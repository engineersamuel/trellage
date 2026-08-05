#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
package_root="$repo_root/packages/trellage-cli"
stamp="$package_root/dist/.source-hash"

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
