# Third-party notices

This project redistributes the third-party assets and data listed below. Each
entry states what is redistributed, under which licence, and what the licence
requires us to carry.

## Material Symbols (icon font)

- **What:** `web/fonts/material-symbols-subset.woff2` — the transport-mode icons
  in the Options panel (`directions_walk`, `directions_bike`, `directions_car`,
  `directions_boat`, `directions_bus`).
- **Copyright:** © Google LLC
- **Licence:** Apache License 2.0 — full text in
  [`web/fonts/LICENSE-Apache-2.0.txt`](web/fonts/LICENSE-Apache-2.0.txt)
- **Source:** <https://github.com/google/material-design-icons> /
  <https://fonts.google.com/icons>
- **Modifications:** The upstream font has been **subset** to only the five
  glyphs listed above (obtained via the Google Fonts CSS API's `icon_names`
  subsetting, reducing ~4 MB to ~2 KB). No glyph outlines were altered. This
  note satisfies the Apache-2.0 §4(b) requirement to state that the files were
  changed.

The font is self-hosted rather than loaded from Google's CDN, so viewing the app
sends no request to Google.

## OpenStreetMap data

- **What:** the routing graph and the district/coastline/forest/water/airport
  basemap layers, built by `data_pipeline/` into
  `data_pipeline/output/`.
- **Copyright:** © OpenStreetMap contributors
- **Licence:** Open Database License (ODbL) —
  <https://www.openstreetmap.org/copyright>

Attribution is shown in the app footer and embedded in every exported SVG.

## VBB public transit data (Berlin only)

- **What:** GTFS stop and connection tables folded into the Berlin routing
  graph.
- **Copyright:** © VBB (Verkehrsverbund Berlin-Brandenburg)
- **Licence:** Creative Commons Attribution 4.0 (CC BY 4.0) —
  <http://www.vbb.de/vbbgtfs>

Attribution is shown in the app footer, and in exported SVGs, whenever a region
with transit data is loaded.
