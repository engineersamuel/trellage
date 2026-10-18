#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

fail() {
  printf 'agent profile matrix: FAIL: %s\n' "$1" >&2
  exit 1
}

[[ "$(make --no-print-directory -n profile-matrix)" == 'scripts/verify-agent-profiles ' ]] \
  || fail 'profile-matrix does not run the verifier'
[[ "$(make --no-print-directory -n profile-matrix PROFILE_MATRIX_ARGS=--live)" == 'scripts/verify-agent-profiles --live' ]] \
  || fail 'profile-matrix does not forward live arguments'
[[ "$(make --no-print-directory -n profile-matrix-test)" == 'bash tests/agent_profile_matrix.sh' ]] \
  || fail 'profile-matrix-test does not run this contract'

fixture="$(mktemp -d)"
trap 'rm -rf -- "$fixture"' EXIT
mkdir -p "$fixture/bin" "$fixture/tmp" "$fixture/data"
log="$fixture/commands.log"
: >"$log"

cat >"$fixture/bin/cpx" <<'CPX'
#!/usr/bin/env bash
set -euo pipefail
printf 'cpx' >>"$FAKE_COMMAND_LOG"
printf '\t%s' "$@" >>"$FAKE_COMMAND_LOG"
printf '\n' >>"$FAKE_COMMAND_LOG"
case "${1-}" in
  list)
    cat "$FAKE_DATA/cpx-list"
    ;;
  doctor)
    [[ "$#" == 2 ]] || exit 64
    if [[ -e "$FAKE_DATA/fail-doctor-$2" ]]; then
      printf 'DOCTOR_SECRET_DO_NOT_LEAK\n' >&2
      exit 65
    fi
    printf '%s: healthy\n' "$2"
    ;;
  *) exit 64 ;;
esac
CPX

cat >"$fixture/bin/trx" <<'TRX'
#!/usr/bin/env bash
set -euo pipefail
printf 'trx' >>"$FAKE_COMMAND_LOG"
printf '\t%s' "$@" >>"$FAKE_COMMAND_LOG"
printf '\n' >>"$FAKE_COMMAND_LOG"
[[ "${1-}" == run && "${2-}" == copilot && -n "${3-}" && "${4-}" == -- ]] || exit 64
profile="$3"
shift 4
case "${1-} ${2-} ${3-}" in
  'plugin list ')
    package="$(while IFS=$'\t' read -r candidate value; do [[ "$candidate" != "$profile" ]] || { printf '%s\n' "$value"; break; }; done <"$FAKE_DATA/cpx-list")"
    printf 'Installed plugins:\n  • %s (v1)\n' "$package"
    ;;
  'skill list --json')
    cat "$FAKE_DATA/cpx-$profile-skills.json"
    ;;
  --prompt*)
    if [[ -n "${FAKE_HUP_READY_FILE-}" ]]; then
      printf '%s\n' "$$" >"$FAKE_HUP_CHILD_PID_FILE"
      : >"$FAKE_HUP_READY_FILE"
      trap 'exit 129' HUP
      trap 'exit 143' TERM
      while :; do sleep 1; done
    fi
    printf '%s\n' '{"type":"assistant.message","data":{"content":"{\"launcher\":\"cpx\",\"profile\":\"alpha\",\"skills\":[\"p1\",\"p2\"],\"emptyPackageConfirmed\":false}"}}'
    ;;
  *) exit 64 ;;
esac
TRX
chmod 0755 "$fixture/bin/cpx" "$fixture/bin/trx"

printf '%s\n' $'zeta\tpack-zeta' $'alpha\tpack-alpha' >"$fixture/data/cpx-list"
printf '%s\n' '[{"name":"p1","source":"plugin","enabled":true},{"name":"p2","source":"plugin","enabled":true},{"name":"project","source":"project","enabled":true}]' >"$fixture/data/cpx-alpha-skills.json"
printf '%s\n' '[{"name":"zplugin","source":"plugin","enabled":true}]' >"$fixture/data/cpx-zeta-skills.json"

run_verifier() {
  set +e
  HOME="$fixture/home" \
  FAKE_COMMAND_LOG="$log" \
  FAKE_DATA="$fixture/data" \
  TRELLAGE_COPILOT_LIFECYCLE_BIN="$fixture/bin/cpx" \
  TMPDIR="$fixture/tmp" \
  PATH="$fixture/bin:$PATH" \
    scripts/verify-agent-profiles >"$fixture/output" 2>"$fixture/error"
  status=$?
  set -e
}

