from pathlib import Path

from isochrone_pipeline.gtfs_transit import (
    TRANSPORT_TYPE_BUS,
    TRANSPORT_TYPE_SUBWAY,
    attach_stops_to_nearest_nodes,
    finalize_transit_extract,
    load_transport_type_by_route_id,
    parse_gtfs_feed,
    resolve_recurring_service_ids_and_date_range,
)

# EPSG:25833 (UTM 33N) projections of stops A/B/C/D below (52.5000-52.5003N,
# 13.4000-13.4003E) land around easting=391390-391412, northing=5817855-
# 5817888 — verified via pyproj directly. The extent bbox here brackets
# that tightly, so "FAR" (52N further south, ~190km away) lands well
# outside even with the buffer.
_EXTENT_ORIGIN_EASTING = 391300.0
_EXTENT_ORIGIN_NORTHING = 5817800.0
_EXTENT_WIDTH_M = 200.0
_EXTENT_HEIGHT_M = 200.0

WEEKDAY_MASK = 0b0011111  # Monday..Friday (bits 0-4)
WEEKEND_MASK = 0b1100000  # Saturday, Sunday (bits 5-6)


def _write_gtfs_fixture(feed_dir: Path) -> None:
    feed_dir.mkdir(parents=True, exist_ok=True)

    (feed_dir / "stops.txt").write_text(
        "stop_id,stop_name,stop_lat,stop_lon\n"
        # In-extent stops (near 13.4E, 52.5N, close to the UTM33N origin above).
        '"A","Stop A","52.500000","13.400000"\n'
        '"B","Stop B","52.500100","13.400100"\n'
        '"C","Stop C","52.500200","13.400200"\n'
        '"D","Stop D","52.500300","13.400300"\n'
        # Far outside the buffered extent (should be filtered out).
        '"FAR","Stop Far Away","48.000000","11.000000"\n',
        encoding="utf-8",
    )

    (feed_dir / "routes.txt").write_text(
        "route_id,route_type\nR_SUBWAY,400\nR_BUS,700\n",
        encoding="utf-8",
    )

    # WEEKDAY and WEEKEND are both weekly-recurring (nonzero day mask) so
    # both get included regardless of any single "reference date" — that's
    # the whole point of the multi-day redesign. Their start/end windows
    # differ deliberately so the aggregated min/max date range has to
    # actually span both. SPECIAL only ever appears in calendar_dates.txt
    # (no calendar.txt row, so its day mask is unresolvable) and must stay
    # excluded — modeling single-date exceptions would need a per-date
    # connections table, which is out of scope (see
    # resolve_recurring_service_ids_and_date_range's docstring).
    (feed_dir / "calendar.txt").write_text(
        "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\n"
        "WEEKDAY,1,1,1,1,1,0,0,20260101,20261231\n"
        "WEEKEND,0,0,0,0,0,1,1,20260301,20260901\n",
        encoding="utf-8",
    )

    (feed_dir / "calendar_dates.txt").write_text(
        "service_id,date,exception_type\n"
        # A one-off addition for a service with no calendar.txt row at all —
        # must NOT make it into the recurring set or the date range.
        "SPECIAL,20260812,1\n",
        encoding="utf-8",
    )

    (feed_dir / "trips.txt").write_text(
        "route_id,service_id,trip_id\n"
        "R_SUBWAY,WEEKDAY,T_MORNING\n"
        "R_BUS,WEEKEND,T_WEEKEND\n"
        "R_SUBWAY,SPECIAL,T_SPECIAL_ONLY\n"  # excluded: not weekly-recurring
        "R_SUBWAY,WEEKDAY,T_PAST_MIDNIGHT\n"
        "R_SUBWAY,WEEKDAY,T_TOUCHES_FAR\n"
        "R_SUBWAY,WEEKDAY,T_DIPS_OUT_AND_BACK\n",
        encoding="utf-8",
    )

    (feed_dir / "stop_times.txt").write_text(
        "trip_id,stop_id,stop_sequence,arrival_time,departure_time\n"
        # T_MORNING: ordinary weekday service, two hops.
        "T_MORNING,A,0,08:00:00,08:00:00\n"
        "T_MORNING,B,1,08:05:00,08:05:00\n"
        "T_MORNING,C,2,08:10:00,08:10:00\n"
        # T_WEEKEND: weekend-only service, one hop.
        "T_WEEKEND,A,0,10:00:00,10:00:00\n"
        "T_WEEKEND,B,1,10:05:00,10:05:00\n"
        # T_SPECIAL_ONLY: must be entirely excluded (service isn't recurring).
        "T_SPECIAL_ONLY,A,0,09:00:00,09:00:00\n"
        "T_SPECIAL_ONLY,B,1,09:05:00,09:05:00\n"
        # T_PAST_MIDNIGHT: GTFS past-midnight rollover time.
        "T_PAST_MIDNIGHT,B,0,25:10:00,25:10:00\n"
        "T_PAST_MIDNIGHT,C,1,25:20:00,25:20:00\n"
        # T_TOUCHES_FAR: hops from an in-extent stop to a far one — must be
        # dropped entirely (both endpoints have to be in-extent).
        "T_TOUCHES_FAR,A,0,11:00:00,11:00:00\n"
        "T_TOUCHES_FAR,FAR,1,12:00:00,12:00:00\n"
        # T_DIPS_OUT_AND_BACK: A (in) -> FAR (out) -> D (in). Must NOT
        # produce a phantom A->D connection — that would splice over the
        # dropped FAR stop with the wrong departure/arrival times.
        "T_DIPS_OUT_AND_BACK,A,0,13:00:00,13:00:00\n"
        "T_DIPS_OUT_AND_BACK,FAR,1,14:00:00,14:00:00\n"
        "T_DIPS_OUT_AND_BACK,D,2,15:00:00,15:00:00\n",
        encoding="utf-8",
    )


