// ── Пошук джерел ──
// OpenAlex  — CORS підтримується, викликаємо з браузера напряму
// CrossRef  — CORS підтримується, викликаємо з браузера напряму (добре індексує укр. журнали)
// Semantic Scholar — НЕ підтримує CORS, проксимо через /api/search-sources (Vercel)

import { normalizeAuthorsScript } from "./transliteration.js";
import { getApiBase, getProxyAuthHeaders, geminiCost } from "./api.js";
import { normalizePages, formatPages, normalizeTotalPages, extractPagesFromDoi, parseRefPages } from "./pageUtils.js";
import { isSameWork, crossrefCandidate } from "./sourceMatch.js";
import { getLangLabels, localSourceLangCode } from "./planUtils.js";

// ── Чистка текстових полів із баз ──
// CrossRef/OpenAlex віддають назви з HTML-сутностями й тегами ("Economics &amp; Finance",
// "<i>Salmonella</i>") — у списку літератури має бути звичайний текст.
const HTML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', laquo: '«', raquo: '»', hellip: '…' };
const MARKUP_TAG_RE = /<\/?(?:i|b|em|strong|sub|sup|scp|span|p|br|u|jats:[\w-]+|mml:[\w-]+)(?:\s[^>]*)?\/?>/gi;
export function cleanMetaText(s) {
  if (s == null) return s;
  return String(s)
    .replace(MARKUP_TAG_RE, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code) => {
      if (code[0] === '#') {
        const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
        return Number.isFinite(n) ? String.fromCodePoint(n) : m;
      }
      return HTML_ENTITIES[code.toLowerCase()] ?? m;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

// Назва видання, якої в описі джерела бути не повинно: порожня, домен сайту
// ("isg-journal.com") чи обрізана Google Scholar-ом ("Актуальні питання …")
export function isBadVenue(v) {
  const s = String(v || '').trim();
  return !s || /^[\w.-]+\.[a-zA-Z]{2,}$/.test(s) || /(?:…|\.{3})\s*$/.test(s);
}

// Лише імена авторів: старий розбір Google Scholar (до 24.09.2026) клав у "авторів" ще й
// назву журналу та рік ("T Nazarova - International Science Journal of …", "управління
// та …", "2015") — далі ШІ переносило цей шматок у журнал, обрізаним і транслітерованим.
export function cleanAuthorList(authors) {
  if (!Array.isArray(authors)) return [];
  return authors
    .map(a => String(a || '').split(/\s+[-–]\s+/)[0].replace(/\s*(?:…|\.{3})\s*$/, '').trim())
    .filter(a => a && !/^\d{4}$/.test(a) && /\p{Lu}/u.test(a) && /\p{L}{2,}/u.test(a));
}

// window.dispatchEvent('apicost', ...) — браузерний спосіб донести вартість
// виклику до живого лічильника в UI. У Node-воркері window немає — там
// виклик передає onCost і отримує ті самі дані прямим викликом функції.
function reportCost(detail, onCost) {
  if (onCost) { onCost(detail); return; }
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("apicost", { detail }));
}

// ── Стоп-слова: структурні/загальні слова що не несуть теми ──
const STOP_WORDS = new Set([
  'аналіз', 'дослідження', 'особливості', 'формування', 'удосконалення',
  'забезпечення', 'оцінка', 'оцінювання', 'підходи', 'методи', 'механізми',
  'розробка', 'обґрунтування', 'характеристика', 'сутність', 'визначення',
  'вдосконалення', 'підвищення', 'покращення', 'реалізація', 'впровадження',
  'практичний', 'практична', 'практичне', 'практичні', 'рекомендації',
  'рекомендація', 'теоретичний', 'теоретична', 'теоретичне', 'теоретичні',
  'загальний', 'основний', 'основні', 'основна', 'щодо', 'умовах', 'умови',
  'шляхи', 'напрями', 'напрямки', 'проблеми', 'проблема', 'питання',
  'розвиток', 'розвитку', 'підтримка', 'підтримки', 'види', 'вид', 'типи',
  'тип', 'форми', 'форма', 'роль', 'місце', 'значення', 'функції', 'функція',
  'властивості', 'поняття', 'концепція', 'концепції', 'система', 'суть',
  // Загальноструктурні терміни що зустрічаються в будь-якій галузі (A)
  'моделі', 'модель', 'методи', 'метод', 'підхід', 'підходи',
  'та', 'або', 'при', 'як', 'що', 'це', 'які', 'який', 'яка', 'яке',
  'його', 'її', 'їх', 'він', 'вона', 'воно', 'вони',
  'а', 'і', 'й', 'в', 'у', 'на', 'з', 'із', 'зі', 'до', 'від', 'про',
  'за', 'по', 'між', 'через', 'під', 'над', 'без', 'після', 'перед',
]);

const BLOCKED = [
  'russia', 'russian federation', 'москв', 'санкт-петербург', 'новосибирск',
  'екатеринбург', 'казань', 'самар', 'нижн', 'российск', 'росс', 'rsci',
  'elibrary.ru', 'cyberleninka', 'киберленинк',
  'белорус', 'беларус', 'minsk', 'минск', 'гродн', 'витебск', 'брест',
];

// ── Чужі студентські роботи (магістерські, дипломні, курсові тощо) — не беремо як джерела ──
const STUDENT_WORK_PATTERNS = [
  'магістерська робота', 'магістерська дисертація', 'магістерської роботи',
  'дипломна робота', 'дипломної роботи', 'кваліфікаційна робота', 'кваліфікаційної роботи',
  'випускна кваліфікаційна робота', 'бакалаврська робота', 'бакалаврської роботи',
  'курсова робота', 'курсової роботи',
  "master's thesis", 'master thesis', 'bachelor thesis', "bachelor's thesis",
  'diploma thesis', 'diploma work', 'coursework', 'term paper', 'graduation thesis',
];
const STUDENT_WORK_TYPES = new Set(['dissertation', 'thesis']);

function isStudentWork(obj) {
  const title = (Array.isArray(obj?.dctitle) ? obj.dctitle[0] : obj?.dctitle) || obj?.title || '';
  const titleLower = title.toLowerCase();
  if (STUDENT_WORK_PATTERNS.some(p => titleLower.includes(p))) return true;
  const type = (obj?.type || obj?.documentType || '').toLowerCase();
  if (STUDENT_WORK_TYPES.has(type)) return true;
  return false;
}

// ── Методичні матеріали (вказівки, рекомендації, посібники) — не містять
// достатньо фактажу/дослідження щоб бути джерелом цитування ──
const METHODICAL_PATTERNS = [
  'методичні вказівки', 'методичних вказівок', 'методичні рекомендації',
  'методичних рекомендацій', 'методичний посібник', 'методичного посібника',
  'методична розробка', 'методичної розробки', 'методичне видання',
  'навчально-методичний посібник', 'навчально-методичні рекомендації',
  'навчально-методична розробка', 'методичні матеріали',
];

function isMethodicalGuide(obj) {
  const title = (Array.isArray(obj?.dctitle) ? obj.dctitle[0] : obj?.dctitle) || obj?.title || '';
  const titleLower = title.toLowerCase();
  return METHODICAL_PATTERNS.some(p => titleLower.includes(p));
}

function isRussianUrl(url = '') {
  return /\.ru(\/|$)/i.test(url.toLowerCase());
}

function isRussianText(text = '') {
  // Символи наявні в російській, але відсутні в українській мові
  return /[ёъыэЁЪЫЭ]/.test(text);
}

function isBlocked(obj) {
  const t = JSON.stringify(obj).toLowerCase();
  if (BLOCKED.some(p => t.includes(p))) return true;
  // Блокуємо будь-який .ru домен
  const url = obj?.url || obj?.dclink || '';
  if (isRussianUrl(Array.isArray(url) ? url[0] : url)) return true;
  // Блокуємо джерела з мовою 'ru' (поле OpenAlex)
  if (obj?.language === 'ru') return true;
  // Блокуємо джерела з російськомовним заголовком
  const title = (Array.isArray(obj?.dctitle) ? obj.dctitle[0] : obj?.dctitle) || obj?.title || '';
  if (isRussianText(title)) return true;
  // Блокуємо чужі студентські роботи (магістерські, дипломні, курсові тощо)
  if (isStudentWork(obj)) return true;
  // Блокуємо методичні вказівки/рекомендації/посібники — не містять потрібної інформації
  if (isMethodicalGuide(obj)) return true;
  return false;
}

function hasCyrillic(text = '') {
  return /[А-ЯҐЄІЇа-яґєіїёЁ]/.test(text);
}

/**
 * Будує coreTerm з назви підрозділу + теми роботи:
 * бере перші 3 значущих слова (без стоп-слів) — зберігає повний контекст теми.
 * Напр.: sectionTitle "Інтерактивні технологій у вихованні дітей"
 *   → coreTerm = "інтерактивних технологій вихованні"
 */
function buildCoreTerm(sectionTitle = '', topic = '') {
  const extract = (text) => text.toLowerCase()
    .split(/[\s,.:;()–—\-/'"«»]+/)
    .filter(w => w.length > 4 && !STOP_WORDS.has(w));
  const seen = new Set();
  const words = [...extract(sectionTitle), ...extract(topic)]
    .filter(w => seen.has(w) ? false : seen.add(w));
  return words.slice(0, 3).join(' ');
}

/**
 * Пост-фільтр за галуззю (E): підвищує скор статей що містять слова
 * з теми роботи та назви підрозділу. Нерелевантні не видаляються —
 * лише опускаються вниз списку.
 */
function domainBoost(results, sectionTitle = '', topic = '') {
  const combined = `${sectionTitle} ${topic}`.toLowerCase();
  const domainWords = combined
    .split(/[\s,.:;()–—\-/]+/)
    .filter(w => w.length > 6 && !STOP_WORDS.has(w));
  if (!domainWords.length) return results;
  return results.map(p => ({
    ...p,
    _score: (p._score || 0) + domainWords.filter(w => p.title.toLowerCase().includes(w)).length * 3,
  })).sort((a, b) => b._score - a._score);
}

/**
 * Скоринг релевантності: скільки ключових фраз/слів зустрічається в назві статті.
 */
function scoreRelevance(titleLower, keywords) {
  let score = 0;
  for (const kw of keywords) {
    const k = kw.toLowerCase().trim();
    if (!k || k.length < 4) continue;
    // Повна фраза — більше балів
    if (titleLower.includes(k)) { score += k.includes(' ') ? 4 : 2; continue; }
    // Окремі слова фрази
    for (const w of k.split(/\s+/)) {
      if (w.length > 4 && !STOP_WORDS.has(w) && titleLower.includes(w)) score += 1;
    }
  }
  return score;
}

// ── Сторінки для запису джерела: { pages: "12–19", pagesSrc } з першого джерела, що
// пройшло перевірку (normalizePages), інакше — з кінця DOI (евристика, pagesSrc "doi",
// у картці позначається "перевірити"). pagesSrc показується менеджеру, звідки сторінки.
function pagesFrom(raw, src, doi = '') {
  const p = normalizePages(raw);
  if (p) return { pages: formatPages(p), pagesSrc: src };
  const fromDoi = extractPagesFromDoi(doi);
  if (fromDoi) return { pages: formatPages(fromDoi), pagesSrc: 'doi' };
  return { pages: '' };
}

/**
 * Отримує авторів і сторінки з CrossRef за DOI.
 * Використовується коли пошук повернув запис без авторів.
 */
export async function lookupDoiMetadata(doi) {
  if (!doi) return null;
  let result = null;
  try {
    const r = await fetch(`https://api.crossref.org/works/${encodeURIComponent(doi)}?mailto=support@academ-assist.vercel.app`);
    if (r.ok) {
      const d = await r.json();
      const p = d.message;
      if (p) {
        const authorsStructured = (p.author || []).slice(0, 3)
          .map(a => ({ family: a.family || '', given: a.given || '' }))
          .filter(a => a.family);
        const authors = authorsStructured
          .map(a => [a.family, a.given?.[0]].filter(Boolean).join(' '))
          .filter(Boolean);
        const crPages = normalizePages(p.page);
        result = {
          authorsStructured,
          authors,
          pages: crPages ? formatPages(crPages) : '',
          ...(crPages ? { pagesSrc: 'crossref' } : {}),
          volume: p.volume || '',
          issue: p.issue || '',
          journal: cleanMetaText(p['container-title']?.[0] || ''),
          publisher: cleanMetaText(p.publisher || ''),
          publisherLocation: p['publisher-location'] || '',
          year: p.published?.['date-parts']?.[0]?.[0] || '',
        };
      }
    }
  } catch { /* fallthrough to OpenAlex */ }

  // Якщо CrossRef не повернув авторів або не повернув сторінки — пробуємо OpenAlex
  if (!result?.authors?.length || !result?.pages) {
    try {
      const oaUrl = `https://api.openalex.org/works/https://doi.org/${doi}?select=authorships,biblio,publication_year`;
      const r2 = await fetch(oaUrl);
      if (r2.ok) {
        const w = await r2.json();
        const oaAuthors = (w.authorships || []).slice(0, 3)
          .map(a => a.author?.display_name || '').filter(Boolean);
        const oaPages = normalizePages(w.biblio?.first_page ? { first: w.biblio.first_page, last: w.biblio.last_page || '' } : null);
        if (oaAuthors.length || oaPages || w.publication_year) {
          const keepCr = !!result?.pages;
          result = {
            ...(result || {}),
            // Автори — лише якщо CrossRef їх не дав
            ...(oaAuthors.length && !result?.authors?.length ? {
              authors: oaAuthors,
              authorsStructured: oaAuthors.map(n => {
                const parts = n.trim().split(/\s+/);
                return { family: parts[0] || '', given: parts.slice(1).join(' ') };
              }),
            } : {}),
            // Сторінки — перше значення, що пройшло перевірку
            pages: keepCr ? result.pages : (oaPages ? formatPages(oaPages) : ''),
            ...(keepCr ? {} : oaPages ? { pagesSrc: 'openalex' } : {}),
            year: result?.year || w.publication_year || '',
          };
        }
      }
    } catch { /* ignore */ }
  }

  // Останній шанс — сторінки з кінця DOI (евристика, у картці — "перевірити").
  // Лише коли сам DOI резолвиться: інакше null означає "DOI не підтверджено".
  if (result && !result.pages) {
    const fromDoi = extractPagesFromDoi(doi);
    if (fromDoi) { result.pages = formatPages(fromDoi); result.pagesSrc = 'doi'; }
  }

  return result;
}

// Кеш відповідей проксі в межах сесії (вкладки браузера / процесу воркера): та сама
// сторінка журналу раніше запитувалась двічі поспіль — по сторінки й по перевірку
// існування. Обмежений за розміром, щоб довгоживучий воркер не накопичував пам'ять.
const _metaCache = new Map();
const _pdfCache = new Map();
function _cacheGet(cache, key, make) {
  if (cache.has(key)) return cache.get(key);
  if (cache.size > 2000) cache.clear();
  // невдачу не кешуємо — тимчасовий збій мережі не має "прилипнути" до сесії воркера
  const p = make().catch(() => null).then(v => { if (v == null) cache.delete(key); return v; });
  cache.set(key, p);
  return p;
}

/**
 * Мета-дані сторінки журналу через проксі /api/fetch-meta: { pages, urlOk, pdfUrl }.
 * pages — з мета-тегів (citation_firstpage, DC.Identifier.pageNumber, prism.*,
 * eprints.pagerange, JSON-LD тощо); pdfUrl — PDF статті (citation_pdf_url, галея OJS
 * або саме посилання, якщо воно веде на PDF) — для витягування сторінок з PDF.
 */
export function fetchUrlMeta(url) {
  if (!url) return Promise.resolve(null);
  return _cacheGet(_metaCache, url, async () => {
    const res = await fetch(`${getApiBase()}/api/fetch-meta`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await getProxyAuthHeaders()) },
      body: JSON.stringify({ url }),
    });
    if (!res.ok) return null;
    return res.json();
  });
}

