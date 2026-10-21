// ── Розбір готової частини роботи клієнта чистим кодом (без ШІ) ──
// Знаходить реальні заголовки розділів/підрозділів у тексті клієнта й розбиває
// текст саме за ними — тому текст завжди відповідає тому, що реально написано.
import { getLangLabels } from "./planUtils.js";

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const ORDINAL_CHAPTER_STEMS = { "перш": 1, "друг": 2, "трет": 3, "четверт": 4 };
const ORDINAL_CHAPTER_STEMS_PL = { "pierwsz": 1, "drug": 2, "trzeci": 3, "czwart": 4 };
const ORDINAL_CHAPTER_STEMS_ES = { "prim": 1, "segund": 2, "tercer": 3, "cuart": 4 };
const ORDINAL_CHAPTER_STEMS_CS = { "prvn": 1, "druh": 2, "třet": 3, "čtvrt": 4 };
const ORDINAL_CHAPTER_STEMS_SK = { "prv": 1, "druh": 2, "tret": 3, "štvrt": 4 };
const CARDINAL_WORDS_EN = { "one": 1, "two": 2, "three": 3, "four": 4 };
const ORDINAL_WORDS_EN = { "first": 1, "second": 2, "third": 3, "fourth": 4 };
const CHAPTER_NUMERALS_ZH = { "一": 1, "二": 2, "三": 3, "四": 4 };

// Заголовок списку джерел клієнт/методичка можуть називати по-різному —
// розпізнаємо поширені варіанти, а не лише фразу, яку сам застосунок
// використовує для власного фінального списку.
const SOURCES_HEADING_SYNONYMS = [
  "СПИСОК ВИКОРИСТАНИХ ДЖЕРЕЛ",
  "СПИСОК ВИКОРИСТАНОЇ ЛІТЕРАТУРИ",
  "СПИСОК ЛІТЕРАТУРИ",
  "БІБЛІОГРАФІЧНИЙ СПИСОК",
  "ПЕРЕЛІК ВИКОРИСТАНИХ ДЖЕРЕЛ",
  "ПЕРЕЛІК ДЖЕРЕЛ",
  "REFERENCES",
  "BIBLIOGRAPHY",
  "WORKS CITED",
  "LIST OF REFERENCES",
  "REFERENCE LIST",
  "LIST OF WORKS CITED",
  // Польська
  "SPIS BIBLIOGRAFICZNY",
  "SPIS LITERATURY",
  "WYKAZ LITERATURY",
  "WYKAZ ŹRÓDEŁ",
  "SPIS WYKORZYSTANEJ LITERATURY",
  // Іспанська
  "REFERENCIAS BIBLIOGRÁFICAS",
  "LISTA DE REFERENCIAS",
  "FUENTES BIBLIOGRÁFICAS",
  "REFERENCIAS",
  // Чеська
  "SEZNAM POUŽITÝCH ZDROJŮ",
  "BIBLIOGRAFIE",
  "SEZNAM LITERATURY",
  // Словацька
  "ZOZNAM POUŽITÝCH ZDROJOV",
  "BIBLIOGRAFIA",
  // Китайська
  "参考书目",
  "文献目录",
  "引用文献",
];

