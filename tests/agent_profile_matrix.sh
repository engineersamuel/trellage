#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

fail() {
  printf 'agent profile matrix: FAIL: %s\n' "$1" >&2
  exit 1
}

normalize_make_output() {
  sed -E 's/[[:space:]]+$//' | sed '/^$/d'
}

cleanup_phony_fixture() {
  local fixture="${phony_fixture:-}"
  local temp_root="${phony_temp_root:-}"
  [ -n "$fixture" ] && [ -n "$temp_root" ] || return 0
  [ "$fixture" != '/' ] && [ "$temp_root" != '/' ] && [ -d "$fixture" ] \
    || return 0
  case "$fixture/" in
    "$temp_root"/*) ;;
    *) return 0 ;;
  esac
  rm -rf -- "$fixture" || return 1
  phony_fixture=''
}

prepare_phony_fixture() {
  local requested_temp_root="${TMPDIR:-/tmp}"
  local canonical_temp_root
  local candidate
  local canonical_candidate

  phony_fixture=''
  phony_temp_root=''
  [ -n "$requested_temp_root" ] || return 1
  [ -d "$requested_temp_root" ] || return 1
  canonical_temp_root="$(cd -- "$requested_temp_root" && pwd -P)" || return 1
  [ -n "$canonical_temp_root" ] || return 1
  [ "$canonical_temp_root" != '/' ] || return 1

  if ! candidate="$(mktemp -d \
    "$canonical_temp_root/agent-profile-matrix.make.XXXXXX")"; then
    return 1
  fi
  [ -n "$candidate" ] || return 1
  [ -d "$candidate" ] || return 1
  canonical_candidate="$(cd -- "$candidate" && pwd -P)" || return 1
  [ -n "$canonical_candidate" ] || return 1
  [ "$canonical_candidate" != "$canonical_temp_root" ] || return 1
  case "$canonical_candidate/" in
    "$canonical_temp_root"/*) ;;
    *) return 1 ;;
  esac

  phony_temp_root="$canonical_temp_root"
  phony_fixture="$canonical_candidate"
  if ! cp -- Makefile "$phony_fixture/Makefile"; then
    return 1
  fi
  if ! : >"$phony_fixture/profile-matrix"; then
    return 1
  fi
  if ! : >"$phony_fixture/profile-matrix-test"; then
    return 1
  fi
}

if ! static_make_output="$(make --no-print-directory -n profile-matrix 2>&1)"; then
  fail 'Makefile does not expose the profile-matrix target'
fi
static_make_output="$(normalize_make_output <<<"$static_make_output")"
[ "$static_make_output" = 'scripts/verify-agent-profiles' ] \
  || fail "unexpected static profile-matrix recipe: $static_make_output"

if ! live_make_output="$(make --no-print-directory -n profile-matrix \
  PROFILE_MATRIX_ARGS=--live 2>&1)"; then
  fail 'profile-matrix target does not accept PROFILE_MATRIX_ARGS'
fi
live_make_output="$(normalize_make_output <<<"$live_make_output")"
[ "$live_make_output" = 'scripts/verify-agent-profiles --live' ] \
  || fail "unexpected live profile-matrix recipe: $live_make_output"

if ! test_make_output="$(make --no-print-directory -n profile-matrix-test 2>&1)"; then
  fail 'Makefile does not expose the profile-matrix-test target'
fi
test_make_output="$(normalize_make_output <<<"$test_make_output")"
[ "$test_make_output" = 'bash tests/agent_profile_matrix.sh' ] \
  || fail "unexpected profile-matrix-test recipe: $test_make_output"

set +e
(
  TMPDIR="$(dirname "$PWD")"
  mktemp() { printf '%s\n' "$PWD"; return 1; }
  cp() { exit 99; }
  prepare_phony_fixture
)
allocation_failure_status=$?
set -e
[ "$allocation_failure_status" -eq 1 ] \
  || fail 'phony fixture path use continued after allocation failure'

phony_fixture=''
phony_temp_root=''
trap cleanup_phony_fixture EXIT
if ! prepare_phony_fixture; then
  fail 'could not safely prepare the profile matrix phony fixture'
fi
if ! phony_make_output="$(make --no-print-directory -n -C "$phony_fixture" \
  profile-matrix profile-matrix-test 2>&1)"; then
  fail 'profile matrix phony-target probe failed'
fi
phony_make_output="$(normalize_make_output <<<"$phony_make_output")"
expected_phony_make_output=$'scripts/verify-agent-profiles\nbash tests/agent_profile_matrix.sh'
[ "$phony_make_output" = "$expected_phony_make_output" ] \
  || fail 'profile-matrix and profile-matrix-test are not both phony targets'
if ! cleanup_phony_fixture; then
  fail 'could not remove the profile matrix phony fixture'
fi
trap - EXIT

if ! default_test_make_output="$(make --no-print-directory -n test 2>&1)"; then
  fail 'default test dry-run failed'
fi
default_test_make_output="$(normalize_make_output <<<"$default_test_make_output")"
expected_default_test_make_output=$'bash tests/manifest_contract.sh\nbash tests/harness_contract.sh\nbash tests/agent_kit_adapter.sh\nbash tests/awesome_copilot_adapter.sh\nbash tests/copilot_agent_image.sh\nbash tests/harness_runner.sh\nbash tests/run_agent_session.sh\nbash tests/workspace_checks.sh\nbash tests/playwright_matrix.sh\nbash tests/evidence_contract.sh'
if grep -Fqx 'profile-compiler:' Makefile; then
  expected_default_test_make_output_with_claude=$'bash tests/publication_contract.sh\nbash tests/publication_contract_self_test.sh\nbash tests/agent_profile_hup_contract.sh\nbash tests/caveman_profile_contract.sh\ncd packages/trellage-cli && npm run lint && npm run format:check && npm run check && npm run build && npm test\nbash tests/trellage_identity_contract.sh\nbash tests/agent_harness_contract.sh\nbash prototypes/trellage/tests/claude_entry_contract.sh\nbash prototypes/trellage/tests/copilot_entry_contract.sh\nbash prototypes/trellage/tests/pi_entry_contract.sh\nbash prototypes/trellage-codex-profiles/tests/contract.sh\nbash prototypes/trellage-copilot-profiles/tests/contract.sh\nbash prototypes/trellage-grok-profiles/tests/contract.sh\nbash prototypes/trellage-jcode-profiles/tests/contract.sh\nbash prototypes/trellage-omp-profiles/tests/contract.sh\nbash prototypes/trellage-router/tests/contract.sh\n'"$expected_default_test_make_output"
  expected_default_test_make_output=$'bash tests/publication_contract.sh\nbash tests/publication_contract_self_test.sh\nbash tests/agent_profile_hup_contract.sh\nbash tests/caveman_profile_contract.sh\ncd packages/trellage-cli && npm run lint && npm run format:check && npm run check && npm run build && npm test\nbash tests/trellage_identity_contract.sh\nbash tests/agent_harness_contract.sh\nbash prototypes/trellage-codex-profiles/tests/contract.sh\nbash prototypes/trellage-copilot-profiles/tests/contract.sh\nbash prototypes/trellage-grok-profiles/tests/contract.sh\nbash prototypes/trellage-jcode-profiles/tests/contract.sh\nbash prototypes/trellage-omp-profiles/tests/contract.sh\nbash prototypes/trellage-router/tests/contract.sh\n'"$expected_default_test_make_output"
fi
if [ "$default_test_make_output" != "$expected_default_test_make_output" ] \
  && [ "$default_test_make_output" != "${expected_default_test_make_output_with_claude:-}" ]; then
  fail 'default test dry-run differs from the established dependency graph'
fi

readme_profile_matrix="$({
  awk '
    /^## Native Agent Profile Matrix$/ { in_section = 1; next }
    in_section && /^## / { exit }
    in_section { print }
  ' README.md
})"
[ -n "$readme_profile_matrix" ] \
  || fail 'README lacks the Native Agent Profile Matrix section'

for documented_command in \
  'scripts/verify-agent-profiles' \
  'scripts/verify-agent-profiles --live' \
  'make profile-matrix' \
  'make profile-matrix PROFILE_MATRIX_ARGS=--live' \
  'make profile-matrix-test'; do
  grep -Fxq "$documented_command" <<<"$readme_profile_matrix" \
    || fail "README lacks exact command: $documented_command"
done

for required_statement in \
  'Prerequisites are the installed commands `cdx`, `codex`, `cpx`, `grx`, and `jq`; profiles provisioned for each launcher; and authenticated CLI sessions. The standalone `jcx` launcher has its own contract and router integration but is not yet part of the plugin-oriented profile matrix. Live verification also requires paid model access.' \
  'Static mode performs native profile discovery plus non-inference health, inventory, and context validation. It never invokes a model.' \
  'All launchers are required; failures are not skips.' \
  'Live mode invokes every statically passing discovered profile, may consume paid model quota, and may create product-local telemetry or state where a CLI lacks ephemeral mode.' \
  'Codex discovery and static checks require the managed `cdx` launcher and its isolated profile roots under `~/.local/share/trellage/profiles/codex/<profile>/home`.' \
  'Codex live checks bypass managed `cdx` and invoke raw `codex` with the validated isolated `CODEX_HOME` plus ephemeral, read-only, approval-never arguments.' \
  'Static verification performs no native marketplace/plugin mutation or live prompt and never runs setup, repair, update, install, uninstall, login, or logout, but `cdx doctor` may atomically remove only exact Codex-generated project-trust stanzas during stale recovery.' \
  'Exit statuses:' \
  '- `0`: all required checks pass.' \
  '- `1`: a required launcher is missing, or discovery, static verification, or live verification fails.' \
  '- `2`: invalid usage.'; do
  grep -Fxq -- "$required_statement" <<<"$readme_profile_matrix" \
    || fail "README profile matrix section lacks statement: $required_statement"
done

if grep -Fqi 'discovery and inventory only' <<<"$readme_profile_matrix"; then
  fail 'README incorrectly limits static verification to discovery and inventory'
fi

real_jq="$(command -v jq)"
fixture_root="$(mktemp -d)"
output_file="$fixture_root/output"
error_file="$fixture_root/error"

cleanup_process_is_running() {
  local process_pid="$1"
  local process_state
  process_state="$(ps -o stat= -p "$process_pid" 2>/dev/null)" || return 1
  case "$process_state" in
    *Z*) return 1 ;;
  esac
  [ -n "$process_state" ]
}

cleanup_wait_for_verifier_exit_bounded() {
  local verifier_pid="$1"
  local cleanup_attempt
  for cleanup_attempt in {1..500}; do
    if ! cleanup_process_is_running "$verifier_pid"; then
      wait "$verifier_pid" 2>/dev/null || true
      return 0
    fi
    sleep 0.01
  done
  return 1
}

cleanup() {
  local cleanup_status=$?
  local cleanup_pid
  trap - EXIT HUP INT TERM
  if [ -n "${verifier_under_signal_pid:-}" ] \
    && [[ "$verifier_under_signal_pid" =~ ^[1-9][0-9]*$ ]] \
    && [ "$verifier_under_signal_pid" -ne "$$" ]; then
    kill -TERM -- "-$verifier_under_signal_pid" 2>/dev/null || true
    if ! cleanup_wait_for_verifier_exit_bounded "$verifier_under_signal_pid"; then
      kill -KILL -- "-$verifier_under_signal_pid" 2>/dev/null || true
      cleanup_wait_for_verifier_exit_bounded "$verifier_under_signal_pid" || true
    fi
  fi
  for cleanup_pid in ${signal_tree_pids:-}; do
    if [[ "$cleanup_pid" =~ ^[1-9][0-9]*$ ]]; then
      kill -KILL "$cleanup_pid" 2>/dev/null || true
    fi
  done
  rm -rf "$fixture_root"
  exit "$cleanup_status"
}
trap cleanup EXIT

set +e
scripts/verify-agent-profiles unexpected >"$output_file" 2>"$error_file"
status=$?
set -e

[ "$status" -eq 2 ] || fail "usage error returned $status instead of 2"
grep -Fq 'Usage: scripts/verify-agent-profiles' "$error_file" \
  || fail 'usage error did not print usage to stderr'

if grep -Eq 'cut -f1 .*\| grep -F[x]?q' scripts/verify-agent-profiles; then
  fail 'duplicate detection uses an early-closing cut/grep pipeline'
fi

fixture_home="$fixture_root/home"
fixture_codex_home="$fixture_root/codex-home"
fixture_bin="$fixture_root/bin"
fixture_core_bin="$fixture_root/core-bin"
fixture_data="$fixture_root/data"
fixture_tmp="$fixture_root/tmp"
command_log="$fixture_root/commands.log"
mkdir -p "$fixture_home" "$fixture_codex_home" "$fixture_bin" "$fixture_core_bin" "$fixture_data" "$fixture_tmp"
: >"$command_log"
: >"$fixture_codex_home/ignored.config.toml"
mkdir -p \
  "$fixture_home/.local/share/trellage/profiles/codex/hve/home" \
  "$fixture_home/.local/share/trellage/profiles/codex/superpowers/home"

cat >"$fixture_bin/cdx" <<'FAKE_CDX'
#!/usr/bin/env bash
set -euo pipefail
printf 'cdx' >>"$FAKE_COMMAND_LOG"
printf '\t%s' "$@" >>"$FAKE_COMMAND_LOG"
printf '\n' >>"$FAKE_COMMAND_LOG"
if [ "$#" -eq 1 ] && [ "$1" = 'list' ]; then
  [ ! -f "$FAKE_DATA/fail-cdx-list" ] || exit 65
  cat "$FAKE_DATA/cdx-list"
elif [ "$#" -eq 2 ] && [ "$1" = 'doctor' ]; then
  [ ! -f "$FAKE_DATA/fail-cdx-doctor-$2" ] || {
    printf 'CDX_DOCTOR_SECRET_DO_NOT_LEAK\n' >&2
    exit 65
  }
  printf '%s: healthy\n' "$2"
elif [ "$#" -eq 4 ] && [ "$2" = 'debug' ] \
  && [ "$3" = 'prompt-input' ] && [ "$4" = 'profile verification' ]; then
  if [ "${FAKE_BLOCK_STATIC:-}" = "cdx-$1" ]; then
    : >"$FAKE_STATIC_READY_FILE"
    static_released=0
    for static_attempt in {1..500}; do
      if [ -f "$FAKE_STATIC_RELEASE_FILE" ]; then
        static_released=1
        break
      fi
      sleep 0.01
    done
    [ "$static_released" -eq 1 ] || exit 124
  fi
  [ ! -f "$FAKE_DATA/fail-cdx-$1" ] || {
    printf 'CDX_COMMAND_SECRET_DO_NOT_LEAK\n' >&2
    exit 65
  }
  cat "$FAKE_DATA/codex-$1.json"
else
  exit 64
fi
FAKE_CDX

cat >"$fixture_bin/codex" <<'FAKE_CODEX'
#!/usr/bin/env bash
set -euo pipefail
printf 'codex' >>"$FAKE_COMMAND_LOG"
printf '\t%s' "$@" >>"$FAKE_COMMAND_LOG"
printf '\n' >>"$FAKE_COMMAND_LOG"
profile_root="${CODEX_HOME%/home}"
profile="${profile_root##*/}"
expected_home="$HOME/.local/share/trellage/profiles/codex/$profile/home"
if [ "$CODEX_HOME" != "$expected_home" ]; then
  exit 63
