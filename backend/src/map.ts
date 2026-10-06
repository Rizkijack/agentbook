import { seededRandom, Pe, vt, V, WorldSize, ROADS } from "@slopagentbook/shared";
import { LOCATIONS } from "./locations.js";

// Dimensions live in shared/src/map.ts — the backend and the browser both read
// them from there. They used to be declared here AND hand-copied into
// frontend/src/canvas/constants.ts, and the two drifted the moment the map grew:
// the collision map indexed 210x128 while the tiles it built were 1050x640, so
// every square spot read as unwalkable. backend/test/world.test.ts pins them.
//
// The 42 original locations were TRANSLATED by (+419, +253) to sit at the centre
// of the new grid, never rescaled: their w/h is what NPC_H is derived from, so
// rescaling would have resized every resident in town.
export { Pe, vt, V, WorldSize };

// Tile types: 0 grass, 1 hill, 2 road, 3 path, 11 stone
//
// NOTE: nothing calls createMap() today — pathfinding runs on the frontend's
// navmap, and solid() reports only the world edge. It stays because the tile
// layer is the obvious next thing to build on, and it now derives its roads
// from the shared network instead of three hardcoded corridors that the 5x
// build-out left in open country.
export function createMap(seed = 20260921) {
  const rng = seededRandom(seed);
  const tiles = new Uint8Array(Pe * vt);

  // Simple procedural: hills, from noise-ish rng
  for (let y = 0; y < vt; y++) {
    for (let x = 0; x < Pe; x++) {
      tiles[y * Pe + x] = rng() < 0.08 ? 1 : 0;
    }
  }

  // Water, taken from the Water-category locations rather than guessed at a
  // fraction of the grid width. It used to be a strip at x = Pe * 0.55, which
  // is inside the town once the grid grew — it marked the square as river.
  for (const l of LOCATIONS) {
    if (l.category !== "Water") continue;
    for (let y = l.y; y < l.y + l.h; y++) {
      for (let x = l.x; x < l.x + l.w; x++) {
        if (x >= 0 && x < Pe && y >= 0 && y < vt) tiles[y * Pe + x] = 1;
      }
    }
  }

  // Carve the shared road network so A* has weighted roads to prefer
  for (const r of ROADS) {
    for (let y = r.y1; y <= r.y2; y++) {
      for (let x = r.x1; x <= r.x2; x++) {
        if (x >= 0 && x < Pe && y >= 0 && y < vt) tiles[y * Pe + x] = 2;
      }
    }
  }

  // Stone paths around buildings
  for (const l of LOCATIONS) {
    if (l.category === "Food" || l.category === "Water") continue;
    for (let y = l.y - 1; y <= l.y + l.h; y++) {
      for (let x = l.x - 1; x <= l.x + l.w; x++) {
        if (x < 0 || x >= Pe || y < 0 || y >= vt) continue;
        if ((x + y) % 7 === 0 && tiles[y * Pe + x] === 0) tiles[y * Pe + x] = 3;
      }
    }
  }

  return {
    at(x: number, y: number): number {
      if (x < 0 || x >= Pe || y < 0 || y >= vt) return 1; // solid outside
      return tiles[y * Pe + x] ?? 0;
    },
    solid(x: number, y: number): boolean {
      // tile 1 hill/river is solid? for MVP only outside is solid
      if (x < 0 || x >= Pe || y < 0 || y >= vt) return true;
      return false;
      // allow all traversal but weighted; real solid would be buildings/water
    },
    tiles,
  };
}

export type GameMap = ReturnType<typeof createMap>;
