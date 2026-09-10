#!/usr/bin/env bash
set -euo pipefail

prototype_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
entry="$prototype_dir/runtime-copilot-entry.sh"
source "$prototype_dir/../../tests/helpers/sandbox_entry_fixture.sh"
root="$(mktemp -d "${TMPDIR:-/tmp}/trellage-copilot-entry.XXXXXX")"
image_ref="trellage-copilot-entry-contract:test-$$"
fixture_image_created=false
fixture_source_ref='mcr.microsoft.com/devcontainers/javascript-node@sha256:0d29e5fdc64f8397cd502223e0c4679f1e60877ca0fd2db4f2e2e0028e4271af'
fixture_source_pulled=false

cleanup() {
  local status=$?
  trap - EXIT
  if ! sandbox_fixture_home_cleanup; then
    printf 'Copilot entry contract: fixture home cleanup failed\n' >&2
    [[ "$status" -ne 0 ]] || status=1
  fi
  if [[ "$fixture_image_created" == true ]]; then
    docker image rm --force "$image_ref" >/dev/null 2>&1 || true
  fi
  if [[ "$fixture_source_pulled" == true ]]; then
    docker image rm "$fixture_source_ref" >/dev/null 2>&1 || true
  fi
  if ! rm -rf -- "$root"; then
    printf 'Copilot entry contract: fixture input cleanup failed\n' >&2
    [[ "$status" -ne 0 ]] || status=1
  fi
  exit "$status"
}
trap cleanup EXIT

fail() {
  printf 'Copilot entry contract: FAIL: %s\n' "$1" >&2
  exit 1
}

ldd_dependency_paths() {
  awk '
    / => \// { print $3 }
    $1 ~ /^\// { print $1 }
  '
}

ldd_parser_fixture=$'\tlinux-vdso.so.1 (0x00000000)\n\tlibc.so.6 => /lib/libc.so.6 (0x00000000)\n\t/lib64/ld-linux-x86-64.so.2 (0x00000000)'
parsed_fixture_dependencies="$(ldd_dependency_paths <<<"$ldd_parser_fixture")"
grep -Fqx '/lib64/ld-linux-x86-64.so.2' <<<"$parsed_fixture_dependencies" \
  || fail 'ldd parser omitted an indented ELF interpreter'

sha256_path() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

copy_linux_binary() {
  local binary="$1"
  local dependency
  mkdir -p "$root/rootfs$(dirname "$binary")"
  cp -L -- "$binary" "$root/rootfs$binary"
  while IFS= read -r dependency; do
    [[ -n "$dependency" ]] || continue
    mkdir -p "$root/rootfs$(dirname "$dependency")"
    cp -L -- "$dependency" "$root/rootfs$dependency"
  done < <(ldd "$binary" 2>/dev/null | ldd_dependency_paths | LC_ALL=C sort -u)
}

create_linux_rootfs() {
  local command_path python_stdlib ctypes_module
  mkdir -p "$root/rootfs"
  for command_name in \
    bash env realpath jq sha256sum find sort sed cut cmp grep mktemp cp mv ln stat chmod chown \
    cat mkdir dirname basename python3 rm flock; do
    command_path="$(command -v "$command_name")" \
      || fail "fixture host lacks required command: $command_name"
    copy_linux_binary "$command_path"
  done
  mkdir -p "$root/rootfs/bin"
  cp -L -- "$(command -v bash)" "$root/rootfs/bin/bash"
  python_stdlib="$(python3 -c 'import sysconfig; print(sysconfig.get_path("stdlib"))')"
  mkdir -p "$root/rootfs$(dirname "$python_stdlib")"
  cp -R -- "$python_stdlib" "$root/rootfs$python_stdlib"
  # Ask Python for the module rather than globbing: `_ctypes*.so` also matches
  # `_ctypes_test*.so`, which does not link libffi, and `find -print -quit` stops
  # at whichever the directory order happens to yield first. Selecting the test
  # helper left libffi out of the rootfs and made the entry fail to import ctypes.
  ctypes_module="$(python3 -c 'import _ctypes; print(_ctypes.__file__)')" \
    || fail 'fixture host Python lacks _ctypes'
  [[ -n "$ctypes_module" ]] || fail 'fixture host Python lacks _ctypes'
  copy_linux_binary "$ctypes_module"
  assembled_elf_interpreter="$(ldd "$(command -v bash)" 2>/dev/null \
    | ldd_dependency_paths | awk '$0 ~ /ld-/ { print; exit }')"
  [[ -n "$assembled_elf_interpreter" \
    && -f "$root/rootfs$assembled_elf_interpreter" ]] \
    || fail 'fixture rootfs omitted the Bash ELF interpreter'
  [[ -x "$root/rootfs/bin/bash" ]] \
    || fail 'fixture rootfs omitted executable canonical /bin/bash'
}

