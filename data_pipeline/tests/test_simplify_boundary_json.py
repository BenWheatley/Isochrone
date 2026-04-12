from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from types import ModuleType

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = REPO_ROOT / "data_pipeline" / "scripts" / "simplify_boundary_json.py"


def load_simplify_boundary_json_module() -> ModuleType:
    spec = importlib.util.spec_from_file_location("simplify_boundary_json_script", SCRIPT_PATH)
    assert spec is not None
    assert spec.loader is not None

    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_main_passes_include_coast_and_source_to_artifact_writer(
    monkeypatch,
    tmp_path: Path,
    capsys,
) -> None:
    module = load_simplify_boundary_json_module()
    input_path = tmp_path / "boundaries.osm.json"
    output_path = tmp_path / "boundaries-canvas.json"
    coast_source = tmp_path / "water-polygons.zip"
    input_path.write_text('{"elements":[]}', encoding="utf-8")

    recorded: dict[str, object] = {}

    def fake_write_simplified_boundary_canvas(**kwargs):
        recorded.update(kwargs)
        return {
            "stats": {
                "feature_count": 1,
                "path_count": 2,
                "input_point_count": 10,
                "output_point_count": 8,
                "water_feature_count": 1,
                "water_path_count": 1,
            }
        }

    monkeypatch.setattr(
        module,
        "write_simplified_boundary_canvas",
        fake_write_simplified_boundary_canvas,
    )
    monkeypatch.setattr(
        sys,
        "argv",
        [
            str(SCRIPT_PATH),
            "--input",
            str(input_path),
            "--output",
            str(output_path),
            "--resolution",
            "25",
            "--units",
            "meters",
            "--include-coast",
            "--coast-source",
            str(coast_source),
        ],
    )

    assert module.main() == 0

    assert recorded["input_path"] == input_path
    assert recorded["output_path"] == output_path
    assert recorded["include_coast"] is True
    assert recorded["coast_source"] == coast_source

    stdout = capsys.readouterr().out
    assert f"Wrote {output_path}" in stdout
    assert "water_feature_count=1" in stdout
    assert "water_path_count=1" in stdout
