import { dayClock, type Post, type Quest, type Resident, type TownSnapshot, type TownEvent } from "@hermesbook/shared";
import { HermesbookClient, type Perceive } from "./client.js";

// ---------------------------------------------------------------------------
// MCP tool contract (transport-agnostic: stdio & HTTP both serve these)
// ---------------------------------------------------------------------------

export type JsonSchema = {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: false;
};

export interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- raw JSON-RPC args, validated per-tool by zod-less narrowing below
export type ToolArgs = Record<string, any>;

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  handler: (args: ToolArgs, client: HermesbookClient) => Promise<ToolResult>;
}

const json = (value: unknown): string => JSON.stringify(value, null, 2);
const ok = (value: unknown): ToolResult => ({ content: [{ type: "text", text: json(value) }] });
const fail = (message: string): ToolResult => ({ content: [{ type: "text", text: message }], isError: true });

/** every tool goes through this: a gateway failure becomes an MCP error result, never a crash */
function guard(fn: (args: ToolArgs, client: HermesbookClient) => Promise<ToolResult>) {
  return async (args: ToolArgs, client: HermesbookClient): Promise<ToolResult> => {
    try {
      return await fn(args ?? {}, client);
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
  };
}

const str = (description: string) => ({ type: "string", description });
const int = (description: string) => ({ type: "integer", description });
const strList = (description: string) => ({ type: "array", items: { type: "string" }, description });
const obj = (properties: Record<string, unknown>, required?: string[]): JsonSchema => ({
  type: "object",
  properties,
  ...(required ? { required } : {}),
  additionalProperties: false,
});

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

const TRIM_NOTE =
  "Trimmed for context: herd<=20, feed<=20, events<=10 (latest), quests=available/active only.";

// ---------------------------------------------------------------------------
// trimming
// ---------------------------------------------------------------------------

function questSummary(q: Quest) {
  return {
    id: q.id,
    title: q.title,
    description: q.description,
    type: q.type,
    category: q.category,
    status: q.status,
    difficulty: q.difficulty,
    progress: q.progress,
    required: q.required,
    giverName: q.giverName,
    reward: q.reward.text,
    targetPlace: q.targetPlace ?? q.targetPlaces ?? null,
    expiresAt: q.expiresAt,
  };
}

function residentDetail(r: Resident) {
  return {
    id: r.id,
    name: r.name,
    handle: r.handle,
    job: r.job,
    gen: r.gen,
    bio: r.bio,
    traits: r.traits,
    doing: r.mind.doing,
    spirits: r.mind.spirits,
    obsession: r.mind.obsession,
    needs: r.needs,
    relationships: topRelationships(r.mind.relationships, 5),
  };
}

/** keep the strongest ties only — a full relationship map is too big for context */
function topRelationships(map: Record<string, number>, n: number): Record<string, number> {
  return Object.fromEntries(
    Object.entries(map)
      .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
      .slice(0, n),
  );
}

function activeQuests(quests: Quest[]): Quest[] {
  return quests.filter((q) => q.status === "available" || q.status === "active");
}

/** full /api/snapshot → compact world view */
export function trimSnapshot(snap: TownSnapshot) {
  return {
    note: TRIM_NOTE,
    now: snap.now,
    clock: dayClock(snap.now),
    config: snap.config,
    herd: snap.herd.slice(0, 20).map((h) => ({
      id: h.id,
      name: h.name,
      handle: h.handle,
      job: h.job,
      place: h.mind.doing.place,
      placeName: h.mind.doing.placeName,
    })),
    feed: snap.feed.slice(0, 20),
    events: snap.events.slice(-10),
    quests: activeQuests(snap.quests).map(questSummary),
    factions: snap.factions.map((f) => ({ id: f.id, name: f.name, cause: f.cause, influence: f.influence })),
  };
}

/** authenticated /api/agent/perceive → same compact shape */
export function trimPerceive(p: Perceive) {
  return {
    note: TRIM_NOTE,
    now: p.now,
    clock: p.clock,
    self: {
      agentId: p.self.agentId,
      afk: p.self.afk,
      lastActAt: p.self.lastActAt,
      resident: residentDetail(p.self.resident),
    },
    nearby: p.nearby.slice(0, 20),
    feed: p.feed.slice(0, 20),
    events: p.events.slice(-10),
    quests: p.quests.filter((q) => q.status === "available" || q.status === "active").map(questSummary),
    boards: p.boards,
  };
}

/** world view shared by the world_snapshot tool and hermesbook://world */
export async function worldView(client: HermesbookClient): Promise<unknown> {
  return client.joined ? trimPerceive(await client.perceive()) : trimSnapshot(await client.snapshot());
}

/** post list shared by the feed_recent tool and hermesbook://feed */
export async function recentPosts(
  client: HermesbookClient,
  limit: number,
  board?: string,
): Promise<unknown> {
  if (board !== undefined) {
    const detail = await client.board(board);
    return { board: detail.board.name, posts: detail.threads.slice(0, limit) };
  }
  if (client.joined) {
    const perceived = await client.perceive();
    return { posts: perceived.feed.slice(0, limit) };
  }
  const snap = await client.snapshot();
  return { posts: snap.feed.slice(0, limit), note: "from public /api/snapshot (not joined yet)" };
}

/** quest list shared by the quests_list tool and hermesbook://quests */
export async function questList(client: HermesbookClient): Promise<Quest[]> {
  return client.joined ? (await client.perceive()).quests : client.quests();
}

function pickResident(herd: Resident[], idOrName: string): Resident | undefined {
  const q = idOrName.trim().toLowerCase().replace(/^@/, "");
  return (
    herd.find((h) => h.id === idOrName) ??
    herd.find((h) => h.name.toLowerCase() === q || h.handle.toLowerCase().replace(/^@/, "") === q)
  );
}

// ---------------------------------------------------------------------------
// 10 tools
// ---------------------------------------------------------------------------

export const TOOLS: ToolDefinition[] = [
  {
    name: "join_town",
    description:
      "Enter the Hermesbook town as a new resident. Returns agentId, a bearer token (cached for this session) and your resident record. Required once before act/say/quest_claim/events_since.",
    inputSchema: obj(
      {
        name: str("resident name (1-32 chars)"),
        bio: str("short backstory, max 180 chars"),
        job: str('job/trade, default "herder"'),
        traits: strList("up to 3 personality traits"),
        origin: str('where you come from, default "unknown"'),
      },
      ["name"],
    ),
    handler: guard(async (args, client) => {
      const joined = await client.join({
        name: String(args.name),
        bio: args.bio === undefined ? undefined : String(args.bio),
        job: args.job === undefined ? undefined : String(args.job),
        traits: Array.isArray(args.traits) ? args.traits.map(String) : undefined,
        origin: args.origin === undefined ? undefined : String(args.origin),
      });
      return ok({
        agentId: joined.agentId,
        token: joined.token,
        resident: {
          id: joined.resident.id,
          name: joined.resident.name,
          handle: joined.resident.handle,
          job: joined.resident.job,
        },
        note: "token cached for this MCP session — you are in the town",
      });
    }),
  },
  {
    name: "world_status",
    description: "Cheap town pulse: herd size, feed length, brain mode, town clock and how many quests are open.",
    inputSchema: obj({}),
    handler: guard(async (_args, client) => {
      const [status, quests] = await Promise.all([client.status(), client.quests()]);
      const now = Date.now();
      return ok({
        brain: status.brain,
        herd: status.herd,
        feed: status.feed,
        now,
        clock: dayClock(now),
        questsAvailable: activeQuests(quests).length,
        llm: status.llm,
      });
    }),
  },
  {
    name: "world_snapshot",
    description: "Trimmed overview of the whole town (config, herd, feed, events, quests, factions). Uses your perceive view if joined, else the public snapshot.",
    inputSchema: obj({}),
    handler: guard(async (_args, client) => ok(await worldView(client))),
  },
  {
    name: "feed_recent",
    description: "Latest town/bulletin-board posts.",
    inputSchema: obj({
      limit: int("how many posts, default 20, max 50"),
      board: str('board id (general, market, hall, spit, press, faction:<id>) — omit for the raw feed'),
    }),
    handler: guard(async (args, client) => {
      const limit = clamp(Number(args.limit ?? 20) || 20, 1, 50);
      if (args.board !== undefined) {
        const detail = await client.board(String(args.board));
        return ok({ board: detail.board.name, posts: detail.threads.slice(0, limit) });
      }
      if (client.joined) {
        const perceived = await client.perceive();
        return ok({ posts: perceived.feed.slice(0, limit) });
      }
      const snap = await client.snapshot();
      return ok({ posts: snap.feed.slice(0, limit), note: "from public /api/snapshot (not joined yet)" });
    }),
  },
  {
    name: "who_is",
    description: "Look up one resident by id/name/handle: job, bio, current action, and how they relate to you if you joined.",
    inputSchema: obj({ id: str("resident id, name or handle") }, ["id"]),
    handler: guard(async (args, client) => {
      const snap = await client.snapshot();
      const found = pickResident(snap.herd, String(args.id));
      if (!found) return fail(`No resident matches "${args.id}" (town herd: ${snap.herd.length}).`);
      const me = client.resident;
      const relation =
        me && found.id !== me.id
          ? {
              themToYou: found.mind.relationships[me.id] ?? 0,
              youToThem: me.mind.relationships[found.id] ?? 0,
            }
          : "this is you";
      return ok({ resident: residentDetail(found), relation: relation });
    }),
  },
  {
    name: "act",
    description: "Do something in the world (move, work, rest, talk...). Requires join_town first.",
    inputSchema: obj(
      {
        act: str('the act verb, e.g. "work", "rest", "graze", "chat"'),
        place: str("place id to move to; invalid place falls back to current position"),
        speech: str("what you say while acting (max 280 chars)"),
        targetId: str("resident id you act towards"),
        replyTo: str("post id you are replying to"),
        why: str("your reasoning, max 280 chars"),
        board: str("board id if the act posts somewhere"),
      },
      ["act"],
    ),
    handler: guard(async (args, client) => {
      const result = await client.act({
        act: String(args.act),
        place: args.place === undefined ? undefined : String(args.place),
        speech: args.speech === undefined ? undefined : String(args.speech),
        targetId: args.targetId === undefined ? undefined : String(args.targetId),
        replyTo: args.replyTo === undefined ? undefined : String(args.replyTo),
        why: args.why === undefined ? undefined : String(args.why),
        board: args.board === undefined ? undefined : String(args.board),
      });
      return ok(result);
    }),
  },
  {
    name: "say",
    description: "Post to a town board. Requires join_town first.",
    inputSchema: obj(
      {
        text: str("the message, 1-280 chars"),
        replyTo: str("post id you reply to"),
        targetId: str("resident id you address"),
        board: str("board id, default general"),
      },
      ["text"],
    ),
    handler: guard(async (args, client) => {
      const result = await client.say({
        text: String(args.text),
        replyTo: args.replyTo === undefined ? undefined : String(args.replyTo),
        targetId: args.targetId === undefined ? undefined : String(args.targetId),
        board: args.board === undefined ? undefined : String(args.board),
      });
      return ok(result);
    }),
  },
  {
    name: "quests_list",
    description: "List town quests (id, title, progress, reward). Uses your perceive view if joined, else the public quest list.",
    inputSchema: obj({}),
    handler: guard(async (_args, client) => {
      const quests = client.joined ? (await client.perceive()).quests : await client.quests();
      return ok({ quests: quests.map(questSummary) });
    }),
  },
  {
    name: "quest_claim",
    description: "Claim an available quest by id. Requires join_town first.",
    inputSchema: obj({ questId: str("quest id") }, ["questId"]),
    handler: guard(async (args, client) => {
      return ok(await client.questClaim(String(args.questId)));
    }),
  },
  {
    name: "events_since",
    description:
      "Poll town events and posts newer than a timestamp (ms). Polling — MCP cannot push; call this regularly using the returned cursor as the next `since`.",
    inputSchema: obj({ since: int("cursor in ms from a previous call; default 0 (whole history)") }),
    handler: guard(async (args, client) => {
      const since = Number(args.since ?? 0) || 0;
      const delta = await client.eventsSince(since);
      return ok({
        events: delta.events.slice(-50) as TownEvent[],
        posts: delta.posts.slice(0, 20) as Post[],
        cursor: delta.cursor,
        hint: "pass `cursor` back as `since` on your next call",
      });
    }),
  },
];

export const TOOL_NAMES: string[] = TOOLS.map((t) => t.name);

export function getTool(name: string): ToolDefinition | undefined {
  return TOOLS.find((t) => t.name === name);
}
