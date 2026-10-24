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
    def test_preparation_status_exposes_elapsed_time_without_fake_progress(self):
        session = server.Session()
        session.update(.1, 'Checking picture and sound; preparing a compatible preview')
        state = session.state()
        self.assertEqual(state['progress'], .1)
        self.assertEqual(state['statusSeconds'], 0)
        self.assertIn('statusSeconds', state)
        session.root.rmdir()
    def test_wizard_contract_only_exposes_real_renderer_modes(self):
        self.assertEqual(server.wizard_from({}), {
            "preset": "wizard", "aspectRatio": "9:16",
            "audioMode": "selected-moment-original", "vibePrompt": ""})
        self.assertEqual(server.wizard_from({"wizard": {"aspectRatio": "16:9"}})["aspectRatio"], "16:9")
        with self.assertRaises(engine.TestError):
            server.wizard_from({"wizard": {"audioMode": "single-master-clip"}})

    def test_wizard_persistence_and_real_adjustment_contract_are_shipped(self):
        source = (Path(engine.HERE) / "static" / "app.js").read_text()
        markup = (Path(engine.HERE) / "static" / "index.html").read_text()
        adapter = (Path(engine.HERE) / "Sources" / "QualityCLI" / "main.swift").read_text()
        self.assertIn("directed['wizard'] = wizard", Path(server.__file__).read_text())
        self.assertIn("editRequest", source)
        self.assertIn("Any edits before export?", markup)
        self.assertIn("One source beneath all visuals", markup)
        self.assertIn("No audio loops or padding", markup)
        self.assertIn("explicitSettings", adapter)

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
