/**
 * Machine-readable rules for the NPC agent skill (skills/npc-agent/SKILL.md).
 *
 * This module is the SINGLE source of truth the decision code reads: the doc
 * table in skills/npc-agent/SKILL.md must list exactly these ids in this exact
 * priority order (shared/test/skills.test.ts parses the markdown and fails on
 * drift). `decide()` in backend/src/simbrain.ts walks NPC_SKILLS in order and
 * applies the first rule whose `when` predicate holds.
 */

/** Context every rule predicate is evaluated against (built by the caller). */
export interface NpcRuleContext {
  /** precomputed from the day clock (backend needs.isNight) */
  readonly night: boolean;
  readonly clock: number;
  readonly needs: { hunger: number; thirst: number; tired: number; lonely: number };
  readonly spirits: number;
  readonly traits: readonly string[];
  /** job id of the resident, "" when jobless */
  readonly job: string;
  /** location id the resident currently stands at */
  readonly location: string;
}

export interface NpcSkillRule {
  /** stable machine id, echoed to the UI through OrderEvent / mind.doing.skill */
  readonly id: string;
  /** human label shown by the UI (npcSkillLabel) */
  readonly label: string;
  /** 1 = highest priority; decide() evaluates rules in ascending priority order */
  readonly priority: number;
  readonly acts: readonly string[];
  readonly places: readonly string[];
  /** gate: true means this rule may fire (its handler may still decline and the chain continues) */
  readonly when: (ctx: NpcRuleContext) => boolean;
  /** reason templates shown to the player; `{place}` is filled with the chosen place */
  readonly reasons: readonly string[];
}

/** Trigger thresholds shared by the rule predicates and their handlers. */
export const NPC_THRESHOLDS = {
  /** thirst above this → drink-water */
  thirst: 0.6,
  /** hunger above this → eat-food */
  hunger: 0.6,
  /** spirits below this → low-spirits may fire */
  lowSpirits: -0.6,
  /** roll guarding low-spirits (0.45 = fires 45% of eligible turns) */
  lowSpiritsChance: 0.45,
  /** base chance of the wander-town roll (before trait/spirits modifiers) */
  wanderChanceBase: 0.42,
  /** roll guarding busy-graze */
  busyGrazeChance: 0.18,
  /** cheerful residents may still be at the fire before this clock */
  nightFireClock: 0.8,
  /** chance to prefer the pond over the fountain when drinking */
  pondBias: 0.6,
  pondBiasGruff: 0.75,
} as const;

/** Trait-adjusted tiredness threshold for the night-rest rule. */
export function npcTiredThreshold(traits: readonly string[]): number {
  return traits.includes("unflappable") ? 0.45 : traits.includes("dreamy") ? 0.25 : 0.3;
}

/** Trait-adjusted loneliness threshold for the seek-company rule. */
export function npcLonelyThreshold(traits: readonly string[]): number {
  return traits.includes("loyal") ? 0.45 : traits.includes("gruff") ? 0.7 : 0.55;
}

/** Loneliness as felt: low spirits numb it, high spirits sharpen it. */
export function npcEffectiveLonely(needs: NpcRuleContext["needs"], spirits: number): number {
  return needs.lonely + (spirits < -0.4 ? -0.15 : spirits > 0.4 ? 0.1 : 0);
}

// --- Place groups (ids of the 99 town locations — backend/src/locations.ts) --