function buildPatterns(lang) {
  const L = getLangLabels(lang);
  const chapterWord = escapeRe(L.chapterWord);
  const introWord = escapeRe(L.intro);
  const conclWord = escapeRe(L.conclusions);
  const sourcesWord = escapeRe(L.sources);
  const sourcesAlt = SOURCES_HEADING_SYNONYMS.map(escapeRe).join("|");
  return {
    // \s* (не \s+) між словом розділу і номером — у китайській немає пробілів між ієрогліфами й цифрою ("第1章")
    chapter: new RegExp(`^\\s*${chapterWord}\\s*(\\d+)\\.?\\s*(.*)$`, "i"),
    // Дозволяємо будь-яку глибину нумерації (2.1, 2.1.1, 2.1.1.2...) — раніше тут
    // жорстко стояли рівно дві групи цифр, тому підпункти третього рівня (2.1.1)
    // взагалі не розпізнавались як заголовки й губились разом з усім своїм текстом.
    sub: /^\s*(\d+(?:\.\d+)+)\.?\s+(.{1,150})$/,
    // "Висновки до розділу 1" / "Висновок до 1 розділу" / "Висновки до першого розділу" / "Conclusions to Chapter 1" /
    // Wnioski do rozdziału 1 (pl) / Conclusiones del capítulo 1 (es) / Závěry ke kapitole 1 (cs) / Závery ku kapitole 1 (sk) —
    // \w у JS не читає кирилицю/діакритику, тому явний клас літер; номер розділу може стояти до або після слова
    // "розділу"/"rozdziału"/"capítulo"/"kapitole", або бути порядковим числівником рідною мовою
    chapConcl: new RegExp(
      "^\\s*(?:" +
        "виснов(?:ок|ки|ків)\\s+до\\s+(?:" +
          "(?<num1>\\d+)\\s*розділ[а-яґєії]*" +
          "|розділ[а-яґєії]*\\s+(?<num2>\\d+)" +
          "|(?<ord>перш|друг|трет|четверт)[а-яґєії]*\\s+розділ[а-яґєії]*" +
        ")" +
        // Англійська: "Conclusions to Chapter 1" / "Conclusions to Chapter One" / "Conclusions to the First Chapter"
        // (зворотний порядок "Chapter 1 Conclusions" не підтримуємо — такий рядок завжди перехоплює звичайний
        // патерн заголовка розділу `chapter`, який перевіряється раніше)
        "|conclusions?\\s+(?:to|of)\\s+(?:the\\s+)?(?:" +
          "chapter\\s*(?<num3>\\d+)" +
          "|chapter\\s+(?<enCard1>one|two|three|four)\\b" +
          "|(?<enOrd1>first|second|third|fourth)\\s+chapter" +
        ")" +
        // Польська
        "|(?:wniosk(?:i|ów)?|wniosek)\\s+do\\s+(?:" +
          "(?<numPl1>\\d+)\\.?\\s*rozdzia[łl][a-ząćęłńóśźż]*" +
          "|rozdzia[łl][a-ząćęłńóśźż]*\\s+(?:(?<numPl2>\\d+)|(?<ordPl2>pierwsz|drug|trzeci|czwart)[a-ząćęłńóśźż]*)" +
          "|(?<ordPl1>pierwsz|drug|trzeci|czwart)[a-ząćęłńóśźż]*\\s+rozdzia[łl][a-ząćęłńóśźż]*" +
        ")" +
        // Іспанська
        "|conclusi(?:ones|ón)\\s+del\\s+(?:" +
          "cap[íi]tulo\\s+(?:(?<numEs1>\\d+)|(?<ordEs1>prim|segund|tercer|cuart)[a-záéíóúñ]*)" +
          "|(?<ordEs2>prim|segund|tercer|cuart)[a-záéíóúñ]*\\s+cap[íi]tulo" +
        ")" +
        // Чеська
        "|z[áa]v[eě]r(?:y)?\\s+ke?\\s+(?:" +
          "(?<numCs1>\\d+)\\.?\\s*kapitol[a-záčďéěíňóřšťúůýž]*" +
          "|kapitol[a-záčďéěíňóřšťúůýž]*\\s+(?<numCs2>\\d+)" +
          "|(?<ordCs>prvn|druh|třet|čtvrt)[a-záčďéěíňóřšťúůýž]*\\s+kapitol[a-záčďéěíňóřšťúůýž]*" +
        ")" +
        // Словацька
        "|z[áa]v[eě]r(?:y)?\\s+ku?\\s+(?:" +
          "(?<numSk1>\\d+)\\.?\\s*kapitol[a-záäčďéíĺľňóôŕšťúýž]*" +
          "|kapitol[a-záäčďéíĺľňóôŕšťúýž]*\\s+(?<numSk2>\\d+)" +
          "|(?<ordSk>prv|druh|tret|štvrt)[a-záäčďéíĺľňóôŕšťúýž]*\\s+kapitol[a-záäčďéíĺľňóôŕšťúýž]*" +
        ")" +
        // Китайська: "第1章结论" / "第一章总结" / "本章小结" (без пробілів — ієрогліфи не розділяються пробілом;
        // "本章..." — без явного номера, береться номер поточного розділу за контекстом)
        "|第(?:(?<numZh1>\\d+)|(?<ordZh>[一二三四]))章(?:的)?(?:结论|总结|小结)" +
        "|(?<zhCurrent>本章)(?:的)?(?:结论|总结|小结)" +
      ")\\s*\\.?\\s*.*$",
      "i"
    ),
    intro: new RegExp(`^\\s*${introWord}\\s*$`, "i"),
    concl: new RegExp(`^\\s*${conclWord}\\s*$`, "i"),
    sources: new RegExp(`^\\s*(?:${sourcesWord}|${sourcesAlt})`, "i"),
  };
}

