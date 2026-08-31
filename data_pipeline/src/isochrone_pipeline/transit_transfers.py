"""Walkable connections between transit stops ("footpaths").

A GTFS feed names each platform and each direction of travel as a separate
stop, so an interchange is several stop ids a few dozen metres apart rather
than one. Unless something connects those ids on foot, a Connection Scan can
only ever chain connections that share a stop id - in practice a single
through service - and a rider can never change vehicle.

The obvious way to connect them is straight-line distance between stop
coordinates. It is also wrong: two stops facing each other across a river,
with the nearest bridge two kilometres away, are 100 m apart in a straight
line. The same goes for railway corridors, motorways, walls and private land.

So footpaths are routed over the walk graph, which is built from
OpenStreetMap and therefore already encodes the bridges, crossings, tunnels
and station passages that decide the question. That is exact by construction,
and needs no data the pipeline does not already have.

Routing has the opposite failure: where OSM has not *joined* two ways, a real
interchange looks unwalkable and the footpath vanishes. Geometry
over-connects, routing under-connects. The repair is the operator's own
`transfers.txt`, which asserts which changes exist, how long they take, and
(type 3) which are impossible. The three sources are unioned here.
"""

from __future__ import annotations

import csv
from dataclasses import dataclass
from heapq import heappop, heappush
from math import hypot
from pathlib import Path

from isochrone_pipeline.adjacency import AdjacencyGraph
from isochrone_pipeline.gtfs_transit import TransitStop

# Reconstructs edge length from the stored walking cost. Must stay identical
# to WALKING_SPEED_M_S in web/src/config/constants.js and gtfs_transit.py:
# it is the speed the graph was encoded at, not a preference.
WALKING_SPEED_M_S = 1.39

# Deliberately excluded from walking, matching ROAD_CLASS_MOTORWAY in
# web/src/config/constants.js, so a routed footpath can never use a road the
# runtime would refuse to walk.
ROAD_CLASS_MOTORWAY = 15
MODE_MASK_WALK = 1 << 0

# How far apart two stops may be, along the walk network, and still count as
# an interchange. Comfortably covers a real change even where the routed path
# is twice the straight line; beyond it, walking between stops is walking, and
# the walk graph models that already. Larger radii grow the table roughly
# quadratically.
DEFAULT_TRANSFER_RADIUS_M = 500.0

# transfer_type values, per the GTFS reference.
_TRANSFER_TYPE_NOT_POSSIBLE = "3"


@dataclass(frozen=True)
class TransitTransfer:
    """One directed footpath, ready for the binary."""

    from_stop_index: int
    to_stop_index: int
    walk_distance_m: int
    # 0 means the feed did not say; the browser applies its own floor.
    min_transfer_seconds: int


@dataclass(frozen=True)
class TransferBuildSummary:
    transfers: tuple[TransitTransfer, ...]
    routed_pair_count: int
    declared_pair_count: int
    declared_only_pair_count: int
    forbidden_pair_count: int
    radius_m: float


def _build_walk_adjacency(
    graph: AdjacencyGraph,
) -> tuple[list[int], list[int], list[int], list[float]]:
    """Flat arrays for the search: attribute access on a million dataclasses
    is the whole cost of this step otherwise."""
    node_first_edge = [node.first_edge_index for node in graph.nodes]
    node_edge_count = [node.edge_count for node in graph.nodes]
    edge_target: list[int] = []
    edge_distance_m: list[float] = []
    for edge in graph.edges:
        walkable = (
            edge.mode_mask & MODE_MASK_WALK
        ) != 0 and edge.road_class_id != ROAD_CLASS_MOTORWAY
        edge_target.append(edge.target_index)
        # Negative marks "not walkable", which the search skips. Mirrors the
        # runtime, where such an edge costs Infinity.
        edge_distance_m.append(
            max(1.0, edge.cost_seconds * WALKING_SPEED_M_S) if walkable else -1.0
        )
    return node_first_edge, node_edge_count, edge_target, edge_distance_m


def _walk_distances_within(
    source_node_index: int,
    radius_m: float,
    node_first_edge: list[int],
    node_edge_count: list[int],
    edge_target: list[int],
    edge_distance_m: list[float],
) -> dict[int, float]:
    """Dijkstra bounded by distance walked. Sparse: a 500 m ball holds a few
    hundred nodes, so a dict beats clearing a 577k-entry array per stop."""
    distances: dict[int, float] = {source_node_index: 0.0}
    queue: list[tuple[float, int]] = [(0.0, source_node_index)]
    while queue:
        distance_m, node_index = heappop(queue)
        if distance_m > distances.get(node_index, float("inf")):
            continue
        first_edge = node_first_edge[node_index]
        for edge_index in range(first_edge, first_edge + node_edge_count[node_index]):
            edge_length_m = edge_distance_m[edge_index]
            if edge_length_m < 0:
                continue
            next_distance_m = distance_m + edge_length_m
            if next_distance_m > radius_m:
                continue
            target_index = edge_target[edge_index]
            if next_distance_m < distances.get(target_index, float("inf")):
                distances[target_index] = next_distance_m
                heappush(queue, (next_distance_m, target_index))
    return distances


