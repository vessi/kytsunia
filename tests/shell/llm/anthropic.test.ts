import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { extractReply, webSearchTool } from "../../../src/shell/llm/anthropic.js";

// Блоки у формі, в якій їх повертає API; поля, які extractReply не читає, опущено.
function blocks(...items: Array<Record<string, unknown>>): Anthropic.ContentBlock[] {
  return items as unknown as Anthropic.ContentBlock[];
}

function text(value: string, citations: Array<Record<string, unknown>> | null = null) {
  return { type: "text", text: value, citations };
}

const toolUse = {
  type: "server_tool_use",
  id: "srv_1",
  name: "web_search",
  input: { query: "курс" },
};
const toolResult = { type: "web_search_tool_result", tool_use_id: "srv_1", content: [] };

describe("extractReply", () => {
  it("returns a single text block as is", () => {
    expect(extractReply(blocks(text("Я компʼютер!"))).text).toBe("Я компʼютер!");
  });

  it("ignores thinking before the answer", () => {
    const content = blocks({ type: "thinking", thinking: "", signature: "s" }, text("4."));
    expect(extractReply(content).text).toBe("4.");
  });

  it("glues answer fragments split by citations without a separator", () => {
    // Реальна форма відповіді з пошуку: одне речення приходить двома блоками.
    const content = blocks(
      toolUse,
      toolResult,
      text("Шмигаль очолює Міністерство оборони"),
      text(" — з липня 2025-го."),
    );
    expect(extractReply(content).text).toBe(
      "Шмигаль очолює Міністерство оборони — з липня 2025-го.",
    );
  });

  it("drops text written before the search", () => {
    const content = blocks(text("Зараз гляну."), toolUse, toolResult, text("Курс 44,55."));
    expect(extractReply(content).text).toBe("Курс 44,55.");
  });

  it("returns empty text when the turn stopped on a tool call", () => {
    expect(extractReply(blocks(text("Шукаю…"), toolUse)).text).toBe("");
  });

  it("collects unique web sources from the answer's citations", () => {
    const nbu = {
      type: "web_search_result_location",
      url: "https://bank.gov.ua/rate",
      title: "НБУ",
      cited_text: "…",
      encrypted_index: "x",
    };
    const doc = {
      type: "char_location",
      cited_text: "…",
      document_index: 0,
      document_title: null,
      start_char_index: 0,
      end_char_index: 1,
    };
    const content = blocks(
      toolUse,
      toolResult,
      text("Курс ", [nbu]),
      text("44,55", [nbu, doc]),
      text("."),
    );
    expect(extractReply(content).sources).toEqual([
      { url: "https://bank.gov.ua/rate", title: "НБУ" },
    ]);
  });
});

describe("webSearchTool", () => {
  it("uses the basic tool with the Kyiv timezone and no country", () => {
    const tool = webSearchTool(3);
    expect(tool).toMatchObject({ type: "web_search_20250305", name: "web_search", max_uses: 3 });
    expect(tool.user_location).toEqual({ type: "approximate", timezone: "Europe/Kyiv" });
  });
});
