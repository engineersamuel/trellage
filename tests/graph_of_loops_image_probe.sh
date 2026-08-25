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
  docker run --rm --entrypoint /usr/bin/fish "$image" -lc "$1"
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

run 'test -x /usr/local/bin/raindrop' \
  || fail 'raindrop binary is missing'

run 'test -f /usr/local/share/trellage/claude-mcp.json && grep -Fq serena /usr/local/share/trellage/claude-mcp.json' \
  || fail 'serena MCP config is missing'

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

run 'mkdir -p /tmp/home; set -gx HOME /tmp/home; set -gx AGENT_WORKTREE_DIR /tmp/wt; set tmp (mktemp -d); cd $tmp; git init -q; git config user.email probe@trellage; git config user.name probe; echo hi > README; git add README; git commit -q -m init; wt new probe-branch >/dev/null; wt ls | string match -q "*probe-branch*"' \
  || fail 'wt new/ls does not create an isolated worktree'

printf 'graph-of-loops image probe: PASS\n'
