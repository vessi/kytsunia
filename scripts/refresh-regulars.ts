import { parseArgs } from "node:util";
import { loadConfig } from "../src/config.js";
import { makeLlmClient } from "../src/shell/llm/anthropic.js";
import { refreshProfiles } from "../src/shell/llm/profile-refresh.js";
import { createLogger } from "../src/shell/logger.js";
import { openDb } from "../src/shell/storage/db.js";
import { makeLlmCallStore } from "../src/shell/storage/llm-calls.js";
import { makeOptOutsStore } from "../src/shell/storage/opt-outs.js";
import { makeRegularsStore } from "../src/shell/storage/regulars.js";

const { values } = parseArgs({
  options: {
    threshold: { type: "string" },
    days: { type: "string" },
    "limit-messages": { type: "string" },
    user: { type: "string" },
    chat: { type: "string" },
    model: { type: "string" },
    "dry-run": { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (values.help) {
  console.log(`
Usage: pnpm refresh:regulars [options]

Options (defaults come from KYTSUNIA_PROFILE_* env):
  --threshold <n>       Min messages to qualify as regular
  --days <n>            Lookback period in days
  --limit-messages <n>  Max messages per user-chat sent to LLM
  --user <user_id>      Refresh single user only (across all their chats)
  --chat <chat_id>      Refresh single chat only
  --model <name>        LLM model
  --dry-run             Print profiles without saving
  -h, --help            Show this help

Profiles are per-(user, chat). The same user in different chats gets
separate profiles based on their behavior in each chat. The bot does the
same for one chat on «Кицюня, онови профілі».
`);
  process.exit(0);
}

const config = loadConfig();
const log = createLogger(config);

if (!config.ANTHROPIC_API_KEY) {
  log.error("ANTHROPIC_API_KEY required");
  process.exit(1);
}

const num = (raw: string | undefined, fallback: number) =>
  raw === undefined ? fallback : Number.parseInt(raw, 10);
const opts = {
  threshold: num(values.threshold, config.KYTSUNIA_PROFILE_THRESHOLD),
  days: num(values.days, config.KYTSUNIA_PROFILE_DAYS),
  limitMessages: num(values["limit-messages"], config.KYTSUNIA_PROFILE_LIMIT_MESSAGES),
  model: values.model ?? config.KYTSUNIA_PROFILE_MODEL,
  ...(values.user ? { userId: Number.parseInt(values.user, 10) } : {}),
  ...(values.chat ? { chatId: Number.parseInt(values.chat, 10) } : {}),
  dryRun: values["dry-run"] ?? false,
};

log.info(opts, "refresh-regulars starting");

const db = openDb(config.DB_PATH, log);
const optOutsStore = makeOptOutsStore(db);
const result = await refreshProfiles(
  {
    db,
    llmClient: makeLlmClient(config.ANTHROPIC_API_KEY),
    regularsStore: makeRegularsStore(db),
    llmCallStore: makeLlmCallStore(db),
    optedOutUserIds: () => new Set(optOutsStore.list()),
    log,
  },
  {
    ...opts,
    onProfile: opts.dryRun
      ? (cand, profile, cost) => {
          console.log(`\n=== ${cand.userName} (${cand.userId}) in chat ${cand.chatId} ===`);
          console.log(profile);
          console.log(`\n--- $${cost.toFixed(5)} ---\n`);
        }
      : undefined,
  },
);

log.info({ ...result, totalCostUsd: result.totalCostUsd.toFixed(4) }, "refresh-regulars complete");
db.close();
process.exit(result.failed > 0 && result.processed === 0 ? 1 : 0);
