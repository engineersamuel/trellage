#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

fail() {
  printf 'graph-of-loops image probe: FAIL: %s\n' "$1" >&2
  exit 1
}

# The Trellage launcher adds the platform suffix when it imports a locked image.
image="${TRELLAGE_GRAPH_OF_LOOPS_IMAGE:-trellage-profile-claude-graph-of-loops-linux-arm64:locked}"
docker image inspect "$image" >/dev/null 2>&1 \
  || fail "image is missing: $image (build it with: make graph-of-loops-image)"

run() {
  docker run --rm --init --entrypoint /usr/bin/fish "$image" -lc "$1"
}

run_bash() {
  docker run --rm --init --entrypoint /bin/bash "$image" -c "$1"
}

# Feeds a Python script on stdin while preserving the image's locked PATH and
# environment (PYTHONPATH, TRELLAGE_GRAPH_POLICY, ...).
# $1 is a hard wall-clock budget in seconds enforced inside the container so
# a wedged subprocess (MCP server, language server, ...) cannot hang `make`.
run_py() {
  local budget="$1"
  docker run --rm -i --init --entrypoint /bin/bash "$image" -c "exec timeout ${budget} python3 -"
}

seed='/usr/local/share/trellage/claude-seed'
runtime='/opt/trellage/graph-of-loops'
policy='/usr/local/share/trellage/graph-of-loops-policy.json'

run 'command -v make >/dev/null' \
  || fail "make is not installed in the locked Graph image"
run_bash '
  grep -Fq "export TMPDIR=" /usr/local/bin/trellage-graph
  dir=/home/agent/.cache/trellage-tmp
  mkdir -p "$dir"
  printf "#!/bin/sh\nexit 0\n" >"$dir/exec-probe"
  chmod 0700 "$dir/exec-probe"
  "$dir/exec-probe"
' || fail "Graph launcher TMPDIR is not executable"

# ---------------------------------------------------------------------------
# CLI entrypoint
#
# Assert real usage output from the installed wrapper, then use the package
# entry point for the remaining functional checks.
# ---------------------------------------------------------------------------

trellage_graph_help_output="$(run 'trellage-graph --help' 2>&1 || true)"
printf '%s\n' "$trellage_graph_help_output" | grep -qi 'usage' \
  || fail "trellage-graph --help produced no usage output; the wrapper (python -m trellage_graph.cli) likely needs cli.py's __main__ guard or a wrapper fix. Output was: ${trellage_graph_help_output}"

run 'python -m trellage_graph --help >/dev/null' \
  || fail 'python -m trellage_graph --help does not succeed'
run 'bwrap --version | grep -Eq "^bubblewrap [0-9]"' \
  || fail 'bubblewrap required by read-only Codex review is missing'

# Trellage mounts persistent state over /home/agent. The runtime entrypoint
# must restore the locked Cargo target configuration after that mount hides
# the image-baked copy.
docker run --rm --init \
  --tmpfs '/home/agent:rw,exec,nosuid,nodev,size=64m,uid=10001,gid=10001' \
  --entrypoint /usr/local/bin/trellage-claude-entry \
  "$image" passthrough /bin/sh -c \
  'test -f "$CARGO_HOME/config.toml" && grep -Fq '\''target = "aarch64-unknown-linux-musl"'\'' "$CARGO_HOME/config.toml"' \
  || fail 'Claude runtime entry does not restore the locked Cargo configuration'

# ---------------------------------------------------------------------------
# Consistent Rust toolchain and portable musl linkers
# ---------------------------------------------------------------------------

# The Rust toolchain floats with the stable channel, so the probe requires a
# single consistent rustc/cargo release rather than one pinned version.
rust_version="$(run 'rustc --version' | sed -n 's/^rustc \([0-9][0-9.]*\).*/\1/p')"
[[ -n "$rust_version" ]] || fail 'rustc did not report a release version'

run "cargo --version | grep -Fq \"cargo $rust_version\"" \
  || fail "cargo does not match the installed rustc release $rust_version"

run 'rustfmt --version >/dev/null && cargo clippy --version >/dev/null' \
  || fail 'rustfmt or Clippy is missing'

run 'test -d "$(rustc --print target-libdir --target aarch64-unknown-linux-musl)" && test -d "$(rustc --print target-libdir --target x86_64-unknown-linux-musl)" && test -d "$(rustc --print target-libdir --target i686-unknown-linux-musl)"' \
  || fail 'one or more locked musl standard libraries are missing'

run_bash 'project="$(mktemp -d)"; trap '\''rm -rf -- "$project"'\'' EXIT; cd "$project"; cargo init --quiet --bin --name rust_probe; cargo generate-lockfile; cargo test --locked --quiet; cargo build --locked --quiet --target x86_64-unknown-linux-musl; cargo build --locked --quiet --target i686-unknown-linux-musl' \
  || fail 'native Rust test or cross-target Rust link probe failed'

# ---------------------------------------------------------------------------
# Installed Claude skill: controller-first execution contract
# ---------------------------------------------------------------------------

claude_skill='/usr/local/share/trellage/claude-seed/skills/graph-of-loops/SKILL.md'
claude_manifest='/usr/local/share/trellage/claude-seed/managed-paths.txt'

run "test -f $claude_skill" \
  || fail 'Graph of Loops Claude skill is missing from the managed seed'

run "grep -Fxq 'skills/graph-of-loops/SKILL.md' $claude_manifest" \
  || fail 'Graph of Loops Claude skill is missing from the managed-path manifest'

run "grep -Fq 'Always start with a direct \`trellage-graph\` controller command.' $claude_skill" \
  || fail 'Graph of Loops Claude skill does not require an immediate controller invocation'

run "grep -Fq 'existing 12-character run ID' $claude_skill" \
  || fail 'Graph of Loops Claude skill does not support direct existing-run recovery'

run "grep -Fq 'OBJECTIVE' $claude_skill && grep -Fq 'CONSTRAINTS' $claude_skill" \
  || fail 'Graph of Loops Claude skill does not define named invocation inputs'

run "grep -Fq 'Before that command, do not search or inspect the repository' $claude_skill" \
  || fail 'Graph of Loops Claude skill does not prohibit outer-session preflight'

run "grep -Fq 'hand-decompose the work' $claude_skill" \
  || fail 'Graph of Loops Claude skill does not prohibit outer-session hand decomposition'

run "grep -Fq 'trellage-graph status --run <run-id>' $claude_skill" \
  || fail 'Graph of Loops Claude skill does not require controller status observation'

run_bash 'runtime="$(mktemp -d)"; trap '\''rm -rf -- "$runtime"'\'' EXIT; mkdir -p "$runtime/skills/graph-of-loops"; printf stale >"$runtime/skills/graph-of-loops/SKILL.md"; : >"$runtime/.trellage-claude-managed"; TRELLAGE_CLAUDE_HOME="$runtime" TRELLAGE_CLAUDE_AUTH_MODE=native /usr/local/bin/trellage-claude-entry new /bin/true; cmp -s /usr/local/share/trellage/claude-seed/skills/graph-of-loops/SKILL.md "$runtime/skills/graph-of-loops/SKILL.md"' \
  || fail 'Claude runtime entry does not adopt and refresh a stale Graph of Loops skill'

# ---------------------------------------------------------------------------
# Runtime package and schemas installed under /opt/trellage/graph-of-loops
# ---------------------------------------------------------------------------

