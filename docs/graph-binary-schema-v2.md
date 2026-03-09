# Graph Binary Schema v2

This document defines the current exported graph binary contract and versioning policy.

## Versioning policy
- Writers export `version = 2`.
- Tooling readers/validators accept both `v1` and `v2` payloads.
- `v1` payloads are interpreted as having zeroed edge metadata (`mode_mask = 0`, `maxspeed_kph = 0`, `road_class_id = 0`).
- Runtime migration policy: browser routing can require `v2` after mode-aware costing is implemented end-to-end.

## Edge record (12 bytes, v2)

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
- `mode_mask`: currently `walk` bit only.
- `maxspeed_kph`: parsed from `maxspeed`, with directional override:
  - forward edge prefers `maxspeed:forward` when present
  - backward edge prefers `maxspeed:backward` when present
  - otherwise falls back to `maxspeed` or `0`
- `road_class_id`: deterministic ID derived from `highway=*`.

## Cost strategy decision
- Chosen strategy: runtime bike/car costing from edge geometry + metadata.
- Transitional rule: keep existing precomputed `cost_seconds` (walking) for MVP compatibility.
- Follow-up phases add mode-aware cost functions without changing the on-disk edge record size.

## Reserved restriction bits
`flags` keeps dedicated bitspace for future legality constraints. In v2 foundation these bits are
already populated as presence markers (not yet enforced by routing):
- bit `8`: `oneway` tag present on source way
- bit `9`: `oneway:bicycle` tag present on source way
- bit `10`: `junction=roundabout` tag present on source way
- bit `11`: directional speed tags present (`maxspeed:forward` or `maxspeed:backward`)
