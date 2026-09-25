import type { Logger } from "../logger.js";
import type { Db } from "../storage/db.js";
import type { LlmCallStore } from "../storage/llm-calls.js";
import type { RegularsStore } from "../storage/regulars.js";
import type { LlmClient } from "./anthropic.js";
import { calculateCost } from "./pricing.js";

export const PROFILE_GENERATOR_PROMPT = `Ти створюєш короткий нейтральний профіль учасника українського приватного чату на основі його повідомлень у цьому конкретному чаті. Профіль використовуватиметься іншим AI-асистентом для розуміння стилю і інтересів людини в цьому чаті.

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
- Військову службу, теперішню чи минулу: підрозділ, звання, ротації, відпустки, поранення
- Місцеперебування, переїзди, поїздки, де людина живе
- Роботу в обороні, на критичній інфраструктурі чи в органах влади
- Службу чи місцеперебування близьких
- Будь-що, що людина явно вважала б приватним
Про службу й місцеперебування — навіть якщо людина сама писала про це відкрито: профіль зберігається надовго, читається в кожній відповіді бота і не має бути довідником, хто де. Замість цього можна написати лише «має чітку громадянську позицію», якщо це видно.

Формат: суцільний текст українською, 100-250 слів. Без переліків, заголовків, markdown.

Якщо повідомлень замало для виявлення значущих рис, напиши коротше і чесно: "Повідомлень небагато" плюс що видно.`;

// 100–250 слів українською ≈ 600–800 токенів; даємо запас, щоб не обрізало.
const PROFILE_MAX_TOKENS = 1500;

/**
 * Запобіжник поверх промпту: якщо модель усе ж написала про службу чи
 * підрозділ, профіль переписуємо ще раз, а якщо і вдруге — не зберігаємо.
 * Регекс навмисно вузький: «фронтенд», «служба підтримки» і «новини війни»
 * ловити не треба. Це не фільтр, а страховка від грубих промахів.
 */
export const OPSEC_PATTERN =
  /\bзсу\b|\bтро\b|\bнгу\b|\bдшв\b|\bссо\b|військов|бригад|батальйон|ротаці|мобілізов|мобілізац|підрозділ|окоп|бойов|штурмов|піхот|артилер|служить у|на службі|в армії|на фронт(?!енд)|позивн/i;

const OPSEC_REWRITE_NOTE = `

Увага: у попередній версії цього профілю було щось із забороненого списку про службу, підрозділи чи місцеперебування. Перепиши профіль без жодної згадки про це, навіть непрямої.`;

export type RefreshCandidate = {
  userId: number;
  chatId: number;
  userName: string;
  messageCount: number;
  lastMessageTs: number;
};

export type RefreshOptions = {
  // Мінімум повідомлень за період, щоб людина вважалась постійною.
  threshold: number;
  days: number;
  // Скільки останніх повідомлень людини йде в модель.
  limitMessages: number;
  model: string;
  chatId?: number;
  // Один користувач: поріг не застосовується, оновлюємо що є.
  userId?: number;
  // Не зберігати, лише віддати текст у onProfile (для скрипта з --dry-run).
  dryRun?: boolean;
  onProfile?: (cand: RefreshCandidate, profile: string, costUsd: number) => void;
  // Хто попросив: пишеться в llm_calls, щоб звіт бачив витрати на профілі.
  requestedByUserId?: number;
  requestedByName?: string;
};

export type RefreshResult = {
  processed: number;
  failed: number;
  // Пропущені через opt-out.
  skipped: number;
  // Відкинуті запобіжником OPSEC після повторної спроби.
  filtered: number;
  totalCostUsd: number;
};

export type ProfileRefreshDeps = {
  db: Db;
  llmClient: LlmClient;
  regularsStore: RegularsStore;
  llmCallStore: LlmCallStore;
  optedOutUserIds: () => ReadonlySet<number>;
  log: Logger;
};

interface CandidateRow {
  user_id: number;
  chat_id: number;
  user_name: string;
  message_count: number;
  last_message_ts: number;
}

interface MessageRow {
  text: string;
}

export function findCandidates(
  db: Db,
  opts: Pick<RefreshOptions, "threshold" | "chatId" | "userId">,
  cutoffTs: number,
): RefreshCandidate[] {
  const filters: string[] = ["ts >= ?", "text != ''"];
  const params: unknown[] = [cutoffTs];
  if (opts.userId !== undefined) {
    filters.push("sender_id = ?");
    params.push(opts.userId);
  }
  if (opts.chatId !== undefined) {
    filters.push("chat_id = ?");
    params.push(opts.chatId);
  }
  const having = opts.userId !== undefined ? "" : "HAVING message_count >= ?";
  if (opts.userId === undefined) params.push(opts.threshold);

  const rows = db
    .prepare(
      `SELECT sender_id as user_id, chat_id, sender_name as user_name,
              COUNT(*) as message_count, MAX(ts) as last_message_ts
       FROM messages
       WHERE ${filters.join(" AND ")}
       GROUP BY sender_id, chat_id
       ${having}
       ORDER BY message_count DESC`,
    )
    .all(...params) as CandidateRow[];
  return rows.map((r) => ({
    userId: r.user_id,
    chatId: r.chat_id,
    userName: r.user_name,
    messageCount: r.message_count,
    lastMessageTs: r.last_message_ts,
  }));
}

