#!/usr/bin/env bash
if [[ "${BASH_SOURCE[0]}" != "$0" ]]; then
  return 0
fi
set -euo pipefail

image_ref="${IMAGE_REF:-trellage-codex:test}"
watchdog_seconds="${RUNTIME_WATCHDOG_SECONDS:-60}"
prototype_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
copilot_runtime_entry="$prototype_dir/runtime-copilot-entry.sh"
test_root=
suffix=
volume_name=
volume_created=0
container_name=
container_id=
prototype_label='dev.trellage.prototype'
worktree_label='dev.trellage.worktree'

fail() {
  printf 'Trellage runtime startup test: FAIL: %s\n' "$1" >&2
  exit 1
}

sha256_path() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
    return
  fi
  shasum -a 256 "$1" | awk '{print $1}'
}

create_copilot_seed() {
  local seed="$1"
  local plugin="$seed/installed-plugins/hve-core/hve-core"
  local managed_path
  mkdir -p "$plugin/.github/plugin" "$plugin/commands"
  printf '{"name":"hve-core","version":"3.3.101"}\n' \
    >"$plugin/.github/plugin/plugin.json"
  printf 'managed review command\n' >"$plugin/commands/review.md"
  printf '{"schema":1,"marketplace":"hve-core","plugin":"hve-core","version":"3.3.101"}\n' \
    >"$seed/managed-lock.json"
  printf '%s\n' \
    '{' \
    '  "extraKnownMarketplaces": {' \
    '    "hve-core": { "source": { "source": "github", "repo": "microsoft/hve-core" } }' \
    '  },' \
    '  "enabledPlugins": { "hve-core@hve-core": true }' \
    '}' >"$seed/managed-settings.json"
  printf '%s\n' \
    'installed-plugins/hve-core/hve-core/.github/plugin/plugin.json' \
    'installed-plugins/hve-core/hve-core/commands/review.md' \
    'managed-lock.json' \
    'managed-settings.json' >"$seed/managed-files.txt"
  : >"$seed/managed.sha256"
  while IFS= read -r managed_path; do
    printf '%s  %s\n' "$(sha256_path "$seed/$managed_path")" "$managed_path" \
      >>"$seed/managed.sha256"
  done <"$seed/managed-files.txt"
}

create_fake_copilot() {
  local fake_bin="$1"
  local utility
  mkdir -p "$fake_bin"
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'set -euo pipefail' \
    'printf "%s\n" "$#" >"$TRELLAGE_TEST_OUTPUT/argc"' \
    ': >"$TRELLAGE_TEST_OUTPUT/argv"' \
    'for argument in "$@"; do' \
    '  printf "%s\0" "$argument" >>"$TRELLAGE_TEST_OUTPUT/argv"' \
    'done' \
    'printf "%s\n" "$COPILOT_HOME" >"$TRELLAGE_TEST_OUTPUT/copilot-home"' \
    'if [[ "${COPILOT_GITHUB_TOKEN+x}" == x ]]; then' \
    '  printf "present\n" >"$TRELLAGE_TEST_OUTPUT/token-presence"' \
    'else' \
    '  printf "absent\n" >"$TRELLAGE_TEST_OUTPUT/token-presence"' \
    'fi' \
    'if [[ "${COPILOT_GITHUB_TOKEN-}" == runtime-contract-secret' \
    '  && "${GH_TOKEN+x}" != x && "${GITHUB_TOKEN+x}" != x ]]; then' \
    '  printf "exact-copilot-only\n" >"$TRELLAGE_TEST_OUTPUT/auth-contract"' \
    'elif [[ "${COPILOT_GITHUB_TOKEN+x}" != x' \
    '  && "${GH_TOKEN+x}" != x && "${GITHUB_TOKEN+x}" != x ]]; then' \
    '  printf "token-free\n" >"$TRELLAGE_TEST_OUTPUT/auth-contract"' \
    'else' \
    '  printf "mismatch\n" >"$TRELLAGE_TEST_OUTPUT/auth-contract"' \
    'fi' >"$fake_bin/copilot"
  chmod 755 "$fake_bin/copilot"

  for utility in realpath jq sha256sum find sort sed cut cmp grep mktemp cp mv stat chmod cat mkdir python3 rm; do
    printf '%s\n' \
      '#!/usr/bin/env bash' \
      'set -euo pipefail' \
      'utility="${0##*/}"' \
      'printf "%s\tCOPILOT_GITHUB_TOKEN=%s\tGH_TOKEN=%s\tGITHUB_TOKEN=%s\n" \
        "$utility" "${COPILOT_GITHUB_TOKEN+x}" "${GH_TOKEN+x}" "${GITHUB_TOKEN+x}" \
        >>"$TRELLAGE_TEST_OUTPUT/preexec-env"' \
      'target="$(PATH=/usr/local/bin:/usr/bin:/bin:/sbin command -v "$utility")"' \
      '[[ -n "$target" && "$target" != "$0" ]]' \
      'exec "$target" "$@"' \
      >"$fake_bin/$utility"
    chmod 755 "$fake_bin/$utility"
  done
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'set -euo pipefail' \
    'printf "flock\tCOPILOT_GITHUB_TOKEN=%s\tGH_TOKEN=%s\tGITHUB_TOKEN=%s\n" \
      "${COPILOT_GITHUB_TOKEN+x}" "${GH_TOKEN+x}" "${GITHUB_TOKEN+x}" \
      >>"$TRELLAGE_TEST_OUTPUT/preexec-env"' \
    '[[ "$#" -eq 2 && ( "$1" == -x || "$1" == -u ) && "$2" == 9 ]]' \
    >"$fake_bin/flock"
  chmod 755 "$fake_bin/flock"
}

