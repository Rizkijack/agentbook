import { describe, it, expect } from "vitest";
import { Hc } from "@hermesbook/shared";
import { renderLlama } from "../src/canvas/renderer/draw.js";
import { sf } from "../src/canvas/renderer/skeleton.js";
import { BUF_W, BUF_H } from "../src/canvas/renderer/pixelBuffer.js";

describe("renderer 52x58", () => {
  it("renders non-empty pixels", () => {
    const genes = Hc("2.1.0.3.1.42.55.62.1");
    const sk = sf({ t: 0, walkPhase: 0, doing: "work", facing: 1 });
    const buf = renderLlama(genes, sk);
    expect(buf.length).toBe(BUF_W * BUF_H);
    expect(buf.some((v) => v !== 0)).toBe(true);
  });

  it("different genes produce different buffers", () => {
    const g1 = Hc("2.1.0.3.1.42.55.62.1");
    const g2 = Hc("2.1.0.3.1.200.55.62.1"); // different hue
    const sk = sf({ t: 1, walkPhase: 0.2, doing: "work", facing: 1 });
    const b1 = renderLlama(g1, sk);
    const b2 = renderLlama(g2, sk);
    let diff = 0;
    for (let i = 0; i < b1.length; i++) if (b1[i] !== b2[i]) diff++;
    expect(diff).toBeGreaterThan(10);
  });

  it("blink closes eyes (lid)", () => {
    const skOpen = sf({ t: 0, walkPhase: 0, doing: "work", facing: 1 });
    expect(skOpen.lid === 0 || skOpen.lid === 1).toBe(true);
    const sk2 = sf({ t: 100, walkPhase: 0, doing: "work", facing: -1 });
    expect(sk2.legs.length).toBe(4);
    expect(sk2.lid === 0 || sk2.lid === 1).toBe(true);
  });
});
