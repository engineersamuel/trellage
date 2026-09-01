"""Beads 1.2.2 repository adapter.

BeadsRepository is the only mutable graph-state boundary.  All mutations
go through subprocess calls to the pinned bd CLI.  Failures are never
swallowed.

Confirmed bd 1.0.5→1.2.2 lifecycle flags:
  bd init --non-interactive --skip-agents --skip-hooks
  bd create <title> --silent --metadata <JSON> --parent <root>
  bd update <id> --status <status> --set-metadata key=value
  bd close <id> --reason <reason>
  bd reopen <id> --reason <reason>
  bd show <id> --json
  bd dep add <blocked-id> <blocker-id>

All calls use -C <repo_root> and --actor trellage-graph-controller.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
from pathlib import Path
from typing import Any, Protocol


class SubprocessRunner(Protocol):
    """Injectable subprocess boundary."""

    def run(
        self, args: list[str], *,
        capture_output: bool = True, text: bool = True,
        check: bool = True, cwd: str | None = None,
        env: dict[str, str] | None = None,
        timeout: int | None = None,
        input: str | None = None,
    ) -> subprocess.CompletedProcess[str]: ...


class RealSubprocessRunner:
    def run(
        self, args: list[str], *,
        capture_output: bool = True, text: bool = True,
        check: bool = True, cwd: str | None = None,
        env: dict[str, str] | None = None,
        timeout: int | None = None,
        input: str | None = None,
    ) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            args, capture_output=capture_output, text=text,
            check=check, cwd=cwd, env=env, timeout=timeout, input=input,
        )


_ACTOR = "trellage-graph-controller"
_BEAD_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
_METADATA_KEY = re.compile(r"^[A-Za-z_][A-Za-z0-9_.-]*$")


class BeadsError(Exception):
    """Raised when any Beads CLI operation fails.  Never swallowed."""


class BeadsRepository:
    def __init__(
        self, *, runner: SubprocessRunner | None = None,
        repo_root: str | None = None,
        beads_dir: str | None = None,
    ) -> None:
        self._runner = runner or RealSubprocessRunner()
        self._repo_root = str(Path(repo_root).resolve()) if repo_root else None
        self._beads_dir = self._resolve_beads_dir(beads_dir)

    def _resolve_beads_dir(self, beads_dir: str | None) -> str | None:
        if beads_dir is None and self._repo_root is not None:
            beads_dir = str(Path(self._repo_root) / ".beads")
        if beads_dir is None:
            return None
        if self._repo_root is None:
            raise BeadsError("beads_dir requires repo_root")
        original = Path(beads_dir)
        if original.is_symlink():
            raise BeadsError(f"Beads directory must not be a symlink: {original}")
        resolved = original.resolve()
        repo = Path(self._repo_root)
        try:
            resolved.relative_to(repo)
        except ValueError as exc:
            raise BeadsError(
                f"Beads directory is outside the worktree: {resolved}"
            ) from exc
        return str(resolved)

    def _bd(self, *args: str) -> subprocess.CompletedProcess[str]:
        cmd = ["bd", "--sandbox"]
        is_init = bool(args) and args[0] == "init"
        if self._repo_root and not is_init:
            cmd.extend(["-C", self._repo_root])
        cmd.extend(["--actor", _ACTOR])
        cmd.extend(args)
        env = None
        if self._beads_dir:
            env = os.environ.copy()
            env["BEADS_DIR"] = self._beads_dir
        cwd = self._repo_root if is_init else None
        try:
            return self._runner.run(cmd, cwd=cwd, env=env)
        except subprocess.CalledProcessError as exc:
            raise BeadsError(
                f"bd command failed: {' '.join(cmd)}\n"
                f"exit={exc.returncode} stderr={exc.stderr}"
            ) from exc
        except FileNotFoundError as exc:
            raise BeadsError("bd binary is not installed") from exc

    def ensure_initialized(self) -> None:
        """Initialize Beads noninteractively without stealth/global mutations."""
        if self._beads_dir and os.path.isfile(
            os.path.join(self._beads_dir, "metadata.json")
        ):
            return
        self._bd("init", "--non-interactive", "--skip-agents", "--skip-hooks")

    @staticmethod
    def _decode_list(result: subprocess.CompletedProcess[str], label: str) -> list[dict[str, Any]]:
        try:
            decoded = json.loads(result.stdout)
        except json.JSONDecodeError as exc:
            raise BeadsError(
                f"{label} returned invalid JSON: {result.stdout}"
            ) from exc
        if not isinstance(decoded, list) or not all(
            isinstance(value, dict) for value in decoded
        ):
            raise BeadsError(f"{label} returned an unexpected JSON value")
        return decoded

    def find_by_metadata(
        self,
        metadata: dict[str, Any],
    ) -> list[dict[str, Any]]:
        args = ["list", "--all", "--json"]
        for key in sorted(metadata):
            if not _METADATA_KEY.fullmatch(key):
                raise BeadsError(f"invalid metadata key: {key!r}")
            value = metadata[key]
            if not isinstance(value, (str, int, float, bool)):
                raise BeadsError(
                    f"metadata identity value must be scalar: {key}"
                )
            args.extend(["--metadata-field", f"{key}={value}"])
        return self._decode_list(
            self._bd(*args),
            "bd list",
        )

    def ensure_issue(
        self,
        *,
        title: str,
        metadata: dict[str, Any],
        identity: dict[str, Any] | None = None,
        parent: str | None = None,
    ) -> str:
        matches = self.find_by_metadata(identity or metadata)
        if len(matches) > 1:
            raise BeadsError(
                f"multiple Beads issues match graph identity: {identity or metadata}"
            )
        if not matches:
            return self.create(
                title=title,
                metadata=metadata,
                parent=parent,
            )
        issue = matches[0]
        issue_id = str(issue.get("id", ""))
        actual_metadata = issue.get("metadata")
        if (
            not _BEAD_ID.fullmatch(issue_id)
            or issue.get("title") != title
            or not isinstance(actual_metadata, dict)
            or any(
                actual_metadata.get(key) != value
                for key, value in metadata.items()
            )
        ):
            raise BeadsError(
                f"existing Beads issue conflicts with graph identity: {issue_id!r}"
            )
        return issue_id

    def create(
        self, *, title: str, metadata: dict[str, Any],
        parent: str | None = None,
    ) -> str:
        """Create a bead.  Returns the bead ID on stdout."""
        args = [
            "create", title, "--silent",
            "--metadata", json.dumps(metadata, separators=(",", ":")),
        ]
        if parent:
            args.extend(["--parent", parent])
        result = self._bd(*args)
        bead_id = result.stdout.strip()
        if not _BEAD_ID.fullmatch(bead_id):
            raise BeadsError(f"bd create returned invalid bead ID: {bead_id!r}")
        return bead_id

    def update_status(
        self, bead_id: str, *, status: str,
        metadata_kv: dict[str, str] | None = None,
    ) -> None:
        """Transition status and optionally set metadata key=value pairs."""
        args = ["update", bead_id, "--status", status]
        if metadata_kv:
            for k, v in metadata_kv.items():
                args.extend(["--set-metadata", f"{k}={v}"])
        self._bd(*args)

    def close(self, bead_id: str, *, reason: str = "") -> None:
        args = ["close", bead_id]
        if reason:
            args.extend(["--reason", reason])
        self._bd(*args)

    def reopen(self, bead_id: str, *, reason: str = "") -> None:
        args = ["reopen", bead_id]
        if reason:
            args.extend(["--reason", reason])
        self._bd(*args)

    def show(self, bead_id: str) -> dict[str, Any]:
        result = self._bd("show", bead_id, "--json")
        try:
            decoded = json.loads(result.stdout)
        except json.JSONDecodeError as exc:
            raise BeadsError(
                f"bd show returned invalid JSON: {result.stdout}"
            ) from exc
        if isinstance(decoded, list):
            if len(decoded) != 1 or not isinstance(decoded[0], dict):
                raise BeadsError("bd show returned an unexpected JSON array")
            return decoded[0]
        if not isinstance(decoded, dict):
            raise BeadsError("bd show returned an unexpected JSON value")
        return decoded

    def reopen_or_open(self, bead_id: str, *, reason: str) -> None:
        issue = self.show(bead_id)
        if issue.get("status") == "closed":
            self.reopen(bead_id, reason=reason)
            return
        self.update_status(
            bead_id,
            status="open",
            metadata_kv={"graph_failure": reason},
        )

    def add_dependency(self, *, blocked: str, blocker: str) -> None:
        """Add a dependency edge: blocked is blocked by blocker."""
        self._bd("dep", "add", blocked, blocker)

    def ensure_dependency(self, *, blocked: str, blocker: str) -> None:
        dependencies = self._decode_list(
            self._bd("dep", "list", blocked, "--json"),
            "bd dep list",
        )
        if any(str(value.get("id", "")) == blocker for value in dependencies):
            return
        self.add_dependency(blocked=blocked, blocker=blocker)
