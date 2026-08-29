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
  printf '%s (Claude Code)\n' "${FAKE_CLAUDE_VERSION:-2.1.233}"
  exit 0
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
jq -e '.outputStyle == "Rundown"' "$settings" >/dev/null \
  || fail 'setup Claude output style differs'

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
' "$settings" >/dev/null || fail 'repair did not preserve Claude settings'
[[ "$(<"$profile_home/unrelated-state")" == preserve ]] \
  || fail 'repair changed unrelated profile state'

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

"$uninstaller" >"$fixture_root/uninstall.out" || fail 'uninstall failed'
[[ ! -e "$runtime_root" ]] || fail 'uninstaller left runtime'
[[ ! -e "$command_path" && ! -L "$command_path" ]] || fail 'uninstaller left command'
[[ -d "$profile_home" ]] || fail 'uninstaller removed profile state'

printf 'cldx contract: PASS\n'
