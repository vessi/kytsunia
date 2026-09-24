type Pricing = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

// Пошук тарифікується окремо від токенів: $10 за 1000 запитів, для всіх моделей.
const WEB_SEARCH_USD = 0.01;

const PRICING: Record<string, Pricing> = {
  "claude-haiku-4-5-20251001": {
    input: 1.0,
    output: 5.0,
    cacheRead: 0.1,
    cacheWrite: 1.25,
  },
  "claude-haiku-4-5": {
    input: 1.0,
    output: 5.0,
    cacheRead: 0.1,
    cacheWrite: 1.25,
  },
  "claude-opus-5": {
    input: 5.0,
    output: 25.0,
    cacheRead: 0.5,
    cacheWrite: 6.25,
  },
  "claude-sonnet-4-6": {
    input: 3.0,
    output: 15.0,
    cacheRead: 0.3,
    cacheWrite: 3.75,
  },
  // Дефолтна модель дайджесту. Дешевша за sonnet-4-6 і свіжіша.
  "claude-sonnet-5": {
    input: 2.0,
    output: 10.0,
    cacheRead: 0.2,
    cacheWrite: 2.5,
  },
};

// Моделі, які можна вибрати для чату командою «Кицюня, модель».
export const KNOWN_MODELS: readonly string[] = Object.keys(PRICING);

export type Usage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  webSearchRequests?: number;
};

export function calculateCost(model: string, usage: Usage): number | null {
  const price = PRICING[model];
  if (!price) return null;

  const inputUsd = (usage.inputTokens * price.input) / 1_000_000;
  const outputUsd = (usage.outputTokens * price.output) / 1_000_000;
  const cacheReadUsd = (usage.cacheReadTokens * price.cacheRead) / 1_000_000;
  const cacheWriteUsd = (usage.cacheWriteTokens * price.cacheWrite) / 1_000_000;
  const webSearchUsd = (usage.webSearchRequests ?? 0) * WEB_SEARCH_USD;

  return inputUsd + outputUsd + cacheReadUsd + cacheWriteUsd + webSearchUsd;
}
