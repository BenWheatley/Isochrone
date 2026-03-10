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
    assert 'id="render-backend-badge"' in index_html
    assert 'id="routing-disclaimer"' in index_html
    assert "OSM data can include isolated disconnected route segments." in index_html
    assert 'id="map-region"' in index_html
    assert 'id="canvas-stack"' in index_html
    assert 'id="mode-select"' in index_html
    assert 'id="mode-select" name="mode-select" multiple' in index_html
    assert 'id="colour-cycle-minutes"' in index_html
    assert 'id="distance-scale"' in index_html
    assert 'id="distance-scale-line"' in index_html
    assert 'id="distance-scale-label"' in index_html
    assert 'id="isochrone-legend"' in index_html
    assert '<option value="walk">Walk</option>' in index_html
    assert '<option value="bike">Bike</option>' in index_html
    assert '<option value="car" selected>Car</option>' in index_html
    assert "dist/app.js" not in index_html
    assert re.search(
        r'<link[^>]*rel="stylesheet"[^>]*href="\./src/styles\.css"',
        index_html,
        flags=re.IGNORECASE,
    )
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
    assert "../data_pipeline/output/graph-walk.bin.gz" in app_js
    assert "response.body.getReader()" in app_js
    assert "Content-Length" in app_js
    assert "new DataView(buffer)" in app_js
    assert "supported graph binary versions" in app_js
    assert "getUint32(0, true)" in app_js
    assert "Loading graph:" in app_js


def test_app_js_default_asset_urls_are_relative_and_deploy_safe() -> None:
    app_js = (WEB_ROOT / "src" / "app.js").read_text(encoding="utf-8")

    assert "DEFAULT_BOUNDARY_BASEMAP_URL" in app_js
    assert "DEFAULT_GRAPH_BINARY_URL" in app_js
    assert "../data_pipeline/output/berlin-district-boundaries-canvas.json" in app_js
    assert "../data_pipeline/output/graph-walk.bin.gz" in app_js
    assert "http://" not in app_js
    assert "https://" not in app_js


def test_app_js_has_gzip_binary_loader_contract() -> None:
    app_js = (WEB_ROOT / "src" / "app.js").read_text(encoding="utf-8")

    assert "export async function maybeDecompressGzipBuffer(" in app_js
    assert "bytes[0] === 0x1f && bytes[1] === 0x8b && bytes[2] === 0x08" in app_js
    assert "new DecompressionStream('gzip')" in app_js
    assert "const binaryBuffer = await maybeDecompressGzipBuffer(buffer);" in app_js
    assert "const graph = parseGraphBinary(binaryBuffer);" in app_js


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
    assert "const yCellsFromSouth = Math.floor(yM / pixelSizeM);" in app_js
    assert "const pxY = maxY - yCellsFromSouth;" in app_js
    assert "export function precomputeNodeModeMask(" in app_js
    assert "const nodeModeMask = new Uint8Array(graph.header.nNodes);" in app_js
    assert "export function createNodeSpatialIndex(" in app_js
    assert "const cellNodeHead = new Int32Array(cellCount);" in app_js
    assert "const nextNodeInCell = new Int32Array(graph.header.nNodes);" in app_js
    assert "const nodePixels = precomputeNodePixelCoordinates(graph);" in app_js
    assert "const nodeModeMask = precomputeNodeModeMask(graph);" in app_js
    assert "const nodeSpatialIndex = createNodeSpatialIndex(graph, nodePixels);" in app_js


def test_app_js_has_time_to_colour_contract() -> None:
    app_js = (WEB_ROOT / "src" / "app.js").read_text(encoding="utf-8")

    assert "export function timeToColour(seconds, options = {})" in app_js
    assert "const cycleMinutes = options.cycleMinutes ?? DEFAULT_COLOUR_CYCLE_MINUTES;" in app_js
    assert "const cyclePositionMinutes = (seconds / 60) % cycleMinutes;" in app_js
    assert "const cycleRatio = cyclePositionMinutes / cycleMinutes;" in app_js
    assert "if (cycleRatio <= 5 / 60)" in app_js
    assert "if (cycleRatio <= 15 / 60)" in app_js
    assert "if (cycleRatio <= 30 / 60)" in app_js
    assert "if (cycleRatio <= 45 / 60)" in app_js
    assert "return [0, 255, 255];" in app_js
    assert "return [64, 255, 64];" in app_js
    assert "return [255, 255, 64];" in app_js
    assert "return [255, 140, 0];" in app_js
    assert "return [255, 64, 160];" in app_js


