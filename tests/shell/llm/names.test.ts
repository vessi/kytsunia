import { describe, expect, it } from "vitest";
import { displayWithHandle } from "../../../src/shell/llm/names.js";

describe("displayWithHandle", () => {
  it("joins name and handle", () => {
    expect(displayWithHandle("Оля", "olya_k")).toBe("Оля (@olya_k)");
  });

  it("falls back to whichever part exists", () => {
    expect(displayWithHandle("Оля", null)).toBe("Оля");
    expect(displayWithHandle("Оля", undefined)).toBe("Оля");
    expect(displayWithHandle("", "olya_k")).toBe("@olya_k");
    expect(displayWithHandle("", null)).toBe("");
  });
});
