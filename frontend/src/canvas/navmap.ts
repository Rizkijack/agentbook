import { LOCATIONS } from "./locationsData.js";
import { Pe, vt } from "./constants.js";
import { ROADS } from "./scenery.js";
import type { GameMapLike } from "./pf.js";

/**
 * The town's collision/navigation map — a lazy singleton over the 210×128 tile
 * grid, handed to `pf()` for every path request.
 *
 * Rules (see build()):
 *  1. everything outside the world is solid;
 *  2. every LOCATIONS footprint is solid, except the `square`, which is open
 *     gathering ground rather than a building (it is the primary contest
 *     venue — walling it would bottle-neck every audience behind one door);
 *  3. inside a solid footprint only the arrival tiles are walkable: the
 *     `spot` tile, the door tile (bottom-centre of the footprint), and the
 *     straight corridor that joins the two when the spot sits inside it;
 *  4. the pond body is solid — its `spot` gets the same treatment, plus an
 *     island-fix corridor (step 5) because the pond's own door dead-ends
 *     against the dock footprint;
 *  5. flood-fill from open ground: any `spot` the fill cannot reach gets a
 *     straight corridor to the nearest reachable tile. Without this, a spot
 *     is an island A* can never enter — `pf()` exempts the goal tile from the
 *     solid check but still has to expand a walkable neighbour of it, so an
 *     island goal silently returns no path at all;
 *  6. `at()` reports road tiles as type 2 so A* prefers asphalt (cost 1.0)
 *     over grass (1.45), matching the weight table in pf.ts.
 */
export class NavMap implements GameMapLike {
  private readonly solidGrid: Uint8Array;
  /** 1 when the tile can be reached from open ground (spots get corridors). */
  private readonly reachGrid: Uint8Array;
  private readonly roadGrid: Uint8Array;

  constructor() {
    const n = Pe * vt;
    const solid = new Uint8Array(n);
    const cov = new Uint8Array(n); // inside any blocked footprint
    const road = new Uint8Array(n);
    const mark = (arr: Uint8Array, x: number, y: number) => {
      if (x >= 0 && y >= 0 && x < Pe && y < vt) arr[y * Pe + x] = 1;
    };
    const carve = (x: number, y: number) => {
      if (x >= 0 && y >= 0 && x < Pe && y < vt) solid[y * Pe + x] = 0;
    };

    // 2. footprints (the square stays open ground)
    for (const loc of LOCATIONS) {
      if (OPEN_GROUND_IDS.has(loc.id)) continue;
      for (let y = loc.y; y < loc.y + loc.h; y++) {
        for (let x = loc.x; x < loc.x + loc.w; x++) {
          mark(solid, x, y);
          mark(cov, x, y);
        }
      }
    }

    // 3/4. arrival tiles: spot, door, and the door↔spot corridor
    for (const loc of LOCATIONS) {
      if (OPEN_GROUND_IDS.has(loc.id)) continue;
      const [sx, sy] = loc.spot;
      const dx = loc.x + (loc.w >> 1);
      const dy = loc.y + loc.h - 1; // door = bottom-centre of the footprint
      carve(sx, sy);
      carve(dx, dy);
      const spotInside = sx >= loc.x && sx < loc.x + loc.w && sy >= loc.y && sy < loc.y + loc.h;
      if (!spotInside) continue;
      for (let y = Math.min(sy, dy); y <= Math.max(sy, dy); y++) carve(dx, y);
      for (let x = Math.min(sx, dx); x <= Math.max(sx, dx); x++) carve(x, sy);
    }

    // 6. roads (they never overlap a footprint — scenery.test.ts guards that)
    for (const r of ROADS) {
      for (let y = r.y1; y <= r.y2; y++) {
        for (let x = r.x1; x <= r.x2; x++) mark(road, x, y);
      }
    }

    this.solidGrid = solid;
    this.roadGrid = road;
    this.reachGrid = floodReach(solid, cov);

    // 5. island-fix: every spot must be reachable from open ground
    for (let pass = 0; pass < 4; pass++) {
      const reach = this.reachGrid;
      let fixed = false;
      for (const loc of LOCATIONS) {
        const [sx, sy] = loc.spot;
        if (this.reachable(sx, sy)) continue;
        const t = this.nearestReachable(sx, sy);
        if (!t) continue;
        for (let y = Math.min(sy, t.y); y <= Math.max(sy, t.y); y++) carve(sx, y);
        for (let x = Math.min(sx, t.x); x <= Math.max(sx, t.x); x++) carve(x, t.y);
        reach.fill(0);
        floodFillInto(solid, cov, reach);
        fixed = true;
      }
      if (!fixed) break;
    }
  }

