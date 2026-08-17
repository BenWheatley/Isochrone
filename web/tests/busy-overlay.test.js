import assert from 'node:assert/strict';
import test from 'node:test';

import {
  hideBusyOverlay,
  runWithBusyOverlay,
  showBusyOverlay,
  waitForNextPaint,
} from '../src/ui/busy-overlay.js';

function createShellStub() {
  return {
    busyOverlay: { hidden: true },
    busyOverlayText: { textContent: '' },
  };
}

test('showBusyOverlay reveals the overlay and sets its message', () => {
  const shell = createShellStub();

  assert.equal(showBusyOverlay(shell, 'Preparing the vector map...'), true);
  assert.equal(shell.busyOverlay.hidden, false);
  assert.equal(shell.busyOverlayText.textContent, 'Preparing the vector map...');

  assert.equal(hideBusyOverlay(shell), true);
  assert.equal(shell.busyOverlay.hidden, true);
});

test('busy overlay helpers tolerate a shell without the overlay elements', () => {
  assert.equal(showBusyOverlay({}, 'x'), false);
  assert.equal(hideBusyOverlay({}), false);
  assert.equal(showBusyOverlay(null, 'x'), false);
});

test('runWithBusyOverlay paints before starting the blocking work', async () => {
  // The whole point: the export build is synchronous, so if the work started
  // before the browser painted, the overlay would never appear at all.
  const shell = createShellStub();
  const order = [];

  const result = await runWithBusyOverlay(
    shell,
    'Preparing...',
    () => {
      order.push(`work (overlay hidden=${shell.busyOverlay.hidden})`);
      return 'built';
    },
    {
      waitForPaint() {
        order.push(`paint (overlay hidden=${shell.busyOverlay.hidden})`);
        return Promise.resolve();
      },
    },
  );

  assert.equal(result, 'built');
  assert.deepEqual(order, ['paint (overlay hidden=false)', 'work (overlay hidden=false)']);
  assert.equal(shell.busyOverlay.hidden, true);
});

test('runWithBusyOverlay takes the overlay down even when the work throws', async () => {
  const shell = createShellStub();

  await assert.rejects(
    runWithBusyOverlay(
      shell,
      'Preparing...',
      () => {
        throw new Error('build failed');
      },
      { waitForPaint: () => Promise.resolve() },
    ),
    /build failed/,
  );
  assert.equal(shell.busyOverlay.hidden, true);
});

test('runWithBusyOverlay rejects work that is not callable', async () => {
  await assert.rejects(
    () => runWithBusyOverlay(createShellStub(), 'x', null),
    /work must be a function/,
  );
});

test('waitForNextPaint waits two frames, and falls back without requestAnimationFrame', async () => {
  // Two frames, because the first fires before the pending style change has
  // been painted.
  let frames = 0;
  const windowStub = {
    requestAnimationFrame(callback) {
      frames += 1;
      setTimeout(callback, 0);
    },
  };
  await waitForNextPaint(windowStub);
  assert.equal(frames, 2);

  // No rAF at all (a non-browser host): resolve rather than hang.
  await waitForNextPaint({});
});

test('waitForNextPaint resolves even if frames never fire', async () => {
  // Background tabs can starve requestAnimationFrame indefinitely; the export
  // must still run rather than wedging behind an overlay forever.
  await waitForNextPaint({ requestAnimationFrame() {} });
});
