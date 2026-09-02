"""Fail-closed structured Codex review."""
from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path
from typing import Any

from .beads_repository import RealSubprocessRunner, SubprocessRunner
from .contracts import PlanValidationError, content_digest, validate_codex_review


class ReviewError(Exception):
    def __init__(
        self, reason: str, *, findings: list[dict[str, Any]] | None = None,
    ) -> None:
        self.reason = reason
        self.findings = findings or []
        super().__init__(reason)


def _codex_env() -> dict[str, str]:
    allowed = {
        "HOME",
        "LANG",
        "LC_ALL",
        "NO_COLOR",
        "PATH",
        "TERM",
        "TMPDIR",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "NO_PROXY",
        "http_proxy",
        "https_proxy",
        "no_proxy",
    }
    env = {key: value for key, value in os.environ.items() if key in allowed}
    env["OPENAI_API_KEY"] = "trellage-local-proxy"
    return env


def _review_was_not_completed(summary: str) -> bool:
    normalized = summary.lower()
    failure_markers = (
        "could not be completed",
        "unable to inspect",
        "could not inspect",
        "sandbox failed",
        "sandbox is unavailable",
        "bubblewrap is unavailable",
    )
    return any(marker in normalized for marker in failure_markers)


class CodexReviewGate:
    def __init__(
        self,
        *,
        runner: SubprocessRunner | None = None,
        schema_path: str | None = None,
        output_dir: Path | None = None,
        timeout_seconds: int = 900,
        **_ignored: Any,
    ) -> None:
        self._runner = runner or RealSubprocessRunner()
        self._schema_path = schema_path
        self._output_dir = output_dir
        self._timeout_seconds = timeout_seconds

    def _default_schema_path(self) -> str:
        return str(
            Path(__file__).resolve().parent.parent
            / "schemas" / "codex-review.schema.json"
        )

    def review(
        self,
        *,
        node_id: str,
        worktree_path: str,
        base_revision: str = "",
        prompt: str = "",
        model: str = "gpt-5.6-sol",
        reasoning_effort: str = "medium",
        output_dir: Path | None = None,
        **_ignored: Any,
    ) -> dict[str, Any]:
        schema = self._schema_path or self._default_schema_path()
        destination = output_dir or self._output_dir
        if destination is None:
            destination = Path(worktree_path).parent / ".trellage-graph-review"
        destination.mkdir(parents=True, exist_ok=True)
        output = destination / f"review-{node_id}.json"
        output.unlink(missing_ok=True)
        review_prompt = prompt or (
            f"Review the diff from {base_revision or 'the merge base'} to HEAD "
            f"for Graph of Loops node {node_id}. Report only critical or high "
            "confidence correctness findings. Return only the required JSON."
        )
        try:
            schema_text = Path(schema).read_text(encoding="utf-8")
        except OSError as exc:
            raise ReviewError(f"cannot load Codex review schema: {exc}") from exc
        review_input = (
            f"{review_prompt}\n\n"
            "Return only one JSON object that conforms to this schema. "
            "Do not use Markdown fences.\n"
            f"{schema_text}"
        )
        command = [
            "codex",
            "exec",
            "--ephemeral",
            "--ignore-user-config",
            "--ignore-rules",
            "--dangerously-bypass-approvals-and-sandbox",
            "--output-last-message",
            str(output),
            "-C",
            worktree_path,
            "-m",
            model,
            "-c",
            'model_provider="copilot_proxy"',
            "-c",
            f'model_reasoning_effort="{reasoning_effort}"',
            "-c",
            'model_providers.copilot_proxy.name="Copilot Proxy RS"',
            "-c",
            'model_providers.copilot_proxy.base_url="http://copilot-proxy-rs:8080/v1"',
            "-c",
            'model_providers.copilot_proxy.wire_api="responses"',
            "-c",
            "model_providers.copilot_proxy.request_max_retries=3",
            "-c",
            "model_providers.copilot_proxy.stream_max_retries=5",
            "-c",
            "model_providers.copilot_proxy.stream_idle_timeout_ms=300000",
        ]
        try:
            self._runner.run(
                command,
                cwd=worktree_path,
                env=_codex_env(),
                capture_output=True,
                text=True,
                check=True,
                timeout=self._timeout_seconds,
                input=review_input,
            )
        except FileNotFoundError as exc:
            raise ReviewError("codex binary is not installed") from exc
        except subprocess.TimeoutExpired as exc:
            raise ReviewError(
                f"codex review timed out after {self._timeout_seconds}s"
            ) from exc
        except subprocess.CalledProcessError as exc:
            raise ReviewError(f"codex exit={exc.returncode}: {exc.stderr}") from exc
        if not output.is_file():
            raise ReviewError(f"codex did not produce output: {output}")
        try:
            result = json.loads(output.read_text(encoding="utf-8"))
            validate_codex_review(result)
        except (OSError, json.JSONDecodeError, PlanValidationError) as exc:
            raise ReviewError(f"codex output is malformed or invalid: {exc}") from exc
        findings = result["findings"]
        if _review_was_not_completed(result["summary"]):
            raise ReviewError(
                f"codex review was not completed for node '{node_id}': "
                f"{result['summary']}"
            )
        if findings:
            raise ReviewError(
                f"codex review found {len(findings)} issue(s) for node '{node_id}'",
                findings=findings,
            )
        return {
            "status": "ok",
            "node_id": node_id,
            "finding_count": 0,
            "summary": result["summary"],
            "output_path": str(output),
        }

    def reject_finding(
        self,
        *,
        finding_id: str,
        node_id: str,
        evidence_path: str,
        run_dir: Path | None = None,
    ) -> dict[str, Any]:
        evidence = Path(evidence_path)
        if not evidence.is_file():
            raise ReviewError(f"rejection evidence not found: {evidence_path}")
        result = {
            "finding_id": finding_id,
            "node_id": node_id,
            "evidence_path": str(evidence.resolve()),
            "evidence_digest": content_digest(evidence.read_bytes()),
            "status": "rejected",
        }
        if run_dir is not None:
            destination = run_dir / "rejections" / f"{finding_id}.json"
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_text(
                json.dumps(result, indent=2, sort_keys=True) + "\n",
                encoding="utf-8",
            )
        return result
