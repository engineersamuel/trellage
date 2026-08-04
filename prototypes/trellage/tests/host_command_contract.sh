#!/usr/bin/env bash
set -euo pipefail

prototype_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
test_root="$(mktemp -d "${TMPDIR:-/tmp}/trellage-codex-host-test.XXXXXX")"
test_root="$(cd "$test_root" && pwd -P)"
trap 'rm -rf -- "$test_root"' EXIT
export TRELLAGE_ENVIRONMENT=off

fail() {
  printf 'Trellage host test: FAIL: %s\n' "$1" >&2
  exit 1
}

fake_bin="$test_root/fake-bin"
mkdir -p "$fake_bin"
ln -s "$prototype_dir/tests/fakes/host-docker" "$fake_bin/docker"
ln -s "$prototype_dir/tests/fakes/host-git" "$fake_bin/git"
ln -s "$prototype_dir/tests/fakes/host-mise" "$fake_bin/mise"

real_node="$(command -v node)"
runtime_hash="$($real_node "$prototype_dir/../../packages/trellage-cli/dist/cli.js" metadata \
  "$prototype_dir/../../profiles/codex-superpowers/profile.toml" | jq -er '.runtime_hash')"
export FAKE_DOCKER_IMAGE_RUNTIME_HASH="$runtime_hash"
export FAKE_DOCKER_CONTAINER_RUNTIME_HASH="$runtime_hash"
host_node_log="$test_root/host-node.log"
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'set -euo pipefail' \
  'printf '\''CALL\n'\'' >>"$FAKE_NODE_LOG"' \
  'printf '\''ENV\tCOPILOT_GITHUB_TOKEN=%s\n'\'' "${COPILOT_GITHUB_TOKEN:+present}" >>"$FAKE_NODE_LOG"' \
  'printf '\''ENV\tGH_TOKEN=%s\n'\'' "${GH_TOKEN:+present}" >>"$FAKE_NODE_LOG"' \
  'printf '\''ENV\tGITHUB_TOKEN=%s\n'\'' "${GITHUB_TOKEN:+present}" >>"$FAKE_NODE_LOG"' \
  'for internal_name in ambient_copilot_github_token ambient_gh_token ambient_github_token copilot_token secret_value secret_source_values; do' \
  '  [[ -z "${!internal_name:-}" ]] || internal_state=present' \
  '  printf '\''ENV\t%s=%s\n'\'' "$internal_name" "${internal_state:-}" >>"$FAKE_NODE_LOG"' \
  '  internal_state=' \
  'done' \
  'printf '\''ARG\t%s\n'\'' "$@" >>"$FAKE_NODE_LOG"' \
  'if [[ "${2:-}" == choices && -n "${FAKE_PROFILE_CHOICES:-}" ]]; then' \
  '  exec cat "$FAKE_PROFILE_CHOICES"' \
  'fi' \
  'if [[ "${2:-}" == metadata && -n "${FAKE_PROFILE_METADATA:-}" ]]; then' \
  '  exec cat "$FAKE_PROFILE_METADATA"' \
  'fi' \
  'if [[ "${1:-}" == */terminal-picker.mjs && -n "${FAKE_PICKER_INPUT:-}" ]]; then' \
  '  cat >"$FAKE_PICKER_INPUT"' \
  '  printf '\''0\n'\''' \
  '  exit 0' \
  'fi' \
  'exec "$FAKE_REAL_NODE" "$@"' \
  >"$fake_bin/node"
chmod +x "$fake_bin/node"
: >"$host_node_log"
export FAKE_NODE_LOG="$host_node_log"
export FAKE_REAL_NODE="$real_node"
copilot_fake_bin="$test_root/copilot-fake-bin"
copilot_metadata="$test_root/copilot-metadata.json"
pi_metadata="$test_root/pi-metadata.json"
copilot_profile="$test_root/copilot-profile.toml"
copilot_node_log="$test_root/copilot-node.log"
copilot_gh_log="$test_root/copilot-gh.log"
mkdir -p "$copilot_fake_bin"
ln -s "$prototype_dir/tests/fakes/host-gh" "$copilot_fake_bin/gh"
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'set -euo pipefail' \
  'printf '\''CALL\n'\'' >>"$FAKE_NODE_LOG"' \
  'printf '\''ENV\tCOPILOT_GITHUB_TOKEN=%s\n'\'' "${COPILOT_GITHUB_TOKEN:+present}" >>"$FAKE_NODE_LOG"' \
  'printf '\''ENV\tGH_TOKEN=%s\n'\'' "${GH_TOKEN:+present}" >>"$FAKE_NODE_LOG"' \
  'printf '\''ENV\tGITHUB_TOKEN=%s\n'\'' "${GITHUB_TOKEN:+present}" >>"$FAKE_NODE_LOG"' \
  'for internal_name in ambient_copilot_github_token ambient_gh_token ambient_github_token copilot_token secret_value secret_source_values; do' \
  '  [[ -z "${!internal_name:-}" ]] || internal_state=present' \
  '  printf '\''ENV\t%s=%s\n'\'' "$internal_name" "${internal_state:-}" >>"$FAKE_NODE_LOG"' \
  '  internal_state=' \
  'done' \
  'printf '\''ARG\t%s\n'\'' "$@" >>"$FAKE_NODE_LOG"' \
  '[[ "${2:-}" == metadata ]] || exec "$FAKE_REAL_NODE" "$@"' \
  'exec cat "$FAKE_HARNESS_METADATA"' \
  >"$copilot_fake_bin/node"
chmod +x "$copilot_fake_bin/node"
no_gh_bin="$test_root/no-gh-bin"
mkdir -p "$no_gh_bin"
for utility in bash env jq awk sed tr shasum dirname basename readlink head grep cat cut sleep; do
  ln -s "$(command -v "$utility")" "$no_gh_bin/$utility"
done
ln -s "$prototype_dir/tests/fakes/host-docker" "$no_gh_bin/docker"
ln -s "$prototype_dir/tests/fakes/host-git" "$no_gh_bin/git"
ln -s "$prototype_dir/tests/fakes/host-mise" "$no_gh_bin/mise"
ln -s "$copilot_fake_bin/node" "$no_gh_bin/node"
: >"$copilot_profile"
jq -n \
  --arg profile "$copilot_profile" \
  --arg runtime_hash "$runtime_hash" \
  '{
    profile_path: $profile,
    profile_name: "copilot-hve-test",
    profile_hash: "sha256:a0f20c294ed9c92e463d3555300e4144752d944bf721124ed1dc85f700a231dd",
    runtime_hash: $runtime_hash,
    image: "trellage-profile-copilot-hve-test:locked",
    locked: true,
    build_command: ("trellage build " + $profile),
    harness_args: ["--allow-all"],
    secrets_provider: "env",
    required_secrets: [],
    secret_environment: {},
    resolved_varlock_path: null,
    has_initial_prompt: false,
    harness_kind: "copilot",
    harness_executable: "copilot",
    runtime_entry: "trellage-copilot-entry",
    default_network: "bridge",
    auth_policy: "host-or-login",
    resolved_version: "1.0.75",
    tmpfs_size: "256m"
  }' >"$copilot_metadata"
jq -n \
  --arg profile "$copilot_profile" \
  --arg runtime_hash "$runtime_hash" \
  '{
    profile_path: $profile,
    profile_name: "pi-oh-my-pi-test",
    profile_hash: "sha256:a8f03f553835e2bece7ca36446fc5d2189e51c3590c7dd6cb35c8f9f63ed1972",
    runtime_hash: $runtime_hash,
    image: "trellage-profile-pi-oh-my-pi-test:locked",
    locked: true,
    build_command: ("trellage build " + $profile),
    harness_args: ["--yolo"],
    secrets_provider: "env",
    required_secrets: [],
    secret_environment: {},
    resolved_varlock_path: null,
    has_initial_prompt: false,
    harness_kind: "pi",
    harness_executable: "omp",
    runtime_entry: "trellage-pi-entry",
    default_network: "bridge",
    auth_policy: "host-or-login",
    resolved_version: "17.2.6"
  }' >"$pi_metadata"
: >"$copilot_node_log"
: >"$copilot_gh_log"

poisoned_internal_auth_env=(
  ambient_copilot_github_token=poison-ambient-copilot-canary
  ambient_gh_token=poison-ambient-gh-canary
  ambient_github_token=poison-ambient-github-canary
  copilot_token=poison-copilot-token-canary
  secret_value=poison-secret-value-canary
  secret_source_values=poison-secret-values-canary
)

run_tty() {
  local work_dir="$1"
  local docker_log="$2"
  local git_root="$3"
  shift 3
  mkdir -p "$git_root/.git"
  (
    cd "$work_dir"
    script -q -e /dev/null env \
      PATH="$fake_bin:$PATH" \
      GH_TOKEN=host-contract-gh-token \
      FAKE_DOCKER_LOG="$docker_log" \
      FAKE_GIT_LOG="$test_root/git.log" \
      FAKE_GIT_ROOT="$git_root" \
      FAKE_NODE_LOG="$host_node_log" \
      FAKE_REAL_NODE="$real_node" \
      "$@"
  )
}

run_copilot_tty() {
  local work_dir="$1"
  local docker_log="$2"
  local git_root="$3"
  shift 3
  run_tty "$work_dir" "$docker_log" "$git_root" \
    env PATH="$copilot_fake_bin:$fake_bin:$PATH" \
    FAKE_HARNESS_METADATA="${FAKE_HARNESS_METADATA_OVERRIDE:-$copilot_metadata}" \
    FAKE_NODE_LOG="$copilot_node_log" \
    FAKE_REAL_NODE="$real_node" \
    FAKE_GH_LOG="$copilot_gh_log" \
    "$@"
}

run_copilot_non_tty() {
  local work_dir="$1"
  local docker_log="$2"
  local git_root="$3"
  shift 3
  run_non_tty "$work_dir" "$docker_log" "$git_root" \
    env PATH="$copilot_fake_bin:$fake_bin:$PATH" \
    FAKE_HARNESS_METADATA="${FAKE_HARNESS_METADATA_OVERRIDE:-$copilot_metadata}" \
    FAKE_NODE_LOG="$copilot_node_log" \
    FAKE_REAL_NODE="$real_node" \
    FAKE_GH_LOG="$copilot_gh_log" \
    "$@"
}

resource_names() {
  local worktree="$1"
  local profile="${2:-codex-superpowers}"
  local harness_kind="${3:-codex}"
  local worktree_name resource_segment path_hash
  worktree_name="$(basename "$worktree")"
  resource_segment="$(printf '%s' "$worktree_name" \
    | tr '[:upper:]' '[:lower:]' \
    | sed -E 's/[^a-z0-9_.-]+/-/g; s/^[^a-z0-9]+//; s/[^a-z0-9]+$//')"
  path_hash="$(printf '%s' "$worktree" | shasum -a 256 | awk '{print $1}')"
  printf 'trellage-%s-%s-%s-%s\n' "$harness_kind" "$profile" "$resource_segment" "${path_hash:0:16}"
  printf 'trellage-%s-state-%s-%s-%s\n' "$harness_kind" "$profile" "$resource_segment" "${path_hash:0:16}"
}

assert_arg() {
  local log="$1"
  local value="$2"
  grep -Fqx $'ARG\t'"$value" "$log" || fail "missing Docker argument: $value"
}

assert_create_label() {
  local log="$1"
  local resource="$2"
  local label="$3"
  awk -v resource="$resource" -v expected="ARG\t$label" '
    $0 == "CALL" { argument = 0; first = second = previous = ""; next }
    /^ARG\t/ {
      argument++
      if (argument == 1) first = $0
      if (argument == 2) second = $0
      if (first == "ARG\t" resource && second == "ARG\tcreate" && previous == "ARG\t--label" && $0 == expected) found++
      previous = $0
    }
    END { exit(found == 1 ? 0 : 1) }
  ' "$log" || fail "missing exact $resource create label: $label"
}

assert_docker_env() {
  local log="$1"
  local value="$2"
  awk -v expected="$value" '
    previous == "ARG\t--env" && $0 == "ARG\t" expected { found = 1 }
    { previous = $0 }
    END { exit(found ? 0 : 1) }
  ' "$log" || fail "missing Docker environment: $value"
}

assert_terminal_contract() {
  local log="$1"
  local expected_colorterm="${2:-}"
  local expected_resume_profile="${3:-false}"
  local expected_env_count=1
  assert_docker_env "$log" 'TERM=xterm-256color'
  if [[ -n "$expected_colorterm" ]]; then
    expected_env_count=2
    assert_docker_env "$log" 'COLORTERM=truecolor'
  else
    ! grep -Eq $'ARG\tCOLORTERM=' "$log" \
      || fail 'unsupported COLORTERM reached Docker'
  fi
  if [[ "$expected_resume_profile" == true ]]; then
    expected_env_count=$((expected_env_count + 1))
    assert_docker_env "$log" TRELLAGE_RESUME_PROFILE
  fi
  [[ "$(grep -Fxc $'ARG\t--env' "$log")" -eq "$expected_env_count" ]] \
    || fail 'Docker received an unexpected terminal environment'
  ! grep -Eq $'ARG\t(NO_COLOR|TERM_PROGRAM|HERDR_AGENT)=' "$log" \
    || fail 'unsupported host environment reached Docker'
  ! grep -Fqx $'ARG\tTERM=host-term' "$log" \
    || fail 'arbitrary host TERM reached Docker'
}

assert_prompt_is_detached() {
  local log="$1"
  ! grep -Fqx $'ARG\t--interactive' "$log" \
    || fail 'portable prompt allocated interactive Docker stdin'
  ! grep -Fqx $'ARG\t--tty' "$log" \
    || fail 'portable prompt allocated a Docker TTY'
  ! grep -Eq $'ARG\t(TERM|COLORTERM)=' "$log" \
    || fail 'portable prompt injected terminal environment'
}

assert_codex_exec_hint() {
  local log="$1"
  [[ "$(grep -Fxc $'ENV\tHERDR_AGENT=codex' "$log")" -eq 1 ]] \
    || fail 'final Codex Docker exec lacks its exclusive agent hint'
  awk '
    /^ENV\tHERDR_AGENT=/ && $0 != "ENV\tHERDR_AGENT=" && $0 != "ENV\tHERDR_AGENT=codex" { exit 1 }
  ' "$log" || fail 'ambient HERDR_AGENT reached a wrapper Docker process'
  awk '
    $0 == "CALL" { agent = first = second = ""; next }
    /^ENV\tHERDR_AGENT=/ { agent = $0; next }
    /^ARG\t/ && first == "" { first = $0; next }
    /^ARG\t/ && second == "" {
      second = $0
      if (agent == "ENV\tHERDR_AGENT=codex" && first == "ARG\tcontainer" && second == "ARG\texec") {
        found++
      }
    }
    END { exit(found == 1 ? 0 : 1) }
  ' "$log" || fail 'Codex agent hint was not isolated to final container exec'
}

assert_no_agent_hint() {
  local log="$1"
  grep -Fqx $'ENV\tHERDR_AGENT=' "$log" \
    || fail 'fake Docker did not observe an empty agent hint'
  ! grep -Eq $'^ENV\tHERDR_AGENT=.+$' "$log" \
    || fail 'non-Codex Docker process received an agent hint'
}

assert_no_mutation() {
  local log="$1"
  ! grep -Fqx $'ARG\tcreate' "$log" || fail 'unexpected container create'
  ! grep -Fqx $'ARG\tstart' "$log" || fail 'unexpected container start'
  ! grep -Fqx $'ARG\tstop' "$log" || fail 'unexpected container stop'
  ! grep -Fqx $'ARG\texec' "$log" || fail 'unexpected container exec'
  ! grep -Fqx $'ARG\trm' "$log" || fail 'unexpected Docker removal'
}

run_non_tty() {
  local work_dir="$1"
  local docker_log="$2"
  local git_root="$3"
  shift 3
  mkdir -p "$git_root/.git"
  (
    cd "$work_dir"
    env \
      GH_TOKEN=host-contract-gh-token \
      PATH="$fake_bin:$PATH" \
      FAKE_DOCKER_LOG="$docker_log" \
      FAKE_GIT_LOG="$test_root/git.log" \
      FAKE_GIT_ROOT="$git_root" \
      FAKE_NODE_LOG="$host_node_log" \
      FAKE_REAL_NODE="$real_node" \
      "$@"
  )
}

test_new_container_from_subdirectory() {
  local worktree="$test_root/parent with spaces/Feature.Tree"
  local subdir="$worktree/src/deep"
  local docker_log="$test_root/new-container.docker.log"
  local create_line container_name mount_path state_volume
  mkdir -p "$subdir"
  : >"$docker_log"
  : >"$test_root/git.log"

  run_tty "$subdir" "$docker_log" "$worktree" \
    env TRELLAGE_IMAGE='test/image:locked' TRELLAGE_NETWORK='test_proxy_net' \
    "$prototype_dir/trellage" 'fix $(touch /tmp/not-executed)' 'with spaces'

  grep -Fqx $'PWD\t'"$subdir" "$test_root/git.log" \
    || fail 'Git root was not resolved from invocation subdirectory'
  mount_path='/mounts/Feature.Tree'
  state_volume="$(resource_names "$worktree" | tail -n 1)"
  assert_arg "$docker_log" 'test/image:locked'
  assert_arg "$docker_log" 'test_proxy_net'
  assert_arg "$docker_log" 'fake-container-id'
  assert_arg "$docker_log" '--user'
  assert_arg "$docker_log" '10001:10001'
  assert_arg "$docker_log" '--read-only'
  assert_arg "$docker_log" '--cap-drop'
  assert_arg "$docker_log" 'ALL'
  assert_arg "$docker_log" '--security-opt'
  assert_arg "$docker_log" 'no-new-privileges'
  assert_arg "$docker_log" '--pids-limit'
  assert_arg "$docker_log" '256'
  assert_arg "$docker_log" '--memory'
  assert_arg "$docker_log" '2g'
  assert_arg "$docker_log" '--cpus'
  assert_arg "$docker_log" '2'
  assert_arg "$docker_log" "type=bind,src=$worktree/.git,dst=$worktree/.git"
  assert_arg "$docker_log" '--tmpfs'
  assert_arg "$docker_log" '/tmp:rw,noexec,nosuid,nodev,size=256m,uid=10001,gid=10001'
  assert_arg "$docker_log" "type=bind,src=$worktree,dst=$mount_path"
  assert_arg "$docker_log" "type=volume,src=$state_volume,dst=/home/agent"
  assert_arg "$docker_log" "dev.trellage.worktree=$worktree"
  assert_arg "$docker_log" 'dev.trellage.prototype=trellage-codex'
  assert_arg "$docker_log" "$mount_path"
  assert_arg "$docker_log" 'fish'
  assert_arg "$docker_log" '-Nlc'
  [[ "$(grep -Fxc $'ARG\t--mount' "$docker_log")" -eq 3 ]] \
    || fail 'container must receive worktree, Git metadata, and state mounts'
  assert_arg "$docker_log" 'fix $(touch /tmp/not-executed) with spaces'
  assert_docker_env "$docker_log" 'GH_CONFIG_DIR=/tmp/trellage-gh'
  assert_docker_env "$docker_log" 'GIT_CONFIG_GLOBAL=/tmp/trellage-gh/gitconfig'
  grep -Fq 'gh auth login --hostname "$GH_HOST" --with-token' "$docker_log" \
    || fail 'GitHub CLI session was not configured from standard input'
  ! grep -Fq $'ARG\tGH_TOKEN=host-contract-gh-token' "$docker_log" \
    || fail 'GitHub token was passed directly to the agent container'

  [[ "$(grep -Fxc $'ARG\t--label' "$docker_log")" -eq 8 ]] \
    || fail 'Codex container and volume must receive exact ownership and container integrity labels'
  assert_arg "$docker_log" 'dev.trellage.profile=codex-superpowers'
  assert_arg "$docker_log" "dev.trellage.profile.hash=sha256:a0f20c294ed9c92e463d3555300e4144752d944bf721124ed1dc85f700a231dd"
  assert_arg "$docker_log" "dev.trellage.runtime.hash=$runtime_hash"
  [[ "$(grep -Fxc $'ARG\t--network' "$docker_log")" -eq 1 ]] \
    || fail 'container must receive exactly one network'
  ! grep -Eq $'ARG\t.*(docker\.sock|herdr)' "$docker_log" \
    || fail 'forbidden host resource was mounted'

  create_line="$(grep -n -F $'ARG\tcreate' "$docker_log" | head -n 1 | cut -d: -f1)"
  [[ "$(grep -n -F $'ARG\tinspect' "$docker_log" | head -n 2 | tail -n 1 | cut -d: -f1)" -lt "$create_line" ]] \
    || fail 'image and network were not validated before mutation'
  container_name="$(resource_names "$worktree" | head -n 1)"
  assert_arg "$docker_log" "$container_name"
  printf 'Trellage host test: PASS: secure new container from subdirectory\n'
}

test_resume_uses_native_thread_without_prompt_replay() {
  local worktree="$test_root/literal-prompt-worktree"
  local docker_log="$test_root/literal-prompt.docker.log"
  mkdir -p "$worktree"
  : >"$docker_log"

  local state_volume
  state_volume="$(resource_names "$worktree" | tail -n 1)"
  FAKE_DOCKER_VOLUME_STATE=matching FAKE_DOCKER_STATE_VOLUME="$state_volume" \
    FAKE_DOCKER_CONTAINER_STATE=matching-running \
    run_tty "$worktree" "$docker_log" "$worktree" "$prototype_dir/trellage" resume
  grep -Fqx $'ARG\texec trellage-codex-entry resume codex $argv' "$docker_log" \
    || fail 'resume did not delegate native thread selection to runtime helper'
  ! grep -Fqx $'ARG\tset prompt $argv[-1]; set -e argv[-1]; exec trellage-codex-entry new codex $argv -- $prompt' "$docker_log" \
    || fail 'resume replayed the new-session startup path'

  : >"$docker_log"
  local resume_session_id='5b3664c0-9954-4526-8aab-d3d2c177798d'
  FAKE_DOCKER_VOLUME_STATE=matching FAKE_DOCKER_STATE_VOLUME="$state_volume" \
    FAKE_DOCKER_CONTAINER_STATE=matching-running \
    run_tty "$worktree" "$docker_log" "$worktree" \
      "$prototype_dir/trellage" resume "$resume_session_id"
  assert_arg "$docker_log" TRELLAGE_RESUME_SESSION_ID
  assert_arg "$docker_log" TRELLAGE_RESUME_PROFILE
  grep -Fqx $'ARG\texec trellage-codex-entry resume codex $argv' "$docker_log" \
    || fail 'exact resume did not delegate native thread selection to runtime helper'

  : >"$docker_log"
  FAKE_DOCKER_VOLUME_STATE=matching FAKE_DOCKER_STATE_VOLUME="$state_volume" \
    FAKE_DOCKER_CONTAINER_STATE=matching-running \
    run_tty "$worktree" "$docker_log" "$worktree" \
      "$prototype_dir/trellage" --sandbox danger-full-access
  grep -Fqx $'ARG\tset prompt $argv[-1]; set -e argv[-1]; exec trellage-codex-entry new codex $argv -- $prompt' "$docker_log" \
    || fail 'option-like prompt lacks Codex option boundary'
  [[ "$(tail -n 1 "$docker_log")" == $'ARG\t--sandbox danger-full-access' ]] \
    || fail 'option-like prompt was not passed as one literal positional prompt'
  ! grep -Fqx $'ARG\t--sandbox' "$docker_log" \
    || fail 'option-like prompt leaked into Codex option argv'
  printf 'Trellage host test: PASS: native resume does not replay startup prompt\n'
}

