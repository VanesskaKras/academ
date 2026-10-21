// ─────────────────────────────────────────────
// correctionAgent.js — агентний режим "правок": замість "один промпт → JSON
// {original, replacement} → заміна наосліп" (classic, correctionStages.js) ШІ
// працює з документом через інструменти так само, як Claude Code з кодом —
// читає потрібні абзаци, шукає, робить точкову правку, бачить результат і, якщо
// треба, виправляє ще раз, а в кінці сам звітує, що не вдалося. Тип правки не
// вгадується регулярками — ШІ сам вирішує, чи зауваження стосується одного
// місця, чи всієї роботи.
//
// Працює на тих самих zip/docXml (docxSurgicalEdit.js), що й classic, тож
// однаково виконується в браузері й у воркері (io — Node-ін'єкція з
// worker/docxNodeIO.js). Детерміновані частини (сторінки в цитатах,
// перебудова списку джерел) не переписані заново, а викликаються як
// інструменти через applyCorrectionTasks — та сама логіка, що в classic.
//
// Що контролює КОД, а не ШІ:
// - абзаци мають постійні мітки ([12], нові — [n1]) — не зсуваються після
//   вставок/видалень, тож агент не може "промахнутися" застарілим номером;
// - видалення звіряє початок абзацу; не видаляє рисунки, формули, частини полів;
// - нові посилання [N] — лише на наявні джерела, у ВИСНОВКАХ — жодних нових;
//   у роботах з посиланнями "(Автор, рік)" — лише на авторів зі списку;
// - маркери [КЛІЄНТ-ІЛЮСТРАЦІЯ:N] не губляться; таблиці markdown/код схем
//   у текст не потрапляють;
// - finish приймається, лише коли кожне зауваження виконано, закрито або
//   внесено в "потребує перевірки", і обсяг у межах.
//
// ctx — { callClaude, costTracker?, onProgress?(msg), onCost?, io?, callClaudeMessage? }
//   callClaude — потрібен лише інструментам restructure_sources/fix_citation_pages
//   (вони йдуть через classic-шлях); сам цикл — callClaudeMessage з api.js
//   (ctx.callClaudeMessage — підміна для тестів).
// ─────────────────────────────────────────────
import { MODEL, callClaudeMessage } from "./api.js";
import { buildSYS } from "./prompts.js";
import { stripEmDash, countWords } from "./wordCount.js";
import {
  refreshTextMap, applyDocxReplacement, removeDocxComment, getParagraphs,
  insertParagraphsAfterEl, insertParagraphsBeforeEl, deleteParagraphEls, readStyleNames,
  paragraphInfo, paragraphInlineMarkers, clearAttentionMarkers,
} from "./docxSurgicalEdit.js";
import { locateSourcesZone } from "./citationFormatting.js";
import { isReddishColor } from "./docxAnnotations.js";
import { locateFragment } from "./textFragmentLocate.js";
import { applyCorrectionTasks, buildCitationPagesTask } from "./correctionStages.js";
import { getLangLabels } from "./planUtils.js";
import { normalizeWorkType } from "./academicDefaults.js";

// Та сама умовна "сторінка", що й при генерації (enforceTotalVolume в orderStages.js).
const WORDS_PER_PAGE = 230;
const STEP_MAX_TOKENS = 12000;
// Повний текст роботи в контексті — лише до цього розміру (кирилиця "важка" в
// токенах: більший диплом разом з історією кроків не влазить у контекст моделі).
const FULL_TEXT_MAX_CHARS = 150000;
// Коли історія розмови перевищує цей обсяг — давні результати читання
// замінюються короткою приміткою (їх можна перечитати).
const CONVO_COMPACT_CHARS = 350000;
const READ_MAX_PARAGRAPHS = 80;
const READ_MAX_CHARS = 25000;
const MAX_VOLUME_REJECTS = 2;
const MAX_REMARK_REJECTS = 1;
const ILLUSTRATION_MARKER_RE = /\[КЛІЄНТ-ІЛЮСТРАЦІЯ:\d+\]/g;
const TAB_MARK = "⇥";
const BR_MARK = "↵";
const CAPTION_RE = /^(Рис\.|Рисунок|Таблиця|Табл\.|Fig\.|Figure|Table|Rys\.|Tabela|Abb\.|Tabelle|Obr\.|Tabulka)\s*[А-ЯA-Z]?\s*\d/i;
const SOURCES_LINE_RE = /^(СПИСОК ВИКОРИСТАНИХ ДЖЕРЕЛ(?: ТА ЛІТЕРАТУРИ)?|СПИСОК ВИКОРИСТАНОЇ ЛІТЕРАТУРИ|СПИСОК ЛІТЕРАТУРИ|СПИСОК ДЖЕРЕЛ|ВИКОРИСТАНІ ДЖЕРЕЛА|ВИКОРИСТАНА ЛІТЕРАТУРА|REFERENCES|LIST OF REFERENCES|WORKS CITED|BIBLIOGRAPHY|LITERATURVERZEICHNIS|BIBLIOGRAFIA|BIBLIOGRAFÍA|SEZNAM POUŽITÉ LITERATURY|ZOZNAM POUŽITEJ LITERATÚRY|参考文献)$/i;

const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ── Обсяг основної частини роботи — від заголовка ВСТУП до кінця списку джерел
// (без титулки, змісту й додатків), тобто те саме, що при генерації рахується
// як сума sec.pages × 230 слів. lines — абзаци (plainText.split("\n")).
// "ВСТУП" береться той, після якого справді йде текст (а не рядок змісту), і
// додатки шукаються лише після списку джерел — інакше, якщо зміст набрано
// окремими рядками, рахувався б обсяг самого змісту. ──
export function measureMainVolume(lines, lang = "Українська") {
  const labels = getLangLabels(lang);
  const introRe = new RegExp(`^(${escRe(labels.intro)}|ВСТУП|INTRODUCTION)$`, "i");
  const appendixRe = new RegExp(`^(${escRe(labels.appendixWord)}|ДОДАТКИ|APPENDICES)$|^(ДОДАТОК|APPENDIX|${escRe(labels.appendixSingular)})\\s*[А-ЯҐЄІЇA-Z0-9]{1,2}(?=$|[\\s.:–-])`, "i");
  const candidates = [];
  lines.forEach((l, i) => { if (introRe.test(l.trim())) candidates.push(i); });
  // Справжній ВСТУП: до наступного заголовка (рядка великими літерами, як у
  // змісті) є хоч один повноцінний абзац.
  const headingLike = t => {
    const letters = t.replace(/[^A-Za-zА-Яа-яҐґЄєІіЇї]/g, "");
    return letters.length >= 4 && t === t.toUpperCase() && t.length < 150;
  };
  const followedByText = i => {
    let seen = 0;
    for (let k = i + 1; k < lines.length && seen < 5; k++) {
      const t = lines[k].trim();
      if (!t) continue;
      seen++;
      if (headingLike(t) || introRe.test(t)) return false;
      if (t.length >= 150) return true;
    }
    return false;
  };
  let from = candidates.find(followedByText);
  if (from == null) from = candidates.length ? candidates[candidates.length - 1] : 0;
  const sourcesIdx = lines.findIndex((l, i) => i > from && SOURCES_LINE_RE.test(l.trim()));
  let to = lines.length;
  for (let i = Math.max(from, sourcesIdx) + 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t.length < 80 && appendixRe.test(t)) { to = i; break; }
  }
  const words = lines.slice(from, to).reduce((sum, l) => sum + (l.trim() ? countWords(l) : 0), 0);
  return { words, from, to };
}

// Замовлений обсяг: "30", "30-35", "30–35 стор. (±10%)", "7000 слів" → діапазон.
// Беремо лише перший діапазон або перше число — інші числа в рядку ("шрифт 14",
// "±10%") до обсягу не належать.
export function parsePagesRange(pages) {
  const s = pages == null ? "" : String(pages);
  const range = s.match(/(\d+)\s*[-–—]\s*(\d+)/);
  const single = s.match(/\d+/);
  if (!range && !single) return null;
  const lo = Number(range ? range[1] : single[0]);
  const hi = Number(range ? range[2] : single[0]);
  if (!lo || !hi) return null;
  return { lo: Math.min(lo, hi), hi: Math.max(lo, hi), words: /слів|слова|слово|words?\b/i.test(s) };
}

