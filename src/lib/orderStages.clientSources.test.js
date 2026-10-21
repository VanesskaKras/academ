// Смоук-тести runClientSourcesDistributionStage без реального API (callClaude
// і enrichLine мокаються — мережеві виклики enrichManualLine/enrichFullSourceInfo
// у продакшні лишаються за замовчуванням, тут підмінені для детермінізму).
// Запуск: node src/lib/orderStages.clientSources.test.js
import assert from "node:assert/strict";
import { runClientSourcesDistributionStage, isCitationMarkerOnly } from "./orderStages.js";

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
  info: { type: "Курсова робота", topic: "Тестова тема", subject: "Психологія", language: "Українська" },
  sections: [
    { id: "1.1", label: "1.1 Теорія", type: "theory" },
    { id: "2.1", label: "2.1 Аналіз", type: "analysis" },
    { id: "intro", label: "Вступ", type: "intro" },
    { id: "conclusions", label: "Висновки", type: "conclusions" },
  ],
  citInputs: {},
  abstractsMap: {},
  clientMaterialsSummary: { rawText: "Іванов І. Основи теорії. Київ, 2020. URL: https://example.com/a" },
};

const identityEnrich = async (line) => line;

await test("немає clientMaterialsSummary.rawText — не викликає AI, повертає незмінний патч", async () => {
  const order = { ...baseOrder, clientMaterialsSummary: null };
  const ctx = { callClaude: async () => { throw new Error("не мала викликатись"); } };
  const patch = await runClientSourcesDistributionStage(order, ctx);
  assert.deepEqual(patch.citInputs, {});
  assert.deepEqual(patch.abstractsMap, {});
  assert.deepEqual(patch.clientSourcesLog, []);
});

await test("немає основних підрозділів (лише intro/conclusions) — не викликає AI", async () => {
  const order = { ...baseOrder, sections: baseOrder.sections.filter(s => ["intro", "conclusions"].includes(s.type)) };
  const ctx = { callClaude: async () => { throw new Error("не мала викликатись") ; } };
  const patch = await runClientSourcesDistributionStage(order, ctx);
  assert.deepEqual(patch.citInputs, {});
});

await test("AI-виклик провалився — не падає, повертає незмінний патч", async () => {
  const ctx = { callClaude: async () => { throw new Error("simulated failure"); } };
  const patch = await runClientSourcesDistributionStage(baseOrder, ctx);
  assert.deepEqual(patch.citInputs, {});
});

await test("невалідний JSON у відповіді — не падає, повертає незмінний патч", async () => {
  const ctx = { callClaude: async () => "не JSON" };
  const patch = await runClientSourcesDistributionStage(baseOrder, ctx);
  assert.deepEqual(patch.citInputs, {});
});

await test("знайдене джерело з валідним sectionId — додається в citInputs і abstractsMap", async () => {
  const ctx = {
    callClaude: async () => JSON.stringify([
      { raw: "Іванов І. Основи теорії. Київ, 2020. URL: https://example.com/a", sectionId: "1.1", snippet: "Дає базове визначення теорії." },
    ]),
    enrichLine: identityEnrich,
  };
  const patch = await runClientSourcesDistributionStage(baseOrder, ctx);
  assert.ok(patch.citInputs["1.1"]?.includes("Іванов І."));
  assert.equal(patch.abstractsMap["Іванов І. Основи теорії. Київ, 2020. URL: https://example.com/a"], "Дає базове визначення теорії.");
  assert.equal(patch.clientSourcesLog.length, 1);
  assert.equal(patch.clientSourcesLog[0].sectionId, "1.1");
});

