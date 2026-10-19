#!/usr/bin/env bash
# Runs the built Liquid Glass extension with Dash to Dock and the test driver
# (lg-driver@liquid-glass.test) in a headless GNOME Shell on a private session
# bus, with its own config, data and cache directories, like run-nested.sh.
# Build first (npm run build). Prints the output directory (shell.log, shots/).
#
#   LG_DRV_SCENARIO   the driver's scenario (default: dock)
#   LG_SPIKE_MONITOR  virtual monitor mode (default: 1920x1080)
#   LG_MONITORS_XML   a monitors.xml to use (e.g. for a fractional scale)
#   LG_DTD_SETTINGS   more Dash to Dock settings, "key value" pairs separated by ";"
#                     (e.g. "dash-max-icon-size 56;apply-custom-theme true")
#   LG_EXTRA_EXTENSIONS  more UUIDs from ~/.local/share/gnome-shell/extensions or
#                        /usr/share/gnome-shell/extensions to enable (e.g.
#                        blur-my-shell@aunetx, ding@rastersoft.com), space separated
#   LG_FAVORITES      the dock's favorite-apps, a GVariant list (e.g. "['kitty.desktop']")
#   LG_BENCH=1        also enable tools/perf/lg-bench@liquid-glass.test
#   LG_SHELL_TIMEOUT  seconds before the shell is killed (default: 180)
#   LG_X11=1          run an X11 session on Xvfb instead (GNOME 48 and older)
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
# The checkout's directory name is historical; the uuid the shell loads is the
# one metadata.json declares.
ext_dir=liquid-glass@thinkingcoding1231.gmail.com
lg_uuid=$(node -p "require('$repo/$ext_dir/metadata.json').uuid")
dtd_uuid=dash-to-dock@micxgx.gmail.com
drv_uuid=lg-driver@liquid-glass.test
dtd_src=${LG_DTD_DIR:-$HOME/.local/share/gnome-shell/extensions/$dtd_uuid}
out=${1:-$(mktemp -d -t lg-glass-XXXXXX)}
mode=${LG_SPIKE_MONITOR:-1920x1080}

ext="$out/data/gnome-shell/extensions"
mkdir -p "$out"/{config,cache,shots} "$ext"
rm -rf "${ext:?}"/*
mkdir -p "$ext/$lg_uuid"
for f in metadata.json extension.js stylesheet.css dist shaders schemas fonts media; do
  cp -r "$repo/$ext_dir/$f" "$ext/$lg_uuid/"
done
cp -r "$dtd_src" "$ext/$dtd_uuid"
cp -r "$here/$drv_uuid" "$ext/"
extra=""
if [ "${LG_BENCH:-}" = 1 ]; then
  cp -r "$repo/tools/perf/lg-bench@liquid-glass.test" "$ext/"
  extra=", 'lg-bench@liquid-glass.test'"
fi
for uuid in ${LG_EXTRA_EXTENSIONS:-}; do
  src="$HOME/.local/share/gnome-shell/extensions/$uuid"
  [ -d "$src" ] || src="/usr/share/gnome-shell/extensions/$uuid"
  cp -r "$src" "$ext/"
  extra="$extra, '$uuid'"
done
if [ -n "${LG_MONITORS_XML:-}" ]; then
  cp "$LG_MONITORS_XML" "$out/config/monitors.xml"
fi

export XDG_CONFIG_HOME="$out/config"
export XDG_DATA_HOME="$out/data"
export XDG_CACHE_HOME="$out/cache"
# The shell keeps its Wayland socket and a "disable extensions" marker (left
# behind if it crashes while starting) in the runtime dir; the real session's
# must not see either.
# Short, since a Wayland socket path is limited to 108 bytes.
export XDG_RUNTIME_DIR=$(mktemp -d /tmp/lgrt.XXXXXX)
export LG_SPIKE_OUT="$out/shots"
export LG_FAVORITES="${LG_FAVORITES:-}"
export LG_DRV_SCENARIO="${LG_DRV_SCENARIO:-dock}"
export XDG_CURRENT_DESKTOP=GNOME
export XDG_SESSION_DESKTOP=gnome
unset WAYLAND_DISPLAY DISPLAY

shell_args="--headless --wayland"
# Inside a distrobox (tools/gnome-versions): the system bus is the host's,
# under /run/host, and Xwayland fails to find its systemd unit.
if [ -f /run/.containerenv ]; then
  export DBUS_SYSTEM_BUS_ADDRESS=unix:path=/run/host/run/dbus/system_bus_socket
  shell_args="$shell_args --no-x11"
fi
xvfb=""
# LG_X11=1: an X11 session on Xvfb instead (GNOME 48 and older have one).
if [ "${LG_X11:-}" = 1 ]; then
  Xvfb :77 -screen 0 "${mode}x24" -nolisten tcp >/dev/null 2>&1 &
  xvfb=$!
  sleep 1
  export DISPLAY=:77
  shell_args="--x11"
fi

socket="lg-glass-$$"
dtd_schemas="$ext/$dtd_uuid/schemas"
dtd_extra=""
IFS=';' read -ra dtd_pairs <<< "${LG_DTD_SETTINGS:-}"
for pair in "${dtd_pairs[@]}"; do
  [ -n "$pair" ] && dtd_extra="$dtd_extra
  gsettings --schemadir '$dtd_schemas' set org.gnome.shell.extensions.dash-to-dock $pair"
done

dbus-run-session -- bash -c "
  gsettings set org.gnome.shell enabled-extensions \"['$drv_uuid', '$dtd_uuid', '$lg_uuid'$extra]\"
  gsettings set org.gnome.shell disable-user-extensions false
  [ -n \"\${LG_FAVORITES:-}\" ] && gsettings set org.gnome.shell favorite-apps \"\$LG_FAVORITES\" || true
  gsettings set org.gnome.shell welcome-dialog-last-shown-version '9999'
  # The desktop widgets and the glass clock ship off; the scenarios that cover
  # them need them on.
  gsettings --schemadir '$ext/$lg_uuid/schemas' set org.gnome.shell.extensions.$lg_uuid enable-glass-clock true
  gsettings --schemadir '$ext/$lg_uuid/schemas' set org.gnome.shell.extensions.$lg_uuid enable-desktop-widgets true
  gsettings --schemadir '$dtd_schemas' set org.gnome.shell.extensions.dash-to-dock dock-fixed true
  gsettings --schemadir '$dtd_schemas' set org.gnome.shell.extensions.dash-to-dock intellihide false
  gsettings --schemadir '$dtd_schemas' set org.gnome.shell.extensions.dash-to-dock dock-position 'BOTTOM'$dtd_extra
  if [ \"$shell_args\" = --x11 ]; then
    exec timeout ${LG_SHELL_TIMEOUT:-180} gnome-shell --x11
  fi
  exec timeout ${LG_SHELL_TIMEOUT:-180} gnome-shell $shell_args --virtual-monitor '$mode' --wayland-display '$socket'
" >"$out/shell.log" 2>&1 || true
[ -n "$xvfb" ] && kill "$xvfb" 2>/dev/null
# The session's document portal mounts itself there.
fusermount3 -u "$XDG_RUNTIME_DIR/doc" 2>/dev/null || true
rm -rf "$XDG_RUNTIME_DIR" 2>/dev/null || true

# The session's caches and indexes (localsearch, evolution) take hundreds of
# megabytes; only the log and the screenshots are results.
sleep 1
rm -rf "$out/data" "$out/cache" 2>/dev/null || true

echo "$out"