/**
 * Витягує сторінки зі сторінки журналу через Google Scholar мета-теги.
 * Використовується як fallback коли CrossRef/OpenAlex не мають сторінок.
 */
export async function fetchPagesFromUrl(url) {
  const data = await fetchUrlMeta(url);
  const p = normalizePages(data?.pages);
  return p ? formatPages(p) : null;
}

/**
 * Перевіряє, що URL справді відкривається (для джерел без DOI — єдиний спосіб
 * підтвердити, що запис реально існує, а не лише має правдоподібну назву).
 * Той самий проксі й кеш, що й fetchPagesFromUrl, але прапорець urlOk окремо від
 * pages — сторінка може відкриватись і не мати citation-мета-тегів.
 */
export async function verifyUrlOpens(url) {
  const data = await fetchUrlMeta(url);
  return data?.urlOk === true;
}

/**
 * Сторінки статті з самого PDF (проксі /api/pdf-pages): номери в колонтитулах першої й
 * останньої сторінок, звірені з кількістю сторінок PDF. { pages, noPages, numPages } —
 * noPages: PDF із текстом, але без жодного номера сторінки (електронне видання, де
 * сторінок немає взагалі — цитувати без "С."). snippets (необов'язково) — речення з
 * тексту роботи; тоді ще й snippetPages: для кожного — сторінка PDF, де про це
 * йдеться найбільше (вибір сторінки за змістом, contentPages.js).
 */
