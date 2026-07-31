#!/usr/bin/env bash
if [[ "${BASH_SOURCE[0]}" != "$0" ]]; then
  return 0
fi
set -euo pipefail

image_ref="${IMAGE_REF:-trellage-codex:test}"
watchdog_seconds="${RUNTIME_WATCHDOG_SECONDS:-60}"
prototype_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
codex_runtime_entry="$prototype_dir/runtime-entry.sh"
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
  printf 'Trellage persistence test: FAIL: %s\n' "$1" >&2
  exit 1
}

sha256_path() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
    return
  fi
  shasum -a 256 "$1" | awk '{print $1}'
}

mode_path() {
  if stat -f '%Lp' "$1" >/dev/null 2>&1; then
    stat -f '%Lp' "$1"
    return
  fi
  stat -c '%a' "$1"
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
  mkdir -p "$fake_bin"
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'set -euo pipefail' \
    'printf "%s\n" "$#" >"$TRELLAGE_TEST_OUTPUT/argc"' \
    ': >"$TRELLAGE_TEST_OUTPUT/argv"' \
    'for argument in "$@"; do' \
    '  printf "%s\0" "$argument" >>"$TRELLAGE_TEST_OUTPUT/argv"' \
    'done' \
    'printf "launched\n" >>"$TRELLAGE_TEST_OUTPUT/launches"' \
    'if [[ "${COPILOT_GITHUB_TOKEN+x}" == x ]]; then' \
    '  printf "present\n" >"$TRELLAGE_TEST_OUTPUT/token-presence"' \
    'else' \
    '  printf "absent\n" >"$TRELLAGE_TEST_OUTPUT/token-presence"' \
    'fi' >"$fake_bin/copilot"
  chmod 755 "$fake_bin/copilot"
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'set -euo pipefail' \
    'arguments=("$@")' \
    'count=${#arguments[@]}' \
    'source_path=${arguments[$((count - 2))]}' \
    'destination_path=${arguments[$((count - 1))]}' \
    'mode=${TRELLAGE_TEST_MV_MODE:-}' \
    'trigger=$TRELLAGE_TEST_OUTPUT/mv-triggered' \
    'case "$destination_path" in' \
    '  */.hve-core.trellage-backup*)' \
    '    if [[ "$mode" == terminate_after_backup && ! -e "$trigger" ]]; then' \
    '      /usr/bin/mv "$@"' \
    '      : >"$trigger"' \
    '      kill -TERM "$PPID"' \
    '      sleep 2' \
    '      exit 143' \
    '    fi' \
    '    ;;' \
    'esac' \
    'case "$source_path:$destination_path" in' \
    '  */.hve-core.trellage-stage*:*/hve-core)' \
    '    case "$mode" in' \
    '      pause_publish)' \
    '        : >"$TRELLAGE_TEST_OUTPUT/mv-paused"' \
    '        sleep 2' \
    '        ;;' \
    '      fail_publish) exit 97 ;;' \
    '      terminate_after_publish)' \
    '        if [[ ! -e "$trigger" ]]; then' \
    '          /usr/bin/mv "$@"' \
    '          : >"$trigger"' \
    '          kill -TERM "$PPID"' \
    '          sleep 2' \
    '          exit 143' \
    '        fi' \
    '        ;;' \
    '    esac' \
    '    ;;' \
    'esac' \
    'exec /usr/bin/mv "$@"' >"$fake_bin/mv"
  chmod 755 "$fake_bin/mv"
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'set -euo pipefail' \
    'candidate=${!#}' \
    'case "${TRELLAGE_TEST_FAULT_MODE:-}:$candidate" in' \
    '  replace_marketplace_parent:*/.hve-core.trellage-stage)' \
    '    identity=$(/usr/bin/stat "$@")' \
    '    marketplace=/home/agent/.copilot/installed-plugins/hve-core' \
    '    /usr/bin/mv -T "$marketplace" "${marketplace}-replaced"' \
    '    /usr/bin/mkdir "$marketplace"' \
    '    printf "%s\n" "$identity"' \
    '    ;;' \
    '  *) exec /usr/bin/stat "$@" ;;' \
    'esac' >"$fake_bin/stat"
  chmod 755 "$fake_bin/stat"
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'set -euo pipefail' \
    'mode=${TRELLAGE_TEST_FAULT_MODE:-}' \
    'case "$mode" in' \
    '  fail_exchange) exit 97 ;;' \
    '  pause_exchange)' \
    '    : >"$TRELLAGE_TEST_OUTPUT/exchange-paused"' \
    '    sleep 2' \
    '    ;;' \
    'esac' \
    '/usr/bin/python3 "$@"' \
    'case "$mode" in' \
    '  terminate_after_exchange)' \
    '    : >"$TRELLAGE_TEST_OUTPUT/exchange-triggered"' \
    '    kill -TERM "$PPID"' \
    '    sleep 2' \
    '    exit 143' \
    '    ;;' \
    '  kill_after_exchange)' \
    '    : >"$TRELLAGE_TEST_OUTPUT/exchange-triggered"' \
    '    kill -KILL "$PPID"' \
    '    sleep 2' \
    '    exit 137' \
    '    ;;' \
    'esac' >"$fake_bin/python3"
  chmod 755 "$fake_bin/python3"
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'set -euo pipefail' \
    'mode=${TRELLAGE_TEST_FAULT_MODE:-}' \
    'candidate=${!#}' \
    '/usr/bin/chmod "$@"' \
    'case "$mode:$candidate" in' \
    '  terminate_settings_temp:*/.settings.json.trellage.??????)' \
    '    : >"$TRELLAGE_TEST_OUTPUT/temp-triggered"' \
    '    kill -TERM "$PPID"' \
    '    sleep 2' \
    '    exit 143' \
    '    ;;' \
    '  kill_settings_temp:*/.settings.json.trellage.??????)' \
    '    : >"$TRELLAGE_TEST_OUTPUT/temp-triggered"' \
    '    kill -KILL "$PPID"' \
    '    sleep 2' \
    '    exit 137' \
    '    ;;' \
    '  fail_control_temp:*/.managed-lock.json.trellage.??????)' \
    '    : >"$TRELLAGE_TEST_OUTPUT/temp-triggered"' \
    '    exit 97' \
    '    ;;' \
    'esac' >"$fake_bin/chmod"
  chmod 755 "$fake_bin/chmod"
}

