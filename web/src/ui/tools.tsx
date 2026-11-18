// Private tools UI: the consent card (Gemini asks → you decide) and the per-answer log of what was shared.
import { useEffect, useRef, useState, type ChangeEvent, type CSSProperties, type ReactNode } from "react";
import { useAirlock, useSession } from "../app/context";
import type { PendingConsent } from "../app/session";
import type { ToolActivity, ToolStatus } from "../engine/tools";
import { IconAskFirst, IconBlocked, IconCheck, IconFreeTime, IconRole, IconToday, IconUpload } from "./icons";

type IconC = (p: { size?: number }) => ReactNode;
const TOOL_ICON: Record<string, IconC> = { today_context: IconToday, find_free_slots: IconFreeTime, get_entity_role: IconRole };
const TOOL_NAME: Record<string, string> = { today_context: "Today’s date", find_free_slots: "Your free time", get_entity_role: "A placeholder’s role" };
export const toolName = (tool: string): string => TOOL_NAME[tool] ?? "A tool Airlock doesn’t have";

/** Inline card: what Gemini asked for, exactly what would be shared, and the choice. */
export function ConsentCard({ consent, index = 0 }: { consent: PendingConsent; index?: number }) {
  const s = useSession();
  const allow = useRef<HTMLButtonElement>(null);
  const Icon = TOOL_ICON[consent.tool] ?? IconAskFirst;
  const titleId = `consent-${consent.id.replace(/[^A-Za-z0-9_-]/g, "")}`;
  useEffect(() => {
    // Move focus to the first open card only (never steal it from another card).
    if (!document.activeElement?.closest(".consent-card")) allow.current?.focus({ preventScroll: true });
  }, []);
  return (
    <section className="consent-card" role="group" aria-labelledby={titleId} style={{ "--i": index } as CSSProperties}>
      <div className="row" style={{ alignItems: "flex-start", flexWrap: "nowrap", gap: 12 }}>
        <span className="consent-icon"><Icon size={20} /></span>
        <div style={{ flex: 1 }}>
          <div className="consent-kicker"><IconAskFirst size={14} /> Gemini is asking first</div>
          <div id={titleId} className="consent-title">{consent.title}</div>
          <p className="small" style={{ margin: "4px 0 0" }}>{consent.shares}</p>
        </div>
      </div>
      <div className="row consent-actions">
        <button ref={allow} className="btn btn-primary" onClick={() => s.answerConsent(consent.id, "allow")}>Allow once</button>
        <button className="btn" onClick={() => s.answerConsent(consent.id, "deny")}>Don’t allow</button>
        <button className="btn btn-ghost small-btn" onClick={() => s.answerConsent(consent.id, "allow", true)} aria-label={`Always allow ${toolName(consent.tool).toLowerCase()} without asking`}>Always allow</button>
      </div>
      <p className="small" style={{ margin: 0 }}>Airlock checks the result for private details before it goes back to Gemini.</p>
    </section>
  );
}

const STATUS: Record<ToolStatus, { text: string; tone: "ok" | "muted" | "risk" | "wait" }> = {
  asking: { text: "Waiting for you", tone: "wait" },
  allowed: { text: "Shared", tone: "ok" },
  declined: { text: "You said no", tone: "muted" },
  withheld: { text: "Withheld: it held a private detail", tone: "risk" },
  invalid: { text: "Not available", tone: "muted" },
  limit: { text: "Stopped: too many requests", tone: "muted" },
};

function pretty(json: string | null): string {
  if (!json) return "";
  try {
    return JSON.stringify(JSON.parse(json), null, 2);
  } catch {
    return json;
  }
}

