import importlib.util
import hashlib
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch


SCRIPT = Path(__file__).parents[1] / "scripts" / "trellage-session-bridge.py"
SPEC = importlib.util.spec_from_file_location("trellage_session_bridge", SCRIPT)
BRIDGE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BRIDGE)


class TrellageSessionBridgeTest(unittest.TestCase):
    def test_install_hook_failure_returns_nonzero(self):
        result = subprocess.run(
            [
                sys.executable,
                str(SCRIPT),
                "install-hook",
                "--agent",
                "copilot",
                "--profile",
                "profile",
                "--mode",
                "native",
                "--config-dir",
                "/missing/config",
                "--hook-path",
                "/missing/bridge",
            ],
            check=False,
            capture_output=True,
            text=True,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("trellage session bridge install:", result.stderr)

    def test_serializes_maximum_unicode_answer_without_ascii_expansion(self):
        source = BRIDGE.serialize_result(
            {
                "version": 1,
                "agent": "claude",
                "profile": "claude-research",
                "session_id": "session",
                "answer": "界" * BRIDGE.MAX_ANSWER_CHARS,
            }
        )
        self.assertIn("界", source)
        self.assertNotIn("\\u754c", source)
        self.assertLess(len(source.encode("utf-8")), 512 * 1024)

    def test_extracts_top_level_completed_messages(self):
        copilot = [
            {
                "type": "session.task_complete",
                "data": {"summary": "Parent answer"},
            },
            {
                "type": "assistant.message",
                "agentId": "nested",
                "data": {
                    "parentToolCallId": "tool",
                    "phase": "final_answer",
                    "content": "Nested answer",
                },
            },
        ]
        codex = [
            {
                "type": "response_item",
                "payload": {
                    "type": "message",
                    "role": "assistant",
                    "content": [{"type": "output_text", "text": "Codex answer"}],
                },
            }
        ]
        claude = [
            {
                "type": "assistant",
                "message": {
                    "id": "message-1",
                    "content": [{"type": "text", "text": "Claude answer"}],
                    "stop_reason": None,
                },
            },
            {
                "type": "assistant",
                "message": {
                    "id": "message-1",
                    "content": [],
                    "stop_reason": "end_turn",
                },
            },
        ]

        self.assertEqual(BRIDGE.copilot_final_message(copilot), "Parent answer")
        self.assertEqual(BRIDGE.codex_final_message(codex), "Codex answer")
        self.assertEqual(BRIDGE.claude_final_message(claude), "Claude answer")

    def test_uses_a_later_copilot_answer_after_an_older_completion(self):
        records = [
            {
                "type": "session.task_complete",
                "data": {"summary": "Older answer"},
            },
            {
                "type": "assistant.message",
                "data": {"content": "Current answer"},
            },
        ]
        self.assertEqual(BRIDGE.copilot_final_message(records), "Current answer")

    def test_reads_each_supported_session_start_payload(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(
                BRIDGE.session_from_hook(
                    "copilot",
                    {
                        "hookEventName": "SessionStart",
                        "sessionId": "10111111-1111-4111-8111-111111111111",
                    },
                ),
                {
                    "session_id": "10111111-1111-4111-8111-111111111111",
                    "transcript_path": None,
                },
            )
            self.assertEqual(
                BRIDGE.session_from_hook(
                    "codex",
                    {
                        "hook_event_name": "SessionStart",
                        "session_id": "20222222-2222-4222-8222-222222222222",
                        "transcript_path": "/home/agent/.codex/sessions/session.jsonl",
                    },
                ),
                {
                    "session_id": "20222222-2222-4222-8222-222222222222",
                    "transcript_path": "/home/agent/.codex/sessions/session.jsonl",
                },
            )
            self.assertEqual(
                BRIDGE.session_from_hook(
                    "claude",
                    {
                        "hook_event_name": "SessionStart",
                        "session_id": "30333333-3333-4333-8333-333333333333",
                        "transcript_path": "/home/agent/.claude/projects/session.jsonl",
                    },
                ),
                {
                    "session_id": "30333333-3333-4333-8333-333333333333",
                    "transcript_path": "/home/agent/.claude/projects/session.jsonl",
                },
            )

    def test_maps_one_sandbox_invocation_to_one_exact_copilot_session(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            session_id = "11111111-1111-4111-8111-111111111111"
            transcript = home / ".copilot" / "session-state" / session_id / "events.jsonl"
            transcript.parent.mkdir(parents=True)
            transcript.write_text(
                json.dumps(
                    {
                        "type": "session.task_complete",
                        "data": {"summary": "Exact Sandbox answer"},
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            with patch.dict(os.environ, {"HOME": temporary}, clear=True):
                BRIDGE.write_sandbox_mapping(
                    "copilot",
                    "copilot-hve",
                    "a" * 32,
                    {"session_id": session_id, "transcript_path": None},
                )
                result = BRIDGE.final_message("copilot", "copilot-hve", "a" * 32)

            self.assertEqual(result["session_id"], session_id)
            self.assertEqual(result["answer"], "Exact Sandbox answer")
            mapping = home / ".trellage" / "herdr-session-bridge" / f"{'a' * 32}.json"
            self.assertEqual(mapping.stat().st_mode & 0o777, 0o600)
            self.assertEqual(mapping.parent.stat().st_mode & 0o777, 0o700)

    def test_conflicting_sandbox_session_mapping_fails_closed(self):
        with tempfile.TemporaryDirectory() as temporary:
            with patch.dict(os.environ, {"HOME": temporary}, clear=True):
                first = {
                    "session_id": "11111111-1111-4111-8111-111111111111",
                    "transcript_path": None,
                }
                second = {
                    "session_id": "22222222-2222-4222-8222-222222222222",
                    "transcript_path": None,
                }
                BRIDGE.write_sandbox_mapping("copilot", "copilot-hve", "b" * 32, first)
                BRIDGE.write_sandbox_mapping("copilot", "copilot-hve", "b" * 32, second)
                with self.assertRaisesRegex(BRIDGE.BridgeError, "conflicting session identities"):
                    BRIDGE.final_message("copilot", "copilot-hve", "b" * 32)

    def test_rejects_transcript_paths_outside_the_agent_state_root(self):
        with tempfile.TemporaryDirectory() as temporary:
            outside = Path(temporary) / "outside.jsonl"
            outside.write_text("{}\n", encoding="utf-8")
            with patch.dict(os.environ, {"HOME": temporary}, clear=True):
                BRIDGE.write_sandbox_mapping(
                    "claude",
                    "claude-research",
                    "c" * 32,
                    {
                        "session_id": "33333333-3333-4333-8333-333333333333",
                        "transcript_path": str(outside),
                    },
                )
                with self.assertRaisesRegex(BRIDGE.BridgeError, "outside the harness state root"):
                    BRIDGE.final_message("claude", "claude-research", "c" * 32)

    def test_rejects_symlinked_transcripts_inside_the_agent_state_root(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            projects = home / ".claude" / "projects"
            projects.mkdir(parents=True)
            target = projects / "target.jsonl"
            target.write_text(
                json.dumps(
                    {
                        "type": "assistant",
                        "sessionId": "33333333-3333-4333-8333-333333333333",
                        "message": {
                            "id": "message-1",
                            "content": [{"type": "text", "text": "Answer"}],
                            "stop_reason": "end_turn",
                        },
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            linked = projects / "linked.jsonl"
            linked.symlink_to(target)
            with patch.dict(os.environ, {"HOME": temporary}, clear=True):
                BRIDGE.write_sandbox_mapping(
                    "claude",
                    "claude-research",
                    "d" * 32,
                    {
                        "session_id": "33333333-3333-4333-8333-333333333333",
                        "transcript_path": str(linked),
                    },
                )
                with self.assertRaisesRegex(BRIDGE.BridgeError, "must not traverse symlinks"):
                    BRIDGE.final_message("claude", "claude-research", "d" * 32)

    def test_rejects_codex_transcript_content_for_another_session(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            transcript = home / ".codex" / "sessions" / "codex.jsonl"
            transcript.parent.mkdir(parents=True)
            transcript.write_text(
                "\n".join(
                    [
                        json.dumps(
                            {
                                "type": "session_meta",
                                "payload": {
                                    "id": "55555555-5555-4555-8555-555555555555",
                                    "cwd": "/repo",
                                },
                            }
                        ),
                        json.dumps(
                            {
                                "type": "event_msg",
                                "payload": {"type": "agent_message", "message": "Wrong session"},
                            }
                        ),
                    ]
                )
                + "\n",
                encoding="utf-8",
            )
            with patch.dict(os.environ, {"HOME": temporary}, clear=True):
                BRIDGE.write_sandbox_mapping(
                    "codex",
                    "codex-profile",
                    "e" * 32,
                    {
                        "session_id": "66666666-6666-4666-8666-666666666666",
                        "transcript_path": str(transcript),
                    },
                )
                with self.assertRaisesRegex(BRIDGE.BridgeError, "conflicts with the mapped session ID"):
                    BRIDGE.final_message("codex", "codex-profile", "e" * 32)

    def test_reports_native_session_as_display_only_metadata(self):
        with tempfile.TemporaryDirectory() as temporary:
            socket_path = str(Path(temporary) / "herdr.sock")
            received = {}
            ready = threading.Event()

            def server():
                with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as listener:
                    listener.bind(socket_path)
                    listener.listen(3)
                    ready.set()
                    for _ in range(3):
                        connection, _ = listener.accept()
                        with connection:
                            request = json.loads(connection.recv(16_384).decode().strip())
                            if request["method"] == "agent.get":
                                response = {
                                    "id": request["id"],
                                    "result": {
                                        "type": "agent_info",
                                        "agent": {
                                            "pane_id": "w1:p1",
                                            "agent": "codex",
                                            "agent_status": "working",
                                            "state_change_seq": 17,
                                        },
                                    },
                                }
                            elif request["method"] == "pane.process_info":
                                response = {
                                    "id": request["id"],
                                    "result": {
                                        "type": "pane_process_info",
                                        "process_info": {
                                            "pane_id": "w1:p1",
                                            "foreground_process_group_id": 2468,
                                        },
                                    },
                                }
                            else:
                                received.update(request)
                                response = {"id": request["id"], "result": {}}
                            connection.sendall((json.dumps(response) + "\n").encode())

            thread = threading.Thread(target=server)
            thread.start()
            ready.wait(timeout=2)
            environment = {
                "HERDR_ENV": "1",
                "HERDR_SOCKET_PATH": socket_path,
                "HERDR_PANE_ID": "w1:p1",
            }
            with patch.dict(os.environ, environment, clear=True):
                BRIDGE.report_native_session(
                    "codex",
                    "rpi",
                    {"session_id": "44444444-4444-4444-8444-444444444444"},
                )
            thread.join(timeout=2)

            self.assertEqual(received["method"], "pane.report_metadata")
            self.assertEqual(received["params"]["agent"], "codex")
            self.assertEqual(
                received["params"]["tokens"],
                {
                    "trellage_surface": "native",
                    "trellage_agent": "codex",
                    "trellage_profile": "rpi",
                    "trellage_session_id": "44444444-4444-4444-8444-444444444444",
                    "trellage_state_seq": "17",
                    "trellage_pgrp": "2468",
                },
            )
            self.assertEqual(received["params"]["source"], "trellage.guide-handoff")
            self.assertEqual(received["params"]["seq"], 35)
            self.assertNotIn("agent_session_id", received["params"])

    def test_rejects_claude_subagent_session_hooks(self):
        with self.assertRaisesRegex(BRIDGE.BridgeError, "subagent"):
            BRIDGE.session_from_hook(
                "claude",
                {
                    "hook_event_name": "SessionStart",
                    "session_id": "55555555-5555-4555-8555-555555555555",
                    "transcript_path": "/home/agent/.claude/projects/subagent.jsonl",
                    "agent_id": "subagent-1",
                },
            )

    def test_installs_idempotent_hooks_without_replacing_existing_hooks(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            hook_path = root / "trellage-session-bridge"
            hook_path.write_text("#!/bin/sh\n", encoding="utf-8")
            for agent in ("copilot", "codex", "claude"):
                config_dir = root / agent
                config_dir.mkdir()
                file_path = config_dir / ("hooks.json" if agent == "codex" else "settings.json")
                file_path.write_text(
                    json.dumps({"hooks": {"SessionStart": [{"type": "existing"}]}}),
                    encoding="utf-8",
                )
                BRIDGE.install_hook(agent, "profile", "native", config_dir, hook_path)
                BRIDGE.install_hook(agent, "profile", "native", config_dir, hook_path)
                settings = json.loads(file_path.read_text(encoding="utf-8"))
                entries = settings["hooks"]["SessionStart"]
                self.assertEqual(entries[0], {"type": "existing"})
                self.assertEqual(len(entries), 2)
                serialized = json.dumps(entries[1])
                self.assertIn("native-hook", serialized)
                self.assertIn("--profile profile", serialized)

    def test_accepts_profile_names_longer_than_eighty_characters(self):
        profile = "p" * 81
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            hook_path = root / "trellage-session-bridge"
            hook_path.write_text("#!/bin/sh\n", encoding="utf-8")
            config_dir = root / "copilot"
            config_dir.mkdir()

            BRIDGE.install_hook("copilot", profile, "native", config_dir, hook_path)

            settings = json.loads((config_dir / "settings.json").read_text(encoding="utf-8"))
            self.assertIn(f"--profile {profile}", json.dumps(settings))


class TrellageConversationBridgeTest(unittest.TestCase):
    session_id = "11111111-1111-4111-8111-111111111111"
    invocation = "a" * 32
    container = "b" * 64

    def setUp(self):
        self.fixture = tempfile.TemporaryDirectory(prefix="conversation-")
        self.addCleanup(self.fixture.cleanup)
        self.home = Path(self.fixture.name).resolve()
        environment = patch.dict(os.environ, {"HOME": str(self.home)}, clear=True)
        environment.start()
        self.addCleanup(environment.stop)

    def write_transcript(self, agent="copilot", records=None):
        if records is None:
            records = self.copilot_turns()
        if agent == "copilot":
            transcript = self.home / ".copilot" / "session-state" / self.session_id / "events.jsonl"
            mapped_path = None
        elif agent == "codex":
            transcript = self.home / ".codex" / "sessions" / "session.jsonl"
            records = [{"type": "session_meta", "payload": {"id": self.session_id}}] + records
            mapped_path = str(transcript)
        else:
            transcript = self.home / ".claude" / "projects" / "project" / "session.jsonl"
            records = [{"sessionId": self.session_id, **record} for record in records]
            mapped_path = str(transcript)
        transcript.parent.mkdir(parents=True, exist_ok=True)
        transcript.write_bytes(b"".join(BRIDGE.json_bytes(record) + b"\n" for record in records))
        BRIDGE.write_sandbox_mapping(
            agent, f"{agent}-profile", self.invocation,
            {"session_id": self.session_id, "transcript_path": mapped_path},
        )
        return transcript

    def copilot_turns(self, count=1, text="answer"):
        records = []
        for index in range(count):
            records.extend([
                {"id": f"user-{index}", "type": "user.message", "data": {"content": "goal"}},
                {"id": f"assistant-{index}", "type": "assistant.message",
                 "data": {"content": text, "phase": "final_answer"}},
            ])
        return records

    def export(self, agent="copilot", cursor=None, container=None, invocation=None):
        return BRIDGE.export_conversation(
            agent, f"{agent}-profile", invocation or self.invocation, container or self.container,
            cursor=cursor,
        )

    def describe(self, snapshot_id=None):
        return BRIDGE.describe_conversation(
            "copilot", "copilot-profile", self.invocation, self.container, snapshot_id
        )

    def release(self, snapshot_id):
        return BRIDGE.release_conversation(
            "copilot", "copilot-profile", self.invocation, self.container, snapshot_id
        )

    def snapshot_path(self, snapshot_id):
        return self.home / ".trellage" / "herdr-session-bridge" / "conversations" / f"{snapshot_id}.json"

    def paginated_export(self):
        self.write_transcript(records=self.copilot_turns(12, "answer " * 60))
        return self.export()

    def test_exports_private_sealed_normalized_snapshot_and_releases_it(self):
        self.write_transcript()
        result = self.export()
        self.assertEqual(result["schemaVersion"], 1)
        self.assertEqual(result["sessionId"], self.session_id)
        self.assertEqual(result["containerId"], self.container)
        self.assertEqual(result["invocationId"], self.invocation)
        self.assertEqual(result["coverage"], {"complete": True, "notices": []})
        self.assertEqual(result["page"], {"index": 0, "total": 1, "nextCursor": None})
        self.assertEqual([message["role"] for message in result["messages"]], ["user", "assistant"])
        self.assertEqual([message["recordIndex"] for message in result["messages"]], [0, 1])
        self.assertEqual(
            result["revision"], hashlib.sha256(BRIDGE.json_bytes(result["messages"])).hexdigest()
        )
        snapshot = self.snapshot_path(result["snapshotId"])
        self.assertEqual(hashlib.sha256(snapshot.read_bytes()).hexdigest(), result["snapshotId"])
        self.assertEqual(snapshot.stat().st_mode & 0o777, 0o600)
        self.assertEqual(snapshot.parent.stat().st_mode & 0o777, 0o700)
        self.assertNotIn("transcript_path", result)
        self.assertFalse(self.describe(result["snapshotId"])["changed"])
        self.assertTrue(self.release(result["snapshotId"])["released"])
        self.assertFalse(snapshot.exists())

    def test_filters_internal_tools_reasoning_nested_and_unfinished_messages(self):
        records = [
            {"type": "system", "content": "private instructions"},
            {"type": "user.message", "isMeta": True, "data": {"content": "injected"}},
            {"id": "u1", "type": "user.message", "data": {"content": "question"}},
            {"type": "assistant.message", "data": {"content": "commentary", "phase": "commentary"}},
            {"type": "assistant.reasoning", "data": {"content": "reasoning"}},
            {"type": "tool.execution_complete", "data": {"content": "tool output"}},
            {"type": "assistant.message", "agentId": "child",
             "data": {"phase": "final_answer", "content": "child output"}},
            {"id": "a1", "type": "assistant.message",
             "data": {"phase": "final_answer", "content": "answer"}},
            {"type": "session.task_complete", "data": {"summary": "alternate presentation"}},
            {"type": "user.message", "data": {"content": "unfinished next question"}},
            {"type": "assistant.message", "data": {"content": "unfinished answer"}},
        ]
        self.write_transcript(records=records)
        result = self.export()
        self.assertEqual([message["text"] for message in result["messages"]], ["question", "answer"])
        self.assertEqual(result["cutoff"]["recordIndex"], 7)
        self.assertIn("pending-turn-excluded", result["coverage"]["notices"])

    def test_copilot_legacy_message_requires_a_completion_boundary(self):
        for terminal in ("assistant.turn_end", "session.idle", "session.task_complete"):
            with self.subTest(terminal=terminal):
                self.write_transcript(records=[
                    {"type": "user.message", "data": {"content": "question"}},
                    {"type": "assistant.message", "data": {"content": "legacy answer"}},
                    {"type": terminal, "data": {"summary": "completion summary"}},
                ])
                expected = "completion summary" if terminal == "session.task_complete" else "legacy answer"
                self.assertEqual(self.export()["messages"][-1]["text"], expected)
        self.write_transcript(records=[
            {"type": "user.message", "data": {"content": "question"}},
            {"type": "assistant.message", "data": {"content": "partial"}},
        ])
        with self.assertRaisesRegex(BRIDGE.BridgeError, "no unambiguous completed"):
            self.export()

    def test_filters_internal_origins_and_subagent_aliases(self):
        records = [
            {"type": "user.message", "data": {"source": origin, "content": "hidden"}}
            for origin in ("system", "developer", "tool", "agent", "internal", "synthetic")
        ]
        records.extend(self.copilot_turns())
        records.extend([
            {"type": "assistant.message", key: value, "data": {"phase": "final_answer", "content": "child"}}
            for key, value in (("subagentId", "child"), ("subagent_id", "child"), ("is_sidechain", True))
        ])
        self.write_transcript(records=records)
        self.assertEqual([entry["text"] for entry in self.export()["messages"]], ["goal", "answer"])

    def test_tool_execution_does_not_complete_a_pending_copilot_comment(self):
        self.write_transcript(records=[
            *self.copilot_turns(),
            {"type": "user.message", "data": {"content": "next question"}},
            {"type": "assistant.message", "data": {"content": "unmarked tool commentary"}},
            {"type": "tool.execution_start"},
            {"type": "session.idle"},
        ])
        result = self.export()
        self.assertEqual([entry["text"] for entry in result["messages"]], ["goal", "answer"])
        self.assertIn("pending-turn-excluded", result["coverage"]["notices"])

    def test_codex_filters_wrappers_and_duplicate_presentations(self):
        self.write_transcript("codex", [
            {"type": "response_item", "payload": {"type": "message", "role": "developer",
             "content": [{"type": "input_text", "text": "private instructions"}]}},
            {"type": "response_item", "payload": {"type": "message", "role": "user",
             "content": [{"type": "input_text", "text": "<environment_context>hidden</environment_context>"}]}},
            {"type": "event_msg", "payload": {"type": "user_message",
             "messageId": "human-1", "message": "human question"}},
            {"type": "response_item", "payload": {"type": "message", "role": "user",
             "messageId": "human-1",
             "internal_chat_message_metadata_passthrough": {"content_item_kinds": ["user.text"]},
             "content": [{"type": "input_text", "text": "human question"}]}},
            {"type": "response_item", "payload": {"type": "message", "role": "assistant",
             "phase": "commentary", "content": [{"type": "output_text", "text": "working"}]}},
            {"type": "response_item", "payload": {"type": "message", "role": "assistant",
             "phase": "final_answer", "content": [{"type": "output_text", "text": "Codex answer"}]}},
            {"type": "event_msg", "payload": {"type": "agent_message", "message": "Codex answer"}},
            {"type": "event_msg", "payload": {"type": "task_complete", "last_agent_message": "Codex answer"}},
        ])
        result = self.export("codex")
        self.assertEqual([message["text"] for message in result["messages"]], ["human question", "Codex answer"])

    def test_codex_discards_response_stranded_before_compaction_accounting(self):
        self.write_transcript("codex", [
            {"type": "response_item", "payload": {"type": "message", "role": "user",
             "internal_chat_message_metadata_passthrough": {"content_item_kinds": ["user.text"]},
             "content": [{"type": "input_text", "text": "question"}]}},
            {"type": "response_item", "payload": {"type": "message", "role": "assistant",
             "phase": "final_answer", "content": [{"type": "output_text", "text": "private"}]}},
            {"type": "token_usage_record", "payload": {"input_tokens": 1, "output_tokens": 1}},
            {"type": "event_msg", "payload": {"type": "token_count", "total": 2}},
            {"type": "compacted", "payload": {"type": "context_compacted"}},
        ])
        with self.assertRaisesRegex(BRIDGE.BridgeError, "no unambiguous completed"):
            self.export("codex")

    def test_codex_preserves_response_after_visible_completion_before_compaction(self):
        self.write_transcript("codex", [
            {"type": "response_item", "payload": {"type": "message", "role": "user",
             "internal_chat_message_metadata_passthrough": {"content_item_kinds": ["user.text"]},
             "content": [{"type": "input_text", "text": "question"}]}},
            {"type": "response_item", "payload": {"type": "message", "role": "assistant",
             "phase": "final_answer", "content": [{"type": "output_text", "text": "visible"}]}},
            {"type": "event_msg", "payload": {"type": "task_complete"}},
            {"type": "token_usage_record", "payload": {"input_tokens": 1, "output_tokens": 1}},
            {"type": "compacted", "payload": {"type": "context_compacted"}},
        ])
        self.assertEqual([message["text"] for message in self.export("codex")["messages"]], ["question", "visible"])

    def test_codex_does_not_promote_pending_event_answer_across_compaction(self):
        self.write_transcript("codex", [
            {"type": "event_msg", "payload": {"type": "user_message", "message": "question"}},
            {"type": "event_msg", "payload": {"type": "agent_message", "message": "private"}},
            {"type": "token_usage_record", "payload": {"input_tokens": 1, "output_tokens": 1}},
            {"type": "event_msg", "payload": {"type": "token_count", "total": 2}},
            {"type": "compacted", "payload": {"type": "context_compacted"}},
        ])
        with self.assertRaisesRegex(BRIDGE.BridgeError, "no unambiguous completed"):
            self.export("codex")

    def test_codex_legacy_answer_waits_for_task_completion(self):
        self.write_transcript("codex", [
            {"type": "response_item", "payload": {"type": "message", "role": "user",
             "internal_chat_message_metadata_passthrough": {"content_item_kinds": ["user.text"]},
             "content": [{"type": "input_text", "text": "question"}]}},
            {"type": "event_msg", "payload": {"type": "agent_message", "message": "legacy answer"}},
            {"type": "event_msg", "payload": {"type": "task_complete"}},
        ])
        self.assertEqual([message["text"] for message in self.export("codex")["messages"]], ["question", "legacy answer"])

    def test_codex_mixed_user_blocks_never_export_injected_instructions(self):
        records = [
            {"type": "response_item", "payload": {"type": "message", "role": "user",
             "internal_chat_message_metadata_passthrough": {"content_item_kinds": ["user.text", "system.instructions"]},
             "content": [{"type": "input_text", "text": "question"}, {"type": "input_text", "text": "hidden instructions"}]}},
            {"type": "response_item", "payload": {"type": "message", "role": "assistant",
             "phase": "final_answer", "content": [{"type": "output_text", "text": "answer"}]}},
        ]
        self.write_transcript("codex", records)
        self.assertEqual([entry["text"] for entry in self.export("codex")["messages"]], ["question", "answer"])
        records[0]["payload"]["content"].append({"type": "input_text", "text": "ambiguous"})
        self.write_transcript("codex", records)
        with self.assertRaisesRegex(BRIDGE.BridgeError, "cannot be separated"):
            self.export("codex")

    def test_codex_tool_call_does_not_commit_a_pending_legacy_message(self):
        self.write_transcript("codex", [
            {"type": "event_msg", "payload": {"type": "user_message", "message": "first question"}},
            {"type": "response_item", "payload": {"type": "message", "role": "assistant",
             "phase": "final_answer", "content": [{"type": "output_text", "text": "answer"}]}},
            {"type": "event_msg", "payload": {"type": "user_message", "message": "next question"}},
            {"type": "response_item", "payload": {"type": "message", "role": "assistant",
             "content": [{"type": "output_text", "text": "tool commentary"}]}},
            {"type": "response_item", "payload": {"type": "function_call", "name": "example"}},
            {"type": "event_msg", "payload": {"type": "task_complete"}},
        ])
        self.assertEqual([entry["text"] for entry in self.export("codex")["messages"]], ["first question", "answer"])

    def test_claude_assembles_completed_fragments_without_deduplicating_repeated_text(self):
        self.write_transcript("claude", [
            {"type": "user", "uuid": "u1", "message": {"role": "user", "content": "question"}},
            {"type": "assistant", "uuid": "a1", "message": {"id": "answer-1",
             "content": [{"type": "text", "text": "repeat"}, {"type": "thinking", "thinking": "hidden"}]}},
            {"type": "assistant", "uuid": "a2", "message": {"id": "answer-1",
             "content": [{"type": "text", "text": "repeat"}]}},
            {"type": "assistant", "uuid": "a3", "message": {"id": "answer-1", "content": [], "stop_reason": "end_turn"}},
            {"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "content": "hidden"}]}},
            {"type": "assistant", "isSidechain": True, "message": {"id": "child",
             "content": [{"type": "text", "text": "child"}], "stop_reason": "end_turn"},
             "sessionId": "nested-session"},
            {"type": "assistant", "message": {"id": "unfinished", "content": [{"type": "text", "text": "partial"}]}},
        ])
        result = self.export("claude")
        self.assertEqual([message["text"] for message in result["messages"]], ["question", "repeat\nrepeat"])
        self.assertEqual(result["cutoff"]["recordIndex"], 3)

    def test_claude_indexed_block_updates_are_one_message(self):
        self.write_transcript("claude", [
            {"type": "user", "message": {"content": "question"}},
            {"type": "assistant", "message": {"id": "a",
             "content": [{"type": "text", "index": 0, "text": "Hello"}]}},
            {"type": "assistant", "message": {"id": "a", "stop_reason": "end_turn",
             "content": [{"type": "text", "index": 0, "text": "Hello world"}]}},
        ])
        self.assertEqual(self.export("claude")["messages"][-1]["text"], "Hello world")

    def test_claude_deduplicates_block_identity_and_excludes_tool_turns(self):
        self.write_transcript("claude", [
            {"type": "user", "message": {"content": "question"}},
            {"type": "assistant", "uuid": "a1", "message": {"id": "answer",
             "content": [{"type": "text", "id": "block-1", "text": "answer"}]}},
            {"type": "assistant", "uuid": "a2", "message": {"id": "answer", "stop_reason": "end_turn",
             "content": [{"type": "text", "id": "block-1", "text": "answer"}]}},
            {"type": "assistant", "message": {"id": "tool-turn", "stop_reason": "end_turn",
             "content": [{"type": "text", "text": "tool commentary"}, {"type": "tool_use", "id": "tool"}]}},
        ])
        self.assertEqual([entry["text"] for entry in self.export("claude")["messages"]], ["question", "answer"])

    def test_sanitizes_control_characters_and_credentials_in_visible_messages(self):
        records = self.copilot_turns()
        records[0]["data"]["content"] = "question\x1b[31m ghp_" + "abcdefghijklmnopqrstuvwxyz1234"
        self.write_transcript(records=records)
        result = self.export()
        self.assertEqual(result["messages"][0]["text"], "question [REDACTED credential]")
        self.assertIn("Conversation credentials were redacted.", result["coverage"]["notices"])
        self.assertIn("Terminal control sequences were removed.", result["coverage"]["notices"])

    def test_export_never_persists_raw_credentials_or_controls(self):
        records = self.copilot_turns()
        records[0]["data"]["content"] = 'password="Abcd12345678!rest"\x1b]8;;https://secret.example\x07link'
        records[1]["data"]["content"] = "-----BEGIN " + "PRIVATE KEY-----secret-----END PRIVATE KEY-----"
        self.write_transcript(records=records)
        result = self.export()
        encoded = json.dumps(result, ensure_ascii=False)
        self.assertNotIn("Abcd12345678", encoded)
        self.assertNotIn("BEGIN " + "PRIVATE KEY", encoded)
        self.assertNotIn("\x1b", encoded)

    def test_export_redacts_escaped_quote_credentials_without_suffix_leaks(self):
        records = self.copilot_turns()
        records[0]["data"]["content"] = 'password="short\\"secretpasswordvalue-longprefix"'
        self.write_transcript(records=records)
        text = self.export()["messages"][0]["text"]
        self.assertNotIn("secretpasswordvalue", text)
        self.assertIn("[REDACTED credential]", text)

    def test_export_preserves_nfkc_sensitive_prose_while_redacting_projected_tokens(self):
        records = self.copilot_turns()
        records[0]["data"]["content"] = "Use ﬀ as key; label ①; 令牌ghp_" + "abcdefghijklmnopqrstuvwxyz1234"
        self.write_transcript(records=records)
        text = self.export()["messages"][0]["text"]
        self.assertIn("ﬀ", text)
        self.assertIn("①", text)
        self.assertIn("令牌[REDACTED credential]", text)

    def test_export_redacts_assignments_adjacent_to_unicode_prose(self):
        records = self.copilot_turns()
        records[0]["data"]["content"] = '设置password="secretpasswordvalue" 和api_key=anothersecretvalue'
        self.write_transcript(records=records)
        self.assertEqual(self.export()["messages"][0]["text"],
                         '设置password="[REDACTED credential]" 和api_key=[REDACTED credential]')

    def test_internal_origin_cannot_be_overridden_by_public_source(self):
        records = self.copilot_turns()
        records.insert(1, {"type": "assistant.message", "origin": "internal",
                           "data": {"source": "cli", "phase": "final_answer", "content": "private handoff"}})
        self.write_transcript(records=records)
        self.assertEqual([message["text"] for message in self.export()["messages"]], ["goal", "answer"])

    def test_preserves_repeated_human_text_and_deduplicates_only_event_identity(self):
        records = self.copilot_turns(2)
        records.insert(1, records[0].copy())
        self.write_transcript(records=records)
        result = self.export()
        self.assertEqual([message["text"] for message in result["messages"]], ["goal", "answer", "goal", "answer"])
        self.assertEqual(len({message["id"] for message in result["messages"]}), 4)
        records[1] = {**records[0], "data": {"content": "conflict"}}
        self.write_transcript(records=records)
        with self.assertRaisesRegex(BRIDGE.BridgeError, "conflicting event"):
            self.export()

    def test_discloses_compaction_and_missing_attachments(self):
        records = self.copilot_turns()
        records[0]["data"]["attachments"] = [{"type": "file", "path": "not-read"}]
        records.insert(0, {"type": "session.compaction_complete", "summary": "not original history"})
        self.write_transcript(records=records)
        result = self.export()
        self.assertFalse(result["coverage"]["complete"])
        self.assertEqual(result["coverage"]["notices"], ["attachments-not-included", "compacted-history"])
        self.assertEqual(len(result["messages"]), 2)

    def test_codex_discloses_compacted_history_without_exporting_replacement_instructions(self):
        self.write_transcript("codex", [
            {"type": "compacted", "payload": {"message": "private compaction summary",
             "replacement_history": [{"role": "user", "content": "not an original human message"}]}},
            {"type": "event_msg", "payload": {"type": "user_message", "message": "question"}},
            {"type": "event_msg", "payload": {"type": "agent_message",
             "phase": "final_answer", "message": "answer"}},
            {"type": "event_msg", "payload": {"type": "task_complete"}},
        ])
        result = self.export("codex")
        self.assertEqual([message["text"] for message in result["messages"]], ["question", "answer"])
        self.assertEqual(result["coverage"], {"complete": False, "notices": ["compacted-history"]})

    def test_captures_history_larger_than_old_tail_and_answer_limits(self):
        records = self.copilot_turns(text="界" * 80_000)
        records[1:1] = [
            {"type": "tool.execution_complete", "data": {"output": "x" * 900_000}}
            for _index in range(10)
        ]
        transcript = self.write_transcript(records=records)
        self.assertGreater(transcript.stat().st_size, BRIDGE.MAX_TRANSCRIPT_BYTES)
        result = self.export()
        self.assertEqual(result["messages"][0]["text"], "goal")
        self.assertEqual(result["messages"][-1]["text"], "界" * 80_000)
        self.assertTrue(result["coverage"]["complete"])

    def test_opaque_pages_stay_frozen_when_source_appends(self):
        with patch.dict(BRIDGE.CONVERSATION_POLICY, {"page_bytes": 4096}):
            first = self.paginated_export()
            self.assertGreater(first["page"]["total"], 1)
            transcript = self.home / ".copilot" / "session-state" / self.session_id / "events.jsonl"
            with transcript.open("ab") as handle:
                handle.write(BRIDGE.json_bytes({"type": "user.message", "data": {"content": "new question"}}) + b"\n")
            messages = first["messages"].copy()
            current = first
            while current["page"]["nextCursor"] is not None:
                following = self.export(cursor=current["page"]["nextCursor"])
                self.assertEqual(following["page"]["index"], current["page"]["index"] + 1)
                self.assertEqual(following["revision"], first["revision"])
                self.assertEqual(following["snapshotId"], first["snapshotId"])
                messages.extend(following["messages"])
                current = following
            self.assertEqual(len(messages), 24)
            self.assertEqual(hashlib.sha256(BRIDGE.json_bytes(messages)).hexdigest(), first["revision"])
            self.assertNotIn("new question", [message["text"] for message in messages])
            changed = self.describe(first["snapshotId"])
            self.assertTrue(changed["changed"])
            self.assertEqual(changed["revision"], first["revision"])
            self.assertNotEqual(changed["activityRevision"], first["activityRevision"])

    def test_tool_only_append_is_not_new_conversation_activity(self):
        transcript = self.write_transcript()
        first = self.export()
        with transcript.open("ab") as handle:
            handle.write(b'{"type":"tool.execution_complete","data":{"output":"hidden"}}\n')
        self.assertFalse(self.describe(first["snapshotId"])["changed"])

    def test_dropping_pending_assistant_for_tools_does_not_change_activity_revision(self):
        transcript = self.write_transcript(records=[
            *self.copilot_turns(),
            {"type": "user.message", "data": {"content": "next question"}},
            {"type": "assistant.message", "data": {"content": "unfinished assistant"}},
        ])
        first = self.export()
        with transcript.open("ab") as handle:
            for record in (
                {"type": "tool.execution_start"},
                {"type": "assistant.message", "subagentId": "child",
                 "data": {"phase": "final_answer", "content": "nested answer"}},
                {"type": "session.idle"},
            ):
                handle.write(BRIDGE.json_bytes(record) + b"\n")
        current = self.describe(first["snapshotId"])
        self.assertFalse(current["changed"])
        self.assertEqual(current["revision"], first["revision"])
        self.assertEqual(current["activityRevision"], first["activityRevision"])
        self.assertEqual(current["cutoff"], first["cutoff"])

    def test_ignores_only_one_incomplete_trailing_record(self):
        transcript = self.write_transcript()
        with transcript.open("ab") as handle:
            handle.write(b'{"type":"assistant.message","data":{"content":"\xe7')
        self.assertIn("incomplete-tail", self.export()["coverage"]["notices"])
        with transcript.open("ab") as handle:
            handle.write(b"\n")
        with self.assertRaisesRegex(BRIDGE.BridgeError, "invalid JSON"):
            self.export()

    def test_keeps_a_complete_final_record_without_a_trailing_newline(self):
        transcript = self.write_transcript()
        transcript.write_bytes(transcript.read_bytes().rstrip(b"\n"))
        first = self.export()
        self.assertEqual(first["messages"][-1]["text"], "answer")
        self.assertTrue(first["coverage"]["complete"])
        with transcript.open("ab") as handle:
            handle.write(b"\n")
        self.assertFalse(self.describe(first["snapshotId"])["changed"])

    def test_rejects_malformed_complete_json_tail_without_a_newline(self):
        transcript = self.write_transcript()
        with transcript.open("ab") as handle:
            handle.write(b'{"type":"assistant.message","type":"system"}')
        with self.assertRaisesRegex(BRIDGE.BridgeError, "duplicate fields"):
            self.export()

    def test_rejects_malformed_complete_nonobject_and_duplicate_field_records(self):
        for line in (b"{bad}\n", b"[]\n", b'{"type":{}}\n', b'{"type":"system","type":"user.message"}\n'):
            with self.subTest(line=line):
                transcript = self.write_transcript()
                with transcript.open("ab") as handle:
                    handle.write(line)
                with self.assertRaises(BRIDGE.BridgeError):
                    self.export()

    def test_rejects_replacement_truncation_and_in_place_prefix_changes_between_pages(self):
        with patch.dict(BRIDGE.CONVERSATION_POLICY, {"page_bytes": 4096}):
            for change in ("replace", "truncate", "rewrite"):
                with self.subTest(change=change):
                    first = self.paginated_export()
                    transcript = self.home / ".copilot" / "session-state" / self.session_id / "events.jsonl"
                    source = transcript.read_bytes()
                    if change == "replace":
                        transcript.rename(transcript.with_suffix(".old"))
                        transcript.write_bytes(source)
                    elif change == "truncate":
                        transcript.write_bytes(source[:-2])
                    else:
                        transcript.write_bytes(source.replace(b"goal", b"evil", 1))
                    with self.assertRaisesRegex(BRIDGE.BridgeError, "replaced|truncated|prefix changed"):
                        self.export(cursor=first["page"]["nextCursor"])
                    self.release(first["snapshotId"])

    def test_detects_in_place_capture_race_but_accepts_append_race(self):
        normalize = BRIDGE.normalize_conversation
        for change in ("rewrite", "append"):
            with self.subTest(change=change):
                transcript = self.write_transcript()

                def mutate(*arguments):
                    result = normalize(*arguments)
                    if change == "rewrite":
                        transcript.write_bytes(transcript.read_bytes().replace(b"goal", b"evil"))
                    else:
                        with transcript.open("ab") as handle:
                            handle.write(b'{"type":"user.message","data":{"content":"later"}}\n')
                    return result

                with patch.object(BRIDGE, "normalize_conversation", side_effect=mutate):
                    if change == "rewrite":
                        with self.assertRaisesRegex(BRIDGE.BridgeError, "prefix changed"):
                            self.export()
                    else:
                        self.assertEqual(self.export()["messages"][0]["text"], "goal")

    def test_detects_same_size_rewrite_even_when_original_bytes_are_restored(self):
        transcript = self.write_transcript()
        normalize = BRIDGE.normalize_conversation

        def rewrite(*arguments):
            result = normalize(*arguments)
            source = transcript.read_bytes()
            transcript.write_bytes(source)
            return result

        with patch.object(BRIDGE, "normalize_conversation", side_effect=rewrite):
            with self.assertRaisesRegex(BRIDGE.BridgeError, "prefix changed during capture"):
                self.export()

    def test_rejects_symlinked_transcript_ancestor(self):
        transcript = self.write_transcript()
        directory = transcript.parent
        moved = directory.with_name("moved-session")
        directory.rename(moved)
        directory.symlink_to(moved, target_is_directory=True)
        with self.assertRaisesRegex(BRIDGE.BridgeError, "unsafe links"):
            self.export()

    def test_rejects_transcript_symlink_and_hardlink(self):
        for link_type in ("symlink", "hardlink"):
            with self.subTest(link_type=link_type):
                transcript = self.write_transcript()
                target = transcript.with_suffix(".target")
                if target.exists():
                    target.unlink()
                if link_type == "symlink":
                    transcript.rename(target)
                    transcript.symlink_to(target)
                else:
                    os.link(transcript, target)
                with self.assertRaisesRegex(BRIDGE.BridgeError, "unsafe links|unlinked file"):
                    self.export()
                transcript.unlink()
                target.unlink()

    def test_rejects_copilot_session_content_conflicts(self):
        self.write_transcript(records=[
            {"type": "session.start", "data": {"sessionId": "another-session"}},
            *self.copilot_turns(),
        ])
        with self.assertRaisesRegex(BRIDGE.BridgeError, "mapped Copilot session"):
            self.export()

    def test_rejects_codex_subagent_main_mapping(self):
        self.write_transcript("codex", [
            {"type": "session_meta", "payload": {"id": self.session_id, "source": {"subagent": {"parent": "other"}}}},
            {"type": "event_msg", "payload": {"type": "agent_message", "phase": "final_answer", "message": "child"}},
        ])
        with self.assertRaisesRegex(BRIDGE.BridgeError, "Codex main session"):
            self.export("codex")

    def test_rejects_cursor_cross_invocation_container_and_unknown_nonce(self):
        with patch.dict(BRIDGE.CONVERSATION_POLICY, {"page_bytes": 4096}):
            first = self.paginated_export()
            cursor = first["page"]["nextCursor"]
            BRIDGE.write_sandbox_mapping(
                "copilot", "copilot-profile", "c" * 32,
                {"session_id": self.session_id, "transcript_path": None},
            )
            for arguments in ({"invocation": "c" * 32}, {"container": "d" * 64}):
                with self.subTest(arguments=arguments):
                    with self.assertRaisesRegex(BRIDGE.BridgeError, "another source"):
                        self.export(cursor=cursor, **arguments)
            with self.assertRaisesRegex(BRIDGE.BridgeError, "cursor is unknown"):
                self.export(cursor=cursor[:64] + "0" * 64)
            with self.assertRaisesRegex(BRIDGE.BridgeError, "cursor is missing or invalid"):
                self.export(cursor="../../outside")

    def test_rejects_mapping_changes_during_capture_and_after_export(self):
        transcript = self.write_transcript()
        first = self.export()
        normalize = BRIDGE.normalize_conversation

        def remap(*arguments):
            result = normalize(*arguments)
            BRIDGE.write_sandbox_mapping(
                "copilot", "copilot-profile", self.invocation,
                {"session_id": "other-session", "transcript_path": None},
            )
            return result

        with patch.object(BRIDGE, "normalize_conversation", side_effect=remap):
            with self.assertRaisesRegex(BRIDGE.BridgeError, "conflicting session identities"):
                self.export()
        with self.assertRaisesRegex(BRIDGE.BridgeError, "conflicting session identities"):
            self.describe(first["snapshotId"])
        self.assertTrue(transcript.exists())

    def test_snapshot_tampering_fails_closed(self):
        self.write_transcript()
        first = self.export()
        snapshot = self.snapshot_path(first["snapshotId"])
        snapshot.write_bytes(snapshot.read_bytes().replace(b"answer", b"forged"))
        with self.assertRaisesRegex(BRIDGE.BridgeError, "seal does not match"):
            self.describe(first["snapshotId"])
        with self.assertRaisesRegex(BRIDGE.BridgeError, "seal does not match"):
            self.release(first["snapshotId"])
        self.assertTrue(snapshot.exists())

    def test_unsafe_snapshot_permissions_are_not_repaired(self):
        self.write_transcript()
        first = self.export()
        snapshot = self.snapshot_path(first["snapshotId"])
        snapshot.chmod(0o644)
        with self.assertRaisesRegex(BRIDGE.BridgeError, "unsafe ownership, permissions, or links"):
            self.release(first["snapshotId"])
        self.assertEqual(snapshot.stat().st_mode & 0o777, 0o644)

    def test_snapshot_symlinks_and_hardlinks_are_rejected_without_deletion(self):
        for link_type in ("symlink", "hardlink"):
            with self.subTest(link_type=link_type):
                self.write_transcript()
                first = self.export()
                snapshot = self.snapshot_path(first["snapshotId"])
                target = self.home / f"{link_type}-target"
                if link_type == "symlink":
                    snapshot.rename(target)
                    snapshot.symlink_to(target)
                else:
                    os.link(snapshot, target)
                with self.assertRaisesRegex(BRIDGE.BridgeError, "unsafe"):
                    self.release(first["snapshotId"])
                self.assertTrue(target.exists())
                snapshot.unlink()
                target.unlink()

    def test_unsafe_state_directory_and_mapping_are_not_repaired(self):
        self.write_transcript()
        bridge = self.home / ".trellage" / "herdr-session-bridge"
        bridge.chmod(0o755)
        with self.assertRaisesRegex(BRIDGE.BridgeError, "unsafe"):
            self.export()
        self.assertEqual(bridge.stat().st_mode & 0o777, 0o755)
        bridge.chmod(0o700)
        mapping = bridge / f"{self.invocation}.json"
        mapping.chmod(0o644)
        with self.assertRaisesRegex(BRIDGE.BridgeError, "unsafe"):
            self.export()
        self.assertEqual(mapping.stat().st_mode & 0o777, 0o644)

    def test_snapshot_expiration_cleanup_and_storage_budget(self):
        self.write_transcript()
        with patch.dict(BRIDGE.CONVERSATION_POLICY, {"snapshots": 1}):
            first = self.export()
            with self.assertRaisesRegex(BRIDGE.BridgeError, "storage budget"):
                self.export()
            future = time.time() + 1000
            with patch.object(BRIDGE.time, "time", return_value=future):
                with self.assertRaisesRegex(BRIDGE.BridgeError, "expired"):
                    self.describe(first["snapshotId"])
                second = self.export()
            self.assertFalse(self.snapshot_path(first["snapshotId"]).exists())
            self.assertTrue(self.snapshot_path(second["snapshotId"]).exists())
            self.release(second["snapshotId"])

    def test_releases_expired_snapshot_without_reading_changed_source(self):
        transcript = self.write_transcript()
        first = self.export()
        transcript.unlink()
        with patch.object(BRIDGE.time, "time", return_value=time.time() + 1000):
            self.assertTrue(self.release(first["snapshotId"])["released"])

    def test_capture_budgets_fail_explicitly_instead_of_dropping_history(self):
        self.write_transcript(records=self.copilot_turns(4, "x" * 2000))
        for policy, diagnostic in (
            ({"source_bytes": 4096, "record_bytes": 4096}, "source capture budget"),
            ({"record_bytes": 1024}, "record exceeds"),
            ({"normalized_bytes": 1024}, "normalized capture budget"),
            ({"messages": 2}, "message budget"),
            ({"records": 2}, "record count budget"),
            ({"page_bytes": 1024}, "message exceeds its page budget"),
            ({"page_bytes": 4096, "pages": 1}, "page budget"),
        ):
            with self.subTest(policy=policy), patch.dict(BRIDGE.CONVERSATION_POLICY, policy):
                with self.assertRaisesRegex(BRIDGE.BridgeError, diagnostic):
                    self.export()
        with patch.dict(BRIDGE.CONVERSATION_POLICY, {"source_bytes": True}):
            with self.assertRaisesRegex(BRIDGE.BridgeError, "invalid limits"):
                self.export()

    def test_cli_conversation_operations_use_separate_schema_and_strict_arguments(self):
        self.write_transcript()
        identity = [
            "--agent", "copilot", "--profile", "copilot-profile",
            "--invocation", self.invocation, "--container-id", self.container,
        ]

        def run(command, extra=()):
            return subprocess.run(
                [sys.executable, str(SCRIPT), command, *identity, *extra],
                capture_output=True, text=True, check=False,
            )

        exported = run("export-conversation")
        self.assertEqual(exported.returncode, 0, exported.stderr)
        snapshot_id = json.loads(exported.stdout)["snapshotId"]
        described = run("describe-conversation", ["--snapshot", snapshot_id])
        self.assertEqual(described.returncode, 0, described.stderr)
        self.assertFalse(json.loads(described.stdout)["changed"])
        current = run("describe-conversation")
        self.assertEqual(current.returncode, 0, current.stderr)
        self.assertEqual(json.loads(current.stdout)["revision"], json.loads(described.stdout)["revision"])
        self.assertNotIn("snapshotId", json.loads(current.stdout))
        self.assertEqual(run("release-conversation", ["--snapshot", snapshot_id]).returncode, 0)
        duplicate = run("export-conversation", ["--agent", "copilot"])
        self.assertNotEqual(duplicate.returncode, 0)
        self.assertIn("may be specified only once", duplicate.stderr)
        missing = run("release-conversation")
        self.assertNotEqual(missing.returncode, 0)
        self.assertEqual(missing.stdout, "")


if __name__ == "__main__":
    unittest.main()