run_copilot_case() {
  local case_root="$1"
  shift
  local entry_command=(/test/runtime-copilot-entry.sh)
  local token_args=()
  local runtime_args=()
  if [[ "${COPILOT_TEST_TOKEN_PRESENT:-0}" == 1 ]]; then
    token_args=(
      --env 'COPILOT_GITHUB_TOKEN=runtime-contract-secret'
      --env 'GH_TOKEN=runtime-gh-must-be-scrubbed'
      --env 'GITHUB_TOKEN=runtime-github-must-be-scrubbed'
    )
  fi
  if [[ "${COPILOT_TEST_XTRACE:-0}" == 1 ]]; then
    entry_command=(-x /test/runtime-copilot-entry.sh)
  fi
  mkdir -p "$case_root/output"
  : >"$case_root/output/preexec-env"
  if [[ "${COPILOT_TEST_NATIVE_RUNTIME:-0}" == 1 ]]; then
    runtime_args=(
      --tmpfs '/home/agent:rw,nosuid,nodev,size=64m,uid=10001,gid=10001'
    )
  else
    mkdir -p "$case_root/runtime"
    runtime_args=(
      --mount "type=bind,src=$case_root/runtime,dst=/home/agent/.copilot"
    )
  fi
  docker run --rm \
    --network none \
    --read-only \
    --entrypoint /bin/bash \
    --mount "type=bind,src=$copilot_runtime_entry,dst=/test/runtime-copilot-entry.sh,readonly" \
    --mount "type=bind,src=$case_root/seed,dst=/usr/local/share/trellage/copilot-seed,readonly" \
    "${runtime_args[@]}" \
    --mount "type=bind,src=$case_root/fake-bin,dst=/test-bin,readonly" \
    --mount "type=bind,src=$case_root/fake-bin/flock,dst=/usr/bin/flock,readonly" \
    --mount "type=bind,src=$case_root/output,dst=/test-output" \
    --env 'PATH=/test-bin:/usr/local/bin:/usr/bin:/bin' \
    --env 'TRELLAGE_TEST_OUTPUT=/test-output' \
    --env 'TRELLAGE_FLOCK=/test-bin/flock' \
    --env 'HARNESS_COPILOT_SEED_HOME=/legacy-seed-must-not-be-used' \
    --env 'HARNESS_COPILOT_HOME=/legacy-home-must-not-be-used' \
    --env 'HARNESS_FLOCK=/legacy-flock-must-not-be-used' \
    --env 'HARNESS_TEST_OUTPUT=/legacy-test-output-must-not-be-used' \
    ${token_args[@]+"${token_args[@]}"} \
    "$image_ref" "${entry_command[@]}" "$@" \
    >"$case_root/runtime.log" 2>&1
}

