// Наскрізний тест сторінок на фінальному кроці великої роботи (runRemapStage) з
// імітацією ШІ: форматування списку (ЛЛМ губить сторінки одного джерела) і довставка
// "осиротілого" джерела. Перевіряє, що в списку й у посиланнях сторінки правильні.
// Запуск: node src/lib/orderStages.remapPages.test.js
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

const IVANOV = "Іванов І. Цифрова трансформація підприємств. *Економіка*. 2022. № 4. С. 12–19.";
const SMITH = "Smith J. Remote work and wellbeing. *Journal of Management*. 2021. Vol. 12. No. 3. P. 191–199.";
const PETRENKO = "Петренко П. Менеджмент організацій. Київ : Логос, 2020. 240 с.";

const filler = n => Array(n).fill("слово").join(" ");
// ~230 слів: перше речення без посилань (сюди довставляється осиротіле джерело),
// далі — речення з груповим посиланням моделі зі сторінками
const sectionText = [
  `Цифрові інструменти змінюють управління персоналом ${filler(20)}.`,
  `Віддалена робота впливає на добробут працівників ${filler(20)} [1, с. 14; 2, с. 195].`,
  `${filler(160)}.`,
].join(" ");

function baseOrder(overrides = {}) {
  return {
    sections: [
      { id: "1.1", label: "1.1 Перший підрозділ", type: "theory", pages: 1 },
      { id: "intro", label: "Вступ", type: "intro", pages: 1 },
      { id: "conclusions", label: "Висновки", type: "conclusions", pages: 1 },
      { id: "sources", label: "Список використаних джерел", type: "sources", pages: 1 },
    ],
    content: { "1.1": sectionText, intro: `${filler(229)}.`, conclusions: `${filler(229)}.`, sources: "" },
    citInputs: { "1.1": [IVANOV, SMITH, PETRENKO].join("\n") },
    citStructured: {},
    methodInfo: null,
    commentAnalysis: null,
    citStyleOverride: null,
    sourcesOrderOverride: null,
    citFootnotes: false,
    info: { type: "Курсова робота", topic: "Тема", subject: "Менеджмент", course: "3", pages: "4", language: "Українська" },
    appendicesText: "",
    refList: [],
    ...overrides,
  };
}

// Імітація ШІ: форматування списку повертає рядки як є, але в рядку Іванова "губить"
// сторінки; довставка ставить позначку в кінець першого речення підрозділу.
const calls = [];
async function fakeClaude(messages) {
  const prompt = messages[0].content;
  if (prompt.includes("ДЖЕРЕЛА ДЛЯ ВСТАВКИ")) {
    calls.push("insert");
    const marker = prompt.match(/перенести ДОСЛІВНО як є\): (.+)/)[1].trim();
    const original = sectionText.split(". ")[0] + ".";
    return JSON.stringify([{ index: 0, match: true, original, replacement: original.replace(/\.$/, ` ${marker}.`) }]);
  }
  if (/СТИЛЬ:/.test(prompt)) {
    calls.push("format");
    const lines = prompt.split("\n").filter(l => /^\d+\.\s/.test(l));
    return lines.map(l => l.replace(" С. 12–19.", "")).join("\n");
  }
  throw new Error("неочікуваний виклик ШІ: " + prompt.slice(0, 80));
}

await test("список: сторінки на місці (загублені ЛЛМ повернуто), книга — «240 с.»", async () => {
  calls.length = 0;
  const patch = await runRemapStage(baseOrder(), { callClaude: fakeClaude });
  const list = patch.refList.join("\n");
  assert.match(list, /1\. Іванов І\. .*С\. 12–19\./, "ЛЛМ загубила — код повернув");
  assert.match(list, /2\. Петренко П\. .*240 с\./);
  assert.match(list, /3\. Smith J\. .*P\. 191–199\./);
  assert.ok(calls.includes("format"));
});

await test("текст: група моделі зі сторінками не губить джерело; осиротіле довставлено зі сторінкою", async () => {
  const patch = await runRemapStage(baseOrder(), { callClaude: fakeClaude });
  const text = patch.content["1.1"];
  // локальні 1=Іванов, 2=Smith → глобальні 1 і 3 (кирилиця, потім латиниця)
  assert.match(text, /\[1, с\. 14; 3, с\. 195\]/);
  // Петренко (глобальний 2) — не процитований моделлю → довставлено з першою сторінкою діапазону книги
  assert.match(text, /управління персоналом .*\[2, с\. 4\]\./);
});

