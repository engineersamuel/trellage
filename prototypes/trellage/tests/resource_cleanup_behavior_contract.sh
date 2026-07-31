#!/usr/bin/env bash
set -euo pipefail

tests_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
smoke_source="$tests_dir/smoke.sh"
startup_source="$tests_dir/runtime_startup_contract.sh"
persistence_source="$tests_dir/runtime_persistence_contract.sh"
contract_root="$(mktemp -d "${TMPDIR:-/tmp}/trellage-cleanup-test.XXXXXX")"
trap 'rm -rf -- "$contract_root"' EXIT

contract_fail() {
  printf 'Trellage cleanup behavior test: FAIL: %s\n' "$1" >&2
  exit 1
}

require_source_guard() {
  local source="$1"
  [[ "$(sed -n '2p' "$source")" == 'if [[ "${BASH_SOURCE[0]}" != "$0" ]]; then' ]] \
    && [[ "$(sed -n '3p' "$source")" == '  return 0' ]] \
    && [[ "$(sed -n '4p' "$source")" == 'fi' ]] \
    || contract_fail "script lacks an inert top-level source guard: $(basename "$source")"
}

source_runner_functions() {
  local source="$1"
  local instrumented_source
  instrumented_source="$contract_root/functions-$(basename "$source")"
  sed '2,4d' "$source" >"$instrumented_source"
  source "$instrumented_source"
}

assert_source_is_inert() {
  local source="$1"
  local absent_variable="$2"
  local absent_function="$3"
  local source_name
  source_name="$(basename "$source")"
  if ! (
    source_tmp="$contract_root/source-$source_name"
    source_stdout="$contract_root/source-$source_name.stdout"
    source_stderr="$contract_root/source-$source_name.stderr"
    docker_log="$contract_root/source-$source_name.docker"
    mkdir "$source_tmp"
    : >"$docker_log"
    TMPDIR="$source_tmp"
    export TMPDIR

    set +e +u
    set +o pipefail
    before_options="$(set +o)"
    image_ref='caller-image_ref'
    prototype_dir='caller-prototype_dir'
    tests_dir='caller-tests_dir'
    watchdog_seconds='caller-watchdog_seconds'
    test_root='caller-test_root'
    suffix='caller-suffix'
    volume_name='caller-volume_name'
    volume_created='caller-volume_created'
    container_name='caller-container_name'
    container_id='caller-container_id'
    mount_path='caller-mount_path'
    prototype_label='caller-prototype_label'
    worktree_label='caller-worktree_label'
    unset "$absent_variable"
    cleanup() { printf 'caller-cleanup\n'; }
    before_cleanup="$(declare -f cleanup)"
    unset -f "$absent_function"
    docker() { printf '%s\n' "$*" >>"$docker_log"; }

    source "$source" >"$source_stdout" 2>"$source_stderr"

    after_options="$(set +o)"
    if [[ "$after_options" != "$before_options" ]]; then
      printf 'source changed caller shell options: %s\n' "$source_name" >&2
      exit 1
    fi
    for variable in \
      image_ref prototype_dir tests_dir watchdog_seconds test_root suffix \
      volume_name volume_created container_name container_id mount_path \
      prototype_label worktree_label; do
      if [[ "$variable" == "$absent_variable" ]]; then
        continue
      fi
      if [[ "${!variable}" != "caller-$variable" ]]; then
        printf 'source overwrote caller variable %s: %s\n' "$variable" "$source_name" >&2
        exit 1
      fi
    done
    if declare -p "$absent_variable" >/dev/null 2>&1; then
      printf 'source introduced caller variable %s: %s\n' "$absent_variable" "$source_name" >&2
      exit 1
    fi
    if [[ "$(declare -f cleanup)" != "$before_cleanup" ]]; then
      printf 'source overwrote caller helper cleanup: %s\n' "$source_name" >&2
      exit 1
    fi
    if declare -F "$absent_function" >/dev/null 2>&1; then
      printf 'source introduced helper %s: %s\n' "$absent_function" "$source_name" >&2
      exit 1
    fi
    if [[ -s "$source_stdout" || -s "$source_stderr" ]]; then
      printf 'source executed runner output: %s\n' "$source_name" >&2
      exit 1
    fi
    if [[ -s "$docker_log" ]]; then
      printf 'source called Docker: %s\n' "$source_name" >&2
      exit 1
    fi
    if find "$source_tmp" -mindepth 1 -print -quit | grep -q .; then
      printf 'source created files: %s\n' "$source_name" >&2
      exit 1
    fi
  ); then
    contract_fail "sourcing changed caller state: $source_name"
  fi
}