// ── Допустимі межі обсягу після правок.
// Звичайно: не більше ±10% від обсягу до правок і в межах замовленого (±5%).
// relaxed (зауваження прямо вимагає дописати/скоротити роботу): у межах
// замовленого ±5%, а якщо його не відомо — ±25% від стартового.
// Межі ніколи не вужчі за стартовий обсяг: правки не мусять виправляти чужий
// недолік, але й не мають його погіршити. ──
export function volumeBounds({ beforeWords, pages, relaxed = false }) {
  const r = parsePagesRange(pages);
  const around = k => ({ lo: Math.round(beforeWords * (1 - k)), hi: Math.round(beforeWords * (1 + k)), fromOrder: false });
  if (!r) return around(relaxed ? 0.25 : 0.1);
  const per = r.words ? 1 : WORDS_PER_PAGE;
  const oLo = Math.round(r.lo * per * 0.95);
  const oHi = Math.round(r.hi * per * 1.05);
  if (relaxed) return { lo: Math.min(oLo, beforeWords), hi: Math.max(oHi, beforeWords), fromOrder: true };
  return {
    lo: Math.min(beforeWords, Math.max(oLo, Math.round(beforeWords * 0.9))),
    hi: Math.max(beforeWords, Math.min(oHi, Math.round(beforeWords * 1.1))),
    fromOrder: true,
  };
}

// ── Правила роботи агента — статичні, кешуються разом із tools. ──
const AGENT_RULES = `УВАГА: ти зараз НЕ пишеш роботу з нуля, а ВИПРАВЛЯЄШ готовий файл Word. Правила з попередніх інструкцій про таблиці markdown (рядки з "|"), схеми plantuml, графіки й рисунки тут НЕ діють: таблиць, рисунків, схем і формул ти створювати не можеш — якщо зауваження цього вимагає, внеси його в needs_review. Markdown (**, #, "- " на початку рядка) не використовуй — лише звичайний текст.

Ти — досвідчений автор і редактор академічних робіт. Тобі дали готову роботу і зауваження до неї (від викладача, керівника чи клієнта). Твоє завдання — виконати КОЖНЕ зауваження повністю й якісно, так, ніби ти сам автор цієї роботи, і не зіпсувати решту тексту.

ЯК ПРАЦЮВАТИ
- Документ — це абзаци з ПОСТІЙНИМИ мітками: [12] — вихідні абзаци, [n1], [n2]… — додані тобою. Мітки не змінюються після вставок і видалень — посилайся на них.
- Позначки після мітки: |заголовок, |таблиця (абзац у клітинці таблиці), |рисунок, |формула, |список, |підпис (підпис рисунка/таблиці). ${TAB_MARK} — табуляція, ${BR_MARK} — розрив рядка всередині абзацу: це не символи тексту, у old/new їх не пиши.
- Перш ніж щось змінювати, прочитай місце правки (і, якщо зауваження змістовне, — сусідній контекст). Не редагуй наосліп.
- Після кожної зміни інструмент показує новий вигляд абзацу — переконайся, що вийшло саме те, що треба.
- Зауваження, що стосується всієї роботи ("по всьому тексту", "скрізь", типова помилка, що повторюється), — знайди search-ем УСІ такі місця й виправ кожне.
- replace_text змінює текст у межах ОДНОГО абзацу; змінюються лише відмінні слова, решта форматування зберігається. Щоб переписати абзац повністю — передай як old увесь його текст. Нові абзаци — лише через insert_paragraphs.
- insert_paragraphs сам підбирає оформлення звичайного тексту, якщо вставляєш після заголовка, таблиці, рисунка чи підпису. Для нового заголовка передай style_like = мітку наявного заголовка того ж рівня. Вставка "після" абзацу таблиці ставить текст ПІСЛЯ всієї таблиці (in_table_cell:true — у саму клітинку).
- Довгий новий текст (підрозділ) вставляй частинами — не більше ~1500 слів за один виклик.
- Кожне зауваження з мітками (#H, #C, #N, #P) має бути або виконане, або закрите через resolve (якщо змін не потрібно — з поясненням), або внесене в needs_review у finish (з міткою зауваження, напр. "#H3: …"). Коментар Word (#C) після виконання теж закрий через resolve.
- Коли все виконано — виклич finish. Код перевірить, що всі зауваження опрацьовано й обсяг у межах, і поверне тебе, якщо ні.

ЯКІСТЬ
- Змінюй лише те, чого стосується зауваження. Стиль, мова, термінологія, науковий регістр — як у решті роботи. Пиши відповідно до типу роботи, теми й предмета із замовлення — не відходь від теми.
- Якщо зауваження не просить розширити чи скоротити — зберігай приблизно той самий обсяг фрагмента. Якщо просить дописати/розширити — пиши повноцінний змістовний текст, а не одне речення.
- Виділений фрагмент (#H) без окремої вказівки означає "тут проблема — виправ або перепиши". Якщо всередині виділення чи нотатки є питання/звернення керівника до автора — це НЕ текст роботи: дай на нього відповідь по суті в тексті (якщо вона однозначно випливає з контексту) і прибери саме питання. Нотатки, вписані в текст кольором шрифту (#N), після виконання обов'язково прибери з тексту.
- Не вигадуй фактів, цифр, дат, назв підприємств, авторів чи джерел. Якщо для виконання потрібні дані, яких немає ні в роботі, ні в матеріалах клієнта (read_client_materials), — не вигадуй, внеси в needs_review.
- Не додавай від себе приміток, пояснень, звернень до читача чи згадок про ШІ — у тексті роботи лише сам текст роботи.

ОБСЯГ
- Загальний обсяг основної частини має лишитися в межах, указаних нижче (їх перевіряє код). Після кожної зміни інструмент показує поточний обсяг. Якщо зауваження змушують дописати більше, ніж дозволяють межі, — компенсуй, скоротивши повтори й другорядні деталі в інших підрозділах основної частини; якщо текст скоротився — допиши змістовно там, де це доречно. Вступ, висновки і список джерел для компенсації не використовуй.
- Якщо зауваження ПРЯМО вимагає збільшити чи зменшити обсяг роботи ("допишіть 3 сторінки", "скоротіть роботу") — виконай без компенсації і вкажи це зауваження в finish.volume_change_reason.

УЗГОДЖЕНІСТЬ
- Додав, прибрав чи переставив підрозділ, таблицю або рисунок — онови нумерацію наступних і всі посилання на них у тексті ("табл. 2.3", "рис. 1.2", "у підрозділі 1.3").
- Змінилась кількість джерел, таблиць, рисунків, сторінок чи додатків — онови ці числа там, де вони названі (зазвичай у вступі — "Структура роботи", і в анотації, якщо вона є).

СТРУКТУРНІ ОБМЕЖЕННЯ
- Посилання [N] — лише на джерела, які вже є в списку. Додати/прибрати джерело зі списку — лише через restructure_sources (він сам перенумерує посилання по всьому тексту); вручну нумерацію списку джерел не змінюй.
- Сторінки в посиланнях поза межами джерела — через fix_citation_pages.
- ВСТУП: зберігай усі стандартні структурні елементи (актуальність, мета, завдання, об'єкт, предмет, методи, практичне значення, структура роботи) в тому ж порядку.
- ВИСНОВКИ: по абзацу на пункт, без нумерації і без посилань на джерела.
- Рядки-маркери [КЛІЄНТ-ІЛЮСТРАЦІЯ:N], підписи рисунків і таблиць не видаляй і не змінюй, якщо зауваження прямо цього не вимагає.`;

const ID_SCHEMA = { type: ["integer", "string"], description: "мітка абзацу: 12 або \"n1\"" };

