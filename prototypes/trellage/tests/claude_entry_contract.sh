#!/usr/bin/env bash
set -euo pipefail

root="$(mktemp -d "${TMPDIR:-/tmp}/trellage-claude-entry.XXXXXX")"
trap 'rm -rf "$root"' EXIT

file_mode() {
  local path="$1"
  if stat -c '%a' "$path" >/dev/null 2>&1; then
    stat -c '%a' "$path"
  else
    stat -f '%Lp' "$path"
  fi
}

default_entry="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/runtime-claude-entry.sh"
entry="${TRELLAGE_CLAUDE_ENTRY_UNDER_TEST:-$default_entry}"
real_cp="$(command -v cp)"
real_mv="$(command -v mv)"
real_tar="$(command -v tar)"
seed="$root/seed"
runtime="$root/home/.claude"
fake_bin="$root/bin"
mkdir -p "$seed/skills/hyperresearch" "$seed/skills/caveman" "$seed/agents" "$runtime/skills/hyperresearch" "$runtime/skills/user-skill" "$runtime/unrelated" "$fake_bin"
grep -Fq 'local bridge=/usr/local/bin/trellage-session-bridge' "$entry"
grep -Fq -- '--mode sandbox' "$entry"
grep -Fq -- '--agent claude' "$entry"
printf 'new skill\n' >"$seed/skills/hyperresearch/SKILL.md"
printf 'ACTIVE EVERY RESPONSE\n' >"$seed/skills/caveman/SKILL.md"
printf 'ACTIVE EVERY RESPONSE\n' >"$seed/CLAUDE.md"
printf 'new agent\n' >"$seed/agents/hyperresearch-browser-fetcher.md"
chmod 755 "$seed/agents/hyperresearch-browser-fetcher.md"
printf '%s\n' CLAUDE.md skills/caveman/SKILL.md skills/hyperresearch/SKILL.md agents/hyperresearch-browser-fetcher.md | LC_ALL=C sort >"$seed/managed-paths.txt"
cp "$seed/managed-paths.txt" "$root/base-managed-paths.txt"
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
cat >"$seed/default-user-settings.json" <<'JSON'
{
  "outputStyle": "Rundown"
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
mkdir "$runtime/.trellage-claude-transaction.stale"
printf 'stale transaction\n' >"$runtime/.trellage-claude-transaction.stale/partial"

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
[[ "$(file_mode "$runtime/skills/hyperresearch/SKILL.md")" == 600 ]]
[[ "$(file_mode "$runtime/agents/hyperresearch-browser-fetcher.md")" == 700 ]]
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
  and .outputStyle == "Rundown"
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
[[ ! -e "$runtime/.trellage-claude-transaction.stale" ]]
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

resume_prompt_args_out="$root/resume-prompt-args"
PATH="$fake_bin:$PATH" \
TRELLAGE_CLAUDE_SEED_HOME="$seed" \
TRELLAGE_CLAUDE_HOME="$core_runtime" \
TRELLAGE_CLAUDE_MODE=core \
TRELLAGE_CLAUDE_AUTH_MODE=proxy \
TRELLAGE_RESUME_SESSION_ID="$resume_session_id" \
ANTHROPIC_AUTH_TOKEN=core-proxy-token \
CLAUDE_ARGS_OUT="$resume_prompt_args_out" CLAUDE_CONFIG_OUT="$root/resume-prompt-config" \
CLAUDE_CONFIG_PATH_OUT="$root/resume-prompt-config-path" CLAUDE_ENV_OUT="$root/resume-prompt-env" \
  "$entry" resume-prompt claude -- 'continuation text'
expected_resume_prompt_args=$'--resume\n'"$resume_session_id"$'\n-p\ncontinuation text'
[[ "$(tail -n 4 "$resume_prompt_args_out")" == "$expected_resume_prompt_args" ]] || {
  printf 'Claude resume-prompt mode did not use exact native --resume ID -p argv\n' >&2
  exit 1
}

jsonl_args_out="$root/jsonl-args"
jsonl_hint_out="$root/jsonl-hint-output"
PATH="$fake_bin:$PATH" \
TRELLAGE_CLAUDE_SEED_HOME="$seed" \
TRELLAGE_CLAUDE_HOME="$core_runtime" \
TRELLAGE_CLAUDE_MODE=core \
TRELLAGE_CLAUDE_AUTH_MODE=proxy \
TRELLAGE_OUTPUT_FORMAT=jsonl \
TRELLAGE_RESUME_PROFILE=/tmp/claude-qwen-local/profile.toml \
CLAUDE_CREATE_SESSION_ID="$resume_session_id" \
ANTHROPIC_AUTH_TOKEN=core-proxy-token \
CLAUDE_ARGS_OUT="$jsonl_args_out" CLAUDE_CONFIG_OUT="$root/jsonl-config" \
CLAUDE_CONFIG_PATH_OUT="$root/jsonl-config-path" CLAUDE_ENV_OUT="$root/jsonl-env" \
  "$entry" new claude --test-interactive >"$jsonl_hint_out"
grep -Fqx -- '--output-format' "$jsonl_args_out"
grep -Fqx -- 'stream-json' "$jsonl_args_out"
grep -Fqx -- '--verbose' "$jsonl_args_out"
[[ ! -s "$jsonl_hint_out" ]] || {
  printf 'Claude jsonl output format printed resume guidance\n' >&2
  exit 1
}

if PATH="$fake_bin:$PATH" \
  TRELLAGE_CLAUDE_SEED_HOME="$seed" \
  TRELLAGE_CLAUDE_HOME="$core_runtime" \
  TRELLAGE_CLAUDE_MODE=core \
  TRELLAGE_CLAUDE_AUTH_MODE=proxy \
  TRELLAGE_OUTPUT_FORMAT=unsupported \
  ANTHROPIC_AUTH_TOKEN=core-proxy-token \
  CLAUDE_ARGS_OUT="$root/unsupported-args" CLAUDE_CONFIG_OUT="$root/unsupported-config" \
  CLAUDE_CONFIG_PATH_OUT="$root/unsupported-config-path" CLAUDE_ENV_OUT="$root/unsupported-env" \
  "$entry" new claude >/dev/null 2>&1; then
  printf 'expected unsupported TRELLAGE_OUTPUT_FORMAT to fail\n' >&2
  exit 1
fi

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
jq '.outputStyle = "Explanatory" | .preserve = "user-state"' \
  "$runtime/settings.json" >"$root/user-settings.json"
mv "$root/user-settings.json" "$runtime/settings.json"
PATH="$fake_bin:$PATH" \
TRELLAGE_CLAUDE_SEED_HOME="$seed" \
TRELLAGE_CLAUDE_HOME="$runtime" \
TRELLAGE_CLAUDE_AUTH_MODE=native \
CLAUDE_ARGS_OUT="$root/no-token-args" CLAUDE_CONFIG_OUT="$no_token_config" CLAUDE_CONFIG_PATH_OUT="$root/no-token-config-path" CLAUDE_ENV_OUT="$root/no-token-env" \
  "$entry" new claude --print hello 2>"$warning"
! grep -Fq '"playwright"' "$no_token_config"
grep -Fq '"obscura"' "$no_token_config"
grep -Fq 'Playwright extension token is absent' "$warning"
jq -e '
  .outputStyle == "Explanatory"
  and .preserve == "user-state"
' "$runtime/settings.json" >/dev/null

cp "$runtime/settings.json" "$root/valid-settings.json"
printf '{invalid json\n' >"$runtime/settings.json"
if PATH="$fake_bin:$PATH" \
  TRELLAGE_CLAUDE_SEED_HOME="$seed" TRELLAGE_CLAUDE_HOME="$runtime" \
  TRELLAGE_CLAUDE_AUTH_MODE=native \
  CLAUDE_ARGS_OUT="$root/invalid-settings-args" CLAUDE_CONFIG_OUT="$root/invalid-settings-config" \
  CLAUDE_CONFIG_PATH_OUT="$root/invalid-settings-config-path" CLAUDE_ENV_OUT="$root/invalid-settings-env" \
  "$entry" new claude --print hello >"$root/invalid-settings.out" 2>"$root/invalid-settings.err"; then
  printf 'expected invalid Claude settings to fail\n' >&2
  exit 1
fi
grep -Fq 'Claude settings are invalid' "$root/invalid-settings.err"
grep -Fqx '{invalid json' "$runtime/settings.json"
mv "$root/valid-settings.json" "$runtime/settings.json"

cp "$runtime/settings.json" "$root/valid-settings.json"
printf '{}\n{}\n' >"$runtime/settings.json"
if PATH="$fake_bin:$PATH" \
  TRELLAGE_CLAUDE_SEED_HOME="$seed" TRELLAGE_CLAUDE_HOME="$runtime" \
  TRELLAGE_CLAUDE_AUTH_MODE=native \
  CLAUDE_ARGS_OUT="$root/multiple-settings-args" CLAUDE_CONFIG_OUT="$root/multiple-settings-config" \
  CLAUDE_CONFIG_PATH_OUT="$root/multiple-settings-config-path" CLAUDE_ENV_OUT="$root/multiple-settings-env" \
  "$entry" new claude --print hello >"$root/multiple-settings.out" 2>"$root/multiple-settings.err"; then
  printf 'expected multiple Claude settings documents to fail\n' >&2
  exit 1
fi
grep -Fq 'Claude settings are invalid' "$root/multiple-settings.err"
if [[ "$(grep -Fxc '{}' "$runtime/settings.json")" != 2 ]]; then
  printf 'multiple Claude settings documents were replaced\n' >&2
  exit 1
fi
mv "$root/valid-settings.json" "$runtime/settings.json"

mv "$runtime/settings.json" "$root/valid-settings.json"
ln -s "$root/valid-settings.json" "$runtime/settings.json"
if PATH="$fake_bin:$PATH" \
  TRELLAGE_CLAUDE_SEED_HOME="$seed" TRELLAGE_CLAUDE_HOME="$runtime" \
  TRELLAGE_CLAUDE_AUTH_MODE=native \
  CLAUDE_ARGS_OUT="$root/symlink-settings-args" CLAUDE_CONFIG_OUT="$root/symlink-settings-config" \
  CLAUDE_CONFIG_PATH_OUT="$root/symlink-settings-config-path" CLAUDE_ENV_OUT="$root/symlink-settings-env" \
  "$entry" new claude --print hello >"$root/symlink-settings.out" 2>"$root/symlink-settings.err"; then
  printf 'expected symlinked Claude settings to fail\n' >&2
  exit 1
fi
grep -Fq 'Claude settings must be a regular file' "$root/symlink-settings.err"
[[ -L "$runtime/settings.json" ]]
rm "$runtime/settings.json"
mv "$root/valid-settings.json" "$runtime/settings.json"

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
jq -e '
  .outputStyle == "Explanatory"
  and .preserve == "user-state"
' "$runtime/settings.json" >/dev/null

cp "$root/base-managed-paths.txt" "$seed/managed-paths.txt"
printf 'replacement that must roll back\n' >"$seed/skills/hyperresearch/SKILL.md"
printf 'replacement root instructions\n' >"$seed/CLAUDE.md"
fail_tar_bin="$root/fail-tar-bin"
mkdir -p "$fail_tar_bin"
cat >"$fail_tar_bin/tar" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
destination=
extract=false
args=("$@")
for ((index = 0; index < ${#args[@]}; index++)); do
  if [[ "${args[$index]}" == -C ]]; then
    ((index += 1))
    destination="${args[$index]}"
  elif [[ "${args[$index]}" == -xf && "${args[$((index + 1))]-}" == - ]]; then
    extract=true
  fi
done
if [[ "$extract" == true && ! -e "${TRELLAGE_TEST_FAIL_TAR_MARKER:?}" ]]; then
  case "$destination" in
    "${TRELLAGE_TEST_FAIL_TAR_DEST:?}")
      : >"${TRELLAGE_TEST_DIRECT_TAR_MARKER:?}"
      ;;
    "${TRELLAGE_TEST_FAIL_TAR_DEST:?}"/.trellage-claude-transaction.*/.managed-runtime-copy.*)
      ;;
    *)
      exec "$TRELLAGE_TEST_REAL_TAR" "$@"
      ;;
  esac
  : >"$TRELLAGE_TEST_FAIL_TAR_MARKER"
  if [[ -n "${TRELLAGE_TEST_TAR_COLLISION_PATH:-}" ]]; then
    printf 'concurrent collision\n' >"$TRELLAGE_TEST_TAR_COLLISION_PATH"
  fi
  "$TRELLAGE_TEST_REAL_TAR" "$@" "${TRELLAGE_TEST_FAIL_TAR_MEMBER:?}"
  exit 73
fi
exec "$TRELLAGE_TEST_REAL_TAR" "$@"
SH
chmod +x "$fail_tar_bin/tar"
if PATH="$fail_tar_bin:$fake_bin:$PATH" \
  TRELLAGE_TEST_REAL_TAR="$real_tar" \
  TRELLAGE_TEST_FAIL_TAR_DEST="$runtime" \
  TRELLAGE_TEST_FAIL_TAR_MARKER="$root/fail-tar-marker" \
  TRELLAGE_TEST_DIRECT_TAR_MARKER="$root/direct-tar-marker" \
  TRELLAGE_TEST_FAIL_TAR_MEMBER=CLAUDE.md \
  TRELLAGE_CLAUDE_SEED_HOME="$seed" TRELLAGE_CLAUDE_HOME="$runtime" \
  TRELLAGE_CLAUDE_AUTH_MODE=native \
  CLAUDE_ARGS_OUT="$root/tar-fail-args" CLAUDE_CONFIG_OUT="$root/tar-fail-config" \
  CLAUDE_CONFIG_PATH_OUT="$root/tar-fail-config-path" CLAUDE_ENV_OUT="$root/tar-fail-env" \
  "$entry" new claude --print hello >"$root/tar-fail.out" 2>"$root/tar-fail.err"; then
  printf 'expected bulk Claude seed extraction to fail\n' >&2
  exit 1
fi
[[ -f "$root/fail-tar-marker" ]]
[[ ! -e "$root/direct-tar-marker" ]] \
  || { printf 'managed Claude files were extracted directly to final paths\n' >&2; exit 1; }
grep -Fqx 'before rollback' "$runtime/skills/hyperresearch/SKILL.md"
grep -Fqx 'ACTIVE EVERY RESPONSE' "$runtime/CLAUDE.md"
cmp -s "$root/base-managed-paths.txt" "$runtime/.trellage-claude-managed"
[[ ! -e "$runtime/.trellage-claude.lock" ]]
[[ -z "$(find "$runtime" -maxdepth 1 -name '.trellage-claude-transaction.*' -print -quit)" ]]

rm -f -- "$root/fail-tar-marker" "$root/direct-tar-marker"
if PATH="$fail_tar_bin:$fake_bin:$PATH" \
  TRELLAGE_TEST_REAL_TAR="$real_tar" \
  TRELLAGE_TEST_FAIL_TAR_DEST="$runtime" \
  TRELLAGE_TEST_FAIL_TAR_MARKER="$root/fail-tar-marker" \
  TRELLAGE_TEST_DIRECT_TAR_MARKER="$root/direct-tar-marker" \
  TRELLAGE_TEST_FAIL_TAR_MEMBER=CLAUDE.md \
  TRELLAGE_TEST_TAR_COLLISION_PATH="$runtime/CLAUDE.md" \
  TRELLAGE_CLAUDE_SEED_HOME="$seed" TRELLAGE_CLAUDE_HOME="$runtime" \
  TRELLAGE_CLAUDE_AUTH_MODE=native \
  CLAUDE_ARGS_OUT="$root/restore-fail-args" CLAUDE_CONFIG_OUT="$root/restore-fail-config" \
  CLAUDE_CONFIG_PATH_OUT="$root/restore-fail-config-path" CLAUDE_ENV_OUT="$root/restore-fail-env" \
  "$entry" new claude --print hello >"$root/restore-fail.out" 2>"$root/restore-fail.err"; then
  printf 'expected managed-file collision rollback to fail\n' >&2
  exit 1
fi
grep -Fqx 'concurrent collision' "$runtime/CLAUDE.md"
grep -Fqx 'before rollback' "$runtime/skills/hyperresearch/SKILL.md" \
  || { printf 'rollback stopped after one managed-file restore collision\n' >&2; exit 1; }
[[ ! -e "$runtime/.trellage-claude.lock" ]]
restore_transaction="$(
  find "$runtime" -mindepth 1 -maxdepth 1 \
    -name '.trellage-claude-transaction.*' -type d -print -quit
)"
[[ -n "$restore_transaction" ]] \
  || { printf 'incomplete managed restore did not retain its transaction\n' >&2; exit 1; }