def test_resolve_recurring_service_ids_and_date_range_excludes_calendar_dates_only_services(
    tmp_path: Path,
) -> None:
    _write_gtfs_fixture(tmp_path)

    service_ids, min_date, max_date = resolve_recurring_service_ids_and_date_range(tmp_path)

    assert service_ids == {"WEEKDAY", "WEEKEND"}
    assert min_date == "2026-01-01"
    assert max_date == "2026-12-31"


def test_parse_gtfs_feed_includes_every_recurring_weekday_pattern(tmp_path: Path) -> None:
    _write_gtfs_fixture(tmp_path)

    parsed = parse_gtfs_feed(
        tmp_path,
        epsg_code=25833,
        extent_origin_easting=_EXTENT_ORIGIN_EASTING,
        extent_origin_northing=_EXTENT_ORIGIN_NORTHING,
        extent_width_m=_EXTENT_WIDTH_M,
        extent_height_m=_EXTENT_HEIGHT_M,
    )

    assert parsed.total_stop_count == 5
    assert set(parsed.stops.keys()) == {"A", "B", "C"}
    assert parsed.min_date == "2026-01-01"
    assert parsed.max_date == "2026-12-31"

    for connection in parsed.connections:
        assert connection.route_id != ""  # sanity: every kept connection has a route

    # T_MORNING contributes A->B and B->C (2 hops); T_WEEKEND contributes
    # A->B (1 hop); T_PAST_MIDNIGHT contributes B->C (1 hop).
    # T_SPECIAL_ONLY is excluded entirely (not a recurring service).
    # T_TOUCHES_FAR's only hop touches FAR, so it contributes 0.
    # T_DIPS_OUT_AND_BACK's A->FAR and FAR->D hops both touch FAR, so it
    # also contributes 0 (no phantom A->D hop).
    assert len(parsed.connections) == 4

    departures = [connection.departure_seconds for connection in parsed.connections]
    assert departures == sorted(departures)

    past_midnight = next(c for c in parsed.connections if c.departure_seconds > 24 * 3600)
    assert past_midnight.departure_seconds == 25 * 3600 + 10 * 60
    assert past_midnight.service_day_mask == WEEKDAY_MASK

    by_departure = {c.departure_seconds: c for c in parsed.connections}
    assert by_departure[8 * 3600].service_day_mask == WEEKDAY_MASK  # T_MORNING A->B
    assert by_departure[8 * 3600 + 5 * 60].service_day_mask == WEEKDAY_MASK  # T_MORNING B->C
    assert by_departure[10 * 3600].service_day_mask == WEEKEND_MASK  # T_WEEKEND A->B

    # Neither the direct A->FAR hop nor a spliced A->D phantom hop appears.
    assert all(c.to_stop_id != "FAR" and c.from_stop_id != "FAR" for c in parsed.connections)
    assert not any(c.from_stop_id == "A" and c.to_stop_id == "D" for c in parsed.connections)


