// Тести переписування плану за правками менеджера (worker/crmPlanReview.js + planUtils.js)
// без Firestore/CRM/API. Запуск: node worker/crmPlanReview.test.js
import assert from "node:assert/strict";
import { parseClientPlan, buildPlanText, buildPlanTextWithPages, rebuildPlanFromText, isSamePlanText } from "../src/lib/planUtils.js";
import { rewritePlanText } from "./crmPlanReview.js";

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

// План зі stage "plan": 30 стор. = вступ 2 + розділ 1 (5+6+4) + розділ 2 (7+3) + висновки 2 + джерела 1
const SRC = `Вступ
Розділ 1. Теоретичні основи
1.1 Поняття мотивації
1.2 Теорії мотивації
1.3 Чинники мотивації
Розділ 2. Практична частина
2.1 Аналіз підприємства
2.2 Рекомендації
Висновки
Список використаних джерел`;
const PAGES = { "1.1": 5, "1.2": 6, "1.3": 4, "2.1": 7, "2.2": 3 };
const oldSections = parseClientPlan(SRC, 30, "Українська").map(s => PAGES[s.id] ? { ...s, pages: PAGES[s.id] } : s);
const sumPages = (secs) => secs.reduce((n, s) => n + (s.pages || 0), 0);
const OLD_TOTAL = sumPages(oldSections);
const leafIds = (secs) => secs.filter(s => /^\d+\.\d+$/.test(s.id)).map(s => s.id);

await test("buildPlanTextWithPages: обсяг у рядках підрозділів, розділи й службові пункти без обсягу", () => {
  const t = buildPlanTextWithPages(oldSections);
  assert.match(t, /1\.1 Поняття мотивації \[5 стор\.\]/);
  assert.match(t, /2\.2 Рекомендації \[3 стор\.\]/);
  assert.doesNotMatch(t, /РОЗДІЛ 1\..*стор/);
  assert.doesNotMatch(buildPlanText(oldSections), /стор\./);
});

await test("перейменування підрозділу: сторінки інших збережено, сума й порядок ті самі", () => {
  const text = buildPlanTextWithPages(oldSections).replace("Теорії мотивації", "Сучасні підходи до мотивації");
  const plan = rebuildPlanFromText(oldSections, text, "Українська");
  const byId = Object.fromEntries(plan.sections.map(s => [s.id, s]));
  assert.equal(byId["1.1"].pages, 5);
  assert.equal(byId["2.1"].pages, 7);
  assert.equal(byId["1.2"].label, "1.2 Сучасні підходи до мотивації");
  assert.equal(byId["1.3"].pages, 4);
  assert.equal(byId["2.2"].pages, 3);
  assert.equal(byId["1.2"].pages, 6, "перейменований пункт отримує залишок суми після незмінених");
  assert.equal(sumPages(plan.sections), OLD_TOTAL);
});

await test("доданий підрозділ: з'являється в sections і sourceDist, сума сторінок лишається", () => {
  const text = buildPlanTextWithPages(oldSections).replace("    2.2 Рекомендації [3 стор.]", "    2.2 Рекомендації [3 стор.]\n    2.3 Економічна ефективність [4 стор.]");
  const plan = rebuildPlanFromText(oldSections, text, "Українська");
  assert.deepEqual(leafIds(plan.sections), ["1.1", "1.2", "1.3", "2.1", "2.2", "2.3"]);
  assert.ok("2.3" in plan.sourceDist);
  assert.deepEqual(Object.keys(plan.sourceDist).sort(), ["1.1", "1.2", "1.3", "2.1", "2.2", "2.3"]);
  assert.equal(sumPages(plan.sections), OLD_TOTAL);
  assert.ok(plan.sourceTotal > 0);
  assert.match(plan.planDisplay, /2\.3 Економічна ефективність/);
});

await test("видалений підрозділ зникає з sections і sourceDist; решта перенумерована", () => {
  const text = buildPlanTextWithPages(oldSections).split("\n").filter(l => !l.includes("Теорії мотивації")).join("\n");
  const plan = rebuildPlanFromText(oldSections, text, "Українська");
  assert.deepEqual(leafIds(plan.sections), ["1.1", "1.2", "2.1", "2.2"]);
  assert.equal(plan.sections.find(s => s.id === "1.2").label, "1.2 Чинники мотивації", "label несе новий номер");
  assert.ok(!("1.3" in plan.sourceDist));
  assert.equal(sumPages(plan.sections), OLD_TOTAL, "обсяг видаленого розподілився між рештою");
});

