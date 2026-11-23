import { getStore, type Store } from "@netlify/blobs";
import { createWriteStream, openAsBlob } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { pipeline } from "node:stream/promises";
import type { CloudStorage } from "../../mobile/cloud-storage.js";

// The store is private: only authenticated server routes return media to a browser.
// Strong reads keep project saves and the quota registry consistent across restarts.
export function netlifyStorage(store: Store = getStore({ name: "vibe-phone-test-v1", consistency: "strong" })): CloudStorage {
  return {
    readJson: (key) => store.get(key, { type: "json", consistency: "strong" }),
    async writeJson(key, value) { await store.setJSON(key, value); },
    async downloadFile(key, destination) {
      const stream = await store.get(key, { type: "stream", consistency: "strong" });
      if (!stream) return false;
      await mkdir(dirname(destination), { recursive: true });
      const temporary = `${destination}.${randomUUID()}.download`;
      try {
        await pipeline(Readable.fromWeb(stream as NodeReadableStream<Uint8Array>), createWriteStream(temporary, { flags: "wx" }));
        await rename(temporary, destination);
        return true;
      } finally { await rm(temporary, { force: true }).catch(() => {}); }
    },
    async uploadFile(key, source, contentType) {
      // A file-backed Blob streams to storage instead of buffering video in RAM.
      await store.set(key, await openAsBlob(source, { type: contentType }), { metadata: { contentType } });
    },
    async delete(key) { await store.delete(key); },
  };
}