elif [ "$#" -eq 12 ] && [ "$1" = 'exec' ] \
  && [ "$2" = '--ephemeral' ] && [ "$3" = '--sandbox' ] && [ "$4" = 'read-only' ] \
  && [ "$5" = '--config' ] && [ "$6" = 'approval_policy="never"' ] \
  && [ "$7" = '--output-schema' ] && [ "$9" = '--json' ] \
  && [ "${10}" = '--output-last-message' ] && [ "${12}" = '-' ]; then
  cat >/dev/null
  [ ! -f "$FAKE_DATA/fail-live-codex-$profile" ] || {
    printf 'LIVE_CODEX_SECRET_DO_NOT_LEAK\n' >&2
    exit 65
  }
  if [ "${FAKE_BLOCK_LIVE:-}" = "codex-$profile" ]; then
    printf '%s\n' "$$" >"$FAKE_PID_FILE"
    : >"$FAKE_READY_FILE"
    trap 'exit 143' TERM
    while :; do :; done
  fi
  if [ "${FAKE_EXIT_WITH_SURVIVOR:-}" = "codex-$profile" ]; then
    "$FAKE_TERM_IGNORER" &
    survivor_ready=0
    for survivor_attempt in {1..500}; do
      if [ -f "$FAKE_READY_FILE" ] && [ -s "$FAKE_IGNORER_PID_FILE" ]; then
        survivor_ready=1
        break
      fi
      sleep 0.01
    done
    [ "$survivor_ready" -eq 1 ] || exit 124
    [ "${FAKE_SURVIVOR_EXIT_STATUS:-0}" -eq 0 ] \
      || exit "$FAKE_SURVIVOR_EXIT_STATUS"
  fi
  cat "$FAKE_DATA/codex-$profile-live-events.jsonl"
  cat "$FAKE_DATA/codex-$profile-live.json" >"${11}"
else
  exit 64
fi
FAKE_CODEX

cat >"$fixture_bin/cpx" <<'FAKE_CPX'
#!/usr/bin/env bash
set -euo pipefail
printf 'cpx' >>"$FAKE_COMMAND_LOG"
printf '\t%s' "$@" >>"$FAKE_COMMAND_LOG"
printf '\n' >>"$FAKE_COMMAND_LOG"
if [ "$#" -eq 1 ] && [ "$1" = 'list' ]; then
  [ ! -f "$FAKE_DATA/fail-cpx-list" ] || exit 65
  cat "$FAKE_DATA/cpx-list"
elif [ "$#" -eq 2 ] && [ "$1" = 'doctor' ]; then
    [ ! -f "$FAKE_DATA/fail-cpx-doctor-$2" ] || {
      printf 'CPX_COMMAND_SECRET_DO_NOT_LEAK\n' >&2
      exit 65
    }
    printf '%s: healthy\n' "$2"
elif [ "$#" -eq 3 ] && [ "$2" = 'plugin' ] && [ "$3" = 'list' ]; then
    [ ! -f "$FAKE_DATA/fail-cpx-plugin-$1" ] || {
      printf 'CPX_PLUGIN_LIST_SECRET_DO_NOT_LEAK\n' >&2
      exit 65
    }
    cat "$FAKE_DATA/cpx-$1-plugins"
elif [ "$#" -eq 4 ] && [ "$2" = 'skill' ] && [ "$3" = 'list' ] && [ "$4" = '--json' ]; then
    [ ! -f "$FAKE_DATA/fail-cpx-skills-$1" ] || {
      printf 'CPX_SKILL_LIST_SECRET_DO_NOT_LEAK\n' >&2
      exit 65
    }
    cat "$FAKE_DATA/cpx-$1-skills.json"
elif [ "$#" -eq 13 ] && [ "$2" = '--prompt' ] && [ "$4" = '--output-format' ] \
  && [ "$5" = 'json' ] && [ "$6" = '--no-ask-user' ] \
  && [ "$7" = '--disable-builtin-mcps' ] && [ "$8" = '--available-tools=' ] \
  && [ "$9" = '--no-remote' ] && [ "${10}" = '--no-remote-export' ] \
  && [ "${11}" = '--no-auto-update' ] && [ "${12}" = '--stream' ] && [ "${13}" = 'off' ]; then
    [ ! -f "$FAKE_DATA/fail-live-cpx-$1" ] || {
      printf 'LIVE_CPX_SECRET_DO_NOT_LEAK\n' >&2
      exit 65
    }
    if [ "${FAKE_BLOCK_LIVE:-}" = "cpx-$1" ]; then
      trap 'exit 143' TERM
      printf '%s\n' "$$" >"$FAKE_PID_FILE"
      "$FAKE_TREE_CHILD" &
      wait "$!"
    fi
    if [ "${FAKE_EXIT_WITH_SURVIVOR:-}" = "cpx-$1" ]; then
      "$FAKE_TERM_IGNORER" &
      survivor_ready=0
      for survivor_attempt in {1..500}; do
        if [ -f "$FAKE_READY_FILE" ] && [ -s "$FAKE_IGNORER_PID_FILE" ]; then
          survivor_ready=1
          break
        fi
        sleep 0.01
      done
      [ "$survivor_ready" -eq 1 ] || exit 124
      [ "${FAKE_SURVIVOR_EXIT_STATUS:-0}" -eq 0 ] \
        || exit "$FAKE_SURVIVOR_EXIT_STATUS"
    fi
    cat "$FAKE_DATA/cpx-$1-live.jsonl"
else
  exit 64
fi
FAKE_CPX

cat >"$fixture_bin/grx" <<'FAKE_GRX'
#!/usr/bin/env bash
set -euo pipefail
printf 'grx' >>"$FAKE_COMMAND_LOG"
printf '\t%s' "$@" >>"$FAKE_COMMAND_LOG"
printf '\n' >>"$FAKE_COMMAND_LOG"
if [ "$#" -eq 1 ] && [ "$1" = 'list' ]; then
    [ ! -f "$FAKE_DATA/fail-grx-list" ] || {
      printf 'GRX_LIST_SECRET_DO_NOT_LEAK\n' >&2
      exit 65
    }
    cat "$FAKE_DATA/grx-list"
elif [ "$#" -eq 2 ] && [ "$1" = 'doctor' ]; then
    [ ! -f "$FAKE_DATA/fail-grx-doctor-$2" ] || {
      printf 'GRX_DOCTOR_SECRET_DO_NOT_LEAK\n' >&2
      exit 65
    }
    printf '%s: healthy\n' "$2"
elif [ "$#" -eq 3 ] && [ "$2" = 'inspect' ] && [ "$3" = '--json' ]; then
    [ ! -f "$FAKE_DATA/fail-grx-inspect-$1" ] || {
      printf 'GRX_COMMAND_SECRET_DO_NOT_LEAK\n' >&2
      exit 65
    }
    cat "$FAKE_DATA/grx-$1-inspect.json"
elif [ "$#" -eq 18 ] && [ "$2" = '--single' ] && [ "$4" = '--json-schema' ] \
  && [ "$6" = '--output-format' ] && [ "$7" = 'json' ] \
  && [ "$8" = '--no-subagents' ] && [ "$9" = '--tools' ] && [ -z "${10}" ] \
  && [ "${11}" = '--deny' ] && [ "${12}" = 'MCPTool' ] \
  && [ "${13}" = '--disable-web-search' ] && [ "${14}" = '--max-turns' ] \
  && [ "${15}" = '1' ] && [ "${16}" = '--no-memory' ] \
  && [ "${17}" = '--permission-mode' ] && [ "${18}" = 'dontAsk' ]; then
    [ ! -f "$FAKE_DATA/fail-live-grx-$1" ] || {
      printf 'LIVE_GRX_SECRET_DO_NOT_LEAK\n' >&2
      exit 65
    }
    if [ "${FAKE_BLOCK_LIVE:-}" = "grx-$1" ]; then
      trap 'exit 143' TERM
      printf '%s\n' "$$" >"$FAKE_PID_FILE"
      "$FAKE_TREE_CHILD" &
      wait "$!"
    fi
    if [ "${FAKE_EXIT_WITH_SURVIVOR:-}" = "grx-$1" ]; then
      "$FAKE_TERM_IGNORER" &
      survivor_ready=0
      for survivor_attempt in {1..500}; do
        if [ -f "$FAKE_READY_FILE" ] && [ -s "$FAKE_IGNORER_PID_FILE" ]; then
          survivor_ready=1
          break
        fi
        sleep 0.01
      done
      [ "$survivor_ready" -eq 1 ] || exit 124
      [ "${FAKE_SURVIVOR_EXIT_STATUS:-0}" -eq 0 ] \
        || exit "$FAKE_SURVIVOR_EXIT_STATUS"
    fi
    cat "$FAKE_DATA/grx-$1-live.json"
else
  exit 64
fi
FAKE_GRX

