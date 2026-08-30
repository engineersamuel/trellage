#!/usr/bin/env bash
set -euo pipefail

source_dir="$(cd "$(dirname "$0")" && pwd)"

local_dir="$HOME/.local"
share_dir="$local_dir/share"
runtime_parent="$share_dir/trellage"
install_root="$runtime_parent/cpx"
installed_launcher="$install_root/bin/cpx"
installed_catalog="$install_root/catalog.json"
installed_assets="$install_root/assets/rundown"
installed_session_bridge="$install_root/lib/trellage-session-bridge.py"
session_bridge_source="$source_dir/../../scripts/trellage-session-bridge.py"
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
  [[ ! -L "$install_root/assets" && ( ! -e "$install_root/assets" || -d "$install_root/assets" ) ]] \
    || refuse "refusing unsafe managed runtime path: $install_root/assets"
  [[ ! -L "$install_root/lib" && ( ! -e "$install_root/lib" || -d "$install_root/lib" ) ]] \
    || refuse "refusing unsafe managed runtime path: $install_root/lib"
  [[ ! -L "$installed_session_bridge" \
    && ( ! -e "$installed_session_bridge" || -f "$installed_session_bridge" ) ]] \
    || refuse "refusing unsafe managed runtime path: $installed_session_bridge"
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

[[ -f "$session_bridge_source" && ! -L "$session_bridge_source" ]] \
  || refuse "missing session bridge: $session_bridge_source"
mkdir -p "$install_root/bin" "$install_root/lib" "$installed_assets" "$command_dir"
require_safe_existing_directory "$local_dir" "$canonical_home/.local" 'runtime ancestor'
require_safe_existing_directory "$share_dir" "$canonical_home/.local/share" 'runtime ancestor'
require_safe_existing_directory "$runtime_parent" "$canonical_home/.local/share/trellage" 'runtime parent'
require_safe_existing_directory "$install_root" "$canonical_home/.local/share/trellage/cpx" 'runtime root'
require_safe_existing_directory "$command_dir" "$canonical_home/.local/bin" 'command directory'
require_safe_existing_directory "$install_root/assets" \
  "$canonical_home/.local/share/trellage/cpx/assets" 'runtime assets'
require_safe_existing_directory "$install_root/lib" \
  "$canonical_home/.local/share/trellage/cpx/lib" 'runtime lib'
require_safe_existing_directory "$installed_assets" \
  "$canonical_home/.local/share/trellage/cpx/assets/rundown" 'runtime assets'
for asset in rundown.instructions.md NOTICE.md; do
  [[ ! -L "$installed_assets/$asset" \
    && ( ! -e "$installed_assets/$asset" || -f "$installed_assets/$asset" ) ]] \
    || refuse "refusing unsafe managed runtime path: $installed_assets/$asset"
done
printf '%s\n' "$ownership_value" >"$ownership_marker"
install -m 0755 "$source_dir/bin/cpx" "$installed_launcher"
install -m 0755 "$session_bridge_source" "$installed_session_bridge"
install -m 0644 "$source_dir/catalog.json" "$installed_catalog"
for asset in rundown.instructions.md NOTICE.md; do
  install -m 0644 "$source_dir/assets/rundown/$asset" "$installed_assets/$asset"
done

if [[ ! -L "$command_path" ]]; then
  ln -s "$installed_launcher" "$command_path"
fi

printf 'Installed cpx at %s\n' "$command_path"
"$source_dir/../../scripts/install-floating-skills-runtime.sh"
