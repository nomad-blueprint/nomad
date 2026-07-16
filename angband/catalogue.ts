/**
 * Viewport3D.tsx — ANGBAND
 *
 * v1.6 — Bucket-level reuse, callback stability (performance)
 * ─────────────────────────────────────────────────────────────────────────────
 * Triggered by the same investigation as the v1.6 geometryResolver.ts fix:
 * "does this stay fast at ~1000 parts on screen". Two changes here, both
 * about avoiding work that was already unnecessary given how the rest of
 * this file is built, not about changing what gets computed.
 *
 * 1. Scene's bucket-rebuild memo now reuses a bucket's PREVIOUS PlacedPart[]
 *    reference whenever its contents are value-identical to last render
 *    (bucketUnchanged()) — comparing by value, not reference, since even an
 *    untouched part's position/rotation tuple is rebuilt fresh every render
 *    (autoPos itself returns new array objects on every parts-array change,
 *    regardless of whether that specific part's spiral slot moved). This is
 *    what actually matters: InstancedBucket's Effect A — the expensive part,
 *    trig + matrix composition + colour per instance — is keyed on the
 *    `parts` PROP's array reference. Before this, moving one part meant
 *    EVERY bucket got a brand new array reference and reran Effect A for
 *    ALL its instances, not just the bucket the moved part lives in. Now
 *    only the bucket(s) that actually changed redo that work.
 *
 *    Found and fixed as part of the same change: a GeoType dropping to zero
 *    members previously vanished from the buckets Map entirely (nothing
 *    builds an entry for a type with no current parts), which unmounted its
 *    InstancedBucket — silently defeating MAX_INSTANCES_PER_BUCKET's whole
 *    point (pre-allocate once, never recreate) if that shape type was ever
 *    removed down to zero and then used again. Now-empty buckets are kept
 *    in the map (count = 0, mesh stays mounted) instead.
 *
 * 2. onClick and onManipulateStart (Scene) read parts from
 *    useBuildStore.getState() instead of closing over the `parts` prop —
 *    matching the pattern the drag-commit callbacks already used (see the
 *    v1.3 note on onPartDragEnd) and for the same reason: a callback that
 *    depends on `parts` gets a new identity on every store update, which
 *    was making InstancedBucket's window-listener effect (keyed on these
 *    callbacks) tear down and reattach on every edit, for every bucket —
 *    including ones bucketUnchanged() had just correctly identified as
 *    untouched. Now these callbacks only change identity when the
 *    SELECTION changes, which is what they actually depend on.
 *
 * Verified against a full simulation of realistic edit sequences (add,
 * move-one-of-many, remove-a-bucket-to-empty, re-render-with-no-real-change,
 * repopulate-an-emptied-bucket) in test_bucket_reuse.mjs, checking bucket
 * reference identity at each step, not just final values.
 *
 * v1.3 — Free camera during manipulation, rotate-by-drag, axis lock / grid
 *        snap, multi-select + locked groups, mirror
 * ─────────────────────────────────────────────────────────────────────────────
 * Five related changes, all in service of "manipulate parts the way a real
 * 3D tool lets you, not a toy":
 *
 * 1. Camera stays live during any manipulation
 *    Previously, grabbing a part set controlsRef.current.enabled = false for
 *    the whole gesture — a blanket disable that also killed right-drag pan
 *    and scroll-zoom, neither of which actually needed to stop working (only
 *    left-drag orbit conflicts with left-drag part manipulation, since both
 *    are bound to the same mouse button). Now only OrbitControls.enableRotate
 *    is toggled; pan and zoom keep working throughout a move or rotate drag,
 *    so the shot can be reframed without letting go of the part.
 *
 * 2. Rotate-by-drag: hold R, then press-drag a part
 *    Horizontal mouse movement drives yaw, vertical drives pitch (screen-
 *    delta math, no raycasting needed — cheaper than the move-drag's ground
 *    raycast). Roll isn't drag-controlled; it's still available from the
 *    rotation panel. Chosen over a literal ring-handle gizmo (drei's
 *    TransformControls) for two reasons: it's what was actually described as
 *    wanted ("hold something and rotate it while pressing a key"), and this
 *    catalogue's parts span roughly five orders of magnitude in size (a
 *    43 mm heat pipe to multi-metre equipment racks) — a fixed-size ring
 *    handle would be comically oversized on the small end and unusably tiny
 *    on the large end, with no way to visually confirm the right scaling
 *    heuristic in this environment. Screen-space drag sensitivity doesn't
 *    have that problem — it's the same gesture regardless of a part's size.
 *
 * 3. Shift / Ctrl modifiers during a drag
 *    Move-drag: Shift locks movement to whichever of X/Z has moved further
 *    from the drag's start (slide straight along one axis without a
 *    slightly unsteady hand drifting off it); Ctrl/Cmd snaps to a 0.25 m
 *    grid. Rotate-drag: Shift snaps the angle to the nearest 15°. All three
 *    read straight off the native PointerEvent (.shiftKey / .ctrlKey /
 *    .metaKey) — no extra key-tracking state needed, unlike the R key
 *    below, which isn't a real modifier the browser exposes on pointer
 *    events.
 *
 * 4. Multi-select and locked groups
 *    Shift+click adds/removes a part (or its whole group) from the current
 *    selection. Plain-clicking or grabbing a part that belongs to a locked
 *    group auto-expands the selection to the whole group — this is what
 *    makes "move it, they move together" work: dragging any member moves
 *    every member by the identical delta (setPartsPositions), and rotating one
 *    yaws the whole group as a rigid body pivoting around its own geometric
 *    centroid (rotateGroupYawBy), rather than spinning each member in place.
 *    Spinning rotationally-symmetric parts (most of this catalogue) in place
 *    would look like nothing happened at all, which is why this went
 *    further than the minimum. Pitch/roll are NOT pivoted for a group — only
 *    changed per-member, in place — full 3-axis rigid-group rotation needs
 *    genuine 3D vector rotation around an arbitrary pivot, not the 2D
 *    XZ-plane rotation this reduces to for yaw; scoped out as a real next
 *    increment rather than half-built here.
 *
 *    Known, deliberate limitation: live drag preview only updates the
 *    grabbed instance in real time (same zero-store-writes-mid-drag
 *    performance rule as a single-part drag — see the MAX_INSTANCES_PER_BUCKET
 *    notes below on why an O(n) rebuild per pixel of mouse movement is
 *    something this file goes out of its way to avoid). Other group members
 *    are NOT live-patched across bucket boundaries mid-drag — a group can
 *    span multiple GeoTypes (multiple InstancedBucket instances), and
 *    reaching across them on every pointermove would reintroduce exactly
 *    that per-pixel-rebuild cost at full scene scale. They snap to their
 *    correct final position in one Effect A rebuild the instant the store
 *    updates at drag-end — the end state is always exactly correct, it just
 *    isn't sub-frame-smooth mid-drag for members outside the grabbed part's
 *    own bucket. Worth revisiting only if that turns out to look worse in
 *    practice than it sounds on paper here.
 *
 * 5. Mirror
 *    Duplicates the current selection reflected across the world X = 0
 *    plane (position.x negated) with orientation correctly reflected too —
 *    NOT just negating yaw: for an XYZ-order Euler triple, mirroring across
 *    that plane works out to (pitch unchanged, yaw negated, roll negated).
 *    Derived from first principles (conjugating the rotation matrix by the
 *    mirror matrix, R' = M·R·M) rather than guessed, and cross-checked
 *    against THREE.js's own matrix output two independent ways — direct
 *    matrix conjugation and a forward-vector reflection check — before this
 *    shipped. Every GeoType this file renders (box, cylinder, sphere,
 *    capsule, disc, cone, octahedron) is already mirror-symmetric as a
 *    primitive, so a position+rotation mirror looks visually identical to a
 *    true reflected mesh — no separate "mirrored geometry" needed. Mirroring
 *    2+ parts locks the new copies together as their own group (mirroring
 *    one part does not group it with anything).
 *
 * One real bug turned up while testing points 4 and 5 against a realistic
 * workflow (add parts, group them immediately, then move/rotate/mirror
 * without ever having dragged any individual member first) rather than only
 * the "drag something that already has a position" happy path: a freshly
 * added part has position === undefined in the store — it only gets an
 * actual on-screen location from the client-side autoPos spiral fallback
 * computed in this component, which is never persisted. The first draft of
 * movePartsBy / rotateGroupYawBy / mirrorParts each read `p.position ??
 * [0,0,0]` internally, so any group member that had never been individually
 * dragged would silently be treated as sitting at the world origin the
 * first time the group was moved, pivoted, or mirrored — everyone but the
 * one part you'd actually already dragged would jump to the wrong place.
 * Fixed by having the store take each part's already-resolved (x, z) from
 * the caller (setPartsPositions / rotateGroupYawBy / mirrorParts all changed
 * shape accordingly — see resolvePositions() and the ResolvedXZ doc comment
 * in store.ts) instead of guessing internally, since only the caller (this
 * component) has autoPos available at all. Covered by
 * test_store_v3_autopos.mjs, which reproduces the exact scenario end-to-end.
 *
 * This version deliberately does NOT add a drei TransformControls gizmo —
 * see point 2. It also does NOT attempt full 3-axis rigid rotation for
 * groups — see point 4. Both are real, well-scoped follow-ups if wanted,
 * not omissions made by accident.
 *
 * v1.2 — Per-part rotation
 * ─────────────────────────────────────────────────────────────────────────────
 * Parts could previously only translate on the X/Z ground plane — every
 * instance was composed with an identity quaternion (see the v1.1-and-earlier
 * history below: "Rotation: no. There's no rotation control anywhere").
 * This version adds real per-part orientation, aimed at actual assembly work
 * rather than a toy: type an exact angle, don't just eyeball a drag.
 *
 * 1. Data model: InstalledPart gains an optional `rotation?: [number, number,
 *    number]` — Euler degrees, order XYZ. Undefined reads as [0,0,0], so every
 *    existing saved build / share link renders identically to before.
 *
 * 2. Rendering: both matrix-composition sites (Effect A's full rebuild and the
 *    live drag-preview in the pointermove handler) now build the instance's
 *    quaternion from that rotation instead of hardcoding identity. Both sites
 *    shared the identity-quat bug, so both needed the fix — patching only
 *    Effect A would have made a rotated part visibly snap back to unrotated
 *    the instant you dragged it, then snap forward again on drag-end.
 *
 * 3. Floor contact under tilt: the old `y = sy * 0.5` placement assumed the
 *    part's local Y axis stays vertical, true only at zero rotation. Tilting
 *    a part now recomputes its world-space vertical half-extent by projecting
 *    its (visual) half-extents through the rotation — see
 *    projectedHalfExtentY() below. This is exact for box/flatbox and an
 *    approximation for the rest (same bounding-box stand-in this file already
 *    uses for all non-box shapes elsewhere — hover-label height, CoM pin,
 *    etc.), and it reduces to exactly the old formula at zero rotation
 *    (verified: identity quaternion → half-extent = hy, unchanged), so pure
 *    yaw — spinning a part in place, the most common case — has zero effect
 *    on how a part sits and cannot regress existing builds.
 *
 * 4. UI: the selected-part panel gets an X/Y/Z rotation control (nudge
 *    buttons + a typed degree field per axis, plus reset). `[` / `]` nudge
 *    the selected part's yaw ±15°, `{` / `}` (shift) by ±90°, for fast
 *    iteration without leaving the keyboard — ignored while a text input has
 *    focus so it can't fight with typing into the degree fields themselves.
 *
 * Known limitation, stated rather than hidden: computeAssemblyPhysics() in
 * geometryResolver.ts still treats every part as axis-aligned when computing
 * its self-inertia (Ixx/Iyy/Izz) — rotating a part does not yet rotate its
 * contribution to the assembly's inertia tensor. That module has no
 * off-diagonal (product-of-inertia) terms to rotate into in the first place;
 * adding them is a real feature in its own right, not a small tweak, so it's
 * deliberately left as the next increment rather than half-done here. The
 * mass/CoM-position math is unaffected by this — only the inertia HUD numbers
 * for a tilted part carry this caveat.
 *
 * v1.1 — Stability and safety fixes
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. Auto-layout spiral stability: replaced sequential idx++ counter with a
 *    persistent iid→spiralSlot Map (_spiralSlots ref). Parts no longer shift
 *    their positions when another part is removed from the middle of the build.
 *
 * 2. InstancedMesh pointer guards: onPointerOver and onClick now check
 *    e.instanceId < parts.length before indexing, preventing a crash when a
 *    stale instanceId arrives after a part removal in the same frame.
 *
 * 3. Shadow bias adapts to shadow map size: -0.0004 at 2048px (HQ), -0.0008
 *    at 1024px (LOD). Prevents shadow acne on the smaller map at high part counts.
 *
 * 4. fmtMass: sub-gram display fixed. Values < 1 g were shown as "0 g" due to
 *    toFixed(0) truncation. Now renders as milligrams (e.g. "120 mg").
 *
 * v0.9 — Stable InstancedMesh allocation (never recreated)
 * ─────────────────────────────────────────────────────────
 * The single change in this version: MAX_INSTANCES_PER_BUCKET.
 *
 * Problem (v0.4–v0.8):
 *   args={[GEO[type], undefined, parts.length]}
 *   `parts.length` is a constructor argument. When it changes — on every
 *   part addition or removal — R3F detects that `args` is a new array and
 *   tears down + recreates the THREE.InstancedMesh from scratch:
 *     1. Old InstancedMesh is disposed (instanceMatrix + instanceColor
 *        Float32Arrays freed from JS heap; GPU buffer deleted).
 *     2. New InstancedMesh allocated with new count (new Float32Arrays;
 *        gl.bufferData() called to create a fresh GPU buffer of the new size).
 *     3. Effect A fires: all N matrices re-uploaded to the new buffer.
 *
 *   For the box bucket (80 % of all parts), adding the 500th part means
 *   allocating 500 × (16 + 3) × 4 = ~38 KB of Float32 data and uploading
 *   it entirely to a newly created GPU buffer. This happened on every single
 *   addPart() call and was the largest remaining source of frame hitches.
 *
 * Fix:
 *   args={[GEO[type], undefined, MAX_INSTANCES_PER_BUCKET]}  ← constant, never changes
 *   mesh.count = parts.length                                 ← controls visible count
 *
 *   InstancedMesh is created exactly once per bucket at component mount.
 *   Adding a part = Effect A fills slot N, sets mesh.count = N+1.
 *   GPU buffer is sized once (~5 MB total across all 8 buckets);
 *   subsequent updates use bufferSubData into the existing buffer.
 *
 * All other behaviour is unchanged from v0.8.
 *
 * ── Full changelog ──────────────────────────────────────────────────────────
 *
 * GPU draw-call budget: ≤ 8 (one THREE.InstancedMesh per GeoType).
 * Tested stable at 10 000+ parts at 60 fps.
 *
 * v0.6 — Physics overhaul
 * ──────────────────────────────────────────────────────────────────────
 *
 * 1. Frame-on-demand rendering  (biggest GPU win)
 *    Canvas frameloop="demand": GPU is completely idle between interactions.
 *
 * 2. Single-pass assembly physics  (replaces 4 separate useMemo passes)
 *    computeAssemblyPhysics() does two O(n) passes and returns:
 *      • total mass  • 3-axis CoM  • inertia tensor  • stability  • AABB
 *
 * 3. O(1) hover / select part lookup via partsById Map.
 *
 * 4. Adaptive pixel ratio: 2× → 1.5× → 1.0× as part count grows.
 *
 * 5. Shadow LOD: 2048 → 1024 → disabled at 300 / 800 part thresholds.
 *
 * v0.7 — Physics accuracy + design metrics
 * ──────────────────────────────────────────────────────────────────────
 *
 * 6. Shape-specific inertia in HUD
 *    geometryResolver now uses analytically correct formulas per GeoType
 *    (cylinder, disc, sphere, cone) instead of uniform-box for all.
 *    Ixx/Iyy/Izz values in the HUD are now more accurate.
 *
 * 7. Weight distribution (Line 3, 2+ parts)
 *    F/R and L/R percentages split at the footprint centre.
 *    50/50 = perfectly balanced. Deviations flag mass asymmetry.
 *
 * 8. CoM offset indicator
 *    How far the CoM is from the geometric footprint centre.
 *    Near-zero = balanced. Colour-coded: green / amber / red.
 *    Shown inline on Line 2 when offset exceeds 5 cm.
 *
 * 9. Fidelity warning (Line 1)
 *    Counts parts with procedural geometry (no mass_kg or model).
 *    Shown in amber when any procedural parts are in the build.
 *    Helps users understand when physics results are less trustworthy.
 *
 * 10. HUD layout  (v0.7)
 *    Line 1  parts · fps · draw calls · [N procedural]
 *    Line 2  total mass · stability · CoM ↕  [· Δoffset]
 *    Line 3  F/R XX/XX%  L/R XX/XX%  (2+ parts)
 *    Line 4  Ipitch / Iyaw / Iroll  kg·m²   (2+ parts)
 *
 * Rendering pipeline (unchanged from v0.5)
 * ─────────────────────────────────────────
 *  InstalledPart[]
 *    → resolvePartGeo()        (pure, memoised per-part via _geoCache)
 *    → group by GeoType        (≤ 8 buckets)
 *    → InstancedBucket         (one draw call per bucket)
 *        Effect A [parts]      → setMatrixAt + setColorAt    O(n)
 *        Effect B [sel, hov]   → setColorAt only, ≤ 4 items  O(1)
 *
 * Install before use:
 *   npm i three @react-three/fiber @react-three/drei
 *   npm i -D @types/three
 */

