"""Extract and simplify administrative boundaries for direct canvas rendering."""

from __future__ import annotations

import math
from dataclasses import dataclass
from pathlib import Path
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
    admin_level: str | None = "9",
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
        if admin_level is not None and str(tags.get("admin_level")) != admin_level:
            continue

        name = str(tags.get("name") or f"relation_{relation_id}")
        feature_admin_level = str(tags.get("admin_level") or "")

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
                    admin_level=feature_admin_level,
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
    include_coast: bool = False,
    coast_source: str | Path | None = None,
    coast_cache_dir: str | Path | None = None,
) -> dict[str, Any]:
    if tolerance < 0.0:
        raise ValueError("tolerance must be non-negative")
    elements = overpass_json.get("elements")
    if isinstance(elements, list) and not elements:
        raise ValueError(
            "Boundary input contains zero Overpass elements. "
            "Rerun the fetch step for this region before building."
        )

    features = extract_overpass_boundary_features(overpass_json, admin_level=admin_level)
    if not features:
        features = extract_overpass_boundary_features(overpass_json, admin_level=None)
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

    boundary_bbox_lon_lat = _compute_feature_bbox_lon_lat(features)
    extent_points = _project_extent_points(boundary_bbox_lon_lat, transformer)

    prepared_features, boundary_stats = _prepare_drawable_features(
        features=tuple(
            {
                "relation_id": feature.relation_id,
                "name": feature.name,
                "admin_level": feature.admin_level,
                "paths": feature.paths_lat_lon,
            }
            for feature in features
        ),
        transformer=transformer,
        tolerance=tolerance,
    )

    prepared_water_features: list[dict[str, Any]] = []
    water_path_count = 0
    if include_coast:
        from isochrone_pipeline.water_polygons import (
            DEFAULT_WATER_POLYGONS_SOURCE,
            load_clipped_water_polygon_features,
        )

        water_features = load_clipped_water_polygon_features(
            source=coast_source or DEFAULT_WATER_POLYGONS_SOURCE,
            clip_bbox=boundary_bbox_lon_lat,
            cache_dir=coast_cache_dir,
        )
        prepared_water_features, water_stats = _prepare_drawable_features(
            features=tuple(
                {"name": "coast", "paths": feature_paths} for feature_paths in water_features
            ),
            transformer=transformer,
            tolerance=tolerance,
        )
        water_path_count = water_stats["path_count"]

        for feature in prepared_water_features:
            for path in feature["paths"]:
                for x, y in path:
                    extent_points.append((x, y))
    if boundary_stats["path_count"] == 0:
        raise ValueError("No boundary geometry found after filtering/simplification")
    if not extent_points:
        raise ValueError("No boundary geometry found after filtering/simplification")

    all_x = [point[0] for point in extent_points]
    all_y = [point[1] for point in extent_points]
    min_x = min(all_x)
    max_x = max(all_x)
    min_y = min(all_y)
    max_y = max(all_y)

    width = max_x - min_x
    height = max_y - min_y

    for prepared_feature in prepared_features:
        prepared_feature["paths"] = _remap_paths_to_canvas_space(
            prepared_feature["paths"],
            min_x=min_x,
            max_y=max_y,
        )
    for prepared_feature in prepared_water_features:
        prepared_feature["paths"] = _remap_paths_to_canvas_space(
            prepared_feature["paths"],
            min_x=min_x,
            max_y=max_y,
        )

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
        "water_features": prepared_water_features,
        "stats": {
            "feature_count": len(prepared_features),
            "path_count": boundary_stats["path_count"],
            "input_point_count": boundary_stats["input_point_count"],
            "output_point_count": boundary_stats["output_point_count"],
            "water_feature_count": len(prepared_water_features),
            "water_path_count": water_path_count,
        },
    }


def _prepare_drawable_features(
    *,
    features: tuple[dict[str, Any], ...],
    transformer: Transformer | None,
    tolerance: float,
) -> tuple[list[dict[str, Any]], dict[str, int]]:
    prepared_features: list[dict[str, Any]] = []
    input_point_count = 0
    output_point_count = 0
    path_count = 0

    for raw_feature in features:
        simplified_paths: list[list[list[float]]] = []

        for path_lon_lat in raw_feature["paths"]:
            projected = _project_path(path_lon_lat, transformer)
            simplified = simplify_polyline(projected, tolerance=tolerance)
            if len(simplified) < 2:
                continue

            input_point_count += len(projected)
            output_point_count += len(simplified)
            path_count += 1
            simplified_paths.append([[x, y] for x, y in simplified])

        if simplified_paths:
            prepared_feature = {
                "name": raw_feature["name"],
                "paths": simplified_paths,
            }
            if "relation_id" in raw_feature:
                prepared_feature["relation_id"] = raw_feature["relation_id"]
            if "admin_level" in raw_feature:
                prepared_feature["admin_level"] = raw_feature["admin_level"]
            prepared_features.append(prepared_feature)

    return prepared_features, {
        "input_point_count": input_point_count,
        "output_point_count": output_point_count,
        "path_count": path_count,
    }


def _project_path(
    path_lon_lat: tuple[tuple[float, float], ...],
    transformer: Transformer | None,
) -> tuple[tuple[float, float], ...]:
    if transformer is None:
        return tuple((lon, lat) for lon, lat in path_lon_lat)

    return tuple(
        (float(easting), float(northing))
        for easting, northing in (transformer.transform(lon, lat) for lon, lat in path_lon_lat)
    )


def _compute_feature_bbox_lon_lat(
    features: tuple[BoundaryFeature, ...],
) -> tuple[float, float, float, float]:
    all_lon = [lon for feature in features for path in feature.paths_lat_lon for lon, _ in path]
    all_lat = [lat for feature in features for path in feature.paths_lat_lon for _, lat in path]
    return (min(all_lon), min(all_lat), max(all_lon), max(all_lat))


def _project_extent_points(
    bbox_lon_lat: tuple[float, float, float, float],
    transformer: Transformer | None,
) -> list[tuple[float, float]]:
    min_lon, min_lat, max_lon, max_lat = bbox_lon_lat
    bbox_points = (
        (min_lon, min_lat),
        (min_lon, max_lat),
        (max_lon, min_lat),
        (max_lon, max_lat),
    )
    return list(_project_path(bbox_points, transformer))


def _remap_paths_to_canvas_space(
    paths: list[list[list[float]]],
    *,
    min_x: float,
    max_y: float,
) -> list[list[list[float]]]:
    return [[[point[0] - min_x, max_y - point[1]] for point in path] for path in paths]


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
