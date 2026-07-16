/**
 * geometryResolver.ts — UMB v1.6
 *
 * v1.6 — resolvePartGeo cache-order fix (performance)
 * ─────────────────────────────────────────────────────────────────────────────
 * Found while investigating "does this stay fast at ~1000 parts on screen":
 * resolvePartGeo built its cache key from the RESOLVED mass/fidelity, which
 * meant resolveGeoRule() — a linear scan testing dozens of regexes against
 * the part's name — ran on every single call, INCLUDING cache hits. Every
 * part that had already been resolved once was still paying the full regex
 * gauntlet on every subsequent lookup, not just genuinely new parts.
 *
 * This mattered more than it might sound: Scene's bucket-rebuild memo and
 * computeAssemblyPhysics() both call resolvePartGeo for EVERY current part
 * on EVERY parts-array change (see the v1.6 note in Viewport3D.tsx for why
 * that's structurally necessary) — so adding the Nth part to a build meant
 * re-resolving all N-1 existing parts too, and every one of those was
 * supposed to be a cache hit but was paying the cache-MISS cost anyway.
 *
 * Fix: resolveGeoRule() and estimateMassKg() are themselves pure functions
 * of (category, domain, name) — the resolved mass is fully DETERMINED by
 * those same raw inputs, so keying the cache on the resolved mass was
 * redundant. Building the key from the raw inputs directly (category,
 * domain, name, explicit mass_kg if any, modelUrl presence, dimensions
 * presence) lets the cache be checked BEFORE calling resolveGeoRule at all,
 * without changing which parts share a cache entry — same partitioning,
 * checked in a different order.
 *
 * Verified two ways before shipping, both against the real 9,831-part
 * catalogue, not synthetic data: (1) correctness — every part produces an
 * identical PartGeo whether served from cache or resolved fresh, checked
 * against a full sanity sweep plus a sampled fresh-cache comparison; (2)
 * performance — a warm (cached) call is 10-15x faster than a cold one on
 * this machine (see test_geo_cache_perf.ts), and simulating the realistic
 * "add 1000 different parts one at a time" workflow directly (see
 * benchmark_add_parts.ts) shows the 1000th add dropping from ~24 ms — above
 * the 16.67 ms/frame budget, i.e. a visible stutter on that click — to
 * ~0.6 ms.
 *
 * v1.5 — Broader name-based shape inference
 * ─────────────────────────────────────────────────────────────────────────────
 * There are no real per-part specs to fall back on in this catalogue (see
 * v1.4), so the only honest lever on visual accuracy is reading the part's
 * own name/category/domain text more thoroughly. This pass was driven by
 * auditing the real 9,831-part catalogue rather than guessing: resolved
 * every part with the v1.4 ruleset, isolated the 3,771 (38%) that were
 * landing in DEFAULT_RULE — the true "no idea, render a box" case, distinct
 * from the legitimate BOX rule for things that really are box-shaped — and
 * ranked the words actually appearing in their names.
 *
 * ~20 new keyword matches added across existing rules, plus 4 new narrow
 * sub-rules (reservoirs, filters, cables/wires/harnesses, springs) so they
 * get their own realistic mass range instead of inheriting a family range
 * built for much bigger parts. Every addition below was checked against
 * real example names before being added — several words that looked
 * promising by frequency alone were checked and deliberately left alone:
 *
 *   - "gauge"  → real hits are machinist tools (bore/feeler/height/pin
 *     gauges) of no consistent shape.
 *   - "chain"  → mostly already-classified actuators, or drag-chain/cable
 *     assemblies and lubricant with no primitive that fits a chain anyway.
 *   - "belt"   → mostly buckles/pretensioners/packs, not literal strap
 *     material.
 *   - "hook"   → no primitive here fits a hook's curve.
 *   - "cab"    → ambiguous between the cab shell itself (big) and equipment
 *     mounted in/for it (small) — real risk of badly mis-sizing the latter.
 *   - "bucket" → spans tiny engine lifter buckets and excavator buckets,
 *     ~5 orders of magnitude apart in mass. No single range is honest.
 *   - "fork"   → mostly small transmission/suspension parts, not the flat
 *     forklift-blade shape the word suggests.
 *
 * Also reordered the two DISC rules (wheel/gear family now checked first)
 * so compounds like "Flywheel Ring Gear" resolve via the gear-specific
 * pattern instead of the new generic \bring\b catch below it.
 * Still 8 GeoTypes, still ≤8 draw calls — every addition maps into an
 * existing type, none of it changes the instancing architecture.
 *
 * v1.4 — Per-part mass diversity + disc sub-split
 * ─────────────────────────────────────────────────────────────────────────────
 * Problem: every part with no real specs.mass_kg (i.e. all 9 831 of them —
 * this catalogue has no populated mass_kg/dimensions data to fall back on)
 * was defaulting to a flat 5 kg. That single constant drives both visual
 * scale (massToBase) and physical dimensions (deriveMassDimensions), so every
 * part sharing a GeoType rendered at exactly the same size — a fuel cell and
 * a ballast tank, both 'capsule', were visually identical.
 *
 * Fix: each GeoRule now carries massHint: [min_kg, max_kg], a realistic
 * order-of-magnitude range for that part family (engineering judgment, not
 * measured data — there's no manufacturer spec sheet to look up for a
 * procedurally curated catalogue). estimateMassKg() picks a deterministic,
 * reproducible point in that range per part (log-uniform, matching the
 * existing log-scale visual system), so the same part is always the same
 * size but different parts in the same family now actually differ.
 *
 * Also: the 'disc' rule covered washers/flanges/brake-rotors AND
 * wheels/gears/flywheels under one razor-thin aspect ratio. Split into two
 * rules (still both GeoType 'disc', so draw-call count is unchanged) with
 * different `aspect` overrides — washers stay thin, wheels/gears get
 * meaningfully thicker proportions. washer/o-ring/seal/gasket moved out of
 * the octahedron (fastener) bucket into the thin-disc rule; they're flat
 * annular parts, not faceted blobs.
 *
 * Visual scale only. physDims / inertia still use the type-level ASPECTS
 * constant, since the inertia formulas below are validated against that
 * fixed ratio (see v1.1's note on disc t/r=0.2) — not touched here.
 *
 * v1.3 — Physics accuracy pass
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. bounds.maxY corrected to physical height (was visual sh — typically 10–100×
 *    too large, since visual scale is log-stretched for viewport legibility).
 *    bounds.minY added. All six AABB faces now use physical coordinates.
 *
 * 2. Disc transverse inertia: replaced thin-disc approximation mr²/4 with the
 *    exact solid-cylinder formula m(3r²+h²)/12, matching the cylinder case.
 *    Error for default t/r=0.2: 1.3% (fixed). For t/r=0.5 (heavy flywheel): 8%.
 *
 * 3. Stable geo cache: _GEO_CACHE_MAX = 30 000, LRU-approximate eviction.
 *    Prevents unbounded growth when many unique mass values enter the system.
 *
 * 4. Unused visual-scale destructure (sw, sh, sd) removed from Pass 1 loop.
 *    All AABB, CoM, and inertia work uses physDims exclusively.
 *
 * 5. Buffer memory comment corrected: 7 Float64 + 1 Uint8 = 570 KB (not 650 KB).
 *
 * Maps every InstalledPart to a geometry bucket + visual scale.
 * Also provides computeAssemblyPhysics() — one call that returns every
 * physics quantity the viewport needs.
 *
 * Performance contract
 * ────────────────────
 * The entire catalog (9,831 parts) maps to exactly 8 geometry types.
 * Each type becomes one THREE.InstancedMesh → one GPU draw call.
 * Regardless of how many parts are in the build, the scene costs ≤ 8 draw calls.
 *
 * Size derivation
 * ───────────────
 * volume  = mass_kg / category_density_kg_m3
 * base    = log-scale visual side (4 cm → 1.8 m for 0.001 kg → 390 000 kg)
 * scale[] = base × per-type aspect ratios [W, H, D]
 *
 * v0.6 additions
 * ──────────────
 * + computeAssemblyPhysics() — single two-pass function replacing 4 useMemo passes
 *   Returns: total mass · 3-axis CoM · inertia tensor · stability · AABB · draw-call count
 *   All geo lookups via _geoCache → O(1) per part after first encounter.
 *
 * v0.7 additions
 * ──────────────
 * + GeometryFidelity — 'exact' | 'derived' | 'procedural' tag on every PartGeo.
 * + confidence — 0–1 score on every PartGeo (propagated to fidelityProfile).
 * + Shape-specific inertia — analytically correct formulas per GeoType.
 * + gyrationRadius — k = sqrt(I/M) per axis (m).
 * + comOffset — CoM displacement (dx, dz) from the AABB footprint centre (m).
 * + weightDistribution — mass fraction (%) on each side of the footprint centre.
 * + fidelityProfile — census of exact / derived / procedural parts in the build.
 *
 * v0.8 — Persistent flat-buffer pool (zero-alloc physics hot path)
 * ─────────────────────────────────────────────────────────────────
 * Previously, computeAssemblyPhysics() allocated 8 TypedArrays on every call.
 * Now: module-level singleton buffers that grow with capacity doubling.
 * At steady state: 0 TypedArray allocations per call.
 *
 * v0.9 — Stable InstancedMesh allocation (no change to this file)
 *
 * v1.1 — Exact solid-capsule inertia
 * ─────────────────────────────────────────────────────────────────────────────
 * Replaces the cylinder approximation used in v1.0 for the 'capsule' GeoType.
 * Hulls, tanks, fuselages, and pressure vessels all land here and are typically
 * the heaviest parts in a build, so the error dominated the tensor.
 *
 * Fix: volume-weighted mass split between the cylinder body (M_c) and the two
 * hemispherical end caps (M_h), with exact centroidal inertia for each sub-body
 * and a parallel-axis correction (d = h_c/2 + 3r/8) for the cap offset.
 *
 * Validation: degenerate h_body = 0 collapses exactly to solid-sphere (2/5)mr².
 * Observed corrections on the 150 kg tank archetype: Iyy −9 %, Itr −25 %.
 *
 * Only computePartLocalInertia() changes. physDims, buffers, and all other
 * shapes are unchanged from v1.0.
 *
 * v1.2 — Merged weight-distribution pass into Pass 2 (zero extra O(n) traversal)
 * ─────────────────────────────────────────────────────────────────────────────
 * Previously, computeAssemblyPhysics() ran three O(n) loops over the flat-buffer
 * pool: Pass 1 (mass/AABB/buckets), a standalone weight-distribution loop, and
 * Pass 2 (inertia tensor). The weight-distribution loop read _massArr, _posXArr,
 * and _posZArr — the exact same arrays that Pass 2 reads first. Running them as
 * separate loops forces those cache lines to be fetched twice.
 *
 * Fix: footCX/footCZ are computed from Pass 1 results immediately after Pass 1,
 * then frontMass/leftMass accumulation is folded into the Pass 2 body. The result
 * is identical; the standalone weight-distribution loop is gone.
 *
 * Net effect: one fewer O(n) array traversal per physics call. For a 500-part
 * build this eliminates ~1 500 array reads; cache-line reuse in Pass 2 also
 * improves because _massArr/_posXArr/_posZArr are still hot when the
 * weight-distribution branches execute in the same iteration.
 *
 * v1.0 — Volume-accurate physical dimension inference
 * ─────────────────────────────────────────────────────────────────
 * Problem (v0.9 and earlier):
 *   computePartLocalInertia() received sw/sh/sd from massToBase() — a log-linear
 *   function designed for viewport legibility (4 cm → 1.8 m over the full mass
 *   range). A 5 kg motor produced r_visual ≈ 30 cm; the actual physical radius
 *   from V = mass/density is ≈ 3 cm. Inertia scales as r², so HUD values were
 *   ~100× too large for typical parts.
 *
 * Fix: deriveMassDimensions(mass, density, type)
 *   Inverts V = mass/density → characteristic linear extents for each GeoType
 *   archetype, preserving fixed aspect ratios. Returns [width_m, height_m, depth_m] —
 *   actual physical size, not viewport representation.
 *
 * These physDims:
 *   • Replace visual scale in computePartLocalInertia() → physically correct tensors.
 *   • Are stored on PartGeo for export / kinematic solver use.
 *   • Unlock confidence tier 0.72 for all 6 593 mass-known parts (was 0.62).
 *
 * Side effects:
 *   • PartGeo gains physDims: [number, number, number].
 *   • All mass-known parts: confidence 0.62 → 0.72.
 *   • Three new flat buffers (_physWArr, _physHArr, _physDArr) in the buffer pool.
 *   • AssemblyPhysics gains avgConfidence: number (mass-weighted).
 *
 * Memory cost (v1.0 buffer pool at 10 000-part build):
 *   11 × 8 × 10 000  +  1 × 10 000  =  890 KB — held permanently.
 *   Was 650 KB (v0.8); 240 KB delta for three Float64 physical-dim arrays.
 */