cat >"$fixture_bin/fake-live-descendant" <<'FAKE_LIVE_DESCENDANT'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$$" >"$FAKE_DESCENDANT_PID_FILE"
"$FAKE_TERM_IGNORER" &
wait "$!"
FAKE_LIVE_DESCENDANT

cat >"$fixture_bin/fake-term-ignorer" <<'FAKE_TERM_IGNORER'
#!/usr/bin/env bash
set -euo pipefail
trap '' TERM
printf '%s\n' "$$" >"$FAKE_IGNORER_PID_FILE"
: >"$FAKE_READY_FILE"
while :; do :; done
FAKE_TERM_IGNORER

chmod 0755 "$fixture_bin/cdx" "$fixture_bin/codex" "$fixture_bin/cpx" "$fixture_bin/grx" \
  "$fixture_bin/fake-live-descendant" "$fixture_bin/fake-term-ignorer"
ln -s "$real_jq" "$fixture_bin/jq"
for core_command in bash mktemp rm cut grep sort awk head cat sleep; do
  ln -s "$(command -v "$core_command")" "$fixture_core_bin/$core_command"
done

printf '%s\n' $'zeta\tpack-zeta' $'alpha\tpack-alpha' >"$fixture_data/cpx-list"
printf '%s\n' \
  $'hve\thve-core-all@hve-core' \
  $'superpowers\tsuperpowers@superpowers-marketplace' >"$fixture_data/cdx-list"
printf '%s\n' $'hve\thve-plugin' $'awesome\tawesome-plugin' >"$fixture_data/grx-list"
printf '%s\n' 'Installed plugins:' '  • pack-alpha (v1)' >"$fixture_data/cpx-alpha-plugins"
printf '%s\n' 'Installed plugins:' '  • pack-zeta (v1)' >"$fixture_data/cpx-zeta-plugins"

"$real_jq" -cn --arg text $'prefix\n### Available skills\n- skillb: B (file: /b)\n- skilla: A (file: /a)\n### Skill roots\nsuffix' \
  '[{type:"message",role:"developer",content:[{type:"input_text",text:$text}]}]' \
  >"$fixture_data/codex-hve.json"
"$real_jq" -cn --arg text $'### Available skills\n- zskill: Z (file: /z)\n### End' \
  '[{type:"message",role:"developer",content:[{type:"input_text",text:$text}]}]' \
  >"$fixture_data/codex-superpowers.json"
"$real_jq" -cn '[
  {name:"p6",source:"plugin",enabled:true}, {name:"p5",source:"plugin",enabled:true},
  {name:"p4",source:"plugin",enabled:true}, {name:"p3",source:"plugin",enabled:true},
  {name:"p2",source:"plugin",enabled:true}, {name:"p1",source:"plugin",enabled:true},
  {name:"projectskill",source:"project",enabled:true}
]' >"$fixture_data/cpx-alpha-skills.json"
"$real_jq" -cn '[
  {name:"zplugin",source:"plugin",enabled:true},
  {name:"hidden",source:"project",enabled:false}
]' >"$fixture_data/cpx-zeta-skills.json"
"$real_jq" -cn '{
  plugins:[{name:"awesome-plugin",enabled:true}],
  skills:[{name:"projectonly",source:{type:"project",path:"/fixture"}}]
}' >"$fixture_data/grx-awesome-inspect.json"
"$real_jq" -cn '{
  plugins:[{name:"hve-plugin",enabled:true}],
  skills:[
    {name:"h6",source:{type:"plugin",plugin_name:"hve-plugin"}},
    {name:"h5",source:{type:"plugin",plugin_name:"hve-plugin"}},
    {name:"h4",source:{type:"plugin",plugin_name:"hve-plugin"}},
    {name:"h3",source:{type:"plugin",plugin_name:"hve-plugin"}},
    {name:"h2",source:{type:"plugin",plugin_name:"hve-plugin"}},
    {name:"h1",source:{type:"plugin",plugin_name:"hve-plugin"}},
    {name:"repo",source:{type:"project",path:"/fixture"}}
  ]
}' >"$fixture_data/grx-hve-inspect.json"

for live_profile in hve superpowers; do
  printf '%s\n' '{"type":"thread.started"}' >"$fixture_data/codex-$live_profile-live-events.jsonl"
done
"$real_jq" -cn '{launcher:"cdx",profile:"hve",skills:["skilla","skillb"],emptyPackageConfirmed:false}' \
  >"$fixture_data/codex-hve-live.json"
"$real_jq" -cn '{launcher:"cdx",profile:"superpowers",skills:["zskill"],emptyPackageConfirmed:false}' \
  >"$fixture_data/codex-superpowers-live.json"
"$real_jq" -cn --arg content \
  '{"launcher":"cpx","profile":"alpha","skills":["p1","p2","p3","p4","p5"],"emptyPackageConfirmed":false}' \
  '{type:"assistant.message",data:{content:$content}}' >"$fixture_data/cpx-alpha-live.jsonl"
"$real_jq" -cn --arg content \
  '{"launcher":"cpx","profile":"zeta","skills":["zplugin"],"emptyPackageConfirmed":false}' \
  '{type:"assistant.message",data:{content:$content}}' >"$fixture_data/cpx-zeta-live.jsonl"
"$real_jq" -cn '{launcher:"grx",profile:"awesome",skills:[],emptyPackageConfirmed:true}' \
  >"$fixture_data/grx-awesome-live.json"
"$real_jq" -cn '{launcher:"grx",profile:"hve",skills:["h1","h2","h3","h4","h5"],emptyPackageConfirmed:false}' \
  >"$fixture_data/grx-hve-live.json"

restricted_path="$fixture_bin:$fixture_core_bin"

set +e
FAKE_COMMAND_LOG="$command_log" FAKE_DATA="$fixture_data" \
  "$fixture_bin/cpx" doctor alpha extra >/dev/null 2>&1
poison_cpx_status=$?
FAKE_COMMAND_LOG="$command_log" FAKE_DATA="$fixture_data" \
  "$fixture_bin/grx" doctor hve extra >/dev/null 2>&1
poison_grx_status=$?
FAKE_COMMAND_LOG="$command_log" FAKE_DATA="$fixture_data" \
  "$fixture_bin/cpx" setup alpha >/dev/null 2>&1
poison_cpx_lifecycle_status=$?
FAKE_COMMAND_LOG="$command_log" FAKE_DATA="$fixture_data" \
  "$fixture_bin/grx" repair hve >/dev/null 2>&1
poison_grx_lifecycle_status=$?
set -e
[ "$poison_cpx_status" -ne 0 ] || fail 'fake cpx accepted an extra doctor argument'
[ "$poison_grx_status" -ne 0 ] || fail 'fake grx accepted an extra doctor argument'
[ "$poison_cpx_lifecycle_status" -ne 0 ] || fail 'fake cpx accepted a lifecycle command'
[ "$poison_grx_lifecycle_status" -ne 0 ] || fail 'fake grx accepted a lifecycle command'
: >"$command_log"

run_matrix() {
  local selected_codex_home="${1:-$fixture_codex_home}"
  set +e
  HOME="$fixture_home" \
  CODEX_HOME="$selected_codex_home" \
  FAKE_COMMAND_LOG="$command_log" \
  FAKE_DATA="$fixture_data" \
  FAKE_BLOCK_LIVE="${FAKE_BLOCK_LIVE:-}" \
  FAKE_READY_FILE="${FAKE_READY_FILE:-}" \
  FAKE_PID_FILE="${FAKE_PID_FILE:-}" \
  FAKE_TREE_CHILD="$fixture_bin/fake-live-descendant" \
  FAKE_TERM_IGNORER="$fixture_bin/fake-term-ignorer" \
  FAKE_DESCENDANT_PID_FILE="${FAKE_DESCENDANT_PID_FILE:-}" \
  FAKE_IGNORER_PID_FILE="${FAKE_IGNORER_PID_FILE:-}" \
  TMPDIR="$fixture_tmp" \
  PATH="$restricted_path" \
    scripts/verify-agent-profiles >"$output_file" 2>"$error_file"
  matrix_status=$?
  set -e
}

run_live_matrix() {
  set +e
  HOME="$fixture_home" \
  CODEX_HOME="$fixture_codex_home" \
  FAKE_COMMAND_LOG="$command_log" \
  FAKE_DATA="$fixture_data" \
  FAKE_BLOCK_LIVE="${FAKE_BLOCK_LIVE:-}" \
  FAKE_READY_FILE="${FAKE_READY_FILE:-}" \
  FAKE_PID_FILE="${FAKE_PID_FILE:-}" \
  FAKE_TREE_CHILD="$fixture_bin/fake-live-descendant" \
  FAKE_TERM_IGNORER="$fixture_bin/fake-term-ignorer" \
  FAKE_DESCENDANT_PID_FILE="${FAKE_DESCENDANT_PID_FILE:-}" \
  FAKE_IGNORER_PID_FILE="${FAKE_IGNORER_PID_FILE:-}" \
  FAKE_EXIT_WITH_SURVIVOR="${FAKE_EXIT_WITH_SURVIVOR:-}" \
  FAKE_SURVIVOR_EXIT_STATUS="${FAKE_SURVIVOR_EXIT_STATUS:-}" \
  TMPDIR="$fixture_tmp" \
  PATH="$restricted_path" \
    scripts/verify-agent-profiles --live >"$output_file" 2>"$error_file"
  matrix_status=$?
  set -e
}

write_cpx_live() {
  local profile="$1"
  local content="$2"
  "$real_jq" -cn --arg content "$content" \
    '{type:"assistant.message",data:{content:$content}}' \
    >"$fixture_data/cpx-$profile-live.jsonl"
}

process_is_running() {
  local process_pid="$1"
  local process_state
  [[ "$process_pid" =~ ^[1-9][0-9]*$ ]] || return 1
  process_state="$(ps -o stat= -p "$process_pid" 2>/dev/null)" || return 1
  case "$process_state" in
    *Z*) return 1 ;;
  esac
  [ -n "$process_state" ]
}

wait_for_verifier_exit_bounded() {
  local verifier_pid="$1"
  local wait_attempt
  for wait_attempt in {1..500}; do
    if ! process_is_running "$verifier_pid"; then
      set +e
      wait "$verifier_pid"
      bounded_wait_status=$?
      set -e
      return 0
    fi
    sleep 0.01
  done
  return 1
}

kill_tree_fixture_bounded() {
  local tree_pid
  local kill_attempt
  for tree_pid in $1; do
    if [[ "$tree_pid" =~ ^[1-9][0-9]*$ ]]; then
      kill -KILL "$tree_pid" 2>/dev/null || true
    fi
  done
  for kill_attempt in {1..500}; do
    tree_fixture_running=0
    for tree_pid in $1; do
      if process_is_running "$tree_pid"; then
        tree_fixture_running=1
      fi
    done
    [ "$tree_fixture_running" -eq 0 ] && return 0
    sleep 0.01
  done
  return 1
}

stop_verifier_fixture_bounded() {
  local verifier_pid="$1"
  [[ "$verifier_pid" =~ ^[1-9][0-9]*$ ]] || return 1
  [ "$verifier_pid" -ne "$$" ] || return 1
  if process_is_running "$verifier_pid"; then
    kill -TERM -- "-$verifier_pid" 2>/dev/null || true
    if wait_for_verifier_exit_bounded "$verifier_pid"; then
      return 0
    fi
    kill -KILL -- "-$verifier_pid" 2>/dev/null || true
  fi
  wait_for_verifier_exit_bounded "$verifier_pid"
}

# The private timeout override is live-only and accepts bounded integers.
set +e
HOME="$fixture_home" \
CODEX_HOME="$fixture_codex_home" \
FAKE_COMMAND_LOG="$command_log" \
FAKE_DATA="$fixture_data" \
_VERIFY_AGENT_PROFILES_LIVE_TIMEOUT_SECONDS=0 \
TMPDIR="$fixture_tmp" \
PATH="$restricted_path" \
  scripts/verify-agent-profiles --live >"$output_file" 2>"$error_file"
invalid_timeout_status=$?
set -e
[ "$invalid_timeout_status" -eq 1 ] \
  || fail "invalid live timeout returned $invalid_timeout_status instead of 1"
