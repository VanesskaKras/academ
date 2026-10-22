// Замір "сторінки в джерелах і посиланнях" на реальних замовленнях — лише читання.
// Скільки джерел у списку літератури мають сторінки (з розбивкою за базою, звідки
// джерело), скільки посилань у тексті мають сторінку, і скільки підозрілих значень
// (сторінка = рік, "С. N" у книг, одна сторінка замість діапазону в англомовних).
// Запускати до і після змін, щоб бачити різницю.
//
// Запуск: node scripts/measurePages.mjs [кількість_замовлень=30]
// Потрібно: GOOGLE_APPLICATION_CREDENTIALS і FIREBASE_PROJECT_ID (як для воркера).
import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { parseRefPages } from "../src/lib/pageUtils.js";
import { replaceCitationBrackets } from "../src/lib/citationFormatting.js";

initializeApp({ credential: applicationDefault(), projectId: process.env.FIREBASE_PROJECT_ID });
const db = getFirestore();
const LIMIT = Number(process.argv[2] || 30);
const CURRENT_YEAR = new Date().getFullYear();

const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : "—");

async function main() {
  const snap = await db.collection("orders").where("stage", "==", "done").get();
  const orders = snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(o => Array.isArray(o.refList) && o.refList.length)
    .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))
    .slice(0, LIMIT);

  const bySource = {}; // база → { total, withPages }
  let refs = 0, refsWithPages = 0, refsBooksTotal = 0, suspiciousYear = 0, suspiciousBook = 0;
  let cites = 0, citesWithPage = 0, groupCites = 0;

  for (const o of orders) {
    const structured = Object.values(o.citStructured || {}).flat();
    const byTitle = new Map(structured.filter(p => p?.title).map(p => [p.title.toLowerCase().slice(0, 60), p]));
    const findStructured = line => {
      const lower = line.toLowerCase();
      for (const [k, p] of byTitle) if (lower.includes(k)) return p;
      return null;
    };

    for (const raw of o.refList) {
      const line = String(raw).replace(/^\s*\d+[.)]\s*/, "");
      if (!line || /^(І|ІІ)\.\s/.test(line)) continue;
      refs++;
      const pages = parseRefPages(line);
      const sp = findStructured(line);
      const src = sp?.source || (sp ? "інше" : "вручну/клієнт");
      bySource[src] ||= { total: 0, withPages: 0 };
      bySource[src].total++;
      if (pages) { refsWithPages++; bySource[src].withPages++; }
      if (pages?.total) refsBooksTotal++;
      // старі хиби: "С. 2021" (рік замість сторінки), книга з однією "С. N"
      const yearAsPage = line.match(/(?:^|[.,;]\s)(?:С|P|p)\.\s*((?:19|20)\d{2})(?=[.,;\s]|$)/);
      if (yearAsPage && Number(yearAsPage[1]) <= CURRENT_YEAR + 1) suspiciousYear++;
      if (sp?.type === "book" && pages?.first != null && pages.first === pages.last) suspiciousBook++;
    }

    for (const text of Object.entries(o.content || {}).filter(([id]) => id !== "sources").map(([, t]) => String(t || ""))) {
      replaceCitationBrackets(text, items => {
        cites++;
        if (items.length > 1) groupCites++;
        if (items.some(it => it.page != null)) citesWithPage++;
        return null;
      });
    }
  }

  console.log(`Замовлень: ${orders.length} (останні завершені зі списком літератури)`);
  console.log(`\nСписок літератури: ${refs} джерел, зі сторінками ${refsWithPages} (${pct(refsWithPages, refs)}), з них обсяг книги "N с." — ${refsBooksTotal}`);
  console.log(`Підозрілі: сторінка = рік — ${suspiciousYear}; книга з "С. N" замість "N с." — ${suspiciousBook}`);
  console.log(`\nЗа базою, звідки джерело (сторінки / всього):`);
  for (const [src, s] of Object.entries(bySource).sort((a, b) => b[1].total - a[1].total)) {
    console.log(`  ${src.padEnd(16)} ${String(s.withPages).padStart(4)} / ${String(s.total).padEnd(4)} ${pct(s.withPages, s.total)}`);
  }
  console.log(`\nПосилання в тексті: ${cites}, зі сторінкою ${citesWithPage} (${pct(citesWithPage, cites)}), групових ${groupCites}`);
}

main().catch(e => { console.error("✗", e.message); process.exit(1); });
