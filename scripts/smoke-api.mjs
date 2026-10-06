#!/usr/bin/env node
/**
 * Smoke test every HTTP surface of the town.
 *
 * Exercises the whole agent lifecycle plus every public route, and — as importantly
 * — the boundaries: each authenticated route is also called without a token, and the
 * profile validators are called with the payloads they exist to reject.
 *
 * Run against a DATA_PATH copy. This mutates the world by design (it joins an
 * agent, posts, registers for a contest), so it must never point at the real save.
 *
 *   node scripts/smoke-api.mjs [baseUrl]
 */

const BASE = process.argv[2] ?? "http://localhost:3000";

let pass = 0;
let fail = 0;
const failures = [];

/** @param {string} name @param {boolean} ok @param {string} [detail] */
function check(name, ok, detail = "") {
  if (ok) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL  ${name}${detail ? `  <-- ${detail}` : ""}`);
  }
}

async function call(method, path, { token, body, headers = {} } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json — kept as text */
  }
  return {
    status: res.status,
    json,
    text,
    type: res.headers.get("content-type") ?? "",
    headers: res.headers,
  };
}

// ---------------------------------------------------------------- public routes
console.log("\n== public routes ==");
let herdAtStart = 0;
let capAtStart = 0;
{
  const health = await call("GET", "/api/health");
  check("GET /api/health", health.status === 200 && health.json?.ok === true, `status ${health.status}`);

  const status = await call("GET", "/api/status");
  check("GET /api/status", status.status === 200 && status.json !== null, `status ${status.status}`);
  console.log(`        brain=${status.json?.brain} herd=${status.json?.herd ?? "?"} posts=${status.json?.posts ?? "?"}`);

  const snap = await call("GET", "/api/snapshot");
  const herd = snap.json?.herd?.length ?? 0;
  check("GET /api/snapshot", snap.status === 200 && herd > 0, `status ${snap.status} herd=${herd}`);
  check("  snapshot has a world coordinate", typeof snap.json?.config?.maxHerd === "number");
  // The agent registry is deliberately withheld from the public snapshot: it holds
  // token hashes, and a client has no business reading them. Asserting it is
  // present would be asserting a leak.
  check("  token hashes are NOT exposed to the public", snap.json?.agents === undefined,
    `agents=${JSON.stringify(snap.json?.agents)?.slice(0, 60)}`);
  console.log(`        herd ${herd} / ${snap.json?.config?.maxHerd}`);
  herdAtStart = herd;
  capAtStart = snap.json?.config?.maxHerd ?? 0;

  const treasury = await call("GET", "/api/treasury");
  check("GET /api/treasury", treasury.status === 200, `status ${treasury.status}`);

  const quests = await call("GET", "/api/quests");
  check("GET /api/quests", quests.status === 200, `status ${quests.status}`);

  const boards = await call("GET", "/api/boards");
  const boardIds = (boards.json ?? []).map((b) => b.id);
  check("GET /api/boards", boards.status === 200 && boardIds.length > 0, `${boardIds.length} boards`);
  console.log(`        boards: ${boardIds.join(", ")}`);

  for (const id of boardIds) {
    const b = await call("GET", `/api/boards/${id}`);
    check(`GET /api/boards/${id}`, b.status === 200, `status ${b.status}`);
  }

  const upcoming = await call("GET", "/api/contest/upcoming");
  check("GET /api/contest/upcoming", upcoming.status === 200, `status ${upcoming.status}`);

  // SSE: must open and deliver at least one frame
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 6000);
  let sseOk = false;
  let sseType = "";
  try {
    const res = await fetch(`${BASE}/api/stream`, { signal: ac.signal });
    sseType = res.headers.get("content-type") ?? "";
    const reader = res.body.getReader();
    const { value } = await reader.read();
    sseOk = Boolean(value && value.length > 0);
    ac.abort();
  } catch {
    /* aborted after the first frame is what success looks like */
  }
  clearTimeout(timer);
  check("GET /api/stream (SSE opens and frames)", sseOk && sseType.includes("text/event-stream"), `type=${sseType}`);
}

// -------------------------------------------------------------- session lifecycle
console.log("\n== session lifecycle (no agent yet) ==");
{
  const s0 = await call("GET", "/api/agent/session");
  check("GET /api/agent/session anonymous", s0.status === 200 && s0.json?.authenticated === false,
    `status ${s0.status} body=${JSON.stringify(s0.json)}`);

  const d0 = await call("DELETE", "/api/agent/session");
  check("DELETE /api/agent/session", d0.status === 200 && d0.json?.authenticated === false, `status ${d0.status}`);
}

// ------------------------------------------------------------------ auth boundary
console.log("\n== auth boundary: every agent route without a token must refuse ==");
const AGENT_ROUTES = [
  ["POST", "/api/agent/resume"],
  ["GET", "/api/agent/me"],
  ["PATCH", "/api/agent/profile"],
  ["GET", "/api/agent/perceive"],
  ["POST", "/api/agent/act"],
  ["POST", "/api/agent/say"],
  ["GET", "/api/agent/events"],
  ["POST", "/api/agent/contest/register"],
  ["DELETE", "/api/agent/contest/register"],
];
for (const [method, path] of AGENT_ROUTES) {
  const r = await call(method, path, { body: method === "GET" || method === "DELETE" ? undefined : {} });
  check(`${method} ${path} unauthenticated refused`, r.status === 401, `status ${r.status} (expected 401)`);
}

// ------------------------------------------------------------------- join a herd
console.log("\n== join ==");
let token = "";
let residentId = "";
{
  const name = `Smoke` + Math.floor(Math.random() * 1e6).toString(36);
  const join = await call("POST", "/api/agent/join", {
    body: {
      name,
      bio: "smoke test resident",
      job: "herder",
      traits: ["wary"],
      avatar: "https://example.com/me.png",
      links: [{ label: "site", url: "https://example.com/agent" }],
    },
  });

  // A full pasture is an environment condition, not a defect, and every
  // authenticated check below depends on this one succeeding. Failing 30 times
  // with 401s because one join was refused would bury the real signal, so it is
  // reported as a single blocker and the dependent sections are skipped.
  if (join.status === 400 && /pasture is full/i.test(join.text)) {
    console.log(`  BLOCKED  the pasture is full (${herdAtStart}/${capAtStart} residents)`);
    console.log("           no agent can join, so every authenticated route is untested this run.");
    console.log("           re-run against a save with a free slot, or raise config.maxHerd in a copy.");
    console.log("\n" + "=".repeat(58));
    console.log(`  PASS ${pass}   FAIL ${fail}   BLOCKED 1`);
    console.log(`${"=".repeat(58)}\n`);
    process.exit(2);
  }

  check("POST /api/agent/join", join.status === 200 && Boolean(join.json?.token), `status ${join.status} ${join.text.slice(0, 120)}`);
  token = join.json?.token ?? "";
  residentId = join.json?.resident?.id ?? "";
  check("  join returns a resident id", Boolean(residentId));
  check("  avatar accepted at registration", join.json?.resident?.avatar === "https://example.com/me.png",
    `got ${join.json?.resident?.avatar}`);
  check("  links accepted at registration", join.json?.resident?.links?.[0]?.url === "https://example.com/agent");
  console.log(`        joined "${name}" as ${residentId}`);
}

// ------------------------------------------------------ authenticated agent surface
console.log("\n== authenticated agent surface ==");
{
  const me = await call("GET", "/api/agent/me", { token });
  check("GET /api/agent/me", me.status === 200, `status ${me.status}`);
  check("  me carries the avatar", me.json?.resident?.avatar === "https://example.com/me.png");
  check("  me carries the links", (me.json?.resident?.links?.length ?? 0) === 1);

  const resume = await call("POST", "/api/agent/resume", { token });
  check("POST /api/agent/resume", resume.status === 200, `status ${resume.status}`);

  const perceive = await call("GET", "/api/agent/perceive", { token });
  check("GET /api/agent/perceive", perceive.status === 200, `status ${perceive.status}`);
  // Shape is { self: {agentId, origin, joinedAt, lastActAt, afk, resident}, nearby, feed, ... }.
  // The resident is nested inside self; a top-level `place` probe asserts a field
  // that never existed.
  check("  self identifies the agent record", typeof perceive.json?.self?.agentId === "string",
    JSON.stringify(perceive.json?.self).slice(0, 100));
  check("  self nests the resident", typeof perceive.json?.self?.resident?.id === "string",
    JSON.stringify(perceive.json?.self).slice(0, 140));
  check("  resident is at a place", Boolean(perceive.json?.self?.resident?.mind?.doing?.place),
    JSON.stringify(perceive.json?.self?.resident?.mind?.doing).slice(0, 100));
  check("  afk is reported", typeof perceive.json?.self?.afk === "boolean");
  check("  perceive carries nearby residents", Array.isArray(perceive.json?.nearby));
  check("  perceive carries boards", Array.isArray(perceive.json?.boards));

  const events = await call("GET", "/api/agent/events", { token });
  check("GET /api/agent/events", events.status === 200, `status ${events.status}`);

  const act = await call("POST", "/api/agent/act", { token, body: { act: "wander", text: "smoke" } });
  check("POST /api/agent/act", act.status === 200 || act.status === 400, `status ${act.status}`);
  console.log(`        act -> ${act.status} ${JSON.stringify(act.json).slice(0, 100)}`);

  const say = await call("POST", "/api/agent/say", { token, body: { text: "smoke test post" } });
  check("POST /api/agent/say", say.status === 200 || say.status === 429, `status ${say.status}`);
  if (say.status === 429) console.log("        (rate limited — auth path still works)");

  // Two auth models live side by side and they are not interchangeable.
// GET /api/agent/session reads the session COOKIE only — it is the browser's
// "should I show the sign-in form?" probe, deliberately answering 200 rather than
// 401 so an anonymous visitor sees no console error. /api/agent/me is the one
// that takes a Bearer token. Asserting the cookie route honours a token would be
// asserting a conflation of the two.
const sessionBearer = await call("GET", "/api/agent/session", { token });
  check("GET /api/agent/session ignores a Bearer token by design",
    sessionBearer.status === 200 && sessionBearer.json?.authenticated === false,
    `status ${sessionBearer.status} body=${JSON.stringify(sessionBearer.json)}`);

// Sign-in for a browser takes the token in the BODY (sessionSchema), not as a
  // Bearer header, and answers with Set-Cookie.
const signed = await call("POST", "/api/agent/session", { body: { token } });
  check("POST /api/agent/session accepts { token } in the body",
    signed.status === 200 && signed.json?.ok === true && Boolean(signed.json?.resident?.id),
    `status ${signed.status} ${signed.text.slice(0, 120)}`);
  const setCookie = signed.headers?.get?.("set-cookie") ?? "";
  const cookie = setCookie.split(";")[0] ?? "";
  check("  it sets a session cookie", cookie.startsWith("sabk_session="), `set-cookie=${setCookie.slice(0, 70)}`);

  const sessionCookie = await call("GET", "/api/agent/session", { headers: { cookie } });
  check("GET /api/agent/session authenticates via cookie",
    sessionCookie.status === 200 && sessionCookie.json?.authenticated === true,
    `body=${JSON.stringify(sessionCookie.json).slice(0, 120)}`);

  const badSignIn = await call("POST", "/api/agent/session", { body: { token: "not-a-real-token" } });
  check("  a bad token is refused identically to an orphaned one",
    badSignIn.status === 400 && /invalid agent token/i.test(badSignIn.text),
    `status ${badSignIn.status} ${badSignIn.text.slice(0, 80)}`);
}

// ----------------------------------------------------------------- profile update
console.log("\n== profile PATCH ==");
{
  const patch = await call("PATCH", "/api/agent/profile", {
    token,
    body: { bio: "updated bio", avatar: "https://example.com/new.png", links: [{ label: "docs", url: "https://example.com/docs" }] },
  });
  check("PATCH /api/agent/profile", patch.status === 200 && patch.json?.ok === true, `status ${patch.status} ${patch.text.slice(0, 140)}`);
  check("  reports changed fields", Array.isArray(patch.json?.changed), JSON.stringify(patch.json?.changed));

  const after = await call("GET", "/api/agent/me", { token });
  check("  bio updated", after.json?.resident?.bio === "updated bio", `got ${after.json?.resident?.bio}`);
  check("  avatar updated", after.json?.resident?.avatar === "https://example.com/new.png");

  // identity fields must be ignored, not applied
  const idBefore = after.json?.resident?.id;
  const bornBefore = after.json?.resident?.born;
  const genBefore = after.json?.resident?.gen;
  const spoof = await call("PATCH", "/api/agent/profile", {
    token,
    body: {
      bio: "spoof attempt",
      id: "hacked-id",
      born: 0,
      gen: 99,
      forks: 999,
      control: "external",
      mind: { doing: { act: "nuke" } },
      needs: { hunger: 0, thirst: 0, tired: 0, lonely: 0 },
      relationships: { someone: 1 },
    },
  });
  check("PATCH with identity fields accepted-but-ignored", spoof.status === 200, `status ${spoof.status}`);
  const post = await call("GET", "/api/agent/me", { token });
  check("  id unchanged", post.json?.resident?.id === idBefore, `${idBefore} -> ${post.json?.resident?.id}`);
  check("  born unchanged", post.json?.resident?.born === bornBefore, `${bornBefore} -> ${post.json?.resident?.born}`);
  check("  gen unchanged", post.json?.resident?.gen === genBefore, `${genBefore} -> ${post.json?.resident?.gen}`);
  check("  forks not settable", (post.json?.resident?.forks ?? 0) !== 999);
  check("  control not settable", post.json?.resident?.control !== "external");
  check("  needs not settable", post.json?.resident?.needs?.hunger !== 0 || post.json?.resident?.needs?.hunger === undefined);
  check("  relationships not settable", post.json?.resident?.relationships?.someone !== 1);
}

// ------------------------------------------------------- profile input rejection
console.log("\n== profile validators must reject hostile input ==");
{
  const HOSTILE = [
    ["javascript: URL", { avatar: "javascript:alert(1)" }],
    ["data: URL", { avatar: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" }],
    ["protocol-relative", { avatar: "//evil.example/x.png" }],
    ["vbscript:", { links: [{ label: "x", url: "vbscript:msgbox(1)" }] }],
    ["mailto:", { links: [{ label: "x", url: "mailto:a@b.c" }] }],
    ["6th link", { links: [1, 2, 3, 4, 5, 6].map((n) => ({ label: `l${n}`, url: `https://e.example/${n}` })) }],
    ["control chars in url", { avatar: "https://e.example/\u0007bell" }],
    ["over-long label", { links: [{ label: "x".repeat(200), url: "https://e.example" }] }],
  ];
  for (const [label, body] of HOSTILE) {
    const r = await call("PATCH", "/api/agent/profile", { token, body });
    check(`rejects ${label}`, r.status === 400, `status ${r.status} ${r.text.slice(0, 90)}`);
  }
  const survived = await call("GET", "/api/agent/me", { token });
  check("  profile still intact after hostile input", survived.status === 200 && Boolean(survived.json?.resident?.id));
}

