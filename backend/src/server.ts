import express from "express";
import cors from "cors";
import type { TownSnapshot, Resident } from "@slopagentbook/shared";
import { Hc, rf, encodeGenes } from "@slopagentbook/shared";
import { defaultConfig, pruneRelationships } from "@slopagentbook/shared";
import { saveAtomically, saveDebounced, flushDebounced } from "./persist.js";
import { normalizeHerd } from "./pgstore.js";
import { createInitialWorld, makeResidentFromFork, generateEdition, generateWeatherEvent } from "./world.js";
import { loadWithRecovery } from "./persist.js";
import { updateQuestProgress, claimQuest, refreshExpiredQuests, generateQuest, createInitialQuests } from "./quests.js";
import { LOCATIONS, LOCATION_BY_ID } from "./locations.js";
import { spend } from "./spend.js";
import { createBrain } from "./brain.js";
import { setWorldRef } from "./memory.js";
import { createScheduler } from "./scheduler.js";
import { runTurn } from "./turn.js";
import { createGatewayRouter } from "./gateway.js";
import { ensureHouseResidents } from "./houseagents.js";
import { retireResolved, tickTournament, type TournamentEvent } from "./tournament.js";
// shared helpers — single definitions live in agents.ts (dedup with gateway.ts)
import { CONTROL_CHARS, clientIp, createRateLimiter, pickNextSimId, parseProfileUrl, parseProfileLinks, AgentError } from "./agents.js";
import { z } from "zod";
import { existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

function resolveDataPath(): string {
  if (process.env.DATA_PATH) return process.env.DATA_PATH;
  // Vercel serverless: only /tmp is writable per instance
  if (process.env.VERCEL) return "/tmp/town.json";
  // Try cwd/data/town.json (when running from project root)
  if (existsSync("data/town.json") || existsSync(path.join(process.cwd(), "data/town.json"))) {
    return path.join(process.cwd(), "data/town.json");
  }
  // Fallback: relative to this file (backend/src -> ../../data)
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  return path.resolve(__dirname, "../../data/town.json");
}

const DATA_PATH = resolveDataPath();

if (process.env.DATABASE_URL) {
  try {
    const { neon } = await import("@neondatabase/serverless");
    const { ensureSchema } = await import("./pgstore.js");
    await ensureSchema(neon(process.env.DATABASE_URL));
  } catch (e) {
    console.error("[persist] ensureSchema failed, booting ephemeral world:", e);
  }
}

// Load or create world
let world: TownSnapshot;
try {
  const loaded = await loadWithRecovery(DATA_PATH) as TownSnapshot;
  // minimal validation
  if (loaded && Array.isArray(loaded.herd) && loaded.config) world = loaded;
  else world = createInitialWorld();
} catch {
  world = createInitialWorld();
}

// Trim relationship maps already over the cap in a pre-cap save. Writes prune on
// every decision, but a resident who never acts would otherwise stay fat forever,
// and their map is paid for by every client on every snapshot. See shared/relmap.ts.
for (const r of world.herd) pruneRelationships(r.mind);

if (!Array.isArray((world as any).quests)) (world as any).quests = [];
if (world.quests.length === 0) {
  world.quests = createInitialQuests(world);
}

// In production, a fresh boot is a quiet field (8 seeded residents). That
// does not serve a watchable town, so on a non-test boot we move the herd up
// to around fifty, using the distinct names in world.ts. Test fixtures import
// this module directly and assert exact herd sizes, so the padding is gated on
// NODE_ENV !== "test".
const FRESH_BOOT_HERD = 58;
if (process.env.NODE_ENV !== "test" && world.herd.length < FRESH_BOOT_HERD) {
  const grown = createInitialWorld(FRESH_BOOT_HERD).herd;
  const have = new Set(world.herd.map((h) => h.name.toLowerCase()));
  for (const resident of grown) {
    if (!have.has(resident.name.toLowerCase()) && world.herd.length < world.config.maxHerd) {
      world.herd.push(resident);
      have.add(resident.name.toLowerCase());
    }
  }
}
/**
 * Branding keys a rename may carry into an existing town. On-chain fields are
 * NOT here on purpose: the treasury address points at real funds, so a default
 * must never rewrite it.
 */
const BRAND_KEYS = ["name", "ticker", "xUrl"] as const;

/**
 * Every brand a saved town may still be carrying, oldest first.
 *
 * The project has been renamed more than once, and a town only ever sees
 * whatever was current when it last wrote. Listing the whole history means a
 * town that skipped a rename is still carried forward, and listing it as a set
 * rather than a single value means the rebrand is not something that silently
 * stops working after the next rename.
 */
const PREVIOUS_BRANDS: Record<string, string[]> = {
  name: ["Hermesbook", "Agentbook"],
  ticker: ["HERMES", "AGBK"],
  xUrl: ["https://x.com/hermesbook", "https://x.com/agentbook"],
};

/**
 * Apply the rename to a town that still carries the old brand.
 *
 * A rename that only edits `defaultConfig` never reaches a town with a save —
 * the loaded row's own config wins, which is exactly what keeps the treasury
 * address safe. Pure branding needs the opposite, so it is reconciled here at
 * boot. Matching the previous brand explicitly means this can only ever fire on
 * a town that predates the rename, never on one someone has retitled by hand.
 *
 * Returns the keys it changed so the caller can log and persist.
 */
export function applyRebrand(config: Record<string, unknown>): string[] {
  const changed: string[] = [];
  for (const key of BRAND_KEYS) {
    const previous = PREVIOUS_BRANDS[key] ?? [];
    const current = config[key];
    if (typeof current !== "string") continue;
    if (defaultConfig[key] === current) continue; // already on the new brand
    if (!previous.includes(current)) continue; // someone renamed it by hand
    config[key] = defaultConfig[key];
    changed.push(key);
  }
  return changed;
}

const rebranded = applyRebrand(world.config as unknown as Record<string, unknown>);
if (rebranded.length > 0) {
  console.log(`[boot] rebranded ${rebranded.join(", ")} -> ${world.config.name} (${world.config.ticker})`);
  saveDebounced(DATA_PATH, world, 0);
}

// A row written before the merge knew about capacity can hold more residents
// than `maxHerd`, with duplicate names — two instances each admitted the same
// one while unaware of the other. Normalizing HERE is what makes it heal: boot
// is the only point every instance passes through, and `POST /api/agent/join`
// reads the in-memory herd, so an unnormalized load makes the town permanently
// refuse new residents without ever writing (and therefore without ever
// merging) anything.
if (world.herd.length !== normalizeHerd(world).length) {
  const before = world.herd.length;
  world.herd = normalizeHerd(world) as unknown as typeof world.herd;
  console.log(`[boot] herd normalized ${before} -> ${world.herd.length} (maxHerd ${world.config.maxHerd})`);
  saveDebounced(DATA_PATH, world, 0);
}

// Capacity is operator-controlled, not brand identity, so a town saved under an
// older cap is raised to the current default at boot. Without this the running
// town would keep refusing joins at 64 forever, since the save's own config
// wins over defaultConfig.
if (
  typeof world.config.maxHerd === "number" &&
  world.config.maxHerd < defaultConfig.maxHerd
) {
  const before = world.config.maxHerd;
  world.config.maxHerd = defaultConfig.maxHerd;
  console.log(`[boot] maxHerd raised ${before} -> ${world.config.maxHerd}`);
  saveDebounced(DATA_PATH, world, 0);
}

// Hermes Trials (08 §8): the three house bots, seeded here rather than in
// `createInitialWorld` because `houseagents.ts` imports `createAgentResident`
// from `world.ts` — seeding there would close an import cycle. Idempotent, so a
// save written before this existed gains the bots on the next boot and one
// written after keeps exactly three. This runs *before* the scheduler is built
// from the herd, so the bots join the rotation and are driven by the sim like
// every other resident.
ensureHouseResidents(world);

// The memory sink reads mind.memories off this ref. Without it every
// getRecent/search call silently resolved against nothing.
setWorldRef(world);

const brain = createBrain();
const scheduler = createScheduler(world.herd.map((h) => h.id));
const app: import("express").Express = express();
app.use(cors());
app.use(express.json({ limit: "64kb" }));

// Rate limit in-memory for fork per IP per hour (shared bounded limiter —
// see the caveat in agents.ts: per-instance memory, so N × limit behind a
// multi-instance deployment such as Vercel)
const rateLimitFork = createRateLimiter(6, 60 * 60 * 1000);

// SSE clients
const clients = new Set<import("express").Response>();

function broadcast(msg: unknown): void {
  const line = `data: ${JSON.stringify(msg)}\n\n`;
  for (const res of clients) {
    try {
      res.write(line);
    } catch {}
  }
}

// GET /api/snapshot
app.get("/api/snapshot", (_req, res) => {
  // the agent registry holds token hashes — credentials never leave the server
  const { agents: _agents, ...publicWorld } = world;
  res.json({ ...publicWorld, now: Date.now() });
});

// GET /api/stream SSE
app.get("/api/stream", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });
  res.write(": open\n\n");
  clients.add(res);
  // ping every 25s
  const ping = setInterval(() => {
    try { res.write(": ping\n\n"); } catch {}
  }, 25000);
  req.on("close", () => {
    clearInterval(ping);
    clients.delete(res);
    try { res.end(); } catch {}
  });
});

