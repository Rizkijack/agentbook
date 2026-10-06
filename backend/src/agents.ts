import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import type { TownSnapshot, Resident, AgentRecord } from "@slopagentbook/shared";
import { Hc, rf, encodeGenes } from "@slopagentbook/shared";
import { createAgentResident, makeResidentFromFork } from "./world.js";

/** An external agent counts as AFK (sim may take over) after this long without an act. */
const afkEnv = Number(process.env.AGENT_AFK_MS ?? 0);
export const AGENT_AFK_MS = Number.isFinite(afkEnv) && afkEnv > 0 ? afkEnv : 900000;

/** Bearer token: "sabk_" + 48 hex chars (24 random bytes). */
export function createToken(): string {
  return "sabk_" + randomBytes(24).toString("hex");
}

/** Only the sha256 hash of a token is ever persisted. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Validation failure → gateway answers 400 with the message. */
export class AgentError extends Error {
  status: number;
  /**
   * Name of the offending body field, when the failure is about one (`links[2].url`).
   * Set by the profile validators so a client form can point at the input; the
   * message always names it too, so nothing depends on this being present.
   */
  field?: string;
  constructor(message: string, status = 400, field?: string) {
    super(message);
    this.name = "AgentError";
    this.status = status;
    this.field = field;
  }
}

// same moderation regex as /api/fork (server.ts) — shared with gateway.ts and server.ts
export const CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F]/;
/**
 * Single-line fields (agent handle, owner account) additionally reject \t \n \r
 * and DEL: they flow into feed lines and the HUD card, where a newline would
 * break the row layout. Name/bio keep the laxer regex above — \n there is
 * historical behaviour other tests rely on.
 */
export const SINGLE_LINE_CONTROL = /[\x00-\x1F\x7F]/;

// ---------------------------------------------------------------------------
// profile text: bio, avatar, links
//
// These are the only fields a token holder may write after registration, and the
// avatar/link strings are the only resident-supplied values the town will ever
// hand to something that dereferences them (a renderer). So they are validated
// once, here, at the boundary — not in the client, which is not a boundary.
// ---------------------------------------------------------------------------

/**
 * Bio bound for the profile edit endpoint. 280 is the same ceiling `say`,
 * `act.speech` and `act.why` already use, so resident-authored prose has one
 * number in this codebase.
 *
 * Registration keeps its own, older 180 bound (`joinWorld`, `forkSchema`): that
 * one is documented in 04 §4 and covered by existing tests, and widening it is
 * a different decision from adding an edit endpoint. The two are deliberately
 * different numbers, and this constant is the only thing that governs editing.
 */
export const PROFILE_BIO_MAX = 280;

/** Bound on any single resident-supplied URL (avatar or one link). */
export const PROFILE_URL_MAX = 300;

/** Bound on a link's label — it renders inside one HUD row next to the url. */
export const PROFILE_LINK_LABEL_MAX = 32;

/** Links per resident. Five is what a profile card can lay out without scrolling. */
export const PROFILE_LINKS_MAX = 5;

/**
 * Schemes a resident-supplied URL may use. Absolute only — there is no
 * relative form, because a profile link is rendered on someone else's page and
 * a relative one would resolve against the town, not against its owner.
 */
const URL_SCHEMES = new Set(["http:", "https:"]);

/**
 * `data:` is refused by name, not just by falling out of the allowlist above.
 *
 * A `data:image/svg+xml` payload is inline script the moment anything renders
 * it, and inlined bytes are the one shape that makes the town row unbounded:
 * the whole snapshot is a single JSONB blob and the herd is capped at 64, so
 * resident-authored megabytes would live there forever. Naming it keeps the
 * intent greppable — the allowlist rejecting it is a side effect, this is the rule.
 */
const URL_SCHEME_REFUSED = /^data:/i;

/**
 * AgentError carrying the offending field name, so the 400 a caller sees can be
 * pointed at one input. Same error class as every other validation failure here —
 * `field` is additive, and the message always names the field too.
 */
function profileError(field: string, message: string): AgentError {
  return new AgentError(message, 400, field);
}

/**
 * Parse a resident-supplied URL and return it in normalized form, or throw
 * `AgentError` (400) naming the field.
 *
 * ## This function never touches the network. Never.
 *
 * It does not fetch, HEAD, resolve DNS, or open a socket — not now, not later
 * "to check the avatar loads". "Validate the avatar" reads like an invitation to
 * add exactly that, and doing it would put a resident-controlled URL on our
 * request path (a server-side request forgery primitive), on every profile
 * write, from a town whose members are strangers by construction. Reachability,
 * content type and image dimensions are the renderer's problem; this returns a
 * string or refuses it.
 *
 * Rejected: anything with a control character (the WHATWG parser silently strips
 * `\u0007` out of a path, so a parse alone does not catch this), any scheme
 * outside the allowlist — `javascript:`, `data:`, `vbscript:`, `file:`, `mailto:` —
 * protocol-relative `//host`, and anything that does not parse as an absolute
 * URL at all.
 */
