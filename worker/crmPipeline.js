#!/usr/bin/env node
// CRM-поллер за docs/crm-integration.md (v1.1): claim → створити/продовжити
// orders/{run_id} → processOrder() → docx → result/error. Окремий від
// pipeline.js (той керує чергою через власний Firestore-прапорець
// autoPipeline; тут чергу тримає CRM, воркер лише приходить за роботою —
// claimJob уже атомарний на боці CRM, окремий лок тут не потрібен).
//
// Паралелізм — WORKER_CONCURRENCY незалежних слотів, кожен зі своїм worker_id
// у claim (WORKER_ID з env + індекс слоту, якщо їх більше одного).
//
// Запуск:
//   CRM_BASE_URL=... ACADEM_WORKER_TOKEN=... WORKER_ID=vps2-1 \
//   GOOGLE_APPLICATION_CREDENTIALS=... FIREBASE_PROJECT_ID=... \
//   DIRECT_API=1 ANTHROPIC_API_KEY=... GEMINI_API_KEY_1=... \
//   API_BASE=https://academ-assist.vercel.app \
//     node worker/crmPipeline.js
//
// API_BASE обов'язковий НЕЗАЛЕЖНО від DIRECT_API: той перемикає лише
// /api/claude і /api/gemini, а пошук джерел (sourcesSearch.js: Scholar, CORE,
// DOAJ, Semantic Scholar, fetch-meta) завжди ходить через getApiBase() —
// без нього в Node ${API_BASE}/api/... стає відносним "/api/...", fetch()
// кидає TypeError (нема origin сторінки, як у браузері), і ці провайдери
// мовчки повертають [] (спіймано try/catch). На каскад це давало лише
// OpenAlex+CrossRef напряму — решта проваджень пошуку джерел пропадали
// без жодного логу.
import os from "node:os";
import { setApiBase } from "../src/lib/api.js";
import { loadOrder, getCostsForOrder, loadWebImages } from "./firestoreAdmin.js";
import { processOrder } from "./processOrder.js";
import { processSmallOrder } from "./processSmallOrder.js";
import { ensureOrderFromJob } from "./crmOrderMapping.js";
import { runPlanReview } from "./crmPlanReview.js";
import { claimJob, sendProgress, sendResult, sendError, CrmCancelledError } from "./crmClient.js";
import { exportToDocx, exportSimpleDocx } from "../src/lib/exportDocx.js";
import { parsePagesAvg } from "../src/lib/planUtils.js";

const apiBaseArg = process.argv.find(a => a.startsWith("--api-base="));
if (apiBaseArg) setApiBase(apiBaseArg.slice("--api-base=".length));
else if (process.env.API_BASE) setApiBase(process.env.API_BASE);

const POLL_INTERVAL_MS = Number(process.env.PIPELINE_POLL_INTERVAL_MS) || 30_000;
const HEARTBEAT_MS = 60_000;
const WORKER_CONCURRENCY = Math.max(1, Number(process.env.WORKER_CONCURRENCY) || 1);
const WORKER_ID_BASE = process.env.WORKER_ID || `${os.hostname()}:${process.pid}`;

// Наближене зіставлення нашого order.stage на довільний рядок стадії з
// контракту (analysis|plan|sources|writing|appendices|docx) + грубий pct.
function crmStageAndPct(order) {
  if (order.mode === "small") return crmStageAndPctSmall(order);
  const stage = order.stage;
  if (!stage || stage === "input" || stage === "parsed") return { stage: "analysis", pct: 10 };
  if (stage === "plan") return { stage: "plan", pct: 20 };
  if (stage === "sources") return { stage: "sources", pct: 30 };
  if (stage === "writing") {
    const total = order.sections?.length || 1;
    const done = order.genIdx || 0;
    return { stage: "writing", pct: Math.min(95, Math.round(40 + (done / total) * 55)) };
  }
  if (stage === "done") return { stage: "docx", pct: 100 };
  return { stage: "analysis", pct: 5 };
}

