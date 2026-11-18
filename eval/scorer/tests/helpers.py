"""Tiny hand-built records (the runner's CaseRecord shape) whose metrics are computed by hand in the tests."""

from __future__ import annotations

import copy

TEXT = "Hi Maya Chen, call 555-0147. I work at Acme Corp in Oakby near the only lighthouse. Bob said hi."
EGRESS = "Hi [[PERSON_1]], call [[CONTACT_1]]. I work at an organisation in Oakby near a landmark. Maya said hi.\n\n[[PERSON_1]] — the user"
GOLD = [
    {"text": "Maya Chen", "type": "PERSON", "role": "the writer"},
    {"text": "555-0147", "type": "CONTACT", "role": "the writer's phone number"},
    {"text": "Acme Corp", "type": "ORG", "role": "the writer's employer"},
    {"text": "Oakby", "type": "LOCATION", "role": "the writer's town"},
    {"text": "Bob", "type": "PERSON", "role": "the writer's friend"},
    {"text": "3 May 1989", "type": "DATE", "role": "an appointment"},
]
PROFILE = {"name": "Maya Chen", "city": "Oakby", "employer": "Acme Corp", "age": 37, "occupation": "nurse", "metro": "Oakby Metro"}


def span(text: str, needle: str, kind: str = "placeholder", category: str = "person") -> dict:
    i = text.index(needle)
    return {"start": i, "end": i + len(needle), "kind": kind, "category": category, "text": needle}


def base(**over) -> dict:
    r = {
        "schema_version": 1, "run_id": "tiny", "mode": "mock", "item_id": "t-1", "dataset": "tiny", "split": "test", "config": "D_llm",
        "doc_type": "email to HR", "language": "en", "length": "short", "words": 20, "task_kind": "summary", "quick_task": True,
        "text": TEXT, "gold": copy.deepcopy(GOLD), "quasi": [{"text": "the only lighthouse", "reveals": "location"}], "profile": dict(PROFILE),
        "egress": EGRESS, "legend_count": 1, "gate": {"passed": True, "failed_checks": [], "counts": {}}, "requires_review": False, "review_reasons": [],
        "llm": None, "sealed_spans": [span(TEXT, "Hi"), span(TEXT, "Maya Chen"), span(TEXT, "555-0147", category="contact"), span(TEXT, "Acme Corp", "generalised", "org"), span(TEXT, "the only lighthouse", "redteam", "quasi")],
        "redteam": None, "seal_ms": 5.0, "route": "phoneFirst", "model_version": "chrome-gemini-nano", "on_device_answer": True, "answer_latency_ms": 1.0,
        "answer_status": "ok", "answer_error": None, "answer_model_text": "x", "answer_restored": "x", "restore": {"unknown_ids": [], "guessed_entities": [], "ok": True},
        "baseline_answer": None, "attacker": {"name": "Maya", "city": "Oakby Metro", "employer": "Acme Corp.", "age": 40, "occupation": ""},
        "judge": {"winner": "tie", "quality": 4, "qualityOf": "airlock", "missing": "", "swapped": False}, "eval_errors": [],
        "engines": {"mode": "mock", "phone": "mock-oracle(recall=1)", "answer": "mock-scripted", "rawBaseline": "mock-scripted", "attacker": "mock-string-match", "judge": "mock-scripted"},
    }
    r.update(over)
    return r


def blocked(**over) -> dict:
    """A case the egress gate blocked: nothing left the device, no answer, no attacker."""
    r = base(item_id="t-2", egress=None, legend_count=0, gate={"passed": False, "failed_checks": ["G2"], "counts": {}}, sealed_spans=[], seal_ms=7.0,
             route=None, model_version=None, on_device_answer=None, answer_status="blocked", answer_model_text=None, answer_restored=None, restore=None,
             attacker=None, judge=None, text="Ana Ruiz here, a short note.", gold=[{"text": "Ana Ruiz", "type": "PERSON", "role": "the writer"}], quasi=[],
             profile=dict(PROFILE, name="Ana Ruiz"))
    r.update(over)
    return r


MANIFEST = {
    "schema_version": 1, "run_id": "tiny", "mode": "mock", "label": "MOCK RUN — not real model results", "created_at": "2026-11-18T00:00:00Z", "finished_at": "2026-11-18T00:00:01Z",
    "git_sha": "0123456789abcdef", "git_dirty": False, "dataset": "tiny", "split": "test", "n_items": 2, "configs": ["A_raw", "D_llm", "E_redteam", "F_vault"], "skipped_configs": [],
    "engine": "TypeScript privacy engine", "engines": base()["engines"], "prompt_ids": {"detect.v1": "abc"}, "remote_config": {"dial_default": "balanced"},
    "models": {"deep": "m-deep"}, "platform": {"node": "v22", "os": "test", "cpu": "test"}, "records": 0,
}


def run_records() -> list[dict]:
    """A small multi-config run: A_raw baseline + D/E/F for two items."""
    out = []
    for item in (base(), blocked()):
        raw = dict(item, config="A_raw", egress=item["text"], gate={"passed": True, "failed_checks": [], "counts": {}}, answer_status="baseline", judge=None, route=None,
                   sealed_spans=[], baseline_answer="b", restore=None, attacker={"name": item["profile"]["name"], "city": "", "employer": "", "age": 0, "occupation": ""})
        out.append(raw)
        for c in ("D_llm", "E_redteam", "F_vault"):
            out.append(dict(item, config=c))
    return out
