// Смоук-тести runAnalyzeStage без реального API. Перевіряють структурну
// коректність порту і саме механізм checkpoint-відновлення (analyzeProgress),
// заради якого ця функція й існує. Запуск: node src/lib/orderStages.analyze.test.js
import assert from "node:assert/strict";
import { runAnalyzeStage } from "./orderStages.js";

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

const baseOrder = {
  tplText: "Тип - Курсова\nТема - Тестова тема\nК-кість стр. - 30",
  comment: "",
  clientPlan: "",
  methodInfo: null,
  methodichkaFile: null,
  exampleWorkFile: null,
  illustrationsPdfFile: null,
  illustrations: [],
  photos: [],
  clientDrawings: [],
  clientMaterials: [],
  clientMaterialsText: "",
  appendicesText: "",
  fileLabel: "",
  exampleWorkFileName: "",
};

function makeSaveRecorder() {
  const calls = [];
  const save = async (patch) => { calls.push(patch); };
  return { save, calls };
}

await test("мінімальний вхід (без методички/фото/ілюстрацій) — не падає, повертає info", async () => {
  const { save, calls } = makeSaveRecorder();
  const ctx = {
    callClaude: async () => JSON.stringify({ topic: "Тестова тема" }),
    callGemini: async () => "{}",
    onProgress: () => {},
    save,
  };
  const patch = await runAnalyzeStage(baseOrder, ctx);
  assert.ok(patch.info, "info має бути присутнім");
  assert.equal(patch.commentAnalysis, null);
  assert.deepEqual(patch.illustrationDescs, []);
  assert.ok(calls.length >= 1, "save() мав викликатись хоча б раз (після методички/прикладу роботи, навіть без файлів)");
});

await test("методичка задана: викликає Gemini і позначає methodologyRead у прогресі", async () => {
  const { save } = makeSaveRecorder();
  let geminiCalls = 0;
  const ctx = {
    callClaude: async () => JSON.stringify({}),
    callGemini: async () => {
      geminiCalls++;
      return JSON.stringify({ chaptersCount: 2, subsectionsPerChapter: 3 });
    },
    onProgress: () => {},
    save,
  };
  const order = { ...baseOrder, methodichkaFile: { b64: "ZmFrZQ==", mediaType: "application/pdf" } };
  const patch = await runAnalyzeStage(order, ctx);
  assert.equal(geminiCalls, 2, "методичка читається у 2 виклики (структура + повне читання)");
  assert.ok(patch.methodInfo, "methodInfo має бути заповнений");
  assert.equal(patch.analyzeProgress.methodologyRead, true);
});

await test("checkpoint: methodologyRead=true у вхідному analyzeProgress → методичку НЕ перечитує повторно", async () => {
  const { save } = makeSaveRecorder();
  let geminiCalls = 0;
  const ctx = {
    callClaude: async () => JSON.stringify({}),
    callGemini: async () => { geminiCalls++; return JSON.stringify({}); },
    onProgress: () => {},
    save,
  };
  const order = {
    ...baseOrder,
    methodichkaFile: { b64: "ZmFrZQ==", mediaType: "application/pdf" },
    methodInfo: { chaptersCount: 3, otherRequirements: "вже проаналізовано раніше" },
    analyzeProgress: { methodologyRead: true },
  };
  const patch = await runAnalyzeStage(order, ctx);
  assert.equal(geminiCalls, 0, "callGemini не мала викликатись — крок вже позначено завершеним");
  assert.equal(patch.methodInfo.otherRequirements, "вже проаналізовано раніше", "має повторно використати вже наявний methodInfo");
});

await test("коментар + фото: аналізує коментар, позначає commentAnalysis у прогресі", async () => {
  const { save } = makeSaveRecorder();
  const ctx = {
    callClaude: async () => JSON.stringify({ planHints: "хінт" }),
    callGemini: async () => "{}",
    onProgress: () => {},
    save,
  };
  const order = { ...baseOrder, comment: "Врахуй розділ 1 і розділ 2" };
  const patch = await runAnalyzeStage(order, ctx);
  assert.ok(patch.commentAnalysis, "commentAnalysis має бути заповнений");
  assert.equal(patch.analyzeProgress.commentAnalysis, true);
});

await test("матеріали клієнта без файлів/креслень: іде через КРОК3.6+4 без падінь, позначає materialsText", async () => {
  const { save } = makeSaveRecorder();
  const ctx = {
    callClaude: async () => JSON.stringify({}),
    callGemini: async () => "{}",
    onProgress: () => {},
    save,
  };
  const order = { ...baseOrder, clientMaterials: [{ name: "файл.txt", text: "зміст файлу" }] };
  const patch = await runAnalyzeStage(order, ctx);
  assert.ok(patch.clientMaterialsSummary?.rawText.includes("зміст файлу"));
  assert.equal(patch.analyzeProgress.materialsText, true);
});

console.log(`\n${passed} тестів пройшло`);
if (process.exitCode) console.error("Є ПОМИЛКИ");
