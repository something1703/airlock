"""Case-, diacritic- and width-insensitive, word-bounded matching (docs/07 §4 "Match").

Mirrors the engine's FoldedSearch closely enough for scoring: a hit never starts or ends inside a word,
and any run of whitespace matches any other run.
"""

from __future__ import annotations

import re
import unicodedata
from functools import lru_cache

PLACEHOLDER = re.compile(r"\[\[[A-Z]+_(?:[0-9]+|ME)\]\]")


def _fold_char(ch: str) -> str:
    decomposed = unicodedata.normalize("NFKD", ch)
    return "".join(c for c in decomposed if not unicodedata.combining(c)).casefold()


@lru_cache(maxsize=8192)
def fold_map(s: str) -> tuple[str, tuple[int, ...]]:
    """Folded text plus, for each folded character, the index of the original character it came from."""
    out: list[str] = []
    starts: list[int] = []
    prev_space = False
    for i, ch in enumerate(s):
        if ch.isspace():
            if not prev_space:
                out.append(" ")
                starts.append(i)
            prev_space = True
            continue
        prev_space = False
        for c in _fold_char(ch):
            out.append(c)
            starts.append(i)
    return "".join(out), tuple(starts)


def fold(s: str) -> str:
    return fold_map(s)[0]


def _is_word_char(c: str) -> bool:
    return c.isalnum() or unicodedata.category(c).startswith("M")


def find_all(needle: str, haystack: str) -> list[tuple[int, int]]:
    """Word-bounded folded occurrences of `needle` in `haystack`, as (start, end) in original offsets."""
    fn = fold(needle.strip())
    if not fn:
        return []
    fh, starts = fold_map(haystack)
    spans: list[tuple[int, int]] = []
    i = 0
    while True:
        j = fh.find(fn, i)
        if j < 0:
            break
        k = j + len(fn)
        before_ok = j == 0 or not _is_word_char(fh[j - 1])
        after_ok = k >= len(fh) or not _is_word_char(fh[k])
        if before_ok and after_ok:
            spans.append((starts[j], starts[k] if k < len(starts) else len(haystack)))
        i = j + 1
    return spans


def contains(needle: str, haystack: str) -> bool:
    return bool(find_all(needle, haystack))


def mask_placeholders(text: str) -> str:
    """Placeholder tokens become spaces of equal length, so they never count as content."""
    return PLACEHOLDER.sub(lambda m: " " * len(m.group(0)), text)


def tokens(s: str, min_len: int = 3) -> list[str]:
    """Word tokens of at least `min_len` characters (folded)."""
    return [t for t in re.split(r"[^\w]+", fold(s)) if len(t) >= min_len]