await test("явний [N стор.] у тексті змінює обсяг (решта пропорційно ужимається до тієї ж суми)", () => {
  const text = buildPlanTextWithPages(oldSections).replace("[5 стор.]", "[10 стор.]");
  const plan = rebuildPlanFromText(oldSections, text, "Українська");
  const p = (id) => plan.sections.find(s => s.id === id).pages;
  assert.ok(p("1.1") > p("1.2"), "1.1 тепер найбільший у розділі");
  assert.equal(sumPages(plan.sections), OLD_TOTAL);
});

await test("помилкова нумерація розділів від ШІ (1,2,2,3) виправляється послідовною", () => {
  const text = `Вступ
РОЗДІЛ 1. Теоретичні основи
    1.1 Поняття мотивації [5 стор.]
РОЗДІЛ 2. Нові методи
    2.1 Метод А [4 стор.]
РОЗДІЛ 2. Практична частина
    2.1 Аналіз підприємства [7 стор.]
Висновки
Список використаних джерел`;
  const plan = rebuildPlanFromText(oldSections, text, "Українська");
  assert.deepEqual(leafIds(plan.sections), ["1.1", "2.1", "3.1"]);
  assert.equal(new Set(plan.sections.map(s => s.id)).size, plan.sections.length);
  assert.match(plan.sections.find(s => s.id === "3.1").sectionTitle, /^РОЗДІЛ 3\./);
});

await test("вступ/висновки/джерела беруться зі старого плану; чого там нема — не додається", () => {
  const withCustom = oldSections.map(s => s.type === "intro" ? { ...s, label: "ВСТУП (особливий)", pages: 3 } : s);
  const plan = rebuildPlanFromText(withCustom, buildPlanTextWithPages(withCustom), "Українська");
  assert.equal(plan.sections[0].type, "intro");
  assert.equal(plan.sections[0].label, "ВСТУП (особливий)");
  assert.equal(plan.sections.at(-1).type, "sources");

  const noSources = oldSections.filter(s => s.type !== "sources");
  const plan2 = rebuildPlanFromText(noSources, buildPlanTextWithPages(noSources), "Українська");
  assert.ok(!plan2.sections.some(s => s.type === "sources"));
});

await test("текст без розділів → null", () => {
  assert.equal(rebuildPlanFromText(oldSections, "Просто речення без структури плану", "Українська"), null);
});

await test("isSamePlanText ігнорує регістр, пробіли й порожні рядки", () => {
  assert.ok(isSamePlanText("Вступ\n\n  Розділ 1.  Назва ", "вступ\nрозділ 1. назва"));
  assert.ok(!isSamePlanText("Вступ\nРозділ 1. А", "Вступ\nРозділ 1. Б"));
});

const nonEmptyInfo = { topic: "Мотивація персоналу", language: "Українська" };

await test("rewritePlanText: ШІ повернув зміну → текст без обгортки ```", async () => {
  const changed = buildPlanTextWithPages(oldSections).replace("Аналіз підприємства", "Аналіз ТОВ «Альфа»");
  let calls = 0;
  const out = await rewritePlanText({ sections: oldSections, comment: "уточни 2.1", info: nonEmptyInfo, call: async () => { calls++; return "```\n" + changed + "\n```"; } });
  assert.equal(calls, 1);
  assert.match(out, /Аналіз ТОВ «Альфа»/);
  assert.doesNotMatch(out, /```/);
});

await test("rewritePlanText: перший раз без змін → повтор, другий раз зміна", async () => {
  const same = buildPlanTextWithPages(oldSections);
  const changed = same.replace("Рекомендації", "Пропозиції");
  const seen = [];
  const out = await rewritePlanText({ sections: oldSections, comment: "перейменуй 2.2", info: nonEmptyInfo, call: async (m) => { seen.push(m.length); return seen.length === 1 ? same : changed; } });
  assert.deepEqual(seen, [1, 3], "повтор — з нагадуванням у діалозі");
  assert.match(out, /Пропозиції/);
});

await test("rewritePlanText: ШІ двічі без змін → помилка (stage plan), а не тихий старий план", async () => {
  const same = buildPlanTextWithPages(oldSections);
  await assert.rejects(
    () => rewritePlanText({ sections: oldSections, comment: "щось зміни", info: nonEmptyInfo, call: async () => same }),
    (e) => e.crmStage === "plan" && /не вніс правку/.test(e.message),
  );
});

await test("rewritePlanText: зміна лише обсягу ([N стор.]) вважається правкою", async () => {
  const resized = buildPlanTextWithPages(oldSections).replace("[7 стор.]", "[9 стор.]");
  const out = await rewritePlanText({ sections: oldSections, comment: "збільш 2.1", info: nonEmptyInfo, call: async () => resized });
  assert.match(out, /\[9 стор\.\]/);
});

console.log(`\n${passed} тестів пройдено`);
