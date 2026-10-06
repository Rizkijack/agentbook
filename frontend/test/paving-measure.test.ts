import { describe, it } from "vitest";
import { LOCATIONS } from "../src/canvas/locationsData.js";
import { Pe, vt } from "../src/canvas/constants.js";
import { ACCESS_SPURS, ROADS, DISTRICT_PARCELS } from "@slopagentbook/shared";
import { PAVED, PAVED_RECTS } from "../src/canvas/scenery.js";

// A measurement, not an assertion — the invariants live in scenery-paving.test.ts.
//
// This exists because the first attempt at fixing "buildings sit on grass" was
// justified by a distance histogram that turned out to answer the wrong question:
// 87 of 87 buildings already touched pavement, because PAVE_REACH is 8 and the
// buildings cluster. What was actually wrong was never measured. Run this to see.

describe("paving measurement", () => {
  it("reports", () => {
    let paved = 0;
    for (const t of PAVED) paved += t;

    // 1. Paved area as a share of each district parcel. A parcel that is mostly
    //    paved is a car park; one that is barely paved is a field with sheds.
    const parcelRows: string[] = [];
    for (const p of DISTRICT_PARCELS) {
      let inside = 0;
      let on = 0;
      for (let y = p.y; y < p.y + p.h; y++) {
        for (let x = p.x; x < p.x + p.w; x++) {
          if (x < 0 || y < 0 || x >= Pe || y >= vt) continue;
          inside++;
          if (PAVED[y * Pe + x]) on++;
        }
      }
      parcelRows.push(`    ${p.name.padEnd(20)} ${((on / inside) * 100).toFixed(1).padStart(5)}% paved`);
    }

    // 2. The largest paved blob that contains NO building. A paved region with
    //    nothing in it is the void defect: tarmac with no reason to exist.
    //    Flood fill from unbuilt paved tiles, keep the biggest.
    const isBuilt = (i: number) => {
      const tx = i % Pe;
      const ty = (i / Pe) | 0;
      for (const l of LOCATIONS) {
        if (tx >= l.x - 1 && tx <= l.x + l.w && ty >= l.y - 1 && ty <= l.y + l.h) return true;
      }
      return false;
    };
    const seen = new Uint8Array(Pe * vt);
    let biggest = 0;
    let biggestAt = "";
    for (let start = 0; start < PAVED.length; start++) {
      if (!PAVED[start] || seen[start]) continue;
      let size = 0;
      let tx = start % Pe;
      let ty = (start / Pe) | 0;
      let hasBuilding = false;
      const stack = [start];
      seen[start] = 1;
      while (stack.length) {
        const i = stack.pop()!;
        size++;
        if (!hasBuilding && isBuilt(i)) hasBuilding = true;
        const x = i % Pe;
        const y = (i / Pe) | 0;
        if (x > 0 && PAVED[i - 1] && !seen[i - 1]) (seen[i - 1] = 1), stack.push(i - 1);
        if (x < Pe - 1 && PAVED[i + 1] && !seen[i + 1]) (seen[i + 1] = 1), stack.push(i + 1);
        if (y > 0 && PAVED[i - Pe] && !seen[i - Pe]) (seen[i - Pe] = 1), stack.push(i - Pe);
        if (y < vt - 1 && PAVED[i + Pe] && !seen[i + Pe]) (seen[i + Pe] = 1), stack.push(i + Pe);
      }
      if (!hasBuilding && size > biggest) {
        biggest = size;
        biggestAt = `${tx},${ty}`;
      }
    }

    // 3. How much of the road network has pavement reaching it at all.
    let roadTiles = 0;
    let roadPaved = 0;
    for (const r of ROADS) {
      for (let y = Math.min(r.y1, r.y2); y <= Math.max(r.y1, r.y2); y++) {
        for (let x = Math.min(r.x1, r.x2); x <= Math.max(r.x1, r.x2); x++) {
          if (x < 0 || y < 0 || x >= Pe || y >= vt) continue;
          roadTiles++;
          if (PAVED[y * Pe + x]) roadPaved++;
        }
      }
    }

    console.log(
      [
        `  paved rects            ${PAVED_RECTS.length}  <- one fillRect each per frame`,
        `  paved tiles            ${paved} (${((paved / (Pe * vt)) * 100).toFixed(2)}% of world)`,
        `  access spur segments   ${ACCESS_SPURS.length}`,
        `  district paving share:`,
        ...parcelRows,
        `  largest building-free paved region  ${biggest} tiles at ${biggestAt || "none"}`,
        `  road tiles that are paved          ${roadPaved}/${roadTiles} (${((roadPaved / roadTiles) * 100).toFixed(1)}%)`,
      ].join("\n"),
    );
  });
});