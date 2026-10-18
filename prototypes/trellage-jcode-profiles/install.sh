#!/usr/bin/env bash

set -euo pipefail

readonly ownership_value='trellage-jcode-profiles-v1'

refuse() {
  printf 'jcx install: %s\n' "$1" >&2
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
install_root="$runtime_parent/jcx"
installed_launcher="$install_root/bin/jcx"
installed_catalog="$install_root/catalog.json"
installed_config_manager="$install_root/config-manager.ts"
installed_version_receipt="$install_root/installed-version"
ownership_marker="$install_root/.managed-by-trellage-jcode-profiles"

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

if [[ -e "$install_root" || -L "$install_root" ]]; then
  require_safe_directory "$install_root" "$canonical_home/.local/share/trellage/jcx" 'runtime root'
  [[ -f "$ownership_marker" && ! -L "$ownership_marker" ]] \
    || refuse "unowned runtime root: $install_root"
  [[ "$(<"$ownership_marker")" == "$ownership_value" ]] \
    || refuse "unowned runtime root: $install_root"
fi


mkdir -p "$install_root/bin"
require_safe_directory "$install_root" "$canonical_home/.local/share/trellage/jcx" 'runtime root'
require_safe_directory "$install_root/bin" "$canonical_home/.local/share/trellage/jcx/bin" 'runtime bin'
[[ ! -L "$installed_launcher" && ( ! -e "$installed_launcher" || -f "$installed_launcher" ) ]] \
  || refuse "unsafe managed launcher: $installed_launcher"
[[ ! -L "$installed_catalog" && ( ! -e "$installed_catalog" || -f "$installed_catalog" ) ]] \
  || refuse "unsafe managed catalog: $installed_catalog"
[[ -f "$source_dir/config-manager.ts" && ! -L "$source_dir/config-manager.ts" ]] \
  || refuse "invalid config manager: $source_dir/config-manager.ts"
[[ ! -L "$installed_config_manager" \
  && ( ! -e "$installed_config_manager" || -f "$installed_config_manager" ) ]] \
  || refuse "unsafe managed config manager: $installed_config_manager"
if [[ -e "$installed_version_receipt" || -L "$installed_version_receipt" ]]; then
  [[ -f "$installed_version_receipt" && ! -L "$installed_version_receipt" ]] \
    || refuse "unsafe installed version receipt: $installed_version_receipt"
fi

launcher_stage="$(mktemp "$install_root/bin/.jcx.XXXXXX")"
catalog_stage="$(mktemp "$install_root/.catalog.XXXXXX")"
config_manager_stage="$(mktemp "$install_root/.config-manager.XXXXXX")"
marker_stage="$(mktemp "$install_root/.ownership.XXXXXX")"
install -m 0755 "$source_dir/bin/jcx" "$launcher_stage"
install -m 0644 "$source_dir/catalog.json" "$catalog_stage"
install -m 0644 "$source_dir/config-manager.ts" "$config_manager_stage"
printf '%s\n' "$ownership_value" >"$marker_stage"
chmod 0600 "$marker_stage"
mv -f "$launcher_stage" "$installed_launcher"
mv -f "$catalog_stage" "$installed_catalog"
mv -f "$config_manager_stage" "$installed_config_manager"
mv -f "$marker_stage" "$ownership_marker"


BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun --no-install --no-env-file "--config=$source_dir/../../packages/trellage-runtime/bunfig.toml" \
  "$source_dir/../trellage-claude-common/native-skills.ts" --install-manual "$install_root"
printf 'Installed jcx at %s\n' "$installed_launcher"
"$source_dir/../../scripts/install-floating-skills-runtime.sh"