export function fetchPdfPages(pdfUrl, snippets = null) {
  if (!pdfUrl) return Promise.resolve(null);
  const run = async () => {
    const res = await fetch(`${getApiBase()}/api/pdf-pages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await getProxyAuthHeaders()) },
      body: JSON.stringify({ url: pdfUrl, ...(snippets?.length ? { snippets } : {}) }),
    });
    if (!res.ok) return null;
    return res.json();
  };
  return snippets?.length ? run().catch(() => null) : _cacheGet(_pdfCache, pdfUrl, run);
}

// Паралельна обробка з обмеженням кількості одночасних запитів (PDF важкі — не
// більше кількох разом, щоб не впертись у ліміти хостингу журналів і Vercel).
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

// ── Декодування abstract_inverted_index OpenAlex → plain text ──
function decodeAbstract(inv) {
  if (!inv || typeof inv !== 'object') return '';
  const words = [];
  for (const [word, positions] of Object.entries(inv)) {
    for (const pos of positions) words[pos] = word;
  }
  return words.filter(Boolean).join(' ');
}

function snippetAbstract(text) {
  if (!text) return '';
  const sentences = text.match(/[^.!?]+[.!?]+/g) || [];
  const snippet = sentences.slice(0, 2).join(' ').trim();
  if (!snippet) return '';
  const words = snippet.split(/\s+/);
  return words.length > 100 ? words.slice(0, 100).join(' ') + '...' : snippet;
}

// CrossRef іноді повертає анотацію як JATS XML (<jats:p>текст</jats:p>) — знімаємо теги
function stripJatsAbstract(text) {
  if (!text) return '';
  return text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Будує семантичні ключові слова з контексту роботи (не від AI).
 * Витягує значущі слова з назви підрозділу, теми, галузі та коментарів,
 * складає 2–3 пошукові комбінації.
 */
export function buildSemanticKeywords(sectionLabel = '', topic = '', direction = '', subject = '', commentHints = '', methodReq = '') {
  const freq = {};
  const addWords = (text, weight) => {
    if (!text) return;
    text.toLowerCase()
      .split(/[\s,.:;()–—\-/'"«»]+/)
      .filter(w => w.length > 4 && !STOP_WORDS.has(w))
      .forEach(w => { freq[w] = (freq[w] || 0) + weight; });
  };
  addWords(sectionLabel, 4);
  addWords(topic, 3);
  addWords(direction, 3);
  addWords(subject, 2);
  addWords(commentHints.slice(0, 300), 1);
  addWords(methodReq.slice(0, 300), 1);

  const topWords = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([w]) => w);
  if (topWords.length < 2) return [];

  const queries = [];
  if (topWords.length >= 2) queries.push(topWords.slice(0, 3).join(' '));
  if (topWords.length >= 4) queries.push(topWords.slice(2, 5).join(' '));
  if (topWords.length >= 6) queries.push([topWords[0], topWords[4], topWords[5]].join(' '));
  return queries;
}

// ── Фільтрація за роками (останні 5 років обов'язково, 6–10 — тільки якщо дуже релевантні) ──
const YEAR_STRICT = new Date().getFullYear() - 4; // >= поточний-4 (останні 5 років)
const YEAR_LOOSE  = new Date().getFullYear() - 9; // >= поточний-9 (останні 10 років)
const YEAR_LOOSE_MIN_SCORE = 2; // мінімальний скор для 6–10-річних джерел

// extraYears: під час добору при нестачі джерел межу "6-10 років" відсовуємо на +2/+3 роки за раунд
// matchableLangs: мови статей, для яких скор проти keywords взагалі щось означає (той самий алфавіт/мова,
// що й keywords) — лише для них має сенс вимагати YEAR_LOOSE_MIN_SCORE; інші мови пропускаємо без перевірки
// скору, бо збіг об'єктивно неможливий (напр. українська фраза проти англомовної назви)
function applyYearFilter(papers, keywords = [], extraYears = 0, matchableLangs = ['uk', 'pl']) {
  const looseFloor = YEAR_LOOSE - extraYears;
  return papers.map(p => ({
    ...p,
    _score: p._score ?? scoreRelevance((p.title || '').toLowerCase(), keywords),
  })).filter(p => {
    const yr = parseInt(p.year, 10) || 0;
    if (yr >= YEAR_STRICT) return true;
    if (yr >= looseFloor) {
      if (!matchableLangs.includes(p.lang)) return true;
      return (p._score || 0) >= YEAR_LOOSE_MIN_SCORE;
    }
    return false;
  });
}

// ── OpenAlex ──
// Анонімний пошук (search=/title.search) зараз обмежується OpenAlex 503-кою —
// потрібен api_key для стабільного доступу
const OA_KEY = (typeof import.meta !== 'undefined' ? (import.meta.env?.VITE_OPENALEX_API_KEY || '') : '')
  || (typeof process !== 'undefined' ? (process.env?.OPENALEX_API_KEY || '') : '');   // Node-воркер: ключ з .env
const OA_KEY_PARAM = OA_KEY ? `&api_key=${OA_KEY}` : '';
const OA_BASE = 'https://api.openalex.org/works';
const OA_FIELDS = 'title,authorships,publication_year,primary_location,doi,language,id,biblio,abstract_inverted_index,type';

const OA_MAILTO = '&mailto=support@academ-assist.vercel.app';

// api_key — платний рівень OpenAlex з передоплаченим бюджетом; коли бюджет вичерпано,
// OpenAlex повертає 429 на КОЖЕН запит із цим ключем, незалежно від навантаження.
// Тому: спершу пробуємо з ключем (якщо є), а при невдачі — одразу той самий запит
// без ключа (безкоштовний "polite pool" через mailto — там немає такого підводного каменя).
// OpenAlex обмежує 10 запитів/с (429 «Rate limit exceeded… Please slow down») і денний бюджет
// кредитів. У воркері пошук по кількох підрозділах іде паралельно (по 3 OpenAlex-запити на
// фразу) — бурст легко перевищував 10/с, більшість запитів отримувала 429 і мовчки давала [],
// звідки «4 джерела на магістерську» (19.09). Тому: черга ≤8 запитів/с + повтор після 429
// із затримкою retryAfter (до 3 разів).
const OA_MIN_GAP_MS = 130;
let _oaLast = 0;
let _oaChain = Promise.resolve();
function _oaSlot() {
  const p = _oaChain.then(async () => {
    const wait = _oaLast + OA_MIN_GAP_MS - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    _oaLast = Date.now();
  });
  _oaChain = p.catch(() => {});
  return p;
}
// Запобіжник бюджету: коли денний бюджет вичерпано, OpenAlex відповідає 429 з retryAfter ≈ секунд до
// півночі UTC (десятки тисяч). Раніше повтор чесно чекав цей retryAfter → пошук джерел «зависав» на години
// (21.09.2026, замовлення 41454 і 41173). Тепер: довге очікування чи «budget» у відповіді = бюджет скінчився —
// більше не чекаємо і не смикаємо OpenAlex до скидання (окремо для запитів із ключем і без).
const _oaBlockedUntil = { keyed: 0, anon: 0 };
const OA_MAX_RETRY_DELAY_MS = 3000;
function _oaBlockedResponse() { return { ok: false, status: 429, json: async () => ({}), clone() { return this; } }; }
async function _oaFetch(url) {
  const lane = /[?&]api_key=/.test(url) ? 'keyed' : 'anon';
  if (Date.now() < _oaBlockedUntil[lane]) return _oaBlockedResponse();
  for (let attempt = 0; attempt < 4; attempt++) {
    await _oaSlot();
    const r = await fetch(url, { cache: 'no-store' });
    if (r.status !== 429) return r;
    let delay = 500 * (attempt + 1);
    try {
      const b = await r.clone().json();
      const retryMs = b?.retryAfter ? Math.ceil(b.retryAfter * 1000) : 0;
      const budgetOut = /budget/i.test(b?.message || '') || retryMs > 30_000;
      if (budgetOut) {
        _oaBlockedUntil[lane] = Date.now() + Math.min(Math.max(retryMs, 10 * 60_000), 6 * 3600_000);
        console.warn(`[openalex] бюджет вичерпано (${lane === 'keyed' ? 'з ключем' : 'без ключа'}) — не звертаємось до ${new Date(_oaBlockedUntil[lane]).toISOString()}`);
        return r;
      }
      if (retryMs) delay = Math.min(Math.max(delay, retryMs + 100), OA_MAX_RETRY_DELAY_MS);
    } catch { /* тіло не JSON */ }
    if (attempt === 3) return r;
    await new Promise(res => setTimeout(res, delay));
  }
  return fetch(url, { cache: 'no-store' });
}
async function fetchOpenAlexJson(baseUrl) {
  if (OA_KEY_PARAM) {
    const withKey = await _oaFetch(`${baseUrl}${OA_KEY_PARAM}`);
    if (withKey.ok) return withKey.json();
  }
  const r = await _oaFetch(baseUrl);
  if (!r.ok) {
    if (r.status === 429) console.warn('[openalex] 429 після повторів — денний ліміт або бурст; кандидатів із OpenAlex не буде');
    return null;
  }
  return r.json();
}

async function openAlexSearch(query, filterStr, limit, page = 1) {
  const url = `${OA_BASE}?search=${encodeURIComponent(query)}&filter=${filterStr}&per_page=${limit}&page=${page}&select=${OA_FIELDS}${OA_MAILTO}`;
  const d = await fetchOpenAlexJson(url);
  if (!d) return [];
  return (d.results || []).filter(p => p.title && !isBlocked(p));
}

// Пошук тільки по заголовках — набагато точніший
// ВАЖЛИВО: OpenAlex ігнорує повторні query-параметри filter= (лишає лише останній) —
// усі умови мають бути об'єднані комою в ОДНОМУ filter= (AND), як і в openAlexSearch
async function openAlexTitleSearch(query, filters, limit, page = 1) {
  const filterStr = [`title.search:${encodeURIComponent(query)}`, ...filters].join(',');
  const url = `${OA_BASE}?filter=${filterStr}&per_page=${limit}&page=${page}&select=${OA_FIELDS}${OA_MAILTO}`;
  const d = await fetchOpenAlexJson(url);
  if (!d) return [];
  return (d.results || []).filter(p => p.title && !isBlocked(p));
}

function mapOpenAlex(p, forceLang) {
  const lang = forceLang || (p.language === 'uk' || hasCyrillic(p.title) ? 'uk' : 'en');
  const fp = p.biblio?.first_page;
  const lp = p.biblio?.last_page;
  const doi = p.doi ? p.doi.replace('https://doi.org/', '') : '';
  const pageFields = pagesFrom(fp ? { first: fp, last: lp || '' } : null, 'openalex', doi);
  const abstract = snippetAbstract(decodeAbstract(p.abstract_inverted_index));
  const url = p.primary_location?.landing_page_url
    || (doi ? `https://doi.org/${doi}` : '')
    || (p.id?.startsWith('https://') ? p.id : '');
  const authors = (p.authorships || []).slice(0, 3)
    .map(a => a.author?.display_name || '').filter(Boolean);
  return {
    id: p.id || p.doi || String(Math.random()),
    title: cleanMetaText(p.title || ''),
    authors: normalizeAuthorsScript(authors, lang === 'uk'),
    year: p.publication_year || '',
    venue: cleanMetaText(p.primary_location?.source?.display_name || ''),
    doi,
    volume: p.biblio?.volume || '',
    issue: p.biblio?.issue || '',
    ...pageFields,
    lang,
    source: 'openalex',
    abstract,
    url,
  };
}

// ── Google Scholar через Serper.dev (проксі /api/search-scholar) ──
// Кеш Scholar по фразі: у памʼяті + (у Node) на диску, TTL 14 днів. Перезапуск тієї самої роботи,
// кола добору й повторна генерація більше не платять Serper за ті самі фрази (22.09.2026: кредити
// Serper закінчились через 3× зростання запитів після вмикання Scholar на кожній фразі).
const _scholarMem = new Map();
const SCHOLAR_TTL_MS = 14 * 24 * 3600_000;
const _isNode = typeof process !== 'undefined' && !!process.versions?.node;
let _scholarDir = null;
async function _scholarDiskGet(key) {
  if (!_isNode) return null;
  try {
    const fs = await import('node:fs/promises'); const path = await import('node:path'); const os = await import('node:os');
    _scholarDir ||= path.join(process.env.SCHOLAR_CACHE_DIR || os.tmpdir(), 'scholar-cache');
    const raw = await fs.readFile(path.join(_scholarDir, key + '.json'), 'utf8');
    const rec = JSON.parse(raw);
    return Date.now() - rec.at < SCHOLAR_TTL_MS ? rec.sources : null;
  } catch { return null; }
}
async function _scholarDiskPut(key, sources) {
  if (!_isNode) return;
  try {
    const fs = await import('node:fs/promises'); const path = await import('node:path'); const os = await import('node:os');
    _scholarDir ||= path.join(process.env.SCHOLAR_CACHE_DIR || os.tmpdir(), 'scholar-cache');
    await fs.mkdir(_scholarDir, { recursive: true });
    await fs.writeFile(path.join(_scholarDir, key + '.json'), JSON.stringify({ at: Date.now(), sources }));
  } catch { /* кеш — best effort */ }
}
function _scholarKey(query, limit) {
  const q = (query || '').toLowerCase().replace(/\s+/g, ' ').trim() + '|' + limit;
  let h = 0; for (let i = 0; i < q.length; i++) h = (h * 31 + q.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36) + '_' + q.replace(/[^a-z0-9а-яіїєґ]+/gi, '_').slice(0, 60);
}
// Результат Scholar — чисті автори, без обрізаної назви журналу й домену замість неї (домен
// лишається як site: для перевірки повноти він рахувався "виданням" і раніше). Потрібне й
// для кешу (пам'ять + диск, 14 днів): там можуть лежати результати старого розбору проксі.
function cleanScholarSource(p) {
  const venue = String(p.venue || '').trim();
  const isDomain = /^[\w.-]+\.[a-zA-Z]{2,}$/.test(venue);
  return {
    ...p,
    authors: cleanAuthorList(p.authors),
    venue: isBadVenue(venue) ? '' : venue,
    ...(isDomain && !p.site ? { site: venue } : {}),
  };
}

async function fetchScholar(query, limit, onCost) {
  const key = _scholarKey(query, limit);
  const hit = _scholarMem.get(key) || await _scholarDiskGet(key);
  if (hit) { _scholarMem.set(key, hit); return hit.filter(p => p.title && !isBlocked(p)).map(cleanScholarSource); }
  try {
    const res = await fetch(`${getApiBase()}/api/search-scholar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await getProxyAuthHeaders()) },
      body: JSON.stringify({ query, limit }),
    });
    if (!res.ok) return [];
    const data = await res.json();
    if (data.serperError) return [];                     // відмова Serper — не кешуємо порожнє
    const sources = (data.sources || []).filter(p => p.title && !isBlocked(p));
    if (sources.length > 0) {
      reportCost({ cost: 0.001, model: 'serper', inTok: 1, outTok: 0 }, onCost);
      _scholarMem.set(key, sources); _scholarDiskPut(key, sources);
    }
    return sources.map(cleanScholarSource);
  } catch { return []; }
}

// ── CORE.ac.uk — агрегатор відкритого доступу, індексує репозиторії ──
// Немає CORS у браузері — проксимо через /api/search-core (Vercel)
async function fetchCORE(query, limit) {
  try {
    const res = await fetch(`${getApiBase()}/api/search-core`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await getProxyAuthHeaders()) },
      body: JSON.stringify({ query, limit }),
    });
    if (!res.ok) return [];
    const d = await res.json();
    return (d.results || []).filter(p => p.title && !isBlocked(p));
  } catch { return []; }
}

function mapCORE(result) {
  const title = result.title || '';
  const doi = result.doi || '';
  const urls = result.sourceFulltextUrls || [];
  // result.links — масив {type, url} у відповіді CORE API; беремо перший не-thumbnail
  const coLink = (result.links || []).find(l => l.url && l.type !== 'thumbnail')?.url || '';
  const coreId = result.id || '';
  const url = result.downloadUrl || urls[0] || coLink
    || (doi ? `https://doi.org/${doi}` : '')
    || (coreId ? `https://core.ac.uk/works/${coreId}` : '');
  const journal = (result.journals || [])[0];
  const lang = hasCyrillic(title) ? 'uk' : 'en';
  const authors = (result.authors || []).slice(0, 3).map(a => (typeof a === 'string' ? a : a.name || '')).filter(Boolean);
  return {
    id: coreId ? `core-${coreId}` : String(Math.random()),
    title,
    authors: normalizeAuthorsScript(authors, lang === 'uk'),
    year: result.yearPublished || '',
    venue: journal?.title || result.publisher || '',
    doi,
    volume: journal?.volume || '',
    issue: journal?.issue || '',
    ...pagesFrom(null, 'core', doi),
    lang,
    source: 'core',
    abstract: snippetAbstract(result.abstract || ''),
    url,
  };
}

// ── DOAJ (Directory of Open Access Journals) — мультидисциплінарний, добре покриває укр. журнали ──
// Немає гарантованого CORS у браузері — проксимо через /api/search-doaj (Vercel)
async function fetchDOAJ(query, limit) {
  try {
    const res = await fetch(`${getApiBase()}/api/search-doaj`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await getProxyAuthHeaders()) },
      body: JSON.stringify({ query, limit }),
    });
    if (!res.ok) return [];
    const d = await res.json();
    return (d.results || []).filter(p => p.bibjson?.title && !isBlocked(p));
  } catch { return []; }
}

function mapDOAJ(result) {
  const bj = result.bibjson || {};
  const title = bj.title || '';
  const identifiers = bj.identifier || [];
  const doi = identifiers.find(i => i.type === 'doi')?.id || '';
  const links = bj.link || [];
  const fulltextUrl = links.find(l => l.type === 'fulltext')?.url || links[0]?.url || '';
  const url = fulltextUrl || (doi ? `https://doi.org/${doi}` : '');
  const authors = (bj.author || []).slice(0, 3).map(a => a.name || '').filter(Boolean);
  const lang = hasCyrillic(title) ? 'uk' : 'en';
  return {
    id: result.id ? `doaj-${result.id}` : String(Math.random()),
    title,
    authors: normalizeAuthorsScript(authors, lang === 'uk'),
    year: bj.year || '',
    venue: bj.journal?.title || '',
    doi,
    volume: bj.journal?.volume || '',
    issue: bj.journal?.number || '',
    // DOAJ віддає сторінки окремими полями bibjson.start_page/end_page (раніше їх не читали)
    ...pagesFrom(bj.start_page ? { first: bj.start_page, last: bj.end_page || '' } : null, 'doaj', doi),
    lang,
    source: 'doaj',
    abstract: snippetAbstract(bj.abstract || ''),
    url,
  };
}

// ── OpenAlex книги (тип book/monograph, україномовні) ──
async function fetchOpenAlexBooks(query, limit) {
  try {
    const yr = `publication_year:>${YEAR_LOOSE - 1}`;
    const url = `${OA_BASE}?search=${encodeURIComponent(query)}&filter=type:book,language:uk,${yr}&per_page=${limit}&select=${OA_FIELDS}${OA_MAILTO}`;
    const d = await fetchOpenAlexJson(url);
    if (!d) return [];
    return (d.results || [])
      .filter(p => p.title && !isBlocked(p))
      .map(p => ({ ...mapOpenAlex(p, 'uk'), type: 'book' }));
  } catch { return []; }
}

// ── CrossRef монографії ──
async function fetchCrossRefBooks(query, limit) {
  try {
    const url = `https://api.crossref.org/works?query=${encodeURIComponent(query)}&filter=type:monograph&rows=${Math.min(limit, 10)}&mailto=support@academ-assist.vercel.app`;
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) return [];
    const d = await r.json();
    return (d.message?.items || [])
      .filter(p => p.title?.[0] && hasCyrillic(p.title[0]) && !isBlocked(p))
      .map(p => ({
        id: p.DOI || String(Math.random()),
        title: cleanMetaText(p.title[0]),
        authors: normalizeAuthorsScript((p.author || []).slice(0, 3)
          .map(a => [a.family, a.given?.[0]].filter(Boolean).join(' ')).filter(Boolean), true),
        year: p.published?.['date-parts']?.[0]?.[0]
          || p['published-print']?.['date-parts']?.[0]?.[0] || '',
        venue: cleanMetaText(p['container-title']?.[0] || p.publisher || ''),
        doi: p.DOI || '',
        // "page" у записі монографії — не сторінки статті; загальний обсяг книги
        // (totalPages) добирає enrichSources через Google Books
        pages: '',
        lang: 'uk',
        source: 'crossref',
        type: 'book',
        abstract: snippetAbstract(stripJatsAbstract(p.abstract || '')),
        url: p.DOI ? `https://doi.org/${p.DOI}` : '',
      }));
  } catch { return []; }
}

