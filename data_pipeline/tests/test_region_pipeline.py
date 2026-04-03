from __future__ import annotations

import gzip
import json
from io import StringIO
from pathlib import Path

from isochrone_pipeline.region_pipeline import (
    RegionSpec,
    build_location_manifest,
    load_region_specs,
    main,
    run_build_pipeline,
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
