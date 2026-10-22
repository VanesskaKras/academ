// Одноразовий діагностичний скрипт: повний скан колекції orders (і, для певності,
// інших колекцій верхнього рівня) на будь-яке входження підрядка (напр. номера
// замовлення) в будь-якому текстовому полі документа. Лише читання.
import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

initializeApp({
  credential: applicationDefault(),
  projectId: process.env.FIREBASE_PROJECT_ID,
});
const db = getFirestore();

const needle = process.argv[2] || "41460";

function deepFindMatches(obj, path = "", out = []) {
  if (obj == null) return out;
  if (typeof obj === "string") {
    if (obj.includes(needle)) out.push({ path, snippet: obj.slice(0, 120) });
    return out;
  }
  if (typeof obj === "number") {
    if (String(obj) === needle) out.push({ path, snippet: String(obj) });
    return out;
  }
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => deepFindMatches(v, `${path}[${i}]`, out));
    return out;
  }
  if (typeof obj === "object") {
    for (const [k, v] of Object.entries(obj)) deepFindMatches(v, path ? `${path}.${k}` : k, out);
    return out;
  }
  return out;
}

async function main() {
  console.log(`Шукаю підрядок "${needle}" у всіх документах колекції orders (глибокий пошук по всіх полях)...`);
  const snap = await db.collection("orders").get();
  console.log(`Всього документів у orders: ${snap.size}`);
  let found = 0;
  snap.forEach(doc => {
    const matches = deepFindMatches(doc.data());
    if (matches.length) {
      found++;
      console.log(`\n=== ${doc.id} ===`);
      matches.slice(0, 10).forEach(m => console.log(`  ${m.path}: ${m.snippet}`));
    }
  });
  console.log(`\nДокументів зі збігом: ${found}`);

  console.log(`\n--- Інші колекції верхнього рівня (назви) ---`);
  const cols = await db.listCollections();
  console.log(cols.map(c => c.id).join(", "));
}

main().catch(e => { console.error("✗", e.message); process.exit(1); });
