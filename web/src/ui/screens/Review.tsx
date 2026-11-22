import { useState, type CSSProperties } from "react";
import type { PrivacyCategory } from "../../engine/types";
import { GATE_CHECK_NAMES } from "../../app/session";
import { useAirlock, useSession } from "../../app/context";
import type { ReviewReason, SealProgress } from "../../engine/pipeline";
import type { Entity } from "../../engine/types";
import { Banner, chipLabel, SealedPreview, TimingDetails, useElapsed, WithChips } from "../components";
import { CATEGORY_ICON, IconCheck, IconDevice, IconEye, IconShield, Logo } from "../icons";
import { TASKS } from "./Ask";

const STEPS: { kind: SealProgress["kind"]; label: string }[] = [
  { kind: "detecting", label: "Reading on your device" },
  { kind: "generalising", label: "Making details less specific" },
  { kind: "checkingRisks", label: "Checking what someone could still guess" },
];

/** The wait, made legible: the user's own text (local), a scanning beam, and the steps ticking off. */
function Sealing({ raw, progress, startedAt }: { raw: string; progress: SealProgress | null; startedAt: number }) {
  const elapsed = useElapsed(startedAt);
  const at = progress ? STEPS.findIndex((x) => x.kind === progress.kind) : 0;
  const current = progress?.kind === "done" ? STEPS.length : Math.max(0, at);
  return (
    <div className="stack" aria-busy="true">
      <div>
        <h1>Sealing on your device</h1>
        <p className="sub" style={{ margin: 0 }}>Nothing has left this computer. You’ll see exactly what will be sent before it goes.</p>
      </div>
      <div className="card scan enter">
        <div className="lock-line"><IconDevice size={16} /> On this device · offline-safe</div>
        <div className="prose raw">{raw.length > 900 ? `${raw.slice(0, 900)}…` : raw}</div>
      </div>
      <div className="card enter" style={{ "--i": 1 } as CSSProperties}>
        <ol className="steps" role="status" aria-live="polite">
          {STEPS.map((st, i) => {
            const state = i < current ? "done" : i === current ? "active" : "";
            const label = st.kind === "detecting" && progress?.kind === "detecting" && progress.of > 1 ? `${st.label} · part ${progress.section} of ${progress.of}` : st.label;
            return <li key={st.kind} className={state}><span className="mark">{state === "done" && <IconCheck size={13} />}</span>{label}</li>;
          })}
        </ol>
        <div className="small elapsed" style={{ marginTop: 12 }}>{elapsed.toFixed(1)} s · Chrome’s built-in model is doing this work locally</div>
      </div>
    </div>
  );
}

function reasonText(r: ReviewReason): string {
  switch (r.kind) {
    case "phoneUnavailable": return "The on-device model isn't available, so Airlock used strict rules. Please check everything.";
    case "llmFailed": return "The on-device model couldn't read part of this. Rules were used there — please check it.";
    case "refused": return "The on-device model declined to read part of this. Rules were used there — please check it.";
    case "lowConfidence": return "Some details might be private (amber dot). Decide whether to protect them.";
    case "ambiguous": return "Some words could be a name or an ordinary word. Please check.";
    case "secretsFound": return "This contains a code or password. It has been removed — never share these.";
    case "risks": return `Someone could still guess ${r.count === 1 ? "one thing" : `${r.count} things`} about you. See below.`;
    case "redTeamUnavailable": return "Airlock couldn't check what someone could still guess. Read the sealed text carefully.";
  }
}

const reduceMotion = (): boolean => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

const PROTECT_AS: { id: Exclude<PrivacyCategory, "quasi">; label: string }[] = [
  { id: "person", label: "Person" }, { id: "org", label: "Organisation" }, { id: "location", label: "Place" }, { id: "contact", label: "Contact" }, { id: "id", label: "Number / ID" },
];

