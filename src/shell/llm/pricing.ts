type Pricing = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

const PRICING: Record<string, Pricing> = {
  "claude-haiku-4-5-20251001": {
    input: 1.0,
    output: 5.0,
    cacheRead: 0.1,
    cacheWrite: 1.25,
  },
  "claude-sonnet-4-6": {
    input: 3.0,
    output: 15.0,
    cacheRead: 0.3,
    cacheWrite: 3.75,
  },
};

export type Usage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

export function calculateCost(model: string, usage: Usage): number | null {
  const price = PRICING[model];
  if (!price) return null;

  const inputUsd = (usage.inputTokens * price.input) / 1_000_000;
  const outputUsd = (usage.outputTokens * price.output) / 1_000_000;
  const cacheReadUsd = (usage.cacheReadTokens * price.cacheRead) / 1_000_000;
  const cacheWriteUsd = (usage.cacheWriteTokens * price.cacheWrite) / 1_000_000;

  return inputUsd + outputUsd + cacheReadUsd + cacheWriteUsd;
}
