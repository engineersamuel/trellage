#!/usr/bin/env bash

set -euo pipefail

ownership_value='trellage-omp-profiles-v1'

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
ownership_marker="$install_root/.managed-by-trellage-omp-profiles"
command_path="$home/.local/bin/omp"

if [[ ! -e "$install_root" && ! -L "$install_root" ]]; then
  [[ ! -e "$command_path" && ! -L "$command_path" ]] \
    || refuse "unowned command remains: $command_path"
  printf 'omp is not installed; profile state was preserved.\n'
  exit 0
fi

[[ -d "$install_root" && ! -L "$install_root" ]] || refuse "unsafe runtime root: $install_root"
[[ "$(canonical_directory "$install_root")" == "$canonical_home/.local/share/trellage/omp" ]] \
  || refuse "redirected runtime root: $install_root"
[[ -f "$ownership_marker" && ! -L "$ownership_marker" ]] \
  || refuse "unowned runtime root: $install_root"
[[ "$(<"$ownership_marker")" == "$ownership_value" ]] \
  || refuse "unowned runtime root: $install_root"

if [[ -e "$command_path" || -L "$command_path" ]]; then
  [[ -L "$command_path" && "$(readlink "$command_path")" == "$installed_launcher" ]] \
    || refuse "unrelated command: $command_path"
  rm -- "$command_path"
fi

rm -rf -- "$install_root"
printf 'Uninstalled omp; OMP profile state and sessions were preserved.\n'
