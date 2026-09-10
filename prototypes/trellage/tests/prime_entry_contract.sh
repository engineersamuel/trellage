#!/usr/bin/env bash
set -euo pipefail

prototype_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
repo_root="$(cd "$prototype_dir/../.." && pwd -P)"
entry="$prototype_dir/runtime-prime-entry.sh"
root="$repo_root/.agent_work/prime-entry-contract-$$"
fixture_source_ref='mcr.microsoft.com/devcontainers/javascript-node@sha256:0d29e5fdc64f8397cd502223e0c4679f1e60877ca0fd2db4f2e2e0028e4271af'
fixture_source_pulled=false
source "$repo_root/tests/helpers/sandbox_entry_fixture.sh"

cleanup() {
  local status=$?
  if ! sandbox_fixture_home_cleanup; then
    [[ "$status" -ne 0 ]] || status=1
  fi
  if [[ "$fixture_source_pulled" == true ]]; then
    docker image rm "$fixture_source_ref" >/dev/null 2>&1 || true
  fi
  if ! rm -rf -- "$root"; then
    [[ "$status" -ne 0 ]] || status=1
  fi
  exit "$status"
}
trap cleanup EXIT

fail() {
  printf 'Prime entry contract: FAIL: %s\n' "$1" >&2
  exit 1
}

mkdir -p \
  "$root/fake-bin" \
  "$root/prime-kernel/.local/share/uv/python/cpython-3.11-linux-aarch64-gnu/bin" \
  "$root/prime-kernel/.prime/agent/kernel-venv/bin" \
  "$root/prime-seed/skills/caveman" \
  "$root/prime-seed/extensions"
printf '%s\n' '{"providers":{"copilot-proxy-rs":{"baseUrl":"http://copilot-proxy-rs:8080","api":"anthropic-messages","apiKey":"trellage-local-proxy","compat":{"supportsEagerToolInputStreaming":false},"models":[{"id":"claude-opus-5"}]}}}' \
  >"$root/prime-seed/models.json"
printf '# Caveman\n' >"$root/prime-seed/skills/caveman/SKILL.md"
printf 'caveman\n' >"$root/prime-seed/managed-skills.txt"
printf 'export default function managedTool() {}\n' >"$root/prime-seed/extensions/managed-tool.ts"
printf 'managed-tool\n' >"$root/prime-seed/managed-extensions.txt"
printf '# Trellage managed always-on skill: caveman\n\n# Caveman\n' >"$root/prime-seed/APPEND_SYSTEM.md"
printf 'schema=1\n' >"$root/prime-kernel/.trellage-prime-kernel"
printf '#!/bin/sh\nexit 0\n' \
  >"$root/prime-kernel/.local/share/uv/python/cpython-3.11-linux-aarch64-gnu/bin/python3.11"
chmod 755 "$root/prime-kernel/.local/share/uv/python/cpython-3.11-linux-aarch64-gnu/bin/python3.11"
ln -s \
  /home/agent/.trellage/prime-kernel/.local/share/uv/python/cpython-3.11-linux-aarch64-gnu/bin/python3.11 \
  "$root/prime-kernel/.prime/agent/kernel-venv/bin/python"
COPYFILE_DISABLE=1 tar --no-xattrs -C "$root/prime-kernel" -czf "$root/prime-kernel-seed.tar.gz" .

cat >"$root/fake-bin/prime-agent" <<'FAKE_PRIME'
#!/usr/bin/env bash
set -euo pipefail
umask 077
mkdir -p -- "$TRELLAGE_TEST_OUTPUT"
printf '%s\n' "$@" >"$TRELLAGE_TEST_OUTPUT/argv"
: >"$TRELLAGE_TEST_OUTPUT/env"
rm -f -- "$TRELLAGE_TEST_OUTPUT/mode"
for name in ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN OPENAI_API_KEY COPILOT_GITHUB_TOKEN GH_TOKEN GITHUB_TOKEN GH_CONFIG_DIR PRIME_AGENT_CODING_AGENT_DIR; do
  printf '%s=%s\n' "$name" "${!name-}" >>"$TRELLAGE_TEST_OUTPUT/env"
