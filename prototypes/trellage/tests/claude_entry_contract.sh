#!/usr/bin/env bash
set -euo pipefail

root="$(mktemp -d "${TMPDIR:-/tmp}/trellage-claude-entry.XXXXXX")"
trap 'rm -rf "$root"' EXIT

entry="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/runtime-claude-entry.sh"
seed="$root/seed"
runtime="$root/home/.claude"
fake_bin="$root/bin"
mkdir -p "$seed/skills/hyperresearch" "$seed/agents" "$runtime/skills/hyperresearch" "$runtime/unrelated" "$fake_bin"
printf 'new skill\n' >"$seed/skills/hyperresearch/SKILL.md"
printf 'new agent\n' >"$seed/agents/hyperresearch-browser-fetcher.md"
printf '%s\n' skills/hyperresearch/SKILL.md agents/hyperresearch-browser-fetcher.md | LC_ALL=C sort >"$seed/managed-paths.txt"
cat >"$seed/default-settings.json" <<'JSON'
{
  "permissions": {
    "defaultMode": "bypassPermissions",
    "deny": [
      "EnterPlanMode",
      "ExitPlanMode",
      "NotebookEdit",
      "SendMessage",
      "PushNotification",
      "RemoteTrigger",
      "ReportFindings",
      "ScheduleWakeup",
      "CronCreate",
      "CronDelete",
      "CronList"
    ]
  },
  "skipDangerousModePermissionPrompt": true,
  "disableRemoteControl": true,
  "disableClaudeAiConnectors": true,
  "disableArtifact": true
}
JSON
printf 'old skill\n' >"$runtime/skills/hyperresearch/SKILL.md"
printf 'keep auth\n' >"$runtime/.credentials.json"
printf 'keep history\n' >"$runtime/history.jsonl"
printf 'keep unrelated\n' >"$runtime/unrelated/file"
printf 'skills/hyperresearch/SKILL.md\n' >"$runtime/.trellage-hyperresearch-managed"

