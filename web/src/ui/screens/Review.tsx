import { useState } from "react";
import { GATE_CHECK_NAMES } from "../../app/session";
import { useAirlock, useSession } from "../../app/context";
import type { ReviewReason, SealProgress } from "../../engine/pipeline";
import type { Entity } from "../../engine/types";
import { Banner, chipLabel, SealedPreview } from "../components";
import { TASKS } from "./Ask";

function progressText(p: SealProgress | null): string {
  if (!p) return "Reading on your device…";
  switch (p.kind) {
    case "detecting": return p.of > 1 ? `Reading on your device… section ${p.section} of ${p.of}` : "Reading on your device…";
    case "generalising": return "Making details less specific…";
    case "checkingRisks": return "Checking what someone could still guess…";
    case "done": return "Done";
  }
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

export function ReviewScreen() {
  const s = useSession();
  const { review } = useAirlock();
  const [view, setView] = useState<"sealed" | "raw">("sealed");
  const [sending, setSending] = useState(false);
  if (!review) return null;
  const { result } = review;
  const risks = s.pendingRisks();

  async function send() {
    setSending(true);
    await new Promise((r) => setTimeout(r, reduceMotion() ? 0 : 750));
    try {
      await s.send();
    } finally {
      setSending(false);
    }
  }

  if (review.error) return <div className="stack"><h1>Check before sending</h1><Banner tone="risk" title={review.error} /><div><button className="btn" onClick={() => s.go("ask")}>Back</button></div></div>;

  if (!result) {
    return (
      <div className="stack" aria-busy="true">
        <h1>Check before sending</h1>
        <div className="progress-line" role="status"><span className="dot-pulse" aria-hidden="true" />{progressText(review.progress)}</div>
        <div className="card"><div className="skeleton" style={{ width: "92%" }} /><div className="skeleton" style={{ width: "80%" }} /><div className="skeleton" style={{ width: "64%" }} /></div>
        <p className="small">Nothing has left this computer.</p>
      </div>
    );
  }

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
          <p className="sub" style={{ margin: 0 }}>This is exactly what will leave your device. Tap a highlighted detail to send it as written.</p>
        </div>
        <div className="segmented" role="group" aria-label="Show">
          <button aria-pressed={view === "sealed"} onClick={() => setView("sealed")}>Leaves your device</button>
          <button aria-pressed={view === "raw"} onClick={() => setView("raw")}>You wrote</button>
        </div>
      </div>

      {result.requiresReview && result.reasons.map((r, i) => <Banner key={i} tone={r.kind === "secretsFound" || r.kind === "phoneUnavailable" ? "risk" : "warn"} title={reasonText(r)} />)}

      {review.blocked && (
        <Banner tone="risk" title="Airlock stopped this before it left">
          The final check found {[...new Set(review.blocked.map((h) => GATE_CHECK_NAMES[h.check] ?? "something private"))].join(", ")} still in the text. Protect it above, or edit your message.
        </Banner>
      )}

      <div className="card">
        {view === "sealed" ? <SealedPreview draft={result.draft} onChip={(e) => s.toggleEntity(e.id)} /> : <div className="prose">{result.normalised.text}</div>}
        <div className="summary-bar" style={{ marginTop: 14 }}>
          <span><b>{sealed.length}</b> protected</span>
          <span><b>{generalised}</b> made general</span>
          <span><b>{kept.length}</b> sent as written</span>
          <span>Sealed on this device in {(result.sealMs / 1000).toFixed(1)}s</span>
        </div>
      </div>

      {risks.length > 0 && (
        <div className="stack" style={{ gap: 10 }}>
          <h2>What someone could still guess</h2>
          {risks.map((r) => (
            <div className="risk-card" key={r.id}>
              <div><b>A reader could guess {r.guess}</b>, because of “{r.evidence}”.</div>
              {r.suggestion && <div className="small" style={{ marginTop: 4 }}>Suggestion: “{r.suggestion}”</div>}
              <div className="row" style={{ marginTop: 10 }}>
                {r.suggestion && <button className="btn btn-primary" onClick={() => s.acceptRisk(r)}>Use suggestion</button>}
                <button className="btn" onClick={() => s.dismissRisk(r)}>Keep as is</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {entities.length > 0 && (
        <div className="card">
          <h2>Details</h2>
          <div className="entity-list">
            {entities.map((e) => {
              const isProtected = e.action.kind !== "keep";
              const locked = e.category === "secret";
              return (
                <div className="entity" key={e.id}>
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
        <button className="btn btn-primary" disabled={sending} onClick={() => void send()}>Seal &amp; send</button>
        <button className="btn btn-ghost" onClick={() => s.go(review.threadId ? "thread" : "ask")}>Cancel</button>
        <span className="small">Gemini sees only the left-hand version. Real names come back on your device.</span>
      </div>

      {sending && (
        <div className="door" aria-hidden="true">
          <div className="panel left" /><div className="panel right" />
          <div className="glyph"><svg width="72" height="72" viewBox="0 0 64 64"><path d="M14 40a18 18 0 0 1 36 0" fill="none" stroke="var(--seal)" strokeWidth="5" strokeLinecap="round" /><path d="M22 40a10 10 0 0 1 20 0" fill="none" stroke="var(--seal)" strokeWidth="5" strokeLinecap="round" /></svg></div>
        </div>
      )}
    </div>
  );
}
