import type { NovaResponse } from "nova-http";
import type { RuntimeLogBuffer } from "../../logging.js";
import type { RuntimeLogEntry } from "../../types.js";

/** 以 SSE 流的形式持续推送运行时日志 */
export async function streamLogEvents(response: NovaResponse, logBuffer: RuntimeLogBuffer): Promise<void> {
  response
    .setHeader("content-type", "text/event-stream; charset=utf-8")
    .setHeader("cache-control", "no-cache, no-transform")
    .setHeader("connection", "keep-alive")
    .setHeader("x-accel-buffering", "no");
  await response.flushHeaders();

  let writeTail = Promise.resolve();
  const enqueue = (chunk: string): void => {
    writeTail = writeTail.then(() => response.write(chunk)).catch(() => undefined);
  };

  enqueue(": connected\n\n");
  for (const entry of logBuffer.entries) {
    enqueue(formatSseLogEntry(entry));
  }

  const unsubscribe = logBuffer.subscribe((entry) => {
    enqueue(formatSseLogEntry(entry));
  });

  await new Promise<void>((resolve) => {
    response.socket.once("close", () => {
      unsubscribe();
      resolve();
    });
  });
}

function formatSseLogEntry(entry: RuntimeLogEntry): string {
  return `id: ${entry.id}\nevent: log\ndata: ${JSON.stringify(entry)}\n\n`;
}
