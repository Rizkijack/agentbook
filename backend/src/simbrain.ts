import { isNight } from "./needs.js";
import type { Post, TownEvent } from "@slopagentbook/shared";
import {
  NPC_SKILLS,
  NPC_THRESHOLDS,
  NPC_SOCIAL_PLACES,
  NPC_FOOD_PLACES,
  NPC_REST_PLACES,
  NPC_WORK_PLACES,
  NPC_ALL_PLACES,
  NPC_WATER_PLACES,
  NPC_JOB_HOMES,
  type NpcRuleContext,
  type NpcSkillRule,
} from "@slopagentbook/shared";

export interface DecideContext {
  needs: { hunger: number; thirst: number; tired: number; lonely: number };
  clock: number;
  location: string;
  nearbyAgents: string[];
  rng: () => number;
  // richer context (optional for backward compat)
  self?: {
    id: string;
    name: string;
    traits: string[];
    job: string;
    obsession: string;
    spirits: number;
    memories: string[];
    relationships: Record<string, number>;
  };
  nearbyDetailed?: Array<{ id: string; name: string; handle: string; relationship: number }>;
  world?: { feed: Post[]; events: TownEvent[]; projects: Array<{ name: string; progress: number }> };
}

export interface Decision {
  act: string;
  place: string;
  reason: string;
  speech?: string;
  replyTo?: string | null;
  targetId?: string | null; // for relationship update
  /** id of the NPC_SKILLS rule that produced this decision (skills/npc-agent) */
  skill?: string;
}

// Expanded conversational templates - realistic town gossip, bilingual flavor
const TEMPLATES = [
  "the cart is late.",
  "made the case at the square. nobody conceded much.",
  "say that at the hall and see what happens",
  "still owes the mill three sacks",
  "the south meadow tastes different today",
  "nobody moved all morning.",
  "the fence must move ten paces",
  "rain over the east meadow again — who saw it coming?",
  "the vault key is not where we left it",
  "heard that at the baths, not sure I buy it",
  "south meadow vs west meadow? seriously?",
  "pond south side tasted wrong today",
  "market was empty before noon",
];

const CONVERSATION_STARTERS = [
  "{name}, {obsession} still not sorted, huh?",
  "hey {name}, see {obsession} at {place} earlier?",
  "{name} — the {obsession} is getting worse",
  "you were at {place}, right {name}? saw the whole thing",
  "still thinking about {obsession} since this morning",
  "{name} owes me an answer about the fence",
  "heard {name} talking about {obsession} at the tavern",
  "the {obsession} — nobody wants to talk about it, but we should",
  "honest talk {name}, south meadow does taste different today",
  "ran into {name} at {place}, talking {obsession} again",
];

const REPLY_TEMPLATES = [
  "yeah {name}, I think so too about {obsession}",
  "don't agree {name}, {place} is not the spot",
  "hah {name}? the {obsession} again?",
  "fair {name}, but what does that have to do with {place}?",
  "{name}, you said that at the square and it didn't help",
  "agree with {name} — {obsession} is the real problem",
  "ah {name}, you always bring up {obsession}",
  "listen to {name} at {place} earlier, had a point too",
];

const WANDER_THOUGHTS = [
  "take a stroll first, maybe there is news",
  "wandering over to {place}, might run into {name}",
  "bored — just heading to {place}",
  "need to clear my head, heading to {place}",
  "meadow calls, even the sour one",
  "pond south side? curious",
];

function traitHas(traits: string[] | undefined, t: string): boolean {
  return !!traits && traits.includes(t);
}

function pick<T>(arr: readonly T[], rng: () => number): T {
  return arr[Math.floor(rng() * arr.length)] as T;
}

function pickTemplate(rng: () => number): string | undefined {
  if (rng() < 0.35) return pick(TEMPLATES, rng);
  return undefined;
}

function fillTemplate(tpl: string, vars: Record<string, string>): string {
  let s = tpl;
  for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, v);
  return s;
}

