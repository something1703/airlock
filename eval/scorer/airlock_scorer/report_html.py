"""Static HTML report with hand-made SVG charts (no chart libraries), light and dark themes.

Charts: doc leak rate by configuration (with Wilson 95% whiskers), span recall by category for the headline
configuration, and where answers ran (stacked). Every mark has a hover tooltip (<title>) and every chart has a
table view below it.
"""

from __future__ import annotations

from html import escape
from typing import Any, Optional

from .evidence import MOCK_LABEL, miss_text
from .metrics import ALL_TYPES, CONFIG_LABELS, HEADLINE
from .report_md import LANG_NAMES, mean, pct, split_text
from .stats import Estimate

CSS = """
:root { color-scheme: light; --surface:#fcfcfb; --surface-2:#f3f2ef; --text:#0b0b0b; --text-2:#52514e; --muted:#76746f; --grid:#e4e3df;
  --s1:#2a78d6; --s2:#eb6834; --s3:#1baf7a; --warn-bg:#fff4d6; --warn-border:#eda100; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { color-scheme: dark; --surface:#1a1a19; --surface-2:#242422; --text:#f0efec;
  --text-2:#c3c2b7; --muted:#9a998f; --grid:#3a3936; --s1:#3987e5; --s2:#d95926; --s3:#199e70; --warn-bg:#3a2e0b; --warn-border:#c98500; } }
:root[data-theme="dark"] { color-scheme: dark; --surface:#1a1a19; --surface-2:#242422; --text:#f0efec; --text-2:#c3c2b7; --muted:#9a998f;
  --grid:#3a3936; --s1:#3987e5; --s2:#d95926; --s3:#199e70; --warn-bg:#3a2e0b; --warn-border:#c98500; }
* { box-sizing: border-box; }
body { margin:0; background:var(--surface); color:var(--text); font:15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width:960px; margin:0 auto; padding:24px 16px 64px; }
h1 { font-size:1.5rem; margin:0 0 4px; } h2 { font-size:1.1rem; margin:32px 0 8px; }
.sub { color:var(--text-2); margin:0 0 16px; }
.banner { border:2px solid var(--warn-border); background:var(--warn-bg); border-radius:8px; padding:12px 14px; margin:16px 0; }
.banner strong { display:block; font-size:1.05rem; }
.tiles { display:grid; grid-template-columns:repeat(auto-fit, minmax(170px, 1fr)); gap:12px; margin:16px 0; }
.tile { background:var(--surface-2); border-radius:8px; padding:12px; }
.tile .v { font-size:1.6rem; font-weight:650; font-variant-numeric: tabular-nums; } .tile .l { color:var(--text-2); font-size:.85rem; }
.tile .ci { color:var(--muted); font-size:.8rem; }
svg { width:100%; height:auto; display:block; } svg text { fill:var(--text-2); font-size:12px; } svg .val { fill:var(--text); }
.grid { stroke:var(--grid); stroke-width:1; } .whisker { stroke:var(--text-2); stroke-width:1.5; }
.legend { display:flex; gap:16px; flex-wrap:wrap; color:var(--text-2); font-size:.85rem; margin:4px 0; }
.sw { display:inline-block; width:10px; height:10px; border-radius:2px; margin-right:6px; vertical-align:middle; }
.scroll { overflow-x:auto; } table { border-collapse:collapse; width:100%; font-size:.85rem; font-variant-numeric: tabular-nums; }
th, td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--grid); white-space:nowrap; } th { color:var(--text-2); font-weight:600; }
details { margin:8px 0; } summary { cursor:pointer; color:var(--text-2); }
ul { padding-left:20px; } code { font-size:.85em; }
"""

W = 720


