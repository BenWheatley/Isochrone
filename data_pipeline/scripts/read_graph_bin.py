#!/usr/bin/env python3
"""Read and validate a binary graph header, node0, and edge0."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from isochrone_pipeline.binary_reader import summarize_graph_file


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path, help="Path to binary graph file")
    args = parser.parse_args()

    lines = summarize_graph_file(args.input)
    for line in lines:
        print(line)

    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:  # noqa: BLE001
        print(f"ERROR: {error}", file=sys.stderr)
        raise