grep -Fq 'verify-agent-profiles: invalid internal live timeout setting' "$error_file" \
  || fail 'invalid live timeout omitted its safe diagnostic'
[ ! -s "$command_log" ] || fail 'invalid live timeout invoked an adapter'
[ -z "$(find "$fixture_tmp" -mindepth 1 -print -quit)" ] \
  || fail 'invalid live timeout created temporary artifacts'

# A per-probe deadline terminates the owned group and continues later rows.
timeout_ready="$fixture_root/live-timeout.ready"
timeout_pid_file="$fixture_root/live-timeout.pid"
rm -f "$timeout_ready" "$timeout_pid_file"
set -m
FAKE_BLOCK_LIVE='codex-hve' \
FAKE_READY_FILE="$timeout_ready" \
FAKE_PID_FILE="$timeout_pid_file" \
HOME="$fixture_home" \
CODEX_HOME="$fixture_codex_home" \
FAKE_COMMAND_LOG="$command_log" \
FAKE_DATA="$fixture_data" \
_VERIFY_AGENT_PROFILES_LIVE_TIMEOUT_SECONDS=1 \
TMPDIR="$fixture_tmp" \
PATH="$restricted_path" \
  scripts/verify-agent-profiles --live >"$output_file" 2>"$error_file" &
verifier_under_signal_pid=$!
set +m
if wait_for_verifier_exit_bounded "$verifier_under_signal_pid"; then
  timeout_verifier_status="$bounded_wait_status"
else
  stop_verifier_fixture_bounded "$verifier_under_signal_pid" \
    || fail 'timed-out verifier fixture could not be cleaned safely'
  verifier_under_signal_pid=''
  fail 'live probe deadline was unavailable'
fi
verifier_under_signal_pid=''
[ "$timeout_verifier_status" -eq 1 ] \
  || fail "timed-out live verifier returned $timeout_verifier_status instead of 1"
[ -s "$timeout_pid_file" ] || fail 'timed-out live probe never started'
timeout_child_pid="$(cat "$timeout_pid_file")"
grep -Fq '| cdx | hve | hve-core-all@hve-core | n/a | 2 | skilla, skillb | pass | fail: timeout |' "$output_file" \
  || fail 'timed-out live probe did not fail its row distinctly'
grep -Fq '| cdx | superpowers | superpowers@superpowers-marketplace | n/a | 1 | zskill | pass | pass |' "$output_file" \
  || fail 'timed-out live probe stopped a later profile'
grep -Fq 'verify-agent-profiles: codex live probe timed out for hve' "$error_file" \
  || fail 'timed-out live probe omitted its safe diagnostic'
if process_is_running "$timeout_child_pid"; then
  fail 'timed-out live probe left its launcher running'
fi
[ -z "$(find "$fixture_tmp" -mindepth 1 -print -quit)" ] \
  || fail 'timed-out live probe left temporary artifacts'
: >"$command_log"

# Successful and failed launchers cannot leave owned descendants behind.
for survivor_case in \
  'codex hve 0 cdx cdx superpowers' 'codex hve 65 cdx cdx superpowers' \
  'cpx alpha 0 cpx cpx zeta' 'cpx alpha 65 cpx cpx zeta' \
  'grx awesome 0 grx grx hve' 'grx awesome 65 grx grx hve'; do
  read -r survivor_adapter survivor_profile survivor_exit \
    survivor_row_adapter survivor_later_adapter survivor_later_profile \
    <<<"$survivor_case"
  survivor_ready="$fixture_root/survivor-$survivor_adapter-$survivor_exit.ready"
  survivor_pid_file="$fixture_root/survivor-$survivor_adapter-$survivor_exit.pid"
  rm -f "$survivor_ready" "$survivor_pid_file"
  FAKE_EXIT_WITH_SURVIVOR="$survivor_adapter-$survivor_profile"
  FAKE_SURVIVOR_EXIT_STATUS="$survivor_exit"
  FAKE_READY_FILE="$survivor_ready"
  FAKE_IGNORER_PID_FILE="$survivor_pid_file"
  run_live_matrix
  FAKE_EXIT_WITH_SURVIVOR=''
  FAKE_SURVIVOR_EXIT_STATUS=''
  FAKE_READY_FILE=''
  FAKE_IGNORER_PID_FILE=''
  [ -s "$survivor_pid_file" ] \
    || fail "$survivor_adapter survivor fixture did not start"
  survivor_pid="$(cat "$survivor_pid_file")"
  signal_tree_pids="$survivor_pid"
  if process_is_running "$survivor_pid"; then
    fail "$survivor_adapter exit $survivor_exit left its descendant running"
  fi
  signal_tree_pids=''
  if [ "$survivor_exit" -eq 0 ]; then
    [ "$matrix_status" -eq 0 ] \
      || fail "$survivor_adapter successful launcher survivor changed final status"
    grep -Fq "| $survivor_later_adapter | $survivor_later_profile |" "$output_file" \
      || fail "$survivor_adapter successful launcher stopped a later row"
    grep -F "| $survivor_row_adapter | $survivor_profile |" "$output_file" \
      | grep -Fq '| pass | pass |' \
      || fail "$survivor_adapter successful launcher did not preserve evidence"
  else
    [ "$matrix_status" -eq 1 ] \
      || fail "$survivor_adapter failed launcher survivor returned success"
    grep -F "| $survivor_row_adapter | $survivor_profile |" "$output_file" \
      | grep -Fq '| pass | fail: command |' \
      || fail "$survivor_adapter failed launcher did not preserve its exit result"
    grep -F "| $survivor_later_adapter | $survivor_later_profile |" "$output_file" \
      | grep -Fq '| pass | pass |' \
      || fail "$survivor_adapter failed launcher stopped a later row"
  fi
  [ -z "$(find "$fixture_tmp" -mindepth 1 -print -quit)" ] \
    || fail "$survivor_adapter survivor cleanup left temporary artifacts"
done
: >"$command_log"

run_matrix
[ "$matrix_status" -eq 0 ] || fail 'happy-path matrix returned nonzero'

expected_table="$fixture_root/expected-table"
cat >"$expected_table" <<'TABLE'
| Launcher | Profile | Package | Package skills | Visible skills | Sample | Static | Live |
|---|---|---|---:|---:|---|---|---|
| cdx | hve | hve-core-all@hve-core | n/a | 2 | skilla, skillb | pass | not run |
| cdx | superpowers | superpowers@superpowers-marketplace | n/a | 1 | zskill | pass | not run |
| cpx | alpha | pack-alpha | 6 | 7 | p1, p2, p3, p4, p5 | pass | not run |
| cpx | zeta | pack-zeta | 1 | 1 | zplugin | pass | not run |
| grx | awesome | awesome-plugin | 0 | 1 |  | pass | not run |
| grx | hve | hve-plugin | 6 | 7 | h1, h2, h3, h4, h5 | pass | not run |
TABLE
cmp -s "$expected_table" "$output_file" || {
  diff -u "$expected_table" "$output_file" >&2 || true
  fail 'happy-path matrix did not match the shared table contract'
}

grep -Fqx $'cdx\tlist' "$command_log" \
  || fail 'managed Codex profiles were not discovered through cdx list'
grep -Fqx $'cdx\tdoctor\thve' "$command_log" \
  || fail 'managed Codex hve profile was not checked through cdx doctor'
grep -Fqx $'cdx\thve\tdebug\tprompt-input\tprofile verification' "$command_log" \
  || fail 'managed Codex hve profile was not verified through prompt-input'
grep -Fqx $'cpx\tdoctor\talpha' "$command_log" || fail 'Copilot doctor was not called'
grep -Fqx $'grx\tdoctor\thve' "$command_log" || fail 'Grok doctor was not called'
awk -F '\t' '
  $1 == "cdx" && NF == 2 && $2 == "list" { next }
  $1 == "cdx" && NF == 3 && $2 == "doctor" { next }
  $1 == "cdx" && NF == 5 && $3 == "debug" \
    && $4 == "prompt-input" && $5 == "profile verification" { next }
  $1 == "cpx" && NF == 2 && $2 == "list" { next }
  $1 == "cpx" && NF == 3 && $2 == "doctor" { next }
  $1 == "cpx" && NF == 4 && $3 == "plugin" && $4 == "list" { next }
  $1 == "cpx" && NF == 5 && $3 == "skill" && $4 == "list" && $5 == "--json" { next }
  $1 == "grx" && NF == 2 && $2 == "list" { next }
  $1 == "grx" && NF == 3 && $2 == "doctor" { next }
  $1 == "grx" && NF == 4 && $3 == "inspect" && $4 == "--json" { next }
  { invalid = 1 }
  END { exit invalid }
' "$command_log" || fail 'verifier invoked a launcher with an unexpected command shape'
if grep -Eq $'\t(setup|repair|update|install|uninstall|login|logout)(\t|$)' "$command_log"; then
  fail 'verifier invoked a forbidden lifecycle command'
fi
if grep -Eq $'\t(-p|--prompt|exec|resume)\t' "$command_log"; then
  fail 'default verification invoked a model command'
fi
[ -z "$(find "$fixture_tmp" -mindepth 1 -print -quit)" ] \
  || fail 'temporary artifacts remained after successful verification'

cp "$fixture_data/cpx-list" "$fixture_data/cpx-list.good"
cp "$fixture_data/cpx-alpha-plugins" "$fixture_data/cpx-alpha-plugins.good"
cp "$fixture_data/cpx-alpha-skills.json" "$fixture_data/cpx-alpha-skills.good.json"
cp "$fixture_data/grx-list" "$fixture_data/grx-list.good"
cp "$fixture_data/grx-hve-inspect.json" "$fixture_data/grx-hve-inspect.good.json"
cp "$fixture_data/cdx-list" "$fixture_data/cdx-list.good"
cp "$fixture_data/codex-hve.json" "$fixture_data/codex-hve.good.json"

# Every dynamic cell is Markdown-safe.
printf '%s\n' $'alpha\tpack&copy;~alpha*beta|bundle' $'zeta\tpack-zeta' >"$fixture_data/cpx-list"
printf '%s\n' 'Installed plugins:' '  • pack&copy;~alpha*beta|bundle (v1)' >"$fixture_data/cpx-alpha-plugins"
run_matrix
[ "$matrix_status" -eq 0 ] || fail 'Markdown escaping fixture returned nonzero'
grep -Fq 'pack\&copy;\~alpha\*beta\|bundle' "$output_file" \
  || fail 'Markdown metacharacters were not escaped in a table cell'
cp "$fixture_data/cpx-list.good" "$fixture_data/cpx-list"
cp "$fixture_data/cpx-alpha-plugins.good" "$fixture_data/cpx-alpha-plugins"

# Duplicate rows are inventory failures, but unique discoverable rows still emit.
printf '%s\n' $'alpha\tpack-alpha' $'alpha\tpack-alpha' $'zeta\tpack-zeta' >"$fixture_data/cpx-list"
run_matrix
[ "$matrix_status" -eq 1 ] || fail 'duplicate profile inventory did not return 1'
grep -Fq '| cpx | alpha |' "$output_file" || fail 'valid Copilot row was lost after a duplicate'
grep -Fq '| grx | hve |' "$output_file" || fail 'later launcher rows were lost after a duplicate'
printf '%s\n' $'zeta\tpack-zeta' $'alpha\tpack-alpha' >"$fixture_data/cpx-list"

# Strict list parsing rejects extra fields and empty inventories.
printf '%s\n' $'hve\thve-plugin\textra' $'awesome\tawesome-plugin' >"$fixture_data/grx-list"
: >"$command_log"
run_matrix
[ "$matrix_status" -eq 1 ] || fail 'three-field Grok list row did not return 1'
grep -Fq 'verify-agent-profiles: grx profile inventory is invalid' "$error_file" \
  || fail 'three-field Grok list row omitted the strict inventory diagnostic'
grep -Fq '| grx | awesome |' "$output_file" || fail 'valid Grok row was lost after an invalid row'
if grep -Fq '| grx | hve |' "$output_file"; then
  fail 'three-field Grok list row emitted an invalid profile row'
