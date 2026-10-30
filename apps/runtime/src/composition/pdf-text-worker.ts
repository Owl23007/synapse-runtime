import { parentPort, workerData } from "node:worker_threads";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

// 此线程没有宿主路径或网络输入，解析预算同时限制页数与最终文本体积
const loading = getDocument({
  data: workerData as Uint8Array,
  useSystemFonts: false,
  disableFontFace: true,
  stopAtErrors: true
});
try {
  const document = await loading.promise;
  if (document.numPages > 200) throw new Error("Page budget exceeded");
  let text = "";
  for (let pageNo = 1; pageNo <= document.numPages; pageNo++) {
    const page = await document.getPage(pageNo);
    const content = await page.getTextContent();
    text += content.items.map((item) => ("str" in item ? item.str : "")).join(" ") + "\n";
    page.cleanup();
    if (text.length > 2_000_000) throw new Error("Text budget exceeded");
  }
  parentPort?.postMessage({ text });
} catch {
  parentPort?.postMessage({ error: "pdf_parse_or_budget_failed" });
} finally {
  await loading.destroy();
}
