import { create } from 'zustand';
import type { InstalledPart } from '@/types';

// Small helper for generating short, unique-enough ids — same scheme addPart
// already used before this version (timestamp + random suffix), reused here
// for group ids and mirrored-part ids so every generated id in this app
// looks/behaves the same way.
function newId(suffix = ''): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}${suffix}`;
}

// Kept in sync with Viewport3D.tsx's normalizeDeg (identical 6-line formula,
// duplicated rather than shared across the store/rendering module boundary
// for one small pure function — see the v1.3 changelog note in Viewport3D.tsx
// for why that trade-off was made deliberately rather than by oversight).
function normalizeDeg(deg: number): number {
  let d = deg % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

// After any removal/ungroup, a "group" left with fewer than 2 members isn't
// a group — clear its lone member's groupId so it doesn't silently keep
// behaving as if still locked to something that no longer exists.
function dissolveSingletonGroups(parts: InstalledPart[]): InstalledPart[] {
  const counts = new Map<string, number>();
  for (const p of parts) {
    if (p.groupId) counts.set(p.groupId, (counts.get(p.groupId) ?? 0) + 1);
  }
  const orphaned = new Set<string>();
  for (const [gid, n] of counts) if (n < 2) orphaned.add(gid);
  if (orphaned.size === 0) return parts;
  return parts.map((p) =>
    p.groupId && orphaned.has(p.groupId) ? { ...p, groupId: undefined } : p
  );
}

/**
 * A part's CURRENT world (x, z) as the caller resolved it — see
 * Viewport3D.tsx's resolvePositions(). This store deliberately does NOT fall
 * back to [0,0,0] for an unresolved position anywhere below: a part that has
 * never been individually dragged has position === undefined in this store
 * and is only ever rendered via the client-side autoPos spiral layout, which
 * this store has no way to compute (it isn't part of persisted state). Any
 * action that needs to know "where is this part right now" — moving a group
 * by a delta, pivoting a group's yaw, mirroring — MUST be given the resolved
 * (x, z) by the caller, which does have autoPos available. Silently assuming
 * [0,0,0] for an unresolved part was a real bug caught during testing: it
 * made every never-individually-touched member of a freshly-grouped
 * selection jump to the origin the first time the group was moved or
 * rotated, instead of shifting/pivoting from its true on-screen position.
 */
interface ResolvedXZ { iid: string; x: number; z: number }

interface BuildStore {
  parts: InstalledPart[];
  addPart: (part: Omit<InstalledPart, 'iid'>) => void;
  removePart: (iid: string) => void;
  removeParts: (iids: string[]) => void;
  /** Sets each listed part's absolute (x, z) position — used for both
   *  single-part and group dragging (a "group" of one is just a normal
   *  move). Takes the caller's already-resolved destinations rather than a
   *  delta, so it never needs to guess a part's "current" position itself —
   *  see the ResolvedXZ doc comment above. */
  setPartsPositions: (updates: { iid: string; x: number; z: number }[]) => void;
  /** Sets one part's absolute rotation — used by the rotation panel's typed
   *  fields and single-part nudges, where an exact value makes sense. */
  rotatePartTo: (iid: string, rotation: [number, number, number]) => void;
  /** Rotates a whole selection by a yaw delta around its own (geometric,
   *  unweighted) centroid — members revolve in position AND spin by the
   *  same delta, like a rigid sub-assembly turning together. Takes each
   *  member's caller-resolved current (x, z) (see ResolvedXZ) rather than
   *  reading `.position` itself. Pitch/roll are deliberately not included
   *  here; see the v1.3 changelog note in Viewport3D.tsx for why. */
  rotateGroupYawBy: (resolved: ResolvedXZ[], deltaYawDeg: number) => void;
  /** Locks 2+ parts together. No-op for fewer than 2 (locking one part to
   *  nothing isn't meaningful). */
  groupParts: (iids: string[]) => void;
  /** Dissolves the *entire* group(s) any of these iids belong to — matches
   *  standard "ungroup" semantics elsewhere (Illustrator/Figma etc.), not
   *  "remove just these members from their group". */
  ungroupParts: (iids: string[]) => void;
  /** Mirrors the given parts across the world X=0 plane, adding NEW parts
   *  (originals are untouched) and returns the new parts' iids so the
   *  caller can select them. Takes each part's caller-resolved current
   *  (x, z) (see ResolvedXZ) rather than reading `.position` itself.
   *  Mirroring 2+ parts locks the copies together as their own fresh group;
   *  mirroring a single part does not group it with anything. */
  mirrorParts: (resolved: ResolvedXZ[]) => string[];
  clearBuild: () => void;
  loadBuild: (parts: InstalledPart[]) => void;
}

export const useBuildStore = create<BuildStore>((set, get) => ({
  parts: [],

  addPart: (part) => {
    set((s) => ({ parts: [...s.parts, { ...part, iid: newId() }] }));
  },

  removePart: (iid) => get().removeParts([iid]),

  removeParts: (iids) =>
    set((s) => {
      const toRemove = new Set(iids);
      const remaining = s.parts.filter((p) => !toRemove.has(p.iid));
      return { parts: dissolveSingletonGroups(remaining) };
    }),

  setPartsPositions: (updates) =>
    set((s) => {
      const byId = new Map(updates.map((u) => [u.iid, u]));
      return {
        parts: s.parts.map((p) => {
          const u = byId.get(p.iid);
          if (!u) return p;
          const next: [number, number, number] = [u.x, 0, u.z];
          return { ...p, position: next };
        }),
      };
    }),

  rotatePartTo: (iid, rotation) =>
    set((s) => ({
      parts: s.parts.map((p) => (p.iid === iid ? { ...p, rotation } : p)),
    })),

  rotateGroupYawBy: (resolved, deltaYawDeg) =>
    set((s) => {
      if (resolved.length === 0) return {};

      // Pivot = plain geometric average of member (x,z) — not mass-weighted —
      // predictable and easy to predict/explain for "spin this cluster in place".
      let cx = 0, cz = 0;
      for (const r of resolved) { cx += r.x; cz += r.z; }
      cx /= resolved.length;
      cz /= resolved.length;

      const rad = (deltaYawDeg * Math.PI) / 180;
      const cos = Math.cos(rad), sin = Math.sin(rad);
      const byId = new Map(resolved.map((r) => [r.iid, r]));

      return {
        parts: s.parts.map((p) => {
          const r = byId.get(p.iid);
          if (!r) return p;
          const dx = r.x - cx, dz = r.z - cz;
          const newX = cx + (dx * cos - dz * sin);
          const newZ = cz + (dx * sin + dz * cos);
          const [rx, ry, rz] = p.rotation ?? [0, 0, 0];
          const nextPos: [number, number, number] = [newX, 0, newZ];
          const nextRot: [number, number, number] = [rx, normalizeDeg(ry + deltaYawDeg), rz];
          return { ...p, position: nextPos, rotation: nextRot };
        }),
      };
    }),

  groupParts: (iids) =>
    set((s) => {
      if (iids.length < 2) return {};
      const groupId = newId('-g');
      const targets = new Set(iids);
      return { parts: s.parts.map((p) => (targets.has(p.iid) ? { ...p, groupId } : p)) };
    }),

  ungroupParts: (iids) =>
    set((s) => {
      const groupIds = new Set<string>();
      for (const iid of iids) {
        const p = s.parts.find((pp) => pp.iid === iid);
        if (p?.groupId) groupIds.add(p.groupId);
      }
      if (groupIds.size === 0) return {};
      return {
        parts: s.parts.map((p) =>
          p.groupId && groupIds.has(p.groupId) ? { ...p, groupId: undefined } : p
        ),
      };
    }),

  mirrorParts: (resolved) => {
    const byId = new Map(resolved.map((r) => [r.iid, r]));
    const members = get().parts.filter((p) => byId.has(p.iid));
    if (members.length === 0) return [];

    const groupId = members.length >= 2 ? newId('-g') : undefined;
    const mirrored: InstalledPart[] = members.map((p) => {
      const r = byId.get(p.iid)!;
      const [rx, ry, rz] = p.rotation ?? [0, 0, 0];
      // Mirroring across the world X=0 plane: negate X position. For
      // orientation, conjugating an XYZ-order rotation by that reflection
      // works out to "keep X (pitch), negate Y (yaw), negate Z (roll)" —
      // derived and cross-checked against THREE.js directly (see
      // verify_mirror_and_group_math.mjs), not guessed.
      const nextPos: [number, number, number] = [-r.x, 0, r.z];
      const nextRot: [number, number, number] = [rx, -ry, -rz];
      return { ...p, iid: newId(), position: nextPos, rotation: nextRot, groupId };
    });

    set((s) => ({ parts: [...s.parts, ...mirrored] }));
    return mirrored.map((p) => p.iid);
  },

  clearBuild: () => set({ parts: [] }),

  loadBuild: (parts) => set({ parts }),
}));
