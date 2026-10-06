// @ts-nocheck — Vercel func bundling uses built-in TS 5.9 with @types/express mismatch; local tsc is source of truth
import express from "express";
import cors from "cors";
import type { TownSnapshot, Resident } from "@hermesbook/shared";
import { Hc, rf, encodeGenes } from "@hermesbook/shared";
import { saveAtomically, saveDebounced, flushDebounced } from "./persist.js";
import { createInitialWorld, makeResidentFromFork, generateEdition, generateWeatherEvent } from "./world.js";
import { loadWithRecovery } from "./persist.js";
import { updateQuestProgress, claimQuest, refreshExpiredQuests, generateQuest, createInitialQuests } from "./quests.js";
import { LOCATIONS, LOCATION_BY_ID } from "./locations.js";
import { spend } from "./spend.js";
import { createBrain } from "./brain.js";
import { createScheduler } from "./scheduler.js";
import { runTurn } from "./turn.js";
import { createGatewayRouter } from "./gateway.js";
import { ensureHouseResidents } from "./houseagents.js";
import { retireResolved, tickTournament, type TournamentEvent } from "./tournament.js";
// shared helpers — single definitions live in agents.ts (dedup with gateway.ts)
import { CONTROL_CHARS, clientIp, createRateLimiter, pickNextSimId } from "./agents.js";
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

if (!Array.isArray((world as any).quests)) (world as any).quests = [];
if (world.quests.length === 0) {
  world.quests = createInitialQuests(world);
}

// Hermes Trials (08 §8): the three house bots, seeded here rather than in
// `createInitialWorld` because `houseagents.ts` imports `createAgentResident`
// from `world.ts` — seeding there would close an import cycle. Idempotent, so a
// save written before this existed gains the bots on the next boot and one
// written after keeps exactly three. This runs *before* the scheduler is built
// from the herd, so the bots join the rotation and are driven by the sim like
// every other resident.
ensureHouseResidents(world);

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
  const { parent, name, bio, traits, job } = parsed.data;

  if (world.herd.length >= world.config.maxHerd) {
    res.status(400).json({ error: "the pasture is full" });
    return;
  }

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

  // genetics
  const parentGenes = Hc(parentResident.genes);
  const childGenes = rf(parentGenes, name);
  const childGenesStr = encodeGenes(childGenes);

  const child: Resident = makeResidentFromFork(parentResident, name, bio, traits, job, childGenesStr);
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
    brain: world.config.brain,
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

// MCP Streamable HTTP transport — opt-in via MCP_HTTP=1 so the default bundle
// never pays for the MCP SDK. Dynamic import keeps the dependency lazy.
if (process.env.MCP_HTTP === "1") {
  void import("@hermesbook/mcp/http")
    .then(({ createMcpHttpHandler }) => {
      const handler = createMcpHttpHandler();
      app.post("/mcp", (req, res) => void handler(req, res));
      console.log("[mcp] Streamable HTTP mounted at POST /mcp");
    })
    .catch((e) => console.error("[mcp] failed to mount /mcp:", e));
}

// health
app.get("/api/health", (_req, res) => res.json({ ok: true, now: Date.now() }));

// Turn scheduler interval (18s per doc demo; prod faster for testing 4s)
const TURN_MS = Number(process.env.TURN_MS ?? 1800);
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
    saveDebounced(DATA_PATH, world);
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
