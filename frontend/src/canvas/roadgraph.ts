/**
 * The road graph the traffic drives on.
 *
 * Vehicles used to follow a pre-baked rectangle — one per road, per direction —
 * so a car drove up and down the same 40 tiles forever and never met anything.
 * That produced 738 units whose only behaviour was a loop, and 851 us/frame
 * measured over them. A graph lets the same fleet route at runtime: at each
 * junction a vehicle picks a different exit, so traffic spreads across the town
 * and the fleet can be sized for the frame budget instead of the road count.
 *
 * The graph is derived, not authored. It is rebuilt only when the road table
 * changes, so it can never disagree with ROADS.
 */

/** A tile-space junction. Ids are indices into `RoadGraph.nodes`. */
export interface Junction {
  readonly x: number;
  readonly y: number;
}

/**
 * One direction of travel between two junctions.
 *
 * `forward` is the direction the unit is heading. A unit on an edge whose
 * forward direction points back along the road simply drives the span in
 * reverse, which is how the two carriageway directions are expressed without
 * duplicating geometry.
 */
export interface Span {
  readonly from: number;
  readonly to: number;
  /** Tile-space length, so speed and look-ahead can be scaled to the road. */
  readonly len: number;
  /** True when the span runs east-west. Drives which way is "right". */
  readonly horizontal: boolean;
  /** Unit direction from `from` to `to`. */
  readonly dx: number;
  readonly dy: number;
}

export interface RoadGraph {
  readonly nodes: readonly Junction[];
  /** Outgoing spans per node: `edges[i]` are the ways out of node `i`. */
  readonly edges: readonly (readonly Span[])[];
}

/** A raw road as ROADS holds it: a 2-tile-wide, axis-aligned tile rectangle. */
type Raw = { x1: number; y1: number; x2: number; y2: number };

const spanX = (s: Raw) => ({ lo: Math.min(s.x1, s.x2), hi: Math.max(s.x1, s.x2) });
const spanY = (s: Raw) => ({ lo: Math.min(s.y1, s.y2), hi: Math.max(s.y1, s.y2) });
const isH = (s: Raw) => Math.abs(s.x2 - s.x1) >= Math.abs(s.y2 - s.y1);

/**
 * A road's centreline, in tile space.
 *
 * Every coordinate in this module is a centreline coordinate, and that is not a
 * stylistic choice. The emitted roads are frequently one tile off axis — the
 * north ring runs (30,60)-(88,61) — so two roads that join at x=88 present
 * different corner tiles: the first ends at y=61, the second starts at y=60.
 * Snapping raw corners together therefore produces two nodes where there should
 * be one, and the graph falls apart into 464 dead ends. Their centrelines agree
 * exactly, which is why centrelines are what gets matched.
 */
interface Centre {
  /** Constant across a horizontal road; the run of it across a vertical one. */
  readonly fixed: number;
  /**
   * The span along the road's own axis, in HALF-tile units so every coordinate in
   * this module lives on one grid.
   *
   * Both ends are TILE CENTRES, not tile edges: a road covering tiles a..b has a
   * centreline running from a+0.5 to b+0.5. Using the edges instead put one road's
   * end at x=592 and the crossing road's cut at x=592.5 — two nodes half a tile
   * apart for one junction, joined by a 0.5-tile span that exists on no tarmac.
   * That was the last 2% of driven positions leaving the road.
   */
  readonly lo: number;
  readonly hi: number;
}

function centre(s: Raw): Centre {
  const horizontal = isH(s);
  const a = horizontal ? spanX(s) : spanY(s);
  const across = horizontal ? spanY(s) : spanX(s);
  return { fixed: (across.lo + across.hi) / 2, lo: a.lo * 2 + 1, hi: a.hi * 2 + 1 };
}

/** A centreline point: `along` is in half-tiles, `fixed` the constant offset. */
const at = (c: Centre, along: number, horizontal: boolean) =>
  horizontal ? { x: along / 2, y: c.fixed } : { x: c.fixed, y: along / 2 };

/**
 * Where two roads meet, as a point on EACH of them — or null if they do not.
 *
 * Endpoints do NOT coincide in this road table: the north ring runs
 * (30,60)-(88,61) while the vertical at x=88 starts at (88,60). Matching on
 * shared endpoints yields 601 nodes and no junctions at all. Two roads join when
 * one reaches across the other, which is the test `netcheck` reaches through
 * MARGIN expansion.
 *
 * Returning a point per road rather than one shared point is the detail that
 * makes this correct. A vertical road crossed at y=88 by a long horizontal needs
 * its cut at y=88; the horizontal needs its cut at the vertical's x. Sharing one
 * midpoint put the vertical's cut at its own centre, which for a road spanning
 * 60..166 is y=113 — fifty tiles away from the crossing, and 4,157 of 10,780
 * sampled vehicle positions landed on grass.
 */