test_bare_command_has_no_prompt() {
  local worktree="$test_root/bare-worktree"
  local docker_log="$test_root/bare.docker.log"
  mkdir -p "$worktree"
  : >"$docker_log"
  local state_volume
  state_volume="$(resource_names "$worktree" | tail -n 1)"

  FAKE_DOCKER_VOLUME_STATE=matching FAKE_DOCKER_STATE_VOLUME="$state_volume" \
    FAKE_DOCKER_CONTAINER_STATE=matching-running \
    run_tty "$worktree" "$docker_log" "$worktree" "$prototype_dir/trellage"

  grep -Fqx $'ARG\texec trellage-codex-entry new codex $argv' "$docker_log" \
    || fail 'bare command did not enter Codex through Fish'
  [[ "$(tail -n 1 "$docker_log")" == $'ARG\t--dangerously-bypass-approvals-and-sandbox' ]] \
    || fail 'bare command did not pass the profile Codex argument'
  ! grep -Fqx $'ARG\tcreate' "$docker_log" || fail 'running matching container was recreated'
  ! grep -Fqx $'ARG\tstart' "$docker_log" || fail 'running matching container was restarted'
  grep -Fqx $'ARG\tfake-container-id' "$docker_log" \
    || fail 'running container was not attached by immutable ID'
  printf 'Trellage host test: PASS: bare command injects no prompt\n'
}

test_portable_prompt_mode_is_noninteractive_and_literal() {
  local worktree="$test_root/portable-prompt-worktree"
  local docker_log="$test_root/portable-prompt.docker.log"
  local state_volume prompt
  mkdir -p "$worktree"
  : >"$docker_log"
  state_volume="$(resource_names "$worktree" | tail -n 1)"
  prompt='literal $(touch /tmp/not-executed) prompt'

  FAKE_DOCKER_VOLUME_STATE=matching FAKE_DOCKER_STATE_VOLUME="$state_volume" \
    FAKE_DOCKER_CONTAINER_STATE=matching-running \
    run_non_tty "$worktree" "$docker_log" "$worktree" \
      "$prototype_dir/trellage" --profile codex-superpowers -p "$prompt"

  grep -Fqx $'ARG\tset prompt $argv[-1]; set -e argv[-1]; exec trellage-codex-entry prompt codex $argv -- $prompt' "$docker_log" \
    || fail 'portable prompt did not use the Codex runtime prompt boundary'
  [[ "$(tail -n 1 "$docker_log")" == $'ARG\t'"$prompt" ]] \
    || fail 'portable prompt text was not passed as one literal argument'
  assert_prompt_is_detached "$docker_log"
  printf 'Trellage host test: PASS: portable prompt is noninteractive and literal\n'
}

test_portable_prompt_is_detached_for_each_harness() {
  local worktree="$test_root/portable-prompt-harness-worktree"
  local docker_log="$test_root/portable-prompt-harness.docker.log"
  local claude_variant="$test_root/portable-prompt-claude.json"
  local state_volume
  mkdir -p "$worktree"

  state_volume="$(resource_names "$worktree" copilot-hve-test copilot | tail -n 1)"
  : >"$docker_log"
  FAKE_GH_STATE=failure \
    FAKE_DOCKER_VOLUME_STATE=matching FAKE_DOCKER_STATE_VOLUME="$state_volume" \
    FAKE_DOCKER_CONTAINER_STATE=matching-running \
    FAKE_DOCKER_PROFILE=copilot-hve-test FAKE_DOCKER_PROTOTYPE=trellage-copilot \
    run_copilot_non_tty "$worktree" "$docker_log" "$worktree" \
      env TERM=host-term COLORTERM=truecolor TRELLAGE_IMAGE='test/copilot:locked' \
      "$prototype_dir/trellage" -p 'Copilot prompt'
  grep -Fqx $'ARG\tset prompt $argv[-1]; set -e argv[-1]; exec trellage-copilot-entry prompt $argv -- $prompt' "$docker_log" \
    || fail 'portable Copilot prompt did not use its runtime prompt boundary'
  assert_prompt_is_detached "$docker_log"

  jq \
    '.profile_name = "claude-hyperresearch"
      | .image = "trellage-profile-claude-hyperresearch:locked"
      | .harness_kind = "claude"
      | .harness_executable = "claude"
      | .runtime_entry = "trellage-claude-entry"
      | .default_network = "copilot-proxy-rs_default"
      | .auth_policy = "claude-explicit"
      | .claude_mode = "hyperresearch"
      | .claude_gateway = "http://copilot-proxy-rs:8080"
      | .claude_opus_model = "claude-opus-5"
      | .claude_sonnet_model = "claude-sonnet-5"
      | .claude_haiku_model = "claude-haiku-4.5"
      | .harness_args = []' \
    "$copilot_metadata" >"$claude_variant"
  state_volume="$(resource_names "$worktree" claude-hyperresearch claude | tail -n 1)"
  : >"$docker_log"
  FAKE_HARNESS_METADATA_OVERRIDE="$claude_variant" \
    FAKE_DOCKER_VOLUME_STATE=matching FAKE_DOCKER_STATE_VOLUME="$state_volume" \
    FAKE_DOCKER_CONTAINER_STATE=matching-running \
    FAKE_DOCKER_PROFILE=claude-hyperresearch FAKE_DOCKER_PROTOTYPE=trellage-claude \
    run_copilot_non_tty "$worktree" "$docker_log" "$worktree" \
      env TERM=host-term COLORTERM=truecolor TRELLAGE_IMAGE='test/claude:locked' \
      "$prototype_dir/trellage" -p 'Claude prompt'
  grep -Fqx $'ARG\tset prompt $argv[-1]; set -e argv[-1]; exec trellage-claude-entry prompt claude $argv -- $prompt' "$docker_log" \
    || fail 'portable Claude prompt did not use its runtime prompt boundary'
  assert_prompt_is_detached "$docker_log"
  printf 'Trellage host test: PASS: all portable prompt launches are detached\n'
}

test_portable_prompt_parser_contract() {
  local worktree="$test_root/portable-prompt-parser-worktree"
  local docker_log="$test_root/portable-prompt-parser.docker.log"
  local state_volume output status
  mkdir -p "$worktree"
  state_volume="$(resource_names "$worktree" | tail -n 1)"

  for prompt_form in '-p' '--prompt' '--prompt=long-form-equals'; do
    : >"$docker_log"
    if [[ "$prompt_form" == -p ]]; then
      launch_args=(-p 'short form value' --profile codex-superpowers)
      expected_prompt='short form value'
    elif [[ "$prompt_form" == --prompt ]]; then
      launch_args=(--profile codex-superpowers --prompt 'long form value')
      expected_prompt='long form value'
    else
      launch_args=(--profile codex-superpowers "$prompt_form")
      expected_prompt='long-form-equals'
    fi
    FAKE_DOCKER_VOLUME_STATE=matching FAKE_DOCKER_STATE_VOLUME="$state_volume" \
      FAKE_DOCKER_CONTAINER_STATE=matching-running \
      run_non_tty "$worktree" "$docker_log" "$worktree" \
        "$prototype_dir/trellage" "${launch_args[@]}"
    [[ "$(tail -n 1 "$docker_log")" == $'ARG\t'"$expected_prompt" ]] \
      || fail "$prompt_form did not preserve its prompt as one argument"
  done

  while IFS='|' read -r expected arguments; do
    : >"$docker_log"
    status=0
    read -r -a rejected_args <<<"$arguments"
    output="$(run_non_tty "$worktree" "$docker_log" "$worktree" \
      "$prototype_dir/trellage" "${rejected_args[@]}" 2>&1)" || status=$?
    [[ "$status" -ne 0 ]] || fail "invalid prompt form succeeded: $arguments"
    grep -Fq "trellage: $expected" <<<"$output" \
      || fail "invalid prompt form had the wrong diagnostic: $arguments"
    assert_no_mutation "$docker_log"
  done <<'CASES'
--prompt requires a non-empty value|-p
--prompt requires a non-empty value|--prompt
--prompt requires a non-empty value|--prompt=
--prompt may be specified only once|-p first --prompt second
--prompt may be specified only once|--prompt first --prompt=second
--prompt may be specified only once|--prompt=first -p second
--prompt cannot be combined with positional arguments|resume -p hello
--prompt cannot be combined with positional arguments|-p hello resume
--prompt cannot be combined with positional arguments|shell --prompt hello
--prompt cannot be combined with positional arguments|stop --prompt=hello
--prompt cannot be combined with positional arguments|doctor -p hello
--prompt cannot be combined with positional arguments|destroy --prompt hello
--prompt cannot be combined with positional arguments|positional -p hello
--prompt is not supported for compiler commands|build --prompt hello
--prompt is not supported for compiler commands|validate -p hello
--prompt is not supported for compiler commands|lock --prompt hello
--prompt is not supported for compiler commands|upgrade --prompt=hello
resume session ID must be a UUID|resume not-a-session-id
resume accepts at most one session ID|resume 5b3664c0-9954-4526-8aab-d3d2c177798d 45f2aaf8-1064-4162-bc09-58808d5819d8
CASES

  : >"$docker_log"
  status=0
  FAKE_DOCKER_VOLUME_STATE=matching FAKE_DOCKER_STATE_VOLUME="$state_volume" \
    FAKE_DOCKER_CONTAINER_STATE=matching-running FAKE_DOCKER_EXEC_EXIT=37 \
    run_non_tty "$worktree" "$docker_log" "$worktree" \
      "$prototype_dir/trellage" -p 'status propagation' >/dev/null 2>&1 \
    || status=$?
  [[ "$status" -eq 37 ]] || fail 'portable prompt changed the harness exit status'
  printf 'Trellage host test: PASS: portable prompt parser forms and errors\n'
}

test_stopped_and_collision_behavior() {
  local worktree="$test_root/reuse-worktree"
  local docker_log="$test_root/reuse.docker.log"
  mkdir -p "$worktree"
  : >"$docker_log"
  local state_volume
  state_volume="$(resource_names "$worktree" | tail -n 1)"

  FAKE_DOCKER_VOLUME_STATE=matching FAKE_DOCKER_STATE_VOLUME="$state_volume" \
    FAKE_DOCKER_CONTAINER_STATE=matching-stopped \
    run_tty "$worktree" "$docker_log" "$worktree" "$prototype_dir/trellage"
  grep -Fqx $'ARG\tstart' "$docker_log" || fail 'matching stopped container was not started'
  ! grep -Fqx $'ARG\tcreate' "$docker_log" || fail 'matching stopped container was recreated'
  grep -Fqx $'ARG\tfake-container-id' "$docker_log" \
    || fail 'stopped container was not started by immutable ID'

  : >"$docker_log"
  if FAKE_DOCKER_VOLUME_STATE=matching FAKE_DOCKER_STATE_VOLUME="$state_volume" \
    FAKE_DOCKER_CONTAINER_STATE=unrelated \
    run_tty "$worktree" "$docker_log" "$worktree" "$prototype_dir/trellage"; then
    fail 'unrelated container name collision was accepted'
  fi
  assert_no_mutation "$docker_log"

  : >"$docker_log"
  if FAKE_DOCKER_VOLUME_STATE=matching FAKE_DOCKER_STATE_VOLUME="$state_volume" \
    FAKE_DOCKER_CONTAINER_STATE=matching-worktree-prefix \
    run_tty "$worktree" "$docker_log" "$worktree" "$prototype_dir/trellage"; then
    fail 'worktree label prefix collision was accepted'
  fi
  assert_no_mutation "$docker_log"
  printf 'Trellage host test: PASS: stopped reuse and collision rejection\n'
}

test_stale_container_preserves_active_sessions() {
  local worktree="$test_root/stale-active-worktree"
  local docker_log="$test_root/stale-active.docker.log"
  local state_volume output
  mkdir -p "$worktree"
  state_volume="$(resource_names "$worktree" | tail -n 1)"
  : >"$docker_log"

  if output="$(
    FAKE_DOCKER_VOLUME_STATE=matching FAKE_DOCKER_STATE_VOLUME="$state_volume" \
      FAKE_DOCKER_CONTAINER_STATE=matching-running \
      FAKE_DOCKER_CONTAINER_RUNTIME_HASH=sha256:stale \
      FAKE_DOCKER_ACTIVE_SESSION=1 \
      run_non_tty "$worktree" "$docker_log" "$worktree" \
        "$prototype_dir/trellage" -p test 2>&1
  )"; then
    fail 'stale container replacement killed an active session'
  fi
  grep -Fq 'profile container is stale but has an active session; exit it and retry' <<<"$output" \
    || fail 'stale active session did not produce a clear diagnostic'
  ! grep -Fqx $'ARG\trm' "$docker_log" || fail 'stale active container was removed'

  : >"$docker_log"
  FAKE_DOCKER_VOLUME_STATE=matching FAKE_DOCKER_STATE_VOLUME="$state_volume" \
    FAKE_DOCKER_CONTAINER_STATE=matching-running \
    FAKE_DOCKER_CONTAINER_RUNTIME_HASH=sha256:stale \
    run_non_tty "$worktree" "$docker_log" "$worktree" \
      "$prototype_dir/trellage" -p test
  grep -Fqx $'ARG\trm' "$docker_log" || fail 'idle stale container was not replaced'
  printf 'Trellage host test: PASS: stale containers preserve active sessions\n'
}

test_volume_collision_and_mount_validation() {
  local worktree="$test_root/volume-worktree"
  local docker_log="$test_root/volume.docker.log"
  local state_volume
  mkdir -p "$worktree"
  state_volume="$(resource_names "$worktree" | tail -n 1)"
  : >"$docker_log"

  if FAKE_DOCKER_VOLUME_STATE=unrelated FAKE_DOCKER_STATE_VOLUME="$state_volume" \
    run_tty "$worktree" "$docker_log" "$worktree" "$prototype_dir/trellage"; then
    fail 'unrelated state volume collision was accepted'
  fi
  assert_no_mutation "$docker_log"

  : >"$docker_log"
  if FAKE_DOCKER_VOLUME_STATE=matching FAKE_DOCKER_STATE_VOLUME="$state_volume" \
    FAKE_DOCKER_CONTAINER_STATE=matching-wrong-mount \
    run_tty "$worktree" "$docker_log" "$worktree" "$prototype_dir/trellage"; then
    fail 'matching-label container with wrong state mount was accepted'
  fi
  assert_no_mutation "$docker_log"

  : >"$docker_log"
  if FAKE_DOCKER_VOLUME_STATE=absent FAKE_DOCKER_STATE_VOLUME="$state_volume" \
    FAKE_DOCKER_CONTAINER_STATE=matching-wrong-mount \
    run_tty "$worktree" "$docker_log" "$worktree" "$prototype_dir/trellage"; then
    fail 'mismatched existing container with absent volume was accepted'
  fi
  assert_no_mutation "$docker_log"
  printf 'Trellage host test: PASS: volume collision and mount mismatch rejected\n'
}

test_shell_and_stop_modes() {
  local worktree="$test_root/recovery-worktree"
  local docker_log="$test_root/recovery.docker.log"
  local state_volume
  mkdir -p "$worktree"
  state_volume="$(resource_names "$worktree" | tail -n 1)"
  : >"$docker_log"

  FAKE_DOCKER_VOLUME_STATE=matching FAKE_DOCKER_STATE_VOLUME="$state_volume" \
    FAKE_DOCKER_CONTAINER_STATE=matching-running \
    run_tty "$worktree" "$docker_log" "$worktree" "$prototype_dir/trellage" shell
  grep -Fqx $'ARG\texec fish -l' "$docker_log" \
    || fail 'shell did not open recovery Fish'
  ! grep -Fq $'ARG\tcodex' "$docker_log" || fail 'shell launched Codex'

  : >"$docker_log"
  FAKE_DOCKER_VOLUME_STATE=matching FAKE_DOCKER_STATE_VOLUME="$state_volume" \
    FAKE_DOCKER_CONTAINER_STATE=absent \
    run_tty "$worktree" "$docker_log" "$worktree" "$prototype_dir/trellage" shell
  [[ "$(grep -Fxc $'ARG\tcreate' "$docker_log")" -eq 1 ]] \
    || fail 'missing-container recovery did not reuse the existing state volume'
  assert_arg "$docker_log" "type=volume,src=$state_volume,dst=/home/agent"
  grep -Fqx $'ARG\texec fish -l' "$docker_log" \
    || fail 'recreated container did not open recovery Fish'

  : >"$docker_log"
  (
    cd "$worktree"
    PATH="$fake_bin:$PATH" FAKE_DOCKER_LOG="$docker_log" \
      FAKE_GIT_LOG="$test_root/git.log" FAKE_GIT_ROOT="$worktree" \
      FAKE_DOCKER_VOLUME_STATE=matching FAKE_DOCKER_STATE_VOLUME="$state_volume" \
      FAKE_DOCKER_CONTAINER_STATE=matching-running \
      "$prototype_dir/trellage" stop
  )
  grep -Fqx $'ARG\tstop' "$docker_log" || fail 'stop did not stop running container'
  ! grep -Fqx $'ARG\texec' "$docker_log" || fail 'stop entered container'
  ! grep -Fqx $'ARG\tcreate' "$docker_log" || fail 'stop recreated container'

  : >"$docker_log"
  (
    cd "$worktree"
    PATH="$fake_bin:$PATH" FAKE_DOCKER_LOG="$docker_log" \
      FAKE_GIT_LOG="$test_root/git.log" FAKE_GIT_ROOT="$worktree" \
      FAKE_DOCKER_CONTAINER_STATE=absent \
      "$prototype_dir/trellage" stop
  )
  assert_no_mutation "$docker_log"
  printf 'Trellage host test: PASS: shell recovery and idempotent stop\n'
}

test_terminal_environment_and_agent_tagging() {
  local worktree="$test_root/terminal-worktree"
  local docker_log="$test_root/terminal.docker.log"
  local state_volume
  local HERDR_AGENT=host-agent
  export HERDR_AGENT
  mkdir -p "$worktree"
  state_volume="$(resource_names "$worktree" | tail -n 1)"

  : >"$docker_log"
  FAKE_DOCKER_VOLUME_STATE=matching FAKE_DOCKER_STATE_VOLUME="$state_volume" \
    FAKE_DOCKER_CONTAINER_STATE=matching-running \
    run_tty "$worktree" "$docker_log" "$worktree" \
      env TERM=host-term COLORTERM=truecolor NO_COLOR=1 TERM_PROGRAM=host-terminal \
      "$prototype_dir/trellage" resume
  assert_terminal_contract "$docker_log" truecolor true
  assert_codex_exec_hint "$docker_log"
  grep -Fqx $'ARG\texec trellage-codex-entry resume codex $argv' "$docker_log" \
    || fail 'resume lacks Codex bypass flag before thread selection'

  : >"$docker_log"
  FAKE_DOCKER_VOLUME_STATE=matching FAKE_DOCKER_STATE_VOLUME="$state_volume" \
    FAKE_DOCKER_CONTAINER_STATE=matching-running \
    run_tty "$worktree" "$docker_log" "$worktree" \
      env TERM=host-term COLORTERM=24bit NO_COLOR=1 TERM_PROGRAM=host-terminal \
      "$prototype_dir/trellage" 'literal $(touch /tmp/not-executed) prompt'
  assert_terminal_contract "$docker_log" truecolor true
  assert_codex_exec_hint "$docker_log"
  grep -Fqx $'ARG\tset prompt $argv[-1]; set -e argv[-1]; exec trellage-codex-entry new codex $argv -- $prompt' "$docker_log" \
    || fail 'prompted new lacks Codex bypass flag before prompt boundary'
  [[ "$(tail -n 1 "$docker_log")" == $'ARG\tliteral $(touch /tmp/not-executed) prompt' ]] \
    || fail 'terminal environment handling changed prompt literalness'

  : >"$docker_log"
  FAKE_DOCKER_VOLUME_STATE=matching FAKE_DOCKER_STATE_VOLUME="$state_volume" \
    FAKE_DOCKER_CONTAINER_STATE=matching-running \
    run_tty "$worktree" "$docker_log" "$worktree" \
      env TERM=host-term COLORTERM=unsupported NO_COLOR=1 TERM_PROGRAM=host-terminal \
      "$prototype_dir/trellage"
  assert_terminal_contract "$docker_log" '' true
  assert_codex_exec_hint "$docker_log"
  grep -Fqx $'ARG\texec trellage-codex-entry new codex $argv' "$docker_log" \
    || fail 'bare new lacks Codex bypass flag'

  : >"$docker_log"
  (
    unset COLORTERM
    FAKE_DOCKER_VOLUME_STATE=matching FAKE_DOCKER_STATE_VOLUME="$state_volume" \
      FAKE_DOCKER_CONTAINER_STATE=matching-running \
      run_tty "$worktree" "$docker_log" "$worktree" \
        env TERM=host-term NO_COLOR=1 TERM_PROGRAM=host-terminal \
        "$prototype_dir/trellage" shell
  )
  assert_terminal_contract "$docker_log"
  assert_no_agent_hint "$docker_log"
  grep -Fqx $'ARG\texec fish -l' "$docker_log" \
    || fail 'terminal environment handling changed shell mode'

  : >"$docker_log"
  (
    cd "$worktree"
    PATH="$fake_bin:$PATH" FAKE_DOCKER_LOG="$docker_log" \
      FAKE_GIT_LOG="$test_root/git.log" FAKE_GIT_ROOT="$worktree" \
      FAKE_DOCKER_VOLUME_STATE=matching FAKE_DOCKER_STATE_VOLUME="$state_volume" \
      FAKE_DOCKER_CONTAINER_STATE=matching-running \
      "$prototype_dir/trellage" stop
  )
  grep -Fqx $'ARG\tstop' "$docker_log" \
    || fail 'ambient agent test did not exercise Docker stop'
  assert_no_agent_hint "$docker_log"
  printf 'Trellage host test: PASS: terminal environment and agent tagging\n'
}

test_validation_precedes_mutation() {
  local worktree="$test_root/invalid worktree"
  local docker_log="$test_root/validation.docker.log"
  mkdir -p "$worktree"
  : >"$docker_log"

  if run_tty "$worktree" "$docker_log" "$worktree" "$prototype_dir/trellage"; then
    fail 'unsafe mount segment was accepted'
  fi
  [[ ! -s "$docker_log" ]] || fail 'unsafe worktree reached Docker'

  worktree="$test_root/valid-worktree"
  mkdir -p "$worktree"
  : >"$docker_log"
  if FAKE_DOCKER_IMAGE_EXISTS=0 \
    run_tty "$worktree" "$docker_log" "$worktree" "$prototype_dir/trellage"; then
    fail 'missing image was accepted'
  fi
  assert_no_mutation "$docker_log"

  : >"$docker_log"
  if FAKE_DOCKER_NETWORK_EXISTS=0 \
    run_tty "$worktree" "$docker_log" "$worktree" "$prototype_dir/trellage"; then
    fail 'missing network was accepted'
  fi
  assert_no_mutation "$docker_log"
  printf 'Trellage host test: PASS: validation precedes mutation\n'
}

