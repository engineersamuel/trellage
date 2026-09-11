#!/usr/bin/env python3

import argparse
import fcntl
import hashlib
import io
import json
import os
import random
import re
import secrets
import shlex
import socket
import stat
import sys
import tempfile
import time
import unicodedata
from pathlib import Path
from contextlib import contextmanager
from datetime import datetime, timezone


MAX_HOOK_BYTES = 1024 * 1024
MAX_MAPPING_BYTES = 16 * 1024
MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024
MAX_TRANSCRIPT_HEAD_BYTES = 512 * 1024
MAX_ANSWER_CHARS = 60_000
AGENTS = {"copilot", "codex", "claude"}
SAFE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$")
SAFE_PROFILE_NAME = re.compile(r"^[a-z0-9][a-z0-9-]*$")
SAFE_SESSION_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$")
SAFE_INVOCATION_ID = re.compile(r"^[a-f0-9]{32}$")
SAFE_SNAPSHOT_ID = re.compile(r"^[a-f0-9]{64}$")
SAFE_CURSOR = re.compile(r"^[a-f0-9]{128}$")
CSI = re.compile(r"(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]")
OSC = re.compile(r"(?:\x1b\]|\x9d)[\s\S]*?(?:\x07|\x1b\\|$)")
UNSUPPORTED_CONTROLS = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]")
TOKEN = re.compile(r"(?<![A-Za-z0-9_])(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{24,})(?![A-Za-z0-9_])")
PRIVATE_KEY = re.compile(r"-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----[\s\S]*?(?:-----END(?: [A-Z0-9]+)? PRIVATE KEY-----|$)")
ASSIGNED_DOUBLE = re.compile(r'''["']?(?a:\b)(?:api[_-]?key|access[_-]?token|password|client[_-]?secret)(?a:\b)["']?\s*(?:[:=]\s*)"((?:\\[\s\S]|[^"\\\r\n]){12,})"''', re.I)
ASSIGNED_SINGLE = re.compile(r'''["']?(?a:\b)(?:api[_-]?key|access[_-]?token|password|client[_-]?secret)(?a:\b)["']?\s*(?:[:=]\s*)'((?:\\[\s\S]|[^'\\\r\n]){12,})' ''', re.I | re.X)
ASSIGNED_UNQUOTED = re.compile(r'''["']?(?a:\b)(?:api[_-]?key|access[_-]?token|password|client[_-]?secret)(?a:\b)["']?\s*(?:[:=]\s*)(?!["'])([^\s,;}\]"']{12,})''', re.I)
CONVERSATION_COMMANDS = {
    "export-conversation", "describe-conversation", "release-conversation"
}
CONVERSATION_HARD_LIMITS = {
    "source_bytes": 64 * 1024 * 1024,
    "record_bytes": 1024 * 1024,
    "normalized_bytes": 32 * 1024 * 1024,
    "page_bytes": 2 * 1024 * 1024,
    "messages": 50_000,
    "records": 200_000,
    "pages": 512,
    "snapshots": 8,
    "snapshot_seconds": 900,
}
CONVERSATION_POLICY = CONVERSATION_HARD_LIMITS.copy()
MAX_SNAPSHOT_BYTES = 40 * 1024 * 1024


class BridgeError(Exception):
    pass


def require_pattern(value, pattern, label):
    if not isinstance(value, str) or pattern.fullmatch(value) is None:
        raise BridgeError(f"{label} is missing or invalid")
    return value


def read_hook_input():
    source = sys.stdin.buffer.read(MAX_HOOK_BYTES + 1)
    if len(source) > MAX_HOOK_BYTES:
        raise BridgeError("hook input is too large")
    if not source.strip():
        return {}
    try:
        value = json.loads(source)
    except json.JSONDecodeError as error:
        raise BridgeError(f"hook input is not valid JSON: {error.msg}") from error
    if not isinstance(value, dict):
        raise BridgeError("hook input must be a JSON object")
    return value


def text_field(payload, *names):
    for name in names:
        value = payload.get(name)
        if isinstance(value, str) and value:
            return value
    return None


def normalized_event(payload):
    event = text_field(payload, "hook_event_name", "hookEventName")
    return "" if event is None else event.replace("_", "").replace("-", "").lower()


def session_from_hook(agent, payload):
    event = normalized_event(payload)
    if event and event != "sessionstart":
        raise BridgeError("hook event is not SessionStart")
    if agent == "copilot" and not event:
        non_session_fields = (
            "prompt",
            "tool_name",
            "toolName",
            "notification_type",
            "notificationType",
            "stop_reason",
            "stopReason",
            "reason",
        )
        if any(payload.get(name) is not None for name in non_session_fields):
            raise BridgeError("Copilot hook input is not a session start")
    if agent == "claude" and payload.get("agent_id"):
        raise BridgeError("Claude subagent sessions are not eligible")

    session_id = text_field(payload, "session_id", "sessionId")
    require_pattern(session_id, SAFE_SESSION_ID, "session ID")
    transcript_path = text_field(payload, "transcript_path", "transcriptPath")
    if agent in {"codex", "claude"} and transcript_path is None:
        raise BridgeError("transcript path is missing")
    inherited_codex_id = os.environ.get("CODEX_THREAD_ID")
    if agent == "codex" and inherited_codex_id and inherited_codex_id != session_id:
        raise BridgeError("Codex inherited session ID conflicts with the hook input")
    return {"session_id": session_id, "transcript_path": transcript_path}


def send_herdr_request(request):
    socket_path = os.environ.get("HERDR_SOCKET_PATH")
    if os.environ.get("HERDR_ENV") != "1" or not socket_path or not os.environ.get("HERDR_PANE_ID"):
        return None
    encoded = (json.dumps(request, separators=(",", ":")) + "\n").encode()
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
        client.settimeout(0.5)
        client.connect(socket_path)
        client.sendall(encoded)
        response = bytearray()
        while b"\n" not in response:
            chunk = client.recv(4096)
            if not chunk:
                raise BridgeError("Herdr metadata socket closed without a response")
            response.extend(chunk)
            if len(response) > 65536:
                raise BridgeError("Herdr metadata response is too large")
    try:
        envelope = json.loads(bytes(response).split(b"\n", 1)[0])
    except (UnicodeError, json.JSONDecodeError) as error:
        raise BridgeError("Herdr metadata response is not valid JSON") from error
    if envelope.get("id") != request["id"]:
        raise BridgeError("Herdr metadata response ID does not match")
    if envelope.get("error") is not None:
        raise BridgeError(f"Herdr metadata request failed: {envelope['error']}")
    return envelope.get("result")


def require_herdr_agent(result, pane_id, agent):
    info = result.get("agent") if isinstance(result, dict) else None
    sequence = info.get("state_change_seq") if isinstance(info, dict) else None
    if (
        not isinstance(sequence, int)
        or isinstance(sequence, bool)
        or sequence < 0
        or sequence > (2**53 - 2) // 2
        or info.get("pane_id") != pane_id
        or info.get("agent") != agent
        or info.get("agent_status") != "working"
    ):
        raise BridgeError("Herdr did not return the current working agent")
    return sequence


def require_herdr_process_group(result, pane_id):
    process_info = result.get("process_info") if isinstance(result, dict) else None
    process_group = (
        process_info.get("foreground_process_group_id")
        if isinstance(process_info, dict)
        else None
    )
    if (
        not isinstance(process_group, int)
        or isinstance(process_group, bool)
        or process_group <= 0
        or process_info.get("pane_id") != pane_id
    ):
        raise BridgeError("Herdr did not return the current foreground process group")
    return process_group


def herdr_agent_context(agent):
    pane_id = os.environ.get("HERDR_PANE_ID")
    request_id = f"trellage.agent-get:{int(time.time() * 1000)}:{random.randrange(1_000_000):06d}"
    agent_result = send_herdr_request(
        {
            "id": request_id,
            "method": "agent.get",
            "params": {"target": pane_id},
        }
    )
    process_result = send_herdr_request(
        {
            "id": f"trellage.process-info:{int(time.time() * 1000)}:{random.randrange(1_000_000):06d}",
            "method": "pane.process_info",
            "params": {"pane_id": pane_id},
        }
    )
    return (
        require_herdr_agent(agent_result, pane_id, agent),
        require_herdr_process_group(process_result, pane_id),
    )


