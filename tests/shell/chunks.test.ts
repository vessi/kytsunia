import type { Context } from "grammy";
import { describe, expect, it, vi } from "vitest";
import { replyInChunks, splitForTelegram } from "../../src/shell/chunks.js";

describe("splitForTelegram", () => {
  it("leaves short text alone", () => {
    expect(splitForTelegram("коротко", 100)).toEqual(["коротко"]);
  });

  it("prefers a paragraph break, then a line break, then a space", () => {
    expect(splitForTelegram("абзац один\n\nабзац два\n\nабзац три", 24)).toEqual([
      "абзац один\n\nабзац два",
      "абзац три",
    ]);
    expect(splitForTelegram("рядок один\nрядок два\nрядок три", 22)).toEqual([
      "рядок один\nрядок два",
      "рядок три",
    ]);
    expect(splitForTelegram("слово слово слово слово", 13)).toEqual(["слово слово", "слово слово"]);
  });

  it("does not take a break that would leave the chunk under half the limit", () => {
    // «\n\n» на позиції 2 — надто рано; ріжемо по пробілу далі.
    const out = splitForTelegram("ab\n\ncccc dddd eeee", 12);
    expect(out[0]?.length).toBeGreaterThanOrEqual(6);
  });

  it("hard-cuts a single long word without splitting a surrogate pair", () => {
    const out = splitForTelegram("абвг😺дежз", 5);
    expect(out[0]).toBe("абвг");
    expect(out.join("")).toBe("абвг😺дежз");
  });

  it("caps the number of messages and marks the truncated tail", () => {
    const out = splitForTelegram("x".repeat(100), 10);
    expect(out).toHaveLength(5);
    expect(out[4]?.endsWith("…")).toBe(true);
    expect(out[4]?.length).toBeLessThanOrEqual(10);
  });
});

describe("replyInChunks", () => {
  it("replies to the trigger with the first chunk and sends the rest plainly", async () => {
    const reply = vi.fn().mockResolvedValue({});
    const ctx = { reply } as unknown as Context;
    await replyInChunks(ctx, `${"a".repeat(3000)}\n\n${"b".repeat(3000)}`, 7);
    expect(reply).toHaveBeenCalledTimes(2);
    expect(reply.mock.calls[0]?.[1]).toEqual({ reply_to_message_id: 7 });
    expect(reply.mock.calls[1]?.[1]).toEqual({});
  });
});
