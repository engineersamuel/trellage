#!/usr/bin/env bash

set -euo pipefail

readonly ownership_value='trellage-prime-profiles-v1'
readonly managed_extension_name='ask-user'
readonly managed_extension_sha256='c02e1ed58195ee6e4793c6e51ed8c9592141ab7cfd654347b1025dd6c9c6dbe2'

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
installed_extensions_dir="$install_root/assets/extensions"
installed_extension="$installed_extensions_dir/${managed_extension_name}.ts"
source_extension="$source_dir/assets/extensions/${managed_extension_name}.ts"
ownership_marker="$install_root/.managed-by-trellage-prime-profiles"
command_dir="$local_dir/bin"
command_path="$command_dir/prx"

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

# One-time rename from the short-lived `pax` launcher (collided with macOS
# /bin/pax). Preserve npm/mise/kernel caches under the new runtime root.
legacy_root="$runtime_parent/pax"
legacy_launcher="$legacy_root/bin/pax"
legacy_marker="$legacy_root/.managed-by-trellage-prime-profiles"
legacy_command="$command_dir/pax"
if [[ ! -e "$install_root" && ! -L "$install_root" ]] \
  && [[ -d "$legacy_root" && ! -L "$legacy_root" ]] \
  && [[ -f "$legacy_marker" && ! -L "$legacy_marker" ]] \
  && [[ "$(<"$legacy_marker")" == "$ownership_value" ]]; then
  require_safe_directory "$legacy_root" "$canonical_home/.local/share/trellage/pax" 'legacy runtime root'
  if [[ -e "$legacy_command" || -L "$legacy_command" ]]; then
    [[ -L "$legacy_command" && "$(readlink "$legacy_command")" == "$legacy_launcher" ]] \
      || refuse "unrelated legacy command: $legacy_command"
    rm -- "$legacy_command"
  fi
  if [[ -f "$legacy_launcher" && ! -L "$legacy_launcher" ]]; then
    rm -f -- "$legacy_launcher"
  fi
  mv -- "$legacy_root" "$install_root"
fi

runtime_owned=false
if [[ -e "$install_root" || -L "$install_root" ]]; then
  require_safe_directory "$install_root" "$canonical_home/.local/share/trellage/prx" 'runtime root'
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

# Drop a stale `pax` command symlink left after a partial rename.
if [[ -L "$legacy_command" ]]; then
  legacy_target="$(readlink "$legacy_command")"
  case "$legacy_target" in
    "$legacy_launcher"|"$installed_launcher"|"$install_root/bin/pax")
      rm -- "$legacy_command"
      ;;
  esac
fi

memory_installer="$source_dir/../trellage-memory/install-deja.sh"
if [[ "${TRELLAGE_MEMORY:-deja}" != off ]]; then
  [[ -f "$memory_installer" && ! -L "$memory_installer" && -x "$memory_installer" ]] \
    || refuse "missing common Deja installer: $memory_installer"
  HOME="$canonical_home" "$memory_installer" >/dev/null \
    || refuse 'could not install the common Deja runtime'
fi

mkdir -p "$install_root/bin" "$installed_extensions_dir" "$command_dir"
require_safe_directory "$install_root" "$canonical_home/.local/share/trellage/prx" 'runtime root'
require_safe_directory "$install_root/bin" "$canonical_home/.local/share/trellage/prx/bin" 'runtime bin'
require_safe_directory "$install_root/assets" "$canonical_home/.local/share/trellage/prx/assets" 'runtime assets'
require_safe_directory "$installed_extensions_dir" \
  "$canonical_home/.local/share/trellage/prx/assets/extensions" 'runtime extensions'
[[ ! -L "$installed_launcher" && ( ! -e "$installed_launcher" || -f "$installed_launcher" ) ]] \
  || refuse "unsafe managed launcher: $installed_launcher"
[[ ! -L "$installed_catalog" && ( ! -e "$installed_catalog" || -f "$installed_catalog" ) ]] \
  || refuse "unsafe managed catalog: $installed_catalog"
[[ -f "$source_extension" && ! -L "$source_extension" ]] \
  || refuse "missing managed extension asset: $source_extension"
[[ ! -L "$installed_extension" && ( ! -e "$installed_extension" || -f "$installed_extension" ) ]] \
  || refuse "unsafe managed extension: $installed_extension"
source_extension_sha256="$(
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 -- "$source_extension" | awk '{ print $1 }'
  else
    sha256sum -- "$source_extension" | awk '{ print $1 }'
  fi
)" || refuse "cannot hash managed extension asset: $source_extension"
[[ "$source_extension_sha256" == "$managed_extension_sha256" ]] \
  || refuse "managed extension asset integrity differs: $source_extension"

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

if [[ ! -L "$command_path" ]]; then
  command_stage="$command_dir/.prx-command.$$"
  [[ ! -e "$command_stage" && ! -L "$command_stage" ]] \
    || refuse "unsafe command staging path: $command_stage"
  ln -s "$installed_launcher" "$command_stage"
  mv "$command_stage" "$command_path"
fi

printf 'Installed prx at %s\n' "$command_path"
