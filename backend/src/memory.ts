import type { TownSnapshot } from "@hermesbook/shared";
import { existsSync, mkdirSync, appendFileSync, readFileSync } from "fs";
import path from "path";

// Dual memory: Honcho local (file) + Mem0 cloud (fetch if MEM0_API_KEY)

export interface MemoryProvider {
  add(agentId: string, text: string, meta?: Record<string, unknown>): Promise<void>;
  search(agentId: string, query: string): Promise<string[]>;
  getRecent(agentId: string, limit: number): Promise<string[]>;
}

let worldRef: TownSnapshot | null = null;
export function setWorldRef(w: TownSnapshot) {
  worldRef = w;
}

function ensureDir(p: string) {
  try {
    mkdirSync(path.dirname(p), { recursive: true });
  } catch {}
}

// Honcho local — file per agent + world.herd memories
export const honcho: MemoryProvider = {
  async add(agentId, text) {
    if (worldRef) {
      const a = worldRef.herd.find((h) => h.id === agentId);
      if (a) {
        a.mind.memories.unshift(text.slice(0, 80));
        if (a.mind.memories.length > 12) a.mind.memories.length = 12;
      }
    }
    const base = process.env.HONCHO_PATH ?? "data/memories";
    const file = path.join(base, `${agentId}.jsonl`);
    ensureDir(file);
    try {
      appendFileSync(file, JSON.stringify({ t: Date.now(), text }) + "\n");
    } catch {}
  },
  async search(agentId, query) {
    const base = process.env.HONCHO_PATH ?? "data/memories";
    const file = path.join(base, `${agentId}.jsonl`);
    if (!existsSync(file)) return [];
    try {
      const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
      return lines
        .map((l) => JSON.parse(l).text as string)
        .filter((t) => t.toLowerCase().includes(query.toLowerCase()))
        .slice(0, 5);
    } catch {
      return [];
    }
  },
  async getRecent(agentId, limit) {
    if (worldRef) {
      const a = worldRef.herd.find((h) => h.id === agentId);
      if (a) return a.mind.memories.slice(0, limit);
    }
    const base = process.env.HONCHO_PATH ?? "data/memories";
    const file = path.join(base, `${agentId}.jsonl`);
    if (!existsSync(file)) return [];
    try {
      const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
      return lines
        .slice(-limit)
        .map((l) => JSON.parse(l).text as string)
        .reverse();
    } catch {
      return [];
    }
  },
};

export const mem0: MemoryProvider | null = process.env.MEM0_API_KEY
  ? {
      async add(agentId, text) {
        try {
          await fetch("https://api.mem0.ai/v1/memories", {
            method: "POST",
            headers: {
              Authorization: `Token ${process.env.MEM0_API_KEY}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ user_id: agentId, text, metadata: { source: "hermesbook" } }),
          });
        } catch {}
        // also mirror to honcho
        await honcho.add(agentId, text);
      },
      async search(agentId, query) {
        try {
          const r = await fetch(`https://api.mem0.ai/v1/memories?user_id=${agentId}&query=${encodeURIComponent(query)}`, {
            headers: { Authorization: `Token ${process.env.MEM0_API_KEY}` },
          });
          const j = (await r.json()) as { results?: Array<{ memory: string }> };
          return (j.results ?? []).map((x) => x.memory).slice(0, 5);
        } catch {
          return honcho.search(agentId, query);
        }
      },
      async getRecent(agentId, limit) {
        return honcho.getRecent(agentId, limit);
      },
    }
  : null;

export function getMemoryProvider(): MemoryProvider {
  return mem0 ?? honcho;
}
