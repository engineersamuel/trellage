#!/usr/bin/env bash

set -euo pipefail

readonly ownership_value='trellage-prime-profiles-v1'
readonly managed_extension_name='ask-user'

refuse() {
  printf 'prx install: %s\n' "$1" >&2
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
install_root="$runtime_parent/prx"
installed_launcher="$install_root/bin/prx"
installed_catalog="$install_root/catalog.json"
installed_version_receipt="$install_root/installed-version"
installed_extensions_dir="$install_root/assets/extensions"
installed_extension="$installed_extensions_dir/${managed_extension_name}.ts"
source_extension="$source_dir/assets/extensions/${managed_extension_name}.ts"
ownership_marker="$install_root/.managed-by-trellage-prime-profiles"

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
  require_safe_directory "$install_root" "$canonical_home/.local/share/trellage/prx" 'runtime root'
  [[ -f "$ownership_marker" && ! -L "$ownership_marker" ]] \
    || refuse "unowned runtime root: $install_root"
  [[ "$(<"$ownership_marker")" == "$ownership_value" ]] \
    || refuse "unowned runtime root: $install_root"
fi


require_safe_directory "$install_root" "$canonical_home/.local/share/trellage/prx" 'runtime root'
require_safe_directory "$install_root/bin" "$canonical_home/.local/share/trellage/prx/bin" 'runtime bin'
require_safe_directory "$install_root/assets" "$canonical_home/.local/share/trellage/prx/assets" 'runtime assets'
require_safe_directory "$installed_extensions_dir" \
  "$canonical_home/.local/share/trellage/prx/assets/extensions" 'runtime extensions'
[[ ! -L "$installed_launcher" && ( ! -e "$installed_launcher" || -f "$installed_launcher" ) ]] \
  || refuse "unsafe managed launcher: $installed_launcher"
[[ ! -L "$installed_catalog" && ( ! -e "$installed_catalog" || -f "$installed_catalog" ) ]] \
  || refuse "unsafe managed catalog: $installed_catalog"
if [[ -e "$installed_version_receipt" || -L "$installed_version_receipt" ]]; then
  [[ -f "$installed_version_receipt" && ! -L "$installed_version_receipt" ]] \
    || refuse "unsafe installed version receipt: $installed_version_receipt"
fi
[[ -f "$source_extension" && ! -L "$source_extension" ]] \
  || refuse "missing managed extension asset: $source_extension"
[[ ! -L "$installed_extension" && ( ! -e "$installed_extension" || -f "$installed_extension" ) ]] \
  || refuse "unsafe managed extension: $installed_extension"

"$source_dir/../../scripts/install-floating-skills-runtime.sh"
mkdir -p "$install_root/bin" "$installed_extensions_dir"
require_safe_directory "$install_root" "$canonical_home/.local/share/trellage/prx" 'runtime root'
require_safe_directory "$install_root/bin" "$canonical_home/.local/share/trellage/prx/bin" 'runtime bin'
require_safe_directory "$installed_extensions_dir" \
  "$canonical_home/.local/share/trellage/prx/assets/extensions" 'runtime extensions'
launcher_stage="$(mktemp "$install_root/bin/.prx.XXXXXX")"
catalog_stage="$(mktemp "$install_root/.catalog.XXXXXX")"
extension_stage="$(mktemp "$installed_extensions_dir/.ask-user.XXXXXX")"
marker_stage="$(mktemp "$install_root/.ownership.XXXXXX")"
install -m 0755 "$source_dir/bin/prx" "$launcher_stage"
install -m 0644 "$source_dir/catalog.json" "$catalog_stage"
install -m 0644 "$source_extension" "$extension_stage"
printf '%s\n' "$ownership_value" >"$marker_stage"
chmod 0600 "$marker_stage"
mv -f "$launcher_stage" "$installed_launcher"
mv -f "$catalog_stage" "$installed_catalog"
mv -f "$extension_stage" "$installed_extension"
mv -f "$marker_stage" "$ownership_marker"


BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun --no-install --no-env-file "--config=$source_dir/../../packages/trellage-runtime/bunfig.toml" \
  "$source_dir/../trellage-claude-common/native-skills.ts" --install "$install_root"
printf 'Installed prx at %s\n' "$installed_launcher"
