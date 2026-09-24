import type { Context } from "grammy";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import type {
  LlmClient,
  LlmReply,
  SystemContent,
  UserContent,
} from "../../../src/shell/llm/anthropic.js";
import {
  type InvokeRosterDeps,
  invokeRoster,
  ROSTER_PROMPT,
  renderRosterProfiles,
  selectRosterProfiles,
} from "../../../src/shell/llm/roster.js";
import type { RegularProfile } from "../../../src/shell/storage/regulars.js";

const silentLog = pino({ level: "silent" });

function profile(
  userId: number,
  name: string,
  text: string,
  extra: Partial<RegularProfile> = {},
): RegularProfile {
  return {
    userId,
    chatId: 1,
    displayName: name,
    profile: text,
    messageCount: 100 - userId,
    lastMessageTs: 0,
    generatedAt: 0,
    manualNotes: null,
    ...extra,
  };
}

function makeCtx() {
  const reply = vi.fn().mockResolvedValue({ message_id: 5, date: 0 });
  const ctx = {
    message: { message_id: 999, chat: { id: 1 }, from: { id: 7, first_name: "Andriy" }, date: 0 },
    chat: { id: 1 },
    from: { id: 7, first_name: "Andriy" },
    reply,
  } as unknown as Context;
  return { ctx, reply };
}

function makeLlm(text = "Andriy — любить віскі.\n\nOlha — бігає.") {
  const calls: Array<{
    system: SystemContent;
    content: UserContent;
    model: string;
    maxTokens?: number;
  }> = [];
  const client: LlmClient = {
    reply: async (system, content, model, maxTokens): Promise<LlmReply> => {
      calls.push({ system, content, model, ...(maxTokens !== undefined ? { maxTokens } : {}) });
      return { text, inputTokens: 500, outputTokens: 80, cacheReadTokens: 0, cacheWriteTokens: 0 };
    },
  };
  return { client, calls };
}

function makeDeps(
  profiles: RegularProfile[],
  overrides: Partial<InvokeRosterDeps> = {},
): InvokeRosterDeps {
  return {
    llmClient: makeLlm().client,
    llmCallStore: {
      record: vi.fn(),
      checkUserRate: vi.fn().mockReturnValue({ used: 0, limit: 15, allowed: true }),
      checkGlobalRate: vi.fn().mockReturnValue({ used: 0, cap: 150, allowed: true }),
      usageSummary: vi.fn(),
    },
    regularsStore: {
      upsert: vi.fn(),
      get: vi.fn(),
      list: vi.fn(() => profiles),
      listByChat: vi.fn((chatId: number) => profiles.filter((p) => p.chatId === chatId)),
      remove: vi.fn(),
      removeAllForUser: vi.fn(),
      setManualNotes: vi.fn(),
    },
    optedOutUserIds: () => new Set(),
    instructionStore: { list: vi.fn(() => []), add: vi.fn(), remove: vi.fn() },
    chatSettings: {
      getModel: vi.fn(() => null),
      setModel: vi.fn(),
      clearModel: vi.fn(),
      getPersona: vi.fn(() => null),
      setPersona: vi.fn(),
      clearPersona: vi.fn(),
      getDigestMaxCount: vi.fn(() => null),
      setDigestMaxCount: vi.fn(),
      clearDigestMaxCount: vi.fn(),
      getDigestModel: vi.fn(() => null),
      setDigestModel: vi.fn(),
      clearDigestModel: vi.fn(),
    },
    model: "claude-sonnet-5",
    digestModel: "claude-sonnet-5",
    persona: (model, digestModel, character) => `P:${model}/${digestModel}/${character}`,
    defaultDailyLimit: 15,
    globalDailyCap: 150,
    log: silentLog,
    startTyping: vi.fn(() => vi.fn()),
    ...overrides,
  };
}

describe("selectRosterProfiles", () => {
  it("drops opted-out users and caps the list", () => {
    const all = Array.from({ length: 25 }, (_, i) => profile(i + 1, `U${i + 1}`, "x"));
    const picked = selectRosterProfiles(all, new Set([2]), 20);
    expect(picked).toHaveLength(20);
    expect(picked.some((p) => p.userId === 2)).toBe(false);
  });
});

