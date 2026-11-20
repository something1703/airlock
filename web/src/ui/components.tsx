import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { CHROME_ON_DEVICE_MODEL } from "../engine/engines";
import type { AnswerOutcome } from "../engine/answer";
import type { Replacement, SealDraft } from "../engine/sealer";
import type { RestoredSegment } from "../engine/restore";
import { parseMarkdown, type Inline, type ListBlock } from "./markdown";
import { type Entity, type PrivacyCategory, idCategory } from "../engine/types";
import { CATEGORY_ICON, IconAlert, IconCheck, IconCloud, IconDevice, IconQuestion, IconSecret, IconShield, IconSparkle } from "./icons";
const LABEL: Record<PrivacyCategory, string> = { person: "Person", org: "Organisation", location: "Place", contact: "Contact", id: "ID", date: "Date", health: "Health", secret: "Secret", quasi: "Detail" };

/** "Person 1 · landlord" */
export function chipLabel(e: Entity): string {
  if (e.id === "PERSON_ME") return "You";
  const n = e.id.split("_")[1];
  const role = e.roleHint?.replace(/^(?:the (?:user|writer)'s|my) /i, "").replace(/^the (user|writer)$/, "you");
  return `${LABEL[e.category]} ${n}${role ? ` · ${role}` : ""}`;
}

export function Chip({ entity, kind, text, onClick, index = 0 }: { entity?: Entity; kind: Replacement["kind"]; text: string; onClick?: () => void; index?: number }) {
  const style = { "--i": index } as CSSProperties;
  if (kind === "generalised" || kind === "bucketed" || kind === "redteam") {
    return <span className={`chip ${kind}`} style={style} title="Made less specific on your device" aria-label={`Made less specific: ${text}`}><IconSparkle /> {text}</span>;
  }
  const category = entity?.category ?? "quasi";
  const low = entity && entity.confidence !== "high";
  const label = entity ? chipLabel(entity) : text;
  const Icon = CATEGORY_ICON[category];
  return (
    <span
      role={onClick ? "button" : undefined} tabIndex={onClick ? 0 : undefined} style={style} className={`chip ${category}${low ? " low" : ""}`} onClick={onClick}
      onKeyDown={(ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); onClick?.(); } }}
      aria-label={`${kind === "blocked" ? "Hidden secret" : "Protected"} ${label}${low ? ", possibly private" : ""}${onClick ? ". Activate to send as written." : ""}`}
    >
      <Icon /> {label}
    </span>
  );
}

/** The sealed draft as it will leave: text with chips. */
export function SealedPreview({ draft, onChip }: { draft: SealDraft; onChip?: (e: Entity) => void }) {
  const parts: ReactNode[] = [];
  let cursor = 0;
  draft.replacements.forEach((r, i) => {
    if (r.sealedSpan.start > cursor) parts.push(draft.text.slice(cursor, r.sealedSpan.start));
    const e = r.entityId ? draft.entities.get(r.entityId) : undefined;
    parts.push(<Chip key={i} index={i} entity={e} kind={r.kind} text={draft.text.slice(r.sealedSpan.start, r.sealedSpan.end)} onClick={e && onChip ? () => onChip(e) : undefined} />);
    cursor = r.sealedSpan.end;
  });
  parts.push(draft.text.slice(cursor));
  return <div className="prose">{parts}</div>;
}

/** Placeholder tokens in sealed text rendered as chips (for sent turns, after the draft is gone). */
export function SealedText({ text, entities }: { text: string; entities: Map<string, Entity> | { get(id: string): Entity | undefined } }) {
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const m of text.matchAll(/\[\[([A-Z]+_(?:\d+|ME))\]\]/g)) {
    if (m.index! > cursor) parts.push(text.slice(cursor, m.index));
    const e = entities.get(m[1]!);
    parts.push(<Chip key={m.index} entity={e} kind="placeholder" text={m[0]} />);
    cursor = m.index! + m[0].length;
  }
  parts.push(text.slice(cursor));
  return <div className="prose">{parts}</div>;
}

function Atom({ seg }: { seg: Exclude<RestoredSegment, { kind: "text" }> }) {
  switch (seg.kind) {
    case "restored": return <span className="restored" title={`Gemini wrote ${seg.original}; your device filled in the real detail.`}>{seg.display}</span>;
    case "secret": return <span className="chip secret" aria-label="Hidden code — never shown"><IconSecret /> hidden code</span>;
    case "unknown": return <span className="chip id" title="The model invented a placeholder Airlock doesn't know"><IconQuestion /> unknown</span>;
  }
}

function Inlines({ nodes }: { nodes: readonly Inline[] }) {
  return (
    <>
      {nodes.map((n, i) => {
        switch (n.t) {
          case "text": return <span key={i}>{n.s}</span>;
          case "atom": return <Atom key={i} seg={n.seg} />;
          case "strong": return <strong key={i}><Inlines nodes={n.c} /></strong>;
          case "em": return <em key={i}><Inlines nodes={n.c} /></em>;
          case "code": return <code key={i}>{n.s}</code>;
          case "br": return <br key={i} />;
        }
      })}
    </>
  );
}