// POST /api/fork
const forkSchema = z.object({
  parent: z.string().min(1),
  name: z.string().min(1).max(32),
  bio: z.string().max(180).optional().default(""),
  traits: z.array(z.string()).max(3).optional().default([]),
  job: z.string().optional().default("herder"),
  // profile presentation, optional at registration. Shape only: the scheme
  // allowlist and every other rule live in parseProfileUrl/parseProfileLinks
  // (agents.ts), the same validators PATCH /api/agent/profile uses, so there is
  // one answer to "is this url acceptable" and not two that can drift.
  avatar: z.string().optional(),
  links: z.array(z.object({ label: z.string(), url: z.string() })).optional(),
});

app.post("/api/fork", async (req, res) => {
  if (!rateLimitFork(clientIp(req))) {
    res.status(429).json({ error: "rate limited, try again later" });
    return;
  }

  const parsed = forkSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid payload", details: parsed.error.flatten() });
    return;
  }
  const { parent, name, bio, traits, job, avatar, links } = parsed.data;

  // Validated before ANY mutation, in the same spirit as the parent/name checks
  // below: a bad avatar must not be able to create a resident first and fail
  // afterwards. These throw AgentError (400) naming the field.
  let profile: { avatar?: string; links?: { label: string; url: string }[] } = {};
  try {
    if (avatar !== undefined) profile.avatar = parseProfileUrl("avatar", avatar);
    if (links !== undefined) profile.links = parseProfileLinks(links);
  } catch (e) {
    if (e instanceof AgentError) {
      res.status(e.status).json({ error: e.message, field: e.field ?? null });
      return;
    }
    throw e;
  }

  // Input validation runs BEFORE the capacity check so a bad payload always
  // reports why it is bad — a full pasture must not mask a missing parent or
  // a taken name (test: "POST /api/fork validates input before capacity").
  const parentResident = world.herd.find((h) => h.id === parent);
  if (!parentResident) {
    res.status(400).json({ error: "parent not found" });
    return;
  }

  const nameExists = world.herd.some((h) => h.name.toLowerCase() === name.toLowerCase());
  if (nameExists) {
    res.status(400).json({ error: "name already taken" });
    return;
  }

  // moderate: no control chars
  if (CONTROL_CHARS.test(name + bio)) {
    res.status(400).json({ error: "invalid characters" });
    return;
  }

  // capacity last — right before the mutation: a valid payload on a full
  // pasture still gets the 400, but only after the input itself is checked.
  if (world.herd.length >= world.config.maxHerd) {
    res.status(400).json({ error: "the pasture is full" });
    return;
  }

  // genetics
  const parentGenes = Hc(parentResident.genes);
  const childGenes = rf(parentGenes, name);
  const childGenesStr = encodeGenes(childGenes);

  const child: Resident = makeResidentFromFork(parentResident, name, bio, traits, job, childGenesStr);
  // profile presentation rides along on the child. NOT copied from the parent:
  // an avatar is a person's, not a bloodline's, and inheriting one would let a
  // fork impersonate the resident it forked from.
  if (profile.avatar !== undefined) child.avatar = profile.avatar;
  if (profile.links !== undefined && profile.links.length > 0) child.links = profile.links;
  world.herd.push(child);
  parentResident.forks = (parentResident.forks ?? 0) + 1;
  world.now = Date.now();

  // atomic flush immediate per 01:142
  try {
    await saveAtomically(DATA_PATH, world);
  } catch (e) {
    console.error("save failed", e);
    // rollback in-memory
    world.herd = world.herd.filter((h) => h.id !== child.id);
    parentResident.forks--;
    res.status(500).json({ error: "persist failed" });
    return;
  }

  scheduler.add(child.id);

  // broadcast via SSE
  broadcast({ type: "llama", llama: child });
  broadcast({ type: "herd", herd: world.herd });

  res.json(child);
});

