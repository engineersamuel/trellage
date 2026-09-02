#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

fail() {
  printf 'claude-ecc image probe: FAIL: %s\n' "$1" >&2
  exit 1
}

if [[ -n "${TRELLAGE_CLAUDE_ECC_IMAGE:-}" ]]; then
  image="$TRELLAGE_CLAUDE_ECC_IMAGE"
else
  docker_platform="$(docker version --format '{{.Server.Os}}/{{.Server.Arch}}')" \
    || fail 'cannot determine the Docker server platform'
  case "$docker_platform" in
    linux/amd64|linux/arm64) ;;
    *) fail "unsupported Docker server platform: $docker_platform" ;;
  esac
  image="trellage-profile-claude-ecc-${docker_platform/\//-}:locked"
fi
docker image inspect "$image" >/dev/null 2>&1 \
  || fail "image is missing: $image"

run() {
  docker run --rm --init --entrypoint /bin/bash "$image" -lc "$1"
}

probe_runtime_sync() {
  docker run --rm --init --entrypoint /bin/bash "$image" -s <<'PROBE'
set -euo pipefail

seed=/usr/local/share/trellage/claude-seed
probe_root="$(mktemp -d)"
runtime="$probe_root/runtime"
fake_bin="$probe_root/bin"
operations="$probe_root/file-operations"
real_cp="$(command -v cp)"
real_mv="$(command -v mv)"
mkdir -p "$runtime" "$fake_bin"
: >"$operations"
printf 'preserve unmanaged state\n' >"$runtime/user-state"

cat >"$fake_bin/claude" <<'SH'
#!/usr/bin/env bash
exit 0
SH
cat >"$fake_bin/cp" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf 'cp\n' >>"${TRELLAGE_PROBE_OPERATIONS:?}"
exec "${TRELLAGE_PROBE_REAL_CP:?}" "$@"
SH
cat >"$fake_bin/mv" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf 'mv\n' >>"${TRELLAGE_PROBE_OPERATIONS:?}"
exec "${TRELLAGE_PROBE_REAL_MV:?}" "$@"
SH
chmod +x "$fake_bin/claude" "$fake_bin/cp" "$fake_bin/mv"

PATH="$fake_bin:$PATH" \
TRELLAGE_PROBE_OPERATIONS="$operations" \
TRELLAGE_PROBE_REAL_CP="$real_cp" \
TRELLAGE_PROBE_REAL_MV="$real_mv" \
TRELLAGE_CLAUDE_SEED_HOME="$seed" \
TRELLAGE_CLAUDE_HOME="$runtime" \
TRELLAGE_CLAUDE_AUTH_MODE=native \
TRELLAGE_CLAUDE_RUNTIME_MODE=native-plugin \
  /usr/local/bin/trellage-claude-entry new claude --print probe \
  >"$probe_root/stdout" 2>"$probe_root/stderr"

test "$(wc -l <"$seed/managed-paths.txt")" -ge 1000
grep -Fq 'synchronizing ' "$probe_root/stderr"
grep -Fq 'managed Claude files are ready' "$probe_root/stderr"
cmp -s "$seed/managed-paths.txt" "$runtime/.trellage-claude-managed"
test -f "$runtime/plugins/installed_plugins.json"
grep -Fqx 'preserve unmanaged state' "$runtime/user-state"
test "$(wc -l <"$operations")" -lt 100
PROBE
}

seed='/usr/local/share/trellage/claude-seed'

run "test -f $seed/plugins/installed_plugins.json" \
  || fail 'installed plugin registry is missing'
run "jq -e '
  .plugins[\"ecc@ecc\"] as \$records
  | (\$records | length) == 1
    and \$records[0].scope == \"user\"
    and (\$records[0].version | type == \"string\" and length > 0)
    and (\$records[0].gitCommitSha | test(\"^[0-9a-f]{40}$\"))
' $seed/plugins/installed_plugins.json >/dev/null" \
  || fail 'ECC plugin registration is invalid'

run "set -e
  plugin_parent=$seed/plugins/cache/ecc/ecc
  test -d \"\$plugin_parent\"
  test \"\$(find \"\$plugin_parent\" -mindepth 1 -maxdepth 1 -type d | wc -l)\" -eq 1
  plugin_root=\"\$(find \"\$plugin_parent\" -mindepth 1 -maxdepth 1 -type d -print -quit)\"
  test -f \"\$plugin_root/.claude-plugin/plugin.json\"
  test -f \"\$plugin_root/package.json\"
  test -f \"\$plugin_root/package-lock.json\"
  test ! -e \"\$plugin_root/yarn.lock\"
  test -f \"\$plugin_root/hooks/hooks.json\"
  test ! -e \"\$plugin_root/.mcp.json\"
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
  jq -e 'has(\"mcpServers\") | not' .claude-plugin/plugin.json >/dev/null
  jq -e '
    [.plugins[] | select(.name == \"ecc\")] as \$plugins
    | (\$plugins | length) == 1
      and (\$plugins[0] | has(\"mcpServers\") | not)
  ' .claude-plugin/marketplace.json >/dev/null
  jq -e '
    .hooks.SessionStart
    and .hooks.PreToolUse
    and .hooks.PostToolUse
    and .hooks.SessionEnd
  ' hooks/hooks.json >/dev/null
  commands=\"\$(jq -r '.. | objects | .command? // empty' hooks/hooks.json)\"
  grep -F 'stop:plan-canvas-pending' <<<\"\$commands\" | grep -Fq \"'minimal,standard,strict'\"
  grep -F 'stop:format-typecheck' <<<\"\$commands\" | grep -Fq \"'standard,strict'\"
  ! grep -F 'stop:format-typecheck' <<<\"\$commands\" | grep -Fq \"'minimal,standard,strict'\"
  ! grep -Fq 'auto-update' hooks/hooks.json" \
  || fail 'ECC cache, entry points, dependencies, or minimal hook gates are incomplete'

run "test ! -e $seed/claude-mcp.json" \
  || fail 'ECC repository MCP configuration became an active Trellage MCP'
probe_runtime_sync \
  || fail 'transactional Claude seed synchronization failed'
run 'gh --version >/dev/null' \
  || fail 'gh is missing'

printf 'claude-ecc image probe: PASS\n'
