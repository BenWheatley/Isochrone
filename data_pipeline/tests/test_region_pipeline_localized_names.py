from __future__ import annotations

import json
from pathlib import Path

from isochrone_pipeline.region_pipeline import (
    RegionSpec,
    build_location_manifest,
    load_region_specs,
)


def test_load_region_specs_reads_optional_localized_names(tmp_path: Path) -> None:
    locations_file = tmp_path / "regions.json"
    locations_file.write_text(
        json.dumps(
            {
                "locations": [
                    {
                        "id": "cologne",
                        "name": "Cologne",
                        "localizedNames": {
                            "de": "Köln",
                            "fr": "Cologne",
                        },
                        "graphFileName": "cologne-graph.bin.gz",
                        "boundaryFileName": "cologne-district-boundaries-canvas.json",
                        "locationRelation": 'rel["boundary"="administrative"]["wikidata"="Q365"]',
                        "subdivisionAdminLevel": "9",
                        "epsg": 25832,
                    }
                ]
            }
        ),
        encoding="utf-8",
    )

    specs = load_region_specs(locations_file)

    assert specs == (
        RegionSpec(
            id="cologne",
            name="Cologne",
            localized_names={"de": "Köln", "fr": "Cologne"},
            graph_file_name="cologne-graph.bin.gz",
            boundary_file_name="cologne-district-boundaries-canvas.json",
            location_relation='rel["boundary"="administrative"]["wikidata"="Q365"]',
            subdivision_admin_level="9",
            subdivision_discovery_modes=("area", "subarea"),
            epsg=25832,
            graph_binary_file_name="cologne-graph.bin",
            graph_summary_file_name="cologne-graph-summary.json",
            boundary_resolution=25.0,
            boundary_units="meters",
        ),
    )


def test_build_location_manifest_preserves_localized_names() -> None:
    manifest = build_location_manifest(
        [
            RegionSpec(
                id="cologne",
                name="Cologne",
                localized_names={"de": "Köln", "fr": "Cologne"},
                graph_file_name="cologne-graph.bin.gz",
                boundary_file_name="cologne-district-boundaries-canvas.json",
                location_relation='rel["boundary"="administrative"]["wikidata"="Q365"]',
                subdivision_admin_level="9",
                subdivision_discovery_modes=("area", "subarea"),
                epsg=25832,
                graph_binary_file_name="cologne-graph.bin",
                graph_summary_file_name="cologne-graph-summary.json",
                boundary_resolution=25.0,
                boundary_units="meters",
            )
        ]
    )

    assert manifest == {
        "locations": [
            {
                "id": "cologne",
                "name": "Cologne",
                "localizedNames": {
                    "de": "Köln",
                    "fr": "Cologne",
                },
                "graphFileName": "cologne-graph.bin.gz",
                "boundaryFileName": "cologne-district-boundaries-canvas.json",
            }
        ]
    }
