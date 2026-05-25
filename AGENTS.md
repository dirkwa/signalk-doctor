# signalk-doctor

Thin-shell SignalK plugin that deep-links into the `signalk-doctor-server` engine container. Mirrors the `signalk-backup` pattern.

## Architecture rules you must keep in mind

- **Adopt, don't manage.** Default `managedContainer: false`. The bash installer drops the systemd Quadlet for `signalk-doctor-server`; this plugin only calls `updates.register()` to enroll for update notifications. Never `ensureRunning()` in the default path.
- **Never crash signalk-server.** On any failure (signalk-container missing, container not running, registration error), call `app.setPluginError(...)` — never throw out of `start()`.
- **Loose coupling.** Hand-rolled `src/types.ts` mirrors signalk-container's API surface. Never `import` signalk-container directly.
- **Spread schema defaults at start.** Signal K does not seed schema defaults at runtime; spread `SCHEMA_DEFAULTS` over the incoming config in `start()`. (See signalk-backup AGENTS.md "Gotchas".)
- **Webapp is a redirect shell.** No React. Vanilla TS that fetches `/api/gui-url`, then `window.location.replace`s. If the updater container is unreachable, render a clear "use signalk-recovery" fallback (CC-3).

## Workflow Conventions

This repo is maintained by Dirk Wahrheit.

- Branch names use **hyphens**, never slashes.
- Angular conventional commits: `<type>(<scope>): <subject>`. Subject ≤ 50 chars, imperative, no period.
- One logical change per commit.
- No `Co-Authored-By` lines. No "Generated with Claude Code" attribution.
- Never commit directly to `main`. Every change goes through a PR.
- Version bumps live in their own `chore(release): X.Y.Z` PR.
- PR descriptions: no checkboxes. "Tested" lists what actually ran, not what was planned.

### Pre-PR checklist

```bash
npm run format
npm run build:all        # lint + tsc + vite + vitest
npm run ci-lint
cr review --plain | tee cr-review-<branch>.txt
```

Save the cr output to a repo-local file (the repo `.gitignore`s `cr-review*.txt`); `cr` is rate-limited so reruns are expensive. Skip `cr review` only for `chore(release): X.Y.Z` PRs.

## TypeScript

- `"type": "module"`, ESM throughout. Relative imports use `.js` suffix.
- Both `tsconfig.json` and `tsconfig.webapp.json` run with the full strict-TS set: `strict`, `noImplicitAny`, `noUnusedLocals`, `noUnusedParameters`, `noUncheckedIndexedAccess`, `noImplicitReturns`, `noFallthroughCasesInSwitch`, `noImplicitOverride`. Code must narrow against `undefined` when reading array slots or record entries.

## Gotchas

- **Ask the engine; don't mirror it.** The plugin no longer carries any plugin-side knowledge of which `signalk-doctor-server` version is running. The engine Quadlet pins `:latest` (see signalk-universal-installer AGENTS.md "Engine images run on `:latest`"), so the `currentTag` passed to signalk-container's update comparator is the literal string `"latest"` — a floating tag the comparator treats as undefined-version on its own. The `currentVersion` callback HTTP-fetches `/api/health.version` on the engine to supply the honest RuntimeIdentity for the diff. This replaces an earlier model that hand-bumped a `DOCTOR_SERVER_VERSION` constant on every engine release — it silently went stale, forced a plugin PR + release per engine release, and was the wrong layer to track engine version at. There's no plugin-side configuration for the engine tag anymore (`imageTag` config option removed) because there's nothing to configure: the Quadlet owns OperatorIntent, the engine owns RuntimeIdentity, GHCR owns LatestAvailable.

## File layout

| Path                   | Purpose                                                              |
| ---------------------- | -------------------------------------------------------------------- |
| `src/index.ts`         | Plugin entry. Adopts the updater container via `updates.register()`. |
| `src/types.ts`         | Hand-rolled mirror of signalk-container's API surface.               |
| `src/config/schema.ts` | TypeBox schema + `SCHEMA_DEFAULTS` (spread at `start()` time).       |
| `webapp/index.html`    | One-page redirect shell.                                             |
| `webapp/src/main.ts`   | Fetches `/api/gui-url`, redirects, fallback rendering.               |
| `vite.config.ts`       | Builds `webapp/` → `public/`, base `/signalk-doctor/`.               |
| `tsconfig.json`        | Plugin TS → `plugin/`.                                               |
| `tsconfig.webapp.json` | Webapp TS typecheck only (vite handles emit).                        |

## Companion plugins (hard runtime dependencies)

- `signalk-container` — provides `globalThis.__signalk_containerManager` and the `updates.register()` API. Declared in `signalk.requires`. We do not add `peerDependencies` — npm's semver matching against signalk-container's prereleases is broken. We poll the global and surface a plugin error if it's never available.

The peer engine container (`signalk-doctor-server`) is **not** a plugin dependency — its lifecycle is owned by systemd via the bash installer's Quadlet.
