# Login HUD

A GNOME Shell 46 extension for desktop restoration progress and workspace
controls. [Workspace State](https://github.com/Sage-Cat/workspace-state) supplies
the progress and applies workspace changes.

Expand jobs for progress, review application problems and cleanup reports,
abort restoration, or run it in the background. The HUD never grabs keyboard or
pointer input and takes no part in power off or restart: GNOME's native
Power Off and Restart actions run unchanged.

## Install

Use Workspace State's [coordinated installer](https://github.com/Sage-Cat/workspace-state/blob/main/docs/deployment.md),
or follow the [standalone installation instructions](docs/operations.md#installation).
Changed Shell code activates at the next login. The restoration overlay appears
after receiving a valid report for that login.

## Switch workspaces

Open **Workspaces** (the grid icon in GNOME's top bar) while logged in. The menu
is available even when there is no restoration report. Each row controls a
named workspace. Turn it off to save and close its windows, or turn it on to
restore them. The controls pause while Workspace State verifies a change.

If the menu reports a partial change, use **Retry turning on** or **Retry turning
off** on that row. Review the details below the workspace name if the change
still fails. A standalone Login HUD can display restoration reports. Workspace
switches require a compatible Workspace State installation.

## Build

Requires Node.js 20.19+, npm, `jq`, `shellcheck`, `unzip` and `gnome-extensions`.

```sh
npm ci
make release-artifacts
```

The checked extension ZIP and checksum are written to `dist/`.

## Documentation

- [Controls and troubleshooting](docs/operations.md)
- [Testing, validation results and limits](docs/testing.md)
- [Status file protocol](docs/protocol.md)
- [Architecture](docs/architecture.md) · [PlantUML](docs/architecture.puml)
- [Screenshots and capture commands](docs/screenshots.md)
