"""Metric definitions (docs/07-EVALUATION.md §4), computed from the runner's per-case records.

Conventions (also in docs/07 "As built"):
- A case whose egress gate blocked has no egress: nothing left, so it cannot leak. It counts in the
  doc-leak denominator, in `gate_block_rate`, and as a loss for quality (no answer). Recall, over-redaction
  and quasi coverage are measured on sent cases only.
- "Sealed or generalised" = the gold text no longer appears (folded, word-bounded) in the egress.
"""

from __future__ import annotations

from collections import Counter, defaultdict
from difflib import SequenceMatcher
from typing import Any, Iterable, Optional

from .stats import Estimate, bootstrap_mean, percentile, wilson
from .textmatch import contains, find_all, fold, mask_placeholders, tokens

DIRECT_TYPES = {"PERSON", "ORG", "LOCATION", "CONTACT", "ID", "SECRET"}
ALL_TYPES = ["PERSON", "ORG", "LOCATION", "CONTACT", "ID", "DATE", "HEALTH", "SECRET"]
ATTRIBUTES = ["name", "city", "employer", "occupation", "age"]
CONFIG_ORDER = ["A_raw", "B_rules", "C_rules_nl", "D_llm", "E_redteam", "F_vault", "G_naive_redact"]
CONFIG_LABELS = {
    "A_raw": "Unprotected", "B_rules": "Rules", "C_rules_nl": "+NL tagger", "D_llm": "+On-device model",
    "E_redteam": "+Red-team", "F_vault": "+Your Vault", "G_naive_redact": "Redact",
}
HEADLINE = "E_redteam"
HEADLINE_VAULT = "F_vault"

Record = dict[str, Any]


def is_dob(g: dict) -> bool:
    return g["type"] == "DATE" and "birth" in (g.get("role") or "").lower()


def is_direct(g: dict) -> bool:
    """PERSON, ORG, LOCATION (address/city), CONTACT, ID, SECRET, and DATE only when it is a date of birth."""
    return g["type"] in DIRECT_TYPES or is_dob(g)


def visible(text: str, egress: str) -> bool:
    return contains(text, egress)


def leaked(g: dict, egress: str) -> bool:
    """Gold text visible in egress; for PERSON also any first/last-name token of ≥ 3 characters."""
    if visible(g["text"], egress):
        return True
    if g["type"] == "PERSON":
        return any(contains(t, egress) for t in tokens(g["text"]))
    return False


def egress_body(rec: Record) -> Optional[str]:
    e = rec.get("egress")
    return None if e is None else mask_placeholders(e)


def leaked_gold(rec: Record) -> list[dict]:
    e = egress_body(rec)
    if e is None:
        return []
    return [g for g in rec["gold"] if is_direct(g) and leaked(g, e)]


def sealed(g: dict, egress: str) -> bool:
    return not visible(g["text"], egress)


def justified_spans(rec: Record) -> list[tuple[int, int]]:
    """Where sealing is warranted: every occurrence of a gold or quasi text, and of PERSON name tokens."""
    text = rec["text"]
    out: list[tuple[int, int]] = []
    for g in rec["gold"]:
        out += find_all(g["text"], text)
        if g["type"] == "PERSON":
            for t in tokens(g["text"]):
                out += find_all(t, text)
    for q in rec.get("quasi") or []:
        out += find_all(q["text"], text)
    return out


def over_redactions(rec: Record) -> tuple[int, int]:
    """(sealed spans not overlapping any gold/quasi occurrence, sealed spans)."""
    spans = rec.get("sealed_spans") or []
    just = justified_spans(rec)
    over = sum(1 for s in spans if not any(s["start"] < b and a < s["end"] for a, b in just))
    return over, len(spans)


def name_hit(guess: str, name: str) -> bool:
    gt = set(tokens(guess))
    return bool(gt) and bool(gt & set(tokens(name)))


def city_hit(guess: str, city: str, metro: Optional[str]) -> bool:
    g = fold(guess).strip()
    if not g:
        return False
    if g == fold(city) or contains(city, guess):
        return True
    return bool(metro) and (g == fold(metro) or contains(metro, guess))


def fuzzy(a: str, b: str) -> float:
    return SequenceMatcher(None, fold(a).strip(), fold(b).strip()).ratio()


def employer_hit(guess: str, employer: str) -> bool:
    return bool(guess.strip()) and fuzzy(guess, employer) >= 0.8