[[ -f "$restore_transaction/transaction-journal" ]]
grep -Fqx 'ACTIVE EVERY RESPONSE' "$restore_transaction/managed-backup/CLAUDE.md"
if PATH="$fake_bin:$PATH" \
  TRELLAGE_CLAUDE_SEED_HOME="$seed" TRELLAGE_CLAUDE_HOME="$runtime" \
  TRELLAGE_CLAUDE_AUTH_MODE=native \
  CLAUDE_ARGS_OUT="$root/restore-retry-args" \
  CLAUDE_CONFIG_OUT="$root/restore-retry-config" \
  CLAUDE_CONFIG_PATH_OUT="$root/restore-retry-config-path" \
  CLAUDE_ENV_OUT="$root/restore-retry-env" \
  "$entry" new claude --print hello >"$root/restore-retry.out" 2>"$root/restore-retry.err"; then
  printf 'expected incomplete managed restore to fail closed\n' >&2
  exit 1
fi
grep -Fq \
  "incomplete Claude rollback requires manual recovery: $restore_transaction" \
  "$root/restore-retry.err"
rm -rf -- "$restore_transaction"
printf 'ACTIVE EVERY RESPONSE\n' >"$runtime/CLAUDE.md"
printf 'new skill\n' >"$seed/skills/hyperresearch/SKILL.md"
printf 'ACTIVE EVERY RESPONSE\n' >"$seed/CLAUDE.md"

