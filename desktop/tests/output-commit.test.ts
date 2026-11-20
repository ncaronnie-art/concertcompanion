import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { commitOutput } from "../electron/output-commit.ts";

test("a verified render is copied and committed without exposing a partial MP4", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "compass-output-"));
  try {
    const render = path.join(root, "render.mp4"), destination = path.join(root, "chosen.mp4");
    await writeFile(render, "verified video");
    let checked = false;
    await commitOutput(render, destination, async () => {
      checked = true;
      assert.deepEqual((await readdir(root)).filter((name) => name.endsWith(".mp4")), ["render.mp4"]);
    });
    assert.equal(checked, true);
    assert.equal(await readFile(render, "utf8"), "verified video");
    assert.equal(await readFile(destination, "utf8"), "verified video");
    assert.ok(!(await readdir(root)).some((name) => name.endsWith(".partial")));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("failed destination check leaves an existing finished video intact", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "compass-output-"));
  try {
    const render = path.join(root, "render.mp4"), destination = path.join(root, "chosen.mp4");
    await writeFile(render, "new video"); await writeFile(destination, "old video");
    await assert.rejects(commitOutput(render, destination, async () => { throw new Error("unsafe destination"); }), /unsafe destination/);
    assert.equal(await readFile(destination, "utf8"), "old video");
    assert.ok(!(await readdir(root)).some((name) => name.endsWith(".partial")));
  } finally { await rm(root, { recursive: true, force: true }); }
});
