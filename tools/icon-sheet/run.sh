#!/usr/bin/env bash
# Builds a contact sheet of every installed application's icon taken apart
# into glass plates and a symbol, in each icon theme given (default: Yaru,
# Adwaita, MacTahoe-dark), and prints the HTML file's path. Build the
# extension first (npm run build): the analysis is its dist/iconStyle.
#
#   tools/icon-sheet/run.sh [theme...]
#   LG_ICON_SHEET_OUT   output directory (default: tools/icon-sheet/out, which git ignores)
#   LG_ICON_SHEET_ONLY  only applications whose id or name contains one of these words
#
# The page takes its controls from the address too, e.g.
#   icon-sheet.html#mode=tinted&variant=dark&accent=%23e01b24&size=96&filter=calculator|files&debug=0
# After changing only the colours or the shader, the page can be made again
# from the JSON already there, without taking the icons apart again:
#   node tools/icon-sheet/build-sheet.cjs tools/icon-sheet/out/icon-sheet.html tools/icon-sheet/out/*.json
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
out=${LG_ICON_SHEET_OUT:-$here/out}
mkdir -p "$out"
themes=("$@")
[ ${#themes[@]} -gt 0 ] || themes=(Yaru Adwaita MacTahoe-dark)

# St lives with the shell, and needs mutter's typelibs.
st_typelib=$(find /usr/lib /usr/lib64 -name 'St-*.typelib' -path '*gnome-shell*' 2>/dev/null | head -n1)
meta_typelib=$(find /usr/lib /usr/lib64 -name 'Meta-*.typelib' -path '*mutter*' 2>/dev/null | head -n1)
if [ -z "$st_typelib" ] || [ -z "$meta_typelib" ]; then
  echo "St or Meta typelib not found" >&2
  exit 1
fi
shell_dir=$(dirname "$st_typelib")
mutter_dir=$(dirname "$meta_typelib")
export LD_LIBRARY_PATH="$shell_dir:$mutter_dir:${LD_LIBRARY_PATH:-}"
export GI_TYPELIB_PATH="$shell_dir:$mutter_dir:${GI_TYPELIB_PATH:-}"
# The theme is picked through org.gnome.desktop.interface; keep that in memory.
export GSETTINGS_BACKEND=memory
# Applications shown only in GNOME (OnlyShowIn=GNOME) are listed only when the desktop says it is GNOME.
export XDG_CURRENT_DESKTOP=GNOME

files=()
for theme in "${themes[@]}"; do
  # shellcheck disable=SC2086
  gjs -m "$here/collect.js" "$theme" "$out/$theme.json" ${LG_ICON_SHEET_ONLY:-}
  files+=("$out/$theme.json")
done
node "$here/build-sheet.cjs" "$out/icon-sheet.html" "${files[@]}"
echo "$out/icon-sheet.html"
