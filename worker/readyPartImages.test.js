// Готова частина .docx з таблицею і рисунком (кейс 41570): таблиця не розсипається на абзаци
// по клітинці, рисунок доходить до фінального .docx на своє місце.
// Запуск: node worker/readyPartImages.test.js
import assert from "node:assert/strict";
import JSZip from "jszip";
import sharp from "sharp";
import { extractDocxReadyPart } from "../src/lib/readyPartDocx.js";
import { exportToDocx } from "../src/lib/exportDocx.js";
import { compressReadyImages } from "./readyPartImages.js";

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok - ${name}`); }
  catch (err) { console.error(`FAIL - ${name}`); console.error(err); process.exitCode = 1; }
}

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';
const p = (t) => `<w:p><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`;
const cell = (t, span) => `<w:tc>${span ? `<w:tcPr><w:gridSpan w:val="${span}"/></w:tcPr>` : ""}${p(t)}</w:tc>`;
const drawing = `<w:p><w:r><w:drawing><wp:inline><a:graphic><a:graphicData><pic:pic><pic:blipFill><a:blip r:embed="rId7"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;

async function buildDocx() {
  const png = await sharp({ create: { width: 300, height: 200, channels: 3, background: "#3366aa" } }).png().toBuffer();
  const body = [
    p("1.1. Поняття говоріння"),
    p("Текст перед таблицею."),
    p("Таблиця 1.1"),
    `<w:tbl><w:tr>${cell("Складова")}${cell("Характеристика")}</w:tr><w:tr>${cell("Мовна | лексика")}${cell("Знання лексики")}</w:tr><w:tr>${cell("Об'єднана на два стовпці", 2)}</w:tr></w:tbl>`,
    p("Текст між таблицею і рисунком."),
    drawing,
    p("Рис.1.1. Складові гейміфікації"),
    p("Текст після рисунка."),
  ].join("");
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.file("word/_rels/document.xml.rels", `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId7" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/></Relationships>`);
  zip.file("word/media/image1.png", png);
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8"?><w:document ${W}><w:body>${body}</w:body></w:document>`);
  return zip.generateAsync({ type: "nodebuffer" });
}

const docx = await buildDocx();
const { text, images } = await extractDocxReadyPart(docx);

await test("таблиця → рядки «| … |» поспіль, «|» у клітинці не ламає рядок, об'єднана клітинка тримає ширину", async () => {
  const rows = text.split("\n").filter(l => l.startsWith("|"));
  assert.deepEqual(rows, [
    "| Складова | Характеристика |",
    "| --- | --- |",
    "| Мовна / лексика | Знання лексики |",
    "| Об'єднана на два стовпці |  |",
  ]);
  const i = text.indexOf("| Складова");
  assert.ok(!text.slice(i, text.indexOf("| Об'єднана")).includes("\n\n"), "рядки таблиці без порожніх рядків між ними");
});

await test("рисунок → окремий рядок-маркер перед підписом, байти картинки повернуті", async () => {
  assert.match(text, /\n\[ГОТОВА-ЧАСТИНА-РИСУНОК:0\]\n\nРис\.1\.1\./);
  assert.equal(images.length, 1);
  assert.equal(images[0].type, "image/png");
});

await test("стиснення: картинка в ліміті зберігається, битий файл → null з тим самим індексом", async () => {
  const logs = [];
  const packed = await compressReadyImages([images[0], { name: "x.emf", type: "image/x-emf", b64: Buffer.from("not an image").toString("base64") }], m => logs.push(m));
  assert.equal(packed.length, 2);
  assert.ok(packed[0]?.b64 && packed[0].type === "image/png");
  assert.equal(packed[1], null);
  assert.equal(logs.length, 1);
});

await test("експорт: таблиця Word і рисунок у підсумковому .docx, маркера в тексті немає", async () => {
  const content = { "1.1": text.split("\n").slice(1).join("\n") };
  const displayOrder = [{ id: "1.1", label: "1.1. Поняття говоріння", sectionTitle: "РОЗДІЛ 1. ТЕОРІЯ", type: "theory", pages: 1 }];
  const readyWorkImages = await compressReadyImages(images, () => {});
  const res = await exportToDocx({ content, info: { language: "Українська", topic: "Тест", type: "Курсова робота" }, displayOrder, orderId: "t", readyWorkImages });
  const x = await (await JSZip.loadAsync(res.buffer)).file("word/document.xml").async("text");
  assert.equal((x.match(/<w:tbl>/g) || []).length, 1);
  assert.equal((x.match(/<w:drawing>/g) || []).length, 1);
  assert.ok(!x.includes("ГОТОВА-ЧАСТИНА"), "маркер не має потрапити в текст");
  assert.ok(!x.includes(">Складова<") || x.indexOf(">Складова<") > x.indexOf("<w:tbl>"), "клітинка — в таблиці, а не окремим абзацом");
  // "Рис.1.1." без пробілу — підпис рисунка (по центру, чорний), а не помаранчева позначка "рисунка немає"
  const capAt = x.indexOf("Рис.1.1. Складові гейміфікації");
  const capPara = x.slice(x.lastIndexOf("<w:p>", capAt), capAt);
  assert.ok(!x.includes("B85C00"), "підпис не має бути помаранчевим");
  assert.match(capPara, /<w:jc w:val="center"\/>/);
});

console.log(`\n${passed} тестів пройшло`);
if (process.exitCode) console.error("Є ПОМИЛКИ");
