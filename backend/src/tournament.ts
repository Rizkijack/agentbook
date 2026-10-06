/**
 * Hermes Trials — the tournament driver (08 §2, §5, §7, D1–D8).
 *
 * Phase 1 made resolution a pure function; this is the part that *calls* it. It
 * owns the contest lifecycle — announced → live → resolved — the registration
 * roster, and the season phases.
 *
 * Everything here is a pure function of `(world, now)`. Nothing schedules
 * itself: `server.ts` calls `tickTournament` once per turn and broadcasts
 * whatever comes back. That is deliberate — a setInterval inside this module
 * would make the whole tournament untestable and would drift against the turn
 * loop it is supposed to be sampling.
 */
import {
  CONTEST,
  CONTEST_VENUES,
  SEASON,
  contestsPerDay,
  dayOfYear,
  pointsForRank,
  type Contest,
  type ContestKind,
  type ContestResult,
  type Season,
  type SeasonStanding,
  type TownSnapshot,
} from "@hermesbook/shared";
import { canStart, hasRoom, scoreContest, takeSamples, trimSamples } from "./contest.js";
import { isAfk } from "./agents.js";
import { isHouseAgent, pickHouseAgent, quietFillAgents, willShowUp } from "./houseagents.js";
import {
  applyContestResult,
  appliedContestIds,
  createSeason,
  rankStandings,
  rollSeason,
  seasonContestIndex,
} from "./season.js";

/** Headline for every contest in v1 — see 08 §3, the outcome-layer note. */
const CONTEST_TITLE = "THE HALL ARGUMENT";

/** How many resolved contests the world keeps for the HUD / Daily Spit. */
const KEEP_RESOLVED = 3;

// ---------------------------------------------------------------------------
// spit capture
// ---------------------------------------------------------------------------

/**
 * Spits raised outside the scheduler, waiting to be folded into the next sample.
 *
 * The sim spits from `runTurn` and the server hands that straight to
 * `tickTournament`. The gateway does not go through `runTurn` at all — it calls
 * `applyDecision` directly, and `applyDecision` really does spit (the same
 * neighbour roll lives inside it). Without this buffer `endure` only ever saw
 * the scheduler's spits, and since D1 makes external agents the *only*
 * contestants, the objective was blind on exactly the path that matters: an
 * agent could be spat on through its own `act` and be told it never was.
 *
 * Module-level on purpose and harmless because of it: the worst case is one
 * stale victim id in the next window, and a process restart has no spits to
 * lose. The alternative — a field on the snapshot — would write a transient
 * half-second event into every save.
 */
let pendingSpits: string[] = [];

/** Record that `victimId` was spat on during the current turn. */
export function noteSpit(victimId: string): void {
  if (victimId) pendingSpits.push(victimId);
}

function drainSpits(): string[] {
  if (pendingSpits.length === 0) return [];
  const out = pendingSpits;
  pendingSpits = [];
  return out;
}

// ---------------------------------------------------------------------------
// schedule
// ---------------------------------------------------------------------------

/**
 * The objective for contest #`index`.
 *
 * The rotation is not cosmetic: `houseagents.ts` partitions the four objectives
 * across the three bots, so a season that only ever ran one objective would
 * leave two of them as dead code. Rotating is what makes all three reachable.
 *
 * Deterministic, so a reload cannot reorder a season that was already played.
 */
export function nextContestKind(index: number): ContestKind {
  const kinds: readonly ContestKind[] = ["gather_at", "hold_ground", "tend_project", "endure"];
  return kinds[((index % kinds.length) + kinds.length) % kinds.length]!;
}

/** Venue for contest #`index`, picked from the objective's legal venues. */
export function contestVenue(kind: ContestKind, index: number): string {
  const venues = CONTEST_VENUES[kind];
  return venues[((index % venues.length) + venues.length) % venues.length]!;
}

/** The stage a contest was announced in — the third segment of its id. */
type ContestStage = "trials" | "semifinals" | "final";

/**
 * A contest's home in the save: season, in-game day, **the stage it ran in**,
 * and its index.
 *
 * The day is in the id because a day's slate must be checkable from the data
 * alone: the driver reads the id back to know how many contests this season has
 * already opened today (quota) and which index the next kind/bot rotation
 * deserves. It was not, once: the id used to be `ct-${day}-${index}`, and
 * because the index comes from the season ledger — which grows on every
 * resolve — a second contest on the same day got a *different* id and no rule
 * could be expressed over "today" at all.
 *
 * **The stage letter (`i` trials / `s` semifinal / `f` final) is what the phase
 * machine reads back, and that is load-bearing.** It used to infer the stage
 * from *where the id sat on the calendar* (`seasonDayPos === SEASON.trials`
 * meant "a semifinal"), which is only true if every day of the plan produced a
 * scored contest. Two failures followed, both reachable through 08 §15's main
 * risk — nobody showing up:
 *
 *  - trials that finished *late* left trial ids parked on the calendar's
 *    bracket days; those counted as semifinals and as "past the semifinal
 *    day", so the season closed with the board leader as champion and the
 *    bracket never ran;
 *  - a bracket opened *after* its planned day never matched
 *    `seasonDayPos === SEASON.trials` again, so the semifinals were never
 *    counted and the season announced two more a day forever while
 *    `retireResolved` shielded every card — a wedge, and a save that grew
 *    without bound.
 *
 * A date says when. Only the id can say *what*.
 *
 * The season number earns its place too: without it the id repeats every time
 * the ledger resets, and once a year when `dayOfYear` wraps.
 */
