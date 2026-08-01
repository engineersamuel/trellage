#!/usr/bin/env bash
set -euo pipefail

prototype_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
adapter="$prototype_dir/adapt-agent-kit.sh"
fixture_root="$(mktemp -d "${TMPDIR:-/tmp}/trellage-agent-kit-adapter-test.XXXXXX")"
trap 'rm -rf -- "$fixture_root"' EXIT

fail() {
  printf 'Trellage agent kit adapter test: FAIL: %s\n' "$1" >&2
  exit 1
}

[[ -x "$adapter" ]] || fail 'adapter is missing or not executable'

missing_error="$fixture_root/missing.error"
if "$adapter" "$fixture_root/missing" 2>"$missing_error"; then
  fail 'adapter accepted a missing agent kit root'
fi
grep -Fq 'Trellage plugin adapter: missing agent directory:' "$missing_error" \
  || fail 'missing-root error does not use Trellage identity'

agent_dir="$fixture_root/kit/.codex/agents"
skill_dir="$fixture_root/kit/.codex/skills/example/references"
mkdir -p -- "$agent_dir" "$skill_dir"
printf 'name = "full-stack-orchestration__deployment-engineer"\n' \
  >"$agent_dir/deployment-engineer.toml"
details="$skill_dir/details.md"
printf '%s\n' \
  'subagent_type: "general-purpose"' \
  'subagent_type: "full-stack-orchestration-deployment-engineer"' \
  >"$details"
"$adapter" "$fixture_root/kit"

grep -Fq 'subagent_type: "general-purpose"' "$details" \
  || fail 'adapter changed an external agent-kit reference'
grep -Fq 'subagent_type: "full-stack-orchestration__deployment-engineer"' \
  "$details" || fail 'adapter did not resolve the generated agent reference'
if grep -Fq 'full-stack-orchestration-deployment-engineer' "$details"; then
  fail 'legacy external agent-kit reference remains'
fi

failure_kit="$fixture_root/failure-kit"
failure_agent_dir="$failure_kit/.codex/agents"
failure_skill_dir="$failure_kit/.codex/skills/example"
failure_tmp="$fixture_root/failure-tmp"
failure_bin="$fixture_root/failure-bin"
mkdir -p -- "$failure_agent_dir" "$failure_skill_dir" "$failure_tmp" "$failure_bin"
printf 'name = "full-stack-orchestration__deployment-engineer"\n' \
  >"$failure_agent_dir/deployment-engineer.toml"
printf 'subagent_type: "full-stack-orchestration-deployment-engineer"\n' \
  >"$failure_skill_dir/SKILL.md"
printf 'preserve\n' >"$failure_tmp/unrelated-sentinel"
cat >"$failure_bin/cp" <<'EOF'
#!/usr/bin/env bash
exit 42
EOF
chmod 0755 "$failure_bin/cp"

if TMPDIR="$failure_tmp" PATH="$failure_bin:/usr/bin:/bin" "$adapter" "$failure_kit"; then
  fail 'adapter accepted an injected post-mktemp copy failure'
fi
[[ -f "$failure_tmp/unrelated-sentinel" ]] \
  || fail 'failure cleanup removed an unrelated temporary file'
if find "$failure_tmp" -maxdepth 1 -type f -name 'trellage-agent-kit-adapter.*' -print -quit \
  | grep -q .; then
  fail 'adapter leaked its temporary file after copy failure'
fi

printf 'Trellage agent kit adapter test: PASS\n'
