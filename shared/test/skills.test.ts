import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  NPC_SKILLS,
  NPC_WORKFLOW,
  NPC_ALL_PLACES,
  NPC_THRESHOLDS,
  npcSkillLabel,
  isNpcSkillId,
  npcTiredThreshold,
  npcLonelyThreshold,
  npcEffectiveLonely,
  type NpcRuleContext,
} from "../src/skills.js";

// skills/npc-agent/SKILL.md is the human half of the contract; this test parses
// it so the doc table can never drift from NPC_SKILLS (the machine half).
const DOC = readFileSync(fileURLToPath(new URL("../../skills/npc-agent/SKILL.md", import.meta.url)), "utf8");

/**
 * Canonical town locations (backend/src/locations.ts) — deliberately a SECOND,
 * independent copy rather than an import: the point of this guard is that a new
 * building has to be added to the rule table on purpose. Importing the same
 * constant would make the check vacuous.
 *
 * Regenerate with `node scripts/emit-canonical.mjs` after adding locations.
 */
const CANONICAL_100 = [
  "square", "hall", "market", "tavern", "press", "bank", "vault", "library", "booth",
  "clinic", "school", "post", "baths", "station", "barn", "shed", "mill", "pens", "pond",
  "dock", "meadowW", "meadowE", "orchard", "trough", "fire", "board", "stables", "granary",
  "warehouse", "chapel", "inn", "smithy", "farmhouse", "theatre", "depot", "garage", "tower",
  "arcade", "forge", "lodge", "observatory", "exchange", "gatehouse", "tollhouse",
  "barracks", "watchtower", "beacon", "northStables", "curtainWall", "outerGate", "wharf",
  "boathouse", "netloft", "saltWarehouse", "ferrySlip", "chandlery", "riverWall",
  "greenhouse", "orangery", "apiary", "bandstand", "aviary", "hedgeMaze", "rosewalk",
  "foundry", "kiln", "oreShed", "foundryCrane", "quarryOffice", "charcoalYard", "slagHeap",
  "scriptorium", "lectureHall", "anatomy", "printHouse", "observatoryAnnex", "disputation",
  "archive", "byre", "threshingBarn", "paddock", "dryingYard", "sheepfold", "dairy",
  "cemetery", "chapelOfBones", "hermitage", "charnel", "bonehouse", "peatWorks",
  "charcoalKiln", "bogHut", "millpond", "northMeadow", "southMeadow", "eastMeadow",
  "westOrchard", "riverRun", "riverMouth", "eastFen"
];

const BACKTICK = /`([^`]+)`/g;
const backticked = (cell: string): string[] => [...cell.matchAll(BACKTICK)].map((m) => m[1]!);

interface DocRuleRow {
  priority: number;
  id: string;
  label: string;
  /** raw Trigger cell (column 4) — numeric thresholds are synced against NPC_THRESHOLDS */
  trigger: string;
  acts: string[];
  places: string[];
}

function parseDocRules(md: string): DocRuleRow[] {
  const rows: DocRuleRow[] = [];
  for (const line of md.split(/\r?\n/)) {
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").map((c) => c.trim());
    if (!/^\d+$/.test(cells[1] ?? "")) continue; // header / separator / workflow rows
    rows.push({
      priority: Number(cells[1]),
      id: (cells[2] ?? "").replaceAll("`", ""),
      label: cells[3] ?? "",
      trigger: cells[4] ?? "",
      acts: backticked(cells[5] ?? ""),
      places: backticked(cells[6] ?? ""),
    });
  }
  return rows;
}

/**
 * Numeric thresholds stated in a Trigger cell, normalized to the code's scale:
 * "0.6" → 0.6, "-0.6" → -0.6, "18%" → 0.18, "55%" → 0.55.
 */
function parseTriggerNumbers(cell: string): number[] {
  const out: number[] = [];
  for (const m of cell.matchAll(/(-?\d+(?:\.\d+)?)(%?)/g)) {
    const n = Number(m[1]);
    out.push(m[2] === "%" ? n / 100 : n);
  }
  return out;
}

