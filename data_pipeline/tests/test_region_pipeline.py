from __future__ import annotations

import gzip
import json
from io import StringIO
from pathlib import Path

from isochrone_pipeline.region_pipeline import (
    DEFAULT_LOCATIONS_FILE,
    RegionSpec,
    build_location_manifest,
    load_region_specs,
    main,
    parse_relation_bounds,
    run_build_pipeline,
    run_fetch_pipeline,
)


def test_load_region_specs_reads_external_json_config(tmp_path: Path) -> None:
    locations_file = tmp_path / "regions.json"
    locations_file.write_text(
        json.dumps(
            {
                "locations": [
                    {
                        "id": "paris",
                        "name": "Paris",
                        "graphFileName": "paris-graph.bin.gz",
                        "boundaryFileName": "paris-district-boundaries-canvas.json",
                        "locationRelation": 'rel["boundary"="administrative"]["wikidata"="Q90"]',
                        "subdivisionAdminLevel": "9",
                        "epsg": 2154,
                    }
                ]
            }
        ),
        encoding="utf-8",
    )

    specs = load_region_specs(locations_file)

    assert specs == (
        RegionSpec(
            id="paris",
            name="Paris",
            graph_file_name="paris-graph.bin.gz",
            boundary_file_name="paris-district-boundaries-canvas.json",
            location_relation='rel["boundary"="administrative"]["wikidata"="Q90"]',
            subdivision_admin_level="9",
            subdivision_discovery_modes=("area", "subarea"),
            routing_query_scope="area",
            routing_tile_size_degrees=None,
            epsg=2154,
            graph_binary_file_name="paris-graph.bin",
            graph_summary_file_name="paris-graph-summary.json",
            boundary_resolution=25.0,
            boundary_units="meters",
        ),
    )


def test_build_location_manifest_strips_pipeline_only_fields() -> None:
    manifest = build_location_manifest(
        [
            RegionSpec(
                id="paris",
                name="Paris",
                graph_file_name="paris-graph.bin.gz",
                boundary_file_name="paris-district-boundaries-canvas.json",
                location_relation='rel["boundary"="administrative"]["wikidata"="Q90"]',
                subdivision_admin_level="9",
                subdivision_discovery_modes=("area", "subarea"),
                routing_query_scope="area",
                routing_tile_size_degrees=None,
                epsg=2154,
                graph_binary_file_name="paris-graph.bin",
                graph_summary_file_name="paris-graph-summary.json",
                boundary_resolution=25.0,
                boundary_units="meters",
            )
        ]
    )

    assert manifest == {
        "locations": [
            {
                "id": "paris",
                "name": "Paris",
                "graphFileName": "paris-graph.bin.gz",
                "boundaryFileName": "paris-district-boundaries-canvas.json",
            }
        ]
    }


def test_run_build_pipeline_writes_outputs_and_returns_manifest(
    tmp_path: Path,
) -> None:
    input_dir = tmp_path / "input"
    output_dir = tmp_path / "output"
    input_dir.mkdir()
    output_dir.mkdir()

    (input_dir / "paris-routing.osm.json").write_text('{"elements": []}\n', encoding="utf-8")
    (input_dir / "paris-district-boundaries.osm.json").write_text(
        '{"elements": []}\n',
        encoding="utf-8",
    )

    def fake_simplify(
        *,
        input_path: Path,
        output_path: Path,
        resolution: float,
        units: str,
        epsg: int,
        admin_level: str,
    ) -> dict[str, object]:
        output_path.write_text('{"format": "isochrone-canvas-boundaries-v1"}\n', encoding="utf-8")
        return {
            "input": str(input_path),
            "output": str(output_path),
            "resolution": {"value": resolution, "units": units},
            "coordinate_space": {"projection": f"EPSG:{epsg}"},
            "stats": {"feature_count": 1},
        }

    def fake_export(
        *,
        input_path: Path,
        binary_output: Path,
        summary_output: Path,
        epsg: int,
    ) -> dict[str, object]:
        binary_output.write_bytes(b"graph-bytes")
        summary_output.write_text(
            json.dumps({"input": str(input_path), "epsg_code": epsg}),
            encoding="utf-8",
        )
        return {
            "input": str(input_path),
            "binary_output": str(binary_output),
            "binary_size_bytes": len(b"graph-bytes"),
        }

    manifest = run_build_pipeline(
        [
            RegionSpec(
                id="paris",
                name="Paris",
                graph_file_name="paris-graph.bin.gz",
                boundary_file_name="paris-district-boundaries-canvas.json",
                location_relation='rel["boundary"="administrative"]["wikidata"="Q90"]',
                subdivision_admin_level="9",
                subdivision_discovery_modes=("area", "subarea"),
                routing_query_scope="area",
                routing_tile_size_degrees=None,
                epsg=2154,
                graph_binary_file_name="paris-graph.bin",
                graph_summary_file_name="paris-graph-summary.json",
                boundary_resolution=25.0,
                boundary_units="meters",
            )
        ],
        input_dir=input_dir,
        output_dir=output_dir,
        simplify_boundaries=fake_simplify,
        export_graph_binary=fake_export,
    )

    assert (output_dir / "paris-district-boundaries-canvas.json").is_file()
    assert (output_dir / "paris-graph.bin").read_bytes() == b"graph-bytes"
    assert (output_dir / "paris-graph.bin.gz").is_file()
    assert gzip.decompress((output_dir / "paris-graph.bin.gz").read_bytes()) == b"graph-bytes"
    assert (output_dir / "paris-graph-summary.json").is_file()
    assert manifest == {
        "locations": [
            {
                "id": "paris",
                "name": "Paris",
                "graphFileName": "paris-graph.bin.gz",
                "boundaryFileName": "paris-district-boundaries-canvas.json",
            }
        ]
    }


