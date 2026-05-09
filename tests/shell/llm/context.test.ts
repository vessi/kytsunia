import { describe, expect, it } from "vitest";
import { buildLlmRequest } from "../../../src/shell/llm/context.js";

describe("buildLlmRequest", () => {
  it("includes persona alone when no recent messages", () => {
    const req = buildLlmRequest({ senderName: "Andriy", text: "привіт" }, [], "PERSONA");
    expect(req.system).toBe("PERSONA");
    expect(req.userMessage).toBe("Andriy: привіт");
  });

  it("appends recent context after persona", () => {
    const req = buildLlmRequest(
      { senderName: "Andriy", text: "привіт" },
      [
        { senderName: "Olha", text: "доброго дня" },
        { senderName: "Stepan", text: "як справи" },
      ],
      "PERSONA",
    );
    expect(req.system).toContain("PERSONA");
    expect(req.system).toContain("Olha: доброго дня");
    expect(req.system).toContain("Stepan: як справи");
    expect(req.userMessage).toBe("Andriy: привіт");
  });

  it("includes profiles section when profiles provided", () => {
    const req = buildLlmRequest({ senderName: "Andriy", text: "привіт" }, [], "PERSONA", [
      { displayName: "Andriy", profile: "Snarky engineer." },
    ]);
    expect(req.system).toContain("PERSONA");
    expect(req.system).toContain("Профілі учасників");
    expect(req.system).toContain("Snarky engineer.");
  });

  it("orders sections persona → profiles → recent", () => {
    const req = buildLlmRequest(
      { senderName: "Andriy", text: "?" },
      [{ senderName: "Olha", text: "тут" }],
      "PERSONA",
      [{ displayName: "Andriy", profile: "PROFILE" }],
    );
    const personaIdx = req.system.indexOf("PERSONA");
    const profileIdx = req.system.indexOf("PROFILE");
    const contextIdx = req.system.indexOf("Контекст");
    expect(personaIdx).toBeLessThan(profileIdx);
    expect(profileIdx).toBeLessThan(contextIdx);
  });
});
