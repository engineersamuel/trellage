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

entry="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/runtime-claude-entry.sh"
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
cat >"$fake_bin/flock" <<'SH'
#!/usr/bin/env bash
exit 0
SH
chmod +x "$fake_bin/flock"

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
[[ -f "$runtime/.trellage-claude.lock" && ! -L "$runtime/.trellage-claude.lock" ]]
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
[[ -f "$runtime/.trellage-claude.lock" && ! -L "$runtime/.trellage-claude.lock" ]]
[[ -z "$(find "$runtime" -maxdepth 1 -name '.trellage-claude-transaction.*' -print -quit)" ]]
printf 'ACTIVE EVERY RESPONSE\n' >"$runtime/CLAUDE.md"
printf 'new skill\n' >"$seed/skills/hyperresearch/SKILL.md"
printf 'ACTIVE EVERY RESPONSE\n' >"$seed/CLAUDE.md"

printf 'before late rollback\n' >"$runtime/skills/hyperresearch/SKILL.md"
printf 'late replacement\n' >"$seed/skills/hyperresearch/SKILL.md"
printf 'late replacement root instructions\n' >"$seed/CLAUDE.md"
exchange_hook_dir="$root/exchange-hook"
mkdir -p "$exchange_hook_dir"
cat >"$exchange_hook_dir/sitecustomize.py" <<'PY'
import ctypes
import os

real_cdll = ctypes.CDLL


class WrappedFunction:
    def __init__(self, function):
        object.__setattr__(self, "function", function)

    def __getattr__(self, name):
        return getattr(self.function, name)

    def __setattr__(self, name, value):
        setattr(self.function, name, value)

    def __call__(self, *arguments):
        destination_index = 3 if len(arguments) == 5 else 1
        destination = os.path.realpath(os.fsdecode(arguments[destination_index]))
        target = os.environ.get("TRELLAGE_TEST_EXCHANGE_TARGET", "")
        marker = os.environ.get("TRELLAGE_TEST_EXCHANGE_MARKER", "")
        action = ""
        kill_after = False
        if target and destination == os.path.realpath(target) and marker and not os.path.exists(marker):
            open(marker, "w", encoding="utf-8").close()
            action = os.environ.get("TRELLAGE_TEST_EXCHANGE_ACTION", "")
            replace_path = os.environ.get("TRELLAGE_TEST_EXCHANGE_REPLACE_PATH", "")
            if replace_path:
                try:
                    os.unlink(replace_path)
                except FileNotFoundError:
                    pass
                with open(replace_path, "w", encoding="utf-8") as replacement:
                    replacement.write(
                        os.environ.get("TRELLAGE_TEST_EXCHANGE_REPLACE_CONTENT", "")
                    )
            if action == "delete":
                os.unlink(destination)
            if action == "fail":
                raise OSError("injected atomic exchange failure")
            if action == "kill":
                os.kill(os.getppid(), 9)
                os._exit(137)
            kill_after = action == "kill-after"
        result = self.function(*arguments)
        if action == "delete-kill-after":
            os.unlink(destination)
            os.kill(os.getppid(), 9)
            os._exit(137)
        if kill_after:
            os.kill(os.getppid(), 9)
            os._exit(137)
        return result


class WrappedLibrary:
    def __init__(self, library):
        self.library = library

    def __getattr__(self, name):
        function = getattr(self.library, name)
        if name in {"renameat2", "renamex_np"}:
            return WrappedFunction(function)
        return function


def wrapped_cdll(*arguments, **keywords):
    return WrappedLibrary(real_cdll(*arguments, **keywords))


ctypes.CDLL = wrapped_cdll
PY
if PYTHONPATH="$exchange_hook_dir" \
  PATH="$fake_bin:$PATH" \
  TRELLAGE_TEST_EXCHANGE_TARGET="$runtime/settings.json" \
  TRELLAGE_TEST_EXCHANGE_MARKER="$root/late-fail-marker" \
  TRELLAGE_TEST_EXCHANGE_REPLACE_PATH="$runtime/CLAUDE.md" \
  TRELLAGE_TEST_EXCHANGE_REPLACE_CONTENT=$'concurrent replacement\n' \
  TRELLAGE_TEST_EXCHANGE_ACTION=fail \
  TRELLAGE_CLAUDE_SEED_HOME="$seed" TRELLAGE_CLAUDE_HOME="$runtime" \
  TRELLAGE_CLAUDE_AUTH_MODE=native \
  CLAUDE_ARGS_OUT="$root/late-fail-args" CLAUDE_CONFIG_OUT="$root/late-fail-config" \
  CLAUDE_CONFIG_PATH_OUT="$root/late-fail-config-path" CLAUDE_ENV_OUT="$root/late-fail-env" \
  "$entry" new claude --print hello >"$root/late-fail.out" 2>"$root/late-fail.err"; then
  printf 'expected post-publication Claude settings update to fail\n' >&2
  exit 1