core_seed="$root/core-seed"
core_runtime="$root/core-home/.claude"
mkdir -p "$core_seed/output-styles" "$core_runtime"
cp "$seed/default-settings.json" "$core_seed/default-settings.json"
cp "$seed/default-user-settings.json" "$core_seed/default-user-settings.json"
cp "$seed/default-onboarding.json" "$core_seed/default-onboarding.json"
printf 'Rundown\n' >"$core_seed/output-styles/rundown.md"
printf 'output-styles/rundown.md\n' >"$core_seed/managed-paths.txt"
printf '{"enabledPlugins":[]}\n' >"$core_seed/plugin-settings.json"
printf '{"outputStyle":"Explanatory","preserve":"core-user-state"}\n' \
  >"$core_runtime/settings.json"
cp "$core_runtime/settings.json" "$root/core-settings.before"
rollback_race_hook="$root/rollback-race-hook.cjs"
cat >"$rollback_race_hook" <<'JS'
const fs = require('node:fs')
const path = require('node:path')

const target = path.resolve(process.env.TRELLAGE_TEST_ROLLBACK_RACE_PATH)
const marker = path.resolve(process.env.TRELLAGE_TEST_ROLLBACK_RACE_MARKER)
const originalRenameSync = fs.renameSync.bind(fs)