run "test -d $runtime/trellage_graph && test -f $runtime/trellage_graph/__init__.py" \
  || fail 'Graph of Loops runtime package is missing'

run_py 15 <<'PY' \
  || fail 'specialist launcher cannot prepare the managed Claude seed'
import os
import subprocess
import tempfile
from pathlib import Path

from trellage_graph.specialist import SpecialistLauncher

with tempfile.TemporaryDirectory() as temporary:
    launcher = SpecialistLauncher()
    config = Path(temporary) / "config"
    settings = launcher._seed_config_dir(str(config))
    assert settings == config / "default-settings.json"
    worktree = Path(temporary) / "worktree"
    worktree.mkdir()
    env = launcher._sanitized_env(str(config), worktree=str(worktree))
    assert env["LD_PRELOAD"].endswith("/libnss_wrapper.so")
    assert env["TRELLAGE_SPECIALIST_WORKTREE"] == str(worktree.resolve())
    identity = subprocess.run(
        ["getent", "passwd", "10001"],
        env={**os.environ, **env},
        check=True,
        capture_output=True,
        text=True,
    )
    assert identity.stdout == "agent:x:10001:10001::/home/agent:/bin/bash\n"
    assert settings.read_bytes() == Path(
        "/usr/local/share/trellage/claude-seed/default-settings.json"
    ).read_bytes()
    schema = launcher._structured_output_schema(
        "/opt/trellage/graph-of-loops/schemas/graph-plan.schema.json"
    )
    assert '"$schema"' not in schema
    assert '"$defs"' in schema
    command = launcher._base_command(
        role="trellage-graph-planner",
        settings=settings,
        output_format="stream-json",
        allowed_tools=[],
        disallowed_tools=[],
    )
    assert "--print" in command
    assert "--verbose" in command
    assert command.index("--verbose") < command.index("--output-format")
    assert "--tools" not in command
PY

run_py 15 <<'PY' \
  || fail 'specialist worktree confinement hook is broken'
import tempfile
from pathlib import Path

from trellage_graph.hooks.specialist_worktree import handle

with tempfile.TemporaryDirectory() as temporary:
    parent = Path(temporary).resolve()
    worktree = parent / ".sdd" / "worktrees" / "node"
    worktree.mkdir(parents=True)
    allowed = handle(
        {
            "hook_event_name": "PreToolUse",
            "cwd": str(worktree),
            "tool_name": "Write",
            "tool_input": {"file_path": "src/owned.rs"},
        },
        expected_worktree=worktree,
    )
    assert allowed is None
    denied = handle(
        {
            "hook_event_name": "PreToolUse",
            "cwd": str(worktree),
            "tool_name": "Write",
            "tool_input": {"file_path": str(parent / "src" / "leaked.rs")},
        },
        expected_worktree=worktree,
    )
    assert denied["hookSpecificOutput"]["permissionDecision"] == "deny"
PY

run_py 15 <<'PY' \
  || fail 'specialist prompt transport or Graph entrypoint hook is broken'
import json
import subprocess
import tempfile
from pathlib import Path

from trellage_graph.hooks.graph_entrypoint import handle
from trellage_graph.specialist import SpecialistLauncher


class Runner:
    def __init__(self):
        self.command = None
        self.input = None

    def run(self, command, **kwargs):
        self.command = command
        self.input = kwargs.get("input")
        event = {"type": "result", "subtype": "success", "result": "OK"}
        return subprocess.CompletedProcess(command, 0, json.dumps(event) + "\n", "")


runner = Runner()
launcher = SpecialistLauncher(runner=runner)
prompt = "exact prompt after variadic tools"
parsed = launcher._run_stream(
    ["claude", "--disallowed-tools", "Bash,Write"],
    cwd="/tmp",
    config_dir="/tmp",
    role="probe",
    label="probe",
    prompt=prompt,
    timeout=5,
)
assert parsed["status"] == "ok"
assert runner.command[-1] == "Bash,Write"
assert prompt not in runner.command
assert runner.input == prompt

with tempfile.TemporaryDirectory() as temporary:
    config = Path(temporary)
    base = {
        "session_id": "probe-session",
        "hook_event_name": "UserPromptSubmit",
        "prompt": '/graph-of-loops OBJECTIVE="probe"',
    }
    assert handle(base, config_dir=config) is None
    denied = handle(
        {
            "session_id": "probe-session",
            "hook_event_name": "PreToolUse",
            "tool_name": "Bash",
            "tool_input": {"command": "trellage-graph --version"},
        },
        config_dir=config,
    )
    assert denied["hookSpecificOutput"]["permissionDecision"] == "deny"
    denied = handle(
        {
            "session_id": "probe-session",
            "hook_event_name": "PreToolUse",
            "tool_name": "Bash",
            "tool_input": {"command": "trellage-graph run --goal x | tail -1"},
        },
        config_dir=config,
    )
    assert denied["hookSpecificOutput"]["permissionDecision"] == "deny"
    assert handle(
        {
            "session_id": "probe-session",
            "hook_event_name": "PreToolUse",
            "tool_name": "Skill",
            "tool_input": {"skill": "graph-of-loops"},
        },
        config_dir=config,
    ) is None
    assert handle(
        {
            "session_id": "probe-session",
            "hook_event_name": "PreToolUse",
            "tool_name": "Bash",
            "tool_input": {"command": "trellage-graph run --goal x"},
        },
        config_dir=config,
    ) is None
PY

for schema in graph-plan node-envelope planning-discovery planning-decision codex-review repository-proof; do
  run "test -f $runtime/schemas/$schema.schema.json" \
    || fail "Graph of Loops schema is missing: $schema.schema.json"
done

# ---------------------------------------------------------------------------
# Pinned graph tools remain installed at their exact locked versions, using
# each tool's real version-reporting shape (verified against the actual
# installed 3.16.0/0.1.1/1.7.0/1.2.2/0.22.0/0.1.21/0.149.1/2.1.10 releases):
#   bernstein --version  -> "bernstein, version 3.16.0"
#   waku-agent            -> no CLI; importlib.metadata is its real version
#   serena --version      -> "Serena 1.7.0[-<commit>[-dirty]]"
#   bd version             -> "bd version 1.2.2 (...)"
#   bv --version           -> "bv 0.22.0" (or "bv v0.22.0")
#   raindrop --version    -> "0.1.21" (console.log(VERSION), no prefix)
#   codex --version        -> contains "0.149.1"
#   lefthook version        -> contains "2.1.10"
# ---------------------------------------------------------------------------

bernstein_version="$(run 'bernstein --version' || true)"
[[ "$bernstein_version" == *3.16.0* ]] \
  || fail "bernstein is not the pinned 3.16.0 CLI: $bernstein_version"

run 'python -c "import importlib.metadata as m; assert m.version(\"waku-agent\") == \"0.1.1\", m.version(\"waku-agent\")"' \
  || fail 'waku-agent is not the pinned 0.1.1 distribution'

serena_version="$(run 'serena --version' || true)"
[[ "$serena_version" == *1.7.0* ]] \
  || fail "serena is not the pinned 1.7.0 CLI: $serena_version"

bd_version="$(run 'bd version' || true)"
[[ "$bd_version" == *1.2.2* ]] \
  || fail "bd is not the pinned 1.2.2 CLI: $bd_version"

bv_version="$(run 'bv --version' || true)"
[[ "$bv_version" == *0.22.0* ]] \
  || fail "bv is not the pinned 0.22.0 CLI: $bv_version"

