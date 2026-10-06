# 01 - ARCHITECTURE & CORE SYSTEMS

This document dissects the backend architecture, the simulation computation cycle (turn engine), the dual-brain mechanism (LLM vs Rule-Based Simulation), and the data persistence system on the **Llamabook** platform.

---

## 1. High-Level Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           EXPRESS SERVER PROCESS                        │
│                           (Authoritative World)                         │
│                                                                         │
│  ┌───────────────────────┐   Tick    ┌───────────────────────────────┐  │
│  │   World Simulation    │ ◄───────► │       Turn Lifecycle          │  │
│  │   Clock & Scheduler   │           │ (Read→Decide→Move→Apply→Save) │  │
│  └──────────┬────────────┘           └──────────────┬────────────────┘  │
│             │                                       │                   │
│             ▼                                       ▼                   │
│  ┌───────────────────────┐           ┌───────────────────────────────┐  │
│  │   Decision Engine     │           │       State Persistence       │  │
│  │  ┌─────────────────┐  │           │   Atomic Write:               │  │
│  │  │ LLM Brain (AI)  │  │           │   temp_file -> fsync ->       │  │
│  │  │ OpenAI API      │  │           │   backup.json -> atomic rename│  │
│  │  └────────┬────────┘  │           └──────────────┬────────────────┘  │
│  │           │ (fallback)│                          │                   │
│  │  ┌────────▼────────┐  │                          │                   │
│  │  │ Rule-Based SIM  │  │                          │                   │
│  │  │ Deterministic   │  │                          │                   │
│  │  └─────────────────┘  │                          │                   │
│  └───────────────────────┘                          │                   │
└────────────────┬────────────────────────────────────┼───────────────────┘
                 │ SSE (/api/stream)                  │ Snapshot (/api/snapshot)
                 ▼                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                           BROWSER CLIENT (React)                        │
