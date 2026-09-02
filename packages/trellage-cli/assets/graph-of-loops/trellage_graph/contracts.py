"""JSON schema validation and graph-plan contract enforcement.

Uses the bundled _schema_validator (stdlib only, no pip install).
Validates graph plans against locked schemas then enforces structural
rules JSON Schema cannot express.
"""
from __future__ import annotations

import hashlib
import json
import fnmatch
import posixpath
import re
from pathlib import Path
from typing import Any

from . import _schema_validator
from .gate_command import gate_command_errors

_SCHEMA_DIR = Path(__file__).resolve().parent.parent / "schemas"


def _load_schema(name: str) -> dict[str, Any]:
    path = _SCHEMA_DIR / name
    if not path.is_file():
        raise FileNotFoundError(f"Schema not found: {path}")
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def graph_plan_schema() -> dict[str, Any]:
    return _load_schema("graph-plan.schema.json")

def node_envelope_schema() -> dict[str, Any]:
    return _load_schema("node-envelope.schema.json")

def codex_review_schema() -> dict[str, Any]:
    return _load_schema("codex-review.schema.json")

def repository_proof_schema() -> dict[str, Any]:
    return _load_schema("repository-proof.schema.json")


def planning_decision_schema() -> dict[str, Any]:
    return _load_schema("planning-decision.schema.json")

def planning_discovery_schema() -> dict[str, Any]:
    return _load_schema("planning-discovery.schema.json")


class PlanValidationError(Exception):
    def __init__(self, errors: list[str]) -> None:
        self.errors = errors
        super().__init__("; ".join(errors))


# -- JSON schema --

def validate_json_schema(instance: Any, schema: dict[str, Any]) -> list[str]:
    return _schema_validator.validate(instance, schema)


# -- Structural rules --

def _detect_cycles(nodes: list[dict[str, Any]]) -> list[str]:
    id_set = {n["id"] for n in nodes}
    adj: dict[str, list[str]] = {n["id"]: [] for n in nodes}
    in_deg: dict[str, int] = {n["id"]: 0 for n in nodes}
    for node in nodes:
        for dep in node["dependencies"]:
            if dep in id_set:
                adj[dep].append(node["id"])
                in_deg[node["id"]] += 1
    visited = _drain_acyclic_nodes(adj, in_deg)
    if visited < len(nodes):
        remaining = sorted(nid for nid, degree in in_deg.items() if degree > 0)
        return [f"cycle detected involving nodes: {', '.join(remaining)}"]
    return []


def _drain_acyclic_nodes(
    adjacency: dict[str, list[str]], in_degree: dict[str, int],
) -> int:
    queue = [node_id for node_id, degree in in_degree.items() if degree == 0]
    visited = 0
    while queue:
        current = queue.pop(0)
        visited += 1
        for neighbor in adjacency[current]:
            in_degree[neighbor] -= 1
            if in_degree[neighbor] == 0:
                queue.append(neighbor)
    return visited


def _check_duplicate_ids(nodes: list[dict[str, Any]]) -> list[str]:
    seen: set[str] = set()
    dupes: list[str] = []
    for n in nodes:
        if n["id"] in seen:
            dupes.append(f"duplicate node id: {n['id']}")
        seen.add(n["id"])
    return dupes


def _check_unknown_deps(nodes: list[dict[str, Any]]) -> list[str]:
    id_set = {n["id"] for n in nodes}
    errs: list[str] = []
    for n in nodes:
        for dep in n["dependencies"]:
            if dep not in id_set:
                errs.append(f"node '{n['id']}' depends on unknown node '{dep}'")
    return errs


def _check_roles(nodes: list[dict[str, Any]], known: set[str] | None) -> list[str]:
    if known is None:
        return []
    return [
        f"node '{n['id']}' has unknown role '{n['role']}'"
        for n in nodes if n["role"] not in known
    ]


def _safe_relative_pattern(value: str) -> bool:
    if not value or value.startswith(("/", "\\")) or "\\" in value:
        return False
    normalized = posixpath.normpath(value)
    return normalized not in (".", "..") and not normalized.startswith("../")


def _static_prefix(pattern: str) -> str:
    segments: list[str] = []
    for segment in pattern.split("/"):
        if any(char in segment for char in "*?["):
            break
        segments.append(segment)
    return "/".join(segments)


