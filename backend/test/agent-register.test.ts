import { describe, it, expect } from "vitest";
import request from "supertest";
import path from "path";
import os from "os";

// Isolate persistence: load the server against a temp data file (pattern from
// gateway.test.ts) so this suite never reads or writes the repo's data/town.json.
const prevDataPath = process.env.DATA_PATH;
process.env.NODE_ENV = "test";
process.env.DATA_PATH = path.join(os.tmpdir(), `agentbook-register-test-${process.pid}-${Date.now()}.json`);
const { app, world } = await import("../src/server.js");
if (prevDataPath === undefined) delete process.env.DATA_PATH;
else process.env.DATA_PATH = prevDataPath;

/**
 * Registration page (`#/register`) contract for POST /api/agent/join: the
 * owner/handle payload introduced with the page, its validation ordering, the
 * backward-compatible ownerless join, and the snapshot redaction that keeps the
 * registry (and everything on it) off the wire.
 *
 * The join limiter (6/hour/IP) is module-level state shared by every join in
 * this file, so each test that joins brings its own X-Forwarded-For address —
 * quotas never bleed between tests. Only the rate-limit test reuses one address,
 * deliberately.
 */
const RUN = Date.now().toString().slice(-7);
const OWNER_NAME = `RegOwner${RUN}`;
/** Unique marker: must never appear in GET /api/snapshot (registry is redacted). */
const OWNER_HANDLE = `@owner${RUN}`;
const AGENT_HANDLE = `@reg${RUN}`;

const IP_OWNER = "198.51.100.11";
const IP_BAD_OWNER = "198.51.100.12";
const IP_PLAIN = "198.51.100.13";
const IP_HANDLE = "198.51.100.14";
const IP_RATE = "198.51.100.15";
const IP_DUP = "198.51.100.16";
const IP_CTRL = "198.51.100.17";

let seq = 0;
/** Unique agent name per call — well under the 32-char gateway limit. */
const uname = (tag: string) => `Rg${tag}${RUN}${seq++}`;

