"""Validation helpers for exported graph binaries."""

from __future__ import annotations

import random
from dataclasses import dataclass

from pyproj import Transformer

from .binary_reader import (
    EDGE_RECORD_SIZE,
    MAGIC,
    NODE_RECORD_SIZE,
    GraphHeader,
    parse_edge_record,
    parse_header,
    parse_node_record,
    validate_offsets,
)

EXPECTED_VERSION = 1


@dataclass(frozen=True)
class BerlinBBox:
    lat_min: float
    lat_max: float
    lon_min: float
    lon_max: float


BERLIN_BBOX = BerlinBBox(
    lat_min=52.30,
    lat_max=52.70,
    lon_min=13.05,
    lon_max=13.80,
)


@dataclass(frozen=True)
class NodeSpotCheck:
    node_index: int
    x_m: int
    y_m: int
    easting: float
    northing: float
    lat: float
    lon: float


@dataclass(frozen=True)
class BinaryValidationResult:
    header: GraphHeader
    sampled_node_count: int
    node_spot_checks: tuple[NodeSpotCheck, ...]
    edge_target_violations: int


def validate_binary_graph_payload(
    payload: bytes | bytearray | memoryview,
    *,
    node_sample_count: int = 5,
    random_seed: int = 1337,
    berlin_bbox: BerlinBBox = BERLIN_BBOX,
) -> BinaryValidationResult:
    if node_sample_count <= 0:
        raise ValueError("node_sample_count must be positive")

    header = parse_header(payload)
    validate_offsets(header, len(payload))

    if header.magic != MAGIC:
        raise ValueError(f"invalid magic 0x{header.magic:08X}; expected 0x{MAGIC:08X}")

    if header.version != EXPECTED_VERSION:
        raise ValueError(f"unsupported version {header.version}; expected {EXPECTED_VERSION}")

    node_spot_checks = _sample_nodes_within_berlin_bbox(
        payload,
        header,
        node_sample_count=node_sample_count,
        random_seed=random_seed,
        berlin_bbox=berlin_bbox,
    )

    edge_target_violations = 0
    for edge_index in range(header.n_edges):
        offset = header.edge_table_offset + (edge_index * EDGE_RECORD_SIZE)
        edge = parse_edge_record(payload, offset)
        if edge.target_node_index >= header.n_nodes:
            edge_target_violations += 1

    if edge_target_violations > 0:
        raise ValueError(f"edge target index out of range: count={edge_target_violations}")

    return BinaryValidationResult(
        header=header,
        sampled_node_count=len(node_spot_checks),
        node_spot_checks=node_spot_checks,
        edge_target_violations=edge_target_violations,
    )


def _sample_nodes_within_berlin_bbox(
    payload: bytes | bytearray | memoryview,
    header: GraphHeader,
    *,
    node_sample_count: int,
    random_seed: int,
    berlin_bbox: BerlinBBox,
) -> tuple[NodeSpotCheck, ...]:
    if header.n_nodes == 0:
        return tuple()

    sample_count = min(node_sample_count, header.n_nodes)
    rng = random.Random(random_seed)
    sampled_indices = sorted(rng.sample(range(header.n_nodes), sample_count))

    transformer = Transformer.from_crs(f"EPSG:{header.epsg_code}", "EPSG:4326", always_xy=True)
    checks: list[NodeSpotCheck] = []

    for node_index in sampled_indices:
        offset = header.node_table_offset + (node_index * NODE_RECORD_SIZE)
        node = parse_node_record(payload, offset)

        easting = header.origin_easting + float(node.x_m)
        northing = header.origin_northing + float(node.y_m)
        lon, lat = transformer.transform(easting, northing)

        if not (
            berlin_bbox.lat_min <= lat <= berlin_bbox.lat_max
            and berlin_bbox.lon_min <= lon <= berlin_bbox.lon_max
        ):
            raise ValueError(
                "sampled node outside Berlin bounding box: "
                f"node_index={node_index} lat={lat:.6f} lon={lon:.6f}"
            )

        checks.append(
            NodeSpotCheck(
                node_index=node_index,
                x_m=node.x_m,
                y_m=node.y_m,
                easting=easting,
                northing=northing,
                lat=lat,
                lon=lon,
            )
        )

    return tuple(checks)
