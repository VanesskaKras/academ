// Смоук-тести runPlanStage без реального API. Перевіряють структурну коректність
// порту (чи не падає кожна гілка дерева рішень), не якість самого плану.
// Запуск: node src/lib/orderStages.plan.test.js
import assert from "node:assert/strict";
import { runPlanStage } from "./orderStages.js";
import { detectWriteScopeFromComment } from "./planUtils.js";

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
  comment: "",
  clientPlan: "",
  clientMaterialsSummary: null,
  clientMaterialsText: "",
  readyWorkText: "",
  content: {},
  citInputs: {},
  illustrations: [],
  illustrationsPdf: null,
};

function failIfCalled(name) {
  return async () => { throw new Error(`${name} не мала викликатись у цій гілці`); };
}

await test("без методички/плану клієнта → дефолтний план через naming-виклик (fallback гарантовано спрацьовує)", async () => {
  const ctx = {
    callClaude: async () => JSON.stringify({ titles: { "1.1": "Назва 1.1", "2.1": "Назва 2.1" } }),
    callGemini: failIfCalled("callGemini"),
    onProgress: () => {},
  };
  const patch = await runPlanStage(baseOrder, ctx);
  assert.ok(Array.isArray(patch.sections) && patch.sections.length > 3, "має повернути непорожній масив sections");
  assert.equal(patch.stage, "plan");
  assert.equal(patch.status, "plan_ready");
  assert.ok(patch.sections.some(s => s.type === "intro"));
  assert.ok(patch.sections.some(s => s.type === "conclusions"));
  assert.ok(patch.sections.some(s => s.type === "sources"));
});

await test("clientPlan заданий → бере структуру з нього, жодного AI-виклику не потрібно", async () => {
  const ctx = {
    callClaude: failIfCalled("callClaude"),
    callGemini: failIfCalled("callGemini"),
    onProgress: () => {},
  };
  const order = {
    ...baseOrder,
    clientPlan: [
      "Розділ 1. Теорія",
      "1.1 Перший підрозділ",
      "1.2 Другий підрозділ",
      "Розділ 2. Аналіз",
      "2.1 Третій підрозділ",
      "2.2 Четвертий підрозділ",
      "Вступ",
      "Висновки",
      "Список використаних джерел",
    ].join("\n"),
  };
  const patch = await runPlanStage(order, ctx);
  assert.ok(Array.isArray(patch.sections) && patch.sections.length > 3);
  assert.equal(patch.status, "plan_ready");
});

