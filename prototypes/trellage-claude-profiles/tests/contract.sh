#!/usr/bin/env bash

set -euo pipefail

root="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
. "$root/../../tests/helpers/floating_skills_fixture.sh"
launcher="$root/bin/cldx"
installer="$root/install.sh"
uninstaller="$root/uninstall.sh"

fail() {
  printf 'cldx contract failed: %s\n' "$1" >&2
  exit 1
}

fixture_root="$(mktemp -d "${TMPDIR:-/tmp}/trellage-cldx-contract.XXXXXX")" \
  || fail 'could not create fixture root'
signal_pid=''
cleanup() {
  if [[ "$signal_pid" =~ ^[1-9][0-9]*$ ]]; then
    kill -TERM "$signal_pid" 2>/dev/null || true
    wait "$signal_pid" 2>/dev/null || true
  fi
  rm -rf -- "$fixture_root"
}
trap cleanup EXIT HUP INT TERM

fake_bin="$fixture_root/fake-bin"
home="$fixture_root/home"
mkdir -p "$fake_bin" "$home"

cat >"$fake_bin/claude" <<'FAKE_CLAUDE'
#!/usr/bin/env bash
set -euo pipefail

if [[ "${1-}" == --version ]]; then
  if [[ -n "${FAKE_CLAUDE_ENV_DUMP-}" ]]; then
    env >"$FAKE_CLAUDE_ENV_DUMP"
  fi
  printf '%s (Claude Code)\n' "${FAKE_CLAUDE_VERSION:-2.1.233}"
  exit 0
fi

if [[ -n "${FAKE_CLAUDE_ENV_DUMP-}" ]]; then
  env >"$FAKE_CLAUDE_ENV_DUMP"
fi

jq -cn \
  --arg configDir "${CLAUDE_CONFIG_DIR-}" \
  --arg authToken "${ANTHROPIC_AUTH_TOKEN-}" \
  --arg baseUrl "${ANTHROPIC_BASE_URL-}" \
  --arg opus "${ANTHROPIC_DEFAULT_OPUS_MODEL-}" \
  --arg sonnet "${ANTHROPIC_DEFAULT_SONNET_MODEL-}" \
  --arg haiku "${ANTHROPIC_DEFAULT_HAIKU_MODEL-}" \
  --arg apiKey "${ANTHROPIC_API_KEY-unset}" \
  --arg oauth "${CLAUDE_CODE_OAUTH_TOKEN-unset}" \
  --arg openai "${OPENAI_API_KEY-unset}" \
  --arg gh "${GH_TOKEN-unset}" \
  '$ARGS.named + {args:$ARGS.positional}' \
  --args -- "$@" >>"$FAKE_CLAUDE_LOG"

if [[ "${FAKE_CLAUDE_WAIT_FOR_SIGNAL-}" == 1 ]]; then
  trap 'printf "TERM\n" >>"$FAKE_CLAUDE_SIGNAL_LOG"; exit 143' TERM
  printf 'READY\n' >>"$FAKE_CLAUDE_SIGNAL_LOG"
  while :; do sleep 0.05; done
fi

if [[ -n "${FAKE_CLAUDE_STDOUT_FILE-}" ]]; then
  [[ -f "$FAKE_CLAUDE_STDOUT_FILE" && ! -L "$FAKE_CLAUDE_STDOUT_FILE" ]] || exit 79
  cat -- "$FAKE_CLAUDE_STDOUT_FILE"
fi
if [[ -n "${FAKE_CLAUDE_STDERR_FILE-}" ]]; then
  [[ -f "$FAKE_CLAUDE_STDERR_FILE" && ! -L "$FAKE_CLAUDE_STDERR_FILE" ]] || exit 79
  cat -- "$FAKE_CLAUDE_STDERR_FILE" >&2
fi

exit "${FAKE_CLAUDE_EXIT_STATUS:-0}"
FAKE_CLAUDE
chmod 0755 "$fake_bin/claude"

cat >"$fake_bin/curl" <<'FAKE_CURL'
#!/usr/bin/env bash
set -euo pipefail

url="${!#}"
case "$url" in
  http://127.0.0.1:8080/health)
    [[ "${FAKE_PROXY_HEALTH:-ok}" == ok ]] || exit 22
    if [[ "${FAKE_PROXY_HEALTH_JSON:-valid}" == valid ]]; then
      printf '{"status":"ok"}\n'
    else
      printf '{"status":"unexpected"}\n'
    fi
    ;;
  http://127.0.0.1:8080/v1/models)
    if [[ "${FAKE_PROXY_HAS_MODEL:-1}" == 1 ]]; then
      printf '{"data":[{"id":"claude-opus-5"}]}\n'
    else
      printf '{"data":[{"id":"another-model"}]}\n'
    fi
    ;;
  *) exit 93 ;;
esac
FAKE_CURL
chmod 0755 "$fake_bin/curl"

ln -s "$(command -v jq)" "$fake_bin/jq"
install_fixture_node "$fake_bin"
seed_floating_skills_cache "$home"

export PATH="$fake_bin:/usr/bin:/bin:/usr/sbin:/sbin"
export HOME="$home"
export FAKE_CLAUDE_LOG="$fixture_root/claude.log"
export FAKE_CLAUDE_SIGNAL_LOG="$fixture_root/signal.log"
: >"$FAKE_CLAUDE_LOG"

"$installer" >"$fixture_root/install.out" || fail 'install failed'
command_path="$HOME/.local/bin/cldx"
runtime_root="$HOME/.local/share/trellage/cldx"
profile_root="$HOME/.local/share/trellage/profiles/claude/default"
profile_home="$profile_root/home"

[[ -L "$command_path" ]] || fail 'installer did not publish command symlink'
[[ "$(readlink "$command_path")" == "$runtime_root/bin/cldx" ]] \
  || fail 'command symlink target differs'
cmp -s "$runtime_root/catalog.json" "$root/catalog.json" \
  || fail 'installer did not publish catalog'
[[ -f "$runtime_root/lib/trellage-session-bridge.py" \
  && ! -L "$runtime_root/lib/trellage-session-bridge.py" \
  && -x "$runtime_root/lib/trellage-session-bridge.py" ]] \
  || fail 'installer did not publish the session bridge'
cmp -s "$runtime_root/lib/trellage-session-bridge.py" \
  "$root/../../scripts/trellage-session-bridge.py" \
  || fail 'installed runtime session bridge differs'
[[ -f "$runtime_root/lib/native-claude" \
  && ! -L "$runtime_root/lib/native-claude" \
  && -x "$runtime_root/lib/native-claude" ]] \
  || fail 'installer did not publish the shared native Claude runtime'
cmp -s "$runtime_root/lib/native-claude" \
  "$root/../trellage-claude-common/native-claude" \
  || fail 'installed shared native Claude runtime differs'
for asset in rundown.md NOTICE.md; do
  [[ -f "$runtime_root/assets/rundown/$asset" && ! -L "$runtime_root/assets/rundown/$asset" ]] \
    || fail "installer did not publish asset: $asset"
  cmp -s "$runtime_root/assets/rundown/$asset" "$root/assets/rundown/$asset" \
    || fail "installed asset differs: $asset"
done
cmp -s "$root/assets/rundown/rundown.md" \
  "$root/../trellage/assets/rundown/rundown.md" \
  || fail 'vendored output style differs from the canonical copy'
cmp -s "$root/assets/rundown/NOTICE.md" \
  "$root/../trellage/assets/rundown/NOTICE.md" \
  || fail 'vendored notice differs from the canonical copy'

"$installer" >"$fixture_root/reinstall.out" || fail 'repeat install failed'