assert_copilot_case() {
  local case_root="$1"
  local expected_token_presence="$2"
  shift 2
  local expected="$case_root/expected-argv"
  local expected_count="$#" argument
  : >"$expected"
  for argument in "$@"; do
    printf '%s\0' "$argument" >>"$expected"
  done
  [[ "$(cat "$case_root/output/argc")" == "$expected_count" ]] \
    || fail "Copilot argc mismatch for $(basename "$case_root")"
  cmp -s "$expected" "$case_root/output/argv" \
    || fail "Copilot argv mismatch for $(basename "$case_root")"
  [[ "$(cat "$case_root/output/copilot-home")" == /home/agent/.copilot ]] \
    || fail "COPILOT_HOME mismatch for $(basename "$case_root")"
  [[ "$(cat "$case_root/output/token-presence")" == "$expected_token_presence" ]] \
    || fail "token presence mismatch for $(basename "$case_root")"
  if [[ "$expected_token_presence" == present ]]; then
    [[ "$(cat "$case_root/output/auth-contract")" == exact-copilot-only ]] \
      || fail "final Copilot exec did not receive only the exact selected token for $(basename "$case_root")"
  else
    [[ "$(cat "$case_root/output/auth-contract")" == token-free ]] \
      || fail "token-free Copilot path received GitHub auth for $(basename "$case_root")"
  fi
  [[ -s "$case_root/output/preexec-env" ]] \
    || fail "no pre-exec child utility was observed for $(basename "$case_root")"
  if grep -Evq $'\tCOPILOT_GITHUB_TOKEN=\tGH_TOKEN=\tGITHUB_TOKEN=$' \
    "$case_root/output/preexec-env"; then
    fail "pre-exec child utility inherited GitHub auth for $(basename "$case_root")"
  fi
  if grep -Fq 'runtime-contract-secret' "$case_root/runtime.log"; then
    fail "token value leaked in runtime output for $(basename "$case_root")"
  fi
  if grep -Eq 'runtime-(gh|github)-must-be-scrubbed' "$case_root/runtime.log"; then
    fail "alternate GitHub token leaked in runtime output for $(basename "$case_root")"
  fi
}

