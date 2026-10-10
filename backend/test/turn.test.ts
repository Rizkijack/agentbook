import { describe, it, expect } from "vitest";
import { createInitialWorld } from "../src/world.js";
import { runTurn, applyDecision } from "../src/turn.js";
import { createBrain } from "../src/brain.js";
import { RESIDENT_ACTS, RELATIONSHIP_CAP, pruneRelationships } from "@slopagentbook/shared";

describe("turn neighborhood timing (M5)", () => {
  it("runTurn keeps the pre-decide neighborhood while an async brain is deciding", async () => {
    const world = createInitialWorld();
    const agent = world.herd[0]!;
    const other = world.herd[1]!;
    other.mind.doing.place = agent.mind.doing.place; // neighbour stands next to the agent
    agent.mind.spirits = 0.5;

    const brain = createBrain({
      llm: {
        async decide() {
          // the town keeps moving while the LLM call is in flight
          other.mind.doing.place = "nowhere-nearby";
          return { act: "talk", place: agent.mind.doing.place, reason: "testing timing", speech: "hi" };
        },
      },
    });

    await runTurn(world, agent.id, brain);

    // talk with company drifts spirits +0.04. Because the neighborhood was captured
    // before decide, `other` still counts as nearby even though it moved away during
    // the await — recomputing after decide would skip the drift (the M5 deviation).
    expect(agent.mind.spirits).toBeCloseTo(0.54, 5);
  });

  it("applyDecision without opts.nearbyIds computes the neighborhood at apply time (gateway path)", () => {
    const world = createInitialWorld();
    const agent = world.herd[0]!;
    const other = world.herd[1]!;
    other.mind.doing.place = agent.mind.doing.place;
    agent.mind.spirits = 0.5;

    applyDecision(world, agent, { act: "talk", place: agent.mind.doing.place, reason: "gateway" }, { secs: 18 });

    expect(agent.mind.spirits).toBeCloseTo(0.54, 5);
  });
});

// The gateway refuses a bad verb with 400, but the scheduler shares this same
// choke point and feeds it brain.decide() — whose LLM branch returns an
// unvalidated `act: string` straight from the model. These cover that path:
// a hallucinated verb must degrade to "wander", never reach shared state, and
// never throw (one bad model reply must not stall the town).
describe("applyDecision act allowlist (sim/LLM path)", () => {
  it("coerces an unknown verb to wander instead of persisting it", () => {
    const world = createInitialWorld();
    const agent = world.herd[0]!;

    const result = applyDecision(
      world,
      agent,
      { act: "teleport", place: "square", reason: "hallucinated verb" },
      { secs: 18 },
    );

    expect(agent.mind.doing.act).toBe("wander");
    // the broadcast payload carries the coerced verb, not the model's string
    expect(result.order?.act).toBe("wander");
    expect(JSON.stringify(result)).not.toContain("teleport");
  });

  it("does not throw on an unknown verb — the town keeps turning", () => {
    const world = createInitialWorld();
    const agent = world.herd[0]!;
    expect(() =>
      applyDecision(world, agent, { act: "asdfgh", place: "square", reason: "junk" }, { secs: 18 }),
    ).not.toThrow();
    expect(agent.mind.doing.act).toBe("wander");
  });

  it("passes every known verb through unchanged", () => {
    for (const act of RESIDENT_ACTS) {
      const world = createInitialWorld();
      const agent = world.herd[0]!;
      const result = applyDecision(world, agent, { act, place: "square", reason: "ok" }, { secs: 18 });
      expect(agent.mind.doing.act, `act=${act}`).toBe(act);
      expect(result.order?.act, `act=${act}`).toBe(act);
    }
  });

  it("runTurn sanitises a hallucinated verb end to end", async () => {
    const world = createInitialWorld();
    const agent = world.herd[0]!;

    const brain = createBrain({
      llm: {
        async decide() {
          return { act: "ascend", place: "square", reason: "the model invented this" };
        },
      },
    });

    const result = await runTurn(world, agent.id, brain);
    expect(agent.mind.doing.act).toBe("wander");
    expect(result.order?.act).toBe("wander");
  });

  it("a rejected verb drives no need delta, so tickNeeds cannot be reached with it", () => {
    const world = createInitialWorld();
    const agent = world.herd[0]!;
    agent.needs = { hunger: 0.5, thirst: 0.5, tired: 0.5, lonely: 0.5 };
    // "sleep" is the only verb with a big tired reduction (-0.15). wander has no
    // tired delta beyond drift, so if the allowlist leaked, tired would drop far
    // more than drift alone accounts for.
    applyDecision(world, agent, { act: "sleep", place: "square", reason: "real verb" }, { secs: 18 });
    const realDelta = 0.5 - agent.needs.tired;

    const w2 = createInitialWorld();
    const a2 = w2.herd[0]!;
    a2.needs = { hunger: 0.5, thirst: 0.5, tired: 0.5, lonely: 0.5 };
    applyDecision(w2, a2, { act: "not-a-verb", place: "square", reason: "junk" }, { secs: 18 });
    const junkDelta = 0.5 - a2.needs.tired;

    expect(realDelta).toBeGreaterThan(junkDelta + 0.1);
  });
});

