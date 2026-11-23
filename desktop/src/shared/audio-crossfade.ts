// A source-handle plan for soundtrack (or picture) joins. The user-selected
// ranges keep their original output positions; only unused source material
// immediately outside each range is borrowed for the overlap.
type SourceRange = {
  asset: { path: string; name: string; duration: number; hasAudio?: boolean; audioDuration?: number };
  start: number;
  end: number;
  locked?: boolean;
};

export type SourceCrossfadeOptions = {
  desiredSeconds?: number;
  medium?: "audio" | "video";
};

export type SourceCrossfadeBoundary = {
  overlapSeconds: number;
  outgoingExtraSeconds: number;
  incomingLeadSeconds: number;
  originalBoundarySeconds: number;
  overlapStartSeconds: number;
  overlapEndSeconds: number;
  reason?: "locked" | "short-section" | "no-handle";
};

export type SourceCrossfadePlan<T extends SourceRange> = {
  extendedSelections: T[];
  boundaries: SourceCrossfadeBoundary[];
  totalSeconds: number;
  warnings: string[];
};

const EPS = 0.000001;
const CODEC_TAIL_TOLERANCE = 0.05;
const MIN_OVERLAP = 0.05;
const CORE_FRACTION = 0.45;

function length(range: SourceRange): number { return range.end - range.start; }

function usableEnd(range: SourceRange, medium: "audio" | "video"): number {
  if (medium === "video") return range.asset.duration;
  const audioDuration = range.asset.audioDuration;
  if (audioDuration === undefined) return range.end;
  if (!Number.isFinite(audioDuration) || audioDuration < 0) {
    throw new Error(`Invalid measured audio duration for ${range.asset.name}.`);
  }
  return Math.min(range.asset.duration, audioDuration);
}

function validate<T extends SourceRange>(selections: readonly T[], medium: "audio" | "video"): void {
  for (const selection of selections) {
    if (!selection?.asset?.path || !Number.isFinite(selection.asset.duration) ||
      selection.asset.duration <= 0 || !Number.isFinite(selection.start) ||
      !Number.isFinite(selection.end) || selection.start < 0 ||
      length(selection) < 0.1 - EPS ||
      selection.end > selection.asset.duration + CODEC_TAIL_TOLERANCE ||
      selection.end > usableEnd(selection, medium) + CODEC_TAIL_TOLERANCE ||
      (selection.locked !== undefined && typeof selection.locked !== "boolean") ||
      (medium === "audio" && selection.asset.hasAudio === false)) {
      throw new Error(`Choose a valid ${medium} range from ${selection?.asset?.name ?? "a recording"}.`);
    }
  }
  for (let first = 0; first < selections.length; first++) {
    for (let second = first + 1; second < selections.length; second++) {
      const a = selections[first], b = selections[second];
      if (a.asset.path === b.asset.path && a.start < b.end - EPS && b.start < a.end - EPS) {
        throw new Error(`Selected ranges from ${a.asset.name} overlap; a crossfade cannot repeat source material.`);
      }
    }
  }
}

function freeAfter<T extends SourceRange>(selections: readonly T[], extended: readonly T[], index: number,
  medium: "audio" | "video"): number {
  const current = selections[index];
  let end = usableEnd(current, medium);
  for (let other = 0; other < extended.length; other++) {
    if (other !== index && extended[other].asset.path === current.asset.path &&
      extended[other].start >= current.end - EPS) {
      end = Math.min(end, extended[other].start);
    }
  }
  return Math.max(0, end - current.end);
}

function freeBefore<T extends SourceRange>(selections: readonly T[], extended: readonly T[], index: number): number {
  const current = selections[index];
  let start = 0;
  for (let other = 0; other < extended.length; other++) {
    if (other !== index && extended[other].asset.path === current.asset.path &&
      extended[other].end <= current.start + EPS) {
      start = Math.max(start, extended[other].end);
    }
  }
  return Math.max(0, current.start - start);
}