function MdList({ list }: { list: ListBlock }) {
  const items = list.items.map((it, i) => <li key={i}><Inlines nodes={it.c} />{it.sub && <MdList list={it.sub} />}</li>);
  return list.ordered ? <ol start={list.start}>{items}</ol> : <ul>{items}</ul>;
}

/** An answer with real details restored, rendered as a safe Markdown subset (no links, images or HTML). */
export function RestoredAnswer({ segments }: { segments: RestoredSegment[] }) {
  const blocks = parseMarkdown(segments);
  return (
    <div className="prose md">
      {blocks.map((b, i) => {
        switch (b.t) {
          case "h": return b.level === 1 ? <h3 key={i}><Inlines nodes={b.c} /></h3> : <h4 key={i}><Inlines nodes={b.c} /></h4>;
          case "p": return <p key={i}><Inlines nodes={b.c} /></p>;
          case "hr": return <hr key={i} />;
          case "list": return <MdList key={i} list={b} />;
        }
      })}
    </div>
  );
}

export function RouteBadge({ outcome, streaming }: { outcome: AnswerOutcome | null; streaming: boolean }) {
  if (!outcome) return <span className="badge cloud" role="status">{streaming ? <><span className="live" aria-hidden="true" /> Sealed request sent · answering…</> : "—"}</span>;
  const secs = (outcome.latencyMs / 1000).toFixed(1);
  if (outcome.fellBackToPhone) return <span className="badge fallback"><IconDevice size={14} /> On this device · cloud unavailable · {secs}s</span>;
  if (outcome.ranOnDevice || outcome.modelVersion === CHROME_ON_DEVICE_MODEL) return <span className="badge phone"><IconDevice size={14} /> On this device · nothing sent · {secs}s</span>;
  return <span className="badge cloud"><IconCloud size={14} /> Gemini · {prettyModel(outcome.modelVersion)} · {secs}s</span>;
}

export const prettyModel = (m: string): string => m.replace(/^gemini-/, "").replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

const BANNER_ICON = { info: IconSparkle, ok: IconShield, warn: IconAlert, risk: IconAlert };

export function Banner({ tone, title, children, action }: { tone: "info" | "ok" | "warn" | "risk"; title: string; children?: ReactNode; action?: ReactNode }) {
  const Icon = BANNER_ICON[tone];
  return (
    <div className={`banner ${tone} enter`} role={tone === "risk" ? "alert" : "status"}>
      <span style={{ marginTop: 2, color: tone === "ok" ? "var(--seal)" : tone === "info" ? "var(--cloud)" : tone === "warn" ? "var(--review)" : "var(--risk)" }}><Icon /></span>
      <div style={{ flex: 1 }}>
        <div className="t">{title}</div>
        {children && <div className="small" style={{ color: "inherit" }}>{children}</div>}
      </div>
      {action}
    </div>
  );
}

export const categoryOf = idCategory;

export { IconCheck };

/** Animated count from 0 → value (respects reduced motion). */
export function useCountUp(value: number, ms = 900): number {
  const [n, setN] = useState(value);
  const from = useRef(0);
  useEffect(() => {
    if (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches) { setN(value); return; }
    const start = performance.now();
    const a = from.current;
    let raf = 0;
    const tick = (t: number) => {
      const k = Math.min(1, (t - start) / ms);
      const eased = 1 - Math.pow(1 - k, 3);
      setN(Math.round(a + (value - a) * eased));
      if (k < 1) raf = requestAnimationFrame(tick);
      else from.current = value;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, ms]);
  return n;
}

/** Seconds since `since` (ticks every 100 ms while mounted). */
export function useElapsed(since: number): number {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    const id = setInterval(() => setNow(performance.now()), 100);
    return () => clearInterval(id);
  }, []);
  return Math.max(0, (now - since) / 1000);
}

/** Text with bare or bracketed placeholder ids (e.g. "lives near LOC_1") rendered as chips. */
export function WithChips({ text, entities }: { text: string; entities: { get(id: string): Entity | undefined } }) {
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const m of text.matchAll(/(?:\[\[)?\b((?:PERSON|ORG|LOC|CONTACT|ID|DATE|HEALTH|SECRET)_(?:\d+|ME))\b(?:\]\])?/g)) {
    if (m.index! > cursor) parts.push(text.slice(cursor, m.index));
    parts.push(<Chip key={m.index} entity={entities.get(m[1]!)} kind="placeholder" text={m[0]} />);
    cursor = m.index! + m[0].length;
  }
  parts.push(text.slice(cursor));
  return <>{parts}</>;
}
