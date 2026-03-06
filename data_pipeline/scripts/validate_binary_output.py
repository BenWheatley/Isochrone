#!/usr/bin/env python3
"""Validate exported binary graph structure and sampled Berlin coordinates."""

from __future__ import annotations

import argparse
import json
from datetime import UTC, datetime
from pathlib import Path

from isochrone_pipeline.binary_reader import summarize_graph_file
from isochrone_pipeline.binary_validation import validate_binary_graph_payload


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--input",
        type=Path,
        default=Path("data_pipeline/output/graph-walk.bin"),
        help="Path to binary graph file.",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("data_pipeline/output/graph-binary-validation-summary.json"),
        help="Path to validation summary JSON output.",
    )
    parser.add_argument(
        "--node-sample-count",
        type=int,
        default=5,
        help="How many random nodes to spot-check for Berlin bbox.",
    )
    parser.add_argument(
        "--seed",
        type=int,
        default=1337,
        help="Random seed used for deterministic node spot-check sampling.",
    )
    args = parser.parse_args()

    # Phase 2.3.2 reader verification output.
    reader_lines = summarize_graph_file(args.input)

    payload = args.input.read_bytes()
    result = validate_binary_graph_payload(
        payload,
        node_sample_count=args.node_sample_count,
        random_seed=args.seed,
    )

    summary = {
        "generated_at_utc": datetime.now(UTC).isoformat(),
        "input": str(args.input),
        "reader_lines": reader_lines,
        "header": {
            "magic": f"0x{result.header.magic:08X}",
            "version": result.header.version,
            "n_nodes": result.header.n_nodes,
            "n_edges": result.header.n_edges,
            "n_stops": result.header.n_stops,
            "n_tedges": result.header.n_tedges,
            "node_table_offset": result.header.node_table_offset,
            "edge_table_offset": result.header.edge_table_offset,
            "stop_table_offset": result.header.stop_table_offset,
        },
        "node_sample_count": result.sampled_node_count,
        "node_spot_checks": [
            {
                "node_index": check.node_index,
                "x_m": check.x_m,
                "y_m": check.y_m,
                "easting": check.easting,
                "northing": check.northing,
                "lat": check.lat,
                "lon": check.lon,
            }
            for check in result.node_spot_checks
        ],
        "edge_target_violations": result.edge_target_violations,
    }

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(summary, indent=2), encoding="utf-8")

    print(f"Wrote {args.output}")
    print(f"node_sample_count={summary['node_sample_count']}")
    print(f"edge_target_violations={summary['edge_target_violations']}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
