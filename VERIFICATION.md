# Verification record

Last checked: `2026-09-03T22:03:10+03:00` on GNOME Shell 46.0, native
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
- The shutdown path retains GNOME's original confirmation, requires a rendered
  HUD acknowledgement and visible countdown, and releases the retained action
  only after a matching prepared marker. Cancellation is operation-bound and
  emitted at most once.

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
