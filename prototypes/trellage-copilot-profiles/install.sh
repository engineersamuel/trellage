#!/usr/bin/env bash
set -euo pipefail

source_dir="$(cd "$(dirname "$0")" && pwd)"
local_dir="$HOME/.local"
share_dir="$local_dir/share"
runtime_parent="$share_dir/trellage"
install_root="$runtime_parent/cpx"
installed_launcher="$install_root/bin/cpx"
installed_catalog="$install_root/catalog.json"
ownership_marker="$install_root/.managed-by-trellage-profiles"
ownership_value='trellage-profiles-v1'
command_dir="$local_dir/bin"
command_path="$command_dir/cpx"
runtime_owned=false

refuse() {
  printf 'cpx install: %s\n' "$1" >&2
  exit 1
}

canonical_directory() {
  (CDPATH= cd -P -- "$1" >/dev/null 2>&1 && pwd -P)
}

require_safe_existing_directory() {
  local path="$1"
  local expected="$2"
  local description="$3"
  local canonical_path

  if [[ -e "$path" || -L "$path" ]]; then
    [[ ! -L "$path" ]] || refuse "refusing unsafe symlinked $description: $path"
    [[ -d "$path" ]] || refuse "refusing unsafe non-directory $description: $path"
    canonical_path="$(canonical_directory "$path")" \
      || refuse "cannot resolve $description: $path"
    [[ "$canonical_path" == "$expected" ]] \
      || refuse "refusing redirected $description: $path"
  fi
}

case "$HOME" in
  /*) ;;
  *) refuse "HOME must be an absolute path: $HOME" ;;
esac
[[ ! -L "$HOME" && -d "$HOME" ]] || refuse "refusing unsafe HOME: $HOME"
canonical_home="$(canonical_directory "$HOME")" || refuse "cannot resolve HOME: $HOME"

if [[ -L "$install_root" ]]; then
  refuse "refusing unsafe symlinked runtime root: $install_root"
fi

require_safe_existing_directory "$local_dir" "$canonical_home/.local" 'runtime ancestor'
require_safe_existing_directory "$share_dir" "$canonical_home/.local/share" 'runtime ancestor'
require_safe_existing_directory "$runtime_parent" "$canonical_home/.local/share/trellage" 'runtime parent'
require_safe_existing_directory "$install_root" "$canonical_home/.local/share/trellage/cpx" 'runtime root'
require_safe_existing_directory "$command_dir" "$canonical_home/.local/bin" 'command directory'

if [[ -e "$install_root" ]]; then
  [[ -d "$install_root" ]] || refuse "refusing unowned runtime root: $install_root"
  [[ -f "$ownership_marker" && ! -L "$ownership_marker" ]] \
    || refuse "refusing unowned runtime root: $install_root"
  [[ "$(<"$ownership_marker")" == "$ownership_value" ]] \
    || refuse "refusing unowned runtime root: $install_root"
  [[ ! -L "$install_root/bin" && ( ! -e "$install_root/bin" || -d "$install_root/bin" ) ]] \
    || refuse "refusing unsafe managed runtime path: $install_root/bin"
  [[ ! -L "$installed_launcher" && ( ! -e "$installed_launcher" || -f "$installed_launcher" ) ]] \
    || refuse "refusing unsafe managed runtime path: $installed_launcher"
  [[ ! -L "$installed_catalog" && ( ! -e "$installed_catalog" || -f "$installed_catalog" ) ]] \
    || refuse "refusing unsafe managed runtime path: $installed_catalog"
  runtime_owned=true
fi

if [[ -e "$command_path" || -L "$command_path" ]]; then
  if [[ "$runtime_owned" != true || ! -L "$command_path" ]]; then
    refuse "refusing to replace unrelated command: $command_path"
  fi
  if [[ "$(readlink "$command_path")" != "$installed_launcher" ]]; then
    refuse "refusing to replace unrelated command: $command_path"
  fi
fi

mkdir -p "$install_root/bin" "$command_dir"
require_safe_existing_directory "$local_dir" "$canonical_home/.local" 'runtime ancestor'
require_safe_existing_directory "$share_dir" "$canonical_home/.local/share" 'runtime ancestor'
require_safe_existing_directory "$runtime_parent" "$canonical_home/.local/share/trellage" 'runtime parent'
require_safe_existing_directory "$install_root" "$canonical_home/.local/share/trellage/cpx" 'runtime root'
require_safe_existing_directory "$command_dir" "$canonical_home/.local/bin" 'command directory'
printf '%s\n' "$ownership_value" >"$ownership_marker"
install -m 0755 "$source_dir/bin/cpx" "$installed_launcher"
install -m 0644 "$source_dir/catalog.json" "$installed_catalog"

if [[ ! -L "$command_path" ]]; then
  ln -s "$installed_launcher" "$command_path"
fi

printf 'Installed cpx at %s\n' "$command_path"
