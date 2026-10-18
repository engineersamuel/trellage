#!/usr/bin/env bash

set -euo pipefail

ownership_value='trellage-omp-profiles-v2'

refuse() {
  printf 'omp uninstall: %s\n' "$1" >&2
  exit 1
}

canonical_directory() {
  CDPATH= cd -P -- "$1" >/dev/null 2>&1 && pwd -P
}

home="${HOME-}"
[[ "$home" == /* && "$home" != / && -d "$home" && ! -L "$home" ]] \
  || refuse "unsafe HOME: $home"
canonical_home="$(canonical_directory "$home")" || refuse "cannot resolve HOME: $home"
install_root="$home/.local/share/trellage/omp"
installed_launcher="$install_root/bin/omp"
installed_catalog="$install_root/catalog.json"
ownership_marker="$install_root/.managed-by-trellage-omp-profiles"

require_safe_directory() {
  local path="$1" expected="$2" description="$3" canonical_path

  if [[ -e "$path" || -L "$path" ]]; then
    [[ -d "$path" && ! -L "$path" ]] || refuse "unsafe $description: $path"
    canonical_path="$(canonical_directory "$path")" || refuse "cannot resolve $description: $path"
    [[ "$canonical_path" == "$expected" ]] || refuse "redirected $description: $path"
  fi
}

require_safe_directory "$home/.local" "$canonical_home/.local" 'runtime ancestor'
require_safe_directory "$home/.local/share" "$canonical_home/.local/share" 'runtime ancestor'
require_safe_directory "$home/.local/share/trellage" "$canonical_home/.local/share/trellage" 'runtime parent'

if [[ ! -e "$install_root" && ! -L "$install_root" ]]; then
  printf 'Trellage OMP is not installed; the host OMP installation and all profile state were preserved.\n'
  exit 0
fi

[[ -d "$install_root" && ! -L "$install_root" ]] || refuse "unsafe runtime root: $install_root"
[[ "$(canonical_directory "$install_root")" == "$canonical_home/.local/share/trellage/omp" ]] \
  || refuse "redirected runtime root: $install_root"
[[ -f "$ownership_marker" && ! -L "$ownership_marker" ]] \
  || refuse "unowned runtime root: $install_root"
[[ "$(<"$ownership_marker")" == "$ownership_value" ]] \
  || refuse "unowned runtime root: $install_root"
require_safe_directory "$install_root/bin" "$canonical_home/.local/share/trellage/omp/bin" 'runtime bin'
[[ -f "$installed_launcher" && ! -L "$installed_launcher" ]] \
  || refuse "unsafe managed launcher: $installed_launcher"
[[ -f "$installed_catalog" && ! -L "$installed_catalog" ]] \
  || refuse "unsafe managed catalog: $installed_catalog"


rm -rf -- "$install_root"
printf 'Uninstalled Trellage OMP; the host OMP installation and all profile state were preserved.\n'
