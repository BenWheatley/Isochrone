import zipfile
from pathlib import Path

from isochrone_pipeline.boundary_canvas import (
    _compute_signed_ring_area,
    _stitch_ways_into_rings,
    extract_overpass_boundary_features,
    extract_overpass_natural_features,
    simplify_overpass_boundaries_for_canvas,
    simplify_polyline,
)

SAMPLE_OVERPASS = {
    "elements": [
        {
            "type": "relation",
            "id": 100,
            "tags": {
                "boundary": "administrative",
                "type": "boundary",
                "admin_level": "9",
                "name": "Mitte",
            },
            "members": [
                {
                    "type": "way",
                    "geometry": [
                        {"lat": 52.5200, "lon": 13.3700},
                        {"lat": 52.5205, "lon": 13.3750},
                        {"lat": 52.5210, "lon": 13.3800},
                    ],
                }
            ],
        },
        {
            "type": "relation",
            "id": 200,
            "tags": {
                "boundary": "administrative",
                "type": "boundary",
                "admin_level": "10",
                "name": "ShouldBeIgnored",
            },
            "members": [],
        },
    ]
}

SAMPLE_OVERPASS_REF_WAYS = {
    "elements": [
        {
            "type": "relation",
            "id": 101,
            "tags": {
                "boundary": "administrative",
                "type": "boundary",
                "admin_level": "9",
                "name": "Pankow",
            },
            "members": [
                {"type": "way", "ref": 9001, "role": "outer"},
            ],
        },
        {
            "type": "way",
            "id": 9001,
            "geometry": [
                {"lat": 52.5300, "lon": 13.4000},
                {"lat": 52.5310, "lon": 13.4010},
                {"lat": 52.5320, "lon": 13.4020},
            ],
        },
    ]
}

SAMPLE_OVERPASS_REF_WAYS_WITH_NODE_COORDS = {
    "elements": [
        {
            "type": "relation",
            "id": 103,
            "tags": {
                "boundary": "administrative",
                "type": "boundary",
                "admin_level": "9",
                "name": "Trastevere",
            },
            "members": [
                {"type": "way", "ref": 9100, "role": "outer"},
            ],
        },
        {
            "type": "way",
            "id": 9100,
            "nodes": [7001, 7002, 7003],
        },
        {
            "type": "node",
            "id": 7001,
            "lat": 41.8890,
            "lon": 12.4680,
        },
        {
            "type": "node",
            "id": 7002,
            "lat": 41.8900,
            "lon": 12.4690,
        },
        {
            "type": "node",
            "id": 7003,
            "lat": 41.8910,
            "lon": 12.4700,
        },
    ]
}

SAMPLE_OVERPASS_NO_GEOMETRY = {
    "elements": [
        {
            "type": "relation",
            "id": 102,
            "tags": {
                "boundary": "administrative",
                "type": "boundary",
                "admin_level": "9",
                "name": "NoGeom",
            },
        },
    ]
}

SAMPLE_OVERPASS_EMPTY = {
    "elements": [],
}

SAMPLE_OVERPASS_PLACE_ONLY = {
    "elements": [
        {
            "type": "relation",
            "id": 127167,
            "tags": {
                "boundary": "administrative",
                "type": "boundary",
                "admin_level": "6",
                "name": "Portsmouth",
            },
            "members": [
                {"type": "way", "ref": 9901, "role": "outer"},
            ],
        },
        {
            "type": "way",
            "id": 9901,
            "nodes": [8001, 8002, 8003],
        },
        {
            "type": "node",
            "id": 8001,
            "lat": 50.8000,
            "lon": -1.1000,
        },
        {
            "type": "node",
            "id": 8002,
            "lat": 50.8100,
            "lon": -1.0900,
        },
        {
            "type": "node",
            "id": 8003,
            "lat": 50.8200,
            "lon": -1.0800,
        },
    ]
}


def _closed_square_geometry(
    *, lat: float, lon: float, lat_delta: float, lon_delta: float
) -> list[dict[str, float]]:
    corners = [
        (lat, lon),
        (lat, lon + lon_delta),
        (lat + lat_delta, lon + lon_delta),
        (lat + lat_delta, lon),
        (lat, lon),
    ]
    return [{"lat": corner_lat, "lon": corner_lon} for corner_lat, corner_lon in corners]


