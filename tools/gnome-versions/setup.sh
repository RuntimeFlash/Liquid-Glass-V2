#!/usr/bin/env bash
# Creates the distrobox "gnomeVERSION" (home ~/gnomeVERSION-home) with that
# GNOME Shell release, for run.sh and for tools/backdrop-spike/run-glass.sh.
# Run on the host; needs podman and distrobox.
#
#   setup.sh VERSION    VERSION is 46, 47, 48, 49 or 51 (50 is the host's)
#
# 46 is Ubuntu 24.04 (its mutter 46.2 still has the old Clutter.Clone
# transform), 48 Debian 13, 47, 49 and 51 Fedora 41, 43 and 45.
#
# Installing inside a container cannot touch udev or systemd, so Fedora's
# package scripts are skipped and the schemas compiled afterwards; the
# "Permission denied" lines from Debian's are harmless.
# GMenu (gnome-menus) is there for ArcMenu, Xvfb for run-glass.sh LG_X11=1.
set -euo pipefail

version=${1:-}
apt_apps="gnome-shell gnome-shell-extension-prefs gnome-shell-extension-manager dbus-bin dbus-daemon \
  unzip libglib2.0-bin foot kitty gnome-text-editor nautilus mesa-utils-bin gir1.2-gmenu-3.0 xvfb"
dnf_apps="gnome-shell mutter gjs dbus-daemon unzip glib2 foot kitty gnome-text-editor nautilus \
  gnome-extensions-app flatpak adwaita-icon-theme mesa-demos gnome-menus"

case "$version" in
  46) image=quay.io/toolbx/ubuntu-toolbox:24.04 ;;
  47) image=registry.fedoraproject.org/fedora-toolbox:41 ;;
  48) image=quay.io/toolbx-images/debian-toolbox:13 ;;
  49) image=registry.fedoraproject.org/fedora-toolbox:43 ;;
  51) image=registry.fedoraproject.org/fedora-toolbox:45 ;;
  *) echo "usage: $(basename "$0") 46|47|48|49|51" >&2; exit 2 ;;
esac

box=gnome$version
mkdir -p "$HOME/$box-home"
distrobox create --yes --name "$box" --image "$image" --home "$HOME/$box-home"

case "$version" in
  46|48)
    distrobox enter "$box" -- bash -c "sudo apt-get update -q &&
      sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -q $apt_apps"
    ;;
  *)
    # 49 and 51 run with --devkit: the viewer is in mutter-devel (49) or
    # mutter-devkit (51), and it needs PipeWire.
    extra="pipewire wireplumber"
    [ "$version" = 47 ] && extra="$extra xorg-x11-server-Xvfb"
    [ "$version" = 49 ] && extra="$extra mutter-devel.x86_64"
    [ "$version" = 51 ] && extra="$extra mutter-devkit"
    distrobox enter "$box" -- bash -c "sudo dnf install -y --setopt=tsflags=noscripts $dnf_apps $extra;
      sudo glib-compile-schemas /usr/share/glib-2.0/schemas"
    # Extension Manager is not packaged in Fedora.
    distrobox enter "$box" -- bash -c "flatpak --user remote-add --if-not-exists flathub \
      https://dl.flathub.org/repo/flathub.flatpakrepo &&
      flatpak --user install -y --noninteractive flathub com.mattjakeman.ExtensionManager"
    ;;
esac

distrobox enter "$box" -- gnome-shell --version
