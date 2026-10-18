import copy
import hashlib
import importlib.util
import math
from pathlib import Path
import unittest

source = Path(__file__).resolve().parents[1] / "scripts/exhaustive-guide-process.py"
spec = importlib.util.spec_from_file_location("guide_process", source)
assert spec and spec.loader
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ProcessCoverageTest(unittest.TestCase):
    def setUp(self):
        matrix = module.domains()
        total = math.prod(len(values) for values in matrix.values())
        digest = hashlib.sha256()
        for index in range(total):
            digest.update(f"{index}\n".encode())
        self.report = {"scope": "guide-ritual-preview-terminal-routing-only", "domains": matrix,
                       "sourceHashes": module.sources(), "complete": True, "expectedCases": total,
                       "executedCases": total, "distinctTupleIds": total,
                       "outcomes": {"terminal-rejected": total}, "idSequenceSha256": digest.hexdigest()}

    def test_complete_report(self):
        self.assertTrue(module.verify_coverage(self.report)["complete"])

    def test_rejects_source_and_domain_drift(self):
        for key, value in (("sourceHashes", {}), ("domains", {})):
            with self.subTest(key=key), self.assertRaises(AssertionError):
                module.verify_coverage({**self.report, key: value})

    def test_rejects_missing_repeated_or_misclassified_cases(self):
        for key, value in (("executedCases", 1), ("distinctTupleIds", 1), ("complete", False),
                           ("outcomes", {"terminal-rejected": 1}), ("idSequenceSha256", "wrong")):
            with self.subTest(key=key), self.assertRaises(AssertionError):
                module.verify_coverage({**self.report, key: value})

    def test_rejects_unknown_scope_and_outcomes(self):
        for key, value in (("scope", "all-guide-behavior"), ("outcomes", {"unverified": self.report["executedCases"]})):
            with self.subTest(key=key), self.assertRaises(AssertionError):
                module.verify_coverage({**self.report, key: value})

    def test_rejects_noninteger_counts(self):
        for value in (True, "864", 864.0):
            report = copy.deepcopy(self.report)
            report["executedCases"] = value
            with self.subTest(value=value), self.assertRaises(AssertionError):
                module.verify_coverage(report)


if __name__ == "__main__":
    unittest.main()
