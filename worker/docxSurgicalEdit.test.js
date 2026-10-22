// Юніт-тести шару редагування .docx (src/lib/docxSurgicalEdit.js, docxTree.js,
// docxAnnotations.js, locateSourcesZone) — у Node з @xmldom/xmldom, тобто в
// тому самому середовищі, що й воркер. Без ШІ.
// Запуск: node worker/docxSurgicalEdit.test.js
import assert from "node:assert/strict";
import { getDocxNodeIO } from "./docxNodeIO.js";
import {
  openDocxForEditing, refreshTextMap, applyDocxReplacement, setParagraphText, getParagraphs,
  acceptRevisionsInDocx, documentHasToc, setUpdateFieldsOnOpen, deleteParagraphEls, paragraphInlineMarkers,
  insertParagraphsAfterEl,
} from "../src/lib/docxSurgicalEdit.js";
import { extractAnnotationsFromOpenDocx, extractAnnotations } from "../src/lib/docxAnnotations.js";
import { locateSourcesZone } from "../src/lib/citationFormatting.js";
import { applyCorrectionTasks, prepareDocxForCorrections } from "../src/lib/correctionStages.js";

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (err) {
    console.error(`FAIL - ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

const io = getDocxNodeIO();
const NS = `xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"`;
const doc = body => `<?xml version="1.0" encoding="UTF-8"?><w:document ${NS}><w:body>${body}<w:sectPr/></w:body></w:document>`;
const para = (text, pPr = "") => `<w:p>${pPr}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;

async function build(body, extra = {}) {
  const zip = new io.JSZip();
  zip.file("word/document.xml", doc(body));
  for (const [name, content] of Object.entries(extra)) zip.file(name, content);
  return zip.generateAsync({ type: "nodebuffer" });
}
const xmlOf = async opened => new io.XMLSerializer().serializeToString(opened.docXml);

await test("setParagraphText: змінюються лише відмінні слова, жирний початок абзацу лишається жирним", async () => {
  const buf = await build(`<w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">Актуальність теми. </w:t></w:r><w:r><w:t>Стара думка про економіку регіону.</w:t></w:r></w:p>`);
  const opened = await openDocxForEditing(buf, io);
  const p = getParagraphs(opened.docXml)[0];
  setParagraphText(p, "Актуальність теми. Нова думка про економіку регіону.");
  const xml = await xmlOf(opened);
  assert.ok(/<w:b\/><\/w:rPr><w:t xml:space="preserve">Актуальність теми. <\/w:t>/.test(xml), "жирний ран не зачеплено");
  assert.equal(refreshTextMap(opened.docXml).plainText, "Актуальність теми. Нова думка про економіку регіону.");
  assert.ok(!/<w:b\/><\/w:rPr><w:t[^>]*>[^<]*Нова/.test(xml), "нове слово не стало жирним");
});

await test("applyDocxReplacement з \\n створює справжні абзаци, а не переноси в одному <w:t>", async () => {
  const buf = await build(para("Перший абзац.") + para("Другий абзац."));
  const opened = await openDocxForEditing(buf, io);
  const { map, plainText } = refreshTextMap(opened.docXml);
  const start = plainText.indexOf("Перший");
  applyDocxReplacement(map, start, start + "Перший абзац.".length, "Новий А.\nНовий Б.\nНовий В.");
  const after = refreshTextMap(opened.docXml).plainText;
  assert.equal(after, "Новий А.\nНовий Б.\nНовий В.\nДругий абзац.");
  assert.equal(getParagraphs(opened.docXml).length, 4);
  assert.ok(!/<w:t[^>]*>[^<]*\n/.test(await xmlOf(opened)), "жодного переносу всередині <w:t>");
});

await test("applyDocxReplacement через кілька абзаців зливає їх коректно", async () => {
  const buf = await build(para("Один.") + para("Два.") + para("Три."));
  const opened = await openDocxForEditing(buf, io);
  const { map, plainText } = refreshTextMap(opened.docXml);
  applyDocxReplacement(map, plainText.indexOf("Один"), plainText.indexOf("Три") + 4, "Разом.");
  assert.equal(refreshTextMap(opened.docXml).plainText, "Разом.");
});

await test("написи: текст mc:Fallback не дублюється, текст напису не липне до зовнішнього абзацу", async () => {
  const box = `<w:txbxContent><w:p><w:r><w:t>Текст схеми</w:t></w:r></w:p></w:txbxContent>`;
  const buf = await build(`<w:p><w:r><w:t xml:space="preserve">До фігури </w:t></w:r><w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing>${box}</w:drawing></mc:Choice><mc:Fallback><w:pict>${box}</w:pict></mc:Fallback></mc:AlternateContent></w:r></w:p>`);
  const opened = await openDocxForEditing(buf, io);
  const lines = opened.plainText.split("\n");
  assert.deepEqual(lines, ["До фігури ", "Текст схеми"]);
  assert.equal(getParagraphs(opened.docXml).length, 2);
});

