// Одноразовий діагностичний скрипт: знайти замовлення "41460" в Firestore
// (і CRM-версію, і сайтову) і вивести кількість джерел по кожному підрозділу.
// Лише читання, нічого не пише.
import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

initializeApp({
  credential: applicationDefault(),
  projectId: process.env.FIREBASE_PROJECT_ID,
});
const db = getFirestore();

function summarize(doc) {
  const d = doc.data();
  console.log(`\n=== ${doc.id} ===`);
  console.log(`orderNumber: ${d.orderNumber ?? "(нема)"}  info.orderNumber: ${d.info?.orderNumber ?? "(нема)"}`);
  console.log(`crmRunId: ${d.crmRunId ?? "(нема, тобто сайтове)"}`);
  console.log(`topic: ${d.info?.topic ?? "(нема info.topic)"}`);
  console.log(`stage/status: ${d.stage} / ${d.status}`);
  const sections = (d.sections || []).filter(s => !["intro", "conclusions", "sources", "chapter_conclusion"].includes(s.type));
  const citInputs = d.citInputs || {};
  const sourceDist = d.sourceDist || {};
  let total = 0;
  for (const sec of sections) {
    const text = (citInputs[sec.id] || "").trim();
    const count = text ? text.split("\n").filter(l => l.trim()).length : 0;
    total += count;
    console.log(`  [${sec.id}] ${sec.label}: ${count} джерел (потрібно ${sourceDist[sec.id] ?? "?"})`);
  }
  console.log(`  ВСЬОГО: ${total}`);
}

async function main() {
  const seen = new Set();
  for (const [field, value] of [["orderNumber", 41460], ["orderNumber", "41460"], ["info.orderNumber", "41460"], ["info.orderNumber", 41460]]) {
    const snap = await db.collection("orders").where(field, "==", value).get();
    snap.forEach(doc => {
      if (seen.has(doc.id)) return;
      seen.add(doc.id);
      summarize(doc);
    });
  }
  if (!seen.size) console.log("Нічого не знайдено за жодним із варіантів поля.");
}

main().catch(e => { console.error("✗", e.message); process.exit(1); });
