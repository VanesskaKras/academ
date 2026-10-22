// Тест правки "переробити всю роботу під інший контекст" (documentAdaptation.js
// + захист таблиць у docxSurgicalEdit.js) без реального ШІ: callClaude замокано.
// Запуск: node worker/documentAdaptation.test.js
import assert from "node:assert/strict";
import { getDocxNodeIO } from "./docxNodeIO.js";
import { openDocxForEditing, refreshTextMap, applyDocxReplacement, serializeDocx } from "../src/lib/docxSurgicalEdit.js";
import { runFileCorrections, annotationsToTasks } from "../src/lib/correctionStages.js";
import { isAdaptationTask } from "../src/lib/documentAdaptation.js";
import { MODEL_FAST } from "../src/lib/api.js";

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok - ${name}`); }
  catch (err) { console.error(`FAIL - ${name}`); console.error(err); process.exitCode = 1; }
}
const io = getDocxNodeIO();
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const p = t => `<w:p><w:r><w:t>${t}</w:t></w:r></w:p>`;
const cell = t => `<w:tc>${p(t)}</w:tc>`;
const DOC = `<?xml version="1.0" encoding="UTF-8"?><w:document ${W}><w:body>
${p("Вступ")}
${p("У третьому класі школи навчається дитина з аутизмом [1].")}
${p("Це речення нейтральне і не потребує змін.")}
<w:tbl><w:tr>${cell("Критерій")}${cell("Школа")}</w:tr><w:tr>${cell("Роль")}${cell("Асистент вчителя")}</w:tr></w:tbl>
${p("Учитель проводить урок.")}
${p("Список використаних джерел")}
${p("1. Гаяш О. Формування траєкторій учнів з ООП. Київ, 2020.")}
</w:body></w:document>`;

async function buildDocx() {
  const zip = new io.JSZip();
  zip.file("word/document.xml", DOC);
  return zip.generateAsync({ type: "nodebuffer" });
}

const INSTR = "Чи могли б ви це саме переробити під роботу з дітьми у ЗДО а не школі";

await test("isAdaptationTask розпізнає «переробити під … ЗДО а не школі»", () => {
  assert.ok(isAdaptationTask({ suggestion: INSTR }));
  assert.ok(isAdaptationTask({ instruction: "адаптувати під ЗДО" }));
  assert.ok(!isAdaptationTask({ suggestion: "Виправити оформлення джерел" }));
});

await test("applyDocxReplacement відмовляє на markdown-таблицю й на заміну через кілька комірок", async () => {
  const { docXml } = await openDocxForEditing(await buildDocx(), io);
  const { map, plainText } = refreshTextMap(docXml);
  const s = plainText.indexOf("Критерій");
  const e = plainText.indexOf("Асистент вчителя") + "Асистент вчителя".length;
  assert.equal(applyDocxReplacement(map, s, e, "|Критерій|Школа|\n|---|---|", false), false);
  assert.equal(applyDocxReplacement(map, s, e, "звичайний текст", false), false, "заміна через кілька абзаців таблиці має бути відхилена");
  const s2 = plainText.indexOf("Учитель проводить урок.");
  assert.equal(applyDocxReplacement(map, s2, s2 + 5, "|x|y|", false), false);
});

await test("адаптація: змінює абзаци й комірки, таблиця ціла, підсвітка є, джерела не чіпає, залишки в звіті", async () => {
  const calls = [];
  const mock = async (messages, signal, sys, max, wait, model) => {
    const prompt = messages[0].content;
    calls.push(prompt.slice(0, 60));
    if (prompt.includes("Визнач, які слова")) return JSON.stringify({ stems: ["школ", "учн", "клас", "учител", "урок", "вчител"] });
    if (model === MODEL_FAST) return JSON.stringify([{ id: "t1", location: "Весь текст", issue: "Контекст", suggestion: INSTR }]);
    const out = [];
    for (const m of prompt.matchAll(/^\[(\d+)\](?: \(комірка таблиці\))? (.+)$/gm)) {
      const [, i, text] = m;
      if (text.includes("третьому класі")) out.push({ i: Number(i), text: "У середній групі закладу дошкільної освіти виховується дитина з аутизмом [1]." });
      else if (text === "Школа") out.push({ i: Number(i), text: "ЗДО" });
      else if (text === "Асистент вчителя") out.push({ i: Number(i), text: "Асистент вихователя" });
      else if (text.startsWith("Учитель")) out.push({ i: Number(i), text: "Вихователь проводить заняття.\nДругий рядок" }); // некоректно — має бути відхилено
    }
    return JSON.stringify(out);
  };
  const result = await runFileCorrections(
    { docxBuffer: await buildDocx(), fileName: "t.docx", instructions: INSTR, markEdits: true },
    { callClaude: mock, io, onProgress: () => {} }
  );
  const reopened = await openDocxForEditing(result.buffer, io);
  const t = reopened.plainText;
  assert.ok(t.includes("У середній групі закладу дошкільної освіти виховується дитина з аутизмом [1]."));
  assert.ok(t.includes("ЗДО") && t.includes("Асистент вихователя"));
  assert.ok(t.includes("Це речення нейтральне"), "непов'язаний абзац не змінено");
  assert.ok(t.includes("1. Гаяш О. Формування траєкторій учнів"), "список джерел не переписано");
  assert.ok(t.includes("Учитель проводить урок."), "абзац із некоректною відповіддю ШІ лишився як був");
  const xml = await reopened.zip.file("word/document.xml").async("string");
  assert.equal((xml.match(/<w:tc>/g) || []).length, 4, "комірки таблиці на місці");
  assert.equal((xml.match(/<w:tr>/g) || []).length, 2, "рядки таблиці на місці");
  assert.ok(!t.includes("|"), "жодного markdown у тексті");
  assert.ok((xml.match(/<w:shd /g) || []).length >= 3, "змінені абзаци підсвічені");
  assert.ok(result.messages.some(m => /Лишились згадки/.test(m.text)), "звіт називає абзаци, де лишився старий контекст");
  assert.ok(result.messages.some(m => /Список джерел не переписувався/.test(m.text)));
});

console.log(`\n${passed} passed`);