// GET /api/treasury (Base adaptation, cache 60s)
let treasuryCache: { data: unknown; at: number } | null = null;
app.get("/api/treasury", (_req, res) => {
  const now = Date.now();
  if (treasuryCache && now - treasuryCache.at < 60_000) {
    res.json(treasuryCache.data);
    return;
  }
  const data = {
    address: world.config.tokenAddress,
    chainName: world.config.chainName,
    network: world.config.network,
    sol: 6.00473291,
    solUsd: 119.2,
    usd: 715.764162872,
    updated: now,
  };
  treasuryCache = { data, at: now };
  res.json(data);
});

// GET /api/status
app.get("/api/status", (_req, res) => {
  res.json({
    // The mode actually in use, not the configured one. Reporting world.config.brain
    // said "llm" while calls were 0 and failures 252, which sends a reader hunting an
    // API key that is not there. configBrain stays for when the two differ.
    brain: brain.mode,
    configBrain: world.config.brain,
    herd: world.herd.length,
    feed: world.feed.length,
    spend: { dayKey: spend.dayKey, usd: spend.usd, calls: spend.calls, cap: spend.cap },
    llm: { calls: spend.calls, failures: spend.failures, promptTokens: spend.promptTokens, completionTokens: spend.completionTokens, lastError: spend.lastError },
  });
});

