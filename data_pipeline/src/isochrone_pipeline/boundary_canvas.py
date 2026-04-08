"""Extract and simplify administrative boundaries for direct canvas rendering."""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, Literal

from pyproj import Transformer

ResolutionUnits = Literal["meters", "degrees"]


@dataclass(frozen=True)
class BoundaryFeature:
    relation_id: int
    name: str
    admin_level: str
    paths_lat_lon: tuple[tuple[tuple[float, float], ...], ...]


def extract_overpass_boundary_features(
    overpass_json: dict[str, Any],
    *,
    admin_level: str = "9",
) -> tuple[BoundaryFeature, ...]:
    elements = overpass_json.get("elements")
    if not isinstance(elements, list):
        raise ValueError("Overpass JSON must contain an 'elements' list")

    features: list[BoundaryFeature] = []
    node_lon_lat_by_id: dict[int, tuple[float, float]] = {}
    way_geometry_by_id: dict[int, tuple[tuple[float, float], ...]] = {}

    for element in elements:
        if not isinstance(element, dict):
            continue
        if element.get("type") != "node":
            continue

        node_id = element.get("id")
        lat = element.get("lat")
        lon = element.get("lon")
        if (
            isinstance(node_id, int)
            and isinstance(lat, int | float)
            and isinstance(lon, int | float)
        ):
            node_lon_lat_by_id[node_id] = (float(lon), float(lat))

    for element in elements:
        if not isinstance(element, dict):
            continue
        if element.get("type") != "way":
            continue

        way_id = element.get("id")
        if not isinstance(way_id, int):
            continue

        way_geometry = _parse_geometry_points(element.get("geometry"))
        if len(way_geometry) < 2:
            node_refs = element.get("nodes")
            if isinstance(node_refs, list):
                reconstructed_geometry = tuple(
                    node_lon_lat_by_id[node_id]
                    for node_id in node_refs
                    if isinstance(node_id, int) and node_id in node_lon_lat_by_id
                )
                if len(reconstructed_geometry) == len(node_refs):
                    way_geometry = reconstructed_geometry
        if len(way_geometry) >= 2:
            way_geometry_by_id[way_id] = way_geometry

    for element in elements:
        if not isinstance(element, dict):
            continue
        if element.get("type") != "relation":
            continue

        relation_id = element.get("id")
        if not isinstance(relation_id, int):
            continue

        tags = element.get("tags")
        if not isinstance(tags, dict):
            continue

        if tags.get("boundary") != "administrative":
            continue
        if str(tags.get("admin_level")) != admin_level:
            continue

        name = str(tags.get("name") or f"relation_{relation_id}")

        paths: list[tuple[tuple[float, float], ...]] = []
        relation_geometry = _parse_geometry_points(element.get("geometry"))
        if len(relation_geometry) >= 2:
            paths.append(relation_geometry)

        members = element.get("members")
        if isinstance(members, list):
            for member in members:
                if not isinstance(member, dict):
                    continue
                if member.get("type") != "way":
                    continue

                member_geometry = _parse_geometry_points(member.get("geometry"))
                if len(member_geometry) >= 2:
                    paths.append(member_geometry)
                    continue

                member_ref = member.get("ref")
                if isinstance(member_ref, int):
                    referenced_geometry = way_geometry_by_id.get(member_ref)
                    if referenced_geometry is not None:
                        paths.append(referenced_geometry)

        if paths:
            features.append(
                BoundaryFeature(
                    relation_id=relation_id,
                    name=name,
                    admin_level=admin_level,
                    paths_lat_lon=tuple(paths),
                )
            )

    features.sort(key=lambda feature: (feature.name, feature.relation_id))
    return tuple(features)


def simplify_polyline(
    points: tuple[tuple[float, float], ...],
    *,
    tolerance: float,
) -> tuple[tuple[float, float], ...]:
    if tolerance <= 0.0 or len(points) <= 2:
        return points

    is_closed = len(points) >= 4 and points[0] == points[-1]
    working = list(points[:-1] if is_closed else points)

    if len(working) <= 2:
        return points

    keep = [False] * len(working)
    keep[0] = True
    keep[-1] = True

    stack: list[tuple[int, int]] = [(0, len(working) - 1)]

    while stack:
        start_index, end_index = stack.pop()
        if end_index - start_index <= 1:
            continue

        start = working[start_index]
        end = working[end_index]

        furthest_index = -1
        furthest_distance = -1.0

        for i in range(start_index + 1, end_index):
            distance = _distance_point_to_segment(working[i], start, end)
            if distance > furthest_distance:
                furthest_distance = distance
                furthest_index = i

        if furthest_index >= 0 and furthest_distance > tolerance:
            keep[furthest_index] = True
            stack.append((start_index, furthest_index))
            stack.append((furthest_index, end_index))

    simplified = [point for point, keep_flag in zip(working, keep, strict=False) if keep_flag]

    if is_closed and simplified:
        simplified.append(simplified[0])

    return tuple(simplified)