test_invalid_tmpfs_metadata_precedes_mutation() {
  local worktree="$test_root/invalid-tmpfs-metadata"
  local docker_log="$test_root/invalid-tmpfs-metadata.docker.log"
  local invalid_variant="$test_root/invalid-tmpfs-metadata.json"
  local output
  mkdir -p "$worktree"
  : >"$docker_log"
  jq '.tmpfs_size = "2g,exec"' "$copilot_metadata" >"$invalid_variant"

  if output="$(FAKE_HARNESS_METADATA_OVERRIDE="$invalid_variant" \
    FAKE_DOCKER_CONTAINER_STATE=absent \
    run_copilot_non_tty "$worktree" "$docker_log" "$worktree" \
      "$prototype_dir/trellage" 2>&1)"; then
    fail 'invalid tmpfs metadata was accepted'
  fi
  grep -Fqx 'trellage: profile metadata has an invalid tmpfs size' <<<"$output" \
    || fail 'invalid tmpfs metadata diagnostic is missing'
  [[ ! -s "$docker_log" ]] || fail 'invalid tmpfs metadata reached Docker'
  printf 'Trellage host test: PASS: invalid tmpfs metadata precedes mutation\n'
}

test_false_tmpfs_metadata_precedes_mutation() {
  local worktree="$test_root/false-tmpfs-metadata"
  local docker_log="$test_root/false-tmpfs-metadata.docker.log"
  local invalid_variant="$test_root/false-tmpfs-metadata.json"
  local output
  mkdir -p "$worktree"
  : >"$docker_log"
  jq '.tmpfs_size = false' "$copilot_metadata" >"$invalid_variant"

  if output="$(FAKE_HARNESS_METADATA_OVERRIDE="$invalid_variant" \
    FAKE_DOCKER_CONTAINER_STATE=absent \
    run_copilot_non_tty "$worktree" "$docker_log" "$worktree" \
      "$prototype_dir/trellage" 2>&1)"; then
    fail 'false tmpfs metadata was accepted'
  fi
  grep -Fqx 'trellage: profile metadata has an invalid tmpfs size' <<<"$output" \
    || fail 'false tmpfs metadata diagnostic is missing'
  [[ ! -s "$docker_log" ]] || fail 'false tmpfs metadata reached Docker'
  printf 'Trellage host test: PASS: false tmpfs metadata precedes mutation\n'
}

test_null_tmpfs_metadata_precedes_mutation() {
  local worktree="$test_root/null-tmpfs-metadata"
  local docker_log="$test_root/null-tmpfs-metadata.docker.log"
  local invalid_variant="$test_root/null-tmpfs-metadata.json"
  local output
  mkdir -p "$worktree"
  : >"$docker_log"
  jq '.tmpfs_size = null' "$copilot_metadata" >"$invalid_variant"

  if output="$(FAKE_HARNESS_METADATA_OVERRIDE="$invalid_variant" \
    FAKE_DOCKER_CONTAINER_STATE=absent \
    run_copilot_non_tty "$worktree" "$docker_log" "$worktree" \
      "$prototype_dir/trellage" 2>&1)"; then
    fail 'null tmpfs metadata was accepted'
  fi
  grep -Fqx 'trellage: profile metadata has an invalid tmpfs size' <<<"$output" \
    || fail 'null tmpfs metadata diagnostic is missing'
  [[ ! -s "$docker_log" ]] || fail 'null tmpfs metadata reached Docker'
  printf 'Trellage host test: PASS: null tmpfs metadata precedes mutation\n'
}

test_legacy_tmpfs_metadata_defaults_at_launch() {
  local worktree="$test_root/legacy-tmpfs-metadata"
  local docker_log="$test_root/legacy-tmpfs-metadata.docker.log"
  local legacy_variant="$test_root/legacy-tmpfs-metadata.json"
  local state_volume
  mkdir -p "$worktree"
  : >"$docker_log"
  jq 'del(.tmpfs_size)' "$copilot_metadata" >"$legacy_variant"
  state_volume="$(resource_names "$worktree" copilot-hve-test copilot | tail -n 1)"

  FAKE_HARNESS_METADATA_OVERRIDE="$legacy_variant" \
    FAKE_DOCKER_VOLUME_STATE=matching FAKE_DOCKER_STATE_VOLUME="$state_volume" \
    FAKE_DOCKER_CONTAINER_STATE=absent \
    FAKE_DOCKER_PROFILE=copilot-hve-test FAKE_DOCKER_PROTOTYPE=trellage-copilot \
    run_copilot_tty "$worktree" "$docker_log" "$worktree" \
      env TRELLAGE_IMAGE='test/copilot:locked' "$prototype_dir/trellage"
  assert_arg "$docker_log" '/tmp:rw,noexec,nosuid,nodev,size=256m,uid=10001,gid=10001'
  printf 'Trellage host test: PASS: legacy tmpfs metadata defaults at launch\n'
}

test_requires_tty_and_returns_exec_status() {
  local worktree="$test_root/tty-worktree"
  local docker_log="$test_root/tty.docker.log"
  mkdir -p "$worktree"
  : >"$docker_log"

  if (
    cd "$worktree"
    PATH="$fake_bin:$PATH" FAKE_DOCKER_LOG="$docker_log" \
      FAKE_GIT_LOG="$test_root/git.log" FAKE_GIT_ROOT="$worktree" \
      "$prototype_dir/trellage"
  ); then
    fail 'non-interactive invocation was accepted'
  fi
  [[ ! -s "$docker_log" ]] || fail 'non-interactive invocation reached Docker'

  : >"$docker_log"
  local state_volume
  state_volume="$(resource_names "$worktree" | tail -n 1)"
  if FAKE_DOCKER_VOLUME_STATE=matching FAKE_DOCKER_STATE_VOLUME="$state_volume" \
    FAKE_DOCKER_CONTAINER_STATE=matching-running FAKE_DOCKER_EXEC_EXIT=23 \
    run_tty "$worktree" "$docker_log" "$worktree" "$prototype_dir/trellage"; then
    fail 'Docker exec exit status was swallowed'
  else
    [[ "$?" -eq 23 ]] || fail 'Docker exec exit status changed'
  fi
  printf 'Trellage host test: PASS: TTY required and exec status preserved\n'
}

test_doctor_reports_status_without_mutation_or_secrets() {
  local worktree="$test_root/doctor-worktree"
  local docker_log="$test_root/doctor.docker.log"
  local container_name state_volume output
  mkdir -p "$worktree"
  container_name="$(resource_names "$worktree" | head -n 1)"
  state_volume="$(resource_names "$worktree" | tail -n 1)"

  : >"$docker_log"
  output="$(
    FAKE_DOCKER_IMAGE_EXISTS=0 FAKE_DOCKER_NETWORK_EXISTS=0 \
      FAKE_DOCKER_VOLUME_STATE=absent FAKE_DOCKER_STATE_VOLUME="$state_volume" \
      FAKE_DOCKER_CONTAINER_STATE=absent \
      run_non_tty "$worktree" "$docker_log" "$worktree" \
        env TRELLAGE_IMAGE='test/image:doctor' TRELLAGE_NETWORK='test_doctor_net' \
        SECRET_DO_NOT_PRINT='doctor-secret-value' "$prototype_dir/trellage" doctor
  )"
  grep -Fqx 'dependency git: available' <<<"$output" || fail 'doctor omitted Git status'
  grep -Fqx 'dependency docker: available' <<<"$output" || fail 'doctor omitted Docker status'
  grep -Eq '^dependency mise: (available|missing)$' <<<"$output" || fail 'doctor omitted mise status'
  grep -Fqx 'environment: disabled' <<<"$output" || fail 'doctor omitted disabled environment status'
  grep -Fqx "environment path: $HOME/.config/trellage" <<<"$output" \
    || fail 'doctor omitted the default environment path'
  grep -Fqx "worktree: $worktree" <<<"$output" || fail 'doctor omitted canonical worktree'
  grep -Fqx 'mount: /mounts/doctor-worktree' <<<"$output" || fail 'doctor omitted mount path'
  grep -Fqx 'image: test/image:doctor (absent)' <<<"$output" || fail 'doctor omitted absent image'
  grep -Fqx 'network: test_doctor_net (absent)' <<<"$output" || fail 'doctor omitted absent network'
  grep -Fqx "container: $container_name" <<<"$output" || fail 'doctor omitted exact container'
  grep -Fqx "state volume: $state_volume" <<<"$output" || fail 'doctor omitted exact volume'
  grep -Fqx 'state: absent (created on first launch)' <<<"$output" \
    || fail 'doctor omitted first-launch guidance for absent state'
  ! grep -Fq 'doctor-secret-value' <<<"$output" || fail 'doctor exposed an environment secret'
  assert_no_mutation "$docker_log"

  : >"$docker_log"
  output="$(
    FAKE_DOCKER_VOLUME_STATE=matching FAKE_DOCKER_STATE_VOLUME="$state_volume" \
      FAKE_DOCKER_CONTAINER_STATE=matching-running \
      run_non_tty "$worktree" "$docker_log" "$worktree" "$prototype_dir/trellage" doctor
  )"
  grep -Fqx 'state: running' <<<"$output" || fail 'doctor omitted running state'
  assert_no_mutation "$docker_log"

  : >"$docker_log"
  output="$(
    FAKE_DOCKER_VOLUME_STATE=matching FAKE_DOCKER_STATE_VOLUME="$state_volume" \
      FAKE_DOCKER_CONTAINER_STATE=matching-stopped \
      run_non_tty "$worktree" "$docker_log" "$worktree" "$prototype_dir/trellage" doctor
  )"
  grep -Fqx 'state: stopped' <<<"$output" || fail 'doctor omitted stopped state'
  assert_no_mutation "$docker_log"

  : >"$docker_log"
  output="$(
    FAKE_DOCKER_VOLUME_STATE=matching FAKE_DOCKER_STATE_VOLUME="$state_volume" \
      FAKE_DOCKER_CONTAINER_STATE=error FAKE_DOCKER_CONTAINER_ERROR_CODE=70 \
      run_non_tty "$worktree" "$docker_log" "$worktree" "$prototype_dir/trellage" doctor
  )"
  grep -Fqx 'state: error' <<<"$output" || fail 'doctor collapsed container inspection error into absence'
  assert_no_mutation "$docker_log"

  : >"$docker_log"
  output="$(
    FAKE_DOCKER_VOLUME_STATE=matching FAKE_DOCKER_STATE_VOLUME="$state_volume" \
      FAKE_DOCKER_CONTAINER_STATE=absent \
      run_non_tty "$worktree" "$docker_log" "$worktree" "$prototype_dir/trellage" doctor
  )"
  grep -Fqx 'state: error' <<<"$output" || fail 'doctor accepted an unpaired owned volume as healthy absence'
  assert_no_mutation "$docker_log"

  : >"$docker_log"
  output="$(
    FAKE_DOCKER_CONTAINER_LIST_STATE=error FAKE_DOCKER_CONTAINER_LIST_ERROR_CODE=72 \
      FAKE_DOCKER_CONTAINER_STATE=absent FAKE_DOCKER_VOLUME_STATE=absent \
      FAKE_DOCKER_STATE_VOLUME="$state_volume" \
      run_non_tty "$worktree" "$docker_log" "$worktree" "$prototype_dir/trellage" doctor
  )"
  grep -Fqx 'state: error' <<<"$output" || fail 'doctor collapsed container presence failure into absence'
  assert_no_mutation "$docker_log"

  : >"$docker_log"
  output="$(
    FAKE_DOCKER_IMAGE_LIST_STATE=error FAKE_DOCKER_IMAGE_LIST_ERROR_CODE=74 \
      FAKE_DOCKER_NETWORK_LIST_STATE=error FAKE_DOCKER_NETWORK_LIST_ERROR_CODE=75 \
      FAKE_DOCKER_VOLUME_STATE=absent FAKE_DOCKER_STATE_VOLUME="$state_volume" \
      FAKE_DOCKER_CONTAINER_STATE=absent \
      run_non_tty "$worktree" "$docker_log" "$worktree" \
        env TRELLAGE_IMAGE='test/image:doctor-error' TRELLAGE_NETWORK='test_doctor_error_net' \
        "$prototype_dir/trellage" doctor
  )"
  grep -Fqx 'image: test/image:doctor-error (error)' <<<"$output" \
    || fail 'doctor collapsed image discovery error into absence or availability'
  grep -Fqx 'network: test_doctor_error_net (error)' <<<"$output" \
    || fail 'doctor collapsed network discovery error into absence or availability'
  assert_no_mutation "$docker_log"
  printf 'Trellage host test: PASS: doctor status is nonmutating and secret-free\n'
}

test_stop_rejects_collisions_and_wrong_mounts() {
  local worktree="$test_root/stop-safety-worktree"
  local docker_log="$test_root/stop-safety.docker.log"
  local state_volume output
  mkdir -p "$worktree"
  state_volume="$(resource_names "$worktree" | tail -n 1)"

  : >"$docker_log"
  if output="$(
    FAKE_DOCKER_VOLUME_STATE=matching FAKE_DOCKER_STATE_VOLUME="$state_volume" \
      FAKE_DOCKER_CONTAINER_STATE=unrelated \
      run_non_tty "$worktree" "$docker_log" "$worktree" "$prototype_dir/trellage" stop 2>&1
  )"; then
    fail 'stop accepted unrelated container ownership'
  fi
  grep -Fq 'refusing unrelated Docker container name collision' <<<"$output" \
    || fail 'stop did not explicitly reject unrelated ownership'
  assert_no_mutation "$docker_log"

  : >"$docker_log"
  if output="$(
    FAKE_DOCKER_VOLUME_STATE=matching FAKE_DOCKER_STATE_VOLUME="$state_volume" \
      FAKE_DOCKER_CONTAINER_STATE=matching-wrong-mount \
      run_non_tty "$worktree" "$docker_log" "$worktree" "$prototype_dir/trellage" stop 2>&1
  )"; then
    fail 'stop accepted wrong mounts'
  fi
  grep -Fq 'refusing Docker container with wrong state volume mount' <<<"$output" \
    || fail 'stop did not explicitly reject wrong mounts'
  assert_no_mutation "$docker_log"
  printf 'Trellage host test: PASS: stop rejects collisions and wrong mounts\n'
}

test_destroy_requires_exact_confirmation_and_removes_in_order() {
  local worktree="$test_root/destroy-worktree"
  local docker_log="$test_root/destroy.docker.log"
  local container_name state_volume confirmation output container_rm_line volume_rm_line
  mkdir -p "$worktree"
  container_name="$(resource_names "$worktree" | head -n 1)"
  state_volume="$(resource_names "$worktree" | tail -n 1)"
  confirmation="destroy $container_name $state_volume"

  : >"$docker_log"
  output="$(
    printf '\n' | FAKE_DOCKER_VOLUME_STATE=matching FAKE_DOCKER_STATE_VOLUME="$state_volume" \
      FAKE_DOCKER_CONTAINER_STATE=matching-running \
      run_non_tty "$worktree" "$docker_log" "$worktree" "$prototype_dir/trellage" destroy
  )"
  grep -Fqx "container: $container_name" <<<"$output" || fail 'destroy omitted exact container'
  grep -Fqx "state volume: $state_volume" <<<"$output" || fail 'destroy omitted exact volume'
  grep -Fq "$confirmation" <<<"$output" || fail 'destroy omitted literal confirmation'
  assert_no_mutation "$docker_log"

  : >"$docker_log"
  run_non_tty "$worktree" "$docker_log" "$worktree" \
    env FAKE_DOCKER_VOLUME_STATE=matching FAKE_DOCKER_STATE_VOLUME="$state_volume" \
    FAKE_DOCKER_CONTAINER_STATE=matching-running \
    "$prototype_dir/trellage" destroy </dev/null >/dev/null
  assert_no_mutation "$docker_log"

  : >"$docker_log"
  printf 'destroy the resources\n' | \
    FAKE_DOCKER_VOLUME_STATE=matching FAKE_DOCKER_STATE_VOLUME="$state_volume" \
    FAKE_DOCKER_CONTAINER_STATE=matching-running \
    run_non_tty "$worktree" "$docker_log" "$worktree" "$prototype_dir/trellage" destroy >/dev/null
  assert_no_mutation "$docker_log"

  : >"$docker_log"
  printf '%s\n' "$confirmation" | \
    FAKE_DOCKER_VOLUME_STATE=matching FAKE_DOCKER_STATE_VOLUME="$state_volume" \
    FAKE_DOCKER_CONTAINER_STATE=matching-running \
    run_non_tty "$worktree" "$docker_log" "$worktree" "$prototype_dir/trellage" destroy >/dev/null
  awk '
    $0 == "CALL" { command = ""; next }
    $0 == "ARG\tcontainer" { command = "container"; next }
    command == "container" && $0 == "ARG\trm" { saw_rm = 1; next }
    command == "container" && saw_rm && $0 == "ARG\t--force" { saw_force = 1; next }
    command == "container" && saw_force && $0 == "ARG\tfake-container-id" { found = 1 }
    END { exit(found ? 0 : 1) }
  ' "$docker_log" || fail 'destroy did not force-remove running container by immutable ID'
  awk -v volume="$state_volume" '
    $0 == "CALL" { command = ""; next }
    $0 == "ARG\tvolume" { command = "volume"; next }
    command == "volume" && $0 == "ARG\trm" { saw_rm = 1; next }
    command == "volume" && saw_rm && $0 == "ARG\t" volume { found = 1 }
    END { exit(found ? 0 : 1) }
  ' "$docker_log" || fail 'destroy did not remove exact state volume'
  container_rm_line="$(grep -n -F $'ARG\tfake-container-id' "$docker_log" | tail -n 1 | cut -d: -f1)"
  volume_rm_line="$(grep -n -F $'ARG\t'"$state_volume" "$docker_log" | tail -n 1 | cut -d: -f1)"
  [[ "$container_rm_line" -lt "$volume_rm_line" ]] || fail 'destroy removed volume before container'
  awk '
    $0 == "CALL" { call_number++; first = second = ""; next }
    /^ARG\t/ && first == "" { first = $0; next }
    /^ARG\t/ && second == "" {
      second = $0
      if (first == "ARG\tcontainer" && second == "ARG\trm") container_rm = call_number
      if (first == "ARG\tvolume" && second == "ARG\tinspect") volume_inspect = call_number
      if (first == "ARG\tvolume" && second == "ARG\trm") volume_rm = call_number
    }
    END { exit(volume_inspect == container_rm + 1 && volume_rm == volume_inspect + 1 ? 0 : 1) }
  ' "$docker_log" || fail 'destroy did not revalidate volume ownership immediately before removal'
  awk '
    $0 == "CALL" { first = ""; next }
    /^ARG\t/ && first == "" { first = $0; next }
    $0 == "ARG\trm" && (first == "ARG\timage" || first == "ARG\tnetwork") { exit 1 }
  ' "$docker_log" || fail 'destroy attempted to remove image or network'
  printf 'Trellage host test: PASS: destroy confirms and removes exact resources in order\n'
}

test_destroy_is_idempotent_and_collision_safe() {
  local worktree="$test_root/destroy-safety-worktree"
  local docker_log="$test_root/destroy-safety.docker.log"
  local container_name state_volume confirmation output
  mkdir -p "$worktree"
  container_name="$(resource_names "$worktree" | head -n 1)"
  state_volume="$(resource_names "$worktree" | tail -n 1)"
  confirmation="destroy $container_name $state_volume"

  : >"$docker_log"
  printf '%s\n' "$confirmation" | \
    FAKE_DOCKER_CONTAINER_STATE=absent FAKE_DOCKER_VOLUME_STATE=absent \
    FAKE_DOCKER_STATE_VOLUME="$state_volume" \
    run_non_tty "$worktree" "$docker_log" "$worktree" "$prototype_dir/trellage" destroy >/dev/null
  assert_no_mutation "$docker_log"

  : >"$docker_log"
  printf '%s\n' "$confirmation" | \
    FAKE_DOCKER_CONTAINER_STATE=absent FAKE_DOCKER_VOLUME_STATE=matching \
    FAKE_DOCKER_STATE_VOLUME="$state_volume" \
    run_non_tty "$worktree" "$docker_log" "$worktree" "$prototype_dir/trellage" destroy >/dev/null
  [[ "$(grep -Fxc $'ARG\trm' "$docker_log")" -eq 1 ]] || fail 'orphan volume destroy removed unexpected resources'
  grep -Fqx $'ARG\t'"$state_volume" "$docker_log" || fail 'orphan volume was not removed by exact name'

  : >"$docker_log"
  if output="$(
    printf '%s\n' "$confirmation" | \
      FAKE_DOCKER_CONTAINER_STATE=unrelated FAKE_DOCKER_VOLUME_STATE=matching \
      FAKE_DOCKER_STATE_VOLUME="$state_volume" \
      run_non_tty "$worktree" "$docker_log" "$worktree" "$prototype_dir/trellage" destroy 2>&1
  )"; then
    fail 'destroy accepted unrelated container ownership'
  fi
  grep -Fq 'refusing unrelated Docker container name collision' <<<"$output" \
    || fail 'destroy did not report unrelated container ownership'
  assert_no_mutation "$docker_log"

  : >"$docker_log"
  if printf '%s\n' "$confirmation" | \
    FAKE_DOCKER_CONTAINER_STATE=matching-wrong-mount FAKE_DOCKER_VOLUME_STATE=matching \
    FAKE_DOCKER_STATE_VOLUME="$state_volume" \
    run_non_tty "$worktree" "$docker_log" "$worktree" "$prototype_dir/trellage" destroy >/dev/null 2>&1; then
    fail 'destroy accepted wrong container mounts'
  fi
  assert_no_mutation "$docker_log"

  : >"$docker_log"
  if printf '%s\n' "$confirmation" | \
    FAKE_DOCKER_CONTAINER_STATE=absent FAKE_DOCKER_VOLUME_STATE=unrelated \
    FAKE_DOCKER_STATE_VOLUME="$state_volume" \
    run_non_tty "$worktree" "$docker_log" "$worktree" "$prototype_dir/trellage" destroy >/dev/null 2>&1; then
    fail 'destroy accepted unrelated orphan volume ownership'
  fi
  assert_no_mutation "$docker_log"

  : >"$docker_log"
  if printf '%s\n' "$confirmation" | \
    FAKE_DOCKER_CONTAINER_STATE=error FAKE_DOCKER_CONTAINER_ERROR_CODE=70 \
    FAKE_DOCKER_VOLUME_STATE=matching FAKE_DOCKER_STATE_VOLUME="$state_volume" \
    run_non_tty "$worktree" "$docker_log" "$worktree" "$prototype_dir/trellage" destroy >/dev/null 2>&1; then
    fail 'destroy treated container inspection error as absence'
  fi
  assert_no_mutation "$docker_log"

  : >"$docker_log"
  if printf '%s\n' "$confirmation" | \
    FAKE_DOCKER_CONTAINER_STATE=matching-running \
    FAKE_DOCKER_VOLUME_STATE=error FAKE_DOCKER_VOLUME_ERROR_CODE=71 \
    FAKE_DOCKER_STATE_VOLUME="$state_volume" \
    run_non_tty "$worktree" "$docker_log" "$worktree" "$prototype_dir/trellage" destroy >/dev/null 2>&1; then
    fail 'destroy treated volume inspection error as absence'
  fi
  assert_no_mutation "$docker_log"

  : >"$docker_log"
  if printf '%s\n' "$confirmation" | \
    FAKE_DOCKER_CONTAINER_LIST_STATE=present \
    FAKE_DOCKER_CONTAINER_STATE=error FAKE_DOCKER_CONTAINER_ERROR_CODE=1 \
    FAKE_DOCKER_VOLUME_STATE=matching FAKE_DOCKER_STATE_VOLUME="$state_volume" \
    run_non_tty "$worktree" "$docker_log" "$worktree" "$prototype_dir/trellage" destroy >/dev/null 2>&1; then
    fail 'destroy treated inspect exit 1 transport error as absence'
  fi
  assert_no_mutation "$docker_log"

  : >"$docker_log"
  if printf '%s\n' "$confirmation" | \
    FAKE_DOCKER_CONTAINER_LIST_STATE=error FAKE_DOCKER_CONTAINER_LIST_ERROR_CODE=72 \
    FAKE_DOCKER_CONTAINER_STATE=absent \
    FAKE_DOCKER_VOLUME_STATE=matching FAKE_DOCKER_STATE_VOLUME="$state_volume" \
    run_non_tty "$worktree" "$docker_log" "$worktree" "$prototype_dir/trellage" destroy >/dev/null 2>&1; then
    fail 'destroy treated container presence failure as absence'
  fi
  assert_no_mutation "$docker_log"

  : >"$docker_log"
  if printf '%s\n' "$confirmation" | \
    FAKE_DOCKER_CONTAINER_STATE=matching-running \
    FAKE_DOCKER_VOLUME_LIST_STATE=error FAKE_DOCKER_VOLUME_LIST_ERROR_CODE=73 \
    FAKE_DOCKER_VOLUME_STATE=matching FAKE_DOCKER_STATE_VOLUME="$state_volume" \
    run_non_tty "$worktree" "$docker_log" "$worktree" "$prototype_dir/trellage" destroy >/dev/null 2>&1; then
    fail 'destroy treated volume presence failure as absence'
  fi
  assert_no_mutation "$docker_log"
  printf 'Trellage host test: PASS: destroy is idempotent and collision-safe\n'
}

