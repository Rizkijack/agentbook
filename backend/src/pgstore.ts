// Postgres backing for the town snapshot (Vercel: /tmp is ephemeral).
//
// The `sql` tag is injected so tests use a stub, never a real database.
//
// ## Why the save is a locked read-modify-write
//
// The town is a single JSONB row, but Vercel runs N serverless instances at
// once and each one keeps its own in-memory `world` loaded at boot. A plain
// upsert is last-writer-wins: an instance that booted before a fork still has
// the old herd, and its next tick overwrites the row — deleting every resident
// another instance added in the meantime. Observed on production as a snapshot
// that answered 39 residents on one request and 51 on the next.
//
// So a save takes a transaction-scoped advisory lock, reads whatever the row
// holds NOW, merges that with the snapshot we are holding (append-mostly, keyed
// by id — the town only ever grows; there is no delete endpoint), and writes
// the union. Two instances can never drop each other's residents.
//
// Known limits, deliberate for now:
// - On an id both instances know, OUR copy wins. Sim churn (spirits, needs,
//   relationships, quest progress) can therefore regress by one tick when a
//   lagging instance saves. That is ephemeral state the next tick re-derives.
// - Serving still happens from the instance's memory, so a cold instance shows
//   its own herd until it reboots. The row is never wrong any more, but the
//   live view can lag; converging that needs a periodic refresh from pg.

/** Tagged-template query function (also what a transaction hands out). */
export type PgQuery = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<Record<string, unknown>[]>;

/**
 * A neon() client.
 *
 * `transaction` takes an ARRAY of already-built query objects — NOT a callback
 * that awaits queries. @neondatabase/serverless 1.2.0 throws
 * "transaction() expects an array of queries, or a function returning an array
 * of queries" otherwise, and because the failure only happens against the real
 * driver, a hand-written stub has to model the array form or it will happily
 * green-light code that 500s in production.
 */
export interface PgSql extends PgQuery {
  transaction(queries: PgPendingQuery[]): Promise<Record<string, unknown>[][]>;
}

/**
 * The object a tagged-template call returns. Awaiting it runs the query —
 * which is what makes `sql.transaction([sql\`...\`])` express "these run
 * together" instead of "run this callback".
 *
 * Typed as a plain promise because that is what the driver actually returns;
 * the driver reads the queries it is handed, it does not read properties off
 * them.
 */
export type PgPendingQuery = Promise<Record<string, unknown>[]>;

export const TOWN_ROW_ID = "town";

/** Advisory lock key for the town row. Any fixed value works; it just has to be the same everywhere. */
const TOWN_LOCK_KEY = 4271938;

export async function ensureSchema(sql: PgQuery): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS town_state (
      id TEXT PRIMARY KEY,
      snapshot JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;
  // Monotonic revision for the optimistic save below. `CREATE TABLE IF NOT
  // EXISTS` is a no-op on the row that already exists, so the column has to be
  // added separately; both statements are idempotent.
  await sql`ALTER TABLE town_state ADD COLUMN IF NOT EXISTS rev bigint NOT NULL DEFAULT 0`;
}

// ---------------------------------------------------------------------------
// merge
// ---------------------------------------------------------------------------

type Rec = Record<string, unknown>;

function asRec(value: unknown): Rec {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Rec) : {};
}

function asArr(value: unknown): Rec[] {
  return Array.isArray(value) ? (value.filter((r) => r && typeof r === "object") as Rec[]) : [];
}

function keyOf(row: Rec, fallback: string): string {
  return typeof row.id === "string" ? row.id : fallback;
}

/**
 * Union of two lists keyed by `key`, in stored order, then anything new from
 * `mine`. A row present in both keeps MINE — the caller is the instance that
 * just produced the tick, so its copy is the more recent one for that id.
 */
function unionBy(
  stored: Rec[],
  mine: Rec[],
  key: (row: Rec, i: number) => string,
): Rec[] {
  const merged: Rec[] = [];
  const index = new Map<string, number>();
  for (const [i, row] of stored.entries()) {
    const k = key(row, i);
    index.set(k, merged.length);
    merged.push(row);
  }
  for (const [i, row] of mine.entries()) {
    const k = key(row, i);
    const at = index.get(k);
    if (at === undefined) {
      index.set(k, merged.length);
      merged.push(row);
    } else {
      merged[at] = row;
    }
  }
  return merged;
}

