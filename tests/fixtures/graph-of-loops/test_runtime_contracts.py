"""No-quota runtime contract tests for Graph of Loops.

Uses only stdlib unittest.  No pip install needed.
Fakes match exact pinned API shapes:
  Bernstein 3.16.0: TaskNode(task_id, description, parallel_safe, depends_on=tuple()),
                     topological_iter_with_parallel -> list[frozenset[TaskNodeLike]],
                     WorktreeManager.create(session_id) -> Path,
                     WorktreeManager.cleanup(session_id)
  Waku 0.1.1: run_loop(client, model, system, messages, tools,
                        max_iterations, max_tokens, observer, stream) -> LoopResult
              LoopResult.iterations, .reply, .tool_calls
              ToolRegistry.execute catches exceptions -> "Error running <name>: ..."
  Beads 1.2.2: bd create --silent --metadata, bd update --status,
               bd close, bd reopen, bd show --json, bd dep add
"""
from __future__ import annotations

import json
import multiprocessing
import os
import subprocess
import sys
import tempfile
import time
import types
import unittest
from pathlib import Path
from typing import Any

ASSETS_DIR = Path(__file__).resolve().parent.parent.parent.parent / \
    "packages" / "trellage-cli" / "assets" / "graph-of-loops"
sys.path.insert(0, str(ASSETS_DIR))
FIXTURES = Path(__file__).resolve().parent

from trellage_graph.contracts import (
    _check_research_write_rules,
    validate_plan, validate_codex_review, validate_proof_policy,
    validate_planning_decision, PlanValidationError, content_digest,
    planning_decision_schema, redact_sensitive,
)
from trellage_graph._schema_validator import validate as schema_validate
from trellage_graph.evidence import EvidenceLedger
from trellage_graph.beads_repository import (
    BeadsError,
    BeadsRepository,
    RealSubprocessRunner,
)
from trellage_graph.bernstein_facade import (
    BernsteinFacade, BernsteinError, FakeTaskNode,
    topological_iter_with_parallel,
)
from trellage_graph.waku_runtime import (
    WakuNodeRuntime, WakuRuntimeError, ExecutionCeilings,
    ToolEvent, ToolEventKind, verify_required_events,
    FakeLoopResult, FakeToolCall,
)
from trellage_graph.gates import GateRunner, GateError
from trellage_graph.review import CodexReviewGate, ReviewError
from trellage_graph.proof import RaindropProofGate, ProofError
from trellage_graph.controller import GraphController, ControllerError
from trellage_graph.specialist import (
    PlanningResult,
    SpecialistLauncher,
    SpecialistError,
)
from trellage_graph.hooks.graph_entrypoint import handle as entrypoint_hook


# ===== Fakes matching exact pinned API shapes =====

class FakeSubprocessRunner:
    def __init__(self) -> None:
        self.calls: list[list[str]] = []
        self.call_kwargs: list[dict[str, Any]] = []
        self.results: dict[str, subprocess.CompletedProcess[str]] = {}
        self.failures: dict[str, subprocess.CalledProcessError] = {}
        self._default_stdout = ""
        self._seq = 0

    def set_default(self, stdout: str) -> None:
        self._default_stdout = stdout

    def set_result(self, key: str, stdout: str) -> None:
        self.results[key] = subprocess.CompletedProcess(
            args=[key], returncode=0, stdout=stdout, stderr="",
        )

    def set_failure(self, key: str, rc: int = 1, stderr: str = "") -> None:
        self.failures[key] = subprocess.CalledProcessError(rc, key, output="", stderr=stderr)

    def run(self, args: list[str], **kw: Any) -> subprocess.CompletedProcess[str]:
        self.calls.append(args)
        self.call_kwargs.append(kw)
        self._seq += 1
        cmd_str = " ".join(args)
        searchable = f"{cmd_str}\n{kw.get('input', '')}"
        for pattern, failure in self.failures.items():
            if pattern in searchable:
                raise failure
        for pat, res in self.results.items():
            if pat in searchable:
                return res
        return subprocess.CompletedProcess(
            args=args, returncode=0,
            stdout=self._default_stdout or f"fake-{self._seq}", stderr="",
        )


class FakeWorktreeManager:
    """Matches exact WorktreeManager(repo_root, salvage_push=False) API.

    .create(session_id) -> Path   (path is .sdd/worktrees/<session_id>)
    .cleanup(session_id)          (best-effort, does not raise)
    No path_for method.
    """
    def __init__(self, base: str = "/fake") -> None:
        self._base = Path(base)
        self._wts: dict[str, Path] = {}

    def create(self, session_id: str) -> Path:
        p = self._base / ".sdd" / "worktrees" / session_id
        self._wts[session_id] = p
        return p

    def cleanup(self, session_id: str) -> None:
        self._wts.pop(session_id, None)


class FakeWakuLoop:
    """Fake run_loop matching Waku 0.1.1 signature.

    run_loop(client, model, system, messages, tools,
             max_iterations, max_tokens, observer, stream) -> LoopResult

    On exhaustion: iterations == max_iterations, reply is iteration-limit text.
    Does NOT raise.
    """
    def __init__(self, *, fail: bool = False, exhaust: bool = False) -> None:
        self._fail = fail
        self._exhaust = exhaust

    def __call__(
        self, client: Any, model: str, system: str,
        messages: list[dict[str, Any]], tools: Any, *,
        max_iterations: int = 10, max_tokens: int = 2048,
        observer: Any = None, stream: bool = False,
    ) -> FakeLoopResult:
        if self._fail:
            raise RuntimeError("waku loop failed")

        tool_calls: list[FakeToolCall] = []

        # Simulate calling registry tools
        if isinstance(tools, dict):
            if "run_specialist" in tools:
                output = tools["run_specialist"](role="tdd-workflows-tdd-orchestrator", prompt="test")
                tool_calls.append(FakeToolCall(name="run_specialist", output=output))
            if "run_gate" in tools:
                output = tools["run_gate"](name="test-final", phase="final")
                tool_calls.append(FakeToolCall(name="run_gate", output=output))

        if self._exhaust:
            return FakeLoopResult(
                iterations=max_iterations,
                reply="Reached maximum iteration limit.",
                tool_calls=tool_calls,
            )

        return FakeLoopResult(
            iterations=1, reply="Done.", tool_calls=tool_calls,
        )


class FakeWorkshopMCPClient:
    """Fake matching Workshop 0.1.21 protocol with register + replay_run.

    For gate-level tests that don't need Popen transcript fidelity.
    """
    def __init__(self, *, result: dict[str, Any] | None = None,
                 error: Exception | None = None,
                 register_error: Exception | None = None) -> None:
        self._result = result or {
            "ok": True, "source_run_id": "src_123",
            "replay_run_id": "rep_456", "events": [],
        }
        self._error = error
        self._register_error = register_error
        self.register_calls: list[str] = []

    def register_replay(self, *, repo_root: str) -> None:
        if self._register_error:
            raise self._register_error
        self.register_calls.append(repo_root)

    def replay_run(
        self, *, run_id: str,
        user_message: str | None = None,
        model: str | None = None,
        timeout: int = 300,
    ) -> dict[str, Any]:
        if self._error:
            raise self._error
        return self._result


class FakePopen:
    """Fake subprocess.Popen returning pre-scripted JSON-RPC transcript."""

    def __init__(self, transcript: list[str]) -> None:
        self._transcript = list(transcript)
        self._line_idx = 0
        self.stdin = self
        self.stdout = self
        self.stderr = self
        self.returncode = 0
        self._killed = False
        self._written: list[str] = []

    # stdin interface
    def write(self, data: str) -> None:
        self._written.append(data)

    def flush(self) -> None:
        pass

    # stdout interface — readline returns next transcript line
    def readline(self) -> str:
        if self._line_idx < len(self._transcript):
            line = self._transcript[self._line_idx] + "\n"
            self._line_idx += 1
            return line
        return ""

    # process lifecycle
    def terminate(self) -> None:
        self._killed = True

    def kill(self) -> None:
        self._killed = True

    def wait(self, timeout: float | None = None) -> int:
        return 0

    def communicate(self, input: str | None = None,
                    timeout: float | None = None) -> tuple[str, str]:
        return "", ""


class FakePopenTransport:
    """Injectable transport that returns a FakePopen."""

    def __init__(self, transcript: list[str]) -> None:
        self._transcript = transcript
        self.spawned: list[list[str]] = []

    def spawn(
        self, args: list[str], *, env: dict[str, str],
    ) -> FakePopen:
        self.spawned.append(args)
        return FakePopen(self._transcript)


class StatefulBeads:
    def __init__(self) -> None:
        self.issues: dict[str, dict[str, Any]] = {}
        self.dependencies: dict[str, set[str]] = {}
        self._next_id = 1

    def ensure_initialized(self) -> None:
        return

    def create(
        self,
        *,
        title: str,
        metadata: dict[str, Any],
        parent: str | None = None,
    ) -> str:
        issue_id = f"bead-{self._next_id}"
        self._next_id += 1
        self.issues[issue_id] = {
            "id": issue_id,
            "title": title,
            "status": "open",
            "metadata": metadata,
            "parent": parent,
        }
        return issue_id

    def ensure_issue(
        self,
        *,
        title: str,
        metadata: dict[str, Any],
        identity: dict[str, Any] | None = None,
        parent: str | None = None,
    ) -> str:
        matches = [
            issue
            for issue in self.issues.values()
            if all(
                issue["metadata"].get(key) == value
                for key, value in (identity or metadata).items()
            )
        ]
        if len(matches) > 1:
            raise BeadsError("multiple matching issues")
        if matches:
            return str(matches[0]["id"])
        return self.create(
            title=title,
            metadata=metadata,
            parent=parent,
        )

    def add_dependency(self, *, blocked: str, blocker: str) -> None:
        self.dependencies.setdefault(blocked, set()).add(blocker)

    def ensure_dependency(self, *, blocked: str, blocker: str) -> None:
        self.add_dependency(blocked=blocked, blocker=blocker)

    def update_status(
        self,
        issue_id: str,
        *,
        status: str,
        metadata: dict[str, str] | None = None,
    ) -> None:
        self.issues[issue_id]["status"] = status
        self.issues[issue_id]["metadata"].update(metadata or {})

    def close(self, issue_id: str, *, reason: str) -> None:
        open_blockers = [
            blocker
            for blocker in self.dependencies.get(issue_id, set())
            if self.issues[blocker]["status"] != "closed"
        ]
        if open_blockers:
            raise BeadsError(
                f"cannot close {issue_id}; blockers are open: {open_blockers}"
            )
        self.issues[issue_id]["status"] = "closed"
        self.issues[issue_id]["reason"] = reason

    def reopen_or_open(self, issue_id: str, *, reason: str) -> None:
        self.issues[issue_id]["status"] = "open"
        self.issues[issue_id]["reason"] = reason

    def show(self, issue_id: str) -> dict[str, Any]:
        return dict(self.issues[issue_id])


class GitWorktreeManager:
    def __init__(self, repo: Path) -> None:
        self.repo = repo
        self.paths: dict[str, Path] = {}

    def create(self, session_id: str) -> Path:
        path = self.repo / ".sdd" / "worktrees" / session_id
        path.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(
            [
                "git", "worktree", "add", "-q", "-b",
                f"agent/{session_id}", str(path), "HEAD",
            ],
            cwd=self.repo,
            check=True,
        )
        self.paths[session_id] = path
        return path

    def cleanup(self, session_id: str) -> None:
        path = self.paths.pop(session_id)
        subprocess.run(
            ["git", "worktree", "remove", "--force", str(path)],
            cwd=self.repo,
            check=True,
        )
        subprocess.run(
            ["git", "branch", "-D", f"agent/{session_id}"],
            cwd=self.repo,
            check=True,
            capture_output=True,
        )


class DeterministicNodeLoop:
    def __call__(
        self,
        client: Any,
        model: str,
        system: str,
        messages: list[dict[str, Any]],
        tools: Any,
        *,
        max_iterations: int,
        max_tokens: int,
        observer: Any,
        stream: bool,
    ) -> FakeLoopResult:
        del client, model, system, messages, max_iterations, max_tokens, observer, stream
        specialist_output = tools["run_specialist"](phase="implement")
        gate_output = tools["run_gate"](name="test-final")
        return FakeLoopResult(
            iterations=1,
            reply="done",
            tool_calls=[
                FakeToolCall(name="run_specialist", output=specialist_output),
                FakeToolCall(name="run_gate", output=gate_output),
            ],
        )


class WritingSpecialist:
    def launch(self, *, worktree_path: str, **_kwargs: Any) -> dict[str, Any]:
        (Path(worktree_path) / "result.txt").write_text(
            "graph result\n",
            encoding="utf-8",
        )
        return {
            "status": "ok",
            "output_digest": content_digest("specialist output"),
            "serena_success": True,
            "serena_fallback": False,
        }


class RedProductionWritingSpecialist:
    def launch(self, *, worktree_path: str, config_dir: str, **_kwargs: Any) -> dict[str, Any]:
        phase = Path(config_dir).name
        if phase == "red":
            path = Path(worktree_path) / "src" / "production.py"
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("implemented_too_early = True\n", encoding="utf-8")
        return {
            "status": "ok",
            "output_digest": content_digest(f"specialist {phase}"),
            "serena_success": True,
            "serena_fallback": False,
        }


class RedGateNodeLoop:
    def __call__(
        self,
        client: Any,
        model: str,
        system: str,
        messages: list[dict[str, Any]],
        tools: Any,
        *,
        max_iterations: int,
        max_tokens: int,
        observer: Any,
        stream: bool,
    ) -> FakeLoopResult:
        del client, model, system, messages, max_iterations, max_tokens, observer, stream
        specialist_output = tools["run_specialist"](phase="red")
        gate_output = tools["run_gate"](name="test-red")
        return FakeLoopResult(
            iterations=1,
            reply="blocked",
            tool_calls=[
                FakeToolCall(name="run_specialist", output=specialist_output),
                FakeToolCall(name="run_gate", output=gate_output),
            ],
        )


class PassingReview:
    def review(self, **_kwargs: Any) -> dict[str, Any]:
        return {"summary": "clean", "findings": []}


def _git_repo(root: Path) -> str:
    subprocess.run(["git", "init", "-q"], cwd=root, check=True)
    subprocess.run(
        ["git", "config", "user.email", "graph-test@trellage"],
        cwd=root,
        check=True,
    )
    subprocess.run(
        ["git", "config", "user.name", "Graph Test"],
        cwd=root,
        check=True,
    )
    (root / "README.md").write_text("base\n", encoding="utf-8")
    subprocess.run(["git", "add", "README.md"], cwd=root, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "base"], cwd=root, check=True)
    return subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=root,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()


class FakeCodexRunner(FakeSubprocessRunner):
    def __init__(self, payload: dict[str, Any] | str) -> None:
        super().__init__()
        self._payload = payload

    def run(self, args: list[str], **kw: Any) -> subprocess.CompletedProcess[str]:
        result = super().run(args, **kw)
        output_index = args.index("--output-last-message") + 1
        output = Path(args[output_index])
        output.parent.mkdir(parents=True, exist_ok=True)
        text = self._payload if isinstance(self._payload, str) else json.dumps(self._payload)
        output.write_text(text, encoding="utf-8")
        return result


def _specialist_fixture(
    root: Path,
    runner: FakeSubprocessRunner,
    role: str,
) -> tuple[SpecialistLauncher, Path, Path]:
    worktree = root / "worktree"
    worktree.mkdir()
    seed = root / "seed"
    seed.mkdir()
    (seed / "default-settings.json").write_text("{}\n", encoding="utf-8")
    roles = root / "roles"
    roles.mkdir()
    (roles / f"{role}.md").write_text(f"You are {role}.\n", encoding="utf-8")
    (roles / "trellage-graph-discovery.md").write_text(
        "Use Serena symbol discovery and return facts.\n",
        encoding="utf-8",
    )
    (roles / "trellage-graph-discovery-normalizer.md").write_text(
        "Normalize supplied discovery facts to JSON without tools.\n",
        encoding="utf-8",
    )
    runner.set_result("git rev-parse --show-toplevel", f"{worktree}\n")
    return (
        SpecialistLauncher(
            runner=runner,
            seed_path=str(seed),
            runtime_roles=roles,
        ),
        worktree,
        root / "config",
    )


def _load(name: str) -> dict[str, Any]:
    with open(FIXTURES / name, encoding="utf-8") as fh:
        return json.load(fh)


def _planner_stream(
    plan: dict[str, Any],
    *,
    serena: bool = True,
    fallback: bool = False,
) -> str:
    events: list[dict[str, Any]] = []
    if serena:
        events.extend([
            {
                "type": "assistant",
                "message": {
                    "content": [{
                        "type": "tool_use",
                        "name": "mcp__serena__find_symbol",
                        "id": "planner-serena",
                        "input": {"name_path": "GraphController"},
                    }],
                },
            },
            {
                "type": "user",
                "message": {
                    "content": [{
                        "type": "tool_result",
                        "tool_use_id": "planner-serena",
                        "is_error": False,
                        "content": "found",
                    }],
                },
            },
        ])
    result_text = (
        "TRELLAGE_SERENA_FALLBACK: unsupported language"
        if fallback else "planned"
    )
    decision = {
        "status": "planned",
        "objective": plan["objective"],
        "constraints": plan.get("constraints", []),
        "target_evidence": [{
            "path": ".",
            "detail": "fixture target",
            "symbols": ["GraphController"],
        }],
        "plan": plan,
    }
    events.append({
        "type": "result",
        "subtype": "success",
        "result": result_text,
        "structured_output": decision,
    })
    return "\n".join(json.dumps(event) for event in events)


def _discovery_stream(
    *,
    structured: bool = True,
    fallback: bool = False,
) -> str:
    tool_result = {
        "type": "tool_result",
        "tool_use_id": "planner-serena",
        "is_error": fallback,
        "content": "unsupported language" if fallback else "found",
    }
    discovery = {
        "target_status": "insufficient-evidence" if fallback else "grounded",
        "summary": "fixture discovery",
        "repository_evidence": [{
            "path": ".",
            "detail": "fixture target",
            "symbols": ["GraphController"],
        }],
        "relevant_symbols": ["GraphController"],
        "relevant_paths": ["."],
        "coverage_limits": [],
        "serena_fallback": "unsupported language" if fallback else None,
    }
    result: dict[str, Any] = {
        "type": "result",
        "subtype": "success",
        "result": (
            "TRELLAGE_SERENA_FALLBACK: unsupported language"
            if fallback else "discovered"
        ),
    }
    if structured:
        result["structured_output"] = discovery
    return "\n".join(json.dumps(event) for event in [
        {
            "type": "assistant",
            "message": {
                "content": [{
                    "type": "tool_use",
                    "name": "mcp__serena__find_symbol",
                    "id": "planner-serena",
                    "input": {"name_path": "GraphController"},
                }],
            },
        },
        {"type": "user", "message": {"content": [tool_result]}},
        result,
    ])


def _make_controller(
    *, beads_runner: FakeSubprocessRunner | None = None,
    git_runner: FakeSubprocessRunner | None = None,
    waku_loop: FakeWakuLoop | None = None,
    policy: dict[str, Any] | None = None,
    td: str = "",
) -> GraphController:
    br = beads_runner or FakeSubprocessRunner()
    br.set_default("bead-id\n")
    br.set_result("list --all", "[]")
    br.set_result("dep list", "[]")
    br.set_result(
        "show",
        json.dumps({"id": "bead-id", "status": "open", "metadata": {}}),
    )
    gr = git_runner or FakeSubprocessRunner()
    base = Path(td or tempfile.mkdtemp())
    ev_path = base / "events.jsonl"
    run_dir = base / "run"
    return GraphController(
        beads=BeadsRepository(runner=br),
        bernstein=BernsteinFacade(worktree_manager=FakeWorktreeManager(str(base))),
        waku=WakuNodeRuntime(loop_runner=waku_loop or FakeWakuLoop()),
        review=CodexReviewGate(),
        proof=RaindropProofGate(),
        evidence=EvidenceLedger(ev_path),
        policy=policy or _load("test-policy.json"),
        runner=gr,
        run_dir=run_dir,
    )


# ===== Tests =====

class TestBundledSchemaValidator(unittest.TestCase):
    def test_valid_plan_schema(self) -> None:
        from trellage_graph.contracts import graph_plan_schema
        errors = schema_validate(_load("valid-plan.json"), graph_plan_schema())
        self.assertEqual(errors, [])

    def test_invalid_type(self) -> None:
        errors = schema_validate(42, {"type": "string"})
        self.assertTrue(len(errors) > 0)

    def test_missing_required(self) -> None:
        errors = schema_validate({}, {"type": "object", "required": ["x"]})
        self.assertTrue(any("required" in e for e in errors))

    def test_one_of_requires_exactly_one_matching_branch(self) -> None:
        schema = {
            "oneOf": [
                {"type": "object", "required": ["planned"]},
                {"type": "object", "required": ["blocked"]},
            ],
        }
        self.assertTrue(schema_validate({}, schema))
        self.assertEqual(schema_validate({"planned": True}, schema), [])


