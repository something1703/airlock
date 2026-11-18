import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useAirlock, useSession } from "../../app/context";
import { PROOF_SAMPLES } from "../../app/proofSamples";
import { engineErrorMessage, type ProofState } from "../../app/session";
import { EngineError } from "../../engine/engines";
import { TACTIC_LABEL, TACTIC_WHY, type CitedItem, type ClaimOutcome, type ClaimVerdict, type ProofResult, type ProofStage, type TacticFlag, type Verdict } from "../../engine/proof";
import type { RestoredSegment } from "../../engine/restore";
import type { EntityMap } from "../../engine/types";
import { prettyModel, SealedText, useElapsed } from "../components";
import { IconAlert, IconArrow, IconCheck, IconCloud, IconCopy, IconDevice, IconEye, IconFlag, IconLedger, IconProof, IconSearch, IconSecret, IconShare, IconShield, IconSparkle, IconStop } from "../icons";
import { mountEntryPoint } from "../searchEntryPoint";
import { OnDeviceStatus } from "./OnDeviceStatus";

const VERDICT: Record<Verdict, { title: string; tone: "scam" | "unsure" | "legit"; Icon: typeof IconStop }> = {
  likelyScam: { title: "Likely a scam", tone: "scam", Icon: IconStop },
  unsure: { title: "Not sure — be careful", tone: "unsure", Icon: IconAlert },
  looksLegit: { title: "Looks legitimate", tone: "legit", Icon: IconShield },
};