function contestId(seasonNo: number, day: number, index: number, stage: ContestStage): string {
  return `ct-s${seasonNo}-d${day}-${stage === "trials" ? "i" : stage === "semifinals" ? "s" : "f"}${index}`;
}

/** The prefix shared by every contest belonging to one season-day. */
function dayKey(seasonNo: number, day: number): string {
  return `ct-s${seasonNo}-d${day}-`;
}

function liveContest(world: TownSnapshot): Contest | undefined {
  return world.contests?.find((c) => c.state !== "resolved");
}

function residentOf(world: TownSnapshot, id: string) {
  return world.herd.find((h) => h.id === id);
}

// ---------------------------------------------------------------------------
// narrative framing (08 §7.1)
// ---------------------------------------------------------------------------

/**
 * "Hux  v  Tux — old rivals, the ledger still carries it."
 *
 * Cosmetic by design (08 §7.1): it never touches scoring, it exists so a
 * leaderboard does not read like a spreadsheet. The relationship lookup is
 * between two *residents*; an agent only builds a relationship by acting or
 * speaking, so a matchup between two fresh agents honestly reports "never
 * spoken" instead of inventing history.
 */
export function matchupLine(world: TownSnapshot, entrants: readonly string[]): string {
  if (entrants.length < 2) return "";
  const left = residentOf(world, entrants[0]!);
  const right = residentOf(world, entrants[1]!);
  if (!left || !right) return "";
  const rel = left.mind.relationships[right.id] ?? 0;
  const history =
    rel <= -0.5
      ? "old rivals — the ledger still carries it"
      : rel >= 0.5
        ? "old friends, which is its own kind of tension"
        : "never spoken";
  return `${left.name}  v  ${right.name} — ${history}`;
}

// ---------------------------------------------------------------------------
// registration (08 §7, D4, D6)
// ---------------------------------------------------------------------------

export interface RegisterOutcome {
  ok: boolean;
  status: number;
  error?: string;
  contest?: Contest;
}

/**
 * D1: only external agents compete. Residents are the audience (08 §9), and the
 * house bots enter by rotation rather than by registering — see
 * `announceContest`.
 */
function isEligibleContestant(world: TownSnapshot, residentId: string): boolean {
  return residentOf(world, residentId)?.mind.control === "external";
}

/**
 * D4: agents register themselves for the next open contest.
 *
 * The cap is `hasRoom` and it belongs *here* rather than in `canStart`, so a
 * full roster turns the latecomer away instead of vetoing the contest for
 * everyone already on the board.
 *
 * `now` exists for the same reason `announceContest` takes it: whether the
 * roster is open is a question about the calendar (a knockout fixes its
 * field), and the caller's clock is the only one that knows what day it is.
 * Defaults to the wall clock, which is what the gateway — with no clock of its
 * own to pass — gets.
 */
export function registerForContest(world: TownSnapshot, residentId: string, now = Date.now()): RegisterOutcome {
  const contest = liveContest(world);
  if (!contest) return { ok: false, status: 409, error: "no contest is open for registration" };
  if (contest.state !== "announced") {
    // D5: the contest continues without you. Rewriting the roster after go-live
    // would break the promise the other contestants were given.
    return { ok: false, status: 409, error: "the contest has already started" };
  }
  if (!isOpenToRegistration(seasonPhase(world.season, now))) {
    // A knockout field is decided by the table, not by who was awake during a
    // 60-second window. Letting anyone register here would pad the bracket past
    // `SEASON.semifinalists` and hand a qualifier's place to a bystander.
    return { ok: false, status: 409, error: "this round is decided by the standings — the roster is closed" };
  }
  if (!isEligibleContestant(world, residentId)) {
    return { ok: false, status: 403, error: "only external agents may compete (D1)" };
  }
  if (contest.entrants.includes(residentId)) return { ok: true, status: 200, contest };
  if (!hasRoom(contest.entrants)) {
    return { ok: false, status: 409, error: "the roster is full" };
  }
  contest.entrants.push(residentId);
  contest.narration = matchupLine(world, contest.entrants) || contest.narration;
  return { ok: true, status: 200, contest };
}

/** Withdraw while the contest is still `announced`; after go-live it is refused. */
export function withdrawFromContest(world: TownSnapshot, residentId: string): RegisterOutcome {
  const contest = liveContest(world);
  if (!contest) return { ok: false, status: 404, error: "no contest is open" };
  if (contest.state !== "announced") {
    return { ok: false, status: 409, error: "too late to withdraw — the contest is already under way" };
  }
  if (!contest.entrants.includes(residentId)) {
    return { ok: false, status: 404, error: "you are not registered" };
  }
  contest.entrants = contest.entrants.filter((id) => id !== residentId);
  if (contest.houseEntrant === residentId) contest.houseEntrant = undefined;
  contest.narration = matchupLine(world, contest.entrants);
  return { ok: true, status: 200, contest };
}

