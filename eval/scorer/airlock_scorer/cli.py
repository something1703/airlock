"""Scorer CLI.

  python3 -I eval/scorer/score.py report --run-dir eval/runs/<runId> [--out DIR]     # local, mock or live records
  python3 -I eval/scorer/score.py upload --run-dir … --bucket … --project … --live --i-have-permission
  python3 -I eval/scorer/score.py job --run-id … --bucket … --project … [--bq-dataset airlock_eval] --live --i-have-permission
  python3 -I eval/scorer/score.py live-check

`job` is the Cloud Run Job entrypoint (docs/07 §7): GCS items → SDP inspect → metrics → BigQuery → reports to GCS.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any, Mapping, Optional

from . import evidence, metrics, report_html, report_md
from .cloud import Clients, bq_items_row, inspect_records, jsonl, live_clients, parse_jsonl, run_paths, run_row
from .live_gate import LiveRefused, assert_live_allowed
from .stats import Estimate


def _plain(o: Any) -> Any:
    if isinstance(o, Estimate):
        return o.as_dict()
    if isinstance(o, dict):
        return {k: _plain(v) for k, v in o.items()}
    if isinstance(o, list):
        return [_plain(v) for v in o]
    return o


def build_outputs(records: list[dict], manifest: dict) -> dict[str, str]:
    """Everything a run produces, as {filename: text}: metrics.json, report.md, report.html, evidence.json."""
    scored = metrics.score(records)
    head = metrics.HEADLINE if metrics.HEADLINE in scored["configs"] else next(iter(scored["configs"]), None)
    miss = metrics.misses(metrics.by_config(records).get(head, [])) if head else []
    ev = evidence.build(scored, manifest, records, miss)
    problems = evidence.validate(ev)
    if problems:
        raise ValueError("evidence_json invalid: " + "; ".join(problems))
    return {
        "metrics.json": json.dumps({"run_id": manifest.get("run_id"), "mode": manifest.get("mode"), "label": ev["label"], **_plain(scored)}, indent=2, ensure_ascii=False) + "\n",
        "report.md": report_md.render(scored, manifest, records, miss),
        "report.html": report_html.render(scored, manifest, records, miss),
        "evidence.json": json.dumps(ev, indent=2, ensure_ascii=False) + "\n",
    }


def load_run(run_dir: Path) -> tuple[list[dict], dict]:
    records = parse_jsonl((run_dir / "items.jsonl").read_text(encoding="utf-8"))
    manifest = json.loads((run_dir / "manifest.json").read_text(encoding="utf-8"))
    return records, manifest


def cmd_report(a: argparse.Namespace, out: Any) -> int:
    run_dir = Path(a.run_dir)
    records, manifest = load_run(run_dir)
    target = Path(a.out) if a.out else run_dir
    target.mkdir(parents=True, exist_ok=True)
    files = build_outputs(records, manifest)
    for name, text in files.items():
        (target / name).write_text(text, encoding="utf-8")
    if manifest.get("mode") != "live":
        print(f"⚠ {evidence.MOCK_LABEL}", file=out)
    print(f"✔ {len(records)} records scored → {target}/{{report.md,report.html,evidence.json,metrics.json}}", file=out)
    return 0


def run_job(run_id: str, bucket: str, clients: Clients, sdp_qps: float = 5.0, sleep: Any = None) -> dict[str, str]:
    """Cloud Run Job body (clients injected so it is testable with fakes)."""
    paths = run_paths(run_id)
    records = parse_jsonl(clients.storage.read_text(bucket, paths["items"]))
    manifest = json.loads(clients.storage.read_text(bucket, paths["manifest"]))
    kwargs = {"sleep": sleep} if sleep else {}
    inspect_records(records, clients.inspector, qps=sdp_qps, **kwargs)
    files = build_outputs(records, manifest)
    clients.warehouse.insert_rows("runs", [run_row(manifest)])
    clients.warehouse.insert_rows("items", [bq_items_row(metrics.item_row(r)) for r in records])
    clients.warehouse.insert_rows("metrics", metrics.metric_rows(run_id, metrics.score(records)))
    types = {"metrics.json": "application/json", "evidence.json": "application/json", "report.md": "text/markdown", "report.html": "text/html"}
    for name, text in files.items():
        clients.storage.write_text(bucket, f"{paths['reports']}/{name}", text, types[name])
    return files


def _live(a: argparse.Namespace, env: Mapping[str, str]) -> None:
    assert_live_allowed(bool(a.live), bool(a.i_have_permission), env)


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="score.py", description="AirlockBench scorer (docs/07-EVALUATION.md §7)")
    sub = p.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("report", help="score a local run directory (no network)")
    r.add_argument("--run-dir", required=True)
    r.add_argument("--out")
    for name in ("upload", "job", "live-check"):
        s = sub.add_parser(name)
        s.add_argument("--live", action="store_true")
        s.add_argument("--i-have-permission", action="store_true")
        if name != "live-check":
            s.add_argument("--bucket", required=True)
            s.add_argument("--project", required=True)
        if name == "upload":
            s.add_argument("--run-dir", required=True)
        if name == "job":
            s.add_argument("--run-id", required=True)
            s.add_argument("--bq-dataset", default="airlock_eval")
            s.add_argument("--bq-location")
            s.add_argument("--sdp-qps", type=float, default=5.0)
    return p


def main(argv: Optional[list[str]] = None, env: Optional[Mapping[str, str]] = None, out: Any = None, clients: Optional[Clients] = None) -> int:
    env = os.environ if env is None else env
    out = sys.stdout if out is None else out
    a = parser().parse_args(argv)
    try:
        if a.cmd == "report":
            return cmd_report(a, out)
        _live(a, env)  # every other command is live
        if a.cmd == "live-check":
            print("Live runs are allowed in this shell (flags + environment present). Nothing was called.", file=out)
            return 0
        c = clients or live_clients(a.project, getattr(a, "bq_dataset", "airlock_eval"), getattr(a, "bq_location", None))
        if a.cmd == "upload":
            records, manifest = load_run(Path(a.run_dir))
            paths = run_paths(manifest["run_id"])
            c.storage.write_text(a.bucket, paths["items"], jsonl(records), "application/x-ndjson")
            c.storage.write_text(a.bucket, paths["manifest"], json.dumps(manifest, indent=2), "application/json")
            print(f"✔ uploaded {len(records)} records to gs://{a.bucket}/{paths['items']}", file=out)
            return 0
        if a.cmd == "job":
            run_job(a.run_id, a.bucket, c, a.sdp_qps)
            print(f"✔ scored {a.run_id} → BigQuery {a.bq_dataset} + gs://{a.bucket}/{run_paths(a.run_id)['reports']}/", file=out)
            return 0
    except LiveRefused as e:
        print(str(e), file=sys.stderr if out is sys.stdout else out)
        return 3
    return 2
