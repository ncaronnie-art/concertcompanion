"""Small, opt-in audio policy for existing Concert Compass render seams.

This module intentionally does not decode, normalize, denoise, or render media.
It gives the renderer vetted FFmpeg fragments plus deterministic seam measurements.
The current renderer owns timeline math and must only call ``seam_filter`` where
the visual plan already has an overlap of exactly the same duration.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Sequence


class AudioPolicyError(ValueError):
    """Raised when a caller requests a policy outside the conservative bounds."""


@dataclass(frozen=True)
class AudioPolicy:
    """Opt-in cleanup policy; raw source audio remains the default.

    ``gentle_cleanup`` is deliberately limited to the existing mixed high-pass
    filter. It can soften very low handling/rumble energy but cannot separate a
    crowd voice from artist vocals. It adds no gain and preserves stereo.

    ``seam_smoothing`` only applies at an already-planned visual dissolve. It
    uses FFmpeg's linear crossfade, which cannot exceed either input's sample
    amplitude for matching sample ranges (unlike equal-power curves). It must
    never create an overlap or shorten a hard-cut timeline on its own.
    """

    gentle_cleanup: bool = False
    seam_smoothing: bool = False
    rumble_hz: int = 70
    rumble_mix: float = 0.45
    max_seam_seconds: float = 0.75

    @classmethod
    def from_settings(cls, settings: dict | None) -> "AudioPolicy":
        settings = settings or {}
        # Unknown values intentionally do not turn processing on.
        return cls(
            gentle_cleanup=settings.get("gentleCleanup") is True,
            seam_smoothing=settings.get("seamSmoothing") is True,
        )

    def segment_suffix(self) -> str:
        """FFmpeg filter suffix for a decoded source segment, or an empty string."""
        if not self.gentle_cleanup:
            return ""
        return f",highpass=f={self.rumble_hz}:mix={self.rumble_mix:.2f}"

    def seam_filter(self, overlap_seconds: float) -> str | None:
        """Return an acrossfade fragment for an *existing* visual overlap.

        Callers must preserve the same overlap in video and subtract it once
        from the output duration. ``None`` means leave the current seam alone.
        A zero-overlap hard cut cannot be quietly converted into a crossfade.
        """
        if not self.seam_smoothing:
            return None
        if not isinstance(overlap_seconds, (int, float)) or isinstance(overlap_seconds, bool):
            raise AudioPolicyError("Seam duration must be a number.")
        if overlap_seconds <= 0:
            return None
        if overlap_seconds > self.max_seam_seconds:
            raise AudioPolicyError("Seam duration exceeds the conservative policy limit.")
        # tri has no equal-power overshoot for correlated concert audio.
        return f"acrossfade=d={overlap_seconds:.6f}:c1=tri:c2=tri"

    def renderer_contract(self, overlap_seconds: float) -> dict[str, object]:
        """Stable handoff contract for the existing bounded assembler."""
        seam = self.seam_filter(overlap_seconds)
        return {
            "segmentSuffix": self.segment_suffix(),
            "seamFilter": seam,
            "requiresExistingVisualOverlap": seam is not None,
            "preservesChannels": True,
            "addsGain": False,
            "changesTimeline": False,
            "crowdVoiceIsolation": False,
        }


def _as_frames(audio: Iterable[Sequence[float]]) -> list[tuple[float, ...]]:
    frames = [tuple(float(sample) for sample in frame) for frame in audio]
    if not frames:
        raise AudioPolicyError("Audio frames cannot be empty.")
    channels = len(frames[0])
    if channels < 1 or any(len(frame) != channels for frame in frames):
        raise AudioPolicyError("Audio frames must have a stable channel count.")
    return frames


def crossfade_frames(
    tail: Iterable[Sequence[float]], head: Iterable[Sequence[float]], fade_frames: int
) -> list[tuple[float, ...]]:
    """Reference linear crossfade for tests and measurable seam evidence.

    The returned length is ``len(tail) + len(head) - fade_frames``—the same
    behavior required when an existing video transition already overlaps. It
    never mixes channels and each mixed sample is a convex combination, so its
    magnitude cannot exceed the larger matching input magnitude.
    """
    tail_frames, head_frames = _as_frames(tail), _as_frames(head)
    if len(tail_frames[0]) != len(head_frames[0]):
        raise AudioPolicyError("Crossfade inputs must have matching channel counts.")
    if not isinstance(fade_frames, int) or isinstance(fade_frames, bool):
        raise AudioPolicyError("Fade length must be an integer frame count.")
    if fade_frames < 1 or fade_frames > min(len(tail_frames), len(head_frames)):
        raise AudioPolicyError("Fade length must fit in both audio inputs.")
    mixed: list[tuple[float, ...]] = []
    for index in range(fade_frames):
        # Include both endpoints so a constant signal remains exactly constant.
        fraction = index / (fade_frames - 1) if fade_frames > 1 else 1.0
        a, b = tail_frames[-fade_frames + index], head_frames[index]
        mixed.append(tuple((1.0 - fraction) * left + fraction * right for left, right in zip(a, b)))
    return tail_frames[:-fade_frames] + mixed + head_frames[fade_frames:]


def peak_step(audio: Iterable[Sequence[float]]) -> float:
    """Largest adjacent-sample change across all channels; a click-risk proxy."""
    frames = _as_frames(audio)
    return max(
        (abs(current[channel] - previous[channel])
         for previous, current in zip(frames, frames[1:])
         for channel in range(len(frames[0]))),
        default=0.0,
    )
