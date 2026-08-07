"""Binary graph reader helpers used for file validation and debugging."""

from __future__ import annotations

import struct
from dataclasses import dataclass
from pathlib import Path

MAGIC = 0x49534F43
HEADER_SIZE = 64
NODE_RECORD_SIZE = 16
EDGE_RECORD_SIZE = 12
STOP_RECORD_SIZE = 24
TEDGE_RECORD_SIZE = 20
TRANSIT_FLAG_BIT = 1 << 0


@dataclass(frozen=True)
class GraphHeader:
    magic: int
    version: int
    flags: int
    n_nodes: int
    n_edges: int
    n_stops: int
    n_tedges: int
    origin_easting: float
    origin_northing: float
    epsg_code: int
    grid_width_px: int
    grid_height_px: int
    pixel_size_m: float
    node_table_offset: int
    edge_table_offset: int
    stop_table_offset: int


@dataclass(frozen=True)
class NodeRecord:
    x_m: int
    y_m: int
    first_edge_index: int
    edge_count: int
    flags: int


@dataclass(frozen=True)
class EdgeRecord:
    target_node_index: int
    cost_seconds: int
    flags: int
    reserved: int
    mode_mask: int
    maxspeed_kph: int
    road_class_id: int


@dataclass(frozen=True)
class StopRecord:
    x_m: int
    y_m: int
    nearest_node_index: int
    first_tedge_index: int
    tedge_count: int
    transport_type: int
    name_offset: int


@dataclass(frozen=True)
class TransitEdgeRecord:
    from_stop_index: int
    to_stop_index: int
    departure_seconds_from_midnight: int
    travel_seconds: int
    route_id: int
    service_day_mask: int


def parse_header(buffer: bytes | bytearray | memoryview) -> GraphHeader:
    if len(buffer) < HEADER_SIZE:
        raise ValueError(f"Binary too small for header: {len(buffer)} bytes")

    (
        magic,
        version,
        flags,
        _reserved,
        n_nodes,
        n_edges,
        n_stops,
        n_tedges,
        origin_easting,
        origin_northing,
        epsg_code,
        grid_width_px,
        grid_height_px,
        _reserved2,
        pixel_size_m,
        node_table_offset,
        edge_table_offset,
        stop_table_offset,
    ) = struct.unpack_from("<IBBHIIIIddHHHHfIII", buffer, 0)

    return GraphHeader(
        magic=magic,
        version=version,
        flags=flags,
        n_nodes=n_nodes,
        n_edges=n_edges,
        n_stops=n_stops,
        n_tedges=n_tedges,
        origin_easting=origin_easting,
        origin_northing=origin_northing,
        epsg_code=epsg_code,
        grid_width_px=grid_width_px,
        grid_height_px=grid_height_px,
        pixel_size_m=pixel_size_m,
        node_table_offset=node_table_offset,
        edge_table_offset=edge_table_offset,
        stop_table_offset=stop_table_offset,
    )


def parse_node_record(buffer: bytes | bytearray | memoryview, offset: int) -> NodeRecord:
    if offset < 0 or offset + NODE_RECORD_SIZE > len(buffer):
        raise ValueError(f"Node record offset out of range: {offset}")

    x_m, y_m, first_edge_index, edge_count, flags = struct.unpack_from("<iiIHH", buffer, offset)
    return NodeRecord(
        x_m=x_m,
        y_m=y_m,
        first_edge_index=first_edge_index,
        edge_count=edge_count,
        flags=flags,
    )


def parse_edge_record(buffer: bytes | bytearray | memoryview, offset: int) -> EdgeRecord:
    if offset < 0 or offset + EDGE_RECORD_SIZE > len(buffer):
        raise ValueError(f"Edge record offset out of range: {offset}")

    target_node_index, cost_seconds, flags, reserved = struct.unpack_from("<IHHI", buffer, offset)
    mode_mask, maxspeed_kph, road_class_id = unpack_edge_metadata(reserved)
    return EdgeRecord(
        target_node_index=target_node_index,
        cost_seconds=cost_seconds,
        flags=flags,
        reserved=reserved,
        mode_mask=mode_mask,
        maxspeed_kph=maxspeed_kph,
        road_class_id=road_class_id,
    )


def transit_edge_table_offset(header: GraphHeader) -> int:
    """Transit edges follow the stop table immediately; there's no separate
    header field for this (the 64-byte header is already full) — both the
    writer and reader derive it the same way."""
    return header.stop_table_offset + (header.n_stops * STOP_RECORD_SIZE)


