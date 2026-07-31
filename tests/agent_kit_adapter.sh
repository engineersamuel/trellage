#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

adapter='scripts/adapt-agent-kit.sh'
[[ -x "$adapter" ]] || {
  printf 'agent kit adapter: FAIL: missing executable %s\n' "$adapter" >&2
  exit 1
}

fixture_dir="$(mktemp -d)"
cleanup() {
  chmod -R u+w "$fixture_dir" 2>/dev/null || true
  rm -rf "$fixture_dir"
}
trap cleanup EXIT

mkdir -p \
  "$fixture_dir/.codex/agents" \
  "$fixture_dir/.codex/skills/full-stack-orchestration__full-stack-feature/references"

for role in deployment-engineer performance-engineer security-auditor test-automator; do
  printf 'name = "full-stack-orchestration__%s"\n' "$role" \
    >"$fixture_dir/.codex/agents/full-stack-orchestration__${role}.toml"
done

details="$fixture_dir/.codex/skills/full-stack-orchestration__full-stack-feature/references/details.md"
cat >"$details" <<'EOF'
subagent_type: "general-purpose"
subagent_type: "full-stack-orchestration-deployment-engineer"
subagent_type: "full-stack-orchestration-performance-engineer"
subagent_type: "full-stack-orchestration-security-auditor"
subagent_type: "full-stack-orchestration-test-automator"
EOF
chmod 0444 "$details"
chmod 0555 "$(dirname "$details")"

"$adapter" "$fixture_dir"

grep -Fq 'subagent_type: "general-purpose"' "$details"
for role in deployment-engineer performance-engineer security-auditor test-automator; do
  grep -Fq "subagent_type: \"full-stack-orchestration__${role}\"" "$details" || {
    printf 'agent kit adapter: FAIL: unresolved generated agent %s\n' "$role" >&2
    exit 1
  }
done

if grep -Eq 'subagent_type: "full-stack-orchestration-[^"]+"' "$details"; then
  printf 'agent kit adapter: FAIL: legacy hyphenated agent reference remains\n' >&2
  exit 1
fi
[[ ! -w "$details" ]] || {
  printf 'agent kit adapter: FAIL: adapted skill permissions became writable\n' >&2
  exit 1
}

printf 'agent kit adapter: PASS\n'
