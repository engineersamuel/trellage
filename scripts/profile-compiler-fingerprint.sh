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

{
  for input in "${inputs[@]}"; do
    printf '%s\0' "${input#"$repo_root"/}"
    shasum -a 256 "$input" | awk '{print $1}'
  done
} | shasum -a 256 | awk '{print $1}'
