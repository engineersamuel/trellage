"""Enforce the Graph profile's direct controller entrypoint."""
from __future__ import annotations

import json
import os
import re
import shlex
import sys
from pathlib import Path
from typing import Any


_SESSION_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
_TASK_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
_EXISTING_RUN_REQUEST = re.compile(
    r"\b(?:resume|status)\b.*\b[0-9a-f]{12}\b",
    re.IGNORECASE | re.DOTALL,
)
_BACKGROUND_TASK_ID = re.compile(
    r"(?:running|started|launched).*?\bbackground\b.*?"
    r"\b(?:with\s+)?(?:task|shell)?\s*(?:id)?\s*[:=]\s*"
    r"([A-Za-z0-9][A-Za-z0-9._-]{0,127})",
    re.IGNORECASE | re.DOTALL,
)
_CONTROL_TOKENS = {";", "&&", "&", "|", "||", ">", ">>", "<", "<<"}
_CONTROLLER_COMMANDS = {"run", "status", "resume", "finding"}
_CONTROLLER_TASK_TOOLS = {"TaskOutput", "TaskStop"}
_TASK_RESPONSE_WRAPPERS = ("data", "metadata", "result", "output")


def _state_path(payload: dict[str, Any], config_dir: Path) -> Path | None:
    session_id = payload.get("session_id")
    if not isinstance(session_id, str) or not _SESSION_ID.fullmatch(session_id):
        return None
    return config_dir / ".trellage" / "graph-entrypoint" / f"{session_id}.json"


def _write_state(
    path: Path,
    status: str,
    *,
    controller_task_id: str | None = None,
) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    state: dict[str, Any] = {"schema": 1, "status": status}
    if controller_task_id is not None:
        state["controller_task_id"] = controller_task_id
    temporary.write_text(
        json.dumps(state) + "\n",
        encoding="utf-8",
    )
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)


def _read_state(path: Path) -> str | None:
    if not path.is_file():
        return None
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return "invalid"
    return value.get("status") if isinstance(value, dict) else "invalid"


def _controller_task_id(path: Path) -> str | None:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    task_id = value.get("controller_task_id") if isinstance(value, dict) else None
    return task_id if isinstance(task_id, str) and task_id else None


def _known_task_id(value: Any) -> str | None:
    return (
        value
        if isinstance(value, str) and _TASK_ID.fullmatch(value)
        else None
    )


def _direct_response_task_id(response: dict[str, Any]) -> str | None:
    for key in (
        "task_id",
        "taskId",
        "shell_id",
        "shellId",
        "background_task_id",
        "backgroundTaskId",
    ):
        if task_id := _known_task_id(response.get(key)):
            return task_id
    return None


def _response_value_task_id(value: Any) -> str | None:
    if isinstance(value, dict):
        return _direct_response_task_id(value)
    if not isinstance(value, str):
        return None
    match = _BACKGROUND_TASK_ID.search(value)
    if match is None:
        return None
    return _known_task_id(match.group(1).rstrip(".,;:"))


def _response_children(value: Any) -> list[Any]:
    if isinstance(value, dict):
        return [
            value[key]
            for key in _TASK_RESPONSE_WRAPPERS
            if key in value
        ]
    return list(value) if isinstance(value, list) else []


def _response_task_id(payload: dict[str, Any]) -> str | None:
    pending: list[Any] = [payload.get("tool_response")]
    while pending:
        current = pending.pop()
        if task_id := _response_value_task_id(current):
            return task_id
        pending.extend(_response_children(current))
    return None


def _deny(reason: str) -> dict[str, Any]:
    return {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        },
    }


def _direct_graph_command(command: str) -> str | None:
    if (
        "\n" in command
        or "\r" in command
        or "`" in command
        or "$(" in command
        or "<(" in command
        or ">(" in command
    ):
        return None
    try:
        lexer = shlex.shlex(
            command,
            posix=True,
            punctuation_chars=";&|<>",
        )
        lexer.whitespace_split = True
        lexer.commenters = ""
        tokens = list(lexer)
    except ValueError:
        return None
    if len(tokens) < 2 or tokens[0] != "trellage-graph":
        return None
    if any(token in _CONTROL_TOKENS for token in tokens):
        return None
    return tokens[1]