await test("clientPlan серед іншого тексту (обґрунтування, мета, завдання) → лише план + попередження про іншу організацію", async () => {
  const ctx = { callClaude: failIfCalled("callClaude"), callGemini: failIfCalled("callGemini"), onProgress: () => {} };
  const order = {
    ...baseOrder,
    info: { ...baseOrder.info, topic: "Управління організацією в умовах кризи (на прикладі ТОВ «АТБ-Маркет»)" },
    clientPlan: [
      "Пропозиція щодо затвердження теми",
      "1. Обґрунтування доцільності теми",
      "В умовах сучасних викликів кризові явища стали частиною діяльності підприємств.",
      "2. Об'єкт та предмет дослідження",
      "3. Мета та завдання роботи",
      "Завдання дослідження:",
      "1. Дослідити теоретико-методичні основи антикризового управління.",
      "2. Визначити роль стратегічного та тактичного менеджменту в",
      "подоланні кризових явищ.",
      "4. Розгорнутий план дипломної роботи",
      "ВСТУП",
      "РОЗДІЛ 1. ТЕОРЕТИКО-МЕТОДИЧНІ ОСНОВИ УПРАВЛІННЯ ОРГАНІЗАЦІЄЮ В",
      "УМОВАХ КРИЗИ",
      "1.1. Сутність кризових явищ на підприємстві.",
      "1.2. Специфіка стратегічного та тактичного підходів.",
      "РОЗДІЛ 2. АНАЛІЗ СИСТЕМИ УПРАВЛІННЯ ТОВ «АТБ-Маркет»",
      "2.1. Організаційно-економічна характеристика ТОВ «Нова",
      "Пошта».",
      "2.2. SWOT-аналіз підприємства.",
      "РОЗДІЛ 3. ШЛЯХИ ВДОСКОНАЛЕННЯ УПРАВЛІННЯ",
      "3.1. Розробка антикризової стратегії.",
      "3.2. Обґрунтування ефективності заходів.",
      "ВИСНОВКИ",
      "СПИСОК ВИКОРИСТАНИХ ДЖЕРЕЛ",
      "ДОДАТКИ",
      "5. Орієнтовний (базовий) список джерел",
    ].join("\n"),
  };
  const patch = await runPlanStage(order, ctx);
  const main = patch.sections.filter(s => /^\d+\.\d+$/.test(s.id));
  assert.deepEqual(main.map(s => s.id), ["1.1", "1.2", "2.1", "2.2", "3.1", "3.2"]);
  assert.ok(patch.sections.some(s => /ОРГАНІЗАЦІЄЮ В УМОВАХ КРИЗИ/.test(s.sectionTitle || "")), "перенесена назва розділу склеєна");
  assert.ok(main.find(s => s.id === "2.1").label.includes("«Нова Пошта»"), "перенесена назва підрозділу склеєна");
  assert.ok(!patch.sections.some(s => /Обґрунтування доцільності|Орієнтовний/.test(s.label || "")));
  assert.equal(patch.clientPlanIssues.length, 1);
  assert.match(patch.clientPlanIssues[0], /Нова Пошта/);
});

await test("methodInfo заданий → генерує план під методичку (методичка-гілка не падає)", async () => {
  const ctx = {
    callClaude: async () => { throw new Error("не мало дійти до naming — methodInfo-гілка мала повернутись раніше"); },
    callGemini: async () => JSON.stringify({
      sections: [
        { id: "1.1", label: "1.1 A", sectionTitle: "РОЗДІЛ 1", pages: 8, type: "theory" },
        { id: "1.2", label: "1.2 B", sectionTitle: "РОЗДІЛ 1", pages: 8, type: "theory" },
        { id: "2.1", label: "2.1 C", sectionTitle: "РОЗДІЛ 2", pages: 8, type: "analysis" },
        { id: "2.2", label: "2.2 D", sectionTitle: "РОЗДІЛ 2", pages: 6, type: "analysis" },
        { id: "intro", label: "Вступ", pages: 2, type: "intro" },
        { id: "conclusions", label: "Висновки", pages: 3, type: "conclusions" },
        { id: "sources", label: "Список використаних джерел", pages: 1, type: "sources" },
      ],
    }),
    onProgress: () => {},
  };
  const order = { ...baseOrder, methodInfo: { chaptersCount: 2, subsectionsPerChapter: 2 } };
  const patch = await runPlanStage(order, ctx);
  assert.ok(Array.isArray(patch.sections) && patch.sections.length > 3);
  assert.equal(patch.status, "plan_ready");
});

// Кейс 41476: зміст з пунктами 3-4 рівня + готовий розділ 2, к-сть сторінок — загальна
const deepPlan = [
  "ВСТУП",
  "РОЗДІЛ 1. ТЕОРЕТИЧНІ ЗАСАДИ …",
  "1.1. Формально-синтаксична організація речень …………… 5",
  "1.1.1 Основні підходи до кваліфікації речень",
  "1.1.2 Засоби вираження синтаксичного зв’язку",
  "1.1.2.1 Сполучники та сполучні слова",
  "1.1.2.2 Корелятивні пари",
  "1.2. Семантико-синтаксична організація речень",
  "РОЗДІЛ 2. АНАЛІЗ МАТЕРІАЛУ",
  "2.1. Присубстантивно-означальні речення",
  "2.2. Займенниково-означальні речення",
  "ВИСНОВКИ",
].join("\n");

