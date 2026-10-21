// ── Вибір сторінки в посиланні за змістом PDF джерела (перемикач "Сторінка за змістом") ──
// Для кожного посилання на джерело, в якого є PDF і відомий діапазон сторінок, беремо
// речення перед позначкою і питаємо /api/pdf-pages, на якій сторінці статті про це
// йдеться найбільше (збіг ключових слів, без ШІ). Результат — pagePicker для
// applyCitationRemap; де збіг слабкий чи PDF недоступний — null, і сторінка
// обирається як звичайно (з діапазону). Обмеження: модель пише текст з анотації
// джерела, тож "найближча за змістом сторінка" — наближення, а не гарантія цитати.
import { fetchPdfPages } from "./sourcesSearch.js";
import { replaceCitationBrackets } from "./citationFormatting.js";

// Речення перед позначкою (від попередньої межі речення), без інших позначок у ньому
export function sentenceBefore(text, offset) {
  const before = text.slice(Math.max(0, offset - 600), offset);
  const cut = Math.max(before.lastIndexOf(". "), before.lastIndexOf("! "), before.lastIndexOf("? "), before.lastIndexOf("\n"));
  return before.slice(cut + 1).replace(/\[[^\]]*\]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Збирає речення для кожного посилання й повертає { [key]: pagePicker(newN, occurrence) }.
 * texts — { key: текст } зі старою (локальною) нумерацією, як перед applyCitationRemap;
 * mappingFor(key) → oldToNew для цього тексту; pdfUrls/pageRanges — за НОВИМИ номерами.
 * occurrence рахується так само, як в applyCitationRemap: по кожному елементу позначки
 * (без повторів у межах однієї дужки), в порядку появи, окремо для кожного тексту.
 */
export async function buildContentPagePickers({ texts, mappingFor, pdfUrls, pageRanges, concurrency = 4 }) {
  const requests = new Map(); // newN → [{ key, occ, snippet }]
  for (const [key, text] of Object.entries(texts)) {
    if (!text) continue;
    const oldToNew = mappingFor(key) || {};
    const occ = {};
    replaceCitationBrackets(text, (items, whole, offset) => {
      const seen = new Set();
      for (const it of items) {
        const newN = oldToNew[it.n];
        if (!newN || seen.has(newN)) continue;
        seen.add(newN);
        occ[newN] = (occ[newN] || 0) + 1;
        if (!pdfUrls?.[newN] || !pageRanges?.[newN]) continue;
        const snippet = sentenceBefore(text, offset);
        if (snippet.length < 20) continue;
        if (!requests.has(newN)) requests.set(newN, []);
        requests.get(newN).push({ key, occ: occ[newN], snippet });
      }
      return null;
    });
  }

  const picks = new Map(); // `${key}|${newN}|${occ}` → сторінка
  const entries = [...requests.entries()];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, entries.length) }, async () => {
    while (next < entries.length) {
      const [newN, reqs] = entries[next++];
      const res = await fetchPdfPages(pdfUrls[newN], reqs.map(r => r.snippet));
      (res?.snippetPages || []).forEach((page, i) => {
        if (page != null && reqs[i]) picks.set(`${reqs[i].key}|${newN}|${reqs[i].occ}`, page);
      });
    }
  }));

  const pickers = {};
  for (const key of Object.keys(texts)) pickers[key] = (newN, occ) => picks.get(`${key}|${newN}|${occ}`) ?? null;
  return pickers;
}
