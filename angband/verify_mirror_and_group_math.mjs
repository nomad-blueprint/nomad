import { create } from 'zustand';

// ── Reimplementation matching the ACTUAL current store.ts structure ────────
function newId(suffix = '') {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}${suffix}`;
}
function normalizeDeg(deg) {
  let d = deg % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}
function dissolveSingletonGroups(parts) {
  const counts = new Map();
  for (const p of parts) if (p.groupId) counts.set(p.groupId, (counts.get(p.groupId) ?? 0) + 1);
  const orphaned = new Set();
  for (const [gid, n] of counts) if (n < 2) orphaned.add(gid);
  if (orphaned.size === 0) return parts;
  return parts.map((p) => (p.groupId && orphaned.has(p.groupId) ? { ...p, groupId: undefined } : p));
}

const useBuildStore = create((set, get) => ({
  parts: [],
  addPart: (part) => set((s) => ({ parts: [...s.parts, { ...part, iid: newId() }] })),
  removePart: (iid) => get().removeParts([iid]),
  removeParts: (iids) =>
    set((s) => {
      const toRemove = new Set(iids);
      return { parts: dissolveSingletonGroups(s.parts.filter((p) => !toRemove.has(p.iid))) };
    }),
  setPartsPositions: (updates) =>
    set((s) => {
      const byId = new Map(updates.map((u) => [u.iid, u]));
      return { parts: s.parts.map((p) => { const u = byId.get(p.iid); return u ? { ...p, position: [u.x, 0, u.z] } : p; }) };
    }),
  rotatePartTo: (iid, rotation) => set((s) => ({ parts: s.parts.map((p) => (p.iid === iid ? { ...p, rotation } : p)) })),
  rotateGroupYawBy: (resolved, deltaYawDeg) =>
    set((s) => {
      if (resolved.length === 0) return {};
      let cx = 0, cz = 0;
      for (const r of resolved) { cx += r.x; cz += r.z; }
      cx /= resolved.length; cz /= resolved.length;
      const rad = deltaYawDeg * Math.PI / 180, cos = Math.cos(rad), sin = Math.sin(rad);
      const byId = new Map(resolved.map((r) => [r.iid, r]));
      return { parts: s.parts.map((p) => {
        const r = byId.get(p.iid);
        if (!r) return p;
        const dx = r.x-cx, dz = r.z-cz;
        const [rx, ry, rz] = p.rotation ?? [0,0,0];
        return { ...p, position: [cx+(dx*cos-dz*sin), 0, cz+(dx*sin+dz*cos)], rotation: [rx, normalizeDeg(ry+deltaYawDeg), rz] };
      }) };
    }),
  groupParts: (iids) =>
    set((s) => {
      if (iids.length < 2) return {};
      const groupId = newId('-g'); const t = new Set(iids);
      return { parts: s.parts.map((p) => (t.has(p.iid) ? { ...p, groupId } : p)) };
    }),
  ungroupParts: (iids) =>
    set((s) => {
      const groupIds = new Set();
      for (const iid of iids) { const p = s.parts.find((pp) => pp.iid === iid); if (p?.groupId) groupIds.add(p.groupId); }
      if (groupIds.size === 0) return {};
      return { parts: s.parts.map((p) => (p.groupId && groupIds.has(p.groupId) ? { ...p, groupId: undefined } : p)) };
    }),
  mirrorParts: (resolved) => {
    const byId = new Map(resolved.map((r) => [r.iid, r]));
    const members = get().parts.filter((p) => byId.has(p.iid));
    if (members.length === 0) return [];
    const groupId = members.length >= 2 ? newId('-g') : undefined;
    const mirrored = members.map((p) => {
      const r = byId.get(p.iid); const [rx, ry, rz] = p.rotation ?? [0,0,0];
      return { ...p, iid: newId(), position: [-r.x, 0, r.z], rotation: [rx, -ry, -rz], groupId };
    });
    set((s) => ({ parts: [...s.parts, ...mirrored] }));
    return mirrored.map((p) => p.iid);
  },
  clearBuild: () => set({ parts: [] }),
  loadBuild: (parts) => set({ parts }),
}));

// Mirrors Viewport3D.tsx's resolvePositions exactly.
function resolvePositions(iids, parts, autoPos) {
  return iids.map((iid) => {
    const part = parts.find((p) => p.iid === iid);
    const pos = part?.position ?? autoPos.get(iid) ?? [0, 0, 0];
    return { iid, x: pos[0], z: pos[2] };
  });
}

let failures = 0;
function check(label, cond) { console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`); if (!cond) failures++; }

