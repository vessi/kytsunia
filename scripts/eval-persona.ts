import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { loadConfig } from "../src/config.js";
import { makeLlmClient } from "../src/shell/llm/anthropic.js";
import { buildLlmRequest } from "../src/shell/llm/context.js";
import { buildPersonaPrompt } from "../src/shell/llm/persona.js";
import { calculateCost } from "../src/shell/llm/pricing.js";
import { createLogger } from "../src/shell/logger.js";

const InputSchema = z.object({
  id: z.string(),
  input: z.string(),
  context: z
    .array(z.object({ senderName: z.string(), text: z.string() }))
    .default([]),
  note: z.string().optional(),
});
const InputsFileSchema = z.array(InputSchema);

const config = loadConfig();
const log = createLogger(config);

if (!config.ANTHROPIC_API_KEY) {
  log.error("ANTHROPIC_API_KEY required");
  process.exit(1);
}

const inputsPath = "data/persona-evals/inputs.json";
const outDir = "data/persona-evals/runs";
// Скільки разів проганяти кожен вхід. Одна відповідь — один семпл; для
// порівняння моделей чи варіантів промпта треба хоча б 3.
const runs = Math.max(1, Number.parseInt(process.env.EVAL_RUNS ?? "1", 10) || 1);

if (!existsSync(inputsPath)) {
  log.error({ path: inputsPath }, "inputs file not found");
  process.exit(1);
}

const inputs = InputsFileSchema.parse(JSON.parse(readFileSync(inputsPath, "utf-8")));

const client = makeLlmClient(config.ANTHROPIC_API_KEY);

// Той самий промпт, що й у проді, — інакше eval міряє не те.
const persona = buildPersonaPrompt({
  model: config.LLM_MODEL,
  digestModel: config.KYTSUNIA_DIGEST_MODEL,
  visionEnabled: config.KYTSUNIA_VISION_ENABLED,
  digestEnabled: config.KYTSUNIA_DIGEST_ENABLED,
  searchEnabled: config.KYTSUNIA_SEARCH_ENABLED,
});

log.info({ count: inputs.length, runs, model: config.LLM_MODEL }, "starting persona eval");

if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
const ts = new Date().toISOString().replace(/[:.]/g, "-");
const outPath = `${outDir}/${ts}-${config.LLM_MODEL}.md`;

const lines: string[] = [];
let totalCost = 0;
let totalOutputTokens = 0;
let totalReplies = 0;

lines.push(`# Persona eval: ${ts}`);
lines.push("");
lines.push(`- Model: \`${config.LLM_MODEL}\``);
lines.push(`- Runs per input: ${runs}`);
lines.push(`- Persona length: ${persona.length} chars`);
lines.push("");
lines.push("---");
lines.push("");

for (const item of inputs) {
  log.info({ id: item.id }, "running");
  const { system, userMessage } = buildLlmRequest(
    { senderName: "Test", text: item.input },
    item.context,
    persona,
    [],
    [],
    Date.now(),
  );

  lines.push(`## ${item.id}`);
  lines.push("");
  if (item.note) {
    lines.push(`*${item.note}*`);
    lines.push("");
  }
  if (item.context.length > 0) {
    lines.push("**Контекст:**");
    lines.push("```");
    for (const c of item.context) lines.push(`${c.senderName}: ${c.text}`);
    lines.push("```");
    lines.push("");
  }
  lines.push(`**Запит:** ${item.input}`);
  lines.push("");

  for (let run = 1; run <= runs; run++) {
    try {
      const reply = await client.reply(system, userMessage, config.LLM_MODEL);
      const cost =
        calculateCost(config.LLM_MODEL, {
          inputTokens: reply.inputTokens,
          outputTokens: reply.outputTokens,
          cacheReadTokens: reply.cacheReadTokens,
          cacheWriteTokens: reply.cacheWriteTokens,
        }) ?? 0;
      totalCost += cost;
      totalOutputTokens += reply.outputTokens;
      totalReplies += 1;

      lines.push(runs > 1 ? `**Відповідь ${run}:**` : "**Відповідь:**");
      lines.push(`> ${reply.text.split("\n").join("\n> ")}`);
      lines.push("");
      lines.push(`*${reply.inputTokens} in / ${reply.outputTokens} out, $${cost.toFixed(5)}*`);
      lines.push("");
    } catch (err) {
      lines.push("**ERROR:**");
      lines.push(`> ${err instanceof Error ? err.message : String(err)}`);
      lines.push("");
    }
  }

  lines.push("");
  lines.push("---");
  lines.push("");
}

lines.push(
  `**Replies:** ${totalReplies}, avg ${totalReplies > 0 ? (totalOutputTokens / totalReplies).toFixed(1) : "0"} output tokens`,
);
lines.push(`**Total cost:** $${totalCost.toFixed(4)}`);
lines.push("");

writeFileSync(outPath, lines.join("\n"), "utf-8");
log.info({ outPath, totalCost: totalCost.toFixed(4) }, "eval complete");
process.exit(0);