const FINDING: Record<ClaimVerdict, { label: string; tone: "scam" | "unsure" | "legit" }> = {
  LIKELY_SCAM: { label: "Matches known scams", tone: "scam" },
  UNCLEAR: { label: "Couldn't confirm", tone: "unsure" },
  LIKELY_LEGIT: { label: "Matches normal messages", tone: "legit" },
};

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** One plain sentence under the verdict, honest about what was (and wasn't) checked. */
function summary(r: ProofResult, online: boolean): string {
  const flags = plural(r.flags.length, "red flag");
  switch (r.mode) {
    case "checked":
      if (r.verdict === "likelyScam") return "This looks like a scam. Here's why.";
      if (r.verdict === "looksLegit") return "Nothing here matches a known scam. Airlock can't be sure, so stay alert.";
      return "Airlock couldn't tell for sure. Treat this message with care.";
    case "offline": return `We found ${flags} on your device. Connect to check against the web.`;
    case "onDeviceUnavailable": return `We found ${flags} using rules on your device. Turn on on-device AI so Airlock can pick out the claims to check on the web.`;
    case "noClaims": return `We found ${flags} on your device. There were no claims to check on the web.`;
    case "allKept": return `We found ${flags} on your device. The claims still looked private after sealing, so they stayed here.`;
    case "cloudFailed": return `We found ${flags} on your device. ${online ? "Gemini couldn't check the web right now — try again in a moment." : "Connect to check against the web."}`;
    case "noCloud": return `We found ${flags} on your device. Checking against the web needs Gemini, which isn't set up here.`;
  }
}

export function ProofScreen() {
  const { proof } = useAirlock();
  if (!proof) return <ProofInput />;
  if (proof.stage !== "done") return <Checking proof={proof} />;
  return <ProofDone proof={proof} />;
}

function ProofInput() {
  const s = useSession();
  const [text, setText] = useState("");
  return (
    <div className="stack">
      <div>
        <h1>Proof</h1>
        <p className="sub">Got a message you’re not sure about? Your device looks for red flags first. Only sealed claims are checked with Gemini and Google Search.</p>
      </div>
      <OnDeviceStatus />
      <textarea className="compose enter" value={text} onChange={(e) => { setText(e.target.value); s.warmUp(); }} placeholder="Paste the message here — a text, an email, a DM…" aria-label="The message you want to check" />
      <div className="row">
        <button className="btn btn-primary" disabled={!text.trim()} onClick={() => void s.startProof(text)}><span className="row" style={{ gap: 8 }}><IconProof size={18} /> Check it</span></button>
        <span className="small">Airlock helps you check; it can’t be sure.</span>
      </div>
      <div className="row" role="group" aria-label="Try a fictional sample">
        <span className="small row" style={{ gap: 6 }}><IconSparkle size={14} /> Try a sample (fictional):</span>
        {PROOF_SAMPLES.map((x) => <button key={x.label} className="pill" onClick={() => setText(x.message)}>{x.label}</button>)}
      </div>
      <div className="card proof-how enter" style={{ "--i": 1 } as CSSProperties}>
        <h2>How Proof works</h2>
        <ol className="how-steps">
          <li><span className="how-icon phone"><IconDevice size={16} /></span><span><b>On your device:</b> Airlock looks for pressure tactics and picks out what the message wants you to believe.</span></li>
          <li><span className="how-icon phone"><IconShield size={16} /></span><span><b>Sealed:</b> names, links, numbers and codes are taken out of those claims before anything leaves.</span></li>
          <li><span className="how-icon cloud"><IconSearch size={16} /></span><span><b>Checked:</b> Gemini looks the sealed claims up with Google Search. You see its sources.</span></li>
        </ol>
      </div>
    </div>
  );
}

const STEPS: { stage: ProofStage; label: string; where: "phone" | "cloud" }[] = [
  { stage: "scanning", label: "Looking for red flags on your device", where: "phone" },
  { stage: "sealing", label: "Sealing the claims to check", where: "phone" },
  { stage: "checking", label: "Checking with Gemini and Google Search", where: "cloud" },
];

function Checking({ proof }: { proof: ProofState }) {
  const elapsed = useElapsed(proof.startedAt);
  const at = STEPS.findIndex((x) => x.stage === proof.stage);
  return (
    <div className="stack" aria-busy="true">
      <div>
        <h1>Checking the message</h1>
        <p className="sub" style={{ margin: 0 }}>Your message stays on this device. Only sealed claims go to Gemini.</p>
      </div>
      <div className="card scan enter">
        <div className="lock-line"><IconDevice size={16} /> On this device · never sent</div>
        <div className="prose raw">{proof.raw.length > 700 ? `${proof.raw.slice(0, 700)}…` : proof.raw}</div>
      </div>
      <div className="card enter" style={{ "--i": 1 } as CSSProperties}>
        <ol className="steps" role="status" aria-live="polite">
          {STEPS.map((st, i) => {
            const state = i < at ? "done" : i === at ? "active" : "";
            return <li key={st.stage} className={`${state}${st.where === "cloud" ? " cloud-step" : ""}`}><span className="mark">{state === "done" && <IconCheck size={13} />}</span>{st.label}</li>;
          })}
        </ol>
        <div className="small elapsed" style={{ marginTop: 12 }}>{elapsed.toFixed(1)} s</div>
      </div>
    </div>
  );
}

function ProofDone({ proof }: { proof: ProofState }) {
  const s = useSession();
  const [sharing, setSharing] = useState(false);
  const r = proof.result;
  if (!r) {
    return (
      <div className="stack">
        <h1>Proof</h1>
        <div className="banner risk enter" role="alert"><IconAlert /><div><div className="t">{proof.error ?? "Something went wrong."}</div></div></div>
        <div className="row"><button className="btn" onClick={() => s.resetProof()}>Check another message</button></div>
      </div>
    );
  }
  const share = s.proofShareText();
  const v = VERDICT[r.verdict];
  const webClaims = r.claims;
  return (
    <div className="stack">
      <div className="row">
        <h1 style={{ flex: 1 }}>Proof</h1>
        <button className="btn btn-ghost" onClick={() => s.resetProof()}>Check another message</button>
      </div>
      <section className={`card verdict-card ${v.tone}`} aria-labelledby="verdict-title">
        <header className="verdict-head">
          <span className="verdict-icon" aria-hidden="true"><v.Icon size={30} /></span>
          <div style={{ flex: 1 }}>
            <h2 id="verdict-title" className="verdict-title">{v.title}</h2>
            <p className="verdict-sub" role="status">{summary(r, s.services.online())}</p>
          </div>
        </header>

        <div className="proof-section">
          <h3 className="section-label"><IconDevice size={15} /> Red flags · found on this device</h3>
          {r.flags.length ? <ul className="flag-list">{r.flags.map((f, i) => <FlagRow key={`${f.tactic}-${i}`} flag={f} index={i} />)}</ul> : <p className="small">No red flags found on your device.</p>}
        </div>

        {webClaims.length > 0 && (
          <div className="proof-section">
            <h3 className="section-label cloud"><IconCloud size={15} /> What the web says · Gemini with Google Search</h3>
            <div className="stack" style={{ gap: 12 }}>
              {webClaims.map((c, i) => <ClaimBlock key={i} outcome={c} index={i} entities={r.entities} />)}
            </div>
          </div>
        )}

        <div className="row verdict-actions">
          {share && <button className="btn" aria-expanded={sharing} onClick={() => setSharing(!sharing)}><span className="row" style={{ gap: 8 }}><IconShare size={16} /> Share a warning</span></button>}
          <span className="small" style={{ flex: 1 }}>Airlock helps you check; it can’t be sure. This isn’t legal or financial advice.</span>
        </div>
        {sharing && share && <ShareSheet text={share} onClose={() => setSharing(false)} />}
      </section>
    </div>
  );
}

function FlagRow({ flag, index }: { flag: TacticFlag; index: number }) {
  return (
    <li className="flag pop" style={{ "--i": index } as CSSProperties}>
      <span className="flag-icon" aria-hidden="true"><IconFlag size={15} /></span>
      <div>
        <div className="flag-label">{TACTIC_LABEL[flag.tactic]}{flag.source === "pattern" && <span className="small"> · rule</span>}</div>
        <div className="small">{flag.detail ?? TACTIC_WHY[flag.tactic]}</div>
        {flag.evidence && <q className="evidence" title="From your message — shown on this device only">{flag.evidence}</q>}
      </div>
    </li>
  );
}

function Inline({ segments }: { segments: RestoredSegment[] }) {
  return (
    <>
      {segments.map((sg, i) => {
        switch (sg.kind) {
          case "text": return <span key={i}>{sg.text}</span>;
          case "restored": return <span key={i} className="restored" title={`Gemini wrote ${sg.original}; your device filled in the real detail.`}>{sg.display}</span>;
          case "secret": return <span key={i} className="chip secret" aria-label="Hidden code — never shown"><IconSecret /> hidden code</span>;
          case "unknown": return <span key={i}>{sg.original}</span>;
        }
      })}
    </>
  );
}

function Cited({ item, sources }: { item: CitedItem; sources: { n: number; title: string; uri: string }[] }) {
  return (
    <>
      <Inline segments={item.restored.segments} />
      {item.cites.map((n) => {
        const src = sources.find((x) => x.n === n);
        return src ? <sup key={n} className="cite"><a href={src.uri} target="_blank" rel="noopener noreferrer" aria-label={`Source ${n}: ${src.title}`}>{n}</a></sup> : null;
      })}
    </>
  );
}

function ClaimBlock({ outcome, index, entities }: { outcome: ClaimOutcome; index: number; entities: EntityMap }) {
  const [showSealed, setShowSealed] = useState(false);
  const sealed = outcome.status === "kept" ? null : outcome.sealed;
  const tag: ReactNode =
    outcome.status === "checked" ? <span className={`finding ${FINDING[outcome.finding.verdict].tone}`}>{FINDING[outcome.finding.verdict].label}</span>
    : outcome.status === "kept" ? <span className="finding muted"><IconDevice size={13} /> Kept on your device</span>
    : outcome.status === "notSent" ? <span className="finding muted">Not checked</span>
    : <span className="finding muted">Couldn’t check</span>;
  return (
    <article className="claim enter" style={{ "--i": index + 2 } as CSSProperties} aria-label={`Claim ${index + 1}`}>
      <div className="claim-head">
        <div className="claim-main">
          <div className="small">{showSealed && sealed ? "What Gemini saw (sealed on this device)" : "The message claims"}</div>
          <div className="claim-text">{showSealed && sealed ? <SealedText text={sealed.value} entities={entities} /> : outcome.claim}</div>
        </div>
        {tag}
      </div>
      {sealed && (
        <button className="btn btn-ghost tiny" aria-pressed={showSealed} onClick={() => setShowSealed(!showSealed)}>
          <span className="row" style={{ gap: 6 }}>{showSealed ? <><IconEye size={14} /> Show the claim</> : <><IconShield size={14} /> What Gemini saw</>}</span>
        </button>
      )}
      {outcome.status === "kept" && <p className="small">This claim still looked private after sealing, so Airlock didn’t send it.</p>}
      {outcome.status === "failed" && <p className="small">{engineErrorMessage(new EngineError(outcome.error))}</p>}
      {outcome.status === "checked" && <Finding outcome={outcome} />}
    </article>
  );
}

function Finding({ outcome }: { outcome: Extract<ClaimOutcome, { status: "checked" }> }) {
  const f = outcome.finding;
  return (
    <div className="grounded">
      {f.why.map((w, i) => <p key={i} className="why"><Cited item={w} sources={f.sources} /></p>)}
      {(f.do.length > 0 || f.dont.length > 0) && (
        <div className="do-dont">
          {f.do.length > 0 && <div><div className="dd-label do"><IconCheck size={14} /> Do</div><ul>{f.do.map((x, i) => <li key={i}><Cited item={x} sources={f.sources} /></li>)}</ul></div>}
          {f.dont.length > 0 && <div><div className="dd-label dont"><IconStop size={14} /> Don’t</div><ul>{f.dont.map((x, i) => <li key={i}><Cited item={x} sources={f.sources} /></li>)}</ul></div>}
        </div>
      )}
      {f.sources.length > 0 && (
        <div className="sources">
          <div className="small">Sources</div>
          <ol>{f.sources.map((src) => <li key={src.n}><a href={src.uri} target="_blank" rel="noopener noreferrer"><span className="src-n">{src.n}</span>{src.title}</a></li>)}</ol>
        </div>
      )}
      {f.searchEntryPointHtml && <SearchSuggestions html={f.searchEntryPointHtml} />}
      <div className="receipt-line">
        <span className="row" style={{ gap: 4 }}><IconCloud size={14} /> Gemini · {prettyModel(f.modelVersion)} · {(f.latencyMs / 1000).toFixed(1)}s</span>
        {outcome.receiptId && <span className="row" style={{ gap: 4 }}><IconLedger size={14} /> Receipt {outcome.receiptId}</span>}
        <span>Only the sealed claim was sent.</span>
      </div>
    </div>
  );
}

/** Google's Search Suggestions, unmodified, in a shadow root at the answer's full width. */
function SearchSuggestions({ html }: { html: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current) mountEntryPoint(ref.current, html);
  }, [html]);
  return <div ref={ref} className="search-suggestions" role="group" aria-label="Google Search suggestions" />;
}

