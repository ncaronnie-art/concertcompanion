import { networkInterfaces } from "node:os";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createMobileServer } from "./server.js";

const html = (value: string) => value.replace(/[&<>\"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character]!);

export function localPhoneAddresses(port: number): string[] {
  const candidates: { address: string; rank: number }[] = [];
  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    for (const item of addresses ?? []) {
      if (item.internal || item.family !== "IPv4") continue;
      const [a, b] = item.address.split(".").map(Number);
      if (!(a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31))) continue;
      const rank = /wi-?fi|wireless/i.test(name) ? 0 : /virtual|vEthernet|VPN|WSL|docker/i.test(name) ? 2 : 1;
      candidates.push({ address: `http://${item.address}:${port}`, rank });
    }
  }
  return [...new Set(candidates.sort((a, b) => a.rank - b.rank).map((item) => item.address))];
}

export function connectionPage(addresses: string[], pairingCode: string): string {
  const links = addresses.length ? addresses.map((address, index) => `<li><small>${index === 0 ? "Try this address first" : "Another address on this PC"}</small><a href="${html(address)}">${html(address)}</a></li>`).join("") :
    "<li>Connect this PC to your trusted Wi-Fi network, then stop and reopen Phone Preview to get its address.</li>";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Vibe Capsule · Connect your iPhone</title><style>
  :root{color-scheme:dark;font-family:system-ui,sans-serif;background:#0c0912;color:#f6effa}*{box-sizing:border-box}body{margin:0;padding:32px 20px}main{max-width:760px;margin:0 auto}h1{font-size:clamp(2rem,5vw,3.3rem);letter-spacing:-.04em;line-height:1.05}p,li{line-height:1.55;color:#d0c5d9}.eyebrow{color:#d8a5f5;font-size:.8rem;font-weight:800;letter-spacing:.14em}.card{padding:24px;border:1px solid #614172;border-radius:20px;background:linear-gradient(135deg,#271633,#15101e);margin:20px 0}ul{list-style:none;padding:0;margin:0}li+li{margin-top:16px}small{display:block;color:#c6afcf}a{color:#f3d5ff;font-size:clamp(1.2rem,4vw,1.8rem);font-weight:750;overflow-wrap:anywhere}.code{font-size:3rem;letter-spacing:.23em;font-weight:800;color:white;margin:8px 0}.note{font-size:.9rem;color:#bdb0c7}strong{color:#fff}h2{margin-top:0;font-size:1.25rem}</style></head><body><main>
  <p class="eyebrow">VIBE CAPSULE · PHONE PREVIEW</p><h1>Your iPhone is the editor.<br>Your PC does the processing.</h1>
  <p>Keep this computer awake and connect your iPhone to the same trusted Wi-Fi network.</p>
  <section class="card"><h2>1. Open this address in Safari on your iPhone</h2><ul>${links}</ul></section>
  <section class="card"><h2>2. Enter this connection code</h2><p class="code">${html(pairingCode)}</p><p>Use it on the phone when Vibe Capsule asks to connect. The code changes when Phone Preview restarts.</p></section>
  <p><strong>3. Choose your videos, describe the edit, and make your first cut.</strong> Keep Safari open while videos upload. When the MP4 is ready, tap its save link on your phone.</p>
  <p class="note">Your videos are processed on this PC. This preview is for your trusted local network. It is not an internet link. If Safari cannot connect, check that both devices use the same Wi-Fi and that Windows allows this app on your private network; guest Wi-Fi may block devices from connecting.</p>
  <p class="note">Use <strong>Stop Phone Preview</strong> in the app folder when you are finished. Stopping the host keeps uploaded copies and saved projects on this computer.</p>
  </main></body></html>`;
}

async function main() {
  const args = process.argv.slice(2);
  const value = (flag: string) => { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1]; };
  const root = path.resolve(value("--root") ?? path.dirname(process.argv[1]));
  const remoteOrigin = value("--remote-origin");
  const dataDirectory = path.resolve(value("--data") ?? path.join(root, remoteOrigin ? "remote-data" : "data"));
  const readyPath = path.join(dataDirectory, "ready.json");
  const connectionPath = path.join(dataDirectory, "Connect-your-iPhone.html");
  const runtime = JSON.parse(await readFile(path.join(root, "runtime.json"), "utf8"));
  const port = Number(value("--port") ?? 4317);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Choose a valid phone preview port.");
  await access(path.join(root, "web", "index.html"));
  let instance: Awaited<ReturnType<typeof createMobileServer>>;
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await instance.close();
    try { const saved = JSON.parse(await readFile(readyPath, "utf8")); if (saved.pid === process.pid) await rm(readyPath, { force: true }); } catch { /* Stale readiness is checked by the launcher. */ }
    process.exit(0);
  };
  instance = await createMobileServer({ dataDirectory, staticDirectory: path.join(root, "web"),
    ffmpegBinary: path.resolve(root, runtime.ffmpegPath), ffprobeBinary: path.resolve(root, runtime.ffprobePath),
    host: value("--host") ?? (remoteOrigin ? "127.0.0.1" : "0.0.0.0"), port, onStop: stop,
    ...(remoteOrigin ? { remoteOrigin, token: randomBytes(32).toString("hex") } : {}) });
  const listening = await instance.listen();
  const addresses = remoteOrigin ? [remoteOrigin] : localPhoneAddresses(listening.port);
  await mkdir(dataDirectory, { recursive: true });
  if (remoteOrigin) await writeFile(path.join(dataDirectory, "access-key"), instance.token, { mode: 0o600 });
  const remotePage = remoteOrigin ? `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Vibe Capsule · Private phone test</title><style>body{font:18px/1.6 system-ui;background:#100b17;color:#f7efff;max-width:680px;margin:60px auto;padding:24px}a{display:inline-block;background:#8543bd;color:white;border-radius:12px;padding:16px 24px;text-decoration:none}small{color:#d0c1da}</style></head><body><p>VIBE CAPSULE · PRIVATE PHONE TEST</p><h1>Your personal test link</h1><p><a href="${html(remoteOrigin)}/#key=${encodeURIComponent(instance.token)}">Open my phone test</a></p><p>Keep this link private: it grants access to this test session. Restarting the host creates a new link.</p><p>Your computer still processes the edit. Test-video traffic passes through the approved relay service. Keep the computer awake and Safari open during uploads.</p><p><strong>Start with two short videos.</strong> This is a limited test, with the relay account’s transfer allowance; long recording transfers have not been verified.</p><small>The phone test needs its approved relay running. This page alone does not create an internet connection.</small></body></html>` : null;
  await writeFile(connectionPath, remotePage ?? connectionPage(addresses, instance.pairingCode), "utf8");
  const ready = { pid: process.pid, port: listening.port, host: listening.host, connectionPage: connectionPath,
    connectionMode: remoteOrigin ? "remote" : "local",
    addresses, startedAt: new Date().toISOString(), processStartedAt: new Date(Date.now() - process.uptime() * 1000).toISOString() };
  const temporaryReady = `${readyPath}.${process.pid}.tmp`;
  await writeFile(temporaryReady, JSON.stringify(ready, null, 2), "utf8");
  await rename(temporaryReady, readyPath);
  console.log(`Vibe Capsule Phone Preview ready on port ${listening.port}.`);
  process.on("SIGINT", () => { void stop(); });
  process.on("SIGTERM", () => { void stop(); });
}

void main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); });
