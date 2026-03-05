from isochrone_pipeline.overpass_survey import compute_node_density_per_km, count_highway_values


def test_count_highway_values() -> None:
    elements = [
        {"type": "way", "tags": {"highway": "residential"}},
        {"type": "way", "tags": {"highway": "residential"}},
        {"type": "way", "tags": {"highway": "footway"}},
        {"type": "node", "tags": {"highway": "crossing"}},
        {"type": "way", "tags": {}},
    ]

    counts = count_highway_values(elements)

    assert counts["residential"] == 2
    assert counts["footway"] == 1
    assert "crossing" not in counts


def test_compute_node_density_per_km() -> None:
    # Roughly 1 km polyline with 6 points (~5 segments) along Berlin latitude.
    ways = [
        {
            "type": "way",
            "geometry": [
                {"lat": 52.5200, "lon": 13.4050},
                {"lat": 52.5200, "lon": 13.4079},
                {"lat": 52.5200, "lon": 13.4108},
                {"lat": 52.5200, "lon": 13.4137},
                {"lat": 52.5200, "lon": 13.4166},
                {"lat": 52.5200, "lon": 13.4195},
            ],
        }
    ]

    density = compute_node_density_per_km(ways)

    assert density is not None
    assert 5.5 <= density <= 6.5


def test_compute_node_density_per_km_returns_none_for_zero_length() -> None:
    ways = [{"type": "way", "geometry": [{"lat": 52.52, "lon": 13.405}]}]

    density = compute_node_density_per_km(ways)

    assert density is None