def test_build_cli_writes_ui_manifest_json_to_stdout(
    tmp_path: Path,
    monkeypatch,
) -> None:
    locations_file = tmp_path / "regions.json"
    locations_file.write_text(
        json.dumps(
            {
                "locations": [
                    {
                        "id": "paris",
                        "name": "Paris",
                        "graphFileName": "paris-graph.bin.gz",
                        "boundaryFileName": "paris-district-boundaries-canvas.json",
                        "locationRelation": 'rel["boundary"="administrative"]["wikidata"="Q90"]',
                        "subdivisionAdminLevel": "9",
                        "subdivisionDiscoveryModes": ["subarea"],
                        "routingQueryScope": "bbox",
                        "routingTileSizeDegrees": 0.25,
                        "epsg": 2154,
                    }
                ]
            }
        ),
        encoding="utf-8",
    )

    captured_specs: list[tuple[str, ...]] = []

    def fake_run_build_pipeline(
        region_specs: list[RegionSpec],
        *,
        input_dir: Path,
        output_dir: Path,
        simplify_boundaries=None,
        export_graph_binary=None,
        stderr=None,
    ) -> dict[str, object]:
        captured_specs.append(tuple(spec.id for spec in region_specs))
        assert input_dir == tmp_path / "input"
        assert output_dir == tmp_path / "output"
        return build_location_manifest(region_specs)

    monkeypatch.setattr(
        "isochrone_pipeline.region_pipeline.run_build_pipeline",
        fake_run_build_pipeline,
    )

    stdout = StringIO()
    stderr = StringIO()
    exit_code = main(
        [
            "build",
            "--locations-file",
            str(locations_file),
            "--only",
            "paris",
            "--input-dir",
            str(tmp_path / "input"),
            "--output-dir",
            str(tmp_path / "output"),
        ],
        stdout=stdout,
        stderr=stderr,
    )

    assert exit_code == 0
    assert captured_specs == [("paris",)]
    assert json.loads(stdout.getvalue()) == {
        "locations": [
            {
                "id": "paris",
                "name": "Paris",
                "graphFileName": "paris-graph.bin.gz",
                "boundaryFileName": "paris-district-boundaries-canvas.json",
            }
        ]
    }


def test_default_regions_config_uses_deterministic_greater_london_relation() -> None:
    specs = load_region_specs(DEFAULT_LOCATIONS_FILE)
    london = next(spec for spec in specs if spec.id == "london")

    assert london.location_relation == 'rel(175342)["name"="Greater London"]["wikidata"="Q84"]'
    assert london.subdivision_admin_level == "8"
    assert london.subdivision_discovery_modes == ("subarea",)
    assert london.routing_query_scope == "bbox"
    assert london.routing_tile_size_degrees == 0.2
    luxembourg = next(spec for spec in specs if spec.id == "luxembourg-country")
    assert luxembourg.routing_query_scope == "bbox"
    assert luxembourg.routing_tile_size_degrees == 0.2


def test_parse_relation_bounds_unions_multiple_matching_relation_bounds() -> None:
    bounds = parse_relation_bounds(
        {
            "elements": [
                {
                    "type": "relation",
                    "id": 1,
                    "bounds": {"minlat": 51.1, "minlon": -0.3, "maxlat": 51.2, "maxlon": -0.2},
                },
                {
                    "type": "relation",
                    "id": 2,
                    "bounds": {"minlat": 51.0, "minlon": -0.4, "maxlat": 51.3, "maxlon": -0.1},
                },
            ]
        }
    )

    assert bounds == (51.0, -0.4, 51.3, -0.1)