create_fixture_image() {
  local fixture_tools
  mkdir -p "$root/rootfs"
  if [[ "$(uname -s)" == Linux ]]; then
    create_linux_rootfs
  else
    if ! docker image inspect "$fixture_source_ref" >/dev/null 2>&1; then
      docker image pull "$fixture_source_ref" >/dev/null
      fixture_source_pulled=true
    fi
    fixture_tools="$(docker run --rm --network none --entrypoint /bin/bash \
      "$fixture_source_ref" -c \
      'command -v bash node jq python3 flock | LC_ALL=C sort')"
    for required_fixture_tool in bash flock jq node python3; do
      grep -Eq "/${required_fixture_tool}$" <<<"$fixture_tools" \
        || fail "pinned fixture source lacks $required_fixture_tool"
    done
    docker image tag "$fixture_source_ref" "$image_ref"
    fixture_image_created=true
    return
  fi
  tar -C "$root/rootfs" -cf - . | docker image import \
    --change 'USER 10001:10001' - "$image_ref" >/dev/null
  fixture_image_created=true
}

fixture_home_script() {
  local home_mount="$1"
  shift
  docker run --rm -i \
    --network none \
    --read-only \
    --user '10001:10001' \
    --entrypoint /bin/bash \
    --mount "$home_mount" \
    --mount "type=bind,src=$seed,dst=/usr/local/share/trellage/copilot-seed,readonly" \
    "$image_ref" -euo pipefail -c '
      fail() {
        printf "Copilot entry contract: FAIL: %s\n" "$1" >&2
        exit 1
      }
      source /dev/stdin
    ' -- "$@"
}

mutate_home() {
  fixture_home_script "$sandbox_fixture_home_mount" "$@"
}

inspect_home() {
  fixture_home_script "$sandbox_fixture_home_mount,readonly" "$@"
}

read_home_file() {
  inspect_home "$1" <<'READ_HOME_FILE'
cat -- "$1"
READ_HOME_FILE
}

snapshot_home_tree() {
  inspect_home "$1" <<'SNAPSHOT_HOME_TREE'
find "$1" -printf '%y %m %U:%G %p %l\n' | LC_ALL=C sort
find "$1" -type f -exec sha256sum -- {} + | LC_ALL=C sort
SNAPSHOT_HOME_TREE
}

transaction_temp_scan() {
  local scan_root="$1"
  docker run --rm \
    --network none \
    --read-only \
    --user '10001:10001' \
    --entrypoint /bin/bash \
    --mount "$sandbox_fixture_home_mount,readonly" \
    "$image_ref" -c '
      match="$(find "$1" -mindepth 1 \
        \( -name ".hve-core.trellage-*" \
          -o -name ".settings.json.trellage.*" \
          -o -name ".managed-*.trellage.*" \) -print -quit)" || exit 74
      if [[ -n "$match" ]]; then
        printf "%s\n" "$match"
        exit 3
      fi
      exit 0
    ' -- "$scan_root"
}

