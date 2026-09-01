#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

fail() {
  printf 'claude-ecc image probe: FAIL: %s\n' "$1" >&2
  exit 1
}

image="${TRELLAGE_CLAUDE_ECC_IMAGE:-trellage-profile-claude-ecc-linux-arm64:locked}"
docker image inspect "$image" >/dev/null 2>&1 \
  || fail "image is missing: $image"

run() {
  docker run --rm --init --entrypoint /bin/bash "$image" -lc "$1"
}

seed='/usr/local/share/trellage/claude-seed'

run "test -f $seed/plugins/installed_plugins.json" \
  || fail 'installed plugin registry is missing'
run "jq -e '
  .plugins[\"ecc@ecc\"] as \$records
  | (\$records | length) == 1
    and \$records[0].scope == \"user\"
    and (\$records[0].version | type == \"string\" and length > 0)
' $seed/plugins/installed_plugins.json >/dev/null" \
  || fail 'ecc plugin registration is invalid'

run "set -e
  plugin_parent=$seed/plugins/cache/ecc/ecc
  test -d \"\$plugin_parent\"
  test \"\$(find \"\$plugin_parent\" -mindepth 1 -maxdepth 1 -type d | wc -l)\" -eq 1
  plugin_root=\"\$(find \"\$plugin_parent\" -mindepth 1 -maxdepth 1 -type d -print -quit)\"
  test -f \"\$plugin_root/.claude-plugin/plugin.json\"
  test -f \"\$plugin_root/package.json\"
  test -f \"\$plugin_root/package-lock.json\"
  test -f \"\$plugin_root/hooks/hooks.json\"
  test -n \"\$(find \"\$plugin_root/skills\" -name SKILL.md -type f -print -quit)\"
  test -n \"\$(find \"\$plugin_root/agents\" -name '*.md' -type f -print -quit)\"
  test -n \"\$(find \"\$plugin_root/commands\" -name '*.md' -type f -print -quit)\"
  test -z \"\$(find \"\$plugin_root\" -type l -print -quit)\"
  cd \"\$plugin_root\"
  for command in orch-add-feature orch-fix-defect orch-change-feature orch-refine-code code-review security-scan test-coverage; do
    test -f \"commands/\$command.md\"
  done
  for skill in orch-add-feature orch-fix-defect production-audit verification-loop tdd-workflow; do
    test -f \"skills/\$skill/SKILL.md\"
  done
  for agent in code-architect tdd-guide code-reviewer security-reviewer silent-failure-hunter; do
    test -f \"agents/\$agent.md\"
  done
  node -e 'for (const name of [\"@iarna/toml\", \"ajv\", \"js-yaml\", \"sql.js\"]) require.resolve(name)'
  jq -e '(.mcpServers // {}) == {}' .claude-plugin/plugin.json >/dev/null
  jq -e '
    .hooks.SessionStart
    and .hooks.PreToolUse
    and .hooks.PostToolUse
    and .hooks.SessionEnd
  ' hooks/hooks.json >/dev/null
  ! grep -Fq 'auto-update' hooks/hooks.json" \
  || fail 'ECC plugin cache, prompt entry points, or runtime dependencies are incomplete'

run "set -e
  plugin_parent=$seed/plugins/cache/ecc/ecc
  plugin_root=\"\$(find \"\$plugin_parent\" -mindepth 1 -maxdepth 1 -type d -print -quit)\"
  test -n \"\$plugin_root\"
  test -d \"\$plugin_root\"
  cd \"\$plugin_root\"
  for hook in post-edit-accumulator stop-format-typecheck; do
    hook_script=\"scripts/hooks/\$hook.js\"
    test -f \"\$hook_script\"
    grep -Fq 'function trellageHookSessionId(rawInput) {' \"\$hook_script\"
    grep -Fq 'function getAccumFile(hookSessionId) {' \"\$hook_script\"
    grep -Fq 'const raw = hookSessionId;' \"\$hook_script\"
    ! grep -Fq 'process.env.CLAUDE_SESSION_ID' \"\$hook_script\"
    ! grep -Fq 'process.env.TRELLAGE_HERDR_INVOCATION_ID' \"\$hook_script\"
    test \"\$(grep -Fc 'function getAccumFile() {' \"\$hook_script\" || true)\" -eq 0
  done
  grep -Fq 'const hookSessionId = trellageHookSessionId(rawInput);' scripts/hooks/post-edit-accumulator.js
  grep -Fq 'if (!hookSessionId) return rawInput;' scripts/hooks/post-edit-accumulator.js
  grep -Fq 'appendPath(input.tool_input?.file_path, hookSessionId);' scripts/hooks/post-edit-accumulator.js
  grep -Fq 'function main(hookSessionId) {' scripts/hooks/stop-format-typecheck.js
  grep -Fq 'if (!hookSessionId) return;' scripts/hooks/stop-format-typecheck.js
  grep -Fq 'main(trellageHookSessionId(rawInput));' scripts/hooks/stop-format-typecheck.js" \
  || fail 'ECC accumulator hooks are not scoped to the Claude session'

run "test ! -e $seed/claude-mcp.json" \
  || fail 'ECC repository MCP configuration became an active Trellage MCP'
run 'gh --version >/dev/null' \
  || fail 'gh is missing'

printf 'claude-ecc image probe: PASS\n'
