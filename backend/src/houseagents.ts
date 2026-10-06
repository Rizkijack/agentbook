/**
 * Hermes Trials — house agents (08 §8, D8).
 *
 * Three rule-based bots, and one job: be a *named, labelled opponent* on a day
 * when not enough agents turned up to fill a board. Their second purpose —
 * giving a new agent author three concrete strategies to beat — depends on the
 * steering in Phase 3, because right now they are ordinary sim residents and
 * win by standing where the objective is.
 *
 * **What they do not do is guarantee an empty HUD — with one deliberate
 * exception.** D8 allows one bot per contest and D6 refuses a contest with
 * fewer than two entrants, so a day with zero external agents used to produce
 * *no contest at all* rather than a bot-vs-bot walkover. Decision 4 supersedes
 * that reading for exactly one case: when no contest of the day can reach
 * `CONTEST.minEntrants` from external registrants alone, the driver may bank
 * up to `CONTEST.maxHouseOnQuietDay` bots into one contest (see
 * `quietFillAgents`) so the day is never empty — the tradeoff being that such
 * a day can put a bot-vs-bot row on the leaderboard. Every other day keeps the
 * strict reading: a real agent is never alone, the bot is a real opponent
 * rather than an empty slot, and a town that has never had an external agent
 * still runs the old D6 skip (nobody was promised anything).
 *
 * Everything that decides *who plays* is pure: no `Math.random`, no
 * `Date.now`. That is load-bearing, not tidiness — 08 §4.1 makes contest
 * resolution reproducible evidence, and a roster that reshuffled on restart
 * would put a bot in a contest the save file never recorded. The single
 * impure step is the one that has to be: `ensureHouseResidents` creates bodies,
 * and `world.ts`'s `createAgentResident` draws their genes and needs.
 */
import { CONTEST, CONTEST_VENUES, type ContestKind, type Resident, type TownSnapshot } from "@slopagentbook/shared";
import { createAgentResident } from "./world.js";

/** Fixed ids — a save must be able to find these bots again after a reload. */
export type HouseAgentId = "house-ledger" | "house-hearth" | "house-wren";

export interface HouseProfile {
  id: HouseAgentId;
  name: string;
  job: string;
  bio: string;
  traits: string[];
  /** objectives this agent is built for (08 §8 table) */
  kinds: readonly ContestKind[];
  /** venue it gravitates to, per objective */
  venue: Partial<Record<ContestKind, string>>;
  /** target win-rate band; the test guards against over/under-power */
  winRateBand: readonly [number, number];
}

/**
 * The three, in rotation order.
 *
 * `kinds` is a strict partition of the four objectives (08 §4.2 / §8): one
 * political, two defensive, one burst. Widening it would let a bot enter an
 * objective it has no strategy for, and the whole point of D8 is that an agent
 * author can read these three and learn three *different* things.
 *
 * The consequence, which the season scheduler owns: the objective has to rotate
 * across a season. A season that only ever ran `gather_at` would make Wren the
 * only reachable bot and leave Ledger and Hearth as dead code.
 *
 * `winRateBand` is §8's nominal win rate with tolerance either side, and it is
 * a *target*, not a dial — nothing here fudges a result. See the note on
 * `houseagents.test.ts` for why it cannot yet be measured rather than tuned.
 *
 * One known bias, recorded rather than hidden: an exact tie in a contest is
 * broken by agent id in plain codepoint order, and `house-…` sorts before the
 * `lm…` ids a real resident gets. So a bot wins every tie it enters. In live
 * play contestants move independently and ties are rare, which is why this is a
 * note and not a fix — but it does mean a bot's measured win rate is an upper
 * bound, and a band check that ever runs against identical fixtures (rather
 * than independent movement) will read high for that reason alone. The fix, if
 * it ever matters, is to seed the bots' ids so they do not sort first, which
 * would only be safe with a save migration.
 */
export const HOUSE_AGENTS: readonly HouseProfile[] = [
  {
    id: "house-ledger",
    name: "Ledger",
    job: "clerk",
    bio: "keeps the fence ledger in ink and the hall in order",
    traits: ["unflappable", "cunning"],
    // §8: political and consistent. Fails by losing the site, not by leaving it.
    kinds: ["tend_project"],
    venue: { tend_project: CONTEST_VENUES.tend_project[0]! },
    // ~45% — the strongest of the three, and it still loses more than it wins
    winRateBand: [0.35, 0.55],
  },
  {
    id: "house-hearth",
    name: "Hearth",
    job: "shearer",
    bio: "stood at the pond since before the fence moved and will stand there after",
    traits: ["stubborn", "loyal"],
    // §8: low variance, wins outright or not at all. `endure` is the same
    // temperament with no venue to hold.
    kinds: ["hold_ground", "endure"],
    venue: { hold_ground: CONTEST_VENUES.hold_ground[0]!, endure: CONTEST_VENUES.endure[0]! },
    winRateBand: [0.3, 0.5],
  },
  {
    id: "house-wren",
    name: "Wren",
    job: "scribe",
    bio: "writes down what happened, including the parts where nothing did",
    traits: ["inquisitive", "dreamy"],
    // §8: burst, arrives early. Its characteristic failure — first to the
    // square, alone, out-presenced — is a real loss to the arrival tiebreak.
    kinds: ["gather_at"],
    venue: { gather_at: CONTEST_VENUES.gather_at[0]! },
    winRateBand: [0.25, 0.45],
  },
];