await test("план з пунктами 3-4 рівня → id за рівнями, батьківські пункти — шапки без сторінок", async () => {
  const ctx = { callClaude: failIfCalled("callClaude"), callGemini: failIfCalled("callGemini"), onProgress: () => {} };
  const patch = await runPlanStage({ ...baseOrder, info: { ...baseOrder.info, pages: "40" }, clientPlan: deepPlan }, ctx);
  const byId = Object.fromEntries(patch.sections.map(s => [s.id, s]));
  for (const id of ["1.1", "1.1.1", "1.1.2", "1.1.2.1", "1.1.2.2", "1.2", "2.1", "2.2"]) assert.ok(byId[id], `немає ${id}`);
  assert.equal(byId["1.1"].headingOnly, true);
  assert.equal(byId["1.1.2"].headingOnly, true);
  assert.equal(byId["1.1"].pages, 0);
  assert.ok(!byId["1.1.1"].headingOnly && byId["1.1.1"].pages > 0);
  assert.equal(byId["1.1.2.1"].sectionTitle, "РОЗДІЛ 1. ТЕОРЕТИЧНІ ЗАСАДИ", "хвостове … має зникнути з назви розділу");
  assert.ok(!("1.1" in patch.sourceDist), "шапці не розподіляються джерела");
  assert.deepEqual(patch.clientPlanIssues, []);
  assert.equal(patch.sections.reduce((a, s) => a + s.pages, 0), 40);
});

await test("готова частина + план → к-сть сторінок у замовленні — обсяг саме нової частини", async () => {
  const ctx = { callClaude: failIfCalled("callClaude"), callGemini: failIfCalled("callGemini"), onProgress: () => {} };
  const para = "Слово ".repeat(230 * 10).trim(); // ~10 сторінок на підрозділ
  const readyWorkText = [
    "РОЗДІЛ 2", "АНАЛІЗ МАТЕРІАЛУ",
    "2.1. Присубстантивно-означальні речення", para,
    "2.2. Займенниково-означальні речення", para,
    "Висновки до розділу 2", "Слово ".repeat(230).trim(),
  ].join("\n");
  const patch = await runPlanStage({ ...baseOrder, info: { ...baseOrder.info, pages: "40" }, clientPlan: deepPlan, readyWorkText }, ctx);
  const imported = new Set(patch.readyWorkImportedIds);
  assert.ok(imported.has("2.1") && imported.has("2.2"));
  assert.deepEqual(patch.sections.map(s => s.id),
    ["intro", "1.1", "1.1.1", "1.1.2", "1.1.2.1", "1.1.2.2", "1.2", "2.1", "2.2", "2.conclusions", "conclusions", "sources"]);
  const byId = Object.fromEntries(patch.sections.map(s => [s.id, s]));
  assert.equal(byId["2.1"].sectionTitle, "РОЗДІЛ 2. АНАЛІЗ МАТЕРІАЛУ", "назва розділу з наступного рядка");
  assert.equal(byId["1.1"].sectionTitle, "РОЗДІЛ 1. ТЕОРЕТИЧНІ ЗАСАДИ", "дописаний розділ отримує назву з плану");
  // готовий текст ~21 с. (2 × 10 + висновки до розділу) + розділ 1 рівно на 40 с. чистого тексту;
  // вступ/висновки/джерела дописуються понад цей обсяг
  const chapterPages = patch.sections.filter(s => !imported.has(s.id) && !["intro", "conclusions", "sources"].includes(s.type)).reduce((a, s) => a + s.pages, 0);
  assert.ok(Math.abs(chapterPages - 40) <= 2, `розділ 1 має бути ~40 сторінок чистого тексту, а не ${chapterPages}`);
  const readyPages = patch.sections.filter(s => imported.has(s.id)).reduce((a, s) => a + s.pages, 0);
  assert.ok(readyPages >= 20, `готова частина лишається як є (${readyPages} с.)`);
});