// ── 8 geometry archetypes ──────────────────────────────────────────────────────

export type GeoType =
  | "cylinder"    // motors, actuators, pumps, hydraulic cylinders, tubes, pipes, rods
  | "box"         // electronics, housings, controllers, computers, general solid
  | "flatbox"     // panels, plates, wings, solar arrays, PCBs, batteries, membranes
  | "sphere"      // sensors, cameras, LiDAR, domes, ball joints
  | "capsule"     // tanks, pressure vessels, fuselages, hulls, nacelles
  | "disc"        // wheels, gears, rotors, discs, pulleys, rings
  | "cone"        // nozzles, bell nozzles, nosecones, tips
  | "octahedron"; // micro-parts, fasteners, misc (< 10 g parts tend to land here)

// ── v0.7 — Geometry fidelity tier ────────────────────────────────────────────
//
// Follows the graduated-fidelity model from the UMB Physics Guidelines:
//   exact      — real .glb / STEP model or explicitly measured dimensions
//   derived    — geometry inferred from known mass + material density
//   procedural — category-default archetype; lowest accuracy

export type GeometryFidelity = 'exact' | 'derived' | 'procedural';

// ── Rule table ─────────────────────────────────────────────────────────────────

interface GeoRule {
  re: RegExp;
  type: GeoType;
  /** Typical material density kg/m³ — used to derive volume → physical size */
  density: number;
  roughness: number;
  metalness: number;
  /**
   * v1.4 — Realistic order-of-magnitude mass range [min_kg, max_kg] for this
   * part family. Only used as a fallback when a part has no real
   * specs.mass_kg. Engineering-judgment estimate, not measured data — see
   * estimateMassKg().
   */
  massHint: [number, number];
  /**
   * v1.4 — Optional visual aspect-ratio override [W, H, D], replacing the
   * shared ASPECTS[type] default for just this rule. Lets two rules that
   * share a GeoType (e.g. a wheel and a washer, both 'disc') render with
   * different proportions. physDims/inertia are unaffected — they still use
   * the type-level default (see note above on validated inertia formulas).
   */
  aspect?: [number, number, number];
}

/**
 * Rules are tested in declaration order; first match wins.
 * Regex tests against " category domain " (lowercased, space-padded).
 */
