/**
 * Phase 2 smoke test — plays a whole season against a real world.
 *
 * The unit suites drive `tickTournament` with a hand-built world and a
 * synthetic clock. What they cannot prove is that the pieces fit *together*
 * over a real season: a real herd, real residents moving, real registration, a
 * full day's slate (2–3 contests), both semifinals on their day, the final, a
 * champion and a rollover — all inside `SEASON.seasonDays` in-game days.
 *
 *   pnpm --filter backend exec tsx scripts/smoke-tournament.ts
 */
import { createInitialWorld } from "../src/world.js";
import { joinWorld } from "../src/agents.js";
import { ensureHouseResidents, isHouseAgent, HOUSE_AGENTS } from "../src/houseagents.js";
import { createSeason, rankStandings, qualifiers } from "../src/season.js";
import {
  announceContest,
  forfeitNotice,
  matchupLine,
  registerForContest,
  retireResolved,
  seasonPhase,
  tickTournament,
  upcomingContest,
} from "../src/tournament.js";
import { CONTEST, SEASON, pointsForRank } from "@slopagentbook/shared";
import type { Contest, Season, TownSnapshot } from "@slopagentbook/shared";

// Aligned to a `DAY_LENGTH_SEC` (900s) boundary. The raw `1_700_000_000_000`
// sits 800s into its in-game day, and a slot is 241s — so the second contest
// of every day would silently cross into the next `dayOfYear`, and the whole
// script would be reading a calendar it never meant to play.
const T0 = 1_699_999_200_000;
const TURN = 1_800;
/** one in-game day */
const DAY = 900_000;
/** one slot of a day's slate: announce + live + handover (08 §6, decision 1) */
const SLOT = CONTEST.announceMs + CONTEST.durationMs + 1000;
const SAMPLES_PER_CONTEST = 90;

/** Counters the season-shape checks at the bottom are made of. */
let trialDays = 0;
let semisPlayed = 0;
let finalsPlayed = 0;
const semifinalists = new Set<string>();

function fail(msg: string): never {
  console.error(`\n  ✗ SMOKE FAILED: ${msg}\n`);
  process.exit(1);
}

function check(cond: boolean, msg: string, detail?: unknown): void {
  if (!cond) {
    if (detail !== undefined) console.error("   ", detail);
    fail(msg);
  }
  console.log(`  ✓ ${msg}`);
}

const world: TownSnapshot = createInitialWorld();
// The clock this script ticks and the season's calendar have to agree: the
// phase machine reads `seasonDayPos` out of the ledger's ids, so a season
// anchored on the *real* today would make every synthetic day below a
// non-existent trial day and the bracket would never open.
world.season = createSeason(1, T0);
ensureHouseResidents(world);
check(world.herd.length >= 8, `world booted with ${world.herd.length} residents`);
check(world.herd.filter((r) => isHouseAgent(r.id)).length === 3, "three house bots in the herd");

// Four external agents — enough for a real trial field plus a knockout.
const agents: string[] = [];
for (let i = 0; i < SEASON.semifinalists; i++) {
  agents.push(joinWorld(world, { name: `Smoke${i}`, origin: "smoke" }).resident.id);
}
check(agents.length === SEASON.semifinalists, `${agents.length} external agents joined`);