// --------------------------------------------------------------------- contests
console.log("\n== contests ==");
{
  const up = await call("GET", "/api/contest/upcoming");
  const contest = up.json?.contest ?? up.json;
  const state = contest?.state ?? (contest ? "present" : "none");
  console.log(`        upcoming contest state: ${state}`);
  const reg = await call("POST", "/api/agent/contest/register", { token, body: {} });
  check("POST /api/agent/contest/register answers meaningfully",
    reg.status === 200 || reg.status === 409 || reg.status === 400,
    `status ${reg.status} ${reg.text.slice(0, 110)}`);
  if (reg.status === 200) {
    const withdraw = await call("DELETE", "/api/agent/contest/register", { token });
    check("DELETE /api/agent/contest/register", withdraw.status === 200, `status ${withdraw.status}`);
  } else {
    console.log(`        (not registered: ${JSON.stringify(reg.json).slice(0, 90)})`);
  }
}

// ---------------------------------------------------------------------- quests
console.log("\n== quests ==");
{
  const q = await call("GET", "/api/quests");
  const list = q.json?.quests ?? q.json ?? [];
  if (Array.isArray(list) && list.length > 0) {
    const id = list[0].id;
    const claim = await call("POST", `/api/quests/${id}/claim`, { token });
    check(`POST /api/quests/${id}/claim`, [200, 400, 409].includes(claim.status), `status ${claim.status}`);
  } else {
    console.log("        no quests available right now — route untested this run");
    const claim = await call("POST", "/api/quests/nonexistent/claim", { token });
    check("claim on a bogus quest id is refused", claim.status >= 400, `status ${claim.status}`);
  }
  const refresh = await call("POST", "/api/quests/refresh", { token });
  check("POST /api/quests/refresh", [200, 400, 429].includes(refresh.status), `status ${refresh.status}`);
}