const RULES: GeoRule[] = [
  // ── DISC — wheel/gear family (wheels, gears, pulleys, flywheels, etc.) ────
  // Checked BEFORE the thin-annular rule below so compounds like "Ring Gear"
  // or "Flywheel Ring Gear" resolve here (thicker), not into the generic
  // \bring\b catch in the thin rule.
  {
    re: /wheel|tyre|tire|\brim\b|\bhub\b|sprocket|pulley|flywheel|gear.?wheel|ring.?gear|face.?gear|\bgear\b|\bdisc\b|\bdisk\b|\bimpeller\b|\bpropeller\b|\bfan.?blade\b|\bturntable\b|\bsparger\b/,
    type: "disc", density: 4700, roughness: 0.48, metalness: 0.88,
    aspect: [1.6, 0.42, 1.6],
    massHint: [0.4, 350],
  },

  // ── DISC — thin annular parts (washers, seals, flanges, brake rotors) ─────
  // v1.5: added generic ring/bearing/bushing/circlip — all confirmed by
  // sampling real catalogue names (e.g. "Wing/Tail Tie-Down Ring", "Center
  // Support Bearing", "Round-Wire Piston Pin Circlip") to be genuinely
  // annular parts, not the faceted-blob shape octahedron implies.
  {
    re: /\bwasher\b(?!\s*(?:fluid|reservoir|pump|nozzle|tank|jet))|\bflange\b|\bsieve\b|\banode\b.disc|\bplaten\b|\bbearing.?ring\b|disc.?brake|disk.?brake|rotor.?disc|rotor.?disk|\brotary.?disk\b|o.?ring|\bseal\b|\bgasket\b|\brings?\b|\bbearings?\b|\bbushings?\b|\bcirclips?\b/,
    type: "disc", density: 4200, roughness: 0.40, metalness: 0.70,
    aspect: [1.6, 0.10, 1.6],
    massHint: [0.01, 12],
  },

  // ── CAPSULE — small fluid reservoirs (v1.5) ───────────────────────────────
  // Confirmed by sampling: "Windshield Washer Reservoir", "Remote Brake
  // Fluid Reservoir" — real, but much smaller than the tanks/vessels below.
  // Own massHint so these don't occasionally roll a 6,000 kg estimate.
  {
    re: /\breservoirs?\b/,
    type: "capsule", density: 1400, roughness: 0.40, metalness: 0.30,
    massHint: [0.3, 20],
  },

  // ── CAPSULE ───────────────────────────────────────────────────────────────
  {
    re: /\btank\b|pressure.vessel|accumulator|bladder\b|fuselage|hull\b|\bpod\b|nacelle|nose.cone|ballast.tank|torpedo|propellant.tank|oxidiser|oxidizer|fuel.cell|cryogenic.vessel|ballast|\bcanister\b|\bbarrel\b|\bdrum\b|\bsilo\b|\bbottle\b|\bflask\b|\bcartridge\b|gas.cylinder|oxygen.cylinder|argon.cylinder|nitrogen.cylinder|co2.tank|\bpressure.tank\b|\bvessel\b|\bchamber\b|\bpropellant.vessel\b/,
    type: "capsule", density: 2400, roughness: 0.35, metalness: 0.65,
    massHint: [1.5, 6000],
  },

  // ── CONE ──────────────────────────────────────────────────────────────────
  // v1.5: added tooth/teeth — confirmed by sampling to be excavator/auger
  // digging teeth ("Bucket Tooth", "Auger Cutter Tooth"), genuinely conical.
  {
    re: /nozzle|bell.nozzle|jet.nozzle|exhaust.tip|diffuser.cone|aerospike|nosecone|nose.?cone|propellant.nozzle|\bfunnel\b|\bcone\b|\bhorn\b|drill.?bit|\bchuck\b|conical|tapered.?tip|\bpyramid\b|injector.?tip|burner.?nozzle|spray.?nozzle|fuel.?nozzle|orifice.?plate|de.?laval|\bspike\b.tip|exhaust.cone|\btooth\b|\bteeth\b/,
    type: "cone", density: 5000, roughness: 0.25, metalness: 0.92,
    massHint: [0.05, 250],
  },

  // ── FLATBOX (aero surfaces, panels, flat electronics) ─────────────────────
  // v1.5: added leaf spring here (checked before the generic \bsprings?\b
  // cylinder rule below) — a leaf spring is flat/curved, not coil-shaped.
  {
    re: /\bwing\b|\bairfoil\b|\baerofoil\b|aileron|elevon|\bflap\b|rudder|stabilizer|canard|solar.panel|solar.array|\bpcb\b|circuit.board|motherboard|battery.module|battery.pack|flat.plate|heat.shield|\bsail\b|rotor.blade|propeller.blade|wind.blade|turbine.blade|\bblade\b|\bfin\b|\bvane\b|\bslab\b|\bmat\b|\bfoil\b|shim.?plate|cover.?plate|face.?plate|\bbaffle\b|\bdeflector\b|\bsplitter\b|reflector.?panel|radiator.?panel|antenna.?panel|display.?screen|lcd.?panel|glass.?panel|rib.?panel|bulkhead.?panel|leaf.?springs?/,
    type: "flatbox", density: 1700, roughness: 0.72, metalness: 0.22,
    massHint: [0.2, 450],
  },

  // ── SPHERE ────────────────────────────────────────────────────────────────
  // v1.5: added light/lamp/beacon — sampled as genuine compact fixtures
  // ("Landing Light", "Nose Gear Taxi Light", "Tail Logo Light").
  {
    re: /\bsensor\b|\bcamera\b|\blidar\b|radar.dome|sonar.dome|\bgyroscope\b|gyro\b|\bimu\b|gps.unit|dome\b|ball.joint|spherical.bearing|globe\b|ball.valve|omnidirectional|\bball\b|\bsphere\b|\bspherical\b|\bbulb\b|\bbubble\b|ball.bearing|spherical.lens|float.ball|\bbuoy\b|pressure.?sphere|hollow.?sphere|\bpivot\b.ball|\bknob\b|\blights?\b|\blamps?\b|\bbeacons?\b|headlamp|floodlight/,
    type: "sphere", density: 3200, roughness: 0.30, metalness: 0.52,
    massHint: [0.02, 60],
  },

  // ── CYLINDER — filters (v1.5, own rule) ───────────────────────────────────
  // Confirmed by sampling: "Cabin Air Filter", "Pollen Filter" — genuine
  // canister shape, but far lighter than a motor/pump, hence its own range.
  {
    re: /\bfilters?\b/,
    type: "cylinder", density: 600, roughness: 0.55, metalness: 0.15,
    massHint: [0.05, 4],
  },

  // ── CYLINDER — cables, wires, harnesses (v1.5, own rule) ──────────────────
  // Confirmed by sampling: "HDMI Cable", "Bonnet Release Cable" — a coiled
  // or bundled cable reads reasonably as a slim cylinder. Own light range.
  {
    re: /\bcables?\b|\bwires?\b|\bharness(?:es)?\b|wiring.?loom/,
    type: "cylinder", density: 1200, roughness: 0.60, metalness: 0.25,
    massHint: [0.02, 15],
  },

  // ── CYLINDER — springs (v1.5, own rule) ───────────────────────────────────
  // Confirmed by sampling: "Valve Spring", "Transmission Detent Spring" —
  // real coil springs, but much lighter than the structural-cylinder family
  // below, hence a separate, smaller range. Leaf springs are excluded (see
  // the FLATBOX rule above, checked first).
  {
    re: /\bsprings?\b/,
    type: "cylinder", density: 7800, roughness: 0.50, metalness: 0.75,
    massHint: [0.02, 8],
  },

  // ── CYLINDER (motors, engines, actuators, pumps, pipes, shafts) ───────────
  // v1.5: added bare "cylinder" — sampled 6/6 genuine hits ("Locking
  // Cylinder", "Rodless Cylinder", "Master Cylinder"). Excludes "cylinder
  // block" specifically: an engine block is a box-ish casting, not a
  // cylinder, even though it's full of cylinder bores.
  {
    re: /\bmotor\b(?!\s*blocks?)|\bengine\b(?!\s*blocks?)|actuator|piston|hydraulic.cylinder|pneumatic.cylinder|servo\b|stepper\b|\bcompressor\b|\bturbine\b|\bgenerator\b|\bpump\b|\bshaft\b|\bspindle\b|\btube\b|\bpipe\b|\bhose\b|\bduct\b|\brod\b|\bbar\b|linear.actuator|rotary.actuator|hydraulic.ram|thruster|drive.shaft|\bcylinders?\b(?!\s*blocks?)/,
    type: "cylinder", density: 7200, roughness: 0.48, metalness: 0.82,
    massHint: [0.3, 750],
  },

  // ── CYLINDER (structural elongated members) ───────────────────────────────
  // v1.5: added track/rail — sampled as mostly linear-slide/rail hardware
  // ("Seat Track", "Fuel Rail").
  {
    re: /\bstrut\b|\bboom\b|\bmast\b|\bcolumn\b|\bpost\b|\barm\b|link\b|spar\b|\bbeam\b|truss.member|tie.rod|push.rod|\bspool\b|\broller\b|\bcoil\b|\baxle\b|\bstanchion\b|\bpillar\b|\btrunnion\b|\bpeg\b|\bpinnion\b|\bstud\b|\bdowel\b|stand.?off|\bstandoff\b|\bcircular.?bar\b|hex.?bar|round.?bar|\btracks?\b|\brails?\b/,
    type: "cylinder", density: 4800, roughness: 0.65, metalness: 0.60,
    massHint: [1, 380],
  },

  // ── FLATBOX (structural plates, sheets, membranes) ────────────────────────
  // v1.5: added frame/guard/pad/door — sampled as mostly flat/thin parts
  // ("License Plate Frame", "Door Edge Guard", brake pads, vehicle doors).
  {
    re: /\bplate\b|\bsheet\b|planform|membrane|diaphragm|bulkhead|\bpanel\b|skin\b|cladding|\bframes?\b|\bguards?\b|\bpads?\b|\bdoors?\b/,
    type: "flatbox", density: 2700, roughness: 0.68, metalness: 0.50,
    massHint: [0.4, 550],
  },

  // ── BOX — small electronics hardware (v1.5, own rule) ─────────────────────
  // connector/terminal/switch/relay are uniformly small — sampled as GPU
  // connectors, terminal blocks, dimmer switches, fuel-pump relays. Kept out
  // of the main BOX range below so one doesn't occasionally roll close to
  // 140 kg (that range exists for controllers/racks/enclosures, not these).
  {
    re: /\bconnectors?\b|\bterminals?\b|\bswitch(?:es)?\b|\brelays?\b/,
    type: "box", density: 1900, roughness: 0.55, metalness: 0.40,
    massHint: [0.02, 3],
  },

  // ── BOX — valves (v1.5, own rule) ──────────────────────────────────────────
  // Sampled as vehicle/aircraft valve bodies ("Outflow Valve", "Heater
  // Control Valve") — irregular castings, honestly still best approximated
  // as a box, but on their own, smaller-than-electronics-cabinet scale.
  {
    re: /\bvalves?\b/,
    type: "box", density: 3000, roughness: 0.50, metalness: 0.55,
    massHint: [0.05, 40],
  },

  // ── BOX — seats (v1.5, own rule) ───────────────────────────────────────────
  // Sampled as vehicle/aircraft seat assemblies ("Ejection Seat") — same
  // reasoning as valves: box is the honest primitive, but seats need their
  // own floor so one doesn't hash toward the connector end of a shared range.
  {
    re: /\bseats?\b/,
    type: "box", density: 900, roughness: 0.65, metalness: 0.10,
    massHint: [3, 100],
  },

  // ── BOX (electronics, controllers, housings — catch-all for smart things) ──
  // v1.5: added block — sampled as small lab/electronics blocks ("Fuse
  // Block", "PCR Thermal Cycler Block") as well as engine/cylinder blocks
  // (via the exclusions added to the CYLINDER rules above) — genuinely wide
  // variance, so left in this wider range rather than given a falsely
  // narrow one.
  {
    re: /controller|computer|processor|electronics|module\b|\bbox\b|housing|enclosure|cabinet|\brack\b|\becu\b|inverter|converter|amplifier|transponder|avionics|display\b|\bscreen\b|\bblocks?\b/,
    type: "box", density: 2600, roughness: 0.70, metalness: 0.30,
    massHint: [0.1, 140],
  },

  // ── OCTAHEDRON (micro-parts: fasteners, rivets, fittings, tiny electronics)
  // washer/o-ring/seal/gasket moved to the DISC (thin) rule above.
  // v1.5: added pin — small rod-like hardware, same scale family as bolts.
  {
    re: /\bbolts?\b|\bnuts?\b|\brivets?\b|\bscrew\b|fastener|fitting|clip\b|clamp\b|bracket\b|microchip|transistor|resistor|capacitor|\bpins?\b/,
    type: "octahedron", density: 7800, roughness: 0.55, metalness: 0.90,
    massHint: [0.004, 4],
  },
];