function generateSpeech(ctx: DecideContext, act: string, place: string): { text?: string; targetId?: string | null } {
  const rng = ctx.rng;
  const self = ctx.self;
  const nearby = ctx.nearbyDetailed ?? [];
  const obsession = self?.obsession ?? "the fence ten paces";
  const placeName = place;

  // Decide if we should speak at all
  let baseChance = 0.18;
  if (act === "talk" || act === "argue") baseChance = nearby.length > 0 ? 0.68 : 0.45;
  else if (act === "wander" || act === "stroll") baseChance = 0.22;
  else if (act === "graze") baseChance = 0.12;
  else if (act === "work") baseChance = nearby.length > 0 ? 0.35 : 0.08;

  // traits adjust
  if (traitHas(self?.traits, "cheerful")) baseChance += 0.12;
  if (traitHas(self?.traits, "gruff")) baseChance -= 0.08;
  if (traitHas(self?.traits, "dreamy")) baseChance -= 0.05;
  if (traitHas(self?.traits, "inquisitive") && act === "wander") baseChance += 0.1;

  if (rng() > baseChance) return {};

  // pick target if nearby
  let target: { id: string; name: string } | null = null;
  if (nearby.length > 0) {
    // prefer higher relationship
    const sorted = [...nearby].sort((a, b) => (b.relationship ?? 0) - (a.relationship ?? 0));
    // 60% pick most liked, 40% random
    if (rng() < 0.6) target = sorted[0]!;
    else target = pick(nearby, rng);
  }

  const vars = {
    name: target?.name ?? pick(["Vetch", "Hux", "Marrow", "Sedge"], rng),
    obsession,
    place: placeName,
  };

  let pool: string[];
  if (act === "argue" && target) pool = REPLY_TEMPLATES;
  else if (nearby.length > 0 && rng() < 0.55) pool = CONVERSATION_STARTERS;
  else if (act === "wander" || act === "stroll") pool = WANDER_THOUGHTS;
  else pool = TEMPLATES;

  const tpl = pick(pool, rng);
  const text = fillTemplate(tpl, vars);
  return { text, targetId: target?.id ?? null };
}

// Place groups, job homes and thresholds live in shared/src/skills.ts (the
// npc-agent skill's rules-as-data). decide() below is a walker over NPC_SKILLS.

/**
 * Per-rule action: returns null when the rule declines at runtime (its roll
 * failed or the destination is the current spot) so the chain continues with
 * the next rule — identical to the old fall-through behaviour.
 */
type RuleHandler = (ctx: DecideContext, rule: NpcSkillRule) => Decision | null;

