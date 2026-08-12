#!/usr/bin/env bash

set -euo pipefail

root="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
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
  printf '2.1.224 (Claude Code)\n'
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

"$installer" >"$fixture_root/reinstall.out" || fail 'repeat install failed'

"$command_path" list >"$fixture_root/list.out" || fail 'list failed'
grep -Fqx $'default\tClaude Code using keyless copilot-proxy-rs with Claude Opus 5 by default.' \
  "$fixture_root/list.out" || fail 'list output differs'

"$command_path" list --json >"$fixture_root/list.json" || fail 'JSON list failed'
jq -e '
  .schemaVersion == 1
  and .launcher == "cldx"
  and .harness == "claude"
  and [.profiles[].name] == ["default"]
  and .profiles[0].source == "anthropics/claude-code"
' "$fixture_root/list.json" >/dev/null || fail 'JSON list differs'

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
  and .lastOnboardingVersion == "2.1.224"
  and .shiftEnterKeyBindingInstalled == true
  and .theme == "dark"
' "$profile_home/.claude.json" >/dev/null || fail 'setup onboarding state differs'

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
grep -Fq 'cldx doctor: OK (2.1.224, claude-opus-5)' "$fixture_root/doctor.out" \
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
"$command_path" repair >"$fixture_root/repair.out" || fail 'repair failed'
jq -e '
  .hasCompletedOnboarding == true
  and .theme == "light"
  and .preserve == "user-state"
' "$profile_home/.claude.json" >/dev/null || fail 'repair did not preserve user state'
[[ "$(<"$profile_home/unrelated-state")" == preserve ]] \
  || fail 'repair changed unrelated profile state'

mv "$fake_bin/claude" "$fake_bin/claude.absent"
"$command_path" doctor >"$fixture_root/missing.out" 2>&1 \
  && fail 'doctor accepted missing Claude Code'
grep -Fq 'required command not found: claude' "$fixture_root/missing.out" \
  || fail 'missing Claude Code error differs'
mv "$fake_bin/claude.absent" "$fake_bin/claude"

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