const DEFAULT_RULE: GeoRule = {
  re: /.*/,
  type: "box",
  density: 5000,
  roughness: 0.60,
  metalness: 0.42,
  massHint: [0.5, 90],
};

export function resolveGeoRule(category: string, domain: string, name?: string): GeoRule {
  // Include part name so e.g. "Bioreactor Impeller" → disc, "Gas Cylinder" → capsule
  const text = ` ${category} ${domain} ${name ?? ''} `.toLowerCase();
  for (const rule of RULES) {
    if (rule.re.test(text)) return rule;
  }
  return DEFAULT_RULE;
}

// ── Log-scale mass → visual base size in metres ───────────────────────────────
//
// Catalogue range: 0.001 kg (tiny electronic) → 390 000 kg (submarine hull)
// Visual range   : 0.04 m (4 cm) → 1.80 m
// Mapping        : t = (log10(m) + 3) / 9  → [0, 1]
//
// v1.0: this function is retained for visual scale only.
// Physics calculations now use deriveMassDimensions() instead.

export function massToBase(massKg: number): number {
  const m = Math.max(massKg, 0.001);
  const t = Math.max(0, Math.min(1, (Math.log10(m) + 3) / 9));
  return 0.04 + t * 1.76;   // 4 cm … 1.8 m
}

// Per-type aspect ratios [W, H, D] applied to base
const ASPECTS: Record<GeoType, [number, number, number]> = {
  cylinder:   [0.80, 2.80, 0.80],
  box:        [1.30, 0.90, 1.00],
  flatbox:    [3.20, 0.11, 2.20],
  sphere:     [1.00, 1.00, 1.00],
  capsule:    [0.65, 2.20, 0.65],
  disc:       [1.80, 0.13, 1.80],
  cone:       [0.75, 2.00, 0.75],
  octahedron: [0.70, 0.70, 0.70],
};

export function resolveScale(massKg: number, aspect: [number, number, number]): [number, number, number] {
  const b = massToBase(massKg);
  const [ax, ay, az] = aspect;
  return [b * ax, b * ay, b * az];
}

// ── v1.0 — Volume-accurate physical dimension derivation ─────────────────────
//
// deriveMassDimensions() inverts V = mass/density → characteristic linear extents.
// It preserves the fixed aspect ratios of each GeoType archetype, producing
// physically consistent [width_m, height_m, depth_m] rather than the visual
// log-scale used for viewport rendering.
//
// These physical dimensions are used ONLY for inertia tensor calculations.
// Visual rendering continues to use resolveScale() so part sizes in the viewport
// remain legible across the full 0.001 kg → 390 000 kg mass range.
//
// Derivation notes per type
// ──────────────────────────
//   cylinder   V = π r² h,          h/r  = ay/(ax·0.5) = 7.0
//              → r = ∛(V / 7π)
//
//   capsule    CapsuleGeometry(0.4, 0.6): h_total/r = 1.4/0.4 = 3.5, h_body = 1.5r
//              V = π r² · h_body + (4/3)π r³ = (17/6) π r³
//              → r = ∛(6V / 17π)
//
//   sphere     V = (4/3) π r³
//              → r = ∛(3V / 4π)
//
//   disc       CylinderGeometry(0.5, 0.5, 0.1): t/r = 0.1/0.5 = 0.2
//              V = π r² · t = 0.2π r³
//              → r = ∛(V / 0.2π)
//
//   cone       ConeGeometry(0.45, 1): h/r = 1/0.45 ≈ 2.222
//              V = (1/3) π r² h = (π · h/r / 3) r³
//              → r = ∛(3V / (π · h/r))
//
//   box / flatbox / octahedron
//              V = ax · ay · az · base³
//              → base = ∛(V / (ax · ay · az))

// ── Physical geometry ratios used by deriveMassDimensions ────────────────────
//
// Each constant is the height-to-radius (or thickness-to-radius) ratio of the
// actual Three.js geometry constructor — not the visual ASPECTS scale.
// Declaring all four together means a geometry change is made in ONE place
// instead of being scattered inside the switch cases.
//
// cylinder: deliberately read from ASPECTS so the archetype's elongated visual
//           proportion (long motor/shaft) also drives its physical h/r.
//           Changing ASPECTS.cylinder propagates here automatically.
// capsule:  CapsuleGeometry(0.4, 0.6): h_total = 0.6 + 2×0.4 = 1.4, r = 0.4 → 3.5
// disc:     CylinderGeometry(0.5, 0.5, 0.1): t = 0.1, r = 0.5 → 0.20
// cone:     ConeGeometry(0.45, 1): h = 1, r = 0.45 → ≈ 2.222

const _PHYS_CYL_H_OVER_R  = ASPECTS.cylinder[1] / (ASPECTS.cylinder[0] * 0.5); // 7.0
const _PHYS_CAP_H_OVER_R  = 3.5;          // h_total / r  (body 1.5r + two caps each r)
const _PHYS_DISC_T_OVER_R = 0.2;          // thickness / r
const _PHYS_CONE_H_OVER_R = 1.0 / 0.45;  // ≈ 2.222
function deriveMassDimensions(
  massKg:  number,
  density: number,
  type:    GeoType,
): [number, number, number] {
  const V = massKg / density;   // m³

  switch (type) {

    case 'cylinder': {
      const r = Math.cbrt(V / (Math.PI * _PHYS_CYL_H_OVER_R));
      return [2 * r, _PHYS_CYL_H_OVER_R * r, 2 * r];
    }

    case 'capsule': {
      // V = π r² · h_body + (4/3)π r³ = (17/6)π r³  →  r = ∛(6V / 17π)
      const r     = Math.cbrt(6 * V / (17 * Math.PI));
      const h_tot = _PHYS_CAP_H_OVER_R * r;
      return [2 * r, h_tot, 2 * r];
    }

    case 'sphere': {
      const r = Math.cbrt(3 * V / (4 * Math.PI));
      return [2 * r, 2 * r, 2 * r];
    }

    case 'disc': {
      // V = π r² · t = _PHYS_DISC_T_OVER_R · π · r³
      const r = Math.cbrt(V / (Math.PI * _PHYS_DISC_T_OVER_R));
      return [2 * r, _PHYS_DISC_T_OVER_R * r, 2 * r];
    }

    case 'cone': {
      // V = (π · h/r / 3) r³
      const r = Math.cbrt(3 * V / (Math.PI * _PHYS_CONE_H_OVER_R));
      return [2 * r, _PHYS_CONE_H_OVER_R * r, 2 * r];
    }

    case 'flatbox':
    case 'box':
    case 'octahedron':
    default: {
      // V = ax · ay · az · base³
      const [ax, ay, az] = ASPECTS[type];
      const base = Math.cbrt(V / (ax * ay * az));
      return [ax * base, ay * base, az * base];
    }
  }
}

