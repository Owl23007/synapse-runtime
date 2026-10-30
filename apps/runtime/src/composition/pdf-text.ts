import { Worker } from "node:worker_threads";
import { ResourceOperationError } from "@synapse/runtime-core/assets";

/** 在有内存和时间预算的独立线程中提取 PDF，避免恶意文档阻塞 Runtime 主循环 */
export async function extractPdfText(bytes: Uint8Array, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const data = Uint8Array.from(bytes);
  const worker = new Worker(
    new URL(import.meta.url.endsWith(".ts") ? "./pdf-text-worker.ts" : "./pdf-text-worker.js", import.meta.url),
    {
      workerData: data,
      transferList: [data.buffer],
      resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16 }
    }
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: (() => void) | undefined;
  try {
    return await new Promise<string>((resolve, reject) => {
      const fail = (code: string) => reject(new ResourceOperationError(422, code));
      cancel = () => fail("pdf_read_cancelled");
      signal?.addEventListener("abort", cancel, { once: true });
      timer = setTimeout(() => fail("pdf_read_timeout"), 30000);
      worker.once("message", (result: unknown) => {
        if (
          result &&
          typeof result === "object" &&
          "text" in result &&
          typeof result.text === "string" &&
          result.text.length <= 2_000_000
        )
          resolve(result.text);
        else fail("pdf_parse_or_budget_failed");
      });
      worker.once("error", () => fail("pdf_parse_or_budget_failed"));
      worker.once("exit", () => fail("pdf_worker_closed"));
      if (signal?.aborted) cancel();
    });
  } finally {
    clearTimeout(timer);
    if (cancel) signal?.removeEventListener("abort", cancel);
    await worker.terminate();
  }
}
