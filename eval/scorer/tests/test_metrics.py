"""Metric definitions on hand-computed tiny cases (see helpers.py for the records)."""

import unittest

from airlock_scorer import metrics as M
from helpers import EGRESS, base, blocked, run_records


class LeakTest(unittest.TestCase):
    def test_leaked_gold(self):
        r = base()
        leaked = {g["text"] for g in M.leaked_gold(r)}
        # "Oakby" is visible; "Maya Chen" is sealed but its token "Maya" is visible (PERSON token rule);
        # Bob, the phone and the org are gone; "3 May 1989" is not direct (not a birth date).
        self.assertEqual(leaked, {"Maya Chen", "Oakby"})

    def test_placeholders_and_legend_never_count(self):
        r = base(egress="[[PERSON_1]] wrote to [[ORG_1]].\n\n[[PERSON_1]] — the user", gold=[{"text": "Person", "type": "PERSON", "role": "x"}])
        self.assertEqual(M.leaked_gold(r), [])

    def test_dob_is_direct_other_dates_are_not(self):
        self.assertTrue(M.is_direct({"text": "1 May 1990", "type": "DATE", "role": "the writer's date of birth"}))
        self.assertFalse(M.is_direct({"text": "1 May", "type": "DATE", "role": "an appointment"}))
        self.assertFalse(M.is_direct({"text": "asthma", "type": "HEALTH", "role": "x"}))

    def test_blocked_case_leaks_nothing(self):
        self.assertEqual(M.leaked_gold(blocked()), [])


class ConfigMetricsTest(unittest.TestCase):
    def setUp(self):
        self.m = M.config_metrics([base(), blocked()])

    def test_doc_leak_counts_blocked_docs_in_the_denominator(self):
        self.assertEqual((self.m["doc_leak_rate"].k, self.m["doc_leak_rate"].n), (1, 2))
        self.assertEqual((self.m["doc_leak_rate_sent"].k, self.m["doc_leak_rate_sent"].n), (1, 1))
        self.assertEqual((self.m["gate_block_rate"].k, self.m["gate_block_rate"].n), (1, 2))

    def test_span_recall(self):
        rec = self.m["span_recall"]
        self.assertEqual((rec["PERSON"].k, rec["PERSON"].n), (2, 2))  # full names absent: Maya Chen, Bob
        self.assertEqual((rec["LOCATION"].k, rec["LOCATION"].n), (0, 1))
        self.assertEqual((rec["ORG"].k, rec["CONTACT"].k), (1, 1))
        self.assertEqual(rec["DATE"].n, 0)  # only dates of birth count
        self.assertEqual((self.m["span_recall_direct"].k, self.m["span_recall_direct"].n), (4, 5))
        self.assertIs(self.m["names_caught"], rec["PERSON"])

    def test_over_redaction_and_quasi(self):
        # Sealed: "Hi" (not private), Maya Chen, 555-0147, Acme Corp, the quasi phrase → 1 of 5 is over-redaction.
        self.assertEqual((self.m["over_redaction"].k, self.m["over_redaction"].n), (1, 5))
        self.assertEqual((self.m["quasi_coverage"].k, self.m["quasi_coverage"].n), (1, 1))

    def test_reid(self):
        # name token "Maya", city via metro, employer fuzzy ("Acme Corp." vs "Acme Corp"), age 40 vs 37 (±3); no occupation.
        reid = self.m["reid"]
        self.assertEqual({a: reid[a].k for a in M.ATTRIBUTES}, {"name": 1, "city": 1, "employer": 1, "occupation": 0, "age": 1})
        self.assertEqual(reid["name"].n, 1)  # blocked case had no attacker call
        self.assertEqual((self.m["reid_two_attrs"].k, self.m["reid_two_attrs"].n), (1, 1))

    def test_quality_counts_no_answer_as_loss(self):
        self.assertEqual((self.m["quality_win_tie"].k, self.m["quality_win_tie"].n), (1, 2))
        self.assertEqual(self.m["quality_mean"].value, 4.0)

    def test_answers_latency_routes(self):
        self.assertEqual((self.m["restore_fidelity"].k, self.m["restore_fidelity"].n), (1, 1))
        self.assertEqual(self.m["model_name_leak"], 0)
        self.assertEqual(self.m["seal_ms_per_100w"]["p50"], 25.0)  # 5 ms over 20 words; blocked docs excluded
        self.assertEqual((self.m["on_device_share"].k, self.m["on_device_share"].n), (1, 1))
        self.assertEqual(self.m["route_mix"], {"blocked": 1, "phoneFirst": 1})
        self.assertEqual(self.m["sdp"], {"measured": 0, "median": None, "max": None})

    def test_model_name_leak_and_unknown_ids(self):
        m = M.config_metrics([base(restore={"unknown_ids": ["PERSON_9"], "guessed_entities": ["PERSON_1"], "ok": False})])
        self.assertEqual(m["restore_fidelity"].k, 0)
        self.assertEqual(m["model_name_leak"], 1)


class AttackerMatchTest(unittest.TestCase):
    def test_rules(self):
        self.assertTrue(M.name_hit("maya", "Maya Chen"))
        self.assertFalse(M.name_hit("May", "Maya Chen"))
        self.assertTrue(M.city_hit("Oakby", "Oakby", None))
        self.assertTrue(M.city_hit("oakby metro", "Oakby", "Oakby Metro"))
        self.assertFalse(M.city_hit("Fenwick", "Oakby", "Oakby Metro"))
        self.assertTrue(M.employer_hit("Acme Corp.", "Acme Corp"))
        self.assertFalse(M.employer_hit("Acme Logistics", "Acme Corp"))
        self.assertFalse(M.employer_hit("", "Acme Corp"))
        self.assertTrue(M.age_hit("34", 37) and M.age_hit(40, 37))
        self.assertFalse(M.age_hit(41, 37) or M.age_hit(0, 37) or M.age_hit("?", 37))
        self.assertTrue(M.occupation_hit("a night nurse", "nurse"))


class ScoreTest(unittest.TestCase):
    def test_score_groups_and_rows(self):
        recs = run_records()
        s = M.score(recs)
        self.assertEqual(list(s["configs"]), ["A_raw", "D_llm", "E_redteam", "F_vault"])
        self.assertEqual(s["configs"]["A_raw"]["doc_leak_rate"].k, 2)
        self.assertIn("language=en", s["slices"]["D_llm"])
        rows = M.metric_rows("tiny", s)
        names = {(r["metric"], r["slice"]) for r in rows}
        self.assertIn(("doc_leak_rate", "config=D_llm"), names)
        self.assertIn(("span_recall.PERSON", "config=D_llm"), names)
        self.assertIn(("doc_leak_rate", "config=D_llm;language=en"), names)
        self.assertIn(("route_mix.phoneFirst", "config=D_llm"), names)

    def test_item_row_matches_bigquery_schema(self):
        import json
        from pathlib import Path

        cols = [c["name"] for c in json.loads((Path(__file__).resolve().parents[2] / "schemas" / "items.json").read_text())]
        row = M.item_row(base())
        self.assertEqual(sorted(row), sorted(cols))
        self.assertEqual(row["leaked_gold"], 2)
        self.assertEqual(row["leaked_types"], ["LOCATION", "PERSON"])
        self.assertEqual(row["over_redactions"], 1)

    def test_misses_are_real_leaked_examples(self):
        ms = M.misses([base()])
        self.assertEqual({m["text"] for m in ms}, {"Maya Chen", "Oakby"})
        self.assertTrue(all(m["text"] in base()["text"] for m in ms))


if __name__ == "__main__":
    unittest.main()
