# signalk-doctor

> [!IMPORTANT]
> **This plugin is only meant to be used as part of the [signalk-universal-installer](https://github.com/dirkwa/signalk-universal-installer) stack.**
> It is a thin shell with no value on its own — it surfaces the [signalk-doctor-server](https://github.com/dirkwa/signalk-doctor-server) engine container, whose lifecycle is owned by the systemd Quadlet the installer drops. Installing this plugin standalone (without that engine container and the installer's setup) does nothing useful. Use the installer; don't install this from the appstore by itself.

Thin-shell SignalK plugin that embeds the SignalK Doctor Console in the admin UI and registers the doctor engine container for image-update tracking.

The heavy lifting (read-only probes, snapshot listing, last-known-good restore) happens in the [signalk-doctor-server](https://github.com/dirkwa/signalk-doctor-server) container, which the [signalk-universal-installer](https://github.com/dirkwa/signalk-universal-installer) drops as a systemd Quadlet. This plugin is just the admin-UI surface for it.

## What this plugin does

- Polls for `globalThis.__signalk_containerManager` (provided by `signalk-container`).
- Calls `containers.updates.register({...})` to enroll the doctor container for update notifications — without `ensureRunning`. The container's lifecycle is owned by systemd, not this plugin (marine-reliability principle: a broken plugin must never break recovery).
- Verifies the doctor container is `running`; on any other state, raises a plugin error in the admin UI explaining how to recover (without taking the server down).
- Renders an embedded panel inside the admin UI (at `/admin/#/e/signalk_doctor`, with the admin sidebar still visible) as a Module Federation remote, rather than redirecting away to a standalone page.
- Reverse-proxies the engine console same-origin under `/plugins/signalk-doctor/console/`, so the embedded panel can iframe the Doctor Console without mixed-content or CORS problems — and it works behind an HTTPS reverse proxy (Traefik/nginx) in front of signalk-server. The proxy forwards to the co-located engine over loopback (`http://127.0.0.1:3004`); signalk-server runs `Network=host` so loopback always reaches it with no DNS.
- Republishes the engine's health probes as SignalK notifications (see [Health-probe notifications](#health-probe-notifications)), so a `warn`/`fail` probe reaches alarm panels (KIP, etc.) instead of living only in the Doctor Console.

## What this plugin does **not** do

- Start, stop, or recreate the doctor container. The bash installer sets up the systemd Quadlet; this plugin only adopts it for update tracking.
- Mutate any host state. The `managedContainer: true` advanced toggle hints at a fallback `ensureRunning` path, but the default is `false` and that's what should ship in production.

## Configuration

| Field                         | Default | Purpose                                                                                                                                                   |
| ----------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `managedContainer`            | `false` | Advanced opt-in. If `true`, the plugin attempts to start the container itself instead of relying on the installer's Quadlet. Leave `false` in production. |
| `logLevel`                    | `info`  | `error` \| `info` \| `debug`.                                                                                                                             |
| `publishNotifications`        | `true`  | Republish the engine's `warn`/`fail` health probes as SignalK notifications. Turn off to keep probe results confined to the Doctor Console.               |
| `notificationIntervalSeconds` | `60`    | How often to poll the engine for probe status (minimum 10s). Only used when `publishNotifications` is on.                                                 |

## Health-probe notifications

When `publishNotifications` is on (the default), the plugin polls the engine's `GET /api/probes` and mirrors each **warn**/**fail** probe into the SignalK data model under `notifications.doctor.<probe-id>` (e.g. `notifications.doctor.timezone-drift`), so alarm panels surface them like any other notification:

| Probe status | Notification `state` | `method`           |
| ------------ | -------------------- | ------------------ |
| `warn`       | `warn`               | `visual`           |
| `fail`       | `alarm`              | `visual` + `sound` |
| `ok`         | cleared → `normal`   | —                  |
| `unknown`    | not raised           | —                  |

`unknown` (a probe that timed out or couldn't measure) is deliberately **not** raised — it isn't a real failure and would flap on a busy boot. When a probe recovers, its notification is set to `state: normal` (SignalK's "resolved" convention); the plugin also clears every active notification on `stop()`, so a shutdown never leaves a stale doctor alarm latched. A transient engine-unreachable poll is skipped without clearing existing notifications, so a blip doesn't spuriously resolve a real alarm.

The plugin reaches the engine over loopback (`http://127.0.0.1:3004` by default; override the port with `SIGNALK_DOCTOR_ENGINE_PORT` for a non-default install). `GET /api/probes` is unauthenticated, so no token is needed.

## Companion repos

| Repo                                                                                 | Role                                                           |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| [signalk-universal-installer](https://github.com/dirkwa/signalk-universal-installer) | Bash bootstrap that drops the systemd Quadlets.                |
| [signalk-doctor-server](https://github.com/dirkwa/signalk-doctor-server)             | Engine container — the real diagnostics + recovery service.    |
| [signalk-updater-server](https://github.com/dirkwa/signalk-updater-server)           | Sister engine container — image lifecycle + version switching. |
| [signalk-updater](https://github.com/dirkwa/signalk-updater)                         | Sister thin-shell plugin for the updater.                      |
| [signalk-container](https://github.com/dirkwa/signalk-container)                     | Cross-plugin container-runtime substrate.                      |

## License

signalk-doctor 1.0.0 and later is **source available, not open source**.
See [LICENSE.md](LICENSE.md).

**You may**, free of charge: run it on your own boat or fleet, private or
commercial; use it for internal company operations; modify it for your own use;
use it in non-commercial education and research; and provide professional
services to others who use it under these terms.

**You may not**: redistribute modified versions or derivative works, or publish
them to npm or anywhere else. Unmodified official releases may be mirrored,
cached and redistributed verbatim as long as the notices stay intact and the
license terms are included.

Versions 0.4.0 and earlier remain available under the Apache-2.0 license
(see [LICENSE-Apache-2.0-through-v0.x.txt](LICENSE-Apache-2.0-through-v0.x.txt)).
