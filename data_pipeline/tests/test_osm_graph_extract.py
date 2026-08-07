from pathlib import Path

from isochrone_pipeline.osm_graph_extract import (
    WayCandidate,
    collect_connector_nodes,
    collect_ferry_way_candidates,
    collect_walkable_way_candidates,
    extract_walkable_graph_input,
    load_referenced_nodes,
    summarize_constraint_tag_coverage,
)


def _write_fixture(path: Path) -> None:
    path.write_text(
        """
{
  "version": 0.6,
  "elements": [
    {"type": "node", "id": 1, "lat": 52.5, "lon": 13.4},
    {"type": "node", "id": 2, "lat": 52.5005, "lon": 13.401},
    {"type": "node", "id": 3, "lat": 52.501, "lon": 13.402},
    {"type": "node", "id": 10, "lat": 52.502, "lon": 13.403, "tags": {"highway": "crossing"}},
    {
      "type": "node",
      "id": 11,
      "lat": 52.503,
      "lon": 13.404,
      "tags": {"barrier": "gate", "entrance": "yes"}
    },
    {
      "type": "way",
      "id": 100,
      "nodes": [1, 2, 3],
      "tags": {
        "highway": "footway",
        "access": "yes",
        "oneway": "no",
        "oneway:foot": "no",
        "bicycle": "yes",
        "cycleway": "track",
        "oneway:bicycle": "no",
        "motor_vehicle": "no",
        "vehicle": "no",
        "sidewalk": "both",
        "junction": "roundabout",
        "service": "alley",
        "surface": "paving_stones",
        "tracktype": "grade1",
        "maxspeed": "30",
        "maxspeed:forward": "25",
        "maxspeed:backward": "20"
      }
    },
    {"type": "way", "id": 101, "nodes": [2, 4], "tags": {"highway": "residential", "foot": "yes"}},
    {"type": "way", "id": 102, "nodes": [1, 2], "tags": {"highway": "motorway"}}
  ]
}
""".strip(),
        encoding="utf-8",
    )


def test_collect_walkable_way_candidates_and_constraints(tmp_path: Path) -> None:
    source = tmp_path / "sample.json"
    _write_fixture(source)

    result = collect_walkable_way_candidates(source)

    assert len(result.ways) == 2
    assert result.ways[0].osm_id == 100
    assert result.ways[0].constraints["access"] == "yes"
    assert result.ways[0].constraints["oneway"] == "no"
    assert result.ways[0].constraints["oneway:foot"] == "no"
    assert result.ways[0].constraints["bicycle"] == "yes"
    assert result.ways[0].constraints["cycleway"] == "track"
    assert result.ways[0].constraints["oneway:bicycle"] == "no"
    assert result.ways[0].constraints["motor_vehicle"] == "no"
    assert result.ways[0].constraints["vehicle"] == "no"
    assert result.ways[0].constraints["sidewalk"] == "both"
    assert result.ways[0].constraints["junction"] == "roundabout"
    assert result.ways[0].constraints["service"] == "alley"
    assert result.ways[0].constraints["surface"] == "paving_stones"
    assert result.ways[0].constraints["tracktype"] == "grade1"
    assert result.ways[0].constraints["maxspeed"] == "30"
    assert result.ways[0].constraints["maxspeed:forward"] == "25"
    assert result.ways[0].constraints["maxspeed:backward"] == "20"
    assert result.ways[1].osm_id == 101
    assert result.ways[1].constraints["foot"] == "yes"
    assert result.referenced_node_ids == {1, 2, 3, 4}


def test_load_referenced_nodes_filters_to_requested_ids(tmp_path: Path) -> None:
    source = tmp_path / "sample.json"
    _write_fixture(source)

    coords = load_referenced_nodes(source, {2, 3, 999})

    assert set(coords.keys()) == {2, 3}


def test_collect_connector_nodes_detects_types(tmp_path: Path) -> None:
    source = tmp_path / "sample.json"
    _write_fixture(source)

    connectors = collect_connector_nodes(source)

    assert connectors[10].connector_types == ("crossing",)
    assert set(connectors[11].connector_types) == {"barrier", "entrance"}


def test_extract_walkable_graph_input_drops_missing_node_ways(tmp_path: Path) -> None:
    source = tmp_path / "sample.json"
    _write_fixture(source)

    extracted = extract_walkable_graph_input(source)

    assert len(extracted.ways) == 1
    assert extracted.ways[0].osm_id == 100
    assert extracted.dropped_way_count == 1
    assert set(extracted.node_coords.keys()) == {1, 2, 3}
    assert set(extracted.connector_nodes.keys()) == {10, 11}


def _write_ferry_fixture(path: Path) -> None:
    path.write_text(
        """
{
  "version": 0.6,
  "elements": [
    {"type": "node", "id": 1, "lat": 52.5, "lon": 13.4},
    {"type": "node", "id": 2, "lat": 52.5005, "lon": 13.401},
    {"type": "node", "id": 20, "lat": 47.36, "lon": 8.54},
    {"type": "node", "id": 21, "lat": 47.30, "lon": 8.75},
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
      "tags": {"route": "ferry", "foot": "yes", "duration": "00:25"}
    }
  ]
}
""".strip(),
        encoding="utf-8",
    )


def test_collect_ferry_way_candidates_filters_route_ferry(tmp_path: Path) -> None:
    source = tmp_path / "ferry.json"
    _write_ferry_fixture(source)

    result = collect_ferry_way_candidates(source)

    assert len(result.ways) == 1
    assert result.ways[0].osm_id == 200
    assert result.ways[0].highway == "ferry"
    assert result.ways[0].node_ids == (20, 21)
    assert result.ways[0].constraints["foot"] == "yes"
    assert result.ways[0].constraints["duration"] == "00:25"
    assert result.referenced_node_ids == {20, 21}


def test_extract_walkable_graph_input_merges_ferry_and_highway_ways(tmp_path: Path) -> None:
    source = tmp_path / "ferry.json"
    _write_ferry_fixture(source)

    extracted = extract_walkable_graph_input(source)

    osm_ids = {way.osm_id for way in extracted.ways}
    assert osm_ids == {100, 200}
    assert set(extracted.node_coords.keys()) == {1, 2, 20, 21}
    ferry_way = next(way for way in extracted.ways if way.osm_id == 200)
    assert ferry_way.highway == "ferry"


def test_summarize_constraint_tag_coverage_counts_presence() -> None:
    ways = (
        WayCandidate(
            osm_id=1,
            highway="residential",
            node_ids=(1, 2),
            constraints={
                "access": "yes",
                "foot": "yes",
                "bicycle": "yes",
                "maxspeed": "50",
            },
        ),
        WayCandidate(
            osm_id=2,
            highway="residential",
            node_ids=(2, 3),
            constraints={
                "foot": "yes",
                "motor_vehicle": "no",
                "maxspeed:forward": "30",
            },
        ),
    )
    coverage = summarize_constraint_tag_coverage(ways)

    assert coverage.total_way_count == 2
    assert coverage.tag_presence["foot"] == 2
    assert coverage.tag_presence["maxspeed"] == 1
    assert coverage.tag_presence["maxspeed:forward"] == 1
    assert coverage.tag_presence["maxspeed:backward"] == 0
    assert coverage.tag_coverage_ratio["foot"] == 1.0
    assert coverage.tag_coverage_ratio["maxspeed"] == 0.5
