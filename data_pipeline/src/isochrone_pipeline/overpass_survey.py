"""Overpass survey helpers for Berlin highway tag analysis."""

from __future__ import annotations

import math
from collections import Counter
from collections.abc import Iterable

# Pragmatic walkable set for initial routing survey.
WALKABLE_HIGHWAY_VALUES: tuple[str, ...] = (
    "footway",
    "path",
    "pedestrian",
    "living_street",
    "residential",
    "service",
    "track",
    "steps",
    "cycleway",
    "unclassified",
    "tertiary",
    "secondary",
    "primary",
)


def count_highway_values(elements: Iterable[dict[str, object]]) -> Counter[str]:
    counts: Counter[str] = Counter()

    for element in elements:
        if element.get("type") != "way":
            continue

        tags = element.get("tags")
        if not isinstance(tags, dict):
            continue

        highway = tags.get("highway")
        if isinstance(highway, str):
            counts[highway] += 1

    return counts


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance in metres."""
    radius_m = 6_371_000.0
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    delta_phi = math.radians(lat2 - lat1)
    delta_lambda = math.radians(lon2 - lon1)

    a = math.sin(delta_phi / 2.0) ** 2 + math.cos(phi1) * math.cos(phi2) * (
        math.sin(delta_lambda / 2.0) ** 2
    )
    c = 2.0 * math.atan2(math.sqrt(a), math.sqrt(1.0 - a))
    return radius_m * c


def compute_node_density_per_km(ways: Iterable[dict[str, object]]) -> float | None:
    total_nodes = 0
    total_length_m = 0.0

    for way in ways:
        if way.get("type") != "way":
            continue

        geometry = way.get("geometry")
        if not isinstance(geometry, list) or len(geometry) < 2:
            continue

        coords: list[tuple[float, float]] = []
        for point in geometry:
            if not isinstance(point, dict):
                continue

            lat = point.get("lat")
            lon = point.get("lon")
            if isinstance(lat, float | int) and isinstance(lon, float | int):
                coords.append((float(lat), float(lon)))

        if len(coords) < 2:
            continue

        total_nodes += len(coords)

        for (lat1, lon1), (lat2, lon2) in zip(coords, coords[1:], strict=False):
            total_length_m += haversine_m(lat1, lon1, lat2, lon2)

    if total_length_m <= 0.0:
        return None

    km = total_length_m / 1_000.0
    return total_nodes / km
