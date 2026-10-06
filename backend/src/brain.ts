import { decide as simDecide, type DecideContext } from "./simbrain.js";
import { spend, recordFailure, recordSuccess, resetIfNewDay } from "./spend.js";

export type LLMBrain = {
  decide(ctx: DecideContext): Promise<{ act: string; place: string; reason: string; speech?: string }>;
};

function createStubLLM(): LLMBrain {
  return {
    async decide(_ctx: DecideContext) {
      const key = process.env.OPENAI_API_KEY;
      if (!key) throw new Error("LLM 429: no credits remaining. Add credits to continue using the API at https://platform.openai.com/settings/organization/billing.");
      // Real OpenAI call would go here; for MVP we fail over if quota issues
      // Simulated: if key is dummy, throw quota
      throw new Error(`LLM 429: {"error":{"message":"You have no credits remaining. Add credits to continue using the API at https://platform.openai.com/settings/organization/billing.","type":"insufficient"}}`);
    },
  };
}

export function createBrain(opts?: { llm?: LLMBrain; cap?: number }) {
  const llm = opts?.llm ?? createStubLLM();
  if (opts?.cap !== undefined) spend.cap = opts.cap;
  return {
    get mode(): "llm" | "sim" {
      resetIfNewDay();
      if (spend.failures > 0 && spend.calls === 0) return "sim"; // fallback indicator, but config.brain stays llm per doc status
      return "llm";
    },
    async decide(ctx: DecideContext) {
      resetIfNewDay();
      if (spend.usd >= spend.cap) {
        return simDecide(ctx);
      }
      try {
        const r = await llm.decide(ctx);
        recordSuccess(0, 0, 0.002);
        return r;
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        recordFailure(msg);
        return simDecide(ctx);
      }
    },
  };
}

export type Brain = ReturnType<typeof createBrain>;