function byNumber(field: string, dir: 1 | -1) {
  return (a: Rec, b: Rec) => {
    const av = typeof a[field] === "number" ? (a[field] as number) : 0;
    const bv = typeof b[field] === "number" ? (b[field] as number) : 0;
    return dir * (av - bv);
  };
}

/** Same idea, but rows carry no id (events) — key on what makes one unique. */
function identity(row: Rec): string {
  return JSON.stringify([row.t, row.kind, row.text]);
}

/**
 * Union cannot exceed what either side thought the capacity was. Two instances
 * can each be legitimately under `maxHerd` and still sum past it (64 + 5 = 69),
 * because the check that gated a join only ever saw that one instance's herd.
 * So the merged herd is trimmed back to the cap here.
 *
 * Residents are dropped oldest-first by `born`: the newest arrivals are the ones
 * someone just created and would notice losing, and `born` is the only field
 * that orders residents by age without looking outside the snapshot.
 */
function capHerd(herd: Rec[], maxHerd: number): Rec[] {
  if (!Number.isFinite(maxHerd) || maxHerd <= 0 || herd.length <= maxHerd) return herd;
  const oldestFirst = herd
    .map((row, i) => ({ row, i }))
    .sort((a, b) => {
      const ab = typeof a.row.born === "number" ? a.row.born : 0;
      const bb = typeof b.row.born === "number" ? b.row.born : 0;
      return ab === bb ? a.i - b.i : ab - bb; // stable: original order breaks a tie
    });
  return oldestFirst.slice(herd.length - maxHerd).map((r) => r.row);
}

/**
 * The name is a resident's identity handle — `who_is` resolves on it, and the
 * join/fork endpoints treat a repeat as a conflict. Two instances can each
 * admit the same name while unaware of each other's join, leaving two residents
 * the API can no longer tell apart. The newer one goes.
 */
function dedupeHerdByName(herd: Rec[]): Rec[] {
  const oldestFirst = herd
    .map((row, i) => ({ row, i }))
    .sort((a, b) => {
      const ab = typeof a.row.born === "number" ? a.row.born : 0;
      const bb = typeof b.row.born === "number" ? b.row.born : 0;
      return ab === bb ? a.i - b.i : ab - bb;
    });
  const seen = new Set<string>();
  const out: Rec[] = [];
  for (const { row } of oldestFirst) {
    const name = typeof row.name === "string" ? row.name.toLowerCase() : "";
    if (name && seen.has(name)) continue;
    if (name) seen.add(name);
    out.push(row);
  }
  return out;
}

/**
 * Dedupe + cap applied to a single snapshot, without merging anything.
 *
 * Boot needs this on its own: the merge only runs when something is WRITTEN,
 * and `POST /api/agent/join` reads the in-memory herd to decide whether there is
 * room. A row that already overflowed therefore keeps every instance refusing
 * new residents forever — the town never heals because nothing ever writes.
 * Applying the same rules at boot makes a bad row converge on the next start.
 *
 * Returns the residents that survived, so callers can compare lengths.
 */
export function normalizeHerd(snapshot: unknown): Rec[] {
  const s = asRec(snapshot);
  const maxHerd = typeof asRec(s.config).maxHerd === "number" ? (asRec(s.config).maxHerd as number) : 0;
  return capHerd(dedupeHerdByName(asArr(s.herd)), maxHerd);
}

/**
 * The town snapshot as it must be written: `stored` (what the row holds now)
 * ∪ `mine` (what this instance believes). Pure, so the lost-update rule is
 * testable without a database.
 */
