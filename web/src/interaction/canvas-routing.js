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
    mapClientPointToCanvasPixel,
    parseNodeIndexFromLocationSearch,
    persistNodeIndexToLocation,
    renderIsochroneLegendIfNeeded,
    runWalkingIsochroneFromSourceNode,
    setRoutingStatus,
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

  const incrementalRender = options.incrementalRender ?? false;
  if (typeof incrementalRender !== 'boolean') {
    throw new Error('options.incrementalRender must be a boolean when provided');
  }

  let activeRunToken = null;
  let isDisposed = false;
  let isPointerDown = false;
  let queuedClientPoint = null;
  let queuedNodeIndex = null;
  let lastCompletedClientPoint = null;
  let lastCompletedNodeIndex = null;

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
      return;
    }

    await queuedRunPromise.catch((error) => {
      setRoutingStatus(shell, 'Routing failed.');
      console.error(error);
    });

    if (!isDisposed && activeRunToken === null && (queuedNodeIndex !== null || queuedClientPoint !== null)) {
      await maybeStartQueuedRun();
    }
  };

  const queueLatestRunAtClientPoint = (clientX, clientY) => {
    if (isDisposed) {
      return;
    }
    const { xPx, yPx } = mapClientPointToCanvasPixel(
      shell.isochroneCanvas,
      clientX,
      clientY,
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

  const queueLatestRunAtNodeIndex = (nodeIndex) => {
    if (isDisposed) {
      return false;
    }
    if (!Number.isInteger(nodeIndex) || nodeIndex < 0 || nodeIndex >= mapData.graph.header.nNodes) {
      return false;
    }
    if (
      queuedNodeIndex !== null
      && queuedNodeIndex === nodeIndex
    ) {
      return true;
    }
    if (
      activeRunToken === null
      && queuedNodeIndex === null
      && queuedClientPoint === null
      && lastCompletedNodeIndex !== null
      && lastCompletedNodeIndex === nodeIndex
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
    return queueLatestRunAtNodeIndex(candidateNodeIndex);
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

  const isPrimaryPointerEvent = (event) => {
    if (Number.isInteger(event.button) && event.button !== 0) {
      return false;
    }
    if (Number.isInteger(event.buttons) && event.buttons !== 0 && (event.buttons & 1) === 0) {
      return false;
    }
    return true;
  };

  const handlePointerDown = (event) => {
    if (!isPrimaryPointerEvent(event)) {
      return;
    }
    isPointerDown = true;
    if (
      typeof shell.isochroneCanvas.setPointerCapture === 'function'
      && Number.isInteger(event.pointerId)
    ) {
      shell.isochroneCanvas.setPointerCapture(event.pointerId);
    }
  };

  const handlePointerMove = (event) => {
    if (!isPointerDown) {
      return;
    }
    if (Number.isInteger(event.buttons) && (event.buttons & 1) === 0) {
      queueLatestRunAtClientPoint(event.clientX, event.clientY);
      isPointerDown = false;
      releasePointerCaptureIfHeld(event);
      return;
    }
    queueLatestRunAtClientPoint(event.clientX, event.clientY);
  };

  const handlePointerUp = (event) => {
    if (!isPrimaryPointerEvent(event)) {
      return;
    }
    if (!isPointerDown) {
      return;
    }
    queueLatestRunAtClientPoint(event.clientX, event.clientY);
    isPointerDown = false;
    releasePointerCaptureIfHeld(event);
  };

  const handlePointerCancel = (event) => {
    isPointerDown = false;
    releasePointerCaptureIfHeld(event);
  };

  shell.isochroneCanvas.addEventListener('pointerdown', handlePointerDown);
  shell.isochroneCanvas.addEventListener('pointermove', handlePointerMove);
  shell.isochroneCanvas.addEventListener('pointerup', handlePointerUp);
  shell.isochroneCanvas.addEventListener('pointercancel', handlePointerCancel);

  const initialNodeIndex = parseNodeIndexFromLocationSearch(
    globalThis.location?.search ?? '',
    mapData.graph.header.nNodes,
  );
  if (initialNodeIndex !== null) {
    const allowedModeMask = getAllowedModeMaskFromShell(shell);
    void runFromNodeIndex(initialNodeIndex, allowedModeMask).catch((error) => {
      setRoutingStatus(shell, 'Routing failed.');
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
    isPointerDown = false;
    queuedClientPoint = null;
    queuedNodeIndex = null;
    lastCompletedClientPoint = null;
    lastCompletedNodeIndex = null;

    shell.isochroneCanvas.removeEventListener('pointerdown', handlePointerDown);
    shell.isochroneCanvas.removeEventListener('pointermove', handlePointerMove);
    shell.isochroneCanvas.removeEventListener('pointerup', handlePointerUp);
    shell.isochroneCanvas.removeEventListener('pointercancel', handlePointerCancel);
  };

  return {
    dispose,
    runFromCanvasPixel,
    requestIsochroneRedraw,
  };
}
