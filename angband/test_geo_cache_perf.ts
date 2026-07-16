// Exact copy of the shipped function (types stripped) — see the grep output
// used to produce this, not a reimplementation from memory.
function bucketUnchanged(prev, next) {
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

let failures = 0;
function check(label, cond) { console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`); if (!cond) failures++; }

const GEO_CYL = { type: 'cylinder', tag: 'cyl-geo' };
const GEO_BOX = { type: 'box', tag: 'box-geo' };

console.log('── bucketUnchanged: direct unit tests ──');
check('undefined prev -> always false (first render)', bucketUnchanged(undefined, []) === false);
check('empty vs empty -> true', bucketUnchanged([], []) === true);
check('different lengths -> false', bucketUnchanged([{ iid: 'a', position: [0,0,0], rotation: [0,0,0], geo: GEO_CYL }], []) === false);

{
  const a = { iid: 'x', position: [1,0,2], rotation: [0,90,0], groupId: undefined, geo: GEO_CYL };
  const bSameValues = { iid: 'x', position: [1,0,2], rotation: [0,90,0], groupId: undefined, geo: GEO_CYL }; // different object, same values
  check('same values, different object identity for the PlacedPart itself -> still true (value comparison)', bucketUnchanged([a], [bSameValues]) === true);
}
{
  const a = { iid: 'x', position: [1,0,2], rotation: [0,90,0], geo: GEO_CYL };
  const bMovedX = { iid: 'x', position: [1.001,0,2], rotation: [0,90,0], geo: GEO_CYL };
  check('tiny position delta -> false (correctly detects real movement)', bucketUnchanged([a], [bMovedX]) === false);
}
{
  const a = { iid: 'x', position: [1,0,2], rotation: [0,90,0], geo: GEO_CYL };
  const bRotated = { iid: 'x', position: [1,0,2], rotation: [0,91,0], geo: GEO_CYL };
  check('rotation delta -> false', bucketUnchanged([a], [bRotated]) === false);
}
{
  const a = { iid: 'x', position: [1,0,2], rotation: [0,0,0], groupId: undefined, geo: GEO_CYL };
  const bGrouped = { iid: 'x', position: [1,0,2], rotation: [0,0,0], groupId: 'g1', geo: GEO_CYL };
  check('groupId changed (locked into a group) -> false', bucketUnchanged([a], [bGrouped]) === false);
}
{
  // Same numeric values but a DIFFERENT geo object (simulating a cache miss
  // producing a non-interned duplicate, which should never actually happen
  // per geometryResolver's cache, but the check must still catch it if it did).
  const geoCopy = { type: 'cylinder', tag: 'cyl-geo' }; // structurally equal, NOT the same reference
  const a = { iid: 'x', position: [1,0,2], rotation: [0,0,0], geo: GEO_CYL };
  const bDifferentGeoRef = { iid: 'x', position: [1,0,2], rotation: [0,0,0], geo: geoCopy };
  check('different geo object reference (even if structurally similar) -> false', bucketUnchanged([a], [bDifferentGeoRef]) === false);
}
{
  const a = { iid: 'x', position: [1,0,2], rotation: [0,0,0], geo: GEO_CYL };
  const bDifferentIid = { iid: 'y', position: [1,0,2], rotation: [0,0,0], geo: GEO_CYL };
  check('different iid at the same index -> false (order/identity matters)', bucketUnchanged([a], [bDifferentIid]) === false);
}

// ── Full simulation: the memo's reuse loop across a realistic edit sequence ──
// Mirrors exactly what the Scene useMemo does: build freshBucketMap, then for
// each type reuse prevArr when bucketUnchanged, else use freshArr; carry
// forward empty-but-previously-seen types.
function simulateMemoPass(parts, prevBuckets, resolveGeo) {
  const freshBucketMap = new Map();
  for (const p of parts) {
    const geo = resolveGeo(p);
    const placed = { iid: p.iid, position: p.position, rotation: p.rotation, groupId: p.groupId, geo };
    let bucket = freshBucketMap.get(geo.type);
    if (!bucket) { bucket = []; freshBucketMap.set(geo.type, bucket); }
    bucket.push(placed);
  }
  const buckets = new Map();
  const seenTypes = new Set();
  for (const [type, freshArr] of freshBucketMap) {
    seenTypes.add(type);
    const prevArr = prevBuckets.get(type);
    buckets.set(type, bucketUnchanged(prevArr, freshArr) ? prevArr : freshArr);
  }
  for (const [type, prevArr] of prevBuckets) {
    if (!seenTypes.has(type)) buckets.set(type, prevArr.length === 0 ? prevArr : []);
  }
  return buckets;
}

const resolveGeo = (p) => (p.shapeHint === 'box' ? GEO_BOX : GEO_CYL);

console.log('\n── Full memo simulation: realistic edit sequence ──');
let prevBuckets = new Map();

// Render 1: two cylinders, one box.
let parts = [
  { iid: 'c1', position: [0,0,0], rotation: [0,0,0], shapeHint: 'cyl' },
  { iid: 'c2', position: [1,0,0], rotation: [0,0,0], shapeHint: 'cyl' },
  { iid: 'b1', position: [2,0,0], rotation: [0,0,0], shapeHint: 'box' },
];
let buckets1 = simulateMemoPass(parts, prevBuckets, resolveGeo);
check('render 1: cylinder bucket has 2, box bucket has 1', buckets1.get('cylinder').length === 2 && buckets1.get('box').length === 1);
prevBuckets = buckets1;

// Render 2: move ONLY c1. c2 and b1 are completely untouched.
parts = [
  { iid: 'c1', position: [5,0,5], rotation: [0,0,0], shapeHint: 'cyl' }, // moved
  { iid: 'c2', position: [1,0,0], rotation: [0,0,0], shapeHint: 'cyl' }, // unchanged
  { iid: 'b1', position: [2,0,0], rotation: [0,0,0], shapeHint: 'box' }, // unchanged
];
let buckets2 = simulateMemoPass(parts, prevBuckets, resolveGeo);
check('render 2: cylinder bucket got a NEW reference (c1 moved, same bucket as c2)', buckets2.get('cylinder') !== buckets1.get('cylinder'));
check('render 2: box bucket REUSED its old reference (b1 fully untouched, different bucket than the edit)', buckets2.get('box') === buckets1.get('box'));
prevBuckets = buckets2;

// Render 3: remove b1 entirely (the box bucket's only member).
parts = [
  { iid: 'c1', position: [5,0,5], rotation: [0,0,0], shapeHint: 'cyl' },
  { iid: 'c2', position: [1,0,0], rotation: [0,0,0], shapeHint: 'cyl' },
];
let buckets3 = simulateMemoPass(parts, prevBuckets, resolveGeo);
check('render 3: box bucket STILL PRESENT (not unmounted) after its last member is removed', buckets3.has('box'));
check('render 3: box bucket is now empty', buckets3.get('box').length === 0);
check('render 3: cylinder bucket REUSED (c1/c2 both fully untouched this render)', buckets3.get('cylinder') === buckets2.get('cylinder'));
prevBuckets = buckets3;

// Render 4: nothing changes at all — a pure re-render (e.g. triggered by
// selection/hover elsewhere) with an IDENTICAL parts array in a fresh array
// wrapper (simulating a new `parts` reference with the same content, which
// is what happens on an unrelated store update in the real app... actually
// in the real app it wouldn't be IDENTICAL content on an unrelated update,
// but this specifically tests that reuse works even with all-new part
// object wrappers as long as the VALUES match).
let buckets4 = simulateMemoPass(parts.map(p => ({ ...p })), prevBuckets, resolveGeo);
check('render 4: cylinder bucket reused even though every InstalledPart object is a new wrapper (value-based)', buckets4.get('cylinder') === buckets3.get('cylinder'));
check('render 4: empty box bucket reused too (still empty, no new array needed)', buckets4.get('box') === buckets3.get('box'));

// Render 5: re-add a box — the previously-emptied bucket must accept new members.
parts = [
  { iid: 'c1', position: [5,0,5], rotation: [0,0,0], shapeHint: 'cyl' },
  { iid: 'c2', position: [1,0,0], rotation: [0,0,0], shapeHint: 'cyl' },
  { iid: 'b2', position: [9,0,9], rotation: [0,0,0], shapeHint: 'box' },
];
let buckets5 = simulateMemoPass(parts, buckets4, resolveGeo);
check('render 5: box bucket repopulated correctly after being empty', buckets5.get('box').length === 1 && buckets5.get('box')[0].iid === 'b2');

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
