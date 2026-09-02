#!/usr/bin/env bash
set -euo pipefail

readonly ownership_value='trellage-agency-profiles-v1'

refuse() {
  printf 'agx install: %s\n' "$1" >&2
  exit 1
}

canonical_directory() {
  CDPATH= cd -P -- "$1" >/dev/null 2>&1 && pwd -P
}

source_dir="$(canonical_directory "$(dirname "$0")")" || refuse 'cannot resolve source directory'
home="${HOME-}"
[[ -n "$home" && "$home" == /* && "$home" != / && -d "$home" && ! -L "$home" ]] \
  || refuse "unsafe HOME: ${home:-<empty>}"
canonical_home="$(canonical_directory "$home")" || refuse "cannot resolve HOME: $home"

local_dir="$canonical_home/.local"
share_dir="$local_dir/share"
runtime_parent="$share_dir/trellage"
install_root="$runtime_parent/agx"
runtime_bin="$install_root/bin"
installed_launcher="$runtime_bin/agx"
installed_catalog="$install_root/catalog.json"
ownership_marker="$install_root/.managed-by-trellage-agency-profiles"
command_dir="$local_dir/bin"
command_path="$command_dir/agx"

require_safe_directory() {
  local path="$1" expected="$2" description="$3" resolved
  if [[ -e "$path" || -L "$path" ]]; then
    [[ -d "$path" && ! -L "$path" ]] || refuse "unsafe $description: $path"
    resolved="$(canonical_directory "$path")" || refuse "cannot resolve $description: $path"
    [[ "$resolved" == "$expected" ]] || refuse "redirected $description: $path"
  fi
}

require_safe_directory "$local_dir" "$canonical_home/.local" 'local directory'
require_safe_directory "$share_dir" "$canonical_home/.local/share" 'share directory'
require_safe_directory "$runtime_parent" "$canonical_home/.local/share/trellage" 'runtime parent'
require_safe_directory "$install_root" "$canonical_home/.local/share/trellage/agx" 'runtime root'
require_safe_directory "$command_dir" "$canonical_home/.local/bin" 'command directory'

runtime_owned=false
if [[ -e "$install_root" ]]; then
  [[ -f "$ownership_marker" && ! -L "$ownership_marker" && -r "$ownership_marker" ]] \
    || refuse "refusing unowned runtime root: $install_root"
  [[ "$(<"$ownership_marker")" == "$ownership_value" ]] \
    || refuse "refusing unowned runtime root: $install_root"
  runtime_owned=true
fi
if [[ -e "$command_path" || -L "$command_path" ]]; then
  [[ "$runtime_owned" == true && -L "$command_path" ]] \
    || refuse "refusing to replace unrelated command: $command_path"
  [[ "$(readlink "$command_path")" == "$installed_launcher" ]] \
    || refuse "refusing to replace unrelated command: $command_path"
fi

mkdir -p "$runtime_bin" "$command_dir"
for path in "$runtime_bin" "$install_root"; do
  [[ -d "$path" && ! -L "$path" ]] || refuse "unsafe managed directory: $path"
done
for path in "$installed_launcher" "$installed_catalog" "$ownership_marker"; do
  [[ ! -L "$path" ]] || refuse "unsafe managed path: $path"
done

launcher_stage="$(mktemp "$runtime_bin/.agx.XXXXXX")" || refuse 'cannot stage launcher'
catalog_stage="$(mktemp "$install_root/.catalog.XXXXXX")" || {
  rm -f -- "$launcher_stage"
  refuse 'cannot stage catalog'
}
marker_stage="$(mktemp "$install_root/.ownership.XXXXXX")" || {
  rm -f -- "$launcher_stage" "$catalog_stage"
  refuse 'cannot stage ownership marker'
}
trap 'rm -f -- "$launcher_stage" "$catalog_stage" "$marker_stage"' EXIT
install -m 0755 "$source_dir/bin/agx" "$launcher_stage"
install -m 0644 "$source_dir/catalog.json" "$catalog_stage"
printf '%s\n' "$ownership_value" >"$marker_stage"
chmod 0644 "$marker_stage"
mv -f "$launcher_stage" "$installed_launcher"
mv -f "$catalog_stage" "$installed_catalog"
mv -f "$marker_stage" "$ownership_marker"
trap - EXIT

if [[ ! -L "$command_path" ]]; then
  command_stage="$(mktemp -d "$command_dir/.agx-command.XXXXXX")" \
    || refuse 'cannot stage command'
  trap 'rm -f -- "$command_stage/agx"; rmdir "$command_stage" 2>/dev/null || true' EXIT
  ln -s "$installed_launcher" "$command_stage/agx"
  mv "$command_stage/agx" "$command_path"
  rmdir "$command_stage"
  trap - EXIT
fi

"$source_dir/../../scripts/install-floating-skills-runtime.sh"
printf 'Installed agx at %s\n' "$command_path"