fs.renameSync = (source, destination) => {
  if (
    path.resolve(source) === target &&
    destination.includes(`${path.sep}rollback-removed${path.sep}`) &&
    !fs.existsSync(marker)
  ) {
    const replacement = `${target}.concurrent-replacement`
    fs.writeFileSync(replacement, 'concurrent rollback replacement\n')
    originalRenameSync(replacement, target)
    fs.writeFileSync(marker, '')
  }
  return originalRenameSync(source, destination)
}
JS
if PATH="$fake_bin:$PATH" \
  NODE_OPTIONS="--require=$rollback_race_hook" \
  TRELLAGE_TEST_ROLLBACK_RACE_PATH="$core_runtime/output-styles/rundown.md" \
  TRELLAGE_TEST_ROLLBACK_RACE_MARKER="$root/rollback-race-marker" \
  TRELLAGE_CLAUDE_SEED_HOME="$core_seed" TRELLAGE_CLAUDE_HOME="$core_runtime" \
  TRELLAGE_CLAUDE_MODE=core TRELLAGE_CLAUDE_RUNTIME_MODE=core \
  TRELLAGE_CLAUDE_AUTH_MODE=native \
  CLAUDE_ARGS_OUT="$root/core-rollback-args" CLAUDE_CONFIG_OUT="$root/core-rollback-config" \
  CLAUDE_CONFIG_PATH_OUT="$root/core-rollback-config-path" CLAUDE_ENV_OUT="$root/core-rollback-env" \
  "$entry" new claude --print hello >"$root/core-rollback.out" 2>"$root/core-rollback.err"; then
  printf 'expected core Claude settings transaction to fail\n' >&2
  exit 1