"$command_path" list >"$fixture_root/list.out" || fail 'list failed'
grep -Fqx $'default\tIsolated Claude Code for autonomous engineering and Rundown status output, routed keylessly to Claude Opus 5 through the local proxy.' \
  "$fixture_root/list.out" || fail 'list output differs'

"$command_path" list --json >"$fixture_root/list.json" || fail 'JSON list failed'
jq -e '
  .schemaVersion == 1
  and .launcher == "cldx"
  and .harness == "claude"
  and .sandbox == false
  and [.profiles[].name] == ["default"]
  and .profiles[0].source == "anthropics/claude-code"
  and .profiles[0].headless == {
    "schemaVersion": 1,
    "prompt": true,
    "outputFormats": ["text", "jsonl"],
    "eventContract": "claude-stream-json-v1",
    "trellageEventContract": null,
    "sessionId": "native",
    "resume": true,
    "resumeWithPrompt": true,
    "questionToolControl": "hard-deny",
    "changedFiles": "none",
    "usage": true,
    "cost": true,
    "modelOverride": true,
    "effortOverride": false,
    "testedHarnessVersion": "2.1.233"
  }
' "$fixture_root/list.json" >/dev/null || fail 'JSON list differs'

FAKE_CLAUDE_VERSION=2.1.230 "$command_path" list --json >"$fixture_root/list-drift.json" \
  || fail 'drifted JSON list failed'
jq -e '
  .profiles[0].headless == {
    "schemaVersion": 1,
    "prompt": false,
    "outputFormats": ["text"],
    "eventContract": null,
    "trellageEventContract": null,
    "sessionId": "none",
    "resume": false,
    "resumeWithPrompt": false,
    "questionToolControl": "none",
    "changedFiles": "none",
    "usage": false,
    "cost": false,
    "modelOverride": false,
    "effortOverride": false,
    "testedHarnessVersion": null
  }
' "$fixture_root/list-drift.json" >/dev/null || fail 'drifted JSON list differs'

cp "$runtime_root/catalog.json" "$fixture_root/catalog.saved" || fail 'could not save catalog'
jq '.profiles.default.headless.questionToolControl = "invalid"' \
  "$runtime_root/catalog.json" >"$fixture_root/catalog.invalid" \
  || fail 'could not create invalid catalog'
mv "$fixture_root/catalog.invalid" "$runtime_root/catalog.json"
if "$command_path" list --json >"$fixture_root/invalid-list.out" 2>"$fixture_root/invalid-list.err"; then
  fail 'list accepted invalid headless catalog'
fi
grep -Fq 'cldx: invalid catalog:' "$fixture_root/invalid-list.err" \
  || fail 'invalid headless catalog diagnostic differs'
jq '.profiles.default.headless.trellageEventContract = "unsupported-trellage-events-v1"' \
  "$fixture_root/catalog.saved" >"$fixture_root/catalog.invalid" \
  || fail 'could not create invalid Trellage event contract'
mv "$fixture_root/catalog.invalid" "$runtime_root/catalog.json"
if "$command_path" list --json \
  >"$fixture_root/invalid-trellage-event-list.out" \
  2>"$fixture_root/invalid-trellage-event-list.err"; then
  fail 'list accepted unsupported Trellage event contract'
fi
grep -Fq 'cldx: invalid catalog:' "$fixture_root/invalid-trellage-event-list.err" \
  || fail 'unsupported Trellage event contract diagnostic differs'
mv "$fixture_root/catalog.saved" "$runtime_root/catalog.json"

"$command_path" default -p 'self-heal-before-setup-probe' \
  >"$fixture_root/self-heal.out" 2>"$fixture_root/self-heal.err" \
  || fail 'launch before explicit setup did not self-heal'
[[ -f "$profile_root/.managed-by-trellage-claude-profiles" ]] \
  || fail 'self-healed launch did not mark profile ownership'
[[ -d "$profile_home" && ! -L "$profile_home" ]] \
  || fail 'self-healed launch did not materialize the profile home'
rm -rf "$profile_root"

mkdir -p "$profile_home"
printf '%s\n' 'trellage-claude-profile-v1' \
  >"$profile_root/.managed-by-trellage-claude-profiles"
cat >"$profile_home/settings.json" <<'EOF'
{
  "hooks": {
    "SessionStart": [
      {"matcher": "*", "hooks": [{"type": "command", "command": "user-session-start"}]},
      {"matcher": "*", "hooks": [{"type": "command", "command": "cccc-session-start"}]}
    ]
  },
  "preserve": "user-settings"
}
EOF
"$command_path" setup >"$fixture_root/setup.out" || fail 'setup failed'
[[ -f "$profile_root/.managed-by-trellage-claude-profiles" ]] \
  || fail 'setup did not mark profile ownership'
[[ -d "$profile_home" && ! -L "$profile_home" ]] || fail 'profile home is unsafe'
jq -e '
  .hasCompletedOnboarding == true
  and .lastOnboardingVersion == "2.1.233"
  and .shiftEnterKeyBindingInstalled == true
  and .theme == "dark"
' "$profile_home/.claude.json" >/dev/null || fail 'setup onboarding state differs'
output_style="$profile_home/output-styles/rundown.md"
[[ -f "$output_style" && ! -L "$output_style" ]] || fail 'setup did not seed the output style'
cmp -s "$output_style" "$root/assets/rundown/rundown.md" \
  || fail 'seeded output style differs'
settings="$profile_home/settings.json"
[[ -f "$settings" && ! -L "$settings" ]] || fail 'setup did not seed Claude settings'
jq -e '
  .outputStyle == "Rundown"
  and .preserve == "user-settings"
  and any(.hooks.SessionStart[]; any(.hooks[]; .command == "user-session-start"))
  and any(.hooks.SessionStart[]; any(.hooks[]; .command == "cccc-session-start"))
  and ([.hooks.SessionStart[]
    | .hooks[]
    | select(.type == "command"
      and (.command | contains(" native-hook --agent claude --profile default")))]
    | length) == 1
' "$settings" >/dev/null \
  || fail 'setup Claude output style differs'
session_bridge="$profile_home/.trellage/trellage-session-bridge.py"
[[ -f "$session_bridge" && ! -L "$session_bridge" && -x "$session_bridge" ]] \
  || fail 'setup did not install a regular executable session bridge'
cmp -s "$session_bridge" "$root/../../scripts/trellage-session-bridge.py" \
  || fail 'installed session bridge differs from the shared executable'
if grep -Fq 'pane.report_agent_session' "$session_bridge"; then
  fail 'session bridge includes forbidden agent-session reporting'
fi
settings_hash="$(shasum -a 256 "$settings" | awk '{print $1}')"
"$command_path" setup >"$fixture_root/setup-repeat.out" || fail 'repeat setup failed'
[[ "$(shasum -a 256 "$settings" | awk '{print $1}')" == "$settings_hash" ]] \
  || fail 'repeated setup changed session bridge hook settings'

"$command_path" || fail 'bare launch failed'
jq -e '
  .args == ["--dangerously-skip-permissions", "--permission-mode", "bypassPermissions", "--disallowedTools", "AskUserQuestion", "--model", "claude-opus-5"]
' "$FAKE_CLAUDE_LOG" >/dev/null || fail 'bare launch arguments differ'

workspace="$(pwd -P)"
jq -e --arg workspace "$workspace" \
  '.projects[$workspace].hasTrustDialogAccepted == true' \
  "$profile_home/.claude.json" >/dev/null \
  || fail 'launch did not trust the current workspace'

printf 'preserve\n' >"$profile_home/unrelated-state"
ANTHROPIC_API_KEY=poison \
CLAUDE_CODE_OAUTH_TOKEN=poison \
OPENAI_API_KEY=poison \
GH_TOKEN=poison \
  "$command_path" default -p 'two words' '' '--literal=*' \
  || fail 'default launch failed'
