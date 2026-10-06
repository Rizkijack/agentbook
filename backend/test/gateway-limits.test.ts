import { describe, it, expect } from "vitest";
import request from "supertest";
import path from "path";
import os from "os";
import { readFile } from "fs/promises";

// Isolate persistence: load the server against a temp data file (same pattern
// as gateway.test.ts) so we can inspect what actually lands on disk.
const prevDataPath = process.env.DATA_PATH;
process.env.NODE_ENV = "test";
process.env.DATA_PATH = path.join(os.tmpdir(), `hermesbook-limits-test-${process.pid}-${Date.now()}.json`);
const { app, world, DATA_PATH } = await import("../src/server.js");
const { rateLimitAct } = await import("../src/agents.js");
if (prevDataPath === undefined) delete process.env.DATA_PATH;
else process.env.DATA_PATH = prevDataPath;

let token = "";
let agentId = "";
const joinName = "LimAgent" + Date.now().toString().slice(-6);

describe("gateway limits & auth", () => {
  it("join persists only the token hash — no plaintext token in DATA_PATH", async () => {
    const res = await request(app).post("/api/agent/join").send({ name: joinName, origin: "vitest" });
    expect(res.status).toBe(200);
    token = res.body.token;
    agentId = res.body.agentId;
    expect(token).toMatch(/^hbk_[0-9a-f]{48}$/);

    const raw = await readFile(DATA_PATH, "utf8");
    expect(raw).not.toContain("hbk_"); // plaintext bearer token never reaches disk
    expect(raw).toContain("tokenHash"); // only the sha256 hash is stored
  });

  it("POST /api/agent/join answers 429 after 6 requests/hour/IP", async () => {
    const ip = "203.0.113.9"; // distinct client, seen via x-forwarded-for
    // the limiter runs BEFORE validation, so empty-name payloads still consume quota
    for (let i = 0; i < 6; i++) {
      const r = await request(app).post("/api/agent/join").set("X-Forwarded-For", ip).send({ name: "" });
      expect(r.status).toBe(400);
    }
    const blocked = await request(app).post("/api/agent/join").set("X-Forwarded-For", ip).send({ name: "" });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toMatch(/rate limited/);
  });

  it("POST /api/agent/resume acknowledges the session (happy path)", async () => {
    const res = await request(app).post("/api/agent/resume").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.agentId).toBe(agentId);
    expect(res.body.lastActAt).toBeGreaterThan(0);
    expect(res.body.clock).toBeDefined();
  });

  it("POST /api/agent/quests/:id/claim claims a completed quest (happy path)", async () => {
    expect(world.quests.length).toBeGreaterThan(0);
    const quest = world.quests.find((q) => q.status === "completed") ?? world.quests[0]!;
    quest.status = "completed"; // state manipulation: pretend the town finished it

    const res = await request(app)
      .post(`/api/agent/quests/${quest.id}/claim`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(quest.id);
    expect(res.body.status).toBe("claimed");
  });

  it("GET /api/agent/events returns events, posts and a cursor (happy path)", async () => {
    const res = await request(app).get("/api/agent/events?since=0").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.events)).toBe(true);
    expect(Array.isArray(res.body.posts)).toBe(true);
    expect(res.body.cursor).toBeGreaterThan(0);
  });

  it("act, say, claim and events answer 401 without a Bearer token", async () => {
    const calls = [
      request(app).post("/api/agent/act").send({ act: "talk" }),
      request(app).post("/api/agent/say").send({ text: "halo" }),
      request(app).post(`/api/agent/quests/${world.quests[0]!.id}/claim`).send({}),
      request(app).get("/api/agent/events"),
    ];
    for (const call of calls) {
      const res = await call;
      expect(res.status).toBe(401);
      expect(res.body.error).toBe("unauthorized");
    }
  });

  it("POST /api/agent/act answers 429 after 30 acts/minute/token", async () => {
    // fill the window in-process instead of firing 30 HTTP requests
    for (let i = 0; i < 30; i++) rateLimitAct(token);
    const res = await request(app).post("/api/agent/act").set("Authorization", `Bearer ${token}`).send({ act: "talk" });
    expect(res.status).toBe(429);
    expect(res.body.error).toMatch(/rate limited/);
  });
});
