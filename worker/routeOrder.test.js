// Юніт-тести routeOrder() без тест-фреймворка (у проєкті його зараз немає) —
// звичайний Node-скрипт з assert, запускається: node worker/routeOrder.test.js
import assert from "node:assert/strict";
import { routeOrder, buildTemplateText, FLOW, UnroutableOrderError } from "./routeOrder.js";
import { parseTemplate } from "../src/lib/planUtils.js";
import { normalizeWorkType } from "../src/lib/academicDefaults.js";

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (err) {
    console.error(`FAIL - ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

const basePayload = {
  orderNumber: "34455",
  direction: "Гуманітарне",
  subject: "Психологія",
  topic: "Вплив гаджетів на когнітивну поведінку дітей",
  deadline: "06.03.2026",
  pages: "100-120",
  uniqueness: "70-80%",
  price: 5000,
  files: [{ name: "methodichka.pdf" }],
};

// ── 10 підтримуваних значень "Вид роботи" → правильний flow/workType ──
const expected = [
  ["Курсова", FLOW.GREAT, null],
  ["Диплом", FLOW.GREAT, null],
  ["Бакалаврська", FLOW.GREAT, null],
  ["Магістерська", FLOW.GREAT, null],
  ["Правки", FLOW.CORRECTIONS, null],
  ["Проходження практики (звіт/щоденник)", FLOW.PRACTICE, null],
  ["Презентація", FLOW.SMALL, "prezentatsiya"],
  ["Реферат", FLOW.SMALL, "referat"],
  ["Тези", FLOW.SMALL, "tezy"],
  ["Есе", FLOW.SMALL, "ese"],
];

for (const [workTypeCrm, flow, workType] of expected) {
  test(`"${workTypeCrm}" → flow=${flow}${workType ? `, workType=${workType}` : ""}`, () => {
    const result = routeOrder({ ...basePayload, workTypeCrm });
    assert.equal(result.flow, flow);
    assert.equal(result.workType, workType);
    assert.equal(result.orderNumber, "34455");
    assert.deepEqual(result.files, [{ name: "methodichka.pdf" }]);
  });
}

// ── Практична робота / Самостійна робота — свідомо НЕ підтримуються ──
test('"Практична робота" кидає UnroutableOrderError (CRM не мала це надсилати)', () => {
  assert.throws(() => routeOrder({ ...basePayload, workTypeCrm: "Практична робота" }), UnroutableOrderError);
});
test('"Самостійна робота" кидає UnroutableOrderError', () => {
  assert.throws(() => routeOrder({ ...basePayload, workTypeCrm: "Самостійна робота" }), UnroutableOrderError);
});
test("невідоме значення кидає UnroutableOrderError", () => {
  assert.throws(() => routeOrder({ ...basePayload, workTypeCrm: "Щось незрозуміле" }), UnroutableOrderError);
});

// ── Наскрізна перевірка: templateText справді парситься parseTemplate() так,
// як очікує решта застосунку (без дублювання логіки парсингу полів) ──
test("templateText → parseTemplate() дає ті самі поля, що прийшли з CRM", () => {
  const result = routeOrder({ ...basePayload, workTypeCrm: "Курсова", course: "3" });
  const parsed = parseTemplate(result.templateText);
  assert.equal(parsed.orderNumber, "34455");
  assert.equal(parsed.type, "Курсова");
  assert.equal(parsed.direction, "Гуманітарне");
  assert.equal(parsed.subject, "Психологія");
  assert.equal(parsed.topic, "Вплив гаджетів на когнітивну поведінку дітей");
  assert.equal(parsed.pages, "100-120");
  assert.equal(parsed.uniqueness, "70-80%");
  assert.equal(parsed.course, "3");
});

// ── course_1_2 vs course_3_4: перевіряємо, що весь ланцюжок
// routeOrder → parseTemplate → normalizeWorkType визначає підтип коректно ──
test("Курсова, курс=2 → course_1_2", () => {
  const result = routeOrder({ ...basePayload, workTypeCrm: "Курсова", course: "2" });
  const parsed = parseTemplate(result.templateText);
  assert.equal(normalizeWorkType(parsed.type, parsed.course), "course_1_2");
});
test("Курсова, курс=4 → course_3_4", () => {
  const result = routeOrder({ ...basePayload, workTypeCrm: "Курсова", course: "4" });
  const parsed = parseTemplate(result.templateText);
  assert.equal(normalizeWorkType(parsed.type, parsed.course), "course_3_4");
});
test("Диплом → bachelor", () => {
  const result = routeOrder({ ...basePayload, workTypeCrm: "Диплом" });
  const parsed = parseTemplate(result.templateText);
  assert.equal(normalizeWorkType(parsed.type, parsed.course), "bachelor");
});
test("Бакалаврська → bachelor", () => {
  const result = routeOrder({ ...basePayload, workTypeCrm: "Бакалаврська" });
  const parsed = parseTemplate(result.templateText);
  assert.equal(normalizeWorkType(parsed.type, parsed.course), "bachelor");
});
test("Магістерська → master", () => {
  const result = routeOrder({ ...basePayload, workTypeCrm: "Магістерська" });
  const parsed = parseTemplate(result.templateText);
  assert.equal(normalizeWorkType(parsed.type, parsed.course), "master");
});

test("buildTemplateText пропускає порожні поля без порожніх рядків усередині", () => {
  const text = buildTemplateText({ orderNumber: "1", workTypeCrm: "Реферат", topic: "Тема X" });
  assert.ok(!text.includes("undefined"));
  assert.ok(text.includes("№ замовлення - 1"));
  assert.ok(text.includes("✈️Тема - Тема X"));
});

console.log(`\n${passed} тестів пройшло`);
if (process.exitCode) {
  console.error("Є ПОМИЛКИ");
}