def report_native_session(agent, profile, session):
    pane_id = os.environ.get("HERDR_PANE_ID")
    if not pane_id:
        return
    state_change_seq, process_group = herdr_agent_context(agent)
    source = "trellage.guide-handoff"
    request = {
        "id": f"{source}:{int(time.time() * 1000)}:{random.randrange(1_000_000):06d}",
        "method": "pane.report_metadata",
        "params": {
            "pane_id": pane_id,
            "source": source,
            "agent": agent,
            "tokens": {
                "trellage_surface": "native",
                "trellage_agent": agent,
                "trellage_profile": profile,
                "trellage_session_id": session["session_id"],
                "trellage_state_seq": str(state_change_seq),
                "trellage_pgrp": str(process_group),
            },
            "seq": state_change_seq * 2 + 1,
        },
    }
    send_herdr_request(request)


def bridge_directory():
    home = Path(os.environ.get("HOME", ""))
    if not home.is_absolute():
        raise BridgeError("HOME must be an absolute path")
    current = home
    for name in (".trellage", "herdr-session-bridge"):
        metadata = current.lstat()
        if not stat.S_ISDIR(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
            raise BridgeError(f"{current} is not a regular directory")
        current /= name
        try:
            current.mkdir(mode=0o700)
        except FileExistsError:
            pass
    metadata = current.lstat()
    if not stat.S_ISDIR(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
        raise BridgeError("session bridge path is not a regular directory")
    os.chmod(current, 0o700)
    return current


def atomic_write_json(target, value):
    descriptor, temporary = tempfile.mkstemp(prefix=".mapping-", dir=target.parent)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            descriptor = -1
            json.dump(value, handle, separators=(",", ":"), sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, target)
        directory_descriptor = os.open(target.parent, os.O_RDONLY)
        try:
            os.fsync(directory_descriptor)
        finally:
            os.close(directory_descriptor)
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def read_json_object(file_path):
    if not file_path.exists():
        return {}
    source = read_bounded_regular_file(file_path, MAX_TRANSCRIPT_BYTES)
    try:
        value = json.loads(source)
    except json.JSONDecodeError as error:
        raise BridgeError(f"{file_path} is not valid JSON: {error.msg}") from error
    if not isinstance(value, dict):
        raise BridgeError(f"{file_path} must contain a JSON object")
    return value


def hooks_object(settings, file_path):
    hooks = settings.setdefault("hooks", {})
    if not isinstance(hooks, dict):
        raise BridgeError(f"{file_path} hooks must be a JSON object")
    return hooks


def event_entries(hooks, file_path):
    entries = hooks.setdefault("SessionStart", [])
    if not isinstance(entries, list):
        raise BridgeError(f"{file_path} SessionStart hooks must be a JSON array")
    return entries


def install_copilot_hook(config_dir, command):
    settings_path = config_dir / "settings.json"
    settings = read_json_object(settings_path)
    entries = event_entries(hooks_object(settings, settings_path), settings_path)
    installed = any(
        isinstance(entry, dict)
        and entry.get("type") == "command"
        and (entry.get("bash") == command or entry.get("command") == command)
        for entry in entries
    )
    if not installed:
        entries.append({"type": "command", "bash": command, "timeoutSec": 10})
        atomic_write_json(settings_path, settings)


def install_nested_hook(config_dir, agent, command):
    file_path = config_dir / ("hooks.json" if agent == "codex" else "settings.json")
    settings = read_json_object(file_path)
    entries = event_entries(hooks_object(settings, file_path), file_path)
    installed = any(
        isinstance(entry, dict)
        and isinstance(entry.get("hooks"), list)
        and any(
            isinstance(hook, dict)
            and hook.get("type") == "command"
            and hook.get("command") == command
            for hook in entry["hooks"]
        )
        for entry in entries
    )
    if installed:
        return
    entry = {"hooks": [{"type": "command", "command": command, "timeout": 10}]}
    if agent == "claude":
        entry["matcher"] = "*"
    entries.append(entry)
    atomic_write_json(file_path, settings)


def install_hook(agent, profile, mode, config_dir, hook_path):
    if not config_dir.is_absolute() or not hook_path.is_absolute():
        raise BridgeError("hook installation paths must be absolute")
    if not hook_path.is_file() or hook_path.is_symlink():
        raise BridgeError("session bridge hook path must be a regular file")
    config_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    command = shlex.join(
        [str(hook_path), f"{mode}-hook", "--agent", agent, "--profile", profile]
    )
    if agent == "copilot":
        install_copilot_hook(config_dir, command)
    else:
        install_nested_hook(config_dir, agent, command)


def read_bounded_regular_file(file_path, maximum):
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(file_path, flags)
    except OSError as error:
        raise BridgeError(f"cannot open {file_path}: {error.strerror}") from error
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode):
            raise BridgeError(f"{file_path} is not a regular file")
        if metadata.st_size > maximum:
            raise BridgeError(f"{file_path} is too large")
        source = os.read(descriptor, maximum + 1)
    finally:
        os.close(descriptor)
    if len(source) > maximum:
        raise BridgeError(f"{file_path} is too large")
    return source


def read_mapping(invocation_id):
    mapping_path = bridge_directory() / f"{invocation_id}.json"
    source = read_bounded_regular_file(mapping_path, MAX_MAPPING_BYTES)
    try:
        mapping = json.loads(source)
    except json.JSONDecodeError as error:
        raise BridgeError("session mapping is not valid JSON") from error
    if not isinstance(mapping, dict) or mapping.get("version") != 1:
        raise BridgeError("session mapping has an unsupported format")
    if mapping.get("conflict") is True:
        raise BridgeError("session mapping contains conflicting session identities")
    return mapping


def write_sandbox_mapping(agent, profile, invocation_id, session):
    directory = bridge_directory()
    target = directory / f"{invocation_id}.json"
    lock_path = directory / f"{invocation_id}.lock"
    flags = os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0)
    try:
        lock_descriptor = os.open(lock_path, flags, 0o600)
    except OSError as error:
        raise BridgeError(f"cannot open the session mapping lock: {error.strerror}") from error
    try:
        os.fchmod(lock_descriptor, 0o600)
        fcntl.flock(lock_descriptor, fcntl.LOCK_EX)
        current = None
        if target.exists():
            current = read_mapping(invocation_id)
        mapping = {
            "version": 1,
            "agent": agent,
            "profile": profile,
            "session_id": session["session_id"],
            "transcript_path": session["transcript_path"],
            "updated_at_ns": time.time_ns(),
        }
        if current is not None:
            identity = ("agent", "profile", "session_id", "transcript_path")
            if any(current.get(name) != mapping.get(name) for name in identity):
                mapping = {
                    "version": 1,
                    "conflict": True,
                    "agent": agent,
                    "profile": profile,
                    "updated_at_ns": time.time_ns(),
                }
        atomic_write_json(target, mapping)
    finally:
        os.close(lock_descriptor)


def parse_jsonl(source):
    records = []
    for line in source.splitlines():
        if not line.strip():
            continue
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            records.append(value)
    return records


def meaningful_text(value):
    return value if isinstance(value, str) and value.strip() else None


def nested_copilot_record(record, data):
    return meaningful_text(record.get("agentId")) is not None or meaningful_text(
        data.get("parentToolCallId")
    ) is not None


def copilot_task_completion(record, data):
    if record.get("type") != "session.task_complete":
        return None
    return meaningful_text(data.get("summary")) or meaningful_text(record.get("summary"))


def copilot_assistant_message(record, data):
    if record.get("type") != "assistant.message":
        return None
    content = meaningful_text(data.get("content")) or meaningful_text(record.get("content"))
    if content is None:
        return None
    return content


def copilot_final_message(records):
    latest = None
    for record in records:
        data = record.get("data") if isinstance(record.get("data"), dict) else {}
        if nested_copilot_record(record, data):
            continue
        task_completion = copilot_task_completion(record, data)
        if task_completion is not None:
            latest = task_completion
            continue
        assistant_message = copilot_assistant_message(record, data)
        if assistant_message is not None:
            latest = assistant_message
    return latest


