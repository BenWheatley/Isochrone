"""Extraction pipeline for walkable graph input from Overpass JSON."""

from __future__ import annotations

import math
from dataclasses import dataclass
from pathlib import Path

from .osm_json_survey import iter_overpass_elements
from .overpass_survey import WALKABLE_HIGHWAY_VALUES
from .projection import DEFAULT_PIXEL_SIZE_M

# The graph binary's grid_width_px/grid_height_px header fields are u16
# (struct.pack raises above 65535), so the projected extent can't exceed
# 65535 * pixel_size_m in either axis at the default 10 m/pixel. A *fixed*
# per-ferry-way span cutoff doesn't scale with region size (Cyprus's own
# coastline exceeds 80 km, so a naive absolute threshold would drop
# legitimate ferries hugging a big region's own coast). Instead, ferry ways
# are accepted greedily nearest-to-the-walkable-network first, up to a
# safety-margined budget below the hard u16 cap — real regional/strait/lake
# ferries (Lake Zurich, Rhode Island Sound, Singapore-Batam, a Cyprus
# coastal route) fit comfortably; only genuinely long-haul open-sea routes
# (e.g. a real ~700 km Piraeus-Limassol way seen in fetched Cyprus data)
# get excluded once the budget is used up. The safety margin (versus the
# hard 655,350 m cap) leaves headroom for the lat/lon-degree approximation
# used here (not the final UTM/local projection) and for stops/transit data
# added on top of the same node table later.
_MAX_GRID_METERS_PER_AXIS = 65_535 * DEFAULT_PIXEL_SIZE_M
FERRY_GRID_BUDGET_METERS = 500_000.0
assert FERRY_GRID_BUDGET_METERS < _MAX_GRID_METERS_PER_AXIS
_EARTH_RADIUS_M = 6_371_000.0
_METERS_PER_DEGREE_LAT = 110_540.0
_METERS_PER_DEGREE_LON_AT_EQUATOR = 111_320.0

CONSTRAINT_TAGS: tuple[str, ...] = (
    "access",
    "foot",
    "oneway",
    "oneway:foot",
    "bicycle",
    "cycleway",
    "oneway:bicycle",
    "motor_vehicle",
    "vehicle",
    "sidewalk",
    "junction",
    "service",
    "surface",
    "tracktype",
    "maxspeed",
    "maxspeed:forward",
    "maxspeed:backward",
    "duration",
)


@dataclass(frozen=True)
class WayCandidate:
    osm_id: int
    highway: str
    node_ids: tuple[int, ...]
    constraints: dict[str, str]


@dataclass(frozen=True)
class ConnectorNode:
    osm_id: int
    lat: float
    lon: float
    connector_types: tuple[str, ...]


@dataclass(frozen=True)
class WayPassResult:
    ways: tuple[WayCandidate, ...]
    referenced_node_ids: set[int]


@dataclass(frozen=True)
class WalkableGraphExtract:
    ways: tuple[WayCandidate, ...]
    node_coords: dict[int, tuple[float, float]]
    connector_nodes: dict[int, ConnectorNode]
    dropped_way_count: int


@dataclass(frozen=True)
class ConstraintTagCoverage:
    total_way_count: int
    tag_presence: dict[str, int]
    tag_coverage_ratio: dict[str, float]


def collect_walkable_way_candidates(
    path: Path,
    walkable_highways: set[str] | None = None,
) -> WayPassResult:
    allowed = walkable_highways or set(WALKABLE_HIGHWAY_VALUES)

    ways: list[WayCandidate] = []
    referenced_node_ids: set[int] = set()

    for element in iter_overpass_elements(path):
        if element.get("type") != "way":
            continue

        tags = element.get("tags")
        if not isinstance(tags, dict):
            continue

        highway = tags.get("highway")
        if not isinstance(highway, str) or highway not in allowed:
            continue

        nodes = element.get("nodes")
        if not isinstance(nodes, list):
            continue

        node_ids = tuple(node_id for node_id in nodes if isinstance(node_id, int))
        if len(node_ids) < 2:
            continue

        osm_id = element.get("id")
        if not isinstance(osm_id, int):
            continue

        constraints: dict[str, str] = {}
        for tag in CONSTRAINT_TAGS:
            tag_value = tags.get(tag)
            if isinstance(tag_value, str):
                constraints[tag] = tag_value

        ways.append(
            WayCandidate(
                osm_id=osm_id,
                highway=highway,
                node_ids=node_ids,
                constraints=constraints,
            )
        )
        referenced_node_ids.update(node_ids)

    return WayPassResult(ways=tuple(ways), referenced_node_ids=referenced_node_ids)