// ── Google Books через Serper.dev (проксі /api/search-books) ──
async function fetchBooksGoogle(query, limit) {
  try {
    const res = await fetch(`${getApiBase()}/api/search-books`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await getProxyAuthHeaders()) },
      body: JSON.stringify({ query, limit }),
    });
    if (!res.ok) return [];
    const data = await res.json();
    // pageCount Google Books — це ЗАГАЛЬНИЙ обсяг книги ("240 с."), а не сторінки:
    // раніше він потрапляв у pages і давав у списку "С. 240", а в тексті щоразу
    // останню сторінку книги. (p.pages — відповідь старої версії проксі.)
    return (data.sources || [])
      .filter(p => p.title && !isBlocked(p))
      .map(p => {
        const totalPages = normalizeTotalPages(p.totalPages ?? p.pages);
        return { ...p, pages: '', totalPages, ...(totalPages ? { pagesSrc: 'books' } : {}) };
      });
  } catch { return []; }
}

// ── CrossRef (добре покриває укр. журнали з DOI) ──
async function fetchCrossRefUkrainian(query, limit, extraYears = 0) {
  const url = `https://api.crossref.org/works?query=${encodeURIComponent(query)}&filter=from-pub-date:${YEAR_LOOSE - extraYears}&rows=${Math.min(limit * 2, 20)}&mailto=support@academ-assist.vercel.app`;
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) return [];
  const d = await r.json();
  return (d.message?.items || [])
    .filter(p => {
      const title = p.title?.[0] || '';
      return title && hasCyrillic(title) && !isBlocked(p);
    })
    .map(p => ({
      id: p.DOI || String(Math.random()),
      title: cleanMetaText(p.title?.[0] || ''),
      authors: normalizeAuthorsScript((p.author || []).slice(0, 3)
        .map(a => [a.family, a.given?.[0]].filter(Boolean).join(' ')).filter(Boolean), true),
      year: (p.published?.['date-parts']?.[0]?.[0]
        || p['published-print']?.['date-parts']?.[0]?.[0]
        || ''),
      venue: cleanMetaText(p['container-title']?.[0] || ''),
      doi: p.DOI || '',
      ...pagesFrom(p.page, 'crossref', p.DOI || ''),
      lang: 'uk',
      source: 'crossref',
      abstract: snippetAbstract(stripJatsAbstract(p.abstract || '')),
      url: p.DOI ? `https://doi.org/${p.DOI}` : '',
    }));
}

// ── Semantic Scholar через бекенд (немає CORS у браузері) ──
async function fetchEnglishViaBackend(enKeywords, limit) {
  try {
    const res = await fetch(`${getApiBase()}/api/search-sources`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await getProxyAuthHeaders()) },
      body: JSON.stringify({ enKeywords, ukKeywords: [], needed: limit }),
    });
    if (!res.ok) return [];
    const data = await res.json();
    // pages — з journal.pages Semantic Scholar (сирі, тож через ту саму перевірку)
    return (data.sources || [])
      .filter(p => p.lang === 'en' && !isBlocked(p))
      .map(p => ({ ...p, ...pagesFrom(p.pages, 's2', p.doi || '') }));
  } catch {
    return [];
  }
}

// ── Пошук за однією фразою: BASE, Scholar (опційно), CORE, DOAJ, OpenAlex uk, CrossRef, OpenAlex pl, OpenAlex en, Semantic Scholar en ──
// enPhrase: англійський відповідник phrase (якщо є) — українська фраза не матчиться з англомовними
// статтями за текстом, тому EN-джерела (OpenAlex-en, Semantic Scholar) шукають саме за ним,
// а якщо enPhrase не передали — фолбек на phrase (як було раніше, краще ніж нічого)
//
// opts (для роботи неукраїнською мовою — phraseSearchOpts нижче):
//   localCode/localPhrase — пошук мовою роботи: OpenAlex language:<localCode> за фразою мовою роботи
//     замість польського запиту (той для української/англійської роботи лишається як був);
//   foreignFirst — зарубіжні кандидати йдуть упереміш з українськими 2:1, а не в кінці списку:
//     викликачі віддають на фільтр Gemini лише перші ~25, тож у кінці списку зарубіжні туди не доходили.
export async function searchByPhrase(phrase, limit = 10, page = 1, useScholar = false, extraYears = 0, enPhrase = '', opts = {}) {
  const { localCode = null, localPhrase = '', foreignFirst = false } = opts;
  const yr = `publication_year:>${YEAR_LOOSE - extraYears - 1}`;
  const enQuery = enPhrase || phrase;
  const localActive = !!(localCode && localPhrase);
  const sideLang = localActive ? localCode : 'pl';
  const sideQuery = localActive ? localPhrase : phrase;
  // BASE вимкнено: api.base-search.net вимагає окремої реєстрації IP/ключа
  // (звичайні запити повертають "Access denied"), яку свідомо вирішили не підключати.
  const [r2, r3, r4, r5, r6, r7, r8, r9] = await Promise.allSettled([
    useScholar ? fetchScholar(phrase, limit) : Promise.resolve([]),
    fetchCORE(phrase, limit),
    openAlexSearch(phrase, `language:uk,${yr}`, limit, page),
    fetchCrossRefUkrainian(phrase, limit, extraYears),
    openAlexSearch(sideQuery, `language:${sideLang},${yr}`, limit, page),
    openAlexSearch(enQuery, `language:en,${yr}`, limit, page),
    enPhrase ? fetchEnglishViaBackend([enPhrase], limit) : Promise.resolve([]),
    fetchDOAJ(phrase, limit),
  ]);

  const scholarRaw = r2.status === 'fulfilled' ? r2.value : [];
  const coreRaw    = r3.status === 'fulfilled' ? r3.value.map(mapCORE) : [];
  const ukRaw      = r4.status === 'fulfilled' ? r4.value.map(p => mapOpenAlex(p, 'uk')) : [];
  const crRaw      = r5.status === 'fulfilled' ? r5.value.filter(p => hasCyrillic(p.title || '')) : [];
  const plRaw      = r6.status === 'fulfilled' ? r6.value.map(p => mapOpenAlex(p, sideLang)) : [];
  const enRaw      = r7.status === 'fulfilled' ? r7.value.map(p => mapOpenAlex(p, 'en')) : [];
  const ssRaw      = r8.status === 'fulfilled' ? r8.value : [];
  const doajRaw    = r9.status === 'fulfilled' ? r9.value.map(mapDOAJ) : [];

  const seen = new Set();
  let raw = [];
  for (const p of [...scholarRaw, ...coreRaw, ...ukRaw, ...crRaw, ...plRaw, ...enRaw, ...ssRaw, ...doajRaw]) {
    const key = (p.title || '').toLowerCase().slice(0, 60);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    raw.push(p);
  }
  if (foreignFirst) {
    const foreign = raw.filter(p => p.lang !== 'uk');
    const uk = raw.filter(p => p.lang === 'uk');
    raw = [];
    while (foreign.length || uk.length) {
      if (foreign.length) raw.push(foreign.shift());
      if (foreign.length) raw.push(foreign.shift());
      if (uk.length) raw.push(uk.shift());
    }
  }
  const keywords = phrase.toLowerCase().split(/\s+/).filter(w => w.length > 3);
  // Ключові слова — з української фрази, тож для мови роботи збіг за назвою не рахуємо
  // (як і для англійської): інакше старші статті мовою роботи відсікались би за нульовий скор
  return applyYearFilter(raw, keywords, extraYears, localActive ? ['uk', 'pl'].filter(c => c !== localCode) : undefined);
}

// Опції searchByPhrase для i-ї фрази підрозділу роботи мовою lang: пошук мовою роботи за
// localPhrases (по колу, як enPhrases) і зарубіжні кандидати впереміш з українськими.
// Для української роботи — {} (поведінка як раніше).
export function phraseSearchOpts(lang, localPhrases, i) {
  if (getLangLabels(lang).code === 'uk') return {};
  const localCode = localSourceLangCode(lang);
  const localPhrase = localCode && localPhrases?.length ? localPhrases[i % localPhrases.length] : '';
  return { foreignFirst: true, localCode: localPhrase ? localCode : null, localPhrase };
}

// ── Офіційні статистичні джерела для економічних/фінансових робіт ──
// OpenAlex/CrossRef/BASE/CORE не індексують державні статистичні портали як
// "статті", тому для econ-підрозділів додаємо їх окремим фіксованим списком —
// це лише нагадування-посилання, конкретний звіт/сторінку клієнт/виконавець
// уточнює сам перед фінальним оформленням цитати.
export const ECON_INSTITUTIONAL_SOURCES = [
  {
    id: 'institutional-ukrstat',
    title: 'Офіційна статистична інформація',
    authors: [],
    year: new Date().getFullYear(),
    venue: 'Державна служба статистики України',
    pages: '',
    lang: 'uk',
    source: 'institutional',
    abstract: 'Загальнодержавна статистика: виробництво, ціни, зовнішня торгівля, зайнятість тощо — оберіть конкретний розділ відповідно до теми.',
    url: 'https://www.ukrstat.gov.ua/',
  },
  {
    id: 'institutional-nbu',
    title: 'Статистика фінансового сектору',
    authors: [],
    year: new Date().getFullYear(),
    venue: 'Національний банк України',
    pages: '',
    lang: 'uk',
    source: 'institutional',
    abstract: 'Грошово-кредитна, банківська та платіжна статистика, курси валют — оберіть конкретний розділ відповідно до теми.',
    url: 'https://bank.gov.ua/ua/statistic',
  },
  {
    id: 'institutional-mof',
    title: 'Статистична та аналітична інформація',
    authors: [],
    year: new Date().getFullYear(),
    venue: 'Міністерство фінансів України',
    pages: '',
    lang: 'uk',
    source: 'institutional',
    abstract: 'Показники державного бюджету, боргу, оподаткування — оберіть конкретний розділ відповідно до теми.',
    url: 'https://mof.gov.ua/uk/statistichna-informacija',
  },
  {
    id: 'institutional-worldbank',
    title: 'World Development Indicators',
    authors: [],
    year: new Date().getFullYear(),
    venue: 'World Bank Open Data',
    pages: '',
    lang: 'en',
    source: 'institutional',
    abstract: 'Міжнародні макроекономічні показники для порівняльного аналізу — оберіть конкретний набір даних відповідно до теми.',
    url: 'https://data.worldbank.org/',
  },
];

// Це завжди посилання на головну сторінку розділу статистики, а не на конкретний
// звіт/таблицю — автоматично знайти саме потрібний розділ для довільної теми
// неможливо без окремого пошукового механізму по кожній установі, тому позначаємо
// явно: виконавець має уточнити конкретне джерело перед фінальним оформленням.
export function getEconInstitutionalSources() {
  return ECON_INSTITUTIONAL_SOURCES.map(s => ({
    ...s,
    _missingFields: ['конкретний звіт/розділ (зараз — головна сторінка установи)'],
  }));
}

