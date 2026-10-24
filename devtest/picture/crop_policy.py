"""Bounded 9:16 crop suggestions, deliberately separate from rendering.

This module does not inspect identities, invent pixels, or stabilize video.  It
only translates a *trusted, local* focal-point measurement into the focusX /
focusY fractions already understood by the renderer.  Uncertain input returns
the existing user framing unchanged.
"""
from __future__ import annotations

from dataclasses import dataclass
from math import isfinite
from typing import Mapping, Sequence


TARGET_ASPECT = 9 / 16
MIN_CONFIDENCE = 0.70
MAX_FOCUS_SHIFT = 0.18
MAX_MOTION_FOR_PROPOSAL = 0.035

CAPABILITIES = {
    "boundedCropProposal": True,
    "motionStabilization": False,
    "semanticArtistDetection": False,
}


@dataclass(frozen=True)
class CropProposal:
    """A non-destructive candidate for a moment's existing crop fractions."""

    focus_x: float
    focus_y: float
    applied: bool
    reason: str
    confidence: float = 0.0


def _unit(value: object, default: float) -> float:
    if type(value) not in (int, float) or not isfinite(float(value)):
        return default
    return min(1.0, max(0.0, float(value)))


def effective_dimensions(width: int, height: int, rotation: float = 0) -> tuple[int, int]:
    """Return display dimensions after right-angle rotation metadata."""
    if type(width) is not int or type(height) is not int or width <= 0 or height <= 0:
        raise ValueError("positive integer dimensions are required")
    if type(rotation) not in (int, float) or not isfinite(float(rotation)):
        raise ValueError("finite rotation is required")
    return (height, width) if round(float(rotation)) % 180 else (width, height)


def crop_bounds(width: int, height: int, focus_x: float, focus_y: float,
                rotation: float = 0, target_aspect: float = TARGET_ASPECT) -> tuple[float, float, float, float]:
    """Return the normalized source rectangle selected by the renderer's crop.

    This maps exactly to ``scale=...:increase,crop=...:(iw-ow)*focusX``.  It
    makes crop assertions possible without decoding or modifying source media.
    """
    if target_aspect <= 0 or not isfinite(target_aspect):
        raise ValueError("a positive finite target aspect is required")
    width, height = effective_dimensions(width, height, rotation)
    aspect = width / height
    fx, fy = _unit(focus_x, 0.5), _unit(focus_y, 0.5)
    if aspect >= target_aspect:
        visible_w, visible_h = target_aspect / aspect, 1.0
    else:
        visible_w, visible_h = 1.0, aspect / target_aspect
    return ((1 - visible_w) * fx, (1 - visible_h) * fy, visible_w, visible_h)


def _focus_for_target(target: float, visible: float) -> float:
    """Place a target near the crop centre while respecting the source edge."""
    if visible >= 1:
        return 0.5
    start = min(1 - visible, max(0.0, target - visible / 2))
    return start / (1 - visible)


def _motion_is_uncertain(motion: Sequence[Sequence[float]] | None) -> bool:
    if not motion:
        return False
    try:
        return any(max(abs(float(dx)), abs(float(dy))) > MAX_MOTION_FOR_PROPOSAL for dx, dy in motion)
    except (TypeError, ValueError):
        return True


def propose_crop(moment: Mapping[str, object], *, width: int, height: int,
                 focal_point: Mapping[str, object] | None = None,
                 rotation: float = 0, motion: Sequence[Sequence[float]] | None = None,
                 quality: Mapping[str, object] | None = None,
                 manual_framing: bool = False) -> CropProposal:
    """Suggest a small crop adjustment or preserve the current framing.

    ``focal_point`` is intentionally just a caller-supplied normalized point
    ``{x, y, confidence}``; it is not a person detector.  A lock, explicit
    manual framing, low confidence, low-light/obstruction flag, or motion above
    the small proposal guard all keep the current crop exactly as selected.
    """
    old_x, old_y = _unit(moment.get("focusX"), 0.5), _unit(moment.get("focusY"), 0.5)
    if bool(moment.get("locked")) or manual_framing:
        return CropProposal(old_x, old_y, False, "manual framing preserved")
    if not focal_point:
        return CropProposal(old_x, old_y, False, "no trusted focal point")
    confidence = _unit(focal_point.get("confidence"), 0.0)
    if confidence < MIN_CONFIDENCE:
        return CropProposal(old_x, old_y, False, "low-confidence focal point", confidence)
    quality = quality or {}
    if bool(quality.get("lowLight")) or bool(quality.get("obstructed")):
        return CropProposal(old_x, old_y, False, "uncertain picture quality", confidence)
    if _motion_is_uncertain(motion):
        return CropProposal(old_x, old_y, False, "motion fallback; stabilization is unavailable", confidence)

    display_w, display_h = effective_dimensions(width, height, rotation)
    left, top, visible_w, visible_h = crop_bounds(display_w, display_h, old_x, old_y)
    target_x, target_y = _unit(focal_point.get("x"), .5), _unit(focal_point.get("y"), .5)
    desired_x = _focus_for_target(target_x, visible_w)
    desired_y = _focus_for_target(target_y, visible_h)
    # A proposal is never an arbitrary punch-in: its focus shift is bounded,
    # and a source with no crop overflow remains untouched.
    new_x = min(old_x + MAX_FOCUS_SHIFT, max(old_x - MAX_FOCUS_SHIFT, desired_x))
    new_y = min(old_y + MAX_FOCUS_SHIFT, max(old_y - MAX_FOCUS_SHIFT, desired_y))
    if (visible_w == 1.0 and visible_h == 1.0) or (abs(new_x - old_x) < .002 and abs(new_y - old_y) < .002):
        return CropProposal(old_x, old_y, False, "existing framing already fits", confidence)
    return CropProposal(new_x, new_y, True, "bounded focal-point proposal", confidence)