const TOOLS = [
  {
    name: "read_paragraphs",
    description: "Прочитати абзаци документа в порядку тексту — від мітки from до мітки to включно (не більше 80 абзаців). Без to — 40 абзаців від from.",
    input_schema: { type: "object", properties: { from: ID_SCHEMA, to: ID_SCHEMA }, required: ["from"] },
  },
  {
    name: "search",
    description: "Знайти абзаци, що містять текст (без урахування регістру; пробіли/лапки/тире — гнучко). regex:true — регулярний вираз JavaScript.",
    input_schema: { type: "object", properties: { query: { type: "string" }, regex: { type: "boolean" } }, required: ["query"] },
  },
  {
    name: "replace_text",
    description: "Замінити фрагмент old на new у межах одного абзацу. old має точно (пробіли/лапки/тире — гнучко) збігатися з текстом абзацу й бути в ньому єдиним. new — без переносу рядка. Порожній new — видалити фрагмент.",
    input_schema: {
      type: "object",
      properties: { paragraph: ID_SCHEMA, old: { type: "string" }, new: { type: "string" } },
      required: ["paragraph", "old", "new"],
    },
  },
  {
    name: "insert_paragraphs",
    description: "Вставити нові абзаци після абзацу after (\"start\" — на початок документа). Кожен рядок text — окремий абзац. style_like — мітка абзацу, чиє оформлення взяти (за замовчуванням код підбирає сам). in_table_cell:true — вставити в клітинку таблиці, а не після таблиці.",
    input_schema: {
      type: "object",
      properties: {
        after: ID_SCHEMA,
        text: { type: "string" },
        style_like: ID_SCHEMA,
        in_table_cell: { type: "boolean" },
      },
      required: ["after", "text"],
    },
  },
  {
    name: "delete_paragraphs",
    description: "Видалити абзаци від from до to включно (не більше 40). first_words — перші 3–6 слів абзацу from (для перевірки; для порожнього абзацу — \"\"). Рисунки, формули й частини полів Word не видаляються.",
    input_schema: {
      type: "object",
      properties: { from: ID_SCHEMA, to: ID_SCHEMA, first_words: { type: "string" } },
      required: ["from", "to", "first_words"],
    },
  },
  {
    name: "resolve",
    description: "Позначити зауваження опрацьованими без (подальших) змін тексту: коментарі Word (#C) закриваються, виділення (#H) і нотатки (#N) знімаються з тексту. note — коротко чому (напр. \"вже виправлено разом із #H2\" або \"фрагмент коректний\").",
    input_schema: {
      type: "object",
      properties: { remarks: { type: "array", items: { type: "string" } }, note: { type: "string" } },
      required: ["remarks"],
    },
  },
  {
    name: "restructure_sources",
    description: "Додати чи видалити джерела зі списку використаних джерел: список буде перенумеровано, посилання [N] по всьому тексту — оновлено, для нових джерел — підібрано місце цитування. Опиши словами, що зробити.",
    input_schema: {
      type: "object",
      properties: {
        issue: { type: "string", description: "що не так зі списком (суть зауваження)" },
        suggestion: { type: "string", description: "що саме зробити: які джерела прибрати (номери) / які додати (бібліографічні описи)" },
      },
      required: ["issue", "suggestion"],
    },
  },
  {
    name: "fix_citation_pages",
    description: "Автоматично виправити номери сторінок у посиланнях [N, с. X], що виходять за межі обсягу джерела. Без параметрів.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "read_client_materials",
    description: "Прочитати матеріали клієнта (дані підприємства, розрахунки тощо) — частинами по 15000 символів.",
    input_schema: { type: "object", properties: { offset: { type: "integer", description: "з якого символу (0 — з початку)" } } },
  },
  {
    name: "finish",
    description: "Завершити роботу, коли всі зауваження опрацьовано.",
    input_schema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "коротко: що зроблено" },
        needs_review: {
          type: "array",
          items: {
            type: "object",
            properties: { remark: { type: "string", description: "мітка й суть зауваження, напр. \"#H3: …\"" }, reason: { type: "string" } },
            required: ["remark", "reason"],
          },
        },
        volume_change_reason: { type: "string", description: "лише якщо зауваження прямо вимагає змінити обсяг роботи — яке саме" },
      },
      required: ["summary"],
    },
  },
];

