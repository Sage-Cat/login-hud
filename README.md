# Login HUD

`login-hud-v2@sagecat.local` is a GNOME Shell 46 extension that displays startup or shutdown telemetry. It is deliberately passive during login: before it receives a complete valid status document for the current GNOME Session Manager instance it stays hidden and does not register Shell chrome, stage listeners, or a refresh timer. A startup document may additionally set `show_startup_hud` to `false`, allowing same-boot re-logins to restore in the background without creating HUD chrome. Once eligible status is present, the extension uses ordinary Shell chrome rather than top chrome, and only the bounded HUD panel participates in pointer input. Startup never acquires a modal or input grab, while its controls remain closable and expandable. An active shutdown alone uses GNOME's system-modal pointer and keyboard grab for **Cancel shutdown**. Invalid startup telemetry remains fail-open; an intercepted power-off or restart is deliberately fail-closed until the coordinator proves that preparation finished.

The extension watches this file (the directory is monitored so atomic rename writes are observed):

```
$XDG_RUNTIME_DIR/workspace-state/login-hud-status.json
```

## Status schema

Writers should write a complete replacement to a temporary file in the same directory, then atomically rename it to `login-hud-status.json`.

```json
{
  "schema_version": 1,
  "mode": "startup",
  "show_startup_hud": true,
  "session_id": "2026-09-01T08:24:12Z-1842",
  "started_at": "2026-09-01T08:24:12Z",
  "updated_at": "2026-09-01T08:24:17Z",
  "overall_state": "running",
  "overall_message": "Restoring desktop applications",
  "stages": [
    {
      "id": "shell",
      "label": "GNOME Shell ready",
      "state": "ready",
      "message": "Session handoff complete",
      "current": 1,
      "total": 1
    },
    {
      "id": "gdrive",
      "label": "Google Drive",
      "group_id": "cloud-drives",
      "group_label": "Cloud drives and metadata",
      "state": "running",
      "message": "Google Drive is connecting",
      "fraction": 0.4,
      "events": [
        {
          "at": "2026-09-01T08:24:17+03:00",
          "state": "running",
          "message": "Starting Google Drive"
        }
      ]
    }
  ],
  "error_log_path": "/run/user/1000/workspace-state/session-startup.log"
}
```

Required top-level fields are `schema_version` (currently `1`), `session_id`, `started_at`, `updated_at`, `overall_state`, `overall_message`, `stages`, and `error_log_path`. `mode` is optional and may be `startup` (the default) or `shutdown`. `show_startup_hud` defaults to `true`; wsctl sets it to `false` on later GNOME logins during an already-claimed OS boot. Shutdown documents also require a unique `operation_id`, `cancelled`, an explicit `shutdown_action` (`poweroff` or `restart`), and `shutdown_origin: "preflight"`. The extension displays a shutdown document only when its operation matches the private request created by the extension after native confirmation. It also validates `session_id` against the current GNOME Session Manager owner, so backend-only or stale status cannot flash or acquire a shutdown grab. `error_log_path` must be an absolute local path; it is only used when a failed stage or `overall_state: "failed"` is present.

Stage fields are `id`, `state`, `message`, and either `label` (the wsctl producer) or `name`. Progress can be supplied as optional numeric `current`/`total` counts or as `fraction` (clamped to 0–1). Supported states are `pending`, `waiting`, `running`, `ready`, `degraded`, `failed`, and `skipped`. A non-terminal stage without measurable progress displays an indeterminate spinner.

Every displayed job is expandable by mouse or keyboard. Its `events` array is shown as a timestamped activity log; the wsctl producer keeps the last 32 distinct state/message transitions per stage. Stages with the same `group_id` are rendered as one aggregate job using `group_label`. Expanding that job shows each internal stage and a merged chronological log. Startup combines GNOME Wayland with display/workspace readiness, combines tmux-resurrect with Alacritty/tmux reconciliation, and combines `gdrive`, `nextcloud`, `pdrive`, and `warmup` as a single cloud-drive job. Shutdown contains only the tmux checkpoint, desktop/browser checkpoint, and checkpoint-integrity proof. It never stops cloud drives, warm-up services, or GNOME components; Ubuntu performs normal service teardown after the handoff.

