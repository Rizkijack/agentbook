import { describe, it, expect } from "vitest";
import type { TownSnapshot } from "@slopagentbook/shared";
import { joinWorld, AgentError } from "../src/agents.js";
import { createInitialWorld } from "../src/world.js";

/**
 * joinWorld and POST /api/fork must apply the same rule: validate the payload
 * first, then the world-state constraint. A full pasture used to answer
 * "the pasture is full" for a duplicate name or a missing parent, which hides
 * the actual problem from the caller (and from the tests).
 *
 * The world here is a throwaway fixture in memory — no file is read or written.
 */
function fullWorld(): TownSnapshot {
  const world = createInitialWorld();
  world.config.maxHerd = world.herd.length; // full, whatever the fixture holds
  return world;
}

const freshName = (tag: string) => `${tag}${Date.now().toString().slice(-6)}`;

describe("joinWorld validates input before capacity", () => {
  it("reports a duplicate name even when the pasture is full", () => {
    const world = fullWorld();
    const taken = world.herd[0]!.name;

    expect(() => joinWorld(world, { name: taken, origin: "vitest" })).toThrow(/taken/);
    expect(world.herd).toHaveLength(world.config.maxHerd); // nothing was added
  });

  it("reports a missing parent even when the pasture is full", () => {
    const world = fullWorld();

    expect(() =>
      joinWorld(world, { name: freshName("Jp"), parent: "nonexistent", origin: "vitest" }),
    ).toThrow(/parent/);
    expect(world.herd[0]!.forks ?? 0).toBe(0); // no forks++ on a rejected join
    expect(world.herd).toHaveLength(world.config.maxHerd);
  });

  it("still reports the capacity error for an otherwise valid payload", () => {
    const world = fullWorld();

    expect(() => joinWorld(world, { name: freshName("Jc"), origin: "vitest" })).toThrow(/pasture/);
    expect(world.herd).toHaveLength(world.config.maxHerd);
    expect(world.agents ?? []).toHaveLength(0); // no token/record leaked on reject
  });

  it("rejects with AgentError, the type the gateway turns into a 400", () => {
    const world = fullWorld();

    expect(() => joinWorld(world, { name: freshName("Je"), origin: "vitest" })).toThrow(
      AgentError,
    );
  });

  it("a join with room still succeeds (capacity is checked, not skipped)", () => {
    const world = createInitialWorld(); // fixture is nowhere near maxHerd
    world.config.maxHerd = world.herd.length + 1;

    const joined = joinWorld(world, { name: freshName("Jr"), origin: "vitest" });

    expect(joined.token).toBeTruthy();
    expect(world.herd).toHaveLength(world.config.maxHerd);
    expect(world.agents).toHaveLength(1);
  });
});
