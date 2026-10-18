"""Generated geometry tests for the non-destructive crop proposal helper."""
from __future__ import annotations
import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from picture.crop_policy import CAPABILITIES, MAX_FOCUS_SHIFT, crop_bounds, effective_dimensions, propose_crop


class PictureCropPolicyTests(unittest.TestCase):
    def moment(self, **changes):
        result = {"focusX": .5, "focusY": .5, "locked": False}
        result.update(changes)
        return result

    def test_capabilities_are_honest(self):
        self.assertTrue(CAPABILITIES["boundedCropProposal"])
        self.assertFalse(CAPABILITIES["motionStabilization"])
        self.assertFalse(CAPABILITIES["semanticArtistDetection"])

    def test_known_generated_landscape_target_stays_inside_crop(self):
        # Synthetic 1920x1080 target at x=.71 needs a modest horizontal move.
        proposal = propose_crop(self.moment(), width=1920, height=1080,
                                focal_point={"x": .71, "y": .5, "confidence": .95})
        self.assertTrue(proposal.applied)
        left, top, visible_w, visible_h = crop_bounds(1920, 1080, proposal.focus_x, proposal.focus_y)
        self.assertLessEqual(left, .71)
        self.assertGreaterEqual(left + visible_w, .71)
        self.assertEqual((top, visible_h), (0.0, 1.0))
        self.assertLessEqual(abs(proposal.focus_x - .5), MAX_FOCUS_SHIFT)

    def test_manual_and_locked_framing_are_never_overridden(self):
        point = {"x": .9, "y": .1, "confidence": 1}
        for moment, manual in ((self.moment(locked=True, focusX=.2, focusY=.8), False),
                               (self.moment(focusX=.2, focusY=.8), True)):
            proposal = propose_crop(moment, width=1920, height=1080, focal_point=point, manual_framing=manual)
            self.assertFalse(proposal.applied)
            self.assertEqual((proposal.focus_x, proposal.focus_y), (.2, .8))

    def test_unstable_pan_and_low_quality_fall_back_without_fake_stabilization(self):
        point = {"x": .8, "y": .5, "confidence": .9}
        for kwargs in ({"motion": [(0.04, 0)]}, {"quality": {"lowLight": True}},
                       {"quality": {"obstructed": True}}, {"focal_point": {"x": .8, "y": .5, "confidence": .2}}):
            proposal = propose_crop(self.moment(focusX=.3, focusY=.7), width=1920, height=1080,
                                    focal_point=kwargs.pop("focal_point", point), **kwargs)
            self.assertFalse(proposal.applied)
            self.assertEqual((proposal.focus_x, proposal.focus_y), (.3, .7))

    def test_rotation_metadata_and_portrait_no_overflow_are_safe(self):
        self.assertEqual(effective_dimensions(1080, 1920, 90), (1920, 1080))
        rotated = propose_crop(self.moment(), width=1080, height=1920, rotation=90,
                                focal_point={"x": .75, "y": .5, "confidence": .9})
        self.assertTrue(rotated.applied)
        portrait = propose_crop(self.moment(focusX=.3, focusY=.6), width=1080, height=1920,
                                 focal_point={"x": .9, "y": .1, "confidence": .9})
        self.assertFalse(portrait.applied)
        self.assertEqual((portrait.focus_x, portrait.focus_y), (.3, .6))


if __name__ == "__main__":
    unittest.main(verbosity=2)