  /** Tile type for A*: 2 = road (cheap), 0 = grass. */
  at(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= Pe || y >= vt) return 0;
    return this.roadGrid[y * Pe + x]! ? 2 : 0;
  }

  /** World bounds are solid too — the edge of the map is a wall. */
  solid(x: number, y: number): boolean {
    if (x < 0 || y < 0 || x >= Pe || y >= vt) return true;
    return this.solidGrid[y * Pe + x] === 1;
  }

  walkable(x: number, y: number): boolean {
    return !this.solid(x, y);
  }

  /** Reachable from open ground (a corridor may have made a spot walkable). */
  reachable(x: number, y: number): boolean {
    if (x < 0 || y < 0 || x >= Pe || y >= vt) return false;
    return this.reachGrid[y * Pe + x] === 1;
  }

  /**
   * Nearest tile an agent can actually path from/to: walkable *and* reachable,
   * searched ring by ring (north first on ties). Used to sanitise both ends of
   * every `pf()` call, so a path never starts or ends inside a wall.
   */
  nearestWalkable(x: number, y: number): { x: number; y: number } {
    const cx = Math.max(0, Math.min(Pe - 1, x));
    const cy = Math.max(0, Math.min(vt - 1, y));
    if (this.reachable(cx, cy)) return { x: cx, y: cy };
    for (let r = 1; r <= 64; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const nx = cx + dx;
          const ny = cy + dy;
          if (this.reachable(nx, ny)) return { x: nx, y: ny };
        }
      }
    }
    return { x: cx, y: cy };
  }

  /** Nearest tile the flood fill reached — the anchor for island corridors. */
  private nearestReachable(x: number, y: number): { x: number; y: number } | null {
    for (let r = 1; r <= 64; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          if (this.reachable(x + dx, y + dy)) return { x: x + dx, y: y + dy };
        }
      }
    }
    return null;
  }
}

/** The square is plaza, not a building: residents gather on it, not in it. */
const OPEN_GROUND_IDS = new Set(["square"]);

/** 4-dir flood over walkable tiles, seeded from every walkable open-ground tile. */
function floodReach(solid: Uint8Array, cov: Uint8Array): Uint8Array {
  const reach = new Uint8Array(solid.length);
  floodFillInto(solid, cov, reach);
  return reach;
}

function floodFillInto(solid: Uint8Array, cov: Uint8Array, reach: Uint8Array): void {
  const queue: number[] = [];
  for (let i = 0; i < solid.length; i++) {
    if (solid[i] === 0 && cov[i] === 0) {
      reach[i] = 1;
      queue.push(i);
    }
  }
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head]!;
    const x = i % Pe;
    const y = (i - x) / Pe;
    if (x > 0 && reach[i - 1] === 0 && solid[i - 1] === 0) { reach[i - 1] = 1; queue.push(i - 1); }
    if (x < Pe - 1 && reach[i + 1] === 0 && solid[i + 1] === 0) { reach[i + 1] = 1; queue.push(i + 1); }
    if (y > 0 && reach[i - Pe] === 0 && solid[i - Pe] === 0) { reach[i - Pe] = 1; queue.push(i - Pe); }
    if (y < vt - 1 && reach[i + Pe] === 0 && solid[i + Pe] === 0) { reach[i + Pe] = 1; queue.push(i + Pe); }
  }
}

let cached: NavMap | null = null;

/** Lazy singleton — the grid is built once, on the first path request. */
export function navmap(): NavMap {
  if (!cached) cached = new NavMap();
  return cached;
}
