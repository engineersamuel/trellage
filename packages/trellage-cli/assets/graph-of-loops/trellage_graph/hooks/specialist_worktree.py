"""Confine headless Graph specialists to their generated worktree."""
from __future__ import annotations

import json
import os
import shlex
import sys
from pathlib import Path
from typing import Any


_FILE_TOOLS = {"Edit", "Write"}
_SERENA_READ_ONLY_TOOLS = {
    "mcp__serena__find_file",
    "mcp__serena__find_referencing_symbols",
    "mcp__serena__find_symbol",
    "mcp__serena__get_symbols_overview",
    "mcp__serena__list_dir",
    "mcp__serena__read_file",
    "mcp__serena__search_for_pattern",
}


def _deny(reason: str) -> dict[str, Any]:
    return {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        },
    }


def _inside(path: Path, root: Path) -> bool:
    try:
        path.resolve().relative_to(root)
    except ValueError:
        return False
    return True


def _tool_path(tool_input: dict[str, Any], cwd: Path) -> Path | None:
    value = tool_input.get("file_path")
    if not isinstance(value, str) or not value:
        return None
    path = Path(value)
    return path if path.is_absolute() else cwd / path


def _bash_mentions_outside_path(command: str, root: Path, cwd: Path) -> bool:
    try:
        tokens = shlex.split(command)
    except ValueError:
        return True
    for token in tokens:
        if not token.startswith(("/", "./", "../")):
            continue
        path = Path(token)
        candidate = path if path.is_absolute() else cwd / path
        if not _inside(candidate, root):
            return True
    return False


def _validate_file_tool(
    tool_input: dict[str, Any], *, root: Path, cwd: Path,
) -> dict[str, Any] | None:
    path = _tool_path(tool_input, cwd)
    if path is not None and _inside(path, root):
        return None
    return _deny(
        f"Graph specialist writes must stay inside generated worktree {root}."
    )


def _validate_bash(
    tool_input: dict[str, Any], *, root: Path, cwd: Path,
) -> dict[str, Any] | None:
    command = tool_input.get("command")
    valid = (
        _inside(cwd, root)
        and isinstance(command, str)
        and not _bash_mentions_outside_path(command, root, cwd)
    )
    if valid:
        return None
    return _deny(
        f"Graph specialist shell commands must stay inside generated worktree {root}."
    )


def handle(
    payload: dict[str, Any], *, expected_worktree: Path,
) -> dict[str, Any] | None:
    if payload.get("hook_event_name") != "PreToolUse":
        return None
    root = expected_worktree.resolve()
    cwd_value = payload.get("cwd")
    if not isinstance(cwd_value, str) or not cwd_value:
        return _deny("Graph specialist tool call is missing its worktree cwd.")
    cwd = Path(cwd_value).resolve()
    tool_name = payload.get("tool_name")
    tool_input = payload.get("tool_input")
    if not isinstance(tool_name, str) or not isinstance(tool_input, dict):
        return _deny("Graph specialist tool call is malformed.")
    if tool_name.startswith("mcp__serena__"):
        if tool_name not in _SERENA_READ_ONLY_TOOLS:
            return _deny("Graph specialists may use Serena only for read-only discovery.")
        return None
    if tool_name in _FILE_TOOLS:
        return _validate_file_tool(tool_input, root=root, cwd=cwd)
    if tool_name == "Bash":
        return _validate_bash(tool_input, root=root, cwd=cwd)
    return None


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except json.JSONDecodeError:
        return 1
    worktree = os.environ.get("TRELLAGE_SPECIALIST_WORKTREE")
    if not worktree:
        return 1
    result = handle(payload, expected_worktree=Path(worktree))
    if result is not None:
        print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
