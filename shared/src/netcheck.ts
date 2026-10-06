/**
 * Road-network checks: connectivity, district redundancy, location reachability.
 *
 * These used to be a claim in three comments ("the generator verifies the whole
 * network against the location table first") and nothing else — the verifier that
 * did it was a scratch file under the OS temp directory, and when it was deleted
 * the claim kept being repeated over data nobody had ever checked. So the checks
 * live in-tree now, and scripts/emit-scenery-data.mjs calls them before it writes
 * anything, so a bad map fails at the point of generation instead of at runtime.
 *
 * THE TILE RULE. scenery.ts bakes each road into a blocked mask with a 1-tile
 * margin (`x1-1, y1-1, x2+1, y2+1`), so two segments count as connected when
 * their *expanded* tile sets share a tile. Everything below works on those
 * expanded tile sets rather than on segment endpoints: a pair of parallel roads
 * whose ends merely line up on the same row are not connected, and neither are
 * two roads one tile apart that share no tile. Both of those read as "joined"
 * if you test endpoint proximity, which is exactly the bug class this exists to
 * catch.
 */

/** A road segment in tile coordinates, inclusive on both ends. Always 2 tiles wide. */
export interface Segment {
  x1: number; y1: number; x2: number; y2: number;
}

/** An axis-aligned tile footprint, matching the location record shape. */
export interface Footprint {
  x: number; y: number; w: number; h: number;
}

/** A named district parcel, matching the renderer shape. */
export interface Parcel extends Footprint { name: string }

/** How many tiles of clearance each road claims either side of its tarmac. */
export const MARGIN = 1;

/** True when a segment runs further east-west than north-south. */
export const isHorizontal = (s: Segment): boolean =>
  s.x2 - s.x1 >= s.y2 - s.y1;

/**
 * The tile rectangle a segment occupies once `MARGIN` tiles of clearance are
 * added, clipped to the world. Two segments are connected iff these rectangles
 * intersect — see the tile rule in the module comment.
 */
export function expanded(s: Segment, worldW: number, worldH: number) {
  return {
    x0: Math.max(0, s.x1 - MARGIN),
    y0: Math.max(0, s.y1 - MARGIN),
    x1: Math.min(worldW - 1, s.x2 + MARGIN),
    y1: Math.min(worldH - 1, s.y2 + MARGIN),
  };
}

const overlaps = (
  a: { x0: number; y0: number; x1: number; y1: number },
  b: { x0: number; y0: number; x1: number; y1: number },
): boolean => a.x0 <= b.x1 && b.x0 <= a.x1 && a.y0 <= b.y1 && b.y0 <= a.y1;

/** Whether two segments touch, measured on expanded tiles rather than endpoints. */
export function connected(a: Segment, b: Segment, worldW: number, worldH: number): boolean {
  if (a === b) return true;
  return overlaps(expanded(a, worldW, worldH), expanded(b, worldW, worldH));
}

/**
 * Adjacency list over segments: `adj[i]` is every segment `i` touches.
 *
 * O(n^2) but n is a few hundred and it runs once, in the generator, not in a
 * frame loop — a spatial index here would be speculative.
 */
export function adjacency(roads: readonly Segment[], worldW: number, worldH: number): number[][] {
  const boxes = roads.map((r) => expanded(r, worldW, worldH));
  return roads.map((_, i) => {
    const out: number[] = [];
    for (let j = 0; j < roads.length; j++) if (overlaps(boxes[i]!, boxes[j]!)) out.push(j);
    return out;
  });
}

export interface NetworkReport {
  /** Indexes of every segment reachable from the seed set. */
  reachable: Set<number>;
  /** Indexes of segments stranded outside the seed component. */
  orphans: number[];
  /** Road tiles inside the seed set — the raw number the brief asks about. */
  crossings: number;
}

/**
 * Every segment touching any of the seeds, plus everything reachable from them.
 *
 * `seeds` is the town core, expressed as a box rather than a list of segments so
 * the caller cannot accidentally seed with a road that is itself an orphan.
 */
export function reachFromBox(
  roads: readonly Segment[],
  seed: Footprint,
  worldW: number,
  worldH: number,
): NetworkReport {
  const adj = adjacency(roads, worldW, worldH);
  const seeds = roads
    .map((r, i) => ({ r, i }))
    .filter(({ r }) =>
      r.x1 <= seed.x + seed.w && r.x2 >= seed.x && r.y1 <= seed.y + seed.h && r.y2 >= seed.y)
    .map(({ i }) => i);

  const seen = new Set<number>(seeds);
  const queue = [...seeds];
  for (let head = 0; head < queue.length; head++) {
    for (const j of adj[queue[head]!]!) {
      if (seen.has(j)) continue;
      seen.add(j);
      queue.push(j);
    }
  }

  // "Crossings" in the old report counted every H/V core pair whose boxes
  // overlapped, which double-counted when three roads met at one junction. The
  // connected-component count is the number that actually matters.
  let crossings = 0;
  for (const i of seen) {
    for (const j of adj[i]!) if (j > i && seen.has(j)) crossings++;
  }
  return {
    reachable: seen,
    orphans: roads.map((_, i) => i).filter((i) => !seen.has(i)),
    crossings,
  };
}