fi
[[ -f "$root/late-fail-marker" ]]
grep -Fqx 'concurrent replacement' "$runtime/CLAUDE.md" \
  || { printf 'rollback deleted a concurrently replaced managed file\n' >&2; exit 1; }
grep -Fqx 'before late rollback' "$runtime/skills/hyperresearch/SKILL.md" \
  || { printf 'rollback did not restore an unchanged managed file\n' >&2; exit 1; }
[[ -f "$runtime/.trellage-claude.lock" && ! -L "$runtime/.trellage-claude.lock" ]]
[[ -z "$(find "$runtime" -maxdepth 1 -name '.trellage-claude-transaction.*' -print -quit)" ]]
printf 'ACTIVE EVERY RESPONSE\n' >"$runtime/CLAUDE.md"
printf 'new skill\n' >"$seed/skills/hyperresearch/SKILL.md"
printf 'ACTIVE EVERY RESPONSE\n' >"$seed/CLAUDE.md"

publication_seed="$root/publication-seed"
publication_runtime="$root/publication-home/.claude"
mkdir -p "$root/publication-home"
cp -R "$seed" "$publication_seed"
cp -R "$runtime" "$publication_runtime"
printf 'prior publication state\n' >"$publication_runtime/skills/hyperresearch/SKILL.md"
printf 'new publication state\n' >"$publication_seed/skills/hyperresearch/SKILL.md"
publication_preload="$root/publication-collision.cjs"
cat >"$publication_preload" <<'JS'
const fs = require('node:fs')
const path = require('node:path')

const linkSync = fs.linkSync
fs.linkSync = (source, destination) => {
  if (
    path.resolve(destination) ===
      path.resolve(process.env.TRELLAGE_TEST_PUBLICATION_COLLISION_PATH) &&
    !fs.existsSync(process.env.TRELLAGE_TEST_PUBLICATION_COLLISION_MARKER)
  ) {
    fs.writeFileSync(destination, 'concurrent publication\n')
    fs.writeFileSync(process.env.TRELLAGE_TEST_PUBLICATION_COLLISION_MARKER, '')
  }
  return linkSync(source, destination)
}
JS
if NODE_OPTIONS="--require=$publication_preload" \
  PATH="$fake_bin:$PATH" \
  TRELLAGE_TEST_PUBLICATION_COLLISION_PATH="$publication_runtime/skills/hyperresearch/SKILL.md" \
  TRELLAGE_TEST_PUBLICATION_COLLISION_MARKER="$root/publication-collision-marker" \
  TRELLAGE_CLAUDE_SEED_HOME="$publication_seed" \
  TRELLAGE_CLAUDE_HOME="$publication_runtime" \
  TRELLAGE_CLAUDE_AUTH_MODE=native \
  CLAUDE_ARGS_OUT="$root/publication-args" CLAUDE_CONFIG_OUT="$root/publication-config" \
  CLAUDE_CONFIG_PATH_OUT="$root/publication-config-path" CLAUDE_ENV_OUT="$root/publication-env" \
  "$entry" new claude --print hello >"$root/publication.out" 2>"$root/publication.err"; then
  printf 'expected atomic managed-file publication collision to fail\n' >&2
  exit 1
fi
[[ -f "$root/publication-collision-marker" ]]
grep -Fqx 'concurrent publication' \
  "$publication_runtime/skills/hyperresearch/SKILL.md" \
  || { printf 'managed publication replaced a concurrently created file\n' >&2; exit 1; }
[[ -f "$publication_runtime/.trellage-claude.lock" \
  && ! -L "$publication_runtime/.trellage-claude.lock" ]]
[[ -z "$(find "$publication_runtime" -maxdepth 1 -name '.trellage-claude-transaction.*' -print -quit)" ]]

