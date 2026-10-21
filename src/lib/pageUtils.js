// ── Сторінки джерела як дані: нормалізація, перевірка, розбір з тексту опису ──
// Сторінки приходять з дуже різних місць (CrossRef "page", OpenAlex biblio, DOAJ
// start_page/end_page, мета-теги сторінки журналу, колонтитули PDF, кінець DOI) і в
// різному вигляді. Тут — єдине місце, де вони зводяться до { first, last } (стаття)
// чи загального обсягу (книга) і де відсіюються явно хибні значення. Чистий код без
// мережі — щоб тестувати на реальних випадках.

const CURRENT_YEAR = new Date().getFullYear();

// Найбільша правдоподібна довжина статті/розділу. Більший "діапазон" — це майже
// завжди сторінки всього номера журналу чи збірника, а не конкретної статті.
export const MAX_ARTICLE_SPAN = 100;

const DASH = "[-–—−‐]";

function isYearLike(n) {
  return n >= 1900 && n <= CURRENT_YEAR + 1;
}

/**
 * Сирі сторінки ("12-19", "С. 12–19", "pp. 191-99", 45, {first, last}) → { first, last }
 * або null, якщо це не сторінки статті:
 *  - "e12345", "S12–S19", "iv–xii", "12, 15" — не числовий діапазон;
 *  - нулі попереду ("04–05" з кінця DOI) — це ідентифікатор, а не сторінки;
 *  - last < first, діапазон довший за MAX_ARTICLE_SPAN;
 *  - одна "сторінка", що виглядає як рік (типова помилка розбору "... 2021.").
 * allowAbbrev: "1234-45" → 1234–1245 (скорочений запис кінцевої сторінки, MLA/CrossRef).
 * Для кінця DOI його вимкнено: там "81-5" — це номер випуску й статті, а не 81–85.
 */
export function normalizePages(raw, { allowAbbrev = true } = {}) {
  if (raw == null || raw === "") return null;
  let firstStr, lastStr;
  if (typeof raw === "object") {
    if (raw.first == null) return null;
    firstStr = String(raw.first).trim();
    lastStr = raw.last == null || raw.last === "" ? "" : String(raw.last).trim();
  } else {
    const s = String(raw).trim().replace(/^(?:pp|p|с|c|стор|s)\.?\s*/i, "");
    const m = s.match(new RegExp(`^(\\d{1,5})(?:\\s*${DASH}\\s*(\\d{1,5}))?\\.?$`));
    if (!m) return null;
    firstStr = m[1];
    lastStr = m[2] || "";
  }
  if (!/^\d{1,5}$/.test(firstStr) || (lastStr && !/^\d{1,5}$/.test(lastStr))) return null;
  if (/^0\d/.test(firstStr) || /^0\d/.test(lastStr)) return null;
  const first = Number(firstStr);
  let last = lastStr ? Number(lastStr) : first;
  if (lastStr && last < first && allowAbbrev && lastStr.length < firstStr.length) {
    last = Number(firstStr.slice(0, firstStr.length - lastStr.length) + lastStr);
  }
  if (first < 1 || last < first) return null;
  if (last - first > MAX_ARTICLE_SPAN) return null;
  if (first === last && isYearLike(first)) return null;
  return { first, last };
}

export function formatPages(p) {
  if (!p) return "";
  return p.first === p.last ? String(p.first) : `${p.first}–${p.last}`;
}

// Загальний обсяг книги (Google Books pageCount, "240 с.") → число або null.
export function normalizeTotalPages(raw) {
  if (raw == null || raw === "") return null;
  const m = String(raw).match(/\d{1,5}/);
  if (!m) return null;
  const n = Number(m[0]);
  return n >= 4 && n <= 5000 ? n : null;
}

/**
 * Сторінки з кінця DOI: частина українських видавців кодує їх у суфіксі
 * ("10.52058/2786-5274-2024-6(34)-383-392" → 383–392). Евристика, тож:
 * лише 2–4-значні числа, без нулів попереду ("…-2025-20-04-05" — це ID статті),
 * без скороченого запису і не дата в кінці ("…2021-10-15").
 */