def test_run_fetch_pipeline_tiles_routing_extracts_and_merges_duplicate_elements(
    tmp_path: Path,
) -> None:
    input_dir = tmp_path / "input"
    spec = RegionSpec(
        id="london",
        name="London",
        graph_file_name="london-graph.bin.gz",
        boundary_file_name="london-district-boundaries-canvas.json",
        location_relation='rel(175342)["name"="Greater London"]["wikidata"="Q84"]',
        subdivision_admin_level="8",
        subdivision_discovery_modes=("subarea",),
        routing_query_scope="bbox",
        routing_tile_size_degrees=0.2,
        epsg=27700,
        graph_binary_file_name="london-graph.bin",
        graph_summary_file_name="london-graph-summary.json",
        boundary_resolution=25.0,
        boundary_units="meters",
    )

    rendered_bboxes: list[str] = []

    def fake_render_query(query_script: Path, *args: str) -> str:
        if query_script.name == "overpass_routing_query.sh":
            scope_index = args.index("--scope") + 1
            assert args[scope_index] == "bbox"
            bbox_index = args.index("--bbox") + 1
            bbox_text = args[bbox_index]
            rendered_bboxes.append(bbox_text)
            return f"routing:{bbox_text}"
        return "boundary"

    def fake_fetch_overpass_json(
        *,
        query_text: str,
        output_path: Path,
        overpass_url: str,
        max_time_seconds: int,
    ) -> None:
        del overpass_url, max_time_seconds
        if "out bb;" in query_text:
            output_path.write_text(
                json.dumps(
                    {
                        "elements": [
                            {
                                "type": "relation",
                                "id": 175342,
                                "bounds": {
                                    "minlat": 51.0,
                                    "minlon": -0.4,
                                    "maxlat": 51.2,
                                    "maxlon": -0.1,
                                },
                            }
                        ]
                    }
                ),
                encoding="utf-8",
            )
            return
        if query_text == "routing:51.000000,-0.400000,51.200000,-0.200000":
            output_path.write_text(
                json.dumps(
                    {
                        "elements": [
                            {
                                "type": "node",
                                "id": 1,
                                "lat": 51.0,
                                "lon": -0.3,
                                "tags": {"barrier": "gate"},
                            },
                            {
                                "type": "way",
                                "id": 10,
                                "nodes": [1, 2],
                                "tags": {"highway": "residential"},
                            },
                        ]
                    }
                ),
                encoding="utf-8",
            )
            return
        if query_text == "routing:51.000000,-0.200000,51.200000,-0.100000":
            output_path.write_text(
                json.dumps(
                    {
                        "elements": [
                            {"type": "node", "id": 1, "lat": 51.0, "lon": -0.3},
                            {"type": "node", "id": 2, "lat": 51.1, "lon": -0.15},
                            {
                                "type": "way",
                                "id": 11,
                                "nodes": [1, 2],
                                "tags": {"highway": "primary"},
                            },
                        ]
                    }
                ),
                encoding="utf-8",
            )
            return
        if query_text == "boundary":
            output_path.write_text('{"elements": []}\n', encoding="utf-8")
            return
        raise AssertionError(f"unexpected query: {query_text}")

    run_fetch_pipeline(
        [spec],
        input_dir=input_dir,
        overpass_url="https://example.test/api/interpreter",
        max_time_seconds=600,
        render_query_fn=fake_render_query,
        fetch_overpass_json_fn=fake_fetch_overpass_json,
    )

    assert rendered_bboxes == [
        "51.000000,-0.400000,51.200000,-0.200000",
        "51.000000,-0.200000,51.200000,-0.100000",
    ]

    routing_payload = json.loads(
        (input_dir / spec.routing_input_file_name).read_text(encoding="utf-8")
    )
    assert routing_payload["elements"] == [
        {"type": "node", "id": 1, "lat": 51.0, "lon": -0.3, "tags": {"barrier": "gate"}},
        {
            "type": "way",
            "id": 10,
            "nodes": [1, 2],
            "tags": {"highway": "residential"},
        },
        {"type": "node", "id": 2, "lat": 51.1, "lon": -0.15},
        {"type": "way", "id": 11, "nodes": [1, 2], "tags": {"highway": "primary"}},
    ]
    assert (input_dir / spec.boundary_input_file_name).is_file()
