import { describe, it, expect } from "vitest";
import { decide, type DecideContext } from "../src/simbrain.js";
import { createInitialWorld } from "../src/world.js";
import { applyDecision } from "../src/turn.js";
import { LOCATION_BY_ID } from "../src/locations.js";
import { NPC_SKILLS, isNpcSkillId, npcSkillLabel, NPC_ALL_PLACES, NPC_SOCIAL_PLACES, NPC_FOOD_PLACES, NPC_WATER_PLACES, NPC_REST_PLACES, NPC_WORK_PLACES, NPC_JOB_HOMES } from "@slopagentbook/shared";

const CALM = { hunger: 0.1, thirst: 0.1, tired: 0.1, lonely: 0.1 };

function ctxOf(over: Partial<DecideContext>): DecideContext {
  return {
    needs: { ...CALM },
    clock: 0.3,
    location: "square",
    nearbyAgents: [],
    rng: () => 0.5,
    ...over,
  };
}

/** rng returning the given draws in order, repeating the last one forever */
function seq(...vals: number[]): () => number {
  let i = 0;
  return () => vals[Math.min(i++, vals.length - 1)]!;
}

const ruleOf = (id: string) => NPC_SKILLS.find((r) => r.id === id)!;

/** every scenario below: skill id is right AND the reason comes from that rule's data */
function expectSkillAndReason(d: ReturnType<typeof decide>, skillId: string) {
  expect(d.skill, `expected skill ${skillId}, got ${d.skill} (act=${d.act} place=${d.place})`).toBe(skillId);
  const rule = ruleOf(skillId);
  expect(rule.acts).toContain(d.act);
  expect(rule.places).toContain(d.place);
  const filled = rule.reasons.map((r) => r.replaceAll("{place}", d.place));
  expect(filled, `reason "${d.reason}" not in ${skillId}.reasons`).toContain(d.reason);
}

describe("decide() — one skill per need branch", () => {
  it("night + tired → rest-night (sleep at the barn)", () => {
    const d = decide(ctxOf({ clock: 0.8, needs: { hunger: 0.2, thirst: 0.2, tired: 0.4, lonely: 0.1 } }));
    expectSkillAndReason(d, "rest-night");
    expect(d.act).toBe("sleep");
    expect(d.place).toBe("barn");
    expect(d.reason).toBe("night is falling, need rest");
  });

  it("thirst > 0.6 → drink-water", () => {
    const d = decide(ctxOf({ needs: { hunger: 0.1, thirst: 0.7, tired: 0.1, lonely: 0.1 }, rng: () => 0.5 }));
    expectSkillAndReason(d, "drink-water");
    expect(d.act).toBe("drink");
    expect(["pond", "square"]).toContain(d.place);
    expect(d.reason).toBe(d.place === "pond" ? "parched, seeking water" : "throat dry, heading to fountain");
  });

  it("hunger > 0.6 → eat-food", () => {
    const d = decide(ctxOf({ needs: { hunger: 0.8, thirst: 0.1, tired: 0.1, lonely: 0.1 }, rng: () => 0.5 }));
    expectSkillAndReason(d, "eat-food");
    expect(d.act).toBe("graze");
  });

  it("lonely > threshold → seek-company", () => {
    const d = decide(ctxOf({ needs: { hunger: 0.1, thirst: 0.1, tired: 0.1, lonely: 0.8 }, rng: () => 0.5 }));
    expectSkillAndReason(d, "seek-company");
    expect(["talk", "argue"]).toContain(d.act);
    expect(d.reason).toBe("feeling lonely, seeking company");
  });

  it("spirits < -0.6 (roll passes) → low-spirits", () => {
    const self = { id: "r1", name: "Vetch", traits: [], job: "", obsession: "the fence", spirits: -0.8, memories: [], relationships: {} };
    const d = decide(ctxOf({ self, rng: seq(0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1) }));
    expectSkillAndReason(d, "low-spirits");
    expect(d.reason).toBe("spirits low, picking a fight");
  });

  it("calm resident with a passing roll → wander-town", () => {
    const d = decide(ctxOf({ rng: seq(0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1) }));
    expectSkillAndReason(d, "wander-town");
  });

  it("wander roll misses, busy-graze roll hits → busy-graze", () => {
    const d = decide(ctxOf({ rng: seq(0.9, 0.1, 0.1, 0.1, 0.1) }));
    expectSkillAndReason(d, "busy-graze");
    expect(d.act).toBe("graze");
    expect(d.place).toBe("meadowW");
    expect(d.reason).toBe("keeping busy with grazing");
  });

  it("no job and both idle rolls miss → stroll-on (never idle)", () => {
    const d = decide(ctxOf({ location: "square", rng: seq(0.9, 0.9, 0.1, 0.5, 0.5) }));
    expectSkillAndReason(d, "stroll-on");
  });

  it("job holder with rolls missing → work-job at the job home", () => {
    const self = { id: "r1", name: "Vetch", traits: [], job: "courier", obsession: "the fence", spirits: 0, memories: [], relationships: {} };
    const d = decide(ctxOf({ location: "square", self, rng: seq(0.9, 0.9, 0.1, 0.5, 0.5) }));
    expectSkillAndReason(d, "work-job");
    expect(d.act).toBe("work");
    expect(d.place).not.toBe("square"); // job home differs from the current spot
    expect(d.reason).toBe(`work calls at ${d.place}`);
  });

  it("job home equal to current location → stroll-on (never idle)", () => {
    const self = { id: "r1", name: "Vetch", traits: [], job: "courier", obsession: "the fence", spirits: 0, memories: [], relationships: {} };
    // draw 3 must land on JOB_HOMES.courier[<index of "square">] so the handler
    // declines. The courier home list grew from 5 to 7 with the 5x build-out, so
    // the old 0.3 (floor(0.3*5)=1) now picks "post" instead and the rule fires.
    // Derived from the list rather than hard-coded, so it survives the next growth.
    const courierHomes = NPC_JOB_HOMES.courier!;
    const squareIdx = courierHomes.indexOf("square");
    expect(squareIdx).toBeGreaterThanOrEqual(0);
    const draw = (squareIdx + 0.5) / courierHomes.length;
    const d = decide(ctxOf({ location: "square", self, rng: seq(0.9, 0.9, draw, 0.1, 0.5) }));
    expectSkillAndReason(d, "stroll-on");
    expect(d.act).toBe("stroll");
    expect(d.reason).toBe("keeping busy, legs need moving");
  });
});

