from pathlib import Path

from isochrone_pipeline.artifacts import write_graph_binary_artifacts


def _write_fixture(path: Path) -> None:
    path.write_text(
        """
{
  "version": 0.6,
  "elements": [
    {"type": "node", "id": 1, "lat": 52.5, "lon": 13.4},
    {"type": "node", "id": 2, "lat": 52.5001, "lon": 13.401},
    {"type": "node", "id": 20, "lat": 52.51, "lon": 13.41},
    {"type": "node", "id": 21, "lat": 52.511, "lon": 13.411},
    {
      "type": "way",
      "id": 100,
      "nodes": [1, 2],
      "tags": {"highway": "footway"}
    },
    {
      "type": "way",
      "id": 200,
      "nodes": [20, 21],
      "tags": {"route": "ferry", "foot": "yes"}
    }
  ]
}
""".strip(),
        encoding="utf-8",
    )


def test_write_graph_binary_artifacts_reports_water_edge_counts(tmp_path: Path) -> None:
    source = tmp_path / "routing.json"
    _write_fixture(source)
    binary_output = tmp_path / "graph.bin"
    summary_output = tmp_path / "graph-summary.json"

    summary = write_graph_binary_artifacts(
        input_path=source,
        binary_output=binary_output,
        summary_output=summary_output,
        epsg=25833,
    )

    assert summary["edge_mode_counts"]["water"] == 2
    assert summary["edge_mode_counts"]["walk"] >= 2
    assert summary["edge_mode_coverage_ratio"]["water"] > 0.0


def _write_transit_fixture(feed_dir: Path) -> None:
    feed_dir.mkdir(parents=True, exist_ok=True)
    # Stop "S1" sits essentially on top of walking-graph node 1 (52.5, 13.4)
    # from _write_fixture above, so it should attach cleanly. "S2" is a
    # second nearby stop so T1 has an actual hop (a lone stop_times row
    # with no neighbor produces zero connections, and parse_gtfs_feed only
    # keeps stops that participate in at least one connection).
    (feed_dir / "stops.txt").write_text(
        "stop_id,stop_name,stop_lat,stop_lon\n"
        '"S1","Near Node 1","52.500010","13.400010"\n'
        '"S2","Near Node 1 Also","52.500020","13.400020"\n',
        encoding="utf-8",
    )
    (feed_dir / "routes.txt").write_text("route_id,route_type\nR1,900\n", encoding="utf-8")
    (feed_dir / "calendar.txt").write_text(
        "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,"
        "start_date,end_date\nWEEKDAY,1,1,1,1,1,0,0,20260101,20261231\n",
        encoding="utf-8",
    )
    (feed_dir / "calendar_dates.txt").write_text(
        "service_id,date,exception_type\n", encoding="utf-8"
    )
    (feed_dir / "trips.txt").write_text(
        "route_id,service_id,trip_id\nR1,WEEKDAY,T1\n", encoding="utf-8"
    )
    (feed_dir / "stop_times.txt").write_text(
        "trip_id,stop_id,stop_sequence,arrival_time,departure_time\n"
        "T1,S1,0,08:00:00,08:00:00\n"
        "T1,S2,1,08:05:00,08:05:00\n",
        encoding="utf-8",
    )


def test_write_graph_binary_artifacts_wires_transit_stops_and_edges(tmp_path: Path) -> None:
    source = tmp_path / "routing.json"
    _write_fixture(source)
    transit_feed_dir = tmp_path / "transit-gtfs"
    _write_transit_fixture(transit_feed_dir)
    binary_output = tmp_path / "graph.bin"
    summary_output = tmp_path / "graph-summary.json"

    summary = write_graph_binary_artifacts(
        input_path=source,
        binary_output=binary_output,
        summary_output=summary_output,
        epsg=25833,
        transit_feed_dir=transit_feed_dir,
    )

    assert summary["transit"]["attached_stop_count"] == 2
    assert summary["transit"]["dropped_stop_count"] == 0
    assert summary["transit"]["final_stop_count"] == 2
    assert summary["transit"]["final_connection_count"] == 1
    assert summary["transit"]["date_range"] == {"min": "2026-01-01", "max": "2026-12-31"}
    assert summary["header"]["n_stops"] == 2
    assert summary["header"]["n_tedges"] == 1
    assert summary["header"]["flags"] & 1


def test_write_graph_binary_artifacts_keeps_stop_attachment_node_through_simplification(
    tmp_path: Path,
) -> None:
    # A pure single-way, two-node graph never has a degree-2 interior node
    # to simplify away, so this test only proves the transit wiring doesn't
    # regress plain (no-transit) behavior when transit_feed_dir is None —
    # the real "stop node survives simplification" guarantee is already
    # covered directly in test_simplify.py via NODE_FLAG_STOP_ATTACHMENT.
    source = tmp_path / "routing.json"
    _write_fixture(source)
    binary_output = tmp_path / "graph.bin"
    summary_output = tmp_path / "graph-summary.json"

    summary = write_graph_binary_artifacts(
        input_path=source,
        binary_output=binary_output,
        summary_output=summary_output,
        epsg=25833,
    )

    assert "transit" not in summary
    assert summary["header"]["n_stops"] == 0
    assert summary["header"]["flags"] == 0