def test_app_js_has_reachable_paint_and_blit_contract() -> None:
    app_js = (WEB_ROOT / "src" / "app.js").read_text(encoding="utf-8")

    assert "export function paintReachableNodesToGrid(" in app_js
    assert "const alpha = options.alpha ?? 255;" in app_js
    assert "if (distSeconds[nodeIndex] < Infinity)" in app_js
    assert (
        "const [r, g, b] = timeToColour("
        "distSeconds[nodeIndex], { cycleMinutes: colourCycleMinutes });"
    ) in app_js
    assert "setPixel(pixelGrid, xPx, yPx, r, g, b, alpha)" in app_js
    assert "export function blitPixelGridToCanvas(" in app_js
    assert (
        "const imageData = new ImageData(pixelGrid.rgba, pixelGrid.widthPx, pixelGrid.heightPx);"
        in app_js
    )
    assert "context.putImageData(imageData, 0, 0);" in app_js


def test_app_js_has_webgl_blit_renderer_contract() -> None:
    app_js = (WEB_ROOT / "src" / "app.js").read_text(encoding="utf-8")

    assert "export function createWebGlIsochroneRenderer(" in app_js
    assert "const contextWebGl2 = canvas.getContext('webgl2'" in app_js
    assert "const contextWebGl = canvas.getContext('webgl'" in app_js
    assert "if (!gl) {" in app_js
    assert "return null;" in app_js
    assert "gl.texImage2D(" in app_js
    assert "pixelGrid.rgba" in app_js
    assert "gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);" in app_js
    assert "function createCanvas2dIsochroneRenderer(" in app_js
    assert "export function createIsochroneRenderer(" in app_js
    assert "const webglRenderer = createWebGlIsochroneRenderer(canvas, options);" in app_js
    assert "return webglRenderer ?? createCanvas2dIsochroneRenderer(canvas);" in app_js
    assert "function getOrCreateIsochroneRenderer(canvas)" in app_js
    assert "canvas.__isochroneRenderer = renderer;" in app_js
    assert "export function formatRenderBackendBadgeText(" in app_js
    assert "return 'Renderer: WebGL';" in app_js
    assert "return 'Renderer: CPU';" in app_js
    assert "function updateRenderBackendBadge(shell, renderer)" in app_js
    assert "const renderer = getOrCreateIsochroneRenderer(canvas);" in app_js
    assert "renderer.draw(pixelGrid);" in app_js


def test_app_js_has_gpu_travel_time_colourization_contract() -> None:
    app_js = (WEB_ROOT / "src" / "app.js").read_text(encoding="utf-8")

    assert "export function createTravelTimeGrid(" in app_js
    assert "seconds: new Float32Array(widthPx * heightPx)" in app_js
    assert "export function clearTravelTimeGrid(" in app_js
    assert "travelTimeGrid.seconds.fill(-1);" in app_js
    assert "export function setTravelTimePixelMin(" in app_js
    assert "if (currentSeconds < 0 || seconds < currentSeconds)" in app_js
    assert "drawTravelTimeGrid(travelTimeGrid, options = {})" in app_js
    assert "const cycleMinutes = options.cycleMinutes ?? DEFAULT_COLOUR_CYCLE_MINUTES;" in app_js
    assert "supportsGpuTravelTimeRendering" in app_js
    assert "paintSettledBatchEdgeInterpolationsToTravelTimeGrid(" in app_js
    assert "paintSettledBatchTravelTimesToGrid(" in app_js
    assert "paintAllReachableEdgeInterpolationsToTravelTimeGrid(" in app_js
    assert "paintReachableNodesTravelTimesToGrid(" in app_js
    assert "renderer.drawTravelTimeGrid(mapData.travelTimeGrid" in app_js
    assert "drawTravelTimeEdges(edgeVertexData, options = {})" in app_js
    assert "collectSettledBatchTravelTimeEdgeVertices(" in app_js
    assert "collectAllReachableTravelTimeEdgeVertices(" in app_js
    assert "function createEdgeVertexBufferBuilder(" in app_js
    assert "function appendEdgeVertexSegment(" in app_js
    assert "const edgeVertexBuilder = createEdgeVertexBufferBuilder();" in app_js
    assert "builder: edgeVertexBuilder" in app_js
    assert (
        "const supportsGpuEdgeInterpolation = typeof renderer.drawTravelTimeEdges === 'function';"
    ) in app_js
    assert "renderer.drawTravelTimeEdges(batchEdgeVertices," in app_js
    assert "renderer.drawTravelTimeEdges(allEdgeVertices," in app_js
    assert "readPixelsRgba(samplePixels)" in app_js
    assert "export function runGpuCpuParityDiagnostic(" in app_js
    assert "const paritySampleCount = options.gpuParitySampleCount ?? 0;" in app_js
    assert (
        "if (!skipFinalFullPass && supportsGpuEdgeInterpolation && paritySampleCount > 0)" in app_js
    )
    assert "const parityResult = runGpuCpuParityDiagnostic(" in app_js