// Знаходить усі заголовки в тексті (за рядками) і повертає їх позиції
function detectHeadings(text, lang) {
  const P = buildPatterns(lang);
  const lines = text.split(/\r?\n/);
  const headings = [];
  let curChapNum = 0;
  let curChapTitle = "";

  lines.forEach((raw, i) => {
    const t = raw.trim();
    if (!t || t.length > 200) return;
    let m;
    if ((m = t.match(P.chapter))) {
      curChapNum = parseInt(m[1], 10);
      curChapTitle = t.replace(/\.$/, "");
      // "РОЗДІЛ 2" окремим рядком, а назва — наступним: доклеюємо її, інакше в роботі
      // лишався голий "РОЗДІЛ 2" без назви (кейс 41476)
      if (!m[2]?.trim()) {
        const next = lines.slice(i + 1).find(l => l.trim())?.trim() || "";
        if (next && next.length <= 200 && !P.sub.test(next) && !P.chapter.test(next) && !P.chapConcl.test(next)) {
          curChapTitle = `${curChapTitle}. ${next.replace(/\.$/, "")}`;
        }
      }
      headings.push({ lineIdx: i, kind: "chapter", chapNum: curChapNum, chapterTitle: curChapTitle });
    } else if ((m = t.match(P.sub))) {
      const id = m[1];
      headings.push({ lineIdx: i, kind: "sub", id, title: `${id} ${m[2].trim()}`, chapNum: parseInt(id.split(".")[0], 10) });
    } else if ((m = t.match(P.chapConcl))) {
      const g = m.groups || {};
      const numGroups = ["num1", "num2", "num3", "numPl1", "numPl2", "numEs1", "numCs1", "numCs2", "numSk1", "numSk2", "numZh1"];
      const ordGroups = { ord: ORDINAL_CHAPTER_STEMS, ordPl1: ORDINAL_CHAPTER_STEMS_PL, ordPl2: ORDINAL_CHAPTER_STEMS_PL, ordEs1: ORDINAL_CHAPTER_STEMS_ES, ordEs2: ORDINAL_CHAPTER_STEMS_ES, ordCs: ORDINAL_CHAPTER_STEMS_CS, ordSk: ORDINAL_CHAPTER_STEMS_SK, enCard1: CARDINAL_WORDS_EN, enOrd1: ORDINAL_WORDS_EN, ordZh: CHAPTER_NUMERALS_ZH };
      let n = null;
      for (const key of numGroups) { if (g[key]) { n = parseInt(g[key], 10); break; } }
      if (n === null) {
        for (const key of Object.keys(ordGroups)) { if (g[key]) { n = ordGroups[key][g[key].toLowerCase()]; break; } }
      }
      if (n === null && g.zhCurrent) n = curChapNum || null; // "本章小结" — номер розділу береться з контексту
      if (n) headings.push({ lineIdx: i, kind: "chapter_conclusion", id: `${n}.conclusions`, chapNum: n });
    } else if (P.intro.test(t)) {
      headings.push({ lineIdx: i, kind: "intro", id: "intro" });
    } else if (P.concl.test(t)) {
      headings.push({ lineIdx: i, kind: "conclusions", id: "conclusions" });
    } else if (P.sources.test(t)) {
      headings.push({ lineIdx: i, kind: "sources", id: "sources" });
    }
  });
  return { headings: dropTocHeadings(headings, lines), lines };
}