The overview progress is derived from displayed jobs. A grouped job's progress is the average of its internal stages. A terminal stage without a fraction counts as complete; a non-terminal stage without one counts as not-yet-complete. Expanded content scrolls inside a bounded panel rather than growing beyond the screen.

In `startup` mode, when every stage is terminal (`ready`, `degraded`, `failed`, or `skipped`) and none failed, the HUD exposes **OK**. Startup controls do not focus themselves or capture keyboard/pointer input; they can be clicked or reached normally from the bounded panel.

For an ordinary power-off or restart, GNOME first shows its stock confirmation. GNOME's early `QueryEndSession` is answered passively and cannot start a HUD or checkpoint. Only after the user presses the final **Power Off** or **Restart** button does the extension intercept the corresponding `_confirm` callback and retain the exact original signal. It waits until the native dialog is fully closed, writes a private `shutdown-request.json`, and then allows the coordinator to show the modal HUD and save tmux plus desktop/browser state. The extension never emits the retained signal merely because status says ready. It first waits for the ready HUD to be allocated and painted, writes `shutdown-hud-rendered.json`, displays a visible three-second countdown, writes `shutdown-commit.json`, and finally requires a matching `shutdown-prepared.json` before invoking GNOME's saved confirmation. If GNOME subsequently presents **Power Off Anyway** because another application inhibited logout, that confirmation continues the already prepared operation without starting another checkpoint.

During shutdown, **Cancel shutdown** remains available until the final handoff and `Esc` invokes the same action. The extension atomically writes an operation-bound `shutdown-cancel.json`, stops only the checkpoint worker, and cancels GNOME's pending DBus dialog exactly once; retrying that cancellation could accidentally close a later, unrelated dialog. Since the preflight changes no drive or OS-service state, cancellation requires no remount or recovery phase. A failed stage never commits or invokes the original action, keeps the HUD visible, and exposes **Show full error log** and **Close**. Disabling the extension during active preflight also cancels both sides. If no matching status arrives within 15 seconds, shutdown is safely cancelled instead of leaving an invisible pending transaction.

The special GNOME **Boot Options** restart remains on GNOME's native path because it changes bootloader state before confirmation and therefore cannot safely offer a reversible HUD preflight. Direct noninteractive logind/systemd power commands are likewise outside this Shell UI hook and follow Ubuntu's native shutdown path without the HUD.

A new `session_id` or a change between `startup` and `shutdown` resets a prior dismissal. This lets a shutdown HUD reappear after its startup HUD was dismissed, while the normal lock-screen and greeter hiding rules still apply.

## Install and development

```sh
make check
make install
gnome-extensions enable login-hud-v2@sagecat.local
```

For development, disable and enable the extension after changing files:

```sh
gnome-extensions disable login-hud-v2@sagecat.local
make install
gnome-extensions enable login-hud-v2@sagecat.local
```

`make package` creates a Shell extension ZIP in `dist/`. `make uninstall` removes only this extension's installed directory.

## Validation

`make check` validates `metadata.json`, parses `extension.js` as an ES module with Node's stdin module syntax checker, and runs ESLint. `tests/check.sh` additionally checks lifecycle and two-phase shutdown invariants: no chrome before valid status parsing, install-before-layout, safe allocation checks, shutdown-only modal capture, durable request/paint/commit markers, prepared-marker matching, exact deferred GNOME handoff, cancellation, and wrapper restoration. Node is used only for static validation; the extension itself uses GNOME Shell GJS/GI APIs exclusively.

The latest local source/install verification and its explicit activation boundary are recorded in [`VERIFICATION.md`](VERIFICATION.md).

For an installed extension, inspect Shell's view of it with:

```sh
gnome-extensions info login-hud-v2@sagecat.local
```
