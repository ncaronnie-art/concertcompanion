"""Conservative, review-only refinements for a CompassCore decision list.

This module deliberately does *not* alter an ``EditPlan``.  It returns a
deterministic editorial proposal that the integration layer can display and
apply only after the user accepts it.  That keeps reviewed trims, locks and
rejections authoritative while giving the existing planner a measurable way
to reduce repeated adjacent sources and reserve a longer hero moment.

The input shape is the JSON emitted by QualityCLI: ``plan`` has ``moments``
and ``settings``; every clip has optional ``audio`` and ``visual`` windows.
No field is interpreted as artist, song, lyric, or crowd-vocal information.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterable


ROLE_ORDER = ("hook", "establish", "build", "peak", "payoff", "end")


@dataclass(frozen=True)
class EditorialProposal:
    """A non-mutating order/role/transition recommendation.

    ``ordered_moment_ids`` contains every approved moment exactly once and
    retains locked moments at their current approved-list indexes.  The lead
    may turn this into a new plan only after the UI presents it for review.
    """

    ordered_moment_ids: list[str]
    roles: dict[str, str]
    transitions: list[dict[str, Any]]
    metrics_before: dict[str, Any]
    metrics_after: dict[str, Any]
    conflicts: list[str]
    notes: list[str]

    def as_dict(self) -> dict[str, Any]:
        return {
            "orderedMomentIDs": self.ordered_moment_ids,
            "roles": self.roles,
            "transitions": self.transitions,
            "metrics": {"before": self.metrics_before, "after": self.metrics_after},
            "conflicts": self.conflicts,
            "notes": self.notes,
        }


def propose_editorial_refinement(
    plan: dict[str, Any],
    clips: Iterable[dict[str, Any]],
    *,
    required_clip_ids: Iterable[str] = (),
    hero_min_seconds: float = 4.0,
) -> EditorialProposal:
    """Return a reviewable improvement without changing the source plan.

    Required sources are never dropped.  If the approved list does not cover
    one, the proposal reports a conflict instead of inventing a replacement.
    Locks are positional guardrails: a locked approved moment stays at the
    same approved-list index.  Rejected moments are excluded from the proposal
    but are otherwise untouched because the caller receives no rewritten plan.
    """

    all_moments = list(plan.get("moments") or [])
    approved = [m for m in all_moments if m.get("approved", True)]
    by_clip = {str(c.get("id")): c for c in clips}
    required = {str(value) for value in required_clip_ids}
    present = {str(m.get("clipID")) for m in approved}
    conflicts = [f"Required source {clip_id} has no approved moment; it was not silently omitted."
                 for clip_id in sorted(required - present)]

    if not approved:
        return EditorialProposal([], {}, [], _metrics([]), _metrics([]), conflicts,
                                 ["No approved moments are available for an editorial proposal."])

    # Preserve each locked moment's approved-list position, then greedily pick
    # from the remaining rows.  The objective rewards visual usability and a
    # sustained hero while penalizing adjacent duplicate sources.  It does not
    # treat raw loudness as proof of artist importance.
    remaining = {str(m.get("id")): m for m in approved if not m.get("locked", False)}
    ordered: list[dict[str, Any]] = []
    for index, original in enumerate(approved):
        if original.get("locked", False):
            ordered.append(original)
            continue
        role = _role_for_index(index, len(approved))
        previous_clip = str(ordered[-1].get("clipID")) if ordered else None
        candidates = list(remaining.values())
        selected = max(candidates, key=lambda m: _selection_score(
            m, by_clip.get(str(m.get("clipID")), {}), role, previous_clip
        ))
        ordered.append(selected)
        del remaining[str(selected.get("id"))]

    roles = {str(moment.get("id")): _role_for_index(i, len(ordered))
             for i, moment in enumerate(ordered)}
    _promote_sustained_hero(ordered, roles, by_clip, hero_min_seconds)
    settings = plan.get("settings") or {}
    transitions = _transition_proposals(ordered, by_clip, settings)
    before = _metrics(approved)
    after = _metrics(ordered, roles, hero_min_seconds)
    notes = [
        "Review-only suggestion: trims, locks, rejections and audio choices remain unchanged until accepted.",
        "Cuts are the default. A short dissolve is proposed only with measured, low-onset visual continuity.",
        "Signal data can describe onset, clipping, sharpness and shake; it cannot identify an artist, lyric, song, or crowd singer.",
    ]
    return EditorialProposal([str(m.get("id")) for m in ordered], roles, transitions,
                             before, after, conflicts, notes)


def _role_for_index(index: int, count: int) -> str:
    if count <= 1:
        return "hook"
    if count == 2:
        return ("hook", "end")[index]
    if count == 3:
        return ("hook", "peak", "end")[index]
    if count == 4:
        return ("hook", "establish", "peak", "end")[index]
    if count == 5:
        return ROLE_ORDER[index if index < 4 else 5]
    if index == 0:
        return "hook"
    if index == 1:
        return "establish"
    if index == count - 3:
        return "peak"
    if index == count - 2:
        return "payoff"
    if index == count - 1:
        return "end"
    return "build"


def _selection_score(moment: dict[str, Any], clip: dict[str, Any], role: str, previous_clip: str | None) -> float:
    duration = max(0.0, float(moment.get("duration") or 0))
    # Visual quality is deliberately the main observable: crowd loudness by
    # itself must not push a clip into a hero role.
    visual = _visual_quality(clip, moment)
    base = float(moment.get("score") or 0) * 0.35 + visual * 0.9
    if role in ("peak", "payoff"):
        base += min(duration, 6.0) * 0.08
    if role == "hook":
        base += min(duration, 2.5) * 0.04
    if previous_clip is not None and str(moment.get("clipID")) == previous_clip:
        base -= 0.42
    return base


def _promote_sustained_hero(ordered: list[dict[str, Any]], roles: dict[str, str], by_clip: dict[str, dict[str, Any]], minimum: float) -> None:
    candidates = [m for m in ordered if float(m.get("duration") or 0) >= minimum and not m.get("locked", False)]
    if not candidates:
        return
    hero = max(candidates, key=lambda m: _selection_score(m, by_clip.get(str(m.get("clipID")), {}), "peak", None))
    roles[str(hero.get("id"))] = "peak"


def _window_at(windows: Iterable[dict[str, Any]], time: float) -> dict[str, Any] | None:
    values = list(windows or [])
    return min(values, key=lambda window: abs(float(window.get("time") or 0) - time)) if values else None


def _visual_quality(clip: dict[str, Any], moment: dict[str, Any]) -> float:
    midpoint = float(moment.get("start") or 0) + float(moment.get("duration") or 0) / 2
    frame = _window_at(clip.get("visual") or [], midpoint)
    if not frame:
        return 0.5
    sharpness = min(1.0, max(0.0, float(frame.get("sharpness") or 0.5)))
    shake = min(1.0, max(0.0, float(frame.get("shake") or 0.2)))
    brightness = min(1.0, max(0.0, float(frame.get("brightness") or 0.5)))
    usable_light = 1.0 - min(1.0, abs(brightness - 0.52) * 1.35)
    return sharpness * 0.55 + (1.0 - shake) * 0.3 + usable_light * 0.15


def _transition_proposals(ordered: list[dict[str, Any]], by_clip: dict[str, dict[str, Any]], settings: dict[str, Any]) -> list[dict[str, Any]]:
    proposals: list[dict[str, Any]] = []
    calm_style = settings.get("style") in ("cinematic", "memory")
    automatic = settings.get("transitions", "automatic") == "automatic"
    for previous, incoming in zip(ordered, ordered[1:]):
        previous_clip = by_clip.get(str(previous.get("clipID")), {})
        incoming_clip = by_clip.get(str(incoming.get("clipID")), {})
        end_audio = _window_at(previous_clip.get("audio") or [], float(previous.get("start") or 0) + float(previous.get("duration") or 0))
        start_audio = _window_at(incoming_clip.get("audio") or [], float(incoming.get("start") or 0))
        end_visual = _window_at(previous_clip.get("visual") or [], float(previous.get("start") or 0) + float(previous.get("duration") or 0))
        start_visual = _window_at(incoming_clip.get("visual") or [], float(incoming.get("start") or 0))
        onsets_known = end_audio is not None and start_audio is not None
        strong_onset = onsets_known and max(float(end_audio.get("onset") or 0), float(start_audio.get("onset") or 0)) >= 0.55
        similar_light = end_visual is not None and start_visual is not None and abs(float(end_visual.get("brightness") or .5) - float(start_visual.get("brightness") or .5)) <= .18
        dissolve = automatic and calm_style and onsets_known and not strong_onset and similar_light and str(previous.get("clipID")) != str(incoming.get("clipID"))
        proposals.append({
            "fromMomentID": str(previous.get("id")),
            "toMomentID": str(incoming.get("id")),
            "kind": "dissolve" if dissolve else "cut",
            "seconds": 0.24 if dissolve else 0.0,
            "reason": "Measured low-onset boundary with similar light" if dissolve else (
                "Measured onset supports a clean cut" if strong_onset else "No reliable continuity signal; keep a clean cut"
            ),
            "confidence": "measured" if onsets_known else "low",
        })
    return proposals


def _metrics(moments: list[dict[str, Any]], roles: dict[str, str] | None = None, hero_min_seconds: float = 4.0) -> dict[str, Any]:
    repeats = sum(1 for left, right in zip(moments, moments[1:]) if left.get("clipID") == right.get("clipID"))
    sustained = any(float(m.get("duration") or 0) >= hero_min_seconds and (roles or {}).get(str(m.get("id"))) == "peak" for m in moments)
    return {"approvedCount": len(moments), "adjacentSourceRepeats": repeats, "hasSustainedHero": sustained,
            "totalApprovedSeconds": round(sum(float(m.get("duration") or 0) for m in moments), 3)}