fi
grep -Fq 'baked Claude plugin settings are invalid' "$root/core-rollback.err"
cmp -s "$root/core-settings.before" "$core_runtime/settings.json"
[[ -f "$root/rollback-race-marker" ]] \
  || { printf 'rollback did not quarantine the checked managed path\n' >&2; exit 1; }
grep -Fqx 'concurrent rollback replacement' "$core_runtime/output-styles/rundown.md"
core_recovery="$(
  find "$core_runtime" -mindepth 1 -maxdepth 1 \
    -name '.trellage-claude-recovery.*' -type d -print -quit
)"
[[ -n "$core_recovery" ]]
grep -Fqx 'concurrent rollback replacement' "$core_recovery/output-styles/rundown.md"
grep -Fq 'preserved concurrent path output-styles/rundown.md' "$root/core-rollback.err"
[[ -z "$(find "$core_runtime" -maxdepth 1 -name '.trellage-claude-transaction.*' -print -quit)" ]]

snapshot_seed="$root/snapshot-seed"
snapshot_runtime="$root/snapshot-home/.claude"
mkdir -p "$snapshot_seed/output-styles" "$snapshot_runtime/output-styles"
cp "$seed/default-settings.json" "$snapshot_seed/default-settings.json"
cp "$seed/default-user-settings.json" "$snapshot_seed/default-user-settings.json"
cp "$seed/default-onboarding.json" "$snapshot_seed/default-onboarding.json"
printf 'new snapshot content\n' >"$snapshot_seed/output-styles/rundown.md"
printf 'output-styles/rundown.md\n' >"$snapshot_seed/managed-paths.txt"
printf '{"enabledPlugins":{}}\n' >"$snapshot_seed/plugin-settings.json"
printf 'pre-transaction snapshot\n' >"$snapshot_runtime/output-styles/rundown.md"
printf 'output-styles/rundown.md\n' >"$snapshot_runtime/.trellage-claude-managed"
printf '{"outputStyle":"Explanatory","preserve":"snapshot-user-state"}\n' \
  >"$snapshot_runtime/settings.json"