// ── Головна функція пошуку ──
// 9 запитів паралельно: різні фрази, режими (full-text / title.search), дві сторінки OpenAlex
// r1,r3-r7,r9 — OpenAlex (сирий формат) → mapOpenAlex
// r2, r8      — CrossRef (вже відформатовано fetchCrossRefUkrainian) → без маппінгу
// lang — мова роботи: для неукраїнської зарубіжні кандидати йдуть першими й їх більше
// (квота sourceLangQuota), а польський запит замінено пошуком мовою роботи за темою
// (тема роботи вже написана цією мовою).
export async function searchSourcesForSection(ukKeywords, enKeywords, needed = 4, sectionTitle = '', topic = '', page = 1, semKeywords = [], anchors = [], geminiPhrases = [], lang = '') {
  const foreignWork = getLangLabels(lang).code !== 'uk';
  const localCode = localSourceLangCode(lang);
  const target = 25;
  const fetchLimit = 20;
  const allUkKeywords = [...new Set([...ukKeywords, ...semKeywords])];
  const yr = `publication_year:>${YEAR_LOOSE - 1}`;

  // ── Фрази для запитів ──
  // Якщо Gemini надав фрази — використовуємо їх; інакше — стара логіка ротації
  let p0, p1, p2, coreTerm, oaPage;
  const usingGemini = geminiPhrases.length >= 2;

  if (usingGemini) {
    p0 = geminiPhrases[0];
    p1 = geminiPhrases[1] || p0;
    p2 = geminiPhrases[2] || p0;
    coreTerm = geminiPhrases[3] || buildCoreTerm(sectionTitle, topic);
    oaPage = page; // пряме відображення: refresh = наступна сторінка OpenAlex
  } else {
    coreTerm = buildCoreTerm(sectionTitle, topic);
    const specificity = (phrase) =>
      phrase.toLowerCase().split(/\s+/).filter(w => w.length > 4 && !STOP_WORDS.has(w)).length;
    const sortedPhrases = [...allUkKeywords].sort((a, b) => specificity(b) - specificity(a));
    const total = Math.max(sortedPhrases.length, 1);
    const i0 = ((page - 1) * 3) % total;
    p0 = sortedPhrases[i0] || coreTerm;
    p1 = sortedPhrases[(i0 + 1) % total] || p0;
    p2 = sortedPhrases[(i0 + 2) % total] || p0;
    oaPage = Math.floor(((page - 1) * 3) / total) + 1;
  }

  const enQ = enKeywords[0] || '';
  // Робота мовою з localSourceLangCode — r8/r9 шукають цією мовою за темою, інакше польські, як раніше
  const localByTopic = !!(localCode && topic);
  const sideLang = localByTopic ? localCode : 'pl';
  const plQ = localByTopic ? topic : (enQ || p0);

  const [r1, r2, r3, r4, r5, r6, r7, r8, r9, r10, r11, r12] = await Promise.allSettled([
    openAlexSearch(p0, `language:uk,${yr}`, fetchLimit, oaPage),            // r1: full-text uk, p0
    fetchCrossRefUkrainian(p0, fetchLimit),                                  // r2: CrossRef uk, p0
    openAlexTitleSearch(p1, ['language:uk', yr], fetchLimit, oaPage),        // r3: title uk, p1
    openAlexSearch(p2, `language:uk,${yr}`, fetchLimit, oaPage),             // r4: full-text uk, p2
    openAlexTitleSearch(coreTerm, ['language:uk', yr], fetchLimit, oaPage),  // r5: title uk, coreTerm/p3
    openAlexSearch(p1, `language:uk,${yr}`, fetchLimit, oaPage),             // r6: full-text uk, p1
    openAlexTitleSearch(p2, ['language:uk', yr], fetchLimit, oaPage),        // r7: title uk, p2
    openAlexSearch(plQ, `language:${sideLang},${yr}`, fetchLimit, oaPage),   // r8: польські (чи мовою роботи) full-text
    openAlexTitleSearch(plQ, [`language:${sideLang}`, yr], fetchLimit, oaPage), // r9: польські (чи мовою роботи) title
    fetchOpenAlexBooks(p0, fetchLimit),                                       // r10: книги OpenAlex
    fetchCrossRefBooks(p0, fetchLimit),                                       // r11: монографії CrossRef
    fetchBooksGoogle(p0, 8),                                                  // r12: Google Books (books.googleapis.com)
  ]);

  const mapOA = (r, lang) => r.status === 'fulfilled'
    ? r.value.filter(p => p.title && !isBlocked(p)).map(p => mapOpenAlex(p, lang))
    : [];

  const fromR1 = mapOA(r1, 'uk');
  const fromCR = r2.status === 'fulfilled' ? r2.value.filter(p => hasCyrillic(p.title || '')) : [];
  const fromR3 = mapOA(r3, 'uk');
  const fromR4 = mapOA(r4, 'uk');
  const fromR5 = mapOA(r5, 'uk');
  const fromR6 = mapOA(r6, 'uk');
  const fromR7 = mapOA(r7, 'uk');

  // Дедуп + attribution (яка фраза першою знайшла статтю)
  const seen = new Set();
  const allUk = [];
  const phraseAttrib = new Map(); // titleKey → phrase

  const addGroup = (papers, phraseLabel) => {
    for (const p of papers) {
      const key = (p.title || '').toLowerCase().slice(0, 60);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      allUk.push(p);
      if (usingGemini) phraseAttrib.set(key, phraseLabel);
    }
  };

  if (usingGemini) {
    addGroup([...fromR1, ...fromCR], p0);
    addGroup(fromR3, p1);
    addGroup(fromR4, p2);
    addGroup(fromR5, coreTerm);
    addGroup(fromR6, p1);
    addGroup(fromR7, p2);
  } else {
    for (const p of [...fromR1, ...fromCR, ...fromR3, ...fromR4, ...fromR5, ...fromR6, ...fromR7]) {
      const key = (p.title || '').toLowerCase().slice(0, 60);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      allUk.push(p);
    }
  }

  // Скоринг + domainBoost + фільтр за роками
  const withScore = allUk.map(p => ({
    ...p,
    _score: scoreRelevance(p.title.toLowerCase(), allUkKeywords),
  })).sort((a, b) => b._score - a._score);
  const boosted = domainBoost(applyYearFilter(withScore, allUkKeywords), sectionTitle, topic);

  // Іноземні: польські (чи мовою роботи) + англійські; для роботи неукраїнською — 70% (sourceLangQuota)
  const maxForeign = Math.max(1, Math.ceil(needed * (foreignWork ? 0.7 : 0.3)));
  const enQuery = enKeywords.slice(0, 3).join(' ').trim();
  const enRaw = enQuery
    ? await fetchEnglishViaBackend(enKeywords, maxForeign).catch(() => [])
    : [];
  const fromPL = [...mapOA(r8, sideLang), ...mapOA(r9, sideLang)];

  const foreignSeen = new Set();
  const allForeign = [];
  for (const p of [...fromPL, ...enRaw]) {
    const key = (p.title || '').toLowerCase().slice(0, 60);
    if (!key || foreignSeen.has(key)) continue;
    foreignSeen.add(key);
    allForeign.push(p);
  }
  const foreignScored = applyYearFilter(
    allForeign.map(p => ({
      ...p,
      _score: scoreRelevance((p.title || '').toLowerCase(), enKeywords),
    })).sort((a, b) => b._score - a._score),
    enKeywords,
    0,
    ['en'], // enKeywords звіряються з англомовними назвами — на відміну від pl, тут скор має сенс
  );

  const ukSeen = new Set(boosted.slice(0, target).map(p => (p.title || '').toLowerCase().slice(0, 60)));
  const foreignFiltered = foreignScored.filter(p => !ukSeen.has((p.title || '').toLowerCase().slice(0, 60)));

  // ── Книги: OpenAlex + CrossRef + Serper ──
  const fromOABooks    = r10.status === 'fulfilled' ? r10.value : [];
  const fromCRBooks    = r11.status === 'fulfilled' ? r11.value : [];
  const fromSerperBooks = r12.status === 'fulfilled' ? r12.value : [];

  const allArticlesSeen = new Set([
    ...boosted.slice(0, target).map(p => (p.title || '').toLowerCase().slice(0, 60)),
    ...foreignFiltered.slice(0, maxForeign).map(p => (p.title || '').toLowerCase().slice(0, 60)),
  ]);
  const booksSeen = new Set(allArticlesSeen);
  const booksPool = [];
  for (const p of [...fromOABooks, ...fromCRBooks, ...fromSerperBooks]) {
    const key = (p.title || '').toLowerCase().slice(0, 60);
    if (!key || booksSeen.has(key)) continue;
    booksSeen.add(key);
    booksPool.push(p);
  }
  const maxBooks = Math.max(2, Math.ceil(needed * 0.4));
  const booksScored = applyYearFilter(
    booksPool
      .map(p => ({ ...p, _score: scoreRelevance((p.title || '').toLowerCase(), allUkKeywords) }))
      .sort((a, b) => b._score - a._score),
    allUkKeywords,
  ).slice(0, maxBooks);

  const flat = foreignWork
    ? [...foreignFiltered.slice(0, maxForeign), ...boosted.slice(0, target), ...booksScored]
    : [...boosted.slice(0, target), ...foreignFiltered.slice(0, maxForeign), ...booksScored];

  // Групи по Gemini-фразах (порожні якщо фрази не надано)
  let groups = [];
  if (usingGemini) {
    const groupMap = {};
    for (const p of boosted.slice(0, target)) {
      const key = (p.title || '').toLowerCase().slice(0, 60);
      const phrase = phraseAttrib.get(key) || p0;
      if (!groupMap[phrase]) groupMap[phrase] = [];
      groupMap[phrase].push(p);
    }
    // Зберігаємо порядок фраз як у Gemini
    const phraseOrder = [p0, p1, p2, coreTerm].filter((v, i, a) => a.indexOf(v) === i);
    groups = phraseOrder
      .filter(ph => groupMap[ph]?.length)
      .map(ph => ({ phrase: ph, papers: groupMap[ph] }));
  }

  return { flat, groups };
}

// Один ретрай при мережевому збої чи непарситься JSON — раніше перша ж невдача
// тихо поверталась як [] (fail-closed навмисно, але без спроби повторити),
// і якість добору джерел псувалась без сліду. null — обидві спроби не вийшли.
async function requestGeminiJsonWithRetry(body, label, onCost) {
  let lastErr = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(`${getApiBase()}/api/gemini`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await getProxyAuthHeaders()) },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`gemini request failed: ${res.status}`);
      const data = await res.json();
      if (data.usageMetadata) {
        const cost = geminiCost(data, "gemini-2.5-flash-lite");
        reportCost({ cost, model: body._model, inTok: data.usageMetadata.promptTokenCount, outTok: data.usageMetadata.candidatesTokenCount }, onCost);
      }
      const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
      return JSON.parse(raw);
    } catch (e) {
      lastErr = e;
      console.warn(`${label}: спроба ${attempt} не вдалась —`, e.message);
    }
  }
  console.error(`${label}: обидві спроби не вдались, відхиляю все (fail-closed) —`, lastErr?.message);
  return null;
}

// ── Прохід Б («адвокат диявола»): незалежна друга перевірка вже відібраних Проходом А
// кандидатів. Не бачить оцінки/вердикту Проходу А (щоб не якорилась на чужому рішенні) —
// отримує лише назву+анотацію і тезу, і її завдання не підтвердити вибір, а спробувати
// його спростувати. Ловить саме те, що один прохід пропускає: загальнотеоретичний збіг
// лексики в тезі задовольняється джерелом з іншого предмета (інший вид мистецтва/
// діяльності, інша вікова група, країна, період чи галузь) ──
async function devilsAdvocateCheck(shortlist, sectionTitle, topic, thesisContext, onCost) {
  if (!shortlist.length) return shortlist;
  const items = shortlist.map((p, i) => {
    const abstractLine = p.abstract ? `\n   Анотація: ${p.abstract.slice(0, 220)}` : '\n   (анотації немає)';
    return `${i}. ${p.title}${abstractLine}`;
  }).join('\n');
  const thesisLine = thesisContext ? `Конкретна теза: "${thesisContext}"\n` : '';
  const prompt = `Тема наукової роботи: "${topic}"
Підрозділ: "${sectionTitle}"
${thesisLine}
Кандидати, які попередньо визнані релевантними:
${items}

Твоє завдання — не підтвердити цей вибір, а спробувати його СПРОСТУВАТИ. Для кожного кандидата шукай конкретну підставу для відхилення:
- підміна виду мистецтва/діяльності/дисципліни (інший жанр чи галузь, ніж у темі, навіть якщо термінологія схожа);
- підміна вікової групи чи цільової аудиторії;
- підміна країни;
- підміна історичного періоду чи епохи;
- підміна конкретного об'єкта дослідження (інший твір/подія/організація, навіть у тій самій галузі).

Загальний збіг теоретичної лексики без збігу власного предмета статті ("про що вона насправді") — підстава відхилити.
Якщо після ретельного пошуку не знайшов жодної з цих підмін — reject:false.
Якщо знайшов хоч одну — reject:true, коротко вкажи яку.

Поверни JSON: {"results":[{"index":0,"reject":false,"reason":"..."}]}`;
  const parsed = await requestGeminiJsonWithRetry({
    _model: 'gemini-2.5-flash-lite',
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      maxOutputTokens: 1200,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'object',
        properties: {
          results: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                index: { type: 'integer' },
                reject: { type: 'boolean' },
                reason: { type: 'string' },
              },
              required: ['index', 'reject', 'reason'],
            },
          },
        },
        required: ['results'],
      },
    },
  }, 'devilsAdvocateCheck', onCost);
  if (!parsed) return []; // fail-closed — жодна з двох спроб не вийшла
  const results = Array.isArray(parsed.results) ? parsed.results : [];
  const verdictByIdx = new Map(results.filter(r => typeof r.index === 'number').map(r => [r.index, r]));
  return shortlist.filter((_, i) => {
    const v = verdictByIdx.get(i);
    return !!v && v.reject === false; // немає вердикту чи reject:true — відхиляємо
  });
}

