"""The live gate (same contract as web/bench/liveGate.ts).

Anything that talks to Google Cloud (GCS, Sensitive Data Protection, BigQuery) needs the repo owner's
explicit permission; those runs happen last on the separate evaluation project. Checked before any
google-cloud import.
"""

from __future__ import annotations

from typing import Mapping

LIVE_ENV = "AIRLOCK_BENCH_LIVE_OK"


class LiveRefused(Exception):
    def __init__(self, missing: list[str]):
        self.missing = missing
        super().__init__(
            "Refusing to run live: this would call Google Cloud (Cloud Storage, Sensitive Data Protection, BigQuery) on the evaluation project.\n"
            "Live evaluation needs the repo owner's explicit permission and runs last, on the separate evaluation Google Cloud project.\n"
            f"Missing: {'; '.join(missing)}.\n"
            f"To run live, the owner must pass --live --i-have-permission AND set {LIVE_ENV}=yes. Nothing was sent."
        )


def assert_live_allowed(live: bool, i_have_permission: bool, env: Mapping[str, str]) -> None:
    missing = []
    if not live:
        missing.append("--live")
    if not i_have_permission:
        missing.append("--i-have-permission")
    if env.get(LIVE_ENV) != "yes":
        missing.append(f"{LIVE_ENV}=yes in the environment")
    if missing:
        raise LiveRefused(missing)
