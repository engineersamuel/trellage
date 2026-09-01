"""Fail-closed Graph of Loops controller."""
from __future__ import annotations

import fnmatch
import json
import multiprocessing
import os
import signal
import subprocess
import threading
import time
from pathlib import Path
from typing import Any, Callable

from .beads_repository import (
    BeadsError,
    BeadsRepository,
    RealSubprocessRunner,
    SubprocessRunner,
)
from .bernstein_facade import BernsteinError, BernsteinFacade
from .contracts import (
    PlanValidationError,
    content_digest,
    redact_sensitive,
    validate_node_envelope,
    validate_plan,
)
from .evidence import EvidenceLedger
from .gates import GateError, GateRunner
from .proof import ProofError, RaindropProofGate
from .review import CodexReviewGate, ReviewError
from .specialist import SpecialistError, SpecialistLauncher
from .waku_runtime import ExecutionCeilings, WakuNodeRuntime, WakuRuntimeError


class ControllerError(Exception):
    pass


class GraphController:
    def __init__(
        self,
        *,
        beads: BeadsRepository,
        bernstein: BernsteinFacade,
        waku: WakuNodeRuntime,
        review: CodexReviewGate,
        proof: RaindropProofGate,
        evidence: EvidenceLedger,
        policy: dict[str, Any] | None = None,
        runner: SubprocessRunner | None = None,
        run_dir: Path | None = None,
        repo_root: Path | None = None,
        specialist: SpecialistLauncher | None = None,
        gate_factory: Callable[..., GateRunner] = GateRunner,
    ) -> None:
        self._beads = beads
        self._bernstein = bernstein
        self._waku = waku
        self._review = review
        self._proof = proof
        self._evidence = evidence
        self._policy = policy or {}
        self._runner = runner or RealSubprocessRunner()
        self._run_dir = run_dir
        self._repo_root = (repo_root or Path.cwd()).resolve()
        self._specialist = specialist
        self._gate_factory = gate_factory
        self._plan: dict[str, Any] | None = None
        self._state: dict[str, Any] = {}
        self._run_id = ""
        self._state_lock = threading.RLock()

    @property
    def run_id(self) -> str:
        return self._run_id

    @property
    def _root_bead_id(self) -> str | None:
        value = self._state.get("root_bead_id")
        return str(value) if value else None

    @property
    def _node_states(self) -> dict[str, str]:
        return {
            node_id: str(node["status"])
            for node_id, node in self._state.get("nodes", {}).items()
        }

    @property
    def _node_beads(self) -> dict[str, str]:
        return {
            node_id: str(node["bead_id"])
            for node_id, node in self._state.get("nodes", {}).items()
        }

    def _persist(self, name: str, data: Any) -> None:
        if self._run_dir is None:
            raise ControllerError("run directory is not configured")
        destination = self._run_dir / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        temporary = destination.with_name(f".{destination.name}.tmp")
        payload = (
            data if isinstance(data, str)
            else json.dumps(data, indent=2, sort_keys=True) + "\n"
        )
        with open(temporary, "w", encoding="utf-8") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, destination)

    def _load_persisted(self, name: str) -> Any | None:
        if self._run_dir is None:
            return None
        path = self._run_dir / name
        if not path.is_file():
            return None
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise ControllerError(f"cannot load persisted {name}: {exc}") from exc

    def _persist_state(self) -> None:
        with self._state_lock:
            self._persist("state.json", self._state)

    def _restore_state(self) -> bool:
        state = self._load_persisted("state.json")
        if state is None:
            return False
        plan = self._load_persisted("plan.json")
        if not isinstance(state, dict) or not isinstance(plan, dict):
            raise ControllerError("persisted graph state is invalid")
        self._state = state
        self._plan = plan
        self._run_id = str(state["run_id"])
        expected = state.get("policy_digest")
        actual = content_digest(json.dumps(self._policy, sort_keys=True))
        if expected != actual:
            raise ControllerError("runtime policy changed since the run was created")
        for node in state.get("nodes", {}).values():
            if node.get("worktree") and node.get("session_id"):
                self._bernstein.restore_worktree(
                    str(node["session_id"]), str(node["worktree"])
                )
        return True

    def _ceilings_from_policy(self) -> dict[str, int]:
        limits = self._policy.get("limits")
        required = {
            "max_parallel_nodes",
            "max_node_iterations",
            "max_specialist_attempts",
            "max_gate_calls",
            "max_supervisor_tokens",
            "node_timeout_seconds",
        }
        if not isinstance(limits, dict) or not required.issubset(limits):
            raise ControllerError("runtime policy has incomplete execution limits")
        values = {
            "max_iterations": limits["max_node_iterations"],
            "max_specialist_attempts": limits["max_specialist_attempts"],
            "max_gate_calls": limits["max_gate_calls"],
            "max_supervisor_tokens": limits["max_supervisor_tokens"],
            "node_timeout_seconds": limits["node_timeout_seconds"],
        }
        all_values = [*values.values(), limits["max_parallel_nodes"]]
        if any(not isinstance(value, int) or value <= 0 for value in all_values):
            raise ControllerError("runtime policy has invalid execution limits")
        return values

    def _max_parallel_nodes(self) -> int:
        self._ceilings_from_policy()
        return int(self._policy["limits"]["max_parallel_nodes"])

    def _profile_authorization(self) -> dict[str, bool]:
        authorization = self._policy.get("authorization")
        expected = {
            "allow_push": False,
            "allow_pull_request": False,
            "allow_deploy": False,
        }
        if authorization != expected:
            raise ControllerError("runtime policy must deny all delivery actions")
        return expected

    def _known_roles(self) -> set[str]:
        roles = self._policy.get("roles")
        if not isinstance(roles, dict) or set(roles) != {
            "planner", "research", "implement", "tdd", "debug", "validate",
        }:
            raise ControllerError("runtime policy has an invalid role map")
        values = {str(value) for value in roles.values()}
        if len(values) != 6:
            raise ControllerError("runtime policy roles must be unique")
        return values

    def _validate_runtime_policy(self) -> None:
        if not isinstance(self._policy.get("gateway"), str):
            raise ControllerError("runtime policy has no model gateway")
        models = self._policy.get("models")
        if not isinstance(models, dict) or not all(
            isinstance(models.get(name), str)
            for name in ("supervisor", "specialist", "reviewer")
        ):
            raise ControllerError("runtime policy has an invalid model map")
        review = self._policy.get("review")
        if (
            not isinstance(review, dict)
            or review.get("kind") != "codex"
            or review.get("required") is not True
            or not isinstance(review.get("model"), str)
            or not isinstance(review.get("reasoning_effort"), str)
        ):
            raise ControllerError("runtime policy has an invalid review gate")
        proof = self._policy.get("proof")
        if (
            not isinstance(proof, dict)
            or proof.get("kind") != "raindrop"
            or proof.get("mode") != "repository-opt-in"
        ):
            raise ControllerError("runtime policy has an invalid proof gate")

    def accept_plan(
        self,
        plan: dict[str, Any],
        *,
        run_id: str,
        plan_generation: int = 1,
    ) -> str:
        self._validate_runtime_policy()
        validate_plan(
            plan,
            known_roles=self._known_roles(),
            profile_authorization=self._profile_authorization(),
        )
        self._ceilings_from_policy()
        self._plan = plan
        self._run_id = run_id
        if self._run_dir is None:
            self._run_dir = self._repo_root / ".sdd" / "graph-of-loops" / "runs" / run_id
        policy_digest = content_digest(json.dumps(self._policy, sort_keys=True))
        self._persist("plan.json", plan)
        self._beads.ensure_initialized()
        root = self._beads.ensure_issue(
            title=f"graph:{run_id}",
            metadata={
                "kind": "graph-of-loops",
                "run_id": run_id,
                "plan_generation": plan_generation,
                "objective_digest": content_digest(plan["objective"]),
                "base_revision": plan["base_revision"],
            },
            identity={
                "kind": "graph-of-loops",
                "run_id": run_id,
                "plan_generation": plan_generation,
            },
        )
        nodes: dict[str, dict[str, Any]] = {}
        for node in plan["nodes"]:
            bead = self._beads.ensure_issue(
                title=f"node:{node['id']}",
                metadata={
                    "kind": "graph-node",
                    "run_id": run_id,
                    "plan_generation": plan_generation,
                    "node_id": node["id"],
                    "type": node["type"],
                    "role": node["role"],
                },
                identity={
                    "kind": "graph-node",
                    "run_id": run_id,
                    "plan_generation": plan_generation,
                    "node_id": node["id"],
                },
                parent=root,
            )
            nodes[node["id"]] = {
                "bead_id": bead,
                "status": "pending",
                "session_id": f"gol-{run_id}-{node['id']}",
                "worktree": None,
                "branch": None,
                "commit": None,
                "integrated": False,
                "integration_pending": False,
                "gates_current": False,
                "review": "pending" if node.get("review_required", True) else "not-applicable",
                "proof": "pending" if node.get("proof_required", False) else "not-applicable",
                "findings": {},
                "repair_beads": [],
            }
        for node in plan["nodes"]:
            node_bead = nodes[node["id"]]["bead_id"]
            self._beads.ensure_dependency(
                blocked=root,
                blocker=node_bead,
            )
            for dependency in node["dependencies"]:
                self._beads.ensure_dependency(
                    blocked=node_bead,
                    blocker=nodes[dependency]["bead_id"],
                )
        self._state = {
            "schema": 1,
            "run_id": run_id,
            "plan_generation": plan_generation,
            "status": "accepted",
            "root_bead_id": root,
            "base_revision": plan["base_revision"],
            "target_revision": plan["base_revision"],
            "policy_digest": policy_digest,
            "nodes": nodes,
            "graph_gates": "pending",
            "graph_review": "pending",
            "graph_proof": "pending",
        }
        for node in plan["nodes"]:
            envelope = self._build_envelope(node)
            validate_node_envelope(envelope)
            self._persist(f"envelopes/{node['id']}.json", envelope)
        self._persist_state()
        self._evidence.record_transition(
            node_id="root",
            from_state="none",
            to_state="accepted",
            actor="controller",
        )
        return root

    def prepare_replan(self, run_id: str) -> int:
        if self._run_id != run_id:
            raise ControllerError(f"run ID mismatch: {run_id}")
        blockers = self._replan_blockers()
        if blockers:
            raise ControllerError(
                "accepted graph cannot be replanned: "
                + "; ".join(blockers)
            )
        for state in self._state.get("nodes", {}).values():
            self._supersede_node_for_replan(state, run_id)
        self._supersede_root_for_replan(run_id)
        generation = int(self._state.get("plan_generation", 1))
        self._state["status"] = "superseded"
        self._persist_state()
        return generation

    def _replan_blockers(self) -> list[str]:
        blockers: list[str] = []
        for node_id, state in self._state.get("nodes", {}).items():
            if state.get("integrated"):
                blockers.append(f"node '{node_id}' is integrated")
            if state.get("commit"):
                blockers.append(f"node '{node_id}' has a commit")
            worktree = state.get("worktree")
            if isinstance(worktree, str) and Path(worktree).is_dir():
                if self._changed_files(worktree):
                    blockers.append(f"node '{node_id}' worktree is dirty")
                base = str(state.get("worktree_base") or self._state["base_revision"])
                if self._committed_changed_files(worktree, base):
                    blockers.append(
                        f"node '{node_id}' worktree has committed changes"
                    )
        return blockers

    def _supersede_node_for_replan(
        self, state: dict[str, Any], run_id: str,
    ) -> None:
        if state.get("worktree"):
            self._bernstein.cleanup_worktree(state["session_id"])
            state["worktree"] = None
        issue = self._beads.show(state["bead_id"])
        if issue.get("status") != "closed":
            self._beads.close(
                state["bead_id"],
                reason=f"superseded by replan of {run_id}",
            )
        state["status"] = "superseded"

    def _supersede_root_for_replan(self, run_id: str) -> None:
        if self._root_bead_id is not None:
            root = self._beads.show(self._root_bead_id)
            if root.get("status") != "closed":
                self._beads.close(
                    self._root_bead_id,
                    reason=f"superseded by replan of {run_id}",
                )

    def compute_ready_waves(self) -> list[list[str]]:
        if self._plan is None:
            raise ControllerError("no plan accepted")
        self._bernstein.build_dag(self._plan["nodes"])
        return self._bernstein.ready_waves()

    def _build_envelope(self, node: dict[str, Any]) -> dict[str, Any]:
        if self._plan is None or self._root_bead_id is None:
            raise ControllerError("no accepted plan")
        node_state = self._state["nodes"][node["id"]]
        revisions = {
            dependency: self._state["nodes"][dependency].get("commit") or ""
            for dependency in node["dependencies"]
        }
        review = self._policy.get("review", {})
        proof = self._policy.get("proof", {})
        review_policy: dict[str, Any] = {
            "required": bool(node.get("review_required", True)),
        }
        if isinstance(review.get("model"), str):
            review_policy["model"] = review["model"]
        if isinstance(review.get("reasoning_effort"), str):
            review_policy["reasoning_effort"] = review["reasoning_effort"]
        envelope = {
            "run_id": self._run_id,
            "plan_generation": int(self._state.get("plan_generation", 1)),
            "root_bead_id": self._root_bead_id,
            "node_bead_id": node_state["bead_id"],
            "node_id": node["id"],
            "node_type": node["type"],
            "role": node["role"],
            "prompt": node["prompt"],
            "behavior_change": node["behavior_change"],
            "phase": "research" if node["type"] == "research" else "implement",
            "base_revision": self._plan["base_revision"],
            "dependency_revisions": revisions,
            "read_set": node["read_set"],
            "test_write_set": node.get("test_write_set", []),
            "evidence_write_set": node.get("evidence_write_set", []),
            "write_set": node["write_set"],
            "repair_write_set": node.get("repair_write_set", []),
            "gates": node["gates"],
            "review_policy": review_policy,
            "proof_policy": {
                "required": bool(node.get("proof_required", False)),
                "mode": proof.get("mode", "repository-opt-in"),
            },
            "authorization": self._profile_authorization(),
            "execution_ceilings": self._ceilings_from_policy(),
        }
        if node.get("research_ledger"):
            envelope["research_ledger"] = node["research_ledger"]
        if self._state["nodes"][node["id"]].get("last_failure"):
            envelope["repair_mode"] = True
        return envelope

    def execute_node(
        self,
        node_id: str,
        *,
        specialist_launcher: Any,
        gate_runner_fn: Any,
        waku_runtime: WakuNodeRuntime | None = None,
    ) -> dict[str, Any]:
        node = self._node(node_id)
        envelope = self._build_envelope(node)
        self._set_node_status(node_id, "running")
        try:
            self._beads.update_status(
                self._state["nodes"][node_id]["bead_id"], status="in_progress"
            )
            session_id = self._state["nodes"][node_id]["session_id"]
            existing_worktree = self._state["nodes"][node_id].get("worktree")
            worktree = (
                Path(existing_worktree)
                if isinstance(existing_worktree, str) and Path(existing_worktree).is_dir()
                else self._bernstein.create_worktree(session_id)
            )
            self._state["nodes"][node_id]["worktree"] = str(worktree)
            self._state["nodes"][node_id]["branch"] = f"agent/{session_id}"
            self._state["nodes"][node_id]["worktree_base"] = self._git(
                ["merge-base", "HEAD", self._target_branch()],
                cwd=worktree,
            ).stdout.strip()
            self._persist_state()
            result = (waku_runtime or self._waku).run_node(
                envelope=envelope,
                specialist_launcher=specialist_launcher,
                gate_runner_fn=gate_runner_fn,
                ceilings=ExecutionCeilings(**envelope["execution_ceilings"]),
            )
            self._set_node_status(node_id, "verified")
            return result
        except BeadsError as exc:
            raise ControllerError(f"Beads state transition failed: {exc}") from exc
        except (BernsteinError, WakuRuntimeError) as exc:
            raise ControllerError(f"node {node_id} failed: {exc}") from exc

    def run(self) -> dict[str, Any]:
        self._verify_run_base()
        self._state["status"] = "running"
        self._persist_state()
        for wave in self.compute_ready_waves():
            self._run_wave(wave)
        try:
            self._run_graph_gates()
            self._run_graph_review()
            self._run_graph_proof()
            self._close_graph_repairs()
        except (GateError, ProofError, ReviewError, ControllerError) as exc:
            self._fail_graph(str(exc), findings=getattr(exc, "findings", None))
            raise ControllerError(f"graph verification failed: {exc}") from exc
        return self.close_root()

    def _run_wave(self, wave: list[str]) -> None:
        pending: list[str] = []
        for node_id in wave:
            state = self._state["nodes"][node_id]
            if state["integrated"]:
                self._finish_integrated_node(node_id)
            elif state.get("integration_pending"):
                self._complete_pending_integration(node_id)
            else:
                pending.append(node_id)
        if len(pending) > 1 and self._max_parallel_nodes() > 1:
            self._prepare_nodes_parallel(pending)
        else:
            for node_id in pending:
                self._prepare_node(node_id)
        for node_id in pending:
            self._integrate_prepared_node(node_id)

    def _prepare_nodes_parallel(self, node_ids: list[str]) -> None:
        limit = self._max_parallel_nodes()
        for offset in range(0, len(node_ids), limit):
            self._prepare_node_batch(node_ids[offset:offset + limit])

    def _prepare_node_batch(self, node_ids: list[str]) -> None:
        initialized: dict[str, dict[str, Any]] = {}
        for node_id in node_ids:
            try:
                initialized[node_id] = self._initialize_parallel_node(node_id)
            except (BeadsError, BernsteinError, ControllerError) as exc:
                self._fail_node(node_id, str(exc))
                raise ControllerError(f"node {node_id} failed: {exc}") from exc
        context = multiprocessing.get_context("fork")
        workers: dict[str, tuple[Any, Any, float]] = {}
        for node_id, envelope in initialized.items():
            receive, send = context.Pipe(duplex=False)
            process = context.Process(
                target=self._parallel_node_worker,
                args=(node_id, envelope, send),
            )
            process.start()
            send.close()
            workers[node_id] = (process, receive, time.monotonic())
        failures = self._wait_for_node_workers(workers)
        if failures:
            for node_id, failure in failures.items():
                self._fail_node(node_id, failure)
            first = next(iter(failures))
            raise ControllerError(f"node {first} failed: {failures[first]}")
        for node_id in node_ids:
            self._finalize_parallel_node(node_id)

    def _wait_for_node_workers(
        self,
        workers: dict[str, tuple[Any, Any, float]],
    ) -> dict[str, str]:
        timeout = self._ceilings_from_policy()["node_timeout_seconds"]
        failures: dict[str, str] = {}
        alive = set(workers)
        while alive:
            for node_id in list(alive):
                process, _receive, started = workers[node_id]
                if not process.is_alive():
                    process.join()
                    alive.remove(node_id)
                elif time.monotonic() - started > timeout:
                    self._terminate_node_worker(process)
                    failures[node_id] = f"node timed out after {timeout}s"
                    alive.remove(node_id)
            if alive:
                time.sleep(0.02)
        self._collect_worker_results(workers, failures)
        return failures

    @staticmethod
    def _terminate_node_worker(process: Any) -> None:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        process.join(timeout=0.5)
        if process.is_alive():
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.join(timeout=0.5)
        if process.is_alive():
            raise ControllerError("node worker did not terminate")

    @staticmethod
    def _collect_worker_results(
        workers: dict[str, tuple[Any, Any, float]],
        failures: dict[str, str],
    ) -> None:
        for node_id, (process, receive, _started) in workers.items():
            if node_id not in failures:
                if receive.poll():
                    result = receive.recv()
                    if not result.get("ok"):
                        failures[node_id] = str(result.get("error") or "worker failed")
                elif process.exitcode != 0:
                    failures[node_id] = (
                        f"node worker exited with {process.exitcode}"
                    )
                else:
                    failures[node_id] = "node worker returned no result"
            receive.close()

    def _initialize_parallel_node(self, node_id: str) -> dict[str, Any]:
        node = self._node(node_id)
        envelope = self._build_envelope(node)
        state = self._state["nodes"][node_id]
        self._set_node_status(node_id, "running")
        self._beads.update_status(state["bead_id"], status="in_progress")
        session_id = state["session_id"]
        existing = state.get("worktree")
        worktree = (
            Path(existing)
            if isinstance(existing, str) and Path(existing).is_dir()
            else self._bernstein.create_worktree(session_id)
        )
        state["worktree"] = str(worktree)
        state["branch"] = f"agent/{session_id}"
        state["worktree_base"] = self._git(
            ["merge-base", "HEAD", self._target_branch()],
            cwd=worktree,
        ).stdout.strip()
        self._persist_state()
        return envelope

    def _parallel_node_worker(
        self,
        node_id: str,
        envelope: dict[str, Any],
        connection: Any,
    ) -> None:
        os.setsid()
        node = self._node(node_id)
        state = self._state["nodes"][node_id]
        gate_runner = self._gate_factory(
            runner=self._runner,
            timeout_seconds=min(
                self._ceilings_from_policy()["node_timeout_seconds"],
                900,
            ),
        )
        try:
            self._waku.fork().run_node(
                envelope=envelope,
                specialist_launcher=self._specialist_callback(node, state),
                gate_runner_fn=self._gate_callback(node, state, gate_runner),
                ceilings=ExecutionCeilings(**envelope["execution_ceilings"]),
            )
            connection.send({"ok": True})
        except (
            GateError,
            SpecialistError,
            WakuRuntimeError,
            subprocess.CalledProcessError,
        ) as exc:
            connection.send({"ok": False, "error": str(exc)})
        finally:
            connection.close()

    def _finalize_parallel_node(self, node_id: str) -> None:
        node = self._node(node_id)
        state = self._state["nodes"][node_id]
        worktree = str(state["worktree"])
        try:
            self._set_node_status(node_id, "verified")
            self._validate_research(node, worktree)
            self._validate_changed_paths(node, state, worktree)
            self._commit_node(node, state, worktree)
            state["execution_prepared"] = True
            self._persist_state()
        except (
            BeadsError,
            BernsteinError,
            ControllerError,
            GateError,
            subprocess.CalledProcessError,
        ) as exc:
            self._fail_node(node_id, str(exc))
            raise ControllerError(f"node {node_id} failed: {exc}") from exc

    def _execute_and_integrate(self, node_id: str) -> None:
        state = self._state["nodes"][node_id]
        if state.get("integration_pending"):
            self._complete_pending_integration(node_id)
            return
        self._prepare_node(node_id)
        self._integrate_prepared_node(node_id)

    def _prepare_node(self, node_id: str) -> None:
        node = self._node(node_id)
        state = self._state["nodes"][node_id]
        if state.get("execution_prepared"):
            return
        if self._specialist is None:
            raise ControllerError("specialist launcher is not configured")
        gate_runner = self._gate_factory(
            runner=self._runner,
            timeout_seconds=min(self._ceilings_from_policy()["node_timeout_seconds"], 900),
        )
        try:
            self.execute_node(
                node_id,
                specialist_launcher=self._specialist_callback(node, state),
                gate_runner_fn=self._gate_callback(node, state, gate_runner),
                waku_runtime=self._waku.fork(),
            )
            worktree = str(state["worktree"])
            self._validate_research(node, worktree)
            self._validate_changed_paths(node, state, worktree)
            self._commit_node(node, state, worktree)
            state["execution_prepared"] = True
            self._persist_state()
        except (
            BeadsError,
            BernsteinError,
            ControllerError,
            GateError,
            ProofError,
            ReviewError,
            SpecialistError,
            subprocess.CalledProcessError,
        ) as exc:
            state["execution_prepared"] = False
            self._fail_node(node_id, str(exc), findings=getattr(exc, "findings", None))
            raise ControllerError(f"node {node_id} failed: {exc}") from exc

    @staticmethod
    def _integration_failure_requires_repair(exc: Exception) -> bool:
        return isinstance(exc, (GateError, ProofError, ReviewError)) or (
            isinstance(exc, ControllerError)
            and "conflict" in str(exc).lower()
        )

    def _repair_prepared_node(
        self,
        node: dict[str, Any],
        state: dict[str, Any],
    ) -> None:
        if self._specialist is None:
            raise ControllerError("specialist launcher is not configured")
        self._specialist_callback(node, state)(
            phase="repair",
            role=node["role"],
        )
        worktree = str(state["worktree"])
        self._validate_changed_paths(node, state, worktree)
        self._commit_node(node, state, worktree)
        state["repair_required"] = False
        state["execution_prepared"] = True
        self._persist_state()

    def _integrate_prepared_node(self, node_id: str) -> None:
        node = self._node(node_id)
        state = self._state["nodes"][node_id]
        if not state.get("execution_prepared"):
            raise ControllerError(f"node {node_id} is not prepared for integration")
        if state.get("repair_required"):
            self._repair_prepared_node(node, state)
        gate_runner = self._gate_factory(
            runner=self._runner,
            timeout_seconds=min(self._ceilings_from_policy()["node_timeout_seconds"], 900),
        )
        try:
            worktree = str(state["worktree"])
            target_revision = self._git(
                ["rev-parse", "HEAD"], cwd=self._repo_root
            ).stdout.strip()
            self._rebase_node(node_id, worktree)
            self._rerun_final_gates(node, worktree, gate_runner)
            state["gates_current"] = True
            self._run_node_review(node, state, worktree, target_revision)
            self._run_node_proof(node, state, worktree)
            state["integration_pending"] = True
            self._persist_state()
            self._fast_forward_node(node_id)
            self._complete_pending_integration(node_id, already_integrated=True)
        except (
            BeadsError,
            BernsteinError,
            ControllerError,
            GateError,
            ProofError,
            ReviewError,
            SpecialistError,
            subprocess.CalledProcessError,
        ) as exc:
            state["repair_required"] = self._integration_failure_requires_repair(
                exc
            )
            self._fail_node(node_id, str(exc), findings=getattr(exc, "findings", None))
            raise ControllerError(f"node {node_id} failed: {exc}") from exc

    def _complete_pending_integration(
        self, node_id: str, *, already_integrated: bool = False,
    ) -> None:
        state = self._state["nodes"][node_id]
        if not already_integrated:
            self._fast_forward_node(node_id)
        state["integrated"] = True
        state["integration_pending"] = False
        self._state["target_revision"] = state["commit"]
        self._persist_state()
        self._finish_integrated_node(node_id)

    def _finish_integrated_node(self, node_id: str) -> None:
        state = self._state["nodes"][node_id]
        if state.get("worktree"):
            self._bernstein.cleanup_worktree(state["session_id"])
            state["worktree"] = None
        self._close_repairs(state, reason=f"node {node_id} passed after repair")
        if state["status"] != "closed":
            old = state["status"]
            self._beads.close(
                state["bead_id"],
                reason=f"node {node_id} integrated and verified",
            )
            state["status"] = "closed"
            self._evidence.record_transition(
                node_id=node_id,
                from_state=old,
                to_state="closed",
                actor="controller",
            )
        self._persist_state()

    def _close_repairs(self, state: dict[str, Any], *, reason: str) -> None:
        for repair in state.get("repair_beads", []):
            try:
                issue = self._beads.show(repair)
            except BeadsError:
                raise
            if issue.get("status") != "closed":
                self._beads.close(repair, reason=reason)

    def _specialist_callback(
        self, node: dict[str, Any], state: dict[str, Any],
    ) -> Callable[..., dict[str, Any]]:
        def launch(*, phase: str, role: str) -> dict[str, Any]:
            worktree = str(state["worktree"])
            prompt = (
                f"Node {node['id']} phase {phase}.\n{node['prompt']}\n"
                f"Allowed writes: {json.dumps(self._allowed_patterns(node, phase))}\n"
                "Use Serena symbol/reference discovery before ordinary text search. "
                "If Serena fails or the language is unsupported, include "
                "TRELLAGE_SERENA_FALLBACK:<exact reason> in the final result."
            )
            if phase == "red":
                prompt += (
                    "\nRED PHASE: write only tests in the allowed test paths. "
                    "Do not add, expose, stub, or edit implementation code. "
                    "Run no gate yourself; the controller must observe the "
                    "declared red gate fail."
                )
            if node["type"] == "research":
                prompt += (
                    f"\nResearch session directory: {node['research_ledger']}. "
                    "Write its artifacts/claim_ledger.jsonl and sources/sources.jsonl "
                    "exactly as required by the role contract."
                )
            if phase == "repair" and state.get("last_failure"):
                prompt += f"\nRepair this verified failure:\n{state['last_failure']}"
            result = self._specialist.launch(
                role=role,
                prompt=prompt,
                worktree_path=worktree,
                expected_worktree=worktree,
                config_dir=str(self._run_dir / "claude" / node["id"] / phase),
                authorized_roles={node["role"]},
                allowed_tools=["Read", "Edit", "Write", "Glob", "Grep", "Bash", "mcp__serena__*"],
                disallowed_tools=[
                    "Bash(git push:*)",
                    "Bash(git commit:*)",
                    "Bash(gh pr:*)",
                    "Bash(bd:*)",
                    "Bash(raindrop:*)",
                ],
                timeout=self._ceilings_from_policy()["node_timeout_seconds"],
            )
            if node["type"] != "research" and not (
                result["serena_success"] or result["serena_fallback"]
            ):
                raise SpecialistError("Serena discovery or explicit fallback evidence is missing")
            self._evidence.record_tool_call(
                node_id=node["id"],
                tool=f"specialist:{role}:{phase}",
                status="ok",
                content_digest=result["output_digest"],
            )
            return result

        return launch

    def _gate_callback(
        self,
        node: dict[str, Any],
        state: dict[str, Any],
        gate_runner: GateRunner,
    ) -> Callable[..., dict[str, Any]]:
        def run_gate(*, gate: dict[str, Any]) -> dict[str, Any]:
            worktree = str(state["worktree"])
            if gate.get("phase") == "red":
                changed = self._changed_files(worktree)
                gate_runner.validate_tdd_write_set(
                    changed_files=changed,
                    test_write_set=node.get("test_write_set", []),
                    phase="red",
                )
            result = gate_runner.run_gate(
                name=gate["name"],
                argv=gate["argv"],
                phase=gate.get("phase", "final"),
                cwd=worktree,
                node_id=node["id"],
            )
            self._evidence.record_gate_result(
                node_id=node["id"],
                gate_name=gate["name"],
                phase=result["phase"],
                passed=True,
                output_digest=result["output_digest"],
                argv=gate["argv"],
            )
            return result

        return run_gate

    def _validate_research(self, node: dict[str, Any], worktree: str) -> None:
        if node["type"] != "research":
            return
        session = Path(worktree) / node["research_ledger"]
        ledger = session / "artifacts" / "claim_ledger.jsonl"
        sources = session / "sources" / "sources.jsonl"
        if not ledger.is_file():
            raise ControllerError(f"research claim ledger is missing: {ledger}")
        if not sources.is_file():
            raise ControllerError(f"research source registry is missing: {sources}")
        state = session / "state.json"
        if not state.exists():
            state.write_text("{}\n", encoding="utf-8")
        matches = list(
            Path("/usr/local/share/trellage/claude-seed").glob(
                "plugins/cache/**/skills/insane-research-main/scripts/validate_ledger.py"
            )
        )
        if len(matches) != 1:
            raise ControllerError(
                f"Insane Research ledger validator must resolve once; found {len(matches)}"
            )
        self._runner.run(
            ["python3", str(matches[0]), "--session", str(session)],
            cwd=worktree,
            capture_output=True,
            text=True,
            check=True,
            timeout=120,
        )
        destination = self._run_dir / "research" / node["id"]
        for relative in (
            Path("artifacts/claim_ledger.jsonl"),
            Path("sources/sources.jsonl"),
            Path("outputs/verified_claims.json"),
            Path("outputs/unresolved_claims.json"),
            Path("outputs/refuted_claims.json"),
            Path("state.json"),
        ):
            source = session / relative
            if source.is_file():
                target = destination / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(source.read_bytes())

    def _allowed_patterns(self, node: dict[str, Any], phase: str = "") -> list[str]:
        if phase == "red":
            return list(node.get("test_write_set", []))
        return [
            *node.get("write_set", []),
            *node.get("repair_write_set", []),
            *node.get("test_write_set", []),
            *node.get("evidence_write_set", []),
        ]

    def _validate_changed_paths(
        self,
        node: dict[str, Any],
        state: dict[str, Any],
        worktree: str,
    ) -> None:
        base = state.get("worktree_base")
        if not isinstance(base, str) or not base:
            raise ControllerError(
                f"node {node['id']} has no recorded worktree base"
            )
        changed = sorted({
            *self._changed_files(worktree),
            *self._committed_changed_files(worktree, base),
        })
        allowed = self._allowed_patterns(node)
        unauthorized = [
            path for path in changed
            if not any(fnmatch.fnmatch(path, pattern) for pattern in allowed)
        ]
        if unauthorized:
            raise ControllerError(
                f"node {node['id']} changed unauthorized paths: {', '.join(unauthorized)}"
            )

    def _committed_changed_files(
        self,
        worktree: str,
        base_revision: str,
    ) -> list[str]:
        result = self._git(
            [
                "diff",
                "--name-status",
                "-z",
                "--find-renames",
                base_revision,
                "HEAD",
            ],
            cwd=Path(worktree),
        )
        entries = result.stdout.split("\0")
        paths: list[str] = []
        index = 0
        while index < len(entries):
            status = entries[index]
            index += 1
            if not status or index >= len(entries):
                continue
            paths.append(entries[index])
            index += 1
            if status.startswith(("R", "C")) and index < len(entries):
                if entries[index]:
                    paths.append(entries[index])
                index += 1
        return sorted(set(paths))

    def _changed_files(self, worktree: str) -> list[str]:
        result = self._git(
            ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
            cwd=Path(worktree),
        )
        entries = result.stdout.split("\0")
        paths: list[str] = []
        index = 0
        while index < len(entries):
            entry = entries[index]
            index += 1
            if len(entry) < 4:
                continue
            paths.append(entry[3:])
            if entry[0] in ("R", "C") and index < len(entries):
                if entries[index]:
                    paths.append(entries[index])
                index += 1
        return sorted(set(paths))

    def _commit_node(
        self, node: dict[str, Any], state: dict[str, Any], worktree: str,
    ) -> None:
        if node["type"] == "research":
            state["commit"] = self._git(["rev-parse", "HEAD"], cwd=Path(worktree)).stdout.strip()
            return
        if not self._changed_files(worktree):
            if node["type"] in ("implement", "tdd", "debug"):
                raise ControllerError(f"node {node['id']} produced no changes")
            state["commit"] = self._git(["rev-parse", "HEAD"], cwd=Path(worktree)).stdout.strip()
            return
        self._git(["add", "-A"], cwd=Path(worktree))
        self._runner.run(
            ["git", "commit", "--no-verify", "-m", f"Graph node {node['id']}"],
            cwd=worktree,
            capture_output=True,
            text=True,
            check=True,
            timeout=120,
        )
        state["commit"] = self._git(["rev-parse", "HEAD"], cwd=Path(worktree)).stdout.strip()

    def _rebase_node(self, node_id: str, worktree: str) -> None:
        try:
            self._runner.run(
                ["git", "rebase", self._target_branch()],
                cwd=worktree,
                capture_output=True,
                text=True,
                check=True,
                timeout=300,
            )
        except subprocess.CalledProcessError as exc:
            self._runner.run(
                ["git", "rebase", "--abort"],
                cwd=worktree,
                capture_output=True,
                text=True,
                check=False,
                timeout=30,
            )
            raise ControllerError(f"rebase failed for node {node_id}: {exc.stderr}") from exc
        self._state["nodes"][node_id]["commit"] = self._git(
            ["rev-parse", "HEAD"], cwd=Path(worktree)
        ).stdout.strip()

    def _rerun_final_gates(
        self, node: dict[str, Any], worktree: str, gate_runner: GateRunner,
    ) -> None:
        for gate in node["gates"]:
            if gate.get("phase", "final") != "final":
                continue
            result = gate_runner.run_gate(
                name=gate["name"],
                argv=gate["argv"],
                phase="final",
                cwd=worktree,
                node_id=node["id"],
            )
            self._evidence.record_gate_result(
                node_id=node["id"],
                gate_name=gate["name"],
                phase="post-rebase-final",
                passed=True,
                output_digest=result["output_digest"],
                argv=gate["argv"],
            )

    def _run_node_review(
        self,
        node: dict[str, Any],
        state: dict[str, Any],
        worktree: str,
        target_revision: str,
    ) -> None:
        if not node.get("review_required", True):
            state["review"] = "not-applicable"
            return
        review_policy = self._policy.get("review")
        if not isinstance(review_policy, dict) or review_policy.get("required") is not True:
            raise ControllerError("runtime review policy is invalid")
        result = self._review.review(
            node_id=node["id"],
            worktree_path=worktree,
            base_revision=target_revision,
            model=str(review_policy["model"]),
            reasoning_effort=str(review_policy["reasoning_effort"]),
            output_dir=self._run_dir / "reviews",
        )
        state["review"] = "passed"
        self._resolve_fixed_findings(node["id"], state, result["summary"])
        self._evidence.record_review(
            node_id=node["id"], finding_count=0, passed=True, detail=result["summary"]
        )

    def _run_node_proof(
        self, node: dict[str, Any], state: dict[str, Any], worktree: str,
    ) -> None:
        proof_path = self._repo_root / ".trellage" / "graph-of-loops-proof.json"
        result = self._proof.run_proof(
            node_id=node["id"],
            repo_root=worktree,
            proof_policy_path=str(proof_path) if proof_path.is_file() else None,
            proof_required=bool(node.get("proof_required", False)),
        )
        state["proof"] = result["status"]
        self._evidence.record_proof(
            node_id=node["id"], status=result["status"], detail=result.get("reason", "")
        )

    def _fast_forward_node(self, node_id: str) -> None:
        state = self._state["nodes"][node_id]
        if not isinstance(state.get("branch"), str) or not state["branch"]:
            raise ControllerError(f"node {node_id} has no Bernstein branch")
        try:
            self._runner.run(
                ["git", "merge", "--ff-only", state["branch"]],
                cwd=str(self._repo_root),
                capture_output=True,
                text=True,
                check=True,
                timeout=300,
            )
        except subprocess.CalledProcessError as exc:
            raise ControllerError(f"fast-forward failed for {node_id}: {exc.stderr}") from exc
        commit = self._git(["rev-parse", "HEAD"], cwd=self._repo_root).stdout.strip()
        if commit != state["commit"]:
            raise ControllerError(f"fast-forward integrated the wrong commit for {node_id}")
        self._evidence.record_integration(
            node_id=node_id, method="fast-forward", commit=commit, passed=True
        )

    def integrate_node(
        self,
        node_id: str,
        *,
        target_branch: str = "",
        node_branch: str = "",
        cwd: str | None = None,
    ) -> dict[str, Any]:
        del target_branch
        state = self._state["nodes"][node_id]
        if node_branch:
            state["branch"] = node_branch
        if cwd:
            state["worktree"] = cwd
        self._rebase_node(node_id, str(state.get("worktree") or cwd or self._repo_root))
        self._fast_forward_node(node_id)
        return {"status": "ok", "node_id": node_id, "method": "fast-forward"}

    def _run_graph_gates(self) -> None:
        gate_runner = self._gate_factory(runner=self._runner)
        for gate in self._plan.get("graph_gates", []):
            result = gate_runner.run_gate(
                name=gate["name"],
                argv=gate["argv"],
                phase="final",
                cwd=str(self._repo_root),
                node_id="graph",
            )
            self._evidence.record_gate_result(
                node_id="graph",
                gate_name=gate["name"],
                phase="final",
                passed=True,
                output_digest=result["output_digest"],
                argv=gate["argv"],
            )
        self._state["graph_gates"] = "passed"
        self._persist_state()

    def _run_graph_review(self) -> None:
        review_policy = self._policy["review"]
        try:
            result = self._review.review(
                node_id="graph",
                worktree_path=str(self._repo_root),
                base_revision=self._state["base_revision"],
                model=review_policy["model"],
                reasoning_effort=review_policy["reasoning_effort"],
                output_dir=self._run_dir / "reviews",
            )
        except ReviewError as exc:
            self._state["graph_review"] = "blocked"
            self._persist_state()
            raise
        self._state["graph_review"] = "passed"
        self._resolve_finding_set(
            "graph",
            self._state.setdefault("graph_findings", {}),
            result["summary"],
        )
        self._evidence.record_review(
            node_id="graph", finding_count=0, passed=True, detail=result["summary"]
        )
        self._persist_state()

    def _run_graph_proof(self) -> None:
        proof_path = self._repo_root / ".trellage" / "graph-of-loops-proof.json"
        result = self._proof.run_proof(
            node_id="graph",
            repo_root=str(self._repo_root),
            proof_policy_path=str(proof_path) if proof_path.is_file() else None,
            proof_required=False,
        )
        self._state["graph_proof"] = result["status"]
        self._evidence.record_proof(
            node_id="graph", status=result["status"], detail=result.get("reason", "")
        )
        self._persist_state()

    def can_close_root(self) -> tuple[bool, list[str]]:
        blockers: list[str] = []
        for node_id, node in self._state.get("nodes", {}).items():
            blockers.extend(self._node_close_blockers(node_id, node))
        blockers.extend(self._graph_close_blockers())
        return not blockers, blockers

    @staticmethod
    def _node_close_blockers(
        node_id: str, node: dict[str, Any],
    ) -> list[str]:
        checks = [
            (node["status"] != "closed", f"node '{node_id}' is {node['status']}"),
            (not node["integrated"], f"node '{node_id}' is not integrated"),
            (not node["gates_current"], f"node '{node_id}' gates are not current"),
            (
                node["review"] not in ("passed", "not-applicable"),
                f"node '{node_id}' review is {node['review']}",
            ),
            (
                node["proof"] not in ("passed", "not-applicable"),
                f"node '{node_id}' proof is {node['proof']}",
            ),
            (bool(node.get("worktree")), f"node '{node_id}' worktree is still active"),
            (
                any(
                    finding.get("status") == "open"
                    for finding in node.get("findings", {}).values()
                ),
                f"node '{node_id}' has unresolved findings",
            ),
        ]
        return [message for blocked, message in checks if blocked]

    def _graph_close_blockers(self) -> list[str]:
        checks = [
            (
                self._state.get("graph_gates") != "passed",
                "graph gates are not current",
            ),
            (
                self._state.get("graph_review") != "passed",
                "graph review is not passed",
            ),
            (
                self._state.get("graph_proof") not in ("passed", "not-applicable"),
                "graph proof is unresolved",
            ),
            (
                any(
                    finding.get("status") == "open"
                    for finding in self._state.get(
                        "graph_findings", {}
                    ).values()
                ),
                "graph has unresolved findings",
            ),
        ]
        return [message for blocked, message in checks if blocked]

    def close_root(self) -> dict[str, Any]:
        can_close, blockers = self.can_close_root()
        if not can_close:
            raise ControllerError(f"cannot close root: {'; '.join(blockers)}")
        if self._root_bead_id is None:
            raise ControllerError("root Bead is missing")
        self._beads.close(
            self._root_bead_id, reason=f"graph {self._run_id} completed"
        )
        self._state["status"] = "closed"
        self._persist_state()
        self._evidence.record_transition(
            node_id="root",
            from_state="running",
            to_state="closed",
            actor="controller",
        )
        return {"status": "closed", "run_id": self._run_id}

    def _set_node_status(self, node_id: str, status: str) -> None:
        old = self._state["nodes"][node_id]["status"]
        self._state["nodes"][node_id]["status"] = status
        self._persist_state()
        self._evidence.record_transition(
            node_id=node_id,
            from_state=old,
            to_state=status,
            actor="controller",
        )

    def _fail_node(
        self,
        node_id: str,
        reason: str,
        *,
        findings: list[dict[str, Any]] | None = None,
    ) -> None:
        node_state = self._state["nodes"][node_id]
        old = node_state["status"]
        node_state["status"] = "reopened"
        node_state["gates_current"] = False
        node_state["last_failure"] = redact_sensitive(reason)
        repair = self._beads.create(
            title=f"repair:{node_id}",
            metadata={
                "kind": "graph-repair",
                "run_id": self._run_id,
                "node_id": node_id,
                "reason_digest": content_digest(reason),
            },
            parent=self._root_bead_id,
        )
        node_state["repair_beads"].append(repair)
        if findings:
            self._record_findings(node_id, findings, repair_bead_id=repair)
        self._beads.add_dependency(blocked=node_state["bead_id"], blocker=repair)
        self._beads.reopen_or_open(node_state["bead_id"], reason=reason)
        if self._root_bead_id:
            self._beads.reopen_or_open(self._root_bead_id, reason=reason)
        self._state["status"] = "blocked"
        self._persist_state()
        self._evidence.record_transition(
            node_id=node_id,
            from_state=old,
            to_state="reopened",
            actor="controller",
            detail=reason,
        )

    def _fail_graph(
        self,
        reason: str,
        *,
        findings: list[dict[str, Any]] | None = None,
    ) -> None:
        repair = self._beads.create(
            title="repair:graph",
            metadata={
                "kind": "graph-repair",
                "run_id": self._run_id,
                "node_id": "graph",
                "reason_digest": content_digest(reason),
            },
            parent=self._root_bead_id,
        )
        self._state.setdefault("graph_repair_beads", []).append(repair)
        if self._root_bead_id:
            self._beads.add_dependency(blocked=self._root_bead_id, blocker=repair)
            self._beads.reopen_or_open(self._root_bead_id, reason=reason)
        if findings:
            self._record_findings("graph", findings, repair_bead_id=repair)
        self._state["status"] = "blocked"
        self._persist_state()
        self._evidence.record_transition(
            node_id="root",
            from_state="running",
            to_state="reopened",
            actor="controller",
            detail=reason,
        )

    def _close_graph_repairs(self) -> None:
        repairs = self._state.get("graph_repair_beads", [])
        for repair in repairs:
            issue = self._beads.show(repair)
            if issue.get("status") != "closed":
                self._beads.close(
                    repair,
                    reason="graph verification passed after repair",
                )

    def _record_findings(
        self,
        node_id: str,
        findings: list[dict[str, Any]],
        *,
        repair_bead_id: str | None = None,
    ) -> None:
        target = (
            self._state.setdefault("graph_findings", {})
            if node_id == "graph"
            else self._state["nodes"][node_id]["findings"]
        )
        for finding in findings:
            target[finding["id"]] = {
                **finding,
                "status": "open",
                "repair_bead_id": repair_bead_id,
            }
        self._evidence.record_review(
            node_id=node_id,
            finding_count=len(findings),
            passed=False,
            detail="review findings require repair or explicit rejection",
        )

    def _resolve_fixed_findings(
        self,
        node_id: str,
        state: dict[str, Any],
        review_summary: str,
    ) -> None:
        self._resolve_finding_set(
            node_id,
            state.get("findings", {}),
            review_summary,
        )

    def _resolve_finding_set(
        self,
        node_id: str,
        findings: dict[str, Any],
        review_summary: str,
    ) -> None:
        fixed = [
            finding
            for finding in findings.values()
            if finding.get("status") == "open"
        ]
        review_digest = content_digest(review_summary)
        for finding in fixed:
            finding["status"] = "fixed"
            finding["review_digest"] = review_digest
            self._evidence.append({
                "kind": "finding_disposition",
                "node_id": node_id,
                "finding_id": finding["id"],
                "status": "fixed",
                "evidence_digest": review_digest,
            })
        for finding in fixed:
            self._close_finding_repair(findings, finding)

    def reject_finding(
        self, *, finding_id: str, evidence_path: str,
    ) -> dict[str, Any]:
        for node_id, findings in self._finding_sets():
            finding = findings.get(finding_id)
            if finding is None:
                continue
            result = self._review.reject_finding(
                finding_id=finding_id,
                node_id=node_id,
                evidence_path=evidence_path,
                run_dir=self._run_dir,
            )
            finding["status"] = "rejected"
            finding["evidence_digest"] = result["evidence_digest"]
            self._close_finding_repair(findings, finding)
            self._persist_state()
            self._evidence.append({
                "kind": "finding_disposition",
                "node_id": node_id,
                "finding_id": finding_id,
                "status": "rejected",
                "evidence_digest": result["evidence_digest"],
            })
            return result
        raise ControllerError(f"finding does not exist in run {self._run_id}: {finding_id}")

    def _close_finding_repair(
        self,
        findings: dict[str, Any],
        finding: dict[str, Any],
    ) -> None:
        repair = finding.get("repair_bead_id")
        if not repair:
            return
        unresolved = any(
            item.get("repair_bead_id") == repair and item.get("status") == "open"
            for item in findings.values()
        )
        if not unresolved:
            self._beads.close(
                str(repair),
                reason="all linked review findings were explicitly resolved",
            )

    def _finding_sets(self) -> list[tuple[str, dict[str, Any]]]:
        values = [
            (node_id, node.get("findings", {}))
            for node_id, node in self._state.get("nodes", {}).items()
        ]
        values.append(("graph", self._state.get("graph_findings", {})))
        return values

    def resume(self, run_id: str) -> bool:
        self._run_dir = self._repo_root / ".sdd" / "graph-of-loops" / "runs" / run_id
        return self._restore_state()

    def status(self) -> dict[str, Any]:
        can_close, blockers = self.can_close_root() if self._plan else (False, ["no plan"])
        canonical: dict[str, str] = {}
        for node_id, node in self._state.get("nodes", {}).items():
            issue = self._beads.show(node["bead_id"])
            canonical[node_id] = str(issue.get("status", "unknown"))
        return {
            "run_id": self._run_id,
            "root_bead_id": self._root_bead_id,
            "status": self._state.get("status", "unknown"),
            "node_count": len(self._state.get("nodes", {})),
            "node_states": self._node_states,
            "bead_states": canonical,
            "review": {
                "graph": self._state.get("graph_review", "pending"),
                "findings": sum(
                    len(findings) for _, findings in self._finding_sets()
                ),
            },
            "proof": self._state.get("graph_proof", "pending"),
            "can_close": can_close,
            "blockers": blockers,
        }

    def _node(self, node_id: str) -> dict[str, Any]:
        if self._plan is None:
            raise ControllerError("no plan accepted")
        for node in self._plan["nodes"]:
            if node["id"] == node_id:
                return node
        raise ControllerError(f"unknown node: {node_id}")

    def _verify_run_base(self) -> None:
        head = self._git(["rev-parse", "HEAD"], cwd=self._repo_root).stdout.strip()
        expected = self._state.get("target_revision", self._state["base_revision"])
        if head != expected:
            pending = [
                state
                for state in self._state.get("nodes", {}).values()
                if state.get("integration_pending") and state.get("commit") == head
            ]
            if len(pending) != 1:
                raise ControllerError(
                    f"repository HEAD {head} does not match expected graph target {expected}"
                )
            pending[0]["integrated"] = True
            pending[0]["integration_pending"] = False
            self._state["target_revision"] = head
            self._persist_state()
        if not self._target_branch():
            raise ControllerError("Graph of Loops requires a named target branch")

    def _target_branch(self) -> str:
        return self._git(
            ["branch", "--show-current"], cwd=self._repo_root
        ).stdout.strip()

    def _git(
        self, arguments: list[str], *, cwd: Path,
    ) -> subprocess.CompletedProcess[str]:
        try:
            return self._runner.run(
                ["git", *arguments],
                cwd=str(cwd),
                capture_output=True,
                text=True,
                check=True,
                timeout=120,
            )
        except (FileNotFoundError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as exc:
            raise ControllerError(f"git {' '.join(arguments)} failed: {exc}") from exc
