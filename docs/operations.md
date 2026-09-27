# Operation and troubleshooting

## Startup and status tabs

The coordinator publishes complete reports for the current GNOME login. Login
HUD remains hidden until it receives one. `show_startup_hud: false` suppresses
startup presentation without preventing restoration; the standard coordinator
uses this for later logins during the same OS boot.

The **Відновлення** (Restoration) tab shows jobs in producer order. Click a job to
expand its substeps and recent activity. A numeric fraction or count produces a
progress bar; unknown progress uses an indeterminate indicator. Waiting means
that a dependency has not completed, rather than a verified success.

Once startup jobs finish without failure, **OK** dismisses the panel. The private
dismissal marker binds to that session and start time, so re-enabling the
extension does not revive completed progress. Locking the screen also dismisses
completed, non-failing startup; active work and failures are retained. A startup
failure offers **Show full error log** and **Close**. Ordinary running startup
has no shutdown Cancel control and never grabs desktop input.

**Важливе** (Important) lists active blocker/critical incidents from the configured
first-party inventory. Expand a row for safe diagnostic details. **Переглянуто**
(Reviewed) acknowledges it; resolution comes from a later successful backend
scan. Missing, malformed, incomplete, or stale reports are not evidence of
health. This tab never appears during shutdown.

**GC-профілі** (Cleanup profiles) displays the latest success or failure for each
profile, including disabled profiles. Its report must have a running daemon and
a heartbeat no older than 30 seconds. Unavailable or stale data is shown as
unavailable. The HUD has no cleanup start/stop controls.

## Power off and restart

1. Use GNOME's normal Power Off or Restart action and confirm its native dialog.
2. If the coordinator is active, the HUD shows checkpoint preparation. It does
   not intercept the earlier query or begin work merely because a status file
   says shutdown.
3. **Cancel shutdown** or Escape withdraws authorization immediately. The modal
   grab is released even if writing cancellation fails. Backend recovery can
   remain visible; cancelling does not claim that recovery has completed.
4. Once preparation is verified, the HUD must paint a ready frame and keep its
   five-second countdown visible. The coordinator must then acknowledge the
   exact commit with a prepared marker before GNOME receives the saved native
   confirmation.

A failed step stops handoff, releases modal capture, and keeps its report visible
with **Show full error log**. Use **Close** or Escape to dismiss the report.
While recovery is still running, the button reads **Hide (recovery continues)**;
hiding the HUD does not interrupt recovery or permit shutdown. A `degraded` result
means verified fallback state was retained, with the reason in stage activity.
It is distinct from failure.

Lock/greeter transitions, hidden or unallocated HUD, expired context, changed
operation identity, and failed status prevent authorization. GNOME's Boot
Options restart stays on the native path because it changes bootloader state
before confirmation. Privileged forced shutdown is outside the UI protocol.

## Verify installed and running versions

```sh
gnome-extensions info login-hud-v2@sagecat.local
gdbus call --session --dest org.gnome.Shell \
  --object-path /org/sagecat/LoginHud \
  --method org.sagecat.LoginHud.GetState
```

`GetState` is read-only. It returns the loaded UUID, metadata version, imported
build revision, visible/modal state, and cancellation/recovery evidence. A
`development` revision reports unknown source identity. Copied files and loaded
Shell modules can differ until the next login; a successful install is not proof
of activation. Release bundles stamp `buildInfo.js` with the source revision.

## Troubleshooting

| Symptom | Check or action |
| --- | --- |
| No startup panel | Confirm the coordinator is running and published a valid current-session status; `show_startup_hud: false`, an existing dismissal, or a completed report older than five minutes can intentionally hide it. |
| Old appearance after upgrade | Compare running `GetState` build with the installed release; log out and back in to activate changed Wayland modules. |
| Shutdown says the coordinator must be upgraded | Its report lacks the complete operation context. Upgrade the coordinator and HUD together; legacy telemetry cannot authorize shutdown. |
| Shutdown preparation fails | Read the failed stage and its error log. The existing checkpoint may have been retained; do not infer success from a terminal progress bar. Retry through GNOME after addressing the cause. |
| Cancellation remains pending | Authorization is withdrawn, but recovery is not yet proven. Inspect coordinator status; a late ready report cannot re-arm the cancelled operation. |
| Important/cleanup tab says unavailable | Inspect the corresponding producer. Do not treat an absent heartbeat or incomplete scan as healthy. |
| A large activity log does not fit | Scroll the job list. The header and action area remain outside that scroll area. Monitor/work-area/scale changes recalculate layout. |

Useful read-only coordinator diagnostics:

```sh
systemctl --user status wsctl-gnome-session.service
journalctl --user -u wsctl-gnome-session.service -b --no-pager
```

Runtime reports and logs may contain personal application information. Review
and redact them before sharing; the published screenshots use synthetic data.
