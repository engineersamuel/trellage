#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

fail() {
  printf 'agent profile HUP contract: FAIL: %s\n' "$1" >&2
  exit 1
}

grep -Fq "trap 'handle_signal 129' HUP" scripts/verify-agent-profiles \
  || fail 'HUP does not map to exit 129'
grep -Fq 'trap - EXIT HUP INT TERM' scripts/verify-agent-profiles \
  || fail 'cleanup does not reset HUP'
grep -Fq 'trap - HUP INT TERM' scripts/verify-agent-profiles \
  || fail 'signal handler does not restore HUP'
grep -Fq "trap '' HUP INT TERM" scripts/verify-agent-profiles \
  || fail 'live launch supervisor does not ignore HUP during handoff'

grep -Fq 'for verifier_signal in HUP INT TERM; do' tests/agent_profile_matrix.sh \
  || fail 'dynamic process and temporary cleanup matrix omits HUP'
grep -Fq "'HUP hold-before-release waiting'" tests/agent_profile_matrix.sh \
  || fail 'launch-window cleanup matrix omits HUP'
grep -Fq "'cpx HUP zeta'" tests/agent_profile_matrix.sh \
  || fail 'descendant-tree cleanup matrix omits HUP'

printf 'agent profile HUP contract: PASS\n'
