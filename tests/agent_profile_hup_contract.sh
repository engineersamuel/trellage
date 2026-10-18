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

grep -Fq '# HUP must terminate the active live process group, reap its child, and remove temporary state.' tests/agent_profile_matrix.sh \
  || fail 'dynamic process and temporary cleanup matrix omits HUP'
grep -Fq 'kill -HUP "$verifier_pid"' tests/agent_profile_matrix.sh \
  || fail 'live verifier HUP delivery is not covered'
grep -Fq "fail 'HUP left the live child running'" tests/agent_profile_matrix.sh \
  || fail 'live descendant cleanup omits HUP'

printf 'agent profile HUP contract: PASS\n'
