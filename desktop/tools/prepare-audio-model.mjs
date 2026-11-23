import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { gunzipSync, inflateRawSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const modelSource = {
  url: "https://qaihub-public-assets.s3.us-west-2.amazonaws.com/qai-hub-models/models/yamnet/releases/v0.59.0/yamnet-onnx-float.zip",
  sha256: "bda628207418bc59b6a371aef6180b53367707eaf7b8b8a7c683417000d1eea4",
  release: "Qualcomm AI Hub Models v0.59.0", license: "MIT (YAMNet); BSD-3-Clause (export code)",
};
const runtimeSource = {
  url: "https://registry.npmjs.org/onnxruntime-web/-/onnxruntime-web-1.23.2.tgz",
  sha256: "0b8707d7efab9a2bea63564d66cad79e897cfd0bd627e5ae000488ffc1c45c7d",
  version: "1.23.2", license: "MIT",
};
const modelFiles = {
  "yamnet.onnx": "970ea63f4dc1aa33c86ef7d61d854319fdfe6bdd078f5b3d674ee1db5dd96471",
  "yamnet.data": "1d6dff488da4712190e10f1c841252aa58011381132d0126dcd5ee56a4e7ed31",
  "labels.txt": "8e1267a120c1932b7273c0d0e0c5529edbb9a35512b437b1c8982baa59047051",
  "metadata.json": "ee4cc52a90680e5f1d9b0bf8c8a74fe3c939aee97fd3b468efe88d57e941649b",
};
const runtimeFiles = ["ort.wasm.min.mjs", "ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.wasm"];
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const option = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);