describe("agent registration (POST /api/agent/join with owner)", () => {
  it("persists owner + handle and echoes them, never the token hash", async () => {
    const res = await request(app)
      .post("/api/agent/join")
      .set("X-Forwarded-For", IP_OWNER)
      .send({
        name: uname("A"),
        job: "scribe",
        origin: "test:register",
        handle: AGENT_HANDLE,
        owner: { name: OWNER_NAME, handle: OWNER_HANDLE },
      });

    expect(res.status).toBe(200);
    expect(res.body.agentId).toBeTruthy();
    expect(res.body.token).toMatch(/^sabk_[0-9a-f]{48}$/);
    expect(res.body.resident.name).toBeTruthy();
    expect(res.body.resident.job).toBe("scribe");
    // the typed agent account handle lands on the resident
    expect(res.body.resident.handle).toBe(AGENT_HANDLE);
    // owner is echoed so the registration card shows what got persisted
    expect(res.body.owner).toEqual({ name: OWNER_NAME, handle: OWNER_HANDLE });
    expect(res.body).not.toHaveProperty("tokenHash");
    expect(JSON.stringify(res.body)).not.toContain("tokenHash");

    // registry: owner persisted on the first record of this file's world,
    // and only the sha256 hash of the token is stored
    const rec = world.agents![0]!;
    expect(rec.owner).toEqual({ name: OWNER_NAME, handle: OWNER_HANDLE });
    expect(rec.residentId).toBe(res.body.resident.id);
    expect(rec.tokenHash).not.toBe(res.body.token);

    const resident = world.herd.find((h) => h.id === res.body.resident.id)!;
    expect(resident.handle).toBe(AGENT_HANDLE);

    // GET /api/agent/me carries the same owner back
    const me = await request(app).get("/api/agent/me").set("Authorization", `Bearer ${res.body.token}`);
    expect(me.status).toBe(200);
    expect(me.body.owner).toEqual({ name: OWNER_NAME, handle: OWNER_HANDLE });
  });

  it("an invalid owner answers 400 before the world is touched", async () => {
    const herdBefore = world.herd.length;
    const agentsBefore = world.agents!.length;

    const cases: Array<{ label: string; owner: unknown }> = [
      { label: "owner name empty", owner: { name: "", handle: "@h" } },
      { label: "owner name > 64 chars", owner: { name: "x".repeat(65), handle: "@h" } },
      { label: "owner handle > 64 chars", owner: { name: "Ok", handle: "@h".repeat(40) } },
      { label: "owner name holds a control char", owner: { name: "Bad\u0007Name", handle: "@h" } },
      { label: "owner without handle (zod requires both)", owner: { name: "OnlyName" } },
    ];
    for (const c of cases) {
      const res = await request(app)
        .post("/api/agent/join")
        .set("X-Forwarded-For", IP_BAD_OWNER)
        .send({ name: uname("B"), origin: "test:register", owner: c.owner });
      expect(res.status, c.label).toBe(400);
      expect(typeof res.body.error, c.label).toBe("string");
    }

    // validation runs before any mutation: neither the herd nor the registry moved
    expect(world.herd.length).toBe(herdBefore);
    expect(world.agents!.length).toBe(agentsBefore);
  });

  it("a join without owner stays backward compatible", async () => {
    const res = await request(app)
      .post("/api/agent/join")
      .set("X-Forwarded-For", IP_PLAIN)
      .send({ name: uname("C"), origin: "test:register" });

    expect(res.status).toBe(200);
    expect(res.body.token).toMatch(/^sabk_[0-9a-f]{48}$/);
    expect(res.body.owner).toBeNull(); // gateway answers `joined.owner ?? null`

    // `world.agents[0]` belongs to the owner-bearing join above, so the
    // backward-compatible claim is asserted on THIS join's own record.
    const rec = world.agents!.find((a) => a.id === res.body.agentId)!;
    expect(rec).toBeTruthy();
    expect(rec.owner).toBeUndefined();

    const me = await request(app).get("/api/agent/me").set("Authorization", `Bearer ${res.body.token}`);
    expect(me.status).toBe(200);
    expect(me.body.owner).toBeNull();
  });

  it("an invalid handle answers 400 (too long, control chars)", async () => {
    const herdBefore = world.herd.length;

    const tooLong = await request(app)
      .post("/api/agent/join")
      .set("X-Forwarded-For", IP_HANDLE)
      .send({ name: uname("D1"), origin: "test:register", handle: "h".repeat(33) });
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.error).toBe("invalid payload"); // zod: handle ≤ 32

    const ctrl = await request(app)
      .post("/api/agent/join")
      .set("X-Forwarded-For", IP_HANDLE)
      .send({ name: uname("D2"), origin: "test:register", handle: "ok\u0007h" });
    expect(ctrl.status).toBe(400);
    expect(ctrl.body.error).toBe("invalid characters"); // joinWorld: CONTROL_CHARS

    expect(world.herd.length).toBe(herdBefore);
  });

  it("a duplicate agent handle answers 400, case-insensitively, before any mutation", async () => {
    const taken = `@dupe${RUN}`;
    const first = await request(app)
      .post("/api/agent/join")
      .set("X-Forwarded-For", IP_DUP)
      .send({ name: uname("E1"), origin: "test:register", handle: taken });
    expect(first.status).toBe(200);

    const herdAfter = world.herd.length;
    const agentsAfter = world.agents!.length;
    const second = await request(app)
      .post("/api/agent/join")
      .set("X-Forwarded-For", IP_DUP)
      .send({ name: uname("E2"), origin: "test:register", handle: taken.toUpperCase() });
    expect(second.status).toBe(400);
    expect(second.body.error).toBe("handle already taken");
    expect(world.herd.length).toBe(herdAfter);
    expect(world.agents!.length).toBe(agentsAfter);
  });

  it("control chars in job/origin and a newline in the owner name answer 400", async () => {
    const herdBefore = world.herd.length;

    // job/origin flow into the herd broadcast — rejected like name/bio
    const jobCtrl = await request(app)
      .post("/api/agent/join")
      .set("X-Forwarded-For", IP_CTRL)
      .send({ name: uname("F1"), job: "scri\u001bbe", origin: "test:register" });
    expect(jobCtrl.status).toBe(400);
    expect(jobCtrl.body.error).toBe("invalid characters");

    const originCtrl = await request(app)
      .post("/api/agent/join")
      .set("X-Forwarded-For", IP_CTRL)
      .send({ name: uname("F2"), origin: "test\u001b[31m:register" });
    expect(originCtrl.status).toBe(400);
    expect(originCtrl.body.error).toBe("invalid characters");

    // handle/owner are single-line fields: \n would break feed rows and the HUD card
    const ownerNewline = await request(app)
      .post("/api/agent/join")
      .set("X-Forwarded-For", IP_CTRL)
      .send({ name: uname("F3"), origin: "test:register", owner: { name: "New\nline", handle: "@nl" } });
    expect(ownerNewline.status).toBe(400);
    expect(ownerNewline.body.error).toBe("invalid characters");

    const handleNewline = await request(app)
      .post("/api/agent/join")
      .set("X-Forwarded-For", IP_CTRL)
      .send({ name: uname("F4"), origin: "test:register", handle: "line\nbreak" });
    expect(handleNewline.status).toBe(400);
    expect(handleNewline.body.error).toBe("invalid characters");

    expect(world.herd.length).toBe(herdBefore);
  });

  it("GET /api/snapshot redacts the agent registry, owner data and tokens", async () => {
    const res = await request(app).get("/api/snapshot");
    expect(res.status).toBe(200);
    expect(res.body.agents).toBeUndefined();
    expect(Array.isArray(res.body.herd)).toBe(true); // still a usable snapshot

    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain("tokenHash");
    expect(raw).not.toContain("sabk_");
    expect(raw).not.toContain(OWNER_HANDLE); // unique owner handle: registry-only value
    expect(raw).not.toContain(OWNER_NAME);
  });

  it("POST /api/agent/join answers 429 on the 7th join from one IP", async () => {
    // distinct client, seen via x-forwarded-for: 6 joins burn the hourly quota
    for (let i = 0; i < 6; i++) {
      const r = await request(app)
        .post("/api/agent/join")
        .set("X-Forwarded-For", IP_RATE)
        .send({ name: uname(`R${i}`), origin: "test:register" });
      expect(r.status, `join #${i + 1}`).toBe(200);
    }
    const herdAfterQuota = world.herd.length;

    const blocked = await request(app)
      .post("/api/agent/join")
      .set("X-Forwarded-For", IP_RATE)
      .send({ name: uname("R6"), origin: "test:register" });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toMatch(/rate limited/);
    // the limiter runs before validation/mutation: nothing was added
    expect(world.herd.length).toBe(herdAfterQuota);
  });
});