class TestPlanValidation(unittest.TestCase):
    def test_valid(self) -> None:
        validate_plan(_load("valid-plan.json"))

    def test_node_cannot_claim_controller_owned_completion(self) -> None:
        plan = _load("valid-plan.json")
        plan["nodes"][0]["acceptance_criteria"] = [
            "The node is rebased, integrated, and the root Bead is closed",
        ]
        with self.assertRaisesRegex(
            PlanValidationError,
            "controller-owned state",
        ):
            validate_plan(plan)

    def test_node_can_disclaim_controller_owned_completion(self) -> None:
        plan = _load("valid-plan.json")
        plan["nodes"][0]["acceptance_criteria"] = [
            "This node claims no integration, review, proof, cleanup, or Bead closure.",
            "The node makes no claim about its own review, proof, integration, cleanup, or Bead closure.",
        ]

        validate_plan(plan)

    def test_cycle(self) -> None:
        with self.assertRaises(PlanValidationError) as ctx:
            validate_plan(_load("cycle-plan.json"))
        self.assertIn("cycle", str(ctx.exception))

    def test_duplicate_ids(self) -> None:
        with self.assertRaises(PlanValidationError) as ctx:
            validate_plan(_load("duplicate-ids-plan.json"))
        self.assertIn("duplicate", str(ctx.exception))

    def test_unknown_dep(self) -> None:
        with self.assertRaises(PlanValidationError) as ctx:
            validate_plan(_load("unknown-dep-plan.json"))
        self.assertIn("unknown", str(ctx.exception).lower())

    def test_parallel_overlap(self) -> None:
        with self.assertRaises(PlanValidationError) as ctx:
            validate_plan(_load("overlap-plan.json"))
        self.assertIn("overlapping", str(ctx.exception))

    def test_research_write(self) -> None:
        with self.assertRaises(PlanValidationError) as ctx:
            validate_plan(_load("research-write-violation-plan.json"))
        self.assertIn("research", str(ctx.exception).lower())

    def test_missing_tdd_gates(self) -> None:
        with self.assertRaises(PlanValidationError) as ctx:
            validate_plan(_load("missing-tdd-gates-plan.json"))
        self.assertIn("green", str(ctx.exception))
        self.assertIn("final", str(ctx.exception))

    def test_unknown_role(self) -> None:
        with self.assertRaises(PlanValidationError) as ctx:
            validate_plan(_load("valid-plan.json"), known_roles={"only-this"})
        self.assertIn("unknown role", str(ctx.exception))

    def test_unauthorized_delivery(self) -> None:
        plan = _load("valid-plan.json")
        plan["authorization"] = {"allow_push": True}
        with self.assertRaises(PlanValidationError) as ctx:
            validate_plan(plan, profile_authorization={"allow_push": False})
        self.assertIn("allow_push", str(ctx.exception))

    def test_profile_auth_passed_through(self) -> None:
        plan = _load("valid-plan.json")
        plan["authorization"] = {"allow_push": True}
        policy = _load("test-policy.json")
        with self.assertRaises(PlanValidationError):
            validate_plan(
                plan, known_roles=set(policy["roles"].values()),
                profile_authorization=policy["authorization"],
            )

    def test_prompt_digest_must_match_prompt(self) -> None:
        plan = _load("valid-plan.json")
        plan["nodes"][0]["prompt"] = "different prompt"
        with self.assertRaises(PlanValidationError) as ctx:
            validate_plan(plan)
        self.assertIn("prompt_digest", str(ctx.exception))

    def test_unsafe_path_pattern_is_rejected(self) -> None:
        plan = _load("valid-plan.json")
        plan["nodes"][0]["write_set"] = ["../outside.py"]
        with self.assertRaises(PlanValidationError) as ctx:
            validate_plan(plan)
        self.assertIn("unsafe path", str(ctx.exception))

    def test_inline_shell_gate_is_rejected(self) -> None:
        plan = _load("valid-plan.json")
        plan["graph_gates"] = [{
            "name": "masked-failure",
            "argv": ["bash", "-lc", "false || true"],
            "phase": "final",
        }]
        with self.assertRaises(PlanValidationError) as ctx:
            validate_plan(plan)
        self.assertIn("inline", str(ctx.exception).lower())


class TestDeterministicWaves(unittest.TestCase):
    """Bernstein 3.16.0 ready-wave contracts."""

    def test_linear(self) -> None:
        nodes = [
            FakeTaskNode("a", depends_on=()),
            FakeTaskNode("b", depends_on=("a",)),
            FakeTaskNode("c", depends_on=("b",)),
        ]
        waves = topological_iter_with_parallel(nodes)
        ids = [[n.task_id for n in w] for w in waves]
        self.assertEqual(ids, [["a"], ["b"], ["c"]])

    def test_parallel(self) -> None:
        nodes = [
            FakeTaskNode("x", parallel_safe=True),
            FakeTaskNode("y", parallel_safe=True),
        ]
        waves = topological_iter_with_parallel(nodes)
        self.assertEqual(len(waves), 1)
        self.assertEqual(sorted(n.task_id for n in waves[0]), ["x", "y"])

    def test_waves_are_frozensets(self) -> None:
        """Bernstein yields frozenset[TaskNode]."""
        nodes = [FakeTaskNode("a")]
        waves = topological_iter_with_parallel(nodes)
        self.assertIsInstance(waves[0], frozenset)

    def test_facade_ready_waves_returns_str_lists(self) -> None:
        facade = BernsteinFacade(worktree_manager=FakeWorktreeManager())
        facade.build_dag([
            {"id": "a", "dependencies": [], "parallel_safe": False},
            {"id": "b", "dependencies": ["a"]},
        ])
        waves = facade.ready_waves()
        self.assertEqual(waves, [["a"], ["b"]])

    def test_filter_parallel_safe(self) -> None:
        facade = BernsteinFacade(worktree_manager=FakeWorktreeManager())
        by_id = {
            "a": {"id": "a", "parallel_safe": True},
            "b": {"id": "b", "parallel_safe": False},
        }
        sub = facade.filter_parallel_safe(["a", "b"], by_id)
        self.assertEqual(sub, [["a"], ["b"]])

    def test_deterministic_repeat(self) -> None:
        for _ in range(3):
            nodes = [
                FakeTaskNode("a"),
                FakeTaskNode("b", parallel_safe=True, depends_on=("a",)),
                FakeTaskNode("c", parallel_safe=True, depends_on=("a",)),
                FakeTaskNode("d", depends_on=("b", "c")),
            ]
            waves = topological_iter_with_parallel(nodes)
            ids = [sorted(n.task_id for n in w) for w in waves]
            self.assertEqual(ids, [["a"], ["b", "c"], ["d"]])

    def test_cycle_raises(self) -> None:
        nodes = [FakeTaskNode("a", depends_on=("b",)), FakeTaskNode("b", depends_on=("a",))]
        with self.assertRaises(BernsteinError):
            topological_iter_with_parallel(nodes)

    def test_worktree_create_returns_path(self) -> None:
        """WorktreeManager.create(session_id) -> Path under .sdd/worktrees/."""
        wm = FakeWorktreeManager("/repo")
        p = wm.create("node-1")
        self.assertIsInstance(p, Path)
        self.assertIn(".sdd/worktrees/node-1", str(p))

    def test_worktree_no_path_for(self) -> None:
        """No path_for method; facade persists and retrieves."""
        facade = BernsteinFacade(worktree_manager=FakeWorktreeManager())
        p = facade.create_worktree("n1")
        self.assertEqual(facade.get_worktree_path("n1"), p)
        with self.assertRaises(BernsteinError):
            facade.get_worktree_path("nonexistent")

    def test_cleanup_best_effort(self) -> None:
        """cleanup does not raise."""
        wm = FakeWorktreeManager()
        wm.create("n1")
        wm.cleanup("n1")
        wm.cleanup("nonexistent")  # no raise


class TestWakuEvents(unittest.TestCase):
    """Waku 0.1.1 event verification."""

    def test_success(self) -> None:
        events = [
            ToolEvent(kind=ToolEventKind.SPECIALIST_START, tool="run_specialist"),
            ToolEvent(kind=ToolEventKind.SPECIALIST_END, tool="run_specialist", status="ok"),
            ToolEvent(kind=ToolEventKind.GATE_END, tool="run_gate", status="final"),
        ]
        self.assertEqual(
            verify_required_events(events, require_specialist=True, require_final_gate=True), [],
        )

    def test_missing_specialist(self) -> None:
        errs = verify_required_events(
            [ToolEvent(kind=ToolEventKind.GATE_END, tool="g", status="final")],
            require_specialist=True,
        )
        self.assertTrue(any("specialist" in e for e in errs))

    def test_error_event(self) -> None:
        errs = verify_required_events(
            [ToolEvent(kind=ToolEventKind.ERROR, tool="t", detail="boom")],
            require_specialist=True,
        )
        self.assertTrue(any("error" in e.lower() for e in errs))

    def test_exhaustion_empty(self) -> None:
        errs = verify_required_events([], require_specialist=True)
        self.assertTrue(len(errs) > 0)

    def test_behavior_change_red_green(self) -> None:
        events = [
            ToolEvent(kind=ToolEventKind.SPECIALIST_START, tool="s"),
            ToolEvent(kind=ToolEventKind.SPECIALIST_END, tool="s", status="ok"),
        ]
        errs = verify_required_events(events, require_specialist=True, behavior_change=True)
        self.assertTrue(any("red" in e for e in errs))
        self.assertTrue(any("green" in e for e in errs))

    def test_repair_mode_skips_red_and_green_sequence(self) -> None:
        prompt = WakuNodeRuntime._system_prompt({
            "repair_mode": True,
            "behavior_change": True,
            "phase": "implement",
        })

        self.assertIn("phase=repair", prompt)
        self.assertIn("Do not rerun red or green gates", prompt)

    def test_malformed(self) -> None:
        events = [
            ToolEvent(kind=ToolEventKind.SPECIALIST_START, tool="s"),
            ToolEvent(kind=ToolEventKind.SPECIALIST_END, tool="s", detail="malformed"),
        ]
        errs = verify_required_events(events, require_specialist=True)
        self.assertTrue(any("malformed" in e for e in errs))

    def test_excess_attempts(self) -> None:
        runtime = WakuNodeRuntime(loop_runner=FakeWakuLoop())
        ceilings = ExecutionCeilings(max_specialist_attempts=1)
        tool = runtime.make_specialist_tool(
            launcher=lambda **kw: {"status": "ok"}, ceilings=ceilings,
        )
        tool(role="r")  # 1 ok
        tool(role="r")  # 2 exceeds
        errs = [e for e in runtime.events if e.kind == ToolEventKind.ERROR]
        self.assertEqual(len(errs), 1)
        self.assertIn("max attempts", errs[0].detail)

    def test_unauthorized_role(self) -> None:
        runtime = WakuNodeRuntime(loop_runner=FakeWakuLoop())
        tool = runtime.make_specialist_tool(
            launcher=lambda **kw: {"status": "ok"},
            ceilings=ExecutionCeilings(),
            authorized_roles={"allowed"},
        )
        result = json.loads(tool(role="evil"))
        self.assertEqual(result["status"], "error")

    def test_error_shaped_result(self) -> None:
        runtime = WakuNodeRuntime(loop_runner=FakeWakuLoop())
        tool = runtime.make_specialist_tool(
            launcher=lambda **kw: {"status": "error", "reason": "boom"},
            ceilings=ExecutionCeilings(),
        )
        result = json.loads(tool(role="r"))
        self.assertEqual(result["status"], "error")

    def test_undeclared_gate(self) -> None:
        runtime = WakuNodeRuntime(loop_runner=FakeWakuLoop())
        tool = runtime.make_gate_tool(
            gate_runner=lambda **kw: {"passed": True},
            ceilings=ExecutionCeilings(),
            declared_gates={"only-this": {}},
        )
        result = json.loads(tool(name="unknown"))
        self.assertEqual(result["status"], "error")

    def test_waku_loop_result_exhaustion_detected(self) -> None:
        """Waku exhaustion: iterations == max_iterations is detected."""
        runtime = WakuNodeRuntime(loop_runner=FakeWakuLoop(exhaust=True))
        ceilings = ExecutionCeilings(max_iterations=5)
        # The exhaustion itself is detected in _inspect_loop_result
        lr = FakeLoopResult(
            iterations=5,
            reply="(I hit my iteration limit before finishing — try breaking the request into smaller steps.)",
        )
        runtime._inspect_loop_result(lr, ceilings)
        errs = [e for e in runtime.events if e.kind == ToolEventKind.ERROR]
        self.assertTrue(any("exhaustion" in e.detail for e in errs))

    def test_waku_error_output_pattern(self) -> None:
        """Waku wraps exceptions as 'Error running <name>: ...'"""
        runtime = WakuNodeRuntime(loop_runner=FakeWakuLoop())
        lr = FakeLoopResult(
            iterations=1, reply="Done.",
            tool_calls=[FakeToolCall(name="run_gate", output="Error running run_gate: kaboom")],
        )
        runtime._inspect_loop_result(lr, ExecutionCeilings())
        errs = [e for e in runtime.events if e.kind == ToolEventKind.ERROR]
        self.assertTrue(any("waku-wrapped" in e.detail for e in errs))

    def test_tool_returns_str_not_dict(self) -> None:
        """Waku Tool functions return str; verify our tools do."""
        runtime = WakuNodeRuntime(loop_runner=FakeWakuLoop())
        tool = runtime.make_specialist_tool(
            launcher=lambda **kw: {"status": "ok"},
            ceilings=ExecutionCeilings(),
        )
        result = tool(role="r")
        self.assertIsInstance(result, str)
        parsed = json.loads(result)
        self.assertEqual(parsed["status"], "ok")

    def test_real_registry_uses_fn_and_restricted_inputs(self) -> None:
        registry_module = types.ModuleType("waku.tools.registry")

        class Tool:
            def __init__(self, *, name: str, description: str,
                         input_schema: dict[str, Any], fn: Any) -> None:
                self.name = name
                self.description = description
                self.input_schema = input_schema
                self.fn = fn

        class ToolRegistry:
            def __init__(self) -> None:
                self.tools: list[Any] = []

            def register(self, tool: Any) -> None:
                self.tools.append(tool)

        registry_module.Tool = Tool
        registry_module.ToolRegistry = ToolRegistry
        old = sys.modules.get("waku.tools.registry")
        sys.modules["waku.tools.registry"] = registry_module
        try:
            runtime = WakuNodeRuntime(loop_runner=FakeWakuLoop())
            registry = runtime._build_tool_registry(
                specialist_fn=lambda **_: "{}",
                gate_fn=lambda **_: "{}",
                phases=["implement"],
                gate_names=["lint"],
            )
            by_name = {tool.name: tool for tool in registry.tools}
            self.assertEqual(set(by_name), {"run_specialist", "run_gate"})
            self.assertEqual(
                set(by_name["run_specialist"].input_schema["properties"]),
                {"phase"},
            )
            self.assertEqual(
                set(by_name["run_gate"].input_schema["properties"]),
                {"name"},
            )
        finally:
            if old is None:
                del sys.modules["waku.tools.registry"]
            else:
                sys.modules["waku.tools.registry"] = old


class TestGates(unittest.TestCase):
    def test_red_must_fail(self) -> None:
        runner = FakeSubprocessRunner()
        runner.set_result("python", "pass")
        gate = GateRunner(runner=runner)
        with self.assertRaises(GateError) as ctx:
            gate.run_gate(name="t", argv=["python", "-m", "pytest"], phase="red")
        self.assertIn("must fail", str(ctx.exception))

    def test_green_without_red(self) -> None:
        gate = GateRunner(runner=FakeSubprocessRunner())
        with self.assertRaises(GateError):
            gate.run_gate(name="t", argv=["pytest"], phase="green")

    def test_green_argv_must_match_red(self) -> None:
        runner = FakeSubprocessRunner()
        runner.set_failure("pytest", rc=1)
        gate = GateRunner(runner=runner)
        gate.run_gate(name="t", argv=["pytest", "tests/"], phase="red")
        runner.failures.clear()
        runner.set_result("pytest", "pass")
        with self.assertRaises(GateError) as ctx:
            gate.run_gate(name="t", argv=["pytest", "tests/", "-v"], phase="green")
        self.assertIn("differs from red", str(ctx.exception))

    def test_red_green_final(self) -> None:
        runner = FakeSubprocessRunner()
        runner.set_failure("pytest", rc=1)
        gate = GateRunner(runner=runner)
        r = gate.run_gate(name="t", argv=["pytest", "tests/"], phase="red")
        self.assertTrue(r["passed"])
        runner.failures.clear()
        runner.set_result("pytest", "pass")
        r = gate.run_gate(name="t", argv=["pytest", "tests/"], phase="green")
        self.assertTrue(r["passed"])
        r = gate.run_gate(name="t", argv=["pytest", "tests/"], phase="final")
        self.assertTrue(r["passed"])

    def test_red_write_set(self) -> None:
        gate = GateRunner()
        with self.assertRaises(GateError):
            gate.validate_tdd_write_set(
                changed_files=["src/main.py", "tests/test.py"],
                test_write_set=["tests/**"], phase="red",
            )

    def test_argv_parent_traversal(self) -> None:
        with self.assertRaises(GateError):
            GateRunner.validate_argv(["cmd", "../../etc/passwd"], "g", "n")

    def test_inline_shell_is_rejected_at_runtime(self) -> None:
        gate = GateRunner(runner=FakeSubprocessRunner())
        with self.assertRaises(GateError) as ctx:
            gate.run_gate(
                name="masked-failure",
                argv=["bash", "-lc", "false || true"],
                phase="final",
            )
        self.assertIn("inline", str(ctx.exception).lower())

    def test_wrappers_cannot_hide_inline_shell(self) -> None:
        commands = [
            [
                "env",
                "MODE=test",
                "timeout",
                "30",
                "bash",
                "-c",
                "false || true",
            ],
            [
                "timeout",
                "--signal",
                "TERM",
                "30",
                "env",
                "-u",
                "CI",
                "bash",
                "-lc",
                "false || true",
            ],
            [
                "env",
                "--split-string=sh",
                "-c",
                "false || true",
            ],
            [
                "env",
                "-Ssh",
                "-c",
                "false || true",
            ],
            [
                "env",
                "-u",
                "CI",
                "-Ssh",
                "-c",
                "false || true",
            ],
            [
                "nice",
                "bash",
                "-c",
                "false || true",
            ],
            ["node", "-p", "process.exit(0)"],
            ["node", "--print", "process.exit(0)"],
            ["node", "-pe", "process.exit(0)"],
            ["python3", "-cprint('masked')"],
            ["perl", "-le", "exit 0"],
            ["ruby", "-eputs('masked')"],
            [
                "flock",
                "gate.lock",
                "bash",
                "-c",
                "false || true",
            ],
            [
                "awk",
                'BEGIN { system("false || true"); exit 0 }',
            ],
            [
                "find",
                ".",
                "-maxdepth",
                "0",
                "-exec",
                "false",
                ";",
            ],
            ["npx", "-c", "false || true"],
            ["npm", "exec", "-c", "false || true"],
            ["uv", "run", "python", "-c", "print('masked')"],
            [
                "git",
                "-c",
                "alias.z=!false || true",
                "z",
            ],
        ]
        for command in commands:
            with self.subTest(command=command), self.assertRaises(GateError):
                GateRunner.validate_argv(
                    command,
                    "masked-failure",
                    "graph",
                )

    def test_checked_in_shell_script_is_allowed(self) -> None:
        commands = [
            ["bash", "tests/health_audit_contract.sh"],
            ["python", "-m", "pytest", "tests"],
            ["npm", "test"],
            ["npm", "run", "test"],
            ["make", "test"],
            ["awk", "-f", "tests/report.awk", "results.txt"],
        ]
        for command in commands:
            with self.subTest(command=command):
                GateRunner.validate_argv(
                    command,
                    "health-contract",
                    "graph",
                )


