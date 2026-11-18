"""`evidence_json` for the app's Evidence screen (docs/06-UI-UX.md §5.12; schema eval/schemas/evidence.schema.json).

Built from the same scored run as the report. A mock run is always marked `mock: true` with the label
"MOCK RUN — not real model results" so it can never be mistaken for measured model results.
"""

from __future__ import annotations

from typing import Any, Optional

from .metrics import CONFIG_LABELS, HEADLINE, HEADLINE_VAULT
from .stats import Estimate

SCHEMA_VERSION = 1
MOCK_LABEL = "MOCK RUN — not real model results"
METHOD_URL = "https://github.com/something1703/airlock/tree/main/eval"
ABLATION = ["B_rules", "D_llm", "E_redteam", "F_vault"]
REQUIRED_KEYS = [
    "schemaVersion", "mock", "label", "runId", "createdAt", "gitSha", "dataset", "split", "n", "languages", "engine", "onDeviceModel",
    "headlineConfig", "leakRate", "leakRateWithVault", "namesCaught", "quality", "onDevice", "restoreFidelity", "reidTwoAttrs",
    "gateBlockRate", "ablation", "misses", "method",
]


def _rate(e: Optional[Estimate]) -> Optional[dict]:
    if e is None or e.value is None:
        return None
    return {"value": round(e.value, 4), "low": round(e.low or 0.0, 4), "high": round(e.high or 0.0, 4), "n": e.n}


LANGUAGE_NAMES = {"en": "English", "es": "Spanish", "de": "German", "hi": "Hindi", "ja": "Japanese"}


def miss_text(m: dict) -> str:
    """e.g. "Person ‘Marcus’ (a parent in the writer's group chat) in an English group chat"."""
    lang = LANGUAGE_NAMES.get(m["language"], m["language"])
    article = "an" if lang[:1].lower() in "aeiou" else "a"
    return f"{m['type'].title()} ‘{m['text']}’ ({m['role']}) in {article} {lang} {m['doc_type']}"


def build(scored: dict[str, Any], manifest: dict, records: list[dict], misses: list[dict]) -> dict:
    cfgs = scored["configs"]
    head = HEADLINE if HEADLINE in cfgs else next((c for c in ("D_llm", "B_rules") if c in cfgs), None)
    h = cfgs.get(head, {}) if head else {}
    v = cfgs.get(HEADLINE_VAULT)
    mock = manifest.get("mode") != "live"
    items = {r["item_id"] for r in records}
    return {
        "schemaVersion": SCHEMA_VERSION,
        "mock": mock,
        "label": MOCK_LABEL if mock else None,
        "runId": manifest.get("run_id"),
        "createdAt": manifest.get("created_at"),
        "gitSha": manifest.get("git_sha"),
        "dataset": manifest.get("dataset"),
        "split": manifest.get("split"),
        "n": len(items),
        "languages": sorted({r["language"] for r in records}),
        "engine": manifest.get("engine"),
        "onDeviceModel": (manifest.get("engines") or {}).get("phone"),
        "headlineConfig": head,
        "leakRate": _rate(h.get("doc_leak_rate")),
        "leakRateWithVault": _rate(v["doc_leak_rate"]) if v else None,
        "namesCaught": _rate(h.get("names_caught")),
        "quality": _rate(h.get("quality_win_tie")),
        "onDevice": _rate(h.get("on_device_share")),
        "restoreFidelity": _rate(h.get("restore_fidelity")),
        "reidTwoAttrs": _rate(h.get("reid_two_attrs")),
        "gateBlockRate": _rate(h.get("gate_block_rate")),
        "ablation": [{"config": c, "label": CONFIG_LABELS[c], "leak": _rate(cfgs[c]["doc_leak_rate"])} for c in ABLATION if c in cfgs],
        "misses": [miss_text(m) for m in misses],
        "method": METHOD_URL,
    }


def validate(ev: dict) -> list[str]:
    """Schema check without third-party libraries (the JSON Schema file documents the same contract)."""
    problems = [f"missing {k}" for k in REQUIRED_KEYS if k not in ev]
    if ev.get("mock") is True and ev.get("label") != MOCK_LABEL:
        problems.append("mock evidence must carry the MOCK RUN label")
    if ev.get("mock") is False and ev.get("label") is not None:
        problems.append("live evidence must not carry a label")
    for k in ("leakRate", "leakRateWithVault", "namesCaught", "quality", "onDevice", "restoreFidelity", "reidTwoAttrs", "gateBlockRate"):
        r = ev.get(k)
        if r is None:
            continue
        if not all(x in r for x in ("value", "low", "high", "n")):
            problems.append(f"{k} must have value/low/high/n")
        elif not (0 <= r["low"] <= r["value"] <= r["high"] <= 1):
            problems.append(f"{k} must satisfy 0 ≤ low ≤ value ≤ high ≤ 1")
    if not isinstance(ev.get("ablation"), list) or not isinstance(ev.get("misses"), list):
        problems.append("ablation and misses must be lists")
    return problems