identity_seed="$root/identity-seed"
identity_runtime="$root/identity-home/.claude"
mkdir -p "$root/identity-home"
cp -R "$seed" "$identity_seed"
cp -R "$runtime" "$identity_runtime"
printf 'prior identity state\n' >"$identity_runtime/skills/hyperresearch/SKILL.md"
printf 'new identity state\n' >"$identity_seed/skills/hyperresearch/SKILL.md"
if PYTHONPATH="$exchange_hook_dir" \
  PATH="$fake_bin:$PATH" \
  TRELLAGE_TEST_EXCHANGE_TARGET="$identity_runtime/settings.json" \
  TRELLAGE_TEST_EXCHANGE_MARKER="$root/identity-marker" \
  TRELLAGE_TEST_EXCHANGE_REPLACE_PATH="$identity_runtime/settings.json" \
  TRELLAGE_TEST_EXCHANGE_REPLACE_CONTENT=$'concurrent identity replacement\n' \
  TRELLAGE_CLAUDE_SEED_HOME="$identity_seed" \
  TRELLAGE_CLAUDE_HOME="$identity_runtime" \
  TRELLAGE_CLAUDE_AUTH_MODE=native \
  CLAUDE_ARGS_OUT="$root/identity-args" CLAUDE_CONFIG_OUT="$root/identity-config" \
  CLAUDE_CONFIG_PATH_OUT="$root/identity-config-path" CLAUDE_ENV_OUT="$root/identity-env" \
  "$entry" new claude --print hello >"$root/identity.out" 2>"$root/identity.err"; then
  printf 'expected changed Claude settings identity to fail publication\n' >&2
  exit 1
fi
grep -Fqx 'concurrent identity replacement' "$identity_runtime/settings.json"
grep -Fqx 'prior identity state' "$identity_runtime/skills/hyperresearch/SKILL.md"
grep -Fq 'Claude state changed during publication: settings.json' "$root/identity.err"
[[ -z "$(find "$identity_runtime" -maxdepth 1 -name '.trellage-claude-transaction.*' -print -quit)" ]]

delete_seed="$root/delete-seed"
delete_runtime="$root/delete-home/.claude"
mkdir -p "$root/delete-home"
cp -R "$seed" "$delete_seed"
cp -R "$runtime" "$delete_runtime"
printf 'prior delete state\n' >"$delete_runtime/skills/hyperresearch/SKILL.md"
printf 'new delete state\n' >"$delete_seed/skills/hyperresearch/SKILL.md"
if PYTHONPATH="$exchange_hook_dir" \
  PATH="$fake_bin:$PATH" \
  TRELLAGE_TEST_EXCHANGE_TARGET="$delete_runtime/settings.json" \
  TRELLAGE_TEST_EXCHANGE_MARKER="$root/delete-marker" \
  TRELLAGE_TEST_EXCHANGE_ACTION=delete \
  TRELLAGE_CLAUDE_SEED_HOME="$delete_seed" \
  TRELLAGE_CLAUDE_HOME="$delete_runtime" \
  TRELLAGE_CLAUDE_AUTH_MODE=native \
  CLAUDE_ARGS_OUT="$root/delete-args" CLAUDE_CONFIG_OUT="$root/delete-config" \
  CLAUDE_CONFIG_PATH_OUT="$root/delete-config-path" CLAUDE_ENV_OUT="$root/delete-env" \
  "$entry" new claude --print hello >"$root/delete.out" 2>"$root/delete.err"; then
  printf 'expected deleted Claude settings to fail publication\n' >&2
  exit 1
fi
[[ ! -e "$delete_runtime/settings.json" && ! -L "$delete_runtime/settings.json" ]]
grep -Fqx 'prior delete state' "$delete_runtime/skills/hyperresearch/SKILL.md"
[[ -z "$(find "$delete_runtime" -maxdepth 1 -name '.trellage-claude-transaction.*' -print -quit)" ]]

exchange_crash_seed="$root/exchange-crash-seed"
exchange_crash_runtime="$root/exchange-crash-home/.claude"
mkdir -p "$root/exchange-crash-home"
cp -R "$seed" "$exchange_crash_seed"
cp -R "$runtime" "$exchange_crash_runtime"
printf 'prior exchange crash state\n' \
  >"$exchange_crash_runtime/skills/hyperresearch/SKILL.md"
