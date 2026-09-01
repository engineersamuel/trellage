"""Isolated headless Claude planning and specialist execution."""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .beads_repository import RealSubprocessRunner, SubprocessRunner
from .contracts import planning_discovery_schema, validate_json_schema


_MCP_CONFIG_PATH = "/usr/local/share/trellage/claude-mcp.json"
_MANAGED_SEED = "/usr/local/share/trellage/claude-seed"
_RUNTIME_PYTHONPATH = "/opt/trellage/graph-of-loops:/opt/trellage/graph-tools"
_DISCOVERY_ROLE = "trellage-graph-discovery"
_DISCOVERY_NORMALIZER_ROLE = "trellage-graph-discovery-normalizer"
_RUNTIME_ROLES = Path(__file__).resolve().parent.parent / "roles"
_SERENA_CONFIG = Path(__file__).resolve().parent.parent / "serena_config.yml"
_SERENA_READ_ONLY_TOOLS = (
    "mcp__serena__get_symbols_overview",
    "mcp__serena__find_symbol",
    "mcp__serena__find_referencing_symbols",
    "mcp__serena__read_file",
    "mcp__serena__list_dir",
    "mcp__serena__find_file",
    "mcp__serena__search_for_pattern",
)
_DISCOVERY_TIMEOUT_SECONDS = 300
_NSS_WRAPPER_CANDIDATES = (
    Path("/usr/lib/aarch64-linux-gnu/libnss_wrapper.so"),
    Path("/usr/lib/x86_64-linux-gnu/libnss_wrapper.so"),
    Path("/usr/lib/libnss_wrapper.so"),
)
_ENV_ALLOWLIST = {
    "LANG",
    "LC_ALL",
    "NO_COLOR",
    "PATH",
    "TERM",
    "TMPDIR",
    "UV_DEFAULT_INDEX",
    "UV_INDEX_URL",
    "XDG_RUNTIME_DIR",
    "PIP_INDEX_URL",
    "npm_config_registry",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
}


class SpecialistError(Exception):
    pass


@dataclass(frozen=True)
class PlanningResult:
    plan: dict[str, Any] | None
    decision: dict[str, Any]
    serena_success: bool
    serena_fallback: bool
    tool_events: list[dict[str, Any]]
    discovery: dict[str, Any] | None = None


def _content_blocks(event: dict[str, Any]) -> list[dict[str, Any]]:
    message = event.get("message")
    if isinstance(message, dict) and isinstance(message.get("content"), list):
        return [block for block in message["content"] if isinstance(block, dict)]
    if event.get("type") in ("tool_use", "tool_result"):
        return [event]
    return []


def _result_text(event: dict[str, Any]) -> str:
    value = event.get("result", event.get("structured_output", ""))
    if isinstance(value, str):
        return value
    return json.dumps(value)


