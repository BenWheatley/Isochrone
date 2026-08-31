"""Walkable connections between transit stops."""

from __future__ import annotations

from pathlib import Path

from isochrone_pipeline.adjacency import AdjacencyGraph, GraphEdge, GraphNode
from isochrone_pipeline.gtfs_transit import TransitStop
from isochrone_pipeline.transit_transfers import (
    ROAD_CLASS_MOTORWAY,
    WALKING_SPEED_M_S,
    build_transit_transfers,
    parse_declared_transfers,
)

MODE_MASK_WALK = 1 << 0
MODE_MASK_CAR = 1 << 2


def _cost_seconds_for_metres(metres: float) -> int:
    return max(1, round(metres / WALKING_SPEED_M_S))


def _chain_graph(
    node_positions: tuple[tuple[int, int], ...],
    links: tuple[tuple[int, int, float], ...],
    *,
    road_class_id: int = 11,
    mode_mask: int = MODE_MASK_WALK,
) -> AdjacencyGraph:
    """Nodes at the given positions, with `links` as (from, to, metres) edges
    in both directions."""
    outgoing: dict[int, list[GraphEdge]] = {index: [] for index in range(len(node_positions))}
    for from_index, to_index, metres in links:
        for source, target in ((from_index, to_index), (to_index, from_index)):
            outgoing[source].append(
                GraphEdge(
                    source_index=source,
                    target_index=target,
                    cost_seconds=_cost_seconds_for_metres(metres),
                    flags=0,
                    mode_mask=mode_mask,
                    maxspeed_kph=0,
                    road_class_id=road_class_id,
                )
            )

    edges: list[GraphEdge] = []
    nodes: list[GraphNode] = []
    for index, (x_m, y_m) in enumerate(node_positions):
        nodes.append(
            GraphNode(
                osm_id=index + 1,
                x_m=x_m,
                y_m=y_m,
                first_edge_index=len(edges),
                edge_count=len(outgoing[index]),
                flags=0,
            )
        )
        edges.extend(outgoing[index])
    return AdjacencyGraph(nodes=tuple(nodes), edges=tuple(edges), skipped_constraint_way_count=0)


def _stop(stop_id: str, x_m: int, node_index: int) -> TransitStop:
    return TransitStop(
        stop_id=stop_id,
        name=stop_id,
        x_m=x_m,
        y_m=0,
        nearest_node_index=node_index,
        walk_attach_cost_seconds=0,
        transport_type=2,
    )


def test_transfer_distance_follows_the_walk_network_not_the_straight_line() -> None:
    """Two stops facing each other across a river. They are 100 m apart as the
    crow flies; the only crossing is a 600 m detour, which is what a rider
    actually walks - and is past the radius, so there is no interchange here at
    all."""
    graph = _chain_graph(
        node_positions=((0, 0), (0, 300), (100, 300), (100, 0)),
        links=((0, 1, 300.0), (1, 2, 100.0), (2, 3, 300.0)),
    )
    stops = (_stop("north-bank", 0, 0), _stop("south-bank", 100, 3))

    summary = build_transit_transfers(graph, stops, radius_m=500.0)
    assert summary.transfers == ()

    # Widen the radius past the detour and the pair appears - at the length of
    # the detour, 700 m, not the 100 m separating the two banks.
    wide = build_transit_transfers(graph, stops, radius_m=800.0)
    distances = {(t.from_stop_index, t.to_stop_index): t.walk_distance_m for t in wide.transfers}
    assert set(distances) == {(0, 1), (1, 0)}
    # 700 m of detour, give or take the graph's integer-seconds encoding: each
    # edge's length is recovered as round(metres / speed) * speed.
    assert abs(distances[(0, 1)] - 700) <= 2
    assert distances[(1, 0)] == distances[(0, 1)]


def test_transfer_search_refuses_a_road_the_runtime_would_not_walk() -> None:
    motorway_only = _chain_graph(
        node_positions=((0, 0), (100, 0)),
        links=((0, 1, 100.0),),
        road_class_id=ROAD_CLASS_MOTORWAY,
    )
    stops = (_stop("a", 0, 0), _stop("b", 100, 1))
    assert build_transit_transfers(motorway_only, stops, radius_m=500.0).transfers == ()

    car_only = _chain_graph(
        node_positions=((0, 0), (100, 0)),
        links=((0, 1, 100.0),),
        mode_mask=MODE_MASK_CAR,
    )
    assert build_transit_transfers(car_only, stops, radius_m=500.0).transfers == ()


