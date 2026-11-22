import { useState } from "react";
import { useAirlock, useSession } from "../../app/context";
import type { AssistantTurn, UserTurn } from "../../app/session";
import { Banner, RestoredAnswer, RouteBadge, SealedText, TimingDetails, WithChips } from "../components";
import { IconDevice, IconEye, IconLedger, IconShield, IconSparkle, IconTrash } from "../icons";
import type { Entity } from "../../engine/types";
import type { Inference } from "../../engine/infer";
import { engineErrorMessage } from "../../app/session";
import type { CSSProperties } from "react";
import { ConsentCard, ToolLog } from "../tools";

/** F-25: what the cloud can still infer from the sealed text it already saw — the honest limit of sealing. */
function GuessCard({ threadId, entities }: { threadId: string; entities: { get(id: string): Entity | undefined } }) {
  const s = useSession();
  const [state, setState] = useState<{ kind: "idle" } | { kind: "asking" } | { kind: "done"; items: Inference[]; unreadable: boolean; receiptId: string } | { kind: "error"; message: string }>({ kind: "idle" });
  const ask = async () => {
    setState({ kind: "asking" });
    try {
      const r = await s.inferGuesses(threadId);
      setState({ kind: "done", items: r.inferences, unreadable: r.unreadable, receiptId: r.receipt.id });
    } catch (e) {
      setState({ kind: "error", message: engineErrorMessage(e) });
    }
  };
  return (
    <div className="card stack guess-card enter" style={{ gap: 12 }}>
      <div className="row" style={{ alignItems: "flex-start", flexWrap: "nowrap", gap: 12 }}>
        <span className="guess-icon"><IconEye size={18} /></span>
        <div style={{ flex: 1 }}>
          <h2 style={{ margin: 0 }}>What could Gemini still guess?</h2>
          <p className="small" style={{ margin: "4px 0 0" }}>Sealing hides who you are, not what happened. Ask Gemini what it can infer from the exact sealed text it already saw — nothing new is sent, and you get a receipt.</p>
        </div>
      </div>
      {state.kind === "idle" && <div><button className="btn" onClick={() => void ask()}><span className="row" style={{ gap: 8 }}><IconSparkle size={16} /> Ask Gemini what it can infer</span></button></div>}
      {state.kind === "asking" && <div className="progress-line" role="status"><span className="dot-pulse" aria-hidden="true" /> Asking Gemini with the same sealed text…</div>}
      {state.kind === "error" && <Banner tone="risk" title={state.message} action={<button className="btn" onClick={() => void ask()}>Try again</button>} />}
      {state.kind === "done" && (
        <div className="stack" style={{ gap: 8 }} aria-live="polite">
          {state.unreadable && <Banner tone="warn" title="Gemini's reply couldn't be read as a list." action={<button className="btn" onClick={() => void ask()}>Try again</button>} />}
          {!state.unreadable && state.items.length === 0 && <Banner tone="ok" title="Gemini couldn't infer anything specific about you from the sealed text." />}
          {state.items.map((g, i) => (
            <div key={i} className={`guess-row ${g.confidence} enter`} style={{ "--i": i } as CSSProperties}>
              <div className="row" style={{ gap: 8 }}>
                <span className="guess-attr">{g.attribute}</span>
                <span className={`guess-conf ${g.confidence}`}>{g.confidence} confidence</span>
              </div>
              <div className="guess-value"><WithChips text={g.value} entities={entities} /></div>
              {g.evidence && <div className="small">because of “<WithChips text={g.evidence} entities={entities} />”</div>}
            </div>
          ))}
          {state.items.length > 0 && <p className="small" style={{ margin: 0 }}>Too much? Next time, use <b>Protect this</b> on Review or a stricter dial — the details that give these away will be sealed too. Receipt {state.receiptId} is in the Ledger.</p>}
        </div>
      )}
    </div>
  );
}

/** F-27: the user copied the sealed text elsewhere; they paste the answer back to restore it on this device. */
function PasteBack({ threadId }: { threadId: string }) {
  const s = useSession();
  const [text, setText] = useState("");
  return (
    <div className="card stack enter" style={{ gap: 10 }}>
      <div className="row" style={{ gap: 10, alignItems: "flex-start", flexWrap: "nowrap" }}>
        <span className="guess-icon seal"><IconDevice size={18} /></span>
        <div>
          <h2 style={{ margin: 0 }}>Paste the answer you got back</h2>
          <p className="small" style={{ margin: "4px 0 0" }}>Use the sealed text with any AI or person. Paste their reply here and Airlock puts the real details back — on this device only.</p>
        </div>
      </div>
      <textarea className="compose" style={{ minHeight: 110 }} value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. Dear [[PERSON_1]], thanks for letting me know about [[LOC_1]]…" aria-label="Answer to restore" />
      <div className="row"><button className="btn btn-primary" disabled={!text.trim()} onClick={() => { const t = text; setText(""); void s.restorePasted(threadId, t); }}>Restore real details</button></div>
    </div>
  );
}

function UserBubble({ turn, entities }: { turn: UserTurn; entities: { get(id: string): import("../../engine/types").Entity | undefined } }) {
  const [showRaw, setShowRaw] = useState(false);
  return (
    <div className="bubble user">
      <div className="row" style={{ marginBottom: 6 }}>
        <span className="small row" style={{ flex: 1, gap: 6 }}>{showRaw ? <><IconEye size={14} /> You wrote · never sent</> : <><IconShield size={14} /> What Gemini saw</>}</span>
        <button className="btn btn-ghost" style={{ minHeight: 32, padding: "4px 10px" }} aria-pressed={showRaw} onClick={() => setShowRaw(!showRaw)}>{showRaw ? "Show sealed" : "Show what I wrote"}</button>
      </div>
      {showRaw ? <div className="prose">{turn.raw}</div> : <SealedText text={turn.display} entities={entities} />}
      {turn.timings && <TimingDetails timings={turn.timings} />}
    </div>
  );
}

