import { readFileSync } from "node:fs";
import type { Logger } from "./logger.js";

export function loadInsults(path: string, log: Logger): string[] {
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      log.warn({ path }, "insults file is not an array, using empty");
      return [];
    }
    const valid = parsed.filter((x): x is string => typeof x === "string");
    if (valid.length !== parsed.length) {
      log.warn({ path }, "some insults entries were not strings, filtered out");
    }
    return valid;
  } catch (err) {
    log.warn(
      { path, err: err instanceof Error ? err.message : String(err) },
      "could not load insults",
    );
    return [];
  }
}