run_copilot_startup_contract() {
  local case_root prompt

  case_root="$test_root/copilot-new-bare"
  mkdir -p "$case_root"
  create_copilot_seed "$case_root/seed"
  create_fake_copilot "$case_root/fake-bin"
  run_copilot_case "$case_root" new
  assert_copilot_case "$case_root" absent

  case_root="$test_root/copilot-new-native-filesystem"
  mkdir -p "$case_root"
  create_copilot_seed "$case_root/seed"
  create_fake_copilot "$case_root/fake-bin"
  if ! COPILOT_TEST_NATIVE_RUNTIME=1 run_copilot_case "$case_root" new; then
    cat "$case_root/runtime.log" >&2
    fail 'normal plugin staging failed on a native container filesystem'
  fi
  assert_copilot_case "$case_root" absent

  case_root="$test_root/copilot-new-empty-prompt"
  mkdir -p "$case_root"
  create_copilot_seed "$case_root/seed"
  create_fake_copilot "$case_root/fake-bin"
  run_copilot_case "$case_root" new -- ''
  assert_copilot_case "$case_root" absent -i ''

  case_root="$test_root/copilot-new"
  mkdir -p "$case_root"
  create_copilot_seed "$case_root/seed"
  create_fake_copilot "$case_root/fake-bin"
  run_copilot_case "$case_root" new --model gpt-test
  assert_copilot_case "$case_root" absent --model gpt-test
  cmp -s \
    "$case_root/seed/installed-plugins/hve-core/hve-core/commands/review.md" \
    "$case_root/runtime/installed-plugins/hve-core/hve-core/commands/review.md" \
    || fail 'new Copilot volume did not receive the managed HVE tree'
  jq -e '
    .extraKnownMarketplaces["hve-core"].source
      == {"source":"github","repo":"microsoft/hve-core"}
    and .enabledPlugins["hve-core@hve-core"] == true
  ' "$case_root/runtime/settings.json" >/dev/null \
    || fail 'new Copilot volume did not receive managed settings'

  case_root="$test_root/copilot-prompt"
  prompt=$'-review the exact argv, including spaces\nand a second line'
  mkdir -p "$case_root"
  create_copilot_seed "$case_root/seed"
  create_fake_copilot "$case_root/fake-bin"
  COPILOT_TEST_TOKEN_PRESENT=1 COPILOT_TEST_XTRACE=1 \
    run_copilot_case "$case_root" new --model gpt-test -- "$prompt"
  assert_copilot_case "$case_root" present --model gpt-test -i "$prompt"

  case_root="$test_root/copilot-version-token-free"
  mkdir -p "$case_root"
  create_copilot_seed "$case_root/seed"
  create_fake_copilot "$case_root/fake-bin"
  COPILOT_TEST_TOKEN_PRESENT=1 \
    run_copilot_case "$case_root" new --version
  assert_copilot_case "$case_root" absent --version

  case_root="$test_root/copilot-plugin-list-token-free"
  mkdir -p "$case_root"
  create_copilot_seed "$case_root/seed"
  create_fake_copilot "$case_root/fake-bin"
  COPILOT_TEST_TOKEN_PRESENT=1 \
    run_copilot_case "$case_root" new plugin list
  assert_copilot_case "$case_root" absent plugin list

  case_root="$test_root/copilot-resume"
  mkdir -p "$case_root"
  create_copilot_seed "$case_root/seed"
  create_fake_copilot "$case_root/fake-bin"
  run_copilot_case "$case_root" resume --model gpt-test
  assert_copilot_case "$case_root" absent --model gpt-test --continue

  case_root="$test_root/copilot-resume-with-token"
  mkdir -p "$case_root"
  create_copilot_seed "$case_root/seed"
  create_fake_copilot "$case_root/fake-bin"
  COPILOT_TEST_TOKEN_PRESENT=1 \
    run_copilot_case "$case_root" resume --model gpt-test
  assert_copilot_case "$case_root" present --model gpt-test --continue

  case_root="$test_root/copilot-resume-bare"
  mkdir -p "$case_root"
  create_copilot_seed "$case_root/seed"
  create_fake_copilot "$case_root/fake-bin"
  run_copilot_case "$case_root" resume
  assert_copilot_case "$case_root" absent --continue

  case_root="$test_root/copilot-sync-failure"
  mkdir -p "$case_root/runtime"
  create_copilot_seed "$case_root/seed"
  create_fake_copilot "$case_root/fake-bin"
  printf '{invalid json\n' >"$case_root/runtime/settings.json"
  if run_copilot_case "$case_root" new; then
    fail 'managed-state sync failure launched Copilot'
  fi
  [[ ! -e "$case_root/output/argv" ]] \
    || fail 'Copilot ran after managed-state sync failed'

  case_root="$test_root/copilot-parent-symlink"
  mkdir -p "$case_root/runtime/unrelated-parent"
  create_copilot_seed "$case_root/seed"
  create_fake_copilot "$case_root/fake-bin"
  ln -s /home/agent/.copilot/unrelated-parent \
    "$case_root/runtime/installed-plugins"
  if run_copilot_case "$case_root" new; then
    fail 'managed plugin parent symlink was accepted'
  fi
  [[ ! -e "$case_root/runtime/unrelated-parent/hve-core" ]] \
    || fail 'managed sync traversed a plugin parent symlink before rejecting it'
  [[ ! -e "$case_root/output/argv" ]] \
    || fail 'Copilot ran after plugin parent validation failed'

  case_root="$test_root/copilot-seed-installed-ancestor-symlink"
  mkdir -p "$case_root/runtime"
  create_copilot_seed "$case_root/seed"
  create_fake_copilot "$case_root/fake-bin"
  mv "$case_root/seed/installed-plugins" "$case_root/seed/installed-plugins-real"
  ln -s installed-plugins-real "$case_root/seed/installed-plugins"
  if run_copilot_case "$case_root" new; then
    fail 'baked installed-plugins ancestor symlink was accepted'
  fi
  [[ ! -e "$case_root/output/argv" ]] \
    || fail 'Copilot ran with a baked installed-plugins ancestor symlink'

  case_root="$test_root/copilot-seed-marketplace-ancestor-symlink"
  mkdir -p "$case_root/runtime"
  create_copilot_seed "$case_root/seed"
  create_fake_copilot "$case_root/fake-bin"
  mv "$case_root/seed/installed-plugins/hve-core" \
    "$case_root/seed/installed-plugins/hve-core-real"
  ln -s hve-core-real "$case_root/seed/installed-plugins/hve-core"
  if run_copilot_case "$case_root" new; then
    fail 'baked marketplace ancestor symlink was accepted'
  fi
  [[ ! -e "$case_root/output/argv" ]] \
    || fail 'Copilot ran with a baked marketplace ancestor symlink'
}