assert_no_remove_call() {
  local log_file="$1"
  if grep -Eq '^(container rm|volume rm)( |$)' "$log_file"; then
    contract_fail "validation failure reached Docker removal: $(cat "$log_file")"
  fi
}

require_source_guard "$smoke_source"
require_source_guard "$startup_source"
require_source_guard "$persistence_source"
assert_source_is_inert "$smoke_source" smoke_root remove_smoke_container
assert_source_is_inert "$startup_source" suffix remove_runtime_container
assert_source_is_inert "$persistence_source" suffix remove_owned_container

init_status=0
(
  source_runner_functions "$smoke_source"
  fake_log="$contract_root/smoke-validation.log"
  : >"$fake_log"
  smoke_root='/tmp/trellage-codex-smoke-owned'
  container_name='trellage-codex-smoke-owned-container'
  container_id='smoke-container-id'
  volume_name='trellage-codex-smoke-owned-state'
  volume_created=1
  docker() {
    printf '%s\n' "$*" >>"$fake_log"
    case "$1 $2" in
      'container inspect'|'volume inspect') printf 'unrelated\n' ;;
    esac
  }
  if remove_smoke_container; then
    contract_fail 'smoke container validation failure reported success'
  fi
  [[ "$container_id" == 'smoke-container-id' ]] \
    || contract_fail 'smoke container validation failure cleared its ID'
  if remove_smoke_volume; then
    contract_fail 'smoke volume validation failure reported success'
  fi
  [[ "$volume_created" -eq 1 ]] \
    || contract_fail 'smoke volume validation failure cleared its tracked state'
  assert_no_remove_call "$fake_log"
)

(
  source_runner_functions "$startup_source"
  fake_log="$contract_root/startup-validation.log"
  : >"$fake_log"
  test_root='/tmp/trellage-codex-runtime-test.owned'
  container_name='trellage-codex-runtime-test-owned'
  container_id='startup-container-id'
  volume_name='trellage-codex-runtime-test-owned'
  volume_created=1
  docker() {
    printf '%s\n' "$*" >>"$fake_log"
    case "$1 $2" in
      'container inspect'|'volume inspect') printf 'unrelated\n' ;;
    esac
  }
  if remove_runtime_container; then
    contract_fail 'startup container validation failure reported success'
  fi
  [[ "$container_id" == 'startup-container-id' ]] \
    || contract_fail 'startup container validation failure cleared its ID'
  if remove_runtime_volume; then
    contract_fail 'startup volume validation failure reported success'
  fi
  [[ "$volume_created" -eq 1 ]] \
    || contract_fail 'startup volume validation failure cleared its tracked state'
  assert_no_remove_call "$fake_log"
)

(
  source_runner_functions "$persistence_source"
  fake_log="$contract_root/persistence-validation.log"
  : >"$fake_log"
  test_root='/tmp/trellage-codex-persistence-test.owned'
  container_name='trellage-codex-persistence-test-owned'
  container_id='persistence-container-id'
  volume_name='trellage-codex-persistence-test-owned'
  volume_created=1
  docker() {
    printf '%s\n' "$*" >>"$fake_log"
    case "$1 $2" in
      'container inspect'|'volume inspect') printf 'unrelated\n' ;;
    esac
  }
  if remove_owned_container; then
    contract_fail 'persistence container validation failure reported success'
  fi
  [[ "$container_id" == 'persistence-container-id' ]] \
    || contract_fail 'persistence container validation failure cleared its ID'
  if remove_owned_volume; then
    contract_fail 'persistence volume validation failure reported success'
  fi
  [[ "$volume_created" -eq 1 ]] \
    || contract_fail 'persistence volume validation failure cleared its tracked state'
  assert_no_remove_call "$fake_log"
)

(
  source_runner_functions "$smoke_source"
  fake_log="$contract_root/removal-failure.log"
  : >"$fake_log"
  smoke_root='/tmp/trellage-codex-smoke-owned'
  container_name='trellage-codex-smoke-owned-container'
  container_id='smoke-container-id'
  volume_name='trellage-codex-smoke-owned-state'
  volume_created=1
  docker() {
    printf '%s\n' "$*" >>"$fake_log"
    case "$1 $2" in
      'container inspect')
        printf '%s\ttrellage-codex\t%s\n' "$container_id" "$smoke_root"
        ;;
      'volume inspect')
        printf 'trellage-codex\t%s\n' "$smoke_root"
        ;;
      'container rm'|'volume rm') return 1 ;;
    esac
  }
  if remove_smoke_container; then
    contract_fail 'failed container removal reported success'
  fi
  [[ "$container_id" == 'smoke-container-id' ]] \
    || contract_fail 'failed container removal cleared its ID'
  if remove_smoke_volume; then
    contract_fail 'failed volume removal reported success'
  fi
  [[ "$volume_created" -eq 1 ]] \
    || contract_fail 'failed volume removal cleared its tracked state'
)

