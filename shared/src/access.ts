/**
 * Access spurs — the short piece of ground between a building and the street.
 *
 * Why this exists, measured rather than assumed. 41 of the 87 built locations do
 * not front a major street: their nearest road tile is up to 30 tiles away. That
 * is not a cosmetic gap. PAVED is computed as "within PAVE_REACH (8) tiles of a
 * road or a footprint", so a building 12 tiles from tarmac sits alone on grass
 * and the district around it reads as a field with sheds in it. Raising
 * PAVE_REACH was rejected for the same reason before: it paints the whole
 * parcel grey and the void comes back one step further out.
 *
 * The honest fix is the one a town actually has. Every building gets a driveway
 * to the nearest carriageway, so the pavement bake has something to grow along
 * and the map reads as buildings joined by lanes rather than scattered on grass.
 *
 * Two properties make this safe to derive instead of hand-authoring 73 more
 * segments in mapdata.ts:
 *
 *  - It is pure and deterministic. Same roads plus same locations gives the same
 *    spurs, every time, so a regeneration is a no-op and a diff is meaningful.
 *  - A spur always starts ON a road tile, so it cannot orphan: the network gate
 *    in the emitter already proves reachability and these inherit it.
 *
 * The L-shape is deliberate. A spur runs along the street's own axis and then
 * turns once to meet the building, because that is what a driveway off a grid
 * looks like, and a single diagonal would cut across front gardens at an angle
 * that reads as a mistake rather than as a road.
 */

export interface AccessSpur {
  readonly building: string;
  /** The tile on the carriageway the spur leaves from. */
  readonly x1: number;
  readonly y1: number;
  /** The tile on the building's edge the spur arrives at. */
  readonly x2: number;
  readonly y2: number;
}

/** Minimal shape both the roads and the locations satisfy. */
interface Rect { readonly x: number; readonly y: number; readonly w: number; readonly h: number }
interface Seg { readonly x1: number; readonly y1: number; readonly x2: number; readonly y2: number }

/**
 * The nearest point of segment `s` to rectangle `r`, and that distance.
 * Clamping the segment's own endpoints onto the rect is what makes this correct
 * for a segment that starts inside and runs away, which every long road does.
 */
function nearestOnSeg(s: Seg, r: Rect): { x: number; y: number; d: number } {
  const rx2 = r.x + r.w - 1;
  const ry2 = r.y + r.h - 1;
  const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

  // A point of the segment that already lies on the rect: distance zero, and
  // the point itself is the answer.
  if (s.x1 >= r.x && s.x1 <= rx2 && s.y1 >= r.y && s.y1 <= ry2) return { x: s.x1, y: s.y1, d: 0 };
  if (s.x2 >= r.x && s.x2 <= rx2 && s.y2 >= r.y && s.y2 <= ry2) return { x: s.x2, y: s.y2, d: 0 };

  // Axis-aligned segments only, which is all ROAD_SEGMENTS holds. So the gap is
  // horizontal or vertical, never diagonal, and the nearest point is whichever
  // end of the segment lies inside the other's span.
  const sLo = Math.min(s.x1, s.x2);
  const sHi = Math.max(s.x1, s.x2);
  const tLo = Math.min(s.y1, s.y2);
  const tHi = Math.max(s.y1, s.y2);

  const dx = Math.max(r.x - sHi, sLo - rx2, 0);
  const dy = Math.max(r.y - tHi, tLo - ry2, 0);
  const d = Math.hypot(dx, dy);

  if (dx !== 0 && dy !== 0) {
    // Corner to corner: the point is the segment end nearest that corner.
    const nearX = s.x1 <= s.x2 ? sLo : sHi;
    const nearY = s.y1 <= s.y2 ? tLo : tHi;
    return { x: nearX, y: nearY, d };
  }
  if (dx !== 0) return { x: dx > 0 ? sLo : sHi, y: clamp(s.y1, r.y, ry2), d };
  return { x: clamp(s.x1, r.x, rx2), y: dy > 0 ? tLo : tHi, d };
}

/**
 * Build the access spurs for the built locations.
 *
 * `frontageGap` is the distance from a building to the nearest carriageway. A
 * building already at gap 0 needs nothing. Food and Water locations are fields,
 * meadows and ponds — a driveway to a wheat field is wrong, so they are skipped
 * the same way the pavement bake skips them.
 */
export function accessSpurs(
  roads: readonly Seg[],
  locations: readonly (Rect & { readonly id: string; readonly category?: string })[],
  opts: { readonly frontageGap?: number } = {},
): AccessSpur[] {
  // Longest gap still worth a driveway. Past this the building is in open
  // country and a lane across the fields would be a new road, not an access.
  const gap = opts.frontageGap ?? 30;
  const out: AccessSpur[] = [];

  for (const l of locations) {
    if (l.category === "Food" || l.category === "Water") continue;

    let best: { x: number; y: number; d: number } | null = null;
    for (const s of roads) {
      const n = nearestOnSeg(s, l);
      if (!best || n.d < best.d) best = n;
    }
    // A building nobody can drive to is not a building in a town; one far out in
    // the fields is a farm, and gets no spur rather than a lane across a meadow.
    if (!best || best.d === 0 || best.d > gap) continue;

    // Aim at the face of the building the approach comes from, not its centre,
    // so the spur ends at a door rather than in the middle of a wall.
    const rx2 = l.x + l.w - 1;
    const ry2 = l.y + l.h - 1;
    const fromLeft = best.x < l.x;
    const fromRight = best.x > rx2;
    const fromAbove = best.y < l.y;
    const fromBelow = best.y > ry2;

    const endX = fromLeft ? l.x : fromRight ? rx2 : Math.round((l.x + rx2) / 2);
    const endY = fromAbove ? l.y : fromBelow ? ry2 : Math.round((l.y + ry2) / 2);

    // One turn, on the street's own axis first. Two segments, because a RoadRect
    // is a single run and an L has to be two of them; the caller draws both.
    if (fromLeft || fromRight) {
      out.push({ building: l.id, x1: best.x, y1: best.y, x2: endX, y2: best.y });
      out.push({ building: l.id, x1: endX, y1: best.y, x2: endX, y2: endY });
    } else {
      out.push({ building: l.id, x1: best.x, y1: best.y, x2: best.x, y2: endY });
      out.push({ building: l.id, x1: best.x, y1: endY, x2: endX, y2: endY });
    }
  }

  return out;
}

/**
 * Drop the zero-length halves. An L whose two legs share an axis produces a
 * second segment of length 0, and a zero-length RoadRect still marks its one
 * tile — harmless but it inflates the count and makes a diff lie.
 */
export function pruneDegenerate(spurs: readonly AccessSpur[]): AccessSpur[] {
  return spurs.filter((s) => s.x1 !== s.x2 || s.y1 !== s.y2);
}