import Anthropic from "@anthropic-ai/sdk";

export type LlmReply = {
  text: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
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

export type LlmClient = {
  reply: (
    system: string,
    userMessage: UserContent,
    model: string,
    maxTokens?: number,
  ) => Promise<LlmReply>;
};

const DEFAULT_MAX_TOKENS = 500;

export function makeLlmClient(apiKey: string): LlmClient {
  const client = new Anthropic({ apiKey });

  return {
    reply: async (system, userMessage, model, maxTokens) => {
      const response = await client.messages.create({
        model,
        max_tokens: maxTokens ?? DEFAULT_MAX_TOKENS,
        system,
        messages: [{ role: "user", content: userMessage }],
      });

      const text = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === "text")
        .map((block) => block.text)
        .join("\n")
        .trim();

      return {
        text,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
      };
    },
  };
}
