from isochrone_pipeline.adjacency import (
    EDGE_FLAG_MODE_ONEWAY_BICYCLE_PRESENT,
    EDGE_FLAG_MODE_ONEWAY_PRESENT,
    EDGE_FLAG_MODE_ROUNDABOUT_PRESENT,
    EDGE_FLAG_MODE_SPEED_DIRECTIONAL_PRESENT,
    EDGE_FLAG_RESERVED_DYNAMIC_ACCESS,
    EDGE_FLAG_RESERVED_RESTRICTION_A,
    EDGE_FLAG_RESERVED_RESTRICTION_B,
    EDGE_FLAG_RESERVED_RESTRICTION_C,
    EDGE_FLAG_SIDEWALK_PRESENT,
    MODE_MASK_BIKE,
    MODE_MASK_CAR,
    MODE_MASK_WALK,
    NODE_FLAG_BARRIER,
    NODE_FLAG_CROSSING,
    build_adjacency_graph,
)
from isochrone_pipeline.osm_graph_extract import ConnectorNode, WalkableGraphExtract, WayCandidate
from isochrone_pipeline.projection import ProjectionResult


def _projection(node_offsets_m: dict[int, tuple[int, int]]) -> ProjectionResult:
    eastings = [float(offset[0]) for offset in node_offsets_m.values()]
    northings = [float(offset[1]) for offset in node_offsets_m.values()]
    return ProjectionResult(
        epsg_code=25833,
        pixel_size_m=10.0,
        origin_easting=min(eastings),
        origin_northing=min(northings),
        max_easting=max(eastings),
        max_northing=max(northings),
        grid_width_px=1,
        grid_height_px=1,
        node_offsets_m=node_offsets_m,
    )


def test_builds_bidirectional_edges_and_indexes_nodes() -> None:
    extracted = WalkableGraphExtract(
        ways=(
            WayCandidate(
                osm_id=100,
                highway="footway",
                node_ids=(1, 2, 3),
                constraints={},
            ),
        ),
        node_coords={1: (52.5, 13.4), 2: (52.5001, 13.401), 3: (52.5002, 13.402)},
        connector_nodes={},
        dropped_way_count=0,
    )
    projected = _projection({1: (0, 0), 2: (10, 0), 3: (20, 0)})

    graph = build_adjacency_graph(extracted, projected)

    assert len(graph.nodes) == 3
    assert len(graph.edges) == 4

    node0 = graph.nodes[0]
    assert node0.first_edge_index == 0
    assert node0.edge_count == 1

    node1 = graph.nodes[1]
    assert node1.edge_count == 2


def test_oneway_foot_yes_emits_only_forward_edges() -> None:
    extracted = WalkableGraphExtract(
        ways=(
            WayCandidate(
                osm_id=200,
                highway="footway",
                node_ids=(1, 2),
                constraints={"oneway:foot": "yes"},
            ),
        ),
        node_coords={1: (52.5, 13.4), 2: (52.5001, 13.401)},
        connector_nodes={},
        dropped_way_count=0,
    )
    projected = _projection({1: (0, 0), 2: (10, 0)})

    graph = build_adjacency_graph(extracted, projected)

    assert len(graph.edges) == 1
    assert graph.edges[0].source_index == 0
    assert graph.edges[0].target_index == 1


def test_constraints_and_connector_flags_are_applied() -> None:
    extracted = WalkableGraphExtract(
        ways=(
            WayCandidate(
                osm_id=300,
                highway="residential",
                node_ids=(1, 2),
                constraints={"access": "private"},
            ),
            WayCandidate(
                osm_id=301,
                highway="residential",
                node_ids=(2, 3),
                constraints={"sidewalk": "both"},
            ),
        ),
        node_coords={1: (52.5, 13.4), 2: (52.5001, 13.401), 3: (52.5002, 13.402)},
        connector_nodes={
            2: ConnectorNode(
                osm_id=2,
                lat=52.5001,
                lon=13.401,
                connector_types=("crossing", "barrier"),
            )
        },
        dropped_way_count=0,
    )
    projected = _projection({1: (0, 0), 2: (10, 0), 3: (20, 0)})

    graph = build_adjacency_graph(extracted, projected)

    assert graph.skipped_constraint_way_count == 1
    assert len(graph.edges) == 2

    node_for_osm_2 = next(node for node in graph.nodes if node.osm_id == 2)
    assert node_for_osm_2.flags & NODE_FLAG_CROSSING
    assert node_for_osm_2.flags & NODE_FLAG_BARRIER

    for edge in graph.edges:
        assert edge.flags & EDGE_FLAG_SIDEWALK_PRESENT


def test_long_edges_are_split_to_fit_uint16_cost() -> None:
    extracted = WalkableGraphExtract(
        ways=(
            WayCandidate(
                osm_id=400,
                highway="footway",
                node_ids=(1, 2),
                constraints={},
            ),
        ),
        node_coords={1: (52.5, 13.4), 2: (52.5001, 13.401)},
        connector_nodes={},
        dropped_way_count=0,
    )
    # 300 km segment to force splits.
    projected = _projection({1: (0, 0), 2: (300_000, 0)})

    graph = build_adjacency_graph(extracted, projected)

    assert len(graph.nodes) > 2
    assert len(graph.edges) > 2
    assert all(edge.cost_seconds <= 65535 for edge in graph.edges)


