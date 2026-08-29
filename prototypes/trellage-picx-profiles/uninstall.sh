#!/usr/bin/env bash

set -euo pipefail

ownership_value='trellage-picx-profiles-v1'

refuse() {
  printf 'picx uninstall: %s\n' "$1" >&2
  exit 1
}

canonical_directory() {
  CDPATH= cd -P -- "$1" >/dev/null 2>&1 && pwd -P
}

home="${HOME-}"
[[ "$home" == /* && "$home" != / && -d "$home" && ! -L "$home" ]] \
  || refuse "unsafe HOME: $home"
canonical_home="$(canonical_directory "$home")" || refuse "cannot resolve HOME: $home"
install_root="$home/.local/share/trellage/picx"
installed_launcher="$install_root/bin/picx"
installed_catalog="$install_root/catalog.json"
installed_version_receipt="$install_root/installed-version"
legacy_version_receipt="$install_root/version"
ownership_marker="$install_root/.managed-by-trellage-picx-profiles"
command_path="$home/.local/bin/picx"

if [[ ! -e "$install_root" && ! -L "$install_root" ]]; then
  [[ ! -e "$command_path" && ! -L "$command_path" ]] \
    || refuse "unowned command remains: $command_path"
  printf 'picx is not installed; profile state was preserved.\n'
  exit 0
fi

[[ -d "$install_root" && ! -L "$install_root" ]] || refuse "unsafe runtime root: $install_root"
[[ "$(canonical_directory "$install_root")" == "$canonical_home/.local/share/trellage/picx" ]] \
  || refuse "redirected runtime root: $install_root"
[[ -f "$ownership_marker" && ! -L "$ownership_marker" ]] \
  || refuse "unowned runtime root: $install_root"
[[ "$(<"$ownership_marker")" == "$ownership_value" ]] \
  || refuse "unowned runtime root: $install_root"
[[ -f "$installed_launcher" && ! -L "$installed_launcher" ]] \
  || refuse "unsafe managed launcher: $installed_launcher"
[[ -f "$installed_catalog" && ! -L "$installed_catalog" ]] \
  || refuse "unsafe managed catalog: $installed_catalog"
for receipt in "$installed_version_receipt" "$legacy_version_receipt"; do
  if [[ -e "$receipt" || -L "$receipt" ]]; then
    [[ -f "$receipt" && ! -L "$receipt" ]] \
      || refuse "unsafe installed version receipt: $receipt"
  fi
done

if [[ -e "$command_path" || -L "$command_path" ]]; then
  [[ -L "$command_path" && "$(readlink "$command_path")" == "$installed_launcher" ]] \
    || refuse "unrelated command: $command_path"
  rm -- "$command_path"
fi

rm -rf -- "$install_root"
printf 'Uninstalled picx; Pi profile state and sessions were preserved.\n'
