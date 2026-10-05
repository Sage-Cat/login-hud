# Testing and validation

Tests cover three different boundaries: JavaScript behavior, a real isolated
GNOME Shell, and a complete disposable VM shutdown and subsequent login.
Each layer has its own evidence; a mocked callback or synthetic status file
does not prove that an operating system powered off.

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
builds the extension ZIP, verifies its exact four-file inventory and metadata,
and writes its checksum to `dist/`. These commands do not install or activate
the extension.

The 2026-10-03 validation passed **53 Node tests**, with no failures or skips,
plus the static checks and package verification. Coverage includes layout,
passive startup, report validation, enable/disable cleanup, painted countdowns,
stale operation contexts, cancellation and late callbacks. The handoff timing
regression confirms that 15, 25, 30 and 34.9 seconds do not prematurely cancel
the 35-second wait, while expiry at 35 seconds cancels it. Local cancellation
stops that wait immediately.

An Oct5 real VM cancellation exposed stale presentation: after native stop jobs
settled, the cancelled report was overwritten by an earlier committed
"Ready to power off" overlay. New regression tests reproduce that stale commit
and check failed stages, local cancellation and expired ownership. Progress
overlays now require a currently ready, authorized operation; terminal reports
clear matching old markers and render cancellation explicitly. Packaging and
all **55 Node tests** passed. Final coordinated VM acceptance is recorded in
[Workspace State's test report](https://github.com/Sage-Cat/workspace-state/blob/main/docs/testing.md).

A later retry timeout was traced to three backend category stages left pending
when a sealed checkpoint was reused. The real renderer correctly withheld
acknowledgement; it needed no layout workaround. Scoped terminal failures now
report completed backend recovery accurately, including Close/Hide and the
diagnostic endpoint. Unscoped or still-recovering reports remain conservative.
The updated package passed **58 Node tests**. The real isolated GNOME suite
passed **21 cases**, including Cancel → Close → a fresh completed retry with
fewer rows, and refusal to commit an overall-ready report with a pending row.

## Isolated GNOME Shell

The integration harness lives in the sibling Workspace State repository.
With `workspace-state`, `login-hud` and `gnome-winctl` checked out alongside one
another, run this from `workspace-state`:

```sh
python3 tests/integration/run_hud_headless.py --run --output /tmp/hud-test
```

See the [integration prerequisites and isolation contract](https://github.com/Sage-Cat/workspace-state/blob/main/tests/integration/README.md).
The harness starts GNOME Shell 46 on its own session bus, Wayland socket and
temporary XDG directories. It exercises real modal input grabs, lock-screen
confirmation, failed cancellation writes, backend silence, late ready reports,
failed-report dismissal, and disable/re-enable races. Native shutdown handoff
is blocked by the fixture. `results.json` records each check and its result.

The final isolated HUD run passed **17 checks**. This verifies Shell behavior
without closing or moving windows in the existing desktop session; it does
not substitute for a real poweroff cycle.

## Genuine VM poweroff and cold boot

On 2026-10-03, the coordinated release passed **three consecutive cycles** in
a disposable QEMU/KVM Ubuntu guest running GNOME Wayland. Testing used the
actual GNOME Power Off confirmation, observed the HUD, waited for guest shutdown,
and then cold-booted into a new Ubuntu graphical login.

| Cycle | Scenario | Observed painted countdown | Chrome exited before Shell teardown |
| --- | --- | --- | --- |
| 1 | Normal poweroff and cold boot | 5.054 s | 325 ms |
| 2 | Three-second HTTP responses, HUD Escape cancellation, then retry | 5.088 s on retry | 145 ms |
| 3 | Normal poweroff and cold boot | 5.008 s | 104 ms |

Each cycle recorded a guest-initiated QMP shutdown, a clean user-manager stop,
matching operation-bound render/commit and durable handoff evidence, and a new
boot identity. The second cycle recorded one cancelled operation and all 42
HTTP responses taking at least three seconds. A cancelled attempt did not
authorize the later retry.

After each cold boot, verification matched the independent expected checkpoint,
browser URLs/order/groups, placement, tmux identities and exact native window
inventory: 25 windows, including six Alacritty terminals, seven Chrome windows
with 42 tabs and three groups, four Nemo windows, one VS Code window, one viewer,
and one each for Slack, Discord, Telegram, Viber, ChatGPT and Remmina. The fixture
contained ten tmux sessions and 23 synthetic conversation processes. Extra
unmanaged windows or duplicate restored windows failed verification.

The tested code was [Login HUD f1026fa](https://github.com/Sage-Cat/login-hud/tree/f1026fa520b863e8a87703c138943de482edbdf1)
with [Workspace State ef24480](https://github.com/Sage-Cat/workspace-state/tree/ef24480e0974442fedb6c100be67c9bfbe84826b).
For reproduction, use the guarded [VM poweroff harness](https://github.com/Sage-Cat/workspace-state/blob/main/docs/testing.md#real-gnome-power-off-and-browser-adoption)
and retain its independent expected-state, receipt, journal and QMP evidence.

## Limits

The VM used three virtual displays. These results do not establish physical
GPU, monitor hotplug or hardware-driver equivalence. Real applications launched
without account sign-in; authenticated application content, conversation
recovery, live cloud synchronization and Windows OS hibernation were outside
this acceptance scope. A separate real Codex CLI launch displayed its signed-out
screen; the 23 mass-scale conversation workers remained synthetic.

Raw runtime reports can contain private application data. Keep them outside
the source tree and redact them before sharing. Screenshots use synthetic data;
see the [capture guide](screenshots.md).