// writeScope від CRM ({chapters:[2], pages:25}) — план на 3 розділи, готовий розділ 1,
// дописуємо ЛИШЕ розділ 2 (кейс 41510: без цієї перевірки розділ 3 писався теж)
const threeChapPlan = [
  "ВСТУП",
  "РОЗДІЛ 1. ТЕОРЕТИЧНІ ЗАСАДИ",
  "1.1. Перший підрозділ",
  "1.2. Другий підрозділ",
  "Висновки до розділу 1",
  "РОЗДІЛ 2. АНАЛІЗ",
  "2.1. Третій підрозділ",
  "2.2. Четвертий підрозділ",
  "Висновки до розділу 2",
  "РОЗДІЛ 3. РЕКОМЕНДАЦІЇ",
  "3.1. П'ятий підрозділ",
  "3.2. Шостий підрозділ",
  "Висновки до розділу 3",
  "ВИСНОВКИ",
  "СПИСОК ВИКОРИСТАНИХ ДЖЕРЕЛ",
].join("\n");

await test("writeScope {chapters:[2]} + готовий розділ 1 → пишемо лише розділ 2, не розділ 3 (кейс 41510)", async () => {
  const ctx = { callClaude: failIfCalled("callClaude"), callGemini: failIfCalled("callGemini"), onProgress: () => {} };
  const para = "Слово ".repeat(230 * 5).trim();
  const readyWorkText = [
    "ВСТУП", para,
    "РОЗДІЛ 1", "ТЕОРЕТИЧНІ ЗАСАДИ",
    "1.1. Перший підрозділ", para,
    "1.2. Другий підрозділ", para,
    "Висновки до розділу 1", "Слово ".repeat(115).trim(),
  ].join("\n");
  const order = {
    ...baseOrder,
    info: { ...baseOrder.info, pages: "25" },
    methodInfo: { hasChapterConclusions: true },
    clientPlan: threeChapPlan,
    readyWorkText,
    writeScope: { chapters: [2], pages: 25 },
  };
  const patch = await runPlanStage(order, ctx);
  const ids = patch.sections.map(s => s.id);
  assert.deepEqual(ids, ["intro", "1.1", "1.2", "1.conclusions", "2.1", "2.2", "2.conclusions", "sources"], "розділ 3 не має потрапити в sections; спільний список джерел — є");
  assert.ok(!ids.some(id => id.startsWith("3.")), "жодного пункту розділу 3");
  const byId = Object.fromEntries(patch.sections.map(s => [s.id, s]));
  assert.equal(byId["2.conclusions"].pages, 1, "висновки до розділу не мають забирати частку бюджету нарівні зі звичайним підрозділом");
  const imported = new Set(patch.readyWorkImportedIds);
  const newPages = patch.sections.filter(s => !imported.has(s.id) && s.type !== "sources").reduce((a, s) => a + s.pages, 0);
  assert.equal(newPages, 25, `дописана частина (розділ 2) має бути рівно 25 с., а не ${newPages}`);
});