export function buildProfileRequest(cand: RefreshCandidate, messages: readonly string[]): string {
  return `Ім'я: ${cand.userName}
Чат: ${cand.chatId}
Кількість повідомлень за період у цьому чаті: ${cand.messageCount}
Аналізую останні ${messages.length} повідомлень.

Повідомлення:
${messages.join("\n---\n")}`;
}

/**
 * Перегенеровує профілі постійних учасників: усіх, одного чату чи однієї
 * людини. Помилка на одному профілі не зупиняє решту. Спільне ядро для
 * скрипта refresh-regulars і команди «Кицюня, онови профілі».
 */
export async function refreshProfiles(
  deps: ProfileRefreshDeps,
  opts: RefreshOptions,
): Promise<RefreshResult> {
  const cutoffTs = Date.now() - opts.days * 24 * 3600 * 1000;
  const optedOut = deps.optedOutUserIds();
  const all = findCandidates(deps.db, opts, cutoffTs);
  const candidates = all.filter((c) => !optedOut.has(c.userId));
  const result: RefreshResult = {
    processed: 0,
    failed: 0,
    skipped: all.length - candidates.length,
    filtered: 0,
    totalCostUsd: 0,
  };
  deps.log.info(
    { candidates: candidates.length, skipped: result.skipped, chatId: opts.chatId ?? null },
    "profile refresh started",
  );

  const messagesStmt = deps.db.prepare(
    `SELECT text FROM messages
     WHERE sender_id = ? AND chat_id = ? AND ts >= ? AND text != ''
     ORDER BY ts DESC LIMIT ?`,
  );

  for (const cand of candidates) {
    const rows = messagesStmt.all(
      cand.userId,
      cand.chatId,
      cutoffTs,
      opts.limitMessages,
    ) as MessageRow[];
    const userMessage = buildProfileRequest(
      cand,
      rows.reverse().map((m) => m.text),
    );
    const record = {
      ts: Date.now(),
      chatId: cand.chatId,
      userId: opts.requestedByUserId ?? 0,
      userName: opts.requestedByName ?? "",
      triggerMsgId: 0,
      model: opts.model,
      // Профілі не зʼїдають нічий добовий ліміт, але в звіті мають бути.
      weight: 0,
    };
    try {
      const generate = async (message: string) => {
        const reply = await deps.llmClient.reply(
          PROFILE_GENERATOR_PROMPT,
          message,
          opts.model,
          PROFILE_MAX_TOKENS,
        );
        const cost =
          calculateCost(opts.model, {
            inputTokens: reply.inputTokens,
            outputTokens: reply.outputTokens,
            cacheReadTokens: reply.cacheReadTokens,
            cacheWriteTokens: reply.cacheWriteTokens,
          }) ?? 0;
        result.totalCostUsd += cost;
        deps.llmCallStore.record({
          ...record,
          status: "ok",
          inputTokens: reply.inputTokens,
          outputTokens: reply.outputTokens,
          cacheReadTokens: reply.cacheReadTokens,
          cacheWriteTokens: reply.cacheWriteTokens,
          costUsd: cost,
        });
        return { text: reply.text, cost };
      };

      let { text, cost } = await generate(userMessage);
      if (OPSEC_PATTERN.test(text)) {
        deps.log.warn(
          { userId: cand.userId, chatId: cand.chatId },
          "profile hit OPSEC filter, rewriting",
        );
        ({ text, cost } = await generate(userMessage + OPSEC_REWRITE_NOTE));
        if (OPSEC_PATTERN.test(text)) {
          deps.log.warn(
            { userId: cand.userId, chatId: cand.chatId },
            "profile dropped by OPSEC filter",
          );
          result.filtered += 1;
          continue;
        }
      }
      deps.log.info(
        { userId: cand.userId, chatId: cand.chatId, cost: cost.toFixed(5) },
        "profile generated",
      );
      opts.onProfile?.(cand, text, cost);
      if (!opts.dryRun) {
        deps.regularsStore.upsert({
          userId: cand.userId,
          chatId: cand.chatId,
          displayName: cand.userName,
          profile: text,
          messageCount: cand.messageCount,
          lastMessageTs: cand.lastMessageTs,
        });
      }
      result.processed += 1;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      deps.llmCallStore.record({ ...record, status: "error", errorMessage });
      deps.log.error(
        { userId: cand.userId, chatId: cand.chatId, err: errorMessage },
        "failed to generate profile",
      );
      result.failed += 1;
    }
  }

  deps.log.info(
    { ...result, totalCostUsd: result.totalCostUsd.toFixed(4) },
    "profile refresh done",
  );
  return result;
}
