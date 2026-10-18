"""Lead-owned integration checks for the quality sprint's actual wiring."""
from __future__ import annotations

import copy
import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import engine
import server
from audio.policy import AudioPolicy


class SprintIntegrationTests(unittest.TestCase):
    def test_settings_route_audio_policy_without_enabling_processing_by_default(self):
        raw = engine.settings_from({})
        self.assertFalse(raw["gentleCleanup"])
        self.assertFalse(raw["seamSmoothing"])
        self.assertEqual(AudioPolicy.from_settings(raw).segment_suffix(), "")
        cleaned = engine.settings_from({"gentleCleanup": True, "seamSmoothing": True})
        policy = AudioPolicy.from_settings(cleaned)
        self.assertIn("highpass", policy.segment_suffix())
        self.assertIn("acrossfade", policy.seam_filter(.24))

    def test_annotation_exposes_review_only_editorial_advice_without_rewriting_choice(self):
        directed = {
            "plan": {"settings": {"style": "cinematic", "transitions": "automatic"}, "moments": [
                {"id": "a", "clipID": "A", "start": 0, "duration": 5, "approved": True,
                 "locked": True, "muted": False, "focusX": .2, "focusY": .8, "score": .4},
                {"id": "b", "clipID": "B", "start": 1, "duration": 3, "approved": True,
                 "locked": False, "muted": False, "focusX": .5, "focusY": .5, "score": .8},
            ]},
            "timeline": [{"at": 0, "moment": {"duration": 5}}, {"at": 5, "moment": {"duration": 3}}],
        }
        original = copy.deepcopy(directed["plan"]["moments"])
        clips = [{"id": "A", "name": "Clip A", "audio": [], "visual": []},
                 {"id": "B", "name": "Clip B", "audio": [], "visual": []}]
        annotated = server.annotate(directed, clips)
        self.assertEqual(annotated["plan"]["moments"], original)
        proposal = annotated["editorialProposal"]
        self.assertEqual(proposal["orderedMomentIDs"][0], "a")
        self.assertEqual(proposal["metrics"]["after"]["totalApprovedSeconds"], 8)
        self.assertEqual(annotated["coverage"]["omitted"], [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
