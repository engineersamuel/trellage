#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
fingerprint="$repo_root/scripts/profile-compiler-fingerprint.sh"

fail() {
  printf 'profile compiler fingerprint contract: %s\n' "$1" >&2
  exit 1
}

now_ns() { python3 -c 'import time; print(time.monotonic_ns())'; }

# The first run fills the cache; the contract is about the cached case. Take the best of 3 cached runs, so a busy
# host (the pre-push hook runs this beside the whole suite) cannot fail it, while a real slowdown still does.
first="$($fingerprint)"
elapsed_ms=""
for _ in 1 2 3; do
  start="$(now_ns)"
  second="$($fingerprint)"
  finish="$(now_ns)"
  ms="$(((finish - start) / 1000000))"
  [[ -z "$elapsed_ms" || "$ms" -lt "$elapsed_ms" ]] && elapsed_ms="$ms"
  [[ "$second" == "$first" ]] || fail 'unchanged inputs produced different fingerprints'
done

[[ "$first" =~ ^[0-9a-f]{64}$ ]] || fail 'output is not a SHA-256 digest'
((elapsed_ms < 900)) || fail "cached-worktree fingerprint took ${elapsed_ms}ms; expected less than 900ms"

printf 'profile compiler fingerprint contract: PASS (%sms)\n' "$elapsed_ms"
