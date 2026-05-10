import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { z } from "zod";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/shell/logger.js";
import { openDb } from "../src/shell/storage/db.js";
import { makeDynamicRuleStore } from "../src/shell/storage/rules.js";

const LegacyRuleSchema = z.object({
  regex: z.string(),
  type: z.enum(["gif", "sticker"]),
  fileId: z.string(),
});
const LegacyRulesFileSchema = z.array(LegacyRuleSchema);
const InsultsFileSchema = z.array(z.string());

const { values } = parseArgs({
  options: {
    rules: { type: "string" },
    insults: { type: "string" },
    "replace-insults": { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (values.help || (!values.rules && !values.insults)) {
  console.log(`
Usage: pnpm import:legacy [options]

Options:
  --rules <path>         Шлях до legacy rules.json
  --insults <path>       Шлях до legacy insults.json
  --replace-insults      Замінити data/insults.json повністю замість злиття
  -h, --help             Показати цю довідку

Хоча б один з --rules або --insults має бути вказаний.
`);
  process.exit(0);
}

const config = loadConfig();
const log = createLogger(config);

log.info("import-legacy starting");

if (values.rules) {
  importRules(values.rules);
}

if (values.insults) {
  importInsults(values.insults, values["replace-insults"] ?? false);
}

log.info("import-legacy done");
process.exit(0);

function importRules(path: string): void {
  if (!existsSync(path)) {
    log.error({ path }, "rules file not found");
    process.exit(1);
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    log.error({ path, err: err instanceof Error ? err.message : err }, "rules file is not valid JSON");
    process.exit(1);
  }

  const parsed = LegacyRulesFileSchema.safeParse(parsedJson);
  if (!parsed.success) {
    log.error({ errors: parsed.error.flatten() }, "rules file has invalid format");
    process.exit(1);
  }

  const db = openDb(config.DB_PATH, log);
  const store = makeDynamicRuleStore(db, log);

  const before = store.list().length;
  for (const rule of parsed.data) {
    store.add({ pattern: rule.regex, type: rule.type, fileId: rule.fileId });
  }
  const after = store.list().length;
  const added = after - before;
  const skipped = parsed.data.length - added;

  log.info(
    { added, skipped, totalInFile: parsed.data.length, totalInDb: after },
    "rules imported",
  );
  db.close();
}

function importInsults(path: string, replace: boolean): void {
  if (!existsSync(path)) {
    log.error({ path }, "insults file not found");
    process.exit(1);
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    log.error({ path, err: err instanceof Error ? err.message : err }, "insults file is not valid JSON");
    process.exit(1);
  }

  const parsed = InsultsFileSchema.safeParse(parsedJson);
  if (!parsed.success) {
    log.error({ errors: parsed.error.flatten() }, "insults file is not array of strings");
    process.exit(1);
  }

  const target = "./data/insults.json";
  const incoming = parsed.data;

  let final: string[];
  if (replace || !existsSync(target)) {
    final = incoming;
  } else {
    const existing = z.array(z.string()).parse(JSON.parse(readFileSync(target, "utf-8")));
    const set = new Set([...existing, ...incoming]);
    final = [...set];
  }

  writeFileSync(target, `${JSON.stringify(final, null, 2)}\n`, "utf-8");
  log.info(
    { count: final.length, mode: replace ? "replace" : "merge" },
    "insults written to data/insults.json",
  );
}
