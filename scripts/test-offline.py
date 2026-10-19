#!/usr/bin/env python3
"""Run tests with inherited network isolation and report caught provider violations."""

from pathlib import Path
import os
import platform
import shutil
import signal
import subprocess
import sys
import tempfile


def isolated_command(command: list[str]) -> list[str]:
    if platform.system() == "Darwin":
        return [
            "/usr/bin/sandbox-exec", "-p",
            "(version 1)(allow default)(allow file-write-setugid)"
            "(deny network*)(allow network* (local unix-socket))",
            *command,
        ]
    if platform.system() == "Linux":
        return [sys.executable, str(Path(__file__).with_name("test-offline-linux.py")), *command]
    raise RuntimeError("offline tests require macOS sandbox-exec or Linux libseccomp")


def main(argv: list[str]) -> int:
    if len(argv) < 2 or argv[0] != "--":
        print("usage: test-offline.py -- COMMAND [ARGS...]", file=sys.stderr)
        return 2
    with tempfile.TemporaryDirectory(prefix="trx-test-offline-") as directory:
        violations = Path(directory) / "violations.log"
        violations.touch()
        env = {
            # Unix fixture sockets remain available. Never hand tests the host
            # agent's control socket or pane; fixtures set their own context
            # inside the isolated command after this boundary.
            **{key: value for key, value in os.environ.items() if not key.startswith("HERDR_")},
            "TRELLAGE_TEST_OFFLINE": "1",
            "TRELLAGE_TEST_VIOLATIONS": str(violations),
        }
        # Fixtures replace HOME; inherited absolute paths would still select the
        # host's config and make parallel tests share mutable Native state.
        for key in ("XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "TRELLAGE_CONFIG"):
            env.pop(key, None)
        # Resolve the pinned executable before fixtures replace HOME. A mise shim
        # would otherwise consult the fixture's empty trust database on every call.
        bun = subprocess.run(
            ["bun", "--no-env-file", "--config=/dev/null", "-p", "process.execPath"],
            check=True, capture_output=True, text=True,
        ).stdout.strip()
        env["PATH"] = f"{Path(bun).parent}{os.pathsep}{env.get('PATH', '')}"
        package_cache = Path(__file__).resolve().parents[1] / ".test-performance/package-cache"
        if package_cache.is_dir():
            env.setdefault("TRELLAGE_TEST_PACKAGE_CACHE", str(package_cache))
        if env.get("TRELLAGE_TEST_PACKAGE_CACHE"):
            env["BUN_INSTALL_CACHE_DIR"] = env["TRELLAGE_TEST_PACKAGE_CACHE"]
        if platform.system() == "Darwin":
            # Seatbelt refuses setuid executables even with allow-default.
            # The real ps needs no elevated privileges to inspect our test children.
            binary_directory = Path(directory) / "bin"
            binary_directory.mkdir()
            process_listing = binary_directory / "ps"
            shutil.copyfile("/bin/ps", process_listing)
            process_listing.chmod(0o755)
            # A copied Apple platform binary must be ad-hoc signed at its new path.
            subprocess.run(
                ["/usr/bin/codesign", "--force", "--sign", "-", str(process_listing)],
                check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
            )
            env["PATH"] = f"{binary_directory}{os.pathsep}{env.get('PATH', '')}"
            env["TRELLAGE_TEST_BIN"] = str(binary_directory)
        try:
            command = isolated_command(argv[1:])
            child = subprocess.Popen(command, env=env, start_new_session=True, close_fds=False)
        except (OSError, RuntimeError) as error:
            print(f"offline test isolation unavailable: {error}", file=sys.stderr)
            return 1

        def forward(signum: int, _frame: object) -> None:
            try:
                os.killpg(child.pid, signum)
            except ProcessLookupError:
                pass

        previous = {sig: signal.signal(sig, forward) for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP)}
        try:
            status = child.wait()
        finally:
            for sig, handler in previous.items():
                signal.signal(sig, handler)
        detail = violations.read_text()
        if detail:
            print(f"Unmocked test provider access:\n{detail}", file=sys.stderr)
            return 1
        return 128 - status if status < 0 else status


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
