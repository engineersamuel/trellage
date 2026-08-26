#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

fail() {
  printf 'graph-of-loops image probe: FAIL: %s\n' "$1" >&2
  exit 1
}

image="${TRELLAGE_GRAPH_OF_LOOPS_IMAGE:-trellage-profile-claude-graph-of-loops-linux-arm64:locked}"
docker image inspect "$image" >/dev/null 2>&1 \
  || fail "image is missing: $image"

run() {
  docker run --rm --init --entrypoint /usr/bin/fish "$image" -lc "$1"
}

run_bash() {
  docker run --rm --init --entrypoint /bin/bash "$image" -lc "$1"
}

bernstein_version="$(run 'bernstein --version' || true)"
[[ "$bernstein_version" == *3.16.0* ]] \
  || fail "bernstein is not the pinned 3.16.0 CLI: $bernstein_version"

run 'wt --help' | grep -Fq 'wt new' \
  || fail 'wt wrapper is missing the new/ls/merge contract'

run 'python -c "import inspect, waku.loop.agent as agent; source = inspect.getsource(agent); assert \"max_iterations\" in source"' \
  || fail 'waku loop source is not importable'

run 'serena --help >/dev/null' \
  || fail 'serena CLI is missing'

run 'test -x /usr/local/bin/bd && bd version' \
  || fail 'bd binary is missing'

run 'test -x /usr/local/bin/bv && bv --version' \
  || fail 'bv binary is missing'

run 'test -x /usr/local/bin/raindrop' \
  || fail 'raindrop binary is missing'

run 'test -x /usr/local/bin/codex && codex --version' \
  || fail 'Codex reviewer binary is missing'

run 'test -x /usr/local/bin/codex-code-mode-host' \
  || fail 'Codex code-mode host is missing'

run 'python -c '\''import tomllib; config = tomllib.load(open("/home/agent/.codex/config.toml", "rb")); assert config["model_provider"] == "copilot_proxy"; assert config["approval_policy"] == "never"; assert config["sandbox_mode"] == "danger-full-access"; assert config["model_providers"]["copilot_proxy"]["base_url"] == "http://copilot-proxy-rs:8080/v1"; assert config["features"]["multi_agent"] is True'\''' \
  || fail 'Codex reviewer is not configured for copilot-proxy-rs'

run 'test -f /etc/codex/skills/graph-of-loops/SKILL.md && grep -Fq '\''name: graph-of-loops'\'' /etc/codex/skills/graph-of-loops/SKILL.md && grep -Fq '\''OBJECTIVE='\'' /etc/codex/skills/graph-of-loops/SKILL.md && grep -Fq '\''CONSTRAINTS='\'' /etc/codex/skills/graph-of-loops/SKILL.md && grep -Fq '\''allow_implicit_invocation: false'\'' /etc/codex/skills/graph-of-loops/agents/openai.yaml' \
  || fail 'Codex graph-of-loops skill is missing or malformed'

run 'test -f /usr/local/share/trellage/claude-mcp.json && grep -Fq serena /usr/local/share/trellage/claude-mcp.json' \
  || fail 'serena MCP config is missing'

run 'uv --version && uvx --version' \
  || fail 'Serena uv/uvx runtime is missing'

run 'test "$BD_DISABLE_METRICS" = 1 && test "$BD_DISABLE_EVENT_FLUSH" = 1' \
  || fail 'Beads telemetry opt-out is missing'

run 'test "$NODE_PATH" = /usr/local/lib/trellage/node_modules && node -e '\''process.stdout.write(require.resolve("lefthook-linux-arm64/bin/lefthook"))'\'' | string match -q "*/lefthook-linux-arm64/bin/lefthook"' \
  || fail 'Lefthook Linux ARM64 package is not resolvable'

run '/usr/local/lib/trellage/node_modules/lefthook-linux-arm64/bin/lefthook version' \
  || fail 'Lefthook Linux ARM64 binary does not run'

run 'test -d /usr/local/share/trellage/claude-seed/plugins/cache' \
  || fail 'Claude plugin cache is missing'

run 'grep -Fq test-driven-development /usr/local/share/trellage/claude-seed/managed-paths.txt || find /usr/local/share/trellage/claude-seed -name SKILL.md | grep -q test-driven-development' \
  || fail 'Superpowers TDD skill is missing from the seed'

run 'gh --version >/dev/null' \
  || fail 'gh is missing'

seed='/usr/local/share/trellage/claude-seed'
run "test -f $seed/plugins/installed_plugins.json" \
  || fail 'installed plugin registry is missing'
run "grep -Fq 'superpowers@superpowers-dev' $seed/plugins/installed_plugins.json" \
  || fail 'superpowers plugin is not installed'
run "grep -Fq 'insane-research@insane-research' $seed/plugins/installed_plugins.json" \
  || fail 'insane-research plugin is not installed'