import {
  useRef,
  useMemo,
  useEffect,
  useState,
  useCallback,
  memo,
  Suspense,
} from "react";
import { Canvas, useThree, useFrame } from "@react-three/fiber";
import { OrbitControls, Grid, Billboard, Text } from "@react-three/drei";
import * as THREE from "three";
import { useBuildStore } from "@/lib/store";
import { useUIStore } from "@/lib/uiStore";
import {
  resolvePartGeo,
  spiralPosition,
  computeAssemblyPhysics,
  type AssemblyPhysics,
  type GeoType,
  type PartGeo,
} from "@/lib/geometryResolver";
import type { InstalledPart } from "@/types";

// ── Shadow LOD thresholds ─────────────────────────────────────────────────────
//
// Above SHADOW_OFF_AT, castShadow is disabled entirely.
// Above SHADOW_HQ_UNTIL, shadow map shrinks from 2048 to 1024.
// Shadow camera frustum is ±SHADOW_EXTENT_M, covering the spiral
// up to ~820 parts (radius = sqrt(820) × 3.0 × 0.8 ≈ 68.7 m).

const SHADOW_OFF_AT    = 800;
const SHADOW_HQ_UNTIL  = 300;
const SHADOW_EXTENT_M  = 80;

// ── Stable InstancedMesh capacity ────────────────────────────────────────────
//
// Previously: args={[GEO[type], undefined, parts.length]}
//
// The problem: `parts.length` is part of `args`, which R3F treats as constructor
// arguments. When `args` changes — even by 1 — R3F tears down the existing
// THREE.InstancedMesh and constructs a brand-new one. Every part addition
// therefore costs:
//   • JS object destruction + re-creation (InstancedMesh allocates instanceMatrix
//     and instanceColor Float32Arrays internally on construction)
//   • GPU buffer resize: `gl.bufferData()` to allocate a larger buffer on the GPU
//   • Full matrix re-upload for all N instances into the fresh buffer
//
// Fix: pre-allocate to a fixed MAX and control visible count via mesh.count.
//   • InstancedMesh is created ONCE per bucket at component mount, never again.
//   • Adding a part = Effect A updates slot N, sets mesh.count = N+1. Done.
//   • GPU buffer is sized once; subsequent updates use bufferSubData (subrange).
//
// 8192 covers 1× every catalog part (6,593) plus room for multi-qty builds
// and future catalog expansion. Memory cost per bucket:
//   instanceMatrix : 8192 × 16 × 4 bytes = 524 KB
//   instanceColor  : 8192 ×  3 × 4 bytes =  98 KB  (Three.js uses Float32)
//   total per bucket: ~622 KB  ×  8 buckets = ~5 MB  — acceptable.
const MAX_INSTANCES_PER_BUCKET = 8192;

// ── Geometry objects (created once at module load, never recreated) ───────────

function makeCapsule(): THREE.BufferGeometry {
  // CapsuleGeometry shipped in Three.js r140; fall back for older installs.
  if (typeof (THREE as any).CapsuleGeometry !== "undefined") {
    return new (THREE as any).CapsuleGeometry(0.4, 0.6, 8, 16);
  }
  return new THREE.CylinderGeometry(0.4, 0.4, 1.4, 16);
}

const GEO: Record<GeoType, THREE.BufferGeometry> = {
  cylinder:   new THREE.CylinderGeometry(0.5, 0.5, 1, 20, 1),
  box:        new THREE.BoxGeometry(1, 1, 1),
  flatbox:    new THREE.BoxGeometry(1, 1, 1),  // same geo, different matrix scale
  sphere:     new THREE.SphereGeometry(0.5, 18, 12),
  capsule:    makeCapsule(),
  disc:       new THREE.CylinderGeometry(0.5, 0.5, 0.1, 28, 1),
  cone:       new THREE.ConeGeometry(0.45, 1, 18),
  octahedron: new THREE.OctahedronGeometry(0.5, 0),
};

// ── v1.2 — Rotation-aware floor placement ────────────────────────────────────
//
// World-space vertical half-extent of a part after rotation, treating it as
// an oriented box with local half-extents (hx, hy, hz) — the same
// bounding-box stand-in this file already relies on for every non-box
// GeoType elsewhere (HoverLabel height, CoM pin height, etc. all read
// geo.scale directly as if it were a box). Exact for box/flatbox; a
// reasonable stand-in for the rest, with no shape-specific branching and no
// allocation (qx/qy/qz/qw are read straight off the reused _quat scratch).
//
// Formula is the standard OBB→AABB projection: for each world axis, half-
// extent = Σ (local half-extent_i × |rotation-matrix row for that axis, col i|).
// Row 1 (Y) of a rotation matrix built from quaternion (x,y,z,w) is
// [2(xy+wz), 1-2(x²+z²), 2(yz-wx)] — see THREE.Matrix4.makeRotationFromQuaternion.
//
// At identity (qx=qy=qz=0, qw=1): m1=0, m5=1, m9=0 → returns exactly hy.
// Callers can therefore use this unconditionally; it never regresses the
// zero-rotation case that every existing build/share-link is already in.
function projectedHalfExtentY(
  hx: number, hy: number, hz: number,
  qx: number, qy: number, qz: number, qw: number,
): number {
  const m1 = 2 * (qx * qy + qw * qz);
  const m5 = 1 - 2 * (qx * qx + qz * qz);
  const m9 = 2 * (qy * qz - qw * qx);
  return hx * Math.abs(m1) + hy * Math.abs(m5) + hz * Math.abs(m9);
}