/** Public view of the next contest and who is in it (08 §7). */
export function upcomingContest(world: TownSnapshot): Contest | null {
  return liveContest(world) ?? null;
}

// ---------------------------------------------------------------------------
// season phases (08 §5, format A — day-driven)
// ---------------------------------------------------------------------------

/**
 * The in-game day a contest id belongs to, or `null` when the id is not in
 * the `ct-s{season}-d{day}-{stage}{index}` shape.
 *
 * The id is the schedule's memory of *when* a contest ran, and the phase
 * machine reads it back: `SEASON.trials` counts DAYS now, so the ledger has to
 * say which days its contests landed on. The pre-Phase-2 `ct-{day}-{index}`
 * shape parses too — a save that predates the rewrite must not lose its
 * history (and a genuinely unrecognised id returns `null`, which callers treat
 * as "unknown day", never as day 0).
 */
export function dayOfContestId(id: string): number | null {
  const current = /^ct-s\d+-d(\d+)-[isf]\d+$/.exec(id);
  if (current) return Number(current[1]);
  const legacy = /^ct-(\d+)-\d+$/.exec(id);
  if (legacy) return Number(legacy[1]);
  return null;
}

/**
 * The stage a contest ran in, read straight out of its id (`i`/`s`/`f`).
 *
 * `null` means "not a `ct-s…` id" — a legacy `ct-{day}-{index}` or a fixture
 * id. An id with no stage is never mistaken for a bracket one: the worst that
 * happens is it counts as history, never as a semifinal that was not played.
 */
function stageOfContestId(id: string): ContestStage | null {
  const m = /^ct-s\d+-d\d+-([isf])\d+$/.exec(id);
  if (!m) return null;
  return m[1] === "i" ? "trials" : m[1] === "s" ? "semifinals" : "final";
}

/**
 * Whether an id belongs to the slate `phase` runs.
 *
 * A day can hold two slates — trials that finish late and a bracket that opens
 * the same afternoon — so the quota is counted per stage, and the trial that
 * landed that morning does not eat a semifinal's seat (or the reverse).
 * Ids without a stage count as trials: they are pre-stage history.
 */
function inStage(id: string, phase: ContestStage): boolean {
  const stage = stageOfContestId(id);
  return phase === "trials" ? stage === "trials" || stage === null : stage === phase;
}

/** The index stamped into a contest id, or `null` if unparsable. */
function indexOfContestId(id: string): number | null {
  const current = /-[isf](\d+)$/.exec(id);
  if (current) return Number(current[1]);
  const legacy = /^ct-\d+-(\d+)$/.exec(id);
  if (legacy) return Number(legacy[1]);
  return null;
}

/**
 * Where the season's calendar starts: the in-game day its first contest was
 * announced. `createSeason` runs at the first announce of that day, so
 * `startedAt` *is* day 0 — every position below is measured from it, which is
 * why it is worth writing down rather than deriving a second anchor.
 */
function seasonAnchor(season: Season): number {
  return dayOfYear(season.startedAt);
}

/**
 * A season's position for `day`: 0..`SEASON.trials - 1` are trial days,
 * `SEASON.trials` is the semifinal day, `+1` the final. `dayOfYear` wraps at
 * 365, so the subtraction is normalised back into range.
 */
function seasonDayPos(season: Season, day: number): number {
  const span = 365;
  return (((day - seasonAnchor(season)) % span) + span) % span;
}

/**
 * Distinct in-game days the ledger has seen — how much of the season has been
 * *played*.
 *
 * An id whose day cannot be parsed counts as its own day (a unique key per
 * position), which keeps a pre-rewrite ledger behaving exactly as it did when
 * the phase was a plain contest count.
 */
function distinctLedgerDays(season: Season): number {
  const days = new Set<string>();
  appliedContestIds(season).forEach((id, i) => days.add(dayOfContestId(id)?.toString() ?? `?${i}`));
  return days.size;
}

/**
 * Ledger ids that were announced as semifinals.
 *
 * Stage-based, not date-based: *when* a semifinal ran is trivia — the final's
 * roster is the winners of the semifinals that were **played**, and a bracket
 * that opened late is still a bracket. Reading this off `seasonDayPos ===
 * SEASON.trials` is exactly the assumption that wedged a late season in
 * `semifinals` forever (see `contestId`).
 */
function semifinalIds(season: Season): string[] {
  return appliedContestIds(season).filter((id) => stageOfContestId(id) === "semifinals");
}

/**
 * How many semifinal CONTESTS the bracket runs: two when the table has a full
 * `SEASON.semifinalists` real agents, one all-in match otherwise.
 *
 * "Real" is the load-bearing word — the bots are filtered out *before* the
 * count, so a top four stuffed with house agents still produces a bracket of
 * agents, not a bracket nobody can win.
 */
function expectedSemifinals(season: Season | undefined): number {
  return contenders(season).length >= SEASON.semifinalists ? SEASON.semifinals : 1;
}

/** The board, best first, bots removed — the pool every knockout draws from. */
function contenders(season: Season | undefined): SeasonStanding[] {
  if (!season) return [];
  return rankStandings(season).filter((row) => !isHouseAgent(row.agentId));
}

