# Isochrone

An isochrone map shows how far one can travel in a given time. This
application computes that reachable area across an entire road and public
transport network, in the browser, from a point chosen on the map — and
recomputes it in a fraction of a second as the departure point, transport
mode, departure time or travelling speed is changed.

**[Open the application](https://benwheatley.github.io/Isochrone/web/)**

Sixteen regions are available, across five continents. Routing is exact
rather than approximate: a full travel-time field is computed over every
reachable node in the network, with no distance cut-off and no server round
trip. Where a region carries timetable data, journeys combine walking with
scheduled public transport at a departure time of the reader's choosing.

The result may be exported as vector artwork, or printed as a poster, with
the map, legend, scale bar and data attributions laid out for the page.

There is no account, no tracking, and no analytics.

## Contents

- [Capabilities](#capabilities)
- [Using the map](#using-the-map)
- [How it works](#how-it-works)
- [Regions and data](#regions-and-data)
- [Development](#development)
- [Repository structure](#repository-structure)
- [Third-party licences](#third-party-licences)
- [Project licence](#project-licence)

## Capabilities

**Transport modes.** Walking, cycling, driving, ferry and public transport,
selectable in combination. Walking and cycling speeds are adjustable. A ferry
requires both the ferry mode and a mode in which its vessel may be boarded, so
a foot-passenger service is available to a pedestrian and a vehicle service is
not.

**Public transport.** Where a region carries a GTFS feed, the isochrone
accounts for scheduled services from a chosen departure date and time, subject
to a configurable limit on the walking distance permitted at either end of a
transit leg.

**Presentation.** Light and dark themes; metric and imperial units, defaulting
to the reader's own locale rather than the region displayed; an adjustable
colour period, the interval after which the isochrone's colour bands repeat.

**Localisation.** English, German and French.

**Export.** Vector SVG and print output, both laid out as a poster rather than
as a screen capture: title, colour legend, scale bar and the required data
attributions are composed for the page, and the map is drawn as vector
geometry throughout.

## Using the map

| Action | Desktop | Touch |
| --- | --- | --- |
| Choose an origin | Primary click | Single tap |
| Pan | Primary drag | Two-finger drag |
| Zoom | Mouse wheel | Two-finger pinch |
| Move the origin | Secondary drag | — |

Panning and zooming redraw the existing result; neither begins a new
calculation.

The region, origin node, transport modes, speeds, departure time, colour
period and interface language are all held in the URL, so that any particular
view may be bookmarked or shared. For example,
`?region=berlin&modes=walk,transit&cycle=60&lang=de`.

Themes, units, pointer-button assignment and the remaining controls are found
under **Options** in the header.

## How it works

The application is built around the observation that an isochrone is a
shortest-path problem over a network, not an image-processing problem over a
grid. Travel times are therefore computed on the network itself and rendered
from it directly.

**Preprocessing.** A Python pipeline retrieves OpenStreetMap extracts through
the Overpass API, projects them into an appropriate metric coordinate system,
simplifies degree-two chains, and emits a compact binary graph. Where a region
carries timetable data, GTFS stops and connections are folded into the same
file. The binary format is documented in
[Graph Binary Schema v2](docs/graph-binary-schema-v2.md).

**Routing.** A Rust kernel compiled to WebAssembly performs the search. For a
region with public transport this runs in three stages: a pedestrian search
from the origin, a Connection Scan over the timetable seeded from the stops
that search reached, and a second multi-source search reseeded at every stop
the timetable improved. The kernel is required; there is no JavaScript
fallback for routing.

**Rendering.** Edges are drawn by the GPU, with each endpoint's travel time
interpolated along the edge, so a road crossed midway is shaded accordingly.
A 2D canvas path exists for browsers without WebGL.

Edge traversal costs are derived at query time from a single stored length per
edge, which is why changing a walking speed or a transport mode re-renders
without returning to the network.

## Regions and data

Sixteen regions are configured: Adelaide, Athens, Berlin, Canton of Zurich,
Cologne, Cyprus, London, Luxembourg, Mexico City, Nairobi, Ottawa, Paris,
Portsmouth, Rhode Island, Rome and Singapore.

Berlin and Adelaide additionally carry public transport timetables. Further
regions may be added; the procedure, and a survey of candidate timetable feeds
together with their licensing, are set out in
[Setup and Region Onboarding](docs/setup-and-regions.md) and the
[Transit Feed Registry](docs/transit_feed_registry.md).

## Development

Installation, routine commands, the data pipeline, benchmarking, deployment
and the procedure for adding a region are documented separately in
[Setup and Region Onboarding](docs/setup-and-regions.md).

In brief:

```bash
make bootstrap
make check
python -m http.server 8000
```

Further reading:

- [Delivery plan and architecture roadmap](PLAN.md)
- [Graph Binary Schema v2](docs/graph-binary-schema-v2.md)
- [WASM Routing Kernel](docs/wasm-routing-kernel.md)
- [Region Data Pipeline](docs/region-data-pipeline.md)
- [Monochrome rendering plan](docs/monochrome-rendering-plan.md)
- [Agentic Coding Guidelines](docs/agentic-coding-guidelines.md)

This repository is configured for autonomous-agent workflows: a single quality
gate (`make check`) covering Python, JavaScript and Rust; explicit agent rules
in `AGENTS.md`; continuous integration on pull requests; and pre-commit hooks
for local feedback.

## Repository structure

| Path | Contents |
| --- | --- |
| `data_pipeline/` | Preprocessing pipeline, region configuration, and generated artifacts |
| `wasm/routing-kernel/` | Rust routing kernel |
| `web/` | Browser application (vanilla JavaScript modules, no bundler) |
| `docs/` | Design and process documentation |
| `PLAN.md` | Delivery plan and architecture roadmap |
| `THIRD_PARTY_NOTICES.md` | Licences for redistributed assets and data |

## Third-party licences

- Map data © OpenStreetMap contributors, available under the Open Database
  License (ODbL).
- Berlin public transport data © VBB (Verkehrsverbund Berlin-Brandenburg),
  available under CC BY 4.0.
- Adelaide public transport data © Adelaide Metro — Department for
  Infrastructure and Transport, South Australia, available under CC BY 4.0.
- Transport-mode icons from Google's Material Symbols, available under the
  Apache License 2.0, subset and self-hosted.

Full notices, including the obligations each licence imposes, are recorded in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Attribution is carried in the
application footer and in every exported and printed document, and is drawn
from the region's own configuration rather than being fixed in the interface.

## Project licence

No licence has yet been declared for the source code in this repository. In the
absence of one, default copyright applies and no permission to use, modify or
redistribute the code is granted. This is distinct from the third-party data
and assets above, which carry their own licences and obligations.