def simplify_overpass_boundaries_for_canvas(
    overpass_json: dict[str, Any],
    *,
    tolerance: float,
    units: ResolutionUnits,
    epsg_code: int = 25833,
    admin_level: str = "9",
) -> dict[str, Any]:
    if tolerance < 0.0:
        raise ValueError("tolerance must be non-negative")

    features = extract_overpass_boundary_features(overpass_json, admin_level=admin_level)
    if not features:
        raise ValueError(
            "No administrative boundary geometry found. "
            "Ensure Overpass output includes relation member ways plus either way geometry "
            "or node coordinates (for example: '(.districts;>;); out body qt; >; out skel qt;')."
        )

    if units == "meters":
        transformer = Transformer.from_crs("EPSG:4326", f"EPSG:{epsg_code}", always_xy=True)
        projection = f"EPSG:{epsg_code}"
    elif units == "degrees":
        transformer = None
        projection = "EPSG:4326"
    else:
        raise ValueError(f"unsupported units: {units}")

    prepared_features: list[dict[str, Any]] = []
    all_x: list[float] = []
    all_y: list[float] = []
    input_point_count = 0
    output_point_count = 0
    path_count = 0

    for raw_feature in features:
        simplified_paths: list[list[list[float]]] = []

        for path_lat_lon in raw_feature.paths_lat_lon:
            if transformer is None:
                projected = tuple((lon, lat) for lon, lat in path_lat_lon)
            else:
                projected = tuple(
                    (float(easting), float(northing))
                    for easting, northing in (
                        transformer.transform(lon, lat) for lon, lat in path_lat_lon
                    )
                )

            simplified = simplify_polyline(projected, tolerance=tolerance)
            if len(simplified) < 2:
                continue

            input_point_count += len(projected)
            output_point_count += len(simplified)
            path_count += 1

            for x, y in simplified:
                all_x.append(x)
                all_y.append(y)

            simplified_paths.append([[x, y] for x, y in simplified])

        if simplified_paths:
            prepared_features.append(
                {
                    "relation_id": raw_feature.relation_id,
                    "name": raw_feature.name,
                    "admin_level": raw_feature.admin_level,
                    "paths": simplified_paths,
                }
            )

    if not all_x or not all_y:
        raise ValueError("No boundary geometry found after filtering/simplification")

    min_x = min(all_x)
    max_x = max(all_x)
    min_y = min(all_y)
    max_y = max(all_y)

    width = max_x - min_x
    height = max_y - min_y

    for prepared_feature in prepared_features:
        remapped_paths: list[list[list[float]]] = []
        for path in prepared_feature["paths"]:
            remapped = [[point[0] - min_x, max_y - point[1]] for point in path]
            remapped_paths.append(remapped)
        prepared_feature["paths"] = remapped_paths

    return {
        "format": "isochrone-canvas-boundaries-v1",
        "resolution": {
            "value": tolerance,
            "units": units,
        },
        "coordinate_space": {
            "units": units,
            "projection": projection,
            "x_origin": min_x,
            "y_origin": max_y,
            "width": width,
            "height": height,
            "axis": "x-right-y-down",
        },
        "features": prepared_features,
        "stats": {
            "feature_count": len(prepared_features),
            "path_count": path_count,
            "input_point_count": input_point_count,
            "output_point_count": output_point_count,
        },
    }


def _parse_geometry_points(raw_geometry: Any) -> tuple[tuple[float, float], ...]:
    if not isinstance(raw_geometry, list):
        return tuple()

    points: list[tuple[float, float]] = []
    for point in raw_geometry:
        if not isinstance(point, dict):
            continue
        lat = point.get("lat")
        lon = point.get("lon")
        if isinstance(lat, int | float) and isinstance(lon, int | float):
            points.append((float(lon), float(lat)))

    return tuple(points)


def _distance_point_to_segment(
    point: tuple[float, float],
    segment_start: tuple[float, float],
    segment_end: tuple[float, float],
) -> float:
    px, py = point
    x1, y1 = segment_start
    x2, y2 = segment_end

    dx = x2 - x1
    dy = y2 - y1

    if dx == 0.0 and dy == 0.0:
        return math.hypot(px - x1, py - y1)

    projection = ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)
    clamped = max(0.0, min(1.0, projection))

    closest_x = x1 + clamped * dx
    closest_y = y1 + clamped * dy

    return math.hypot(px - closest_x, py - closest_y)