/**
 * The phase a season is in, derived — never stored — so a save cannot
 * disagree with itself: the ledger plus the calendar are the only things that
 * have to be right, and every other field is a function of them.
 *
 * Day-driven (08 §5, format A with the serial-cadence revision): `SEASON.trials`
 * counts in-game DAYS, and a day's slate is serial, so two calendars decide:
 *
 *  1. **the ledger's distinct days** — what has been played. Fewer than
 *     `SEASON.trials` means the trial days are not all done;
 *  2. **the plan** — today's `seasonDayPos`. This is what stops a mid-day
 *     flip: the last trial day hosts `contestsPerDay` contests, and resolving
 *     its first one takes the ledger to exactly `SEASON.trials` days while the
 *     day is still a trial day. Quota wins that argument — the day finishes
 *     its slate before the bracket opens.
 *
 * Once both say the trial days are over, the bracket's own ledger decides —
 * by **stage**, never by date: fewer than `expectedSemifinals` ids announced
 * as semifinals → `semifinals`, no id announced as a final → `final`,
 * otherwise `closed`. Two more calendar *floors* cooperate at the edges, and
 * both only ever say "not yet": (2) keeps the bracket off the last trial day,
 * and the final's own check keeps the final off the semifinal day — 08 §5
 * gives each its day. Neither can skip anything: once the day has passed the
 * floor stops binding, which is why a season whose bracket opened late still
 * reaches its final instead of stalling.
 *
 * That distinction is the whole reason the stage is in the id. Deriving the
 * bracket from the calendar assumed every day of the plan produced a scored
 * contest; when it did not, late trials were read as results (the season
 * crowned a board leader and skipped the bracket) and a late bracket was never
 * counted (the season announced semifinals forever).
 *
 * `now` is required on purpose: "what day is it" cannot be answered from the
 * save alone, and a default wall clock inside a pure function would silently
 * disagree with a replayed one.
 */
export function seasonPhase(season: Season | undefined, now: number): Season["state"] {
  if (!season) return "trials";
  if (season.state === "closed") return "closed";
  if (distinctLedgerDays(season) < SEASON.trials) return "trials";
  if (seasonDayPos(season, dayOfYear(now)) < SEASON.trials) return "trials";

  if (semifinalIds(season).length < expectedSemifinals(season)) return "semifinals";
  // The final gets a day of its own (08 §5). A floor again: it holds the
  // bracket at `semifinals` while the calendar is still on the semifinal day,
  // which makes the quota go quiet instead of opening a third semifinal — and
  // it cannot strand a season, because a day the clock has already walked past
  // no longer satisfies `<`.
  if (seasonDayPos(season, dayOfYear(now)) < SEASON.trials + 1) return "semifinals";
  const finalPlayed = appliedContestIds(season).some((id) => stageOfContestId(id) === "final");
  return finalPlayed ? "closed" : "final";
}

/**
 * The roster a phase starts with, before anyone registers.
 *
 * Trials are open: the field is whoever opted in. The knockout phases are not
 * — they are decided by the table, so a qualifier plays because they earned it,
 * not because they were awake during a 60-second window. House agents never
 * enter a knockout (they cannot qualify, and a bot in the final would hand the
 * trophy to the thing the HUD exists to give away).
 */
function knockoutRoster(world: TownSnapshot, season: Season | undefined, phase: Season["state"]): string[] {
  if (!season || phase === "trials") return [];
  if (phase === "semifinals") return semifinalRoster(world, season);
  return finalRoster(world, season);
}

/**
 * The two semifinals, seeded 1v4 across two contests.
 *
 * The bots are filtered out *before* the top-N is taken, not after — the
 * obvious version is wrong: `qualifiers()` truncates to `SEASON.semifinalists`
 * and a bot that finished inside that cut would then be removed, shrinking the
 * field. Two bots in the top four is common (they win ties, since `house-…`
 * sorts before `lm…`), and three was observed, which left one contender,
 * tripped D6, and collapsed the whole season. The bracket is the best four
 * *real* agents.
 *
 * Pairing zero takes the ends of that field (`q0` v `q3`); pairing one takes
 * the field *minus whoever the first semifinal already took*. Reading the
 * played contest rather than re-deriving `q1` v `q2` is deliberate: the board
 * moves (+10/+5 for the winners, and more if they split later contests) while
 * the first semifinal is running, so a fresh top-four no longer reproduces the
 * original seeding — and a bracket that re-derived it could hand the same
 * qualifier both tickets.
 *
 * A table shorter than `SEASON.semifinalists` real agents runs ONE all-in
 * match instead (`expectedSemifinals` falls to 1) — a bracket about nobody
 * would be worse than a crowded first round.
 */
