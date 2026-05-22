# signalk-doctor

Thin-shell SignalK plugin that opens the SignalK Doctor Console from the admin UI and registers the doctor engine container for image-update tracking.

The heavy lifting (read-only probes, snapshot listing, last-known-good restore) happens in the [signalk-doctor-server](https://github.com/dirkwa/signalk-doctor-server) container, which the [signalk-universal-installer](https://github.com/dirkwa/signalk-universal-installer) drops as a systemd Quadlet. This plugin is just the deep-link from the admin UI.

> Status: **0.1.0**. First release; pairs with signalk-doctor-server 0.x.

## What this plugin does

- Polls for `globalThis.__signalk_containerManager` (provided by `signalk-container`).
- Calls `containers.updates.register({...})` to enroll the doctor container for update notifications — without `ensureRunning`. The container's lifecycle is owned by systemd, not this plugin (marine-reliability principle: a broken plugin must never break recovery).
- Verifies the doctor container is `running`; on any other state, raises a plugin error in the admin UI explaining how to recover (without taking the server down).
- Serves a webapp at `/signalk-doctor/` that fetches `GET /plugins/signalk-doctor/api/gui-url` and redirects to the Doctor Console (default `http://localhost:3004`).

## What this plugin does **not** do

- Start, stop, or recreate the doctor container. The bash installer sets up the systemd Quadlet; this plugin only adopts it for update tracking.
- Mutate any host state. The `managedContainer: true` advanced toggle hints at a fallback `ensureRunning` path, but the default is `false` and that's what should ship in production.

## Configuration

| Field              | Default                 | Purpose                                                                                                                                                               |
| ------------------ | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `managedContainer` | `false`                 | Advanced opt-in. If `true`, the plugin will (eventually) attempt to start the container itself. Default off — the bash installer's Quadlet is the authoritative path. |
| `imageTag`         | `latest`                | Image tag to track for update notifications.                                                                                                                          |
| `externalUrl`      | `http://localhost:3004` | Where the Doctor Console is reachable.                                                                                                                                |
| `logLevel`         | `info`                  | `error` \| `info` \| `debug`.                                                                                                                                         |

## Companion repos

| Repo                                                                                 | Role                                                           |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| [signalk-universal-installer](https://github.com/dirkwa/signalk-universal-installer) | Bash bootstrap that drops the systemd Quadlets.                |
| [signalk-doctor-server](https://github.com/dirkwa/signalk-doctor-server)             | Engine container — the real diagnostics + recovery service.    |
| [signalk-updater-server](https://github.com/dirkwa/signalk-updater-server)           | Sister engine container — image lifecycle + version switching. |
| [signalk-updater](https://github.com/dirkwa/signalk-updater)                         | Sister thin-shell plugin for the updater.                      |
| [signalk-container](https://github.com/dirkwa/signalk-container)                     | Cross-plugin container-runtime substrate.                      |
