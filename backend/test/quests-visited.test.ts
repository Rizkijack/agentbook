import { describe, it, expect } from "vitest";
import type { Quest, TownSnapshot } from "@slopagentbook/shared";
import { updateQuestProgress } from "../src/quests.js";

// updateQuestProgress only reads/writes world.quests, so a minimal holder is a
// faithful fixture — and it guarantees this test never touches a saved town
// (data/*.json) the way a full createInitialWorld() round-trip would.
function worldWith(...quests: Quest[]): TownSnapshot {
  return { quests } as unknown as TownSnapshot;
}

function exploreQuest(overrides: Partial<Quest> = {}): Quest {
  return {
    id: "qvisited",
    title: "Town Tour",
    description: "tour the town",
    giver: "lm1",
    giverName: "Vetch",
    type: "explore",
    category: "Exploration",
    targetPlaces: ["garden", "square", "hall", "vault", "dock"],
    progress: 0,
    required: 5,
    reward: { text: "+0.35 spirits" },
    status: "active",
    difficulty: "hard",
    createdAt: Date.now(),
    expiresAt: null,
    ...overrides,
  };
}

function visit(q: Quest, place: string) {
  return updateQuestProgress(worldWith(q), { act: "move", place, agentId: "lm1" });
}

function rawVisited(q: Quest): unknown {
  return (q as unknown as Record<string, unknown>)._visited;
}

function setRawVisited(q: Quest, value: unknown): void {
  (q as unknown as Record<string, unknown>)._visited = value;
}

describe("explore quest _visited survives JSON persistence", () => {
  it("legacy save shape `_visited: {}` does not throw and new places still count", () => {
    // This is the literal shape found in data/town.json: JSON.stringify turns
    // the old runtime Set into `{}`, and `{}.has(...)` used to throw TypeError.
    const q = exploreQuest({ progress: 0 });
    setRawVisited(q, {});

    expect(() => visit(q, "garden")).not.toThrow();
    expect(q.progress).toBe(1);
    expect(rawVisited(q)).toEqual(["garden"]); // healed into a JSON-safe array
    expect(Array.isArray(rawVisited(q))).toBe(true);

    visit(q, "square");
    expect(q.progress).toBe(2);
    expect(rawVisited(q)).toEqual(["garden", "square"]);
  });

  it("array `_visited` from a save: same place is not counted twice, new place is", () => {
    const q = exploreQuest({ progress: 1 });
    setRawVisited(q, ["garden"]);

    // repeat visit → no progress, no completion
    const repeat = visit(q, "garden");
    expect(q.progress).toBe(1);
    expect(repeat).toHaveLength(0);
    expect(rawVisited(q)).toEqual(["garden"]);

    // new place → counted
    visit(q, "square");
    expect(q.progress).toBe(2);
    expect(rawVisited(q)).toEqual(["garden", "square"]);
  });

  it("runtime `Set` still works and is written back as an array", () => {
    const q = exploreQuest({ progress: 1 });
    setRawVisited(q, new Set(["garden"]));

    expect(() => visit(q, "garden")).not.toThrow();
    expect(q.progress).toBe(1); // already visited — not counted again

    visit(q, "square");
    expect(q.progress).toBe(2);
    expect(Array.isArray(rawVisited(q))).toBe(true); // JSON-safe from now on
    expect(rawVisited(q)).toEqual(["garden", "square"]);
  });

  it("progress never regresses when the stored state is corrupt", () => {
    // stored progress ahead of the (empty) visited list — e.g. a save whose
    // `_visited` was lost. A quest near completion must not fall back to 0.
    const q = exploreQuest({ progress: 3, required: 5 });
    setRawVisited(q, []);

    visit(q, "garden");
    expect(q.progress).toBe(3); // max(3, visited.length 1) — not 1, not 0
    expect(q.status).toBe("active");
    expect(rawVisited(q)).toEqual(["garden"]);
  });

  it("completes when the number of distinct places reaches required", () => {
    const q = exploreQuest({
      targetPlaces: ["garden", "square", "hall"],
      required: 3,
      progress: 0,
    });
    setRawVisited(q, {});

    expect(visit(q, "garden")).toHaveLength(0);
    expect(q.progress).toBe(1);
    expect(q.status).toBe("active");

    // duplicate does not count toward completion
    expect(visit(q, "garden")).toHaveLength(0);
    expect(q.progress).toBe(1);

    visit(q, "square");
    expect(q.progress).toBe(2);
    expect(q.status).toBe("active");

    const updated = visit(q, "hall");
    expect(q.progress).toBe(3);
    expect(q.status).toBe("completed");
    expect(q.completedAt).toBeGreaterThan(0);
    expect(updated).toHaveLength(1);
    expect(updated[0]).toBe(q);
    expect(Array.isArray(rawVisited(q))).toBe(true);
  });
});
