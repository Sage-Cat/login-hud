# Contributing

Login HUD currently targets GNOME Shell 46. Keep changes scoped to that runtime
unless a compatibility change also updates `metadata.json`, documentation, and
tests.

## Development checks

```sh
npm ci
make check
make release-artifacts
```

Before submitting a change:

- keep startup behavior non-modal;
- preserve native GNOME shutdown when the coordinator is unavailable;
- keep every shutdown marker bound to the operation and GNOME session;
- retain cancellation until the final GNOME handoff;
- never add cloud-drive, GPU, or operating-system teardown to the extension;
- add or update a lifecycle assertion for safety-sensitive behavior.

GNOME Shell modules may remain cached after disable/enable on Wayland. Validate
runtime changes in a fresh GNOME login as well as with the static checks.
