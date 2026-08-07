import pytest
from isochrone_pipeline.adjacency import AdjacencyGraph, GraphEdge, GraphNode
from isochrone_pipeline.binary_reader import (
    EDGE_RECORD_SIZE,
    HEADER_SIZE,
    NODE_RECORD_SIZE,
    STOP_RECORD_SIZE,
    TRANSIT_FLAG_BIT,
    parse_edge_record,
    parse_header,
    parse_node_record,
    parse_stop_record,
    parse_transit_edge_record,
    transit_edge_table_offset,
    validate_offsets,
)
from isochrone_pipeline.graph_binary import export_graph_binary_bytes
from isochrone_pipeline.gtfs_transit import TransitConnection, TransitStop
from isochrone_pipeline.projection import ProjectionResult


def _projection() -> ProjectionResult:
    return ProjectionResult(
        epsg_code=25833,
        pixel_size_m=10.0,
        origin_easting=392000.0,
        origin_northing=5820000.0,
        max_easting=392100.0,
        max_northing=5820100.0,
        grid_width_px=10,
        grid_height_px=10,
        node_offsets_m={1: (0, 0), 2: (10, 0), 3: (20, 0)},
    )


def test_export_graph_binary_bytes_writes_header_nodes_and_edges() -> None:
    graph = AdjacencyGraph(
        nodes=(
            GraphNode(osm_id=1, x_m=0, y_m=0, first_edge_index=0, edge_count=1, flags=0),
            GraphNode(osm_id=2, x_m=10, y_m=0, first_edge_index=1, edge_count=1, flags=0),
            GraphNode(osm_id=3, x_m=20, y_m=0, first_edge_index=2, edge_count=0, flags=0),
        ),
        edges=(
            GraphEdge(
                source_index=0,
                target_index=1,
                cost_seconds=7,
                flags=2,
                mode_mask=0b0000_0111,
                maxspeed_kph=50,
                road_class_id=9,
            ),
            GraphEdge(
                source_index=1,
                target_index=2,
                cost_seconds=9,
                flags=4,
                mode_mask=0b0000_0001,
                maxspeed_kph=20,
                road_class_id=3,
            ),
        ),
        skipped_constraint_way_count=0,
    )

    payload = export_graph_binary_bytes(graph, projection=_projection())

    header = parse_header(payload)
    assert header.version == 2
    assert header.flags == 0
    assert header.n_nodes == 3
    assert header.n_edges == 2
    assert header.n_stops == 0
    assert header.n_tedges == 0
    assert header.origin_easting == 392000.0
    assert header.origin_northing == 5820000.0
    assert header.epsg_code == 25833
    assert header.grid_width_px == 10
    assert header.grid_height_px == 10
    assert header.pixel_size_m == 10.0

    assert header.node_table_offset == HEADER_SIZE
    assert header.edge_table_offset == HEADER_SIZE + (3 * NODE_RECORD_SIZE)
    assert header.stop_table_offset == header.edge_table_offset + (2 * EDGE_RECORD_SIZE)
    assert len(payload) == header.stop_table_offset

    node0 = parse_node_record(payload, header.node_table_offset)
    node1 = parse_node_record(payload, header.node_table_offset + NODE_RECORD_SIZE)
    edge0 = parse_edge_record(payload, header.edge_table_offset)
    edge1 = parse_edge_record(payload, header.edge_table_offset + EDGE_RECORD_SIZE)

    assert node0.x_m == 0
    assert node0.first_edge_index == 0
    assert node0.edge_count == 1
    assert node1.x_m == 10
    assert node1.first_edge_index == 1

    assert edge0.target_node_index == 1
    assert edge0.cost_seconds == 7
    assert edge0.flags == 2
    assert edge0.mode_mask == 0b0000_0111
    assert edge0.maxspeed_kph == 50
    assert edge0.road_class_id == 9

    assert edge1.target_node_index == 2
    assert edge1.cost_seconds == 9
    assert edge1.flags == 4
    assert edge1.mode_mask == 0b0000_0001
    assert edge1.maxspeed_kph == 20
    assert edge1.road_class_id == 3