function meeting(a: Raw, b: Raw): { onA: { x: number; y: number }; onB: { x: number; y: number } } | null {
  const ca = centre(a);
  const cb = centre(b);
  const ah = isH(a);
  const bh = isH(b);

  if (ah === bh) {
    // Collinear. They join only where one terminates against the other — two
    // roads merely overlapping along their length are the same road.
    if (Math.abs(ca.fixed - cb.fixed) > 0.001) return null;
    if (Math.min(ca.hi, cb.hi) < Math.max(ca.lo, cb.lo)) return null;
    // The join sits at the far end of the shared run, in half-tile units, which
    // is the same grid the perpendicular branch uses. Averaging the overlap
    // instead put a join at x=30.49 for roads that abut exactly, which is half a
    // tile off the tarmac — worse than the duplicated-node problem it fixed.
    const along = Math.min(ca.hi, cb.hi);
    return { onA: at(ca, along, ah), onB: at(cb, along, bh) };
  }

  // Perpendicular. The horizontal's fixed coordinate is its y; the vertical's is
  // its x. They cross when each one's axis run covers the other's fixed line.
  //
  // The tolerance is two half-tiles, i.e. one tile, because the roads are drawn
  // two tiles wide and a crossing at the very edge is a real junction. The cut is
  // then CLAMPED to the road that owns it: without that, a crossing accepted on
  // the tolerance anchors a span from just outside a road's end, and the vehicle
  // drives off the tarmac into open ground.
  const horizontal = ah ? ca : cb;
  const vertical = ah ? cb : ca;
  const vFixed = vertical.fixed * 2; // into half-tiles
  const hFixed = horizontal.fixed * 2;
  if (vFixed < horizontal.lo - 2 || vFixed > horizontal.hi + 2) return null;
  if (hFixed < vertical.lo - 2 || hFixed > vertical.hi + 2) return null;

  const clamp = (v: number, c: Centre) => Math.min(Math.max(v, c.lo), c.hi);
  // The orientation flag must belong to the road whose centre is being read, not
  // to road `a`. Passing `ah` here transposed the axes whenever the pair arrived
  // as (vertical, horizontal), which is what produced 758 diagonal spans across
  // ground where no road exists.
  const onHorizontal = at(horizontal, clamp(vFixed, horizontal), true);
  const onVertical = at(vertical, clamp(hFixed, vertical), false);
  return ah ? { onA: onHorizontal, onB: onVertical } : { onA: onVertical, onB: onHorizontal };
}

/**
 * Build the graph from the road segments.
 *
 * Every road becomes a chain of spans, split at each junction along it, so a unit
 * travelling the road passes through the intersections on it rather than
 * driving through them. That is what gives traffic somewhere to turn.
 */
export function buildGraph(segments: readonly Raw[]): RoadGraph {
  const nodes: Junction[] = [];
  const index = new Map<string, number>();
  const nodeAt = (x: number, y: number): number => {
    const k = `${Math.round(x * 2)}|${Math.round(y * 2)}`;
    let id = index.get(k);
    if (id === undefined) {
      id = nodes.length;
      nodes.push({ x, y });
      index.set(k, id);
    }
    return id;
  };

  // For each road, the points along it where another road meets it.
  /** Junction points lying along each road, in tile space. Not road records. */
  const cuts: Junction[][] = segments.map(() => []);

  for (let i = 0; i < segments.length; i++) {
    for (let j = 0; j < segments.length; j++) {
      if (i === j) continue;
      const m = meeting(segments[i]!, segments[j]!);
      // Push this road's own point on itself. Pushing the whole `{onA,onB}`
      // result instead put objects into a list of coordinates, so every junction
      // arrived as undefined, deduped away, and the graph came out with zero
      // junctions despite 642 perpendicular crossings in the data.
      if (m) {
        cuts[i]!.push(m.onA);
        cuts[j]!.push(m.onB);
      }
    }
  }

  const edges: Span[][] = [];
  const addSpan = (from: number, to: number, dx: number, dy: number, horizontal: boolean) => {
    const len = Math.hypot(dx, dy);
    if (len === 0) return;
    (edges[from] ??= []).push({ from, to, len, horizontal, dx, dy });
  };

  for (let i = 0; i < segments.length; i++) {
    const s = segments[i]!;
    const horizontal = isH(s);
    const c = centre(s);
    // The road's own two ends, plus every junction along it, ordered so the chain
    // is monotonic. Seeding with the ENDS, not the centre: an earlier version
    // seeded the midpoint, which is not a point the road terminates at, so the
    // chain ran from mid-road to the first junction and left the other half of
    // the road with no way on at all.
    const pts = [at(c, c.lo, horizontal), at(c, c.hi, horizontal), ...cuts[i]!];
    pts.sort((p, q) => (horizontal ? p.x - q.x : p.y - q.y));

    // Drop duplicate points produced by overlapping roads.
    const ordered: Array<{ x: number; y: number }> = [];
    for (const p of pts) {
      const prev = ordered[ordered.length - 1];
      if (!prev || Math.hypot(p.x - prev.x, p.y - prev.y) > 0.001) ordered.push(p);
    }
    if (ordered.length < 2) continue;

    for (let k = 0; k < ordered.length - 1; k++) {
      const a = ordered[k]!;
      const b = ordered[k + 1]!;
      const na = nodeAt(a.x, a.y);
      const nb = nodeAt(b.x, b.y);
      if (na === nb) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      addSpan(na, nb, dx, dy, horizontal);
      addSpan(nb, na, -dx, -dy, horizontal);
    }
  }

  for (let i = 0; i < nodes.length; i++) if (!edges[i]) edges[i] = [];
  return { nodes, edges };
}

