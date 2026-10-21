// Тести суворого збігу "той самий твір" (sourceMatch.js) на реальних записах CrossRef.
// Запуск: node src/lib/sourceMatch.test.js
import assert from "node:assert/strict";
import { isSameWork, titlesMatch, titleCoveredByLine, authorsCompatible, crossrefCandidate } from "./sourceMatch.js";

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

// Реальні записи CrossRef (вересень 2026) — три статті з майже однаковими назвами
const FURMAN = { title: "ІМПЕРАТИВИ СТРАТЕГІЧНОГО УПРАВЛІННЯ ПЕРСОНАЛОМ ПІДПРИЄМСТВА", authors: ["Фурман"], year: 2023 };
const HUMENIUK = { title: "ФОРМУВАННЯ СТРАТЕГІЇ УПРАВЛІННЯ ПЕРСОНАЛОМ  ПІДПРИЄМСТВА", authors: ["Гуменюк"], year: 2024 };
const KHALAKHUR = { title: "ТІМБІЛДИНГ ЯК МЕТОД УПРАВЛІННЯ ПЕРСОНАЛОМ ПІДПРИЄМСТВА", authors: ["Халахур"], year: 2024 };
const SMALL_FIRMS = { title: "ОСОБЛИВОСТІ МОТИВАЦІЇ ПЕРСОНАЛУ МАЛИХ ПІДПРИЄМСТВ В СУЧАСНИХ УМОВАХ", authors: [], year: 2022 };

test("рядок «Петренко…» більше не чіпляє чужу статтю (кейс з перевірки)", () => {
  const line = "Петренко І. В. Особливості мотивації персоналу аграрних підприємств Полтавщини. Вісник аграрної науки. 2022. № 3.";
  assert.equal(isSameWork({ line }, SMALL_FIRMS), false);
});

test("схожі назви різних статей — не той самий твір", () => {
  const line = "Гуменюк А. Формування стратегії управління персоналом підприємства. Наукові інновації та передові технології. 2024. № 6(34). С. 383–392.";
  assert.equal(isSameWork({ line }, FURMAN), false);
  assert.equal(isSameWork({ line }, KHALAKHUR), false);
  assert.equal(isSameWork({ line }, HUMENIUK), true);
});

test("відома назва (результат пошуку) проти запису бази", () => {
  assert.equal(isSameWork({ title: "Тімбілдинг як метод управління персоналом підприємства", authors: ["Халахур Ю."], year: 2024 }, KHALAKHUR), true);
  assert.equal(isSameWork({ title: "Тімбілдинг як метод управління персоналом підприємства", authors: ["Халахур Ю."], year: 2024 }, HUMENIUK), false);
});

test("підзаголовок у базі не заважає, чужа довга назва — заважає", () => {
  assert.equal(titlesMatch("Цифрова трансформація бізнесу", "Цифрова трансформація бізнесу: виклики та можливості"), true);
  assert.equal(titlesMatch("Цифрова трансформація", "Цифрова трансформація малого бізнесу в аграрному секторі регіонів України"), false);
});

test("прізвище латиницею в базі проти кирилиці в нас", () => {
  assert.equal(authorsCompatible("Салига К. С. Управління фінансами підприємства", ["Salyha"]), true);
  assert.equal(authorsCompatible("Голуб О. Назва", ["Holub"]), true);
  assert.equal(authorsCompatible("Бойко Н. Назва", ["Boiko"]), true);
  assert.equal(authorsCompatible("Іванов І. Назва", ["Petrenko"]), false);
  assert.equal(authorsCompatible("Іванов І. Назва", []), null);
});

test("рік: різниця більше року — інший твір", () => {
  const line = "Коваль О. М. Соціально-психологічна адаптація студентів першокурсників закладів вищої освіти до навчання в умовах війни. 2021.";
  const cand = { title: "СОЦІАЛЬНО-ПСИХОЛОГІЧНА АДАПТАЦІЯ СТУДЕНТІВ ПЕРШОКУРСНИКІВ ЗАКЛАДІВ ВИЩОЇ ОСВІТИ ДО НАВЧАННЯ В УМОВАХ ВІЙНИ", authors: ["Коваль"], year: 2023 };
  assert.equal(isSameWork({ line }, cand), false);
  assert.equal(isSameWork({ line: line.replace("2021", "2023") }, cand), true);
});

test("коротку назву в сирому рядку не звіряємо (відмова, а не вгадування)", () => {
  assert.equal(titleCoveredByLine("Менеджмент", "Петренко П. Менеджмент. Київ, 2020."), false);
});

test("crossrefCandidate", () => {
  const c = crossrefCandidate({ title: ["T"], author: [{ family: "Фурман", given: "Д. Г." }], published: { "date-parts": [[2023, 5]] } });
  assert.deepEqual(c, { title: "T", authors: ["Фурман"], year: 2023 });
});

console.log(`\n${passed} тестів пройшло`);
