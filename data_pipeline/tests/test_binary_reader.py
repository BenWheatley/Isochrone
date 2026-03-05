from pathlib import Path

import pytest
from isochrone_pipeline.binary_reader import (
    EDGE_RECORD_SIZE,
    HEADER_SIZE,
    MAGIC,
    NODE_RECORD_SIZE,
    parse_edge_record,
    parse_header,
    parse_node_record,
    summarize_graph_file,
    validate_offsets,
)
from isochrone_pipeline.binary_writer import BinaryWriter


def _build_graph_bytes(
    *,
    n_nodes: int = 1,
    n_edges: int = 1,
    node_table_offset: int = HEADER_SIZE,
    edge_table_offset: int = HEADER_SIZE + NODE_RECORD_SIZE,
    stop_table_offset: int = HEADER_SIZE + NODE_RECORD_SIZE + EDGE_RECORD_SIZE,
) -> bytes:
    writer = BinaryWriter()

    writer.write_u32(MAGIC)
    writer.write_u8(1)
    writer.write_u8(0)
    writer.write_u16(0)
    writer.write_u32(n_nodes)
    writer.write_u32(n_edges)
    writer.write_u32(0)
    writer.write_u32(0)
    writer.write_f64(392000.0)
    writer.write_f64(5820000.0)
    writer.write_u16(25833)
    writer.write_u16(4500)
    writer.write_u16(3800)
    writer.write_u16(0)
    writer.write_f32(10.0)
    writer.write_u32(node_table_offset)
    writer.write_u32(edge_table_offset)
    writer.write_u32(stop_table_offset)

    assert writer.offset == HEADER_SIZE

    while writer.offset < node_table_offset:
        writer.write_u8(0)

    for _ in range(n_nodes):
        writer.write_i32(10)
        writer.write_i32(20)
        writer.write_u32(0)
        writer.write_u16(1)
        writer.write_u16(0)

    while writer.offset < edge_table_offset:
        writer.write_u8(0)

    for _ in range(n_edges):
        writer.write_u32(0)
        writer.write_u16(42)
        writer.write_u16(0)
        writer.write_u32(0)

    while writer.offset < stop_table_offset:
        writer.write_u8(0)

    return writer.to_bytes()


def test_parse_header_and_records() -> None:
    payload = _build_graph_bytes()

    header = parse_header(payload)
    node = parse_node_record(payload, header.node_table_offset)
    edge = parse_edge_record(payload, header.edge_table_offset)

    assert header.magic == MAGIC
    assert header.version == 1
    assert header.n_nodes == 1
    assert header.n_edges == 1
    assert node.x_m == 10
    assert node.y_m == 20
    assert edge.target_node_index == 0
    assert edge.cost_seconds == 42


def test_validate_offsets_rejects_inconsistent_offsets() -> None:
    payload = _build_graph_bytes(edge_table_offset=HEADER_SIZE + 4)
    header = parse_header(payload)

    with pytest.raises(ValueError, match="edge_table_offset"):
        validate_offsets(header, len(payload))


def test_summarize_graph_file_prints_node0_and_edge0(tmp_path: Path) -> None:
    path = tmp_path / "graph.bin"
    path.write_bytes(_build_graph_bytes())

    lines = summarize_graph_file(path)

    assert any("magic=0x49534F43" in line for line in lines)
    assert any(line.startswith("node0=") for line in lines)
    assert any(line.startswith("edge0=") for line in lines)
