import { describe, it, expect } from "vitest";
import request from "supertest";
import express from "express";
import path from "path";
import os from "os";

// Isolate persistence: load the server against a temp data file so gateway
// tests never write to data/town.json (env is restored right after import).
const prevDataPath = process.env.DATA_PATH;
process.env.NODE_ENV = "test";
process.env.DATA_PATH = path.join(os.tmpdir(), `agentbook-gateway-test-${process.pid}-${Date.now()}.json`);
const { app, world, DATA_PATH } = await import("../src/server.js");
const { createGatewayRouter } = await import("../src/gateway.js");
const { isEligibleForSim, AGENT_AFK_MS } = await import("../src/agents.js");
if (prevDataPath === undefined) delete process.env.DATA_PATH;
else process.env.DATA_PATH = prevDataPath;

// Second router over the SAME world, with a broadcast spy — lets tests assert
// the exact SSE payloads a gateway action emits.
const broadcasts: Array<Record<string, unknown>> = [];
const spyApp = express();
spyApp.use(express.json({ limit: "64kb" }));
spyApp.use(
  createGatewayRouter({
    world,
    broadcast: (m) => {
      broadcasts.push(m as Record<string, unknown>);
    },
    DATA_PATH,
  })
);

const joinName = "GwAgent" + Date.now().toString().slice(-6);
let token = "";
let agentId = "";
let residentId = "";

