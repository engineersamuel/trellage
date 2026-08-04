#!/usr/bin/env bash
set -euo pipefail

prototype_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
entry="$prototype_dir/runtime-copilot-entry.sh"
root="$(mktemp -d "${TMPDIR:-/tmp}/trellage-copilot-entry.XXXXXX")"
image_ref="trellage-copilot-entry-contract:test-$$"
fixture_image_created=false
fixture_source_ref='mcr.microsoft.com/devcontainers/javascript-node@sha256:0d29e5fdc64f8397cd502223e0c4679f1e60877ca0fd2db4f2e2e0028e4271af'
fixture_source_pulled=false

cleanup() {
  local status=$?
  if [[ "$fixture_image_created" == true ]]; then
    docker run --rm --network none --user '0:0' \
      --entrypoint /bin/bash \
      --mount "type=bind,src=$root/runtime,dst=/cleanup-runtime" \
      --mount "type=bind,src=$root/output,dst=/cleanup-output" \
      "$image_ref" -c 'chmod -R a+rwX /cleanup-runtime /cleanup-output' \
      >/dev/null 2>&1 || true
    docker image rm --force "$image_ref" >/dev/null 2>&1 || true
  fi
  if [[ "$fixture_source_pulled" == true ]]; then
    docker image rm "$fixture_source_ref" >/dev/null 2>&1 || true
  fi
  rm -rf -- "$root"
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
    bash env realpath jq sha256sum find sort sed cut cmp grep mktemp cp mv stat chmod \
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
  ctypes_module="$(find "$python_stdlib" -type f -name '_ctypes*.so' -print -quit)"
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

transaction_temp_scan() {
  local scan_root="$1"
  docker run --rm \
    --network none \
    --read-only \
    --user '10001:10001' \
    --entrypoint /bin/bash \
    --mount "type=bind,src=$scan_root,dst=/runtime,readonly" \
    "$image_ref" -c '
      match="$(find /runtime -mindepth 1 \
        \( -name ".hve-core.trellage-*" \
          -o -name ".settings.json.trellage.*" \
          -o -name ".managed-*.trellage.*" \) -print -quit)" || exit 74
      if [[ -n "$match" ]]; then
        printf "%s\n" "$match"
        exit 3
      fi
    '
}

assert_transaction_scanner_contract() {
  local clean="$root/scan-clean"
  local matched="$root/scan-matched"
  local denied="$root/scan-denied"
  local scan_status=0
  mkdir -p "$clean" "$matched" "$denied"
  chmod 777 "$clean" "$matched"
  : >"$matched/.managed-probe.trellage.1"
  chmod 700 "$denied"

  transaction_temp_scan "$clean" >/dev/null 2>&1 \
    || fail 'transaction temporary scanner rejected a clean tree'
  scan_status=0
  transaction_temp_scan "$matched" >/dev/null 2>&1 || scan_status=$?
  [[ "$scan_status" -eq 3 ]] \
    || fail "transaction temporary scanner returned $scan_status for a match"
  if [[ "$(uname -s)" == Linux ]]; then
    scan_status=0
    transaction_temp_scan "$denied" >/dev/null 2>&1 || scan_status=$?
    [[ "$scan_status" -eq 74 ]] \
      || fail "transaction temporary scanner returned $scan_status for a find error"
  fi
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
runtime="$root/runtime"
fake_bin="$root/fake-bin"
output="$root/output"
plugin="$seed/installed-plugins/hve-core/hve-core"
mkdir -p "$plugin/.github/plugin" "$plugin/commands" "$runtime" "$fake_bin" "$output"
chmod 777 "$runtime" "$output"
printf '{"name":"hve-core","version":"3.3.101"}\n' >"$plugin/.github/plugin/plugin.json"
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
assert_transaction_scanner_contract

run_entry() {
  local status=0
  docker run --rm \
    --network none \
    --read-only \
    --tmpfs '/tmp:rw,nosuid,nodev,size=16m' \
    --user '10001:10001' \
    --entrypoint /bin/bash \
    --mount "type=bind,src=$entry,dst=/test/runtime-copilot-entry.sh,readonly" \
    --mount "type=bind,src=$seed,dst=/usr/local/share/trellage/copilot-seed,readonly" \
    --mount "type=bind,src=$runtime,dst=/home/agent/.copilot" \
    --mount "type=bind,src=$fake_bin,dst=/test-bin,readonly" \
    --mount "type=bind,src=$output,dst=/test-output" \
    --env 'PATH=/test-bin:/usr/local/bin:/usr/bin:/bin' \
    --env 'TRELLAGE_TEST_OUTPUT=/test-output' \
    --env "COPILOT_GITHUB_TOKEN=${COPILOT_GITHUB_TOKEN-}" \
    --env "GH_TOKEN=${GH_TOKEN-}" \
    --env "GITHUB_TOKEN=${GITHUB_TOKEN-}" \
    --env "TRELLAGE_TEST_COPILOT_EXIT=${TRELLAGE_TEST_COPILOT_EXIT-}" \
    --env "TRELLAGE_TEST_CREATE_SESSION_ID=${TRELLAGE_TEST_CREATE_SESSION_ID-}" \
    --env "TRELLAGE_RESUME_PROFILE=${TRELLAGE_RESUME_PROFILE-}" \
    --env "TRELLAGE_RESUME_SESSION_ID=${TRELLAGE_RESUME_SESSION_ID-}" \
    "$image_ref" /test/runtime-copilot-entry.sh "$@" || status=$?
  return "$status"
}

read_output_file() {
  local output_file="$1"
  case "$output_file" in
    argv|env) ;;
    *) fail "unsupported fixture output file: $output_file" ;;
  esac
  docker run --rm \
    --network none \
    --read-only \
    --user '10001:10001' \
    --entrypoint /bin/bash \
    --mount "type=bind,src=$output,dst=/test-output,readonly" \
    "$image_ref" -c 'cat -- "/test-output/$1"' -- "$output_file"
}