snapshot_race_hook="$root/snapshot-race-hook.cjs"
cat >"$snapshot_race_hook" <<'JS'
const fs = require('node:fs')
const path = require('node:path')

const target = path.resolve(process.env.TRELLAGE_TEST_SNAPSHOT_RACE_PATH)
const marker = path.resolve(process.env.TRELLAGE_TEST_SNAPSHOT_RACE_MARKER)
const originalRenameSync = fs.renameSync.bind(fs)

fs.renameSync = (source, destination) => {
  if (
    path.resolve(source) === target &&
    destination.includes(`${path.sep}prior-removed${path.sep}`) &&
    !fs.existsSync(marker)
  ) {
    fs.writeFileSync(target, 'concurrent in-place edit\n')
    fs.writeFileSync(marker, '')
  }
  return originalRenameSync(source, destination)
}
JS
if PATH="$fake_bin:$PATH" \
  NODE_OPTIONS="--require=$snapshot_race_hook" \
  TRELLAGE_TEST_SNAPSHOT_RACE_PATH="$snapshot_runtime/output-styles/rundown.md" \
  TRELLAGE_TEST_SNAPSHOT_RACE_MARKER="$root/snapshot-race-marker" \
  TRELLAGE_CLAUDE_SEED_HOME="$snapshot_seed" TRELLAGE_CLAUDE_HOME="$snapshot_runtime" \
  TRELLAGE_CLAUDE_MODE=core TRELLAGE_CLAUDE_RUNTIME_MODE=core \
  TRELLAGE_CLAUDE_AUTH_MODE=native \
  CLAUDE_ARGS_OUT="$root/snapshot-race-args" \
  CLAUDE_CONFIG_OUT="$root/snapshot-race-config" \
  CLAUDE_CONFIG_PATH_OUT="$root/snapshot-race-config-path" \
  CLAUDE_ENV_OUT="$root/snapshot-race-env" \
  "$entry" new claude --print hello \
  >"$root/snapshot-race.out" 2>"$root/snapshot-race.err"; then
  printf 'expected in-place managed-file race to fail closed\n' >&2
  exit 1
fi
[[ -f "$root/snapshot-race-marker" ]]
grep -Fqx 'concurrent in-place edit' "$snapshot_runtime/output-styles/rundown.md"
snapshot_transaction="$(
  find "$snapshot_runtime" -mindepth 1 -maxdepth 1 \
    -name '.trellage-claude-transaction.*' -type d -print -quit
)"
[[ -n "$snapshot_transaction" ]]
[[ -f "$snapshot_transaction/transaction-journal" ]]
[[ -f "$snapshot_transaction/rollback-retain" ]]
grep -Fqx \
  'pre-transaction snapshot' \
  "$snapshot_transaction/managed-backup/output-styles/rundown.md"
rm -rf -- "$snapshot_transaction"

crash_seed="$root/crash-seed"
crash_runtime="$root/crash-home/.claude"
mkdir -p "$crash_seed/output-styles" "$crash_runtime"
cp "$seed/default-settings.json" "$crash_seed/default-settings.json"
cp "$seed/default-user-settings.json" "$crash_seed/default-user-settings.json"
cp "$seed/default-onboarding.json" "$crash_seed/default-onboarding.json"
printf 'Rundown\n' >"$crash_seed/output-styles/rundown.md"
printf 'output-styles/rundown.md\n' >"$crash_seed/managed-paths.txt"
printf '{"enabledPlugins":[]}\n' >"$crash_seed/plugin-settings.json"
printf '{"outputStyle":"Explanatory","preserve":"crash-user-state"}\n' \
  >"$crash_runtime/settings.json"
rollback_crash_hook="$root/rollback-crash-hook.cjs"
cat >"$rollback_crash_hook" <<'JS'
const fs = require('node:fs')
const path = require('node:path')

const target = path.resolve(process.env.TRELLAGE_TEST_ROLLBACK_CRASH_PATH)
const marker = path.resolve(process.env.TRELLAGE_TEST_ROLLBACK_CRASH_MARKER)
const originalRenameSync = fs.renameSync.bind(fs)