def occupation_hit(guess: str, occupation: str) -> bool:
    """Deterministic proxy for "judge-equivalent": fuzzy ≥ 0.8 or one contains the other (folded)."""
    g, o = fold(guess).strip(), fold(occupation).strip()
    if not g or not o:
        return False
    return fuzzy(g, o) >= 0.8 or o in g or g in o


def age_hit(guess: Any, age: int) -> bool:
    try:
        v = float(guess)
    except (TypeError, ValueError):
        return False
    return v > 0 and abs(v - age) <= 3


def attacker_hits(rec: Record) -> Optional[dict[str, bool]]:
    a = rec.get("attacker")
    if not a:
        return None
    p = rec["profile"]
    return {
        "name": name_hit(a.get("name", ""), p["name"]),
        "city": city_hit(a.get("city", ""), p["city"], p.get("metro")),
        "employer": employer_hit(a.get("employer", ""), p["employer"]),
        "occupation": occupation_hit(a.get("occupation", ""), p["occupation"]),
        "age": age_hit(a.get("age", 0), int(p.get("age") or 0)),
    }


def item_row(rec: Record) -> dict:
    """Per-case facts — also the BigQuery `items` row (eval/schemas/items.json)."""
    leaks = leaked_gold(rec)
    over, _ = over_redactions(rec) if rec.get("egress") is not None else (0, 0)
    judge = rec.get("judge") or {}
    restore = rec.get("restore") or {}
    return {
        "run_id": rec["run_id"], "item_id": rec["item_id"], "config": rec["config"], "doc_type": rec["doc_type"], "language": rec["language"],
        "words": rec["words"], "gold_count": len(rec["gold"]), "leaked_gold": len(leaks), "leaked_types": sorted({g["type"] for g in leaks}),
        "over_redactions": over, "sdp_findings": rec.get("sdp_findings"), "attacker_hits": attacker_hits(rec),
        "judge_winner": judge.get("winner"), "judge_quality": judge.get("quality") if judge.get("qualityOf") == "airlock" else None,
        "restore_ok": restore.get("ok") if restore else None, "seal_ms": rec.get("seal_ms"), "route": rec.get("route"),
        "on_device_answer": rec.get("on_device_answer"), "gate_passed": rec["gate"]["passed"],
    }


def _rate(cases: Iterable[bool]) -> Estimate:
    xs = list(cases)
    return wilson(sum(1 for x in xs if x), len(xs))


def config_metrics(recs: list[Record]) -> dict[str, Any]:
    """All docs/07 §4 metrics for one configuration's cases."""
    n = len(recs)
    sent = [r for r in recs if r.get("egress") is not None]
    m: dict[str, Any] = {"n": n, "n_sent": len(sent)}
    m["doc_leak_rate"] = _rate(bool(leaked_gold(r)) for r in recs)
    m["doc_leak_rate_sent"] = _rate(bool(leaked_gold(r)) for r in sent)
    m["gate_block_rate"] = _rate(not r["gate"]["passed"] for r in recs)
    m["review_required_rate"] = _rate(bool(r.get("requires_review")) for r in recs)

    recall: dict[str, Estimate] = {}
    for t in ALL_TYPES:
        flags = [sealed(g, egress_body(r) or "") for r in sent for g in r["gold"] if g["type"] == t and not (t == "DATE" and not is_dob(g))]
        recall[t] = _rate(flags)
    m["span_recall"] = recall
    m["span_recall_direct"] = _rate(sealed(g, egress_body(r) or "") for r in sent for g in r["gold"] if is_direct(g))
    m["names_caught"] = recall["PERSON"]

    over_k = over_n = 0
    for r in sent:
        o, s = over_redactions(r)
        over_k += o
        over_n += s
    m["over_redaction"] = wilson(over_k, over_n)
    m["quasi_coverage"] = _rate(not visible(q["text"], egress_body(r) or "") for r in sent for q in r.get("quasi") or [])

    hits = [h for h in (attacker_hits(r) for r in recs) if h is not None]
    m["reid"] = {a: _rate(h[a] for h in hits) for a in ATTRIBUTES}
    m["reid_two_attrs"] = _rate(sum(h.values()) >= 2 for h in hits)

    sdp = [r["sdp_findings"] for r in sent if r.get("sdp_findings") is not None]
    m["sdp"] = {"measured": len(sdp), "median": percentile(sdp, 50) if sdp else None, "max": max(sdp) if sdp else None}

    # Quality: answered cases with a verdict, plus every case that produced no answer (blocked/error) as a loss.
    judged = [r for r in recs if r.get("judge")]
    no_answer = [r for r in recs if r.get("answer_status") in ("blocked", "error")]
    if judged or no_answer:
        m["quality_win_tie"] = wilson(sum(1 for r in judged if r["judge"]["winner"] in ("airlock", "tie")), len(judged) + len(no_answer))
    else:
        m["quality_win_tie"] = wilson(0, 0)
    qs = [float(r["judge"]["quality"]) for r in judged if r["judge"].get("qualityOf") == "airlock" and r["judge"].get("quality") is not None]
    m["quality_mean"] = bootstrap_mean(qs)

    answered = [r for r in recs if r.get("answer_status") == "ok" and r.get("restore") is not None]
    m["restore_fidelity"] = _rate(bool(r["restore"]["ok"]) and not r["restore"]["unknown_ids"] for r in answered)
    m["model_name_leak"] = sum(1 for r in answered if r["restore"]["guessed_entities"])

    per100 = [100.0 * r["seal_ms"] / max(1, r["words"]) for r in sent if r.get("seal_ms") is not None and r["config"] != "A_raw"]
    m["seal_ms_per_100w"] = {"p50": percentile(per100, 50), "p95": percentile(per100, 95), "n": len(per100)}
    quick = [r for r in answered if r.get("quick_task")]
    m["on_device_share"] = _rate(bool(r.get("on_device_answer")) for r in quick)
    m["route_mix"] = dict(sorted(Counter(r.get("route") or ("blocked" if not r["gate"]["passed"] else "none") for r in recs).items()))
    return m