jq -s -e --arg home "$profile_home" '
  .[-1].configDir == $home
  and .[-1].authToken == "trellage-local-proxy"
  and .[-1].baseUrl == "http://127.0.0.1:8080"
  and .[-1].opus == "claude-opus-5"
  and .[-1].sonnet == "claude-sonnet-5"
  and .[-1].haiku == "claude-haiku-4.5"
  and .[-1].apiKey == "unset"
  and .[-1].oauth == "unset"
  and .[-1].openai == "unset"
  and .[-1].gh == "unset"
  and .[-1].args == ["--dangerously-skip-permissions", "--permission-mode", "bypassPermissions", "--disallowedTools", "AskUserQuestion", "--model", "claude-opus-5", "-p", "two words", "", "--literal=*"]
' "$FAKE_CLAUDE_LOG" >/dev/null || fail 'default launch environment or arguments differ'

# --- provider/token scrub must cover the supported provider/token override
# paths, so a stale tmux/Herdr daemon environment (fmx worker threat
# model) can never leak into the launched process. GH_CONFIG_DIR must
# survive since fmx workers deliberately use file-backed gh auth.
poison_env_assignments=(
  ANTHROPIC_CUSTOM_HEADERS=poison ANTHROPIC_MODEL=poison ANTHROPIC_SMALL_FAST_MODEL=poison
  CLAUDE_CODE_USE_FOUNDRY=poison ANTHROPIC_FOUNDRY_API_KEY=poison ANTHROPIC_FOUNDRY_BASE_URL=poison
  ANTHROPIC_FOUNDRY_RESOURCE=poison ANTHROPIC_BEDROCK_BASE_URL=poison ANTHROPIC_VERTEX_BASE_URL=poison
  CLAUDE_CODE_USE_BEDROCK=poison AWS_ACCESS_KEY_ID=poison AWS_SECRET_ACCESS_KEY=poison
  AWS_SESSION_TOKEN=poison AWS_PROFILE=poison AWS_BEARER_TOKEN_BEDROCK=poison AWS_REGION=poison
  AWS_DEFAULT_REGION=poison AWS_ROLE_ARN=poison AWS_WEB_IDENTITY_TOKEN_FILE=poison
  AWS_SHARED_CREDENTIALS_FILE=poison AWS_CONFIG_FILE=poison
  CLAUDE_CODE_USE_VERTEX=poison GOOGLE_APPLICATION_CREDENTIALS=poison ANTHROPIC_VERTEX_PROJECT_ID=poison
  CLOUD_ML_REGION=poison GOOGLE_CLOUD_PROJECT=poison GOOGLE_CLOUD_QUOTA_PROJECT=poison
  GOOGLE_CLOUD_REGION=poison VERTEX_PROJECT=poison VERTEX_REGION=poison
  AZURE_CLIENT_ID=poison AZURE_CLIENT_SECRET=poison AZURE_TENANT_ID=poison OPENAI_API_KEY=poison
  AZURE_API_KEY=poison AZURE_OPENAI_API_KEY=poison AZURE_OPENAI_ENDPOINT=poison OPENAI_BASE_URL=poison
  COPILOT_GITHUB_TOKEN=poison COPILOT_PROXY_GITHUB_TOKEN=poison COPILOT_TOKEN=poison
  GH_TOKEN=poison GITHUB_TOKEN=poison GH_ENTERPRISE_TOKEN=poison
  GITHUB_ENTERPRISE_TOKEN=poison
)
scrubbed_var_names=(
  ANTHROPIC_CUSTOM_HEADERS ANTHROPIC_MODEL ANTHROPIC_SMALL_FAST_MODEL
  CLAUDE_CODE_USE_FOUNDRY ANTHROPIC_FOUNDRY_API_KEY ANTHROPIC_FOUNDRY_BASE_URL
  ANTHROPIC_FOUNDRY_RESOURCE ANTHROPIC_BEDROCK_BASE_URL ANTHROPIC_VERTEX_BASE_URL
  CLAUDE_CODE_USE_BEDROCK AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
  AWS_PROFILE AWS_BEARER_TOKEN_BEDROCK AWS_REGION AWS_DEFAULT_REGION AWS_ROLE_ARN
  AWS_WEB_IDENTITY_TOKEN_FILE AWS_SHARED_CREDENTIALS_FILE AWS_CONFIG_FILE
  CLAUDE_CODE_USE_VERTEX GOOGLE_APPLICATION_CREDENTIALS ANTHROPIC_VERTEX_PROJECT_ID
  CLOUD_ML_REGION GOOGLE_CLOUD_PROJECT GOOGLE_CLOUD_QUOTA_PROJECT GOOGLE_CLOUD_REGION
  VERTEX_PROJECT VERTEX_REGION
  AZURE_CLIENT_ID AZURE_CLIENT_SECRET AZURE_TENANT_ID OPENAI_API_KEY
  AZURE_API_KEY AZURE_OPENAI_API_KEY AZURE_OPENAI_ENDPOINT OPENAI_BASE_URL
  COPILOT_GITHUB_TOKEN COPILOT_PROXY_GITHUB_TOKEN COPILOT_TOKEN
  GH_TOKEN GITHUB_TOKEN GH_ENTERPRISE_TOKEN GITHUB_ENTERPRISE_TOKEN
)

env_dump="$fixture_root/launch-env-dump.txt"
env "${poison_env_assignments[@]}" \
  GH_CONFIG_DIR=/fixture/gh-config-marker \
  FAKE_CLAUDE_ENV_DUMP="$env_dump" \
  "$command_path" default -p 'scrub check' \
  || fail 'scrub-check launch failed'

for scrubbed_var in "${scrubbed_var_names[@]}"; do
  grep -q "^${scrubbed_var}=" "$env_dump" \
    && fail "launch did not scrub $scrubbed_var"
done
grep -Fqx 'GH_CONFIG_DIR=/fixture/gh-config-marker' "$env_dump" \
  || fail 'launch scrubbed GH_CONFIG_DIR, which fmx workers rely on for file-backed gh auth'
grep -Fqx 'ANTHROPIC_AUTH_TOKEN=trellage-local-proxy' "$env_dump" \
  || fail 'launch did not set the managed ANTHROPIC_AUTH_TOKEN'
grep -Fqx 'ANTHROPIC_BASE_URL=http://127.0.0.1:8080' "$env_dump" \
  || fail 'launch did not set the managed ANTHROPIC_BASE_URL'

"$command_path" --model claude-sonnet-5 -p override \
  || fail 'model override launch failed'
jq -s -e '
  .[-1].args == ["--dangerously-skip-permissions", "--permission-mode", "bypassPermissions", "--disallowedTools", "AskUserQuestion", "--model", "claude-sonnet-5", "-p", "override"]
' "$FAKE_CLAUDE_LOG" >/dev/null || fail 'explicit model override was changed'

headless_session_id='5b3664c0-9954-4526-8aab-d3d2c177798d'
headless_initial_stream="$fixture_root/headless-initial.jsonl"
printf '%s\n' \
  '{"type":"system","subtype":"init","session_id":"5b3664c0-9954-4526-8aab-d3d2c177798d","model":"claude-opus-5"}' \
  '{"type":"result","subtype":"success","is_error":false,"session_id":"5b3664c0-9954-4526-8aab-d3d2c177798d","result":"CLDX_JSONL_OK","usage":{"input_tokens":9,"output_tokens":4},"total_cost_usd":0.01}' \
  >"$headless_initial_stream"
FAKE_CLAUDE_STDOUT_FILE="$headless_initial_stream" \
  "$command_path" --output-format stream-json --verbose -p 'machine output' \
  >"$fixture_root/headless-initial.out" 2>"$fixture_root/headless-initial.err" \
  || fail 'Claude JSONL launch failed'