def collect_ferry_way_candidates(path: Path) -> WayPassResult:
    ways: list[WayCandidate] = []
    referenced_node_ids: set[int] = set()

    for element in iter_overpass_elements(path):
        if element.get("type") != "way":
            continue

        tags = element.get("tags")
        if not isinstance(tags, dict):
            continue

        if tags.get("route") != "ferry":
            continue

        nodes = element.get("nodes")
        if not isinstance(nodes, list):
            continue

        node_ids = tuple(node_id for node_id in nodes if isinstance(node_id, int))
        if len(node_ids) < 2:
            continue

        osm_id = element.get("id")
        if not isinstance(osm_id, int):
            continue

        constraints: dict[str, str] = {}
        for tag in CONSTRAINT_TAGS:
            tag_value = tags.get(tag)
            if isinstance(tag_value, str):
                constraints[tag] = tag_value

        ways.append(
            WayCandidate(
                osm_id=osm_id,
                highway="ferry",
                node_ids=node_ids,
                constraints=constraints,
            )
        )
        referenced_node_ids.update(node_ids)

    return WayPassResult(ways=tuple(ways), referenced_node_ids=referenced_node_ids)


def load_referenced_nodes(
    path: Path,
    referenced_node_ids: set[int],
) -> dict[int, tuple[float, float]]:
    if not referenced_node_ids:
        return {}

    coords: dict[int, tuple[float, float]] = {}
    for element in iter_overpass_elements(path):
        if element.get("type") != "node":
            continue

        osm_id = element.get("id")
        if not isinstance(osm_id, int) or osm_id not in referenced_node_ids:
            continue

        lat = element.get("lat")
        lon = element.get("lon")
        if not isinstance(lat, float | int) or not isinstance(lon, float | int):
            continue

        coords[osm_id] = (float(lat), float(lon))

        if len(coords) == len(referenced_node_ids):
            break

    return coords


def collect_connector_nodes(path: Path) -> dict[int, ConnectorNode]:
    connectors: dict[int, ConnectorNode] = {}

    for element in iter_overpass_elements(path):
        if element.get("type") != "node":
            continue

        tags = element.get("tags")
        if not isinstance(tags, dict):
            continue

        connector_types: list[str] = []

        if "barrier" in tags:
            connector_types.append("barrier")
        if tags.get("highway") == "crossing":
            connector_types.append("crossing")
        if tags.get("railway") == "level_crossing":
            connector_types.append("level_crossing")
        if "entrance" in tags:
            connector_types.append("entrance")

        if not connector_types:
            continue

        osm_id = element.get("id")
        lat = element.get("lat")
        lon = element.get("lon")

        if not isinstance(osm_id, int):
            continue
        if not isinstance(lat, float | int) or not isinstance(lon, float | int):
            continue

        connectors[osm_id] = ConnectorNode(
            osm_id=osm_id,
            lat=float(lat),
            lon=float(lon),
            connector_types=tuple(connector_types),
        )

    return connectors


def drop_ways_with_missing_nodes(
    ways: tuple[WayCandidate, ...],
    node_coords: dict[int, tuple[float, float]],
) -> tuple[tuple[WayCandidate, ...], int]:
    kept: list[WayCandidate] = []
    dropped = 0

    for way in ways:
        if all(node_id in node_coords for node_id in way.node_ids):
            kept.append(way)
        else:
            dropped += 1

    return tuple(kept), dropped


def _haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    delta_phi = math.radians(lat2 - lat1)
    delta_lambda = math.radians(lon2 - lon1)
    a = (
        math.sin(delta_phi / 2) ** 2
        + math.cos(phi1) * math.cos(phi2) * math.sin(delta_lambda / 2) ** 2
    )
    return 2 * _EARTH_RADIUS_M * math.asin(min(1.0, math.sqrt(a)))


def _way_coords(
    way: WayCandidate, node_coords: dict[int, tuple[float, float]]
) -> list[tuple[float, float]]:
    return [node_coords[node_id] for node_id in way.node_ids if node_id in node_coords]


def _bbox_of_ways(
    ways: tuple[WayCandidate, ...], node_coords: dict[int, tuple[float, float]]
) -> tuple[float, float, float, float] | None:
    """Streaming min/max over every node referenced by `ways`, without
    materializing a coordinate list — the walkable network can be hundreds
    of thousands of nodes for a large region.
    """
    min_lat = min_lon = math.inf
    max_lat = max_lon = -math.inf
    seen_any = False
    for way in ways:
        for node_id in way.node_ids:
            coord = node_coords.get(node_id)
            if coord is None:
                continue
            lat, lon = coord
            seen_any = True
            if lat < min_lat:
                min_lat = lat
            if lat > max_lat:
                max_lat = lat
            if lon < min_lon:
                min_lon = lon
            if lon > max_lon:
                max_lon = lon

    return (min_lat, min_lon, max_lat, max_lon) if seen_any else None


def _bbox_of(coords: list[tuple[float, float]]) -> tuple[float, float, float, float]:
    lats = [c[0] for c in coords]
    lons = [c[1] for c in coords]
    return min(lats), min(lons), max(lats), max(lons)


def _bbox_center(bbox: tuple[float, float, float, float]) -> tuple[float, float]:
    min_lat, min_lon, max_lat, max_lon = bbox
    return (min_lat + max_lat) / 2, (min_lon + max_lon) / 2


