#!/usr/bin/env node
// Довгоживучий поллер: замінює ручний запуск `node worker/runOrder.js <id>`
// по одному замовленню за раз — постійно перевіряє Firestore на замовлення,
// позначені для автообробки (autoPipeline:true), і проводить кожне через
// processOrder(), поки не готове або не впреться в чекпойнт, що потребує
// зовнішньої дії (затвердження плану, ручне дороблення джерел, пауза).
//
// Паралелізм — WORKER_CONCURRENCY незалежних слотів (кожен зі своїм
// WORKER_ID), за замовчуванням 1; claimNextOrder транзакційний, тож слоти не
// заберуть те саме замовлення двічі. Поки замовлення в обробці, лок
// освіжається (pipelineLockedAt) кожні 60с — щоб довге замовлення не
// виглядало протухлим для інших інстансів поллера.
//
// Керування:
//   node worker/pipelineControl.js pause    — пауза (див. коментар нижче)
//   node worker/pipelineControl.js resume   — продовжити
//   node worker/pipelineControl.js status   — перевірити стан
//
// Щоб замовлення взагалі потрапило в конвеєр (поки нема CRM-вебхука,
// тимчасова заміна кроку "менеджер додав автора Academ Assist"):
//   node worker/enqueueOrder.js <orderId>
//
// Запуск (на always-on сервері, під PM2/systemd для автозапуску й
// автовідновлення після падіння):
//   GOOGLE_APPLICATION_CREDENTIALS=... FIREBASE_PROJECT_ID=... \
//     WORKER_CONCURRENCY=1 node worker/pipeline.js [--api-base=https://...]
import os from "node:os";
import { setApiBase } from "../src/lib/api.js";
import { processOrder } from "./processOrder.js";
import { readPipelineControl, claimNextOrder, releaseLock, touchLock } from "./firestoreAdmin.js";

const apiBaseArg = process.argv.find(a => a.startsWith("--api-base="));
if (apiBaseArg) setApiBase(apiBaseArg.slice("--api-base=".length));
else if (process.env.API_BASE) setApiBase(process.env.API_BASE);

const POLL_INTERVAL_MS = Number(process.env.PIPELINE_POLL_INTERVAL_MS) || 30_000;
const HEARTBEAT_MS = 60_000;
const WORKER_CONCURRENCY = Math.max(1, Number(process.env.WORKER_CONCURRENCY) || 1);
const WORKER_ID_BASE = `${os.hostname()}:${process.pid}`;

// Пауза перевіряється не лише перед тим, як брати нове замовлення, а й
// всередині processOrder() між кроками (shouldPause) — щоб замовлення, яке
// вже в роботі, зупинилось на найближчому чекпойнті, а не тільки після
// повного завершення.
async function shouldPause() {
  const control = await readPipelineControl();
  return !!control.paused;
}

async function tick(workerId) {
  if (await shouldPause()) {
    console.log(`⏸ Конвеєр на паузі, нічого не беру (${workerId}).`);
    return;
  }
  const orderId = await claimNextOrder(workerId);
  if (!orderId) {
    console.log(`Немає замовлень, готових до обробки (${workerId}).`);
    return;
  }
  console.log(`\n=== [${workerId}] Беру в роботу замовлення ${orderId} ===`);
  const heartbeat = setInterval(() => {
    touchLock(orderId, workerId).catch(e => console.error(`✗ Не вдалось освіжити лок ${orderId}:`, e.message));
  }, HEARTBEAT_MS);
  try {
    const result = await processOrder(orderId, { log: console.log, shouldPause });
    if (result.waiting) console.log(`⏸ Замовлення ${orderId} очікує: ${result.waiting}`);
  } catch (e) {
    console.error(`✗ Помилка на замовленні ${orderId}:`, e.message);
    console.error(e.stack);
  } finally {
    clearInterval(heartbeat);
    await releaseLock(orderId);
  }
}

let stopping = false;
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    console.log(`\nОтримано ${sig}, завершую після поточного тіка...`);
    stopping = true;
  });
}

// Кожен слот — незалежний цикл tick()+пауза зі своїм WORKER_ID; claimNextOrder
// транзакційний, тож паралельні слоти не заберуть те саме замовлення двічі.
async function workerLoop(workerId) {
  while (!stopping) {
    await tick(workerId);
    if (stopping) break;
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
}

async function main() {
  console.log(`Поллер запущено (${WORKER_ID_BASE}), слотів: ${WORKER_CONCURRENCY}, інтервал: ${POLL_INTERVAL_MS / 1000}с`);
  const slots = Array.from({ length: WORKER_CONCURRENCY }, (_, i) => workerLoop(`${WORKER_ID_BASE}#${i}`));
  await Promise.all(slots);
  console.log("Поллер зупинено.");
}

main().catch(e => {
  console.error("✗ Критична помилка поллера:", e.message);
  console.error(e.stack);
  process.exit(1);
});
