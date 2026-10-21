// ── Форматування списку джерел + перестановка посилань [N] у тексті ──
// Портовано з doRemapCitations (academic-assistant.jsx) для малих робіт,
// де [N] у тексті ЗАВЖДИ відповідає citations[N-1] (єдиний глобальний список,
// без посекційної локальної нумерації).
//
// Ключовий принцип конвеєра (дедуплікація → форматування → сортування):
// 1. Дедуплікація — на сирому тексті (робить викликач, до цього файлу).
// 2. Форматування стилю через ЛЛМ — ЛЛМ виправляє пунктуацію/порядок компонентів
//    імені в КОЖНОМУ джерелі окремо, але НІКОЛИ не переставляє, не додає й не вилучає
//    джерела. Відповідь звіряється за змістом (formatSourcesWithRetry), а не лише за
//    кількістю рядків — інакше галюцинація чи збита нумерація тихо ламають усі номери
//    цитат у тексті. (Раніше була ще гілка "довіряй порядку ЛЛМ" для кастомного
//    групування з методички — прибрана: майже кожна методичка згадує стандартну
//    вимогу "за алфавітом", тож ця гілка вмикалась майже завжди, а ЛЛМ ненадійна саме
//    в питаннях порядку — з цього й починалась уся ця історія багів.)
// 3. Сортування — код, ПІСЛЯ форматування, на вже правильно оформленому (прізвище
//    спереду) тексті. Раніше сортування йшло ДО форматування, на сирому тексті —
//    тому джерело на кшталт "В. О. Іванов" (ініціали спереду) сортувалось під "В",
//    а не під "І", як має бути за ДСТУ.

import { normalizeAuthorsScript, isCyrillicText, normalizeAuthorScriptInRawLine } from "./transliteration.js";
import { locateFragment } from "./textFragmentLocate.js";
import { buildCitationInsertPrompt } from "./prompts.js";
import { parseRefPages, normalizeTotalPages, narrowBookRange, formatPages } from "./pageUtils.js";
import { cleanAuthorList, isBadVenue, cleanMetaText, fetchUrlMeta } from "./sourcesSearch.js";
import { getLangLabels, sourcesHeadingAlt, dynamicAppendixWords } from "./planUtils.js";

// Абетка авторів має бути єдиною в межах ОДНОГО запису (і, за замовчуванням,
// відповідати абетці назви джерела) — інакше виходить "Savchuk I., Лисецька
// Ю. В." замість "Савчук І., Лисецька Ю. В.". Основна причина розсинхрону —
// автоімпорт з OpenAlex/CrossRef, де display_name часто дається лише
// латиницею навіть для українських авторів. normalizeAuthorsScript сама
// вирішує, чи є запис кириличним (за назвою АБО за іншими авторами того
// самого запису), тож достатньо передати сюди "необов'язковий" прапорець.
export function buildStructuredEntry(p) {
  const e = { _type: "structured" };
  const recordIsCyrillic = p.lang === "uk" || isCyrillicText(p.title);
  if (p.authorsStructured?.length) {
    const families = normalizeAuthorsScript(p.authorsStructured.map(a => a.family || ""), recordIsCyrillic);
    const givens = normalizeAuthorsScript(p.authorsStructured.map(a => a.given || ""), recordIsCyrillic);
    e.authors = p.authorsStructured.map((a, i) => ({ ...a, family: families[i], given: givens[i] }));
  } else if (p.authors?.length) {
    // лише імена: у джерелах, зібраних до виправлення розбору Google Scholar, серед
    // "авторів" лежать уламки назви журналу й рік ("T Nazarova - International Science
    // Journal of …", "2024") — ЛЛМ переносила їх у журнал, обрізаними й транслітерованими
    const clean = cleanAuthorList(p.authors);
    if (clean.length) e.authorsRaw = normalizeAuthorsScript(clean, recordIsCyrillic);
  }
  if (p.title) e.title = p.title;
  if (p.year) e.year = p.year;
  // домен сайту чи обрізана Scholar-ом назва ("Актуальні питання …") — не журнал
  if (!isBadVenue(p.venue)) e.journal = cleanMetaText(p.venue);
  if (p.volume) e.volume = p.volume;
  if (p.issue) e.issue = p.issue;
  if (p.pages) e.pages = p.pages;
  if (p.totalPages) e.totalPages = p.totalPages;
  if (p.publisher) e.publisher = p.publisher;
  if (p.publisherLocation) e.city = p.publisherLocation;
  const url = p.url || (p.doi ? `https://doi.org/${p.doi}` : "");
  if (url) e.url = url;
  if (p.type === "book") e._docType = "book";
  return e;
}

// Витягує валідний діапазон сторінок джерела для внутрітекстового цитування:
// - стаття/дисертація з "С. X–Y" / "P. X–Y" / "pp. X–Y" → діапазон статті;
// - книга без діапазону, але з відомим загальним обсягом (власний рядок "N с."/"N p."
//   або structuredPaper.totalPages) → [1, N], звужений на пару сторінок з кожного краю
//   (титул/зміст на початку, бібліографія/покажчик у кінці — не змістовні);
// - закон/сайт (немає ні того, ні іншого) → null, сторінка не показується.
// Джерело істини — сам текст рядка (ручні правки менеджера важливіші за збережені
// дані пошуку); розбір — строгий (parseRefPages), тож "Освітній процес. 2021" чи
// "Leadership. 2021" більше не дають "сторінку 2021", а "P. 191–199" — лише 191.
export function extractPageRange(rawRef, structuredPaper) {
  const isBook = structuredPaper?.type === "book" || structuredPaper?._docType === "book";
  const parsed = parseRefPages(rawRef || "");
  if (parsed?.first != null) {
    // Одне число "С. N" у книги — старі записи Google Books, де загальний обсяг
    // потрапляв у поле сторінок: це обсяг, а не сторінка.
    if (isBook && parsed.first === parsed.last) return narrowBookRange(parsed.first);
    return { min: parsed.first, max: parsed.last };
  }
  if (parsed?.total) return narrowBookRange(parsed.total);
  const total = normalizeTotalPages(structuredPaper?.totalPages);
  if (total) return narrowBookRange(total);
  return null;
}

// Обирає конкретну сторінку з діапазону для N-го за рахунком вживання джерела —
// щоб повторні цитування того самого джерела не показували щоразу однакову сторінку.
export function pickPageInRange(range, occurrenceIndex) {
  const span = range.max - range.min;
  if (span <= 0) return range.min;
  const fractions = [0, 0.5, 0.25, 0.75, 0.15, 0.85, 0.4, 0.6];
  const frac = fractions[(occurrenceIndex - 1) % fractions.length];
  return range.min + Math.round(span * frac);
}

// ── Єдиний розбір позначки джерела в квадратних дужках ──
// Модель і наші ж проходи пишуть посилання по-різному: [5] · [5, с. 12] · [5, с. 12–14] ·
// [5, p. 7] · [5 с. 12] · [2; 3] · [2, 3] · [2, с. 54; 3, с. 101] · [1–3]. Раніше кожне
// місце в проєкті мало власну регулярку, і всі вони в "[2, с. 54; 3, с. 101]" бачили
// лише перше джерело: друге мовчки зникало з тексту, а далі — як "непроцитоване" — і
// зі списку літератури. Тепер усі місця, що читають чи переписують посилання, йдуть
// через parseCitationInner / replaceCitationBrackets / extractCitedNumbers.
const CIT_ITEM_WITH_PAGE_RE = /\s*(\d{1,4})\s*,?\s*(pp|p|стор|сс|с|c|s)\.?\s*(\d{1,5})(?:\s*[–—−-]\s*(\d{1,5}))?\s*/iuy;
// "[5, с. X]" / "[5, с. PAGE]" — модель скопіювала заглушку замість сторінки: джерело
// лишається, "сторінку" відкидаємо (далі код підставить справжню з діапазону)
const CIT_ITEM_PLACEHOLDER_PAGE_RE = /\s*(\d{1,4})\s*,\s*(?:pp|p|стор|сс|с|c|s)\.\s*[A-Za-zА-Яа-яІіЇїЄєҐґ_?]{0,12}\s*/iuy;
const CIT_ITEM_RANGE_RE = /\s*(\d{1,4})\s*[–—−-]\s*(\d{1,4})\s*/uy;
const CIT_ITEM_NUM_RE = /\s*(\d{1,4})\s*/uy;
const CIT_SEP_RE = /[,;]/uy;
const CIT_BRACKET_RE = /\[([^[\]\n]{1,160})\]/g;

/**
 * Вміст дужок → [{ n, page?, pageTo?, abbr?, raw }] або null, якщо це не позначка
 * джерела ("[Електронний ресурс]", "[КЛІЄНТ-ІЛЮСТРАЦІЯ:1]", "[1.1]", "[N]").
 * raw — нормалізований запис елемента ("5" / "5, с. 12–14") для перезбирання дужки.
 */