raindrop_version="$(run 'raindrop --version' || true)"
[[ "$raindrop_version" == *0.1.21* ]] \
  || fail "raindrop is not the pinned 0.1.21 CLI: $raindrop_version"

codex_version="$(run 'codex --version' || true)"
[[ "$codex_version" == *0.149.1* ]] \
  || fail "codex is not the pinned 0.149.1 CLI: $codex_version"

lefthook_version="$(run '/usr/local/lib/trellage/node_modules/lefthook-linux-arm64/bin/lefthook version' || true)"
[[ "$lefthook_version" == *2.1.10* ]] \
  || fail "Lefthook Linux ARM64 binary is not the pinned 2.1.10 CLI: $lefthook_version"

run 'test -x /usr/local/bin/raindrop' \
  || fail 'raindrop binary is missing'

run 'test -x /usr/local/bin/codex-code-mode-host' \
  || fail 'Codex code-mode host is missing'

run 'test "$NODE_PATH" = /usr/local/lib/trellage/node_modules && node -e '\''process.stdout.write(require.resolve("lefthook-linux-arm64/bin/lefthook"))'\'' | string match -q "*/lefthook-linux-arm64/bin/lefthook"' \
  || fail 'Lefthook Linux ARM64 package is not resolvable'

run 'gh --version >/dev/null' \
  || fail 'gh is missing'

# ---------------------------------------------------------------------------
# Runtime modules import: every module the real trellage_graph package ships
# ---------------------------------------------------------------------------

run 'python -c "
import importlib
for module in [
    \"trellage_graph\",
    \"trellage_graph.cli\",
    \"trellage_graph.contracts\",
    \"trellage_graph._schema_validator\",
    \"trellage_graph.controller\",
    \"trellage_graph.beads_repository\",
    \"trellage_graph.bernstein_facade\",
    \"trellage_graph.waku_runtime\",
    \"trellage_graph.specialist\",
    \"trellage_graph.gates\",
    \"trellage_graph.gate_command\",
    \"trellage_graph.run_lifecycle\",
    \"trellage_graph.review\",
    \"trellage_graph.proof\",
    \"trellage_graph.evidence\",
]:
    importlib.import_module(module)
"' \
  || fail 'a Trellage Graph of Loops runtime module failed to import'

# ---------------------------------------------------------------------------
# Bernstein 3.16.0 compatibility probe (no model, real Git repo).
#
# Exercises the actual pinned API surface (verified directly against the
# installed 3.16.0 distribution, not the local facade's own re-implementation):
#   bernstein.core.orchestration.task_dag.TaskNode
#   bernstein.core.orchestration.task_dag.TaskDag.from_nodes
#   bernstein.core.orchestration.task_dag.topological_iter_with_parallel
#   bernstein.core.git.worktree.WorktreeManager(repo_root, salvage_push=False)
# and confirms the real worktree/branch lifecycle: creation under
# .sdd/worktrees/<id> on branch agent/<id>, then absence after cleanup.
# ---------------------------------------------------------------------------

bernstein_probe_output="$(run_py 60 <<'PYEOF' 2>&1 || true
import subprocess
import sys
import tempfile
from pathlib import Path

from bernstein.core.orchestration.task_dag import (
    TaskDag,
    TaskNode,
    topological_iter_with_parallel,
)
from bernstein.core.git.worktree import WorktreeManager


def sh(*args, cwd):
    subprocess.run(args, cwd=cwd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def main():
    repo = Path(tempfile.mkdtemp(prefix="bernstein-probe-"))
    sh("git", "init", "-q", cwd=repo)
    sh("git", "config", "user.email", "probe@trellage", cwd=repo)
    sh("git", "config", "user.name", "probe", cwd=repo)
    (repo / "README").write_text("hi\n", encoding="utf-8")
    sh("git", "add", "README", cwd=repo)
    sh("git", "commit", "-q", "-m", "init", cwd=repo)

    nodes = [
        TaskNode(task_id="a", description="Task A"),
        TaskNode(task_id="b", description="Task B", depends_on=("a",), parallel_safe=True),
        TaskNode(task_id="c", description="Task C", depends_on=("a",), parallel_safe=True),
    ]
    dag = TaskDag.from_nodes(nodes)
    batches = [sorted(n.task_id for n in batch) for batch in topological_iter_with_parallel(dag)]
    if batches != [["a"], ["b", "c"]]:
        print(f"FAIL: unexpected ready waves: {batches}")
        sys.exit(1)

    wm = WorktreeManager(repo, salvage_push=False)
    session_id = "probe-session"
    worktree_path = wm.create(session_id)
    expected_path = repo / ".sdd" / "worktrees" / session_id
    if worktree_path.resolve() != expected_path.resolve():
        print(f"FAIL: unexpected worktree path: {worktree_path} (expected {expected_path})")
        sys.exit(1)
    if not worktree_path.is_dir():
        print("FAIL: worktree directory was not created")
        sys.exit(1)

    branches = subprocess.run(
        ["git", "branch", "--list", f"agent/{session_id}"],
        cwd=repo, check=True, capture_output=True, text=True,
    ).stdout
    if f"agent/{session_id}" not in branches:
        print(f"FAIL: branch agent/{session_id} was not created: {branches!r}")
        sys.exit(1)

    wm.cleanup(session_id)
    if worktree_path.exists():
        print("FAIL: worktree directory still exists after cleanup")
        sys.exit(1)
    branches_after = subprocess.run(
        ["git", "branch", "--list", f"agent/{session_id}"],
        cwd=repo, check=True, capture_output=True, text=True,
    ).stdout
    if f"agent/{session_id}" in branches_after:
        print(f"FAIL: branch agent/{session_id} still exists after cleanup")
        sys.exit(1)

    print("PASS: bernstein compatibility probe")


main()
PYEOF
)"
printf '%s\n' "$bernstein_probe_output" | grep -q '^PASS: bernstein compatibility probe$' \
  || fail "bernstein compatibility probe did not pass: ${bernstein_probe_output}"

# ---------------------------------------------------------------------------
# Waku 0.1.1 compatibility probe (no model, no network).
#
# Runs the real waku.loop.agent.run_loop against a real waku.tools.registry
# ToolRegistry/Tool, with only the Anthropic client faked deterministically.
# Proves: max_tokens is forwarded to the client, a requested tool is really
# invoked before the loop continues, the loop ends naturally once no more
# tools are requested, and iteration exhaustion produces the documented
# "hit my iteration limit" shape rather than hanging or silently succeeding.
# ---------------------------------------------------------------------------

waku_probe_output="$(run_py 60 <<'PYEOF' 2>&1 || true
import sys
from dataclasses import dataclass

from waku.loop.agent import run_loop
from waku.tools.registry import Tool, ToolRegistry


@dataclass
class FakeBlock:
    type: str
    text: str = ""
    name: str = ""
    input: dict | None = None
    id: str = ""


@dataclass
class FakeUsage:
    input_tokens: int
    output_tokens: int


@dataclass
class FakeMessage:
    stop_reason: str
    content: list
    usage: FakeUsage


class FakeMessagesAPI:
    def __init__(self, responses):
        self._responses = list(responses)
        self._index = 0
        self.calls = []

    def create(self, *, model, system, messages, tools, max_tokens):
        self.calls.append({"model": model, "max_tokens": max_tokens, "tool_count": len(tools)})
        response = self._responses[self._index]
        self._index = min(self._index + 1, len(self._responses) - 1)
        return response


