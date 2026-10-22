// Обробляє одне замовлення через усі стадії генерації, наскільки дозволяє
// поточний стан (stage/status) — та сама логіка, що раніше жила в
// worker/runOrder.js як one-shot скрипт. Винесено в перевикористовувану
// функцію, щоб її міг викликати як ручний CLI (runOrder.js), так і
// довгоживучий поллер (майбутній pipeline.js).
//
// Межі цієї фази (навмисно не автоматизовано):
//   - "ширший період"/"оновити джерела" для окремого підрозділу — ручні кнопки
//     дороблення в браузері, не частина автоматичного потоку.
import { loadOrder, saveOrderPatch, appendCostEntry } from "./firestoreAdmin.js";
import {
  runAnalyzeStage, runPlanStage, runSourcesStage, runWritingSection, runRemapStage,
  runAppendicesStage, runFillAppendixDataStage, runEconProfileStage, sectionNeedsAppendix, planAppendixGeneration,
  runClientSourcesDistributionStage,
} from "../src/lib/orderStages.js";
import { getEmpiricalSections, isEcon } from "../src/lib/planUtils.js";
import { APPENDIX_FILL_MARKER } from "../src/lib/textCleanup.js";
import { callClaude, callGemini, createCostTracker, resetGenerationCost } from "../src/lib/api.js";
import { createTokenAccumulator } from "./tokenAccumulator.js";
import { runWebImagesStep } from "./webImagesStep.js";

/**
 * @param {string} orderId
 * @param {object} [opts]
 * @param {(msg: string) => void} [opts.log] - куди виводити прогрес (за замовчуванням console.log)
 * @param {() => Promise<boolean>} [opts.shouldPause] - викликається між кроками;
 *   якщо повертає true, обробка зупиняється на найближчому чекпойнті
 *   (за замовчуванням завжди false — ручний запуск через runOrder.js паузу
 *   конвеєра не враховує, лише сам поллер pipeline.js)
 * @returns {Promise<{done: boolean, waiting?: string, stage: string, status: string}>}
 *   waiting !== undefined означає, що конвеєр зупинився й чекає на зовнішню
 *   дію (затвердження плану, ручне дороблення джерел, паузу) — це НЕ помилка.
 */
