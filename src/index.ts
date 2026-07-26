import type { Plugin, ServerAPI } from '@signalk/server-api';
import type { IRouter, Request, Response } from 'express';
import type { ContainerManagerApi } from './types.js';
import { ConfigSchema, SCHEMA_DEFAULTS, type Config } from './config/schema.js';
import { createConsoleProxy } from './proxy.js';
import { ProbeNotifier, pollOnce } from './probes-notify.js';

const PLUGIN_PATH_PREFIX = '/plugins/signalk-doctor';
const CONSOLE_MOUNT = '/console';

const PLUGIN_ID = 'signalk-doctor';
const CONTAINER_NAME = 'signalk-doctor-server';
const IMAGE = 'ghcr.io/dirkwa/signalk-doctor-server';
const REPO = 'dirkwa/signalk-doctor-server';
// Default engine port; overridable via SIGNALK_DOCTOR_ENGINE_PORT for
// non-default installs and for e2e tests that point the plugin at a mock
// engine. Falls back to 3004 on an unset/invalid value.
const ENGINE_PORT = ((): number => {
  const raw = Number(process.env.SIGNALK_DOCTOR_ENGINE_PORT);
  return Number.isInteger(raw) && raw > 0 && raw < 65536 ? raw : 3004;
})();
// Engine container Quadlet pins :latest by default (see signalk-universal-installer
// AGENTS.md "Engine images run on :latest"). The honest "what version is running"
// answer is the engine's own /api/health.version — see fetchEngineVersion() below.
const ENGINE_TAG = 'latest';

// signalk-server runs Network=host and the engine publishes its port on the
// host at 127.0.0.1:ENGINE_PORT, so loopback ALWAYS reaches the co-located
// engine from inside this container — no DNS, no mDNS. 127.0.0.1 (not
// localhost) dodges IPv6 ::1-first resolution; the engine is published on IPv4.
// This is what the server-side consumers (health probe, version fetch, console
// proxy) hit — never a user-supplied hostname, which the slim engine image
// can't resolve for .local/mDNS names.
export const ENGINE_LOCAL_URL = `http://127.0.0.1:${ENGINE_PORT}`;

/**
 * Derive the browser-facing Doctor Console URL from the incoming HTTP request.
 * Reason: a browser hitting the admin UI at http://192.168.0.122:3000 expects
 * the "Open Doctor Console" link to go to http://192.168.0.122:3004, NOT to
 * http://localhost:3004 (which is the BROWSER's localhost, not the SignalK box's).
 * A .local/mDNS host works here because the BROWSER resolves it (Bonjour/Avahi),
 * unlike the server-side probe which runs in a container that can't.
 *
 * Honors X-Forwarded-Host when present (reverse-proxy setups). Strips the port
 * from the request's host before re-appending the engine port — the admin UI
 * and the engine container are on the same host but different ports.
 */
