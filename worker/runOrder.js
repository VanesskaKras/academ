#!/usr/bin/env node
// CLI-скрипт: доводить одне замовлення через генерацію без відкритої вкладки
// браузера, використовуючи ту саму спільну логіку (processOrder.js →
// src/lib/orderStages.js), що й academic-assistant.jsx. Продовжує з того
// місця, де замовлення зараз зупинилось (за полем stage у Firestore) —
// можна перезапускати після збою. Якщо замовлення чекає на затвердження
// плану (waiting: "plan_approval"), скрипт зупиняється й нічого не ламає —
// перезапустіть після того, як хтось виставить status:"plan_approved".
//
// Використання:
//   GOOGLE_APPLICATION_CREDENTIALS=... FIREBASE_PROJECT_ID=... \
//     node worker/runOrder.js <orderId> [--api-base=https://...]
import { setApiBase } from "../src/lib/api.js";
import { processOrder } from "./processOrder.js";

const orderId = process.argv[2];
const apiBaseArg = process.argv.find(a => a.startsWith("--api-base="));
if (!orderId || orderId.startsWith("--")) {
  console.error("Використання: node worker/runOrder.js <orderId> [--api-base=https://...]");
  process.exit(1);
}
if (apiBaseArg) setApiBase(apiBaseArg.slice("--api-base=".length));
else if (process.env.API_BASE) setApiBase(process.env.API_BASE);

processOrder(orderId).catch(e => {
  console.error("\n✗ Помилка:", e.message);
  console.error(e.stack);
  process.exit(1);
});
