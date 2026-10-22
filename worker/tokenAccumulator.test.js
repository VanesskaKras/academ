// Юніт-тести createTokenAccumulator — перевіряють саме той облік вартості,
// якого не вистачало воркеру (знайдено при реальному прогоні замовлення
// №41280: totalCostUsd/generationDurationSec не оновлювались після воркера).
// Запуск: node worker/tokenAccumulator.test.js
import assert from "node:assert/strict";
import { createTokenAccumulator } from "./tokenAccumulator.js";

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

test("стартує з нуля, коли в документі ще нічого немає", () => {
  const acc = createTokenAccumulator({});
  const s = acc.snapshot();
  assert.equal(s.totalCostUsd, 0);
  assert.equal(s.claudeInTok, 0);
  assert.equal(s.geminiCostUsd, 0);
  assert.equal(s.serperCredits, 0);
});

test("стартує з наявних у документі значень (частину міг зробити браузер) і додає зверху", () => {
  const acc = createTokenAccumulator({ totalCostUsd: 0.13, claudeInTok: 1000, claudeOutTok: 500, claudeCostUsd: 0.13 });
  acc.onCost({ cost: 0.05, model: "claude-sonnet-4-6", inTok: 200, outTok: 100 });
  const s = acc.snapshot();
  assert.equal(s.totalCostUsd, 0.13 + 0.05);
  assert.equal(s.claudeInTok, 1000 + 200);
  assert.equal(s.claudeOutTok, 500 + 100);
  assert.equal(s.claudeCostUsd, 0.13 + 0.05);
  assert.equal(s.totalInTok, 200, "totalInTok мав початково бути 0 (у фікстурі не заданий) + новий виклик");
});

test("розподіляє по провайдеру: claude / gemini / serper — кожен у свій кошик", () => {
  const acc = createTokenAccumulator({});
  acc.onCost({ cost: 0.01, model: "claude-sonnet-4-6", inTok: 100, outTok: 50 });
  acc.onCost({ cost: 0.02, model: "gemini-2.5-flash-lite", inTok: 200, outTok: 80 });
  acc.onCost({ cost: 0.001, model: "serper", inTok: 1, outTok: 0 });
  const s = acc.snapshot();
  assert.equal(s.claudeInTok, 100);
  assert.equal(s.claudeOutTok, 50);
  assert.equal(s.claudeCostUsd, 0.01);
  assert.equal(s.geminiInTok, 200);
  assert.equal(s.geminiOutTok, 80);
  assert.equal(s.geminiCostUsd, 0.02);
  assert.equal(s.serperCredits, 1);
  assert.equal(s.serperCostUsd, 0.001);
  // totalInTok/totalOutTok рахують і Claude, і Gemini, але НЕ Serper (кредити — не токени)
  assert.equal(s.totalInTok, 300);
  assert.equal(s.totalOutTok, 130);
  assert.equal(s.totalCostUsd, 0.01 + 0.02 + 0.001);
});

test("snapshot() повертає незалежний знімок — подальші onCost не змінюють раніше повернутий об'єкт", () => {
  const acc = createTokenAccumulator({});
  const s1 = acc.snapshot();
  acc.onCost({ cost: 1, model: "claude-sonnet-4-6", inTok: 10, outTok: 10 });
  assert.equal(s1.totalCostUsd, 0, "старий знімок не мав змінитись");
});

console.log(`\n${passed} тестів пройшло`);
if (process.exitCode) console.error("Є ПОМИЛКИ");