// Рядок "ЗМІСТ" / "CONTENTS" / "SPIS TREŚCI"… окремим рядком — початок змісту документа
const TOC_HEADING_RE = /^\s*(?:зміст|содержание|contents|table\s+of\s+contents|spis\s+treści|índice|indice|inhaltsverzeichnis|inhalt|obsah|目录)\s*[:.]?\s*$/i;

// Рядки ЗМІСТУ на початку готової частини — теж "заголовки" (1.1, 2.1, РОЗДІЛ 3…), але тексту під
// ними немає: без цього пункти, які є лише в змісті, вважались готовими (порожніми "шапками"), і
// дописування за планом нічого не дописувало (кейс 41570: у змісті готового розділу 1 був увесь план).
// Зміст закінчується на першому заголовку, що повторює вже побачений у змісті, — це початок тексту.
function dropTocHeadings(headings, lines) {
  const tocLine = lines.findIndex(l => TOC_HEADING_RE.test(l));
  if (tocLine < 0) return headings;
  const key = (h) => h.kind === "chapter" ? `chapter:${h.chapNum}` : `${h.kind}:${h.id}`;
  const seen = new Set();
  let bodyStart = -1;
  for (let k = 0; k < headings.length; k++) {
    if (headings[k].lineIdx < tocLine) continue;
    const kk = key(headings[k]);
    if (seen.has(kk)) { bodyStart = k; break; }
    seen.add(kk);
  }
  if (bodyStart < 0) return headings;
  return headings.filter((h, k) => h.lineIdx < tocLine || k >= bodyStart);
}

// Юридичні методички нерідко ділять список джерел римськими цифрами
// ("І. Нормативна література", "ІІ. Спеціальна література" тощо) — такий рядок
// не є ні новим пронумерованим записом (не починається з арабської цифри), ні
// продовженням попереднього речення джерела, тож без окремої перевірки він
// мовчки приклеївся б до тексту останнього перед ним запису.
const ROMAN_SUBHEADING_RE = /^[ІIVX]+\.\s+\S/;

// Розбиває "СПИСОК ВИКОРИСТАНИХ ДЖЕРЕЛ" на пронумеровані записи { number: text }
function parseBibliography(sourcesText) {
  const bib = {};
  const lines = sourcesText.split(/\r?\n/);
  let curNum = null;
  lines.forEach(raw => {
    const t = raw.trim();
    if (!t) return;
    const m = t.match(/^(\d+)[.)]\s*(.+)$/);
    if (m) {
      curNum = parseInt(m[1], 10);
      bib[curNum] = m[2].trim();
    } else if (ROMAN_SUBHEADING_RE.test(t)) {
      // заголовок підрозділу списку — не запис і не продовження, пропускаємо
    } else if (curNum !== null) {
      // продовження попереднього запису на новому рядку
      bib[curNum] += " " + t;
    }
  });
  return bib;
}

