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


@dataclass(frozen=True)
class NaturalPolygonFeature:
    name: str
    paths_lat_lon: tuple[tuple[tuple[float, float], ...], ...]


@dataclass(frozen=True)
class WaterwayFeature:
    name: str
    category: str  # "river" | "stream" | "canal"
    navigable: bool
    paths_lat_lon: tuple[tuple[tuple[float, float], ...], ...]


_NAVIGABLE_BOAT_TAG_VALUES = {"yes", "permissive", "designated"}


def _index_node_and_way_geometry(
    elements: list[Any],
) -> tuple[dict[int, tuple[float, float]], dict[int, tuple[tuple[float, float], ...]]]:
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

    return node_lon_lat_by_id, way_geometry_by_id


def extract_overpass_boundary_features(
    overpass_json: dict[str, Any],
    *,
    admin_level: str | None = "9",
) -> tuple[BoundaryFeature, ...]:
    elements = overpass_json.get("elements")
    if not isinstance(elements, list):
        raise ValueError("Overpass JSON must contain an 'elements' list")

    features: list[BoundaryFeature] = []
    _, way_geometry_by_id = _index_node_and_way_geometry(elements)

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


def _stitch_ways_into_rings(
    way_geometries: list[tuple[tuple[float, float], ...]],
) -> list[tuple[tuple[float, float], ...]]:
    """Greedily join open way segments sharing endpoints into closed ring(s).

    Multipolygon relation members are frequently split into many way
    segments (a large tidal river's outer boundary alone can be dozens of
    ways); this reassembles them into fillable rings by matching shared
    endpoints. A chain that never closes is dropped by the caller rather than
    force-closed, since a straight line across a real gap would render as a
    wrong-shaped fill artifact.
    """
    remaining = [list(geometry) for geometry in way_geometries if len(geometry) >= 2]
    rings: list[tuple[tuple[float, float], ...]] = []

    while remaining:
        chain = remaining.pop(0)
        progress = True
        while chain[0] != chain[-1] and progress:
            progress = False
            for index, candidate in enumerate(remaining):
                if candidate[0] == chain[-1]:
                    chain = chain + candidate[1:]
                elif candidate[-1] == chain[-1]:
                    chain = chain + list(reversed(candidate))[1:]
                elif candidate[-1] == chain[0]:
                    chain = candidate[:-1] + chain
                elif candidate[0] == chain[0]:
                    chain = list(reversed(candidate))[:-1] + chain
                else:
                    continue
                remaining.pop(index)
                progress = True
                break
        rings.append(tuple(chain))

    return rings


def _compute_signed_ring_area(ring: tuple[tuple[float, float], ...]) -> float:
    if len(ring) < 3:
        return 0.0
    area_sum = 0.0
    for index in range(len(ring) - 1):
        x1, y1 = ring[index]
        x2, y2 = ring[index + 1]
        area_sum += x1 * y2 - x2 * y1
    return area_sum / 2.0


def _normalize_ring_winding(
    ring: tuple[tuple[float, float], ...],
    *,
    clockwise: bool,
) -> tuple[tuple[float, float], ...]:
    is_clockwise = _compute_signed_ring_area(ring) < 0
    if is_clockwise != clockwise:
        return tuple(reversed(ring))
    return ring


def _extract_multipolygon_relation_rings(
    element: dict[str, Any],
    way_geometry_by_id: dict[int, tuple[tuple[float, float], ...]],
) -> tuple[tuple[tuple[float, float], ...], ...]:
    """Assemble a relation's outer/inner member ways into fillable rings.

    Outer and inner rings are wound in opposite directions so a single
    beginPath()-style fill across every ring in the returned tuple punches
    holes correctly under the nonzero winding rule — the same convention
    already used for the coastal water polygons' multi-ring shapefile
    features. Which specific inner ring "belongs to" which outer ring does
    not matter for this: the renderer only needs consistent, opposite
    winding across the whole feature.
    """
    members = element.get("members")
    if not isinstance(members, list):
        return tuple()

    outer_way_geometries: list[tuple[tuple[float, float], ...]] = []
    inner_way_geometries: list[tuple[tuple[float, float], ...]] = []

    for member in members:
        if not isinstance(member, dict) or member.get("type") != "way":
            continue

        geometry = _parse_geometry_points(member.get("geometry"))
        if len(geometry) < 2:
            member_ref = member.get("ref")
            if isinstance(member_ref, int):
                geometry = way_geometry_by_id.get(member_ref, tuple())
        if len(geometry) < 2:
            continue

        if member.get("role") == "inner":
            inner_way_geometries.append(geometry)
        else:
            outer_way_geometries.append(geometry)

    outer_rings = [
        _normalize_ring_winding(ring, clockwise=False)
        for ring in _stitch_ways_into_rings(outer_way_geometries)
        if len(ring) >= 4 and ring[0] == ring[-1]
    ]
    inner_rings = [
        _normalize_ring_winding(ring, clockwise=True)
        for ring in _stitch_ways_into_rings(inner_way_geometries)
        if len(ring) >= 4 and ring[0] == ring[-1]
    ]

    return tuple(outer_rings + inner_rings)