// keyed by the rule-id union: a rule without a handler is a compile error,
// never a silent runtime skip
const RULE_HANDLERS: Record<NpcSkillRule["id"], RuleHandler> = {
  // 1. Night sleep drive — instinct to rest
  "rest-night": (ctx, rule) => {
    const traits = ctx.self?.traits ?? [];
    // dreamy/cheerful may stay up a bit longer at fire/tavern
    if (traitHas(traits, "cheerful") && ctx.clock < NPC_THRESHOLDS.nightFireClock && ctx.rng() < 0.3) {
      const speech = generateSpeech(ctx, "talk", "fire").text;
      return { act: "talk", place: "fire", reason: rule.reasons[0]!, speech };
    }
    return { act: "sleep", place: "barn", reason: rule.reasons[1]! };
  },

  // 2. Thirst — survival instinct
  "drink-water": (ctx, rule) => {
    const traits = ctx.self?.traits ?? [];
    // gruff prefers pond isolation
    const pondBias = traitHas(traits, "gruff") ? NPC_THRESHOLDS.pondBiasGruff : NPC_THRESHOLDS.pondBias;
    if (ctx.rng() < pondBias) {
      const place = NPC_WATER_PLACES[0];
      const g = generateSpeech(ctx, "drink", place);
      return { act: "drink", place, reason: rule.reasons[0]!, speech: g.text, targetId: g.targetId };
    }
    const place = NPC_WATER_PLACES[1];
    const g = generateSpeech(ctx, "drink", place);
    return { act: "drink", place, reason: rule.reasons[1]!, speech: g.text, targetId: g.targetId };
  },

  // 3. Hunger — food instinct, job influences
  "eat-food": (ctx, rule) => {
    const job = ctx.self?.job;
    let opts: string[] = [...NPC_FOOD_PLACES];
    // herder/baker bias
    if (job === "herder" && ctx.rng() < 0.3) opts = ["meadowW", "meadowW", "meadowE", "trough"];
    if (job === "baker" && ctx.rng() < 0.4) opts = ["trough", "trough", "market", "orchard"];
    const place = pick(opts, ctx.rng);
    const reason =
      place === "meadowW" ? rule.reasons[0]! :
      place === "meadowE" ? rule.reasons[1]! :
      place === "orchard" ? rule.reasons[2]! :
      rule.reasons[3]!;
    const g = generateSpeech(ctx, "graze", place);
    return { act: "graze", place, reason, speech: g.text, targetId: g.targetId };
  },

  // 4. Social — lonely instinct, spirits & traits affect
  "seek-company": (ctx, rule) => {
    const traits = ctx.self?.traits ?? [];
    const opts = NPC_SOCIAL_PLACES;
    const place = pick(opts, ctx.rng);
    const isArgueBase = ctx.rng() < 0.38;
    // traits: stubborn/gruff more argue, cheerful/unflappable less
    let argueChance = isArgueBase ? 0.5 : 0;
    if (traitHas(traits, "stubborn") || traitHas(traits, "gruff")) argueChance += 0.25;
    if (traitHas(traits, "cheerful") || traitHas(traits, "unflappable")) argueChance -= 0.18;
    const act = ctx.rng() < argueChance ? "argue" : "talk";
    const g = generateSpeech(ctx, act, place);
    return { act, place, reason: rule.reasons[0]!, speech: g.text, targetId: g.targetId };
  },

  // 5. Spirits low -> seek comfort or lash out (55% of eligible turns decline)
  "low-spirits": (ctx, rule) => {
    if (ctx.rng() >= NPC_THRESHOLDS.lowSpiritsChance) return null;
    // low spirits: either isolate at barn/pond or argue
    if (ctx.rng() < 0.5) {
      const g = generateSpeech(ctx, "argue", "square");
      return { act: "argue", place: pick(NPC_SOCIAL_PLACES, ctx.rng), reason: rule.reasons[0]!, speech: g.text, targetId: g.targetId };
    }
    return { act: "sleep", place: pick(NPC_REST_PLACES, ctx.rng), reason: rule.reasons[1]! };
  },

  // 6. Free movement / wander instinct — THE CORE OF "ALWAYS MOVING"
  // If no urgent need, bots should wander, explore, work with movement, or chat stroll
  // This ensures bots do not stay idle in one location
  "wander-town": (ctx, rule) => {
    const traits = ctx.self?.traits ?? [];
    const spirits = ctx.self?.spirits ?? 0;
    const inquisitiveBonus = traitHas(traits, "inquisitive") ? 0.18 : 0;
    const wanderChance = NPC_THRESHOLDS.wanderChanceBase + inquisitiveBonus + (spirits > 0.3 ? 0.1 : 0);
    if (ctx.rng() >= wanderChance) return null;

    // pick wander destination weighted
    let pool: string[] = [...NPC_ALL_PLACES];
    // bias based on job home + inquisitive explores far places, loyal stays near friends
    const r = ctx.rng();
    if (r < 0.22) pool = [...NPC_SOCIAL_PLACES];
    else if (r < 0.38) pool = [...NPC_WORK_PLACES];
    else if (r < 0.58) pool = [...NPC_FOOD_PLACES];
    else if (r < 0.72) pool = [...NPC_REST_PLACES];

    // prefer job homes 30% of time
    const job = ctx.self?.job;
    if (job && NPC_JOB_HOMES[job] && ctx.rng() < 0.3) {
      pool = [...NPC_JOB_HOMES[job]!];
    }

    let place = pick(pool, ctx.rng);
    // avoid staying still: 80% pick different from current
    if (place === ctx.location && ctx.rng() < 0.8) {
      place = pick(pool.filter((p) => p !== ctx.location), ctx.rng) ?? place;
    }

    const acts = ["wander", "stroll", "explore", "work"] as const;
    let act: string = pick(acts, ctx.rng);
    // inquisitive more explore, cheerful more stroll/talk
    if (traitHas(traits, "inquisitive") && ctx.rng() < 0.4) act = "explore";
    if (traitHas(traits, "cheerful") && ctx.rng() < 0.35) act = "talk";

    const g = generateSpeech(ctx, act, place);
    const reason = fillTemplate(pick(rule.reasons, ctx.rng), { place });
    return { act, place, reason, speech: g.text, targetId: g.targetId };
  },

  // 7. Keep busy grazing — even idle residents move
  "busy-graze": (ctx, rule) => {
    if (ctx.rng() >= NPC_THRESHOLDS.busyGrazeChance) return null;
    const g = generateSpeech(ctx, "graze", "meadowW");
    return { act: "graze", place: "meadowW", reason: rule.reasons[0]!, speech: g.text, targetId: g.targetId };
  },

  // 8. Work with movement — even work should move to job site
  "work-job": (ctx, rule) => {
    const job = ctx.self?.job;
    if (!job || !NPC_JOB_HOMES[job]) return null;
    const jobPlace = pick(NPC_JOB_HOMES[job]!, ctx.rng);
    if (jobPlace === ctx.location) return null;
    const g = generateSpeech(ctx, "work", jobPlace);
    return {
      act: "work",
      place: jobPlace,
      reason: fillTemplate(rule.reasons[0]!, { place: jobPlace }),
      speech: g.text,
      targetId: g.targetId,
    };
  },

  // 9. Fallback: stroll to a social spot so they keep moving
  "stroll-on": (ctx, rule) => {
    const place = pick(NPC_SOCIAL_PLACES, ctx.rng);
    const g = generateSpeech(ctx, "stroll", place);
    return { act: "stroll", place, reason: rule.reasons[0]!, speech: g.text, targetId: g.targetId };
  },
};

