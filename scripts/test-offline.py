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
            "/usr/bin/sandbox-exec",
            "-p",
            "(version 1)(allow default)(allow file-write-setugid)(deny network*)(allow network* (local unix-socket))",
            *command,
        ]
    if platform.system() == "Linux":
        return [sys.executable, str(Path(__file__).with_name("test-offline-linux.py")), *command]
    raise RuntimeError("offline tests require macOS sandbox-exec or Linux libseccomp")


def prepare_process_listing(directory: Path, env: dict[str, str]) -> None:
    directory.mkdir()
    process_listing = directory / "ps"
    architectures = (None, "x86_64") if platform.machine() == "arm64" else (None,)
    for architecture in architectures:
        if architecture is None:
            shutil.copyfile("/bin/ps", process_listing)
        else:
            # Some macOS releases cannot execute re-signed arm64e tools.
            # Rosetta runs the same system ps without removing offline isolation.
            print("offline tests: native ps is unavailable; trying its x86_64 slice with Rosetta.", file=sys.stderr)
            subprocess.run(
                ["/usr/bin/lipo", "/bin/ps", "-thin", architecture, "-output", str(process_listing)],
                check=True,
                capture_output=True,
                text=True,
            )
        process_listing.chmod(0o755)
        subprocess.run(
            ["/usr/bin/codesign", "--force", "--sign", "-", str(process_listing)],
            check=True,
            capture_output=True,
            text=True,
        )
        probe = subprocess.run(
            isolated_command([str(process_listing), "-p", str(os.getpid()), "-o", "pid=,ppid=,pgid=,lstart=,tty="]),
            env=env,
            capture_output=True,
            text=True,
            timeout=10,
        )
        if probe.returncode == 0 and probe.stdout.strip().split(maxsplit=1)[0:1] == [str(os.getpid())]:
            env["PATH"] = f"{directory}{os.pathsep}{env.get('PATH', '')}"
            env["TRELLAGE_TEST_BIN"] = str(directory)
            return
        print(f"offline tests: ps probe failed (status {probe.returncode}): {probe.stderr.strip()}", file=sys.stderr)
    raise RuntimeError("cannot inspect test processes inside Seatbelt; Apple Silicon may require Rosetta 2")


GIT_LOCATION = (
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_COMMON_DIR",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_PREFIX",
    "GIT_NAMESPACE",
    "GIT_CONFIG",
    "GIT_CONFIG_PARAMETERS",
    "GIT_CONFIG_COUNT",
)


def isolated_environment(violations: Path) -> dict[str, str]:
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
    # Git hooks (pre-push runs these tests) export GIT_DIR and friends. Inherited, they send every fixture's
    # `git init` or `git config` to the enclosing repository: one such run made the main checkout bare.
    for key in GIT_LOCATION:
        env.pop(key, None)
    # Resolve the pinned executable before fixtures replace HOME. A mise shim
    # would otherwise consult the fixture's empty trust database on every call.
    bun = subprocess.run(
        ["bun", "--no-env-file", "--config=/dev/null", "-p", "process.execPath"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    env["PATH"] = f"{Path(bun).parent}{os.pathsep}{env.get('PATH', '')}"
    package_cache = Path(__file__).resolve().parents[1] / ".test-performance/package-cache"
    if package_cache.is_dir():
        env.setdefault("TRELLAGE_TEST_PACKAGE_CACHE", str(package_cache))
    if env.get("TRELLAGE_TEST_PACKAGE_CACHE"):
        env["BUN_INSTALL_CACHE_DIR"] = env["TRELLAGE_TEST_PACKAGE_CACHE"]
    return env


def main(argv: list[str]) -> int:
    if len(argv) < 2 or argv[0] != "--":
        print("usage: test-offline.py -- COMMAND [ARGS...]", file=sys.stderr)
        return 2
    with tempfile.TemporaryDirectory(prefix="trx-test-offline-") as directory:
        violations = Path(directory) / "violations.log"
        violations.touch()
        env = isolated_environment(violations)
        try:
            if platform.system() == "Darwin":
                # Seatbelt refuses setuid executables, but ps needs no elevated
                # privileges to inspect our test children.
                prepare_process_listing(Path(directory) / "bin", env)
            command = isolated_command(argv[1:])
            child = subprocess.Popen(command, env=env, start_new_session=True, close_fds=False)
        except (OSError, RuntimeError, subprocess.SubprocessError) as error:
            print(f"offline test isolation unavailable: {error}", file=sys.stderr)
            if isinstance(error, subprocess.CalledProcessError) and error.stderr:
                print(error.stderr, file=sys.stderr)
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
