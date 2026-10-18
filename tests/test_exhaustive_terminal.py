import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("terminal_driver", Path(__file__).parents[1] / "scripts/exhaustive-terminal.py")
driver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(driver)


class TerminalContract(unittest.TestCase):
    def execute(self, source, steps):
        with tempfile.TemporaryDirectory() as directory:
            return driver.execute({
                'command': [sys.executable, '-I', '-c', source],
                'cwd': directory,
                'env': {'TRELLAGE_TEST_OFFLINE': '1'},
                'steps': steps,
            })

    def test_waits_for_raw_mode_after_a_rendered_prompt(self):
        result = self.execute(
            "import os,time,tty; os.write(1,b'Ready'); time.sleep(0.1); tty.setraw(0); "
            "assert os.read(0,1)==b'v'; os.write(1,b'Read view'); assert os.read(0,1)==b'q'",
            [{'wait': ['Ready'], 'keys': 'v'}, {'wait': ['Read view'], 'keys': 'q'}],
        )
        self.assertEqual(result, {'exitCode': 0, 'stepsCompleted': 2})

    def test_early_exit_cannot_claim_completed_interaction(self):
        with self.assertRaisesRegex(AssertionError, 'early exit 0 at step 0'):
            self.execute("print('Exited')", [{'wait': ['Never rendered'], 'keys': 'q'}])


if __name__ == '__main__':
    unittest.main()