async function archive(source, filename, override) {
  const location = override ?? path.join(desktop, ".model-cache", filename);
  let bytes;
  try { bytes = await readFile(location); } catch (error) {
    if (override || error.code !== "ENOENT") throw error;
    const response = await fetch(source.url, { signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error(`Cannot prepare local sound model (${response.status}).`);
    bytes = Buffer.from(await response.arrayBuffer());
    if (hash(bytes) !== source.sha256) throw new Error("Downloaded audio resource checksum does not match.");
    await mkdir(path.dirname(location), { recursive: true });
    await writeFile(location, bytes);
  }
  if (hash(bytes) !== source.sha256) throw new Error(`Audio resource checksum does not match: ${filename}`);
  return bytes;
}

// Extract only named regular entries, never archive paths or symlinks. The
// complete archives are authenticated before this small built-in extractor runs.
function zipEntries(bytes, wanted) {
  let end = bytes.length - 22;
  while (end >= Math.max(0, bytes.length - 65557) && bytes.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0 || bytes.readUInt32LE(end) !== 0x06054b50) throw new Error("Invalid model ZIP.");
  let cursor = bytes.readUInt32LE(end + 16);
  const found = new Map();
  for (let i = 0; i < bytes.readUInt16LE(end + 10); i++) {
    if (bytes.readUInt32LE(cursor) !== 0x02014b50) throw new Error("Invalid model ZIP directory.");
    const length = bytes.readUInt16LE(cursor + 28), extra = bytes.readUInt16LE(cursor + 30), comment = bytes.readUInt16LE(cursor + 32);
    const name = bytes.toString("utf8", cursor + 46, cursor + 46 + length);
    if (wanted.has(name)) {
      const local = bytes.readUInt32LE(cursor + 42), method = bytes.readUInt16LE(cursor + 10);
      if (bytes.readUInt32LE(local) !== 0x04034b50 || (bytes.readUInt16LE(cursor + 8) & 1)) throw new Error("Unsupported model ZIP entry.");
      const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
      const compressed = bytes.subarray(start, start + bytes.readUInt32LE(cursor + 20));
      const data = method === 8 ? inflateRawSync(compressed) : method === 0 ? compressed : undefined;
      if (!data || data.length !== bytes.readUInt32LE(cursor + 24)) throw new Error("Invalid model ZIP data.");
      found.set(name, data);
    }
    cursor += 46 + length + extra + comment;
  }
  return found;
}
function tarEntries(compressed, wanted) {
  const bytes = gunzipSync(compressed), found = new Map();
  for (let cursor = 0; cursor + 512 <= bytes.length;) {
    const name = bytes.toString("utf8", cursor, cursor + 100).split("\0")[0];
    if (!name) break;
    const size = parseInt(bytes.toString("ascii", cursor + 124, cursor + 136).replace(/\0/g, "").trim(), 8);
    if (!Number.isSafeInteger(size) || size < 0 || cursor + 512 + size > bytes.length) throw new Error("Invalid runtime TAR.");
    const type = bytes[cursor + 156];
    if (wanted.has(name)) {
      if (type !== 0 && type !== 48) throw new Error("Runtime entry is not a regular file.");
      found.set(name, bytes.subarray(cursor + 512, cursor + 512 + size));
    }
    cursor += 512 + Math.ceil(size / 512) * 512;
  }
  return found;
}

export async function verifyAudioResources(directory = path.join(desktop, "resources", "audio-events")) {
  const manifest = JSON.parse(await readFile(path.join(directory, "provenance.json"), "utf8"));
  if (manifest.version !== 1 || manifest.model.sha256 !== modelSource.sha256 || manifest.runtime.sha256 !== runtimeSource.sha256)
    throw new Error("The bundled local sound model has an unexpected version.");
  const required = [...Object.keys(modelFiles).map(name => `model/${name}`), ...runtimeFiles.map(name => `runtime/${name}`),
    "notices/YAMNet-source-MIT.txt", "notices/Qualcomm-export-BSD3.txt", "notices/ONNX-Runtime-MIT.txt", "notices/ONNX-Runtime-ThirdPartyNotices.txt"];
  for (const name of required) {
    if (!manifest.files[name] || hash(await readFile(path.join(directory, name))) !== manifest.files[name])
      throw new Error(`The bundled local sound model failed integrity checking: ${name}`);
  }
  return manifest;
}

export async function prepareAudioModel() {
  const destination = path.join(desktop, "resources", "audio-events");
  try { await verifyAudioResources(destination); console.log("Local sound model resources verified."); return; } catch { /* prepare the pinned assets */ }
  const model = await archive(modelSource, "yamnet-v0.59.0.zip", option("model-archive"));
  const runtime = await archive(runtimeSource, "onnxruntime-web-1.23.2.tgz", option("runtime-archive"));
  const modelEntries = zipEntries(model, new Set(Object.keys(modelFiles).map(name => `yamnet-onnx-float/${name}`)));
  const runtimeEntries = tarEntries(runtime, new Set(runtimeFiles.map(name => `package/dist/${name}`)));
  const files = {};
  async function output(name, bytes) {
    if (!bytes) throw new Error(`Pinned audio resource is missing: ${name}`);
    await mkdir(path.dirname(path.join(destination, name)), { recursive: true });
    await writeFile(path.join(destination, name), bytes); files[name] = hash(bytes);
  }
  for (const [name, checksum] of Object.entries(modelFiles)) {
    const bytes = modelEntries.get(`yamnet-onnx-float/${name}`);
    if (!bytes || hash(bytes) !== checksum) throw new Error(`Model file integrity check failed: ${name}`);
    await output(`model/${name}`, bytes);
  }
  for (const name of runtimeFiles) await output(`runtime/${name}`, runtimeEntries.get(`package/dist/${name}`));
  const notices = path.join(desktop, "tools", "audio-model-notices");
  for (const name of await readdir(notices)) await output(`notices/${name}`, await readFile(path.join(notices, name)));
  await writeFile(path.join(destination, "provenance.json"), JSON.stringify({ version: 1, model: modelSource, runtime: runtimeSource,
    sources: ["https://github.com/qualcomm/ai-hub-models/blob/v0.59.0/qai_hub_models/models/yamnet/manifest.yaml",
      "https://github.com/w-hc/torch_audioset/tree/e8852c5", "https://onnxruntime.ai/docs/tutorials/web/deploy.html"],
    input: "Raw mono 16000 Hz PCM; centered periodic Hann400/FFT512/hop160; magnitude HTK64 log-mel; 96 frames/hop48",
    output: "521 independent sigmoid scores, family maxima; estimates do not identify the singer", files }, null, 2));
  await verifyAudioResources(destination);
  console.log("Local sound model and CPU WebAssembly runtime prepared; no media was uploaded.");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await prepareAudioModel();
