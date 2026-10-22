// Юніт-тест headless-оркестрації правок (src/lib/correctionStages.js) — без
// реального виклику ШІ: callClaude замокано, щоб перевірити саме застосування
// відповіді до .docx (пошук фрагмента, заміна в XML, зняття коментаря,
// підрахунок success/failed) — ту саму логіку, що doApply() у
// FileCorrectionsPage.jsx. Запуск: node worker/correctionStages.test.js
import assert from "node:assert/strict";
import { getDocxNodeIO } from "./docxNodeIO.js";
import { openDocxForEditing, serializeDocx } from "../src/lib/docxSurgicalEdit.js";
import { extractAnnotations } from "../src/lib/docxAnnotations.js";
import { annotationsToTasks, applyCorrectionTasks, buildCitationPagesTask, runFileCorrections } from "../src/lib/correctionStages.js";
import { MODEL_FAST } from "../src/lib/api.js";

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

const DOCUMENT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p>
      <w:r><w:t>Звичайний текст без правок. </w:t></w:r>
      <w:r><w:rPr><w:highlight w:val="yellow"/></w:rPr><w:t>памилка тут</w:t></w:r>
      <w:r><w:t> і далі текст.</w:t></w:r>
    </w:p>
    <w:p>
      <w:commentRangeStart w:id="0"/>
      <w:r><w:t>Фрагмент з коментарем</w:t></w:r>
      <w:commentRangeEnd w:id="0"/>
      <w:r><w:rPr><w:commentReference w:id="0"/></w:rPr></w:r>
    </w:p>
  </w:body>
</w:document>`;

const COMMENTS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:comment w:id="0" w:author="Керівник"><w:p><w:r><w:t>Виправте це, будь ласка.</w:t></w:r></w:p></w:comment>
</w:comments>`;

const io = getDocxNodeIO();

async function buildSyntheticDocx() {
  const zip = new io.JSZip();
  zip.file("word/document.xml", DOCUMENT_XML);
  zip.file("word/comments.xml", COMMENTS_XML);
  return zip.generateAsync({ type: "nodebuffer" });
}

await test("applyCorrectionTasks застосовує батч annotation-завдань і знімає коментар", async () => {
  const buffer = await buildSyntheticDocx();
  const { zip, docXml } = await openDocxForEditing(buffer, io);
  const annotations = await extractAnnotations(buffer, io);
  const tasks = annotationsToTasks(annotations);
  assert.equal(tasks.length, 2);

  let callCount = 0;
  const mockCallClaude = async (messages) => {
    callCount++;
    const prompt = messages[0].content;
    assert.ok(prompt.includes("памилка тут") && prompt.includes("Фрагмент з коментарем"), "обидва завдання мають потрапити в один батч (той самий kind, менше BATCH_SIZE)");
    return JSON.stringify([
      { index: 0, status: "fixed", original: "памилка тут", replacement: "тут усе правильно" },
      { index: 1, status: "fixed", original: "Фрагмент з коментарем", replacement: "Виправлений фрагмент" },
    ]);
  };

  const result = await applyCorrectionTasks({ zip, docXml, tasks }, { callClaude: mockCallClaude, io, onProgress: () => {} });

  assert.equal(callCount, 1, "два завдання одного kind мають піти в один виклик ШІ (батчинг)");
  assert.equal(result.appliedCount, 2);
  assert.equal(result.failed.length, 0);
  assert.ok(result.correctedText.includes("тут усе правильно"));
  assert.ok(result.correctedText.includes("Виправлений фрагмент"));
  assert.ok(!result.correctedText.includes("памилка тут"));

  // Коментар мав зніматись під час заміни фрагмента c_0 (task.commentId) — перевіряємо в серіалізованому виводі.
  const outBuffer = await serializeDocx(zip, docXml, { ...io, asBuffer: true });
  const rawZip = await io.JSZip.loadAsync(outBuffer);
  const commentsRaw = await rawZip.file("word/comments.xml").async("string");
  assert.ok(!commentsRaw.includes('w:id="0"'), "коментар має зникнути з comments.xml після застосування правки");
});

