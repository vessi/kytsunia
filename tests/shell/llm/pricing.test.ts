import { describe, expect, it } from "vitest";
import { calculateCost } from "../../../src/shell/llm/pricing.js";

describe("calculateCost", () => {
  it("returns null for unknown model", () => {
    expect(
      calculateCost("unknown-model", {
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }),
    ).toBeNull();
  });

  it("calculates Haiku 4.5 cost correctly", () => {
    const cost = calculateCost("claude-haiku-4-5-20251001", {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(cost).toBeCloseTo(1.0 + 5.0, 5);
  });

  it("includes cache token costs", () => {
    const cost = calculateCost("claude-haiku-4-5-20251001", {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(0.1 + 1.25, 5);
  });
});
