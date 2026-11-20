#!/bin/sh
# Copy the mod into the Herdr app's mods folder; Herdr loads it within a second.
# Herdr only watches real files there, so this installs a copy, not a symlink.
# Run it again after pulling a new version.
set -eu
src="$(cd "$(dirname "$0")" && pwd)/mods/plan-progress"
dest="${HERDR_APP_HOME:-$HOME/.config/herdr-app}/mods/plan-progress"
[ -L "$dest" ] && rm "$dest"
mkdir -p "$dest"
for f in main.js parse.js mod.json; do cp "$src/$f" "$dest/$f.tmp" && mv "$dest/$f.tmp" "$dest/$f"; done
herdr-app check "$dest"
