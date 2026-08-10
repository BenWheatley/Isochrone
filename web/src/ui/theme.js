// Reads back the theme the document is actually showing. data-theme pins an
// explicit light/dark choice; anything else (including "auto", the default)
// follows the OS preference, matching the @media (prefers-color-scheme)
// block in styles.css so canvas colours and page chrome always agree.

export function resolveIsochroneTheme(rootElement = globalThis.document?.documentElement ?? null) {
  const datasetTheme = rootElement?.dataset?.theme ?? null;
  if (datasetTheme === 'light' || datasetTheme === 'dark') {
    return datasetTheme;
  }
  // 'auto' (or no explicit choice yet) follows the OS/browser preference,
  // same signal the CSS @media (prefers-color-scheme: dark) block reacts
  // to, so canvas colours and page chrome always agree.
  const prefersDark = globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true;
  return prefersDark ? 'dark' : 'light';
}