cmp -s "$headless_initial_stream" "$fixture_root/headless-initial.out" \
  || fail 'Claude JSONL launch changed native stdout'
[[ ! -s "$fixture_root/headless-initial.err" ]] \
  || fail 'Claude JSONL launch wrote unexpected stderr'
jq -se --arg session "$headless_session_id" '
  length == 2
  and all(.[]; type == "object")
  and .[0].type == "system"
  and .[0].subtype == "init"
  and .[0].session_id == $session
  and .[1].type == "result"
  and .[1].subtype == "success"
  and .[1].is_error == false
  and .[1].session_id == $session
  and .[1].result == "CLDX_JSONL_OK"
  and (.[1].usage | type == "object")
  and (.[1].total_cost_usd | type == "number")
' "$fixture_root/headless-initial.out" >/dev/null \
  || fail 'Claude JSONL evidence differs'
jq -s -e '
  .[-1].args == ["--dangerously-skip-permissions", "--permission-mode", "bypassPermissions", "--disallowedTools", "AskUserQuestion", "--model", "claude-opus-5", "--output-format", "stream-json", "--verbose", "-p", "machine output"]
' "$FAKE_CLAUDE_LOG" >/dev/null || fail 'Claude JSONL argument vector differs'

headless_resume_stream="$fixture_root/headless-resume.jsonl"
printf '%s\n' \
  '{"type":"system","subtype":"init","session_id":"5b3664c0-9954-4526-8aab-d3d2c177798d","model":"claude-opus-5"}' \
  '{"type":"result","subtype":"success","is_error":false,"session_id":"5b3664c0-9954-4526-8aab-d3d2c177798d","result":"CLDX_RESUME_OK","usage":{"input_tokens":5,"output_tokens":3},"total_cost_usd":0.006}' \
  >"$headless_resume_stream"
FAKE_CLAUDE_STDOUT_FILE="$headless_resume_stream" \
  "$command_path" --resume "$headless_session_id" \
  --output-format stream-json --verbose -p 'resume output' \
  >"$fixture_root/headless-resume.out" 2>"$fixture_root/headless-resume.err" \
  || fail 'Claude resume-with-prompt launch failed'
jq -se --arg session "$headless_session_id" '
  all(.[]; type == "object")
  and all(.[] | select(.session_id != null); .session_id == $session)
  and .[-1].result == "CLDX_RESUME_OK"
' "$fixture_root/headless-resume.out" >/dev/null \
  || fail 'Claude resume-with-prompt session evidence differs'
jq -s -e --arg session "$headless_session_id" '
  .[-1].args == ["--dangerously-skip-permissions", "--permission-mode", "bypassPermissions", "--disallowedTools", "AskUserQuestion", "--model", "claude-opus-5", "--resume", $session, "--output-format", "stream-json", "--verbose", "-p", "resume output"]
' "$FAKE_CLAUDE_LOG" >/dev/null || fail 'Claude resume-with-prompt argument vector differs'

headless_malformed_stream="$fixture_root/headless-malformed.jsonl"
printf '%s\n' \
  '{"type":"system","subtype":"init","session_id":"5b3664c0-9954-4526-8aab-d3d2c177798d"}' \
  'not-json' >"$headless_malformed_stream"
FAKE_CLAUDE_STDOUT_FILE="$headless_malformed_stream" \
  "$command_path" --output-format stream-json --verbose -p malformed \
  >"$fixture_root/headless-malformed.out" 2>"$fixture_root/headless-malformed.err" \
  || fail 'Claude malformed-output fixture launch failed'
cmp -s "$headless_malformed_stream" "$fixture_root/headless-malformed.out" \
  || fail 'Claude malformed-output fixture changed native stdout'
if jq -se 'all(.[]; type == "object")' "$fixture_root/headless-malformed.out" >/dev/null 2>&1; then
  fail 'malformed Claude output passed JSONL validation'
fi

status=0
FAKE_CLAUDE_EXIT_STATUS=37 "$command_path" -p exit-probe || status=$?
[[ "$status" == 37 ]] || fail "child exit status became $status"

FAKE_CLAUDE_WAIT_FOR_SIGNAL=1 "$command_path" -p signal-probe &
signal_pid=$!
for _attempt in {1..100}; do
  [[ -f "$FAKE_CLAUDE_SIGNAL_LOG" ]] && grep -Fqx READY "$FAKE_CLAUDE_SIGNAL_LOG" \
    && break
  sleep 0.02
done
[[ -f "$FAKE_CLAUDE_SIGNAL_LOG" ]] && grep -Fqx READY "$FAKE_CLAUDE_SIGNAL_LOG" \
  || fail 'Claude signal fixture did not become ready'
kill -TERM "$signal_pid"
status=0
wait "$signal_pid" || status=$?
signal_pid=''
[[ "$status" == 143 ]] || fail "terminated child exited $status instead of 143"
grep -Fqx TERM "$FAKE_CLAUDE_SIGNAL_LOG" \
  || fail 'Claude process did not receive TERM'

"$command_path" doctor >"$fixture_root/doctor.out" || fail 'doctor failed'
grep -Fq 'cldx doctor: OK (2.1.233, claude-opus-5)' "$fixture_root/doctor.out" \
  || fail 'doctor output differs'

no_python_bin="$fixture_root/no-python-bin"
mkdir "$no_python_bin"
for command_name in bash dirname jq readlink; do
  ln -s "$(command -v "$command_name")" "$no_python_bin/$command_name"
done
ln -s "$fake_bin/claude" "$no_python_bin/claude"
PATH="$no_python_bin" /bin/bash "$command_path" doctor >"$fixture_root/python.out" 2>&1 \
  && fail 'doctor accepted missing Python'
grep -Fq 'required command not found: python3' "$fixture_root/python.out" \
  || fail 'missing Python error differs'

FAKE_PROXY_HAS_MODEL=0 "$command_path" doctor >"$fixture_root/model.out" 2>&1 \
  && fail 'doctor accepted missing model'
grep -Fq 'copilot-proxy-rs model is missing: claude-opus-5' "$fixture_root/model.out" \
  || fail 'missing model error differs'

FAKE_PROXY_HEALTH=bad "$command_path" doctor >"$fixture_root/health.out" 2>&1 \
  && fail 'doctor accepted failed proxy health'
grep -Fq 'copilot-proxy-rs health check failed' "$fixture_root/health.out" \
  || fail 'proxy health error differs'

FAKE_PROXY_HEALTH_JSON=invalid "$command_path" doctor \
  >"$fixture_root/health-json.out" 2>&1 \
  && fail 'doctor accepted invalid proxy health JSON'
grep -Fq 'copilot-proxy-rs health response is invalid' "$fixture_root/health-json.out" \
  || fail 'proxy health JSON error differs'

jq '.theme = "light" | .preserve = "user-state" | .hasCompletedOnboarding = false' \
  "$profile_home/.claude.json" >"$fixture_root/onboarding.json"
mv "$fixture_root/onboarding.json" "$profile_home/.claude.json"
jq '.outputStyle = "Explanatory" | .preserve = "user-state"' \
  "$settings" >"$fixture_root/settings.json"
mv "$fixture_root/settings.json" "$settings"
"$command_path" repair >"$fixture_root/repair.out" || fail 'repair failed'
jq -e '
  .hasCompletedOnboarding == true
  and .theme == "light"
  and .preserve == "user-state"
' "$profile_home/.claude.json" >/dev/null || fail 'repair did not preserve user state'
jq -e '
  .outputStyle == "Explanatory"
  and .preserve == "user-state"
  and any(.hooks.SessionStart[]; any(.hooks[]; .command == "user-session-start"))
  and any(.hooks.SessionStart[]; any(.hooks[]; .command == "cccc-session-start"))
  and ([.hooks.SessionStart[]
    | .hooks[]
    | select(.type == "command"
      and (.command | contains(" native-hook --agent claude --profile default")))]
    | length) == 1