def test_app_js_has_cpu_interpolation_foundation_contract() -> None:
    app_js = (WEB_ROOT / "src" / "app.js").read_text(encoding="utf-8")

    assert "export function rasterizeLinePixels(" in app_js
    assert "const startX = Math.round(x0);" in app_js
    assert "const endX = Math.round(x1);" in app_js
    assert "visitPixel(x, y);" in app_js
    assert "export function interpolateEdgeTravelSeconds(" in app_js
    assert "const ratio = stepIndex / totalSteps;" in app_js
    assert "return startSeconds + (endSeconds - startSeconds) * ratio;" in app_js
    assert "export function paintInterpolatedEdgeToGrid(" in app_js
    assert "rasterizeLinePixels(x0, y0, x1, y1," in app_js
    assert "const seconds = interpolateEdgeTravelSeconds(" in app_js
    assert (
        "const [r, g, b] = timeToColour(seconds, { cycleMinutes: colourCycleMinutes });" in app_js
    )


def test_app_js_paints_interpolated_edges_during_search_contract() -> None:
    app_js = (WEB_ROOT / "src" / "app.js").read_text(encoding="utf-8")

    assert "const EDGE_INTERPOLATION_SLACK_SECONDS = 0.75;" in app_js
    assert "const INTERACTIVE_EDGE_INTERPOLATION_STEP_STRIDE = 3;" in app_js
    assert "const FINAL_EDGE_INTERPOLATION_STEP_STRIDE = 1;" in app_js
    assert "allowedModeMask," in app_js
    assert "export function paintSettledBatchEdgeInterpolationsToGrid(" in app_js
    assert "export function paintAllReachableEdgeInterpolationsToGrid(" in app_js
    assert "const expectedTargetSeconds = startSeconds + edgeCostSeconds;" in app_js
    assert "if (expectedTargetSeconds > targetSeconds + edgeSlackSeconds)" in app_js
    assert "paintInterpolatedEdgeToGrid(" in app_js
    assert "const stepStride = options.stepStride ?? 1;" in app_js
    assert "if (stepIndex % stepStride !== 0 && stepIndex !== totalSteps)" in app_js
    assert "const allowedModeMask = searchState.allowedModeMask ?? EDGE_MODE_CAR_BIT;" in app_js
    assert "const interactiveEdgeStepStride =" in app_js
    assert (
        "options.interactiveEdgeStepStride ?? INTERACTIVE_EDGE_INTERPOLATION_STEP_STRIDE;" in app_js
    )
    assert (
        "const finalEdgeStepStride = "
        "options.finalEdgeStepStride ?? FINAL_EDGE_INTERPOLATION_STEP_STRIDE;"
    ) in app_js
    assert "paintedEdgeCount += paintSettledBatchEdgeInterpolationsToGrid(" in app_js
    assert "paintedEdgeCount = paintAllReachableEdgeInterpolationsToGrid(" in app_js
    assert "paintedEdgeCount," in app_js


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
    assert "const isCancelled = options.isCancelled ?? (() => false);" in app_js
    assert "const requestAnimationFrameImpl = options.requestAnimationFrameImpl" in app_js
    assert "while (!isDone(searchState))" in app_js
    assert "if (isCancelled()) {" in app_js
    assert "while (elapsedMs < sliceBudgetMs && !isDone(searchState))" in app_js
    assert "onSlice(settledBatch);" in app_js
    assert "await waitForAnimationFrame(requestAnimationFrameImpl);" in app_js
    assert "export async function runSearchTimeSlicedWithRendering(" in app_js
    assert "const statusUpdateIntervalMs = options.statusUpdateIntervalMs ?? 120;" in app_js
    assert "const skipFinalFullPass = options.skipFinalFullPass ?? false;" in app_js
    assert "let lastStatusUpdateMs = routeStartMs;" in app_js
    assert "if (nowMs - lastStatusUpdateMs >= statusUpdateIntervalMs) {" in app_js
    assert "paintedNodeCount = settledNodeCount;" in app_js
    assert "if (!skipFinalFullPass) {" in app_js
    assert "setRoutingStatus(shell, formatRoutingStatusPreview(routeElapsedMs));" in app_js
    assert "paintSettledBatchToGrid(" in app_js
    assert "blitPixelGridToCanvas(shell.isochroneCanvas, mapData.pixelGrid);" in app_js


