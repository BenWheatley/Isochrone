from __future__ import annotations

import gzip
import json
import subprocess
from io import StringIO
from pathlib import Path

from isochrone_pipeline.region_pipeline import (
    DEFAULT_LOCATIONS_FILE,
    RegionSpec,
    build_location_manifest,
    fetch_overpass_json,
    load_region_specs,
    main,
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


def test_run_fetch_pipeline_logs_rendered_queries_before_fetching(
    tmp_path: Path,
) -> None:
    input_dir = tmp_path / "input"
    stderr = StringIO()
    fetch_calls: list[tuple[str, Path]] = []

    spec = RegionSpec(
        id="paris",
        name="Paris",
        graph_file_name="paris-graph.bin.gz",
        boundary_file_name="paris-district-boundaries-canvas.json",
        location_relation='rel["boundary"="administrative"]["wikidata"="Q90"]',
        subdivision_admin_level="9",
        subdivision_discovery_modes=("area", "subarea"),
        epsg=2154,
        graph_binary_file_name="paris-graph.bin",
        graph_summary_file_name="paris-graph-summary.json",
        boundary_resolution=25.0,
        boundary_units="meters",
    )

    def fake_render_query(query_script: Path, *args: str) -> str:
        return f"/* {query_script.name} */\n" + " ".join(args) + "\n"

    def fake_fetch_overpass_json(
        *,
        query_text: str,
        output_path: Path,
        overpass_url: str,
        max_time_seconds: int,
        stderr=None,
        request_label: str | None = None,
    ) -> None:
        del overpass_url, max_time_seconds, stderr
        current_logs = stderr_buffer.getvalue()
        assert query_text in current_logs
        assert str(output_path) in current_logs
        assert request_label is not None
        fetch_calls.append((request_label, output_path))

    stderr_buffer = stderr
    run_fetch_pipeline(
        [spec],
        input_dir=input_dir,
        overpass_url="https://overpass.example/api/interpreter",
        max_time_seconds=600,
        render_query_fn=fake_render_query,
        fetch_overpass_json_fn=fake_fetch_overpass_json,
        stderr=stderr,
    )

    log_text = stderr.getvalue()
    assert "Rendered routing query for Paris" in log_text
    assert "Rendered boundary query for Paris" in log_text
    assert "Overpass URL: https://overpass.example/api/interpreter" in log_text
    assert "Output path: " + str(input_dir / "paris-routing.osm.json") in log_text
    assert "Output path: " + str(input_dir / "paris-district-boundaries.osm.json") in log_text
    assert fetch_calls == [
        ("routing extract for Paris", input_dir / "paris-routing.osm.json"),
        ("boundary extract for Paris", input_dir / "paris-district-boundaries.osm.json"),
    ]


def test_fetch_overpass_json_failure_writes_debug_bundle(tmp_path: Path, monkeypatch) -> None:
    output_path = tmp_path / "london-routing.osm.json"
    stderr = StringIO()

    def fake_run(
        args: list[str],
        *,
        check: bool,
        text: bool,
        capture_output: bool,
    ) -> subprocess.CompletedProcess[str]:
        del check, text, capture_output
        output_arg_index = args.index("-o") + 1
        Path(args[output_arg_index]).write_text('{"remark":"gateway timeout"}\n', encoding="utf-8")
        header_arg_index = args.index("--dump-header") + 1
        Path(args[header_arg_index]).write_text(
            "HTTP/1.1 504 Gateway Timeout\nContent-Type: application/json\n",
            encoding="utf-8",
        )
        return subprocess.CompletedProcess(
            args=args,
            returncode=0,
            stdout="504",
            stderr="",
        )

    monkeypatch.setattr("isochrone_pipeline.region_pipeline.subprocess.run", fake_run)

    try:
        fetch_overpass_json(
            query_text='[out:json];way["highway"](0,0,1,1);out body qt;',
            output_path=output_path,
            overpass_url="https://overpass.example/api/interpreter",
            max_time_seconds=600,
            stderr=stderr,
            request_label="routing extract for London",
        )
    except RuntimeError as exc:
        message = str(exc)
    else:
        raise AssertionError("expected fetch_overpass_json to fail")

    assert "routing extract for London" in message
    assert "curl_exit_code=0" in message
    assert "http_status=504" in message
    assert "https://overpass.example/api/interpreter" in message
    assert str(output_path) in message
    assert str(output_path.with_name("london-routing.osm.json.failed-query.ql")) in message
    assert str(output_path.with_name("london-routing.osm.json.failed-response-body.txt")) in message
    assert (
        str(output_path.with_name("london-routing.osm.json.failed-response-headers.txt")) in message
    )
    assert (
        output_path.with_name("london-routing.osm.json.failed-query.ql").read_text(encoding="utf-8")
        == '[out:json];way["highway"](0,0,1,1);out body qt;'
    )
    assert (
        output_path.with_name("london-routing.osm.json.failed-curl-stderr.txt").read_text(
            encoding="utf-8"
        )
        == ""
    )
    assert (
        output_path.with_name("london-routing.osm.json.failed-response-body.txt").read_text(
            encoding="utf-8"
        )
        == '{"remark":"gateway timeout"}\n'
    )
    assert (
        output_path.with_name("london-routing.osm.json.failed-response-headers.txt").read_text(
            encoding="utf-8"
        )
        == "HTTP/1.1 504 Gateway Timeout\nContent-Type: application/json\n"
    )
    assert not output_path.exists()
    assert "Rendered routing extract for London" in stderr.getvalue()
