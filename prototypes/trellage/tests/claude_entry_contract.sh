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
cp "$config" "$CLAUDE_CONFIG_OUT"
env | LC_ALL=C sort >"$CLAUDE_ENV_OUT"
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
CLAUDE_ARGS_OUT="$args_out" CLAUDE_CONFIG_OUT="$config_out" CLAUDE_ENV_OUT="$env_out" \
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
grep -Fq -- '--mcp-config' "$args_out"
dangerous_line="$(grep -nFx -- '--dangerously-skip-permissions' "$args_out" | cut -d: -f1)"
separator_line="$(grep -nFx -- '--' "$args_out" | cut -d: -f1)"
if [[ "$dangerous_line" -ge "$separator_line" ]]; then
  printf 'managed Claude flags must precede the user argument separator\n' >&2
  exit 1
fi

no_token_config="$root/no-token-config"
warning="$root/warning"
printf 'keep settings\n' >"$runtime/settings.json"
PATH="$fake_bin:$PATH" \
TRELLAGE_CLAUDE_SEED_HOME="$seed" \
TRELLAGE_CLAUDE_HOME="$runtime" \
TRELLAGE_CLAUDE_AUTH_MODE=native \
CLAUDE_ARGS_OUT="$root/no-token-args" CLAUDE_CONFIG_OUT="$no_token_config" CLAUDE_ENV_OUT="$root/no-token-env" \
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
  CLAUDE_ARGS_OUT="$root/fail-args" CLAUDE_CONFIG_OUT="$root/fail-config" CLAUDE_ENV_OUT="$root/fail-env" \
  "$entry" new claude --print hello >/dev/null 2>&1; then
  printf 'expected invalid managed seed to fail\n' >&2
  exit 1
fi
grep -Fqx 'before rollback' "$runtime/skills/hyperresearch/SKILL.md"
grep -Fqx 'keep settings' "$runtime/settings.json"

printf 'claude entry contract: PASS\n'
