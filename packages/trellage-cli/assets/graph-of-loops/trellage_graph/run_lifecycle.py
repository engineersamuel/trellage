"""Durable bootstrap, planning, recovery, and controller handoff."""
from __future__ import annotations

import fcntl
import json
import os
import re
import shutil
import subprocess
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Callable, Iterator, Protocol

from .beads_repository import BeadsError
from .contracts import (
    PlanValidationError,
    content_digest,
    redact_sensitive,
    validate_plan,
    validate_planning_decision,
)
from .controller import ControllerError
from .review import ReviewError
from .specialist import PlanningResult, SpecialistError


_RUN_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
_SCHEMA_PATH = (
    Path(__file__).resolve().parent.parent
    / "schemas" / "graph-plan.schema.json"
)
_PLANNER_CONTRACT_PATHS = (
    Path(__file__).resolve().parent.parent
    / "roles" / "trellage-graph-discovery.md",
    Path(__file__).resolve().parent.parent
    / "roles" / "trellage-graph-planner.md",
    Path(__file__).resolve().parent.parent
    / "schemas" / "graph-plan.schema.json",
    Path(__file__).resolve().parent.parent
    / "schemas" / "planning-discovery.schema.json",
    Path(__file__).resolve().parent.parent
    / "schemas" / "planning-decision.schema.json",
)


class Planner(Protocol):
    def plan(
        self,
        *,
        role: str,
        objective: str,
        constraints: list[str],
        repo_root: str,
        config_dir: str,
        schema_path: str,
        timeout: int,
    ) -> PlanningResult: ...


class PlanReviewer(Protocol):
    def review(self, **kwargs: Any) -> dict[str, Any]: ...


class Controller(Protocol):
    def accept_plan(
        self, plan: dict[str, Any], *, run_id: str, plan_generation: int = 1,
    ) -> str: ...
    def resume(self, run_id: str) -> bool: ...
    def prepare_replan(self, run_id: str) -> int: ...
    def run(self) -> dict[str, Any]: ...
    def status(self) -> dict[str, Any]: ...
    def reject_finding(
        self,
        *,
        finding_id: str,
        evidence_path: str,
    ) -> dict[str, Any]: ...


class RunLifecycleError(Exception):
    def __init__(self, message: str, *, run_id: str | None = None) -> None:
        super().__init__(message)
        self.run_id = run_id


