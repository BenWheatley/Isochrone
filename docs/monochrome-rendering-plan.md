# Monochrome rendering plan

Making the isochrone read correctly on devices with no colour: black-and-white
printers, basic e-Ink, and for viewers with total colourblindness
(achromatopsia).

Status: **in progress on branch `true-monochrome`.** Written 2026-08-21; grid
allocation section revised 2026-08-23 once that work landed; the cyclic
question settled 2026-08-31 (see "The cyclic problem"), and contour extraction
implemented.

## Why the current output fails

The palette encodes time as hue, cycling every `cycleMinutes`. Converting both
themes to perceptual luminance (sRGB relative luminance, expressed 0-255):

| Band | Time (60 min cycle) | Light theme | grey | Dark theme | grey |
| --- | --- | --- | --- | --- | --- |
| 0 | 0-12 min | blue | 40 | cyan | 201 |
| 1 | 12-24 min | green | 57 | green | 186 |
| 2 | 24-36 min | gold | 74 | yellow | 238 |
| 3 | 36-48 min | orange | 43 | orange | 102 |
| 4 | 48-60 min | magenta | 25 | pink | 70 |

Two distinct failures, and the second is the more damaging:

1. **Separability.** In the light theme, bands 0 and 3 are three grey levels
   apart out of 255 - identical once printed. Six of the ten band pairs fall
   within 25 levels. The dark theme is better but still collides bands 0 and 1
   (201 vs 186).
2. **Ordering.** Greyscale order is 4, 0, 3, 1, 2 (light) and 4, 3, 1, 0, 2
   (dark) - neither is monotonic in time. So even where two bands *are*
   distinguishable, darker does not mean nearer. This is not fixable by
   retuning: hue has no intrinsic luminance order.

Both numbers above are reproducible from `ISOCHRONE_PALETTE_LIGHT` /
`ISOCHRONE_PALETTE_DARK` in `web/src/render/colour.js`.

## The decision this plan rests on

Recolouring the existing render - dashes, greys, patterned strokes - would make
the output *legible* but not *good*. In colour, the eye separates half a
million overlapping line segments by hue; remove hue and a dense region is a
grey mass however the strokes are patterned. Density itself becomes the
problem.

So monochrome changes **what is drawn**, not just how it is coloured: filled,
hatched isochrone bands bounded by labelled contours, which is what a
monochrome map would actually do.

The existing colour palette stays exactly as it is. Monochrome is a separate
rendering mode, not a re-tint of the current one.

## Where the regions come from

The isochrone is computed on the road network, so "reachable area" is already
an interpolation - a claim that the space between roads is reachable, which it
is not. Any 2D region is a rendering fiction; the question is only which
construction is cheapest and most robust.

Two candidate constructions were considered.

**Rejected: polygon buffer and union of the exported band geometry.** The SVG
exporter already groups edges into one `<path>` per colour band, but that path
is ~100k *disjoint line segments*, not a closed shape - there is no boundary to
take. Producing a region means buffering every segment by a radius and unioning
the results: a full 2D boolean geometry engine (Clipper2/Martinez) over ~100k
shapes per band, with floating-point robustness as the classic failure mode and
vertex counts that explode along every cul-de-sac. It also does not avoid an
arbitrary parameter, since the buffer radius plays exactly the role a raster
cell size would.

**Chosen: rasterise the per-band vector geometry, then contour it.** The vector
edge geometry remains the source of truth; a raster is used only as a transient
rendering intermediate, sized to the output (a poster is ~4576px wide), then
discarded. Marching squares over that gives closed rings directly.

Note this is not "use the rasteriser as the source of truth" - the existing
`paintAllReachableEdgeInterpolationsToTravelTimeGrid` walks *the same
interpolated edge geometry* and writes it into cells, so raster and vector are
the same information at different fidelity, not rival models. What this plan
avoids is the *persistent, graph-sized* grid; see "Interaction with grid
allocation" below.

### Why contouring wins on the two hard cases

- **Holes** (unreachable pockets: parks, industrial land, water) come out as
  interior rings. Classify parent/child by containment and fill even-odd.
- **Disjoint regions** (a transit isochrone lands in several places at once)
  come out as separate connected components for free. This is the case that
  would cost the most under buffer-and-union for the least benefit.

## Encoding: `timeToFillPattern`

The monochrome analogue of `timeToColour`, and it slots in at the same seam.
Returns a hatch specification per band rather than an RGB triple.

Design constraints:

- **Patterns need a luminance test, like colours do.** A hatch's perceived tone
  is its ink coverage ratio, which is directly measurable: render each pattern
  tile at print resolution, measure mean coverage, assert adjacent bands differ
  by a set margin. This is a stronger test than the colour one, because it also
  catches a pattern so dense it reads as flat grey.
- **`patternUnits="userSpaceOnUse"`**, so hatches do not rescale with the shape
  they fill. Otherwise a large band and a small band acquire different apparent
  textures.
