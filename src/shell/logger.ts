import { pino } from "pino";
import type { Config } from "../config.js";

export function createLogger(config: Config) {
  const isDev = config.NODE_ENV === "development";

  return pino({
    level: config.LOG_LEVEL,
    ...(isDev
      ? {
          transport: {
            target: "pino-pretty",
            options: {
              colorize: true,
              translateTime: "HH:MM:ss",
              ignore: "pid,hostname",
            },
          },
        }
      : {}),
  });
}

export type Logger = ReturnType<typeof createLogger>;