/** Mark something the detectors missed. Selecting text above pre-fills it; works fully from the keyboard too. */
function ProtectBar({ phrase, setPhrase }: { phrase: string; setPhrase: (s: string) => void }) {
  const s = useSession();
  const [note, setNote] = useState<string | null>(null);
  const go = (category: Exclude<PrivacyCategory, "quasi">) => {
    const ok = s.protect(phrase, category);
    setNote(ok ? `Protected every “${phrase.trim()}”.` : `“${phrase.trim()}” isn't in your text.`);
    if (ok) setPhrase("");
  };
  return (
    <div className="card stack enter" style={{ gap: 10 }}>
      <div>
        <h2 style={{ marginBottom: 4 }}>Protect something Airlock missed</h2>
        <p className="small" style={{ margin: 0 }}>Select a word above, or type it here. Every place it appears is replaced before sending, and the real words come back in the answer.</p>
      </div>
      <input className="field" value={phrase} onChange={(e) => { setPhrase(e.target.value); setNote(null); }} placeholder="e.g. Mercy General Hospital" aria-label="Word or phrase to protect" maxLength={120} />
      <div className="row" role="group" aria-label="Protect it as">
        {PROTECT_AS.map((c) => <button key={c.id} className="pill" disabled={!phrase.trim()} onClick={() => go(c.id)}>{c.label}</button>)}
      </div>
      {note && <div className="small" role="status">{note}</div>}
    </div>
  );
}

