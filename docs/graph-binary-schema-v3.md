# Graph Binary Schema v3

This document defines the current exported graph binary contract and versioning policy.

## Versioning policy
- Writers export `version = 3`.
- Pipeline tooling readers/validators accept `v1`, `v2` and `v3` payloads for inspection and migration support.
- `v1` payloads are interpreted as having zeroed edge metadata (`mode_mask = 0`, `maxspeed_kph = 0`, `road_class_id = 0`).
- Browser runtime accepts `v2` and `v3`, and rejects older payloads. A `v2`
  payload reads back as having no stop-to-stop transfers, which is exactly what
  it means: see the stop record below.

## Stop record (24 bytes, v3)

| Offset | Type   | Field |
|--------|--------|-------|
| 0      | int32  | `x_m` |
| 4      | int32  | `y_m` |
| 8      | uint32 | `nearest_node_index` |
| 12     | uint32 | `first_transfer_index` |
| 16     | uint16 | `transfer_count` |
| 18     | uint8  | `transport_type` |
| 19     | uint8  | reserved |
| 20     | uint32 | `name_offset` (string table not implemented) |

The record size is unchanged from v2. Offsets 12 and 16 held
`first_tedge_index` / `tedge_count`, reserved for a per-stop index into the
transit-edge table that nothing ever needed — the Connection Scan reads that
table as one departure-ordered sweep — and were always written as zero. v3
spends them on the CSR range into the transfer table instead, which is why a
v2 payload reads as "no transfers" rather than as corrupt.

Every stop carries the running offset, including one with no transfers, so
that the last stop's `first_transfer_index + transfer_count` is the table's
total length.

## Transfer record (8 bytes, v3)

| Offset | Type   | Field |
|--------|--------|-------|
| 0      | uint32 | `to_stop_index` |
| 4      | uint16 | `walk_distance_m` |
| 6      | uint16 | `min_transfer_seconds` (`0` = feed did not say) |

Walkable connections between stops, which is what lets a rider change vehicle:
a feed names each platform and each direction of travel as a separate stop, so
without these the scan can only chain connections sharing a stop id.

Distances are stored in metres rather than seconds because walking speed is a
user preference, and every walk edge costs `distance / speed` with motorways
excluded — so the shortest walking path is the same at any speed and a stored
distance stays valid.

They are produced by routing over the walk graph, not by straight-line
distance between stop coordinates: two stops facing each other across a river
are metres apart and a long walk from one another. Measured against Berlin, of
the 15,407 pairs a 250 m straight-line rule would produce, 771 have no walk
route at all and 72.9% route more than 1.2× the straight line. Routing has the
opposite failure — where OSM has not joined two ways, a real interchange
disappears — so the routed set is unioned with the feed's own `transfers.txt`,
which also supplies `min_transfer_seconds` and removes pairs it marks
`transfer_type = 3`. In Berlin that recovers 246 interchanges routing missed.

The table follows the transit-edge table, and like it has no offset field of
its own: the 64-byte header is full, so both writer and reader derive the
offset the same way.

Self-transfer rows (`from_stop_id == to_stop_id`, "changing here takes five
minutes") are deliberately ignored. Honouring one needs a trip id to tell a
change from staying aboard the same vehicle through the stop, and the
transit-edge record does not carry one.

## Edge record (12 bytes, unchanged since v2)

The record size is unchanged from v1; metadata is packed into the final `uint32` word.

| Offset | Type   | Field |
|--------|--------|-------|
| 0      | uint32 | `target_node_index` |
| 4      | uint16 | `cost_seconds` (walking cost for current MVP runtime) |
| 6      | uint16 | `flags` |
| 8      | uint32 | `packed_metadata` |

`packed_metadata` bit layout:
- bits `0..7`: `mode_mask`
- bits `8..15`: `road_class_id`
- bits `16..31`: `maxspeed_kph`

## Current extraction defaults (v2 foundation)
- `mode_mask`: derived from highway defaults plus access-tag conflict resolution.
- `maxspeed_kph`: parsed from `maxspeed`, with directional override:
  - forward edge prefers `maxspeed:forward` when present
  - backward edge prefers `maxspeed:backward` when present
  - otherwise falls back to `maxspeed` or deterministic highway/mode defaults
- `road_class_id`: deterministic ID derived from `highway=*`.

## Access conflict resolution order
Mode permissions are derived deterministically from combined tags:
1. Start from highway defaults (`walk` always, plus class-based bike/car defaults).
2. Apply `access=*` global allow/deny.
3. Apply mode overrides in fixed order: `foot`, `bicycle`, `vehicle`, `motor_vehicle`.
4. Final mode bits are stored in `mode_mask`.

## Fallback speed policy
When explicit speed tags are absent/unusable:
- Use highway + mode fallback tables (`walk`, `bike`, `car`).
- Choose the maximum allowed-mode fallback as stored `maxspeed_kph` for that directed edge.

## Cost strategy decision
- Chosen strategy: runtime bike/car costing from edge geometry + metadata.
- Transitional rule: keep existing precomputed `cost_seconds` (walking) in the binary while runtime bike/car costs are derived from metadata.
- Follow-up phases add mode-aware cost functions without changing the on-disk edge record size.

## Reserved restriction bits
`flags` keeps dedicated bitspace for future legality constraints. In v2 foundation these bits are
already populated as presence markers (not yet enforced by routing):
- bit `8`: `oneway` tag present on source way
- bit `9`: `oneway:bicycle` tag present on source way
- bit `10`: `junction=roundabout` tag present on source way
- bit `11`: directional speed tags present (`maxspeed:forward` or `maxspeed:backward`)
