# Transit feed registry

Candidate GTFS sources for the regions in `data_pipeline/regions.json`, for
deciding which region gets public transport support next.

**Except where a row says "verified", read the licence column as "where to
look and what to expect", not as fact.** Feed URLs and licence terms change
more often than almost anything else in this space, and the candidate rows
below have *not* been fetched or checked against their publishers. Confirm at
fetch time, the way Berlin's and Adelaide's were. The confidence column says
how much to trust the row, not how good the data is.

Survey date: 2026-08-17.

## Configured

| Region | Source | Licence | Notes |
| --- | --- | --- | --- |
| berlin | VBB, mirrored via `vbb-gtfs.jannisr.de` | CC BY 4.0 | Mirror used because VBB's own `gtfs.zip` has a reproducibly corrupted `stop_times.txt` entry. VBB remains the licence holder to credit. Served as loose CSVs, hence `archiveFormat: "files"`. |
| adelaide | Adelaide Metro (Department for Infrastructure and Transport) | CC BY 4.0 — **verified** | Licence confirmed 2026-08-17 against data.sa.gov.au's CKAN API (`license_id=cc-by`). Feed URL from Adelaide Metro's own OpenAPI spec: `/v1/static/latest/google_transit.zip`; guessed paths 403. State-wide feed, clipped to the region like VBB's is to Brandenburg. **Built and deployed** 2026-08-20: 7,353 stops attached, 917,563 connections. The region was rescoped from the CBD council (Q1094063, 4x5 km) to metropolitan Adelaide (rel(11381689), Q5112, 38x86 km), since a metro-wide feed on a CBD-sized region made no sense. |

## Strong candidates

National or regional feed, one authoritative source, licence expected to be
unambiguous.

| Region | Likely source | Expected licence | Confidence |
| --- | --- | --- | --- |
| zurich-canton | opentransportdata.swiss national GTFS | CC BY 4.0 | High |
| luxembourg-country | data.public.lu national GTFS | CC0 / CC BY | High |
| cologne | DELFI / gtfs.de Germany-wide GTFS | CC BY 4.0 | High |
| ottawa | OC Transpo via open.ottawa.ca | City of Ottawa OGL | High |
| portsmouth | UK Bus Open Data Service | OGL v3 | High, buses only — rail is a separate feed under separate terms |

## Workable, with friction

| Region | Likely source | Friction |
| --- | --- | --- |
| paris | IDFM via PRIM / data.gouv.fr | ODbL-ish, but PRIM wants a registered API key |
| london | TfL open data | Bespoke TfL licence, not a standard CC/ODbL — needs reading before we commit |
| rome | dati.comune.roma.it / ATAC | Licence varies by dataset (IODL vs CC BY) |
| rhode-island | RIPTA | Feed near-certainly exists; US agencies often publish with *no* explicit licence, which is the actual blocker |
| mexico-city | datos.cdmx.gob.mx | Split across operators; "Libre uso MX" terms |
| cyprus | National Access Point / motionbuscard | Medium confidence it is published at all |

## Problematic

| Region | Problem |
| --- | --- |
| singapore | LTA DataMall is not standard GTFS and its terms restrict redistribution. Community conversions exist; the licensing is the risk. |
| athens | OASA's GTFS has historically been intermittent and unclearly licensed. |
| nairobi | Digital Matatus GTFS exists and is openly licensed, but is frequency-based rather than a fixed timetable. The CSA scan reads concrete `stop_times`, so this needs frequency expansion first — pipeline work, not a config entry. |

## Recommended order

1. **zurich-canton.** The licence is the same shape as VBB's, so the existing
   multi-source attribution machinery (disclaimer, poster credits, docs) takes
   it with no new code. The Swiss feed is national, so the build clips it to
   the region bbox and keeps trips that touch it — exactly what already happens
   with the Brandenburg-wide VBB feed, meaning the second region tests the
   existing design rather than replacing it. The network is dense and
   multimodal, so the isochrone should visibly change along corridors. The
   region already carries ferries, so it exercises transit and water together.
2. **luxembourg-country**, deliberately as a contrast: a whole-country region
   exercises the *no clipping needed* path that Zurich will not, and the feed is
   small enough to iterate on in seconds.
3. **cologne** or **ottawa**, whichever is wanted first — both are single
   authoritative feeds with clear terms.

## Adding a feed

1. Add a `transitFeed` block to the region's entry in `data_pipeline/regions.json`:
   `baseUrl`, `archiveFormat` (`"zip"` for a single archive, `"files"` for one
   CSV per table), a free-text `licence` provenance note, and an `attribution`
   block (`operator`, `licenceName`, `url`). The attribution block is not
   optional in practice — a pipeline test fails if a configured feed lacks one,
   because shipping uncredited CC BY data breaches the licence.
2. `./data_pipeline/region-data.py fetch --only <id> --components transit`
3. `./data_pipeline/region-data.py build --only <id> --components graph,transit`

The attribution then flows automatically into the locations manifest, the app
footer, and SVG/print exports. Nothing needs editing in the web app or the
locale files: the sentence around the credit is translated, but the operator
name and licence come from the region.

## Known structural limit

`TransitFeedSpec` (`region_pipeline.py`) holds **one feed per region**. That
suits Zurich, Luxembourg, Cologne, Ottawa and Adelaide, which each have a
single authoritative source.

It does not suit london (bus and rail published separately), mexico-city
(per-operator) or rhode-island (RIPTA plus commuter rail). Those need several
feeds merged, which is a schema and pipeline change rather than a config
entry. If one of those regions is wanted specifically, do the multi-feed work
first rather than forcing a single feed in.
