# Verification record

Last checked: `2026-09-05T12:09:34+03:00` on GNOME Shell 46.0, native
Wayland.

## Confirmed

- `make check` passes metadata validation, JavaScript parsing, ESLint, and the
  static lifecycle safety assertions. Installer scripts pass ShellCheck.
- `tests/check.sh` passes the same repository checks through the supported test
  entry point.
- A clean `npm ci` with Node 20.19.5 reports zero vulnerabilities, and
  `make release-artifacts` builds a package whose exact file allowlist and
  metadata are verified before its SHA-256 file is produced.
- Install and uninstall were exercised against an isolated `XDG_DATA_HOME`.
- The installed `metadata.json`, `extension.js`, and `stylesheet.css` under
  `~/.local/share/gnome-shell/extensions/login-hud-v2@sagecat.local/` are
  byte-identical to the tracked source.
- Startup presentation is claimed from the persistent kernel `boot_id`, not
  from tmux presence. The backend claim tests confirm that a later GNOME login
  during the same OS boot receives `show_startup_hud: false`.
- Version 9 records dismissal for the exact session/start timestamp. A
  completed non-failing startup is also dismissed on lock/greeter transition,
  and a stale completed status cannot reappear after an extension reload.
- `login-hud-v2@sagecat.local` is present in GNOME's `enabled-extensions`
  setting.
- The initial GNOME `QueryEndSession` is passive. A shutdown request is created
  only from the final native `_confirm` callback and only after that dialog is
  fully closed.
- Shutdown work contains only tmux, desktop/browser, and integrity checkpoints.
  It has no cloud-drive, mount, warm-up, or GNOME deinitialization commands.
- The shutdown path requires a rendered HUD acknowledgement, visible countdown,
  and a prepared marker matching the operation, session, and action. Prepared
  polling is bounded, and cancellation is operation-bound and emitted at most
  once across repeated status updates.
- The final GNOME action is intercepted only while
  `wsctl-gnome-session.service` is active; a missing companion service fails
  open to the original native GNOME shutdown.
- The complete workspace test target passes: 140 Python tests, the Chrome
  extension protocol checks, 14 gnome-winctl Python tests, 31 gnome-winctl Node
  tests, and the Login HUD static checks.
- The live coordinator is active, and the current startup status is ready with
  `show_startup_hud: false`.

## Activation boundary

The current GNOME Shell process loaded v2 version 9 at login and retains that
JavaScript module across disable/enable on Wayland. Version 10 is byte-identical
between the tracked runtime source and the installed extension directory, but
its coordinator fail-open check activates at the next fresh GNOME Shell login.

## Deliberately not claimed

No real power-off or reboot was triggered while producing this record. The
checks confirm the repository, installed payload, and shutdown protocol
invariants; an actual machine shutdown is intentionally not represented as a
completed test.
