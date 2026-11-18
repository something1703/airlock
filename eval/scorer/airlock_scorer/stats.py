"""Confidence intervals (docs/07 §4): Wilson 95% for rates, bootstrap (1,000 resamples) for means."""

from __future__ import annotations

import math
import random
from dataclasses import dataclass
from typing import Optional, Sequence

Z95 = 1.959963984540054
BOOTSTRAP_RESAMPLES = 1000
BOOTSTRAP_SEED = 20261118


@dataclass(frozen=True)
class Estimate:
    value: Optional[float]
    low: Optional[float]
    high: Optional[float]
    n: int
    k: Optional[int] = None

    def as_dict(self) -> dict:
        d = {"value": self.value, "low": self.low, "high": self.high, "n": self.n}
        if self.k is not None:
            d["k"] = self.k
        return d


def wilson(k: int, n: int, z: float = Z95) -> Estimate:
    """Wilson score interval for k successes out of n. n = 0 → all None."""
    if n <= 0:
        return Estimate(None, None, None, 0, k)
    if not 0 <= k <= n:
        raise ValueError("k must be between 0 and n")
    p = k / n
    z2 = z * z
    denom = 1 + z2 / n
    centre = (p + z2 / (2 * n)) / denom
    half = z * math.sqrt(p * (1 - p) / n + z2 / (4 * n * n)) / denom
    low = 0.0 if k == 0 else max(0.0, centre - half)
    high = 1.0 if k == n else min(1.0, centre + half)
    return Estimate(p, low, high, n, k)


def percentile(values: Sequence[float], q: float) -> Optional[float]:
    """Linear-interpolated percentile (q in [0, 100]), like numpy's default."""
    if not values:
        return None
    xs = sorted(values)
    if len(xs) == 1:
        return float(xs[0])
    pos = (len(xs) - 1) * q / 100.0
    lo = math.floor(pos)
    hi = math.ceil(pos)
    return float(xs[lo] + (xs[hi] - xs[lo]) * (pos - lo))


def bootstrap_mean(values: Sequence[float], resamples: int = BOOTSTRAP_RESAMPLES, seed: int = BOOTSTRAP_SEED) -> Estimate:
    """Mean with a percentile bootstrap 95% interval. Seeded, so reports are reproducible."""
    n = len(values)
    if n == 0:
        return Estimate(None, None, None, 0)
    mean = sum(values) / n
    rnd = random.Random(seed)
    means = []
    for _ in range(resamples):
        s = 0.0
        for _ in range(n):
            s += values[rnd.randrange(n)]
        means.append(s / n)
    return Estimate(mean, percentile(means, 2.5), percentile(means, 97.5), n)