test_destroy_revalidates_after_confirmation() {
  local worktree="$test_root/destroy-transition-worktree"
  local docker_log="$test_root/destroy-transition.docker.log"
  local output_file="$test_root/destroy-transition.output"
  local status_file="$test_root/destroy-transition.status"
  local container_state_file="$test_root/destroy-transition.container-state"
  local volume_state_file="$test_root/destroy-transition.volume-state"
  local input_fifo="$test_root/destroy-transition.input"
  local container_name state_volume confirmation pid prompt_seen=false
  local preconfirmation_docker_calls=false attempts=0
  mkdir -p "$worktree"
  container_name="$(resource_names "$worktree" | head -n 1)"
  state_volume="$(resource_names "$worktree" | tail -n 1)"
  confirmation="destroy $container_name $state_volume"
  printf 'matching-running\n' >"$container_state_file"
  printf 'matching\n' >"$volume_state_file"
  : >"$docker_log"
  : >"$output_file"
  mkfifo "$input_fifo"
  exec 9<>"$input_fifo"

  (
    if run_non_tty "$worktree" "$docker_log" "$worktree" \
      env FAKE_DOCKER_CONTAINER_STATE_FILE="$container_state_file" \
      FAKE_DOCKER_VOLUME_STATE_FILE="$volume_state_file" \
      FAKE_DOCKER_STATE_VOLUME="$state_volume" \
      "$prototype_dir/trellage" destroy <&9 >"$output_file" 2>&1; then
      printf '0\n' >"$status_file"
    else
      printf '%s\n' "$?" >"$status_file"
    fi
  ) &
  pid="$!"

  while [[ "$attempts" -lt 200 ]]; do
    if grep -Fq "$confirmation" "$output_file"; then
      prompt_seen=true
      break
    fi
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.01
    attempts=$((attempts + 1))
  done
  [[ "$prompt_seen" == true ]] || fail 'destroy did not present confirmation prompt'
  [[ ! -s "$docker_log" ]] || preconfirmation_docker_calls=true

  printf 'unrelated\n' >"$container_state_file"
  printf 'unrelated\n' >"$volume_state_file"
  printf '%s\n' "$confirmation" >&9
  exec 9>&-
  wait "$pid"

  [[ "$preconfirmation_docker_calls" == false ]] \
    || fail 'destroy validated mutable Docker resources before confirmation'
  [[ "$(head -n 1 "$status_file")" -ne 0 ]] \
    || fail 'destroy accepted resources replaced during confirmation'
  assert_no_mutation "$docker_log"
  printf 'Trellage host test: PASS: destroy revalidates after confirmation\n'
}

test_resource_identity_isolates_codex_and_copilot_profiles() {
  local worktree="$test_root/profile-worktree"
  local profile_one="$test_root/one.toml"
  local profile_one_lock="$test_root/one.lock.toml"
  local profile_two="$test_root/two.toml"
  local docker_log="$test_root/profile-identity.docker.log"
  local copilot_one="$test_root/copilot-one.json"
  local copilot_two="$test_root/copilot-two.json"
  local output output_one output_two container_one container_two state_one profile_one_hash
  local copilot_container_one copilot_container_two copilot_state_one path_hash
  mkdir -p "$worktree"
  sed 's/name = "codex-superpowers"/name = "one"/' \
    "$prototype_dir/../../profiles/codex-superpowers/profile.toml" >"$profile_one"
  sed 's/name = "codex-superpowers"/name = "two"/' \
    "$prototype_dir/../../profiles/codex-superpowers/profile.toml" >"$profile_two"
  : >"$docker_log"

  output_one="$(run_non_tty "$worktree" "$docker_log" "$worktree" \
    env TRELLAGE_IMAGE='test/image:doctor' TRELLAGE_NETWORK='test_doctor_net' \
    "$prototype_dir/trellage" doctor --profile "$profile_one")"
  output_two="$(run_non_tty "$worktree" "$docker_log" "$worktree" \
    env TRELLAGE_IMAGE='test/image:doctor' TRELLAGE_NETWORK='test_doctor_net' \
    "$prototype_dir/trellage" doctor --profile "$profile_two")"

  container_one="$(sed -n 's/^container: //p' <<<"$output_one")"
  container_two="$(sed -n 's/^container: //p' <<<"$output_two")"
  path_hash="$(printf '%s' "$worktree" | shasum -a 256 | awk '{print substr($1, 1, 16)}')"
  [[ "$container_one" == "trellage-codex-one-profile-worktree-$path_hash" ]] \
    || fail 'Codex profile one lacks an isolated exact container name'
  [[ "$container_two" == "trellage-codex-two-profile-worktree-$path_hash" ]] \
    || fail 'Codex profile two lacks an isolated exact container name'
  [[ "$container_one" != "$container_two" ]] \
    || fail 'Codex profiles collide on one worktree'
  state_one="$(resource_names "$worktree" one | tail -n 1)"
  profile_one_hash="$("$real_node" \
    "$prototype_dir/../../packages/trellage-cli/dist/cli.js" \
    metadata "$profile_one" | jq -r '.profile_hash')"
  cp "$prototype_dir/../../profiles/codex-superpowers/profile.lock.toml" "$profile_one_lock"
  sed -i.bak "s/^profile_hash = .*/profile_hash = \"$profile_one_hash\"/" "$profile_one_lock"
  rm -f "$profile_one_lock.bak"

  : >"$docker_log"
  if output="$(FAKE_DOCKER_IMAGE_PROFILE_HASH="$profile_one_hash" \
    FAKE_DOCKER_VOLUME_STATE=matching FAKE_DOCKER_STATE_VOLUME="$state_one" \
    FAKE_DOCKER_CONTAINER_STATE=matching-running \
    FAKE_DOCKER_PROFILE=wrong-profile FAKE_DOCKER_PROTOTYPE=trellage-codex \
    run_tty "$worktree" "$docker_log" "$worktree" \
      env TRELLAGE_IMAGE='test/image:locked' "$prototype_dir/trellage" --profile "$profile_one" 2>&1)"; then
    fail 'Codex container with a wrong profile label was accepted'
  fi
  grep -Fq 'refusing Docker container profile collision:' <<<"$output" \
    || fail 'Codex wrong container profile did not reach profile ownership validation'
  assert_no_mutation "$docker_log"

  : >"$docker_log"
  if output="$(FAKE_DOCKER_IMAGE_PROFILE_HASH="$profile_one_hash" \
    FAKE_DOCKER_VOLUME_STATE=matching FAKE_DOCKER_STATE_VOLUME="$state_one" \
    FAKE_DOCKER_CONTAINER_STATE=matching-running-missing-profile \
    FAKE_DOCKER_PROFILE=one FAKE_DOCKER_PROTOTYPE=trellage-codex \
    run_tty "$worktree" "$docker_log" "$worktree" \
      env TRELLAGE_IMAGE='test/image:locked' "$prototype_dir/trellage" --profile "$profile_one" 2>&1)"; then
    fail 'Codex container with a missing profile label was accepted'
  fi
  grep -Fq 'refusing Docker container profile collision:' <<<"$output" \
    || fail 'Codex missing container profile did not reach profile ownership validation'
  assert_no_mutation "$docker_log"

  : >"$docker_log"
  if output="$(FAKE_DOCKER_IMAGE_PROFILE_HASH="$profile_one_hash" \
    FAKE_DOCKER_VOLUME_STATE=matching-missing-profile \
    FAKE_DOCKER_STATE_VOLUME="$state_one" FAKE_DOCKER_CONTAINER_STATE=absent \
    FAKE_DOCKER_PROFILE=one FAKE_DOCKER_PROTOTYPE=trellage-codex \
    run_tty "$worktree" "$docker_log" "$worktree" \
      env TRELLAGE_IMAGE='test/image:locked' "$prototype_dir/trellage" --profile "$profile_one" 2>&1)"; then
    fail 'Codex volume with a missing profile label was accepted'
  fi
  grep -Fq 'refusing unrelated Docker volume name collision:' <<<"$output" \
    || fail 'Codex missing volume profile did not reach profile ownership validation'
  assert_no_mutation "$docker_log"

  : >"$docker_log"
  if output="$(FAKE_DOCKER_IMAGE_PROFILE_HASH="$profile_one_hash" \
    FAKE_DOCKER_VOLUME_STATE=matching FAKE_DOCKER_STATE_VOLUME="$state_one" \
    FAKE_DOCKER_CONTAINER_STATE=absent \
    FAKE_DOCKER_PROFILE=wrong-profile FAKE_DOCKER_PROTOTYPE=trellage-codex \
    run_tty "$worktree" "$docker_log" "$worktree" \
      env TRELLAGE_IMAGE='test/image:locked' "$prototype_dir/trellage" --profile "$profile_one" 2>&1)"; then
    fail 'Codex volume with a wrong profile label was accepted'
  fi
  grep -Fq 'refusing unrelated Docker volume name collision:' <<<"$output" \
    || fail 'Codex wrong volume profile did not reach profile ownership validation'
  assert_no_mutation "$docker_log"

  jq '.profile_name = "copilot-one"' "$copilot_metadata" >"$copilot_one"
  jq '.profile_name = "copilot-two"' "$copilot_metadata" >"$copilot_two"
  copilot_container_one="$(FAKE_HARNESS_METADATA_OVERRIDE="$copilot_one" \
    run_copilot_non_tty "$worktree" "$docker_log" "$worktree" \
      env FAKE_GH_STATE=failure TRELLAGE_IMAGE='test/copilot:doctor' \
      "$prototype_dir/trellage" doctor | sed -n 's/^container: //p')"
  copilot_container_two="$(FAKE_HARNESS_METADATA_OVERRIDE="$copilot_two" \
    run_copilot_non_tty "$worktree" "$docker_log" "$worktree" \
      env FAKE_GH_STATE=failure TRELLAGE_IMAGE='test/copilot:doctor' \
      "$prototype_dir/trellage" doctor | sed -n 's/^container: //p')"
  [[ "$copilot_container_one" == "trellage-copilot-copilot-one-profile-worktree-$path_hash" ]] \
    || fail 'Copilot profile one lacks an isolated exact container name'
  [[ "$copilot_container_two" == "trellage-copilot-copilot-two-profile-worktree-$path_hash" ]] \
    || fail 'Copilot profile two lacks an isolated exact container name'
  [[ "$copilot_container_one" != "$copilot_container_two" ]] \
    || fail 'Copilot profiles collide on one worktree'
  copilot_state_one="$(resource_names "$worktree" copilot-one copilot | tail -n 1)"

  : >"$docker_log"
  if FAKE_HARNESS_METADATA_OVERRIDE="$copilot_one" \
    FAKE_GH_STATE=failure FAKE_DOCKER_VOLUME_STATE=matching \
    FAKE_DOCKER_STATE_VOLUME="$copilot_state_one" \
    FAKE_DOCKER_CONTAINER_STATE=matching-running \
    FAKE_DOCKER_PROFILE=wrong-profile FAKE_DOCKER_PROTOTYPE=trellage-copilot \
    run_copilot_tty "$worktree" "$docker_log" "$worktree" \
      env TRELLAGE_IMAGE='test/copilot:locked' "$prototype_dir/trellage"; then
    fail 'Copilot container with a wrong profile label was accepted'
  fi
  assert_no_mutation "$docker_log"

  : >"$docker_log"
  if FAKE_HARNESS_METADATA_OVERRIDE="$copilot_one" \
    FAKE_GH_STATE=failure FAKE_DOCKER_VOLUME_STATE=matching \
    FAKE_DOCKER_STATE_VOLUME="$copilot_state_one" \
    FAKE_DOCKER_CONTAINER_STATE=matching-running-missing-profile \
    FAKE_DOCKER_PROFILE=copilot-one FAKE_DOCKER_PROTOTYPE=trellage-copilot \
    run_copilot_tty "$worktree" "$docker_log" "$worktree" \
      env TRELLAGE_IMAGE='test/copilot:locked' "$prototype_dir/trellage"; then
    fail 'Copilot container with a missing profile label was accepted'
  fi
  assert_no_mutation "$docker_log"

  : >"$docker_log"
  if FAKE_HARNESS_METADATA_OVERRIDE="$copilot_one" \
    FAKE_GH_STATE=failure FAKE_DOCKER_VOLUME_STATE=matching-missing-profile \
    FAKE_DOCKER_STATE_VOLUME="$copilot_state_one" \
    FAKE_DOCKER_CONTAINER_STATE=absent \
    FAKE_DOCKER_PROFILE=copilot-one FAKE_DOCKER_PROTOTYPE=trellage-copilot \
    run_copilot_tty "$worktree" "$docker_log" "$worktree" \
      env TRELLAGE_IMAGE='test/copilot:locked' "$prototype_dir/trellage"; then
    fail 'Copilot volume with a missing profile label was accepted'
  fi
  assert_no_mutation "$docker_log"

  : >"$docker_log"
  if FAKE_HARNESS_METADATA_OVERRIDE="$copilot_one" \
    FAKE_GH_STATE=failure FAKE_DOCKER_VOLUME_STATE=matching \
    FAKE_DOCKER_STATE_VOLUME="$copilot_state_one" \
    FAKE_DOCKER_CONTAINER_STATE=absent \
    FAKE_DOCKER_PROFILE=wrong-profile FAKE_DOCKER_PROTOTYPE=trellage-copilot \
    run_copilot_tty "$worktree" "$docker_log" "$worktree" \
      env TRELLAGE_IMAGE='test/copilot:locked' "$prototype_dir/trellage"; then
    fail 'Copilot volume with a wrong profile label was accepted'
  fi
  assert_no_mutation "$docker_log"
  printf 'Trellage host test: PASS: Codex and Copilot profile resource identities hold\n'
}

test_codex_profile_resources_reuse_running_and_stopped_state() {
  local worktree="$test_root/profile-reuse-worktree"
  local docker_log="$test_root/profile-reuse.docker.log"
  local container_name state_volume state
  mkdir -p "$worktree"
  container_name="$(resource_names "$worktree" | head -n 1)"
  state_volume="$(resource_names "$worktree" | tail -n 1)"

  for state in matching-running matching-stopped; do
    : >"$docker_log"
    FAKE_DOCKER_VOLUME_STATE=matching FAKE_DOCKER_STATE_VOLUME="$state_volume" \
      FAKE_DOCKER_CONTAINER_STATE="$state" FAKE_DOCKER_PROFILE=codex-superpowers \
      run_tty "$worktree" "$docker_log" "$worktree" "$prototype_dir/trellage"
    assert_arg "$docker_log" "name=^/$container_name\$"
    assert_arg "$docker_log" "name=^$state_volume\$"
    ! grep -Fqx $'ARG\tcreate' "$docker_log" \
      || fail "existing $state profile-aware Codex container was recreated"
    ! grep -Fqx $'ARG\trm' "$docker_log" \
      || fail "existing $state profile-aware Codex resource was removed"
    awk '
      $0 == "CALL" { first = second = ""; next }
      /^ARG\t/ && first == "" { first = $0; next }
      /^ARG\t/ && second == "" {
        second = $0
        if (first == "ARG\tvolume" && (second == "ARG\tcreate" || second == "ARG\trm")) exit 1
      }
    ' "$docker_log" || fail "existing $state profile-aware Codex state volume was mutated"
  done
  grep -Fqx $'ARG\tstart' "$docker_log" \
    || fail 'existing stopped Codex container was not resumed'
  printf 'Trellage host test: PASS: exact profile-aware Codex resources preserve running and stopped state\n'
}

test_env_secrets_reach_only_final_codex_exec() {
  local worktree="$test_root/secret-worktree"
  local profile="$test_root/secret.toml"
  local lock="$test_root/secret.lock.toml"
  local docker_log="$test_root/secret.docker.log"
  local state_volume profile_hash
  mkdir -p "$worktree"
  sed \
    -e 's/name = "codex-superpowers"/name = "secret-test"/' \
    -e 's/required = \[\]/required = ["DOCS_TOKEN"]/' \
    -e '/^\[secrets\]/i\
[[mcps]]\
name = "local"\
transport = "stdio"\
command = "local-mcp"\
env_from_secret = { TOKEN = "DOCS_TOKEN" }\
' \
    "$prototype_dir/../../profiles/codex-superpowers/profile.toml" >"$profile"
  cp "$prototype_dir/../../profiles/codex-superpowers/profile.lock.toml" "$lock"
  profile_hash="$(shasum -a 256 "$profile" | awk '{print "sha256:" $1}')"
  sed -i.bak "s/^profile_hash = .*/profile_hash = \"$profile_hash\"/" "$lock"
  rm -f "$lock.bak"
  state_volume="$(resource_names "$worktree" secret-test | tail -n 1)"
  : >"$docker_log"

  if FAKE_DOCKER_IMAGE_PROFILE_HASH="$profile_hash" FAKE_DOCKER_CONTAINER_PROFILE_HASH="$profile_hash" \
    FAKE_DOCKER_VOLUME_STATE=matching FAKE_DOCKER_STATE_VOLUME="$state_volume" \
    FAKE_DOCKER_CONTAINER_STATE=matching-running FAKE_DOCKER_PROFILE=secret-test \
    run_tty "$worktree" "$docker_log" "$worktree" \
      env TRELLAGE_IMAGE='test/image:locked' TRELLAGE_NETWORK='test_proxy_net' \
      "$prototype_dir/trellage" --profile "$profile" >/dev/null 2>&1; then
    fail 'missing required profile secret was accepted'
  fi
  [[ ! -s "$docker_log" ]] || fail 'missing secret mutated or inspected Docker state'

  : >"$docker_log"
  FAKE_DOCKER_IMAGE_PROFILE_HASH="$profile_hash" FAKE_DOCKER_CONTAINER_PROFILE_HASH="$profile_hash" \
    FAKE_DOCKER_VOLUME_STATE=matching FAKE_DOCKER_STATE_VOLUME="$state_volume" \
    FAKE_DOCKER_CONTAINER_STATE=matching-running FAKE_DOCKER_PROFILE=secret-test \
    run_tty "$worktree" "$docker_log" "$worktree" \
      env DOCS_TOKEN='top-secret-value' TRELLAGE_IMAGE='test/image:locked' TRELLAGE_NETWORK='test_proxy_net' \
      "$prototype_dir/trellage" --profile "$profile"
  assert_docker_env "$docker_log" 'DOCS_TOKEN'
  assert_docker_env "$docker_log" 'TOKEN'
  awk '
    $0 == "CALL" { secret = first = second = ""; next }
    /^ENV\tDOCS_TOKEN=/ { secret = $0; next }
    /^ARG\t/ && first == "" { first = $0; next }
    /^ARG\t/ && second == "" {
      second = $0
      if (secret == "ENV\tDOCS_TOKEN=present" && !(first == "ARG\tcontainer" && second == "ARG\texec")) exit 1
      if (secret == "ENV\tDOCS_TOKEN=present") found++
    }
    END { exit(found == 1 ? 0 : 1) }
  ' "$docker_log" || fail 'secret entered an intermediate Docker child environment'
  ! grep -Fq 'top-secret-value' "$docker_log" || fail 'secret value entered Docker arguments or logs'

  : >"$docker_log"
  FAKE_DOCKER_IMAGE_PROFILE_HASH="$profile_hash" FAKE_DOCKER_CONTAINER_PROFILE_HASH="$profile_hash" \
    FAKE_DOCKER_VOLUME_STATE=matching FAKE_DOCKER_STATE_VOLUME="$state_volume" \
    FAKE_DOCKER_CONTAINER_STATE=matching-running FAKE_DOCKER_PROFILE=secret-test \
    run_non_tty "$worktree" "$docker_log" "$worktree" \
      env DOCS_TOKEN='prompt-secret-value' TRELLAGE_IMAGE='test/image:locked' TRELLAGE_NETWORK='test_proxy_net' \
      "$prototype_dir/trellage" --profile "$profile" -p 'secret prompt'
  awk '
    $0 == "CALL" { secret = first = second = ""; next }
    /^ENV\tDOCS_TOKEN=/ { secret = $0; next }
    /^ARG\t/ && first == "" { first = $0; next }
    /^ARG\t/ && second == "" {
      second = $0
      if (secret == "ENV\tDOCS_TOKEN=present" && !(first == "ARG\tcontainer" && second == "ARG\texec")) exit 1
      if (secret == "ENV\tDOCS_TOKEN=present") found++
    }
    END { exit(found == 1 ? 0 : 1) }
  ' "$docker_log" || fail 'prompt secret entered an intermediate Docker child environment'
  ! grep -Fq 'prompt-secret-value' "$docker_log" \
    || fail 'prompt secret value entered Docker arguments or logs'
  printf 'Trellage host test: PASS: env secrets reach only final Codex exec\n'
}

