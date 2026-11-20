import type { CreativeBriefInput, CreativeClip } from "./creative-brief.js";
import type { ExportOptions, MediaAsset } from "./render-plan.js";

export type ProjectSnapshot = {
  version: 1;
  clips: CreativeClip[];
  options: ExportOptions;
  briefInput: CreativeBriefInput;
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isString = (value: unknown, maximum = 32767): value is string =>
  typeof value === "string" && value.length <= maximum;
const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const oneOf = <T extends string>(value: unknown, choices: readonly T[]): value is T =>
  typeof value === "string" && choices.includes(value as T);

function readAsset(value: unknown): MediaAsset {
  if (!isObject(value) || !isString(value.path) || !value.path ||
    !isString(value.name, 500) || !value.name ||
    !isNumber(value.duration) || value.duration < 0.1 ||
    !isNumber(value.width) || value.width < 1 ||
    !isNumber(value.height) || value.height < 1 ||
    typeof value.hasAudio !== "boolean") throw new Error("The project contains an invalid video.");
  return { path: value.path, name: value.name, duration: value.duration,
    width: value.width, height: value.height, hasAudio: value.hasAudio };
}

function readClip(value: unknown): CreativeClip {
  if (!isObject(value)) throw new Error("The project contains an invalid section.");
  const asset = readAsset(value.asset);
  if (!isNumber(value.start) || !isNumber(value.end) || value.start < 0 ||
    value.end - value.start < 0.1 || value.end > asset.duration + 0.05 ||
    typeof value.included !== "boolean" || typeof value.locked !== "boolean" ||
    typeof value.excludedByUser !== "boolean" ||
    !oneOf(value.selectionSource, ["suggested", "manual"] as const) ||
    (value.included && value.excludedByUser) ||
    (value.label !== undefined && !isString(value.label, 100))) {
    throw new Error(`The project has an invalid section for ${asset.name}.`);
  }
  return { asset, start: value.start, end: value.end, included: value.included,
    locked: value.locked, excludedByUser: value.excludedByUser,
    selectionSource: value.selectionSource,
    ...(value.label === undefined ? {} : { label: value.label }) };
}

function readOptions(value: unknown): ExportOptions {
  if (!isObject(value) || !oneOf(value.aspect, ["vertical", "landscape"] as const) ||
    typeof value.reduceRumble !== "boolean" ||
    (value.finish !== undefined && !oneOf(value.finish, ["natural", "vivid", "cinematic", "warm"] as const)) ||
    (value.transition !== undefined && !oneOf(value.transition, ["cut", "fade"] as const))) {
    throw new Error("The project contains invalid video settings.");
  }
  return { aspect: value.aspect, reduceRumble: value.reduceRumble,
    ...(value.finish === undefined ? {} : { finish: value.finish }),
    ...(value.transition === undefined ? {} : { transition: value.transition }) };
}

function readBrief(value: unknown): CreativeBriefInput {
  if (!isObject(value) || !isString(value.description, 4000) ||
    (value.videoType !== undefined && !oneOf(value.videoType, ["highlight", "one-song", "recap", "compilation"] as const)) ||
    (value.vibe !== undefined && !oneOf(value.vibe, ["energetic", "cinematic", "nostalgic", "intimate", "clean-live", "custom"] as const)) ||
    (value.selectionMode !== undefined && !oneOf(value.selectionMode, ["use-my-sections", "choose-for-me", "keep-and-choose"] as const)) ||
    (value.targetSeconds !== undefined && value.targetSeconds !== null &&
      (!isNumber(value.targetSeconds) || value.targetSeconds < 0.1 || value.targetSeconds > 86400)) ||
    (value.aspect !== undefined && !oneOf(value.aspect, ["vertical", "landscape"] as const)) ||
    (value.customVibe !== undefined && !isString(value.customVibe, 500))) {
    throw new Error("The project contains an invalid creative brief.");
  }
  return { description: value.description,
    ...(value.videoType === undefined ? {} : { videoType: value.videoType }),
    ...(value.vibe === undefined ? {} : { vibe: value.vibe }),
    ...(value.selectionMode === undefined ? {} : { selectionMode: value.selectionMode }),
    ...(value.targetSeconds === undefined ? {} : { targetSeconds: value.targetSeconds }),
    ...(value.aspect === undefined ? {} : { aspect: value.aspect }),
    ...(value.customVibe === undefined ? {} : { customVibe: value.customVibe }) };
}

// Keep project data as ranges and settings. Preview URLs and generated files are session-only.
export function parseProjectSnapshot(value: unknown): ProjectSnapshot {
  if (!isObject(value) || value.version !== 1 || !Array.isArray(value.clips) ||
    value.clips.length < 1 || value.clips.length > 500) {
    throw new Error("This is not a supported Concert Compass project.");
  }
  const clips = value.clips.map(readClip);
  if (new Set(clips.map((clip) => clip.asset.path.toLowerCase())).size !== clips.length) {
    throw new Error("The project lists the same recording more than once.");
  }
  return { version: 1, clips, options: readOptions(value.options),
    briefInput: readBrief(value.briefInput) };
}