run_copilot_sync() {
  local fixture="$1"
  local output_dir="${TRELLAGE_TEST_OUTPUT_DIR:-$fixture/output}"
  local log_file="${TRELLAGE_TEST_LOG:-$fixture/runtime.log}"
  local fault_env=()
  if [[ -n "${TRELLAGE_TEST_MV_MODE:-}" ]]; then
    fault_env+=(--env "TRELLAGE_TEST_MV_MODE=$TRELLAGE_TEST_MV_MODE")
  fi
  if [[ -n "${TRELLAGE_TEST_FAULT_MODE:-}" ]]; then
    fault_env+=(--env "TRELLAGE_TEST_FAULT_MODE=$TRELLAGE_TEST_FAULT_MODE")
  fi
  docker run --rm \
    --network none \
    --read-only \
    --entrypoint /bin/bash \
    --mount "type=bind,src=$copilot_runtime_entry,dst=/test/runtime-copilot-entry.sh,readonly" \
    --mount "type=bind,src=$fixture/seed,dst=/usr/local/share/trellage/copilot-seed,readonly" \
    --mount "type=bind,src=$fixture/runtime,dst=/home/agent/.copilot" \
    --mount "type=bind,src=$fixture/fake-bin,dst=/test-bin,readonly" \
    --mount "type=bind,src=$output_dir,dst=/test-output" \
    --env 'PATH=/test-bin:/usr/local/bin:/usr/bin:/bin' \
    --env 'TRELLAGE_TEST_OUTPUT=/test-output' \
    --env 'HARNESS_COPILOT_SEED_HOME=/legacy-seed-must-not-be-used' \
    --env 'HARNESS_COPILOT_HOME=/legacy-home-must-not-be-used' \
    --env 'HARNESS_FLOCK=/legacy-flock-must-not-be-used' \
    --env 'HARNESS_TEST_OUTPUT=/legacy-test-output-must-not-be-used' \
    --env 'COPILOT_GITHUB_TOKEN=persistence-contract-secret' \
    ${fault_env[@]+"${fault_env[@]}"} \
    "$image_ref" /test/runtime-copilot-entry.sh new \
    >"$log_file" 2>&1
}

wait_for_container_symlink() {
  local fixture="$1"
  local relative="$2"
  local attempt
  for attempt in 1 2 3 4 5 6 7 8 9 10; do
    if docker run --rm \
      --entrypoint /bin/bash \
      --mount "type=bind,src=$fixture/runtime,dst=/home/agent/.copilot" \
      "$image_ref" -c "[[ -L /home/agent/.copilot/$relative ]]"; then
      return
    fi
    sleep 0.1
  done
  fail "Docker bind mount did not expose test symlink: $relative"
}

install_control_symlink() {
  local fixture="$1"
  local control_file="$2"
  local control_target="$3"
  docker run --rm \
    --entrypoint /bin/bash \
    --mount "type=bind,src=$fixture/runtime,dst=/home/agent/.copilot" \
    "$image_ref" -ceu '
      unlink "/home/agent/.copilot/$1"
      ln -s "/home/agent/.copilot/$2" "/home/agent/.copilot/$1"
    ' -- "$control_file" "$(basename "$control_target")"
}