export const NPC_SOCIAL_PLACES = [
  "square", "tavern", "hall", "baths", "fire", "market", "board", "inn", "chapel", "theatre", "arcade", "lodge",
  // The Commons and the two public halls added in the 5x build-out
  "bandstand", "aviary", "hedgeMaze", "rosewalk", "disputation",
] as const;
export const NPC_FOOD_PLACES = [
  "trough", "meadowW", "meadowE", "orchard",
  "northMeadow", "southMeadow", "eastMeadow", "westOrchard",
] as const;
export const NPC_WATER_PLACES = ["pond", "square", "riverRun", "riverMouth", "eastFen", "millpond"] as const;
export const NPC_REST_PLACES = [
  "barn", "pens", "stables", "farmhouse",
  "barracks", "northStables", "byre", "paddock", "sheepfold", "hermitage", "bogHut",
] as const;
export const NPC_WORK_PLACES = [
  "shed", "mill", "library", "press", "bank", "post", "school", "clinic", "granary", "warehouse", "smithy", "depot", "garage", "forge", "exchange",
  // Riverside Wharf
  "wharf", "boathouse", "netloft", "saltWarehouse", "chandlery",
  // The Commons
  "greenhouse", "orangery", "apiary",
  // Ironworks
  "foundry", "kiln", "oreShed", "foundryCrane", "quarryOffice", "charcoalYard", "slagHeap",
  // University Quarter
  "scriptorium", "lectureHall", "anatomy", "printHouse", "archive", "observatoryAnnex",
  // Farm Belt
  "threshingBarn", "dryingYard", "dairy",
  // Ashen Moor + Hollowmere
  "peatWorks", "charcoalKiln", "bonehouse",
] as const;

export const NPC_ALL_PLACES = [
  // the original core
  "square", "hall", "market", "tavern", "press", "bank", "vault", "library", "booth", "clinic", "school", "post", "baths", "station", "barn", "shed", "mill", "pens", "pond", "dock", "meadowW", "meadowE", "orchard", "trough", "fire", "board",
  "stables", "granary", "warehouse", "chapel", "inn", "smithy", "farmhouse", "theatre",
  "depot", "garage", "tower", "arcade", "forge", "lodge", "observatory", "exchange",
  // Northgate
  "gatehouse", "tollhouse", "barracks", "watchtower", "beacon", "northStables", "curtainWall", "outerGate",
  // Riverside Wharf
  "wharf", "boathouse", "netloft", "saltWarehouse", "ferrySlip", "chandlery", "riverWall",
  // The Commons
  "greenhouse", "orangery", "apiary", "bandstand", "aviary", "hedgeMaze", "rosewalk",
  // Ironworks
  "foundry", "kiln", "oreShed", "foundryCrane", "quarryOffice", "charcoalYard", "slagHeap",
  // University Quarter
  "scriptorium", "lectureHall", "anatomy", "printHouse", "observatoryAnnex", "disputation", "archive",
  // Farm Belt
  "byre", "threshingBarn", "paddock", "dryingYard", "sheepfold", "dairy",
  // Hollowmere
  "cemetery", "chapelOfBones", "hermitage", "charnel", "bonehouse",
  // Ashen Moor
  "peatWorks", "charcoalKiln", "bogHut",
  // open ground
  "millpond", "northMeadow", "southMeadow", "eastMeadow", "westOrchard", "riverRun", "riverMouth", "eastFen",
] as const;

/** Job → instinct home locations (the work-job rule picks one of these). */
export const NPC_JOB_HOMES: Readonly<Record<string, readonly string[]>> = {
  shearer: ["shed", "pens", "meadowW", "paddock"],
  miller: ["mill", "trough", "market", "granary", "millpond"],
  librarian: ["library", "press", "school", "archive", "scriptorium"],
  clerk: ["bank", "hall", "market", "exchange", "archive"],
  baker: ["trough", "market", "orchard", "dairy"],
  herder: ["meadowW", "meadowE", "pens", "stables", "sheepfold", "southMeadow"],
  scribe: ["press", "library", "hall", "observatory", "scriptorium", "printHouse"],
  smith: ["shed", "mill", "vault", "smithy", "forge", "foundry"],
  courier: ["station", "square", "post", "depot", "garage", "wharf", "gatehouse"],
  keeper: ["tower", "chapel", "hall", "beacon", "watchtower", "gatehouse"],
};

/**
 * The decision rules, ordered by priority (1 = highest). decide() walks this
 * array top-down and stops at the first rule whose `when` holds — so a higher
 * priority rule always wins when two triggers are satisfied at once.
 */
