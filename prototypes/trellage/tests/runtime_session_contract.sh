#!/usr/bin/env bash
set -euo pipefail

prototype_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
test_root="$(mktemp -d "${TMPDIR:-/tmp}/trellage-codex-session-test.XXXXXX")"
test_root="$(cd "$test_root" && pwd -P)"
trap '[[ "${KEEP_TEST_ROOT:-0}" == 1 ]] || rm -rf -- "$test_root"' EXIT

fail() {
  printf 'Trellage runtime session test: FAIL: %s\n' "$1" >&2
  exit 1
}

fake_bin="$test_root/fake-bin"
seed_home="$test_root/seed/.codex"
worktree="$test_root/worktree"
mkdir -p "$fake_bin" "$seed_home" "$worktree"
printf 'seed\n' >"$seed_home/config.toml"

cat >"$fake_bin/codex" <<'FAKE_CODEX'
#!/usr/bin/env bash
set -euo pipefail
printf 'ARG\t%s\n' "$@" >>"${FAKE_CODEX_LOG:?}"
if [[ "${FAKE_CODEX_CREATE_SESSION:-0}" == 1 ]]; then
  session_dir="$CODEX_HOME/sessions/2026/07/24"
  mkdir -p "$session_dir"
  jq -nc --arg id "${FAKE_CODEX_THREAD_ID:?}" --arg cwd "$PWD" \
    '{type:"session_meta",payload:{id:$id,cwd:$cwd}}' \
    >"$session_dir/rollout-${FAKE_CODEX_THREAD_ID}.jsonl"
fi
if [[ -n "${FAKE_CODEX_STARTED_FILE:-}" ]]; then
  : >"$FAKE_CODEX_STARTED_FILE"
fi
if [[ -n "${FAKE_CODEX_RELEASE_FILE:-}" ]]; then
  while [[ ! -f "$FAKE_CODEX_RELEASE_FILE" ]]; do
    sleep 0.01
  done
fi
exit "${FAKE_CODEX_EXIT:-0}"
FAKE_CODEX
chmod +x "$fake_bin/codex"

run_entry() {
  (
    cd "$worktree"
    PATH="$fake_bin:$PATH" \
      HARNESS_CODEX_SEED_HOME="$test_root/legacy-seed-must-not-be-used" \
      HARNESS_CODEX_HOME="$test_root/legacy-home-must-not-be-used" \
      HARNESS_FLOCK="$test_root/legacy-flock-must-not-be-used" \
      TRELLAGE_CODEX_SEED_HOME="$seed_home" \
      TRELLAGE_CODEX_HOME="$test_root/codex-home" \
      FAKE_CODEX_LOG="$test_root/codex.log" \
      "$prototype_dir/runtime-entry.sh" "$@"
  )
}

test_codex_home_precedence() {
  local default_fake_bin="$test_root/default-home-fake-bin"
  local default_mkdir_log="$test_root/default-home-mkdir.log"
  local precedence_home="$test_root/precedence-home"
  local status=0
  mkdir -p "$default_fake_bin" "$precedence_home"
  printf 'precedence\n' >"$precedence_home/config.toml"
  cat >"$default_fake_bin/mkdir" <<'FAKE_MKDIR'
#!/usr/bin/env bash
set -euo pipefail
printf 'ARG\t%s\n' "$@" >"${DEFAULT_MKDIR_LOG:?}"
exit 99
FAKE_MKDIR
  chmod +x "$default_fake_bin/mkdir"

  (
    cd "$worktree"
    env -u TRELLAGE_CODEX_HOME \
      CODEX_HOME="$precedence_home" \
      TRELLAGE_CODEX_SEED_HOME="$precedence_home" \
      "$prototype_dir/runtime-entry.sh" passthrough bash -c \
      'test "$CODEX_HOME" = "$1"' _ "$precedence_home"
  ) || fail 'ambient CODEX_HOME was not used when Trellage override was absent'
  printf 'Trellage runtime session test: PASS: ambient CODEX_HOME fallback\n'

  CODEX_HOME="$test_root/ambient-home-must-not-win" \
    TRELLAGE_CODEX_HOME="$precedence_home" \
    TRELLAGE_CODEX_SEED_HOME="$precedence_home" \
    "$prototype_dir/runtime-entry.sh" passthrough bash -c \
    'test "$CODEX_HOME" = "$1"' _ "$precedence_home" \
    || fail 'TRELLAGE_CODEX_HOME did not override ambient CODEX_HOME'
  printf 'Trellage runtime session test: PASS: Trellage home overrides ambient CODEX_HOME\n'

  set +e
  (
    cd "$worktree"
    env -u TRELLAGE_CODEX_HOME -u CODEX_HOME \
      PATH="$default_fake_bin:$PATH" \
      DEFAULT_MKDIR_LOG="$default_mkdir_log" \
      TRELLAGE_CODEX_SEED_HOME="$precedence_home" \
      "$prototype_dir/runtime-entry.sh" passthrough true
  )
  status=$?
  set -e
  [[ "$status" -eq 99 ]] \
    || fail "default home probe exited $status instead of controlled mkdir status 99"
  grep -Fqx $'ARG\t-p' "$default_mkdir_log" \
    || fail 'default home probe did not preserve mkdir options'
  grep -Fqx $'ARG\t/home/agent/.codex' "$default_mkdir_log" \
    || fail 'default Codex home changed from /home/agent/.codex'
  printf 'Trellage runtime session test: PASS: default CODEX_HOME remains /home/agent/.codex\n'
}

