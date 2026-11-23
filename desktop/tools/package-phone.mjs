import { cp, access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (!process.argv[2]) throw new Error("Choose the phone preview output folder.");
const destination = path.resolve(process.argv[2]);
await access(path.join(desktop, "dist", "index.html"));
await mkdir(destination, { recursive: true });
await build({ entryPoints: [path.join(desktop, "mobile", "cli.ts")], outfile: path.join(destination, "host.cjs"),
  bundle: true, platform: "node", format: "cjs", target: "node22", logLevel: "warning" });
await cp(path.join(desktop, "dist"), path.join(destination, "web"), { recursive: true, force: true });
for (const dependency of ["ffmpeg-static", "ffprobe-static"]) {
  const folder = path.dirname(require.resolve(`${dependency}/package.json`));
  await cp(folder, path.join(destination, "vendor", dependency), { recursive: true, dereference: true, force: true });
}
const ffmpegSource = require("ffmpeg-static");
const ffprobeSource = require("ffprobe-static").path;
const ffmpegFolder = path.dirname(require.resolve("ffmpeg-static/package.json"));
const ffprobeFolder = path.dirname(require.resolve("ffprobe-static/package.json"));
await writeFile(path.join(destination, "runtime.json"), JSON.stringify({
  nodePath: process.execPath,
  runtimeMode: "installed-on-this-computer",
  ffmpegPath: path.join("vendor", "ffmpeg-static", path.relative(ffmpegFolder, ffmpegSource)),
  ffprobePath: path.join("vendor", "ffprobe-static", path.relative(ffprobeFolder, ffprobeSource)),
}, null, 2));
await cp(path.join(desktop, "tools", "phone-launcher"), destination, { recursive: true, force: true });
const version = JSON.parse(await readFile(path.join(desktop, "package.json"), "utf8")).version;
await writeFile(path.join(destination, "BUILD.json"), JSON.stringify({ product: "Vibe Capsule Phone Preview", version,
  builtAt: new Date().toISOString(), runtime: process.version, runtimeMode: "installed-on-this-computer" }, null, 2));
await writeFile(path.join(destination, "Read me.txt"), "Vibe Capsule Phone Preview\r\n\r\nDouble-click Start Phone Preview, then follow the page that opens.\r\nKeep the PC awake and your iPhone on the same trusted Wi-Fi.\r\nKeep Safari open while videos upload.\r\nUse Stop Phone Preview when finished.\r\nUploaded copies and saved projects remain in this folder's data directory.\r\n\r\nThis local preview uses the Node runtime already installed with Codex on this computer.\r\nIt is not a portable installer for another PC. No public server or account is required.\r\n");
console.log(`Phone preview packaged: ${destination}`);
