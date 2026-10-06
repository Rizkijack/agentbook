/**
 * Phase 1 smoke test — proves the contest resolvers work against a *real*
 * world, not just hand-written fixtures.
 *
 * Unit tests can't catch the failure mode that matters most here: assuming a
 * field exists on `Resident` that the sim never actually writes. This script
 * pulls live residents out of `createInitialWorld()`, drives a simulated
 * contest window through them, and resolves all four objectives.
 *
 *   pnpm --filter backend exec tsx scripts/smoke-contest.ts
 */
import { createInitialWorld } from "../src/world.js";
import { canStart, hasRoom, scoreContest, takeSamples, trimSamples } from "../src/contest.js";
import { CONTEST, CONTEST_VENUES, pointsForRank } from "@slopagentbook/shared";
import type { ContestKind, ContestSample, Resident } from "@slopagentbook/shared";

const TICK = 1800;
const TICKS = 12;
const T0 = Date.now();

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

const world = createInitialWorld();
const herd = world.herd;
check(herd.length >= 2, `world booted with ${herd.length} residents`);

// --- entrants are real residents, so mind.doing.place really must exist -----
const entrants: string[] = herd.slice(0, 4).map((r: Resident) => r.id);
if (!canStart(entrants)) fail(`canStart rejected ${entrants.length} real entrants (D6)`);
check(true, `canStart accepts ${entrants.length} entrants (D6)`);

// hasRoom must be exercised at the boundary — a check on a random roster
// cannot fail, which would make it worse than no check at all
const roster = Array.from({ length: CONTEST.maxEntrants }, (_, i) => `roster-${i}`);
check(hasRoom(roster.slice(0, -1)) === true, `hasRoom allows ${CONTEST.maxEntrants - 1} entrants`);
check(hasRoom(roster) === false, `hasRoom refuses the ${CONTEST.maxEntrants}th entrant`);

const places = [...new Set(herd.map((r) => r.mind.doing.place).filter(Boolean))];
check(places.length >= 1, `found ${places.length} distinct live places: ${places.join(", ")}`);

/**
 * A venue must be legal for its objective (`CONTEST_VENUES` in shared config).
 * Prefer one that is occupied right now so the assertion exercises the real
 * path, but never fall back to an arbitrary live place — that is exactly how
 * this smoke used to "pass" a square under `hold_ground`.
 */
function venueFor(kind: ContestKind): string {
  const legal = CONTEST_VENUES[kind];
  const chosen = legal.find((v) => places.includes(v)) ?? legal[0];
  if (!legal.includes(chosen)) fail(`${kind}: no legal venue available`);
  return chosen;
}

/**
 * The lookup contract the real turn loop will satisfy. `spatNow` is swapped
 * per tick so `endure` can be driven through real spit events.
 */
const byId = new Map(herd.map((r) => [r.id, r]));
let spatNow: readonly string[] = [];
const lookup = {
  place: (id: string) => byId.get(id)?.mind.doing.place ?? null,
  spirits: (id: string) => byId.get(id)?.mind.spirits ?? 0,
  get spatThisTick() {
    return spatNow;
  },
};

/** somewhere to be when *not* at the venue */
const elsewhere = [...new Set([...places, ...Object.values(CONTEST_VENUES).flat()])];

/**
 * Drive one contest window against real residents, per objective:
 *
 *  - `gather_at` / `tend_project` — everyone converges on the venue, arriving
 *    on different ticks and lapsing now and then. The stagger and the lapses
 *    are what keep the counts different; without them every metric matches and
 *    the ranking assertions pass without ever comparing anything.
 *
 *  - `hold_ground` — the objective is to be the *only* contestant at the venue
 *    (08 §4.2), so a window where everybody piles into the pond is not a
 *    harder contest, it is a contest nobody can win. Model the real dynamic
 *    instead: they compete for the spot, so at most one is ever camped there
 *    and each one's run breaks the moment a rival turns up.
 *
 *  - `endure` — nobody controls being spat on, so a real window has a victim.
 */
