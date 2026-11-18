"""AirlockBench scorer (docs/07-EVALUATION.md §7).

Deterministic metrics, report rendering and evidence_json run locally with the standard library only.
The live parts (GCS, Sensitive Data Protection, BigQuery) import google-cloud libraries lazily and are
gated behind --live --i-have-permission plus AIRLOCK_BENCH_LIVE_OK=yes (see live_gate.py).
"""

__version__ = "1.0.0"
