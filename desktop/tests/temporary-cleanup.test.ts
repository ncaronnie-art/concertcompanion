import test from "node:test";
import assert from "node:assert/strict";
import { withTemporaryCleanup } from "../electron/temporary-cleanup.ts";

test("a cleanup permission error cannot hide a successful export", async () => {
  const result = await withTemporaryCleanup("temporary", async () => "finished.mp4", async () => { throw new Error("permission denied"); });
  assert.equal(result.value, "finished.mp4");
  assert.equal(result.cleanupWarning, true);
});

test("a cleanup permission error cannot hide the original render failure", async () => {
  const original = new Error("underlying render failed");
  await assert.rejects(withTemporaryCleanup("temporary", async () => { throw original; }, async () => { throw new Error("permission denied"); }), (error) => error === original);
});
