"""Canaries use local listeners only; no test contacts a provider."""

from pathlib import Path
import os
import socket
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
RUNNER = ROOT / "scripts/test-offline.py"


class OfflineContract(unittest.TestCase):
    def run_offline(self, source):
        return subprocess.run(
            [sys.executable, str(RUNNER), "--", sys.executable, "-c", source],
            text=True, capture_output=True, timeout=15,
        )

    def test_command_result_and_explicit_configuration(self):
        result = self.run_offline(
            "import os; assert os.environ['TRELLAGE_TEST_OFFLINE'] == '1'; print('protected')"
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "protected")
        self.assertEqual(self.run_offline("raise SystemExit(23)").returncode, 23)

    def test_host_agent_context_is_not_inherited_by_test_processes(self):
        with patch.dict(os.environ, {
            "HERDR_SOCKET_PATH": "/host-agent/control.sock",
            "HERDR_PANE_ID": "host-pane",
            "HERDR_ENV": "1",
        }):
            result = self.run_offline(
                "import os; "
                "assert not any(key.startswith('HERDR_') for key in os.environ), "
                "'test inherited host agent control context'; "
                "os.environ['HERDR_SOCKET_PATH']='/test-owned/fixture.sock'; "
                "assert os.environ['HERDR_SOCKET_PATH']=='/test-owned/fixture.sock'"
            )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_process_identity_is_available_inside_isolation(self):
        result = self.run_offline(
            "import os,subprocess; "
            "r=subprocess.run(['ps','-o','lstart=','-p',str(os.getpid())],capture_output=True,text=True); "
            "assert r.returncode == 0, r.stderr; assert r.stdout.strip(), 'missing process identity'"
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_isolation_preserves_user_and_ancestor_ownership(self):
        paths = [str(ROOT), *(str(parent) for parent in ROOT.parents)]
        expected = [(path, os.stat(path).st_uid, os.stat(path).st_gid) for path in paths]
        result = self.run_offline(
            "import os; "
            f"assert (os.getuid(),os.getgid()) == {(os.getuid(), os.getgid())!r}; "
            f"expected={expected!r}; "
            "actual=[(p,os.stat(p).st_uid,os.stat(p).st_gid) for p,_,_ in expected]; "
            "assert actual == expected, (actual, expected)"
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_permission_rejection_fixtures_keep_exact_mode_bits(self):
        result = self.run_offline(
            "import os,tempfile; from pathlib import Path; "
            "d=tempfile.TemporaryDirectory(); p=Path(d.name)/'request'; "
            "p.write_text('fixture'); os.chmod(p,0o4600); "
            "assert p.stat().st_mode & 0o7777 == 0o4600"
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_fixture_home_does_not_rerun_host_tool_manager(self):
        result = self.run_offline(
            "import os,subprocess,tempfile; "
            "d=tempfile.mkdtemp(); "
            "r=subprocess.run(['bun','--version'],env={**os.environ,'HOME':d,'XDG_CONFIG_HOME':d},"
            "capture_output=True,text=True); "
            "assert r.returncode == 0, r.stderr; assert r.stdout.strip() == '1.4.2', r.stdout"
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_network_denial_survives_empty_child_environment(self):
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            listener.listen()
            port = listener.getsockname()[1]
            probe = (
                "import socket; s=socket.socket(); s.settimeout(1); "
                f"s.connect(('127.0.0.1', {port}))"
            )
            result = self.run_offline(
                "import subprocess,sys; "
                f"r=subprocess.run([sys.executable,'-c',{probe!r}],env={{}},capture_output=True); "
                "assert r.returncode != 0, 'child reached listener'; "
                "assert b'Permission' in r.stderr or b'Operation not permitted' in r.stderr or "
                "b'Network is unreachable' in r.stderr, r.stderr"
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            listener.settimeout(0.05)
            with self.assertRaises(socket.timeout):
                listener.accept()

    def test_unix_fixture_sockets_remain_available(self):
        with tempfile.TemporaryDirectory(prefix="trx-offline-") as directory:
            address = os.path.join(directory, "fixture.sock")
            result = self.run_offline(
                "import socket; "
                "s=socket.socket(socket.AF_UNIX); "
                f"s.bind({address!r}); s.listen(); "
                "c=socket.socket(socket.AF_UNIX); "
                f"c.connect({address!r}); "
                "a,_=s.accept(); c.sendall(b'fixture'); assert a.recv(7)==b'fixture'"
            )
            self.assertEqual(result.returncode, 0, result.stderr)

    @unittest.skipUnless(sys.platform == "linux", "Linux syscall isolation contract")
    def test_linux_denies_datagram_raw_and_io_uring_network_paths(self):
        result = self.run_offline("""
import ctypes, errno, socket
for family, kind in [(socket.AF_INET, socket.SOCK_DGRAM),
                     (socket.AF_INET6, socket.SOCK_STREAM),
                     (socket.AF_INET6, socket.SOCK_DGRAM),
                     (socket.AF_PACKET, socket.SOCK_RAW),
                     (socket.AF_NETLINK, socket.SOCK_RAW)]:
    try:
        socket.socket(family, kind)
    except OSError as error:
        assert error.errno == errno.EPERM, error
    else:
        raise AssertionError((family, kind, 'network socket permitted'))
library = ctypes.CDLL('libseccomp.so.2')
library.seccomp_syscall_resolve_name.argtypes = [ctypes.c_char_p]
number = library.seccomp_syscall_resolve_name(b'io_uring_setup')
assert number >= 0
libc = ctypes.CDLL(None, use_errno=True)
parameters = ctypes.create_string_buffer(256)
assert libc.syscall(number, 1, ctypes.byref(parameters)) == -1
assert ctypes.get_errno() == errno.EPERM
""")
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_caught_provider_violation_still_fails_command(self):
        result = self.run_offline(
            "import os; from pathlib import Path; "
            "Path(os.environ['TRELLAGE_TEST_VIOLATIONS']).write_text('unexpected Copilot client\\n')"
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("unexpected Copilot client", result.stderr)


if __name__ == "__main__":
    unittest.main()