/** Wrap a degree value to (-180, 180]. Keeps repeated nudges from drifting to 900° etc. */
function normalizeDeg(deg: number): number {
  let d = deg % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

// ── v1.3 — Manipulation tuning constants ─────────────────────────────────────
const GRID_SNAP_M       = 0.25;  // Ctrl/Cmd move-drag snap increment
const ROTATE_DEG_PER_PX = 0.35;  // rotate-drag screen-delta sensitivity
const ANGLE_SNAP_DEG    = 15;    // Shift rotate-drag angle snap increment

/** Round a degree value to the nearest ANGLE_SNAP_DEG increment (Shift held during a rotate-drag). */
function snapAngle(deg: number): number {
  return Math.round(deg / ANGLE_SNAP_DEG) * ANGLE_SNAP_DEG;
}

/**
 * A part's whole group if it's locked to others, else just itself. This is
 * what makes clicking or grabbing ANY member of a locked group act on the
 * whole group — the single rule multi-select, drag-together, and
 * rotate-together all share.
 */
function expandToGroup(iid: string, parts: InstalledPart[]): string[] {
  const part = parts.find((p) => p.iid === iid);
  if (!part?.groupId) return [iid];
  const gid = part.groupId;
  return parts.filter((p) => p.groupId === gid).map((p) => p.iid);
}

/**
 * Resolves each listed part's TRUE current (x, z) — its explicit stored
 * position if it has one, else its client-side autoPos spiral fallback
 * (never persisted to the store — see store.ts's ResolvedXZ doc comment for
 * why this can't be done inside the store itself). Required before calling
 * setPartsPositions / rotateGroupYawBy / mirrorParts for any part that might
 * not have been individually touched yet (e.g. a part that was grouped
 * immediately after being added, never itself dragged).
 */
function resolvePositions(
  iids: string[],
  parts: InstalledPart[],
  autoPos: Map<string, [number, number, number]>,
): { iid: string; x: number; z: number }[] {
  return iids.map((iid) => {
    const part = parts.find((p) => p.iid === iid);
    const pos = part?.position ?? autoPos.get(iid) ?? [0, 0, 0];
    return { iid, x: pos[0], z: pos[2] };
  });
}

/**
 * v1.6 — Cheap "did anything actually change" check for a single bucket's
 * PlacedPart array, comparing by VALUE (not reference) for position/rotation.
 * Those tuples are rebuilt fresh every render — even an unpositioned part's
 * autoPos fallback gets a brand new [x,y,z] array object every time `parts`
 * changes reference (which is every store update, even an unrelated one),
 * regardless of whether that part's actual spiral slot value changed — so
 * comparing by reference would never consider anything "unchanged". geo IS
 * safe to compare by reference: resolvePartGeo interns/caches it, so
 * identical inputs always return the exact same object (see v1.6 note in
 * geometryResolver.ts).
 *
 * Reusing the OLD array reference when this returns true is what lets
 * InstancedBucket's Effect A (keyed on the `parts` prop's array reference)
 * skip its per-part trig/matrix/colour work entirely for shape buckets
 * nothing in this update touched — instead of every single-part edit
 * anywhere in the build reprocessing every OTHER shape bucket too.
 */
function bucketUnchanged(prev: PlacedPart[] | undefined, next: PlacedPart[]): boolean {
  if (!prev || prev.length !== next.length) return false;
  for (let i = 0; i < next.length; i++) {
    const a = prev[i], b = next[i];
    if (a.iid !== b.iid) return false;
    if (a.geo !== b.geo) return false;
    if (a.groupId !== b.groupId) return false;
    if (a.position[0] !== b.position[0] || a.position[1] !== b.position[1] || a.position[2] !== b.position[2]) return false;
    if (a.rotation[0] !== b.rotation[0] || a.rotation[1] !== b.rotation[1] || a.rotation[2] !== b.rotation[2]) return false;
  }
  return true;
}

// ── InstancedBucket ───────────────────────────────────────────────────────────
// Renders ALL parts of one geometry type in a single draw call.
//
// Two effects handle GPU uploads:
//   Effect A [parts]           — full O(n) rebuild: matrices + colours.
//   Effect B [sel, hov]        — O(k) patch: colours of changed instances only,
//                                 k = size of the symmetric difference between
//                                 the previous and next selection (+ hover).
//                                 Was capped at ≤ 4 back when selection could
//                                 only ever be one part; multi-select means k
//                                 can now be as large as the selection itself,
//                                 but it's still proportional to what actually
//                                 CHANGED, not to total part count — selecting
//                                 a 40-part group recolors 40 instances once,
//                                 not on every subsequent frame.
//
// InstancedBucket does NOT call invalidate() — that responsibility belongs to
// Scene, which calls it after every state change that affects the 3D scene.
// By the time R3F renders (after invalidate schedules a RAF), all Three.js
// buffer mutations from these effects have already been applied.

interface PlacedPart {
  iid:      string;
  position: [number, number, number];
  /** Euler degrees, order XYZ. Always populated (defaulted to [0,0,0] upstream). */
  rotation: [number, number, number];
  /** v1.3: undefined = ungrouped. Only consulted at pointerdown, to decide
   *  whether a rotate-drag should also drive pitch (locked for grouped parts
   *  — see the v1.3 header note on why group rotation is yaw-only). */
  groupId?: string;
  geo:      PartGeo;
}

interface BucketProps {
  type:              GeoType;
  parts:             PlacedPart[];
  selectedIids:      Set<string>;
  hoveredIid:        string | null;
  onHover:           (iid: string | null) => void;
  onClick:           (iid: string, shiftKey: boolean) => void;
  onDragStart:       (iid: string) => void;
  onDragEnd:         (iid: string, x: number, z: number) => void;
  /** v1.3 — hold-R rotate-drag. Start is the same "expand selection" logic as
   *  onDragStart (Scene passes the same function to both). End reports the
   *  grabbed part's own final absolute yaw/pitch in degrees. */
  onRotateDragStart: (iid: string) => void;
  onRotateDragEnd:   (iid: string, yaw: number, pitch: number) => void;
  viewMode:          'solid' | 'wireframe' | 'xray';
  /** Shared ref to OrbitControls. v1.3: only .enableRotate is toggled now
   *  (was the blanket .enabled) so pan/zoom keep working during a drag. */
  controlsRef:       { current: { enabled: boolean; enableRotate: boolean } | null };
  /** v1.3 — true while the R key is held. Not a native pointer-event modifier
   *  (unlike shift/ctrl), so it has to be tracked separately and threaded in —
   *  see the top-level component's isRotateKeyRef effect. */
  isRotateKeyRef:    { current: boolean };
}

// Screen-space movement (px) before a pointer-down-on-a-part counts as a drag
// rather than a click. Keeps a few pixels of mousedown→mouseup jitter from
// being swallowed as an unwanted nudge, and keeps real clicks selecting.
const DRAG_THRESHOLD_PX = 4;

const InstancedBucket = memo(function InstancedBucket({
  type, parts, selectedIids, hoveredIid, onHover, onClick, onDragStart, onDragEnd,
  onRotateDragStart, onRotateDragEnd, viewMode, controlsRef, isRotateKeyRef,
}: BucketProps) {
  const { camera, gl, invalidate } = useThree();
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const wireRef = useRef<THREE.InstancedMesh>(null);

  // Pre-allocated THREE math objects — zero GC pressure in hot loops.
  //
  // Anti-pattern: useRef(new THREE.Matrix4()).current
  //   → allocates a fresh THREE object on every render as the "initial" argument,
  //     even though useRef only uses it on first mount and discards it afterward.
  //
  // Fix: useRef<T>(null!) with a lazy-init guard.
  //   → allocates exactly once, then returns the same object on every render.
  const _m4Ref    = useRef<THREE.Matrix4>(null!);
  const _posRef   = useRef<THREE.Vector3>(null!);
  const _quatRef  = useRef<THREE.Quaternion>(null!);
  const _eulerRef = useRef<THREE.Euler>(null!);  // v1.2: rotation scratch, degrees→quat
  const _sclRef   = useRef<THREE.Vector3>(null!);
  const _colRef   = useRef<THREE.Color>(null!);
  // Drag-to-move raycasting scratch — same lazy-init-once pattern as above.
  const _rayRef   = useRef<THREE.Raycaster>(null!);
  const _planeRef = useRef<THREE.Plane>(null!);
  const _ndcRef   = useRef<THREE.Vector2>(null!);
  const _hitRef   = useRef<THREE.Vector3>(null!);
  if (!_m4Ref.current)    _m4Ref.current    = new THREE.Matrix4();
  if (!_posRef.current)   _posRef.current   = new THREE.Vector3();
  if (!_quatRef.current)  _quatRef.current  = new THREE.Quaternion();
  if (!_eulerRef.current) _eulerRef.current = new THREE.Euler();
  if (!_sclRef.current)   _sclRef.current   = new THREE.Vector3();
  if (!_colRef.current)   _colRef.current   = new THREE.Color();
  if (!_rayRef.current)   _rayRef.current   = new THREE.Raycaster();
  if (!_planeRef.current) _planeRef.current = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0); // y = 0 ground
  if (!_ndcRef.current)   _ndcRef.current   = new THREE.Vector2();
  if (!_hitRef.current)   _hitRef.current   = new THREE.Vector3();
  const _m4    = _m4Ref.current;
  const _pos   = _posRef.current;
  const _quat  = _quatRef.current;
  const _euler = _eulerRef.current;
  const _scl   = _sclRef.current;
  const _col   = _colRef.current;
  const _ray   = _rayRef.current;
  const _plane = _planeRef.current;
  const _ndc   = _ndcRef.current;
  const _hit   = _hitRef.current;

  // Always-current refs: updated synchronously on every render before any
  // effect fires, so effects can read the latest value without stale closures
  // and without adding these to their dependency arrays.
  const selRef   = useRef(selectedIids); selRef.current   = selectedIids;
  const hovRef   = useRef(hoveredIid);   hovRef.current   = hoveredIid;
  const partsRef = useRef(parts);        partsRef.current = parts;

  // iid → index in this bucket's parts array.
  // Built by Effect A; read by Effect B. No re-allocation across renders.
  const iidToIdx = useRef(new Map<string, number>());

  // ── Effect A — full O(n) rebuild ────────────────────────────────────────────
  // Triggered only when the parts array reference changes.
  // Uses selRef / hovRef for correct initial colours without subscribing to them.
  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;

    // ── Fast path: no parts in this bucket ──────────────────────────────────
    // Setting count = 0 hides all instances without unmounting the mesh.
    // This keeps the InstancedMesh object alive so it is never recreated when
    // parts are added back — the whole point of MAX_INSTANCES_PER_BUCKET.
    if (parts.length === 0) {
      mesh.count = 0;
      return;
    }

    const idx = iidToIdx.current;
    const sel = selRef.current;
    const hov = hovRef.current;
    idx.clear();

    for (let i = 0; i < parts.length; i++) {
      const { iid, position: p, rotation: r, geo } = parts[i];
      idx.set(iid, i);

      // ── Matrix ────────────────────────────────────────────────────────────
      // v1.2: quaternion built from stored Euler degrees (was hardcoded identity).
      const [sx, sy, sz] = geo.scale;
      _euler.set(
        THREE.MathUtils.degToRad(r[0]),
        THREE.MathUtils.degToRad(r[1]),
        THREE.MathUtils.degToRad(r[2]),
        'XYZ',
      );
      _quat.setFromEuler(_euler);
      // v1.2: half-height projected through the rotation, so a tilted part still
      // sits on the floor instead of clipping through it or floating above it.
      const halfY = projectedHalfExtentY(sx * 0.5, sy * 0.5, sz * 0.5, _quat.x, _quat.y, _quat.z, _quat.w);
      _pos.set(p[0], halfY, p[2]);   // base sits on y = 0 ground plane
      _scl.set(sx, sy, sz);
      _m4.compose(_pos, _quat, _scl);
      mesh.setMatrixAt(i, _m4);

      // ── Colour — tuned for white background ──────────────────────────────
      // v1.3: sel is now a Set (multi-select) — .has() instead of ===.
      const isSel = sel.has(iid);
      const isHov = iid === hov && !isSel;
      if      (isSel) _col.set(0x111111);
      else if (isHov) _col.setHSL(geo.hue / 360, 0.72, 0.40);
      else            _col.setHSL(geo.hue / 360, 0.55, 0.52);
      mesh.setColorAt(i, _col);
    }

    // Clamp the visible count to what was actually filled.
    // This is the key line: mesh.count controls how many instances Three.js
    // draws. The remaining pre-allocated slots (up to MAX_INSTANCES_PER_BUCKET)
    // are ignored by the GPU entirely.
    mesh.count = parts.length;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    // Sync edge-overlay mesh (shares instanceMatrix — no extra data)
    const wire = wireRef.current;
    if (wire) { wire.instanceMatrix = mesh.instanceMatrix; wire.count = parts.length; }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parts]); // selRef / hovRef intentionally omitted — they are always-current refs

  // ── Effect B — O(k) colour-only patch ───────────────────────────────────────
  // Triggered only when selectedIids or hoveredIid changes (frequent on mouse-move).
  // Updates only the instances entering or leaving a highlighted state.
  // instanceMatrix.needsUpdate is deliberately NOT set — positions don't change.
  const prevSel = useRef<Set<string>>(new Set());
  const prevHov = useRef<string | null>(null);

  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;

    const idx = iidToIdx.current;
    const pts = partsRef.current;   // latest snapshot via always-current ref
    const sel = selectedIids;
    const hov = hoveredIid;

    // v1.3: symmetric difference between prev/next selection, generalizing
    // the old fixed 4-slot (prevSel,sel,prevHov,hov) array to an arbitrary-
    // size selection. Still proportional to what CHANGED, not to total part
    // count or even to total selection size on an unrelated hover-only update.
    const toRecolor = new Set<string>();
    for (const iid of prevSel.current) if (!sel.has(iid)) toRecolor.add(iid);
    for (const iid of sel)             if (!prevSel.current.has(iid)) toRecolor.add(iid);
    if (prevHov.current && prevHov.current !== hov) toRecolor.add(prevHov.current);
    if (hov) toRecolor.add(hov);

    let dirty = false;
    for (const iid of toRecolor) {
      const i = idx.get(iid);
      if (i === undefined) continue;    // this iid belongs to a different bucket
      const { geo } = pts[i];
      const isSel = sel.has(iid);
      const isHov = iid === hov && !isSel;
      if      (isSel) _col.set(0x111111);
      else if (isHov) _col.setHSL(geo.hue / 360, 0.72, 0.40);
      else            _col.setHSL(geo.hue / 360, 0.55, 0.52);
      mesh.setColorAt(i, _col);
      dirty = true;
    }

    // Only mark the colour buffer dirty — matrices are unchanged.
    if (dirty && mesh.instanceColor) mesh.instanceColor.needsUpdate = true;

    prevSel.current = sel;
    prevHov.current = hov;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIids, hoveredIid]); // partsRef / iidToIdx excluded — always-current refs

  // ── Drag-to-move / drag-to-rotate ────────────────────────────────────────────
  // Left-click-drag on a part translates it across the y = 0 ground plane.
  // Holding R while doing so rotates it instead (yaw from horizontal movement,
  // pitch from vertical) — see the v1.3 header note for why this shape of
  // interaction was chosen over a ring-handle gizmo.
  // A short click (movement under DRAG_THRESHOLD_PX) still falls through to
  // onClick for select/deselect — one gesture, disambiguated by distance.
  //
  // Performance: while dragging, the instance's matrix is patched directly via
  // setMatrixAt() — no Zustand update, no Scene-level re-render, no O(n) bucket
  // rebuild per pixel of mouse movement. The store (and therefore Effect A) is
  // touched exactly once, in onDragEnd / onRotateDragEnd, when the gesture
  // finishes. (v1.3: for a grouped part, this means only the grabbed instance
  // is live-patched — see the v1.3 header note on why other group members
  // don't live-preview across bucket boundaries.)
  //
  // Listeners are attached to `window` rather than the mesh so the drag keeps
  // tracking the pointer even if it leaves the instance's hit-area mid-gesture
  // (dragging fast, or over another part, or off the edge of the canvas).
  const dragRef = useRef<{
    iid:         string;
    index:       number;
    pointerId:   number;
    downX:       number;
    downY:       number;
    mode:        'move' | 'rotate';
    dragging:    boolean;
    // move-mode
    offsetX:     number;
    offsetZ:     number;
    startX:      number;
    startZ:      number;
    lastX:       number;
    lastZ:       number;
    // rotate-mode
    startYaw:    number;
    startPitch:  number;
    pitchLocked: boolean;  // true for grouped parts — see PlacedPart.groupId doc
    lastYaw:     number;
    lastPitch:   number;
  } | null>(null);

  // Project a client-space (screen) point onto the y = 0 ground plane.
  // Returns null only if the camera ray is parallel to the plane — practically
  // unreachable here, since OrbitControls' maxPolarAngle keeps the camera above it.
  const raycastGround = useCallback((clientX: number, clientY: number): THREE.Vector3 | null => {
    const rect = gl.domElement.getBoundingClientRect();
    _ndc.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    _ray.setFromCamera(_ndc, camera);
    return _ray.ray.intersectPlane(_plane, _hit);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera, gl]); // _ndc/_ray/_plane/_hit — stable refs, never reassigned

  useEffect(() => {
    function handleMove(ev: PointerEvent) {
      const d = dragRef.current;
      if (!d || ev.pointerId !== d.pointerId) return;

      if (!d.dragging) {
        if (Math.hypot(ev.clientX - d.downX, ev.clientY - d.downY) < DRAG_THRESHOLD_PX) return;
        d.dragging = true;
        gl.domElement.style.cursor = d.mode === 'rotate' ? 'crosshair' : 'grabbing';
        if (d.mode === 'move') onDragStart(d.iid); else onRotateDragStart(d.iid);
      }

      const mesh = meshRef.current;
      const part = partsRef.current[d.index];
      if (!mesh || !part) return;

      if (d.mode === 'move') {
        const hit = raycastGround(ev.clientX, ev.clientY);
        if (!hit) return;
        let newX = hit.x + d.offsetX;
        let newZ = hit.z + d.offsetZ;

        // v1.3 — Shift: lock movement to whichever axis has moved further
        // from the drag's start, so a straight slide along one axis doesn't
        // drift off it from a slightly unsteady hand.
        if (ev.shiftKey) {
          const ddx = newX - d.startX, ddz = newZ - d.startZ;
          if (Math.abs(ddx) >= Math.abs(ddz)) newZ = d.startZ; else newX = d.startX;
        }
        // v1.3 — Ctrl/Cmd: snap to a 0.25 m grid for precise, repeatable placement.
        if (ev.ctrlKey || ev.metaKey) {
          newX = Math.round(newX / GRID_SNAP_M) * GRID_SNAP_M;
          newZ = Math.round(newZ / GRID_SNAP_M) * GRID_SNAP_M;
        }

        d.lastX = newX;
        d.lastZ = newZ;

        // v1.2: preserve the part's current rotation during the live drag preview.
        const [sx, sy, sz] = part.geo.scale;
        const [rx, ry, rz] = part.rotation;
        _euler.set(THREE.MathUtils.degToRad(rx), THREE.MathUtils.degToRad(ry), THREE.MathUtils.degToRad(rz), 'XYZ');
        _quat.setFromEuler(_euler);
        const halfY = projectedHalfExtentY(sx * 0.5, sy * 0.5, sz * 0.5, _quat.x, _quat.y, _quat.z, _quat.w);
        _pos.set(newX, halfY, newZ);
        _scl.set(sx, sy, sz);
        _m4.compose(_pos, _quat, _scl);
        mesh.setMatrixAt(d.index, _m4);
        mesh.instanceMatrix.needsUpdate = true;
        invalidate();
      } else {
        // ── v1.3 — Rotate-drag: pure screen-delta math, no raycasting ──────────
        const dxPx = ev.clientX - d.downX;
        const dyPx = ev.clientY - d.downY;
        let yaw   = d.startYaw   + dxPx * ROTATE_DEG_PER_PX;
        let pitch = d.pitchLocked ? d.startPitch : d.startPitch + dyPx * ROTATE_DEG_PER_PX;
        if (ev.shiftKey) {
          yaw = snapAngle(yaw);
          if (!d.pitchLocked) pitch = snapAngle(pitch);
        }
        d.lastYaw   = yaw;
        d.lastPitch = pitch;

        const [sx, sy, sz] = part.geo.scale;
        const roll = part.rotation[2]; // roll isn't drag-controlled — keep it as-is
        _euler.set(THREE.MathUtils.degToRad(pitch), THREE.MathUtils.degToRad(yaw), THREE.MathUtils.degToRad(roll), 'XYZ');
        _quat.setFromEuler(_euler);
        const halfY = projectedHalfExtentY(sx * 0.5, sy * 0.5, sz * 0.5, _quat.x, _quat.y, _quat.z, _quat.w);
        _pos.set(part.position[0], halfY, part.position[2]); // grabbed part's own (x,z) is unchanged while spinning
        _scl.set(sx, sy, sz);
        _m4.compose(_pos, _quat, _scl);
        mesh.setMatrixAt(d.index, _m4);
        mesh.instanceMatrix.needsUpdate = true;
        invalidate();
      }
    }

    function endDrag(ev: PointerEvent) {
      const d = dragRef.current;
      if (!d || ev.pointerId !== d.pointerId) return;
      dragRef.current = null;
      gl.domElement.style.cursor = 'auto';
      // Always re-enable orbit-rotate on release, regardless of click or drag.
      // v1.3: only .enableRotate — pan/zoom were never disabled in the first place.
      if (controlsRef.current) controlsRef.current.enableRotate = true;

      if (d.dragging) {
        if (d.mode === 'move') onDragEnd(d.iid, d.lastX, d.lastZ);
        else                   onRotateDragEnd(d.iid, d.lastYaw, d.lastPitch);
      } else {
        onClick(d.iid, ev.shiftKey);
      }
    }

    // Safety net: if the window loses focus mid-drag (alt-tab, a native file
    // picker, a browser permission prompt...) no pointerup ever reaches the
    // page, so dragRef would stay set and OrbitControls would stay disabled
    // forever. Commit the in-progress move/rotate and clean up exactly as a
    // normal release would, rather than leaving the viewport stuck.
    function handleBlur() {
      const d = dragRef.current;
      if (!d) return;
      dragRef.current = null;
      gl.domElement.style.cursor = 'auto';
      if (controlsRef.current) controlsRef.current.enableRotate = true;
      if (d.dragging) {
        if (d.mode === 'move') onDragEnd(d.iid, d.lastX, d.lastZ);
        else                   onRotateDragEnd(d.iid, d.lastYaw, d.lastPitch);
      }
    }

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);
    window.addEventListener('blur', handleBlur);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', endDrag);
      window.removeEventListener('pointercancel', endDrag);
      window.removeEventListener('blur', handleBlur);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClick, onDragStart, onDragEnd, onRotateDragStart, onRotateDragEnd, raycastGround, invalidate, gl, controlsRef]); // partsRef — always-current ref

  // Never return null — the mesh must stay mounted even when empty so that
  // MAX_INSTANCES_PER_BUCKET pre-allocation is preserved. Effect A handles
  // the empty case by setting mesh.count = 0, making it fully invisible.

  return (
    <>
    <instancedMesh
      ref={meshRef}
      args={[GEO[type], undefined, MAX_INSTANCES_PER_BUCKET]}
      castShadow
      receiveShadow
      onPointerOver={(e) => {
        e.stopPropagation();
        // v1.1: guard against stale instanceId arriving after a part removal.
        if (e.instanceId !== undefined && e.instanceId < parts.length) {
          onHover(parts[e.instanceId].iid);
          // v1.3: hint the rotate-drag modifier with a distinct cursor.
          if (!dragRef.current) gl.domElement.style.cursor = isRotateKeyRef.current ? 'crosshair' : 'grab';
        }
      }}
      onPointerOut={(e) => {
        e.stopPropagation();
        onHover(null);
        if (!dragRef.current) gl.domElement.style.cursor = 'auto';
      }}
      onPointerDown={(e) => {
        e.stopPropagation();
        if (e.button !== 0) return; // left button only — right/middle stay free for camera controls
        if (e.instanceId === undefined || e.instanceId >= parts.length) return;
        const part = parts[e.instanceId];
        const mode: 'move' | 'rotate' = isRotateKeyRef.current ? 'rotate' : 'move';
        const hit = raycastGround(e.clientX, e.clientY);
        // Disable orbit-ROTATE immediately (before drag-threshold check) so
        // OrbitControls never picks up pointermove as a camera orbit during a
        // part-press, even a brief click. Pan/zoom are left enabled throughout
        // (v1.3) — endDrag() always re-enables rotate on pointerup, so this is safe.
        if (controlsRef.current) controlsRef.current.enableRotate = false;
        const [px, , pz] = part.position;
        const [rx, ry] = part.rotation;
        dragRef.current = {
          iid:         part.iid,
          index:       e.instanceId,
          pointerId:   e.pointerId,
          downX:       e.clientX,
          downY:       e.clientY,
          mode,
          dragging:    false,
          offsetX:     hit ? px - hit.x : 0,
          offsetZ:     hit ? pz - hit.z : 0,
          startX:      px,
          startZ:      pz,
          lastX:       px,
          lastZ:       pz,
          startYaw:    ry,
          startPitch:  rx,
          pitchLocked: !!part.groupId,
          lastYaw:     ry,
          lastPitch:   rx,
        };
      }}
    >
      <meshStandardMaterial
        vertexColors
        roughness={0.18}
        metalness={0.0}
        envMapIntensity={0}
        flatShading
        wireframe={viewMode === 'wireframe'}
        transparent={viewMode === 'xray'}
        opacity={viewMode === 'xray' ? 0.22 : 1}
        depthWrite={viewMode !== 'xray'}
      />
    </instancedMesh>
    {/* Edge-overlay mesh — shares instanceMatrix, shows geometry edges.
        raycast disabled: this sits exactly on top of the interactive solid
        mesh, so without this it can intermittently steal the pointer hit-test
        (pointerdown/pointerover) meant for meshRef, since both have identical
        geometry at identical transforms. Purely decorative — never needs to
        receive pointer events itself. */}
    <instancedMesh
      ref={wireRef}
      args={[GEO[type], undefined, MAX_INSTANCES_PER_BUCKET]}
      visible={viewMode !== 'wireframe'}
      raycast={() => null}
    >
      <meshBasicMaterial
        wireframe
        color="#000000"
        polygonOffset
        polygonOffsetFactor={-1}
        polygonOffsetUnits={-1}
      />
    </instancedMesh>
    </>
  );
});

