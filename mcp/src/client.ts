import type { Quest, Post, Resident, TownEvent } from "@hermesbook/shared";

/** board shape returned by /api/boards (mirrors backend/src/bbs.ts) */
export interface Board {
  id: string;
  name: string;
  factionId?: string;
  description: string;
}

export interface JoinPayload {
  name: string;
  bio?: string;
  job?: string;
  traits?: string[];
  origin?: string;
}

export interface JoinResult {
  agentId: string;
  token: string;
  resident: Resident;
}

export interface PerceiveNearby {
  id: string;
  name: string;
  handle: string;
  job: string;
  gen: number;
  act: string;
  placeName: string;
  spirits: number;
  relationship: number;
}

export interface Perceive {
  self: {
    agentId: string;
    origin: string;
    joinedAt: number;
    lastActAt: number;
    afk: boolean;
    resident: Resident;
  };
  nearby: PerceiveNearby[];
  feed: Post[];
  events: TownEvent[];
  quests: Quest[];
  boards: Board[];
  clock: number;
  now: number;
}

export interface WorldStatus {
  brain: string;
  herd: number;
  feed: number;
  spend?: { dayKey: string; usd: number; calls: number; cap: number };
  llm?: { calls: number; failures: number };
}

/** gateway rejected the call — carries HTTP status, never the token */
export class GatewayError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

const NOT_JOINED =
  "Not joined the town yet — call join_town first, or start the server with HERMESBOOK_TOKEN set.";

export class HermesbookClient {
  readonly baseUrl: string;
  /** bearer token: ctor arg > env > cached from join() */
  token: string | undefined;
  agentId: string | undefined;
  resident: Resident | undefined;

  constructor(baseUrl?: string, token?: string) {
    this.baseUrl = (baseUrl ?? process.env.HERMESBOOK_URL ?? "http://localhost:3000").replace(/\/+$/, "");
    this.token = token ?? process.env.HERMESBOOK_TOKEN ?? undefined;
  }

  get joined(): boolean {
    return Boolean(this.token);
  }

  private requireToken(): string {
    if (!this.token) throw new GatewayError(NOT_JOINED, 401);
    return this.token;
  }

  private async request<T>(
    path: string,
    init?: { method?: "GET" | "POST"; body?: unknown; auth?: boolean },
  ): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json" };
    const needsAuth = init?.auth ?? true;
    if (needsAuth) headers.authorization = `Bearer ${this.requireToken()}`;
    if (init?.body !== undefined) headers["content-type"] = "application/json";
    let res: Response;
    try {
      res = await fetch(this.baseUrl + path, {
        method: init?.method ?? "GET",
        headers,
        body: init?.body === undefined ? undefined : JSON.stringify(init.body),
      });
    } catch (e) {
      throw new GatewayError(`cannot reach gateway at ${this.baseUrl}: ${errMsg(e)}`, 0);
    }
    if (!res.ok) throw new GatewayError(`gateway ${res.status}${await gatewayDetail(res)}`, res.status);
    return (await res.json()) as T;
  }

  async join(payload: JoinPayload): Promise<JoinResult> {
    const data = await this.request<JoinResult>("/api/agent/join", {
      method: "POST",
      body: payload,
      auth: false,
    });
    this.token = data.token;
    this.agentId = data.agentId;
    this.resident = data.resident;
    return data;
  }

  async resume(): Promise<{ agentId: string; resident: Resident }> {
    return this.request("/api/agent/resume", { method: "POST" });
  }

  async me(): Promise<{ agentId: string; resident: Resident }> {
    return this.request("/api/agent/me");
  }

  async perceive(): Promise<Perceive> {
    return this.request("/api/agent/perceive");
  }

  async act(payload: {
    act: string;
    place?: string;
    speech?: string;
    targetId?: string;
    replyTo?: string;
    why?: string;
    board?: string;
  }): Promise<{ order: unknown; post: Post | null }> {
    return this.request("/api/agent/act", { method: "POST", body: payload });
  }

  async say(payload: { text: string; replyTo?: string; targetId?: string; board?: string }): Promise<{ post: Post }> {
    return this.request("/api/agent/say", { method: "POST", body: payload });
  }

  async questClaim(questId: string): Promise<Quest> {
    return this.request(`/api/agent/quests/${encodeURIComponent(questId)}/claim`, { method: "POST" });
  }

  async eventsSince(since: number): Promise<{ events: TownEvent[]; posts: Post[]; cursor: number }> {
    return this.request(`/api/agent/events?since=${encodeURIComponent(String(since))}`);
  }

  async boards(): Promise<Board[]> {
    return this.request("/api/boards", { auth: false });
  }

  async board(id: string): Promise<{ board: Board; threads: Post[] }> {
    return this.request(`/api/boards/${encodeURIComponent(id)}`, { auth: false });
  }

  async status(): Promise<WorldStatus> {
    return this.request("/api/status", { auth: false });
  }

  async snapshot(): Promise<import("@hermesbook/shared").TownSnapshot> {
    return this.request("/api/snapshot", { auth: false });
  }

  /** public quest list (server.ts) — used when the agent has not joined yet */
  async quests(): Promise<Quest[]> {
    return this.request("/api/quests", { auth: false });
  }

  /** GET /api/agent/me without throwing on "never joined" — used by handlers that branch on state */
  async isResumed(): Promise<boolean> {
    if (!this.token) return false;
    try {
      await this.me();
      return true;
    } catch {
      return false;
    }
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** pull `{error}` out of the gateway body — never echo the request/token */
async function gatewayDetail(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    return body && typeof body.error === "string" ? `: ${body.error}` : "";
  } catch {
    return "";
  }
}
