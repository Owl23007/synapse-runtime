import assert from "node:assert/strict";
import { ContainerExecutor } from "../packages/tool-container/dist/index.js";
import { ContainerSettingsSchema } from "../packages/tool-container/dist/config.js";

// 使用产品执行器验证部署镜像，不把宿主机的 Python 依赖当作容器能力
const executor = new ContainerExecutor(
  ContainerSettingsSchema.parse({ enabled: true, image: "synapse-artifacts:0.1", timeoutMs: 30_000 })
);
const result = await executor.execute({
  outputs: ["report.docx", "report.xlsx", "report.pdf", "chart.png"],
  script: String.raw`
from docx import Document
from openpyxl import Workbook, load_workbook
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.font_manager import FontProperties

doc = Document()
doc.add_heading('群聊工件验收', 0)
doc.add_paragraph('测试数据：42')
doc.save('report.docx')
assert Document('report.docx').paragraphs[1].text == '测试数据：42'

book = Workbook()
book.active.append(['名称', '数值'])
book.active.append(['测试', 42])
book.save('report.xlsx')
assert load_workbook('report.xlsx').active['B2'].value == 42

pdfmetrics.registerFont(UnicodeCIDFont('STSong-Light'))
pdf = canvas.Canvas('report.pdf')
pdf.setFont('STSong-Light', 16)
pdf.drawString(72, 740, '群聊工件验收：42')
pdf.save()

font = FontProperties(fname='/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc')
plt.bar(['A', 'B'], [21, 42])
plt.title('群聊图表验收', fontproperties=font)
plt.savefig('chart.png')
plt.close()
`
});
assert.equal(result.files.length, 4);
for (const file of result.files) assert.ok(file.data.byteLength > 100, `${file.name} 必须包含实际内容`);
assert.equal(Buffer.from(result.files[0].data).subarray(0, 2).toString(), "PK");
assert.equal(Buffer.from(result.files[1].data).subarray(0, 2).toString(), "PK");
assert.equal(Buffer.from(result.files[2].data).subarray(0, 5).toString(), "%PDF-");
assert.equal(Buffer.from(result.files[3].data).subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
console.log("真实工件镜像验收通过：DOCX、XLSX、PDF、PNG 生成与收集");