function semifinalRoster(world: TownSnapshot, season: Season): string[] {
  // `contenders()` hands back *rows*; everything below this line is id
  // arithmetic (`gone`, the seeding pair, the `string[]` contract), so the
  // truncation is where the board becomes a roster.
  const field = contenders(season)
    .slice(0, SEASON.semifinalists)
    .map((row) => row.agentId);
  if (expectedSemifinals(season) < 2) return field;
  if (semifinalIds(season).length === 0) {
    return [field[0], field[3]].filter((id): id is string => id !== undefined);
  }
  // Who the first semifinal already took — from the card, because that is the
  // only place the pairing that actually ran is recorded.
  const played = semifinalIds(season)
    .map((id) => world.contests?.find((c) => c.id === id))
    .find((c) => c !== undefined && c.result !== undefined);
  const gone = new Set(played?.entrants ?? []);
  const rest = field.filter((id) => !gone.has(id));
  if (rest.length >= 2) return rest.slice(0, 2);
  // The card was already swept from the snapshot: the board is the only
  // memory left, so take the next qualifiers in rank order.
  return contenders(season)
    .filter((row) => !gone.has(row.agentId))
    .slice(0, 2)
    .map((row) => row.agentId);
}

/**
 * The final: the rank-1 of each semifinal, in the order they were played
 * (ledger order is resolve order, so no sorting — and no dependence on
 * `world.contests` holding the cards, which `retireResolved` could sweep).
 *
 * A short bracket has only one semifinal, so the roster is padded back up to
 * two from the board — real agents only. With no semifinal card at all (n=0/1:
 * the bracket never fielded) this is empty, D6 refuses the start, and the
 * season closes rather than staging a walkover for the trophy.
 */
function finalRoster(world: TownSnapshot, season: Season): string[] {
  const roster: string[] = [];
  for (const id of semifinalIds(season)) {
    const card = world.contests?.find((c) => c.id === id);
    const rank1 = card?.result?.standings.find((s) => s.rank === 1);
    if (rank1 && !roster.includes(rank1.agentId)) roster.push(rank1.agentId);
    if (roster.length >= 2) break;
  }
  for (const row of contenders(season)) {
    if (roster.length >= 2) break;
    if (!roster.includes(row.agentId)) roster.push(row.agentId);
  }
  return roster;
}

/** Whether external agents may still sign up during this phase. */
function isOpenToRegistration(phase: Season["state"]): boolean {
  return phase === "trials";
}

// ---------------------------------------------------------------------------
// announce
// ---------------------------------------------------------------------------

/**
 * Open the next contest of today's slate, if the slate has room.
 *
 * Serial cadence (supersedes 08 D2's "1 per day", see `CONTEST.perDay`): one
 * contest at a time, created a full `announceMs` before it starts so the venue
 * can glow and agents get a registration window; the next one opens only after
 * the previous has resolved (or been skipped by D6). Two rules bound it:
 *
 *  - **one open contest at a time** — a second `announced` card would collect
 *    registrations for the same hall from two windows, and `liveContest`
 *    would only ever serve the first;
 *  - **the day's quota** — `contestsPerDay` on trial days (2–3), one contest
 *    per remaining slot on the bracket days: `expectedSemifinals` on the
 *    semifinal day, and the final alone on its own day. A D6 skip still
 *    consumes quota — the day is a slate, not a retry loop.
 */
export function announceContest(world: TownSnapshot, now = Date.now()): Contest | null {
  world.contests ??= [];
  const day = dayOfYear(now);
  const season = world.season ?? (world.season = createSeason(1, now));
  const seasonNo = season.no;

  const phase = seasonPhase(season, now);
  if (phase === "closed") {
    // The season ran out of contests without ever reaching the final (nobody
    // registered, so the table is empty). Roll it forward rather than stalling
    // the tournament forever on a bracket that cannot be fielded.
    closeSeason(world, now);
    return null;
  }

  // One open contest at a time: the roster is a promise to everyone who
  // registered, and a second window would promise the same hall twice.
  if (liveContest(world)) return null;

  // Today's slate — every id this season carries for this in-game day. The
  // ledger is unioned in because a resolved card may already have been swept
  // from the snapshot (`retireResolved`); a quota that undercounted would open
  // one extra contest per missing card.
  const prefix = dayKey(seasonNo, day);
  const today = new Set(world.contests.filter((c) => c.id.startsWith(prefix)).map((c) => c.id));
  for (const id of appliedContestIds(season)) if (id.startsWith(prefix)) today.add(id);

  const slate =
    phase === "trials"
      ? contestsPerDay(seasonDayPos(season, day))
      : phase === "semifinals"
        ? expectedSemifinals(season)
        : 1;
  // Quota per *stage*: a day that ran its last trials and then opened the
  // bracket holds two slates at once, and neither may eat the other's seats.
  if ([...today].filter((id) => inStage(id, phase)).length >= slate) return null;

  // The index is the ledger (global: it decides the kind/bot rotation for the
  // whole season) plus how many of today's contests are already known. Ids
  // within a day therefore stay unique even when a D6 skip never reaches the
  // ledger, and rotation follows the ledger forward — a D6 skip never reaches
  // it, so the *stage* may repeat an index across days (ids stay unique anyway
  // because the day and the stage are part of the id).
  const index = seasonContestIndex(season) + today.size;
  const kind = nextContestKind(index);
  const entrants = knockoutRoster(world, season, phase);
  const contest: Contest = {
    id: contestId(seasonNo, day, index, phase),
    kind,
    title: CONTEST_TITLE,
    place: contestVenue(kind, index),
    startsAt: now + CONTEST.announceMs,
    endsAt: now + CONTEST.announceMs + CONTEST.durationMs,
    state: "announced",
    entrants,
    samples: [],
    narration: matchupLine(world, entrants),
  };

  // D8: the single house agent, trials only, and only if it will actually turn
  // up — a bot that registers and then stands still is the cheapest honest
  // demonstration of the AFK / forfeit path (D5, D7).
  if (phase === "trials") {
    const house = pickHouseAgent(index, kind);
    // A bot that was never seeded (a save whose pasture was already full) must
    // not appear in the roster: `takeSamples` would record a null place for it
    // and the standings would carry a contestant that does not exist.
    if (house && willShowUp(house, index) && residentOf(world, house)) {
      contest.houseEntrant = house;
      contest.entrants.push(house);
    }
  }

  world.contests.push(contest);
  return contest;
}

