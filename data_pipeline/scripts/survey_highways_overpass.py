#!/usr/bin/env python3
"""Survey Berlin highway tags using targeted Overpass API queries."""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import requests
from isochrone_pipeline.overpass_survey import (
    WALKABLE_HIGHWAY_VALUES,
    compute_node_density_per_km,
    count_highway_values,
)

OVERPASS_ENDPOINTS: tuple[str, ...] = (
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
)


def _run_overpass_query(query: str, timeout_s: int) -> list[dict[str, Any]]:
    payload = {"data": query}
    last_error: Exception | None = None

    for endpoint in OVERPASS_ENDPOINTS:
        try:
            response = requests.post(endpoint, data=payload, timeout=timeout_s)
            response.raise_for_status()
            body = response.json()
            elements = body.get("elements")
            if isinstance(elements, list):
                return elements
            raise RuntimeError(f"Unexpected Overpass response shape from {endpoint}")
        except Exception as error:  # noqa: BLE001
            last_error = error

    assert last_error is not None
    raise RuntimeError("All Overpass endpoints failed") from last_error


def _build_tag_query() -> str:
    return """
[out:json][timeout:180];
area["name"="Berlin"]["boundary"="administrative"]["admin_level"="4"]->.searchArea;
way["highway"](area.searchArea);
out tags;
""".strip()


def _build_walkable_geometry_query(limit: int) -> str:
    highway_regex = "|".join(re.escape(value) for value in WALKABLE_HIGHWAY_VALUES)
    return f"""
[out:json][timeout:180];
area["name"="Berlin"]["boundary"="administrative"]["admin_level"="4"]->.searchArea;
way["highway"~"^{highway_regex}$"](area.searchArea);
out geom qt {limit};
""".strip()


def _write_report(
    report_path: Path,
    all_counts: Counter[str],
    walkable_counts: Counter[str],
    density_nodes_per_km: float | None,
    sample_size: int,
) -> None:
    lines: list[str] = []
    lines.append("# Berlin Highway Survey (Overpass)")
    lines.append("")
    lines.append(f"Generated: {datetime.now(UTC).isoformat()}")
    lines.append("")
    lines.append("## Method")
    lines.append("- Used targeted Overpass queries (no full `.pbf` download).")
    lines.append("- Query 1: all Berlin `way[highway]` with `out tags` for value counts.")
    lines.append(
        "- Query 2: walkable ways with geometry, capped to "
        f"{sample_size} ways, for node-density estimation."
    )
    lines.append("")
    lines.append("## `highway=*` counts (top 25)")
    lines.append("")
    lines.append("| highway | ways |")
    lines.append("|---|---:|")

    for highway, count in all_counts.most_common(25):
        lines.append(f"| `{highway}` | {count:,} |")

    lines.append("")
    lines.append("## Walkable values observed")
    lines.append("")

    observed_walkable = [
        f"`{highway}` ({count:,})" for highway, count in walkable_counts.most_common() if count > 0
    ]
    if observed_walkable:
        lines.append("- " + ", ".join(observed_walkable))
    else:
        lines.append("- No walkable highway values found in the queried data.")

    lines.append("")
    lines.append("## Typical node density per km (walkable ways)")
    lines.append("")
    if density_nodes_per_km is None:
        lines.append("- Could not compute (insufficient geometry length).")
    else:
        lines.append(f"- Estimated `~{density_nodes_per_km:.2f}` nodes/km from sampled geometry.")

    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--sample-limit",
        type=int,
        default=2000,
        help="Max number of walkable ways to fetch geometry for density estimate.",
    )
    parser.add_argument(
        "--output-markdown",
        type=Path,
        default=Path("docs/osm-highway-survey.md"),
        help="Path to output markdown report.",
    )
    parser.add_argument(
        "--output-json",
        type=Path,
        default=Path("data_pipeline/output/osm-highway-survey.json"),
        help="Path to output machine-readable summary.",
    )
    args = parser.parse_args()

    if args.sample_limit <= 0:
        raise ValueError("--sample-limit must be positive")

    tag_elements = _run_overpass_query(_build_tag_query(), timeout_s=240)
    all_counts = count_highway_values(tag_elements)

    walkable_elements = _run_overpass_query(
        _build_walkable_geometry_query(args.sample_limit), timeout_s=240
    )
    walkable_way_elements = [
        element for element in walkable_elements if element.get("type") == "way"
    ]
    density_nodes_per_km = compute_node_density_per_km(walkable_way_elements)

    walkable_counts: Counter[str] = Counter()
    for highway in WALKABLE_HIGHWAY_VALUES:
        walkable_counts[highway] = all_counts.get(highway, 0)

    _write_report(
        report_path=args.output_markdown,
        all_counts=all_counts,
        walkable_counts=walkable_counts,
        density_nodes_per_km=density_nodes_per_km,
        sample_size=len(walkable_way_elements),
    )

    args.output_json.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "generated_at_utc": datetime.now(UTC).isoformat(),
        "sample_way_count": len(walkable_way_elements),
        "density_nodes_per_km": density_nodes_per_km,
        "top_highway_counts": all_counts.most_common(50),
        "walkable_counts": {
            highway: walkable_counts[highway] for highway in WALKABLE_HIGHWAY_VALUES
        },
    }
    args.output_json.write_text(json.dumps(payload, indent=2), encoding="utf-8")

    print(f"Wrote markdown report: {args.output_markdown}")
    print(f"Wrote JSON summary: {args.output_json}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:  # noqa: BLE001
        print(f"ERROR: {error}", file=sys.stderr)
        raise
