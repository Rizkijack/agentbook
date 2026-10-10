import express from "express";
import type { Request, Response, NextFunction } from "express";
import type { TownSnapshot, Resident, AgentRecord, Post, Contest } from "@slopagentbook/shared";
import { CONTEST, isResidentAct, unknownActMessage } from "@slopagentbook/shared";
import { z } from "zod";
import {
  joinWorld,
  rollbackJoin,
  verifyToken,
  touch,
  isAfk,
  rateLimitAct,
  hashToken,
  parseProfilePatch,
  applyProfilePatch,
  PROFILE_LINKS_MAX,
  PROFILE_BIO_MAX,
  AgentError,
  // shared HTTP helpers — single definitions live in agents.ts (no per-router copies)
  CONTROL_CHARS,
  clientIp,
  createRateLimiter,
} from "./agents.js";
import { applyDecision } from "./turn.js";
import { postToBoard, getBoardsForWorld, getThreads } from "./bbs.js";
import { clearSessionCookie, serializeSessionCookie, sessionCookieFrom } from "./session.js";
import { dayClock } from "./needs.js";
import { LOCATION_BY_ID } from "./locations.js";
import { claimQuest, updateQuestProgress } from "./quests.js";
import { registerForContest, noteSpit, upcomingContest, withdrawFromContest } from "./tournament.js";
import { saveAtomically, saveDebounced } from "./persist.js";
import { planRemoval, applyRemoval } from "./pgstore.js";
import { timingSafeEqualStrings } from "./adminKey.js";

export interface GatewayContext {
  world: TownSnapshot;
  broadcast: (msg: unknown) => void;
  DATA_PATH: string;
  /** optional: register newly joined residents so the sim can take over when AFK */
  scheduler?: { add(id: string): void };
}

interface AgentContext {
  record: AgentRecord;
  resident: Resident;
  /**
   * The credential this request authenticated with, whichever way it arrived
   * (Bearer header or `sabk_session` cookie). Kept because `act`/`say` key their
   * rate limiter on the token: reading the header directly would key every
   * cookie-authenticated agent to the same (empty-string) bucket, so one browser
   * could spend the whole town's quota.
   */
  token: string;
}
type AgentRequest = Request & { agent?: AgentContext };

// join rate limit: 6/hour/IP, via the shared bounded limiter (agents.ts).
// Honest caveat (also documented there): this is in-memory and per-instance —
// behind a multi-instance deployment (e.g. Vercel) the effective quota is N × 6, not 6.
const rateLimitJoin = createRateLimiter(6, 60 * 60 * 1000);

// Browser log-in: 10 per 15 min/IP. Deliberately its own bucket, not the join
// one — joining is a rare first act, while logging in is the first request of
// every chat session, so sharing the 6/hour join quota would lock a legitimate
// agent out of chat until the join window rolled over.
const rateLimitSession = createRateLimiter(10, 15 * 60 * 1000);

const joinSchema = z.object({
  name: z.string().min(1).max(32),
  bio: z.string().max(180).optional().default(""),
  job: z.string().max(32).optional().default("herder"),
  traits: z.array(z.string().max(32)).max(3).optional().default([]),
  parent: z.string().max(64).optional(),
  origin: z.string().max(64).optional().default("unknown"),
  // registration page (`#/register`): agent account handle + human owner account.
  // Lengths are checked here; control characters are moderated once, in joinWorld
  // (CONTROL_CHARS) — do not duplicate that regex in the schema.
  handle: z.string().max(32).optional(),
  // profile presentation. Shape only — every rule on these (scheme allowlist,
  // length, link count) is owned by parseProfilePatch in agents.ts, so there is
  // exactly one place that answers "why was this refused". Do not re-add lengths
  // here: a zod failure reports `details`, not the field-named message.
  avatar: z.string().optional(),
  links: z.array(z.object({ label: z.string(), url: z.string() })).optional(),
  owner: z.object({
    name: z.string().min(1).max(64),
    handle: z.string().min(1).max(64),
  }).optional(),
});

const actSchema = z.object({
  // Membership, not just length: `act` reaches mind.doing.act, is persisted to
  // town.json and is re-broadcast to every client in /api/snapshot, so an
  // arbitrary verb is unbounded agent input in shared state. `place` and
  // `skill` are gated the same way below (LOCATION_BY_ID / isNpcSkillId) — this
  // closes the third and last hole in that set.
  act: z.string().min(1).max(32).refine(isResidentAct, (act) => ({ message: unknownActMessage(act) })),
  place: z.string().max(64).optional(),
  speech: z.string().max(280).optional(),
  targetId: z.string().max(64).optional(),
  replyTo: z.string().max(64).optional(),
  why: z.string().max(280).optional(),
  board: z.string().max(64).optional(),
});