function parseDocWorkflow(md: string): string[] {
  const stages: string[] = [];
  for (const line of md.split(/\r?\n/)) {
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").map((c) => c.trim());
    if (!/^`[a-z-]+`$/.test(cells[1] ?? "")) continue;
    stages.push(backticked(cells[1]!)[0]!);
  }
  return stages;
}

const sorted = (xs: readonly string[]): string[] => [...xs].sort();

function ruleCtx(over: Partial<NpcRuleContext>): NpcRuleContext {
  return {
    night: false,
    clock: 0.3,
    needs: { hunger: 0.1, thirst: 0.1, tired: 0.1, lonely: 0.1 },
    spirits: 0,
    traits: [],
    job: "",
    location: "square",
    ...over,
  };
}

describe("npc-agent skill — doc ⇄ code sync", () => {
  const docRows = parseDocRules(DOC);

  it("SKILL.md lists exactly the NPC_SKILLS ids in the same priority order", () => {
    expect(docRows.length).toBe(NPC_SKILLS.length);
    expect(docRows.map((r) => r.id)).toEqual(NPC_SKILLS.map((r) => r.id));
    expect(docRows.map((r) => r.priority)).toEqual(NPC_SKILLS.map((r) => r.priority));
  });

  it("SKILL.md labels, acts and places match every rule", () => {
    for (const row of docRows) {
      const rule = NPC_SKILLS.find((r) => r.id === row.id)!;
      expect(row.label, `label of ${row.id}`).toBe(rule.label);
      expect(sorted(row.acts), `acts of ${row.id}`).toEqual(sorted(rule.acts));
      expect(sorted(row.places), `places of ${row.id}`).toEqual(sorted(rule.places));
    }
  });

  it("SKILL.md points at the machine source and the verification command", () => {
    expect(DOC).toContain("shared/src/skills.ts");
    expect(DOC).toContain("pnpm --filter @slopagentbook/shared test");
  });

  it("SKILL.md workflow table lists the six stages in order", () => {
    expect(parseDocWorkflow(DOC)).toEqual([...NPC_WORKFLOW]);
  });
});

