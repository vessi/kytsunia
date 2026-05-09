import { parseArgs } from "node:util";
import { loadConfig } from "../src/config.js";
import { makeLlmClient } from "../src/shell/llm/anthropic.js";
import { calculateCost } from "../src/shell/llm/pricing.js";
import { createLogger } from "../src/shell/logger.js";
import { openDb } from "../src/shell/storage/db.js";
import { makeRegularsStore } from "../src/shell/storage/regulars.js";

const { values } = parseArgs({
  options: {
    threshold: { type: "string", default: "30" },
    days: { type: "string", default: "30" },
    "limit-messages": { type: "string", default: "200" },
    user: { type: "string" },
    chat: { type: "string" },
    model: { type: "string", default: "claude-sonnet-4-6" },
    "dry-run": { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (values.help) {
  console.log(`
Usage: pnpm refresh:regulars [options]

Options:
  --threshold <n>       Min messages to qualify as regular (default 30)
  --days <n>            Lookback period in days (default 30)
  --limit-messages <n>  Max messages per user-chat sent to LLM (default 200)
  --user <user_id>      Refresh single user only (across all their chats)
  --chat <chat_id>      Refresh single chat only
  --model <name>        LLM model (default claude-sonnet-4-6)
  --dry-run             Print profiles without saving
  -h, --help            Show this help

Profiles are now per-(user, chat). The same user in different chats gets
separate profiles based on their behavior in each chat.
`);
  process.exit(0);
}

const config = loadConfig();
const log = createLogger(config);

if (!config.ANTHROPIC_API_KEY) {
  log.error("ANTHROPIC_API_KEY required");
  process.exit(1);
}

const threshold = Number.parseInt(values.threshold ?? "30", 10);
const days = Number.parseInt(values.days ?? "30", 10);
const limitMessages = Number.parseInt(values["limit-messages"] ?? "200", 10);
const targetUser = values.user ? Number.parseInt(values.user, 10) : undefined;
const targetChat = values.chat ? Number.parseInt(values.chat, 10) : undefined;
const dryRun = values["dry-run"] ?? false;
const model = values.model ?? "claude-sonnet-4-6";

log.info(
  { threshold, days, limitMessages, targetUser, targetChat, dryRun, model },
  "refresh-regulars starting",
);

const db = openDb(config.DB_PATH, log);
const regularsStore = makeRegularsStore(db);
const llmClient = makeLlmClient(config.ANTHROPIC_API_KEY);

const cutoffTs = Date.now() - days * 24 * 3600 * 1000;

interface CandidateRow {
  user_id: number;
  chat_id: number;
  user_name: string;
  message_count: number;
  last_message_ts: number;
}

interface MessageRow {
  ts: number;
  text: string;
}

// Build dynamic query based on targets
const filters: string[] = ["ts >= ?", "text != ''"];
const params: unknown[] = [cutoffTs];

if (targetUser !== undefined) {
  filters.push("sender_id = ?");
  params.push(targetUser);
}
if (targetChat !== undefined) {
  filters.push("chat_id = ?");
  params.push(targetChat);
}

const where = filters.join(" AND ");
// When targeting a single user we relax the threshold (refresh whatever they have).
const havingClause = targetUser !== undefined ? "" : `HAVING message_count >= ?`;
if (!targetUser) params.push(threshold);

const candidatesQuery = `
  SELECT sender_id as user_id, chat_id, sender_name as user_name,
         COUNT(*) as message_count, MAX(ts) as last_message_ts
  FROM messages
  WHERE ${where}
  GROUP BY sender_id, chat_id
  ${havingClause}
  ORDER BY message_count DESC
`;

const candidates = db.prepare(candidatesQuery).all(...params) as CandidateRow[];

if (candidates.length === 0) {
  log.warn("no candidates found");
  process.exit(0);
}

log.info({ count: candidates.length }, "candidates found");

const generatorSystem = `Ти створюєш короткий нейтральний профіль учасника українського приватного чату на основі його повідомлень у цьому конкретному чаті. Профіль використовуватиметься іншим AI-асистентом для розуміння стилю і інтересів людини в цьому чаті.

Важливо: профіль описує поведінку людини у цьому конкретному чаті. Та сама людина в іншому чаті може поводитись по-іншому. Уникай узагальнень про "людину взагалі"; пиши про "цього учасника тут".

Включай:
- Стиль мови (лаконічний / розгорнутий, casual / формальний, з гумором / серйозний)
- Теми про які часто пише в цьому чаті (інтереси, професія, хобі)
- Сильні думки або позиції (що любить, що не любить)
- Манера: схильність до факт-перевірки, гумору, скепсису, конструктиву
- Помітні patterns в розмовах

НЕ включай:
- Психічне чи фізичне здоров'я і деталі діагнозів
- Фінансові деталі
- Інтимні стосунки
- Релігійні погляди (крім явно й публічно висловлених у цьому чаті)
- Сексуальну орієнтацію
- Будь-що, що людина явно вважала б приватним

Формат: суцільний текст українською, 100-250 слів. Без переліків, заголовків, markdown.

Якщо повідомлень замало для виявлення значущих рис, напиши коротше і чесно: "Повідомлень небагато" плюс що видно.`;

let totalCost = 0;
let processed = 0;

for (const cand of candidates) {
  log.info(
    {
      userId: cand.user_id,
      chatId: cand.chat_id,
      name: cand.user_name,
      msgs: cand.message_count,
    },
    "processing",
  );

  const messagesRows = db
    .prepare(`
      SELECT ts, text
      FROM messages
      WHERE sender_id = ? AND chat_id = ? AND ts >= ? AND text != ''
      ORDER BY ts DESC
      LIMIT ?
    `)
    .all(cand.user_id, cand.chat_id, cutoffTs, limitMessages) as MessageRow[];

  const messagesText = messagesRows
    .reverse()
    .map((m) => m.text)
    .join("\n---\n");

  const userMessage = `Ім'я: ${cand.user_name}
Чат: ${cand.chat_id}
Кількість повідомлень за період у цьому чаті: ${cand.message_count}
Аналізую останні ${messagesRows.length} повідомлень.

Повідомлення:
${messagesText}`;

  try {
    const reply = await llmClient.reply(generatorSystem, userMessage, model);
    const cost =
      calculateCost(model, {
        inputTokens: reply.inputTokens,
        outputTokens: reply.outputTokens,
        cacheReadTokens: reply.cacheReadTokens,
        cacheWriteTokens: reply.cacheWriteTokens,
      }) ?? 0;
    totalCost += cost;

    log.info(
      {
        userId: cand.user_id,
        chatId: cand.chat_id,
        input: reply.inputTokens,
        output: reply.outputTokens,
        cost: cost.toFixed(5),
      },
      "profile generated",
    );

    if (dryRun) {
      console.log(
        `\n=== ${cand.user_name} (${cand.user_id}) in chat ${cand.chat_id} ===`,
      );
      console.log(reply.text);
      console.log(
        `\n--- ${reply.inputTokens} in / ${reply.outputTokens} out, $${cost.toFixed(5)} ---\n`,
      );
    } else {
      regularsStore.upsert({
        userId: cand.user_id,
        chatId: cand.chat_id,
        displayName: cand.user_name,
        profile: reply.text,
        messageCount: cand.message_count,
        lastMessageTs: cand.last_message_ts,
      });
    }

    processed += 1;
  } catch (err) {
    log.error(
      {
        userId: cand.user_id,
        chatId: cand.chat_id,
        err: err instanceof Error ? err.message : err,
      },
      "failed to generate profile",
    );
  }
}

log.info(
  { processed, totalCost: totalCost.toFixed(4), dryRun },
  "refresh-regulars complete",
);
db.close();
process.exit(0);