// ── Проходить shortlist пачками по BATCH_SIZE, щоб великий список не впирався
// в maxOutputTokens одного виклику devilsAdvocateCheck ──
async function devilsAdvocateCheckBatched(shortlist, sectionTitle, topic, thesisContext, onCost) {
  const batches = chunkArray(shortlist, GEMINI_FILTER_BATCH_SIZE);
  const results = await Promise.all(
    batches.map(batch => devilsAdvocateCheck(batch, sectionTitle, topic, thesisContext, onCost)),
  );
  return results.flat();
}

// Максимум кандидатів на один виклик Gemini-фільтрації: більший список ризикує обрізати
// JSON-відповідь по maxOutputTokens (кожен кандидат — це окремі objectMatch/aspectMatch/
// contextMatch/score/reason у відповіді), і тоді JSON.parse впаде, а виклик тихо поверне 0.
const GEMINI_FILTER_BATCH_SIZE = 25;

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ── Gemini-фільтрація: два незалежні проходи. Прохід А відбирає за трьома обов'язковими
// осями (об'єкт/аспект/контекст), Прохід Б («адвокат диявола») незалежно намагається
// спростувати кожного кандидата з проходу А. Джерело йде далі лише якщо погодились обидва —
// немає "тихого" дефолту: збій запиту чи непарситься відповідь трактуються як "нічого не
// підтверджено", а не як "усе підходить".
// Кандидатів ділимо на пачки по GEMINI_FILTER_BATCH_SIZE — інакше великий список (типово
// для реферату, де фільтрація йде одним викликом на весь підрозділ) ризикує обрізати
// відповідь Gemini по лімту токенів.
// opts.returnPassA: true — повертає {passB, passA} замість самого passB, щоб виклик міг
// добрати з Проходу А для м'якого фолбеку (лише звіт з практики, див. searchSectionSources/
// doSearchSources) — не чіпає жоден з інших 7 викликів цієї функції в проєкті.
export async function filterSourcesWithGemini(candidates, sectionTitle, topic, maxResults = 15, thesisContext = '', onCost, opts = {}) {
  if (!candidates.length) return opts.returnPassA ? { passB: candidates, passA: [] } : candidates;
  const batches = chunkArray(candidates, GEMINI_FILTER_BATCH_SIZE);
  const passAResults = await Promise.all(
    batches.map(batch => filterCandidatesBatch(batch, sectionTitle, topic, thesisContext, onCost)),
  );
  const passA = passAResults.flat();
  console.log(`[filterSourcesWithGemini:${sectionTitle}] кандидатів: ${candidates.length}, пройшло Прохід А: ${passA.length}`);
  if (!passA.length) return opts.returnPassA ? { passB: passA, passA } : passA;
  // Прохід Б: незалежна друга перевірка — не бачить оцінки/причини Проходу А
  const passB = await devilsAdvocateCheckBatched(passA, sectionTitle, topic, thesisContext, onCost);
  console.log(`[filterSourcesWithGemini:${sectionTitle}] пройшло Прохід Б: ${passB.length}`);
  return opts.returnPassA ? { passB, passA } : passB;
}

// ── Прохід А для однієї пачки (≤ GEMINI_FILTER_BATCH_SIZE кандидатів) ──
async function filterCandidatesBatch(candidates, sectionTitle, topic, thesisContext, onCost) {
  if (!candidates.length) return candidates;
  const items = candidates.map((p, i) => {
    const abstractLine = p.abstract
      ? `\n   Анотація: ${p.abstract.slice(0, 220)}`
      : '\n   (анотації немає — суди обережно лише за назвою)';
    return `${i}. ${p.title}${abstractLine}`;
  }).join('\n');
  const thesisLine = thesisContext ? `Конкретна теза, під яку шукаємо джерела: "${thesisContext}"\n` : '';
  const prompt = `Тема наукової роботи: "${topic}"
Підрозділ: "${sectionTitle}"
${thesisLine}
Список знайдених статей (з анотацією, де є):
${items}

Для кожного кандидата перевір ТРИ обов'язкові умови — включай статтю в results лише якщо ВСІ три виконані:
1. ОБ'ЄКТ — власний предмет самої статті (те, про що вона за назвою й анотацією, а не окремий термін, який у ній згадується) — той самий конкретний твір/вид мистецтва чи діяльності/явище/група, що й у темі й тезі, а не просто суміжна галузь чи спільна теоретична лексика. Стаття про ІНШИЙ вид мистецтва чи діяльності (напр. драма чи література, коли тема — балет; фольклорний танець, коли тема — класичний балет; підготовка/педагогіка фахівців, коли тема — аналіз конкретних творів), ІНШИЙ напрям чи епоху (напр. авангард/дадаїзм, коли тема — романтизм) — НЕ проходить об'єкт, навіть якщо в анотації трапляються ті самі абстрактні терміни ("метафізична рефлексія", "тіло і звук як код", "методологічний підхід"). Перевіряй, що стаття написана САМЕ про предмет теми, а не просто використовує суміжну термінологію з іншого приводу.
2. АСПЕКТ — стаття розглядає саме той кут проблеми, який потрібен для цієї тези/підрозділу, а не тему загалом з іншого боку.
3. КОНТЕКСТ — країна, період, вікова група, галузь чи метод дослідження не суперечать обмеженням роботи.

Якщо анотації немає — суди дуже обережно: включай лише коли сама назва однозначно підтверджує всі три умови.
Якщо хоч одна з трьох умов не виконується — НЕ включай статтю, навіть якщо назва виглядає схожою чи термінологія збігається. Загальне теоретичне речення в тезі ("тіло і звук діють як єдиний код", "потребує методологічного підходу") НЕ виправдовує джерело з іншого предмета — воно однаково має бути про той самий об'єкт теми.
Якщо жодна стаття не підходить — поверни порожній масив results. Не підганяй кількість під ліміт — краще менше, ніж хибне.

Для кожної відібраної статті постав objectMatch/aspectMatch/contextMatch (усі true), оцінку score 0-100 (100 = точний збіг за трьома умовами, нижче 70 не включай) і одне речення-причину (до 12 слів).

Поверни JSON: {"results":[{"index":0,"objectMatch":true,"aspectMatch":true,"contextMatch":true,"score":85,"reason":"Розглядає..."}]}`;
  const parsed = await requestGeminiJsonWithRetry({
    _model: 'gemini-2.5-flash-lite',
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      maxOutputTokens: 1600,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'object',
        properties: {
          results: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                index: { type: 'integer' },
                objectMatch: { type: 'boolean' },
                aspectMatch: { type: 'boolean' },
                contextMatch: { type: 'boolean' },
                score: { type: 'integer' },
                reason: { type: 'string' },
              },
              required: ['index', 'objectMatch', 'aspectMatch', 'contextMatch', 'score', 'reason'],
            },
          },
        },
        required: ['results'],
      },
    },
  }, 'filterCandidatesBatch', onCost);
  if (!parsed) return []; // fail-closed — жодна з двох спроб не вийшла
  const results = Array.isArray(parsed.results) ? parsed.results : [];
  return results
    .filter(r =>
      typeof r.index === 'number' && candidates[r.index]
      && r.objectMatch === true && r.aspectMatch === true && r.contextMatch === true
      && typeof r.score === 'number' && r.score >= 70,
    )
    .map(r => ({
      ...candidates[r.index],
      geminiReason: r.reason || '',
      geminiScore: r.score,
    }));
}

// ── Другий раунд добору при нестачі: альтернативні (синоніми/суміжні терміни) пошукові фрази ──
export async function generateAlternatePhrases(topic, sectionTitle, triedPhrases = [], onCost) {
  const prompt = `Тема наукової роботи: "${topic}"
Підрозділ: "${sectionTitle}"
Вже пробували ці пошукові фрази (результатів бракує): ${triedPhrases.join('; ')}

Попередні фрази явно занадто вузькі — бракує результатів під них у наукових базах. Запропонуй 3 НОВІ, СУТТЄВО ШИРШІ пошукові фрази українською: прибери вузькі власні назви (конкретні імена, назви творів) і вузькоспеціальні терміни, залиш лише загальний предмет і суть теми підрозділу — так, як шукав би цю тему науковець, що формулює запит на рівень ширше за вже спробуване, а не просто підбирає синонім до того самого вузького словосполучення.
Поверни JSON: {"phrases":["фраза1","фраза2","фраза3"]}`;
  try {
    const res = await fetch(`${getApiBase()}/api/gemini`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await getProxyAuthHeaders()) },
      body: JSON.stringify({
        _model: 'gemini-2.5-flash-lite',
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 400, responseMimeType: 'application/json' },
      }),
    });
    if (!res.ok) return [];
    const data = await res.json();
    if (data.usageMetadata) {
      const cost = geminiCost(data, "gemini-2.5-flash-lite");
      reportCost({ cost, model: 'gemini-2.5-flash-lite', inTok: data.usageMetadata.promptTokenCount, outTok: data.usageMetadata.candidatesTokenCount }, onCost);
    }
    const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const parsed = JSON.parse(raw);
    return (parsed.phrases || []).map(String).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Шукає DOI в CrossRef за бібліографічними даними для паперів без DOI (у тому числі
 * з URL — результати Google Scholar/CORE теж часто мають DOI, а з ним — сторінки).
 * Повертає той самий об'єкт з доданим doi, лише коли знайдений запис — ТОЙ САМИЙ
 * твір (isSameWork: назва, прізвище першого автора, рік). Раніше бралось перше
 * відповідне CrossRef з двома спільними словами — і до джерела чіплявся DOI (а з
 * ним сторінки, том, журнал) іншої статті зі схожою назвою.
 * opts.line — сирий рядок опису замість відомої назви (ручне введення, джерела клієнта).
 */
export async function lookupDOIByBiblio(paper, { line = '' } = {}) {
  if (paper.doi) return paper;
  const title = (paper.title || '').slice(0, 200);
  if (!line && title.length < 8) return paper;
  const firstAuthorFamily = (Array.isArray(paper.authors) ? (paper.authors[0] || '') : '')
    .split(/[\s,]+/)[0] || '';
  const year = String(paper.year || '');
  try {
    const q = line ? line.slice(0, 250) : [title, firstAuthorFamily, year].filter(Boolean).join(' ');
    const r = await fetch(
      `https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(q)}&rows=5&select=DOI,published,published-print,title,author&mailto=support@academ-assist.vercel.app`,
    );
    if (!r.ok) return paper;
    const d = await r.json();
    const ours = line ? { line } : { title, authors: Array.isArray(paper.authors) ? paper.authors : [], year };
    const item = (d.message?.items || []).find(it => it.DOI && isSameWork(ours, crossrefCandidate(it)));
    return item ? { ...paper, doi: item.DOI } : paper;
  } catch { return paper; }
}

// Кандидати з Google Books (до 5) — вибір робить isSameWork, а не "перший-ліпший"
async function googleBooksCandidates(q) {
  const r = await fetch(
    `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=5`,
    { cache: 'no-store' },
  );
  if (!r.ok) return [];
  const d = await r.json();
  return (d.items || []).map(it => it.volumeInfo).filter(info => info?.title);
}