// The relationship map only grows - nothing ever removes an entry - so it
// reached one pair per herd member (53% of a resident's JSON at n=77). These
// pin the cap: strongest ties survive, the map cannot pass the cap, and a pruned
// pair reads as 0 rather than breaking a lookup.
describe("relationship map cap", () => {
  it("keeps the strongest ties and drops the noise", () => {
    const world = createInitialWorld();
    const agent = world.herd[0]!;
    // one clear friend, one clear enemy, and a crowd of negligible ties
    agent.mind.relationships = {};
    for (let i = 0; i < 60; i++) agent.mind.relationships["noise-" + i] = 0.001;
    agent.mind.relationships["best-friend"] = 0.95;
    agent.mind.relationships["worst-enemy"] = -0.88;

    applyDecision(world, agent, { act: "talk", place: "square", reason: "chat" }, { secs: 18 });

    const rel = agent.mind.relationships;
    expect(Object.keys(rel).length).toBeLessThanOrEqual(RELATIONSHIP_CAP);
    expect(rel["best-friend"]).toBeCloseTo(0.95, 2);
    // magnitude, not sign: the enemy is kept too
    expect(rel["worst-enemy"]).toBeCloseTo(-0.88, 2);
    // 62 entries in, 16 kept: both strong ties plus 14 of the 60 negligible ones
    expect(Object.keys(rel).filter((k) => k.startsWith("noise-")).length).toBe(RELATIONSHIP_CAP - 2);
  });

  it("cannot exceed the cap across many decisions", () => {
    const world = createInitialWorld();
    const agent = world.herd[0]!;
    for (let turn = 0; turn < 300; turn++) {
      // chat at the square, so new peers keep appearing in the map
      applyDecision(
        world, agent,
        { act: "talk", place: "square", reason: "loop", speech: "hi " + turn },
        { secs: 18 },
      );
      expect(Object.keys(agent.mind.relationships).length).toBeLessThanOrEqual(RELATIONSHIP_CAP);
    }
  });

  it("a pruned neighbour still reads as 0 instead of breaking a lookup", () => {
    const map: Record<string, number> = { kept: 0.9 };
    pruneRelationships({ relationships: map });
    expect(map.kept).toBeCloseTo(0.9, 5);
    expect(map["never-met"] ?? 0).toBe(0);
  });

  it("leaves a small map byte-identical", () => {
    const world = createInitialWorld();
    const agent = world.herd[0]!;
    agent.mind.relationships = { a: 0.5, b: -0.5 };
    const before = JSON.stringify(agent.mind.relationships);
    pruneRelationships(agent.mind);
    expect(JSON.stringify(agent.mind.relationships)).toBe(before);
  });
});