assert_transaction_scanner_contract() {
  local clean='/home/agent/.fixture-scanner/clean'
  local matched='/home/agent/.fixture-scanner/matched'
  local denied='/home/agent/.fixture-scanner/denied'
  local scan_status=0
  mutate_home "$clean" "$matched" <<'SCANNER_SETUP'
umask 077
mkdir -p -- "$1" "$2"
: >"$2/.managed-probe.trellage.1"
SCANNER_SETUP
  docker run --rm \
    --network none \
    --read-only \
    --user '0:0' \
    --entrypoint /bin/bash \
    --mount "$sandbox_fixture_home_mount" \
    "$image_ref" -ceu '
      mkdir -m 0700 -- "$1"
      [[ "$(stat -c "%u:%g:%a" -- "$1")" == "0:0:700" ]]
    ' -- "$denied" \
    || fail 'could not create a root-owned denied transaction scan directory'

  transaction_temp_scan "$clean" >/dev/null 2>&1 \
    || fail 'transaction temporary scanner rejected a clean tree'
  scan_status=0
  transaction_temp_scan "$matched" >/dev/null 2>&1 || scan_status=$?
  [[ "$scan_status" -eq 3 ]] \
    || fail "transaction temporary scanner returned $scan_status for a match"
  scan_status=0
  transaction_temp_scan "$denied" >/dev/null 2>&1 || scan_status=$?
  [[ "$scan_status" -eq 74 ]] \
    || fail "transaction temporary scanner returned $scan_status for a find error"
}

assert_no_transaction_temps() {
  local label="$1"
  local scan_output scan_status=0
  scan_output="$(transaction_temp_scan "$runtime" 2>&1)" || scan_status=$?
  case "$scan_status" in
    0) ;;
    3) fail "$label left a managed-state transaction temporary behind" ;;
    74) fail "$label transaction temporary scan failed: $scan_output" ;;
    *) fail "$label transaction temporary scan exited $scan_status: $scan_output" ;;
  esac
}

if [[ "${COPILOT_ENTRY_LINUX_ROOTFS_ONLY:-0}" == 1 ]]; then
  [[ "$(uname -s)" == Linux ]] || fail 'Linux rootfs probe requires Linux'
  assembled_elf_interpreter=
  create_linux_rootfs
  printf 'Copilot entry Linux rootfs: PASS: %s\n' "$assembled_elf_interpreter"
  exit 0
fi

seed="$root/seed"
runtime='/home/agent/.copilot'
fake_bin="$root/fake-bin"
output='/home/agent/.fixture-output'
plugin="$seed/installed-plugins/hve-core/hve-core"
mkdir -p "$plugin/.github/plugin" "$plugin/commands" "$seed/skills/caveman" "$fake_bin"
printf '{"name":"hve-core","version":"3.3.101"}\n' >"$plugin/.github/plugin/plugin.json"
printf 'managed review command\n' >"$plugin/commands/review.md"
printf 'ACTIVE EVERY RESPONSE\n' >"$seed/skills/caveman/SKILL.md"
printf 'ACTIVE EVERY RESPONSE\n' >"$seed/copilot-instructions.md"
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
  'copilot-instructions.md' \
  'installed-plugins/hve-core/hve-core/.github/plugin/plugin.json' \
  'installed-plugins/hve-core/hve-core/commands/review.md' \
  'managed-lock.json' \
  'managed-settings.json' \
  'skills/caveman/SKILL.md' >"$seed/managed-files.txt"
: >"$seed/managed.sha256"
while IFS= read -r managed_path; do
  printf '%s  %s\n' "$(sha256_path "$seed/$managed_path")" "$managed_path" \
    >>"$seed/managed.sha256"
done <"$seed/managed-files.txt"

cat >"$fake_bin/copilot" <<'FAKE_COPILOT'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$@" >"$TRELLAGE_TEST_OUTPUT/argv"
printf 'COPILOT_GITHUB_TOKEN=%s\n' "${COPILOT_GITHUB_TOKEN-}" >"$TRELLAGE_TEST_OUTPUT/env"
printf 'GH_TOKEN=%s\n' "${GH_TOKEN-}" >>"$TRELLAGE_TEST_OUTPUT/env"
printf 'GITHUB_TOKEN=%s\n' "${GITHUB_TOKEN-}" >>"$TRELLAGE_TEST_OUTPUT/env"
if [[ -n "${TRELLAGE_TEST_CREATE_SESSION_ID-}" ]]; then
  session_dir="$COPILOT_HOME/session-state/$TRELLAGE_TEST_CREATE_SESSION_ID"
  mkdir -p "$session_dir"
  printf 'id: %s\ncwd: %s\n' "$TRELLAGE_TEST_CREATE_SESSION_ID" "$PWD" \
    >"$session_dir/workspace.yaml"
fi
exit "${TRELLAGE_TEST_COPILOT_EXIT:-0}"
FAKE_COPILOT
chmod 755 "$fake_bin/copilot"

