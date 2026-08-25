#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf 'install-floating-skills-runtime: %s\n' "$1" >&2
  exit 1
}

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
source_manager="$repo_root/scripts/floating-skills.mjs"
source_catalog="$repo_root/skills.json"

[[ -f "$source_manager" && ! -L "$source_manager" ]] \
  || fail "invalid floating-skills manager: $source_manager"
[[ -f "$source_catalog" && ! -L "$source_catalog" ]] \
  || fail "invalid skill catalog: $source_catalog"
[[ "${HOME-}" == /* && "$HOME" != / && -d "$HOME" && ! -L "$HOME" ]] \
  || fail "unsafe HOME: ${HOME-}"

canonical_home="$(cd -P "$HOME" && pwd -P)"
runtime_parent="$canonical_home/.local/share/trellage"
common_root="$runtime_parent/common"
destination="$common_root/floating-skills-runtime"

for directory in "$canonical_home/.local" "$canonical_home/.local/share" "$runtime_parent" "$common_root"; do
  [[ ! -L "$directory" ]] || fail "unsafe symlinked runtime path: $directory"
  if [[ -e "$directory" ]]; then
    [[ -d "$directory" ]] || fail "runtime path is not a directory: $directory"
  else
    mkdir "$directory"
  fi
done

stage="$(mktemp -d "$runtime_parent/.floating-skills-runtime.XXXXXX")"
backup="$stage.old"
rollback_required=false
cleanup() {
  local status=$?
  trap - EXIT
  if [[ "$status" -ne 0 && "$rollback_required" == true ]]; then
    rm -rf -- "$destination"
    if ! mv "$backup" "$destination"; then
      printf 'install-floating-skills-runtime: rollback failed; previous runtime retained at %s\n' "$backup" >&2
      rm -rf -- "$stage"
      exit "$status"
    fi
  fi
  rm -rf -- "$stage"
  [[ "$rollback_required" == true ]] || rm -rf -- "$backup"
  exit "$status"
}
trap cleanup EXIT

mkdir "$stage/runtime"
install -m 0555 "$source_manager" "$stage/runtime/floating-skills.mjs"
install -m 0444 "$source_catalog" "$stage/runtime/skills.json"

if [[ -e "$destination" || -L "$destination" ]]; then
  [[ -d "$destination" && ! -L "$destination" ]] \
    || fail "unsafe installed floating-skills runtime: $destination"
  mv "$destination" "$backup"
  rollback_required=true
fi
mv "$stage/runtime" "$destination"
rollback_required=false
rm -rf -- "$backup"