output_file_mode() {
  if stat -f '%Lp' "$1" >/dev/null 2>&1; then
    stat -f '%Lp' "$1"
  else
    stat -c '%a' "$1"
  fi
}

prompt='literal $(touch /tmp/not-executed) prompt'
COPILOT_GITHUB_TOKEN='selected-token' GH_TOKEN='poison-gh' GITHUB_TOKEN='poison-github' \
  run_entry prompt --allow-all -- "$prompt"
expected_prompt_argv=$'--allow-all\n-p\nliteral $(touch /tmp/not-executed) prompt'
prompt_argv="$(read_output_file argv)"
prompt_env="$(read_output_file env)"
[[ "$(output_file_mode "$output/argv")" == 600 \
  && "$(output_file_mode "$output/env")" == 600 ]] \
  || fail 'Copilot fixture output did not preserve mode 0600'
[[ "$prompt_argv" == "$expected_prompt_argv" ]] \
  || fail 'prompt mode did not map the exact prompt to Copilot -p argv'
grep -Fqx 'COPILOT_GITHUB_TOKEN=selected-token' <<<"$prompt_env" \
  || fail 'prompt mode did not preserve selected Copilot authentication'
grep -Fqx 'GH_TOKEN=' <<<"$prompt_env" \
  || fail 'prompt mode exposed ambient GH_TOKEN'
grep -Fqx 'GITHUB_TOKEN=' <<<"$prompt_env" \
  || fail 'prompt mode exposed ambient GITHUB_TOKEN'

assert_no_transaction_temps 'successful prompt mode'

COPILOT_GITHUB_TOKEN= GH_TOKEN= GITHUB_TOKEN= run_entry new --allow-all
interactive_argv="$(read_output_file argv)"
interactive_env="$(read_output_file env)"
[[ "$interactive_argv" == '--allow-all' ]] \
  || fail 'bare new mode was not left interactive without a prompt flag'
grep -Fqx 'COPILOT_GITHUB_TOKEN=' <<<"$interactive_env" \
  || fail 'bare new mode invented Copilot authentication'

resume_session_id='5b3664c0-9954-4526-8aab-d3d2c177798d'
TRELLAGE_RESUME_SESSION_ID="$resume_session_id" \
  COPILOT_GITHUB_TOKEN= GH_TOKEN= GITHUB_TOKEN= \
  run_entry resume --allow-all
exact_resume_argv="$(read_output_file argv)"
[[ "$exact_resume_argv" == $'--allow-all\n--resume='"$resume_session_id" ]] \
  || fail 'exact resume did not map to Copilot --resume=ID argv'

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

printf 'Copilot entry contract: PASS\n'
