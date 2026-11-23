import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AudioEventFeatures, AudioEventBins, eventScores, EVENT_SAMPLE_RATE,
  type EventScores, type EventBin } from "../src/shared/audio-event-features.js";

type Tensor = { data: Float32Array; dispose(): void };
type Session = { run(input: Record<string, Tensor>): Promise<Record<string, Tensor>>; release(): Promise<void> };
type Ort = { env: { wasm: { numThreads: number; proxy: boolean; wasmPaths: string } };
  Tensor: new (type: "float32", data: Float32Array, dimensions: number[]) => Tensor;
  InferenceSession: { create(bytes: Uint8Array, options: unknown): Promise<Session> } };
export type AudioEventModel = { classify(features: Float32Array, signal?: AbortSignal): Promise<EventScores> };
export class AudioEventsUnavailableError extends Error {}
const unavailable = "Local singing and crowd analysis is unavailable; using sound measurements only.";
export const AUDIO_EVENTS_FALLBACK = unavailable;

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
let cachedModel: { directory: string; promise: Promise<AudioEventModel> } | undefined;

async function resourceDirectory() {
  for (const relative of ["../../resources/audio-events", "../resources/audio-events"]) {
    const candidate = path.resolve(moduleDirectory, relative);
    try { await readFile(path.join(candidate, "provenance.json")); return candidate; } catch { /* try source layout */ }
  }
  throw new AudioEventsUnavailableError(unavailable);
}

export async function loadAudioEventModel(directory?: string): Promise<AudioEventModel> {
  const location = directory ?? await resourceDirectory();
  if (cachedModel?.directory === location) return cachedModel.promise;
  const promise = (async () => {
    const provenance = JSON.parse(await readFile(path.join(location, "provenance.json"), "utf8"));
    if (provenance.version !== 1 || provenance.runtime.version !== "1.23.2") throw new Error("Unsupported audio model resources.");
    const names = ["model/yamnet.onnx", "model/yamnet.data", "runtime/ort.wasm.min.mjs",
      "runtime/ort-wasm-simd-threaded.mjs", "runtime/ort-wasm-simd-threaded.wasm"];
    const resources = new Map<string, Buffer>();
    for (const name of names) {
      const bytes = await readFile(path.join(location, name));
      if (createHash("sha256").update(bytes).digest("hex") !== provenance.files[name]) throw new Error("Audio model resource is damaged.");
      if (name.startsWith("model/")) resources.set(name, bytes);
    }
    const runtime = path.join(location, "runtime");
    const ort = await import(pathToFileURL(path.join(runtime, "ort.wasm.min.mjs")).href) as Ort;
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.proxy = false;
    ort.env.wasm.wasmPaths = pathToFileURL(runtime + path.sep).href;
    const session = await ort.InferenceSession.create(resources.get("model/yamnet.onnx")!, {
      executionProviders: ["wasm"], externalData: [{ path: "yamnet.data", data: resources.get("model/yamnet.data")! }],
    });
    // Keep concurrent analyses from invoking a single WASM session at once. Each
    // caller still streams with backpressure and observes its own cancellation.
    let pending: Promise<unknown> = Promise.resolve();
    return { classify(features: Float32Array, signal?: AbortSignal) {
      const operation = pending.then(async () => {
        signal?.throwIfAborted();
        if (features.length !== 96 * 64 || features.some(value => !Number.isFinite(value))) throw new Error("Invalid sound-model input.");
        const input = new ort.Tensor("float32", features, [1, 1, 96, 64]);
        let outputs: Record<string, Tensor> | undefined;
        try {
          outputs = await session.run({ audio: input });
          signal?.throwIfAborted();
          return eventScores(outputs.class_scores.data);
        } finally {
          input.dispose();
          if (outputs) for (const output of Object.values(outputs)) output.dispose();
        }
      });
      pending = operation.catch(() => undefined);
      return operation;
    } };
  })();
  cachedModel = { directory: location, promise };
  try { return await promise; } catch {
    if (cachedModel?.promise === promise) cachedModel = undefined;
    throw new AudioEventsUnavailableError(unavailable);
  }
}

// Decode raw audio separately from the optional rumble filter used by the
// existing energy/beat pass. Model estimates therefore mean the same thing when
// the user switches a presentation option. No audio or model request goes online.
export async function measureAudioEvents(binary: string, source: string, signal?: AbortSignal,
  modelOverride?: AudioEventModel): Promise<EventBin[]> {
  signal?.throwIfAborted();
  const model = modelOverride ?? await loadAudioEventModel();
  signal?.throwIfAborted();
  const decoder = spawn(binary, ["-v", "error", "-nostdin", "-i", source, "-map", "0:a:0", "-vn",
    "-ac", "1", "-ar", String(EVENT_SAMPLE_RATE), "-f", "f32le", "pipe:1"], { windowsHide: true, signal });
  let stderr = "";
  decoder.stderr.on("data", data => { stderr = (stderr + data.toString()).slice(-2000); });
  const complete = new Promise<void>((resolve, reject) => {
    decoder.on("error", reject);
    decoder.on("close", code => code === 0 ? resolve() : reject(new Error(stderr || "Sound analysis could not finish.")));
  });
  // Attach a handler immediately, including when spawn fails before stdout is read.
  void complete.catch(() => undefined);
  const features = new AudioEventFeatures(), bins = new AudioEventBins();
  let remainder = Buffer.alloc(0);
  try {
    for await (const data of decoder.stdout) {
      signal?.throwIfAborted();
      const chunk = Buffer.concat([remainder, data as Buffer]), limit = chunk.length - chunk.length % 4;
      for (let offset = 0; offset < limit; offset += 4096 * 4) {
        const length = Math.min(4096, (limit - offset) / 4);
        const samples = Float32Array.from({ length }, (_, i) => chunk.readFloatLE(offset + i * 4));
        for (const patch of features.push(samples)) {
          bins.add(patch.start, patch.end, await model.classify(patch.features, signal));
        }
      }
      remainder = Buffer.from(chunk.subarray(limit));
    }
    await complete;
    signal?.throwIfAborted();
    if (remainder.length) throw new Error("Incomplete decoded sound sample.");
    for (const patch of features.finish()) bins.add(patch.start, patch.end, await model.classify(patch.features, signal));
    return bins.finish(features.sampleCount / EVENT_SAMPLE_RATE);
  } finally {
    if (decoder.exitCode === null) decoder.kill();
    await complete.catch(() => undefined);
  }
}
