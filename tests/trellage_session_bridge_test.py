import importlib.util
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
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


if __name__ == "__main__":
    unittest.main()