done
if [[ -f "${PRIME_AGENT_CODING_AGENT_DIR:-/missing}/models.json" ]]; then
  stat -c 'MODE=%a' -- "$PRIME_AGENT_CODING_AGENT_DIR/models.json" >"$TRELLAGE_TEST_OUTPUT/mode"
fi
exit "${TRELLAGE_TEST_PRIME_EXIT:-0}"
FAKE_PRIME
chmod 755 "$root/fake-bin/prime-agent"

if ! docker image inspect "$fixture_source_ref" >/dev/null 2>&1; then
  docker image pull "$fixture_source_ref" >/dev/null
  fixture_source_pulled=true
fi
sandbox_fixture_home_create "$fixture_source_ref" prime-entry

run_entry() {
  local status=0
  docker run --rm \
    --network none \
    --read-only \
    --tmpfs '/tmp:rw,nosuid,nodev,size=16m' \
    --user '10001:10001' \
    --entrypoint /bin/bash \
    --mount "type=bind,src=$entry,dst=/test/runtime-prime-entry.sh,readonly" \
    --mount "type=bind,src=$root/fake-bin,dst=/test-bin,readonly" \
    --mount "$sandbox_fixture_home_mount" \
    --mount "type=bind,src=$root/prime-kernel-seed.tar.gz,dst=/usr/local/share/trellage/prime-kernel-seed.tar.gz,readonly" \
    --mount "type=bind,src=$root/prime-seed,dst=/usr/local/share/trellage/prime-seed,readonly" \
    --env 'PATH=/test-bin:/usr/local/bin:/usr/bin:/bin' \
    --env 'TRELLAGE_TEST_OUTPUT=/home/agent/.fixture-output' \
    --env 'PRIME_AGENT_CODING_AGENT_DIR=/home/agent/.prime/agent' \
    --env 'PRIME_AGENT_KERNEL_PYTHON=/home/agent/.trellage/prime-kernel/.prime/agent/kernel-venv/bin/python' \
    --env "TRELLAGE_RESUME_SESSION_ID=${TRELLAGE_RESUME_SESSION_ID-}" \
    --env "TRELLAGE_TEST_PRIME_EXIT=${TRELLAGE_TEST_PRIME_EXIT-}" \
    --env "ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY-}" \
    --env "ANTHROPIC_AUTH_TOKEN=${ANTHROPIC_AUTH_TOKEN-}" \
    --env "CLAUDE_CODE_OAUTH_TOKEN=${CLAUDE_CODE_OAUTH_TOKEN-}" \
    --env "OPENAI_API_KEY=${OPENAI_API_KEY-}" \
    --env "COPILOT_GITHUB_TOKEN=${COPILOT_GITHUB_TOKEN-}" \
    --env "GH_TOKEN=${GH_TOKEN-}" \
    --env "GITHUB_TOKEN=${GITHUB_TOKEN-}" \
    --env 'GH_CONFIG_DIR=/tmp/trellage-gh' \
    "$fixture_source_ref" /test/runtime-prime-entry.sh "$@" || status=$?
  return "$status"
}

mutate_home() {
  local mount="$sandbox_fixture_home_mount"
  if [[ "${1-}" == --readonly ]]; then
    mount+=',readonly'
    shift
  fi
  local script="$1"
  shift
  docker run --rm \
    --network none \
    --read-only \
    --user '10001:10001' \
    --entrypoint /bin/bash \
    --mount "$mount" \
    --mount "type=bind,src=$root/prime-seed,dst=/seed,readonly" \
    "$fixture_source_ref" -ceu "$(declare -f fail)"$'\n'"$script" prime-entry-fixture "$@"
}

assert_argv() {
  mutate_home --readonly '
    [[ "$(cat /home/agent/.fixture-output/argv)" == "$1" ]] || fail "$2"
  ' "$1" "$2"
}

run_entry new --version
mutate_home --readonly '
  [[ "$(cat /home/agent/.fixture-output/argv)" == --version ]] \
    || fail "version mode did not call prime-agent directly"
  [[ ! -e /home/agent/.prime && ! -L /home/agent/.prime ]] \
    || fail "version mode initialized Prime state"
'