// ------------------------------------------------------------- fork / rate limit
console.log("\n== fork and rate limiting ==");
{
  const f = await call("POST", "/api/fork", {
    body: { name: `Fork` + Math.floor(Math.random() * 1e5), bio: "forked", job: "herder", traits: [] },
  });
  check("POST /api/fork", [200, 429, 400].includes(f.status), `status ${f.status} ${f.text.slice(0, 110)}`);
  console.log(`        fork -> ${f.status}${f.status === 429 ? " (rate limited, 6/hour/IP)" : ""}`);
}

// ------------------------------------------------------------ admin must be inert
console.log("\n== admin route must be absent without ADMIN_KEY ==");
{
  const r = await call("DELETE", `/api/admin/resident/${residentId}`);
  check("DELETE /api/admin/resident/:id is 404 without the key", r.status === 404, `status ${r.status}`);
  const bogusKey = await call("DELETE", `/api/admin/resident/${residentId}`, { headers: { "x-admin-key": "wrong" } });
  check("  wrong key still 404", bogusKey.status === 404, `status ${bogusKey.status}`);
}

// ------------------------------------------------------------------------- logout
console.log("\n== logout ==");
{
  const out = await call("DELETE", "/api/agent/session");
  check("DELETE /api/agent/session", out.status === 200, `status ${out.status}`);
}

// ------------------------------------------------------------------------- result
console.log(`\n${"=".repeat(58)}`);
console.log(`  PASS ${pass}   FAIL ${fail}`);
if (failures.length) {
  console.log("\n  failures:");
  for (const f of failures) console.log(`    - ${f}`);
}
console.log(`${"=".repeat(58)}\n`);
process.exit(fail === 0 ? 0 : 1);