def test_app_js_has_routing_status_text_contract() -> None:
    app_js = (WEB_ROOT / "src" / "app.js").read_text(encoding="utf-8")

    assert "getElementById('routing-status')" in app_js
    assert "getElementById('render-backend-badge')" in app_js
    assert "getElementById('map-region')" in app_js
    assert "getElementById('canvas-stack')" in app_js
    assert "export function formatRoutingStatusCalculating(" in app_js
    assert "Calculating..." in app_js
    assert "nodes settled" in app_js
    assert "export function formatRoutingStatusDone(" in app_js
    assert "Done - full travel-time field ready" in app_js
    assert "export function formatRoutingStatusPreview(" in app_js
    assert "Done - preview updated" in app_js
    assert "function formatRoutingDurationSuffix(" in app_js
    assert "return ` (${roundedDurationMs} ms)`;" in app_js
    assert "setRoutingStatus(shell, formatRoutingStatusCalculating(0));" in app_js
    assert "setRoutingStatus(shell, formatRoutingStatusDone(routeElapsedMs));" in app_js


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
    assert "const distSeconds = new Float64Array(graph.header.nNodes);" in app_js
    assert "distSeconds.fill(Infinity);" in app_js
    assert "const settled = new Uint8Array(graph.header.nNodes);" in app_js
    assert "heap.push(sourceNodeIndex, 0);" in app_js
    assert "if (Number.isFinite(timeLimitSeconds) && cost > timeLimitSeconds)" in app_js
    assert "if ((graph.edgeModeMask[edgeIndex] & allowedModeMask) === 0)" in app_js
    assert "const edgeCostSeconds = computeEdgeTraversalCostSeconds(" in app_js
    assert "if (!Number.isFinite(edgeCostSeconds) || edgeCostSeconds <= 0)" in app_js
    assert "if (nextCost < distSeconds[targetIndex])" in app_js
    assert "heap.decreaseKey(targetIndex, nextCost);" in app_js
    assert "export function findNearestNodeIndex(" in app_js
    assert "const dx = nodeXM - xM;" in app_js
    assert "const dy = nodeYM - yM;" in app_js
    assert "export async function runWalkingIsochroneFromSourceNode(" in app_js
    assert "const allowedModeMask = options.allowedModeMask ?? EDGE_MODE_CAR_BIT;" in app_js
    assert "if (!runSummary.cancelled) {" in app_js
    assert "runPostMvpTransitStub(mapData.graph, searchState);" in app_js
    assert "runSearchTimeSlicedWithRendering(" in app_js


