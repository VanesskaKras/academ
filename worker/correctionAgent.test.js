// Юніт-тест агентного режиму правок (src/lib/correctionAgent.js) — без
// реального ШІ: callClaudeMessage замокано скриптом кроків (tool_use), щоб
// перевірити самі інструменти над .docx і цикл (tool_result → наступний крок →
// finish) у Node, тобто так, як вони працюють у воркері.
// Запуск: node worker/correctionAgent.test.js
import assert from "node:assert/strict";
import { getDocxNodeIO } from "./docxNodeIO.js";
import { serializeDocx, refreshTextMap } from "../src/lib/docxSurgicalEdit.js";
import { runAgentCorrections, measureMainVolume, volumeBounds, parsePagesRange } from "../src/lib/correctionAgent.js";
import { runFileCorrections, prepareDocxForCorrections } from "../src/lib/correctionStages.js";

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
const NS = `xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"`;
const LONG = "Це звичайний абзац основного тексту, достатньо довгий, щоб код вважав його зразком оформлення для нових абзаців основного тексту роботи.";

// [0] заголовок (стиль "1" = heading 1), [1] абзац з виділенням, [2] абзац з
// коментарем, [3] маркер ілюстрації, [4] таблиця (клітинка), [5] ВИСНОВКИ,
// [6] текст висновків, [7] заголовок джерел, [8–9] джерела.
const DOCUMENT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<w:document ${NS}>
  <w:body>
    <w:p><w:pPr><w:pStyle w:val="1"/></w:pPr><w:r><w:t>1.1 Теоретичні засади</w:t></w:r></w:p>
    <w:p><w:pPr><w:pStyle w:val="Body"/><w:ind w:firstLine="709"/></w:pPr>
      <w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">Суть. </w:t></w:r>
      <w:r><w:rPr><w:rFonts w:ascii="Times New Roman"/></w:rPr><w:t xml:space="preserve">${LONG} </w:t></w:r>
      <w:r><w:rPr><w:rFonts w:ascii="Times New Roman"/><w:highlight w:val="yellow"/></w:rPr><w:t>памилка тут</w:t></w:r>
      <w:r><w:rPr><w:rFonts w:ascii="Times New Roman"/></w:rPr><w:t xml:space="preserve"> і далі текст [1].</w:t></w:r>
    </w:p>
    <w:p><w:pPr><w:pStyle w:val="Body"/></w:pPr>
      <w:commentRangeStart w:id="0"/>
      <w:r><w:t>Фрагмент з коментарем</w:t></w:r>
      <w:commentRangeEnd w:id="0"/>
      <w:r><w:rPr><w:commentReference w:id="0"/></w:rPr></w:r>
    </w:p>
    <w:p><w:r><w:t>[КЛІЄНТ-ІЛЮСТРАЦІЯ:1]</w:t></w:r></w:p>
    <w:tbl><w:tr><w:tc><w:p><w:r><w:t>Показник</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
    <w:p><w:pPr><w:pStyle w:val="1"/></w:pPr><w:r><w:t>ВИСНОВКИ</w:t></w:r></w:p>
    <w:p><w:pPr><w:pStyle w:val="Body"/></w:pPr><w:r><w:t>Висновок про результати дослідження.</w:t></w:r></w:p>
    <w:p><w:r><w:t>СПИСОК ВИКОРИСТАНИХ ДЖЕРЕЛ</w:t></w:r></w:p>
    <w:p><w:r><w:t>1. Іваненко І. Економіка. Київ, 2020. 200 с.</w:t></w:r></w:p>
    <w:p><w:r><w:t>2. Петренко П. Менеджмент. Львів, 2021. 150 с.</w:t></w:r></w:p>
    <w:sectPr/>
  </w:body>
</w:document>`;

const COMMENTS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<w:comments ${NS}>
  <w:comment w:id="0" w:author="Керівник"><w:p><w:r><w:t>Розкрийте детальніше.</w:t></w:r></w:p></w:comment>
</w:comments>`;

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8"?>
<w:styles ${NS}>
  <w:style w:styleId="1"><w:name w:val="heading 1"/></w:style>
  <w:style w:styleId="Body"><w:name w:val="Body Text"/></w:style>
