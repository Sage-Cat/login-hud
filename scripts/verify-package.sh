#!/bin/sh
set -eu

archive=${1:-dist/login-hud-v2@sagecat.local.shell-extension.zip}
uuid='login-hud-v2@sagecat.local'

for command in unzip jq; do
    if ! command -v "$command" >/dev/null 2>&1; then
        printf 'verify-package: %s is required\n' "$command" >&2
        exit 1
    fi
done
if [ ! -f "$archive" ]; then
    printf 'verify-package: archive does not exist: %s\n' "$archive" >&2
    exit 1
fi

temporary_dir=$(mktemp -d)
trap 'rm -rf -- "$temporary_dir"' EXIT HUP INT TERM

unzip -Z1 "$archive" | sed '/\/$/d' | LC_ALL=C sort > "$temporary_dir/actual"
printf '%s\n' extension.js metadata.json stylesheet.css | LC_ALL=C sort > "$temporary_dir/expected"
if ! diff -u "$temporary_dir/expected" "$temporary_dir/actual"; then
    printf 'verify-package: unexpected archive contents\n' >&2
    exit 1
fi

unzip -p "$archive" metadata.json > "$temporary_dir/metadata.json"
jq -e --arg uuid "$uuid" \
    '.uuid == $uuid and .["shell-version"] == ["46"] and (.version | type == "number")' \
    "$temporary_dir/metadata.json" >/dev/null

printf 'verify-package: %s is valid\n' "$archive"