initialize_runtime_test() {
  test_root="$(mktemp -d "${TMPDIR:-/tmp}/trellage-codex-runtime-test.XXXXXX")"
  test_root="$(cd "$test_root" && pwd -P)"
  suffix="$(date +%s)-$$-${RANDOM}"
  volume_name="trellage-codex-runtime-test-$suffix"
  container_name="trellage-codex-runtime-test-$suffix"
  printf '%s\n' "$test_root" >"$test_root/.runtime-test-owner"
}

validate_container_ownership() {
  local actual expected
  [[ -n "$container_id" ]] || return 1
  actual="$(docker container inspect --format \
    '{{ printf "%s\t%s\t%s" .Id (index .Config.Labels "dev.trellage.prototype") (index .Config.Labels "dev.trellage.worktree") }}' \
    "$container_id" 2>/dev/null)" || return 1
  expected="$container_id"$'\ttrellage-codex\t'"$test_root"
  [[ "$actual" == "$expected" ]]
}

validate_volume_ownership() {
  local actual expected
  actual="$(docker volume inspect --format \
    '{{ printf "%s\t%s" (index .Labels "dev.trellage.prototype") (index .Labels "dev.trellage.worktree") }}' \
    "$volume_name" 2>/dev/null)" || return 1
  expected=$'trellage-codex\t'"$test_root"
  [[ "$actual" == "$expected" ]]
}

remove_runtime_container() {
  [[ -n "$container_id" ]] || return 1
  validate_container_ownership || return 1
  docker container rm --force "$container_id" >/dev/null || return 1
  container_id=
}

remove_runtime_volume() {
  [[ "$volume_created" -eq 1 ]] || return 1
  validate_volume_ownership || return 1
  docker volume rm "$volume_name" >/dev/null || return 1
  volume_created=0
}

cleanup() {
  local original_status=$?
  local cleanup_status=0
  trap - EXIT
  [[ "$container_name" == trellage-codex-runtime-test-* ]] || return 1
  [[ "$volume_name" == trellage-codex-runtime-test-* ]] || return 1

  if [[ -n "$container_id" ]]; then
    if ! remove_runtime_container; then
      printf 'Trellage runtime startup test: refusing container cleanup without preserved ownership: %s\n' \
        "$container_id" >&2
      cleanup_status=1
    fi
  fi

  if [[ "$volume_created" -eq 1 ]]; then
    if ! remove_runtime_volume; then
      printf 'Trellage runtime startup test: refusing volume cleanup without preserved ownership: %s\n' \
        "$volume_name" >&2
      cleanup_status=1
    fi
  fi

  if [[ -d "$test_root" ]]; then
    if [[ "$(basename "$test_root")" == trellage-codex-runtime-test.* ]] \
      && [[ -f "$test_root/.runtime-test-owner" ]] \
      && [[ "$(cat "$test_root/.runtime-test-owner")" == "$test_root" ]]; then
      rm -rf -- "$test_root" || cleanup_status=1
    else
      printf 'Trellage runtime startup test: refusing unowned directory cleanup: %s\n' \
        "$test_root" >&2
      cleanup_status=1
    fi
  fi

  if [[ "$original_status" -ne 0 ]]; then
    return "$original_status"
  fi
  return "$cleanup_status"
}

run_with_watchdog() {
  local timeout_seconds="$1"
  shift
  local command_pid elapsed=0 termination_step=0

  "$@" &
  command_pid=$!
  while kill -0 "$command_pid" 2>/dev/null; do
    if [[ "$elapsed" -ge "$timeout_seconds" ]]; then
      kill -TERM "$command_pid" 2>/dev/null || true
      while kill -0 "$command_pid" 2>/dev/null \
        && [[ "$termination_step" -lt 10 ]]; do
        sleep 0.1
        termination_step=$((termination_step + 1))
      done
      if kill -0 "$command_pid" 2>/dev/null; then
        kill -KILL "$command_pid" 2>/dev/null || true
      fi
      wait "$command_pid" 2>/dev/null || true
      return 124
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  wait "$command_pid"
}

