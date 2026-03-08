"""Build directed walking adjacency lists from extracted ways and projected nodes."""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, replace

from .osm_graph_extract import WalkableGraphExtract, WayCandidate
from .projection import ProjectionResult

WALKING_SPEED_M_S = 1.39
MAX_EDGE_COST_SECONDS = 65535

NODE_FLAG_CROSSING = 1 << 0
NODE_FLAG_LEVEL_CROSSING = 1 << 1
NODE_FLAG_ENTRANCE = 1 << 2
NODE_FLAG_BARRIER = 1 << 3

EDGE_FLAG_SIDEWALK_PRESENT = 1 << 0
EDGE_FLAG_RESERVED_RESTRICTION_A = 1 << 8
EDGE_FLAG_RESERVED_RESTRICTION_B = 1 << 9
EDGE_FLAG_RESERVED_RESTRICTION_C = 1 << 10
EDGE_FLAG_RESERVED_DYNAMIC_ACCESS = 1 << 11

MODE_MASK_WALK = 1 << 0
MODE_MASK_BIKE = 1 << 1
MODE_MASK_CAR = 1 << 2

ROAD_CLASS_BY_HIGHWAY: dict[str, int] = {
    "footway": 1,
    "path": 2,
    "pedestrian": 3,
    "steps": 4,
    "living_street": 5,
    "residential": 6,
    "service": 7,
    "cycleway": 8,
    "track": 9,
    "unclassified": 10,
    "tertiary": 11,
    "secondary": 12,
    "primary": 13,
    "trunk": 14,
    "motorway": 15,
}


@dataclass(frozen=True)
class GraphNode:
    osm_id: int | None
    x_m: int
    y_m: int
    first_edge_index: int
    edge_count: int
    flags: int


@dataclass(frozen=True)
class GraphEdge:
    source_index: int
    target_index: int
    cost_seconds: int
    flags: int
    mode_mask: int = MODE_MASK_WALK
    maxspeed_kph: int = 0
    road_class_id: int = 0


@dataclass(frozen=True)
class AdjacencyGraph:
    nodes: tuple[GraphNode, ...]
    edges: tuple[GraphEdge, ...]
    skipped_constraint_way_count: int


class _AdjacencyBuilder:
    def __init__(self, extracted: WalkableGraphExtract, projected: ProjectionResult) -> None:
        self._nodes: list[GraphNode] = []
        self._node_positions: list[tuple[float, float]] = []
        self._osm_id_to_index: dict[int, int] = {}
        self._edges: list[GraphEdge] = []
        self._synthetic_next_id = -1
        self._skipped_constraint_way_count = 0

        for osm_id in sorted(projected.node_offsets_m):
            x_m, y_m = projected.node_offsets_m[osm_id]
            flags = _connector_flags(extracted, osm_id)
            index = len(self._nodes)
            self._osm_id_to_index[osm_id] = index
            self._nodes.append(
                GraphNode(
                    osm_id=osm_id,
                    x_m=x_m,
                    y_m=y_m,
                    first_edge_index=0,
                    edge_count=0,
                    flags=flags,
                )
            )
            self._node_positions.append((float(x_m), float(y_m)))

    def build(self, ways: tuple[WayCandidate, ...]) -> AdjacencyGraph:
        for way in ways:
            if _is_way_disallowed(way):
                self._skipped_constraint_way_count += 1
                continue

            oneway_foot = way.constraints.get("oneway:foot") == "yes"
            edge_flags = _edge_flags(way)
            edge_mode_mask = _mode_mask_for_way(way)
            edge_maxspeed_kph = _maxspeed_kph_for_way(way)
            edge_road_class_id = _road_class_id_for_way(way.highway)

            for src_osm_id, dst_osm_id in zip(way.node_ids, way.node_ids[1:], strict=False):
                src_index = self._osm_id_to_index[src_osm_id]
                dst_index = self._osm_id_to_index[dst_osm_id]

                self._add_directed_edge_with_splitting(
                    src_index,
                    dst_index,
                    edge_flags,
                    edge_mode_mask,
                    edge_maxspeed_kph,
                    edge_road_class_id,
                )
                if not oneway_foot:
                    self._add_directed_edge_with_splitting(
                        dst_index,
                        src_index,
                        edge_flags,
                        edge_mode_mask,
                        edge_maxspeed_kph,
                        edge_road_class_id,
                    )

        sorted_edges = sorted(self._edges, key=lambda edge: (edge.source_index, edge.target_index))

        nodes = list(self._nodes)
        first_index = 0
        i = 0
        while i < len(sorted_edges):
            source_index = sorted_edges[i].source_index
            j = i
            while j < len(sorted_edges) and sorted_edges[j].source_index == source_index:
                j += 1

            nodes[source_index] = replace(
                nodes[source_index],
                first_edge_index=i,
                edge_count=j - i,
            )
            first_index = j
            i = j

        # Keep static analyzers honest about full edge scan side effects.
        _ = first_index

        return AdjacencyGraph(
            nodes=tuple(nodes),
            edges=tuple(sorted_edges),
            skipped_constraint_way_count=self._skipped_constraint_way_count,
        )

    def _add_directed_edge_with_splitting(
        self,
        source_index: int,
        target_index: int,
        flags: int,
        mode_mask: int,
        maxspeed_kph: int,
        road_class_id: int,
    ) -> None:
        source = self._node_positions[source_index]
        target = self._node_positions[target_index]

        self._add_segment_recursive(
            source_index=source_index,
            source_xy=source,
            target_index=target_index,
            target_xy=target,
            flags=flags,
            mode_mask=mode_mask,
            maxspeed_kph=maxspeed_kph,
            road_class_id=road_class_id,
        )

    def _add_segment_recursive(
        self,
        source_index: int,
        source_xy: tuple[float, float],
        target_index: int,
        target_xy: tuple[float, float],
        flags: int,
        mode_mask: int,
        maxspeed_kph: int,
        road_class_id: int,
    ) -> None:
        distance_m = math.hypot(target_xy[0] - source_xy[0], target_xy[1] - source_xy[1])
        cost_seconds = max(1, int(round(distance_m / WALKING_SPEED_M_S)))

        if cost_seconds <= MAX_EDGE_COST_SECONDS:
            self._edges.append(
                GraphEdge(
                    source_index=source_index,
                    target_index=target_index,
                    cost_seconds=cost_seconds,
                    flags=flags,
                    mode_mask=mode_mask,
                    maxspeed_kph=maxspeed_kph,
                    road_class_id=road_class_id,
                )
            )
            return

        midpoint_xy = ((source_xy[0] + target_xy[0]) / 2.0, (source_xy[1] + target_xy[1]) / 2.0)

        if midpoint_xy == source_xy or midpoint_xy == target_xy:
            capped_cost = MAX_EDGE_COST_SECONDS
            self._edges.append(
                GraphEdge(
                    source_index=source_index,
                    target_index=target_index,
                    cost_seconds=capped_cost,
                    flags=flags,
                    mode_mask=mode_mask,
                    maxspeed_kph=maxspeed_kph,
                    road_class_id=road_class_id,
                )
            )
            return

        midpoint_index = self._append_synthetic_node(midpoint_xy)
        self._add_segment_recursive(
            source_index=source_index,
            source_xy=source_xy,
            target_index=midpoint_index,
            target_xy=midpoint_xy,
            flags=flags,
            mode_mask=mode_mask,
            maxspeed_kph=maxspeed_kph,
            road_class_id=road_class_id,
        )
        self._add_segment_recursive(
            source_index=midpoint_index,
            source_xy=midpoint_xy,
            target_index=target_index,
            target_xy=target_xy,
            flags=flags,
            mode_mask=mode_mask,
            maxspeed_kph=maxspeed_kph,
            road_class_id=road_class_id,
        )

    def _append_synthetic_node(self, xy: tuple[float, float]) -> int:
        node = GraphNode(
            osm_id=self._synthetic_next_id,
            x_m=int(round(xy[0])),
            y_m=int(round(xy[1])),
            first_edge_index=0,
            edge_count=0,
            flags=0,
        )
        self._synthetic_next_id -= 1

        index = len(self._nodes)
        self._nodes.append(node)
        self._node_positions.append(xy)
        return index


