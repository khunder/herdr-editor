#!/bin/sh
# Copies the mods in this repo into the Herdr app's folder (it hot-reloads them),
# checks each one, and installs the `hedit` launcher.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
app=${HERDR_APP_HOME:-$HOME/.config/herdr-app}
for mod in "$here"/mods/*/; do
  name=$(basename "$mod")
  mkdir -p "$app/mods/$name"
  cp "$mod"*.js "$mod"mod.json "$app/mods/$name/"
  ls "$mod"*.svg >/dev/null 2>&1 && cp "$mod"*.svg "$app/mods/$name/"
  herdr-app check "$app/mods/$name"
  echo "installed mod: $name"
done
mkdir -p "$HOME/.local/bin"
install -m 755 "$here/bin/hedit" "$HOME/.local/bin/hedit"
echo "installed: ~/.local/bin/hedit"
