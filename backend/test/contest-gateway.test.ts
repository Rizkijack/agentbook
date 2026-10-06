/**
 * The contest registration routes (08 §7, §13 `contest-gateway.test.ts`).
 *
 * These are the only endpoints an agent author has to call to take part, so the
 * things worth pinning are the promises rather than the plumbing: a Bearer token
 * is required, a full roster turns the latecomer away *without* cancelling the
 * contest, a withdrawal works mid-window, and D6 stops a start that never had
 * two entrants.
 *
 * `saveAtomically` is mocked so nothing touches disk; the rest of the gateway
 * (auth, rate limiter, routing) stays real.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

vi.mock("../src/persist.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/persist.js")>();
  return { ...actual, saveAtomically: vi.fn(async () => undefined) };
});

const { createGatewayRouter } = await import("../src/gateway.js");
const { createInitialWorld } = await import("../src/world.js");
const { joinWorld } = await import("../src/agents.js");
const { ensureHouseResidents } = await import("../src/houseagents.js");
const { announceContest, tickTournament } = await import("../src/tournament.js");
const { CONTEST } = await import("@hermesbook/shared");

const T0 = 1_700_000_000_000;
const TICK = 1_800;

let world: ReturnType<typeof createInitialWorld>;
let app: express.Express;
let agentSeq = 0;

/** Join an external agent and return its bearer token + resident id. */
function newAgent(): { token: string; residentId: string } {
  const joined = joinWorld(world, { name: `Gw${agentSeq++}`, origin: "vitest" });
  return { token: joined.token, residentId: joined.resident.id };
}

beforeEach(() => {
  world = createInitialWorld();
  ensureHouseResidents(world);
  app = express();
  app.use(express.json({ limit: "64kb" }));
  app.use(createGatewayRouter({ world, broadcast: () => {}, DATA_PATH: "/tmp/never-written-contest.json" }));
});

describe("POST /api/agent/contest/register", () => {
  it("refuses without a Bearer token", async () => {
    announceContest(world, T0);
    const res = await request(app).post("/api/agent/contest/register");
    expect(res.status).toBe(401);
  });

  it("refuses a bad token", async () => {
    announceContest(world, T0);
    const res = await request(app)
      .post("/api/agent/contest/register")
      .set("Authorization", "Bearer hbk_deadbeef");
    expect(res.status).toBe(401);
  });

  it("accepts an external agent and reports the roster", async () => {
    const a = newAgent();
    announceContest(world, T0);
    const res = await request(app)
      .post("/api/agent/contest/register")
      .set("Authorization", `Bearer ${a.token}`);
    expect(res.status).toBe(200);
    expect(res.body.contest.entrants).toContain(a.residentId);
    expect(res.body.registered).toBe(res.body.contest.entrants.length);
    expect(res.body.capacity).toBe(CONTEST.maxEntrants);
  });

  it("withholds the evidence trail from the public payload", async () => {
    // up to CONTEST.persistSamples rows per entrant is not information the roster
    // needs; the Daily Spit quotes `result.standings[].detail` after the fact
    const a = newAgent();
    const c = announceContest(world, T0)!;
    c.samples = [{ t: T0, agentId: a.residentId, place: "square", spirits: 0.5, wasSpit: false }];
    const res = await request(app)
      .post("/api/agent/contest/register")
      .set("Authorization", `Bearer ${a.token}`);
    expect(res.status).toBe(200);
    expect(res.body.contest).not.toHaveProperty("samples");
  });

  it("turns the latecomer away when the roster is full, without cancelling the contest", async () => {
    // one over capacity, so there is definitely somebody to turn away
    const agents = Array.from({ length: CONTEST.maxEntrants + 1 }, () => newAgent());
    const c = announceContest(world, T0)!;
    // a house bot may already hold a slot (D8); the agent budget is what is left
    const takenByHouse = c.entrants.length;
    const slots = CONTEST.maxEntrants - takenByHouse;

    for (const a of agents.slice(0, slots)) {
      const res = await request(app)
        .post("/api/agent/contest/register")
        .set("Authorization", `Bearer ${a.token}`);
      expect(res.status).toBe(200);
    }
    expect(c.entrants).toHaveLength(CONTEST.maxEntrants);

    // one too many
    const over = await request(app)
      .post("/api/agent/contest/register")
      .set("Authorization", `Bearer ${agents[slots]!.token}`);
    expect(over.status).toBe(409);
    expect(over.body.error).toMatch(/full/i);
    // the contest the others signed up for is still on
    expect(c.state).toBe("announced");
    expect(c.entrants).toHaveLength(CONTEST.maxEntrants);
  });

  it("is rate limited", async () => {
    const a = newAgent();
    announceContest(world, T0);
    const statuses: number[] = [];
    for (let i = 0; i < 8; i++) {
      const res = await request(app)
        .post("/api/agent/contest/register")
        .set("Authorization", `Bearer ${a.token}`);
      statuses.push(res.status);
    }
    expect(statuses).toContain(429);
  });
});

