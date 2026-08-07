"""Helpers for writing boundary and routing graph artifacts."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from isochrone_pipeline.adjacency import (
    MODE_MASK_BIKE,
    MODE_MASK_CAR,
    MODE_MASK_WALK,
    MODE_MASK_WATER,
    GraphEdge,
    build_adjacency_graph,
)
from isochrone_pipeline.binary_reader import parse_header
from isochrone_pipeline.boundary_canvas import (
    ResolutionUnits,
    simplify_overpass_boundaries_for_canvas,
)
from isochrone_pipeline.graph_binary import export_graph_binary_bytes
from isochrone_pipeline.gtfs_transit import (
    attach_stops_to_nearest_nodes,
    finalize_transit_extract,
    load_transport_type_by_route_id,
    parse_gtfs_feed,
)
from isochrone_pipeline.osm_graph_extract import (
    extract_walkable_graph_input,
    summarize_constraint_tag_coverage,
)
from isochrone_pipeline.projection import project_nodes_to_utm
from isochrone_pipeline.simplify import simplify_degree2_chains


def write_simplified_boundary_canvas(
    *,
    input_path: Path,
    output_path: Path,
    resolution: float,
    units: ResolutionUnits,
    epsg: int,
    admin_level: str,
    include_coast: bool = False,
    coast_source: str | Path | None = None,
    coast_cache_dir: str | Path | None = None,
) -> dict[str, Any]:
    overpass_json = json.loads(input_path.read_text(encoding="utf-8"))
    payload = simplify_overpass_boundaries_for_canvas(
        overpass_json,
        tolerance=resolution,
        units=units,
        epsg_code=epsg,
        admin_level=admin_level,
        include_coast=include_coast,
        coast_source=coast_source,
        coast_cache_dir=coast_cache_dir,
    )

    output = {
        "generated_at_utc": datetime.now(UTC).isoformat(),
        "input": str(input_path),
        **payload,
    }

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(output, indent=2), encoding="utf-8")
    return output


def write_graph_binary_artifacts(
    *,
    input_path: Path,
    binary_output: Path,
    summary_output: Path,
    epsg: int,
    transit_feed_dir: Path | None = None,
    transit_reference_date: str | None = None,
) -> dict[str, Any]:
    extracted = extract_walkable_graph_input(input_path)
    tag_coverage = summarize_constraint_tag_coverage(extracted.ways)
    projected = project_nodes_to_utm(extracted.node_coords, epsg_code=epsg)
    graph = build_adjacency_graph(extracted, projected)

    transit_summary: dict[str, Any] = {}
    stop_attachment_osm_ids: set[int] = set()
    parsed_feed = None
    attached_stops: dict[str, Any] = {}
    dropped_stop_count = 0

    if transit_feed_dir is not None and transit_reference_date is not None:
        parsed_feed = parse_gtfs_feed(
            transit_feed_dir,
            reference_date=transit_reference_date,
            epsg_code=epsg,
            extent_origin_easting=projected.origin_easting,
            extent_origin_northing=projected.origin_northing,
            extent_width_m=projected.grid_width_px * projected.pixel_size_m,
            extent_height_m=projected.grid_height_px * projected.pixel_size_m,
        )
        transport_type_by_route_id = load_transport_type_by_route_id(transit_feed_dir)
        attached_stops, dropped_stop_count = attach_stops_to_nearest_nodes(
            parsed_feed.stops,
            projected.node_offsets_m,
            transport_type_by_route_id,
        )
        stop_attachment_osm_ids = {stop.nearest_node_osm_id for stop in attached_stops.values()}
        transit_summary["parsed_stop_count"] = len(parsed_feed.stops)
        transit_summary["attached_stop_count"] = len(attached_stops)
        transit_summary["dropped_stop_count"] = dropped_stop_count
        transit_summary["total_stop_count_in_feed"] = parsed_feed.total_stop_count
        transit_summary["raw_connection_count"] = len(parsed_feed.connections)

    simplified = simplify_degree2_chains(graph, stop_attachment_osm_ids=stop_attachment_osm_ids)

    stops: tuple[Any, ...] = ()
    transit_edges: tuple[Any, ...] = ()
    if parsed_feed is not None:
        osm_id_to_final_index = {
            node.osm_id: index
            for index, node in enumerate(simplified.graph.nodes)
            if node.osm_id is not None
        }
        transit_extract = finalize_transit_extract(
            attached_stops,
            osm_id_to_final_index,
            parsed_feed.connections,
            parsed_feed.total_stop_count,
            dropped_stop_count,
        )
        stops = transit_extract.stops
        transit_edges = transit_extract.connections
        transit_summary["final_stop_count"] = len(stops)
        transit_summary["final_connection_count"] = len(transit_edges)

    payload = export_graph_binary_bytes(
        simplified.graph,
        projection=projected,
        stops=stops,
        transit_edges=transit_edges,
    )

    binary_output.parent.mkdir(parents=True, exist_ok=True)
    binary_output.write_bytes(payload)

    header = parse_header(payload)
    summary = {
        "generated_at_utc": datetime.now(UTC).isoformat(),
        "input": str(input_path),
        "binary_output": str(binary_output),
        "binary_size_bytes": len(payload),
        "before_node_count": simplified.before_node_count,
        "before_edge_count": simplified.before_edge_count,
        "after_node_count": simplified.after_node_count,
        "after_edge_count": simplified.after_edge_count,
        "constraint_tag_presence": tag_coverage.tag_presence,
        "constraint_tag_coverage_ratio": tag_coverage.tag_coverage_ratio,
        "edge_mode_mask_counts": _edge_mode_mask_counts(simplified.graph.edges),
        "edge_mode_counts": _edge_mode_counts(simplified.graph.edges),
        "edge_mode_coverage_ratio": _edge_mode_coverage_ratio(simplified.graph.edges),
        **({"transit": transit_summary} if transit_summary else {}),
        "header": {
            "magic": f"0x{header.magic:08X}",
            "version": header.version,
            "flags": header.flags,
            "n_nodes": header.n_nodes,
            "n_edges": header.n_edges,
            "n_stops": header.n_stops,
            "n_tedges": header.n_tedges,
            "origin_easting": header.origin_easting,
            "origin_northing": header.origin_northing,
            "epsg_code": header.epsg_code,
            "grid_width_px": header.grid_width_px,
            "grid_height_px": header.grid_height_px,
            "pixel_size_m": header.pixel_size_m,
            "node_table_offset": header.node_table_offset,
            "edge_table_offset": header.edge_table_offset,
            "stop_table_offset": header.stop_table_offset,
        },
    }

    summary_output.parent.mkdir(parents=True, exist_ok=True)
    summary_output.write_text(json.dumps(summary, indent=2), encoding="utf-8")
    return summary


def _edge_mode_mask_counts(edges: tuple[GraphEdge, ...]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for edge in edges:
        key = str(edge.mode_mask)
        counts[key] = counts.get(key, 0) + 1
    return counts


def _edge_mode_counts(edges: tuple[GraphEdge, ...]) -> dict[str, int]:
    # "walk"/"bike"/"car" now also include composite ferry edges that carry
    # those bits (e.g. a foot+bike passenger ferry) — expected, not a
    # regression; "water" identifies ferry edges specifically.
    counts = {"walk": 0, "bike": 0, "car": 0, "water": 0}
    for edge in edges:
        if edge.mode_mask & MODE_MASK_WALK:
            counts["walk"] += 1
        if edge.mode_mask & MODE_MASK_BIKE:
            counts["bike"] += 1
        if edge.mode_mask & MODE_MASK_CAR:
            counts["car"] += 1
        if edge.mode_mask & MODE_MASK_WATER:
            counts["water"] += 1
    return counts


def _edge_mode_coverage_ratio(edges: tuple[GraphEdge, ...]) -> dict[str, float]:
    total_edges = len(edges)
    if total_edges == 0:
        return {"walk": 0.0, "bike": 0.0, "car": 0.0, "water": 0.0}

    mode_counts = _edge_mode_counts(edges)
    return {
        "walk": mode_counts["walk"] / total_edges,
        "bike": mode_counts["bike"] / total_edges,
        "car": mode_counts["car"] / total_edges,
        "water": mode_counts["water"] / total_edges,
    }
