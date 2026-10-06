import { describe, it, expect } from "vitest";
import { createInitialWorld } from "../src/world.js";
import { runTurn, applyDecision } from "../src/turn.js";
import { createBrain } from "../src/brain.js";

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