function driveWindow(kind: ContestKind, place: string): ContestSample[] {
  const rows: ContestSample[] = [];
  for (let tick = 0; tick < TICKS; tick++) {
    for (let i = 0; i < entrants.length; i++) {
      const r = byId.get(entrants[i])!;
      const lapsed = (tick + i) % 5 === 0; // phase-shifted absences
      if (kind === "hold_ground") {
        // only the contestant holding this tick's turn is camped at the venue
        const mine = tick % entrants.length === i;
        r.mind.doing.place = mine && !lapsed ? place : elsewhere[(tick * 3 + i) % elsewhere.length]!;
      } else {
        const arrived = tick >= i;
        r.mind.doing.place =
          arrived && !lapsed ? place : elsewhere[(tick * 3 + i) % elsewhere.length]!;
      }
      // endure: one entrant takes the brunt, and loses spirits for it
      if (kind === "endure" && i === 2 && tick % 3 === 0) {
        r.mind.spirits = Math.max(-1, r.mind.spirits - 0.25);
      }
    }
    spatNow = kind === "endure" && tick % 3 === 0 ? [entrants[2]!] : [];
    rows.push(...takeSamples(T0 + tick * TICK, entrants, lookup));
  }
  return rows;
}

function windowIsReal(kind: ContestKind, place: string, samples: ContestSample[]): void {
  check(samples.length === entrants.length * TICKS, `${kind}: ${samples.length} rows over ${TICKS} ticks`);
  check(
    samples.every((s) => typeof s.place === "string" && s.place.length > 0),
    `${kind}: every sample carries a non-empty place — mind.doing.place is real`
  );
  check(samples.every((s) => Number.isFinite(s.spirits)), `${kind}: every sample carries finite spirits`);
  check(
    samples.some((s) => s.place === place),
    `${kind}: the window actually reaches ${place} — the venue is not a no-op`
  );
}

// --- resolve all four objectives -------------------------------------------
const kinds: readonly ContestKind[] = ["gather_at", "hold_ground", "tend_project", "endure"];

for (const kind of kinds) {
  const place = venueFor(kind);
  const samples = driveWindow(kind, place);
  windowIsReal(kind, place, samples);

  const result = scoreContest({ kind, place, entrants, samples, resolvedAt: T0 + TICKS * TICK });
  check(result.standings.length === entrants.length, `${kind}: all ${entrants.length} entrants scored`);
  check(
    result.standings.every((s, i) => s.rank === i + 1 && Number.isFinite(s.metric) && s.detail.length > 0),
    `${kind}: ranks dense, metrics finite, every entry has quotable evidence`
  );
  check(
    result.standings.every((s) => s.score === (result.voidResult ? 0 : pointsForRank(s.rank))),
    `${kind}: scores match 10/5/1 — or 0 across the board when void (D7)`
  );
  check(!result.voidResult, `${kind}: four standing contestants is never void (D7)`);

  // non-vacuity: a window where every metric matched would mean the ranking
  // was never actually exercised
  const metrics = result.standings.map((s) => s.metric);
  check(new Set(metrics).size > 1, `${kind}: metrics differ, so the ranking really compared (${metrics.join(", ")})`);

  for (const s of result.standings) {
    console.log(`      ${kind.padEnd(13)} @${place.padEnd(7)} #${s.rank} ${s.agentId} ${s.score}pt "${s.detail}"`);
  }

  // order independence on live data, per objective
  const flipped = scoreContest({
    kind,
    place,
    entrants: [...entrants].reverse(),
    samples: [...samples].reverse(),
    resolvedAt: T0 + TICKS * TICK,
  });
  check(JSON.stringify(flipped) === JSON.stringify(result), `${kind}: identical from a shuffled trail + reversed roster`);
}

// --- evidence budget --------------------------------------------------------
const trail = driveWindow("gather_at", venueFor("gather_at"));
const fat = Array.from({ length: 600 }, (_, i) => trail[i % trail.length]);
const trimmed = trimSamples(fat);
check(trimmed.length === CONTEST.persistSamples, `trimSamples caps a 600-row trail at ${CONTEST.persistSamples} (08 §11)`);
check(
  trimmed[trimmed.length - 1].t >= trimmed[0].t,
  "trimSamples returns a chronological window, newest last"
);

console.log(`\n  SMOKE OK — Phase 1 resolves against the real world\n`);