def extract_overpass_natural_features(
    overpass_json: dict[str, Any],
) -> tuple[
    tuple[NaturalPolygonFeature, ...],
    tuple[NaturalPolygonFeature, ...],
    tuple[WaterwayFeature, ...],
    tuple[NaturalPolygonFeature, ...],
]:
    """Extract forest, inland-water, waterway, and airport context features.

    Polygon categories (forest, inland water, airport) accept both plain ways
    and multipolygon relations — relations are assembled from outer/inner
    member ways via `_stitch_ways_into_rings`, since large real-world
    features (a tidal river, a major airport) are frequently mapped as
    relations rather than a single way. Waterway lines (river/stream/canal)
    stay way-only; OSM doesn't represent those as multipolygon relations.

    Relation queries are scoped to specific tags only (`natural=water`,
    `aeroway=aerodrome`) rather than a broad one like
    `boundary=administrative` — see docs/overpass_boundary_query.sh for why
    that distinction matters for Overpass query cost on large regions.
    """
    elements = overpass_json.get("elements")
    if not isinstance(elements, list):
        raise ValueError("Overpass JSON must contain an 'elements' list")

    forest_features: list[NaturalPolygonFeature] = []
    inland_water_features: list[NaturalPolygonFeature] = []
    waterway_features: list[WaterwayFeature] = []
    airport_features: list[NaturalPolygonFeature] = []
    _, way_geometry_by_id = _index_node_and_way_geometry(elements)

    for element in elements:
        if not isinstance(element, dict):
            continue

        tags = element.get("tags")
        if not isinstance(tags, dict):
            continue

        element_type = element.get("type")
        name = str(tags.get("name") or "")

        if element_type == "way":
            way_id = element.get("id")
            if not isinstance(way_id, int):
                continue
            geometry = way_geometry_by_id.get(way_id)
            if geometry is None:
                continue

            waterway_value = tags.get("waterway")
            if waterway_value in {"river", "stream", "canal"}:
                waterway_features.append(
                    WaterwayFeature(
                        name=name,
                        category=str(waterway_value),
                        navigable=_is_navigable_waterway(tags, waterway_value),
                        paths_lat_lon=(geometry,),
                    )
                )
                continue

            if len(geometry) < 4 or geometry[0] != geometry[-1]:
                continue  # not a closed ring; skip rather than fill an open polygon

            polygon_feature = NaturalPolygonFeature(name=name, paths_lat_lon=(geometry,))
            if tags.get("natural") == "wood" or tags.get("landuse") == "forest":
                forest_features.append(polygon_feature)
            elif tags.get("natural") == "water":
                inland_water_features.append(polygon_feature)
            elif tags.get("aeroway") == "aerodrome":
                airport_features.append(polygon_feature)

        elif element_type == "relation":
            is_water_relation = tags.get("natural") == "water"
            is_airport_relation = tags.get("aeroway") == "aerodrome"
            if not (is_water_relation or is_airport_relation):
                continue

            rings = _extract_multipolygon_relation_rings(element, way_geometry_by_id)
            if not rings:
                continue

            relation_feature = NaturalPolygonFeature(name=name, paths_lat_lon=rings)
            if is_water_relation:
                inland_water_features.append(relation_feature)
            else:
                airport_features.append(relation_feature)

    return (
        tuple(forest_features),
        tuple(inland_water_features),
        tuple(waterway_features),
        tuple(airport_features),
    )


