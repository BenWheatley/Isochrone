from __future__ import annotations

import json
import os
import stat
import subprocess
import sys
from pathlib import Path

from isochrone_pipeline.region_pipeline import render_query

REPO_ROOT = Path(__file__).resolve().parents[2]
DOCS_ROOT = REPO_ROOT / "docs"
PIPELINE_ROOT = REPO_ROOT / "data_pipeline"


def _run_shell_script(
    script_path: Path,
    *args: str,
    env: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["bash", str(script_path), *args],
        check=False,
        capture_output=True,
        text=True,
        cwd=REPO_ROOT,
        env=env,
    )


def _run_python_script(
    script_path: Path,
    *args: str,
    env: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(script_path), *args],
        check=False,
        capture_output=True,
        text=True,
        cwd=REPO_ROOT,
        env=env,
    )


def test_region_pipeline_render_query_uses_bash_interpreter(monkeypatch, tmp_path: Path) -> None:
    script_path = tmp_path / "query.ql"
    script_path.write_text("#!/bin/sh\necho ok\n", encoding="utf-8")

    calls: list[list[str]] = []

    def fake_run(
        args: list[str],
        *,
        check: bool,
        capture_output: bool,
        text: bool,
    ) -> subprocess.CompletedProcess[str]:
        del check, capture_output, text
        calls.append(args)
        return subprocess.CompletedProcess(args, 0, stdout="ok\n", stderr="")

    monkeypatch.setattr("isochrone_pipeline.region_pipeline.shutil.which", lambda name: "/bin/bash")
    monkeypatch.setattr("isochrone_pipeline.region_pipeline.subprocess.run", fake_run)

    assert render_query(script_path) == "ok\n"
    assert calls == [["/bin/bash", str(script_path)]]


def test_routing_query_script_renders_location_selector() -> None:
    script_path = DOCS_ROOT / "overpass_routing_query.sh"
    result = _run_shell_script(
        script_path,
        "--location-label",
        "Paris",
        "--location-relation",
        'rel["boundary"="administrative"]["wikidata"="Q90"]',
    )

    assert result.returncode == 0, result.stderr
    assert "Paris routing-focused OSM extraction" in result.stdout
    assert 'rel["boundary"="administrative"]["wikidata"="Q90"]->.placeRel;' in result.stdout
    assert ".placeRel map_to_area->.searchArea;" in result.stdout
    assert 'way(area.searchArea)["highway"];' in result.stdout


def test_routing_query_script_can_scope_extract_to_bbox_tile() -> None:
    script_path = DOCS_ROOT / "overpass_routing_query.sh"
    result = _run_shell_script(
        script_path,
        "--location-label",
        "London",
        "--location-relation",
        'rel["boundary"="administrative"]["wikidata"="Q23306"]',
        "--bbox",
        "51.000000,-0.400000,51.200000,-0.200000",
    )

    assert result.returncode == 0, result.stderr
    assert (
        'way(area.searchArea)(51.000000,-0.400000,51.200000,-0.200000)["highway"];' in result.stdout
    )
    assert (
        'node(area.searchArea)(51.000000,-0.400000,51.200000,-0.200000)["barrier"];'
        in result.stdout
    )


def test_boundary_query_script_renders_location_selector_and_admin_level() -> None:
    script_path = DOCS_ROOT / "overpass_boundary_query.sh"
    result = _run_shell_script(
        script_path,
        "--location-label",
        "Luxembourg (country)",
        "--location-relation",
        'rel["boundary"="administrative"]["wikidata"="Q32"]',
        "--subdivision-admin-level",
        "8",
    )

    assert result.returncode == 0, result.stderr
    assert "Luxembourg (country) subdivision boundaries" in result.stdout
    assert 'rel["boundary"="administrative"]["wikidata"="Q32"]->.placeRel;' in result.stdout
    assert ".placeRel map_to_area->.placeArea;" in result.stdout
    assert 'rel(r.placeRel:"subarea")' in result.stdout
    assert '["admin_level"="8"];' in result.stdout
    assert ")->.subdivisions;" in result.stdout
    assert "out body qt;" in result.stdout
    assert "out skel qt;" in result.stdout
    assert '["type"="boundary"]' not in result.stdout