export function resolveGuiUrl(req: Request): string {
  const forwarded = req.headers['x-forwarded-host'];
  // Behind chained proxies X-Forwarded-Host can be a comma-joined list; take
  // the first entry (same as the X-Forwarded-Proto handling below).
  const forwardedFirst = (Array.isArray(forwarded) ? forwarded[0] : forwarded)
    ?.split(',')[0]
    ?.trim();
  const hostHeader = forwardedFirst || req.headers.host || `localhost:${ENGINE_PORT}`;
  // hostHeader is e.g. "192.168.0.122:3000" or "[::1]:3000" or "localhost:3000".
  // Strip the port; keep IPv6 brackets if present.
  let hostname = hostHeader;
  if (hostname.startsWith('[')) {
    const closeBracket = hostname.indexOf(']');
    if (closeBracket > 0) hostname = hostname.substring(0, closeBracket + 1);
  } else {
    const colon = hostname.lastIndexOf(':');
    if (colon > 0) hostname = hostname.substring(0, colon);
  }

  const proto =
    (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim() ||
    (req.secure ? 'https' : 'http');
  return `${proto}://${hostname}:${ENGINE_PORT}`;
}

function getContainerManager(): ContainerManagerApi | undefined {
  return globalThis.__signalk_containerManager;
}

/**
 * Wait until signalk-container is loaded AND its runtime probe has settled.
 * Same pattern as signalk-backup — we load alphabetically before signalk-container,
 * so polling lets us race that gap without flapping.
 */
async function waitForContainerManager(
  maxMs: number,
  intervalMs = 500,
): Promise<ContainerManagerApi | undefined> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const m = getContainerManager();
    if (m && m.getRuntime()) return m;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return getContainerManager();
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Reachable but slower than this ⇒ a (green) "slow, likely I/O" status rather
// than a clean bill of health. Observed-healthy is ~12ms; an SD-card-starved
// engine answered in 2700–3800ms. Mirrors signalk-doctor-server SLOW_MS.
const ENGINE_SLOW_MS = 1500;

/**
 * Probe the peer engine's own /api/health. Retries a transient failure twice
 * (5s per attempt, ~2s apart) so a single slow/missed answer on a busy or
 * SD-card-bound host doesn't flap the plugin to a red "not reachable" error —
 * the same false-down the installer's one-shot checks used to produce. Returns
 * `reachable`, plus `slowMs` (the successful attempt's duration) when that
 * attempt exceeded ENGINE_SLOW_MS. Never throws.
 */
export async function probeEngineHealth(
  healthUrl: string,
): Promise<{ reachable: boolean; slowMs?: number }> {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 2000));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const start = Date.now();
    try {
      const res = await fetch(healthUrl, { signal: controller.signal });
      if (res.ok) {
        const elapsed = Date.now() - start;
        return elapsed > ENGINE_SLOW_MS
          ? { reachable: true, slowMs: elapsed }
          : { reachable: true };
      }
    } catch {
      // transient — fall through to retry
    } finally {
      clearTimeout(timer);
    }
  }
  return { reachable: false };
}

/**
 * Ask the engine container for its running semver via /api/health. Used as
 * the `currentVersion` callback on signalk-container's update registration —
 * the comparator prefers this over `currentTag` when present, so the
 * "available vs running" diff is computed against the engine's honest
 * RuntimeIdentity rather than a stale Quadlet tag string or a hand-bumped
 * plugin-side constant.
 *
 * 3s timeout — signalk-container's update check is async and a hung engine
 * shouldn't block its tick. Null on any failure; the comparator falls back
 * to currentTag (which is "latest" — a floating tag the comparator treats
 * as undefined-version, no upgrade offered).
 */
