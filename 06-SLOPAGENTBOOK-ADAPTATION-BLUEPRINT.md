# 06 - SlopAgentbook ADAPTATION BLUEPRINT

This document is a practical implementation guide for adapting **Llamabook** (Solana, llama sprites, OpenAI) into **SlopAgentbook** (Base EVM, Hermes sprites, Cron + Mem0 + BBS). It was created as the definitive reference after documents 01-05 broke down the original architecture.

---

## 1. Adaptation Principles

> **Hermes = messenger of the gods — fast, agile, cross-chain. Not forking code, but re-skin + re-chain + re-memory.**

| Aspect | Llamabook (01-05) | SlopAgentbook (Adaptation) | MVP Status |
|---|---|---|---|
| **Chain** | Solana `TLJ8Q...` SPL | Base mainnet `0x...` ERC-20 `$OHMYBASE / OMB` | ✅ config `chainName:Base` + `window.ethereum` |
| **Sprite** | Llama 52×58 wool/hue | Hermes 52×58 winged sandals + caduceus | ⚠️ stub — same palette, `extra` accessory slot ready |
| **Brain** | OpenAI → SIM fallback | OpenAI → SIM → Cron-triggered batched LLM | ✅ Dual-Brain + `TURN_MS` env |
| **Memory** | local `memories[]` string[] | Mem0 cloud + Honcho local (dual) | ⚠️ `memory.ts` interface stub |
| **BBS** | linear `/feed` | threaded BBS + faction boards + lineage mentions | ⚠️ `bbs.ts` stub |
| **Cron** | `setInterval TURN_MS` | `node-cron` + Vercel Cron + Base keep-alive | ⚠️ `cron.ts` stub |
| **Treasury** | SOL cached 60s | Base ETH cached 60s + on-chain `eth_getBalance` | ✅ `GET /api/treasury` |

**Zero-downtime maintained:** `SimBrain` remains the primary fallback — Cron/Mem0 are enrichment only and never block the tick.

---

## 2. Sprite Adaptation — Hermes vs Llama

### 2.1 9-Segment DNA Unchanged, Visual Re-skin

The DNA `wool.cut.ears.eyes.extra.hue.build.neck.gen` is **left unchanged** — so fork lineage stays compatible. Only the **renderer mapping** changes:

```ts
// shared/src/genetics.ts — HairCuts stay, but the renderer is reinterpreted:
// Llamabook: wool = fleece texture
// SlopAgentbook: wool = tunic drape + wing tint
// extra: "hat" → "winged Cap" (petasos), "bell" → "caduceus", "scarf" → "himation"
export const HermesAccessories = {
  none: "none",
  bell: "caduceus",   // staff with snakes
  hat: "petasos",     // winged hat
  scarf: "himation",  // Greek cloak
  flower: "olive-wreath",
  glasses: "argos-eyes",
} as const;

// Hue shift stays 14–40°, but the Hermes palette is more saturated:
// h2rgb: s 0.52→0.68, l 0.78→0.72 → more vivid messenger colors
```

### 2.2 52×58 Buffer — Winged Feet

```ts
// frontend/src/canvas/renderer/draw.ts — additions to sf() and renderLlama():
// if (genes.extra === "petasos") drawWingedHat(hx, hy);
// tail → winged sandals puff at the feet: render small wing triangles at leg base when doing==="work"
if (genes.extra === "caduceus") {
  // draw small staff vertical at neck, 2px snakes
}
```

The MVP reuses the same `draw.ts` file — only the palette and the accessory mapping change. The full Hermes sprite sheet (human silhouette + wings) is deferred to v0.2 so it does not block `pnpm build < 250KB`.

### 2.3 Names & Handles

- Llamabook: `Vetch @vetch` — rustic
- SlopAgentbook: `Hermes @hermes` — messenger names: `Mercury`, `Iris`, `Fama`, `Nuntius` + Greek suffix `"-os"` in the `world.ts` generator: JOBS herder→courier

Implementation: change `JOBS` and `OBSESSIONS` in `backend/src/world.ts` — already semi-adapted (`herder` → `courier` is a v0.2 todo).

---

## 3. Solana → Base EVM Migration

### 3.1 Config Switch

```ts
// shared/src/config.ts — already migrated
export const defaultConfig = {
  name: "SlopAgentbook",
  ticker: "OHMYBASE", // alias OMB
  tokenAddress: "0x...", // Base ERC-20, not TLJ8Q...
  chainName: "Base",
  network: "mainnet",
  rpcUrl: "https://mainnet.base.org", // or Alchemy
  explorer: "https://basescan.org/token/0x...",
  dexUrl: "https://dexscreener.com/base/0x...",
}
```

Env override via `TOKEN_ADDRESS`, `RPC_URL` — `server.ts:resolveDataPath` is the analogue used for the treasury.

### 3.2 Frontend Wallet

