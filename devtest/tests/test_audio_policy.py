"""Generated-signal evidence for the optional audio seam policy."""
from __future__ import annotations

import array
import math
import subprocess
import sys
import time
import tracemalloc
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from audio.policy import AudioPolicy, AudioPolicyError, crossfade_frames, peak_step


def tone(frames: int, frequency: float, sample_rate: int = 48_000, amplitude: float = 0.8):
    return [
        (amplitude * math.sin(2 * math.pi * frequency * index / sample_rate),
         amplitude * math.cos(2 * math.pi * frequency * index / sample_rate))
        for index in range(frames)
    ]


class AudioPolicyTests(unittest.TestCase):
    def test_default_is_raw_and_unknown_settings_do_not_enable_processing(self):
        policy = AudioPolicy.from_settings({"gentleCleanup": 1, "seamSmoothing": "yes"})
        self.assertEqual(policy.segment_suffix(), "")
        self.assertIsNone(policy.seam_filter(.2))
        self.assertFalse(policy.renderer_contract(.2)["crowdVoiceIsolation"])

    def test_opt_in_contract_uses_existing_overlap_without_timeline_change(self):
        policy = AudioPolicy(gentle_cleanup=True, seam_smoothing=True)
        contract = policy.renderer_contract(.24)
        self.assertEqual(contract["segmentSuffix"], ",highpass=f=70:mix=0.45")
        self.assertEqual(contract["seamFilter"], "acrossfade=d=0.240000:c1=tri:c2=tri")
        self.assertTrue(contract["requiresExistingVisualOverlap"])
        self.assertFalse(contract["changesTimeline"])
        self.assertFalse(contract["addsGain"])
        self.assertIsNone(policy.seam_filter(0))
        with self.assertRaises(AudioPolicyError):
            policy.seam_filter(.76)

    def test_abrupt_phase_flip_has_lower_click_proxy_after_crossfade(self):
        # A deliberately hostile generated boundary: +0.8 jumps to -0.8.
        tail = [(0.8, 0.8)] * 4_800
        head = [(-0.8, -0.8)] * 4_800
        raw = tail + head
        smoothed = crossfade_frames(tail, head, 1_920)  # 40 ms at 48 kHz
        self.assertEqual(len(smoothed), len(raw) - 1_920)
        self.assertAlmostEqual(peak_step(raw), 1.6)
        self.assertLess(peak_step(smoothed), .01)

    def test_ffmpeg_fragment_reduces_the_same_generated_phase_flip(self):
        """Exercise the exact fragment handed to the bounded FFmpeg assembler."""
        fragment = AudioPolicy(seam_smoothing=True).seam_filter(.04)
        command = [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin",
            "-f", "lavfi", "-i", "aevalsrc=0.8:s=48000:d=0.1",
            "-f", "lavfi", "-i", "aevalsrc=-0.8:s=48000:d=0.1",
            "-filter_complex", f"[0:a][1:a]{fragment}[a]", "-map", "[a]",
            "-f", "f32le", "pipe:1",
        ]
        raw = subprocess.check_output(command)
        samples = array.array("f"); samples.frombytes(raw)
        frames = [(sample,) for sample in samples]
        self.assertEqual(len(frames), 7_680)  # .1 + .1 - .04 seconds
        self.assertLess(peak_step(frames), .01)

    def test_silence_and_tones_keep_stereo_order_duration_and_safe_peak(self):
        silence = [(0.0, 0.0)] * 2_400
        bass = tone(2_400, 55)
        treble = tone(2_400, 8_000)
        result = crossfade_frames(silence + bass, treble, 480)
        self.assertEqual(len(result), 4_800 + 2_400 - 480)
        self.assertTrue(all(len(frame) == 2 for frame in result))
        # Channels remain distinct; no mono fold-down or amplitude overshoot.
        self.assertTrue(any(abs(left - right) > .05 for left, right in result))
        self.assertLessEqual(max(abs(sample) for frame in result for sample in frame), .8 + 1e-12)
        self.assertEqual(result[0], (0.0, 0.0))

    def test_invalid_channel_and_fade_requests_fail_closed(self):
        with self.assertRaises(AudioPolicyError):
            crossfade_frames([(0.1,)], [(0.1, 0.2)], 1)
        with self.assertRaises(AudioPolicyError):
            crossfade_frames([(0.1,)], [(0.1,)], 0)
        with self.assertRaises(AudioPolicyError):
            crossfade_frames([], [(0.1,)], 1)

    def test_generated_measurement_cost_is_small_and_repeatable(self):
        tail, head = tone(9_600, 220), tone(9_600, 880)
        tracemalloc.start(); started = time.perf_counter()
        result = crossfade_frames(tail, head, 1_920)
        _, peak_memory = tracemalloc.get_traced_memory(); tracemalloc.stop()
        elapsed = time.perf_counter() - started
        self.assertEqual(len(result), 17_280)
        self.assertLess(elapsed, 1.0)
        self.assertLess(peak_memory, 8 * 1024 * 1024)


if __name__ == "__main__":
    unittest.main(verbosity=2)
