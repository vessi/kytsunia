import type { Context } from "grammy";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startTyping } from "../../src/shell/typing.js";

function makeCtx(impl: () => Promise<true>) {
  const replyWithChatAction = vi.fn(impl);
  return { ctx: { replyWithChatAction } as unknown as Context, replyWithChatAction };
}

describe("startTyping", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends typing immediately and refreshes it until stopped", () => {
    const { ctx, replyWithChatAction } = makeCtx(() => Promise.resolve(true));

    const stop = startTyping(ctx, 4000);
    expect(replyWithChatAction).toHaveBeenCalledWith("typing");
    expect(replyWithChatAction).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(8000);
    expect(replyWithChatAction).toHaveBeenCalledTimes(3);

    stop();
    vi.advanceTimersByTime(8000);
    expect(replyWithChatAction).toHaveBeenCalledTimes(3);
  });

  it("swallows a rejected chat action", async () => {
    const { ctx, replyWithChatAction } = makeCtx(() =>
      Promise.reject(new Error("not enough rights to send chat actions")),
    );

    const stop = startTyping(ctx, 4000);
    await vi.advanceTimersByTimeAsync(4000);
    stop();

    expect(replyWithChatAction).toHaveBeenCalledTimes(2);
  });

  it("swallows a synchronous throw for an update without a chat", () => {
    const { ctx } = makeCtx(() => {
      throw new Error("Missing information for API call to sendChatAction");
    });

    expect(() => startTyping(ctx, 4000)()).not.toThrow();
  });
});