' "$settings" >/dev/null || fail 'repair did not preserve Claude settings'
[[ "$(<"$profile_home/unrelated-state")" == preserve ]] \
  || fail 'repair changed unrelated profile state'
settings_hash="$(shasum -a 256 "$settings" | awk '{print $1}')"
"$command_path" repair >"$fixture_root/repair-repeat.out" || fail 'repeat repair failed'
[[ "$(shasum -a 256 "$settings" | awk '{print $1}')" == "$settings_hash" ]] \
  || fail 'repeated repair changed session bridge hook settings'

mv "$fake_bin/claude" "$fake_bin/claude.absent"
"$command_path" doctor >"$fixture_root/missing.out" 2>&1 \
  && fail 'doctor accepted missing Claude Code'
grep -Fq 'required command not found: claude' "$fixture_root/missing.out" \
  || fail 'missing Claude Code error differs'
mv "$fake_bin/claude.absent" "$fake_bin/claude"

mv "$settings" "$fixture_root/valid-settings.json"
ln -s /dev/null "$settings"
"$command_path" repair >"$fixture_root/settings-symlink.out" 2>"$fixture_root/settings-symlink.err" \
  && fail 'repair accepted symlinked Claude settings'
grep -Fq 'unsafe Claude settings' "$fixture_root/settings-symlink.err" \
  || fail 'symlinked Claude settings diagnostic differs'
rm "$settings"
mv "$fixture_root/valid-settings.json" "$settings"
printf '{invalid json\n' >"$settings"
"$command_path" repair >"$fixture_root/settings-invalid.out" 2>"$fixture_root/settings-invalid.err" \
  && fail 'repair accepted invalid Claude settings'
grep -Fq 'invalid Claude settings' "$fixture_root/settings-invalid.err" \
  || fail 'invalid Claude settings diagnostic differs'
grep -Fqx '{invalid json' "$settings" || fail 'invalid Claude settings were replaced'
printf '{}\n{}\n' >"$settings"
"$command_path" repair >"$fixture_root/settings-multiple.out" 2>"$fixture_root/settings-multiple.err" \
  && fail 'repair accepted multiple Claude settings documents'
grep -Fq 'invalid Claude settings' "$fixture_root/settings-multiple.err" \
  || fail 'multiple Claude settings diagnostic differs'
[[ "$(grep -Fxc '{}' "$settings")" == 2 ]] \
  || fail 'multiple Claude settings documents were replaced'
printf '{"outputStyle":"Explanatory","preserve":"user-state"}\n' >"$settings"

rm -f "$output_style"
ln -s /dev/null "$output_style"
"$command_path" repair >"$fixture_root/style-symlink.out" 2>"$fixture_root/style-symlink.err" \
  && fail 'repair accepted a symlinked output style'
grep -Fq 'unsafe managed output style' "$fixture_root/style-symlink.err" \
  || fail 'symlinked output style diagnostic differs'
rm -f "$output_style"
printf 'stale\n' >"$output_style"
"$command_path" repair >"$fixture_root/style-repair.out" || fail 'repair failed'
cmp -s "$output_style" "$root/assets/rundown/rundown.md" \
  || fail 'repair did not refresh the output style'

unrelated_home="$fixture_root/unrelated-home"
mkdir -p "$unrelated_home/.local/bin"
printf 'unrelated\n' >"$unrelated_home/.local/bin/cldx"
HOME="$unrelated_home" "$installer" >"$fixture_root/unrelated.out" 2>&1 \
  && fail 'installer replaced unrelated command'
grep -Fq 'unrelated command' "$fixture_root/unrelated.out" \
  || fail 'unrelated command error differs'

# --- delegation: cldx must actually call the shared native Claude runtime,
# not reimplement its logic. Swap the installed shared runtime for a stub
# and confirm cldx's own output changes accordingly.
native_claude="$runtime_root/lib/native-claude"
export TRELLAGE_CLAUDE_LAUNCHER_NAME=cldx
export TRELLAGE_CLAUDE_RUNTIME_ROOT="$(CDPATH= cd -P -- "$runtime_root" && pwd)"
cp "$native_claude" "$fixture_root/native-claude.real"
cat >"$native_claude" <<'STUB'
#!/usr/bin/env bash
printf 'STUB-INVOKED:%s\n' "$*"
exit 0
STUB
chmod 0755 "$native_claude"
"$command_path" doctor >"$fixture_root/delegation.out" || fail 'delegation stub doctor failed'
grep -Fq 'STUB-INVOKED:doctor --home' "$fixture_root/delegation.out" \
  || fail 'cldx did not delegate doctor to the shared native Claude runtime'
grep -Fq -- '--bridge enabled --profile default' "$fixture_root/delegation.out" \
  || fail 'cldx did not pass --bridge/--profile through to the shared runtime'
cp "$fixture_root/native-claude.real" "$native_claude"
chmod 0755 "$native_claude"
"$command_path" doctor >"$fixture_root/delegation-restored.out" \
  || fail 'doctor failed after restoring the shared native Claude runtime'
grep -Fq 'cldx doctor: OK (2.1.233, claude-opus-5)' "$fixture_root/delegation-restored.out" \
  || fail 'doctor output differs after restoring the shared native Claude runtime'

# --- prepare/doctor must scrub the provider/token environment before
# probing `claude --version`, not only before launch's final exec, since a
# stale tmux/Herdr daemon environment could otherwise leak into that
# earlier child process too. Invoke native-claude directly (not the cldx
# wrapper) so the dump captures exactly prepare's/doctor's own --version
# probe, with no risk of being overwritten by an unrelated later call.
prepare_scrub_dump="$fixture_root/prepare-scrub-dump.txt"
env "${poison_env_assignments[@]}" \
  GH_CONFIG_DIR=/fixture/gh-config-marker \
  FAKE_CLAUDE_ENV_DUMP="$prepare_scrub_dump" \
  "$native_claude" prepare --home "$profile_home" \
  --marker "$profile_root/.managed-by-trellage-claude-profiles" \
  --marker-value trellage-claude-profile-v1 --bridge enabled --profile default \
  --require-existing >"$fixture_root/prepare-scrub-check.out" \
  || fail 'scrub-check prepare failed'
for scrubbed_var in "${scrubbed_var_names[@]}"; do
  grep -q "^${scrubbed_var}=" "$prepare_scrub_dump" \
    && fail "prepare did not scrub $scrubbed_var before probing claude --version"
done
grep -Fqx 'GH_CONFIG_DIR=/fixture/gh-config-marker' "$prepare_scrub_dump" \
  || fail 'prepare scrubbed GH_CONFIG_DIR, which fmx workers rely on for file-backed gh auth'

doctor_scrub_dump="$fixture_root/doctor-scrub-dump.txt"
env "${poison_env_assignments[@]}" \
  GH_CONFIG_DIR=/fixture/gh-config-marker \
  FAKE_CLAUDE_ENV_DUMP="$doctor_scrub_dump" \
  "$native_claude" doctor --home "$profile_home" \
  --marker "$profile_root/.managed-by-trellage-claude-profiles" \
  --marker-value trellage-claude-profile-v1 --bridge enabled --profile default \
  >"$fixture_root/doctor-scrub-check.out" \
  || fail 'scrub-check doctor failed'
for scrubbed_var in "${scrubbed_var_names[@]}"; do
  grep -q "^${scrubbed_var}=" "$doctor_scrub_dump" \
    && fail "doctor did not scrub $scrubbed_var before probing claude --version"