/** What Gemini asked for while answering, and the exact (gate-checked) reply each request got. */
export function ToolLog({ tools }: { tools: ToolActivity[] }) {
  if (!tools.length) return null;
  return (
    <div className="tool-log" role="list" aria-label="Private tools Gemini asked for">
      {tools.map((t, i) => {
        const Icon = TOOL_ICON[t.tool] ?? IconAskFirst;
        const st = STATUS[t.status];
        return (
          <details key={t.id} className={`tool-item ${st.tone}`} role="listitem" style={{ "--i": i } as CSSProperties}>
            <summary>
              <Icon size={16} />
              <span className="tool-name">{toolName(t.tool)}</span>
              <span className={`tool-status ${st.tone}`}>{st.tone === "ok" ? <IconCheck size={13} /> : st.tone === "risk" ? <IconBlocked size={13} /> : null}{st.text}</span>
            </summary>
            {t.shared && (
              <div className="tool-detail">
                <div className="small">Exactly what went back to Gemini:</div>
                <pre className="mono">{pretty(t.shared)}</pre>
              </div>
            )}
          </details>
        );
      })}
    </div>
  );
}

/** Settings → Private tools: import or remove the calendar, reset "Always allow". */
export function PrivateToolsSettings() {
  const s = useSession();
  const { calendar, prefs } = useAirlock();
  const [note, setNote] = useState<{ tone: "ok" | "risk"; text: string } | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const enabled = s.services.config.calendarToolEnabled;

  const onFile = async (e: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    if (f.size > 5_000_000) { setNote({ tone: "risk", text: "That file is too large. Export a smaller calendar (5 MB at most)." }); return; }
    const ok = await s.importCalendar(await f.text());
    setNote(ok ? { tone: "ok", text: "Calendar imported. Only busy times were kept." } : { tone: "risk", text: "Airlock couldn’t find any events in that file. Choose an .ics calendar export." });
  };

  return (
    <div className="card stack enter" style={{ gap: 12 }}>
      <div>
        <h2>Private tools</h2>
        <p className="small" style={{ margin: 0 }}>When it helps, Gemini can ask for a few facts that stay on this device: today’s date, the role behind a placeholder, or your free time. You decide each time. Airlock checks every answer for private details before it goes back.</p>
      </div>
      <div className="tool-cal">
        <span className="consent-icon"><IconFreeTime size={20} /></span>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 600 }}>{calendar ? (calendar.sample ? "Sample calendar (fictional)" : "Your calendar") : "No calendar imported"}</div>
          <div className="small">
            {calendar
              ? `${calendar.events} busy ${calendar.events === 1 ? "time" : "times"} · imported ${new Date(calendar.importedAt).toLocaleDateString()} · event names, places and people were never read.`
              : "Import an .ics file to let Gemini suggest meeting times. It’s read in this browser and stored encrypted here. It’s never uploaded."}
          </div>
        </div>
      </div>
      {!enabled && <p className="small" style={{ margin: 0 }}>The free-time tool is switched off for now.</p>}
      <div className="row">
        <input ref={file} type="file" accept=".ics,text/calendar" hidden onChange={(e) => void onFile(e)} aria-hidden="true" tabIndex={-1} />
        <button className="btn" onClick={() => file.current?.click()}><span className="row" style={{ gap: 6 }}><IconUpload size={16} /> {calendar ? "Replace calendar…" : "Import .ics file…"}</span></button>
        {!calendar && <button className="btn btn-ghost" onClick={() => void s.useSampleCalendar().then(() => setNote({ tone: "ok", text: "Sample calendar loaded. It’s fictional." }))}>Use a sample calendar</button>}
        {calendar && <button className="btn btn-ghost btn-danger" onClick={() => void s.removeCalendar().then(() => setNote(null))}>Remove calendar</button>}
      </div>
      {note && <p className={`small note-${note.tone}`} role="status" style={{ margin: 0 }}>{note.text}</p>}
      {prefs.toolsAlwaysAllow.length > 0 && (
        <div className="row" style={{ justifyContent: "space-between" }}>
          <span className="small">Always allowed: {prefs.toolsAlwaysAllow.map((t) => toolName(t).toLowerCase()).join(", ")}.</span>
          <button className="btn btn-ghost" onClick={() => s.resetAlwaysAllow()}>Ask me every time</button>
        </div>
      )}
    </div>
  );
}