def test_boundary_query_script_can_use_subarea_only_discovery_mode() -> None:
    script_path = DOCS_ROOT / "overpass_boundary_query.sh"
    result = _run_shell_script(
        script_path,
        "--location-label",
        "London",
        "--location-relation",
        'rel(175342)["name"="Greater London"]["wikidata"="Q84"]',
        "--subdivision-admin-level",
        "8",
        "--subdivision-discovery-modes",
        "subarea",
    )

    assert result.returncode == 0, result.stderr
    assert ".placeRel map_to_area->.placeArea;" not in result.stdout
    assert "rel(area.placeArea)" not in result.stdout
    assert 'rel(r.placeRel:"subarea")' in result.stdout


def test_region_data_fetch_command_fetches_selected_locations_from_external_config(
    tmp_path: Path,
) -> None:
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    fake_curl = fake_bin / "curl"
    fake_log = tmp_path / "curl.log"
    fake_curl.write_text(
        "#!/bin/sh\n"
        "set -eu\n"
        'output=""\n'
        'while [ "$#" -gt 0 ]; do\n'
        '  case "$1" in\n'
        "    -o)\n"
        '      output="$2"\n'
        "      shift 2\n"
        "      ;;\n"
        "    *)\n"
        "      shift\n"
        "      ;;\n"
        "  esac\n"
        "done\n"
        'if [ -z "$output" ]; then\n'
        '  echo "missing output path" >&2\n'
        "  exit 1\n"
        "fi\n"
        'mkdir -p "$(dirname "$output")"\n'
        'printf \'{"elements": []}\\n\' > "$output"\n'
        f"printf 'OUTPUT=%s\\n' \"$output\" >> {str(fake_log)!r}\n",
        encoding="utf-8",
    )
    fake_curl.chmod(fake_curl.stat().st_mode | stat.S_IXUSR)

    locations_file = tmp_path / "regions.json"
    locations_file.write_text(
        json.dumps(
            {
                "locations": [
                    {
                        "id": "berlin",
                        "name": "Berlin",
                        "graphFileName": "graph-walk.bin.gz",
                        "boundaryFileName": "berlin-district-boundaries-canvas.json",
                        "locationRelation": 'rel(62422)["name"="Berlin"]["wikidata"="Q64"]',
                        "subdivisionAdminLevel": "9",
                        "epsg": 25833,
                    },
                    {
                        "id": "paris",
                        "name": "Paris",
                        "graphFileName": "paris-graph.bin.gz",
                        "boundaryFileName": "paris-district-boundaries-canvas.json",
                        "locationRelation": 'rel["boundary"="administrative"]["wikidata"="Q90"]',
                        "subdivisionAdminLevel": "9",
                        "epsg": 2154,
                    },
                ]
            }
        ),
        encoding="utf-8",
    )

    input_dir = tmp_path / "input"
    env = os.environ.copy()
    env["PATH"] = f"{fake_bin}:{env['PATH']}"
    env["ISOCHRONE_TESTS_ALLOW_SUBPROCESS_PATHS"] = str(fake_curl)
    result = _run_python_script(
        PIPELINE_ROOT / "region-data.py",
        "fetch",
        "--locations-file",
        str(locations_file),
        "--input-dir",
        str(input_dir),
        "--only",
        "paris",
        env=env,
    )

    assert result.returncode == 0, result.stderr

    expected_outputs = [
        input_dir / "paris-routing.osm.json",
        input_dir / "paris-district-boundaries.osm.json",
    ]

    for output_path in expected_outputs:
        assert output_path.is_file(), f"missing output: {output_path}"

    logged_outputs = [
        line.removeprefix("OUTPUT=").strip()
        for line in fake_log.read_text(encoding="utf-8").splitlines()
        if line.startswith("OUTPUT=")
    ]
    assert len(logged_outputs) == 2
    assert all(Path(path).name.startswith("overpass-response-") for path in logged_outputs)
    assert all(Path(path).suffix == ".tmp" for path in logged_outputs)