await test("applyCorrectionTasks позначає needs_review як failed, не як застосовану правку", async () => {
  const buffer = await buildSyntheticDocx();
  const { zip, docXml } = await openDocxForEditing(buffer, io);
  const annotations = await extractAnnotations(buffer, io);
  const tasks = annotationsToTasks(annotations);

  const mockCallClaude = async () => JSON.stringify([
    { index: 0, status: "needs_review", note: "не можу перевірити факт" },
    { index: 1, status: "fixed", original: "Фрагмент з коментарем", replacement: "Виправлено" },
  ]);

  const result = await applyCorrectionTasks({ zip, docXml, tasks }, { callClaude: mockCallClaude, io, onProgress: () => {} });
  assert.equal(result.appliedCount, 1);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].reason, "не можу перевірити факт");
});

await test("buildCitationPagesTask повертає null, якщо немає невалідних сторінок у цитатах", () => {
  assert.equal(buildCitationPagesTask("Звичайний текст без жодних цитат."), null);
});

await test("runFileCorrections — повний цикл: анотації з файлу + instructions → виправлений buffer", async () => {
  const buffer = await buildSyntheticDocx();

  // Дискримінатор за унікальним заголовком кожного промпта (а не за вмістом
  // documentText) — надійніше, бо батчі виконуються послідовно й до моменту
  // виклику manual-батчу текст уже змінений попереднім annotation-батчем.
  const mockCallClaude = async (messages, signal, systemPrompt, maxTokens, onWait, model) => {
    const prompt = messages[0].content;
    if (model === MODEL_FAST) {
      // analyzeManualNotes() — аналіз вільного тексту instructions
      return JSON.stringify([
        { id: "task_1", location: "Весь текст", issue: "Застарілий термін", suggestion: "Замінити на сучасний відповідник" },
      ]);
    }
    if (prompt.includes("ВИДІЛЕНИЙ ФРАГМЕНТ")) {
      // applyOneBatch(kind:"annotation")
      return JSON.stringify([
        { index: 0, status: "fixed", original: "памилка тут", replacement: "усе правильно" },
        { index: 1, status: "fixed", original: "Фрагмент з коментарем", replacement: "Виправлений фрагмент" },
      ]);
    }
    // applyOneBatch(kind:"manual")
    assert.ok(prompt.includes("ЧАСТИНА ЯКА ПОТРЕБУЄ ВИПРАВЛЕННЯ"));
    return JSON.stringify([
      { index: 0, status: "fixed", original: "Звичайний текст без правок.", replacement: "Оновлений текст без правок." },
    ]);
  };

  const result = await runFileCorrections(
    { docxBuffer: buffer, fileName: "test.docx", instructions: "Заміни застарілий термін у тексті.", info: { orderNumber: "123" } },
    { callClaude: mockCallClaude, io, onProgress: () => {} }
  );

  assert.ok(Buffer.isBuffer(result.buffer), "runFileCorrections має повернути Buffer у result.buffer (io.asBuffer)");
  assert.ok(result.summary.startsWith("#123:"), "summary має включати orderNumber з info");
  assert.equal(result.changes.length, 3, "мають застосуватись 2 annotation-правки + 1 manual-правка");
  assert.equal((result.failed || []).length, 0);

  const reopened = await openDocxForEditing(result.buffer, io);
  assert.ok(reopened.plainText.includes("усе правильно"));
  assert.ok(reopened.plainText.includes("Оновлений текст без правок."));
  assert.ok(!reopened.plainText.includes("памилка тут"));
});

await test("runFileCorrections без анотацій і без instructions — повертає вхідний buffer без змін", async () => {
  const zip = new io.JSZip();
  zip.file("word/document.xml", '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Звичайний текст без анотацій.</w:t></w:r></w:p></w:body></w:document>');
  const plainBuffer = await zip.generateAsync({ type: "nodebuffer" });

  const result = await runFileCorrections(
    { docxBuffer: plainBuffer, fileName: "plain.docx", instructions: "" },
    { callClaude: async () => { throw new Error("callClaude не мав викликатись"); }, io }
  );

  assert.equal(result.buffer, plainBuffer);
  assert.deepEqual(result.changes, []);
  assert.ok(result.summary.includes("нічого виправляти"));
});

if (process.exitCode) {
  console.error(`\n${passed} пройдено, є провали.`);
} else {
  console.log(`\nОК — усі ${passed} тестів пройдено.`);
}