await test("sectionId відсутній у плані (вигаданий/null) — джерело клієнта НЕ губиться: іде в найменш заповнений підрозділ, у лозі причина", async () => {
  const ctx = {
    callClaude: async () => JSON.stringify([
      { raw: "Petrov P. Some Book. 2019.", sectionId: "9.9", snippet: "..." },
      { raw: "Sydorenko O. Another. 2021.", sectionId: null, snippet: "..." },
    ]),
    enrichLine: identityEnrich,
  };
  const patch = await runClientSourcesDistributionStage(baseOrder, ctx);
  const all = Object.values(patch.citInputs).join("\n");
  assert.ok(all.includes("Petrov P.") && all.includes("Sydorenko O."));
  assert.equal(patch.clientSourcesLog.length, 2);
  assert.ok(patch.clientSourcesLog.every(l => l.sectionId && l.reason));
});

await test("sectionId числом або з назвою підрозділу — розпізнається (кейс 41468: «розподілено 0 з 32»)", async () => {
  const ctx = {
    callClaude: async () => JSON.stringify([
      { raw: "Numeric Id. 2020.", sectionId: 1.1, snippet: "..." },
      { raw: "Labeled Id. 2021.", sectionId: "2.1 Якась назва", snippet: "..." },
    ]),
    enrichLine: identityEnrich,
  };
  const patch = await runClientSourcesDistributionStage(baseOrder, ctx);
  assert.ok(patch.citInputs["1.1"]?.includes("Numeric Id."));
  assert.ok(patch.citInputs["2.1"]?.includes("Labeled Id."));
  assert.ok(patch.clientSourcesLog.every(l => !l.reason));
});

await test("дублікат уже наявного джерела (той самий URL) — пропускається з причиною", async () => {
  const order = {
    ...baseOrder,
    citInputs: { "2.1": "Наявне джерело. 2018. URL: https://example.com/dup" },
  };
  const ctx = {
    callClaude: async () => JSON.stringify([
      { raw: "Інша назва того ж джерела. 2018. URL: https://example.com/dup", sectionId: "1.1", snippet: "..." },
    ]),
    enrichLine: identityEnrich,
  };
  const patch = await runClientSourcesDistributionStage(order, ctx);
  assert.equal(patch.citInputs["1.1"], undefined);
  assert.equal(patch.clientSourcesLog[0].reason, "дублікат наявного джерела");
});

await test("порожній масив від AI — незмінний патч", async () => {
  const ctx = { callClaude: async () => "[]" };
  const patch = await runClientSourcesDistributionStage(baseOrder, ctx);
  assert.deepEqual(patch.citInputs, {});
  assert.deepEqual(patch.clientSourcesLog, []);
});

await test("посилання з тексту ([12 с.312], [14 с.39; 15 с.214]. С. 14–15.) не стають джерелами, шапка не отримує джерел", async () => {
  const order = { ...baseOrder, sections: [
    { id: "1.1", label: "1.1 Група", type: "theory", headingOnly: true },
    { id: "1.1.1", label: "1.1.1 Теорія", type: "theory" },
    ...baseOrder.sections.filter(s => s.id !== "1.1"),
  ] };
  const ctx = {
    callClaude: async () => JSON.stringify([
      { raw: "[12 с.312]", sectionId: "1.1" },
      { raw: "[14 с.39; 15 с.214; 16 с.109]. С. 14–15.", sectionId: "2.1" },
      { raw: "Іванов І. Основи теорії. Київ, 2020. 200 с.", sectionId: "1.1" },
    ]),
    enrichLine: identityEnrich,
  };
  const patch = await runClientSourcesDistributionStage(order, ctx);
  const all = Object.values(patch.citInputs).join("\n");
  assert.ok(!all.includes("[12"), "маркер посилання не має потрапити в citInputs");
  assert.ok(all.includes("Іванов"), "справжнє джерело лишається");
  assert.ok(!patch.citInputs["1.1"], "шапка без тексту не отримує джерел");
  assert.equal(isCitationMarkerOnly("Шкляр В. Троща : роман. Харків, 2017. 416 с."), false);
  assert.equal(isCitationMarkerOnly("[6; 23]"), true);
});

console.log(`\n${passed} тестів пройшло`);
if (process.exitCode) console.error("Є ПОМИЛКИ");