await test("режим рецензування: вставки приймаються, видалення прибираються, злиття абзаців, коментар не губиться", async () => {
  const body =
    `<w:p><w:r><w:t xml:space="preserve">Було </w:t></w:r><w:del w:id="1" w:author="В"><w:r><w:delText>зайве </w:delText></w:r></w:del><w:ins w:id="2" w:author="В"><w:r><w:t>нове </w:t></w:r></w:ins><w:r><w:t>слово</w:t></w:r></w:p>` +
    `<w:p><w:pPr><w:rPr><w:del w:id="3" w:author="В"/></w:rPr></w:pPr><w:r><w:t xml:space="preserve">Половина </w:t></w:r></w:p>` +
    `<w:p><w:r><w:t>речення.</w:t></w:r></w:p>` +
    `<w:p><w:r><w:rPr><w:b/><w:rPrChange w:id="4" w:author="В"><w:rPr/></w:rPrChange></w:rPr><w:t>Жирне</w:t></w:r></w:p>` +
    `<w:p><w:del w:id="5" w:author="В"><w:commentRangeStart w:id="7"/><w:r><w:delText>прибрати</w:delText></w:r></w:del><w:r><w:t>лишити</w:t></w:r><w:commentRangeEnd w:id="7"/></w:p>`;
  const buf = await build(body, { "word/settings.xml": `<w:settings ${NS}><w:trackRevisions/><w:compat/></w:settings>` });
  const opened = await openDocxForEditing(buf, io);
  const res = await acceptRevisionsInDocx(opened.zip, opened.docXml, io);
  const text = refreshTextMap(opened.docXml).plainText;
  assert.equal(text, "Було нове слово\nПоловина речення.\nЖирне\nлишити");
  assert.ok(res.inserted >= 1 && res.deleted >= 2 && res.formatting >= 1 && res.trackingDisabled);
  const xml = await xmlOf(opened);
  assert.ok(!/w:ins|w:del\b|w:delText|rPrChange/.test(xml));
  assert.ok(xml.includes(`w:commentRangeStart w:id="7"`), "межа коментаря винесена з видаленого");
  const settings = await opened.zip.file("word/settings.xml").async("string");
  assert.ok(!settings.includes("trackRevisions"));
});

await test("зміст: поле TOC розпізнається, updateFields ставиться перед w:compat", async () => {
  const buf = await build(`<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> TOC \\o "1-3" </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>ВСТУП</w:t></w:r></w:p><w:p><w:r><w:t>РОЗДІЛ 1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>`,
    { "word/settings.xml": `<w:settings ${NS}><w:zoom w:percent="100"/><w:compat/></w:settings>` });
  const opened = await openDocxForEditing(buf, io);
  assert.ok(documentHasToc(opened.docXml));
  assert.ok(await setUpdateFieldsOnOpen(opened.zip, io));
  const settings = await opened.zip.file("word/settings.xml").async("string");
  assert.ok(/<w:zoom[^>]*\/><w:updateFields w:val="true"\/><w:compat\/>/.test(settings), settings);
  // Абзаци з половиною поля змісту не видаляються
  const res = deleteParagraphEls(getParagraphs(opened.docXml));
  assert.equal(res.deleted, 0);
  assert.equal(res.skipped.length, 2);
});

await test("табуляції й розриви рядка — позиції всередині абзацу", async () => {
  const buf = await build(`<w:p><w:r><w:t>Таблиця 1.1</w:t><w:tab/><w:t>Назва</w:t><w:br/><w:t>далі</w:t></w:r></w:p>`);
  const opened = await openDocxForEditing(buf, io);
  const marks = paragraphInlineMarkers(getParagraphs(opened.docXml)[0]);
  assert.deepEqual(marks, [{ offset: 11, kind: "tab" }, { offset: 16, kind: "br" }]);
});

await test("вставка після абзацу таблиці — за таблицею, а не в клітинку", async () => {
  const buf = await build(`<w:tbl><w:tr><w:tc>${para("Клітинка")}</w:tc></w:tr></w:tbl>${para("Після таблиці")}`);
  const opened = await openDocxForEditing(buf, io);
  const cell = getParagraphs(opened.docXml)[0];
  insertParagraphsAfterEl(cell, ["Новий текст"], cell, { afterTable: true });
  assert.equal(refreshTextMap(opened.docXml).plainText, "Клітинка\nНовий текст\nПісля таблиці");
  const xml = await xmlOf(opened);
  assert.ok(xml.indexOf("Новий текст") > xml.indexOf("</w:tbl>"));
});