class FakeAnthropicClient:
    def __init__(self, responses):
        self.messages = FakeMessagesAPI(responses)


def build_registry():
    called = []

    def echo_fn(text):
        called.append(text)
        return f"echo:{text}"

    registry = ToolRegistry()
    registry.register(
        Tool(
            name="echo",
            description="Echoes text back",
            input_schema={"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]},
            fn=echo_fn,
        )
    )
    return registry, called


def main():
    # -- success path: real tool invocation, then a natural stop --
    registry, called = build_registry()
    responses = [
        FakeMessage("tool_use", [FakeBlock("tool_use", name="echo", input={"text": "hi"}, id="call-1")], FakeUsage(10, 5)),
        FakeMessage("end_turn", [FakeBlock("text", text="done")], FakeUsage(12, 6)),
    ]
    client = FakeAnthropicClient(responses)
    result = run_loop(
        client, model="fake-model", system="sys",
        messages=[{"role": "user", "content": "go"}],
        tools=registry, max_iterations=5, max_tokens=777, stream=False,
    )
    if result.iterations != 2:
        print(f"FAIL: expected 2 iterations, got {result.iterations}")
        sys.exit(1)
    if result.reply != "done":
        print(f"FAIL: expected reply 'done', got {result.reply!r}")
        sys.exit(1)
    if called != ["hi"]:
        print(f"FAIL: echo tool was not really invoked: {called!r}")
        sys.exit(1)
    if not result.tool_calls or result.tool_calls[0]["tool"] != "echo":
        print(f"FAIL: tool_calls not recorded: {result.tool_calls!r}")
        sys.exit(1)
    if client.messages.calls[0]["max_tokens"] != 777:
        print(f"FAIL: max_tokens was not forwarded: {client.messages.calls[0]!r}")
        sys.exit(1)

    # -- exhaustion path: model always calls tools; loop must hard-stop --
    registry2, called2 = build_registry()
    responses2 = [
        FakeMessage("tool_use", [FakeBlock("tool_use", name="echo", input={"text": "x"}, id=f"c{i}")], FakeUsage(1, 1))
        for i in range(5)
    ]
    client2 = FakeAnthropicClient(responses2)
    result2 = run_loop(
        client2, model="fake-model", system="sys",
        messages=[{"role": "user", "content": "go"}],
        tools=registry2, max_iterations=3, max_tokens=100, stream=False,
    )
    if result2.iterations != 3:
        print(f"FAIL: expected exhaustion at 3 iterations, got {result2.iterations}")
        sys.exit(1)
    if "iteration limit" not in result2.reply:
        print(f"FAIL: exhaustion reply did not mention the iteration limit: {result2.reply!r}")
        sys.exit(1)
    if len(called2) != 3:
        print(f"FAIL: expected 3 tool invocations before exhaustion, got {len(called2)}")
        sys.exit(1)

    print("PASS: waku compatibility probe")


main()
PYEOF
)"
printf '%s\n' "$waku_probe_output" | grep -q '^PASS: waku compatibility probe$' \
  || fail "waku compatibility probe did not pass: ${waku_probe_output}"

# ---------------------------------------------------------------------------
# Serena discovery contract: --project-from-cwd wiring, plus a hard-required
# real MCP symbol lookup (no model calls). This is a required contract, not
# best-effort: it discovers the exact tool input schema from the server's own
# tools/list response (real property names, e.g. "name_path_pattern", not a
# guess), builds valid arguments from that schema, and fails unless the call
# succeeds and actually identifies the fixture's `add` function.
# ---------------------------------------------------------------------------

run "test -f /usr/local/share/trellage/claude-mcp.json && grep -Fq serena /usr/local/share/trellage/claude-mcp.json && grep -Fq -- --project-from-cwd /usr/local/share/trellage/claude-mcp.json" \
  || fail 'serena MCP config is missing --project-from-cwd'

run 'uv --version && uvx --version' \
  || fail 'Serena uv/uvx runtime is missing'

serena_probe_output="$(run_py 220 <<'PYEOF' 2>&1 || true
import json
import os
import re
import select
import shutil
import subprocess
import sys
import tempfile

# Only locked read-only discovery tools are candidates; editing tools
# (replace_symbol_body, insert_after_symbol, rename_symbol, ...) must never
# be invoked by this probe.
READ_ONLY_DISCOVERY_TOOLS = [
    "find_symbol",
    "find_referencing_symbols",
    "get_symbols_overview",
    "read_file",
    "list_dir",
    "find_file",
    "search_for_pattern",
]


def send(proc, message):
    proc.stdin.write(json.dumps(message) + "\n")
    proc.stdin.flush()


def recv(proc, timeout):
    ready, _, _ = select.select([proc.stdout], [], [], timeout)
    if not ready:
        raise TimeoutError("no response from serena mcp server")
    line = proc.stdout.readline()
    if not line:
        raise EOFError("serena mcp server closed stdout")
    return json.loads(line)


def build_args(schema):
    """Build valid arguments from a tool's real inputSchema (no guessing):
    fill only required properties, preferring a 'name'-ish property for the
    fixture symbol name over a 'path'-ish property for the fixture file,
    since real schemas (e.g. Serena's name_path_pattern) can contain both
    substrings in one property name."""
    props = schema.get("properties", {})
    required = schema.get("required", [])
    args = {}
    for prop_name in required:
        prop_schema = props.get(prop_name, {})
        prop_type = prop_schema.get("type", "string")
        lower = prop_name.lower()
        if "name" in lower:
            args[prop_name] = "add"
        elif "path" in lower:
            args[prop_name] = "sample.py"
        elif prop_type == "boolean":
            args[prop_name] = False
        elif prop_type in ("integer", "number"):
            args[prop_name] = 0
        elif prop_type == "array":
            args[prop_name] = []
        elif prop_type == "object":
            args[prop_name] = {}
        else:
            args[prop_name] = ""
    return args


