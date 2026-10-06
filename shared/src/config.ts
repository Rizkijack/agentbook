import type { ContestKind, TownConfig } from "./types.js";

/**
 * Length of one in-game day, in real seconds. 900 = 15 real minutes per day.
 *
 * Single source of truth. Previously hardcoded at seven sites
 * (shared config, backend needs/turn/gateway x2, mcp tools, canvas engine,
 * TownView) and only ever agreed by coincidence — see
 * 08-HERMES-TRIALS-TOURNAMENT.md §6.1.
 */
export const DAY_LENGTH_SEC = 900;

/**
 * Where the town clock sits within the current day, as 0..1.
 *
 * Pure wall-clock: it advances whether or not anything is simulated, so an
 * in-game hour is a fixed real-time slot — not a daily appointment.
 * (08 §6: at DAY_LENGTH_SEC=900 "20:00" recurs every 15 real minutes.)
 */
export function dayClock(dateMs: number = Date.now(), dayLengthSec: number = DAY_LENGTH_SEC): number {
  const sec = (dateMs / 1000) % dayLengthSec;
  return sec / dayLengthSec;
}

/** Day-of-year number (1..365) derived from the same wall clock. */
export function dayOfYear(dateMs: number = Date.now(), dayLengthSec: number = DAY_LENGTH_SEC): number {
  return Math.floor((dateMs / 1000 / dayLengthSec) % 365) + 1;
}

/**
 * Hermes Trials contest timing and rules (08 §4.3, §11, §14).
 *
 * The live window is 180s = exactly 100 ticks at TURN_MS 1800, which is where
 * the "~100 samples per contestant" budget in 08 §11 comes from.
 */
export const CONTEST = {
  /** announced → live. The window the HUD shows "starts in …" for. */
  announceMs: 60_000,
  /** live → resolved. 180s / 1800ms tick = 100 ticks per contestant. */
  durationMs: 180_000,
  /**
   * Cadence: how many contests one in-game day hosts (supersedes 08 D2's
   * "1 per day"). 2–3 × (announce 60s + live 180s + ~2s handover) = 480–726s,
   * which fits back-to-back inside one DAY_LENGTH_SEC 900 day — that is the
   * arithmetic the range is derived from, not a preference.
   *
   * Read with `SEASON.trials` (5 trial *days*): a season still accumulates
   * `trials × perDay` = 10–15 trial contests, the same scale the original
   * 10-days × 1/day format promised, in 7 in-game days instead of 12.
   */
  perDay: { min: 2, max: 3 } as const,
  /**
   * Decision 4 (supersedes 08 §8 / D8 for exactly one case): on a day where no
   * contest can reach `minEntrants` from *external registrants alone*, ONE
   * contest of that day may bank up to this many house agents so the day is
   * never empty (08 §8/§15: "the HUD is never empty").
   *
   * Tradeoff, accepted deliberately: such a day can put a bot-vs-bot row on
   * the leaderboard. The alternative — a whole in-game day with no contest at
   * all — breaks the promise the house-agent roster exists for. The rule is
   * capped here rather than in code so the cap is inspectable next to
   * `minEntrants`, and normal days still hold the D8 limit of one bot.
   */
  maxHouseOnQuietDay: 2,
  /** how long the result card stays on screen before idle (08 §10.1). */
  resultCardMs: 45_000,
  /** below this the contest never starts — nothing was promised (D6). */
  minEntrants: 2,
  /** hard cap; keeps a single contest from swallowing the whole roster. */
  maxEntrants: 6,
  /** rank points: 1st, 2nd, 3rd, everyone else (08 §4.3). */
  pointsForRank: [10, 5, 1] as const,
  /**
   * Evidence kept per contest **once it is over** (08 §11: ~600 raw rows, trim
   * to 200).
   *
   * Deliberately a *persist* budget and not a live one. Trimming while the
   * contest is running would change what the resolver gets to see: a 3-minute
   * window at a 1.8s tick is 100 ticks, a six-horse roster is ~600 rows, and
   * keeping the newest 200 would score the contest on its last third — with
   * early positioning invisible. The live trail is bounded by the window
   * anyway (`durationMs` ÷ tick × entrants), so it needs no cap; it is trimmed
   * the moment the contest resolves, which is when it becomes save data.
   */
  persistSamples: 200,
} as const;

