export interface SpendState {
  dayKey: string;
  usd: number;
  calls: number;
  failures: number;
  cap: number;
  promptTokens: number;
  completionTokens: number;
  lastError: string | null;
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

export const spend: SpendState = {
  dayKey: todayKey(),
  usd: 0,
  calls: 0,
  failures: 0,
  cap: 6,
  promptTokens: 0,
  completionTokens: 0,
  lastError: null,
};

export function resetIfNewDay(): void {
  const k = todayKey();
  if (k !== spend.dayKey) {
    spend.dayKey = k;
    spend.usd = 0;
    spend.calls = 0;
    spend.failures = 0;
    spend.promptTokens = 0;
    spend.completionTokens = 0;
    spend.lastError = null;
  }
}

export function recordFailure(err: string): void {
  spend.failures++;
  spend.lastError = err;
}

export function recordSuccess(promptTokens = 0, completionTokens = 0, costUsd = 0): void {
  spend.calls++;
  spend.promptTokens += promptTokens;
  spend.completionTokens += completionTokens;
  spend.usd += costUsd;
}