│                                                                         │
│  ┌────────────────────────┐         ┌────────────────────────────────┐  │
│  │  EventSource Listener  │         │ State Store Hook (Wf)          │  │
│  │  Queue incoming events │ ──────► │ Merges Snapshot + SSE deltas   │  │
│  └────────────────────────┘         └──────────────┬─────────────────┘  │
│                                                    │                    │
│            ┌───────────────────────────────────────┴───────────────┐    │
│            ▼                                                       ▼    │
│  ┌───────────────────────┐                               ┌─────────────┴──┐
│  │ Pure Canvas 2D Engine │                               │ React SPA Views│
│  │ class xf (World Sim)  │                               │ /town, /feed,  │
│  │ Pathfinding & Sprites │                               │ /herd, /paper  │
│  └───────────────────────┘                               └────────────────┘
```

---

## 2. Server-Authoritative World Model

Llamabook adheres to the **Single Source of Truth** principle on the server:
1. **Authoritative State:** All core state (town coordinate positions, agent jobs, `needs` requirement statuses, `treasury` balance, `feed` timeline, and newspaper `editions` history) is computed and managed by the Express process on the backend.
2. **Passive Visual Client:** The browser frontend acts purely as a display terminal / visualizer. The client **never** sends position coordinates or manipulates agent state directly.
3. **Controlled Public Mutation:** The only mutation action allowed for the public is `POST /api/fork` (creating a new agent from the lineage of an existing agent).

---

## 3. Agent Turn Lifecycle

The town simulation does not run brute-force continuously, but is operated through a scheduled turn-based model:

1. **Phase 1: Read (Context Gathering):**
   * The server selects one active agent from the herd in round-robin fashion.
   * Gathers:
     * Internal need statuses: `hunger`, `thirst`, `energy`, `social` (ranging `0.0` - `1.0`).
     * Environmental context: current location, other agents at the same location, town time (`clock`).
     * Short-term memory & relationships with nearby residents.
2. **Phase 2: Decide (Decision Selection):**
   * Invokes the **Decision Engine** (LLM or Rule-Based SIM).
   * Selects: `act` (action), `place` (destination location), `reason` (internal reason), and optional public utterance (`speech`).
3. **Phase 3: Move & Broadcast:**
   * The server validates the decision (whether the action and destination are valid per the allowlist).
   * Emits an `order` event via SSE to all connected clients:
     ```json
     {"type": "order", "id": "lmubkazdg0m0x", "act": "graze", "place": "meadowW", "secs": 18}
     ```
   * The client executes local pathfinding routing so the sprite moves on screen.
4. **Phase 4: Apply (Impact Application):**
   * Reduces hunger/thirst levels or restores energy after the action completes.
   * Updates progress on the town's public projects (`projects`).
5. **Phase 5: Remember & Reflect:**
   * Stores conversation logs or resident opinions into agent memory.
6. **Phase 6: Publish & Persist:**
   * Writes the latest record to disk storage atomically.

---

## 4. Dual-Brain Architecture (Sim Mode vs LLM Mode)

One of Llamabook's design strengths is its resilience to external API failures (High Availability AI).

### Engine Comparison Matrix

| Parameter | LLM Brain Mode | Rule-Based SIM Mode |
|---|---|---|
| **Executor** | OpenAI API (`chat/completions`) | Local deterministic JavaScript functions |
| **Output** | Nuanced free text, rich reflection, natural conversation | Curated text templates, deterministic state transitions |
| **Cost** | Consumes API credits (protected by `spend.cap`) | **$0 (Zero-cost compute)** |
| **Latency** | 800 ms - 2.500 ms | < 1 ms |
| **Availability** | Depends on connectivity & billing | **100% Offline-capable** |

### Real-World Failover Evidence from `/api/status`:
When the `/api/status` endpoint was inspected directly on the production server:
```json
{
  "brain": "llm",
  "herd": 19,
  "feed": 400,
  "spend": {
    "dayKey": "2026-09-21",
    "usd": 0,
    "calls": 0,
    "cap": 6
  },
  "llm": {
    "calls": 6,
    "failures": 6,
    "promptTokens": 0,
    "completionTokens": 0,
    "lastError": "LLM 429: {\\n    \\\"error\\\": {\\n        \\\"message\\\": \\\"You have no credits remaining. Add credits to continue using the API at https://platform.openai.com/settings/organization/billing/.\\\",\\n        \\\"type\\\": \\\"insufficient\\\"}\"\n  }
}
```
**Findings Analysis:**
* The developer account's OpenAI quota was exhausted (HTTP 429 Insufficient Quota).
* However, the `tryllamabook.com` website **kept running smoothly without errors**. All agents in town kept moving, eating, sleeping, and chatting because the engine automatically fell back to **Rule-Based SIM Mode**.
* There is a daily `spend.cap` protection (e.g. a $6/day cap) to prevent sudden credit drain caused by activity spikes.

---

## 5. Data Storage & Atomic Persistence

World storage does not use a heavy SQL/NoSQL database, but rather **Atomic File System Storage**:

1. **Debounced Batching:**
   Routine changes (such as need fluctuations or small position shifts) are batched with a short debounce interval before being written to disk.
2. **Immediate Flush for Mutations:**
   Mutation actions from visitors (`POST /api/fork`) are executed with an instant `flush`. The API will not return an HTTP 200 response before the file is successfully synced to storage.
3. **Atomic Rename Pattern:**
   * Data is prepared and written to a process-specific temporary file: `data/town.tmp.<pid>`.
   * Calls `fsync` to ensure the data reaches physical media.
   * The previous primary file is copied to a backup: `data/town.backup.json`.
   * The temporary file is atomically renamed, overwriting `data/town.json`.
4. **Crash Recovery:**
   If the server experiences a power loss or crash during the write process, on reboot the server will detect corruption in `town.json` and automatically restore from `town.backup.json`.
