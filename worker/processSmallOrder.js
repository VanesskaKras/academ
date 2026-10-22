// Обробляє одне замовлення kind="small" через усі стадії генерації, наскільки
// дозволяє поточний стан (stage/status) — та сама ідея, що й processOrder.js
// для великих робіт, але поверх smallStages.js (портована логіка
// src/small-works.jsx). Наразі підтримано лише workType="ese" — інші типи
// малих робіт (реферат/тези/стаття/презентація/доповідь) crmOrderMapping.js
// відхиляє ще на етапі ensureOrderFromJob, до виклику цієї функції.
//
// Для "ese" runSimple() сам виконує пошук джерел і написання за один виклик
// (order.stage="sources" — це і пошук, і генерація тексту, на відміну від
// великих робіт, де це окремі стадії) — тож цикл тут коротший:
//   input → (runSmallAnalyze) → sources → (runSimple) → done → (runSmallRemap) → done
import { loadOrder, saveOrderPatch, appendCostEntry } from "./firestoreAdmin.js";
import { runSmallAnalyze, runSimple, runSmallRemap } from "../src/lib/smallStages.js";
import { callClaude, callGemini, createCostTracker, resetGenerationCost } from "../src/lib/api.js";
import { createTokenAccumulator } from "./tokenAccumulator.js";
import { runWebImagesStep } from "./webImagesStep.js";
import { SIMPLE_WORK_SECTION_ID } from "../src/lib/webImages.js";

/**
 * @param {string} orderId
 * @param {object} [opts]
 * @param {(msg: string) => void} [opts.log]
 * @param {() => Promise<boolean>} [opts.shouldPause]
 * @returns {Promise<{done: boolean, waiting?: string, stage: string, status: string}>}
 */
export async function processSmallOrder(orderId, { log = console.log, shouldPause = async () => false, costLimit } = {}) {
  let order = await loadOrder(orderId);
  log(`Замовлення ${orderId} (small/${order.workType}): stage="${order.stage}", status="${order.status}"`);
  resetGenerationCost();
  const tokenAcc = createTokenAccumulator(order);
  const ORDER_COST_LIMIT = costLimit ?? (Number(process.env.ORDER_COST_LIMIT) || 6);
  const costTracker = createCostTracker(ORDER_COST_LIMIT);
  const alreadySpent = order.totalCostUsd || 0;
  if (alreadySpent > 0) costTracker.reserve(alreadySpent).settle(alreadySpent);
  const wrappedCallClaude = (messages, signal, systemPrompt, maxTokens, onWait, model, opts) =>
    callClaude(messages, signal, systemPrompt, maxTokens, onWait, model, { ...opts, costTracker });
  const wrappedCallGemini = (messages, signal, systemPrompt, maxTokens, onWait, model, jsonMode, opts) =>
    callGemini(messages, signal, systemPrompt, maxTokens, onWait, model, jsonMode, { ...opts, costTracker });
  const onProgress = (msg) => log(`  ${msg}`);
  const costFor = (stage) => (detail) => {
    tokenAcc.onCost(detail);
    appendCostEntry(orderId, { ...detail, stage }).catch(e => log(`⚠ Не вдалось записати costs (${stage}): ${e.message}`));
  };
  const save = async (patch) => {
    order = { ...order, ...patch };
    await saveOrderPatch(orderId, { ...patch, ...tokenAcc.snapshot() });
  };

  if (!order.generationStartedAt) {
    await save({ generationStartedAt: new Date().toISOString() });
  }

  try {
    return await runStages();
  } catch (e) {
    if (e.isCostLimit) {
      log(`⛔ ${e.message}`);
      await save({ status: "error", errorReason: e.message });
      return { done: false, waiting: undefined, stage: order.stage, status: "error" };
    }
    throw e;
  }

  async function runStages() {
    if (order.workType !== "ese") {
      const e = new Error(`workType="${order.workType}" (kind="small") ще не підтримується headless-воркером — реалізовано поки лише "ese".`);
      e.crmRetryable = false;
      e.crmStage = "input";
      throw e;
    }

    if ((!order.stage || order.stage === "input") && await shouldPause()) {
      log("⏸ Конвеєр на паузі перед аналізом. Зупиняюсь.");
      return { done: false, waiting: "paused", stage: order.stage, status: order.status };
    }

    if (!order.stage || order.stage === "input") {
      log("→ Аналіз вхідних даних...");
      const patch = await runSmallAnalyze(order, { callClaude: wrappedCallClaude, onProgress, onCost: costFor("analyze") });
      await save(patch);
    }

    if (order.stage === "sources" && await shouldPause()) {
      log("⏸ Конвеєр на паузі перед пошуком джерел і написанням. Зупиняюсь.");
      return { done: false, waiting: "paused", stage: order.stage, status: order.status };
    }

    if (order.stage === "sources") {
      log("→ Пошук джерел і написання...");
      const patch = await runSimple(order, { callClaude: wrappedCallClaude, callGemini: wrappedCallGemini, onProgress, onCost: costFor("writing") });
      await save(patch);
      if (order.status === "manual_sources_needed") {
        log(`⚠ Джерел зібрано менше мінімуму (${order.sourcesMinRequired}) — headless-режим не має способу дозбирати вручну.`);
        return { done: false, waiting: "manual_sources", stage: order.stage, status: order.status };
      }
    }

    if (order.stage === "done" && !order.sourcesFormatted && (order.tezyCitations || []).length) {
      if (await shouldPause()) {
        log("⏸ Конвеєр на паузі перед форматуванням джерел. Зупиняюсь.");
        return { done: false, waiting: "paused", stage: order.stage, status: order.status };
      }
      log("→ Форматую та розставляю джерела...");
      const patch = await runSmallRemap(order, { callClaude: wrappedCallClaude, onProgress, onCost: costFor("remap") });
      const completedAt = new Date().toISOString();
      const generationDurationSec = order.generationStartedAt
        ? Math.round((Date.now() - new Date(order.generationStartedAt).getTime()) / 1000)
        : undefined;
      await save({ ...patch, sourcesFormatted: true, completedAt, generationDurationSec });
    } else if (order.stage === "done" && !order.completedAt) {
      await save({ completedAt: new Date().toISOString() });
    }

    // Фото з інтернету для рисунків-заглушок — раз на замовлення, як у великих роботах
    if (order.stage === "done" && !order.webImagesDone) {
      await runWebImagesStep({
        orderId, content: { [SIMPLE_WORK_SECTION_ID]: order.result || "" }, sections: [{ id: SIMPLE_WORK_SECTION_ID }],
        lang: order.info?.language, topic: order.info?.topic, callClaude: wrappedCallClaude, onCost: costFor("web_images"), log,
      });
      await save({ webImagesDone: true });
    }

    if (order.stage === "done") {
      log(`\n✓ Замовлення ${orderId} (есе) готове. Вартість цієї генерації: $${costTracker.value.toFixed(2)}`);
      return { done: true, stage: order.stage, status: order.status };
    }

    log(`Невідома стадія "${order.stage}" — нічого не зроблено.`);
    return { done: false, stage: order.stage, status: order.status };
  }
}
