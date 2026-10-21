// Тести відновлення автонумерації Word у тексті .docx (кейс 41476).
// Запуск: node src/lib/docxListNumbers.test.js
import assert from "node:assert/strict";
import { injectListNumbersIntoXml } from "./docxListNumbers.js";

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (err) {
    console.error(`FAIL - ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

const lvl = (i, text, fmt = "decimal") =>
  `<w:lvl w:ilvl="${i}"><w:start w:val="1"/><w:numFmt w:val="${fmt}"/><w:lvlText w:val="${text}"/></w:lvl>`;
const overrides = [0, 1, 2, 3].map(i => `<w:lvlOverride w:ilvl="${i}"><w:startOverride w:val="1"/></w:lvlOverride>`).join("");
const numbering = `<w:numbering>
  <w:abstractNum w:abstractNumId="0">${lvl(0, "%1.")}${lvl(1, "%1.%2.")}${lvl(2, "%1.%2.%3")}${lvl(3, "%1.%2.%3.%4")}</w:abstractNum>
  <w:abstractNum w:abstractNumId="1">${lvl(0, "%1")}${lvl(1, "%1.%2")}${lvl(2, "%1.%2.%3")}</w:abstractNum>
  <w:abstractNum w:abstractNumId="2">${lvl(0, "•", "bullet")}</w:abstractNum>
  <w:abstractNum w:abstractNumId="3">${lvl(0, "%1)", "russianLower")}</w:abstractNum>
  <w:num w:numId="1"><w:abstractNumId w:val="0"/>${overrides}</w:num>
  <w:num w:numId="2"><w:abstractNumId w:val="1"/>${overrides}</w:num>
  <w:num w:numId="3"><w:abstractNumId w:val="2"/></w:num>
  <w:num w:numId="4"><w:abstractNumId w:val="3"/></w:num>
</w:numbering>`;

const p = (text, numId, ilvl) => numId == null
  ? `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`
  : `<w:p w:rsidR="1"><w:pPr><w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="${numId}"/></w:numPr></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`;
const texts = (xml) => [...xml.matchAll(/<w:p\b[\s\S]*?<\/w:p>/g)]
  .map(m => [...m[0].matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map(t => t[1]).join(""));

test("зміст 41476: 1.1. і 1.1.1/1.1.2 з різних списків, невикористані рівні — зі стартовим значенням", () => {
  const doc = [p("РОЗДІЛ 1"), p("Формально", 1, 1), p("Підходи", 2, 2), p("Засоби", 2, 2), p("1.2. Семантика")].join("");
  assert.deepEqual(texts(injectListNumbersIntoXml(doc, numbering, "")),
    ["РОЗДІЛ 1", "1.1. Формально", "1.1.1 Підходи", "1.1.2 Засоби", "1.2. Семантика"]);
});

test("4 рівні: лічильники глибших рівнів скидаються після вищого", () => {
  const doc = [p("A", 1, 0), p("B", 1, 1), p("C", 1, 2), p("D", 1, 3), p("E", 1, 3), p("F", 1, 2), p("G", 1, 1), p("H", 1, 3)].join("");
  assert.deepEqual(texts(injectListNumbersIntoXml(doc, numbering, "")),
    ["1. A", "1.1. B", "1.1.1 C", "1.1.1.1 D", "1.1.1.2 E", "1.1.2 F", "1.2. G", "1.2.1.1 H"]);
});

test("маркований список не чіпаємо, кириличні літери — як у Word", () => {
  const doc = [p("пункт", 3, 0), p("перший", 4, 0), p("другий", 4, 0)].join("");
  assert.deepEqual(texts(injectListNumbersIntoXml(doc, numbering, "")), ["пункт", "а) перший", "б) другий"]);
});

test("нумерація через стиль абзацу (заголовки)", () => {
  const styles = `<w:styles><w:style w:type="paragraph" w:styleId="H2"><w:pPr><w:numPr><w:ilvl w:val="1"/><w:numId w:val="1"/></w:numPr></w:pPr></w:style></w:styles>`;
  const doc = `<w:p><w:pPr><w:pStyle w:val="H2"/></w:pPr><w:r><w:t>Теорія</w:t></w:r></w:p>`;
  assert.deepEqual(texts(injectListNumbersIntoXml(doc, numbering, styles)), ["1.1. Теорія"]);
});

test("без numbering.xml або без нумерованих абзаців — документ без змін", () => {
  const doc = p("Текст");
  assert.equal(injectListNumbersIntoXml(doc, "", ""), doc);
  assert.equal(injectListNumbersIntoXml(doc, numbering, ""), doc);
});

console.log(`\n${passed} тестів пройшло`);
if (process.exitCode) console.error("Є ПОМИЛКИ");
