# Verification record

Last checked: `2026-09-04T01:36:16+03:00` on GNOME Shell 46.0, native
Wayland.

## Confirmed

- `make check` passes metadata validation, JavaScript parsing, ESLint, and the
  static lifecycle safety assertions.
- `tests/check.sh` passes the same repository checks through the supported test
  entry point.
- The installed `metadata.json`, `extension.js`, and `stylesheet.css` under
  `~/.local/share/gnome-shell/extensions/login-hud-v2@sagecat.local/` are
  byte-identical to the tracked source.
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
- The complete workspace test target passes: 140 Python tests, the Chrome
  extension protocol checks, 14 gnome-winctl Python tests, 31 gnome-winctl Node
  tests, and the Login HUD static checks.
- The live coordinator is active, all three cloud-drive services remain active
  and mounted, and the current startup status is ready with
  `show_startup_hud: false`.

## Activation boundary

The GNOME Shell process that was already running during installation still
indexes only the legacy `login-hud@sagecat.local` UUID. The new v2 extension is
installed and enabled, but its first live activation therefore remains pending
the next fresh GNOME Shell login. This is recorded explicitly so source and
installation verification are not mistaken for a live v2 activation in the
current Shell process.

## Deliberately not claimed

No real power-off or reboot was triggered while producing this record. The
checks confirm the repository, installed payload, and shutdown protocol
invariants; an actual machine shutdown is intentionally not represented as a
completed test.
