// Юніт-тест Node-порту хірургічного редагування .docx (без тест-фреймворка,
// як і решта worker/*.test.js): будує мінімальний синтетичний .docx
// (лише word/document.xml + word/comments.xml — усе, що читають наші функції)
// з виділенням і коментарем, і проганяє його через той самий код, що працює в
// браузері (src/lib/docxSurgicalEdit.js, src/lib/docxAnnotations.js), лише з
// ін'єкцією Node-реалізацій JSZip/DOMParser/XMLSerializer (worker/docxNodeIO.js).
// Запуск: node worker/docxNodeIO.test.js
import assert from "node:assert/strict";
import { getDocxNodeIO } from "./docxNodeIO.js";
import { openDocxForEditing, refreshTextMap, applyDocxReplacement, removeDocxComment, serializeDocx } from "../src/lib/docxSurgicalEdit.js";
import { extractAnnotations } from "../src/lib/docxAnnotations.js";

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

async function buildSyntheticDocx(io) {
  const zip = new io.JSZip();
  zip.file("word/document.xml", DOCUMENT_XML);
  zip.file("word/comments.xml", COMMENTS_XML);
  return zip.generateAsync({ type: "nodebuffer" });
}

const io = getDocxNodeIO();

await test("extractAnnotations знаходить виділення й коментар (Node IO)", async () => {
  const buffer = await buildSyntheticDocx(io);
  const { highlights, comments } = await extractAnnotations(buffer, io);
  assert.equal(highlights.length, 1);
  assert.equal(highlights[0].text, "памилка тут");
  assert.equal(highlights[0].color, "yellow");
  assert.equal(comments.length, 1);
  assert.equal(comments[0].commentedText, "Фрагмент з коментарем");
  assert.equal(comments[0].instruction, "Виправте це, будь ласка.");
});

await test("applyDocxReplacement + removeDocxComment + serializeDocx — повний цикл (Node IO)", async () => {
  const buffer = await buildSyntheticDocx(io);
  const { zip, docXml, map, plainText } = await openDocxForEditing(buffer, io);

  const start = plainText.indexOf("памилка тут");
  assert.ok(start >= 0, "фрагмент має бути в plainText");
  applyDocxReplacement(map, start, start + "памилка тут".length, "помилку виправлено");
  const after1 = refreshTextMap(docXml);
  assert.ok(after1.plainText.includes("помилку виправлено"), "заміна має зʼявитись у тексті");
  assert.ok(!after1.plainText.includes("памилка тут"), "старий фрагмент має зникнути");

  await removeDocxComment(zip, docXml, "0", io);
  const after2 = refreshTextMap(docXml);
  assert.ok(after2.plainText.includes("Фрагмент з коментарем"), "текст під коментарем лишається — видаляється лише сам коментар");

  const outBuffer = await serializeDocx(zip, docXml, { ...io, asBuffer: true });
  assert.ok(Buffer.isBuffer(outBuffer), "serializeDocx(asBuffer:true) має повернути Buffer");

  // Перечитуємо результат «з нуля» — підтверджує, що зміни реально осіли в zip,
  // а не лише в живих DOM-обʼєктах з попереднього кроку.
  const reopened = await openDocxForEditing(outBuffer, io);
  assert.ok(reopened.plainText.includes("помилку виправлено"));
  assert.ok(!reopened.plainText.includes("памилка тут"));

  const rawZip = await io.JSZip.loadAsync(outBuffer);
  const commentsRaw = await rawZip.file("word/comments.xml").async("string");
  assert.ok(!commentsRaw.includes('w:id="0"'), "коментар має бути видалений з comments.xml");
  const docRaw = await rawZip.file("word/document.xml").async("string");
  assert.ok(!docRaw.includes("commentRangeStart"), "прив'язка коментаря має зникнути з document.xml");
});

if (process.exitCode) {
  console.error(`\n${passed} пройдено, є провали.`);
} else {
  console.log(`\nОК — усі ${passed} тестів пройдено.`);
}
