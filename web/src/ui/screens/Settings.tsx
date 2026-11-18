import { useState } from "react";
import { useAirlock, useSession } from "../../app/context";
import type { AnswerPreference } from "../../engine/answer";
import type { DialPreset } from "../../engine/types";
import { OnDeviceStatus } from "./OnDeviceStatus";
import howItWorks from "../../../../docs/images/how-it-works.svg?url";

export function SettingsScreen() {
  const s = useSession();
  const { prefs } = useAirlock();
  const [confirm, setConfirm] = useState(false);
  const dials: DialPreset[] = ["strict", "balanced", "open"];
  const prefsList: { id: AnswerPreference; label: string }[] = [{ id: "auto", label: "Automatic" }, { id: "phoneOnly", label: "Only on this device" }, { id: "best", label: "Best answer (Gemini)" }];
  return (
    <div className="stack">
      <h1>Settings</h1>
      <OnDeviceStatus />
      <div className="card stack enter" style={{ gap: 12 }}>
        <div><h2>Privacy dial</h2><div className="segmented" role="group" aria-label="Privacy dial">{dials.map((d) => <button key={d} aria-pressed={prefs.dial === d} onClick={() => s.setPrefs({ dial: d })}>{d[0]!.toUpperCase() + d.slice(1)}</button>)}</div></div>
        <div><h2>Where answers come from</h2><div className="segmented" role="group" aria-label="Answer preference">{prefsList.map((p) => <button key={p.id} aria-pressed={prefs.preference === p.id} onClick={() => s.setPrefs({ preference: p.id })}>{p.label}</button>)}</div>
          <p className="small">Automatic answers quick tasks on this device and sends harder ones, sealed, to Gemini.</p></div>
      </div>
      {s.services.sync && (
        <div className="card row" style={{ gap: 14, alignItems: "flex-start", flexWrap: "nowrap" }}>
          <div style={{ flex: 1 }}>
            <h2>Back up sealed history</h2>
            <p className="small" style={{ margin: 0 }}>Only the sealed version of requests that already went to Gemini is backed up — placeholders and receipts, exactly what Gemini saw. Real names, your original words and on-device answers never leave this device.</p>
          </div>
          <button className="switch" role="switch" aria-checked={prefs.backup} aria-label="Back up sealed history" onClick={() => s.setPrefs({ backup: !prefs.backup })} />
        </div>
      )}
      <details className="card about-diagram">
        <summary><h2 style={{ display: "inline", margin: 0 }}>How Airlock works</h2></summary>
        <img src={howItWorks} alt="On your device: detect private details, seal them into placeholders, red-team the draft, then a deterministic egress gate. Only sealed text reaches Gemini. The answer comes back with placeholders, your device restores the real details, and a hash-chained receipt records exactly what left." />
      </details>
      <div className="card stack" style={{ gap: 8 }}>
        <h2>What Airlock does and doesn’t do</h2>
        <p className="small">Airlock hides who you are, not what happened. It finds names, places, contact details and IDs on your device and replaces them before anything is sent. Detection isn’t perfect, so you always see exactly what leaves. Airlock helps you understand and prepare; it doesn’t give legal, medical or financial advice.</p>
        <p className="small">Raw text you paste is kept encrypted in this browser for {s.services.config.rawPurgeDays} days, then deleted. Mode: {s.services.mode === "live" ? "live (Firebase AI Logic)" : s.services.mode === "demo" ? "demo (scripted)" : "rules only (no Firebase config)"}.</p>
      </div>
      <div className="card stack" style={{ gap: 10 }}>
        <h2>Delete everything</h2>
        <p className="small">Removes your Vault, conversations, receipts and the encryption key from this browser.</p>
        {confirm ? (
          <div className="row"><button className="btn btn-danger" onClick={() => void s.deleteEverything()}>Yes, delete everything</button><button className="btn btn-ghost" onClick={() => setConfirm(false)}>Cancel</button></div>
        ) : <div><button className="btn btn-danger" onClick={() => setConfirm(true)}>Delete everything…</button></div>}
      </div>
    </div>
  );
}
