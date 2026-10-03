import { describe, expect, it } from "vitest";
import { messageLink } from "../../src/shell/tg-links.js";

describe("messageLink", () => {
  it("builds supergroup links and refuses basic groups and privates", () => {
    expect(messageLink(-1001407977544, 42)).toBe("https://t.me/c/1407977544/42");
    expect(messageLink(-4205862514, 42)).toBeNull();
    expect(messageLink(53569574, 42)).toBeNull();
  });
});