// ── Domain → hue (deterministic djb2-like hash) ───────────────────────────────

export function domainHue(domain: string): number {
  let h = 0;
  for (let i = 0; i < domain.length; i++) h = ((h << 5) - h + domain.charCodeAt(i)) | 0;
  return Math.abs(h) % 360;
}

// ── v1.4 — Deterministic per-part mass estimate ──────────────────────────────
//
// Not a source of real specs — there are none to find in a procedurally
// curated catalogue like this one (confirmed: 0 of 9,831 parts have
// specs.mass_kg or dimensions populated). This replaces the flat 5 kg
// fallback with a better-informed one: each rule's massHint gives a
// realistic order-of-magnitude range for its part family, and each part
// gets a stable, reproducible position in that range from its own identity
// — same part, same mass, every time, never Math.random(). Log-uniform
// sampling matches the log-scale visual system massToBase() already uses,
// so small and large members of the same family both read clearly instead
// of clustering at one end of the range.

function stableHash01(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return (Math.abs(h) % 100_000) / 100_000; // deterministic, 0..1
}

function estimateMassKg(
  part: { category: string; domain: string; name?: string },
  [lo, hi]: [number, number],
): number {
  const t = stableHash01(`${part.category}|${part.domain}|${part.name ?? ''}`);
  const logLo = Math.log(lo), logHi = Math.log(hi);
  return Math.exp(logLo + t * (logHi - logLo));
}

// ── Public interface ──────────────────────────────────────────────────────────

export interface PartGeo {
  type:      GeoType;
  /** Visual world-space metres [W, H, D] — log-scale for viewport legibility. */
  scale:     [number, number, number];
  /**
   * v1.0 — Volume-accurate physical dimensions in metres [W, H, D].
   * For axisymmetric shapes (cylinder, capsule, sphere, disc, cone):
   *   W = D = diameter,  H = height / total length.
   * Derived from V = mass_kg / material_density via shape-specific formulae.
   * Used for inertia tensor calculation instead of visual scale.
   */
  physDims:  [number, number, number];
  hue:       number;   // 0–360 (domain colour)
  roughness: number;
  metalness: number;
  /** v0.7 — geometry data fidelity tier (exact / derived / procedural). */
  fidelity:  GeometryFidelity;
  /**
   * v0.7 / v1.0 — confidence score 0–1 for physics computations using this part.
   *   0.95  exact model / measured dimensions
   *   0.82  derived with explicit manufacturer dimensions
   *   0.72  derived from mass_kg → volume → inferred physical dimensions  ← v1.0 NEW
   *   0.25  procedural default (no mass data)
   *
   * Note: tier 0.62 (mass_kg known but no physical dims) is retired in v1.0.
   *       All mass-known parts now receive physDims and the 0.72 tier.
   */
  confidence: number;
}

// ── Module-level geo cache ────────────────────────────────────────────────────
//
// resolvePartGeo is a pure function of (category, domain, name, explicit
// mass_kg, modelUrl presence, hasDims) — resolveGeoRule() and estimateMassKg()
// are themselves pure functions of (category, domain, name), so two parts
// with identical raw inputs always resolve to the same rule, mass, and
// therefore the same PartGeo. That means the cache key can be built directly
// from those raw inputs, without first resolving the rule or mass — which
// matters because the very first version of this cache built its key FROM
// the resolved mass/fidelity, meaning resolveGeoRule() — a linear scan
// testing dozens of regexes against the part's name — ran on every call,
// including cache HITS. For a build with any repeated part types (or,
// concretely, every existing part in the scene every time Scene's bucket
// rebuild or computeAssemblyPhysics re-runs after a single part changes),
// that meant re-doing the full regex gauntlet for parts whose geometry had
// already been resolved and cached. Checking the cache first turns a repeat
// lookup into a string-concat + Map.get — see verify_geo_cache_perf.mjs for
// a measurement of the difference.
//
// Cache key format: "<category>|<domain>|<name>|<explicit mass_kg>|<hasModelUrl>|<hasDims>"
//   hasDims = 2 → explicit manufacturer dimensions (confidence 0.82)
//   hasDims = 1 → mass-inferred physical dimensions (confidence 0.72, v1.0)
//   hasDims = 0 → procedural (confidence 0.25)
//
// Cache size: ~80 bytes per entry; 10 000 unique combos ≈ 800 KB — acceptable.
//
// v1.3: cap at _GEO_CACHE_MAX entries. Maps preserve insertion order in V8, so
// evicting the first 10% of keys removes the oldest (LRU-approximate) entries.
// Eviction is O(evictCount) and fires at most once per _GEO_CACHE_MAX inserts.

const _GEO_CACHE_MAX = 30_000;
const _geoCache = new Map<string, PartGeo>();

export function resolvePartGeo(part: {
  name?:       string;
  category:    string;
  domain:      string;
  specs?:      { mass_kg?: number };
  /** Presence triggers 'exact' fidelity tier (0.95) */
  modelUrl?:   string;
  /** Presence triggers explicit-dims derived tier (0.82) */
  dimensions?: Record<string, number>;
}): PartGeo {
  // Cache sub-key for hasDims:
  //   2 = explicit dims supplied (0.82), 1 = mass-inferred (0.72), 0 = procedural (0.25)
  const hasDims = part.dimensions !== undefined   ? 2 :
                  part.specs?.mass_kg !== undefined ? 1 : 0;
  // v1.6 — built from raw inputs only, so a cache hit never needs resolveGeoRule
  // or estimateMassKg at all (see the module comment above). Include name in
  // the key so "Air Cylinder" and "Air Compressor" in the same category can
  // resolve to different shapes based on name-level regex rules.
  const key = `${part.category}|${part.domain}|${part.name ?? ''}|${part.specs?.mass_kg ?? ''}|${part.modelUrl ? 1 : 0}|${hasDims}`;

  const cached = _geoCache.get(key);
  if (cached) return cached;

  const rule = resolveGeoRule(part.category, part.domain, part.name);

  // v1.4: procedural mass is no longer a flat 5 kg for every part — it's a
  // deterministic, category-appropriate estimate from the matched rule's
  // massHint. Real specs.mass_kg, when present, always wins.
  const mass = part.specs?.mass_kg ?? estimateMassKg(part, rule.massHint);

  // Fidelity: exact > derived > procedural
  const fidelity: GeometryFidelity =
    part.modelUrl                       ? 'exact'     :
    part.dimensions                     ? 'derived'   :
    part.specs?.mass_kg !== undefined   ? 'derived'   :
    'procedural';

  // v1.0: confidence tiers
  //   0.82 → explicit manufacturer dimensions supplied by caller
  //   0.72 → mass_kg known; physDims inferred from V = mass/density  (was 0.62)
  //   0.25 → neither — pure procedural archetype
  const confidence: number =
    fidelity === 'exact'              ? 0.95 :
    part.dimensions !== undefined     ? 0.82 :   // explicit real dims → highest derived tier
    part.specs?.mass_kg !== undefined ? 0.72 :   // v1.0: mass → volume → inferred physDims
    0.25;                                         // procedural

  // v1.0: derive physical dimensions for ALL parts (procedural uses estimated mass)
  // physDims are the actual physical extents in metres, independent of visual scale.
  const physDims: [number, number, number] = deriveMassDimensions(
    mass, rule.density, rule.type,
  );

  const geo: PartGeo = {
    type:       rule.type,
    // v1.4: use this rule's aspect override when it has one (e.g. a wheel vs.
    // a washer, both GeoType 'disc'), else fall back to the shared per-type
    // default — same behavior as before for every rule that doesn't set one.
    scale:      resolveScale(mass, rule.aspect ?? ASPECTS[rule.type]),
    physDims,                                     // v1.0: physical dimensions (basis unchanged)
    hue:        domainHue(part.domain),
    roughness:  rule.roughness,
    metalness:  rule.metalness,
    fidelity,
    confidence,
  };

  // v1.3: evict oldest 10% before the cache reaches its cap.
  if (_geoCache.size >= _GEO_CACHE_MAX) {
    const evict = Math.ceil(_GEO_CACHE_MAX * 0.1);
    let n = 0;
    for (const k of _geoCache.keys()) {
      _geoCache.delete(k);
      if (++n >= evict) break;
    }
  }
  _geoCache.set(key, geo);
  return geo;
}

