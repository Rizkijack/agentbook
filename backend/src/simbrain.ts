import { isNight } from "./needs.js";
import type { Post, TownEvent } from "@hermesbook/shared";

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

// Job -> preferred locations (instinct homes)
const JOB_HOMES: Record<string, string[]> = {
  shearer: ["shed", "pens", "meadowW"],
  miller: ["mill", "trough", "market"],
  librarian: ["library", "press", "school"],
  clerk: ["bank", "hall", "market"],
  baker: ["trough", "market", "orchard"],
  herder: ["meadowW", "meadowE", "pens"],
  scribe: ["press", "library", "hall"],
  smith: ["shed", "mill", "vault"],
  courier: ["station", "square", "post"],
};

const ALL_PLACES = [
  "square", "hall", "market", "tavern", "press", "bank", "vault", "library", "booth", "clinic", "school", "post", "baths", "station", "barn", "shed", "mill", "pens", "pond", "dock", "meadowW", "meadowE", "orchard", "trough", "fire", "board",
];

const SOCIAL_PLACES = ["square", "tavern", "hall", "baths", "fire", "market", "board"] as const;
const FOOD_PLACES = ["trough", "meadowW", "meadowE", "orchard"] as const;
const WATER_PLACES = ["pond", "square"] as const;
const REST_PLACES = ["barn", "pens"] as const;
const WORK_PLACES = ["shed", "mill", "library", "press", "bank", "post", "school", "clinic"] as const;

