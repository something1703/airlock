"""Evidence JSON, reports, the CLI, the live gate and the Cloud Run job body (with fakes, never the network)."""

import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from airlock_scorer import cli, evidence
from airlock_scorer.cloud import Clients, inspect_records, run_paths, sdp_text
from airlock_scorer.live_gate import LIVE_ENV, LiveRefused, assert_live_allowed
from helpers import MANIFEST, run_records

SCHEMAS = Path(__file__).resolve().parents[2] / "schemas"


class EvidenceTest(unittest.TestCase):
    def setUp(self):
        self.files = cli.build_outputs(run_records(), MANIFEST)
        self.ev = json.loads(self.files["evidence.json"])

    def test_mock_evidence_is_labelled_and_valid(self):
        self.assertEqual(evidence.validate(self.ev), [])
        self.assertTrue(self.ev["mock"])
        self.assertEqual(self.ev["label"], "MOCK RUN — not real model results")
        self.assertEqual(self.ev["headlineConfig"], "E_redteam")
        self.assertEqual(self.ev["leakRate"]["value"], 0.5)
        self.assertEqual([a["config"] for a in self.ev["ablation"]], ["D_llm", "E_redteam", "F_vault"])
        self.assertEqual(self.ev["n"], 2)

    def test_matches_json_schema_required_keys(self):
        schema = json.loads((SCHEMAS / "evidence.schema.json").read_text())
        self.assertEqual(sorted(schema["required"]), sorted(evidence.REQUIRED_KEYS))
        self.assertEqual(sorted(self.ev), sorted(schema["properties"]))

    def test_validate_rejects_unlabelled_mock_and_bad_rates(self):
        bad = dict(self.ev, label=None)
        self.assertIn("mock evidence must carry the MOCK RUN label", evidence.validate(bad))
        bad = dict(self.ev, leakRate={"value": 0.5, "low": 0.6, "high": 0.7, "n": 2})
        self.assertTrue(any("leakRate" in p for p in evidence.validate(bad)))

    def test_live_manifest_has_no_label(self):
        ev = json.loads(cli.build_outputs(run_records(), dict(MANIFEST, mode="live"))["evidence.json"])
        self.assertFalse(ev["mock"])
        self.assertIsNone(ev["label"])

    def test_reports(self):
        md, html = self.files["report.md"], self.files["report.html"]
        self.assertIn("MOCK RUN — not real model results", md)
        self.assertIn("| Config | Doc leak rate | Names caught | Re-ID ≥2 attrs | Quality win+tie | Seal p50/100w |", md)
        self.assertIn("50.0% (9.5–90.5)", md)  # D_llm leak 1/2 with its Wilson interval
        self.assertNotIn("None", md)
        self.assertIn("<svg", html)
        self.assertIn("prefers-color-scheme: dark", html)
        self.assertIn("MOCK RUN", html)
        self.assertNotIn("<script", html)  # static, no chart library
        live_md = cli.build_outputs(run_records(), dict(MANIFEST, mode="live"))["report.md"]
        self.assertNotIn("MOCK RUN", live_md)


class CliTest(unittest.TestCase):
    def test_report_writes_all_files(self):
        with tempfile.TemporaryDirectory() as d:
            run = Path(d) / "run"
            run.mkdir()
            (run / "items.jsonl").write_text("".join(json.dumps(r) + "\n" for r in run_records()))
            (run / "manifest.json").write_text(json.dumps(MANIFEST))
            out = io.StringIO()
            self.assertEqual(cli.main(["report", "--run-dir", str(run)], env={}, out=out), 0)
            for f in ("report.md", "report.html", "evidence.json", "metrics.json"):
                self.assertTrue((run / f).exists(), f)
            self.assertIn("MOCK RUN", out.getvalue())
            metrics = json.loads((run / "metrics.json").read_text())
            self.assertEqual(metrics["configs"]["D_llm"]["doc_leak_rate"], {"value": 0.5, "low": metrics["configs"]["D_llm"]["doc_leak_rate"]["low"], "high": metrics["configs"]["D_llm"]["doc_leak_rate"]["high"], "n": 2, "k": 1})


