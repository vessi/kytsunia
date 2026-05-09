import Anthropic from "@anthropic-ai/sdk";

export type LlmReply = {
  text: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

export type LlmClient = {
  reply: (system: string, userMessage: string, model: string) => Promise<LlmReply>;
};

export function makeLlmClient(apiKey: string): LlmClient {
  const client = new Anthropic({ apiKey });

  return {
    reply: async (system, userMessage, model) => {
      const response = await client.messages.create({
        model,
        max_tokens: 500,
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
