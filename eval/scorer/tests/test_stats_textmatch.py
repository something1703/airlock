import unittest

from airlock_scorer.stats import bootstrap_mean, percentile, wilson
from airlock_scorer.textmatch import contains, find_all, fold, mask_placeholders, tokens


class WilsonTest(unittest.TestCase):
    def test_known_intervals(self):
        e = wilson(5, 10)
        self.assertAlmostEqual(e.value, 0.5)
        self.assertAlmostEqual(e.low, 0.2366, places=4)
        self.assertAlmostEqual(e.high, 0.7634, places=4)
        e = wilson(1, 2)
        self.assertAlmostEqual(e.low, 0.0945, places=4)
        self.assertAlmostEqual(e.high, 0.9055, places=4)
        e = wilson(0, 10)
        self.assertEqual(e.low, 0.0)
        self.assertAlmostEqual(e.high, 0.2775, places=4)
        e = wilson(10, 10)
        self.assertAlmostEqual(e.low, 0.7225, places=4)
        self.assertEqual(e.high, 1.0)

    def test_empty_and_invalid(self):
        self.assertIsNone(wilson(0, 0).value)
        with self.assertRaises(ValueError):
            wilson(3, 2)


class BootstrapTest(unittest.TestCase):
    def test_mean_exact_and_seeded(self):
        a = bootstrap_mean([1, 2, 3, 4, 5])
        self.assertEqual(a.value, 3.0)
        self.assertEqual(a, bootstrap_mean([1, 2, 3, 4, 5]))
        self.assertTrue(1 <= a.low <= 3 <= a.high <= 5)
        c = bootstrap_mean([4, 4, 4])
        self.assertEqual((c.value, c.low, c.high), (4.0, 4.0, 4.0))
        self.assertIsNone(bootstrap_mean([]).value)

    def test_percentile_interpolates(self):
        self.assertEqual(percentile([1, 2, 3, 4], 50), 2.5)
        self.assertEqual(percentile([10], 95), 10.0)
        self.assertAlmostEqual(percentile([0, 10], 95), 9.5)
        self.assertIsNone(percentile([], 50))


class TextMatchTest(unittest.TestCase):
    def test_folding(self):
        self.assertEqual(fold("Iñigo ÁLVAREZ"), "inigo alvarez")
        self.assertTrue(contains("Lucia", "Hola, soy Lucía."))
        self.assertTrue(contains("lucía", "LUCIA"))

    def test_word_bounded(self):
        self.assertTrue(contains("Raj", "Ask Raj's landlord"))
        self.assertFalse(contains("Raj", "Rajesh called"))
        self.assertFalse(contains("Ana", "Banana"))

    def test_whitespace_runs(self):
        self.assertEqual(find_all("Harlow Bay", "in Harlow\n  Bay today"), [(3, 15)])

    def test_offsets_are_original(self):
        text = "Dear Lucía Ferrández, hi"
        (s, e), = find_all("lucia ferrandez", text)
        self.assertEqual(text[s:e], "Lucía Ferrández")

    def test_placeholders_and_tokens(self):
        self.assertEqual(mask_placeholders("Hi [[PERSON_1]]!"), "Hi " + " " * 12 + "!")
        self.assertEqual(tokens("Jo Ann-Marie Li"), ["ann", "marie"])


if __name__ == "__main__":
    unittest.main()
