import unittest

from devtest.editorial.refine import propose_editorial_refinement


def clip(clip_id, *, audio=True, visual=True):
    return {
        "id": clip_id,
        "audio": ([{"time": 0, "onset": .1}, {"time": 5, "onset": .1}] if audio else []),
        "visual": ([{"time": 0, "sharpness": .9, "shake": .1, "brightness": .5},
                    {"time": 5, "sharpness": .9, "shake": .1, "brightness": .5}] if visual else []),
    }


def moment(moment_id, clip_id, start=0, duration=2, **extra):
    value = {"id": moment_id, "clipID": clip_id, "start": start, "duration": duration,
             "approved": True, "locked": False, "score": .5}
    value.update(extra)
    return value


def plan(moments, **settings):
    base = {"style": "cinematic", "transitions": "automatic"}
    base.update(settings)
    return {"settings": base, "moments": moments}


class EditorialRefinementTests(unittest.TestCase):
    def test_proposal_preserves_locks_rejections_and_required_coverage(self):
        locked = moment("locked", "A", duration=5, locked=True)
        rejected = moment("rejected", "Z", approved=False)
        result = propose_editorial_refinement(plan([moment("one", "A"), locked, moment("two", "B"), rejected]),
                                               [clip("A"), clip("B"), clip("Z")], required_clip_ids=["A", "B", "MISSING"])
        self.assertEqual(result.ordered_moment_ids[1], "locked")
        self.assertNotIn("rejected", result.ordered_moment_ids)
        self.assertTrue(any("MISSING" in conflict for conflict in result.conflicts))
        self.assertEqual(result.metrics_after["approvedCount"], 3)

    def test_reduces_adjacent_source_repeats_without_losing_irregular_durations(self):
        moments = [moment("a1", "A", duration=.37), moment("a2", "A", duration=5.19),
                   moment("b", "B", duration=1.11), moment("c", "C", duration=3.73)]
        result = propose_editorial_refinement(plan(moments), [clip("A"), clip("B"), clip("C")])
        self.assertLess(result.metrics_after["adjacentSourceRepeats"], result.metrics_before["adjacentSourceRepeats"])
        self.assertEqual(result.metrics_after["totalApprovedSeconds"], result.metrics_before["totalApprovedSeconds"])
        self.assertTrue(result.metrics_after["hasSustainedHero"])

    def test_absent_rhythm_and_silence_never_invent_a_dissolve(self):
        result = propose_editorial_refinement(plan([moment("one", "A"), moment("two", "B")]),
                                               [clip("A", audio=False), clip("B", audio=False)])
        self.assertEqual(result.transitions[0]["kind"], "cut")
        self.assertEqual(result.transitions[0]["confidence"], "low")

    def test_onset_boundary_prefers_cut_and_crowd_loudness_is_not_a_hero_signal(self):
        loud = clip("A")
        loud["audio"] = [{"time": 0, "onset": .9, "energy": 1}, {"time": 5, "onset": .9, "energy": 1}]
        soft = clip("B")
        soft["visual"] = [{"time": 0, "sharpness": 1, "shake": 0, "brightness": .5}]
        result = propose_editorial_refinement(plan([moment("loud", "A", duration=5), moment("clean", "B", duration=5)]), [loud, soft])
        self.assertEqual(result.transitions[0]["kind"], "cut")
        self.assertEqual(result.roles["clean"], "peak")  # visual quality/duration, not loudness, wins the hero role

    def test_deterministic_before_after_example_and_no_required_clip_is_dropped(self):
        moments = [moment("m1", "A"), moment("m2", "A"), moment("m3", "B", duration=4.5), moment("m4", "C")]
        first = propose_editorial_refinement(plan(moments), [clip("A"), clip("B"), clip("C")], required_clip_ids=["A", "B", "C"])
        second = propose_editorial_refinement(plan(moments), [clip("A"), clip("B"), clip("C")], required_clip_ids=["A", "B", "C"])
        self.assertEqual(first.as_dict(), second.as_dict())
        self.assertTrue({"A", "B", "C"} <= {source["clipID"] for source in moments if source["id"] in first.ordered_moment_ids})
        self.assertLessEqual(first.metrics_after["adjacentSourceRepeats"], first.metrics_before["adjacentSourceRepeats"])


if __name__ == "__main__":
    unittest.main()