def _is_navigable_waterway(tags: dict[str, Any], waterway_value: object) -> bool:
    boat_tag = tags.get("boat")
    if boat_tag in _NAVIGABLE_BOAT_TAG_VALUES:
        return True
    if boat_tag == "no":
        return False
    return waterway_value == "canal"


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


MIN_NATURAL_POLYGON_AREA_M2 = 10_000.0  # ~1 hectare; drops digitizing-noise slivers


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
    # The region's own outline sits at a different admin_level from its
    # subdivisions, so filtering to the subdivision level discarded it. That is
    # harmless where subdivisions tile the region, but Mexico City's
    # admin_level 8 turns up ten scattered colonias plus a smaller entity that
    # merely shares the city's name, covering 36 x 37 km of a 45 x 60 km
    # region: the map simply stopped a third of the way down. The outline is
    # now always kept, and marked so the app can both draw it and use it for
    # the zoom-out limit.
    features = _with_region_outline_feature(features, overpass_json, admin_level)
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

    outline_relation_id = _resolve_region_outline_relation_id(features)
    boundary_bbox_lon_lat = _compute_feature_bbox_lon_lat(features)
    extent_points = _project_extent_points(boundary_bbox_lon_lat, transformer)

    prepared_features, boundary_stats = _prepare_drawable_features(
        features=tuple(
            {
                "relation_id": feature.relation_id,
                "name": feature.name,
                "admin_level": feature.admin_level,
                "is_region_outline": feature.relation_id == outline_relation_id,
                "paths": feature.paths_lat_lon,
            }
            for feature in features
        ),
        transformer=transformer,
        tolerance=tolerance,
        extra_field_names=("relation_id", "admin_level", "is_region_outline"),
    )

    # Natural-feature context (forest, inland water, waterways) always uses its
    # own metric transformer for area filtering, independent of `units`/
    # `transformer` above, which is None in degrees-mode builds and would
    # otherwise make the area threshold meaningless.
    metric_transformer = Transformer.from_crs("EPSG:4326", f"EPSG:{epsg_code}", always_xy=True)
    raw_forest_features, raw_inland_water_features, raw_waterway_features, raw_airport_features = (
        extract_overpass_natural_features(overpass_json)
    )
    raw_forest_features = _filter_natural_polygon_features_by_area(
        raw_forest_features,
        metric_transformer=metric_transformer,
        min_area_m2=MIN_NATURAL_POLYGON_AREA_M2,
    )
    raw_inland_water_features = _filter_natural_polygon_features_by_area(
        raw_inland_water_features,
        metric_transformer=metric_transformer,
        min_area_m2=MIN_NATURAL_POLYGON_AREA_M2,
    )
    raw_airport_features = _filter_natural_polygon_features_by_area(
        raw_airport_features,
        metric_transformer=metric_transformer,
        min_area_m2=MIN_NATURAL_POLYGON_AREA_M2,
    )

    prepared_forest_features, forest_stats = _prepare_drawable_features(
        features=tuple(
            {"name": feature.name, "paths": feature.paths_lat_lon}
            for feature in raw_forest_features
        ),
        transformer=transformer,
        tolerance=tolerance,
    )
    prepared_inland_water_features, inland_water_stats = _prepare_drawable_features(
        features=tuple(
            {"name": feature.name, "paths": feature.paths_lat_lon}
            for feature in raw_inland_water_features
        ),
        transformer=transformer,
        tolerance=tolerance,
    )
    prepared_waterway_features, waterway_stats = _prepare_drawable_features(
        features=tuple(
            {
                "name": feature.name,
                "category": feature.category,
                "navigable": feature.navigable,
                "paths": feature.paths_lat_lon,
            }
            for feature in raw_waterway_features
        ),
        transformer=transformer,
        tolerance=tolerance,
        extra_field_names=("category", "navigable"),
    )
    prepared_airport_features, airport_stats = _prepare_drawable_features(
        features=tuple(
            {"name": feature.name, "paths": feature.paths_lat_lon}
            for feature in raw_airport_features
        ),
        transformer=transformer,
        tolerance=tolerance,
    )

    for prepared_feature_list in (
        prepared_forest_features,
        prepared_inland_water_features,
        prepared_waterway_features,
        prepared_airport_features,
    ):
        for prepared_feature in prepared_feature_list:
            for path in prepared_feature["paths"]:
                for x, y in path:
                    extent_points.append((x, y))

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

    for prepared_feature_list in (
        prepared_features,
        prepared_water_features,
        prepared_forest_features,
        prepared_inland_water_features,
        prepared_waterway_features,
        prepared_airport_features,
    ):
        for prepared_feature in prepared_feature_list:
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
        "forest_features": prepared_forest_features,
        "inland_water_features": prepared_inland_water_features,
        "waterway_features": prepared_waterway_features,
        "airport_features": prepared_airport_features,
        "stats": {
            "feature_count": len(prepared_features),
            "path_count": boundary_stats["path_count"],
            "input_point_count": boundary_stats["input_point_count"],
            "output_point_count": boundary_stats["output_point_count"],
            "water_feature_count": len(prepared_water_features),
            "water_path_count": water_path_count,
            "forest_feature_count": len(prepared_forest_features),
            "forest_path_count": forest_stats["path_count"],
            "inland_water_feature_count": len(prepared_inland_water_features),
            "inland_water_path_count": inland_water_stats["path_count"],
            "waterway_feature_count": len(prepared_waterway_features),
            "waterway_path_count": waterway_stats["path_count"],
            "airport_feature_count": len(prepared_airport_features),
            "airport_path_count": airport_stats["path_count"],
        },
    }


