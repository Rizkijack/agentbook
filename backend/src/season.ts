/**
 * Hermes Trials — season standings and rollover (08 §5).
 *
 * Format A (D3): `SEASON.trials` trial days accumulate rank points, the top
 * `SEASON.semifinalists` go on to the semifinals and the final, and the
 * leader on the board when the season closes is the champion. The board is
 * wiped on rollover — that reset is the entire return hook, because there is
 * no token (D10) and so a fresh leaderboard is the only reason to come back.
 *
 * Every function here is pure: no clock read, no world read, no I/O. A season
 * is a value. That is what lets the schedule hand the same result to the
 * season twice, replay a save, and rebuild a leaderboard without the
 * leaderboard depending on *when* or *in what order* it was asked.
 */
import {
  SEASON,
  pointsForRank,
  type ContestKind,
  type ContestResult,
  type ContestStanding,
  type Season,
  type SeasonStanding,
} from "@slopagentbook/shared";

// ---------------------------------------------------------------------------
// the idempotency ledger
// ---------------------------------------------------------------------------

/**
 * `Season` with the one field this module needs and the shared type does not
 * declare. See the note on `appliedContests` below.
 */
type SeasonLedger = Season & { appliedContests?: string[] };

/**
 * Contest ids already folded into this season, oldest first.
 *
 * Read defensively (an older save has no ledger at all, and a hand-edited one
 * may hold rubbish) even though `Season.appliedContests` is now declared in
 * shared/src/types.ts — an optional field on a persisted object is exactly the
 * kind that is missing from saves written before it existed.
 *
 * Exported because the schedule reads it too: a contest id carries its day
 * (`ct-s{season}-d{day}-i{index}`), so the driver derives the season phase
 * from the *days* the ledger has seen, not from a raw contest count.
 */
export function appliedContestIds(season: Season): readonly string[] {
  const list = (season as SeasonLedger).appliedContests;
  return Array.isArray(list) ? list : [];
}

/**
 * How many contests this season has already resolved — the schedule's index for
 * the next one.
 *
 * It is the ledger length rather than a stored counter because the ledger is
 * already restart-safe: this is the number a contest id is stamped from, and a
 * counter that reset to 0 on reload would hand two different contests the same
 * id and let the second one overwrite the first.
 *
 * Note the unit: this is *contests*, while `SEASON.trials` counts *days*
 * (contests arrive in per-day slates). Quota, not phase, is what this drives.
 */
export function seasonContestIndex(season: Season | undefined): number {
  return season ? appliedContestIds(season).length : 0;
}

// ---------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------

/**
 * Open a season. `index` is the contract's name for what `Season` spells
 * `no` (shared/src/types.ts:196) — 1-based, the unit of the return cadence
 * (08 §6).
 *
 * Every season opens in `trials`: the phase is the schedule's to advance
 * (it knows the in-game day), and a season that guessed its own phase would
 * skip straight to a bracket nobody played for.
 */
export function createSeason(index: number, now: number): Season {
  return { id: `s${index}`, no: index, startedAt: now, state: "trials", standings: [] };
}

/**
 * Fold one resolved contest into the season's table.
 *
 * Points come from `pointsForRank(rank)` in the shared table (08 §4.3) and are
 * recomputed from the standing's `rank` rather than read off its `score`, so
 * the two layers cannot drift and a hand-edited result cannot inflate a
 * leaderboard.
 *
 * `meta.kind` is accepted and deliberately not consulted: every objective is
 * scored from the same rank table, so the objective cannot change season
 * points. It is in the signature because the caller has it in hand and the
 * *phase* (`season.state`) is driven by the schedule, not by the objective.
 *
 * A rank-1 standing is a win, any other rank is a loss. Exactly one of the
 * two per contested contestant, so `wins + losses` doubles as "how many
 * contests this agent actually appeared in".
 */