def test_app_js_has_mode_aware_edge_cost_contract() -> None:
    app_js = (WEB_ROOT / "src" / "app.js").read_text(encoding="utf-8")

    assert "const WALKING_SPEED_M_S = 1.39;" in app_js
    assert "const BIKE_CRUISE_SPEED_KPH = 20;" in app_js
    assert "const ROAD_CLASS_MOTORWAY = 15;" in app_js
    assert "export function computeEdgeTraversalCostSeconds(" in app_js
    assert "const edgeModeMask = graph.edgeModeMask[edgeIndex];" in app_js
    assert "const walkingCostSeconds = graph.edgeU16[edgeIndex * 6 + 2];" in app_js
    assert "const distanceMeters = Math.max(1, walkingCostSeconds * WALKING_SPEED_M_S);" in app_js
    assert (
        "if ((allowedModeMask & EDGE_MODE_WALK_BIT) !== 0 && "
        "(edgeModeMask & EDGE_MODE_WALK_BIT) !== 0)"
    ) in app_js
    assert "const isMotorway = graph.edgeRoadClassId[edgeIndex] === ROAD_CLASS_MOTORWAY;" in app_js
    assert "if (!isMotorway) {" in app_js
    assert (
        "if ((allowedModeMask & EDGE_MODE_BIKE_BIT) !== 0 && "
        "(edgeModeMask & EDGE_MODE_BIKE_BIT) !== 0)"
    ) in app_js
    assert "const bikeSpeedKph = Math.min(BIKE_CRUISE_SPEED_KPH, edgeMaxspeedKph);" in app_js
    assert (
        "if ((allowedModeMask & EDGE_MODE_CAR_BIT) !== 0 && "
        "(edgeModeMask & EDGE_MODE_CAR_BIT) !== 0)"
    ) in app_js
    assert (
        "const carSpeedKph = edgeMaxspeedKph > 0 ? edgeMaxspeedKph : CAR_FALLBACK_SPEED_KPH;"
    ) in app_js
    assert "return Number.isFinite(bestCostSeconds) ? bestCostSeconds : Infinity;" in app_js


def test_app_js_has_mode_selector_contract() -> None:
    app_js = (WEB_ROOT / "src" / "app.js").read_text(encoding="utf-8")

    assert "getElementById('mode-select')" in app_js
    assert "export function bindModeSelectControl(" in app_js
    assert "export function getAllowedModeMaskFromShell(" in app_js
    assert "const selectedOptions = shell.modeSelect?.selectedOptions;" in app_js
    assert "if (optionValue === 'walk')" in app_js
    assert "if (optionValue === 'bike')" in app_js
    assert "if (optionValue === 'car')" in app_js
    assert "if (allowedModeMask === 0)" in app_js
    assert "option.selected = option.value === 'car';" in app_js


def test_app_js_has_legend_and_scale_bar_contract() -> None:
    app_js = (WEB_ROOT / "src" / "app.js").read_text(encoding="utf-8")

    assert "const DEFAULT_COLOUR_CYCLE_MINUTES = 60;" in app_js
    assert "getElementById('colour-cycle-minutes')" in app_js
    assert "getElementById('distance-scale')" in app_js
    assert "getElementById('distance-scale-line')" in app_js
    assert "getElementById('distance-scale-label')" in app_js
    assert "getElementById('isochrone-legend')" in app_js
    assert "shell.isochroneCanvas.width = graph.header.gridWidthPx;" in app_js
    assert "shell.isochroneCanvas.height = graph.header.gridHeightPx;" in app_js
    assert "export function getColourCycleMinutesFromShell(" in app_js
    assert "const rawCycleValue = shell.colourCycleMinutesInput?.value;" in app_js
    assert "export function renderIsochroneLegend(" in app_js
    assert "export function renderIsochroneLegendIfNeeded(" in app_js
    assert "shell.lastRenderedLegendCycleMinutes = cycleMinutes;" in app_js
    assert "export function updateDistanceScaleBar(" in app_js
    assert "const metresPerCssPixel =" in app_js
    assert "renderIsochroneLegendIfNeeded(shell, getColourCycleMinutesFromShell(shell));" in app_js
    assert "updateRenderBackendBadge(shell, renderer);" in app_js
    assert "updateDistanceScaleBar(shell, graph.header);" in app_js


def test_app_js_reads_v2_edge_mode_and_speed_metadata_contract() -> None:
    app_js = (WEB_ROOT / "src" / "app.js").read_text(encoding="utf-8")

    assert "const edgeModeMask = new Uint8Array(nEdges);" in app_js
    assert "const edgeRoadClassId = new Uint8Array(nEdges);" in app_js
    assert "const edgeMaxspeedKph = new Uint16Array(nEdges);" in app_js
    assert "const packedMetadata = edgeU32[edgeIndex * 3 + 2];" in app_js
    assert "edgeModeMask[edgeIndex] = packedMetadata & 0xff;" in app_js
    assert "edgeRoadClassId[edgeIndex] = (packedMetadata >>> 8) & 0xff;" in app_js
    assert "edgeMaxspeedKph[edgeIndex] = (packedMetadata >>> 16) & 0xffff;" in app_js
    assert "edgeModeMask," in app_js
    assert "edgeRoadClassId," in app_js
    assert "edgeMaxspeedKph," in app_js