class LiveGateTest(unittest.TestCase):
    def test_gate(self):
        assert_live_allowed(True, True, {LIVE_ENV: "yes"})
        for live, perm, env in [(True, True, {}), (True, False, {LIVE_ENV: "yes"}), (False, True, {LIVE_ENV: "yes"}), (True, True, {LIVE_ENV: "1"})]:
            with self.assertRaises(LiveRefused):
                assert_live_allowed(live, perm, env)

    def test_cli_refuses_before_building_any_client(self):
        argvs = [
            ["upload", "--run-dir", "x", "--bucket", "b", "--project", "p", "--live", "--i-have-permission"],
            ["job", "--run-id", "r", "--bucket", "b", "--project", "p", "--live"],
            ["job", "--run-id", "r", "--bucket", "b", "--project", "p"],
            ["live-check"],
        ]
        with mock.patch.object(cli, "live_clients", side_effect=AssertionError("google-cloud client built")):
            for argv in argvs:
                out = io.StringIO()
                self.assertEqual(cli.main(argv, env={}, out=out), 3, argv)
                self.assertIn("owner's explicit permission", out.getvalue())
                self.assertIn("Nothing was sent", out.getvalue())


class FakeStorage:
    def __init__(self, files):
        self.files = dict(files)

    def read_text(self, bucket, path):
        return self.files[(bucket, path)]

    def write_text(self, bucket, path, text, content_type):
        self.files[(bucket, path)] = text


class FakeInspector:
    def __init__(self):
        self.texts = []

    def count_findings(self, text):
        self.texts.append(text)
        return 1 if "Oakby" in text else 0


class FakeWarehouse:
    def __init__(self):
        self.rows = {}

    def insert_rows(self, table, rows):
        self.rows.setdefault(table, []).extend(rows)


class JobTest(unittest.TestCase):
    def test_job_with_fakes(self):
        recs = run_records()
        paths = run_paths("tiny")
        storage = FakeStorage({("b", paths["items"]): "".join(json.dumps(r) + "\n" for r in recs), ("b", paths["manifest"]): json.dumps(MANIFEST)})
        inspector, warehouse = FakeInspector(), FakeWarehouse()
        out = io.StringIO()
        code = cli.main(["job", "--run-id", "tiny", "--bucket", "b", "--project", "p", "--live", "--i-have-permission"], env={LIVE_ENV: "yes"}, out=out,
                        clients=Clients(storage, inspector, warehouse))
        self.assertEqual(code, 0)
        # SDP: only sealed cases that left (3 configs × 1 sent item), never A_raw, placeholders blanked.
        self.assertEqual(len(inspector.texts), 3)
        self.assertTrue(all("[[PERSON_1]]" not in t for t in inspector.texts))
        self.assertEqual(len(warehouse.rows["runs"]), 1)
        self.assertEqual(len(warehouse.rows["items"]), len(recs))
        self.assertTrue(any(r["metric"] == "sdp.median" and r["value"] == 1 for r in warehouse.rows["metrics"]))
        for f in ("report.md", "report.html", "evidence.json", "metrics.json"):
            self.assertIn(("b", f"reports/tiny/{f}"), storage.files)
        bq_cols = {c["name"] for c in json.loads((SCHEMAS / "items.json").read_text())}
        self.assertEqual(set(warehouse.rows["items"][0]), bq_cols)
        run_cols = {c["name"] for c in json.loads((SCHEMAS / "runs.json").read_text())}
        self.assertEqual(set(warehouse.rows["runs"][0]), run_cols)
        metric_cols = {c["name"] for c in json.loads((SCHEMAS / "metrics.json").read_text())}
        self.assertEqual(set(warehouse.rows["metrics"][0]), metric_cols)

    def test_sdp_rate_limit_and_masking(self):
        sleeps = []
        recs = run_records()
        n = inspect_records(recs, FakeInspector(), qps=4, sleep=sleeps.append)
        self.assertEqual(n, 3)
        self.assertEqual(sleeps, [0.25, 0.25])
        self.assertEqual(sdp_text("Hi [[PERSON_1]]"), "Hi " + " " * 12)


if __name__ == "__main__":
    unittest.main()