create_fixture_image
sandbox_fixture_home_create "$image_ref" copilot-entry \
  || fail 'could not create the Copilot fixture home'
mutate_home "$runtime" "$output" <<'INITIAL_STATE'
runtime="$1"
output="$2"
seed='/usr/local/share/trellage/copilot-seed'
umask 077
mkdir -p "$runtime/skills/user-skill" "$output"
printf 'keep user skill\n' >"$runtime/skills/user-skill/SKILL.md"
cp -R "$seed/skills/caveman" "$runtime/skills/caveman"
cp "$seed/copilot-instructions.md" "$runtime/copilot-instructions.md"
printf '{"keep":true,"trustedFolders":["/existing"]}\n' >"$runtime/config.json"
printf '{"hooks":{"SessionStart":[{"type":"command","bash":"existing-session-start"}]}}\n' \
  >"$runtime/settings.json"
INITIAL_STATE
assert_transaction_scanner_contract

run_entry() {
  docker run --rm \
    --network none \
    --read-only \
    --tmpfs '/tmp:rw,nosuid,nodev,size=16m' \
    --user '10001:10001' \
    --entrypoint /bin/bash \
    --mount "type=bind,src=$entry,dst=/test/runtime-copilot-entry.sh,readonly" \
    --mount "type=bind,src=$prototype_dir/copilot-model-settings.py,dst=/usr/local/bin/trellage-copilot-model-settings,readonly" \
    --mount "type=bind,src=$prototype_dir/../../scripts/trellage-session-bridge.py,dst=/usr/local/bin/trellage-session-bridge,readonly" \
    --mount "type=bind,src=$seed,dst=/usr/local/share/trellage/copilot-seed,readonly" \
    --mount "$sandbox_fixture_home_mount" \
    --mount "type=bind,src=$fake_bin,dst=/test-bin,readonly" \
    --env 'PATH=/test-bin:/usr/local/bin:/usr/bin:/bin' \
    --env "TRELLAGE_TEST_OUTPUT=$output" \
    --env 'TRELLAGE_AGENT=copilot' \
    --env 'TRELLAGE_PROFILE_NAME=copilot-hve-test' \
    --env "TRELLAGE_COPILOT_MODEL=${TRELLAGE_COPILOT_MODEL-}" \
    --env "TRELLAGE_COPILOT_REASONING_EFFORT=${TRELLAGE_COPILOT_REASONING_EFFORT-}" \
    --env "TRELLAGE_COPILOT_PLAN_MODE_REASONING_EFFORT=${TRELLAGE_COPILOT_PLAN_MODE_REASONING_EFFORT-}" \
    --env "COPILOT_GITHUB_TOKEN=${COPILOT_GITHUB_TOKEN-}" \
    --env "GH_TOKEN=${GH_TOKEN-}" \
    --env "GITHUB_TOKEN=${GITHUB_TOKEN-}" \
    --env "TRELLAGE_TEST_COPILOT_EXIT=${TRELLAGE_TEST_COPILOT_EXIT-}" \
    --env "TRELLAGE_TEST_CREATE_SESSION_ID=${TRELLAGE_TEST_CREATE_SESSION_ID-}" \
    --env "TRELLAGE_RESUME_PROFILE=${TRELLAGE_RESUME_PROFILE-}" \
    --env "TRELLAGE_RESUME_SESSION_ID=${TRELLAGE_RESUME_SESSION_ID-}" \
    "$image_ref" -euo pipefail -c '
      rm -f -- "$TRELLAGE_TEST_OUTPUT/argv" "$TRELLAGE_TEST_OUTPUT/env"
      exec /bin/bash /test/runtime-copilot-entry.sh "$@"
    ' -- "$@"
}

read_output_file() {
  local output_file="$1"
  case "$output_file" in
    argv|env) ;;
    *) fail "unsupported fixture output file: $output_file" ;;
  esac
  inspect_home "$output/$output_file" <<'READ_OUTPUT'
[[ -f "$1" && ! -L "$1" ]] || fail "missing regular Copilot fixture capture: $1"
[[ "$(stat -c '%a' -- "$1")" == 600 ]] \
  || fail "Copilot fixture output did not preserve mode 0600: $1"
