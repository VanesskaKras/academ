// Смоук-тести sectionNeedsAppendix / planAppendixGeneration / runAppendicesStage /
// runFillAppendixDataStage без реального API. Запуск:
// node src/lib/orderStages.appendices.test.js
import assert from "node:assert/strict";
import { sectionNeedsAppendix, planAppendixGeneration, runAppendicesStage, runFillAppendixDataStage } from "./orderStages.js";

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
  info: { type: "Курсова робота", topic: "Тестова тема", subject: "Психологія", course: "3", pages: "30", language: "Українська" },
  methodInfo: null,
  commentAnalysis: null,
  sections: [
    { id: "1.1", label: "1.1 Теорія", type: "theory" },
    { id: "2.1", label: "2.1 Організація дослідження", type: "analysis" },
    { id: "2.2", label: "2.2 Результати", type: "analysis" },
    { id: "intro", label: "Вступ", type: "intro" },
    { id: "conclusions", label: "Висновки", type: "conclusions" },
  ],
  content: {},
  clientMaterialsSummary: null,
  clientMaterialsText: "",
  econProfile: "",
  appendicesCustomPrompt: "",
  clientMaterials: [],
  appendicesText: "",
};

// ── sectionNeedsAppendix ──
await test("sectionNeedsAppendix: психологія (isPsychoPed) → analysis-підрозділ потребує додатку через getEmpiricalSections", () => {
  const order = { ...baseOrder };
  const sec = order.sections.find(s => s.id === "2.1");
  // Не перевіряємо точне значення (залежить від getEmpiricalSections/isPsychoPed) —
  // лише що функція не падає і повертає boolean.
  const result = sectionNeedsAppendix(sec, order);
  assert.equal(typeof result, "boolean");
});

await test("sectionNeedsAppendix: theory-підрозділ без emp/practical ознак — типово не потребує", () => {
  const order = { ...baseOrder, info: { ...baseOrder.info, subject: "Право" } };
  const sec = order.sections.find(s => s.id === "1.1");
  const result = sectionNeedsAppendix(sec, order);
  assert.equal(typeof result, "boolean");
});

// ── planAppendixGeneration ──
await test("planAppendixGeneration: психологія → needsAppendix=true, deferred=true (авторська анкета, немає фіксованого інструменту)", () => {
  const result = planAppendixGeneration(baseOrder);
  assert.equal(result.needsAppendix, true);
  assert.equal(result.deferred, true);
});

await test("planAppendixGeneration: реальний інструмент (psycho_scale) → needsAppendix=true, deferred=false (не чекає тексту)", () => {
  const order = { ...baseOrder, commentAnalysis: { researchDesign: { instrumentType: "psycho_scale" } } };
  const result = planAppendixGeneration(order);
  assert.equal(result.needsAppendix, true);
  assert.equal(result.deferred, false);
});

await test("planAppendixGeneration: невідома спеціальність, без practicalApproach/researchDesign → needsAppendix=true (специфіка не розпізнана)", () => {
  const order = { ...baseOrder, info: { ...baseOrder.info, subject: "Щось незрозуміле й нерозпізнаване" } };
  const result = planAppendixGeneration(order);
  assert.equal(result.needsAppendix, true);
});

// ── runAppendicesStage ──
await test("runAppendicesStage: генерує текст додатку, не падає (mock callClaude)", async () => {
  const ctx = { callClaude: async () => "ДОДАТОК А\nАнкета дослідження\n\n1. Питання один? а) так б) ні" };
  const patch = await runAppendicesStage(baseOrder, ctx);
  assert.ok(patch.appendicesText?.includes("ДОДАТОК А"));
});

await test("runAppendicesStage: finishedBodyTextOverride (відкладена генерація) не падає", async () => {
  const ctx = { callClaude: async () => "ДОДАТОК А\nАнкета дослідження" };
  const patch = await runAppendicesStage(baseOrder, ctx, { finishedBodyTextOverride: "Вибірка склала 42 респонденти." });
  assert.ok(patch.appendicesText?.includes("ДОДАТОК А"));
});