restore_control_file() {
  local fixture="$1"
  local control_file="$2"
  docker run --rm \
    --entrypoint /bin/bash \
    --mount "type=bind,src=$fixture/runtime,dst=/home/agent/.copilot" \
    --mount "type=bind,src=$fixture/seed,dst=/seed,readonly" \
    "$image_ref" -ceu '
      unlink "/home/agent/.copilot/$1"
      cp "/seed/$1" "/home/agent/.copilot/$1"
    ' -- "$control_file"
}

install_ancestor_symlink() {
  local fixture="$1"
  local relative="$2"
  local backup_relative="$3"
  docker run --rm \
    --entrypoint /bin/bash \
    --mount "type=bind,src=$fixture/runtime,dst=/home/agent/.copilot" \
    "$image_ref" -ceu '
      mv -T "/home/agent/.copilot/$1" "/home/agent/.copilot/$2"
      ln -s "/home/agent/.copilot/$2" "/home/agent/.copilot/$1"
    ' -- "$relative" "$backup_relative"
  wait_for_container_symlink "$fixture" "$relative"
}

restore_ancestor_directory() {
  local fixture="$1"
  local relative="$2"
  local backup_relative="$3"
  docker run --rm \
    --entrypoint /bin/bash \
    --mount "type=bind,src=$fixture/runtime,dst=/home/agent/.copilot" \
    "$image_ref" -ceu '
      unlink "/home/agent/.copilot/$1"
      mv -T "/home/agent/.copilot/$2" "/home/agent/.copilot/$1"
    ' -- "$relative" "$backup_relative"
}

restore_replaced_ancestor_directory() {
  local fixture="$1"
  local relative="$2"
  local backup_relative="$3"
  docker run --rm \
    --entrypoint /bin/bash \
    --mount "type=bind,src=$fixture/runtime,dst=/home/agent/.copilot" \
    "$image_ref" -ceu '
      rmdir "/home/agent/.copilot/$1"
      mv -T "/home/agent/.copilot/$2" "/home/agent/.copilot/$1"
    ' -- "$relative" "$backup_relative"
}

wait_for_path() {
  local candidate="$1"
  local attempt
  for attempt in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    [[ -e "$candidate" ]] && return
    sleep 0.1
  done
  fail "timed out waiting for test path: $candidate"
}

assert_no_reserved_runtime_temp() {
  local runtime="$1"
  if docker run --rm \
    --entrypoint /bin/bash \
    --mount "type=bind,src=$runtime,dst=/home/agent/.copilot" \
    "$image_ref" -ceu '
      find /home/agent/.copilot -mindepth 1 -maxdepth 1 \( \
        -name ".settings.json.trellage.??????" \
        -o -name ".managed-lock.json.trellage.??????" \
        -o -name ".managed-settings.json.trellage.??????" \
        -o -name ".managed-files.txt.trellage.??????" \
        -o -name ".managed.sha256.trellage.??????" \
      \) -print -quit | grep -q .
    '; then
    fail 'managed sync left a reserved settings or control temporary file'
  fi
}

run_plugin_reader() {
  local fixture="$1"
  docker run --rm \
    --entrypoint /bin/bash \
    --mount "type=bind,src=$fixture/runtime,dst=/home/agent/.copilot" \
    --mount "type=bind,src=$fixture/output-reader,dst=/test-output" \
    "$image_ref" -ceu '
      target=/home/agent/.copilot/installed-plugins/hve-core/hve-core
      : >/test-output/ready
      while [[ ! -e /test-output/stop ]]; do
        if [[ ! -e "$target" && ! -L "$target" ]]; then
          : >/test-output/missing
          exit 0
        fi
      done
    '
}

install_plugin_target_type() {
  local fixture="$1"
  local target_type="$2"
  docker run --rm \
    --entrypoint /bin/bash \
    --mount "type=bind,src=$fixture/runtime,dst=/home/agent/.copilot" \
    "$image_ref" -ceu '
      target=/home/agent/.copilot/installed-plugins/hve-core/hve-core
      rm -rf -- "$target"
      case "$1" in
        fifo) mkfifo "$target" ;;
        socket)
          /usr/bin/python3 - "$target" <<"PY"
import socket
import sys

sock = socket.socket(socket.AF_UNIX)
sock.bind(sys.argv[1])
sock.close()
PY
          ;;
        *) exit 64 ;;
      esac
    ' -- "$target_type"
}

assert_plugin_target_type() {
  local fixture="$1"
  local target_type="$2"
  docker run --rm \
    --entrypoint /bin/bash \
    --mount "type=bind,src=$fixture/runtime,dst=/home/agent/.copilot" \
    "$image_ref" -ceu '
      target=/home/agent/.copilot/installed-plugins/hve-core/hve-core
      case "$1" in
        fifo) [[ -p "$target" ]] ;;
        socket) [[ -S "$target" ]] ;;
        *) exit 64 ;;
      esac
    ' -- "$target_type" \
    || fail "managed sync mutated the rejected $target_type plugin target"
}

