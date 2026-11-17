import { useState } from "react";
import { useAirlock, useSession } from "../../app/context";
import type { AssistantTurn, UserTurn } from "../../app/session";
import { Banner, RestoredAnswer, RouteBadge, SealedText } from "../components";
import { IconEye, IconLedger, IconShield } from "../icons";

function UserBubble({ turn, entities }: { turn: UserTurn; entities: { get(id: string): import("../../engine/types").Entity | undefined } }) {
  const [showRaw, setShowRaw] = useState(false);
  return (
    <div className="bubble user">
      <div className="row" style={{ marginBottom: 6 }}>
        <span className="small row" style={{ flex: 1, gap: 6 }}>{showRaw ? <><IconEye size={14} /> You wrote · never sent</> : <><IconShield size={14} /> What Gemini saw</>}</span>
        <button className="btn btn-ghost" style={{ minHeight: 32, padding: "4px 10px" }} aria-pressed={showRaw} onClick={() => setShowRaw(!showRaw)}>{showRaw ? "Show sealed" : "Show what I wrote"}</button>
      </div>
      {showRaw ? <div className="prose">{turn.raw}</div> : <SealedText text={turn.sealed.value} entities={entities} />}
    </div>
  );
}

function AssistantBubble({ turn }: { turn: AssistantTurn }) {
  const o = turn.outcome;
  return (
    <div className="bubble ai" aria-live="polite" aria-busy={turn.status === "streaming"}>
      <div style={{ marginBottom: 8 }}><RouteBadge outcome={o} streaming={turn.status === "streaming"} /></div>
      {turn.status === "error" ? <Banner tone="risk" title={turn.error ?? "Something went wrong."} /> : turn.segments.length ? <div className={turn.status === "streaming" ? "caret" : undefined}><RestoredAnswer segments={turn.segments} /></div> : <span className="typing" aria-label="Waiting for the answer"><i /><i /><i /></span>}
      {o && (
        <div className="receipt-line">
          {o.receipt ? <><span className="row" style={{ gap: 4 }}><IconLedger size={14} /> Receipt {o.receipt.id}</span><span className="mono">{o.receipt.outboundSha256.slice(0, 12)}…</span><span>{o.receipt.outboundChars} characters sent</span></> : <span>Nothing left this device — no receipt needed.</span>}
          {o.fidelity.guessedEntities.length > 0 && <span>· Gemini wrote a real detail it guessed — check the answer.</span>}
          {o.fidelity.unknownIds.length > 0 && <span>· The answer mentioned a placeholder Airlock doesn’t know.</span>}
        </div>
      )}
    </div>
  );
}

export function ThreadScreen() {
  const s = useSession();
  const { threads, currentThreadId } = useAirlock();
  const [text, setText] = useState("");
  const thread = threads.find((t) => t.id === currentThreadId);
  if (!thread) return <div className="stack"><h1>Not found</h1><button className="btn" onClick={() => s.go("ask")}>Back to Ask</button></div>;
  const busy = thread.turns.some((t) => t.kind === "assistant" && t.status === "streaming");

  return (
    <div className="stack">
      <div className="row">
        <h1 style={{ flex: 1 }}>{thread.title}</h1>
        <button className="btn btn-ghost" onClick={() => s.go("ask")}>New question</button>
      </div>
      {thread.turns.map((t, i) => (t.kind === "user" ? <UserBubble key={i} turn={t} entities={thread.entities} /> : <AssistantBubble key={i} turn={t} />))}
      <div className="card stack" style={{ gap: 10 }}>
        <textarea className="compose" style={{ minHeight: 90 }} value={text} onChange={(e) => setText(e.target.value)} placeholder="Ask a follow-up — it gets sealed too" aria-label="Follow-up question" />
        <div className="row">
          <button className="btn btn-primary" disabled={!text.trim() || busy} onClick={() => { const t = text; setText(""); void s.startReview(t, { kind: "help" }, thread.id); }}>Continue</button>
          <span className="small">Real names show underlined: Gemini wrote placeholders and your device filled them in.</span>
        </div>
      </div>
    </div>
  );
}