printf 'new exchange crash state\n' \
  >"$exchange_crash_seed/skills/hyperresearch/SKILL.md"
exchange_crash_status=0
{
  PYTHONPATH="$exchange_hook_dir" \
  PATH="$fake_bin:$PATH" \
  TRELLAGE_TEST_EXCHANGE_TARGET="$exchange_crash_runtime/settings.json" \
  TRELLAGE_TEST_EXCHANGE_MARKER="$root/exchange-crash-marker" \
  TRELLAGE_TEST_EXCHANGE_REPLACE_PATH="$exchange_crash_runtime/settings.json" \
  TRELLAGE_TEST_EXCHANGE_REPLACE_CONTENT=$'concurrent exchange crash replacement\n' \
  TRELLAGE_TEST_EXCHANGE_ACTION=kill-after \
  TRELLAGE_CLAUDE_SEED_HOME="$exchange_crash_seed" \
  TRELLAGE_CLAUDE_HOME="$exchange_crash_runtime" \
  TRELLAGE_CLAUDE_AUTH_MODE=native \
  CLAUDE_ARGS_OUT="$root/exchange-crash-args" \
  CLAUDE_CONFIG_OUT="$root/exchange-crash-config" \
  CLAUDE_CONFIG_PATH_OUT="$root/exchange-crash-config-path" \
  CLAUDE_ENV_OUT="$root/exchange-crash-env" \
    "$entry" new claude --print hello \
    >"$root/exchange-crash.out" 2>"$root/exchange-crash.err" \
    || exchange_crash_status=$?
} 2>>"$root/exchange-crash.err"
[[ "$exchange_crash_status" -ne 0 && -f "$root/exchange-crash-marker" ]] || {
  printf 'expected SIGKILL after a mismatched Claude state exchange\n' >&2
  exit 1
}
exchange_crash_transaction="$(
  find "$exchange_crash_runtime" -maxdepth 1 \
    -name '.trellage-claude-transaction.*' -print -quit
)"
[[ -n "$exchange_crash_transaction" ]]
printf 'skills/hyperresearch/missing-after-exchange-recovery.md\n' \
  >"$exchange_crash_seed/managed-paths.txt"
if PATH="$fake_bin:$PATH" \
  TRELLAGE_CLAUDE_SEED_HOME="$exchange_crash_seed" \
  TRELLAGE_CLAUDE_HOME="$exchange_crash_runtime" \
  TRELLAGE_CLAUDE_AUTH_MODE=native \
  CLAUDE_ARGS_OUT="$root/exchange-recovery-args" \
  CLAUDE_CONFIG_OUT="$root/exchange-recovery-config" \
  CLAUDE_CONFIG_PATH_OUT="$root/exchange-recovery-config-path" \
  CLAUDE_ENV_OUT="$root/exchange-recovery-env" \
  "$entry" new claude --print hello \
  >"$root/exchange-recovery.out" 2>"$root/exchange-recovery.err"; then
  printf 'expected invalid seed after exchange recovery to fail\n' >&2
  exit 1
fi
grep -Fqx 'concurrent exchange crash replacement' \
  "$exchange_crash_runtime/settings.json"
grep -Fqx 'prior exchange crash state' \
  "$exchange_crash_runtime/skills/hyperresearch/SKILL.md"
[[ -z "$(find "$exchange_crash_runtime" -maxdepth 1 -name '.trellage-claude-transaction.*' -print -quit)" ]]

delete_crash_seed="$root/delete-crash-seed"
delete_crash_runtime="$root/delete-crash-home/.claude"
mkdir -p "$root/delete-crash-home"
cp -R "$seed" "$delete_crash_seed"
cp -R "$runtime" "$delete_crash_runtime"
printf 'prior delete crash state\n' \
  >"$delete_crash_runtime/skills/hyperresearch/SKILL.md"
printf 'new delete crash state\n' \
  >"$delete_crash_seed/skills/hyperresearch/SKILL.md"