test_codex_home_precedence

thread_id='019f93af-41dd-7333-9bea-d8edc20760e5'
: >"$test_root/codex.log"
FAKE_CODEX_CREATE_SESSION=1 FAKE_CODEX_THREAD_ID="$thread_id" \
  run_entry prompt codex --dangerously-bypass-approvals-and-sandbox -- 'hello $(false)'
expected_prompt_args=$'ARG\texec\nARG\t--dangerously-bypass-approvals-and-sandbox\nARG\t--\nARG\thello $(false)'
[[ "$(cat "$test_root/codex.log")" == "$expected_prompt_args" ]] \
  || fail 'portable prompt was not translated to exact native Codex exec argv'
[[ "$(cat "$test_root/codex-home/.trellage-codex/last-thread-id")" == "$thread_id" ]] \
  || fail 'Codex prompt mode did not retain native session tracking'
printf 'Trellage runtime session test: PASS: portable prompt uses native Codex exec\n'

rm -rf "$test_root/codex-home"
: >"$test_root/codex.log"
prompt_status=0
FAKE_CODEX_CREATE_SESSION=1 FAKE_CODEX_THREAD_ID="$thread_id" FAKE_CODEX_EXIT=27 \
  run_entry prompt codex --dangerously-bypass-approvals-and-sandbox -- 'failed prompt' \
  || prompt_status=$?
[[ "$prompt_status" -eq 27 ]] \
  || fail "Codex prompt mode changed native status 27 to $prompt_status"
printf 'Trellage runtime session test: PASS: portable prompt preserves native failure status\n'

rm -rf "$test_root/codex-home"
: >"$test_root/codex.log"
FAKE_CODEX_CREATE_SESSION=1 FAKE_CODEX_THREAD_ID="$thread_id" \
  run_entry new codex -- 'original startup prompt'
[[ "$(cat "$test_root/codex-home/.trellage-codex/last-thread-id")" == "$thread_id" ]] \
  || fail 'new native thread ID was not recorded'
grep -Fqx $'ARG\toriginal startup prompt' "$test_root/codex.log" \
  || fail 'new startup prompt was not passed literally'

: >"$test_root/codex.log"
run_entry resume codex
grep -Fqx $'ARG\tresume' "$test_root/codex.log" || fail 'native resume subcommand missing'
grep -Fqx $'ARG\t'"$thread_id" "$test_root/codex.log" || fail 'recorded native thread ID missing'
! grep -Fq 'original startup prompt' "$test_root/codex.log" \
  || fail 'resume replayed original startup prompt'
printf 'Trellage runtime session test: PASS: record and native resume argv\n'

rm -rf "$test_root/codex-home"
: >"$test_root/codex.log"
if run_entry resume codex >"$test_root/missing.out" 2>&1; then
  fail 'resume without native state succeeded'
else
  [[ "$?" -eq 66 ]] || fail 'missing native state did not exit 66'
fi
grep -Fq 'start a new session with: trellage' "$test_root/missing.out" \
  || fail 'missing native state lacks start-new guidance'
printf 'Trellage runtime session test: PASS: missing state guidance\n'

mkdir -p "$test_root/codex-home/sessions/2026/07/24"
jq -nc --arg id "$thread_id" --arg cwd "$worktree" \
  '{type:"session_meta",payload:{id:$id,cwd:$cwd}}' \
  >"$test_root/codex-home/sessions/2026/07/24/rollout-recovered.jsonl"
wrong_thread_id='019f93af-41dd-7333-9bea-d8edc20760e6'
jq -nc --arg id "$wrong_thread_id" --arg cwd "$test_root/other-worktree" \
  '{type:"session_meta",payload:{id:$id,cwd:$cwd}}' \
  >"$test_root/codex-home/sessions/2026/07/24/rollout-wrong-worktree.jsonl"
touch -t 202607242359 \
  "$test_root/codex-home/sessions/2026/07/24/rollout-wrong-worktree.jsonl"
: >"$test_root/codex.log"
run_entry resume codex
[[ "$(cat "$test_root/codex-home/.trellage-codex/last-thread-id")" == "$thread_id" ]] \
  || fail 'missing wrapper metadata was not recovered from native store'
printf 'Trellage runtime session test: PASS: native store recovery\n'

printf 'not-a-thread\n' >"$test_root/codex-home/.trellage-codex/last-thread-id"
if run_entry resume codex >"$test_root/malformed.out" 2>&1; then
  fail 'malformed recorded thread ID succeeded'
else
  [[ "$?" -eq 66 ]] || fail 'malformed recorded thread ID did not exit 66'