// ═══ THE BUG SCENARIO, end-to-end through the real store + resolvePositions ═══
// Add 2 parts (neither ever individually dragged — position stays undefined,
// exactly like real addPart()), simulate their autoPos spiral slots, group
// them immediately, then drag ONE of them. Both should shift by the drag
// delta while preserving their spiral-derived relative arrangement.
{
  useBuildStore.getState().clearBuild();
  useBuildStore.getState().addPart({ name: 'Bolt A', category: 'X', domain: 'Y' }); // no position!
  useBuildStore.getState().addPart({ name: 'Bolt B', category: 'X', domain: 'Y' }); // no position!
  const [a, b] = useBuildStore.getState().parts;
  check('freshly added parts have no stored position (rely on autoPos)', a.position === undefined && b.position === undefined);

  const autoPos = new Map([[a.iid, [10, 0, 10]], [b.iid, [13, 0, 10]]]); // simulated spiral slots

  useBuildStore.getState().groupParts([a.iid, b.iid]);

  // Drag A from its true autoPos location (10,10) to (12,10) — a +2 in X.
  const store1 = useBuildStore.getState();
  const grabbed = resolvePositions([a.iid], store1.parts, autoPos)[0];
  check('resolvePositions falls back to autoPos for an unpositioned part', grabbed.x === 10 && grabbed.z === 10);
  const deltaX = 12 - grabbed.x, deltaZ = 10 - grabbed.z;
  const targets = [a.iid, b.iid]; // expandToGroup would return this
  const resolved = resolvePositions(targets, store1.parts, autoPos);
  store1.setPartsPositions(resolved.map((r) => ({ iid: r.iid, x: r.x + deltaX, z: r.z + deltaZ })));

  const after = useBuildStore.getState().parts;
  const aAfter = after.find((p) => p.iid === a.iid), bAfter = after.find((p) => p.iid === b.iid);
  check('dragged member A lands exactly where dropped', aAfter.position[0] === 12 && aAfter.position[2] === 10);
  check('never-dragged member B shifts from its TRUE autoPos location, not from the origin',
    bAfter.position[0] === 15 && bAfter.position[2] === 10);
  check('B did NOT incorrectly jump toward (2,0) (the old bug: delta applied to a [0,0,0] fallback)',
    bAfter.position[0] !== 2);
}

// Same bug class, for rotateGroupYawBy: group two never-dragged parts, pivot
// the group — the pivot centroid must be computed from their TRUE autoPos
// positions, not (0,0).
{
  useBuildStore.getState().clearBuild();
  useBuildStore.getState().addPart({ name: 'Left', category: 'X', domain: 'Y' });
  useBuildStore.getState().addPart({ name: 'Right', category: 'X', domain: 'Y' });
  const [l, r] = useBuildStore.getState().parts;
  const autoPos = new Map([[l.iid, [-1, 0, 0]], [r.iid, [1, 0, 0]]]); // symmetric about x=0, NOT about the origin's default fallback
  useBuildStore.getState().groupParts([l.iid, r.iid]);

  const store2 = useBuildStore.getState();
  const resolved = resolvePositions([l.iid, r.iid], store2.parts, autoPos);
  store2.rotateGroupYawBy(resolved, 90);

  const after = useBuildStore.getState().parts;
  const lAfter = after.find((p) => p.iid === l.iid), rAfter = after.find((p) => p.iid === r.iid);
  // Centroid of (-1,0) and (1,0) is (0,0); rotating 90° should swap them onto the Z axis.
  check('rotateGroupYawBy pivots around the TRUE autoPos centroid (L -> +Z)', Math.abs(lAfter.position[0]) < 1e-9 && Math.abs(lAfter.position[2] - (-1)) < 1e-9);
  check('rotateGroupYawBy pivots around the TRUE autoPos centroid (R -> -Z)', Math.abs(rAfter.position[0]) < 1e-9 && Math.abs(rAfter.position[2] - 1) < 1e-9);
}

// Same bug class, for mirrorParts: mirror a never-dragged part — must reflect
// its TRUE autoPos x, not 0.
{
  useBuildStore.getState().clearBuild();
  useBuildStore.getState().addPart({ name: 'Wheel', category: 'X', domain: 'Y' });
  const [w] = useBuildStore.getState().parts;
  const autoPos = new Map([[w.iid, [5, 0, 2]]]);
  const store3 = useBuildStore.getState();
  const resolved = resolvePositions([w.iid], store3.parts, autoPos);
  const newIids = store3.mirrorParts(resolved);
  const mirrored = useBuildStore.getState().parts.find((p) => p.iid === newIids[0]);
  check('mirrorParts reflects the TRUE autoPos x (5 -> -5), not 0 -> 0', mirrored.position[0] === -5 && mirrored.position[2] === 2);
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
