#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf 'install-native-environment-runtime: %s\n' "$1" >&2
  exit 1
}

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
package_root="$repo_root/packages/trellage-cli"
source_resolver="$repo_root/scripts/native-environment.mjs"

[[ -f "$source_resolver" && ! -L "$source_resolver" ]] \
  || fail "invalid native environment resolver: $source_resolver"
[[ "${HOME-}" == /* && "$HOME" != / && -d "$HOME" && ! -L "$HOME" ]] \
  || fail "unsafe HOME: ${HOME-}"
command -v node >/dev/null 2>&1 || fail "required command not found: node"

system_name="$(uname -s 2>/dev/null)" || fail "could not identify the host system"
current_uid="$(id -u 2>/dev/null)" || fail "could not identify the current user"

path_mode() {
  case "$system_name" in
    Darwin) stat -f '%Lp' "$1" ;;
    Linux) stat -c '%a' "$1" ;;
    *) return 1 ;;
  esac
}

path_uid() {
  case "$system_name" in
    Darwin) stat -f '%u' "$1" ;;
    Linux) stat -c '%u' "$1" ;;
    *) return 1 ;;
  esac
}

mode_has_shared_write() {
  case "$1" in
    *[2367][0-7] | *[0-7][2367]) return 0 ;;
    *) return 1 ;;
  esac
}

assert_owned_safe_path() {
  local candidate="$1"
  local expected_kind="$2"
  local mode
  local owner

  [[ ! -L "$candidate" ]] || fail "unsafe symlinked runtime path: $candidate"
  case "$expected_kind" in
    directory) [[ -d "$candidate" ]] || fail "runtime path is not a directory: $candidate" ;;
    file) [[ -f "$candidate" ]] || fail "runtime path is not a regular file: $candidate" ;;
    *) fail "internal path-kind error: $expected_kind" ;;
  esac
  owner="$(path_uid "$candidate")" || fail "could not inspect runtime path owner: $candidate"
  [[ "$owner" == "$current_uid" ]] || fail "runtime path is not owned by the current user: $candidate"
  mode="$(path_mode "$candidate")" || fail "could not inspect runtime path mode: $candidate"
  [[ "$mode" =~ ^[0-7]{3,4}$ ]] || fail "invalid runtime path mode: $candidate"
  ! mode_has_shared_write "$mode" \
    || fail "runtime path must not be writable by group or other users: $candidate"
}

dependency_root="$package_root/node_modules"
if [[ ! -d "$dependency_root/varlock" || ! -d "$dependency_root/smol-toml" ]]; then
  dependency_root="$repo_root/node_modules"
fi
if [[ ! -d "$dependency_root/varlock" || ! -d "$dependency_root/smol-toml" ]]; then
  command -v npm >/dev/null 2>&1 || fail "npm is required to install native environment dependencies"
  printf 'install-native-environment-runtime: installing declared dependencies\n' >&2
  npm --prefix "$package_root" ci
  dependency_root="$package_root/node_modules"
fi

source_varlock="$dependency_root/varlock"
source_toml="$dependency_root/smol-toml"
for package_path in "$source_varlock" "$source_toml"; do
  [[ -d "$package_path" && ! -L "$package_path" ]] \
    || fail "invalid native environment dependency: $package_path"
  [[ -z "$(find "$package_path" -type l -print -quit)" ]] \
    || fail "native environment dependency contains a symbolic link: $package_path"
done
[[ -f "$source_varlock/bin/cli.js" && ! -L "$source_varlock/bin/cli.js" ]] \
  || fail "invalid Varlock CLI: $source_varlock/bin/cli.js"

canonical_home="$(cd -P "$HOME" && pwd -P)"
assert_owned_safe_path "$canonical_home" directory
runtime_parent="$canonical_home/.local/share/trellage"
common_root="$runtime_parent/common"
destination="$common_root/native-environment-runtime"
ownership_value='trellage-native-environment-runtime-v1'

for directory in "$canonical_home/.local" "$canonical_home/.local/share" "$runtime_parent" "$common_root"; do
  [[ ! -L "$directory" ]] || fail "unsafe symlinked runtime path: $directory"
  if [[ -e "$directory" ]]; then
    assert_owned_safe_path "$directory" directory
  else
    mkdir -m 0755 "$directory"
    assert_owned_safe_path "$directory" directory
  fi
done

if [[ -e "$destination" || -L "$destination" ]]; then
  assert_owned_safe_path "$destination" directory
  [[ -f "$destination/.managed-by-trellage" && ! -L "$destination/.managed-by-trellage" ]] \
    || fail "refusing unowned native environment runtime: $destination"
  assert_owned_safe_path "$destination/.managed-by-trellage" file
  cmp -s "$destination/.managed-by-trellage" <(printf '%s\n' "$ownership_value") \
    || fail "refusing unowned native environment runtime: $destination"
  [[ -z "$(find "$destination" -type l -print -quit)" ]] \
    || fail "installed native environment runtime contains a symbolic link: $destination"
fi

stage="$(mktemp -d "$runtime_parent/.native-environment-runtime.XXXXXX")"
backup="$stage.old"
rollback_required=false
cleanup() {
  local status=$?
  trap - EXIT
  if [[ "$status" -ne 0 && "$rollback_required" == true ]]; then
    rm -rf -- "$destination"
    if ! mv "$backup" "$destination"; then
      printf 'install-native-environment-runtime: rollback failed; previous runtime retained at %s\n' \
        "$backup" >&2
      rm -rf -- "$stage"
      exit "$status"
    fi
  fi
  rm -rf -- "$stage"
  [[ "$rollback_required" == true ]] || rm -rf -- "$backup"
  exit "$status"
}
trap cleanup EXIT

mkdir -p "$stage/runtime/node_modules"
install -m 0555 "$source_resolver" "$stage/runtime/native-environment.mjs"
cp -R "$source_varlock" "$stage/runtime/node_modules/varlock"
cp -R "$source_toml" "$stage/runtime/node_modules/smol-toml"
printf '%s\n' "$ownership_value" >"$stage/runtime/.managed-by-trellage"
chmod 0444 "$stage/runtime/.managed-by-trellage"
[[ -z "$(find "$stage/runtime" -type l -print -quit)" ]] \
  || fail "staged native environment runtime contains a symbolic link"
find "$stage/runtime" -type d -exec chmod 0755 {} +
find "$stage/runtime" -type f -exec chmod go-w {} +

if [[ -e "$destination" || -L "$destination" ]]; then
  mv "$destination" "$backup"
  rollback_required=true
fi
mv "$stage/runtime" "$destination"
rollback_required=false
rm -rf -- "$backup"