await test("locateSourcesZone: 'СПИСОК ВИКОРИСТАНОЇ ЛІТЕРАТУРИ', додатки відсікаються, останній заголовок (не зі змісту)", () => {
  const text = [
    "ЗМІСТ", "СПИСОК ВИКОРИСТАНОЇ ЛІТЕРАТУРИ", "ДОДАТКИ",
    "ВСТУП", "Текст [1].",
    "СПИСОК ВИКОРИСТАНОЇ ЛІТЕРАТУРИ", "1. Іваненко І. Економіка. Київ, 2020. 200 с.", "2. Петренко П. Менеджмент. Львів, 2021.",
    "ДОДАТКИ", "1. Це рядок додатку, не джерело",
  ].join("\n");
  const zone = locateSourcesZone(text);
  assert.equal(zone.entries.length, 2);
  assert.ok(!text.slice(zone.sourcesStart, zone.sourcesEnd).includes("додатку"));
});

await test("locateSourcesZone: автонумерований список (номерів у тексті немає)", () => {
  const text = "СПИСОК ВИКОРИСТАНИХ ДЖЕРЕЛ\nІваненко І. Економіка. Київ, 2020. 200 с.\nПетренко П. Менеджмент. Львів, 2021. 150 с.";
  const zone = locateSourcesZone(text);
  assert.equal(zone.autoNumbered, true);
  assert.deepEqual(zone.entries.map(e => e.number), [1, 2]);
});

await test("перебудова джерел — по абзацах: номери оновлено, закладки на місці, новий запис окремим абзацом", async () => {
  const src = (n, t) => `<w:p><w:bookmarkStart w:id="${n}" w:name="src${n}"/><w:r><w:t xml:space="preserve">${n}. ${t}</w:t></w:r><w:bookmarkEnd w:id="${n}"/></w:p>`;
  const buf = await build(para("Текст [1], далі [2] і [3].") + para("СПИСОК ВИКОРИСТАНИХ ДЖЕРЕЛ") +
    src(1, "Іваненко І. Економіка. Київ, 2020. 200 с.") + src(2, "Петренко П. Менеджмент. Львів, 2021. 150 с.") + src(3, "Сидоренко С. Облік. Одеса, 2019. 90 с."));
  const opened = await openDocxForEditing(buf, io);
  const calls = [];
  const callClaude = async (messages) => {
    const prompt = typeof messages[0].content === "string" ? messages[0].content : "";
    calls.push(prompt.slice(0, 40));
    if (calls.length === 1) return JSON.stringify({ remove: [2], add: [] });
    return "[]";
  };
  const r = await applyCorrectionTasks({ zip: opened.zip, docXml: opened.docXml, tasks: [{ id: "s", kind: "sources_restructure", issue: "прибрати 2", suggestion: "видалити джерело 2" }] }, { callClaude, io });
  assert.equal(r.failed.length, 0, JSON.stringify(r.failed));
  const text = refreshTextMap(opened.docXml).plainText;
  assert.equal(text, "Текст [1], далі і [2].\nСПИСОК ВИКОРИСТАНИХ ДЖЕРЕЛ\n1. Іваненко І. Економіка. Київ, 2020. 200 с.\n2. Сидоренко С. Облік. Одеса, 2019. 90 с.");
  const xml = await xmlOf(opened);
  assert.ok(xml.includes(`w:name="src3"`), "закладка уцілілого джерела лишилась");
  assert.equal(getParagraphs(opened.docXml).length, 4);
});

await test("анотації з відкритого документа несуть рани; той самий перелік, що з буфера", async () => {
  const buf = await build(`<w:p><w:r><w:t xml:space="preserve">Текст </w:t></w:r><w:r><w:rPr><w:highlight w:val="yellow"/></w:rPr><w:t>памилка</w:t></w:r><w:r><w:rPr><w:color w:val="FF0000"/></w:rPr><w:t xml:space="preserve"> перевірте!</w:t></w:r></w:p>`);
  const opened = await openDocxForEditing(buf, io);
  const a = await extractAnnotationsFromOpenDocx(opened.zip, opened.docXml, io);
  const b = await extractAnnotations(buf, io);
  assert.equal(a.highlights.length, 1);
  assert.equal(a.highlights[0].runs.length, 1);
  assert.equal(a.colorNotes[0].text, "перевірте!");
  assert.deepEqual(a.highlights.map(h => h.text), b.highlights.map(h => h.text));
});

await test("prepareDocxForCorrections: приймає рецензування ДО витягу анотацій", async () => {
  const buf = await build(`<w:p><w:ins w:id="1" w:author="В"><w:r><w:rPr><w:highlight w:val="yellow"/></w:rPr><w:t>вставлене виділене</w:t></w:r></w:ins></w:p>`);
  const prepared = await prepareDocxForCorrections(buf, io);
  assert.equal(prepared.revisionsAccepted, true);
  assert.equal(prepared.plainText, "вставлене виділене");
  assert.equal(prepared.annotations.highlights[0].text, "вставлене виділене");
});

console.log(`\n${passed} passed`);
