# Testing and validation

Tests cover two different boundaries: JavaScript behavior and a real isolated
GNOME Shell. Each layer has its own evidence; a synthetic status file does not
prove that a real login was restored.

## Unit checks and packaging

Requires Node.js 20.19+, npm, `jq`, `shellcheck`, `unzip` and `gnome-extensions`.
From this repository:

```sh
npm ci
make check
make release-artifacts
```

`make check` runs metadata and syntax checks, ESLint, shellcheck, static lifecycle
invariants, and the Node tests. `make release-artifacts` repeats those checks,
builds the extension ZIP, verifies its exact six-file inventory and metadata,
and writes its checksum to `dist/`. These commands do not install or activate
the extension.

Coverage includes layout, passive startup, report validation, enable/disable
cleanup, startup controls, and the rules that a status document for a mode other
than startup is ignored and that the extension never touches GNOME's end-session
dialog or mentions any shutdown marker. Version 19 removed the shutdown
interface; validation results for earlier releases that coordinated shutdown
are in the repository history.

## Isolated GNOME Shell

The integration harness lives in the sibling Workspace State repository.
With `workspace-state`, `login-hud` and `gnome-winctl` checked out alongside one
another, run this from `workspace-state`:

```sh
python3 tests/integration/run_hud_headless.py --run --output /tmp/hud-test
```

See the [integration prerequisites and isolation contract](https://github.com/Sage-Cat/workspace-state/blob/main/tests/integration/README.md).
The harness starts GNOME Shell 46 on its own session bus, Wayland socket and
temporary XDG directories. It exercises startup presentation and controls
without closing or moving windows in the existing desktop session. Its
`results.json` records each check and its result. The harness lives in
workspace-state and is updated together with it; it is not part of this
repository's checks, so run it against this checkout before relying on it.

## Limits

These results do not establish physical GPU, monitor hotplug or
hardware-driver equivalence, authenticated application content, conversation
recovery, or live cloud synchronization. Power off and restart are not covered
because the HUD takes no part in them.

Raw runtime reports can contain private application data. Keep them outside
the source tree and redact them before sharing. Screenshots use synthetic data;
see the [capture guide](screenshots.md).