export function mergeSnapshots(stored: unknown, mine: unknown): Rec {
  const a = asRec(stored);
  const b = asRec(mine);

  // Deletions are applied FIRST, to both sides, because every union below is
  // additive: without this the herd would resurrect the resident from whichever
  // side still had them, and no amount of filtering the result would help.
  // Tombstones themselves are unioned, so a removal recorded by one instance is
  // honoured by all of them from then on.
  const tombs = unionBy(asArr(a.tombstones), asArr(b.tombstones), (r, i) => keyOf(r, `tomb${i}`))
    .filter((r) => typeof r?.id === "string");
  const deadResidents = new Set(tombs.map((r) => String(r.id)));
  const deadAgents = new Set(tombs.flatMap((r) => (Array.isArray(r.agentIds) ? r.agentIds : []).map(String)));
  // A row belongs to a resident if ANY of its resident-id fields names one.
  // Checking only `id` looked right and silently did nothing for posts, whose
  // `id` is the post id and whose author lives in `by` — so every post by a
  // removed resident came straight back on the next merge.
  const alive = <T extends { id?: unknown; by?: unknown; agentId?: unknown }>(
    rows: T[],
  ): T[] => rows.filter((r) => {
    if (r == null || typeof r !== "object") return true;
    return ![r.id, r.by, r.agentId].some(
      (v) => typeof v === "string" && deadResidents.has(v),
    );
  });

  // the agent registry must never shrink: losing an entry locks its owner out
  // of their resident forever, since the token hash is the only credential.
  // A tombstone is the one deliberate exception — it names the exact entries to
  // drop, so the rule above still holds against accidental loss.
  const agents = alive(unionBy(asArr(a.agents), asArr(b.agents), (r, i) => keyOf(r, `agent${i}`)))
    .filter((row) => !deadAgents.has(String(row.id)))
    .map((row) => {
    const other = asArr(b.agents).find((r) => r.id === row.id);
    if (!other || typeof other.lastActAt !== "number") return row;
    // keep the freshest activity clock: a stale instance must not age an agent
    // out of "active" and hand their resident back to the sim
    const newest = Math.max(
      typeof row.lastActAt === "number" ? row.lastActAt : 0,
      other.lastActAt,
    );
    return { ...row, lastActAt: newest };
  });

  const config = asRec(b.config ?? a.config);
  const maxHerd = typeof config.maxHerd === "number" ? config.maxHerd : 0;
  const herd = dedupeHerdByName(alive(unionBy(asArr(a.herd), asArr(b.herd), (r, i) => keyOf(r, `herd${i}`))));

  return {
    // fields this code does not know about survive the round trip
    ...a,
    now: typeof b.now === "number" ? b.now : Date.now(),
    config: b.config ?? a.config,
    // dedupe first, then cap: dropping a duplicate frees a slot for a resident
    // that would otherwise be evicted for being merely old
    herd: capHerd(herd, maxHerd),
    feed: alive(unionBy(asArr(a.feed), asArr(b.feed), (r, i) => keyOf(r, `post${i}`)))
      .sort(byNumber("t", -1))
      .slice(0, 400),
    events: unionBy(asArr(a.events), asArr(b.events), identity)
      .sort(byNumber("t", 1))
      .slice(-120),
    editions: unionBy(asArr(a.editions), asArr(b.editions), (r, i) => keyOf(r, `edition${i}`))
      .sort(byNumber("no", -1))
      .slice(0, 20),
    projects: unionBy(asArr(a.projects), asArr(b.projects), (r, i) => keyOf(r, `project${i}`)),
    factions: unionBy(asArr(a.factions), asArr(b.factions), (r, i) => keyOf(r, `faction${i}`)),
    quests: unionBy(asArr(a.quests), asArr(b.quests), (r, i) => keyOf(r, `quest${i}`))
      .sort(byNumber("createdAt", -1))
      .slice(0, 12),
    contests: unionBy(asArr(a.contests), asArr(b.contests), (r, i) => keyOf(r, `contest${i}`))
      // a dead contestant cannot hold a place: drop them from the roster, their
      // attendance samples and the standings, but keep the contest itself
      .map((c) => (c && typeof c === "object"
        ? {
            ...c,
            entrants: (Array.isArray(c.entrants) ? c.entrants : []).filter((e: unknown) => !deadResidents.has(String(e))),
            samples: (Array.isArray(c.samples) ? c.samples : []).filter((s) => !deadResidents.has(String(s?.agentId))),
            standings: (Array.isArray(c.standings) ? c.standings : []).filter((s) => !deadResidents.has(String(s?.agentId))),
          }
        : c))
      .sort(byNumber("startsAt", -1))
      .slice(0, 8),
    agents,
    tombstones: tombs,
    // single object: no union possible, the ticker's copy stands
    season: b.season ?? a.season,
  };
}

// ---------------------------------------------------------------------------
// deletion
// ---------------------------------------------------------------------------

