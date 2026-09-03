#!/usr/bin/env python3

from __future__ import annotations

import json
import os
import re
import runpy
import signal
import subprocess
import sys
import tempfile
import textwrap
import time
import unittest
from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parent.parent
RUNNER = REPOSITORY_ROOT / "scripts" / "verify-native-tuis"
PRODUCTION_CONFIG = REPOSITORY_ROOT / "scripts" / "native-tui-adapters.json"


class NativeTuiMatrixTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="native-tui-matrix-")
        self.root = Path(self.temporary.name)
        self.state = self.root / "state"
        self.state.mkdir()
        self.fake_tui = self.root / "fake-tui.py"
        self.fake_trx = self.root / "trx"
        self.config = self.root / "adapters.json"
        self.write_fake_tui()
        self.write_fake_trx()
        self.write_config()

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def write_fake_tui(self) -> None:
        self.fake_tui.write_text(
            textwrap.dedent(
                """\
                #!/usr/bin/env python3
                import os
                import re
                import select
                import signal
                import subprocess
                import sys
                import termios
                import time
                from pathlib import Path

                launcher, profile = sys.argv[1:3]
                log = Path(os.environ["FAKE_TUI_STATE"]) / "input.log"
                ready = "\\x1b[1mREA\\x1b[0mDY>"
                prompt_number = 1

                if profile in ("delayed-blocked", "submit-blocked", "triple-exit"):
                    attributes = termios.tcgetattr(sys.stdin.fileno())
                    attributes[3] &= ~(termios.ICANON | termios.ECHO | termios.ISIG)
                    termios.tcsetattr(sys.stdin.fileno(), termios.TCSANOW, attributes)

                def show_ready():
                    if launcher == "fz":
                        print(f"{prompt_number}> ", flush=True)
                    else:
                        print(ready, flush=True)

                if profile == "blocked":
                    print(f"{ready}\\nCONSENT REQUIRED", flush=True)
                elif profile == "delayed-blocked":
                    print(ready, flush=True)
                    time.sleep(0.05)
                    print("CONSENT REQUIRED", flush=True)
                elif profile == "submit-blocked":
                    print(ready, flush=True)
                    time.sleep(0.15)
                    print("CONSENT REQUIRED", flush=True)
                elif profile == "cursor-split":
                    print("REA\\x1b[20;1HDY>", flush=True)
                elif profile == "signal-descendant":
                    print("BOOTING", flush=True)
                elif profile == "quiet-env" and os.environ.get("PONYTAIL_QUIET_STARTUP") != "0":
                    print("QUIET STARTUP", flush=True)
                else:
                    show_ready()
                if profile == "ready-exit":
                    raise SystemExit(0)
                if profile in ("descendant", "signal-descendant"):
                    child = subprocess.Popen([
                        sys.executable,
                        "-c",
                        (
                            "import signal,time;"
                            "signal.signal(signal.SIGTERM,signal.SIG_IGN);"
                            "signal.signal(signal.SIGHUP,signal.SIG_IGN);"
                            "time.sleep(60)"
                        ),
                    ])
                    (log.parent / "descendant.pid").write_text(str(child.pid))
                if profile in ("delayed-blocked", "submit-blocked"):
                    data = os.read(sys.stdin.fileno(), 4096)
                    with log.open("a") as output:
                        output.write(f"BYTES:{data.hex()}\\n")
                    while True:
                        time.sleep(1)
                if profile == "triple-exit":
                    control_c_count = 0
                    while control_c_count < 3:
                        if os.read(sys.stdin.fileno(), 1) == b"\\x03":
                            control_c_count += 1
                            with log.open("a") as output:
                                output.write("CTRL_C\\n")
                    raise SystemExit(0)
                previous = ""
                for line in sys.stdin:
                    if not line.endswith(("\\r", "\\n")):
                        continue
                    value = line.rstrip("\\r\\n")
                    with log.open("a") as output:
                        output.write(f"{launcher}\\t{profile}\\t{value}\\n")
                    if value == "/exit":
                        if profile == "exit-blocked":
                            print("CONSENT REQUIRED", flush=True)
                        raise SystemExit(0)
                    numbers = [int(item) for item in re.findall(r"\\b\\d{2,3}\\b", value)]
                    decoded = "".join(chr(item) for item in numbers)
                    if value.startswith("Decode"):
                        previous = decoded
                        print(previous, flush=True)
                    elif value.startswith("Append"):
                        previous += decoded
                        print(previous, flush=True)
                    elif value.startswith("/justify "):
                        if profile != "no-skill":
                            print("Verdict: Justified", flush=True)
                        print(decoded, flush=True)
                    else:
                        print(decoded, flush=True)
                    prompt_number += 1
                    if profile == "active-redraw":
                        print(ready, flush=True)
                        for active_tick in range(8):
                            readable, _, _ = select.select([sys.stdin], [], [], 0.05)
                            if readable:
                                (log.parent / "early-input").write_text("received")
                            print(f"ACTIVE {active_tick}", flush=True)
                    elif profile != "startup-only":
                        show_ready()
                """
            )
        )
        self.fake_tui.chmod(0o755)

    def write_fake_trx(self) -> None:
        self.fake_trx.write_text(
            textwrap.dedent(
                f"""\
                #!{sys.executable}
                import json
                import os
                import sys
                from pathlib import Path

                state = Path(os.environ["FAKE_TUI_STATE"])
                catalog = json.loads(os.environ["FAKE_TUI_CATALOG"])
                readiness = json.loads(os.environ.get("FAKE_TUI_READINESS", "{{}}"))
                arguments = sys.argv[1:]
                if arguments == ["list", "--json"]:
                    print(json.dumps({{"schemaVersion": 1, "profiles": catalog}}))
                    raise SystemExit(0)
                if len(arguments) == 4 and arguments[0] == "inventory" and arguments[3] == "--json":
                    launcher, profile = arguments[1:3]
                    with (state / "events.log").open("a") as output:
                        output.write(f"inventory\\t{{launcher}}\\t{{profile}}\\n")
                    value = readiness.get(f"{{launcher}}/{{profile}}", "healthy")
                    print(json.dumps({{
                        "schemaVersion": 1,
                        "launcher": launcher,
                        "profile": profile,
                        "readiness": value,
                    }}))
                    raise SystemExit(0)
                if len(arguments) >= 3 and arguments[0] == "run":
                    launcher, profile = arguments[1:3]
                    with (state / "events.log").open("a") as output:
                        output.write(f"launch\\t{{launcher}}\\t{{profile}}\\n")
                    os.execv(
                        sys.executable,
                        [sys.executable, {str(self.fake_tui)!r}, launcher, profile],
                    )
                raise SystemExit(2)
                """
            )
        )
        self.fake_trx.chmod(0o755)

    def write_config(self) -> None:
        value = {
            "schemaVersion": 1,
            "defaults": {
                "readyTimeoutSeconds": 3,
                "readySettleMilliseconds": 100,
                "turnTimeoutSeconds": 3,
                "exitTimeoutSeconds": 3,
                "submitDelayMilliseconds": 100,
                "maxOutputBytes": 1048576,
            },
            "live": {
                "turnOnePrompt": "Decode these decimal ASCII values: {encodedMarker}",
                "turnTwoPrompt": "Append these decimal ASCII values: {encodedSuffix}",
                "skillPrompt": (
                    "{skillPrefix}Use justify, include its canonical verdict label, "
                    "and decode: {encodedMarker}"
                ),
                "skillRequiredPatterns": ["Verdict:"],
            },
            "adapters": {
                "fixture": {
                    "readyPatterns": ["READY>"],
                    "blockedPatterns": ["CONSENT REQUIRED"],
                    "launchArgs": ["--session-id", "{sessionId}"],
                    "exitSteps": [
                        {"data": "/exit", "delayMilliseconds": 20},
                        {"data": "\r", "delayMilliseconds": 0},
                    ],
                    "allowedExitCodes": [0],
                    "skillPrefix": "/justify ",
                },
                "quiet-fixture": {
                    "readyPatterns": ["READY>"],
                    "readyQuietMilliseconds": 50,
                    "turnReadyPatterns": [],
                    "turnReadyQuietMilliseconds": 50,
                    "environment": {"PONYTAIL_QUIET_STARTUP": "0"},
                    "blockedPatterns": ["CONSENT REQUIRED"],
                    "launchArgs": [],
                    "exitSteps": [
                        {"data": "/exit", "delayMilliseconds": 20},
                        {"data": "\r", "delayMilliseconds": 0},
                    ],
                    "allowedExitCodes": [0],
                    "skillPrefix": "/justify ",
                },
                "numbered-fixture": {
                    "readyPatterns": ["1> "],
                    "numberedReadyPattern": "{turn}> ",
                    "blockedPatterns": [],
                    "launchArgs": [],
                    "exitSteps": [
                        {"data": "/exit", "delayMilliseconds": 20},
                        {"data": "\r", "delayMilliseconds": 0},
                    ],
                    "allowedExitCodes": [0],
                    "skillPrefix": "/justify ",
                },
                "triple-exit-fixture": {
                    "readyPatterns": ["READY>"],
                    "blockedPatterns": [],
                    "launchArgs": [],
                    "exitSteps": [
                        {"data": "\u0003", "delayMilliseconds": 20},
                        {"data": "\u0003", "delayMilliseconds": 20},
                        {"data": "\u0003", "delayMilliseconds": 0},
                    ],
                    "allowedExitCodes": [0],
                    "skillPrefix": "",
                },
                "active-turn-fixture": {
                    "readyPatterns": ["READY>"],
                    "turnReadyPatterns": [],
                    "turnReadyQuietMilliseconds": 150,
                    "blockedPatterns": [],
                    "launchArgs": [],
                    "exitSteps": [
                        {"data": "/exit", "delayMilliseconds": 20},
                        {"data": "\r", "delayMilliseconds": 0},
                    ],
                    "allowedExitCodes": [0],
                    "skillPrefix": "/justify ",
                }
            },
            "launchers": {
                "fx": "fixture",
                "fy": "quiet-fixture",
                "fz": "numbered-fixture",
                "fv": "triple-exit-fixture",
                "fu": "active-turn-fixture",
            },
        }
        self.config.write_text(f"{json.dumps(value, indent=2)}\n")

    def run_matrix(
        self,
        profiles: list[dict[str, str]],
        *arguments: str,
        readiness: dict[str, str] | None = None,
        evidence: Path | None = None,
    ) -> subprocess.CompletedProcess[str]:
        evidence = evidence or self.root / f"evidence-{len(list(self.root.glob('evidence-*')))}"
        environment = os.environ.copy()
        environment.update(
            {
                "FAKE_TUI_STATE": str(self.state),
                "FAKE_TUI_CATALOG": json.dumps(profiles),
                "FAKE_TUI_READINESS": json.dumps(readiness or {}),
                "PONYTAIL_QUIET_STARTUP": "1",
            }
        )
        return subprocess.run(
            [
                str(RUNNER),
                "--trx",
                str(self.fake_trx),
                "--config",
                str(self.config),
                "--evidence-dir",
                str(evidence),
                "--json",
                *arguments,
            ],
            capture_output=True,
            text=True,
            timeout=20,
            check=False,
            env=environment,
        )

    @staticmethod
    def profile(name: str, launcher: str = "fx") -> dict[str, str]:
        return {"launcher": launcher, "harness": "fixture", "name": name}

    def test_lifecycle_discovers_future_profiles(self) -> None:
        result = self.run_matrix([self.profile("current"), self.profile("future")])
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        self.assertEqual(payload["outcome"], "pass")
        self.assertEqual([profile["profile"] for profile in payload["profiles"]], ["current", "future"])
        self.assertTrue(all(profile["stages"]["postflight"] == "pass" for profile in payload["profiles"]))
        self.assertEqual(Path(payload["evidenceDirectory"]).stat().st_mode & 0o777, 0o700)
        self.assertEqual((Path(payload["evidenceDirectory"]) / "result.json").stat().st_mode & 0o777, 0o600)
        events = (self.state / "events.log").read_text().splitlines()
        self.assertEqual([line for line in events if line.startswith("launch\t")], [
            "launch\tfx\tcurrent",
            "launch\tfx\tfuture",
        ])

    def test_lifecycle_supports_frame_then_quiet_readiness(self) -> None:
        result = self.run_matrix([self.profile("current", launcher="fy")])
        self.assertEqual(result.returncode, 0, result.stderr)
        profile = json.loads(result.stdout)["profiles"][0]
        self.assertEqual(profile["stages"]["ready"], "pass")
        self.assertEqual(profile["stages"]["exit"], "pass")

    def test_lifecycle_can_send_three_control_c_exit_keys(self) -> None:
        result = self.run_matrix([self.profile("triple-exit", launcher="fv")])
        self.assertEqual(result.returncode, 0, result.stderr)
        profile = json.loads(result.stdout)["profiles"][0]
        self.assertEqual(profile["stages"]["exit"], "pass")
        self.assertEqual(
            (self.state / "input.log").read_text().splitlines(),
            ["CTRL_C", "CTRL_C", "CTRL_C"],
        )

    def test_pty_constructor_reaps_child_when_initialization_is_interrupted(self) -> None:
        namespace = runpy.run_path(str(RUNNER), run_name="native_tui_runner")
        pty_module = namespace["pty"]
        fcntl_module = namespace["fcntl"]
        real_fork = pty_module.fork
        real_ioctl = fcntl_module.ioctl
        spawned: list[int] = []

        def recording_fork() -> tuple[int, int]:
            pid, terminal = real_fork()
            if pid:
                spawned.append(pid)
            return pid, terminal

        def interrupted_ioctl(*_arguments: object) -> None:
            raise namespace["MatrixTermination"](signal.SIGTERM)

        pty_module.fork = recording_fork
        fcntl_module.ioctl = interrupted_ioctl
        try:
            with self.assertRaises(namespace["MatrixTermination"]):
                namespace["PtyProcess"](
                    [sys.executable, "-c", "import time; time.sleep(60)"],
                    self.root / "interrupted.raw",
                    1024,
                    {},
                )
        finally:
            pty_module.fork = real_fork
            fcntl_module.ioctl = real_ioctl

        self.assertEqual(len(spawned), 1)
        with self.assertRaises(ProcessLookupError):
            os.kill(spawned[0], 0)

    def test_pty_cleanup_reaps_child_before_delivering_pending_sigint(self) -> None:
        namespace = runpy.run_path(str(RUNNER), run_name="native_tui_runner")
        process = namespace["PtyProcess"](
            [
                sys.executable,
                "-c",
                (
                    "import signal,time;"
                    "signal.signal(signal.SIGTERM,signal.SIG_IGN);"
                    "print('READY',flush=True);"
                    "time.sleep(60)"
                ),
            ],
            self.root / "cleanup-interrupted.raw",
            1024,
            {},
        )
        process.wait_for_event((b"READY",), (), 0, 3)
        pid = process.pid
        real_wait_for_reap = process.wait_for_reap
        interrupted = False

        def interrupting_wait(timeout: float) -> int | None:
            nonlocal interrupted
            if not interrupted:
                interrupted = True
                os.kill(os.getpid(), signal.SIGINT)
            return real_wait_for_reap(timeout)

        process.wait_for_reap = interrupting_wait
        with self.assertRaises(KeyboardInterrupt):
            process.close()
        with self.assertRaises(ProcessLookupError):
            os.kill(pid, 0)

    def test_adapter_environment_overrides_inherited_quiet_mode(self) -> None:
        result = self.run_matrix([self.profile("quiet-env", launcher="fy")])
        self.assertEqual(result.returncode, 0, result.stderr)
        profile = json.loads(result.stdout)["profiles"][0]
        self.assertEqual(profile["stages"]["ready"], "pass")

    def test_live_mode_supports_startup_only_readiness_marker(self) -> None:
        result = self.run_matrix(
            [self.profile("startup-only", launcher="fy")],
            "--live",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        profile = json.loads(result.stdout)["profiles"][0]
        self.assertEqual(profile["stages"]["turnOne"], "pass")
        self.assertEqual(profile["stages"]["turnTwo"], "pass")
        self.assertEqual(profile["stages"]["skill"], "pass")

    def test_live_mode_waits_for_active_turn_output_to_stop(self) -> None:
        result = self.run_matrix(
            [self.profile("active-redraw", launcher="fu")],
            "--live",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse((self.state / "early-input").exists())

    def test_live_mode_tracks_numbered_readiness_markers(self) -> None:
        result = self.run_matrix(
            [self.profile("numbered", launcher="fz")],
            "--live",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        profile = json.loads(result.stdout)["profiles"][0]
        self.assertEqual(profile["stages"]["turnOne"], "pass")
        self.assertEqual(profile["stages"]["turnTwo"], "pass")
        self.assertEqual(profile["stages"]["skill"], "pass")

    def test_live_mode_proves_two_turns_and_skill(self) -> None:
        result = self.run_matrix([self.profile("current")], "--live")
        self.assertEqual(result.returncode, 0, result.stderr)
        profile = json.loads(result.stdout)["profiles"][0]
        self.assertEqual(profile["outcome"], "pass")
        self.assertEqual(profile["stages"]["turnOne"], "pass")
        self.assertEqual(profile["stages"]["turnTwo"], "pass")
        self.assertEqual(profile["stages"]["skill"], "pass")
        inputs = (self.state / "input.log").read_text()
        self.assertIn("/justify ", inputs)
        self.assertIn("\t/exit\n", inputs)

    def test_live_mode_fails_without_justify_verdict(self) -> None:
        result = self.run_matrix([self.profile("no-skill")], "--live")
        self.assertEqual(result.returncode, 1)
        profile = json.loads(result.stdout)["profiles"][0]
        self.assertEqual(profile["stages"]["skill"], "fail")
        self.assertIn("response omitted or misordered required pattern", profile["errors"][0])

    def test_missing_launcher_adapter_fails_closed(self) -> None:
        result = self.run_matrix(
            [self.profile("current"), self.profile("future", launcher="newx")],
            "--launcher",
            "fx",
        )
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, "")
        self.assertIn("no PTY adapter for discovered launcher: newx", result.stderr)
        self.assertFalse((self.state / "events.log").exists())

    def test_unknown_extra_filter_fails_closed(self) -> None:
        result = self.run_matrix(
            [self.profile("current")],
            "--launcher",
            "fx",
            "--launcher",
            "missing",
        )
        self.assertEqual(result.returncode, 1)
        self.assertIn("launcher filter was not discovered: missing", result.stderr)
        self.assertFalse((self.state / "events.log").exists())

    def test_incompatible_combined_filter_fails_closed(self) -> None:
        result = self.run_matrix(
            [self.profile("default"), self.profile("pstack", launcher="fy")],
            "--launcher",
            "fx",
            "--profile",
            "default",
            "--profile",
            "pstack",
        )
        self.assertEqual(result.returncode, 1)
        self.assertIn("profile filter matched no selected launcher: pstack", result.stderr)
        self.assertFalse((self.state / "events.log").exists())

    def test_unhealthy_profile_is_not_launched(self) -> None:
        result = self.run_matrix(
            [self.profile("broken")],
            readiness={"fx/broken": "unhealthy"},
        )
        self.assertEqual(result.returncode, 1)
        profile = json.loads(result.stdout)["profiles"][0]
        self.assertEqual(profile["stages"]["preflight"], "fail")
        events = (self.state / "events.log").read_text()
        self.assertNotIn("launch\t", events)

    def test_blocking_screen_fails_and_keeps_evidence(self) -> None:
        result = self.run_matrix([self.profile("blocked")])
        self.assertEqual(result.returncode, 1)
        profile = json.loads(result.stdout)["profiles"][0]
        self.assertIn("TUI blocked by: CONSENT REQUIRED", profile["errors"])
        self.assertTrue(Path(profile["rawOutput"]).is_file())

    def test_delayed_blocking_screen_fails_after_readiness(self) -> None:
        result = self.run_matrix([self.profile("delayed-blocked")])
        self.assertEqual(result.returncode, 1)
        profile = json.loads(result.stdout)["profiles"][0]
        self.assertEqual(profile["stages"]["ready"], "pass")
        self.assertEqual(profile["stages"]["exit"], "fail")
        self.assertIn("TUI blocked by: CONSENT REQUIRED", profile["errors"])
        self.assertFalse((self.state / "input.log").exists())

    def test_live_submit_does_not_answer_delayed_blocker(self) -> None:
        result = self.run_matrix([self.profile("submit-blocked")], "--live")
        self.assertEqual(result.returncode, 1)
        profile = json.loads(result.stdout)["profiles"][0]
        self.assertEqual(profile["stages"]["turnOne"], "fail")
        self.assertIn("TUI blocked by: CONSENT REQUIRED", profile["errors"])
        self.assertFalse((self.state / "input.log").exists())

    def test_blocking_screen_during_exit_still_fails(self) -> None:
        result = self.run_matrix([self.profile("exit-blocked")])
        self.assertEqual(result.returncode, 1)
        profile = json.loads(result.stdout)["profiles"][0]
        self.assertEqual(profile["stages"]["ready"], "pass")
        self.assertEqual(profile["stages"]["exit"], "fail")
        self.assertIn("TUI blocked by: CONSENT REQUIRED", profile["errors"])

    def test_cursor_movement_does_not_join_marker_text(self) -> None:
        result = self.run_matrix([self.profile("cursor-split")])
        self.assertEqual(result.returncode, 1)
        profile = json.loads(result.stdout)["profiles"][0]
        self.assertEqual(profile["stages"]["ready"], "fail")
        self.assertIn("timed out waiting for TUI marker", profile["errors"][0])

    def test_ready_then_immediate_exit_fails_lifecycle(self) -> None:
        result = self.run_matrix([self.profile("ready-exit")])
        self.assertEqual(result.returncode, 1)
        profile = json.loads(result.stdout)["profiles"][0]
        self.assertEqual(profile["stages"]["ready"], "pass")
        self.assertEqual(profile["stages"]["exit"], "fail")
        self.assertIn("TUI exited before exit keys were sent", profile["errors"][0])

    def test_symlink_evidence_directory_is_rejected(self) -> None:
        target = self.root / "evidence-target"
        target.mkdir()
        evidence = self.root / "evidence-link"
        evidence.symlink_to(target, target_is_directory=True)
        result = self.run_matrix([self.profile("current")], evidence=evidence)
        self.assertEqual(result.returncode, 1)
        self.assertIn("evidence directory must not be a symlink", result.stderr)
        self.assertFalse((target / "result.json").exists())

    def test_evidence_directory_cannot_be_reused(self) -> None:
        evidence = self.root / "reused-evidence"
        first = self.run_matrix([self.profile("current")], evidence=evidence)
        self.assertEqual(first.returncode, 0, first.stderr)
        original = (evidence / "result.json").read_bytes()
        second = self.run_matrix([self.profile("current")], evidence=evidence)
        self.assertEqual(second.returncode, 1)
        self.assertIn("evidence directory must be empty", second.stderr)
        self.assertEqual((evidence / "result.json").read_bytes(), original)

    def test_rejected_evidence_directory_keeps_permissions(self) -> None:
        evidence = self.root / "shared-evidence"
        evidence.mkdir(mode=0o775)
        evidence.chmod(0o775)
        (evidence / "existing.txt").write_text("keep")
        result = self.run_matrix([self.profile("current")], evidence=evidence)
        self.assertEqual(result.returncode, 1)
        self.assertIn("evidence directory must be empty", result.stderr)
        self.assertEqual(evidence.stat().st_mode & 0o777, 0o775)

    def test_cleanup_kills_same_group_descendants(self) -> None:
        result = self.run_matrix([self.profile("descendant")])
        self.assertEqual(result.returncode, 0, result.stderr)
        pid = int((self.state / "descendant.pid").read_text())
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            check = subprocess.run(
                ["ps", "-p", str(pid), "-o", "stat="],
                capture_output=True,
                text=True,
                check=False,
            )
            if not check.stdout.strip():
                break
            time.sleep(0.05)
        else:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            self.fail(f"PTY descendant remained alive: {pid}")

    def test_sigterm_cleans_active_pty_process_group(self) -> None:
        evidence = self.root / "signal-evidence"
        environment = os.environ.copy()
        environment.update(
            {
                "FAKE_TUI_STATE": str(self.state),
                "FAKE_TUI_CATALOG": json.dumps([self.profile("signal-descendant")]),
                "FAKE_TUI_READINESS": "{}",
            }
        )
        process = subprocess.Popen(
            [
                str(RUNNER),
                "--trx",
                str(self.fake_trx),
                "--config",
                str(self.config),
                "--evidence-dir",
                str(evidence),
                "--json",
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=environment,
        )
        pid_path = self.state / "descendant.pid"
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and not pid_path.exists():
            if process.poll() is not None:
                break
            time.sleep(0.05)
        self.assertTrue(pid_path.exists(), "fixture descendant did not start")
        descendant_pid = int(pid_path.read_text())
        try:
            process.terminate()
            _, stderr = process.communicate(timeout=10)
            self.assertEqual(process.returncode, 143, stderr)
            self.assertIn("terminated by signal 15", stderr)
            deadline = time.monotonic() + 2
            while time.monotonic() < deadline:
                check = subprocess.run(
                    ["ps", "-p", str(descendant_pid), "-o", "stat="],
                    capture_output=True,
                    text=True,
                    check=False,
                )
                if not check.stdout.strip():
                    break
                time.sleep(0.05)
            else:
                self.fail(f"PTY descendant remained alive after SIGTERM: {descendant_pid}")
        finally:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=5)
            try:
                os.kill(descendant_pid, signal.SIGKILL)
            except ProcessLookupError:
                pass

    def test_invalid_templates_fail_before_discovery(self) -> None:
        for location, value in (
            (("adapters", "fixture", "launchArgs"), ["{unknown}"]),
            (("live", "turnOnePrompt"), "{unknown}"),
        ):
            with self.subTest(location=location):
                config = json.loads(self.config.read_text())
                target = config
                for key in location[:-1]:
                    target = target[key]
                target[location[-1]] = value
                self.config.write_text(f"{json.dumps(config, indent=2)}\n")
                result = self.run_matrix([self.profile("current")])
                self.assertEqual(result.returncode, 1)
                self.assertIn("placeholder", result.stderr)
                self.assertFalse((self.state / "events.log").exists())
                self.write_config()

    def test_production_config_covers_every_router_launcher(self) -> None:
        config = json.loads(PRODUCTION_CONFIG.read_text())
        router = (REPOSITORY_ROOT / "prototypes" / "trellage-router" / "bin" / "trx").read_text()
        discovered = set(re.findall(r"discover_launcher ([a-z0-9]+) ", router))
        self.assertEqual(set(config["launchers"]), discovered)
        self.assertTrue(all(adapter in config["adapters"] for adapter in config["launchers"].values()))
        for adapter_name in ("agency-copilot", "copilot"):
            self.assertNotIn("--mode", config["adapters"][adapter_name]["launchArgs"])
        self.assertEqual(len(config["adapters"]["grok"]["exitSteps"]), 2)
        self.assertTrue(
            all(step["data"] == "\u0004" for step in config["adapters"]["grok"]["exitSteps"])
        )
        self.assertEqual(config["adapters"]["grok"]["readyPatterns"], ["\u276f"])
        self.assertEqual(config["adapters"]["grok"]["readySettleMilliseconds"], 5000)
        self.assertEqual(config["adapters"]["jcode"]["numberedReadyPattern"], "{turn}> ")
        self.assertEqual(len(config["adapters"]["jcode"]["exitSteps"]), 3)
        self.assertIn(
            "Update available!",
            config["adapters"]["codex"]["blockedPatterns"],
        )
        self.assertEqual(config["adapters"]["codex"]["turnReadyPatterns"], [])
        self.assertEqual(config["adapters"]["codex"]["turnReadyQuietMilliseconds"], 2000)
        self.assertEqual(config["adapters"]["pi"]["readyPatterns"], ["Ponytail loaded:"])
        self.assertEqual(config["adapters"]["pi"]["readyQuietMilliseconds"], 750)
        self.assertEqual(config["adapters"]["pi"]["turnReadyPatterns"], [])
        self.assertEqual(config["adapters"]["pi"]["turnReadyQuietMilliseconds"], 750)
        self.assertEqual(
            config["adapters"]["pi"]["environment"],
            {"PONYTAIL_QUIET_STARTUP": "0"},
        )
        self.assertEqual(config["live"]["skillRequiredPatterns"], ["Verdict:"])

    def test_makefile_and_readme_publish_matrix_commands(self) -> None:
        makefile = (REPOSITORY_ROOT / "Makefile").read_text()
        readme = (REPOSITORY_ROOT / "README.md").read_text()
        self.assertIn("native-tui-matrix native-tui-matrix-live native-tui-matrix-test", makefile)
        self.assertIn("scripts/verify-native-tuis $(NATIVE_TUI_MATRIX_ARGS)", makefile)
        self.assertIn("scripts/verify-native-tuis --live $(NATIVE_TUI_MATRIX_ARGS)", makefile)
        self.assertIn("python3 tests/native_tui_matrix_test.py", makefile)
        for command in (
            "scripts/verify-native-tuis",
            "make native-tui-matrix",
            "scripts/verify-native-tuis --launcher cldx --profile default",
            "scripts/verify-native-tuis --live --launcher cldx --profile default",
            "make native-tui-matrix-test",
        ):
            self.assertIn(command, readme)


if __name__ == "__main__":
    unittest.main()
