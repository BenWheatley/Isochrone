from pathlib import Path

from isochrone_pipeline.artifacts import write_graph_binary_artifacts


def _write_fixture(path: Path) -> None:
    path.write_text(
        """
{
  "version": 0.6,
  "elements": [
    {"type": "node", "id": 1, "lat": 52.5, "lon": 13.4},
    {"type": "node", "id": 2, "lat": 52.5001, "lon": 13.401},
    {"type": "node", "id": 20, "lat": 52.51, "lon": 13.41},
    {"type": "node", "id": 21, "lat": 52.511, "lon": 13.411},
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
      "tags": {"route": "ferry", "foot": "yes"}
    }
  ]
}
""".strip(),
        encoding="utf-8",
    )


def test_write_graph_binary_artifacts_reports_water_edge_counts(tmp_path: Path) -> None:
    source = tmp_path / "routing.json"
    _write_fixture(source)
    binary_output = tmp_path / "graph.bin"
    summary_output = tmp_path / "graph-summary.json"

    summary = write_graph_binary_artifacts(
        input_path=source,
        binary_output=binary_output,
        summary_output=summary_output,
        epsg=25833,
    )

    assert summary["edge_mode_counts"]["water"] == 2
    assert summary["edge_mode_counts"]["walk"] >= 2
    assert summary["edge_mode_coverage_ratio"]["water"] > 0.0