def _patterns_may_overlap(left: str, right: str) -> bool:
    if left == right or left == "**" or right == "**":
        return True
    if fnmatch.fnmatch(left, right) or fnmatch.fnmatch(right, left):
        return True
    left_prefix = _static_prefix(left)
    right_prefix = _static_prefix(right)
    if not left_prefix or not right_prefix:
        return True
    return (
        left_prefix == right_prefix
        or left_prefix.startswith(f"{right_prefix}/")
        or right_prefix.startswith(f"{left_prefix}/")
    )


def _depends_transitively(
    node_id: str, dependency_id: str, by_id: dict[str, dict[str, Any]],
) -> bool:
    pending = list(by_id[node_id]["dependencies"])
    visited: set[str] = set()
    while pending:
        current = pending.pop()
        if current == dependency_id:
            return True
        if current in visited or current not in by_id:
            continue
        visited.add(current)
        pending.extend(by_id[current]["dependencies"])
    return False


def _check_parallel_write_overlap(nodes: list[dict[str, Any]]) -> list[str]:
    errs: list[str] = []
    by_id = {node["id"]: node for node in nodes}
    parallel = [node for node in nodes if node.get("parallel_safe", False)]
    for index, left in enumerate(parallel):
        for right in parallel[index + 1:]:
            overlap = _parallel_pair_overlap(left, right, by_id)
            if overlap is not None:
                errs.append(
                    f"parallel nodes '{left['id']}' and '{right['id']}' have "
                    f"overlapping write sets: {', '.join(overlap)}"
                )
    return errs


def _parallel_pair_overlap(
    left: dict[str, Any],
    right: dict[str, Any],
    by_id: dict[str, dict[str, Any]],
) -> list[str] | None:
    if _depends_transitively(left["id"], right["id"], by_id):
        return None
    if _depends_transitively(right["id"], left["id"], by_id):
        return None
    left_writes = _all_write_patterns(left)
    right_writes = _all_write_patterns(right)
    overlap = {
        f"{left_pattern} <> {right_pattern}"
        for left_pattern in left_writes
        for right_pattern in right_writes
        if _patterns_may_overlap(left_pattern, right_pattern)
    }
    return sorted(overlap) or None


def _all_write_patterns(node: dict[str, Any]) -> list[str]:
    return [
        *node["write_set"],
        *node.get("repair_write_set", []),
        *node.get("test_write_set", []),
        *node.get("evidence_write_set", []),
    ]


def _check_behavior_change_gates(nodes: list[dict[str, Any]]) -> list[str]:
    errs: list[str] = []
    for node in nodes:
        errs.extend(_behavior_change_errors(node))
    return errs


def _behavior_change_errors(node: dict[str, Any]) -> list[str]:
    if not node.get("behavior_change", False):
        return []
    errors: list[str] = []
    phases = {gate.get("phase") for gate in node["gates"]}
    errors.extend(
        f"behavior-change node '{node['id']}' missing '{phase}' gate"
        for phase in ("red", "green", "final")
        if phase not in phases
    )
    red = sorted(
        tuple(gate["argv"])
        for gate in node["gates"]
        if gate.get("phase") == "red"
    )
    green = sorted(
        tuple(gate["argv"])
        for gate in node["gates"]
        if gate.get("phase") == "green"
    )
    if red and green and red != green:
        errors.append(
            f"behavior-change node '{node['id']}' red and green gate argv sets differ"
        )
    if not node.get("test_write_set"):
        errors.append(
            f"behavior-change node '{node['id']}' requires test_write_set"
        )
    return errors


def _repair_ownership_errors(node: dict[str, Any]) -> list[str]:
    repair_patterns = node.get("repair_write_set", [])
    uncovered = [
        path
        for path in [*node.get("write_set", []), *node.get("test_write_set", [])]
        if not any(fnmatch.fnmatch(path, pattern) for pattern in repair_patterns)
    ]
    if not uncovered:
        return []
    return [
        f"behavior-change node '{node['id']}' repair_write_set does not cover "
        f"owned paths: {', '.join(uncovered)}"
    ]


def _research_session_paths(ledger: str) -> list[str]:
    return [
        f"{ledger}/artifacts/claim_ledger.jsonl",
        f"{ledger}/sources/sources.jsonl",
        f"{ledger}/outputs/verified_claims.json",
        f"{ledger}/outputs/unresolved_claims.json",
        f"{ledger}/outputs/refuted_claims.json",
        f"{ledger}/outputs/gate_failed.json",
        f"{ledger}/state.json",
    ]