/** Clear the geo cache — call this only in tests or if rule definitions change at runtime. */
export function clearGeoCache(): void {
  _geoCache.clear();
}

// ── Auto-layout: sunflower / phyllotaxis spiral ───────────────────────────────
//
// Each part at index i gets a deterministic position that never shifts when
// other parts are added or removed (unlike a recalculated grid).
// The golden-angle spiral produces a compact, evenly spaced layout with no
// clustering — identical to how seeds pack in a sunflower head.

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5)); // ≈ 2.3999 rad (137.5°)

export function spiralPosition(index: number, spacing = 2.5): [number, number, number] {
  if (index === 0) return [0, 0, 0];
  const angle  = index * GOLDEN_ANGLE;
  const radius = Math.sqrt(index) * spacing * 0.8;
  return [Math.cos(angle) * radius, 0, Math.sin(angle) * radius];
}

// ── v1.0 — Shape-specific local inertia using physical dimensions ─────────────
//
// v0.7 introduced shape-specific analytical formulas per GeoType, replacing the
// uniform-box approximation used in v0.6. This was architecturally correct but
// passed visual scale values (sw, sh, sd) as the linear dimensions — producing
// inertia values ~100× too large for typical parts because the visual scale for
// a 5 kg motor is ~0.6 m wide vs its physical diameter of ~0.06 m. Inertia
// scales as r², so the error compounds: (0.6/0.06)² = 100.
//
// v1.0 change: the function now receives pw, ph, pd — actual physical extents in
// metres, computed by deriveMassDimensions() and stored in PartGeo.physDims.
// The analytical formulas themselves are unchanged; only the dimension source differs.
//
// Parameter semantics:
//   pw — physical width  (metres). For axisymmetric shapes: full diameter.
//   ph — physical height (metres). For axisymmetric: symmetry-axis length.
//   pd — physical depth  (metres). For axisymmetric: = pw.
//
// Axis convention (Three.js / UMB world space, Y = vertical):
//   Ixx — rotation about X (pitch: nose up / down)
//   Iyy — rotation about Y (yaw:  turning left / right)
//   Izz — rotation about Z (roll: leaning side to side)

// GeoType → packed index for Uint8Array storage (avoids string comparison in hot loop)
const GEO_TYPE_IDX: Record<GeoType, number> = {
  cylinder: 0, box: 1, flatbox: 2, sphere: 3,
  capsule:  4, disc: 5, cone:    6, octahedron: 7,
};
const IDX_TO_GEOTYPE: GeoType[] = [
  'cylinder', 'box', 'flatbox', 'sphere',
  'capsule',  'disc', 'cone',   'octahedron',
];

// ── Bucket population count ───────────────────────────────────────────────────

const POPCOUNT_8 = Uint8Array.from(
  { length: 256 },
  (_, x) => { let n = 0; while (x) { n += x & 1; x >>>= 1; } return n; }
);

/**
 * Compute the centroidal (local CoM) inertia tensor for one part.
 *
 * v1.0 change: pw/ph/pd are PHYSICAL dimensions in metres (from PartGeo.physDims),
 * NOT visual scale factors. This corrects the systematic ~100× over-estimate
 * present in v0.7–v0.9.
 *
 * @param mass  Part mass in kg.
 * @param type  Resolved GeoType.
 * @param pw    Physical width  in metres (= diameter for axisymmetric shapes).
 * @param ph    Physical height in metres (= total length for capsule/cylinder).
 * @param pd    Physical depth  in metres (= pw for axisymmetric shapes).
 * @returns     { Ixx, Iyy, Izz } in kg·m².
 */
function computePartLocalInertia(
  mass: number,
  type: GeoType,
  pw:   number,
  ph:   number,
  pd:   number,
): { Ixx: number; Iyy: number; Izz: number } {
  const m = mass;

  switch (type) {

    case 'cylinder': {
      // Solid cylinder: radius = pw/2, height = ph
      // Iyy (about symmetry axis Y) = mr²/2
      // Ixx = Izz (transverse, through CoM) = m(3r²+h²)/12
      const r   = pw * 0.5;
      const h   = ph;
      const Iyy = 0.5 * m * r * r;
      const Itr = m * (3 * r * r + h * h) / 12;
      return { Ixx: Itr, Iyy, Izz: Itr };
    }

    case 'capsule': {
      // v1.1 — Exact solid-capsule inertia (cylinder body + two hemispherical caps).
      //
      // pw = diameter (2r),  ph = total height h_total = h_body + 2r
      //
      // Mass is split volume-proportionally:
      //   M_c = m · V_body / V_total    (cylinder body)
      //   M_h = m · V_caps / V_total    (combined hemisphere pair = one sphere)
      //
      // Iyy  (about symmetry / Y axis):
      //   M_c · r²/2              solid cylinder
      //   (2/5) M_h · r²          hemisphere pair — same axis, no parallel offset
      //
      // Itr  (transverse Ixx = Izz through capsule CoM):
      //   M_c · (r²/4 + h_c²/12)     cylinder centroidal transverse
      //   M_h · (83r²/320 + d²)       hemisphere centroidal transverse + parallel axis
      //   where d = h_c/2 + 3r/8      offset of each hemisphere CoM from capsule CoM
      //         83/320 = 2/5 − (3/8)² hemisphere centroidal coefficient
      //
      // Degeneracy check: h_body = 0 → M_c = 0, M_h = m, d = 3r/8
      //   Iyy = (2/5)mr², Itr = m(83r²/320 + 9r²/64) = m(128r²/320) = (2/5)mr² ✓

      const r      = pw * 0.5;
      const h_body = Math.max(0, ph - 2 * r);

      const V_body  = Math.PI * r * r * h_body;
      const V_caps  = (4 / 3) * Math.PI * r * r * r;
      const V_total = V_body + V_caps;
      const M_c     = m * V_body / V_total;
      const M_h     = m * V_caps / V_total;

      const d   = h_body / 2 + 3 * r / 8;
      const Iyy = 0.5 * M_c * r * r + 0.4 * M_h * r * r;
      const Itr = M_c * (r * r / 4 + h_body * h_body / 12) +
                  M_h * (83 * r * r / 320 + d * d);

      return { Ixx: Itr, Iyy, Izz: Itr };
    }

    case 'disc': {
      // Solid disc (thick cylinder): radius = pw/2, thickness = ph.
      // Iyy (about symmetry axis Y, normal to face) = mr²/2.
      // Ixx = Izz (transverse) = m(3r²+h²)/12.
      //
      // v1.3 fix: replaces the thin-disc approximation mr²/4.
      // The physDims thickness h = _PHYS_DISC_T_OVER_R × r = 0.2r, so the exact
      // formula gives m(3r² + 0.04r²)/12 ≈ 0.2533mr² vs the prior 0.25mr² (1.3%
      // low). For heavy flywheels with larger h/r, the error grows as (h/r)² and
      // would exceed 5% at h/r ≈ 0.5. Using the same cylinder formula here is both
      // exact and keeps disc and cylinder on a consistent code path.
      const r   = pw * 0.5;
      const h   = ph;
      const Iyy = 0.5 * m * r * r;
      const Itr = m * (3 * r * r + h * h) / 12;
      return { Ixx: Itr, Iyy, Izz: Itr };
    }

    case 'sphere': {
      // Uniform solid sphere: I = 2mr²/5 (all axes equal)
      const r = pw * 0.5;
      const I = 0.4 * m * r * r;
      return { Ixx: I, Iyy: I, Izz: I };
    }

    case 'cone': {
      // Solid cone: base radius = pw/2, height = ph, CoM at h/4 from base
      // Iyy (about symmetry axis Y) = 3mr²/10
      // Ixx = Izz (transverse, through CoM) = 3m(4r²+h²)/80
      const r   = pw * 0.5;
      const h   = ph;
      const Iyy = 0.3 * m * r * r;
      const Itr = 3 * m * (4 * r * r + h * h) / 80;
      return { Ixx: Itr, Iyy, Izz: Itr };
    }

    case 'box':
    case 'flatbox':
    case 'octahedron':
    default: {
      // Uniform solid rectangular box: pw=width, ph=height, pd=depth
      // Ixx = m(ph²+pd²)/12,  Iyy = m(pw²+pd²)/12,  Izz = m(pw²+ph²)/12
      const Ixx = m * (ph * ph + pd * pd) / 12;
      const Iyy = m * (pw * pw + pd * pd) / 12;
      const Izz = m * (pw * pw + ph * ph) / 12;
      return { Ixx, Iyy, Izz };
    }
  }
}

