export interface InstalledPart {
  iid: string;
  name: string;
  category: string;
  domain: string;
  specs?: {
    mass_kg?: number;
    cost_usd?: number;
  };
  modelUrl?: string;
  dimensions?: Record<string, number>;
  position?: [number, number, number];
  /**
   * Euler rotation in degrees, order XYZ (matches THREE.Euler's default order).
   * Undefined means [0, 0, 0] — every existing build without this field
   * (older shared links, older saved builds) renders exactly as before.
   */
  rotation?: [number, number, number];
  /**
   * Parts sharing the same groupId are "locked together": selecting or
   * dragging any one of them selects/drags the whole group. Undefined means
   * ungrouped. Groups of fewer than 2 members are auto-dissolved by the
   * store (see store.ts) so this field never meaningfully points at a
   * group of one.
   */
  groupId?: string;
}