def _handle_prompt(payload: dict[str, Any], path: Path) -> None:
    prompt = payload.get("prompt", "")
    if isinstance(prompt, str) and prompt.lstrip().startswith("/graph-of-loops"):
        status = (
            "awaiting-existing-run"
            if _EXISTING_RUN_REQUEST.search(prompt)
            else "awaiting-run"
        )
        _write_state(path, status)
    else:
        path.unlink(missing_ok=True)


def _handle_controller_task_tool(
    payload: dict[str, Any],
    path: Path,
    state: str,
) -> tuple[bool, dict[str, Any] | None]:
    tool_name = payload.get("tool_name")
    if state != "running" or tool_name not in _CONTROLLER_TASK_TOOLS:
        return False, None
    tool_input = payload.get("tool_input")
    task_id = tool_input.get("task_id") if isinstance(tool_input, dict) else None
    if task_id == _controller_task_id(path):
        return True, None
    return True, _deny(
        "Graph mode permits task output or stop only for the active "
        "trellage-graph controller task."
    )


def _handle_awaiting_skill(
    payload: dict[str, Any],
    state: str,
) -> tuple[bool, dict[str, Any] | None]:
    if state not in ("awaiting-run", "awaiting-existing-run") or payload.get("tool_name") != "Skill":
        return False, None
    tool_input = payload.get("tool_input")
    skill = tool_input.get("skill") if isinstance(tool_input, dict) else None
    if skill == "graph-of-loops":
        return True, None
    return True, _deny(
        "Graph mode permits only the graph-of-loops skill before the "
        "direct controller run."
    )


def _handle_pre_tool(
    payload: dict[str, Any], path: Path,
) -> dict[str, Any] | None:
    state = _read_state(path)
    if state is None:
        return None
    if state == "invalid":
        return _deny("Graph entrypoint state is invalid; restart the session.")
    tool_name = payload.get("tool_name")
    handled, decision = _handle_awaiting_skill(payload, state)
    if handled:
        return decision
    handled, decision = _handle_controller_task_tool(payload, path, state)
    if handled:
        return decision
    if tool_name != "Bash":
        return _deny(
            "Graph mode requires a direct trellage-graph controller command."
        )
    tool_input = payload.get("tool_input")
    command = tool_input.get("command") if isinstance(tool_input, dict) else None
    subcommand = _direct_graph_command(command) if isinstance(command, str) else None
    if state == "awaiting-run" and subcommand == "run":
        _write_state(path, "controller-pending")
        return None
    if state == "awaiting-existing-run" and subcommand in {"status", "resume"}:
        _write_state(path, "controller-pending")
        return None
    if state == "running" and subcommand in _CONTROLLER_COMMANDS:
        return None
    return _deny(
        "Use a direct trellage-graph run, status, resume, or finding command "
        "without wrappers, pipelines, redirection, or companion probes."
    )


def _handle_post_tool(
    payload: dict[str, Any],
    path: Path,
) -> None:
    state = _read_state(path)
    if state not in ("controller-pending", "running"):
        return
    tool_input = payload.get("tool_input")
    command = tool_input.get("command") if isinstance(tool_input, dict) else None
    subcommand = (
        _direct_graph_command(command)
        if payload.get("tool_name") == "Bash" and isinstance(command, str)
        else None
    )
    if state == "controller-pending" and subcommand in _CONTROLLER_COMMANDS:
        _write_state(
            path,
            "running",
            controller_task_id=_response_task_id(payload),
        )
        return
    if state == "running" and subcommand in _CONTROLLER_COMMANDS:
        task_id = _response_task_id(payload)
        if task_id is not None:
            _write_state(path, "running", controller_task_id=task_id)


def handle(
    payload: dict[str, Any], *, config_dir: Path,
) -> dict[str, Any] | None:
    path = _state_path(payload, config_dir)
    if path is None:
        return None
    event = payload.get("hook_event_name")
    if event == "UserPromptSubmit":
        _handle_prompt(payload, path)
        return None
    if event == "SessionEnd":
        path.unlink(missing_ok=True)
        return None
    if event in ("PostToolUse", "PostToolUseFailure"):
        _handle_post_tool(payload, path)
        return None
    return (
        _handle_pre_tool(payload, path)
        if event == "PreToolUse"
        else None
    )


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except json.JSONDecodeError:
        return 1
    config_dir = Path(
        os.environ.get("CLAUDE_CONFIG_DIR")
        or os.environ.get("HOME")
        or "."
    )
    result = handle(payload, config_dir=config_dir)
    if result is not None:
        print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
