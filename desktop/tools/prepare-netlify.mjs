import { mkdir, copyFile, chmod, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const assets = path.resolve("netlify/server/assets");
await mkdir(assets, { recursive: true });
const binaries = { ffmpeg: require("ffmpeg-static"), ffprobe: require("ffprobe-static").path };
for (const [name, source] of Object.entries(binaries)) {
  if (!source || !(await stat(source)).isFile()) throw new Error(`${name} is missing from the host build.`);
  const target = path.join(assets, name);
  await copyFile(source, target);
  await chmod(target, 0o755);
}
console.log(`Prepared ${process.platform}/${process.arch} video tools for the private phone test.`);