def build_adjacency_graph(
    extracted: WalkableGraphExtract,
    projected: ProjectionResult,
) -> AdjacencyGraph:
    builder = _AdjacencyBuilder(extracted=extracted, projected=projected)
    return builder.build(extracted.ways)


def _is_way_disallowed(way: WayCandidate) -> bool:
    access = way.constraints.get("access")
    foot = way.constraints.get("foot")

    if access in {"private", "no"}:
        return True
    if foot == "no":
        return True

    return False


def _edge_flags(way: WayCandidate) -> int:
    flags = 0

    sidewalk = way.constraints.get("sidewalk")
    if sidewalk is not None and sidewalk not in {"no", "none"}:
        flags |= EDGE_FLAG_SIDEWALK_PRESENT

    return flags


def _connector_flags(extracted: WalkableGraphExtract, osm_id: int) -> int:
    connector = extracted.connector_nodes.get(osm_id)
    if connector is None:
        return 0

    flags = 0
    for connector_type in connector.connector_types:
        if connector_type == "crossing":
            flags |= NODE_FLAG_CROSSING
        elif connector_type == "level_crossing":
            flags |= NODE_FLAG_LEVEL_CROSSING
        elif connector_type == "entrance":
            flags |= NODE_FLAG_ENTRANCE
        elif connector_type == "barrier":
            flags |= NODE_FLAG_BARRIER

    return flags


def _mode_mask_for_way(_way: WayCandidate) -> int:
    # Multimodal semantics land in Phase 10.4.3; v2 writes walk support explicitly now.
    return MODE_MASK_WALK


def _maxspeed_kph_for_way(way: WayCandidate) -> int:
    raw = way.constraints.get("maxspeed")
    if raw is None:
        return 0

    match = re.match(r"^\s*(\d+(?:\.\d+)?)\s*(km/h|kph|mph)?\s*$", raw.lower())
    if match is None:
        return 0

    value = float(match.group(1))
    unit = match.group(2) or "km/h"
    if unit == "mph":
        value *= 1.60934

    rounded = int(round(value))
    return max(0, min(rounded, 65535))


def _road_class_id_for_way(highway: str) -> int:
    return ROAD_CLASS_BY_HIGHWAY.get(highway, 0)