cat -- "$1"
READ_OUTPUT
}

prompt='literal $(touch /tmp/not-executed) prompt'
COPILOT_GITHUB_TOKEN='selected-token' GH_TOKEN='poison-gh' GITHUB_TOKEN='poison-github' \
  run_entry prompt --allow-all -- "$prompt"
default_model_argv=$'--model\ngpt-6-astra\n--effort\nlow'
expected_prompt_argv="$default_model_argv"$'\n--allow-all\n-p\nliteral $(touch /tmp/not-executed) prompt'
prompt_argv="$(read_output_file argv)"
prompt_env="$(read_output_file env)"
[[ "$prompt_argv" == "$expected_prompt_argv" ]] \
  || fail 'prompt mode did not map the exact prompt to Copilot -p argv'
grep -Fqx 'COPILOT_GITHUB_TOKEN=selected-token' <<<"$prompt_env" \
  || fail 'prompt mode did not preserve selected Copilot authentication'
grep -Fqx 'GH_TOKEN=' <<<"$prompt_env" \
  || fail 'prompt mode exposed ambient GH_TOKEN'
grep -Fqx 'GITHUB_TOKEN=' <<<"$prompt_env" \
  || fail 'prompt mode exposed ambient GITHUB_TOKEN'

assert_no_transaction_temps 'successful prompt mode'
inspect_home "$runtime" <<'INITIAL_CHECKS'
runtime="$1"
grep -Fqx 'ACTIVE EVERY RESPONSE' "$runtime/skills/caveman/SKILL.md" \
  || fail 'managed Caveman skill was not synchronized'
grep -Fqx 'ACTIVE EVERY RESPONSE' "$runtime/copilot-instructions.md" \
  || fail 'managed Copilot instructions were not synchronized'
grep -Fqx 'keep user skill' "$runtime/skills/user-skill/SKILL.md" \
  || fail 'Copilot synchronization replaced unrelated user state'
jq -e '
  .keep == true
  and .trustedFolders == ["/existing", "/"]
' "$runtime/config.json" >/dev/null \
  || fail 'Copilot workspace trust was not persisted without changing existing config'
jq -e '
  .model == "gpt-6-astra" and .effortLevel == "low"
  and .planModel == "gpt-6-astra" and .planEffortLevel == "max"
' "$runtime/settings.json" >/dev/null \
  || fail 'Copilot default and plan modes did not receive separate model settings'
INITIAL_CHECKS

COPILOT_GITHUB_TOKEN= GH_TOKEN= GITHUB_TOKEN= run_entry new --allow-all
interactive_argv="$(read_output_file argv)"
interactive_env="$(read_output_file env)"
[[ "$interactive_argv" == "$default_model_argv"$'\n--allow-all' ]] \
  || fail 'bare new mode was not left interactive without a prompt flag'
grep -Fqx 'COPILOT_GITHUB_TOKEN=' <<<"$interactive_env" \
  || fail 'bare new mode invented Copilot authentication'

resume_session_id='5b3664c0-9954-4526-8aab-d3d2c177798d'
TRELLAGE_RESUME_SESSION_ID="$resume_session_id" \
  COPILOT_GITHUB_TOKEN= GH_TOKEN= GITHUB_TOKEN= \
  run_entry resume --allow-all
exact_resume_argv="$(read_output_file argv)"
[[ "$exact_resume_argv" == "$default_model_argv"$'\n--allow-all\n--resume='"$resume_session_id" ]] \
  || fail 'exact resume did not map to Copilot --resume=ID argv'

TRELLAGE_COPILOT_MODEL=gpt-5.5 TRELLAGE_COPILOT_REASONING_EFFORT=high \
  TRELLAGE_COPILOT_PLAN_MODE_REASONING_EFFORT=xhigh \
  run_entry prompt --model gpt-5.4-mini --reasoning-effort low -- 'explicit overrides'
[[ "$(read_output_file argv)" == $'--model\ngpt-5.5\n--effort\nhigh\n--model\ngpt-5.4-mini\n--reasoning-effort\nlow\n-p\nexplicit overrides' ]] \
  || fail 'configured Copilot defaults did not precede explicit caller overrides'
settings_before_probe="$(
  inspect_home "$runtime/settings.json" <<'OVERRIDE_SETTINGS'