export function ReviewScreen() {
  const s = useSession();
  const { review } = useAirlock();
  const [view, setView] = useState<"sealed" | "raw">("sealed");
  const [sending, setSending] = useState(false);
  const [phrase, setPhrase] = useState("");
  if (!review) return null;
  const { result } = review;
  const risks = s.pendingRisks();

  async function copySealed() {
    const text = await s.scrubAndCopy();
    if (text) {
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        // Clipboard can be blocked; the sealed text is shown in the conversation to copy by hand.
      }
    }
  }

  async function send() {
    setSending(true);
    await new Promise((r) => setTimeout(r, reduceMotion() ? 0 : 950));
    try {
      await s.send();
    } finally {
      setSending(false);
    }
  }

  if (review.error) return <div className="stack"><h1>Check before sending</h1><Banner tone="risk" title={review.error} /><div><button className="btn" onClick={() => s.go("ask")}>Back</button></div></div>;

  if (!result) return <Sealing raw={review.raw} progress={review.progress} startedAt={review.startedAt} />;

  const entities = result.draft.entities.sorted();
  const sealed = entities.filter((e) => e.action.kind !== "keep");
  const kept = entities.filter((e) => e.action.kind === "keep");
  const generalised = result.draft.replacements.filter((r) => r.kind === "generalised" || r.kind === "bucketed" || r.kind === "redteam").length;
  const describe = (e: Entity): string => (e.action.kind === "keep" ? "sent as written" : e.action.kind === "generalise" ? `sent as “${e.generalisedText ?? "a general description"}”` : e.action.kind === "block" ? "removed" : "replaced");

  return (
    <div className="stack">
      <div className="row">
        <div style={{ flex: 1 }}>
          <h1>Check before sending</h1>
          <p className="sub" style={{ margin: 0 }}>This is exactly what will leave your device. Tap a protected detail to send it as written instead.</p>
        </div>
        <div className="segmented" role="group" aria-label="Show">
          <button aria-pressed={view === "sealed"} onClick={() => setView("sealed")}><IconShield size={14} /> Leaves your device</button>
          <button aria-pressed={view === "raw"} onClick={() => setView("raw")}><IconEye size={14} /> You wrote</button>
        </div>
      </div>

      {result.requiresReview && result.reasons.map((r, i) => <Banner key={i} tone={r.kind === "secretsFound" || r.kind === "phoneUnavailable" ? "risk" : "warn"} title={reasonText(r)} />)}

      {review.blocked && (
        <Banner tone="risk" title="Airlock stopped this before it left">
          The final check found {[...new Set(review.blocked.map((h) => GATE_CHECK_NAMES[h.check] ?? "something private"))].join(", ")} still in the text. Protect it above, or edit your message.
        </Banner>
      )}

      <div className="card sealed-card enter" key={view} onMouseUp={() => { const sel = window.getSelection()?.toString().trim() ?? ""; if (sel && sel.length <= 120 && !sel.includes("\n")) setPhrase(sel); }}>
        {view === "sealed" ? <SealedPreview draft={result.draft} onChip={(e) => s.toggleEntity(e.id)} /> : <div className="prose">{result.normalised.text}</div>}
        <div className="summary-bar" style={{ marginTop: 14 }}>
          <span><b className="counter" key={`p${sealed.length}`}>{sealed.length}</b> protected</span>
          <span><b className="counter" key={`g${generalised}`}>{generalised}</b> made less specific</span>
          <span><b className="counter" key={`k${kept.length}`}>{kept.length}</b> sent as written</span>
          <span className="spacer" />
          <span><IconDevice size={14} /> Sealed on this device in {(result.sealMs / 1000).toFixed(1)} s</span>
        </div>
        <TimingDetails timings={result.timings} />
      </div>

      {result.redTeamPending && (
        <div className="card row enter" role="status" style={{ gap: 12 }}>
          <span className="dot-pulse" aria-hidden="true" />
          <div><b>Checking what someone could still guess…</b><div className="small">Still on your device. You can review and change details meanwhile; sending unlocks when the check is done.</div></div>
        </div>
      )}

      {risks.length > 0 && (
        <div className="stack" style={{ gap: 10 }}>
          <h2>What someone could still guess</h2>
          {risks.map((r, i) => (
            <div className="risk-card" key={r.id} style={{ "--i": i } as CSSProperties}>
              <div className="row" style={{ alignItems: "flex-start", flexWrap: "nowrap" }}>
                <span className="guess-icon"><IconEye size={16} /></span>
                <div>
                  <div><b>A reader could guess: <WithChips text={r.guess} entities={result.draft.entities} /></b></div>
                  <div className="small">because of “<WithChips text={r.evidence} entities={result.draft.entities} />”</div>
                  {r.suggestion && <div className="small" style={{ marginTop: 4 }}>Suggestion: “<WithChips text={r.suggestion} entities={result.draft.entities} />”</div>}
                </div>
              </div>
              <div className="row" style={{ marginTop: 10 }}>
                {r.suggestion && <button className="btn btn-primary" onClick={() => s.acceptRisk(r)}>Use suggestion</button>}
                <button className="btn" onClick={() => s.dismissRisk(r)}>Keep as is</button>
              </div>
            </div>
          ))}
        </div>
      )}

      <ProtectBar phrase={phrase} setPhrase={setPhrase} />

      {entities.length > 0 && (
        <div className="card enter" style={{ "--i": 2 } as CSSProperties}>
          <h2>Details</h2>
          <div className="entity-list">
            {entities.map((e) => {
              const isProtected = e.action.kind !== "keep";
              const locked = e.category === "secret";
              const Icon = CATEGORY_ICON[e.category];
              return (
                <div className="entity" key={e.id}>
                  <span className={`chip ${e.category}`} style={{ padding: 6, animation: "none" }}><Icon size={16} /></span>
                  <div style={{ flex: 1 }}>
                    <div className="name">{e.canonical}</div>
                    <div className="role">{chipLabel(e)} · {describe(e)}{e.vaultEntryId ? " · from your Vault" : ""}{e.confidence !== "high" ? " · possibly private" : ""}</div>
                  </div>
                  <button className="switch" role="switch" aria-checked={isProtected} disabled={locked}
                    aria-label={`Protect ${chipLabel(e)}`} onClick={() => s.toggleEntity(e.id)} />
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="row" role="group" aria-label="What do you want?">
        {TASKS.map((t) => <button key={t.label} className="pill" aria-pressed={JSON.stringify(t.task) === JSON.stringify(review.task)} onClick={() => s.setReviewTask(t.task)}>{t.label}</button>)}
      </div>
      <div className="row">
        <button className="btn btn-primary" disabled={sending || result.redTeamPending === true} onClick={() => void send()}><span className="row" style={{ gap: 8 }}><IconShield size={16} /> {result.redTeamPending ? "Finishing the check…" : "Seal & send"}</span></button>
        {!review.threadId && (
          <>
            <button className="btn" disabled={sending || result.redTeamPending === true} onClick={() => void copySealed()} aria-describedby="copy-sealed-hint">Copy sealed version</button>
            <span id="copy-sealed-hint" className="sr-only">Copies the sealed text to use with any other AI or person. Airlock sends nothing.</span>
          </>
        )}
        <button className="btn btn-ghost" onClick={() => s.go(review.threadId ? "thread" : "ask")}>Cancel</button>
        <span className="small">Gemini sees only the left-hand version. Real names come back on your device.</span>
      </div>

      {sending && (
        <div className="door" aria-hidden="true">
          <div className="panel left" /><div className="panel right" />
          <div className="ring" />
          <div className="glyph"><Logo size={84} animated /><span>Sealed · leaving your device</span></div>
        </div>
      )}
    </div>
  );
}