SAMPLE_OVERPASS_NATURAL_FEATURES = {
    "elements": [
        SAMPLE_OVERPASS["elements"][0],  # boundary=administrative relation "Mitte"
        {
            "type": "way",
            "id": 20001,
            "tags": {"natural": "wood", "name": "TinyCopse"},
            "geometry": _closed_square_geometry(
                lat=52.5000, lon=13.3000, lat_delta=0.0003, lon_delta=0.0003
            ),
        },
        {
            "type": "way",
            "id": 20002,
            "tags": {"landuse": "forest", "name": "BigForest"},
            "geometry": _closed_square_geometry(
                lat=52.5100, lon=13.3100, lat_delta=0.01, lon_delta=0.01
            ),
        },
        {
            "type": "way",
            "id": 20003,
            "tags": {"natural": "water", "name": "BigLake"},
            "geometry": _closed_square_geometry(
                lat=52.5200, lon=13.3200, lat_delta=0.01, lon_delta=0.01
            ),
        },
        {
            "type": "way",
            "id": 20004,
            "tags": {"waterway": "river", "name": "PlainRiver"},
            "geometry": [
                {"lat": 52.5300, "lon": 13.3300},
                {"lat": 52.5310, "lon": 13.3310},
            ],
        },
        {
            "type": "way",
            "id": 20005,
            "tags": {"waterway": "stream", "name": "PlainStream"},
            "geometry": [
                {"lat": 52.5400, "lon": 13.3400},
                {"lat": 52.5410, "lon": 13.3410},
            ],
        },
        {
            "type": "way",
            "id": 20006,
            "tags": {"waterway": "canal", "name": "PlainCanal"},
            "geometry": [
                {"lat": 52.5500, "lon": 13.3500},
                {"lat": 52.5510, "lon": 13.3510},
            ],
        },
        {
            "type": "way",
            "id": 20007,
            "tags": {"waterway": "canal", "boat": "no", "name": "NonNavigableCanal"},
            "geometry": [
                {"lat": 52.5600, "lon": 13.3600},
                {"lat": 52.5610, "lon": 13.3610},
            ],
        },
        {
            "type": "way",
            "id": 20008,
            "tags": {"waterway": "river", "boat": "yes", "name": "NavigableRiver"},
            "geometry": [
                {"lat": 52.5700, "lon": 13.3700},
                {"lat": 52.5710, "lon": 13.3710},
            ],
        },
    ]
}


SAMPLE_OVERPASS_MULTIPOLYGON_FEATURES = {
    "elements": [
        SAMPLE_OVERPASS["elements"][0],  # boundary=administrative relation "Mitte"
        {
            "type": "relation",
            "id": 30001,
            "tags": {"natural": "water", "type": "multipolygon", "name": "BigRiver"},
            "members": [
                {"type": "way", "ref": 30101, "role": "outer"},
                {"type": "way", "ref": 30102, "role": "outer"},
                {"type": "way", "ref": 30103, "role": "inner"},
            ],
        },
        {
            # Outer boundary split across two way segments that must be
            # stitched end-to-end into one closed ring.
            "type": "way",
            "id": 30101,
            "geometry": [
                {"lat": 52.5000, "lon": 13.3000},
                {"lat": 52.5000, "lon": 13.3100},
                {"lat": 52.5100, "lon": 13.3100},
            ],
        },
        {
            "type": "way",
            "id": 30102,
            "geometry": [
                {"lat": 52.5100, "lon": 13.3100},
                {"lat": 52.5100, "lon": 13.3000},
                {"lat": 52.5000, "lon": 13.3000},
            ],
        },
        {
            # Island hole, already a closed ring on its own.
            "type": "way",
            "id": 30103,
            "geometry": [
                {"lat": 52.5030, "lon": 13.3030},
                {"lat": 52.5030, "lon": 13.3070},
                {"lat": 52.5070, "lon": 13.3070},
                {"lat": 52.5070, "lon": 13.3030},
                {"lat": 52.5030, "lon": 13.3030},
            ],
        },
        {
            "type": "way",
            "id": 30201,
            "tags": {"aeroway": "aerodrome", "name": "SmallAirfield"},
            "geometry": _closed_square_geometry(
                lat=52.5200, lon=13.3200, lat_delta=0.01, lon_delta=0.01
            ),
        },
        {
            "type": "relation",
            "id": 30301,
            "tags": {"aeroway": "aerodrome", "type": "multipolygon", "name": "BigAirport"},
            "members": [
                {"type": "way", "ref": 30401, "role": "outer"},
            ],
        },
        {
            "type": "way",
            "id": 30401,
            "geometry": _closed_square_geometry(
                lat=52.5300, lon=13.3300, lat_delta=0.01, lon_delta=0.01
            ),
        },
    ]
}