create_runtime_volume() {
  local created_volume
  created_volume="$(docker volume create \
    --label "$prototype_label=trellage-codex" \
    --label "$worktree_label=$test_root" \
    "$volume_name")" \
    || fail 'Docker failed to create the runtime volume'
  [[ "$created_volume" == "$volume_name" ]] \
    || fail "Docker created an unexpected runtime volume: $created_volume"
  volume_created=1
  validate_volume_ownership \
    || fail "runtime volume ownership labels are invalid: $volume_name"
}

create_runtime_container() {
  local runtime_probe="$1"
  local created_container
  [[ -z "$container_id" ]] \
    || fail "refusing to replace a preserved runtime container ID: $container_id"
  created_container="$(docker container create \
    --name "$container_name" \
    --label "$prototype_label=trellage-codex" \
    --label "$worktree_label=$test_root" \
    --tty \
    --network none \
    --read-only \
    --cap-drop ALL \
    --security-opt no-new-privileges \
    --pids-limit 256 \
    --memory 2g \
    --cpus 2 \
    --tmpfs /tmp:rw,noexec,nosuid,nodev,size=256m,uid=10001,gid=10001 \
    --mount "type=volume,src=$volume_name,dst=/home/agent" \
    --user 10001:10001 \
    --workdir /workspace \
    --entrypoint fish \
    "$image_ref" -Nlc '
      if command -q trellage-codex-entry
        exec trellage-codex-entry bash -c $argv[1]
      end
      exec bash -c $argv[1]
    ' -- "$runtime_probe")" \
    || fail 'Docker failed to create the runtime startup container'
  [[ -n "$created_container" ]] \
    || fail 'Docker returned an empty runtime startup container ID'
  container_id="$created_container"
  validate_container_ownership \
    || fail "runtime container ownership labels are invalid: $container_name"
}

run_runtime_probe() {
  local runtime_probe startup_log startup_status=0
  runtime_probe="$(cat <<'PROBE'
set -euo pipefail
test "$(codex --version 2>/dev/null)" = "codex-cli 0.144.6"
test -w "$CODEX_HOME"
printf writable >"$CODEX_HOME/runtime-startup-smoke"
test "$(cat "$CODEX_HOME/runtime-startup-smoke")" = writable
grep -Fqx 'model_provider = "copilot_proxy"' "$CODEX_HOME/config.toml"
grep -Fqx 'base_url = "http://copilot-proxy-rs:8080/v1"' "$CODEX_HOME/config.toml"
test -f "$CODEX_HOME/skills/using-superpowers/SKILL.md"
test -f "$CODEX_HOME/skills/full-stack-orchestration__full-stack-feature/SKILL.md"
test -f "$CODEX_HOME/agents/full-stack-orchestration__security-auditor.toml"
PROBE
)"

  create_runtime_container "$runtime_probe"
  startup_log="$test_root/startup.log"
  run_with_watchdog "$watchdog_seconds" \
    docker container start --attach "$container_id" >"$startup_log" 2>&1 \
    || startup_status=$?
  cat "$startup_log"
  if [[ "$startup_status" -eq 124 ]]; then
    fail "runtime startup probe timed out after ${watchdog_seconds}s"
  fi
  [[ "$startup_status" -eq 0 ]] \
    || fail "runtime startup probe exited $startup_status"
  validate_container_ownership \
    || fail "runtime container identity changed after execution: $container_id"
}

main() {
  [[ "$watchdog_seconds" =~ ^[1-9][0-9]*$ ]] \
    || fail "runtime watchdog must be a positive integer: $watchdog_seconds"
  [[ -f "$copilot_runtime_entry" ]] \
    || fail "missing Copilot runtime entrypoint: $copilot_runtime_entry"
  command -v docker >/dev/null 2>&1 || fail 'docker is required'
  docker image inspect "$image_ref" >/dev/null 2>&1 \
    || fail "missing real runtime image: $image_ref"
  initialize_runtime_test
  trap cleanup EXIT
  run_copilot_startup_contract
  create_runtime_volume
  run_runtime_probe
  printf 'Trellage runtime startup test: PASS\n'
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