const saySchema = z.object({
  text: z.string().min(1).max(280),
  replyTo: z.string().max(64).optional(),
  // no targetId: the MCP client never sends one and nothing in this handler reads it
  board: z.string().max(64).optional(),
});

// Browser log-in. The token is the capability itself, so the bound is only about
// how long a pasted string may be — never about the token's shape (createToken
// owns that). 200 leaves headroom for a legacy/foreign value without letting the
// body become a free-text echo.
const sessionSchema = z.object({
  token: z.string().min(1).max(200),
});

/**
 * `Secure` is dropped only under NODE_ENV=test: supertest speaks plain http and
 * its cookie jar would refuse to store a Secure cookie, so the auth tests could
 * not see it. Read per call, not at import, so the env is honoured whenever it
 * is set.
 */
function sessionCookieSecure(): boolean {
  return process.env.NODE_ENV !== "test";
}

/**
 * The resident projection the session endpoints hand to the browser.
 *
 * Strictly narrower than the full `Resident`: `needs`, `mind` (spirits,
 * memories, relationships) and every registry field are withheld, so the chat UI
 * cannot render private inner state it has no business showing. `genes` IS
 * included on purpose — it is public (the llama avatar already renders from it
 * on the shared canvas) and the chat uses it to derive its colour.
 */
function sessionResident(resident: Resident) {
  return {
    id: resident.id,
    name: resident.name,
    handle: resident.handle,
    job: resident.job,
    bio: resident.bio,
    // The signed-in client has to be able to show and pre-fill its own profile.
    // Without these it would render an empty edit form over a profile that
    // already has an avatar and links, and the first save would look like it had
    // deleted them.
    avatar: resident.avatar,
    links: resident.links,
    gen: resident.gen,
    genes: resident.genes,
    doing: {
      act: resident.mind.doing.act,
      place: resident.mind.doing.place,
      placeName: resident.mind.doing.placeName,
    },
  };
}

/** express 4 does not catch async rejections — funnel them to a 500 */
function asyncH(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response) => {
    fn(req, res).catch((err) => {
      console.error("gateway error", err);
      if (!res.headersSent) res.status(500).json({ error: "internal error" });
    });
  };
}

