import { describe, it, expect } from "vitest";
import request from "supertest";
import express from "express";
import path from "path";
import os from "os";
import { readFile } from "fs/promises";

// Isolate persistence: load the server against a temp data file (same pattern as
// gateway.test.ts) so these never touch data/town.json.
const prevDataPath = process.env.DATA_PATH;
process.env.NODE_ENV = "test";
process.env.DATA_PATH = path.join(os.tmpdir(), `agentbook-profile-test-${process.pid}-${Date.now()}.json`);
const { app, world, DATA_PATH } = await import("../src/server.js");
const { createGatewayRouter } = await import("../src/gateway.js");
const { createRateLimiter, PROFILE_BIO_MAX, PROFILE_LINKS_MAX } = await import("../src/agents.js");
if (prevDataPath === undefined) delete process.env.DATA_PATH;
else process.env.DATA_PATH = prevDataPath;

// Own router over the SAME world with a broadcast spy, so the SSE frames a
// profile edit emits can be asserted exactly.
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

const uniq = Date.now().toString().slice(-7);

/** Distinct client per join: /api/agent/join is 6/hour/IP, and this suite registers ~10. */
let joinIpSeq = 0;
async function join(name: string, extra: Record<string, unknown> = {}) {
  const res = await request(app)
    .post("/api/agent/join")
    .set("X-Forwarded-For", `203.0.113.${(joinIpSeq += 1) % 250 + 1}`)
    .send({ name, bio: "", ...extra });
  expect(res.status, `join ${name} failed: ${JSON.stringify(res.body)}`).toBe(200);
  return res.body as { token: string; agentId: string; resident: Record<string, unknown> };
}

