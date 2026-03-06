#!/usr/bin/env python3
"""Simplify adjacency graph and write before/after summary."""

from __future__ import annotations

import argparse
import json
from datetime import UTC, datetime
from pathlib import Path

from isochrone_pipeline.adjacency import build_adjacency_graph
from isochrone_pipeline.osm_graph_extract import extract_walkable_graph_input
from isochrone_pipeline.projection import project_nodes_to_utm
from isochrone_pipeline.simplify import simplify_degree2_chains


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--input",
        type=Path,
        default=Path("data_pipeline/input/berlin-routing.osm.json"),
        help="Path to Overpass JSON input.",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("data_pipeline/output/simplified-adjacency-summary.json"),
        help="Path to simplification summary JSON output.",
    )
    args = parser.parse_args()

    extracted = extract_walkable_graph_input(args.input)
    projected = project_nodes_to_utm(extracted.node_coords)
    graph = build_adjacency_graph(extracted, projected)
    simplified = simplify_degree2_chains(graph)

    summary = {
        "generated_at_utc": datetime.now(UTC).isoformat(),
        "input": str(args.input),
        "before_node_count": simplified.before_node_count,
        "before_edge_count": simplified.before_edge_count,
        "after_node_count": simplified.after_node_count,
        "after_edge_count": simplified.after_edge_count,
        "merged_node_count": simplified.merged_node_count,
        "skipped_constraint_way_count": simplified.graph.skipped_constraint_way_count,
        "dropped_missing_node_way_count": extracted.dropped_way_count,
    }

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(summary, indent=2), encoding="utf-8")

    print(f"Wrote {args.output}")
    print(f"before_node_count={summary['before_node_count']}")
    print(f"before_edge_count={summary['before_edge_count']}")
    print(f"after_node_count={summary['after_node_count']}")
    print(f"after_edge_count={summary['after_edge_count']}")
    print(f"merged_node_count={summary['merged_node_count']}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