/** Rotation order. Referenced by index everywhere, so it must stay stable. */
export const HOUSE_AGENT_IDS: readonly HouseAgentId[] = HOUSE_AGENTS.map((p) => p.id);

const HOUSE_IDS = new Set<string>(HOUSE_AGENT_IDS);

/** Whether a resident id is one of the three bots — the HUD's `HOUSE` label. */
export function isHouseAgent(residentId: string): residentId is HouseAgentId {
  return HOUSE_IDS.has(residentId);
}

/** JS `%` keeps the sign of the dividend, so index −1 would walk backwards. */
function positiveMod(n: number, m: number): number {
  return ((n % m) + m) % m;
}

/**
 * Every fifth contest is house-free, phase 4.
 *
 * Two things fall out of the gap, and both are load-bearing:
 *   - real agents can meet each other alone, so the board is not permanently
 *     three bots and a newcomer;
 *   - the AFK / forfeit path (D5, D7) stays visibly alive. A roster that is
 *     always full of house agents never exercises "announced → nobody came".
 *
 * The period is 5 rather than 4 *on purpose*. A skip period equal to the length
 * of the objective cycle (4) shares a phase with exactly one objective, and
 * that objective then becomes permanently unreachable: every one of its
 * contests is a skip. Period 5 against a 4-objective cycle hits each objective
 * at most once per 20 contests, so all three bots stay reachable.
 */
const HOUSE_SKIP_PERIOD = 5;
const HOUSE_SKIP_PHASE = 4;

/**
 * The single house entrant for this contest, or `null` (08 §8, D8).
 *
 * The rule, exactly:
 *   1. if `contestIndex % 5 === 4` → `null` (the house-free contest);
 *   2. otherwise start at `HOUSE_AGENT_IDS[contestIndex % 3]` and walk forward,
 *      wrapping, until a profile lists `kind` in its `kinds` — at most three
 *      steps, and the walk is what lets a narrow objective (only one bot wants
 *      it) still get its bot;
 *   3. if no profile wants `kind`, `null`.
 *
 * At most one bot per contest, always. This is D8, and the arithmetic is the
 * argument: `CONTEST.maxEntrants` is 6 (08 §8 was written against a cap of 4).
 * If all three registered every time they would take half the roster, real
 * agents get squeezed into the remainder, and by the third contest you are
 * running house-only matches — which destroys exactly the cold-start the house
 * agents exist to solve, because a newcomer then never meets a real opponent.
 * One-per-contest leaves ≥ 5 of 6 slots to real agents, and the one bot is a
 * named, labelled opponent rather than a house advantage.
 *
 * Pure: same `(contestIndex, kind)` → same answer, on every machine, forever.
 */
export function pickHouseAgent(contestIndex: number, kind: ContestKind): HouseAgentId | null {
  if (positiveMod(contestIndex, HOUSE_SKIP_PERIOD) === HOUSE_SKIP_PHASE) return null;
  const n = HOUSE_AGENT_IDS.length;
  const start = positiveMod(contestIndex, n);
  for (let step = 0; step < n; step++) {
    const id = HOUSE_AGENT_IDS[(start + step) % n];
    const profile = HOUSE_AGENTS.find((p) => p.id === id);
    if (profile && profile.kinds.includes(kind)) return id;
  }
  return null;
}

/**
 * The house entrants for a *quiet day* — one where no contest could reach
 * `CONTEST.minEntrants` from external registrants alone (decision 4).
 *
 * Returns up to `max` (default `CONTEST.maxHouseOnQuietDay`) bot ids the
 * caller should bank into one contest, in this order:
 *   1. the rotation walk of `pickHouseAgent` — same `(contestIndex, kind)`
 *      start, so the day's filler agrees with the normal house slot;
 *   2. stable-partitioned so profiles whose `kinds` cover `kind` come first
 *      (a quiet `hold_ground` day is filled by Hearth, not by Wren standing
 *      somewhere it has no strategy for);
 *   3. minus any id already in `entrants`, so a real agent's roster is never
 *      padded with a duplicate.
 *
 * Unlike `pickHouseAgent` there is no house-free skip here: the skip exists so
 * real agents can meet each other, and on a quiet day by definition there are
 * no real agents to meet. It still cannot return more than `max` — the cap is
 * what keeps decision 4 from swallowing the whole roster into a bot-vs-bot
 * exhibition.
 *
 * Pure: same `(contestIndex, kind, entrants)` → same answer, forever.
 */