// ---------------------------------------------------------------------------
// quiet-day fill (decision 4)
// ---------------------------------------------------------------------------

/**
 * Bank house agents into one contest on a *quiet day*, so the day is never
 * empty (08 §8/§15: "the HUD is never empty" — decision 4 supersedes the
 * strict D6 reading for exactly this case).
 *
 * The day is quiet when no contest of it could reach `CONTEST.minEntrants`
 * from *external registrants alone*. The checks, in order:
 *
 *   - **trials only.** A knockout is decided by the table; padding one would
 *     hand a qualifier's place to a bot.
 *   - **the town has hosted an external agent** (`world.agents`). A world that
 *     never has is the demo path, where D6's quiet skip is the honest answer —
 *     nothing was ever promised, and the gateway's D6 test depends on it.
 *   - **nothing today is live or carries a result.** The first contest of the
 *     day gets the help, so at most one fill per day; the rest of the slate
 *     keeps the strict reading.
 *   - **nothing today is already padded to the cap**, and **no other contest
 *     today could start from externals alone** — if one can, the day is not
 *     quiet and this roster is not the one that needs help.
 *
 * Accepted tradeoff, deliberate (see `CONTEST.maxHouseOnQuietDay`): such a day
 * can put a bot-vs-bot row on the leaderboard. The alternative — a whole
 * in-game day with no contest at all — breaks the promise the house-agent
 * roster exists for.
 *
 * @returns true when the roster was padded far enough to start.
 */
function fillQuietDay(world: TownSnapshot, contest: Contest, now: number): boolean {
  // `seasonPhase(null)` reports "trials" — that is a correct answer to "which
  // phase is no season in", but it is not a reason to reach for `season!`:
  // a world without a season has no season number to build a day key from.
  if (!world.season) return false;
  if (seasonPhase(world.season, now) !== "trials") return false;
  if ((world.agents ?? []).length === 0) return false;

  const prefix = dayKey(world.season.no, dayOfYear(now));
  for (const other of world.contests ?? []) {
    if (other.id === contest.id || !other.id.startsWith(prefix)) continue;
    if (other.state === "live" || other.result !== undefined) return false;
    if (other.entrants.filter((id) => isHouseAgent(id)).length >= CONTEST.maxHouseOnQuietDay) return false;
    if (other.entrants.filter((id) => !isHouseAgent(id)).length >= CONTEST.minEntrants) return false;
  }

  const houseSoFar = contest.entrants.filter((id) => isHouseAgent(id)).length;
  const room = CONTEST.maxEntrants - contest.entrants.length;
  const max = Math.min(CONTEST.maxHouseOnQuietDay - houseSoFar, room);
  if (max <= 0) return false;

  const index = indexOfContestId(contest.id) ?? seasonContestIndex(world.season);
  const additions = quietFillAgents(index, contest.kind, contest.entrants, max);
  if (additions.length === 0) return false;
  contest.entrants.push(...additions);
  // `Contest.houseEntrant` is a single id (shared/src/types.ts says "at most
  // one" — that comment is now doc drift, see the report). Name the first
  // filler; the HUD's HOUSE label reads `isHouseAgent` per entrant anyway.
  contest.houseEntrant ??= additions[0];
  contest.narration = matchupLine(world, contest.entrants) || contest.narration;
  return canStart(contest.entrants);
}

// ---------------------------------------------------------------------------
// tick
// ---------------------------------------------------------------------------

export interface TournamentEvent {
  type: "contest";
  /**
   * The contest the event is about. Absent only for `retired`, which reports an
   * id that has already been swept out of the snapshot — that is the whole
   * point of the event, and it is why the field is optional rather than
   * half-populated with a placeholder a Phase 3 reducer would have to detect.
   */
  contest?: Contest;
  /** why the broadcast fired — the HUD and the tests key off this */
  reason: "announced" | "live" | "resolved" | "skipped" | "retired";
  /** set when the contest was dropped (D6, or a knockout that could not field) */
  skippedBecause?: string;
  /** set when a season closed on this tick */
  champion?: string | null;
  /** the swept contest's id, for `retired` */
  contestId?: string;
}