// Малі роботи (kind="small"): runSimple() виконує і пошук джерел, і
// написання за один виклик на стадії "sources" — тож немає окремої "writing"
// стадії з прогресом по підрозділах, як у великих робіт.
function crmStageAndPctSmall(order) {
  const stage = order.stage;
  if (!stage || stage === "input") return { stage: "analysis", pct: 10 };
  if (stage === "sources") return { stage: "writing", pct: 50 };
  if (stage === "done") return { stage: "docx", pct: 100 };
  return { stage: "analysis", pct: 5 };
}

async function buildResultMeta(orderId, order) {
  const costs = await getCostsForOrder(orderId);
  const stages = {};
  for (const c of costs) {
    const key = c.stage || "other";
    stages[key] = Math.round(((stages[key] || 0) + (c.cost || 0)) * 100) / 100;
  }
  const sources = order.mode === "small"
    ? (order.tezyCitations || []).length
    : (order.sections || []).reduce((sum, sec) => {
      const text = (order.citInputs?.[sec.id] || "").trim();
      return sum + (text ? text.split("\n").filter(l => l.trim()).length : 0);
    }, 0);
  return {
    cost_usd: Math.round((order.totalCostUsd || 0) * 100) / 100,
    duration_s: order.generationDurationSec,
    pages: parsePagesAvg(order.info?.pages), // оцінка із запитаного обсягу, не точний фактичний підрахунок
    sections: (order.sections || []).length,
    sources,
    stages,
  };
}

async function exportResultFiles(orderId, order) {
  if (order.mode === "small") {
    const docx = await exportSimpleDocx({
      title: order.info?.topic, sections: [{ label: "", text: order.result || "" }],
      info: order.info, citations: undefined, orderId, methodInfo: order.methodInfo, pageNumbers: false,
      webImages: await loadWebImages(orderId),
    });
    return [{ name: docx.filename, buffer: docx.buffer, contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }];
  }
  const docx = await exportToDocx({
    content: order.content, info: order.info, displayOrder: order.sections, appendicesText: order.appendicesText,
    titlePage: order.titlePage, titlePageLines: order.titlePageLines, methodInfo: order.methodInfo,
    commentAnalysis: order.commentAnalysis, orderId, annotationUk: order.annotationUk, annotationEn: order.annotationEn,
    illustrations: order.illustrations, readyWorkImages: order.readyWorkImages,
    webImages: await loadWebImages(orderId),
  });
  return [{ name: docx.filename, buffer: docx.buffer, contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }];
}

async function reportFailure(job, order, e, log) {
  const stage = e.crmStage || order?.stage || "analysis";
  const retryable = e.crmRetryable !== undefined ? e.crmRetryable : true;
  log(`✗ ${job.run_id}: ${e.message}`);
  try {
    await sendError(job.run_id, { stage, message: e.message, cost_usd: order?.totalCostUsd || 0, retryable });
  } catch (sendErr) {
    log(`✗ Не вдалось надіслати error у CRM для ${job.run_id}: ${sendErr.message}`);
  }
}

