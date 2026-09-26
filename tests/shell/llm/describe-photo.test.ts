import type Database from "better-sqlite3";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LlmClient, LlmReply, UserContent } from "../../../src/shell/llm/anthropic.js";
import {
  makePhotoDescriber,
  PHOTO_DESCRIBE_PROMPT,
} from "../../../src/shell/llm/describe-photo.js";
import { makeLlmCallStore } from "../../../src/shell/storage/llm-calls.js";
import { makePhotoDescriptionStore } from "../../../src/shell/storage/photo-descriptions.js";
import { openTestDb } from "../../helpers/db.js";

const silentLog = pino({ level: "silent" });

describe("photo describer", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openTestDb();
  });

  afterEach(() => {
    db.close();
  });

  function make(text = "  Надкушений сінабон\nна тарілці. ", fail = false) {
    const calls: Array<{ system: unknown; content: UserContent; model: string }> = [];
    const client: LlmClient = {
      reply: async (system, content, model): Promise<LlmReply> => {
        calls.push({ system, content, model });
        if (fail) throw new Error("boom");
        return {
          text,
          inputTokens: 1500,
          outputTokens: 20,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        };
      },
    };
    const store = makePhotoDescriptionStore(db);
    const llmCallStore = makeLlmCallStore(db);
    const fetcher = vi.fn().mockResolvedValue({ mime: "image/jpeg", base64: "B64" });
    const describe = makePhotoDescriber({
      llmClient: client,
      llmCallStore,
      store,
      photoFetcher: fetcher,
      model: "claude-haiku-4-5",
      log: silentLog,
    });
    return { describe, calls, store, llmCallStore, fetcher };
  }

  const photo = { fileId: "f", uniqueId: "u1" };
  const ctx = { chatId: 1, userId: 7, userName: "Andriy" };

  it("fetches, describes with the image, normalises whitespace and caches", async () => {
    const { describe, calls, store, fetcher } = make();
    const first = await describe(photo, ctx);
    expect(first).toEqual({ text: "Надкушений сінабон на тарілці.", generated: true });
    expect(fetcher).toHaveBeenCalledWith("f", "u1");
    expect(calls[0]?.system).toBe(PHOTO_DESCRIBE_PROMPT);
    expect(calls[0]?.model).toBe("claude-haiku-4-5");
    expect((calls[0]?.content as Array<{ type: string }>)[0]?.type).toBe("image");
    expect(store.get("u1")).toBe("Надкушений сінабон на тарілці.");

    const second = await describe(photo, ctx);
    expect(second).toEqual({ text: "Надкушений сінабон на тарілці.", generated: false });
    expect(calls).toHaveLength(1);
  });

  it("serves only the cache when generation is not allowed", async () => {
    const { describe, calls, store } = make();
    expect(await describe(photo, ctx, { allowGenerate: false })).toBeNull();
    expect(calls).toHaveLength(0);
    store.put("u1", "з кешу", "m");
    expect(await describe(photo, ctx, { allowGenerate: false })).toEqual({
      text: "з кешу",
      generated: false,
    });
  });

  it("records the call with weight 0 so it never eats a daily slot", async () => {
    const { describe, llmCallStore } = make();
    await describe(photo, ctx);
    const row = db.prepare("SELECT weight, status, chat_id FROM llm_calls").get() as {
      weight: number;
      status: string;
      chat_id: number;
    };
    expect(row).toEqual({ weight: 0, status: "ok", chat_id: 1 });
    expect(llmCallStore.checkUserRate(7, 15).used).toBe(0);
  });

  it("returns null and records an error when the model fails", async () => {
    const { describe, store } = make("x", true);
    expect(await describe(photo, ctx)).toBeNull();
    expect(store.get("u1")).toBeNull();
    const row = db.prepare("SELECT status FROM llm_calls").get() as { status: string };
    expect(row.status).toBe("error");
  });

  it("returns null on an empty description without caching", async () => {
    const { describe, store } = make("   ");
    expect(await describe(photo, ctx)).toBeNull();
    expect(store.get("u1")).toBeNull();
  });
});