export async function processOrder(orderId, { log = console.log, shouldPause = async () => false, costLimit } = {}) {
  let order = await loadOrder(orderId);
  log(`Замовлення ${orderId}: stage="${order.stage}", status="${order.status}"`);
  resetGenerationCost();
  const tokenAcc = createTokenAccumulator(order);
  // Ліміт на ВСЕ замовлення (сума всіх запусків), не на один прохід
  // processOrder(): лічильник стартує не з нуля, а з уже витраченого
  // (order.totalCostUsd) — щоб відновлений після рестарту воркер одразу
  // побачив, що ліміт вичерпано, і не зробив жодного зайвого виклику.
  // costLimit (опц.) — перевизначає ORDER_COST_LIMIT для цього виклику; CRM-
  // пайплайн передає сюди job.limits.cost_usd (фактичний ліміт для job).
  const ORDER_COST_LIMIT = costLimit ?? (Number(process.env.ORDER_COST_LIMIT) || 6);
  const costTracker = createCostTracker(ORDER_COST_LIMIT);
  const alreadySpent = order.totalCostUsd || 0;
  if (alreadySpent > 0) costTracker.reserve(alreadySpent).settle(alreadySpent);
  const wrappedCallClaude = (messages, signal, systemPrompt, maxTokens, onWait, model, opts) =>
    callClaude(messages, signal, systemPrompt, maxTokens, onWait, model, { ...opts, costTracker });
  const wrappedCallGemini = (messages, signal, systemPrompt, maxTokens, onWait, model, jsonMode, opts) =>
    callGemini(messages, signal, systemPrompt, maxTokens, onWait, model, jsonMode, { ...opts, costTracker });
  const onProgress = (msg) => log(`  ${msg}`);
  // costFor(stage) — той самий tokenAcc.onCost (сумарний облік), плюс окремий
  // рядок у orders/{id}/costs із позначкою стадії; запис не блокує генерацію
  // (fire-and-forget з логуванням помилки).
  const costFor = (stage) => (detail) => {
    tokenAcc.onCost(detail);
    appendCostEntry(orderId, { ...detail, stage }).catch(e => log(`⚠ Не вдалось записати costs (${stage}): ${e.message}`));
  };

  // save() — обгортка над saveOrderPatch, що завжди домішує актуальний
  // знімок вартості/токенів, як і кожен saveToFirestore у браузері.
  const save = async (patch) => {
    order = { ...order, ...patch };
    await saveOrderPatch(orderId, { ...patch, ...tokenAcc.snapshot() });
  };

  // Фото з інтернету для рисунків-заглушок — той самий крок, що в браузері після
  // "Готово" (webImg.searchAll у doRemapCitations, academic-assistant.jsx). Один раз на замовлення
  // (webImagesDone): і .docx для CRM, і повторне завантаження з UI беруть уже
  // збережені картинки (worker/webImagesStep.js).
  async function ensureWebImages() {
    if (order.webImagesDone) return;
    await runWebImagesStep({
      orderId, content: order.content, sections: order.sections, lang: order.info?.language, topic: order.info?.topic,
      skipSectionIds: order.readyWorkImportedIds, callClaude: wrappedCallClaude, onCost: costFor("web_images"), log,
    });
    await save({ webImagesDone: true });
  }

  // generationStartedAt — той самий момент, що й клік "Аналізувати" у браузері
  // (doAnalyze): найперший дотик до замовлення. Гардовано, щоб не збивати
  // час на кожному повторному запуску (відновлення після збою, повторний
  // прохід поллера тощо).
  if (!order.generationStartedAt) {
    await save({ generationStartedAt: new Date().toISOString() });
  }

  // Ловимо лише перевищення ORDER_COST_LIMIT (err.isCostLimit з createCostTracker)
  // — тут, а не в pipeline.js/runOrder.js, бо тільки тут є order/save() для
  // запису status:"error"+причини. Інші помилки пропускаємо як є.
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
    if ((order.stage === "input" || order.stage === "parsed" || !order.stage) && await shouldPause()) {
      log("⏸ Конвеєр на паузі перед аналізом. Зупиняюсь.");
      return { done: false, waiting: "paused", stage: order.stage, status: order.status };
    }

    if (order.stage === "input" || order.stage === "parsed" || !order.stage) {
      log("→ Аналіз вхідних даних...");
      const patch = await runAnalyzeStage(
        { ...order, analyzeProgress: order.analyzeProgress || {} },
        {
          callClaude: wrappedCallClaude, callGemini: wrappedCallGemini, onProgress, onCost: costFor("analyze"),
          save: async (p) => { order = { ...order, ...p }; await saveOrderPatch(orderId, { ...p, ...tokenAcc.snapshot() }); },
        }
      );
      await save({ ...patch, stage: "parsed", status: order.status || "new" });
    }

    if (order.stage === "parsed" && await shouldPause()) {
      log("⏸ Конвеєр на паузі перед генерацією плану. Зупиняюсь.");
      return { done: false, waiting: "paused", stage: order.stage, status: order.status };
    }

    if (order.stage === "parsed") {
      log("→ Генерація плану...");
      const patch = await runPlanStage(order, { callClaude: wrappedCallClaude, callGemini: wrappedCallGemini, onProgress, onCost: costFor("plan") });
      await save(patch);
      log(`  План: ${order.sections?.length || 0} пунктів`);
    }

    // Пауза на затвердженні плану (стадія 2 узгодженого флоу): щойно
    // згенерований план завжди має status:"plan_ready" (виставляє
    // runPlanStage) — це сигнал "чекає рішення клієнта через CRM", а не
    // "готово, продовжуй". Конвеєр зупиняється тут і НЕ чіпає джерела/писання,
    // поки хтось ззовні не виставить status:"plan_approved" на тому ж
    // документі (вручну, доки немає реального вебхука CRM). Правки плану
    // (окремий цикл із коментарем) — поки не автоматизовано, лишається
    // ручним доопрацюванням плану й повторним запуском.
    if (order.stage === "plan" && order.status !== "plan_approved") {
      log("⏸ План згенеровано, очікує затвердження (status: plan_ready). Зупиняюсь до сигналу ззовні.");
      return { done: false, waiting: "plan_approval", stage: order.stage, status: order.status };
    }

    if ((order.stage === "plan" && order.status === "plan_approved") || order.stage === "sources") {
      if (!order.clientSourcesDistributed) {
        if (await shouldPause()) {
          log("⏸ Конвеєр на паузі перед розподілом джерел клієнта. Зупиняюсь.");
          return { done: false, waiting: "paused", stage: order.stage, status: order.status };
        }
        log("→ Розподіл джерел клієнта по підрозділах...");
        const distPatch = await runClientSourcesDistributionStage(order, { callClaude: wrappedCallClaude, onCost: costFor("client_sources") });
        await save({ ...distPatch, clientSourcesDistributed: true });
        if (distPatch.clientSourcesLog?.length) {
          log(`  Джерел клієнта розподілено: ${distPatch.clientSourcesLog.filter(l => l.sectionId).length} з ${distPatch.clientSourcesLog.length}`);
        }
      }

      log("→ Підбір джерел...");
      // headingOnly — пункт-«шапка» без тексту (1.1 перед 1.1.1): джерела йому не шукаємо
      const mainSecs = (order.sections || []).filter(s => !["intro", "conclusions", "sources", "chapter_conclusion"].includes(s.type) && !s.headingOnly);
      // crossSectionSeen — спільний для всіх підрозділів цього запуску, щоб те
      // саме джерело не потрапило в citInputs двох різних підрозділів одразу
      // (той самий підхід, що doGenKeywords використовує в браузері).
      const crossSectionSeen = new Set();
      // готова частина клієнта йде як є — джерела для неї не шукаємо (як і doGenKeywords у браузері)
      const importedIds = new Set(order.readyWorkImportedIds || []);
      for (const sec of mainSecs) {
        if (importedIds.has(sec.id)) continue;
        if ((order.citInputs?.[sec.id] || "").trim()) continue; // вже є джерела — природний чекпойнт, як і авто-вставка в браузері
        if (await shouldPause()) {
          log("⏸ Конвеєр на паузі під час підбору джерел. Зупиняюсь на найближчому чекпойнті.");
          return { done: false, waiting: "paused", stage: order.stage, status: order.status };
        }
        log(`  [джерела] ${sec.label}`);
        const patch = await runSourcesStage(order, sec, { callGemini: wrappedCallGemini, onCost: costFor("sources"), crossSectionSeen });
        await save({ ...patch, workflowMode: "sources-first", stage: "sources", status: "writing" });
      }

      // Ціль підбору лишається рекомендованою кількістю (needed у кожній секції,
      // не змінюємо) — sourcesMinRequired лише нижня межа. Якщо навіть її не
      // досягнуто, замовлення лишається на stage:"sources" (не переходить у
      // "writing") — needsSources() у Dashboard.jsx покаже його менеджеру під
      // фільтром "Джерела" без додаткового UI. Ручне дороблення підхопить той
      // самий чекпойнт вище (citInputs[secId] вже не порожній → пропустити).
      const totalGathered = mainSecs.reduce((sum, sec) => {
        const text = (order.citInputs?.[sec.id] || "").trim();
        return sum + (text ? text.split("\n").filter(l => l.trim()).length : 0);
      }, 0);
      if (mainSecs.length && order.sourcesMinRequired && totalGathered < order.sourcesMinRequired) {
        log(`⚠ Джерел знайдено ${totalGathered} з мінімум ${order.sourcesMinRequired} — потрібне ручне дороблення. Замовлення лишається на стадії "sources".`);
        return { done: false, waiting: "manual_sources", stage: order.stage, status: order.status };
      } else {
        await save({ stage: "writing", status: "writing" });
      }
    }

    if (order.stage === "writing") {
      // Профіль підприємства для економічних/управлінських робіт — генеруємо ДО
      // Додатку А і до підрозділів аналізу, той самий крок і той самий порядок,
      // що startGen() у браузері (doGenEconProfile): і Додаток А, і текст мають
      // спиратись на ту саму назву підприємства й ті самі базові показники.
      if (!order.econProfile && (isEcon(order.info) || order.methodInfo?.requiresEnterpriseProfile)) {
        log("→ Генерую профіль підприємства...");
        const profPatch = await runEconProfileStage(order, { callClaude: wrappedCallClaude, onCost: costFor("econ_profile") });
        await save(profPatch);
      }

      // Додаток А: реальний інструмент (методика/тест/експеримент) чи додатки
      // з реальним обґрунтуванням генеруємо ДО тексту — вони не залежать від
      // того, що напише ШІ. Авторську анкету (немає фіксованого джерела істини)
      // відкладаємо до готового тексту — той самий підхід, що й startGen().
      if (!order.appendicesText) {
        const { needsAppendix, deferred } = planAppendixGeneration(order);
        if (needsAppendix && !deferred) {
          log("→ Генерую Додаток А (до написання тексту)...");
          const patch = await runAppendicesStage(order, { callClaude: wrappedCallClaude, onCost: costFor("appendix") });
          await save(patch);
        }
      }

      const sections = order.sections || [];
      let genIdx = order.genIdx || 0;
      log(`→ Написання: ${genIdx}/${sections.length} підрозділів уже готово`);
      const deferredSecIds = [];
      while (genIdx < sections.length) {
        const sec = sections[genIdx];
        if (order.content?.[sec.id] !== undefined) { genIdx++; continue; }
        if (await shouldPause()) {
          log("⏸ Конвеєр на паузі під час написання. Зупиняюсь на найближчому чекпойнті.");
          return { done: false, waiting: "paused", stage: order.stage, status: order.status };
        }
        if (sec.type === "sources") {
          genIdx++;
          await save({ content: { ...order.content, [sec.id]: "[Додайте джерела на кроці «Джерела»]" }, genIdx });
          continue;
        }
        // headingOnly довіряємо лише якщо в плані справді є вкладений пункт (id, що починається
        // з "${sec.id}.") — інакше це осиротіла "шапка" без дітей, і пункт пишеться як звичайний.
        if (sec.headingOnly && sections.some(s => s.id !== sec.id && s.id.startsWith(sec.id + "."))) {
          // пункт-«шапка» (1.1 перед 1.1.1) — лише заголовок, власного тексту не пишемо
          genIdx++;
          await save({ content: { ...order.content, [sec.id]: "" }, genIdx });
          continue;
        }
        if (!order.appendicesText && sectionNeedsAppendix(sec, order)) {
          // Додаток А ще не готовий (відкладена генерація) — цей підрозділ
          // пропускаємо, повернемось до нього після написання решти й генерації додатку.
          deferredSecIds.push(sec.id);
          genIdx++;
          continue;
        }
        log(`  [${genIdx + 1}/${sections.length}] ${sec.label}`);
        const patch = await runWritingSection(order, sec, { callClaude: wrappedCallClaude, onProgress, onCost: costFor("writing") });
        genIdx++;
        await save({ content: patch.content, citInputs: patch.citInputs, abstractsMap: patch.abstractsMap, sourceThesisMap: patch.sourceThesisMap, glossary: patch.glossary, stage: "writing", status: "writing", genIdx });
        await new Promise(r => setTimeout(r, 2000)); // пауза проти rate limit, як і в браузері
      }

      // Відкладена генерація Додатку А — тепер, коли решта тексту готова,
      // додаток узгоджується з реально написаною вибіркою (той самий підхід,
      // що deferred-ефект у браузері) — і дописуємо підрозділи, які на нього чекали.
      if (deferredSecIds.length && !order.appendicesText) {
        log("→ Генерую Додаток А (відкладено, узгоджено з готовим текстом)...");
        const empSecsForApp = getEmpiricalSections(order.sections, order.info, order.commentAnalysis, order.methodInfo);
        const empIds = new Set([...(empSecsForApp.chapterSectionIds || []), empSecsForApp.anchorId].filter(Boolean));
        const empText = order.sections.filter(s => empIds.has(s.id)).map(s => order.content[s.id]).filter(Boolean).join("\n\n");
        const finishedBodyText = empText || order.sections.filter(s => s.type !== "sources").map(s => order.content[s.id]).filter(Boolean).join("\n\n");
        const appPatch = await runAppendicesStage(order, { callClaude: wrappedCallClaude, onCost: costFor("appendix") }, { finishedBodyTextOverride: finishedBodyText });
        await save(appPatch);

        for (const secId of deferredSecIds) {
          const sec = order.sections.find(s => s.id === secId);
          if (!sec || order.content?.[sec.id] !== undefined) continue;
          log(`  [відкладений] ${sec.label}`);
          const patch = await runWritingSection(order, sec, { callClaude: wrappedCallClaude, onProgress, onCost: costFor("writing") });
          await save({ content: patch.content, citInputs: patch.citInputs, abstractsMap: patch.abstractsMap, sourceThesisMap: patch.sourceThesisMap, glossary: patch.glossary });
          await new Promise(r => setTimeout(r, 2000));
        }
      }

      // Автозаповнення полів Додатку А, позначених маркером (напр. "Фактичний
      // результат"/"Статус" для ІТ-протоколу тестування) — тепер, коли основний
      // текст точно готовий, так само як в браузері.
      if (order.appendicesText?.includes(APPENDIX_FILL_MARKER)) {
        log("→ Автозаповнення полів Додатку А...");
        const fillPatch = await runFillAppendixDataStage(order, { callClaude: wrappedCallClaude, onCost: costFor("appendix_fill") });
        if (fillPatch.appendicesText) await save(fillPatch);
      }

      log("→ Усі підрозділи готові. Перерозподіл цитат, список джерел, фінальне оформлення...");
      const remapPatch = await runRemapStage(order, { callClaude: wrappedCallClaude, onCost: costFor("remap") });
      const completedAt = new Date().toISOString();
      const generationDurationSec = order.generationStartedAt
        ? Math.round((Date.now() - new Date(order.generationStartedAt).getTime()) / 1000)
        : undefined;
      await save({ ...remapPatch, ...(remapPatch.stage === "done" ? { completedAt, generationDurationSec } : {}) });
      if (order.stage === "done") await ensureWebImages();
      log(`\n✓ Замовлення ${orderId} готове (stage="${order.stage}"). Вартість цієї генерації (лише цей запуск): $${costTracker.value.toFixed(2)}`);
      log(`  Сумарна вартість замовлення (усі запуски): $${tokenAcc.snapshot().totalCostUsd.toFixed(2)}${generationDurationSec !== undefined ? `, час: ${generationDurationSec}с` : ""}`);
      return { done: order.stage === "done", stage: order.stage, status: order.status };
    }

    if (order.stage === "done") {
      // відновлення після збою між фінальним оформленням і пошуком фото (attempt 2 від CRM)
      if (!order.webImagesDone) await ensureWebImages();
      else log("Замовлення вже готове (stage=\"done\") — нічого робити не треба.");
      return { done: true, stage: order.stage, status: order.status };
    }

    log(`Невідома стадія "${order.stage}" — нічого не зроблено.`);
    return { done: false, stage: order.stage, status: order.status };
  }
}
