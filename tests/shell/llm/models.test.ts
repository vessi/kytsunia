import { describe, expect, it } from "vitest";
import { modelChoicesHelp, resolveModel } from "../../../src/shell/llm/models.js";

describe("resolveModel", () => {
  it("maps short names to the current generation", () => {
    expect(resolveModel("opus")).toBe("claude-opus-5-5");
    expect(resolveModel("Sonnet")).toBe("claude-sonnet-5");
    expect(resolveModel(" haiku ")).toBe("claude-haiku-4-5");
  });

  it("accepts full ids that have pricing", () => {
    expect(resolveModel("claude-sonnet-4-6")).toBe("claude-sonnet-4-6");
    expect(resolveModel("claude-opus-5")).toBe("claude-opus-5");
  });

  it("rejects unknown models", () => {
    expect(resolveModel("gpt-5")).toBeNull();
    expect(resolveModel("claude-opus-9")).toBeNull();
  });

  it("lists the choices in the help text", () => {
    expect(modelChoicesHelp()).toContain("opus");
    expect(modelChoicesHelp()).toContain("claude-sonnet-5");
  });
});
