import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
WEB_ROOT = REPO_ROOT / "web"


def test_index_html_uses_native_module_entrypoint() -> None:
    index_html = (WEB_ROOT / "index.html").read_text(encoding="utf-8")

    assert 'id="boundaries"' in index_html
    assert 'id="map"' in index_html
    assert 'id="loading"' in index_html
    assert "dist/app.js" not in index_html
    assert re.search(
        r'<script[^>]*type="module"[^>]*src="\./src/app\.js"',
        index_html,
        flags=re.IGNORECASE,
    )


def test_web_directory_has_no_node_toolchain_files() -> None:
    assert not (REPO_ROOT / ".prettierrc.json").exists()
    assert not (WEB_ROOT / "package.json").exists()
    assert not (WEB_ROOT / "package-lock.json").exists()
    assert not (WEB_ROOT / "eslint.config.js").exists()
    assert not (WEB_ROOT / "tests").exists()


def test_app_js_has_zero_size_canvas_guard_and_binary_loader_contract() -> None:
    app_js = (WEB_ROOT / "src" / "app.js").read_text(encoding="utf-8")

    assert "if (width < 2 || height < 2)" in app_js
    assert "DEFAULT_GRAPH_BINARY_URL" in app_js
    assert "response.body.getReader()" in app_js
    assert "Content-Length" in app_js
    assert "new DataView(buffer)" in app_js
    assert "getUint32(0, true)" in app_js
    assert "Loading graph:" in app_js


def test_app_js_has_pixel_grid_contract() -> None:
    app_js = (WEB_ROOT / "src" / "app.js").read_text(encoding="utf-8")

    assert "export function createPixelGrid(" in app_js
    assert "new Uint8ClampedArray(widthPx * heightPx * 4)" in app_js
    assert "export function clearGrid(" in app_js
    assert "for (let i = 3; i < pixelGrid.rgba.length; i += 4)" in app_js
    assert "export function setPixel(" in app_js
    assert (
        "if (xPx < 0 || yPx < 0 || xPx >= pixelGrid.widthPx || yPx >= pixelGrid.heightPx)" in app_js
    )


def test_app_js_has_node_pixel_index_contract() -> None:
    app_js = (WEB_ROOT / "src" / "app.js").read_text(encoding="utf-8")

    assert "export function precomputeNodePixelCoordinates(" in app_js
    assert "const nodePixelX = new Uint16Array(graph.header.nNodes);" in app_js
    assert "const nodePixelY = new Uint16Array(graph.header.nNodes);" in app_js
    assert "const xM = graph.nodeI32[nodeIndex * 4];" in app_js
    assert "const yM = graph.nodeI32[nodeIndex * 4 + 1];" in app_js
    assert "const pxX = Math.floor(xM / pixelSizeM);" in app_js
    assert "const pxY = Math.floor(yM / pixelSizeM);" in app_js
    assert "const nodePixels = precomputeNodePixelCoordinates(graph);" in app_js


def test_app_js_has_time_to_colour_contract() -> None:
    app_js = (WEB_ROOT / "src" / "app.js").read_text(encoding="utf-8")

    assert "export function timeToColour(seconds)" in app_js
    assert "const minutes = seconds / 60;" in app_js
    assert "if (minutes <= 5)" in app_js
    assert "if (minutes <= 15)" in app_js
    assert "if (minutes <= 30)" in app_js
    assert "if (minutes <= 45)" in app_js
    assert "return [32, 163, 78];" in app_js
    assert "return [214, 201, 37];" in app_js
    assert "return [230, 138, 43];" in app_js
    assert "return [210, 58, 54];" in app_js


def test_app_js_has_reachable_paint_and_blit_contract() -> None:
    app_js = (WEB_ROOT / "src" / "app.js").read_text(encoding="utf-8")

    assert "export function paintReachableNodesToGrid(" in app_js
    assert "const alpha = options.alpha ?? 180;" in app_js
    assert "if (distSeconds[nodeIndex] < Infinity)" in app_js
    assert "const [r, g, b] = timeToColour(distSeconds[nodeIndex]);" in app_js
    assert "setPixel(pixelGrid, xPx, yPx, r, g, b, alpha)" in app_js
    assert "export function blitPixelGridToCanvas(" in app_js
    assert (
        "const imageData = new ImageData(pixelGrid.rgba, pixelGrid.widthPx, pixelGrid.heightPx);"
        in app_js
    )
    assert "context.putImageData(imageData, 0, 0);" in app_js


def test_styles_prevent_zero_height_map_region() -> None:
    styles_css = (WEB_ROOT / "src" / "styles.css").read_text(encoding="utf-8")

    assert ".app-shell" in styles_css
    assert "height: 100vh;" in styles_css
    assert ".map-region" in styles_css
    assert "min-height: 16rem;" in styles_css
