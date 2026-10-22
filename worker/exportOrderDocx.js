#!/usr/bin/env node
// Продукує .docx для готового замовлення (stage:"done") тим самим шляхом, що
// й кнопка "Завантажити .docx" в DoneStage.jsx/PracticePage.jsx (exportToDocx
// з тими самими полями) — для звірки headless-результату воркера з
// browser-результатом на реальному замовленні.
//
// Охоплює основний потік (курсова/диплом/реферат тощо — ті самі поля, що
// DoneStage.jsx передає в exportToDocx) і звіти з практики (mode:"practice") —
// основний звіт + окремий .docx щоденника (buildPracticeMainExportParams/
// buildPracticeDiaryExportParams з src/lib/practiceStages.js, та сама логіка
// вибору титулки/аркуша завдання/календарного плану й розбору щоденника, що
// doExportMain/doExportDiary в PracticePage.jsx).
//
// Використання:
//   GOOGLE_APPLICATION_CREDENTIALS=... FIREBASE_PROJECT_ID=... \
//     node worker/exportOrderDocx.js <orderId> [outPath]
import { writeFile } from "node:fs/promises";
import { loadOrder, loadWebImages } from "./firestoreAdmin.js";
import { exportToDocx } from "../src/lib/exportDocx.js";
import { buildPracticeMainExportParams, buildPracticeDiaryExportParams } from "../src/lib/practiceStages.js";

const orderId = process.argv[2];
const outPathArg = process.argv[3];
if (!orderId) {
  console.error("Використання: node worker/exportOrderDocx.js <orderId> [outPath]");
  process.exit(1);
}

async function writeDocx(params, outPath) {
  const result = await exportToDocx(params);
  const path = outPath || result.filename;
  await writeFile(path, result.buffer);
  console.log(`✓ Записано: ${path} (${result.buffer.length} байт)`);
}

async function main() {
  const order = await loadOrder(orderId);

  if (order.mode === "practice") {
    await writeDocx({ ...buildPracticeMainExportParams(order), orderId, webImages: await loadWebImages(orderId) }, outPathArg);
    const diaryParams = buildPracticeDiaryExportParams(order);
    if (diaryParams) {
      await writeDocx({ ...diaryParams, orderId: `${orderId}_diary` }, null);
    } else {
      console.log("ℹ Щоденник ще не згенеровано (order.diaryContent порожній) — пропускаю.");
    }
    return;
  }

  await writeDocx({
    content: order.content,
    info: order.info,
    displayOrder: order.sections,
    appendicesText: order.appendicesText,
    titlePage: order.titlePage,
    titlePageLines: order.titlePageLines,
    methodInfo: order.methodInfo,
    commentAnalysis: order.commentAnalysis,
    orderId,
    annotationUk: order.annotationUk,
    annotationEn: order.annotationEn,
    illustrations: order.illustrations,
    readyWorkImages: order.readyWorkImages,
    webImages: await loadWebImages(orderId),
  }, outPathArg);
}

main().catch(e => {
  console.error("✗ Помилка:", e.message);
  console.error(e.stack);
  process.exit(1);
});