def codex_message_text(payload):
    content = payload.get("content")
    if not isinstance(content, list):
        return None
    parts = []
    for part in content:
        if not isinstance(part, dict) or part.get("type") not in {"output_text", "text"}:
            continue
        text = meaningful_text(part.get("text"))
        if text is not None:
            parts.append(text)
    return "\n".join(parts) if parts else None


def codex_final_message(records):
    latest = None
    for record in records:
        payload = record.get("payload") if isinstance(record.get("payload"), dict) else {}
        if record.get("type") == "response_item" and payload.get("type") == "message":
            if payload.get("role") == "assistant":
                latest = codex_message_text(payload) or latest
        if record.get("type") == "event_msg" and payload.get("type") == "agent_message":
            latest = meaningful_text(payload.get("message")) or latest
    return latest


def append_claude_text(current, part):
    if not isinstance(part, dict) or part.get("type") != "text":
        return
    text = meaningful_text(part.get("text"))
    if text is None or text in current["seen"]:
        return
    current["seen"].add(text)
    current["texts"].append(text)


def append_claude_record(messages, record, index):
    message = record.get("message")
    if record.get("type") != "assistant" or not isinstance(message, dict):
        return
    message_id = meaningful_text(message.get("id"))
    if message_id is None:
        return
    current = messages.setdefault(
        message_id, {"texts": [], "seen": set(), "end_turn": False, "index": index}
    )
    content = message.get("content") if isinstance(message.get("content"), list) else []
    for part in content:
        append_claude_text(current, part)
    current["end_turn"] = current["end_turn"] or message.get("stop_reason") == "end_turn"
    current["index"] = index


def claude_final_message(records):
    messages = {}
    for index, record in enumerate(records):
        append_claude_record(messages, record, index)
    completed = [message for message in messages.values() if message["end_turn"] and message["texts"]]
    if not completed:
        return None
    return "\n".join(max(completed, key=lambda message: message["index"])["texts"])


def is_inside(root, candidate):
    try:
        return os.path.commonpath((root, candidate)) == root
    except ValueError:
        return False


def transcript_root(agent):
    home = os.path.abspath(os.environ.get("HOME", ""))
    if agent == "copilot":
        return os.path.join(home, ".copilot", "session-state")
    if agent == "codex":
        return os.path.join(home, ".codex", "sessions")
    return os.path.join(home, ".claude", "projects")


def transcript_path(mapping):
    agent = mapping["agent"]
    configured = mapping.get("transcript_path")
    if agent == "copilot":
        return os.path.join(transcript_root(agent), mapping["session_id"], "events.jsonl")
    if not isinstance(configured, str) or not os.path.isabs(configured):
        raise BridgeError("mapped transcript path is missing or invalid")
    return configured


def path_without_symlinks(root, candidate):
    home = os.path.abspath(os.environ.get("HOME", ""))
    root = os.path.abspath(root)
    candidate = os.path.abspath(candidate)
    if not is_inside(home, root) or not is_inside(root, candidate):
        raise BridgeError("mapped transcript resolves outside the harness state root")
    current = home
    relative = os.path.relpath(candidate, home)
    for component in relative.split(os.sep):
        current = os.path.join(current, component)
        try:
            metadata = os.lstat(current)
        except OSError as error:
            raise BridgeError(f"cannot inspect the mapped transcript path: {error.strerror}") from error
        if stat.S_ISLNK(metadata.st_mode):
            raise BridgeError("mapped transcript path must not traverse symlinks")
    return candidate


def read_transcript(mapping):
    root = transcript_root(mapping["agent"])
    candidate = path_without_symlinks(root, transcript_path(mapping))
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(candidate, flags)
    except OSError as error:
        raise BridgeError(f"cannot open the mapped transcript: {error.strerror}") from error
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode):
            raise BridgeError("mapped transcript is not a regular file")
        head_length = min(metadata.st_size, MAX_TRANSCRIPT_HEAD_BYTES)
        head = os.read(descriptor, head_length)
        length = min(metadata.st_size, MAX_TRANSCRIPT_BYTES)
        os.lseek(descriptor, metadata.st_size - length, os.SEEK_SET)
        source = os.read(descriptor, length)
    finally:
        os.close(descriptor)
    if metadata.st_size > MAX_TRANSCRIPT_BYTES:
        newline = source.find(b"\n")
        source = b"" if newline < 0 else source[newline + 1 :]
    return candidate, head.decode("utf-8", errors="ignore"), source.decode("utf-8", errors="strict")


def codex_transcript_session_id(head):
    for record in parse_jsonl(head):
        payload = record.get("payload")
        if record.get("type") != "session_meta" or not isinstance(payload, dict):
            continue
        session_id = meaningful_text(payload.get("id")) or meaningful_text(payload.get("session_id"))
        if session_id is not None:
            return session_id
    if re.search(r'"type"\s*:\s*"session_meta"', head) is None:
        return None
    match = re.search(r'"(?:id|session_id)"\s*:\s*("(?:\\.|[^"\\])*")', head)
    if match is None:
        return None
    try:
        return meaningful_text(json.loads(match.group(1)))
    except json.JSONDecodeError:
        return None


def validate_transcript_identity(mapping, candidate, head, records):
    expected = mapping["session_id"]
    if mapping["agent"] == "copilot":
        if os.path.basename(os.path.dirname(candidate)) != expected:
            raise BridgeError("Copilot transcript path conflicts with the mapped session ID")
        return
    if mapping["agent"] == "codex":
        if codex_transcript_session_id(head) != expected:
            raise BridgeError("Codex transcript content conflicts with the mapped session ID")
        return
    session_ids = {
        record.get("sessionId")
        for record in records
        if isinstance(record.get("sessionId"), str) and record.get("sessionId")
    }
    if session_ids != {expected}:
        raise BridgeError("Claude transcript content conflicts with the mapped session ID")


def validate_mapping(mapping, agent, profile):
    mapped_agent = require_pattern(mapping.get("agent"), SAFE_NAME, "mapped agent")
    mapped_profile = require_pattern(mapping.get("profile"), SAFE_PROFILE_NAME, "mapped profile")
    require_pattern(mapping.get("session_id"), SAFE_SESSION_ID, "mapped session ID")
    if mapped_agent not in AGENTS or mapped_agent != agent:
        raise BridgeError("mapped agent does not match the requested agent")
    if mapped_profile != profile:
        raise BridgeError("mapped profile does not match the requested profile")


def final_message(agent, profile, invocation_id):
    mapping = read_mapping(invocation_id)
    validate_mapping(mapping, agent, profile)
    candidate, head, source = read_transcript(mapping)
    records = parse_jsonl(source)
    validate_transcript_identity(mapping, candidate, head, records)
    if agent == "copilot":
        answer = copilot_final_message(records)
    elif agent == "codex":
        answer = codex_final_message(records)
    else:
        answer = claude_final_message(records)
    if answer is None:
        raise BridgeError("mapped transcript does not contain a completed assistant message")
    if len(answer) > MAX_ANSWER_CHARS:
        raise BridgeError(f"completed assistant message exceeds {MAX_ANSWER_CHARS} characters")
    return {
        "version": 1,
        "agent": agent,
        "profile": profile,
        "session_id": mapping["session_id"],
        "answer": answer,
    }


def conversation_policy():
    policy = CONVERSATION_POLICY.copy()
    if set(policy) != set(CONVERSATION_HARD_LIMITS):
        raise BridgeError("conversation policy has unknown or missing limits")
    if any(type(value) is not int or value <= 0 for value in policy.values()):
        raise BridgeError("conversation policy has invalid limits")
    if (
        any(value > CONVERSATION_HARD_LIMITS[key] for key, value in policy.items())
        or policy["record_bytes"] > policy["source_bytes"]
        or policy["page_bytes"] < 1024
    ):
        raise BridgeError("conversation policy exceeds supported limits")
    return policy


def json_bytes(value):
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def digest(value):
    return hashlib.sha256(value).hexdigest()