describe("DELETE /api/agent/contest/register", () => {
  it("withdraws during the announce window", async () => {
    const a = newAgent();
    const c = announceContest(world, T0)!;
    await request(app).post("/api/agent/contest/register").set("Authorization", `Bearer ${a.token}`);
    expect(c.entrants).toContain(a.residentId);

    const res = await request(app)
      .delete("/api/agent/contest/register")
      .set("Authorization", `Bearer ${a.token}`);
    expect(res.status).toBe(200);
    expect(c.entrants).not.toContain(a.residentId);
  });

  it("refuses once the contest is live — the roster was promised to the others (D5)", async () => {
    const a = newAgent();
    const b = newAgent();
    const c = announceContest(world, T0)!;
    for (const ag of [a, b]) {
      await request(app).post("/api/agent/contest/register").set("Authorization", `Bearer ${ag.token}`);
    }
    tickTournament(world, c.startsAt);
    expect(c.state).toBe("live");

    const res = await request(app)
      .delete("/api/agent/contest/register")
      .set("Authorization", `Bearer ${a.token}`);
    expect(res.status).toBe(409);
    // D5: nobody is voided or kicked, the contest continues as it is
    expect(c.entrants).toContain(a.residentId);
    expect(c.entrants).toContain(b.residentId);
  });

  it("404s for an agent that never registered", async () => {
    const a = newAgent();
    announceContest(world, T0);
    const res = await request(app)
      .delete("/api/agent/contest/register")
      .set("Authorization", `Bearer ${a.token}`);
    expect(res.status).toBe(404);
  });

  it("requires a Bearer token", async () => {
    announceContest(world, T0);
    const res = await request(app).delete("/api/agent/contest/register");
    expect(res.status).toBe(401);
  });
});

describe("GET /api/contest/upcoming", () => {
  it("is public — an agent must be able to discover a contest before joining it", async () => {
    const c = announceContest(world, T0)!;
    const res = await request(app).get("/api/contest/upcoming");
    expect(res.status).toBe(200);
    expect(res.body.contest.id).toBe(c.id);
    expect(res.body.contest.kind).toBe(c.kind);
    expect(res.body.contest.startsAt).toBe(c.startsAt);
    expect(res.body.now).toBeTypeOf("number");
  });

  it("reports an empty slate once the day's contest is done, not a stale one", async () => {
    const a = newAgent();
    const b = newAgent();
    const c = announceContest(world, T0)!;
    c.entrants = [a.residentId, b.residentId];
    tickTournament(world, c.startsAt);
    for (let i = 0; i < 6; i++) tickTournament(world, c.startsAt + (i + 1) * TICK);
    tickTournament(world, c.endsAt + 1);
    expect(c.state).toBe("resolved");

    // a resolved contest is history, not something to register for
    const res = await request(app).get("/api/contest/upcoming");
    expect(res.status).toBe(200);
    expect(res.body.contest).toBeNull();
  });
});

describe("D6 through the HTTP surface", () => {
  it("a contest with one entrant never starts, and says so", async () => {
    // only the house bot is in the roster — below CONTEST.minEntrants
    const c = announceContest(world, T0)!;
    expect(c.entrants.length).toBeLessThan(CONTEST.minEntrants);
    const event = tickTournament(world, c.startsAt)!;
    expect(event.reason).toBe("skipped");
    expect(event.skippedBecause).toMatch(new RegExp(String(CONTEST.minEntrants)));
    expect(c.result).toBeUndefined();
  });

  it("a second entrant arriving in the window makes the same contest start", async () => {
    const a = newAgent();
    const c = announceContest(world, T0)!;
    expect(c.entrants.length).toBeLessThan(CONTEST.minEntrants);
    // the agent arrives before go-live
    await request(app).post("/api/agent/contest/register").set("Authorization", `Bearer ${a.token}`);
    expect(c.entrants.length).toBeGreaterThanOrEqual(CONTEST.minEntrants);
    expect(tickTournament(world, c.startsAt)?.reason).toBe("live");
  });

  it("runs a full contest to a scored result over the HTTP surface", async () => {
    const a = newAgent();
    const b = newAgent();
    const c = announceContest(world, T0)!;
    for (const ag of [a, b]) {
      await request(app).post("/api/agent/contest/register").set("Authorization", `Bearer ${ag.token}`);
    }
    tickTournament(world, c.startsAt);
    for (let i = 0; i < 10; i++) {
      for (const id of c.entrants) {
        const r = world.herd.find((h) => h.id === id);
        if (r) r.mind.doing.place = i % 2 === 0 ? c.place : "tavern";
      }
      tickTournament(world, c.startsAt + (i + 1) * TICK);
    }
    const done = tickTournament(world, c.endsAt + 1)!;
    expect(done.reason).toBe("resolved");
    expect(c.result!.standings.length).toBeGreaterThanOrEqual(2);
    // the season board moved
    expect(world.season!.standings.length).toBeGreaterThan(0);
  });
});