def _check_research_node_write_rules(node: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    if node["write_set"]:
        errors.append(f"research node '{node['id']}' must have empty write_set")
    evidence = node.get("evidence_write_set", [])
    ledger = node.get("research_ledger", "")
    if not evidence:
        errors.append(f"research node '{node['id']}' requires evidence_write_set")
    session_paths = _research_session_paths(ledger) if ledger else []
    uncovered = [
        path
        for path in session_paths
        if not any(fnmatch.fnmatch(path, pattern) for pattern in evidence)
    ]
    if not ledger or uncovered:
        errors.append(
            f"research node '{node['id']}' research_ledger is not in evidence_write_set"
        )
    if ledger.endswith(".md") or ledger.endswith(".jsonl"):
        errors.append(
            f"research node '{node['id']}' research_ledger must name a session directory"
        )
    if uncovered:
        errors.append(
            f"research node '{node['id']}' evidence_write_set does not cover "
            f"the research session contract: {', '.join(uncovered)}"
        )
    return errors


def _check_research_write_rules(nodes: list[dict[str, Any]]) -> list[str]:
    errors: list[str] = []
    for node in nodes:
        if node["type"] == "research":
            errors.extend(_check_research_node_write_rules(node))
    return errors


def _check_prompt_digests(nodes: list[dict[str, Any]]) -> list[str]:
    errors: list[str] = []
    for node in nodes:
        prompt = node.get("prompt")
        if not isinstance(prompt, str) or not prompt:
            errors.append(f"node '{node['id']}' requires a non-empty prompt")
            continue
        actual = content_digest(prompt)
        if node["prompt_digest"] != actual:
            errors.append(
                f"node '{node['id']}' prompt_digest does not match prompt"
            )
    return errors


def _check_path_sets(nodes: list[dict[str, Any]]) -> list[str]:
    errors: list[str] = []
    for node in nodes:
        for key in (
            "read_set",
            "write_set",
            "repair_write_set",
            "test_write_set",
            "evidence_write_set",
        ):
            for value in node.get(key, []):
                if not _safe_relative_pattern(value):
                    errors.append(
                        f"node '{node['id']}' has unsafe path in {key}: {value}"
                    )
        ledger = node.get("research_ledger")
        if ledger is not None and not _safe_relative_pattern(ledger):
            errors.append(
                f"node '{node['id']}' has unsafe path in research_ledger: {ledger}"
            )
    return errors


def _check_controller_owned_acceptance(
    nodes: list[dict[str, Any]],
) -> list[str]:
    controller_claims = re.compile(
        r"\b("
        r"rebase[ds]?|fast[- ]forward(?:ed)?|integrat(?:e|ed|ion)|"
        r"codex review|graph review|root bead|close[ds]? the bead|"
        r"worktree cleanup|clean(?:ed)? up (?:the )?worktree|"
        r"graph proof|raindrop proof"
        r")\b",
        re.IGNORECASE,
    )
    errors: list[str] = []
    for node in nodes:
        for criterion in node.get("acceptance_criteria", []):
            claim = controller_claims.search(criterion)
            if claim and not _controller_claim_is_negated(
                criterion,
                claim.start(),
            ):
                errors.append(
                    f"node '{node['id']}' acceptance criterion claims "
                    f"controller-owned state: {criterion}"
                )
    return errors


def _controller_claim_is_negated(criterion: str, claim_start: int) -> bool:
    prefix = criterion[max(0, claim_start - 80):claim_start]
    return bool(re.search(
        r"\b(?:no|not|never|without)\s+(?:[A-Za-z-]+\s+){0,4}$|"
        r"\b(?:does|do|must|will|can)\s+not\s+"
        r"(?:claim|perform|verify|assert|require)?\s*$|"
        r"\b(?:makes?|states?|asserts?)\s+no\s+claims?\s+"
        r"(?:about|of|to)\b",
        prefix,
        re.IGNORECASE,
    ))


def _check_gate_argv_safety(
    nodes: list[dict[str, Any]], graph_gates: list[dict[str, Any]],
) -> list[str]:
    """Reject unsafe or inline-evaluated gate commands."""
    errs: list[str] = []
    gate_groups = [
        *[(n["id"], n["gates"]) for n in nodes],
        ("graph", graph_gates),
    ]
    for node_id, gates in gate_groups:
        for g in gates:
            prefix = f"gate '{g['name']}' in node '{node_id}':"
            errs.extend(
                f"{prefix} {error}"
                for error in gate_command_errors(g["argv"])
            )
    return errs


def _check_authorization(
    plan: dict[str, Any], profile_auth: dict[str, bool] | None,
) -> list[str]:
    if profile_auth is None:
        return []
    plan_auth = plan.get("authorization", {})
    return [
        f"plan requests '{perm}' but profile does not grant it"
        for perm in ("allow_push", "allow_pull_request", "allow_deploy")
        if plan_auth.get(perm, False) and not profile_auth.get(perm, False)
    ]


# -- Public API --

def validate_plan(
    plan: dict[str, Any],
    *,
    known_roles: set[str] | None = None,
    profile_authorization: dict[str, bool] | None = None,
) -> None:
    schema_errors = validate_json_schema(plan, graph_plan_schema())
    if schema_errors:
        raise PlanValidationError(schema_errors)

    nodes = plan.get("nodes", [])
    errors: list[str] = []
    errors.extend(_check_duplicate_ids(nodes))
    errors.extend(_check_unknown_deps(nodes))
    errors.extend(_detect_cycles(nodes))
    errors.extend(_check_roles(nodes, known_roles))
    errors.extend(_check_prompt_digests(nodes))
    errors.extend(_check_path_sets(nodes))
    errors.extend(_check_controller_owned_acceptance(nodes))
    errors.extend(_check_parallel_write_overlap(nodes))
    errors.extend(_check_behavior_change_gates(nodes))
    errors.extend(_check_research_write_rules(nodes))
    errors.extend(_check_gate_argv_safety(nodes, plan.get("graph_gates", [])))
    errors.extend(_check_authorization(plan, profile_authorization))
    if errors:
        raise PlanValidationError(errors)


def _planning_alignment_errors(
    decision: dict[str, Any],
    objective: str,
    constraints: list[str],
) -> list[str]:
    errors: list[str] = []
    if decision.get("objective") != objective:
        errors.append("planning decision objective does not match the request")
    if decision.get("constraints") != constraints:
        errors.append("planning decision constraints do not match the request")
    if decision.get("status") == "planned":
        plan = decision.get("plan", {})
        if plan.get("objective") != objective:
            errors.append("graph plan objective does not match the request")
        if plan.get("constraints", []) != constraints:
            errors.append("graph plan constraints do not match the request")
    return errors


def _planning_evidence_errors(
    decision: dict[str, Any], repo_root: Path,
) -> list[str]:
    errors: list[str] = []
    evidence = (
        decision.get("target_evidence", [])
        if decision.get("status") == "planned"
        else decision.get("evidence", [])
    )
    root = repo_root.resolve()
    for item in evidence:
        if not isinstance(item, dict):
            continue
        raw_path = item.get("path")
        if not isinstance(raw_path, str) or not raw_path:
            continue
        candidate = (root / raw_path).resolve()
        try:
            candidate.relative_to(root)
        except ValueError:
            errors.append(f"planning evidence escapes repository: {raw_path}")
            continue
        if not candidate.exists():
            errors.append(f"planning evidence path does not exist: {raw_path}")
    return errors


def validate_planning_decision(
    decision: dict[str, Any],
    *,
    objective: str,
    constraints: list[str],
    repo_root: Path,
    known_roles: set[str] | None = None,
    profile_authorization: dict[str, bool] | None = None,
) -> None:
    errors = validate_json_schema(decision, planning_decision_schema())
    errors.extend(_planning_decision_shape_errors(decision))
    errors.extend(_planning_alignment_errors(decision, objective, constraints))
    errors.extend(_planning_evidence_errors(decision, repo_root))
    if errors:
        raise PlanValidationError(errors)
    if decision["status"] == "planned":
        validate_plan(
            decision["plan"],
            known_roles=known_roles,
            profile_authorization=profile_authorization,
        )
        planning_errors = _planning_contract_errors(decision["plan"])
        if planning_errors:
            raise PlanValidationError(planning_errors)


def _planning_decision_shape_errors(
    decision: dict[str, Any],
) -> list[str]:
    common = {"status", "objective", "constraints"}
    branch_fields = {
        "planned": {"target_evidence", "plan"},
        "blocked": {
            "reason_code",
            "summary",
            "evidence",
            "constraint_conflicts",
        },
    }
    status = decision.get("status")
    expected = branch_fields.get(status)
    if expected is None:
        return []
    required = common | expected
    errors = [
        f"planning decision is missing '{key}' for status '{status}'"
        for key in sorted(required - set(decision))
    ]
    errors.extend(
        f"planning decision has '{key}' which is invalid for status '{status}'"
        for key in sorted(set(decision) - required)
    )
    return errors


def _planning_contract_errors(plan: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    for node in plan["nodes"]:
        if node.get("behavior_change") and not node.get("repair_write_set"):
            errors.append(
                f"behavior-change node '{node['id']}' requires repair_write_set"
            )
        if node.get("behavior_change"):
            errors.extend(_repair_ownership_errors(node))
        if node["type"] == "validate" and (
            node.get("behavior_change")
            or node.get("write_set")
            or node.get("repair_write_set")
            or node.get("test_write_set")
        ):
            errors.append(
                f"validate node '{node['id']}' must be non-behavioral and read-only"
            )
    errors.extend(_validation_matrix_errors(plan))
    return errors


def _validation_matrix_errors(plan: dict[str, Any]) -> list[str]:
    required = {
        "format",
        "lint",
        "typecheck",
        "build",
        "targeted-test",
        "full-suite",
    }
    by_kind = {
        entry.get("kind"): entry
        for entry in plan.get("validation_matrix", [])
        if isinstance(entry, dict)
    }
    errors = [
        f"validation matrix is missing '{kind}'"
        for kind in sorted(required - set(by_kind))
    ]
    final_gates = _final_gate_names(plan)
    for kind, entry in by_kind.items():
        errors.extend(_validation_entry_errors(kind, entry, final_gates))
    return errors


def _final_gate_names(plan: dict[str, Any]) -> set[str]:
    return {
        gate["name"]
        for node in plan["nodes"]
        for gate in node["gates"]
        if gate.get("phase", "final") == "final"
    } | {
        gate["name"]
        for gate in plan.get("graph_gates", [])
        if gate.get("phase", "final") == "final"
    }


def _validation_entry_errors(
    kind: str, entry: dict[str, Any], final_gates: set[str],
) -> list[str]:
    if entry.get("status") != "covered":
        return (
            []
            if entry.get("reason")
            else [f"validation '{kind}' needs a not-applicable reason"]
        )
    names = entry.get("gate_names", [])
    errors = (
        []
        if names
        else [f"validation '{kind}' has no gate_names"]
    )
    errors.extend(
        f"validation '{kind}' references unknown final gate '{name}'"
        for name in names
        if name not in final_gates
    )
    return errors


def validate_node_envelope(envelope: dict[str, Any]) -> None:
    errs = validate_json_schema(envelope, node_envelope_schema())
    if errs:
        raise PlanValidationError(errs)


def validate_codex_review(result: dict[str, Any]) -> None:
    errs = validate_json_schema(result, codex_review_schema())
    if errs:
        raise PlanValidationError(errs)


def validate_proof_policy(policy: dict[str, Any]) -> None:
    errs = validate_json_schema(policy, repository_proof_schema())
    if errs:
        raise PlanValidationError(errs)


def content_digest(content: str | bytes) -> str:
    if isinstance(content, str):
        content = content.encode("utf-8")
    return f"sha256:{hashlib.sha256(content).hexdigest()}"


_SENSITIVE_PATTERNS = [
    re.compile(r"(?i)(api[_-]?key|token|secret|password|credential)\s*[:=]\s*\S+"),
    re.compile(r"(?i)bearer\s+\S+"),
    re.compile(r"sk-[a-zA-Z0-9]{20,}"),
    re.compile(r"ghp_[a-zA-Z0-9]{36}"),
    re.compile(r"gho_[a-zA-Z0-9]{36}"),
]


def redact_sensitive(text: str) -> str:
    """Replace known sensitive patterns with [REDACTED]."""
    for pat in _SENSITIVE_PATTERNS:
        text = pat.sub("[REDACTED]", text)
    return text