// Без плану клієнта: готовий розділ 2 → дописуємо розділ 1 ПЕРЕД ним (раніше добирались лише
// розділи після останнього готового, і розділ 1 не з'являвся взагалі)
await test("без плану: готовий розділ 2 + writeScope {chapters:[1]} → розділ 1 перед готовим, обсяг — лише текст розділу", async () => {
  const fakeClaude = async () => JSON.stringify({ chapters: [
    { num: 1, title: "РОЗДІЛ 1. ТЕОРІЯ", type: "theory", subsections: ["1.1 Перший", "1.2 Другий"] },
  ] });
  const ctx = { callClaude: fakeClaude, callGemini: failIfCalled("callGemini"), onProgress: () => {} };
  const para = "Слово ".repeat(230 * 5).trim();
  const readyWorkText = [
    "РОЗДІЛ 2", "АНАЛІЗ",
    "2.1. Аналіз перший", para + " [1]",
    "2.2. Аналіз другий", para + " [2]",
    "2.3. Аналіз третій", para,
    "СПИСОК ВИКОРИСТАНИХ ДЖЕРЕЛ",
    "1. Іваненко І. Перша книга. Київ, 2020. 200 с.",
    "2. Петренко П. Друга книга. Львів, 2021. 150 с.",
    "3. Сидоренко С. Непроцитована книга. Одеса, 2019. 90 с.",
  ].join("\n");
  const patch = await runPlanStage({
    ...baseOrder, info: { ...baseOrder.info, pages: "20" }, readyWorkText,
    writeScope: { chapters: [1], pages: 20 },
  }, ctx);
  const ids = patch.sections.map(s => s.id);
  assert.deepEqual(ids, ["1.1", "1.2", "2.1", "2.2", "2.3", "sources"]);
  const byId = Object.fromEntries(patch.sections.map(s => [s.id, s]));
  assert.equal(byId["1.1"].pages + byId["1.2"].pages, 20, "20 с. — увесь обсяг розділу 1");
  assert.equal(byId["1.1"].sectionTitle, "РОЗДІЛ 1. ТЕОРІЯ");
  // непроцитоване джерело з готової частини теж іде в роботу (у список)
  const allCit = Object.values(patch.citInputs).join("\n");
  assert.ok(allCit.includes("Непроцитована книга"), "джерело без посилання з готової частини має лишитись");
  assert.ok(allCit.includes("Перша книга") && allCit.includes("Друга книга"));
});

await test("без плану й writeScope: готовий розділ 1 → розділ 2 на весь обсяг, вступ/висновки/джерела понад нього", async () => {
  const fakeClaude = async () => JSON.stringify({ chapters: [
    { num: 2, title: "РОЗДІЛ 2. АНАЛІЗ", type: "analysis", subsections: ["2.1 Перший", "2.2 Другий", "2.3 Третій"] },
  ] });
  const ctx = { callClaude: fakeClaude, callGemini: failIfCalled("callGemini"), onProgress: () => {} };
  const para = "Слово ".repeat(230 * 5).trim();
  const readyWorkText = [
    "РОЗДІЛ 1", "ТЕОРІЯ",
    "1.1. Теорія перша", para,
    "1.2. Теорія друга", para,
    "1.3. Теорія третя", para,
  ].join("\n");
  const patch = await runPlanStage({
    ...baseOrder, info: { ...baseOrder.info, pages: "15" }, methodInfo: { chaptersCount: 2 }, readyWorkText,
  }, ctx);
  assert.deepEqual(patch.sections.map(s => s.id), ["intro", "1.1", "1.2", "1.3", "2.1", "2.2", "2.3", "conclusions", "sources"]);
  const ch2 = patch.sections.filter(s => String(s.id).startsWith("2.")).reduce((a, s) => a + s.pages, 0);
  assert.equal(ch2, 15, `розділ 2 має забрати всі 15 с., а не ${ch2}`);
});