/**
 * Max edge-disjoint paths from `nodes` back to the core component.
 *
 * Max-flow on the segment graph with unit capacity per segment, Edmonds-Karp.
 * The flow is integral, so a value of 2 is the certificate that no single
 * segment removal separates the district from the core — which turns "this
 * district hangs off one bridge" into a number instead of a claim.
 *
 * Each undirected adjacency becomes TWO directed arcs of capacity 1, not one.
 * That is the standard reduction for undirected unit-capacity max-flow and it
 * computes the right number: an integral flow that pushes both arcs of the same
 * edge can have one unit cancelled without changing the value, so the maximum
 * equals the maximum number of edge-disjoint paths. Giving only one arc per pair
 * would silently orient the graph by array index and report a district as
 * unreachable purely because its neighbour happened to be declared later.
 *
 * Source = the district's touching segments, sink = any segment of `core`.
 */
export function edgeDisjointTo(
  roads: readonly Segment[],
  adj: readonly number[][],
  nodes: readonly number[],
  core: ReadonlySet<number>,
): number {
  const n = roads.length;
  const SRC = n;          // virtual source
  const SNK = n + 1;      // virtual sink
  const width = n + 2;

  // Residual graph as an arc list. `res[e]` is the remaining capacity of arc e;
  // arc e^1 is its reverse. Segment-to-segment arcs get capacity 1 in *one*
  // direction only (i < j), so a segment is capacity 1 total rather than 1 each
  // way — otherwise the same bridge would count as two disjoint paths.
  const to: number[] = [];
  const res: number[] = [];
  const head = new Int32Array(width).fill(-1);
  const next: number[] = [];
  const add = (a: number, b: number, c = 1): void => {
    const e = to.length;
    to.push(b); res.push(c); next.push(head[a]!); head[a] = e;
    to.push(a); res.push(0); next.push(head[b]!); head[b] = e + 1;
  };

  for (const i of nodes) {
    if (i >= 0 && i < n && !core.has(i)) add(SRC, i);
  }
  for (let i = 0; i < n; i++) {
    for (const j of adj[i]!) {
      if (j <= i) continue;               // add each undirected pair once
      add(i, j);
      add(j, i);                         // ... in both directions (see above)
    }
    if (core.has(i)) add(i, SNK);
  }

  // Edmonds-Karp: repeatedly augment along a shortest residual path. The network
  // is small and integral, so this terminates quickly and exactly.
  const from = new Int32Array(width);
  const viaEdge = new Int32Array(width);
  let flow = 0;
  for (;;) {
    from.fill(-1);
    from[SRC] = SRC;
    const queue = [SRC];
    for (let q = 0; q < queue.length; q++) {
      const u = queue[q]!;
      for (let e = head[u]!; e !== -1; e = next[e]!) {
        if (res[e]! < 1) continue;
        const v = to[e]!;
        if (from[v] !== -1) continue;
        from[v] = u;
        viaEdge[v] = e;
        if (v === SNK) break;
        queue.push(v);
      }
    }
    if (from[SNK] === -1) break;              // no augmenting path left
    for (let v = SNK; v !== SRC; v = from[v]!) {
      const e = viaEdge[v]!;
      res[e]! -= 1;
      res[e ^ 1]! += 1;
    }
    flow++;
  }
  return flow;
}

/**
 * Walk-reachability: can you get from the town core to each building on foot?
 *
 * A road is 2 tiles of blocked tarmac, so the honest question is not "does a road
 * touch this building" but "is this building still on the same side of the
 * streets as the town". Flood over the tiles that are neither carriageway nor
 * building — the same BLOCKED mask scenery.ts bakes — starting from every tile
 * beside a core road, and report the buildings that no footpath reaches.
 *
 * The stricter "a road passes within one tile of the footprint" rule is also
 * measured, and reported, but it is not a gate: 40 of the town's buildings sit
 * inside a 190x96 parcel packed tight enough that no street can be laid beside
 * all of them, and the pre-existing network failed it 86 times out of 100.
 */