export function parseCitationInner(inner) {
  const s = String(inner || "");
  const items = [];
  let pos = 0;
  for (let guard = 0; guard < 50; guard++) {
    let m;
    CIT_ITEM_WITH_PAGE_RE.lastIndex = pos;
    if ((m = CIT_ITEM_WITH_PAGE_RE.exec(s))) {
      const pageTo = m[4] != null ? Number(m[4]) : null;
      const abbr = `${m[2]}.`;
      items.push({ n: Number(m[1]), page: Number(m[3]), pageTo, abbr, raw: `${m[1]}, ${abbr} ${m[3]}${pageTo != null ? `–${m[4]}` : ""}` });
      pos = CIT_ITEM_WITH_PAGE_RE.lastIndex;
    } else if ((CIT_ITEM_PLACEHOLDER_PAGE_RE.lastIndex = pos, m = CIT_ITEM_PLACEHOLDER_PAGE_RE.exec(s))) {
      items.push({ n: Number(m[1]), raw: m[1] });
      pos = CIT_ITEM_PLACEHOLDER_PAGE_RE.lastIndex;
    } else {
      CIT_ITEM_RANGE_RE.lastIndex = pos;
      m = CIT_ITEM_RANGE_RE.exec(s);
      if (m && Number(m[2]) > Number(m[1]) && Number(m[2]) - Number(m[1]) <= 20) {
        for (let k = Number(m[1]); k <= Number(m[2]); k++) items.push({ n: k, raw: String(k) });
        pos = CIT_ITEM_RANGE_RE.lastIndex;
      } else {
        CIT_ITEM_NUM_RE.lastIndex = pos;
        m = CIT_ITEM_NUM_RE.exec(s);
        if (!m) return null;
        items.push({ n: Number(m[1]), raw: m[1] });
        pos = CIT_ITEM_NUM_RE.lastIndex;
      }
    }
    if (pos >= s.length) return items;
    CIT_SEP_RE.lastIndex = pos;
    if (!CIT_SEP_RE.exec(s)) return null;
    pos = CIT_SEP_RE.lastIndex;
  }
  return null;
}

// Проходить усі позначки джерел у тексті: fn(items, whole, offset) повертає заміну
// (рядок) або null/undefined — лишити як є. Дужки, що не є позначками джерел, не чіпає.
export function replaceCitationBrackets(text, fn) {
  if (!text) return text;
  return String(text).replace(CIT_BRACKET_RE, (whole, inner, offset) => {
    const items = parseCitationInner(inner);
    if (!items) return whole;
    const out = fn(items, whole, offset);
    return out == null ? whole : out;
  });
}

// Номери джерел у порядку появи в тексті (з повторами) — з усіх форм позначок,
// включно з груповими зі сторінками.
export function extractCitedNumbers(text) {
  const nums = [];
  replaceCitationBrackets(text || "", items => { items.forEach(it => nums.push(it.n)); return null; });
  return nums;
}

// Чи процитоване джерело N у тексті для APA/MLA, де позначка — "(Автор, Рік)": шукаємо
// внутрішню частину без дужок, бо в тексті вона буває зі сторінкою "(Автор, Рік, с. 5)"
// чи в групі "(Автор1, Рік; Автор2, Рік)" — повний рядок "(Автор, Рік)" там не трапиться.
export function isAuthorYearCited(text, cite) {
  if (!text || !cite) return false;
  const inner = cite.startsWith("(") && cite.endsWith(")") ? cite.slice(1, -1) : cite;
  return inner.length > 2 && text.includes(inner);
}

// Перезбирає позначку з елементів parseCitationInner (нормалізований запис, "; " між джерелами)
export function rebuildBracket(items) {
  return `[${items.map(it => it.raw).join("; ")}]`;
}

// ── Виправлення сторінок у цитатах, що виходять за межі реального обсягу джерела ──
// Суто кодова перевірка (без ШІ): для кожної цитати "[N, с. X]" чи "[N, с. X–Y]" у
// тексті (у тому числі всередині групи "[2, с. 54; 3, с. 101]") звіряє сторінку(и) з
// реальним діапазоном джерела N (extractPageRange із самого бібліографічного опису) і,
// якщо вона поза межами, підбирає нову коректну (pickPageInRange) — число підбирає
// код, а не ЛЛМ, тож ризику вигадування немає. Для діапазону зберігає ширину
// оригіналу (Y−X), звужену до реально доступної в джерелі, а не схлопує в одну
// сторінку — так "с. 120–125" лишається діапазоном, а не стає "с. 50–50".
function fixItemPages(it, range, occ) {
  const x = it.page;
  if (it.pageTo == null) {
    if (x >= range.min && x <= range.max) return null; // валідна — лишаємо
    return `${pickPageInRange(range, occ)}`;
  }
  const y = it.pageTo;
  if (x >= range.min && y <= range.max && x <= y) return null; // валідний діапазон
  const width = Math.min(Math.max(0, y - x), range.max - range.min);
  const newStart = pickPageInRange({ min: range.min, max: range.max - width }, occ);
  return `${newStart}–${newStart + width}`;
}

// Прохід по одній дужці: повертає виправлені елементи або null, якщо все гаразд.
function fixBracketPages(items, ranges, occCount) {
  let changed = 0;
  const fixed = items.map(it => {
    if (it.page == null) return it;
    const range = ranges[it.n];
    if (!range) return it; // джерело без відомого діапазону (закон/сайт) — не чіпаємо
    occCount[it.n] = (occCount[it.n] || 0) + 1;
    const newPages = fixItemPages(it, range, occCount[it.n]);
    if (newPages == null) return it;
    changed++;
    return { ...it, raw: `${it.n}, ${it.abbr} ${newPages}` };
  });
  return changed ? { fixed, changed } : null;
}

export function fixOutOfRangeCitationPages({ content, sections }) {
  const srcSec = sections.find(s => s.type === "sources");
  if (!srcSec) return { updatedContent: content, fixedCount: 0, affectedSectionIds: [] };
  const sourcesText = content[srcSec.id] || "";

  const ranges = {};
  sourcesText.split("\n").forEach(line => {
    const m = line.match(/^\s*(\d+)[.)]\s*(.*)$/);
    if (!m) return;
    const range = extractPageRange(m[2].trim(), null);
    if (range && range.min <= range.max) ranges[Number(m[1])] = range;
  });

  const occCount = {};
  let fixedCount = 0;
  const updatedContent = { ...content };
  const affectedSectionIds = [];

  sections.filter(s => s.type !== "sources").forEach(sec => {
    const text = content[sec.id];
    if (!text) return;
    const newText = replaceCitationBrackets(text, items => {
      const res = fixBracketPages(items, ranges, occCount);
      if (!res) return null;
      fixedCount += res.changed;
      return rebuildBracket(res.fixed);
    });
    if (newText !== text) {
      updatedContent[sec.id] = newText;
      affectedSectionIds.push(sec.id);
    }
  });

  return { updatedContent, fixedCount, affectedSectionIds };
}

// ── Той самий принцип, але для суцільного плаского тексту одного документа без
// структури sections/content (використовує "Правки до файлу" — там немає окремих
// розділів, список джерел треба знайти прямо в тексті за заголовком). Повертає
// ОДНЕ перше знайдене невалідне цитування (позиція + виправлений варіант) або
// null — виклик має застосувати його й повторно викликати цю функцію на
// оновленому тексті (заміна може змінити довжину рядка й зсунути позиції інших
// збігів, тож рахувати наперед усі позиції одразу небезпечно). ──
// Варіанти заголовка списку джерел (цілий рядок). Окрім стандартних — поширені
// в чужих роботах ("СПИСОК ВИКОРИСТАНОЇ ЛІТЕРАТУРИ" тощо) і ті, що генерація
// сама пише для чеської/словацької/китайської (getLangLabels().sources).
// Слова — окремим рядком: до них під час розбору додаються заголовки всіх мов роботи, зокрема
// мов із набору ШІ (sourcesHeadingAlt, planUtils.js).
const SOURCES_HEADING_WORDS = "СПИСОК ВИКОРИСТАНИХ ДЖЕРЕЛ(?: ТА ЛІТЕРАТУРИ)?|СПИСОК ВИКОРИСТАНОЇ ЛІТЕРАТУРИ|СПИСОК ЛІТЕРАТУРИ|СПИСОК ДЖЕРЕЛ|ВИКОРИСТАНІ ДЖЕРЕЛА|ВИКОРИСТАНА ЛІТЕРАТУРА|ДЖЕРЕЛА|REFERENCES|LIST OF REFERENCES|WORKS CITED|BIBLIOGRAPHY|LITERATURVERZEICHNIS|BIBLIOGRAFIA|BIBLIOGRAFÍA|SEZNAM POUŽITÉ LITERATURY|ZOZNAM POUŽITEJ LITERATÚRY|参考文献";
const sourcesHeadingRe = () => new RegExp(`^(${SOURCES_HEADING_WORDS}|${sourcesHeadingAlt()})\\s*$`, "gim");
// Не \b: без прапорця u він не бачить меж кириличних слів — через це раніше
// "ДОДАТКИ" ніколи не знаходились, і рядки додатків ("1. ...") читались як джерела.
// Множинні заголовки й однинні позначки додатків усіма мовами роботи (getLangLabels:
// appendixWord / appendixSingular) — "ANHÄNGE", "APÉNDICES", "ANNEXES" тощо раніше не впізнавались.
const NEXT_HEADING_AFTER_SOURCES_WORDS = "ДОДАТКИ|ДОДАТОК|APPENDIX|APPENDICES|ANHANG|ANHÄNGE|ZAŁĄCZNIKI|ZAŁĄCZNIK|DODATKI|PŘÍLOHY|PŘÍLOHA|PRÍLOHY|PRÍLOHA|APÉNDICES|APÉNDICE|ANEXOS|ANNEXES|ANNEXE|APPENDICI|APPENDICE|附录";
const nextHeadingAfterSourcesRe = () => new RegExp(`\\n\\s*(${[NEXT_HEADING_AFTER_SOURCES_WORDS, ...dynamicAppendixWords()].join("|")})(?=[\\s.:–-]|$)`, "i");

