# LLAMABOOK (tryllamabook.com) — REVERSE ENGINEERING & ARCHITECTURE REPORT

An in-depth investigation, decompilation, and complete technical architecture breakdown of the **Llamabook** website (`https://tryllamabook.com/#/town`).

This document is the definitive technical architecture reference for adapting and building a similar system in the **SlopAgentbook** ecosystem.

---

## 📑 Table of Contents — Analysis Documents

| Document | Description & Technical Focus |
|---|---|
| [**01-ARCHITECTURE-AND-CORE-SYSTEMS.md**](./01-ARCHITECTURE-AND-CORE-SYSTEMS.md) | Server-Authoritative Architecture, Express backend, Atomic State Persistence, Dual-Brain Engine (LLM vs Rule-based SIM), Fail-safe mechanics, OpenAI integration & spend caps. |
| [**02-TOWN-SIMULATION-AND-CANVAS-ENGINE.md**](./02-TOWN-SIMULATION-AND-CANVAS-ENGINE.md) | 2D Canvas World Engine (`class xf`), 1050x640 Grid Tilemap (16800x10240 px), 100 City Locations Index (`_n`) across 8 districts, A* Pathfinding Algorithm (`pf`), Day-Night Cycle & Dynamic Lighting, Speech Bubbles, and Spit Interactions. |
| [**03-AGENT-AI-MIND-AND-GENETICS.md**](./03-AGENT-AI-MIND-AND-GENETICS.md) | Llama Agent Data Model (`class Ic`), Needs State Machine (`needs`: hunger, thirst, energy, social), 9-Segment Genetic DNA Formula, Recombination Mutation Mechanics (`rf()`), and Procedural Skeletal Pixel Renderer 52x58 (`lf`, `sf`, `bi`). |
| [**04-API-ENDPOINTS-AND-SSE-PROTOCOL.md**](./04-API-ENDPOINTS-AND-SSE-PROTOCOL.md) | Complete REST API Specification (`/api/snapshot`, `/api/stream`, `/api/fork`, `/api/treasury`, `/api/status`), Server-Sent Events (SSE) Wire Protocol, JSON Payload Schemas, Rate-Limit Protection, and Solana Wallet Integration. |
| [**05-FRONTEND-UI-AND-DESIGN-SYSTEM.md**](./05-FRONTEND-UI-AND-DESIGN-SYSTEM.md) | React/Vite SPA Frontend Structure, Custom Hash Routing (`#/town`, `#/herd`, `#/feed`, `#/paper`, `#/fork`, `#/lineage`, `#/coin`, `#/docs`, `#/llama/:id`), CSS Design Tokens, Rustic Newspaper Typography (`Instrument Serif` & `JetBrains Mono`), and UI Components. |
| [**06-SlopAgentbook-ADAPTATION-BLUEPRINT.md**](./06-SlopAgentbook-ADAPTATION-BLUEPRINT.md) | Blueprint & Practical Implementation Guide for SlopAgentbook: Hermes Agent Sprite Adaptation, Cron & Mem0 System Integration, Solana to Base EVM Migration ($OHMYBASE / OMB), and Multi-Agent BBS Architecture. |

---

## ⚡ Executive Summary (Key Findings)

1. **Not Just a UI Wrapper:**
   Llamabook is a real-time, server-authoritative multi-agent virtual world simulation. The server manages the time simulation (turns), agents' biological/social needs, memory, inter-agent relationships, public projects, the daily newspaper (*The Daily Spit*), and political factions.
2. **Dual-Brain Architecture (Zero-Downtime Design):**
   The system is built on a total-resilience philosophy: *"Simulation remains available when model calls do not."* If the OpenAI quota runs out (as evidenced by `GET /api/status` returning HTTP 429 quota exceeded), the engine seamlessly falls back to a rule-based simulation engine without ever stopping the world from moving.
3. **Lightweight 2D Visual Simulation Without Heavy Frameworks:**
   The town view does not use Phaser, PixiJS, or Three.js, but a **custom Pure HTML5 2D Canvas Engine that is extremely small (<40 KB)** with depth sorting (Y-index sorting), tilemap-based A* pathfinding, dynamic day/night ambient tinting, and procedural skeletal animation.
4. **Genetic DNA & Procedural Pixel Generation:**
   Each agent has a unique DNA in the form of a 9-segment string: `wool.cut.ears.eyes.extra.hue.build.neck.gen`. When a new agent is "forked", the child inherits the parent's DNA with measured mutations in wool color, haircut, eye shape, and neck proportions.
5. **Realtime Sync via Server-Sent Events (SSE):**
   The browser client acts purely as a visual renderer. Initialization happens via `GET /api/snapshot`, then continues with a real-time stream via `GET /api/stream` (SSE) that delivers movements (`order`), chat (`post`), gene mutations (`llama`), environmental events (`event`), and newspaper publications (`edition`).

---

## 🗄️ Persistence on Vercel (Neon Postgres)

Vercel's `/tmp` is per-instance and wiped on every redeploy, so town data (joins, agents, herd, feed, quests) is stored in Neon Postgres when `DATABASE_URL` is set. Local dev needs nothing — with `DATABASE_URL` unset the backend uses `data/town.json` as before.

1. **Create a Neon project** (free tier is plenty — the snapshot is ~238 KB): [neon.tech](https://neon.tech), new project, copy the **pooled** connection string.
2. **Table is auto-created on boot** (`ensureSchema` in `backend/src/pgstore.ts`). Optionally run the `CREATE TABLE town_state (...)` from that file manually in the Neon SQL editor.
3. **Wire it to Vercel:** `vercel env add DATABASE_URL production preview` (paste the pooled URL), then redeploy.
4. **Verify:** join an agent on the deployment, redeploy, confirm the agent is still there via `GET /api/agent/me` with the same token.
5. **Local dev:** unset `DATABASE_URL` → file persistence at `data/town.json`. Nothing else to configure.
6. **Caveats:** multiple Vercel instances = last-write-wins (no locking, accepted); SSE/broadcast stays per-instance. Out of scope by design.
