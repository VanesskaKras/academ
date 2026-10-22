// Пошук замовлення 41406 по всій колекції orders — гнучкий пошук за
// ключовими словами теми (біологія/опора/рух/позаурочна), бо точний збіг
// не знайшов нічого. Лише читання.
import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

initializeApp({
  credential: applicationDefault(),
  projectId: process.env.FIREBASE_PROJECT_ID,
});
const db = getFirestore();

async function main() {
  const snap = await db.collection("orders").get();
  console.log(`Усього замовлень у колекції: ${snap.size}`);
  let found = 0;
  const candidates = [];
  snap.forEach(doc => {
    const d = doc.data();
    const topic = (d.info?.topic || "").toLowerCase();
    const tpl = (d.tplText || "").toLowerCase();
    const hitTopic = /біолог/.test(topic) && /(опор|рух)/.test(topic);
    const hitTpl = /41406/.test(tpl) || /біолог/.test(tpl) && /позаурочн/.test(tpl);
    if (hitTopic || hitTpl) {
      found++;
      console.log(`\n=== ${doc.id} ===`);
      console.log(`orderNumber: ${d.orderNumber} / info.orderNumber: ${d.info?.orderNumber} / crmRunId: ${d.crmRunId} / crmKind: ${d.crmKind}`);
      console.log(`topic: ${d.info?.topic}`);
      console.log(`info.type: ${d.info?.type}`);
      console.log(`stage/status: ${d.stage} / ${d.status}`);
    }
    // Заодно збираємо всі CRM-замовлення (crmRunId є) для контексту.
    if (d.crmRunId) candidates.push({ id: doc.id, orderNumber: d.orderNumber, crmRunId: d.crmRunId, topic: d.info?.topic });
  });
  if (!found) {
    console.log("Не знайдено ні за темою, ні за 41406 у tplText.");
    console.log(`\nВсього CRM-замовлень (є crmRunId) у колекції: ${candidates.length}`);
    candidates.slice(0, 30).forEach(c => console.log(`  ${c.id} | orderNumber=${c.orderNumber} | crmRunId=${c.crmRunId} | topic=${c.topic}`));
  }
}

main().catch(e => { console.error("✗", e.message); process.exit(1); });