/** "Check before you share": the warning is built from fixed phrases only, and the user sees it first. */
function ShareSheet({ text, onClose }: { text: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const reduce = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    ref.current?.scrollIntoView({ block: "nearest", behavior: reduce ? "auto" : "smooth" });
  }, []);
  const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div ref={ref} className="share-sheet enter" role="region" aria-label="Share a warning">
      <div className="row" style={{ gap: 8 }}><IconShare size={16} /><b>Check before you share</b></div>
      <p className="small" style={{ margin: "6px 0 10px" }}>This warning has no names, links, numbers or quotes from the message. It says “looks like” because Airlock can’t be sure. Read it before you send it.</p>
      <div className="share-text">{text}</div>
      <div className="row" style={{ marginTop: 12 }}>
        {canShare && <button className="btn btn-primary" onClick={() => void navigator.share({ text }).catch(() => {})}><span className="row" style={{ gap: 8 }}><IconShare size={16} /> Share…</span></button>}
        <button className={`btn${canShare ? "" : " btn-primary"}`} onClick={() => void copy()}><span className="row" style={{ gap: 8 }}>{copied ? <><IconCheck size={16} /> Copied</> : <><IconCopy size={16} /> Copy</>}</span></button>
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}

/** Ask's entry point into Proof. */
export function CheckScamButton({ text }: { text: string }) {
  const s = useSession();
  if (!s.services.config.bool("feature_proof")) return null;
  return (
    <button className="btn btn-ghost" disabled={!text.trim()} onClick={() => s.openProof(text)}>
      <span className="row" style={{ gap: 6 }}><IconProof size={16} /> Check if this is a scam <IconArrow size={14} /></span>
    </button>
  );
}