describe("renderRosterProfiles", () => {
  it("renders name, profile and admin notes as a marked line", () => {
    const text = renderRosterProfiles([
      profile(1, "Olha", "Бігає.", { manualNotes: "Без «тітко»." }),
      profile(2, null as unknown as string, "Тихий.", { displayName: null }),
    ]);
    expect(text).toBe("Olha:\nБігає.\nСлужбові примітки: Без «тітко».\n\n2:\nТихий.");
  });
});

describe("invokeRoster", () => {
  it("answers without the model when the chat has no profiles", async () => {
    const { ctx, reply } = makeCtx();
    const llm = makeLlm();
    await invokeRoster(ctx, 999, makeDeps([], { llmClient: llm.client }));
    expect(llm.calls).toHaveLength(0);
    expect(reply.mock.calls[0]?.[0]).toContain("нікого");
  });

  it("sends the chat's persona as the cached block, the task next, profiles in the message", async () => {
    const { ctx, reply } = makeCtx();
    const llm = makeLlm();
    const deps = makeDeps([profile(7, "Andriy", "Любить віскі."), profile(8, "Olha", "Бігає.")], {
      llmClient: llm.client,
    });
    (deps.chatSettings.getPersona as ReturnType<typeof vi.fn>).mockReturnValue("Ти сумна сова.");
    (deps.instructionStore.list as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: 1, chatId: 1, text: "Хвали Олю.", createdAt: 0 },
    ]);
    await invokeRoster(ctx, 999, deps);

    const system = llm.calls[0]?.system as Array<{ text: string; cache_control?: unknown }>;
    expect(system[0]?.text).toContain("P:claude-sonnet-5/claude-sonnet-5/Ти сумна сова.");
    expect(system[0]?.text).toContain("Хвали Олю.");
    expect(system[0]?.cache_control).toBeDefined();
    expect(system[1]?.text).toBe(ROSTER_PROMPT);
    expect(llm.calls[0]?.content).toContain("Andriy:\nЛюбить віскі.");
    expect(llm.calls[0]?.content).toContain("Olha:\nБігає.");
    expect(reply.mock.calls[0]?.[0]).toBe("Andriy — любить віскі.\n\nOlha — бігає.");
    expect(deps.llmCallStore.record).toHaveBeenCalledWith(
      expect.objectContaining({ status: "ok", weight: 1, model: "claude-sonnet-5" }),
    );
  });

  it("uses the chat's model override", async () => {
    const { ctx } = makeCtx();
    const llm = makeLlm();
    const deps = makeDeps([profile(7, "Andriy", "x")], { llmClient: llm.client });
    (deps.chatSettings.getModel as ReturnType<typeof vi.fn>).mockReturnValue("claude-opus-5");
    await invokeRoster(ctx, 999, deps);
    expect(llm.calls[0]?.model).toBe("claude-opus-5");
  });

  it("respects the user's daily limit", async () => {
    const { ctx, reply } = makeCtx();
    const llm = makeLlm();
    const deps = makeDeps([profile(7, "Andriy", "x")], { llmClient: llm.client });
    (deps.llmCallStore.checkUserRate as ReturnType<typeof vi.fn>).mockReturnValue({
      used: 15,
      limit: 15,
      allowed: false,
    });
    await invokeRoster(ctx, 999, deps);
    expect(llm.calls).toHaveLength(0);
    expect(deps.llmCallStore.record).toHaveBeenCalledWith(
      expect.objectContaining({ status: "rate_limited", errorMessage: "user_limit" }),
    );
    expect(reply).toHaveBeenCalled();
  });

  it("reports a failure and clears typing", async () => {
    const { ctx, reply } = makeCtx();
    const stop = vi.fn();
    const client: LlmClient = {
      reply: async () => {
        throw new Error("boom");
      },
    };
    const deps = makeDeps([profile(7, "Andriy", "x")], {
      llmClient: client,
      startTyping: vi.fn(() => stop),
    });
    await invokeRoster(ctx, 999, deps);
    expect(reply.mock.calls[0]?.[0]).toContain("не вийшло");
    expect(stop).toHaveBeenCalledTimes(1);
    expect(deps.llmCallStore.record).toHaveBeenCalledWith(
      expect.objectContaining({ status: "error", errorMessage: "boom" }),
    );
  });
});
