#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

fail() {
  printf 'harness session discovery: FAIL: %s\n' "$1" >&2
  exit 1
}

finder='scripts/find-harness-session.sh'
fixture_root="$(mktemp -d)"
cleanup() {
  rm -rf -- "$fixture_root"
}
trap cleanup EXIT

codex_home="$fixture_root/codex"
copilot_home="$fixture_root/copilot"
mkdir -p \
  "$codex_home/sessions/2026/08/10" \
  "$copilot_home/session-state/11111111-1111-4111-8111-111111111111" \
  "$copilot_home/session-state/22222222-2222-4222-8222-222222222222" \
  "$copilot_home/session-state/33333333-3333-4333-8333-333333333333"

printf '%s\n' \
  '{"type":"session_meta","payload":{"cwd":"/workspace","id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}}' \
  >"$codex_home/sessions/2026/08/10/older.jsonl"
printf '%s\n' \
  '{"type":"session_meta","payload":{"cwd":"/workspace","id":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"}}' \
  >"$codex_home/sessions/2026/08/10/newer.jsonl"
printf '%s\n' \
  '{"type":"session_meta","payload":{"cwd":"/other","id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc"}}' \
  >"$codex_home/sessions/2026/08/10/other.jsonl"
printf '%s\n' 'not-json' >"$codex_home/sessions/2026/08/10/malformed.jsonl"
touch -t 202608101200 "$codex_home/sessions/2026/08/10/older.jsonl"
touch -t 202608101201 "$codex_home/sessions/2026/08/10/newer.jsonl"
touch -t 202608101202 "$codex_home/sessions/2026/08/10/other.jsonl"

[[ "$("$finder" codex "$codex_home" /workspace)" == \
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' ]] \
  || fail 'Codex discovery did not select the newest matching session'
[[ "$("$finder" codex "$codex_home" /workspace \
  aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa)" == \
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' ]] \
  || fail 'Codex discovery did not validate a requested session'
if "$finder" codex "$codex_home" /workspace \
  cccccccc-cccc-4ccc-8ccc-cccccccccccc >/dev/null; then
  fail 'Codex discovery accepted a session for another cwd'
fi

printf '%s\n' 'cwd: /workspace' \
  >"$copilot_home/session-state/11111111-1111-4111-8111-111111111111/workspace.yaml"
printf '%s\n' 'cwd: "/workspace"' \
  >"$copilot_home/session-state/22222222-2222-4222-8222-222222222222/workspace.yaml"
printf '%s\n' 'cwd: /other' \
  >"$copilot_home/session-state/33333333-3333-4333-8333-333333333333/workspace.yaml"
touch -t 202608101200 \
  "$copilot_home/session-state/11111111-1111-4111-8111-111111111111/workspace.yaml"
touch -t 202608101201 \
  "$copilot_home/session-state/22222222-2222-4222-8222-222222222222/workspace.yaml"

[[ "$("$finder" copilot "$copilot_home" /workspace)" == \
  '22222222-2222-4222-8222-222222222222' ]] \
  || fail 'Copilot discovery did not select the newest matching session'
if "$finder" copilot "$copilot_home" /workspace \
  33333333-3333-4333-8333-333333333333 >/dev/null; then
  fail 'Copilot discovery accepted a session for another cwd'
fi
if "$finder" copilot "$fixture_root/missing" /workspace >/dev/null; then
  fail 'discovery succeeded without native session state'
fi

printf 'harness session discovery: PASS\n'
