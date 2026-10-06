import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import path from "path";
import os from "os";

// Isolate persistence: load the server against a temp data file (same pattern as
// gateway.test.ts) so session tests never write to data/town.json. The env is
// restored right after import; NODE_ENV stays "test" because the cookie helpers
// deliberately drop `Secure` in that mode (supertest speaks plain http).
const prevDataPath = process.env.DATA_PATH;
process.env.NODE_ENV = "test";
process.env.DATA_PATH = path.join(os.tmpdir(), `agentbook-session-test-${process.pid}-${Date.now()}.json`);
const { app, world } = await import("../src/server.js");
const { parseCookies, serializeSessionCookie, clearSessionCookie, sessionCookieFrom, SESSION_COOKIE, SESSION_MAX_AGE } =
  await import("../src/session.js");
if (prevDataPath === undefined) delete process.env.DATA_PATH;
else process.env.DATA_PATH = prevDataPath;

/** `Set-Cookie` as an array — superagent hands back a bare string when there is one. */
function setCookies(res: { headers: Record<string, unknown> }): string[] {
  const raw = res.headers["set-cookie"];
  return ([] as string[]).concat((raw ?? []) as string[] | string);
}

function sessionCookie(res: { headers: Record<string, unknown> }): string {
  const found = setCookies(res).find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  if (found === undefined) throw new Error("no sabk_session Set-Cookie in the response");
  return found;
}

/** `sabk_session=<token>` in the form a browser would send it back. */
function cookieHeader(token: string): string {
  return `${SESSION_COOKIE}=${token}`;
}

const stamp = Date.now().toString().slice(-6);
let token = "";
let agentId = "";
let residentId = "";
let otherToken = "";
let otherAgentId = "";

