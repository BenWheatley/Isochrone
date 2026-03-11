from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
WEB_ROOT = REPO_ROOT / "web"


def test_web_entrypoint_uses_vanilla_module_and_required_shell_elements() -> None:
    index_html = (WEB_ROOT / "index.html").read_text(encoding="utf-8")

    assert 'id="boundaries"' in index_html
    assert 'id="isochrone"' in index_html
    assert 'id="map-region"' in index_html
    assert 'id="canvas-stack"' in index_html
    assert 'id="loading"' in index_html
    assert 'id="loading-text"' in index_html
    assert 'id="loading-progress-bar"' in index_html
    assert 'id="routing-status"' in index_html
    assert 'id="render-backend-badge"' in index_html
    assert 'id="routing-disclaimer"' in index_html
    assert 'id="mode-select"' in index_html
    assert 'id="colour-cycle-minutes"' in index_html
    assert 'id="isochrone-legend"' in index_html
    assert 'id="distance-scale"' in index_html
    assert 'id="distance-scale-line"' in index_html
    assert 'id="distance-scale-label"' in index_html
    assert '<script type="module" src="./src/app.js"></script>' in index_html


def test_web_defaults_reference_pipeline_outputs() -> None:
    constants_js = (WEB_ROOT / "src" / "config" / "constants.js").read_text(encoding="utf-8")
    app_js = (WEB_ROOT / "src" / "app.js").read_text(encoding="utf-8")

    assert "DEFAULT_BOUNDARY_BASEMAP_URL" in constants_js
    assert "DEFAULT_GRAPH_BINARY_URL" in constants_js
    assert "../data_pipeline/output/berlin-district-boundaries-canvas.json" in constants_js
    assert "../data_pipeline/output/graph-walk.bin.gz" in constants_js
    assert "DEFAULT_BOUNDARY_BASEMAP_URL" in app_js
    assert "DEFAULT_GRAPH_BINARY_URL" in app_js


def test_quality_gates_include_js_lint_and_runtime_tests() -> None:
    package_json = (REPO_ROOT / "package.json").read_text(encoding="utf-8")
    makefile = (REPO_ROOT / "Makefile").read_text(encoding="utf-8")
    ci_workflow = (REPO_ROOT / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")

    assert '"lint:js"' in package_json
    assert '"test:js"' in package_json
    assert "$(NPM) run --silent lint:js" in makefile
    assert "$(NPM) run --silent test:js" in makefile
    assert "npm run --silent lint:js" in ci_workflow
    assert "npm run --silent test:js" in ci_workflow
