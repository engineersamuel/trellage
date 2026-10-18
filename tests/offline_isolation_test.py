from pathlib import Path
import socket
import subprocess
import sys
import unittest


OFFLINE = Path(__file__).resolve().parents[1] / "scripts" / "test-offline.sh"


class OfflineIsolationTest(unittest.TestCase):
    def test_unsafe_mode_fixture_keeps_its_setuid_bit_for_rejection_tests(self):
        probe = (
            "import os,subprocess,tempfile; f=tempfile.NamedTemporaryFile(); "
            "subprocess.run(['/bin/chmod','4600',f.name],check=True); "
            "assert os.stat(f.name).st_mode & 0o7777 == 0o4600"
        )
        result = subprocess.run(
            ["bash", str(OFFLINE), sys.executable, "-c", probe],
            capture_output=True, text=True, timeout=10,
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_process_identity_remains_observable(self):
        probe = (
            "import os,subprocess; "
            "value=subprocess.check_output(['ps','-o','lstart=','-p',str(os.getpid())]); "
            "assert value.strip()"
        )
        result = subprocess.run(
            ["bash", str(OFFLINE), sys.executable, "-c", probe],
            capture_output=True, text=True, timeout=10,
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_child_cannot_connect_to_host_provider_even_without_test_environment(self):
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            listener.listen()
            port = listener.getsockname()[1]
            probe = (
                "import socket,sys; s=socket.socket(); s.settimeout(1); "
                f"sys.exit(0 if s.connect_ex(('127.0.0.1', {port})) else 9)"
            )
            with socket.create_connection(("127.0.0.1", port), timeout=1):
                connection, _ = listener.accept()
                connection.close()
            result = subprocess.run(
                ["bash", str(OFFLINE), "env", "-i", sys.executable, "-c", probe],
                capture_output=True, text=True, timeout=10,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            listener.settimeout(0.05)
            with self.assertRaises(socket.timeout):
                listener.accept()


if __name__ == "__main__":
    unittest.main()