def main():
    project = tempfile.mkdtemp(prefix="serena-probe-")
    os.chdir(project)
    serena_home = tempfile.mkdtemp(prefix="serena-probe-home-")
    shutil.copy2(
        "/opt/trellage/graph-of-loops/serena_config.yml",
        os.path.join(serena_home, "serena_config.yml"),
    )
    env = dict(os.environ)
    env["SERENA_HOME"] = serena_home

    def sh(*args):
        subprocess.run(args, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    sh("git", "init", "-q")
    sh("git", "config", "user.email", "probe@trellage")
    sh("git", "config", "user.name", "probe")
    with open("sample.py", "w", encoding="utf-8") as fh:
        fh.write("def add(a, b):\n    return a + b\n")
    sh("git", "add", "sample.py")
    sh("git", "commit", "-q", "-m", "init")

    proc = subprocess.Popen(
        ["serena", "start-mcp-server", "--context", "agent", "--project-from-cwd"],
        cwd=project,
        env=env,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        bufsize=1,
    )
    try:
        send(
            proc,
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {},
                    "clientInfo": {"name": "trellage-graph-of-loops-probe", "version": "0.1.0"},
                },
            },
        )
        init_response = recv(proc, timeout=45)
        if "error" in init_response:
            print(f"FAIL: serena initialize returned an error: {init_response['error']}")
            sys.exit(1)

        send(proc, {"jsonrpc": "2.0", "method": "notifications/initialized"})
        send(proc, {"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
        tools_response = recv(proc, timeout=20)
        if "error" in tools_response:
            print(f"FAIL: serena tools/list returned an error: {tools_response['error']}")
            sys.exit(1)

        tools = {t["name"]: t for t in tools_response.get("result", {}).get("tools", [])}
        if not tools:
            print("FAIL: serena tools/list returned no tools")
            sys.exit(1)
        if sorted(tools) != sorted(READ_ONLY_DISCOVERY_TOOLS):
            print(
                "FAIL: Serena tool surface is not the locked read-only set: "
                f"{sorted(tools)}"
            )
            sys.exit(1)

        tool_name = next((name for name in READ_ONLY_DISCOVERY_TOOLS if name in tools), None)
        if tool_name is None:
            print(f"FAIL: none of the expected read-only symbol tools are exposed: {sorted(tools)}")
            sys.exit(1)

        schema = tools[tool_name].get("inputSchema", {})
        args = build_args(schema)

        send(
            proc,
            {
                "jsonrpc": "2.0",
                "id": 3,
                "method": "tools/call",
                "params": {"name": tool_name, "arguments": args},
            },
        )
        call_response = recv(proc, timeout=150)
        if "error" in call_response:
            print(f"FAIL: serena {tool_name} call returned a JSON-RPC error: {call_response['error']}")
            sys.exit(1)

        result = call_response.get("result", {})
        if result.get("isError"):
            print(f"FAIL: serena {tool_name} reported a tool-level error: {result}")
            sys.exit(1)

        text = "".join(
            block.get("text", "") for block in result.get("content", []) if isinstance(block, dict)
        )
        if not re.search(r"\badd\b", text):
            print(f"FAIL: serena {tool_name} result did not identify 'add': {text[:500]!r}")
            sys.exit(1)

        print(f"PASS: serena {tool_name} succeeded and identified add")
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()


main()
PYEOF
)"
printf '%s\n' "$serena_probe_output" | grep -qE '^PASS: serena .* succeeded and identified add$' \
  || fail "serena MCP symbol-lookup contract did not pass: ${serena_probe_output}"

# ---------------------------------------------------------------------------
# Raindrop Workshop MCP handshake (no replay, no model call).
#
# `raindrop workshop mcp` is the real subcommand (src/index.ts: "MCP server
# over stdio, used by Claude Code/Cursor"); it auto-starts a detached local
# `workshop serve` daemon under $HOME/.raindrop if one is not already running,
# so HOME is isolated to a throwaway directory and the daemon is stopped
# afterward. `replay_run` is a real tool (src/mcp/tools.ts) that requires
# run_id and would execute a replay against a registered agent; this probe
# only confirms it is advertised over tools/list and never calls it.
# ---------------------------------------------------------------------------

raindrop_probe_output="$(run_py 120 <<'PYEOF' 2>&1 || true
import json
import os
import select
import shutil
import subprocess
import sys
import tempfile


def send(proc, message):
    proc.stdin.write(json.dumps(message) + "\n")
    proc.stdin.flush()


def recv(proc, timeout):
    ready, _, _ = select.select([proc.stdout], [], [], timeout)
    if not ready:
        raise TimeoutError("no response from raindrop workshop mcp")
    line = proc.stdout.readline()
    if not line:
        raise EOFError("raindrop workshop mcp closed stdout")
    return json.loads(line)


def main():
    home = tempfile.mkdtemp(prefix="raindrop-probe-home-")
    env = dict(os.environ)
    env["HOME"] = home

    proc = subprocess.Popen(
        ["raindrop", "workshop", "mcp"],
        env=env,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        bufsize=1,
    )
    try:
        send(
            proc,
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {},
                    "clientInfo": {"name": "trellage-graph-of-loops-probe", "version": "0.1.0"},
                },
            },
        )
        init_response = recv(proc, timeout=60)
        if "error" in init_response:
            print(f"FAIL: raindrop workshop mcp initialize returned an error: {init_response['error']}")
            sys.exit(1)

        send(proc, {"jsonrpc": "2.0", "method": "notifications/initialized"})
        send(proc, {"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
        tools_response = recv(proc, timeout=20)
        if "error" in tools_response:
            print(f"FAIL: raindrop workshop mcp tools/list returned an error: {tools_response['error']}")
            sys.exit(1)

        tool_names = {t["name"] for t in tools_response.get("result", {}).get("tools", [])}
        if "replay_run" not in tool_names:
            print(f"FAIL: raindrop workshop mcp did not expose replay_run: {sorted(tool_names)}")
            sys.exit(1)

        # Do NOT call replay_run here: it would execute a real replay
        # against a registered local agent. Advertisement over tools/list
        # is the required, sufficient, side-effect-free proof.
        print("PASS: raindrop workshop mcp exposed replay_run")
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
        try:
            subprocess.run(
                ["raindrop", "workshop", "stop"],
                env=env,
                timeout=15,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        except Exception:
            pass
        shutil.rmtree(home, ignore_errors=True)


main()
PYEOF
)"
printf '%s\n' "$raindrop_probe_output" | grep -q '^PASS: raindrop workshop mcp exposed replay_run$' \
  || fail "raindrop Workshop MCP handshake did not pass: ${raindrop_probe_output}"

# ---------------------------------------------------------------------------
# Graph policy JSON: components, exact role map, limits, review, proof,
# denied delivery flags
# ---------------------------------------------------------------------------

run "test -f $policy" \
  || fail 'Graph of Loops policy JSON is missing'

run "jq -e '.components.tracker == \"beads\" and .components.scheduler == \"bernstein\" and .components.worktree_backend == \"bernstein\" and .components.node_runtime == \"waku\"' $policy >/dev/null" \
  || fail 'Graph of Loops policy components do not match Beads/Bernstein/Waku'

run "jq -e '.roles.planner == \"trellage-graph-planner\" and .roles.research == \"insane-research\" and .roles.implement == \"team-implementer\" and .roles.tdd == \"tdd-workflows-tdd-orchestrator\" and .roles.debug == \"team-debugger\" and .roles.validate == \"conductor-validator\"' $policy >/dev/null" \
  || fail 'Graph of Loops policy role map does not match the profile role map'

run "jq -e '.limits.max_parallel_nodes == 3 and .limits.max_node_iterations == 10 and .limits.max_specialist_attempts == 3 and .limits.max_gate_calls == 12 and .limits.max_supervisor_tokens == 2048 and .limits.node_timeout_seconds == 1800' $policy >/dev/null" \
  || fail 'Graph of Loops policy limits do not match the default execution ceilings'

run "jq -e '.review.kind == \"codex\" and .review.required == true' $policy >/dev/null" \
  || fail 'Graph of Loops policy does not require Codex review'

run "jq -e '.proof.kind == \"raindrop\" and .proof.mode == \"repository-opt-in\"' $policy >/dev/null" \
  || fail 'Graph of Loops policy proof is not repository-opt-in Raindrop'

run "jq -e '.authorization.allow_push == false and .authorization.allow_pull_request == false and .authorization.allow_deploy == false' $policy >/dev/null" \
  || fail 'Graph of Loops policy does not deny push/pull-request/deploy by default'

# ---------------------------------------------------------------------------
# The custom wt binary is absent
# ---------------------------------------------------------------------------

run 'not command -v wt >/dev/null 2>&1' \
  || fail 'the custom wt binary is still present'

run 'test ! -e /usr/local/bin/wt' \
  || fail 'the custom wt binary file is still present at /usr/local/bin/wt'

# ---------------------------------------------------------------------------
# The hamel review-loop plugin is absent
# ---------------------------------------------------------------------------

run "test ! -d $seed/plugins/cache/hamel-review" \
  || fail 'the hamel review-loop plugin cache is still present'

run "not grep -Fq 'review-loop@hamel-review' $seed/plugins/installed_plugins.json" \
  || fail 'the hamel review-loop plugin is still registered'

# ---------------------------------------------------------------------------
# Wshobson selections are reduced to agent-teams, tdd-workflows, conductor
# and configured role names resolve uniquely
# ---------------------------------------------------------------------------

run "test -f $seed/plugins/installed_plugins.json" \
  || fail 'installed plugin registry is missing'
run "grep -Fq 'superpowers@superpowers-dev' $seed/plugins/installed_plugins.json" \
  || fail 'superpowers plugin is not installed'
run "grep -Fq 'beads@beads-marketplace' $seed/plugins/installed_plugins.json" \
  || fail 'beads plugin is not installed'
run "grep -Fq 'agent-teams@claude-code-workflows' $seed/plugins/installed_plugins.json" \
  || fail 'wshobson agent-teams is not installed'
run "grep -Fq 'tdd-workflows@claude-code-workflows' $seed/plugins/installed_plugins.json" \
  || fail 'wshobson tdd-workflows is not installed'
run "grep -Fq 'conductor@claude-code-workflows' $seed/plugins/installed_plugins.json" \
  || fail 'wshobson conductor is not installed'
run "not grep -Fq 'full-stack-orchestration@claude-code-workflows' $seed/plugins/installed_plugins.json" \
  || fail 'wshobson full-stack-orchestration must be removed from this profile'
run "not grep -Fq 'agent-orchestration@claude-code-workflows' $seed/plugins/installed_plugins.json" \
  || fail 'wshobson agent-orchestration must be removed from this profile'
run "not grep -Fq 'comprehensive-review@claude-code-workflows' $seed/plugins/installed_plugins.json" \
  || fail 'wshobson comprehensive-review must be removed from this profile'

run "find $seed -name SKILL.md | grep -q test-driven-development" \
  || fail 'Superpowers TDD skill file is missing'

# The research plugin supplies the locked validator and research skill. The
# Graph runtime supplies a deterministic headless adapter for the configured
# role instead of executing the plugin's interactive command.
run_bash "count=\$(grep -o 'insane-research@insane-research' $seed/plugins/installed_plugins.json | wc -l); test \"\$count\" -eq 1" \
  || fail 'configured research role (insane-research) does not resolve to exactly one installed plugin'
run "find $seed/plugins/cache/insane-research -name '*.md' | grep -qi insane" \
  || fail 'insane-research command/skill files are missing'
run "test -f $runtime/roles/insane-research.md" \
  || fail 'Graph headless insane-research adapter is missing'

run_py 30 <<'PY' \
  || fail 'Graph research adapter or locked claim-ledger validator is not usable'
import json
import subprocess
import tempfile
from pathlib import Path

from trellage_graph.specialist import SpecialistLauncher

runtime = Path("/opt/trellage/graph-of-loops")
seed = Path("/usr/local/share/trellage/claude-seed")
launcher = SpecialistLauncher(seed_path=seed, runtime_roles=runtime / "roles")
definition = json.loads(
    launcher._agent_definition("insane-research", ["Write"], [])
)
prompt = definition["insane-research"]["prompt"]
assert "artifacts/claim_ledger.jsonl" in prompt
assert "sources/sources.jsonl" in prompt

validators = sorted(
    seed.glob(
        "plugins/cache/**/skills/insane-research-main/scripts/"
        "validate_ledger.py"
    )
)
assert len(validators) == 1, validators

with tempfile.TemporaryDirectory() as temporary:
    session = Path(temporary)
    (session / "artifacts").mkdir()
    (session / "sources").mkdir()
    source = {
        "id": "source-1",
        "url": "file:///workspace/Cargo.toml",
        "title": "Cargo manifest",
        "type": "repository",
        "quality_rating": "A",
    }
    claim = {
        "claim_id": "claim-1",
        "text": "The manifest declares the package.",
        "claim_type": "executable",
        "risk": "normal",
        "source_ids": ["source-1"],
        "execution_proof": {
            "script": "Read Cargo.toml",
            "output": "package declaration observed",
            "env": "locked Graph profile",
            "verdict": "confirmed",
        },
    }
    (session / "sources" / "sources.jsonl").write_text(
        json.dumps(source) + "\n",
        encoding="utf-8",
    )
    (session / "artifacts" / "claim_ledger.jsonl").write_text(
        json.dumps(claim) + "\n",
        encoding="utf-8",
    )
    (session / "state.json").write_text("{}\n", encoding="utf-8")
    subprocess.run(
        ["python3", str(validators[0]), "--session", str(session)],
        check=True,
        capture_output=True,
        text=True,
    )
    assert (session / "outputs" / "verified_claims.json").is_file()
    assert (session / "state.json").is_file()
PY

# The "planner" role is configured as exactly "trellage-graph-planner",
# which is a Trellage-owned runtime asset (unlike roles/trellage-research.md,
# which is not referenced by any runtime module for a documented purpose and
# is therefore not asserted here).
run "test -f $runtime/roles/trellage-graph-planner.md" \
  || fail 'trellage-graph-planner role prompt (the configured planner role) is missing'

# Curated wshobson roles must each resolve to exactly one agent definition.
for role in team-implementer team-debugger tdd-workflows-tdd-orchestrator conductor-validator; do
  run_bash "count=\$(grep -rl \"^name: $role\\\$\" $seed/plugins/cache 2>/dev/null | wc -l); test \"\$count\" -eq 1" \
    || fail "configured role '$role' does not resolve to exactly one agent definition"
done

# ---------------------------------------------------------------------------
# Codex reviewer config is read-only, not danger-full-access
# ---------------------------------------------------------------------------

run 'python -c '\''import tomllib; config = tomllib.load(open("/home/agent/.codex/config.toml", "rb")); assert config["approval_policy"] == "never"; assert config["sandbox_mode"] == "read-only"; assert config["sandbox_mode"] != "danger-full-access"; assert config["model_provider"] == "copilot_proxy"; assert config["model_providers"]["copilot_proxy"]["base_url"] == "http://copilot-proxy-rs:8080/v1"; assert config["features"]["multi_agent"] is True'\''' \
  || fail 'Codex reviewer config is not a read-only copilot-proxy-rs configuration'

# ---------------------------------------------------------------------------
# Claude and Codex graph skills are present and explicitly invoke
# trellage-graph
# ---------------------------------------------------------------------------

run "test -f $claude_skill && grep -Fq trellage-graph $claude_skill" \
  || fail 'Claude graph-of-loops managed skill is missing or does not invoke trellage-graph'

run 'test -f /etc/codex/skills/graph-of-loops/SKILL.md && grep -Fq trellage-graph /etc/codex/skills/graph-of-loops/SKILL.md && grep -Fq '\''name: graph-of-loops'\'' /etc/codex/skills/graph-of-loops/SKILL.md' \
  || fail 'Codex graph-of-loops skill is missing or does not invoke trellage-graph'

run "test -f /etc/codex/skills/graph-of-loops/agents/openai.yaml && grep -Fq 'allow_implicit_invocation: false' /etc/codex/skills/graph-of-loops/agents/openai.yaml" \
  || fail 'Codex graph-of-loops skill policy is missing or allows implicit invocation'

# ---------------------------------------------------------------------------
# No-model validate-plan self-test: a valid plan passes; a cyclic plan, an
# unauthorized delivery request, and malformed JSON all fail closed.
#
# Uses `python -m trellage_graph validate-plan --plan <file>` (the current
# cli.py argument shape) rather than the `trellage-graph` wrapper, so a
# validation-logic regression is not conflated with the wrapper bug caught
# by the CLI entrypoint check above.
# ---------------------------------------------------------------------------

validate_plan_output="$(run_bash '
set -eu
work="$(mktemp -d)"
cd "$work"
prompt_text="Probe fixture node prompt."
digest="sha256:$(printf "%s" "$prompt_text" | sha256sum | awk "{print \$1}")"

cat > valid-plan.json <<JSON
{
  "objective": "Probe validate-plan wiring",
  "base_revision": "abc1234",
  "nodes": [
    {
      "id": "validate-fixture",
      "type": "validate",
      "role": "conductor-validator",
      "prompt": "$prompt_text",
      "prompt_digest": "$digest",
      "dependencies": [],
      "read_set": ["**"],
      "write_set": [],
      "behavior_change": false,
      "gates": []
    }
  ]
}
JSON

cat > cycle-plan.json <<JSON
{
  "objective": "Probe cyclic dependency rejection",
  "base_revision": "abc1234",
  "nodes": [
    {
      "id": "node-a",
      "type": "validate",
      "role": "conductor-validator",
      "prompt": "$prompt_text",
      "prompt_digest": "$digest",
      "dependencies": ["node-b"],
      "read_set": [],
      "write_set": [],
      "behavior_change": false,
      "gates": []
    },
    {
      "id": "node-b",
      "type": "validate",
      "role": "conductor-validator",
      "prompt": "$prompt_text",
      "prompt_digest": "$digest",
      "dependencies": ["node-a"],
      "read_set": [],
      "write_set": [],
      "behavior_change": false,
      "gates": []
    }
  ]
}
JSON

cat > unauthorized-plan.json <<JSON
{
  "objective": "Probe denied delivery authorization",
  "base_revision": "abc1234",
  "nodes": [
    {
      "id": "validate-fixture",
      "type": "validate",
      "role": "conductor-validator",
      "prompt": "$prompt_text",
      "prompt_digest": "$digest",
      "dependencies": [],
      "read_set": [],
      "write_set": [],
      "behavior_change": false,
      "gates": []
    }
  ],
  "authorization": { "allow_push": true }
}
JSON

printf "{not valid json" > malformed-plan.json

fail_case() {
  printf "FIXTURE FAIL: %s\n" "$1"
  exit 1
}

python3 -m trellage_graph validate-plan --plan valid-plan.json || fail_case "valid plan was rejected"

if python3 -m trellage_graph validate-plan --plan cycle-plan.json 2>cycle.err; then
  fail_case "cyclic plan was accepted"
fi
grep -qi cycle cycle.err || fail_case "cyclic plan did not report a cycle error"

if python3 -m trellage_graph validate-plan --plan unauthorized-plan.json 2>auth.err; then
  fail_case "unauthorized delivery request was accepted"
fi
grep -qi allow_push auth.err || fail_case "unauthorized delivery request did not report the denied permission"

if python3 -m trellage_graph validate-plan --plan malformed-plan.json 2>malformed.err; then
  fail_case "malformed JSON plan was accepted"
fi
grep -qi "cannot load plan" malformed.err || fail_case "malformed JSON plan did not fail closed with a clear error"

printf "VALIDATE_PLAN_FIXTURES_OK\n"
' 2>&1 || true)"
printf '%s\n' "$validate_plan_output" | grep -q '^VALIDATE_PLAN_FIXTURES_OK$' \
  || fail "validate-plan fixtures did not pass: ${validate_plan_output}"

run_py 15 <<'PY' \
  || fail 'inline gate evaluation was not rejected consistently'
from trellage_graph.contracts import PlanValidationError, content_digest, validate_plan
from trellage_graph.gates import GateError, GateRunner

prompt = "Probe unsafe gate rejection."
commands = [
    ["env", "MODE=test", "timeout", "30", "bash", "-lc", "false || true"],
    ["env", "-u", "CI", "--split-string=sh", "-c", "false || true"],
    ["nice", "bash", "-c", "false || true"],
    ["node", "-p", "process.exit(0)"],
    ["python3", "-cprint('masked')"],
    ["perl", "-le", "exit 0"],
    ["flock", "gate.lock", "bash", "-c", "false || true"],
    ["awk", "BEGIN { system(\"false || true\"); exit 0 }"],
    ["find", ".", "-maxdepth", "0", "-exec", "false", ";"],
    ["npx", "-c", "false || true"],
    ["npm", "exec", "-c", "false || true"],
    ["uv", "run", "python", "-c", "print('masked')"],
    ["git", "-c", "alias.z=!false || true", "z"],
]
for argv in commands:
    plan = {
        "objective": "Reject masked gate failures",
        "base_revision": "abc1234",
        "nodes": [{
            "id": "unsafe-gate",
            "type": "validate",
            "role": "conductor-validator",
            "prompt": prompt,
            "prompt_digest": content_digest(prompt),
            "dependencies": [],
            "read_set": [],
            "write_set": [],
            "behavior_change": False,
            "gates": [{
                "id": "masked",
                "phase": "final",
                "argv": argv,
                "timeout_seconds": 30,
            }],
        }],
    }

    try:
        validate_plan(plan)
    except PlanValidationError:
        pass
    else:
        raise AssertionError(f"static validation accepted inline source: {argv}")

    try:
        GateRunner.validate_argv(argv, "masked", "final")
    except GateError:
        pass
    else:
        raise AssertionError(f"runtime validation accepted inline source: {argv}")
PY

run_py 30 <<'PY' \
  || fail 'run lifecycle did not preserve identity and reuse a valid plan'
import subprocess
import tempfile
from pathlib import Path

from trellage_graph.beads_repository import BeadsError
from trellage_graph.contracts import content_digest
from trellage_graph.run_lifecycle import RunLifecycle, RunLifecycleError
from trellage_graph.specialist import PlanningResult


class Planner:
    def __init__(self, root, announced, base_revision):
        self.root = root
        self.announced = announced
        self.base_revision = base_revision
        self.calls = 0

    def plan(self, **kwargs):
        self.calls += 1
        run_dir = self.root / ".sdd" / "graph-of-loops" / "runs" / "probe-run"
        assert self.announced == ["probe-run"]
        assert (run_dir / "request.json").is_file()
        assert (run_dir / "lifecycle.json").is_file()
        prompt = "Validate lifecycle recovery."
        plan = {
                "objective": kwargs["objective"],
                "constraints": kwargs["constraints"],
                "base_revision": self.base_revision,
                "nodes": [{
                    "id": "validate",
                    "type": "validate",
                    "role": "conductor-validator",
                    "prompt": prompt,
                    "prompt_digest": content_digest(prompt),
                    "dependencies": [],
                    "read_set": [],
                    "write_set": [],
                    "behavior_change": False,
                    "gates": [],
                }],
                "validation_matrix": [
                    {
                        "kind": kind,
                        "status": "not-applicable",
                        "source_paths": ["."],
                        "reason": "The lifecycle probe has no project command.",
                    }
                    for kind in (
                        "format",
                        "lint",
                        "typecheck",
                        "build",
                        "targeted-test",
                        "full-suite",
                    )
                ],
            }
        return PlanningResult(
            plan=plan,
            decision={
                "status": "planned",
                "objective": kwargs["objective"],
                "constraints": kwargs["constraints"],
                "target_evidence": [{
                    "path": ".",
                    "detail": "Lifecycle probe root",
                    "symbols": ["RunLifecycle"],
                }],
                "plan": plan,
            },
            tool_events=[],
            serena_success=True,
            serena_fallback=False,
        )


class Controller:
    failures = 1

    def resume(self, run_id):
        return False

    def accept_plan(self, plan, *, run_id, plan_generation=1):
        assert plan_generation == 1
        if Controller.failures:
            Controller.failures -= 1
            raise BeadsError("simulated partial bootstrap")
        return "root"

    def run(self):
        return {"status": "complete"}

    def status(self):
        return {"status": "running"}


with tempfile.TemporaryDirectory() as temporary:
    root = Path(temporary)
    subprocess.run(["git", "init", "-q"], cwd=root, check=True)
    subprocess.run(
        ["git", "config", "user.email", "probe@trellage.invalid"],
        cwd=root,
        check=True,
    )
    subprocess.run(
        ["git", "config", "user.name", "Trellage Probe"],
        cwd=root,
        check=True,
    )
    (root / "README").write_text("probe\n", encoding="utf-8")
    subprocess.run(["git", "add", "README"], cwd=root, check=True)
    subprocess.run(
        ["git", "commit", "-q", "-m", "probe"],
        cwd=root,
        check=True,
    )
    base_revision = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=root,
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()
    announced = []
    planner = Planner(root, announced, base_revision)
    lifecycle = RunLifecycle(
        repo_root=root,
        policy={
            "roles": {
                "planner": "trellage-graph-planner",
                "validate": "conductor-validator",
            },
            "authorization": {
                "allow_push": False,
                "allow_pull_request": False,
                "allow_deploy": False,
            },
            "limits": {"node_timeout_seconds": 30},
        },
        planner=planner,
        controller_factory=lambda run_id: Controller(),
        announce=announced.append,
        run_id_factory=lambda: "probe-run",
    )
    try:
        lifecycle.start(
            objective="Probe lifecycle recovery",
            constraints=[],
        )
    except RunLifecycleError:
        pass
    else:
        raise AssertionError("simulated bootstrap failure did not block")
    assert lifecycle.status("probe-run")["status"] == "blocked"
    assert lifecycle.resume("probe-run")["status"] == "complete"
    assert planner.calls == 1
PY

run_py 60 <<'PY' \
  || fail 'Beads did not initialize in the explicit linked-worktree directory'
import os
import subprocess
import tempfile
from pathlib import Path

from trellage_graph.beads_repository import BeadsRepository


def git(*args, cwd):
    subprocess.run(
        ["git", *args],
        cwd=cwd,
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


with tempfile.TemporaryDirectory() as temporary:
    root = Path(temporary)
    common = root / "common"
    worktree = root / "linked"
    common.mkdir()
    git("init", "-q", cwd=common)
    git("config", "user.email", "probe@trellage", cwd=common)
    git("config", "user.name", "probe", cwd=common)
    (common / "README").write_text("probe\n", encoding="utf-8")
    git("add", "README", cwd=common)
    git("commit", "-q", "-m", "init", cwd=common)
    git("worktree", "add", "-q", "-b", "probe-linked", str(worktree), cwd=common)
    common.chmod(0o555)
    os.environ.pop("BEADS_DIR", None)
    try:
        repository = BeadsRepository(
            repo_root=str(worktree),
            beads_dir=str(worktree / ".beads"),
        )
        repository.ensure_initialized()
        assert (worktree / ".beads" / "metadata.json").is_file()
        assert not (common / ".beads").exists()
        root_metadata = {"kind": "graph-of-loops", "run_id": "probe-run"}
        root_id = repository.ensure_issue(
            title="Graph: probe",
            metadata=root_metadata,
            identity=root_metadata,
        )
        assert repository.ensure_issue(
            title="Graph: probe",
            metadata=root_metadata,
            identity=root_metadata,
        ) == root_id
        node_metadata = {
            "kind": "graph-node",
            "run_id": "probe-run",
            "node_id": "validate",
        }
        node_id = repository.ensure_issue(
            title="Node: validate",
            metadata=node_metadata,
            identity=node_metadata,
            parent=root_id,
        )
        assert repository.ensure_issue(
            title="Node: validate",
            metadata=node_metadata,
            identity=node_metadata,
            parent=root_id,
        ) == node_id
        repository.ensure_dependency(blocked=root_id, blocker=node_id)
        repository.ensure_dependency(blocked=root_id, blocker=node_id)
        assert len(repository.find_by_metadata(root_metadata)) == 1
        assert len(repository.find_by_metadata(node_metadata)) == 1
    finally:
        common.chmod(0o755)
PY

# ---------------------------------------------------------------------------
# General environment checks that remain valid for this profile
# ---------------------------------------------------------------------------

run 'test "$BD_DISABLE_METRICS" = 1 && test "$BD_DISABLE_EVENT_FLUSH" = 1' \
  || fail 'Beads telemetry opt-out is missing'

run 'test -d /usr/local/share/trellage/claude-seed/plugins/cache' \
  || fail 'Claude plugin cache is missing'

run 'mkdir -p /tmp/home; set -gx HOME /tmp/home; set tmp (mktemp -d); cd $tmp; git init -q; git config user.email probe@trellage; git config user.name probe; echo hi > README; git add README; git commit -q -m init; bd init --stealth --quiet; bd create "probe" -p 0 >/dev/null; bd ready --json | string match -q "*probe*"' \
  || fail 'bd init/create/ready does not work'

run_bash 'set -e; home="$(mktemp -d)"; export HOME="$home"; repo="$(mktemp -d)"; cd "$repo"; git init -q; git config user.email probe@trellage; git config user.name probe; printf "#!/bin/sh\nnode -e '\''const { spawnSync } = require(\"node:child_process\"); const result = spawnSync(require.resolve(\"lefthook-linux-arm64/bin/lefthook\"), [\"version\"]); process.exit(result.status ?? 1)'\''\n" >.git/hooks/pre-commit; chmod +x .git/hooks/pre-commit; echo hook >hook.txt; git add hook.txt; git commit -q -m hook' \
  || fail 'normal Git commit could not run the Lefthook package hook'

run_bash 'set -e; home="$(mktemp -d)"; export HOME="$home"; repo="$(mktemp -d)"; cd "$repo"; git init -q; git config user.email probe@trellage; git config user.name probe; echo base >README; git add README; git commit -q -m init; bd init --stealth --quiet; before="$(find /proc -maxdepth 1 -type d -regex "/proc/[0-9]+" | wc -l)"; for _ in $(seq 1 20); do bd ready --json >/dev/null; done; sleep 1; after="$(find /proc -maxdepth 1 -type d -regex "/proc/[0-9]+" | wc -l)"; test "$after" -le "$((before + 1))"; for status in /proc/[0-9]*/status; do if grep -q "^Name:.*bd" "$status" && grep -q "^State:.*Z" "$status"; then exit 1; fi; done' \
  || fail 'repeated Beads commands leaked processes or zombies'

printf 'graph-of-loops image probe: PASS\n'
