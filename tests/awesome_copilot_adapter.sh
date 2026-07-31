#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

fail() {
  printf 'awesome copilot adapter: FAIL: %s\n' "$1" >&2
  exit 1
}

adapter='scripts/materialize-awesome-plugin.sh'
[[ -x "$adapter" ]] || fail "missing executable adapter: $adapter"

fixture_root="$(mktemp -d)"
cleanup() {
  chmod -R u+w "$fixture_root" 2>/dev/null || true
  rm -rf "$fixture_root"
}
trap cleanup EXIT

source_root="$fixture_root/source"
output_root="$fixture_root/output"

mkdir -p \
  "$source_root/plugins/frontend-web-dev/.github/plugin" \
  "$source_root/plugins/testing-automation/.github/plugin" \
  "$source_root/plugins/unsafe-mcp/.github/plugin" \
  "$source_root/agents" \
  "$source_root/skills/browser-test/references" \
  "$source_root/skills/unit-test"

cat >"$source_root/plugins/frontend-web-dev/.github/plugin/plugin.json" <<'EOF'
{
  "name": "frontend-web-dev",
  "description": "Frontend fixture",
  "version": "1.0.0",
  "agents": ["./agents/expert-react.md"],
  "skills": ["./skills/browser-test/"]
}
EOF

cat >"$source_root/plugins/testing-automation/.github/plugin/plugin.json" <<'EOF'
{
  "name": "testing-automation",
  "description": "Testing fixture",
  "version": "1.0.0",
  "agents": ["./agents/tdd-red.md"],
  "skills": ["./skills/unit-test/"]
}
EOF

cat >"$source_root/plugins/unsafe-mcp/.github/plugin/plugin.json" <<'EOF'
{
  "name": "unsafe-mcp",
  "description": "Must be rejected",
  "version": "1.0.0",
  "mcpServers": {
    "unsafe": {
      "command": "docker",
      "args": ["run", "example/image:latest"]
    }
  }
}
EOF

printf '%s\n' '# React expert fixture' >"$source_root/agents/expert-react.agent.md"
printf '%s\n' '# TDD red fixture' >"$source_root/agents/tdd-red.agent.md"
printf '%s\n' '---' 'name: browser-test' 'description: Browser test fixture' '---' \
  >"$source_root/skills/browser-test/SKILL.md"
printf '%s\n' '# Browser reference' >"$source_root/skills/browser-test/references/details.md"
printf '%s\n' '---' 'name: unit-test' 'description: Unit test fixture' '---' \
  >"$source_root/skills/unit-test/SKILL.md"

"$adapter" "$source_root" "$output_root" frontend-web-dev testing-automation

for plugin_name in frontend-web-dev testing-automation; do
  manifest="$output_root/$plugin_name/.github/plugin/plugin.json"
  [[ -f "$manifest" ]] || fail "missing materialized manifest: $manifest"
  jq -e --arg name "$plugin_name" '.name == $name' "$manifest" >/dev/null \
    || fail "materialized manifest name mismatch: $plugin_name"
done

[[ -f "$output_root/frontend-web-dev/agents/expert-react.md" ]] \
  || fail 'source .agent.md was not normalized to plugin manifest path'
[[ -f "$output_root/testing-automation/agents/tdd-red.md" ]] \
  || fail 'testing agent was not materialized'
[[ -f "$output_root/frontend-web-dev/skills/browser-test/SKILL.md" ]] \
  || fail 'frontend skill was not materialized'
[[ -f "$output_root/frontend-web-dev/skills/browser-test/references/details.md" ]] \
  || fail 'nested skill resources were not copied'
[[ -f "$output_root/testing-automation/skills/unit-test/SKILL.md" ]] \
  || fail 'testing skill was not materialized'

if "$adapter" "$source_root" "$fixture_root/unsafe-output" unsafe-mcp \
  >"$fixture_root/unsafe.stdout" 2>"$fixture_root/unsafe.stderr"; then
  fail 'Docker-backed MCP plugin was accepted'
fi
grep -Fq 'unsupported mcpServers' "$fixture_root/unsafe.stderr" \
  || fail 'unsafe MCP rejection did not explain the unsupported surface'

if "$adapter" "$source_root" "$fixture_root/traversal-output" '../frontend-web-dev' \
  >"$fixture_root/traversal.stdout" 2>"$fixture_root/traversal.stderr"; then
  fail 'unsafe plugin identifier was accepted'
fi
grep -Fq 'invalid plugin name' "$fixture_root/traversal.stderr" \
  || fail 'unsafe plugin identifier rejection was unclear'

printf 'awesome copilot adapter: PASS\n'
