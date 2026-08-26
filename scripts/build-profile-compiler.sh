#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
package_root="$repo_root/packages/trellage-cli"
guide_core="$repo_root/packages/trellage-guide-core"
stamp="$package_root/dist/.source-hash"

if [[ ! -x "$guide_core/node_modules/.bin/tsc" ]]; then
  command -v npm >/dev/null 2>&1 || {
    printf 'profile compiler build: npm is required to install profile guide dependencies\n' >&2
    exit 1
  }
  printf 'profile compiler build: installing profile guide dependencies\n' >&2
  npm --prefix "$guide_core" ci
fi

"$guide_core/node_modules/.bin/tsc" -p "$guide_core/tsconfig.build.json"

cd "$package_root"
./node_modules/.bin/tsc -p tsconfig.build.json

temp_stamp="$(mktemp "$package_root/dist/.source-hash.XXXXXX")"
cleanup() {
  rm -f -- "$temp_stamp"
}
trap cleanup EXIT HUP INT TERM
"$repo_root/scripts/profile-compiler-fingerprint.sh" >"$temp_stamp"
chmod 0644 "$temp_stamp"
mv -f -- "$temp_stamp" "$stamp"
trap - EXIT HUP INT TERM