delete_crash_status=0
{
  PYTHONPATH="$exchange_hook_dir" \
  PATH="$fake_bin:$PATH" \
  TRELLAGE_TEST_EXCHANGE_TARGET="$delete_crash_runtime/settings.json" \
  TRELLAGE_TEST_EXCHANGE_MARKER="$root/delete-crash-marker" \
  TRELLAGE_TEST_EXCHANGE_ACTION=delete-kill-after \
  TRELLAGE_CLAUDE_SEED_HOME="$delete_crash_seed" \
  TRELLAGE_CLAUDE_HOME="$delete_crash_runtime" \
  TRELLAGE_CLAUDE_AUTH_MODE=native \
  CLAUDE_ARGS_OUT="$root/delete-crash-args" \
  CLAUDE_CONFIG_OUT="$root/delete-crash-config" \
  CLAUDE_CONFIG_PATH_OUT="$root/delete-crash-config-path" \
  CLAUDE_ENV_OUT="$root/delete-crash-env" \
    "$entry" new claude --print hello \
    >"$root/delete-crash.out" 2>"$root/delete-crash.err" \
    || delete_crash_status=$?
} 2>>"$root/delete-crash.err"
[[ "$delete_crash_status" -ne 0 && -f "$root/delete-crash-marker" ]] || {
  printf 'expected SIGKILL after deleting exchanged Claude settings\n' >&2
  exit 1
}
printf 'skills/hyperresearch/missing-after-delete-recovery.md\n' \
  >"$delete_crash_seed/managed-paths.txt"
if PATH="$fake_bin:$PATH" \
  TRELLAGE_CLAUDE_SEED_HOME="$delete_crash_seed" \
  TRELLAGE_CLAUDE_HOME="$delete_crash_runtime" \
  TRELLAGE_CLAUDE_AUTH_MODE=native \
  CLAUDE_ARGS_OUT="$root/delete-recovery-args" \
  CLAUDE_CONFIG_OUT="$root/delete-recovery-config" \
  CLAUDE_CONFIG_PATH_OUT="$root/delete-recovery-config-path" \
  CLAUDE_ENV_OUT="$root/delete-recovery-env" \
  "$entry" new claude --print hello \
  >"$root/delete-recovery.out" 2>"$root/delete-recovery.err"; then
  printf 'expected invalid seed after deletion recovery to fail\n' >&2
  exit 1
fi
[[ ! -e "$delete_crash_runtime/settings.json" \
  && ! -L "$delete_crash_runtime/settings.json" ]]
grep -Fqx 'prior delete crash state' \
  "$delete_crash_runtime/skills/hyperresearch/SKILL.md"
[[ -z "$(find "$delete_crash_runtime" -maxdepth 1 -name '.trellage-claude-transaction.*' -print -quit)" ]]

absent_seed="$root/absent-seed"
absent_runtime="$root/absent-home/.claude"
mkdir -p "$root/absent-home"
cp -R "$seed" "$absent_seed"
cp -R "$runtime" "$absent_runtime"
rm -f -- "$absent_runtime/settings.json"
printf '{}\n' >"$absent_seed/plugin-marketplaces.json"
if PATH="$fake_bin:$PATH" \
  TRELLAGE_CLAUDE_SEED_HOME="$absent_seed" \
  TRELLAGE_CLAUDE_HOME="$absent_runtime" \
  TRELLAGE_CLAUDE_AUTH_MODE=native \
  CLAUDE_ARGS_OUT="$root/absent-args" CLAUDE_CONFIG_OUT="$root/absent-config" \
  CLAUDE_CONFIG_PATH_OUT="$root/absent-config-path" CLAUDE_ENV_OUT="$root/absent-env" \
  "$entry" new claude --print hello >"$root/absent.out" 2>"$root/absent.err"; then
  printf 'expected invalid marketplace state after initial settings publication to fail\n' >&2
  exit 1
fi
grep -Fq 'baked Claude plugin marketplaces are invalid' "$root/absent.err"
[[ ! -e "$absent_runtime/settings.json" && ! -L "$absent_runtime/settings.json" ]]
[[ -z "$(find "$absent_runtime" -maxdepth 1 -name '.trellage-claude-transaction.*' -print -quit)" ]]

