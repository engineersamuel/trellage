#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
package_root="$repo_root/packages/trellage-cli"
inputs=(
  "$package_root/package.json"
  "$package_root/package-lock.json"
  "$package_root/tsconfig.json"
  "$package_root/tsconfig.build.json"
  "$repo_root/scripts/build-profile-compiler.sh"
  "$repo_root/scripts/profile-compiler-fingerprint.sh"
  "$package_root"/src/*.ts
)

for input in "${inputs[@]}"; do
  [[ -f "$input" ]] || {
    printf 'profile compiler fingerprint: missing input: %s\n' "$input" >&2
    exit 1
  }
done

shasum -a 256 "${inputs[@]}" \
  | awk -v root="$repo_root/" '
      {
        digest = $1
        absolute = substr($0, length($1) + 3)
        if (index(absolute, root) != 1) exit 1
        relative = substr(absolute, length(root) + 1)
        printf "%s%c%s\n", relative, 0, digest
      }
    ' \
  | shasum -a 256 \
  | awk '{print $1}'
