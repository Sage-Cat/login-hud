#!/bin/sh
set -eu

uuid='login-hud-v2@sagecat.local'
disable_extension=true
data_home=${XDG_DATA_HOME:-"$HOME/.local/share"}
extension_root="$data_home/gnome-shell/extensions"
destination="$extension_root/$uuid"

if [ "${1:-}" = '--help' ]; then
    printf 'Usage: %s [--no-disable]\n' "$0"
    printf 'Disables and removes %s for the current user.\n' "$uuid"
    exit 0
fi
if [ "${1:-}" = '--no-disable' ]; then
    disable_extension=false
    shift
fi
if [ "$#" -ne 0 ]; then
    printf 'uninstall: unknown argument: %s\n' "$1" >&2
    exit 2
fi

case "$destination" in
    "$extension_root/$uuid") ;;
    *)
        printf 'uninstall: refusing unexpected destination: %s\n' "$destination" >&2
        exit 1
        ;;
esac

if [ "$disable_extension" = true ] && command -v gnome-extensions >/dev/null 2>&1; then
    gnome-extensions disable "$uuid" >/dev/null 2>&1 || true
fi

if [ -d "$destination" ]; then
    rm -rf -- "$destination"
    printf 'Removed %s\n' "$destination"
else
    printf '%s is not installed.\n' "$uuid"
fi

printf '%s\n' 'Log out and back in to unload any JavaScript retained by Wayland GNOME Shell.'
