import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import type { Store } from "@netlify/blobs";
import { netlifyStorage } from "../netlify/server/storage.ts";

const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");

test("Netlify adapter streams file-backed uploads and downloads and requests strongly consistent JSON", async () => {
  const folder = await mkdtemp(path.join(tmpdir(), "vibe-blob-adapter-"));
  const records = new Map<string, unknown>(), files = new Map<string, Buffer>();
  let readChunks = 0;
  const mock = {
    async get(key: string, options: { type: string; consistency: string }) {
      assert.equal(options.consistency, "strong");
      if (options.type === "json") return records.get(key) ?? null;
      assert.equal(options.type, "stream");
      const bytes = files.get(key); if (!bytes) return null;
      let offset = 0;
      return new ReadableStream<Uint8Array>({ pull(controller) {
        if (offset >= bytes.length) return controller.close();
        const next = bytes.subarray(offset, offset + 16384); offset += next.length; readChunks++; controller.enqueue(next);
      } });
    },
    async setJSON(key: string, value: unknown) { records.set(key, structuredClone(value)); },
    async set(key: string, value: Blob, options: { metadata: { contentType: string } }) {
      assert.ok(value instanceof Blob, "upload passes a file-backed Blob, not an in-memory Buffer");
      assert.equal(options.metadata.contentType, "video/mp4"); assert.equal(value.type, "video/mp4");
      const reader = value.stream().getReader(), pieces: Buffer[] = [];
      while (true) { const { value: piece, done } = await reader.read(); if (done) break; pieces.push(Buffer.from(piece)); }
      files.set(key, Buffer.concat(pieces));
    },
    async delete(key: string) { files.delete(key); records.delete(key); },
  } as unknown as Store;
  const adapter = netlifyStorage(mock);
  try {
    const input = Buffer.alloc(256 * 1024); for (let index = 0; index < input.length; index++) input[index] = index % 251;
    const source = path.join(folder, "source.mp4"), output = path.join(folder, "nested", "result.mp4"); await writeFile(source, input);
    await adapter.uploadFile("media/video", source, "video/mp4");
    assert.equal(await adapter.downloadFile("media/video", output), true); assert.ok(readChunks > 1);
    assert.equal(hash(await readFile(output)), hash(input));
    assert.deepEqual(await readdir(path.dirname(output)), ["result.mp4"], "successful download leaves no staging file");
    await adapter.writeJson("project", { locked: true, sections: [1, 2] });
    assert.deepEqual(await adapter.readJson("project"), { locked: true, sections: [1, 2] });
    assert.equal(await adapter.readJson("missing"), null);
    const absent = path.join(folder, "absent", "video.mp4");
    assert.equal(await adapter.downloadFile("missing", absent), false); assert.ok(!(await readdir(folder)).includes("absent"));
    await adapter.delete("media/video"); assert.equal(files.has("media/video"), false);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test("failed storage streams remove partial files and preserve an existing destination", async () => {
  const folder = await mkdtemp(path.join(tmpdir(), "vibe-blob-failure-"));
  const adapter = netlifyStorage({ async get() {
    let count = 0;
    return new ReadableStream<Uint8Array>({ pull(controller) {
      if (count++ === 0) controller.enqueue(Buffer.alloc(65536, 7));
      else controller.error(new Error("Synthetic remote stream interrupted"));
    } });
  } } as unknown as Store);
  try {
    const destination = path.join(folder, "existing.mp4"); await writeFile(destination, "existing working video");
    await assert.rejects(adapter.downloadFile("failed", destination), /Synthetic remote stream interrupted/);
    assert.equal(await readFile(destination, "utf8"), "existing working video");
    const absent = path.join(folder, "new.mp4");
    await assert.rejects(adapter.downloadFile("failed", absent), /Synthetic remote stream interrupted/);
    assert.deepEqual(await readdir(folder), ["existing.mp4"], "neither failed download leaks a staging or final partial file");
  } finally { await rm(folder, { recursive: true, force: true }); }
});
