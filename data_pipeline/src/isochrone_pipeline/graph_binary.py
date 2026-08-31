"""Binary graph export for graph schema v3."""

from __future__ import annotations

from dataclasses import dataclass

from .adjacency import AdjacencyGraph
from .binary_reader import (
    EDGE_RECORD_SIZE,
    HEADER_SIZE,
    MAGIC,
    NODE_RECORD_SIZE,
    TRANSIT_FLAG_BIT,
)
from .binary_writer import BinaryWriter
from .gtfs_transit import TransitConnection, TransitStop
from .projection import ProjectionResult
from .transit_transfers import TransitTransfer

FORMAT_VERSION = 3


@dataclass(frozen=True)
class GraphBinaryOffsets:
    node_table_offset: int
    edge_table_offset: int
    stop_table_offset: int


def export_graph_binary_bytes(
    graph: AdjacencyGraph,
    *,
    projection: ProjectionResult,
    stops: tuple[TransitStop, ...] = (),
    transit_edges: tuple[TransitConnection, ...] = (),
    transfers: tuple[TransitTransfer, ...] = (),
) -> bytes:
    _validate_adjacency_layout(graph)
    _validate_transit_layout(graph, stops, transit_edges)

    n_nodes = len(graph.nodes)
    n_edges = len(graph.edges)
    n_stops = len(stops)
    n_tedges = len(transit_edges)

    offsets = GraphBinaryOffsets(
        node_table_offset=HEADER_SIZE,
        edge_table_offset=HEADER_SIZE + (n_nodes * NODE_RECORD_SIZE),
        stop_table_offset=HEADER_SIZE + (n_nodes * NODE_RECORD_SIZE) + (n_edges * EDGE_RECORD_SIZE),
    )

    writer = BinaryWriter()

    # Header (64 bytes)
    writer.write_u32(MAGIC)
    writer.write_u8(FORMAT_VERSION)
    writer.write_u8(TRANSIT_FLAG_BIT if n_stops > 0 else 0)
    writer.write_u16(0)

    writer.write_u32(n_nodes)
    writer.write_u32(n_edges)
    writer.write_u32(n_stops)
    writer.write_u32(n_tedges)

    writer.write_f64(projection.origin_easting)
    writer.write_f64(projection.origin_northing)

    writer.write_u16(projection.epsg_code)
    writer.write_u16(projection.grid_width_px)
    writer.write_u16(projection.grid_height_px)
    writer.write_u16(0)

    writer.write_f32(projection.pixel_size_m)

    writer.write_u32(offsets.node_table_offset)
    writer.write_u32(offsets.edge_table_offset)
    writer.write_u32(offsets.stop_table_offset)

    if writer.offset != HEADER_SIZE:
        raise ValueError(f"header serialized to {writer.offset} bytes, expected {HEADER_SIZE}")

    for node in graph.nodes:
        writer.write_i32(node.x_m)
        writer.write_i32(node.y_m)
        writer.write_u32(node.first_edge_index)
        writer.write_u16(node.edge_count)
        writer.write_u16(node.flags)

    for edge in graph.edges:
        writer.write_u32(edge.target_index)
        writer.write_u16(edge.cost_seconds)
        writer.write_u16(edge.flags)
        writer.write_u32(
            _pack_edge_metadata(
                mode_mask=edge.mode_mask,
                maxspeed_kph=edge.maxspeed_kph,
                road_class_id=edge.road_class_id,
            )
        )

    # Transit edges are written in the order given (the caller sorts by
    # departure_seconds_from_midnight, which is what the browser's
    # single-pass Connection Scan Algorithm needs — one global scan, not a
    # per-stop lookup), so no per-stop index into them is needed.
    #
    # The two words that used to reserve such an index now carry the CSR range
    # into the transfer table instead. `transfers` is required to be sorted by
    # (from_stop_index, to_stop_index), which makes each stop's range
    # contiguous.
    transfer_ranges = _transfer_ranges_by_stop(transfers, len(stops))
    for stop_index, stop in enumerate(stops):
        first_transfer_index, transfer_count = transfer_ranges[stop_index]
        writer.write_i32(stop.x_m)
        writer.write_i32(stop.y_m)
        writer.write_u32(stop.nearest_node_index)
        writer.write_u32(first_transfer_index)
        writer.write_u16(transfer_count)
        writer.write_u8(stop.transport_type)
        writer.write_u8(0)  # reserved
        writer.write_u32(0)  # name_offset (string table not implemented in this MVP)

    for transit_edge in transit_edges:
        writer.write_u32(transit_edge.from_stop_index)
        writer.write_u32(transit_edge.to_stop_index)
        writer.write_u32(transit_edge.departure_seconds)
        travel_seconds = max(0, transit_edge.arrival_seconds - transit_edge.departure_seconds)
        writer.write_u16(min(travel_seconds, 0xFFFF))
        writer.write_u16(transit_edge.route_id)
        writer.write_u32(transit_edge.service_day_mask)

    # Appended after the transit edges, with no header field of its own: the
    # 64-byte header is full, and the reader derives this table's offset the
    # same way it already derives the transit-edge table's, then its length
    # from the last stop's CSR range. A v2 payload simply ends here, which
    # reads back as every stop having no transfers.
    for transfer in transfers:
        writer.write_u32(transfer.to_stop_index)
        writer.write_u16(transfer.walk_distance_m)
        writer.write_u16(transfer.min_transfer_seconds)

    return writer.to_bytes()


