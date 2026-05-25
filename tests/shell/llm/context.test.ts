import { describe, expect, it } from "vitest";
import { buildLlmRequest } from "../../../src/shell/llm/context.js";

function joinSystem(system: ReadonlyArray<{ text: string }>): string {
  return system.map((b) => b.text).join("\n\n");
}

describe("buildLlmRequest", () => {
  it("includes persona alone when no recent messages", () => {
    const req = buildLlmRequest({ senderName: "Andriy", text: "привіт" }, [], "PERSONA");
    expect(req.system).toHaveLength(1);
    expect(req.system[0]?.text).toBe("PERSONA");
    expect(req.userMessage).toBe("Andriy: привіт");
  });

  it("puts cache_control on persona block only", () => {
    const req = buildLlmRequest(
      { senderName: "Andriy", text: "привіт" },
      [{ senderName: "Olha", text: "тут" }],
      "PERSONA",
      [{ displayName: "Andriy", profile: "PROFILE" }],
    );
    expect(req.system).toHaveLength(2);
    expect(req.system[0]?.cache_control).toEqual({ type: "ephemeral" });
    expect(req.system[1]?.cache_control).toBeUndefined();
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
    const text = joinSystem(req.system);
    expect(text).toContain("PERSONA");
    expect(text).toContain("Olha: доброго дня");
    expect(text).toContain("Stepan: як справи");
    expect(req.userMessage).toBe("Andriy: привіт");
  });

  it("includes profiles section when profiles provided", () => {
    const req = buildLlmRequest({ senderName: "Andriy", text: "привіт" }, [], "PERSONA", [
      { displayName: "Andriy", profile: "Snarky engineer." },
    ]);
    const text = joinSystem(req.system);
    expect(text).toContain("PERSONA");
    expect(text).toContain("Профілі учасників");
    expect(text).toContain("Snarky engineer.");
  });

  it("orders sections persona → profiles → recent", () => {
    const req = buildLlmRequest(
      { senderName: "Andriy", text: "?" },
      [{ senderName: "Olha", text: "тут" }],
      "PERSONA",
      [{ displayName: "Andriy", profile: "PROFILE" }],
    );
    const text = joinSystem(req.system);
    const personaIdx = text.indexOf("PERSONA");
    const profileIdx = text.indexOf("PROFILE");
    const contextIdx = text.indexOf("Контекст");
    expect(personaIdx).toBeLessThan(profileIdx);
    expect(profileIdx).toBeLessThan(contextIdx);
  });

  it("keeps persona as a separate block from the mutable tail", () => {
    const req = buildLlmRequest(
      { senderName: "Andriy", text: "?" },
      [{ senderName: "Olha", text: "тут" }],
      "PERSONA",
      [{ displayName: "Andriy", profile: "PROFILE" }],
    );
    // Persona не повинна мати в собі ні profile, ні recent — щоб кеш-префікс
    // не зсувався при кожному повідомленні.
    expect(req.system[0]?.text).toBe("PERSONA");
    expect(req.system[1]?.text).toContain("PROFILE");
    expect(req.system[1]?.text).toContain("Контекст");
  });

  // ─── Vision ──────────────────────────────────────────────────────────

  it("returns string user message when no photos anywhere", () => {
    const req = buildLlmRequest(
      { senderName: "A", text: "x" },
      [{ senderName: "B", text: "y" }],
      "P",
    );
    expect(typeof req.userMessage).toBe("string");
  });

  it("returns content blocks when current message has a photo", () => {
    const req = buildLlmRequest(
      {
        senderName: "Andriy",
        text: "як вам?",
        photos: [{ mime: "image/jpeg", base64: "AAAA" }],
      },
      [],
      "PERSONA",
    );
    expect(Array.isArray(req.userMessage)).toBe(true);
    const blocks = req.userMessage as Array<{ type: string }>;
    expect(blocks.filter((b) => b.type === "image")).toHaveLength(1);
    const text = blocks.find((b) => b.type === "text") as { type: "text"; text: string };
    expect(text.text).toContain("[фото 1]");
    expect(text.text).toContain("як вам?");
  });

  it("numbers photos sequentially across history and current", () => {
    const req = buildLlmRequest(
      {
        senderName: "Andriy",
        text: "ну?",
        photos: [{ mime: "image/jpeg", base64: "CUR" }],
      },
      [
        {
          senderName: "Olha",
          text: "дивись",
          photos: [{ mime: "image/jpeg", base64: "OLHA1" }],
        },
        {
          senderName: "Stepan",
          text: "альбом",
          photos: [
            { mime: "image/jpeg", base64: "ST1" },
            { mime: "image/jpeg", base64: "ST2" },
          ],
        },
      ],
      "P",
    );
    // Перевіряємо порядок image-блоків і маркерів
    const blocks = req.userMessage as Array<
      { type: "image"; source: { data: string } } | { type: "text"; text: string }
    >;
    const images = blocks.filter((b) => b.type === "image") as Array<{
      source: { data: string };
    }>;
    expect(images.map((i) => i.source.data)).toEqual(["OLHA1", "ST1", "ST2", "CUR"]);

    // Маркери в системі (history) і в user-text (current)
    const systemText = joinSystem(req.system);
    expect(systemText).toContain("Olha: [фото 1]");
    expect(systemText).toContain("Stepan: [фото 2-3]");
    const userText = (blocks.find((b) => b.type === "text") as { text: string }).text;
    expect(userText).toContain("Andriy: [фото 4]");
  });

  it("history-only photos still produce content blocks", () => {
    const req = buildLlmRequest(
      { senderName: "Andriy", text: "що це було" },
      [
        {
          senderName: "Olha",
          text: "",
          photos: [{ mime: "image/png", base64: "X" }],
        },
      ],
      "P",
    );
    expect(Array.isArray(req.userMessage)).toBe(true);
    const blocks = req.userMessage as Array<{ type: string }>;
    expect(blocks.filter((b) => b.type === "image")).toHaveLength(1);
  });

  it("falls back to image/jpeg for unknown mime", () => {
    const req = buildLlmRequest(
      {
        senderName: "A",
        text: "x",
        photos: [{ mime: "image/heic", base64: "Y" }],
      },
      [],
      "P",
    );
    const blocks = req.userMessage as Array<{
      type: "image";
      source: { media_type: string };
    }>;
    const img = blocks.find((b) => b.type === "image");
    expect(img?.source.media_type).toBe("image/jpeg");
  });
});