// ── Знаходить межі списку джерел у плоскому тексті (за заголовком) і парсить
// пронумеровані записи — спільна основа для findOutOfRangeCitationInText і для
// перебудови списку джерел ("Правки до файлу", де немає структури sections/content).
// Заголовок береться ОСТАННІЙ з тих, що збіглися: той самий рядок може стояти
// раніше у ЗМІСТІ (якщо зміст набрано рядками чи таблицею).
// Якщо жоден рядок не має набраного номера ("1. ..."), список, найімовірніше,
// пронумеровано автоматично (нумерація Word не є текстом) — тоді записами
// вважаються непорожні рядки по порядку (autoNumbered:true). ──
export function locateSourcesZone(text) {
  const matches = Array.from(text.matchAll(sourcesHeadingRe()));
  const headingMatch = matches[matches.length - 1];
  if (!headingMatch) return null;
  const sourcesStart = headingMatch.index + headingMatch[0].length;
  const nextMatch = text.slice(sourcesStart).match(nextHeadingAfterSourcesRe());
  const sourcesEnd = nextMatch ? sourcesStart + nextMatch.index : text.length;
  const lines = text.slice(sourcesStart, sourcesEnd).split("\n");
  const entries = [];
  lines.forEach(line => {
    const m = line.match(/^\s*(\d+)[.)]\s*(.*)$/);
    if (m && m[2].trim()) entries.push({ number: Number(m[1]), text: m[2].trim() });
  });
  if (!entries.length) {
    // Підзаголовки всередині списку ("І. Нормативна література", "ЛІТЕРАТУРА
    // ІНОЗЕМНИМИ МОВАМИ") — не джерела.
    lines.map(l => l.trim())
      .filter(l => l.length >= 15 && l !== l.toUpperCase() && !/^[IVXІ]+\.\s/.test(l))
      .forEach((l, i) => entries.push({ number: i + 1, text: l }));
    return { sourcesStart, sourcesEnd, entries, autoNumbered: entries.length > 0 };
  }
  return { sourcesStart, sourcesEnd, entries };
}

// ── Перенумерація цитат поза списком джерел після перебудови списку ("Правки до
// файлу"): для КОЖНОЇ позначки [N] / [N, с. X] / групи [2, с. 54; 3] обчислює заміну
// за oldToNew — новий номер, або видалення елемента, якщо N відображено в null
// (джерело прибрано); номери, яких у мапі немає, лишаються як є. Повертає всі заміни
// одразу, від кінця тексту до початку: викликач застосовує їх саме в цьому порядку,
// тож позиції ще не застосованих лишаються дійсними.
// (Раніше тут була findNextCitationToRenumber, що повертала по одній заміні за виклик:
// на незмінному номері — [1] → [1] — цикл викликача крутився до запобіжника, решта
// посилань не перенумеровувалась, а вже зсунуте "[5] → [4]" на наступному колі
// перенумеровувалось удруге як старе 4.)
export function findCitationsToRenumber(text, oldToNew, sourcesStart, sourcesEnd) {
  const fixes = [];
  replaceCitationBrackets(text, (items, whole, offset) => {
    if (offset >= sourcesStart && offset < sourcesEnd) return null; // сам список джерел
    let changed = false;
    const kept = [];
    for (const it of items) {
      if (!(it.n in oldToNew)) { kept.push(it); continue; }
      const newN = oldToNew[it.n];
      if (newN == null) { changed = true; continue; }
      if (newN !== it.n) changed = true;
      kept.push({ ...it, n: newN, raw: it.raw.replace(/^\d+/, String(newN)) });
    }
    if (!changed) return null;
    if (!kept.length) {
      // усі джерела позначки видалено — прибираємо її разом із пробілом перед нею,
      // інакше лишається "текст ," замість "текст,"
      const start = offset > 0 && text[offset - 1] === " " ? offset - 1 : offset;
      fixes.push({ start, end: offset + whole.length, replacement: "" });
    } else {
      fixes.push({ start: offset, end: offset + whole.length, replacement: rebuildBracket(kept) });
    }
    return null;
  });
  return fixes.sort((a, b) => b.start - a.start);
}

export function findOutOfRangeCitationInText(text) {
  const zone = locateSourcesZone(text);
  if (!zone) return null;
  const { sourcesStart, sourcesEnd, entries } = zone;

  const ranges = {};
  entries.forEach(e => {
    const range = extractPageRange(e.text, null);
    if (range && range.min <= range.max) ranges[e.number] = range;
  });
  if (!Object.keys(ranges).length) return null;

  const occCount = {};
  let found = null;
  replaceCitationBrackets(text, (items, whole, offset) => {
    if (found) return null;
    if (offset >= sourcesStart && offset < sourcesEnd) return null; // сам список джерел, не цитата
    const res = fixBracketPages(items, ranges, occCount);
    if (res) found = { start: offset, end: offset + whole.length, replacement: rebuildBracket(res.fixed) };
    return null;
  });
  return found;
}

// Рахує, скільки невалідних цитувань є в тексті — для показу в UI перед
// застосуванням. Прогонить fix-і на СКОПІЙОВАНОМУ рядку, не чіпаючи реальний
// документ (справжнє застосування йде через docx-хірургію викликачем).
export function countOutOfRangeCitations(text) {
  let t = text;
  let count = 0;
  for (let i = 0; i < 500; i++) {
    const fix = findOutOfRangeCitationInText(t);
    if (!fix) break;
    t = t.slice(0, fix.start) + fix.replacement + t.slice(fix.end);
    count++;
  }
  return count;
}

// Готова позначка для одного чи кількох джерел у стилі роботи. mapped — [{ n, page }]
// (фінальні номери; page — null, якщо сторінки немає). ДСТУ: "[5, с. 12]", група —
// "[2, с. 54; 3]"; APA/MLA: "(Автор, 2020, с. 12)", група — "(А, 2020; Б, 2021)";
// виноски "%%FNn%%" сторінки не мають і в групі йдуть окремими маркерами.
export function formatCitationGroup(mapped, refCiteText, pageAbbrev = "с.") {
  const bases = mapped.map(m => refCiteText[m.n] || `[${m.n}]`);
  const withPage = (base, page) => {
    if (page == null) return base;
    if (base.endsWith(")")) return `${base.slice(0, -1)}, ${pageAbbrev} ${page})`;
    if (base.endsWith("]")) return `${base.slice(0, -1)}, ${pageAbbrev} ${page}]`;
    return base;
  };
  if (mapped.length === 1) return withPage(bases[0], mapped[0].page);
  const parts = mapped.map((m, i) => withPage(bases[i], m.page));
  if (bases.every(b => b.startsWith("[") && b.endsWith("]"))) return `[${parts.map(p => p.slice(1, -1)).join("; ")}]`;
  if (bases.every(b => b.startsWith("(") && b.endsWith(")"))) return `(${parts.map(p => p.slice(1, -1)).join("; ")})`;
  return parts.join(" ");
}

// Формат позначки джерела після перенумерації oldN → newN: "[oldN]" → "[newN]",
// "%%FNoldN%%" → "%%FNnewN%%"; "(Автор, Рік)" APA/MLA від номера не залежить.
// (Практика копіювала старий "[oldN]" як є — після видалення джерела зі списку всі
// наступні посилання в тексті лишались зі старими номерами, зсунутими на одиницю.)
export function renumberedCiteText(base, newN) {
  if (base == null) return base;
  if (/^\[\d+\]$/.test(base)) return `[${newN}]`;
  if (/^%%FN\d+%%$/.test(base)) return `%%FN${newN}%%`;
  return base;
}

// Позначка для довставки посилання на джерело N (осиротілі джерела на фінальному
// кроці) — одразу зі сторінкою, якщо діапазон відомий: раніше довставлені посилання
// йшли як "[N]" без сторінки, бо прохід сторінок після довставки вже не запускався.
export function citationMarkerWithPage(n, refCiteText, pageRanges = {}, pageAbbrev = "с.") {
  const range = pageRanges?.[n];
  return formatCitationGroup([{ n, page: range ? pickPageInRange(range, 1) : null }], refCiteText, pageAbbrev);
}

// Замінює [oldN] / [oldN, с. X] / групові [oldN; oldM, с. Y] та виносочні маркери
// %%FN<oldN>%% у тексті на нові номери у фінальному форматі стилю. Групові цитати
// виникають і в самої моделі, і при локалізації посилань готової частини клієнта
// (localizeCitations у readyWorkExtract.js). Сторінка кожного елемента, у тому числі
// в групі, обирається так: сторінка за змістом (pagePicker, якщо ввімкнено й вона
// в межах діапазону) → сторінка, яку вписала модель (якщо в межах діапазону) →
// сторінка з діапазону (pickPageInRange, різна для повторних посилань). Без відомого
// діапазону (закон/сайт, виноски) — без сторінки.
// %%FN<oldN>%% — завжди одиночний номер, тож для нього достатньо прямої заміни за
// oldToNew; якщо джерело видалено — маркер прибирається (порожній рядок), інакше
// експорт (exportDocx.js) підставить виноску не того джерела.
// pagePicker(newN, occurrence) — необов'язковий вибір сторінки за змістом PDF
// (contentPages.js); occurrence рахується так само, як тут: по кожному елементу
// позначки, в порядку появи, окремо для кожного newN у межах цього тексту.
export function applyCitationRemap(text, oldToNew, refCiteText, { pageRanges = {}, pageAbbrev = "с.", pagePicker = null } = {}) {
  if (!text) return text;
  const citCount = {};
  const pageFor = (newN, modelPage) => {
    citCount[newN] = (citCount[newN] || 0) + 1;
    const range = pageRanges[newN];
    if (!range) return null;
    const inRange = p => p != null && p >= range.min && p <= range.max;
    const picked = pagePicker ? pagePicker(newN, citCount[newN]) : null;
    if (inRange(picked)) return picked;
    if (inRange(modelPage)) return modelPage;
    return pickPageInRange(range, citCount[newN]);
  };
  let out = replaceCitationBrackets(text, items => {
    const mapped = [];
    for (const it of items) {
      const newN = oldToNew[it.n];
      if (!newN || mapped.some(m => m.n === newN)) continue;
      mapped.push({ n: newN, page: pageFor(newN, it.page ?? null) });
    }
    if (!mapped.length) return ""; // усі номери хибні (галюциновані) — прибираємо
    return formatCitationGroup(mapped, refCiteText, pageAbbrev);
  });
  out = out.replace(/%%FN(\d+)%%/g, (_, oldNStr) => {
    const newN = oldToNew[Number(oldNStr)];
    return newN ? `%%FN${newN}%%` : ""; // джерело видалено — прибираємо маркер виноски
  });
  // Видалена позначка (хибний номер чи виноска видаленого джерела) лишає "висячий"
  // пробіл перед сусідньою пунктуацією ("...стану [1]." → "...стану ."). Прибираємо
  // такий пробіл — у валідному тексті пробіл перед крапкою/комою ніколи не потрібен.
  out = out.replace(/ +([.,;:!?])/g, "$1");
  return out;
}