// review gap #6 — the Trigger column states numeric thresholds as prose; without
// this check the doc could drift from NPC_THRESHOLDS without a single test going
// red. Every number the doc states must resolve to a code threshold, and every
// trigger-side threshold must be stated in the doc.
describe("npc-agent skill — Trigger thresholds ⇄ NPC_THRESHOLDS", () => {
  type ThresholdKey = keyof typeof NPC_THRESHOLDS;

  /**
   * Which NPC_THRESHOLDS entry each rule's Trigger cell must state, and how.
   * `via: "decline"` = the doc phrases the chance as its complement
   * ("55% of eligible turns decline" ⇔ lowSpiritsChance 0.45 fires).
   */
  const TRIGGER_EXPECTATIONS: Record<string, { key: ThresholdKey; via?: "decline" }[]> = {
    "drink-water": [{ key: "thirst" }],
    "eat-food": [{ key: "hunger" }],
    "low-spirits": [{ key: "lowSpirits" }, { key: "lowSpiritsChance", via: "decline" }],
    "wander-town": [{ key: "wanderChanceBase" }],
    "busy-graze": [{ key: "busyGrazeChance" }],
  };

  /** Handler-side biases, not rule gates — never stated in the Trigger column. */
  const NOT_TRIGGERS: ThresholdKey[] = ["nightFireClock", "pondBias", "pondBiasGruff"];

  const close = (a: number, b: number): boolean => Math.abs(a - b) < 1e-9;
  const docRows = parseDocRules(DOC);

  it("every numeric Trigger in SKILL.md matches NPC_THRESHOLDS exactly (both directions)", () => {
    for (const [id, expects] of Object.entries(TRIGGER_EXPECTATIONS)) {
      const row = docRows.find((r) => r.id === id);
      expect(row, `rule ${id} missing from the doc rules table`).toBeDefined();
      const nums = parseTriggerNumbers(row!.trigger);
      const used = new Set<number>();
      for (const exp of expects) {
        const want = NPC_THRESHOLDS[exp.key];
        const idx = nums.findIndex((n, i) => !used.has(i) && close(exp.via === "decline" ? 1 - n : n, want));
        expect(
          idx,
          `${id}: Trigger "${row!.trigger}" must state ${String(exp.key)}=${want}` +
            `${exp.via === "decline" ? " (written as its complement)" : ""} — found ${JSON.stringify(nums)}`
        ).toBeGreaterThanOrEqual(0);
        used.add(idx);
      }
      // a number the expectation table does not consume = doc/code drift
      nums.forEach((n, i) =>
        expect(used.has(i), `${id}: undocumented trigger number ${n} in "${row!.trigger}"`).toBe(true)
      );
    }
  });

  it("no rule states numeric triggers that the expectation table does not cover", () => {
    for (const row of docRows) {
      if (parseTriggerNumbers(row.trigger).length === 0) continue;
      expect(
        Object.keys(TRIGGER_EXPECTATIONS),
        `${row.id} states numeric triggers ${JSON.stringify(parseTriggerNumbers(row.trigger))} but has no expectation`
      ).toContain(row.id);
    }
  });

  it("every trigger-side NPC_THRESHOLDS entry is doc-synced (code cannot drift silently)", () => {
    const covered = new Set(Object.values(TRIGGER_EXPECTATIONS).flat().map((e) => e.key));
    for (const key of Object.keys(NPC_THRESHOLDS) as ThresholdKey[]) {
      if (NOT_TRIGGERS.includes(key)) continue;
      expect(covered, `NPC_THRESHOLDS.${key} gates a rule but is not stated in SKILL.md's Trigger column`).toContain(key);
    }
  });
});

describe("NPC_SKILLS data", () => {
  it("priorities are unique and strictly ascending (1 = highest)", () => {
    const prios = NPC_SKILLS.map((r) => r.priority);
    expect(new Set(prios).size).toBe(prios.length);
    for (let i = 1; i < prios.length; i++) expect(prios[i]!).toBeGreaterThan(prios[i - 1]!);
    expect(prios[0]).toBe(1);
  });

  it("ids are unique and non-empty", () => {
    const ids = NPC_SKILLS.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z][a-z0-9-]*$/);
  });

  it("every rule targets only real town locations (42-location whitelist)", () => {
    expect(sorted(NPC_ALL_PLACES)).toEqual(sorted(CANONICAL_100));
    for (const rule of NPC_SKILLS) {
      expect(rule.places.length, `${rule.id} has places`).toBeGreaterThan(0);
      for (const p of rule.places) expect(CANONICAL_100, `${rule.id} → ${p}`).toContain(p);
    }
  });

  it("every rule has acts, a label, and at least one reason", () => {
    for (const rule of NPC_SKILLS) {
      expect(rule.acts.length, `${rule.id} acts`).toBeGreaterThan(0);
      expect(rule.label.length, `${rule.id} label`).toBeGreaterThan(0);
      expect(rule.reasons.length, `${rule.id} reasons`).toBeGreaterThan(0);
    }
  });

  it("the chain ends with an unconditional rule (no idle residents)", () => {
    const last = NPC_SKILLS[NPC_SKILLS.length - 1]!;
    expect(last.when(ruleCtx({}))).toBe(true);
  });
});

describe("NPC_WORKFLOW", () => {
  it("is the complete perceive → … → remember sequence", () => {
    expect([...NPC_WORKFLOW]).toEqual(["perceive", "appraise", "decide", "act", "speak", "remember"]);
  });
});