def test_app_js_has_post_mvp_transit_stub_contract() -> None:
    app_js = (WEB_ROOT / "src" / "app.js").read_text(encoding="utf-8")

    assert "export function runPostMvpTransitStub(" in app_js
    assert "const nStops = graph.header.nStops;" in app_js
    assert "if (nStops === 0)" in app_js
    assert "// POST-MVP: run CSA here, then re-run Dijkstra from transit-reached stops" in app_js
    assert "runPostMvpTransitStub(mapData.graph, searchState);" in app_js


def test_app_js_has_canvas_pixel_to_graph_coordinate_contract() -> None:
    app_js = (WEB_ROOT / "src" / "app.js").read_text(encoding="utf-8")

    assert "export function mapCanvasPixelToGraphMeters(" in app_js
    assert "graph.header.originEasting + xPx * graph.header.pixelSizeM" in app_js
    assert "graph.header.originNorthing + (graph.header.gridHeightPx - 1 - yPx)" in app_js
    assert "* graph.header.pixelSizeM" in app_js
    assert "return { easting, northing };" in app_js


def test_app_js_has_nearest_node_and_highlight_contract() -> None:
    app_js = (WEB_ROOT / "src" / "app.js").read_text(encoding="utf-8")

    assert "export function findNearestNodeIndexForMode(" in app_js
    assert "allowedModeMask = EDGE_MODE_CAR_BIT" in app_js
    assert "export function findNearestNodeForCanvasPixel(" in app_js
    assert (
        "const { easting, northing } = mapCanvasPixelToGraphMeters(mapData.graph, xPx, yPx);"
        in app_js
    )
    assert "const xM = easting - mapData.graph.header.originEasting;" in app_js
    assert "const yM = northing - mapData.graph.header.originNorthing;" in app_js
    assert "const nodeModeMask = mapData.nodeModeMask ?? null;" in app_js
    assert "const nodeSpatialIndex = mapData.nodeSpatialIndex ?? null;" in app_js
    assert "export function findNearestNodeIndexForModeFromSpatialIndex(" in app_js
    assert "let nearestModeNodeIndex = -1;" in app_js
    assert "for (let radius = 0; radius <= maxRadius; radius += 1)" in app_js
    assert "if (nodeModeMask[nodeIndex] & allowedModeMask)" in app_js
    assert "const nodeIndexPx = findNearestNodeIndexForModeFromSpatialIndex(" in app_js
    assert (
        "nodeIndex = findNearestNodeIndexForMode(mapData.graph, xM, yM, allowedModeMask);" in app_js
    )
    assert "export function highlightNodeIndexOnIsochroneCanvas(" in app_js
    assert "const xPx = mapData.nodePixels.nodePixelX[nodeIndex];" in app_js
    assert "const yPx = mapData.nodePixels.nodePixelY[nodeIndex];" in app_js
    assert "setPixel(mapData.pixelGrid, xPx, yPx, r, g, b, alpha);" in app_js
    assert "blitPixelGridToCanvas(shell.isochroneCanvas, mapData.pixelGrid);" in app_js


