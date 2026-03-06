from __future__ import annotations

import pytest
from isochrone_pipeline.adjacency import AdjacencyGraph, GraphEdge, GraphNode
from isochrone_pipeline.binary_validation import (
    BERLIN_BBOX,
    validate_binary_graph_payload,
)
from isochrone_pipeline.graph_binary import export_graph_binary_bytes
from isochrone_pipeline.projection import ProjectionResult


def _projection() -> ProjectionResult:
    return ProjectionResult(
        epsg_code=25833,
        pixel_size_m=10.0,
        origin_easting=370035.4331555407,
        origin_northing=5799762.899206582,
        max_easting=370100.0,
        max_northing=5799900.0,
        grid_width_px=10,
        grid_height_px=10,
        node_offsets_m={1: (0, 0), 2: (20, 20)},
    )


def _graph() -> AdjacencyGraph:
    return AdjacencyGraph(
        nodes=(
            GraphNode(osm_id=1, x_m=0, y_m=0, first_edge_index=0, edge_count=1, flags=0),
            GraphNode(osm_id=2, x_m=20, y_m=20, first_edge_index=1, edge_count=0, flags=0),
        ),
        edges=(GraphEdge(source_index=0, target_index=1, cost_seconds=10, flags=0),),
        skipped_constraint_way_count=0,
    )


def test_validate_binary_graph_payload_accepts_valid_payload() -> None:
    payload = export_graph_binary_bytes(_graph(), projection=_projection())

    result = validate_binary_graph_payload(payload, node_sample_count=2, random_seed=1)

    assert result.header.version == 1
    assert result.sampled_node_count == 2
    assert result.edge_target_violations == 0
    assert all(
        BERLIN_BBOX.lat_min <= spot.lat <= BERLIN_BBOX.lat_max
        and BERLIN_BBOX.lon_min <= spot.lon <= BERLIN_BBOX.lon_max
        for spot in result.node_spot_checks
    )


def test_validate_binary_graph_payload_rejects_wrong_version() -> None:
    payload = bytearray(export_graph_binary_bytes(_graph(), projection=_projection()))
    payload[4] = 2

    with pytest.raises(ValueError, match="unsupported version"):
        validate_binary_graph_payload(bytes(payload))


def test_validate_binary_graph_payload_rejects_out_of_range_edge_target() -> None:
    graph = AdjacencyGraph(
        nodes=(GraphNode(osm_id=1, x_m=0, y_m=0, first_edge_index=0, edge_count=1, flags=0),),
        edges=(GraphEdge(source_index=0, target_index=99, cost_seconds=10, flags=0),),
        skipped_constraint_way_count=0,
    )

    payload = export_graph_binary_bytes(graph, projection=_projection())

    with pytest.raises(ValueError, match="edge target index out of range"):
        validate_binary_graph_payload(payload)


def test_validate_binary_graph_payload_rejects_nodes_outside_berlin_bbox() -> None:
    projection = ProjectionResult(
        epsg_code=25833,
        pixel_size_m=10.0,
        origin_easting=100000.0,
        origin_northing=100000.0,
        max_easting=100010.0,
        max_northing=100010.0,
        grid_width_px=1,
        grid_height_px=1,
        node_offsets_m={1: (0, 0)},
    )
    graph = AdjacencyGraph(
        nodes=(GraphNode(osm_id=1, x_m=0, y_m=0, first_edge_index=0, edge_count=0, flags=0),),
        edges=(),
        skipped_constraint_way_count=0,
    )

    payload = export_graph_binary_bytes(graph, projection=projection)

    with pytest.raises(ValueError, match="outside Berlin bounding box"):
        validate_binary_graph_payload(payload, node_sample_count=1, random_seed=0)
