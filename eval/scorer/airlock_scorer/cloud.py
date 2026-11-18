"""Google Cloud adapters for the live scorer job: Cloud Storage, Sensitive Data Protection, BigQuery.

All clients are injected (tests use fakes). `live_clients()` is the only place google-cloud libraries are
imported, and only after the live gate has passed. Bucket layout (docs/05 §9): `datasets/`,
`runs/{runId}/items.jsonl`, `runs/{runId}/manifest.json`, `reports/{runId}/…`.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass
from typing import Any, Callable, Iterable, Optional, Protocol

from .textmatch import mask_placeholders


class Storage(Protocol):
    def read_text(self, bucket: str, path: str) -> str: ...
    def write_text(self, bucket: str, path: str, text: str, content_type: str) -> None: ...


class Inspector(Protocol):
    def count_findings(self, text: str) -> int: ...


class Warehouse(Protocol):
    def insert_rows(self, table: str, rows: list[dict]) -> None: ...


@dataclass
class Clients:
    storage: Storage
    inspector: Inspector
    warehouse: Warehouse


def run_paths(run_id: str) -> dict[str, str]:
    return {"items": f"runs/{run_id}/items.jsonl", "manifest": f"runs/{run_id}/manifest.json", "reports": f"reports/{run_id}"}


def sdp_text(egress: str) -> str:
    """What SDP inspects: the egress with our own placeholder tokens blanked (they are not findings)."""
    return mask_placeholders(egress)


def inspect_records(records: list[dict], inspector: Inspector, qps: float = 5.0, sleep: Callable[[float], None] = time.sleep) -> int:
    """Adds `sdp_findings` to every sealed record that left (A_raw is skipped: it is raw by definition)."""
    calls = 0
    for r in records:
        if r["config"] == "A_raw" or r.get("egress") is None:
            continue
        if calls and qps > 0:
            sleep(1.0 / qps)
        r["sdp_findings"] = inspector.count_findings(sdp_text(r["egress"]))
        calls += 1
    return calls


def jsonl(rows: Iterable[dict]) -> str:
    return "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows)


def parse_jsonl(text: str) -> list[dict]:
    return [json.loads(l) for l in text.splitlines() if l.strip()]


def run_row(manifest: dict, notes: str = "") -> dict:
    """BigQuery `runs` row (eval/schemas/runs.json)."""
    return {
        "run_id": manifest["run_id"], "created_at": manifest.get("created_at"), "git_sha": manifest.get("git_sha"),
        "prompt_ids": json.dumps(manifest.get("prompt_ids") or {}, sort_keys=True), "dial": (manifest.get("remote_config") or {}).get("dial_default"),
        "config": json.dumps({"configs": manifest.get("configs"), "engines": manifest.get("engines"), "models": manifest.get("models"), "mode": manifest.get("mode")}, sort_keys=True),
        "n_items": manifest.get("n_items"), "notes": notes,
    }


def bq_items_row(row: dict) -> dict:
    """`attacker_hits` is a JSON column; everything else maps 1:1."""
    out = dict(row)
    out["attacker_hits"] = json.dumps(row["attacker_hits"]) if row.get("attacker_hits") is not None else None
    return out


# MARK: real clients (imported lazily, live only)


class _GcsStorage:
    def __init__(self, client: Any):
        self.client = client

    def read_text(self, bucket: str, path: str) -> str:
        return self.client.bucket(bucket).blob(path).download_as_text()

    def write_text(self, bucket: str, path: str, text: str, content_type: str) -> None:
        self.client.bucket(bucket).blob(path).upload_from_string(text, content_type=content_type)


class _SdpInspector:
    def __init__(self, client: Any, project: str, min_likelihood: str = "POSSIBLE"):
        self.client = client
        self.parent = f"projects/{project}/locations/global"
        self.min_likelihood = min_likelihood

    def count_findings(self, text: str) -> int:
        resp = self.client.inspect_content(request={
            "parent": self.parent,
            "inspect_config": {"min_likelihood": self.min_likelihood, "include_quote": False, "limits": {"max_findings_per_request": 100}},
            "item": {"value": text},
        })
        return len(resp.result.findings)


class _BigQuery:
    def __init__(self, client: Any, dataset: str):
        self.client = client
        self.dataset = dataset

    def insert_rows(self, table: str, rows: list[dict]) -> None:
        for i in range(0, len(rows), 500):
            errors = self.client.insert_rows_json(f"{self.client.project}.{self.dataset}.{table}", rows[i:i + 500])
            if errors:
                raise RuntimeError(f"BigQuery insert into {table} failed for {len(errors)} rows")


def live_clients(project: str, bq_dataset: str, location: Optional[str] = None) -> Clients:
    """Real Google Cloud clients. Call only after `assert_live_allowed`."""
    from google.cloud import bigquery, dlp_v2, storage  # noqa: PLC0415 — lazy on purpose

    return Clients(
        storage=_GcsStorage(storage.Client(project=project)),
        inspector=_SdpInspector(dlp_v2.DlpServiceClient(), project),
        warehouse=_BigQuery(bigquery.Client(project=project, location=location), bq_dataset),
    )