remove_plugin_target() {
  local fixture="$1"
  docker run --rm \
    --entrypoint /bin/bash \
    --mount "type=bind,src=$fixture/runtime,dst=/home/agent/.copilot" \
    "$image_ref" -ceu '
      target=/home/agent/.copilot/installed-plugins/hve-core/hve-core
      rm -f -- "$target"
      mkdir "$target"
      printf stale >"$target/type-recovery-fixture"
    '
}

wait_for_plugin_directory() {
  local fixture="$1"
  local attempt
  for attempt in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    if docker run --rm \
      --entrypoint /bin/bash \
      --mount "type=bind,src=$fixture/runtime,dst=/home/agent/.copilot" \
      "$image_ref" -ceu '
        target=/home/agent/.copilot/installed-plugins/hve-core/hve-core
        [[ -d "$target" && ! -L "$target" ]]
      '; then
      return
    fi
    sleep 0.1
  done
  fail 'Docker bind mount did not expose restored managed plugin directory'
}

expect_copilot_sync_failure() {
  local fixture="$1"
  local reason="$2"
  local output_dir="${TRELLAGE_TEST_OUTPUT_DIR:-$fixture/output}"
  local launches_before=0 launches_after=0
  if [[ -f "$output_dir/launches" ]]; then
    launches_before="$(wc -l <"$output_dir/launches")"
  fi
  if run_copilot_sync "$fixture"; then
    cat "$fixture/runtime.log" >&2
    fail "$reason was accepted"
  fi
  if [[ -f "$output_dir/launches" ]]; then
    launches_after="$(wc -l <"$output_dir/launches")"
  fi
  [[ "$launches_after" -eq "$launches_before" ]] \
    || fail "Copilot ran after $reason"
}

assert_copilot_persistence() {
  local fixture="$1"
  local seed="$fixture/seed"
  local runtime="$fixture/runtime"
  local control_file
  diff -r \
    "$seed/installed-plugins/hve-core/hve-core" \
    "$runtime/installed-plugins/hve-core/hve-core" >/dev/null \
    || fail 'runtime managed plugin tree does not exactly match the seed'
  for control_file in managed-lock.json managed-settings.json managed-files.txt managed.sha256; do
    cmp -s "$seed/$control_file" "$runtime/$control_file" \
      || fail "runtime control file does not match the seed: $control_file"
  done
  [[ "$(cat "$runtime/config.json")" == 'login-session-fixture' ]] \
    || fail 'Copilot login fixture did not survive managed sync'
  [[ "$(cat "$runtime/sessions/thread.json")" == 'session-history-fixture' ]] \
    || fail 'Copilot session fixture did not survive managed sync'
  [[ "$(cat "$runtime/unrelated.txt")" == 'unrelated-fixture' ]] \
    || fail 'unrelated Copilot state did not survive managed sync'
  [[ "$(cat "$runtime/installed-plugins/other-market/other-plugin/data.txt")" == 'other-plugin-fixture' ]] \
    || fail 'unrelated installed plugin did not survive managed sync'
  jq -e '
    .theme == "dark"
    and .nested.keep == true
    and .extraKnownMarketplaces.other.source.repo == "example/other"
    and .enabledPlugins["other@other"] == true
    and .extraKnownMarketplaces["hve-core"].source
      == {"source":"github","repo":"microsoft/hve-core"}
    and .enabledPlugins["hve-core@hve-core"] == true
  ' "$runtime/settings.json" >/dev/null \
    || fail 'runtime settings merge changed non-HVE keys or omitted managed HVE keys'
  [[ "$(cat "$fixture/output/token-presence")" == present ]] \
    || fail 'token presence was not forwarded to Copilot'
  if grep -Fq 'persistence-contract-secret' "$fixture/runtime.log"; then
    fail 'token value leaked in persistence runtime output'
  fi
  if find "$runtime/installed-plugins/hve-core" -mindepth 1 -maxdepth 1 \
    ! -name hve-core -print -quit | grep -q .; then
    fail 'managed sync left a staging or backup plugin sibling'
  fi
  assert_no_reserved_runtime_temp "$runtime"
}