hardlink_seed="$root/hardlink-seed"
hardlink_runtime="$root/hardlink-home/.claude"
mkdir -p "$root/hardlink-home"
cp -R "$seed" "$hardlink_seed"
cp -R "$runtime" "$hardlink_runtime"
printf 'prior hardlink state\n' >"$hardlink_runtime/skills/hyperresearch/SKILL.md"
ln "$hardlink_runtime/settings.json" "$root/settings-hardlink"
if PATH="$fake_bin:$PATH" \
  TRELLAGE_CLAUDE_SEED_HOME="$hardlink_seed" \
  TRELLAGE_CLAUDE_HOME="$hardlink_runtime" \
  TRELLAGE_CLAUDE_AUTH_MODE=native \
  CLAUDE_ARGS_OUT="$root/hardlink-args" CLAUDE_CONFIG_OUT="$root/hardlink-config" \
  CLAUDE_CONFIG_PATH_OUT="$root/hardlink-config-path" CLAUDE_ENV_OUT="$root/hardlink-env" \
  "$entry" new claude --print hello >"$root/hardlink.out" 2>"$root/hardlink.err"; then
  printf 'expected hard-linked Claude settings to fail before publication\n' >&2
  exit 1
fi
grep -Fq 'Claude state must be a single-link regular file: settings.json' \
  "$root/hardlink.err"
cmp -s "$hardlink_runtime/settings.json" "$root/settings-hardlink"
grep -Fqx 'prior hardlink state' "$hardlink_runtime/skills/hyperresearch/SKILL.md"
[[ -z "$(find "$hardlink_runtime" -maxdepth 1 -name '.trellage-claude-transaction.*' -print -quit)" ]]

legacy_lock_seed="$root/legacy-lock-seed"
legacy_lock_runtime="$root/legacy-lock-home/.claude"
mkdir -p "$root/legacy-lock-home"
cp -R "$seed" "$legacy_lock_seed"
cp -R "$runtime" "$legacy_lock_runtime"
rm -f -- "$legacy_lock_runtime/.trellage-claude.lock"
mkdir "$legacy_lock_runtime/.trellage-claude.lock"
printf '999999\n' >"$legacy_lock_runtime/.trellage-claude.lock/pid"
if PATH="$fake_bin:$PATH" \
  TRELLAGE_CLAUDE_SEED_HOME="$legacy_lock_seed" \
  TRELLAGE_CLAUDE_HOME="$legacy_lock_runtime" \
  TRELLAGE_CLAUDE_AUTH_MODE=native \
  CLAUDE_ARGS_OUT="$root/legacy-lock-args" CLAUDE_CONFIG_OUT="$root/legacy-lock-config" \
  CLAUDE_CONFIG_PATH_OUT="$root/legacy-lock-config-path" CLAUDE_ENV_OUT="$root/legacy-lock-env" \
  "$entry" new claude --print hello \
  >"$root/legacy-lock.out" 2>"$root/legacy-lock.err"; then
  printf 'expected legacy Claude lock directory to fail closed\n' >&2
  exit 1
fi
grep -Fq 'legacy Claude lock directory requires manual removal' "$root/legacy-lock.err"
[[ -d "$legacy_lock_runtime/.trellage-claude.lock" ]]

crash_seed="$root/crash-seed"
crash_runtime="$root/crash-home/.claude"
mkdir -p "$root/crash-home"
cp -R "$seed" "$crash_seed"
cp -R "$runtime" "$crash_runtime"
printf 'prior crash state\n' >"$crash_runtime/skills/hyperresearch/SKILL.md"
printf 'published before crash\n' >"$crash_seed/skills/hyperresearch/SKILL.md"
cp "$crash_runtime/settings.json" "$root/crash-settings.before"
cp "$crash_runtime/.trellage-claude-managed" "$root/crash-manifest.before"
crash_status=0
{
  PYTHONPATH="$exchange_hook_dir" \
  PATH="$fake_bin:$PATH" \
  TRELLAGE_TEST_EXCHANGE_TARGET="$crash_runtime/.claude.json" \
  TRELLAGE_TEST_EXCHANGE_MARKER="$root/crash-marker" \
  TRELLAGE_TEST_EXCHANGE_ACTION=kill \
  TRELLAGE_CLAUDE_SEED_HOME="$crash_seed" \
  TRELLAGE_CLAUDE_HOME="$crash_runtime" \
  TRELLAGE_CLAUDE_AUTH_MODE=native \
  CLAUDE_ARGS_OUT="$root/crash-args" CLAUDE_CONFIG_OUT="$root/crash-config" \
  CLAUDE_CONFIG_PATH_OUT="$root/crash-config-path" CLAUDE_ENV_OUT="$root/crash-env" \
    "$entry" new claude --print hello >"$root/crash.out" 2>"$root/crash.err" \
    || crash_status=$?
} 2>>"$root/crash.err"
[[ "$crash_status" -ne 0 && -f "$root/crash-marker" ]] || {
  printf 'expected SIGKILL during Claude state publication\n' >&2
  exit 1
}
crash_transaction="$(find "$crash_runtime" -maxdepth 1 -name '.trellage-claude-transaction.*' -print -quit)"
[[ -n "$crash_transaction" && -f "$crash_runtime/.trellage-claude.lock" \
  && ! -L "$crash_runtime/.trellage-claude.lock" ]]