def _bar_chart(rows: list[tuple[str, Optional[Estimate]]], title: str, series_var: str = "--s1") -> str:
    """Horizontal bars (0–100%) with optional CI whiskers. Single series → no legend; the title names it."""
    label_w, right_pad, bar_h, gap, top = 170, 70, 18, 12, 24
    plot_w = W - label_w - right_pad
    h = top + len(rows) * (bar_h + gap) + 20
    x = lambda v: label_w + plot_w * max(0.0, min(1.0, v))  # noqa: E731
    parts = [f'<svg viewBox="0 0 {W} {h}" role="img" aria-label="{escape(title)}">']
    for t in (0, 0.25, 0.5, 0.75, 1.0):
        parts.append(f'<line class="grid" x1="{x(t):.1f}" x2="{x(t):.1f}" y1="{top - 6}" y2="{h - 18}"/>')
        parts.append(f'<text x="{x(t):.1f}" y="{h - 4}" text-anchor="middle">{int(t * 100)}%</text>')
    for i, (label, e) in enumerate(rows):
        y = top + i * (bar_h + gap)
        parts.append(f'<text x="{label_w - 8}" y="{y + bar_h - 4}" text-anchor="end">{escape(label)}</text>')
        if e is None or e.value is None:
            parts.append(f'<text x="{label_w + 4}" y="{y + bar_h - 4}">not measured</text>')
            continue
        bw = max(2.0, x(e.value) - label_w)
        tip = escape(f"{label}: {pct(e)} · n={e.n}")
        parts.append(f'<g><title>{tip}</title><rect x="{label_w}" y="{y}" width="{bw:.1f}" height="{bar_h}" rx="4" fill="var({series_var})"/>')
        if e.low is not None and e.high is not None:
            cy = y + bar_h / 2
            parts.append(f'<line class="whisker" x1="{x(e.low):.1f}" x2="{x(e.high):.1f}" y1="{cy}" y2="{cy}"/>')
            parts.append(f'<line class="whisker" x1="{x(e.low):.1f}" x2="{x(e.low):.1f}" y1="{cy - 4}" y2="{cy + 4}"/><line class="whisker" x1="{x(e.high):.1f}" x2="{x(e.high):.1f}" y1="{cy - 4}" y2="{cy + 4}"/>')
        parts.append(f'<text class="val" x="{max(x(e.value), x(e.high or 0)) + 6:.1f}" y="{y + bar_h - 4}">{100 * e.value:.1f}%</text></g>')
    parts.append("</svg>")
    return "".join(parts)


ROUTE_SERIES = [("on device", "--s1"), ("cloud", "--s2"), ("not sent (gate)", "--s3")]


def _route_split(m: dict) -> tuple[int, int, int]:
    mix = m["route_mix"]
    blocked = mix.get("blocked", 0)
    answered = m["n"] - blocked
    on_device = round(m["on_device_share"].k or 0) if m["on_device_share"].n else 0
    return on_device, max(0, answered - on_device), blocked


def _stacked(rows: list[tuple[str, tuple[int, int, int]]]) -> str:
    label_w, right_pad, bar_h, gap, top = 170, 20, 18, 12, 8
    plot_w = W - label_w - right_pad
    h = top + len(rows) * (bar_h + gap) + 8
    parts = [f'<svg viewBox="0 0 {W} {h}" role="img" aria-label="Where answers ran, by configuration">']
    for i, (label, counts) in enumerate(rows):
        y = top + i * (bar_h + gap)
        total = max(1, sum(counts))
        parts.append(f'<text x="{label_w - 8}" y="{y + bar_h - 4}" text-anchor="end">{escape(label)}</text>')
        x0 = float(label_w)
        for (name, var), c in zip(ROUTE_SERIES, counts):
            if c == 0:
                continue
            w = plot_w * c / total
            # 2px surface gap between adjacent segments.
            parts.append(f'<g><title>{escape(f"{label} — {name}: {c} of {sum(counts)} ({100 * c / total:.0f}%)")}</title><rect x="{x0:.1f}" y="{y}" width="{max(1.0, w - 2):.1f}" height="{bar_h}" rx="3" fill="var({var})"/></g>')
            x0 += w
    parts.append("</svg>")
    return "".join(parts)


def _table(headers: list[str], rows: list[list[str]]) -> str:
    th = "".join(f"<th>{escape(h)}</th>" for h in headers)
    trs = "".join("<tr>" + "".join(f"<td>{escape(c)}</td>" for c in r) + "</tr>" for r in rows)
    return f'<div class="scroll"><table><thead><tr>{th}</tr></thead><tbody>{trs}</tbody></table></div>'


def _tile(label: str, e: Optional[Estimate], note: str = "") -> str:
    v = "—" if e is None or e.value is None else f"{100 * e.value:.1f}%"
    ci = "" if e is None or e.value is None or e.low is None else f"95% CI {100 * e.low:.1f}–{100 * e.high:.1f}% · n={e.n}"
    return f'<div class="tile"><div class="v">{v}</div><div class="l">{escape(label)}</div><div class="ci">{escape(ci or note)}</div></div>'