def parse_stop_record(buffer: bytes | bytearray | memoryview, offset: int) -> StopRecord:
    if offset < 0 or offset + STOP_RECORD_SIZE > len(buffer):
        raise ValueError(f"Stop record offset out of range: {offset}")

    (
        x_m,
        y_m,
        nearest_node_index,
        first_tedge_index,
        tedge_count,
        transport_type,
        _reserved,
        name_offset,
    ) = struct.unpack_from("<iiIIHBBI", buffer, offset)
    return StopRecord(
        x_m=x_m,
        y_m=y_m,
        nearest_node_index=nearest_node_index,
        first_tedge_index=first_tedge_index,
        tedge_count=tedge_count,
        transport_type=transport_type,
        name_offset=name_offset,
    )


def parse_transit_edge_record(
    buffer: bytes | bytearray | memoryview, offset: int
) -> TransitEdgeRecord:
    if offset < 0 or offset + TEDGE_RECORD_SIZE > len(buffer):
        raise ValueError(f"Transit edge record offset out of range: {offset}")

    (
        from_stop_index,
        to_stop_index,
        departure_seconds_from_midnight,
        travel_seconds,
        route_id,
        service_day_mask,
    ) = struct.unpack_from("<IIIHHI", buffer, offset)
    return TransitEdgeRecord(
        from_stop_index=from_stop_index,
        to_stop_index=to_stop_index,
        departure_seconds_from_midnight=departure_seconds_from_midnight,
        travel_seconds=travel_seconds,
        route_id=route_id,
        service_day_mask=service_day_mask,
    )


def validate_offsets(header: GraphHeader, file_size: int) -> None:
    if header.magic != MAGIC:
        raise ValueError(f"Invalid magic 0x{header.magic:08X}; expected 0x{MAGIC:08X}")

    if header.node_table_offset < HEADER_SIZE:
        raise ValueError("node_table_offset points inside header")

    node_table_end = header.node_table_offset + (header.n_nodes * NODE_RECORD_SIZE)
    edge_table_end = header.edge_table_offset + (header.n_edges * EDGE_RECORD_SIZE)

    if header.edge_table_offset < node_table_end:
        raise ValueError("edge_table_offset overlaps node table")

    if header.stop_table_offset < edge_table_end:
        raise ValueError("stop_table_offset overlaps edge table")

    if node_table_end > file_size:
        raise ValueError("node table extends beyond file size")

    if edge_table_end > file_size:
        raise ValueError("edge table extends beyond file size")

    if header.stop_table_offset > file_size:
        raise ValueError("stop_table_offset beyond file size")

    stop_table_end = header.stop_table_offset + (header.n_stops * STOP_RECORD_SIZE)
    if stop_table_end > file_size:
        raise ValueError("stop table extends beyond file size")

    tedge_table_offset = transit_edge_table_offset(header)
    tedge_table_end = tedge_table_offset + (header.n_tedges * TEDGE_RECORD_SIZE)
    if tedge_table_end > file_size:
        raise ValueError("transit edge table extends beyond file size")


def summarize_graph_file(path: Path) -> list[str]:
    buffer = path.read_bytes()
    header = parse_header(buffer)
    validate_offsets(header, len(buffer))

    lines = [
        f"path={path}",
        f"size_bytes={len(buffer)}",
        f"magic=0x{header.magic:08X}",
        f"version={header.version}",
        (
            "counts="
            f"nodes:{header.n_nodes} edges:{header.n_edges} "
            f"stops:{header.n_stops} tedges:{header.n_tedges}"
        ),
        (
            "offsets="
            f"nodes:{header.node_table_offset} "
            f"edges:{header.edge_table_offset} "
            f"stops:{header.stop_table_offset}"
        ),
    ]

    if header.n_nodes > 0:
        node0 = parse_node_record(buffer, header.node_table_offset)
        lines.append(f"node0={node0}")
    else:
        lines.append("node0=<none>")

    if header.n_edges > 0:
        edge0 = parse_edge_record(buffer, header.edge_table_offset)
        lines.append(f"edge0={edge0}")
    else:
        lines.append("edge0=<none>")

    return lines


def unpack_edge_metadata(packed: int) -> tuple[int, int, int]:
    mode_mask = packed & 0xFF
    road_class_id = (packed >> 8) & 0xFF
    maxspeed_kph = (packed >> 16) & 0xFFFF
    return mode_mask, maxspeed_kph, road_class_id
