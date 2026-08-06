#!/usr/bin/env bash
set -euo pipefail

root="$(mktemp -d "${TMPDIR:-/tmp}/trellage-claude-entry.XXXXXX")"
trap 'rm -rf "$root"' EXIT

entry="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/runtime-claude-entry.sh"
seed="$root/seed"
runtime="$root/home/.claude"
fake_bin="$root/bin"
mkdir -p "$seed/skills/hyperresearch" "$seed/skills/caveman" "$seed/agents" "$runtime/skills/hyperresearch" "$runtime/skills/user-skill" "$runtime/unrelated" "$fake_bin"
printf 'new skill\n' >"$seed/skills/hyperresearch/SKILL.md"
printf 'ACTIVE EVERY RESPONSE\n' >"$seed/skills/caveman/SKILL.md"
printf 'ACTIVE EVERY RESPONSE\n' >"$seed/CLAUDE.md"
printf 'new agent\n' >"$seed/agents/hyperresearch-browser-fetcher.md"
printf '%s\n' CLAUDE.md skills/caveman/SKILL.md skills/hyperresearch/SKILL.md agents/hyperresearch-browser-fetcher.md | LC_ALL=C sort >"$seed/managed-paths.txt"
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
cat >"$seed/default-onboarding.json" <<'JSON'
{
  "hasCompletedOnboarding": true,
  "lastOnboardingVersion": "2.1.222",
  "theme": "dark",
  "shiftEnterKeyBindingInstalled": true
}
JSON
printf 'old skill\n' >"$runtime/skills/hyperresearch/SKILL.md"
printf 'keep auth\n' >"$runtime/.credentials.json"
printf 'keep history\n' >"$runtime/history.jsonl"
printf 'keep user skill\n' >"$runtime/skills/user-skill/SKILL.md"
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
grep -Fqx 'ACTIVE EVERY RESPONSE' "$runtime/skills/caveman/SKILL.md"
grep -Fqx 'ACTIVE EVERY RESPONSE' "$runtime/CLAUDE.md"
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
jq -e '
  .hasCompletedOnboarding == true
  and .lastOnboardingVersion == "2.1.222"
  and .theme == "dark"
  and .shiftEnterKeyBindingInstalled == true
' "$runtime/.claude.json" >/dev/null
workspace="$(pwd -P)"
jq -e --arg workspace "$workspace" \
  '.projects[$workspace].hasTrustDialogAccepted == true' \
  "$runtime/.claude.json" >/dev/null
grep -Fqx 'keep unrelated' "$runtime/unrelated/file"
grep -Fqx 'keep user skill' "$runtime/skills/user-skill/SKILL.md"
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

native_seed="$root/native-seed"
native_runtime="$root/native-home/.claude"
plugin_root="$native_seed/plugins/cache/social-media-skills/social-media-skills/1.0.0"
mkdir -p "$plugin_root/skills/post-writer" "$native_runtime"
printf '# Post writer\n' >"$plugin_root/skills/post-writer/SKILL.md"
cat >"$native_seed/plugins/installed_plugins.json" <<'JSON'
{
  "version": 2,
  "plugins": {
    "social-media-skills@social-media-skills": [
      {
        "scope": "user",
        "installPath": "/home/agent/.claude/plugins/cache/social-media-skills/social-media-skills/1.0.0",
        "version": "1.0.0",
        "gitCommitSha": "94f72ea2ece388fa30ef49a26fb2e6fd2109e0b1"
      }
    ]
  }
}
JSON
cat >"$native_seed/plugin-marketplaces.json" <<'JSON'
{
  "social-media-skills": {
    "source": {
      "source": "directory",
      "path": "/home/agent/.claude/plugins/cache/social-media-skills/social-media-skills/1.0.0"
    },
    "installLocation": "/home/agent/.claude/plugins/cache/social-media-skills/social-media-skills/1.0.0"
  }
}
JSON
cat >"$native_seed/plugin-settings.json" <<'JSON'
{
  "enabledPlugins": {
    "social-media-skills@social-media-skills": true
  }
}
JSON
cp "$seed/default-settings.json" "$native_seed/default-settings.json"
cp "$seed/default-onboarding.json" "$native_seed/default-onboarding.json"
printf '%s\n' \
  plugins/cache/social-media-skills/social-media-skills/1.0.0/skills/post-writer/SKILL.md \
  plugins/installed_plugins.json | LC_ALL=C sort >"$native_seed/managed-paths.txt"