await test("ДСТУ, порядок появи: перенумерація зберігає сторінки всередині групи", async () => {
  const patch = await runRemapStage(baseOrder({ sourcesOrderOverride: "appearance" }), { callClaude: fakeClaude });
  const text = patch.content["1.1"];
  // першим у тексті стоїть довставлений Петренко → №1; далі група Іванов/Smith → №2 і №3
  assert.match(text, /управління персоналом .*\[1, с\. 4\]\./);
  assert.match(text, /\[2, с\. 14; 3, с\. 195\]/);
  const list = patch.refList.join("\n");
  assert.match(list, /1\. Петренко/);
  assert.match(list, /2\. Іванов/);
});

await test("APA: сторінка в дужці автора, група через «;»", async () => {
  const patch = await runRemapStage(baseOrder({ citStyleOverride: "APA" }), { callClaude: fakeClaude });
  const text = patch.content["1.1"];
  assert.match(text, /\(Іванов, 2022, с\. 14; Smith, 2021, с\. 195\)/);
});

await test("методичка «[N]» без сторінок — сторінок у посиланнях немає", async () => {
  const patch = await runRemapStage(baseOrder({ methodInfo: { citationStyle: "[1]" } }), { callClaude: fakeClaude });
  const text = patch.content["1.1"];
  assert.match(text, /\[1; 3\]/);
  assert.doesNotMatch(text, /с\. \d/);
});

await test("готова частина клієнта: джерело без посилання лишається в списку, у готовий текст нічого не довставляється", async () => {
  calls.length = 0;
  const patch = await runRemapStage(baseOrder({ readyWorkImportedIds: ["1.1"] }), { callClaude: fakeClaude });
  assert.ok(!calls.includes("insert"), "у готовий текст не довставляємо посилань");
  const list = patch.refList.join("\n");
  assert.match(list, /Петренко/, "непроцитоване джерело готової частини — у спільному списку");
  assert.match(patch.content["1.1"], /\[1, с\. 14; 3, с\. 195\]/, "номери в готовому тексті — за спільним списком");
  assert.doesNotMatch(patch.content["1.1"], /управління персоналом [^.]*\[2/);
});

await test("готовий розділ 1 + новий розділ 2, порядок появи → наскрізна нумерація одного списку", async () => {
  const newText = `Новий розділ спирається на ${filler(20)} [1] і ще ${filler(20)} [2].`;
  const KOVAL = "Коваль К. Стратегічний аналіз. Харків : Фоліо, 2019. 180 с.";
  const order = baseOrder({
    sourcesOrderOverride: "appearance",
    readyWorkImportedIds: ["1.1"],
    sections: [
      { id: "intro", label: "Вступ", type: "intro", pages: 1 },
      { id: "1.1", label: "1.1 Готовий", type: "theory", pages: 1 },
      { id: "2.1", label: "2.1 Новий", type: "analysis", pages: 1 },
      { id: "conclusions", label: "Висновки", type: "conclusions", pages: 1 },
      { id: "sources", label: "Список використаних джерел", type: "sources", pages: 1 },
    ],
    content: { intro: `${filler(229)}.`, "1.1": sectionText, "2.1": newText, conclusions: `${filler(229)}.`, sources: "" },
    // у новому розділі [2] — те саме джерело, що вже є в готовому (Smith) — має злитись в один номер
    citInputs: { "1.1": [IVANOV, SMITH, PETRENKO].join("\n"), "2.1": [KOVAL, SMITH].join("\n") },
  });
  const patch = await runRemapStage(order, { callClaude: async (m) => {
    const p = m[0].content;
    if (/СТИЛЬ:/.test(p)) return p.split("\n").filter(l => /^\d+\.\s/.test(l)).join("\n");
    if (p.includes("ДЖЕРЕЛА ДЛЯ ВСТАВКИ")) throw new Error("довставка не очікувалась");
    return "{}";
  } });
  const list = patch.refList;
  assert.match(patch.content["1.1"], /\[1, с\. 14; 2, с\. 195\]/, "готовий текст іде першим → №1, №2");
  assert.match(patch.content["2.1"], /\[3(, с\. \d+)?\].*\[2(, с\. \d+)?\]/, "новий розділ продовжує нумерацію, спільне джерело — той самий номер");
  assert.match(list[0], /Іванов/); assert.match(list[1], /Smith/); assert.match(list[2], /Коваль/);
  assert.match(list.join("\n"), /Петренко/, "непроцитоване з готової частини — в кінці списку");
  assert.equal(list.length, 4);
});

console.log(`\n${passed} тестів пройшло`);
if (process.exitCode) console.error("Є ПОМИЛКИ");
