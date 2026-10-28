import unittest
from run import compare, observations, run
from pathlib import Path
import sys
import tempfile


class EvidenceTests(unittest.TestCase):
    def test_empty_successful_processes_are_not_parity(self):
        _, _, passed = compare({"code": 0, "output": ""}, {"code": 0, "output": ""})
        self.assertFalse(passed)

    def test_matching_output_from_failed_process_is_not_parity(self):
        output = "\n".join("FM_OBS|" + key + "|1" for key in ("22|1", "22|0", "0|1"))
        _, _, passed = compare({"code": 1, "output": output}, {"code": 0, "output": output})
        self.assertFalse(passed)

    def test_wrong_input_set_cannot_pass(self):
        output = "\n".join("FM_OBS|" + key + "|1" for key in ("23|1", "23|0", "0|1"))
        _, _, passed = compare({"code": 0, "output": output}, {"code": 0, "output": output})
        self.assertFalse(passed)

    def test_duplicate_observations_are_rejected(self):
        with self.assertRaises(ValueError):
            observations("FM_OBS|22|1|1\nFM_OBS|22|1|0")

    def test_revert_data_difference_is_detected(self):
        lean = '\n'.join('"FM_OBS|' + key + '"' for key in ("22|1|1", "22|0|0", "0|1|revert:1,2"))
        evm = lean.replace('"', '').replace("revert:1,2", "revert:1,3")
        self.assertFalse(compare({"code": 0, "output": lean}, {"code": 0, "output": evm})[2])

    def test_timeout_is_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            result = run([sys.executable, "-c", "import time; time.sleep(10)"], Path(directory), timeout=0.05)
        self.assertEqual(result["code"], 124)


if __name__ == "__main__":
    unittest.main()