fi
printf 'Trellage runtime session test: PASS: malformed metadata rejected\n'

printf '%s\n' "$wrong_thread_id" \
  >"$test_root/codex-home/.trellage-codex/last-thread-id"
if run_entry resume codex >"$test_root/unmatched.out" 2>&1; then
  fail 'thread ID unmatched for the current worktree succeeded'
else
  [[ "$?" -eq 66 ]] || fail 'unmatched recorded thread ID did not exit 66'
fi
printf 'Trellage runtime session test: PASS: unmatched metadata rejected\n'

rm -rf "$test_root/codex-home"
: >"$test_root/codex.log"
set +e
FAKE_CODEX_CREATE_SESSION=1 FAKE_CODEX_THREAD_ID="$thread_id" FAKE_CODEX_EXIT=23 \
  run_entry new codex
status=$?
set -e
[[ "$status" -eq 23 ]] || fail 'Codex failure exit status changed'
[[ "$(cat "$test_root/codex-home/.trellage-codex/last-thread-id")" == "$thread_id" ]] \
  || fail 'native state was not retained after Codex failure'
printf 'Trellage runtime session test: PASS: Codex failure status and state retained\n'

self_home="$test_root/self-home"
mkdir -p "$self_home"
printf 'keep\n' >"$self_home/config.toml"
HARNESS_CODEX_SEED_HOME="$test_root/legacy-self-seed-must-not-be-used" \
  HARNESS_CODEX_HOME="$test_root/legacy-self-home-must-not-be-used" \
  TRELLAGE_CODEX_SEED_HOME="$self_home" TRELLAGE_CODEX_HOME="$self_home" \
  "$prototype_dir/runtime-entry.sh" passthrough bash -c \
  'test "$CODEX_HOME" = "$TRELLAGE_CODEX_HOME" && test -f "$CODEX_HOME/config.toml"'
printf 'Trellage runtime session test: PASS: durable home avoids self-copy\n'
[[ ! -e "$test_root/legacy-home-must-not-be-used" \
  && ! -e "$test_root/legacy-self-home-must-not-be-used" ]] \
  || fail 'legacy Codex runtime variables changed durable state'
printf 'Trellage runtime session test: PASS: legacy runtime variables are ignored\n'

rm -rf "$test_root/codex-home"
first_started_file="$test_root/concurrent-first-started"
first_release_file="$test_root/concurrent-first-release"
second_started_file="$test_root/concurrent-second-started"
second_release_file="$test_root/concurrent-second-release"
first_thread_id='019f93af-41dd-7333-9bea-d8edc20760e7'
second_thread_id='019f93af-41dd-7333-9bea-d8edc20760e8'
FAKE_CODEX_CREATE_SESSION=1 FAKE_CODEX_THREAD_ID="$first_thread_id" \
  FAKE_CODEX_STARTED_FILE="$first_started_file" \
  FAKE_CODEX_RELEASE_FILE="$first_release_file" \
  run_entry new codex >"$test_root/first-concurrent.out" 2>&1 &
first_pid=$!
for _ in {1..500}; do
  [[ -f "$first_started_file" ]] && break
  sleep 0.01
done
[[ -f "$first_started_file" ]] || fail 'first concurrent invocation did not start'

FAKE_CODEX_CREATE_SESSION=1 FAKE_CODEX_THREAD_ID="$second_thread_id" \
  FAKE_CODEX_STARTED_FILE="$second_started_file" \
  FAKE_CODEX_RELEASE_FILE="$second_release_file" \
  run_entry new codex >"$test_root/second-concurrent.out" 2>&1 &
second_pid=$!
for _ in {1..500}; do
  [[ -f "$second_started_file" ]] && break
  ! kill -0 "$second_pid" 2>/dev/null && break
  sleep 0.01
done
if [[ ! -f "$second_started_file" ]]; then
  : >"$first_release_file"
  set +e
  wait "$first_pid"
  first_status=$?
  wait "$second_pid"
  second_status=$?
  set -e
  fail "second concurrent invocation did not start (first=$first_status second=$second_status)"
fi

: >"$first_release_file"
set +e
wait "$first_pid"
first_status=$?
set -e
: >"$second_release_file"
set +e
wait "$second_pid"
second_status=$?
set -e

[[ "$first_status" -eq 0 && "$second_status" -eq 0 ]] \
  || fail "concurrent same-worktree invocations exited first=$first_status second=$second_status"
[[ -f "$test_root/codex-home/sessions/2026/07/24/rollout-${first_thread_id}.jsonl" ]] \
  || fail 'first concurrent native session was not preserved'
[[ -f "$test_root/codex-home/sessions/2026/07/24/rollout-${second_thread_id}.jsonl" ]] \
  || fail 'second concurrent native session was not preserved'
[[ "$(cat "$test_root/codex-home/.trellage-codex/last-thread-id")" == "$second_thread_id" ]] \
  || fail 'concurrent launches did not retain the newest native thread marker'
printf 'Trellage runtime session test: PASS: concurrent same-worktree launches\n'
