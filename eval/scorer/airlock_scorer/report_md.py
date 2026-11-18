"""Markdown report in the docs/07 §6 layout. Never prints a number that was not measured: missing → "—"."""

from __future__ import annotations

from typing import Any, Optional

from .evidence import LANGUAGE_NAMES as LANG_NAMES
from .evidence import MOCK_LABEL, miss_text
from .metrics import ALL_TYPES, ATTRIBUTES, CONFIG_LABELS
from .stats import Estimate


def seconds(ms: float) -> str:
    return f"{ms / 1000:.2f} s" if ms >= 100 else f"{ms:.1f} ms"


def split_text(split: str) -> str:
    return "All splits" if split == "all" else f"{split.capitalize()} split"


def pct(e: Optional[Estimate], ci: bool = True) -> str:
    if e is None or e.value is None:
        return "—"
    s = f"{100 * e.value:.1f}%"
    return f"{s} ({100 * (e.low or 0):.1f}–{100 * (e.high or 0):.1f})" if ci else s


def num(v: Optional[float], unit: str = "", digits: int = 2) -> str:
    return "—" if v is None else f"{v:.{digits}f}{unit}"


def mean(e: Optional[Estimate]) -> str:
    if e is None or e.value is None:
        return "—"
    return f"{e.value:.2f} ({e.low:.2f}–{e.high:.2f})"


def banner(manifest: dict) -> list[str]:
    if manifest.get("mode") == "live":
        return []
    eng = manifest.get("engines") or {}
    return [
        f"> **⚠ {MOCK_LABEL}.** The on-device model is `{eng.get('phone')}` (it reads the gold labels), answers, judge and attacker",
        f"> are scripted (`{eng.get('answer')}`, `{eng.get('judge')}`, `{eng.get('attacker')}`). These numbers exercise the pipeline;",
        "> they say nothing about Apple's, Chrome's or Gemini's models. Leak and recall in the rules-only row (`B_rules`) involve no model",
        "> and do measure the TypeScript rules and egress gate; latency here is the pipeline with an instant mock model.",
        "",
    ]


