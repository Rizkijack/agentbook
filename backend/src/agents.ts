import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import type { TownSnapshot, Resident, AgentRecord } from "@hermesbook/shared";
import { Hc, rf, encodeGenes } from "@hermesbook/shared";
import { createAgentResident, makeResidentFromFork } from "./world.js";

/** An external agent counts as AFK (sim may take over) after this long without an act. */
const afkEnv = Number(process.env.AGENT_AFK_MS ?? 0);
export const AGENT_AFK_MS = Number.isFinite(afkEnv) && afkEnv > 0 ? afkEnv : 900000;

/** Bearer token: "hbk_" + 48 hex chars (24 random bytes). */
export function createToken(): string {
  return "hbk_" + randomBytes(24).toString("hex");
}

/** Only the sha256 hash of a token is ever persisted. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Validation failure → gateway answers 400 with the message. */
export class AgentError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "AgentError";
    this.status = status;
  }
}

// same moderation regex as /api/fork (server.ts) — shared with gateway.ts and server.ts
export const CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F]/;

/**
 * Best-effort client IP: first x-forwarded-for entry, else req.ip.
 * The x-forwarded-for header is client-controlled when no trusted proxy appends
 * to it (spoofable) — usable as a rate-limit hint, never as an identity.
 */
export function clientIp(req: { headers: { [key: string]: string | string[] | undefined }; ip?: string }): string {
  const xf = req.headers["x-forwarded-for"];
  const raw = Array.isArray(xf) ? xf[0] : xf;
  const first = raw?.split(",")[0]?.trim();
  if (first) return first;
  return req.ip ?? "unknown";
}

const MAX_RATE_KEYS = 5000;

/**
 * Fixed-window counter per key (bounded, opportunistic eviction of expired entries).
 * Known limitation: the map is in-memory and per-instance — on a multi-instance
 * deployment (e.g. Vercel) the effective quota is N × max, not max. Not solved here.
 */
export function createRateLimiter(max: number, windowMs: number): (key: string) => boolean {
  // insertion order = age (oldest first), which the size cap relies on
  const buckets = new Map<string, number[]>();
  return (key: string): boolean => {
    const now = Date.now();
    // Evict keys whose whole window elapsed on EVERY call (not only when the same
    // key returns), so stale IPs cannot linger. Bounded by MAX_RATE_KEYS, and only
    // used by the low-rate join/fork endpoints — the ≤5000-entry scan is negligible.
    for (const [k, v] of buckets) {
      if (v.length === 0 || now - v[v.length - 1]! >= windowMs) buckets.delete(k);
    }
    const arr = (buckets.get(key) ?? []).filter((t) => now - t < windowMs);
    if (arr.length >= max) {
      buckets.set(key, arr);
      return false;
    }
    arr.push(now);
    buckets.set(key, arr);
    // hard cap: evict the oldest key so unique-key floods cannot grow memory unbounded
    while (buckets.size > MAX_RATE_KEYS) {
      const oldest = buckets.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      buckets.delete(oldest);
    }
    return true;
  };
}

export interface JoinInput {
  name: string;
  bio?: string;
  job?: string;
  traits?: string[];
  parent?: string;
  origin?: string;
}

export interface JoinResult {
  agentId: string;
  token: string;
  resident: Resident;
}

/**
 * Register an external agent: create (or fork) a resident with control "external",
 * push it to the herd and record its token hash. In-memory only — the caller
 * persists (and rolls back via rollbackJoin if the save fails).
 */
export function joinWorld(world: TownSnapshot, input: JoinInput): JoinResult {
  const name = input.name ?? "";
  const bio = input.bio ?? "";
  const traits = input.traits ?? [];
  const job = input.job ?? "herder";
  const origin = input.origin ?? "unknown";

  if (!name || name.length > 32) throw new AgentError("name must be 1-32 characters");
  if (bio.length > 180) throw new AgentError("bio too long");
  if (traits.length > 3) throw new AgentError("too many traits");
  if (CONTROL_CHARS.test(name + bio)) throw new AgentError("invalid characters");
  if (world.herd.length >= world.config.maxHerd) throw new AgentError("the pasture is full");
  if (world.herd.some((h) => h.name.toLowerCase() === name.toLowerCase())) throw new AgentError("name already taken");

  let resident: Resident;
  if (input.parent) {
    const parent = world.herd.find((h) => h.id === input.parent);
    if (!parent) throw new AgentError("parent not found");
    const childGenes = encodeGenes(rf(Hc(parent.genes), name));
    resident = makeResidentFromFork(parent, name, bio, traits, job, childGenes);
    parent.forks = (parent.forks ?? 0) + 1;
  } else {
    resident = createAgentResident({ name, bio, job, traits });
  }
  resident.mind.control = "external";

  world.herd.push(resident);
  world.now = Date.now();

  const now = Date.now();
  const token = createToken();
  const record: AgentRecord = {
    id: "ag" + randomBytes(8).toString("hex"),
    residentId: resident.id,
    tokenHash: hashToken(token),
    origin,
    joinedAt: now,
    lastActAt: now,
  };

  world.agents ??= [];
  world.agents.push(record);

  return { agentId: record.id, token, resident };
}