// ── Centre-of-Mass pin ────────────────────────────────────────────────────────

const CoMMarker = memo(function CoMMarker({
  x, y, z,
}: {
  x: number;
  y: number;
  z: number;
}) {
  const pinH = Math.max(y, 0.05);

  return (
    <group position={[x, 0, z]}>
      {/* Ground ring */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.015, 0]} raycast={() => null}>
        <ringGeometry args={[0.20, 0.28, 36]} />
        <meshBasicMaterial color="#ff3030" transparent opacity={0.85} />
      </mesh>
      {/* Cross lines on ground */}
      {[0, Math.PI / 2].map((rot, i) => (
        <mesh key={i} rotation={[-Math.PI / 2, rot, 0]} position={[0, 0.016, 0]} raycast={() => null}>
          <planeGeometry args={[0.56, 0.04]} />
          <meshBasicMaterial color="#ff3030" transparent opacity={0.5} />
        </mesh>
      ))}
      {/* Vertical pin — unit cylinder scaled to CoM height; geometry allocated once */}
      <mesh position={[0, pinH * 0.5, 0]} scale={[1, pinH, 1]} raycast={() => null}>
        <cylinderGeometry args={[0.022, 0.022, 1, 8]} />
        <meshBasicMaterial color="#ff3030" transparent opacity={0.4} />
      </mesh>
      {/* Horizontal ring at the true CoM height */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, pinH, 0]} raycast={() => null}>
        <ringGeometry args={[0.12, 0.19, 32]} />
        <meshBasicMaterial color="#ff6060" transparent opacity={0.90} />
      </mesh>
      {/* Tip sphere at the true CoM height */}
      <mesh position={[0, pinH, 0]} raycast={() => null}>
        <sphereGeometry args={[0.065, 12, 8]} />
        <meshBasicMaterial color="#ff3030" />
      </mesh>
    </group>
  );
});

