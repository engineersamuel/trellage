#!/usr/bin/env bash

set -euo pipefail

readonly ownership_value='trellage-claude-profiles-v1'

refuse() {
  printf 'cldx install: %s\n' "$1" >&2
  exit 1
}

canonical_directory() {
  CDPATH= cd -P -- "$1" >/dev/null 2>&1 && pwd -P
}

source_dir="$(CDPATH= cd -P -- "$(dirname "$0")" && pwd)"
home="${HOME-}"
[[ "$home" == /* && "$home" != / && -d "$home" && ! -L "$home" ]] \
  || refuse "unsafe HOME: $home"
canonical_home="$(canonical_directory "$home")" || refuse "cannot resolve HOME: $home"

local_dir="$home/.local"
share_dir="$local_dir/share"
runtime_parent="$share_dir/trellage"
install_root="$runtime_parent/cldx"
installed_launcher="$install_root/bin/cldx"
installed_catalog="$install_root/catalog.json"
installed_assets="$install_root/assets/rundown"
ownership_marker="$install_root/.managed-by-trellage-claude-profiles"
command_dir="$local_dir/bin"
command_path="$command_dir/cldx"

require_safe_directory() {
  local path="$1" expected="$2" description="$3" canonical_path

  if [[ -e "$path" || -L "$path" ]]; then
    [[ -d "$path" && ! -L "$path" ]] || refuse "unsafe $description: $path"
    canonical_path="$(canonical_directory "$path")" || refuse "cannot resolve $description: $path"
    [[ "$canonical_path" == "$expected" ]] || refuse "redirected $description: $path"
  fi
}

require_safe_directory "$local_dir" "$canonical_home/.local" 'runtime ancestor'
require_safe_directory "$share_dir" "$canonical_home/.local/share" 'runtime ancestor'
require_safe_directory "$runtime_parent" "$canonical_home/.local/share/trellage" 'runtime parent'
require_safe_directory "$command_dir" "$canonical_home/.local/bin" 'command directory'

runtime_owned=false
if [[ -e "$install_root" || -L "$install_root" ]]; then
  require_safe_directory "$install_root" "$canonical_home/.local/share/trellage/cldx" 'runtime root'
  [[ -f "$ownership_marker" && ! -L "$ownership_marker" ]] \
    || refuse "unowned runtime root: $install_root"
  [[ "$(<"$ownership_marker")" == "$ownership_value" ]] \
    || refuse "unowned runtime root: $install_root"
  runtime_owned=true
fi

if [[ -e "$command_path" || -L "$command_path" ]]; then
  [[ "$runtime_owned" == true && -L "$command_path" ]] \
    || refuse "unrelated command: $command_path"
  [[ "$(readlink "$command_path")" == "$installed_launcher" ]] \
    || refuse "unrelated command: $command_path"
fi

mkdir -p "$install_root/bin" "$installed_assets" "$command_dir"
require_safe_directory "$install_root" "$canonical_home/.local/share/trellage/cldx" 'runtime root'
require_safe_directory "$install_root/bin" "$canonical_home/.local/share/trellage/cldx/bin" 'runtime bin'
require_safe_directory "$install_root/assets" \
  "$canonical_home/.local/share/trellage/cldx/assets" 'runtime assets'
require_safe_directory "$installed_assets" \
  "$canonical_home/.local/share/trellage/cldx/assets/rundown" 'runtime assets'
for asset in rundown.md NOTICE.md; do
  [[ ! -L "$installed_assets/$asset" \
    && ( ! -e "$installed_assets/$asset" || -f "$installed_assets/$asset" ) ]] \
    || refuse "unsafe managed asset: $installed_assets/$asset"
done
[[ ! -L "$installed_launcher" && ( ! -e "$installed_launcher" || -f "$installed_launcher" ) ]] \
  || refuse "unsafe managed launcher: $installed_launcher"
[[ ! -L "$installed_catalog" && ( ! -e "$installed_catalog" || -f "$installed_catalog" ) ]] \
  || refuse "unsafe managed catalog: $installed_catalog"

launcher_stage="$(mktemp "$install_root/bin/.cldx.XXXXXX")"
catalog_stage="$(mktemp "$install_root/.catalog.XXXXXX")"
marker_stage="$(mktemp "$install_root/.ownership.XXXXXX")"
install -m 0755 "$source_dir/bin/cldx" "$launcher_stage"
install -m 0644 "$source_dir/catalog.json" "$catalog_stage"
printf '%s\n' "$ownership_value" >"$marker_stage"
chmod 0600 "$marker_stage"
mv -f "$launcher_stage" "$installed_launcher"
mv -f "$catalog_stage" "$installed_catalog"
mv -f "$marker_stage" "$ownership_marker"

for asset in rundown.md NOTICE.md; do
  asset_stage="$(mktemp "$installed_assets/.$asset.XXXXXX")"
  install -m 0644 "$source_dir/assets/rundown/$asset" "$asset_stage"
  mv -f "$asset_stage" "$installed_assets/$asset"
done

if [[ ! -L "$command_path" ]]; then
  command_stage="$command_dir/.cldx-command.$$"
  [[ ! -e "$command_stage" && ! -L "$command_stage" ]] \
    || refuse "unsafe command staging path: $command_stage"
  ln -s "$installed_launcher" "$command_stage"
  mv "$command_stage" "$command_path"
fi

printf 'Installed cldx at %s\n' "$command_path"
"$source_dir/../../scripts/install-floating-skills-runtime.sh"
