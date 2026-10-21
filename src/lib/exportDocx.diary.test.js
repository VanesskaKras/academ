// Тести parseDiaryCalendarGraphRows: дата в клітинці визначає реальний тиждень практики,
// незалежно від того, в яку колонку її помилково вписав ШІ (типова помилка — усі дати в
// колонку "Тиждень 1"). Запуск: node src/lib/exportDocx.diary.test.js
import assert from "node:assert/strict";
import { parseDiaryCalendarGraphRows } from "./exportDocx.js";

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

const TABLE = `| Назви робіт | Тиждень 1 | Тиждень 2 | Тиждень 3 | Тиждень 4 | Відмітки |
|---|---|---|---|---|---|
| Оформлення | 10.08–11.08 |  |  |  | Виконано |
| Вивчення НПБ | 12.08–14.08 |  |  |  | Виконано |
| Характеристика | 17.08–19.08 |  |  |  | Виконано |
| Аналіз | 24.08–28.08 |  |  |  | Виконано |
`;

test("розкидає дати по правильних тижнях, навіть якщо ШІ вписав усе в колонку Тиждень 1", () => {
  const rows = parseDiaryCalendarGraphRows(TABLE, 4, "10.08.2026");
  assert.deepEqual(rows.map(r => r.weeks.findIndex(Boolean)), [0, 0, 1, 2]);
  assert.equal(rows[2].weeks[1], "17.08–19.08");
  assert.equal(rows[3].weeks[2], "24.08–28.08");
});

test("без dateStart — фолбек на позицію колонки як і раніше", () => {
  const rows = parseDiaryCalendarGraphRows(TABLE, 4, "");
  assert.equal(rows[0].weeks[0], "10.08–11.08");
  assert.equal(rows[3].weeks[0], "24.08–28.08");
});

console.log(`\n${passed} passed`);
