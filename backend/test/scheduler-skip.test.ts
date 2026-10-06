import { describe, it, expect } from "vitest";
import type { AgentRecord } from "@slopagentbook/shared";
import { createInitialWorld } from "../src/world.js";
import { pickNextSimId, AGENT_AFK_MS } from "../src/agents.js";

/** registry record for a resident under external control */
function externalRecord(residentId: string, lastActAt = Date.now()): AgentRecord {
  return {
    id: "ag" + Math.random().toString(36).slice(2, 10),
    residentId,
    tokenHash: "hash-not-token",
    origin: "vitest",
    joinedAt: Date.now(),
    lastActAt,
  };
}

/** scheduler stub cycling forever over the given ids (mirrors createScheduler rotation) */
function cyclingScheduler(ids: string[]): { next(): string | null } {
  let i = 0;
  return { next: () => ids[i++ % ids.length]! };
}

describe("pickNextSimId — scheduler skip loop", () => {
  it("picks a sim resident (control absent) immediately", () => {
    const world = createInitialWorld();
    const first = world.herd[0]!;
    const picked = pickNextSimId(world, cyclingScheduler([first.id]));
    expect(picked).toBe(first.id);
  });

  it("skips an active external resident and picks the next sim resident", () => {
    const world = createInitialWorld();
    const external = world.herd[0]!;
    const sim = world.herd[1]!;
    external.mind.control = "external";
    world.agents = [externalRecord(external.id)];

    const picked = pickNextSimId(world, cyclingScheduler([external.id, sim.id]));
    expect(picked).toBe(sim.id);
  });

  it("returns null (no crash) when every resident is an active external", () => {
    const world = createInitialWorld();
    world.agents = world.herd.map((h) => {
      h.mind.control = "external";
      return externalRecord(h.id);
    });

    const picked = pickNextSimId(world, cyclingScheduler(world.herd.map((h) => h.id)));
    expect(picked).toBeNull();
  });

  it("picks an external resident whose agent went AFK (sim takes over)", () => {
    const world = createInitialWorld();
    const stale = Date.now() - AGENT_AFK_MS - 1000;
    world.agents = world.herd.map((h) => {
      h.mind.control = "external";
      return externalRecord(h.id, stale);
    });

    const picked = pickNextSimId(world, cyclingScheduler(world.herd.map((h) => h.id)));
    expect(picked).toBe(world.herd[0]!.id);
  });
});
