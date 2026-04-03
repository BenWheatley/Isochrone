#!/usr/bin/env python3
"""Export simplified walking graph to MVP binary format."""

from __future__ import annotations

import argparse
from pathlib import Path

from isochrone_pipeline.artifacts import write_graph_binary_artifacts


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--input",
        type=Path,
        default=Path("data_pipeline/input/berlin-routing.osm.json"),
        help="Path to Overpass JSON input.",
    )
    parser.add_argument(
        "--binary-output",
        type=Path,
        default=Path("data_pipeline/output/graph-walk.bin"),
        help="Path to binary graph output.",
    )
    parser.add_argument(
        "--summary-output",
        type=Path,
        default=Path("data_pipeline/output/graph-binary-summary.json"),
        help="Path to binary export summary JSON output.",
    )
    parser.add_argument(
        "--epsg",
        type=int,
        default=25833,
        help="Target EPSG code (default 25833 for Berlin).",
    )
    args = parser.parse_args()

    summary = write_graph_binary_artifacts(
        input_path=args.input,
        binary_output=args.binary_output,
        summary_output=args.summary_output,
        epsg=args.epsg,
    )

    print(f"Wrote {args.binary_output}")
    print(f"Wrote {args.summary_output}")
    print(f"binary_size_bytes={summary['binary_size_bytes']}")
    print(f"after_node_count={summary['after_node_count']}")
    print(f"after_edge_count={summary['after_edge_count']}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