def test_load_transport_type_by_route_id_maps_extended_gtfs_codes(tmp_path: Path) -> None:
    _write_gtfs_fixture(tmp_path)

    transport_types = load_transport_type_by_route_id(tmp_path)

    assert transport_types["R_SUBWAY"] == TRANSPORT_TYPE_SUBWAY
    assert transport_types["R_BUS"] == TRANSPORT_TYPE_BUS


def test_attach_stops_to_nearest_nodes_respects_radius_and_drops_far_stops() -> None:
    parsed_stops = {
        "near": _raw_stop("near", 100, 100),
        "far": _raw_stop("far", 100_000, 100_000),
    }
    node_offsets_m = {1: (105, 100), 2: (200, 200)}

    attached, dropped_count = attach_stops_to_nearest_nodes(
        parsed_stops, node_offsets_m, {}, attach_radius_m=50.0
    )

    assert dropped_count == 1
    assert set(attached.keys()) == {"near"}
    assert attached["near"].nearest_node_osm_id == 1
    assert attached["near"].walk_attach_cost_seconds >= 1


def _raw_stop(stop_id: str, x_m: int, y_m: int):
    from isochrone_pipeline.gtfs_transit import RawStop

    return RawStop(stop_id=stop_id, name=stop_id, x_m=x_m, y_m=y_m, route_ids=frozenset())


def test_finalize_transit_extract_resolves_indices_and_drops_unattached_endpoints() -> None:
    from isochrone_pipeline.gtfs_transit import AttachedStop, RawConnection

    attached_stops = {
        "A": AttachedStop(
            stop_id="A",
            name="Stop A",
            x_m=0,
            y_m=0,
            nearest_node_osm_id=100,
            walk_attach_cost_seconds=5,
            transport_type=TRANSPORT_TYPE_SUBWAY,
        ),
        "B": AttachedStop(
            stop_id="B",
            name="Stop B",
            x_m=10,
            y_m=0,
            nearest_node_osm_id=200,
            walk_attach_cost_seconds=3,
            transport_type=TRANSPORT_TYPE_BUS,
        ),
    }
    osm_id_to_final_node_index = {100: 7, 200: 9}
    raw_connections = (
        RawConnection(
            from_stop_id="A",
            to_stop_id="B",
            departure_seconds=100,
            arrival_seconds=200,
            route_id="R1",
            service_day_mask=0b1111100,
        ),
        # References a stop that was never attached (radius-dropped) —
        # must be silently excluded, not raise or produce a bad index.
        RawConnection(
            from_stop_id="A",
            to_stop_id="UNATTACHED",
            departure_seconds=300,
            arrival_seconds=400,
            route_id="R1",
            service_day_mask=0b1111100,
        ),
    )

    extract = finalize_transit_extract(
        attached_stops,
        osm_id_to_final_node_index,
        raw_connections,
        total_stop_count=5,
        dropped_stop_count=1,
        min_date="2026-01-01",
        max_date="2026-12-31",
    )

    assert len(extract.stops) == 2
    assert len(extract.connections) == 1
    assert extract.dropped_stop_count == 1
    assert extract.total_stop_count == 5
    assert extract.min_date == "2026-01-01"
    assert extract.max_date == "2026-12-31"

    stop_a = next(s for s in extract.stops if s.stop_id == "A")
    stop_b = next(s for s in extract.stops if s.stop_id == "B")
    assert stop_a.nearest_node_index == 7
    assert stop_b.nearest_node_index == 9

    connection = extract.connections[0]
    stops_by_index = {0: extract.stops[0].stop_id, 1: extract.stops[1].stop_id}
    assert stops_by_index[connection.from_stop_index] == "A"
    assert stops_by_index[connection.to_stop_index] == "B"
    assert extract.route_ids[connection.route_id] == "R1"