run_copilot_persistence_contract() {
  local fixture="$test_root/copilot-persistence"
  local runtime="$fixture/runtime"
  local before_inode after_inode control_file control_target
  local first_repair_pid second_repair_pid first_repair_status second_repair_status
  local reader_pid
  mkdir -p "$runtime" "$fixture/output"
  create_copilot_seed "$fixture/seed"
  create_fake_copilot "$fixture/fake-bin"

  run_copilot_sync "$fixture"
  mkdir -p "$runtime/sessions" \
    "$runtime/installed-plugins/other-market/other-plugin"
  printf 'login-session-fixture\n' >"$runtime/config.json"
  printf 'session-history-fixture\n' >"$runtime/sessions/thread.json"
  printf 'unrelated-fixture\n' >"$runtime/unrelated.txt"
  printf 'other-plugin-fixture\n' \
    >"$runtime/installed-plugins/other-market/other-plugin/data.txt"
  printf '%s\n' \
    '{' \
    '  "theme": "dark",' \
    '  "nested": { "keep": true },' \
    '  "extraKnownMarketplaces": {' \
    '    "other": { "source": { "source": "github", "repo": "example/other" } },' \
    '    "hve-core": { "source": { "source": "github", "repo": "microsoft/hve-core" } }' \
    '  },' \
    '  "enabledPlugins": {' \
    '    "other@other": true,' \
    '    "hve-core@hve-core": true' \
    '  }' \
    '}' >"$runtime/settings.json"

  run_copilot_sync "$fixture"
  assert_copilot_persistence "$fixture"

  printf 'atomic exchange reader fixture\n' \
    >"$runtime/installed-plugins/hve-core/hve-core/commands/review.md"
  mkdir "$fixture/output-reader"
  run_plugin_reader "$fixture" &
  reader_pid=$!
  wait_for_path "$fixture/output-reader/ready"
  TRELLAGE_TEST_MV_MODE=pause_publish run_copilot_sync "$fixture"
  : >"$fixture/output-reader/stop"
  wait "$reader_pid"
  [[ ! -e "$fixture/output-reader/missing" ]] \
    || fail 'an already-running reader observed a missing managed plugin target'
  assert_copilot_persistence "$fixture"

  printf 'sensitive settings leftover\n' \
    >"$runtime/.settings.json.trellage.ABC123"
  printf 'control leftover\n' \
    >"$runtime/.managed-lock.json.trellage.DEF456"
  printf 'control leftover\n' \
    >"$runtime/.managed-settings.json.trellage.GHI789"
  printf 'control leftover\n' \
    >"$runtime/.managed-files.txt.trellage.JKL012"
  printf 'control leftover\n' \
    >"$runtime/.managed.sha256.trellage.MNO345"
  printf 'unrelated lookalike\n' \
    >"$runtime/.settings.json.trellage.ABC12"
  run_copilot_sync "$fixture"
  assert_no_reserved_runtime_temp "$runtime"
  [[ -f "$runtime/.settings.json.trellage.ABC12" ]] \
    || fail 'managed temp recovery removed an unreserved lookalike'
  rm "$runtime/.settings.json.trellage.ABC12"

  printf 'TERM settings temp fixture\n' >"$runtime/managed-lock.json"
  mkdir "$fixture/output-terminate-settings"
  TRELLAGE_TEST_OUTPUT_DIR="$fixture/output-terminate-settings" \
    TRELLAGE_TEST_FAULT_MODE=terminate_settings_temp \
    expect_copilot_sync_failure "$fixture" 'termination during settings staging'
  assert_no_reserved_runtime_temp "$runtime"
  run_copilot_sync "$fixture"
  assert_copilot_persistence "$fixture"

  printf 'SIGKILL settings temp fixture\n' >"$runtime/managed-lock.json"
  mkdir "$fixture/output-kill-settings"
  TRELLAGE_TEST_OUTPUT_DIR="$fixture/output-kill-settings" \
    TRELLAGE_TEST_FAULT_MODE=kill_settings_temp \
    expect_copilot_sync_failure "$fixture" 'SIGKILL during settings staging'
  [[ -e "$fixture/output-kill-settings/temp-triggered" ]] \
    || fail 'SIGKILL settings fault did not reach the staged temporary file'
  run_copilot_sync "$fixture"
  assert_copilot_persistence "$fixture"

  printf 'unexpected control temp failure fixture\n' >"$runtime/managed-lock.json"
  mkdir "$fixture/output-fail-control"
  TRELLAGE_TEST_OUTPUT_DIR="$fixture/output-fail-control" \
    TRELLAGE_TEST_FAULT_MODE=fail_control_temp \
    expect_copilot_sync_failure "$fixture" 'unexpected control staging failure'
  assert_no_reserved_runtime_temp "$runtime"
  run_copilot_sync "$fixture"
  assert_copilot_persistence "$fixture"

  before_inode="$(ls -di "$runtime/installed-plugins/hve-core/hve-core" | awk '{print $1}')"
  printf 'changed marker\n' >"$runtime/managed-lock.json"
  run_copilot_sync "$fixture"
  after_inode="$(ls -di "$runtime/installed-plugins/hve-core/hve-core" | awk '{print $1}')"
  [[ "$after_inode" != "$before_inode" ]] \
    || fail 'changed marker did not replace the managed plugin path'
  assert_copilot_persistence "$fixture"

  rm "$runtime/installed-plugins/hve-core/hve-core/commands/review.md"
  run_copilot_sync "$fixture"
  assert_copilot_persistence "$fixture"

  printf 'changed hash\n' \
    >"$runtime/installed-plugins/hve-core/hve-core/commands/review.md"
  run_copilot_sync "$fixture"
  assert_copilot_persistence "$fixture"

  printf 'extra managed file\n' \
    >"$runtime/installed-plugins/hve-core/hve-core/commands/extra.md"
  run_copilot_sync "$fixture"
  assert_copilot_persistence "$fixture"

  rm "$runtime/installed-plugins/hve-core/hve-core/commands/review.md"
  ln -s /home/agent/.copilot/unrelated.txt \
    "$runtime/installed-plugins/hve-core/hve-core/commands/review.md"
  run_copilot_sync "$fixture"
  assert_copilot_persistence "$fixture"

  chmod 640 "$runtime/settings.json"
  printf 'changed marker for settings mode repair\n' >"$runtime/managed-lock.json"
  run_copilot_sync "$fixture"
  [[ "$(mode_path "$runtime/settings.json")" == 640 ]] \
    || fail 'forced settings repair did not preserve settings.json mode'
  assert_copilot_persistence "$fixture"

  for control_file in managed-lock.json managed-settings.json managed-files.txt managed.sha256; do
    control_target="$runtime/control-target-${control_file//./-}"
    mkdir "$control_target"
    install_control_symlink "$fixture" "$control_file" "$control_target"
    wait_for_container_symlink "$fixture" "$control_file"
    expect_copilot_sync_failure "$fixture" \
      "directory symlink at managed control destination $control_file"
    wait_for_container_symlink "$fixture" "$control_file"
    [[ -z "$(find "$control_target" -mindepth 1 -print -quit)" ]] \
      || fail "managed control publish traversed a directory symlink: $control_file"
    restore_control_file "$fixture" "$control_file"
    rmdir "$control_target"
    if ! run_copilot_sync "$fixture"; then
      cat "$fixture/runtime.log" >&2
      fail "managed sync did not recover after restoring $control_file"
    fi
    assert_copilot_persistence "$fixture"
  done

  install_ancestor_symlink "$fixture" installed-plugins installed-plugins-real
  expect_copilot_sync_failure "$fixture" 'installed-plugins ancestor symlink'
  restore_ancestor_directory "$fixture" installed-plugins installed-plugins-real
  run_copilot_sync "$fixture"
  assert_copilot_persistence "$fixture"

  install_ancestor_symlink "$fixture" \
    installed-plugins/hve-core installed-plugins/hve-core-real
  expect_copilot_sync_failure "$fixture" 'marketplace ancestor symlink'
  restore_ancestor_directory "$fixture" \
    installed-plugins/hve-core installed-plugins/hve-core-real
  run_copilot_sync "$fixture"
  assert_copilot_persistence "$fixture"

  printf 'ancestor replacement fixture\n' \
    >"$runtime/installed-plugins/hve-core/hve-core/commands/review.md"
  TRELLAGE_TEST_FAULT_MODE=replace_marketplace_parent \
    expect_copilot_sync_failure "$fixture" \
      'marketplace ancestor inode replacement during staging'
  grep -Fq 'managed plugin parents changed while staging the plugin' \
    "$fixture/runtime.log" \
    || fail 'ancestor inode replacement did not reach the parent identity guard'
  [[ -d "$runtime/installed-plugins/hve-core" \
    && -d "$runtime/installed-plugins/hve-core-replaced" ]] \
    || fail 'ancestor replacement fault did not preserve both directory identities'
  restore_replaced_ancestor_directory "$fixture" \
    installed-plugins/hve-core installed-plugins/hve-core-replaced
  run_copilot_sync "$fixture"
  assert_copilot_persistence "$fixture"

  docker run --rm \
    --entrypoint /bin/bash \
    --mount "type=bind,src=$runtime,dst=/home/agent/.copilot" \
    "$image_ref" -ceu '
      marketplace=/home/agent/.copilot/installed-plugins/hve-core
      cp -R "$marketplace/hve-core" "$marketplace/.hve-core.trellage-backup"
      cp -R "$marketplace/hve-core" "$marketplace/.hve-core.trellage-stage"
    '
  run_copilot_sync "$fixture"
  assert_copilot_persistence "$fixture"

  printf 'concurrent repair fixture\n' \
    >"$runtime/installed-plugins/hve-core/hve-core/commands/review.md"
  mkdir "$fixture/output-concurrent-a" "$fixture/output-concurrent-b"
  TRELLAGE_TEST_OUTPUT_DIR="$fixture/output-concurrent-a" \
    TRELLAGE_TEST_LOG="$fixture/concurrent-a.log" \
    TRELLAGE_TEST_FAULT_MODE=pause_exchange \
    run_copilot_sync "$fixture" &
  first_repair_pid=$!
  wait_for_path "$fixture/output-concurrent-a/exchange-paused"
  TRELLAGE_TEST_OUTPUT_DIR="$fixture/output-concurrent-b" \
    TRELLAGE_TEST_LOG="$fixture/concurrent-b.log" \
    TRELLAGE_TEST_FAULT_MODE=pause_exchange \
    run_copilot_sync "$fixture" &
  second_repair_pid=$!
  set +e
  wait "$first_repair_pid"
  first_repair_status=$?
  wait "$second_repair_pid"
  second_repair_status=$?
  set -e
  [[ "$first_repair_status" -eq 0 && "$second_repair_status" -eq 0 ]] \
    || fail "concurrent managed repairs were not serialized: $first_repair_status/$second_repair_status"
  assert_copilot_persistence "$fixture"

  printf 'failed exchange fixture\n' \
    >"$runtime/installed-plugins/hve-core/hve-core/commands/review.md"
  TRELLAGE_TEST_FAULT_MODE=fail_exchange \
    expect_copilot_sync_failure "$fixture" 'managed plugin exchange failure'
  run_copilot_sync "$fixture"
  assert_copilot_persistence "$fixture"

  printf 'terminated exchange fixture\n' \
    >"$runtime/installed-plugins/hve-core/hve-core/commands/review.md"
  mkdir "$fixture/output-terminate-exchange"
  TRELLAGE_TEST_OUTPUT_DIR="$fixture/output-terminate-exchange" \
    TRELLAGE_TEST_FAULT_MODE=terminate_after_exchange \
    expect_copilot_sync_failure "$fixture" 'termination after plugin exchange'
  run_copilot_sync "$fixture"
  assert_copilot_persistence "$fixture"

  printf 'SIGKILL exchange fixture\n' \
    >"$runtime/installed-plugins/hve-core/hve-core/commands/review.md"
  mkdir "$fixture/output-kill-exchange"
  TRELLAGE_TEST_OUTPUT_DIR="$fixture/output-kill-exchange" \
    TRELLAGE_TEST_FAULT_MODE=kill_after_exchange \
    expect_copilot_sync_failure "$fixture" 'SIGKILL after plugin exchange'
  [[ -e "$fixture/output-kill-exchange/exchange-triggered" ]] \
    || fail 'SIGKILL exchange fault did not reach the completed atomic exchange'
  [[ -e "$runtime/installed-plugins/hve-core/hve-core" \
    || -L "$runtime/installed-plugins/hve-core/hve-core" ]] \
    || fail 'SIGKILL after exchange left the managed plugin target missing'
  run_copilot_sync "$fixture"
  assert_copilot_persistence "$fixture"

  install_plugin_target_type "$fixture" fifo
  expect_copilot_sync_failure "$fixture" \
    'unsupported managed plugin fifo target'
  assert_plugin_target_type "$fixture" fifo
  if find "$runtime/installed-plugins/hve-core" -mindepth 1 -maxdepth 1 \
    \( -name '.hve-core.trellage-stage' -o -name '.hve-core.trellage-backup' \) \
    -print -quit | grep -q .; then
    fail 'unsupported fifo target left a reserved plugin transaction path'
  fi
  remove_plugin_target "$fixture"
  wait_for_plugin_directory "$fixture"
  if ! run_copilot_sync "$fixture"; then
    cat "$fixture/runtime.log" >&2
    fail 'managed sync did not recover after removing an unsupported fifo target'
  fi
  assert_copilot_persistence "$fixture"

  install_plugin_target_type "$fixture" socket
  expect_copilot_sync_failure "$fixture" \
    'unsupported managed plugin socket target'
  assert_plugin_target_type "$fixture" socket
  if find "$runtime/installed-plugins/hve-core" -mindepth 1 -maxdepth 1 \
    \( -name '.hve-core.trellage-stage' -o -name '.hve-core.trellage-backup' \) \
    -print -quit | grep -q .; then
    fail 'unsupported socket target left a reserved plugin transaction path'
  fi
}

