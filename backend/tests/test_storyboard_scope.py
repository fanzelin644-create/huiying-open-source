import copy
import unittest
from types import SimpleNamespace
from core.storyboard_scope import scope_artifacts
from core.orchestrator import WorkflowEngine, WorkflowStage


class StoryboardScopeTests(unittest.TestCase):
    def setUp(self):
        self.episodes = [{"episode_number":1,"segments":[
            {"segment_id":"one","segment_number":1,"shots":[{"content":"A","duration":5}]},
            {"segment_id":"two","segment_number":2,"enabled":False,"shots":[{"content":"B","duration":5}]}
        ]}]

    def test_paid_input_contains_only_selected_segment_and_does_not_mutate(self):
        artifacts = {"storyboard":{"episodes":self.episodes},
                     "reference_generation":{"scenes":[{"id":"one"},{"id":"two"}]},
                     "video_generation":{"clips":[{"id":"one"},{"id":"two"}]}}
        before = copy.deepcopy(artifacts)
        result = scope_artifacts(artifacts)
        self.assertEqual([s["segment_id"] for s in result["storyboard"]["episodes"][0]["segments"]], ["one"])
        self.assertEqual(result["reference_generation"]["scenes"], [{"id":"one"}])
        self.assertEqual(result["video_generation"]["clips"], [{"id":"one"}])
        self.assertEqual(artifacts, before)

    def test_scope_sync_restore_and_delete_keep_existing_media(self):
        engine = WorkflowEngine.__new__(WorkflowEngine)
        state = SimpleNamespace(artifacts={
            "reference_generation":{"scenes":[{"id":"two","selected":"existing.png","versions":["existing.png"]}]},
            "video_generation":{"clips":[{"id":"two","selected":"existing.mp4","versions":["existing.mp4"]}]}})
        engine._sync_artifacts_cross_stages(state, WorkflowStage.STORYBOARD, {"episodes":self.episodes})
        self.assertEqual([s["id"] for s in state.artifacts["reference_generation"]["scenes"]], ["one"])
        self.episodes[0]["segments"][1]["enabled"] = True
        engine._sync_artifacts_cross_stages(state, WorkflowStage.STORYBOARD, {"episodes":self.episodes})
        self.assertEqual(state.artifacts["video_generation"]["clips"][1]["selected"], "existing.mp4")
        self.episodes[0]["segments"] = self.episodes[0]["segments"][:1]
        engine._sync_artifacts_cross_stages(state, WorkflowStage.STORYBOARD, {"episodes":self.episodes})
        self.assertEqual([s["id"] for s in state.artifacts["video_generation"]["clips"]], ["one"])

    def test_empty_scope_never_falls_back_to_all(self):
        for segment in self.episodes[0]["segments"]:
            segment["enabled"] = False
        result = scope_artifacts({"storyboard":{"episodes":self.episodes}})
        self.assertEqual(result["storyboard"]["episodes"][0]["segments"], [])

    def test_delete_episode_removes_its_downstream_tasks(self):
        engine = WorkflowEngine.__new__(WorkflowEngine)
        state = SimpleNamespace(artifacts={})
        episodes = self.episodes + [{"episode_number":2,"segments":[
            {"segment_id":"three","shots":[{"content":"C","duration":4}]}]}]
        engine._sync_artifacts_cross_stages(state, WorkflowStage.STORYBOARD, {"episodes":episodes})
        engine._sync_artifacts_cross_stages(state, WorkflowStage.STORYBOARD, {"episodes":episodes[:1]})
        self.assertEqual([c["id"] for c in state.artifacts["video_generation"]["clips"]], ["one"])
        engine._sync_artifacts_cross_stages(state, WorkflowStage.STORYBOARD, {"episodes":[]})
        self.assertEqual(state.artifacts["video_generation"]["clips"], [])
        self.assertEqual(state.artifacts["reference_generation"]["scenes"], [])