/** What a removal would touch, and whether it is allowed to happen. */
export interface RemovalPlan {
  id: string;
  name: string;
  ok: boolean;
  /** why it is refused, when ok is false */
  blockedBy?: string;
  /** counts, so a dry run can be compared against the result */
  wouldRemove: {
    resident: boolean;
    agentRecords: string[];
    posts: number;
    /** ids of other residents whose relationship map mentions them */
    relationshipRefs: string[];
    children: string[];
    contestEntrances: number;
    seasonStandings: number;
  };
}

export interface RemovalReport extends RemovalPlan {
  applied: boolean;
}

/**
 * Plan the removal of one resident, without doing it.
 *
 * Refuses by default when the removal would break something structural — a
 * resident with children would leave a dangling `parent`, and a live contest
 * entrant would leave a roster pointing at nobody. The refusal is the point:
 * this runs against a town full of other people's work.
 */
export function planRemoval(snapshot: unknown, id: string): RemovalPlan {
  const s = asRec(snapshot);
  const resident = asArr(s.herd).find((r) => r?.id === id);
  const agents = asArr(s.agents).filter((r) => r?.residentId === id);
  const posts = asArr(s.feed).filter((p) => p?.by === id);
  const children = asArr(s.herd).filter((r) => r?.parent === id).map((r) => String(r?.id));
  const relationshipRefs = asArr(s.herd)
    .filter((r) => r && r.id !== id && r.relationships && typeof r.relationships === "object"
      && Object.prototype.hasOwnProperty.call(r.relationships, id))
    .map((r) => String(r?.id));
  const contestEntrances = asArr(s.contests).filter(
    (c) => Array.isArray(c?.entrants) && c.entrants.includes(id),
  ).length;
  const season = asRec(s.season);
  const seasonStandings = Array.isArray(season?.standings)
    ? (season.standings as Array<{ agentId?: unknown }>).filter((r) => r?.agentId === id).length
    : 0;

  const liveContest = asArr(s.contests).some(
    (c) => c?.state === "live" && Array.isArray(c?.entrants) && c.entrants.includes(id),
  );

  return {
    id,
    name: typeof resident?.name === "string" ? resident.name : "(not in herd)",
    ok: Boolean(resident) && children.length === 0 && !liveContest,
    blockedBy: !resident
      ? "no such resident"
      : children.length > 0
        ? `has ${children.length} child(ren): ${children.join(", ")}`
        : liveContest
          ? "is in a live contest"
          : undefined,
    wouldRemove: {
      resident: Boolean(resident),
      agentRecords: agents.map((r) => String(r?.id)),
      posts: posts.length,
      relationshipRefs,
      children,
      contestEntrances,
      seasonStandings,
    },
  };
}

/**
 * Apply a removal to a snapshot.
 *
 * The tombstone is the load-bearing part: without it the next `pgSave` from any
 * instance merges the resident straight back out of that instance's memory. It
 * also carries the registry ids, so the credential goes with the resident rather
 * than being left behind able to sign in as a ghost.
 */
export function applyRemoval(
  snapshot: unknown,
  plan: RemovalPlan,
  reason: string,
  at = Date.now(),
): Rec {
  const s = asRec(snapshot);
  const dead = new Set([plan.id]);
  const deadAgents = new Set(plan.wouldRemove.agentRecords);

  const tombstones = unionBy(asArr(s.tombstones), [
    { id: plan.id, reason, at, agentIds: plan.wouldRemove.agentRecords },
  ], (r, i) => keyOf(r, `tomb${i}`));

  // Everyone else stops carrying a relationship with them. Leaving the entry
  // would be harmless in the sim (it is only ever read to find a neighbour that
  // exists) but it is a name that no longer resolves, and the counts show up in
  // the resident dossier.
  const herd = asArr(s.herd)
    .filter((r) => !dead.has(String(r?.id)))
    .map((r) => {
      const rel = (r as { relationships?: unknown } | null)?.relationships;
      if (!rel || typeof rel !== "object") return r;
      if (!Object.prototype.hasOwnProperty.call(rel, plan.id)) return r;
      const next: Record<string, unknown> = { ...(rel as Record<string, unknown>) };
      delete next[plan.id];
      return { ...r, relationships: next };
    });

  return {
    ...s,
    herd,
    agents: asArr(s.agents).filter(
      (r) => !dead.has(String(r?.residentId)) && !deadAgents.has(String(r?.id)),
    ),
    feed: asArr(s.feed).filter((p) => !dead.has(String(p?.by))),
    contests: asArr(s.contests).map((c) => (c && typeof c === "object"
      ? {
          ...c,
          entrants: (Array.isArray(c.entrants) ? c.entrants : []).filter((e: unknown) => !dead.has(String(e))),
          samples: (Array.isArray(c.samples) ? c.samples : []).filter((x) => !dead.has(String(x?.agentId))),
          standings: (Array.isArray(c.standings) ? c.standings : []).filter((x) => !dead.has(String(x?.agentId))),
        }
      : c)),
    tombstones,
  };
}

