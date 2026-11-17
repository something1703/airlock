import { useState, type CSSProperties } from "react";
import { useAirlock, useSession } from "../../app/context";
import type { Receipt } from "../../engine/hashchain";
import { CHROME_ON_DEVICE_MODEL } from "../../engine/engines";
import { Banner, prettyModel, useCountUp } from "../components";
import { IconCloud, IconDevice, IconLedger, IconLink } from "../icons";

const CAT: Record<string, string> = { person: "people", org: "organisations", location: "places", contact: "contact details", id: "IDs", date: "dates", health: "health details", secret: "secrets", quasi: "other details" };

function ReceiptRow({ r, index, lit, broken }: { r: Receipt; index: number; lit: boolean; broken: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`chain-row${lit ? " lit" : ""}${broken ? " broken" : ""}`} style={{ "--i": index } as CSSProperties}>
      <button className="receipt-row" style={{ width: "100%", background: "none", border: 0, borderBottom: "1px solid var(--stroke)", textAlign: "left", cursor: "pointer" }} aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="mono row" style={{ gap: 6 }}><span className="link"><IconLink size={14} /></span>#{r.seq}</span>
        <span className="row" style={{ gap: 6 }}>{r.modelVersion === CHROME_ON_DEVICE_MODEL ? <IconDevice size={14} /> : <IconCloud size={14} />}{prettyModel(r.modelVersion)} · {r.outboundChars} characters · {new Date(r.createdAt).toLocaleString()}</span>
        <span>{r.gate.passed ? <span className="ok-dot" aria-label="Gate passed" /> : <span className="bad-dot" aria-label="Gate bypassed" />}</span>
      </button>
      {open && (
        <div className="card stack" style={{ margin: "10px 0", gap: 8 }}>
          <div className="small">Exactly what left (sealed):</div>
          <div className="prose mono">{r.outboundText ?? "(not kept)"}</div>
          <div className="small mono">sha256 {r.outboundSha256}</div>
          <div className="small mono">prev {r.prevHash.slice(0, 16)}… · hash {r.hash.slice(0, 16)}…</div>
          <div className="small">Checks passed: {r.gate.checks.join(" ")} · Seal {r.latencyMs["seal"] ?? 0} ms · Network {r.latencyMs["network"] ?? 0} ms</div>
        </div>
      )}
    </div>
  );
}

export function LedgerScreen() {
  const s = useSession();
  const { chain } = useAirlock();
  const stats = s.stats(7);
  const receipts = [...s.ledger.receipts].reverse();
  const hero = useCountUp(stats.sealedDetails);
  const [verifyRun, setVerifyRun] = useState(0);
  return (
    <div className="stack">
      <div>
        <h1>Ledger</h1>
        <p className="sub">Every request that left this device has a receipt. Receipts are chained, so editing or deleting one breaks the chain.</p>
      </div>
      <div className="card row enter" style={{ gap: 28 }}>
        <div><div className="hero-num" aria-label={`${stats.sealedDetails} details`}>{hero}</div><div className="small">details kept off the cloud this week</div></div>
        <div className="stack" style={{ gap: 4 }}>
          <span><b>{stats.requests}</b> requests sent to Gemini</span>
          <span><b>{stats.onDeviceAnswers}</b> answered on this device</span>
          <span className="small">{Object.entries(stats.byCategory).filter(([, v]) => v > 0).map(([k, v]) => `${v} ${CAT[k] ?? k}`).join(" · ") || "No details sealed yet."}</span>
        </div>
      </div>
      <div className="row">
        <button className="btn" onClick={() => { s.verifyChain(); setVerifyRun(verifyRun + 1); }}><span className="row" style={{ gap: 8 }}><IconLink size={16} /> Verify chain</span></button>
        {chain && (chain.valid ? <Banner tone="ok" title={`Chain intact · ${chain.count} receipts`} /> : <Banner tone="risk" title={`Chain broken at receipt #${chain.seq}`}>Reason: {chain.reason}</Banner>)}
      </div>
      <div className="card">
        <h2>Receipts</h2>
        {receipts.length === 0 ? (
          <div className="empty"><IconLedger size={36} /><div>No receipts yet.</div><div className="small">Answers made on this device don’t need one — nothing left.</div></div>
        ) : receipts.map((r, i) => (
          <ReceiptRow key={`${r.id}-${verifyRun}`} r={r} index={receipts.length - 1 - i} lit={verifyRun > 0 && chain?.valid === true} broken={chain?.valid === false && chain.seq === r.seq} />
        ))}
      </div>
    </div>
  );
}