def _bbox_span_m(bbox: tuple[float, float, float, float]) -> tuple[float, float]:
    """Approximate (lat_span_m, lon_span_m) via equirectangular projection.

    Good enough for a safety-margined budget check; the real, precise
    projection happens later in projection.py against whichever nodes
    actually survive this filtering pass.
    """
    min_lat, min_lon, max_lat, max_lon = bbox
    mean_lat = (min_lat + max_lat) / 2
    lat_span_m = (max_lat - min_lat) * _METERS_PER_DEGREE_LAT
    lon_span_m = (
        (max_lon - min_lon) * _METERS_PER_DEGREE_LON_AT_EQUATOR * math.cos(math.radians(mean_lat))
    )
    return abs(lat_span_m), abs(lon_span_m)


def _merge_bbox(
    a: tuple[float, float, float, float], b: tuple[float, float, float, float]
) -> tuple[float, float, float, float]:
    return (min(a[0], b[0]), min(a[1], b[1]), max(a[2], b[2]), max(a[3], b[3]))


def select_ferry_ways_within_grid_budget(
    ferry_ways: tuple[WayCandidate, ...],
    node_coords: dict[int, tuple[float, float]],
    core_bbox: tuple[float, float, float, float] | None,
    *,
    budget_meters: float = FERRY_GRID_BUDGET_METERS,
) -> tuple[WayCandidate, ...]:
    """Greedily accept ferry ways, nearest-to-the-core-network first, up to
    a grid-size budget. Ways that would push either axis of the combined
    bounding box past the budget are skipped (later, farther candidates may
    still be skipped even though the core alone has room, since the point
    is to keep the *combined* grid within the u16 header capacity).
    """
    candidates = [
        (way, _bbox_of(coords))
        for way in ferry_ways
        if len(coords := _way_coords(way, node_coords)) >= 2
    ]
    if not candidates:
        return ()

    if core_bbox is None:
        # No walkable network at all (degenerate input) - seed from the
        # nearest-to-nothing-in-particular first candidate itself so the
        # ordering below still terminates deterministically.
        core_bbox = candidates[0][1]

    core_center = _bbox_center(core_bbox)
    candidates.sort(
        key=lambda pair: _haversine_m(*core_center, *_bbox_center(pair[1])),
    )

    accepted: list[WayCandidate] = []
    combined_bbox = core_bbox
    for way, way_bbox in candidates:
        candidate_bbox = _merge_bbox(combined_bbox, way_bbox)
        lat_span_m, lon_span_m = _bbox_span_m(candidate_bbox)
        if lat_span_m <= budget_meters and lon_span_m <= budget_meters:
            accepted.append(way)
            combined_bbox = candidate_bbox

    return tuple(accepted)


def extract_walkable_graph_input(
    path: Path,
    walkable_highways: set[str] | None = None,
) -> WalkableGraphExtract:
    pass1 = collect_walkable_way_candidates(path, walkable_highways=walkable_highways)
    ferry_pass = collect_ferry_way_candidates(path)
    referenced_node_ids = pass1.referenced_node_ids | ferry_pass.referenced_node_ids
    node_coords = load_referenced_nodes(path, referenced_node_ids)
    connector_nodes = collect_connector_nodes(path)

    core_bbox = _bbox_of_ways(pass1.ways, node_coords)
    ferry_ways_within_budget = select_ferry_ways_within_grid_budget(
        ferry_pass.ways, node_coords, core_bbox
    )
    excessive_span_ferry_way_count = len(ferry_pass.ways) - len(ferry_ways_within_budget)

    combined_ways = pass1.ways + ferry_ways_within_budget
    kept_ways, dropped_way_count = drop_ways_with_missing_nodes(combined_ways, node_coords)

    # Prune coordinates no longer referenced by any kept way so an excluded
    # far-away ferry endpoint doesn't still expand the region's projected
    # bounding box.
    surviving_node_ids: set[int] = set()
    for way in kept_ways:
        surviving_node_ids.update(way.node_ids)
    pruned_node_coords = {
        node_id: coord for node_id, coord in node_coords.items() if node_id in surviving_node_ids
    }

    return WalkableGraphExtract(
        ways=kept_ways,
        node_coords=pruned_node_coords,
        connector_nodes=connector_nodes,
        dropped_way_count=dropped_way_count + excessive_span_ferry_way_count,
    )


def summarize_constraint_tag_coverage(
    ways: tuple[WayCandidate, ...],
    *,
    tracked_tags: tuple[str, ...] = CONSTRAINT_TAGS,
) -> ConstraintTagCoverage:
    total_way_count = len(ways)
    tag_presence = {tag: 0 for tag in tracked_tags}

    for way in ways:
        for tag in tracked_tags:
            if tag in way.constraints:
                tag_presence[tag] += 1

    if total_way_count == 0:
        tag_coverage_ratio = {tag: 0.0 for tag in tracked_tags}
    else:
        tag_coverage_ratio = {tag: tag_presence[tag] / total_way_count for tag in tracked_tags}

    return ConstraintTagCoverage(
        total_way_count=total_way_count,
        tag_presence=tag_presence,
        tag_coverage_ratio=tag_coverage_ratio,
    )