fi
if grep -Eq $'^grx\t(doctor\thve|hve\tinspect\t--json)$' "$command_log"; then
  fail 'three-field Grok list row invoked the invalid profile'
fi
: >"$fixture_data/grx-list"
run_matrix
[ "$matrix_status" -eq 1 ] || fail 'empty Grok inventory did not return 1'
grep -Fq '| cpx | zeta |' "$output_file" || fail 'Copilot rows were lost after empty Grok inventory'
cp "$fixture_data/grx-list.good" "$fixture_data/grx-list"

: >"$fixture_data/cpx-list"
run_matrix
[ "$matrix_status" -eq 1 ] || fail 'empty Copilot inventory did not return 1'
grep -Fq 'verify-agent-profiles: cpx profile inventory is empty' "$error_file" \
  || fail 'empty Copilot inventory did not emit a useful diagnostic'
if grep -Fq '| cpx |' "$output_file"; then
  fail 'empty Copilot inventory emitted a fabricated profile row'
fi
grep -Fq '| grx | hve |' "$output_file" || fail 'Grok rows were lost after empty Copilot inventory'
cp "$fixture_data/cpx-list.good" "$fixture_data/cpx-list"

printf '%s\n' $'hve\thve-plugin' $'hve\thve-plugin' $'awesome\tawesome-plugin' \
  >"$fixture_data/grx-list"
run_matrix
[ "$matrix_status" -eq 1 ] || fail 'duplicate Grok profile inventory did not return 1'
grep -Fq 'verify-agent-profiles: duplicate grx profile: hve' "$error_file" \
  || fail 'duplicate Grok profile did not emit useful stderr detail'
grep -Fq '| grx | hve |' "$output_file" || fail 'first unique Grok row was lost after duplicate'
grep -Fq '| grx | awesome |' "$output_file" || fail 'other Grok row was lost after duplicate'
cp "$fixture_data/grx-list.good" "$fixture_data/grx-list"

# Malformed JSON and unexpected packages fail their rows without stopping aggregation.
printf '%s\n' '{"token":"SENSITIVE_PAYLOAD_DO_NOT_LEAK","fullConfig":{"prompt":"DO_NOT_DUMP_FULL_DOCUMENT"}}' \
  >"$fixture_data/cpx-alpha-skills.json"
run_matrix
[ "$matrix_status" -eq 1 ] || fail 'malformed Copilot JSON did not return 1'
grep -Fq '| cpx | alpha | pack-alpha | ? | ? |  | fail: invalid skill JSON | not run |' "$output_file" \
  || fail 'malformed Copilot JSON diagnostic was not retained in its row'
grep -Fq 'verify-agent-profiles: cpx skill inventory validation failed for alpha: expected one JSON array with valid skill fields' "$error_file" \
  || fail 'malformed Copilot JSON did not emit useful safe stderr detail'
if grep -Eq 'SENSITIVE_PAYLOAD_DO_NOT_LEAK|DO_NOT_DUMP_FULL_DOCUMENT' "$error_file"; then
  fail 'malformed Copilot JSON leaked sensitive or full payload content to stderr'
fi
grep -Fq '| cpx | zeta |' "$output_file" || fail 'later Copilot row was lost after malformed JSON'
cp "$fixture_data/cpx-alpha-skills.good.json" "$fixture_data/cpx-alpha-skills.json"

printf '%s\n' '{"token":"GROK_SECRET_DO_NOT_LEAK","plugins":"not-an-array","skills":[]}' \
  >"$fixture_data/grx-hve-inspect.json"
run_matrix
[ "$matrix_status" -eq 1 ] || fail 'malformed Grok JSON did not return 1'
grep -Fq '| grx | hve | hve-plugin | ? | ? |  | fail: invalid inspect JSON | not run |' "$output_file" \
  || fail 'malformed Grok JSON diagnostic was not retained in its row'
grep -Fq 'verify-agent-profiles: grx inspect validation failed for hve: expected one JSON object with plugin and skill arrays' "$error_file" \
  || fail 'malformed Grok JSON did not emit useful safe stderr detail'
if grep -Fq 'GROK_SECRET_DO_NOT_LEAK' "$error_file"; then
  fail 'malformed Grok JSON leaked payload content to stderr'
fi
grep -Fq '| grx | awesome |' "$output_file" || fail 'other Grok row was lost after malformed JSON'
cp "$fixture_data/grx-hve-inspect.good.json" "$fixture_data/grx-hve-inspect.json"

printf '%s\n' 'Installed plugins:' '  • other-package (v1)' >"$fixture_data/cpx-alpha-plugins"
run_matrix
[ "$matrix_status" -eq 1 ] || fail 'unexpected Copilot package did not return 1'
grep -Fq 'fail: unexpected package' "$output_file" \
  || fail 'unexpected package diagnostic was not retained in its row'
grep -Fq 'verify-agent-profiles: cpx package validation failed for alpha: cataloged package is not the sole installed plugin' "$error_file" \
  || fail 'unexpected Copilot package did not emit useful safe stderr detail'
cp "$fixture_data/cpx-alpha-plugins.good" "$fixture_data/cpx-alpha-plugins"

"$real_jq" '(.plugins[0].name) = "other-plugin"' \
  "$fixture_data/grx-hve-inspect.good.json" >"$fixture_data/grx-hve-inspect.json"
run_matrix
[ "$matrix_status" -eq 1 ] || fail 'unexpected Grok package did not return 1'
grep -Fq '| grx | hve | hve-plugin | ? | ? |  | fail: unexpected package | not run |' "$output_file" \
  || fail 'unexpected Grok package diagnostic was not retained in its row'
grep -Fq 'verify-agent-profiles: grx package validation failed for hve: cataloged package is not enabled exactly once' "$error_file" \
  || fail 'unexpected Grok package did not emit useful safe stderr detail'
grep -Fq '| grx | awesome |' "$output_file" || fail 'other Grok row was lost after unexpected package'
cp "$fixture_data/grx-hve-inspect.good.json" "$fixture_data/grx-hve-inspect.json"

# Each adapter command failure is a row failure; other profiles still run.
: >"$fixture_data/fail-cdx-hve"
: >"$fixture_data/fail-cpx-doctor-alpha"
: >"$fixture_data/fail-grx-inspect-hve"
run_matrix
[ "$matrix_status" -eq 1 ] || fail 'adapter command failures did not aggregate to status 1'
grep -Fq '| cdx | hve | hve-core-all@hve-core | n/a | ? |  | fail: prompt input command | not run |' "$output_file" \
  || fail 'Codex command failure row is missing'
grep -Fq '| cpx | alpha | pack-alpha | 6 | 7 | p1, p2, p3, p4, p5 | fail: doctor command | not run |' "$output_file" \
  || fail 'Copilot command failure row is missing'
grep -Fq '| grx | hve | hve-plugin | ? | ? |  | fail: inspect command | not run |' "$output_file" \
  || fail 'Grok command failure row is missing'
grep -Fq 'verify-agent-profiles: Codex prompt-input failed for hve (exit 65)' "$error_file" \
  || fail 'Codex command failure stderr omitted safe exit detail'
grep -Fq 'verify-agent-profiles: cpx doctor failed for alpha (exit 65)' "$error_file" \
  || fail 'Copilot command failure stderr omitted safe exit detail'
grep -Fq 'verify-agent-profiles: grx inspect failed for hve (exit 65)' "$error_file" \
  || fail 'Grok command failure stderr omitted safe exit detail'
if grep -Eq 'CODEX_COMMAND_SECRET_DO_NOT_LEAK|CPX_COMMAND_SECRET_DO_NOT_LEAK|GRX_COMMAND_SECRET_DO_NOT_LEAK' "$error_file"; then
  fail 'adapter command failure leaked command stderr payload'
fi
grep -Fq '| cpx | zeta |' "$output_file" || fail 'Copilot aggregation stopped after command failure'
grep -Fq '| grx | awesome |' "$output_file" || fail 'Grok aggregation stopped after command failure'
rm -f "$fixture_data/fail-cdx-hve" "$fixture_data/fail-cpx-doctor-alpha" "$fixture_data/fail-grx-inspect-hve"

: >"$fixture_data/fail-cdx-doctor-hve"
run_matrix
[ "$matrix_status" -eq 1 ] || fail 'managed Codex doctor failure did not return 1'
grep -Fq '| cdx | hve | hve-core-all@hve-core | n/a | 2 | skilla, skillb | fail: doctor command | not run |' "$output_file" \
  || fail 'managed Codex doctor failure row is missing'
grep -Fq 'verify-agent-profiles: cdx doctor failed for hve (exit 65)' "$error_file" \
  || fail 'managed Codex doctor failure omitted safe stderr detail'
if grep -Fq 'CDX_DOCTOR_SECRET_DO_NOT_LEAK' "$error_file"; then
  fail 'managed Codex doctor failure leaked command stderr payload'
fi
grep -Fq '| cpx | zeta |' "$output_file" \
  || fail 'managed Codex doctor failure stopped later adapters'
rm -f "$fixture_data/fail-cdx-doctor-hve"

: >"$fixture_data/fail-cpx-plugin-alpha"
run_matrix
[ "$matrix_status" -eq 1 ] || fail 'Copilot plugin-list command failure did not return 1'
grep -Fq '| cpx | alpha | pack-alpha | 6 | 7 | p1, p2, p3, p4, p5 | fail: plugin command | not run |' "$output_file" \
  || fail 'Copilot plugin-list failure row is missing'
grep -Fq 'verify-agent-profiles: cpx plugin list failed for alpha (exit 65)' "$error_file" \
  || fail 'Copilot plugin-list failure omitted safe stderr detail'
if grep -Fq 'CPX_PLUGIN_LIST_SECRET_DO_NOT_LEAK' "$error_file"; then
  fail 'Copilot plugin-list failure leaked command payload'
fi
grep -Fq '| cpx | zeta |' "$output_file" || fail 'Copilot plugin-list failure stopped later profiles'
rm -f "$fixture_data/fail-cpx-plugin-alpha"

: >"$fixture_data/fail-cpx-skills-alpha"
run_matrix
[ "$matrix_status" -eq 1 ] || fail 'Copilot skill-list command failure did not return 1'
grep -Fq '| cpx | alpha | pack-alpha | ? | ? |  | fail: skill command | not run |' "$output_file" \
  || fail 'Copilot skill-list failure row is missing'
grep -Fq 'verify-agent-profiles: cpx skill list failed for alpha (exit 65)' "$error_file" \
  || fail 'Copilot skill-list failure omitted safe stderr detail'
if grep -Fq 'CPX_SKILL_LIST_SECRET_DO_NOT_LEAK' "$error_file"; then
  fail 'Copilot skill-list failure leaked command payload'
fi
grep -Fq '| cpx | zeta |' "$output_file" || fail 'Copilot skill-list failure stopped later profiles'
rm -f "$fixture_data/fail-cpx-skills-alpha"

: >"$fixture_data/fail-grx-list"
run_matrix
[ "$matrix_status" -eq 1 ] || fail 'Grok list command failure did not return 1'
grep -Fq 'verify-agent-profiles: grx list failed (exit 65)' "$error_file" \
  || fail 'Grok list failure omitted safe stderr detail'
if grep -Fq 'GRX_LIST_SECRET_DO_NOT_LEAK' "$error_file"; then
  fail 'Grok list failure leaked command payload'
fi
if grep -Fq '| grx |' "$output_file"; then
  fail 'Grok list failure emitted fabricated rows'
fi
grep -Fq '| cpx | zeta |' "$output_file" || fail 'Grok list failure lost earlier launcher rows'
rm -f "$fixture_data/fail-grx-list"

: >"$fixture_data/fail-grx-doctor-hve"
run_matrix
[ "$matrix_status" -eq 1 ] || fail 'Grok doctor command failure did not return 1'
grep -Fq '| grx | hve | hve-plugin | 6 | 7 | h1, h2, h3, h4, h5 | fail: doctor command | not run |' "$output_file" \
  || fail 'Grok doctor failure row is missing'
grep -Fq 'verify-agent-profiles: grx doctor failed for hve (exit 65)' "$error_file" \
  || fail 'Grok doctor failure omitted safe stderr detail'