initialize_persistence_test() {
  test_root="$(mktemp -d "${TMPDIR:-/tmp}/trellage-codex-persistence-test.XXXXXX")"
  test_root="$(cd "$test_root" && pwd -P)"
  suffix="$(date +%s)-$$-${RANDOM}"
  volume_name="trellage-codex-persistence-test-$suffix"
  container_name="trellage-codex-persistence-test-$suffix"
  printf '%s\n' "$test_root" >"$test_root/.persistence-test-owner"
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

remove_owned_container() {
  [[ -n "$container_id" ]] || return 1
  validate_container_ownership || return 1
  docker container rm --force "$container_id" >/dev/null || return 1
  container_id=
}

remove_owned_volume() {
  [[ "$volume_created" -eq 1 ]] || return 1
  validate_volume_ownership || return 1
  docker volume rm "$volume_name" >/dev/null || return 1
  volume_created=0
}

cleanup() {
  local original_status=$?
  local cleanup_status=0
  trap - EXIT
  [[ "$container_name" == trellage-codex-persistence-test-* ]] || return 1
  [[ "$volume_name" == trellage-codex-persistence-test-* ]] || return 1

  if [[ -n "$container_id" ]]; then
    if ! remove_owned_container; then
      printf 'Trellage persistence test: refusing container cleanup without preserved ownership: %s\n' \
        "$container_id" >&2
      cleanup_status=1
    fi
  fi

  if [[ "$volume_created" -eq 1 ]]; then
    if ! remove_owned_volume; then
      printf 'Trellage persistence test: refusing volume cleanup without preserved ownership: %s\n' \
        "$volume_name" >&2
      cleanup_status=1
    fi
  fi

  if [[ -d "$test_root" ]]; then
    if [[ "$(basename "$test_root")" == trellage-codex-persistence-test.* ]] \
      && [[ -f "$test_root/.persistence-test-owner" ]] \
      && [[ "$(cat "$test_root/.persistence-test-owner")" == "$test_root" ]]; then
      rm -rf -- "$test_root" || cleanup_status=1
    else
      printf 'Trellage persistence test: refusing unowned directory cleanup: %s\n' \
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

create_persistence_volume() {
  local created_volume
  created_volume="$(docker volume create \
    --label "$prototype_label=trellage-codex" \
    --label "$worktree_label=$test_root" \
    "$volume_name")" \
    || fail 'Docker failed to create the persistence volume'
  [[ "$created_volume" == "$volume_name" ]] \
    || fail "Docker created an unexpected persistence volume: $created_volume"
  volume_created=1
  validate_volume_ownership \
    || fail "persistence volume ownership labels are invalid: $volume_name"
}

run_persistence_container() {
  local probe="$1"
  local created_container run_status=0
  [[ -z "$container_id" ]] \
    || fail "refusing to replace a preserved persistence container ID: $container_id"
  created_container="$(docker container create \
    --name "$container_name" \
    --label "$prototype_label=trellage-codex" \
    --label "$worktree_label=$test_root" \
    --read-only \
    --network none \
    --user 10001:10001 \
    --tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m,uid=10001,gid=10001 \
    --mount "type=volume,src=$volume_name,dst=/home/agent" \
    --mount "type=bind,src=$codex_runtime_entry,dst=/usr/local/bin/trellage-codex-entry,readonly" \
    --entrypoint trellage-codex-entry \
    "$image_ref" passthrough bash -ceu "$probe")" \
    || fail 'Docker failed to create the persistence container'
  [[ -n "$created_container" ]] \
    || fail 'Docker returned an empty persistence container ID'
  container_id="$created_container"
  validate_container_ownership \
    || fail "persistence container ownership labels are invalid: $container_name"
  run_with_watchdog "$watchdog_seconds" \
    docker container start --attach "$container_id" >/dev/null \
    || run_status=$?
  if [[ "$run_status" -eq 124 ]]; then
    fail "persistence container timed out after ${watchdog_seconds}s: $container_id"
  fi
  [[ "$run_status" -eq 0 ]] \
    || fail "persistence container exited $run_status: $container_id"
  validate_container_ownership \
    || fail "persistence container identity changed after execution: $container_id"
}

main() {
  local first_probe second_probe
  [[ "$watchdog_seconds" =~ ^[1-9][0-9]*$ ]] \
    || fail "runtime watchdog must be a positive integer: $watchdog_seconds"
  first_probe="$(cat <<'PROBE'
test -f "$CODEX_HOME/config.toml"
test "$(stat -c %u "$HOME")" = 10001
printf persisted >"$CODEX_HOME/persistence-smoke"
PROBE
)"
  second_probe="$(cat <<'PROBE'
test "$(cat "$CODEX_HOME/persistence-smoke")" = persisted
test -f "$CODEX_HOME/config.toml"
PROBE
)"

  [[ -f "$codex_runtime_entry" ]] \
    || fail "missing Codex runtime entrypoint: $codex_runtime_entry"
  [[ -f "$copilot_runtime_entry" ]] \
    || fail "missing Copilot runtime entrypoint: $copilot_runtime_entry"
  command -v docker >/dev/null 2>&1 || fail 'docker is required'
  docker image inspect "$image_ref" >/dev/null 2>&1 \
    || fail "missing real runtime image: $image_ref"
  initialize_persistence_test
  trap cleanup EXIT
  run_copilot_persistence_contract
  create_persistence_volume
  run_persistence_container "$first_probe"
  remove_owned_container \
    || fail 'first persistence container could not be safely removed'
  run_persistence_container "$second_probe"

  printf 'Trellage persistence test: PASS: %s reused across container recreation\n' \
    "$volume_name"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