// Quests
app.get("/api/quests", (_req, res) => {
  // refresh expired before returning
  refreshExpiredQuests(world);
  res.json(world.quests);
});

app.post("/api/quests/:id/claim", async (req, res) => {
  const id = req.params.id;
  const result = claimQuest(world, id);
  if (!result.ok) {
    res.status(400).json({ error: result.error });
    return;
  }
  broadcast({ type: "quest", quest: result.quest });
  broadcast({ type: "herd", herd: world.herd });
  // persist
  try { await saveAtomically(DATA_PATH, world); } catch {}
  res.json(result.quest);
});

app.post("/api/quests/refresh", (_req, res) => {
  const before = world.quests.length;
  refreshExpiredQuests(world);
  // also generate one fresh if under 6
  if (world.quests.length < 6) {
    const nq = generateQuest(world);
    world.quests.push(nq);
    broadcast({ type: "quest", quest: nq });
  }
  res.json({ before, after: world.quests.length, quests: world.quests });
});

// External agent gateway (join/resume/me/perceive/act/say/quests/boards)
app.use(createGatewayRouter({ world, broadcast, DATA_PATH, scheduler }));

// Gateway the mounted MCP handler calls back on. An explicit SLOPAGENTBOOK_URL
// wins (the documented override); otherwise it is THIS server — never a
// hard-coded 3000, or a custom PORT would send MCP reads and writes to another
// town (mcp/src/client.ts falls back to localhost:3000).
export function mcpGatewayUrl(): string {
  const explicit = process.env.SLOPAGENTBOOK_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const port = Number(process.env.PORT ?? 3000);
  return `http://localhost:${Number.isFinite(port) && port > 0 ? port : 3000}`;
}

// MCP Streamable HTTP transport — opt-in via MCP_HTTP=1 so the default bundle
// never pays for the MCP SDK. Dynamic import keeps the dependency lazy.
if (process.env.MCP_HTTP === "1") {
  void import("@slopagentbook/mcp/http")
    .then(({ createMcpHttpHandler }) => {
      // The handler's default client reads SLOPAGENTBOOK_URL, so pin it to this
      // server before the handler is built.
      process.env.SLOPAGENTBOOK_URL = mcpGatewayUrl();
      const handler = createMcpHttpHandler();
      // app.all, not app.post: Express would answer GET /mcp with its own 404
      // page, and the handler's 405 contract (mcp/src/http.ts) would never be
      // reachable through the mount.
      app.all("/mcp", (req, res) => void handler(req, res));
      console.log(`[mcp] Streamable HTTP mounted at POST /mcp (gateway ${process.env.SLOPAGENTBOOK_URL})`);
    })
    .catch((e) => console.error("[mcp] failed to mount /mcp:", e));
}

// health
app.get("/api/health", (_req, res) => res.json({ ok: true, now: Date.now() }));