export function walkReachable(opts: {
  roads: readonly Segment[];
  locations: readonly (Footprint & { id: string })[];
  core: Footprint;
  worldW: number;
  worldH: number;
}): { unreachable: string[]; noFrontage: string[]; nested: string[] } {
  const { roads, locations, core, worldW, worldH } = opts;
  const W = worldW, H = worldH;

  // 0 = open ground, 1 = carriageway (walkable at a cost), 2 = building (solid).
  // This mirrors backend/src/map.ts: A* treats a road as passable-but-slow, so a
  // road can never wall anything off. Only buildings are solid.
  const grid = new Uint8Array(W * H);
  for (const r of roads) {
    for (let y = Math.max(0, r.y1); y <= Math.min(H - 1, r.y2); y++) {
      for (let x = Math.max(0, r.x1); x <= Math.min(W - 1, r.x2); x++) grid[y * W + x] = 1;
    }
  }
  // Only the true footprint is solid. The 1-tile margin scenery.ts applies is
  // separate; folding it in here too would mark every tile a caller could
  // possibly test as solid, and then every location is unreachable by
  // construction. Reachability is measured on the tiles immediately outside the
  // footprint — "can you stand beside this building and still be in town".
  for (const l of locations) {
    for (let y = Math.max(0, l.y); y <= Math.min(H - 1, l.y + l.h - 1); y++) {
      for (let x = Math.max(0, l.x); x <= Math.min(W - 1, l.x + l.w - 1); x++) grid[y * W + x] = 2;
    }
  }

  // seed: every passable tile in the core box, which is the town centre itself
  const seen = new Uint8Array(W * H);
  const queue: number[] = [];
  const step = (i: number): void => {
    if (seen[i] || grid[i] === 2) return;
    seen[i] = 1;
    queue.push(i);
  };
  for (let y = Math.max(0, core.y); y <= Math.min(H - 1, core.y + core.h); y++) {
    for (let x = Math.max(0, core.x); x <= Math.min(W - 1, core.x + core.w); x++) step(y * W + x);
  }
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head]!;
    const x = i % W, y = (i - x) / W;
    if (x > 0) step(i - 1);
    if (x < W - 1) step(i + 1);
    if (y > 0) step(i - W);
    if (y < H - 1) step(i + W);
  }

  const unreachable: string[] = [];
  // A footprint wholly inside another one is a fixture, not a building you can
  // walk up to: the 3x2 board listed at 522,310 sits inside the square's own
  // 18x15 footprint, so no street and no amount of paving can reach it. Excluded
  // from the gate and reported separately, because failing on it would only ever
  // teach someone to ignore the check.
  const nested = new Set<string>();
  for (const l of locations) {
    for (const other of locations) {
      if (other === l) continue;
      if (l.x >= other.x && l.y >= other.y && l.x + l.w <= other.x + other.w && l.y + l.h <= other.y + other.h) {
        nested.add(l.id);
        break;
      }
    }
  }
  for (const l of locations) {
    if (nested.has(l.id)) continue;
    let ok = false;
    for (let y = Math.max(0, l.y - 1); y <= Math.min(H - 1, l.y + l.h) && !ok; y++) {
      for (let x = Math.max(0, l.x - 1); x <= Math.min(W - 1, l.x + l.w); x++) {
        if (seen[y * W + x]) { ok = true; break; }
      }
    }
    if (!ok) unreachable.push(l.id);
  }

  // reported metric only: a carriageway beside the footprint
  const noFrontage: string[] = [];
  for (const l of locations) {
    const near = roads.some((r) =>
      r.x1 - MARGIN <= l.x + l.w - 1 && r.x2 + MARGIN >= l.x &&
      r.y1 - MARGIN <= l.y + l.h - 1 && r.y2 + MARGIN >= l.y);
    if (!near) noFrontage.push(l.id);
  }
  return { unreachable, noFrontage, nested: [...nested] };
}

export interface NetworkFailure { rule: string; detail: string }

/**
 * The gate the generator runs: no orphan segments, nothing outside the world,
 * no location walled off. Returns failures rather than throwing so the caller
 * can print all of them at once — fixing a map one error per run is miserable.
 */
export function checkNetwork(opts: {
  roads: readonly Segment[];
  names: readonly string[];
  core: Footprint;
  locations: readonly (Footprint & { id: string })[];
  worldW: number;
  worldH: number;
}): NetworkFailure[] {
  const { roads, names, core, locations, worldW, worldH } = opts;
  const failures: NetworkFailure[] = [];

  for (const r of roads) {
    if (r.x1 < 0 || r.y1 < 0 || r.x2 >= worldW || r.y2 >= worldH) {
      failures.push({
        rule: "in-bounds",
        detail: `${r.x1},${r.y1} -> ${r.x2},${r.y2} leaves [0,${worldW - 1}] x [0,${worldH - 1}]`,
      });
    }
  }

  const { orphans } = reachFromBox(roads, core, worldW, worldH);
  for (const i of orphans) {
    failures.push({ rule: "reachable", detail: `${names[i]} (${roads[i]!.x1},${roads[i]!.y1}) is an orphan` });
  }

  // A location is reachable when a footpath exists from the town core to it,
  // crossing neither carriageway nor building. See walkReachable for why the
  // stricter "a road touches the footprint" rule is reported, not enforced.
  const { unreachable } = walkReachable({ roads, locations, core, worldW, worldH });
  for (const id of unreachable) {
    failures.push({ rule: "location-reachable", detail: `${id} cannot be walked to from the core` });
  }

  return failures;
}