def _prepare_drawable_features(
    *,
    features: tuple[dict[str, Any], ...],
    transformer: Transformer | None,
    tolerance: float,
    extra_field_names: tuple[str, ...] = (),
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
            for field_name in extra_field_names:
                if field_name in raw_feature:
                    prepared_feature[field_name] = raw_feature[field_name]
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


def _compute_projected_ring_area(ring: tuple[tuple[float, float], ...]) -> float:
    """Shoelace-formula area of a single ring, in the ring's own units squared."""
    return abs(_compute_signed_ring_area(ring))


def _filter_natural_polygon_features_by_area(
    features: tuple[NaturalPolygonFeature, ...],
    *,
    metric_transformer: Transformer,
    min_area_m2: float,
) -> tuple[NaturalPolygonFeature, ...]:
    kept: list[NaturalPolygonFeature] = []
    for feature in features:
        # A relation-sourced feature can carry multiple (possibly disconnected)
        # outer rings — e.g. one relation covering several separated reaches
        # of a river — so the size test uses the largest ring, not just the
        # first one.
        largest_ring_area = max(
            _compute_projected_ring_area(_project_path(ring, metric_transformer))
            for ring in feature.paths_lat_lon
        )
        if largest_ring_area >= min_area_m2:
            kept.append(feature)
    return tuple(kept)


def _feature_bbox_area_deg2(feature: BoundaryFeature) -> float:
    lons = [lon for path in feature.paths_lat_lon for _lat, lon in path]
    lats = [lat for path in feature.paths_lat_lon for lat, _lon in path]
    if not lons or not lats:
        return 0.0
    return (max(lons) - min(lons)) * (max(lats) - min(lats))


def _resolve_region_outline_relation_id(features: tuple[BoundaryFeature, ...]) -> int | None:
    """The region's own outline: the largest administrative boundary present.

    The Overpass boundary query exports the place relation together with its
    subdivisions, so the largest of them is the place relation by construction.
    Comparing bounding-box area rather than ring area is deliberate - a coastal
    region's outline can enclose less area than an inland subdivision while
    still spanning far more of the map, and it is the span that decides both
    what to draw and where to stop zooming out.
    """
    if not features:
        return None
    return max(features, key=_feature_bbox_area_deg2).relation_id


def _with_region_outline_feature(
    features: tuple[BoundaryFeature, ...],
    overpass_json: dict[str, Any],
    admin_level: str | None,
) -> tuple[BoundaryFeature, ...]:
    """Adds the region outline back if filtering to the subdivision level lost it."""
    if admin_level is None or not features:
        return features

    all_features = extract_overpass_boundary_features(overpass_json, admin_level=None)
    if not all_features:
        return features

    outline = max(all_features, key=_feature_bbox_area_deg2)
    known_ids = {feature.relation_id for feature in features}
    if outline.relation_id in known_ids:
        return features
    # Only if it actually encloses more than the subdivisions do; otherwise the
    # subdivisions already cover the region and there is nothing to add.
    if _feature_bbox_area_deg2(outline) <= max(
        _feature_bbox_area_deg2(feature) for feature in features
    ):
        return features
    return (outline, *features)


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