describe("decide() — priority chain", () => {
  it("night rest beats thirst, hunger and loneliness when all trigger", () => {
    const d = decide(ctxOf({
      clock: 0.8,
      needs: { hunger: 0.9, thirst: 0.9, tired: 0.4, lonely: 0.9 },
      rng: () => 0.1,
    }));
    expect(d.skill).toBe("rest-night");
    expect(d.act).toBe("sleep");
  });

  it("thirst beats hunger and loneliness when both trigger", () => {
    const d = decide(ctxOf({ needs: { hunger: 0.9, thirst: 0.7, tired: 0.1, lonely: 0.9 }, rng: () => 0.5 }));
    expect(d.skill).toBe("drink-water");
    expect(d.act).toBe("drink");
  });

  it("hunger beats loneliness when both trigger", () => {
    const d = decide(ctxOf({ needs: { hunger: 0.8, thirst: 0.1, tired: 0.1, lonely: 0.9 }, rng: () => 0.5 }));
    expect(d.skill).toBe("eat-food");
    expect(d.act).toBe("graze");
  });

  it("loneliness beats low spirits when both trigger", () => {
    const self = { id: "r1", name: "Vetch", traits: [], job: "", obsession: "the fence", spirits: -0.9, memories: [], relationships: {} };
    const d = decide(ctxOf({ self, needs: { hunger: 0.1, thirst: 0.1, tired: 0.1, lonely: 0.9 }, rng: () => 0.5 }));
    expect(d.skill).toBe("seek-company");
  });

  it("an urgent need beats wander — the returning resident always drinks first", () => {
    const d = decide(ctxOf({ needs: { hunger: 0.1, thirst: 0.9, tired: 0.1, lonely: 0.1 }, rng: () => 0.9 }));
    expect(d.skill).toBe("drink-water"); // roll would otherwise wander (0.9 > 0.42)
  });

  it("NPC_SKILLS is ordered and decide() always names a known rule", () => {
    const prios = NPC_SKILLS.map((r) => r.priority);
    for (let i = 1; i < prios.length; i++) expect(prios[i]!).toBeGreaterThan(prios[i - 1]!);

    for (let i = 0; i < 300; i++) {
      const traits = ["cheerful", "gruff", "dreamy", "loyal", "stubborn", "inquisitive", "unflappable"].filter(() => Math.random() < 0.3);
      const self = {
        id: "r" + i,
        name: "Vetch",
        traits,
        job: ["courier", "herder", "baker", "smith", ""][Math.floor(Math.random() * 5)]!,
        obsession: "the fence",
        spirits: Math.random() * 2 - 1,
        memories: [],
        relationships: {},
      };
      const d = decide(ctxOf({
        clock: Math.random(),
        location: ["square", "pond", "barn", "station", "unknown-place"][Math.floor(Math.random() * 5)]!,
        self,
        rng: Math.random,
        needs: { hunger: Math.random(), thirst: Math.random(), tired: Math.random(), lonely: Math.random() },
      }));
      expect(isNpcSkillId(d.skill), `run ${i}: skill=${d.skill} act=${d.act}`).toBe(true);
      const rule = ruleOf(d.skill!);
      expect(rule.acts).toContain(d.act);
      expect(rule.places).toContain(d.place);
      expect(LOCATION_BY_ID.has(d.place), `run ${i}: place=${d.place}`).toBe(true);
      expect(d.reason.length).toBeGreaterThan(0);
      expect(npcSkillLabel(d.skill)).toBe(rule.label);
    }
  });
});