grep -Fq '"path":"settings.json"' "$crash_transaction/published.jsonl"
grep -Fqx 'published before crash' "$crash_runtime/skills/hyperresearch/SKILL.md"
cp "$crash_seed/managed-paths.txt" "$root/crash-managed-paths.valid"
printf 'skills/hyperresearch/missing-after-recovery.md\n' >"$crash_seed/managed-paths.txt"
if PATH="$fake_bin:$PATH" \
  TRELLAGE_CLAUDE_SEED_HOME="$crash_seed" \
  TRELLAGE_CLAUDE_HOME="$crash_runtime" \
  TRELLAGE_CLAUDE_AUTH_MODE=native \
  CLAUDE_ARGS_OUT="$root/crash-recovery-args" CLAUDE_CONFIG_OUT="$root/crash-recovery-config" \
  CLAUDE_CONFIG_PATH_OUT="$root/crash-recovery-config-path" CLAUDE_ENV_OUT="$root/crash-recovery-env" \
  "$entry" new claude --print hello >"$root/crash-recovery.out" 2>"$root/crash-recovery.err"; then
  printf 'expected post-recovery invalid managed seed to fail\n' >&2
  exit 1
fi
grep -Fqx 'prior crash state' "$crash_runtime/skills/hyperresearch/SKILL.md"
cmp -s "$root/crash-settings.before" "$crash_runtime/settings.json"
cmp -s "$root/crash-manifest.before" "$crash_runtime/.trellage-claude-managed"
[[ -f "$crash_runtime/.trellage-claude.lock" \
  && ! -L "$crash_runtime/.trellage-claude.lock" ]]
[[ -z "$(find "$crash_runtime" -maxdepth 1 -name '.trellage-claude-transaction.*' -print -quit)" ]]

retained_seed="$root/retained-seed"
retained_runtime="$root/retained-home/.claude"
mkdir -p "$root/retained-home"
cp -R "$seed" "$retained_seed"
cp -R "$runtime" "$retained_runtime"
printf 'prior retained state\n' >"$retained_runtime/skills/hyperresearch/SKILL.md"
printf 'new retained state\n' >"$retained_seed/skills/hyperresearch/SKILL.md"
retained_tar_bin="$root/retained-tar-bin"
retained_tar_count="$root/retained-tar-count"
mkdir -p "$retained_tar_bin"
printf '0\n' >"$retained_tar_count"
cat >"$retained_tar_bin/tar" <<'SH'
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
if [[ "$extract" == true ]]; then
  case "$destination" in
    "${TRELLAGE_TEST_RETAINED_RUNTIME:?}"/.trellage-claude-transaction.*/.managed-runtime-copy.*)
      count="$(cat "${TRELLAGE_TEST_RETAINED_COUNT:?}")"
      printf '%s\n' "$((count + 1))" >"$TRELLAGE_TEST_RETAINED_COUNT"
      exit 76
      ;;
  esac
fi
exec "${TRELLAGE_TEST_REAL_TAR:?}" "$@"
SH
chmod +x "$retained_tar_bin/tar"
if PATH="$retained_tar_bin:$fake_bin:$PATH" \
  TRELLAGE_TEST_REAL_TAR="$real_tar" \
  TRELLAGE_TEST_RETAINED_RUNTIME="$retained_runtime" \
  TRELLAGE_TEST_RETAINED_COUNT="$retained_tar_count" \
  TRELLAGE_CLAUDE_SEED_HOME="$retained_seed" \
  TRELLAGE_CLAUDE_HOME="$retained_runtime" \
  TRELLAGE_CLAUDE_AUTH_MODE=native \
  CLAUDE_ARGS_OUT="$root/retained-args" CLAUDE_CONFIG_OUT="$root/retained-config" \
  CLAUDE_CONFIG_PATH_OUT="$root/retained-config-path" CLAUDE_ENV_OUT="$root/retained-env" \
  "$entry" new claude --print hello >"$root/retained.out" 2>"$root/retained.err"; then
  printf 'expected managed publication and rollback staging to fail\n' >&2
  exit 1
