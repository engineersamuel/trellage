"""Append-only JSONL evidence ledger.

- Stores metadata and content digests, never raw credentials or prompts.
- Redacts known sensitive patterns before writing.
- Uses file locking (fcntl on Unix) and fsync for durability.
- Provides deterministic normalization for comparison tests.
"""
from __future__ import annotations

import fcntl
import json
import os
import time
from pathlib import Path
from typing import Any

from .contracts import redact_sensitive, content_digest


class EvidenceLedger:
    """Append-only JSONL evidence file with locking and redaction."""

    def __init__(self, path: Path) -> None:
        self._path = path
        self._path.parent.mkdir(parents=True, exist_ok=True)

    @property
    def path(self) -> Path:
        return self._path

    def _sanitize(self, event: dict[str, Any]) -> dict[str, Any]:
        return {
            key: self._sanitize_value(value)
            for key, value in event.items()
        }

    def _sanitize_value(self, value: Any) -> Any:
        if isinstance(value, str):
            return redact_sensitive(value)
        if isinstance(value, list):
            return [self._sanitize_value(item) for item in value]
        if isinstance(value, dict):
            return {
                str(key): self._sanitize_value(item)
                for key, item in value.items()
            }
        return value

    def append(self, event: dict[str, Any]) -> None:
        record = {"ts": time.time(), **self._sanitize(event)}
        line = json.dumps(record, separators=(",", ":"), sort_keys=True) + "\n"
        fd = os.open(str(self._path), os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX)
            os.write(fd, line.encode("utf-8"))
            os.fsync(fd)
        finally:
            fcntl.flock(fd, fcntl.LOCK_UN)
            os.close(fd)

    def read_all(self) -> list[dict[str, Any]]:
        if not self._path.is_file():
            return []
        events: list[dict[str, Any]] = []
        with open(self._path, encoding="utf-8") as fh:
            for lineno, line in enumerate(fh, 1):
                stripped = line.strip()
                if not stripped:
                    continue
                try:
                    events.append(json.loads(stripped))
                except json.JSONDecodeError:
                    events.append({
                        "kind": "parse_error",
                        "line": lineno,
                        "raw_digest": content_digest(stripped),
                    })
        return events

    def normalized(self) -> list[dict[str, Any]]:
        """Return events with timestamps removed for deterministic comparison."""
        events = self.read_all()
        for e in events:
            e.pop("ts", None)
        return events

    # -- typed helpers --

    def record_transition(
        self, *, node_id: str, from_state: str, to_state: str,
        actor: str, detail: str = "",
    ) -> None:
        self.append({
            "kind": "transition", "node_id": node_id,
            "from": from_state, "to": to_state,
            "actor": actor, "detail": detail,
        })

    def record_tool_call(
        self, *, node_id: str, tool: str, status: str,
        duration_ms: int = 0, content_digest: str = "",
    ) -> None:
        self.append({
            "kind": "tool_call", "node_id": node_id,
            "tool": tool, "status": status,
            "duration_ms": duration_ms, "content_digest": content_digest,
        })

    def record_gate_result(
        self, *, node_id: str, gate_name: str, phase: str,
        passed: bool, output_digest: str = "", argv: list[str] | None = None,
    ) -> None:
        self.append({
            "kind": "gate_result", "node_id": node_id,
            "gate_name": gate_name, "phase": phase,
            "passed": passed, "output_digest": output_digest,
            "argv_digest": content_digest(" ".join(argv)) if argv else "",
        })

    def record_review(
        self, *, node_id: str, finding_count: int, passed: bool,
        detail: str = "",
    ) -> None:
        self.append({
            "kind": "review", "node_id": node_id,
            "finding_count": finding_count, "passed": passed,
            "detail": detail,
        })

    def record_proof(
        self, *, node_id: str, status: str, detail: str = "",
    ) -> None:
        self.append({
            "kind": "proof", "node_id": node_id,
            "status": status, "detail": detail,
        })

    def record_integration(
        self, *, node_id: str, method: str, commit: str = "",
        passed: bool = True, detail: str = "",
    ) -> None:
        self.append({
            "kind": "integration", "node_id": node_id,
            "method": method, "commit": commit,
            "passed": passed, "detail": detail,
        })
