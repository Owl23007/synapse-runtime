import { describe, expect, it } from "vitest";
import { extractPdfText } from "./pdf-text.js";

function fixture(): Uint8Array {
  const content = "BT /F1 12 Tf 10 30 Td (hello resource) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => String(offset).padStart(10, "0") + " 00000 n \n")
    .join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf);
}
describe("bounded PDF text extraction", () => {
  it("extracts text using a separate worker and rejects invalid input without leaking parser internals", async () => {
    expect(await extractPdfText(fixture())).toContain("hello resource");
    await expect(extractPdfText(Buffer.from("%PDF-invalid"))).rejects.toMatchObject({
      status: 422,
      code: "pdf_parse_or_budget_failed"
    });
  });
  it("does not start document work after cancellation", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(extractPdfText(fixture(), controller.signal)).rejects.toThrow("cancelled");
  });
});