printf '{"theme":"dark"}\n' >"$native_runtime/settings.json"
mkdir -p "$native_runtime/plugins"
cat >"$native_runtime/plugins/known_marketplaces.json" <<'JSON'
{
  "claude-plugins-official": {
    "source": {
      "source": "github",
      "repo": "anthropics/claude-plugins-official"
    },
    "installLocation": "/home/agent/.claude/plugins/marketplaces/claude-plugins-official"
  }
}
JSON
printf 'keep native auth\n' >"$native_runtime/.credentials.json"
native_warning="$root/native-warning"
PATH="$fake_bin:$PATH" \
TRELLAGE_CLAUDE_SEED_HOME="$native_seed" \
TRELLAGE_CLAUDE_HOME="$native_runtime" \
TRELLAGE_CLAUDE_AUTH_MODE=native \
TRELLAGE_CLAUDE_RUNTIME_MODE=native-plugin \
APIFY_API_TOKEN=apify-sentinel \
GOOGLE_AI_API_KEY=google-sentinel \
CLAUDE_ARGS_OUT="$root/native-args" CLAUDE_CONFIG_OUT="$root/native-config" \
CLAUDE_CONFIG_PATH_OUT="$root/native-config-path" CLAUDE_ENV_OUT="$root/native-env" \
  "$entry" new claude --print hello 2>"$native_warning"
grep -Fqx '# Post writer' \
  "$native_runtime/plugins/cache/social-media-skills/social-media-skills/1.0.0/skills/post-writer/SKILL.md"
grep -Fqx 'keep native auth' "$native_runtime/.credentials.json"
jq -e '
  .theme == "dark"
  and .enabledPlugins["social-media-skills@social-media-skills"] == true
' "$native_runtime/settings.json" >/dev/null
jq -e '
  .["social-media-skills"].source.source == "directory"
  and .["social-media-skills"].source.path
    == "/home/agent/.claude/plugins/cache/social-media-skills/social-media-skills/1.0.0"
  and .["social-media-skills"].installLocation
    == "/home/agent/.claude/plugins/cache/social-media-skills/social-media-skills/1.0.0"
  and .["claude-plugins-official"].source.repo == "anthropics/claude-plugins-official"
' "$native_runtime/plugins/known_marketplaces.json" >/dev/null
grep -Fqx 'APIFY_API_TOKEN=apify-sentinel' "$root/native-env"
grep -Fqx 'GOOGLE_AI_API_KEY=google-sentinel' "$root/native-env"
! grep -Fq -- '--mcp-config' "$root/native-args"
[[ ! -s "$root/native-config" ]]
[[ ! -s "$native_warning" ]]
printf '{"theme":"light","preserve":"user-state"}\n' >"$native_runtime/.claude.json"
PATH="$fake_bin:$PATH" \
TRELLAGE_CLAUDE_SEED_HOME="$native_seed" \
TRELLAGE_CLAUDE_HOME="$native_runtime" \
TRELLAGE_CLAUDE_AUTH_MODE=native \
TRELLAGE_CLAUDE_RUNTIME_MODE=native-plugin \
CLAUDE_ARGS_OUT="$root/native-second-args" CLAUDE_CONFIG_OUT="$root/native-second-config" \
CLAUDE_CONFIG_PATH_OUT="$root/native-second-config-path" CLAUDE_ENV_OUT="$root/native-second-env" \
  "$entry" new claude --print hello
jq -e '
  .hasCompletedOnboarding == true
  and .lastOnboardingVersion == "2.1.222"
  and .theme == "light"
  and .shiftEnterKeyBindingInstalled == true
  and .preserve == "user-state"
' "$native_runtime/.claude.json" >/dev/null
jq -e --arg workspace "$workspace" \
  '.projects[$workspace].hasTrustDialogAccepted == true' \
  "$native_runtime/.claude.json" >/dev/null

hostile_runtime="$root/hostile-home/.claude"
hostile_outside="$root/hostile-outside"
mkdir -p "$hostile_runtime" "$hostile_outside"
ln -s "$hostile_outside" "$hostile_runtime/plugins"
if PATH="$fake_bin:$PATH" \
  TRELLAGE_CLAUDE_SEED_HOME="$native_seed" \
  TRELLAGE_CLAUDE_HOME="$hostile_runtime" \
  TRELLAGE_CLAUDE_AUTH_MODE=native \
  TRELLAGE_CLAUDE_RUNTIME_MODE=native-plugin \
  CLAUDE_ARGS_OUT="$root/hostile-args" CLAUDE_CONFIG_OUT="$root/hostile-config" \
  CLAUDE_CONFIG_PATH_OUT="$root/hostile-config-path" CLAUDE_ENV_OUT="$root/hostile-env" \
  "$entry" new claude --print hello >/dev/null 2>&1; then
  printf 'expected symlinked Claude plugin parent to fail\n' >&2
  exit 1
fi
[[ -z "$(find "$hostile_outside" -mindepth 1 -print -quit)" ]] || {
  printf 'Claude seed synchronization escaped through a parent symlink\n' >&2
  exit 1
}

printf 'claude entry contract: PASS\n'
