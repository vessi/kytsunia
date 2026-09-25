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

  it("puts cache_control on the persona and profile blocks, not on the tail", () => {
    const req = buildLlmRequest(
      { senderName: "Andriy", text: "привіт" },
      [{ senderName: "Olha", text: "тут" }],
      "PERSONA",
      [{ displayName: "Andriy", profile: "PROFILE" }],
    );
    expect(req.system).toHaveLength(3);
    expect(req.system[0]?.cache_control).toEqual({ type: "ephemeral" });
    expect(req.system[1]?.cache_control).toEqual({ type: "ephemeral" });
    expect(req.system[2]?.cache_control).toBeUndefined();
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

  it("puts profiles into their own cached block right after the persona", () => {
    const req = buildLlmRequest({ senderName: "Andriy", text: "привіт" }, [], "PERSONA", [
      { displayName: "Andriy", profile: "Snarky engineer." },
    ]);
    expect(req.system[0]?.text).toBe("PERSONA");
    expect(req.system[1]?.text).toContain("Профілі учасників");
    expect(req.system[1]?.text).toContain("Andriy:\nSnarky engineer.");
    expect(req.system[1]?.cache_control).toEqual({ type: "ephemeral" });
  });

  it("adds no profiles block when there are no profiles", () => {
    const req = buildLlmRequest({ senderName: "Andriy", text: "привіт" }, [], "PERSONA");
    expect(req.system).toHaveLength(1);
  });

  it("keeps the volatile tail out of the cached prefix", () => {
    const req = buildLlmRequest(
      { senderName: "Andriy", text: "?" },
      [{ senderName: "Olha", text: "тут" }],
      "PERSONA",
      [{ displayName: "Andriy", profile: "PROFILE" }],
      [],
      1_000_000,
    );
    expect(req.system).toHaveLength(3);
    expect(req.system[2]?.cache_control).toBeUndefined();
    expect(req.system[2]?.text).toContain("Контекст");
    expect(req.system[2]?.text).not.toContain("PROFILE");
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

  it("appends the reply thread after recent context, marking the target", () => {
    const req = buildLlmRequest(
      { senderName: "Andriy", text: "а чому саме так?" },
      [{ senderName: "Olha", text: "тут" }],
      "PERSONA",
      [],
      [
        { senderName: "Andriy", text: "що взяти?" },
        { senderName: "Кицюня", text: "Lagavulin" },
      ],
    );
    expect(req.system).toHaveLength(2);
    const tail = req.system[1]?.text ?? "";
    expect(tail).toContain("Гілка, на яку відповідає користувач");
    expect(tail).toContain("Andriy: що взяти?\nКицюня: Lagavulin");
    expect(tail.indexOf("Контекст")).toBeLessThan(tail.indexOf("Гілка"));
    expect(req.system[0]?.text).toBe("PERSONA");
  });

  it("adds the tail block for a thread even without recent messages", () => {
    const req = buildLlmRequest(
      { senderName: "Andriy", text: "?" },
      [],
      "PERSONA",
      [],
      [{ senderName: "Кицюня", text: "Lagavulin" }],
    );
    expect(req.system).toHaveLength(2);
    expect(req.system[1]?.text).toContain("Кицюня: Lagavulin");
  });

  it("puts the current Kyiv date and time at the top of the tail, never in persona", () => {
    // 2026-09-12T05:15:00Z = субота, 08:15 за Києвом (UTC+3, літній час).
    const req = buildLlmRequest(
      { senderName: "Andriy", text: "яке сьогодні число?" },
      [{ senderName: "Olha", text: "тут" }],
      "PERSONA",
      [],
      [],
      Date.UTC(2026, 8, 12, 5, 15),
    );
    expect(req.system[0]?.text).toBe("PERSONA");
    const tail = req.system[1]?.text ?? "";
    expect(tail.startsWith("Зараз субота, 12 вересня 2026 р. о 08:15 за київським часом.")).toBe(
      true,
    );
    expect(tail.indexOf("Зараз")).toBeLessThan(tail.indexOf("Контекст"));
  });

  it("adds the tail block for the date even with nothing else", () => {
    const req = buildLlmRequest({ senderName: "A", text: "?" }, [], "PERSONA", [], [], 0);
    expect(req.system).toHaveLength(2);
    expect(req.system[1]?.text).toContain("1970");
  });

  it("omits the date line when now is not given", () => {
    const req = buildLlmRequest({ senderName: "A", text: "?" }, [], "PERSONA");
    expect(req.system).toHaveLength(1);
  });

  it("keeps persona as a separate block from the mutable tail", () => {
    const req = buildLlmRequest(
      { senderName: "Andriy", text: "?" },
      [{ senderName: "Olha", text: "тут" }],
      "PERSONA",
      [{ displayName: "Andriy", profile: "PROFILE" }],
    );
    // Persona не повинна мати в собі ні profile, ні recent — щоб кеш-префікс
    // не зсувався при кожному повідомленні. Профілі — свій блок, recent — хвіст.
    expect(req.system[0]?.text).toBe("PERSONA");
    expect(req.system[1]?.text).toContain("PROFILE");
    expect(req.system[1]?.text).not.toContain("Контекст");
    expect(req.system[2]?.text).toContain("Контекст");
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
