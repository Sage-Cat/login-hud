# Login HUD

A GNOME Shell 46 overlay showing desktop restoration and shutdown preparation.
[Workspace State](https://github.com/Sage-Cat/workspace-state) supplies the progress.

![Restoration progress](docs/images/startup.png)

Native GNOME screenshot with example data. [All views](docs/screenshots.md).

- Expand a job to see its progress and recent activity.
- Review application problems in **Важливе**.
- View cleanup results in **GC-профілі**; the HUD does not run cleanup.
- Cancel shutdown while checkpoints are being prepared.

Startup never grabs keyboard or pointer input. Shutdown waits for verified
preparation before handing control back to GNOME.

## Install

With Workspace State, use its [coordinated installer](https://github.com/Sage-Cat/workspace-state/blob/main/docs/deployment.md).
For a standalone install, download the ZIP and `SHA256SUMS` from
[Releases](https://github.com/Sage-Cat/login-hud/releases/latest):

```sh
sha256sum --check --ignore-missing SHA256SUMS
gnome-extensions install --force login-hud-v2@sagecat.local.shell-extension.zip
```

Log out and back in, then enable it:

```sh
gnome-extensions enable login-hud-v2@sagecat.local
```

The HUD stays hidden until a producer supplies a valid current-session report.

## Build

Requires Node.js 20.19+, npm, `jq`, `shellcheck`, `unzip` and `gnome-extensions`.

```sh
npm ci
make release-artifacts
```

The checked extension ZIP and checksum are written to `dist/`.

## Documentation

- [Controls and troubleshooting](docs/operations.md)
- [Status file protocol](docs/protocol.md)
- [Architecture](docs/architecture.md) · [PlantUML](docs/architecture.puml)
- [Screenshots and capture commands](docs/screenshots.md)
