import type { RuntimeServerLogger } from "../types.js";
import type { ConsoleLevel, ConsoleLogEntry } from "./types.js";

export class ConsoleLogStore implements RuntimeServerLogger {
  readonly #entries: ConsoleLogEntry[] = [];
  readonly #listeners = new Set<() => void>();
  #nextId = 1;

  constructor(readonly limit = 300) {}

  get entries(): readonly ConsoleLogEntry[] {
    return this.#entries;
  }

  subscribe(listener: () => void): () => void {
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

  #append(level: ConsoleLevel, message: string, metadata?: Readonly<Record<string, unknown>>): void {
    this.#entries.push({
      id: this.#nextId,
      timestamp: new Date().toISOString(),
      level,
      message,
      ...(metadata === undefined ? {} : { metadata })
    });
    this.#nextId += 1;

    while (this.#entries.length > this.limit) {
      this.#entries.shift();
    }

    for (const listener of this.#listeners) {
      listener();
    }
  }
}
