"""Command-line entry point for the Graph of Loops controller."""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

from .beads_repository import BeadsRepository
from .bernstein_facade import BernsteinFacade
from .contracts import PlanValidationError, validate_plan
from .controller import ControllerError, GraphController
from .evidence import EvidenceLedger
from .proof import RaindropProofGate, StdioWorkshopMCPClient
from .review import CodexReviewGate
from .run_lifecycle import RunLifecycle, RunLifecycleError
from .specialist import SpecialistError, SpecialistLauncher
from .waku_runtime import WakuNodeRuntime


def _load_json(path: str, label: str) -> dict[str, Any]:
    try:
        value = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ControllerError(f"cannot load {label}: {exc}") from exc
    if not isinstance(value, dict):
        raise ControllerError(f"{label} must be a JSON object")
    return value


def _load_policy(path: str | None, *, required: bool) -> dict[str, Any]:
    candidate = path or os.environ.get("TRELLAGE_GRAPH_POLICY")
    if not candidate:
        if required:
            raise ControllerError("Graph of Loops runtime policy is required")
        return {}
    return _load_json(candidate, "policy")


def _repo_root() -> Path:
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            capture_output=True,
            text=True,
            check=True,
            timeout=15,
        )
    except (FileNotFoundError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as exc:
        raise ControllerError(f"current directory is not a Git worktree: {exc}") from exc
    return Path(result.stdout.strip()).resolve()


def _run_dir(repo_root: Path, run_id: str) -> Path:
    return repo_root / ".sdd" / "graph-of-loops" / "runs" / run_id


def _make_controller(
    policy: dict[str, Any], run_id: str, repo_root: Path,
) -> GraphController:
    run_dir = _run_dir(repo_root, run_id)
    gateway = str(policy["gateway"])
    limits = policy["limits"]
    workshop_home = run_dir / "raindrop-home"
    specialist = SpecialistLauncher(gateway_url=gateway)
    return GraphController(
        beads=BeadsRepository(
            repo_root=str(repo_root),
            beads_dir=str(repo_root / ".beads"),
        ),
        bernstein=BernsteinFacade.from_live(repo_root=repo_root),
        waku=WakuNodeRuntime(
            model=str(policy["models"]["supervisor"]),
            gateway=gateway,
        ),
        review=CodexReviewGate(
            output_dir=run_dir / "reviews",
            timeout_seconds=min(int(limits["node_timeout_seconds"]), 900),
        ),
        proof=RaindropProofGate(
            mcp_client=StdioWorkshopMCPClient(home=str(workshop_home)),
            repo_root=str(repo_root),
        ),
        evidence=EvidenceLedger(run_dir / "events.jsonl"),
        policy=policy,
        run_dir=run_dir,
        repo_root=repo_root,
        specialist=specialist,
    )


def _make_lifecycle(
    policy: dict[str, Any],
    repo_root: Path,
) -> RunLifecycle:
    gateway = str(policy["gateway"])
    return RunLifecycle(
        repo_root=repo_root,
        policy=policy,
        planner=SpecialistLauncher(gateway_url=gateway),
        plan_reviewer=CodexReviewGate(
            output_dir=(
                repo_root / ".sdd" / "graph-of-loops"
                / "planning-reviews"
            ),
            timeout_seconds=min(
                int(policy["limits"]["node_timeout_seconds"]),
                900,
            ),
        ),
        controller_factory=(
            lambda run_id: _make_controller(policy, run_id, repo_root)
        ),
        announce=lambda run_id: print(
            f"run-id: {run_id}",
            flush=True,
        ),
    )


def cmd_validate_plan(args: argparse.Namespace) -> int:
    try:
        plan = _load_json(args.plan, "plan")
        policy = _load_policy(args.policy, required=False)
        roles = policy.get("roles")
        authorization = policy.get("authorization")
        validate_plan(
            plan,
            known_roles=set(roles.values()) if isinstance(roles, dict) else None,
            profile_authorization=authorization if isinstance(authorization, dict) else None,
        )
    except (ControllerError, PlanValidationError) as exc:
        print(f"validation error: {exc}", file=sys.stderr)
        return 1
    print("plan is valid")
    return 0


def cmd_run(args: argparse.Namespace) -> int:
    try:
        policy = _load_policy(args.policy, required=True)
        repo_root = _repo_root()
        result = _make_lifecycle(policy, repo_root).start(
            objective=args.goal,
            constraints=args.constraint,
            requested_run_id=args.run_id,
        )
        print(json.dumps(result, sort_keys=True))
        return 0
    except RunLifecycleError as exc:
        print(f"error: {exc}", file=sys.stderr)
        if exc.run_id:
            print(
                "resume with: "
                f"trellage-graph resume --run {exc.run_id}",
                file=sys.stderr,
            )
        return 1
    except (
        ControllerError,
        PlanValidationError,
        SpecialistError,
    ) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


def cmd_status(args: argparse.Namespace) -> int:
    try:
        policy = _load_policy(args.policy, required=True)
        repo_root = _repo_root()
        status = _make_lifecycle(policy, repo_root).status(args.run_id)
    except (ControllerError, RunLifecycleError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    print(json.dumps(status, indent=2, sort_keys=True))
    return 0


def cmd_resume(args: argparse.Namespace) -> int:
    try:
        policy = _load_policy(args.policy, required=True)
        repo_root = _repo_root()
        result = _make_lifecycle(policy, repo_root).resume(
            args.run_id,
            replan=args.replan,
        )
    except (ControllerError, RunLifecycleError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


def cmd_finding_reject(args: argparse.Namespace) -> int:
    try:
        policy = _load_policy(args.policy, required=True)
        repo_root = _repo_root()
        result = _make_lifecycle(
            policy,
            repo_root,
        ).reject_finding(
            args.run_id,
            finding_id=args.finding_id,
            evidence_path=args.evidence,
        )
    except (ControllerError, RunLifecycleError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="trellage-graph",
        description="Trellage Graph of Loops runtime",
    )
    parser.add_argument("--policy", help="Runtime policy JSON path")
    subcommands = parser.add_subparsers(dest="command")

    validate = subcommands.add_parser("validate-plan")
    validate.add_argument("--plan", required=True)

    run = subcommands.add_parser("run")
    run.add_argument("--goal", required=True)
    run.add_argument("--constraint", action="append", default=[])
    run.add_argument("--run-id")

    status = subcommands.add_parser("status")
    status.add_argument("--run", dest="run_id", required=True)

    resume = subcommands.add_parser("resume")
    resume.add_argument("--run", dest="run_id", required=True)
    resume.add_argument("--replan", action="store_true")

    finding = subcommands.add_parser("finding")
    finding_commands = finding.add_subparsers(dest="finding_command")
    reject = finding_commands.add_parser("reject")
    reject.add_argument("finding_id")
    reject.add_argument("--run", dest="run_id", required=True)
    reject.add_argument("--evidence", required=True)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    handlers = {
        "validate-plan": cmd_validate_plan,
        "run": cmd_run,
        "status": cmd_status,
        "resume": cmd_resume,
    }
    if args.command == "finding" and args.finding_command == "reject":
        return cmd_finding_reject(args)
    handler = handlers.get(args.command)
    if handler is None:
        parser.print_help()
        return 1
    return handler(args)


if __name__ == "__main__":
    raise SystemExit(main())