fi
grep -Fq 'rollback incomplete; transaction retained:' "$root/retained.err"
[[ "$(cat "$retained_tar_count")" == 2 ]]
retained_transaction="$(find "$retained_runtime" -maxdepth 1 -name '.trellage-claude-transaction.*' -print -quit)"
[[ -n "$retained_transaction" && -d "$retained_transaction" ]]
[[ ! -e "$retained_runtime/skills/hyperresearch/SKILL.md" ]]
printf 'skills/hyperresearch/missing-after-retained-recovery.md\n' \
  >"$retained_seed/managed-paths.txt"
if PATH="$fake_bin:$PATH" \
  TRELLAGE_CLAUDE_SEED_HOME="$retained_seed" \
  TRELLAGE_CLAUDE_HOME="$retained_runtime" \
  TRELLAGE_CLAUDE_AUTH_MODE=native \
  CLAUDE_ARGS_OUT="$root/retained-recovery-args" CLAUDE_CONFIG_OUT="$root/retained-recovery-config" \
  CLAUDE_CONFIG_PATH_OUT="$root/retained-recovery-config-path" CLAUDE_ENV_OUT="$root/retained-recovery-env" \
  "$entry" new claude --print hello >"$root/retained-recovery.out" 2>"$root/retained-recovery.err"; then
  printf 'expected invalid seed after retained rollback recovery to fail\n' >&2
  exit 1
fi
grep -Fqx 'prior retained state' "$retained_runtime/skills/hyperresearch/SKILL.md"
[[ -z "$(find "$retained_runtime" -maxdepth 1 -name '.trellage-claude-transaction.*' -print -quit)" ]]

state_seed="$root/state-seed"
state_runtime="$root/state-home/.claude"
mkdir -p "$root/state-home"
cp -R "$seed" "$state_seed"
cp -R "$runtime" "$state_runtime"
printf 'prior state rollback\n' >"$state_runtime/skills/hyperresearch/SKILL.md"
printf 'new state rollback\n' >"$state_seed/skills/hyperresearch/SKILL.md"
if PYTHONPATH="$exchange_hook_dir" \
  PATH="$fake_bin:$PATH" \
  TRELLAGE_TEST_EXCHANGE_TARGET="$state_runtime/.claude.json" \
  TRELLAGE_TEST_EXCHANGE_MARKER="$root/state-fail-marker" \
  TRELLAGE_TEST_EXCHANGE_REPLACE_PATH="$state_runtime/settings.json" \
  TRELLAGE_TEST_EXCHANGE_REPLACE_CONTENT=$'concurrent settings replacement\n' \
  TRELLAGE_TEST_EXCHANGE_ACTION=fail \
  TRELLAGE_CLAUDE_SEED_HOME="$state_seed" \
  TRELLAGE_CLAUDE_HOME="$state_runtime" \
  TRELLAGE_CLAUDE_AUTH_MODE=native \
  CLAUDE_ARGS_OUT="$root/state-fail-args" CLAUDE_CONFIG_OUT="$root/state-fail-config" \
  CLAUDE_CONFIG_PATH_OUT="$root/state-fail-config-path" CLAUDE_ENV_OUT="$root/state-fail-env" \
  "$entry" new claude --print hello >"$root/state-fail.out" 2>"$root/state-fail.err"; then
  printf 'expected late Claude state publication to fail\n' >&2
  exit 1
fi
grep -Fqx 'concurrent settings replacement' "$state_runtime/settings.json" \
  || { printf 'rollback replaced a concurrent Claude settings update\n' >&2; exit 1; }
grep -Fqx 'prior state rollback' "$state_runtime/skills/hyperresearch/SKILL.md"
[[ -f "$state_runtime/.trellage-claude.lock" \
  && ! -L "$state_runtime/.trellage-claude.lock" ]]
[[ -z "$(find "$state_runtime" -maxdepth 1 -name '.trellage-claude-transaction.*' -print -quit)" ]]

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
if PATH="$fake_bin:$PATH" \
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
[[ ! -e "$core_runtime/output-styles/rundown.md" ]]

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