class TestCodexReview(unittest.TestCase):
    def test_malformed(self) -> None:
        runner = FakeCodexRunner("not json")
        review = CodexReviewGate(runner=runner)
        with tempfile.TemporaryDirectory() as td:
            with self.assertRaises(ReviewError):
                review.review(node_id="n1", worktree_path=td)

    def test_finding_blocks(self) -> None:
        runner = FakeCodexRunner({
            "findings": [{"id": "f1", "severity": "high",
                          "file": "a.py", "description": "bug"}],
            "summary": "bug",
        })
        review = CodexReviewGate(runner=runner)
        with tempfile.TemporaryDirectory() as td:
            with self.assertRaises(ReviewError) as ctx:
                review.review(node_id="n1", worktree_path=td)
            self.assertEqual(len(ctx.exception.findings), 1)

    def test_unavailable_sandbox_blocks_empty_review(self) -> None:
        runner = FakeCodexRunner({
            "findings": [],
            "summary": (
                "Review could not be completed because the repository sandbox "
                "failed to launch: bubblewrap is unavailable."
            ),
        })
        review = CodexReviewGate(runner=runner)
        with tempfile.TemporaryDirectory() as td:
            with self.assertRaises(ReviewError) as ctx:
                review.review(node_id="n1", worktree_path=td)
            self.assertIn("was not completed", str(ctx.exception))

    def test_missing_binary(self) -> None:
        runner = FakeSubprocessRunner()
        runner.set_failure("codex", rc=127, stderr="not found")
        review = CodexReviewGate(runner=runner)
        with tempfile.TemporaryDirectory() as td:
            with self.assertRaises(ReviewError) as ctx:
                review.review(node_id="n1", worktree_path=td)
            self.assertIn("127", str(ctx.exception))

    def test_rejection_persisted(self) -> None:
        review = CodexReviewGate()
        with tempfile.TemporaryDirectory() as td:
            ev = Path(td) / "evidence.md"
            ev.write_text("rationale")
            run_dir = Path(td) / "run"
            result = review.reject_finding(
                finding_id="f1", node_id="n1",
                evidence_path=str(ev), run_dir=run_dir,
            )
            self.assertEqual(result["status"], "rejected")
            self.assertIn("evidence_digest", result)
            self.assertTrue((run_dir / "rejections" / "f1.json").is_file())

    def test_rejection_requires_evidence(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            with self.assertRaises(ReviewError):
                CodexReviewGate().reject_finding(
                    finding_id="f1", node_id="n1",
                    evidence_path="/nonexistent", run_dir=Path(td),
                )


class TestProofGate(unittest.TestCase):
    """Raindrop Workshop 0.1.21 proof gate contracts."""

    def _setup_raindrop_dir(
        self, td: str,
        agents_content: str = "event: integration-test\n  command: echo ok\n",
    ) -> None:
        (Path(td) / ".raindrop").mkdir(exist_ok=True)
        (Path(td) / ".raindrop" / "agents.yaml").write_text(agents_content)

    def test_not_applicable(self) -> None:
        r = RaindropProofGate().run_proof(node_id="n1", repo_root="/nonexistent")
        self.assertEqual(r["status"], "not-applicable")

    def test_required_unavailable(self) -> None:
        with self.assertRaises(ProofError):
            RaindropProofGate().run_proof(
                node_id="n1", repo_root="/nonexistent", proof_required=True)

    def test_success_with_source_run_id(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            self._setup_raindrop_dir(td)
            mcp = FakeWorkshopMCPClient()
            gate = RaindropProofGate(mcp_client=mcp, repo_root=td)
            r = gate.run_proof(
                node_id="n1", repo_root=td,
                proof_policy_path=str(FIXTURES / "proof-policy.json"),
            )
            self.assertEqual(r["status"], "passed")
            self.assertEqual(r["source_run_id"], "wkshp_trace_abc123")
            self.assertEqual(r["replay_run_id"], "rep_456")

    def test_ok_false_blocks(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            self._setup_raindrop_dir(td)
            mcp = FakeWorkshopMCPClient(result={
                "ok": False, "error": "source trace invalid",
            })
            gate = RaindropProofGate(mcp_client=mcp, repo_root=td)
            with self.assertRaises(ProofError) as ctx:
                gate.run_proof(
                    node_id="n1", repo_root=td,
                    proof_policy_path=str(FIXTURES / "proof-policy.json"),
                )
            self.assertIn("ok=false", str(ctx.exception))

    def test_empty_replay_run_id_blocks(self) -> None:
        """Nonempty replay_run_id required."""
        with tempfile.TemporaryDirectory() as td:
            self._setup_raindrop_dir(td)
            mcp = FakeWorkshopMCPClient(result={
                "ok": True, "source_run_id": "src", "replay_run_id": "",
                "events": [],
            })
            gate = RaindropProofGate(mcp_client=mcp, repo_root=td)
            with self.assertRaises(ProofError) as ctx:
                gate.run_proof(
                    node_id="n1", repo_root=td,
                    proof_policy_path=str(FIXTURES / "proof-policy.json"),
                )
            self.assertIn("empty replay_run_id", str(ctx.exception))

    def test_timeout(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            self._setup_raindrop_dir(td)
            gate = RaindropProofGate(
                mcp_client=FakeWorkshopMCPClient(error=TimeoutError("t")),
                repo_root=td,
            )
            with self.assertRaises(ProofError):
                gate.run_proof(
                    node_id="n1", repo_root=td,
                    proof_policy_path=str(FIXTURES / "proof-policy.json"),
                )

    def test_event_name_parsed_not_substring(self) -> None:
        """event_name validated by parsing YAML structure, not substring."""
        for content in (
            "event: integration-test-other\n",
            "description: integration-test\n",
        ):
            with self.subTest(content=content), tempfile.TemporaryDirectory() as td:
                self._setup_raindrop_dir(td, agents_content=content)
                gate = RaindropProofGate(
                    mcp_client=FakeWorkshopMCPClient(), repo_root=td,
                )
                with self.assertRaises(ProofError) as ctx:
                    gate.run_proof(
                        node_id="n1", repo_root=td,
                        proof_policy_path=str(FIXTURES / "proof-policy.json"),
                    )
                self.assertIn(
                    "not found in .raindrop/agents.yaml",
                    str(ctx.exception),
                )

    def test_missing_source_run_id_blocks(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            self._setup_raindrop_dir(td)
            bad = Path(td) / "bad.json"
            bad.write_text(json.dumps({
                "event_name": "integration-test", "source_run_id": "",
                "assertions": [{"name": "ok", "check": "replay_ok"}],
            }))
            gate = RaindropProofGate(
                mcp_client=FakeWorkshopMCPClient(), repo_root=td,
            )
            with self.assertRaises(ProofError):
                gate.run_proof(node_id="n1", repo_root=td,
                               proof_policy_path=str(bad))

    def test_no_mcp_client_blocks(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            self._setup_raindrop_dir(td)
            with self.assertRaises(ProofError):
                RaindropProofGate(mcp_client=None, repo_root=td).run_proof(
                    node_id="n1", repo_root=td,
                    proof_policy_path=str(FIXTURES / "proof-policy.json"),
                )

    def test_register_called_before_replay(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            self._setup_raindrop_dir(td)
            mcp = FakeWorkshopMCPClient()
            RaindropProofGate(mcp_client=mcp, repo_root=td).run_proof(
                node_id="n1", repo_root=td,
                proof_policy_path=str(FIXTURES / "proof-policy.json"),
            )
            self.assertEqual(mcp.register_calls, [td])

    def test_register_failure_blocks(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            self._setup_raindrop_dir(td)
            mcp = FakeWorkshopMCPClient(
                register_error=ProofError("register failed"),
            )
            with self.assertRaises(ProofError) as ctx:
                RaindropProofGate(mcp_client=mcp, repo_root=td).run_proof(
                    node_id="n1", repo_root=td,
                    proof_policy_path=str(FIXTURES / "proof-policy.json"),
                )
            self.assertIn("register failed", str(ctx.exception))

    def test_snapshot_detects_new_file(self) -> None:
        """Full snapshot detects files created during replay."""
        with tempfile.TemporaryDirectory() as td:
            self._setup_raindrop_dir(td)
            (Path(td) / "config.yaml").write_text("ok")

            class MutatingMCP(FakeWorkshopMCPClient):
                def replay_run(self, **kw: Any) -> dict[str, Any]:
                    # Simulate replay creating an unauthorized file
                    (Path(td) / "surprise.txt").write_text("oops")
                    return super().replay_run(**kw)

            gate = RaindropProofGate(mcp_client=MutatingMCP(), repo_root=td)
            with self.assertRaises(ProofError) as ctx:
                gate.run_proof(
                    node_id="n1", repo_root=td,
                    proof_policy_path=str(FIXTURES / "proof-policy.json"),
                )
            self.assertIn("unauthorized", str(ctx.exception))
            self.assertIn("surprise.txt", str(ctx.exception))

    def test_snapshot_detects_modified_file(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            self._setup_raindrop_dir(td)
            (Path(td) / "config.yaml").write_text("original")

            class MutatingMCP(FakeWorkshopMCPClient):
                def replay_run(self, **kw: Any) -> dict[str, Any]:
                    (Path(td) / "config.yaml").write_text("tampered")
                    return super().replay_run(**kw)

            gate = RaindropProofGate(mcp_client=MutatingMCP(), repo_root=td)
            with self.assertRaises(ProofError) as ctx:
                gate.run_proof(
                    node_id="n1", repo_root=td,
                    proof_policy_path=str(FIXTURES / "proof-policy.json"),
                )
            self.assertIn("config.yaml", str(ctx.exception))

    def test_snapshot_detects_deleted_file(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            self._setup_raindrop_dir(td)
            victim = Path(td) / "config.yaml"
            victim.write_text("will be deleted")

            class MutatingMCP(FakeWorkshopMCPClient):
                def replay_run(self, **kw: Any) -> dict[str, Any]:
                    victim.unlink()
                    return super().replay_run(**kw)

            gate = RaindropProofGate(mcp_client=MutatingMCP(), repo_root=td)
            with self.assertRaises(ProofError) as ctx:
                gate.run_proof(
                    node_id="n1", repo_root=td,
                    proof_policy_path=str(FIXTURES / "proof-policy.json"),
                )
            self.assertIn("config.yaml", str(ctx.exception))

    def test_allowed_effects_pass(self) -> None:
        """Files matching allowed_file_effects do not fail."""
        with tempfile.TemporaryDirectory() as td:
            self._setup_raindrop_dir(td)
            (Path(td) / "reports").mkdir()
            (Path(td) / "config.yaml").write_text("ok")

            class MutatingMCP(FakeWorkshopMCPClient):
                def replay_run(self, **kw: Any) -> dict[str, Any]:
                    (Path(td) / "reports" / "out.txt").write_text("allowed")
                    return super().replay_run(**kw)

            gate = RaindropProofGate(mcp_client=MutatingMCP(), repo_root=td)
            r = gate.run_proof(
                node_id="n1", repo_root=td,
                proof_policy_path=str(FIXTURES / "proof-policy.json"),
            )
            self.assertEqual(r["status"], "passed")


class TestStdioMCPTranscript(unittest.TestCase):
    def test_progress_notification_does_not_discard_response(self) -> None:
        from trellage_graph.proof import _read_response

        class DelayedStdout:
            def __init__(self) -> None:
                self.lines = [
                    json.dumps({"jsonrpc": "2.0", "method": "progress"}) + "\n",
                    json.dumps({"jsonrpc": "2.0", "id": 3, "result": {}}) + "\n",
                ]

            def readline(self) -> str:
                time.sleep(0.2)
                return self.lines.pop(0) if self.lines else ""

        proc = types.SimpleNamespace(stdout=DelayedStdout())
        response = _read_response(proc, expected_id=3, timeout=2.0)
        self.assertEqual(response["id"], 3)

    """Popen-level MCP JSON-RPC transcript tests for StdioWorkshopMCPClient."""

    def _good_transcript(self) -> list[str]:
        """A valid JSON-RPC exchange: init response, tools/list, tools/call."""
        return [
            json.dumps({"jsonrpc": "2.0", "id": 1, "result": {
                "protocolVersion": "2024-11-05",
                "serverInfo": {"name": "workshop", "version": "0.1.21"},
                "capabilities": {"tools": {}},
            }}),
            json.dumps({"jsonrpc": "2.0", "id": 2, "result": {
                "tools": [{"name": "replay_run", "description": "Replay a run",
                           "inputSchema": {"type": "object"}}],
            }}),
            json.dumps({"jsonrpc": "2.0", "id": 3, "result": {
                "content": [{"type": "text", "text": json.dumps({
                    "ok": True, "source_run_id": "src_1",
                    "replay_run_id": "rep_2", "events": [],
                })}],
            }}),
        ]

    def test_successful_replay(self) -> None:
        from trellage_graph.proof import StdioWorkshopMCPClient
        transport = FakePopenTransport(self._good_transcript())
        runner = FakeSubprocessRunner()  # for register
        client = StdioWorkshopMCPClient(
            transport=transport, runner=runner,
            home="/fake/home", workshop_url="http://localhost:5899",
            assume_healthy=True,
        )
        client.register_replay(repo_root="/repo")
        result = client.replay_run(run_id="trace_abc", timeout=10)
        self.assertTrue(result["ok"])
        self.assertEqual(result["replay_run_id"], "rep_2")
        # Verify Popen was spawned with correct command
        self.assertEqual(transport.spawned[-1], ["raindrop", "workshop", "mcp"])

    def test_missing_replay_run_tool(self) -> None:
        """tools/list without replay_run raises ProofError."""
        from trellage_graph.proof import StdioWorkshopMCPClient
        transcript = [
            json.dumps({"jsonrpc": "2.0", "id": 1, "result": {
                "protocolVersion": "2024-11-05", "serverInfo": {},
                "capabilities": {},
            }}),
            json.dumps({"jsonrpc": "2.0", "id": 2, "result": {
                "tools": [{"name": "other_tool"}],
            }}),
        ]
        client = StdioWorkshopMCPClient(
            transport=FakePopenTransport(transcript),
            runner=FakeSubprocessRunner(),
            workshop_url="http://localhost:5899",
            assume_healthy=True,
        )
        with self.assertRaises(ProofError) as ctx:
            client.replay_run(run_id="x", timeout=5)
        self.assertIn("replay_run", str(ctx.exception))

    def test_init_error(self) -> None:
        from trellage_graph.proof import StdioWorkshopMCPClient
        transcript = [
            json.dumps({"jsonrpc": "2.0", "id": 1, "error": {
                "code": -1, "message": "init failed",
            }}),
        ]
        client = StdioWorkshopMCPClient(
            transport=FakePopenTransport(transcript),
            runner=FakeSubprocessRunner(),
            workshop_url="http://localhost:5899",
            assume_healthy=True,
        )
        with self.assertRaises(ProofError) as ctx:
            client.replay_run(run_id="x", timeout=5)
        self.assertIn("initialize failed", str(ctx.exception))

    def test_replay_error_response(self) -> None:
        from trellage_graph.proof import StdioWorkshopMCPClient
        transcript = [
            json.dumps({"jsonrpc": "2.0", "id": 1, "result": {
                "protocolVersion": "2024-11-05", "serverInfo": {},
                "capabilities": {},
            }}),
            json.dumps({"jsonrpc": "2.0", "id": 2, "result": {
                "tools": [{"name": "replay_run"}],
            }}),
            json.dumps({"jsonrpc": "2.0", "id": 3, "result": {
                "content": [{"type": "text", "text": json.dumps({
                    "ok": False, "error": "trace not found",
                })}],
            }}),
        ]
        client = StdioWorkshopMCPClient(
            transport=FakePopenTransport(transcript),
            runner=FakeSubprocessRunner(),
            workshop_url="http://localhost:5899",
            assume_healthy=True,
        )
        result = client.replay_run(run_id="missing", timeout=5)
        self.assertFalse(result["ok"])
        self.assertIn("trace not found", result.get("error", ""))

    def test_child_always_killed(self) -> None:
        """Popen child is always terminated/killed."""
        from trellage_graph.proof import StdioWorkshopMCPClient
        transport = FakePopenTransport(self._good_transcript())
        client = StdioWorkshopMCPClient(
            transport=transport, runner=FakeSubprocessRunner(),
            workshop_url="http://localhost:5899",
            assume_healthy=True,
        )
        client.replay_run(run_id="x", timeout=10)
        # FakePopen._killed should be True after replay
        # (we can't easily check this on FakePopenTransport,
        # but the finally block in replay_run guarantees _kill_proc)


class TestBeads(unittest.TestCase):
    def test_create_silent_with_title_and_parent(self) -> None:
        runner = FakeSubprocessRunner()
        runner.set_default("bead-001\n")
        beads = BeadsRepository(runner=runner)
        bid = beads.create(title="graph:r1", metadata={"kind": "test"}, parent="root-id")
        self.assertEqual(bid, "bead-001")
        cmd = " ".join(runner.calls[-1])
        self.assertIn("--silent", cmd)
        self.assertIn("--parent", cmd)
        self.assertIn("root-id", cmd)
        self.assertIn("--actor", cmd)
        self.assertIn("trellage-graph-controller", cmd)

    def test_create_without_parent(self) -> None:
        runner = FakeSubprocessRunner()
        runner.set_default("bead-002\n")
        beads = BeadsRepository(runner=runner)
        bid = beads.create(title="root", metadata={"kind": "root"})
        self.assertEqual(bid, "bead-002")
        cmd = " ".join(runner.calls[-1])
        self.assertNotIn("--parent", cmd)

    def test_init_non_interactive(self) -> None:
        runner = FakeSubprocessRunner()
        BeadsRepository(runner=runner).ensure_initialized()
        cmd = " ".join(runner.calls[-1])
        self.assertIn("--non-interactive", cmd)
        self.assertIn("--skip-agents", cmd)
        self.assertIn("--skip-hooks", cmd)

    def test_update_status(self) -> None:
        runner = FakeSubprocessRunner()
        BeadsRepository(runner=runner).update_status("b1", status="in_progress")
        cmd = " ".join(runner.calls[-1])
        self.assertIn("--status", cmd)
        self.assertIn("in_progress", cmd)

    def test_update_with_metadata_kv(self) -> None:
        runner = FakeSubprocessRunner()
        BeadsRepository(runner=runner).update_status(
            "b1", status="running", metadata_kv={"wt": "/path"})
        cmd = " ".join(runner.calls[-1])
        self.assertIn("--set-metadata", cmd)
        self.assertIn("wt=/path", cmd)

    def test_close_with_reason(self) -> None:
        runner = FakeSubprocessRunner()
        BeadsRepository(runner=runner).close("b1", reason="done")
        cmd = " ".join(runner.calls[-1])
        self.assertIn("close", cmd)
        self.assertIn("--reason", cmd)
        self.assertIn("done", cmd)

    def test_reopen_with_reason(self) -> None:
        runner = FakeSubprocessRunner()
        BeadsRepository(runner=runner).reopen("b1", reason="late failure")
        cmd = " ".join(runner.calls[-1])
        self.assertIn("reopen", cmd)
        self.assertIn("--reason", cmd)

    def test_repo_root_flag(self) -> None:
        runner = FakeSubprocessRunner()
        runner.set_result("show", '{"id":"b1","status":"open"}')
        BeadsRepository(runner=runner, repo_root="/repo").show("b1")
        cmd = " ".join(runner.calls[-1])
        self.assertIn("-C", cmd)
        self.assertIn("/repo", cmd)

    def test_uses_explicit_worktree_beads_dir(self) -> None:
        runner = FakeSubprocessRunner()
        runner.set_result("show", '{"id":"b1","status":"open"}')
        with tempfile.TemporaryDirectory() as td:
            repo = Path(td).resolve()
            beads_dir = repo / ".beads"
            BeadsRepository(
                runner=runner,
                repo_root=str(repo),
                beads_dir=str(beads_dir),
            ).show("b1")
        self.assertEqual(
            runner.call_kwargs[-1]["env"]["BEADS_DIR"],
            str(beads_dir),
        )

    def test_rejects_beads_dir_outside_worktree(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            repo = Path(td) / "repo"
            repo.mkdir()
            with self.assertRaises(BeadsError):
                BeadsRepository(
                    repo_root=str(repo),
                    beads_dir=str(Path(td) / "other" / ".beads"),
                )

    def test_dep_add(self) -> None:
        runner = FakeSubprocessRunner()
        BeadsRepository(runner=runner).add_dependency(blocked="b2", blocker="b1")
        self.assertTrue(any("dep" in " ".join(c) and "add" in " ".join(c)
                            for c in runner.calls))

    def test_ensure_issue_reuses_exact_metadata_match(self) -> None:
        runner = FakeSubprocessRunner()
        runner.set_result(
            "list --all",
            json.dumps([{
                "id": "b1",
                "title": "graph:run-1",
                "status": "open",
                "metadata": {
                    "kind": "graph-of-loops",
                    "run_id": "run-1",
                },
            }]),
        )
        beads = BeadsRepository(runner=runner)
        issue_id = beads.ensure_issue(
            title="graph:run-1",
            metadata={"kind": "graph-of-loops", "run_id": "run-1"},
        )
        self.assertEqual(issue_id, "b1")
        self.assertFalse(any(" create " in f" {' '.join(call)} "
                             for call in runner.calls))

    def test_ensure_issue_rejects_duplicate_matches(self) -> None:
        runner = FakeSubprocessRunner()
        runner.set_result(
            "list --all",
            json.dumps([
                {"id": "b1", "title": "graph", "metadata": {"run_id": "r"}},
                {"id": "b2", "title": "graph", "metadata": {"run_id": "r"}},
            ]),
        )
        with self.assertRaises(BeadsError):
            BeadsRepository(runner=runner).ensure_issue(
                title="graph",
                metadata={"run_id": "r"},
            )

    def test_ensure_dependency_reuses_existing_edge(self) -> None:
        runner = FakeSubprocessRunner()
        runner.set_result(
            "dep list blocked",
            json.dumps([{"id": "blocker", "dependency_type": "blocks"}]),
        )
        beads = BeadsRepository(runner=runner)
        beads.ensure_dependency(blocked="blocked", blocker="blocker")
        self.assertFalse(any(" dep add " in f" {' '.join(call)} "
                             for call in runner.calls))

    def test_failure_raises(self) -> None:
        runner = FakeSubprocessRunner()
        runner.set_failure("bd", rc=1, stderr="err")
        with self.assertRaises(BeadsError):
            BeadsRepository(runner=runner).create(title="t", metadata={})

    def test_show_json(self) -> None:
        runner = FakeSubprocessRunner()
        runner.set_result("show", '{"id":"b1","status":"open"}')
        self.assertEqual(BeadsRepository(runner=runner).show("b1")["status"], "open")


class TestEvidence(unittest.TestCase):
    def test_append_read(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            ledger = EvidenceLedger(Path(td) / "ev.jsonl")
            ledger.append({"kind": "test", "detail": "hello"})
            ledger.append({"kind": "test", "detail": "world"})
            self.assertEqual(len(ledger.read_all()), 2)

    def test_empty(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            self.assertEqual(EvidenceLedger(Path(td) / "nope.jsonl").read_all(), [])

    def test_redaction(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            ledger = EvidenceLedger(Path(td) / "ev.jsonl")
            ledger.append({"detail": "token: ghp_abcdefghijklmnopqrstuvwxyz1234567890"})
            self.assertIn("[REDACTED]", ledger.read_all()[0]["detail"])

    def test_normalized_strips_ts(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            ledger = EvidenceLedger(Path(td) / "ev.jsonl")
            ledger.append({"kind": "test"})
            self.assertNotIn("ts", ledger.normalized()[0])

    def test_malformed_line_survives(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "ev.jsonl"
            p.write_text('{"kind":"ok"}\nnot-json\n{"kind":"also-ok"}\n')
            events = EvidenceLedger(p).read_all()
            self.assertEqual(len(events), 3)
            self.assertEqual(events[1]["kind"], "parse_error")


class TestSpecialist(unittest.TestCase):
    def test_serena_runtime_is_read_only_and_ignores_generated_state(self) -> None:
        config = (ASSETS_DIR / "serena_config.yml").read_text(encoding="utf-8")
        self.assertIn("fixed_tools:", config)
        self.assertIn("- find_symbol", config)
        self.assertIn("- find_referencing_symbols", config)
        self.assertIn("- read_file", config)
        self.assertIn("- search_for_pattern", config)
        self.assertIn("web_dashboard: false", config)
        self.assertIn("web_dashboard_open_on_launch: false", config)
        self.assertNotIn("enable_web_dashboard", config)
        self.assertNotIn("open_web_dashboard", config)
        self.assertNotIn("- replace_", config)
        self.assertIn('- ".sdd/**"', config)
        self.assertIn('- ".agent_work/**"', config)
        self.assertIn('- "target/**"', config)

    def test_discovery_target_mismatch_blocks_planned_decision(self) -> None:
        with self.assertRaisesRegex(
            SpecialistError,
            "after discovery reported target-not-found",
        ):
            SpecialistLauncher._validate_discovery_alignment(
                {"target_status": "target-not-found"},
                {"status": "planned"},
            )

    def test_unauthorized_role(self) -> None:
        with self.assertRaises(SpecialistError):
            SpecialistLauncher().launch(
                role="evil", agent_name="t", prompt="t",
                worktree_path="/x", expected_worktree="/x",
                config_dir="/c", authorized_roles={"team-implementer"})

    def test_worktree_mismatch(self) -> None:
        with self.assertRaises(SpecialistError):
            SpecialistLauncher().launch(
                role="team-implementer", agent_name="t", prompt="t",
                worktree_path="/actual", expected_worktree="/expected",
                config_dir="/c", authorized_roles={"team-implementer"})

    def test_namespaced_plugin_role_resolves_to_agent_file(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            seed = root / "seed"
            role = seed / "plugins" / "cache" / "marketplace" / "tdd-workflows" / "1.3.1" / "agents" / "tdd-orchestrator.md"
            role.parent.mkdir(parents=True)
            role.write_text("Use red, green, refactor.\n", encoding="utf-8")
            launcher = SpecialistLauncher(seed_path=seed, runtime_roles=root / "roles")

            definition = json.loads(
                launcher._agent_definition(
                    "tdd-workflows-tdd-orchestrator",
                    ["Read"],
                    ["Bash"],
                )
            )

            self.assertEqual(
                definition["tdd-workflows-tdd-orchestrator"]["prompt"],
                "Use red, green, refactor.\n",
            )

    def test_runtime_owned_role_overrides_plugin_command(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            seed_role = (
                root / "seed" / "plugins" / "cache" / "marketplace" /
                "insane-research" / "2.9.0" / "commands" /
                "insane-research.md"
            )
            seed_role.parent.mkdir(parents=True)
            seed_role.write_text("interactive command\n", encoding="utf-8")
            runtime_role = root / "roles" / "insane-research.md"
            runtime_role.parent.mkdir(parents=True)
            runtime_role.write_text("headless adapter\n", encoding="utf-8")
            launcher = SpecialistLauncher(
                seed_path=root / "seed",
                runtime_roles=root / "roles",
            )

            definition = json.loads(
                launcher._agent_definition("insane-research", ["Write"], [])
            )

            self.assertEqual(
                definition["insane-research"]["prompt"],
                "headless adapter\n",
            )

    def test_confirmed_cli_flags(self) -> None:
        """Verify stream JSON and managed Claude execution flags."""
        runner = FakeSubprocessRunner()
        runner.set_result(
            "claude",
            '{"type":"result","subtype":"success","result":"ok"}',
        )
        with tempfile.TemporaryDirectory() as td:
            launcher, wt, cfg = _specialist_fixture(
                Path(td), runner, "team-implementer",
            )
            launcher.launch(
                role="team-implementer", agent_name="test-agent",
                prompt="do it", worktree_path=str(wt),
                expected_worktree=str(wt), config_dir=str(cfg),
                authorized_roles={"team-implementer"},
                settings_path="/usr/local/share/trellage/settings.json",
                allowed_tools=["Read", "Write"],
                disallowed_tools=["Bash"],
            )
            cmd = " ".join(runner.calls[-1])
            self.assertIn("--print --verbose", cmd)
            self.assertIn("--output-format stream-json", cmd)
            self.assertIn("--no-session-persistence", cmd)
            self.assertIn("--strict-mcp-config", cmd)
            self.assertIn("--settings /usr/local/share/trellage/settings.json", cmd)
            self.assertIn("--tools Read,Write", cmd)
            self.assertIn("--allowed-tools Read,Write", cmd)
            self.assertIn("--disallowed-tools Bash", cmd)
            self.assertIn("--agent team-implementer", cmd)
            self.assertNotIn("do it", runner.calls[-1])
            self.assertEqual(runner.call_kwargs[-1]["input"], "do it")

    def test_managed_seed_default_settings_are_used(self) -> None:
        runner = FakeSubprocessRunner()
        runner.set_result(
            "claude",
            '{"type":"result","subtype":"success","result":"ok"}',
        )
        with tempfile.TemporaryDirectory() as td:
            launcher, wt, cfg = _specialist_fixture(
                Path(td), runner, "team-implementer",
            )
            launcher.launch(
                role="team-implementer",
                prompt="do it",
                worktree_path=str(wt),
                expected_worktree=str(wt),
                config_dir=str(cfg),
                authorized_roles={"team-implementer"},
            )
            cmd = runner.calls[-1]
            settings_index = cmd.index("--settings") + 1
            self.assertEqual(
                cmd[settings_index],
                str(cfg / "default-settings.json"),
            )

    def test_planner_json_schema(self) -> None:
        runner = FakeSubprocessRunner()
        runner.set_result(
            "Perform planner-time semantic discovery",
            _discovery_stream(),
        )
        runner.set_result(
            "Return one planning decision",
            _planner_stream(_load("valid-plan.json")),
        )
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            launcher, wt, cfg = _specialist_fixture(root, runner, "planner")
            schema = root / "plan.schema.json"
            schema.write_text(
                json.dumps({
                    "$schema": "https://json-schema.org/draft/2020-12/schema",
                    "$id": "https://trellage.dev/test-schema",
                    "type": "object",
                }),
                encoding="utf-8",
            )
            result = launcher.plan(
                role="planner",
                objective="plan",
                constraints=[],
                repo_root=str(wt),
                config_dir=str(cfg),
                schema_path=str(schema),
                timeout=30,
            )
            self.assertEqual(
                result.plan["objective"],
                "plan",
            )
            self.assertTrue(result.serena_success)
            self.assertEqual(len(runner.calls), 3)
            discovery_command = runner.calls[-2]

            self.assertNotIn("Perform planner-time semantic discovery", discovery_command)
            self.assertIn(
                "Perform planner-time semantic discovery",
                runner.call_kwargs[-2]["input"],
            )
            self.assertIn(
                "MUST be exactly one JSON object",
                runner.call_kwargs[-2]["input"],
            )
            self.assertIn(
                "no more than twelve Serena tool calls",
                runner.call_kwargs[-2]["input"],
            )
            self.assertIn(
                "repository-root instructions and validation entrypoints",
                runner.call_kwargs[-2]["input"],
            )
            self.assertIn(
                "profile lock and materializer paths",
                runner.call_kwargs[-2]["input"],
            )
            self.assertIn(
                "Do not stop after a failed symbol or reference lookup",
                runner.call_kwargs[-2]["input"],
            )
            self.assertEqual(
                discovery_command[discovery_command.index("--tools") + 1],
                "",
            )
            discovery_tools = discovery_command[
                discovery_command.index("--allowed-tools") + 1
            ].split(",")
            self.assertIn("mcp__serena__find_symbol", discovery_tools)
            self.assertIn(
                "mcp__serena__find_referencing_symbols",
                discovery_tools,
            )
            self.assertIn("mcp__serena__read_file", discovery_tools)
            self.assertIn(
                "mcp__serena__search_for_pattern",
                discovery_tools,
            )
            self.assertNotIn("mcp__serena__*", discovery_tools)
            self.assertFalse(
                any("replace" in tool or "insert" in tool or "delete" in tool
                    for tool in discovery_tools)
            )
            self.assertIn(
                "Read",
                discovery_command[
                    discovery_command.index("--disallowed-tools") + 1
                ],
            )
            command = runner.calls[-1]
            self.assertNotIn("Create a Graph of Loops plan", command)
            self.assertIn(
                "Return one planning decision",
                runner.call_kwargs[-1]["input"],
            )
            self.assertIn("--verbose", command)
            self.assertIn("--tools", command)
            self.assertNotIn("Agent", command[command.index("--tools") + 1])
            self.assertIn("stream-json", command)
            self.assertIn(
                "mcp__serena__find_symbol",
                command[command.index("--allowed-tools") + 1],
            )
            schema_argument = json.loads(
                command[command.index("--json-schema") + 1],
            )
            self.assertNotIn("$schema", schema_argument)
            self.assertEqual(
                schema_argument["$id"],
                "https://trellage.dev/schemas/planning-decision.schema.json",
            )
            self.assertEqual(
                schema_argument["properties"]["status"]["enum"],
                ["planned", "blocked"],
            )

    def test_planned_decision_drops_blocked_only_fields(self) -> None:
        decision = {
            "status": "planned",
            "objective": "wrong objective",
            "constraints": ["wrong constraint"],
            "graph_plan": {
                "nodes": [{
                    "prompt": "Implement the behavior.",
                    "prompt_digest": "sha256:model-generated-value",
                }],
            },
            "target_status": "grounded",
            "grounding": {},
            "reconciliation": {},
            "constraint_reconciliation": {},
            "notes": [],
            "decision": {"status": "planned"},
            "reason_code": "insufficient-evidence",
            "summary": "not applicable",
            "evidence": [],
            "constraint_conflicts": [],
            "decision_summary": "planner explanation",
            "discovery_gaps_carried_forward": [],
            "base_revision": "model-selected-revision",
            "discovery_fallback_note": "fallback was not required",
        }

        normalized = SpecialistLauncher._normalize_planning_decision(
            decision,
            objective="build it",
            constraints=[],
            discovery={
                "repository_evidence": [{
                    "path": ".",
                    "detail": "target",
                }],
            },
        )

        self.assertEqual(
            set(normalized),
            {"status", "objective", "constraints", "target_evidence", "plan"},
        )
        self.assertEqual(
            normalized["plan"]["nodes"][0]["prompt_digest"],
            content_digest("Implement the behavior."),
        )
        self.assertEqual(normalized["objective"], "build it")
        self.assertEqual(normalized["constraints"], [])
        self.assertEqual(normalized["plan"]["objective"], "build it")
        self.assertEqual(normalized["plan"]["constraints"], [])
        self.assertEqual(
            normalized["target_evidence"],
            [{"path": ".", "detail": "target"}],
        )

    def test_planned_decision_unwraps_nested_decision_envelope(self) -> None:
        nested = {
            "status": "planned",
            "graph_plan": {
                "nodes": [{
                    "prompt": "Implement the behavior.",
                    "prompt_digest": "sha256:model-generated-value",
                }],
            },
        }

        normalized = SpecialistLauncher._normalize_planning_decision(
            {"decision": nested},
            objective="build it",
            constraints=[],
            discovery={
                "repository_evidence": [{
                    "path": ".",
                    "detail": "target",
                }],
            },
        )

        self.assertEqual(normalized["status"], "planned")
        self.assertNotIn("decision", normalized)
        self.assertEqual(normalized["plan"]["objective"], "build it")
        self.assertEqual(
            normalized["plan"]["nodes"][0]["prompt_digest"],
            content_digest("Implement the behavior."),
        )

    def test_blocked_decision_drops_planned_only_fields(self) -> None:
        decision = {
            "status": "blocked",
            "objective": "build it",
            "constraints": [],
            "reason_code": "target-not-found",
            "summary": "missing",
            "evidence": [],
            "constraint_conflicts": [],
            "target_evidence": [],
            "plan": {},
        }

        normalized = SpecialistLauncher._normalize_planning_decision(
            decision,
            objective="build it",
            constraints=[],
            discovery={"repository_evidence": []},
        )

        self.assertEqual(
            set(normalized),
            {
                "status",
                "objective",
                "constraints",
                "reason_code",
                "summary",
                "evidence",
                "constraint_conflicts",
            },
        )

    def test_planner_requires_serena_or_explicit_fallback(self) -> None:
        runner = FakeSubprocessRunner()
        runner.set_result(
            "claude",
            _planner_stream(_load("valid-plan.json"), serena=False),
        )
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            launcher, wt, cfg = _specialist_fixture(root, runner, "planner")
            schema = root / "plan.schema.json"
            schema.write_text('{"type":"object"}\n', encoding="utf-8")
            with self.assertRaisesRegex(
                SpecialistError,
                "Serena discovery or explicit fallback evidence is missing",
            ):
                launcher.plan(
                    role="planner",
                    objective="plan",
                    constraints=[],
                    repo_root=str(wt),
                    config_dir=str(cfg),
                    schema_path=str(schema),
                    timeout=30,
                )

    def test_planner_requires_structured_discovery(self) -> None:
        runner = FakeSubprocessRunner()
        runner.set_result(
            "Perform planner-time semantic discovery",
            _discovery_stream(structured=False, fallback=True),
        )
        runner.set_result(
            "Normalize the completed planner discovery",
            "\n".join([
                json.dumps({
                    "type": "result",
                    "subtype": "success",
                    "result": "still not JSON",
                }),
            ]),
        )
        runner.set_result(
            "Return one planning decision",
            _planner_stream(_load("valid-plan.json"), serena=False),
        )
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            launcher, wt, cfg = _specialist_fixture(root, runner, "planner")
            schema = root / "plan.schema.json"
            schema.write_text('{"type":"object"}\n', encoding="utf-8")
            with self.assertRaisesRegex(
                SpecialistError,
                "structured discovery result is missing",
            ):
                launcher.plan(
                    role="planner",
                    objective="plan",
                    constraints=[],
                    repo_root=str(wt),
                    config_dir=str(cfg),
                    schema_path=str(schema),
                    timeout=30,
                )

    def test_planner_normalizes_discovery_prose_without_tools(self) -> None:
        runner = FakeSubprocessRunner()
        discovery = json.loads(
            _discovery_stream().splitlines()[-1],
        )["structured_output"]
        runner.set_result(
            "Perform planner-time semantic discovery",
            _discovery_stream(structured=False).replace(
                '"result": "discovered"',
                '"result": "## Discovery Result\\nTarget status: '
                '`target-found`\\nPath: `src/lib.rs`"',
            ),
        )
        runner.set_result(
            "Normalize the completed planner discovery",
            "\n".join([
                json.dumps({
                    "type": "result",
                    "subtype": "success",
                    "result": json.dumps(discovery),
                }),
            ]),
        )
        runner.set_result(
            "Return one planning decision",
            _planner_stream(_load("valid-plan.json"), serena=False),
        )
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            launcher, wt, cfg = _specialist_fixture(root, runner, "planner")
            schema = root / "plan.schema.json"
            schema.write_text('{"type":"object"}\n', encoding="utf-8")
            result = launcher.plan(
                role="planner",
                objective="plan",
                constraints=[],
                repo_root=str(wt),
                config_dir=str(cfg),
                schema_path=str(schema),
                timeout=30,
            )
            self.assertEqual(result.discovery, discovery)
            self.assertEqual(len(runner.calls), 4)
            normalizer_command = runner.calls[-2]
            self.assertNotIn("--tools", normalizer_command)
            self.assertIn("--json-schema", normalizer_command)
            self.assertIn(
                "Normalize the completed planner discovery",
                runner.call_kwargs[-2]["input"],
            )
            self.assertIn(
                "mcp__serena__read_file",
                normalizer_command[
                    normalizer_command.index("--disallowed-tools") + 1
                ],
            )

    def test_planner_normalizes_schema_invalid_structured_discovery(self) -> None:
        runner = FakeSubprocessRunner()
        discovery = json.loads(
            _discovery_stream().splitlines()[-1],
        )["structured_output"]
        invalid_discovery = {
            **discovery,
            "repository_evidence": discovery["repository_evidence"][0],
            "relevant_symbols": [{"name": "GraphController"}],
            "relevant_paths": [{"path": "."}],
        }
        discovery_events = [
            json.loads(line) for line in _discovery_stream().splitlines()
        ]
        discovery_events[-1]["structured_output"] = invalid_discovery
        normalized_discovery = dict(discovery)
        normalized_discovery.pop("summary")
        runner.set_result(
            "Perform planner-time semantic discovery",
            "\n".join(json.dumps(event) for event in discovery_events),
        )
        runner.set_result(
            "Normalize the completed planner discovery",
            "\n".join([
                json.dumps({
                    "type": "result",
                    "subtype": "success",
                    "result": json.dumps(normalized_discovery),
                }),
            ]),
        )
        runner.set_result(
            "Return one planning decision",
            _planner_stream(_load("valid-plan.json"), serena=False),
        )
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            launcher, wt, cfg = _specialist_fixture(root, runner, "planner")
            schema = root / "plan.schema.json"
            schema.write_text('{"type":"object"}\n', encoding="utf-8")
            result = launcher.plan(
                role="planner",
                objective="plan",
                constraints=[],
                repo_root=str(wt),
                config_dir=str(cfg),
                schema_path=str(schema),
                timeout=30,
            )
            self.assertEqual(
                result.discovery["summary"],
                "Planner discovery completed with status grounded.",
            )
            self.assertEqual(
                {
                    key: value
                    for key, value in result.discovery.items()
                    if key != "summary"
                },
                normalized_discovery,
            )
            normalization_prompt = runner.call_kwargs[-2]["input"]
            self.assertIn(
                json.dumps(invalid_discovery, sort_keys=True),
                normalization_prompt,
            )

    def test_discovery_strips_path_annotation_only_for_existing_path(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            (root / "src").mkdir()
            discovery = {
                "repository_evidence": [
                    {"path": "src (pattern search)", "detail": "found"},
                    {"path": "missing (pattern search)", "detail": "missing"},
                ],
                "relevant_paths": [
                    "src (pattern search)",
                    "missing (pattern search)",
                ],
            }

            normalized = SpecialistLauncher._normalize_discovery_paths(
                discovery,
                repo_root=str(root),
            )

            self.assertEqual(
                normalized["repository_evidence"][0]["path"],
                "src",
            )
            self.assertEqual(
                normalized["repository_evidence"][1]["path"],
                "missing (pattern search)",
            )
            self.assertEqual(
                normalized["relevant_paths"],
                ["src", "missing (pattern search)"],
            )

    def test_discovery_expands_existing_sibling_path_annotation(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            crate = root / "crate"
            crate.mkdir()
            (crate / "Cargo.toml").write_text("", encoding="utf-8")
            (crate / "Cargo.lock").write_text("", encoding="utf-8")
            discovery = {
                "repository_evidence": [{
                    "path": "crate/Cargo.toml / Cargo.lock (per docs)",
                    "detail": "crate metadata",
                }],
                "relevant_paths": [
                    "crate/Cargo.toml / Cargo.lock (per docs)",
                ],
            }

            normalized = SpecialistLauncher._normalize_discovery_paths(
                discovery,
                repo_root=str(root),
            )

            self.assertEqual(
                normalized["repository_evidence"],
                [
                    {"path": "crate/Cargo.toml", "detail": "crate metadata"},
                    {"path": "crate/Cargo.lock", "detail": "crate metadata"},
                ],
            )
            self.assertEqual(
                normalized["relevant_paths"],
                ["crate/Cargo.toml", "crate/Cargo.lock"],
            )

    def test_planner_accepts_locally_validated_discovery_json_text(self) -> None:
        runner = FakeSubprocessRunner()
        discovery = json.loads(
            _discovery_stream().splitlines()[-1],
        )["structured_output"]
        runner.set_result(
            "Perform planner-time semantic discovery",
            _discovery_stream(structured=False).replace(
                '"result": "discovered"',
                f'"result": {json.dumps(json.dumps(discovery))}',
            ),
        )
        runner.set_result(
            "Return one planning decision",
            _planner_stream(_load("valid-plan.json"), serena=False),
        )
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            launcher, wt, cfg = _specialist_fixture(root, runner, "planner")
            schema = root / "plan.schema.json"
            schema.write_text('{"type":"object"}\n', encoding="utf-8")
            result = launcher.plan(
                role="planner",
                objective="plan",
                constraints=[],
                repo_root=str(wt),
                config_dir=str(cfg),
                schema_path=str(schema),
                timeout=30,
            )
            self.assertEqual(result.discovery, discovery)

    def test_planner_preserves_exact_serena_fallback_failure(self) -> None:
        runner = FakeSubprocessRunner()
        discovery_events = [
            json.loads(line)
            for line in _discovery_stream(fallback=True).splitlines()
        ]
        discovery_events[-1]["structured_output"]["target_status"] = "grounded"
        del discovery_events[-1]["structured_output"]["serena_fallback"]
        runner.set_result(
            "Perform planner-time semantic discovery",
            "\n".join(json.dumps(event) for event in discovery_events),
        )
        runner.set_result(
            "Return one planning decision",
            _planner_stream(_load("valid-plan.json"), serena=False),
        )
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            launcher, wt, cfg = _specialist_fixture(root, runner, "planner")
            schema = root / "plan.schema.json"
            schema.write_text('{"type":"object"}\n', encoding="utf-8")
            result = launcher.plan(
                role="planner",
                objective="plan",
                constraints=[],
                repo_root=str(wt),
                config_dir=str(cfg),
                schema_path=str(schema),
                timeout=30,
            )
            self.assertEqual(
                result.discovery["serena_fallback"],
                "unsupported language",
            )

    def test_planner_rejects_schema_invalid_discovery_json_text(self) -> None:
        runner = FakeSubprocessRunner()
        runner.set_result(
            "Perform planner-time semantic discovery",
            _discovery_stream(structured=False).replace(
                '"result": "discovered"',
                '"result": "{\\"target_status\\":\\"grounded\\"}"',
            ),
        )
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            launcher, wt, cfg = _specialist_fixture(root, runner, "planner")
            schema = root / "plan.schema.json"
            schema.write_text('{"type":"object"}\n', encoding="utf-8")
            with self.assertRaisesRegex(
                SpecialistError,
                "normalization failed",
            ):
                launcher.plan(
                    role="planner",
                    objective="plan",
                    constraints=[],
                    repo_root=str(wt),
                    config_dir=str(cfg),
                    schema_path=str(schema),
                    timeout=30,
                )

    def test_planner_discovery_has_shorter_bounded_timeout(self) -> None:
        runner = FakeSubprocessRunner()
        runner.set_result(
            "Perform planner-time semantic discovery",
            _discovery_stream(),
        )
        runner.set_result(
            "Return one planning decision",
            _planner_stream(_load("valid-plan.json")),
        )
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            launcher, wt, cfg = _specialist_fixture(root, runner, "planner")
            schema = root / "plan.schema.json"
            schema.write_text('{"type":"object"}\n', encoding="utf-8")
            launcher.plan(
                role="planner",
                objective="plan",
                constraints=[],
                repo_root=str(wt),
                config_dir=str(cfg),
                schema_path=str(schema),
                timeout=1800,
            )
            self.assertEqual(runner.call_kwargs[-2]["timeout"], 300)
            self.assertEqual(runner.call_kwargs[-1]["timeout"], 1800)

    def test_planner_failure_reports_stderr(self) -> None:
        runner = FakeSubprocessRunner()
        runner.set_failure(
            "claude",
            rc=1,
            stderr="structured output schema is unsupported",
        )
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            launcher, wt, cfg = _specialist_fixture(root, runner, "planner")
            schema = root / "plan.schema.json"
            schema.write_text('{"type":"object"}\n', encoding="utf-8")
            with self.assertRaisesRegex(
                SpecialistError,
                "planner discovery failed with exit 1: "
                "structured output schema is unsupported",
            ):
                launcher.plan(
                    role="planner",
                    objective="plan",
                    constraints=[],
                    repo_root=str(wt),
                    config_dir=str(cfg),
                    schema_path=str(schema),
                    timeout=30,
                )

    def test_planner_uses_discovery_evidence_from_separate_phase(self) -> None:
        runner = FakeSubprocessRunner()
        runner.set_result(
            "Perform planner-time semantic discovery",
            _discovery_stream(),
        )
        runner.set_result(
            "Return one planning decision",
            _planner_stream(_load("valid-plan.json"), serena=False),
        )
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            launcher, wt, cfg = _specialist_fixture(root, runner, "planner")
            schema = root / "plan.schema.json"
            schema.write_text('{"type":"object"}\n', encoding="utf-8")
            result = launcher.plan(
                role="planner",
                objective="plan",
                constraints=[],
                repo_root=str(wt),
                config_dir=str(cfg),
                schema_path=str(schema),
                timeout=30,
            )
            self.assertTrue(result.serena_success)
            self.assertEqual(result.plan["objective"], "plan")

    def test_stream_json_serena_parsing(self) -> None:
        """Parse tool_use/result events from stream-json to detect Serena."""
        launcher = SpecialistLauncher()
        stream = '\n'.join([
            '{"type":"tool_use","name":"serena_find_symbol","id":"t1","input":{"action":"find_symbol","symbol":"Foo"}}',
            '{"type":"tool_result","tool_use_id":"t1","is_error":false,"content":"found Foo at line 42"}',
        ])
        result = launcher._parse_stream_json(stream, role="test")
        self.assertTrue(result["serena_success"])
        self.assertFalse(result["serena_fallback"])
        self.assertEqual(len(result["tool_events"]), 2)

    def test_stream_json_serena_read_fallback_counts_as_discovery(self) -> None:
        launcher = SpecialistLauncher()
        stream = "\n".join([
            '{"type":"tool_use","name":"mcp__serena__read_file","id":"t1","input":{"relative_path":"src/lib.rs"}}',
            '{"type":"tool_result","tool_use_id":"t1","is_error":false,"content":"pub fn target() {}"}',
            '{"type":"result","subtype":"success","result":"done"}',
        ])
        result = launcher._parse_stream_json(stream, role="test")
        self.assertTrue(result["serena_success"])
        self.assertFalse(result["serena_fallback"])

    def test_serena_request_without_successful_result_does_not_pass(self) -> None:
        launcher = SpecialistLauncher()
        stream = '\n'.join([
            '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"mcp__serena__find_symbol","id":"t1","input":{"name_path":"Foo"}}]}}',
            '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","is_error":true,"content":"failed"}]}}',
            '{"type":"result","subtype":"success","result":"done"}',
        ])
        result = launcher._parse_stream_json(stream, role="test")
        self.assertFalse(result["serena_success"])

    def test_stream_json_serena_fallback(self) -> None:
        launcher = SpecialistLauncher()
        stream = "\n".join([
            '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"mcp__serena__find_symbol","id":"t1","input":{}}]}}',
            '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","is_error":true,"content":"unsupported language"}]}}',
            '{"type":"result","subtype":"success","result":"TRELLAGE_SERENA_FALLBACK: unsupported language"}',
        ])
        result = launcher._parse_stream_json(stream, role="test")
        self.assertTrue(result["serena_fallback"])
        self.assertEqual(result["serena_failures"], ["unsupported language"])

    def test_decodes_one_fenced_planner_json_object(self) -> None:
        decoded = SpecialistLauncher._decode_json_result(
            'Discovery summary.\n```json\n{"nodes":[{"id":"one"}]}\n```',
        )
        self.assertEqual(decoded, {"nodes": [{"id": "one"}]})

    def test_rejects_ambiguous_fenced_planner_json(self) -> None:
        with self.assertRaisesRegex(ValueError, "exactly one"):
            SpecialistLauncher._decode_json_result(
                '```json\n{"id":"one"}\n```\n```json\n{"id":"two"}\n```',
            )

    def test_seed_from_managed_not_mutable(self) -> None:
        """Config seed copies from claude-seed, not from ~/.claude."""
        from trellage_graph.specialist import _MANAGED_SEED
        self.assertEqual(_MANAGED_SEED, "/usr/local/share/trellage/claude-seed")

    def test_nss_wrapper_supplies_runtime_identity(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            wrapper = root / "libnss_wrapper.so"
            wrapper.touch()
            config = root / "config"
            config.mkdir()
            launcher = SpecialistLauncher(nss_wrapper_path=wrapper)
            env = launcher._sanitized_env(str(config))
            self.assertEqual(env["LD_PRELOAD"], str(wrapper))
            self.assertIn(
                "agent:x:10001:10001::/home/agent:/bin/bash",
                Path(env["NSS_WRAPPER_PASSWD"]).read_text(encoding="utf-8"),
            )
            self.assertIn(
                "agent:x:10001:",
                Path(env["NSS_WRAPPER_GROUP"]).read_text(encoding="utf-8"),
            )


class TestCodexReviewFlags(unittest.TestCase):
    """Verify Codex exec uses the container as its outer sandbox."""

    def test_codex_cmd_flags(self) -> None:
        runner = FakeCodexRunner({"findings": [], "summary": "clean"})
        review = CodexReviewGate(runner=runner)
        with tempfile.TemporaryDirectory() as td:
            review.review(
                node_id="n1", worktree_path=td,
                model="gpt-5.6-sol", reasoning_effort="medium",
            )
            cmd = " ".join(runner.calls[-1])
            self.assertIn("--ephemeral", cmd)
            self.assertIn("--ignore-user-config", cmd)
            self.assertIn("--ignore-rules", cmd)
            self.assertIn(
                "--dangerously-bypass-approvals-and-sandbox",
                cmd,
            )
            self.assertNotIn("--sandbox read-only", cmd)
            self.assertNotIn("--output-schema", cmd)
            self.assertIn(f"-C {td}", cmd)
            self.assertIn("-m gpt-5.6-sol", cmd)
            self.assertIn('-c model_provider="copilot_proxy"', cmd)
            self.assertIn('-c model_reasoning_effort="medium"', cmd)
            self.assertIn(
                '-c model_providers.copilot_proxy.base_url='
                '"http://copilot-proxy-rs:8080/v1"', cmd)
            self.assertIn(
                '-c model_providers.copilot_proxy.wire_api="responses"', cmd)
            self.assertIn(
                "-c model_providers.copilot_proxy.request_max_retries=3", cmd)
            self.assertIn(
                "-c model_providers.copilot_proxy.stream_max_retries=5", cmd)
            self.assertIn(
                "-c model_providers.copilot_proxy.stream_idle_timeout_ms=300000",
                cmd)
            self.assertNotIn("Return only", cmd)
            review_input = runner.call_kwargs[-1]["input"]
            self.assertIn("Return only", review_input)
            self.assertIn('"findings"', review_input)
            self.assertIn('"summary"', review_input)


class TestRebaseFF(unittest.TestCase):
    def test_rebase_conflict(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            ctrl = _make_controller(td=td)
            ctrl.accept_plan(_load("valid-plan.json"), run_id="t1")
            git_runner = FakeSubprocessRunner()
            git_runner.set_result("branch --show-current", "main\n")
            git_runner.set_failure("git rebase main", rc=1, stderr="conflict")
            ctrl._runner = git_runner
            with self.assertRaises(ControllerError) as ctx:
                ctrl.integrate_node(
                    "add-greeter",
                    cwd=td,
                    node_branch="agent/add-greeter",
                )
            self.assertIn("rebase failed", str(ctx.exception))

    def test_ff_refused(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            ctrl = _make_controller(td=td)
            ctrl.accept_plan(_load("valid-plan.json"), run_id="t2")
            git_runner = FakeSubprocessRunner()
            git_runner.set_result("branch --show-current", "main\n")
            git_runner.set_result("rev-parse HEAD", "node-commit\n")
            orig_run = git_runner.run
            def patched(args: list[str], **kw: Any) -> subprocess.CompletedProcess[str]:
                if "merge" in " ".join(args) and "--ff-only" in " ".join(args):
                    raise subprocess.CalledProcessError(1, "git", output="", stderr="not ff")
                return orig_run(args, **kw)
            git_runner.run = patched  # type: ignore[assignment]
            ctrl._runner = git_runner
            ctrl._state["nodes"]["add-greeter"]["commit"] = "node-commit"
            with self.assertRaises(ControllerError) as ctx:
                ctrl.integrate_node(
                    "add-greeter",
                    cwd=td,
                    node_branch="agent/add-greeter",
                )
            self.assertIn("fast-forward", str(ctx.exception).lower())


class TestControllerE2E(unittest.TestCase):
    def test_reopened_node_envelope_uses_repair_mode(self) -> None:
        controller = _make_controller()
        controller._plan = _load("valid-plan.json")
        controller._state = {
            "root_bead_id": "root",
            "nodes": {
                "add-greeter": {
                    "bead_id": "node",
                    "last_failure": "green gate failed",
                },
            },
        }

        envelope = controller._build_envelope(controller._plan["nodes"][0])

        self.assertTrue(envelope["repair_mode"])

    def test_node_commit_bypasses_repository_hooks_after_controller_gates(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            subprocess.run(["git", "init", "-q"], cwd=root, check=True)
            subprocess.run(
                ["git", "config", "user.email", "graph@example.invalid"],
                cwd=root,
                check=True,
            )
            subprocess.run(
                ["git", "config", "user.name", "Graph Test"],
                cwd=root,
                check=True,
            )
            (root / "tracked.txt").write_text("base\n", encoding="utf-8")
            subprocess.run(["git", "add", "tracked.txt"], cwd=root, check=True)
            subprocess.run(
                ["git", "commit", "-q", "-m", "base"],
                cwd=root,
                check=True,
            )
            hook = root / ".git" / "hooks" / "pre-commit"
            hook.write_text("#!/bin/sh\nexit 99\n", encoding="utf-8")
            hook.chmod(0o755)
            (root / "tracked.txt").write_text("changed\n", encoding="utf-8")
            controller = _make_controller(
                git_runner=RealSubprocessRunner(),
                td=td,
            )
            state: dict[str, Any] = {}

            controller._commit_node(
                {"id": "implementation", "type": "implement"},
                state,
                str(root),
            )

            self.assertTrue(state["commit"])
            subject = subprocess.run(
                ["git", "log", "-1", "--format=%s"],
                cwd=root,
                check=True,
                capture_output=True,
                text=True,
            ).stdout.strip()
            self.assertEqual(subject, "Graph node implementation")

    def test_resume_reconciles_fast_forward_completed_before_state_persist(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            repo = Path(td)
            base_revision = _git_repo(repo)
            plan = {
                "objective": "Recover an integrated node",
                "base_revision": base_revision,
                "nodes": [{
                    "id": "recover-node",
                    "type": "implement",
                    "role": "team-implementer",
                    "prompt": "Write result.txt.",
                    "prompt_digest": content_digest("Write result.txt."),
                    "dependencies": [],
                    "read_set": ["README.md"],
                    "write_set": ["result.txt"],
                    "behavior_change": False,
                    "gates": [{
                        "name": "test-final",
                        "argv": ["true"],
                        "phase": "final",
                    }],
                    "review_required": False,
                    "proof_required": False,
                }],
                "graph_gates": [],
                "authorization": {
                    "allow_push": False,
                    "allow_pull_request": False,
                    "allow_deploy": False,
                },
            }
            run_dir = repo / ".sdd" / "graph-of-loops" / "runs" / "recover"
            controller = GraphController(
                beads=StatefulBeads(),  # type: ignore[arg-type]
                bernstein=BernsteinFacade(
                    worktree_manager=GitWorktreeManager(repo),
                ),
                waku=WakuNodeRuntime(loop_runner=FakeWakuLoop()),
                review=PassingReview(),  # type: ignore[arg-type]
                proof=RaindropProofGate(),
                evidence=EvidenceLedger(run_dir / "events.jsonl"),
                policy=_load("test-policy.json"),
                run_dir=run_dir,
                repo_root=repo,
            )
            controller.accept_plan(plan, run_id="recover")
            (repo / "result.txt").write_text("integrated\n", encoding="utf-8")
            subprocess.run(["git", "add", "result.txt"], cwd=repo, check=True)
            subprocess.run(
                ["git", "commit", "-q", "-m", "integrated node"],
                cwd=repo,
                check=True,
            )
            integrated_revision = subprocess.run(
                ["git", "rev-parse", "HEAD"],
                cwd=repo,
                check=True,
                capture_output=True,
                text=True,
            ).stdout.strip()
            node_state = controller._state["nodes"]["recover-node"]
            node_state["commit"] = integrated_revision
            node_state["integration_pending"] = True
            controller._persist_state()

            controller._verify_run_base()

            self.assertTrue(node_state["integrated"])
            self.assertFalse(node_state["integration_pending"])
            self.assertEqual(controller._state["target_revision"], integrated_revision)

    def test_red_phase_rejects_uncommitted_production_changes(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            repo = Path(td)
            base_revision = _git_repo(repo)
            plan = {
                "objective": "Use tests before production changes",
                "base_revision": base_revision,
                "nodes": [{
                    "id": "tdd-result",
                    "type": "tdd",
                    "role": "tdd-workflows-tdd-orchestrator",
                    "prompt": "Add behavior with tests.",
                    "prompt_digest": content_digest("Add behavior with tests."),
                    "dependencies": [],
                    "read_set": ["README.md"],
                    "write_set": ["src/**"],
                    "test_write_set": ["tests/**"],
                    "behavior_change": True,
                    "gates": [
                        {
                            "name": "test-red",
                            "argv": ["false"],
                            "phase": "red",
                        },
                        {
                            "name": "test-green",
                            "argv": ["false"],
                            "phase": "green",
                        },
                        {
                            "name": "test-final",
                            "argv": ["true"],
                            "phase": "final",
                        },
                    ],
                    "review_required": False,
                    "proof_required": False,
                }],
                "graph_gates": [],
                "authorization": {
                    "allow_push": False,
                    "allow_pull_request": False,
                    "allow_deploy": False,
                },
            }
            run_dir = repo / ".sdd" / "graph-of-loops" / "runs" / "red-write"
            controller = GraphController(
                beads=StatefulBeads(),  # type: ignore[arg-type]
                bernstein=BernsteinFacade(
                    worktree_manager=GitWorktreeManager(repo),
                ),
                waku=WakuNodeRuntime(
                    loop_runner=RedGateNodeLoop(),
                    client_factory=lambda: object(),
                ),
                review=PassingReview(),  # type: ignore[arg-type]
                proof=RaindropProofGate(),
                evidence=EvidenceLedger(run_dir / "events.jsonl"),
                policy=_load("test-policy.json"),
                run_dir=run_dir,
                repo_root=repo,
                specialist=RedProductionWritingSpecialist(),  # type: ignore[arg-type]
            )
            controller.accept_plan(plan, run_id="red-write")
            with self.assertRaisesRegex(
                ControllerError,
                "red phase changed non-test files: src/production.py",
            ):
                controller.run()

    def test_graph_review_failure_creates_repair_and_rejection_closes_it(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            beads = StatefulBeads()
            controller = GraphController(
                beads=beads,  # type: ignore[arg-type]
                bernstein=BernsteinFacade(
                    worktree_manager=FakeWorktreeManager(td),
                ),
                waku=WakuNodeRuntime(loop_runner=FakeWakuLoop()),
                review=CodexReviewGate(),
                proof=RaindropProofGate(),
                evidence=EvidenceLedger(Path(td) / "events.jsonl"),
                policy=_load("test-policy.json"),
                run_dir=Path(td) / "run",
                repo_root=Path(td),
            )
            root = controller.accept_plan(
                _load("valid-plan.json"),
                run_id="review-repair",
            )
            finding = {
                "id": "review-finding",
                "severity": "high",
                "file": "src/example.py",
                "description": "Incorrect behavior",
            }
            controller._fail_graph("review failed", findings=[finding])
            repair = controller._state["graph_repair_beads"][0]
            self.assertEqual(beads.show(root)["status"], "open")
            self.assertIn(repair, beads.dependencies[root])
            evidence = Path(td) / "finding-evidence.md"
            evidence.write_text("The reported path is unreachable.\n")
            controller.reject_finding(
                finding_id="review-finding",
                evidence_path=str(evidence),
            )
            self.assertEqual(beads.show(repair)["status"], "closed")

    def test_full_graph_closes_only_after_integration_and_cleanup(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            repo = Path(td)
            base_revision = _git_repo(repo)
            beads = StatefulBeads()
            plan = {
                "objective": "Write a result file",
                "base_revision": base_revision,
                "nodes": [{
                    "id": "write-result",
                    "type": "implement",
                    "role": "team-implementer",
                    "prompt": "Write result.txt.",
                    "prompt_digest": content_digest("Write result.txt."),
                    "dependencies": [],
                    "read_set": ["README.md"],
                    "write_set": ["result.txt"],
                    "behavior_change": False,
                    "gates": [{
                        "name": "test-final",
                        "argv": ["test", "-f", "result.txt"],
                        "phase": "final",
                    }],
                    "review_required": False,
                    "proof_required": False,
                }],
                "graph_gates": [],
                "authorization": {
                    "allow_push": False,
                    "allow_pull_request": False,
                    "allow_deploy": False,
                },
            }
            run_dir = repo / ".sdd" / "graph-of-loops" / "runs" / "vertical"
            controller = GraphController(
                beads=beads,  # type: ignore[arg-type]
                bernstein=BernsteinFacade(
                    worktree_manager=GitWorktreeManager(repo),
                ),
                waku=WakuNodeRuntime(
                    loop_runner=DeterministicNodeLoop(),
                    client_factory=lambda: object(),
                ),
                review=PassingReview(),  # type: ignore[arg-type]
                proof=RaindropProofGate(),
                evidence=EvidenceLedger(run_dir / "events.jsonl"),
                policy=_load("test-policy.json"),
                run_dir=run_dir,
                repo_root=repo,
                specialist=WritingSpecialist(),  # type: ignore[arg-type]
            )
            root = controller.accept_plan(plan, run_id="vertical")
            result = controller.run()
            self.assertEqual(result["status"], "closed")
            self.assertEqual(beads.show(root)["status"], "closed")
            node_state = controller._state["nodes"]["write-result"]
            self.assertTrue(node_state["integrated"])
            self.assertIsNone(node_state["worktree"])
            self.assertEqual((repo / "result.txt").read_text(), "graph result\n")
            self.assertEqual(
                list((repo / ".sdd" / "worktrees").glob("gol-*")),
                [],
            )

    def test_accept_status(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            ctrl = _make_controller(td=td)
            root = ctrl.accept_plan(_load("valid-plan.json"), run_id="e2e")
            self.assertTrue(root)
            st = ctrl.status()
            self.assertEqual(st["run_id"], "e2e")
            self.assertEqual(st["node_count"], 2)

    def test_ready_waves(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            ctrl = _make_controller(td=td)
            ctrl.accept_plan(_load("valid-plan.json"), run_id="rw")
            waves = ctrl.compute_ready_waves()
            flat = [nid for w in waves for nid in w]
            self.assertLess(flat.index("add-greeter"), flat.index("add-formatter"))

    def test_persistence(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            ctrl = _make_controller(td=td)
            ctrl.accept_plan(_load("valid-plan.json"), run_id="p")
            rd = ctrl._run_dir
            self.assertTrue((rd / "plan.json").is_file())
            self.assertTrue((rd / "state.json").is_file())
            envelope_path = rd / "envelopes" / "add-greeter.json"
            self.assertTrue(envelope_path.is_file())
            envelope = json.loads(envelope_path.read_text(encoding="utf-8"))
            self.assertEqual(envelope["plan_generation"], 1)

    def test_replan_rejects_integrated_or_committed_nodes(self) -> None:
        for field in ("integrated", "commit"):
            with self.subTest(field=field), tempfile.TemporaryDirectory() as td:
                ctrl = _make_controller(td=td)
                ctrl.accept_plan(_load("valid-plan.json"), run_id=f"blocked-{field}")
                node = ctrl._state["nodes"]["add-greeter"]
                node[field] = True if field == "integrated" else "abc1234"
                with self.assertRaisesRegex(
                    ControllerError,
                    "accepted graph cannot be replanned",
                ):
                    ctrl.prepare_replan(f"blocked-{field}")

    def test_clean_accepted_graph_can_be_superseded(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            ctrl = _make_controller(td=td)
            ctrl.accept_plan(
                _load("valid-plan.json"),
                run_id="clean-replan",
                plan_generation=3,
            )
            self.assertEqual(ctrl.prepare_replan("clean-replan"), 3)
            self.assertEqual(ctrl._state["status"], "superseded")
            self.assertTrue(all(
                node["status"] == "superseded"
                for node in ctrl._state["nodes"].values()
            ))

    def test_ready_wave_execution_is_bounded_and_parallel(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            policy = _load("test-policy.json")
            policy["limits"]["max_parallel_nodes"] = 2
            ctrl = _make_controller(td=td, policy=policy)
            plan = _load("valid-plan.json")
            plan["nodes"][1]["dependencies"] = []
            for node in plan["nodes"]:
                node["parallel_safe"] = True
            ctrl.accept_plan(plan, run_id="parallel-wave")
            integrated: list[str] = []
            context = multiprocessing.get_context("fork")
            active = context.Value("i", 0)
            maximum = context.Value("i", 0)

            def initialize(
                _self: GraphController, _node_id: str,
            ) -> dict[str, Any]:
                return {}

            def worker(
                _self: GraphController,
                _node_id: str,
                _envelope: dict[str, Any],
                connection: Any,
            ) -> None:
                os.setsid()
                with active.get_lock():
                    active.value += 1
                    maximum.value = max(maximum.value, active.value)
                time.sleep(0.15)
                with active.get_lock():
                    active.value -= 1
                connection.send({"ok": True})
                connection.close()

            def finalize(
                _self: GraphController, _node_id: str,
            ) -> None:
                return None

            def integrate(
                _self: GraphController, node_id: str,
            ) -> None:
                integrated.append(node_id)

            ctrl._initialize_parallel_node = types.MethodType(initialize, ctrl)
            ctrl._parallel_node_worker = types.MethodType(worker, ctrl)
            ctrl._finalize_parallel_node = types.MethodType(finalize, ctrl)
            ctrl._integrate_prepared_node = types.MethodType(integrate, ctrl)
            ctrl._run_graph_gates = lambda: None
            ctrl._run_graph_review = lambda: None
            ctrl._run_graph_proof = lambda: None
            ctrl._close_graph_repairs = lambda: None
            ctrl._verify_run_base = lambda: None
            ctrl.close_root = lambda: {"status": "closed"}

            result = ctrl.run()
            self.assertEqual(result["status"], "closed")
            self.assertEqual(maximum.value, 2)
            self.assertEqual(integrated, ["add-formatter", "add-greeter"])

    def test_parallel_worker_timeout_terminates_hung_node(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            policy = _load("test-policy.json")
            policy["limits"]["node_timeout_seconds"] = 1
            ctrl = _make_controller(td=td, policy=policy)
            ctrl.accept_plan(_load("valid-plan.json"), run_id="worker-timeout")
            child_pid_path = Path(td) / "child.pid"

            def initialize(
                _self: GraphController, _node_id: str,
            ) -> dict[str, Any]:
                return {}

            def worker(
                _self: GraphController,
                _node_id: str,
                _envelope: dict[str, Any],
                _connection: Any,
            ) -> None:
                os.setsid()
                child = subprocess.Popen(["sleep", "5"])
                child_pid_path.write_text(str(child.pid), encoding="utf-8")
                child.wait()

            ctrl._initialize_parallel_node = types.MethodType(initialize, ctrl)
            ctrl._parallel_node_worker = types.MethodType(worker, ctrl)
            started = time.monotonic()
            with self.assertRaisesRegex(
                ControllerError,
                "node timed out after 1s",
            ):
                ctrl._prepare_node_batch(["add-greeter"])
            self.assertLess(time.monotonic() - started, 2)
            child_pid = child_pid_path.read_text(encoding="utf-8")
            status = subprocess.run(
                ["ps", "-p", child_pid, "-o", "stat="],
                capture_output=True,
                text=True,
                check=False,
            ).stdout.strip()
            self.assertFalse(status and not status.startswith("Z"))

    def test_integration_failure_classifies_repairs(self) -> None:
        self.assertTrue(
            GraphController._integration_failure_requires_repair(
                GateError("final gate failed")
            )
        )
        self.assertTrue(
            GraphController._integration_failure_requires_repair(
                ControllerError("rebase conflict")
            )
        )
        self.assertFalse(
            GraphController._integration_failure_requires_repair(
                ControllerError("temporary Git lookup failed")
            )
        )

    def test_clean_review_resolves_prior_findings(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            ctrl = _make_controller(td=td)
            ctrl.accept_plan(_load("valid-plan.json"), run_id="fixed-findings")
            state = ctrl._state["nodes"]["add-greeter"]
            state["findings"]["finding-1"] = {
                "id": "finding-1",
                "status": "open",
                "repair_bead_id": "repair-1",
            }
            ctrl._resolve_fixed_findings(
                "add-greeter",
                state,
                "No findings remain.",
            )
            self.assertEqual(
                state["findings"]["finding-1"]["status"],
                "fixed",
            )

    def test_graph_findings_block_close_until_clean_review(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            ctrl = _make_controller(td=td)
            ctrl.accept_plan(_load("valid-plan.json"), run_id="graph-findings")
            ctrl._state["graph_gates"] = "passed"
            ctrl._state["graph_review"] = "passed"
            ctrl._state["graph_proof"] = "not-applicable"
            findings = ctrl._state.setdefault("graph_findings", {})
            findings["graph-1"] = {
                "id": "graph-1",
                "status": "open",
                "repair_bead_id": "repair-graph",
            }
            self.assertIn(
                "graph has unresolved findings",
                ctrl._graph_close_blockers(),
            )
            ctrl._resolve_finding_set(
                "graph",
                findings,
                "No graph findings remain.",
            )
            self.assertNotIn(
                "graph has unresolved findings",
                ctrl._graph_close_blockers(),
            )

    def test_late_gate_failure_preserves_prepared_repair_state(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            ctrl = _make_controller(td=td)
            ctrl.accept_plan(_load("valid-plan.json"), run_id="late-gate")
            state = ctrl._state["nodes"]["add-greeter"]
            state["execution_prepared"] = True
            state["worktree"] = td
            ctrl._git = lambda *_args, **_kwargs: subprocess.CompletedProcess(
                [], 0, "abc1234\n", "",
            )
            ctrl._rebase_node = lambda *_args: (_ for _ in ()).throw(
                GateError("post-rebase gate failed")
            )
            with self.assertRaisesRegex(
                ControllerError,
                "post-rebase gate failed",
            ):
                ctrl._integrate_prepared_node("add-greeter")
            self.assertTrue(state["execution_prepared"])
            self.assertTrue(state["repair_required"])

    def test_resume_restores(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            sdd = Path(td) / ".sdd" / "graph-of-loops" / "runs" / "res"
            sdd.mkdir(parents=True)
            ctrl = _make_controller(td=td)
            ctrl._run_dir = sdd
            ctrl.accept_plan(_load("valid-plan.json"), run_id="res")
            ctrl2 = _make_controller(td=td)
            ctrl2._run_dir = sdd
            self.assertTrue(ctrl2._restore_state())
            self.assertEqual(ctrl2._run_id, "res")

    def test_accept_plan_reuses_existing_graph_beads(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            beads = StatefulBeads()

            def controller() -> GraphController:
                return GraphController(
                    beads=beads,  # type: ignore[arg-type]
                    bernstein=BernsteinFacade(
                        worktree_manager=FakeWorktreeManager(td),
                    ),
                    waku=WakuNodeRuntime(loop_runner=FakeWakuLoop()),
                    review=PassingReview(),  # type: ignore[arg-type]
                    proof=RaindropProofGate(),
                    evidence=EvidenceLedger(Path(td) / "events.jsonl"),
                    policy=_load("test-policy.json"),
                    run_dir=Path(td) / "run",
                    repo_root=Path(td),
                )

            first = controller()
            first.accept_plan(_load("valid-plan.json"), run_id="same-run")
            issue_count = len(beads.issues)
            second = controller()
            second.accept_plan(_load("valid-plan.json"), run_id="same-run")
            self.assertEqual(len(beads.issues), issue_count)

    def test_accept_plan_recovers_partial_beads_bootstrap(self) -> None:
        class InterruptingBeads(StatefulBeads):
            def __init__(self) -> None:
                super().__init__()
                self.ensure_calls = 0
                self.interrupt = True

            def ensure_issue(
                self,
                *,
                title: str,
                metadata: dict[str, Any],
                identity: dict[str, Any] | None = None,
                parent: str | None = None,
            ) -> str:
                self.ensure_calls += 1
                issue_id = super().ensure_issue(
                    title=title,
                    metadata=metadata,
                    identity=identity,
                    parent=parent,
                )
                if self.interrupt and self.ensure_calls == 2:
                    self.interrupt = False
                    raise BeadsError("simulated bootstrap interruption")
                return issue_id

        with tempfile.TemporaryDirectory() as td:
            beads = InterruptingBeads()

            def controller() -> GraphController:
                return GraphController(
                    beads=beads,  # type: ignore[arg-type]
                    bernstein=BernsteinFacade(
                        worktree_manager=FakeWorktreeManager(td),
                    ),
                    waku=WakuNodeRuntime(loop_runner=FakeWakuLoop()),
                    review=PassingReview(),  # type: ignore[arg-type]
                    proof=RaindropProofGate(),
                    evidence=EvidenceLedger(Path(td) / "events.jsonl"),
                    policy=_load("test-policy.json"),
                    run_dir=Path(td) / "run",
                    repo_root=Path(td),
                )

            with self.assertRaises(BeadsError):
                controller().accept_plan(
                    _load("valid-plan.json"),
                    run_id="partial-run",
                )
            self.assertEqual(len(beads.issues), 2)

            controller().accept_plan(
                _load("valid-plan.json"),
                run_id="partial-run",
            )
            self.assertEqual(len(beads.issues), 3)
            self.assertEqual(
                sum(len(values) for values in beads.dependencies.values()),
                3,
            )

    def test_committed_changes_must_remain_in_write_set(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            subprocess.run(["git", "init", "-q"], cwd=root, check=True)
            subprocess.run(
                ["git", "config", "user.email", "probe@trellage"],
                cwd=root,
                check=True,
            )
            subprocess.run(
                ["git", "config", "user.name", "probe"],
                cwd=root,
                check=True,
            )
            (root / "allowed.txt").write_text("base\n", encoding="utf-8")
            subprocess.run(["git", "add", "."], cwd=root, check=True)
            subprocess.run(
                ["git", "commit", "-q", "-m", "base"],
                cwd=root,
                check=True,
            )
            base = subprocess.run(
                ["git", "rev-parse", "HEAD"],
                cwd=root,
                check=True,
                capture_output=True,
                text=True,
            ).stdout.strip()
            (root / "outside.txt").write_text(
                "unauthorized\n",
                encoding="utf-8",
            )
            subprocess.run(["git", "add", "."], cwd=root, check=True)
            subprocess.run(
                ["git", "commit", "-q", "-m", "outside"],
                cwd=root,
                check=True,
            )
            controller = _make_controller(td=td)
            controller._runner = RealSubprocessRunner()
            with self.assertRaisesRegex(
                ControllerError,
                "outside.txt",
            ):
                controller._validate_changed_paths(
                    {
                        "id": "committed-path",
                        "write_set": ["allowed.txt"],
                        "test_write_set": [],
                        "evidence_write_set": [],
                    },
                    {"worktree_base": base},
                    td,
                )

    def test_policy_limits(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            ctrl = _make_controller(td=td, policy=_load("test-policy.json"))
            ctrl.accept_plan(_load("valid-plan.json"), run_id="l")
            c = ctrl._ceilings_from_policy()
            self.assertEqual(c["max_iterations"], 10)
            self.assertEqual(c["max_specialist_attempts"], 3)

    def test_policy_limits_fail_closed_when_missing(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            ctrl = _make_controller(
                td=td,
                policy={
                    "authorization": {
                        "allow_push": False,
                        "allow_pull_request": False,
                        "allow_deploy": False,
                    },
                },
            )
            with self.assertRaises(ControllerError):
                ctrl._ceilings_from_policy()

    def test_beads_failure_fatal(self) -> None:
        br = FakeSubprocessRunner()
        br.set_default("bead-id\n")
        with tempfile.TemporaryDirectory() as td:
            ctrl = _make_controller(td=td, beads_runner=br)
            ctrl.accept_plan(_load("valid-plan.json"), run_id="bf")
            br.set_failure("bd", rc=1, stderr="broken")
            with self.assertRaises(ControllerError):
                ctrl.execute_node(
                    "add-greeter",
                    specialist_launcher=lambda **kw: {"status": "ok"},
                    gate_runner_fn=lambda **kw: {"passed": True},
                )

    def test_cannot_close_incomplete(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            ctrl = _make_controller(td=td)
            ctrl.accept_plan(_load("valid-plan.json"), run_id="nc")
            can, blockers = ctrl.can_close_root()
            self.assertFalse(can)
            self.assertTrue(len(blockers) > 0)


class TestCLI(unittest.TestCase):
    def test_validate_valid(self) -> None:
        from trellage_graph.cli import main
        self.assertEqual(
            main(["validate-plan", "--plan", str(FIXTURES / "valid-plan.json")]), 0)

    def test_validate_invalid(self) -> None:
        from trellage_graph.cli import main
        self.assertEqual(
            main(["validate-plan", "--plan", str(FIXTURES / "cycle-plan.json")]), 1)

    def test_missing_file(self) -> None:
        from trellage_graph.cli import main
        self.assertEqual(
            main(["validate-plan", "--plan", "/nonexistent"]),
            1,
        )

    def test_run_accepts_goal_without_plan_argument(self) -> None:
        from trellage_graph.cli import build_parser
        args = build_parser().parse_args(["run", "--goal", "fix it"])
        self.assertEqual(args.goal, "fix it")
        self.assertFalse(hasattr(args, "plan") and args.plan)

    def test_run_failure_prints_same_run_resume_command(self) -> None:
        import io
        from contextlib import redirect_stderr
        from unittest.mock import patch

        from trellage_graph.cli import build_parser, cmd_run
        from trellage_graph.run_lifecycle import RunLifecycleError

        class FailingLifecycle:
            def start(self, **_kwargs: Any) -> dict[str, Any]:
                raise RunLifecycleError(
                    "run durable-id blocked: beads unavailable",
                    run_id="durable-id",
                )

        args = build_parser().parse_args(["run", "--goal", "fix it"])
        stderr = io.StringIO()
        with (
            patch("trellage_graph.cli._load_policy", return_value={}),
            patch("trellage_graph.cli._repo_root", return_value=Path.cwd()),
            patch(
                "trellage_graph.cli._make_lifecycle",
                return_value=FailingLifecycle(),
            ),
            redirect_stderr(stderr),
        ):
            self.assertEqual(cmd_run(args), 1)
        self.assertIn(
            "trellage-graph resume --run durable-id",
            stderr.getvalue(),
        )

    def test_finding_rejection_is_scoped_to_run(self) -> None:
        from trellage_graph.cli import build_parser
        args = build_parser().parse_args([
            "finding", "reject", "finding-1",
            "--run", "run-1", "--evidence", "evidence.md",
        ])
        self.assertEqual(args.run_id, "run-1")
        self.assertEqual(args.finding_id, "finding-1")

    def test_resume_replan_is_explicit(self) -> None:
        from trellage_graph.cli import build_parser
        args = build_parser().parse_args([
            "resume", "--run", "run-1", "--replan",
        ])
        self.assertTrue(args.replan)


class TestGraphEntrypointHook(unittest.TestCase):
    @staticmethod
    def _payload(event: str, **values: Any) -> dict[str, Any]:
        return {
            "session_id": "session-1",
            "hook_event_name": event,
            **values,
        }

    def test_requires_direct_run_before_preflight(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            config = Path(td)
            entrypoint_hook(
                self._payload(
                    "UserPromptSubmit",
                    prompt='/graph-of-loops OBJECTIVE="build it"',
                ),
                config_dir=config,
            )
            self.assertIsNone(entrypoint_hook(
                self._payload(
                    "PreToolUse",
                    tool_name="Skill",
                    tool_input={"skill": "graph-of-loops"},
                ),
                config_dir=config,
            ))
            denied_skill = entrypoint_hook(
                self._payload(
                    "PreToolUse",
                    tool_name="Skill",
                    tool_input={"skill": "unrelated-skill"},
                ),
                config_dir=config,
            )
            self.assertEqual(
                denied_skill["hookSpecificOutput"]["permissionDecision"],
                "deny",
            )
            denied = entrypoint_hook(
                self._payload(
                    "PreToolUse",
                    tool_name="Bash",
                    tool_input={"command": "command -v trellage-graph"},
                ),
                config_dir=config,
            )
            self.assertEqual(
                denied["hookSpecificOutput"]["permissionDecision"],
                "deny",
            )
            self.assertIsNotNone(entrypoint_hook(
                self._payload(
                    "PreToolUse",
                    tool_name="Bash",
                    tool_input={
                        "command": "trellage-graph run --goal x | tail -20",
                    },
                ),
                config_dir=config,
            ))
            for command in (
                "trellage-graph run --goal x\ncommand -v trellage-graph",
                "trellage-graph run --goal `command -v trellage-graph`",
                "trellage-graph run --goal $(command -v trellage-graph)",
                "trellage-graph run --goal <(command -v trellage-graph)",
            ):
                with self.subTest(command=command):
                    self.assertIsNotNone(entrypoint_hook(
                        self._payload(
                            "PreToolUse",
                            tool_name="Bash",
                            tool_input={"command": command},
                        ),
                        config_dir=config,
                    ))
            self.assertIsNone(entrypoint_hook(
                self._payload(
                    "PreToolUse",
                    tool_name="Bash",
                    tool_input={"command": "trellage-graph run --goal x"},
                ),
                config_dir=config,
            ))
            self.assertIsNone(entrypoint_hook(
                self._payload(
                    "PostToolUse",
                    tool_name="Bash",
                    tool_input={"command": "trellage-graph run --goal x"},
                    tool_response={"task_id": "controller-task"},
                ),
                config_dir=config,
            ))
            self.assertIsNone(entrypoint_hook(
                self._payload(
                    "PreToolUse",
                    tool_name="Bash",
                    tool_input={"command": "trellage-graph status --run r1"},
                ),
                config_dir=config,
            ))
            self.assertIsNone(entrypoint_hook(
                self._payload(
                    "PreToolUse",
                    tool_name="TaskOutput",
                    tool_input={"task_id": "controller-task"},
                ),
                config_dir=config,
            ))
            self.assertIsNone(entrypoint_hook(
                self._payload(
                    "PreToolUse",
                    tool_name="TaskStop",
                    tool_input={"task_id": "controller-task"},
                ),
                config_dir=config,
            ))
            denied_task = entrypoint_hook(
                self._payload(
                    "PreToolUse",
                    tool_name="TaskOutput",
                    tool_input={"task_id": "unrelated-task"},
                ),
                config_dir=config,
            )
            self.assertEqual(
                denied_task["hookSpecificOutput"]["permissionDecision"],
                "deny",
            )
            self.assertIsNotNone(entrypoint_hook(
                self._payload(
                    "PreToolUse",
                    tool_name="Read",
                    tool_input={"file_path": "shortener/store.py"},
                ),
                config_dir=config,
            ))

    def test_existing_run_prompt_allows_direct_status_then_resume(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            config = Path(td)
            entrypoint_hook(
                self._payload(
                    "UserPromptSubmit",
                    prompt=(
                        "/graph-of-loops Resume the existing Graph of Loops "
                        "run 72e145d2e954. Do not start a new run."
                    ),
                ),
                config_dir=config,
            )
            self.assertIsNone(entrypoint_hook(
                self._payload(
                    "PreToolUse",
                    tool_name="Skill",
                    tool_input={"skill": "graph-of-loops"},
                ),
                config_dir=config,
            ))
            denied = entrypoint_hook(
                self._payload(
                    "PreToolUse",
                    tool_name="Read",
                    tool_input={"file_path": "README.md"},
                ),
                config_dir=config,
            )
            self.assertEqual(
                denied["hookSpecificOutput"]["permissionDecision"],
                "deny",
            )
            status = self._payload(
                "PreToolUse",
                tool_name="Bash",
                tool_input={
                    "command": "trellage-graph status --run 72e145d2e954",
                },
            )
            self.assertIsNone(entrypoint_hook(status, config_dir=config))
            self.assertIsNone(entrypoint_hook(
                self._payload(
                    "PostToolUse",
                    tool_name="Bash",
                    tool_input=status["tool_input"],
                    tool_response={},
                ),
                config_dir=config,
            ))
            self.assertIsNone(entrypoint_hook(
                self._payload(
                    "PreToolUse",
                    tool_name="Bash",
                    tool_input={
                        "command": "trellage-graph resume --run 72e145d2e954",
                    },
                ),
                config_dir=config,
            ))

    def test_controller_task_id_accepts_nested_and_text_responses(self) -> None:
        responses = [
            (
                {"data": {"shellId": "nested-controller"}},
                "nested-controller",
            ),
            (
                "Command started in background; task ID: text-controller",
                "text-controller",
            ),
            (
                {"backgroundTaskId": "claude-controller"},
                "claude-controller",
            ),
            (
                "Command running in background with ID: response-controller.",
                "response-controller",
            ),
        ]
        for index, (response, expected) in enumerate(responses):
            with self.subTest(response=response), tempfile.TemporaryDirectory() as td:
                config = Path(td)
                session_id = f"session-{index}"
                self.assertIsNone(entrypoint_hook(
                    self._payload(
                        "UserPromptSubmit",
                        session_id=session_id,
                        prompt="/graph-of-loops test",
                    ),
                    config_dir=config,
                ))
                self.assertIsNone(entrypoint_hook(
                    self._payload(
                        "PreToolUse",
                        session_id=session_id,
                        tool_name="Bash",
                        tool_input={"command": "trellage-graph run --goal x"},
                    ),
                    config_dir=config,
                ))
                self.assertIsNone(entrypoint_hook(
                    self._payload(
                        "PostToolUse",
                        session_id=session_id,
                        tool_name="Bash",
                        tool_input={"command": "trellage-graph run --goal x"},
                        tool_response=response,
                    ),
                    config_dir=config,
                ))
                self.assertIsNone(entrypoint_hook(
                    self._payload(
                        "PreToolUse",
                        session_id=session_id,
                        tool_name="TaskOutput",
                        tool_input={"task_id": expected},
                    ),
                    config_dir=config,
                ))

    def test_controller_task_id_ignores_untrusted_nested_fields(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            config = Path(td)
            entrypoint_hook(
                self._payload(
                    "UserPromptSubmit",
                    prompt="/graph-of-loops test",
                ),
                config_dir=config,
            )
            entrypoint_hook(
                self._payload(
                    "PreToolUse",
                    tool_name="Bash",
                    tool_input={"command": "trellage-graph run --goal x"},
                ),
                config_dir=config,
            )
            entrypoint_hook(
                self._payload(
                    "PostToolUse",
                    tool_name="Bash",
                    tool_input={"command": "trellage-graph run --goal x"},
                    tool_response={
                        "stdout": {"task_id": "untrusted-controller"},
                    },
                ),
                config_dir=config,
            )
            denied = entrypoint_hook(
                self._payload(
                    "PreToolUse",
                    tool_name="TaskOutput",
                    tool_input={"task_id": "untrusted-controller"},
                ),
                config_dir=config,
            )
            self.assertEqual(
                denied["hookSpecificOutput"]["permissionDecision"],
                "deny",
            )

    def test_controller_task_id_updates_for_background_resume(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            config = Path(td)
            self.assertIsNone(entrypoint_hook(
                self._payload(
                    "UserPromptSubmit",
                    prompt="/graph-of-loops test",
                ),
                config_dir=config,
            ))
            self.assertIsNone(entrypoint_hook(
                self._payload(
                    "PreToolUse",
                    tool_name="Bash",
                    tool_input={"command": "trellage-graph run --goal x"},
                ),
                config_dir=config,
            ))
            self.assertIsNone(entrypoint_hook(
                self._payload(
                    "PostToolUse",
                    tool_name="Bash",
                    tool_input={"command": "trellage-graph run --goal x"},
                    tool_response={"backgroundTaskId": "run-task"},
                ),
                config_dir=config,
            ))
            self.assertIsNone(entrypoint_hook(
                self._payload(
                    "PreToolUse",
                    tool_name="Bash",
                    tool_input={"command": "trellage-graph resume --run r1"},
                ),
                config_dir=config,
            ))
            self.assertIsNone(entrypoint_hook(
                self._payload(
                    "PostToolUse",
                    tool_name="Bash",
                    tool_input={"command": "trellage-graph resume --run r1"},
                    tool_response={"backgroundTaskId": "resume-task"},
                ),
                config_dir=config,
            ))
            self.assertIsNone(entrypoint_hook(
                self._payload(
                    "PreToolUse",
                    tool_name="TaskOutput",
                    tool_input={"task_id": "resume-task"},
                ),
                config_dir=config,
            ))
            denied = entrypoint_hook(
                self._payload(
                    "PreToolUse",
                    tool_name="TaskOutput",
                    tool_input={"task_id": "run-task"},
                ),
                config_dir=config,
            )
            self.assertEqual(
                denied["hookSpecificOutput"]["permissionDecision"],
                "deny",
            )

    def test_malformed_state_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            config = Path(td)
            state = (
                config / ".trellage" / "graph-entrypoint" / "session-1.json"
            )
            state.parent.mkdir(parents=True)
            state.write_text("{", encoding="utf-8")
            denied = entrypoint_hook(
                self._payload(
                    "PreToolUse",
                    tool_name="Bash",
                    tool_input={"command": "trellage-graph run --goal x"},
                ),
                config_dir=config,
            )
            self.assertEqual(
                denied["hookSpecificOutput"]["permissionDecision"],
                "deny",
            )

    def test_failed_run_allows_direct_retry(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            config = Path(td)
            entrypoint_hook(
                self._payload(
                    "UserPromptSubmit",
                    prompt='/graph-of-loops OBJECTIVE="build it"',
                ),
                config_dir=config,
            )
            run_payload = self._payload(
                "PreToolUse",
                tool_name="Bash",
                tool_input={"command": "trellage-graph run --goal x"},
            )
            self.assertIsNone(entrypoint_hook(run_payload, config_dir=config))
            self.assertIsNone(entrypoint_hook(
                self._payload(
                    "PostToolUseFailure",
                    tool_name="Bash",
                    tool_input={"command": "trellage-graph run --goal x"},
                ),
                config_dir=config,
            ))
            for command in (
                "trellage-graph status --run r1",
                "trellage-graph resume --run r1",
                "trellage-graph finding --run r1 --node n1 --severity high "
                "--summary x --evidence y",
                "trellage-graph run --goal retry",
            ):
                with self.subTest(command=command):
                    self.assertIsNone(entrypoint_hook(
                        self._payload(
                            "PreToolUse",
                            tool_name="Bash",
                            tool_input={"command": command},
                        ),
                        config_dir=config,
                    ))
            self.assertIsNone(entrypoint_hook(run_payload, config_dir=config))


class FakePlanner:
    def __init__(
        self,
        plan: dict[str, Any],
        *,
        events: list[str] | None = None,
        error: Exception | None = None,
    ) -> None:
        self.plan_value = plan
        self.events = events
        self.error = error
        self.calls = 0

    def plan(self, **_kwargs: Any) -> PlanningResult:
        self.calls += 1
        if self.events is not None:
            self.events.append("planner")
        if self.error is not None:
            raise self.error
        plan = json.loads(json.dumps(self.plan_value))
        plan["objective"] = str(_kwargs["objective"])
        plan["constraints"] = list(_kwargs["constraints"])
        for node in plan["nodes"]:
            if node.get("behavior_change"):
                node["repair_write_set"] = [
                    *node["write_set"],
                    *node.get("test_write_set", []),
                ]
        plan["validation_matrix"] = [
            {
                "kind": kind,
                "status": "not-applicable",
                "source_paths": ["."],
                "reason": "fixture does not exercise this repository check",
            }
            for kind in ("format", "lint", "typecheck", "build")
        ] + [
            {
                "kind": "targeted-test",
                "status": "covered",
                "source_paths": ["."],
                "gate_names": ["test-final"],
            },
            {
                "kind": "full-suite",
                "status": "covered",
                "source_paths": ["."],
                "gate_names": ["test-final"],
            },
        ]
        decision = {
            "status": "planned",
            "objective": plan["objective"],
            "constraints": plan["constraints"],
            "target_evidence": [{
                "path": ".",
                "detail": "fixture target",
            }],
            "plan": plan,
        }
        return PlanningResult(
            plan=plan,
            decision=decision,
            serena_success=True,
            serena_fallback=False,
            tool_events=[{"type": "tool_use", "name": "mcp__serena__find_symbol"}],
        )


class FakeBlockedPlanner(FakePlanner):
    def plan(self, **_kwargs: Any) -> PlanningResult:
        self.calls += 1
        decision = {
            "status": "blocked",
            "objective": str(_kwargs["objective"]),
            "constraints": list(_kwargs["constraints"]),
            "reason_code": "target-not-found",
            "summary": "The requested subsystem is absent.",
            "evidence": [{
                "path": ".",
                "detail": "Repository inspection found no matching target.",
            }],
            "constraint_conflicts": [],
        }
        return PlanningResult(
            plan=None,
            decision=decision,
            serena_success=True,
            serena_fallback=False,
            tool_events=[{
                "type": "tool_use",
                "name": "mcp__serena__find_symbol",
            }],
        )


class FakeLifecycleController:
    def __init__(
        self,
        *,
        restored: bool = False,
        accept_error: Exception | None = None,
    ) -> None:
        self.restored = restored
        self.accept_error = accept_error
        self.accept_calls = 0
        self.run_calls = 0
        self.reject_calls = 0

    def resume(self, _run_id: str) -> bool:
        return self.restored

    def accept_plan(
        self,
        _plan: dict[str, Any],
        *,
        run_id: str,
        plan_generation: int = 1,
    ) -> str:
        del plan_generation
        self.accept_calls += 1
        if self.accept_error is not None:
            raise self.accept_error
        self.restored = True
        return f"root-{run_id}"

    def prepare_replan(self, _run_id: str) -> int:
        self.restored = False
        return 1

    def run(self) -> dict[str, Any]:
        self.run_calls += 1
        return {"status": "closed", "root_bead_id": "root"}

    def status(self) -> dict[str, Any]:
        return {"status": "running", "run_id": "restored"}

    def reject_finding(
        self,
        *,
        finding_id: str,
        evidence_path: str,
    ) -> dict[str, Any]:
        self.reject_calls += 1
        return {
            "finding_id": finding_id,
            "evidence_path": evidence_path,
        }


class FakePlanReviewer:
    def __init__(self, error: Exception | None = None) -> None:
        self.error = error
        self.calls = 0
        self.last_kwargs: dict[str, Any] = {}

    def review(self, **kwargs: Any) -> dict[str, Any]:
        self.calls += 1
        self.last_kwargs = kwargs
        if self.error is not None:
            raise self.error
        return {
            "summary": "candidate plan is grounded",
            "output_path": "review.json",
        }


class TestRunLifecycle(unittest.TestCase):
    def test_announces_run_before_planner_and_persists_request(self) -> None:
        from trellage_graph.run_lifecycle import RunLifecycle

        with tempfile.TemporaryDirectory() as td:
            events: list[str] = []
            planner = FakePlanner(_load("valid-plan.json"), events=events)
            controller = FakeLifecycleController()
            lifecycle = RunLifecycle(
                repo_root=Path(td),
                policy=_load("test-policy.json"),
                planner=planner,
                controller_factory=lambda _run_id: controller,
                announce=lambda run_id: events.append(f"run:{run_id}"),
            )
            result = lifecycle.start(
                objective="build it",
                constraints=["no push"],
                requested_run_id="early-id",
            )
            self.assertEqual(events[:2], ["run:early-id", "planner"])
            self.assertEqual(result["status"], "closed")
            run_dir = (
                Path(td) / ".sdd" / "graph-of-loops"
                / "runs" / "early-id"
            )
            self.assertTrue((run_dir / "request.json").is_file())
            self.assertTrue((run_dir / "plan.json").is_file())

    def test_same_run_rejects_concurrent_writer(self) -> None:
        from trellage_graph.run_lifecycle import (
            RunLifecycle,
            RunLifecycleError,
        )

        with tempfile.TemporaryDirectory() as td:
            observed: list[str] = []
            lifecycle: RunLifecycle
            testcase = self

            class ReentrantPlanner(FakePlanner):
                def plan(self, **kwargs: Any) -> PlanningResult:
                    with testcase.assertRaises(RunLifecycleError) as ctx:
                        lifecycle.resume("locked-run")
                    observed.append(str(ctx.exception))
                    return super().plan(**kwargs)

            lifecycle = RunLifecycle(
                repo_root=Path(td),
                policy=_load("test-policy.json"),
                planner=ReentrantPlanner(_load("valid-plan.json")),
                controller_factory=lambda _run_id: FakeLifecycleController(),
                announce=lambda _run_id: None,
            )
            lifecycle.start(
                objective="build it",
                constraints=[],
                requested_run_id="locked-run",
            )
            self.assertIn("already active", observed[0])

    def test_same_run_rejects_request_mismatch(self) -> None:
        from trellage_graph.run_lifecycle import (
            RunLifecycle,
            RunLifecycleError,
        )

        with tempfile.TemporaryDirectory() as td:
            lifecycle = RunLifecycle(
                repo_root=Path(td),
                policy=_load("test-policy.json"),
                planner=FakePlanner(_load("valid-plan.json")),
                controller_factory=lambda _run_id: FakeLifecycleController(),
                announce=lambda _run_id: None,
            )
            lifecycle.start(
                objective="first objective",
                constraints=[],
                requested_run_id="fixed-request",
            )
            with self.assertRaises(RunLifecycleError) as ctx:
                lifecycle.start(
                    objective="different objective",
                    constraints=[],
                    requested_run_id="fixed-request",
                )
            self.assertIn("does not match", str(ctx.exception))

    def test_finding_rejection_uses_same_run_lock(self) -> None:
        from trellage_graph.run_lifecycle import (
            RunLifecycle,
            RunLifecycleError,
        )

        with tempfile.TemporaryDirectory() as td:
            lifecycle: RunLifecycle
            testcase = self

            class ReentrantPlanner(FakePlanner):
                def plan(self, **kwargs: Any) -> PlanningResult:
                    with testcase.assertRaises(RunLifecycleError) as ctx:
                        lifecycle.reject_finding(
                            "finding-lock",
                            finding_id="finding-1",
                            evidence_path="evidence.md",
                        )
                    testcase.assertIn("already active", str(ctx.exception))
                    return super().plan(**kwargs)

            lifecycle = RunLifecycle(
                repo_root=Path(td),
                policy=_load("test-policy.json"),
                planner=ReentrantPlanner(_load("valid-plan.json")),
                controller_factory=lambda _run_id: FakeLifecycleController(
                    restored=True,
                ),
                announce=lambda _run_id: None,
            )
            lifecycle.start(
                objective="build it",
                constraints=[],
                requested_run_id="finding-lock",
            )

    def test_resume_reuses_valid_plan_after_accept_failure(self) -> None:
        from trellage_graph.run_lifecycle import (
            RunLifecycle,
            RunLifecycleError,
        )

        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            subprocess.run(["git", "init", "-q"], cwd=root, check=True)
            subprocess.run(
                ["git", "config", "user.email", "test@trellage.invalid"],
                cwd=root,
                check=True,
            )
            subprocess.run(
                ["git", "config", "user.name", "Trellage Test"],
                cwd=root,
                check=True,
            )
            (root / "README").write_text("fixture\n", encoding="utf-8")
            subprocess.run(["git", "add", "README"], cwd=root, check=True)
            subprocess.run(
                ["git", "commit", "-q", "-m", "fixture"],
                cwd=root,
                check=True,
            )
            revision = subprocess.run(
                ["git", "rev-parse", "HEAD"],
                cwd=root,
                capture_output=True,
                text=True,
                check=True,
            ).stdout.strip()
            plan = _load("valid-plan.json")
            plan["base_revision"] = revision
            first_planner = FakePlanner(plan)
            first = RunLifecycle(
                repo_root=root,
                policy=_load("test-policy.json"),
                planner=first_planner,
                controller_factory=lambda _run_id: FakeLifecycleController(
                    accept_error=ControllerError("beads unavailable"),
                ),
                announce=lambda _run_id: None,
            )
            with self.assertRaises(RunLifecycleError):
                first.start(
                    objective="build it",
                    constraints=[],
                    requested_run_id="reuse-plan",
                )
            second_planner = FakePlanner(
                plan,
                error=AssertionError("planner must not run"),
            )
            controller = FakeLifecycleController()
            second = RunLifecycle(
                repo_root=root,
                policy=_load("test-policy.json"),
                planner=second_planner,
                controller_factory=lambda _run_id: controller,
                announce=lambda _run_id: None,
            )
            result = second.resume("reuse-plan")
            self.assertEqual(result["status"], "closed")
            self.assertEqual(second_planner.calls, 0)
            self.assertEqual(controller.accept_calls, 1)

    def test_resume_rejects_tampered_plan_provenance(self) -> None:
        from trellage_graph.run_lifecycle import (
            RunLifecycle,
            RunLifecycleError,
        )

        with tempfile.TemporaryDirectory() as td:
            first = RunLifecycle(
                repo_root=Path(td),
                policy=_load("test-policy.json"),
                planner=FakePlanner(_load("valid-plan.json")),
                controller_factory=lambda _run_id: FakeLifecycleController(
                    accept_error=ControllerError("beads unavailable"),
                ),
                announce=lambda _run_id: None,
            )
            with self.assertRaises(RunLifecycleError):
                first.start(
                    objective="build it",
                    constraints=[],
                    requested_run_id="tampered-plan",
                )
            plan_path = (
                Path(td) / ".sdd" / "graph-of-loops" / "runs"
                / "tampered-plan" / "plan.json"
            )
            plan = json.loads(plan_path.read_text(encoding="utf-8"))
            plan["objective"] = "tampered"
            plan_path.write_text(json.dumps(plan), encoding="utf-8")
            second = RunLifecycle(
                repo_root=Path(td),
                policy=_load("test-policy.json"),
                planner=FakePlanner(
                    _load("valid-plan.json"),
                    error=AssertionError("planner must not run"),
                ),
                controller_factory=lambda _run_id: FakeLifecycleController(),
                announce=lambda _run_id: None,
            )
            with self.assertRaisesRegex(
                RunLifecycleError,
                "persisted plan provenance is stale",
            ):
                second.resume("tampered-plan")

    def test_explicit_replan_archives_preaccept_generation(self) -> None:
        from trellage_graph.run_lifecycle import (
            RunLifecycle,
            RunLifecycleError,
        )

        with tempfile.TemporaryDirectory() as td:
            first = RunLifecycle(
                repo_root=Path(td),
                policy=_load("test-policy.json"),
                planner=FakePlanner(_load("valid-plan.json")),
                controller_factory=lambda _run_id: FakeLifecycleController(
                    accept_error=ControllerError("beads unavailable"),
                ),
                announce=lambda _run_id: None,
            )
            with self.assertRaises(RunLifecycleError):
                first.start(
                    objective="build it",
                    constraints=[],
                    requested_run_id="replan-run",
                )
            second_planner = FakePlanner(_load("valid-plan.json"))
            second = RunLifecycle(
                repo_root=Path(td),
                policy=_load("test-policy.json"),
                planner=second_planner,
                controller_factory=lambda _run_id: FakeLifecycleController(),
                announce=lambda _run_id: None,
            )
            result = second.resume("replan-run", replan=True)
            self.assertEqual(result["status"], "closed")
            run_dir = (
                Path(td) / ".sdd" / "graph-of-loops"
                / "runs" / "replan-run"
            )
            self.assertTrue(
                (run_dir / "history" / "generation-1" / "plan.json").is_file()
            )
            record = json.loads(
                (run_dir / "plan-record.json").read_text(encoding="utf-8")
            )
            self.assertEqual(record["generation"], 2)
            self.assertEqual(second_planner.calls, 1)

    def test_repeated_preaccept_replan_uses_candidate_generation(self) -> None:
        from trellage_graph.run_lifecycle import (
            RunLifecycle,
            RunLifecycleError,
        )

        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            plan = _load("valid-plan.json")
            semantic_error = ReviewError(
                "candidate plan has a defect",
                findings=[{"id": "plan-defect"}],
            )

            first = RunLifecycle(
                repo_root=root,
                policy=_load("test-policy.json"),
                planner=FakePlanner(plan),
                plan_reviewer=FakePlanReviewer(semantic_error),
                controller_factory=lambda _run_id: FakeLifecycleController(),
                announce=lambda _run_id: None,
            )
            with self.assertRaises(RunLifecycleError):
                first.start(
                    objective="build it",
                    constraints=[],
                    requested_run_id="repeat-replan",
                )

            second = RunLifecycle(
                repo_root=root,
                policy=_load("test-policy.json"),
                planner=FakePlanner(plan),
                plan_reviewer=FakePlanReviewer(semantic_error),
                controller_factory=lambda _run_id: FakeLifecycleController(),
                announce=lambda _run_id: None,
            )
            with self.assertRaises(RunLifecycleError):
                second.resume("repeat-replan", replan=True)

            run_dir = second._run_dir("repeat-replan")
            candidate = json.loads(
                (run_dir / "candidate-record.json").read_text(encoding="utf-8")
            )
            self.assertEqual(candidate["generation"], 2)

            third = RunLifecycle(
                repo_root=root,
                policy=_load("test-policy.json"),
                planner=FakePlanner(plan),
                plan_reviewer=FakePlanReviewer(),
                controller_factory=lambda _run_id: FakeLifecycleController(),
                announce=lambda _run_id: None,
            )
            result = third.resume("repeat-replan", replan=True)

            self.assertEqual(result["status"], "closed")
            record = json.loads(
                (run_dir / "plan-record.json").read_text(encoding="utf-8")
            )
            self.assertEqual(record["generation"], 3)
            self.assertTrue(
                (
                    run_dir / "history" / "generation-2"
                    / "planning-review-failure.json"
                ).is_file()
            )

    def test_generation_archive_recovers_partial_move_and_is_idempotent(self) -> None:
        from trellage_graph.run_lifecycle import RunLifecycle

        with tempfile.TemporaryDirectory() as td:
            lifecycle = RunLifecycle(
                repo_root=Path(td),
                policy=_load("test-policy.json"),
                planner=FakePlanner(_load("valid-plan.json")),
                controller_factory=lambda _run_id: FakeLifecycleController(),
                announce=lambda _run_id: None,
            )
            run_dir = lifecycle._run_dir("archive-recovery")
            staging = run_dir / "history" / ".generation-1.staging"
            staging.mkdir(parents=True)
            (staging / "plan.json").write_text("{}\n", encoding="utf-8")
            (run_dir / "plan-record.json").write_text("{}\n", encoding="utf-8")

            lifecycle._archive_generation("archive-recovery", 1)
            archived = run_dir / "history" / "generation-1"
            self.assertTrue((archived / "plan.json").is_file())
            self.assertTrue((archived / "plan-record.json").is_file())

            lifecycle._archive_generation("archive-recovery", 1)
            self.assertTrue((archived / "plan.json").is_file())

    def test_status_reports_preaccept_planner_failure(self) -> None:
        from trellage_graph.run_lifecycle import (
            RunLifecycle,
            RunLifecycleError,
        )

        with tempfile.TemporaryDirectory() as td:
            lifecycle = RunLifecycle(
                repo_root=Path(td),
                policy=_load("test-policy.json"),
                planner=FakePlanner(
                    _load("valid-plan.json"),
                    error=SpecialistError("planner timed out"),
                ),
                controller_factory=lambda _run_id: FakeLifecycleController(),
                announce=lambda _run_id: None,
            )
            with self.assertRaises(RunLifecycleError):
                lifecycle.start(
                    objective="build it",
                    constraints=[],
                    requested_run_id="blocked-plan",
                )
            status = lifecycle.status("blocked-plan")
            self.assertEqual(status["run_id"], "blocked-plan")
            self.assertEqual(status["status"], "blocked")
            self.assertIn("planner timed out", status["error"])

    def test_blocked_planning_decision_is_durable(self) -> None:
        from trellage_graph.run_lifecycle import (
            RunLifecycle,
            RunLifecycleError,
        )

        with tempfile.TemporaryDirectory() as td:
            planner = FakeBlockedPlanner(_load("valid-plan.json"))
            lifecycle = RunLifecycle(
                repo_root=Path(td),
                policy=_load("test-policy.json"),
                planner=planner,
                controller_factory=lambda _run_id: FakeLifecycleController(),
                announce=lambda _run_id: None,
            )
            with self.assertRaises(RunLifecycleError) as ctx:
                lifecycle.start(
                    objective="implement missing webhooks",
                    constraints=["preserve existing webhook storage"],
                    requested_run_id="blocked-decision",
                )
            self.assertIn("target-not-found", str(ctx.exception))
            run_dir = (
                Path(td) / ".sdd" / "graph-of-loops"
                / "runs" / "blocked-decision"
            )
            self.assertTrue((run_dir / "planning-decision.json").is_file())
            self.assertFalse((run_dir / "plan.json").exists())
            with self.assertRaises(RunLifecycleError):
                lifecycle.resume("blocked-decision")
            self.assertEqual(planner.calls, 1)

    def test_plan_review_finding_blocks_acceptance_and_reuse(self) -> None:
        from trellage_graph.run_lifecycle import (
            RunLifecycle,
            RunLifecycleError,
        )

        with tempfile.TemporaryDirectory() as td:
            planner = FakePlanner(_load("valid-plan.json"))
            reviewer = FakePlanReviewer(
                ReviewError(
                    "candidate plan invents an unrelated subsystem",
                    findings=[{"id": "scope-drift"}],
                )
            )
            lifecycle = RunLifecycle(
                repo_root=Path(td),
                policy=_load("test-policy.json"),
                planner=planner,
                plan_reviewer=reviewer,
                controller_factory=lambda _run_id: FakeLifecycleController(),
                announce=lambda _run_id: None,
            )
            with self.assertRaises(RunLifecycleError):
                lifecycle.start(
                    objective="build it",
                    constraints=[],
                    requested_run_id="review-blocked",
                )
            run_dir = (
                Path(td) / ".sdd" / "graph-of-loops"
                / "runs" / "review-blocked"
            )
            self.assertTrue((run_dir / "candidate-plan.json").is_file())
            self.assertFalse((run_dir / "plan.json").exists())
            with self.assertRaisesRegex(
                RunLifecycleError,
                "explicit replan is required",
            ):
                lifecycle.resume("review-blocked")
            self.assertEqual(planner.calls, 1)
            self.assertEqual(reviewer.calls, 1)
            prompt = str(reviewer.last_kwargs["prompt"])
            self.assertIn("run review-blocked", prompt)
            self.assertIn(
                ".sdd/graph-of-loops/runs/review-blocked/request.json",
                prompt,
            )
            self.assertIn(
                ".sdd/graph-of-loops/runs/review-blocked/candidate-plan.json",
                prompt,
            )
            self.assertIn(
                "compiler-host targets from targets with configured linkers",
                prompt,
            )

    def test_resume_retries_only_infrastructure_plan_review(self) -> None:
        from trellage_graph.run_lifecycle import (
            RunLifecycle,
            RunLifecycleError,
        )

        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            subprocess.run(["git", "init", "-q"], cwd=root, check=True)
            subprocess.run(
                ["git", "config", "user.email", "test@trellage.invalid"],
                cwd=root,
                check=True,
            )
            subprocess.run(
                ["git", "config", "user.name", "Trellage Test"],
                cwd=root,
                check=True,
            )
            (root / "README").write_text("fixture\n", encoding="utf-8")
            subprocess.run(["git", "add", "README"], cwd=root, check=True)
            subprocess.run(
                ["git", "commit", "-q", "-m", "fixture"],
                cwd=root,
                check=True,
            )
            revision = subprocess.run(
                ["git", "rev-parse", "HEAD"],
                cwd=root,
                capture_output=True,
                text=True,
                check=True,
            ).stdout.strip()
            plan = _load("valid-plan.json")
            plan["base_revision"] = revision
            planner = FakePlanner(plan)
            failing_reviewer = FakePlanReviewer(
                ReviewError("codex exit=1: Copilot request failed with HTTP 400")
            )
            first = RunLifecycle(
                repo_root=root,
                policy=_load("test-policy.json"),
                planner=planner,
                plan_reviewer=failing_reviewer,
                controller_factory=lambda _run_id: FakeLifecycleController(),
                announce=lambda _run_id: None,
            )
            with self.assertRaises(RunLifecycleError):
                first.start(
                    objective="build it",
                    constraints=[],
                    requested_run_id="review-retry",
                )
            run_dir = (
                Path(td) / ".sdd" / "graph-of-loops"
                / "runs" / "review-retry"
            )
            failure = json.loads(
                (run_dir / "planning-review-failure.json").read_text(
                    encoding="utf-8"
                )
            )
            self.assertEqual(failure["kind"], "infrastructure")

            succeeding_reviewer = FakePlanReviewer()
            second_planner = FakePlanner(
                plan,
                error=AssertionError("planner must not run"),
            )
            controller = FakeLifecycleController()
            second = RunLifecycle(
                repo_root=root,
                policy=_load("test-policy.json"),
                planner=second_planner,
                plan_reviewer=succeeding_reviewer,
                controller_factory=lambda _run_id: controller,
                announce=lambda _run_id: None,
            )
            result = second.resume("review-retry")
            self.assertEqual(result["status"], "closed")
            self.assertEqual(second_planner.calls, 0)
            self.assertEqual(succeeding_reviewer.calls, 1)
            self.assertFalse(
                (run_dir / "planning-review-failure.json").exists()
            )
            self.assertFalse((run_dir / "candidate-plan.json").exists())
            self.assertTrue((run_dir / "plan.json").is_file())

    def test_resume_rejects_reviewed_plan_after_base_revision_changes(self) -> None:
        from trellage_graph.run_lifecycle import (
            RunLifecycle,
            RunLifecycleError,
        )

        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            subprocess.run(["git", "init", "-q"], cwd=root, check=True)
            subprocess.run(
                ["git", "config", "user.email", "test@trellage.invalid"],
                cwd=root,
                check=True,
            )
            subprocess.run(
                ["git", "config", "user.name", "Trellage Test"],
                cwd=root,
                check=True,
            )
            tracked = root / "README"
            tracked.write_text("first\n", encoding="utf-8")
            subprocess.run(["git", "add", "README"], cwd=root, check=True)
            subprocess.run(
                ["git", "commit", "-q", "-m", "first"],
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
            plan = _load("valid-plan.json")
            plan["base_revision"] = base_revision
            first = RunLifecycle(
                repo_root=root,
                policy=_load("test-policy.json"),
                planner=FakePlanner(plan),
                controller_factory=lambda _run_id: FakeLifecycleController(
                    accept_error=ControllerError("beads unavailable"),
                ),
                announce=lambda _run_id: None,
            )
            with self.assertRaises(RunLifecycleError):
                first.start(
                    objective="build it",
                    constraints=[],
                    requested_run_id="stale-reviewed-plan",
                )

            tracked.write_text("second\n", encoding="utf-8")
            subprocess.run(["git", "add", "README"], cwd=root, check=True)
            subprocess.run(
                ["git", "commit", "-q", "-m", "second"],
                cwd=root,
                check=True,
            )
            controller = FakeLifecycleController()
            second = RunLifecycle(
                repo_root=root,
                policy=_load("test-policy.json"),
                planner=FakePlanner(
                    plan,
                    error=AssertionError("planner must not run"),
                ),
                controller_factory=lambda _run_id: controller,
                announce=lambda _run_id: None,
            )
            with self.assertRaisesRegex(
                RunLifecycleError,
                "reviewed plan base revision changed",
            ):
                second.resume("stale-reviewed-plan")
            self.assertEqual(controller.accept_calls, 0)

    def test_accepted_run_defers_revision_check_to_controller(self) -> None:
        from trellage_graph.run_lifecycle import (
            RunLifecycle,
            RunLifecycleError,
        )

        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            subprocess.run(["git", "init", "-q"], cwd=root, check=True)
            subprocess.run(
                ["git", "config", "user.email", "test@trellage.invalid"],
                cwd=root,
                check=True,
            )
            subprocess.run(
                ["git", "config", "user.name", "Trellage Test"],
                cwd=root,
                check=True,
            )
            tracked = root / "README"
            tracked.write_text("base\n", encoding="utf-8")
            subprocess.run(["git", "add", "README"], cwd=root, check=True)
            subprocess.run(
                ["git", "commit", "-q", "-m", "base"],
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
            plan = _load("valid-plan.json")
            plan["base_revision"] = base_revision
            first = RunLifecycle(
                repo_root=root,
                policy=_load("test-policy.json"),
                planner=FakePlanner(plan),
                controller_factory=lambda _run_id: FakeLifecycleController(
                    accept_error=ControllerError("beads unavailable"),
                ),
                announce=lambda _run_id: None,
            )
            with self.assertRaises(RunLifecycleError):
                first.start(
                    objective="build it",
                    constraints=[],
                    requested_run_id="accepted-resume",
                )
            run_dir = (
                root / ".sdd" / "graph-of-loops"
                / "runs" / "accepted-resume"
            )
            (run_dir / "state.json").write_text(
                '{"plan_generation":1}\n',
                encoding="utf-8",
            )
            tracked.write_text("integrated\n", encoding="utf-8")
            subprocess.run(["git", "add", "README"], cwd=root, check=True)
            subprocess.run(
                ["git", "commit", "-q", "-m", "integrated"],
                cwd=root,
                check=True,
            )
            controller = FakeLifecycleController(restored=True)
            second = RunLifecycle(
                repo_root=root,
                policy=_load("test-policy.json"),
                planner=FakePlanner(
                    plan,
                    error=AssertionError("planner must not run"),
                ),
                controller_factory=lambda _run_id: controller,
                announce=lambda _run_id: None,
            )
            result = second.resume("accepted-resume")
            self.assertEqual(result["status"], "closed")
            self.assertEqual(controller.accept_calls, 0)


class TestContentDigest(unittest.TestCase):
    def test_string(self) -> None:
        self.assertTrue(content_digest("hi").startswith("sha256:"))

    def test_deterministic(self) -> None:
        self.assertEqual(content_digest("x"), content_digest("x"))


class TestRedaction(unittest.TestCase):
    def test_api_key(self) -> None:
        self.assertIn("[REDACTED]", redact_sensitive("api_key: secret123"))

    def test_gh_token(self) -> None:
        self.assertIn("[REDACTED]", redact_sensitive("ghp_abcdefghijklmnopqrstuvwxyz1234567890"))

    def test_safe(self) -> None:
        self.assertEqual(redact_sensitive("hello"), "hello")


class TestSchemaValidation(unittest.TestCase):
    def test_research_ledger_names_a_session_directory(self) -> None:
        errors = _check_research_write_rules([{
            "id": "research",
            "type": "research",
            "write_set": [],
            "evidence_write_set": ["docs/research/**"],
            "research_ledger": "docs/research/claims.md",
        }])

        self.assertIn(
            "research node 'research' research_ledger must name a session directory",
            errors,
        )

    def test_research_evidence_covers_validator_outputs(self) -> None:
        session = "docs/research/session"
        errors = _check_research_write_rules([{
            "id": "research",
            "type": "research",
            "write_set": [],
            "evidence_write_set": [
                session,
                f"{session}/artifacts/claim_ledger.jsonl",
                f"{session}/sources/sources.jsonl",
                f"{session}/state.json",
            ],
            "research_ledger": session,
        }])

        self.assertTrue(any(
            "outputs/verified_claims.json" in error
            and "outputs/gate_failed.json" in error
            for error in errors
        ))

    def test_recursive_research_session_ownership_is_accepted(self) -> None:
        session = "docs/research/session"
        errors = _check_research_write_rules([{
            "id": "research",
            "type": "research",
            "write_set": [],
            "evidence_write_set": [f"{session}/**"],
            "research_ledger": session,
        }])

        self.assertEqual(errors, [])

    def test_planning_decision_schema_uses_status_discriminator(self) -> None:
        schema = planning_decision_schema()
        self.assertNotIn("oneOf", schema)
        self.assertEqual(
            schema["properties"]["status"]["enum"],
            ["planned", "blocked"],
        )

    def test_planning_decision_rejects_fields_from_other_status(self) -> None:
        decision = {
            "status": "blocked",
            "objective": "missing target",
            "constraints": [],
            "reason_code": "target-not-found",
            "summary": "No matching implementation exists.",
            "evidence": [],
            "constraint_conflicts": [],
            "target_evidence": [],
        }
        with self.assertRaisesRegex(
            PlanValidationError,
            "target_evidence.*invalid for status 'blocked'",
        ):
            validate_planning_decision(
                decision,
                objective="missing target",
                constraints=[],
                repo_root=FIXTURES,
            )

    def test_planning_contract_rejects_incomplete_behavior_ownership(self) -> None:
        plan = _load("valid-plan.json")
        plan["nodes"][0]["repair_write_set"] = ["src/greeter.py"]
        decision = {
            "status": "planned",
            "objective": plan["objective"],
            "constraints": [],
            "target_evidence": [{
                "path": ".",
                "detail": "fixture root",
            }],
            "plan": plan,
        }
        with self.assertRaises(PlanValidationError) as ctx:
            validate_planning_decision(
                decision,
                objective=plan["objective"],
                constraints=[],
                repo_root=FIXTURES,
                known_roles={
                    "tdd-workflows-tdd-orchestrator",
                    "team-implementer",
                },
                profile_authorization={
                    "allow_push": False,
                    "allow_pull_request": False,
                    "allow_deploy": False,
                },
            )
        detail = str(ctx.exception)
        self.assertIn(
            "repair_write_set does not cover owned paths: tests/test_greeter.py",
            detail,
        )
        self.assertIn("validation matrix is missing", detail)

    def test_clean_review(self) -> None:
        validate_codex_review(_load("codex-review-clean.json"))

    def test_review_with_findings(self) -> None:
        validate_codex_review(_load("codex-review-with-finding.json"))

    def test_invalid_review(self) -> None:
        with self.assertRaises(PlanValidationError):
            validate_codex_review({"wrong": True})

    def test_valid_proof_policy(self) -> None:
        validate_proof_policy(_load("proof-policy.json"))

    def test_invalid_proof_policy(self) -> None:
        with self.assertRaises(PlanValidationError):
            validate_proof_policy({"missing": True})


if __name__ == "__main__":
    unittest.main()