(
  source_runner_functions "$persistence_source"
  child_pid_file="$contract_root/watchdog-child.pid"
  watchdog_status=0
  run_with_watchdog 1 bash -c '
    printf "%s\n" "$$" >"$1"
    trap "exit 0" TERM
    while :; do sleep 1; done
  ' _ "$child_pid_file" || watchdog_status=$?
  [[ "$watchdog_status" -eq 124 ]] \
    || contract_fail "watchdog returned $watchdog_status instead of 124"
  child_pid="$(cat "$child_pid_file")"
  if kill -0 "$child_pid" 2>/dev/null; then
    contract_fail "watchdog left child running: $child_pid"
  fi
)

(
  source_runner_functions "$smoke_source"
  copilot_root="$contract_root/copilot-preassignment"
  mkdir "$copilot_root"
  printf '%s\n' "$copilot_root" >"$copilot_root/.trellage-copilot-smoke-owner"
  copilot_resource_names
  copilot_container_id=
  copilot_login_container_id=
  copilot_volume_name=
  copilot_login_volume_name=
  fake_log="$contract_root/copilot-preassignment.log"
  : >"$fake_log"
  docker() {
    case "$1 $2" in
      'container inspect')
        target="${@: -1}"
        if [[ "$target" == "$copilot_container_name" ]]; then
          printf 'primary-id\n'
        elif [[ "$target" == "$copilot_login_container_name" ]]; then
          printf 'login-id\n'
        elif [[ "$*" == *'.Name'* && "$target" == primary-id ]]; then
          printf '/%s\n' "$copilot_container_name"
        elif [[ "$*" == *'.Name'* && "$target" == login-id ]]; then
          printf '/%s\n' "$copilot_login_container_name"
        elif [[ "$target" == primary-id ]]; then
          printf 'primary-id\ttrellage-copilot\t%s\tcopilot-hve\n' "$copilot_root"
        elif [[ "$target" == login-id ]]; then
          printf 'login-id\ttrellage-copilot-smoke\t%s\tcopilot-hve\n' "$copilot_root"
        else
          return 1
        fi
        ;;
      'container rm') printf '%s\n' "${@: -1}" >>"$fake_log" ;;
      'volume inspect') return 1 ;;
    esac
  }
  cleanup_copilot_smoke
  grep -Fqx primary-id "$fake_log" \
    || contract_fail 'cleanup missed a pre-assignment primary Copilot container'
  grep -Fqx login-id "$fake_log" \
    || contract_fail 'cleanup missed a pre-assignment login Copilot container'
)

(
  source_runner_functions "$smoke_source"
  failure_tmp="$contract_root/copilot-init-failure"
  mkdir "$failure_tmp"
  TMPDIR="$failure_tmp"
  copilot_profile="$tests_dir/../../../profiles/copilot-hve/profile.toml"
  docker() { return 1; }
  cp() { exit 77; }
  initialize_copilot_smoke
) || init_status=$?
[[ "$init_status" -eq 77 ]] \
  || contract_fail "Copilot initialization fixture exited $init_status instead of failing at pre-git copy"
if find "$contract_root/copilot-init-failure" -mindepth 1 -print -quit | grep -q .; then
  contract_fail 'Copilot initialization failure left its owned temporary root'
fi

(
  source_runner_functions "$smoke_source"
  sleep 60 &
  copilot_login_attach_pid=$!
  attach_pid="$copilot_login_attach_pid"
  start_seconds=$SECONDS
  stop_copilot_login_attach 1 1 2>/dev/null
  (( SECONDS - start_seconds <= 4 )) \
    || contract_fail 'hung Copilot login attach cleanup exceeded its bound'
  [[ -z "$copilot_login_attach_pid" ]] \
    || contract_fail 'hung Copilot login attach cleanup retained its PID'
  ! kill -0 "$attach_pid" 2>/dev/null \
    || contract_fail 'hung Copilot login attach client survived bounded cleanup'
)

printf 'Trellage cleanup behavior test: PASS\n'
