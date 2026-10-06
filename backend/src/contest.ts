/**
 * Hermes Trials — contest resolution (08 §4).
 *
 * The whole module is deliberately pure: every entry point takes a sample
 * array and returns a result. Nothing here reads the world, so the entire
 * competitive layer can be tested from hand-written fixtures without a running
 * sim (08 §13), and the samples double as the evidence the Daily Spit cites.
 *
 * The four objectives in 08 §4.2 collapse onto three shapes:
 *   - `gather_at` / `tend_project` → presence at a target (shared `presenceCards`)
 *   - `hold_ground`                → longest unbroken spell *alone* at the target
 *   - `endure`                     → never spat on
 * `win_argument` is intentionally absent: the sim has no resolved outcome to
 * read (08 §3), and pretending otherwise would ship a fake verdict.
 */
import {
  CONTEST,
  pointsForRank,
  type ContestKind,
  type ContestResult,
  type ContestSample,
  type ContestStanding,
} from "@slopagentbook/shared";

// ---------------------------------------------------------------------------
// sampling (08 §4.1)
// ---------------------------------------------------------------------------

/** What the sampler needs from the world — keeps the turn-loop wiring trivial. */
export interface SamplingLookup {
  /** current `mind.doing.place`, or null when the contestant is no longer simulated */
  place: (agentId: string) => string | null;
  spirits: (agentId: string) => number;
  /** contestants hit by a spit during this tick (drives `endure`) */
  spatThisTick: readonly string[];
}

/**
 * One row per contestant per tick. A contestant that is no longer simulated
 * produces no row rather than a placeholder, so "showed up" stays equivalent
 * to "produced evidence" — which is what the forfeit rules judge on (08 §4.3).
 */