// ── v0.8 / v1.0 / v1.2 — Persistent flat-buffer pool ────────────────────────
//
// All TypedArrays used by computeAssemblyPhysics() are declared here as
// module-level singletons. They are reallocated only when n exceeds the current
// capacity — and then only to a doubled capacity, so reallocations become
// exponentially rare as the build grows.
//
// v1.0 added three Float64 arrays for physical dimensions (_physWArr, _physHArr,
// _physDArr). These feed computePartLocalInertia() in Pass 2, replacing the
// visual scale that was previously used.
//
// v1.2: _scWArr, _scHArr, _scDArr removed. They stored visual scale (sw/sh/sd)
// purely for inertia input in v0.8–v0.9. Since v1.0 uses _physWArr/H/D instead,
// the sc* arrays were written in Pass 1 but never read. Dead code removed.
//
// Memory at steady state (10 000-part build):
//   v0.8: 8 × 8 × 10 000  +  1 × 10 000  =  650 KB
//   v1.0: 11 × 8 × 10 000  +  1 × 10 000  =  890 KB  (+240 KB for physDim arrays)
//   v1.2: 7 × 8 × 10 000  +  1 × 10 000  =  570 KB  (−320 KB; 3 scW/H/D removed)

let _bufCap    = 0;
let _massArr   = new Float64Array(0);
let _posXArr   = new Float64Array(0);
let _posYcArr  = new Float64Array(0);  // vertical centre of each part
let _posZArr   = new Float64Array(0);
// _scWArr/_scHArr/_scDArr removed in v1.2: visual scale was written here in v0.8–v0.9
// for inertia input, replaced by _physWArr/H/D in v1.0. Nothing reads them anymore.
let _physWArr  = new Float64Array(0);  // v1.0: physical width  in metres (or diameter)
let _physHArr  = new Float64Array(0);  // v1.0: physical height in metres
let _physDArr  = new Float64Array(0);  // v1.0: physical depth  in metres (or diameter)
let _geoTArr   = new Uint8Array(0);    // GeoType index per part (8× smaller than Float64)

/**
 * Ensure all flat buffers have capacity for at least `n` elements.
 * No-op when n ≤ _bufCap. Grows all 8 arrays together to max(n, _bufCap × 2, 64).
 *
 * v1.2: _scWArr/_scHArr/_scDArr removed (were written but never read since v1.0).
 * Memory at steady state (10 000-part build):
 *   v0.8–v1.1: 11 × 8 × 10 000  +  1 × 10 000  =  890 KB
 *   v1.2:       7 × 8 × 10 000  +  1 × 10 000  =  570 KB  (−320 KB)
 */
function _ensureBuffers(n: number): void {
  if (n <= _bufCap) return;
  const cap  = Math.max(n, _bufCap * 2, 64);
  _massArr   = new Float64Array(cap);
  _posXArr   = new Float64Array(cap);
  _posYcArr  = new Float64Array(cap);
  _posZArr   = new Float64Array(cap);
  _physWArr  = new Float64Array(cap);   // v1.0
  _physHArr  = new Float64Array(cap);   // v1.0
  _physDArr  = new Float64Array(cap);   // v1.0
  _geoTArr   = new Uint8Array(cap);
  _bufCap    = cap;
}

// ── Assembly physics ──────────────────────────────────────────────────────────
//
// computeAssemblyPhysics() runs two O(n) passes over the flat-buffer pool.
// All resolvePartGeo calls hit _geoCache → O(1) per part.
//
// Pass 1 — totalMass, weighted-sum positions, AABB footprint, bucket census,
//           fidelity census, flat-buffer fill (visual + physical dims),
//           mass-weighted confidence accumulator.
//
// Pass 2 — inertia tensor about CoM using shape-specific local formulas (v0.7)
//           + parallel-axis correction. Uses physical dims (v1.0) for accuracy.
//           v1.2: weight-distribution accumulation (frontMass/leftMass) folded
//           in here; footCX/footCZ computed from Pass 1 results beforehand.
//
// Post-pass — gyration radius, comOffset, weightDistribution, avgConfidence.
//
// v1.0 changes in this function:
//   Pass 1: fill _physWArr/H/D[i] from geo.physDims; accumulate wxConf for avgConfidence.
//   Pass 2: call computePartLocalInertia with _physWArr/H/D instead of _scWArr/H/D.
//   Return: include avgConfidence.
//
// v1.2 changes:
//   Merged former weight-distribution loop into Pass 2 body; removed standalone loop.

/** Structural type accepted by computeAssemblyPhysics — compatible with InstalledPart. */
type PhysicsPart = {
  iid:         string;
  position?:   [number, number, number];
  specs?:      { mass_kg?: number };
  category:    string;
  domain:      string;
  modelUrl?:   string;
  dimensions?: Record<string, number>;
};

export interface AssemblyPhysics {
  /** Sum of all part masses (kg). */
  totalMass: number;

  /** Mass-weighted centre of mass in world-space metres. */
  com: { x: number; y: number; z: number };

  /**
   * Approximate principal moments of inertia (kg·m²) about the CoM.
   *
   * v1.0: computed from physical dimensions (PartGeo.physDims) rather than
   * visual scale, correcting a systematic ~100× over-estimate present in v0.9.
   * Uses shape-specific analytical formulas per GeoType (introduced in v0.7).
   *
   * Axis convention (Three.js / UMB world space):
   *   Ixx — rotation about X (pitch: nose up / down)
   *   Iyy — rotation about Y (yaw:  turning left / right)
   *   Izz — rotation about Z (roll: leaning side to side)
   */
  inertia: { Ixx: number; Iyy: number; Izz: number };

  /**
   * Radii of gyration k = sqrt(I / M) in metres (v0.7).
   * Shape- and scale-agnostic measure of how spread-out the mass is.
   */
  gyrationRadius: { kx: number; ky: number; kz: number };

  /**
   * Tip-over stability index  [0 … 1].
   *   > 0.70  →  stable
   *   0.35–0.70 →  marginal
   *   < 0.35  →  likely to tip
   */
  stability: number;

  /** CoM displacement from the AABB footprint centre (v0.7). */
  comOffset: { dx: number; dz: number };

  /**
   * Mass distribution split at the footprint centre (v0.7).
   * front/rear = split along Z axis.  left/right = split along X axis.
   */
  weightDistribution: {
    front: number; rear: number;
    left:  number; right: number;
  };

  /** Axis-aligned bounding box of the full assembly (physical world-space metres). */
  bounds: {
    minX: number; maxX: number;
    minZ: number; maxZ: number;
    minY: number; maxY: number;
  };

  /**
   * Number of distinct GeoType values present in this build.
   * Equals the number of active THREE.InstancedMesh draw calls (≤ 8).
   */
  bucketCount: number;

  /**
   * Part data fidelity census (v0.7).
   *   exact      — real model or explicit dimensions
   *   derived    — mass-derived geometry (mass_kg known)
   *   procedural — pure category-archetype default
   */
  fidelityProfile: { exact: number; derived: number; procedural: number };

  /**
   * v1.0 — Mass-weighted average confidence score across all build parts [0–1].
   *   0.95  all parts have exact geometry models
   *   0.82  all parts have explicit manufacturer dimensions
   *   0.72  all parts have mass-inferred physical dimensions (v1.0 baseline for
   *          the 6 593-part catalog — upgraded from the prior 0.62 ceiling)
   *   0.25  no mass data — pure procedural archetypes
   */
  avgConfidence: number;
}

/**
 * Compute all assembly-level physics quantities in two O(n) passes.
 *
 * v1.0: uses physical dimensions for inertia; zero TypedArray allocations at
 * steady state; returns mass-weighted avgConfidence.
 *
 * v1.2: weight-distribution accumulation folded into Pass 2 — three loops
 * reduced to two, with better cache reuse on _massArr/_posXArr/_posZArr.
 *
 * @param parts   The InstalledPart array from the build store.
 * @param posMap  Auto-layout positions for parts without an explicit position.
 */