def render(scored: dict[str, Any], manifest: dict, records: list[dict], misses: list[dict]) -> str:
    cfgs = scored["configs"]
    n_items = len({r["item_id"] for r in records})
    langs = ", ".join(LANG_NAMES.get(l, l) for l in sorted({r["language"] for r in records}))
    prompts = manifest.get("prompt_ids") or {}
    sha = (manifest.get("git_sha") or "unknown")[:7] + (" +dirty" if manifest.get("git_dirty") else "")
    plat = manifest.get("platform") or {}
    title_prompts = "/".join(p for p in ("detect.v1", "attack.v1", "gen.v1") if p in prompts) or "—"
    out: list[str] = [f"# Airlock benchmark — run {manifest.get('run_id')} (git {sha}, prompts {title_prompts})", ""]
    out += banner(manifest)
    out += [
        f"{split_text(manifest.get('split', 'test'))}: {n_items} synthetic documents · {langs} · {plat.get('cpu', '?')}, {plat.get('os', '?')}, Node {plat.get('node', '?')}",
        f"Engine: {manifest.get('engine', '?')}",
        "",
        "| Config | Doc leak rate | Names caught | Re-ID ≥2 attrs | Quality win+tie | Seal p50/100w |",
        "|--------|---------------|--------------|----------------|-----------------|---------------|",
    ]
    for c, m in cfgs.items():
        p50 = m["seal_ms_per_100w"]["p50"]
        seal = "—" if c == "A_raw" or p50 is None else seconds(p50)
        leak = "100% (by definition)" if c == "A_raw" else pct(m["doc_leak_rate"])
        out.append(f"| {CONFIG_LABELS.get(c, c)} (`{c}`) | {leak} | {pct(m['names_caught'], False) if c != 'A_raw' else '—'} | {pct(m['reid_two_attrs'], False)} | {pct(m['quality_win_tie'], False)} | {seal} |")
    out.append("")
    out.append("What we still miss (3 examples): " + ("; ".join(miss_text(x) for x in misses) if misses else "none in this run") + ".")
    sdp = [m["sdp"] for m in cfgs.values() if m["sdp"]["measured"]]
    if sdp:
        out.append(f"SDP findings on egress: median {num(sdp[0]['median'], digits=0)}, max {num(sdp[0]['max'], digits=0)} (headline config)")
    else:
        out.append("SDP findings on egress: not measured (Sensitive Data Protection runs only in the live scorer job).")
    out.append("Model Armor blocks during run: not measured.")
    skipped = manifest.get("skipped_configs") or []
    for s in skipped:
        out.append(f"Skipped `{s['config']}`: {s['reason']}.")
    out.append("")

    sealed_cfgs = {c: m for c, m in cfgs.items() if c != "A_raw"}
    out += ["## Detail", "", "### Leak, gate and review", "", "| Config | Doc leak (all docs) | Doc leak (sent docs) | Gate blocked | Review required | Over-redaction | Quasi coverage |", "|---|---|---|---|---|---|---|"]
    for c, m in sealed_cfgs.items():
        out.append(f"| `{c}` | {pct(m['doc_leak_rate'])} | {pct(m['doc_leak_rate_sent'])} | {pct(m['gate_block_rate'], False)} | {pct(m['review_required_rate'], False)} | {pct(m['over_redaction'], False)} | {pct(m['quasi_coverage'], False)} |")
    out += ["", "### Span recall by category (sent docs)", "", "| Config | " + " | ".join(ALL_TYPES) + " | Direct IDs |", "|---" * (len(ALL_TYPES) + 2) + "|"]
    for c, m in sealed_cfgs.items():
        out.append(f"| `{c}` | " + " | ".join(pct(m["span_recall"][t], False) for t in ALL_TYPES) + f" | {pct(m['span_recall_direct'])} |")
    out += ["", "DATE counts dates of birth only. Balanced keeps HEALTH and non-birth dates by design (docs/03 §2.1).", ""]
    out += ["### Re-identification (attacker)", "", "| Config | " + " | ".join(ATTRIBUTES) + " | ≥2 attrs |", "|---" * (len(ATTRIBUTES) + 2) + "|"]
    for c, m in cfgs.items():
        out.append(f"| `{c}` | " + " | ".join(pct(m["reid"][a], False) for a in ATTRIBUTES) + f" | {pct(m['reid_two_attrs'])} |")
    out += ["", "### Answers", "", "| Config | Quality win+tie | Mean quality (1–5) | Restore fidelity | Model name leaks | On-device share (quick tasks) | Routes |", "|---|---|---|---|---|---|---|"]
    for c, m in sealed_cfgs.items():
        routes = ", ".join(f"{k} {v}" for k, v in m["route_mix"].items())
        out.append(f"| `{c}` | {pct(m['quality_win_tie'])} | {mean(m['quality_mean'])} | {pct(m['restore_fidelity'], False)} | {m['model_name_leak']} | {pct(m['on_device_share'], False)} | {routes} |")
    out += ["", "### Seal latency (ms per 100 words)", "", "| Config | p50 | p95 |", "|---|---|---|"]
    for c, m in sealed_cfgs.items():
        s = m["seal_ms_per_100w"]
        out.append(f"| `{c}` | {num(s['p50'])} | {num(s['p95'])} |")
    out += ["", "### Doc leak rate by language", "", "| Config | " + " | ".join(sorted({k for v in scored['slices'].values() for k in v})) + " |"]
    keys = sorted({k for v in scored["slices"].values() for k in v})
    out.append("|---" * (len(keys) + 1) + "|")
    for c in sealed_cfgs:
        out.append(f"| `{c}` | " + " | ".join(pct(scored["slices"][c].get(k)) for k in keys) + " |")
    eng = manifest.get("engines") or {}
    out += ["", "### Run", "", f"- Mode: **{manifest.get('mode')}** · engines: " + ", ".join(f"{k} `{v}`" for k, v in eng.items() if k != "mode")]
    out.append("- Prompts: " + ", ".join(f"`{k}` {v}" for k, v in prompts.items()))
    out.append("- Models (Remote Config): " + ", ".join(f"{k} `{v}`" for k, v in (manifest.get("models") or {}).items()))
    out.append(f"- Created {manifest.get('created_at')} · finished {manifest.get('finished_at')} · records {manifest.get('records')}")
    out.append("- Intervals: Wilson 95% for rates, bootstrap (1,000 resamples) for means. Method: docs/07-EVALUATION.md.")
    return "\n".join(out) + "\n"
