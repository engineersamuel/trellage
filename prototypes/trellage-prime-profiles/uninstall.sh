#!/usr/bin/env bash

set -euo pipefail

readonly ownership_value='trellage-prime-profiles-v1'

refuse() {
  printf 'prx uninstall: %s\n' "$1" >&2
  exit 1
}

canonical_directory() {
  CDPATH= cd -P -- "$1" >/dev/null 2>&1 && pwd -P
}

home="${HOME-}"
[[ "$home" == /* && "$home" != / && -d "$home" && ! -L "$home" ]] \
  || refuse "unsafe HOME: $home"
canonical_home="$(canonical_directory "$home")" || refuse "cannot resolve HOME: $home"
install_root="$home/.local/share/trellage/prx"
installed_launcher="$install_root/bin/prx"
installed_catalog="$install_root/catalog.json"
ownership_marker="$install_root/.managed-by-trellage-prime-profiles"
command_path="$home/.local/bin/prx"

if [[ ! -e "$install_root" && ! -L "$install_root" ]]; then
  [[ ! -e "$command_path" && ! -L "$command_path" ]] \
    || refuse "unowned command remains: $command_path"
  printf 'prx is not installed; profile state was preserved.\n'
  exit 0
fi

[[ -d "$install_root" && ! -L "$install_root" ]] \
  || refuse "unsafe runtime root: $install_root"
[[ "$(canonical_directory "$install_root")" == "$canonical_home/.local/share/trellage/prx" ]] \
  || refuse "redirected runtime root: $install_root"
[[ -f "$ownership_marker" && ! -L "$ownership_marker" ]] \
  || refuse "unowned runtime root: $install_root"
[[ "$(<"$ownership_marker")" == "$ownership_value" ]] \
  || refuse "unowned runtime root: $install_root"
[[ -f "$installed_launcher" && ! -L "$installed_launcher" ]] \
  || refuse "unsafe managed launcher: $installed_launcher"
[[ -f "$installed_catalog" && ! -L "$installed_catalog" ]] \
  || refuse "unsafe managed catalog: $installed_catalog"

if [[ -e "$command_path" || -L "$command_path" ]]; then
  [[ -L "$command_path" && "$(readlink "$command_path")" == "$installed_launcher" ]] \
    || refuse "unrelated command: $command_path"
  rm -- "$command_path"
fi

# Also clear a leftover pre-rename `pax` install if still present.
legacy_root="$home/.local/share/trellage/pax"
legacy_launcher="$legacy_root/bin/pax"
legacy_marker="$legacy_root/.managed-by-trellage-prime-profiles"
legacy_command="$home/.local/bin/pax"
if [[ -d "$legacy_root" && ! -L "$legacy_root" ]] \
  && [[ -f "$legacy_marker" && ! -L "$legacy_marker" ]] \
  && [[ "$(<"$legacy_marker")" == "$ownership_value" ]] \
  && [[ "$(canonical_directory "$legacy_root")" == "$canonical_home/.local/share/trellage/pax" ]]; then
  if [[ -e "$legacy_command" || -L "$legacy_command" ]]; then
    [[ -L "$legacy_command" && "$(readlink "$legacy_command")" == "$legacy_launcher" ]] \
      || refuse "unrelated legacy command: $legacy_command"
    rm -- "$legacy_command"
  fi
  rm -rf -- "$legacy_root"
fi

rm -rf -- "$install_root"
printf 'Uninstalled prx; Prime profile state and sessions were preserved.\n'