export function extractPagesFromDoi(doi = "") {
  const d = String(doi || "").trim();
  if (/(?:19|20)\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/.test(d)) return null;
  // "…/2024-60-71": рік-випуск-стаття ("Економіка та суспільство" № 60, стаття 71;
  // справжні сторінки — 340–343). Сторінки в суфіксі йдуть після випуску, а не одразу після року
  if (/(?:^|[/.-])(?:19|20)\d{2}-\d{1,4}-\d{1,4}$/.test(d)) return null;
  const m = d.match(/-(\d{2,4})-(\d{2,4})$/);
  if (!m) return null;
  return normalizePages({ first: m[1], last: m[2] }, { allowAbbrev: false });
}

// ── Розбір сторінок з тексту бібліографічного опису ──
// "С./с./P./p./pp./стор./S." визнається сторінками ЛИШЕ як окремий елемент опису —
// на початку, після ". ", ", ", "; ", ": ", "(" чи " – ". Раніше будь-яке слово на
// "с"/"p" перед числом ("Освітній процес. 2021", "Leadership. 2021") давало
// "сторінку 2021", а "P. 191–199" — лише 191.
const PAGE_MARK = "(?:pp|PP|Pp|p|P|стор|Стор|сс|с|С|c|C|S)";
const BEFORE = "(?:^|[.,;:(]\\s*|\\s[–—-]\\s*)";
const AFTER = "(?=\\s*(?:[.,;)\\]]|$|URL|DOI|doi|https?:|\\())";
const RANGE_IN_TEXT_RE = new RegExp(`${BEFORE}${PAGE_MARK}\\.\\s*(\\d{1,5})(?:\\s*${DASH}\\s*(\\d{1,5}))?${AFTER}`, "u");
const TOTAL_IN_TEXT_RE = new RegExp(`(?:^|[.,;:]\\s*|\\s)(\\d{1,5})\\s*(?:с|c|p|pp|стор|S|s)\\.${AFTER}`, "u");
// APA: "Journal, 12(3), 191–199." — сторінки без позначки, одразу після том(номер)
const APA_RANGE_RE = new RegExp(`\\d+\\s*\\(\\s*[\\w–-]+\\s*\\)\\s*,\\s*(\\d{1,5})\\s*${DASH}\\s*(\\d{1,5})`, "u");

/**
 * Текст опису → { first, last, index, length } (сторінки статті; index/length —
 * де в рядку стоять самі числа, щоб їх можна було замінити) або { total } (обсяг
 * книги "240 с.") або null.
 */
export function parseRefPages(text) {
  const s = String(text || "");
  const m = s.match(RANGE_IN_TEXT_RE);
  if (m) {
    const p = normalizePages({ first: m[1], last: m[2] || "" });
    if (p) {
      // до першої цифри в збігу — лише роздільник і позначка "С.", самі числа — далі
      const d = m[0].search(/\d/);
      return { ...p, index: m.index + d, length: m[0].length - d };
    }
  }
  const apa = s.match(APA_RANGE_RE);
  if (apa) {
    const p = normalizePages({ first: apa[1], last: apa[2] });
    if (p) {
      const d = apa[0].lastIndexOf(apa[1]);
      return { ...p, index: apa.index + d, length: apa[0].length - d };
    }
  }
  const t = s.match(TOTAL_IN_TEXT_RE);
  if (t) {
    const total = normalizeTotalPages(t[1]);
    if (total && !isYearLike(total)) return { total };
  }
  return null;
}

// Діапазон сторінок книги для внутрітекстових посилань: [1, N] звужений на пару
// сторінок з кожного краю (титул/зміст на початку, бібліографія/покажчик у кінці).
export function narrowBookRange(total) {
  const n = Number(total);
  const buffer = Math.min(3, Math.max(1, Math.floor(n * 0.1)));
  const min = buffer + 1;
  const max = n - buffer;
  return min < max ? { min, max } : { min: 1, max: n };
}