export function applyContestResult(
  season: Season,
  result: ContestResult,
  meta: { contestId: string; kind: ContestKind }
): Season {
  const applied = appliedContestIds(season);

  // ── IDEMPOTENCY: the load-bearing invariant ──────────────────────────────
  //
  // The turn loop can legitimately resolve the same contest more than once: a
  // restart replays the last tick, a debounced save can be flushed twice, and
  // a caller that re-reads a contest out of the snapshot has no way to know
  // it was already counted. Points are the one number in this project that
  // contestants argue about, so double-crediting a single contest would hand
  // out season points that were never won — and it would be silent.
  //
  // Replaying a contest id is a no-op: the *same* season object comes back,
  // not a copy that merely looks equal, so a caller cannot accidentally treat
  // "recomputed" as "changed".
  if (applied.includes(meta.contestId)) return season;

  // D7 (08 §4.3): a void result is recorded and narrated but credits nothing.
  // The contestant may well have "won" by forfeit, but a match that was never
  // genuinely contested must not be worth season points, or an agent that
  // never shows up can farm the table by registering and walking away. The
  // contest id still goes in the ledger, so a void resolution replays as a
  // no-op exactly like a scored one.
  const credited = result.voidResult ? [] : result.standings;

  const byId = new Map<string, SeasonStanding>();
  // Fresh row objects: `SeasonStanding`s handed to a caller are never shared
  // with the season they came from.
  for (const row of season.standings) byId.set(row.agentId, { ...row });

  // A duplicated standing inside one result is the same failure as a
  // duplicated contest — `scoreContest` cannot emit one, but a hand-built
  // result can, and it would be worth the same points twice.
  const seen = new Set<string>();

  for (const standing of credited) {
    if (!isCreditable(standing)) continue;
    if (seen.has(standing.agentId)) continue;
    seen.add(standing.agentId);

    const row = byId.get(standing.agentId) ?? { agentId: standing.agentId, points: 0, wins: 0, losses: 0 };
    row.points += pointsForRank(standing.rank);
    if (standing.rank === 1) row.wins += 1;
    else row.losses += 1;
    byId.set(standing.agentId, row);
  }

  // Shallow copy of the season plus a brand new standings array and new row
  // objects — the rest of `Season` is five scalars/`champion`, so a deep copy
  // would cost clarity for nothing. Nothing above touched `season`.
  const next: SeasonLedger = {
    ...season,
    standings: [...byId.values()],
    appliedContests: [...applied, meta.contestId],
  };
  return next;
}

// ---------------------------------------------------------------------------
// the board
// ---------------------------------------------------------------------------

/**
 * A standing is creditable only with a real 1-based rank: `pointsForRank`
 * hands out 0 for anything else, and a rank of 0 or NaN would silently become
 * a zero-point row that still claims a win.
 */
function isCreditable(standing: ContestStanding): boolean {
  return Number.isInteger(standing.rank) && standing.rank >= 1;
}

/**
 * Total order on the board: points, then wins, then agent id.
 *
 * The id comparison is plain codepoint, never `localeCompare` — collation
 * depends on the machine's locale data, and this codebase's promise is
 * reproducible evidence (the same reason `contest.ts` resolves ties the same
 * way). Codepoint order is the only tiebreak that produces the same
 * leaderboard on every machine that replays the same save.
 */
function compareStandings(a: SeasonStanding, b: SeasonStanding): number {
  return (
    b.points - a.points ||
    b.wins - a.wins ||
    (a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0)
  );
}

/**
 * The leaderboard, best first.
 *
 * Rows that contested nothing are dropped: with no points, no wins and no
 * losses there is nothing to say about the agent, and a leaderboard row of
 * zeros is noise that pushes the real contenders off the screen. `season` is
 * untouched and the returned rows are copies, so a caller sorting or
 * annotating the board cannot corrupt the season.
 */
export function rankStandings(season: Season): SeasonStanding[] {
  return season.standings
    .filter((row) => row.wins + row.losses > 0)
    .map((row) => ({ ...row }))
    .sort(compareStandings);
}

/**
 * Who advances to the semifinals: the top `SEASON.semifinalists` (4) of the
 * board, fewer when fewer agents contested — a bracket padded with agents
 * that never played would be a bracket about nobody.
 */
export function qualifiers(season: Season): SeasonStanding[] {
  return rankStandings(season).slice(0, SEASON.semifinalists);
}

// ---------------------------------------------------------------------------
// rollover
// ---------------------------------------------------------------------------

/**
 * Close a season and open the next one.
 *
 * The champion is the leader of the final board — a total order, so exactly
 * one champion, and null when nobody contested all season. The old season is
 * returned untouched (not even `state`/`champion` are stamped on it): the
 * caller owns closing it, and a function that quietly rewrote its own input
 * would make the "did the bracket finish?" question unanswerable. Stamp and
 * persist it yourself:
 *
 *   const closed = { ...season, state: "closed", champion } as const;
 *
 * The new season starts empty with `index + 1` and a fresh `startedAt`,
 * which is the reset that makes the next season worth playing (08 §5).
 */
export function rollSeason(
  season: Season,
  now: number
): { season: Season; champion: SeasonStanding | null } {
  const board = rankStandings(season);
  const champion = board.length > 0 ? board[0] : null;
  return { season: createSeason(season.no + 1, now), champion };
}
