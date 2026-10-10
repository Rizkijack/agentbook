import { describe, it } from "vitest";
import { LOCATIONS } from "../src/canvas/locationsData.js";
import { Pe, vt } from "../src/canvas/constants.js";
import { DISTRICT_PARCELS, FOREST_ZONES, GROVE_SPECS } from "@slopagentbook/shared";
import { TREES, HOMES, FORESTS } from "../src/canvas/scenery.js";

describe("built-vs-green measurement", () => {
  it("reports", () => {
    const TREE_TILES = 4; // a tree canopy covers roughly this many tiles
    const inParcel = (x, y, p) =>
      x >= p.x && x < p.x + p.w && y >= p.y && y < p.y + p.h;

    const builtPerParcel = DISTRICT_PARCELS.map((p) => {
      let named = 0;
      for (const l of LOCATIONS) {
        const cx = l.x + l.w / 2, cy = l.y + l.h / 2;
        if (!inParcel(cx, cy, p)) continue;
        named += l.w * l.h;
      }
      let houses = 0;
      for (const h of HOMES) {
        if (!inParcel(h.x + h.w / 2, h.y + h.h / 2, p)) continue;
        houses += h.w * h.h;
      }
      let trees = 0;
      for (const t of TREES) {
        if (!inParcel(Math.floor(t.x / 16), Math.floor(t.y / 16), p)) continue;
        trees++;
      }
      let grove = 0;
      for (const g of FORESTS) {
        if (!g.name.endsWith("Grove")) continue;
        const ox = Math.max(p.x, g.x), oy = Math.max(p.y, g.y);
        const ox2 = Math.min(p.x + p.w, g.x + g.w), oy2 = Math.min(p.y + p.h, g.y + g.h);
        if (ox2 > ox && oy2 > oy) grove += (ox2 - ox) * (oy2 - oy);
      }
      return { name: p.name, plot: p.w * p.h, named, houses, trees, grove };
    });

    const rows = builtPerParcel.map((r) => {
      const built = r.named + r.houses;
      const green = r.grove + r.trees * TREE_TILES;
      const total = built + green;
      return `    ${r.name.padEnd(20)} plot ${String(r.plot).padStart(6)}  built ${((built / r.plot) * 100).toFixed(1).padStart(5)}%  green ${((green / r.plot) * 100).toFixed(1).padStart(5)}%  houses ${String(r.houses ? Math.round(r.houses / 15) : 0).padStart(3)}  trees ${String(r.trees).padStart(3)}  grove ${String(r.grove).padStart(4)}`;
    });

    const plot = builtPerParcel.reduce((a, r) => a + r.plot, 0);
    const built = builtPerParcel.reduce((a, r) => a + r.named + r.houses, 0);
    const green = builtPerParcel.reduce((a, r) => a + r.grove + r.trees * TREE_TILES, 0);
    const groveSpecs = GROVE_SPECS.length;

    console.log([
      `  named locations   ${LOCATIONS.length}`,
      `  decorative homes  ${HOMES.length}`,
      `  trees             ${TREES.length}`,
      `  forest zones      ${FOREST_ZONES.length} (${FORESTS.length - groveSpecs} of them wilderness, ${groveSpecs} parcel groves)`,
      ``,
      `  target: built should outweigh green across the district parcels`,
      `  parcel built ${built} / green ${green}`,
      `  = ${((built / (built + green)) * 100).toFixed(1)}% built, ${((green / (built + green)) * 100).toFixed(1)}% green`,
      ``,
      `  per parcel:`,
      ...rows,
      `  parcels with no grove: ${builtPerParcel.filter((r) => r.grove === 0).map((r) => r.name).join(", ") || "none"}`,
      `  parcels with no trees: ${builtPerParcel.filter((r) => r.trees === 0).map((r) => r.name).join(", ") || "none"}`,
      `  parcels with no houses: ${builtPerParcel.filter((r) => r.houses === 0).map((r) => r.name).join(", ") || "none"}`,
    ].join("\n"));
  });
});