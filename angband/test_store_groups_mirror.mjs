# tests/

Standalone verification scripts written while building v1.2–v1.6. Not wired
into a test runner (no vitest/jest is configured in this project) — just
plain Node scripts that either exercise the real source directly or a
deliberately-inlined copy of it, documented at the top of each file.

Run from the app root (`~/angband-app`, after `setup.sh` has copied this
folder in) so `node_modules` resolves normally:

## Pure-math verification (needs `three` — already an app dependency)
```
node tests/verify_rotation_math.mjs
node tests/verify_mirror_and_group_math.mjs
```
Cross-checks the floor-placement, mirror-reflection, and group-pivot
rotation math directly against THREE.js's own Matrix4/Quaternion output,
independently of anything this app does with them.

## Store logic (needs `zustand` — already an app dependency)
```
node tests/test_store_basic.mjs
node tests/test_store_groups_mirror.mjs
node tests/test_store_autopos_fix.mjs
```
`test_store_autopos_fix.mjs` specifically reproduces the bug where a part
that had never been individually dragged (position only ever resolved via
the client-side autoPos spiral layout, never persisted) would jump to the
world origin the first time its group was moved, rotated, or mirrored.

## Real source + real data (needs `sucrase-node`, already an app devDependency)
```
node_modules/.bin/sucrase-node tests/test_geo_cache_perf.ts
node_modules/.bin/sucrase-node tests/benchmark_add_parts.ts
```
These import `resolvePartGeo` and `CATALOGUE` directly from `src/` — not a
copy — and run against the actual 9,831-part catalogue. `test_geo_cache_perf`
checks correctness (cached vs. fresh-cache results, full-catalogue sanity
sweep) and measures the cache-hit speedup. `benchmark_add_parts` simulates
adding 1,000 different parts to the build one at a time — the realistic
workflow the v1.6 performance fixes targeted — and prints per-add timing.

## Pure logic, no dependencies
```
node tests/test_bucket_reuse.mjs
```
Simulates a sequence of realistic build edits (add, move one of several,
empty a bucket, no-op re-render, repopulate) and checks bucket *reference*
identity at each step, not just final values — this is what actually
determines whether InstancedBucket's Effect A re-runs.