export function decide(ctx: DecideContext): Decision {
  const { needs, clock, rng } = ctx;
  const self = ctx.self;
  const traits = self?.traits ?? [];
  const spirits = self?.spirits ?? 0;

  // trait thresholds mod
  const tiredThreshold = traitHas(traits, "unflappable") ? 0.45 : traitHas(traits, "dreamy") ? 0.25 : 0.3;
  const lonelyThreshold = traitHas(traits, "loyal") ? 0.45 : traitHas(traits, "gruff") ? 0.7 : 0.55;

  // 1. Night sleep drive — instinct to rest
  if (isNight(clock) && needs.tired > tiredThreshold) {
    // dreamy/cheerful may stay up a bit longer at fire/tavern
    if (traitHas(traits, "cheerful") && clock < 0.8 && rng() < 0.3) {
      const speech = generateSpeech(ctx, "talk", "fire").text;
      return { act: "talk", place: "fire", reason: "night but spirits high at the fire", speech };
    }
    return { act: "sleep", place: "barn", reason: "night is falling, need rest" };
  }

  // 2. Thirst — survival instinct
  if (needs.thirst > 0.6) {
    // gruff prefers pond isolation
    const pondBias = traitHas(traits, "gruff") ? 0.75 : 0.6;
    if (rng() < pondBias) {
      const g = generateSpeech(ctx, "drink", "pond");
      return { act: "drink", place: "pond", reason: "parched, seeking water", speech: g.text, targetId: g.targetId };
    }
    const g = generateSpeech(ctx, "drink", "square");
    return { act: "drink", place: "square", reason: "throat dry, heading to fountain", speech: g.text, targetId: g.targetId };
  }

  // 3. Hunger — food instinct, job influences
  if (needs.hunger > 0.6) {
    let opts = [...FOOD_PLACES] as string[];
    // herder/baker bias
    if (self?.job === "herder" && rng() < 0.3) opts = ["meadowW", "meadowW", "meadowE", "trough"];
    if (self?.job === "baker" && rng() < 0.4) opts = ["trough", "trough", "market", "orchard"];
    const place = pick(opts, rng);
    const reason = place === "meadowW" ? "craving the good grass" : place === "meadowE" ? "sour grass is still grass" : place === "orchard" ? "apples sound right" : "oats at the trough";
    const g = generateSpeech(ctx, "graze", place);
    return { act: "graze", place, reason, speech: g.text, targetId: g.targetId };
  }

  // 4. Social — lonely instinct, spirits & traits affect
  const effectiveLonely = needs.lonely + (spirits < -0.4 ? -0.15 : spirits > 0.4 ? 0.1 : 0);
  if (effectiveLonely > lonelyThreshold) {
    const opts = [...SOCIAL_PLACES] as const;
    const place = pick(opts, rng);
    const isArgueBase = rng() < 0.38;
    // traits: stubborn/gruff more argue, cheerful/unflappable less
    let argueChance = isArgueBase ? 0.5 : 0;
    if (traitHas(traits, "stubborn") || traitHas(traits, "gruff")) argueChance += 0.25;
    if (traitHas(traits, "cheerful") || traitHas(traits, "unflappable")) argueChance -= 0.18;
    const act = rng() < argueChance ? "argue" : "talk";
    const g = generateSpeech(ctx, act, place);
    return { act, place, reason: "feeling lonely, seeking company", speech: g.text, targetId: g.targetId };
  }

  // 5. Spirits low -> seek comfort or lash out
  if (spirits < -0.6 && rng() < 0.45) {
    // low spirits: either isolate at barn/pond or argue
    if (rng() < 0.5) {
      const g = generateSpeech(ctx, "argue", "square");
      return { act: "argue", place: pick(SOCIAL_PLACES, rng), reason: "spirits low, picking a fight", speech: g.text, targetId: g.targetId };
    }
    return { act: "sleep", place: pick(REST_PLACES, rng), reason: "low spirits, need rest" };
  }

  // 6. Free movement / wander instinct — THE CORE OF "ALWAYS MOVING"
  // If no urgent need, bots should wander, explore, work with movement, or chat stroll
  // This ensures bots do not stay idle in one location
  const inquisitiveBonus = traitHas(traits, "inquisitive") ? 0.18 : 0;
  const wanderChance = 0.42 + inquisitiveBonus + (spirits > 0.3 ? 0.1 : 0);
  if (rng() < wanderChance) {
    // pick wander destination weighted
    let pool: string[] = ALL_PLACES as string[];
    // bias based on job home + inquisitive explores far places, loyal stays near friends
    const r = rng();
    if (r < 0.22) pool = SOCIAL_PLACES as unknown as string[];
    else if (r < 0.38) pool = WORK_PLACES as unknown as string[];
    else if (r < 0.58) pool = FOOD_PLACES as unknown as string[];
    else if (r < 0.72) pool = REST_PLACES as unknown as string[];
    else pool = ALL_PLACES;

    // prefer job homes 30% of time
    if (self?.job && JOB_HOMES[self.job] && rng() < 0.3) {
      pool = JOB_HOMES[self.job]!;
    }

    let place = pick(pool, rng);
    // avoid staying still: 80% pick different from current
    if (place === ctx.location && rng() < 0.8) {
      place = pick(pool.filter((p) => p !== ctx.location), rng) ?? place;
    }

    const acts = ["wander", "stroll", "explore", "work"] as const;
    let act: string = pick(acts, rng);
    // inquisitive more explore, cheerful more stroll/talk
    if (traitHas(traits, "inquisitive") && rng() < 0.4) act = "explore";
    if (traitHas(traits, "cheerful") && rng() < 0.35) act = "talk";

    const g = generateSpeech(ctx, act, place);
    const reasons = [
      "out for a walk, need to see what's happening",
      "instinct to move, staying still feels wrong",
      "wandering — town is too quiet",
      `heading to ${place}, curiosity`,
      "catching some air, maybe there is a story",
    ];
    return { act, place, reason: pick(reasons, rng), speech: g.text, targetId: g.targetId };
  }

  // 7. Work with movement — even work should move to job site
  if (rng() < 0.18) {
    const g = generateSpeech(ctx, "graze", "meadowW");
    return { act: "graze", place: "meadowW", reason: "keeping busy with grazing", speech: g.text, targetId: g.targetId };
  }
  // work at job home or wander nearby
  if (self?.job && JOB_HOMES[self.job]) {
    const jobPlace = pick(JOB_HOMES[self.job]!, rng);
    if (jobPlace !== ctx.location) {
      const g = generateSpeech(ctx, "work", jobPlace);
      return { act: "work", place: jobPlace, reason: `work calls at ${jobPlace}`, speech: g.text, targetId: g.targetId };
    }
  }
  // fallback: stroll to nearby social spot so they keep moving
  const fallbackPlace = pick(SOCIAL_PLACES, rng);
  const g = generateSpeech(ctx, "stroll", fallbackPlace);
  return { act: "stroll", place: fallbackPlace, reason: "keeping busy, legs need moving", speech: g.text, targetId: g.targetId };
}