// ── Обмежує кількість повторних цитувань одного джерела в тексті (локальна
// нумерація [N], до фінального ремапу стилю) — модель не завжди дотримується
// ліміту "не більше N разів", заданого лише текстом промпту, тож рахунок і
// обрізання зайвих повторів примусово виконує код. Групові цитати лишає як є,
// прибираючи з групи лише номери, що вже вичерпали ліміт — весь маркер
// видаляється лише якщо вичерпані всі номери в ньому. ──
export function capCitationRepeats(text, maxRepeats = 2) {
  if (!text) return text;
  const counts = {};
  let out = replaceCitationBrackets(text, (items, whole) => {
    const kept = items.filter(it => {
      counts[it.n] = (counts[it.n] || 0) + 1;
      return counts[it.n] <= maxRepeats;
    });
    if (!kept.length) return "";
    if (kept.length === items.length) return whole;
    return rebuildBracket(kept);
  });
  out = out.replace(/ +([.,;:!?])/g, "$1");
  return out;
}

// ── Звірка змісту відформатованої відповіді ЛЛМ із вхідним списком ──

// Витягує "ідентифікаційні" токени (4+ символів) з рядка джерела для звірки змісту.
function sourceTokens(s) {
  return new Set((String(s).toLowerCase().match(/[a-zа-яґєіїʼ'0-9-]{4,}/g) || []));
}

function matchScore(tokenSet, text) {
  if (!tokenSet.size) return 1; // нема за чим звіряти — вважаємо збіг
  const lower = text.toLowerCase();
  let hits = 0;
  tokenSet.forEach(t => { if (lower.includes(t)) hits++; });
  return hits / tokenSet.size;
}

const dedupeNormalize = str => str.toLowerCase()
  .replace(/\s*(url\s*:|https?:\/\/\S+|\(дата звернення[^)]*\))/gi, "")
  .replace(/[.,;:&–—\-«»"'()[\]]/g, "").replace(/\s+/g, " ").trim();

// DOI — найнадійніший ключ дублікату: те саме джерело, додане двічі різними шляхами
// (напр. з двох різних пошукових фраз чи структурованим і сирим записом), часто
// відрізняється формулюванням/порядком полів настільки, що dedupeNormalize(text) дає
// РІЗНІ рядки для того самого запису — і дублікат не ловиться (виявляється лише
// візуально в готовому списку, вже ПІСЛЯ того, як ЛЛМ причесала обидва до однакового
// вигляду за стилем). DOI у складі URL — стабільний ідентифікатор, не залежить від
// форматування навколишнього тексту.
const DOI_RE = /\b10\.\d{4,9}\/[^\s"'<>]+/i;
const extractDoiKey = text => {
  const m = String(text).match(DOI_RE);
  return m ? m[0].replace(/[).,;\]]+$/, "").toLowerCase() : null;
};

// URL — другий за надійністю ключ (після DOI): те саме джерело з різним форматуванням
// довколишнього тексту (порядок авторів, наявність venue/сторінок) часто веде на ту саму
// сторінку. Нормалізуємо лише "шумову" частину — регістр, кінцевий слеш, #fragment
// (напр. #page=330 з PDF-читалки) — query-параметри лишаємо як є, бо вони бувають
// значущими ідентифікаторами (напр. ?id=35564).
const URL_RE = /https?:\/\/\S+/i;
const extractUrlKey = text => {
  const m = String(text).match(URL_RE);
  if (!m) return null;
  return m[0]
    .replace(/[).,;\]]+$/, "")
    .replace(/#.*$/, "")
    .replace(/\/$/, "")
    .toLowerCase();
};

// Обчислює ключ дублікату для одного тексту джерела: DOI → URL → нормалізований текст.
export function computeDedupKey(text) {
  return extractDoiKey(text) || extractUrlKey(text) || dedupeNormalize(text);
}

// Дедуплікатор сирих текстів джерел: збіг за DOI, інакше за URL, інакше за
// нормалізованим текстом. add(text) — ідемпотентний: повторний виклик із уже відомим
// текстом повертає ІНДЕКС того самого канонічного запису, не додає новий.
// canonicalRefs — унікальні тексти (довший/з URL варіант лишається як канонічний).
export function createReferenceDeduper() {
  const canonicalRefs = [];
  const seenKeys = new Map(); // ключ (DOI, URL або нормалізований текст) → індекс у canonicalRefs

  function add(text) {
    const key = computeDedupKey(text);
    const hasUrl = /https?:\/\/\S+/i.test(text);
    if (seenKeys.has(key)) {
      const idx = seenKeys.get(key);
      if (hasUrl && !/https?:\/\/\S+/i.test(canonicalRefs[idx])) canonicalRefs[idx] = text;
      return idx;
    }
    canonicalRefs.push(text);
    seenKeys.set(key, canonicalRefs.length - 1);
    return canonicalRefs.length - 1;
  }

  return { canonicalRefs, add };
}

// Зіставляє відформатовані рядки з вхідними ЗА ЗМІСТОМ (не за позицією) — формат і
// пунктуація змінюються, а автори/назва/рік мають лишитись впізнаваними. Жадібний
// найкращий-збіг-спершу підбір пар (i, j) за оцінкою перетину токенів. Повертає
// matchedIndex, де matchedIndex[i] — позиція в styledLines, що відповідає refLines[i],
// або null, якщо для когось не знайшлось впевненого унікального відповідника
// (галюцинація/пропуск/дублікат/переставляння від ЛЛМ — усе це заборонено).
function matchFormattedLines(refLines, styledLines) {
  const n = refLines.length;
  if (styledLines.length !== n) return null;
  const tokenSets = refLines.map(sourceTokens);
  const pairs = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) pairs.push({ i, j, score: matchScore(tokenSets[i], styledLines[j]) });
  }
  pairs.sort((a, b) => b.score - a.score);
  const matchedIndex = new Array(n).fill(-1);
  const usedJ = new Set();
  let assigned = 0;
  for (const { i, j, score } of pairs) {
    if (matchedIndex[i] !== -1 || usedJ.has(j)) continue;
    if (tokenSets[i].size > 0 && score < 0.3) continue; // недостатньо впевнено
    matchedIndex[i] = j; usedJ.add(j); assigned++;
    if (assigned === n) break;
  }
  return assigned === n ? matchedIndex : null;
}

// Фільтрує сиру відповідь ЛЛМ-форматування списку джерел до валідних пронумерованих
// рядків ("N. текст"), перевіряє їх кількість і зіставляє кожен з вхідним джерелом за
// ЗМІСТОМ (matchFormattedLines) — не за позицією, бо самої лише позиції недостатньо,
// щоб надійно відрізнити "ЛЛМ просто трохи перефразувала" від "ЛЛМ підмінила джерело".
// Якщо для когось не знайшлось впевненого унікального відповідника — це або
// преамбула/примітка, або вигадане/загублене джерело, або зіпсована/переставлена
// нумерація (усе це заборонено промптом); довіряти відповіді не можна.
// Повертає масив у порядку refLines (без права переставляти) або null.
export function sanitizeFormattedSourceLines(fmtResult, refLines) {
  if (!fmtResult) return null;
  const lines = fmtResult.split("\n").map(l => l.trim()).filter(l => /^\d+[.)]\s/.test(l));
  if (lines.length !== refLines.length) return null;
  const stripped = lines.map(l => l.replace(/^\d+[.)]\s*/, ""));
  const matchedIndex = matchFormattedLines(refLines, stripped);
  if (!matchedIndex) return null;
  return matchedIndex.map(j => stripped[j]);
}

// ── Детерміноване (кодове) визначення групи/мови джерела для сортування ──

// Реальний бібліографічний запис нормативного акта за ДСТУ 8302:2015 зазвичай
// НЕ починається зі слова "закон"/"кодекс" — спочатку йде повна назва акта, а тип
// документа стоїть після двокрапки: "Про запобігання корупції : Закон України від…",
// "Кримінальний процесуальний кодекс України : Кодекс України від…". Старий варіант
// (анкорований лише на позицію 0) пропускав саме цей, найпоширеніший, запис —
// ловив тільки рідкісний випадок, коли тип документа стоїть першим словом.
// ВАЖЛИВО: \w у JS-регексах — це лише [A-Za-z0-9_], кирилицю він НЕ охоплює. Тому
// суфікс після кириличної основи ловимо класом [а-яіїєґ]*, а не \w* (\w* після
// кириличного стему просто мовчки матчить 0 символів і "\b" одразу за ним ніколи
// не спрацьовує між двома кириличними літерами — обидві сторони "не-\w").
const CYR = "а-яіїєґ";
const LAW_RE = new RegExp(`^(закон[${CYR}]*|кодекс[${CYR}]*|конституці[${CYR}]*|конвенці[${CYR}]*)`, "i");
const LAW_AFTER_COLON_RE = new RegExp(`:\\s*(закон[${CYR}]*|кодекс[${CYR}]*|конституці[${CYR}]*|указ[${CYR}]*|постанов[${CYR}]*|декрет[${CYR}]*|розпорядженн[${CYR}]*|конвенці[${CYR}]*)\\s+[А-ЯЇІЄҐ]`, "i");
const NAMED_CODE_RE = new RegExp(`(кримінальн[${CYR}]*|цивільн[${CYR}]*|господарськ[${CYR}]*|сімейн[${CYR}]*|земельн[${CYR}]*|податков[${CYR}]*|бюджетн[${CYR}]*|митн[${CYR}]*|виборч[${CYR}]*|повітрян[${CYR}]*|водн[${CYR}]*|лісов[${CYR}]*|адміністративн[${CYR}]*)(\\s+процесуальн[${CYR}]*)?\\s+кодекс[${CYR}]*\\s+україни`, "i");
export const isLawSource = s => {
  const t = s.trim();
  return LAW_RE.test(t) || LAW_AFTER_COLON_RE.test(t) || NAMED_CODE_RE.test(t);
};