// Знаходить позначки цитувань [N] у тексті підрозділу, перенумеровує їх локально (1,2,3...)
// і повертає { text, sources[] } — sources у форматі "рядок на джерело", як citInputs
function localizeCitations(text, bibliography, usedGlobal = null) {
  // Дужка може містити кілька позначень одразу, кожне зі своєю сторінкою:
  // "[14 с.76; 16 с.211]", "[14, с.39; 15, с.214]", "[6; 23]", "[21]" — формат
  // сторінки (кома чи без, "с."/"c."/"стор.") надто різний, щоб описати одним
  // жорстким шаблоном. Тому просто ділимо вміст дужки на частини за "," / ";" і
  // з кожної частини беремо цифри на початку — це і є номер джерела, а хвіст
  // (сторінка) нас тут не цікавить. Раніше жорсткий шаблон часто зіставляв лише
  // перший номер, а решту (разом зі сторінками) мовчки викидав як "хвіст".
  const numRe = /\[\s*(\d+[^\]]*)\]/g;
  const localMap = new Map(); // globalNum → localIdx (1-based)
  const localSources = [];

  const rewritten = text.replace(numRe, (whole, inner) => {
    const globalNums = inner
      .split(/[,;]/)
      .map(seg => { const m = seg.trim().match(/^(\d+)/); return m ? parseInt(m[1], 10) : NaN; })
      .filter(n => !isNaN(n) && bibliography[n]);
    if (!globalNums.length) return whole; // не змогли зіставити — лишаємо як є
    const localNums = globalNums.map(gn => {
      usedGlobal?.add(gn);
      if (!localMap.has(gn)) {
        localSources.push(bibliography[gn]);
        localMap.set(gn, localSources.length);
      }
      return localMap.get(gn);
    });
    return `[${localNums.join(", ")}]`;
  });

  return { text: rewritten, sources: localSources };
}

// ── Головна функція: код-only розбір готової частини роботи клієнта ──
// planIds: опційний масив id/label з явного плану клієнта — якщо задано, назви беруться звідти,
// а текст зіставляється за номером розділу/підрозділу.
export function extractReadyWorkStructure({ documentText, lang = "Українська", planSections = null }) {
  const { headings, lines } = detectHeadings(documentText, lang);
  if (headings.length < 3) return null; // замало розпізнано — нехай викликач падає на ШІ-резерв

  // Знаходимо межі бібліографії окремо (щоб не рахувати її як звичайний текст розділу)
  const srcHeading = headings.find(h => h.kind === "sources");
  const bibliography = srcHeading
    ? parseBibliography(lines.slice(srcHeading.lineIdx + 1).join("\n"))
    : {};

  const sections = [];
  const content = {};
  const citInputs = {};
  const foundIds = [];

  const chapterTitleByNum = {};
  headings.forEach(h => { if (h.kind === "chapter") chapterTitleByNum[h.chapNum] = h.chapterTitle; });

  const planById = new Map((planSections || []).map(s => [s.id, s]));
  const usedBibNums = new Set();

  headings.forEach((h, idx) => {
    if (h.kind === "chapter") return; // сама назва розділу — лише контекст для підрозділів, не окрема секція
    const nextIdx = h.lineIdx + 1;
    const endIdx = idx + 1 < headings.length ? headings[idx + 1].lineIdx : lines.length;
    const rawText = lines.slice(nextIdx, endIdx).join("\n").trim();
    if (h.kind === "sources") return; // бібліографія вже розібрана окремо, не потрібна як content
    // Підрозділ-«шапка» без власного тексту перед першим вкладеним пунктом
    // (напр. "2.1 Назва групи" одразу перед "2.1.1 ...") — не пропускаємо інакше
    // назва групи зникає з документа; рендеримо як заголовок без тексту під ним.
    // "Шапка" — лише коли одразу за нею йде вкладений пункт; порожній пункт без дітей — це
    // заголовок без тексту (зміст, недописане), він не готовий і має дописатись за планом.
    const next = headings[idx + 1];
    const isHeadingOnlySub = h.kind === "sub" && !rawText
      && next?.kind === "sub" && next.id.startsWith(h.id + ".");
    if (!rawText && !isHeadingOnlySub) return;

    const words = rawText.split(/\s+/).filter(Boolean).length;
    const pages = isHeadingOnlySub ? 0 : Math.max(1, Math.round(words / 230));
    const { text, sources } = isHeadingOnlySub ? { text: "", sources: [] } : localizeCitations(rawText, bibliography, usedBibNums);

    let type = "intro";
    let label = "Вступ";
    let sectionTitle;
    if (h.kind === "sub") {
      type = h.chapNum === 1 ? "theory" : h.chapNum === 2 ? "analysis" : "recommendations";
      label = h.title;
      sectionTitle = chapterTitleByNum[h.chapNum];
      const planMatch = planById.get(h.id);
      if (planMatch) { label = planMatch.label; sectionTitle = planMatch.sectionTitle || sectionTitle; }
    } else if (h.kind === "chapter_conclusion") {
      type = "chapter_conclusion";
      label = `Висновки до розділу ${h.chapNum}`;
      sectionTitle = chapterTitleByNum[h.chapNum];
    } else if (h.kind === "conclusions") {
      type = "conclusions"; label = "Висновки";
    } else if (h.kind === "intro") {
      type = "intro"; label = "Вступ";
    }

    sections.push({ id: h.id, label, ...(sectionTitle ? { sectionTitle } : {}), pages, type, ...(isHeadingOnlySub ? { headingOnly: true } : {}) });
    content[h.id] = text;
    foundIds.push(h.id);
    if (sources.length) citInputs[h.id] = sources.join("\n");
  });

  if (sections.length < 3) return null;

  // Джерела зі списку клієнта, на які в тексті немає жодного [N], — теж мають потрапити в
  // спільний список роботи. Чіпляємо їх до останнього готового підрозділу розділу: у фінальному
  // перерозподілі (runRemapStage) такі "осиротілі" джерела готової частини лишаються в списку
  // без довставки посилань — готовий текст клієнта не змінюється.
  const uncited = Object.keys(bibliography).map(Number).sort((a, b) => a - b)
    .filter(n => !usedBibNums.has(n)).map(n => bibliography[n]).filter(Boolean);
  if (uncited.length) {
    const host = [...sections].reverse().find(s => !s.headingOnly && !["intro", "conclusions"].includes(s.type))
      || [...sections].reverse().find(s => !s.headingOnly);
    if (host) citInputs[host.id] = [citInputs[host.id], ...uncited].filter(Boolean).join("\n");
  }

  return { sections, content, citInputs, foundIds };
}