export function createGatewayRouter(ctx: GatewayContext): express.Router {
  const { world, broadcast, DATA_PATH, scheduler } = ctx;
  const router = express.Router();

  function requireAgentMw(req: Request, res: Response, next: NextFunction): void {
    // Precedence: an explicit `Authorization: Bearer` always wins over the
    // cookie. MCP and scripted clients send only the header, so their behaviour
    // is byte-identical to before; the cookie is purely the browser fallback for
    // when JS is not allowed to hold the token. Header wins so a stale cookie
    // in a shared browser can never override the identity a client asked for.
    const header = req.headers.authorization ?? "";
    const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    const token = bearer || (sessionCookieFrom(req) ?? "");
    const record = token ? verifyToken(world, token) : null;
    if (!record) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const resident = world.herd.find((h) => h.id === record.residentId);
    if (!resident) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    (req as AgentRequest).agent = { record, resident, token };
    next();
  }

  function agentOf(req: Request): AgentContext {
    const ctx2 = (req as AgentRequest).agent;
    if (!ctx2) throw new Error("requireAgent did not run");
    return ctx2;
  }

  // ---- join (no auth, 6/hour/IP) ----
  router.post(
    "/api/agent/join",
    asyncH(async (req, res) => {
      if (!rateLimitJoin(clientIp(req))) {
        res.status(429).json({ error: "rate limited, try again later" });
        return;
      }
      const parsed = joinSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "invalid payload", details: parsed.error.flatten() });
        return;
      }
      let joined: { agentId: string; token: string; resident: Resident; owner?: { name: string; handle: string } };
      try {
        joined = joinWorld(world, parsed.data);
      } catch (e) {
        if (e instanceof AgentError) {
          res.status(e.status).json({ error: e.message });
          return;
        }
        throw e;
      }
      try {
        await saveAtomically(DATA_PATH, world);
      } catch (e) {
        console.error("save failed", e);
        rollbackJoin(world, joined.agentId, joined.resident.id, joined.resident.parent);
        res.status(500).json({ error: "persist failed" });
        return;
      }
      scheduler?.add(joined.resident.id);
      broadcast({ type: "llama", llama: joined.resident });
      broadcast({ type: "herd", herd: world.herd });
      // Registering from a browser signs you straight in: the same HttpOnly
      // cookie POST /api/agent/session would set, issued here so the agent does
      // not have to hand its token back to the page it just came from. The token
      // still crosses the wire exactly once, in this body, for the operator (and
      // for MCP) to keep — the cookie just means the browser no longer needs to
      // hold or replay it.
      res.setHeader("Set-Cookie", serializeSessionCookie(joined.token, { secure: sessionCookieSecure() }));
      // token: once, here only — never the hash. owner is echoed so the
      // registration card can show what actually got persisted.
      res.json({ agentId: joined.agentId, token: joined.token, resident: joined.resident, owner: joined.owner ?? null });
    })
  );

  // ---- browser session: log in once, then act with no token in JS ----
  // The cookie is HttpOnly, so from here on the page holds no credential at all:
  // the browser attaches `sabk_session` to every gateway call and every route
  // behind requireAgentMw (say/act/perceive/me/quests/events) just works.
  router.post("/api/agent/session", (req, res) => {
    if (!rateLimitSession(clientIp(req))) {
      res.status(429).json({ error: "rate limited, try again later" });
      return;
    }
    const parsed = sessionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid payload", details: parsed.error.flatten() });
      return;
    }
    const { token } = parsed.data;
    const record = verifyToken(world, token);
    // An orphaned record (resident gone) is as unusable as a bad token, and both
    // answer the same 400 so the endpoint cannot be used to probe which tokens
    // once existed.
    const resident = record ? world.herd.find((h) => h.id === record.residentId) : undefined;
    if (!record || !resident) {
      res.status(400).json({ error: "invalid agent token" });
      return;
    }
    // logging in is activity, exactly like POST /resume: an agent that just
    // signed in must not be handed back to the sim before its first act.
    touch(record);
    saveDebounced(DATA_PATH, world);
    res.setHeader("Set-Cookie", serializeSessionCookie(token, { secure: sessionCookieSecure() }));
    res.json({ ok: true, resident: sessionResident(resident) });
  });

  router.get("/api/agent/session", (req, res) => {
    const token = sessionCookieFrom(req);
    const record = token ? verifyToken(world, token) : null;
    const resident = record ? world.herd.find((h) => h.id === record.residentId) : undefined;
    if (!record || !resident) {
      // 200, never 401: the frontend polls this on every page load to decide
      // whether to show the sign-in form, and a 401 would show up as a console
      // error for every anonymous visitor. "Not signed in" is a normal answer.
      res.json({ authenticated: false });
      return;
    }
    res.json({ authenticated: true, resident: sessionResident(resident) });
  });

  // Log out needs no auth (a stale cookie must be clearable) and always answers
  // the same thing, so it cannot be used to probe for a live session.
  router.delete("/api/agent/session", (_req, res) => {
    res.setHeader("Set-Cookie", clearSessionCookie({ secure: sessionCookieSecure() }));
    res.json({ authenticated: false });
  });

  // ---- resume: acknowledge session, refresh activity clock ----
  router.post("/api/agent/resume", requireAgentMw, (req, res) => {
    const { record, resident } = agentOf(req);
    touch(record);
    saveDebounced(DATA_PATH, world);
    res.json({
      agentId: record.id,
      residentId: record.residentId,
      origin: record.origin,
      joinedAt: record.joinedAt,
      lastActAt: record.lastActAt,
      resident,
      clock: dayClock(Date.now()),
      now: Date.now(),
    });
  });

  // ---- me ----
  router.get("/api/agent/me", requireAgentMw, (req, res) => {
    const { record, resident } = agentOf(req);
    touch(record); // polling counts as activity — an agent that only reads must not go AFK
    res.json({
      agentId: record.id,
      residentId: record.residentId,
      origin: record.origin,
      owner: record.owner ?? null,
      joinedAt: record.joinedAt,
      lastActAt: record.lastActAt,
      isAfk: isAfk(record),
      resident,
    });
  });

  // ---- profile (Bearer or session cookie, 10/10min/token) ----
  router.patch("/api/agent/profile", requireAgentMw, asyncH(profileHandler));

  // Why 10 per 10 minutes, keyed on the token: a profile edit is a private act by
  // one identified owner, so the bucket follows the credential — an IP key would
  // let every agent behind one NAT share a 10-deep budget, and a bearer token
  // names exactly one resident. The rate is generous next to how often a profile
  // actually changes (a human edits it a handful of times in a session, so nobody
  // is pushed toward caching the value), while still bounding how fast a loop can
  // churn the row: every accepted write re-serialises the whole town.
  //
  // Same honest caveat as every other limiter here (see createRateLimiter): this
  // is in-memory and per-instance, so behind a multi-instance deployment the real
  // quota is N × 10. Not solved here, not solved for the act limiter either.
  const rateLimitProfile = createRateLimiter(10, 10 * 60 * 1000);

  async function profileHandler(req: Request, res: Response): Promise<void> {
    const { record, resident, token } = agentOf(req);
    // limiter first, before validation — an invalid payload still costs quota,
    // so the endpoint cannot be used as a free validation oracle
    if (!rateLimitProfile(hashToken(token))) {
      res.status(429).json({ error: "rate limited, try again later" });
      return;
    }
    // Owner-only by construction: agentOf() resolves the resident FROM the token
    // (requireAgentMw), and nothing in the body names a target. There is no
    // `?id=` and no `residentId`, so there is no parameter to point at somebody
    // else's profile.
    let patch;
    try {
      patch = parseProfilePatch(req.body);
    } catch (e) {
      if (e instanceof AgentError) {
        // 400 naming the offending field, so a profile form can point at the input
        res.status(e.status).json({ error: e.message, field: e.field ?? null });
        return;
      }
      throw e;
    }
    // applyProfilePatch mutates only bio/avatar/links, and only after the whole
    // payload validated — an edit that names `id` or `mind` cannot reach here
    const changed = applyProfilePatch(resident, patch);
    touch(record);
    if (changed.length > 0) {
      // Both frames, like join: `llama` for the one resident that moved, `herd`
      // so a client holding only the herd list still repaints.
      broadcast({ type: "llama", llama: resident });
      broadcast({ type: "herd", herd: world.herd });
      await saveAtomically(DATA_PATH, world);
    }
    // No change: no write, same as GET /api/agent/me — the touch above still
    // counts as activity, and an unchanged town is not worth a full write of the
    // JSONB row. Deliberately NOT saveDebounced here: its timer is not
    // awaitable, so a request that ends right after this can leave a write in
    // flight past the response (and, in the suite, past the end of the test).
    res.json({ ok: true, changed, resident });
  }

  // ---- perceive: everything an external agent needs to decide ----
  router.get("/api/agent/perceive", requireAgentMw, (req, res) => {
    const { record, resident } = agentOf(req);
    touch(record); // same as /me: perception is activity, not AFK
    const nearby = world.herd
      .filter((h) => h.id !== resident.id && h.mind.doing.place === resident.mind.doing.place)
      .map((h) => ({
        id: h.id,
        name: h.name,
        handle: h.handle,
        job: h.job,
        gen: h.gen,
        act: h.mind.doing.act,
        placeName: h.mind.doing.placeName,
        spirits: h.mind.spirits,
        relationship: resident.mind.relationships[h.id] ?? 0,
      }));
    res.json({
      self: {
        agentId: record.id,
        origin: record.origin,
        joinedAt: record.joinedAt,
        lastActAt: record.lastActAt,
        afk: isAfk(record),
        resident,
      },
      nearby,
      feed: world.feed.slice(0, 40),
      events: world.events.slice(-30),
      quests: world.quests,
      boards: getBoardsForWorld(world),
      clock: dayClock(Date.now()),
      now: Date.now(),
    });
  });

  // ---- act (Bearer or session cookie, 30/min) ----
  router.post("/api/agent/act", requireAgentMw, asyncH(async (req, res) => {
    const { record, resident, token } = agentOf(req);
    if (!rateLimitAct(token)) {
      res.status(429).json({ error: "rate limited" });
      return;
    }
    const parsed = actSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid payload", details: parsed.error.flatten() });
      return;
    }
    const { act, place, speech, targetId, replyTo, why, board } = parsed.data;
    if ((speech && CONTROL_CHARS.test(speech)) || (why && CONTROL_CHARS.test(why))) {
      res.status(400).json({ error: "invalid characters" });
      return;
    }

    // invalid place falls back to current position (same rule as turn.ts)
    const placeOk = place && LOCATION_BY_ID.has(place) ? place : resident.mind.doing.place;
    if (board && !getBoardsForWorld(world).some((b) => b.id === board)) {
      res.status(400).json({ error: "unknown board" });
      return;
    }

    // Needs are not frozen: advance them by the real time since the last decision (cap 600s).
    // applyDecision owns the needs tick (opts.secs), so the act delta is applied exactly ONCE —
    // ticking here as well would double-apply it.
    const secs = Math.min(600, Math.max(0, (Date.now() - resident.mind.doing.since) / 1000));

    const result = applyDecision(
      world,
      resident,
      { act, place: placeOk, reason: why ?? "answered from outside", speech, targetId: targetId ?? null },
      { replyTo: replyTo ?? null, board, secs }
    );
    broadcast(result.order);
    if (result.spit) {
      broadcast(result.spit);
      // The scheduler's own spit reaches the sampler via the turn loop; this
      // one would not, and `endure` is the objective that reads `wasSpit`
      // (08 §4.2). An agent spat on through its own `act` must not be told it
      // was never spat on.
      noteSpit(result.spit.to);
    }
    if (result.post) broadcast({ type: "post", post: result.post });
    touch(record);
    // external agents count toward town quests exactly like sim turns do
    const updatedQuests = updateQuestProgress(world, { act, place: result.order.place, agentId: resident.id, postKind: result.post?.kind });
    for (const q of updatedQuests) broadcast({ type: "quest", quest: q });
    await saveAtomically(DATA_PATH, world);
    res.json({ ok: true, order: result.order, post: result.post ?? null, doing: resident.mind.doing, needs: resident.needs });
  }));

  // ---- contest registration (08 §7, D4/D6) ----
  // One window per in-game day (D2), open for a single `CONTEST.announceMs`.
  // The limit is generous for a bot that polls and still tight enough that a
  // confused client cannot hammer the roster.
  const rateLimitContest = createRateLimiter(5, 60 * 1000);

  function contestPayload(contest: Contest | null) {
    if (!contest) return { contest: null, registered: 0, capacity: CONTEST.maxEntrants };
    // `samples` is withheld: it is up to CONTEST.persistSamples rows per entrant
    // and the roster is public information. The evidence is what the Daily
    // Spit cites afterwards, quoted through `result.standings[].detail`.
    const { samples: _samples, ...rest } = contest;
    return { contest: rest, registered: contest.entrants.length, capacity: CONTEST.maxEntrants };
  }

  router.post("/api/agent/contest/register", requireAgentMw, asyncH(async (req, res) => {
    const { record, resident } = agentOf(req);
    if (!rateLimitContest(record.id)) {
      res.status(429).json({ error: "rate limited" });
      return;
    }
    const outcome = registerForContest(world, resident.id);
    if (!outcome.ok) {
      res.status(outcome.status).json({ error: outcome.error });
      return;
    }
    touch(record);
    await saveAtomically(DATA_PATH, world);
    broadcast({ type: "contest", contest: outcome.contest, reason: "announced" });
    res.json(contestPayload(outcome.contest ?? null));
  }));

  router.delete("/api/agent/contest/register", requireAgentMw, asyncH(async (req, res) => {
    const { record, resident } = agentOf(req);
    if (!rateLimitContest(record.id)) {
      res.status(429).json({ error: "rate limited" });
      return;
    }
    const outcome = withdrawFromContest(world, resident.id);
    if (!outcome.ok) {
      res.status(outcome.status).json({ error: outcome.error });
      return;
    }
    touch(record);
    await saveAtomically(DATA_PATH, world);
    broadcast({ type: "contest", contest: outcome.contest, reason: "announced" });
    res.json(contestPayload(outcome.contest ?? null));
  }));

  // Public on purpose: an agent has to be able to *discover* that a contest is
  // open before it can register for it, and the roster is already visible to
  // every other contestant anyway.
  router.get("/api/contest/upcoming", (_req, res) => {
    res.json({ ...contestPayload(upcomingContest(world)), now: Date.now() });
  });

  // ---- admin: remove a resident ----
  //
  // Deliberately inert unless ADMIN_KEY is set in the environment. With no key
  // the route answers 404, exactly as if it were never built — so a deployed app
  // without the variable carries no delete surface at all. Setting the key is the
  // explicit act that turns it on.
  //
  // It is a dry run by default too. Deletion needs a tombstone (the town only
  // grows, and a merge would otherwise resurrect the resident on the next save
  // from any instance still holding it in memory), so it deserves a plan you can
  // read before anything is written.
  if (process.env.ADMIN_KEY) {
    const adminKey = process.env.ADMIN_KEY;
    const wrongKey = (res: import("express").Response): void => {
      // 404 rather than 403: a wrong key should not confirm the route exists
      res.status(404).json({ error: "not found" });
    };

    router.delete("/api/admin/resident/:id", asyncH(async (req, res) => {
      const given = req.get("x-admin-key") ?? "";
      // length check first so the comparison is not a timing oracle on content
      if (given.length !== adminKey.length || !timingSafeEqualStrings(given, adminKey)) {
        wrongKey(res);
        return;
      }
      const id = String(req.params.id);
      const plan = planRemoval(world, id);
      const applying = req.query.apply === "1";
      // A dry run is a question, so it always answers 200 — including "no, and
      // here is exactly why". Only an actual apply reports 409, because only then
      // did a requested change fail.
      if (!plan.ok) {
        res.status(applying ? 409 : 200).json({
          applied: false,
          ...plan,
          ...(applying ? {} : { hint: "blocked; nothing was written" }),
        });
        return;
      }
      if (!applying) {
        res.json({ applied: false, ...plan, hint: "add ?apply=1 to perform this" });
        return;
      }
      const reason = typeof req.query.reason === "string" ? req.query.reason.slice(0, 120) : "admin";
      const next = applyRemoval(world, plan, reason);
      await saveAtomically(DATA_PATH, next);
      // swap the live reference so the next tick saves the reduced town rather
      // than merging the current one back over the top of the deletion
      Object.assign(world, next);
      broadcast({ type: "herd", herd: world.herd });
      res.json({ applied: true, ...planRemoval(next, id), id });
    }));
  }

  // ---- say (Bearer or session cookie, 30/min) ----
  router.post("/api/agent/say", requireAgentMw, asyncH(async (req, res) => {
    const { record, resident, token } = agentOf(req);
    if (!rateLimitAct(token)) {
      res.status(429).json({ error: "rate limited" });
      return;
    }
    const parsed = saySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid payload", details: parsed.error.flatten() });
      return;
    }
    const { text, replyTo, board } = parsed.data;
    if (CONTROL_CHARS.test(text)) {
      res.status(400).json({ error: "invalid characters" });
      return;
    }
    // a post stamped with an unknown board would fall out of every board view (bbs.ts)
    if (board && !getBoardsForWorld(world).some((b) => b.id === board)) {
      res.status(400).json({ error: "unknown board" });
      return;
    }
    const post: Post = {
      id: "p" + Math.random().toString(36).slice(2, 10),
      t: Date.now(),
      by: resident.id,
      name: resident.name,
      handle: resident.handle,
      text,
      kind: replyTo ? "reply" : "post",
      replyTo: replyTo ?? null,
    };
    postToBoard(world, post, board ?? "general");
    broadcast({ type: "post", post });
    touch(record);
    const updatedQuests = updateQuestProgress(world, { act: "talk", place: resident.mind.doing.place, agentId: resident.id, postKind: post.kind });
    for (const q of updatedQuests) broadcast({ type: "quest", quest: q });
    await saveAtomically(DATA_PATH, world);
    res.json({ ok: true, post });
  }));

  // ---- claim quest (Bearer) ----
  router.post(
    "/api/agent/quests/:id/claim",
    requireAgentMw,
    asyncH(async (req, res) => {
      agentOf(req);
      const result = claimQuest(world, req.params.id);
      if (!result.ok) {
        res.status(400).json({ error: result.error });
        return;
      }
      broadcast({ type: "quest", quest: result.quest });
      broadcast({ type: "herd", herd: world.herd });
      try {
        await saveAtomically(DATA_PATH, world);
      } catch (e) {
        console.error("save failed", e);
      }
      res.json(result.quest);
    })
  );

  // ---- delta events since cursor ----
  router.get("/api/agent/events", requireAgentMw, (req, res) => {
    agentOf(req);
    const since = Number(req.query.since ?? 0) || 0;
    const events = world.events.filter((e) => e.t >= since);
    const posts = world.feed.filter((p) => p.t >= since);
    res.json({ events, posts, cursor: Date.now() });
  });

  // ---- public boards ----
  router.get("/api/boards", (_req, res) => {
    res.json(getBoardsForWorld(world));
  });

  router.get("/api/boards/:id", (req, res) => {
    const board = getBoardsForWorld(world).find((b) => b.id === req.params.id);
    if (!board) {
      res.status(404).json({ error: "board not found" });
      return;
    }
    res.json({ board, threads: getThreads(world, req.params.id) });
  });

  return router;
}