/**
 * Advance the contest lifecycle by one turn.
 *
 * This is the *only* integration point with the sim: it samples the world
 * during `live`, resolves on `endsAt`, and folds the result into the season.
 *
 * The pitfall worth naming: resolution is not idempotent for free. The sampler
 * may run again after a restart, so `scoreContest` sees a `samples` array that
 * is already on the save. `scoreContest` dedupes by `(t, agentId)`, which is
 * what makes re-resolution safe — without it a second pass would double every
 * presence count and could flip the winner.
 */
export function tickTournament(
  world: TownSnapshot,
  now: number,
  spatThisTick: readonly string[] = []
): TournamentEvent | null {
  const contest = liveContest(world);
  if (!contest) {
    const opened = announceContest(world, now);
    return opened ? { type: "contest", contest: opened, reason: "announced" } : null;
  }

  if (contest.state === "announced" && now >= contest.startsAt) {
    if (!canStart(contest.entrants)) fillQuietDay(world, contest, now);
    if (!canStart(contest.entrants)) {
      // D6: below two entrants the contest never starts — nothing was
      // promised, so nothing can be forfeited. It is closed as `resolved`
      // with **no** result rather than deleted, and that is load-bearing: if it
      // were removed, the next turn would re-announce the same id for the same
      // day and spin announce → skip → announce for the rest of the day. The
      // quiet day is a real state, and `retireResolved` sweeps it up.
      //
      // The slate still moves on (quota, not the id, bounds the day), so the
      // spin this used to guard against is now bounded by `contestsPerDay`
      // even when every contest of the day skips.
      const phase = seasonPhase(world.season, now);
      const reason = `only ${contest.entrants.length} entrant(s) registered; D6 needs ${CONTEST.minEntrants}`;
      contest.state = "resolved";

      // A knockout phase that cannot be fielded would otherwise deadlock: the
      // ledger never grows, the phase never advances, and the tournament stops
      // forever. Close the season and hand the trophy to whoever is on top.
      if (phase !== "trials") {
        return {
          type: "contest",
          contest,
          reason: "skipped",
          skippedBecause: reason,
          champion: closeSeason(world, now),
        };
      }
      return { type: "contest", contest, reason: "skipped", skippedBecause: reason };
    }
    contest.state = "live";
    return { type: "contest", contest, reason: "live" };
  }

  if (contest.state !== "live") return null;

  if (now >= contest.endsAt) return resolveContest(world, contest, now);

  // One row per entrant per turn — exactly what `scoreContest` folds over.
  // `wasSpit` is `endure`'s only input besides spirit, and it comes from the
  // turn's own spit event.
  //
  // No cap here, and that is a decision rather than an oversight: the trail is
  // already bounded by the window (durationMs ÷ tick × entrants ≈ 600 rows for
  // a full roster). Capping it mid-contest would score the contest on a
  // truncated slice of itself — `CONTEST.persistSamples` is a *save* budget and
  // is applied at resolve time instead.
  const byId = new Map(world.herd.map((r) => [r.id, r]));
  const spit = new Set([...spatThisTick, ...drainSpits()]);
  const lookup = {
    place: (id: string) => byId.get(id)?.mind.doing.place ?? null,
    spirits: (id: string) => byId.get(id)?.mind.spirits ?? 0,
    get spatThisTick() {
      return [...spit];
    },
  };
  contest.samples.push(...takeSamples(now, contest.entrants, lookup));
  return null;
}

function resolveContest(world: TownSnapshot, contest: Contest, now: number): TournamentEvent {
  // D5: the contest continues with whoever is really competing. The roster on
  // the contest is left intact — it is what the HUD shows and what the
  // newspaper names — but a forfeiter is not scored, because a llama the sim
  // was driving on their behalf is not them (see `forfeitingEntrants`).
  const forfeiting = forfeitingEntrants(world, contest, now);
  const competing = contest.entrants.filter((id) => !forfeiting.includes(id));

  const result: ContestResult = scoreContest({
    kind: contest.kind,
    place: contest.place,
    entrants: competing,
    samples: contest.samples,
    resolvedAt: now,
  });
  contest.result = result;
  contest.state = "resolved";
  // 08 §11, applied at the moment the contest becomes save data: score over the
  // *whole* trail, then keep the newest 200 rows for the file. Trimming after
  // `scoreContest` rather than before it is the whole point of the split.
  contest.samples = trimSamples(contest.samples);

  const season = world.season ?? createSeason(1, now);
  // The phase a contest *counted as* is the one it was announced in, not the
  // one the table now says — a final that advances the phase must still be
  // folded in before the board is wiped.
  const phaseBefore = seasonPhase(season, now);
  world.season = applyContestResult(season, result, { contestId: contest.id, kind: contest.kind });

  const event: TournamentEvent = { type: "contest", contest, reason: "resolved" };
  const phaseAfter = seasonPhase(world.season, now);
  if (phaseAfter === "closed") {
    // Champion = the winner of the final (08 §5: "2 winners → 1 →
    // SeasonChampion"). The board leader is only the fallback, for a season
    // that closes without a rank-1 to read (a void final, or a bracket that
    // never fielded — that path reaches `closeSeason` through the skip above).
    const winner = phaseBefore === "final" ? result.standings.find((s) => s.rank === 1)?.agentId : undefined;
    event.champion = closeSeason(world, now, winner);
  } else {
    world.season.state = phaseAfter;
  }
  return event;
}

