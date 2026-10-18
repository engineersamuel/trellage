#!/usr/bin/env bash

set -euo pipefail

ownership_value='trellage-omp-profiles-v2'

refuse() {
  printf 'omp install: %s\n' "$1" >&2
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
install_root="$runtime_parent/omp"
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

require_safe_directory "$local_dir" "$canonical_home/.local" 'runtime ancestor'
require_safe_directory "$share_dir" "$canonical_home/.local/share" 'runtime ancestor'
require_safe_directory "$runtime_parent" "$canonical_home/.local/share/trellage" 'runtime parent'

runtime_owned=false
if [[ -e "$install_root" || -L "$install_root" ]]; then
  require_safe_directory "$install_root" "$canonical_home/.local/share/trellage/omp" 'runtime root'
  [[ -f "$ownership_marker" && ! -L "$ownership_marker" ]] \
    || refuse "unowned runtime root: $install_root"
  [[ "$(<"$ownership_marker")" == "$ownership_value" ]] \
    || refuse "unowned runtime root: $install_root"
  runtime_owned=true
fi

require_safe_directory "$install_root" "$canonical_home/.local/share/trellage/omp" 'runtime root'
require_safe_directory "$install_root/bin" "$canonical_home/.local/share/trellage/omp/bin" 'runtime bin'
[[ ! -L "$installed_launcher" && ( ! -e "$installed_launcher" || -f "$installed_launcher" ) ]] \
  || refuse "unsafe managed launcher: $installed_launcher"
[[ ! -L "$installed_catalog" && ( ! -e "$installed_catalog" || -f "$installed_catalog" ) ]] \
  || refuse "unsafe managed catalog: $installed_catalog"
is_retired_mise_cache() (
  local cache="$install_root/cache" directory entry name
  [[ -d "$cache" && ! -L "$cache" ]] || return 1
  [[ "$(canonical_directory "$cache")" == "$canonical_home/.local/share/trellage/omp/cache" ]] || return 1
  shopt -s nullglob dotglob
  for directory in "$cache"/*; do
    [[ -d "$directory" && ! -L "$directory" ]] || return 1
    name="${directory##*/}"
    case "$name" in
      github|github-can1357-oh-my-pi|lockfiles|.auto_prune) ;;
      *) return 1 ;;
    esac
    for entry in "$directory"/*; do
      [[ -f "$entry" && ! -L "$entry" ]] || return 1
      case "$name:${entry##*/}" in
        github:https-api-github-com-can1357-oh-my-pi-*.msgpack.z) ;;
        github-can1357-oh-my-pi:remote_versions-*.msgpack.z) ;;
        lockfiles:*) [[ "${entry##*/}" =~ ^[[:xdigit:]]+$ ]] || return 1 ;;
        *) return 1 ;;
      esac
    done
  done
)

"$source_dir/../../scripts/install-floating-skills-runtime.sh"
mkdir -p "$install_root/bin"
require_safe_directory "$install_root" "$canonical_home/.local/share/trellage/omp" 'runtime root'
require_safe_directory "$install_root/bin" "$canonical_home/.local/share/trellage/omp/bin" 'runtime bin'
launcher_stage="$(mktemp "$install_root/bin/.omp.XXXXXX")"
catalog_stage="$(mktemp "$install_root/.catalog.XXXXXX")"
marker_stage="$(mktemp "$install_root/.ownership.XXXXXX")"
install -m 0755 "$source_dir/bin/omp" "$launcher_stage"
install -m 0644 "$source_dir/catalog.json" "$catalog_stage"
printf '%s\n' "$ownership_value" >"$marker_stage"
chmod 0600 "$marker_stage"
mv -f "$launcher_stage" "$installed_launcher"
mv -f "$catalog_stage" "$installed_catalog"
mv -f "$marker_stage" "$ownership_marker"


BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun --no-install --no-env-file "--config=$source_dir/../../packages/trellage-runtime/bunfig.toml" \
  "$source_dir/../trellage-claude-common/native-skills.ts" --install "$install_root"
if [[ "$runtime_owned" == true ]]; then
  rm -rf -- "$install_root/installed-version" "$install_root/version" \
    "$install_root/mise" "$install_root/mise-config"
  if is_retired_mise_cache; then
    rm -rf -- "$install_root/cache"
  fi
fi
printf 'Installed omp at %s\n' "$installed_launcher"