// --- one contest, start to finish -----------------------------------------
/** Register, go live, sample, resolve. Everything a real client's card does. */
function playContest(c: Contest, at: number, day: number): void {
  // every agent registers in the announce window, as a real client would —
  // `at` matters: the phase is read off the clock, and `Date.now()` would be
  // centuries away from this season's calendar
  for (const id of agents) {
    if (c.state === "announced") registerForContest(world, id, at);
  }
  const roster = upcomingContest(world);
  check(roster?.id === c.id, `day ${day}: contest ${c.kind} @${c.place} is open for registration`);
  check(
    c.entrants.length <= CONTEST.maxEntrants,
    `day ${day}: roster of ${c.entrants.length} is within the cap of ${CONTEST.maxEntrants}`
  );

  const phase = seasonPhase(world.season, at);
  const bots = c.entrants.filter((id) => isHouseAgent(id));
  const field = rankStandings(world.season!)
    .filter((s) => !isHouseAgent(s.agentId))
    .map((s) => s.agentId);
  if (phase === "trials") {
    // D8 is about the trials — a self-registration field takes at most one bot.
    check(
      bots.length <= 1,
      `day ${day}: trials take at most one house bot (D8) — ${c.houseEntrant ?? "none today"}`
    );
  } else {
    // The bracket is seeded from the table (08 §5): two duels, then the final,
    // every seat held by a *real* agent — bots are removed before the cut.
    check(
      c.entrants.length >= 2 && c.entrants.every((id) => field.includes(id)),
      `day ${day}: the ${phase} is seeded from the top of the table (${c.entrants.join(" v ")})`
    );
    check(
      bots.length === 0,
      `day ${day}: no house bot reaches a knockout — a bot holding the trophy is the loudest way to make a board look fake`
    );
    if (phase === "semifinals") {
      semisPlayed++;
      for (const id of c.entrants) semifinalists.add(id);
    } else {
      finalsPlayed++;
    }
  }

  // go live, then sample
  tickTournament(world, c.startsAt);
  for (let i = 0; i < SAMPLES_PER_CONTEST; i++) {
    for (let k = 0; k < c.entrants.length; k++) {
      const r = world.herd.find((h) => h.id === c.entrants[k]);
      if (!r) continue;
      // realistic drift: most of the time near the venue, sometimes elsewhere
      const atVenue = i % 7 !== 0 && (i + k) % 5 !== 0;
      r.mind.doing.place = atVenue ? c.place : "tavern";
    }
    tickTournament(world, c.startsAt + (i + 1) * TURN, i % 11 === 0 ? [c.entrants[1] ?? ""] : []);
  }
  tickTournament(world, c.endsAt + 1);
}

/**
 * Play one whole in-game day's slate — 2–3 serial contests on a trial day,
 * both semifinals on the bracket day, the final alone on its own day.
 *
 * Returns the phase the day opened in, or `null` when nothing was announced.
 */
function playDay(day: number): Season["state"] | null {
  const base = T0 + day * DAY;
  let phase: Season["state"] | null = null;
  let played = 0;
  for (let slot = 0; slot <= CONTEST.perDay.max; slot++) {
    const at = base + slot * SLOT;
    const c = announceContest(world, at);
    if (!c) break; // the day's quota is spent — that is what ends a slate
    phase ??= seasonPhase(world.season, at);
    playContest(c, at, day);
    played++;
    if (world.season?.champion) break;
  }
  if (phase === "trials") {
    trialDays++;
    check(
      played >= CONTEST.perDay.min && played <= CONTEST.perDay.max,
      `day ${day}: the trial slate ran ${played} contests (${CONTEST.perDay.min}–${CONTEST.perDay.max} per day)`
    );
  }
  return phase;
}

// --- day one, in detail ----------------------------------------------------
playDay(0);
const first = world.contests?.find((c) => c.state === "resolved");
check(first?.result !== undefined, "a contest resolved end to end");
if (first?.result) {
  const board = first.result.standings
    .map((s) => `#${s.rank} ${world.herd.find((h) => h.id === s.agentId)?.name ?? s.agentId} ${s.score}pt "${s.detail}"`)
    .join("\n        ");
  console.log(`\n      ${first.kind} @${first.place}\n        ${board}\n`);
  check(first.result.standings.length > 0, "the result has standings");
  check(
    first.result.standings.every((s) => s.score === (first.result!.voidResult ? 0 : pointsForRank(s.rank))),
    "scores follow the rank table, or zero when void (D7)"
  );
  const missing = forfeitNotice(world, first, first.endsAt + 1);
  if (missing) console.log(`      forfeit: ${missing}`);
}
check((world.season?.standings.length ?? 0) > 0, "the season board has points on it");

// --- the rest of the season ------------------------------------------------
let champion: string | null = null;
let championDay = -1;
for (let day = 1; day < SEASON.seasonDays + 1; day++) {
  playDay(day);
  // retire at the *end* of the day: the slate has just finished, and the
  // knockout shield in `retireResolved` keeps the semifinal cards the final
  // still has to read its roster from
  retireResolved(world, T0 + (day + 1) * DAY);
  if (world.season?.champion) {
    champion = world.season.champion;
    championDay = day;
    break;
  }
}