if grep -Fq 'GRX_DOCTOR_SECRET_DO_NOT_LEAK' "$error_file"; then
  fail 'Grok doctor failure leaked command payload'
fi
grep -Fq '| grx | awesome |' "$output_file" || fail 'Grok doctor failure lost other profile rows'
rm -f "$fixture_data/fail-grx-doctor-hve"

# Codex inventory and prompt JSON validation are strict.
printf '%s\n' '{"token":"CODEX_SECRET_DO_NOT_LEAK","fullPrompt":"DO_NOT_DUMP_PROMPT"}' \
  >"$fixture_data/codex-hve.json"
run_matrix
[ "$matrix_status" -eq 1 ] || fail 'malformed Codex prompt JSON did not return 1'
grep -Fq 'fail: invalid prompt JSON' "$output_file" || fail 'malformed Codex JSON row is missing'
grep -Fq 'verify-agent-profiles: Codex prompt validation failed for hve: expected one JSON message array' "$error_file" \
  || fail 'malformed Codex JSON did not emit useful safe stderr detail'
if grep -Eq 'CODEX_SECRET_DO_NOT_LEAK|DO_NOT_DUMP_PROMPT' "$error_file"; then
  fail 'malformed Codex JSON leaked credentials or prompt content to stderr'
fi
cp "$fixture_data/codex-hve.good.json" "$fixture_data/codex-hve.json"

"$real_jq" -cn --arg text $'### Available skills\n- skilla: A\n### End\nSECTION_SECRET_DO_NOT_LEAK\n### Available skills\n- skillb: B\n### End' \
  '[{type:"message",role:"developer",content:[{type:"input_text",text:$text}]}]' \
  >"$fixture_data/codex-hve.json"
run_matrix
[ "$matrix_status" -eq 1 ] || fail 'duplicate Codex available-skills sections returned success'
grep -Fq 'verify-agent-profiles: Codex skill-section validation failed for hve: expected exactly one available-skills section' "$error_file" \
  || fail 'Codex skill-section validation omitted useful safe stderr detail'
if grep -Fq 'SECTION_SECRET_DO_NOT_LEAK' "$error_file"; then
  fail 'Codex skill-section validation leaked prompt content'
fi
cp "$fixture_data/codex-hve.good.json" "$fixture_data/codex-hve.json"

# Managed Codex discovery strictly rejects malformed and duplicate list rows.
printf '%s\n' $'Bad\tbad-package' \
  $'superpowers\tsuperpowers@superpowers-marketplace' >"$fixture_data/cdx-list"
run_matrix
[ "$matrix_status" -eq 1 ] || fail 'malformed cdx list row did not return 1'
grep -Fq 'verify-agent-profiles: cdx profile inventory is invalid' "$error_file" \
  || fail 'malformed cdx list row omitted its exact diagnostic'
if grep -Fq '| cdx | Bad |' "$output_file"; then
  fail 'malformed cdx list row emitted an invalid profile row'
fi
grep -Fq '| cpx | alpha |' "$output_file" \
  || fail 'malformed cdx list row stopped later adapters'

printf '%s\n' $'hve\thve-core-all@hve-core' $'hve\thve-core-all@hve-core' \
  $'superpowers\tsuperpowers@superpowers-marketplace' >"$fixture_data/cdx-list"
run_matrix
[ "$matrix_status" -eq 1 ] || fail 'duplicate cdx list row did not return 1'
grep -Fq 'verify-agent-profiles: duplicate cdx profile: hve' "$error_file" \
  || fail 'duplicate cdx list row omitted its exact diagnostic'
grep -Fq '| cdx | hve |' "$output_file" || fail 'first unique cdx row was lost after duplicate'
grep -Fq '| grx | hve |' "$output_file" || fail 'duplicate cdx row stopped later adapters'

printf '%s\n' $'superpowers\tsuperpowers@superpowers-marketplace' \
  >"$fixture_data/cdx-list"
run_matrix
[ "$matrix_status" -eq 1 ] || fail 'missing managed cdx profile did not return 1'
grep -Fq 'verify-agent-profiles: cdx profile inventory does not match managed catalog' "$error_file" \
  || fail 'missing managed cdx profile omitted its exact diagnostic'
grep -Fq '| cpx | alpha |' "$output_file" \
  || fail 'missing managed cdx profile stopped later adapters'

printf '%s\n' \
  $'hve\thve-core-all@hve-core' \
  $'superpowers\tsuperpowers@superpowers-marketplace' \
  $'third\tthird-package' >"$fixture_data/cdx-list"
run_matrix
[ "$matrix_status" -eq 1 ] || fail 'extra managed cdx profile did not return 1'
grep -Fq 'verify-agent-profiles: cdx profile inventory does not match managed catalog' "$error_file" \
  || fail 'extra managed cdx profile omitted its exact diagnostic'
grep -Fq '| grx | hve |' "$output_file" \
  || fail 'extra managed cdx profile stopped later adapters'

printf '%s\n' \
  $'hve\twrong-package' \
  $'superpowers\tsuperpowers@superpowers-marketplace' >"$fixture_data/cdx-list"
run_matrix
[ "$matrix_status" -eq 1 ] || fail 'wrong managed cdx package did not return 1'
grep -Fq 'verify-agent-profiles: cdx profile inventory does not match managed catalog' "$error_file" \
  || fail 'wrong managed cdx package omitted its exact diagnostic'
grep -Fq '| cpx | zeta |' "$output_file" \
  || fail 'wrong managed cdx package stopped later adapters'
cp "$fixture_data/cdx-list.good" "$fixture_data/cdx-list"

# Every required launcher and jq must be present.
for missing_command in cdx codex cpx grx jq; do
  mv "$fixture_bin/$missing_command" "$fixture_bin/$missing_command.hidden"
  run_matrix
  [ "$matrix_status" -eq 1 ] || fail "missing $missing_command did not return 1"
  grep -Fq "required command not found: $missing_command" "$error_file" \
    || fail "missing $missing_command diagnostic is absent"
  case "$missing_command" in
    cdx|codex)
      grep -Fq '| cpx | zeta |' "$output_file" \
        || fail "missing $missing_command stopped the later Copilot adapter"
      ;;
    cpx)
      grep -Fq '| grx | hve |' "$output_file" \
        || fail 'missing cpx stopped the later Grok adapter'
      ;;
    grx)
      grep -Fq '| cpx | zeta |' "$output_file" \
        || fail 'missing grx lost completed Copilot rows'
      ;;
  esac
  mv "$fixture_bin/$missing_command.hidden" "$fixture_bin/$missing_command"
done

# Failure cleanup is as strict as success cleanup.
: >"$fixture_data/fail-cpx-list"
run_matrix
[ "$matrix_status" -eq 1 ] || fail 'discovery command failure did not return 1'
[ -z "$(find "$fixture_tmp" -mindepth 1 -print -quit)" ] \
  || fail 'temporary artifacts remained after failed verification'
rm -f "$fixture_data/fail-cpx-list"

# A valid empty Copilot skill array is a zero-count inventory.
cp "$fixture_data/cpx-zeta-skills.json" "$fixture_data/cpx-zeta-skills.good.json"
printf '[]\n' >"$fixture_data/cpx-zeta-skills.json"
run_matrix
[ "$matrix_status" -eq 0 ] || fail 'empty valid Copilot skill inventory returned nonzero'
grep -Fq '| cpx | zeta | pack-zeta | 0 | 0 |  | pass | not run |' "$output_file" \
  || fail 'empty valid Copilot skill inventory did not produce zero counts'
cp "$fixture_data/cpx-zeta-skills.good.json" "$fixture_data/cpx-zeta-skills.json"

# Skill source metadata must be structurally valid, not merely present.
cp "$fixture_data/cpx-alpha-skills.json" "$fixture_data/cpx-alpha-skills.source-good.json"
"$real_jq" '.+[ {name:"badsource",source:"bad\nsource",enabled:true} ]' \
  "$fixture_data/cpx-alpha-skills.json" >"$fixture_data/cpx-alpha-skills.invalid.json"
mv "$fixture_data/cpx-alpha-skills.invalid.json" "$fixture_data/cpx-alpha-skills.json"
run_matrix
[ "$matrix_status" -eq 1 ] || fail 'invalid Copilot skill source returned success'
grep -Fq 'fail: invalid skill JSON' "$output_file" \
  || fail 'invalid Copilot skill source was not diagnosed in its row'
cp "$fixture_data/cpx-alpha-skills.source-good.json" "$fixture_data/cpx-alpha-skills.json"

cp "$fixture_data/grx-hve-inspect.json" "$fixture_data/grx-hve-inspect.source-good.json"
"$real_jq" '.skills += [{name:"badsource",source:{type:"plugin"}}]' \
  "$fixture_data/grx-hve-inspect.json" >"$fixture_data/grx-hve-inspect.invalid.json"
mv "$fixture_data/grx-hve-inspect.invalid.json" "$fixture_data/grx-hve-inspect.json"
run_matrix
[ "$matrix_status" -eq 1 ] || fail 'invalid Grok plugin skill source returned success'
grep -Fq '| grx | hve | hve-plugin |' "$output_file" \
  || fail 'invalid Grok source profile row is missing'
grep -Fq 'fail: invalid inspect JSON' "$output_file" \
  || fail 'invalid Grok plugin skill source was not diagnosed'
cp "$fixture_data/grx-hve-inspect.source-good.json" "$fixture_data/grx-hve-inspect.json"

# Codex may expose the same skill name from more than one model-visible root.
cp "$fixture_data/codex-hve.json" "$fixture_data/codex-hve.duplicate-good.json"
"$real_jq" -cn --arg text $'### Available skills\n- skillb: B (file: /b)\n- skilla: A1 (file: /a1)\n- skilla: A2 (file: /a2)\n### End' \
  '[{type:"message",role:"developer",content:[{type:"input_text",text:$text}]}]' \
  >"$fixture_data/codex-hve.json"
run_matrix
[ "$matrix_status" -eq 0 ] || fail 'duplicate model-visible Codex skill names returned nonzero'
grep -Fq '| cdx | hve | hve-core-all@hve-core | n/a | 3 | skilla, skilla, skillb | pass | not run |' "$output_file" \
  || fail 'duplicate model-visible Codex skill entries were not counted'
cp "$fixture_data/codex-hve.duplicate-good.json" "$fixture_data/codex-hve.json"

# Codex samples are sorted and capped at five model-visible entries.
cp "$fixture_data/codex-hve.json" "$fixture_data/codex-hve.sample-good.json"
"$real_jq" -cn --arg text $'### Available skills\n- skillf: F (file: /f)\n- skille: E (file: /e)\n- skilld: D (file: /d)\n- skillc: C (file: /c)\n- skillb: B (file: /b)\n- skilla: A (file: /a)\n### End' \
  '[{type:"message",role:"developer",content:[{type:"input_text",text:$text}]}]' \
  >"$fixture_data/codex-hve.json"
run_matrix
[ "$matrix_status" -eq 0 ] || fail 'six-skill Codex sample fixture returned nonzero'
grep -Fq '| cdx | hve | hve-core-all@hve-core | n/a | 6 | skilla, skillb, skillc, skilld, skille | pass | not run |' "$output_file" \
  || fail 'Codex sample was not sorted and capped at five entries'
if grep -Fq 'skille, skillf' "$output_file"; then
  fail 'Codex sample included a sixth entry'
fi
cp "$fixture_data/codex-hve.sample-good.json" "$fixture_data/codex-hve.json"

# Large inventories must not trip pipefail while limiting the sample.
large_codex_text="$fixture_data/codex-hve-large.txt"
awk 'BEGIN {
  print "### Available skills"
  for (i = 20000; i >= 1; i--)
    printf "- largeskill%05d: fixture (file: /large/%05d)\n", i, i
  print "### End"
}' >"$large_codex_text"
"$real_jq" -cn --rawfile text "$large_codex_text" \
  '[{type:"message",role:"developer",content:[{type:"input_text",text:$text}]}]' \
  >"$fixture_data/codex-hve.json"