done
grep -Fqx 'GH_CONFIG_DIR=/fixture/gh-config-marker' "$doctor_scrub_dump" \
  || fail 'doctor scrubbed GH_CONFIG_DIR, which fmx workers rely on for file-backed gh auth'

# --- the standalone `version` verb must scrub too: `cldx setup`/`doctor`
# call it after the main operation (via cldx's setup_profile/doctor_profile
# wrappers), so its own `claude --version` child must not inherit a
# poisoned environment either, even though `version` starts no bridge or
# proxy work of its own. `cldx doctor` runs `native-claude doctor` and then
# `native-claude version`, so the dump (last write wins) reflects the
# version verb's own probe specifically.
version_scrub_dump="$fixture_root/version-scrub-dump.txt"
env "${poison_env_assignments[@]}" \
  GH_CONFIG_DIR=/fixture/gh-config-marker \
  FAKE_CLAUDE_ENV_DUMP="$version_scrub_dump" \
  "$command_path" doctor >"$fixture_root/version-scrub-check.out" \
  || fail 'scrub-check cldx doctor (version verb) failed'
for scrubbed_var in "${scrubbed_var_names[@]}"; do
  grep -q "^${scrubbed_var}=" "$version_scrub_dump" \
    && fail "version did not scrub $scrubbed_var before probing claude --version"
done
grep -Fqx 'GH_CONFIG_DIR=/fixture/gh-config-marker' "$version_scrub_dump" \
  || fail 'version scrubbed GH_CONFIG_DIR, which fmx workers rely on for file-backed gh auth'

# --- bridge separation: prepare --bridge disabled must remove exactly the
# Trellage-managed hook and executable, and must never touch unrelated
# SessionStart hook entries.
"$command_path" repair >"$fixture_root/bridge-repair.out" || fail 'repair failed'
bridge_path="$profile_home/.trellage/trellage-session-bridge.py"
jq '.hooks.SessionStart += [
  {"matcher": "*", "hooks": [{"type": "command", "command": "unrelated-user-hook"}]}
]' "$settings" >"$fixture_root/settings-with-unrelated.json"
mv "$fixture_root/settings-with-unrelated.json" "$settings"
[[ -f "$bridge_path" && ! -L "$bridge_path" ]] \
  || fail 'bridge fixture setup: bridge executable missing'
jq -e 'any(.hooks.SessionStart[]; any(.hooks[]; .command == "unrelated-user-hook"))' \
  "$settings" >/dev/null || fail 'bridge fixture setup: unrelated hook missing'

"$native_claude" doctor --home "$profile_home" \
  --marker "$profile_root/.managed-by-trellage-claude-profiles" \
  --marker-value trellage-claude-profile-v1 --bridge disabled --profile default \
  >"$fixture_root/bridge-doctor-mismatch.out" 2>&1 \
  && fail 'doctor accepted --bridge disabled while the bridge was installed'
grep -Fq 'session bridge is still installed' "$fixture_root/bridge-doctor-mismatch.out" \
  || fail 'bridge-still-installed diagnostic differs'

"$native_claude" prepare --home "$profile_home" \
  --marker "$profile_root/.managed-by-trellage-claude-profiles" \
  --marker-value trellage-claude-profile-v1 --bridge disabled --profile default \
  --require-existing >"$fixture_root/bridge-disable.out" \
  || fail 'prepare --bridge disabled failed'
[[ ! -e "$bridge_path" && ! -L "$bridge_path" ]] \
  || fail 'prepare --bridge disabled left the session bridge executable'
jq -e 'any(.hooks.SessionStart[]; any(.hooks[]; .command == "unrelated-user-hook"))' \
  "$settings" >/dev/null \
  || fail 'prepare --bridge disabled removed an unrelated hook'
jq -e '[.hooks.SessionStart[]?.hooks[]?
  | select((.command | contains("native-hook --agent claude --profile default")))]
  | length == 0' "$settings" >/dev/null \
  || fail 'prepare --bridge disabled left the managed session bridge hook'

"$native_claude" doctor --home "$profile_home" \
  --marker "$profile_root/.managed-by-trellage-claude-profiles" \
  --marker-value trellage-claude-profile-v1 --bridge disabled --profile default \
  >"$fixture_root/bridge-doctor-disabled.out" \
  || fail 'doctor rejected a correctly disabled bridge'
"$native_claude" doctor --home "$profile_home" \
  --marker "$profile_root/.managed-by-trellage-claude-profiles" \
  --marker-value trellage-claude-profile-v1 --bridge enabled --profile default \
  >"$fixture_root/bridge-doctor-enabled.out" 2>&1 \
  && fail 'doctor accepted --bridge enabled while the bridge was absent'
grep -Fq 'session bridge is missing' "$fixture_root/bridge-doctor-enabled.out" \
  || fail 'bridge-missing diagnostic differs'

"$command_path" repair >"$fixture_root/bridge-restore.out" || fail 'repair failed to reinstall the bridge'
[[ -f "$bridge_path" && ! -L "$bridge_path" && -x "$bridge_path" ]] \
  || fail 'repair did not reinstall the session bridge executable'
jq -e 'any(.hooks.SessionStart[]; any(.hooks[]; .command == "unrelated-user-hook"))
  and ([.hooks.SessionStart[]?.hooks[]?
    | select((.command | contains("native-hook --agent claude --profile default")))]
    | length) == 1
' "$settings" >/dev/null \
  || fail 'repair did not restore the session bridge hook alongside the unrelated hook'

# --- stale other-profile isolation: a bridge-enabled home must contain
# exactly the current managed hook and no stale managed hook left behind
# for a previously active profile at the same bridge path; a
# bridge-disabled home must contain no managed hook at all, even one that
# records a different stale profile name. Unrelated hooks must survive
# both directions.
# Derive the stale-profile variant from the real installed hook command
# (rather than hand-reconstructing native-claude's shlex-quoting rules
# here), so this stays correct however the bridge_path happens to quote.
current_hook_command="$(jq -r --arg needle 'native-hook --agent claude --profile default' \
  '[.hooks.SessionStart[]?.hooks[]? | select(.command | contains($needle))][0].command' \
  "$settings")"
[[ -n "$current_hook_command" && "$current_hook_command" != null ]] \
  || fail 'stale-profile fixture setup: could not read the current managed hook command'
stale_hook_command="${current_hook_command%default}stale-profile"
jq --arg cmd "$stale_hook_command" '.hooks.SessionStart += [
  {"matcher": "*", "hooks": [{"type": "command", "command": $cmd}]}
]' "$settings" >"$fixture_root/settings-with-stale-profile.json"
mv "$fixture_root/settings-with-stale-profile.json" "$settings"

"$native_claude" doctor --home "$profile_home" \
  --marker "$profile_root/.managed-by-trellage-claude-profiles" \
  --marker-value trellage-claude-profile-v1 --bridge enabled --profile default \
  >"$fixture_root/stale-profile-doctor.out" 2>&1 \
  && fail 'doctor accepted a stale managed hook for another profile'
grep -Fq 'stale session bridge hook for another profile is installed' \
  "$fixture_root/stale-profile-doctor.out" \
  || fail 'stale-other-profile doctor diagnostic differs'

"$native_claude" launch --home "$profile_home" \
  --marker "$profile_root/.managed-by-trellage-claude-profiles" \
  --marker-value trellage-claude-profile-v1 --bridge enabled --profile default \
  -- --version >"$fixture_root/stale-profile-launch.out" 2>"$fixture_root/stale-profile-launch.err" \
  && fail 'launch accepted a stale managed hook for another profile'
grep -Fq 'stale session bridge hook for another profile is installed' \
  "$fixture_root/stale-profile-launch.err" \
  || fail 'stale-other-profile launch diagnostic differs'