// Чи схожий файл, завантажений як "матеріали клієнта", насправді на готову частину роботи
// (кейс 41476: готовий розділ 2 поклали в матеріали — його не вставили як є, а переписали,
// і посилання з тексту "[14 с.39]" потрапили в список джерел). Ознаки: це великий текст, і
// щонайменше два його пронумеровані заголовки (2.1, 2.1.1…) збігаються з планом клієнта
// і за номером, і за назвою. Без плану — лише з allowWithoutPlan (UI, де людина
// підтверджує сама): тоді достатньо ≥3 пронумерованих заголовків.
export function looksLikeReadyPart(text, planText, { lang = "Українська", allowWithoutPlan = false } = {}) {
  if (!text?.trim()) return false;
  const words = text.split(/\s+/).filter(Boolean).length;
  if (words < 1500) return false;
  const subs = detectHeadings(text, lang).headings.filter(h => h.kind === "sub");
  const plan = quickParsePlanIds(planText || "");
  if (!plan.length) return allowWithoutPlan && subs.length >= 3;
  const norm = (s) => String(s || "").replace(/^\s*\d+(?:\.\d+)*\.?\s*/, "").toLowerCase().replace(/[^a-zа-яґєії]/gi, "");
  const planById = new Map(plan.map(p => [p.id, norm(p.label)]));
  const matches = subs.filter(h => {
    const a = planById.get(h.id), b = norm(h.title);
    if (!a || !b) return false;
    const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
    return shorter.length >= 12 && longer.startsWith(shorter);
  });
  return matches.length >= 2;
}

// Швидкий розбір явного плану клієнта (текст) на список {id, label} — лише для зіставлення
// назв підрозділів під час імпорту готової частини роботи, без повного парсингу конфлікту сторінок.
export function quickParsePlanIds(planText) {
  const ids = [];
  const lines = (planText || "").split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  for (const line of lines) {
    // будь-яка глибина: 1.1, 1.1.1, 1.1.1.1
    const subM = line.match(/^(\d+(?:\.\d+)+)\.?\s+(.+)$/);
    if (subM) ids.push({ id: subM[1], label: line.replace(/(?:\s*[…‥]|[.·\s]{3,})[.…·‥\s]*\d*\s*$/, "").replace(/\.$/, ""), chapNum: parseInt(subM[1], 10) });
  }
  return ids;
}
