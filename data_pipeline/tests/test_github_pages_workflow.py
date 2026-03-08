from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
PAGES_WORKFLOW = REPO_ROOT / ".github" / "workflows" / "pages.yml"


def test_pages_workflow_exists() -> None:
    assert PAGES_WORKFLOW.exists()


def test_pages_workflow_uses_actions_pages_flow() -> None:
    workflow = PAGES_WORKFLOW.read_text(encoding="utf-8")

    assert "workflow_dispatch:" in workflow
    assert "actions/configure-pages@v5" in workflow
    assert "actions/upload-pages-artifact@v3" in workflow
    assert "actions/deploy-pages@v4" in workflow


def test_pages_workflow_packages_required_runtime_files() -> None:
    workflow = PAGES_WORKFLOW.read_text(encoding="utf-8")

    assert "cp web/index.html site/index.html" in workflow
    assert "cp -R web/src/. site/src/" in workflow
    assert (
        "cp data_pipeline/output/berlin-district-boundaries-canvas.json site/data_pipeline/output/"
    ) in workflow
    assert "cp data_pipeline/output/graph-walk.bin.gz site/data_pipeline/output/" in workflow
