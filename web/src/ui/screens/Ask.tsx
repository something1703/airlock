import { useState } from "react";
import { useAirlock, useSession } from "../../app/context";
import type { TaskKind } from "../../engine/answer";
import { OnDeviceStatus } from "./OnDeviceStatus";
import { CheckScamButton } from "./Proof";
import { IconArrow, IconCloud, IconDevice, IconSparkle } from "../icons";

export const TASKS: { label: string; task: TaskKind }[] = [
  { label: "Help me with this", task: { kind: "help" } },
  { label: "Draft a reply", task: { kind: "reply", tone: "firm but polite" } },
  { label: "Explain simply", task: { kind: "explain" } },
  { label: "Summarise", task: { kind: "summary" } },
  { label: "Questions to ask", task: { kind: "questions" } },
  { label: "List actions", task: { kind: "actions" } },
];

const SAMPLE = "Hi Raj, the heater at 14 Elm St, Apt 3B has been broken since Oct 28. I've texted you four times. I work nights at Mercy General Hospital and need to sleep during the day — please send someone this week. You can reach me on 312-555-0147. Thanks, Maya Chen";

export function Ask() {
  const s = useSession();
  const { threads } = useAirlock();
  const [text, setText] = useState("");
  const [task, setTask] = useState<TaskKind>(TASKS[0]!.task);

  return (
    <div className="stack">
      <div>
        <h1>Ask</h1>
        <p className="sub">Paste anything. Your device reads it first and seals what identifies you.</p>
      </div>
      <OnDeviceStatus />
      <textarea className="compose enter" value={text} onChange={(e) => { setText(e.target.value); s.warmUp(); }} placeholder="Paste a tense text thread, a lease clause, a strange message…" aria-label="Your message" />
      <div className="row" role="group" aria-label="What do you want?">
        {TASKS.map((t) => (
          <button key={t.label} className="pill" aria-pressed={JSON.stringify(t.task) === JSON.stringify(task)} onClick={() => setTask(t.task)}>{t.label}</button>
        ))}
      </div>
      <div className="row">
        <button className="btn btn-primary" disabled={!text.trim()} onClick={() => void s.startReview(text, task)}><span className="row" style={{ gap: 8 }}>Seal on this device <IconArrow size={16} /></span></button>
        <CheckScamButton text={text} />
        <button className="btn btn-ghost" onClick={() => { setText(SAMPLE); s.warmUp(); }}><span className="row" style={{ gap: 6 }}><IconSparkle size={16} /> Try a sample (fictional)</span></button>
      </div>
      {threads.length > 0 && (
        <div className="card enter">
          <h2>Recent</h2>
          {threads.map((t) => {
            const last = [...t.turns].reverse().find((x) => x.kind === "assistant");
            const onDevice = last?.kind === "assistant" && last.outcome?.ranOnDevice;
            return (
              <button key={t.id} className="nav-btn" style={{ width: "100%" }} onClick={() => s.openThread(t.id)}>
                <span style={{ flex: 1 }}>{t.title}</span>
                <span className="small row" style={{ gap: 4 }}>{onDevice ? <><IconDevice size={14} /> on device</> : <><IconCloud size={14} /> Gemini</>}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