cat >"$fake_bin/claude" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$@" >"$CLAUDE_ARGS_OUT"
config=
while (($#)); do
  if [[ "$1" == --mcp-config ]]; then config="$2"; break; fi
  shift
done
if [[ -n "$config" ]]; then
  cp "$config" "$CLAUDE_CONFIG_OUT"
  printf '%s\n' "$config" >"${CLAUDE_CONFIG_PATH_OUT:?}"
else
  : >"$CLAUDE_CONFIG_OUT"
  printf 'none\n' >"${CLAUDE_CONFIG_PATH_OUT:?}"
fi
env | LC_ALL=C sort >"$CLAUDE_ENV_OUT"
if [[ -n "${CLAUDE_CREATE_SESSION_ID-}" ]]; then
  session_dir="$CLAUDE_CONFIG_DIR/projects/test-project"
  mkdir -p "$session_dir"
  jq -nc --arg id "$CLAUDE_CREATE_SESSION_ID" --arg cwd "$PWD" \
    '{type:"user",sessionId:$id,cwd:$cwd}' \
    >"$session_dir/$CLAUDE_CREATE_SESSION_ID.jsonl"
fi
exit "${CLAUDE_EXIT:-0}"
SH
chmod +x "$fake_bin/claude"

args_out="$root/args"
config_out="$root/config"
env_out="$root/env"
PATH="$fake_bin:$PATH" \
TRELLAGE_CLAUDE_SEED_HOME="$seed" \
TRELLAGE_CLAUDE_HOME="$runtime" \
TRELLAGE_CLAUDE_AUTH_MODE=proxy \
PLAYWRIGHT_MCP_EXTENSION_TOKEN=browser-secret \
ANTHROPIC_AUTH_TOKEN=proxy-sentinel \
CLAUDE_ARGS_OUT="$args_out" CLAUDE_CONFIG_OUT="$config_out" CLAUDE_CONFIG_PATH_OUT="$root/config-path" CLAUDE_ENV_OUT="$env_out" \
  "$entry" new claude -- --print hello

grep -Fqx 'new skill' "$runtime/skills/hyperresearch/SKILL.md"
grep -Fqx 'keep auth' "$runtime/.credentials.json"
grep -Fqx 'keep history' "$runtime/history.jsonl"
jq -e '
  .permissions.defaultMode == "bypassPermissions"
  and .permissions.deny == [
    "EnterPlanMode", "ExitPlanMode", "NotebookEdit", "SendMessage",
    "PushNotification", "RemoteTrigger", "ReportFindings", "ScheduleWakeup",
    "CronCreate", "CronDelete", "CronList"
  ]
  and .skipDangerousModePermissionPrompt == true
  and .disableRemoteControl == true
  and .disableClaudeAiConnectors == true
  and .disableArtifact == true
' "$runtime/settings.json" >/dev/null
grep -Fqx 'keep unrelated' "$runtime/unrelated/file"
grep -Fq '"playwright"' "$config_out"
grep -Fq '"obscura"' "$config_out"
! grep -Fq 'browser-secret' "$config_out"
grep -Fq 'PLAYWRIGHT_MCP_EXTENSION_TOKEN=browser-secret' "$env_out"
grep -Fqx -- '--dangerously-skip-permissions' "$args_out"
grep -Fqx -- '--settings' "$args_out"
grep -Fqx -- "$seed/default-settings.json" "$args_out"
grep -Fq -- '--mcp-config' "$args_out"
dangerous_line="$(grep -nFx -- '--dangerously-skip-permissions' "$args_out" | cut -d: -f1)"
settings_line="$(grep -nFx -- '--settings' "$args_out" | cut -d: -f1)"
separator_line="$(grep -nFx -- '--' "$args_out" | cut -d: -f1)"
if [[ "$dangerous_line" -ge "$separator_line" || "$settings_line" -ge "$separator_line" ]]; then
  printf 'managed Claude flags must precede the user argument separator\n' >&2
  exit 1
fi

prompt_args_out="$root/prompt-args"
PATH="$fake_bin:$PATH" \
TRELLAGE_CLAUDE_SEED_HOME="$seed" \
TRELLAGE_CLAUDE_HOME="$runtime" \
TRELLAGE_CLAUDE_AUTH_MODE=proxy \
PLAYWRIGHT_MCP_EXTENSION_TOKEN=prompt-browser-secret \
CLAUDE_CODE_OAUTH_TOKEN=poison-oauth \
ANTHROPIC_API_KEY=poison-api-key \
ANTHROPIC_AUTH_TOKEN=proxy-sentinel \
CLAUDE_ARGS_OUT="$prompt_args_out" CLAUDE_CONFIG_OUT="$root/prompt-config" CLAUDE_CONFIG_PATH_OUT="$root/prompt-config-path" CLAUDE_ENV_OUT="$root/prompt-env" \
  "$entry" prompt claude --profile-argument -- 'hello $(false)'
expected_prompt_args=$'--profile-argument\n-p\nhello $(false)'
[[ "$(tail -n 3 "$prompt_args_out")" == "$expected_prompt_args" ]] || {
  printf 'Claude prompt mode did not use exact native -p argv\n' >&2
  exit 1
}
grep -Fqx 'ANTHROPIC_AUTH_TOKEN=proxy-sentinel' "$root/prompt-env"
! grep -Fq 'CLAUDE_CODE_OAUTH_TOKEN=poison-oauth' "$root/prompt-env"
! grep -Fq 'ANTHROPIC_API_KEY=poison-api-key' "$root/prompt-env"
grep -Fqx 'PLAYWRIGHT_MCP_EXTENSION_TOKEN=prompt-browser-secret' "$root/prompt-env"
! grep -Fq 'prompt-browser-secret' "$prompt_args_out" "$root/prompt-config"
prompt_config_path="$(cat "$root/prompt-config-path")"
[[ ! -e "$prompt_config_path" ]] || {
  printf 'Claude prompt mode did not remove its MCP configuration\n' >&2
  exit 1
}

prompt_status=0
PATH="$fake_bin:$PATH" \
TRELLAGE_CLAUDE_SEED_HOME="$seed" \
TRELLAGE_CLAUDE_HOME="$runtime" \
TRELLAGE_CLAUDE_AUTH_MODE=native \
CLAUDE_CODE_OAUTH_TOKEN=native-sentinel \
CLAUDE_EXIT=31 \
CLAUDE_ARGS_OUT="$root/status-args" CLAUDE_CONFIG_OUT="$root/status-config" CLAUDE_CONFIG_PATH_OUT="$root/status-config-path" CLAUDE_ENV_OUT="$root/status-env" \
  "$entry" prompt claude -- 'status prompt' || prompt_status=$?
[[ "$prompt_status" -eq 31 ]] || {
  printf 'Claude prompt mode changed native status 31 to %s\n' "$prompt_status" >&2
  exit 1
}
grep -Fqx 'CLAUDE_CODE_OAUTH_TOKEN=native-sentinel' "$root/status-env"
status_config_path="$(cat "$root/status-config-path")"
[[ ! -e "$status_config_path" ]] || {
  printf 'Claude failed prompt did not remove its MCP configuration\n' >&2
  exit 1
}

core_runtime="$root/core-home/.claude"
core_status=0
PATH="$fake_bin:$PATH" \
TRELLAGE_CLAUDE_SEED_HOME="$seed" \
TRELLAGE_CLAUDE_HOME="$core_runtime" \
TRELLAGE_CLAUDE_MODE=core \
TRELLAGE_CLAUDE_AUTH_MODE=proxy \
PLAYWRIGHT_MCP_EXTENSION_TOKEN=core-browser-poison \
ANTHROPIC_AUTH_TOKEN=core-proxy-token \
ANTHROPIC_BASE_URL=http://copilot-proxy-rs:8080 \
ANTHROPIC_DEFAULT_OPUS_MODEL=qwen3.6-35b-a3b-local \
ANTHROPIC_DEFAULT_SONNET_MODEL=qwen3.6-35b-a3b-local \
ANTHROPIC_DEFAULT_HAIKU_MODEL=qwen3.6-35b-a3b-local \
CLAUDE_EXIT=37 \
CLAUDE_ARGS_OUT="$root/core-args" CLAUDE_CONFIG_OUT="$root/core-config" \
CLAUDE_CONFIG_PATH_OUT="$root/core-config-path" CLAUDE_ENV_OUT="$root/core-env" \
  "$entry" prompt claude -- 'literal core -p' || core_status=$?
[[ "$core_status" -eq 37 ]] || {
  printf 'Claude core prompt changed native status 37 to %s\n' "$core_status" >&2
  exit 1
}
! grep -Fq -- '--mcp-config' "$root/core-args"
grep -Fqx 'none' "$root/core-config-path"
! grep -Fq 'PLAYWRIGHT_MCP_EXTENSION_TOKEN=' "$root/core-env"
grep -Fqx 'ANTHROPIC_BASE_URL=http://copilot-proxy-rs:8080' "$root/core-env"
grep -Fqx 'ANTHROPIC_DEFAULT_OPUS_MODEL=qwen3.6-35b-a3b-local' "$root/core-env"
grep -Fqx 'ANTHROPIC_DEFAULT_SONNET_MODEL=qwen3.6-35b-a3b-local' "$root/core-env"
grep -Fqx 'ANTHROPIC_DEFAULT_HAIKU_MODEL=qwen3.6-35b-a3b-local' "$root/core-env"
[[ "$(tail -n 2 "$root/core-args")" == $'-p\nliteral core -p' ]]

resume_session_id='5b3664c0-9954-4526-8aab-d3d2c177798d'
PATH="$fake_bin:$PATH" \
TRELLAGE_CLAUDE_SEED_HOME="$seed" \
TRELLAGE_CLAUDE_HOME="$core_runtime" \
TRELLAGE_CLAUDE_MODE=core \
TRELLAGE_CLAUDE_AUTH_MODE=proxy \
TRELLAGE_RESUME_SESSION_ID="$resume_session_id" \
ANTHROPIC_AUTH_TOKEN=core-proxy-token \
CLAUDE_ARGS_OUT="$root/resume-args" CLAUDE_CONFIG_OUT="$root/resume-config" \
CLAUDE_CONFIG_PATH_OUT="$root/resume-config-path" CLAUDE_ENV_OUT="$root/resume-env" \
  "$entry" resume claude
[[ "$(tail -n 2 "$root/resume-args")" == $'--resume\n'"$resume_session_id" ]] || {
  printf 'Claude exact resume did not use native --resume ID argv\n' >&2
  exit 1
}

hint_output="$root/resume-hint-output"
PATH="$fake_bin:$PATH" \
TRELLAGE_CLAUDE_SEED_HOME="$seed" \
TRELLAGE_CLAUDE_HOME="$core_runtime" \
TRELLAGE_CLAUDE_MODE=core \
TRELLAGE_CLAUDE_AUTH_MODE=proxy \
TRELLAGE_RESUME_PROFILE=/tmp/claude-qwen-local/profile.toml \
CLAUDE_CREATE_SESSION_ID="$resume_session_id" \
ANTHROPIC_AUTH_TOKEN=core-proxy-token \
CLAUDE_ARGS_OUT="$root/hint-args" CLAUDE_CONFIG_OUT="$root/hint-config" \
CLAUDE_CONFIG_PATH_OUT="$root/hint-config-path" CLAUDE_ENV_OUT="$root/hint-env" \
  "$entry" new claude --test-interactive >"$hint_output"
grep -Fqx 'Resume this conversation:' "$hint_output" || {
  printf 'Claude exit did not print resume guidance\n' >&2
  exit 1
}
grep -Fqx \
  "trellage resume --profile /tmp/claude-qwen-local/profile.toml $resume_session_id" \
  "$hint_output" || {
  printf 'Claude exit did not print exact Trellage resume command\n' >&2
  exit 1
}

no_token_config="$root/no-token-config"
warning="$root/warning"
printf 'keep settings\n' >"$runtime/settings.json"
PATH="$fake_bin:$PATH" \
TRELLAGE_CLAUDE_SEED_HOME="$seed" \
TRELLAGE_CLAUDE_HOME="$runtime" \
TRELLAGE_CLAUDE_AUTH_MODE=native \
CLAUDE_ARGS_OUT="$root/no-token-args" CLAUDE_CONFIG_OUT="$no_token_config" CLAUDE_CONFIG_PATH_OUT="$root/no-token-config-path" CLAUDE_ENV_OUT="$root/no-token-env" \
  "$entry" new claude --print hello 2>"$warning"
! grep -Fq '"playwright"' "$no_token_config"
grep -Fq '"obscura"' "$no_token_config"
grep -Fq 'Playwright extension token is absent' "$warning"
grep -Fqx 'keep settings' "$runtime/settings.json"

printf 'before rollback\n' >"$runtime/skills/hyperresearch/SKILL.md"
printf 'skills/hyperresearch/missing.md\n' >"$seed/managed-paths.txt"
if PATH="$fake_bin:$PATH" \
  TRELLAGE_CLAUDE_SEED_HOME="$seed" TRELLAGE_CLAUDE_HOME="$runtime" \
  TRELLAGE_CLAUDE_AUTH_MODE=native \
  CLAUDE_ARGS_OUT="$root/fail-args" CLAUDE_CONFIG_OUT="$root/fail-config" CLAUDE_CONFIG_PATH_OUT="$root/fail-config-path" CLAUDE_ENV_OUT="$root/fail-env" \
  "$entry" new claude --print hello >/dev/null 2>&1; then
  printf 'expected invalid managed seed to fail\n' >&2
  exit 1
fi
grep -Fqx 'before rollback' "$runtime/skills/hyperresearch/SKILL.md"
grep -Fqx 'keep settings' "$runtime/settings.json"

printf 'claude entry contract: PASS\n'
