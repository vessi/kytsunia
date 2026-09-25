import { describe, expect, it } from "vitest";
import {
  buildPersonaPrompt,
  DIGEST_PROMPT,
  modelDisplayName,
  OPSEC_RULES,
  PERSONA_PROMPT,
} from "../../../src/shell/llm/persona.js";
import { PROFILE_GENERATOR_PROMPT } from "../../../src/shell/llm/profile-refresh.js";
import { ROSTER_PROMPT } from "../../../src/shell/llm/roster.js";

const base = {
  model: "claude-haiku-4-5-20251001",
  digestModel: "claude-sonnet-5",
  visionEnabled: true,
  digestEnabled: true,
  searchEnabled: true,
};

describe("modelDisplayName", () => {
  it.each([
    ["claude-haiku-4-5-20251001", "Claude Haiku 4.5"],
    ["claude-haiku-4-5", "Claude Haiku 4.5"],
    ["claude-sonnet-5", "Claude Sonnet 5"],
    ["claude-sonnet-4-6", "Claude Sonnet 4.6"],
    ["claude-opus-5", "Claude Opus 5"],
    ["claude-opus-4-8", "Claude Opus 4.8"],
  ])("%s → %s", (id, name) => {
    expect(modelDisplayName(id)).toBe(name);
  });

  it("returns unknown ids untouched instead of inventing a name", () => {
    expect(modelDisplayName("some-custom-model")).toBe("some-custom-model");
  });
});

describe("buildPersonaPrompt: character override", () => {
  it("replaces only the character, keeping the technical part", () => {
    const prompt = buildPersonaPrompt({ ...base, character: "Ти сумна сова." });
    expect(prompt.startsWith("Ти сумна сова.\n\nХто ти технічно:")).toBe(true);
    expect(prompt).not.toContain(PERSONA_PROMPT);
    expect(prompt).toContain("Що ти вмієш і чого не вмієш:");
  });

  it("keeps the OPSEC rules even with a custom character", () => {
    const prompt = buildPersonaPrompt({ ...base, character: "Ти сумна сова." });
    expect(prompt).toContain(OPSEC_RULES);
    expect(prompt.indexOf(OPSEC_RULES)).toBeGreaterThan(prompt.indexOf("Що ти вмієш"));
  });
});

describe("OPSEC rules in every prompt", () => {
  it("are part of the default persona, the digest, the roster and the profile generator", () => {
    expect(buildPersonaPrompt(base)).toContain("хто в чаті військовий");
    expect(DIGEST_PROMPT).toContain("не переказуй, хто служить");
    expect(ROSTER_PROMPT).toContain("нічого про службу");
    expect(PROFILE_GENERATOR_PROMPT).toContain("Військову службу");
  });
});

describe("buildPersonaPrompt", () => {
  it("starts with the base persona", () => {
    expect(buildPersonaPrompt(base).startsWith(PERSONA_PROMPT)).toBe(true);
  });

  it("names the reply model honestly", () => {
    const prompt = buildPersonaPrompt(base);
    expect(prompt).toContain("Claude Haiku 4.5 від Anthropic");
  });

  it("mentions the digest model only when it differs from the reply model", () => {
    expect(buildPersonaPrompt(base)).toContain("Дайджести чату за тебе пише Claude Sonnet 5");
    expect(buildPersonaPrompt({ ...base, digestModel: base.model })).not.toContain(
      "Дайджести чату за тебе пише",
    );
    expect(buildPersonaPrompt({ ...base, digestEnabled: false })).not.toContain(
      "Дайджести чату за тебе пише",
    );
  });

  it("describes search only when it is enabled", () => {
    expect(buildPersonaPrompt(base)).toContain("«Кицюня, пошукай …»");
    const off = buildPersonaPrompt({ ...base, searchEnabled: false });
    expect(off).not.toContain("«Кицюня, пошукай …»");
    expect(off).toContain("В інтернет не ходиш");
  });

  it("describes vision according to the flag", () => {
    expect(buildPersonaPrompt(base)).toContain("Бачиш фото");
    expect(buildPersonaPrompt({ ...base, visionEnabled: false })).toContain("Фото не бачиш");
  });

  it("omits the digest command when digest is disabled", () => {
    expect(buildPersonaPrompt({ ...base, digestEnabled: false })).not.toContain(
      "«Кицюня, дайджест»",
    );
  });

  it("mentions private chats among the triggers", () => {
    expect(buildPersonaPrompt(base)).toContain("пишуть тобі в особисті");
  });
});
