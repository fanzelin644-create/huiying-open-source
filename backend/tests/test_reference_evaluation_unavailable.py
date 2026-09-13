import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock
from core.agents.reference_agent import ReferenceGeneratorAgent


class EvaluationFailureTests(unittest.TestCase):
    def test_evaluator_outage_does_not_generate_more_images(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/"image.png"
            path.write_bytes(b"image")
            agent = ReferenceGeneratorAgent.__new__(ReferenceGeneratorAgent)
            agent.cancellation_check = None
            agent._check_cancel = Mock()
            agent._get_style_prompt = Mock(return_value="")
            agent._next_version_path = Mock(return_value=str(path))
            agent._report_progress = Mock()
            agent._evaluate_with_vlm = Mock(return_value={"evaluation_status":"unavailable","is_acceptable":False})
            client = Mock()
            client.generate_image.return_value = [str(path)]
            result = agent._generate_one(client,"test",{"segment_id":"one","shots":[]},"test",[],"test","test","test")
            self.assertEqual(client.generate_image.call_count,1)
            self.assertEqual(result[1],str(path))
            self.assertFalse(result[2]["is_acceptable"])
