#!/usr/bin/env python3
"""Simplify Overpass administrative-boundary JSON and emit canvas-ready geometry."""

from __future__ import annotations

import argparse
from pathlib import Path

from isochrone_pipeline.artifacts import write_simplified_boundary_canvas


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--input",
        type=Path,
        required=True,
        help="Path to Overpass JSON input (for example from docs/overpass_boundary_query.sh).",
    )
    parser.add_argument(
        "--output",
        type=Path,
        required=True,
        help="Path to simplified canvas-ready JSON output.",
    )
    parser.add_argument(
        "--resolution",
        type=float,
        required=True,
        help="Simplification tolerance value.",
    )
    parser.add_argument(
        "--units",
        choices=("meters", "degrees"),
        required=True,
        help="Units for --resolution.",
    )
    parser.add_argument(
        "--epsg",
        type=int,
        default=25833,
        help="Projection used when --units=meters (default: 25833).",
    )
    parser.add_argument(
        "--admin-level",
        default="9",
        help="Administrative level filter (default: 9).",
    )
    args = parser.parse_args()

    output = write_simplified_boundary_canvas(
        input_path=args.input,
        output_path=args.output,
        resolution=args.resolution,
        units=args.units,
        epsg=args.epsg,
        admin_level=args.admin_level,
    )

    print(f"Wrote {args.output}")
    print(f"feature_count={output['stats']['feature_count']}")
    print(f"path_count={output['stats']['path_count']}")
    print(f"input_point_count={output['stats']['input_point_count']}")
    print(f"output_point_count={output['stats']['output_point_count']}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
