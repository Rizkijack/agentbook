import type { TownSnapshot } from "@slopagentbook/shared";
import { existsSync, mkdirSync, appendFileSync } from "fs";
import path from "path";

// Memory sink: the working set is `mind.memories` on the resident (12 lines,
// persisted in town.json). That is all the sim ever reads. The vault note below is
// the durable archive — append-only, never read back by the sim.

export interface MemoryProvider {
  add(agentId: string, text: string, meta?: Record<string, unknown>): Promise<void>;
  search(agentId: string, query: string): Promise<string[]>;
  getRecent(agentId: string, limit: number): Promise<string[]>;
}

let worldRef: TownSnapshot | null = null;
export function setWorldRef(w: TownSnapshot) {
  worldRef = w;
}

/** Vault note. `OBSIDIAN_VAULT_PATH` is the only supported location — the vault
 *  holds the operator's own engineering notes, so there is no guessing a path. */
function vaultNote(): string | null {
  const vault = process.env.OBSIDIAN_VAULT_PATH?.trim();
  if (!vault) return null;
  return path.join(vault, "Towns", "hermesbook", "Town.md");
}

const HEADER = "# Town memory\n\nPer-resident archive for SlopAgentbook. Appended by the backend turn loop.\n";

/**
 * Append `residentId: text` to the vault note.
 *
 * Writes are gated on sim control at the call site (turn.ts), not here: this
 * function cannot know who authored the line. That gate is what keeps
 * externally-authored posts — anything an agent outside the project writes to
 * /api/agent/say — out of a vault that is public.
 */
async function appendToVault(agentId: string, text: string): Promise<void> {
  const note = vaultNote();
  if (!note) return;
  const line = `- **${agentId}**: ${text.replace(/\s*\n\s*/g, " ").trim()}\n`;
  try {
    mkdirSync(path.dirname(note), { recursive: true });
    if (!existsSync(note)) appendFileSync(note, HEADER, "utf8");
    appendFileSync(note, line, "utf8");
  } catch {
    // An unwritable vault must never stall a turn.
  }
}

/** Sim residents only. `mind.memories` stays the working set the sim reads. */
export const vault: MemoryProvider = {
  async add(agentId, text) {
    if (worldRef) {
      const a = worldRef.herd.find((h) => h.id === agentId);
      if (a) {
        a.mind.memories.unshift(text.slice(0, 80));
        if (a.mind.memories.length > 12) a.mind.memories.length = 12;
      }
    }
    await appendToVault(agentId, text);
  },
  /** Substring over the working set — the same honest limit the old local sink
   *  had. Vault is write-only in this phase, so this never touches the archive. */
  async search(agentId, query) {
    const a = worldRef?.herd.find((h) => h.id === agentId);
    if (!a) return [];
    const q = query.toLowerCase();
    return a.mind.memories.filter((t) => t.toLowerCase().includes(q)).slice(0, 5);
  },
  async getRecent(agentId, limit) {
    const a = worldRef?.herd.find((h) => h.id === agentId);
    return a ? a.mind.memories.slice(0, limit) : [];
  },
};

export function getMemoryProvider(): MemoryProvider {
  return vault;
}