// Тести getWorkingDatesInRange / isWorkingDay.
// Запуск: node src/lib/ukrainianHolidays.test.js
import assert from "node:assert/strict";
import { getWorkingDatesInRange, isWorkingDay, isUkrainianPublicHoliday } from "./ukrainianHolidays.js";

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

test("виключає День незалежності 24.08.2026 (понеділок)", () => {
  const dates = getWorkingDatesInRange("20.08.2026", "28.08.2026");
  assert.ok(!dates.includes("24.08.2026"), "24.08.2026 не має бути у списку робочих днів");
});

test("виключає суботу і неділю 05-06.09.2026", () => {
  const dates = getWorkingDatesInRange("01.09.2026", "08.09.2026");
  assert.ok(!dates.includes("05.09.2026"));
  assert.ok(!dates.includes("06.09.2026"));
});

test("включає звичайні робочі дні періоду", () => {
  const dates = getWorkingDatesInRange("01.09.2026", "08.09.2026");
  // 01.09.2026 — вівторок, робочий день
  assert.ok(dates.includes("01.09.2026"));
  assert.ok(dates.includes("07.09.2026")); // понеділок
  assert.ok(dates.includes("08.09.2026")); // вівторок
});

test("isWorkingDay: субота/неділя завжди false", () => {
  assert.equal(isWorkingDay(new Date(Date.UTC(2026, 8, 5))), false); // субота
  assert.equal(isWorkingDay(new Date(Date.UTC(2026, 8, 6))), false); // неділя
});

test("православний Великдень 2024 (05.05) визначається як свято", () => {
  assert.equal(isUkrainianPublicHoliday(new Date(Date.UTC(2024, 4, 5))), true);
});

test("некоректний або порожній період -> порожній масив", () => {
  assert.deepEqual(getWorkingDatesInRange("", ""), []);
  assert.deepEqual(getWorkingDatesInRange("10.09.2026", "01.09.2026"), []);
});

console.log(`\n${passed} passed`);
