"""Parse a GTFS static feed into a canonical stops/connections model for CSA.

Scope (see PLAN.md Phase 11 for the full post-MVP design this trims from):
GTFS static only, filtered to a single reference service day and to stops
within a buffered bounding box around an existing walking graph's extent.
Which stops are walking-reachable from a given origin depends on where the
user clicks, so the actual Connection Scan Algorithm runs at query time in
the browser (web/src/app.js) — this module only prepares the raw sorted
connections table it scans over.

Two-stage design: `parse_gtfs_feed` and `attach_stops_to_nearest_nodes` work
in terms of raw GTFS stop ids (strings) and OSM node ids, because the
walking graph's final node indices aren't known until AFTER degree-2
simplification runs (which itself needs the attached OSM node ids, to keep
them from being simplified away). `finalize_transit_extract` resolves
everything to the final binary-ready index space once that's available.
"""

from __future__ import annotations

import csv
import math
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

from pyproj import Transformer

DEFAULT_STOP_ATTACH_RADIUS_M = 300.0
DEFAULT_EXTENT_BUFFER_M = 5_000.0
_GRID_CELL_SIZE_M = 500.0

TRANSPORT_TYPE_BUS = 0
TRANSPORT_TYPE_TRAM = 1
TRANSPORT_TYPE_SUBWAY = 2
TRANSPORT_TYPE_RAIL = 3
TRANSPORT_TYPE_WATER = 4
TRANSPORT_TYPE_OTHER = 5

# GTFS route_type -> compact transport_type. Covers both the legacy 0-7
# values and the extended (Google) values actually observed in the VBB feed
# (100/106/109 regional/suburban rail, 400 U-Bahn/urban rail, 700 bus,
# 900 tram, 1000 water transport).
_ROUTE_TYPE_TO_TRANSPORT_TYPE: dict[str, int] = {
    "0": TRANSPORT_TYPE_TRAM,
    "1": TRANSPORT_TYPE_SUBWAY,
    "2": TRANSPORT_TYPE_RAIL,
    "3": TRANSPORT_TYPE_BUS,
    "4": TRANSPORT_TYPE_WATER,
    "100": TRANSPORT_TYPE_RAIL,
    "106": TRANSPORT_TYPE_RAIL,
    "109": TRANSPORT_TYPE_RAIL,
    "400": TRANSPORT_TYPE_SUBWAY,
    "700": TRANSPORT_TYPE_BUS,
    "900": TRANSPORT_TYPE_TRAM,
    "1000": TRANSPORT_TYPE_WATER,
}

_WEEKDAY_COLUMNS = (
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
)

WALKING_SPEED_M_S = 1.39


# ---- Raw (pre-resolution) shapes -------------------------------------------------


@dataclass(frozen=True)
class RawStop:
    stop_id: str
    name: str
    x_m: int
    y_m: int
    route_ids: frozenset[str]


@dataclass(frozen=True)
class RawConnection:
    from_stop_id: str
    to_stop_id: str
    departure_seconds: int
    arrival_seconds: int
    route_id: str
    service_day_mask: int


@dataclass(frozen=True)
class ParsedGtfsFeed:
    stops: dict[str, RawStop]
    connections: tuple[RawConnection, ...]
    total_stop_count: int
    min_date: str
    max_date: str


@dataclass(frozen=True)
class AttachedStop:
    stop_id: str
    name: str
    x_m: int
    y_m: int
    nearest_node_osm_id: int
    walk_attach_cost_seconds: int
    transport_type: int


# ---- Final (binary-export-ready) shapes ------------------------------------------


@dataclass(frozen=True)
class TransitStop:
    stop_id: str
    name: str
    x_m: int
    y_m: int
    nearest_node_index: int
    walk_attach_cost_seconds: int
    transport_type: int


@dataclass(frozen=True)
class TransitConnection:
    from_stop_index: int
    to_stop_index: int
    departure_seconds: int
    arrival_seconds: int
    route_id: int
    service_day_mask: int


@dataclass(frozen=True)
class GtfsTransitExtract:
    stops: tuple[TransitStop, ...]
    connections: tuple[TransitConnection, ...]
    route_ids: tuple[str, ...]
    dropped_stop_count: int
    total_stop_count: int
    min_date: str
    max_date: str