run "grep -Fq 'beads@beads-marketplace' $seed/plugins/installed_plugins.json" \
  || fail 'beads plugin is not installed'
run "grep -Fq 'review-loop@hamel-review' $seed/plugins/installed_plugins.json" \
  || fail 'review-loop plugin is not installed'
run "grep -Fq 'full-stack-orchestration@claude-code-workflows' $seed/plugins/installed_plugins.json" \
  || fail 'wshobson full-stack-orchestration is not installed'
run "grep -Fq 'conductor@claude-code-workflows' $seed/plugins/installed_plugins.json" \
  || fail 'wshobson conductor is not installed'

run "find $seed -name SKILL.md | grep -q test-driven-development" \
  || fail 'Superpowers TDD skill file is missing'
run "find $seed/plugins/cache/hamel-review -name hooks.json | grep -q ." \
  || fail 'review-loop Stop hook is missing'
run "find $seed/plugins/cache/insane-research -name '*.md' | grep -qi insane" \
  || fail 'insane-research command/skill files are missing'

run 'mkdir -p /tmp/home; set -gx HOME /tmp/home; set tmp (mktemp -d); cd $tmp; git init -q; git config user.email probe@trellage; git config user.name probe; echo hi > README; git add README; git commit -q -m init; bd init --stealth --quiet; bd create "probe" -p 0 >/dev/null; bd ready --json | string match -q "*probe*"' \
  || fail 'bd init/create/ready does not work'

run_bash 'set -e; home="$(mktemp -d)"; export HOME="$home"; repo="$(mktemp -d)"; cd "$repo"; git init -q; git config user.email probe@trellage; git config user.name probe; printf "#!/bin/sh\nnode -e '\''const { spawnSync } = require(\"node:child_process\"); const result = spawnSync(require.resolve(\"lefthook-linux-arm64/bin/lefthook\"), [\"version\"]); process.exit(result.status ?? 1)'\''\n" >.git/hooks/pre-commit; chmod +x .git/hooks/pre-commit; echo hook >hook.txt; git add hook.txt; git commit -q -m hook' \
  || fail 'normal Git commit could not run the Lefthook package hook'

run_bash 'set -e; home="$(mktemp -d)"; export HOME="$home"; repo="$(mktemp -d)"; cd "$repo"; git init -q -b main; git config user.email probe@trellage; git config user.name probe; echo base >base.txt; git add base.txt; git commit -q -m base; git checkout -q -b feature; echo feature >feature.txt; git add feature.txt; git commit -q -m feature; git checkout -q main; wt merge feature >/dev/null; test "$(cat feature.txt)" = feature' \
  || fail 'wt merge did not merge the named source branch'

run_bash 'set -e; home="$(mktemp -d)"; export HOME="$home"; repo="$(mktemp -d)"; cd "$repo"; git init -q -b main; git config user.email probe@trellage; git config user.name probe; echo base >same.txt; git add same.txt; git commit -q -m base; git checkout -q -b feature; echo feature >same.txt; git commit -qam feature; git checkout -q main; echo main >same.txt; git commit -qam main; if wt merge feature >/dev/null 2>&1; then exit 1; fi; test ! -e .git/MERGE_HEAD; test "$(cat same.txt)" = main; test -z "$(git status --porcelain)"' \
  || fail 'wt merge did not roll back a conflicting merge'

run_bash 'set -e; repo="$(mktemp -d)"; cd "$repo"; git init -q; if wt merge >/dev/null 2>&1; then exit 1; fi; if wt merge missing >/dev/null 2>&1; then exit 1; fi' \
  || fail 'wt merge accepted a missing or unknown source branch'

run 'mkdir -p /tmp/home; set -gx HOME /tmp/home; set -gx AGENT_WORKTREE_DIR /tmp/wt; set tmp (mktemp -d); cd $tmp; git init -q; git config user.email probe@trellage; git config user.name probe; echo hi > README; git add README; git commit -q -m init; wt new probe-branch >/dev/null; wt ls | string match -q "*probe-branch*"' \
  || fail 'wt new/ls does not create an isolated worktree'

run_bash 'set -e; home="$(mktemp -d)"; export HOME="$home"; repo="$(mktemp -d)"; cd "$repo"; git init -q; git config user.email probe@trellage; git config user.name probe; echo base >README; git add README; git commit -q -m init; bd init --stealth --quiet; before="$(find /proc -maxdepth 1 -type d -regex "/proc/[0-9]+" | wc -l)"; for _ in $(seq 1 20); do bd ready --json >/dev/null; done; sleep 1; after="$(find /proc -maxdepth 1 -type d -regex "/proc/[0-9]+" | wc -l)"; test "$after" -le "$((before + 1))"; for status in /proc/[0-9]*/status; do if grep -q "^Name:.*bd" "$status" && grep -q "^State:.*Z" "$status"; then exit 1; fi; done' \
  || fail 'repeated Beads commands leaked processes or zombies'

printf 'graph-of-loops image probe: PASS\n'