def by_config(records: list[Record]) -> dict[str, list[Record]]:
    groups: dict[str, list[Record]] = defaultdict(list)
    for r in records:
        groups[r["config"]].append(r)
    return {c: groups[c] for c in CONFIG_ORDER if c in groups} | {c: v for c, v in groups.items() if c not in CONFIG_ORDER}


def misses(recs: list[Record], limit: int = 3) -> list[dict]:
    """Real examples (synthetic data) of direct identifiers that still left, most common type first."""
    found: list[dict] = []
    for r in recs:
        for g in leaked_gold(r):
            found.append({"item_id": r["item_id"], "type": g["type"], "text": g["text"], "role": g.get("role", ""), "language": r["language"], "doc_type": r["doc_type"]})
    counts = Counter(f["type"] for f in found)
    out: list[dict] = []
    seen: set[tuple[str, str]] = set()
    for f in sorted(found, key=lambda f: (-counts[f["type"]], f["item_id"])):
        key = (f["type"], f["language"])
        if key in seen:
            continue
        seen.add(key)
        out.append(f)
        if len(out) >= limit:
            break
    return out


def score(records: list[Record]) -> dict[str, Any]:
    """Metrics per config, plus per-language slices for the doc leak rate."""
    out: dict[str, Any] = {"configs": {}, "slices": {}}
    for c, recs in by_config(records).items():
        out["configs"][c] = config_metrics(recs)
        langs: dict[str, list[Record]] = defaultdict(list)
        for r in recs:
            langs[r["language"]].append(r)
        out["slices"][c] = {f"language={l}": _rate(bool(leaked_gold(r)) for r in v) for l, v in sorted(langs.items())}
    return out


def metric_rows(run_id: str, scored: dict[str, Any]) -> list[dict]:
    """Flattens `score()` into BigQuery `metrics` rows (metric, value, ci_low, ci_high, slice)."""
    rows: list[dict] = []

    def add(metric: str, est: Any, slice_: str) -> None:
        if isinstance(est, Estimate):
            rows.append({"run_id": run_id, "metric": metric, "value": est.value, "ci_low": est.low, "ci_high": est.high, "slice": slice_})
        elif isinstance(est, (int, float)) or est is None:
            rows.append({"run_id": run_id, "metric": metric, "value": est, "ci_low": None, "ci_high": None, "slice": slice_})

    for c, m in scored["configs"].items():
        s = f"config={c}"
        for k, v in m.items():
            if isinstance(v, dict) and k in ("span_recall", "reid"):
                for sub, est in v.items():
                    add(f"{k}.{sub}", est, s)
            elif isinstance(v, dict) and k in ("seal_ms_per_100w", "sdp"):
                for sub, val in v.items():
                    add(f"{k}.{sub}", val, s)
            elif k != "route_mix":
                add(k, v, s)
        for route, count in m["route_mix"].items():
            add(f"route_mix.{route}", count, s)
        for sl, est in scored["slices"].get(c, {}).items():
            add("doc_leak_rate", est, f"{s};{sl}")
    return rows
