#!/usr/bin/env bash
set -euo pipefail

local_dir="$HOME/.local"
share_dir="$local_dir/share"
runtime_parent="$share_dir/trellage"
install_root="$runtime_parent/trx"
command_dir="$local_dir/bin"
command_path="$command_dir/trx"
installed_launcher="$install_root/bin/trx"
ownership_marker="$install_root/.managed-by-trellage-router"
ownership_value='trellage-router-v1'

refuse() {
  printf 'trx uninstall: %s\n' "$1" >&2
  exit 1
}

canonical_directory() {
  (CDPATH= cd -P -- "$1" >/dev/null 2>&1 && pwd -P)
}

require_safe_directory() {
  local path="$1"
  local expected="$2"
  local description="$3"
  local resolved

  if [[ -e "$path" || -L "$path" ]]; then
    [[ -d "$path" && ! -L "$path" ]] || refuse "refusing unsafe $description: $path"
    resolved="$(canonical_directory "$path")" || refuse "cannot resolve $description: $path"
    [[ "$resolved" == "$expected" ]] || refuse "refusing redirected $description: $path"
  fi
}

require_owned_runtime_contents() {
  local path

  while IFS= read -r path; do
    case "$path" in
      "$ownership_marker"|"$install_root/bin"|"$installed_launcher"|\
      "$install_root/lib"|"$install_root/lib/terminal-picker.mjs") ;;
      *) refuse "refusing unrelated runtime path: $path" ;;
    esac
  done < <(find "$install_root" -mindepth 1 -maxdepth 2 -print)
}

case "$HOME" in
  /*) ;;
  *) refuse "HOME must be an absolute path: $HOME" ;;
esac
[[ -d "$HOME" && ! -L "$HOME" ]] || refuse "refusing unsafe HOME: $HOME"
canonical_home="$(canonical_directory "$HOME")" || refuse "cannot resolve HOME: $HOME"
[[ "$canonical_home" != / ]] || refuse 'HOME must not be /'

require_safe_directory "$local_dir" "$canonical_home/.local" 'runtime ancestor'
require_safe_directory "$share_dir" "$canonical_home/.local/share" 'runtime ancestor'
require_safe_directory "$runtime_parent" "$canonical_home/.local/share/trellage" 'runtime parent'
require_safe_directory "$install_root" "$canonical_home/.local/share/trellage/trx" 'runtime root'
require_safe_directory "$command_dir" "$canonical_home/.local/bin" 'command directory'

if [[ ! -e "$install_root" ]]; then
  [[ ! -e "$command_path" && ! -L "$command_path" ]] \
    || refuse "refusing unrelated command: $command_path"
  printf 'trx is not installed.\n'
  exit 0
fi

[[ -f "$ownership_marker" && ! -L "$ownership_marker" ]] \
  || refuse "refusing unowned runtime root: $install_root"
[[ "$(<"$ownership_marker")" == "$ownership_value" ]] \
  || refuse "refusing unowned runtime root: $install_root"
[[ -d "$install_root/bin" && ! -L "$install_root/bin" ]] \
  || refuse "refusing unsafe managed runtime: $install_root/bin"
[[ -d "$install_root/lib" && ! -L "$install_root/lib" ]] \
  || refuse "refusing unsafe managed runtime: $install_root/lib"
[[ -f "$installed_launcher" && ! -L "$installed_launcher" ]] \
  || refuse "refusing unsafe managed launcher: $installed_launcher"
[[ -f "$install_root/lib/terminal-picker.mjs" && ! -L "$install_root/lib/terminal-picker.mjs" ]] \
  || refuse "refusing unsafe managed picker"
require_owned_runtime_contents

if [[ -e "$command_path" || -L "$command_path" ]]; then
  [[ -L "$command_path" && "$(readlink "$command_path")" == "$installed_launcher" ]] \
    || refuse "refusing to remove unrelated command: $command_path"
  rm "$command_path"
fi

rm "$installed_launcher" "$install_root/lib/terminal-picker.mjs" "$ownership_marker"
rmdir "$install_root/bin" "$install_root/lib" "$install_root"
printf 'Uninstalled trx.\n'