def _write_test_water_polygons_zip(zip_path: Path) -> None:
    import shapefile

    source_dir = zip_path.parent / "water_source"
    source_dir.mkdir(parents=True, exist_ok=True)
    shapefile_base = source_dir / "water_polygons"

    writer = shapefile.Writer(str(shapefile_base), shapeType=shapefile.POLYGON)
    writer.field("name", "C")
    writer.poly(
        [
            [
                [13.3600, 52.5190],
                [13.3900, 52.5190],
                [13.3900, 52.5220],
                [13.3600, 52.5220],
                [13.3600, 52.5190],
            ]
        ]
    )
    writer.record("ocean")
    writer.close()

    with zipfile.ZipFile(zip_path, "w") as archive:
        for suffix in (".shp", ".shx", ".dbf"):
            file_path = shapefile_base.with_suffix(suffix)
            archive.write(file_path, arcname=file_path.name)


def test_extract_overpass_boundary_features_filters_admin_level() -> None:
    features = extract_overpass_boundary_features(SAMPLE_OVERPASS, admin_level="9")

    assert len(features) == 1
    assert features[0].relation_id == 100
    assert features[0].name == "Mitte"
    assert len(features[0].paths_lat_lon) == 1


def test_simplify_polyline_reduces_nearly_collinear_points() -> None:
    points = ((0.0, 0.0), (0.5, 0.01), (1.0, 0.0))

    simplified = simplify_polyline(points, tolerance=0.05)

    assert simplified == ((0.0, 0.0), (1.0, 0.0))


def test_simplify_overpass_boundaries_for_canvas_degrees() -> None:
    payload = simplify_overpass_boundaries_for_canvas(
        SAMPLE_OVERPASS,
        tolerance=0.0,
        units="degrees",
        admin_level="9",
    )

    assert payload["coordinate_space"]["units"] == "degrees"
    assert payload["coordinate_space"]["projection"] == "EPSG:4326"
    assert payload["stats"]["feature_count"] == 1
    assert payload["stats"]["input_point_count"] == payload["stats"]["output_point_count"]

    first_path = payload["features"][0]["paths"][0]
    assert first_path[0][0] >= 0.0
    assert first_path[0][1] >= 0.0


def test_simplify_overpass_boundaries_for_canvas_meters() -> None:
    payload = simplify_overpass_boundaries_for_canvas(
        SAMPLE_OVERPASS,
        tolerance=25.0,
        units="meters",
        epsg_code=25833,
        admin_level="9",
    )

    assert payload["coordinate_space"]["units"] == "meters"
    assert payload["coordinate_space"]["projection"] == "EPSG:25833"
    assert payload["stats"]["output_point_count"] <= payload["stats"]["input_point_count"]


def test_extract_overpass_boundary_features_uses_way_refs_with_geometry() -> None:
    features = extract_overpass_boundary_features(SAMPLE_OVERPASS_REF_WAYS, admin_level="9")

    assert len(features) == 1
    assert features[0].relation_id == 101
    assert len(features[0].paths_lat_lon) == 1
    assert len(features[0].paths_lat_lon[0]) == 3


def test_extract_overpass_boundary_features_reconstructs_way_geometry_from_node_coords() -> None:
    features = extract_overpass_boundary_features(
        SAMPLE_OVERPASS_REF_WAYS_WITH_NODE_COORDS,
        admin_level="9",
    )

    assert len(features) == 1
    assert features[0].relation_id == 103
    assert features[0].paths_lat_lon == (
        (
            (12.4680, 41.8890),
            (12.4690, 41.8900),
            (12.4700, 41.8910),
        ),
    )


def test_simplify_overpass_boundaries_requires_geometry() -> None:
    try:
        simplify_overpass_boundaries_for_canvas(
            SAMPLE_OVERPASS_NO_GEOMETRY,
            tolerance=25.0,
            units="meters",
            admin_level="9",
        )
    except ValueError as exc:
        assert "No administrative boundary geometry found" in str(exc)
    else:
        raise AssertionError("expected ValueError")


def test_simplify_overpass_boundaries_rejects_empty_overpass_payload() -> None:
    try:
        simplify_overpass_boundaries_for_canvas(
            SAMPLE_OVERPASS_EMPTY,
            tolerance=25.0,
            units="meters",
            admin_level="9",
        )
    except ValueError as exc:
        assert "zero Overpass elements" in str(exc)
    else:
        raise AssertionError("expected ValueError")


