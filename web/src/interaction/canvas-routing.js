import {
  createDefaultMapViewport,
  mapScreenCanvasPixelToGraphPixel,
  panMapViewportByCanvasDelta,
  zoomMapViewportAtCanvasPixel,
} from '../core/viewport.js';

const NAVIGATION_DRAG_THRESHOLD_PX = 5;
const MAX_VIEWPORT_SCALE = 8;
const MIN_VIEWPORT_SCALE = 1;
const WHEEL_ZOOM_SENSITIVITY = 0.0015;

export function bindCanvasClickRouting(shell, mapData, options = {}, dependencies = {}) {
  if (!shell || !shell.isochroneCanvas) {
    throw new Error('shell.isochroneCanvas is required');
  }
  if (!mapData || typeof mapData !== 'object' || !mapData.graph) {
    throw new Error('mapData.graph is required');
  }

  const {
    findNearestNodeForCanvasPixel,
    getAllowedModeMaskFromShell,
    getColourCycleMinutesFromShell,
    getRoutingFailedStatusText,
    mapClientPointToCanvasPixel,
    parseNodeIndexFromLocationSearch,
    persistNodeIndexToLocation,
    renderIsochroneLegendIfNeeded,
    runWalkingIsochroneFromSourceNode,
    setRoutingStatus,
    updateDistanceScaleBar,
    redrawViewport,
  } = dependencies;

  if (typeof findNearestNodeForCanvasPixel !== 'function') {
    throw new Error('dependencies.findNearestNodeForCanvasPixel must be a function');
  }
  if (typeof getAllowedModeMaskFromShell !== 'function') {
    throw new Error('dependencies.getAllowedModeMaskFromShell must be a function');
  }
  if (typeof getColourCycleMinutesFromShell !== 'function') {
    throw new Error('dependencies.getColourCycleMinutesFromShell must be a function');
  }
  if (getRoutingFailedStatusText !== undefined && typeof getRoutingFailedStatusText !== 'function') {
    throw new Error('dependencies.getRoutingFailedStatusText must be a function when provided');
  }
  if (typeof mapClientPointToCanvasPixel !== 'function') {
    throw new Error('dependencies.mapClientPointToCanvasPixel must be a function');
  }
  if (typeof parseNodeIndexFromLocationSearch !== 'function') {
    throw new Error('dependencies.parseNodeIndexFromLocationSearch must be a function');
  }
  if (typeof persistNodeIndexToLocation !== 'function') {
    throw new Error('dependencies.persistNodeIndexToLocation must be a function');
  }
  if (typeof renderIsochroneLegendIfNeeded !== 'function') {
    throw new Error('dependencies.renderIsochroneLegendIfNeeded must be a function');
  }
  if (typeof runWalkingIsochroneFromSourceNode !== 'function') {
    throw new Error('dependencies.runWalkingIsochroneFromSourceNode must be a function');
  }
  if (typeof setRoutingStatus !== 'function') {
    throw new Error('dependencies.setRoutingStatus must be a function');
  }
  if (updateDistanceScaleBar !== undefined && typeof updateDistanceScaleBar !== 'function') {
    throw new Error('dependencies.updateDistanceScaleBar must be a function when provided');
  }
  if (redrawViewport !== undefined && typeof redrawViewport !== 'function') {
    throw new Error('dependencies.redrawViewport must be a function when provided');
  }

  const incrementalRender = options.incrementalRender ?? false;
  if (typeof incrementalRender !== 'boolean') {
    throw new Error('options.incrementalRender must be a boolean when provided');
  }

  let activeRunToken = null;
  let isDisposed = false;
  let activePointerGesture = null;
  let queuedClientPoint = null;
  let queuedNodeIndex = null;
  let lastCompletedClientPoint = null;
  let lastCompletedNodeIndex = null;
  let idleWaiterResolvers = [];
  if (!mapData.viewport) {
    mapData.viewport = createDefaultMapViewport();
  }

  const isRoutingIdle = () =>
    activeRunToken === null && queuedNodeIndex === null && queuedClientPoint === null;

  const flushIdleWaitersIfIdle = () => {
    if (!isRoutingIdle() || idleWaiterResolvers.length === 0) {
      return;
    }
    const resolvers = idleWaiterResolvers;
    idleWaiterResolvers = [];
    for (const resolveIdle of resolvers) {
      resolveIdle();
    }
  };

  const runFromNodeIndex = async (nodeIndex, modeMask = null) => {
    if (isDisposed) {
      throw new Error('routing click handler is disposed');
    }
    if (!Number.isInteger(nodeIndex) || nodeIndex < 0 || nodeIndex >= mapData.graph.header.nNodes) {
      throw new Error(`nodeIndex out of range: ${nodeIndex}`);
    }
    if (activeRunToken !== null) {
      return {
        nodeIndex,
        cancelled: true,
        ignoredBusy: true,
        elapsedMs: 0,
        paintedEdgeCount: 0,
        paintedNodeCount: 0,
      };
    }

    const runToken = { cancelled: false };
    activeRunToken = runToken;
    const allowedModeMask = modeMask ?? getAllowedModeMaskFromShell(shell);
    const colourCycleMinutes = getColourCycleMinutesFromShell(shell);
    renderIsochroneLegendIfNeeded(shell, colourCycleMinutes);

    try {
      const runSummary = await runWalkingIsochroneFromSourceNode(
        shell,
        mapData,
        nodeIndex,
        Number.POSITIVE_INFINITY,
        {
          ...options,
          allowedModeMask,
          colourCycleMinutes,
          skipFinalFullPass: false,
          incrementalRender,
          isCancelled: () => runToken.cancelled,
        },
      );
      if (!runSummary.cancelled) {
        persistNodeIndexToLocation(nodeIndex);
        lastCompletedNodeIndex = nodeIndex;
      }
      if (activeRunToken === runToken) {
        activeRunToken = null;
      }
      if (!isDisposed && activeRunToken === null && (queuedNodeIndex !== null || queuedClientPoint !== null)) {
        void maybeStartQueuedRun();
      }
      flushIdleWaitersIfIdle();
      return {
        nodeIndex,
        ...runSummary,
      };
    } catch (error) {
      if (activeRunToken === runToken) {
        activeRunToken = null;
      }
      if (!isDisposed && activeRunToken === null && (queuedNodeIndex !== null || queuedClientPoint !== null)) {
        void maybeStartQueuedRun();
      }
      flushIdleWaitersIfIdle();
      throw error;
    }
  };

  const runFromCanvasPixel = async (xPx, yPx) => {
    if (activeRunToken !== null) {
      return {
        xPx,
        yPx,
        cancelled: true,
        ignoredBusy: true,
        elapsedMs: 0,
        paintedEdgeCount: 0,
        paintedNodeCount: 0,
      };
    }
    const allowedModeMask = getAllowedModeMaskFromShell(shell);
    const nearest = findNearestNodeForCanvasPixel(mapData, xPx, yPx, { allowedModeMask });
    const runSummary = await runFromNodeIndex(nearest.nodeIndex, allowedModeMask);
    if (!runSummary.cancelled) {
      lastCompletedClientPoint = { xPx, yPx };
    }
    return {
      ...nearest,
      ...runSummary,
    };
  };

  const maybeStartQueuedRun = async () => {
    if (isDisposed || activeRunToken !== null) {
      return;
    }
    const nextNodeIndex = queuedNodeIndex;
    const nextPoint = queuedNodeIndex === null ? queuedClientPoint : null;
    queuedNodeIndex = null;
    queuedClientPoint = null;

    const queuedRunPromise =
      nextNodeIndex !== null
        ? runFromNodeIndex(nextNodeIndex)
        : nextPoint !== null
          ? runFromCanvasPixel(nextPoint.xPx, nextPoint.yPx)
          : null;
    if (queuedRunPromise === null) {
      flushIdleWaitersIfIdle();
      return;
    }

    await queuedRunPromise.catch((error) => {
      setRoutingStatus(shell, getRoutingFailedStatusText?.(shell) ?? 'Routing failed.');
      console.error(error);
    });

    if (!isDisposed && activeRunToken === null && (queuedNodeIndex !== null || queuedClientPoint !== null)) {
      await maybeStartQueuedRun();
    }
    flushIdleWaitersIfIdle();
  };

  const queueLatestRunAtClientPoint = (clientX, clientY) => {
    if (isDisposed) {
      return;
    }
    const screenCanvasPixel = mapClientPointToCanvasPixel(
      shell.isochroneCanvas,
      clientX,
      clientY,
    );
    const { xPx, yPx } = mapScreenCanvasPixelToGraphPixel(
      mapData.viewport,
      screenCanvasPixel.xPx,
      screenCanvasPixel.yPx,
    );
    if (queuedClientPoint !== null && queuedClientPoint.xPx === xPx && queuedClientPoint.yPx === yPx) {
      return;
    }
    if (
      activeRunToken === null
      && queuedClientPoint === null
      && lastCompletedClientPoint !== null
      && lastCompletedClientPoint.xPx === xPx
      && lastCompletedClientPoint.yPx === yPx
    ) {
      return;
    }
    queuedClientPoint = { xPx, yPx };
    void maybeStartQueuedRun();
  };

  const queueLatestRunAtNodeIndex = (nodeIndex, options = {}) => {
    if (isDisposed) {
      return false;
    }
    if (!Number.isInteger(nodeIndex) || nodeIndex < 0 || nodeIndex >= mapData.graph.header.nNodes) {
      return false;
    }
    const force = options.force === true;
    if (
      queuedNodeIndex !== null
      && queuedNodeIndex === nodeIndex
    ) {
      return true;
    }
    if (
      !force
      && (
      activeRunToken === null
      && queuedNodeIndex === null
      && queuedClientPoint === null
      && lastCompletedNodeIndex !== null
      && lastCompletedNodeIndex === nodeIndex
      )
    ) {
      return true;
    }

    queuedNodeIndex = nodeIndex;
    queuedClientPoint = null;
    void maybeStartQueuedRun();
    return true;
  };

  const requestIsochroneRedraw = () => {
    const candidateNodeIndex =
      lastCompletedNodeIndex ?? parseNodeIndexFromLocationSearch(
        globalThis.location?.search ?? '',
        mapData.graph.header.nNodes,
      );
    if (candidateNodeIndex === null) {
      return false;
    }
    return queueLatestRunAtNodeIndex(candidateNodeIndex, { force: true });
  };

  const releasePointerCaptureIfHeld = (event) => {
    if (
      typeof shell.isochroneCanvas.hasPointerCapture !== 'function'
      || typeof shell.isochroneCanvas.releasePointerCapture !== 'function'
      || !Number.isInteger(event.pointerId)
    ) {
      return;
    }
    if (shell.isochroneCanvas.hasPointerCapture(event.pointerId)) {
      shell.isochroneCanvas.releasePointerCapture(event.pointerId);
    }
  };

  const getPointerActions = () =>
    shell.invertPointerButtonsInput?.checked === true
      ? { navigateButton: 2, selectButton: 0 }
      : { navigateButton: 0, selectButton: 2 };

  const beginPointerGesture = (event, action) => {
    activePointerGesture = {
      action,
      pointerId: Number.isInteger(event.pointerId) ? event.pointerId : null,
      startClientX: event.clientX,
      startClientY: event.clientY,
      lastClientX: event.clientX,
      lastClientY: event.clientY,
      dragged: false,
    };
    if (
      typeof shell.isochroneCanvas.setPointerCapture === 'function'
      && Number.isInteger(event.pointerId)
    ) {
      shell.isochroneCanvas.setPointerCapture(event.pointerId);
    }
  };

  const handlePointerDown = (event) => {
    if (isDisposed || activePointerGesture !== null) {
      return;
    }
    if (event.pointerType !== 'mouse') {
      beginPointerGesture(event, 'select');
      return;
    }
    const { navigateButton, selectButton } = getPointerActions();
    if (event.button === navigateButton) {
      beginPointerGesture(event, 'navigate');
      return;
    }
    if (event.button === selectButton) {
      if (typeof event.preventDefault === 'function') {
        event.preventDefault();
      }
      beginPointerGesture(event, 'select');
      return;
    }
  };

  const handlePointerMove = (event) => {
    if (
      activePointerGesture === null
      || (
        activePointerGesture.pointerId !== null
        && Number.isInteger(event.pointerId)
        && event.pointerId !== activePointerGesture.pointerId
      )
    ) {
      return;
    }

    if (activePointerGesture.action === 'navigate') {
      if (!isPointerButtonPressed(event, getPointerActions().navigateButton)) {
        releasePointerCaptureIfHeld(event);
        activePointerGesture = null;
        return;
      }

      const totalDeltaX = event.clientX - activePointerGesture.startClientX;
      const totalDeltaY = event.clientY - activePointerGesture.startClientY;
      if (
        !activePointerGesture.dragged
        && Math.hypot(totalDeltaX, totalDeltaY) < NAVIGATION_DRAG_THRESHOLD_PX
      ) {
        return;
      }

      const deltaX = event.clientX - activePointerGesture.lastClientX;
      const deltaY = event.clientY - activePointerGesture.lastClientY;
      activePointerGesture.dragged = true;
      updateViewportByClientDelta(deltaX, deltaY);
      activePointerGesture.lastClientX = event.clientX;
      activePointerGesture.lastClientY = event.clientY;
      return;
    }

    if (!isPointerButtonPressed(event, getPointerActions().selectButton)) {
      queueLatestRunAtClientPoint(event.clientX, event.clientY);
      releasePointerCaptureIfHeld(event);
      activePointerGesture = null;
      return;
    }

    queueLatestRunAtClientPoint(event.clientX, event.clientY);
  };

  const handlePointerUp = (event) => {
    if (
      activePointerGesture === null
      || (
        activePointerGesture.pointerId !== null
        && Number.isInteger(event.pointerId)
        && event.pointerId !== activePointerGesture.pointerId
      )
    ) {
      return;
    }

    if (
      activePointerGesture.action === 'select'
      || !activePointerGesture.dragged
    ) {
      queueLatestRunAtClientPoint(event.clientX, event.clientY);
    }
    releasePointerCaptureIfHeld(event);
    activePointerGesture = null;
  };

  const handleWheel = (event) => {
    if (typeof event.preventDefault === 'function') {
      event.preventDefault();
    }
    zoomViewportAtClientPoint(event.clientX, event.clientY, event.deltaY);
  };

  const handleContextMenu = (event) => {
    if (typeof event.preventDefault === 'function') {
      event.preventDefault();
    }
  };

  const handlePointerCancel = (event) => {
    activePointerGesture = null;
    releasePointerCaptureIfHeld(event);
  };

  shell.isochroneCanvas.addEventListener('pointerdown', handlePointerDown);
  shell.isochroneCanvas.addEventListener('pointermove', handlePointerMove);
  shell.isochroneCanvas.addEventListener('pointerup', handlePointerUp);
  shell.isochroneCanvas.addEventListener('pointercancel', handlePointerCancel);
  shell.isochroneCanvas.addEventListener('wheel', handleWheel, { passive: false });
  shell.isochroneCanvas.addEventListener('contextmenu', handleContextMenu);

  const initialNodeIndex = parseNodeIndexFromLocationSearch(
    globalThis.location?.search ?? '',
    mapData.graph.header.nNodes,
  );
  if (initialNodeIndex !== null) {
    const allowedModeMask = getAllowedModeMaskFromShell(shell);
    void runFromNodeIndex(initialNodeIndex, allowedModeMask).catch((error) => {
      setRoutingStatus(shell, getRoutingFailedStatusText?.(shell) ?? 'Routing failed.');
      console.error(error);
    });
  }

  const dispose = () => {
    if (isDisposed) {
      return;
    }
    isDisposed = true;

    if (activeRunToken !== null) {
      activeRunToken.cancelled = true;
      activeRunToken = null;
    }
    activePointerGesture = null;
    queuedClientPoint = null;
    queuedNodeIndex = null;
    lastCompletedClientPoint = null;
    lastCompletedNodeIndex = null;
    flushIdleWaitersIfIdle();

    shell.isochroneCanvas.removeEventListener('pointerdown', handlePointerDown);
    shell.isochroneCanvas.removeEventListener('pointermove', handlePointerMove);
    shell.isochroneCanvas.removeEventListener('pointerup', handlePointerUp);
    shell.isochroneCanvas.removeEventListener('pointercancel', handlePointerCancel);
    shell.isochroneCanvas.removeEventListener('wheel', handleWheel);
    shell.isochroneCanvas.removeEventListener('contextmenu', handleContextMenu);
  };

  return {
    dispose,
    getViewportState() {
      return { ...mapData.viewport };
    },
    runFromCanvasPixel,
    requestIsochroneRedraw,
    waitForIdle() {
      if (isDisposed || isRoutingIdle()) {
        return Promise.resolve();
      }
      return new Promise((resolveIdle) => {
        idleWaiterResolvers.push(resolveIdle);
      });
    },
  };
  function updateViewportByClientDelta(deltaClientX, deltaClientY) {
    const canvasRect = shell.isochroneCanvas.getBoundingClientRect();
    if (!(canvasRect.width > 0) || !(canvasRect.height > 0)) {
      return false;
    }
    const deltaCanvasX = (deltaClientX / canvasRect.width) * shell.isochroneCanvas.width;
    const deltaCanvasY = (deltaClientY / canvasRect.height) * shell.isochroneCanvas.height;
    const nextViewport = panMapViewportByCanvasDelta(
      mapData.graph.header,
      mapData.viewport,
      deltaCanvasX,
      deltaCanvasY,
      {
        minScale: MIN_VIEWPORT_SCALE,
        maxScale: MAX_VIEWPORT_SCALE,
      },
    );
    return applyViewport(nextViewport, { updateScaleBar: false });
  }

  function zoomViewportAtClientPoint(clientX, clientY, deltaY) {
    if (!Number.isFinite(clientX) || !Number.isFinite(clientY) || !Number.isFinite(deltaY)) {
      return false;
    }
    const anchorCanvasPixel = mapClientPointToCanvasPixel(shell.isochroneCanvas, clientX, clientY);
    const zoomFactor = Math.exp(-deltaY * WHEEL_ZOOM_SENSITIVITY);
    const nextViewport = zoomMapViewportAtCanvasPixel(
      mapData.graph.header,
      mapData.viewport,
      anchorCanvasPixel.xPx,
      anchorCanvasPixel.yPx,
      zoomFactor,
      {
        minScale: MIN_VIEWPORT_SCALE,
        maxScale: MAX_VIEWPORT_SCALE,
      },
    );
    return applyViewport(nextViewport, { updateScaleBar: true });
  }

  function applyViewport(nextViewport, applyOptions = {}) {
    if (!nextViewport) {
      return false;
    }
    const currentViewport = mapData.viewport ?? createDefaultMapViewport();
    if (
      currentViewport.scale === nextViewport.scale
      && currentViewport.offsetXPx === nextViewport.offsetXPx
      && currentViewport.offsetYPx === nextViewport.offsetYPx
    ) {
      return false;
    }
    mapData.viewport = nextViewport;
    if (applyOptions.updateScaleBar === true && typeof updateDistanceScaleBar === 'function') {
      updateDistanceScaleBar(shell, mapData.graph.header, { viewport: mapData.viewport });
    }
    if (typeof redrawViewport === 'function') {
      redrawViewport(shell, mapData);
    }
    return true;
  }
}

function getPointerButtonMask(button) {
  if (button === 0) {
    return 1;
  }
  if (button === 1) {
    return 4;
  }
  if (button === 2) {
    return 2;
  }
  return 0;
}

function isPointerButtonPressed(event, button) {
  if (!Number.isInteger(button) || button < 0) {
    return false;
  }
  if (Number.isInteger(event.buttons)) {
    return (event.buttons & getPointerButtonMask(button)) !== 0;
  }
  return event.button === button;
}