jq -e '
  .model == "gpt-5.5" and .effortLevel == "high"
  and .planModel == "gpt-5.5" and .planEffortLevel == "xhigh"
' "$1" >/dev/null \
  || fail 'Copilot plan overrides did not stay separate from default effort'
cat -- "$1"
OVERRIDE_SETTINGS
)"

run_entry new --version
[[ "$(read_output_file argv)" == --version ]] \
  || fail 'version probe received session model defaults'
run_entry new plugin list
[[ "$(read_output_file argv)" == $'plugin\nlist' ]] \
  || fail 'plugin inventory probe received session model defaults'
settings_after_probe="$(read_home_file "$runtime/settings.json")"
[[ "$settings_after_probe" == "$settings_before_probe" ]] \
  || fail 'read-only Copilot probes changed model settings'

for mode in new prompt; do
  prompt_flag=-i
  [[ "$mode" != prompt ]] || prompt_flag=-p
  COPILOT_GITHUB_TOKEN= GH_TOKEN= GITHUB_TOKEN= \
    run_entry "$mode" --allow-all --agent hve-core:dt-coach -- 'Customer discovery only.'
  [[ "$(read_output_file argv)" == "$default_model_argv"$'\n--allow-all\n--agent\nhve-core:dt-coach\n'"$prompt_flag"$'\nCustomer discovery only.' ]] \
    || fail "$mode mode lost the selected workflow agent or changed its prompt"
done
TRELLAGE_RESUME_SESSION_ID="$resume_session_id" \
  COPILOT_GITHUB_TOKEN= GH_TOKEN= GITHUB_TOKEN= \
  run_entry resume --allow-all --agent hve-core:dt-coach
[[ "$(read_output_file argv)" == "$default_model_argv"$'\n--allow-all\n--agent\nhve-core:dt-coach\n--resume='"$resume_session_id" ]] \
  || fail 'resume lost the selected workflow agent'

hint_output="$(
  TRELLAGE_RESUME_PROFILE=/tmp/copilot-hve/profile.toml \
  TRELLAGE_TEST_CREATE_SESSION_ID="$resume_session_id" \
  COPILOT_GITHUB_TOKEN= GH_TOKEN= GITHUB_TOKEN= \
    run_entry new --allow-all
)"
grep -Fqx 'Resume this conversation:' <<<"$hint_output" \
  || fail 'Copilot exit did not print resume guidance'
grep -Fqx \
  "trellage resume --profile /tmp/copilot-hve/profile.toml $resume_session_id" \
  <<<"$hint_output" \
  || fail 'Copilot exit did not print exact Trellage resume command'

status=0
COPILOT_GITHUB_TOKEN='selected-token' TRELLAGE_TEST_COPILOT_EXIT=29 \
  run_entry prompt --allow-all -- 'native status' || status=$?
[[ "$status" -eq 29 ]] || fail "prompt mode changed Copilot status 29 to $status"
assert_no_transaction_temps 'failed prompt mode'

inspect_home "$runtime" <<'REPEATED_LAUNCH_CHECKS'
runtime="$1"
jq -e '.trustedFolders == ["/existing", "/"]' "$runtime/config.json" >/dev/null \
  || fail 'repeated Copilot launches duplicated the trusted workspace'
jq -e '
  .model == "gpt-6-astra" and .effortLevel == "low"
  and .planModel == "gpt-6-astra" and .planEffortLevel == "max"
' "$runtime/settings.json" >/dev/null \
  || fail 'repeated Copilot launches did not restore managed mode defaults'
jq -e '
  .hooks.SessionStart
  | map(select(
      .type == "command"
      and .bash == "/usr/local/bin/trellage-session-bridge sandbox-hook --agent copilot --profile copilot-hve-test"
    ))
  | length == 1
' "$runtime/settings.json" >/dev/null \
  || fail 'repeated Copilot launches did not install exactly one Sandbox SessionStart bridge'
jq -e '
  any(.hooks.SessionStart[]; .type == "command" and .bash == "existing-session-start")
' "$runtime/settings.json" >/dev/null \
  || fail 'Copilot SessionStart bridge replaced an existing hook'
REPEATED_LAUNCH_CHECKS

