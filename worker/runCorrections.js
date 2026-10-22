#!/usr/bin/env node
// CLI-скрипт: застосовує "правки" (виправлення за виділеннями/коментарями
// Word + опційно вільний текст зауважень) до локального .docx поза браузером,
// тим самим шляхом, що кнопка "Правки" (FileCorrectionsPage.jsx) — спільна
// логіка з src/lib/correctionStages.js, DOM-хірургія з src/lib/docxSurgicalEdit.js/
// docxAnnotations.js через Node-ін'єкцію (docxNodeIO.js). Без Firestore/CRM —
// локальний файл на вході, виправлений локальний файл на виході (аналог
// runOrder.js/exportOrderDocx.js для CRM-незалежного, одноразового прогону
// з консолі).
//
// Використання:
//   ANTHROPIC_API_KEY=... DIRECT_API=1 \
//     node worker/runCorrections.js <файл.docx> [--notes="текст зауважень"] \
//       [--notes-file=зауваження.txt] [--remark-files=фото1.jpg,фото2.png] \
//       [--lang="Українська"] [--out=outPath.docx] \
//       [--mode=classic|agent] [--context=auto|full|outline] [--api-base=https://...] \
//       [--order=<orderId>] [--pages=30-35] [--type="Курсова"] [--topic="..."]
//
// --mode=agent — агентний режим (src/lib/correctionAgent.js): ШІ сам читає,
// шукає й правит документ інструментами, як Claude Code. --context — лише для
// agent: full (увесь текст у кеші), outline (лише структура), auto (за обсягом
// зауважень). За замовчуванням — classic, як кнопка "Правки" в браузері.
//
// Умови замовлення: --order=<id> підтягує з Firestore (orders/{id}) мову,
// методичку, матеріали клієнта, тип/тему/предмет/курс і замовлений обсяг
// (потрібен GOOGLE_APPLICATION_CREDENTIALS, як для runOrder.js); --pages/
// --type/--topic задають їх вручну (і перекривають значення із замовлення).
// Обсяг (pages) агент тримає в межах кодовою перевіркою; без нього — ±10%
// від обсягу до правок.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { callClaude, createCostTracker, setApiBase, GENERATION_COST_LIMIT } from "../src/lib/api.js";
import { runFileCorrections } from "../src/lib/correctionStages.js";
import { getDocxNodeIO } from "./docxNodeIO.js";