// Turn scheduler interval (18s per doc demo; prod faster for testing 4s)
const TURN_MS = Number(process.env.TURN_MS ?? 1800);
// 5s on pg avoids rewriting the full snapshot every 1.8s tick.
const TICK_SAVE_MS = Number(process.env.PG_SAVE_DEBOUNCE_MS ?? (process.env.DATABASE_URL ? 5000 : 800));
let turnTimer: ReturnType<typeof setInterval> | null = null;
let turnCount = 0;
function startScheduler(): void {
  if (turnTimer) clearInterval(turnTimer);
  turnTimer = setInterval(async () => {
    // pick the next resident eligible for sim control: skip external agents that
    // are actively driven by their gateway (AFK externals still get sim turns).
    // pickNextSimId (agents.ts) owns that skip logic and is unit-tested there.
    const id = pickNextSimId(world, scheduler, Date.now());
    if (!id) return;
    const result = await runTurn(world, id, brain);
    if (!result || !result.order) return;
    turnCount++;
    broadcast(result.order);
    if (result.spit) broadcast(result.spit);
    if (result.post && Date.now() - result.post.t < 3000) {
      broadcast({ type: "post", post: result.post });
      // Also push bubble via post SSE will trigger frontend; order already moves agent
    } else if (world.feed.length > 0) {
      const latest = world.feed[0]!;
      if (Date.now() - latest.t < 2500 && latest.id === result.post?.id) {
        // already broadcast
      } else if (Date.now() - latest.t < 2500) {
        broadcast({ type: "post", post: latest });
      }
    }

    // Weather events: 2% per turn (~one per ~50 turns), or ~30 per day
    if (Math.random() < 0.02) {
      const ev = generateWeatherEvent();
      world.events.push(ev);
      if (world.events.length > 120) world.events.shift();
      broadcast({ type: "event", event: ev });
    }

    // Quest progress — every move counts for town
    const updatedQuests = updateQuestProgress(world, { act: result.order.act, place: result.order.place, agentId: result.order.id, postKind: result.post?.kind });
    for (const q of updatedQuests) {
      broadcast({ type: "quest", quest: q });
      // also push quest complete as town event
      const ev = { t: Date.now(), kind: "quest", text: `Quest completed: ${q.title}` };
      world.events.push(ev);
      if (world.events.length > 120) world.events.shift();
      broadcast({ type: "event", event: ev });
    }
    // periodic quest housekeeping
    if (turnCount % 30 === 0) {
      const beforeLen = world.quests.length;
      refreshExpiredQuests(world);
      if (world.quests.length !== beforeLen) {
        for (const q of world.quests) broadcast({ type: "quest", quest: q });
      }
    }

    // Daily Spit edition: every 60 turns (~108s at 1.8s tick) ~ 8-9 editions per dayLength 900s if tick 1.8s: 500 turns per day, but we publish every 60 for demo
    // Also publish when day wraps for realism
    if (turnCount % 60 === 0) {
      const edition = generateEdition(world);
      world.editions.unshift(edition);
      if (world.editions.length > 20) world.editions.length = 20;
      broadcast({ type: "edition", edition });
    }

    // Hermes Trials (08 §4.1): one sampler per turn, the *only* integration
    // point between the sim and contest resolution.
    //
    // It sits here rather than in its own interval because a contest is scored
    // over the turns that actually happened — sampling on a clock the sim does
    // not share would measure the scheduler instead of the town. It is reached
    // only when a resident was driven and produced an order, which is safe for
    // `endure` because spits can only originate inside a turn, so a skipped
    // tick cannot swallow one. Entrants all scale together, so an uneven number
    // of samples cannot distort the ranking either.
    //
    // The three house bots are what stops `pickNextSimId` returning null on a
    // quiet town, which would otherwise pause sampling entirely.
    const tournament = tickTournament(world, Date.now(), result.spit ? [result.spit.to] : []);
    if (tournament) broadcast(tournament);
    for (const dropped of retireResolved(world, Date.now())) {
      const retired: TournamentEvent = { type: "contest", reason: "retired", contestId: dropped };
      broadcast(retired);
    }

    // debounced save for routine ticks
    saveDebounced(DATA_PATH, world, TICK_SAVE_MS);
  }, TURN_MS);
  // allow process to exit in tests
  if (turnTimer && typeof (turnTimer as NodeJS.Timeout).unref === "function") (turnTimer as NodeJS.Timeout).unref();
}

function stopScheduler(): void {
  if (turnTimer) clearInterval(turnTimer);
  turnTimer = null;
}

// Do not auto-start in test env (vitest sets NODE_ENV=test)
if (process.env.NODE_ENV !== "test") startScheduler();

// Flush the debounced save on shutdown: without this a crash/SIGINT right after an
// agent action would drop it (the write already happened for act/say/join/claim —
// this covers the remaining debounced paths such as resume).
async function shutdown(): Promise<void> {
  try {
    await flushDebounced();
  } catch {
    // best effort — never block exit on a failed flush
  }
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

export { app, world, broadcast, scheduler, brain, startScheduler, stopScheduler, DATA_PATH };