async function processJob(job, workerId, log) {
  log(`\n=== [${workerId}] Взято job ${job.run_id} (CRM #${job.order_num}, kind=${job.kind}, attempt=${job.attempt}) ===`);

  let orderId;
  try {
    orderId = await ensureOrderFromJob(job, log);
  } catch (e) {
    await reportFailure(job, null, e, log);
    return;
  }

  let cancelled = false;
  const heartbeat = setInterval(async () => {
    try {
      const order = await loadOrder(orderId);
      // §3.5: під час очікування затвердження плану heartbeat — це GET /plan
      // (runPlanReview), а не /progress — контракт прямо каже їх не змішувати.
      if (order.stage === "plan" && order.status !== "plan_approved") return;
      const { stage, pct } = crmStageAndPct(order);
      await sendProgress(job.run_id, { stage, pct, cost_usd: order.totalCostUsd || 0 });
    } catch (e) {
      if (e instanceof CrmCancelledError || e.crmCancelled) {
        cancelled = true;
        log(`⏹ CRM зняв job ${job.run_id} (409) — зупиняюсь.`);
      } else {
        log(`⚠ Не вдалось надіслати progress для ${job.run_id}: ${e.message}`);
      }
    }
  }, HEARTBEAT_MS);
  const shouldPause = async () => cancelled;

  try {
    while (true) {
      const orderBeforeRun = await loadOrder(orderId);
      const runStage = orderBeforeRun.mode === "small" ? processSmallOrder : processOrder;
      const result = await runStage(orderId, { log, shouldPause, costLimit: job.limits?.cost_usd });
      if (cancelled) {
        log(`⏹ Job ${job.run_id} скасовано CRM — нічого не надсилаю.`);
        return;
      }

      const order = await loadOrder(orderId);

      if (order.status === "error") {
        await reportFailure(job, order, new Error(order.errorReason || "Перевищено ліміт вартості"), log);
        return;
      }

      if (result.waiting === "plan_approval") {
        await runPlanReview(job, orderId, log);
        continue; // план затверджено — ще один прохід processOrder() продовжить з sources
      }

      if (result.waiting === "manual_sources") {
        const e = new Error("Джерел зібрано менше мінімуму — headless-режим не має способу дозбирати вручну.");
        e.crmStage = "sources";
        e.crmRetryable = false;
        await reportFailure(job, order, e, log);
        return;
      }

      if (result.waiting === "paused") {
        return; // завжди наш власний cancelled — уже оброблено вище
      }

      if (result.done) {
        log("→ Замовлення готове, збираю .docx для CRM...");
        const files = await exportResultFiles(orderId, order);
        const meta = await buildResultMeta(orderId, order);
        await sendResult(job.run_id, { meta, files });
        log(`✓ Результат надіслано в CRM (job ${job.run_id}).`);
        return;
      }

      const e = new Error(`Невідома стадія "${order.stage}" — генерація зупинилась без результату.`);
      e.crmRetryable = false;
      await reportFailure(job, order, e, log);
      return;
    }
  } catch (e) {
    if (e instanceof CrmCancelledError || e.crmCancelled) {
      log(`⏹ Job ${job.run_id} скасовано CRM під час обробки — зупиняюсь.`);
      return;
    }
    console.error(`✗ Помилка на job ${job.run_id}:`, e.message);
    console.error(e.stack);
    const order = await loadOrder(orderId).catch(() => null);
    await reportFailure(job, order, e, log);
  } finally {
    clearInterval(heartbeat);
  }
}

let stopping = false;
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    console.log(`\nОтримано ${sig}, завершую після поточного job...`);
    stopping = true;
  });
}

async function workerLoop(workerId) {
  while (!stopping) {
    let job = null;
    try {
      job = await claimJob(workerId);
    } catch (e) {
      console.error(`✗ [${workerId}] Помилка claim:`, e.message);
    }
    if (job) {
      await processJob(job, workerId, console.log);
    } else {
      console.log(`[${workerId}] Немає робіт у черзі CRM.`);
    }
    if (stopping) break;
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
}

async function main() {
  console.log(`CRM-поллер запущено (${WORKER_ID_BASE}), слотів: ${WORKER_CONCURRENCY}, інтервал: ${POLL_INTERVAL_MS / 1000}с`);
  const slots = Array.from(
    { length: WORKER_CONCURRENCY },
    (_, i) => workerLoop(WORKER_CONCURRENCY > 1 ? `${WORKER_ID_BASE}-${i}` : WORKER_ID_BASE)
  );
  await Promise.all(slots);
  console.log("CRM-поллер зупинено.");
}

main().catch(e => {
  console.error("✗ Критична помилка CRM-поллера:", e.message);
  console.error(e.stack);
  process.exit(1);
});