def test_simplify_overpass_boundaries_falls_back_to_place_boundary() -> None:
    payload = simplify_overpass_boundaries_for_canvas(
        SAMPLE_OVERPASS_PLACE_ONLY,
        tolerance=0.0,
        units="degrees",
        admin_level="10",
    )

    assert payload["stats"]["feature_count"] == 1
    assert payload["features"][0]["relation_id"] == 127167
    assert payload["features"][0]["name"] == "Portsmouth"


def test_simplify_overpass_boundaries_can_include_clipped_water_polygons(
    tmp_path: Path,
) -> None:
    coast_zip_path = tmp_path / "water-polygons.zip"
    _write_test_water_polygons_zip(coast_zip_path)

    payload = simplify_overpass_boundaries_for_canvas(
        SAMPLE_OVERPASS,
        tolerance=0.0,
        units="degrees",
        admin_level="9",
        include_coast=True,
        coast_source=coast_zip_path,
    )

    assert payload["stats"]["water_feature_count"] == 1
    assert payload["stats"]["water_path_count"] >= 1
    assert len(payload["water_features"]) == 1

    width = payload["coordinate_space"]["width"]
    height = payload["coordinate_space"]["height"]
    water_path = payload["water_features"][0]["paths"][0]
    assert len(water_path) >= 4
    for x, y in water_path:
        assert 0.0 <= x <= width
        assert 0.0 <= y <= height


def test_extract_overpass_natural_features_buckets_by_tag() -> None:
    forest, inland_water, waterways, airports = extract_overpass_natural_features(
        SAMPLE_OVERPASS_NATURAL_FEATURES
    )

    assert {feature.name for feature in forest} == {"TinyCopse", "BigForest"}
    assert {feature.name for feature in inland_water} == {"BigLake"}
    waterways_by_name = {feature.name: feature for feature in waterways}
    assert set(waterways_by_name) == {
        "PlainRiver",
        "PlainStream",
        "PlainCanal",
        "NonNavigableCanal",
        "NavigableRiver",
    }
    assert airports == ()


def test_extract_overpass_natural_features_navigability_rules() -> None:
    _forest, _inland_water, waterways, _airports = extract_overpass_natural_features(
        SAMPLE_OVERPASS_NATURAL_FEATURES
    )
    waterways_by_name = {feature.name: feature for feature in waterways}

    # No explicit `boat` tag: canal defaults navigable, river/stream do not.
    assert waterways_by_name["PlainRiver"].category == "river"
    assert waterways_by_name["PlainRiver"].navigable is False
    assert waterways_by_name["PlainStream"].category == "stream"
    assert waterways_by_name["PlainStream"].navigable is False
    assert waterways_by_name["PlainCanal"].category == "canal"
    assert waterways_by_name["PlainCanal"].navigable is True

    # Explicit `boat` tag overrides the waterway-type default either way.
    assert waterways_by_name["NonNavigableCanal"].navigable is False
    assert waterways_by_name["NavigableRiver"].navigable is True


def test_simplify_overpass_boundaries_filters_small_polygons_and_keeps_large_ones() -> None:
    payload = simplify_overpass_boundaries_for_canvas(
        SAMPLE_OVERPASS_NATURAL_FEATURES,
        tolerance=0.0,
        units="meters",
        epsg_code=25833,
        admin_level="9",
    )

    forest_names = {feature["name"] for feature in payload["forest_features"]}
    assert forest_names == {"BigForest"}  # TinyCopse dropped: below the area threshold
    assert payload["stats"]["forest_feature_count"] == 1

    inland_water_names = {feature["name"] for feature in payload["inland_water_features"]}
    assert inland_water_names == {"BigLake"}
    assert payload["stats"]["inland_water_feature_count"] == 1

    assert payload["stats"]["waterway_feature_count"] == 5
    assert len(payload["waterway_features"]) == 5
    waterway_by_name = {feature["name"]: feature for feature in payload["waterway_features"]}
    assert waterway_by_name["PlainCanal"]["navigable"] is True
    assert waterway_by_name["PlainRiver"]["navigable"] is False
    assert waterway_by_name["PlainRiver"]["category"] == "river"