def test_attachment_offsets_count_towards_the_transfer_distance() -> None:
    graph = _chain_graph(node_positions=((0, 0), (100, 0)), links=((0, 1, 100.0),))
    # Each stop sits 40 m off the node it is pinned to, so the walk is
    # 40 + 100 + 40, not 100.
    stops = (_stop("a", -40, 0), _stop("b", 140, 1))
    transfers = build_transit_transfers(graph, stops, radius_m=500.0).transfers
    assert {t.walk_distance_m for t in transfers} == {180}


def test_declared_transfers_repair_an_interchange_the_walk_graph_cannot_route(
    tmp_path: Path,
) -> None:
    """Where OSM has not joined the ways, routing finds nothing. The operator
    says the change exists, and the operator is right."""
    disconnected = _chain_graph(node_positions=((0, 0), (60, 0)), links=())
    stops = (_stop("platform-a", 0, 0), _stop("platform-b", 60, 1))
    assert build_transit_transfers(disconnected, stops, radius_m=500.0).transfers == ()

    (tmp_path / "transfers.txt").write_text(
        "from_stop_id,to_stop_id,transfer_type,min_transfer_time\nplatform-a,platform-b,2,300\n",
        encoding="utf-8",
    )
    summary = build_transit_transfers(disconnected, stops, feed_dir=tmp_path, radius_m=500.0)
    assert len(summary.transfers) == 1
    assert summary.declared_only_pair_count == 1
    transfer = summary.transfers[0]
    assert (transfer.from_stop_index, transfer.to_stop_index) == (0, 1)
    # Straight-line, used only because somebody has asserted this is walkable.
    assert transfer.walk_distance_m == 60
    assert transfer.min_transfer_seconds == 300


def test_declared_minimum_time_attaches_to_a_routed_transfer(tmp_path: Path) -> None:
    graph = _chain_graph(node_positions=((0, 0), (100, 0)), links=((0, 1, 100.0),))
    stops = (_stop("a", 0, 0), _stop("b", 100, 1))
    (tmp_path / "transfers.txt").write_text(
        "from_stop_id,to_stop_id,transfer_type,min_transfer_time\na,b,2,240\n",
        encoding="utf-8",
    )
    transfers = build_transit_transfers(graph, stops, feed_dir=tmp_path, radius_m=500.0).transfers
    by_pair = {(t.from_stop_index, t.to_stop_index): t for t in transfers}
    assert by_pair[(0, 1)].walk_distance_m == 100
    assert by_pair[(0, 1)].min_transfer_seconds == 240
    # The reverse direction was not declared, so it keeps the routed distance
    # and leaves the minimum for the browser's own floor.
    assert by_pair[(1, 0)].min_transfer_seconds == 0


def test_a_forbidden_transfer_is_removed_even_though_it_routes(tmp_path: Path) -> None:
    graph = _chain_graph(node_positions=((0, 0), (100, 0)), links=((0, 1, 100.0),))
    stops = (_stop("a", 0, 0), _stop("b", 100, 1))
    (tmp_path / "transfers.txt").write_text(
        "from_stop_id,to_stop_id,transfer_type,min_transfer_time\na,b,3,\n",
        encoding="utf-8",
    )
    summary = build_transit_transfers(graph, stops, feed_dir=tmp_path, radius_m=500.0)
    assert summary.forbidden_pair_count == 1
    assert {(t.from_stop_index, t.to_stop_index) for t in summary.transfers} == {(1, 0)}


def test_parse_declared_transfers_skips_self_transfers(tmp_path: Path) -> None:
    """A row saying "changing here takes five minutes" needs a trip id to tell
    a change from staying aboard, and the transit-edge record has none."""
    (tmp_path / "transfers.txt").write_text(
        "from_stop_id,to_stop_id,transfer_type,min_transfer_time\na,a,2,300\na,b,2,120\n",
        encoding="utf-8",
    )
    declared, forbidden = parse_declared_transfers(tmp_path)
    assert declared == {("a", "b"): 120}
    assert forbidden == set()


def test_transfers_are_sorted_for_the_writer_s_csr_layout() -> None:
    graph = _chain_graph(
        node_positions=((0, 0), (100, 0), (200, 0)),
        links=((0, 1, 100.0), (1, 2, 100.0)),
    )
    stops = (_stop("a", 0, 0), _stop("b", 100, 1), _stop("c", 200, 2))
    transfers = build_transit_transfers(graph, stops, radius_m=500.0).transfers
    keys = [(t.from_stop_index, t.to_stop_index) for t in transfers]
    assert keys == sorted(keys)
