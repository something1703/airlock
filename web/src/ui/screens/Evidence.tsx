import { useEffect, type CSSProperties, type ReactNode } from "react";
import { useSession } from "../../app/context";
import { loadEvidence, pct, type Evidence, type Measure } from "../../app/evidence";
import { Banner, useCountUp } from "../components";
import { IconAlert, IconDevice, IconLedger, IconShield, IconSparkle } from "../icons";

const LANG: Record<string, string> = { en: "English", es: "Spanish", de: "German", fr: "French", hi: "Hindi" };

function Tile({ label, m, definition, better, icon, index }: { label: string; m: Measure; definition: string; better: "lower" | "higher"; icon: ReactNode; index: number }) {
  const shown = useCountUp(Math.round(m.value * 1000)) / 10;
  return (
    <div className="card ev-tile enter" style={{ "--i": index } as CSSProperties}>
      <div className="row" style={{ gap: 8 }}><span className="ev-tile-icon">{icon}</span><span className="ev-tile-label">{label}</span></div>
      <div className="ev-num" aria-label={`${pct(m.value, 1)}, 95% interval ${pct(m.low, 1)} to ${pct(m.high, 1)}`}>{shown.toFixed(1)}%</div>
      <div className="ev-ci" aria-hidden="true">
        <svg viewBox="0 0 100 10" preserveAspectRatio="none">
          <rect x="0" y="4" width="100" height="2" rx="1" className="ev-track" />
          <rect x={m.low * 100} y="2" width={Math.max(0.8, (m.high - m.low) * 100)} height="6" rx="3" className="ev-range" />
          <rect x={m.value * 100 - 0.6} y="0" width="1.2" height="10" className="ev-point" />
        </svg>
      </div>
      <div className="small">95% interval {pct(m.low, 1)}–{pct(m.high, 1)} · n = {m.n} · {better} is better</div>
      <p className="small" style={{ margin: "6px 0 0" }}>{definition}</p>
    </div>
  );
}

const TICKS = [0, 0.25, 0.5, 0.75, 1];
const at = (v: number) => `${(Math.min(1, Math.max(0, v)) * 100).toFixed(2)}%`;

/**
 * Leak rate as each layer is added — hand-built bars with 95% interval whiskers. HTML rather than one SVG so the
 * labels stay readable at phone width (they move above the bars below 560px).
 */
function Ablation({ e }: { e: Evidence }) {
  const rows = e.ablation;
  return (
    <div className="ev-chart" role="img" aria-label={`Leak rate by configuration: ${rows.map((r) => `${r.label} ${pct(r.leak.value)}`).join(", ")}`}>
      {rows.map((r, i) => (
        <div key={r.config} className="ev-row" style={{ "--i": i } as CSSProperties}>
          <div className="ev-label">{r.label}</div>
          <div className="ev-plot">
            {TICKS.map((t) => <span key={t} className="ev-grid" style={{ left: at(t) }} />)}
            <span className={`ev-bar${i === rows.length - 1 ? " best" : ""}`} style={{ width: `max(3px, ${at(r.leak.value)})` }} />
            <span className="ev-whisker" style={{ left: at(r.leak.low), width: at(r.leak.high - r.leak.low) }} />
          </div>
          <div className="ev-value">{pct(r.leak.value)}</div>
        </div>
      ))}
      <div className="ev-row ev-axis-row" aria-hidden="true">
        <div className="ev-label" />
        <div className="ev-plot">{TICKS.map((t) => <span key={t} className="ev-tick" style={{ left: at(t) }}>{pct(t)}</span>)}</div>
        <div className="ev-value" />
      </div>
    </div>
  );
}

export function EvidenceScreen() {
  const s = useSession();
  const e = loadEvidence(s.services.config.string("evidence_json"));
  useEffect(() => {
    window.scrollTo({ top: 0 }); // opened from deep in Settings
  }, []);
  if (!e) return <div className="stack"><h1>How Airlock is tested</h1><Banner tone="info" title="No benchmark results are bundled with this build yet." /></div>;
  const langs = e.languages.map((l) => LANG[l] ?? l).join(", ");
  const date = new Date(e.createdAt).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
  return (
    <div className={`stack ev-screen${e.mock ? " is-mock" : ""}`}>
      <div>
        <h1>How Airlock is tested</h1>
        <p className="sub" style={{ margin: 0 }}>AirlockBench runs the same privacy engine on synthetic documents — fictional people, places and numbers — and measures what still gets through.</p>
      </div>
      {e.mock && (
        <Banner tone="warn" title={e.label ?? "MOCK RUN — not real model results"}>
          These numbers come from scripted stand-in models, to show what the report looks like. Real results are published here after the final evaluation run.
        </Banner>
      )}
      <div className="ev-tiles">
        <Tile index={0} icon={<IconShield size={16} />} label="Leak rate" m={e.leakRate} better="lower" definition="Share of documents where at least one direct identifier (name, address, number) left the device." />
        <Tile index={1} icon={<IconSparkle size={16} />} label="Names caught" m={e.namesCaught} better="higher" definition="Share of all personal names in the documents that were sealed before anything was sent." />
        <Tile index={2} icon={<IconLedger size={16} />} label="Answer quality" m={e.quality} better="higher" definition="Answers judged as good as or better than sending the raw text unprotected." />
        {e.onDevice && <Tile index={3} icon={<IconDevice size={16} />} label="Quick tasks on device" m={e.onDevice} better="higher" definition="Quick tasks answered entirely on the device — nothing sent at all." />}
      </div>
      <div className="card stack" style={{ gap: 10 }}>
        <h2 style={{ margin: 0 }}>Each layer lowers the leak rate</h2>
        <p className="small" style={{ margin: 0 }}>Same documents, one layer added at a time. Bars show the leak rate; whiskers its 95% interval.</p>
        <Ablation e={e} />
      </div>
      {e.misses.length > 0 && (
        <div className="card stack" style={{ gap: 8 }}>
          <div className="row" style={{ gap: 8 }}><IconAlert size={16} /><h2 style={{ margin: 0 }}>What we still miss</h2></div>
          <ul className="ev-misses">{e.misses.map((m, i) => <li key={i}>{m}</li>)}</ul>
          <p className="small" style={{ margin: 0 }}>Every miss above is from a synthetic document. This is why Review always shows you exactly what will leave, and why “Protect this” exists.</p>
        </div>
      )}
      <p className="small">Measured on {e.n} synthetic documents in {langs} on {date} ({e.dataset}, {e.split} split). Method and code: <a href={e.method} target="_blank" rel="noreferrer">github.com/something1703/airlock/eval</a>.</p>
    </div>
  );
}