</w:styles>`;

async function buildSyntheticDocx(documentXml = DOCUMENT_XML) {
  const zip = new io.JSZip();
  zip.file("word/document.xml", documentXml);
  zip.file("word/comments.xml", COMMENTS_XML);
  zip.file("word/styles.xml", STYLES_XML);
  return zip.generateAsync({ type: "nodebuffer" });
}

async function openSynthetic(documentXml) {
  return prepareDocxForCorrections(await buildSyntheticDocx(documentXml), io);
}

// Скрипт кроків: кожен крок — масив викликів [name, input] (або готовий об'єкт
// відповіді). seen.results[k] — tool_result-и, що пішли в модель на кроці k+1.
function scriptedAgent(steps) {
  let i = 0;
  const seen = { firstPrompt: null, extraCached: null, results: [], conversations: [] };
  const call = async (conversation, systemPrompt, maxTokens, model, opts) => {
    seen.conversations.push(JSON.parse(JSON.stringify(conversation)));
    if (!opts.tools) return { stop_reason: "end_turn", content: [{ type: "text", text: "1. Розпізнане з фото зауваження." }] };
    if (i === 0) {
      seen.firstPrompt = conversation[0].content.map(b => b.text || "").join("\n");
      seen.extraCached = opts.extraCached.join("\n");
    } else {
      seen.results.push(conversation.at(-1).content.filter(b => b.type === "tool_result"));
    }
    const step = steps[i++];
    if (!step) throw new Error("скрипт вичерпано");
    if (!Array.isArray(step)) return step;
    return {
      stop_reason: "tool_use",
      content: step.map(([name, input], k) => ({ type: "tool_use", id: `tu_${i}_${k}`, name, input })),
    };
  };
  return { call, seen };
}

await test("агент: читання з позначками, мінімальна правка, вставка з автооформленням, захисти, resolve, finish", async () => {
  const { zip, docXml, annotations } = await openSynthetic();
  const { call, seen } = scriptedAgent([
    [["read_paragraphs", { from: 0, to: 9 }]],
    [["replace_text", { paragraph: 1, old: "памилка тут", new: "помилки немає" }]],
    [["insert_paragraphs", { after: 0, text: "**Нове речення** після заголовка.\nДругий новий абзац [2]." }]],
    // мітка [2] лишилась за абзацом з коментарем, хоч перед ним вставлено два абзаци
    [["replace_text", { paragraph: 2, old: "Фрагмент з коментарем", new: "Розкритий фрагмент" }]],
    [["replace_text", { paragraph: 1, old: "і далі текст [1].", new: "і далі текст [7]." }]],
    [["replace_text", { paragraph: 6, old: "дослідження.", new: "дослідження [1]." }]],
    [["delete_paragraphs", { from: 3, to: 3, first_words: "[КЛІЄНТ-ІЛЮСТРАЦІЯ:1]" }]],
    [["delete_paragraphs", { from: 6, to: 6, first_words: "Зовсім інший початок" }]],
    [["insert_paragraphs", { after: 4, text: "| А | Б |\n|---|---|" }]],
    [["insert_paragraphs", { after: 4, text: "Текст після таблиці." }]],
    [["resolve", { remarks: ["#C0"], note: "розкрито" }]],
    [["finish", { summary: "Виконано.", needs_review: [{ remark: "#X", reason: "немає даних" }], volume_change_reason: "Розширте підрозділ." }]],
  ]);

  const result = await runAgentCorrections(
    { zip, docXml, annotations, instructions: "Розширте підрозділ.", orderInfo: { pages: "1" }, contextMode: "outline" },
    { callClaudeMessage: call, io },
  );

  assert.ok(seen.firstPrompt.includes("#H1 [абзац [1]]") && seen.firstPrompt.includes("памилка тут"));
  assert.ok(seen.firstPrompt.includes("#C0 [абзац [2]]"));
  assert.ok(seen.extraCached.includes("[0] 1.1 Теоретичні засади"), "заголовок за стилем heading 1 у структурі");

  const [read, repl, ins, replShifted, badCite, conclCite, delIll, delWrong, table, afterTbl, resolved] = seen.results.map(r => r[0]);
  assert.ok(read.content.includes("[0|заголовок] 1.1 Теоретичні засади"));
  assert.ok(read.content.includes("[4|таблиця] Показник"));
  assert.ok(!repl.is_error && repl.content.includes("помилки немає"), repl.content);
  assert.ok(ins.content.includes("[n1]–[n2]") && ins.content.includes("як у [1]"), ins.content);
  assert.ok(!replShifted.is_error, replShifted.content);
  assert.ok(badCite.is_error && badCite.content.includes("№7"));
  assert.ok(conclCite.is_error && conclCite.content.includes("ВИСНОВКАХ"), conclCite.content);
  assert.ok(delIll.is_error && delIll.content.includes("КЛІЄНТ-ІЛЮСТРАЦІЯ"));
  assert.ok(delWrong.is_error && delWrong.content.includes("починається інакше"));
  assert.ok(table.is_error && table.content.includes("Таблиці"));
  assert.ok(afterTbl.content.includes("після всієї таблиці"), afterTbl.content);
  assert.ok(resolved.content.includes("#C0: коментар закрито"));

  assert.equal(result.finished, true);
  assert.equal(result.modified, true);
  assert.deepEqual(result.failed.map(f => f.reason), ["немає даних"]);

  const lines = refreshTextMap(docXml).plainText.split("\n");
  assert.deepEqual(lines.slice(0, 4), ["1.1 Теоретичні засади", "Нове речення після заголовка.", "Другий новий абзац [2].", `Суть. ${LONG} помилки немає і далі текст [1].`]);
  assert.ok(lines.indexOf("Текст після таблиці.") === lines.indexOf("Показник") + 1);

  const xml = new io.XMLSerializer().serializeToString(docXml);
  assert.ok(!xml.includes("w:highlight"), "підсвітку знято");
  assert.ok(/<w:b\/><\/w:rPr><w:t xml:space="preserve">Суть. <\/w:t>/.test(xml), "жирний початок абзацу не зачеплено");
  const newPara = xml.match(/<w:p>(?:(?!<w:p>).)*Нове речення(?:(?!<\/w:p>).)*<\/w:p>/s)?.[0] || "";
  assert.ok(newPara.includes('w:pStyle w:val="Body"') && newPara.includes('w:firstLine="709"'), "після заголовка — оформлення звичайного абзацу");
  assert.ok(newPara.includes("Times New Roman") && !newPara.includes("<w:b/>") && !newPara.includes("w:highlight"), "шрифт переважного рану, не жирний");
  assert.ok(!xml.includes("commentRangeStart"));
  const out = await serializeDocx(zip, docXml, io);
  const comments = await (await io.JSZip.loadAsync(out)).file("word/comments.xml").async("string");
  assert.ok(!comments.includes('w:id="0"'));
});

await test("агент: finish відхиляється, поки зауваження не опрацьовано; невиконане — у failed", async () => {
  const { zip, docXml, annotations } = await openSynthetic();
  const { call, seen } = scriptedAgent([
    [["finish", { summary: "1" }]],
    [["finish", { summary: "2" }]],
  ]);
  const result = await runAgentCorrections({ zip, docXml, annotations, orderInfo: { pages: "1" } }, { callClaudeMessage: call, io });
  assert.ok(seen.results[0][0].is_error && seen.results[0][0].content.includes("#H1") && seen.results[0][0].content.includes("#C0"));
  assert.equal(result.summary, "2");
  assert.ok(result.failed.some(f => f.task.label.startsWith("#H1")));
  assert.ok(result.failed.some(f => f.task.label.startsWith("#C0")));
  const xml = new io.XMLSerializer().serializeToString(docXml);
  assert.ok(xml.includes("w:highlight"), "неопрацьоване виділення лишається видимим для людини");
});

await test("агент: зауваження в needs_review з міткою не блокують finish", async () => {
  const { zip, docXml, annotations } = await openSynthetic();
  const { call } = scriptedAgent([
    [["finish", { summary: "ok", needs_review: [{ remark: "#H1: памилка", reason: "треба уточнити" }, { remark: "#C0", reason: "немає даних" }] }]],
  ]);
  const result = await runAgentCorrections({ zip, docXml, annotations, orderInfo: { pages: "1" } }, { callClaudeMessage: call, io });
  assert.equal(result.steps, 1);
  assert.equal(result.failed.length, 2);
});

await test("агент: видалення абзацу з коментарем знімає коментар; порожня відповідь моделі не ламає історію", async () => {
  const { zip, docXml, annotations } = await openSynthetic();
  const { call, seen } = scriptedAgent([
    { stop_reason: "end_turn", content: [] },
    [["delete_paragraphs", { from: 2, to: 2, first_words: "Фрагмент з" }]],
    [["resolve", { remarks: ["H1"] }]],
    [["finish", { summary: "ok", volume_change_reason: "видалення за зауваженням" }]],
  ]);
  const result = await runAgentCorrections({ zip, docXml, annotations, contextMode: "full" }, { callClaudeMessage: call, io });
  assert.equal(result.finished, true, JSON.stringify(result.failed));
  assert.equal(result.failed.length, 0);
  for (const conv of seen.conversations) {
    assert.ok(conv.every(m => m.content.length > 0), "жодного порожнього повідомлення");
    conv.forEach((m, k) => { if (k) assert.notEqual(m.role, conv[k - 1].role, "ролі чергуються"); });
  }
});

await test("агент: обрізаний виклик (max_tokens) не виконується", async () => {
  const { zip, docXml, annotations } = await openSynthetic();
  const before = refreshTextMap(docXml).plainText;
  const { call, seen } = scriptedAgent([
    { stop_reason: "max_tokens", content: [{ type: "tool_use", id: "t1", name: "insert_paragraphs", input: { after: 1, text: "обрізано" }, _truncated: true }] },
    [["resolve", { remarks: ["#H1", "#C0"] }]],
    [["finish", { summary: "ok" }]],
  ]);
  await runAgentCorrections({ zip, docXml, annotations, orderInfo: { pages: "1" } }, { callClaudeMessage: call, io });
  assert.ok(seen.results[0][0].is_error);
  assert.equal(refreshTextMap(docXml).plainText.replace("Фрагмент з коментарем", ""), before.replace("Фрагмент з коментарем", ""));
});

await test("агент: фото зауважень розпізнаються один раз і далі йдуть текстом, без зображень", async () => {
  const { zip, docXml, annotations } = await openSynthetic();
  const { call, seen } = scriptedAgent([
    [["resolve", { remarks: ["#H1", "#C0"] }]],
    [["finish", { summary: "ok" }]],
  ]);
  const tinyPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  await runAgentCorrections({ zip, docXml, annotations, remarkFiles: [{ name: "a.png", type: "image/png", b64: tinyPng }], orderInfo: { pages: "1" } }, { callClaudeMessage: call, io });
  assert.equal(seen.conversations[0][0].content[0].type, "image", "перший виклик — розпізнавання фото");
  assert.ok(seen.firstPrompt.includes("ЗАУВАЖЕННЯ З ФОТО (розпізнано)") && seen.firstPrompt.includes("Розпізнане з фото"));
  seen.conversations.slice(1).forEach(conv => assert.ok(!JSON.stringify(conv).includes('"type":"image"'), "у кроках агента зображень немає"));
});

await test("measureMainVolume: ВСТУП із текстом (а не рядок змісту), додатки після джерел", () => {
  const lines = [
    "Титульна сторінка слово слово", "ЗМІСТ", "ВСТУП", "РОЗДІЛ 1", "СПИСОК ВИКОРИСТАНИХ ДЖЕРЕЛ", "ДОДАТКИ",
    "ВСТУП", "a ".repeat(100).trim(), "",
    "СПИСОК ВИКОРИСТАНИХ ДЖЕРЕЛ", "1. Автор А. Назва.",
    "ДОДАТОК А", "додаток не рахується зовсім",
  ];
  const v = measureMainVolume(lines);
  assert.equal(v.from, 6, "рядок змісту «ВСТУП» не є початком основної частини");
  assert.equal(v.to, 11);
  assert.equal(v.words, 1 + 100 + 3 + 4);
});

await test("parsePagesRange / volumeBounds: лише діапазон з рядка, ±10% від старту в межах замовлення, relaxed", () => {
  assert.deepEqual(parsePagesRange("30-35 стор. (±10%)"), { lo: 30, hi: 35, words: false });
  assert.deepEqual(parsePagesRange("25 стор., шрифт 14"), { lo: 25, hi: 25, words: false });
  assert.equal(parsePagesRange(""), null);
  assert.deepEqual(volumeBounds({ beforeWords: 7000, pages: "30-35" }), { lo: 6555, hi: 7700, fromOrder: true });
  assert.deepEqual(volumeBounds({ beforeWords: 9000, pages: "30-35" }), { lo: 8100, hi: 9000, fromOrder: true });
  assert.deepEqual(volumeBounds({ beforeWords: 7000, pages: "30-35", relaxed: true }), { lo: 6555, hi: 8453, fromOrder: true });
  assert.deepEqual(volumeBounds({ beforeWords: 1000, pages: "" }), { lo: 900, hi: 1100, fromOrder: false });
  assert.deepEqual(volumeBounds({ beforeWords: 1000, pages: null, relaxed: true }), { lo: 750, hi: 1250, fromOrder: false });
});

await test("агент: finish з обсягом поза межами відхиляється; volume_change_reason розширює межі", async () => {
  const { zip, docXml, annotations } = await openSynthetic();
  const big = Array.from({ length: 10 }, (_, i) => `Змістовне речення номер ${i + 1} для розширення підрозділу.`).join(" ");
  const { call, seen } = scriptedAgent([
    [["insert_paragraphs", { after: 1, text: big }], ["resolve", { remarks: ["#H1", "#C0"] }]],
    [["finish", { summary: "розширено" }]],
    [["finish", { summary: "розширено за вимогою", volume_change_reason: "#C0: розкрийте детальніше" }]],
  ]);
  const result = await runAgentCorrections({ zip, docXml, annotations, orderInfo: { pages: "1" }, contextMode: "outline" }, { callClaudeMessage: call, io });
  assert.ok(seen.results[0][0].content.includes("ПЕРЕВИЩЕНО"));
  assert.ok(seen.results[1][0].is_error && seen.results[1][0].content.includes("Завершити не можна"));
  assert.equal(result.summary, "розширено за вимогою");
  assert.ok(result.messages.some(m => m.text.includes("за вимогою зауваження")));
  assert.ok(!result.failed.some(f => f.task.label === "Обсяг роботи"));
});

await test("runFileCorrections mode:agent — рецензування прийнято, файл збережено навіть без текстових правок", async () => {
  const withIns = DOCUMENT_XML.replace("<w:r><w:t>Висновок", `<w:ins w:id="9" w:author="В"><w:r><w:t xml:space="preserve">Вставлено викладачем. </w:t></w:r></w:ins><w:r><w:t>Висновок`);
  const buffer = await buildSyntheticDocx(withIns);
  const { call } = scriptedAgent([
    [["resolve", { remarks: ["#H1", "#C0"] }]],
    [["finish", { summary: "done" }]],
  ]);
  const res = await runFileCorrections({ docxBuffer: buffer, mode: "agent", info: { pages: "1" } }, { callClaude: async () => "", callClaudeMessage: call, io });
  assert.ok(res.messages.some(m => m.text.includes("режиму рецензування")));
  const xml = await (await io.JSZip.loadAsync(res.buffer)).file("word/document.xml").async("string");
  assert.ok(xml.includes("Вставлено викладачем.") && !xml.includes("<w:ins"));
  assert.ok(!xml.includes("commentRangeStart"), "закритий через resolve коментар прибрано з файлу");
});

console.log(`\n${passed} passed`);
