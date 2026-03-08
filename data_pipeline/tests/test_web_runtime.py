import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
WEB_ROOT = REPO_ROOT / "web"


def test_index_html_uses_native_module_entrypoint() -> None:
    index_html = (WEB_ROOT / "index.html").read_text(encoding="utf-8")

    assert 'id="boundaries"' in index_html
    assert 'id="isochrone"' in index_html
    assert 'id="loading"' in index_html
    assert 'id="loading-text"' in index_html
    assert 'id="loading-progress"' in index_html
    assert 'id="loading-progress-bar"' in index_html
    assert 'id="routing-status"' in index_html
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


def test_app_js_uses_isochrone_canvas_layer() -> None:
    app_js = (WEB_ROOT / "src" / "app.js").read_text(encoding="utf-8")

    assert "getElementById('isochrone')" in app_js
    assert "shell.isochroneCanvas" in app_js
    assert "blitPixelGridToCanvas(shell.isochroneCanvas, mapData.pixelGrid);" in app_js


def test_app_js_has_loading_progress_bar_and_fade_contract() -> None:
    app_js = (WEB_ROOT / "src" / "app.js").read_text(encoding="utf-8")

    assert "loading-progress-bar" in app_js
    assert "Loading graph:" in app_js
    assert "progressPercent" in app_js
    assert "style.width" in app_js
    assert "classList.add('is-fading')" in app_js
    assert "showLoadingOverlay(shell, 'Initialization failed.', 0);" in app_js


def test_app_js_has_time_sliced_search_contract() -> None:
    app_js = (WEB_ROOT / "src" / "app.js").read_text(encoding="utf-8")

    assert "export async function runSearchTimeSliced(" in app_js
    assert "const sliceBudgetMs = options.sliceBudgetMs ?? 8;" in app_js
    assert "const requestAnimationFrameImpl = options.requestAnimationFrameImpl" in app_js
    assert "while (!isDone(searchState))" in app_js
    assert "while (elapsedMs < sliceBudgetMs && !isDone(searchState))" in app_js
    assert "onSlice(settledBatch);" in app_js
    assert "await waitForAnimationFrame(requestAnimationFrameImpl);" in app_js
    assert "export async function runSearchTimeSlicedWithRendering(" in app_js
    assert "paintSettledBatchToGrid(" in app_js
    assert "blitPixelGridToCanvas(shell.isochroneCanvas, mapData.pixelGrid);" in app_js


def test_app_js_has_routing_status_text_contract() -> None:
    app_js = (WEB_ROOT / "src" / "app.js").read_text(encoding="utf-8")

    assert "getElementById('routing-status')" in app_js
    assert "export function formatRoutingStatusCalculating(" in app_js
    assert "Calculating..." in app_js
    assert "nodes settled" in app_js
    assert "export function formatRoutingStatusDone(" in app_js
    assert "Done - reachable area for" in app_js
    assert "setRoutingStatus(shell, formatRoutingStatusCalculating(0));" in app_js
    assert "setRoutingStatus(shell, formatRoutingStatusDone(doneMinutes));" in app_js


def test_app_js_has_min_heap_contract() -> None:
    app_js = (WEB_ROOT / "src" / "app.js").read_text(encoding="utf-8")

    assert "export class MinHeap" in app_js
    assert "this.costs = new Float64Array(" in app_js
    assert "this.nodeIndices = new Int32Array(" in app_js
    assert "this.positionLookup = new Int32Array(" in app_js
    assert "push(nodeIndex, cost)" in app_js
    assert "pop()" in app_js
    assert "decreaseKey(nodeIndex, newCost)" in app_js
    assert "runMinHeapSelfTest" in app_js
    assert "for (let i = 0; i < 1000; i += 1)" in app_js


def test_app_js_has_walking_dijkstra_contract() -> None:
    app_js = (WEB_ROOT / "src" / "app.js").read_text(encoding="utf-8")

    assert "export function createWalkingSearchState(" in app_js
    assert "const distSeconds = new Float32Array(graph.header.nNodes);" in app_js
    assert "distSeconds.fill(Infinity);" in app_js
    assert "const settled = new Uint8Array(graph.header.nNodes);" in app_js
    assert "heap.push(sourceNodeIndex, 0);" in app_js
    assert "if (cost > timeLimitSeconds)" in app_js
    assert "if (nextCost < distSeconds[targetIndex])" in app_js
    assert "heap.decreaseKey(targetIndex, nextCost);" in app_js
    assert "export function findNearestNodeIndex(" in app_js
    assert "const dx = nodeXM - xM;" in app_js
    assert "const dy = nodeYM - yM;" in app_js
    assert "export async function runWalkingIsochroneFromSourceNode(" in app_js
    assert "runSearchTimeSlicedWithRendering(" in app_js


def test_styles_prevent_zero_height_map_region() -> None:
    styles_css = (WEB_ROOT / "src" / "styles.css").read_text(encoding="utf-8")

    assert ".app-shell" in styles_css
    assert "height: 100vh;" in styles_css
    assert ".map-region" in styles_css
    assert "min-height: 16rem;" in styles_css
    assert "#loading-progress" in styles_css
    assert "#loading-progress-bar" in styles_css
    assert "#loading.is-fading" in styles_css
    assert "#routing-status" in styles_css