export function planSourceCrossfades<T extends SourceRange>(selections: readonly T[],
  options: SourceCrossfadeOptions = {}): SourceCrossfadePlan<T> {
  const medium = options.medium ?? "audio";
  const desired = options.desiredSeconds ?? 2;
  if (medium !== "audio" && medium !== "video") throw new Error("Choose audio or video joins.");
  if (!Number.isFinite(desired) || desired < 0 || desired > 30) {
    throw new Error("Choose a crossfade duration from zero to thirty seconds.");
  }
  validate(selections, medium);
  const extended = selections.map((selection) => ({ ...selection }));
  const totalSeconds = selections.reduce((total, selection) => total + length(selection), 0);
  const boundaries: SourceCrossfadeBoundary[] = [];
  const warnings: string[] = [];
  let originalBoundarySeconds = 0;

  for (let index = 0; index < selections.length - 1; index++) {
    const outgoing = selections[index], incoming = selections[index + 1];
    originalBoundarySeconds += length(outgoing);
    let outgoingExtraSeconds = 0, incomingLeadSeconds = 0;
    let reason: SourceCrossfadeBoundary["reason"];
    if (outgoing.locked || incoming.locked) reason = "locked";
    else if (desired > 0) {
      // Each boundary may consume less than half of either original section.
      // Two joins around a short section therefore cannot run into each other.
      let target = Math.min(desired, CORE_FRACTION * Math.min(length(outgoing), length(incoming)));
      const shortSection = target + EPS < desired;
      if (outgoing.asset.path === incoming.asset.path && outgoing.end <= incoming.start) {
        target = Math.min(target, incoming.start - outgoing.end);
      }
      const outgoingCapacity = Math.min(freeAfter(selections, extended, index, medium),
        CORE_FRACTION * length(incoming));
      const incomingCapacity = Math.min(freeBefore(selections, extended, index + 1),
        CORE_FRACTION * length(outgoing));
      outgoingExtraSeconds = Math.min(target / 2, outgoingCapacity);
      incomingLeadSeconds = Math.min(target / 2, incomingCapacity);
      let unfilled = target - outgoingExtraSeconds - incomingLeadSeconds;
      const extraOutgoing = Math.min(unfilled, outgoingCapacity - outgoingExtraSeconds);
      outgoingExtraSeconds += extraOutgoing; unfilled -= extraOutgoing;
      const extraIncoming = Math.min(unfilled, incomingCapacity - incomingLeadSeconds);
      incomingLeadSeconds += extraIncoming;
      if (outgoingExtraSeconds + incomingLeadSeconds < MIN_OVERLAP - EPS) {
        outgoingExtraSeconds = 0; incomingLeadSeconds = 0;
      }
      if (outgoingExtraSeconds + incomingLeadSeconds + EPS < desired) {
        reason = shortSection ? "short-section" : "no-handle";
        warnings.push(`The join from ${outgoing.asset.name} to ${incoming.asset.name} supports only ` +
          `${(outgoingExtraSeconds + incomingLeadSeconds).toFixed(2)} seconds of the requested ` +
          `${desired.toFixed(2)}-second overlap with these sections and ${medium} handles.`);
      }
      extended[index].end += outgoingExtraSeconds;
      extended[index + 1].start -= incomingLeadSeconds;
    }
    const overlapSeconds = outgoingExtraSeconds + incomingLeadSeconds;
    boundaries.push({ overlapSeconds, outgoingExtraSeconds, incomingLeadSeconds,
      originalBoundarySeconds, overlapStartSeconds: originalBoundarySeconds - incomingLeadSeconds,
      overlapEndSeconds: originalBoundarySeconds + outgoingExtraSeconds, ...(reason ? { reason } : {}) });
  }

  return { extendedSelections: extended, boundaries, totalSeconds, warnings };
}
