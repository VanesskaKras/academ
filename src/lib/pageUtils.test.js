// Тести нормалізації й розбору сторінок джерела (pageUtils.js).
// Запуск: node src/lib/pageUtils.test.js
import assert from "node:assert/strict";
import { normalizePages, formatPages, normalizeTotalPages, extractPagesFromDoi, parseRefPages, narrowBookRange } from "./pageUtils.js";

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (err) {
    console.error(`  FAIL - ${name}\n    ${err.message}`);
    process.exitCode = 1;
  }
}

test("normalizePages: звичайні діапазони з різних баз", () => {
  assert.deepEqual(normalizePages("12-19"), { first: 12, last: 19 });
  assert.deepEqual(normalizePages("12–19"), { first: 12, last: 19 });
  assert.deepEqual(normalizePages("С. 12–19"), { first: 12, last: 19 });
  assert.deepEqual(normalizePages("pp. 191 - 199"), { first: 191, last: 199 });
  assert.deepEqual(normalizePages(45), { first: 45, last: 45 });
  assert.deepEqual(normalizePages({ first: "340", last: "343" }), { first: 340, last: 343 });
});

test("normalizePages: скорочений запис кінцевої сторінки", () => {
  assert.deepEqual(normalizePages("1234-45"), { first: 1234, last: 1245 });
  assert.equal(normalizePages("81-5", { allowAbbrev: false }), null);
});

test("normalizePages: не сторінки — відкидаємо", () => {
  assert.equal(normalizePages("e12345"), null);
  assert.equal(normalizePages("S12-S19"), null);
  assert.equal(normalizePages("04-05"), null, "нулі попереду — це ID, не сторінки");
  assert.equal(normalizePages("19-12"), null);
  assert.equal(normalizePages("1-250"), null, "діапазон усього номера, а не статті");
  assert.equal(normalizePages("2021"), null, "одна «сторінка»-рік");
  assert.equal(normalizePages(""), null);
  assert.equal(normalizePages("12, 15"), null);
});

test("formatPages", () => {
  assert.equal(formatPages({ first: 12, last: 19 }), "12–19");
  assert.equal(formatPages({ first: 7, last: 7 }), "7");
  assert.equal(formatPages(null), "");
});

test("normalizeTotalPages", () => {
  assert.equal(normalizeTotalPages(240), 240);
  assert.equal(normalizeTotalPages("240 с."), 240);
  assert.equal(normalizeTotalPages(2), null);
  assert.equal(normalizeTotalPages(""), null);
});

test("extractPagesFromDoi: реальні DOI українських журналів", () => {
  assert.deepEqual(extractPagesFromDoi("10.52058/2786-5274-2024-6(34)-383-392"), { first: 383, last: 392 });
  assert.deepEqual(extractPagesFromDoi("10.52058/2786-5274-2023-14(28)-1301-1311"), { first: 1301, last: 1311 });
  assert.equal(extractPagesFromDoi("10.54929/2786-5738-2025-20-04-05"), null, "ID статті reicst, не сторінки");
  assert.equal(extractPagesFromDoi("10.54929/2786-5738-2022-4-09-01"), null);
  assert.equal(extractPagesFromDoi("10.32689/2523-4536/81-5"), null, "номер випуску й статті");
  assert.equal(extractPagesFromDoi("10.1234/abc.2021-10-15"), null, "дата в кінці DOI");
  assert.equal(extractPagesFromDoi("10.32782/2524-0072/2024-60-71"), null, "рік-випуск-стаття (справжні сторінки 340–343)");
  assert.equal(extractPagesFromDoi("10.36887/2415-8453-2021-12-16"), null, "рік-випуск-стаття");
  assert.equal(extractPagesFromDoi(""), null);
});

test("parseRefPages: баги старого розбору більше не відтворюються", () => {
  const en = "Smith J. Remote work and wellbeing. *Journal of Management*. 2021. Vol. 12. No. 3. P. 191–199.";
  assert.deepEqual({ ...parseRefPages(en), index: undefined, length: undefined }, { first: 191, last: 199, index: undefined, length: undefined });
  assert.equal(parseRefPages("Smith J. Transformational leadership. 2021."), null);
  assert.equal(parseRefPages("Іванов І. Освітній процес. 2021."), null);
});

test("parseRefPages: українські формати ДСТУ", () => {
  const r = parseRefPages("Іванов І. Цифрова трансформація. *Економіка*. 2022. № 4. С. 12–19.");
  assert.equal(r.first, 12); assert.equal(r.last, 19);
  const line = "Іванов І. Назва. Вісник. 2022. № 4. С. 12–19. URL: https://x.ua/1";
  const p = parseRefPages(line);
  assert.equal(line.slice(p.index, p.index + p.length), "12–19");
  assert.deepEqual(parseRefPages("Петренко П. Менеджмент. Київ : Логос, 2020. 240 с."), { total: 240 });
  assert.deepEqual(parseRefPages("Kowalski J. Title. Warszawa, 2019. 312 p."), { total: 312 });
  assert.equal(parseRefPages("Іванов І. Назва. Вісник. 2022. № 4. – С. 7.").first, 7);
  assert.equal(parseRefPages("Іванов І. Назва. Вісник. 2022. Вип. 5, с.33-41.").last, 41);
});

test("parseRefPages: APA без позначки сторінок", () => {
  const r = parseRefPages("Smith, J. (2021). Title. Journal of X, 12(3), 191–199. https://doi.org/10.1/x");
  assert.equal(r.first, 191); assert.equal(r.last, 199);
});

test("parseRefPages: ініціал автора з роком не стає сторінкою", () => {
  assert.equal(parseRefPages("Kowalski, P. 2019. Title of the work."), null);
});

test("narrowBookRange", () => {
  assert.deepEqual(narrowBookRange(240), { min: 4, max: 237 });
  assert.deepEqual(narrowBookRange(5), { min: 2, max: 4 });
});

console.log(`\n${passed} тестів пройшло`);
