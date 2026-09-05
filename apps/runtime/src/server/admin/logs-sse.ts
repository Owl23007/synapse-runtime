import type { NovaResponse } from "nova-http";
import type { RuntimeLogBuffer } from "../../logging.js";
import type { RuntimeLogEntry } from "../../types.js";

const NOVA_HEADERS_SENT_KEY = "_headersSent";

export function streamLogEvents(response: NovaResponse, logBuffer: RuntimeLogBuffer): Promise<void> {
  const socket = response.socket;
  const responseState = response as unknown as Record<typeof NOVA_HEADERS_SENT_KEY, boolean>;
  responseState[NOVA_HEADERS_SENT_KEY] = true;

  socket.write(
    [
      "HTTP/1.1 200 OK",
      "content-type: text/event-stream; charset=utf-8",
      "cache-control: no-cache, no-transform",
      "connection: keep-alive",
      "x-accel-buffering: no",
      "",
      ": connected",
      "",
      ""
    ].join("\r\n")
  );

  for (const entry of logBuffer.entries) {
    writeSseLogEntry(socket, entry);
  }

  const unsubscribe = logBuffer.subscribe((entry) => {
    writeSseLogEntry(socket, entry);
  });

  return new Promise((resolve) => {
    socket.once("close", () => {
      unsubscribe();
      resolve();
    });
  });
}

export function writeSseLogEntry(socket: NovaResponse["socket"], entry: RuntimeLogEntry): void {
  if (socket.destroyed) {
    return;
  }

  socket.write(`id: ${entry.id}\nevent: log\ndata: ${JSON.stringify(entry)}\n\n`);
}