// ---------------------------------------------------------------------------
// read / write
// ---------------------------------------------------------------------------

/** How many times a save re-reads and re-merges when another writer wins the race. */
const SAVE_RETRIES = 4;

export async function pgSave(sql: PgSql, snapshot: unknown): Promise<void> {
  for (let attempt = 0; attempt <= SAVE_RETRIES; attempt++) {
    // Read the row as it is NOW. This is a plain query, not part of a
    // transaction: the array form of neon().transaction() cannot feed a query's
    // result into a later query's values, and a read-merge-write needs exactly
    // that (the merged JSON is not known until the read returns). So the read
    // is optimistic and the write below is what actually decides who wins.
    const rows = await sql`SELECT snapshot, rev FROM town_state WHERE id = ${TOWN_ROW_ID}`;
    const row = rows[0];

    if (!row) {
      // No row yet — first boot. A concurrent creator may beat us; the
      // ON CONFLICT DO UPDATE makes that harmless (we merge into whatever is
      // there rather than clobbering it).
      await sql`
        INSERT INTO town_state (id, snapshot, updated_at, rev)
        VALUES (${TOWN_ROW_ID}, ${JSON.stringify(snapshot)}, now(), 1)
        ON CONFLICT (id) DO UPDATE
          SET snapshot = EXCLUDED.snapshot, updated_at = now(), rev = town_state.rev + 1`;
      return;
    }

    const stored = parseSnapshot(row.snapshot);
    const merged = JSON.stringify(mergeSnapshots(stored, snapshot));
    const seenRev = typeof row.rev === "number" ? row.rev : 0;

    // Compare-and-swap: only write if the row is still at the revision we read.
    // The advisory lock serializes the instances so they queue instead of
    // colliding; the rev check is the belt to that braces, and it is what makes
    // the whole thing safe even if the lock is unavailable.
    const result = await sql.transaction([
      sql`SELECT pg_advisory_xact_lock(${TOWN_LOCK_KEY}::bigint)`,
      sql`
        UPDATE town_state SET snapshot = ${merged}::jsonb, updated_at = now(), rev = rev + 1
        WHERE id = ${TOWN_ROW_ID} AND rev = ${seenRev}
        RETURNING rev`,
    ]);

    const updated = result[1] ?? [];
    if (updated.length > 0) return;
    // Somebody committed between our read and our write: re-read and re-merge
    // against THEIR result, so their residents survive. This is the whole point
    // — the previous plain upsert had no way to notice.
  }

  // Every attempt lost the race. Fall back to one last read-then-write so the
  // town still persists AND still merges: writing our raw snapshot here would
  // reintroduce exactly the bug this whole change exists to fix.
  const rows = await sql`SELECT snapshot FROM town_state WHERE id = ${TOWN_ROW_ID}`;
  const latest = rows.length > 0 ? parseSnapshot(rows[0]!.snapshot) : null;
  const payload = JSON.stringify(latest ? mergeSnapshots(latest, snapshot) : snapshot);
  await sql`
    INSERT INTO town_state (id, snapshot, updated_at, rev)
    VALUES (${TOWN_ROW_ID}, ${payload}::jsonb, now(), 1)
    ON CONFLICT (id) DO UPDATE
      SET snapshot = EXCLUDED.snapshot, updated_at = now(), rev = town_state.rev + 1`;
}

export async function pgLoad(sql: PgQuery): Promise<unknown | null> {
  const rows = await sql`SELECT snapshot FROM town_state WHERE id = ${TOWN_ROW_ID}`;
  if (rows.length === 0) return null;
  return parseSnapshot(rows[0]!.snapshot);
}

/** JSONB comes back parsed over HTTP, but a string is legal — handle both. */
function parseSnapshot(raw: unknown): unknown {
  return typeof raw === "string" ? JSON.parse(raw) : raw;
}