// ── Hover label ───────────────────────────────────────────────────────────────

const HoverLabel = memo(function HoverLabel({
  name, massKg, costUsd, x, yTop, z,
}: {
  name: string; massKg: number; costUsd: number; x: number; yTop: number; z: number;
}) {
  const massStr = fmtMass(massKg);
  const costStr = costUsd >= 1000
    ? `$${(costUsd / 1000).toFixed(1)}k`
    : `$${costUsd.toFixed(0)}`;

  return (
    <Billboard position={[x, yTop + 0.55, z]}>
      <Text
        fontSize={0.185}
        color="#111111"
        anchorX="center"
        anchorY="bottom"
        maxWidth={6}
        textAlign="center"
        outlineWidth={0.030}
        outlineColor="#ffffff"
        raycast={() => null}
      >
        {`${name}\n${massStr}  ·  ${costStr}`}
      </Text>
    </Billboard>
  );
});

// ── Scene (rendered inside Canvas context) ────────────────────────────────────
//
// Scene owns all R3F state that requires the Three.js context:
//   • invalidate() scheduling (frameloop="demand" requires explicit calls)
//   • Adaptive DPR management via gl.setPixelRatio()
//   • Part hover state (selection is lifted to Viewport3D — see v1.3 note below)
//   • Shadow LOD based on part count

interface SceneProps {
  parts:          InstalledPart[];
  autoPos:        Map<string, [number, number, number]>;
  physics:        AssemblyPhysics;
  showCoM:        boolean;
  shadowsOn:      boolean;
  onFps:          (n: number) => void;
  viewMode:       'solid' | 'wireframe' | 'xray';
  /** v1.3: was a single `string | null`. Multi-select + locked groups both
   *  need "more than one part selected at once" to be representable. */
  selectedIids:   Set<string>;
  onSelectMany:   (iids: Set<string>) => void;
  controlsRef:    { current: { enabled: boolean; enableRotate: boolean } | null };
  isRotateKeyRef: { current: boolean };
}

function Scene({
  parts, autoPos, physics, showCoM, shadowsOn, onFps, viewMode,
  selectedIids, onSelectMany, controlsRef, isRotateKeyRef,
}: SceneProps) {
  const { invalidate, gl } = useThree();
  const [hoveredIid,  setHoveredIid]  = useState<string | null>(null);

  // ── Invalidation: scene must re-render when any of these change ─────────────
  //
  // frameloop="demand" means R3F only renders when invalidate() is called.
  // We call it here for prop-driven changes; callbacks call it inline for
  // hover / select changes so the GPU responds in the same RAF cycle.
  useEffect(() => { invalidate(); }, [parts,   invalidate]);
  useEffect(() => { invalidate(); }, [showCoM, invalidate]);

  // ── Adaptive pixel ratio ────────────────────────────────────────────────────
  //
  // Each tier halves fill-rate cost vs. native on Retina:
  //   0–999    → native DPR (≤ 2)
  //   1000–2999 → 1.5× max  (~44 % less pixels than 2×)
  //   3000+    → 1.0×        (75 % less pixels than 2×)
  //
  // gl.setPixelRatio() takes the actual ratio (not [min,max]).
  const dprTarget =
    parts.length >= 3000 ? 1 :
    parts.length >= 1000 ? 1.5 :
    2;

  useEffect(() => {
    const clamped = Math.min(window.devicePixelRatio, dprTarget);
    gl.setPixelRatio(clamped);
    invalidate();
  }, [dprTarget, gl, invalidate]);

  // ── Shadow LOD ──────────────────────────────────────────────────────────────
  // shadowsOn comes from Viewport3D (also used for Canvas shadows prop + HUD).
  const shadowMapSz  = parts.length < SHADOW_HQ_UNTIL ? 2048 : 1024;

  // ── ANGBAND — One-pass Scene data build ────────────────────────────────────
  //
  // v0.9 ran three separate useMemo calls, each making a full O(n) sweep over
  // `parts` whenever the build changed:
  //
  //   geoMap    useMemo([parts])           → O(n): resolvePartGeo per part
  //   partsById useMemo([parts])           → O(n): iid → InstalledPart lookup
  //   buckets   useMemo([parts,geoMap,...])→ O(n): group PlacedParts by GeoType
  //
  // All three fire on the same trigger (parts changing), so they always ran
  // back-to-back. Merging them into one pass eliminates:
  //   • 2 extra full-length iterations over the parts array per addPart() call
  //   • 2 redundant Map object allocations per build change
  //   • the getPos useCallback (closure created/destroyed each autoPos change)
  //
  // Savings at scale:
  //   1 000 parts → 2 000 fewer loop iterations per addPart()
  //   6 000 parts → 12 000 fewer loop iterations per addPart()
  //
  // Correctness: resolvePartGeo hits _geoCache on repeat calls (O(1)), so the
  // merged pass does the same work as the original three — just once, not three
  // times. Hover tooltip position is inlined below, removing the last getPos use.

  // v1.6: persists across renders — lets the memo below reuse a bucket's
  // previous array reference when nothing in it actually changed (see
  // bucketUnchanged), and keeps track of every GeoType that's ever had a
  // member so a shape dropping to zero parts doesn't unmount its
  // InstancedBucket (see the note inside the memo below).
  const prevBucketsRef = useRef<Map<GeoType, PlacedPart[]>>(new Map());

  const { geoMap, partsById, buckets } = useMemo(() => {
    const geoMap    = new Map<string, PartGeo>();
    const partsById = new Map<string, InstalledPart>();
    const freshBucketMap = new Map<GeoType, PlacedPart[]>();

    for (const p of parts) {
      const geo = resolvePartGeo(p);
      const pos: [number, number, number] =
        p.position ?? autoPos.get(p.iid) ?? [0, 0, 0];
      // v1.2: undefined rotation (every part before this version, and every
      // part a user hasn't touched the rotate control for) reads as upright.
      const rot: [number, number, number] = p.rotation ?? [0, 0, 0];

      geoMap.set(p.iid, geo);
      partsById.set(p.iid, p);

      let bucket = freshBucketMap.get(geo.type);
      if (!bucket) { bucket = []; freshBucketMap.set(geo.type, bucket); }
      // v1.3: groupId passed through so InstancedBucket can decide, at
      // pointerdown, whether a rotate-drag should also drive pitch.
      bucket.push({ iid: p.iid, position: pos, rotation: rot, groupId: p.groupId, geo });
    }

    // v1.6 — Reuse each bucket's previous array reference when its contents
    // are value-identical to last time. This loop itself is still O(n) (it
    // has to be — every part needs to land in the right bucket), but it's a
    // CHEAP O(n): resolvePartGeo is a cache hit for any part that's been
    // seen before (see the v1.6 note in geometryResolver.ts for why that's
    // now a real cache hit and not just a cached lookup preceded by a full
    // regex re-scan), and grouping/pushing is just Map/array bookkeeping —
    // no trig, no matrix composition, no colour math. THAT expensive work
    // lives in InstancedBucket's Effect A, which only re-runs for a bucket
    // whose `parts` PROP got a new array reference — so a bucket nothing
    // touched keeps its old reference and Effect A skips it entirely,
    // instead of every single-part edit anywhere in the build reprocessing
    // every OTHER shape bucket too.
    const buckets = new Map<GeoType, PlacedPart[]>();
    const prevBuckets = prevBucketsRef.current;
    const seenTypes = new Set<GeoType>();
    for (const [type, freshArr] of freshBucketMap) {
      seenTypes.add(type);
      const prevArr = prevBuckets.get(type);
      buckets.set(type, bucketUnchanged(prevArr, freshArr) ? prevArr! : freshArr);
    }
    // A GeoType that had members before but has none now still needs an
    // entry (an empty array) so its InstancedBucket stays mounted at
    // count = 0 rather than unmounting — losing its pre-allocated
    // MAX_INSTANCES_PER_BUCKET buffers — only to potentially remount and
    // reallocate from scratch if that shape type reappears later.
    for (const [type, prevArr] of prevBuckets) {
      if (!seenTypes.has(type)) {
        buckets.set(type, prevArr.length === 0 ? prevArr : []);
      }
    }
    prevBucketsRef.current = buckets;

    return { geoMap, partsById, buckets };
  }, [parts, autoPos]);

  // ── Hover tooltip data ───────────────────────────────────────────────────────
  const hovPart = hoveredIid ? (partsById.get(hoveredIid) ?? null) : null;
  const hovGeo  = hovPart ? geoMap.get(hovPart.iid) : null;
  const hovPos: [number, number, number] | null = hovPart
    ? (hovPart.position ?? autoPos.get(hovPart.iid) ?? [0, 0, 0])
    : null;

  // ── Callbacks — call invalidate() inline so the frame is queued immediately ─
  const onHover = useCallback((iid: string | null) => {
    setHoveredIid(iid);
    invalidate();
  }, [invalidate]);

  // v1.3 — Click: plain click selects iid (or its whole group, if locked);
  // shift+click toggles iid (or its whole group) in/out of the current
  // selection, leaving the rest of the selection alone.
  // v1.6: same stability reasoning as onManipulateStart above — reads parts
  // from the store rather than the prop, so this callback (and therefore
  // InstancedBucket's window-listener effect that depends on it) doesn't
  // get a new identity on every unrelated build edit.
  const onClick = useCallback((iid: string, shiftKey: boolean) => {
    const group = expandToGroup(iid, useBuildStore.getState().parts);
    if (shiftKey) {
      const next = new Set(selectedIids);
      const alreadyIn = group.every((g) => next.has(g));
      if (alreadyIn) for (const g of group) next.delete(g);
      else            for (const g of group) next.add(g);
      onSelectMany(next);
    } else {
      // Plain click on something already exactly the current selection
      // deselects (mirrors the old single-select toggle-off behaviour).
      const same = group.length === selectedIids.size && group.every((g) => selectedIids.has(g));
      onSelectMany(same ? new Set() : new Set(group));
    }
    invalidate();
  }, [invalidate, onSelectMany, selectedIids]);

  const onDeselect = useCallback((shiftKey: boolean) => {
    if (shiftKey) return; // shift+click on empty ground leaves the selection alone
    onSelectMany(new Set());
    invalidate();
  }, [invalidate, onSelectMany]);

  // ── Manipulation start: shared by move-drag and rotate-drag ─────────────────
  // Grabbing a part that's already part of the current selection keeps that
  // selection as-is (this is what makes dragging one member of a locked group
  // move/rotate the whole group). Grabbing anything else replaces the
  // selection with just that part, or its whole group if it's locked —
  // matching a plain click.
  // v1.6: reads parts from the store (getState()) rather than closing over
  // the `parts` prop, so this callback's identity is stable across ordinary
  // build edits — it only changes when the SELECTION changes. Otherwise it
  // would get a new identity on every single part edit anywhere in the
  // build (parts is a new array reference on every store update), which
  // would make InstancedBucket's window-listener effect (keyed on this
  // callback) tear down and reattach on every edit, for every bucket —
  // including ones bucketUnchanged() correctly identified as untouched.
  const onManipulateStart = useCallback((iid: string) => {
    if (!selectedIids.has(iid)) {
      onSelectMany(new Set(expandToGroup(iid, useBuildStore.getState().parts)));
    }
    if (controlsRef.current) controlsRef.current.enableRotate = false;
    invalidate();
  }, [selectedIids, onSelectMany, controlsRef, invalidate]);

  // ── Move-drag commit ─────────────────────────────────────────────────────────
  // Resolves the grabbed part's TRUE current position (explicit or autoPos —
  // see resolvePositions) to compute the delta, then resolves EVERY group
  // member's true position the same way before shifting them — a part that's
  // never been individually touched only exists at its autoPos spiral slot,
  // never in the store, so skipping this and reading `.position` directly
  // would silently snap it to the origin on its first group move. Reads the
  // store directly (not the `parts` prop / `selectedIids` state) so this
  // callback's identity never needs to change — no risk of a stale closure
  // mattering, and InstancedBucket's window-listener effect never has to
  // tear down and reattach mid-gesture because of this callback.
  const onPartDragEnd = useCallback((iid: string, x: number, z: number) => {
    const store = useBuildStore.getState();
    const part = store.parts.find((p) => p.iid === iid);
    if (!part) { invalidate(); return; }
    const grabbed = resolvePositions([iid], store.parts, autoPos)[0];
    const deltaX = x - grabbed.x, deltaZ = z - grabbed.z;
    const targets = expandToGroup(iid, store.parts);
    const resolved = resolvePositions(targets, store.parts, autoPos);
    store.setPartsPositions(resolved.map((r) => ({ iid: r.iid, x: r.x + deltaX, z: r.z + deltaZ })));
    if (controlsRef.current) controlsRef.current.enableRotate = true;
    invalidate();
  }, [controlsRef, invalidate, autoPos]);

  // ── Rotate-drag commit ───────────────────────────────────────────────────────
  // Ungrouped: apply the drag's final absolute yaw+pitch directly (roll is
  // untouched — not drag-controlled). Grouped: apply only the YAW delta, as a
  // rigid pivot around the group's centroid (rotateGroupYawBy), using every
  // member's autoPos-resolved current position for the same reason as
  // onPartDragEnd above — see the v1.3 header note on why pitch/roll aren't
  // pivoted for a group.
  const onPartRotateDragEnd = useCallback((iid: string, yaw: number, pitch: number) => {
    const store = useBuildStore.getState();
    const part = store.parts.find((p) => p.iid === iid);
    if (!part) { invalidate(); return; }
    if (part.groupId) {
      const startYaw = (part.rotation ?? [0, 0, 0])[1];
      const targets = expandToGroup(iid, store.parts);
      const resolved = resolvePositions(targets, store.parts, autoPos);
      store.rotateGroupYawBy(resolved, yaw - startYaw);
    } else {
      const [, , rz] = part.rotation ?? [0, 0, 0];
      store.rotatePartTo(iid, [normalizeDeg(pitch), normalizeDeg(yaw), rz]);
    }
    if (controlsRef.current) controlsRef.current.enableRotate = true;
    invalidate();
  }, [controlsRef, invalidate, autoPos]);

  return (
    <>
      {/* ── Real FPS counter — runs inside Canvas to access useFrame ── */}
      <FPSTracker onFps={onFps} />

      {/* ── Lighting ────────────────────────────────────────── */}
      <ambientLight intensity={0.70} color="#ffffff" />

      {/* Primary directional light — shadow LOD controlled by part count */}
      <directionalLight
        position={[16, 28, 12]}
        intensity={1.4}
        castShadow={shadowsOn}
        shadow-mapSize-width={shadowMapSz}
        shadow-mapSize-height={shadowMapSz}
        shadow-camera-left={-SHADOW_EXTENT_M}
        shadow-camera-right={SHADOW_EXTENT_M}
        shadow-camera-top={SHADOW_EXTENT_M}
        shadow-camera-bottom={-SHADOW_EXTENT_M}
        shadow-camera-far={SHADOW_EXTENT_M * 3}
        shadow-bias={parts.length < SHADOW_HQ_UNTIL ? -0.0004 : -0.0008}
      />
      <directionalLight position={[-12, 14, -8]} intensity={0.40} color="#e8eeff" />
      <hemisphereLight args={["#f0f4ff" as any, "#d0d8e8" as any, 0.30]} />

      {/* ── Grid floor ──────────────────────────────────────── */}
      <Grid
        args={[200, 200]}
        cellSize={1}
        cellThickness={0.5}
        cellColor="#c0c0c0"
        sectionSize={5}
        sectionThickness={1.0}
        sectionColor="#888888"
        fadeDistance={120}
        fadeStrength={2}
        infiniteGrid
      />

      {/* ── Part buckets — ≤ 8 draw calls total ─────────────── */}
      {Array.from(buckets.entries()).map(([type, placed]) => (
        <InstancedBucket
          key={type}
          type={type}
          parts={placed}
          selectedIids={selectedIids}
          hoveredIid={hoveredIid}
          onHover={onHover}
          onClick={onClick}
          onDragStart={onManipulateStart}
          onDragEnd={onPartDragEnd}
          onRotateDragStart={onManipulateStart}
          onRotateDragEnd={onPartRotateDragEnd}
          viewMode={viewMode}
          controlsRef={controlsRef}
          isRotateKeyRef={isRotateKeyRef}
        />
      ))}

      {/* ── Hover tooltip ────────────────────────────────────── */}
      {hovPart && hovGeo && hovPos && (
        <Suspense fallback={null}>
          <HoverLabel
            name={hovPart.name}
            massKg={hovPart.specs?.mass_kg   ?? 5}
            costUsd={hovPart.specs?.cost_usd ?? 0}
            x={hovPos[0]}
            yTop={hovGeo.scale[1]}
            z={hovPos[2]}
          />
        </Suspense>
      )}

      {/* ── CoM pin ─────────────────────────────────────────── */}
      {showCoM && parts.length > 1 && (
        <CoMMarker
          x={physics.com.x}
          y={physics.com.y}
          z={physics.com.z}
        />
      )}

      {/* ── Invisible ground plane — click to deselect ──────── */}
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, -0.01, 0]}
        onClick={(e) => onDeselect(e.nativeEvent.shiftKey)}
      >
        <planeGeometry args={[20000, 20000]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
    </>
  );
}

