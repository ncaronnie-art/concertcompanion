import { getContext, onShutdown, type Config } from "@netlify/server";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createMobileServer } from "../../mobile/server.js";
import { netlifyStorage } from "./storage.js";
import { resolveRuntimeConfig } from "./runtime-config.js";

export const config: Config = { size: "small", region: "cmh", scale: { min: 0, max: 1 }, includedFiles: ["assets/**"] };

// The initial deployment can be inspected safely before its private key is set.
// Never generate a public/default credential or accept an origin from a request.
async function start() {
  const settings = resolveRuntimeConfig(process.env);
  if (!settings.ok) {
    console.warn("Vibe Capsule setup is incomplete:", settings.issues.join(", "));
    return createServer((_request, response) => {
      response.writeHead(503, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      response.end(JSON.stringify({ error: "The private phone test is being prepared. Please use your new launch link when it is ready.", setupIssues: settings.issues }));
    });
  }
  const { token, origin, storageNamespace } = settings;
  const scratch = path.join(tmpdir(), "vibe-phone-test");
  await mkdir(scratch, { recursive: true });
  const assets = path.join(import.meta.dirname, "assets");
  const escapedFonts = path.join(assets, "fonts").replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const fontConfig = path.join(scratch, "fonts.conf");
  await writeFile(fontConfig, `<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig><dir>${escapedFonts}</dir><cachedir>${scratch}/font-cache</cachedir><alias><family>Segoe UI</family><prefer><family>Barlow</family></prefer></alias></fontconfig>`);
  process.env.FONTCONFIG_FILE = fontConfig;
  const app = await createMobileServer({
    dataDirectory: path.join(scratch, "data"), staticDirectory: path.join(assets, "empty"),
    ffmpegBinary: path.join(assets, "ffmpeg"), ffprobeBinary: path.join(assets, "ffprobe"),
    token, remoteOrigin: origin, host: "0.0.0.0", port: Number(process.env.PORT || 3000),
    cloud: { storage: netlifyStorage(undefined, storageNamespace), keepAlive: (work) => getContext().waitUntil(work) },
  });
  onShutdown(async ({ drained }) => { await drained; await app.close(); });
  return app.server;
}

export default await start();