def render(scored: dict[str, Any], manifest: dict, records: list[dict], misses: list[dict]) -> str:
    cfgs = scored["configs"]
    mock = manifest.get("mode") != "live"
    head = HEADLINE if HEADLINE in cfgs else next(iter(c for c in cfgs if c != "A_raw"), None)
    hm = cfgs.get(head, {}) if head else {}
    sealed = [(c, m) for c, m in cfgs.items() if c != "A_raw"]
    n_items = len({r["item_id"] for r in records})
    langs = ", ".join(LANG_NAMES.get(l, l) for l in sorted({r["language"] for r in records}))
    sha = (manifest.get("git_sha") or "unknown")[:7]
    title = "Airlock benchmark (mock run)" if mock else "Airlock benchmark"
    eng = manifest.get("engines") or {}

    body = [f"<h1>{escape(title)} — {escape(str(manifest.get('run_id')))}</h1>",
            f'<p class="sub">{n_items} synthetic documents · {escape(langs)} · {escape(split_text(manifest.get("split", "test")))} · git {escape(sha)}</p>']
    if mock:
        body.append(f'<div class="banner" role="note"><strong>⚠ {escape(MOCK_LABEL)}</strong>The on-device model is a mock that reads the gold labels '
                    f'(<code>{escape(str(eng.get("phone")))}</code>); answers, judge and attacker are scripted. These numbers exercise the pipeline and say '
                    "nothing about Apple's, Chrome's or Gemini's models. Rules-only leak and recall involve no model.</div>")
    body.append('<div class="tiles">')
    body.append(_tile(f"Doc leak rate ({CONFIG_LABELS.get(head, head)})", hm.get("doc_leak_rate")))
    if "F_vault" in cfgs:
        body.append(_tile("Doc leak rate (+Your Vault)", cfgs["F_vault"]["doc_leak_rate"]))
    body.append(_tile("Names caught", hm.get("names_caught")))
    body.append(_tile("Answer quality vs unprotected (win+tie)", hm.get("quality_win_tie")))
    body.append(_tile("Quick answers on device", hm.get("on_device_share")))
    body.append("</div>")

    body.append("<h2>Doc leak rate by configuration</h2>")
    leak_rows = [(CONFIG_LABELS.get(c, c), m["doc_leak_rate"]) for c, m in sealed]
    body.append(_bar_chart(leak_rows, "Doc leak rate by configuration, with 95% intervals"))
    body.append("<details><summary>Table view</summary>" + _table(["Config", "Doc leak rate", "Sent-doc leak", "Gate blocked", "n"],
                [[f"{CONFIG_LABELS.get(c, c)} ({c})", pct(m["doc_leak_rate"]), pct(m["doc_leak_rate_sent"]), pct(m["gate_block_rate"], False), str(m["n"])] for c, m in sealed]) + "</details>")

    if hm:
        body.append(f"<h2>Span recall by category — {escape(CONFIG_LABELS.get(head, head))}</h2>")
        body.append(_bar_chart([(t, hm["span_recall"][t]) for t in ALL_TYPES], "Span recall by category"))
        body.append('<p class="sub">DATE counts dates of birth only. Health details are generalised on Strict, kept on Balanced (docs/03 §2.1).</p>')

    body.append("<h2>Where answers ran</h2>")
    body.append('<div class="legend">' + "".join(f'<span><span class="sw" style="background:var({v})"></span>{escape(n)}</span>' for n, v in ROUTE_SERIES) + "</div>")
    body.append(_stacked([(CONFIG_LABELS.get(c, c), _route_split(m)) for c, m in sealed]))

    body.append("<h2>All metrics</h2>")
    body.append(_table(["Config", "Leak", "Names", "Direct-ID recall", "Over-redaction", "Quasi coverage", "Re-ID ≥2", "Quality", "Mean quality", "Restore", "On device", "Seal p50 ms/100w"],
                       [[c, pct(m["doc_leak_rate"]) if c != "A_raw" else "100% (definition)", pct(m["names_caught"], False), pct(m["span_recall_direct"], False), pct(m["over_redaction"], False),
                         pct(m["quasi_coverage"], False), pct(m["reid_two_attrs"], False), pct(m["quality_win_tie"], False), mean(m["quality_mean"]), pct(m["restore_fidelity"], False),
                         pct(m["on_device_share"], False), "—" if m["seal_ms_per_100w"]["p50"] is None or c == "A_raw" else f"{m['seal_ms_per_100w']['p50']:.2f}"] for c, m in cfgs.items()]))

    body.append("<h2>What we still miss</h2>")
    body.append("<ul>" + ("".join(f"<li>{escape(miss_text(x))}</li>" for x in misses) or "<li>Nothing in this run.</li>") + "</ul>")
    skipped = manifest.get("skipped_configs") or []
    if skipped:
        body.append("<ul>" + "".join(f"<li>Skipped <code>{escape(s['config'])}</code>: {escape(s['reason'])}.</li>" for s in skipped) + "</ul>")
    body.append(f'<p class="sub">Intervals: Wilson 95% for rates, bootstrap (1,000 resamples) for means. Method: docs/07-EVALUATION.md. Engine: {escape(str(manifest.get("engine")))}.</p>')
    return (
        '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
        f"<title>{escape(title)}</title><style>{CSS}</style></head><body><main>" + "".join(body) + "</main></body></html>\n"
    )
