#!/usr/bin/env python3
"""Entry point for multi-region fetch/build artifact generation."""

from __future__ import annotations

import sys
from pathlib import Path


def _main() -> int:
    src_root = Path(__file__).resolve().parent / "src"
    if str(src_root) not in sys.path:
        sys.path.insert(0, str(src_root))

    from isochrone_pipeline.region_pipeline import main

    return main()


if __name__ == "__main__":
    raise SystemExit(_main())