function flexiblePattern(query) {
  return escRe(query.trim())
    .replace(/\s+/g, "\\s+")
    .replace(/["“”«»]/g, "[\"“”«»]")
    .replace(/['‘’`]/g, "['‘’`]")
    .replace(/[-–—]/g, "[-–—]");
}

function citationNumbers(s) {
  const nums = new Set();
  for (const m of (s || "").matchAll(/\[([^\]]+)\]/g)) {
    for (const part of m[1].split(";")) {
      const n = part.trim().match(/^(\d+)(?=\s*(,|$))/);
      if (n) nums.add(Number(n[1]));
    }
  }
  return nums;
}

// Посилання "(Автор, рік)" / "[Автор, рік, с. 5]" → ключі "прізвище|рік".
const AUTHOR_STOPWORDS = new Set(["див", "рис", "табл", "таблиця", "додаток", "дод", "розділ", "пункт", "see", "fig", "table", "cf", "напр", "ст", "с", "p", "pp", "станом"]);
function authorYearKeys(s) {
  const keys = new Set();
  for (const m of (s || "").matchAll(/[([]([^()[\]]{3,200})[)\]]/g)) {
    for (const part of m[1].split(";")) {
      const mm = part.trim().match(/^([A-ZА-ЯҐЄІЇ][A-Za-zА-Яа-яҐґЄєІіЇї'’-]+)[^;]*?(1[89]\d\d|20\d\d)/);
      if (mm && !AUTHOR_STOPWORDS.has(mm[1].toLowerCase())) keys.add(`${mm[1].toLowerCase()}|${mm[2]}`);
    }
  }
  return keys;
}

function looksLikeHeading(styleName, text) {
  if (/heading|заголов|title/i.test(styleName || "")) return true;
  const t = text.trim();
  if (!t || t.length > 150) return false;
  if (/^(ВСТУП|ВИСНОВКИ|ЗМІСТ|ДОДАТК|ДОДАТОК|СПИСОК\s+(ВИКОРИСТАН|ЛІТЕРАТУРИ|ДЖЕРЕЛ)|РОЗДІЛ\s+\d)/i.test(t)) return true;
  if (/^\d+\.\d+(\.\d+)?\.?\s+\S/.test(t) && !/[.;:]$/.test(t)) return true;
  const letters = t.replace(/[^A-Za-zА-Яа-яҐґЄєІіЇї]/g, "");
  return letters.length >= 4 && t === t.toUpperCase() && t !== t.toLowerCase();
}

// Чи текст схожий на таблицю markdown / код схеми, а не на текст роботи.
function looksLikeMarkup(text) {
  return text.split("\n").some(l => /^\s*\|.*\|\s*$/.test(l) || /^\s*```/.test(l) || /@startuml|@enduml/.test(l));
}

// Прибрати markdown-оформлення, яке ШІ інколи додає за звичкою.
function stripMarkdown(s) {
  return s
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/(^|\n)\s*#{1,6}\s+/g, "$1")
    .replace(/(^|\n)\s*[-*•]\s+/g, "$1")
    .replace(/`([^`]+)`/g, "$1");
}

const normStart = s => (s || "").replace(new RegExp(`[${TAB_MARK}${BR_MARK}]`, "g"), " ").replace(/\s+/g, " ").trim().toLowerCase();
const stripMarks = s => (s || "").replace(new RegExp(`[${TAB_MARK}${BR_MARK}]`, "g"), "");

// ── Фото зауважень → формат, який приймає API (jpeg/png/gif/webp до ~4.5 МБ).
// Більші чи HEIC — стискаються: у воркері через io.compressImage (sharp), у
// браузері — canvas. Якщо стиснути не вдалося — фото пропускається з поясненням. ──
const MAX_IMAGE_BYTES = 4_500_000;
const API_IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];

async function compressInBrowser(f) {
  const img = new Image();
  img.src = `data:${f.type};base64,${f.b64}`;
  await img.decode();
  const scale = Math.min(1, 2000 / Math.max(img.width, img.height));
  const c = document.createElement("canvas");
  c.width = Math.round(img.width * scale);
  c.height = Math.round(img.height * scale);
  c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
  return { name: f.name, type: "image/jpeg", b64: c.toDataURL("image/jpeg", 0.85).split(",")[1] };
}

async function prepareImageForApi(f, io) {
  const bytes = Math.floor((f.b64?.length || 0) * 0.75);
  if (f.type === "application/pdf") return bytes <= 30_000_000 ? f : null;
  if (API_IMAGE_TYPES.includes(f.type) && bytes <= MAX_IMAGE_BYTES) return f;
  try {
    if (io.compressImage) return await io.compressImage(f);
    if (typeof document !== "undefined") return await compressInBrowser(f);
  } catch { /* не вдалося стиснути — нижче повертаємо null */ }
  return null;
}

// ── Фото/скріни зауважень → текст, ОДИН раз на старті. Інакше зображення
// пересилалися б на кожному кроці агента (проксі Vercel приймає до 10 МБ на
// запит — двох фото з телефона досить, щоб агент падав). ──
async function transcribeRemarkFiles(files, { callStep, costTracker, onCost, io, onProgress }) {
  const blocks = [];
  const skipped = [];
  for (const f of files) {
    const ready = await prepareImageForApi(f, io);
    if (!ready) { skipped.push(f.name || "фото"); continue; }
    blocks.push(ready.type === "application/pdf"
      ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: ready.b64 } }
      : { type: "image", source: { type: "base64", media_type: ready.type, data: ready.b64 } });
  }
  if (!blocks.length) return { text: "", skipped };
  onProgress("Розпізнаю фото зауважень");
  const prompt = "На зображеннях — зауваження викладача до студентської роботи (фото сторінок із позначками, скріни, списки, рукописні нотатки). Перепиши ДОСЛІВНО кожне зауваження. Для кожного вкажи, до якого місця роботи воно стосується (цитата фрагмента, підкреслене слово, номер сторінки чи розділу — що видно на фото) і що саме вимагається. Нічого не виконуй і не додавай від себе. Формат — нумерований список, без вступу.";
  const resp = await callStep([{ role: "user", content: [...blocks, { type: "text", text: prompt }] }],
    "Ти уважно розпізнаєш друковані й рукописні зауваження викладача до студентської роботи.", 4000, MODEL, { costTracker, onCost });
  const text = resp.content.filter(b => b.type === "text").map(b => b.text).join("\n").trim();
  return { text, skipped };
}

/**
 * Агентне застосування правок до вже відкритого .docx (prepareDocxForCorrections /
 * openDocxForEditing). docXml мутується напряму, як і в applyCorrectionTasks.
 *
 * @param {object} input
 * @param {object} input.zip
 * @param {object} input.docXml
 * @param {{highlights:Array, comments:Array, colorNotes:Array}} input.annotations - з
 *   extractAnnotationsFromOpenDocx (з посиланнями на рани того самого docXml) або
 *   extractAnnotations (лише тексти — тоді виділення відстежуються за текстом)
 * @param {string} [input.instructions] - вільний текст зауважень
 * @param {Array<{b64:string, type:string, name?:string}>} [input.remarkFiles] - фото/PDF зауважень
 * @param {string} [input.lang]
 * @param {object} [input.methodInfo]
 * @param {{rawText:string}} [input.clientMaterialsSummary]
 * @param {{type?:string, topic?:string, subject?:string, course?:string|number, pages?:string|number}} [input.orderInfo] -
 *   умови замовлення: тип/тема/предмет/курс ідуть у правила агента, pages — у
 *   кодовий контроль загального обсягу (volumeBounds)
 * @param {"auto"|"full"|"outline"} [input.contextMode] - full: увесь текст роботи
 *   в кешованому контексті (краще бачить роботу цілком, дорожче); outline: лише
 *   структура, текст агент читає інструментами (дешевше); auto — за обсягом
 * @param {{callClaude: Function, costTracker?: object, onProgress?: Function, onCost?: Function, io?: object}} ctx
 * @returns {Promise<{changes: Array, failed: Array, messages: Array, appliedCount: number, summary: string, steps: number, finished: boolean, modified: boolean, contextMode: string, volume: {before:number, after:number, lo:number, hi:number, fromOrder:boolean}}>}
 */
export async function runAgentCorrections({
  zip, docXml, annotations, instructions = "", remarkFiles = [],
  lang = "Українська", methodInfo = null, clientMaterialsSummary = null, orderInfo = {}, contextMode = "auto", markEdits = false,
}, ctx) {
  const { costTracker, onProgress = () => {}, onCost, io = {} } = ctx;
  const callStep = ctx.callClaudeMessage || callClaudeMessage;
  const styleNames = await readStyleNames(zip, io);
  const labels = getLangLabels(lang);

  const changes = [];
  const messages = [];
  const failed = [];
  let modified = false;

  // ── Стан документа + постійні мітки абзаців ──
  const idOf = new WeakMap();
  const elById = new Map();
  let newCounter = 0;
  let initialized = false;
  let map, text, lines, paraEls, posOf, lineStart;
  const refresh = () => {
    ({ map, plainText: text } = refreshTextMap(docXml));
    lines = text.split("\n");
    paraEls = getParagraphs(docXml);
    if (paraEls.length !== lines.length) throw new Error("Внутрішня помилка: абзаци й текст документа розійшлися");
    posOf = new Map();
    lineStart = [];
    let off = 0;
    paraEls.forEach((el, i) => {
      posOf.set(el, i);
      lineStart.push(off);
      off += lines[i].length + 1;
      // Вихідні абзаци — мітки за їхнім номером на старті; усі, що з'явились
      // пізніше (зокрема створені restructure_sources), — n1, n2…
      if (!idOf.has(el)) {
        const id = initialized ? `n${++newCounter}` : String(i);
        idOf.set(el, id);
        elById.set(id, el);
      }
    });
    initialized = true;
  };
  refresh();

  const idKey = v => String(v ?? "").trim().replace(/^\[|\]$/g, "").split("|")[0].trim();
  const resolveId = (v, what = "абзацу") => {
    const key = idKey(v);
    const el = elById.get(key);
    if (!el) throw new Error(`Мітки ${what} [${key}] немає в документі.`);
    if (!posOf.has(el)) throw new Error(`Абзацу [${key}] вже немає — його видалено.`);
    return el;
  };
  const labelOf = el => `[${idOf.get(el)}]`;
  const isHeadingEl = el => looksLikeHeading(paragraphInfo(el, styleNames).styleName, lines[posOf.get(el)] || "");
  const isCaption = t => CAPTION_RE.test((t || "").trim()) && (t || "").length < 300;

  const withMarkers = el => {
    const line = lines[posOf.get(el)];
    const marks = paragraphInlineMarkers(el);
    if (!marks.length) return line;
    let out = "", last = 0;
    marks.forEach(m => {
      out += line.slice(last, m.offset) + (m.kind === "tab" ? TAB_MARK : BR_MARK);
      last = m.offset;
    });
    return out + line.slice(last);
  };
  const row = el => {
    const info = paragraphInfo(el, styleNames);
    const t = lines[posOf.get(el)];
    const tags = [];
    if (isHeadingEl(el)) tags.push("заголовок");
    if (info.inTable) tags.push("таблиця");
    if (info.hasPicture) tags.push("рисунок");
    if (info.hasMath) tags.push("формула");
    if (info.numbered) tags.push("список");
    if (isCaption(t)) tags.push("підпис");
    return { tags, text: `[${idOf.get(el)}${tags.length ? "|" + tags.join(",") : ""}] ${withMarkers(el)}` };
  };
  const visible = el => {
    if (lines[posOf.get(el)].trim()) return true;
    const info = paragraphInfo(el, styleNames);
    return info.hasPicture || info.hasMath;
  };

  // ── Контроль загального обсягу (кодом, не ШІ) — завжди, навіть коли жодне
  // зауваження не стосується обсягу. ──
  const beforeWords = measureMainVolume(lines, lang).words;
  let bounds = volumeBounds({ beforeWords, pages: orderInfo.pages });
  const currentWords = () => measureMainVolume(lines, lang).words;
  const volumeStatus = () => {
    const w = currentWords();
    const flag = w > bounds.hi ? ` — ПЕРЕВИЩЕНО на ${w - bounds.hi}` : w < bounds.lo ? ` — БРАКУЄ ${bounds.lo - w}` : "";
    return `Обсяг основної частини: ${w} слів (межі ${bounds.lo}–${bounds.hi})${flag}.`;
  };

  // ── Зауваження з мітками — їх стан відстежує код ──
  const isAttached = node => {
    for (let n = node; n; n = n.parentNode) if (n === docXml.documentElement) return true;
    return false;
  };
  const runMarked = (run, kind) => {
    const rPr = Array.from(run.childNodes).find(n => n.tagName === "w:rPr");
    if (!rPr) return false;
    if (kind === "highlight") {
      const hl = Array.from(rPr.childNodes).find(n => n.tagName === "w:highlight");
      return !!hl && !["none", "white", "black"].includes(hl.getAttribute("w:val"));
    }
    const color = Array.from(rPr.childNodes).find(n => n.tagName === "w:color");
    return !!color && isReddishColor(color.getAttribute("w:val"));
  };
  const paragraphOfText = (t, context) => {
    const loc = locateFragment(text, t, context);
    if (!loc) return null;
    return paraEls[text.slice(0, loc.start).split("\n").length - 1] || null;
  };
  const remarks = [];
  annotations.highlights.forEach((h, i) => {
    const para = h.paragraph && posOf.has(h.paragraph) ? h.paragraph : paragraphOfText(h.text, h.context);
    remarks.push({ id: `#H${i + 1}`, kind: "highlight", text: h.text, runs: (h.runs || []).filter(isAttached), paragraph: para, colorLabel: h.colorInfo?.ua || h.color });
  });
  const openComments = new Map();
  annotations.comments.forEach(c => {
    openComments.set(String(c.id), c);
    const start = Array.from(docXml.getElementsByTagName("w:commentRangeStart")).find(el => el.getAttribute("w:id") === String(c.id));
    let para = null;
    for (let n = start?.parentNode; n; n = n.parentNode) if (n.tagName === "w:p") { para = n; break; }
    if (!para) para = paragraphOfText(c.commentedText, null);
    remarks.push({ id: `#C${c.id}`, kind: "comment", commentId: String(c.id), text: c.commentedText, instruction: c.instruction, author: c.author, paragraph: para });
  });
  (annotations.colorNotes || []).forEach((n, i) => {
    const para = n.paragraph && posOf.has(n.paragraph) ? n.paragraph : paragraphOfText(n.text, n.context);
    remarks.push({ id: `#N${i + 1}`, kind: "note", text: n.text, runs: (n.runs || []).filter(isAttached), paragraph: para });
  });
  const citationTask = buildCitationPagesTask(text);
  if (citationTask) remarks.push({ id: "#P", kind: "citations", text: citationTask.label });
  const remarkById = new Map(remarks.map(r => [r.id.toUpperCase(), r]));

  const remarkDone = r => {
    if (r.kind === "comment") return !openComments.has(r.commentId);
    if (r.kind === "citations") return !buildCitationPagesTask(text);
    if (r.kind === "highlight") {
      if (r.resolved) return true;
      if (r.runs.length) return r.runs.every(run => !isAttached(run) || !runMarked(run, "highlight"));
      return !(r.paragraph && posOf.has(r.paragraph) && lines[posOf.get(r.paragraph)].includes(r.text));
    }
    // нотатка: сам текст нотатки має зникнути з абзацу
    const stillThere = r.paragraph && posOf.has(r.paragraph) && lines[posOf.get(r.paragraph)].includes(r.text);
    if (stillThere) return false;
    return r.resolved || !r.runs.length || r.runs.every(run => !isAttached(run) || !(runMarked(run, "note") && (run.textContent || "").trim()));
  };

  // ── Фото зауважень → текст (один раз) ──
  let remarkFilesText = "";
  if (remarkFiles.length) {
    try {
      const { text: t, skipped } = await transcribeRemarkFiles(remarkFiles, { callStep, costTracker, onCost, io, onProgress });
      remarkFilesText = t;
      if (skipped.length) messages.push({ type: "error", text: `Не вдалося обробити фото зауважень (${skipped.join(", ")}): формат не підтримується або файл завеликий — перевірте ці зауваження вручну.` });
    } catch (e) {
      messages.push({ type: "error", text: `Не вдалося розпізнати фото зауважень: ${e.message}` });
    }
  }

  const remarksCount = remarks.length + (instructions.trim() ? 1 : 0) + (remarkFilesText ? 1 : 0);
  if (!remarksCount) {
    return { changes, failed, messages, appliedCount: 0, summary: "Зауважень не знайдено.", steps: 0, finished: true, modified, contextMode, volume: { before: beforeWords, after: beforeWords, ...bounds } };
  }

  // ── Список джерел і правила посилань ──
  let zone = locateSourcesZone(text);
  const sourceNumbers = new Set();
  let sourcesTextLower = "";
  const refreshSources = () => {
    zone = locateSourcesZone(text);
    sourceNumbers.clear();
    (zone?.entries || []).forEach(e => sourceNumbers.add(e.number));
    sourcesTextLower = zone ? text.slice(zone.sourcesStart, zone.sourcesEnd).toLowerCase() : "";
  };
  refreshSources();
  const citationStyleText = [methodInfo?.citationStyle, methodInfo?.sourcesStyle].filter(Boolean).join(" ");
  const authorYearMode = /apa|mla|harvard|chicago|автор.{0,10}рік/i.test(citationStyleText) || authorYearKeys(text).size >= 3;
  const conclusionsRe = new RegExp(`^(${escRe(labels.conclusions)}|ВИСНОВКИ|CONCLUSIONS?)$`, "i");
  const inConclusions = pos => {
    let start = -1;
    for (let i = pos; i >= 0; i--) {
      const t = lines[i].trim();
      if (conclusionsRe.test(t)) { start = i; break; }
      if (i !== pos && SOURCES_LINE_RE.test(t)) return false;
    }
    if (start < 0) return false;
    for (let i = start + 1; i < pos; i++) if (SOURCES_LINE_RE.test(lines[i].trim())) return false;
    return true;
  };

  const checkIllustrationsKept = (before, after) => {
    const lost = (before.match(ILLUSTRATION_MARKER_RE) || []).filter(m => !after.includes(m));
    if (lost.length) throw new Error(`Не можна прибирати маркер ${lost.join(", ")} — збережи його без змін.`);
  };
  const checkCitations = (before, after, pos) => {
    const had = citationNumbers(before);
    const added = [...citationNumbers(after)].filter(n => !had.has(n));
    if (added.length && pos != null && inConclusions(pos)) {
      throw new Error("У ВИСНОВКАХ не ставлять посилань на джерела — прибери [N] з нового тексту.");
    }
    const bad = added.filter(n => !sourceNumbers.has(n));
    if (bad.length) throw new Error(`Джерел №${bad.join(", ")} немає у списку джерел — не посилайся на них (доступні: ${sourceNumbers.size ? `${Math.min(...sourceNumbers)}–${Math.max(...sourceNumbers)}` : "жодного"}).`);
    if (authorYearMode) {
      const hadAY = authorYearKeys(before);
      const newAY = [...authorYearKeys(after)].filter(k => !hadAY.has(k));
      if (newAY.length && pos != null && inConclusions(pos)) throw new Error("У ВИСНОВКАХ не ставлять посилань на джерела.");
      const missing = newAY.filter(k => {
        const [author, year] = k.split("|");
        return !(sourcesTextLower.includes(author) && sourcesTextLower.includes(year));
      });
      if (missing.length) throw new Error(`Посилання ${missing.map(k => k.replace("|", ", ")).join("; ")} не відповідає жодному джерелу зі списку — не вигадуй авторів; посилайся лише на наявні джерела.`);
    }
  };
  const sanitizeNew = s => {
    const clean = stripEmDash(stripMarkdown(stripMarks(s || "")));
    if (looksLikeMarkup(clean)) throw new Error("Таблиці (рядки з \"|\") і код схем у текст вставляти не можна — таблиці/рисунки ти створювати не можеш; внеси це зауваження в needs_review.");
    return clean;
  };
  const clip = (s, n = 1500) => (s.length > n ? s.slice(0, n) + "…" : s);
  const markModified = () => { modified = true; };

  // Оформлення для нових абзаців, якщо агент не вказав style_like: після
  // заголовка/таблиці/рисунка/підпису/порожнього абзацу — найближчий звичайний
  // абзац основного тексту, інакше — сам абзац, після якого вставляємо.
  const pickBodyModel = pos => {
    const ok = i => {
      const el = paraEls[i];
      const t = lines[i];
      if (!el || t.length < 120 || isCaption(t) || isHeadingEl(el)) return false;
      const info = paragraphInfo(el, styleNames);
      return !info.inTable && !info.hasPicture && !info.hasMath && !info.numbered;
    };
    for (let d = 0; d < 300; d++) {
      if (pos - d >= 0 && ok(pos - d)) return paraEls[pos - d];
      if (pos + d < paraEls.length && ok(pos + d)) return paraEls[pos + d];
    }
    return null;
  };
  const autoModel = anchor => {
    const pos = posOf.get(anchor);
    const t = lines[pos];
    const info = paragraphInfo(anchor, styleNames);
    if (isHeadingEl(anchor) || info.inTable || info.hasPicture || info.hasMath || isCaption(t) || !t.trim()) {
      return pickBodyModel(pos) || anchor;
    }
    return anchor;
  };

  // ── Реалізація інструментів. Кожен повертає рядок для tool_result;
  // throw → is_error з текстом помилки (ШІ бачить причину і пробує інакше). ──
  const tools = {
    read_paragraphs({ from, to }) {
      const fromEl = resolveId(from);
      const a = posOf.get(fromEl);
      let b = to != null && to !== "" ? posOf.get(resolveId(to)) : a + 39;
      if (b < a) throw new Error("to стоїть раніше за from.");
      b = Math.min(b, a + READ_MAX_PARAGRAPHS - 1, paraEls.length - 1);
      onProgress(`Читаю абзаци ${labelOf(fromEl)}…`);
      const out = [];
      let chars = 0;
      for (let i = a; i <= b; i++) {
        if (!visible(paraEls[i])) continue;
        const r = row(paraEls[i]).text;
        if (chars + r.length > READ_MAX_CHARS) { out.push(`…обрізано, читай далі з ${labelOf(paraEls[i])}`); break; }
        out.push(r);
        chars += r.length;
      }
      const next = b + 1 < paraEls.length ? ` Далі — ${labelOf(paraEls[b + 1])}.` : " Це кінець документа.";
      return (out.length ? out.join("\n") : "(порожні абзаци)") + next;
    },

    search({ query, regex }) {
      if (!query?.trim()) throw new Error("Порожній запит.");
      const re = new RegExp(regex ? query : flexiblePattern(query), "iu");
      onProgress(`Пошук: ${query.slice(0, 40)}`);
      const hits = [];
      lines.forEach((l, i) => {
        const m = l.match(re);
        if (!m) return;
        const s = Math.max(0, m.index - 100);
        const e = m.index + m[0].length + 100;
        const tags = row(paraEls[i]).tags;
        hits.push(`[${idOf.get(paraEls[i])}${tags.length ? "|" + tags.join(",") : ""}] ${s > 0 ? "…" : ""}${l.slice(s, e)}${e < l.length ? "…" : ""}`);
      });
      if (!hits.length) return "Нічого не знайдено.";
      return `Знайдено в ${hits.length} абзацах${hits.length > 40 ? " (показано перші 40)" : ""}:\n${hits.slice(0, 40).join("\n")}`;
    },

    replace_text({ paragraph, old, new: repl }) {
      const el = resolveId(paragraph);
      const pos = posOf.get(el);
      const oldClean = stripMarks(old);
      if (!oldClean) throw new Error("old не може бути порожнім.");
      if (/\n/.test(repl || "")) throw new Error("new не може містити перенос рядка — для нових абзаців використовуй insert_paragraphs.");
      const line = lines[pos];
      const exactCount = line.split(oldClean).length - 1;
      if (exactCount > 1) throw new Error(`Фрагмент трапляється в абзаці ${exactCount} рази — візьми довший, унікальний фрагмент.`);
      const loc = exactCount === 1 ? { start: line.indexOf(oldClean), end: line.indexOf(oldClean) + oldClean.length } : locateFragment(line, oldClean, null);
      if (!loc) throw new Error(`Фрагмент не знайдено в абзаці ${labelOf(el)}. Поточний текст абзацу:\n${clip(withMarkers(el), 3000)}`);
      const original = line.slice(loc.start, loc.end);
      const replacement = sanitizeNew(repl);
      checkIllustrationsKept(original, replacement);
      checkCitations(original, replacement, pos);
      onProgress(`Правка абзацу ${labelOf(el)}`);
      if (!applyDocxReplacement(map, lineStart[pos] + loc.start, lineStart[pos] + loc.end, replacement, markEdits)) {
        throw new Error("Цей фрагмент не редагується (поле/службовий текст Word) — зміни інший фрагмент або внеси зауваження в needs_review.");
      }
      changes.push({ label: `Абзац ${labelOf(el)}`, original, replacement });
      markModified();
      refresh();
      return `Готово. ${clip(row(el).text)}\n${volumeStatus()}`;
    },

    insert_paragraphs({ after, text: newText, style_like, in_table_cell }) {
      const atStart = after === -1 || /^(start|початок|-1)$/i.test(String(after ?? "").trim());
      const anchor = atStart ? paraEls[0] : resolveId(after);
      const texts = sanitizeNew(newText).split(/\n+/).map(s => s.trim()).filter(Boolean);
      if (!texts.length) throw new Error("Порожній текст.");
      const anchorPos = posOf.get(anchor);
      checkCitations("", texts.join("\n"), atStart ? 0 : anchorPos);
      const model = style_like != null && style_like !== "" ? resolveId(style_like, "style_like") : (atStart ? (pickBodyModel(0) || anchor) : autoModel(anchor));
      const inTable = paragraphInfo(anchor, styleNames).inTable;
      onProgress(`Додаю ${texts.length} абз. після ${atStart ? "початку" : labelOf(anchor)}`);
      const created = atStart
        ? insertParagraphsBeforeEl(anchor, texts, model, markEdits)
        : insertParagraphsAfterEl(anchor, texts, model, { afterTable: !in_table_cell, markEdits });
      changes.push({ label: `Нові абзаци після ${atStart ? "початку" : labelOf(anchor)}`, original: "", replacement: texts.join("\n") });
      markModified();
      refresh();
      const where = atStart ? "на початок документа" : `після ${labelOf(anchor)}${inTable && !in_table_cell ? " (після всієї таблиці)" : ""}`;
      return `Готово: вставлено ${labelOf(created[0])}${created.length > 1 ? `–${labelOf(created[created.length - 1])}` : ""} ${where}; оформлення — як у ${labelOf(model)}.\n${volumeStatus()}`;
    },

    async delete_paragraphs({ from, to, first_words }) {
      const fromEl = resolveId(from);
      const toEl = resolveId(to);
      const a = posOf.get(fromEl);
      const b = posOf.get(toEl);
      if (b < a) throw new Error("to стоїть раніше за from.");
      if (b - a > 39) throw new Error("Не більше 40 абзаців за раз.");
      const expected = normStart(first_words);
      const actual = normStart(lines[a]);
      if (expected ? !actual.startsWith(expected) : actual !== "") {
        throw new Error(`Абзац ${labelOf(fromEl)} починається інакше: «${clip(lines[a], 120) || "(порожній)"}». Нічого не видалено — перевір мітки.`);
      }
      const els = paraEls.slice(a, b + 1);
      const removedText = lines.slice(a, b + 1).join("\n");
      checkIllustrationsKept(removedText, "");
      onProgress(`Видаляю абзаци ${labelOf(fromEl)}–${labelOf(toEl)}`);
      const neighbour = paraEls[a - 1] || paraEls[b + 1] || null;
      const res = deleteParagraphEls(els, { moveMarkersTo: neighbour });
      for (const id of res.commentIds) {
        await removeDocxComment(zip, docXml, id, io);
        openComments.delete(String(id));
      }
      if (res.deleted || res.cleared) {
        changes.push({ label: `Видалено абзаци ${labelOf(fromEl)}–${labelOf(toEl)}`, original: removedText, replacement: "" });
        markModified();
      }
      const skipped = res.skipped.map(s => `${labelOf(s.p)} (${s.reason})`);
      refresh();
      return `Готово: видалено ${res.deleted}, очищено ${res.cleared}${skipped.length ? `; НЕ видалено: ${skipped.join(", ")}` : ""}.\n${volumeStatus()}`;
    },

    async resolve({ remarks: ids = [], note = "" }) {
      if (!ids.length) throw new Error("Вкажи мітки зауважень, напр. [\"#C0\", \"#H2\"].");
      const out = [];
      for (const raw of ids) {
        const key = String(raw).trim().toUpperCase().replace(/^([HCNP])/, "#$1");
        const r = remarkById.get(key);
        if (!r) { out.push(`${raw}: такого зауваження немає`); continue; }
        if (r.kind === "citations") { out.push(`${r.id}: для нього виклич fix_citation_pages`); continue; }
        if (r.kind === "comment") {
          if (openComments.has(r.commentId)) {
            await removeDocxComment(zip, docXml, r.commentId, io);
            openComments.delete(r.commentId);
            markModified();
          }
          out.push(`${r.id}: коментар закрито`);
          continue;
        }
        r.resolved = true;
        r.note = note;
        (r.runs || []).filter(isAttached).forEach(run => { if (clearAttentionMarkers(run)) markModified(); });
        if (r.kind === "note" && r.paragraph && posOf.has(r.paragraph) && lines[posOf.get(r.paragraph)].includes(r.text)) {
          out.push(`${r.id}: позначку знято, але текст нотатки ще в абзаці ${labelOf(r.paragraph)} — прибери його через replace_text`);
        } else {
          out.push(`${r.id}: позначено опрацьованим`);
        }
      }
      refresh();
      return out.join("\n");
    },

    async restructure_sources({ issue, suggestion }) {
      const r = await applyCorrectionTasks(
        { zip, docXml, tasks: [{ id: "agent_sources", kind: "sources_restructure", label: "Список джерел", issue, suggestion }], lang, methodInfo, clientMaterialsSummary, markEdits },
        { ...ctx, io },
      );
      refresh();
      refreshSources();
      markModified();
      changes.push(...r.changes);
      if (r.failed.length) throw new Error(r.failed.map(f => f.reason).join("; "));
      return (r.messages.map(m => m.text).join(" ") || "Готово.") + ` Тепер у списку джерела №1–${sourceNumbers.size ? Math.max(...sourceNumbers) : 0}. Якщо кількість джерел названа у вступі чи анотації — онови її.`;
    },

    async fix_citation_pages() {
      const task = buildCitationPagesTask(text);
      if (!task) return "Невалідних сторінок у посиланнях не знайдено.";
      const r = await applyCorrectionTasks({ zip, docXml, tasks: [task], lang, methodInfo, markEdits }, { ...ctx, io });
      refresh();
      changes.push(...r.changes);
      if (r.changes.length) markModified();
      if (r.failed.length) throw new Error(r.failed.map(f => f.reason).join("; "));
      return r.messages.map(m => m.text).join(" ") || "Готово.";
    },

    read_client_materials({ offset = 0 }) {
      const raw = clientMaterialsSummary?.rawText || "";
      if (!raw) return "Матеріалів клієнта немає.";
      const chunk = raw.slice(offset, offset + 15000);
      const end = offset + chunk.length;
      return chunk + (end < raw.length ? `\n…(далі — offset ${end} з ${raw.length})` : "\n(кінець матеріалів)");
    },
  };
  const READ_TOOLS = new Set(["read_paragraphs", "search", "read_client_materials"]);

  // ── Контекст документа: повний текст або лише структура ──
  const tooBig = text.length > FULL_TEXT_MAX_CHARS;
  let mode = contextMode === "auto"
    ? (!tooBig && (remarksCount >= 12 || instructions.length > 1500 || text.length < 40000) ? "full" : "outline")
    : contextMode;
  if (mode === "full" && tooBig) {
    mode = "outline";
    messages.push({ type: "success", text: "Робота завелика, щоб тримати її цілком у контексті ШІ, — агент читав її частинами." });
  }
  const docInfo = [];
  docInfo.push(`ДОКУМЕНТ: ${lines.length} абзаців (мітки від [0] до [${lines.length - 1}]), ≈${countWords(text)} слів. Нижче — знімок на початок роботи; після змін актуальний текст — у відповідях інструментів (мітки абзаців не змінюються).`);
  const orderLine = [
    orderInfo.type && `тип роботи: ${orderInfo.type}`,
    orderInfo.topic && `тема: «${orderInfo.topic}»`,
    orderInfo.subject && `предмет/спеціальність: ${orderInfo.subject}`,
    orderInfo.course && `курс: ${orderInfo.course}`,
    orderInfo.pages && `замовлений обсяг: ${orderInfo.pages}${parsePagesRange(orderInfo.pages)?.words ? "" : " стор."}`,
  ].filter(Boolean);
  if (orderLine.length) docInfo.push(`ЗАМОВЛЕННЯ: ${orderLine.join("; ")}.`);
  const relaxedPreview = volumeBounds({ beforeWords, pages: orderInfo.pages, relaxed: true });
  docInfo.push(`ОБСЯГ: основна частина (від ${labels.intro} до кінця списку джерел, без додатків) зараз ${beforeWords} слів ≈ ${Math.round(beforeWords / WORDS_PER_PAGE)} стор. (${WORDS_PER_PAGE} слів = стор.). Після правок — у межах ${bounds.lo}–${bounds.hi} слів${bounds.fromOrder ? " (з урахуванням замовленого обсягу)" : ""}. Якщо зауваження прямо вимагає змінити обсяг роботи (volume_change_reason) — у межах ${relaxedPreview.lo}–${relaxedPreview.hi}.`);
  if (zone) {
    docInfo.push(`СПИСОК ДЖЕРЕЛ: ${zone.entries.length} шт.${zone.autoNumbered ? " (нумерація автоматична, у тексті абзаців номерів немає)" : ""}, №${zone.entries[0]?.number ?? "?"}–${zone.entries.at(-1)?.number ?? "?"}. Посилатися можна лише на ці номери${authorYearMode ? " / лише на авторів із цього списку" : ""}.`);
  } else {
    docInfo.push("СПИСОК ДЖЕРЕЛ: не знайдено — нових посилань на джерела не додавай.");
  }
  if (methodInfo) {
    const req = [methodInfo.sourcesStyle && `стиль джерел: ${methodInfo.sourcesStyle}`, methodInfo.sourcesFormatRules, methodInfo.citationStyle, methodInfo.formatting?.tableFormat, methodInfo.theoryRequirements].filter(Boolean);
    if (req.length) docInfo.push(`ВИМОГИ МЕТОДИЧКИ: ${req.join(". ")}`);
  }
  if (clientMaterialsSummary?.rawText) {
    docInfo.push(`МАТЕРІАЛИ КЛІЄНТА: є, ${clientMaterialsSummary.rawText.length} символів — читай через read_client_materials, коли зауваження стосується даних.`);
  }
  if (mode === "full") {
    docInfo.push("ПОВНИЙ ТЕКСТ РОБОТИ:\n" + paraEls.filter(visible).map(el => row(el).text).join("\n"));
  } else {
    const outline = paraEls.filter(el => isHeadingEl(el)).slice(0, 250).map(el => `${labelOf(el)} ${lines[posOf.get(el)].trim()}`);
    docInfo.push("СТРУКТУРА РОБОТИ (заголовки; сам текст читай через read_paragraphs):\n" + outline.join("\n"));
  }

  const remarkLines = remarks.map(r => {
    const where = r.paragraph && posOf.has(r.paragraph) ? `[абзац ${labelOf(r.paragraph)}]` : "[місце не визначено — знайди search-ем]";
    if (r.kind === "highlight") return `${r.id} ${where} виділено (${r.colorLabel}): «${r.text}»`;
    if (r.kind === "comment") return `${r.id} ${where} коментар Word (${r.author}) до «${r.text}»: ${r.instruction}`;
    if (r.kind === "note") return `${r.id} ${where} нотатка, вписана в текст кольором шрифту: «${r.text}»`;
    return `${r.id} автоматична перевірка: ${r.text} — виклич fix_citation_pages.`;
  });
  const systemPrompt = buildSYS(lang, methodInfo, normalizeWorkType(orderInfo.type, orderInfo.course)) + "\n\n" + AGENT_RULES;
  const firstText = [
    remarkLines.length ? "ЗАУВАЖЕННЯ З ФАЙЛУ:" : "",
    ...remarkLines,
    instructions.trim() ? `\nЗАУВАЖЕННЯ ВІЛЬНИМ ТЕКСТОМ:\n${instructions.trim()}` : "",
    remarkFilesText ? `\nЗАУВАЖЕННЯ З ФОТО (розпізнано):\n${remarkFilesText}` : "",
    "\nВиконай усі зауваження, потім виклич finish.",
  ].filter(Boolean).join("\n");
  const conversation = [{ role: "user", content: [{ type: "text", text: firstText }] }];
  const readToolIds = new Set();

  // Додати блоки до останнього user-повідомлення (API не приймає двох user поспіль
  // як окремих — і порожнього assistant-повідомлення).
  const pushUser = blocks => {
    const last = conversation[conversation.length - 1];
    if (last.role === "user") last.content.push(...blocks);
    else conversation.push({ role: "user", content: blocks });
  };
  const compactConversation = () => {
    let size = 0;
    conversation.forEach(m => m.content.forEach(b => { size += (b.text || (typeof b.content === "string" ? b.content : "") || JSON.stringify(b.input || "")).length; }));
    if (size < CONVO_COMPACT_CHARS) return;
    conversation.slice(0, -8).forEach(m => m.content.forEach(b => {
      if (b.type === "tool_result" && readToolIds.has(b.tool_use_id) && typeof b.content === "string" && b.content.length > 300) {
        b.content = "[давній результат читання прибрано, щоб не переповнити контекст — за потреби прочитай знову]";
      }
    }));
  };

  // ── Агентний цикл ──
  const maxSteps = Math.min(250, Math.max(60, 40 + 6 * remarksCount));
  let steps = 0;
  let finished = false;
  let summary = "";
  let nudges = 0;
  let volumeRejects = 0;
  let remarkRejects = 0;
  const extraCached = [docInfo.join("\n\n")];

  while (steps < maxSteps && !finished) {
    steps++;
    compactConversation();
    let resp;
    try {
      resp = await callStep(conversation, systemPrompt, STEP_MAX_TOKENS, MODEL, { tools: TOOLS, extraCached, costTracker, onCost });
    } catch (e) {
      messages.push({ type: "error", text: e.isCostLimit ? e.message : `Помилка ШІ на кроці ${steps}: ${e.message}` });
      break;
    }
    const content = (resp.content || []).filter(b => b.type !== "text" || b.text);
    if (content.length) conversation.push({ role: "assistant", content });
    const toolUses = content.filter(b => b.type === "tool_use");

    if (!toolUses.length) {
      if (resp.stop_reason === "max_tokens" || nudges < 2) {
        nudges++;
        pushUser([{ type: "text", text: resp.stop_reason === "max_tokens"
          ? "Відповідь обрізано. Продовжуй меншими кроками через інструменти."
          : "Продовжуй через інструменти. Якщо всі зауваження виконано — виклич finish." }]);
        continue;
      }
      break;
    }

    const results = [];
    for (const tu of toolUses) {
      if (resp.stop_reason === "max_tokens" || tu._truncated) {
        results.push({ type: "tool_result", tool_use_id: tu.id, is_error: true, content: "Відповідь обрізано посеред виклику — нічого не змінено. Розбий зміну на менші частини (напр., не більше ~1500 слів за вставку)." });
        continue;
      }
      if (tu.name === "finish") {
        const input = tu.input || {};
        const reviewIds = new Set();
        (input.needs_review || []).forEach(nr => (`${nr.remark} ${nr.reason}`.toUpperCase().match(/#[HCNP]\d*/g) || []).forEach(id => reviewIds.add(id)));
        const pending = remarks.filter(r => !remarkDone(r) && !reviewIds.has(r.id.toUpperCase()));
        if (pending.length && remarkRejects < MAX_REMARK_REJECTS) {
          remarkRejects++;
          results.push({ type: "tool_result", tool_use_id: tu.id, is_error: true, content: `Завершити не можна — ще не опрацьовано: ${pending.slice(0, 15).map(r => `${r.id} «${clip(r.text || "", 80)}»${r.kind === "note" ? " (текст нотатки ще в документі)" : ""}`).join("; ")}${pending.length > 15 ? ` і ще ${pending.length - 15}` : ""}. Виправ їх, закрий через resolve (якщо змін не потрібно) або внеси в needs_review з міткою, потім знову виклич finish.` });
          continue;
        }
        const relaxed = !!(input.volume_change_reason || "").trim();
        bounds = volumeBounds({ beforeWords, pages: orderInfo.pages, relaxed });
        const w = currentWords();
        const outOfBounds = w > bounds.hi || w < bounds.lo;
        if (outOfBounds && volumeRejects < MAX_VOLUME_REJECTS) {
          volumeRejects++;
          // До найближчої межі із запасом — не до середини діапазону.
          const margin = Math.round((bounds.hi - bounds.lo) * 0.02) + 20;
          const diff = w > bounds.hi ? `скороти приблизно на ${w - bounds.hi + margin} слів` : `допиши приблизно ${bounds.lo - w + margin} слів`;
          results.push({ type: "tool_result", tool_use_id: tu.id, is_error: true, content: `Завершити не можна: ${volumeStatus()} Щоб повернутися в межі, ${diff} в інших підрозділах основної частини (не у вступі, висновках чи списку джерел і не скасовуючи вже виконаних правок), потім знову виклич finish.${relaxed ? "" : " Якщо зауваження ПРЯМО вимагає змінити обсяг — вкажи його у volume_change_reason."}` });
          continue;
        }
        finished = true;
        summary = input.summary || "";
        if (relaxed) messages.push({ type: "success", text: `Обсяг змінено за вимогою зауваження: ${input.volume_change_reason}` });
        for (const nr of input.needs_review || []) failed.push({ task: { label: nr.remark }, reason: nr.reason });
        pending.forEach(r => failed.push({ task: { label: `${r.id}: ${clip(r.text || r.instruction || "", 100)}` }, reason: "Агент не опрацював це зауваження — перевірте вручну." }));
        if (outOfBounds) failed.push({ task: { label: "Обсяг роботи" }, reason: `Після правок обсяг основної частини ${w} слів ≈ ${Math.round(w / WORDS_PER_PAGE)} стор. — поза межами ${bounds.lo}–${bounds.hi} слів; перевірте вручну.` });
        results.push({ type: "tool_result", tool_use_id: tu.id, content: "OK" });
        continue;
      }
      const fn = tools[tu.name];
      try {
        if (!fn) throw new Error(`Невідомий інструмент ${tu.name}.`);
        const out = await fn(tu.input || {});
        if (READ_TOOLS.has(tu.name)) readToolIds.add(tu.id);
        results.push({ type: "tool_result", tool_use_id: tu.id, content: out });
      } catch (e) {
        // Ліміт вартості всередині інструмента теж іде сюди як помилка — сам цикл
        // зупиниться на наступному кроці (callClaudeMessage → tracker.check()).
        results.push({ type: "tool_result", tool_use_id: tu.id, is_error: true, content: e.message || String(e) });
      }
    }
    pushUser(results);
  }

  if (!finished) {
    if (steps >= maxSteps) messages.push({ type: "error", text: `Агент зупинено після ${maxSteps} кроків — частину зауважень могло лишитися не виконано; перевірте документ.` });
    remarks.filter(r => !remarkDone(r)).forEach(r => failed.push({ task: { label: `${r.id}: ${clip(r.text || r.instruction || "", 100)}` }, reason: "Не опрацьовано — агент не завершив роботу." }));
  }
  // Позначки знімаємо з опрацьованих зауважень; з тих, що потребують перевірки
  // чи не опрацьовані, — лишаємо: людина побачить у файлі, де дивитися.
  remarks.filter(r => (r.kind === "highlight" || r.kind === "note") && r.resolved && remarkDone(r))
    .forEach(r => r.runs.filter(isAttached).forEach(run => { if (clearAttentionMarkers(run)) modified = true; }));
  if (summary) messages.push({ type: "success", text: summary });

  const afterWords = currentWords();
  if (!finished && (afterWords > bounds.hi || afterWords < bounds.lo)) {
    failed.push({ task: { label: "Обсяг роботи" }, reason: `Обсяг основної частини ${afterWords} слів — поза межами ${bounds.lo}–${bounds.hi}; перевірте вручну.` });
  }
  return { changes, failed, messages, appliedCount: changes.length, summary, steps, finished, modified, contextMode: mode, volume: { before: beforeWords, after: afterWords, ...bounds } };
}
