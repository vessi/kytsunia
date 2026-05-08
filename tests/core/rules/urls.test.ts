import { describe, expect, it } from "vitest";
import { rewriteInstagramUrl, rewriteXUrl } from "../../../src/core/rules/urls.js";

describe("rewriteInstagramUrl", () => {
  it("rewrites a bare instagram link", () => {
    expect(rewriteInstagramUrl("https://instagram.com/p/abc123/")).toBe(
      "https://ddinstagram.com/p/abc123/",
    );
  });

  it("rewrites a www.instagram.com link", () => {
    expect(rewriteInstagramUrl("https://www.instagram.com/p/abc123")).toBe(
      "https://ddinstagram.com/p/abc123",
    );
  });

  it("captures multi-segment path", () => {
    expect(rewriteInstagramUrl("https://instagram.com/user/reel/12345")).toBe(
      "https://ddinstagram.com/user/reel/12345",
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
      "https://ddinstagram.com/p/xxx тут смішно",
    );
    // Так, "тут смішно" потрапить у вихідний URL.
    // Це не баг рефакторингу, а збережена поведінка.
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
