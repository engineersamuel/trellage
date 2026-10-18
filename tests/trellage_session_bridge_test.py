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