export function parseProfileUrl(field: string, value: unknown): string {
  if (typeof value !== "string") throw profileError(field, `${field} must be a string`);
  const raw = value.trim();
  if (!raw) throw profileError(field, `${field} is required`);
  if (raw.length > PROFILE_URL_MAX) throw profileError(field, `${field} too long (max ${PROFILE_URL_MAX} characters)`);
  // checked on the raw string, before parsing: `new URL` normalises control
  // characters away instead of rejecting them
  if (SINGLE_LINE_CONTROL.test(raw)) throw profileError(field, `${field} contains control characters`);
  if (URL_SCHEME_REFUSED.test(raw)) throw profileError(field, `${field} must not be a data: URL`);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    // no base is passed on purpose: a relative or protocol-relative string must
    // fail here rather than silently resolve against the town
    throw profileError(field, `${field} must be an absolute http(s) URL`);
  }
  if (!URL_SCHEMES.has(url.protocol)) throw profileError(field, `${field} must use http: or https:`);
  if (!url.host) throw profileError(field, `${field} must be an absolute http(s) URL`);
  return url.toString();
}

/**
 * Validate a resident's link list. At most {@link PROFILE_LINKS_MAX} entries,
 * each a `label`/`url` pair; the returned array is fresh, so callers can store
 * it without aliasing anything the caller still holds. Order is preserved —
 * the owner chose it.
 */
export function parseProfileLinks(value: unknown): { label: string; url: string }[] {
  if (!Array.isArray(value)) throw profileError("links", "links must be an array");
  if (value.length > PROFILE_LINKS_MAX) throw profileError("links", `too many links (max ${PROFILE_LINKS_MAX})`);
  return value.map((entry, i) => {
    const row = entry as { label?: unknown; url?: unknown } | null;
    if (!row || typeof row !== "object" || Array.isArray(row)) throw profileError(`links[${i}]`, `links[${i}] must be a {label, url} object`);
    const field = `links[${i}].label`;
    if (typeof row.label !== "string") throw profileError(field, `${field} must be a string`);
    const label = row.label.trim();
    if (!label) throw profileError(field, `${field} is required`);
    if (label.length > PROFILE_LINK_LABEL_MAX) {
      throw profileError(field, `${field} too long (max ${PROFILE_LINK_LABEL_MAX} characters)`);
    }
    if (SINGLE_LINE_CONTROL.test(label)) throw profileError(field, `${field} contains control characters`);
    return { label, url: parseProfileUrl(`links[${i}].url`, row.url) };
  });
}

/**
 * A validated profile write: exactly the three editable fields, each present
 * only when the caller sent it. `null` means "remove this" for the two optional
 * fields — without it an owner could set an avatar but never take it down.
 */
export interface ProfilePatch {
  bio?: string;
  avatar?: string | null;
  links?: { label: string; url: string }[] | null;
}

/**
 * Pull the editable fields out of a request body and validate all of them
 * BEFORE anything is written.
 *
 * Fields are picked explicitly rather than spread onto the resident: identity
 * (`id`, `born`, `gen`, `parent`, `forks`), `mind`, `needs`, `relationships`
 * and `control` are not editable here, and picking is what makes that true by
 * construction instead of by remembering a denylist. An unknown key is ignored,
 * not refused, so adding a field elsewhere never breaks a client that sends it.
 */
