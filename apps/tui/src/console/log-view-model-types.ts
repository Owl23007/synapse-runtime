import type { ConsoleLevel } from "./types.js";

export type StructuredLogKind = "channel" | "routing" | "agent" | "event" | "admin" | "server" | "console" | "unknown";

export type StructuredLogStatus = "received" | "accepted" | "ignored" | "started" | "succeeded" | "failed" | "info";

export interface StructuredLogEntry {
  readonly id: number;
  readonly timestamp: string;
  readonly level: ConsoleLevel;
  readonly kind: StructuredLogKind;
  readonly status: StructuredLogStatus;
  readonly title: string;
  readonly summary: string;
  readonly fields: readonly StructuredLogField[];
}

export interface StructuredLogField {
  readonly label: string;
  readonly value: string;
}