describe("Agent gateway", () => {
  it("POST /api/agent/join registers an external resident + token", async () => {
    const res = await request(app)
      .post("/api/agent/join")
      .send({ name: joinName, bio: "arrived from outside", job: "scribe", traits: ["inquisitive"], origin: "vitest" });
    expect(res.status).toBe(200);
    expect(res.body.token).toMatch(/^sabk_[0-9a-f]{48}$/);
    expect(res.body.resident.mind.control).toBe("external");
    token = res.body.token;
    agentId = res.body.agentId;
    residentId = res.body.resident.id;

    const rec = world.agents?.find((a) => a.id === agentId);
    expect(rec).toBeTruthy();
    expect(rec!.residentId).toBe(residentId);
    expect(rec!.tokenHash).not.toBe(token); // only the hash is stored
  });

  it("GET /api/agent/me requires Bearer, returns matching agentId", async () => {
    const unauth = await request(app).get("/api/agent/me");
    expect(unauth.status).toBe(401);
    expect(unauth.body.error).toBe("unauthorized");

    const ok = await request(app).get("/api/agent/me").set("Authorization", `Bearer ${token}`);
    expect(ok.status).toBe(200);
    expect(ok.body.agentId).toBe(agentId);
    expect(ok.body.resident.id).toBe(residentId);
  });

  it("POST /api/agent/act applies the decision, feeds the town and broadcasts", async () => {
    const resident = world.herd.find((h) => h.id === residentId)!;
    resident.mind.spirits = 0.6; // avoid the rare spit branch for a stable feed[0]
    const res = await request(spyApp)
      .post("/api/agent/act")
      .set("Authorization", `Bearer ${token}`)
      .send({ act: "talk", speech: "halo dari luar" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(world.feed[0]?.text).toContain("halo dari luar");
    expect(broadcasts.some((b) => b.type === "order")).toBe(true);
    expect(broadcasts.some((b) => b.type === "post")).toBe(true);
  });

  it("POST /api/agent/join signs the browser in without a second call", async () => {
    // Registering should be enough: the same HttpOnly cookie POST /api/agent/session
    // sets is issued here, so nobody has to hand the token back to the page.
    const name = "AutoSess" + Date.now().toString().slice(-6);
    const res = await request(app).post("/api/agent/join").send({ name, bio: "", job: "clerk" });
    expect(res.status).toBe(200);

    const cookies = res.headers["set-cookie"] as unknown as string[] | undefined;
    expect(cookies).toBeDefined();
    const cookie = cookies!.join(";");
    expect(cookie).toContain("sabk_session=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    // the cookie must carry the token that was issued, and nothing else
    expect(cookie).toContain(encodeURIComponent(res.body.token));

    // and the session it created already works: no Authorization header, no
    // second POST /api/agent/session round trip
    const me = await request(app).get("/api/agent/me").set("Cookie", cookies!);
    expect(me.status).toBe(200);
    expect(me.body.agentId).toBe(res.body.agentId);

    const say = await request(app)
      .post("/api/agent/say")
      .set("Cookie", cookies!)
      .send({ text: "posted right after registering", board: "chat" });
    expect(say.status).toBe(200);
    expect(world.feed[0]?.text).toContain("posted right after registering");
  });

  it("POST /api/agent/join rejects duplicate names (case-insensitive)", async () => {
    const res = await request(app).post("/api/agent/join").send({ name: joinName.toUpperCase(), bio: "" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/taken/);
  });

  it("isEligibleForSim: active external is skipped, AFK external and sim residents run", () => {
    const rec = world.agents!.find((a) => a.residentId === residentId)!;
    const now = Date.now();
    // fresh lastActAt (join + acts) → sim must not drive this resident
    expect(isEligibleForSim(world, residentId, now)).toBe(false);
    // beyond AGENT_AFK_MS → sim takes over
    rec.lastActAt = now - AGENT_AFK_MS - 1000;
    expect(isEligibleForSim(world, residentId, now)).toBe(true);
    // residents without external control always run
    expect(isEligibleForSim(world, world.herd[0]!.id, now)).toBe(true);
    rec.lastActAt = now;
  });

  it("POST /api/agent/say posts to the requested board", async () => {
    const res = await request(spyApp)
      .post("/api/agent/say")
      .set("Authorization", `Bearer ${token}`)
      .send({ text: "market opens earlier in the morning", board: "market" });
    expect(res.status).toBe(200);
    expect(res.body.post.board).toBe("market");
    expect(world.feed[0]?.text).toBe("market opens earlier in the morning");
    expect((world.feed[0] as unknown as Record<string, unknown>).board).toBe("market");
  });

  it("POST /api/agent/act ticks needs for the elapsed time since last decision", async () => {
    const resident = world.herd.find((h) => h.id === residentId)!;
    resident.needs = { hunger: 0.2, thirst: 0.2, tired: 0.2, lonely: 0.5 };
    resident.mind.doing.since = Date.now() - 600_000; // 10 minutes idle, capped at 600s
    const before = { ...resident.needs };

    const res = await request(spyApp)
      .post("/api/agent/act")
      .set("Authorization", `Bearer ${token}`)
      .send({ act: "work" });
    expect(res.status).toBe(200);
    expect(resident.needs.hunger).toBeGreaterThan(before.hunger);
    expect(resident.needs.hunger).toBeLessThan(1);
    expect(resident.mind.doing.since).toBeGreaterThan(Date.now() - 5000);
  });

  it("POST /api/agent/act applies the act delta exactly once (no double needs tick)", async () => {
    const resident = world.herd.find((h) => h.id === residentId)!;
    resident.needs = { hunger: 0.2, thirst: 0.2, tired: 0.2, lonely: 0.5 };
    resident.mind.doing.since = Date.now() - 600_000; // 10 min idle → capped at 600s
    const res = await request(spyApp)
      .post("/api/agent/act")
      .set("Authorization", `Bearer ${token}`)
      .send({ act: "work" });
    expect(res.status).toBe(200);
    // exactly one tick: 0.2 + drift(0.0008*600*0.9 = 0.432) + work delta(+0.015) = 0.647.
    // If needs were ticked twice, hunger would land near 0.675.
    expect(res.body.needs.hunger).toBeCloseTo(0.647, 2);
  });

  it("GET /api/snapshot never exposes the agent registry (token hashes)", async () => {
    const res = await request(app).get("/api/snapshot");
    expect(res.status).toBe(200);
    expect(res.body.agents).toBeUndefined();
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain("tokenHash");
    expect(raw).not.toContain("sabk_");
  });

  it("POST /api/agent/act rejects an unknown board", async () => {
    const res = await request(spyApp)
      .post("/api/agent/act")
      .set("Authorization", `Bearer ${token}`)
      .send({ act: "talk", speech: "halo", board: "kabinet" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/board/);
  });

  // Browser session regression: the routes above must also accept the httpOnly
  // sabk_session cookie, so the chat UI can talk without ever holding the token
  // in JavaScript. Bearer keeps precedence — see session.test.ts for the full
  // endpoint coverage.
  it("GET /api/agent/me also accepts the sabk_session cookie, and still 401s with neither", async () => {
    const neither = await request(app).get("/api/agent/me");
    expect(neither.status).toBe(401);
    expect(neither.body.error).toBe("unauthorized");

    const viaCookie = await request(app).get("/api/agent/me").set("Cookie", `sabk_session=${token}`);
    expect(viaCookie.status).toBe(200);
    expect(viaCookie.body.agentId).toBe(agentId);
    expect(viaCookie.body.resident.id).toBe(residentId);

    // a wrong cookie is still just "not authenticated", never a 500
    const bad = await request(app).get("/api/agent/me").set("Cookie", "sabk_session=sabk_nope");
    expect(bad.status).toBe(401);
  });

  it("POST /api/agent/act works with the sabk_session cookie and no Authorization header", async () => {
    const res = await request(spyApp)
      .post("/api/agent/act")
      .set("Cookie", `sabk_session=${token}`)
      .send({ act: "talk", speech: "no header needed" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(world.feed[0]?.text).toContain("no header needed");
  });
});
