# Third-party notices

This project redistributes the third-party assets and data listed below. Each
entry states what is redistributed, under which licence, and what the licence
requires us to carry.

## Material Symbols (icon font)

- **What:** `web/fonts/material-symbols-subset.woff2` — the transport-mode icons
  in the Options panel (`directions_walk`, `directions_bike`, `directions_car`,
  `directions_boat`, `directions_bus`) and the `menu` glyph on the Options
  button itself.
- **Copyright:** © Google LLC
- **Licence:** Apache License 2.0 — full text in
  [`web/fonts/LICENSE-Apache-2.0.txt`](web/fonts/LICENSE-Apache-2.0.txt)
- **Source:** <https://github.com/google/material-design-icons> /
  <https://fonts.google.com/icons>
- **Modifications:** The upstream font has been **subset** to only the six
  glyphs listed above (obtained via the Google Fonts CSS API's `icon_names`
  subsetting, reducing ~4 MB to ~2 KB). No glyph outlines were altered. This
  note satisfies the Apache-2.0 §4(b) requirement to state that the files were
  changed.

The font is self-hosted rather than loaded from Google's CDN, so viewing the app
sends no request to Google.

Because the file holds only those six glyphs, **adding an icon to the UI means
regenerating the subset first** - otherwise the new ligature renders as its own
literal text (`menu`, `directions_train`, ...). Ask the CSS API for the full
list, then download the `src` URL it returns:

```bash
curl -A "Mozilla/5.0" "https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined&icon_names=directions_bike,directions_boat,directions_bus,directions_car,directions_walk,menu"
```

Update the glyph list above, and the count in the `@font-face` comment in
`web/src/styles.css`, to match.

## OpenStreetMap data

- **What:** the routing graph and the district/coastline/forest/water/airport
  basemap layers, built by `data_pipeline/` into
  `data_pipeline/output/`.
- **Copyright:** © OpenStreetMap contributors
- **Licence:** Open Database License (ODbL) —
  <https://www.openstreetmap.org/copyright>

Attribution is shown in the app footer and embedded in every exported SVG.

## Public transit data (per region)

GTFS stop and connection tables, folded into the routing graph of the region
they belong to. Each feed is licensed on condition of attribution, so each is
credited separately.

### Berlin

- **Copyright:** © VBB (Verkehrsverbund Berlin-Brandenburg)
- **Licence:** Creative Commons Attribution 4.0 (CC BY 4.0) —
  <http://www.vbb.de/vbbgtfs>
- **Note:** fetched via the `vbb-gtfs.jannisr.de` mirror because VBB's own
  `gtfs.zip` has a reproducibly corrupted `stop_times.txt` entry. VBB remains
  the licence holder to credit; the mirror is a technical detail.

### Adelaide

- **Copyright:** © Adelaide Metro — Department for Infrastructure and
  Transport, South Australia
- **Licence:** Creative Commons Attribution 4.0 (CC BY 4.0) —
  <https://data.sa.gov.au/data/dataset/https-gtfs-adelaidemetro-com-au>
- **Note:** licence confirmed 2026-08-17 against the publisher's own CKAN API
  (`license_id=cc-by`). The feed covers South Australia state-wide; the build
  clips it to the region extent.

Attribution is shown in the app footer, and in exported SVGs and printed
output, whenever a region with transit data is loaded. The operator, licence
name and link travel with the region in the locations manifest rather than
being hardcoded, so adding a feed cannot ship uncredited data — a pipeline
test fails if a configured feed has no attribution block.
