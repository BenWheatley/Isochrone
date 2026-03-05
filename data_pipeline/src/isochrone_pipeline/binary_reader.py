"""Binary graph reader helpers used for file validation and debugging."""

from __future__ import annotations

import struct
from dataclasses import dataclass
from pathlib import Path

MAGIC = 0x49534F43
HEADER_SIZE = 64
NODE_RECORD_SIZE = 16
EDGE_RECORD_SIZE = 12


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
    return EdgeRecord(
        target_node_index=target_node_index,
        cost_seconds=cost_seconds,
        flags=flags,
        reserved=reserved,
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