test_varlock_secrets_reach_only_final_codex_exec() {
  local worktree="$test_root/varlock-worktree"
  local profile="$test_root/varlock.toml"
  local lock="$test_root/varlock.lock.toml"
  local docker_log="$test_root/varlock.docker.log"
  local state_volume profile_hash
  mkdir -p "$worktree"
  sed \
    -e 's/name = "codex-superpowers"/name = "varlock-test"/' \
    -e 's/provider = "env"/provider = "varlock"/' \
    -e 's/required = \[\]/required = ["DOCS_TOKEN"]\nvarlock_path = "."/' \
    -e '/^\[secrets\]/i\
[[mcps]]\
name = "local"\
transport = "stdio"\
command = "local-mcp"\
env_from_secret = { DOCS_TOKEN = "DOCS_TOKEN" }\
' \
    "$prototype_dir/../../profiles/codex-superpowers/profile.toml" >"$profile"
  cp "$prototype_dir/../../profiles/codex-superpowers/profile.lock.toml" "$lock"
  profile_hash="$(shasum -a 256 "$profile" | awk '{print "sha256:" $1}')"
  sed -i.bak "s/^profile_hash = .*/profile_hash = \"$profile_hash\"/" "$lock"
  rm -f "$lock.bak"
  state_volume="$(resource_names "$worktree" varlock-test | tail -n 1)"
  : >"$docker_log"
  printf 'DOCS_TOKEN=varlock-file-secret\n' >"$test_root/.env"
  chmod 600 "$test_root/.env"

  FAKE_DOCKER_IMAGE_PROFILE_HASH="$profile_hash" FAKE_DOCKER_CONTAINER_PROFILE_HASH="$profile_hash" \
    FAKE_DOCKER_VOLUME_STATE=matching FAKE_DOCKER_STATE_VOLUME="$state_volume" \
    FAKE_DOCKER_CONTAINER_STATE=matching-running FAKE_DOCKER_PROFILE=varlock-test \
    run_tty "$worktree" "$docker_log" "$worktree" \
      env DOCS_TOKEN='ambient-must-not-leak' TRELLAGE_IMAGE='test/image:locked' TRELLAGE_NETWORK='test_proxy_net' \
      "$prototype_dir/trellage" --profile "$profile"

  awk '
    $0 == "CALL" { secret = first = second = ""; next }
    /^ENV\tDOCS_TOKEN=/ { secret = $0; next }
    /^ARG\t/ && first == "" { first = $0; next }
    /^ARG\t/ && second == "" {
      second = $0
      if (secret == "ENV\tDOCS_TOKEN=present" && !(first == "ARG\tcontainer" && second == "ARG\texec")) exit 1
      if (secret == "ENV\tDOCS_TOKEN=present") found++
    }
    END { exit(found == 1 ? 0 : 1) }
  ' "$docker_log" || fail 'Varlock secret did not reach only the final Docker exec'
  ! grep -Fq 'ambient-must-not-leak' "$docker_log" \
    || fail 'Varlock secret value entered logs'
  printf 'Trellage host test: PASS: bundled Varlock injection is final-exec-only\n'
}

test_global_varlock_bootstrap_supplies_claude_browser_token() {
  local worktree="$test_root/global-varlock-claude"
  local docker_log="$test_root/global-varlock-claude.docker.log"
  local claude_variant="$test_root/global-varlock-claude.json"
  local config_directory="$test_root/global-varlock-config"
  local state_volume
  mkdir -p "$worktree" "$config_directory"
  chmod 700 "$config_directory"
  printf '# @sensitive\nPLAYWRIGHT_MCP_EXTENSION_TOKEN=\n' >"$config_directory/.env.schema"
  printf 'PLAYWRIGHT_MCP_EXTENSION_TOKEN=browser-from-varlock\n' >"$config_directory/.env.local"
  chmod 600 "$config_directory/.env.local"
  jq \
    '.profile_name = "claude-hyperresearch"
      | .image = "trellage-profile-claude-hyperresearch:locked"
      | .harness_kind = "claude"
      | .harness_executable = "claude"
      | .runtime_entry = "trellage-claude-entry"
      | .default_network = "copilot-proxy-rs_default"
      | .auth_policy = "claude-explicit"
      | .claude_mode = "hyperresearch"
      | .claude_gateway = "http://copilot-proxy-rs:8080"
      | .claude_opus_model = "claude-opus-5"
      | .claude_sonnet_model = "claude-sonnet-5"
      | .claude_haiku_model = "claude-haiku-4.5"
      | .harness_args = []' \
    "$copilot_metadata" >"$claude_variant"
  state_volume="$(resource_names "$worktree" claude-hyperresearch claude | tail -n 1)"
  : >"$docker_log"

  FAKE_HARNESS_METADATA_OVERRIDE="$claude_variant" \
    FAKE_DOCKER_VOLUME_STATE=matching FAKE_DOCKER_STATE_VOLUME="$state_volume" \
    FAKE_DOCKER_CONTAINER_STATE=matching-running \
    FAKE_DOCKER_PROFILE=claude-hyperresearch FAKE_DOCKER_PROTOTYPE=trellage-claude \
    run_copilot_non_tty "$worktree" "$docker_log" "$worktree" \
      env TRELLAGE_ENVIRONMENT=on TRELLAGE_CONFIG="$config_directory/config.toml" \
      TRELLAGE_IMAGE='test/claude:locked' "$prototype_dir/trellage" -p 'browser token probe'

  awk '
    $0 == "CALL" { token = first = second = ""; next }
    /^ENV\tPLAYWRIGHT_MCP_EXTENSION_TOKEN=/ { token = $0; next }
    /^ARG\t/ && first == "" { first = $0; next }
    /^ARG\t/ && second == "" {
      second = $0
      if (token == "ENV\tPLAYWRIGHT_MCP_EXTENSION_TOKEN=present" && !(first == "ARG\tcontainer" && second == "ARG\texec")) exit 1
      if (token == "ENV\tPLAYWRIGHT_MCP_EXTENSION_TOKEN=present") found++
    }
    END { exit(found == 1 ? 0 : 1) }
  ' "$docker_log" || fail 'global Varlock browser token did not reach only the final Claude exec'
  ! grep -Fq 'browser-from-varlock' "$docker_log" "$copilot_node_log" \
    || fail 'global Varlock browser token value entered logs'
  printf 'Trellage host test: PASS: global Varlock bootstrap supplies Claude browser token\n'
}

test_stale_image_label_requires_exact_build() {
  local worktree="$test_root/stale-image-worktree"
  local docker_log="$test_root/stale-image.docker.log"
  local output expected_profile
  mkdir -p "$worktree"
  : >"$docker_log"
  expected_profile="$(cd "$prototype_dir/../.." && pwd)/profiles/codex-superpowers/profile.toml"

  if output="$(FAKE_DOCKER_IMAGE_PROFILE_HASH="sha256:$(printf '0%.0s' {1..64})" \
    run_tty "$worktree" "$docker_log" "$worktree" \
      env TRELLAGE_NETWORK='test_proxy_net' "$prototype_dir/trellage" 2>&1)"; then
    fail 'stale same-name profile image was accepted'
  fi
  grep -Fq "profile image is missing or stale; run: trellage build --locked $expected_profile" <<<"$output" \
    || fail 'stale image did not print the exact build command'
  assert_no_mutation "$docker_log"
  printf 'Trellage host test: PASS: stale image label requires exact build\n'
}

test_stale_runtime_labels_are_rejected_and_doctor_is_read_only() {
  local worktree="$test_root/stale-runtime-worktree"
  local docker_log="$test_root/stale-runtime.docker.log"
  local output state_volume
  mkdir -p "$worktree"
  state_volume="$(resource_names "$worktree" | tail -n 1)"
  : >"$docker_log"

  assert_override_label_stale() {
    local variable="$1"
    local value="$2"
    local label="$3"
    : >"$docker_log"
    if output="$(
      export "$variable=$value"
      run_tty "$worktree" "$docker_log" "$worktree" \
        env TRELLAGE_IMAGE='test/override:locked' TRELLAGE_NETWORK='test_proxy_net' \
        "$prototype_dir/trellage" 2>&1
    )"; then
      fail "explicit image override accepted $label"
    fi
    grep -Fq 'profile image is missing or stale; run:' <<<"$output" \
      || fail "explicit image override $label did not require a rebuild"
    assert_no_mutation "$docker_log"

    : >"$docker_log"
    output="$(
      export "$variable=$value"
      FAKE_DOCKER_VOLUME_STATE=absent FAKE_DOCKER_STATE_VOLUME="$state_volume" \
        FAKE_DOCKER_CONTAINER_STATE=absent \
        run_non_tty "$worktree" "$docker_log" "$worktree" \
          env TRELLAGE_IMAGE='test/override:locked' "$prototype_dir/trellage" doctor
    )"
    grep -Fqx 'image: test/override:locked (stale)' <<<"$output" \
      || fail "doctor accepted explicit image override $label"
    assert_no_mutation "$docker_log"
  }

  assert_override_label_stale FAKE_DOCKER_IMAGE_PROFILE_HASH \
    "sha256:$(printf '1%.0s' {1..64})" 'with a mismatched profile label'
  assert_override_label_stale FAKE_DOCKER_IMAGE_PROFILE_HASH '' 'with a missing profile label'
  assert_override_label_stale FAKE_DOCKER_IMAGE_RUNTIME_HASH \
    "sha256:$(printf '2%.0s' {1..64})" 'with a mismatched runtime label'
  assert_override_label_stale FAKE_DOCKER_IMAGE_RUNTIME_HASH '' 'with a missing runtime label'

  : >"$docker_log"
  FAKE_DOCKER_RETAG_RACE=1 FAKE_DOCKER_RACE_TAG='test/race:latest' \
    FAKE_DOCKER_IMAGE_ID='sha256:resolved-image-id' \
    FAKE_DOCKER_VOLUME_STATE=absent FAKE_DOCKER_STATE_VOLUME="$state_volume" \
    FAKE_DOCKER_CONTAINER_STATE=absent \
    run_tty "$worktree" "$docker_log" "$worktree" \
      env TRELLAGE_IMAGE='test/race:latest' TRELLAGE_NETWORK='test_proxy_net' "$prototype_dir/trellage"
  assert_arg "$docker_log" 'sha256:resolved-image-id'
  [[ "$(grep -Fxc $'ARG\ttest/race:latest' "$docker_log")" -eq 1 ]] \
    || fail 'mutable image tag was reused after immutable ID resolution'
  image_verification_line="$(grep -n -F $'ARG\t{{ .Image }}' "$docker_log" | tail -n 1 | cut -d: -f1)"
  start_line="$(grep -n -F $'ARG\tstart' "$docker_log" | tail -n 1 | cut -d: -f1)"
  [[ -n "$image_verification_line" && -n "$start_line" && "$image_verification_line" -lt "$start_line" ]] \
    || fail 'created container image ID was not verified before start'

  : >"$docker_log"
  if output="$(FAKE_DOCKER_CONTAINER_RUNTIME_HASH="sha256:$(printf '0%.0s' {1..64})" \
    FAKE_DOCKER_VOLUME_STATE=unrelated FAKE_DOCKER_STATE_VOLUME="$state_volume" \
    FAKE_DOCKER_CONTAINER_STATE=matching-running \
    run_tty "$worktree" "$docker_log" "$worktree" "$prototype_dir/trellage" 2>&1)"; then
    fail 'stale container bypassed colliding state-volume validation'
  fi
  grep -Fq 'refusing unrelated Docker volume name collision:' <<<"$output" \
    || fail 'stale container did not preserve state-volume collision diagnostic'
  assert_no_mutation "$docker_log"

  : >"$docker_log"
  if output="$(FAKE_DOCKER_CONTAINER_RUNTIME_HASH="sha256:$(printf '0%.0s' {1..64})" \
    FAKE_DOCKER_VOLUME_STATE=matching FAKE_DOCKER_STATE_VOLUME="$state_volume" \
    FAKE_DOCKER_CONTAINER_STATE=matching-wrong-mount \
    run_tty "$worktree" "$docker_log" "$worktree" "$prototype_dir/trellage" 2>&1)"; then
    fail 'stale container bypassed exact mount validation'
  fi
  grep -Fq 'refusing Docker container with wrong state volume mount:' <<<"$output" \
    || fail 'stale container did not preserve mount collision diagnostic'
  assert_no_mutation "$docker_log"

  : >"$docker_log"
  output="$(FAKE_DOCKER_CONTAINER_LABEL_INSPECT_ERROR=1 \
    FAKE_DOCKER_VOLUME_STATE=matching FAKE_DOCKER_STATE_VOLUME="$state_volume" \
    FAKE_DOCKER_CONTAINER_STATE=matching-running \
    run_non_tty "$worktree" "$docker_log" "$worktree" "$prototype_dir/trellage" doctor)"
  grep -Fqx 'state: error' <<<"$output" \
    || fail 'doctor collapsed container label inspection error into stale'
  assert_no_mutation "$docker_log"

  : >"$docker_log"
  output="$(FAKE_DOCKER_IMAGE_LABEL_INSPECT_ERROR=1 \
    FAKE_DOCKER_VOLUME_STATE=absent FAKE_DOCKER_STATE_VOLUME="$state_volume" \
    FAKE_DOCKER_CONTAINER_STATE=absent \
    run_non_tty "$worktree" "$docker_log" "$worktree" "$prototype_dir/trellage" doctor)"
  grep -Fq ' (error)' <<<"$(grep '^image:' <<<"$output")" \
    || fail 'doctor collapsed image label inspection error into stale'
  assert_no_mutation "$docker_log"

  : >"$docker_log"
  output="$(FAKE_DOCKER_CONTAINER_LABEL_INSPECT_FAIL_ON=3 \
    FAKE_DOCKER_VOLUME_STATE=matching FAKE_DOCKER_STATE_VOLUME="$state_volume" \
    FAKE_DOCKER_CONTAINER_STATE=matching-running \
    run_non_tty "$worktree" "$docker_log" "$worktree" "$prototype_dir/trellage" doctor)"
  grep -Fqx 'state: error' <<<"$output" \
    || fail 'doctor collapsed second-pass container label inspection error into stale'
  assert_no_mutation "$docker_log"

  for invalid_field in profile_hash runtime_hash; do
    invalid_metadata="$test_root/invalid-$invalid_field.json"
    jq --arg field "$invalid_field" '.[$field] = "not-a-sha256"' "$copilot_metadata" >"$invalid_metadata"
    : >"$docker_log"
    if output="$(FAKE_HARNESS_METADATA_OVERRIDE="$invalid_metadata" \
      run_copilot_non_tty "$worktree" "$docker_log" "$worktree" "$prototype_dir/trellage" doctor 2>&1)"; then
      fail "invalid $invalid_field metadata was accepted"
    fi
    grep -Fq "profile metadata has an invalid ${invalid_field%_hash} hash" <<<"$output" \
      || fail "invalid $invalid_field metadata had the wrong diagnostic"
    [[ ! -s "$docker_log" ]] || fail "invalid $invalid_field reached Docker"
  done

  if output="$(FAKE_DOCKER_IMAGE_RUNTIME_HASH="sha256:$(printf '0%.0s' {1..64})" \
    run_tty "$worktree" "$docker_log" "$worktree" \
      env TRELLAGE_NETWORK='test_proxy_net' "$prototype_dir/trellage" 2>&1)"; then
    fail 'stale same-name runtime image was accepted'
  fi
  grep -Fq 'profile image is missing or stale; run:' <<<"$output" \
    || fail 'stale runtime image did not require an exact rebuild'
  assert_no_mutation "$docker_log"

  : >"$docker_log"
  FAKE_DOCKER_CONTAINER_RUNTIME_HASH="sha256:$(printf '0%.0s' {1..64})" \
    FAKE_DOCKER_VOLUME_STATE=matching FAKE_DOCKER_STATE_VOLUME="$state_volume" \
    FAKE_DOCKER_CONTAINER_STATE=matching-running \
    run_tty "$worktree" "$docker_log" "$worktree" \
      env TRELLAGE_NETWORK='test_proxy_net' "$prototype_dir/trellage"
  grep -Fqx $'ARG\trm' "$docker_log" || fail 'stale runtime container was not replaced'
  grep -Fqx $'ARG\tcreate' "$docker_log" || fail 'stale runtime container replacement was not created'

  : >"$docker_log"
  output="$(FAKE_DOCKER_IMAGE_RUNTIME_HASH="sha256:$(printf '0%.0s' {1..64})" \
    FAKE_DOCKER_VOLUME_STATE=absent FAKE_DOCKER_STATE_VOLUME="$state_volume" \
    FAKE_DOCKER_CONTAINER_STATE=absent \
    run_non_tty "$worktree" "$docker_log" "$worktree" "$prototype_dir/trellage" doctor)"
  grep -Fq ' (stale)' <<<"$(grep '^image:' <<<"$output")" \
    || fail 'doctor did not report a stale runtime image'
  assert_no_mutation "$docker_log"

  : >"$docker_log"
  output="$(FAKE_DOCKER_IMAGE_RUNTIME_HASH= \
    FAKE_DOCKER_VOLUME_STATE=absent FAKE_DOCKER_STATE_VOLUME="$state_volume" \
    FAKE_DOCKER_CONTAINER_STATE=absent \
    run_non_tty "$worktree" "$docker_log" "$worktree" "$prototype_dir/trellage" doctor)"
  grep -Fq ' (stale)' <<<"$(grep '^image:' <<<"$output")" \
    || fail 'doctor did not report a missing runtime image label as stale'
  assert_no_mutation "$docker_log"

  : >"$docker_log"
  output="$(FAKE_DOCKER_CONTAINER_RUNTIME_HASH="sha256:$(printf '0%.0s' {1..64})" \
    FAKE_DOCKER_VOLUME_STATE=matching FAKE_DOCKER_STATE_VOLUME="$state_volume" \
    FAKE_DOCKER_CONTAINER_STATE=matching-running \
    run_non_tty "$worktree" "$docker_log" "$worktree" "$prototype_dir/trellage" doctor)"
  grep -Fqx 'state: stale' <<<"$output" || fail 'doctor did not report a stale runtime container'
  assert_no_mutation "$docker_log"

  : >"$docker_log"
  output="$(FAKE_DOCKER_CONTAINER_PROFILE_HASH="sha256:$(printf '0%.0s' {1..64})" \
    FAKE_DOCKER_VOLUME_STATE=matching FAKE_DOCKER_STATE_VOLUME="$state_volume" \
    FAKE_DOCKER_CONTAINER_STATE=matching-running \
    run_non_tty "$worktree" "$docker_log" "$worktree" "$prototype_dir/trellage" doctor)"
  grep -Fqx 'state: stale' <<<"$output" || fail 'doctor did not report a stale profile container hash'
  assert_no_mutation "$docker_log"

  : >"$docker_log"
  output="$(FAKE_DOCKER_CONTAINER_RUNTIME_HASH= \
    FAKE_DOCKER_VOLUME_STATE=matching FAKE_DOCKER_STATE_VOLUME="$state_volume" \
    FAKE_DOCKER_CONTAINER_STATE=matching-running \
    run_non_tty "$worktree" "$docker_log" "$worktree" "$prototype_dir/trellage" doctor)"
  grep -Fqx 'state: stale' <<<"$output" || fail 'doctor did not report a missing runtime container label as stale'
  assert_no_mutation "$docker_log"
  printf 'Trellage host test: PASS: stale runtime labels are rejected read-only\n'
}

test_rebuild_replaces_container_and_preserves_profile_state() {
  local worktree="$test_root/rebuild-worktree"
  local docker_log="$test_root/rebuild.docker.log"
  local state_volume
  mkdir -p "$worktree"
  state_volume="$(resource_names "$worktree" | tail -n 1)"
  : >"$docker_log"

  FAKE_DOCKER_VOLUME_STATE=matching FAKE_DOCKER_STATE_VOLUME="$state_volume" \
    FAKE_DOCKER_CONTAINER_STATE=matching-running \
    FAKE_DOCKER_CONTAINER_IMAGE_ID='sha256:old' FAKE_DOCKER_IMAGE_ID='sha256:new' \
    run_tty "$worktree" "$docker_log" "$worktree" \
      env TRELLAGE_IMAGE='test/image:locked' TRELLAGE_NETWORK='test_proxy_net' \
      "$prototype_dir/trellage"

  grep -Fqx $'ARG\trm' "$docker_log" || fail 'stale profile container was not removed'
  grep -Fqx $'ARG\tcreate' "$docker_log" || fail 'rebuilt profile container was not recreated'
  awk '
    $0 == "CALL" { first = second = ""; next }
    /^ARG\t/ && first == "" { first = $0; next }
    /^ARG\t/ && second == "" {
      second = $0
      if (first == "ARG\tvolume" && (second == "ARG\tcreate" || second == "ARG\trm")) exit 1
    }
  ' "$docker_log" || fail 'profile rebuild mutated the state volume'
  printf 'Trellage host test: PASS: rebuild replaces container and preserves state\n'
}

test_upgrade_delegates_to_effect_cli() {
  local compiler="$prototype_dir/../../packages/trellage-cli/dist/cli.js"
  local fake_node_bin="$test_root/fake-node-bin"
  local node_log="$test_root/upgrade-node.log"
  local help_output real_node
  real_node="$(command -v node)"
  help_output="$("$real_node" "$compiler" --help)"
  grep -Eq -- '- upgrade \[<profile>\]' <<<"$help_output" \
    || fail 'Effect CLI help does not list upgrade'

  mkdir -p "$fake_node_bin"
  printf '%s\n' \
    '#!/bin/sh' \
    'set -eu' \
    'printf '\''ARG\t%s\n'\'' "$@" >"$FAKE_NODE_LOG"' \
    >"$fake_node_bin/node"
  chmod +x "$fake_node_bin/node"
  FAKE_NODE_LOG="$node_log" PATH="$fake_node_bin:$PATH" \
    "$prototype_dir/trellage" upgrade --profile '/tmp/profile with spaces.toml'

  [[ "$(sed -n '1p' "$node_log")" == $'ARG\t'"$compiler" ]] \
    || fail 'upgrade did not delegate to the profile compiler'
  [[ "$(sed -n '2p' "$node_log")" == $'ARG\tupgrade' ]] \
    || fail 'upgrade command was not preserved during delegation'
  [[ "$(sed -n '3p' "$node_log")" == $'ARG\t--profile' ]] \
    || fail 'upgrade profile flag was not preserved during delegation'
  [[ "$(sed -n '4p' "$node_log")" == $'ARG\t/tmp/profile with spaces.toml' ]] \
    || fail 'upgrade profile path was not preserved during delegation'
  [[ "$(wc -l <"$node_log" | tr -d ' ')" -eq 4 ]] \
    || fail 'upgrade delegation added unexpected arguments'
  printf 'Trellage host test: PASS: upgrade delegates to Effect CLI\n'
}

