#!/usr/bin/env bash
# Runs the backdrop spike in a headless GNOME Shell on a private session bus,
# with its own config, data and cache directories: the real session's dconf
# database, extensions and screen are not touched. Prints the output directory
# (shell.log and shots/).
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
uuid=backdrop-spike@liquid-glass.test
out=${1:-$(mktemp -d -t lg-spike-XXXXXX)}
mode=${LG_SPIKE_MONITOR:-1920x1080}

mkdir -p "$out"/{config,data/gnome-shell/extensions,cache,shots}
rm -rf "$out/data/gnome-shell/extensions/$uuid"
cp -r "$here/$uuid" "$out/data/gnome-shell/extensions/"

export XDG_CONFIG_HOME="$out/config"
export XDG_DATA_HOME="$out/data"
export XDG_CACHE_HOME="$out/cache"
# The shell keeps its Wayland socket and a "disable extensions" marker (left
# behind if it crashes while starting) in the runtime dir; the real session's
# must not see either.
# Short, since a Wayland socket path is limited to 108 bytes.
export XDG_RUNTIME_DIR=$(mktemp -d /tmp/lgrt.XXXXXX)
export LG_SPIKE_OUT="$out/shots"
export LG_SPIKE_SCENARIO="${LG_SPIKE_SCENARIO:-full}"
export XDG_CURRENT_DESKTOP=GNOME
export XDG_SESSION_DESKTOP=gnome
unset WAYLAND_DISPLAY DISPLAY

socket="lg-spike-$$"

dbus-run-session -- bash -c "
  gsettings set org.gnome.shell enabled-extensions \"['$uuid']\"
  gsettings set org.gnome.shell disable-user-extensions false
  gsettings set org.gnome.shell welcome-dialog-last-shown-version '9999'
  exec timeout 120 gnome-shell --headless --wayland --virtual-monitor '$mode' --wayland-display '$socket'
" >"$out/shell.log" 2>&1 || true
# The session's document portal mounts itself there.
fusermount3 -u "$XDG_RUNTIME_DIR/doc" 2>/dev/null || true
rm -rf "$XDG_RUNTIME_DIR" 2>/dev/null || true

echo "$out"
