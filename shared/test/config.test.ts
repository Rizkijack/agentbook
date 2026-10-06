import { describe, it, expect } from "vitest";
import { DAY_LENGTH_SEC, dayClock, dayOfYear } from "../src/config.js";

/**
 * These are the single-source-of-truth guards for 08 §6.1: the day length used
 * to be duplicated across seven files (backend needs/turn/gateway x2, mcp tools,
 * canvas engine, TownView) and only agreed by coincidence. If any of these fail,
 * the canvas clock and the server clock have drifted apart again.
 */
describe("day length is single-sourced", () => {
  it("exposes a 900-second in-game day", () => {
    expect(DAY_LENGTH_SEC).toBe(900);
  });

  it("spans exactly one 15-minute real day per in-game day", () => {
    expect(DAY_LENGTH_SEC / 60).toBe(15);
  });
});

describe("dayClock", () => {
  it("is a pure function of the supplied timestamp", () => {
    expect(dayClock(123456789)).toBe(dayClock(123456789));
  });

  it("starts at 0 at the epoch", () => {
    expect(dayClock(0)).toBe(0);
  });

  it("reports midday at half a day length", () => {
    expect(dayClock(DAY_LENGTH_SEC * 1000 * 0.5)).toBeCloseTo(0.5, 10);
  });

  it("stays within [0, 1) for arbitrary times", () => {
    for (const ms of [1, 999, 899_000, 899_999, 1_000_000, 1_700_000_000_000, 1_735_689_600_000]) {
      const c = dayClock(ms);
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThan(1);
    }
  });

  it("wraps exactly one day later", () => {
    const base = 5_000_000;
    expect(dayClock(base + DAY_LENGTH_SEC * 1000)).toBeCloseTo(dayClock(base), 10);
  });

  it("honours an overridden day length", () => {
    expect(dayClock(1_500_000, 2_000)).toBeCloseTo(0.75, 10);
  });
});

describe("dayOfYear", () => {
  it("starts at day 1", () => {
    expect(dayOfYear(0)).toBe(1);
  });

  it("stays within 1..365", () => {
    for (const ms of [0, 1_000_000, 1_700_000_000_000, 1_735_689_600_000]) {
      const d = dayOfYear(ms);
      expect(d).toBeGreaterThanOrEqual(1);
      expect(d).toBeLessThanOrEqual(365);
    }
  });

  it("advances to the next day after one full day length", () => {
    expect(dayOfYear(0)).toBe(1);
    expect(dayOfYear(DAY_LENGTH_SEC * 1000)).toBe(2);
    // and the 365-day calendar wraps back to day 1
    expect(dayOfYear(DAY_LENGTH_SEC * 1000 * 365)).toBe(1);
  });
});