// The 26→34 location drift guard: shared/test/skills.test.ts pins NPC_ALL_PLACES
// to its own hard-coded list, but only the backend knows the REAL location ids.
// These two assertions close that loop — adding a town building without putting
// it in the NPC wander pool (or inventing a place that does not exist) fails here.
describe("NPC place data ⇄ real town locations (guard)", () => {
  it("every rule place and every place group exists in LOCATIONS", () => {
    const groups: Record<string, readonly string[]> = {
      all: NPC_ALL_PLACES,
      social: NPC_SOCIAL_PLACES,
      food: NPC_FOOD_PLACES,
      water: NPC_WATER_PLACES,
      rest: NPC_REST_PLACES,
      work: NPC_WORK_PLACES,
      ...NPC_JOB_HOMES,
    };
    for (const rule of NPC_SKILLS) {
      for (const p of rule.places) {
        expect(LOCATION_BY_ID.has(p), `${rule.id} → ${p} is not a real location`).toBe(true);
      }
    }
    for (const [name, list] of Object.entries(groups)) {
      for (const p of list) expect(LOCATION_BY_ID.has(p), `group ${name} → ${p} is not a real location`).toBe(true);
    }
  });

  it("NPC_ALL_PLACES covers every town location — a new building fails this test", () => {
    const pool: readonly string[] = NPC_ALL_PLACES;
    for (const id of LOCATION_BY_ID.keys()) {
      expect(pool, `location ${id} is missing from the NPC wander pool`).toContain(id);
    }
  });
});

describe("applyDecision — skill and why reach mind.doing and the order event", () => {
  it("carries a valid skill id and the reason into both channels", () => {
    const world = createInitialWorld();
    const agent = world.herd[0]!;
    const res = applyDecision(
      world,
      agent,
      { act: "drink", place: "pond", reason: "parched, seeking water", skill: "drink-water" },
      { secs: 18 }
    );

    expect(agent.mind.doing.skill).toBe("drink-water");
    expect(agent.mind.doing.why).toBe("parched, seeking water");
    expect(res.order.type).toBe("order");
    expect(res.order.skill).toBe("drink-water");
    expect(res.order.why).toBe("parched, seeking water");
    expect(res.order.act).toBe("drink");
    expect(res.order.place).toBe("pond");
    expect(res.order.secs).toBe(18);
  });

  it("drops an unknown skill id instead of throwing (safe for the gateway path)", () => {
    const world = createInitialWorld();
    const agent = world.herd[0]!;
    const res = applyDecision(
      world,
      agent,
      { act: "stroll", place: "board", reason: "external agent", skill: "not-a-real-rule" },
      { secs: 18 }
    );
    // "" (not undefined): JSON drops undefined keys, so the HUD would keep the
    // resident's previous skill label — an explicit blank clears it instead
    expect(res.order.skill).toBe("");
    expect(agent.mind.doing.skill).toBe("");
    expect(res.order.why).toBe("external agent");
  });

  it("handles a decision without any skill (LLM / gateway brains)", () => {
    const world = createInitialWorld();
    const agent = world.herd[0]!;
    const res = applyDecision(
      world,
      agent,
      { act: "talk", place: "square", reason: "answered from outside" },
      { secs: 18 }
    );
    expect(res.order.skill).toBe("");
    expect(agent.mind.doing.skill).toBe("");
    expect(res.order.why).toBe("answered from outside");
    expect(agent.mind.doing.why).toBe("answered from outside");
  });
});

describe("doc ↔ code contract", () => {
  it("SKILL.md stays in sync with NPC_SKILLS (the shared test enforces the full table)", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const doc = readFileSync(fileURLToPath(new URL("../../skills/npc-agent/SKILL.md", import.meta.url)), "utf8");
    for (const rule of NPC_SKILLS) expect(doc, `doc must document ${rule.id}`).toContain(`| ${rule.priority} | \`${rule.id}\` |`);
  });
});