// Кейс 41570: у готовому розділі 1 на першій сторінці — ЗМІСТ з усім планом (1.1…3.5). Рядки
// змісту вважались готовими порожніми підрозділами, і розділ 2 не дописувався зовсім.
const plan41570 = [
  "ЗМІСТ", "", "ВСТУП", "", "РОЗДІЛ 1. ТЕОРЕТИЧНІ ЗАСАДИ ГОВОРІННЯ", "",
  "1.1. Поняття іншомовного говоріння у методиці навчання", "1.2. Сучасні підходи до формування навичок мовлення", "",
  "РОЗДІЛ 2. МЕТОДИКА НАВЧАННЯ ГОВОРІННЯ ІЗ ЗАСТОСУВАННЯМ ГЕЙМІФІКАЦІЇ", "",
  "2.1. Аналіз стану сформованості навичок говоріння в учнів", "2.2. Розробка комплексу гейміфікованих вправ для учнів",
  "2.3. Модель уроку англійської мови з використанням гейміфікації", "2.4. Проведення педагогічного експерименту та аналіз результатів", "",
  "РОЗДІЛ 3. ПРАКТИЧНА РЕАЛІЗАЦІЯ МЕТОДИКИ", "", "3.1. Комплекс гейміфікованих вправ для розвитку говоріння", "",
  "ВИСНОВКИ", "", "СПИСОК ВИКОРИСТАНИХ ДЖЕРЕЛ",
].join("\n");
const para = (n) => Array.from({ length: n }, () => "Текст підрозділу про говоріння і гейміфікацію [1].").join(" ");
const ready41570 = [
  plan41570, "", "", "ВСТУП", para(40), "РОЗДІЛ 1", "ТЕОРЕТИЧНІ ЗАСАДИ ГОВОРІННЯ",
  "1.1. Поняття іншомовного говоріння у методиці навчання", para(60),
  "1.2. Сучасні підходи до формування навичок мовлення", para(60),
  "СПИСОК ВИКОРИСТАНИХ ДЖЕРЕЛ", "1. Автор А. Назва книги. Київ, 2020. 200 с.",
].join("\n");
const comment41570 = "Потрібно виконати 2-й розділ роботи за готовим планом клієнта, який є у прикріпленому файлі.\n\n1-й розділ уже написаний, тому новий розділ потрібно виконувати з урахуванням його тематики.\n\n📌 Обсяг 2-го розділу — 10 сторінок.";

await test("кейс 41570: ЗМІСТ у готовій частині не рахується готовим, пишеться лише розділ 2 з коментаря, рівно 10 с.", async () => {
  const ctx = { callClaude: failIfCalled("callClaude"), callGemini: failIfCalled("callGemini"), onProgress: () => {} };
  const patch = await runPlanStage({ ...baseOrder, info: { ...baseOrder.info, pages: "10" }, clientPlan: plan41570, readyWorkText: ready41570, comment: comment41570 }, ctx);
  const ids = patch.sections.map(s => s.id);
  assert.deepEqual(ids, ["intro", "1.1", "1.2", "2.1", "2.2", "2.3", "2.4", "sources"]);
  assert.deepEqual(patch.readyWorkImportedIds, ["intro", "1.1", "1.2"], "зі змісту нічого не імпортується");
  const ch2 = patch.sections.filter(s => s.id.startsWith("2.")).map(s => s.pages);
  assert.equal(ch2.reduce((a, b) => a + b, 0), 10, `розділ 2 — рівно 10 с., а не ${ch2}`);
  assert.ok(ch2.every(p => p > 0));
});

await test("кейс 41570 без вказівки в коментарі → дописується все відсутнє за планом, зміст не імпортується", async () => {
  const ctx = { callClaude: failIfCalled("callClaude"), callGemini: failIfCalled("callGemini"), onProgress: () => {} };
  const patch = await runPlanStage({ ...baseOrder, info: { ...baseOrder.info, pages: "10" }, clientPlan: plan41570, readyWorkText: ready41570, comment: "" }, ctx);
  const ids = patch.sections.map(s => s.id);
  for (const id of ["2.1", "2.4", "3.1", "conclusions"]) assert.ok(ids.includes(id), `немає ${id}`);
  assert.equal(ids.filter(id => id === "1.1").length, 1, "1.1 не дублюється");
});

await test("detectWriteScopeFromComment: номери розділів з коментаря", async () => {
  const cases = [
    [comment41570, [2]],
    ["Треба дописати 2 і 3 розділи, 10 сторінок", [2, 3]],
    ["Дописати розділи 2-3", [2, 3]],
    ["Написати другий та третій розділи", [2, 3]],
    ["Потрібно написати розділ 3", [3]],
    ["Треба написати роботу, 3 розділи", null],
    ["Потрібно, щоб у 2 розділі була таблиця", null],
    ["Розділ 1 уже написаний", null],
    ["", null],
  ];
  for (const [text, want] of cases) assert.deepEqual(detectWriteScopeFromComment(text)?.chapters ?? null, want, text);
});

console.log(`\n${passed} тестів пройшло`);
if (process.exitCode) console.error("Є ПОМИЛКИ");