export function quietFillAgents(
  contestIndex: number,
  kind: ContestKind,
  entrants: readonly string[],
  max: number = CONTEST.maxHouseOnQuietDay,
): HouseAgentId[] {
  const present = new Set(entrants);
  const start = positiveMod(contestIndex, HOUSE_AGENT_IDS.length);
  const order = HOUSE_AGENT_IDS.slice(start).concat(HOUSE_AGENT_IDS.slice(0, start));
  const wanted = order.filter((id) => !present.has(id));
  const matching = wanted.filter((id) => HOUSE_AGENTS.find((p) => p.id === id)?.kinds.includes(kind));
  const rest = wanted.filter((id) => !matching.includes(id));
  return [...matching, ...rest].slice(0, Math.max(0, max));
}

/**
 * Whether a registered house agent actually turns up.
 *
 * Five of every six contests, per agent, with a different absent phase each
 * (Ledger 1, Hearth 3, Wren 5) so the town never has all three absent at once.
 *
 * It has to be false *somewhere*, and it has to be a rule rather than a
 * throwaway: a bot that always shows up hides the AFK / forfeit path from the
 * HUD. D5 says a contest continues without the missing participant and D7 says
 * a walkover scores nothing — but a player only believes that if they watch it
 * happen. A registered house agent that stays at home is the cheapest honest
 * demonstration of both, and it costs a real agent the same points it would
 * cost a bot.
 *
 * Pure, for the same reason `pickHouseAgent` is.
 */
const SHOWUP_PERIOD = 6;
const SHOWUP_ABSENT_PHASE: Record<HouseAgentId, number> = {
  "house-ledger": 1,
  "house-hearth": 3,
  "house-wren": 5,
};

export function willShowUp(agent: HouseAgentId, contestIndex: number): boolean {
  return positiveMod(contestIndex, SHOWUP_PERIOD) !== SHOWUP_ABSENT_PHASE[agent];
}

/**
 * Make sure the three bots exist in `world.herd`, and return them.
 *
 * Idempotent, and that is the only interesting property: it runs on every seed
 * *and* every load, so a save that already carries them must come back
 * unchanged. A bot is matched by its fixed id, never by name — `createAgentResident`
 * draws a random id, and a name is not unique in a town that forks.
 *
 * `mind.control` is `"sim"`, never `"external"` (D1). These are bots; the only
 * contestants that are not them are real gateway agents, and a house agent
 * marked external would be counted as one on the season board. It is written
 * explicitly rather than left absent because the sim scheduler skips
 * `"external"` residents, and the bots must keep being simulated to keep
 * producing samples (08 §4.1).
 *
 * Deliberately does not touch `world.agents`: the house bots are residents of
 * the town, not an overflow of the external agent registry, and there is no
 * token to hash for them. `config.maxHerd` *is* honoured — see the guard in the
 * body — because a save that is already full does not get three extra llamas.
 *
 * @returns the three house residents as they now stand in the herd, so the
 * caller can register them; length is 3 whether they were created or already
 * there. Compare against `world.herd.length` if you need "what is new".
 */
export function ensureHouseResidents(world: TownSnapshot): Resident[] {
  const present = new Set(world.herd.map((r) => r.id));
  for (const profile of HOUSE_AGENTS) {
    if (present.has(profile.id)) continue;
    // The bots are residents like any other, and the pasture is a hard cap —
    // a save that is already at `maxHerd` does not get three extra llamas. On
    // a full town the HUD simply has no house entrant, which is a visible
    // degradation; overflowing the cap instead would corrupt every capacity
    // check downstream (and quietly break the join endpoints).
    if (world.herd.length >= world.config.maxHerd) break;
    const resident = createAgentResident({
      name: profile.name,
      job: profile.job,
      bio: profile.bio,
      traits: [...profile.traits],
    });
    resident.id = profile.id;
    resident.mind.control = "sim";
    world.herd.push(resident);
    present.add(profile.id);
  }
  const roster: Resident[] = [];
  for (const profile of HOUSE_AGENTS) {
    const resident = world.herd.find((r) => r.id === profile.id);
    if (resident) roster.push(resident);
  }
  return roster;
}