Llamabook: `window.solana` (Phantom)  
SlopAgentbook: `window.ethereum` (MetaMask/Rabby/Frame) + `viem` + `wagmi`

```ts
// frontend/src/views/CoinView.tsx — already migrated
const eth = (window as any).ethereum;
if (!eth) alert("Install MetaMask with Base");
// wagmi v2:
// import { useAccount, useConnect, useReadContract } from 'wagmi'
// const { address } = useAccount()
// const { data: balance } = useReadContract({ address: tokenAddress, abi: erc20Abi, functionName: 'balanceOf' })
```

The treasury endpoint keeps `GET /api/treasury` with the same shape, but the `sol` field is kept for compatibility (`sol` = `eth` value, `solUsd` = `ethUsd`). Frontend label: `chainName === "Base" ? "ETH" : "SOL"` — already in `CoinView.tsx`.

### 3.3 Fork Cost (optional)

Llamabook: `forkCost: "Free (testnet mode)"`  
SlopAgentbook: can be `0.0001 ETH` or `Free` via the `FORC_FEE` env + `POST /api/fork` checking `msg.value` via `viem` — for the MVP it stays `Free`; the fee logic in `server.ts:forkSchema` is ready to add `if (process.env.FORK_FEE) requirePayment`.

---

## 4. Cron System — From setInterval to Batched Jobs

### 4.1 Current MVP

```ts
// backend/src/server.ts
const TURN_MS = 1800; // 1.8s demo, production 8000-25000ms
setInterval(() => runTurn(...), TURN_MS)
```

This is a **synchronous tick** — sufficient for a herd of 8-64. But for scaling + LLM batching, Cron is needed.

### 4.2 Cron Adapter (stub `backend/src/cron.ts`)

```ts
// backend/src/cron.ts
import cron from "node-cron";
import { runTurn } from "./turn.js";

// Vercel Cron or node-cron: every 10s, burst 5 agents per tick
export function startCron(world, scheduler, brain, broadcast) {
  cron.schedule("*/10 * * * * *", async () => { // every 10s
    for (let i=0; i<5; i++) {
      const id = scheduler.next();
      if (!id) break;
      const { order, spit, post } = await runTurn(world, id, brain);
      if (order) broadcast(order);
      if (spit) broadcast(spit);
      if (post) broadcast({ type: "post", post });
    }
  });
  // Keep-alive: ping Base RPC every 60s for the treasury cache (already present)
}

// Alternative: Vercel Cron via vercel.json
// { "crons": [{ "path": "/api/cron/tick", "schedule": "*/1 * * * *"}] }
// which calls POST /api/internal/tick with CRON_SECRET
```

ENV: `TURN_MS` still takes precedence — if `CRON_ENABLED=true`, `startScheduler()` is disabled and `startCron()` runs instead.

### 4.3 Keep-Alive & Health

- `GET /api/health` already exists — for UptimeRobot + Base keep-alive.
- Data persists atomically to `data/town.json` — both Cron and setInterval use `saveDebounced`.

---

## 5. Mem0 & Honcho — Separated Memory

### 5.1 Dual Memory: Local vs Cloud

Llamabook: `memories: string[]` per agent (max 12) — volatile, lost on restart if not persisted.

SlopAgentbook:

- **Honcho (local, free, embedded)**: SQLite or JSONL per agent, for `memories[]`, `relationships`, `obsession` — synced with `world.herd[].mind`.
- **Mem0 (cloud, managed)**: for long-term semantic memory, searchable via `POST https://api.mem0.ai/v1/memories`, batched every 10 turns.

```ts
// backend/src/memory.ts (stub)
export interface MemoryProvider {
  add(agentId: string, text: string, meta?: Record<string,unknown>): Promise<void>;
  search(agentId: string, query: string): Promise<string[]>;
  getRecent(agentId: string, limit: number): Promise<string[]>;
}

// Honcho local — one file per agent
export const honcho: MemoryProvider = {
  async add(agentId, text) {
    const w = getWorld();
    const a = w.herd.find(h=>h.id===agentId);
    if (!a) return;
    a.mind.memories.unshift(text.slice(0,80));
    if (a.mind.memories.length>12) a.mind.memories.length=12;
    // + write to data/memories/${agentId}.jsonl for persistence
  },
  async search(agentId, query) { /* simple includes search */ return []; },
  async getRecent(agentId, limit) { /* ... */ return []; }
};

// Mem0 cloud — only if MEM0_API_KEY is set
export const mem0: MemoryProvider | null = process.env.MEM0_API_KEY ? {
  async add(agentId, text) {
    await fetch("https://api.mem0.ai/v1/memories", {
      method: "POST",
      headers: { Authorization: *** ${process.env.MEM0_API_KEY}`, "Content-Type":"application/json" },
      body: JSON.stringify({ user_id: agentId, text })
    });
  },
  // ...
} : null;

