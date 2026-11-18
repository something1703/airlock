"""Entry point that works with `python3 -I` (isolated mode does not put this directory on sys.path)."""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from airlock_scorer.cli import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main())