export function parseProfilePatch(body: unknown): ProfilePatch {
  const src = (body && typeof body === "object" && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
  const has = (key: string): boolean => Object.prototype.hasOwnProperty.call(src, key);
  const patch: ProfilePatch = {};

  if (has("bio")) {
    const bio = src.bio;
    if (typeof bio !== "string") throw profileError("bio", "bio must be a string");
    if (bio.length > PROFILE_BIO_MAX) throw profileError("bio", `bio too long (max ${PROFILE_BIO_MAX} characters)`);
    if (CONTROL_CHARS.test(bio)) throw profileError("bio", "bio contains control characters");
    patch.bio = bio;
  }
  if (has("avatar")) {
    patch.avatar = src.avatar === null ? null : parseProfileUrl("avatar", src.avatar);
  }
  if (has("links")) {
    patch.links = src.links === null ? null : parseProfileLinks(src.links);
  }
  if (patch.bio === undefined && patch.avatar === undefined && patch.links === undefined) {
    throw new AgentError("nothing to update: send bio, avatar or links");
  }
  return patch;
}

/**
 * Apply a validated patch and report which fields actually changed — an edit
 * that matches what is already stored is a no-op the caller should be able to
 * see, not a silent "ok".
 */
export function applyProfilePatch(resident: Resident, patch: ProfilePatch): string[] {
  const changed: string[] = [];

  if (patch.bio !== undefined && patch.bio !== resident.bio) {
    resident.bio = patch.bio;
    changed.push("bio");
  }
  if (patch.avatar !== undefined) {
    if (patch.avatar === null) {
      if (resident.avatar !== undefined) {
        delete resident.avatar;
        changed.push("avatar");
      }
    } else if (patch.avatar !== resident.avatar) {
      resident.avatar = patch.avatar;
      changed.push("avatar");
    }
  }
  if (patch.links !== undefined) {
    if (patch.links === null) {
      if (resident.links !== undefined) {
        delete resident.links;
        changed.push("links");
      }
    } else if (!linksEqual(resident.links, patch.links)) {
      // an empty list is stored as an absent field: a cleared profile should not
      // carry `links: []` through every merge and every snapshot forever
      if (patch.links.length === 0) delete resident.links;
      else resident.links = patch.links;
      changed.push("links");
    }
  }
  return changed;
}

/** Order matters to the owner, so two lists are equal only element-wise, in order. */
function linksEqual(a: { label: string; url: string }[] | undefined, b: { label: string; url: string }[]): boolean {
  if (!Array.isArray(a) || a.length !== b.length) return false;
  return b.every((l, i) => a[i]?.label === l.label && a[i]?.url === l.url);
}

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
  /** Agent account handle (registration page `#/register`). Absent → derived from the name. */
  handle?: string;
  /** Human owner behind the agent (registration page `#/register`). Optional for backward compatibility. */
  owner?: { name: string; handle: string };
  /** Custom avatar URL. Same rules as the profile endpoint's `avatar`. */
  avatar?: string;
  /** External links, in the owner's order. Same rules as the profile endpoint's `links`. */
  links?: { label: string; url: string }[];
}

export interface JoinResult {
  agentId: string;
  token: string;
  resident: Resident;
  owner?: { name: string; handle: string };
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
  // job/traits/origin flow into the herd broadcast — same moderation as name/bio
  if (CONTROL_CHARS.test(job + origin + traits.join(""))) throw new AgentError("invalid characters");

  // agent account handle: free-form, but bounded and clean (same moderation as name/bio)
  const handle = (input.handle ?? "").trim();
  if (handle.length > 32) throw new AgentError("handle must be 1-32 characters");
  if (handle && SINGLE_LINE_CONTROL.test(handle)) throw new AgentError("invalid characters");

  // profile presentation: validated here, BEFORE any world mutation, so a bad
  // url never gets as far as the herd push below (same ordering rule as the
  // owner block next to it)
  const avatar = input.avatar === undefined ? undefined : parseProfileUrl("avatar", input.avatar);
  const links = input.links === undefined ? undefined : parseProfileLinks(input.links);

  // owner account: validated BEFORE any world mutation, so a full pasture never
  // masks a bad payload (same ordering rule as the name/parent checks below)
  const owner = input.owner;
  if (owner) {
    if (owner.name.length < 1 || owner.name.length > 64) throw new AgentError("owner name must be 1-64 characters");
    if (owner.handle.length < 1 || owner.handle.length > 64) throw new AgentError("owner handle must be 1-64 characters");
    if (SINGLE_LINE_CONTROL.test(owner.name + owner.handle)) throw new AgentError("invalid characters");
  }

  if (world.herd.some((h) => h.name.toLowerCase() === name.toLowerCase())) throw new AgentError("name already taken");
  // handles resolve identity in who_is (first match wins) — a duplicate would
  // silently impersonate, so treat it like the name: unique, case-insensitive
  if (handle && world.herd.some((h) => (h.handle ?? "").toLowerCase() === handle.toLowerCase())) {
    throw new AgentError("handle already taken");
  }

  const parent = input.parent ? world.herd.find((h) => h.id === input.parent) : undefined;
  if (input.parent && !parent) throw new AgentError("parent not found");

  // Capacity is checked last — right before the first mutation (forks++ below) —
  // so a full pasture never masks a bad payload. Same contract as POST /api/fork:
  // validate the input first, then apply the world-state constraint.
  if (world.herd.length >= world.config.maxHerd) throw new AgentError("the pasture is full");

  let resident: Resident;
  if (parent) {
    const childGenes = encodeGenes(rf(Hc(parent.genes), name));
    resident = makeResidentFromFork(parent, name, bio, traits, job, childGenes);
    parent.forks = (parent.forks ?? 0) + 1;
  } else {
    resident = createAgentResident({ name, bio, job, traits });
  }
  resident.mind.control = "external";
  if (handle) resident.handle = handle; // registration page: the typed agent account handle
  // deliberately NOT inherited from the parent: an avatar is a person's, not a bloodline's
  if (avatar !== undefined) resident.avatar = avatar;
  if (links !== undefined && links.length > 0) resident.links = links;

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
  if (owner) record.owner = { name: owner.name, handle: owner.handle };

  world.agents ??= [];
  world.agents.push(record);

  return { agentId: record.id, token, resident, owner: record.owner };
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