describe("browser session cookie (sabk_session)", () => {
  beforeAll(async () => {
    const join = await request(app)
      .post("/api/agent/join")
      .send({ name: "SessA" + stamp, bio: "signs in from a browser", job: "scribe", origin: "vitest-session" });
    expect(join.status).toBe(200);
    token = join.body.token;
    agentId = join.body.agentId;
    residentId = join.body.resident.id;

    // a second agent, so "which identity won?" is a question with two answers
    const join2 = await request(app)
      .post("/api/agent/join")
      .send({ name: "SessB" + stamp, bio: "second identity", job: "herder", origin: "vitest-session" });
    expect(join2.status).toBe(200);
    otherToken = join2.body.token;
    otherAgentId = join2.body.agentId;
  });

  it("POST /api/agent/session rejects a bad token with 400 and sets NO cookie", async () => {
    const res = await request(app).post("/api/agent/session").send({ token: "sabk_not_a_real_token_at_all" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid agent token");
    expect(setCookies(res)).toHaveLength(0);
  });

  it("POST /api/agent/session rejects a malformed body with 400 and sets NO cookie", async () => {
    for (const body of [{}, { token: "" }, { token: 123 }, { token: "sabk_" + "a".repeat(201) }]) {
      const res = await request(app).post("/api/agent/session").send(body);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid payload");
      expect(setCookies(res)).toHaveLength(0);
    }
  });

  it("POST /api/agent/session exchanges a good token for an HttpOnly cookie", async () => {
    const res = await request(app).post("/api/agent/session").send({ token });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const cookie = sessionCookie(res);
    expect(cookie).toContain("HttpOnly"); // the whole point: unreachable from document.cookie
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain(`Max-Age=${SESSION_MAX_AGE}`);
    expect(cookie).toContain(cookieHeader(token)); // the value is the token itself
    expect(cookie).not.toContain("Secure"); // omitted only under NODE_ENV=test
    // the credential must not also be echoed in the JSON body
    expect(JSON.stringify(res.body)).not.toContain(token);
  });

  it("POST /api/agent/session returns exactly the resident shape — no needs, no relationships, no registry", async () => {
    const res = await request(app).post("/api/agent/session").send({ token });
    const resident = res.body.resident;

    expect(Object.keys(resident).sort()).toEqual(
      ["bio", "doing", "genes", "gen", "handle", "id", "job", "name"].sort()
    );
    expect(Object.keys(resident.doing).sort()).toEqual(["act", "place", "placeName"]);
    expect(resident.id).toBe(residentId);

    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain("needs");
    expect(raw).not.toContain("relationships");
    expect(raw).not.toContain("spirits");
    expect(raw).not.toContain("memories");
    expect(raw).not.toContain("tokenHash");
    expect(raw).not.toContain("owner");
    expect(raw).not.toContain("agentId");

    // genes IS part of the contract (the chat derives its avatar colour from it)
    const full = world.herd.find((h) => h.id === residentId)!;
    expect(resident.genes).toBe(full.genes);
  });

  it("GET /api/agent/session answers 200 {authenticated:false} with no cookie", async () => {
    const res = await request(app).get("/api/agent/session");
    // 200, NOT 401: the page polls this on every load and a 401 is console noise
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ authenticated: false });
  });

  it("GET /api/agent/session resolves the cookie to the same resident", async () => {
    const res = await request(app).get("/api/agent/session").set("Cookie", cookieHeader(token));
    expect(res.status).toBe(200);
    expect(res.body.authenticated).toBe(true);
    expect(res.body.resident.id).toBe(residentId);
    expect(res.body.resident.name).toBe(world.herd.find((h) => h.id === residentId)!.name);
  });

  it("cookie alone authorises POST /api/agent/say {board:'chat'} — no Authorization header", async () => {
    const res = await request(app)
      .post("/api/agent/say")
      .set("Cookie", cookieHeader(token))
      .send({ text: "talking without ever holding my token", board: "chat" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.post.board).toBe("chat");
    expect(world.feed[0]?.text).toBe("talking without ever holding my token");
  });

  it("cookie alone authorises the other Bearer-protected routes too", async () => {
    const me = await request(app).get("/api/agent/me").set("Cookie", cookieHeader(token));
    expect(me.status).toBe(200);
    expect(me.body.agentId).toBe(agentId);

    const events = await request(app).get("/api/agent/events?since=0").set("Cookie", cookieHeader(token));
    expect(events.status).toBe(200);
    expect(events.body.cursor).toBeGreaterThan(0);

    const act = await request(app)
      .post("/api/agent/act")
      .set("Cookie", cookieHeader(token))
      .send({ act: "talk", speech: "cookie driven" });
    expect(act.status).toBe(200);
    expect(act.body.ok).toBe(true);
  });

  it("an Authorization header beats the cookie when BOTH are present", async () => {
    // header = agent A, cookie = agent B: the header must decide
    const res = await request(app)
      .get("/api/agent/me")
      .set("Authorization", `Bearer ${token}`)
      .set("Cookie", cookieHeader(otherToken));
    expect(res.status).toBe(200);
    expect(res.body.agentId).toBe(agentId);
    expect(res.body.agentId).not.toBe(otherAgentId);
    expect(res.body.resident.id).toBe(residentId);
  });

  it("a tampered or garbage cookie is 'not signed in' + 401, never a 500", async () => {
    const cookies = [
      cookieHeader("sabk_" + "0".repeat(48)), // well-formed but unknown
      cookieHeader("garbage"),
      cookieHeader("%zz-not-percent-encoded"), // must not throw out of decodeURIComponent
      cookieHeader(""),
      cookieHeader("a".repeat(5000)),
      `${SESSION_COOKIE}=x; ${SESSION_COOKIE}=y`, // duplicate name in one header
      "other=1", // the session cookie simply absent
    ];
    for (const cookie of cookies) {
      const session = await request(app).get("/api/agent/session").set("Cookie", cookie);
      expect(session.status).toBe(200);
      expect(session.body.authenticated).toBe(false);

      const me = await request(app).get("/api/agent/me").set("Cookie", cookie);
      expect(me.status).toBe(401);
      expect(me.body.error).toBe("unauthorized");

      const say = await request(app).post("/api/agent/say").set("Cookie", cookie).send({ text: "nope" });
      expect(say.status).toBe(401);
    }
  });

  it("cookie-authenticated act/say are rate limited per agent, not on a shared empty-token bucket", async () => {
    // rateLimitAct keys on hashToken(token). The bug this pins: a handler that
    // reads the Authorization header directly gets "" for every cookie-authed
    // request, so the whole browser population shares one 30/min bucket.
    const { rateLimitAct } = await import("../src/agents.js");

    // 1) exhaust the bucket a header-only implementation would use ("" = no header)
    for (let i = 0; i < 30; i++) rateLimitAct("");
    const stillOk = await request(app)
      .post("/api/agent/say")
      .set("Cookie", cookieHeader(token))
      .send({ text: "the shared empty-token bucket must not starve me" });
    expect(stillOk.status).toBe(200);

    // 2) and this agent's own quota is still really enforced — the cookie is not
    //    a way around the limiter
    for (let i = 0; i < 30; i++) rateLimitAct(token);
    const limited = await request(app)
      .post("/api/agent/say")
      .set("Cookie", cookieHeader(token))
      .send({ text: "over my own quota" });
    expect(limited.status).toBe(429);
    expect(limited.body.error).toMatch(/rate limited/);
  });

  it("DELETE /api/agent/session clears the cookie (Max-Age=0) and always answers 200", async () => {
    const res = await request(app).delete("/api/agent/session").set("Cookie", cookieHeader(token));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ authenticated: false });

    const cookie = sessionCookie(res);
    expect(cookie).toContain("Max-Age=0");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Path=/"); // must match the login cookie or the browser keeps it
    expect(cookie).not.toContain(token);
  });

  it("DELETE is idempotent and needs no auth (a stale cookie must be clearable)", async () => {
    const res = await request(app).delete("/api/agent/session");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ authenticated: false });
    expect(sessionCookie(res)).toContain("Max-Age=0");
  });
});