mutate_home '
  umask 077
  prime_home=/home/agent/.prime/agent
  mkdir -p "$prime_home/sessions" "$prime_home/skills/user" "$prime_home/extensions"
  printf "persisted\n" >"$prime_home/sessions/sentinel"
  printf "stale\n" >"$prime_home/models.json"
  printf "user\n" >"$prime_home/skills/user/SKILL.md"
  printf "user-extension\n" >"$prime_home/extensions/user-tool.ts"
'

prompt='literal $(touch /tmp/not-executed) --resume prompt'
ANTHROPIC_API_KEY=poison-anthropic ANTHROPIC_AUTH_TOKEN=poison-auth CLAUDE_CODE_OAUTH_TOKEN=poison-claude \
OPENAI_API_KEY=poison-openai COPILOT_GITHUB_TOKEN=poison-copilot GH_TOKEN=poison-gh GITHUB_TOKEN=poison-github \
  run_entry prompt --dangerous-arg -- "$prompt"
expected_prompt_argv=$'--provider\ncopilot-proxy-rs\n--model\nclaude-opus-5\n--offline\n--dangerous-arg\n-p\nliteral $(touch /tmp/not-executed) --resume prompt'
mutate_home --readonly '
  output=/home/agent/.fixture-output
  prime_home=/home/agent/.prime/agent
  kernel_home=/home/agent/.trellage/prime-kernel
  [[ "$(cat "$output/argv")" == "$1" ]] \
    || fail "prompt mode did not preserve literal prompt and fixed provider/model argv"
  for name in ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN OPENAI_API_KEY COPILOT_GITHUB_TOKEN GH_TOKEN GITHUB_TOKEN; do
    grep -Fqx "$name=" "$output/env" || fail "prompt mode exposed $name"
  done
  grep -Fqx "GH_CONFIG_DIR=/tmp/trellage-gh" "$output/env" \
    || fail "prompt mode discarded GH_CONFIG_DIR"
  grep -Fqx "PRIME_AGENT_CODING_AGENT_DIR=/home/agent/.prime/agent" "$output/env" \
    || fail "prompt mode did not isolate persistent Prime state"
  [[ "$(cat "$output/mode")" == MODE=600 ]] || fail "managed models.json mode is not 0600"
  [[ -L "$kernel_home/.prime/agent/kernel-venv/bin/python" \
    && -x "$kernel_home/.local/share/uv/python/cpython-3.11-linux-aarch64-gnu/bin/python3.11" ]] \
    || fail "managed Prime kernel was not restored into persistent state"
  cmp -s /seed/models.json "$prime_home/models.json" \
    || fail "managed models.json was not replaced from the baked seed"
  [[ "$(cat "$prime_home/sessions/sentinel")" == persisted ]] \
    || fail "unmanaged Prime session state was not preserved"
  cmp -s /seed/skills/caveman/SKILL.md "$prime_home/skills/caveman/SKILL.md" \
    || fail "managed Caveman skill was not installed from the baked seed"
  cmp -s /seed/managed-skills.txt "$prime_home/.trellage-managed-skills" \
    || fail "managed Prime skill manifest was not installed"
  cmp -s /seed/extensions/managed-tool.ts "$prime_home/extensions/managed-tool.ts" \
    || fail "managed extension was not installed from the baked seed"
  cmp -s /seed/managed-extensions.txt "$prime_home/.trellage-managed-extensions" \
    || fail "managed Prime extension manifest was not installed"
  cmp -s /seed/APPEND_SYSTEM.md "$prime_home/APPEND_SYSTEM.md" \
    || fail "managed Prime always-on instructions were not installed"
  [[ "$(cat "$prime_home/skills/user/SKILL.md")" == user ]] \
    || fail "unmanaged Prime skill state was not preserved"
  [[ "$(cat "$prime_home/extensions/user-tool.ts")" == user-extension ]] \
    || fail "unmanaged Prime extension state was not preserved"
' "$expected_prompt_argv"

