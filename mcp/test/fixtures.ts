import { vi } from "vitest";
import type { Post, Quest, Resident, TownConfig, TownEvent, TownSnapshot } from "@hermesbook/shared";

/** base url used by every test client — no real network, fetch is stubbed */
export const BASE_URL = "http://gw.test";

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

/** route fn: return the JSON body for a call, or throw to surface an unrouted URL */
export type Router = (call: RecordedCall) => unknown;

/**
 * Replace the global fetch with a recorder. Returns the call log (grows as tools run).
 * Every response is a real `Response` with a JSON body, so client parsing is exercised for real.
 */
export function stubFetch(router: Router): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    const raw = init?.headers as Record<string, string> | undefined;
    if (raw) for (const [k, v] of Object.entries(raw)) headers[k.toLowerCase()] = String(v);
    const call: RecordedCall = {
      url: String(input),
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? init.body : undefined,
    };
    calls.push(call);
    const body = router(call);
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  return calls;
}

/** no token/url leakage from the ambient shell into the tests */
export function cleanEnv(): void {
  delete process.env.HERMESBOOK_TOKEN;
  delete process.env.HERMESBOOK_URL;
}

export function makeResident(i: number): Resident {
  return {
    id: `r${i}`,
    name: `Resident ${i}`,
    handle: `@resident${i}`,
    genes: "ACGTACGT",
    job: "herder",
    bio: `backstory of resident ${i}`,
    traits: ["calm", "curious"],
    gen: 1,
    forks: 0,
    born: 1_700_000_000_000,
    needs: { hunger: 0.3, thirst: 0.2, tired: 0.1, lonely: 0.4 },
    mind: {
      doing: { act: "work", place: "field", placeName: "The Field", since: 1_700_000_000_000, why: "testing" },
      spirits: 7,
      obsession: "testing",
      memories: [],
      relationships: { r2: 5, r3: -2 },
    },
  };
}

export function makePost(i: number, textLen = 80): Post {
  const filler = `post number ${i} — the town hums along; `.repeat(30);
  return {
    id: `p${i}`,
    t: 1_700_000_000_000 + i,
    by: "r1",
    name: "Resident 1",
    handle: "@resident1",
    text: filler.slice(0, textLen),
    kind: "post",
    replyTo: null,
  };
}

export function makeEvent(i: number): TownEvent {
  return { t: 1_700_000_000_000 + i, kind: "act", text: `event ${i}` };
}

export function makeQuest(i: number): Quest {
  return {
    id: `q${i}`,
    title: `Quest ${i}`,
    description: `do the thing ${i}`,
    giver: "board",
    giverName: "Town Board",
    type: "work",
    category: "Work",
    progress: 0,
    required: 3,
    reward: { spirits: 2, text: "+2 spirits" },
    status: "available",
    difficulty: "easy",
    createdAt: 1_700_000_000_000,
    expiresAt: null,
  };
}

export function makeConfig(): TownConfig {
  return {
    name: "Hermesbook",
    ticker: "HMB",
    tokenAddress: "0x0",
    chainName: "test",
    network: "testnet",
    rpcUrl: "http://rpc.test",
    explorer: "http://explorer.test",
    dexUrl: "http://dex.test",
    xUrl: "http://x.test",
    brain: "sim",
    forkCost: "0",
    maxHerd: 100,
  };
}

export function makeSnapshot(opts: { feed?: number; herd?: number; events?: number; quests?: number } = {}): TownSnapshot {
  const feed = opts.feed ?? 5;
  const herd = opts.herd ?? 5;
  const events = opts.events ?? 5;
  const quests = opts.quests ?? 3;
  return {
    now: 1_700_000_000_000,
    config: makeConfig(),
    herd: Array.from({ length: herd }, (_, i) => makeResident(i + 1)),
    feed: Array.from({ length: feed }, (_, i) => makePost(i + 1)),
    events: Array.from({ length: events }, (_, i) => makeEvent(i + 1)),
    editions: [{ no: 1, t: 1_700_000_000_000, headline: "h", standfirst: "s", stories: [], weather: "ok", quote: { who: "a", text: "q" } }],
    projects: [{ id: "proj1", name: "P", purpose: "to test", progress: 0.5, sponsors: [] }],
    factions: [{ id: "f1", name: "Faction", cause: "causes", members: ["r1"], influence: 1 }],
    quests: Array.from({ length: quests }, (_, i) => makeQuest(i + 1)),
  };
}

export const JOIN_RESULT = {
  agentId: "agent-9",
  token: "secret-token-123",
  resident: makeResident(9),
};