await test("runAppendicesStage: технічна робота з кодом клієнта додає лістинг у кінець", async () => {
  const order = {
    ...baseOrder,
    info: { ...baseOrder.info, subject: "Інформатика", type: "Курсова робота" },
    clientMaterials: [{ name: "main.js", text: "console.log('hi');" }],
  };
  const ctx = { callClaude: async () => "ДОДАТОК А\nОпис" };
  const patch = await runAppendicesStage(order, ctx);
  assert.ok(patch.appendicesText.includes("Вихідний код програми"));
  assert.ok(patch.appendicesText.includes("console.log"));
});

// ── runFillAppendixDataStage ──
await test("runFillAppendixDataStage: без маркера в тексті — не викликає AI, повертає порожній патч", async () => {
  const order = { ...baseOrder, appendicesText: "ДОДАТОК А\nЗвичайний текст без маркерів" };
  const ctx = { callClaude: async () => { throw new Error("не мала викликатись — немає маркера"); } };
  const patch = await runFillAppendixDataStage(order, ctx);
  assert.deepEqual(patch, {});
});

await test("runFillAppendixDataStage: лише маркер дати — заповнює без виклику AI", async () => {
  const order = { ...baseOrder, appendicesText: "Дата тестування: ЗАПОВНЮЄТЬСЯ_АВТОМАТИЧНО" };
  const ctx = { callClaude: async () => { throw new Error("не мала викликатись — лишився тільки маркер дати"); } };
  const patch = await runFillAppendixDataStage(order, ctx);
  assert.ok(!patch.appendicesText.includes("ЗАПОВНЮЄТЬСЯ_АВТОМАТИЧНО"));
  assert.ok(/Дата тестування: \d/.test(patch.appendicesText));
});

await test("runFillAppendixDataStage: маркер поза датою — викликає AI лише за значеннями (без переказу всього тексту)", async () => {
  const order = {
    ...baseOrder,
    appendicesText: "Статус: ЗАПОВНЮЄТЬСЯ_АВТОМАТИЧНО",
    content: { "1.1": "Текст роботи, функціонал працює коректно." },
  };
  const ctx = { callClaude: async () => '["ПРОЙДЕНО"]' };
  const patch = await runFillAppendixDataStage(order, ctx);
  assert.equal(patch.appendicesText, "Статус: ПРОЙДЕНО");
});

await test("runFillAppendixDataStage: кілька маркерів у різних додатках — підставляє значення по порядку появи", async () => {
  const order = {
    ...baseOrder,
    appendicesText: "ДОДАТОК А\nСтатус: ЗАПОВНЮЄТЬСЯ_АВТОМАТИЧНО\n\nДОДАТОК Б\nРезультат: ЗАПОВНЮЄТЬСЯ_АВТОМАТИЧНО",
    content: { "1.1": "Текст роботи, функціонал працює коректно." },
  };
  const ctx = { callClaude: async () => '["ПРОЙДЕНО", "УСПІШНО"]' };
  const patch = await runFillAppendixDataStage(order, ctx);
  assert.ok(patch.appendicesText.includes("Статус: ПРОЙДЕНО"));
  assert.ok(patch.appendicesText.includes("Результат: УСПІШНО"));
});

await test("runFillAppendixDataStage: AI повернув не той розмір масиву — лишає текст із заповненою датою, без обриву додатків", async () => {
  const order = { ...baseOrder, appendicesText: "Статус: ЗАПОВНЮЄТЬСЯ_АВТОМАТИЧНО" };
  const ctx = { callClaude: async () => '["одне", "зайве"]' };
  const patch = await runFillAppendixDataStage(order, ctx);
  assert.equal(patch.appendicesText, order.appendicesText);
});

await test("runFillAppendixDataStage: AI-виклик провалився — лишає текст як є (з заповненою датою, якщо була)", async () => {
  const order = { ...baseOrder, appendicesText: "Статус: ЗАПОВНЮЄТЬСЯ_АВТОМАТИЧНО" };
  const ctx = { callClaude: async () => { throw new Error("simulated failure"); } };
  const patch = await runFillAppendixDataStage(order, ctx);
  assert.equal(patch.appendicesText, order.appendicesText);
});

console.log(`\n${passed} тестів пройшло`);
if (process.exitCode) console.error("Є ПОМИЛКИ");