def test_simplify_overpass_boundaries_area_filter_stays_metric_in_degrees_mode() -> None:
    """Regression: the area filter must use a dedicated metric transformer,
    not the (possibly-None, degrees-passthrough) render transformer, or a
    1-hectare threshold becomes meaningless/inconsistent in degrees-mode
    builds."""
    payload = simplify_overpass_boundaries_for_canvas(
        SAMPLE_OVERPASS_NATURAL_FEATURES,
        tolerance=0.0,
        units="degrees",
        epsg_code=25833,
        admin_level="9",
    )

    forest_names = {feature["name"] for feature in payload["forest_features"]}
    assert forest_names == {"BigForest"}
    inland_water_names = {feature["name"] for feature in payload["inland_water_features"]}
    assert inland_water_names == {"BigLake"}


def test_stitch_ways_into_rings_joins_open_segments_sharing_endpoints() -> None:
    segment_a = ((0.0, 0.0), (0.0, 1.0), (1.0, 1.0))
    segment_b = ((1.0, 1.0), (1.0, 0.0), (0.0, 0.0))

    rings = _stitch_ways_into_rings([segment_a, segment_b])

    assert len(rings) == 1
    ring = rings[0]
    assert ring[0] == ring[-1]
    assert len(ring) == 5


def test_stitch_ways_into_rings_leaves_already_closed_ways_untouched() -> None:
    closed = ((0.0, 0.0), (0.0, 1.0), (1.0, 1.0), (1.0, 0.0), (0.0, 0.0))

    rings = _stitch_ways_into_rings([closed])

    assert rings == [closed]


def test_stitch_ways_into_rings_reverses_a_segment_stored_backwards() -> None:
    # segment_b's endpoints are stored in the opposite direction to how it
    # connects (its LAST point, not first, matches the growing chain's end),
    # so stitching it in must reverse it first.
    segment_a = ((0.0, 0.0), (0.0, 1.0))
    segment_b = ((1.0, 1.0), (0.0, 1.0))
    segment_c = ((1.0, 1.0), (0.0, 0.0))

    rings = _stitch_ways_into_rings([segment_a, segment_b, segment_c])

    assert len(rings) == 1
    ring = rings[0]
    assert ring[0] == ring[-1]
    assert ring == ((0.0, 0.0), (0.0, 1.0), (1.0, 1.0), (0.0, 0.0))


def test_extract_overpass_natural_features_stitches_water_relation_with_hole() -> None:
    _forest, inland_water, _waterways, _airports = extract_overpass_natural_features(
        SAMPLE_OVERPASS_MULTIPOLYGON_FEATURES
    )

    rivers = [feature for feature in inland_water if feature.name == "BigRiver"]
    assert len(rivers) == 1
    river = rivers[0]
    assert len(river.paths_lat_lon) == 2  # one stitched outer ring, one inner hole

    outer_ring, inner_ring = river.paths_lat_lon
    assert outer_ring[0] == outer_ring[-1]
    assert inner_ring[0] == inner_ring[-1]
    assert len(outer_ring) == 5  # two 3-point ways stitched, shared endpoint deduped

    # Outer and inner rings must wind in opposite directions for nonzero-winding
    # fill to punch the hole correctly.
    outer_area = _compute_signed_ring_area(outer_ring)
    inner_area = _compute_signed_ring_area(inner_ring)
    assert (outer_area < 0) != (inner_area < 0)


def test_extract_overpass_natural_features_extracts_airport_way_and_relation() -> None:
    _forest, _inland_water, _waterways, airports = extract_overpass_natural_features(
        SAMPLE_OVERPASS_MULTIPOLYGON_FEATURES
    )

    airport_names = {feature.name for feature in airports}
    assert airport_names == {"SmallAirfield", "BigAirport"}

    big_airport = next(feature for feature in airports if feature.name == "BigAirport")
    assert len(big_airport.paths_lat_lon) == 1
    assert big_airport.paths_lat_lon[0][0] == big_airport.paths_lat_lon[0][-1]


def test_simplify_overpass_boundaries_includes_water_relation_and_airports() -> None:
    payload = simplify_overpass_boundaries_for_canvas(
        SAMPLE_OVERPASS_MULTIPOLYGON_FEATURES,
        tolerance=0.0,
        units="meters",
        epsg_code=25833,
        admin_level="9",
    )

    inland_water_by_name = {
        feature["name"]: feature for feature in payload["inland_water_features"]
    }
    assert "BigRiver" in inland_water_by_name
    assert len(inland_water_by_name["BigRiver"]["paths"]) == 2

    airport_names = {feature["name"] for feature in payload["airport_features"]}
    assert airport_names == {"SmallAirfield", "BigAirport"}
    assert payload["stats"]["airport_feature_count"] == 2