"$command_path" repair >"$fixture_root/stale-profile-repair.out" \
  || fail 'repair failed to prune the stale other-profile hook'
jq -e --arg cmd "$stale_hook_command" \
  '[.hooks.SessionStart[]?.hooks[]? | select(.command == $cmd)] | length == 0' \
  "$settings" >/dev/null \
  || fail 'repair left the stale other-profile hook installed'
jq -e 'any(.hooks.SessionStart[]; any(.hooks[]; .command == "unrelated-user-hook"))' \
  "$settings" >/dev/null \
  || fail 'pruning the stale other-profile hook removed an unrelated hook'
jq -e '[.hooks.SessionStart[]?.hooks[]?
  | select((.command | contains("native-hook --agent claude --profile default")))]
  | length == 1' "$settings" >/dev/null \
  || fail 'repair did not leave exactly one current managed hook'

jq --arg cmd "$stale_hook_command" '.hooks.SessionStart += [
  {"matcher": "*", "hooks": [{"type": "command", "command": $cmd}]}
]' "$settings" >"$fixture_root/settings-with-stale-profile-2.json"
mv "$fixture_root/settings-with-stale-profile-2.json" "$settings"
"$native_claude" prepare --home "$profile_home" \
  --marker "$profile_root/.managed-by-trellage-claude-profiles" \
  --marker-value trellage-claude-profile-v1 --bridge disabled --profile default \
  --require-existing >"$fixture_root/stale-profile-disable.out" \
  || fail 'prepare --bridge disabled failed with a stale other-profile hook present'
jq -e '[.hooks.SessionStart[]?.hooks[]?
  | select(.command | contains("native-hook --agent claude --profile"))]
  | length == 0' "$settings" >/dev/null \
  || fail 'prepare --bridge disabled left a managed hook for another profile installed'
jq -e 'any(.hooks.SessionStart[]; any(.hooks[]; .command == "unrelated-user-hook"))' \
  "$settings" >/dev/null \
  || fail 'prepare --bridge disabled removed an unrelated hook while pruning a stale profile'

"$command_path" repair >"$fixture_root/bridge-restore-3.out" || fail 'repair failed to reinstall the bridge'

# --- launch must assert the *full* bridge state (hook presence, not just
# executable presence). A "captain" launch (--bridge enabled) must fail if
# the exact SessionStart hook is missing even though the executable is
# still installed; a "worker" launch (--bridge disabled) must fail if a
# stale matching hook remains even though the executable is gone.
managed_hook_command="$(jq -r --arg needle 'native-hook --agent claude --profile default' \
  '[.hooks.SessionStart[]?.hooks[]? | select(.command | contains($needle))][0].command' \
  "$settings")"
[[ -n "$managed_hook_command" && "$managed_hook_command" != null ]] \
  || fail 'bridge fixture setup: could not read the managed hook command'

cp "$settings" "$fixture_root/settings-before-launch-checks.json"
jq --arg cmd "$managed_hook_command" \
  '.hooks.SessionStart = [.hooks.SessionStart[] | .hooks |= map(select(.command != $cmd))]
   | .hooks.SessionStart |= map(select((.hooks | length) > 0))' \
  "$settings" >"$fixture_root/settings-missing-hook.json"
mv "$fixture_root/settings-missing-hook.json" "$settings"
"$native_claude" launch --home "$profile_home" \
  --marker "$profile_root/.managed-by-trellage-claude-profiles" \
  --marker-value trellage-claude-profile-v1 --bridge enabled --profile default \
  -- --version >"$fixture_root/launch-missing-hook.out" 2>"$fixture_root/launch-missing-hook.err" \
  && fail 'launch accepted a bridge-enabled profile whose SessionStart hook is missing'
grep -Fq 'session bridge hook is missing' "$fixture_root/launch-missing-hook.err" \
  || fail 'launch missing-hook diagnostic differs'
cp "$fixture_root/settings-before-launch-checks.json" "$settings"

rm -f "$bridge_path"
"$native_claude" launch --home "$profile_home" \
  --marker "$profile_root/.managed-by-trellage-claude-profiles" \
  --marker-value trellage-claude-profile-v1 --bridge disabled --profile default \
  -- --version >"$fixture_root/launch-stale-hook.out" 2>"$fixture_root/launch-stale-hook.err" \
  && fail 'launch accepted a bridge-disabled profile with a stale SessionStart hook'
grep -Fq 'session bridge hook is still installed' "$fixture_root/launch-stale-hook.err" \
  || fail 'launch stale-hook diagnostic differs'

"$command_path" repair >"$fixture_root/bridge-restore-2.out" || fail 'repair failed to reinstall the bridge'
[[ -f "$bridge_path" && ! -L "$bridge_path" && -x "$bridge_path" ]] \
  || fail 'repair did not reinstall the session bridge executable after launch checks'

# --- doctor_bridge_state must not silently treat a malformed, missing, or
# symlinked settings.json as "zero managed hooks" in --bridge disabled
# mode. An owned profile always has a settings.json from prepare's
# ensure_settings, so these are fail-closed hardening cases, not normal
# states a well-formed profile can reach.
"$native_claude" prepare --home "$profile_home" \
  --marker "$profile_root/.managed-by-trellage-claude-profiles" \
  --marker-value trellage-claude-profile-v1 --bridge disabled --profile default \
  --require-existing >"$fixture_root/settings-safety-disable.out" \
  || fail 'prepare --bridge disabled failed ahead of settings-safety checks'
cp "$settings" "$fixture_root/settings-before-safety-checks.json"

printf '{invalid json\n' >"$settings"
"$native_claude" doctor --home "$profile_home" \
  --marker "$profile_root/.managed-by-trellage-claude-profiles" \
  --marker-value trellage-claude-profile-v1 --bridge disabled --profile default \
  >"$fixture_root/settings-malformed-json.out" 2>"$fixture_root/settings-malformed-json.err" \
  && fail 'doctor accepted malformed JSON settings as zero managed hooks'
grep -Fq 'invalid Claude settings' "$fixture_root/settings-malformed-json.err" \
  || fail 'malformed-JSON settings diagnostic differs'
grep -Fqx '{invalid json' "$settings" \
  || fail 'malformed-JSON settings check mutated the settings file'
cp "$fixture_root/settings-before-safety-checks.json" "$settings"

jq '.hooks.SessionStart = "not-an-array"' "$settings" \
  >"$fixture_root/settings-malformed-hook-shape.json"
mv "$fixture_root/settings-malformed-hook-shape.json" "$settings"
"$native_claude" doctor --home "$profile_home" \
  --marker "$profile_root/.managed-by-trellage-claude-profiles" \
  --marker-value trellage-claude-profile-v1 --bridge disabled --profile default \
  >"$fixture_root/settings-malformed-shape.out" 2>"$fixture_root/settings-malformed-shape.err" \
  && fail 'doctor accepted a non-array hooks.SessionStart as zero managed hooks'
grep -Fq 'invalid Claude settings' "$fixture_root/settings-malformed-shape.err" \
  || fail 'malformed-hook-shape settings diagnostic differs'
cp "$fixture_root/settings-before-safety-checks.json" "$settings"

# `//` treats a present `false` the same as null/absent, so boolean-false
# shapes at each nesting level must be rejected explicitly rather than
# silently tolerated as "hooks absent".
for false_shape_jq in \
  '.hooks = false' \
  '.hooks.SessionStart = false' \
  '.hooks.SessionStart = [{"matcher": "*", "hooks": false}]'; do
  jq "$false_shape_jq" "$settings" >"$fixture_root/settings-false-shape.json"
  mv "$fixture_root/settings-false-shape.json" "$settings"
  "$native_claude" doctor --home "$profile_home" \
    --marker "$profile_root/.managed-by-trellage-claude-profiles" \
    --marker-value trellage-claude-profile-v1 --bridge disabled --profile default \
    >"$fixture_root/settings-false-shape.out" 2>"$fixture_root/settings-false-shape.err" \
    && fail "doctor accepted a boolean-false shape ($false_shape_jq) as zero managed hooks"
  grep -Fq 'invalid Claude settings' "$fixture_root/settings-false-shape.err" \
    || fail "boolean-false shape ($false_shape_jq) diagnostic differs"
  cp "$fixture_root/settings-before-safety-checks.json" "$settings"
