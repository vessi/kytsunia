import { describe, expect, it } from "vitest";
import {
  matchUrlRewrites,
  rewriteInstagramUrl,
  rewriteXUrl,
} from "../../../src/core/rules/urls.js";
import type { MessageInput } from "../../../src/core/types.js";

describe("rewriteInstagramUrl", () => {
  it("rewrites a bare instagram link", () => {
    expect(rewriteInstagramUrl("https://instagram.com/p/abc123/")).toBe(
      "https://eeinstagram.com/p/abc123/",
    );
  });

  it("rewrites a www.instagram.com link", () => {
    expect(rewriteInstagramUrl("https://www.instagram.com/p/abc123")).toBe(
      "https://eeinstagram.com/p/abc123",
    );
  });

  it("captures multi-segment path", () => {
    expect(rewriteInstagramUrl("https://instagram.com/user/reel/12345")).toBe(
      "https://eeinstagram.com/user/reel/12345",
    );
  });

  it("returns null for unrelated text", () => {
    expect(rewriteInstagramUrl("nothing relevant here")).toBeNull();
  });

  it("returns null for non-instagram url", () => {
    expect(rewriteInstagramUrl("https://example.com/foo")).toBeNull();
  });

  it("matches inside a larger message", () => {
    // Зберігаємо поведінку оригіналу: regex не має $-якоря,
    // знаходить URL як підрядок.
    expect(rewriteInstagramUrl("дивись що знайшов: https://instagram.com/p/xxx тут смішно")).toBe(
      "https://eeinstagram.com/p/xxx тут смішно",
    );
    // Так, "тут смішно" потрапить у вихідний URL.
    // Це не баг рефакторингу, а збережена поведінка.
  });

  it("does not match instagrammcom (escape fix)", () => {
    expect(rewriteInstagramUrl("https://instagrammcom/p/abc")).toBeNull();
  });
});

describe("rewriteXUrl", () => {
  it("rewrites an x.com link", () => {
    expect(rewriteXUrl("https://x.com/user/status/123")).toBe(
      "https://fxtwitter.com/user/status/123",
    );
  });

  it("rewrites a twitter.com link", () => {
    expect(rewriteXUrl("https://twitter.com/user/status/123")).toBe(
      "https://fxtwitter.com/user/status/123",
    );
  });

  it("rewrites a www.x.com link", () => {
    expect(rewriteXUrl("https://www.x.com/user/status/123")).toBe(
      "https://fxtwitter.com/user/status/123",
    );
  });

  it("returns null for unrelated text", () => {
    expect(rewriteXUrl("hello world")).toBeNull();
  });

  it("returns null for non-x url", () => {
    expect(rewriteXUrl("https://facebook.com/foo")).toBeNull();
  });
});

function buildInput(text: string, messageId = 1): MessageInput {
  return {
    text,
    messageId,
    chatId: 1,
    senderId: 1,
    senderName: "x",
    ts: 0,
    kind: "text",
  };
}

describe("matchUrlRewrites", () => {
  it("wraps instagram rewrite in reply_text action", () => {
    const result = matchUrlRewrites(buildInput("https://instagram.com/p/abc", 42));
    expect(result?.[0]?.kind).toBe("reply_text");
    if (result?.[0]?.kind === "reply_text") {
      expect(result[0].text).toBe("https://eeinstagram.com/p/abc");
      expect(result[0].replyTo).toBe(42);
    }
  });

  it("wraps x rewrite in reply_text action", () => {
    const result = matchUrlRewrites(buildInput("https://x.com/u/status/1"));
    if (result?.[0]?.kind === "reply_text") {
      expect(result[0].text).toBe("https://fxtwitter.com/u/status/1");
    }
  });

  it("returns null for unrelated text", () => {
    expect(matchUrlRewrites(buildInput("просто текст"))).toBeNull();
  });
});