export const NPC_SKILLS: readonly NpcSkillRule[] = [
  {
    id: "rest-night",
    label: "Night Rest",
    priority: 1,
    acts: ["sleep", "talk"],
    places: ["barn", "fire"],
    when: (c) => c.night && c.needs.tired > npcTiredThreshold(c.traits),
    reasons: ["night but spirits high at the fire", "night is falling, need rest"],
  },
  {
    id: "drink-water",
    label: "Thirst",
    priority: 2,
    acts: ["drink"],
    // the drink handler in backend/src/simbrain.ts only ever returns one of the
    // first two water places (pondBias picks the isolated one), so the rule
    // declares exactly that slice rather than the whole group — widening it
    // would let the test pass places the handler can never return
    places: NPC_WATER_PLACES.slice(0, 2),
    when: (c) => c.needs.thirst > NPC_THRESHOLDS.thirst,
    reasons: ["parched, seeking water", "throat dry, heading to fountain"],
  },
  {
    id: "eat-food",
    label: "Hunger",
    priority: 3,
    acts: ["graze"],
    // derived: the eat-food handler picks from NPC_FOOD_PLACES, with a baker bias
    // that adds the market. This list was a hand-copy of the five original food
    // places and went stale the moment the 5x build-out added four more meadows —
    // decide() returned northMeadow and the rule claimed it could not.
    places: [...NPC_FOOD_PLACES, "market"],
    when: (c) => c.needs.hunger > NPC_THRESHOLDS.hunger,
    reasons: ["craving the good grass", "sour grass is still grass", "apples sound right", "oats at the trough"],
  },
  {
    id: "seek-company",
    label: "Lonely",
    priority: 4,
    acts: ["talk", "argue"],
    places: [...NPC_SOCIAL_PLACES],
    when: (c) => npcEffectiveLonely(c.needs, c.spirits) > npcLonelyThreshold(c.traits),
    reasons: ["feeling lonely, seeking company"],
  },
  {
    id: "low-spirits",
    label: "Low Spirits",
    priority: 5,
    acts: ["argue", "sleep"],
    places: [...NPC_SOCIAL_PLACES, ...NPC_REST_PLACES],
    when: (c) => c.spirits < NPC_THRESHOLDS.lowSpirits,
    reasons: ["spirits low, picking a fight", "low spirits, need rest"],
  },
  {
    id: "wander-town",
    label: "Wander",
    priority: 6,
    acts: ["wander", "stroll", "explore", "work", "talk"],
    places: [...NPC_ALL_PLACES],
    when: () => true,
    reasons: [
      "out for a walk, need to see what's happening",
      "instinct to move, staying still feels wrong",
      "wandering — town is too quiet",
      "heading to {place}, curiosity",
      "catching some air, maybe there is a story",
    ],
  },
  {
    id: "busy-graze",
    label: "Busy Grazing",
    priority: 7,
    acts: ["graze"],
    places: ["meadowW"],
    when: () => true,
    reasons: ["keeping busy with grazing"],
  },
  {
    id: "work-job",
    label: "Work",
    priority: 8,
    acts: ["work"],
    places: [...new Set(Object.values(NPC_JOB_HOMES).flat())],
    when: (c) => c.job !== "" && NPC_JOB_HOMES[c.job] !== undefined,
    reasons: ["work calls at {place}"],
  },
  {
    id: "stroll-on",
    label: "Keep Moving",
    priority: 9,
    acts: ["stroll"],
    places: [...NPC_SOCIAL_PLACES],
    when: () => true,
    reasons: ["keeping busy, legs need moving"],
  },
];

const NPC_SKILL_IDS: ReadonlySet<string> = new Set(NPC_SKILLS.map((r) => r.id));

/** true when `id` names a rule in NPC_SKILLS (never throws). */
export function isNpcSkillId(id: string | undefined | null): id is string {
  return typeof id === "string" && NPC_SKILL_IDS.has(id);
}

/** Rule id → human label for the UI; undefined for unknown/absent ids. */
export function npcSkillLabel(id: string | undefined | null): string | undefined {
  if (!isNpcSkillId(id)) return undefined;
  return NPC_SKILLS.find((r) => r.id === id)?.label;
}

/** Perceive → appraise → decide → act → speak → remember: one turn per resident. */
export const NPC_WORKFLOW = ["perceive", "appraise", "decide", "act", "speak", "remember"] as const;
export type NpcWorkflowStage = (typeof NPC_WORKFLOW)[number];
