import { redactConfig, type LogLevel } from "@synapse/runtime-config";
import type { RuntimeLogEntry, RuntimeLogLevel, RuntimeServerLogger } from "./types.js";

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

export class RuntimeLogBuffer implements RuntimeServerLogger {
  readonly #entries: RuntimeLogEntry[] = [];
  readonly #listeners = new Set<(entry: RuntimeLogEntry) => void>();
  #nextId = 1;

  constructor(readonly limit: number) {}

  get entries(): readonly RuntimeLogEntry[] {
    return this.#entries;
  }

  subscribe(listener: (entry: RuntimeLogEntry) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  debug(message: string, metadata?: Readonly<Record<string, unknown>>): void {
    this.#append("debug", message, metadata);
  }

  info(message: string, metadata?: Readonly<Record<string, unknown>>): void {
    this.#append("info", message, metadata);
  }

  warn(message: string, metadata?: Readonly<Record<string, unknown>>): void {
    this.#append("warn", message, metadata);
  }

  error(message: string, metadata?: Readonly<Record<string, unknown>>): void {
    this.#append("error", message, metadata);
  }

  #append(level: RuntimeLogLevel, message: string, metadata?: Readonly<Record<string, unknown>>): void {
    const entry: RuntimeLogEntry = {
      id: this.#nextId,
      timestamp: new Date().toISOString(),
      level,
      message,
      ...(metadata === undefined ? {} : { metadata })
    };
    this.#entries.push(entry);
    this.#nextId += 1;

    while (this.#entries.length > this.limit) {
      this.#entries.shift();
    }

    for (const listener of this.#listeners) {
      listener(entry);
    }
  }
}

export function createTeeLogger(loggers: readonly RuntimeServerLogger[]): RuntimeServerLogger {
  return {
    debug(message, metadata) {
      for (const logger of loggers) {
        logger.debug?.(message, metadata);
      }
    },
    info(message, metadata) {
      for (const logger of loggers) {
        logger.info(message, metadata);
      }
    },
    warn(message, metadata) {
      for (const logger of loggers) {
        logger.warn(message, metadata);
      }
    },
    error(message, metadata) {
      for (const logger of loggers) {
        logger.error(message, metadata);
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