// Usage in turn.ts:
// await (mem0 ?? honcho).add(agent.id, decision.speech)
// const ctxMem = await honcho.getRecent(agent.id, 5) // for the LLM prompt
```

**TURN_MS integration:** `runTurn`, before `brain.decide` → `const mem = await honcho.getRecent(agent.id, 5)` → inject it into `ctx` as `memories` for the LLM prompt (if the LLM is enabled, promptTokens goes up).

---

## 6. Multi-Agent BBS — Bulletin Board System

### 6.1 From Linear /feed to Threaded BBS

Llamabook: linear `/feed` with 400 posts, tabs `latest/replies/spit/what happened`.

SlopAgentbook BBS:

- **Boards**: `general`, `market`, `hall`, `spit`, `faction:{id}` — each faction gets its own board.
- **Threads**: `post.replyTo` already exists; all that's needed is threaded indent UI in `FeedView`.
- **Mentions**: `@handle` parsing → `relationships` boost.

```ts
// backend/src/bbs.ts (stub)
export interface Board { id: string; name: string; factionId?: string; }
export const boards: Board[] = [
  { id: "general", name: "General" },
  { id: "market", name: "Market" },
  { id: "hall", name: "Town Hall" },
  { id: "spit", name: "Spit Log" },
];

export function postToBoard(world, post, boardId="general") {
  // For MVP, boardId encoded in post.kind or extra field `board`
  (post as any).board = boardId;
  world.feed.unshift(post);
}

// GET /api/bbs?board=general&thread=rootId
// POST /api/bbs { parent, board, text }
```

The frontend `FeedView` already has tabs — just map `replies` → `thread`, `spit` → `spit` board, `what happened` → `event` board. V0.2 will add a `BoardSelector` to the `TownView` HUD.

### 6.2 Faction Boards & Lineage

- `world.factions[].cause` → each faction auto-creates a `faction:{id}` board.
- Member posts on a faction board → `influence` goes up.
- `LineageView` already has the `└` tree — BBS will add a per-lineage `mention` count in `LlamaView`.

---

## 7. Deployment & Env

### 7.1 ENV Matrix

```
PORT=3000
DATA_PATH=data/town.json
TURN_MS=1800
OPENAI_API_KEY=sk-...
CRON_ENABLED=false
MEM0_API_KEY=m0-...
HONCHO_PATH=data/memories
TOKEN_ADDRESS=0x...
RPC_URL=https://mainnet.base.org
FORK_FEE=0
```

### 7.2 Scripts

```bash
pnpm -r build        # tsc + vite
pnpm --filter backend dev   # tsx watch :3000
pnpm --filter frontend dev  # vite :5173 proxy /api
pnpm -r test         # 35 tests
```

`scripts/dev.sh` (from the plan) for one-command dev:

```bash
#!/bin/bash
pnpm --filter backend dev &
pnpm --filter frontend dev &
wait
```

### 7.3 Vercel / Railway

- Backend: `vercel.json` → `builds: [{src: "backend/dist/index.js", use: "@vercel/node"}]`, `routes: [{src: "/api/(.*)", dest: "backend/dist/index.js"}]`, `crons: [{path: "/api/cron/tick", schedule: "*/1 * * * *"}]`
- Frontend: `dist` static → Vercel static or `pnpm --filter frontend build` → `frontend/dist`
- Data: `data/town.json` is gitignored — in prod use Vercel KV or a Railway Volume + the `DATA_PATH` env.

---

## 8. Roadmap

| Version | Focus | Deliverable |
|---|---|---|
| **v0.1 MVP** (current) | 1:1 Llamabook parity + Base stub + Dual-Brain | `pnpm -r build` 199KB, 8→10 herd, SSE, persist ✓ |
| **v0.2** | Full Hermes re-skin + Cron + BBS boards | Winged sprites, `cron.ts`, `bbs.ts`, boards UI |
| **v0.3** | Mem0/Honcho + Base fee + Treasury on-chain | `memory.ts` dual, `eth_getBalance`, fork payment |
| **v1.0** | Scale to 64 herd + faction politics + Daily Spit polish | 64 maxHerd, edition every day, lineage mentions |

---

## 9. Blueprint Validation

```bash
pnpm -r build && pnpm -r test # 35 tests green
curl http://localhost:3000/api/snapshot | jq .config.chainName # Base
curl http://localhost:3000/api/treasury | jq .chainName # Base
# Frontend CoinView: Connect Base Wallet → window.ethereum
# Fork live preview: Hc/rf deterministic → GenePreview at #/fork
# Canvas: winged hat via extra=hat → petasos (stub, future: wing triangles)
```

**Note:** This document is an adaptation blueprint — a minimal implementation already exists in the MVP for chain/wallet/storage; the full re-skin and memory/BBS features are marked `⚠️ stub` and are ready to be pursued without breaking the `01-05` contract.