run_entry new --unsafe
expected_new_argv=$'--provider\ncopilot-proxy-rs\n--model\nclaude-opus-5\n--offline\n--unsafe'
assert_argv "$expected_new_argv" 'interactive mode changed Prime argv'
run_entry new --unsafe --model vendor/custom
expected_custom_argv=$'--provider\ncopilot-proxy-rs\n--model\nvendor/custom\n--offline\n--unsafe'
mutate_home --readonly '
  [[ "$(cat /home/agent/.fixture-output/argv)" == "$1" ]] \
    || fail "custom model did not replace the Prime launch default"
  jq -e '\''[.providers["copilot-proxy-rs"].models[].id] == ["claude-opus-5", "vendor/custom"]'\'' /home/agent/.prime/agent/models.json >/dev/null \
    || fail "custom model was not materialized in managed Prime configuration"
' "$expected_custom_argv"

run_entry new --unsafe -- 'new prompt'
expected_new_prompt_argv=$'--provider\ncopilot-proxy-rs\n--model\nclaude-opus-5\n--offline\n--unsafe\nnew prompt'
assert_argv "$expected_new_prompt_argv" 'new prompt mode changed Prime argv'

TRELLAGE_RESUME_SESSION_ID='session-123' run_entry resume --unsafe
expected_exact_resume_argv=$'--provider\ncopilot-proxy-rs\n--model\nclaude-opus-5\n--offline\n--unsafe\n-r\nsession-123'
assert_argv "$expected_exact_resume_argv" 'explicit resume mode changed Prime argv'

TRELLAGE_RESUME_SESSION_ID= run_entry resume --unsafe
expected_latest_resume_argv=$'--provider\ncopilot-proxy-rs\n--model\nclaude-opus-5\n--offline\n--unsafe\n-c'
assert_argv "$expected_latest_resume_argv" 'latest resume mode changed Prime argv'

mutate_home 'printf "outside\\n" >/home/agent/outside-skill; rm -rf /home/agent/.prime/agent/skills/caveman; ln -s /home/agent/outside-skill /home/agent/.prime/agent/skills/caveman'
status=0
run_entry new || status=$?
[[ "$status" -ne 0 ]] || fail 'symlinked managed Prime skill was accepted'
mutate_home '
  [[ "$(cat /home/agent/outside-skill)" == outside ]] \
    || fail "managed Prime skill symlink target was modified"
  rm -f /home/agent/.prime/agent/skills/caveman
'

mutate_home 'printf "outside\\n" >/home/agent/outside-extension; rm -f /home/agent/.prime/agent/extensions/managed-tool.ts; ln -s /home/agent/outside-extension /home/agent/.prime/agent/extensions/managed-tool.ts'
status=0
run_entry new || status=$?
[[ "$status" -ne 0 ]] || fail 'symlinked managed Prime extension was accepted'
mutate_home '
  [[ "$(cat /home/agent/outside-extension)" == outside ]] \
    || fail "managed Prime extension symlink target was modified"
  rm -f /home/agent/.prime/agent/extensions/managed-tool.ts
'

mutate_home 'printf "outside\\n" >/home/agent/outside-models.json; rm -f /home/agent/.prime/agent/models.json; ln -s /home/agent/outside-models.json /home/agent/.prime/agent/models.json'
status=0
run_entry new || status=$?
[[ "$status" -ne 0 ]] || fail 'symlinked models.json was accepted'
mutate_home '
  [[ "$(cat /home/agent/outside-models.json)" == outside ]] || fail "symlink target was modified"
  rm -f /home/agent/.prime/agent/models.json
'

mutate_home '
  cp -R /home/agent/.prime/agent /home/agent/.fixture-output/agent-before-symlink
  mv /home/agent/.prime/agent /home/agent/.prime/agent-real
  ln -s agent-real /home/agent/.prime/agent
'
status=0
run_entry new || status=$?
[[ "$status" -ne 0 ]] || fail 'symlinked Prime config root was accepted'
mutate_home '
  diff -r /home/agent/.fixture-output/agent-before-symlink /home/agent/.prime/agent-real \
    || fail "Prime config root symlink target was modified"
  rm -f /home/agent/.prime/agent
  mv /home/agent/.prime/agent-real /home/agent/.prime/agent
'

status=0
TRELLAGE_TEST_PRIME_EXIT=29 run_entry prompt -- 'native status' || status=$?
[[ "$status" -eq 29 ]] || fail "prompt mode changed Prime status 29 to $status"

printf 'Prime entry contract: PASS\n'
