// A modal "working on it" overlay for the one operation that blocks the main
// thread long enough to look like a hang: building the vector export. On
// Berlin that is ~2.7s of synchronous string building for half a million
// segments, during which nothing repaints - not even the button the user just
// pressed.

/**
 * Resolves after the browser has had a chance to paint.
 *
 * Two frames, not one: the first fires before the pending style/layout change
 * has been painted, so work started there would still block the very frame
 * that was meant to show the overlay. A timeout backstop keeps this from
 * hanging in a background tab, where rAF may never fire.
 */
export function waitForNextPaint(windowObject = globalThis) {
  const requestFrame = typeof windowObject?.requestAnimationFrame === 'function'
    ? windowObject.requestAnimationFrame.bind(windowObject)
    : null;
  if (requestFrame === null) {
    return new Promise((resolve) => { setTimeout(resolve, 0); });
  }
  return new Promise((resolve) => {
    let settled = false;
    const settle = () => {
      if (settled) {
        return;
      }
      settled = true;
      resolve();
    };
    requestFrame(() => {
      requestFrame(settle);
    });
    setTimeout(settle, 250);
  });
}

export function showBusyOverlay(shell, message) {
  if (!shell || typeof shell !== 'object' || !shell.busyOverlay) {
    return false;
  }
  if (shell.busyOverlayText && typeof message === 'string' && message.length > 0) {
    shell.busyOverlayText.textContent = message;
  }
  shell.busyOverlay.hidden = false;
  return true;
}

export function hideBusyOverlay(shell) {
  if (!shell || typeof shell !== 'object' || !shell.busyOverlay) {
    return false;
  }
  shell.busyOverlay.hidden = true;
  return true;
}

/**
 * Runs blocking work with the overlay up, guaranteeing it is painted first and
 * taken down afterwards even if the work throws.
 */
export async function runWithBusyOverlay(shell, message, work, options = {}) {
  if (typeof work !== 'function') {
    throw new Error('work must be a function');
  }
  const waitForPaint = options.waitForPaint ?? waitForNextPaint;
  showBusyOverlay(shell, message);
  try {
    await waitForPaint();
    return await work();
  } finally {
    hideBusyOverlay(shell);
  }
}
