import { describe, expect, it } from "vitest";
import type { UsageSummary } from "../../src/shell/storage/llm-calls.js";
import { formatUsageReport } from "../../src/shell/usage-report.js";

const empty: UsageSummary = {
  ok: {
    calls: 0,
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  },
  errors: 0,
  rateLimited: 0,
  byChat: [],
  byUser: [],
  byModel: [],
};

// 2026-09-06T00:00:00 за Києвом.
const SINCE = Date.UTC(2026, 8, 5, 21);

describe("formatUsageReport", () => {
  it("says so when there were no calls at all", () => {
    const text = formatUsageReport({
      days: 7,
      sinceTs: SINCE,
      period: empty,
      today: empty,
      currentChatId: 1,
    });
    expect(text).toBe("Звіт за 7 днів, з 06.09.2026\nВикликів не було.");
  });

  it("renders totals, cache share, breakdowns and today's line", () => {
    const period: UsageSummary = {
      ok: {
        calls: 42,
        costUsd: 0.83,
        inputTokens: 12_000,
        outputTokens: 4_000,
        cacheReadTokens: 108_000,
        cacheWriteTokens: 0,
      },
      errors: 1,
      rateLimited: 3,
      byChat: [
        {
          chatId: -100,
          calls: 30,
          costUsd: 0.61,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
        {
          chatId: -200,
          calls: 12,
          costUsd: 0.22,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      ],
      byUser: [
        { userId: 1, userName: "Андрій", calls: 21, costUsd: 0.4 },
        { userId: 2, userName: "", calls: 2, costUsd: 0.02 },
      ],
      byModel: [{ model: "claude-sonnet-5", calls: 42, costUsd: 0.83 }],
    };
    const today: UsageSummary = {
      ...empty,
      ok: { ...empty.ok, calls: 5, costUsd: 0.09 },
    };

    const text = formatUsageReport({ days: 7, sinceTs: SINCE, period, today, currentChatId: -100 });
    expect(text).toBe(
      [
        "Звіт за 7 днів, з 06.09.2026",
        "Викликів: 42, разом $0.830",
        "Токени: 120k вхідних, з них 90% з кешу; 4000 вихідних",
        "Помилок: 1, відмов по ліміту: 3",
        "",
        "По чатах:",
        "цей чат: 30 викликів, $0.610",
        "-200: 12 викликів, $0.220",
        "",
        "По людях:",
        "Андрій: 21 виклик, $0.400",
        "2: 2 виклики, $0.020",
        "",
        "Сьогодні: 5 викликів, $0.090",
      ].join("\n"),
    );
  });

  it("lists models only when there is more than one", () => {
    const period: UsageSummary = {
      ...empty,
      ok: { ...empty.ok, calls: 3, costUsd: 1.5 },
      byModel: [
        { model: "claude-sonnet-5", calls: 2, costUsd: 1.2 },
        { model: "claude-haiku-4-5-20251001", calls: 1, costUsd: 0.3 },
      ],
    };
    const text = formatUsageReport({
      days: 1,
      sinceTs: SINCE,
      period,
      today: period,
      currentChatId: 1,
    });
    expect(text).toContain("Звіт за 1 день");
    expect(text).toContain(
      "По моделях:\nclaude-sonnet-5: 2 виклики, $1.20\nclaude-haiku-4-5-20251001: 1 виклик, $0.300",
    );
    expect(text).not.toContain("Помилок");
  });
});