set +e
scripts/verify-agent-profiles unexpected >"$fixture/output" 2>"$fixture/error"
usage_status=$?
set -e
[[ "$usage_status" == 2 ]] || fail 'invalid arguments do not return usage status 2'
grep -Fq 'Usage: scripts/verify-agent-profiles [--live]' "$fixture/error" \
  || fail 'invalid arguments omit usage'

run_verifier
[[ "$status" == 0 ]] || fail 'healthy static verification failed'
cat >"$fixture/expected" <<'TABLE'
| Launcher | Profile | Package | Package skills | Visible skills | Sample | Static | Live |
|---|---|---|---:|---:|---|---|---|
| cpx | alpha | pack-alpha | 2 | 3 | p1, p2 | pass | not run |
| cpx | zeta | pack-zeta | 1 | 1 | zplugin | pass | not run |
TABLE
cmp -s "$fixture/expected" "$fixture/output" || fail 'static table does not match the Copilot contract'
grep -Fqx $'cpx\tlist' "$log" || fail 'profile discovery bypassed the lifecycle runtime'
grep -Fqx $'cpx\tdoctor\talpha' "$log" || fail 'profile health was not checked'
if grep -Eq $'\t(setup|repair|update|install|uninstall|login|logout)(\t|$)' "$log"; then
  fail 'static verification invoked a mutating lifecycle operation'
fi
[[ -z "$(find "$fixture/tmp" -mindepth 1 -print -quit)" ]] || fail 'static verification leaked temporary files'

: >"$fixture/data/fail-doctor-alpha"
run_verifier
[[ "$status" == 1 ]] || fail 'doctor failure did not fail verification'
grep -Fq '| cpx | alpha | pack-alpha | 2 | 3 | p1, p2 | fail: doctor command | not run |' "$fixture/output" \
  || fail 'doctor failure was not retained in its row'
grep -Fq 'cpx doctor failed for alpha (exit 65)' "$fixture/error" || fail 'doctor failure lacks a safe diagnostic'
! grep -Fq 'DOCTOR_SECRET_DO_NOT_LEAK' "$fixture/error" || fail 'doctor failure leaked command stderr'
rm "$fixture/data/fail-doctor-alpha"

printf '%s\n' $'alpha\tpack-alpha' $'alpha\tpack-alpha' >"$fixture/data/cpx-list"
run_verifier
[[ "$status" == 1 ]] || fail 'duplicate profile inventory was accepted'
grep -Fq 'duplicate cpx profile: alpha' "$fixture/error" || fail 'duplicate profile lacks a diagnostic'

# HUP must terminate the active live process group, reap its child, and remove temporary state.
printf '%s\n' $'alpha\tpack-alpha' >"$fixture/data/cpx-list"
hup_ready="$fixture/hup.ready"
hup_child_pid_file="$fixture/hup.child-pid"
set -m
HOME="$fixture/home" \
FAKE_COMMAND_LOG="$log" \
FAKE_DATA="$fixture/data" \
FAKE_HUP_READY_FILE="$hup_ready" \
FAKE_HUP_CHILD_PID_FILE="$hup_child_pid_file" \
TRELLAGE_COPILOT_LIFECYCLE_BIN="$fixture/bin/cpx" \
TMPDIR="$fixture/tmp" \
PATH="$fixture/bin:$PATH" \
  scripts/verify-agent-profiles --live >"$fixture/output" 2>"$fixture/error" &
verifier_pid=$!
set +m
for _ in {1..500}; do
  [[ -s "$hup_child_pid_file" && -e "$hup_ready" ]] && break
  sleep 0.01
done
[[ -s "$hup_child_pid_file" && -e "$hup_ready" ]] || fail 'HUP live probe never became ready'
hup_child_pid="$(cat "$hup_child_pid_file")"
kill -HUP "$verifier_pid"
set +e
wait "$verifier_pid"
hup_status=$?
set -e
[[ "$hup_status" == 129 ]] || fail "HUP returned $hup_status instead of 129"
if kill -0 "$hup_child_pid" 2>/dev/null; then fail 'HUP left the live child running'; fi
[[ -z "$(find "$fixture/tmp" -mindepth 1 -print -quit)" ]] || fail 'HUP left temporary artifacts'

printf 'agent profile matrix: PASS\n'
