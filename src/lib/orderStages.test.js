// Смоук-тест runWritingSection без реального API — callClaude замоклений,
// щоб перевірити, що перенесена з academic-assistant.jsx логіка (проміжні
// етапи: buildMessages, побудова інструкції, enforceWordCount, capCitationRepeats,
// fixDanglingFigures, глосарій) виконується без падінь і повертає очікувану форму
// патчу. Не перевіряє якість самого тексту (це відповідальність промптів/моделі) —
// лише структурну коректність порту. Запуск: node src/lib/orderStages.test.js
import assert from "node:assert/strict";
import { runWritingSection } from "./orderStages.js";
import { SYS_JSON_ARRAY } from "./prompts.js";

let passed = 0;
function test(name, fn) {
  return (async () => {
    try {
      await fn();
      passed++;
      console.log(`  ok - ${name}`);
    } catch (err) {
      console.error(`FAIL - ${name}`);
      console.error(err);
      process.exitCode = 1;
    }
  })();
}

// ~230 слів (targetWords для sec.pages=1), щоб enforceWordCount не робив зайвих викликів
const PLACEHOLDER_PARAGRAPH = Array(230).fill("слово").join(" ") + ".";

function makeMockCallClaude(calls) {
  return async (messages, signal, sys, maxTokens, onWait, model, opts) => {
    calls.push({ sys, model, opts });
    if (sys === SYS_JSON_ARRAY) return "[]";
    return PLACEHOLDER_PARAGRAPH;
  };
}

const baseOrder = {
  info: { type: "Курсова робота", topic: "Тестова тема", subject: "Психологія", course: "3", pages: "30", language: "Українська" },
  sections: [
    { id: "1.1", label: "1.1 Перший підрозділ", sectionTitle: "РОЗДІЛ 1. ТЕОРІЯ", pages: 1, type: "theory" },
    { id: "intro", label: "Вступ", pages: 2, type: "intro" },
    { id: "conclusions", label: "Висновки", pages: 2, type: "conclusions" },
  ],
  content: {},
  citInputs: {},
  citStructured: {},
  abstractsMap: {},
  sourceThesisMap: {},
  commentAnalysis: null,
  methodInfo: null,
  appendicesText: "",
  clientMaterialsSummary: null,
  clientMaterialsText: "",
  econProfile: "",
  glossary: {},
  illustrationDescs: [],
  illustrations: [],
};

await test("theory-підрозділ: повертає патч з новим content, не чіпає інші поля", async () => {
  const calls = [];
  const ctx = { callClaude: makeMockCallClaude(calls), signal: undefined, onProgress: () => {} };
  const sec = baseOrder.sections[0];
  const patch = await runWritingSection(baseOrder, sec, ctx);

  assert.ok(patch.content["1.1"], "content для 1.1 має бути непорожнім рядком");
  assert.equal(typeof patch.content["1.1"], "string");
  assert.ok(calls.length >= 1, "callClaude мала бути викликана хоча б раз");
  // Порожні вхідні citInputs/abstractsMap/sourceThesisMap не змінюються (без джерел — нема що довставляти)
  assert.equal(patch.citInputs, baseOrder.citInputs);
  assert.equal(patch.abstractsMap, baseOrder.abstractsMap);
  assert.equal(patch.sourceThesisMap, baseOrder.sourceThesisMap);
  // Глосарій для theory-типу оновлюється (навіть якщо порожній масив термінів — mock повертає "[]")
  assert.equal(patch.glossary, baseOrder.glossary); // "[]" → 0 термінів → glossary лишається тим самим об'єктом
});

await test("intro-підрозділ: інструкція будується без методички/коментаря (гілка intro не падає)", async () => {
  const calls = [];
  const ctx = { callClaude: makeMockCallClaude(calls), signal: undefined, onProgress: () => {} };
  const sec = baseOrder.sections[1];
  const patch = await runWritingSection(baseOrder, sec, ctx);
  assert.ok(patch.content["intro"]);
});

await test("conclusions-підрозділ з непорожнім content з попередніх кроків — не падає на glossary-блоці", async () => {
  const calls = [];
  const ctx = { callClaude: makeMockCallClaude(calls), signal: undefined, onProgress: () => {} };
  const orderWithContent = { ...baseOrder, content: { "1.1": PLACEHOLDER_PARAGRAPH, intro: PLACEHOLDER_PARAGRAPH }, glossary: { "1.1": "тестовий термін" } };
  const sec = baseOrder.sections[2];
  const patch = await runWritingSection(orderWithContent, sec, ctx);
  assert.ok(patch.content["conclusions"]);
});

await test("підрозділ із джерелами в citInputs: пропущена цитата довставляється (mock без [N] у відповіді)", async () => {
  const calls = [];
  const ctx = { callClaude: makeMockCallClaude(calls), signal: undefined, onProgress: () => {} };
  const orderWithSources = { ...baseOrder, citInputs: { "1.1": "Іванов І. Тестове джерело. 2020." } };
  const sec = baseOrder.sections[0];
  // Мок callClaude не вставляє [1] у текст — insertMissingCitations сама зробить ще виклик(и);
  // головне, що весь ланцюжок не падає і повертає рядок.
  const patch = await runWritingSection(orderWithSources, sec, ctx);
  assert.ok(typeof patch.content["1.1"] === "string" && patch.content["1.1"].length > 0);
});

console.log(`\n${passed} тестів пройшло`);
if (process.exitCode) console.error("Є ПОМИЛКИ");