def parse_declared_transfers(
    feed_dir: Path,
) -> tuple[dict[tuple[str, str], int], set[tuple[str, str]]]:
    """`transfers.txt` as (allowed pairs -> min_transfer_time, forbidden pairs).

    Self-transfers are skipped. A row saying "changing at this stop takes five
    minutes" is real, but honouring it needs a trip id to tell a change from
    staying aboard the same vehicle through the stop, and the transit-edge
    record does not carry one. Charging it blind would penalise through
    riders.
    """
    transfers_path = feed_dir / "transfers.txt"
    if not transfers_path.is_file():
        return {}, set()

    declared: dict[tuple[str, str], int] = {}
    forbidden: set[tuple[str, str]] = set()
    with transfers_path.open("r", encoding="utf-8-sig", newline="") as handle:
        for row in csv.DictReader(handle):
            from_stop_id = (row.get("from_stop_id") or "").strip()
            to_stop_id = (row.get("to_stop_id") or "").strip()
            if not from_stop_id or not to_stop_id or from_stop_id == to_stop_id:
                continue
            pair = (from_stop_id, to_stop_id)
            if (row.get("transfer_type") or "").strip() == _TRANSFER_TYPE_NOT_POSSIBLE:
                forbidden.add(pair)
                continue
            raw_minimum = (row.get("min_transfer_time") or "").strip()
            minimum_seconds = 0
            if raw_minimum:
                try:
                    minimum_seconds = max(0, int(float(raw_minimum)))
                except ValueError:
                    minimum_seconds = 0
            declared[pair] = max(minimum_seconds, declared.get(pair, 0))
    return declared, forbidden


def build_transit_transfers(
    graph: AdjacencyGraph,
    stops: tuple[TransitStop, ...],
    *,
    feed_dir: Path | None = None,
    radius_m: float = DEFAULT_TRANSFER_RADIUS_M,
) -> TransferBuildSummary:
    """Routed footpaths within `radius_m`, unioned with the feed's own
    declarations, as a table sorted by (from_stop_index, to_stop_index)."""
    if not stops:
        return TransferBuildSummary((), 0, 0, 0, 0, radius_m)

    node_first_edge, node_edge_count, edge_target, edge_distance_m = _build_walk_adjacency(graph)

    stop_indices_by_node: dict[int, list[int]] = {}
    for stop_index, stop in enumerate(stops):
        stop_indices_by_node.setdefault(stop.nearest_node_index, []).append(stop_index)

    def attach_distance_m(stop_index: int) -> float:
        stop = stops[stop_index]
        node = graph.nodes[stop.nearest_node_index]
        return hypot(stop.x_m - node.x_m, stop.y_m - node.y_m)

    attach_distances_m = [attach_distance_m(index) for index in range(len(stops))]

    # Keyed by ordered pair; several stops can share an attachment node, so the
    # search is cached per node rather than run per stop.
    routed_distances_m: dict[tuple[int, int], float] = {}
    for source_node_index, source_stop_indices in stop_indices_by_node.items():
        node_distances = _walk_distances_within(
            source_node_index,
            radius_m,
            node_first_edge,
            node_edge_count,
            edge_target,
            edge_distance_m,
        )
        for target_node_index, node_distance_m in node_distances.items():
            for to_stop_index in stop_indices_by_node.get(target_node_index, ()):
                for from_stop_index in source_stop_indices:
                    if from_stop_index == to_stop_index:
                        continue
                    total_m = (
                        attach_distances_m[from_stop_index]
                        + node_distance_m
                        + attach_distances_m[to_stop_index]
                    )
                    if total_m > radius_m:
                        continue
                    pair = (from_stop_index, to_stop_index)
                    if total_m < routed_distances_m.get(pair, float("inf")):
                        routed_distances_m[pair] = total_m

    routed_pair_count = len(routed_distances_m)

    stop_index_by_id = {stop.stop_id: index for index, stop in enumerate(stops)}
    declared_by_id, forbidden_by_id = (
        parse_declared_transfers(feed_dir) if feed_dir is not None else ({}, set())
    )

    def resolve(pair_ids: tuple[str, str]) -> tuple[int, int] | None:
        from_index = stop_index_by_id.get(pair_ids[0])
        to_index = stop_index_by_id.get(pair_ids[1])
        if from_index is None or to_index is None or from_index == to_index:
            return None
        return from_index, to_index

    minimum_seconds_by_pair: dict[tuple[int, int], int] = {}
    declared_only_pair_count = 0
    declared_pair_count = 0
    for pair_ids, minimum_seconds in declared_by_id.items():
        resolved = resolve(pair_ids)
        if resolved is None:
            continue
        pair = resolved
        declared_pair_count += 1
        minimum_seconds_by_pair[pair] = minimum_seconds
        if pair not in routed_distances_m:
            # The operator says this change exists and the walk graph cannot
            # find it - almost always an unjoined way in OSM. Trust the
            # operator, and fall back to straight-line distance, which is only
            # ever used for a pair somebody has asserted is walkable.
            from_stop = stops[pair[0]]
            to_stop = stops[pair[1]]
            routed_distances_m[pair] = hypot(
                from_stop.x_m - to_stop.x_m, from_stop.y_m - to_stop.y_m
            )
            declared_only_pair_count += 1

    forbidden_pair_count = 0
    for pair_ids in forbidden_by_id:
        forbidden_pair = resolve(pair_ids)
        if forbidden_pair is not None and routed_distances_m.pop(forbidden_pair, None) is not None:
            forbidden_pair_count += 1

    transfers = tuple(
        TransitTransfer(
            from_stop_index=from_index,
            to_stop_index=to_index,
            walk_distance_m=min(0xFFFF, max(0, round(distance_m))),
            min_transfer_seconds=min(
                0xFFFF, minimum_seconds_by_pair.get((from_index, to_index), 0)
            ),
        )
        for (from_index, to_index), distance_m in sorted(routed_distances_m.items())
    )
    return TransferBuildSummary(
        transfers=transfers,
        routed_pair_count=routed_pair_count,
        declared_pair_count=declared_pair_count,
        declared_only_pair_count=declared_only_pair_count,
        forbidden_pair_count=forbidden_pair_count,
        radius_m=radius_m,
    )