test_interactive_profile_selection() {
  local worktree="$test_root/interactive-profile"
  local docker_log="$test_root/interactive-profile.docker.log"
  local choices="$test_root/interactive-profile-choices.json"
  local metadata="$test_root/interactive-profile-metadata.json"
  local picker_input="$test_root/interactive-picker-input.json"
  local profile="$prototype_dir/../../profiles/codex-superpowers/profile.toml"
  local output profile_hash status=0
  mkdir -p "$worktree"
  : >"$docker_log"
  "$real_node" "$prototype_dir/../../packages/trellage-cli/dist/cli.js" metadata "$profile" \
    | jq '.locked = true | .image = "test/image:locked"' >"$metadata"
  profile_hash="$(jq -er '.profile_hash' "$metadata")"
  jq -n --arg profile "$profile" '[
    {
      value: $profile,
      name: "cap",
      description: ("Interactive\u0001 " + ("x" * 1200)),
      harness: { kind: "codex", version: "v", model: "g" },
      skills: [{ repository: "skills", ref: "v1", select: ["s1", "s2"] }],
      plugins: [{
        adapter: "test",
        repository: "plugins",
        ref: "v1",
        select: ["p1"]
      }],
      mcps: [{ name: "m1" }]
    }
  ]' >"$choices"

  : >"$host_node_log"
  printf '\n' | FAKE_PROFILE_CHOICES="$choices" FAKE_PROFILE_METADATA="$metadata" \
    FAKE_PICKER_INPUT="$picker_input" \
    FAKE_DOCKER_IMAGE_PROFILE_HASH="$profile_hash" \
    run_tty "$worktree" "$docker_log" "$worktree" \
      env TRELLAGE_IMAGE='test/image:locked' TRELLAGE_NETWORK='test_proxy_net' \
      "$prototype_dir/trellage" --interactive
  jq -e '
    .choices[0]
    | .label == "cap / codex"
      and (.description | startswith("Interactive  ") and length == 1213)
      and (.details
        | contains("Declared profile — harness codex v, model g")
          and contains("plugins 1: p1")
          and contains("skill selections 2: s1, s2")
          and contains("MCPs 1: m1"))
      and ([.label,.description,.details] | all(test("[[:cntrl:]]") | not))
  ' "$picker_input" >/dev/null \
    || fail 'interactive choice omitted concise label, description, or declared details'
  grep -Fqx $'ARG\tchoices' "$host_node_log" \
    || fail 'interactive launch did not request compiler choices'
  grep -Fqx $'ARG\t'"$profile" "$host_node_log" \
    || fail 'interactive launch did not feed the selected profile into metadata resolution'
  grep -Fqx $'ARG\texec' "$docker_log" \
    || fail 'interactive selection did not continue through the existing launch flow'

  output="$(run_non_tty "$worktree" "$docker_log" "$worktree" \
    "$prototype_dir/trellage" -i 2>&1)" || status=$?
  [[ "$status" -eq 1 ]] || fail "non-TTY interactive launch returned $status instead of 1"
  grep -Fqx 'trellage: interactive profile selection requires an interactive terminal' <<<"$output" \
    || fail 'non-TTY interactive launch did not report the terminal requirement'

  output="$("$prototype_dir/trellage" --profile "$profile" -i 2>&1)" && \
    fail 'interactive launch accepted --profile'
  grep -Fqx 'trellage: --profile cannot be combined with --interactive' <<<"$output" \
    || fail 'interactive --profile conflict diagnostic is incorrect'

  output="$("$prototype_dir/trellage" resume --interactive 2>&1)" && \
    fail 'resume accepted --interactive'
  grep -Fqx 'trellage: --interactive is not supported for resume' <<<"$output" \
    || fail 'interactive lifecycle diagnostic is incorrect'

  output="$("$prototype_dir/trellage" validate --interactive 2>&1)" && \
    fail 'compiler command accepted --interactive'
  grep -Fqx 'trellage: --interactive is not supported for compiler commands' <<<"$output" \
    || fail 'interactive compiler diagnostic is incorrect'

  status=0
  printf '\033' | FAKE_PROFILE_CHOICES="$choices" FAKE_PROFILE_METADATA="$metadata" \
    run_tty "$worktree" "$docker_log" "$worktree" \
      "$prototype_dir/trellage" -i >/dev/null 2>&1 || status=$?
  [[ "$status" -eq 130 ]] \
    || fail "interactive cancellation returned $status instead of 130"
  printf 'Trellage host test: PASS: interactive profile selection\n'
}

test_compiler_commands_scrub_copilot_auth() {
  local fake_node_bin="$test_root/compiler-auth-node-bin"
  local node_log="$test_root/compiler-auth-node.log"
  local command
  mkdir -p "$fake_node_bin"
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'set -euo pipefail' \
    'printf '\''CALL\n'\'' >>"$FAKE_NODE_LOG"' \
    'printf '\''ENV\tCOPILOT_GITHUB_TOKEN=%s\n'\'' "${COPILOT_GITHUB_TOKEN:+present}" >>"$FAKE_NODE_LOG"' \
    'printf '\''ENV\tGH_TOKEN=%s\n'\'' "${GH_TOKEN:+present}" >>"$FAKE_NODE_LOG"' \
    'printf '\''ENV\tGITHUB_TOKEN=%s\n'\'' "${GITHUB_TOKEN:+present}" >>"$FAKE_NODE_LOG"' \
    'for internal_name in ambient_copilot_github_token ambient_gh_token ambient_github_token copilot_token secret_value secret_source_values; do' \
    '  [[ -z "${!internal_name:-}" ]] || internal_state=present' \
    '  printf '\''ENV\t%s=%s\n'\'' "$internal_name" "${internal_state:-}" >>"$FAKE_NODE_LOG"' \
    '  internal_state=' \
    'done' \
    'printf '\''ARG\t%s\n'\'' "$@" >>"$FAKE_NODE_LOG"' \
    >"$fake_node_bin/node"
  chmod +x "$fake_node_bin/node"
  : >"$node_log"

  for command in validate lock build upgrade; do
    FAKE_NODE_LOG="$node_log" PATH="$fake_node_bin:$PATH" env \
      "${poisoned_internal_auth_env[@]}" \
      COPILOT_GITHUB_TOKEN='compiler-copilot-canary' \
      GH_TOKEN='compiler-gh-canary' \
      GITHUB_TOKEN='compiler-github-canary' \
      "$prototype_dir/trellage" "$command" "$copilot_profile"
    grep -Fqx $'ARG\t'"$command" "$node_log" \
      || fail "$command did not delegate to the profile compiler"
  done
  ! grep -Eq $'ENV\t(COPILOT_GITHUB_TOKEN|GH_TOKEN|GITHUB_TOKEN|ambient_copilot_github_token|ambient_gh_token|ambient_github_token|copilot_token|secret_value|secret_source_values)=present' "$node_log" \
    || fail 'Copilot auth entered a compiler command environment'
  ! grep -Eq 'compiler-(copilot|gh|github)-canary' "$node_log" \
    || fail 'Copilot auth value entered compiler arguments or logs'
  printf 'Trellage host test: PASS: compiler commands scrub Copilot host auth\n'
}

test_copilot_metadata_contract() {
  local fixture="$test_root/copilot-metadata-fixture"
  local profile="$fixture/profile.toml"
  local lock="$fixture/profile.lock.toml"
  local metadata compiler profile_hash source_integrity
  mkdir -p "$fixture"
  printf '%s\n' \
    'schema = 1' \
    'name = "copilot-hve-test"' \
    'description = "Copilot host metadata contract profile"' \
    '[harness]' \
    'kind = "copilot"' \
    'version = "latest"' \
    'args = ["--allow-all"]' \
    '[harness.copilot]' \
    'auth = "host-or-login"' \
    '[image]' \
    'platform = "linux/arm64"' \
    'base = "node:22.17.0-bookworm-slim"' \
    'shell = "fish"' \
    'packages = []' \
    '[[plugins]]' \
    'adapter = "copilot-marketplace"' \
    'repository = "https://github.com/microsoft/hve-core.git"' \
    'ref = "main"' \
    'marketplace = "hve-core"' \
    'select = ["hve-core"]' >"$profile"
  compiler="$prototype_dir/../../packages/trellage-cli/dist/cli.js"
  profile_hash="$($real_node "$compiler" metadata "$profile" | jq -r '.profile_hash')"
  source_integrity="$(printf '%s' '[{"kind":"file","path":"plugins/hve-core/SKILL.md","sha256":"sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"}]' | shasum -a 256 | awk '{print "sha256:" $1}')"
  printf '%s\n' \
    'schema = 1' \
    'source_date_epoch = 1784379906' \
    "profile_hash = \"$profile_hash\"" \
    '[[sources]]' \
    'kind = "plugin"' \
    'adapter = "copilot-marketplace"' \
    'marketplace = "hve-core"' \
    'repository = "https://github.com/microsoft/hve-core.git"' \
    'ref = "main"' \
    'select = ["hve-core"]' \
    'commit = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"' \
    "integrity = \"$source_integrity\"" \
    '[sources.plugin_versions]' \
    '"hve-core" = "3.3.101"' \
    '[[sources.files]]' \
    'kind = "file"' \
    'path = "plugins/hve-core/SKILL.md"' \
    'sha256 = "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"' \
    '[packages]' \
    'runtime = []' \
    '[packages.harness]' \
    'kind = "copilot"' \
    'selector = "latest"' \
    'version = "1.0.75"' \
    'integrity = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"' \
    'url = "https://github.com/github/copilot-cli/releases/download/v1.0.75/copilot-linux-arm64.tar.gz"' \
    'size = 106111479' \
    '[image]' \
    'base = "node:22.17.0-bookworm-slim"' \
    'base_digest = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"' \
    'final_digest = "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"' >"$lock"
  metadata="$($real_node "$compiler" metadata "$profile")"

  [[ "$(jq -r '.harness_kind' <<<"$metadata")" == copilot ]] \
    || fail 'Copilot metadata lacks harness kind'
  [[ "$(jq -r '.harness_executable' <<<"$metadata")" == copilot ]] \
    || fail 'Copilot metadata lacks executable'
  [[ "$(jq -r '.runtime_entry' <<<"$metadata")" == trellage-copilot-entry ]] \
    || fail 'Copilot metadata lacks runtime entry'
  [[ "$(jq -r '.default_network' <<<"$metadata")" == bridge ]] \
    || fail 'Copilot metadata lacks bridge default network'
  [[ "$(jq -r '.auth_policy' <<<"$metadata")" == host-or-login ]] \
    || fail 'Copilot metadata lacks host-or-login auth policy'
  [[ "$(jq -r '.resolved_version' <<<"$metadata")" == 1.0.75 ]] \
    || fail 'Copilot metadata lacks exact resolved version'
  printf 'Trellage host test: PASS: Copilot metadata drives host lifecycle\n'
}

test_host_docker_created_labels_round_trip_without_defaults() {
  local fake_docker="$prototype_dir/tests/fakes/host-docker"
  local fixture_root="$test_root/created-label-round-trip"
  local volume_log="$fixture_root/volume.log"
  local container_log="$fixture_root/container.log"
  local volume_profile container_profile
  mkdir -p "$fixture_root"
  : >"$volume_log"
  : >"$container_log"

  FAKE_DOCKER_LOG="$volume_log" FAKE_DOCKER_VOLUME_STATE=absent \
    FAKE_DOCKER_PROTOTYPE=trellage-copilot FAKE_DOCKER_PROFILE= \
    FAKE_GIT_ROOT=/tmp/fake-worktree \
    "$fake_docker" volume create \
      --label 'dev.trellage.prototype=trellage-copilot' \
      --label 'dev.trellage.worktree=/tmp/fake-worktree' \
      fake-created-volume >/dev/null
  volume_profile="$(FAKE_DOCKER_LOG="$volume_log" FAKE_DOCKER_VOLUME_STATE=absent \
    FAKE_DOCKER_PROTOTYPE=trellage-copilot FAKE_DOCKER_PROFILE= \
    FAKE_GIT_ROOT=/tmp/fake-worktree \
    "$fake_docker" volume inspect --format \
      '{{ index .Labels "dev.trellage.profile" }}' fake-created-volume)" \
    || fail 'fake lost a created volume before inspection'
  [[ -z "$volume_profile" ]] \
    || fail 'fake synthesized a missing created-volume profile label'
  : >"$volume_log"
  [[ -z "$(FAKE_DOCKER_LOG="$volume_log" FAKE_DOCKER_VOLUME_STATE=absent \
    "$fake_docker" volume ls --filter 'name=^fake-created-volume$' --format '{{.Name}}')" ]] \
    || fail 'fake leaked a created volume into a new log generation'
  FAKE_DOCKER_LOG="$volume_log" FAKE_DOCKER_VOLUME_STATE=absent \
    FAKE_DOCKER_PROTOTYPE=wrong-default FAKE_DOCKER_PROFILE=wrong-default \
    FAKE_GIT_ROOT=/tmp/wrong-default \
    "$fake_docker" volume create \
      --label 'dev.trellage.prototype=trellage-copilot' \
      --label 'dev.trellage.worktree=/tmp/fake-worktree' \
      --label 'dev.trellage.profile=copilot-hve-test' \
      fake-created-volume >/dev/null
  volume_profile="$(FAKE_DOCKER_LOG="$volume_log" FAKE_DOCKER_VOLUME_STATE=absent \
    FAKE_DOCKER_PROTOTYPE=wrong-default FAKE_DOCKER_PROFILE=wrong-default \
    FAKE_GIT_ROOT=/tmp/wrong-default \
    "$fake_docker" volume inspect --format \
      '{{ index .Labels "dev.trellage.profile" }}' fake-created-volume)"
  [[ "$volume_profile" == copilot-hve-test ]] \
    || fail 'fake did not round-trip the exact created-volume profile label'

  FAKE_DOCKER_LOG="$container_log" FAKE_DOCKER_CONTAINER_STATE=absent \
    FAKE_DOCKER_PROTOTYPE=trellage-copilot FAKE_DOCKER_PROFILE= \
    FAKE_GIT_ROOT=/tmp/fake-worktree \
    "$fake_docker" container create --name fake-created-container \
      --label 'dev.trellage.prototype=trellage-copilot' \
      --label 'dev.trellage.worktree=/tmp/fake-worktree' \
      fake-image sleep infinity >/dev/null
  container_profile="$(FAKE_DOCKER_LOG="$container_log" FAKE_DOCKER_CONTAINER_STATE=absent \
    FAKE_DOCKER_PROTOTYPE=trellage-copilot FAKE_DOCKER_PROFILE= \
    FAKE_GIT_ROOT=/tmp/fake-worktree \
    "$fake_docker" container inspect --format \
      '{{ index .Config.Labels "dev.trellage.profile" }}' fake-created-container)" \
    || fail 'fake lost a created container before inspection'
  [[ -z "$container_profile" ]] \
    || fail 'fake synthesized a missing created-container profile label'
  : >"$container_log"
  [[ -z "$(FAKE_DOCKER_LOG="$container_log" FAKE_DOCKER_CONTAINER_STATE=absent \
    "$fake_docker" container ls --all --filter 'name=^/fake-created-container$' --format '{{.Names}}')" ]] \
    || fail 'fake leaked a created container into a new log generation'
  FAKE_DOCKER_LOG="$container_log" FAKE_DOCKER_CONTAINER_STATE=absent \
    FAKE_DOCKER_PROTOTYPE=wrong-default FAKE_DOCKER_PROFILE=wrong-default \
    FAKE_GIT_ROOT=/tmp/wrong-default \
    "$fake_docker" container create --name fake-created-container \
      --label 'dev.trellage.prototype=trellage-copilot' \
      --label 'dev.trellage.worktree=/tmp/fake-worktree' \
      --label 'dev.trellage.profile=copilot-hve-test' \
      fake-image sleep infinity >/dev/null
  container_profile="$(FAKE_DOCKER_LOG="$container_log" FAKE_DOCKER_CONTAINER_STATE=absent \
    FAKE_DOCKER_PROTOTYPE=wrong-default FAKE_DOCKER_PROFILE=wrong-default \
    FAKE_GIT_ROOT=/tmp/wrong-default \
    "$fake_docker" container inspect --format \
      '{{ index .Config.Labels "dev.trellage.profile" }}' fake-created-container)"
  [[ "$container_profile" == copilot-hve-test ]] \
    || fail 'fake did not round-trip the exact created-container profile label'
  printf 'Trellage host test: PASS: fake created labels round-trip without defaults\n'
}

test_runtime_dispatch_uses_metadata() {
  local worktree="$test_root/metadata-runtime-worktree"
  local docker_log="$test_root/metadata-runtime.docker.log"
  local copilot_variant="$test_root/copilot-runtime-metadata.json"
  local codex_variant="$test_root/codex-runtime-metadata.json"
  local state_volume
  mkdir -p "$worktree"
  jq \
    '.runtime_entry = "sentinel-copilot-entry"
      | .harness_executable = "sentinel-copilot"' \
    "$copilot_metadata" >"$copilot_variant"
  : >"$docker_log"
  state_volume="$(resource_names "$worktree" copilot-hve-test copilot | tail -n 1)"

  FAKE_HARNESS_METADATA_OVERRIDE="$copilot_variant" FAKE_GH_STATE=failure \
    FAKE_DOCKER_VOLUME_STATE=matching FAKE_DOCKER_STATE_VOLUME="$state_volume" \
    FAKE_DOCKER_CONTAINER_STATE=matching-running \
    FAKE_DOCKER_PROFILE=copilot-hve-test FAKE_DOCKER_PROTOTYPE=trellage-copilot \
    run_copilot_tty "$worktree" "$docker_log" "$worktree" \
      env TRELLAGE_IMAGE='test/copilot:locked' "$prototype_dir/trellage" resume
  grep -Fqx $'ARG\texec sentinel-copilot-entry resume $argv' "$docker_log" \
    || fail 'Copilot resume runtime entry was not selected from metadata'
  grep -Fqx $'ENV\tHERDR_AGENT=sentinel-copilot' "$docker_log" \
    || fail 'Copilot Herdr agent was not selected from metadata'
  ! grep -Fq 'trellage-copilot-entry' "$docker_log" \
    || fail 'hardcoded Copilot runtime entry masked metadata'

  jq \
    '.profile_name = "codex-metadata-test"
      | .image = "trellage-profile-codex-metadata-test:locked"
      | .harness_kind = "codex"
      | .harness_executable = "sentinel-codex"
      | .runtime_entry = "sentinel-codex-entry"
      | .default_network = "copilot-proxy-rs_default"
      | .auth_policy = "profile-secrets"
      | .harness_args = ["--sentinel-arg"]' \
    "$copilot_metadata" >"$codex_variant"
  : >"$docker_log"
  state_volume="$(resource_names "$worktree" codex-metadata-test codex | tail -n 1)"
  FAKE_HARNESS_METADATA_OVERRIDE="$codex_variant" \
    FAKE_DOCKER_VOLUME_STATE=matching FAKE_DOCKER_STATE_VOLUME="$state_volume" \
    FAKE_DOCKER_CONTAINER_STATE=matching-running \
    FAKE_DOCKER_PROFILE=codex-metadata-test FAKE_DOCKER_PROTOTYPE=trellage-codex \
    run_copilot_tty "$worktree" "$docker_log" "$worktree" \
      env TRELLAGE_IMAGE='test/codex:locked' "$prototype_dir/trellage" resume
  grep -Fqx $'ARG\texec sentinel-codex-entry resume sentinel-codex $argv' "$docker_log" \
    || fail 'Codex resume runtime entry and executable were not selected from metadata'
  grep -Fqx $'ENV\tHERDR_AGENT=sentinel-codex' "$docker_log" \
    || fail 'Codex Herdr agent was not selected from metadata'
  ! grep -Fq 'trellage-codex-entry' "$docker_log" \
    || fail 'hardcoded Codex runtime entry masked metadata'
  printf 'Trellage host test: PASS: runtime dispatch uses metadata without hardcoded fallback\n'
}

test_claude_launch_allows_empty_harness_args() {
  local worktree="$test_root/claude-empty-harness-args"
  local docker_log="$test_root/claude-empty-harness-args.docker.log"
  local claude_variant="$test_root/claude-empty-harness-args.json"
  local state_volume
  mkdir -p "$worktree"
  : >"$docker_log"
  jq \
    '.profile_name = "claude-hyperresearch"
      | .image = "trellage-profile-claude-hyperresearch:locked"
      | .harness_kind = "claude"
      | .harness_executable = "claude"
      | .runtime_entry = "trellage-claude-entry"
      | .default_network = "copilot-proxy-rs_default"
      | .auth_policy = "claude-explicit"
      | .harness_args = []
      | .claude_mode = "hyperresearch"
      | .claude_gateway = "http://copilot-proxy-rs:8080"
      | .claude_opus_model = "claude-opus-5"
      | .claude_sonnet_model = "claude-sonnet-5"
      | .claude_haiku_model = "claude-haiku-4.5"
      | .tmpfs_size = "2g"' \
    "$copilot_metadata" >"$claude_variant"
  state_volume="$(resource_names "$worktree" claude-hyperresearch claude | tail -n 1)"

  FAKE_HARNESS_METADATA_OVERRIDE="$claude_variant" \
    FAKE_DOCKER_VOLUME_STATE=matching FAKE_DOCKER_STATE_VOLUME="$state_volume" \
    FAKE_DOCKER_CONTAINER_STATE=absent \
    FAKE_DOCKER_PROFILE=claude-hyperresearch FAKE_DOCKER_PROTOTYPE=trellage-claude \
    run_copilot_tty "$worktree" "$docker_log" "$worktree" \
      env TRELLAGE_IMAGE='test/claude:locked' "$prototype_dir/trellage" \
    || fail 'Claude launch rejected an empty harness argument list'
  grep -Fqx $'ENV\tHERDR_AGENT=claude' "$docker_log" \
    || fail 'Claude launch did not reach its final container exec'
  assert_arg "$docker_log" '/tmp:rw,noexec,nosuid,nodev,size=2g,uid=10001,gid=10001'
  printf 'Trellage host test: PASS: Claude launch allows empty harness args\n'
}

test_claude_core_injects_exact_metadata_routing_only_at_final_exec() {
  local worktree="$test_root/claude-core-routing"
  local docker_log="$test_root/claude-core-routing.docker.log"
  local claude_variant="$test_root/claude-core-routing.json"
  local state_volume
  mkdir -p "$worktree"
  : >"$docker_log"
  jq \
    '.profile_name = "claude-qwen-local"
      | .image = "trellage-profile-claude-qwen-local:locked"
      | .harness_kind = "claude"
      | .harness_executable = "claude"
      | .runtime_entry = "trellage-claude-entry"
      | .default_network = "copilot-proxy-rs_default"
      | .auth_policy = "claude-explicit"
      | .claude_mode = "core"
      | .claude_gateway = "http://copilot-proxy-rs:8080"
      | .claude_opus_model = "qwen3.6-35b-a3b-local"
      | .claude_sonnet_model = "qwen3.6-35b-a3b-local"
      | .claude_haiku_model = "qwen3.6-35b-a3b-local"
      | .harness_args = []' \
    "$copilot_metadata" >"$claude_variant"
  state_volume="$(resource_names "$worktree" claude-qwen-local claude | tail -n 1)"

  FAKE_HARNESS_METADATA_OVERRIDE="$claude_variant" \
    FAKE_DOCKER_VOLUME_STATE=matching FAKE_DOCKER_STATE_VOLUME="$state_volume" \
    FAKE_DOCKER_CONTAINER_STATE=matching-running \
    FAKE_DOCKER_PROFILE=claude-qwen-local FAKE_DOCKER_PROTOTYPE=trellage-claude \
    FAKE_DOCKER_EXPECT_CLAUDE_MODE=core \
    FAKE_DOCKER_EXPECT_CLAUDE_GATEWAY=http://copilot-proxy-rs:8080 \
    FAKE_DOCKER_EXPECT_CLAUDE_OPUS_MODEL=qwen3.6-35b-a3b-local \
    FAKE_DOCKER_EXPECT_CLAUDE_SONNET_MODEL=qwen3.6-35b-a3b-local \
    FAKE_DOCKER_EXPECT_CLAUDE_HAIKU_MODEL=qwen3.6-35b-a3b-local \
    run_copilot_non_tty "$worktree" "$docker_log" "$worktree" \
      env PLAYWRIGHT_MCP_EXTENSION_TOKEN=browser-poison TRELLAGE_IMAGE='test/claude:locked' \
      "$prototype_dir/trellage" -p 'literal Qwen -p'

  [[ "$(grep -Fxc $'ENV\tCLAUDE_PROXY_ROUTING=matched' "$docker_log")" -eq 1 ]] \
    || fail 'exact Qwen gateway and alias routing did not reach only the final Claude exec'
  ! grep -Fq $'ENV\tPLAYWRIGHT_MCP_EXTENSION_TOKEN=present' "$docker_log" \
    || fail 'Claude core mode forwarded a browser credential'
  grep -Fqx $'ARG\tbash' "$docker_log" \
    || fail 'Claude core mode did not use its Python-free Bash runtime'
  grep -Fqx $'ARG\t-c' "$docker_log" \
    || fail 'Claude core mode used a login shell that resets the locked tool PATH'
  [[ "$(tail -n 1 "$docker_log")" == $'ARG\tliteral Qwen -p' ]] \
    || fail 'Claude core prompt was not passed literally'
  printf 'Trellage host test: PASS: Claude core injects exact metadata routing only at final exec\n'
}

