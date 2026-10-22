#!/usr/bin/env node
// Позначає замовлення для автоматичної обробки конвеєром (worker/pipeline.js).
// Тимчасова заміна кроку "менеджер додав автора Academ Assist" з майбутнього
// CRM-флоу, поки реального вебхука немає — після підключення CRM цей крок
// робитиме вебхук, а не цей скрипт.
import { saveOrderPatch } from "./firestoreAdmin.js";

const orderId = process.argv[2];
if (!orderId) {
  console.error("Використання: node worker/enqueueOrder.js <orderId>");
  process.exit(1);
}

saveOrderPatch(orderId, { autoPipeline: true })
  .then(() => console.log(`✓ Замовлення ${orderId} позначено для автообробки конвеєром.`))
  .catch(e => {
    console.error("✗ Помилка:", e.message);
    process.exit(1);
  });