export function takeSamples(
  t: number,
  entrants: readonly string[],
  lookup: SamplingLookup
): ContestSample[] {
  const spat = new Set(lookup.spatThisTick);
  const out: ContestSample[] = [];
  for (const agentId of entrants) {
    const place = lookup.place(agentId);
    if (place === null || place === undefined) continue;
    out.push({ t, agentId, place, spirits: lookup.spirits(agentId), wasSpit: spat.has(agentId) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// score cards
// ---------------------------------------------------------------------------

/**
 * A contestant's objective read before it is turned into rank points.
 *
 * `metric`/`secondary` sort descending and `firstArrival` ascending — but
 * which field carries the tiebreak is set per objective (08 §4.2), so two
 * objectives that tie on the metric can legitimately resolve differently.
 */
interface ScoreCard {
  agentId: string;
  metric: number;
  secondary: number;
  /** wall-clock ms of the first sample at the target; Infinity when never there */
  firstArrival: number;
  detail: string;
}

/**
 * Collapse rows repeating the same `(t, agentId)`.
 *
 * Registration may hand us a duplicated roster and the sampler will happily
 * emit a row per entry, so without this the "N of M ticks" counts double and
 * `presenceCards` can report more ticks than the window contains — enough to
 * flip a winner against the arrival tiebreak.
 */
function dedupeSamples(samples: readonly ContestSample[]): ContestSample[] {
  const seen = new Set<string>();
  const out: ContestSample[] = [];
  for (const s of samples) {
    const key = `${s.t} ${s.agentId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

/**
 * First time the contestant reached the target — as a minimum over `t`, never
 * "the first matching row", so the result does not depend on array order.
 */
function firstArrivalAt(agentId: string, samples: readonly ContestSample[], target?: string): number {
  let best = Number.POSITIVE_INFINITY;
  for (const s of samples) {
    if (s.agentId !== agentId) continue;
    if (target !== undefined && s.place !== target) continue;
    if (s.t < best) best = s.t;
  }
  return best;
}

function totalSamples(agentId: string, samples: readonly ContestSample[]): number {
  let n = 0;
  for (const s of samples) if (s.agentId === agentId) n++;
  return n;
}

/**
 * `gather_at` and `tend_project` are the same mechanic with a different venue:
 * be present at a target more often than anyone else (08 §4.2). They part on
 * the tiebreak, which the spec grants once per objective and no more.
 */
function presenceCards(
  kind: ContestKind,
  target: string,
  samples: readonly ContestSample[]
): ScoreCard[] {
  const present = new Map<string, number>();
  for (const s of samples) {
    if (s.place !== target) continue;
    present.set(s.agentId, (present.get(s.agentId) ?? 0) + 1);
  }

  // 08 §4.2 grants each objective exactly one tiebreak: `gather_at`'s is
  // earliest arrival, `tend_project`'s is total samples. So `gather_at` must
  // carry a neutral secondary — putting participation in front of arrival
  // would hand the win to whoever showed up most, not whoever got there first.
  const useAttendance = kind === "tend_project";

  const cards: ScoreCard[] = [];
  for (const [agentId, count] of present) {
    const total = totalSamples(agentId, samples);
    cards.push({
      agentId,
      metric: count,
      secondary: useAttendance ? total : 0,
      firstArrival: firstArrivalAt(agentId, samples, target),
      detail:
        kind === "tend_project"
          ? `on duty at ${target} on ${count} of ${total} ticks`
          : `at ${target} on ${count} of ${total} ticks`,
    });
  }
  return cards;
}

/**
 * `hold_ground`: longest consecutive run of ticks where this contestant was
 * the *only* one at the target (08 §4.2). The run length is the metric and
 * total time held is the tiebreak — two agents who both held once for three
 * ticks are not equal if one of them did it twice.
 */
function holdCards(
  target: string,
  entrants: readonly string[],
  samples: readonly ContestSample[]
): ScoreCard[] {
  const atTarget = new Map<number, Set<string>>();
  for (const s of samples) {
    if (s.place !== target) continue;
    let set = atTarget.get(s.t);
    if (!set) atTarget.set(s.t, (set = new Set()));
    set.add(s.agentId);
  }

  // The tick domain must be *every* tick the sampler produced anything, not
  // just the ticks where someone stood at the target: a tick where the target
  // is empty is exactly what breaks a run. Restricting the loop to occupied
  // ticks silently joins spells across gaps and reports a continuous hold that
  // never happened. (A tick with no rows at all is invisible here — the
  // sampler emits one row per simulated entrant per tick, so that only occurs
  // when the whole roster was unsimulated.)
  //
  // `samples` has already been filtered to registered entrants by
  // `scoreContest`, so an audience member at the venue cannot block a hold.
  const tickList = [...new Set(samples.map((s) => s.t))].sort((a, b) => a - b);

  const longest = new Map<string, number>();
  const total = new Map<string, number>();
  const run: Record<string, number> = {};

  for (const t of tickList) {
    const present = atTarget.get(t);
    // "alone at the target" means no *other* contestant was also there
    for (const agentId of entrants) {
      const alone = present !== undefined && present.has(agentId) && present.size === 1;
      if (alone) {
        run[agentId] = (run[agentId] ?? 0) + 1;
        total.set(agentId, (total.get(agentId) ?? 0) + 1);
        if (run[agentId] > (longest.get(agentId) ?? 0)) longest.set(agentId, run[agentId]);
      } else {
        run[agentId] = 0;
      }
    }
  }

  const cards: ScoreCard[] = [];
  for (const [agentId, held] of longest) {
    const solo = total.get(agentId) ?? 0;
    cards.push({
      agentId,
      metric: held,
      secondary: solo,
      firstArrival: firstArrivalAt(agentId, samples, target),
      detail: `held ${target} alone for ${held} of ${solo} solo tick${solo === 1 ? "" : "s"}`,
    });
  }
  return cards;
}

/**
 * `endure`: never spat on. Binary metric, so every survivor ties and the
 * spirit delta decides — surviving with composure beats surviving by luck.
 */
function endureCards(samples: readonly ContestSample[]): ScoreCard[] {
  const byAgent = new Map<string, ContestSample[]>();
  for (const s of samples) {
    let list = byAgent.get(s.agentId);
    if (!list) byAgent.set(s.agentId, (list = []));
    list.push(s);
  }

  const cards: ScoreCard[] = [];
  for (const [agentId, rows] of byAgent) {
    // chronological, so the spirit delta is start→end regardless of arrival order
    const list = rows.slice().sort((a, b) => a.t - b.t);
    const spits = list.reduce((n, s) => n + (s.wasSpit ? 1 : 0), 0);
    const delta = Math.round((list[list.length - 1].spirits - list[0].spirits) * 100) / 100;
    // signed with 2dp — "spirits +0" reads as a typo in the Daily Spit
    const mood = `${delta < 0 ? "-" : "+"}${Math.abs(delta).toFixed(2)}`;
    cards.push({
      agentId,
      metric: spits === 0 ? 1 : 0,
      secondary: delta,
      firstArrival: list[0].t,
      detail:
        spits === 0
          ? `never spat on — spirits ${mood}`
          : `spat on ${spits}× — spirits ${mood}`,
    });
  }
  return cards;
}

// ---------------------------------------------------------------------------
// scoring
// ---------------------------------------------------------------------------

function compare(a: ScoreCard, b: ScoreCard): number {
  // two "never arrived" entrants both hold Infinity, and Infinity - Infinity
  // is NaN — compare explicitly rather than relying on NaN being falsy
  const arrive = Number.isFinite(a.firstArrival) || Number.isFinite(b.firstArrival)
    ? a.firstArrival - b.firstArrival
    : 0;
  return (
    b.metric - a.metric ||
    b.secondary - a.secondary ||
    arrive ||
    // plain codepoint order: localeCompare collates differently per machine,
    // and this module's whole claim is reproducible evidence
    (a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0)
  );
}

/**
 * D6: below two entrants the contest never exists, because nothing was
 * announced and so nothing can be forfeited.
 *
 * Counts unique ids — `canStart(["a", "a"])` is one entrant, not two, or a
 * contest could be announced for a single agent and resolve void.
 *
 * The cap in `CONTEST.maxEntrants` is deliberately *not* checked here — it
 * belongs to registration, where the surplus is turned away. Making it a
 * start condition would let over-subscription veto the whole contest.
 */
export function canStart(entrants: readonly string[]): boolean {
  return new Set(entrants).size >= CONTEST.minEntrants;
}

/** Whether there is still room in the roster for one more registrant. */
export function hasRoom(entrants: readonly string[]): boolean {
  return new Set(entrants).size < CONTEST.maxEntrants;
}

export interface ScoreInput {
  kind: ContestKind;
  /** target location id for every objective except `endure` */
  place: string;
  entrants: readonly string[];
  samples: readonly ContestSample[];
  resolvedAt: number;
}

/**
 * Turn a sample trail into standings (08 §4.3).
 *
 * Contestants with no samples are dropped rather than ranked last: not
 * showing up is not the same as finishing last, and it is what makes the
 * void check below mean "one contestant still standing".
 */
export function scoreContest(input: ScoreInput): ContestResult {
  const { kind, place, resolvedAt } = input;

  // Registration is allowed to be wrong; the leaderboard must not inherit it.
  const roster = [...new Set(input.entrants)];
  const known = new Set(roster);

  // Two guards, both applied once here rather than in each objective:
  //  - a duplicated roster would inflate "N of M ticks" past the window length
  //    and flip a winner against the arrival tiebreak;
  //  - evidence from anyone who did not register must be ignored, because a
  //    bystander standing at the venue would otherwise stop every contestant
  //    from counting as "alone" — which would make `hold_ground` unsolvable
  //    the moment the town turns up to watch (08 §9).
  const samples = dedupeSamples(input.samples).filter((s) => known.has(s.agentId));

  const cards =
    kind === "hold_ground"
      ? holdCards(place, roster, samples)
      : kind === "endure"
        ? endureCards(samples)
        : presenceCards(kind, place, samples);

  const scored = cards.filter((c) => known.has(c.agentId));
  const present = new Set(scored.map((c) => c.agentId));

  // "Still standing" means *produced evidence*, not *won something*. An entrant
  // who showed up but never claimed the objective belongs on the board with a
  // zero — otherwise a three-way contest reads as a solo walkover.
  for (const agentId of roster) {
    if (present.has(agentId) || !samples.some((s) => s.agentId === agentId)) continue;
    scored.push({
      agentId,
      metric: 0,
      secondary: 0,
      // arrival *at the target*, not first sample anywhere: for someone who
      // never got there this is Infinity, which correctly falls through to the
      // agentId tiebreak rather than inventing an arrival time
      firstArrival: firstArrivalAt(agentId, samples, place),
      detail: kind === "hold_ground" ? "never held the ground alone" : "present but never reached the target",
    });
  }

  scored.sort(compare);

  // D7 — a contest nobody contested was never won (08 §4.3).
  const voidResult = scored.length <= 1;

  const standings: ContestStanding[] = scored.map((c, i) => ({
    agentId: c.agentId,
    rank: i + 1,
    score: voidResult ? 0 : pointsForRank(i + 1),
    metric: c.metric,
    detail: c.detail,
  }));

  return { standings, voidResult, resolvedAt };
}

// ---------------------------------------------------------------------------
// persistence
// ---------------------------------------------------------------------------

/**
 * Keep only the most recent evidence (08 §11): the raw trail for one contest
 * is ~600 rows, and the resolution only ever needed them once.
 *
 * Rows are ordered by `t` first, so "most recent" means newest by timestamp
 * and not merely last in the array — the sampler appends chronologically
 * today, but nothing here should depend on that holding.
 */
export function trimSamples(samples: readonly ContestSample[], max: number = CONTEST.persistSamples): ContestSample[] {
  if (samples.length <= max) return [...samples];
  const ordered = [...samples].sort((a, b) => a.t - b.t);
  return ordered.slice(ordered.length - max);
}
