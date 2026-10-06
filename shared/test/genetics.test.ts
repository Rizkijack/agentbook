import { describe, it, expect } from "vitest";
import { Hc, rf, encodeGenes, HairCuts } from "../src/genetics.js";

describe("Genetics Hc decoder", () => {
  it("decodes 9-seg DNA", () => {
    const g = Hc("2.1.0.3.1.42.55.62.1");
    expect(g.wool).toBe(2);
    expect(g.hue).toBe(42);
    expect(g.build).toBeCloseTo(0.55);
    expect(g.neck).toBeCloseTo(0.62);
    expect(g.gen).toBe(1);
  });

  it("round-trips encode", () => {
    const dna = "2.1.0.3.1.42.55.62.1";
    const g = Hc(dna);
    expect(encodeGenes(g)).toBe(dna);
  });

  it("handles missing parts default", () => {
    const g = Hc("1");
    expect(g.cut).toBe(HairCuts[0]);
    expect(g.build).toBe(0.5);
  });
});

describe("rf recombination", () => {
  it("increments gen capped at 9", () => {
    const p = Hc("2.1.0.3.1.42.55.62.9");
    const c = rf(p, "Child");
    expect(c.gen).toBe(9);
    const p8 = Hc("2.1.0.3.1.42.55.62.8");
    expect(rf(p8, "Kid").gen).toBe(9);
  });

  it("mutates hue", () => {
    const p = Hc("2.1.0.3.1.42.55.62.1");
    const c = rf(p, "Marrow Junior");
    expect(c.hue).not.toBe(42);
    expect(c.hue).toBeGreaterThanOrEqual(0);
    expect(c.hue).toBeLessThan(360);
  });

  it("deterministic same name same child", () => {
    const p = Hc("2.1.0.3.1.42.55.62.1");
    const c1 = rf(p, "SameName");
    const c2 = rf(p, "SameName");
    expect(c1).toEqual(c2);
    expect(rf(p, "OtherName").hue).not.toBe(c1.hue);
  });

  it("build/neck drift clamped 0.1-0.95", () => {
    const p = Hc("0.0.0.0.0.0.90.90.0"); // build 0.9, neck 0.9
    for (let i = 0; i < 20; i++) {
      const c = rf(p, "Test" + i);
      expect(c.build).toBeGreaterThanOrEqual(0.1);
      expect(c.build).toBeLessThanOrEqual(0.95);
      expect(c.neck).toBeGreaterThanOrEqual(0.1);
      expect(c.neck).toBeLessThanOrEqual(0.95);
    }
  });
});