// --- the shape that just ran ------------------------------------------------
check(champion !== null, `a champion emerged on day ${championDay} (${champion ?? "none"})`);
check(
  championDay === SEASON.seasonDays - 1,
  `the season fits its ${SEASON.seasonDays}-day plan — trials days 0..${SEASON.trials - 1}, semis on day ${SEASON.trials}, final on day ${SEASON.seasonDays - 1}`
);
check(trialDays === SEASON.trials, `exactly ${SEASON.trials} trial days ran (got ${trialDays})`);
check(
  semisPlayed === SEASON.semifinals,
  `both semifinals ran (${semisPlayed} of ${SEASON.semifinals})`
);
check(finalsPlayed === 1, `the final ran exactly once (got ${finalsPlayed})`);
check(
  semifinalists.size === SEASON.semifinalists,
  `every qualifier contested a semifinal (${semifinalists.size} of ${SEASON.semifinalists})`
);
check(world.season!.no === 2, `the season rolled over into no ${world.season!.no}`);
check(world.season!.standings.length === 0, "the new season opens with an empty board (D10)");

// --- the shape of the closed season ---------------------------------------
// replay the trials on a copy so the standings can be inspected
const replay = structuredClone(world);
replay.season = { ...createSeason(1, T0), standings: [], appliedContests: [] };
let replayContests = 0;
for (let day = 0; day < SEASON.trials; day++) {
  const base = T0 + day * DAY;
  for (let slot = 0; slot <= CONTEST.perDay.max; slot++) {
    const at = base + slot * SLOT;
    const c = announceContest(replay, at);
    if (!c) break;
    for (const id of agents) if (c.state === "announced") registerForContest(replay, id, at);
    tickTournament(replay, c.startsAt);
    for (let s = 0; s < SAMPLES_PER_CONTEST; s++) {
      for (const id of c.entrants) {
        const r = replay.herd.find((h) => h.id === id);
        if (r) r.mind.doing.place = s % 7 !== 0 ? c.place : "tavern";
      }
      tickTournament(replay, c.startsAt + (s + 1) * TURN);
    }
    tickTournament(replay, c.endsAt + 1);
    replayContests++;
  }
  retireResolved(replay, T0 + (day + 1) * DAY);
}
check(
  replayContests >= SEASON.trials * CONTEST.perDay.min &&
    replayContests <= SEASON.trials * CONTEST.perDay.max,
  `${SEASON.trials} trial days hosted ${replayContests} contests (${CONTEST.perDay.min}–${CONTEST.perDay.max} per day)`
);
const table = rankStandings(replay.season!);
check(table.length > 0, `the trials produced a leaderboard of ${table.length}`);
check(
  table.every((s, i) => i === 0 || table[i - 1]!.points >= s.points),
  "the board is ordered by points, descending"
);
check(
  qualifiers(replay.season!).length === Math.min(SEASON.semifinalists, table.length),
  `the top ${SEASON.semifinalists} qualify — got ${qualifiers(replay.season!).length}`
);
console.log(
  `\n      leaderboard after ${SEASON.trials} trial days (${replayContests} contests):\n` +
    table
      .map(
        (s, i) =>
          `        ${String(i + 1).padStart(2)}. ${(replay.herd.find((h) => h.id === s.agentId)?.name ?? s.agentId).padEnd(9)} ${s.points}pt  ${s.wins}W ${s.losses}L`
      )
      .join("\n")
);

// --- house bots actually turned up -----------------------------------------
const seen = new Set<string>();
for (let i = 0; i < 12; i++) {
  const at = T0 + i * DAY;
  const probe: TownSnapshot = {
    ...world,
    contests: [],
    // Re-anchored so the probe's own day *is* day 0 of its season: without
    // this the clock walks out of the trial days on i ≥ SEASON.trials and the
    // bracket opens instead of a trial contest.
    season: { ...world.season!, appliedContests: new Array(i).fill("x"), startedAt: at },
  };
  const c = announceContest(probe, at);
  // A quiet day banks up to `CONTEST.maxHouseOnQuietDay` bots, so the row —
  // not the single `houseEntrant` field — is what "turned up" means now.
  for (const id of c?.entrants.filter((x) => isHouseAgent(x)) ?? []) seen.add(id);
}
check(
  seen.size === HOUSE_AGENTS.length,
  `all ${HOUSE_AGENTS.length} house bots entered over 12 contests (${[...seen].join(", ")})`
);

// --- the narrative is honest, not invented ---------------------------------
const pair = agents.slice(0, 2);
console.log(`\n      matchup framing: ${matchupLine(world, pair)}`);
check(
  matchupLine(world, pair).includes("never spoken"),
  "a matchup between two agents who never interacted says so"
);

console.log(`\n  SMOKE OK — a full Hermes Trials season runs end to end\n`);
