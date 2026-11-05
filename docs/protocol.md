# File protocol

This is a local per-user integration contract, not a network API. The current
status schema is version 1. The supported producer is workspace-state; read this
together with its operation/coordinator documentation before writing a new
producer. Do not synthesize control markers in a live desktop session.

## Locations and publication

The runtime directory is `$XDG_RUNTIME_DIR/workspace-state/`. Producers write a
complete document to a private temporary file in the same directory and
atomically rename it into place. The HUD monitors the directory, so it also sees
replacement rather than only in-place changes. Partial JSON is never a valid
status update.

| File | Writer and purpose |
| --- | --- |
| `login-hud-status.json` | Coordinator: current startup stages and operation evidence. |
| `alerts.json` | Incident collector: first-party source coverage and active important incidents. |
| `startup-hud-dismissed.json` | HUD: dismissal bound to session and startup time; `background` keeps restoration running. |
| `startup-abort.json` | HUD: request to stop the exact current startup restoration. |

Cleanup status is separate:
`${XDG_STATE_HOME:-$HOME/.local/state}/gc-profiled/status.json`.

## Status document

Required fields are `schema_version: 1`, `session_id`, `started_at`, `updated_at`,
`overall_state`, `overall_message`, `stages`, and `error_log_path`. Timestamps are
ISO 8601 strings. `mode` defaults to `startup`; `show_startup_hud` defaults to
true. The HUD presents only startup status: a document with any other `mode`
is ignored, so nothing is shown and nothing is written. The HUD takes no part
in power off or restart and neither writes nor reads any shutdown marker. The
report must match the current GNOME Session Manager-derived session
identity, not merely a recently written timestamp.

This structural example is deliberately synthetic; it cannot authorize a live
session:

```json
{
  "schema_version": 1,
  "mode": "startup",
  "session_id": "example-login",
  "show_startup_hud": true,
  "started_at": "2026-01-01T09:00:00Z",
  "updated_at": "2026-01-01T09:00:05Z",
  "overall_state": "running",
  "overall_message": "Restoring example windows",
  "error_log_path": "/tmp/example-startup.log",
  "stages": [
    {
      "id": "browsers",
      "label": "Browser windows",
      "state": "running",
      "message": "Verified 2 of 3 windows",
      "current": 2,
      "total": 3,
      "events": [
        {"at": "2026-01-01T09:00:05Z", "state": "running", "message": "Waiting for one window"}
      ]
    }
  ]
}
```

A stage requires `id`, `state`, and `message`; `label` or `name` supplies its
heading. Supported states are `pending`, `waiting`, `running`, `ready`,
`degraded`, `failed`, and `skipped`. The last four are terminal. A `degraded`
stage represents verified safe fallbacks; `failed` marks a stage that did not
complete.

Numeric `current`/`total` or `fraction` supplies clamped 0–1 progress. Unknown
nonterminal progress is indeterminate. Terminal stages without explicit progress
count as complete for the overview; this visual fraction is not authorization.
Stages sharing `group_id` form one job named by `group_label`, with averaged
progress and merged activity. The HUD accepts at most 64 stages and the last 32
events per stage. Event fields are `at`, `state`, and `message`.

## Operation identity

Startup status adds `operation_id`, `operation_state`, and `cancelled`.
`operation_state` is backend lifecycle evidence; it does not replace the HUD's
independent checks.

`operation_context` contains exactly these six fields:

| Field | Meaning |
| --- | --- |
| `boot_id` | Current kernel boot identity. |
| `login_generation` | Exact current login identity. |
| `operation_id` | Same operation as the surrounding startup report. |
| `mode` | `startup`. |
| `attempt` | Positive integer attempt number. |
| `deadline` | Positive finite absolute monotonic seconds for this boot. |

The context is immutable. Expiry, old boot/login identity, and missing context
make abort unavailable. Reports without a context can still be displayed.

## Independent reports

`alerts.json` has `schema_version: 1`, `sources`, and `incidents`, with scan and
boot metadata. Only allowed first-party source identifiers and active
blocker/critical incidents are displayed. The report is bounded to 64 sources
and 200 incidents. Missing coverage, a scan older than 15 minutes, or a scan
from another boot is shown as unverified. Acknowledgment invokes only the fixed
`~/.local/bin/wsctl alerts ack SOURCE CODE` argv with validated identifiers; it
never executes commands supplied by incident content.

Cleanup reports contain `schema_version: 1`, `updated_at`, a `daemon` object,
and `profiles`. Each profile has a name, enabled flag, state, message, and
nullable last-start/finish/success/failure/next-run timestamps. States are
`pending`, `running`, `ok`, `failed`, and `disabled`. The HUD limits input to
2 MiB and 256 profiles and requires a fresh running heartbeat for availability.
These reports are consumed only for startup presentation and cannot reopen a
hidden HUD or enable cleanup.


## Startup controls

Abort restoration atomically writes `startup-abort.json` with `schema_version: 1`,
`mode: "startup"`, `session_id`, `operation_id`, the exact six-field startup
`operation_context`, and ISO 8601 `requested_at`. The coordinator validates the
complete operation identity before stopping remaining restoration work. It
publishes `operation_state: "cancelling"`, then `"cancelled"` with `cancelled: true`
and truthful degraded status. Already opened applications remain preserved. Explicit startup `operation_state`
`running` or `cancelling` keeps active controls available even if a category has
already made `overall_state` failed or degraded; completed/failed/cancelled
operation states are terminal. Legacy reports without that lifecycle state use
the overall state.
The HUD displays a pending request until backend status confirms the result;
a failed receipt write leaves restoration active and permits a retry. This file
has no authority over power off or restart.

Run in background hides the startup HUD and records dismissal reason
`background`; the backend continues. The accessible top-bar **Workspace
restoration status** button reopens the current startup report. It deletes only
a dismissal matching the report's session and startup time, and never starts a
new operation. Completed or cancelled reports can also be reopened. Reopening
is unavailable at the lock/greeter boundary.

The same action is exposed as the boolean-returning D-Bus method
`org.sagecat.LoginHud.ShowStartupStatus` at `/org/sagecat/LoginHud` on the Shell's
session bus name `org.gnome.Shell`. A true result means the current startup
report was reopened; false means no eligible report or the dismissal could not
be removed. The extension removes its top-bar actor on disable.