test_copilot_lifecycle_identity_and_runtime() {
  local worktree="$test_root/copilot-lifecycle"
  local docker_log="$test_root/copilot-lifecycle.docker.log"
  local output codex_output copilot_container codex_container state_volume
  mkdir -p "$worktree"
  : >"$docker_log"
  : >"$copilot_node_log"
  : >"$copilot_gh_log"
  state_volume="$(resource_names "$worktree" copilot-hve-test copilot | tail -n 1)"

  FAKE_GH_STATE=failure FAKE_DOCKER_PROTOTYPE=trellage-copilot \
    FAKE_DOCKER_PROFILE=copilot-hve-test \
    run_copilot_tty "$worktree" "$docker_log" "$worktree" \
      env TRELLAGE_IMAGE='test/copilot:locked' \
      "$prototype_dir/trellage" 'research $(touch /tmp/not-executed)'

  assert_arg "$docker_log" "$(resource_names "$worktree" copilot-hve-test copilot | head -n 1)"
  assert_arg "$docker_log" "$state_volume"
  assert_arg "$docker_log" 'dev.trellage.prototype=trellage-copilot'
  assert_create_label "$docker_log" volume \
    'dev.trellage.prototype=trellage-copilot'
  assert_create_label "$docker_log" volume \
    "dev.trellage.worktree=$worktree"
  assert_create_label "$docker_log" volume \
    'dev.trellage.profile=copilot-hve-test'
  assert_create_label "$docker_log" container \
    'dev.trellage.prototype=trellage-copilot'
  assert_create_label "$docker_log" container \
    "dev.trellage.worktree=$worktree"
  assert_create_label "$docker_log" container \
    'dev.trellage.profile=copilot-hve-test'
  assert_arg "$docker_log" 'bridge'
  assert_arg "$docker_log" 'set prompt $argv[-1]; set -e argv[-1]; exec trellage-copilot-entry new $argv -- $prompt'
  assert_arg "$docker_log" 'research $(touch /tmp/not-executed)'
  assert_arg "$docker_log" '--allow-all'
  [[ "$(grep -Fxc $'ENV\tHERDR_AGENT=copilot' "$docker_log")" -eq 1 ]] \
    || fail 'final Copilot exec lacks its exclusive agent hint'

  : >"$docker_log"
  FAKE_GH_STATE=failure \
    FAKE_DOCKER_VOLUME_STATE=matching FAKE_DOCKER_STATE_VOLUME="$state_volume" \
    FAKE_DOCKER_CONTAINER_STATE=matching-running \
    FAKE_DOCKER_PROFILE=copilot-hve-test FAKE_DOCKER_PROTOTYPE=trellage-copilot \
    run_copilot_tty "$worktree" "$docker_log" "$worktree" \
      env TRELLAGE_IMAGE='test/copilot:locked' "$prototype_dir/trellage" resume
  grep -Fqx $'ARG\texec trellage-copilot-entry resume $argv' "$docker_log" \
    || fail 'Copilot resume did not delegate native --continue handling to its runtime entry'
  ! grep -Fq 'trellage-codex-entry' "$docker_log" \
    || fail 'Copilot lifecycle invoked the Codex runtime entry'

  : >"$docker_log"
  codex_output="$(run_non_tty "$worktree" "$docker_log" "$worktree" \
    env TRELLAGE_IMAGE='test/image:doctor' TRELLAGE_NETWORK='test_doctor_net' \
    "$prototype_dir/trellage" doctor)"
  copilot_container="$(run_copilot_non_tty "$worktree" "$docker_log" "$worktree" \
    env FAKE_GH_STATE=failure TRELLAGE_IMAGE='test/copilot:doctor' \
    "$prototype_dir/trellage" doctor | sed -n 's/^container: //p')"
  codex_container="$(sed -n 's/^container: //p' <<<"$codex_output")"
  [[ "$codex_container" == trellage-codex-* && "$copilot_container" == trellage-copilot-* ]] \
    || fail 'Codex and Copilot resource identities are not harness-specific'
  [[ "$codex_container" != "$copilot_container" ]] \
    || fail 'Codex and Copilot collide on one worktree'
  printf 'Trellage host test: PASS: Copilot lifecycle identity and runtime are isolated\n'
}

test_copilot_rebuild_shell_and_doctor() {
  local worktree="$test_root/copilot-rebuild"
  local docker_log="$test_root/copilot-rebuild.docker.log"
  local output state_volume
  mkdir -p "$worktree"
  state_volume="$(resource_names "$worktree" copilot-hve-test copilot | tail -n 1)"
  : >"$docker_log"

  FAKE_GH_STATE=failure \
    FAKE_DOCKER_VOLUME_STATE=matching FAKE_DOCKER_STATE_VOLUME="$state_volume" \
    FAKE_DOCKER_CONTAINER_STATE=matching-running \
    FAKE_DOCKER_PROFILE=copilot-hve-test FAKE_DOCKER_PROTOTYPE=trellage-copilot \
    FAKE_DOCKER_CONTAINER_IMAGE_ID='sha256:old' FAKE_DOCKER_IMAGE_ID='sha256:new' \
    run_copilot_tty "$worktree" "$docker_log" "$worktree" \
      env TRELLAGE_IMAGE='test/copilot:locked' "$prototype_dir/trellage"
  grep -Fqx $'ARG\trm' "$docker_log" || fail 'stale Copilot container was not removed'
  grep -Fqx $'ARG\tcreate' "$docker_log" || fail 'stale Copilot container was not recreated'
  awk '
    $0 == "CALL" { first = second = ""; next }
    /^ARG\t/ && first == "" { first = $0; next }
    /^ARG\t/ && second == "" {
      second = $0
      if (first == "ARG\tvolume" && (second == "ARG\tcreate" || second == "ARG\trm")) exit 1
    }
  ' "$docker_log" || fail 'Copilot stale-container replacement mutated its state volume'

  : >"$docker_log"
  FAKE_DOCKER_VOLUME_STATE=matching FAKE_DOCKER_STATE_VOLUME="$state_volume" \
    FAKE_DOCKER_CONTAINER_STATE=matching-running \
    FAKE_DOCKER_PROFILE=copilot-hve-test FAKE_DOCKER_PROTOTYPE=trellage-copilot \
    run_copilot_tty "$worktree" "$docker_log" "$worktree" \
      env COPILOT_GITHUB_TOKEN='shell-isolation-canary' TRELLAGE_IMAGE='test/copilot:locked' \
      "$prototype_dir/trellage" shell
  ! grep -Fqx $'ENV\tCOPILOT_GITHUB_TOKEN=present' "$docker_log" \
    || fail 'Copilot token reached recovery shell Docker process'
  ! grep -Fqx $'ARG\tCOPILOT_GITHUB_TOKEN' "$docker_log" \
    || fail 'Copilot token was forwarded to recovery shell'
  assert_no_agent_hint "$docker_log"

  : >"$docker_log"
  output="$(run_copilot_non_tty "$worktree" "$docker_log" "$worktree" \
    env FAKE_GH_TOKEN='doctor-auth-canary' TRELLAGE_IMAGE='test/copilot:doctor' \
    "$prototype_dir/trellage" doctor 2>&1)"
  grep -Fqx 'harness kind: copilot' <<<"$output" \
    || fail 'doctor omitted Copilot harness kind'
  grep -Fqx 'resolved version: 1.0.75' <<<"$output" \
    || fail 'doctor omitted exact Copilot version'
  grep -Fqx 'host auth: gh' <<<"$output" \
    || fail 'doctor omitted value-free gh auth source'
  ! grep -Fq 'doctor-auth-canary' <<<"$output" \
    || fail 'doctor printed a Copilot token value'
  assert_no_mutation "$docker_log"
  printf 'Trellage host test: PASS: Copilot rebuild, shell, and doctor contracts hold\n'
}

assert_copilot_auth_forwarding() {
  local docker_log="$1"
  local node_log="$2"
  assert_docker_env "$docker_log" 'COPILOT_GITHUB_TOKEN'
  [[ "$(grep -Fxc $'ENV\tCOPILOT_GITHUB_TOKEN=matched' "$docker_log")" -eq 1 ]] \
    || fail 'selected Copilot token did not reach exactly one Docker process'
  awk '
    $0 == "CALL" { token = first = second = ""; next }
    /^ENV\tCOPILOT_GITHUB_TOKEN=/ { token = $0; next }
    /^ARG\t/ && first == "" { first = $0; next }
    /^ARG\t/ && second == "" {
      second = $0
      if (token == "ENV\tCOPILOT_GITHUB_TOKEN=matched" && !(first == "ARG\tcontainer" && second == "ARG\texec")) exit 1
      if (token == "ENV\tCOPILOT_GITHUB_TOKEN=matched") found++
    }
    END { exit(found == 1 ? 0 : 1) }
  ' "$docker_log" || fail 'selected Copilot token reached a non-final Docker process'
  ! grep -Eq $'ENV\t(GH_TOKEN|GITHUB_TOKEN)=present' "$docker_log" \
    || fail 'alternate GitHub token entered a Docker child environment'
  ! grep -Fqx $'ARG\tGH_TOKEN' "$docker_log" \
    || fail 'GH_TOKEN was forwarded with Docker --env'
  ! grep -Fqx $'ARG\tGITHUB_TOKEN' "$docker_log" \
    || fail 'GITHUB_TOKEN was forwarded with Docker --env'
  ! grep -Eq $'ENV\t(COPILOT_GITHUB_TOKEN|GH_TOKEN|GITHUB_TOKEN)=present' "$node_log" \
    || fail 'host auth token entered compiler metadata resolution'
  assert_internal_auth_scrubbed_from_child_log 'Copilot metadata child' "$node_log"
  assert_internal_auth_scrubbed_from_child_log 'Copilot final Docker exec' "$docker_log"
}

run_copilot_auth_case() {
  local label="$1"
  local copilot_value="$2"
  local gh_value="$3"
  local github_value="$4"
  local gh_state="$5"
  local gh_value_from_cli="$6"
  local expected="$7"
  local worktree="$test_root/copilot-auth-$label"
  local docker_log="$test_root/copilot-auth-$label.docker.log"
  local output state_volume expected_hash
  mkdir -p "$worktree"
  state_volume="$(resource_names "$worktree" copilot-hve-test copilot | tail -n 1)"
  expected_hash="$(printf '%s' "$expected" | shasum -a 256 | awk '{print $1}')"
  : >"$docker_log"
  : >"$copilot_node_log"
  : >"$copilot_gh_log"

  output="$(FAKE_DOCKER_VOLUME_STATE=matching FAKE_DOCKER_STATE_VOLUME="$state_volume" \
    FAKE_DOCKER_CONTAINER_STATE=matching-running \
    FAKE_DOCKER_PROFILE=copilot-hve-test FAKE_DOCKER_PROTOTYPE=trellage-copilot \
    FAKE_DOCKER_EXPECT_COPILOT_TOKEN_SHA256="$expected_hash" \
    run_copilot_tty "$worktree" "$docker_log" "$worktree" \
      env "${poisoned_internal_auth_env[@]}" \
      COPILOT_GITHUB_TOKEN="$copilot_value" GH_TOKEN="$gh_value" GITHUB_TOKEN="$github_value" \
      FAKE_GH_STATE="$gh_state" FAKE_GH_TOKEN="$gh_value_from_cli" \
      TRELLAGE_IMAGE='test/copilot:locked' "$prototype_dir/trellage" 2>&1)"
  ! grep -Fq "$expected" <<<"$output" \
    || fail "$label Copilot token appeared in stdout or stderr"
  ! grep -Fq "$expected" "$docker_log" "$copilot_node_log" "$copilot_gh_log" \
    || fail "$label Copilot token appeared in a fake invocation log"
  assert_copilot_auth_forwarding "$docker_log" "$copilot_node_log"
}

test_copilot_auth_precedence_and_leakage() {
  run_copilot_auth_case precedence \
    'copilot-first-canary' 'gh-second-canary' 'github-third-canary' \
    success 'gh-last-canary' 'copilot-first-canary'
  [[ ! -s "$copilot_gh_log" ]] \
    || fail 'gh was consulted despite COPILOT_GITHUB_TOKEN'

  run_copilot_auth_case gh-env \
    '' 'gh-environment-canary' 'github-lower-canary' \
    success 'gh-cli-lower-canary' 'gh-environment-canary'
  [[ ! -s "$copilot_gh_log" ]] \
    || fail 'gh was consulted despite GH_TOKEN'

  run_copilot_auth_case github-env \
    '' '' 'github-environment-canary' \
    success 'gh-cli-lower-canary' 'github-environment-canary'
  [[ ! -s "$copilot_gh_log" ]] \
    || fail 'gh was consulted despite GITHUB_TOKEN'

  run_copilot_auth_case gh-cli \
    '' '' '' success 'gh-cli-canary' 'gh-cli-canary'
  grep -Fqx $'ARG\tauth' "$copilot_gh_log" || fail 'gh fallback did not request auth token'
  grep -Fqx $'ARG\ttoken' "$copilot_gh_log" || fail 'gh fallback did not request auth token'
  grep -Fqx $'ARG\t--hostname' "$copilot_gh_log" || fail 'gh fallback omitted hostname flag'
  grep -Fqx $'ARG\tgithub.com' "$copilot_gh_log" || fail 'gh fallback omitted default hostname'
  ! grep -Eq $'ENV\t(COPILOT_GITHUB_TOKEN|GH_TOKEN|GITHUB_TOKEN)=present' "$copilot_gh_log" \
    || fail 'inherited token reached gh fallback'

  local worktree="$test_root/copilot-auth-login"
  local docker_log="$test_root/copilot-auth-login.docker.log"
  local output state_volume
  mkdir -p "$worktree"
  state_volume="$(resource_names "$worktree" copilot-hve-test copilot | tail -n 1)"
  : >"$docker_log"
  : >"$copilot_node_log"
  : >"$copilot_gh_log"
  output="$(FAKE_DOCKER_VOLUME_STATE=matching FAKE_DOCKER_STATE_VOLUME="$state_volume" \
    FAKE_DOCKER_CONTAINER_STATE=matching-running \
    FAKE_DOCKER_PROFILE=copilot-hve-test FAKE_DOCKER_PROTOTYPE=trellage-copilot \
    run_copilot_tty "$worktree" "$docker_log" "$worktree" \
      env COPILOT_GITHUB_TOKEN='' GH_TOKEN='' GITHUB_TOKEN='' \
      FAKE_GH_STATE=failure FAKE_GH_TOKEN='failing-gh-canary' \
      TRELLAGE_IMAGE='test/copilot:locked' "$prototype_dir/trellage" 2>&1)"
  ! grep -Fq 'failing-gh-canary' <<<"$output" \
    || fail 'failed gh lookup printed a token value'
  ! grep -Fqx $'ARG\tCOPILOT_GITHUB_TOKEN' "$docker_log" \
    || fail 'missing host auth forwarded an empty token'
  ! grep -Eq $'ENV\t(COPILOT_GITHUB_TOKEN|GH_TOKEN|GITHUB_TOKEN)=(present|matched)' "$docker_log" \
    || fail 'missing host auth reached a Docker process'
  grep -Fqx $'ARG\texec trellage-copilot-entry new $argv' "$docker_log" \
    || fail 'missing host auth did not launch Copilot login flow'
  printf 'Trellage host test: PASS: Copilot auth precedence and leakage contracts hold\n'
}

test_pi_host_auth_dispatch_and_doctor() {
  local worktree="$test_root/pi-host-auth"
  local docker_log="$test_root/pi-host-auth.docker.log"
  local state_volume expected_hash output pi_profile_hash
  mkdir -p "$worktree"
  state_volume="$(resource_names "$worktree" pi-oh-my-pi-test pi | tail -n 1)"
  expected_hash="$(printf '%s' 'pi-host-token-canary' | shasum -a 256 | awk '{print $1}')"
  pi_profile_hash="$(jq -r '.profile_hash' "$pi_metadata")"
  : >"$docker_log"
  : >"$copilot_node_log"
  : >"$copilot_gh_log"

  output="$(FAKE_HARNESS_METADATA_OVERRIDE="$pi_metadata" \
    FAKE_DOCKER_VOLUME_STATE=matching FAKE_DOCKER_STATE_VOLUME="$state_volume" \
    FAKE_DOCKER_CONTAINER_STATE=matching-running \
    FAKE_DOCKER_PROFILE=pi-oh-my-pi-test FAKE_DOCKER_PROTOTYPE=trellage-pi \
    FAKE_DOCKER_IMAGE_PROFILE_HASH="$pi_profile_hash" \
    FAKE_DOCKER_CONTAINER_PROFILE_HASH="$pi_profile_hash" \
    FAKE_DOCKER_EXPECT_COPILOT_TOKEN_SHA256="$expected_hash" \
    run_copilot_tty "$worktree" "$docker_log" "$worktree" \
      env COPILOT_GITHUB_TOKEN='pi-host-token-canary' \
      GH_TOKEN='pi-poison-gh' GITHUB_TOKEN='pi-poison-github' \
      TRELLAGE_IMAGE='test/pi:locked' "$prototype_dir/trellage" 2>&1)"
  ! grep -Fq 'pi-host-token-canary' <<<"$output" \
    || fail 'Pi launch printed selected Copilot authentication'
  assert_copilot_auth_forwarding "$docker_log" "$copilot_node_log"
  grep -Fqx $'ARG\texec trellage-pi-entry new $argv' "$docker_log" \
    || fail 'Pi launch did not dispatch through the Pi runtime entry'
  grep -Fqx $'ENV\tHERDR_AGENT=omp' "$docker_log" \
    || fail 'Pi launch did not select the OMP host agent hint'

  : >"$docker_log"
  output="$(FAKE_HARNESS_METADATA_OVERRIDE="$pi_metadata" \
    FAKE_DOCKER_PROFILE=pi-oh-my-pi-test FAKE_DOCKER_PROTOTYPE=trellage-pi \
    FAKE_DOCKER_IMAGE_PROFILE_HASH="$pi_profile_hash" \
    FAKE_DOCKER_CONTAINER_PROFILE_HASH="$pi_profile_hash" \
    run_copilot_non_tty "$worktree" "$docker_log" "$worktree" \
      env FAKE_GH_TOKEN='pi-doctor-auth-canary' TRELLAGE_IMAGE='test/pi:doctor' \
      "$prototype_dir/trellage" doctor 2>&1)"
  grep -Fqx 'harness kind: pi' <<<"$output" || fail 'doctor omitted Pi harness kind'
  grep -Fqx 'resolved version: 17.2.6' <<<"$output" || fail 'doctor omitted exact Pi version'
  grep -Fqx 'host auth: gh' <<<"$output" || fail 'doctor omitted Pi gh auth readiness'
  grep -Fqx 'network: bridge (available)' <<<"$output" || fail 'doctor omitted Pi bridge network'
  ! grep -Fq 'pi-doctor-auth-canary' <<<"$output" || fail 'doctor printed a Pi token value'
  assert_no_mutation "$docker_log"

  : >"$docker_log"
  : >"$copilot_gh_log"
  FAKE_HARNESS_METADATA_OVERRIDE="$pi_metadata" \
    FAKE_DOCKER_VOLUME_STATE=matching FAKE_DOCKER_STATE_VOLUME="$state_volume" \
    FAKE_DOCKER_CONTAINER_STATE=matching-running \
    FAKE_DOCKER_PROFILE=pi-oh-my-pi-test FAKE_DOCKER_PROTOTYPE=trellage-pi \
    FAKE_DOCKER_IMAGE_PROFILE_HASH="$pi_profile_hash" \
    FAKE_DOCKER_CONTAINER_PROFILE_HASH="$pi_profile_hash" \
    run_copilot_tty "$worktree" "$docker_log" "$worktree" \
      env COPILOT_GITHUB_TOKEN='' GH_TOKEN='' GITHUB_TOKEN='' FAKE_GH_STATE=failure \
      TRELLAGE_IMAGE='test/pi:locked' "$prototype_dir/trellage"
  ! grep -Fqx $'ARG\tCOPILOT_GITHUB_TOKEN' "$docker_log" \
    || fail 'Pi login fallback forwarded an empty token'
  grep -Fqx $'ARG\texec trellage-pi-entry new $argv' "$docker_log" \
    || fail 'Pi login fallback did not launch native OMP login flow'
  printf 'Trellage host test: PASS: Pi auth, dispatch, and doctor contracts hold\n'
}

test_copilot_launches_when_gh_is_genuinely_absent() {
  local worktree="$test_root/copilot-auth-no-gh"
  local docker_log="$test_root/copilot-auth-no-gh.docker.log"
  local state_volume
  mkdir -p "$worktree"
  state_volume="$(resource_names "$worktree" copilot-hve-test copilot | tail -n 1)"
  : >"$docker_log"
  : >"$copilot_node_log"
  if env PATH="$no_gh_bin" bash -c 'command -v gh >/dev/null 2>&1'; then
    fail 'isolated no-gh PATH still resolves gh'
  fi

  FAKE_DOCKER_VOLUME_STATE=matching FAKE_DOCKER_STATE_VOLUME="$state_volume" \
    FAKE_DOCKER_CONTAINER_STATE=matching-running \
    FAKE_DOCKER_PROFILE=copilot-hve-test FAKE_DOCKER_PROTOTYPE=trellage-copilot \
    run_tty "$worktree" "$docker_log" "$worktree" \
      env PATH="$no_gh_bin" \
      FAKE_HARNESS_METADATA="$copilot_metadata" \
      FAKE_NODE_LOG="$copilot_node_log" \
      FAKE_REAL_NODE="$real_node" \
      TRELLAGE_IMAGE='test/copilot:locked' "$prototype_dir/trellage"
  ! grep -Fqx $'ARG\tCOPILOT_GITHUB_TOKEN' "$docker_log" \
    || fail 'absent gh caused an empty Copilot token to be forwarded'
  ! grep -Eq $'ENV\t(COPILOT_GITHUB_TOKEN|GH_TOKEN|GITHUB_TOKEN)=(present|matched)' "$docker_log" \
    || fail 'absent gh launch leaked a GitHub token'
  grep -Fqx $'ARG\texec trellage-copilot-entry new $argv' "$docker_log" \
    || fail 'absent gh did not reach Copilot login flow'
  printf 'Trellage host test: PASS: genuinely absent gh reaches login flow\n'
}

