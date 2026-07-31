#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf 'trellage installer: %s\n' "$1" >&2
  exit 1
}

source_path="${BASH_SOURCE[0]}"
while [[ -L "$source_path" ]]; do
  source_dir="$(cd -P "$(dirname "$source_path")" && pwd)"
  link_target="$(readlink -- "$source_path")"
  if [[ "$link_target" == /* ]]; then
    source_path="$link_target"
  else
    source_path="$source_dir/$link_target"
  fi
done
prototype_dir="$(cd -P "$(dirname "$source_path")" && pwd)"
command_path="$prototype_dir/trellage"
[[ -f "$command_path" && -x "$command_path" ]] \
  || fail "prototype command is missing or not executable: $command_path"

install_dir="${TRELLAGE_INSTALL_DIR:-${XDG_BIN_HOME:-${HOME:+$HOME/.local/bin}}}"
[[ -n "$install_dir" ]] \
  || fail 'HOME is unset; set TRELLAGE_INSTALL_DIR explicitly'
if [[ "$install_dir" == -* ]]; then
  install_dir="./$install_dir"
fi

destination="$install_dir/trellage"
action="${1:-}"
dry_run=0
usage='usage: install-trellage.sh install|uninstall|uninstall --dry-run'

case "$#" in
  1)
    [[ "$action" == install || "$action" == uninstall ]] || fail "$usage"
    ;;
  2)
    [[ "$action" == uninstall && "$2" == --dry-run ]] || fail "$usage"
    dry_run=1
    ;;
  *) fail "$usage" ;;
esac

is_owned_link_at() {
  local candidate="$1"
  [[ -L "$candidate" ]] || return 1
  [[ "$(readlink -- "$candidate")" == "$command_path" ]]
}

is_owned_link() {
  is_owned_link_at "$destination"
}

restore_quarantined_path() {
  local quarantine="$1"
  [[ ! -e "$destination" && ! -L "$destination" ]] || return 1
  mv -n -- "$quarantine" "$destination" || return 1
  [[ ! -e "$quarantine" && ! -L "$quarantine" ]]
}

remove_owned_destination() {
  local quarantine_root quarantine
  quarantine_root="$(mktemp -d "$install_dir/.trellage-uninstall.XXXXXX")" \
    || fail "could not create uninstall quarantine in: $install_dir"
  quarantine="$quarantine_root/trellage"

  if ! mv -- "$destination" "$quarantine"; then
    rmdir -- "$quarantine_root" 2>/dev/null || true
    fail "could not quarantine owned path before removal: $destination"
  fi

  if ! is_owned_link_at "$quarantine"; then
    if restore_quarantined_path "$quarantine"; then
      rmdir -- "$quarantine_root" 2>/dev/null || true
      fail "refusing to remove quarantined unrelated path: $quarantine; restored to $destination"
    fi
    fail "refusing to remove quarantined unrelated path: $quarantine; recover it manually"
  fi

  rm -- "$quarantine" \
    || fail "could not remove verified owned symlink; recover it from: $quarantine"
  rmdir -- "$quarantine_root" \
    || fail "removed owned symlink but could not remove quarantine directory: $quarantine_root"
}

case "$action" in
  install)
    mkdir -p -- "$install_dir"
    if [[ -e "$destination" || -L "$destination" ]]; then
      is_owned_link || fail "refusing to overwrite unrelated path: $destination"
      printf 'trellage installer: already installed at %s\n' "$destination"
      exit 0
    fi
    ln -s -- "$command_path" "$destination"
    printf 'trellage installer: installed %s\n' "$destination"
    ;;
  uninstall)
    if [[ ! -e "$destination" && ! -L "$destination" ]]; then
      printf 'trellage installer: already absent at %s\n' "$destination"
      exit 0
    fi
    is_owned_link || fail "refusing to remove unrelated path: $destination"
    if (( dry_run )); then
      printf 'trellage installer: would remove %s\n' "$destination"
      exit 0
    fi
    remove_owned_destination
    printf 'trellage installer: removed %s\n' "$destination"
    ;;
esac