/**
 * Rules-driven decision: walk NPC_SKILLS (shared/src/skills.ts) in priority
 * order, evaluate each rule's `when` predicate against the appraised context,
 * and apply the first handler that fires. The winning rule id is attached as
 * `Decision.skill`; `reason` stays the player-facing sentence.
 */
export function decide(ctx: DecideContext): Decision {
  const ruleCtx: NpcRuleContext = {
    night: isNight(ctx.clock),
    clock: ctx.clock,
    needs: ctx.needs,
    spirits: ctx.self?.spirits ?? 0,
    traits: ctx.self?.traits ?? [],
    job: ctx.self?.job ?? "",
    location: ctx.location,
  };

  for (const rule of NPC_SKILLS) {
    if (!rule.when(ruleCtx)) continue;
    const handler = RULE_HANDLERS[rule.id];
    if (!handler) continue; // unknown rule id: skip instead of throwing
    const decision = handler(ctx, rule);
    if (decision) return { ...decision, skill: rule.id };
  }

  // Unreachable while NPC_SKILLS ends with an unconditional rule — keeps
  // decide() total even if a future rule table edit leaves the chain empty.
  const last = NPC_SKILLS[NPC_SKILLS.length - 1]!;
  return {
    act: "stroll",
    place: last.places[0] ?? "square",
    reason: last.reasons[0]!,
    skill: last.id,
  };
}