def test_app_js_has_click_to_routing_wiring_contract() -> None:
    app_js = (WEB_ROOT / "src" / "app.js").read_text(encoding="utf-8")

    assert "export function bindCanvasClickRouting(" in app_js
    assert "const dragDebounceMs = options.dragDebounceMs ?? 60;" in app_js
    assert "let isPointerDown = false;" in app_js
    assert "let dragDebounceTimerId = null;" in app_js
    assert "let pendingDebouncePoint = null;" in app_js
    assert "let queuedDragPoint = null;" in app_js
    assert "let dragRunInFlight = false;" in app_js
    assert "const clearDragDebounceTimer = () => {" in app_js
    assert "const flushPendingDebouncedDragRun = () => {" in app_js
    assert "const scheduleDebouncedDragRun = (xPx, yPx) => {" in app_js
    assert "shell.isochroneCanvas.addEventListener('pointerdown', handlePointerDown);" in app_js
    assert "shell.isochroneCanvas.addEventListener('pointermove', handlePointerMove);" in app_js
    assert "shell.isochroneCanvas.addEventListener('pointerup', handlePointerUp);" in app_js
    assert "shell.isochroneCanvas.addEventListener('pointercancel', handlePointerCancel);" in app_js
    assert "scheduleDebouncedDragRun(xPx, yPx);" in app_js
    assert "flushPendingDebouncedDragRun();" in app_js
    assert "skipFinalFullPass: true" in app_js
    assert "skipFinalFullPass: false" in app_js
    assert (
        "queueRunFromCanvasPixel(xPx, yPx, { cancelInFlight: true, skipFinalFullPass: true });"
        in app_js
    )
    assert "if (!isPointerDown) {" in app_js
    assert "if (activeRunToken !== null) {" in app_js
    assert "activeRunToken.cancelled = true;" in app_js
    assert "const runToken = { cancelled: false };" in app_js
    assert "clearGrid(mapData.pixelGrid);" in app_js
    assert (
        "clearGrid(mapData.pixelGrid);\n"
        "    highlightNodeIndexOnIsochroneCanvas(shell, mapData, nodeIndex);"
    ) in app_js
    assert "renderIsochroneLegendIfNeeded(shell, colourCycleMinutes);" in app_js
    assert "blitPixelGridToCanvas(shell.isochroneCanvas, mapData.pixelGrid);" in app_js
    assert "findNearestNodeForCanvasPixel(mapData, xPx, yPx, { allowedModeMask });" in app_js
    assert "highlightNodeIndexOnIsochroneCanvas(shell, mapData, nodeIndex);" in app_js
    assert "runWalkingIsochroneFromSourceNode(" in app_js
    assert "Number.POSITIVE_INFINITY" in app_js
    assert "const allowedModeMask = getAllowedModeMaskFromShell(shell);" in app_js
    assert "allowedModeMask," in app_js
    assert "isCancelled: () => runToken.cancelled," in app_js
    assert "return { dispose, runFromCanvasPixel };" in app_js


def test_app_js_has_boundary_graph_alignment_contract() -> None:
    app_js = (WEB_ROOT / "src" / "app.js").read_text(encoding="utf-8")

    assert "export function drawBoundaryBasemapAlignedToGraphGrid(" in app_js
    assert "const easting = parsedBoundary.coordinateSpace.xOrigin + point[0];" in app_js
    assert "const northing = parsedBoundary.coordinateSpace.yOrigin - point[1];" in app_js
    assert "const xPx = (easting - graphHeader.originEasting) / graphHeader.pixelSizeM;" in app_js
    assert (
        "const yPx = maxY - (northing - graphHeader.originNorthing) / graphHeader.pixelSizeM;"
        in app_js
    )
    assert "boundaryCanvas.width = graphHeader.gridWidthPx;" in app_js
    assert "boundaryCanvas.height = graphHeader.gridHeightPx;" in app_js
    assert "drawBoundaryBasemapAlignedToGraphGrid(" in app_js
    assert "boundaryLoad.boundaryPayload," in app_js
    assert "const parsed = parseBoundaryBasemapPayload(payload);" in app_js
    assert "export function layoutMapViewportToContainGraph(" in app_js
    assert "const regionRect = shell.mapRegion.getBoundingClientRect();" in app_js
    assert "const graphAspect = graphHeader.gridWidthPx / graphHeader.gridHeightPx;" in app_js
    assert "const regionAspect = regionRect.width / regionRect.height;" in app_js
    assert "shell.canvasStack.style.width = `${layoutWidthPx}px`;" in app_js
    assert "shell.canvasStack.style.height = `${layoutHeightPx}px`;" in app_js
    assert "layoutMapViewportToContainGraph(shell, graph.header);" in app_js


def test_styles_prevent_zero_height_map_region() -> None:
    styles_css = (WEB_ROOT / "src" / "styles.css").read_text(encoding="utf-8")

    assert ".app-shell" in styles_css
    assert "height: 100vh;" in styles_css
    assert ".map-region" in styles_css
    assert "min-height: 16rem;" in styles_css
    assert "justify-content: center;" in styles_css
    assert "#canvas-stack" in styles_css
    assert "max-width: 100%;" in styles_css
    assert "max-height: 100%;" in styles_css
    assert "#loading-progress" in styles_css
    assert "#loading-progress-bar" in styles_css
    assert "#loading.is-fading" in styles_css
    assert "#loading[hidden]" in styles_css
    assert "#routing-status" in styles_css
    assert "#render-backend-badge" in styles_css
    assert ".mode-select" in styles_css
    assert "#mode-select" in styles_css
    assert "#distance-scale" in styles_css
    assert "#isochrone-legend" in styles_css
