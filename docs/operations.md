# Operation and troubleshooting

## Installation

With Workspace State, use its [coordinated installer](https://github.com/Sage-Cat/workspace-state/blob/main/docs/deployment.md)
to activate compatible components together at the next login.

For a standalone installation, download the extension ZIP and `SHA256SUMS` from
[Releases](https://github.com/Sage-Cat/login-hud/releases/latest), then run:

```sh
sha256sum --check --ignore-missing SHA256SUMS
gnome-extensions install --force login-hud-v2@sagecat.local.shell-extension.zip
```

Log out and back in, then enable the extension:

```sh
gnome-extensions enable login-hud-v2@sagecat.local
```

Installation does not restart the desktop or prove that the new code is loaded.
Use the read-only version checks below to distinguish installed and running code.

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
failure offers **Show full error log** and **Close**. Running startup offers
**Abort restoration** and **Run in background**, and never grabs desktop input.

**Важливе** (Important) lists active blocker/critical incidents from the configured
first-party inventory. Expand a row for safe diagnostic details. **Переглянуто**
(Reviewed) acknowledges it; resolution comes from a later successful backend
scan. Missing, malformed, incomplete, or stale reports are not evidence of
health.

**GC-профілі** (Cleanup profiles) displays the latest success or failure for each
profile, including disabled profiles. Its report must have a running daemon and
a heartbeat no older than 30 seconds. Unavailable or stale data is shown as
unavailable. The HUD has no cleanup start/stop controls.

## Power off and restart

The HUD does not take part in power off or restart. GNOME's Power Off and
Restart actions, including their confirmation dialog, run natively and are never
intercepted, delayed, or cancelled by the extension. A status document whose
`mode` is not `startup` is ignored. Any shutdown preparation is owned by the
coordinator, not by this extension.

## Verify installed and running versions

```sh
gnome-extensions info login-hud-v2@sagecat.local
gdbus call --session --dest org.gnome.Shell \
  --object-path /org/sagecat/LoginHud \
  --method org.sagecat.LoginHud.GetState
```

`GetState` is read-only. It returns the loaded UUID, metadata version, imported
build revision, visible state, operation context, and startup abort state. A
`development` revision reports unknown source identity. Copied files and loaded
Shell modules can differ until the next login; a successful install is not proof
of activation. Release bundles stamp `buildInfo.js` with the source revision.

## Troubleshooting

| Symptom | Check or action |
| --- | --- |
| No startup panel | Confirm the coordinator is running and published a valid current-session status; `show_startup_hud: false`, an existing dismissal, or a completed report older than five minutes can intentionally hide it. |
| Old appearance after upgrade | Compare running `GetState` build with the installed release; log out and back in to activate changed Wayland modules. |
| Important/cleanup tab says unavailable | Inspect the corresponding producer. Do not treat an absent heartbeat or incomplete scan as healthy. |
| A large activity log does not fit | Scroll the job list. The header and action area remain outside that scroll area. Monitor/work-area/scale changes recalculate layout. |

Useful read-only coordinator diagnostics:

```sh
systemctl --user status wsctl-gnome-session.service
journalctl --user -u wsctl-gnome-session.service -b --no-pager
```

Runtime reports and logs may contain personal application information. Review
and redact them before sharing; the published screenshots use synthetic data.