function booksCandidate(info) {
  return {
    title: [info.title, info.subtitle].filter(Boolean).join(': '),
    authors: info.authors || [],
    year: (info.publishedDate || '').slice(0, 4),
  };
}

/**
 * Шукає загальний обсяг книги (кількість сторінок) через Google Books API.
 * Використовується коли CrossRef/OpenAlex/DOI не дають діапазону сторінок
 * (типово для книг — вони мають лише "загальний обсяг", не "сторінки статті").
 */
export async function fetchGoogleBooksPageCount(title, authorSurname = '', year = '') {
  const cleanTitle = (title || '').slice(0, 120).trim();
  if (!cleanTitle || cleanTitle.length < 8) return null;
  try {
    const qParts = [`intitle:${cleanTitle}`];
    if (authorSurname) qParts.push(`inauthor:${authorSurname}`);
    const infos = await googleBooksCandidates(qParts.join('+'));
    const ours = { title: cleanTitle, authors: authorSurname ? [authorSurname] : [], year };
    const info = infos.find(i => normalizeTotalPages(i.pageCount) && isSameWork(ours, booksCandidate(i)));
    return info ? normalizeTotalPages(info.pageCount) : null;
  } catch { return null; }
}

/**
 * Шукає видавця, рік і обсяг книги через Google Books API за СИРИМ рядком опису
 * (ширший набір полів, ніж fetchGoogleBooksPageCount — для повного збагачення
 * джерела). Збіг — лише коли назва книги майже повністю є в рядку, а автор не суперечить.
 */
async function fetchGoogleBooksInfo(line) {
  const text = (line || '').replace(/https?:\/\/\S+/g, '').replace(/\s{2,}/g, ' ').trim().slice(0, 200);
  if (text.length < 8) return null;
  try {
    const infos = await googleBooksCandidates(text);
    const info = infos.find(i => isSameWork({ line: text }, booksCandidate(i)));
    if (!info) return null;
    return {
      pageCount: normalizeTotalPages(info.pageCount),
      publisher: info.publisher || '',
      year: info.publishedDate ? info.publishedDate.slice(0, 4) : '',
    };
  } catch { return null; }
}

function normTitle(str) {
  if (!str) return str;
  const letters = str.match(/[а-яґєіїА-ЯҐЄІЇa-zA-Z]/g) || [];
  const upper = letters.filter(c => c !== c.toLowerCase()).length;
  if (letters.length > 5 && upper / letters.length > 0.6)
    return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
  return str;
}

// Вставляє елемент опису ("С. 12–19.", "2020. Київ.") перед "URL: …"/"DOI: …"/посиланням —
// раніше вставка йшла між "URL:" і самою адресою ("URL: С. 340–343. https://…").
function insertBeforeUrlElement(line, element) {
  const m = line.match(/\s*(?:(?:URL|DOI)\s*:\s*)?https?:\/\/\S+/i) || line.match(/\s*DOI\s*:\s*10\.\S+/i);
  if (m) {
    const head = line.slice(0, m.index).replace(/[\s.]+$/, '');
    return `${head}. ${element} ${line.slice(m.index).trimStart()}`;
  }
  return line.trimEnd().replace(/[.\s]+$/, '') + `. ${element}`;
}

/**
 * Збагачує один рядок ручного введення — підтягує сторінки.
 *
 * Стратегія (від надійного до ненадійного):
 *  1. DOI в тексті → CrossRef/OpenAlex напряму (не залежить від сайту)
 *  2. CrossRef бібліографічний пошук по тексту рядка (назва + автор + рік)
 *  3. HTML мета-теги через проксі (fallback, може дати 429 або timeout)
 */