function parseArgs(argv) {
  const inputPath = argv.find(a => !a.startsWith("--"));
  const notesArg = argv.find(a => a.startsWith("--notes="));
  const langArg = argv.find(a => a.startsWith("--lang="));
  const outArg = argv.find(a => a.startsWith("--out="));
  const apiBaseArg = argv.find(a => a.startsWith("--api-base="));
  const notesFileArg = argv.find(a => a.startsWith("--notes-file="));
  const modeArg = argv.find(a => a.startsWith("--mode="));
  const contextArg = argv.find(a => a.startsWith("--context="));
  const val = name => { const a = argv.find(x => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : null; };
  return {
    orderId: val("order"),
    pages: val("pages"),
    type: val("type"),
    topic: val("topic"),
    notesFile: notesFileArg ? notesFileArg.slice("--notes-file=".length) : null,
    remarkFilePaths: (val("remark-files") || "").split(",").map(x => x.trim()).filter(Boolean),
    mode: modeArg ? modeArg.slice("--mode=".length) : "classic",
    contextMode: contextArg ? contextArg.slice("--context=".length) : "auto",
    inputPath,
    notes: notesArg ? notesArg.slice("--notes=".length) : "",
    lang: langArg ? langArg.slice("--lang=".length) : null,
    outPath: outArg ? outArg.slice("--out=".length) : null,
    apiBase: apiBaseArg ? apiBaseArg.slice("--api-base=".length) : null,
  };
}

const { inputPath, notes, notesFile, remarkFilePaths, mode, contextMode, lang, outPath, apiBase, orderId, pages, type, topic } = parseArgs(process.argv.slice(2));
if (!inputPath) {
  console.error('Використання: node worker/runCorrections.js <файл.docx> [--notes="текст зауважень"] [--notes-file=файл.txt] [--remark-files=фото.jpg,...] [--mode=classic|agent] [--context=auto|full|outline] [--order=<id>] [--pages=30-35] [--type="Курсова"] [--topic="..."] [--lang="Українська"] [--out=outPath.docx]');
  process.exit(1);
}
if (apiBase) setApiBase(apiBase);
else if (process.env.API_BASE) setApiBase(process.env.API_BASE);

async function main() {
  const io = getDocxNodeIO();
  const inputBuffer = await readFile(inputPath);
  const fileName = path.basename(inputPath);
  const allNotes = [notes, notesFile ? await readFile(notesFile, "utf8") : ""].filter(s => s.trim()).join("\n\n");
  // Фото/скріни/PDF зауважень — той самий формат, що PhotoDropZone в UI ({name, type, b64}).
  const MIME = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", heic: "image/heic", pdf: "application/pdf" };
  const remarkFiles = await Promise.all(remarkFilePaths.map(async f => ({
    name: path.basename(f),
    type: MIME[path.extname(f).slice(1).toLowerCase()] || "application/octet-stream",
    b64: (await readFile(f)).toString("base64"),
  })));

  // Умови замовлення: з Firestore (--order) + ручні прапорці поверх них.
  let order = null;
  if (orderId) {
    const { loadOrder } = await import("./firestoreAdmin.js"); // лише з --order: без нього Firebase-ключ не потрібен
    order = await loadOrder(orderId);
    console.log(`→ Замовлення ${orderId}: ${order.info?.type || "?"}, «${order.info?.topic || "?"}», обсяг ${order.info?.pages || "?"}`);
  }
  const oi = order?.info || {};
  const info = {
    lang: lang || oi.language || "Українська",
    methodInfo: order?.methodInfo || null,
    clientMaterialsSummary: order?.clientMaterialsSummary || null,
    orderNumber: oi.orderNumber,
    type: type || oi.type,
    topic: topic || oi.topic,
    subject: oi.subject,
    course: oi.course,
    pages: pages || oi.pages,
  };

  console.log(`→ Читаю ${inputPath}... (режим: ${mode}${mode === "agent" ? `, контекст: ${contextMode}` : ""})`);
  const costTracker = createCostTracker(Number(process.env.CORRECTIONS_COST_LIMIT) || GENERATION_COST_LIMIT);
  const wrappedCallClaude = (messages, signal, systemPrompt, maxTokens, onWait, model, opts) =>
    callClaude(messages, signal, systemPrompt, maxTokens, onWait, model, { ...opts, costTracker });

  const result = await runFileCorrections(
    { docxBuffer: inputBuffer, fileName, instructions: allNotes, remarkFiles, info, mode, contextMode, markEdits: true },
    { callClaude: wrappedCallClaude, costTracker, onProgress: msg => console.log(`  ${msg}`), io }
  );

  for (const msg of result.messages || []) console.log(`  ${msg.type === "error" ? "⛔" : "✓"} ${msg.text}`);
  console.log(`✓ ${result.summary}`);
  if (result.volume) {
    const v = result.volume;
    console.log(`  Обсяг основної частини: ${v.before} → ${v.after} слів (≈${Math.round(v.before / 230)} → ${Math.round(v.after / 230)} стор.; межі ${v.lo}–${v.hi}${v.fromOrder ? ", за замовленням" : ", ±10%"})`);
  }
  for (const { task, reason } of result.failed || []) {
    console.log(`  ⚠ ${(task.label || task.location || task.annotatedText || "").slice(0, 80)} — ${reason}`);
  }

  const finalOutPath = outPath || path.join(
    path.dirname(inputPath),
    `${path.basename(inputPath, path.extname(inputPath))}_виправлено${mode === "agent" ? "_agent" : ""}.docx`
  );
  await writeFile(finalOutPath, result.buffer);
  console.log(`✓ Записано: ${finalOutPath} (${result.buffer.length} байт). Вартість: $${costTracker.value.toFixed(2)}`);
}

main().catch(e => {
  console.error("\n✗ Помилка:", e.message);
  console.error(e.stack);
  process.exit(1);
});
