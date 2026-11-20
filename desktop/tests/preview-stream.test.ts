import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { previewResponse } from "../electron/preview-stream.ts";

test("preview serves complete files and byte ranges for seeking", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "compass-range-"));
  try {
    const file = path.join(root, "preview.webm"); await writeFile(file, "0123456789");
    const full = await previewResponse(file, new Request("https://preview/"));
    assert.equal(full.status, 200); assert.equal(full.headers.get("accept-ranges"), "bytes"); assert.equal(await full.text(), "0123456789");
    const partial = await previewResponse(file, new Request("https://preview/", { headers: { Range: "bytes=3-6" } }));
    assert.equal(partial.status, 206); assert.equal(partial.headers.get("content-range"), "bytes 3-6/10"); assert.equal(await partial.text(), "3456");
    const suffix = await previewResponse(file, new Request("https://preview/", { headers: { Range: "bytes=-3" } }));
    assert.equal(await suffix.text(), "789");
    const bad = await previewResponse(file, new Request("https://preview/", { headers: { Range: "bytes=15-" } }));
    assert.equal(bad.status, 416);
    const mp4 = path.join(root, "draft.mp4"); await writeFile(mp4, "video");
    const draft = await previewResponse(mp4, new Request("https://draft/"));
    assert.equal(draft.headers.get("content-type"), "video/mp4");
    assert.equal(await draft.text(), "video");
  } finally { await rm(root, { recursive: true, force: true }); }
});
