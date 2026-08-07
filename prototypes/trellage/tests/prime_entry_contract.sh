#!/usr/bin/env bash
set -euo pipefail

prototype_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
repo_root="$(cd "$prototype_dir/../.." && pwd -P)"
entry="$prototype_dir/runtime-prime-entry.sh"
root="$repo_root/.agent_work/prime-entry-contract-$$"
fixture_source_ref='mcr.microsoft.com/devcontainers/javascript-node@sha256:0d29e5fdc64f8397cd502223e0c4679f1e60877ca0fd2db4f2e2e0028e4271af'
fixture_source_pulled=false

cleanup() {
  local status=$?
  if [[ -d "$root" ]] && docker image inspect "$fixture_source_ref" >/dev/null 2>&1; then
    docker run --rm \
      --network none \
      --entrypoint /bin/chmod \
      --mount "type=bind,src=$root,dst=/cleanup" \
      "$fixture_source_ref" -R a+rwX /cleanup >/dev/null 2>&1 || true
  fi
  if [[ "$fixture_source_pulled" == true ]]; then
    docker image rm "$fixture_source_ref" >/dev/null 2>&1 || true
  fi
  rm -rf -- "$root"
  exit "$status"
}
trap cleanup EXIT

fail() {
  printf 'Prime entry contract: FAIL: %s\n' "$1" >&2
  exit 1
}

mkdir -p "$root/fake-bin" "$root/home" "$root/output" "$root/prime-seed/skills/caveman"
printf '%s\n' '{"providers":{"copilot-proxy-rs":{"baseUrl":"http://copilot-proxy-rs:8080","api":"anthropic-messages","apiKey":"trellage-local-proxy","compat":{"supportsEagerToolInputStreaming":false},"models":[{"id":"claude-opus-5"}]}}}' \
  >"$root/prime-seed/models.json"
printf '# Caveman\n' >"$root/prime-seed/skills/caveman/SKILL.md"
printf 'caveman\n' >"$root/prime-seed/managed-skills.txt"
printf '# Trellage managed always-on skill: caveman\n\n# Caveman\n' >"$root/prime-seed/APPEND_SYSTEM.md"
chmod -R 777 "$root/home" "$root/output"

cat >"$root/fake-bin/prime-agent" <<'FAKE_PRIME'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$@" >"$TRELLAGE_TEST_OUTPUT/argv"
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
    --mount "type=bind,src=$root/home,dst=/home/agent" \
    --mount "type=bind,src=$root/output,dst=/test-output" \
    --mount "type=bind,src=$root/prime-seed,dst=/usr/local/share/trellage/prime-seed,readonly" \
    --env 'PATH=/test-bin:/usr/local/bin:/usr/bin:/bin' \
    --env 'TRELLAGE_TEST_OUTPUT=/test-output' \
    --env 'PRIME_AGENT_CODING_AGENT_DIR=/home/agent/.prime/agent' \
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
  docker run --rm \
    --network none \
    --user '10001:10001' \
    --entrypoint /bin/bash \
    --mount "type=bind,src=$root/home,dst=/home/agent" \
    --mount "type=bind,src=$root/prime-seed,dst=/seed,readonly" \
    "$fixture_source_ref" -ceu "$1"
}

run_entry new --version
[[ "$(cat "$root/output/argv")" == '--version' ]] || fail 'version mode did not call prime-agent directly'
[[ ! -e "$root/home/.prime" ]] || fail 'version mode initialized Prime state'

mkdir -p "$root/home/.prime/agent/sessions"
printf 'persisted\n' >"$root/home/.prime/agent/sessions/sentinel"
printf 'stale\n' >"$root/home/.prime/agent/models.json"
mkdir -p "$root/home/.prime/agent/skills/user"
printf 'user\n' >"$root/home/.prime/agent/skills/user/SKILL.md"
chmod -R 777 "$root/home"

prompt='literal $(touch /tmp/not-executed) --resume prompt'
ANTHROPIC_API_KEY=poison-anthropic ANTHROPIC_AUTH_TOKEN=poison-auth CLAUDE_CODE_OAUTH_TOKEN=poison-claude \
OPENAI_API_KEY=poison-openai COPILOT_GITHUB_TOKEN=poison-copilot GH_TOKEN=poison-gh GITHUB_TOKEN=poison-github \
  run_entry prompt --dangerous-arg -- "$prompt"
expected_prompt_argv=$'--provider\ncopilot-proxy-rs\n--model\nclaude-opus-5\n--offline\n--dangerous-arg\n-p\n--\nliteral $(touch /tmp/not-executed) --resume prompt'
[[ "$(cat "$root/output/argv")" == "$expected_prompt_argv" ]] \
  || fail 'prompt mode did not preserve literal prompt and fixed provider/model argv'