- **A solid hairline contour between bands.** At 1 bit, adjacent hatches moire
  into each other; a separating line kills that, and gives labels something to
  sit on.

## The cyclic problem

Bands repeat every `cycleMinutes`. Filled and hatched, band 6 is
indistinguishable from band 1 - worse than with colour, where repetition at
least reads as repetition.

**Decided 2026-08-31: labels, and the cycle stays.**

Contour labels ("36 min") are mandatory, on the same footing as isobar values
on a weather chart or height figures on an Ordnance Survey sheet - and for the
same reason. A contour map without values on the contours is a picture of a
gradient, not a measurement. Capping at a single cycle was rejected outright:
an OS sheet does not stop drawing at 500 m, and neither should this.

An intermediate proposal - drop the modulo in monochrome so that bands run
monotonically over one cycle with an open-ended top band - was also rejected.
It buys unambiguity at the price of the map's range, which is the wrong trade
when labels can buy the same unambiguity and keep the range.

So monochrome keeps the cyclic structure the colour palette has: a repeating
cycle of *n* fill patterns, with the labels telling you which cycle you are
in. Both attached references do exactly this - Paullin's "Rates of Travel"
plates label every contour ("6wks.", "1 day", "36hrs.") and a two-tone
alternating fill with numbered regions carries the repeat.

`n` is deliberately not fixed here. Patterns need high contrast between
neighbours, and it may turn out that the honest answer at 1 bit is n=2 -
literally "none" and "some". That is not guessable from first principles, so
the encoding takes `n` as a parameter and the number is settled by looking at
real output on real paper.

## Interaction with grid allocation

When this plan was written, `initializeMapData` allocated two
full-graph-sized grids eagerly and wrote to every cell - about 4 GB on
Portsmouth, whose grid was then sized to a ferry route reaching France. That
has since been fixed on three fronts: ferries no longer inflate a region's
extent, the grids are sized to the visible view rather than the graph, and
they are allocated only for a renderer that will actually read them, which a
WebGL renderer never does.

The constraint that fix implies for this plan still stands, and is the reason
the contouring raster must be **transient, sized to the output, and
discarded** rather than a persistent graph-sized buffer. A contouring pass
that allocated per region, at graph resolution, for the lifetime of the map
would reintroduce exactly what was removed.

## Verification

**Rasterise the output and look at it at 1:1.** `web/tools/render-monochrome.mjs`
writes an SVG; `rsvg-convert -w 1500 -b white out.svg -o out.png` turns it into
something that can actually be inspected. This is not a nicety. Reviewing the
SVG in a viewport that downscaled it hid, in turn: a water pattern that was
never drawn at all (a sub-pixel stroke snapped away by `crispEdges`), ferry
routes drawn as roads and striking off the sheet, and a coastline registered
kilometres from the road network it describes. Each was obvious within seconds
of looking at a raster, and invisible for two rounds without one.

Note also that a "detail view" of an SVG is meaningless - it is vector, the
reader can zoom. A detail *raster* is worth producing.

"Looks fine to me" is how the current palette shipped, so:

- **Pattern coverage test.** Per above - objective, and cheap to run in CI.
- **Render, desaturate, measure.** Screenshot a region, convert to luminance,
  sample within each band, assert separation. Catches the patterns being right
  but the rendering washing them out.
- **1-bit threshold test.** The same image hard-thresholded, confirming bands
  remain distinguishable once greys are gone.
- **Geometry tests** on the contour extraction: a synthetic field with a known
  hole and a known disjoint component must produce the expected ring counts and
  containment.
- Actual paper is a human check; it cannot be automated here.

**Anything drawn alongside the isochrone must go through
`projectBoundaryBasemapToGraphPaths`.** The boundary payload carries its own
projected origin and extent, and they are not the graph's - for Portsmouth the
origins differ by 2.4 km east and 14.2 km north, and the extents by a factor of
1.23. Rescaling one onto the other, rather than projecting it, puts the
coastline nowhere near the roads it belongs to.

## Suggested sequencing

1. Contour extraction from a transient per-band raster, with the geometry
   tests. No UI yet.
2. `timeToFillPattern` plus the coverage test; SVG `<pattern>` definitions.
3. Monochrome mode in the export/print path, with hairline contours and the
   legend showing real hatch samples rather than tone swatches.
4. Contour labelling - or the decision to cap at one cycle instead.
5. Screen rendering, if wanted. Note that e-Ink and achromatopsia are
   *live-viewing* cases, so screen support is what those two of the three
   stated targets actually need; export-only would serve the printer case only.

## Open questions

- Contour labels, or cap monochrome at a single cycle?
- Is monochrome an explicit theme choice alongside auto/light/dark, or does it
  engage automatically for print? Recommendation: explicit. Auto-switching on
  print would surprise anyone with a colour printer.
- Do the basemap layers (water, forest, airports, waterways) get their own
  hatches in monochrome, or drop to plain outlines?
