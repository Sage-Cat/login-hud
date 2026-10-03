# Login HUD

A GNOME Shell 46 overlay showing desktop restoration and shutdown preparation.
[Workspace State](https://github.com/Sage-Cat/workspace-state) supplies the progress.

Expand jobs for progress, review application problems and cleanup reports, or
cancel shutdown preparation. Startup never grabs keyboard or pointer input;
shutdown requires a visible countdown and verified coordinator handoff.

## Install

Use Workspace State's [coordinated installer](https://github.com/Sage-Cat/workspace-state/blob/main/docs/deployment.md),
or follow the [standalone installation instructions](docs/operations.md#installation).
Changed Shell code activates at the next login. The HUD stays hidden until it
receives a valid report for that login.

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
