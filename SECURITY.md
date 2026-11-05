# Security policy

## Supported version

The latest tagged release on GNOME Shell 46 is supported. Other Shell versions
have not been reviewed because the HUD relies on private Shell interfaces.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting for this repository. Do not open a
public issue for a vulnerability that could block power off or restart, bypass
startup abort, or act on a stale operation.

Reports should include the GNOME Shell version, extension version, relevant
local journal excerpts with secrets removed, and a minimal reproduction.

The extension performs no network requests. Runtime status and startup
control markers stay inside the current user's private runtime directory.