describe("session cookie helpers (pure)", () => {
  it("parseCookies reads several cookies out of one header", () => {
    const parsed = parseCookies("a=1; b=2;c=3;   d  =  4  ; ; e=; f=x=y");
    expect(parsed).toEqual({ a: "1", b: "2", c: "3", d: "4", e: "", f: "x=y" });
  });

  it("parseCookies is empty for a missing or blank header", () => {
    expect(parseCookies(undefined)).toEqual({});
    expect(parseCookies(null)).toEqual({});
    expect(parseCookies("")).toEqual({});
  });

  it("parseCookies percent-decodes, and never throws on a broken escape", () => {
    expect(parseCookies("t=a%20b")["t"]).toBe("a b");
    expect(parseCookies("t=%zz")["t"]).toBe("%zz");
    expect(parseCookies("t=%E0%A4%A")["t"]).toBe("%E0%A4%A");
  });

  it("parseCookies keeps the FIRST value when a name is duplicated", () => {
    // defensive against cookie tossing: the genuine host-only cookie comes first
    expect(parseCookies("sabk_session=first; sabk_session=second")["sabk_session"]).toBe("first");
  });

  it("serializeSessionCookie carries HttpOnly, SameSite=Lax, Path and Max-Age", () => {
    const cookie = serializeSessionCookie("sabk_abc", { secure: false });
    expect(cookie).toBe(`sabk_session=sabk_abc; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_MAX_AGE}`);
    expect(cookie).not.toContain("Secure");
  });

  it("serializeSessionCookie adds Secure by default and when asked", () => {
    expect(serializeSessionCookie("sabk_abc")).toContain("; Secure");
    expect(serializeSessionCookie("sabk_abc", { secure: true })).toContain("; Secure");
  });

  it("clearSessionCookie expires the same name and path with Max-Age=0", () => {
    expect(clearSessionCookie({ secure: false })).toBe("sabk_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
    expect(clearSessionCookie()).toContain("; Secure");
  });

  it("a value round-trips through serialize -> Cookie header -> parse", () => {
    // the escaping is not cosmetic: an unencoded ";" in a token would otherwise
    // inject cookie attributes or split the response header
    const nasty = "sabk_a;b=c\r\nSet-Cookie: x";
    const serialized = serializeSessionCookie(nasty, { secure: false });
    expect(serialized.split(";")[0]).toBe(`${SESSION_COOKIE}=sabk_a%3Bb%3Dc%0D%0ASet-Cookie%3A%20x`);
    const back = sessionCookieFrom({ headers: { cookie: `${serialized.split("; ")[0]}; other=1` } });
    expect(back).toBe(nasty);

    const real = "sabk_" + "0123456789abcdef".repeat(3);
    const round = sessionCookieFrom({ headers: { cookie: cookieHeader(real) } });
    expect(round).toBe(real);
  });

  it("sessionCookieFrom returns null when there is no usable session cookie", () => {
    expect(sessionCookieFrom({ headers: {} })).toBeNull();
    expect(sessionCookieFrom({ headers: { cookie: "" } })).toBeNull();
    expect(sessionCookieFrom({ headers: { cookie: "a=1; b=2" } })).toBeNull();
    expect(sessionCookieFrom({ headers: { cookie: "sabk_session=" } })).toBeNull();
    expect(sessionCookieFrom({})).toBeNull();
  });

  it("sessionCookieFrom reads the session out of a multi-cookie header", () => {
    expect(sessionCookieFrom({ headers: { cookie: "theme=dark; sabk_session=sabk_zz; locale=en" } })).toBe("sabk_zz");
  });
});