// Переважання кириличних чи латинських літер У ВСЬОМУ рядку — а не лише перший
// символ. Короткий латинський префікс на кшталт "ISSN 2409-1154" не повинен
// перетягувати переважно українське джерело в іноземну групу.
export function isMostlyCyrillic(text) {
  const cyr = (text.match(/[А-ЯҐЄІЇа-яґєії]/g) || []).length;
  const lat = (text.match(/[A-Za-z]/g) || []).length;
  return cyr >= lat;
}

// Мова джерела для угруповання ДСТУ визначається за ПІБ автора — першим словом
// запису (прізвище, бо на цьому етапі текст уже відформатовано "Прізвище І. І."),
// а НЕ за всім рядком: інакше джерело з українським автором, але з англомовною
// цитованою назвою чи установою в описі (наприклад, переклад іноземного документа),
// хибно потрапляє в іноземну групу через саму лише кількість латинських літер у
// назві. Джерела без автора (починаються з назви) класифікуються за мовою самої
// назви — тим самим першим словом.
function isForeignAuthorScript(text) {
  const m = text.trim().match(/^[«"']?([A-Za-zА-ЯҐЄІЇа-яґєії]+)/);
  if (!m) return false;
  const word = m[1];
  const lat = (word.match(/[A-Za-z]/g) || []).length;
  const cyr = (word.match(/[А-ЯҐЄІЇа-яґєії]/g) || []).length;
  return lat > cyr;
}

// Чи це "електронний ресурс" (сайт/сторінка без чіткої журнальної/книжкової
// структури) на противагу книзі/статті. Найнадійніше — за структурованими даними
// (є journal/volume/сторінки чи _docType:"book" → це НЕ електронний ресурс); для
// сирого тексту без структури — евристика за наявністю номера випуску/сторінок.
export function isElectronicResource(text, structuredPaper) {
  if (structuredPaper) {
    if (structuredPaper._docType === "book" || structuredPaper.journal || structuredPaper.pages || structuredPaper.volume || structuredPaper.issue) return false;
    return true;
  }
  const hasIssueOrPages = /№\s*\d+|Вип\.\s*\d+|Т\.\s*\d+|[Сс]\.\s*\d+/i.test(text);
  const hasUrl = /https?:\/\/\S+/i.test(text);
  return hasUrl && !hasIssueOrPages;
}

// Мовний порядок ("хто першим — укр чи іноземні") зі structured-поля sourcesGrouping
// методички ("спочатку українські, потім англійські…"). Повертає true, якщо
// методичка явно вимагає іноземні/латиницю ПЕРШИМИ, false — якщо явно вимагає
// українські першими, null — якщо методички/поля немає, чи текст не вказує порядок
// прямо (тоді вирішує мова самої роботи, див. виклик у buildFinalReferenceList).
function detectForeignFirstFromGrouping(sourcesGrouping) {
  const s = (sourcesGrouping || "").trim();
  if (!s) return null;
  const FOREIGN = "(іноземн\\w*|англ\\w*|латин\\w*|зарубіжн\\w*|польськ\\w*|нім\\w*|французьк\\w*)";
  const UKR = "(укр\\w*|кирил\\w*)";
  const POS = "(спочатку|першими|на\\s+початку)";
  const foreignFirst = new RegExp(`${FOREIGN}[^.]{0,40}${POS}`, "i").test(s) || new RegExp(`${POS}[^.]{0,40}${FOREIGN}`, "i").test(s);
  const ukrFirst = new RegExp(`${UKR}[^.]{0,40}${POS}`, "i").test(s) || new RegExp(`${POS}[^.]{0,40}${UKR}`, "i").test(s);
  if (foreignFirst && !ukrFirst) return true;
  if (ukrFirst && !foreignFirst) return false;
  return null;
}

// Вирішує, яке СТРУКТУРНЕ групування застосувати до списку джерел. Закони окремо
// (lawFirst) і друковані/електронні окремо (typeGroup) — ЛИШЕ за явним сигналом з
// методички (sourcesFormatRules), інакше "алфавіт" в UI обіцяє одне, а фактичний
// список виглядає невпорядкованим для студента.
// Мовне групування (foreignGroup: кирилиця/латиниця окремими блоками) — УВІМКНЕНЕ
// ЗАВЖДИ: єдиного природного алфавітного порядку між кирилицею й латиницею не існує
// (localeCompare для різних абеток непослідовний між парами рядків), тож без поділу
// на блоки суцільний список виглядає хаотично навіть за коректно працюючого
// сортування. Порядок блоків (укр/латиниця першими) — з detectForeignFirstFromGrouping
// (сигнал sourcesGrouping методички), якщо методичка не каже прямо — вирішує мова
// самої роботи (латиниця першою лише для роботи, написаної іноземною мовою).
// Чи методичка явно вимагає ДВА ПІДПИСАНИХ розділи списку джерел — "І. Нормативна
// література" / "ІІ. Спеціальна література" (типове формулювання ДСТУ 8302:2015
// для юридичних робіт), а не просто "закони спочатку" без заголовків. Це формулювання
// зазвичай НЕ містить слів "спочатку/першими/окремо/перед", на які зважає lawFirst
// нижче (напр. "І. Нормативна література (…); ІІ. Спеціальна література (…)"), тому
// потребує окремого, прямого розпізнавання за назвами обох розділів.
export function needsNormativeSectionHeaders(sourcesFormatRules) {
  const rules = sourcesFormatRules || "";
  return new RegExp(`нормативн[${CYR}]*\\s+літератур[${CYR}]*`, "i").test(rules)
    && new RegExp(`спеціальн[${CYR}]*\\s+літератур[${CYR}]*`, "i").test(rules);
}

export function detectSourceGrouping({ sourcesFormatRules, sourcesGrouping } = {}) {
  const rules = sourcesFormatRules || "";
  const lawFirst = needsNormativeSectionHeaders(rules)
    || /(закон\w*|кодекс\w*|нормативн\w*|законодавч\w*)[^.]{0,50}(спочатку|першими|на\s+початку|окрем\w*|перед)/i.test(rules)
    || /(спочатку|першими|на\s+початку)[^.]{0,50}(закон\w*|кодекс\w*|нормативн\w*|законодавч\w*)/i.test(rules);
  const typeGroup = /(друкован\w*|книг\w*|статт\w*)[^.]{0,80}(електрон\w*\s*ресурс\w*)/i.test(rules)
    || /(електрон\w*\s*ресурс\w*)[^.]{0,80}(друкован\w*|книг\w*|статт\w*)/i.test(rules);
  const foreignFirst = detectForeignFirstFromGrouping(sourcesGrouping);
  return { lawFirst, typeGroup, foreignGroup: true, foreignFirst };
}

// Сортує вже ВІДФОРМАТОВАНИЙ (прізвище спереду) список джерел. Кирилиця й латиниця
// завжди окремими блоками (foreignGroup — вмикається завжди у detectSourceGrouping),
// закони/тип-ресурсу — лише якщо методичка про них явно каже. Групи ДСТУ 8302:2015:
// закони → кирилиця книги/статті → кирилиця електронні ресурси → іноземні
// (латиниця) для роботи українською мовою; або закони → іноземні → кирилиця
// книги/статті → кирилиця електронні ресурси для іноземної роботи.
// Оскільки group — детермінована функція саме від isForeignAuthorScript(item.text)
// (жоден інший прапорець не змішує foreign=true й foreign=false в одну group), у
// межах одного group завжди РІВНО одна мовна абетка, тож locale(a.item) нижче
// лишається сталим для всіх пар усередині group — localeCompare порівнює послідовно
// (не "стрибає" між "uk"/"en" залежно від того, хто з пари випадково опинився "a" —
// саме такий стрибок і ламав сортування раніше, коли group ще не гарантував це).
// items: [{ text, structured }]
export function sortReferencesForDisplay(items, { latinFirst = false, grouping = {} } = {}) {
  const { lawFirst = false, typeGroup = false, foreignGroup = false } = grouping;
  const groupOf = (item) => {
    if (lawFirst && isLawSource(item.text)) return 0;
    const foreign = foreignGroup && isForeignAuthorScript(item.text);
    if (foreign) return latinFirst ? 1 : 3;
    const electronic = typeGroup && isElectronicResource(item.text, item.structured);
    return latinFirst ? (electronic ? 3 : 2) : (electronic ? 2 : 1);
  };
  const locale = (item) => isForeignAuthorScript(item.text) ? "en" : "uk";
  return items
    .map((item, idx) => ({ item, idx, group: groupOf(item) }))
    .sort((a, b) => a.group !== b.group ? a.group - b.group : a.item.text.localeCompare(b.item.text, locale(a.item)))
    .map(x => x.item);
}

// Збирає фінальний пронумерований текст списку джерел. Коли needsHeaders — вставляє
// "І. Нормативна література" / "ІІ. Спеціальна література" перед відповідною групою,
// але нумерація лишається НАСКРІЗНОЮ через обидва розділи (позначки [N] у тексті
// показують на позицію в єдиному списку, а не на позицію всередині розділу).
// refs МАЄ бути вже відсортований (закони — групою 0, sortReferencesForDisplay) —
// ця функція лише вставляє заголовки в точці зміни групи, самої сортування не робить.
// Якщо серед refs немає жодного нормативного акта — "І." не друкується взагалі,
// а "ІІ." виводиться перед самим першим записом: прогалину видно одразу, а не ховає.
export function assembleSourcesText(refs, needsHeaders = false) {
  if (!needsHeaders) return refs.map((r, i) => `${i + 1}. ${r}`).join("\n");
  const lines = [];
  let printedLaw = false, printedSpecial = false;
  refs.forEach((text, i) => {
    const law = isLawSource(text);
    if (law && !printedLaw) { lines.push("І. Нормативна література"); printedLaw = true; }
    if (!law && !printedSpecial) { lines.push("ІІ. Спеціальна література"); printedSpecial = true; }
    lines.push(`${i + 1}. ${text}`);
  });
  return lines.join("\n");
}

// Будує правила стилю (ДСТУ/APA/MLA) + промпт форматування списку джерел, викликає
// ЛЛМ і валідує відповідь (sanitizeFormattedSourceLines). ЛЛМ переформатовує КОЖНЕ
// джерело окремо (пунктуація, порядок ініціалів, курсив тощо) — сортування й
// групування завжди робить код (sortReferencesForDisplay) ПІСЛЯ форматування, ЛЛМ
// ніколи не переставляє рядки. (Раніше довіра до "кастомного групування з
// методички" вмикалась майже завжди — типова методичка просто згадує стандартну
// вимогу "за алфавітом", і ЛЛМ, отримавши нечітку вказівку, часто взагалі нічого
// не переставляла, лишаючи список невідсортованим. Вимкнено, поки не буде
// надійнішого способу відрізнити справді нестандартну вимогу від типової.)
export async function formatSourcesViaLLM({
  refLines,             // string[] — вже побудовані рядки "N. ..." (raw text або JSON structured)
  sourcesStyle,         // "APA" | "MLA" | "ДСТУ 8302:2015"
  sourcesFormatRules,   // methodInfo?.sourcesFormatRules
  callClaude,
}) {
  const isAPA = sourcesStyle === "APA";
  const isMLA = sourcesStyle === "MLA";
  const isDstu = !isAPA && !isMLA;

  const today = new Date();
  const accessDate = `${String(today.getDate()).padStart(2, "0")}.${String(today.getMonth() + 1).padStart(2, "0")}.${today.getFullYear()}`;

  const orderInstruction = "НЕ переставляй рядки місцями, НЕ додавай і НЕ вилучай джерела — кожен вхідний рядок N має стати рівно одним вихідним рядком на позиції N (сортування й групування виконає код окремо, після твого форматування).";

  const styleRules = isAPA
    ? `СТИЛЬ: APA 7th edition. СУВОРО дотримуйся APA — НЕ змішуй з ДСТУ чи іншими стилями.
Правила APA:
- Книга: Прізвище, І. І. (рік). Назва книги курсивом. Видавець.
- Стаття: Прізвище, І. І. (рік). Назва статті. Назва журналу курсивом, том(номер), сторінки. https://doi.org/...
- Розділ у збірнику: Прізвище, І. І. (рік). Назва розділу. В І. І. Редактор (Ред.), Назва збірника (сс. xx–xx). Видавець.
- Онлайн-ресурс: Прізвище, І. І. (рік). Назва. Назва сайту. URL
- НЕ використовуй двокрапку між містом і видавцем (це ДСТУ, не APA).
- НЕ пиши "Київ:" або "Oxford:" перед видавцем (APA не вказує місто для більшості джерел після 7-го вид.).
- НЕ додавай "Вип.", "Т.", "С." у журнальних статтях — використовуй том і сторінки у форматі APA.
- ОБОВ'ЯЗКОВО: якщо автор вказаний як "Ім'я Прізвище" (ім'я першим) — переставляй у "Прізвище, І." (прізвище першим, ім'я скорочується до ініціалу). Це вимога APA, не зміна імені.
  Українські імена (перші слова, що НЕ є прізвищами): Олеся, Оксана, Тетяна, Наталія, Наталя, Марія, Ірина, Олена, Світлана, Валентина, Людмила, Галина, Ніна, Лариса, Юлія, Анна, Катерина, Вікторія, Андрій, Олег, Микола, Василь, Іван, Петро, Сергій, Олексій, Михайло, Дмитро, Юрій, Владислав, Богдан, Роман, Тарас, Євген. Якщо джерело починається з такого слова — це ім'я, і наступне слово є прізвищем; переставляй: "Олеся Коваль" → "Коваль, О."; "Тетяна Петренко" → "Петренко, Т."
- Назви джерел: sentence case (перша літера велика, решта малі, окрім власних назв та абревіатур). Якщо назва написана ВЕЛИКИМИ ЛІТЕРАМИ — обов'язково переводь у sentence case.`
    : isDstu
      ? `СТИЛЬ: ДСТУ 8302:2015. СУВОРО дотримуйся ДСТУ — НЕ змішуй з APA чи іншими стилями.
Правила ДСТУ 8302:2015:
- Книга: Прізвище І. І. Назва книги. Місто : Видавець, рік. Кількість с.
- Стаття: Прізвище І. І. Назва статті. *Назва журналу*. рік. № номер. С. xx–xx.
- Онлайн: Прізвище І. І. Назва. *Назва сайту або журналу*. URL: адреса (дата звернення: ${accessDate}).
- КАТЕГОРИЧНО ЗАБОРОНЕНО ставити ініціали ПЕРЕД прізвищем. НЕ "В. Андріяш" — лише "Андріяш В.". Ініціали ЗАВЖДИ після прізвища.
- Між ініціалами — пробіл: "М. В." а не "М.В.".
- Між містом і видавцем — пробіл двокрапка пробіл ( : ).
- КУРСИВ: назву журналу, збірника, серії або сайту ОБОВ'ЯЗКОВО обгортай в *зірочки* (*Назва журналу*). Назву статті та прізвища авторів — звичайний шрифт.`
      : `СТИЛЬ: ${sourcesStyle}. Точно дотримуйся цього стилю.`;

  const methodSourcesRulesText = sourcesFormatRules ? `\nВИМОГИ МЕТОДИЧКИ ДО СПИСКУ ДЖЕРЕЛ: ${sourcesFormatRules}` : "";

  const fmtPrompt = `${styleRules}
${orderInstruction}${methodSourcesRulesText}
Збережи номери. Поверни ТІЛЬКИ список без заголовка. Для онлайн-джерел додай URL (дата звернення: ${accessDate}), АЛЕ ЛИШЕ якщо цей URL явно присутній у вхідних даних джерела (поле "url" у JSON або адреса http(s):// у сирому тексті рядка). Якщо URL немає — НЕ вигадуй його і не підставляй замість нього якесь інше число чи ідентифікатор із запису (наприклад, рік чи DOI-суфікс): просто випусти частину "URL: ..." для цього джерела. НЕ використовуй "[Електронний ресурс]".

ФОРМАТ ВХІДНИХ ДАНИХ: кожен рядок — або JSON-об'єкт (_type:"structured") або сирий текст.
Для JSON (_type:"structured"):
- authors: [{family:"Прізвище", given:"Ім'я"}] → форматуй як "Прізвище І." (перша літера given). НЕ перекладай і НЕ транслітеруй.
- authorsRaw: масив рядків → нормалізуй порядок (прізвище перед ініціалами), додай крапки після ініціалів.
- journal + volume + issue → для ДСТУ: "Назва журналу. рік. Вип. N, № M. С. xx–xx."
- _docType:"book" → це монографія/книга (Місто : Видавець, рік. Nс., де N — totalPages якщо є)
Для сирого тексту: нормалізуй порядок слів і розділові знаки за вимогами стилю.
КРИТИЧНО: НЕ перекладай і НЕ транслітеруй прізвища авторів та назви джерел — не вигадуй переклад чи іноземний варіант того, що подано мовою оригіналу. Переведення ВЕЛИКИХ ЛІТЕР у sentence case — дозволено і обов'язково.
ОКРЕМИЙ ВИНЯТОК (це виправлення АБЕТКИ, а не перекладу): якщо в ОДНОМУ записі прізвища авторів подані РІЗНИМИ абетками (частина кирилицею, частина латиницею — типовий артефакт автоімпорту з OpenAlex/CrossRef, напр. "Savchuk I., Лисецька Ю. В., Савчук О. Р."), приведи латиничне прізвище до кирилиці за стандартною українською транслітерацією, щоб усі автори запису були однією абеткою (тут — "Савчук І."). Так само якщо ВЕСЬ запис українською (назва, журнал кириличні), а прізвище єдиного автора дано лише латиницею через той самий артефакт бази — теж поверни його кирилицею. Якщо є сумнів, що прізвище насправді іноземне (не українське/не транслітероване) — НЕ чіпай його.

${refLines.join("\n")}`;

  const systemPrompt = `Ти — асистент з бібліографічного форматування. Форматуй джерела строго за стилем ${sourcesStyle}. Не змішуй стилі цитування. Не перекладай і не транслітеруй прізвища авторів та назви джерел — зберігай мову оригіналу (українські джерела — українською, англійські — англійською). Виняток: якщо в одному записі співавтори подані різними абетками (частина кирилицею, частина латиницею — артефакт автоімпорту з баз даних), приведи латиничне до кирилиці, щоб абетка була єдиною в межах запису. Перестав компоненти імені відповідно до вимог стилю (для APA: "Ім'я Прізвище" → "Прізвище, І."). Назви повністю ВЕЛИКИМИ ЛІТЕРАМИ переводь у sentence case. Повертай тільки відформатований список, без зайвого тексту.`;

  let fmtResult;
  try {
    fmtResult = await callClaude([{ role: "user", content: fmtPrompt }], null, systemPrompt, 16000);
  } catch (e) { console.error("sources format error:", e); }

  return sanitizeFormattedSourceLines(fmtResult, refLines);
}

// Форматує список джерел через ЛЛМ з автоматичним відновленням: якщо відповідь не
// пройшла валідацію (ЛЛМ зсунула/вигадала/загубила джерело), замість відкидання
// ВСЬОГО списку ділимо його навпіл і пробуємо кожну половину окремо, рекурсивно, поки
// не ізолюємо конкретний проблемний фрагмент (у гіршому випадку — одне джерело, яке
// тоді лишається без стильового форматування, а решта — акуратно оформлена).
// У звичайному (успішному) випадку це один виклик на весь список — без подорожчання.
// Повертає масив рядків у ТОМУ Ж порядку, що й rawRefs (ЛЛМ ніколи не переставляє).
export async function formatSourcesWithRetry({
  rawRefs, findStructured, sourcesStyle, sourcesFormatRules, callClaude,
}) {
  if (!rawRefs.length) return [];

  const refLines = rawRefs.map((r, i) => {
    const sp = findStructured(r);
    return sp ? `${i + 1}. ${JSON.stringify(buildStructuredEntry(sp))}` : `${i + 1}. ${normalizeAuthorScriptInRawLine(r)}`;
  });

  const sanitized = await formatSourcesViaLLM({ refLines, sourcesStyle, sourcesFormatRules, callClaude });
  if (sanitized) return sanitized;

  if (rawRefs.length === 1) {
    // Нема куди ділити далі — лишаємо сирий текст як є, без стильового форматування.
    return [rawRefs[0]];
  }

  const mid = Math.ceil(rawRefs.length / 2);
  const [left, right] = await Promise.all([
    formatSourcesWithRetry({ rawRefs: rawRefs.slice(0, mid), findStructured, sourcesStyle, sourcesFormatRules, callClaude }),
    formatSourcesWithRetry({ rawRefs: rawRefs.slice(mid), findStructured, sourcesStyle, sourcesFormatRules, callClaude }),
  ]);
  return [...left, ...right];
}

// Джерела, зібрані до виправлення розбору Google Scholar (24.09.2026), мають замість
// журналу домен сайту чи обрізану назву. Перед оформленням списку пробуємо взяти повну
// назву зі сторінки статті (мета-теги citation_journal_title / DC.Source) — інакше журнал
// просто не пишемо: краще без назви, ніж "Актуальні питання …". Повертає Map
// (оригінальний запис → копія з назвою журналу), самі записи не змінює.
async function repairMissingVenues(papers, fetchMeta) {
  const repaired = new Map();
  const todo = [...new Set(papers.filter(p => p?.url && p.type !== "book" && p.source !== "institutional" && isBadVenue(p.venue)))];
  await Promise.all(todo.map(async p => {
    try {
      const meta = await fetchMeta(p.url);
      if (meta?.journal && !isBadVenue(meta.journal)) repaired.set(p, { ...p, venue: cleanMetaText(meta.journal) });
    } catch { /* без назви журналу — як є */ }
  }));
  return repaired;
}

// Будує фінальний (відформатований і відсортований) список джерел та мапу
// "індекс у rawRefs (дедуплікований сирий список, у порядку першої появи) →
// фінальний номер у списку". Порядок: форматування (formatSourcesWithRetry, без
// права переставляти) → сортування кодом на вже правильно оформленому тексті
// (sortReferencesForDisplay).
export async function buildFinalReferenceList({
  rawRefs, findStructured: findStructuredRaw, sourcesStyle, isLatinWork, sourcesFormatRules, sourcesGrouping, callClaude,
  skipSort = false, // true → зберегти порядок першої появи (обрано "порядок появи", не алфавітний; актуально лише для APA/MLA — ДСТУ завжди алфавітний)
  fetchMeta = fetchUrlMeta, // лише для тестів — підміна запиту до сторінки статті
}) {
  if (!rawRefs.length) return { finalTexts: [], indexMap: [] };

  const repaired = await repairMissingVenues(rawRefs.map(findStructuredRaw), fetchMeta);
  const findStructured = ref => {
    const sp = findStructuredRaw(ref);
    return (sp && repaired.get(sp)) || sp;
  };

  const formatted = await formatSourcesWithRetry({ rawRefs, findStructured, sourcesStyle, sourcesFormatRules, callClaude });
  // ЛЛМ оформлює пунктуацію, а сторінки — дані: що було в сирому рядку, те має
  // лишитись і у відформатованому (загублене чи змінене повертає код)
  const byInputOrder = formatted.map((text, i) => restoreLostPages(rawRefs[i], text, sourcesStyle));

  let finalTexts, rawIdxOfFinal;
  if (skipSort) {
    finalTexts = byInputOrder;
    rawIdxOfFinal = byInputOrder.map((_, i) => i);
  } else {
    const items = byInputOrder.map((text, i) => ({ text, structured: findStructured(rawRefs[i]), rawIdx: i }));
    const grouping = detectSourceGrouping({ sourcesFormatRules, sourcesGrouping });
    // Порядок блоків: якщо методичка явно каже (grouping.foreignFirst) — за нею,
    // інакше — за мовою самої роботи (isLatinWork).
    const latinFirst = grouping.foreignFirst ?? isLatinWork;
    const sortedItems = sortReferencesForDisplay(items, { latinFirst, grouping });
    finalTexts = sortedItems.map(it => it.text);
    rawIdxOfFinal = sortedItems.map(it => it.rawIdx);
  }

  const indexMap = new Array(rawRefs.length);
  rawIdxOfFinal.forEach((rawIdx, finalPos) => { indexMap[rawIdx] = finalPos + 1; });
  return { finalTexts, indexMap };
}

// Вставляє в текст підрозділу позначки джерел, які були йому призначені, але не
// потрапили в текст природним шляхом (під час першої генерації чи фінального
// проходу doRemapCitations) — ОДНИМ пакетним викликом ШІ на весь підрозділ
// (buildCitationInsertPrompt: ШІ лише вказує "яке речення" + "з доданою
// позначкою"), замість окремого виклику на кожне джерело й замість переписування
// підрозділу цілком. Якщо ШІ визнала, що жодне речення джерело не підтверджує
// ("match": false), або вказала фрагмент неточно і locateFragment його не знайшов —
// джерело НЕ вставляється (жодної хибної прив'язки "за темою"), а лишається в
// unresolved, щоб виклик спробував знайти заміну (retryUnmatchedSource) або, як
// останній варіант, лишити користувачу попередження.
export async function insertMissingCitations({ sectionText, insertions, lang, callClaude, signal }) {
  if (!insertions.length) return { text: sectionText, unresolved: [] };
  const maxTokens = Math.min(8000, Math.max(1500, insertions.length * 400));
  let raw;
  try {
    raw = await callClaude(
      [{ role: "user", content: buildCitationInsertPrompt({ sectionText, insertions, lang }) }],
      signal || null, "Ти — редактор академічного тексту. Повертай лише JSON, без пояснень.", maxTokens,
    );
  } catch (e) { console.error("insertMissingCitations error:", e); }

  let parsed = [];
  try {
    const jsonMatch = raw?.match(/\[[\s\S]*\]/);
    parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : [];
  } catch { /* нижче — фолбек для всіх пунктів */ }

  let text = sectionText;
  const unresolved = [];
  insertions.forEach((ins, i) => {
    const item = parsed.find(p => p.index === i);
    const hasMatch = item && item.match !== false && item.original;
    const loc = hasMatch ? locateFragment(text, item.original, null) : null;
    if (loc && item.replacement) {
      text = text.slice(0, loc.start) + item.replacement + text.slice(loc.end);
    } else {
      unresolved.push(ins.number);
    }
  });
  return { text, unresolved };
}

// Дістає з бібліографічного опису прізвище автора (+ рік для APA) і формує текст
// внутрітекстової цитати "(Автор, Рік)" / "(Автор)". Винесено окремо від buildCiteFormats,
// бо ця сама логіка потрібна і для того, щоб порахувати, як цитата виглядала для ВЖЕ
// ВИДАЛЕНОГО джерела (щоб потім знайти й прибрати саме її з тексту — applySourcesRestructure
// в academic-assistant.jsx).
export function apaOrMlaCiteText(ref, n, { isAPA, isMLA }) {
  const commaIdx = ref.indexOf(",");
  const beforeComma = commaIdx > 0 ? ref.substring(0, commaIdx).trim() : "";
  if (isAPA) {
    let rawAuthor;
    if (beforeComma && !beforeComma.includes(" ") && beforeComma.length >= 3) {
      rawAuthor = beforeComma;
    } else {
      const surnameMatch = ref.match(/(?:^|[\s,&])([А-ЯҐЄІЇа-яґєіїA-Za-z]{3,})/);
      rawAuthor = surnameMatch?.[1] || `Автор${n}`;
    }
    const yearMatch = ref.match(/[(.\s](\d{4})[).,\s]/);
    const author = rawAuthor.charAt(0).toUpperCase() + rawAuthor.slice(1).toLowerCase();
    const year = yearMatch?.[1] || null;
    const noYearLabel = isMostlyCyrillic(ref) ? "б.р." : "n.d.";
    return { text: `(${author}, ${year || noYearLabel})`, author, year };
  }
  if (isMLA) {
    const rawSurname = (beforeComma && !beforeComma.includes(" "))
      ? beforeComma
      : ref.match(/(?:^|[\s,])([А-ЯҐЄІЇа-яґєіїA-Za-z]{3,})/)?.[1];
    const author = rawSurname || `Автор${n}`;
    return { text: `(${author})`, author, year: null };
  }
  return null;
}

// ── Чи ставити сторінку в посиланні в тексті — за вимогою методички до посилань
// (methodInfo.citationStyle, напр. "[N]", "[N, с. 25]", "(Автор, рік)"):
//  "never"  — методичка показує посилання без сторінки ("[1]", "(Автор, рік)") і ніде
//             не згадує сторінок — сторінки в тексті не ставимо зовсім;
//  "always" — методичка вимагає сторінку ("[N, с. 25]", "із зазначенням сторінки") —
//             ставимо, а джерела без відомих сторінок підсвічуються менеджеру;
//  "auto"   — не вказано чи неоднозначно: сторінка там, де діапазон джерела відомий. ──
export function detectInTextPagePolicy(citationStyle) {
  const s = String(citationStyle || "").trim();
  if (!s) return "auto";
  if (/сторін|page|(?:^|[\s\d,([])(?:с|c|p|pp|стор|s)\.\s*(?:\d|x|х|n|№|\.\.\.)/i.test(s)) return "always";
  if (/\[\s*(?:n|\d+|№)\s*\]|\(\s*[^()]{1,40},\s*(?:\d{4}|рік|р\.|year|рр?\.?)\s*\)/i.test(s)) return "never";
  return "auto";
}

// ── Сторінки, що були в сирому рядку джерела, мають лишитись і у відформатованому
// ЛЛМ рядку. Модель відповідає за пунктуацію й порядок елементів, але іноді губить
// "С. 12–19" чи змінює числа — тоді сторінки повертає код (без ШІ): замінює змінені
// числа на правильні або вставляє відсутній елемент у звичне для стилю місце. ──
const URL_TAIL_RE = /\s*(?:URL\s*:|DOI\s*:|doi\s*:|https?:\/\/)/;

function insertBeforeUrl(line, element) {
  const m = line.match(URL_TAIL_RE);
  if (m) {
    const head = line.slice(0, m.index).replace(/[\s.]+$/, "");
    return `${head}. ${element} ${line.slice(m.index).trimStart()}`;
  }
  return `${line.replace(/[\s.]+$/, "")}. ${element}`;
}

export function restoreLostPages(rawRef, styled, sourcesStyle = "") {
  if (!styled) return styled;
  const raw = parseRefPages(rawRef);
  if (!raw) return styled;
  const isAPA = /APA/i.test(sourcesStyle);
  const isMLA = /MLA/i.test(sourcesStyle);
  const latin = !isMostlyCyrillic(styled);

  if (raw.first != null) {
    const want = formatPages(raw);
    const got = parseRefPages(styled);
    if (got?.first != null) {
      if (got.first === raw.first && got.last === raw.last) return styled;
      return styled.slice(0, got.index) + want + styled.slice(got.index + got.length); // ЛЛМ змінила числа
    }
    // Діапазон уже є в рядку в іншому вигляді (напр. APA без позначки) — нічого не робимо
    if (raw.first !== raw.last && new RegExp(`(^|\\D)${raw.first}\\s*[-–—]\\s*${raw.last}(\\D|$)`).test(styled)) return styled;
    if (isAPA) {
      const vi = styled.match(/\d+\s*\([^)]*\)/);
      if (vi) return `${styled.slice(0, vi.index + vi[0].length)}, ${want}${styled.slice(vi.index + vi[0].length)}`;
      return insertBeforeUrl(styled, `${want}.`);
    }
    const mark = isMLA ? (raw.first === raw.last ? "p." : "pp.") : (latin ? "P." : "С.");
    return insertBeforeUrl(styled, `${mark} ${want}.`);
  }

  if (raw.total && !isAPA && !isMLA) {
    if (new RegExp(`(^|\\D)${raw.total}\\s*(?:с|c|p|pp|стор|S)\\.`).test(styled)) return styled;
    return insertBeforeUrl(styled, `${raw.total} ${latin ? "p." : "с."}`);
  }
  return styled;
}

// Будує формат внутрітекстового посилання ("[N]" / "(Автор, рік)" / "%%FNn%%") і, для
// ДСТУ та APA/MLA (де відомий діапазон сторінок джерела), діапазон сторінок — для
// кожного фінального номера. Спільна для remapAndFormatCitations і runRemapStage.
// pagePolicy "never" (методичка вимагає посилання без сторінок) — діапазонів не
// повертає, тож applyCitationRemap не ставить сторінок і прибирає вписані моделлю.
// pdfUrls — PDF джерела (якщо знайдено під час пошуку) для вибору сторінки за змістом.
export function buildCiteFormats({ finalTexts, rawRefs, indexMap, findStructured, isAPA, isMLA, isFootnoteMode, pagePolicy = "auto" }) {
  const rawIdxOfFinal = new Array(finalTexts.length);
  indexMap.forEach((finalPos, rawIdx) => { rawIdxOfFinal[finalPos - 1] = rawIdx; });

  const refCiteText = {};
  const pageRanges = {};
  const pdfUrls = {};
  finalTexts.forEach((ref, i) => {
    const n = i + 1;
    const rawIdx = rawIdxOfFinal[i];
    const rawRef = rawRefs[rawIdx] ?? ref;
    const sp = findStructured(rawRef);
    if (sp?.pdfUrl) pdfUrls[n] = sp.pdfUrl;
    if (isAPA || isMLA) {
      refCiteText[n] = apaOrMlaCiteText(ref, n, { isAPA, isMLA }).text;
      // Сторінка для APA/MLA — так само, як для ДСТУ: якщо в описі джерела є
      // діапазон (стаття/дисертація) чи відомий загальний обсяг (книга), applyCitationRemap
      // допише її в дужку в потрібному місці (перед закриваючою ")").
      const range = pagePolicy === "never" ? null : extractPageRange(rawRef, sp);
      if (range) pageRanges[n] = range;
    } else if (isFootnoteMode) {
      // Маркер для exportDocx — буде замінений на справжню Word-виноску з повним
      // описом джерела (ref), узятим зі сформатованого списку.
      refCiteText[n] = `%%FN${n}%%`;
    } else {
      const range = pagePolicy === "never" ? null : extractPageRange(rawRef, sp);
      if (range) pageRanges[n] = range;
      refCiteText[n] = `[${n}]`;
    }
  });
  return { refCiteText, pageRanges, pdfUrls };
}

// Форматує список джерел за стилем (ДСТУ/APA/MLA), сортує (закони/мова/тип ресурсу)
// і повертає мапу старий→новий номер та формат inline-посилання для кожного нового
// номера. Для малих робіт (small-works.jsx, PracticePage.jsx), де [N] у тексті
// ЗАВЖДИ відповідає citations[N-1] (єдиний глобальний список без посекційної
// локальної нумерації, на відміну від doRemapCitations в academic-assistant.jsx).
export async function remapAndFormatCitations({
  citations,           // string[] — tezyCitations
  citStructured,       // paper[] — плоский масив структурованих даних
  citStyle,            // info?.citStyle
  language,            // info?.language
  sourcesOrder,        // methodInfo?.sourcesOrder (опційно)
  sourcesFormatRules,  // methodInfo?.sourcesFormatRules (опційно)
  sourcesGrouping,     // methodInfo?.sourcesGrouping (опційно) — сигнал для мовного групування
  citFootnotes,        // true → ДСТУ-посилання у вигляді посторінкових виносок замість [N]
  citationStyle,       // methodInfo?.citationStyle (опційно) — чи потрібні сторінки в посиланнях
  callClaude,
}) {
  if (!citations?.length) return { refList: [], oldToNew: {}, refCiteText: {}, pageRanges: {}, pdfUrls: {} };

  const sourcesStyleRaw = citStyle || "ДСТУ 8302:2015";
  const isAPA = /APA/i.test(sourcesStyleRaw);
  const isMLA = /MLA/i.test(sourcesStyleRaw);
  const isDstu = !isAPA && !isMLA;
  const sourcesStyle = isAPA ? "APA" : isMLA ? "MLA" : "ДСТУ 8302:2015";
  const isAlphabeticalOrder = !sourcesOrder || sourcesOrder === "alphabetical";
  // Для будь-якої неукраїнської роботи (зокрема чеської/словацької/китайської, яких тут раніше не було)
  const latinFirst = getLangLabels(language).code !== "uk";

  const structuredByTitle = {};
  (citStructured || []).forEach(p => {
    if (p?.title) structuredByTitle[p.title.toLowerCase().slice(0, 60)] = p;
  });
  const findStructured = (refText) => {
    const lower = refText.toLowerCase();
    for (const [key, paper] of Object.entries(structuredByTitle)) {
      if (lower.includes(key)) return paper;
    }
    return null;
  };

  const { finalTexts, indexMap } = await buildFinalReferenceList({
    rawRefs: citations, findStructured, sourcesStyle, isLatinWork: latinFirst,
    sourcesFormatRules, sourcesGrouping, callClaude,
    skipSort: !isAlphabeticalOrder && !isDstu,
  });

  const oldToNew = {};
  citations.forEach((_, i) => { oldToNew[i + 1] = indexMap[i]; });

  const pagePolicy = detectInTextPagePolicy(citationStyle);
  const { refCiteText, pageRanges, pdfUrls } = buildCiteFormats({
    finalTexts, rawRefs: citations, indexMap, findStructured,
    isAPA, isMLA, isFootnoteMode: citFootnotes, pagePolicy,
  });

  // Абревіатура сторінки в дужці цитати (мовний профіль з getLangLabels — "p." для
  // англійської, "s." для польської/чеської/словацької, "S." для німецької тощо) —
  // застосовується лише коли applyCitationRemap реально дописує сторінку (APA/MLA з
  // відомим діапазоном, чи ДСТУ [N, с. X]).
  const pageAbbrev = getLangLabels(language).pageAbbrev;

  return { refList: finalTexts, oldToNew, refCiteText, pageRanges, pageAbbrev, pdfUrls, pagePolicy };
}
