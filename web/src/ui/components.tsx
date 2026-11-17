import type { ReactNode } from "react";
import { CHROME_ON_DEVICE_MODEL } from "../engine/engines";
import type { AnswerOutcome } from "../engine/answer";
import type { Replacement, SealDraft } from "../engine/sealer";
import type { RestoredSegment } from "../engine/restore";
import { type Entity, type PrivacyCategory, idCategory } from "../engine/types";

const ICON: Record<PrivacyCategory, string> = { person: "👤", org: "🏢", location: "📍", contact: "✉️", id: "#", date: "📅", health: "✚", secret: "🔑", quasi: "✦" };
const LABEL: Record<PrivacyCategory, string> = { person: "Person", org: "Organisation", location: "Place", contact: "Contact", id: "ID", date: "Date", health: "Health", secret: "Secret", quasi: "Detail" };

/** "Person 1 · landlord" */
export function chipLabel(e: Entity): string {
  if (e.id === "PERSON_ME") return "You";
  const n = e.id.split("_")[1];
  const role = e.roleHint?.replace(/^the (user|writer)'s /, "").replace(/^the (user|writer)$/, "you");
  return `${LABEL[e.category]} ${n}${role ? ` · ${role}` : ""}`;
}

export function Chip({ entity, kind, text, onClick }: { entity?: Entity; kind: Replacement["kind"]; text: string; onClick?: () => void }) {
  if (kind === "generalised" || kind === "bucketed" || kind === "redteam") {
    return <span className={`chip ${kind}`} title="Generalised on your device" aria-label={`Generalised: ${text}`}>✦ {text}</span>;
  }
  const category = entity?.category ?? "quasi";
  const low = entity && entity.confidence !== "high";
  const label = entity ? chipLabel(entity) : text;
  return (
    <span
      role="button" tabIndex={0} className={`chip ${category}${low ? " low" : ""}`} onClick={onClick}
      onKeyDown={(ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); onClick?.(); } }}
      aria-label={`${kind === "blocked" ? "Hidden secret" : "Protected"} ${label}${low ? ", possibly private" : ""}. Activate to send as written.`}
    >
      <span aria-hidden="true">{ICON[category]}</span> {label}
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
    parts.push(<Chip key={i} entity={e} kind={r.kind} text={draft.text.slice(r.sealedSpan.start, r.sealedSpan.end)} onClick={e && onChip ? () => onChip(e) : undefined} />);
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

export function RestoredAnswer({ segments }: { segments: RestoredSegment[] }) {
  return (
    <div className="prose">
      {segments.map((s, i) => {
        switch (s.kind) {
          case "text": return <span key={i}>{s.text}</span>;
          case "restored": return <span key={i} className="restored" title={`Gemini wrote ${s.original}; your device filled in the real detail.`}>{s.display}</span>;
          case "secret": return <span key={i} className="chip secret" aria-label="Hidden code — never shown">🔑 hidden code</span>;
          case "unknown": return <span key={i} className="chip id" title="The model invented a placeholder Airlock doesn't know">? unknown</span>;
        }
      })}
    </div>
  );
}

export function RouteBadge({ outcome, streaming }: { outcome: AnswerOutcome | null; streaming: boolean }) {
  if (!outcome) return <span className="badge cloud">{streaming ? "Answering…" : "—"}</span>;
  const secs = (outcome.latencyMs / 1000).toFixed(1);
  if (outcome.fellBackToPhone) return <span className="badge fallback">On this device · cloud unavailable · {secs}s</span>;
  if (outcome.ranOnDevice || outcome.modelVersion === CHROME_ON_DEVICE_MODEL) return <span className="badge phone">On this device · nothing sent · {secs}s</span>;
  return <span className="badge cloud">Gemini · {prettyModel(outcome.modelVersion)} · {secs}s</span>;
}

export const prettyModel = (m: string): string => m.replace(/^gemini-/, "").replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

export function Banner({ tone, title, children, action }: { tone: "info" | "ok" | "warn" | "risk"; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className={`banner ${tone}`} role={tone === "risk" ? "alert" : "status"}>
      <div style={{ flex: 1 }}>
        <div className="t">{title}</div>
        {children && <div className="small" style={{ color: "inherit" }}>{children}</div>}
      </div>
      {action}
    </div>
  );
}

export const categoryOf = idCategory;
