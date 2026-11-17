import { useState } from "react";
import { useAirlock, useSession } from "../../app/context";
import type { DialPreset } from "../../engine/types";
import type { VaultEntry } from "../../engine/vault";
import { OnDeviceStatus } from "./OnDeviceStatus";
import { CATEGORY_ICON, IconArrow, IconCloud, IconDevice, IconPlus, Logo } from "../icons";
import type { CSSProperties } from "react";
import type { PrivacyCategory } from "../../engine/types";

/** Fictional details flow left → right through the airlock and come out as chips. Pure CSS motion. */
function HeroAnimation() {
  const lanes: { before: string; after: string; cat: PrivacyCategory; d: string }[] = [
    { before: "Raj Patel", after: "Person 1 · landlord", cat: "person", d: "0s" },
    { before: "14 Elm St, Apt 3B", after: "Place 1", cat: "location", d: "-2s" },
    { before: "312-555-0147", after: "Contact 1", cat: "contact", d: "-4s" },
  ];
  return (
    <div className="hero-anim" aria-hidden="true">
      <div className="gate"><Logo size={44} animated /></div>
      {lanes.map((l) => {
        const Icon = CATEGORY_ICON[l.cat];
        return (
          <div className="lane" key={l.before}>
            <span className="token" style={{ "--d": l.d } as CSSProperties}>
              <span className="before">{l.before}</span>
              <span className={`after chip ${l.cat}`} style={{ animationName: "swapB" }}><Icon /> {l.after}</span>
            </span>
          </div>
        );
      })}
      <span className="side l"><IconDevice size={14} /> Your device</span>
      <span className="side r">Gemini <IconCloud size={14} /></span>
    </div>
  );
}

const Dots = ({ step }: { step: number }) => <div className="dots" aria-label={`Step ${step + 1} of 3`}>{[0, 1, 2].map((i) => <span key={i} className={i === step ? "on" : ""} />)}</div>;

const DIALS: { id: DialPreset; title: string; line: string; level: number }[] = [
  { id: "strict", title: "Strict", line: "Hides more and always shows you what leaves. Best for very sensitive things.", level: 3 },
  { id: "balanced", title: "Balanced", line: "Hides names, places and numbers; keeps dates and amounts so answers stay useful.", level: 2 },
  { id: "open", title: "Open", line: "Hides names, contact details and IDs only.", level: 1 },
];

/** "Raj Patel" → ["Raj"]: people are usually written by first name. */
const firstNameAlias = (name: string): string[] => {
  const parts = name.trim().split(/\s+/);
  return parts.length > 1 && [...parts[0]!].length > 1 ? [parts[0]!] : [];
};

export function Onboarding() {
  const s = useSession();
  const { prefs } = useAirlock();
  const [step, setStep] = useState(0);
  const [me, setMe] = useState("");
  const [others, setOthers] = useState<{ name: string; role: string }[]>([{ name: "", role: "" }]);

  async function saveVault() {
    const entries: VaultEntry[] = [];
    if (me.trim()) entries.push({ id: crypto.randomUUID(), canonical: me.trim(), aliases: firstNameAlias(me), category: "person", roleHint: "me", isUser: true });
    for (const o of others) if (o.name.trim()) entries.push({ id: crypto.randomUUID(), canonical: o.name.trim(), aliases: firstNameAlias(o.name), category: "person", roleHint: o.role.trim() ? `my ${o.role.trim()}` : null, isUser: false });
    if (entries.length) await s.saveVault([...s.getState().vault, ...entries]);
    setStep(2);
  }

  return (
    <div className="main" style={{ margin: "0 auto", maxWidth: 640 }}>
      {step === 0 && (
        <div className="stack enter" key="s0">
          <div className="row"><Logo size={40} animated /><Dots step={0} /></div>
          <h1>AI is great. Oversharing isn’t.</h1>
          <p className="sub">Airlock lets you ask the smartest AI about private things, while the details that identify you stay on your device.</p>
          <HeroAnimation />
          <div className="card stack">
            <div><b>1. Your device reads it first.</b> Chrome’s built-in model finds names, places and numbers and seals them — on this computer.</div>
            <div><b>2. Gemini gets the problem, not the person.</b> Only the sealed version is sent, after a final check.</div>
            <div><b>3. The real names come back on your device.</b> Every request gets a receipt showing exactly what left.</div>
          </div>
          <p className="small">Airlock hides who you are, not what happened. Detection isn’t perfect, which is why you can review everything before it’s sent. Airlock helps you understand and prepare; it doesn’t give legal, medical or financial advice.</p>
          <div className="row"><button className="btn btn-primary" onClick={() => setStep(1)}><span className="row" style={{ gap: 8 }}>Get started <IconArrow size={16} /></span></button></div>
        </div>
      )}
      {step === 1 && (
        <div className="stack enter" key="s1">
          <Dots step={1} />
          <h1>Who should always be protected?</h1>
          <p className="sub">Add your name and the people you never want to share. Stored only in this browser, encrypted.</p>
          <div className="card stack">
            <label className="stack" style={{ gap: 6 }}>
              <span className="small">Your name</span>
              <input className="field" value={me} onChange={(e) => setMe(e.target.value)} placeholder="e.g. Maya Chen" autoComplete="name" />
            </label>
            {others.map((o, i) => (
              <div className="row" key={i}>
                <input className="field" style={{ flex: 2 }} value={o.name} placeholder="Someone else, e.g. Raj Patel" aria-label="Person's name"
                  onChange={(e) => setOthers(others.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
                <input className="field" style={{ flex: 1 }} value={o.role} placeholder="role, e.g. landlord" aria-label="Their role to you"
                  onChange={(e) => setOthers(others.map((x, j) => (j === i ? { ...x, role: e.target.value } : x)))} />
              </div>
            ))}
            <div><button className="btn btn-ghost" onClick={() => setOthers([...others, { name: "", role: "" }])}><span className="row" style={{ gap: 6 }}><IconPlus size={16} /> Add someone</span></button></div>
          </div>
          <div className="row"><button className="btn btn-primary" onClick={() => void saveVault()}>Continue</button><button className="btn btn-ghost" onClick={() => setStep(2)}>Skip</button></div>
        </div>
      )}
      {step === 2 && (
        <div className="stack enter" key="s2">
          <Dots step={2} />
          <h1>Choose how careful to be.</h1>
          <p className="sub">You can change this any time, and per request.</p>
          <div className="stack" role="radiogroup" aria-label="Privacy dial">
            {DIALS.map((d) => (
              <button key={d.id} role="radio" aria-checked={prefs.dial === d.id} className="card dial-card" onClick={() => s.setPrefs({ dial: d.id })}>
                <span className="meter" aria-hidden="true">{[1, 2, 3].map((n) => <i key={n} className={n <= d.level ? "on" : ""} />)}</span>
                <span><b>{d.title}</b><br /><span className="small">{d.line}</span></span>
              </button>
            ))}
          </div>
          <OnDeviceStatus />
          <div className="row"><button className="btn btn-primary" onClick={() => s.finishOnboarding()}>Start</button></div>
        </div>
      )}
    </div>
  );
}