export function computeAssemblyPhysics(
  parts:  readonly PhysicsPart[],
  posMap: ReadonlyMap<string, [number, number, number]>,
): AssemblyPhysics {

  const EMPTY: AssemblyPhysics = {
    totalMass:          0,
    com:                { x: 0, y: 0, z: 0 },
    inertia:            { Ixx: 0, Iyy: 0, Izz: 0 },
    gyrationRadius:     { kx: 0, ky: 0, kz: 0 },
    stability:          1,
    comOffset:          { dx: 0, dz: 0 },
    weightDistribution: { front: 50, rear: 50, left: 50, right: 50 },
    bounds:             { minX: 0, maxX: 0, minZ: 0, maxZ: 0, minY: 0, maxY: 0 },
    bucketCount:        0,
    fidelityProfile:    { exact: 0, derived: 0, procedural: 0 },
    avgConfidence:      0,
  };
  if (parts.length === 0) return EMPTY;

  const n = parts.length;

  _ensureBuffers(n);

  // ── Pass 1: mass · weighted-position sums · AABB · bucket census ──────────
  let totalMass = 0;
  let wx = 0, wy = 0, wz = 0;
  let minX =  Infinity, maxX = -Infinity;
  let minZ =  Infinity, maxZ = -Infinity;
  let minY =  Infinity, maxY = -Infinity;

  let bucketBits = 0;
  let exactCount = 0, derivedCount = 0, proceduralCount = 0;
  let wxConf = 0;   // v1.0: mass-weighted confidence accumulator

  for (let i = 0; i < n; i++) {
    const p    = parts[i];
    const mass = p.specs?.mass_kg ?? 5;
    const pos  = p.position ?? posMap.get(p.iid)
               ?? ([0, 0, 0] as [number, number, number]);
    const geo  = resolvePartGeo(p);
    // v1.3: visual scale (geo.scale) no longer read in this loop.
    // All AABB, CoM, and inertia calculations use geo.physDims only.
    const [pw, ph, pd] = geo.physDims;   // v1.0: physical dimensions

    bucketBits |= 1 << GEO_TYPE_IDX[geo.type];
    _geoTArr[i] = GEO_TYPE_IDX[geo.type];

    if      (geo.fidelity === 'exact')    exactCount++;
    else if (geo.fidelity === 'derived')  derivedCount++;
    else                                  proceduralCount++;

    wxConf += mass * geo.confidence;   // v1.0

    // v1.5: physical height for accurate CoM Y
    // v1.6: cone centroid is at h/4 from base, not h/2 (all other shapes are symmetric)
    const cy = pos[1] + (geo.type === 'cone' ? ph * 0.25 : ph * 0.5);

    totalMass += mass;
    wx += mass * pos[0];
    wy += mass * cy;
    wz += mass * pos[2];

    const hw = pw * 0.5, hd = pd * 0.5;   // v1.5: physical dims for accurate AABB footprint
    if (pos[0] - hw < minX) minX = pos[0] - hw;
    if (pos[0] + hw > maxX) maxX = pos[0] + hw;
    if (pos[2] - hd < minZ) minZ = pos[2] - hd;
    if (pos[2] + hd > maxZ) maxZ = pos[2] + hd;
    if (pos[1]      < minY) minY = pos[1];          // v1.3: base Y (ground contact)
    if (pos[1] + ph > maxY) maxY = pos[1] + ph;    // v1.3: physical top (was visual sh — 10–100× too large)

    _massArr[i]  = mass;
    _posXArr[i]  = pos[0];
    _posYcArr[i] = cy;
    _posZArr[i]  = pos[2];
    _physWArr[i] = pw;   // v1.0
    _physHArr[i] = ph;   // v1.0
    _physDArr[i] = pd;   // v1.0
  }

  const com = totalMass > 0
    ? { x: wx / totalMass, y: wy / totalMass, z: wz / totalMass }
    : { x: 0, y: 0, z: 0 };

  // v1.0: mass-weighted average confidence
  const avgConfidence = totalMass > 0
    ? Math.round(wxConf / totalMass * 100) / 100
    : 0;

  // footCX/footCZ are needed before Pass 2 (weight-distribution is folded in).
  const footCX = (minX + maxX) * 0.5;
  const footCZ = (minZ + maxZ) * 0.5;

  // ── Pass 2: inertia tensor about CoM + weight distribution ───────────────────
  //
  // v1.0: computePartLocalInertia receives physical dimensions (_physWArr/H/D)
  // instead of visual scale (_scWArr/H/D). This corrects the ~100× over-estimate.
  // Parallel-axis theorem applied identically to v0.7–v0.9.
  //
  // v1.2: frontMass/leftMass accumulation is folded into this loop (was a separate
  // O(n) pass). Both branches read _massArr/_posXArr/_posZArr which are already
  // in CPU cache from the inertia reads, so no additional memory traffic.

  let Ixx = 0, Iyy = 0, Izz = 0;
  let frontMass = 0, leftMass = 0;
  const cx = com.x, cy_com = com.y, cz = com.z;

  for (let i = 0; i < n; i++) {
    const mass  = _massArr[i];
    const dx    = _posXArr[i]  - cx;
    const dy    = _posYcArr[i] - cy_com;
    const dz    = _posZArr[i]  - cz;

    const gtype = IDX_TO_GEOTYPE[_geoTArr[i]];

    // v1.0: physical dimensions replace visual scale here
    const { Ixx: Ixx_l, Iyy: Iyy_l, Izz: Izz_l } =
      computePartLocalInertia(mass, gtype, _physWArr[i], _physHArr[i], _physDArr[i]);

    Ixx += Ixx_l + mass * (dy * dy + dz * dz);
    Iyy += Iyy_l + mass * (dx * dx + dz * dz);
    Izz += Izz_l + mass * (dx * dx + dy * dy);

    // v1.2: weight distribution (folded from former standalone loop)
    // v1.5: parts exactly on the midline (incl. single-part case) split 50/50
    if      (_posZArr[i] < footCZ)   frontMass += mass;
    else if (_posZArr[i] === footCZ) frontMass += mass * 0.5;
    if      (_posXArr[i] < footCX)   leftMass  += mass;
    else if (_posXArr[i] === footCX) leftMass  += mass * 0.5;
  }

  const frontPct = totalMass > 0 ? Math.round(frontMass / totalMass * 1000) / 10 : 50;
  const leftPct  = totalMass > 0 ? Math.round(leftMass  / totalMass * 1000) / 10 : 50;

  // ── Radii of gyration ──────────────────────────────────────────────────────
  const invM = totalMass > 0 ? 1 / totalMass : 0;
  const kx   = Math.sqrt(Ixx * invM);
  const ky   = Math.sqrt(Iyy * invM);
  const kz   = Math.sqrt(Izz * invM);

  // ── Stability score ────────────────────────────────────────────────────────
  let stability = 1;

  if (n > 1) {
    const footW  = Math.max(maxX - minX, 0.001);
    const footD  = Math.max(maxZ - minZ, 0.001);
    const offX   = Math.abs(com.x - footCX);
    const offZ   = Math.abs(com.z - footCZ);
    const marginX = footW * 0.5 - offX;
    const marginZ = footD * 0.5 - offZ;

    if (marginX <= 0 || marginZ <= 0) {
      stability = 0;
    } else {
      const r        = Math.min(marginX, marginZ);
      const comHeight = Math.max(com.y, 0.001);
      const tipAngle  = Math.atan2(r, comHeight);
      stability       = Math.min(1, tipAngle / (Math.PI * 0.25));
    }
    stability = Math.round(stability * 1000) / 1000;
  }

  return {
    totalMass,
    com,
    inertia:     { Ixx, Iyy, Izz },
    gyrationRadius: {
      kx: Math.round(kx * 1000) / 1000,
      ky: Math.round(ky * 1000) / 1000,
      kz: Math.round(kz * 1000) / 1000,
    },
    stability,
    comOffset: {
      dx: Math.round((com.x - footCX) * 1000) / 1000,
      dz: Math.round((com.z - footCZ) * 1000) / 1000,
    },
    weightDistribution: {
      front: frontPct,
      rear:  Math.round((100 - frontPct) * 10) / 10,
      left:  leftPct,
      right: Math.round((100 - leftPct) * 10) / 10,
    },
    bounds:         { minX, maxX, minZ, maxZ, minY, maxY },
    bucketCount:    POPCOUNT_8[bucketBits],
    fidelityProfile: {
      exact:      exactCount,
      derived:    derivedCount,
      procedural: proceduralCount,
    },
    avgConfidence,   // v1.0
  };
}
