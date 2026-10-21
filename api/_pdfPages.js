// Сторінки статті з самого PDF — для /api/pdf-pages.
// Українські журнали часто не мають ні сторінок у CrossRef/OpenAlex, ні мета-тегів
// сторінок, але в PDF статті номери сторінок надруковано в колонтитулах. Беремо
// числа з верхнього/нижнього поля кількох сторінок (1, 2, 3, передостання, остання)
// і приймаємо лише ЗУСТРІЧНЕ їм зміщення: на сторінці i PDF надруковано first+i−1.
// Випадкові числа (рік, номер випуску, "№ 4" на кожній сторінці) такої узгодженості
// не дають. PDF із текстом, але без жодного номера — електронне видання без сторінок.
//
// Спершу — DOMMatrix/Path2D для Node без @napi-rs/canvas (див. _pdfNodePolyfills.js):
// pdf.mjs звертається до DOMMatrix одразу при імпорті.
// Статичний імпорт воркера: у Node pdf.js працює з "fake worker" і бере обробник з
// globalThis.pdfjsWorker (його виставляє сам цей модуль). Без явного імпорту pdf.js
// робить динамічний import файлу воркера, якого бандлер Vercel не бачить.
import "./_pdfNodePolyfills.js";
import "pdfjs-dist/legacy/build/pdf.worker.mjs";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

export const MAX_PDF_BYTES = 15 * 1024 * 1024;
// Довші PDF — майже завжди весь номер журналу чи збірник: яка з статей наша, звідси не видно
export const MAX_ARTICLE_PDF_PAGES = 60;

const CURRENT_YEAR = new Date().getFullYear();
const isYearLike = n => n >= 1990 && n <= CURRENT_YEAR + 1;
const MARGIN = 0.1; // верхні/нижні 10% сторінки
const ISSUE_LABEL_RE = /(?:вип(?:уск)?|№|no|nr|vol|volume|issue|т|том|number|част(?:ина)?)\.?\s*$/i;

// ── Чисті функції (без pdf.js) ──