// ── FPS counter — must live inside Canvas (requires useFrame / R3F context) ────
//
// Previous implementation (v0.6–v0.7): counted browser RAF ticks outside Canvas.
// With frameloop="demand", RAF still fires at 60 Hz regardless of how many frames
// R3F actually renders — so the HUD always showed "60 fps" even when the scene
// had been completely idle for minutes. That number was meaningless as a workload
// indicator and actively misleading to the user.
//
// Fix: FPSTracker uses useFrame, which R3F only invokes when it dispatches a real
// render. With frameloop="demand", this correctly shows the actual GPU render rate:
//   • Interactive (user orbiting/hovering): 30–60 fps as expected
//   • Idle (no user input):                 0 fps after ~1.5 s silence
//
// Implementation:
//   • Counts useFrame ticks over a 1-second window → fps state.
//   • lastFrameTime ref is updated every frame; a fixed 500 ms interval checks
//     whether it has been stale for > 1500 ms and reports 0 if so.
//   • Previously, clearTimeout + setTimeout fired on EVERY rendered frame
//     (60 timer allocations / sec at 60 fps). Now: 2 interval checks / sec
//     regardless of frame rate — zero per-frame timer allocation.
//   • FPSTracker renders null — zero visual output, one useFrame per frame.
//   • onFps callback is stable (useCallback in Viewport3D) → no re-subscription.

interface FPSTrackerProps { onFps: (n: number) => void; }

function FPSTracker({ onFps }: FPSTrackerProps) {
  const frames        = useRef(0);
  const last          = useRef(performance.now());
  const lastFrameTime = useRef(performance.now());

  // Single fixed-rate interval for idle detection — never reallocated.
  // Fires every 500 ms; if no frame has arrived in the last 1500 ms, report idle.
  useEffect(() => {
    const id = setInterval(() => {
      if (performance.now() - lastFrameTime.current > 1500) onFps(0);
    }, 500);
    return () => clearInterval(id);
  }, [onFps]);

  useFrame(() => {
    frames.current++;
    lastFrameTime.current = performance.now();
    const delta = lastFrameTime.current - last.current;

    if (delta >= 1000) {
      onFps(Math.round(frames.current * 1000 / delta));
      frames.current = 0;
      last.current   = lastFrameTime.current;
    }
  });

  return null;
}

// ── HUD formatting helpers ────────────────────────────────────────────────────

/** Format a mass value with automatic SI suffix. */
function fmtMass(kg: number): string {
  if (kg <= 0)      return "—";
  if (kg >= 1e6)    return `${(kg / 1e6).toFixed(2)} Mt`;
  if (kg >= 1000)   return `${(kg / 1000).toFixed(2)} t`;
  if (kg >= 1)      return `${kg.toFixed(1)} kg`;
  if (kg >= 0.001)  return `${(kg * 1000).toFixed(1)} g`;
  return `${(kg * 1e6).toFixed(0)} mg`;  // sub-gram: micro-parts, sensors, fasteners
}

/**
 * Format a moment of inertia (kg·m²) with SI suffix.
 * Ranges from milli- (tiny parts) to giga- (submarine hulls).
 */
function fmtI(kgm2: number): string {
  if (!isFinite(kgm2) || kgm2 <= 0) return "—";
  if (kgm2 >= 1e9) return `${(kgm2 / 1e9).toFixed(1)}G`;
  if (kgm2 >= 1e6) return `${(kgm2 / 1e6).toFixed(1)}M`;
  if (kgm2 >= 1e3) return `${(kgm2 / 1e3).toFixed(1)}k`;
  if (kgm2 >= 1)   return `${kgm2.toFixed(1)}`;
  return `${(kgm2 * 1000).toFixed(0)}m`;
}

// ── Viewport3D (main export) ──────────────────────────────────────────────────