describe("rule predicates", () => {
  const byId = (id: string) => NPC_SKILLS.find((r) => r.id === id)!;

  it("rest-night fires only at night when tired above the trait threshold", () => {
    const rule = byId("rest-night");
    expect(rule.when(ruleCtx({ night: true, needs: { hunger: 0.1, thirst: 0.1, tired: 0.4, lonely: 0.1 } }))).toBe(true);
    expect(rule.when(ruleCtx({ night: false, needs: { hunger: 0.1, thirst: 0.1, tired: 0.9, lonely: 0.1 } }))).toBe(false);
    expect(rule.when(ruleCtx({ night: true, needs: { hunger: 0.1, thirst: 0.1, tired: 0.2, lonely: 0.1 } }))).toBe(false);
    // dreamy lowers the bar, unflappable raises it
    expect(npcTiredThreshold(["dreamy"])).toBeLessThan(npcTiredThreshold([]));
    expect(npcTiredThreshold(["unflappable"])).toBeGreaterThan(npcTiredThreshold([]));
  });

  it("drink-water / eat-food use their 0.6 thresholds", () => {
    expect(byId("drink-water").when(ruleCtx({ needs: { hunger: 0.1, thirst: NPC_THRESHOLDS.thirst, tired: 0.1, lonely: 0.1 } }))).toBe(false);
    expect(byId("drink-water").when(ruleCtx({ needs: { hunger: 0.1, thirst: 0.61, tired: 0.1, lonely: 0.1 } }))).toBe(true);
    expect(byId("eat-food").when(ruleCtx({ needs: { hunger: 0.61, thirst: 0.1, tired: 0.1, lonely: 0.1 } }))).toBe(true);
    expect(byId("eat-food").when(ruleCtx({ needs: { hunger: 0.6, thirst: 0.1, tired: 0.1, lonely: 0.1 } }))).toBe(false);
  });

  it("seek-company weighs spirits into effective loneliness", () => {
    const rule = byId("seek-company");
    const base = { hunger: 0.1, thirst: 0.1, tired: 0.1, lonely: 0.6 };
    expect(npcEffectiveLonely(base, 0)).toBe(0.6);
    expect(rule.when(ruleCtx({ needs: base }))).toBe(true);
    // low spirits numb loneliness below the default threshold
    expect(npcEffectiveLonely(base, -0.8)).toBeLessThan(0.6);
    expect(rule.when(ruleCtx({ needs: base, spirits: -0.8 }))).toBe(false);
    // gruff is harder to please
    expect(npcLonelyThreshold(["gruff"])).toBeGreaterThan(npcLonelyThreshold([]));
  });

  it("low-spirits gates on spirits, wander/stroll/busy-graze are unconditional", () => {
    expect(byId("low-spirits").when(ruleCtx({ spirits: -0.7 }))).toBe(true);
    expect(byId("low-spirits").when(ruleCtx({ spirits: -0.5 }))).toBe(false);
    expect(byId("wander-town").when(ruleCtx())).toBe(true);
    expect(byId("busy-graze").when(ruleCtx())).toBe(true);
    expect(byId("stroll-on").when(ruleCtx())).toBe(true);
  });

  it("work-job only fires for a job that has a home", () => {
    expect(byId("work-job").when(ruleCtx({ job: "courier" }))).toBe(true);
    expect(byId("work-job").when(ruleCtx({ job: "" }))).toBe(false);
    expect(byId("work-job").when(ruleCtx({ job: "unlisted-job" }))).toBe(false);
  });
});

describe("npcSkillLabel / isNpcSkillId", () => {
  it("maps known ids to labels and rejects unknown ones without throwing", () => {
    for (const rule of NPC_SKILLS) expect(npcSkillLabel(rule.id)).toBe(rule.label);
    expect(npcSkillLabel("nope")).toBeUndefined();
    expect(npcSkillLabel("")).toBeUndefined();
    expect(npcSkillLabel(undefined)).toBeUndefined();
    expect(npcSkillLabel(null)).toBeUndefined();
    expect(isNpcSkillId("rest-night")).toBe(true);
    expect(isNpcSkillId("nope")).toBe(false);
    expect(isNpcSkillId(undefined)).toBe(false);
  });
});