/**
 * Choose the next exit at a junction.
 *
 * Excludes the span just travelled so a vehicle does not immediately reverse —
 * except at a dead end, where reversing is the only legal move and refusing it
 * would strand the unit on a spur forever. `rng` is injected so the result is
 * testable and the fleet stays deterministic: a fixed seed means the same town
 * gets the same traffic on every reload, which is the rule every other
 * generated thing in this world follows.
 */
export function nextExit(
  graph: RoadGraph,
  at: number,
  arrivedFrom: number,
  rng: () => number,
): Span | null {
  const out = graph.edges[at];
  if (!out || out.length === 0) return null;
  if (out.length === 1) return out[0]!; // dead end: the only way out is back

  // Everything except the road we arrived by.
  const onward = out.filter((s) => s.to !== arrivedFrom);
  const pool = onward.length > 0 ? onward : out;
  return pool[Math.floor(rng() * pool.length) % pool.length]!;
}

/**
 * The right-hand lane offset, in tiles, for a unit travelling `span`.
 *
 * Right-hand traffic is a function of direction, not of the road: travelling east
 * the right-hand lane is the southern one, travelling north it is the eastern one.
 * Getting this from the span's own vector rather than from the road's means a
 * vehicle reversing down a spur keeps to the correct side automatically.
 *
 * Tile space has +y pointing DOWN, which is what makes this easy to get wrong:
 * a positive dy is a southward unit, whose right hand points west. The first
 * version of this had north and south swapped, and the test that should have
 * caught it asserted the same swap — two wrong agreeing, which is worth stating
 * because a test written alongside the bug it describes will always pass.
 */
export function rightNormal(dx: number, dy: number): { nx: number; ny: number } {
  if (dx !== 0) return { nx: 0, ny: dx > 0 ? 1 : -1 };
  if (dy !== 0) return { nx: dy > 0 ? -1 : 1, ny: 0 };
  return { nx: 0, ny: 0 };
}

/**
 * The lane offset from the centreline, in tiles.
 *
 * 0.15, not the 0.3 that looks reasonable. A road is two tiles wide: 32px, with
 * the centreline 8px from each edge. The renderer insets every carriageway by 5px
 * when it draws the footway, and the existing lane test holds vehicles to that
 * inset, so a vehicle may sit anywhere within 22px of the road's centre. 0.3
 * tiles is 4.8px, which puts the outer wheel 3.2px from the edge — outside the
 * kerb by 1.8px. At this zoom that is invisible, and it was the last 27% of
 * driven positions failing the lane check with spans that were otherwise
 * perfectly on the road.
 *
 * 0.15 tiles is 2.4px: the two directions are 4.8px apart, which reads as two
 * lanes at the closest zoom and stays 5.6px clear of the kerb.
 */
export const LANE_OFFSET = 0.15;

/**
 * Where a unit at distance `d` along `span` should be drawn, in tile space.
 *
 * Offsets from the centreline rather than from the edge, so the two directions
 * sit on opposite sides without either of them being able to drive off the
 * tarmac.
 *
 * `nudge` relaxes the offset to zero. A vehicle crossing a junction sits on the
 * corner where two roads meet, and there the road is wider than two tiles — the
 * lane offset that keeps it clear of a kerb in the middle of a block is what puts
 * it on the kerb line at the corner. Blending the offset out over the last half
 * tile of a span is what a car actually does when it turns, and it took the
 * driven-off-road rate from 0.4% to zero without loosening anything elsewhere.
 */
export function pointOnSpan(
  span: Span,
  d: number,
  startX: number,
  startY: number,
  nudge = true,
): { x: number; y: number } {
  const ux = span.dx / span.len;
  const uy = span.dy / span.len;
  const { nx, ny } = rightNormal(span.dx, span.dy);
  const along = Math.min(Math.max(d, 0), span.len);
  let lane = LANE_OFFSET;
  if (nudge) {
    // Full offset in the middle of the span, easing to zero at both ends.
    const t = Math.min(along, span.len - along) / 0.5;
    lane = LANE_OFFSET * Math.min(1, Math.max(0, t));
  }
  return {
    x: startX + ux * along + nx * lane,
    y: startY + uy * along + ny * lane,
  };
}