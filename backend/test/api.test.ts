import { describe, it, expect } from "vitest";
import request from "supertest";
import http from "http";
import { app, world } from "../src/server.js";

describe("API", () => {
  it("GET /api/snapshot returns full world", async () => {
    const res = await request(app).get("/api/snapshot");
    expect(res.status).toBe(200);
    expect(res.body.herd).toBeDefined();
    expect(Array.isArray(res.body.herd)).toBe(true);
    expect(res.body.config.name).toBe("SlopAgentbook");
    expect(res.body.feed).toBeDefined();
    expect(res.body.editions).toBeDefined();
  });

  it("GET /api/status returns brain herd spend", async () => {
    const res = await request(app).get("/api/status");
    expect(res.status).toBe(200);
    expect(res.body.herd).toBeGreaterThan(0);
    expect(res.body.spend).toBeDefined();
    expect(res.body.llm).toBeDefined();
  });

  it("GET /api/treasury returns sol etc", async () => {
    const res = await request(app).get("/api/treasury");
    expect(res.status).toBe(200);
    expect(res.body.address).toBeTruthy();
    expect(res.body.chainName).toBe("Base");
    expect(res.body.sol).toBeGreaterThan(0);
  });

  it("GET /api/stream returns : open", async () => {
    const server = app.listen(0);
    await new Promise<void>((resolve, reject) => {
      const addr = server.address() as { port: number };
      const req = http.get(`http://127.0.0.1:${addr.port}/api/stream`, (res) => {
        try {
          expect(res.headers["content-type"]).toContain("text/event-stream");
        } catch (e) {
          server.close(() => reject(e));
          req.destroy();
          return;
        }
        let data = "";
        const timer = setTimeout(() => {
          server.close(() => reject(new Error("timeout waiting for : open")));
          req.destroy();
        }, 2000);
        res.on("data", (chunk: Buffer) => {
          data += chunk.toString();
          if (data.includes(": open")) {
            clearTimeout(timer);
            server.close(() => resolve());
            req.destroy();
          }
        });
      });
      req.on("error", (err) => {
        server.close(() => reject(err));
      });
    });
  }, 10000);

  it("POST /api/fork validates parent and name", async () => {
    // invalid parent — validated before the capacity check, so this holds even
    // when the saved herd is 64/64 (it used to answer "the pasture is full")
    const r1 = await request(app).post("/api/fork").send({ parent: "nonexistent", name: "NewName123", bio: "", traits: [], job: "herder" });
    expect(r1.status).toBe(400);
    expect(r1.body.error).toMatch(/parent/);

    // get valid parent from snapshot
    const snap = await request(app).get("/api/snapshot");
    const parent = snap.body.herd[0].id;
    const baseName = "TestFork" + Date.now().toString().slice(-5);

    // Guarantee exactly one free slot so this test asserts the fork contract
    // itself, not the live herd's occupancy (the saved town can be 64/64 full).
    // Full-pasture behaviour is asserted separately in the next test.
    const origMaxHerd = world.config.maxHerd;
    world.config.maxHerd = world.herd.length + 1;
    try {
      // valid fork
      const r2 = await request(app).post("/api/fork").send({ parent, name: baseName, bio: "test bio", traits: ["loyal"], job: "scribe" });
      expect(r2.status).toBe(200);
      expect(r2.body.name).toBe(baseName);
      expect(r2.body.genes).toBeTruthy();

      // duplicate name should fail
      const r3 = await request(app).post("/api/fork").send({ parent, name: baseName, bio: "", traits: [], job: "herder" });
      expect(r3.status).toBe(400);
      expect(r3.body.error).toMatch(/taken/);

      // bio too long
      const r4 = await request(app).post("/api/fork").send({ parent, name: baseName + "2", bio: "x".repeat(181), traits: [], job: "herder" });
      expect(r4.status).toBe(400);

      // traits >3
      const r5 = await request(app).post("/api/fork").send({ parent, name: baseName + "3", bio: "", traits: ["a", "b", "c", "d"], job: "herder" });
      expect(r5.status).toBe(400);
    } finally {
      world.config.maxHerd = origMaxHerd;
    }
  });

  it("POST /api/fork validates input before capacity (full pasture)", async () => {
    // Asserts against `world` directly, so it relies on vitest running the
    // tests inside a file sequentially (do not enable sequence.concurrent).
    // Own rate-limit bucket (6/hour per IP, spoofable via x-forwarded-for by
    // design) so this test's three calls cannot starve the test above.
    const xff = "203.0.113.7";
    const fork = (payload: Record<string, unknown>) =>
      request(app).post("/api/fork").set("x-forwarded-for", xff).send(payload);

    // Make the pasture deterministically full, whatever the saved town holds.
    const origMaxHerd = world.config.maxHerd;
    world.config.maxHerd = world.herd.length;
    try {
      const parent = world.herd[0]!.id;
      const existingName = world.herd[0]!.name;

      // invalid parent must say "parent", not "the pasture is full"
      const r1 = await fork({ parent: "nonexistent", name: "OrderCheck" + Date.now().toString().slice(-5), bio: "", traits: [], job: "herder" });
      expect(r1.status).toBe(400);
      expect(r1.body.error).toMatch(/parent/);

      // duplicate name must say "taken", not "the pasture is full"
      const r2 = await fork({ parent, name: existingName, bio: "", traits: [], job: "herder" });
      expect(r2.status).toBe(400);
      expect(r2.body.error).toMatch(/taken/);

      // a valid payload on a full pasture still gets the capacity error
      const r3 = await fork({ parent, name: "PastureFull" + Date.now().toString().slice(-5), bio: "", traits: [], job: "herder" });
      expect(r3.status).toBe(400);
      expect(r3.body.error).toMatch(/pasture/);
    } finally {
      world.config.maxHerd = origMaxHerd;
    }
  });
});
