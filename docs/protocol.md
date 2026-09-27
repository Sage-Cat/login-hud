# File protocol

This is a local per-user integration contract, not a network API. The current
status schema is version 1. The supported producer is workspace-state; read this
together with its operation/coordinator documentation before writing a new
producer. Do not synthesize authorization markers in a live desktop session.

## Locations and publication

The runtime directory is `$XDG_RUNTIME_DIR/workspace-state/`. Producers write a
complete document to a private temporary file in the same directory and
atomically rename it into place. The HUD monitors the directory, so it also sees
replacement rather than only in-place changes. Partial JSON is never a valid
status update.

| File | Writer and purpose |
| --- | --- |
| `login-hud-status.json` | Coordinator: current startup/shutdown stages and operation evidence. |
| `alerts.json` | Incident collector: first-party source coverage and active important incidents. |
| `startup-hud-dismissed.json` | HUD: dismissal bound to session and startup time. |
| `shutdown-request.json` | HUD: request after final native confirmation; exact session, operation, and action. |
| `shutdown-hud-rendered.json` | HUD: current completed status was allocated and painted. |
| `shutdown-commit.json` | HUD: visible countdown completed for this operation. |
| `shutdown-cancel.json` | HUD: operation authorization withdrawn; recovery may still be pending. |
| `shutdown-prepared.json` | Coordinator: exact operation is prepared for native handoff. |

Cleanup status is separate:
`${XDG_STATE_HOME:-$HOME/.local/state}/gc-profiled/status.json`.

## Status document

Required fields are `schema_version: 1`, `session_id`, `started_at`, `updated_at`,
`overall_state`, `overall_message`, `stages`, and `error_log_path`. Timestamps are
ISO 8601 strings. `mode` defaults to `startup`; `show_startup_hud` defaults to
true. The report must match the current GNOME Session Manager-derived session
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
shutdown represents verified safe fallbacks, while `failed` blocks handoff.

Numeric `current`/`total` or `fraction` supplies clamped 0–1 progress. Unknown
nonterminal progress is indeterminate. Terminal stages without explicit progress
count as complete for the overview; this visual fraction is not authorization.
Stages sharing `group_id` form one job named by `group_label`, with averaged
progress and merged activity. The HUD accepts at most 64 stages and the last 32
events per stage. Event fields are `at`, `state`, and `message`.

## Shutdown identity and evidence

Shutdown adds `operation_id`, `shutdown_action` (`poweroff` or `restart`),
`shutdown_origin: "preflight"`, and `cancelled`. Reports can include backend
`operation_state`; it does not replace the HUD's independent authorization
checks. A shutdown report must match the request or locally retained native
confirmation. A failed/cancelled report can remain visible without authorizing
anything.

`operation_context` contains exactly these six fields:

| Field | Meaning |
| --- | --- |
| `boot_id` | Current kernel boot identity. |
| `login_generation` | Exact current login identity. |
| `operation_id` | Same operation as the surrounding shutdown report. |
| `mode` | `shutdown`. |
| `attempt` | Positive integer attempt number. |
| `deadline` | Positive finite absolute monotonic seconds for this boot. |

The context is immutable. Regressing an attempt or changing fields within the
same attempt is rejected. Expiry, old boot/login identity, cancellation, and
missing context cannot authorize handoff. Legacy reports can be displayed, but
require a coordinator upgrade before shutdown authorization.

Rendered, commit, cancellation, and prepared evidence echo the exact context.
Prepared evidence also matches `schema_version`, `session_id`, `operation_id`,
and action. The native confirmation is invoked only after current completed
status, visible allocated HUD, paint acknowledgement, countdown, commit, and
prepared proof all agree. A terminal percentage or a stale ready file is
insufficient.

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
These reports are consumed only for startup presentation and cannot authorize
shutdown, reopen a hidden HUD, or enable cleanup.