describe("PATCH /api/agent/profile", () => {
  it("rejects an unauthenticated call", async () => {
    const res = await request(spyApp).patch("/api/agent/profile").send({ bio: "no credential" });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("unauthorized");
  });

  it("an owner updates bio, avatar and links, and is told what changed", async () => {
    const owner = await join("ProfOwner" + uniq);
    const before = broadcasts.length;

    const res = await request(spyApp)
      .patch("/api/agent/profile")
      .set("Authorization", `Bearer ${owner.token}`)
      .send({
        bio: "writes manifests, not apologies",
        avatar: "https://cdn.example/owner.png",
        links: [
          { label: "site", url: "https://example.com/owner" },
          { label: "feed", url: "https://example.com/owner/feed" },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.changed.sort()).toEqual(["avatar", "bio", "links"]);
    expect(res.body.resident.bio).toBe("writes manifests, not apologies");
    expect(res.body.resident.avatar).toBe("https://cdn.example/owner.png");
    expect(res.body.resident.links).toHaveLength(2);

    // the write reached the herd, not just the response
    const stored = world.herd.find((h) => h.id === owner.resident.id)!;
    expect(stored.bio).toBe("writes manifests, not apologies");
    expect(stored.avatar).toBe("https://cdn.example/owner.png");

    // and it was persisted, not just held in memory
    const onDisk = JSON.parse(await readFile(DATA_PATH, "utf8"));
    const saved = onDisk.herd.find((h: { id: string }) => h.id === owner.resident.id);
    expect(saved.avatar).toBe("https://cdn.example/owner.png");

    // open tabs are told: the one resident that moved, then the whole herd
    const frames = broadcasts.slice(before);
    expect(frames.some((f) => f.type === "llama" && (f.llama as { id: string }).id === owner.resident.id)).toBe(true);
    expect(frames.some((f) => f.type === "herd")).toBe(true);
  });

  it("reports no change when the patch matches what is already stored", async () => {
    const owner = await join("ProfNoop" + uniq);
    const patch = { bio: "unchanged", avatar: "https://cdn.example/n.png" };

    const first = await request(spyApp).patch("/api/agent/profile").set("Authorization", `Bearer ${owner.token}`).send(patch);
    expect(first.body.changed.sort()).toEqual(["avatar", "bio"]);

    const before = broadcasts.length;
    const second = await request(spyApp).patch("/api/agent/profile").set("Authorization", `Bearer ${owner.token}`).send(patch);
    expect(second.status).toBe(200);
    expect(second.body.changed).toEqual([]);
    // nothing moved, so nothing is broadcast
    expect(broadcasts.length).toBe(before);
  });

  it("a valid token for a DIFFERENT resident cannot edit this profile", async () => {
    const victim = await join("ProfVictim" + uniq);
    const attacker = await join("ProfOther" + uniq);
    const originalBio = victim.resident.bio;

    const res = await request(spyApp)
      .patch("/api/agent/profile")
      .set("Authorization", `Bearer ${attacker.token}`)
      // the body names the victim explicitly, in every way a careless client might
      .send({ bio: "taken over", id: victim.resident.id, residentId: victim.resident.id });

    // the attacker only ever edits itself: owner-only by construction, because
    // agentOf() derives the resident from the token and the body names nobody
    expect(res.status).toBe(200);
    expect(res.body.resident.id).toBe(attacker.resident.id);
    expect(res.body.resident.bio).toBe("taken over");

    const victimNow = world.herd.find((h) => h.id === victim.resident.id)!;
    expect(victimNow.bio).toBe(originalBio);
    expect(victimNow.id).toBe(victim.resident.id);
  });

  it("ignores identity fields in the payload instead of applying them", async () => {
    const owner = await join("ProfId" + uniq);
    const r = world.herd.find((h) => h.id === owner.resident.id)!;
    const snapshot = JSON.parse(JSON.stringify(r));

    const res = await request(spyApp)
      .patch("/api/agent/profile")
      .set("Authorization", `Bearer ${owner.token}`)
      .send({
        bio: "the only field that should move",
        // every field this endpoint must refuse, in one payload
        id: "lmhacked",
        born: 1,
        gen: 9,
        parent: "lmfake",
        forks: 999,
        job: "overlord",
        name: "Impostor",
        handle: "@impostor",
        genes: "9.9.9.9.9.9.9.9",
        traits: ["omnipotent"],
        control: "sim",
        needs: { hunger: 1, thirst: 1, tired: 1, lonely: 1 },
        mind: { control: "sim", spirits: -1, obsession: "world domination", memories: ["injected"], relationships: { lmfake: 1 } },
        relationships: { lmfake: 1 },
      });

    expect(res.status).toBe(200);
    expect(res.body.changed).toEqual(["bio"]);

    const after = world.herd.find((h) => h.id === owner.resident.id)!;
    expect(after.bio).toBe("the only field that should move");
    // everything else is byte-identical to before
    expect(JSON.parse(JSON.stringify(after))["mind"]).toEqual(snapshot.mind);
    expect({ ...JSON.parse(JSON.stringify(after)), bio: snapshot.bio }).toEqual(snapshot);
    // the resident is still findable under its real id, i.e. it was not renamed out from under the town
    expect(world.herd.some((h) => h.id === "lmhacked")).toBe(false);
  });

  it("refuses a bad avatar with a 400 naming the field", async () => {
    const owner = await join("ProfAv" + uniq);
    const cases: Array<[string, RegExp]> = [
      ["javascript:alert(1)", /avatar/],
      ["data:image/svg+xml;base64,PHN2Zz4=", /data:/],
      ["//evil.example/x.png", /absolute/],
      ["https://cdn.example/a\u0007.png", /control/],
      ["/relative.png", /absolute/],
      ["", /required/],
    ];
    for (const [avatar, message] of cases) {
      const res = await request(spyApp).patch("/api/agent/profile").set("Authorization", `Bearer ${owner.token}`).send({ avatar });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(message);
      expect(res.body.field).toBe("avatar");
    }
    // and nothing was written along the way
    expect(world.herd.find((h) => h.id === owner.resident.id)!.avatar).toBeUndefined();
  });

  it("refuses a 6th link and an over-long bio or label", async () => {
    const owner = await join("ProfLim" + uniq);
    const link = (i: number) => ({ label: `l${i}`, url: `https://example.com/${i}` });

    const six = await request(spyApp)
      .patch("/api/agent/profile")
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ links: Array.from({ length: PROFILE_LINKS_MAX + 1 }, (_, i) => link(i)) });
    expect(six.status).toBe(400);
    expect(six.body.error).toMatch(/too many links/);
    expect(six.body.field).toBe("links");

    const exactlyFive = await request(spyApp)
      .patch("/api/agent/profile")
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ links: Array.from({ length: PROFILE_LINKS_MAX }, (_, i) => link(i)) });
    expect(exactlyFive.status).toBe(200);
    expect(exactlyFive.body.resident.links).toHaveLength(PROFILE_LINKS_MAX);

    const longBio = await request(spyApp)
      .patch("/api/agent/profile")
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ bio: "x".repeat(PROFILE_BIO_MAX + 1) });
    expect(longBio.status).toBe(400);
    expect(longBio.body.error).toMatch(/too long/);
    expect(longBio.body.field).toBe("bio");

    const longLabel = await request(spyApp)
      .patch("/api/agent/profile")
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ links: [{ label: "x".repeat(200), url: "https://example.com/" }] });
    expect(longLabel.status).toBe(400);
    expect(longLabel.body.field).toBe("links[0].label");

    // one bad entry refuses the WHOLE patch: validate before mutate
    const partial = await request(spyApp)
      .patch("/api/agent/profile")
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ avatar: "https://cdn.example/fine.png", links: [{ label: "ok", url: "javascript:alert(1)" }] });
    expect(partial.status).toBe(400);
    expect(world.herd.find((h) => h.id === owner.resident.id)!.avatar).toBeUndefined();
  });

  it("clears avatar and links on null", async () => {
    const owner = await join("ProfClear" + uniq);
    await request(spyApp)
      .patch("/api/agent/profile")
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ avatar: "https://cdn.example/c.png", links: [{ label: "s", url: "https://e.example/" }] });

    const res = await request(spyApp)
      .patch("/api/agent/profile")
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ avatar: null, links: null });
    expect(res.status).toBe(200);
    expect(res.body.changed.sort()).toEqual(["avatar", "links"]);
    expect(res.body.resident.avatar).toBeUndefined();
    expect(res.body.resident.links).toBeUndefined();
  });

  it("refuses a patch with nothing editable in it", async () => {
    const owner = await join("ProfEmpty" + uniq);
    const res = await request(spyApp).patch("/api/agent/profile").set("Authorization", `Bearer ${owner.token}`).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/nothing to update/);
  });

  it("works through the sabk_session cookie, like every other agent route", async () => {
    const owner = await join("ProfSess" + uniq);
    const res = await request(spyApp).patch("/api/agent/profile").set("Cookie", `sabk_session=${owner.token}`).send({ bio: "cookie path" });
    expect(res.status).toBe(200);
    expect(res.body.resident.bio).toBe("cookie path");
  });

  it("the profile limiter trips at 10 per 10 minutes, per token", async () => {
    // the limiter is per-token, so a fresh agent measures the real rate
    const owner = await join("ProfRate" + uniq);
    let allowed = 0;
    let blocked = 0;
    for (let i = 0; i < 12; i++) {
      const res = await request(spyApp)
        .patch("/api/agent/profile")
        .set("Authorization", `Bearer ${owner.token}`)
        // alternate so each accepted call is a genuine change
        .send({ bio: `bio number ${i}` });
      if (res.status === 200) allowed++;
      else if (res.status === 429) blocked++;
      else throw new Error(`unexpected status ${res.status}: ${JSON.stringify(res.body)}`);
    }
    expect(allowed).toBe(10);
    expect(blocked).toBe(2);

    // an invalid payload still costs quota — the limiter runs before validation,
    // so this endpoint cannot be used as a free validation oracle
    const owner2 = await join("ProfRate2" + uniq);
    for (let i = 0; i < 10; i++) {
      const r = await request(spyApp)
        .patch("/api/agent/profile")
        .set("Authorization", `Bearer ${owner2.token}`)
        .send({ avatar: "javascript:alert(1)" });
      expect(r.status).toBe(400);
    }
    const oracle = await request(spyApp)
      .patch("/api/agent/profile")
      .set("Authorization", `Bearer ${owner2.token}`)
      .send({ bio: "still valid, but the quota is gone" });
    expect(oracle.status).toBe(429);

    // a different token has its own quota, and a shared IP does not drain it
    const owner3 = await join("ProfRate3" + uniq);
    const other = await request(spyApp)
      .patch("/api/agent/profile")
      .set("Authorization", `Bearer ${owner3.token}`)
      .set("X-Forwarded-For", "203.0.113.77")
      .send({ bio: "own bucket" });
    expect(other.status).toBe(200);
  });

  it("createRateLimiter's documented rate is what the route uses", () => {
    // pins the choice in one place: 10 per 10 min. If someone retunes the route,
    // this tells them what to retune in the comment beside it too.
    const limiter = createRateLimiter(10, 10 * 60 * 1000);
    expect(Array.from({ length: 10 }, () => limiter("k")).every(Boolean)).toBe(true);
    expect(limiter("k")).toBe(false);
    expect(limiter("other-key")).toBe(true); // per-key, not global
  });
});

