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
- `maxspeed_kph`: parsed from `maxspeed` tag when present; otherwise `0`.
- `road_class_id`: deterministic ID derived from `highway=*`.

## Cost strategy decision
- Chosen strategy: runtime bike/car costing from edge geometry + metadata.
- Transitional rule: keep existing precomputed `cost_seconds` (walking) for MVP compatibility.
- Follow-up phases add mode-aware cost functions without changing the on-disk edge record size.

## Reserved restriction bits
`flags` keeps dedicated reserved space for future legality constraints (no enforcement in v2 foundation yet):
- bit `8`: turn/access restriction group A (reserved)
- bit `9`: turn/access restriction group B (reserved)
- bit `10`: turn/access restriction group C (reserved)
- bit `11`: dynamic/legal access override (reserved)
