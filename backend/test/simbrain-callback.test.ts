import { describe, it, expect } from "vitest";
import { decide, type DecideContext } from "../src/simbrain.js";

// Callbacks are the cheapest coherence available: the resident quotes back a line
// they actually remember about the person in front of them, instead of picking
// from a fixed pool that never acknowledges the past.
//
// decide() walks the whole NPC_SKILLS chain before reaching generateSpeech, so
// these run it many times over a deterministic rng sweep rather than trying to
// aim a single roll at the callback branch.

const baseSelf = {
  id: "me", name: "Vetch", traits: [] as string[], job: "herder",
  obsession: "the station timetable", spirits: 0,
  relationships: {} as Record<string, number>,
};

function ctx(memories: string[]): DecideContext {
  return {
    needs: { hunger: 0, thirst: 0, tired: 0, lonely: 0.9 },
    clock: 0.5,
    location: "square",
    nearbyAgents: ["brindle"],
    rng: () => 0,
    self: { ...baseSelf, memories },
    nearbyDetailed: [
      { id: "brindle", name: "Brindle", handle: "@brindle", relationship: 0.6 },
    ],
  } as DecideContext;
}

/** Sweep the rng so every template and branch is exercised across the run. */
function sweep(memories: string[], runs = 240) {
  const out: string[] = [];
  for (let i = 0; i < runs; i++) {
    const c = ctx(memories);
    let n = 0;
    c.rng = () => ((i * 7 + n++ * 13) % 100) / 100;
    const d = decide(c);
    if (d.speech) out.push(d.speech);
  }
  return out;
}

describe("simbrain callbacks", () => {
  it("quotes a remembered line back to the person it names", () => {
    const said = sweep(["heard Brindle talking about the pond deed at the tavern"]);
    const hits = said.filter((s) => s.includes("pond deed"));
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((s) => s.includes("Brindle"))).toBe(true);
  });

  it("does not quote a memory to someone it is not about", () => {
    // the resident remembers this line, but nothing in it names Brindle — quoting
    // it at them would put words in their mouth
    const said = sweep(["the cart is late."]);
    expect(said.filter((s) => s.includes("the cart is late"))).toEqual([]);
    expect(said.filter((s) => s.includes('"'))).toEqual([]);
  });

  it("says nothing to quote when the resident remembers nothing", () => {
    const said = sweep([]);
    expect(said.filter((s) => s.includes('"'))).toEqual([]);
  });

  it("strips quotes out of a remembered line so the template stays balanced", () => {
    const said = sweep(['Brindle said "the cart is late" and meant it']);
    for (const s of said) {
      if (!s.includes("cart is late")) continue;
      expect((s.match(/"/g) ?? []).length % 2, `unbalanced quotes in: ${s}`).toBe(0);
    }
  });

  it("never leaks a raw template placeholder", () => {
    for (const memories of [["Brindle at the tavern"], ["Brindle again, honestly"], []]) {
      for (const s of sweep(memories, 120)) {
        expect(s).not.toMatch(/\{(said|name|place|obsession)\}/);
      }
    }
  });

  it("is rarer than ordinary talk — a callback is an event, not the default", () => {
    const callbacks = sweep(["heard Brindle talking about the pond deed"]).filter((s) =>
      s.includes("pond deed"),
    ).length;
    const all = sweep(["heard Brindle talking about the pond deed"]).length;
    expect(callbacks).toBeGreaterThan(0);
    expect(callbacks).toBeLessThan(all);
  });
});