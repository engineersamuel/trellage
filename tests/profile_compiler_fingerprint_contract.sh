#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
fingerprint="$repo_root/scripts/profile-compiler-fingerprint.sh"

fail() {
  printf 'profile compiler fingerprint contract: %s\n' "$1" >&2
  exit 1
}

start="$(python3 -c 'import time; print(time.monotonic_ns())')"
first="$($fingerprint)"
finish="$(python3 -c 'import time; print(time.monotonic_ns())')"
second="$($fingerprint)"
elapsed_ms="$(((finish - start) / 1000000))"

[[ "$first" =~ ^[0-9a-f]{64}$ ]] || fail 'output is not a SHA-256 digest'
[[ "$second" == "$first" ]] || fail 'unchanged inputs produced different fingerprints'
((elapsed_ms < 900)) || fail "cached-worktree fingerprint took ${elapsed_ms}ms; expected less than 900ms"

printf 'profile compiler fingerprint contract: PASS (%sms)\n' "$elapsed_ms"
