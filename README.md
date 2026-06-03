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

## What this plugin does **not** do

- Start, stop, or recreate the doctor container. The bash installer sets up the systemd Quadlet; this plugin only adopts it for update tracking.
- Mutate any host state. The `managedContainer: true` advanced toggle hints at a fallback `ensureRunning` path, but the default is `false` and that's what should ship in production.

## Configuration

| Field              | Default | Purpose                                                                                                                                                               |
| ------------------ | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `managedContainer` | `false` | Advanced opt-in. If `true`, the plugin will (eventually) attempt to start the container itself. Default off — the bash installer's Quadlet is the authoritative path. |
| `logLevel`         | `info`  | `error` \| `info` \| `debug`.                                                                                                                                         |

## Companion repos

| Repo                                                                                 | Role                                                           |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| [signalk-universal-installer](https://github.com/dirkwa/signalk-universal-installer) | Bash bootstrap that drops the systemd Quadlets.                |
| [signalk-doctor-server](https://github.com/dirkwa/signalk-doctor-server)             | Engine container — the real diagnostics + recovery service.    |
| [signalk-updater-server](https://github.com/dirkwa/signalk-updater-server)           | Sister engine container — image lifecycle + version switching. |
| [signalk-updater](https://github.com/dirkwa/signalk-updater)                         | Sister thin-shell plugin for the updater.                      |
| [signalk-container](https://github.com/dirkwa/signalk-container)                     | Cross-plugin container-runtime substrate.                      |