def _iter_csv_rows(path: Path) -> Iterator[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        yield from csv.DictReader(handle)


def _parse_gtfs_time_to_seconds(raw: str) -> int:
    parts = raw.strip().split(":")
    if len(parts) != 3:
        raise ValueError(f"invalid GTFS time value: {raw!r}")
    hours, minutes, seconds = (int(part) for part in parts)
    return hours * 3600 + minutes * 60 + seconds


@dataclass(frozen=True)
class _ServiceCalendarEntry:
    day_mask: int
    start_date: int
    end_date: int


def _resolve_service_calendar(feed_dir: Path) -> dict[str, _ServiceCalendarEntry]:
    entries: dict[str, _ServiceCalendarEntry] = {}
    calendar_path = feed_dir / "calendar.txt"
    if calendar_path.is_file():
        for row in _iter_csv_rows(calendar_path):
            mask = 0
            for bit_index, column in enumerate(_WEEKDAY_COLUMNS):
                if row[column].strip() == "1":
                    mask |= 1 << bit_index
            entries[row["service_id"]] = _ServiceCalendarEntry(
                day_mask=mask,
                start_date=int(row["start_date"]),
                end_date=int(row["end_date"]),
            )
    return entries


def _format_gtfs_date(date_int: int) -> str:
    text = str(date_int)
    return f"{text[0:4]}-{text[4:6]}-{text[6:8]}"


def resolve_recurring_service_ids_and_date_range(
    feed_dir: Path,
) -> tuple[set[str], str, str]:
    """Every service_id with a nonzero weekly weekday pattern in
    calendar.txt, plus the overall min/max date range those services cover.

    calendar_dates.txt-only services (single-date add/remove exceptions,
    e.g. holiday specials) are intentionally excluded: their activity can't
    be expressed as a weekly bitmask, and modeling them precisely would need
    a per-date connections table rather than the single shared table the
    query-time CSA scan filters by weekday bit (see
    runConnectionScanFromWalkingReachableStops in web/src/app.js, which
    checks graph.tedgeServiceDayMask against the selected date's weekday).
    """
    calendar = _resolve_service_calendar(feed_dir)
    recurring_service_ids = {
        service_id for service_id, entry in calendar.items() if entry.day_mask != 0
    }
    if not recurring_service_ids:
        raise ValueError(f"no weekday-recurring GTFS services found in {feed_dir}")
    min_date = min(calendar[service_id].start_date for service_id in recurring_service_ids)
    max_date = max(calendar[service_id].end_date for service_id in recurring_service_ids)
    return recurring_service_ids, _format_gtfs_date(min_date), _format_gtfs_date(max_date)


def load_transport_type_by_route_id(feed_dir: Path) -> dict[str, int]:
    routes_path = feed_dir / "routes.txt"
    result: dict[str, int] = {}
    if not routes_path.is_file():
        return result
    for row in _iter_csv_rows(routes_path):
        result[row["route_id"]] = _ROUTE_TYPE_TO_TRANSPORT_TYPE.get(
            row.get("route_type", "").strip(),
            TRANSPORT_TYPE_OTHER,
        )
    return result


def parse_gtfs_feed(
    feed_dir: Path,
    *,
    epsg_code: int,
    extent_origin_easting: float,
    extent_origin_northing: float,
    extent_width_m: float,
    extent_height_m: float,
    extent_buffer_m: float = DEFAULT_EXTENT_BUFFER_M,
) -> ParsedGtfsFeed:
    """Parse+filter a GTFS feed directory, returning kept stops and connections.

    Stops are filtered to a buffered bounding box around an existing walking
    graph's extent; connections (hops between consecutive stop_times rows
    within a trip) are kept only when both endpoints are in that kept-stop
    set, and only for trips whose service recurs on some weekday (see
    resolve_recurring_service_ids_and_date_range). Every kept connection
    carries its true weekly service_day_mask; which ones apply to a given
    query date is decided later, at CSA scan time in the browser.
    """
    transformer = Transformer.from_crs("EPSG:4326", f"EPSG:{epsg_code}", always_xy=True)

    min_easting = extent_origin_easting - extent_buffer_m
    max_easting = extent_origin_easting + extent_width_m + extent_buffer_m
    min_northing = extent_origin_northing - extent_buffer_m
    max_northing = extent_origin_northing + extent_height_m + extent_buffer_m

    stop_positions: dict[str, tuple[int, int]] = {}
    stop_names: dict[str, str] = {}
    kept_stop_ids: set[str] = set()
    total_stop_count = 0
    for row in _iter_csv_rows(feed_dir / "stops.txt"):
        total_stop_count += 1
        lat = float(row["stop_lat"])
        lon = float(row["stop_lon"])
        easting, northing = transformer.transform(lon, lat)
        stop_id = row["stop_id"]
        # Offsets from the walking graph's own origin, matching
        # NodeRecord.x_m/y_m's "offset from origin" convention (node_offsets_m
        # is never in absolute UTM coordinates) — required both so nearest-node
        # distance comparisons in attach_stops_to_nearest_nodes are correct and
        # so the final StopRecord.x_m/y_m lines up with node positions.
        stop_positions[stop_id] = (
            int(round(easting - extent_origin_easting)),
            int(round(northing - extent_origin_northing)),
        )
        stop_names[stop_id] = row.get("stop_name", "")
        if min_easting <= easting <= max_easting and min_northing <= northing <= max_northing:
            kept_stop_ids.add(stop_id)

    active_service_ids, min_date, max_date = resolve_recurring_service_ids_and_date_range(feed_dir)
    service_day_masks = {
        service_id: entry.day_mask
        for service_id, entry in _resolve_service_calendar(feed_dir).items()
    }

    active_trip_service: dict[str, str] = {}
    trip_route_id: dict[str, str] = {}
    for row in _iter_csv_rows(feed_dir / "trips.txt"):
        if row["service_id"] not in active_service_ids:
            continue
        trip_id = row["trip_id"]
        active_trip_service[trip_id] = row["service_id"]
        trip_route_id[trip_id] = row["route_id"]

    # Rows are gathered for every active trip regardless of extent, and
    # filtered to the kept-stop set only when pairing up consecutive hops
    # below. Filtering rows here instead would splice together a phantom
    # direct hop (with wrong departure/arrival times) whenever a trip dips
    # briefly outside the extent and back in — e.g. in-extent -> far away
    # -> in-extent would otherwise collapse into a single incorrect hop
    # between the two in-extent stops.
    trip_stop_times: dict[str, list[tuple[int, str, int, int]]] = {}
    for row in _iter_csv_rows(feed_dir / "stop_times.txt"):
        trip_id = row["trip_id"]
        if trip_id not in active_trip_service:
            continue
        stop_id = row["stop_id"]
        sequence = int(row["stop_sequence"])
        arrival_seconds = _parse_gtfs_time_to_seconds(row["arrival_time"])
        departure_seconds = _parse_gtfs_time_to_seconds(row["departure_time"])
        trip_stop_times.setdefault(trip_id, []).append(
            (sequence, stop_id, arrival_seconds, departure_seconds)
        )

    stop_route_ids: dict[str, set[str]] = {}
    connections: list[RawConnection] = []
    for trip_id, rows in trip_stop_times.items():
        rows.sort(key=lambda entry: entry[0])
        service_id = active_trip_service[trip_id]
        route_id = trip_route_id.get(trip_id, "")
        service_day_mask = service_day_masks[service_id]
        for (_, from_stop_id, _, departure_seconds), (
            _,
            to_stop_id,
            arrival_seconds,
            _,
        ) in zip(rows, rows[1:], strict=False):
            if from_stop_id not in kept_stop_ids or to_stop_id not in kept_stop_ids:
                continue
            stop_route_ids.setdefault(from_stop_id, set()).add(route_id)
            stop_route_ids.setdefault(to_stop_id, set()).add(route_id)
            connections.append(
                RawConnection(
                    from_stop_id=from_stop_id,
                    to_stop_id=to_stop_id,
                    departure_seconds=departure_seconds,
                    arrival_seconds=arrival_seconds,
                    route_id=route_id,
                    service_day_mask=service_day_mask,
                )
            )

    connections.sort(key=lambda connection: connection.departure_seconds)

    used_stop_ids = set(stop_route_ids.keys())
    kept_stops = {
        stop_id: RawStop(
            stop_id=stop_id,
            name=stop_names.get(stop_id, ""),
            x_m=stop_positions[stop_id][0],
            y_m=stop_positions[stop_id][1],
            route_ids=frozenset(stop_route_ids.get(stop_id, ())),
        )
        for stop_id in used_stop_ids
        if stop_id in stop_positions
    }

    return ParsedGtfsFeed(
        stops=kept_stops,
        connections=tuple(connections),
        total_stop_count=total_stop_count,
        min_date=min_date,
        max_date=max_date,
    )


def attach_stops_to_nearest_nodes(
    stops: dict[str, RawStop],
    node_offsets_m: dict[int, tuple[int, int]],
    transport_type_by_route_id: dict[str, int],
    *,
    attach_radius_m: float = DEFAULT_STOP_ATTACH_RADIUS_M,
) -> tuple[dict[str, AttachedStop], int]:
    """Grid-bucketed nearest-node search, mirroring the JS spatial index used
    for click-to-node snapping (web/src/app.js
    findNearestNodeIndexForModeFromSpatialIndex) but reimplemented in Python
    rather than adding a scipy dependency (not currently installed)."""
    buckets: dict[tuple[int, int], list[int]] = {}
    for osm_id, (x_m, y_m) in node_offsets_m.items():
        cell = (int(x_m // _GRID_CELL_SIZE_M), int(y_m // _GRID_CELL_SIZE_M))
        buckets.setdefault(cell, []).append(osm_id)

    attached: dict[str, AttachedStop] = {}
    dropped_count = 0

    for stop_id, stop in stops.items():
        cell_x = int(stop.x_m // _GRID_CELL_SIZE_M)
        cell_y = int(stop.y_m // _GRID_CELL_SIZE_M)

        best_osm_id: int | None = None
        best_distance_sq = float("inf")
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for candidate_osm_id in buckets.get((cell_x + dx, cell_y + dy), ()):
                    cx, cy = node_offsets_m[candidate_osm_id]
                    distance_sq = (cx - stop.x_m) ** 2 + (cy - stop.y_m) ** 2
                    if distance_sq < best_distance_sq:
                        best_distance_sq = distance_sq
                        best_osm_id = candidate_osm_id

        if best_osm_id is None or math.sqrt(best_distance_sq) > attach_radius_m:
            dropped_count += 1
            continue

        distance_m = math.sqrt(best_distance_sq)
        transport_type = TRANSPORT_TYPE_OTHER
        for route_id in stop.route_ids:
            if route_id in transport_type_by_route_id:
                transport_type = transport_type_by_route_id[route_id]
                break

        attached[stop_id] = AttachedStop(
            stop_id=stop_id,
            name=stop.name,
            x_m=stop.x_m,
            y_m=stop.y_m,
            nearest_node_osm_id=best_osm_id,
            walk_attach_cost_seconds=max(1, round(distance_m / WALKING_SPEED_M_S)),
            transport_type=transport_type,
        )

    return attached, dropped_count


def finalize_transit_extract(
    attached_stops: dict[str, AttachedStop],
    osm_id_to_final_node_index: dict[int, int],
    raw_connections: tuple[RawConnection, ...],
    total_stop_count: int,
    dropped_stop_count: int,
    min_date: str,
    max_date: str,
) -> GtfsTransitExtract:
    """Resolve stop ids/OSM node ids to the final contiguous index space used
    by the binary stop/transit-edge tables, dropping any connection whose
    endpoint didn't survive attachment (radius-dropped) or simplification."""
    ordered_stop_ids = sorted(attached_stops.keys())
    stop_index_by_id: dict[str, int] = {
        stop_id: index for index, stop_id in enumerate(ordered_stop_ids)
    }

    route_ids = sorted({connection.route_id for connection in raw_connections})
    route_index_by_id = {route_id: index for index, route_id in enumerate(route_ids)}

    stops: list[TransitStop] = []
    for stop_id in ordered_stop_ids:
        attached = attached_stops[stop_id]
        final_node_index = osm_id_to_final_node_index.get(attached.nearest_node_osm_id)
        if final_node_index is None:
            continue
        stops.append(
            TransitStop(
                stop_id=attached.stop_id,
                name=attached.name,
                x_m=attached.x_m,
                y_m=attached.y_m,
                nearest_node_index=final_node_index,
                walk_attach_cost_seconds=attached.walk_attach_cost_seconds,
                transport_type=attached.transport_type,
            )
        )

    connections: list[TransitConnection] = []
    for raw in raw_connections:
        from_index = stop_index_by_id.get(raw.from_stop_id)
        to_index = stop_index_by_id.get(raw.to_stop_id)
        if from_index is None or to_index is None:
            continue
        connections.append(
            TransitConnection(
                from_stop_index=from_index,
                to_stop_index=to_index,
                departure_seconds=raw.departure_seconds,
                arrival_seconds=raw.arrival_seconds,
                route_id=route_index_by_id[raw.route_id],
                service_day_mask=raw.service_day_mask,
            )
        )

    return GtfsTransitExtract(
        stops=tuple(stops),
        connections=tuple(connections),
        route_ids=tuple(route_ids),
        dropped_stop_count=dropped_stop_count,
        total_stop_count=total_stop_count,
        min_date=min_date,
        max_date=max_date,
    )