/**
 * Undo an in-memory join after a failed persist. Also mirrors the forks++
 * done in joinWorld, so a failed save does not leave the parent's counter
 * inflated (parentId falls back to the removed resident's own parent field).
 */
export function rollbackJoin(world: TownSnapshot, agentId: string, residentId: string, parentId?: string | null): void {
  const removed = world.herd.find((h) => h.id === residentId);
  if (world.agents) world.agents = world.agents.filter((a) => a.id !== agentId);
  world.herd = world.herd.filter((h) => h.id !== residentId);
  const pid = parentId ?? removed?.parent;
  if (pid) {
    const parent = world.herd.find((h) => h.id === pid);
    if (parent) parent.forks = Math.max(0, (parent.forks ?? 1) - 1);
  }
}

/** Constant-time string compare on equal-length buffers (hashes are fixed length). */
function hashEquals(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false; // timingSafeEqual throws on length mismatch
  try {
    return timingSafeEqual(ba, bb);
  } catch {
    return false; // defensive: never fail open
  }
}

/** Resolve a bearer token to its registry entry, or null when invalid/orphaned. */
export function verifyToken(world: TownSnapshot, token: string): AgentRecord | null {
  if (!token) return null;
  const hash = hashToken(token);
  for (const record of world.agents ?? []) {
    if (!hashEquals(record.tokenHash, hash)) continue;
    // resolve resident: a record whose resident vanished cannot act
    if (!world.herd.some((h) => h.id === record.residentId)) return null;
    return record;
  }
  return null;
}

/** Mark activity so the agent stays out of sim control. */
export function touch(record: AgentRecord): void {
  record.lastActAt = Date.now();
}

export function isAfk(record: AgentRecord, now = Date.now()): boolean {
  return now - record.lastActAt > AGENT_AFK_MS;
}

/**
 * Sim scheduler eligibility: residents without external control always run;
 * externally controlled residents only when their agent went AFK (or has no
 * registry record at all — then nobody can ever act for them, so sim takes over).
 */
export function isEligibleForSim(world: TownSnapshot, residentId: string, now = Date.now()): boolean {
  const resident = world.herd.find((h) => h.id === residentId);
  if (!resident) return false;
  if (resident.mind.control !== "external") return true;
  const record = (world.agents ?? []).find((a) => a.residentId === residentId);
  if (!record) return true;
  return isAfk(record, now);
}

/**
 * Next resident the sim may drive this tick: round-robin via the scheduler,
 * skipping externally-controlled residents whose agent is still active.
 * Returns null when nobody in the rotation is eligible (or the rotation is
 * empty) — the caller then simply skips the tick. Extracted from the server
 * scheduler loop so the skip logic is unit-testable.
 */
export function pickNextSimId(world: TownSnapshot, scheduler: { next(): string | null }, now = Date.now()): string | null {
  const maxTries = Math.max(1, world.herd.length);
  for (let i = 0; i < maxTries; i++) {
    const candidate = scheduler.next();
    if (!candidate) return null;
    if (isEligibleForSim(world, candidate, now)) return candidate;
  }
  return null;
}

// rate limit: 30 acts/minute per token (same Map pattern as checkRateLimit in server.ts)
const actBuckets = new Map<string, number[]>();
export const ACT_RATE_MAX = 30;
export const ACT_RATE_WINDOW_MS = 60_000;

export function rateLimitAct(token: string, max = ACT_RATE_MAX, windowMs = ACT_RATE_WINDOW_MS): boolean {
  const key = hashToken(token);
  const now = Date.now();
  const arr = (actBuckets.get(key) ?? []).filter((t) => now - t < windowMs);
  if (arr.length >= max) {
    actBuckets.set(key, arr);
    return false;
  }
  arr.push(now);
  actBuckets.set(key, arr);
  return true;
}