async function fetchEngineVersion(baseUrl: string): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
      const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/health`, {
        signal: controller.signal,
      });
      if (!res.ok) return null;
      const raw: unknown = await res.json();
      const version =
        typeof raw === 'object' && raw !== null
          ? (raw as Record<string, unknown>).version
          : undefined;
      return typeof version === 'string' && version.length > 0 ? version : null;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

interface PluginInternalState {
  config: Config;
  app: ServerAPI;
  containers?: ContainerManagerApi;
  notifier?: ProbeNotifier;
  pollTimer?: ReturnType<typeof setInterval>;
  // Set true in stop(); a poll that was already in flight when stop() ran
  // checks this before reconciling so it can't re-raise alarms after clearAll.
  pollStopped: boolean;
  // In-flight guard: setInterval fires on a fixed period regardless of how
  // long a cycle takes, so a slow engine could overlap cycles and produce
  // out-of-order writes. Skip a tick while one is still running.
  pollInFlight: boolean;
}

// Minimum poll interval; also the schema minimum. Guards against a mistyped
// tiny interval hammering the engine.
const MIN_POLL_INTERVAL_S = 10;

/**
 * Start the health-probe → SignalK notification poll loop. Guarded by the
 * `publishNotifications` config toggle. Runs one cycle immediately, then on
 * the configured interval. Every cycle is best-effort — a fetch failure skips
 * that tick without clearing existing notifications, and nothing here throws
 * out of start().
 */
function startNotificationPolling(state: PluginInternalState): void {
  if (!state.config.publishNotifications) return;
  const notifier = new ProbeNotifier(state.app, PLUGIN_ID);
  state.notifier = notifier;
  state.pollStopped = false;

  // A malformed interval (NaN/Infinity from bad config) must not degrade
  // setInterval into a ~1ms hot loop — fall back to the schema default, then
  // apply the floor.
  const raw = Math.floor(state.config.notificationIntervalSeconds);
  const seconds = Number.isFinite(raw) ? raw : SCHEMA_DEFAULTS.notificationIntervalSeconds;
  const intervalS = Math.max(MIN_POLL_INTERVAL_S, seconds);

  const cycle = (): void => {
    if (state.pollStopped || state.pollInFlight) return; // no overlap, no post-stop run
    state.pollInFlight = true;
    void (async () => {
      try {
        await pollOnce(
          ENGINE_LOCAL_URL,
          notifier,
          (msg) => state.app.debug(msg),
          () => state.pollStopped, // skip reconcile if stop() ran mid-fetch
        );
      } catch (err) {
        // reconcile()/handleMessage() could throw — never let it become an
        // unhandled rejection or take down the timer.
        state.app.debug(`notification poll cycle failed: ${errMsg(err)}`);
      } finally {
        state.pollInFlight = false;
      }
    })();
  };
  cycle(); // fire once now so a warning surfaces without waiting a full interval
  state.pollTimer = setInterval(cycle, intervalS * 1000);
}

export default function pluginFactory(app: ServerAPI): Plugin {
  const state: PluginInternalState = {
    config: { ...SCHEMA_DEFAULTS },
    app,
    pollStopped: false,
    pollInFlight: false,
  };

  const plugin: Plugin = {
    id: PLUGIN_ID,
    name: 'Doctor',
    description:
      'Thin-shell plugin that registers the signalk-doctor-server container for update tracking ' +
      'and opens the Doctor Console from the admin UI.',

    schema(): unknown {
      return ConfigSchema;
    },

    async start(rawConfig: unknown): Promise<void> {
      // Signal K does not seed schema defaults at runtime — spread over the raw config so
      // missing keys land at their declared defaults. (signalk-backup AGENTS.md, "Gotchas".)
      const config = { ...SCHEMA_DEFAULTS, ...(rawConfig as Partial<Config>) };
      state.config = config;

      // Republish the engine's warn/fail health probes as SignalK
      // notifications. Started BEFORE the container-manager wait: it only needs
      // the engine's /api/probes (loopback), is independent of signalk-container,
      // and must keep working even when the manager never loads (the early
      // return below). Never throws — the poll loop swallows its own errors.
      startNotificationPolling(state);

      const containers = await waitForContainerManager(30_000);
      if (!containers) {
        app.setPluginError(
          'signalk-container is not loaded — install it and restart the server. ' +
            'The plugin will not register updates without it.',
        );
        return;
      }
      state.containers = containers;

      // Adopt-only: the bash installer starts the container as a Quadlet, this plugin only
      // registers it for update notifications. managedContainer=true is an opt-in fallback.
      try {
        containers.updates.register({
          pluginId: PLUGIN_ID,
          containerName: CONTAINER_NAME,
          image: IMAGE,
          // OperatorIntent: the Quadlet pins :latest, so that's the tag the
          // operator tracks. signalk-container's comparator falls through to
          // currentVersion() for the actual semver compare.
          currentTag: () => ENGINE_TAG,
          // RuntimeIdentity: ask the engine itself. /api/health.version is
          // the canonical "what version am I" answer — read from the engine's
          // package.json at boot. Eliminates the previous hand-bumped
          // DOCTOR_SERVER_VERSION constant, which silently went stale on
          // every engine release and forced an extra plugin PR per bump.
          currentVersion: () => fetchEngineVersion(ENGINE_LOCAL_URL),
          versionSource: containers.updates.sources.githubReleases(REPO),
          checkInterval: '24h',
        });
      } catch (err) {
        app.setPluginError(`update registration failed: ${errMsg(err)}`);
      }

      // Sanity check the peer container is actually reachable. We HTTP-probe its own
      // /api/health rather than calling containers.getState() — signalk-container's API
      // prefixes container names with `sk-` (the plugin-engine convention), and our
      // peer containers don't carry that prefix (they're systemd-managed peers, not
      // plugin-managed children). A direct health probe also catches the case where
      // the container is technically "running" but stuck/unhealthy. Never throw —
      // the plugin must never take signalk-server down.
      try {
        const healthUrl = `${ENGINE_LOCAL_URL}/api/health`;
        const probe = await probeEngineHealth(healthUrl);
        if (!probe.reachable) {
          // Genuinely down after retries.
          app.setPluginError(
            `${CONTAINER_NAME} is not reachable at ${healthUrl}. ` +
              `Run the bash installer or \`systemctl --user start ${CONTAINER_NAME}.service\`.`,
          );
        } else if (probe.slowMs !== undefined) {
          // Reachable but slow — usually microSD I/O contention, not a fault.
          // SignalK's plugin API has no warning tier, so this lands as a
          // (green) status rather than a red error; the Doctor Console's
          // storage-type probe carries the full SD-card detail.
          app.setPluginStatus(
            `${CONTAINER_NAME} reachable but slow (${probe.slowMs}ms) — likely disk I/O contention; ` +
              `if this host runs off an SD card, a USB3/NVMe SSD removes it`,
          );
        }
      } catch (err) {
        app.setPluginError(`could not probe ${CONTAINER_NAME}: ${errMsg(err)}`);
      }
    },

    stop(): void {
      // Mark stopped FIRST so any poll already in flight sees it and skips its
      // reconcile — otherwise a completed fetch could re-raise alarms right
      // after clearAll() below.
      state.pollStopped = true;
      if (state.pollTimer) {
        clearInterval(state.pollTimer);
        state.pollTimer = undefined;
      }
      // Don't leave doctor alarms latched in the data model after shutdown.
      try {
        state.notifier?.clearAll();
      } catch {
        // best-effort
      }
      state.notifier = undefined;
      try {
        state.containers?.updates.unregister(PLUGIN_ID);
      } catch {
        // best-effort
      }
    },

    registerWithRouter(router: IRouter): void {
      router.get('/api/gui-url', (req: Request, res: Response) => {
        res.json({ url: resolveGuiUrl(req) });
      });
      router.get('/api/info', (_req: Request, res: Response) => {
        res.json({
          pluginId: PLUGIN_ID,
          containerName: CONTAINER_NAME,
          image: IMAGE,
          managedContainer: state.config.managedContainer,
          engineUrl: ENGINE_LOCAL_URL,
          // OperatorIntent — the channel the Quadlet tracks. The engine's
          // real running version is at /api/health on the engine itself
          // (not proxied here — callers go direct).
          currentTag: ENGINE_TAG,
        });
      });

      // Same-origin reverse proxy to the engine console. Lets the embedded
      // React AppPanel iframe the engine UI without mixed-content or CORS
      // issues, and works behind HTTPS reverse proxies (Traefik/nginx) in
      // front of signalk-server. See src/proxy.ts for SSE/HTML-injection
      // details. Requires the engine UI to read <meta name="api-base"> for
      // all API calls — see signalk-doctor-server 0.7.8+ release notes.
      const consoleProxy = createConsoleProxy({
        getTargetUrl: () => ENGINE_LOCAL_URL,
        publicPathPrefix: `${PLUGIN_PATH_PREFIX}${CONSOLE_MOUNT}`,
      });
      router.use(CONSOLE_MOUNT, consoleProxy);
    },
  };

  return plugin;
}

// Signal K plugin loader expects a default export OR a `module.exports = (app) => plugin` style.
// We export the factory; the runtime calls it with the app instance.
