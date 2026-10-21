// Смоук-тест runRemapStage без реального API. Використовує замовлення без
// цитат (citInputs: {}), щоб уникнути мокання складного форматування списку
// джерел (buildFinalReferenceList) — перевіряє структурну коректність порту:
// не падає, доходить до stage:"done", коректно рахує обсяг.
// Запуск: node src/lib/orderStages.remap.test.js
import assert from "node:assert/strict";
import { runRemapStage } from "./orderStages.js";

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

const words230 = Array(230).fill("слово").join(" ") + ".";

const baseOrder = {
  sections: [
    { id: "1.1", label: "1.1 Перший підрозділ", type: "theory", pages: 1 },
    { id: "intro", label: "Вступ", type: "intro", pages: 1 },
    { id: "conclusions", label: "Висновки", type: "conclusions", pages: 1 },
    { id: "sources", label: "Список використаних джерел", type: "sources", pages: 1 },
  ],
  content: { "1.1": words230, intro: words230, conclusions: words230, sources: "" },
  citInputs: {}, // без джерел — уникаємо виклику buildFinalReferenceList
  citStructured: {},
  methodInfo: null,
  commentAnalysis: null,
  citStyleOverride: null,
  sourcesOrderOverride: null,
  citFootnotes: false,
  info: { type: "Курсова робота", topic: "Тестова тема", subject: "Психологія", course: "3", pages: "4", language: "Українська" },
  appendicesText: "",
  refList: [],
};

function failIfCalled(name) {
  return async () => { throw new Error(`${name} не мала викликатись у цьому тесті (без цитат, обсяг у межах допуску)`); };
}

await test("без цитат, обсяг у межах допуску → доходить до stage:done без жодного AI-виклику", async () => {
  const ctx = { callClaude: failIfCalled("callClaude"), signal: undefined };
  const patch = await runRemapStage(baseOrder, ctx);
  assert.equal(patch.stage, "done");
  assert.equal(patch.status, "done");
  assert.deepEqual(patch.refList, []);
  assert.equal(patch.content["1.1"], words230, "текст підрозділу без цитат лишається незмінним");
  assert.equal(patch.annotationUk, undefined, "курсова — без анотації (тільки бак./маг.)");
});

await test("bachelor: генерує анотацію (annotationUk/annotationEn)", async () => {
  const ctx = {
    callClaude: async (messages, signal, sys) => {
      if (sys === undefined || typeof sys !== "string") return JSON.stringify({ uk: "Анотація укр", en: "Annotation en" });
      return JSON.stringify({ uk: "Анотація укр", en: "Annotation en" });
    },
    signal: undefined,
  };
  const order = { ...baseOrder, info: { ...baseOrder.info, type: "Бакалаврська робота" } };
  const patch = await runRemapStage(order, ctx);
  assert.equal(patch.annotationUk, "Анотація укр");
  assert.equal(patch.annotationEn, "Annotation en");
});

console.log(`\n${passed} тестів пройшло`);
if (process.exitCode) console.error("Є ПОМИЛКИ");