fs.renameSync = (source, destination) => {
  if (
    path.resolve(source) === target &&
    destination.includes(`${path.sep}rollback-removed${path.sep}`) &&
    !fs.existsSync(marker)
  ) {
    const replacement = `${target}.concurrent-replacement`
    fs.writeFileSync(replacement, 'crash-window replacement\n')
    originalRenameSync(replacement, target)
    originalRenameSync(target, destination)
    fs.writeFileSync(marker, '')
    process.kill(process.ppid, 'SIGKILL')
    process.kill(process.pid, 'SIGKILL')
  }
  return originalRenameSync(source, destination)
}
JS
if PATH="$fake_bin:$PATH" \
  TRELLAGE_TEST_ROLLBACK_CRASH_PATH="$crash_runtime/output-styles/rundown.md" \
  TRELLAGE_TEST_ROLLBACK_CRASH_MARKER="$root/rollback-crash-marker" \
  TRELLAGE_CLAUDE_SEED_HOME="$crash_seed" TRELLAGE_CLAUDE_HOME="$crash_runtime" \
  TRELLAGE_CLAUDE_MODE=core TRELLAGE_CLAUDE_RUNTIME_MODE=core \
  TRELLAGE_CLAUDE_AUTH_MODE=native \
  CLAUDE_ARGS_OUT="$root/crash-args" CLAUDE_CONFIG_OUT="$root/crash-config" \
  CLAUDE_CONFIG_PATH_OUT="$root/crash-config-path" CLAUDE_ENV_OUT="$root/crash-env" \
  node - \
    "$entry" "$root/crash.out" "$root/crash.err" "$rollback_crash_hook" <<'NODE'
const fs = require('node:fs')
const { spawnSync } = require('node:child_process')

const [entry, stdoutPath, stderrPath, hook] = process.argv.slice(2)
const stdout = fs.openSync(stdoutPath, 'w')
const stderr = fs.openSync(stderrPath, 'w')
const result = spawnSync(entry, ['new', 'claude', '--print', 'hello'], {
  env: { ...process.env, NODE_OPTIONS: `--require=${hook}` },
  stdio: ['ignore', stdout, stderr],
})
fs.closeSync(stdout)
fs.closeSync(stderr)
if (result.error) throw result.error
process.exit(result.signal === 'SIGKILL' ? 1 : (result.status ?? 1))
NODE
then
  printf 'expected rollback crash injection to terminate the entrypoint\n' >&2
  exit 1
fi
[[ -f "$root/rollback-crash-marker" ]]
crash_transaction="$(
  find "$crash_runtime" -mindepth 1 -maxdepth 1 \
    -name '.trellage-claude-transaction.*' -type d -print -quit
)"
[[ -n "$crash_transaction" ]]
[[ -f "$crash_transaction/transaction-journal" ]]
grep -Fqx \
  'crash-window replacement' \
  "$crash_transaction/rollback-removed/output-styles/rundown.md"
if PATH="$fake_bin:$PATH" \
  TRELLAGE_CLAUDE_SEED_HOME="$crash_seed" TRELLAGE_CLAUDE_HOME="$crash_runtime" \
  TRELLAGE_CLAUDE_MODE=core TRELLAGE_CLAUDE_RUNTIME_MODE=core \
  TRELLAGE_CLAUDE_AUTH_MODE=native \
  CLAUDE_ARGS_OUT="$root/crash-retry-args" CLAUDE_CONFIG_OUT="$root/crash-retry-config" \
  CLAUDE_CONFIG_PATH_OUT="$root/crash-retry-config-path" \
  CLAUDE_ENV_OUT="$root/crash-retry-env" \
  "$entry" new claude --print hello >"$root/crash-retry.out" 2>"$root/crash-retry.err"; then
  printf 'expected incomplete rollback recovery to fail closed\n' >&2
  exit 1
fi
grep -Fq \
  "incomplete Claude rollback requires manual recovery: $crash_transaction" \
  "$root/crash-retry.err"
grep -Fqx \
  'crash-window replacement' \
  "$crash_transaction/rollback-removed/output-styles/rundown.md"
[[ ! -e "$crash_runtime/.trellage-claude.lock" ]]

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
  },
  "pluginConfigs": {
    "social-media-skills@social-media-skills": {
      "options": {
        "hook_profile": "minimal",
        "hooks_enabled": true
      }
    }
  }
}
JSON
cp "$seed/default-settings.json" "$native_seed/default-settings.json"
cp "$seed/default-user-settings.json" "$native_seed/default-user-settings.json"
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
  and .outputStyle == "Rundown"
  and .enabledPlugins["social-media-skills@social-media-skills"] == true
  and .pluginConfigs["social-media-skills@social-media-skills"].options.hook_profile == "minimal"
  and .pluginConfigs["social-media-skills@social-media-skills"].options.hooks_enabled == true
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