def _transfer_ranges_by_stop(
    transfers: tuple[TransitTransfer, ...],
    n_stops: int,
) -> list[tuple[int, int]]:
    """CSR ranges, one per stop.

    A stop with no transfers still gets the running offset rather than zero, so
    that `first + count` of the *last* stop is the table's total length however
    the transfers happen to be distributed. The reader derives the length that
    way, having no header field to read it from.
    """
    counts = [0] * n_stops
    previous_from_stop_index = -1
    for index, transfer in enumerate(transfers):
        from_stop_index = transfer.from_stop_index
        if from_stop_index < 0 or from_stop_index >= n_stops:
            raise ValueError(
                f"transfer {index} from_stop_index out of range: "
                f"{from_stop_index} (n_stops={n_stops})"
            )
        if from_stop_index < previous_from_stop_index:
            raise ValueError(
                "transfers must be sorted by from_stop_index; "
                f"stop {from_stop_index} follows {previous_from_stop_index}"
            )
        previous_from_stop_index = from_stop_index
        counts[from_stop_index] += 1

    ranges: list[tuple[int, int]] = []
    running_offset = 0
    for stop_index in range(n_stops):
        ranges.append((running_offset, counts[stop_index]))
        running_offset += counts[stop_index]
    return ranges


def _validate_transit_layout(
    graph: AdjacencyGraph,
    stops: tuple[TransitStop, ...],
    transit_edges: tuple[TransitConnection, ...],
) -> None:
    n_nodes = len(graph.nodes)
    n_stops = len(stops)

    for stop_index, stop in enumerate(stops):
        if stop.nearest_node_index < 0 or stop.nearest_node_index >= n_nodes:
            raise ValueError(
                f"stop {stop_index} nearest_node_index out of range: "
                f"{stop.nearest_node_index} (n_nodes={n_nodes})"
            )
        if stop.transport_type < 0 or stop.transport_type > 0xFF:
            raise ValueError(
                f"stop {stop_index} transport_type out of range: {stop.transport_type}"
            )

    for edge_index, transit_edge in enumerate(transit_edges):
        if transit_edge.from_stop_index < 0 or transit_edge.from_stop_index >= n_stops:
            raise ValueError(
                f"transit edge {edge_index} from_stop_index out of range: "
                f"{transit_edge.from_stop_index} (n_stops={n_stops})"
            )
        if transit_edge.to_stop_index < 0 or transit_edge.to_stop_index >= n_stops:
            raise ValueError(
                f"transit edge {edge_index} to_stop_index out of range: "
                f"{transit_edge.to_stop_index} (n_stops={n_stops})"
            )
        if transit_edge.route_id < 0 or transit_edge.route_id > 0xFFFF:
            raise ValueError(
                f"transit edge {edge_index} route_id out of range: {transit_edge.route_id}"
            )


def _validate_adjacency_layout(graph: AdjacencyGraph) -> None:
    edge_count = len(graph.edges)
    coverage = [0] * edge_count

    for node_index, node in enumerate(graph.nodes):
        start = node.first_edge_index
        end = start + node.edge_count

        if start < 0 or start > edge_count:
            raise ValueError(
                "node "
                f"{node_index} first_edge_index out of range: {start} "
                f"(edge_count={edge_count})"
            )
        if end < 0 or end > edge_count:
            raise ValueError(f"node {node_index} edge range out of bounds: [{start}, {end})")

        for edge_index in range(start, end):
            coverage[edge_index] += 1
            edge = graph.edges[edge_index]
            if edge.source_index != node_index:
                raise ValueError(
                    "edge source_index does not match node adjacency range: "
                    f"edge_index={edge_index} "
                    f"source_index={edge.source_index} "
                    f"node_index={node_index}"
                )
            if edge.mode_mask <= 0 or edge.mode_mask > 0xFF:
                raise ValueError(
                    f"edge mode_mask out of range at edge_index={edge_index}: {edge.mode_mask}"
                )
            if edge.maxspeed_kph < 0 or edge.maxspeed_kph > 0xFFFF:
                raise ValueError(
                    "edge maxspeed_kph out of range at "
                    f"edge_index={edge_index}: {edge.maxspeed_kph}"
                )
            if edge.road_class_id < 0 or edge.road_class_id > 0xFF:
                raise ValueError(
                    "edge road_class_id out of range at "
                    f"edge_index={edge_index}: {edge.road_class_id}"
                )

    gaps = [index for index, count in enumerate(coverage) if count == 0]
    overlaps = [index for index, count in enumerate(coverage) if count > 1]

    if gaps:
        raise ValueError(f"edge indices not referenced by node ranges: first_gap={gaps[0]}")
    if overlaps:
        raise ValueError(
            f"edge indices multiply referenced by node ranges: first_overlap={overlaps[0]}"
        )


def _pack_edge_metadata(*, mode_mask: int, maxspeed_kph: int, road_class_id: int) -> int:
    return (maxspeed_kph << 16) | (road_class_id << 8) | mode_mask