run_matrix
[ "$matrix_status" -eq 0 ] || fail 'large Codex inventory triggered a verifier failure'
grep -Fq '| cdx | hve | hve-core-all@hve-core | n/a | 20000 | largeskill00001, largeskill00002, largeskill00003, largeskill00004, largeskill00005 | pass | not run |' "$output_file" \
  || fail 'large Codex inventory did not retain a passing capped sample'
[ -z "$(find "$fixture_tmp" -mindepth 1 -print -quit)" ] \
  || fail 'temporary artifacts remained after large inventory verification'
cp "$fixture_data/codex-hve.sample-good.json" "$fixture_data/codex-hve.json"

# Live mode invokes every statically passing row and validates structured evidence.
: >"$command_log"
run_live_matrix
[ "$matrix_status" -eq 0 ] || fail '--live happy path returned nonzero'
[ "$(grep -Fc '| pass | pass |' "$output_file")" -eq 6 ] \
  || fail '--live did not report six passing live rows'
for live_row in \
  $'codex\texec' \
  $'cpx\talpha\t--prompt' \
  $'cpx\tzeta\t--prompt' \
  $'grx\tawesome\t--single' \
  $'grx\thve\t--single'; do
  grep -Fq "$live_row" "$command_log" || fail "missing live invocation: $live_row"
done
grep -Fq '| grx | awesome | awesome-plugin | 0 | 1 |  | pass | pass |' "$output_file" \
  || fail 'zero-package-skill Grok row was not live-probed successfully'
if grep -Eq $'\t(--dangerously-bypass-approvals-and-sandbox|--allow-all|--allow-all-tools|--yolo|--always-approve|--permission-mode\tbypassPermissions)(\t|$)' "$command_log"; then
  fail 'live verifier used a dangerous approval or sandbox bypass'
fi
[ -z "$(find "$fixture_tmp" -mindepth 1 -print -quit)" ] \
  || fail 'temporary artifacts remained after successful live verification'

awk -F '\t' -v temp_prefix="$fixture_tmp/verify-agent-profiles." '
  $1 == "codex" && $2 == "exec" {
    codex_count++
    if (NF != 13 || $3 != "--ephemeral" ||
      $4 != "--sandbox" || $5 != "read-only" || $6 != "--config" ||
      $7 != "approval_policy=\"never\"" || $8 != "--output-schema" ||
      index($9, temp_prefix) != 1 || $10 != "--json" ||
      $11 != "--output-last-message" || index($12, temp_prefix) != 1 ||
      $13 != "-") bad = 1
  }
  $1 == "cpx" && $3 == "--prompt" {
    if (NF != 14 || $5 != "--output-format" || $6 != "json" ||
      $7 != "--no-ask-user" || $8 != "--disable-builtin-mcps" ||
      $9 != "--available-tools=" || $10 != "--no-remote" ||
      $11 != "--no-remote-export" || $12 != "--no-auto-update" ||
      $13 != "--stream" || $14 != "off") bad = 1
  }
  $1 == "grx" && $3 == "--single" {
    deny_count = 0
    for (i = 1; i <= NF; i++) if ($i == "--deny") deny_count++
    if (NF != 19 || $5 != "--json-schema" || $7 != "--output-format" ||
      $8 != "json" || $9 != "--no-subagents" || $10 != "--tools" ||
      $11 != "" || $12 != "--deny" || $13 != "MCPTool" ||
      deny_count != 1 || $14 != "--disable-web-search" ||
      $15 != "--max-turns" || $16 != "1" || $17 != "--no-memory" ||
      $18 != "--permission-mode" || $19 != "dontAsk") bad = 1
  }
  END { exit bad || codex_count != 2 }
' "$command_log" || fail 'live verifier changed a safety-critical argument shape'
if grep -Eq $'^cdx\t.*\t(exec|-p|--prompt|--dangerously-bypass-approvals-and-sandbox)(\t|$)|\t(--model|--resume|--continue|--session-id|--autopilot|--always-approve|--allow-all|--allow-all-tools|--yolo)(\t|$)' "$command_log"; then
  fail 'live verifier used a forbidden launcher, model, lifecycle, or multi-turn variant'
fi
if grep -Eq '/fixture|\.config\.toml|SECRET_DO_NOT_LEAK' "$command_log"; then
  fail 'live prompt exposed a source path, config path, or secret'
fi

cp "$fixture_data/codex-hve-live.json" "$fixture_data/codex-hve-live.good.json"
cp "$fixture_data/codex-hve-live-events.jsonl" "$fixture_data/codex-hve-live-events.good.jsonl"
cp "$fixture_data/cpx-alpha-live.jsonl" "$fixture_data/cpx-alpha-live.good.jsonl"
cp "$fixture_data/cpx-zeta-live.jsonl" "$fixture_data/cpx-zeta-live.good.jsonl"
cp "$fixture_data/grx-awesome-live.json" "$fixture_data/grx-awesome-live.good.json"
cp "$fixture_data/grx-hve-live.json" "$fixture_data/grx-hve-live.good.json"

# A live command failure is safe, aggregates, and does not stop later profiles.
: >"$fixture_data/fail-live-cpx-alpha"
: >"$command_log"
run_live_matrix
[ "$matrix_status" -eq 1 ] || fail 'nonzero live command returned success'
grep -Fq '| cpx | alpha | pack-alpha | 6 | 7 | p1, p2, p3, p4, p5 | pass | fail: command |' "$output_file" \
  || fail 'nonzero live command did not fail its row'
grep -Fq '| cpx | zeta | pack-zeta | 1 | 1 | zplugin | pass | pass |' "$output_file" \
  || fail 'live command failure stopped a later Copilot profile'
grep -Fq '| grx | hve | hve-plugin | 6 | 7 | h1, h2, h3, h4, h5 | pass | pass |' "$output_file" \
  || fail 'live command failure stopped a later launcher'
grep -Fq 'verify-agent-profiles: cpx live probe failed for alpha (exit 65)' "$error_file" \
  || fail 'nonzero live command omitted safe exit detail'
if grep -Fq 'LIVE_CPX_SECRET_DO_NOT_LEAK' "$error_file"; then
  fail 'nonzero live command leaked captured stderr'
fi
[ -z "$(find "$fixture_tmp" -mindepth 1 -print -quit)" ] \
  || fail 'temporary artifacts remained after a failed live verification'
rm -f "$fixture_data/fail-live-cpx-alpha"

# Malformed structured output fails without dumping response content.
write_cpx_live alpha 'MALFORMED_LIVE_SECRET_DO_NOT_LEAK'
run_live_matrix
[ "$matrix_status" -eq 1 ] || fail 'malformed live response returned success'
grep -Fq '| cpx | alpha | pack-alpha | 6 | 7 | p1, p2, p3, p4, p5 | pass | fail: malformed evidence |' "$output_file" \
  || fail 'malformed live response did not fail its row'
if grep -Fq 'MALFORMED_LIVE_SECRET_DO_NOT_LEAK' "$error_file"; then
  fail 'malformed live response leaked model output'
fi
cp "$fixture_data/cpx-alpha-live.good.jsonl" "$fixture_data/cpx-alpha-live.jsonl"

# Launcher and profile identity must match exactly.
"$real_jq" '.launcher = "grx"' "$fixture_data/codex-hve-live.good.json" \
  >"$fixture_data/codex-hve-live.json"
run_live_matrix
[ "$matrix_status" -eq 1 ] || fail 'wrong live launcher returned success'
grep -Fq '| cdx | hve | hve-core-all@hve-core | n/a | 2 | skilla, skillb | pass | fail: wrong launcher |' "$output_file" \
  || fail 'wrong live launcher did not fail its row'
cp "$fixture_data/codex-hve-live.good.json" "$fixture_data/codex-hve-live.json"

"$real_jq" '.profile = "awesome"' "$fixture_data/grx-hve-live.good.json" \
  >"$fixture_data/grx-hve-live.json"
run_live_matrix
[ "$matrix_status" -eq 1 ] || fail 'wrong live profile returned success'
grep -Fq '| grx | hve | hve-plugin | 6 | 7 | h1, h2, h3, h4, h5 | pass | fail: wrong profile |' "$output_file" \
  || fail 'wrong live profile did not fail its row'
cp "$fixture_data/grx-hve-live.good.json" "$fixture_data/grx-hve-live.json"

# Missing and duplicate expected skills are distinct failures.
write_cpx_live alpha '{"launcher":"cpx","profile":"alpha","skills":["p1","p2","p3","p4"],"emptyPackageConfirmed":false}'
run_live_matrix
[ "$matrix_status" -eq 1 ] || fail 'missing expected live skill returned success'
grep -Fq 'pass | fail: missing skill |' "$output_file" \
  || fail 'missing expected live skill was not diagnosed'

write_cpx_live alpha '{"launcher":"cpx","profile":"alpha","skills":["p1","p1","p2","p3","p4","p5"],"emptyPackageConfirmed":false}'
run_live_matrix
[ "$matrix_status" -eq 1 ] || fail 'duplicate expected live skill returned success'
grep -Fq 'pass | fail: duplicate skill |' "$output_file" \
  || fail 'duplicate expected live skill was not diagnosed'
cp "$fixture_data/cpx-alpha-live.good.jsonl" "$fixture_data/cpx-alpha-live.jsonl"

# Event adapters reject tool use even when final structured evidence is valid.
printf '%s\n' '{"type":"item.started","item":{"type":"command_execution"}}' \
  >>"$fixture_data/codex-hve-live-events.jsonl"
run_live_matrix
[ "$matrix_status" -eq 1 ] || fail 'Codex tool-use event returned success'
grep -Fq 'pass | fail: tool use |' "$output_file" \
  || fail 'Codex tool-use event was not diagnosed'
cp "$fixture_data/codex-hve-live-events.good.jsonl" "$fixture_data/codex-hve-live-events.jsonl"

printf '%s\n' '{"type":"item.started","item":{"type":"collab_tool_call"}}' \
  >>"$fixture_data/codex-hve-live-events.jsonl"
run_live_matrix
[ "$matrix_status" -eq 1 ] || fail 'Codex collab tool event returned success'
grep -Fq '| cdx | hve | hve-core-all@hve-core | n/a | 2 | skilla, skillb | pass | fail: tool use |' "$output_file" \
  || fail 'Codex collab tool event was not diagnosed'
grep -Fq '| cdx | superpowers | superpowers@superpowers-marketplace | n/a | 1 | zskill | pass | pass |' "$output_file" \
  || fail 'Codex collab tool event stopped a later Codex profile'
grep -Fq '| grx | hve | hve-plugin | 6 | 7 | h1, h2, h3, h4, h5 | pass | pass |' "$output_file" \
  || fail 'Codex collab tool event stopped a later launcher'
cp "$fixture_data/codex-hve-live-events.good.jsonl" "$fixture_data/codex-hve-live-events.jsonl"

{
  printf '%s\n' '{"type":"tool.execution_start"}'
  cat "$fixture_data/cpx-alpha-live.good.jsonl"
} >"$fixture_data/cpx-alpha-live.jsonl"
run_live_matrix
[ "$matrix_status" -eq 1 ] || fail 'Copilot tool-use event returned success'
grep -Fq '| cpx | alpha | pack-alpha | 6 | 7 | p1, p2, p3, p4, p5 | pass | fail: tool use |' "$output_file" \
  || fail 'Copilot tool-use event was not diagnosed'
cp "$fixture_data/cpx-alpha-live.good.jsonl" "$fixture_data/cpx-alpha-live.jsonl"

# Empty package evidence requires explicit confirmation for both package launchers.
"$real_jq" '.emptyPackageConfirmed = false' "$fixture_data/grx-awesome-live.good.json" \
  >"$fixture_data/grx-awesome-live.json"
run_live_matrix
[ "$matrix_status" -eq 1 ] || fail 'unconfirmed empty Grok package returned success'
grep -Fq '| grx | awesome | awesome-plugin | 0 | 1 |  | pass | fail: empty package unconfirmed |' "$output_file" \
  || fail 'unconfirmed empty Grok package was not diagnosed'
cp "$fixture_data/grx-awesome-live.good.json" "$fixture_data/grx-awesome-live.json"

