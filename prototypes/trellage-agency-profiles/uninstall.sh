#!/usr/bin/env bash
set -euo pipefail

readonly ownership_value='trellage-agency-profiles-v1'

refuse() {
  printf 'agx uninstall: %s\n' "$1" >&2
  exit 1
}

canonical_directory() {
  CDPATH= cd -P -- "$1" >/dev/null 2>&1 && pwd -P
}

home="${HOME-}"
[[ -n "$home" && "$home" == /* && "$home" != / && -d "$home" && ! -L "$home" ]] \
  || refuse "unsafe HOME: ${home:-<empty>}"
canonical_home="$(canonical_directory "$home")" || refuse "cannot resolve HOME: $home"
install_root="$canonical_home/.local/share/trellage/agx"
runtime_bin="$install_root/bin"
installed_launcher="$runtime_bin/agx"
installed_catalog="$install_root/catalog.json"
ownership_marker="$install_root/.managed-by-trellage-agency-profiles"
command_path="$canonical_home/.local/bin/agx"

if [[ ! -e "$install_root" ]]; then
  [[ ! -e "$command_path" && ! -L "$command_path" ]] \
    || refuse "refusing unowned command: $command_path"
  printf 'agx is not installed; profile homes were preserved.\n'
  exit 0
fi
[[ -d "$install_root" && ! -L "$install_root" ]] || refuse "unsafe runtime root: $install_root"
[[ -f "$ownership_marker" && ! -L "$ownership_marker" && -r "$ownership_marker" ]] \
  || refuse "refusing unowned runtime root: $install_root"
[[ "$(<"$ownership_marker")" == "$ownership_value" ]] \
  || refuse "refusing unowned runtime root: $install_root"
[[ -d "$runtime_bin" && ! -L "$runtime_bin" ]] || refuse "unsafe runtime bin: $runtime_bin"
[[ -f "$installed_launcher" && ! -L "$installed_launcher" ]] \
  || refuse "unsafe managed launcher: $installed_launcher"
[[ -f "$installed_catalog" && ! -L "$installed_catalog" ]] \
  || refuse "unsafe managed catalog: $installed_catalog"
if [[ -e "$command_path" || -L "$command_path" ]]; then
  [[ -L "$command_path" && "$(readlink "$command_path")" == "$installed_launcher" ]] \
    || refuse "refusing to remove unrelated command: $command_path"
  rm "$command_path"
fi
rm -f -- "$installed_launcher" "$installed_catalog" "$ownership_marker"
rmdir "$runtime_bin" "$install_root" 2>/dev/null \
  || refuse "managed runtime contains unrelated files: $install_root"
printf 'Uninstalled agx; profile homes were preserved.\n'