class SpecialistLauncher:
    def __init__(
        self,
        *,
        runner: SubprocessRunner | None = None,
        gateway_url: str = "http://copilot-proxy-rs:8080",
        seed_path: str = _MANAGED_SEED,
        mcp_config_path: str = _MCP_CONFIG_PATH,
        runtime_roles: Path = _RUNTIME_ROLES,
        nss_wrapper_path: Path | None = None,
    ) -> None:
        self._runner = runner or RealSubprocessRunner()
        self._gateway_url = gateway_url
        self._seed_path = Path(seed_path)
        self._mcp_config_path = mcp_config_path
        self._runtime_roles = runtime_roles
        self._nss_wrapper_path = nss_wrapper_path or next(
            (path for path in _NSS_WRAPPER_CANDIDATES if path.is_file()),
            None,
        )

    def _sanitized_env(self, config_dir: str) -> dict[str, str]:
        env = {
            key: value for key, value in os.environ.items()
            if key in _ENV_ALLOWLIST
        }
        env.update({
            "HOME": config_dir,
            "CLAUDE_CONFIG_DIR": config_dir,
            "ANTHROPIC_BASE_URL": self._gateway_url,
            "ANTHROPIC_API_KEY": "trellage-local-proxy",
            "ANTHROPIC_AUTH_TOKEN": "trellage-local-proxy",
            "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
            "PYTHONPATH": _RUNTIME_PYTHONPATH,
            "SERENA_HOME": str(Path(config_dir) / ".serena"),
        })
        env.update(self._nss_identity_env(config_dir))
        return env

    def _nss_identity_env(self, config_dir: str) -> dict[str, str]:
        if self._nss_wrapper_path is None:
            return {}
        config = Path(config_dir)
        passwd_path = config / ".nss-passwd"
        group_path = config / ".nss-group"
        passwd = Path("/etc/passwd").read_text(encoding="utf-8")
        group = Path("/etc/group").read_text(encoding="utf-8")
        if not self._contains_id(passwd, "10001"):
            passwd += "agent:x:10001:10001::/home/agent:/bin/bash\n"
        if not self._contains_id(group, "10001"):
            group += "agent:x:10001:\n"
        passwd_path.write_text(passwd, encoding="utf-8")
        group_path.write_text(group, encoding="utf-8")
        return {
            "LD_PRELOAD": str(self._nss_wrapper_path),
            "NSS_WRAPPER_PASSWD": str(passwd_path),
            "NSS_WRAPPER_GROUP": str(group_path),
        }

    @staticmethod
    def _contains_id(contents: str, numeric_id: str) -> bool:
        return any(
            fields[2] == numeric_id
            for line in contents.splitlines()
            if len(fields := line.split(":")) >= 3
        )

    def _validate_worktree(self, actual_cwd: str, expected_worktree: str) -> None:
        actual = Path(actual_cwd).resolve()
        expected = Path(expected_worktree).resolve()
        if actual != expected:
            raise SpecialistError(f"cwd '{actual}' is not expected worktree '{expected}'")
        if not actual.is_dir():
            raise SpecialistError(f"expected worktree does not exist: {actual}")
        try:
            result = self._runner.run(
                ["git", "rev-parse", "--show-toplevel"],
                cwd=str(actual),
                capture_output=True,
                text=True,
                check=True,
                timeout=15,
            )
        except (FileNotFoundError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as exc:
            raise SpecialistError(f"cannot verify worktree: {exc}") from exc
        if Path(result.stdout.strip()).resolve() != expected:
            raise SpecialistError("git worktree root does not match expected worktree")

    @staticmethod
    def _validate_role(role: str, authorized: set[str]) -> None:
        if role not in authorized:
            raise SpecialistError(f"role '{role}' is not authorized")

    @staticmethod
    def _structured_output_schema(schema_path: str) -> str:
        try:
            schema = json.loads(Path(schema_path).read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise SpecialistError(f"cannot load structured output schema: {exc}") from exc
        if not isinstance(schema, dict):
            raise SpecialistError("structured output schema must be a JSON object")
        schema.pop("$schema", None)
        return json.dumps(schema)

    @staticmethod
    def _process_failure(
        label: str,
        error: FileNotFoundError | subprocess.CalledProcessError | subprocess.TimeoutExpired,
    ) -> SpecialistError:
        if isinstance(error, subprocess.CalledProcessError):
            detail = (error.stderr or error.stdout or "").strip()
            suffix = f": {detail}" if detail else ""
            return SpecialistError(f"{label} failed with exit {error.returncode}{suffix}")
        if isinstance(error, subprocess.TimeoutExpired):
            return SpecialistError(f"{label} timed out after {error.timeout} seconds")
        return SpecialistError(f"{label} could not start: {error}")

    @staticmethod
    def _discovery_summary(discovery: dict[str, Any]) -> str:
        result = discovery.get("structured_output")
        valid_statuses = {
            "grounded",
            "target-not-found",
            "insufficient-evidence",
        }
        if isinstance(result, dict) and result.get("target_status") in valid_statuses:
            return json.dumps(result, sort_keys=True)[:12_000]
        return str(discovery["result_text"])[:12_000]

    @staticmethod
    def _validate_discovery_alignment(
        discovery: dict[str, Any] | None,
        decision: dict[str, Any],
    ) -> None:
        if not isinstance(discovery, dict):
            raise SpecialistError("structured discovery result is missing")
        target_status = discovery.get("target_status")
        if target_status not in {
            "grounded",
            "target-not-found",
            "insufficient-evidence",
        }:
            raise SpecialistError("structured discovery status is invalid")
        if target_status != "grounded" and decision.get("status") == "planned":
            raise SpecialistError(
                "planner returned a plan after discovery reported "
                f"{target_status}"
            )

    def _seed_config_dir(self, config_dir: str) -> Path:
        if not self._seed_path.is_dir():
            raise SpecialistError(f"managed Claude seed is missing: {self._seed_path}")
        destination = Path(config_dir)
        if destination.exists():
            shutil.rmtree(destination)
        shutil.copytree(self._seed_path, destination)
        settings = destination / "default-settings.json"
        if not settings.is_file():
            raise SpecialistError("managed Claude seed has no default-settings.json")
        serena_home = destination / ".serena"
        serena_home.mkdir(exist_ok=True)
        shutil.copy2(_SERENA_CONFIG, serena_home / "serena_config.yml")
        return settings

    def _role_candidates(self, role: str) -> list[Path]:
        candidates: list[Path] = []
        owned = self._runtime_roles / f"{role}.md"
        if owned.is_file():
            return [owned.resolve()]
        cache = self._seed_path / "plugins" / "cache"
        if cache.is_dir():
            for candidate in [*cache.glob("**/agents/*.md"), *cache.glob("**/commands/*.md")]:
                plugin = candidate.parent.parent.parent.name
                if candidate.stem == role or role == f"{plugin}-{candidate.stem}":
                    candidates.append(candidate)
        return sorted({candidate.resolve() for candidate in candidates})

    def _agent_definition(
        self,
        role: str,
        allowed_tools: list[str],
        disallowed_tools: list[str],
    ) -> str:
        candidates = self._role_candidates(role)
        if len(candidates) != 1:
            raise SpecialistError(
                f"role '{role}' must resolve exactly once; found {len(candidates)}"
            )
        content = candidates[0].read_text(encoding="utf-8")
        return json.dumps({
            role: {
                "description": f"Locked Graph of Loops role {role}",
                "prompt": content,
                "tools": allowed_tools,
                "disallowedTools": disallowed_tools,
            },
        })

    def _base_command(
        self,
        *,
        role: str,
        settings: Path,
        output_format: str,
        allowed_tools: list[str],
        disallowed_tools: list[str],
    ) -> list[str]:
        command = [
            "claude",
            "--print",
            "--verbose",
            "--output-format",
            output_format,
            "--no-session-persistence",
            "--agent",
            role,
            "--agents",
            self._agent_definition(role, allowed_tools, disallowed_tools),
            "--mcp-config",
            self._mcp_config_path,
            "--strict-mcp-config",
            "--settings",
            str(settings),
            "--permission-mode",
            "dontAsk",
        ]
        if allowed_tools:
            builtins = [
                value.split("(", 1)[0]
                for value in allowed_tools
                if not value.startswith("mcp__")
            ]
            command.extend(["--tools", ",".join(dict.fromkeys(builtins))])
            command.extend(["--allowed-tools", ",".join(allowed_tools)])
        if disallowed_tools:
            command.extend(["--disallowed-tools", ",".join(disallowed_tools)])
        return command

    def _run_stream(
        self,
        command: list[str],
        *,
        cwd: str,
        config_dir: str,
        role: str,
        label: str,
        prompt: str,
        timeout: int,
    ) -> dict[str, Any]:
        try:
            result = self._runner.run(
                command,
                cwd=cwd,
                env=self._sanitized_env(config_dir),
                capture_output=True,
                text=True,
                check=True,
                timeout=timeout,
                input=prompt,
            )
        except (FileNotFoundError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as exc:
            raise self._process_failure(label, exc) from exc
        parsed = self._parse_stream_json(result.stdout, role=role)
        if parsed["status"] != "ok":
            raise SpecialistError(f"{label} returned unsuccessful output")
        return parsed

    def _normalize_discovery_result(
        self,
        *,
        result_text: str,
        repo_root: str,
        config_dir: str,
        settings: Path,
        schema_text: str,
    ) -> dict[str, Any]:
        command = self._base_command(
            role=_DISCOVERY_NORMALIZER_ROLE,
            settings=settings,
            output_format="stream-json",
            allowed_tools=[],
            disallowed_tools=[
                "Agent",
                "Bash",
                "Edit",
                "Glob",
                "Grep",
                "Read",
                "WebFetch",
                "WebSearch",
                "Write",
                *_SERENA_READ_ONLY_TOOLS,
            ],
        )
        command.extend([
            "--max-turns",
            "2",
            "--json-schema",
            schema_text,
        ])
        prompt = (
            "Normalize the completed planner discovery below into exactly one "
            "JSON object matching the supplied schema. Do not inspect the "
            "repository, call tools, add evidence, infer new facts, or propose "
            "a plan. Preserve paths, symbols, coverage limits, and the exact "
            "Serena fallback error from the source. Map an evidenced "
            "`target-found` label to schema status `grounded`; otherwise use "
            "`target-not-found` or `insufficient-evidence` as supported by the "
            "source. Return JSON only, with no Markdown or commentary.\n\n"
            f"Source discovery result:\n{result_text[:12_000]}"
        )
        try:
            parsed = self._run_stream(
                command,
                cwd=repo_root,
                config_dir=config_dir,
                role=_DISCOVERY_NORMALIZER_ROLE,
                label="planner discovery normalization",
                prompt=prompt,
                timeout=60,
            )
            normalized = self._structured_result(
                parsed,
                label="normalized discovery result",
            )
            fallback = normalized.pop("TRELLAGE_SERENA_FALLBACK", None)
            if (
                isinstance(fallback, str)
                and fallback
                and not normalized.get("serena_fallback")
            ):
                normalized["serena_fallback"] = fallback
            if not normalized.get("summary"):
                status = normalized.get(
                    "target_status",
                    "insufficient-evidence",
                )
                normalized["summary"] = (
                    f"Planner discovery completed with status {status}."
                )
            errors = validate_json_schema(
                normalized,
                planning_discovery_schema(),
            )
            if errors:
                raise SpecialistError(
                    "normalized discovery result failed schema validation: "
                    + "; ".join(errors)
                )
            return normalized
        except SpecialistError as exc:
            raise SpecialistError(
                "structured discovery result is missing; "
                f"normalization failed: {exc}"
            ) from exc

    @staticmethod
    def _discovery_normalization_source(
        discovery: dict[str, Any],
    ) -> str:
        structured = discovery.get("structured_output")
        if isinstance(structured, dict):
            return json.dumps(structured, sort_keys=True)
        return str(discovery.get("result_text", ""))

    def _run_planner_discovery(
        self,
        *,
        objective: str,
        constraints: list[str],
        repo_root: str,
        config_dir: str,
        settings: Path,
        schema_text: str,
        timeout: int,
    ) -> dict[str, Any]:
        command = self._base_command(
            role=_DISCOVERY_ROLE,
            settings=settings,
            output_format="stream-json",
            allowed_tools=list(_SERENA_READ_ONLY_TOOLS),
            disallowed_tools=[
                "Agent",
                "Bash",
                "Edit",
                "Glob",
                "Grep",
                "Read",
                "WebFetch",
                "WebSearch",
                "Write",
            ],
        )
        command.extend([
            "--max-turns",
            "16",
            "--json-schema",
            schema_text,
        ])
        prompt = (
            "Perform planner-time semantic discovery for this objective using "
            "Serena. Call a Serena symbol or reference tool. If the repository "
            "language is unavailable to Serena's active language servers, use "
            "the authorized Serena file and pattern tools as a read-only "
            "fallback and report the exact language-server failure. Do not stop "
            "after a failed symbol or reference lookup. When the objective "
            "names a target path, inspect its manifest, source and test seams, "
            "the repository-root validation entrypoint, and required locked "
            "profile or materializer evidence before choosing insufficient "
            "evidence. Return a "
            "concise structured result with target status, repository evidence, "
            "relevant symbols and paths, coverage limits, and a concise summary. "
            "Inspect repository-root instructions and validation entrypoints "
            "such as AGENTS.md and Makefile when they exist. When the request "
            "depends on a locked toolchain, target architecture, cross target, "
            "or linker, inspect the profile lock and materializer paths that "
            "prove those capabilities before reporting the target grounded. "
            "Use no more than twelve Serena tool calls and stop discovery once "
            "the target and relevant seams have sufficient evidence. Your final "
            "response MUST be exactly one JSON object matching the supplied "
            "schema, with no Markdown or commentary. `target_status` MUST be "
            "exactly `grounded`, `target-not-found`, or "
            "`insufficient-evidence`. "
            f"Objective: {objective}\nConstraints: {json.dumps(constraints)}\n"
            "If Serena fails or cannot support the repository language, include "
            "TRELLAGE_SERENA_FALLBACK:<exact tool failure> in the final result. "
            "Do not ask questions and do not propose a plan yet."
        )
        discovery = self._run_stream(
            command,
            cwd=repo_root,
            config_dir=config_dir,
            role=_DISCOVERY_ROLE,
            label="planner discovery",
            prompt=prompt,
            timeout=min(timeout, _DISCOVERY_TIMEOUT_SECONDS),
        )
        if not (discovery["serena_success"] or discovery["serena_fallback"]):
            raise self._missing_serena_error(discovery)
        try:
            structured = self._validated_structured_result(
                discovery,
                label="structured discovery result",
                schema=planning_discovery_schema(),
            )
        except SpecialistError as exc:
            message = str(exc)
            if not (
                message.startswith("structured discovery result is missing")
                or message.startswith(
                    "structured discovery result failed schema validation"
                )
            ):
                raise
            structured = self._normalize_discovery_result(
                result_text=self._discovery_normalization_source(discovery),
                repo_root=repo_root,
                config_dir=config_dir,
                settings=settings,
                schema_text=schema_text,
            )
        structured = self._normalize_discovery_paths(
            structured,
            repo_root=repo_root,
        )
        discovery["structured_output"] = structured
        if discovery["serena_fallback"] and not structured.get("serena_fallback"):
            failures = discovery.get("serena_failures")
            exact_failure = (
                failures[0]
                if isinstance(failures, list)
                and failures
                and isinstance(failures[0], str)
                else None
            )
            if exact_failure is None:
                raise SpecialistError(
                    "structured discovery fallback evidence is missing"
                )
            structured = {
                **structured,
                "serena_fallback": exact_failure,
            }
            errors = validate_json_schema(
                structured,
                planning_discovery_schema(),
            )
            if errors:
                raise SpecialistError(
                    "structured discovery fallback evidence failed schema "
                    f"validation: {'; '.join(errors)}"
                )
            discovery["structured_output"] = structured
        return discovery

    @staticmethod
    def _normalize_discovery_paths(
        discovery: dict[str, Any],
        *,
        repo_root: str,
    ) -> dict[str, Any]:
        normalized = dict(discovery)
        root = Path(repo_root).resolve()

        def normalized_path(value: Any) -> Any:
            if not isinstance(value, str):
                return value
            candidate = (root / value).resolve()
            if candidate.exists():
                return value
            stripped = re.sub(r"\s+\([^()]+\)$", "", value)
            if stripped != value and (root / stripped).resolve().exists():
                return stripped
            return value

        def normalized_paths(value: Any) -> list[Any]:
            normalized_value = normalized_path(value)
            if not isinstance(normalized_value, str):
                return [normalized_value]
            if (root / normalized_value).resolve().exists():
                return [normalized_value]
            stripped = re.sub(r"\s+\([^()]+\)$", "", normalized_value)
            parts = stripped.split(" / ")
            if len(parts) < 2:
                return [normalized_value]
            first = Path(parts[0])
            resolved: list[str] = []
            for index, part in enumerate(parts):
                candidates = [Path(part)]
                if index > 0:
                    candidates.append(first.parent / part)
                existing = next(
                    (
                        candidate
                        for candidate in candidates
                        if (root / candidate).resolve().exists()
                    ),
                    None,
                )
                if existing is None:
                    return [normalized_value]
                resolved.append(existing.as_posix())
            return resolved

        evidence = normalized.get("repository_evidence")
        if isinstance(evidence, list):
            normalized_evidence: list[Any] = []
            for entry in evidence:
                if not isinstance(entry, dict):
                    normalized_evidence.append(entry)
                    continue
                normalized_evidence.extend(
                    {**entry, "path": path}
                    for path in normalized_paths(entry.get("path"))
                )
            normalized["repository_evidence"] = normalized_evidence
        paths = normalized.get("relevant_paths")
        if isinstance(paths, list):
            normalized["relevant_paths"] = [
                normalized_path
                for path in paths
                for normalized_path in normalized_paths(path)
            ]
        return normalized

    def launch(
        self,
        *,
        role: str,
        agent_name: str | None = None,
        prompt: str,
        worktree_path: str,
        expected_worktree: str,
        config_dir: str,
        authorized_roles: set[str],
        settings_path: str | None = None,
        allowed_tools: list[str] | None = None,
        disallowed_tools: list[str] | None = None,
        json_schema_path: str | None = None,
        timeout: int = 1800,
    ) -> dict[str, Any]:
        del agent_name
        self._validate_role(role, authorized_roles)
        self._validate_worktree(worktree_path, expected_worktree)
        settings = self._seed_config_dir(config_dir)
        if settings_path is not None:
            settings = Path(settings_path)
        command = self._base_command(
            role=role,
            settings=settings,
            output_format="stream-json",
            allowed_tools=allowed_tools or [],
            disallowed_tools=disallowed_tools or [],
        )
        if json_schema_path is not None:
            schema_text = self._structured_output_schema(json_schema_path)
            command.extend(["--json-schema", schema_text])
        return self._run_stream(
            command,
            cwd=worktree_path,
            config_dir=config_dir,
            role=role,
            label=f"specialist '{role}'",
            prompt=prompt,
            timeout=timeout,
        )

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
    ) -> PlanningResult:
        self._validate_worktree(repo_root, repo_root)
        settings = self._seed_config_dir(config_dir)
        del schema_path
        decision_schema = (
            Path(__file__).resolve().parent.parent
            / "schemas" / "planning-decision.schema.json"
        )
        discovery_schema = (
            Path(__file__).resolve().parent.parent
            / "schemas" / "planning-discovery.schema.json"
        )
        schema_text = self._structured_output_schema(str(decision_schema))
        discovery_schema_text = self._structured_output_schema(
            str(discovery_schema)
        )
        discovery = self._run_planner_discovery(
            objective=objective,
            constraints=constraints,
            repo_root=repo_root,
            config_dir=config_dir,
            settings=settings,
            schema_text=discovery_schema_text,
            timeout=timeout,
        )
        structured_discovery = discovery["structured_output"]
        discovery_summary = self._discovery_summary(discovery)

        command = self._base_command(
            role=role,
            settings=settings,
            output_format="stream-json",
            allowed_tools=[
                "Read",
                "Glob",
                "Grep",
                "Bash(git status:*)",
                "Bash(git rev-parse:*)",
                *_SERENA_READ_ONLY_TOOLS,
            ],
            disallowed_tools=[
                "Agent",
                "Edit",
                "Write",
                "WebFetch",
                "WebSearch",
            ],
        )
        command.extend(["--json-schema", schema_text])
        planning_prompt = (
            "Return one planning decision for this objective. Preserve the "
            "objective and constraints exactly. Return status=blocked with a "
            "stable reason code when the requested target is absent, the "
            "constraints conflict with the repository, or discovery is "
            "insufficient. Do not reinterpret an unrelated existing surface "
            "as the requested target and do not invent a subsystem, endpoint, "
            "event schema, or storage mechanism. Return status=planned only "
            "when repository evidence grounds the target and every selected "
            "module seam. "
            f"Objective: {objective}\nConstraints: {json.dumps(constraints)}\n"
            "Planner-time Serena discovery completed before this planning phase. "
            f"Discovery summary:\n{discovery_summary}\n"
            "Use that discovery before choosing module seams, file ownership, or "
            "parallel write sets. Use the current Git "
            "HEAD as base_revision. Include each node prompt and its exact "
            "sha256: digest. Gate argv must invoke one direct executable or a "
            "checked-in repository script; never embed source with shell -c, "
            "Python -c, Node -e, or equivalent flags. Request no delivery "
            "authorization."
        )
        parsed = self._run_stream(
            command,
            cwd=repo_root,
            config_dir=config_dir,
            role=role,
            label="planner",
            prompt=planning_prompt,
            timeout=timeout,
        )
        decision = parsed.get("structured_output")
        if not isinstance(decision, dict):
            raw = parsed.get("result_text")
            if isinstance(raw, str):
                try:
                    decision = self._decode_json_result(raw)
                except (json.JSONDecodeError, ValueError) as exc:
                    excerpt = " ".join(raw.split())[:500]
                    raise SpecialistError(
                        "planner produced no valid plan; "
                        f"result: {excerpt}"
                    ) from exc
        if not isinstance(decision, dict):
            raise SpecialistError("planner returned no structured output")
        decision = self._normalize_planning_decision(
            decision,
            objective=objective,
            constraints=constraints,
            discovery=structured_discovery,
        )
        status = decision.get("status")
        if status not in ("planned", "blocked"):
            raise SpecialistError("planner returned an invalid decision status")
        plan = decision.get("plan") if status == "planned" else None
        if status == "planned" and not isinstance(plan, dict):
            raise SpecialistError("planned decision has no graph plan")
        self._validate_discovery_alignment(
            structured_discovery,
            decision,
        )
        return PlanningResult(
            plan=plan,
            decision=decision,
            serena_success=bool(discovery["serena_success"]),
            serena_fallback=bool(discovery["serena_fallback"]),
            tool_events=(
                list(discovery["tool_events"]) + list(parsed["tool_events"])
            ),
            discovery=structured_discovery,
        )

    @staticmethod
    def _normalize_planning_decision(
        decision: dict[str, Any],
        *,
        objective: str,
        constraints: list[str],
        discovery: dict[str, Any],
    ) -> dict[str, Any]:
        normalized = dict(decision)
        status = normalized.get("status")
        nested_decision = normalized.get("decision")
        if (
            status not in {"planned", "blocked"}
            and isinstance(nested_decision, dict)
            and nested_decision.get("status") in {"planned", "blocked"}
        ):
            normalized = {
                **{
                    key: value
                    for key, value in normalized.items()
                    if key != "decision"
                },
                **nested_decision,
            }
            status = normalized.get("status")
        normalized["objective"] = objective
        normalized["constraints"] = list(constraints)
        if status == "planned":
            return SpecialistLauncher._normalize_planned_decision(
                normalized,
                objective=objective,
                constraints=constraints,
                discovery=discovery,
            )
        elif status == "blocked":
            return SpecialistLauncher._normalize_blocked_decision(
                normalized,
                discovery=discovery,
            )
        return normalized

    @staticmethod
    def _normalize_planned_decision(
        decision: dict[str, Any],
        *,
        objective: str,
        constraints: list[str],
        discovery: dict[str, Any],
    ) -> dict[str, Any]:
        for key in (
            "reason_code",
            "summary",
            "evidence",
            "constraint_conflicts",
            "target_status",
            "reconciliation",
            "grounding",
            "constraint_reconciliation",
            "notes",
            "decision",
        ):
            decision.pop(key, None)
        plan = decision.get("plan")
        if not isinstance(plan, dict):
            graph_plan = decision.pop("graph_plan", None)
            if isinstance(graph_plan, dict):
                plan = graph_plan
        if isinstance(plan, dict):
            normalized_plan = dict(plan)
            normalized_plan["objective"] = objective
            normalized_plan["constraints"] = list(constraints)
            decision["plan"] = (
                SpecialistLauncher._normalize_plan_prompt_digests(
                    normalized_plan
                )
            )
        evidence = discovery.get("repository_evidence")
        if isinstance(evidence, list):
            decision["target_evidence"] = evidence
        return decision

    @staticmethod
    def _normalize_blocked_decision(
        decision: dict[str, Any],
        *,
        discovery: dict[str, Any],
    ) -> dict[str, Any]:
        for key in (
            "target_evidence",
            "plan",
            "graph_plan",
            "target_status",
            "reconciliation",
            "grounding",
        ):
            decision.pop(key, None)
        if not decision.get("summary"):
            decision["summary"] = str(
                discovery.get("summary", "Planning is blocked.")
            )
        if not isinstance(decision.get("constraint_conflicts"), list):
            decision["constraint_conflicts"] = []
        if not isinstance(decision.get("evidence"), list):
            evidence = discovery.get("repository_evidence")
            decision["evidence"] = (
                evidence if isinstance(evidence, list) else []
            )
        if decision.get("reason_code") not in {
            "target-not-found",
            "constraint-conflict",
            "insufficient-evidence",
        }:
            decision["reason_code"] = (
                "target-not-found"
                if discovery.get("target_status") == "target-not-found"
                else "insufficient-evidence"
            )
        return decision

    @staticmethod
    def _normalize_plan_prompt_digests(
        plan: dict[str, Any],
    ) -> dict[str, Any]:
        normalized = dict(plan)
        nodes = normalized.get("nodes")
        if not isinstance(nodes, list):
            return normalized
        normalized_nodes: list[Any] = []
        for value in nodes:
            if not isinstance(value, dict):
                normalized_nodes.append(value)
                continue
            node = dict(value)
            prompt = node.get("prompt")
            if isinstance(prompt, str) and prompt:
                digest = hashlib.sha256(prompt.encode("utf-8")).hexdigest()
                node["prompt_digest"] = f"sha256:{digest}"
            normalized_nodes.append(node)
        normalized["nodes"] = normalized_nodes
        return normalized

    @staticmethod
    def _decode_json_result(raw: str) -> Any:
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            blocks = re.findall(
                r"```(?:json)?\s*(\{.*?\})\s*```",
                raw,
                flags=re.DOTALL | re.IGNORECASE,
            )
            if len(blocks) != 1:
                raise ValueError("expected exactly one fenced JSON object")
            return json.loads(blocks[0])

    @classmethod
    def _structured_result(
        cls,
        parsed: dict[str, Any],
        *,
        label: str,
    ) -> dict[str, Any]:
        value = parsed.get("structured_output")
        if not isinstance(value, dict):
            raw = parsed.get("result_text")
            if isinstance(raw, str) and raw.strip():
                try:
                    value = cls._decode_json_result(raw)
                except (json.JSONDecodeError, ValueError):
                    value = None
        if not isinstance(value, dict):
            excerpt = " ".join(str(parsed.get("result_text", "")).split())[:500]
            suffix = f"; result: {excerpt}" if excerpt else ""
            raise SpecialistError(f"{label} is missing{suffix}")
        return value

    @classmethod
    def _validated_structured_result(
        cls,
        parsed: dict[str, Any],
        *,
        label: str,
        schema: dict[str, Any],
    ) -> dict[str, Any]:
        value = cls._structured_result(parsed, label=label)
        errors = validate_json_schema(value, schema)
        if errors:
            raise SpecialistError(
                f"{label} failed schema validation: {'; '.join(errors)}"
            )
        return value

    @staticmethod
    def _missing_serena_error(parsed: dict[str, Any]) -> SpecialistError:
        observed_tools = sorted({
            str(event.get("name"))
            for event in parsed["tool_events"]
            if event.get("type") == "tool_use" and event.get("name")
        })
        event_types = ", ".join(parsed["event_types"]) or "none"
        tool_names = ", ".join(observed_tools) or "none"
        available = ", ".join(parsed["available_tools"]) or "none"
        mcp_status = ", ".join(parsed["mcp_status"]) or "none"
        result_text = " ".join(str(parsed["result_text"]).split())[:500] or "none"
        return SpecialistError(
            "Serena discovery or explicit fallback evidence is missing; "
            f"stream events: {event_types}; tools: {tool_names}; "
            f"available: {available}; MCP: {mcp_status}; result: {result_text}"
        )

    def _parse_stream_json(self, output: str, *, role: str) -> dict[str, Any]:
        uses: dict[str, str] = {}
        successful: set[str] = set()
        state = {
            "failed_serena": False,
            "fallback_marker": False,
            "completed": False,
            "structured_output": None,
            "result_text": "",
            "serena_failures": [],
        }
        tool_events: list[dict[str, Any]] = []
        event_types: set[str] = set()
        available_tools: set[str] = set()
        mcp_status: set[str] = set()
        for raw_line in output.splitlines():
            event = self._decode_stream_event(raw_line)
            if event is None:
                continue
            event_types.add(str(event.get("type", "unknown")))
            self._record_init_state(event, available_tools, mcp_status)
            self._record_result_state(event, state)
            for block in _content_blocks(event):
                self._record_tool_block(
                    block,
                    uses=uses,
                    successful=successful,
                    state=state,
                    tool_events=tool_events,
                )
        return {
            "status": "ok" if state["completed"] else "error",
            "role": role,
            "output_digest": hashlib.sha256(output.encode()).hexdigest(),
            "serena_success": self._has_serena_success(uses, successful),
            "serena_fallback": (
                state["failed_serena"] and state["fallback_marker"]
            ),
            "serena_failures": list(state["serena_failures"]),
            "tool_events": tool_events,
            "event_types": sorted(event_types),
            "available_tools": sorted(available_tools),
            "mcp_status": sorted(mcp_status),
            "structured_output": state["structured_output"],
            "result_text": state["result_text"],
        }

    @staticmethod
    def _record_init_state(
        event: dict[str, Any],
        available_tools: set[str],
        mcp_status: set[str],
    ) -> None:
        if event.get("type") != "system" or event.get("subtype") != "init":
            return
        available_tools.update(str(tool) for tool in event.get("tools", []))
        mcp_status.update(
            f"{server.get('name', 'unknown')}={server.get('status', 'unknown')}"
            for server in event.get("mcp_servers", [])
            if isinstance(server, dict)
        )

    @staticmethod
    def _decode_stream_event(raw_line: str) -> dict[str, Any] | None:
        try:
            event = json.loads(raw_line)
        except json.JSONDecodeError:
            return None
        return event if isinstance(event, dict) else None

    @staticmethod
    def _record_result_state(
        event: dict[str, Any], state: dict[str, Any],
    ) -> None:
        if event.get("type") != "result":
            return
        state["completed"] = event.get("subtype", "success") == "success"
        state["structured_output"] = event.get("structured_output")
        state["result_text"] = _result_text(event)
        state["fallback_marker"] = (
            "TRELLAGE_SERENA_FALLBACK:" in state["result_text"]
        )

    @staticmethod
    def _record_tool_block(
        block: dict[str, Any],
        *,
        uses: dict[str, str],
        successful: set[str],
        state: dict[str, Any],
        tool_events: list[dict[str, Any]],
    ) -> None:
        block_type = block.get("type")
        if block_type == "tool_use":
            tool_id = str(block.get("id", ""))
            tool_name = str(block.get("name", ""))
            uses[tool_id] = tool_name
            tool_events.append({
                "type": "tool_use",
                "id": tool_id,
                "name": tool_name,
            })
            return
        if block_type != "tool_result":
            return
        tool_id = str(block.get("tool_use_id", ""))
        is_error = bool(block.get("is_error", False))
        tool_name = uses.get(tool_id, "")
        tool_events.append({
            "type": "tool_result",
            "tool_use_id": tool_id,
            "is_error": is_error,
        })
        if "serena" not in tool_name.lower():
            return
        if is_error:
            state["failed_serena"] = True
            content = block.get("content")
            if isinstance(content, str) and content.strip():
                state["serena_failures"].append(content.strip())
        else:
            successful.add(tool_id)

    @staticmethod
    def _has_serena_success(
        uses: dict[str, str], successful: set[str],
    ) -> bool:
        return any(
            tool_id in successful
            and any(
                term in name.lower()
                for term in (
                    "symbol",
                    "reference",
                    "read_file",
                    "list_dir",
                    "find_file",
                    "search_for_pattern",
                )
            )
            for tool_id, name in uses.items()
        )
