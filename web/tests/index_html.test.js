import { describe, expect, it } from 'vitest';

import { readFileSync } from 'node:fs';

const indexHtml = readFileSync(new globalThis.URL('../index.html', import.meta.url), 'utf-8');

describe('index.html shell', () => {
  it('includes required map canvas and loading overlay', () => {
    expect(indexHtml).toMatch(/<canvas[^>]*id="map"/i);
    expect(indexHtml).toMatch(/<div[^>]*id="loading"/i);
  });

  it('includes time input defaulting to 08:00', () => {
    expect(indexHtml).toMatch(/<input[^>]*type="time"/i);
    expect(indexHtml).toMatch(/value="08:00"/i);
  });

  it('loads the bundled app script from dist', () => {
    expect(indexHtml).toMatch(/<script[^>]*src="\.\/dist\/app\.js"/i);
  });
});
