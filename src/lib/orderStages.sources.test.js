// Тести runSourcesStage/autoSelectSources. Мережеві функції з lib/sourcesSearch.js
// (searchByPhrase, filterSourcesWithGemini, enrichSources) — реальні HTTP-виклики,
// їх тут не мокаємо; замість цього:
//  - runSourcesStage перевіряється на шляху "немає тез" (не доходить до мережі);
//  - autoSelectSources (чисте ядро авто-вставки — round-robin по тезах з
//    квотою на зарубіжні джерела, перенесене з SourcesStage.jsx) перевіряється
//    напряму, без мережі.
// Наскрізна перевірка з реальним пошуком — окремо, на живому тестовому замовленні.
// Запуск: node src/lib/orderStages.sources.test.js
import assert from "node:assert/strict";
import { runSourcesStage, autoSelectSources } from "./orderStages.js";

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
  sections: [{ id: "1.1", label: "1.1 Теорія", type: "theory" }],
  sourceDist: { "1.1": 4 },
  citInputs: {},
  citStructured: {},
  abstractsMap: {},
  sourceThesisMap: {},
  content: {},
  commentAnalysis: null,
  methodInfo: null,
};

await test("runSourcesStage: Gemini не дав жодної тези → не доходить до мережевого пошуку, citInputs незмінний", async () => {
  const sec = baseOrder.sections[0];
  const ctx = { callGemini: async () => JSON.stringify({ theses: [], enPhrases: [] }) };
  const patch = await runSourcesStage(baseOrder, sec, ctx);
  assert.deepEqual(patch.citInputs, {});
  assert.deepEqual(patch.citStructured, {});
});

// ── autoSelectSources: ядро авто-вставки ──
function paper(id, { score = 80, complete = true, lang = 'uk', thesis = '' } = {}) {
  return { id, title: `Title ${id}`, geminiScore: score, _complete: complete, lang, sourceThesis: thesis };
}

await test("autoSelectSources: відхиляє score<70 і неповні джерела", () => {
  const groups = [{ phrase: 'x', papers: [paper('a', { score: 50 }), paper('b', { complete: false }), paper('c', { score: 90 })] }];
  const top = autoSelectSources(groups, 4, false);
  assert.deepEqual(top.map(p => p.id), ['c']);
});

await test("autoSelectSources: інституційні джерела (без geminiScore) завжди проходять", () => {
  const groups = [{ phrase: 'x', papers: [{ id: 'inst', title: 'T', source: 'institutional', lang: 'uk' }] }];
  const top = autoSelectSources(groups, 4, false);
  assert.deepEqual(top.map(p => p.id), ['inst']);
});

await test("autoSelectSources: розподіл по колу — спершу по одному з кожної тези, а не топ-N з однієї", () => {
  const groups = [{
    phrase: 'x', papers: [
      paper('t1-a', { score: 95, thesis: 'теза1' }),
      paper('t1-b', { score: 94, thesis: 'теза1' }),
      paper('t1-c', { score: 93, thesis: 'теза1' }),
      paper('t2-a', { score: 80, thesis: 'теза2' }),
    ],
  }];
  const top = autoSelectSources(groups, 2, false);
  // Без round-robin топ-2 за оцінкою дали б t1-a, t1-b (обидва з теза1) —
  // round-robin має віддати перевагу покриттю обох тез.
  assert.deepEqual(new Set(top.map(p => p.id)), new Set(['t1-a', 't2-a']));
});

await test("autoSelectSources: квота на зарубіжні джерела (30% для нетехнічних робіт)", () => {
  const groups = [{
    phrase: 'x', papers: [
      paper('f1', { score: 95, lang: 'en', thesis: 't' }),
      paper('f2', { score: 94, lang: 'en', thesis: 't' }),
      paper('f3', { score: 93, lang: 'en', thesis: 't' }),
      paper('u1', { score: 80, lang: 'uk', thesis: 't' }),
    ],
  }];
  const top = autoSelectSources(groups, 4, false);
  const foreignCount = top.filter(p => p.lang !== 'uk').length;
  assert.ok(foreignCount <= Math.max(1, Math.round(4 * 0.3)), `забагато зарубіжних: ${foreignCount}`);
});

await test("autoSelectSources: технічна робота — вища квота на зарубіжні (50%)", () => {
  const groups = [{
    phrase: 'x', papers: [
      paper('f1', { score: 95, lang: 'en', thesis: 't' }),
      paper('f2', { score: 94, lang: 'en', thesis: 't' }),
      paper('u1', { score: 80, lang: 'uk', thesis: 't' }),
      paper('u2', { score: 79, lang: 'uk', thesis: 't' }),
    ],
  }];
  const top = autoSelectSources(groups, 4, true);
  const foreignCount = top.filter(p => p.lang !== 'uk').length;
  assert.ok(foreignCount >= 1, "технічна робота має допускати щонайменше 1 зарубіжне при квоті 50%");
});

await test("autoSelectSources: недостатньо джерел — вставляє скільки є, не намагається вигадати більше", () => {
  const groups = [{ phrase: 'x', papers: [paper('only-one', { score: 90, thesis: 't' })] }];
  const top = autoSelectSources(groups, 4, false);
  assert.equal(top.length, 1);
});

console.log(`\n${passed} тестів пройшло`);
if (process.exitCode) console.error("Є ПОМИЛКИ");