large_seed="$root/large-seed"
large_runtime="$root/large-home/.claude"
large_count_bin="$root/large-count-bin"
mkdir -p "$large_seed/skills/bulk" "$large_runtime" "$large_count_bin"
cp "$seed/default-settings.json" "$large_seed/default-settings.json"
cp "$seed/default-user-settings.json" "$large_seed/default-user-settings.json"
cp "$seed/default-onboarding.json" "$large_seed/default-onboarding.json"
: >"$large_seed/managed-paths.txt"
for ((index = 1; index <= 1200; index++)); do
  printf -v filename 'file-%04d.md' "$index"
  printf 'bulk file %04d\n' "$index" >"$large_seed/skills/bulk/$filename"
  printf 'skills/bulk/%s\n' "$filename" >>"$large_seed/managed-paths.txt"
done
chmod 755 "$large_seed/skills/bulk/file-0001.md"
printf 'keep large unmanaged state\n' >"$large_runtime/user-state"
cat >"$large_count_bin/cp" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf 'cp\n' >>"${TRELLAGE_TEST_FILE_OPS:?}"
exec "${TRELLAGE_TEST_REAL_CP:?}" "$@"
SH
cat >"$large_count_bin/mv" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf 'mv\n' >>"${TRELLAGE_TEST_FILE_OPS:?}"
exec "${TRELLAGE_TEST_REAL_MV:?}" "$@"
SH
chmod +x "$large_count_bin/cp" "$large_count_bin/mv"
large_file_ops="$root/large-file-ops"
: >"$large_file_ops"
PATH="$large_count_bin:$fake_bin:$PATH" \
TRELLAGE_TEST_FILE_OPS="$large_file_ops" \
TRELLAGE_TEST_REAL_CP="$real_cp" \
TRELLAGE_TEST_REAL_MV="$real_mv" \
TRELLAGE_CLAUDE_SEED_HOME="$large_seed" \
TRELLAGE_CLAUDE_HOME="$large_runtime" \
TRELLAGE_CLAUDE_AUTH_MODE=native \
TRELLAGE_CLAUDE_RUNTIME_MODE=native-plugin \
CLAUDE_ARGS_OUT="$root/large-first-args" CLAUDE_CONFIG_OUT="$root/large-first-config" \
CLAUDE_CONFIG_PATH_OUT="$root/large-first-config-path" CLAUDE_ENV_OUT="$root/large-first-env" \
  "$entry" new claude --print hello 2>"$root/large-first.err"
grep -Fq 'synchronizing 1200 managed Claude files' "$root/large-first.err"
grep -Fq 'managed Claude files are ready' "$root/large-first.err"
grep -Fqx 'bulk file 0001' "$large_runtime/skills/bulk/file-0001.md"
grep -Fqx 'bulk file 1200' "$large_runtime/skills/bulk/file-1200.md"
grep -Fqx 'keep large unmanaged state' "$large_runtime/user-state"
[[ "$(file_mode "$large_runtime/skills/bulk/file-0001.md")" == 700 ]]
[[ "$(file_mode "$large_runtime/skills/bulk/file-0002.md")" == 600 ]]
printf 'stale managed state\n' >"$large_runtime/skills/bulk/file-0002.md"
PATH="$large_count_bin:$fake_bin:$PATH" \
TRELLAGE_TEST_FILE_OPS="$large_file_ops" \
TRELLAGE_TEST_REAL_CP="$real_cp" \
TRELLAGE_TEST_REAL_MV="$real_mv" \
TRELLAGE_CLAUDE_SEED_HOME="$large_seed" \
TRELLAGE_CLAUDE_HOME="$large_runtime" \
TRELLAGE_CLAUDE_AUTH_MODE=native \
TRELLAGE_CLAUDE_RUNTIME_MODE=native-plugin \
CLAUDE_ARGS_OUT="$root/large-second-args" CLAUDE_CONFIG_OUT="$root/large-second-config" \
CLAUDE_CONFIG_PATH_OUT="$root/large-second-config-path" CLAUDE_ENV_OUT="$root/large-second-env" \
  "$entry" new claude --print hello 2>"$root/large-second.err"
grep -Fq 'synchronizing 1200 managed Claude files' "$root/large-second.err"
grep -Fq 'managed Claude files are ready' "$root/large-second.err"
grep -Fqx 'bulk file 0002' "$large_runtime/skills/bulk/file-0002.md"
grep -Fqx 'keep large unmanaged state' "$large_runtime/user-state"
large_file_op_count="$(wc -l <"$large_file_ops")"
if (( large_file_op_count >= 100 )); then
  printf 'large Claude seed used %s per-file cp/mv operations\n' "$large_file_op_count" >&2
  exit 1
fi
[[ "$(find "$large_runtime/skills/bulk" -type f | wc -l | tr -d ' ')" == 1200 ]]

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
