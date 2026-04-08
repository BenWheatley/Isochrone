from isochrone_pipeline.boundary_canvas import (
    extract_overpass_boundary_features,
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
            (41.8890, 12.4680),
            (41.8900, 12.4690),
            (41.8910, 12.4700),
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
