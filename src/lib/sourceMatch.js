// ── Чи знайдений у базі запис — той самий твір, що й наш ──
// Без цієї перевірки збагачення брало перший результат CrossRef/Google Books і
// чіпляло до джерела DOI, сторінки чи видавця ІНШОЇ статті зі схожою назвою:
// українські наукові назви дуже шаблонні ("Формування стратегії управління
// персоналом підприємства" / "Імперативи стратегічного управління персоналом
// підприємства" — різні статті, різні автори, сусідні роки). Тому звіряємо разом
// назву, прізвище першого автора і рік. Чистий код без мережі — легко тестувати.
import { transliterateLatinToCyrillic } from "./transliteration.js";

// Службові слова, які нічого не кажуть про зміст назви (довші за 3 літери — коротші
// й так відкидаються)
const STOP_WORDS = new Set([
  "який", "яка", "яке", "які", "щодо", "через", "після", "перед", "також", "умовах", "умови",
  "with", "from", "into", "that", "this", "their", "about", "under", "between", "within", "towards",
]);

const HOMOGLYPHS = { a: "а", c: "с", e: "е", i: "і", o: "о", p: "р", x: "х", y: "у", k: "к", m: "м", t: "т", h: "н", b: "в" };

// Слово з мішаниною абеток ("Iнновацiї" з латинськими i з записів баз) → кирилиця
function normWord(w) {
  const lower = w.toLowerCase().replace(/['’ʼ`]/g, "");
  if (/[а-яґєії]/.test(lower) && /[a-z]/.test(lower)) {
    return lower.replace(/[a-z]/g, ch => HOMOGLYPHS[ch] || ch);
  }
  return lower;
}

// Значущі слова назви → "основи" (перші 6 літер), щоб "персоналу"/"персоналом"
// чи "стратегії"/"стратегічного" збігались без повноцінного стемінгу
export function wordStems(text) {
  return (String(text || "").match(/[\p{L}\p{N}'’ʼ]+/gu) || [])
    .map(normWord)
    .filter(w => w.length >= 4 && !STOP_WORDS.has(w))
    .map(w => (w.length > 6 ? w.slice(0, 6) : w));
}

function countShared(aStems, bSet) {
  let n = 0;
  for (const s of new Set(aStems)) if (bSet.has(s)) n++;
  return n;
}

/** Відома назва проти назви кандидата: майже всі слова коротшої — у довшій,
 * і довша не набагато довша (підзаголовок дозволено, чужа стаття — ні). */
export function titlesMatch(ourTitle, candTitle) {
  const a = [...new Set(wordStems(ourTitle))];
  const b = [...new Set(wordStems(candTitle))];
  if (!a.length || !b.length) return false;
  const shared = countShared(a, new Set(b));
  const minLen = Math.min(a.length, b.length);
  const maxLen = Math.max(a.length, b.length);
  if (minLen < 2) return shared === minLen && maxLen <= 2;
  return shared / minLen >= 0.85 && shared / maxLen >= 0.5;
}

/** Сирий рядок опису (межі назви невідомі) проти назви кандидата: майже всі слова
 * назви кандидата мають бути в рядку. Короткі назви так не звірити — відмова. */
export function titleCoveredByLine(candTitle, line) {
  const b = [...new Set(wordStems(candTitle))];
  if (b.length < 3) return false;
  return countShared(b, new Set(wordStems(line))) / b.length >= 0.85;
}

// "Скелет" прізвища для порівняння латиниці з кирилицею: бази часто дають
// українських авторів латиницею ("Salyha" ↔ "Салига", "Holub" ↔ "Голуб")
function skeleton(s) {
  return transliterateLatinToCyrillic(String(s || ""))
    .toLowerCase()
    .replace(/['’ʼ`ь]/g, "")
    .replace(/ґ/g, "г").replace(/[иїй]/g, "і").replace(/є/g, "е");
}

/**
 * Прізвище першого автора кандидата серед наших авторів / у рядку опису.
 * candNames — прізвища (CrossRef family) або повні імена (Google Books "Іван Петренко"):
 * достатньо, щоб хоч одне слово імені першого автора збіглося з нашим словом.
 * true / false, або null — нема чим перевірити (у кандидата чи в нас немає авторів).
 */
export function authorsCompatible(ourAuthorsText, candNames) {
  const first = (candNames || []).map(f => String(f || "").trim()).find(Boolean);
  if (!first) return null;
  const nameWords = (skeleton(first).match(/\p{L}{3,}/gu) || []);
  if (!nameWords.length) return null;
  const ourWords = skeleton(ourAuthorsText).match(/\p{L}{3,}/gu) || [];
  if (!ourWords.length) return null;
  return nameWords.some(nw => {
    const probe = nw.slice(0, 5);
    return ourWords.some(w => w.startsWith(probe));
  });
}

function yearsCompatible(a, b) {
  const x = parseInt(a, 10);
  const y = parseInt(b, 10);
  if (!x || !y) return true;
  return Math.abs(x - y) <= 1;
}

function yearFromText(text) {
  return String(text || "").match(/\b(19\d{2}|20\d{2})\b/)?.[1] || null;
}

/**
 * ours: { title?, line?, authors?: string[], year? } — або відома назва (пошуковий
 *   результат), або сирий рядок опису (ручне введення, джерела клієнта).
 * cand: { title, authors?: string[] (прізвища), year? } — запис з CrossRef / Google Books.
 */
export function isSameWork(ours, cand) {
  if (!cand?.title) return false;
  const ourYear = ours.year || yearFromText(ours.line);
  if (!yearsCompatible(ourYear, cand.year)) return false;
  const titleOk = ours.title
    ? titlesMatch(ours.title, cand.title)
    : titleCoveredByLine(cand.title, ours.line || "");
  if (!titleOk) return false;
  const ourAuthorsText = ours.authors?.length ? ours.authors.join(" ") : (ours.title ? "" : ours.line || "");
  return authorsCompatible(ourAuthorsText, cand.authors) !== false;
}

// Записи CrossRef → формат кандидата для isSameWork
export function crossrefCandidate(item) {
  return {
    title: item?.title?.[0] || "",
    authors: (item?.author || []).map(a => a.family || a.name || "").filter(Boolean),
    year: item?.published?.["date-parts"]?.[0]?.[0] || item?.["published-print"]?.["date-parts"]?.[0]?.[0] || null,
  };
}
