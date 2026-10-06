import { seededRandom } from "@hermesbook/shared";

// Dimensions per 02:12-20
export const Pe = 210;
export const vt = 128;
export const V = 16;

export const WorldSize = {
  width: Pe * V, // 3360
  height: vt * V, // 2048
};

// Tile types: 0 grass, 1 hill, 2 road, 3 path, 11 stone
export function createMap(seed = 20260921) {
  const rng = seededRandom(seed);
  const tiles = new Uint8Array(Pe * vt);

  // Simple procedural: hills + river + roads
  for (let y = 0; y < vt; y++) {
    for (let x = 0; x < Pe; x++) {
      let t = 0;
      // pseudo hills via noise-ish rng
      if (rng() < 0.08) t = 1;
      // river vertical strip
      if (Math.abs(x - Pe * 0.55) < 2 && rng() < 0.7) t = 1;
      tiles[y * Pe + x] = t;
    }
  }

  // Carve roads between locations (straight Manhattan for MVP)
  // This ensures A* has weighted roads to prefer
  const roads: Array<[number, number, number, number]> = [
    [96, 55, 104, 62], // square area
    [54, 57, 170, 58], // baths to station corridor
    [16, 60, 172, 30], // meadowW to meadowE
  ];
  for (const [x1, y1, x2, y2] of roads) {
    let x = x1, y = y1;
    while (x !== x2 || y !== y2) {
      if (x !== x2) x += Math.sign(x2 - x);
      else if (y !== y2) y += Math.sign(y2 - y);
      if (x >= 0 && x < Pe && y >= 0 && y < vt) tiles[y * Pe + x] = 2;
      // thicken
      if (x + 1 < Pe) tiles[y * Pe + (x + 1)] = 2;
    }
  }

  // Stone paths around buildings
  for (let y = 42; y < 72; y++) {
    for (let x = 80; x < 135; x++) {
      if ((x + y) % 7 === 0 && tiles[y * Pe + x] === 0) tiles[y * Pe + x] = 3;
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