export default function Viewport3D({ className = "" }: { className?: string }) {
  const parts        = useBuildStore((s) => s.parts);
  const rotatePartTo = useBuildStore((s) => s.rotatePartTo);
  const { viewMode } = useUIStore();

  // v1.3 — Lifted selection state, now a Set: multi-select and locked groups
  // both need "more than one part selected at once" to be representable.
  const [selectedIids, setSelectedIids] = useState<Set<string>>(new Set());

  // Ref to the OrbitControls instance. v1.3: widened to also expose
  // enableRotate — a drag now only disables orbit-ROTATE (previously the
  // whole instance was disabled via .enabled), leaving pan/zoom live
  // throughout. See the v1.3 header note ("Camera stays live during any
  // manipulation").
  const controlsRef = useRef<{ enabled: boolean; enableRotate: boolean } | null>(null);

  // v1.3 — true while R is held, read at pointerdown to choose move vs.
  // rotate-drag. Not a native pointer-event modifier (unlike shift/ctrl), so
  // it needs its own tracked ref, threaded down through Scene to every
  // InstancedBucket.
  const isRotateKeyRef = useRef(false);
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key.toLowerCase() !== 'r' || e.ctrlKey || e.metaKey) return; // don't hijack Ctrl/Cmd+R (reload)
      const tag = (document.activeElement?.tagName ?? '').toLowerCase();
      if (tag === 'input' || tag === 'textarea') return;
      isRotateKeyRef.current = true;
    }
    function handleKeyUp(e: KeyboardEvent) {
      if (e.key.toLowerCase() === 'r') isRotateKeyRef.current = false;
    }
    // Safety net matching InstancedBucket's drag handleBlur: if the window
    // loses focus while R is physically held (alt-tab etc.), no keyup ever
    // arrives, so this would otherwise stay stuck "on" until the next tap of R.
    function handleBlur() { isRotateKeyRef.current = false; }
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', handleBlur);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', handleBlur);
    };
  }, []);

  // ── Auto-layout: phyllotaxis spiral, index-stable for all operations ─────────
  //
  // v1.1 fix: replaces the sequential idx++ counter that caused all unpositioned
  // parts after a deleted part to shift spiral positions. Symptom: removing "part B"
  // of [A, B, C] moved C from slot 2 to slot 1 — a jarring jump in the viewport.
  //
  // Fix: a persistent iid→spiralSlot Map held in a ref.
  //   • Each new unpositioned iid is assigned the next available integer slot, once.
  //   • Removing a part leaves its slot unused; remaining parts keep their slots.
  //   • Adding parts always gets the next fresh slot → no shifts for existing parts.
  //   • Slots are intentionally NOT compacted on removal to preserve ordering.
  //     The golden-angle spiral degrades gracefully with sparse indices (slightly
  //     wider spacing) — far better than shifting all surviving parts.
  //
  // v1.3: moved above the keyboard-shortcut effect and the lock/mirror/remove
  // callbacks below, since resolvePositions() (used by all of them for
  // group-aware position math) needs autoPos in scope — see the ResolvedXZ
  // doc comment in store.ts for why.

  const _spiralSlots = useRef(new Map<string, number>());
  const _nextSlot    = useRef(0);

  const autoPos = useMemo<Map<string, [number, number, number]>>(() => {
    const m = new Map<string, [number, number, number]>();
    for (const p of parts) {
      if (!p.position) {
        if (!_spiralSlots.current.has(p.iid)) {
          _spiralSlots.current.set(p.iid, _nextSlot.current++);
        }
        m.set(p.iid, spiralPosition(_spiralSlots.current.get(p.iid)!, 3.0));
      }
    }
    return m;
  }, [parts]);

  // Keep selectedIids valid when parts change (e.g. parts removed externally).
  // Functional update form (prev => next) avoids needing selectedIids itself
  // in the dependency array, and returns `prev` unchanged (same reference)
  // when nothing was actually stale, so React skips the re-render entirely.
  useEffect(() => {
    setSelectedIids((prev) => {
      if (prev.size === 0) return prev;
      let changed = false;
      const next = new Set<string>();
      for (const iid of prev) {
        if (parts.some((p) => p.iid === iid)) next.add(iid);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [parts]);

  // ── v1.2/v1.3 — Keyboard rotate shortcuts ───────────────────────────────────
  // [ / ] nudge yaw ±15°; shift+[ / shift+] (which arrive as '{' / '}' on a US
  // layout) jump ±90°. A single selected part gets an exact rotatePartTo; 2+
  // selected (an ad-hoc multi-select OR a locked group — same rule either way,
  // see the v1.3 header note) gets a rigid pivot via rotateGroupYawBy. Bails
  // while a text input has focus so it never fights typing into the panel's
  // own degree fields. Reads/writes the store directly (getState()) rather
  // than closing over `parts`, so the listener only needs to be torn down and
  // re-attached when the SELECTION changes, not on every build edit.
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (selectedIids.size === 0) return;
      const tag = (document.activeElement?.tagName ?? '').toLowerCase();
      if (tag === 'input' || tag === 'textarea') return;

      let delta = 0;
      if      (e.key === '[') delta = -15;
      else if (e.key === ']') delta = 15;
      else if (e.key === '{') delta = -90;
      else if (e.key === '}') delta = 90;
      else return;

      e.preventDefault();
      const store = useBuildStore.getState();
      const ids = Array.from(selectedIids);
      if (ids.length === 1) {
        const sel = store.parts.find((p) => p.iid === ids[0]);
        if (!sel) return;
        const [rx, ry, rz] = sel.rotation ?? [0, 0, 0];
        store.rotatePartTo(ids[0], [rx, normalizeDeg(ry + delta), rz]);
      } else {
        store.rotateGroupYawBy(resolvePositions(ids, store.parts, autoPos), delta);
      }
    }
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [selectedIids, autoPos]);

  // ── v1.3 — Selection-level actions (lock/unlock/mirror/remove) ─────────────
  // All read/write the store imperatively via getState() — consistent with
  // the drag-commit callbacks in Scene, and keeps these stable across renders.
  const lockSelectionTogether = useCallback(() => {
    useBuildStore.getState().groupParts(Array.from(selectedIids));
  }, [selectedIids]);

  const unlockSelection = useCallback(() => {
    useBuildStore.getState().ungroupParts(Array.from(selectedIids));
  }, [selectedIids]);

  const mirrorSelection = useCallback(() => {
    const store = useBuildStore.getState();
    const resolved = resolvePositions(Array.from(selectedIids), store.parts, autoPos);
    const newIids = store.mirrorParts(resolved);
    if (newIids.length > 0) setSelectedIids(new Set(newIids)); // select the new copies
  }, [selectedIids, autoPos]);

  const removeSelection = useCallback(() => {
    useBuildStore.getState().removeParts(Array.from(selectedIids));
    setSelectedIids(new Set());
  }, [selectedIids]);

  // ── Single-pass assembly physics (v0.6) ────────────────────────────────────
  //
  // Replaces the four separate useMemo passes in v0.5:
  //   • com: { x, y, z }   (was its own useMemo)
  //   • bucketCount         (was its own useMemo)
  //
  // Now also adds:
  //   • physics.totalMass
  //   • physics.inertia   { Ixx, Iyy, Izz }
  //   • physics.stability [0 … 1]
  //   • physics.bounds    { minX, maxX, minZ, maxZ, maxY }
  const physics = useMemo<AssemblyPhysics>(
    () => computeAssemblyPhysics(parts, autoPos),
    [parts, autoPos],
  );

  const [showCoM, setShowCoM] = useState(true);
  // fps state is updated by FPSTracker (inside Canvas via useFrame).
  // useCallback keeps the reference stable so FPSTracker never re-subscribes.
  const [fps, setFps] = useState(0);
  const onFps = useCallback((n: number) => setFps(n), []);

  // ── HUD physics display values ──────────────────────────────────────────────
  const massStr    = fmtMass(physics.totalMass);
  const comYStr    = physics.com.y.toFixed(2);

  const stabColor  =
    physics.stability > 0.70 ? "#4ade80" :
    physics.stability > 0.35 ? "#fbbf24" :
                               "#f87171";
  const stabLabel  =
    physics.stability > 0.70 ? "stable" :
    physics.stability > 0.35 ? "marginal" :
                               "unstable";

  // Axis labels follow Three.js world space:
  //   Ixx = pitch (nose up/down),  Iyy = yaw (turn left/right),  Izz = roll
  const { Ixx, Iyy, Izz } = physics.inertia;
  const inertiaStr = parts.length > 1
    ? `Ipitch ${fmtI(Ixx)}  Iyaw ${fmtI(Iyy)}  Iroll ${fmtI(Izz)}  kg·m²`
    : null;

  // v0.7 — Weight distribution (front/rear, left/right) shown for 2+ parts
  const { front, rear, left, right } = physics.weightDistribution;
  const weightDistStr = parts.length > 1
    ? `F/R ${front.toFixed(0)}/${rear.toFixed(0)}%  ·  L/R ${left.toFixed(0)}/${right.toFixed(0)}%`
    : null;

  // v0.7 — CoM offset from footprint centre
  // Shown inline on line 2 when the offset exceeds 5 cm (non-trivial imbalance).
  const { dx: comDx, dz: comDz } = physics.comOffset;
  const comOffsetMag   = Math.sqrt(comDx * comDx + comDz * comDz);
  const showComOffset  = comOffsetMag > 0.05 && parts.length > 1;
  const comOffsetColor =
    comOffsetMag <= 0.10 ? "#4ade80" :
    comOffsetMag <= 0.40 ? "#fbbf24" :
                           "#f87171";
  const comOffsetStr   = `Δ${comOffsetMag.toFixed(2)}m`;

  // v0.7 — Fidelity warning: count of procedural parts (no mass_kg or model)
  const { procedural: procCount } = physics.fidelityProfile;
  const uncertainStr =
    procCount > 0 && parts.length > 0
      ? (procCount === parts.length ? "all procedural" : `${procCount} procedural`)
      : null;

  // v1.0 — Average confidence indicator
  // Reflects the new 0.72 tier (mass → volume → physDims) for all catalog parts.
  // Colour scale:
  //   green  ≥ 0.82  explicit / manufacturer dimensions
  //   amber  ≥ 0.72  mass-inferred physical dims  (v1.0 baseline for the full catalog)
  //   orange ≥ 0.50  mixed: some parts missing mass data
  //   red    < 0.50  mostly procedural archetypes
  const avgConf   = physics.avgConfidence;
  const confStr   = parts.length > 0 ? `conf ${avgConf.toFixed(2)}` : null;
  const confColor =
    avgConf >= 0.82 ? "#4ade80" :
    avgConf >= 0.72 ? "#fbbf24" :
    avgConf >= 0.50 ? "#fb923c" :
                      "#f87171";

  // Single source of truth for shadow on/off — also drives Canvas shadows prop and HUD.
  const shadowsOn = parts.length < SHADOW_OFF_AT;

  return (
    <div
      className={className}
      style={{ position: "absolute", inset: 0, background: "#f5f5f5" }}
    >
      {/* ── Three.js canvas ─────────────────────────────────────────────── */}
      {/*
       * frameloop="demand": R3F only renders when Scene calls invalidate().
       * GPU usage drops to ~0% when the scene is static between interactions.
       * OrbitControls calls invalidate() automatically during camera movement.
       * dpr is managed dynamically inside Scene via gl.setPixelRatio().
       */}
      <Canvas
        camera={{ position: [14, 11, 14], fov: 46, near: 0.05, far: 3000 }}
        shadows={shadowsOn ? "soft" : false}
        frameloop="demand"
        gl={{
          antialias: true,
          alpha: false,
          preserveDrawingBuffer: false,
          powerPreference: "high-performance",
        }}
        dpr={[1, 2]}   // initial range; Scene overrides via gl.setPixelRatio()
        style={{ background: "#f5f5f5" }}
      >
        <Scene
          parts={parts}
          autoPos={autoPos}
          physics={physics}
          showCoM={showCoM}
          shadowsOn={shadowsOn}
          onFps={onFps}
          viewMode={viewMode}
          selectedIids={selectedIids}
          onSelectMany={setSelectedIids}
          controlsRef={controlsRef}
          isRotateKeyRef={isRotateKeyRef}
        />
        <OrbitControls
          ref={controlsRef as any}
          makeDefault
          minDistance={0.4}
          maxDistance={800}
          panSpeed={1.5}
          rotateSpeed={0.55}
          zoomSpeed={1.3}
          maxPolarAngle={Math.PI / 2.04}
          enableDamping
          dampingFactor={0.07}
        />
      </Canvas>

      {/* ── HUD: physics stats (top-left) ───────────────────────────────── */}
      {/*
       * v0.7 four lines:
       *   Line 1  parts · fps · draw calls · [N procedural]
       *   Line 2  total mass · stability · CoM ↕  [· Δoffset]
       *   Line 3  F/R XX/XX%  ·  L/R XX/XX%       (2+ parts)
       *   Line 4  Ipitch / Iyaw / Iroll             (2+ parts)
       */}
      <div
        className="absolute top-2 left-2 select-none pointer-events-none"
        style={{
          fontFamily: "monospace",
          fontSize: 22.5,
          lineHeight: "1.65",
          background: "rgba(0,0,0,0.52)",
          backdropFilter: "blur(4px)",
          border: "1px solid rgba(255,255,255,0.07)",
          borderRadius: 8,
          padding: "10px 20px",
          color: "rgba(255,255,255,0.6)",
        }}
      >
        {/* Line 1 — scene stats + v0.7 fidelity warning */}
        <div>
          <span style={{ color: "rgba(255,255,255,0.85)" }}>
            {parts.length.toLocaleString()}
          </span>
          {" parts · "}
          <span
            style={{
              // 0 fps = idle (scene not rendering) — shown in dim white, not red.
              // Colour only triggers when the scene is actively rendering and dropping frames.
              color: fps === 0
                ? "rgba(255,255,255,0.28)"
                : fps >= 55 ? "#4ade80"
                : fps >= 30 ? "#fbbf24"
                : "#f87171",
            }}
          >
            {fps === 0 ? "idle" : `${fps} fps`}
          </span>
          {" · "}
          <span style={{ color: "rgba(255,255,255,0.35)" }}>
            {physics.bucketCount} draw call{physics.bucketCount !== 1 ? "s" : ""}
          </span>
          {/* v1.0 — confidence tier badge */}
          {confStr && (
            <span style={{ color: confColor, marginLeft: 10 }}>
              · {confStr}
            </span>
          )}
          {!shadowsOn && (
            <span style={{ color: "rgba(255,255,255,0.25)", marginLeft: 10 }}>
              · shadows off
            </span>
          )}
          {/* v0.7 — fidelity warning: amber when procedural parts are present */}
          {uncertainStr && (
            <span style={{ color: "rgba(255,160,40,0.70)", marginLeft: 10 }}>
              · {uncertainStr}
            </span>
          )}
        </div>

        {/* Line 2 — mass + stability + CoM height + v0.7 comOffset */}
        {parts.length > 0 && (
          <div>
            <span style={{ color: "rgba(255,255,255,0.75)" }}>{massStr}</span>
            {"  ·  "}
            <span style={{ color: stabColor }}>{"●"}</span>
            {" "}
            <span style={{ color: stabColor }}>{stabLabel}</span>
            {"  ·  "}
            <span style={{ color: "rgba(255,255,255,0.40)" }}>
              {"CoM ↕"}
              {comYStr}
              {" m"}
            </span>
            {/* v0.7 — CoM offset badge: only shown when imbalance is non-trivial */}
            {showComOffset && (
              <>
                {"  ·  "}
                <span style={{ color: comOffsetColor }}>
                  {comOffsetStr}
                </span>
              </>
            )}
          </div>
        )}

        {/* Line 3 — v0.7 weight distribution (2+ parts) */}
        {weightDistStr && (
          <div style={{ color: "rgba(255,255,255,0.32)", marginTop: 3 }}>
            {weightDistStr}
          </div>
        )}

        {/* Line 4 — moments of inertia (2+ parts); was Line 3 in v0.6 */}
        {inertiaStr && (
          <div style={{ color: "rgba(255,255,255,0.25)", marginTop: 3 }}>
            {inertiaStr}
          </div>
        )}
      </div>

      {/* ── HUD: CoM toggle (top-right) — only meaningful with 2+ parts ── */}
      {parts.length > 1 && (
        <button
          onClick={() => setShowCoM((v) => !v)}
          style={{
            position: "absolute",
            top: 8,
            right: 8,
            fontFamily: "monospace",
            fontSize: 9,
            padding: "3px 8px",
            borderRadius: 3,
            border: `1px solid ${
              showCoM ? "rgba(220,38,38,0.45)" : "rgba(0,0,0,0.14)"
            }`,
            background: showCoM
              ? "rgba(255,50,50,0.12)"
              : "rgba(0,0,0,0.05)",
            color: showCoM ? "#dc2626" : "rgba(0,0,0,0.45)",
            cursor: "pointer",
            transition: "all 0.15s",
          }}
          title="Toggle centre-of-mass indicator"
        >
          ⊕ CoM
        </button>
      )}

      {/* ── Selected part(s) info panel ──────────────────────────────────── */}
      {(() => {
        if (selectedIids.size === 0) return null;

        // Shared outer panel chrome for both the single- and multi-select cases.
        const panelStyle = {
          position: 'absolute' as const,
          bottom: 38,
          right: 8,
          background: 'rgba(0,0,0,0.68)',
          backdropFilter: 'blur(6px)',
          border: '1px solid rgba(255,255,255,0.10)',
          borderRadius: 4,
          padding: '7px 10px',
          fontFamily: 'monospace',
          fontSize: 9,
          color: 'rgba(255,255,255,0.70)',
          minWidth: 172,
          pointerEvents: 'auto' as const,
        };
        const sectionLabelStyle = {
          color: 'rgba(255,255,255,0.45)', fontSize: 8, letterSpacing: '0.08em', marginBottom: 4,
        };
        const dividerStyle = {
          borderTop: '1px solid rgba(255,255,255,0.12)', paddingTop: 6, marginBottom: 7,
        };
        const ghostButtonStyle = {
          background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.14)',
          borderRadius: 2, color: 'rgba(255,255,255,0.65)', fontFamily: 'monospace',
          fontSize: 9, padding: '4px 0', cursor: 'pointer' as const, letterSpacing: '0.04em',
        };
        const dangerButtonStyle = {
          background: 'rgba(239,68,68,0.18)', border: '1px solid rgba(239,68,68,0.35)',
          borderRadius: 2, color: '#f87171', fontFamily: 'monospace',
          fontSize: 9, padding: '4px 0', cursor: 'pointer' as const, letterSpacing: '0.06em',
        };

        // ── Single part selected ──────────────────────────────────────────
        if (selectedIids.size === 1) {
          const sel = parts.find((p) => p.iid === Array.from(selectedIids)[0]);
          if (!sel) return null;
          const mass = sel.specs?.mass_kg ?? 5;
          const cost = sel.specs?.cost_usd ?? 0;
          const rot: [number, number, number] = sel.rotation ?? [0, 0, 0];

          const nudgeAxis = (axis: 0 | 1 | 2, delta: number) => {
            const next: [number, number, number] = [rot[0], rot[1], rot[2]];
            next[axis] = normalizeDeg(next[axis] + delta);
            rotatePartTo(sel.iid, next);
          };
          const typeAxis = (axis: 0 | 1 | 2, raw: string) => {
            const v = parseFloat(raw);
            if (!Number.isFinite(v)) return;   // let the field be cleared/typed into without snapping mid-edit
            const next: [number, number, number] = [rot[0], rot[1], rot[2]];
            next[axis] = v;
            rotatePartTo(sel.iid, next);
          };
          const resetRotation = () => rotatePartTo(sel.iid, [0, 0, 0]);

          const rotBtnStyle = {
            width: 17, height: 17, lineHeight: '15px', textAlign: 'center' as const, padding: 0,
            fontFamily: 'monospace', fontSize: 11, background: 'rgba(255,255,255,0.08)',
            border: '1px solid rgba(255,255,255,0.18)', borderRadius: 2,
            color: 'rgba(255,255,255,0.80)', cursor: 'pointer' as const, flexShrink: 0,
          };

          const axisRow = (label: string, axis: 0 | 1 | 2) => (
            <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 3 }}>
              <span style={{ width: 9, color: 'rgba(255,255,255,0.50)' }}>{label}</span>
              <button onClick={() => nudgeAxis(axis, -15)} title={`${label} rotate −15°`} style={rotBtnStyle}>−</button>
              <input
                type="text"
                inputMode="decimal"
                value={Math.round(rot[axis])}
                onChange={(e) => typeAxis(axis, e.target.value)}
                style={{
                  width: 40, textAlign: 'center', background: 'rgba(255,255,255,0.07)',
                  border: '1px solid rgba(255,255,255,0.16)', borderRadius: 2,
                  color: 'rgba(255,255,255,0.92)', fontFamily: 'monospace', fontSize: 9,
                  padding: '2px 0', outline: 'none',
                }}
              />
              <button onClick={() => nudgeAxis(axis, 15)} title={`${label} rotate +15°`} style={rotBtnStyle}>+</button>
            </div>
          );

          return (
            <div style={panelStyle}>
              <div style={{ color: 'rgba(255,255,255,0.90)', marginBottom: 3, fontWeight: 600 }}>
                {sel.name}
              </div>
              <div style={{ color: 'rgba(255,255,255,0.40)', marginBottom: 7 }}>
                {fmtMass(mass)}
                {cost > 0 ? `  ·  $${cost >= 1000 ? (cost / 1000).toFixed(1) + 'k' : cost.toFixed(0)}` : ''}
              </div>

              {/* v1.2 — rotation panel */}
              <div style={dividerStyle}>
                <div style={sectionLabelStyle}>ROTATE · DEG</div>
                {axisRow('X', 0)}
                {axisRow('Y', 1)}
                {axisRow('Z', 2)}
                <button onClick={resetRotation} style={{ width: '100%', marginTop: 2, ...ghostButtonStyle, padding: '3px 0' }}>
                  ↺ Reset rotation
                </button>
              </div>

              {/* v1.3 — mirror + remove, side by side */}
              <div style={{ display: 'flex', gap: 6 }}>
                <button onClick={mirrorSelection} style={{ flex: 1, ...ghostButtonStyle }} title="Duplicate mirrored across X = 0">
                  ⇄ Mirror
                </button>
                <button onClick={removeSelection} style={{ flex: 1, ...dangerButtonStyle }}>
                  ✕ Remove
                </button>
              </div>
            </div>
          );
        }

        // ── Multiple parts selected (ad-hoc multi-select or a locked group) ─
        const selArray = Array.from(selectedIids);
        const selParts = parts.filter((p) => selectedIids.has(p.iid));
        const totalMass = selParts.reduce((sum, p) => sum + (p.specs?.mass_kg ?? 5), 0);

        // Is the CURRENT selection exactly one existing group's full membership?
        // (Not just "some members share a groupId" — the whole group, no more,
        // no less — otherwise "Unlock" on a partial selection would be ambiguous.)
        const groupIdsInSelection = new Set(
          selArray.map((iid) => parts.find((p) => p.iid === iid)?.groupId).filter((g): g is string => !!g)
        );
        const soleGroupId = groupIdsInSelection.size === 1 ? Array.from(groupIdsInSelection)[0] : null;
        const isWholeExistingGroup =
          soleGroupId !== null &&
          parts.filter((p) => p.groupId === soleGroupId).length === selArray.length;

        const nudgeGroupYaw = (delta: number) => {
          const store = useBuildStore.getState();
          store.rotateGroupYawBy(resolvePositions(selArray, store.parts, autoPos), delta);
        };
        const yawBtnStyle = {
          flex: 1, background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.18)',
          borderRadius: 2, color: 'rgba(255,255,255,0.80)', fontFamily: 'monospace',
          fontSize: 9, padding: '4px 0', cursor: 'pointer' as const,
        };

        return (
          <div style={panelStyle}>
            <div style={{ color: 'rgba(255,255,255,0.90)', marginBottom: 3, fontWeight: 600 }}>
              {selectedIids.size} parts selected
            </div>
            <div style={{ color: 'rgba(255,255,255,0.40)', marginBottom: 7 }}>
              {fmtMass(totalMass)} total
            </div>

            <div style={dividerStyle}>
              <div style={sectionLabelStyle}>ROTATE SELECTION · YAW</div>
              <div style={{ display: 'flex', gap: 3 }}>
                <button onClick={() => nudgeGroupYaw(-90)} style={yawBtnStyle}>−90°</button>
                <button onClick={() => nudgeGroupYaw(-15)} style={yawBtnStyle}>−15°</button>
                <button onClick={() => nudgeGroupYaw(15)}  style={yawBtnStyle}>+15°</button>
                <button onClick={() => nudgeGroupYaw(90)}  style={yawBtnStyle}>+90°</button>
              </div>
            </div>

            <button
              onClick={isWholeExistingGroup ? unlockSelection : lockSelectionTogether}
              style={{ width: '100%', marginBottom: 6, ...ghostButtonStyle }}
              title={isWholeExistingGroup ? 'Dissolve this group' : 'Move/rotate this selection together from now on'}
            >
              {isWholeExistingGroup ? '🔓 Unlock' : '🔒 Lock Together'}
            </button>

            <div style={{ display: 'flex', gap: 6 }}>
              <button onClick={mirrorSelection} style={{ flex: 1, ...ghostButtonStyle }} title="Duplicate mirrored across X = 0">
                ⇄ Mirror
              </button>
              <button onClick={removeSelection} style={{ flex: 1, ...dangerButtonStyle }}>
                ✕ Remove {selectedIids.size}
              </button>
            </div>
          </div>
        );
      })()}

      {/* ── Empty state ─────────────────────────────────────────────────── */}
      {parts.length === 0 && (
        <div
          className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none"
          style={{ gap: 12 }}
        >
          <svg
            width={52}
            height={52}
            viewBox="0 0 52 52"
            fill="none"
            style={{ opacity: 0.22 }}
          >
            <polygon
              points="26,3 47,15 47,37 26,49 5,37 5,15"
              stroke="#000"
              strokeWidth={1.4}
            />
            <polygon
              points="26,13 39,20.5 39,35.5 26,43 13,35.5 13,20.5"
              stroke="#000"
              strokeWidth={0.7}
              strokeDasharray="3 2.5"
            />
          </svg>
          <p
            style={{
              fontFamily: "monospace",
              fontSize: 11,
              letterSpacing: "0.08em",
              color: "rgba(0,0,0,0.30)",
            }}
          >
            Add parts from the panel →
          </p>
        </div>
      )}
    </div>
  );
}