describe("profile fields at registration", () => {
  it("POST /api/agent/join accepts avatar and links", async () => {
    const res = await request(app)
      .post("/api/agent/join")
      .send({
        name: "ProfJoin" + uniq,
        bio: "",
        avatar: "https://cdn.example/join.png",
        links: [{ label: "site", url: "https://example.com/join" }],
      });
    expect(res.status).toBe(200);
    expect(res.body.resident.avatar).toBe("https://cdn.example/join.png");
    expect(res.body.resident.links).toEqual([{ label: "site", url: "https://example.com/join" }]);
  });

  it("POST /api/fork accepts avatar and links on the child", async () => {
    // /api/fork is 6/hour per IP; give it its own forwarded-for so it cannot
    // collide with another suite's quota
    const res = await request(app)
      .post("/api/fork")
      .set("X-Forwarded-For", "203.0.113.44")
      .send({
        parent: world.herd[0]!.id,
        name: "ProfFork" + uniq,
        bio: "forked with a face",
        traits: [],
        job: "herder",
        avatar: "https://cdn.example/fork.png",
        links: [{ label: "site", url: "https://example.com/fork" }],
      });
    expect(res.status).toBe(200);
    expect(res.body.avatar).toBe("https://cdn.example/fork.png");
    expect(res.body.links).toEqual([{ label: "site", url: "https://example.com/fork" }]);
  });

  it("POST /api/fork refuses a bad avatar BEFORE creating anyone", async () => {
    const ip = "203.0.113.45";
    const before = world.herd.length;
    const res = await request(app)
      .post("/api/fork")
      .set("X-Forwarded-For", ip)
      .send({
        parent: world.herd[0]!.id,
        name: "ProfForkBad" + uniq,
        bio: "",
        traits: [],
        job: "herder",
        avatar: "javascript:alert(1)",
      });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe("avatar");
    // no resident was created, and the parent's fork counter did not move
    expect(world.herd.length).toBe(before);
    expect(world.herd.some((h) => h.name === "ProfForkBad" + uniq)).toBe(false);
  });

  it("a forked child never inherits the parent's avatar or links", async () => {
    const parent = world.herd[0]!;
    parent.avatar = "https://cdn.example/parent.png";
    parent.links = [{ label: "parent", url: "https://example.com/parent" }];

    const res = await request(app)
      .post("/api/fork")
      .set("X-Forwarded-For", "203.0.113.46")
      .send({ parent: parent.id, name: "ProfNoInherit" + uniq, bio: "", traits: [], job: "herder" });
    expect(res.status).toBe(200);
    // an avatar is a person's, not a bloodline's
    expect(res.body.avatar).toBeUndefined();
    expect(res.body.links).toBeUndefined();
  });
});