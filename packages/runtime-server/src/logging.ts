import { redactConfig, type LogLevel } from "@synapse/runtime-config";
import type { RuntimeServerLogger } from "./types.js";

export const DEFAULT_LOGGER: RuntimeServerLogger = {
  debug(message, metadata) {
    log("debug", message, metadata);
  },
  info(message, metadata) {
    log("info", message, metadata);
  },
  warn(message, metadata) {
    log("warn", message, metadata);
  },
  error(message, metadata) {
    log("error", message, metadata);
  }
};

export function createLevelLogger(logger: RuntimeServerLogger, logLevel: LogLevel): RuntimeServerLogger {
  const threshold = LOG_LEVEL_ORDER[logLevel];

  return {
    debug(message, metadata) {
      if (LOG_LEVEL_ORDER.debug >= threshold) {
        logger.debug?.(message, redactConfig(metadata));
      }
    },
    info(message, metadata) {
      if (LOG_LEVEL_ORDER.info >= threshold) {
        logger.info(message, redactConfig(metadata));
      }
    },
    warn(message, metadata) {
      if (LOG_LEVEL_ORDER.warn >= threshold) {
        logger.warn(message, redactConfig(metadata));
      }
    },
    error(message, metadata) {
      if (LOG_LEVEL_ORDER.error >= threshold) {
        logger.error(message, redactConfig(metadata));
      }
    }
  };
}

const LOG_LEVEL_ORDER = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60
} as const satisfies Record<LogLevel, number>;

function log(level: "debug" | "info" | "warn" | "error", message: string, metadata?: Readonly<Record<string, unknown>>): void {
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    pid: process.pid,
    message,
    ...(metadata === undefined ? {} : { metadata })
  });

  if (level === "error") {
    console.error(line);
    return;
  }

  console.log(line);
}
