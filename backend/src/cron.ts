import type { TownSnapshot } from "@hermesbook/shared";
import type { Brain } from "./brain.js";
import type { Scheduler } from "./scheduler.js";
import { runTurn } from "./turn.js";

// Cron adapter: batched ticks alternative to setInterval in server.ts
// Usage: if (process.env.CRON_ENABLED === "true") startCron(world, scheduler, brain, broadcast)

export function startCron(
  world: TownSnapshot,
  scheduler: Scheduler,
  brain: Brain,
  broadcast: (msg: unknown) => void
): { stop: () => void } {
  // For MVP, we use setInterval as cron-like, but shaped for node-cron / Vercel Cron
  // To use real node-cron: import cron from "node-cron"; cron.schedule("*/10 * * * * *", tick);
  const interval = setInterval(async () => {
    // Burst 3-5 agents per cron tick (vs 1 per TURN_MS in setInterval mode)
    const burst = 3 + Math.floor(Math.random() * 2);
    for (let i = 0; i < burst; i++) {
      const id = scheduler.next();
      if (!id) break;
      const result = await runTurn(world, id, brain);
      if (!result.order) continue;
      broadcast(result.order);
      if (result.spit) broadcast(result.spit);
      if (result.post) broadcast({ type: "post", post: result.post });
      // Note: edition/weather handled in server.ts turnCount logic; if migrated to cron, move that logic here
    }
  }, 10000); // every 10s

  if (typeof (interval as NodeJS.Timeout).unref === "function") (interval as NodeJS.Timeout).unref();

  return {
    stop() {
      clearInterval(interval);
    },
  };
}

// Vercel Cron handler placeholder
// export async function handleVercelCron(req: Request) {
//   if (req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) return new Response("unauthorized", { status: 401 });
//   // tick once
//   return Response.json({ ok: true });
// }
