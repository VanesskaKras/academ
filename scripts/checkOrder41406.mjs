// Одноразовий діагностичний скрипт: замовлення "41406" (стаття, згенерована
// через CRM, без списку джерел) — дивимось crmKind, info.type, sections
// (їхні type — чи є "справжні" розділи поза intro/conclusions/sources/
// chapter_conclusion), citInputs, sourcesMinRequired. Лише читання.
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
  console.log(`crmRunId: ${d.crmRunId ?? "(нема, тобто сайтове)"}  crmKind: ${d.crmKind ?? "(нема)"}`);
  console.log(`info.type: ${d.info?.type ?? "(нема)"}  workType: ${d.workType ?? "(нема)"}`);
  console.log(`topic: ${d.info?.topic ?? "(нема info.topic)"}`);
  console.log(`stage/status: ${d.stage} / ${d.status}`);
  console.log(`sourcesMinRequired: ${d.sourcesMinRequired ?? "(нема)"}`);
  console.log(`sections (${(d.sections || []).length}):`);
  const excluded = ["intro", "conclusions", "sources", "chapter_conclusion"];
  const citInputs = d.citInputs || {};
  let mainSecsCount = 0;
  for (const sec of (d.sections || [])) {
    const isMain = !excluded.includes(sec.type);
    if (isMain) mainSecsCount++;
    const text = (citInputs[sec.id] || "").trim();
    const count = text ? text.split("\n").filter(l => l.trim()).length : 0;
    console.log(`  [${sec.id}] type="${sec.type}" ${isMain ? "(mainSec)" : "(excluded)"} label="${sec.label}" — ${count} джерел у citInputs`);
  }
  console.log(`  mainSecs (потребують джерел): ${mainSecsCount}`);
  console.log(`refList: ${d.refList ? `${(d.refList || []).length} шт.` : "(нема)"}`);
  console.log(`clientSourcesDistributed: ${d.clientSourcesDistributed ?? "(нема)"}`);
}

async function main() {
  const seen = new Set();
  for (const [field, value] of [["orderNumber", 41406], ["orderNumber", "41406"], ["info.orderNumber", "41406"], ["info.orderNumber", 41406]]) {
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
