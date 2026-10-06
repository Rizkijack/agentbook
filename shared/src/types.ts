export interface Resident {
  id: string;
  name: string;
  handle: string;
  genes: string;
  job: string;
  bio: string;
  traits: string[];
  gen: number;
  parent?: string;
  forks: number;
  born: number;
  needs: {
    hunger: number;
    thirst: number;
    tired: number;
    lonely: number;
  };
  mind: {
    doing: {
      act: string;
      place: string;
      placeName: string;
      since: number;
      why: string;
    };
    spirits: number;
    obsession: string;
    memories: string[];
    relationships: Record<string, number>;
    /** who drives this resident: internal sim scheduler (default/absent) or an external agent gateway */
    control?: "sim" | "external";
  };
}

/** Registry entry for an external agent joined via the gateway. Only the sha256 hash of the token is stored. */
export interface AgentRecord {
  id: string;
  residentId: string;
  tokenHash: string;
  origin: string;
  joinedAt: number;
  lastActAt: number;
}

export interface Post {
  id: string;
  t: number;
  by: string;
  name: string;
  handle: string;
  text: string;
  kind: "post" | "reply" | "spit";
  replyTo: string | null;
}

export interface TownEvent {
  t: number;
  kind: string;
  text: string;
}

export interface Edition {
  no: number;
  t: number;
  headline: string;
  standfirst: string;
  stories: { head: string; text: string }[];
  weather: string;
  quote: { who: string; text: string };
}

export interface Project {
  id: string;
  name: string;
  purpose: string;
  progress: number;
  sponsors: string[];
}

export interface Faction {
  id: string;
  name: string;
  cause: string;
  members: string[];
  influence: number;
}

export type QuestType = "visit" | "talk" | "fetch" | "work" | "explore" | "social";
export type QuestStatus = "available" | "active" | "completed" | "claimed";
export type QuestDifficulty = "easy" | "medium" | "hard";

export interface Quest {
  id: string;
  title: string;
  description: string;
  giver: string; // resident id or "board"
  giverName: string;
  type: QuestType;
  category: string; // Daily, Work, Social, Exploration
  targetPlace?: string;
  targetPlaces?: string[];
  targetAgent?: string;
  progress: number;
  required: number;
  reward: { spirits?: number; text: string; progressBonus?: number };
  status: QuestStatus;
  difficulty: QuestDifficulty;
  createdAt: number;
  expiresAt: number | null;
  completedAt?: number;
}

/**
 * Hermes Trials — one contest objective (08 §4.2).
 *
 * Every kind resolves from data the sim already produces; none of them
 * require the outcome layer that `win_argument` would need (08 §3).
 */
export type ContestKind = "gather_at" | "hold_ground" | "tend_project" | "endure";

/** Lifecycle: announced → live → resolved (08 §10.1). */
export type ContestState = "announced" | "live" | "resolved";

/**
 * One row per contestant per live tick — the evidence trail (08 §4.1).
 *
 * `place` is `mind.doing.place`, so a contestant that stopped being simulated
 * simply stops producing samples and is judged on what it did show up for.
 * A contestant with no samples at all does not count as standing.
 */
export interface ContestSample {
  /** wall-clock ms of the tick that produced this row */
  t: number;
  agentId: string;
  place: string;
  spirits: number;
  /** this contestant was hit by a spit during this tick (drives `endure`) */
  wasSpit: boolean;
}

export interface ContestStanding {
  /** resident id of the contestant */
  agentId: string;
  /** rank points: 1st 10, 2nd 5, 3rd 1, rest 0 (08 §4.3). 0 when void. */
  score: number;
  /** 1-based; kept even when the result is void, because that is what the win
   * is narrated from ("won by forfeit") — only the points are zeroed. */
  rank: number;
  /** objective-specific metric, higher is better */
  metric: number;
  /** human-readable evidence, rendered by the HUD and the Daily Spit */
  detail: string;
}

export interface ContestResult {
  standings: ContestStanding[];
  /**
   * True when a single contestant (or none) was still standing at the end —
   * the win is narrated but awards no season points (D7, 08 §4.3).
   */
  voidResult: boolean;
  resolvedAt: number;
}

export interface Contest {
  id: string;
  kind: ContestKind;
  /** headline; always "THE HALL ARGUMENT" in v1 — see 08 §3 */
  title: string;
  /** target location id for `gather_at` / `hold_ground` / `tend_project` */
  place: string;
  startsAt: number;
  endsAt: number;
  state: ContestState;
  /** contestant resident ids — external agents only (D1); never residents. */
  entrants: string[];
  /** the single house agent in this contest, if any (D8: at most one) */
  houseEntrant?: string;
  /** capped evidence trail (08 §11: trimmed on persist) */
  samples: ContestSample[];
  result?: ContestResult;
  /** matchup framing derived from relationships (08 §7.1). Cosmetic only. */
  narration: string;
}

export interface SeasonStanding {
  agentId: string;
  points: number;
  wins: number;
  losses: number;
}

export interface Season {
  id: string;
  /** 1-based season number; the unit of the return cadence (08 §6) */
  no: number;
  startedAt: number;
  /** trials (10 days) → semifinals (top 4) → final → champion (08 §5) */
  state: "trials" | "semifinals" | "final" | "closed";
  standings: SeasonStanding[];
  champion?: string;
  /**
   * Contest ids already folded into `standings`.
   *
   * Optional because older saves predate it, but it MUST live on the object
   * rather than in a module-level cache: the case idempotency exists for is a
   * restart, and that is exactly when an in-process cache is empty. The save
   * is written wholesale, so a property on the season survives the round trip.
   */
  appliedContests?: string[];
}

export interface TownSnapshot {
  now: number;
  config: TownConfig;
  herd: Resident[];
  feed: Post[];
  events: TownEvent[];
  editions: Edition[];
  projects: Project[];
  factions: Faction[];
  quests: Quest[];
  /** external agent registry (optional — older saves without it stay valid) */
  agents?: AgentRecord[];
  /**
   * Hermes Trials contests (08 §11). Optional — older saves have none and
   * the contest HUD must stay unmounted rather than guess at an empty state.
   */
  contests?: Contest[];
  /** current tournament season standings (08 §5) */
  season?: Season;
}

export interface TownConfig {
  name: string;
  ticker: string;
  tokenAddress: string;
  chainName: string;
  network: string;
  rpcUrl: string;
  explorer: string;
  dexUrl: string;
  xUrl: string;
  brain: "llm" | "sim";
  forkCost: string;
  maxHerd: number;
}

// Utility: clamp
export function clamp(min: number, max: number, v: number) {
  return Math.max(min, Math.min(max, v));
}