class RunLifecycle:
    def __init__(
        self,
        *,
        repo_root: Path,
        policy: dict[str, Any],
        planner: Planner,
        controller_factory: Callable[[str], Controller],
        announce: Callable[[str], None],
        plan_reviewer: PlanReviewer | None = None,
        run_id_factory: Callable[[], str] | None = None,
    ) -> None:
        self._repo_root = repo_root.resolve()
        self._policy = policy
        self._planner = planner
        self._controller_factory = controller_factory
        self._announce = announce
        self._plan_reviewer = plan_reviewer
        self._run_id_factory = run_id_factory or (
            lambda: uuid.uuid4().hex[:12]
        )

    def _run_dir(self, run_id: str) -> Path:
        return (
            self._repo_root / ".sdd" / "graph-of-loops"
            / "runs" / run_id
        )

    @staticmethod
    def _validate_run_id(run_id: str) -> None:
        if not _RUN_ID.fullmatch(run_id):
            raise RunLifecycleError(f"invalid run ID: {run_id!r}")

    @staticmethod
    def _load_json(path: Path) -> dict[str, Any] | None:
        if not path.is_file():
            return None
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise RunLifecycleError(
                f"cannot load {path.name}: {exc}"
            ) from exc
        if not isinstance(value, dict):
            raise RunLifecycleError(f"{path.name} must be a JSON object")
        return value

    @staticmethod
    def _write_json(path: Path, value: dict[str, Any]) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name(f".{path.name}.tmp")
        payload = json.dumps(value, indent=2, sort_keys=True) + "\n"
        try:
            with open(temporary, "w", encoding="utf-8") as handle:
                os.chmod(temporary, 0o600)
                handle.write(payload)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, path)
        except OSError as exc:
            raise RunLifecycleError(
                f"cannot persist {path.name}: {exc}"
            ) from exc

    @contextmanager
    def _exclusive(self, run_id: str) -> Iterator[None]:
        lock_path = self._run_dir(run_id) / "run.lock"
        lock_path.parent.mkdir(parents=True, exist_ok=True)
        descriptor = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o600)
        try:
            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as exc:
                raise RunLifecycleError(
                    f"run {run_id} is already active"
                ) from exc
            yield
        finally:
            fcntl.flock(descriptor, fcntl.LOCK_UN)
            os.close(descriptor)

    def _policy_digest(self) -> str:
        return content_digest(json.dumps(self._policy, sort_keys=True))

    def _planner_contract_digest(self) -> str:
        payload = b"".join(
            path.read_bytes()
            for path in _PLANNER_CONTRACT_PATHS
        )
        return content_digest(payload)

    def _runtime_integrity(self) -> str:
        value = self._policy.get("runtime_integrity")
        return str(value) if isinstance(value, str) else "unavailable"

    @staticmethod
    def _json_digest(value: dict[str, Any]) -> str:
        return content_digest(json.dumps(value, sort_keys=True))

    def _plan_record(
        self,
        *,
        request: dict[str, Any],
        decision: dict[str, Any],
        plan: dict[str, Any],
        planning_evidence: dict[str, Any],
        planning_review: dict[str, Any],
        generation: int = 1,
    ) -> dict[str, Any]:
        return {
            "schema": 1,
            "generation": generation,
            "request_digest": self._json_digest(request),
            "decision_digest": self._json_digest(decision),
            "plan_digest": self._json_digest(plan),
            "policy_digest": self._policy_digest(),
            "runtime_integrity": self._runtime_integrity(),
            "planner_contract_digest": self._planner_contract_digest(),
            "discovery_digest": self._json_digest(planning_evidence),
            "review_digest": self._json_digest(planning_review),
            "base_revision": plan["base_revision"],
        }

    def _candidate_record(
        self,
        *,
        request: dict[str, Any],
        decision: dict[str, Any],
        plan: dict[str, Any],
        planning_evidence: dict[str, Any],
        generation: int,
    ) -> dict[str, Any]:
        return {
            "schema": 1,
            "generation": generation,
            "request_digest": self._json_digest(request),
            "decision_digest": self._json_digest(decision),
            "plan_digest": self._json_digest(plan),
            "policy_digest": self._policy_digest(),
            "runtime_integrity": self._runtime_integrity(),
            "planner_contract_digest": self._planner_contract_digest(),
            "discovery_digest": self._json_digest(planning_evidence),
            "base_revision": plan["base_revision"],
        }

    def _validate_candidate_record(
        self,
        *,
        request: dict[str, Any],
        decision: dict[str, Any],
        plan: dict[str, Any],
        planning_evidence: dict[str, Any],
        record: dict[str, Any],
    ) -> int:
        generation = int(record.get("generation", 1))
        expected = self._candidate_record(
            request=request,
            decision=decision,
            plan=plan,
            planning_evidence=planning_evidence,
            generation=generation,
        )
        mismatches = [
            key for key, value in expected.items()
            if record.get(key) != value
        ]
        if mismatches:
            raise RunLifecycleError(
                "persisted candidate provenance is stale: "
                + ", ".join(sorted(mismatches))
            )
        return generation

    def _current_revision(self) -> str:
        try:
            result = subprocess.run(
                ["git", "rev-parse", "HEAD"],
                cwd=self._repo_root,
                capture_output=True,
                text=True,
                check=True,
                timeout=15,
            )
        except (
            FileNotFoundError,
            subprocess.CalledProcessError,
            subprocess.TimeoutExpired,
        ) as exc:
            raise RunLifecycleError(
                f"cannot verify candidate base revision: {exc}"
            ) from exc
        return result.stdout.strip()

    def _validate_plan_record(
        self,
        *,
        request: dict[str, Any],
        decision: dict[str, Any],
        plan: dict[str, Any],
        planning_evidence: dict[str, Any],
        planning_review: dict[str, Any],
        record: dict[str, Any],
    ) -> None:
        expected = self._plan_record(
            request=request,
            decision=decision,
            plan=plan,
            planning_evidence=planning_evidence,
            planning_review=planning_review,
            generation=int(record.get("generation", 1)),
        )
        mismatches = [
            key for key, value in expected.items()
            if record.get(key) != value
        ]
        if mismatches:
            raise RunLifecycleError(
                "persisted plan provenance is stale: "
                + ", ".join(sorted(mismatches))
            )

    def _set_phase(
        self,
        run_id: str,
        phase: str,
        *,
        error: str | None = None,
    ) -> None:
        value: dict[str, Any] = {
            "schema": 1,
            "run_id": run_id,
            "status": phase,
            "policy_digest": self._policy_digest(),
        }
        if error:
            value["error"] = redact_sensitive(error)[:2000]
        self._write_json(self._run_dir(run_id) / "lifecycle.json", value)

    def _ensure_request(
        self,
        run_id: str,
        *,
        objective: str,
        constraints: list[str],
    ) -> dict[str, Any]:
        path = self._run_dir(run_id) / "request.json"
        expected = {
            "schema": 1,
            "run_id": run_id,
            "objective": objective,
            "constraints": constraints,
            "policy_digest": self._policy_digest(),
        }
        existing = self._load_json(path)
        if existing is not None and existing != expected:
            raise RunLifecycleError(
                f"run {run_id} request or runtime policy does not match"
            )
        if existing is None:
            self._write_json(path, expected)
        return expected

    def _request_for_resume(self, run_id: str) -> dict[str, Any]:
        request = self._load_json(self._run_dir(run_id) / "request.json")
        if request is not None:
            if request.get("policy_digest") != self._policy_digest():
                raise RunLifecycleError(
                    "runtime policy changed since the run was created"
                )
            return request
        plan = self._load_json(self._run_dir(run_id) / "plan.json")
        if plan is None:
            raise RunLifecycleError(f"no resumable state for run {run_id}")
        return self._ensure_request(
            run_id,
            objective=str(plan.get("objective", "")),
            constraints=[
                str(value) for value in plan.get("constraints", [])
            ],
        )

    def _validate_plan(self, plan: dict[str, Any]) -> None:
        roles = self._policy.get("roles")
        authorization = self._policy.get("authorization")
        validate_plan(
            plan,
            known_roles=(
                set(roles.values()) if isinstance(roles, dict) else None
            ),
            profile_authorization=(
                authorization
                if isinstance(authorization, dict) else None
            ),
        )

    def _load_or_create_plan(
        self,
        run_id: str,
        request: dict[str, Any],
        *,
        generation: int,
    ) -> dict[str, Any]:
        persisted = self._load_persisted_plan(run_id, request)
        if persisted is not None:
            return persisted
        return self._create_plan(
            run_id,
            request,
            generation=generation,
        )

    def _load_persisted_plan(
        self, run_id: str, request: dict[str, Any],
    ) -> dict[str, Any] | None:
        plan_path = self._run_dir(run_id) / "plan.json"
        decision_path = self._run_dir(run_id) / "planning-decision.json"
        evidence_path = self._run_dir(run_id) / "planning-evidence.json"
        review_path = self._run_dir(run_id) / "planning-review.json"
        record_path = self._run_dir(run_id) / "plan-record.json"
        decision = self._load_json(decision_path)
        if decision is not None and decision.get("status") == "blocked":
            code = str(decision.get("reason_code", "blocked"))
            summary = str(decision.get("summary", "planner blocked"))
            raise RunLifecycleError(f"planner blocked [{code}]: {summary}")
        if (
            decision is not None
            and decision.get("status") == "planned"
            and (self._run_dir(run_id) / "candidate-plan.json").is_file()
            and not plan_path.is_file()
        ):
            return self._retry_candidate_review(
                run_id=run_id,
                request=request,
                decision=decision,
            )
        plan = self._load_json(plan_path)
        if plan is not None:
            if decision is None:
                raise RunLifecycleError(
                    "persisted plan has no planning decision"
                )
            evidence = self._load_json(evidence_path)
            review = self._load_json(review_path)
            record = self._load_json(record_path)
            if evidence is None or review is None or record is None:
                raise RunLifecycleError(
                    "persisted plan has incomplete provenance"
                )
            self._validate_plan_record(
                request=request,
                decision=decision,
                plan=plan,
                planning_evidence=evidence,
                planning_review=review,
                record=record,
            )
            self._validate_plan(plan)
            if (
                not (self._run_dir(run_id) / "state.json").is_file()
                and self._current_revision() != plan["base_revision"]
            ):
                raise RunLifecycleError(
                    "reviewed plan base revision changed; "
                    "explicit replan is required"
                )
            return plan
        return None

    def _record_review_failure(
        self,
        run_id: str,
        error: ReviewError,
    ) -> None:
        self._write_json(
            self._run_dir(run_id) / "planning-review-failure.json",
            {
                "schema": 1,
                "kind": "semantic" if error.findings else "infrastructure",
                "finding_count": len(error.findings),
                "error": redact_sensitive(str(error))[:2000],
            },
        )

    def _review_and_finalize_candidate(
        self,
        *,
        run_id: str,
        request: dict[str, Any],
        decision: dict[str, Any],
        plan: dict[str, Any],
        planning_evidence: dict[str, Any],
        generation: int,
    ) -> dict[str, Any]:
        run_dir = self._run_dir(run_id)
        try:
            planning_review = self._review_candidate(
                run_id=run_id,
                generation=generation,
                plan=plan,
            )
        except ReviewError as exc:
            self._record_review_failure(run_id, exc)
            raise
        self._write_json(run_dir / "planning-review.json", planning_review)
        self._write_json(run_dir / "plan.json", plan)
        self._write_json(
            run_dir / "plan-record.json",
            self._plan_record(
                request=request,
                decision=decision,
                plan=plan,
                planning_evidence=planning_evidence,
                planning_review=planning_review,
                generation=generation,
            ),
        )
        for name in (
            "candidate-plan.json",
            "candidate-record.json",
            "planning-review-failure.json",
        ):
            (run_dir / name).unlink(missing_ok=True)
        self._set_phase(run_id, "planned")
        return plan

    def _retry_candidate_review(
        self,
        *,
        run_id: str,
        request: dict[str, Any],
        decision: dict[str, Any],
    ) -> dict[str, Any]:
        run_dir = self._run_dir(run_id)
        failure = self._load_json(run_dir / "planning-review-failure.json")
        if failure is not None and failure.get("kind") == "semantic":
            raise RunLifecycleError(
                "candidate plan has unresolved review findings; "
                "explicit replan is required"
            )
        plan = self._load_json(run_dir / "candidate-plan.json")
        evidence = self._load_json(run_dir / "planning-evidence.json")
        record = self._load_json(run_dir / "candidate-record.json")
        if plan is None or evidence is None or record is None:
            raise RunLifecycleError(
                "candidate plan has incomplete provenance; "
                "explicit replan is required"
            )
        generation = self._validate_candidate_record(
            request=request,
            decision=decision,
            plan=plan,
            planning_evidence=evidence,
            record=record,
        )
        self._validate_plan(plan)
        if self._current_revision() != plan["base_revision"]:
            raise RunLifecycleError(
                "candidate plan base revision changed; "
                "explicit replan is required"
            )
        self._set_phase(run_id, "reviewing-plan")
        return self._review_and_finalize_candidate(
            run_id=run_id,
            request=request,
            decision=decision,
            plan=plan,
            planning_evidence=evidence,
            generation=generation,
        )

    def _create_plan(
        self,
        run_id: str,
        request: dict[str, Any],
        *,
        generation: int,
    ) -> dict[str, Any]:
        run_dir = self._run_dir(run_id)
        plan_path = run_dir / "plan.json"
        decision_path = run_dir / "planning-decision.json"
        evidence_path = run_dir / "planning-evidence.json"
        self._set_phase(run_id, "planning")
        limits = self._policy.get("limits")
        roles = self._policy.get("roles")
        if not isinstance(limits, dict) or not isinstance(roles, dict):
            raise RunLifecycleError("runtime policy cannot configure planner")
        result = self._planner.plan(
            role=str(roles["planner"]),
            objective=str(request["objective"]),
            constraints=[
                str(value) for value in request.get("constraints", [])
            ],
            repo_root=str(self._repo_root),
            config_dir=str(
                self._run_dir(run_id) / "claude" / "planner"
            ),
            schema_path=str(_SCHEMA_PATH),
            timeout=int(limits["node_timeout_seconds"]),
        )
        validate_planning_decision(
            result.decision,
            objective=str(request["objective"]),
            constraints=[
                str(value) for value in request.get("constraints", [])
            ],
            repo_root=self._repo_root,
            known_roles=set(roles.values()),
            profile_authorization=(
                self._policy.get("authorization")
                if isinstance(self._policy.get("authorization"), dict)
                else None
            ),
        )
        planning_evidence = {
            "schema": 1,
            "serena_success": result.serena_success,
            "serena_fallback": result.serena_fallback,
            "discovery": result.discovery,
            "tool_events": result.tool_events,
        }
        self._write_json(evidence_path, planning_evidence)
        self._write_json(decision_path, result.decision)
        if result.plan is None:
            code = str(result.decision["reason_code"])
            summary = str(result.decision["summary"])
            raise RunLifecycleError(
                f"planner blocked [{code}]: {summary}"
            )
        candidate_path = self._run_dir(run_id) / "candidate-plan.json"
        self._write_json(candidate_path, result.plan)
        self._write_json(
            run_dir / "candidate-record.json",
            self._candidate_record(
                request=request,
                decision=result.decision,
                plan=result.plan,
                planning_evidence=planning_evidence,
                generation=generation,
            ),
        )
        return self._review_and_finalize_candidate(
            run_id=run_id,
            request=request,
            decision=result.decision,
            generation=generation,
            plan=result.plan,
            planning_evidence=planning_evidence,
        )

    def _review_candidate(
        self,
        *,
        run_id: str,
        generation: int,
        plan: dict[str, Any],
    ) -> dict[str, Any]:
        if self._plan_reviewer is None:
            return {
                "schema": 1,
                "status": "not-configured",
                "summary": "Injected tests omit the external plan reviewer.",
            }
        run_dir = self._run_dir(run_id)
        run_path = run_dir.relative_to(self._repo_root).as_posix()
        prompt = (
            f"Audit candidate Graph of Loops plan for run {run_id} before "
            f"acceptance. Compare {run_path}/request.json, "
            f"{run_path}/planning-decision.json, "
            f"{run_path}/planning-evidence.json, "
            f"{run_path}/candidate-plan.json, and the repository. "
            "Report critical or high "
            "confidence findings for invented or substituted scope, request drift, "
            "unsupported target evidence, incomplete repair ownership, missing "
            "repository validation, toolchain or language-version conflicts, "
            "missing requested target architectures, benchmark seams that cannot "
            "call the declared comparison implementation, or node criteria that "
            "claim controller-owned integration, review, proof, cleanup, or root "
            "closure. Distinguish compiler-host targets from targets with configured "
            "linkers: reject build, test, run, or benchmark gates that require "
            "linking for a target when the evidence proves only compiler or standard "
            "library availability. Return only the required JSON."
        )
        result = self._plan_reviewer.review(
            node_id=f"plan-g{generation}",
            worktree_path=str(self._repo_root),
            base_revision=str(plan["base_revision"]),
            prompt=prompt,
            output_dir=run_dir / "planning-reviews",
        )
        return {
            "schema": 1,
            "status": "passed",
            "summary": str(result["summary"]),
            "output_path": str(result["output_path"]),
        }

    def _continue(
        self,
        run_id: str,
        request: dict[str, Any],
        *,
        generation: int = 1,
    ) -> dict[str, Any]:
        plan = self._load_or_create_plan(
            run_id,
            request,
            generation=generation,
        )
        controller = self._controller_factory(run_id)
        if not controller.resume(run_id):
            self._set_phase(run_id, "accepting")
            controller.accept_plan(
                plan,
                run_id=run_id,
                plan_generation=generation,
            )
        self._set_phase(run_id, "running")
        result = controller.run()
        self._set_phase(
            run_id,
            str(result.get("status", "complete")),
        )
        return {"run_id": run_id, **result}

    def _run_and_record(
        self,
        run_id: str,
        request: dict[str, Any],
        *,
        generation: int = 1,
    ) -> dict[str, Any]:
        try:
            return self._continue(
                run_id,
                request,
                generation=generation,
            )
        except (
            BeadsError,
            ControllerError,
            PlanValidationError,
            ReviewError,
            RunLifecycleError,
            SpecialistError,
        ) as exc:
            message = redact_sensitive(str(exc))[:2000]
            self._set_phase(run_id, "blocked", error=message)
            raise RunLifecycleError(
                f"run {run_id} blocked: {message}",
                run_id=run_id,
            ) from exc

    def start(
        self,
        *,
        objective: str,
        constraints: list[str],
        requested_run_id: str | None = None,
    ) -> dict[str, Any]:
        run_id = requested_run_id or self._run_id_factory()
        self._validate_run_id(run_id)
        with self._exclusive(run_id):
            request = self._ensure_request(
                run_id,
                objective=objective,
                constraints=constraints,
            )
            self._announce(run_id)
            return self._run_and_record(run_id, request)

    def _archive_generation(self, run_id: str, generation: int) -> None:
        run_dir = self._run_dir(run_id)
        destination = run_dir / "history" / f"generation-{generation}"
        staging = run_dir / "history" / f".generation-{generation}.staging"
        if destination.exists():
            return
        staging.mkdir(parents=True, exist_ok=True)
        for name in (
            "plan.json",
            "planning-decision.json",
            "planning-evidence.json",
            "planning-review.json",
            "planning-review-failure.json",
            "plan-record.json",
            "candidate-plan.json",
            "candidate-record.json",
            "lifecycle.json",
            "state.json",
            "envelopes",
            "claude",
            "reviews",
            "planning-reviews",
            "proof",
        ):
            source = run_dir / name
            if source.exists():
                staged = staging / name
                if staged.exists():
                    raise RunLifecycleError(
                        f"cannot archive generation {generation}: "
                        f"both active and staged {name} exist"
                    )
                shutil.move(str(source), str(staged))
        try:
            os.replace(staging, destination)
        except OSError as exc:
            raise RunLifecycleError(
                f"cannot finalize plan generation {generation} archive: {exc}"
            ) from exc

    def _prepare_replan(self, run_id: str) -> int:
        run_dir = self._run_dir(run_id)
        record = self._load_json(run_dir / "plan-record.json")
        if record is None:
            record = self._load_json(run_dir / "candidate-record.json")
        generation = int(record.get("generation", 1)) if record else 1
        if (run_dir / "state.json").is_file():
            controller = self._controller_factory(run_id)
            if not controller.resume(run_id):
                raise RunLifecycleError(
                    f"cannot restore accepted run {run_id}"
                )
            generation = controller.prepare_replan(run_id)
        self._archive_generation(run_id, generation)
        return generation + 1

    def _current_generation(self, run_id: str) -> int:
        run_dir = self._run_dir(run_id)
        record = self._load_json(run_dir / "plan-record.json")
        if record is None:
            record = self._load_json(run_dir / "candidate-record.json")
        if record is not None:
            return int(record.get("generation", 1))
        state = self._load_json(run_dir / "state.json")
        return int(state.get("plan_generation", 1)) if state else 1

    def resume(
        self, run_id: str, *, replan: bool = False,
    ) -> dict[str, Any]:
        self._validate_run_id(run_id)
        with self._exclusive(run_id):
            request = self._request_for_resume(run_id)
            generation = (
                self._prepare_replan(run_id)
                if replan
                else self._current_generation(run_id)
            )
            return self._run_and_record(
                run_id,
                request,
                generation=generation,
            )

    def status(self, run_id: str) -> dict[str, Any]:
        self._validate_run_id(run_id)
        run_dir = self._run_dir(run_id)
        if (run_dir / "state.json").is_file():
            controller = self._controller_factory(run_id)
            if not controller.resume(run_id):
                raise RunLifecycleError(
                    f"cannot restore accepted run {run_id}"
                )
            return controller.status()
        lifecycle = self._load_json(run_dir / "lifecycle.json")
        if lifecycle is not None:
            return lifecycle
        if (run_dir / "plan.json").is_file():
            return {
                "schema": 1,
                "run_id": run_id,
                "status": "planned",
                "policy_digest": self._policy_digest(),
            }
        raise RunLifecycleError(f"no run state for {run_id}")

    def reject_finding(
        self,
        run_id: str,
        *,
        finding_id: str,
        evidence_path: str,
    ) -> dict[str, Any]:
        self._validate_run_id(run_id)
        with self._exclusive(run_id):
            controller = self._controller_factory(run_id)
            if not controller.resume(run_id):
                raise RunLifecycleError(
                    f"cannot restore accepted run {run_id}"
                )
            return controller.reject_finding(
                finding_id=finding_id,
                evidence_path=evidence_path,
            )
