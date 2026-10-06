import { describe, it, expect } from "vitest";
import { decide } from "../src/simbrain.js";

describe("SimBrain decide", () => {
  it("night + tired >0.3 -> barn", () => {
    const d = decide({ needs: { hunger: 0.2, thirst: 0.2, tired: 0.4, lonely: 0.1 }, clock: 0.8, location: "square", nearbyAgents: [], rng: () => 0.5 });
    expect(d.place).toBe("barn");
    expect(d.act).toBe("sleep");
  });

  it("thirst >0.6 -> pond 60% square 40%", () => {
    let pond = 0, square = 0;
    for (let i = 0; i < 100; i++) {
      const rng = () => (i % 2 === 0 ? 0.3 : 0.8); // 0.3 -> pond, 0.8 -> square
      const d = decide({ needs: { hunger: 0.1, thirst: 0.7, tired: 0.1, lonely: 0.1 }, clock: 0.3, location: "square", nearbyAgents: [], rng });
      if (d.place === "pond") pond++; else if (d.place === "square") square++;
    }
    expect(pond).toBeGreaterThan(40);
    expect(square).toBeGreaterThan(40);
  });

  it("hunger >0.6 -> one of trough/meadowW/meadowE/orchard", () => {
    const opts = new Set(["trough", "meadowW", "meadowE", "orchard"]);
    for (let i = 0; i < 20; i++) {
      const d = decide({ needs: { hunger: 0.8, thirst: 0.1, tired: 0.1, lonely: 0.1 }, clock: 0.3, location: "square", nearbyAgents: [], rng: () => Math.random() });
      expect(opts.has(d.place)).toBe(true);
      expect(d.act).toBe("graze");
    }
  });

  it("lonely -> social places", () => {
    const opts = new Set(["square", "tavern", "hall", "baths", "fire", "market", "board"]);
    for (let i = 0; i < 20; i++) {
      const d = decide({ needs: { hunger: 0.1, thirst: 0.1, tired: 0.1, lonely: 0.8 }, clock: 0.2, location: "square", nearbyAgents: [], rng: () => Math.random() });
      expect(opts.has(d.place)).toBe(true);
    }
  });

  it("returns reason and optional speech", () => {
    const d = decide({ needs: { hunger: 0.1, thirst: 0.1, tired: 0.1, lonely: 0.1 }, clock: 0.2, location: "square", nearbyAgents: [], rng: () => 0.1 });
    expect(d.reason).toBeTruthy();
    expect(typeof d.act).toBe("string");
  });
});
