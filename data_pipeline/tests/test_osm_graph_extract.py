from pathlib import Path

from isochrone_pipeline.osm_graph_extract import (
    WayCandidate,
    collect_connector_nodes,
    collect_ferry_way_candidates,
    collect_walkable_way_candidates,
    extract_walkable_graph_input,
    load_referenced_nodes,
    select_ferry_ways_within_grid_budget,
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
    # Footway network and ferry (20, 21) both sit around Lake Zurich. The
    # footways span the canton (~40 km), as a real region's road network does,
    # so the ~20 km lake boat is comfortably inside the region - the case
    # select_ferry_ways_within_grid_budget must keep. A two-node core a few
    # metres across would not model this: against that, every ferry looks
    # like an international route.
    path.write_text(
        """
{
  "version": 0.6,
  "elements": [
    {"type": "node", "id": 1, "lat": 47.20, "lon": 8.40},
    {"type": "node", "id": 2, "lat": 47.55, "lon": 8.85},
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


def _write_long_ferry_fixture(path: Path) -> None:
    path.write_text(
        """
{
  "version": 0.6,
  "elements": [
    {"type": "node", "id": 1, "lat": 52.5, "lon": 13.4},
    {"type": "node", "id": 2, "lat": 52.5005, "lon": 13.401},
    {"type": "node", "id": 30, "lat": 37.9373296, "lon": 23.6370552},
    {"type": "node", "id": 31, "lat": 34.6555364, "lon": 33.019948},
    {"type": "node", "id": 40, "lat": 52.502, "lon": 13.403},
    {"type": "node", "id": 41, "lat": 52.5025, "lon": 13.4035},
    {
      "type": "way",
      "id": 100,
      "nodes": [1, 2],
      "tags": {"highway": "footway"}
    },
    {
      "type": "way",
      "id": 300,
      "nodes": [30, 31],
      "tags": {"route": "ferry", "duration": "31:00"}
    },
    {
      "type": "way",
      "id": 400,
      "nodes": [40, 41],
      "tags": {"route": "ferry", "duration": "00:05"}
    }
  ]
}
""".strip(),
        encoding="utf-8",
    )


def test_extract_walkable_graph_input_drops_excessively_long_ferry_ways(
    tmp_path: Path,
) -> None:
    source = tmp_path / "long_ferry.json"
    _write_long_ferry_fixture(source)

    extracted = extract_walkable_graph_input(source)

    osm_ids = {way.osm_id for way in extracted.ways}
    assert osm_ids == {100, 400}
    assert 300 not in osm_ids
    # The dropped ~700 km ferry's endpoints must not linger in node_coords,
    # or they'd still blow out the region's projected bounding box.
    assert 30 not in extracted.node_coords
    assert 31 not in extracted.node_coords
    assert extracted.dropped_way_count == 1


def _write_long_coastal_ferry_fixture(path: Path) -> None:
    # A ~90 km coastal ferry - longer than the old fixed 80 km cutoff would
    # have allowed, but well within a large region's own extent: the footways
    # here span Cyprus (~150 km), as the island's real road network does. Must
    # be kept, because what decides this is the region's own size, not a fixed
    # per-way distance.
    path.write_text(
        """
{
  "version": 0.6,
  "elements": [
    {"type": "node", "id": 1, "lat": 34.65, "lon": 32.30},
    {"type": "node", "id": 2, "lat": 35.15, "lon": 33.95},
    {"type": "node", "id": 50, "lat": 34.7, "lon": 33.0},
    {"type": "node", "id": 51, "lat": 34.75, "lon": 32.0},
    {
      "type": "way",
      "id": 100,
      "nodes": [1, 2],
      "tags": {"highway": "footway"}
    },
    {
      "type": "way",
      "id": 500,
      "nodes": [50, 51],
      "tags": {"route": "ferry", "duration": "01:30"}
    }
  ]
}
""".strip(),
        encoding="utf-8",
    )


def test_extract_walkable_graph_input_keeps_ferry_longer_than_old_fixed_cutoff(
    tmp_path: Path,
) -> None:
    source = tmp_path / "long_coastal_ferry.json"
    _write_long_coastal_ferry_fixture(source)

    extracted = extract_walkable_graph_input(source)

    osm_ids = {way.osm_id for way in extracted.ways}
    assert osm_ids == {100, 500}
    assert extracted.dropped_way_count == 0


def test_select_ferry_ways_within_grid_budget_prefers_nearest_ferries_first() -> None:
    core_bbox = (0.0, 0.0, 0.001, 0.001)
    node_coords = {
        # ~10 km from the core.
        1: (0.09, 0.0),
        2: (0.091, 0.0),
        # ~50 km from the core.
        3: (0.45, 0.0),
        4: (0.451, 0.0),
        # ~200 km from the core - should be dropped once the 100 km budget
        # is used up by the nearer two.
        5: (1.8, 0.0),
        6: (1.801, 0.0),
    }
    # Declared far-to-near, to confirm selection is distance-ordered, not
    # input-order-dependent.
    ferry_far = WayCandidate(osm_id=300, highway="ferry", node_ids=(5, 6), constraints={})
    ferry_mid = WayCandidate(osm_id=200, highway="ferry", node_ids=(3, 4), constraints={})
    ferry_near = WayCandidate(osm_id=100, highway="ferry", node_ids=(1, 2), constraints={})

    accepted = select_ferry_ways_within_grid_budget(
        (ferry_far, ferry_mid, ferry_near),
        node_coords,
        core_bbox,
        budget_meters=100_000.0,
        # This test is about the grid budget and the near-first ordering; the
        # region margin has its own test below.
        margin_fraction=float("inf"),
    )

    accepted_ids = {way.osm_id for way in accepted}
    assert accepted_ids == {100, 200}


def test_select_ferry_ways_within_grid_budget_handles_no_walkable_core() -> None:
    node_coords = {1: (10.0, 20.0), 2: (10.001, 20.001)}
    ferry = WayCandidate(osm_id=900, highway="ferry", node_ids=(1, 2), constraints={})

    accepted = select_ferry_ways_within_grid_budget(
        (ferry,), node_coords, core_bbox=None, budget_meters=100_000.0
    )

    assert {way.osm_id for way in accepted} == {900}


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


def test_select_ferry_ways_rejects_routes_that_leave_the_region() -> None:
    """Portsmouth's real shape: a small city with ferries to another country.

    The map never zooms out past the region's own boundary, so a route
    reaching far beyond it only ever draws a line off the edge of the view to
    a destination that is never shown. Its grid came out 206 x 248 km for a
    city 11 km across.
    """
    # Portsea Island, roughly 11 x 12 km.
    core_bbox = (50.78, -1.11, 50.85, -1.03)
    node_coords = {
        # Gosport foot ferry: a few hundred metres across the harbour.
        1: (50.795, -1.109),
        2: (50.796, -1.117),
        # Isle of Wight: outside the region, ~20 km south.
        3: (50.79, -1.10),
        4: (50.61, -1.16),
        # Channel Islands: far outside, ~180 km south.
        5: (50.79, -1.10),
        6: (49.18, -2.11),
    }
    gosport = WayCandidate(osm_id=100, highway="ferry", node_ids=(1, 2), constraints={})
    isle_of_wight = WayCandidate(osm_id=200, highway="ferry", node_ids=(3, 4), constraints={})
    channel_islands = WayCandidate(osm_id=300, highway="ferry", node_ids=(5, 6), constraints={})

    accepted = select_ferry_ways_within_grid_budget(
        (channel_islands, isle_of_wight, gosport),
        node_coords,
        core_bbox,
    )

    assert {way.osm_id for way in accepted} == {100}


def test_select_ferry_ways_margin_floor_keeps_a_crossing_in_a_compact_region() -> None:
    """A small region must not be held so tightly it loses its own ferry.

    The margin is a fraction of the region's span, which for a compact region
    is small in absolute terms - hence the floor.
    """
    # A town about 1 km across.
    core_bbox = (51.500, -0.100, 51.509, -0.090)
    node_coords = {
        # A crossing just outside it, well within the floor.
        1: (51.504, -0.089),
        2: (51.504, -0.080),
    }
    crossing = WayCandidate(osm_id=100, highway="ferry", node_ids=(1, 2), constraints={})

    accepted = select_ferry_ways_within_grid_budget((crossing,), node_coords, core_bbox)

    assert {way.osm_id for way in accepted} == {100}