test_copilot_auth_isolated_across_create_start_stop_destroy() {
  local worktree="$test_root/copilot-auth-lifecycle"
  local docker_log="$test_root/copilot-auth-lifecycle.docker.log"
  local mise_log="$test_root/copilot-auth-lifecycle.mise.log"
  local output state_volume container_name confirmation expected_hash
  local selected='lifecycle-selected-canary'
  local gh_alternate='lifecycle-gh-alternate-canary'
  local github_alternate='lifecycle-github-alternate-canary'
  mkdir -p "$worktree"
  container_name="$(resource_names "$worktree" copilot-hve-test copilot | head -n 1)"
  state_volume="$(resource_names "$worktree" copilot-hve-test copilot | tail -n 1)"
  expected_hash="$(printf '%s' "$selected" | shasum -a 256 | awk '{print $1}')"
  : >"$docker_log"
  : >"$copilot_node_log"
  : >"$copilot_gh_log"
  : >"$mise_log"

  output="$(FAKE_DOCKER_EXPECT_COPILOT_TOKEN_SHA256="$expected_hash" \
    FAKE_DOCKER_PROFILE=copilot-hve-test FAKE_DOCKER_PROTOTYPE=trellage-copilot \
    FAKE_MISE_LOG="$mise_log" \
    run_copilot_tty "$worktree" "$docker_log" "$worktree" \
      env COPILOT_GITHUB_TOKEN="$selected" GH_TOKEN="$gh_alternate" GITHUB_TOKEN="$github_alternate" \
      TRELLAGE_IMAGE='test/copilot:locked' "$prototype_dir/trellage" 2>&1)"
  grep -Fqx $'ARG\tcreate' "$docker_log" || fail 'auth create-path case did not create a container'
  grep -Fqx $'ARG\tstart' "$docker_log" || fail 'auth create-path case did not start a container'
  assert_copilot_auth_forwarding "$docker_log" "$copilot_node_log"
  ! grep -Eq $'ENV\tCOPILOT_GITHUB_TOKEN=present' "$docker_log" \
    || fail 'selected token reached a non-final create/start Docker process'
  [[ ! -s "$mise_log" ]] || fail 'Copilot auth path invoked mise'
  [[ ! -s "$copilot_gh_log" ]] || fail 'Copilot auth path invoked gh despite environment auth'
  ! grep -Fq "$selected" "$docker_log" "$copilot_node_log" "$copilot_gh_log" "$mise_log" \
    || fail 'selected token value entered create/start artifacts'
  ! grep -Fq "$selected" <<<"$output" || fail 'selected token value entered create/start output'
  ! grep -Fq "$gh_alternate" "$docker_log" "$copilot_node_log" "$copilot_gh_log" "$mise_log" \
    || fail 'GH_TOKEN value entered create/start artifacts'
  ! grep -Fq "$github_alternate" "$docker_log" "$copilot_node_log" "$copilot_gh_log" "$mise_log" \
    || fail 'GITHUB_TOKEN value entered create/start artifacts'

  : >"$docker_log"
  : >"$copilot_node_log"
  output="$(FAKE_DOCKER_VOLUME_STATE=matching FAKE_DOCKER_STATE_VOLUME="$state_volume" \
    FAKE_DOCKER_CONTAINER_STATE=matching-running \
    FAKE_DOCKER_PROFILE=copilot-hve-test FAKE_DOCKER_PROTOTYPE=trellage-copilot \
    FAKE_MISE_LOG="$mise_log" \
    run_copilot_non_tty "$worktree" "$docker_log" "$worktree" \
      env COPILOT_GITHUB_TOKEN="$selected" GH_TOKEN="$gh_alternate" GITHUB_TOKEN="$github_alternate" \
      TRELLAGE_IMAGE='test/copilot:locked' "$prototype_dir/trellage" stop 2>&1)"
  grep -Fqx $'ARG\tstop' "$docker_log" || fail 'auth stop-path case did not stop the container'
  ! grep -Eq $'ENV\t(COPILOT_GITHUB_TOKEN|GH_TOKEN|GITHUB_TOKEN)=(present|matched)' "$docker_log" \
    || fail 'host auth reached a stop Docker process'
  ! grep -Eq $'ARG\t(COPILOT_GITHUB_TOKEN|GH_TOKEN|GITHUB_TOKEN)' "$docker_log" \
    || fail 'host auth name reached stop Docker arguments'
  ! grep -Fq "$selected" <<<"$output" || fail 'selected token value entered stop output'

  : >"$docker_log"
  : >"$copilot_node_log"
  confirmation="destroy $container_name $state_volume"
  output="$(FAKE_DOCKER_VOLUME_STATE=matching FAKE_DOCKER_STATE_VOLUME="$state_volume" \
    FAKE_DOCKER_CONTAINER_STATE=matching-running \
    FAKE_DOCKER_PROFILE=copilot-hve-test FAKE_DOCKER_PROTOTYPE=trellage-copilot \
    FAKE_MISE_LOG="$mise_log" \
    run_copilot_non_tty "$worktree" "$docker_log" "$worktree" \
      env COPILOT_GITHUB_TOKEN="$selected" GH_TOKEN="$gh_alternate" GITHUB_TOKEN="$github_alternate" \
      TRELLAGE_IMAGE='test/copilot:locked' "$prototype_dir/trellage" destroy <<<"$confirmation" 2>&1)"
  grep -Fqx $'ARG\trm' "$docker_log" || fail 'auth destroy-path case did not remove resources'
  ! grep -Eq $'ENV\t(COPILOT_GITHUB_TOKEN|GH_TOKEN|GITHUB_TOKEN)=(present|matched)' "$docker_log" \
    || fail 'host auth reached a destroy Docker process'
  ! grep -Eq $'ARG\t(COPILOT_GITHUB_TOKEN|GH_TOKEN|GITHUB_TOKEN)' "$docker_log" \
    || fail 'host auth name reached destroy Docker arguments'
  ! grep -Fq "$selected" <<<"$output" || fail 'selected token value entered destroy output'
  [[ ! -s "$mise_log" ]] || fail 'stop/destroy auth path invoked mise'
  printf 'Trellage host test: PASS: auth is isolated across create/start/stop/destroy\n'
}

assert_internal_auth_scrubbed_from_child_log() {
  local label="$1"
  local log="$2"
  ! grep -Eq $'ENV\t(ambient_copilot_github_token|ambient_gh_token|ambient_github_token|copilot_token|secret_value|secret_source_values)=present' "$log" \
    || fail "$label inherited an internal auth variable"
}

assert_github_auth_scrubbed_from_child_log() {
  local label="$1"
  local log="$2"
  ! grep -Eq $'ENV\t(COPILOT_GITHUB_TOKEN|GH_TOKEN|GITHUB_TOKEN)=present' "$log" \
    || fail "$label inherited GitHub auth"
  assert_internal_auth_scrubbed_from_child_log "$label" "$log"
}

test_codex_scrubs_github_auth_before_children() {
  local worktree="$test_root/codex-auth-scrub"
  local docker_log="$test_root/codex-auth-scrub.docker.log"
  local output state_volume
  local selected='codex-copilot-canary'
  local gh_alternate='codex-gh-canary'
  local github_alternate='codex-github-canary'
  mkdir -p "$worktree"
  state_volume="$(resource_names "$worktree" | tail -n 1)"
  : >"$docker_log"
  : >"$host_node_log"

  output="$(run_tty "$worktree" "$docker_log" "$worktree" \
    env "${poisoned_internal_auth_env[@]}" \
    COPILOT_GITHUB_TOKEN="$selected" GH_TOKEN="$gh_alternate" GITHUB_TOKEN="$github_alternate" \
    TRELLAGE_IMAGE='test/image:codex-auth-scrub' TRELLAGE_NETWORK='test_auth_scrub_net' \
    "$prototype_dir/trellage" 2>&1)"
  assert_github_auth_scrubbed_from_child_log 'Codex compiler metadata child' "$host_node_log"
  assert_github_auth_scrubbed_from_child_log 'Codex Docker child' "$docker_log"
  ! grep -Eq $'ARG\t(COPILOT_GITHUB_TOKEN|GH_TOKEN|GITHUB_TOKEN)' "$docker_log" \
    || fail 'Codex final exec forwarded GitHub auth'
  ! grep -Fq "$selected" <<<"$output" || fail 'Codex launch traced COPILOT_GITHUB_TOKEN'
  ! grep -Fq "$gh_alternate" <<<"$output" || fail 'Codex launch traced GH_TOKEN'
  ! grep -Fq "$github_alternate" <<<"$output" || fail 'Codex launch traced GITHUB_TOKEN'

  : >"$docker_log"
  : >"$host_node_log"
  output="$(FAKE_DOCKER_VOLUME_STATE=matching FAKE_DOCKER_STATE_VOLUME="$state_volume" \
    FAKE_DOCKER_CONTAINER_STATE=matching-running \
    run_tty "$worktree" "$docker_log" "$worktree" \
      env "${poisoned_internal_auth_env[@]}" \
      COPILOT_GITHUB_TOKEN="$selected" GH_TOKEN="$gh_alternate" GITHUB_TOKEN="$github_alternate" \
      TRELLAGE_IMAGE='test/image:codex-auth-scrub' TRELLAGE_NETWORK='test_auth_scrub_net' \
      "$prototype_dir/trellage" resume 2>&1)"
  assert_github_auth_scrubbed_from_child_log 'Codex resume metadata child' "$host_node_log"
  assert_github_auth_scrubbed_from_child_log 'Codex resume Docker child' "$docker_log"
  ! grep -Fq "$selected" <<<"$output" || fail 'Codex resume traced COPILOT_GITHUB_TOKEN'
  ! grep -Fq "$gh_alternate" <<<"$output" || fail 'Codex resume traced GH_TOKEN'
  ! grep -Fq "$github_alternate" <<<"$output" || fail 'Codex resume traced GITHUB_TOKEN'

  : >"$docker_log"
  : >"$host_node_log"
  output="$(run_non_tty "$worktree" "$docker_log" "$worktree" \
    env "${poisoned_internal_auth_env[@]}" \
    COPILOT_GITHUB_TOKEN="$selected" GH_TOKEN="$gh_alternate" GITHUB_TOKEN="$github_alternate" \
    TRELLAGE_IMAGE='test/image:codex-auth-scrub' TRELLAGE_NETWORK='test_auth_scrub_net' \
    "$prototype_dir/trellage" doctor 2>&1)"
  assert_github_auth_scrubbed_from_child_log 'Codex doctor metadata child' "$host_node_log"
  assert_github_auth_scrubbed_from_child_log 'Codex doctor Docker child' "$docker_log"
  ! grep -Fq "$selected" <<<"$output" || fail 'Codex doctor traced COPILOT_GITHUB_TOKEN'
  ! grep -Fq "$gh_alternate" <<<"$output" || fail 'Codex doctor traced GH_TOKEN'
  ! grep -Fq "$github_alternate" <<<"$output" || fail 'Codex doctor traced GITHUB_TOKEN'
  printf 'Trellage host test: PASS: Codex scrubs GitHub auth before children\n'
}

test_copilot_non_agent_modes_skip_auth_discovery_and_xtrace_is_safe() {
  local worktree="$test_root/copilot-auth-non-agent"
  local docker_log="$test_root/copilot-auth-non-agent.docker.log"
  local output state_volume container_name confirmation mode
  local selected='xtrace-copilot-canary'
  local gh_alternate='xtrace-gh-canary'
  local github_alternate='xtrace-github-canary'
  mkdir -p "$worktree"
  container_name="$(resource_names "$worktree" copilot-hve-test copilot | head -n 1)"
  state_volume="$(resource_names "$worktree" copilot-hve-test copilot | tail -n 1)"
  confirmation="destroy $container_name $state_volume"

  for mode in shell stop destroy; do
    : >"$docker_log"
    : >"$copilot_node_log"
    : >"$copilot_gh_log"
    if [[ "$mode" == destroy ]]; then
      output="$(FAKE_DOCKER_VOLUME_STATE=matching FAKE_DOCKER_STATE_VOLUME="$state_volume" \
        FAKE_DOCKER_CONTAINER_STATE=matching-running \
        FAKE_DOCKER_PROFILE=copilot-hve-test FAKE_DOCKER_PROTOTYPE=trellage-copilot \
        run_copilot_non_tty "$worktree" "$docker_log" "$worktree" \
          env "${poisoned_internal_auth_env[@]}" \
          COPILOT_GITHUB_TOKEN="$selected" GH_TOKEN="$gh_alternate" GITHUB_TOKEN="$github_alternate" \
          TRELLAGE_IMAGE='test/copilot:locked' "$prototype_dir/trellage" destroy <<<"$confirmation" 2>&1)"
    elif [[ "$mode" == shell ]]; then
      output="$(FAKE_DOCKER_VOLUME_STATE=matching FAKE_DOCKER_STATE_VOLUME="$state_volume" \
        FAKE_DOCKER_CONTAINER_STATE=matching-running \
        FAKE_DOCKER_PROFILE=copilot-hve-test FAKE_DOCKER_PROTOTYPE=trellage-copilot \
        run_copilot_tty "$worktree" "$docker_log" "$worktree" \
          env "${poisoned_internal_auth_env[@]}" \
          COPILOT_GITHUB_TOKEN="$selected" GH_TOKEN="$gh_alternate" GITHUB_TOKEN="$github_alternate" \
          TRELLAGE_IMAGE='test/copilot:locked' "$prototype_dir/trellage" shell 2>&1)"
    else
      output="$(FAKE_DOCKER_VOLUME_STATE=matching FAKE_DOCKER_STATE_VOLUME="$state_volume" \
        FAKE_DOCKER_CONTAINER_STATE=matching-running \
        FAKE_DOCKER_PROFILE=copilot-hve-test FAKE_DOCKER_PROTOTYPE=trellage-copilot \
        run_copilot_non_tty "$worktree" "$docker_log" "$worktree" \
          env "${poisoned_internal_auth_env[@]}" \
          COPILOT_GITHUB_TOKEN="$selected" GH_TOKEN="$gh_alternate" GITHUB_TOKEN="$github_alternate" \
          TRELLAGE_IMAGE='test/copilot:locked' "$prototype_dir/trellage" stop 2>&1)"
    fi
    [[ ! -s "$copilot_gh_log" ]] || fail "$mode consulted gh"
    assert_github_auth_scrubbed_from_child_log "$mode metadata child" "$copilot_node_log"
    assert_github_auth_scrubbed_from_child_log "$mode Docker child" "$docker_log"
    ! grep -Fq "$selected" <<<"$output" || fail "$mode printed COPILOT_GITHUB_TOKEN"
    ! grep -Fq "$gh_alternate" <<<"$output" || fail "$mode printed GH_TOKEN"
    ! grep -Fq "$github_alternate" <<<"$output" || fail "$mode printed GITHUB_TOKEN"
  done

  : >"$docker_log"
  : >"$copilot_node_log"
  : >"$copilot_gh_log"
  output="$(run_copilot_non_tty "$worktree" "$docker_log" "$worktree" \
    env "${poisoned_internal_auth_env[@]}" \
    COPILOT_GITHUB_TOKEN="$selected" GH_TOKEN="$gh_alternate" GITHUB_TOKEN="$github_alternate" \
    TRELLAGE_IMAGE='test/copilot:doctor' bash -x "$prototype_dir/trellage" doctor 2>&1)"
  ! grep -Fq "$selected" <<<"$output" || fail 'bash -x printed COPILOT_GITHUB_TOKEN'
  ! grep -Fq "$gh_alternate" <<<"$output" || fail 'bash -x printed GH_TOKEN'
  ! grep -Fq "$github_alternate" <<<"$output" || fail 'bash -x printed GITHUB_TOKEN'
  assert_github_auth_scrubbed_from_child_log 'bash -x metadata child' "$copilot_node_log"
  assert_github_auth_scrubbed_from_child_log 'bash -x Docker child' "$docker_log"
  printf 'Trellage host test: PASS: non-agent modes skip auth and xtrace is safe\n'
}

test_copilot_gh_host_precedence() {
  local worktree="$test_root/copilot-gh-host-precedence"
  local docker_log="$test_root/copilot-gh-host-precedence.docker.log"
  local state_volume expected_hash
  mkdir -p "$worktree"
  state_volume="$(resource_names "$worktree" copilot-hve-test copilot | tail -n 1)"
  expected_hash="$(printf '%s' 'enterprise-host-canary' | shasum -a 256 | awk '{print $1}')"
  : >"$docker_log"
  : >"$copilot_node_log"
  : >"$copilot_gh_log"

  FAKE_DOCKER_VOLUME_STATE=matching FAKE_DOCKER_STATE_VOLUME="$state_volume" \
    FAKE_DOCKER_CONTAINER_STATE=matching-running \
    FAKE_DOCKER_PROFILE=copilot-hve-test FAKE_DOCKER_PROTOTYPE=trellage-copilot \
    FAKE_DOCKER_EXPECT_COPILOT_TOKEN_SHA256="$expected_hash" \
    run_copilot_tty "$worktree" "$docker_log" "$worktree" \
      env "${poisoned_internal_auth_env[@]}" \
      COPILOT_GH_HOST='copilot.example.test' GH_HOST='gh.example.test' \
      FAKE_GH_TOKEN='enterprise-host-canary' TRELLAGE_IMAGE='test/copilot:locked' \
      "$prototype_dir/trellage"
  grep -Fqx $'ARG\tcopilot.example.test' "$copilot_gh_log" \
    || fail 'COPILOT_GH_HOST did not override GH_HOST'
  ! grep -Fqx $'ARG\tgh.example.test' "$copilot_gh_log" \
    || fail 'GH_HOST overrode COPILOT_GH_HOST'
  assert_internal_auth_scrubbed_from_child_log 'gh fallback' "$copilot_gh_log"
  assert_copilot_auth_forwarding "$docker_log" "$copilot_node_log"
  printf 'Trellage host test: PASS: COPILOT_GH_HOST overrides GH_HOST\n'
}

test_legacy_product_environment_is_ignored() {
  local worktree="$test_root/legacy-product-environment"
  local docker_log="$test_root/legacy-product-environment.docker.log"
  local output
  mkdir -p "$worktree"
  : >"$docker_log"
  : >"$copilot_node_log"
  : >"$copilot_gh_log"

  output="$(FAKE_GH_STATE=failure \
    run_copilot_non_tty "$worktree" "$docker_log" "$worktree" \
      env \
      HARNESS_IMAGE='legacy/image:must-not-be-used' \
      HARNESS_NETWORK='legacy_network_must_not_be_used' \
      HARNESS_CODEX_HOME='/legacy-codex-home-must-not-be-used' \
      HARNESS_CODEX_SEED_HOME='/legacy-codex-seed-must-not-be-used' \
      HARNESS_COPILOT_HOME='/legacy-copilot-home-must-not-be-used' \
      HARNESS_COPILOT_SEED_HOME='/legacy-copilot-seed-must-not-be-used' \
      HARNESS_FLOCK='/legacy-flock-must-not-be-used' \
      HARNESS_TEST_OUTPUT='/legacy-test-output-must-not-be-used' \
      "$prototype_dir/trellage" doctor)"

  grep -Fqx 'image: trellage-profile-copilot-hve-test:locked (available)' <<<"$output" \
    || fail 'legacy HARNESS_IMAGE changed the selected image'
  grep -Fqx 'network: bridge (available)' <<<"$output" \
    || fail 'legacy HARNESS_NETWORK changed the selected network'
  ! grep -Eq 'legacy[-_/](image|network|codex|copilot|flock|test)' \
    "$docker_log" \
    || fail 'legacy product environment entered Docker arguments'
  printf 'Trellage host test: PASS: legacy product environment is ignored\n'
}

test_command_diagnostics_use_trellage_prefix() {
  local worktree="$test_root/diagnostic-prefix"
  local docker_log="$test_root/diagnostic-prefix.docker.log"
  local output status=0
  mkdir -p "$worktree"
  : >"$docker_log"

  output="$(run_non_tty "$worktree" "$docker_log" "$worktree" \
    "$prototype_dir/trellage" 2>&1)" || status=$?
  [[ "$status" -ne 0 ]] || fail 'noninteractive launch unexpectedly succeeded'
  grep -Fqx 'trellage: an interactive terminal is required' <<<"$output" \
    || fail 'command diagnostic does not use the exact trellage prefix'
  ! grep -Fq 'harness:' <<<"$output" \
    || fail 'legacy command diagnostic prefix remains observable'
  printf 'Trellage host test: PASS: command diagnostics use trellage prefix\n'
}

if [[ "${TRELLAGE_HOST_PROMPT_ONLY:-}" == 1 ]]; then
  test_resume_uses_native_thread_without_prompt_replay
  test_bare_command_has_no_prompt
  test_portable_prompt_mode_is_noninteractive_and_literal
  test_portable_prompt_is_detached_for_each_harness
  test_portable_prompt_parser_contract
  exit 0
fi

if [[ "${TRELLAGE_HOST_RUNTIME_IDENTITY_ONLY:-}" == 1 ]]; then
  test_stale_runtime_labels_are_rejected_and_doctor_is_read_only
  exit 0
fi

if [[ "${TRELLAGE_HOST_INTERACTIVE_ONLY:-}" == 1 ]]; then
  test_interactive_profile_selection
  exit 0
fi

if [[ "${TRELLAGE_HOST_PI_ONLY:-}" == 1 ]]; then
  test_pi_host_auth_dispatch_and_doctor
  exit 0
fi

if [[ "${TRELLAGE_HOST_CLAUDE_CORE_ONLY:-}" == 1 ]]; then
  test_claude_core_injects_exact_metadata_routing_only_at_final_exec
  exit 0
fi

test_claude_launch_allows_empty_harness_args
test_claude_core_injects_exact_metadata_routing_only_at_final_exec
test_upgrade_delegates_to_effect_cli
test_interactive_profile_selection
test_compiler_commands_scrub_copilot_auth
test_copilot_metadata_contract
test_host_docker_created_labels_round_trip_without_defaults
test_resource_identity_isolates_codex_and_copilot_profiles
test_codex_profile_resources_reuse_running_and_stopped_state
test_runtime_dispatch_uses_metadata
test_copilot_lifecycle_identity_and_runtime
test_copilot_rebuild_shell_and_doctor
test_copilot_auth_precedence_and_leakage
test_pi_host_auth_dispatch_and_doctor
test_copilot_launches_when_gh_is_genuinely_absent
test_copilot_auth_isolated_across_create_start_stop_destroy
test_codex_scrubs_github_auth_before_children
test_copilot_non_agent_modes_skip_auth_discovery_and_xtrace_is_safe
test_copilot_gh_host_precedence
test_legacy_product_environment_is_ignored
test_command_diagnostics_use_trellage_prefix
test_new_container_from_subdirectory
test_resume_uses_native_thread_without_prompt_replay
test_bare_command_has_no_prompt
test_portable_prompt_mode_is_noninteractive_and_literal
test_portable_prompt_is_detached_for_each_harness
test_portable_prompt_parser_contract
test_stopped_and_collision_behavior
test_stale_container_preserves_active_sessions
test_volume_collision_and_mount_validation
test_shell_and_stop_modes
test_terminal_environment_and_agent_tagging
test_validation_precedes_mutation
test_invalid_tmpfs_metadata_precedes_mutation
test_false_tmpfs_metadata_precedes_mutation
test_null_tmpfs_metadata_precedes_mutation
test_legacy_tmpfs_metadata_defaults_at_launch
test_requires_tty_and_returns_exec_status
test_doctor_reports_status_without_mutation_or_secrets
test_stop_rejects_collisions_and_wrong_mounts
test_destroy_requires_exact_confirmation_and_removes_in_order
test_destroy_is_idempotent_and_collision_safe
test_destroy_revalidates_after_confirmation
test_env_secrets_reach_only_final_codex_exec
test_varlock_secrets_reach_only_final_codex_exec
test_global_varlock_bootstrap_supplies_claude_browser_token
test_stale_image_label_requires_exact_build
test_stale_runtime_labels_are_rejected_and_doctor_is_read_only
test_rebuild_replaces_container_and_preserves_profile_state
