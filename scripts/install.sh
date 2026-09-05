#!/bin/sh
set -eu

uuid='login-hud-v2@sagecat.local'
enable_extension=true
script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
source_dir=$(CDPATH='' cd -- "$script_dir/.." && pwd)
data_home=${XDG_DATA_HOME:-"$HOME/.local/share"}
extension_root="$data_home/gnome-shell/extensions"
destination="$extension_root/$uuid"

if [ "${1:-}" = '--help' ]; then
    printf 'Usage: %s [--no-enable]\n' "$0"
    printf 'Installs and enables %s for the current user.\n' "$uuid"
    exit 0
fi
if [ "${1:-}" = '--no-enable' ]; then
    enable_extension=false
    shift
fi
if [ "$#" -ne 0 ]; then
    printf 'install: unknown argument: %s\n' "$1" >&2
    exit 2
fi

for file in metadata.json extension.js stylesheet.css; do
    if [ ! -f "$source_dir/$file" ]; then
        printf 'install: missing source file: %s\n' "$source_dir/$file" >&2
        exit 1
    fi
done

install -d -m 0755 "$extension_root" "$destination"
install -m 0644 \
    "$source_dir/metadata.json" \
    "$source_dir/extension.js" \
    "$source_dir/stylesheet.css" \
    "$destination/"

printf 'Installed %s to %s\n' "$uuid" "$destination"
if [ "$enable_extension" = false ]; then
    printf 'Enable manually with: gnome-extensions enable %s\n' "$uuid"
elif command -v gnome-extensions >/dev/null 2>&1; then
    if gnome-extensions enable "$uuid" >/dev/null 2>&1; then
        printf 'Enabled %s.\n' "$uuid"
    else
        printf '%s\n' \
            'GNOME Shell has not indexed this installation yet; log out and back in, then run:' \
            "  gnome-extensions enable $uuid"
    fi
else
    printf '%s\n' \
        'gnome-extensions is unavailable. Log out and back in, then enable the extension with GNOME Extensions.'
fi

printf '%s\n' \
    'Wayland keeps loaded extension modules in memory; log out and back in after an upgrade.'