done

rm -f "$settings"
"$native_claude" launch --home "$profile_home" \
  --marker "$profile_root/.managed-by-trellage-claude-profiles" \
  --marker-value trellage-claude-profile-v1 --bridge disabled --profile default \
  -- --version >"$fixture_root/settings-missing.out" 2>"$fixture_root/settings-missing.err" \
  && fail 'launch accepted a missing settings.json as zero managed hooks'
grep -Fq 'Claude settings are missing; run: cldx repair' "$fixture_root/settings-missing.err" \
  || fail 'missing-settings diagnostic differs'
cp "$fixture_root/settings-before-safety-checks.json" "$settings"

mv "$settings" "$fixture_root/settings-before-symlink-safety.json"
ln -s /dev/null "$settings"
"$native_claude" doctor --home "$profile_home" \
  --marker "$profile_root/.managed-by-trellage-claude-profiles" \
  --marker-value trellage-claude-profile-v1 --bridge disabled --profile default \
  >"$fixture_root/settings-symlink-safety.out" 2>"$fixture_root/settings-symlink-safety.err" \
  && fail 'doctor accepted a symlinked settings.json as zero managed hooks'
grep -Fq 'unsafe Claude settings' "$fixture_root/settings-symlink-safety.err" \
  || fail 'symlinked-settings safety diagnostic differs'
rm -f "$settings"
mv "$fixture_root/settings-before-symlink-safety.json" "$settings"

"$command_path" repair >"$fixture_root/bridge-restore-4.out" \
  || fail 'repair failed to reinstall the bridge after settings-safety checks'
[[ -f "$bridge_path" && ! -L "$bridge_path" && -x "$bridge_path" ]] \
  || fail 'repair did not reinstall the session bridge executable after settings-safety checks'

# --- --home itself must be validated, not only the marker's parent chain.
# Replacing the profile home with a symlink must be refused before any
# read/write, for prepare/doctor/launch alike.
symlink_target="$home/symlink-target"
mkdir -p "$symlink_target"
symlinked_home="$home/symlinked-profile-home"
ln -s "$symlink_target" "$symlinked_home"
symlinked_marker="$home/.managed-by-symlinked-profile"
printf 'trellage-claude-profile-v1\n' >"$symlinked_marker"
"$native_claude" doctor --home "$symlinked_home" --marker "$symlinked_marker" \
  --marker-value trellage-claude-profile-v1 --bridge disabled \
  >"$fixture_root/symlinked-home-doctor.out" 2>"$fixture_root/symlinked-home-doctor.err" \
  && fail 'doctor accepted a symlinked --home'
grep -Fq 'unsafe profile home' "$fixture_root/symlinked-home-doctor.err" \
  || fail 'symlinked --home diagnostic differs'
"$native_claude" launch --home "$symlinked_home" --marker "$symlinked_marker" \
  --marker-value trellage-claude-profile-v1 --bridge disabled \
  -- --version >"$fixture_root/symlinked-home-launch.out" 2>"$fixture_root/symlinked-home-launch.err" \
  && fail 'launch accepted a symlinked --home'
grep -Fq 'unsafe profile home' "$fixture_root/symlinked-home-launch.err" \
  || fail 'symlinked --home launch diagnostic differs'

# --- spaced paths: the installed hook .command must shell-quote the bridge
# path/profile exactly like Python's shlex.join/shlex.quote, and disabling
# the bridge must remove only that exact hook, never an unrelated one.
spaced_root="$home/spaced-root"
spaced_home="$spaced_root/spaced profile"
spaced_marker="$spaced_root/.managed-by-spaced-profile"
"$native_claude" prepare --home "$spaced_home" --marker "$spaced_marker" \
  --marker-value trellage-claude-profile-v1 --bridge enabled --profile default \
  >"$fixture_root/spaced-prepare.out" || fail 'prepare with a spaced home path failed'
spaced_settings="$spaced_home/settings.json"
spaced_bridge="$spaced_home/.trellage/trellage-session-bridge.py"
[[ -f "$spaced_bridge" && ! -L "$spaced_bridge" && -x "$spaced_bridge" ]] \
  || fail 'spaced-path prepare did not install the session bridge executable'
# native-claude squeezes redundant slashes out of the hook path before
# quoting it (matching Python's pathlib.Path normalization), so the
# expected command must be squeezed the same way to compare exactly even
# when $TMPDIR itself contains a trailing/doubled slash.
squeezed_spaced_bridge="$spaced_bridge"
squeeze_slash='/'
while [[ "$squeezed_spaced_bridge" == *"$squeeze_slash$squeeze_slash"* ]]; do
  squeezed_spaced_bridge="${squeezed_spaced_bridge//$squeeze_slash$squeeze_slash/$squeeze_slash}"
done
expected_spaced_hook_command="'$squeezed_spaced_bridge' native-hook --agent claude --profile default"
jq -e --arg cmd "$expected_spaced_hook_command" \
  '[.hooks.SessionStart[]?.hooks[]? | select(.command == $cmd)] | length == 1' \
  "$spaced_settings" >/dev/null \
  || fail 'spaced-path prepare did not record the shlex-quoted hook command'

jq '.hooks.SessionStart += [
  {"matcher": "*", "hooks": [{"type": "command", "command": "unrelated-spaced-hook"}]}
]' "$spaced_settings" >"$fixture_root/spaced-settings-with-unrelated.json"
mv "$fixture_root/spaced-settings-with-unrelated.json" "$spaced_settings"

"$native_claude" doctor --home "$spaced_home" --marker "$spaced_marker" \
  --marker-value trellage-claude-profile-v1 --bridge enabled --profile default \
  >"$fixture_root/spaced-doctor.out" \
  || fail 'doctor rejected a correctly enabled bridge at a spaced-path home'

"$native_claude" prepare --home "$spaced_home" --marker "$spaced_marker" \
  --marker-value trellage-claude-profile-v1 --bridge disabled --profile default \
  --require-existing >"$fixture_root/spaced-disable.out" \
  || fail 'prepare --bridge disabled failed at a spaced-path home'
[[ ! -e "$spaced_bridge" && ! -L "$spaced_bridge" ]] \
  || fail 'prepare --bridge disabled left the session bridge executable at a spaced-path home'
jq -e 'any(.hooks.SessionStart[]; any(.hooks[]; .command == "unrelated-spaced-hook"))' \
  "$spaced_settings" >/dev/null \
  || fail 'prepare --bridge disabled removed an unrelated hook at a spaced-path home'
jq -e --arg cmd "$expected_spaced_hook_command" \
  '[.hooks.SessionStart[]?.hooks[]? | select(.command == $cmd)] | length == 0' \
  "$spaced_settings" >/dev/null \
  || fail 'prepare --bridge disabled left the managed session bridge hook at a spaced-path home'

"$uninstaller" >"$fixture_root/uninstall.out" || fail 'uninstall failed'
[[ ! -e "$runtime_root" ]] || fail 'uninstaller left runtime'
[[ ! -e "$command_path" && ! -L "$command_path" ]] || fail 'uninstaller left command'
[[ -d "$profile_home" ]] || fail 'uninstaller removed profile state'

printf 'cldx contract: PASS\n'
