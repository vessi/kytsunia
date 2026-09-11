import Anthropic from "@anthropic-ai/sdk";

export type ReplySource = {
  url: string;
  title: string | null;
};

export type LlmReply = {
  text: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  // Optional: справжній клієнт заповнює завжди, фейкові клієнти в тестах можуть пропускати.
  webSearchRequests?: number;
  sources?: ReplySource[];
  stopReason?: string | null;
};

export type ImageContent = {
  type: "image";
  source: {
    type: "base64";
    media_type: "image/jpeg" | "image/png" | "image/webp" | "image/gif";
    data: string;
  };
};

export type TextContent = {
  type: "text";
  text: string;
};

export type UserContent = string | Array<TextContent | ImageContent>;

// Anthropic system-блок. cache_control: ephemeral робить префікс кандидатом на
// prompt cache (TTL 5 хв). Ставити лише на стабільну частину префікса.
export type SystemBlock = {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
};

export type SystemContent = string | SystemBlock[];

export type ReplyOptions = {
  tools?: Anthropic.ToolUnion[];
};

export type LlmClient = {
  reply: (
    system: SystemContent,
    userMessage: UserContent,
    model: string,
    maxTokens?: number,
    options?: ReplyOptions,
  ) => Promise<LlmReply>;
};

const DEFAULT_MAX_TOKENS = 500;

/**
 * Базова версія web search, а не новіша web_search_20260209 з динамічною
 * фільтрацією: на коротких чат-запитах новіша відповідала ~30 с проти ~5 с,
 * коштувала дорожче й додавала ~6k токенів опису інструмента в кожен запит.
 * Країну не передаємо: country "UA" API відхиляє, часовий пояс приймає.
 */
export function webSearchTool(maxUses: number): Anthropic.WebSearchTool20250305 {
  return {
    type: "web_search_20250305",
    name: "web_search",
    max_uses: maxUses,
    user_location: { type: "approximate", timezone: "Europe/Kyiv" },
  };
}

/**
 * Витягує фінальну відповідь із content.
 *
 * З пошуком content виглядає як [text?, server_tool_use, web_search_tool_result, text, text…]:
 * текст до пошуку — це «зараз гляну», а фінальна відповідь розбита на кілька
 * text-блоків по межах цитат. Тому беремо лише хвіст text-блоків після останнього
 * не-текстового блоку і клеїмо без роздільника: це шматки одного тексту.
 */
export function extractReply(content: readonly Anthropic.ContentBlock[]): {
  text: string;
  sources: ReplySource[];
} {
  let start = content.length;
  while (start > 0 && content[start - 1]?.type === "text") start--;
  const tail = content
    .slice(start)
    .filter((block): block is Anthropic.TextBlock => block.type === "text");

  const seen = new Set<string>();
  const sources: ReplySource[] = [];
  for (const block of tail) {
    for (const citation of block.citations ?? []) {
      if (citation.type !== "web_search_result_location" || seen.has(citation.url)) continue;
      seen.add(citation.url);
      sources.push({ url: citation.url, title: citation.title });
    }
  }

  return {
    text: tail
      .map((block) => block.text)
      .join("")
      .trim(),
    sources,
  };
}

export function makeLlmClient(apiKey: string): LlmClient {
  const client = new Anthropic({ apiKey });

  return {
    reply: async (system, userMessage, model, maxTokens, options) => {
      const response = await client.messages.create({
        model,
        max_tokens: maxTokens ?? DEFAULT_MAX_TOKENS,
        system,
        messages: [{ role: "user", content: userMessage }],
        ...(options?.tools ? { tools: options.tools } : {}),
      });

      const { text, sources } = extractReply(response.content);

      return {
        text,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
        webSearchRequests: response.usage.server_tool_use?.web_search_requests ?? 0,
        sources,
        stopReason: response.stop_reason,
      };
    },
  };
}
