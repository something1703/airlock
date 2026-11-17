import { useState } from "react";
import { useAirlock, useSession } from "../../app/context";
import type { Receipt } from "../../engine/hashchain";
import { Banner, prettyModel } from "../components";

const CAT: Record<string, string> = { person: "people", org: "organisations", location: "places", contact: "contact details", id: "IDs", date: "dates", health: "health details", secret: "secrets", quasi: "other details" };

function ReceiptRow({ r }: { r: Receipt }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button className="receipt-row" style={{ width: "100%", background: "none", border: 0, borderBottom: "1px solid var(--stroke)", textAlign: "left", cursor: "pointer" }} aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="mono">#{r.seq}</span>
        <span>{prettyModel(r.modelVersion)} · {r.outboundChars} characters · {new Date(r.createdAt).toLocaleString()}</span>
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
  return (
    <div className="stack">
      <div>
        <h1>Ledger</h1>
        <p className="sub">Every request that left this device has a receipt. Receipts are chained, so editing or deleting one breaks the chain.</p>
      </div>
      <div className="card row" style={{ gap: 28 }}>
        <div><div className="hero-num">{stats.sealedDetails}</div><div className="small">details kept off the cloud this week</div></div>
        <div className="stack" style={{ gap: 4 }}>
          <span><b>{stats.requests}</b> requests sent to Gemini</span>
          <span><b>{stats.onDeviceAnswers}</b> answered on this device</span>
          <span className="small">{Object.entries(stats.byCategory).filter(([, v]) => v > 0).map(([k, v]) => `${v} ${CAT[k] ?? k}`).join(" · ") || "No details sealed yet."}</span>
        </div>
      </div>
      <div className="row">
        <button className="btn" onClick={() => s.verifyChain()}>Verify chain</button>
        {chain && (chain.valid ? <Banner tone="ok" title={`Chain intact · ${chain.count} receipts`} /> : <Banner tone="risk" title={`Chain broken at receipt #${chain.seq}`}>Reason: {chain.reason}</Banner>)}
      </div>
      <div className="card">
        <h2>Receipts</h2>
        {receipts.length === 0 ? <p className="small">No receipts yet. Answers made on this device don’t need one — nothing left.</p> : receipts.map((r) => <ReceiptRow key={r.id} r={r} />)}
      </div>
    </div>
  );
}
