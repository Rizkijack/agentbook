import { describe, it } from "vitest";
import { VEHICLES, tickScenery } from "../src/canvas/scenery.js";

// Frame cost for the vehicle simulation, measured rather than assumed.
//
// This exists because the 738 per-road loop routes have never been timed. Every
// vehicle walked its own four-point rectangle and the per-frame work was
// "however many vehicles there are", which was fine at 16 and not obviously
// fine at 738. The runtime graph routing that replaces it has to be shown to be
// cheaper, and this is the number that shows it.
//
// Not an assertion on purpose: a hard threshold here would flake on whatever
// machine runs it. Run it, read the numbers, judge.

function bench(label: string, frames = 600): void {
  // Warm up so JIT compilation is not counted as simulation cost.
  for (let i = 0; i < 60; i++) tickScenery(1 / 60, i / 60);
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < frames; i++) tickScenery(1 / 60, i / 60);
  const t1 = process.hrtime.bigint();
  const perFrameUs = Number(t1 - t0) / 1000 / frames;
  console.log(
    `  ${label.padEnd(34)} ${VEHICLES.length.toString().padStart(4)} vehicles  ` +
      `${perFrameUs.toFixed(1).padStart(7)} us/frame  ` +
      `${(perFrameUs / VEHICLES.length).toFixed(2).padStart(5)} us/vehicle  ` +
      `budget 16667us = ${((perFrameUs / 16667) * 100).toFixed(2)}%`,
  );
}

describe("vehicle frame cost", () => {
  it("measures", () => {
    console.log("");
    bench("graph routing, 150 units");
    console.log("");
  });
});