def test_edges_include_mode_speed_and_road_metadata() -> None:
    extracted = WalkableGraphExtract(
        ways=(
            WayCandidate(
                osm_id=500,
                highway="footway",
                node_ids=(1, 2),
                constraints={"maxspeed": "30 mph"},
            ),
        ),
        node_coords={1: (52.5, 13.4), 2: (52.5001, 13.401)},
        connector_nodes={},
        dropped_way_count=0,
    )
    projected = _projection({1: (0, 0), 2: (10, 0)})

    graph = build_adjacency_graph(extracted, projected)

    assert len(graph.edges) == 2
    for edge in graph.edges:
        assert edge.mode_mask == MODE_MASK_WALK
        assert edge.maxspeed_kph == 48
        assert edge.road_class_id == 1


def test_reserved_restriction_flag_bits_do_not_overlap_sidewalk_flag() -> None:
    reserved_mask = (
        EDGE_FLAG_RESERVED_RESTRICTION_A
        | EDGE_FLAG_RESERVED_RESTRICTION_B
        | EDGE_FLAG_RESERVED_RESTRICTION_C
        | EDGE_FLAG_RESERVED_DYNAMIC_ACCESS
    )
    assert EDGE_FLAG_SIDEWALK_PRESENT & reserved_mask == 0


def test_mode_mask_applies_vehicle_access_overrides() -> None:
    extracted = WalkableGraphExtract(
        ways=(
            WayCandidate(
                osm_id=600,
                highway="residential",
                node_ids=(1, 2),
                constraints={
                    "foot": "yes",
                    "bicycle": "no",
                    "vehicle": "no",
                    "motor_vehicle": "yes",
                },
            ),
        ),
        node_coords={1: (52.5, 13.4), 2: (52.5001, 13.401)},
        connector_nodes={},
        dropped_way_count=0,
    )
    projected = _projection({1: (0, 0), 2: (10, 0)})

    graph = build_adjacency_graph(extracted, projected)

    assert len(graph.edges) == 2
    for edge in graph.edges:
        assert edge.mode_mask == (MODE_MASK_WALK | MODE_MASK_CAR)
        assert (edge.mode_mask & MODE_MASK_BIKE) == 0


def test_flags_capture_directionality_tag_presence() -> None:
    extracted = WalkableGraphExtract(
        ways=(
            WayCandidate(
                osm_id=601,
                highway="residential",
                node_ids=(1, 2),
                constraints={
                    "oneway": "yes",
                    "oneway:bicycle": "yes",
                    "junction": "roundabout",
                    "maxspeed:forward": "50",
                },
            ),
        ),
        node_coords={1: (52.5, 13.4), 2: (52.5001, 13.401)},
        connector_nodes={},
        dropped_way_count=0,
    )
    projected = _projection({1: (0, 0), 2: (10, 0)})

    graph = build_adjacency_graph(extracted, projected)

    assert len(graph.edges) == 2
    for edge in graph.edges:
        assert edge.flags & EDGE_FLAG_MODE_ONEWAY_PRESENT
        assert edge.flags & EDGE_FLAG_MODE_ONEWAY_BICYCLE_PRESENT
        assert edge.flags & EDGE_FLAG_MODE_ROUNDABOUT_PRESENT
        assert edge.flags & EDGE_FLAG_MODE_SPEED_DIRECTIONAL_PRESENT


def test_maxspeed_parser_supports_units_and_walk_keyword() -> None:
    extracted = WalkableGraphExtract(
        ways=(
            WayCandidate(
                osm_id=700,
                highway="residential",
                node_ids=(1, 2),
                constraints={"maxspeed": "50 km/h"},
            ),
            WayCandidate(
                osm_id=701,
                highway="residential",
                node_ids=(2, 3),
                constraints={"maxspeed": "30mph"},
            ),
            WayCandidate(
                osm_id=702,
                highway="footway",
                node_ids=(3, 4),
                constraints={"maxspeed": "walk"},
            ),
            WayCandidate(
                osm_id=703,
                highway="residential",
                node_ids=(4, 5),
                constraints={"maxspeed": "50;70"},
            ),
        ),
        node_coords={
            1: (52.5, 13.4),
            2: (52.5001, 13.401),
            3: (52.5002, 13.402),
            4: (52.5003, 13.403),
            5: (52.5004, 13.404),
        },
        connector_nodes={},
        dropped_way_count=0,
    )
    projected = _projection({1: (0, 0), 2: (10, 0), 3: (20, 0), 4: (30, 0), 5: (40, 0)})

    graph = build_adjacency_graph(extracted, projected)

    maxspeed_by_road_class: dict[int, set[int]] = {}
    for edge in graph.edges:
        bucket = maxspeed_by_road_class.setdefault(edge.road_class_id, set())
        bucket.add(edge.maxspeed_kph)

    # residential
    assert 50 in maxspeed_by_road_class[6]
    assert 48 in maxspeed_by_road_class[6]
    assert 0 not in maxspeed_by_road_class[6]
    # footway walk keyword
    assert maxspeed_by_road_class[1] == {5}