function AssistantBubble({ turn, waitingForYou, onContinue }: { turn: AssistantTurn; waitingForYou: boolean; onContinue?: () => void }) {
  const o = turn.outcome;
  return (
    <div className="bubble ai" aria-live="polite" aria-busy={turn.status === "streaming"}>
      <div style={{ marginBottom: 8 }}>{turn.pasted !== undefined ? <span className="badge phone"><IconDevice size={14} /> Pasted answer · restored on this device</span> : <RouteBadge outcome={o} streaming={turn.status === "streaming"} />}</div>
      <ToolLog tools={turn.tools} />
      {turn.status === "error" ? <Banner tone="risk" title={turn.error ?? "Something went wrong."} />
        : turn.segments.length ? <div className={turn.status === "streaming" ? "caret" : undefined}><RestoredAnswer segments={turn.segments} /></div>
        : waitingForYou ? <span className="small">Gemini is waiting for your answer below.</span>
        : <span className="typing" aria-label="Waiting for the answer"><i /><i /><i /></span>}
      {o && (
        <div className="receipt-line">
          {o.receipt ? <><span className="row" style={{ gap: 4 }}><IconLedger size={14} /> Receipt {o.receipt.id}</span><span className="mono">{o.receipt.outboundSha256.slice(0, 12)}…</span><span>{o.receipt.outboundChars} characters sent</span></> : <span>Nothing left this device — no receipt needed.</span>}
          {o.fidelity.guessedEntities.length > 0 && <span>· Gemini wrote a real detail it guessed — check the answer.</span>}
          {o.fidelity.unknownIds.length > 0 && <span>· The answer mentioned a placeholder Airlock doesn’t know.</span>}
        </div>
      )}
      {o?.truncated && (
        <div className="cut-short" role="status">
          <span>This answer was cut short.</span>
          {onContinue && <button className="btn" onClick={onContinue}>Continue</button>}
        </div>
      )}
    </div>
  );
}

export function ThreadScreen() {
  const s = useSession();
  const { threads, currentThreadId, consents } = useAirlock();
  const [text, setText] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const thread = threads.find((t) => t.id === currentThreadId);
  if (!thread) return <div className="stack"><h1>Not found</h1><button className="btn" onClick={() => s.go("ask")}>Back to Ask</button></div>;
  const busy = thread.turns.some((t) => t.kind === "assistant" && t.status === "streaming");
  const asking = consents.filter((c) => c.threadId === thread.id);

  return (
    <div className="stack">
      <div className="row">
        <h1 style={{ flex: 1 }}>{thread.title}</h1>
        <button className="btn btn-ghost" onClick={() => s.go("ask")}>New question</button>
        <button className="btn btn-ghost btn-danger" aria-label="Delete this conversation" onClick={() => setConfirmDelete(true)}><IconTrash size={16} /></button>
      </div>
      {confirmDelete && (
        <Banner tone="risk" title="Delete this conversation from this browser?" action={<div className="row"><button className="btn btn-danger" onClick={() => void s.deleteThread(thread.id)}>Delete</button><button className="btn btn-ghost" onClick={() => setConfirmDelete(false)}>Cancel</button></div>}>
          Your words, the answers and the real names for this conversation are removed. Its receipts stay in the Ledger so the chain can still be verified — they only ever held the sealed text.
        </Banner>
      )}
      {thread.mode === "scrub" && <Banner tone="ok" title="Sealed version copied">Airlock didn't send anything. The text you copied has your private details replaced, and the real ones stay here.</Banner>}
      {thread.turns.map((t, i) => (t.kind === "user" ? <UserBubble key={i} turn={t} entities={thread.entities} /> : <AssistantBubble key={i} turn={t} waitingForYou={t.status === "streaming" && asking.length > 0} onContinue={!busy && i === thread.turns.length - 1 ? () => void s.continueAnswer(thread.id) : undefined} />))}
      {asking.length > 0 && <div className="stack" style={{ gap: 10 }} aria-live="polite">{asking.map((c, i) => <ConsentCard key={c.id} consent={c} index={i} />)}</div>}
      {thread.mode === "scrub" && <PasteBack threadId={thread.id} />}
      {thread.mode !== "scrub" && !busy && s.services.mode !== "noCloud" && thread.turns.some((t) => t.kind === "assistant" && t.outcome?.receipt) && <GuessCard key={thread.turns.length} threadId={thread.id} entities={thread.entities} />}
      {thread.mode !== "scrub" && <div className="card stack" style={{ gap: 10 }}>
        <textarea className="compose" style={{ minHeight: 90 }} value={text} onChange={(e) => setText(e.target.value)} placeholder="Ask a follow-up — it gets sealed too" aria-label="Follow-up question" />
        <div className="row">
          <button className="btn btn-primary" disabled={!text.trim() || busy} onClick={() => { const t = text; setText(""); void s.startReview(t, { kind: "help" }, thread.id); }}>Continue</button>
          <span className="small">Real names show underlined: Gemini wrote placeholders and your device filled them in.</span>
        </div>
      </div>}
    </div>
  );
}