mutate_home "$runtime" <<'COMMENTED_CONFIG'
runtime="$1"
commented_config="$runtime/config.json.next"
cat >"$commented_config" <<'EOF'
// User settings belong in settings.json.
// This file is managed automatically.
{
  "keep": true,
  "trustedFolders": ["/existing"]
}
EOF
mv -f -- "$commented_config" "$runtime/config.json"
COMMENTED_CONFIG
COPILOT_GITHUB_TOKEN= GH_TOKEN= GITHUB_TOKEN= \
  run_entry prompt --allow-all -- 'commented config'
inspect_home "$runtime/config.json" <<'COMMENTED_CONFIG_CHECK'
jq -e '
  .keep == true
  and .trustedFolders == ["/existing", "/"]
' "$1" >/dev/null \
  || fail 'Copilot managed config comment prologue was not normalized safely'
COMMENTED_CONFIG_CHECK
assert_no_transaction_temps 'commented config normalization'

redirected_parent='/home/agent/.fixture-plugin-parent-target'
mutate_home "$runtime" "$redirected_parent" <<'REDIRECT_PLUGIN_PARENT'
runtime="$1"
target="$2"
# Redirect the marketplace parent, not the repairable managed-plugin leaf.
parent="$runtime/installed-plugins/hve-core"
mv -- "$parent" "$runtime/installed-plugins/hve-core.fixture-original"
mkdir -p "$target/hve-core/commands"
printf 'keep redirected plugin unchanged\n' >"$target/hve-core/commands/review.md"
ln -s -- "$target" "$parent"
REDIRECT_PLUGIN_PARENT
redirected_parent_before="$(snapshot_home_tree "$redirected_parent")"
if parent_refusal_output="$(run_entry prompt --allow-all -- 'redirected plugin parent' 2>&1)"; then
  fail 'managed plugin parent redirection was accepted'
fi
grep -Fqx \
  'trellage-copilot-entry: Copilot managed marketplace must be a directory without symlinks' \
  <<<"$parent_refusal_output" \
  || fail "managed plugin parent redirection failed for another reason: $parent_refusal_output"
redirected_parent_after="$(snapshot_home_tree "$redirected_parent")"
[[ "$redirected_parent_after" == "$redirected_parent_before" ]] \
  || fail 'managed plugin parent redirection changed the redirected target'
inspect_home "$runtime" "$output" <<'PLUGIN_PARENT_CHECKS'
[[ -L "$1/installed-plugins/hve-core" ]] \
  || fail 'managed plugin parent redirection was replaced instead of refused'
[[ ! -e "$2/argv" && ! -L "$2/argv" && ! -e "$2/env" && ! -L "$2/env" ]] \
  || fail 'managed plugin parent redirection reached Copilot'
PLUGIN_PARENT_CHECKS
assert_no_transaction_temps 'managed plugin parent redirection refusal'
mutate_home "$runtime" <<'RESTORE_PLUGIN_PARENT'
parent="$1/installed-plugins/hve-core"
[[ -L "$parent" ]] || fail 'managed plugin parent redirection could not be restored'
rm -- "$parent"
mv -- "$1/installed-plugins/hve-core.fixture-original" "$parent"
RESTORE_PLUGIN_PARENT

mutate_home "$runtime/config.json" <<'MALFORMED_CONFIG'
printf 'not-json\n' >"$1"
MALFORMED_CONFIG
if run_entry prompt --allow-all -- 'malformed config'; then
  fail 'malformed Copilot config was accepted'
fi
assert_no_transaction_temps 'malformed config rejection'

mutate_home "$runtime" <<'SYMLINKED_CONFIG'
printf '{"trustedFolders":[]}\n' >"$1/config-target.json"
rm -f -- "$1/config.json"
ln -s config-target.json "$1/config.json"
SYMLINKED_CONFIG
if run_entry prompt --allow-all -- 'symlinked config'; then
  fail 'symlinked Copilot config was accepted'
fi
config_target="$(read_home_file "$runtime/config-target.json")"
[[ "$config_target" == '{"trustedFolders":[]}' ]] \
  || fail 'symlinked Copilot config target was modified'
assert_no_transaction_temps 'symlinked config rejection'

printf 'Copilot entry contract: PASS\n'
