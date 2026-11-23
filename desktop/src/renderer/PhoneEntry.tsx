import { useEffect, useState } from "react";
import { App } from "./App";
import { pairPhone, phoneKey, verifyPhoneConnection, remotePhoneTest } from "./browser-bridge";

export function PhoneEntry() {
  const remote = remotePhoneTest();
  const [ready, setReady] = useState(false), [code, setCode] = useState("");
  const [busy, setBusy] = useState(false), [message, setMessage] = useState("Enter the six-digit code shown on your computer.");
  async function reconnect() {
    setBusy(true); setMessage("Opening your Vibe Capsule test…");
    try { await verifyPhoneConnection(); setReady(true); }
    catch (error) { setMessage(remote ? (error instanceof Error && error.message.includes("too long") ? error.message : "This test link has expired or is unavailable. Check your connection, or open the latest private test link.") : "Reconnect with the code shown on your computer."); }
    finally { setBusy(false); }
  }
  useEffect(() => { if (phoneKey()) void reconnect(); }, []);
  if (ready) return <App />;
  if (remote) return <main className="phone-connect"><p className="eyebrow">VIBE CAPSULE · PRIVATE PHONE TEST</p><h1>Your personal test link</h1><p role="status">{phoneKey() ? message === "Enter the six-digit code shown on your computer." ? "Opening your Vibe Capsule test…" : message : "Open the complete private test link you received to enter this test."}</p>{phoneKey() && <button className="primary" disabled={busy} onClick={() => void reconnect()}>{busy ? "Connecting…" : "Try again"}</button>}<p className="helper">Keep your test link private. Upload and processing details will appear before you choose videos.</p></main>;
  return <main className="phone-connect"><p className="eyebrow">VIBE CAPSULE · PHONE PREVIEW</p><h1>Your night, in your hands.</h1>
    <p>Choose videos on your phone. Your Windows computer makes the edit.</p>
    <form onSubmit={async (event) => { event.preventDefault(); setBusy(true); try { await pairPhone(code); setReady(true); } catch (error) { setMessage(error instanceof Error ? error.message : "Could not connect. Try again."); } finally { setBusy(false); } }}>
      <label>Connection code<input aria-label="Connection code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} pattern="[0-9]{6}" required value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))} /></label>
      <button className="primary" disabled={busy}>{busy ? "Connecting…" : "Connect to my computer"}</button>
      <p role="status">{message}</p>
    </form><p className="helper">Keep both devices on the same Wi-Fi and the computer awake. Keep Safari open while videos upload.</p>
  </main>;
}