def strict_json(source):
    def object_pairs(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise BridgeError("conversation JSON contains duplicate fields")
            result[key] = value
        return result

    def invalid_constant(_value):
        raise BridgeError("conversation JSON contains a non-finite number")

    try:
        return json.loads(source, object_pairs_hook=object_pairs, parse_constant=invalid_constant)
    except (UnicodeError, ValueError, RecursionError) as error:
        raise BridgeError("conversation contains invalid JSON") from error


def private_metadata(metadata, directory=False):
    expected_mode = 0o700 if directory else 0o600
    expected_type = stat.S_ISDIR if directory else stat.S_ISREG
    if (
        not expected_type(metadata.st_mode)
        or metadata.st_uid != os.geteuid()
        or stat.S_IMODE(metadata.st_mode) != expected_mode
        or (not directory and metadata.st_nlink != 1)
    ):
        raise BridgeError("conversation state has unsafe ownership, permissions, or links")


def open_absolute_directory(candidate):
    candidate = Path(candidate)
    if not candidate.is_absolute() or ".." in candidate.parts:
        raise BridgeError("conversation path must be absolute and confined")
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    descriptor = os.open(candidate.anchor, flags)
    try:
        for name in candidate.parts[1:]:
            child = os.open(name, flags, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def private_child_directory(parent, name):
    try:
        os.mkdir(name, 0o700, dir_fd=parent)
    except FileExistsError:
        pass
    descriptor = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
    try:
        private_metadata(os.fstat(descriptor), directory=True)
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


@contextmanager
def conversation_state():
    home = os.environ.get("HOME", "")
    descriptors = []
    try:
        descriptors.append(open_absolute_directory(home))
        for name in (".trellage", "herdr-session-bridge", "conversations"):
            descriptors.append(private_child_directory(descriptors[-1], name))
        state = descriptors[-1]
        lock = os.open(
            "export.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK,
            0o600, dir_fd=state,
        )
        descriptors.append(lock)
        private_metadata(os.fstat(lock))
        deadline = time.monotonic() + 2
        while True:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise BridgeError("conversation state is busy")
                time.sleep(0.02)
        yield descriptors[-3], state
        for parent, name, child in zip(
            descriptors, (".trellage", "herdr-session-bridge", "conversations"), descriptors[1:]
        ):
            current = os.stat(name, dir_fd=parent, follow_symlinks=False)
            opened = os.fstat(child)
            private_metadata(current, directory=True)
            if (current.st_dev, current.st_ino) != (opened.st_dev, opened.st_ino):
                raise BridgeError("conversation state directory changed")
    except OSError as error:
        raise BridgeError("conversation state is unavailable or unsafe") from error
    finally:
        for descriptor in reversed(descriptors):
            os.close(descriptor)


def read_exact(descriptor, length):
    source = bytearray()
    while len(source) < length:
        chunk = os.read(descriptor, min(length - len(source), 1024 * 1024))
        if not chunk:
            raise BridgeError("conversation source was truncated")
        source.extend(chunk)
    return bytes(source)


def read_private_file(directory, name, maximum):
    descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
    try:
        before = os.fstat(descriptor)
        private_metadata(before)
        if before.st_size > maximum:
            raise BridgeError("conversation state exceeds its size budget")
        source = read_exact(descriptor, before.st_size)
        after = os.fstat(descriptor)
        current = os.stat(name, dir_fd=directory, follow_symlinks=False)
        if (
            (before.st_size, before.st_mtime_ns, before.st_ctime_ns)
            != (after.st_size, after.st_mtime_ns, after.st_ctime_ns)
            or (current.st_dev, current.st_ino) != (before.st_dev, before.st_ino)
        ):
            raise BridgeError("conversation state changed during reading")
        private_metadata(current)
        return source
    finally:
        os.close(descriptor)


def conversation_mapping(directory, agent, profile, invocation_id):
    mapping = strict_json(read_private_file(directory, f"{invocation_id}.json", MAX_MAPPING_BYTES))
    if (
        not isinstance(mapping, dict)
        or type(mapping.get("version")) is not int or mapping["version"] != 1
        or mapping.get("conflict") is True
    ):
        raise BridgeError("conversation mapping is invalid or contains conflicting session identities")
    validate_mapping(mapping, agent, profile)
    return {name: mapping.get(name) for name in ("agent", "profile", "session_id", "transcript_path")}


@contextmanager
def open_conversation_transcript(mapping):
    candidate = os.path.abspath(transcript_path(mapping))
    root = transcript_root(mapping["agent"])
    if (
        not is_inside(root, candidate)
        or candidate == root
        or "subagents" in Path(candidate).parts
    ):
        raise BridgeError("conversation transcript is not the mapped main-session source")
    parent = descriptor = None
    try:
        parent = open_absolute_directory(os.path.dirname(candidate))
        descriptor = os.open(
            os.path.basename(candidate), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
            dir_fd=parent,
        )
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
            raise BridgeError("conversation transcript must be a regular, unlinked file")
        yield descriptor, candidate, metadata
        current = os.stat(os.path.basename(candidate), dir_fd=parent, follow_symlinks=False)
        check_parent = open_absolute_directory(os.path.dirname(candidate))
        try:
            reopened = os.fstat(check_parent)
            original_parent = os.fstat(parent)
            if (
                (current.st_dev, current.st_ino) != (metadata.st_dev, metadata.st_ino)
                or (reopened.st_dev, reopened.st_ino)
                != (original_parent.st_dev, original_parent.st_ino)
                or not stat.S_ISREG(current.st_mode)
                or current.st_nlink != 1
            ):
                raise BridgeError("conversation source was replaced")
        finally:
            os.close(check_parent)
    except OSError as error:
        raise BridgeError("conversation transcript is unavailable or traverses unsafe links") from error
    finally:
        if descriptor is not None:
            os.close(descriptor)
        if parent is not None:
            os.close(parent)


def verify_conversation_prefix(mapping, proof):
    with open_conversation_transcript(mapping) as (descriptor, _candidate, before):
        if (before.st_dev, before.st_ino) != (proof["device"], proof["inode"]):
            raise BridgeError("conversation source was replaced")
        if before.st_size < proof["observedBytes"]:
            raise BridgeError("conversation source was truncated")
        source = read_exact(descriptor, proof["prefixBytes"])
        after = os.fstat(descriptor)
        if (
            digest(source) != proof["prefixDigest"]
            or after.st_size < before.st_size
            or (
                before.st_size == after.st_size
                and (before.st_mtime_ns, before.st_ctime_ns)
                != (after.st_mtime_ns, after.st_ctime_ns)
            )
        ):
            raise BridgeError("conversation source prefix changed")


def conversation_records(source, policy):
    prefix_end = source.rfind(b"\n") + 1
    tail = source[prefix_end:]
    if len(tail) > policy["record_bytes"]:
        raise BridgeError("conversation incomplete record exceeds its capture budget")
    incomplete_tail = bool(tail.strip()) and not complete_json_tail(tail)
    if tail.strip() and not incomplete_tail:
        prefix_end = len(source)
    prefix = source[:prefix_end]
    records = []
    for index, line in enumerate(io.BytesIO(prefix)):
        if index >= policy["records"]:
            raise BridgeError("conversation exceeds its record count budget")
        value = conversation_record(line, policy)
        if value is not None:
            records.append((index, value))
    return prefix, records, incomplete_tail


def conversation_record(line, policy):
    if line.endswith(b"\n"):
        line = line[:-1]
    if len(line) > policy["record_bytes"]:
        raise BridgeError("conversation record exceeds its capture budget")
    if not line.strip():
        return None
    value = strict_json(line)
    if not isinstance(value, dict):
        raise BridgeError("conversation record must be an object")
    if meaningful_text(value.get("type")) is None:
        raise BridgeError("conversation record has an invalid event type")
    return value


def complete_json_tail(source):
    try:
        json.loads(source)
        return True
    except (json.JSONDecodeError, UnicodeError):
        return False
    except (ValueError, RecursionError) as error:
        raise BridgeError("conversation contains invalid JSON") from error


def conversation_nested(record):
    for value in (record, record.get("data"), record.get("payload"), record.get("message")):
        if not isinstance(value, dict):
            continue
        if value.get("isSidechain") is True or value.get("is_sidechain") is True:
            return True
        if any(value.get(key) for key in (
            "agentId", "agent_id", "parentToolCallId", "parent_tool_call_id",
            "parentAgentId", "parent_agent_id", "parentSessionId", "parent_session_id",
            "subagentId", "subagent_id",
        )):
            return True
    return False


def conversation_text(content, accepted=("text", "input_text", "output_text")):
    if isinstance(content, str):
        return meaningful_text(content)
    if not isinstance(content, list):
        return None
    parts = [
        part["text"] for part in content
        if isinstance(part, dict) and part.get("type") in accepted
        and meaningful_text(part.get("text")) is not None
    ]
    return "\n".join(parts) if parts else None


def internal_user_text(text):
    return text is not None and re.match(
        r"^\s*(?:# AGENTS\.md instructions\b|<(?:(?:system[-_]reminder|environment_context|"
        r"instructions|permissions instructions|developer_instructions|turn_aborted)\b))",
        text, re.IGNORECASE,
    ) is not None


def conversation_identifier(value):
    return value if isinstance(value, str) and value else None


def conversation_event_id(record, payload):
    for value in (
        payload.get("messageId"), payload.get("message_id"), payload.get("id"),
        record.get("uuid"), record.get("id"),
    ):
        identifier = conversation_identifier(value)
        if identifier is not None:
            return identifier
    return None


def internal_conversation_record(record, payload):
    if any(record.get(name) is True or payload.get(name) is True for name in ("isMeta", "isSynthetic", "internal")):
        return True
    return any(
        value in ("system", "developer", "tool", "agent", "internal", "synthetic")
        for value in (payload.get("source"), record.get("source"), payload.get("origin"), record.get("origin"))
    )


def codex_human_content(payload, kinds):
    content = payload.get("content")
    if all(kind == "user.text" for kind in kinds):
        return content
    if not isinstance(content, list) or len(content) != len(kinds):
        raise BridgeError("Codex human input cannot be separated from injected instructions")
    return [part for part, kind in zip(content, kinds) if kind == "user.text"]


def compacted_conversation_record(record):
    payload = record.get("payload")
    subtype = payload.get("type") if isinstance(payload, dict) else None
    return (
        record.get("type") in {"compacted", "compaction", "session.compaction_complete", "session.compaction"}
        or record.get("subtype") == "compact_boundary"
        or record.get("isCompactSummary") is True
        or subtype in ("context_compacted", "compacted")
    )


def accounting_record(record):
    payload = record.get("payload") if isinstance(record.get("payload"), dict) else {}
    return record.get("type") == "token_usage_record" or (
        record.get("type") == "event_msg" and payload.get("type") == "token_count"
    )


def sanitize_conversation_text(text):
    cleaned = OSC.sub("", CSI.sub("", text))
    cleaned = UNSUPPORTED_CONTROLS.sub("", cleaned)
    controls_removed = cleaned != text
    redacted = False
    projection = []
    starts = []
    ends = []
    for index, character in enumerate(cleaned):
        normalized = unicodedata.normalize("NFKC", character)
        projection.append(normalized)
        starts.extend([index] * len(normalized))
        ends.extend([index + 1] * len(normalized))
    projected = "".join(projection)
    spans = []
    for pattern, replacement, group in (
        (PRIVATE_KEY, "[REDACTED private key]", 0),
        (TOKEN, "[REDACTED credential]", 0),
        (ASSIGNED_DOUBLE, "[REDACTED credential]", 1),
        (ASSIGNED_SINGLE, "[REDACTED credential]", 1),
        (ASSIGNED_UNQUOTED, "[REDACTED credential]", 1),
    ):
        for match in pattern.finditer(projected):
            value_start = match.start(group)
            value_end = match.end(group)
            if value_start >= len(starts) or value_end <= 0:
                continue
            start = starts[value_start]
            end = ends[value_end - 1]
            spans.append((start, end, replacement))
            redacted = True
    merged = []
    for start, end, replacement in sorted(spans):
        if merged and start < merged[-1][1]:
            previous = merged[-1]
            merged[-1] = (previous[0], max(previous[1], end), previous[2])
        else:
            merged.append((start, end, replacement))
    for start, end, replacement in reversed(merged):
        cleaned = cleaned[:start] + replacement + cleaned[end:]
    return cleaned, redacted, controls_removed


class ConversationNormalizer:
    def __init__(self, mapping, policy):
        self.agent = mapping["agent"]
        self.session_id = mapping["session_id"]
        self.policy = policy
        self.messages = []
        self.notices = set()
        self.seen_events = {}
        self.seen_messages = {}
        self.claude_fragments = {}
        self.pending_answer = None
        self.turn_completed = False
        self.summary_id = None
        self.compaction_tail = None

    def normalized(self, role, text, index, key=None):
        if text is None:
            return None
        text, credentials_redacted, controls_removed = sanitize_conversation_text(text)
        if credentials_redacted:
            self.notices.add("Conversation credentials were redacted.")
        if controls_removed:
            self.notices.add("Terminal control sequences were removed.")
        if not text.strip():
            raise BridgeError("conversation text is empty after sanitization")
        # Match the TypeScript parser's evidence identity, including its record-index fallback.
        identity = [self.agent, self.session_id, role, key if key is not None else f"record:{index}"]
        return {
            "id": "msg-" + digest(json_bytes(identity)),
            "role": role, "text": text, "recordIndex": index,
        }

    def append(self, message):
        if message is None:
            return False
        previous = self.seen_messages.get(message["id"])
        if previous is not None:
            if (previous["role"], previous["text"]) != (message["role"], message["text"]):
                raise BridgeError("conversation has conflicting message identities")
            return False
        self.seen_messages[message["id"]] = message
        self.messages.append(message)
        if len(self.messages) > self.policy["messages"]:
            raise BridgeError("conversation exceeds its message budget")
        return True

    def finish(self, message, summary=False):
        if summary and self.turn_completed:
            return
        if message is not None:
            if not summary and self.summary_id is not None:
                self.messages = [entry for entry in self.messages if entry["id"] != self.summary_id]
                self.seen_messages.pop(self.summary_id, None)
            self.append(message)
            self.turn_completed = True
            self.summary_id = message["id"] if summary else None
        self.pending_answer = None

    def new_turn(self):
        self.pending_answer = None
        self.turn_completed = False
        self.summary_id = None

    def record_key(self, record, index):
        if conversation_nested(record):
            return None
        kind = record.get("type")
        event_id = (
            conversation_identifier(record.get("uuid")) or conversation_identifier(record.get("id"))
            or conversation_identifier(record.get("eventId"))
        )
        payload = next(
            (value for value in (record.get("data"), record.get("payload"), record.get("message"))
             if isinstance(value, dict)), {}
        )
        key = f"{kind}:{payload.get('type', '')}:{event_id}" if event_id else f"record:{index}"
        if event_id:
            encoded = digest(json_bytes(record))
            if key in self.seen_events:
                if self.seen_events[key] != encoded:
                    raise BridgeError("conversation has conflicting event identities")
                return None
            self.seen_events[key] = encoded
        if compacted_conversation_record(record):
            self.notices.add("compacted-history")
            self.discard_compaction_tail()
            return None
        if internal_conversation_record(record, payload):
            return None
        if not accounting_record(record):
            self.compaction_tail = None
        return key

    def discard_compaction_tail(self):
        tail = self.compaction_tail
        if tail is None:
            return
        candidate, source_type, source_subtype = tail
        if not (
            (source_type == "response_item" and source_subtype == "message")
            or (source_type == "event_msg" and source_subtype == "agent_message")
        ):
            return
        self.messages = [message for message in self.messages if message["id"] != candidate["id"]]
        self.seen_messages.pop(candidate["id"], None)
        if self.pending_answer is not None and self.pending_answer["id"] == candidate["id"]:
            self.pending_answer = None
        if self.summary_id == candidate["id"]:
            self.summary_id = None
        self.compaction_tail = None

    def content_text(self, content):
        if isinstance(content, list) and any(
            isinstance(part, dict) and part.get("type") in ("image", "input_image", "document")
            for part in content
        ):
            self.notices.add("attachments-not-included")
        return conversation_text(content, ("text", "input_text"))

    def copilot_user(self, record, data):
        if record.get("type") != "user.message" or internal_conversation_record(record, data):
            return None
        if data.get("attachments") or record.get("attachments"):
            self.notices.add("attachments-not-included")
        return self.content_text(data.get("content", record.get("content")))

    def codex_user(self, record, payload):
        if internal_conversation_record(record, payload):
            return None
        if record.get("type") == "event_msg" and payload.get("type") == "user_message":
            text = meaningful_text(payload.get("message"))
            if payload.get("images") or payload.get("local_images"):
                self.notices.add("attachments-not-included")
            return text
        if record.get("type") == "response_item" and payload.get("role") == "user":
            metadata = payload.get("internal_chat_message_metadata_passthrough")
            kinds = metadata.get("content_item_kinds", []) if isinstance(metadata, dict) else []
            if not isinstance(kinds, list):
                raise BridgeError("Codex conversation user metadata is invalid")
            if "user.text" in kinds:
                return self.content_text(codex_human_content(payload, kinds))
        return None

    def claude_user(self, record):
        message = record.get("message")
        if (
            record.get("type") != "user" or not isinstance(message, dict)
            or internal_conversation_record(record, message)
        ):
            return None
        content = message.get("content")
        if isinstance(content, list) and any(
            isinstance(part, dict) and part.get("type") == "tool_result" for part in content
        ):
            return None
        return self.content_text(message.get("content"))

    def copilot_answer(self, record, data, index):
        if internal_conversation_record(record, data):
            return
        phase = data.get("phase", record.get("phase"))
        tools = data.get("toolRequests", record.get("toolRequests"))
        if phase in ("commentary", "analysis", "reasoning") or tools:
            self.pending_answer = None
            return
        if phase not in (None, "final_answer", "final"):
            raise BridgeError("Copilot conversation has an unsupported completion phase")
        text = conversation_text(data.get("content", record.get("content")))
        answer = self.normalized("assistant", text, index, conversation_event_id(record, data))
        if phase in ("final_answer", "final"):
            self.finish(answer)
        elif phase is None:
            self.pending_answer = answer

    def copilot_event(self, record, data, index):
        kind = record.get("type")
        if kind == "assistant.message":
            self.copilot_answer(record, data, index)
        elif kind == "session.task_complete":
            summary = meaningful_text(data.get("summary")) or meaningful_text(record.get("summary"))
            if summary is not None:
                self.finish(self.normalized("assistant", summary, index, conversation_event_id(record, data)), summary=True)
            elif not self.turn_completed:
                self.finish(self.pending_answer)
        elif kind in ("assistant.turn_end", "session.idle") and not self.turn_completed:
            self.finish(self.pending_answer)
        elif kind == "assistant.turn_start":
            self.new_turn()
        elif kind in ("tool.execution_start", "tool.executionStart"):
            self.pending_answer = None

    def codex_answer(self, record, payload, index, response=False):
        if internal_conversation_record(record, payload):
            return
        phase = payload.get("phase")
        if phase is None:
            phase = payload.get("channel")
        if phase in ("commentary", "analysis", "reasoning") or payload.get("recipient") not in (None, "all"):
            return
        if phase not in (None, "final_answer", "final"):
            raise BridgeError("Codex conversation has an unsupported completion phase")
        if response:
            text = codex_message_text(payload)
        else:
            if self.turn_completed:
                return
            text = meaningful_text(payload.get("message"))
        answer = self.normalized("assistant", text, index, conversation_event_id(record, payload))
        if answer is not None:
            self.compaction_tail = (answer, record.get("type"), payload.get("type"))
        if response and phase in ("final_answer", "final"):
            self.finish(answer)
        else:
            self.pending_answer = answer

    def codex_event(self, record, payload, index):
        kind, subtype = record.get("type"), payload.get("type")
        if kind == "response_item" and subtype == "message" and payload.get("role") == "assistant":
            self.codex_answer(record, payload, index, response=True)
        elif kind == "event_msg":
            self.codex_terminal_event(record, payload, index)
        elif kind == "response_item" and subtype in ("function_call", "custom_tool_call", "web_search_call"):
            self.pending_answer = None

    def codex_terminal_event(self, record, payload, index):
        subtype = payload.get("type")
        if subtype == "agent_message":
            self.codex_answer(record, payload, index)
        elif subtype in ("task_complete", "turn_complete"):
            if not self.turn_completed:
                self.finish(self.pending_answer or self.normalized(
                    "assistant", meaningful_text(payload.get("last_agent_message")), index,
                    conversation_event_id(record, payload),
                ))
        elif subtype == "task_started":
            self.new_turn()
        elif subtype in ("turn_aborted", "task_aborted"):
            self.pending_answer = None

    def claude_part(self, fragments, part, record):
        if not isinstance(part, dict):
            return
        if part.get("type") == "tool_use":
            fragments["tool_use"] = True
            return
        if part.get("type") != "text":
            return
        text = meaningful_text(part.get("text"))
        if text is None:
            return
        identity = conversation_identifier(part.get("id"))
        if identity is not None:
            self.claude_identified_part(fragments, identity, text)
            return
        block = part.get("index", record.get("content_block_index"))
        if block is None:
            if fragments["complete"]:
                raise BridgeError("Claude conversation completed message changed")
            fragments["parts"].append(text)
            return
        if type(block) is not int or block < 0:
            raise BridgeError("Claude conversation block identity is invalid")
        previous = fragments["blocks"].get(block)
        if previous is not None and previous != text and not text.startswith(previous):
            raise BridgeError("Claude conversation block changed")
        fragments["blocks"][block] = text

    def claude_identified_part(self, fragments, identity, text):
        previous = fragments["identities"].get(identity)
        if previous is not None:
            if previous != text:
                raise BridgeError("Claude conversation block identity has conflicting content")
            return
        if fragments["complete"]:
            raise BridgeError("Claude conversation completed message changed")
        fragments["identities"][identity] = text
        fragments["parts"].append(text)

    def claude_event(self, record, index):
        message = record.get("message")
        if record.get("type") != "assistant" or not isinstance(message, dict):
            return
        message_id = meaningful_text(message.get("id"))
        if message_id is None:
            raise BridgeError("Claude conversation message identity is missing")
        fragments = self.claude_fragments.setdefault(message_id, {
            "parts": [], "blocks": {}, "identities": {}, "complete": False, "tool_use": False,
        })
        content = message.get("content") if isinstance(message.get("content"), list) else []
        for part in content:
            self.claude_part(fragments, part, record)
        if message.get("stop_reason") == "end_turn" and not fragments["complete"]:
            text = "\n".join(fragments["parts"] + [
                fragments["blocks"][block] for block in sorted(fragments["blocks"])
            ])
            if not fragments["tool_use"]:
                self.finish(self.normalized("assistant", meaningful_text(text), index, message_id))
            fragments["complete"] = True

    def accept(self, record, index):
        key = self.record_key(record, index)
        if key is None:
            return
        data = record.get("data") if isinstance(record.get("data"), dict) else {}
        payload = record.get("payload") if isinstance(record.get("payload"), dict) else {}
        if self.agent == "copilot":
            user_text = self.copilot_user(record, data)
        elif self.agent == "codex":
            user_text = self.codex_user(record, payload)
        else:
            user_text = self.claude_user(record)
        if user_text is not None and not internal_user_text(user_text):
            message_id = self.user_message_id(record, data, payload)
            if self.append(self.normalized("user", user_text, index, message_id)):
                self.new_turn()
        elif self.agent == "copilot":
            self.copilot_event(record, data, index)
        elif self.agent == "codex":
            self.codex_event(record, payload, index)
        else:
            self.claude_event(record, index)

    def user_message_id(self, record, data, payload):
        if self.agent == "copilot":
            return conversation_event_id(record, data)
        if self.agent == "codex":
            return conversation_event_id(record, payload)
        message = record.get("message", {})
        return conversation_identifier(record.get("uuid")) or conversation_identifier(message.get("id"))

    def result(self, incomplete_tail):
        if incomplete_tail:
            self.notices.add("incomplete-tail")
        self.messages.sort(key=lambda message: message["recordIndex"])
        completed = [message for message in self.messages if message["role"] == "assistant"]
        if not completed:
            raise BridgeError("conversation has no unambiguous completed assistant response")
        cutoff = {"messageId": completed[-1]["id"], "recordIndex": completed[-1]["recordIndex"]}
        activity_revision = digest(json_bytes(self.messages))
        if self.has_pending_turn(cutoff):
            self.notices.add("pending-turn-excluded")
        messages = [message for message in self.messages if message["recordIndex"] <= cutoff["recordIndex"]]
        if messages[0]["role"] != "user":
            self.notices.add("history-starts-with-assistant")
        encoded = json_bytes(messages)
        if len(encoded) > self.policy["normalized_bytes"]:
            raise BridgeError("conversation exceeds its normalized capture budget")
        return {
            "cutoff": cutoff, "revision": digest(encoded), "activityRevision": activity_revision,
            "messages": messages,
            "coverage": {"complete": not self.notices, "notices": sorted(self.notices)},
        }

    def has_pending_turn(self, cutoff):
        if self.messages[-1]["recordIndex"] > cutoff["recordIndex"] or self.pending_answer is not None:
            return True
        return any(
            not fragments["complete"] and not fragments["tool_use"] and (fragments["parts"] or fragments["blocks"])
            for fragments in self.claude_fragments.values()
        )


def normalize_conversation(mapping, records, incomplete_tail, policy):
    normalizer = ConversationNormalizer(mapping, policy)
    for index, record in records:
        normalizer.accept(record, index)
    return normalizer.result(incomplete_tail)


def validate_codex_conversation_identity(mapping, records):
    found = False
    for record in records:
        if record.get("type") != "session_meta":
            continue
        payload = record.get("payload")
        if not isinstance(payload, dict):
            raise BridgeError("conversation Codex session metadata is invalid")
        found = True
        source = payload.get("source")
        nested = isinstance(source, dict) and any(key.startswith("subagent") for key in source)
        nested = nested or isinstance(source, str) and source.startswith("subagent")
        if payload.get("id", payload.get("session_id")) != mapping["session_id"] or nested:
            raise BridgeError("conversation is not the mapped Codex main session")
    if not found:
        raise BridgeError("conversation Codex session metadata is missing")


def validate_copilot_conversation_identity(mapping, records):
    for record in records:
        if record.get("type") != "session.start" or conversation_nested(record):
            continue
        data = record.get("data")
        session_id = text_field(data, "sessionId", "session_id") if isinstance(data, dict) else None
        if session_id is not None and session_id != mapping["session_id"]:
            raise BridgeError("conversation is not the mapped Copilot session")


def capture_conversation_source(mapping, policy):
    with open_conversation_transcript(mapping) as (descriptor, candidate, before):
        if before.st_size > policy["source_bytes"]:
            raise BridgeError("conversation exceeds its source capture budget")
        source = read_exact(descriptor, before.st_size)
        prefix, indexed_records, incomplete = conversation_records(source, policy)
        records = [record for _index, record in indexed_records if not conversation_nested(record)]
        if mapping["agent"] == "codex":
            validate_codex_conversation_identity(mapping, records)
        else:
            validate_transcript_identity(mapping, candidate, "", records)
            if mapping["agent"] == "copilot":
                validate_copilot_conversation_identity(mapping, records)
        result = normalize_conversation(mapping, indexed_records, incomplete, policy)
        proof = {
            "device": before.st_dev, "inode": before.st_ino, "observedBytes": before.st_size,
            "prefixBytes": len(prefix), "prefixDigest": digest(prefix),
        }
        after = os.fstat(descriptor)
        if after.st_size < before.st_size:
            raise BridgeError("conversation source was truncated")
        if after.st_size == before.st_size and (
            after.st_mtime_ns, after.st_ctime_ns
        ) != (before.st_mtime_ns, before.st_ctime_ns):
            raise BridgeError("conversation source prefix changed during capture")
        verify_conversation_prefix(mapping, proof)
        return result, proof


def conversation_identity(agent, profile, invocation_id, container_id, mapping):
    require_pattern(invocation_id, SAFE_INVOCATION_ID, "conversation invocation ID")
    require_pattern(container_id, SAFE_SNAPSHOT_ID, "conversation container ID")
    if len(profile.encode()) > 1024:
        raise BridgeError("conversation profile identity exceeds its size budget")
    return {
        "agent": agent, "profile": profile, "sessionId": mapping["session_id"],
        "containerId": container_id, "invocationId": invocation_id,
    }


def load_conversation_snapshot(state, snapshot_id, identity=None, mapping=None, allow_expired=False):
    require_pattern(snapshot_id, SAFE_SNAPSHOT_ID, "conversation snapshot ID")
    source = read_private_file(state, f"{snapshot_id}.json", MAX_SNAPSHOT_BYTES)
    if digest(source) != snapshot_id:
        raise BridgeError("conversation snapshot seal does not match")
    snapshot = strict_json(source)
    if not valid_conversation_snapshot(snapshot):
        raise BridgeError("conversation snapshot has an invalid format")
    if identity is not None and (snapshot["identity"] != identity or snapshot["mapping"] != mapping):
        raise BridgeError("conversation snapshot belongs to another source")
    if not allow_expired and snapshot["expiresAt"] <= time.time():
        raise BridgeError("conversation snapshot expired; capture the source again")
    return snapshot


def valid_conversation_snapshot(snapshot):
    if not isinstance(snapshot, dict) or snapshot.get("schemaVersion") != 1:
        return False
    if any(not isinstance(snapshot.get(key), dict) for key in ("identity", "mapping", "proof", "data")):
        return False
    pages = snapshot.get("pages")
    return (
        type(snapshot.get("expiresAt")) in (int, float)
        and isinstance(pages, list) and 0 < len(pages) <= 512
        and all(isinstance(page, dict) and isinstance(page.get("messages"), list) for page in pages)
    )


def cleanup_conversation_snapshots(state, policy):
    names = os.listdir(state)
    if len(names) > policy["snapshots"] + 1:
        raise BridgeError("conversation snapshot storage budget is exhausted")
    count = 0
    for name in names:
        if name == "export.lock":
            continue
        if not name.endswith(".json") or SAFE_SNAPSHOT_ID.fullmatch(name[:-5]) is None:
            raise BridgeError("conversation snapshot storage contains an unexpected entry")
        snapshot = load_conversation_snapshot(state, name[:-5], allow_expired=True)
        if snapshot["expiresAt"] <= time.time():
            remove_sealed_snapshot(state, name[:-5])
        else:
            count += 1
    if count >= policy["snapshots"]:
        raise BridgeError("conversation snapshot storage budget is exhausted")


def write_conversation_snapshot(state, snapshot):
    source = json_bytes(snapshot)
    if len(source) > MAX_SNAPSHOT_BYTES:
        raise BridgeError("conversation snapshot exceeds its storage budget")
    # The opaque, nonce-bearing content address seals metadata and every page without a sidecar key.
    snapshot_id = digest(source)
    name = f"{snapshot_id}.json"
    descriptor = os.open(
        name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=state
    )
    try:
        offset = 0
        while offset < len(source):
            offset += os.write(descriptor, source[offset:])
        os.fsync(descriptor)
        os.fsync(state)
    except BaseException:
        os.unlink(name, dir_fd=state)
        raise
    finally:
        os.close(descriptor)
    return snapshot_id


def remove_sealed_snapshot(state, snapshot_id):
    name = f"{snapshot_id}.json"
    if digest(read_private_file(state, name, MAX_SNAPSHOT_BYTES)) != snapshot_id:
        raise BridgeError("conversation snapshot seal changed before release")
    os.unlink(name, dir_fd=state)
    os.fsync(state)


def conversation_pages(messages, policy):
    pages = []
    current = []
    size = 2
    budget = policy["page_bytes"] - min(16 * 1024, policy["page_bytes"] // 2)
    for message in messages:
        message_size = len(json_bytes(message)) + 1
        if message_size > budget:
            raise BridgeError("conversation message exceeds its page budget")
        if current and size + message_size > budget:
            pages.append({"messages": current, "cursor": secrets.token_hex(32)})
            current, size = [], 2
        current.append(message)
        size += message_size
    if current:
        pages.append({"messages": current, "cursor": secrets.token_hex(32)})
    if len(pages) > policy["pages"]:
        raise BridgeError("conversation exceeds its page budget")
    return pages


def conversation_page(snapshot_id, snapshot, index, policy):
    pages = snapshot["pages"]
    result = {
        "schemaVersion": 1, **snapshot["identity"], "snapshotId": snapshot_id,
        "capturedAt": snapshot["capturedAt"], **snapshot["data"],
        "messages": pages[index]["messages"],
        "page": {
            "index": index, "total": len(pages),
            "nextCursor": snapshot_id + pages[index + 1]["cursor"] if index + 1 < len(pages) else None,
        },
    }
    if len(json_bytes(result)) > policy["page_bytes"]:
        raise BridgeError("conversation page exceeds its transport budget")
    return result


def export_conversation(agent, profile, invocation_id, container_id, cursor=None):
    policy = conversation_policy()
    require_pattern(invocation_id, SAFE_INVOCATION_ID, "conversation invocation ID")
    with conversation_state() as (directory, state):
        mapping = conversation_mapping(directory, agent, profile, invocation_id)
        identity = conversation_identity(agent, profile, invocation_id, container_id, mapping)
        if cursor is not None:
            require_pattern(cursor, SAFE_CURSOR, "conversation cursor")
            snapshot_id = cursor[:64]
            snapshot = load_conversation_snapshot(state, snapshot_id, identity, mapping)
            indices = [index for index, page in enumerate(snapshot["pages"]) if page["cursor"] == cursor[64:]]
            if len(indices) != 1 or indices[0] == 0:
                raise BridgeError("conversation cursor is unknown")
            verify_conversation_prefix(mapping, snapshot["proof"])
            result = conversation_page(snapshot_id, snapshot, indices[0], policy)
        else:
            cleanup_conversation_snapshots(state, policy)
            data, proof = capture_conversation_source(mapping, policy)
            pages = conversation_pages(data.pop("messages"), policy)
            snapshot = {
                "schemaVersion": 1, "nonce": secrets.token_hex(32), "identity": identity,
                "mapping": mapping, "proof": proof,
                "capturedAt": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
                "expiresAt": time.time() + policy["snapshot_seconds"],
                "data": data, "pages": pages,
            }
            if conversation_mapping(directory, agent, profile, invocation_id) != mapping:
                raise BridgeError("conversation session mapping changed during capture")
            snapshot_id = write_conversation_snapshot(state, snapshot)
            try:
                result = conversation_page(snapshot_id, snapshot, 0, policy)
            except BaseException:
                os.unlink(f"{snapshot_id}.json", dir_fd=state)
                raise
        if conversation_mapping(directory, agent, profile, invocation_id) != mapping:
            raise BridgeError("conversation session mapping changed during export")
        return result


def describe_conversation(agent, profile, invocation_id, container_id, snapshot_id=None):
    policy = conversation_policy()
    require_pattern(invocation_id, SAFE_INVOCATION_ID, "conversation invocation ID")
    with conversation_state() as (directory, state):
        mapping = conversation_mapping(directory, agent, profile, invocation_id)
        identity = conversation_identity(agent, profile, invocation_id, container_id, mapping)
        snapshot = None
        if snapshot_id is not None:
            snapshot = load_conversation_snapshot(state, snapshot_id, identity, mapping)
            verify_conversation_prefix(mapping, snapshot["proof"])
        data, _proof = capture_conversation_source(mapping, policy)
        data.pop("messages")
        if conversation_mapping(directory, agent, profile, invocation_id) != mapping:
            raise BridgeError("conversation session mapping changed during describe")
        result = {"schemaVersion": 1, **identity, **data}
        if snapshot is not None:
            result["snapshotId"] = snapshot_id
            result["changed"] = any(
                data[key] != snapshot["data"][key] for key in ("revision", "activityRevision")
            )
        return result


def release_conversation(agent, profile, invocation_id, container_id, snapshot_id):
    require_pattern(invocation_id, SAFE_INVOCATION_ID, "conversation invocation ID")
    with conversation_state() as (directory, state):
        mapping = conversation_mapping(directory, agent, profile, invocation_id)
        identity = conversation_identity(agent, profile, invocation_id, container_id, mapping)
        load_conversation_snapshot(state, snapshot_id, identity, mapping, allow_expired=True)
        if conversation_mapping(directory, agent, profile, invocation_id) != mapping:
            raise BridgeError("conversation session mapping changed during release")
        remove_sealed_snapshot(state, snapshot_id)
        return {"schemaVersion": 1, **identity, "snapshotId": snapshot_id, "released": True}


class UniqueConversationArgument(argparse.Action):
    def __call__(self, parser, namespace, values, option_string=None):
        if getattr(namespace, self.dest, None) is not None:
            parser.error(f"{option_string} may be specified only once")
        setattr(namespace, self.dest, values)


def add_conversation_arguments(subparsers):
    for command in sorted(CONVERSATION_COMMANDS):
        conversation = subparsers.add_parser(command, allow_abbrev=False)
        for argument in ("agent", "profile", "invocation", "container-id"):
            options = {"choices": sorted(AGENTS)} if argument == "agent" else {}
            conversation.add_argument(
                f"--{argument}", required=True, action=UniqueConversationArgument, **options
            )
        if command == "export-conversation":
            conversation.add_argument("--cursor", action=UniqueConversationArgument)
        else:
            conversation.add_argument(
                "--snapshot", required=command == "release-conversation",
                action=UniqueConversationArgument,
            )


def parse_arguments():
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    for command in ("native-hook", "sandbox-hook"):
        hook = subparsers.add_parser(command)
        hook.add_argument("--agent", choices=sorted(AGENTS), required=True)
        hook.add_argument("--profile", required=True)
    install = subparsers.add_parser("install-hook")
    install.add_argument("--agent", choices=sorted(AGENTS), required=True)
    install.add_argument("--profile", required=True)
    install.add_argument("--mode", choices=("native", "sandbox"), required=True)
    install.add_argument("--config-dir", type=Path, required=True)
    install.add_argument("--hook-path", type=Path, required=True)
    final = subparsers.add_parser("final-message")
    final.add_argument("--agent", choices=sorted(AGENTS), required=True)
    final.add_argument("--profile", required=True)
    final.add_argument("--invocation", required=True)
    add_conversation_arguments(subparsers)
    return parser.parse_args()


def run_hook(arguments):
    profile = require_pattern(arguments.profile, SAFE_PROFILE_NAME, "profile")
    session = session_from_hook(arguments.agent, read_hook_input())
    if arguments.command == "native-hook":
        report_native_session(arguments.agent, profile, session)
        return
    invocation_id = require_pattern(
        os.environ.get("TRELLAGE_HERDR_INVOCATION_ID"),
        SAFE_INVOCATION_ID,
        "Trellage attachment invocation ID",
    )
    write_sandbox_mapping(arguments.agent, profile, invocation_id, session)


def serialize_result(value):
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False)


def run_conversation_command(arguments, profile, invocation_id):
    identity = (arguments.agent, profile, invocation_id, arguments.container_id)
    if arguments.command == "export-conversation":
        return export_conversation(*identity, cursor=arguments.cursor)
    if arguments.command == "describe-conversation":
        return describe_conversation(*identity, snapshot_id=arguments.snapshot)
    return release_conversation(*identity, snapshot_id=arguments.snapshot)


def main():
    arguments = parse_arguments()
    try:
        if arguments.command in {"native-hook", "sandbox-hook"}:
            run_hook(arguments)
            return 0
        if arguments.command == "install-hook":
            profile = require_pattern(arguments.profile, SAFE_PROFILE_NAME, "profile")
            install_hook(
                arguments.agent,
                profile,
                arguments.mode,
                arguments.config_dir,
                arguments.hook_path,
            )
            return 0
        profile = require_pattern(arguments.profile, SAFE_PROFILE_NAME, "profile")
        invocation_id = require_pattern(
            arguments.invocation, SAFE_INVOCATION_ID, "Trellage attachment invocation ID"
        )
        if arguments.command in CONVERSATION_COMMANDS:
            result = run_conversation_command(arguments, profile, invocation_id)
        else:
            result = final_message(arguments.agent, profile, invocation_id)
        print(serialize_result(result))
        return 0
    except (BridgeError, OSError, UnicodeError) as error:
        if arguments.command == "final-message" or arguments.command in CONVERSATION_COMMANDS:
            print(f"trellage session {arguments.command}: {error}", file=sys.stderr)
            return 1
        if arguments.command == "install-hook":
            print(f"trellage session bridge install: {error}", file=sys.stderr)
            return 1
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