/**
 * How many contests the driver announces for in-game day `day` of a season
 * (0-based: 0..4 are trial days). Deterministic: the 2..3 span alternates
 * (even day → 2, odd day → 3), so a 5-trial-day season accumulates
 * 2+3+2+3+2 = 12 trial contests — the same scale as 08's original
 * 10 × 1/day, inside 7 in-game days (see `SEASON`).
 *
 * Days 5 (semifinals) and 6 (final) are outside this range: the driver
 * announces `expectedSemifinals` of them on the semifinal day (two, when the
 * table is full) and exactly one contest — the final — on its own day.
 */
export function contestsPerDay(day: number): number {
  const span = CONTEST.perDay.max - CONTEST.perDay.min + 1;
  const idx = ((day % span) + span) % span;
  return CONTEST.perDay.min + idx;
}

/**
 * Season shape — format A (D3): `trials` trial DAYS, then top 4 → 2
 * semifinals (same day) → final.
 *
 * Unit change from 08 D3 (orchestrator decision): `trials` counts *days*,
 * not contests — each day hosts `contestsPerDay` contests serially (one
 * open contest at a time), so a season spans `trials + 2` = 7 in-game days
 * (5 trial days ≈ 12 contests + 1 semifinal day + 1 final day), ≈1.75 real
 * hours at DAY_LENGTH_SEC 900 (08 §6/§8).
 */
export const SEASON = {
  /** number of trial DAYS (each hosts `contestsPerDay` contests). */
  trials: 5,
  /** qualifiers that reach the semifinals — 2 contests of 2, winner each. */
  semifinalists: 4,
  /**
   * how many semifinal CONTESTS a full bracket runs (2 when there are
   * `semifinalists` real contenders; a short table falls back to ONE all-in
   * match — see `seasonPhase`/`knockoutRoster` in backend/src/tournament.ts).
   */
  semifinals: 2,
  /** total in-game days a season spans — the unit of return cadence (08 §6). */
  seasonDays: 7,
} as const;

/** Rank → points (08 §4.3). Ranks beyond the list earn 0. */
export function pointsForRank(rank: number): number {
  const idx = rank - 1;
  return idx >= 0 && idx < CONTEST.pointsForRank.length ? CONTEST.pointsForRank[idx] : 0;
}

export const CONTEST_VENUES: Record<ContestKind, readonly string[]> = {
  /** §4.2 — the square is where the town already gathers */
  gather_at: ["square", "board", "market"],
  /** §4.2 — a fixed spot to hold, away from the traffic */
  hold_ground: ["pond", "fire", "dock"],
  /**
   * §4.2 — no venue given, because `Project` has no site field: progress is
   * bumped by location-independent RNG (turn.ts:215, which claims otherwise).
   * Presence is measured at a civic site as a *convention*, not as causation —
   * the doc measures presence, not attributed progress.
   */
  tend_project: ["hall", "bank", "press"],
  /** §4.2 — `endure` has no target, so this is never consulted */
  endure: ["square"],
};

/**
 * Defaults for a NEW town. An existing town keeps whatever config its save
 * carries — this is a default, never a migration — so a rebrand here does not
 * rewrite towns that are already running.
 */
export const defaultConfig: TownConfig = {
  name: "SlopAgentbook",
  ticker: "SLB",
  tokenAddress: "TLJ8QbLnNUxZJJ1dcqF9auUKHrtKd8aNUkscxhSDADj",
  chainName: "Base",
  network: "mainnet",
  rpcUrl: "https://mainnet.base.org",
  explorer: "https://basescan.org/token/TLJ8QbLnNUxZJJ1dcqF9auUKHrtKd8aNUkscxhSDADj",
  dexUrl: "https://dexscreener.com/base/",
  xUrl: "https://x.com/slopagentbook",
  brain: "llm",
  forkCost: "Free",
  maxHerd: 64,
};
