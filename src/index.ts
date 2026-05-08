import { Bot } from "grammy";
import { loadConfig } from "./config.js";
import { createLogger } from "./shell/logger.js";
import { openDb } from "./shell/storage/db.js";
import { toMessageInput } from "./shell/telegram.js";

const config = loadConfig();
const log = createLogger(config);

log.info({ env: config.NODE_ENV }, "kytsunia starting");

const db = openDb(config.DB_PATH, log);
log.info({ dbPath: config.DB_PATH }, "database opened");

const bot = new Bot(config.BOT_TOKEN);

bot.on("message", async (ctx) => {
  const input = toMessageInput(ctx);
  if (!input) return;

  log.debug(
    {
      chatId: input.chatId,
      msgId: input.messageId,
      sender: input.senderName,
      kind: input.kind,
      hasReply: !!input.replyTo,
      hasForward: !!input.forwardOrigin,
      textPreview: input.text.slice(0, 60),
    },
    "message received",
  );
});

bot.catch((err) => {
  log.error({ err: err.error, ctx: err.ctx?.update?.update_id }, "bot error");
});

const shutdown = (signal: string) => {
  log.info({ signal }, "shutting down");
  bot.stop();
  db.close();
  process.exit(0);
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

try {
  await bot.start({
    onStart: (info) => log.info({ username: info.username, id: info.id }, "bot started"),
  });
} catch (err) {
  if (err instanceof Error && err.message.includes("getMe")) {
    log.error({ msg: err.message }, "bot failed to authenticate, check BOT_TOKEN");
  } else {
    log.error({ err }, "bot failed to start");
  }
  db.close();
  process.exit(1);
}