def test_export_graph_binary_bytes_rejects_invalid_node_edge_layout() -> None:
    graph = AdjacencyGraph(
        nodes=(
            GraphNode(osm_id=1, x_m=0, y_m=0, first_edge_index=0, edge_count=1, flags=0),
            GraphNode(osm_id=2, x_m=10, y_m=0, first_edge_index=1, edge_count=0, flags=0),
        ),
        edges=(GraphEdge(source_index=1, target_index=0, cost_seconds=7, flags=0),),
        skipped_constraint_way_count=0,
    )

    with pytest.raises(ValueError, match="source_index"):
        export_graph_binary_bytes(graph, projection=_projection())


def _small_graph() -> AdjacencyGraph:
    return AdjacencyGraph(
        nodes=(
            GraphNode(osm_id=1, x_m=0, y_m=0, first_edge_index=0, edge_count=1, flags=0),
            GraphNode(osm_id=2, x_m=10, y_m=0, first_edge_index=1, edge_count=0, flags=0),
        ),
        edges=(GraphEdge(source_index=0, target_index=1, cost_seconds=7, flags=0),),
        skipped_constraint_way_count=0,
    )


def test_export_graph_binary_bytes_writes_stops_and_transit_edges() -> None:
    stops = (
        TransitStop(
            stop_id="s1",
            name="Stop 1",
            x_m=0,
            y_m=0,
            nearest_node_index=0,
            walk_attach_cost_seconds=10,
            transport_type=2,
        ),
        TransitStop(
            stop_id="s2",
            name="Stop 2",
            x_m=10,
            y_m=0,
            nearest_node_index=1,
            walk_attach_cost_seconds=5,
            transport_type=0,
        ),
    )
    connections = (
        TransitConnection(
            from_stop_index=0,
            to_stop_index=1,
            departure_seconds=28800,
            arrival_seconds=28920,
            route_id=3,
            service_day_mask=0b0011111,
        ),
    )

    payload = export_graph_binary_bytes(
        _small_graph(), projection=_projection(), stops=stops, transit_edges=connections
    )

    header = parse_header(payload)
    validate_offsets(header, len(payload))
    assert header.flags & TRANSIT_FLAG_BIT
    assert header.n_stops == 2
    assert header.n_tedges == 1

    stop0 = parse_stop_record(payload, header.stop_table_offset)
    stop1 = parse_stop_record(payload, header.stop_table_offset + STOP_RECORD_SIZE)
    assert stop0.nearest_node_index == 0
    assert stop0.transport_type == 2
    assert stop1.nearest_node_index == 1
    assert stop1.transport_type == 0

    tedge_offset = transit_edge_table_offset(header)
    tedge0 = parse_transit_edge_record(payload, tedge_offset)
    assert tedge0.from_stop_index == 0
    assert tedge0.to_stop_index == 1
    assert tedge0.departure_seconds_from_midnight == 28800
    assert tedge0.travel_seconds == 120
    assert tedge0.route_id == 3
    assert tedge0.service_day_mask == 0b0011111
    assert len(payload) == tedge_offset + len(connections) * 20


def test_export_graph_binary_bytes_rejects_stop_with_bad_node_index() -> None:
    stops = (
        TransitStop(
            stop_id="s1",
            name="Stop 1",
            x_m=0,
            y_m=0,
            nearest_node_index=99,
            walk_attach_cost_seconds=10,
            transport_type=0,
        ),
    )

    with pytest.raises(ValueError, match="nearest_node_index"):
        export_graph_binary_bytes(_small_graph(), projection=_projection(), stops=stops)


def test_export_graph_binary_bytes_rejects_transit_edge_with_bad_stop_index() -> None:
    stops = (
        TransitStop(
            stop_id="s1",
            name="Stop 1",
            x_m=0,
            y_m=0,
            nearest_node_index=0,
            walk_attach_cost_seconds=10,
            transport_type=0,
        ),
    )
    connections = (
        TransitConnection(
            from_stop_index=0,
            to_stop_index=5,
            departure_seconds=100,
            arrival_seconds=200,
            route_id=0,
            service_day_mask=0,
        ),
    )

    with pytest.raises(ValueError, match="to_stop_index"):
        export_graph_binary_bytes(
            _small_graph(), projection=_projection(), stops=stops, transit_edges=connections
        )