/**
 * 08 §5: the season is over. The champion is the rank-1 of the final when the
 * bracket produced one (`finalWinner`), otherwise the leader of the board that
 * was just closed — and the new season opens empty. That reset is the entire
 * return hook, because there is no token (D10) and a fresh leaderboard is the
 * only reason to come back.
 *
 * Returns the champion's agent id, or `null` when nobody ever contested.
 */
function closeSeason(world: TownSnapshot, now: number, finalWinner?: string | null): string | null {
  const season = world.season;
  if (!season) return null;
  const { season: next, champion } = rollSeason(season, now);
  const id = finalWinner ?? champion?.agentId ?? null;
  world.season = { ...next, state: "trials", champion: id ?? undefined };
  return id;
}

// ---------------------------------------------------------------------------
// retirement + forfeits
// ---------------------------------------------------------------------------

/**
 * 08 §10.1: the HUD is transient. A result card stays up for `resultCardMs`
 * and is then dropped, so the town is allowed to be quiet again.
 *
 * `endsAt` is the reference for every resolved contest, resolved or skipped: a
 * contest that never had enough entrants (D6) is closed at its `startsAt`, so
 * measuring from `endsAt` simply lets it linger until the day would have ended
 * anyway. One rule, no extra field on the save.
 *
 * A couple of cards are kept so a reload during the result window does not
 * lose the result the Daily Spit is about to cite.
 */
export function retireResolved(world: TownSnapshot, now = Date.now()): string[] {
  if (!world.contests) return [];
  const resolved = world.contests.filter((c) => c.state === "resolved");
  if (resolved.length === 0) return [];
  // Knockout shield: the final reads its roster off the semifinal cards, so a
  // bracket card has to outlive `resultCardMs` for as long as the season's
  // ledger still counts it. Keyed on the id's *stage* rather than on a flag
  // written to the save — a rollover empties the ledger, which releases every
  // shield at once and lets the cards retire normally. Keying it off the
  // calendar instead (as it once did) shielded every card of a season whose
  // bracket opened late: nothing was ever retired again and the save grew
  // without bound.
  const shield = new Set<string>();
  if (world.season) {
    for (const id of appliedContestIds(world.season)) {
      const stage = stageOfContestId(id);
      if (stage === "semifinals" || stage === "final") shield.add(id);
    }
  }
  // The retention window comes first and the *count* cap second. Applying the
  // cap alone meant `keep` swallowed every resolved contest while there were
  // three or fewer of them, so the `resultCardMs` promise in the docstring was
  // never actually observed: 1 → 1, 2 → 2, 3 → 3, and only the fourth was
  // dropped. A card is dropped when it is both older than its moment and not
  // among the most recent few.
  const keep = new Set(resolved.slice(-KEEP_RESOLVED).map((c) => c.id));
  const dropped: string[] = [];
  for (const c of resolved) {
    if (keep.has(c.id)) continue;
    if (shield.has(c.id)) continue;
    if (now - c.endsAt < CONTEST.resultCardMs) continue;
    dropped.push(c.id);
  }
  if (dropped.length === 0) return [];
  const gone = new Set(dropped);
  world.contests = world.contests.filter((c) => !gone.has(c.id));
  return dropped;
}

/**
 * D5, D7: an entrant that did not really compete.
 *
 * Two ways that happens, and the first one is not the obvious one:
 *
 *  1. **AFK.** `isEligibleForSim` deliberately hands an AFK external's
 *     resident to the sim, so a stand-in llama goes on walking the venue and
 *     the sampler keeps producing perfectly good rows for it. Keying the
 *     forfeit off "no evidence" therefore never fired: the agent collected
 *     season points for a llama playing on their behalf. Keying it off
 *     `isAfk` at resolve time is both the honest reading of D7 and the
 *     anti-grief behaviour — registering, walking away, and letting the town
 *     score for you is exactly what D7 exists to stop.
 *  2. **Silence.** Registered but never sampled at all.
 *
 * A house bot is never a forfeiter: it has no `AgentRecord`, it is simulated
 * like any other resident, and the whole point of it competing is that the
 * town — not an absent author — is playing.
 */
export function forfeitingEntrants(world: TownSnapshot, contest: Contest, now = Date.now()): string[] {
  const present = new Set(contest.samples.map((s) => s.agentId));
  return contest.entrants.filter((id) => {
    const record = (world.agents ?? []).find((a) => a.residentId === id);
    if (record === undefined) return false;
    if (!present.has(id)) return true;
    return isAfk(record, now);
  });
}

/**
 * The sentence the newspaper prints when somebody did not turn up.
 *
 * Naming them is the point. D5 keeps the contest running and D7 keeps the win
 * worthless, but a forfeit that is only visible as a gap in the standings reads
 * as a bug — "Hux did not show" is what makes the rule believable.
 */
export function forfeitNotice(world: TownSnapshot, contest: Contest, now = Date.now()): string {
  const missing = forfeitingEntrants(world, contest, now);
  if (missing.length === 0) return "";
  const names = missing.map((id) => residentOf(world, id)?.name ?? id);
  if (names.length === 1) return `${names[0]} did not show`;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]!} did not show`;
}