export async function enrichManualLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return line;
  // Вже є сторінки ("С. 86", "P. 45–52") чи обсяг книги ("240 с.") — строгий розбір,
  // щоб ініціал з роком ("Kowalski P. 2019") не вважався сторінками
  if (parseRefPages(trimmed)) return line;

  const isUk = /[а-яА-ЯҐЄІЇґєії]/.test(trimmed);

  // Вставляємо сторінки перед елементом "URL: …" (або самим посиланням), інакше — в кінець рядка
  const insertPages = (pages) => {
    const p = pages.replace(/-/g, '–');
    return insertBeforeUrlElement(line, `${isUk ? 'С.' : 'P.'} ${p}.`);
  };

  // ── Крок 1: DOI в тексті (doi.org/10.xxx або bare 10.xxx) ──
  const doiRaw = trimmed.match(/doi\.org\/(10\.\d{4,}\/[^\s"'<>]+)/i)
    || trimmed.match(/(?:^|\s)(10\.\d{4,}\/[^\s"'<>]+)/);
  if (doiRaw) {
    const doi = doiRaw[1].replace(/[.,;)]+$/, '');
    const meta = await lookupDoiMetadata(doi);
    if (meta?.pages) return insertPages(meta.pages);
  }

  // ── Крок 2: CrossRef бібліографічний пошук по тексту ──
  // Сторінки беремо лише з запису, що є ТИМ САМИМ твором (isSameWork: назва майже
  // повністю в рядку, прізвище автора, рік). Раніше бралось перше відповідне CrossRef
  // з перевіркою лише року — і в рядок потрапляли сторінки іншої статті зі схожою назвою.
  const textOnly = trimmed.replace(/https?:\/\/\S+/g, '').replace(/\s{2,}/g, ' ').trim();

  if (textOnly.length > 20) {
    try {
      const q = encodeURIComponent(textOnly.slice(0, 220));
      const r = await fetch(
        `https://api.crossref.org/works?query.bibliographic=${q}&rows=5&select=DOI,page,published,published-print,title,author&mailto=support@academ-assist.vercel.app`,
      );
      if (r.ok) {
        const d = await r.json();
        const item = (d.message?.items || []).find(it => isSameWork({ line: textOnly }, crossrefCandidate(it)));
        const p = item && (normalizePages(item.page) || extractPagesFromDoi(item.DOI));
        if (p) return insertPages(formatPages(p));
      }
    } catch { /* CrossRef недоступний */ }
  }

  // ── Крок 3: сторінка журналу за посиланням — мета-теги, а якщо їх немає, то PDF статті ──
  const urlMatch = trimmed.match(/https?:\/\/\S+/);
  if (urlMatch) {
    const url = urlMatch[0].replace(/[.,;)#]+$/, '');
    const meta = await fetchUrlMeta(url);
    const fromMeta = normalizePages(meta?.pages);
    if (fromMeta) return insertPages(formatPages(fromMeta));
    if (meta?.pdfUrl) {
      const pdf = await fetchPdfPages(meta.pdfUrl);
      const fromPdf = normalizePages(pdf?.pages);
      if (fromPdf) return insertPages(formatPages(fromPdf));
    }
  }

  // ── Крок 4: без URL і без DOI — це, ймовірно, книга. Пробуємо загальний
  // обсяг через Google Books (окрема сторінка для конкретної цитати з книги
  // об'єктивно невідома — але хоча б діапазон 1–N дає з чого обрати) ──
  const looksLikeArticle = /№|Вип\.|Vol\.|No\.|pp?\.\s*\d/i.test(textOnly);
  if (!urlMatch && !looksLikeArticle && textOnly.length > 8) {
    const books = await fetchGoogleBooksInfo(textOnly);
    if (books?.pageCount) {
      const suffix = isUk ? `${books.pageCount} с.` : `${books.pageCount} p.`;
      return line.trimEnd().replace(/[.\s]+$/, '') + `. ${suffix}`;
    }
  }

  return line;
}

/**
 * Збагачує один рядок джерела (типово — з клієнтської готової частини роботи,
 * де джерела часто оформлені без частини даних) повнішою бібліографічною
 * інформацією: рік, том/випуск, видавництво, журнал, сторінки.
 * На відміну від enrichManualLine (лише сторінки), тут додаються всі поля,
 * яких у рядку явно бракує; сам стиль оформлення виправляє подальший LLM-крок
 * конвеєра (formatSourcesWithRetry), тому дані просто дописуються в кінець.
 *
 * Стратегія пошуку та сама, що й у enrichManualLine:
 *  1. DOI в тексті → CrossRef/OpenAlex напряму
 *  2. CrossRef бібліографічний пошук за назвою+автором+роком → DOI → повні метадані
 *  3. Немає URL і не схоже на статтю → ймовірно книга → Google Books
 */
export async function enrichFullSourceInfo(line) {
  const trimmed = line.trim();
  if (!trimmed) return line;

  const isUk = /[а-яА-ЯҐЄІЇґєії]/.test(trimmed);
  const hasYear = /\b(19|20)\d{2}\b/.test(trimmed);
  const hasPages = !!parseRefPages(trimmed);
  const hasVolIssue = /(Vol\.|Т\.\s*\d|№\s*\d|No\.\s*\d)/i.test(trimmed);
  const textOnly = trimmed.replace(/https?:\/\/\S+/g, '').replace(/\s{2,}/g, ' ').trim();
  const looksSparse = textOnly.split(/\s+/).filter(Boolean).length < 12;

  let meta = null;

  // ── Крок 1: DOI в тексті ──
  const doiRaw = trimmed.match(/doi\.org\/(10\.\d{4,}\/[^\s"'<>]+)/i)
    || trimmed.match(/(?:^|\s)(10\.\d{4,}\/[^\s"'<>]+)/);
  if (doiRaw) {
    const doi = doiRaw[1].replace(/[.,;)]+$/, '');
    meta = await lookupDoiMetadata(doi);
  }

  // ── Крок 2: без DOI — шукаємо його за бібліографічними даними, тоді тягнемо повні метадані ──
  if (!meta && textOnly.length > 20) {
    // межі назви в сирому рядку невідомі — звіряємо рядок цілком (line-режим isSameWork)
    const withDoi = await lookupDOIByBiblio({}, { line: textOnly });
    if (withDoi.doi) meta = await lookupDoiMetadata(withDoi.doi);
  }

  const extras = [];
  if (meta) {
    if (meta.year && !hasYear) extras.push(String(meta.year));
    if (!hasVolIssue) {
      const vi = [];
      if (meta.volume) vi.push(isUk ? `Т. ${meta.volume}` : `Vol. ${meta.volume}`);
      if (meta.issue) vi.push(isUk ? `№ ${meta.issue}` : `No. ${meta.issue}`);
      if (vi.length) extras.push(vi.join(', '));
    }
    if (meta.journal && looksSparse) extras.push(meta.journal);
    if (meta.publisher && looksSparse) extras.push([meta.publisher, meta.publisherLocation].filter(Boolean).join(', '));
    if (meta.pages && !hasPages) extras.push((isUk ? 'С. ' : 'P. ') + meta.pages);
  }

  // Сторінок у базах немає, але є посилання на статтю — мета-теги сайту журналу чи PDF
  const urlMatch = trimmed.match(/https?:\/\/\S+/);
  if (!hasPages && !meta?.pages && urlMatch) {
    const url = urlMatch[0].replace(/[.,;)#]+$/, '');
    const pageMeta = await fetchUrlMeta(url);
    let p = normalizePages(pageMeta?.pages);
    if (!p && pageMeta?.pdfUrl) p = normalizePages((await fetchPdfPages(pageMeta.pdfUrl))?.pages);
    if (p) extras.push((isUk ? 'С. ' : 'P. ') + formatPages(p));
  }

  // ── Крок 3: без DOI-збігу, без URL, не схоже на статтю — ймовірно книга ──
  const looksLikeArticle = /№|Вип\.|Vol\.|No\.|pp?\.\s*\d/i.test(textOnly);
  if (!meta && !urlMatch && !looksLikeArticle && textOnly.length > 8) {
    const books = await fetchGoogleBooksInfo(textOnly);
    if (books) {
      if (books.year && !hasYear) extras.push(String(books.year));
      if (books.publisher && looksSparse) extras.push(books.publisher);
      if (books.pageCount && !hasPages) extras.push(isUk ? `${books.pageCount} с.` : `${books.pageCount} p.`);
    }
  }

  if (!extras.length) return line;
  return insertBeforeUrlElement(line, extras.join('. ') + '.');
}

export function paperToCitation(paper) {
  const isUk = paper.lang !== 'en';
  const authorsList = cleanAuthorList(paper.authors);
  // ДСТУ: коли автор невідомий — починаємо з назви (без "Автор невідомий")
  const authorsPart = authorsList.length ? `${authorsList.join(', ')}. ` : '';
  // домен сайту чи обрізана Scholar-ом назва ("Актуальні питання …") журналом не є — краще без неї
  const venue = !isBadVenue(paper.venue) ? ` *${cleanMetaText(paper.venue)}*.` : '';
  let issuePart = '';
  if (paper.volume) issuePart += isUk ? ` Вип. ${paper.volume}.` : ` Vol. ${paper.volume}.`;
  if (paper.issue) issuePart += isUk ? ` № ${paper.issue}.` : ` No. ${paper.issue}.`;
  // Стаття — "С. 12–19." (перевірений діапазон); книга без діапазону — загальний
  // обсяг "240 с." в кінці опису (ДСТУ), щоб його бачили і менеджер, і розбір сторінок
  let articlePages = normalizePages(paper.pages);
  let total = null;
  if (paper.type === 'book' && (!articlePages || articlePages.first === articlePages.last)) {
    // одне число в pages книги — старі записи Google Books, де так лежав загальний обсяг
    total = normalizeTotalPages(paper.totalPages) || (articlePages ? normalizeTotalPages(articlePages.first) : null);
    articlePages = null;
  }
  const pages = articlePages
    ? ` ${isUk ? 'С.' : 'P.'} ${formatPages(articlePages)}.`
    : total ? ` ${total} ${isUk ? 'с.' : 'p.'}` : '';
  const rawUrl = paper.url || (paper.doi ? `https://doi.org/${paper.doi}` : '');
  const urlPart = rawUrl ? ` URL: ${rawUrl}.` : '';
  return `${authorsPart}${normTitle(paper.title)}.${venue} ${paper.year}.${issuePart}${pages}${urlPart}`.replace(/\.\s*\./g, '.').replace(/\s{2,}/g, ' ').trim();
}

export async function generateSearchPhrases(sectionLabel, topic, direction = '', subject = '', onCost) {
  const domainCtx = [direction, subject].filter(Boolean).join(', ');
  const prompt = `Тема наукової роботи: "${topic}"${domainCtx ? `\nГалузь: ${domainCtx}` : ''}
Підрозділ: "${sectionLabel}"

Згенеруй пошукові фрази для пошуку в наукових базах (OpenAlex, CrossRef, Semantic Scholar).
Потрібно:
- 4 фрази УКРАЇНСЬКОЮ (3–5 слів, реальні академічні формулювання)
- 4 фрази АНГЛІЙСЬКОЮ (3–5 слів, academic English equivalents)
- Кожна фраза — різний аспект підрозділу
- Лише ключові слова, без прийменників і сполучників

Поверни JSON: {"phrases":["укр 1","укр 2","укр 3","укр 4","en 1","en 2","en 3","en 4"]}`;
  try {
    const res = await fetch(`${getApiBase()}/api/gemini`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await getProxyAuthHeaders()) },
      body: JSON.stringify({
        _model: 'gemini-2.5-flash-lite',
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 400, responseMimeType: 'application/json' },
      }),
    });
    if (!res.ok) return [];
    const data = await res.json();
    if (data.usageMetadata) {
      const cost = geminiCost(data, "gemini-2.5-flash-lite");
      reportCost({ cost, model: 'gemini-2.5-flash-lite', inTok: data.usageMetadata.promptTokenCount, outTok: data.usageMetadata.candidatesTokenCount }, onCost);
    }
    const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const parsed = JSON.parse(raw);
    return (parsed.phrases || []).filter(p => typeof p === 'string' && p.trim().length > 3).slice(0, 8);
  } catch {
    return [];
  }
}

// ── Автозбагачення метаданих + гейт повноти для вже релевантних (Прохід А+Б) джерел ──
// Викликається одразу після filterSourcesWithGemini, до вставки в suggestedSources — щоб
// автовставка (SourcesStage.jsx buildTop) оцінювала вже збагачені дані, а не сирі з
// пошукового API, де авторів/сторінок часто бракує, хоча вони доступні через DOI.
// Позначає кожне джерело полями _complete/_missingFields: чого не вдалось знайти
// в жодній базі після реальної спроби — того чесно бракує, воно не автовставляється,
// а йде в список ручного вибору з поясненням, що саме відсутнє.
export async function enrichSources(papers) {
  if (!papers.length) return papers;

  // 1) DOI за бібліографічними даними — і для джерел з URL (Google Scholar, CORE): з DOI
  //    приходять сторінки, том, журнал. Лише коли знайдений запис — той самий твір
  //    (isSameWork), тож чужий DOI зі схожою назвою більше не чіпляється.
  const withDoi = await Promise.all(papers.map(async p => {
    if (p.doi || p.source === 'institutional') return p;
    return lookupDOIByBiblio(p);
  }));

  // 2) Метадані за DOI. _doiResolved: чи справді підтвердився DOI живим запитом до
  //    CrossRef/OpenAlex — null, якщо DOI взагалі немає (перевіряти нема чим).
  //    Сторінки з бази важливіші за вгадані з кінця DOI (pagesSrc "doi").
  const afterDoi = await Promise.all(withDoi.map(async p => {
    if (!p.doi) return { ...p, _doiResolved: null };
    const meta = await lookupDoiMetadata(p.doi);
    if (!meta) return { ...p, _doiResolved: false };
    const takePages = meta.pages && (!p.pages || (p.pagesSrc === 'doi' && meta.pagesSrc !== 'doi'));
    return {
      ...p,
      _doiResolved: true,
      ...(meta.authorsStructured?.length ? { authorsStructured: meta.authorsStructured } : {}),
      ...(meta.authors?.length ? { authors: meta.authors } : {}),
      ...(takePages ? { pages: meta.pages, pagesSrc: meta.pagesSrc } : {}),
      ...(meta.volume ? { volume: meta.volume } : {}),
      ...(meta.issue ? { issue: meta.issue } : {}),
      ...(meta.journal && isBadVenue(p.venue) ? { venue: meta.journal } : {}),
      ...(meta.publisher ? { publisher: meta.publisher } : {}),
      ...(meta.publisherLocation ? { publisherLocation: meta.publisherLocation } : {}),
    };
  }));

  // 3) Сторінка статті на сайті журналу (один запит на джерело, кеш): мета-теги
  //    сторінок, посилання на PDF статті (для кроку 4 і вибору сторінки за змістом) і
  //    прапорець "сторінка відкривається" для перевірки існування (раніше — окремий запит).
  const afterMeta = await Promise.all(afterDoi.map(async p => {
    if (p.type === 'book' || p.source === 'institutional') return p;
    const pageUrl = p.url || (p.doi ? `https://doi.org/${p.doi}` : null);
    if (!pageUrl) return p;
    const meta = await fetchUrlMeta(pageUrl);
    if (!meta) return p;
    const out = {
      ...p,
      ...(pageUrl === p.url ? { _urlOk: meta.urlOk === true } : {}),
      // повна назва журналу зі сторінки статті (citation_journal_title / DC.Source) — коли
      // пошук дав домен чи обрізану назву (Google Scholar), а DOI не знайшовся
      ...(meta.journal && isBadVenue(p.venue) && !isBadVenue(meta.journal) ? { venue: cleanMetaText(meta.journal) } : {}),
      ...(meta.pdfUrl ? { pdfUrl: meta.pdfUrl } : {}),
    };
    if (p.pages && p.pagesSrc !== 'doi') return out;
    const mp = normalizePages(meta.pages);
    return mp ? { ...out, pages: formatPages(mp), pagesSrc: 'meta' } : out;
  }));

  // 4) PDF статті — коли ні бази, ні мета-теги сторінок не дали (чи дали лише вгадані
  //    з кінця DOI): номери сторінок у колонтитулах, звірені з кількістю сторінок PDF.
  //    PDF без жодного номера (електронне видання) → noPages: сторінок немає взагалі.
  const afterPdf = await mapLimit(afterMeta, 4, async p => {
    if (p.type === 'book' || !p.pdfUrl || (p.pages && p.pagesSrc !== 'doi')) return p;
    const pdf = await fetchPdfPages(p.pdfUrl);
    const pp = normalizePages(pdf?.pages);
    if (pp) return { ...p, pages: formatPages(pp), pagesSrc: 'pdf' };
    if (pdf?.noPages && !p.pages) return { ...p, noPages: true };
    return p;
  });

  // 5) Книги — загальний обсяг через Google Books (лише той самий твір)
  const enriched = await Promise.all(afterPdf.map(async p => {
    if (p.type !== 'book' || p.pages || p.totalPages) return p;
    const firstAuthorSurname = (Array.isArray(p.authors) ? (p.authors[0] || '') : '').split(/[\s,]+/)[0] || '';
    const totalPages = await fetchGoogleBooksPageCount(p.title, firstAuthorSurname, p.year);
    return totalPages ? { ...p, totalPages, pagesSrc: 'books' } : p;
  }));

  // Перевірка існування: DOI резолвиться живим запитом, АБО (коли DOI немає) URL
  // справді відкривається. Без жодного з двох — джерело не можна вважати підтвердженим,
  // хай навіть назва виглядає правдоподібно.
  const verified = await Promise.all(enriched.map(async ({ _urlOk, ...p }) => {
    if (p._doiResolved === true) return p;
    if (p._doiResolved === false) return { ...p, _unverified: true }; // DOI є, але не резолвиться
    if (p.url) {
      const ok = _urlOk ?? await verifyUrlOpens(p.url);
      return ok ? p : { ...p, _unverified: true };
    }
    return { ...p, _unverified: true }; // ні DOI, ні URL — нічим підтвердити
  }));

  // Гейт повноти: рік, видання/видавництво мають бути присутні, а існування — підтверджене.
  // Для книг вимагаємо саме видавця (не будь-яке "видання") і обсяг сторінок —
  // ISBN/каталог послідовно недоступні з наявних API, тому видавець+обсяг — реалістичний
  // мінімум. Авторів навмисно не вимагаємо жорстко — ДСТУ 8302 дозволяє легітимні записи
  // без автора (інституційні звіти тощо), paperToCitation це коректно обробляє.
  // Анотація — не блокує _complete: для вузьких/спеціальних тем вона часто недоступна
  // через API навіть у справді релевантних і підтверджених (DOI/URL) джерел. Лишається
  // видимою в _missingFields як інформаційний бейдж, щоб користувач бачив прогалину.
  return verified.map(p => {
    const missing = [];
    const missingSoft = [];
    if (!p.year) missing.push('рік');
    if (p.type === 'book') {
      if (!p.publisher) missing.push('видавець');
      if (!p.pages && !p.totalPages) missing.push('обсяг сторінок');
    } else if (!p.venue && !p.publisher && !p.site) {
      // сайт журналу (Google Scholar) рахувався "виданням" і раніше — тоді домен лежав у venue
      missing.push('видання/видавництво');
    }
    if (!p.abstract) missingSoft.push('анотація');
    // Сторінки статті — м'яка позначка (як анотація): не блокує автовставку, але
    // менеджер бачить, що в посиланнях на це джерело сторінки не буде. Електронні
    // видання без сторінок (noPages) і офіційні сайти — не прогалина.
    if (p.type !== 'book' && p.source !== 'institutional' && !p.pages && !p.noPages) missingSoft.push('сторінки');
    // відомий лише сайт, назви журналу не знайшли ніде — в описі джерела її не буде
    if (p.type !== 'book' && isBadVenue(p.venue) && p.site) missingSoft.push('назва видання');
    if (p._unverified) missing.push('не підтверджено існування джерела (DOI/посилання)');
    return { ...p, _complete: missing.length === 0, _missingFields: [...missing, ...missingSoft] };
  });
}

// Чи відомі сторінки джерела: діапазон статті, обсяг книги, або підтверджено, що
// сторінок немає (електронне видання) — усе це "повні" дані для посилання.
export function hasKnownPages(p) {
  return !!(p?.pages || p?.totalPages || p?.noPages);
}

// Порядок кандидатів для автовставки (SourcesStage.jsx і autoSelectSources у воркері —
// один компаратор, щоб UI і headless обирали однаково): спершу оцінка релевантності,
// а за однакової оцінки — джерело з відомими сторінками.
export function compareForAutoInsert(a, b) {
  const byScore = (b.geminiScore ?? 100) - (a.geminiScore ?? 100);
  if (byScore !== 0) return byScore;
  return Number(hasKnownPages(b)) - Number(hasKnownPages(a));
}