for name in ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN OPENAI_API_KEY COPILOT_GITHUB_TOKEN GH_TOKEN GITHUB_TOKEN; do
  grep -Fqx "$name=" "$root/output/env" || fail "prompt mode exposed $name"
done
grep -Fqx 'GH_CONFIG_DIR=/tmp/trellage-gh' "$root/output/env" || fail 'prompt mode discarded GH_CONFIG_DIR'
grep -Fqx 'PRIME_AGENT_CODING_AGENT_DIR=/home/agent/.prime/agent' "$root/output/env" \
  || fail 'prompt mode did not isolate persistent Prime state'
[[ "$(cat "$root/output/mode")" == 'MODE=600' ]] || fail 'managed models.json mode is not 0600'
mutate_home 'cmp -s /seed/models.json /home/agent/.prime/agent/models.json' \
  || fail 'managed models.json was not replaced from the baked seed'
[[ "$(cat "$root/home/.prime/agent/sessions/sentinel")" == persisted ]] \
  || fail 'unmanaged Prime session state was not preserved'
cmp -s "$root/prime-seed/skills/caveman/SKILL.md" "$root/home/.prime/agent/skills/caveman/SKILL.md" \
  || fail 'managed Caveman skill was not installed from the baked seed'
cmp -s "$root/prime-seed/managed-skills.txt" "$root/home/.prime/agent/.trellage-managed-skills" \
  || fail 'managed Prime skill manifest was not installed'
cmp -s "$root/prime-seed/APPEND_SYSTEM.md" "$root/home/.prime/agent/APPEND_SYSTEM.md" \
  || fail 'managed Prime always-on instructions were not installed'
[[ "$(cat "$root/home/.prime/agent/skills/user/SKILL.md")" == user ]] \
  || fail 'unmanaged Prime skill state was not preserved'

run_entry new --unsafe
expected_new_argv=$'--provider\ncopilot-proxy-rs\n--model\nclaude-opus-5\n--offline\n--unsafe'
[[ "$(cat "$root/output/argv")" == "$expected_new_argv" ]] || fail 'interactive mode changed Prime argv'

run_entry new --unsafe -- 'new prompt'
expected_new_prompt_argv=$'--provider\ncopilot-proxy-rs\n--model\nclaude-opus-5\n--offline\n--unsafe\n--\nnew prompt'
[[ "$(cat "$root/output/argv")" == "$expected_new_prompt_argv" ]] || fail 'new prompt mode changed Prime argv'

TRELLAGE_RESUME_SESSION_ID='session-123' run_entry resume --unsafe
expected_exact_resume_argv=$'--provider\ncopilot-proxy-rs\n--model\nclaude-opus-5\n--offline\n--unsafe\n-r\nsession-123'
[[ "$(cat "$root/output/argv")" == "$expected_exact_resume_argv" ]] || fail 'explicit resume mode changed Prime argv'

TRELLAGE_RESUME_SESSION_ID= run_entry resume --unsafe
expected_latest_resume_argv=$'--provider\ncopilot-proxy-rs\n--model\nclaude-opus-5\n--offline\n--unsafe\n-c'
[[ "$(cat "$root/output/argv")" == "$expected_latest_resume_argv" ]] || fail 'latest resume mode changed Prime argv'

mutate_home 'printf "outside\\n" >/home/agent/outside-skill; rm -rf /home/agent/.prime/agent/skills/caveman; ln -s /home/agent/outside-skill /home/agent/.prime/agent/skills/caveman'
status=0
run_entry new || status=$?
[[ "$status" -ne 0 ]] || fail 'symlinked managed Prime skill was accepted'
[[ "$(cat "$root/home/outside-skill")" == outside ]] || fail 'managed Prime skill symlink target was modified'
mutate_home 'rm -f /home/agent/.prime/agent/skills/caveman'

mutate_home 'printf "outside\\n" >/home/agent/outside-models.json; rm -f /home/agent/.prime/agent/models.json; ln -s /home/agent/outside-models.json /home/agent/.prime/agent/models.json'
status=0
run_entry new || status=$?
[[ "$status" -ne 0 ]] || fail 'symlinked models.json was accepted'
[[ "$(cat "$root/home/outside-models.json")" == outside ]] || fail 'symlink target was modified'
mutate_home 'rm -f /home/agent/.prime/agent/models.json'

mutate_home 'mv /home/agent/.prime/agent /home/agent/.prime/agent-real; ln -s agent-real /home/agent/.prime/agent'
status=0
run_entry new || status=$?
[[ "$status" -ne 0 ]] || fail 'symlinked Prime config root was accepted'
mutate_home 'rm -f /home/agent/.prime/agent; mv /home/agent/.prime/agent-real /home/agent/.prime/agent'

status=0
TRELLAGE_TEST_PRIME_EXIT=29 run_entry prompt -- 'native status' || status=$?
[[ "$status" -eq 29 ]] || fail "prompt mode changed Prime status 29 to $status"

printf 'Prime entry contract: PASS\n'
