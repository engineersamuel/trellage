#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf 'install-engineersamuel-skills-runtime: %s\n' "$1" >&2
  exit 1
}

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
source_snapshot="$repo_root/vendor/engineersamuel-skills"
source_helper="$repo_root/scripts/sync-engineersamuel-skills.sh"

[[ "${HOME-}" == /* && "$HOME" != / && -d "$HOME" && ! -L "$HOME" ]] \
  || fail "unsafe HOME: ${HOME-}"
canonical_home="$(cd -P "$HOME" && pwd -P)"
runtime_parent="$canonical_home/.local/share/trellage"
common_root="$runtime_parent/common"

for directory in "$canonical_home/.local" "$canonical_home/.local/share" "$runtime_parent" "$common_root"; do
  [[ ! -L "$directory" ]] || fail "unsafe symlinked runtime path: $directory"
  if [[ -e "$directory" ]]; then
    [[ -d "$directory" ]] || fail "runtime path is not a directory: $directory"
  else
    mkdir "$directory"
  fi
done

stage="$(mktemp -d "$runtime_parent/.engineersamuel-skills.XXXXXX")"
backup="$stage.old"
cleanup() {
  rm -rf -- "$stage" "$backup"
}
trap cleanup EXIT

mkdir "$stage/engineersamuel-skills"
cp -R "$source_snapshot/." "$stage/engineersamuel-skills/"
install -m 0555 "$source_helper" "$stage/sync-engineersamuel-skills.sh"
chmod -R u=rwX,go=rX "$stage/engineersamuel-skills"

if [[ -e "$common_root/engineersamuel-skills" || -L "$common_root/engineersamuel-skills" ]]; then
  [[ -d "$common_root/engineersamuel-skills" && ! -L "$common_root/engineersamuel-skills" ]] \
    || fail "unsafe installed skill snapshot: $common_root/engineersamuel-skills"
  mv "$common_root/engineersamuel-skills" "$backup"
fi
mv "$stage/engineersamuel-skills" "$common_root/engineersamuel-skills"
install -m 0555 "$stage/sync-engineersamuel-skills.sh" \
  "$common_root/sync-engineersamuel-skills.sh"
rm -rf -- "$backup"