cp "$fixture_data/cpx-zeta-skills.json" "$fixture_data/cpx-zeta-skills.live-good.json"
printf '[]\n' >"$fixture_data/cpx-zeta-skills.json"
write_cpx_live zeta '{"launcher":"cpx","profile":"zeta","skills":[],"emptyPackageConfirmed":true}'
run_live_matrix
[ "$matrix_status" -eq 0 ] || fail 'confirmed empty Copilot package returned nonzero'
grep -Fq '| cpx | zeta | pack-zeta | 0 | 0 |  | pass | pass |' "$output_file" \
  || fail 'empty Copilot package was not live-probed'
cp "$fixture_data/cpx-zeta-skills.live-good.json" "$fixture_data/cpx-zeta-skills.json"
cp "$fixture_data/cpx-zeta-live.good.jsonl" "$fixture_data/cpx-zeta-live.jsonl"

# Static-failed rows stay not-run while all other eligible rows are probed.
: >"$fixture_data/fail-cpx-doctor-alpha"
: >"$command_log"
run_live_matrix
[ "$matrix_status" -eq 1 ] || fail 'static failure in live mode returned success'
grep -Fq '| cpx | alpha | pack-alpha | 6 | 7 | p1, p2, p3, p4, p5 | fail: doctor command | not run |' "$output_file" \
  || fail 'static-failed live row did not retain not-run'
if grep -Fq $'cpx\talpha\t--prompt' "$command_log"; then
  fail 'static-failed row was live-probed'
fi
grep -Fq $'cpx\tzeta\t--prompt' "$command_log" \
  || fail 'eligible row after static failure was not live-probed'
rm -f "$fixture_data/fail-cpx-doctor-alpha"

# INT and TERM remove the validated temp workspace and terminate the fake live child.
for verifier_signal in HUP INT TERM; do
  signal_ready="$fixture_root/signal-$verifier_signal.ready"
  signal_child_pid_file="$fixture_root/signal-$verifier_signal.child-pid"
  rm -f "$signal_ready" "$signal_child_pid_file"
  set -m
  FAKE_BLOCK_LIVE='codex-hve' \
  FAKE_READY_FILE="$signal_ready" \
  FAKE_PID_FILE="$signal_child_pid_file" \
  HOME="$fixture_home" \
  CODEX_HOME="$fixture_codex_home" \
  FAKE_COMMAND_LOG="$command_log" \
  FAKE_DATA="$fixture_data" \
  TMPDIR="$fixture_tmp" \
  PATH="$restricted_path" \
    scripts/verify-agent-profiles --live >"$output_file" 2>"$error_file" &
  verifier_under_signal_pid=$!
  set +m
  signal_ready_seen=0
  for signal_attempt in {1..500}; do
    if [ -f "$signal_ready" ] && [ -s "$signal_child_pid_file" ]; then
      signal_ready_seen=1
      break
    fi
    sleep 0.01
  done
  [ "$signal_ready_seen" -eq 1 ] || fail "$verifier_signal live probe never became ready"
  [ -n "$(find "$fixture_tmp" -mindepth 1 -print -quit)" ] \
    || fail "$verifier_signal test did not observe a temp workspace"
  live_child_pid="$(cat "$signal_child_pid_file")"
  signal_tree_pids="$live_child_pid"
  kill -s "$verifier_signal" "$verifier_under_signal_pid"
  wait_for_verifier_exit_bounded "$verifier_under_signal_pid" \
    || fail "$verifier_signal verifier did not exit before the deadline"
  signal_status="$bounded_wait_status"
  verifier_under_signal_pid=''
  case "$verifier_signal" in
    HUP) [ "$signal_status" -eq 129 ] || fail "HUP returned $signal_status instead of 129" ;;
    INT) [ "$signal_status" -eq 130 ] || fail "INT returned $signal_status instead of 130" ;;
    TERM) [ "$signal_status" -eq 143 ] || fail "TERM returned $signal_status instead of 143" ;;
  esac
  [ -z "$(find "$fixture_tmp" -mindepth 1 -print -quit)" ] \
    || fail "$verifier_signal left temporary artifacts"
  if process_is_running "$live_child_pid"; then
    fail "$verifier_signal left the fake live process running"
  fi
  signal_tree_pids=''
done

# Signals before spawn and before adapter release cannot escape PID/PGID registration.
launch_window_failure=0
for launch_case in 'INT hold-before-spawn pre-spawn' \
  'TERM hold-before-release waiting' 'HUP hold-before-release waiting'; do
  read -r launch_signal launch_hold_name launch_marker_name <<<"$launch_case"
  static_ready="$fixture_root/launch-$launch_signal.static-ready"
  static_release="$fixture_root/launch-$launch_signal.static-release"
  rm -f "$static_ready" "$static_release"
  : >"$command_log"
  set -m
  FAKE_BLOCK_STATIC='cdx-hve' \
  FAKE_STATIC_READY_FILE="$static_ready" \
  FAKE_STATIC_RELEASE_FILE="$static_release" \
  HOME="$fixture_home" \
  CODEX_HOME="$fixture_codex_home" \
  FAKE_COMMAND_LOG="$command_log" \
  FAKE_DATA="$fixture_data" \
  TMPDIR="$fixture_tmp" \
  PATH="$restricted_path" \
    scripts/verify-agent-profiles --live >"$output_file" 2>"$error_file" &
  verifier_under_signal_pid=$!
  set +m
  static_ready_seen=0
  for launch_attempt in {1..500}; do
    if [ -f "$static_ready" ]; then
      static_ready_seen=1
      break
    fi
    sleep 0.01
  done
  [ "$static_ready_seen" -eq 1 ] \
    || fail "$launch_signal static launch fixture never became ready"
  launch_temp_dir="$(find "$fixture_tmp" -mindepth 1 -maxdepth 1 \
    -type d -name 'verify-agent-profiles.*' -print -quit)"
  [ -n "$launch_temp_dir" ] \
    || fail "$launch_signal launch-window temp directory was not observed"
  : >"$launch_temp_dir/live-launch.$launch_hold_name"
  : >"$static_release"
  launch_marker="$launch_temp_dir/live-launch.1.$launch_marker_name"
  launch_marker_seen=0
  for launch_attempt in {1..500}; do
    if [ -f "$launch_marker" ]; then
      launch_marker_seen=1
      break
    fi
    if ! process_is_running "$verifier_under_signal_pid"; then
      break
    fi
    sleep 0.01
  done
  if [ "$launch_marker_seen" -eq 0 ]; then
    stop_verifier_fixture_bounded "$verifier_under_signal_pid" \
      || fail "$launch_signal RED verifier could not be cleaned safely"
    verifier_under_signal_pid=''
    launch_window_failure=1
    continue
  fi
  launch_supervisor_pid=''
  if [ "$launch_marker_name" = 'waiting' ]; then
    launch_supervisor_pid="$(cat "$launch_marker")"
    signal_tree_pids="$launch_supervisor_pid"
  fi
  kill -s "$launch_signal" "$verifier_under_signal_pid"
  wait_for_verifier_exit_bounded "$verifier_under_signal_pid" \
    || fail "$launch_signal launch-window verifier exceeded its exit deadline"
  launch_signal_status="$bounded_wait_status"
  verifier_under_signal_pid=''
  case "$launch_signal" in
    HUP) [ "$launch_signal_status" -eq 129 ] \
      || fail "launch-window HUP returned $launch_signal_status instead of 129" ;;
    INT) [ "$launch_signal_status" -eq 130 ] \
      || fail "launch-window INT returned $launch_signal_status instead of 130" ;;
    TERM) [ "$launch_signal_status" -eq 143 ] \
      || fail "launch-window TERM returned $launch_signal_status instead of 143" ;;
  esac
  if grep -Fq $'codex\texec' "$command_log"; then
    fail "$launch_signal launch-window signal allowed the adapter to start"
  fi
  [ -z "$(find "$fixture_tmp" -mindepth 1 -print -quit)" ] \
    || fail "$launch_signal launch-window cleanup left temporary artifacts"
  if [ -n "$launch_supervisor_pid" ] \
    && process_is_running "$launch_supervisor_pid"; then
    fail "$launch_signal launch-window cleanup left the supervisor running"
  fi
  signal_tree_pids=''
done
[ "$launch_window_failure" -eq 0 ] \
  || fail 'launch-window gate was unavailable for INT or TERM'

# Copilot and Grok descendant trees, including a TERM-ignoring child, are killed as a unit.
tree_cleanup_failure=0
for tree_case in 'cpx INT alpha' 'grx TERM awesome' 'cpx HUP zeta'; do
  read -r tree_adapter tree_signal tree_profile <<<"$tree_case"
  tree_ready="$fixture_root/tree-$tree_adapter.ready"
  tree_launcher_pid_file="$fixture_root/tree-$tree_adapter.launcher-pid"
  tree_descendant_pid_file="$fixture_root/tree-$tree_adapter.descendant-pid"
  tree_ignorer_pid_file="$fixture_root/tree-$tree_adapter.ignorer-pid"
  rm -f "$tree_ready" "$tree_launcher_pid_file" \
    "$tree_descendant_pid_file" "$tree_ignorer_pid_file"
  set -m
  FAKE_BLOCK_LIVE="$tree_adapter-$tree_profile" \
  FAKE_READY_FILE="$tree_ready" \
  FAKE_PID_FILE="$tree_launcher_pid_file" \
  FAKE_TREE_CHILD="$fixture_bin/fake-live-descendant" \
  FAKE_TERM_IGNORER="$fixture_bin/fake-term-ignorer" \
  FAKE_DESCENDANT_PID_FILE="$tree_descendant_pid_file" \
  FAKE_IGNORER_PID_FILE="$tree_ignorer_pid_file" \
  HOME="$fixture_home" \
  CODEX_HOME="$fixture_codex_home" \
  FAKE_COMMAND_LOG="$command_log" \
  FAKE_DATA="$fixture_data" \
  TMPDIR="$fixture_tmp" \
  PATH="$restricted_path" \
    scripts/verify-agent-profiles --live >"$output_file" 2>"$error_file" &
  verifier_under_signal_pid=$!
  set +m
  tree_ready_seen=0
  for tree_attempt in {1..500}; do
    if [ -f "$tree_ready" ] && [ -s "$tree_launcher_pid_file" ] \
      && [ -s "$tree_descendant_pid_file" ] && [ -s "$tree_ignorer_pid_file" ]; then
      tree_ready_seen=1
      break
    fi
    sleep 0.01
  done
  [ "$tree_ready_seen" -eq 1 ] \
    || fail "$tree_adapter descendant tree never became ready"
  signal_tree_pids="$(cat "$tree_launcher_pid_file") \
$(cat "$tree_descendant_pid_file") $(cat "$tree_ignorer_pid_file")"
  kill -s "$tree_signal" "$verifier_under_signal_pid"
  wait_for_verifier_exit_bounded "$verifier_under_signal_pid" \
    || fail "$tree_adapter verifier did not exit before the deadline"
  tree_signal_status="$bounded_wait_status"
  verifier_under_signal_pid=''
  case "$tree_signal" in
    HUP) [ "$tree_signal_status" -eq 129 ] \
      || fail "$tree_adapter HUP returned $tree_signal_status instead of 129" ;;
    INT) [ "$tree_signal_status" -eq 130 ] \
      || fail "$tree_adapter INT returned $tree_signal_status instead of 130" ;;
    TERM) [ "$tree_signal_status" -eq 143 ] \
      || fail "$tree_adapter TERM returned $tree_signal_status instead of 143" ;;
  esac
  [ -z "$(find "$fixture_tmp" -mindepth 1 -print -quit)" ] \
    || fail "$tree_adapter signal cleanup left temporary artifacts"
  tree_fixture_running=0
  for tree_pid in $signal_tree_pids; do
    if process_is_running "$tree_pid"; then
      tree_fixture_running=1
    fi
  done
  if [ "$tree_fixture_running" -ne 0 ]; then
    tree_cleanup_failure=1
    kill_tree_fixture_bounded "$signal_tree_pids" \
      || fail "$tree_adapter RED fixture could not be cleaned safely"
  fi
  signal_tree_pids=''
done
[ "$tree_cleanup_failure" -eq 0 ] \
  || fail 'signal cleanup left Copilot or Grok live descendants running'

printf 'agent profile matrix: PASS\n'