/** Кандидати в номер сторінки з текстових елементів однієї сторінки PDF. */
export function marginNumbers(items, pageHeight) {
  const out = [];
  for (const it of items) {
    const y = it.y / pageHeight;
    if (y > MARGIN && y < 1 - MARGIN) continue;
    const s = String(it.str || "").trim();
    if (!s || s.length > 120) continue;
    if (/\d{1,2}[./]\d{1,2}[./]\d{2,4}/.test(s)) continue; // дата ("24.03.2023") — не номер сторінки
    if (/\.{3,}|…|(?:\.\s){3,}/.test(s)) continue; // рядок змісту з крапками-заповнювачами ("… 243")
    let n = null;
    const whole = s.match(/^(\d{1,4})$/);
    // число на початку чи в кінці колонтитула — лише відокремлене пробілом чи роздільником
    // від слова ("53 Економіка…", "…Випуск 60 | 341"), а не частина "24.03" чи "12,5"
    const lead = s.match(/^(\d{1,4})(?:\s*[|·•–—-]\s*|\s+)\p{L}/u);
    const tail = s.match(/^(.*\p{L}[.,:»")]?)(?:\s*[|·•–—-]\s*|\s+)(\d{1,4})$/u);
    if (whole) n = Number(whole[1]);
    else if (lead) n = Number(lead[1]);
    // "Випуск 60", "№ 4", "Vol. 12" наприкінці колонтитула — номер випуску/тому, не сторінка
    else if (tail && !ISSUE_LABEL_RE.test(tail[1])) n = Number(tail[2]);
    if (n != null && n >= 1 && !isYearLike(n)) out.push(n);
  }
  return out;
}

/**
 * samples: [{ index (1-based номер сторінки в PDF), numbers: [...] }] → { first, last }.
 * Голосування за зміщення first = n − (index − 1): потрібна згода щонайменше двох
 * різних сторінок (для однієї сторінки PDF — однозначне єдине число).
 */
export function pagesFromMarginSamples(numPages, samples) {
  // Розворот "дві сторінки на аркуші PDF" (автореферати, брошури: "2 3", "18 19") —
  // зміщення тут не працює, а вгадувати не будемо
  if (samples.some(s => s.numbers.some(n => s.numbers.includes(n + 1)))) return null;
  const votes = new Map();
  for (const { index, numbers } of samples) {
    for (const off of new Set(numbers.map(n => n - (index - 1)))) {
      if (off < 1) continue;
      if (!votes.has(off)) votes.set(off, new Set());
      votes.get(off).add(index);
    }
  }
  let best = null;
  for (const [off, pages] of votes) {
    if (!best || pages.size > best.pages.size || (pages.size === best.pages.size && off < best.off)) best = { off, pages };
  }
  if (!best) return null;
  const need = numPages === 1 ? 1 : 2;
  if (best.pages.size < need) return null;
  // Наскрізна нумерація статті видна і на початку PDF, і в кінці. Якщо зміщення
  // підтверджують лише останні сторінки — це, найімовірніше, зміст чи покажчик
  // уривка книги ("…123", "…243"), а не номери сторінок статті
  if (numPages >= 4) {
    const supported = [...best.pages];
    if (!supported.some(i => i <= 3) || !supported.some(i => i >= numPages - 1)) return null;
  }
  if (numPages === 1) {
    const only = samples[0]?.numbers || [];
    if (new Set(only).size !== 1) return null;
  }
  return { first: best.off, last: best.off + numPages - 1 };
}

/**
 * Рядок цитування на першій сторінці ("Для цитування: … С. 12–19", "Cite as: … pp. 12–19")
 * — запасний сигнал; приймається, лише якщо довжина діапазону узгоджена з PDF.
 */
export function citeLinePages(firstPageText, numPages) {
  const t = String(firstPageText || "").replace(/\s+/g, " ");
  const re = /(?:для цитування|бібліографічний опис|цитування|cite as|citation|how to cite|references to this article)[^]{0,500}?(?:С|C|P|pp?|с)\.\s*(\d{1,4})\s*[-–—]\s*(\d{1,4})/i;
  const m = t.match(re);
  if (!m) return null;
  const first = Number(m[1]);
  const last = Number(m[2]);
  if (last < first || isYearLike(first)) return null;
  const span = last - first + 1;
  return Math.abs(span - numPages) <= 1 ? { first, last } : null;
}

// ── Вибір сторінки за змістом (для посилань у тексті) ──
const STOP = new Set(["which", "these", "those", "their", "there", "where", "about", "також", "якого", "цього", "цьому", "цієї", "більш", "може", "можуть", "тому", "через", "після", "перед", "однак", "проте", "який", "яка", "яке", "які"]);
function stems(text) {
  return (String(text || "").toLowerCase().match(/[\p{L}]{5,}/gu) || [])
    .filter(w => !STOP.has(w))
    .map(w => w.slice(0, 6));
}

const REFS_HEADING_RE = /(список\s+(використаних\s+)?(джерел|літератури)|використані\s+джерела|^\s*література\s*$|references|bibliography|джерела\s+та\s+література)/im;

/**
 * pageTexts — текст кожної сторінки PDF; first — надрукований номер першої сторінки.
 * Для кожного речення з роботи — надрукований номер сторінки статті, де про це йдеться
 * найбільше, або null (збіг слабкий). Не рахуються: перша сторінка (там анотація, з
 * якої модель і писала текст — вона "виграла" б майже завжди) і все від заголовка
 * списку літератури далі (там самі назви джерел та англійська анотація).
 */
export function pickPagesForSnippets(pageTexts, first, snippets) {
  const n = pageTexts.length;
  let end = n;
  for (let i = Math.floor(n / 2); i < n; i++) {
    if (REFS_HEADING_RE.test(pageTexts[i] || "")) { end = i; break; }
  }
  const start = n >= 3 ? 1 : 0;
  const body = [];
  for (let i = start; i < end; i++) body.push({ i, set: new Set(stems(pageTexts[i])) });
  if (!body.length || first == null) return snippets.map(() => null);
  return snippets.map(snip => {
    const want = [...new Set(stems(snip))];
    if (want.length < 3) return null;
    let best = null;
    for (const pg of body) {
      const hit = want.filter(w => pg.set.has(w)).length;
      if (!best || hit > best.hit) best = { hit, i: pg.i };
    }
    if (!best || best.hit < 3 || best.hit / want.length < 0.3) return null;
    return first + best.i;
  });
}

// ── pdf.js ──

async function pageItems(doc, index) {
  const page = await doc.getPage(index);
  const height = page.getViewport({ scale: 1 }).height;
  const content = await page.getTextContent();
  const items = content.items.map(it => ({ str: it.str, y: it.transform?.[5] ?? 0 }));
  return { height, items, text: content.items.map(it => it.str).join(" ") };
}

/**
 * Buffer з PDF → { pages: "a–b" | null, noPages, numPages, snippetPages? }.
 * snippets — речення з тексту роботи для вибору сторінки за змістом (необов'язково).
 */
export async function analyzePdf(buffer, snippets = null) {
  const doc = await getDocument({
    data: new Uint8Array(buffer), verbosity: 0,
    isEvalSupported: false, disableFontFace: true, useSystemFonts: false,
  }).promise;
  try {
    const numPages = doc.numPages;
    if (numPages > MAX_ARTICLE_PDF_PAGES) return { pages: null, noPages: false, numPages, reason: "too-many-pages" };

    const sampleIdx = [...new Set([1, 2, 3, numPages - 1, numPages])].filter(i => i >= 1 && i <= numPages).sort((a, b) => a - b);
    const sampled = new Map();
    for (const i of sampleIdx) sampled.set(i, await pageItems(doc, i));
    const samples = sampleIdx.map(i => ({ index: i, numbers: marginNumbers(sampled.get(i).items, sampled.get(i).height) }));

    let range = pagesFromMarginSamples(numPages, samples) || citeLinePages(sampled.get(1)?.text, numPages);
    const textChars = [...sampled.values()].reduce((sum, p) => sum + p.text.replace(/\s/g, "").length, 0);
    const anyNumbers = samples.some(s => s.numbers.length);
    // Текст є (не скан), а номерів сторінок немає ніде — видання без сторінок
    const noPages = !range && !anyNumbers && textChars > 1500;
    if (range && (range.last - range.first > 100)) range = null;

    const result = { pages: range ? (range.first === range.last ? `${range.first}` : `${range.first}–${range.last}`) : null, noPages, numPages };
    if (snippets?.length && range) {
      const texts = [];
      for (let i = 1; i <= numPages; i++) texts.push(sampled.get(i)?.text ?? (await pageItems(doc, i)).text);
      result.snippetPages = pickPagesForSnippets(texts, range.first, snippets);
    }
    return result;
  } finally {
    try { await doc.destroy(); } catch { /* ignore */ }
  }
}
