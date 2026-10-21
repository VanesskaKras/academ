// ─────────────────────────────────────────────
// smallStages.js — спільна, не прив'язана до React орхестраційна логіка потоку
// "малих робіт" (реферат/тези/стаття/есе/презентація) — той самий патерн, що й
// orderStages.js: кожна функція приймає (order, ctx) і повертає патч полів для
// збереження, без setState/window/alert усередині. Джерело логіки —
// src/small-works.jsx (React-компонент SmallWorks), звідки цей файл перенесений
// без зміни логіки, щоб той самий потік міг виконуватись і в браузері (замість
// дублювання), і в серверному воркері (worker/*) без React.
//
// order — плоский стан замовлення (та ж форма, що документ Firestore, mode:"small"):
//   workType, tplText, comment, clientPlan, materialText, deptGuidanceText,
//   structureExampleText (реферат), essayExampleText (есе — стиль/аргументація/
//   оформлення, лише перший чанк runSimple), files, materialFiles, instrFiles, authorData, info,
//   methodInfo, methodRequirements, sections, citInputs, citStructured,
//   tezyCitations, result, slides, annotationUk, citStyleOverride,
//   sourcesOrderOverride, citFootnotes
// ctx — { callClaude, callGemini, onProgress?(msg), onCost?, signal? }
//   callClaude/callGemini тут — ВЖЕ прив'язані до costTracker/onCost версії
//   (як у orderStages.js) — ці функції самі не керують лічильником вартості.
// ─────────────────────────────────────────────
import mammoth from "mammoth";
import { extractPptxText } from "./pptxText.js";
import { MODEL, MODEL_FAST } from "./api.js";
import { buildSYSSmall, buildSmallWorkFormattingPrompt, buildReferatAnnotationPrompt, SYS_JSON_SHORT } from "./prompts.js";
import { runSourcesStage } from "./orderStages.js";
import { getSourcesMinFromTable, extractPlanBlock, getLangLabels, chapterWordRe, chapterHeadingPrefix, sourcesHeading, matchSourcesBlock, isSourcesTitle } from "./planUtils.js";
import { typographQuotes, stripStrayCJK } from "./textCleanup.js";
import { withLangProfile } from "./langProfile.js";
import {
  remapAndFormatCitations, applyCitationRemap, detectSourceGrouping,
  createReferenceDeduper, insertMissingCitations, capCitationRepeats, isLawSource,
  extractCitedNumbers, citationMarkerWithPage,
} from "./citationFormatting.js";
import { buildContentPagePickers } from "./contentPages.js";
import { enforceWordCount, enforceTotalVolume } from "./wordCount.js";
import { fixDanglingFigures, fixMissingTableConclusion, dedupeRepeatedFigures } from "./figureFixup.js";

const WORK_TYPE_LABELS = {
  referat: "Реферат", tezy: "Тези", stattia: "Стаття", ese: "Есе",
  prezentatsiya: "Презентація", dopovid: "Доповідь та презентація",
};

// Мінімум джерел за таблицею (той самий SOURCES_MIN_TABLE, що й для курсової/
// диплома) — для тез/статті/есе за обсягом сторінок; null, якщо таблиця не
// покриває цей діапазон (викликач падає на старий дефолт-фолбек).
function getSmallWorkSourcesMin(workType, pages) {
  const tableLabel = workType === "stattia" ? "наукова стаття" : workType === "tezy" ? "тези" : workType === "ese" ? "есе" : null;
  if (!tableLabel) return null;
  return getSourcesMinFromTable(tableLabel, pages);
}

// Дефолт 20 — для малих робіт (реферат, тези, есе). Велика версія в lib/planUtils.js має дефолт 80.
function parsePagesAvg(str) {
  if (!str) return 20;
  const s = String(str);
  const nums = s.match(/\d+/g);
  if (!nums) return 20;
  const avg = nums.length === 1 ? parseInt(nums[0]) : Math.round(nums.reduce((a, b) => a + parseInt(b), 0) / nums.length);
  if (/слів|слова|слово|words?\b/i.test(s)) return Math.max(1, Math.round(avg / 230));
  return avg;
}

function cleanDash(raw) {
  return raw.replace(/ — /g, ", ").replace(/— /g, " ").replace(/ —/g, " ");
}

// ── Файл → контент для Claude. Claude приймає для "document" лише application/pdf,
// тож docx/doc конвертуємо в текст через mammoth, а не шлемо як document (інакше 400 від API). ──
async function toClaudeFileAsync(f) {
  if (f.type.startsWith("image/")) {
    return { type: "image", source: { type: "base64", media_type: f.type, data: f.b64 } };
  }
  const isDocx = f.type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    || f.type === "application/msword"
    || /\.docx?$/i.test(f.name || "");
  if (isDocx) {
    try {
      const bytes = Uint8Array.from(atob(f.b64), c => c.charCodeAt(0));
      const result = await mammoth.extractRawText(typeof Buffer !== "undefined" ? { buffer: Buffer.from(bytes) } : { arrayBuffer: bytes.buffer }); // Node-воркер: mammoth приймає лише buffer (інакше «Could not find file in options»)
      return { type: "text", text: `[Файл: ${f.name}]\n\n${result.value.trim()}` };
    } catch {
      return { type: "text", text: `[Файл: ${f.name}] — не вдалося прочитати вміст.` };
    }
  }
  return { type: "document", source: { type: "base64", media_type: "application/pdf", data: f.b64 } };
}
const toClaudeFilesAsync = files => Promise.all((files || []).map(toClaudeFileAsync));

// Будує карту формату посилань для промпту: { 1: "[1]", ... } — лише номер. Сторінку
// в посиланні ставить код на фінальному кроці (runSmallRemap → applyCitationRemap) з
// перевіреного діапазону джерела, різну для повторних посилань. Раніше тут моделі
// давали готове "[N, с. X]" з першою сторінкою статті (тож кожне посилання на джерело
// мало ту саму сторінку), а розбір рядка брав за сторінку рік ("процес. 2021").
function buildCiteMap(citations) {
  const map = {};
  citations.forEach((_, i) => { map[i + 1] = `[${i + 1}]`; });
  return map;
}

// Дедуплікація + (для реферату) опційне сортування за алфавітом із законами
// попереду — та сама логіка, що doGenerateFromCitText/doGenerateFromCitInputs.
function dedupAndSortCitations(rawLines, { sortAlpha, sourcesFormatRules, sourcesGrouping } = {}) {
  const deduper = createReferenceDeduper();
  let citations = rawLines.map(c => { deduper.add(c); return c; });
  citations = deduper.canonicalRefs;
  if (sortAlpha) {
    const { lawFirst } = detectSourceGrouping({ sourcesFormatRules, sourcesGrouping });
    const isLaw = s => lawFirst && isLawSource(s);
    citations = [...citations].sort((a, b) => {
      const lawA = isLaw(a), lawB = isLaw(b);
      if (lawA !== lawB) return lawA ? -1 : 1;
      return a.localeCompare(b, "uk");
    });
  }
  return citations;
}

/**
 * Аналіз замовлення (шаблон + файли) → info/methodInfo/methodRequirements і
 * наступна стадія за типом роботи (referat→"plan", tezy/stattia/ese/
 * prezentatsiya→"sources", інакше→"writing"). Перенесено з doAnalyze
 * (small-works.jsx) без зміни логіки промптів.
 *
 * @param {object} order - { workType, tplText, comment, materialText, deptGuidanceText, files, materialFiles }
 * @param {object} ctx - { callClaude, onProgress? }
 * @returns {Promise<object>} патч {info, methodInfo?, methodRequirements?, stage, status}
 */
export async function runSmallAnalyze(order, ctx) {
  const { callClaude, onProgress } = ctx;
  const workType = order.workType;
  const tplText = order.tplText || "";
  const comment = order.comment || "";
  const materialText = order.materialText || "";
  const deptGuidanceText = order.deptGuidanceText || "";
  const files = order.files || [];
  const materialFiles = order.materialFiles || [];

  onProgress?.("Аналізую замовлення...");
  const isTezy = workType === "tezy";
  // Для тез методичка, рекомендації кафедри і матеріал — окремі поля з різною роллю
  // (вимоги vs зміст), тож і підписуємо файли окремо, щоб модель їх не змішувала.
  const fileContext = isTezy && files.length > 0
    ? [{ type: "text", text: "Методичка / вимоги конференції (файли):" }, ...await toClaudeFilesAsync(files)]
    : await toClaudeFilesAsync(files);
  const matFileContext = materialFiles.length > 0
    ? [{ type: "text", text: isTezy ? "Матеріал для роботи — зміст (файли):" : "Матеріал, методичка та вимоги (файли):" }, ...await toClaudeFilesAsync(materialFiles)]
    : [];

  const isSimpleWithSources = ["stattia", "ese"].includes(workType);
  const isStattia = workType === "stattia";
  const isReferat = workType === "referat";
  const tezyFields = isTezy ? `,"needsSources":true,"sourceCount":null,"authorFormat":"center","bodyStructure":"linear","needsEmail":false,"needsUDK":false,"needsFigures":false,"figureCount":null` : "";
  const simpleFields = isSimpleWithSources ? `,"sourceCount":null,"citStyle":"ДСТУ","needsFigures":false,"figureCount":null,"sortAlpha":false` : "";
  const stattiaFields = isStattia ? `,"authorFormat":"center","needsEmail":false,"needsUDK":true` : "";
  const referatFields = isReferat ? `,"sourceCount":null,"sortAlpha":true,"citStyle":"ДСТУ","titlePageInfo":null,"introStructure":null` : "";
  const tezyHints = isTezy ? `
needsSources — чи конференція вимагає список джерел (true/false).
sourceCount — скільки джерел, ТІЛЬКИ якщо методичка/шаблон явно вказують число. null якщо не вказано явно (типове значення підставить система).
authorFormat — вирівнювання блоку автора: "center" або "right".
bodyStructure — "linear" (Актуальність→Мета→Результати→Висновки) або "structured" (Преамбула→Тези→Аргументація→Демонстрація→Результати).
needsEmail — чи треба email автора (true/false).
needsUDK — чи треба УДК (true/false).
needsFigures — чи потрібні рисунки/схеми у тезах за методичкою або матеріалом (true/false).
figureCount — скільки рисунків, ТІЛЬКИ якщо явно вказано. null якщо не вказано явно.` : "";
  const simpleHints = isSimpleWithSources ? `
sourceCount — скільки джерел потрібно, ТІЛЬКИ якщо методичка/шаблон явно вказують число. null якщо не вказано явно (типове значення підставить система).
citStyle — стиль цитування: "ДСТУ" або "APA" або інший зазначений у вимогах.
needsFigures — чи потрібні рисунки/схеми (true/false).
figureCount — скільки рисунків, ТІЛЬКИ якщо явно вказано. null якщо не вказано явно.
sortAlpha — чи сортувати список літератури за алфавітом (true/false).` : "";
  const stattiaHints = isStattia ? `
authorFormat — вирівнювання блоку автора під назвою статті: "center" або "right".
needsEmail — чи вказати email автора у статті (true/false).
needsUDK — чи потрібен код УДК першим рядком статті (true/false, за замовчуванням true для наукової статті, якщо у вимогах явно не сказано інше).` : "";
  const referatHints = isReferat ? `
sourceCount — мінімальна кількість джерел, ТІЛЬКИ якщо методичка явно вказує число. null якщо не вказано явно (система сама підставить кількість = обсягу сторінок).
sortAlpha — чи сортувати список літератури за алфавітом (true/false).
citStyle — стиль цитування: "ДСТУ" або "APA" або інший зазначений у вимогах. Якщо не вказано — "ДСТУ".
titlePageInfo — якщо у файлах (фото або PDF) знайдено титульну сторінку — витягни дані у вигляді JSON-обʼєкта: {"university":"...","faculty":"...","discipline":"...","student":"...","supervisor":"...","year":"...","city":""}. Якщо університет, студент або керівник не вказані — залиш поле порожнім рядком. Якщо титульної сторінки немає — null.
introStructure — якщо у методичці явно вказана структура вступу (перелік обовʼязкових елементів: актуальність, мета, обʼєкт, предмет тощо) — скопіюй вимоги одним рядком. Якщо не вказано — null.` : "";

  const materialHint = ((isTezy || isSimpleWithSources || isReferat || workType === "prezentatsiya") && materialText.trim())
    ? `\nМАТЕРІАЛ (фрагмент для розуміння теми):\n${materialText.trim().slice(0, 1500)}`
    : "";
  const deptGuidanceHint = ((isReferat || isTezy) && deptGuidanceText.trim())
    ? `\nДОДАТКОВІ РЕКОМЕНДАЦІЇ КАФЕДРИ/ВИКЛАДАЧА (враховуй нарівні з методичкою): ${deptGuidanceText.trim()}`
    : "";

  const prompt = `Проаналізуй замовлення на ${WORK_TYPE_LABELS[workType] || workType}.

ШАБЛОН:
${tplText}
${comment ? `\nКОМЕНТАР: ${comment}` : ""}${materialHint}${deptGuidanceHint}

Поверни ТІЛЬКИ JSON (без markdown):
{"type":"${WORK_TYPE_LABELS[workType] || workType}","pages":"","topic":"","subject":"","direction":"","uniqueness":"","language":"Українська","deadline":"","orderNumber":"","requirements":"","formatting":{"left":null,"right":null,"top":null,"bottom":null}${tezyFields}${simpleFields}${stattiaFields}${referatFields}}

orderNumber — номер замовлення якщо є (наприклад "37808.2"), інакше порожній рядок.
pages — кількість сторінок, якщо явно вказана у шаблоні/коментарі/файлах (число або діапазон, наприклад "10" або "10-12"). Якщо не вказано — порожній рядок.
requirements — якщо є рекомендації у файлах, стисло опиши ключові вимоги до структури та оформлення.
formatting — поля сторінки в мм якщо явно вказані у файлах або коментарі: left (ліве), right (праве), top (верхнє), bottom (нижнє). Якщо написано "зі всіх сторін X см" — постав X*10 у всі чотири поля. null для кожного поля якщо не вказано.${tezyHints}${simpleHints}${stattiaHints}${referatHints}`;

  const msgs = [{ role: "user", content: [...fileContext, ...matFileContext, { type: "text", text: prompt }] }];
  const model = ((isTezy || isSimpleWithSources || isReferat || workType === "prezentatsiya") && (files.length > 0 || materialFiles.length > 0)) ? MODEL : MODEL_FAST;
  const raw = await callClaude(msgs, ctx.signal, "Respond only with valid JSON. No markdown.", 10000, null, model, { onCost: ctx.onCost });
  const parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || raw);
  const extractedFormatting = parsed.formatting;
  delete parsed.formatting;
  if (!parsed.orderNumber) {
    const m = tplText.match(/№\s*замовлення\s*[-–—:]\s*(\S+)/i);
    if (m) parsed.orderNumber = m[1].trim();
  }
  if (parsed.sourceCount == null || parsed.sourceCount === "") {
    if (isReferat) parsed.sourceCount = Number(parsed.pages) || 10;
    else if (isStattia) parsed.sourceCount = 5;
    else if (isTezy || workType === "ese") parsed.sourceCount = 3;
  }
  if ((isTezy || isSimpleWithSources) && (parsed.figureCount == null || parsed.figureCount === "")) {
    parsed.figureCount = parsed.needsFigures ? (isTezy ? 1 : 2) : 0;
  }
  // Мова поза таблицею — ШІ один раз складає для неї набір підписів (langProfile.js)
  const newInfo = await withLangProfile({ ...parsed, workType }, callClaude, { signal: ctx.signal, onCost: ctx.onCost });
  let mergedMethodInfo = null;
  if (extractedFormatting?.left || extractedFormatting?.right || extractedFormatting?.top || extractedFormatting?.bottom) {
    const toNum = v => (v != null && v !== "" ? Number(v) : null);
    mergedMethodInfo = { formatting: { margins: { left: toNum(extractedFormatting.left), right: toNum(extractedFormatting.right), top: toNum(extractedFormatting.top), bottom: toNum(extractedFormatting.bottom) } } };
  }

  let extractedMethodReqs = "";
  if (fileContext.length > 0) {
    onProgress?.("Читаю вимоги методички...");
    const reqMsgs = [{ role: "user", content: [...fileContext, { type: "text", text: `Уважно прочитай ці вимоги/методичку до написання ${WORK_TYPE_LABELS[workType] || "роботи"}. Витягни ВСІ вимоги: структуру роботи, обсяг кожного розділу, форматування (шрифт, поля, інтервал), вимоги до джерел та цитування, стиль написання, особливі умови конференції/викладача. Поверни лише текст вимог — повно але без зайвих коментарів. Відповідай мовою документу.` }] }];
    const fmtMsgs = [{ role: "user", content: [...fileContext, { type: "text", text: buildSmallWorkFormattingPrompt() }] }];
    const [reqResult, fmtResult] = await Promise.allSettled([
      callClaude(reqMsgs, ctx.signal, "You are a helpful assistant. Extract requirements from the provided documents.", 2000, null, MODEL, { onCost: ctx.onCost }),
      callClaude(fmtMsgs, ctx.signal, "Respond only with valid JSON. No markdown.", 1500, null, MODEL, { onCost: ctx.onCost }),
    ]);
    if (reqResult.status === "fulfilled") {
      extractedMethodReqs = reqResult.value.trim();
    } else {
      console.warn("methodRequirements extraction failed:", reqResult.reason?.message);
    }
    if (fmtResult.status === "fulfilled") {
      try {
        const fmt = JSON.parse(fmtResult.value.match(/\{[\s\S]*\}/)?.[0] || fmtResult.value);
        mergedMethodInfo = {
          ...(mergedMethodInfo || {}),
          ...(fmt.sourcesStyle ? { sourcesStyle: fmt.sourcesStyle } : {}),
          ...(fmt.sourcesOrder ? { sourcesOrder: fmt.sourcesOrder } : {}),
          ...(fmt.sourcesGrouping ? { sourcesGrouping: fmt.sourcesGrouping } : {}),
          ...(fmt.citationStyle ? { citationStyle: fmt.citationStyle } : {}),
          ...(fmt.sourcesFormatRules ? { sourcesFormatRules: fmt.sourcesFormatRules } : {}),
          ...(fmt.recommendedSources ? { recommendedSources: fmt.recommendedSources } : {}),
          ...(fmt.annotationExample ? { annotationExample: fmt.annotationExample } : {}),
          ...(fmt.needsAnnotation ? { needsAnnotation: true } : {}),
          formatting: { ...(mergedMethodInfo?.formatting || {}), ...(fmt.formatting || {}), margins: { ...(mergedMethodInfo?.formatting?.margins || {}), ...(fmt.formatting?.margins || {}) } },
        };
      } catch (e) {
        console.warn("formatting extraction parse failed:", e.message);
      }
    } else {
      console.warn("formatting extraction failed:", fmtResult.reason?.message);
    }
  }

  const fullMethodInfo = mergedMethodInfo
    ? { ...(order.methodInfo || {}), ...mergedMethodInfo, formatting: { ...(order.methodInfo?.formatting || {}), ...mergedMethodInfo.formatting } }
    : undefined;

  let stage, status = "new";
  if (workType === "referat") stage = "plan";
  else if (isTezy && newInfo.needsSources !== false) stage = "sources";
  else if (isSimpleWithSources) stage = "sources";
  else if (workType === "prezentatsiya") stage = "sources";
  else stage = "writing";

  return {
    info: newInfo,
    ...(extractedMethodReqs ? { methodRequirements: extractedMethodReqs } : {}),
    ...(fullMethodInfo ? { methodInfo: fullMethodInfo } : {}),
    stage, status,
  };
}

/**
 * План розділів реферату — з clientPlan (якщо є, парситься по рядках) або AI.
 * Перенесено з doGenPlan (small-works.jsx) без зміни логіки.
 *
 * @param {object} order - { info, clientPlan, deptGuidanceText, structureExampleText, files }
 * @param {object} ctx - { callClaude, onProgress? }
 * @returns {Promise<object>} патч {sections, stage:"plan", status:"plan_ready"}
 */
export async function runReferatPlan(order, ctx) {
  const { callClaude, onProgress } = ctx;
  const effInfo = order.info;
  const clientPlan = extractPlanBlock(order.clientPlan || "");
  const deptGuidanceText = order.deptGuidanceText || "";
  const structureExampleText = order.structureExampleText || "";
  onProgress?.("Генерую план...");
  const totalPages = parsePagesAvg(effInfo?.pages);
  const chapCount = totalPages < 10 ? 2 : 3;
  const pagesPerChap = Math.max(2, Math.round((totalPages - 2) / chapCount));
  // Підписи вступу/висновків/списку джерел і слово "розділ" — мовою роботи (раніше завжди
  // українською, і експорт брав їх як є навіть для англійського реферату).
  const L = getLangLabels(effInfo?.language);

  let newSections = [];
  if (clientPlan.trim()) {
    const lines = clientPlan.split("\n").map(l => l.trim()).filter(Boolean);
    const chapSecs = lines
      .filter(l => chapterWordRe().test(l) || /^\d+\.?\s+\p{L}/u.test(l))
      .map((l, i) => ({ id: `${i + 1}`, label: l, text: "", pages: pagesPerChap }));
    if (chapSecs.length > 0) {
      newSections = [
        { id: "intro", label: L.intro, text: "", pages: 1 },
        ...chapSecs,
        { id: "conclusions", label: L.conclusions, text: "", pages: 1 },
        { id: "sources", label: L.sources, text: "", pages: 0 },
      ];
    }
  }

  if (newSections.length === 0) {
    const fileContext = await toClaudeFilesAsync(order.files);

    const chapEntries = Array.from({ length: chapCount }, (_, i) =>
      `  {"id":"${i + 1}","label":"${chapterHeadingPrefix(effInfo?.language, i + 1)}. Назва","pages":${pagesPerChap}}`
    ).join(",\n");

    const prompt = `Склади план реферату.
Тема: "${effInfo?.topic}". Галузь: ${effInfo?.subject || ""}. Обсяг: ${totalPages} стор.
${L.code !== "uk" ? `Мова роботи: ${effInfo?.language}. Усі назви в плані (розділи, вступ, висновки, список джерел) — ТІЛЬКИ цією мовою.\n` : ""}Кількість основних розділів: ${chapCount}.
${effInfo?.requirements ? `Вимоги методички: ${effInfo.requirements}` : ""}
${deptGuidanceText.trim() ? `\nДодаткові рекомендації кафедри/викладача (враховуй нарівні з методичкою): ${deptGuidanceText.trim()}\n` : ""}
${structureExampleText.trim() ? `\nЗРАЗОК СТРУКТУРИ реферату — побудуй план розділів за реальною структурою цього зразка:\n${structureExampleText.trim().slice(0, 4000)}\n` : ""}

Назви розділів мають відповідати темі. Якщо є зразок структури — пріоритет за ним, інакше якщо у методичці є конкретна структура — використай її.

Поверни ТІЛЬКИ JSON:
{"sections":[
  {"id":"intro","label":"${L.intro}","pages":1},
${chapEntries},
  {"id":"conclusions","label":"${L.conclusions}","pages":1},
  {"id":"sources","label":"${L.sources}","pages":0}
]}`;

    const msgs = fileContext.length > 0
      ? [{ role: "user", content: [...fileContext, { type: "text", text: prompt }] }]
      : [{ role: "user", content: prompt }];
    const model = fileContext.length > 0 ? MODEL : MODEL_FAST;
    const raw = await callClaude(msgs, ctx.signal, "Respond only with valid JSON. No markdown.", 1200, null, model, { onCost: ctx.onCost });
    const parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || raw);
    let chapN = 0;
    newSections = (parsed.sections || []).map(s => {
      if (["intro", "conclusions", "sources"].includes(s.id)) return { ...s, text: "" };
      chapN++;
      return { ...s, id: `${chapN}`, text: "" };
    });
  }

  return { sections: newSections, stage: "plan", status: "plan_ready" };
}

/**
 * Генерує ОДИН розділ/підрозділ реферату. Джерела джереляться у citInputs[sec.id]
 * (заповнюється окремо через runSourcesStage з orderStages.js — той самий
 * механізм, що й для великих робіт, вже придатний для викликів order+ctx).
 * Перенесено з runSection (small-works.jsx) без зміни логіки.
 *
 * @param {object} order - { info, sections, citInputs, tezyCitations, materialText,
 *   methodRequirements, comment, deptGuidanceText, files, materialFiles }
 * @param {object} sec - підрозділ/розділ зі order.sections, який генеруємо
 * @param {object} ctx - { callClaude, onProgress? }
 * @returns {Promise<object>} патч {sections} — з оновленим text для sec.id
 */
export async function runReferatSection(order, sec, ctx) {
  const { callClaude, onProgress } = ctx;
  const info = order.info;
  const sections = order.sections || [];
  const citInputs = order.citInputs || {};
  const tezyCitations = order.tezyCitations || [];
  const materialText = order.materialText || "";
  const methodRequirements = order.methodRequirements || "";
  const comment = order.comment || "";
  const deptGuidanceText = order.deptGuidanceText || "";

  onProgress?.(`Генерую: ${sec.label}...`);
  const lang = info?.language || "Українська";
  const totalPages = parsePagesAvg(info?.pages);
  const chapCount = sections.filter(s => !["intro", "conclusions", "sources"].includes(s.id)).length;
  const pagesPerSec = sec.pages != null
    ? sec.pages
    : (sec.id === "intro" || sec.id === "conclusions"
        ? Math.max(1, Math.round(totalPages * 0.07))
        : Math.max(2, Math.round(totalPages * 0.8 / chapCount)));
  const approxParas = Math.max(3, Math.round(pagesPerSec * 3));

  const secCitations = (citInputs[sec.id] || "").split("\n").map(s => s.trim()).filter(Boolean);
  const hasSources = secCitations.length > 0;

  let citeMap;
  if (tezyCitations.length > 0 && secCitations.length > 0) {
    citeMap = {};
    secCitations.forEach(c => {
      const n = tezyCitations.indexOf(c) + 1;
      if (n > 0) citeMap[n] = `[${n}]`; // лише номер — сторінку ставить runSmallRemap
    });
  } else {
    citeMap = buildCiteMap(secCitations);
  }

  const firstCiteRef = tezyCitations.length > 0
    ? (citeMap[Object.keys(citeMap)[0]] || "[1]")
    : (citeMap[1] || "[1]");

  const sourcesBlock = hasSources
    ? tezyCitations.length > 0
      ? `\nДЖЕРЕЛА ДЛЯ РОБОТИ (${secCitations.length} шт.) — спирайся на них, вставляй посилання у тексті ТОЧНО у форматі вказаному перед кожним джерелом:\n${secCitations.map(c => {
          const n = tezyCitations.indexOf(c) + 1;
          return `${citeMap[n] || `[${n}]`} ${c}`;
        }).join("\n")}\n`
      : `\nДЖЕРЕЛА ДЛЯ РОБОТИ (${secCitations.length} шт.) — спирайся на них, вставляй посилання у тексті ТОЧНО у форматі вказаному перед кожним джерелом:\n${secCitations.map((s, i) => `${citeMap[i + 1]} ${s}`).join("\n")}\n`
    : "";
  const citNote = hasSources
    ? `Вставляй позначку джерела ЗАВЖДИ в самому кінці речення, перед крапкою — ніколи не одразу після дієслова на початку речення. НЕПРАВИЛЬНО: 'Зазначається ${firstCiteRef}, що явище поширене.' ПРАВИЛЬНО: 'Явище поширене ${firstCiteRef}.' Безособові конструкції: 'встановлено, що ...', 'зазначається, що ...' — без позначки одразу після цих слів, позначка йде в кінці всього речення. Формат позначки — точно як у таблиці вище. ЗАБОРОНЕНО об'єднувати джерела через кому — ставь кожне окремо. Кожне джерело цитуй НЕ БІЛЬШЕ 2 РАЗІВ у межах цього підрозділу.`
    : "Без посилань на джерела.";

  const materialContext = materialText.trim()
    ? `\nМАТЕРІАЛ ДЛЯ РОБОТИ (використай як основу для змісту):\n${materialText.trim()}\n`
    : "";
  const methodReqBlock = methodRequirements.trim()
    ? `\nВИМОГИ ДО РОБОТИ (ОБОВ'ЯЗКОВО дотримуватись):\n${methodRequirements}\n`
    : "";
  const matFileContext = order.materialFiles?.length > 0
    ? [{ type: "text", text: "Матеріал для роботи (файли):" }, ...await toClaudeFilesAsync(order.materialFiles)]
    : [];
  const refFileContext = await toClaudeFilesAsync(order.files);

  const chapNum = sec.id.includes(".") ? sec.id.split(".")[0] : (/^\d+$/.test(sec.id) ? sec.id : null);
  const commentBlock = comment.trim() ? `\nКОМЕНТАР ДО РОБОТИ: ${comment.trim()}\n` : "";
  const deptGuidanceBlock = deptGuidanceText.trim()
    ? `\nРЕКОМЕНДАЦІЇ КАФЕДРИ/ВИКЛАДАЧА (враховуй нарівні з методичкою): ${deptGuidanceText.trim()}\n`
    : "";
  const priorSectionsContext = sections.filter(s => s.id !== sec.id && s.id !== "sources" && s.text?.trim())
    .map(s => `=== ${s.label} ===\n${s.text.trim()}`).join("\n\n");
  const priorContextBlock = priorSectionsContext
    ? `ПОПЕРЕДНІ СЕКЦІЇ РЕФЕРАТУ (вже написані — контекст лише для стилю: не повторюй їх зміст і факти, орієнтуйся на них тільки щоб обрати ІНШИЙ стиль відкриття та завершення абзацу):\n${priorSectionsContext}\n\n`
    : "";

  let instruction = "";
  if (sec.id === "intro") {
    const hasMethodIntroReq = info?.introStructure || (info?.requirements && /вступ.*(?:актуальн|мет[аи]|об.єкт|предмет)/i.test(info.requirements));
    const introStructure = hasMethodIntroReq
      ? `Структура вступу відповідно до вимог: ${info.introStructure || info.requirements}`
      : `Структура вступу: звичайний вступ реферату суцільним текстом, БЕЗ структурних елементів — без міток "Актуальність теми:", "Об'єкт дослідження:", "Предмет дослідження:", "Мета роботи:", "Завдання дослідження:", без жирного, без нумерації. Розкрий послідовно актуальність теми, мету та основні завдання роботи як зв'язний текст, абзаци переходять один в інший природно, без формальних підзаголовків чи виділень.`;
    instruction = `${priorContextBlock}Напиши ВСТУП для реферату на тему "${info?.topic}".
${materialContext}${methodReqBlock}${commentBlock}${deptGuidanceBlock}${introStructure}
${!methodReqBlock && info?.requirements ? `\nДодаткові вимоги: ${info.requirements}` : ""}
Обсяг: ~${approxParas} абзаців (~${pagesPerSec} стор.). Без цитат на джерела. Починай одразу з тексту — не пиши слово "Вступ" на початку.`;
  } else if (sec.id === "conclusions") {
    instruction = `${priorContextBlock}Напиши ВИСНОВКИ для реферату на тему "${info?.topic}".
${materialContext}${methodReqBlock}${commentBlock}${deptGuidanceBlock}Підсумуй основні результати по кожному розділу. Конкретні висновки без загальних фраз.
${!methodReqBlock && info?.requirements ? `Вимоги: ${info.requirements}\n` : ""}Обсяг: ~${approxParas} абзаців (~${pagesPerSec} стор.). Без цитат. Без жирного. Без нумерації. Пиши суцільними абзацами.`;
  } else if (sec.sectionTitle) {
    const tableNumInstr = chapNum
      ? `Таблиці нумеруй: Таблиця ${chapNum}.Y – Назва (Y — порядковий номер у цьому розділі, починаючи з 1). Рисунки нумеруй: Рис. ${chapNum}.Y – Назва.`
      : "";
    instruction = `${priorContextBlock}Напиши підрозділ "${sec.label}" розділу "${sec.sectionTitle}" для реферату на тему "${info?.topic}". Галузь: ${info?.subject || ""}.
${materialContext}${methodReqBlock}${commentBlock}${deptGuidanceBlock}${sourcesBlock}${!methodReqBlock && info?.requirements ? `Вимоги до оформлення: ${info.requirements}\n` : ""}${tableNumInstr ? tableNumInstr + "\n" : ""}Обсяг: ~${approxParas} абзаців (~${pagesPerSec} стор.). ${citNote} Без жирного. Завершуй підсумковим реченням. Якщо у тексті є таблиця чи рисунок — одразу після неї йде окремий абзац-висновок з інтерпретацією даних; ЗАБОРОНЕНО закінчувати текст рядком таблиці, підписом рисунка чи фразою-посиланням на них без подальшого абзацу.
НЕ включай назву підрозділу у відповідь — починай одразу з тексту.`;
  } else {
    const tableNumInstr = chapNum
      ? `Таблиці нумеруй: Таблиця ${chapNum}.Y – Назва (Y — порядковий номер у цьому розділі, починаючи з 1). Рисунки нумеруй: Рис. ${chapNum}.Y – Назва.`
      : "";
    instruction = `${priorContextBlock}Напиши розділ "${sec.label}" для реферату на тему "${info?.topic}". Галузь: ${info?.subject || ""}.
${materialContext}${methodReqBlock}${commentBlock}${deptGuidanceBlock}${sourcesBlock}${!methodReqBlock && info?.requirements ? `Вимоги до оформлення: ${info.requirements}\n` : ""}${tableNumInstr ? tableNumInstr + "\n" : ""}Обсяг: ~${approxParas} абзаців (~${pagesPerSec} стор.). ${citNote} Без жирного. Завершуй підсумковим реченням. Якщо у тексті є таблиця чи рисунок — одразу після неї йде окремий абзац-висновок з інтерпретацією даних; ЗАБОРОНЕНО закінчувати текст рядком таблиці, підписом рисунка чи фразою-посиланням на них без подальшого абзацу.
НЕ включай заголовок розділу у відповідь — починай одразу з тексту.`;
  }

  const allFileContext = [...refFileContext, ...matFileContext];
  const msgs = allFileContext.length > 0
    ? [{ role: "user", content: [...allFileContext, { type: "text", text: instruction }] }]
    : [{ role: "user", content: instruction }];

  const secMaxTokens = Math.min(30000, Math.max(6000, Math.round(pagesPerSec * 3000)));
  const sysSmall = buildSYSSmall(lang, "referat");
  const raw = cleanDash(await callClaude(msgs, ctx.signal, sysSmall, secMaxTokens, null, undefined, { onCost: ctx.onCost }));
  let result = await enforceWordCount({
    text: raw, targetWords: Math.round(pagesPerSec * 230), label: sec.label,
    callClaude, sys: sysSmall, signal: ctx.signal, onProgress, clean: cleanDash,
    cacheOpts: { onCost: ctx.onCost },
  });
  try {
    result = await fixDanglingFigures({ text: result, lang, callClaude, signal: ctx.signal });
  } catch (e) { console.error("fixDanglingFigures:", e.message); }
  try {
    result = await fixMissingTableConclusion({ text: result, lang, callClaude, signal: ctx.signal });
  } catch (e) { console.error("fixMissingTableConclusion:", e.message); }

  if (secCitations.length) {
    const citedNums = new Set(extractCitedNumbers(result));
    const missing = secCitations
      .map(c => ({ number: tezyCitations.indexOf(c) + 1, sourceText: c }))
      .filter(s => s.number > 0 && !citedNums.has(s.number))
      .map(s => ({ ...s, marker: citeMap[s.number] || `[${s.number}]` }));
    if (missing.length) {
      onProgress?.(`Довставляю пропущені джерела: ${sec.label}...`);
      try {
        const { text } = await insertMissingCitations({ sectionText: result, insertions: missing, lang, callClaude, signal: ctx.signal });
        result = text;
      } catch (e) { console.error("insertMissingCitations (referat):", e.message); }
    }
    result = capCitationRepeats(result);
  } else if (sec.id === "intro" || sec.id === "conclusions") {
    result = result.replace(/\s?\[[^[\]]*\d[^[\]]*\]/g, "").replace(/[ \t]{2,}/g, " ").replace(/[ \t]+([.,;:!?])/g, "$1");
  }

  const nextSections = sections.map(s => s.id === sec.id ? { ...s, text: result } : s);
  return { sections: nextSections };
}

/**
 * Тези наукової доповіді — автоматичний пошук джерел (через runSourcesStage,
 * секція-заглушка "_main") + генерація тексту. Headless-заміна ручного
 * doSearchTezyPapers+doConfirmTezyPapers+doGenerateTezy (в браузері користувач
 * сам відбирає статті — тут відбір автоматичний, як і для розділів реферату).
 *
 * @param {object} order - { info, authorData, materialText, deptGuidanceText, comment,
 *   methodRequirements, files, materialFiles, tezyCitations?, citStructured? }
 *   files — методичка/вимоги конференції (роль: вимоги), deptGuidanceText — рекомендації
 *   кафедри (вимоги, пріоритет над методичкою), materialText/materialFiles — лише зміст.
 * @param {object} ctx - { callClaude, callGemini, onProgress? }
 * @returns {Promise<object>} патч {citStructured?, tezyCitations, result, stage:"done", status:"done"}
 */
export async function runTezy(order, ctx) {
  const { callClaude, onProgress } = ctx;
  const info = order.info || {};
  let citations = order.tezyCitations || [];
  let citStructuredPatch = order.citStructured;
  const sourcesMinRequired = getSmallWorkSourcesMin("tezy", parsePagesAvg(info.pages || "3"));

  if (!citations.length && info.needsSources !== false) {
    onProgress?.("Шукаю джерела...");
    const needed = info.sourceCount || sourcesMinRequired || 3;
    const topic = info.topic || "";
    const searchOrder = {
      info,
      sections: [{ id: "_main", label: topic }],
      sourceDist: { _main: needed },
      citInputs: {}, citStructured: {}, content: {},
      commentAnalysis: null, methodInfo: order.methodInfo,
    };
    const patch = await runSourcesStage(searchOrder, { id: "_main", label: topic }, { callGemini: ctx.callGemini, onCost: ctx.onCost });
    citations = (patch.citInputs?._main || "").split("\n").map(s => s.trim()).filter(Boolean);
    citStructuredPatch = { ...(order.citStructured || {}), _main: patch.citStructured?._main || [] };
  }

  // Жорсткий гейт, як у курсовій/дипломі (processOrder.js, waiting:"manual_sources"):
  // якщо навіть після каскаду не набрано мінімуму з таблиці — не пишемо текст,
  // а віддаємо статус "чекає ручного дороблення джерел" замість тихого продовження.
  if (info.needsSources !== false && sourcesMinRequired && citations.length < sourcesMinRequired) {
    return {
      tezyCitations: citations, citStructured: citStructuredPatch,
      stage: "sources", status: "manual_sources_needed", sourcesMinRequired,
    };
  }

  onProgress?.("Генерую тези...");
  const lang = info.language || "Українська";
  const totalPages = parsePagesAvg(info.pages || "3");

  const ad = order.authorData || {};
  // Заглушки й підписи блоку автора, УДК, список джерел і підпис рисунка — мовою роботи
  const L = getLangLabels(lang);
  const authorName = ad.authorName?.trim() || L.authorPlaceholder;
  const supervisor = ad.supervisor?.trim() || `[${L.supervisorLabel}]`;
  const university = ad.university?.trim() || L.universityPlaceholder;
  const faculty = ad.faculty?.trim() || "";
  const role = ad.role?.trim() || "";
  const email = (info.needsEmail && ad.email?.trim()) ? ad.email.trim() : null;

  const authorFormat = info.authorFormat || "center";
  const authorBlockLines = [
    authorName + (role ? `, ${role}` : ""),
    supervisor,
    university + (faculty ? `, ${faculty}` : ""),
    email,
  ].filter(Boolean).join("\n");

  const hasSources = citations.length > 0;
  const citeMap = buildCiteMap(citations);
  const sourcesContext = hasSources
    ? `\nДЖЕРЕЛА — при цитуванні вставляй у текст ЛИШЕ технічну позначку [N] (де N — номер джерела нижче), БЕЗ сторінки — сторінку система підставить сама з діапазону джерела. НІКОЛИ не пиши саму цитату (прізвище автора, рік, сторінку) в тексті в жодному вигляді — ні круглими дужками (Автор, рік), ні квадратними [Автор, рік, с. X]: остаточний стиль оформлення цитати підставить система вже після генерації, це не твоя турбота. Цитуй ЛИШЕ джерела зі списку нижче під їхніми номерами — категорично не згадуй і не посилайся на будь-яке інше дослідження, статтю чи автора, якого немає в цьому списку, яким би доречним воно не здавалося. Кожне джерело цитуй НЕ БІЛЬШЕ 2 РАЗІВ за весь текст роботи (рахуючи всі частини разом) — навіть якщо воно дуже доречне, для третього разу сформулюй без цитування або спирайся на інше джерело. ТОЧНО у форматі перед кожним джерелом:\n${citations.map((s, i) => `${citeMap[i + 1]} ${s}`).join("\n")}`
    : "";

  const structureInstr = info.bodyStructure === "structured"
    ? "Структура за замовчуванням: Преамбула (2-3 речення: актуальність і новизна) → Тези (5-7 речень: ключові ідеї, власна позиція) → Аргументація (4-6 речень: обґрунтування, посилання на джерела) → Демонстрація (4-6 речень: ілюстрація прикладами) → Результати (2-4 речення: висновки, теоретична/практична цінність; БЕЗ посилань на джерела). Якщо у методичці або рекомендаціях кафедри вказана інша структура тез — використай її замість цієї."
    : "Структура за замовчуванням: Актуальність (1-2 абзаци) → Мета та завдання (1 абзац) → Матеріали і методи (1 абзац) → Результати та обговорення (2-3 абзаци з посиланнями на джерела) → Висновки (пиши слово \"Висновки.\" жирним inline, потім текст; БЕЗ посилань на джерела). Якщо у методичці або рекомендаціях кафедри вказана інша структура тез — використай її замість цієї.";

  const sourcesList = hasSources
    ? `\n${sourcesHeading(lang)}:\n${citations.map((s, i) => `${i + 1}. ${s}`).join("\n")}`
    : "";
  const supervisorBlock = `${L.supervisorLabel}: ${supervisor}`;

  const materialContext = (order.materialText || "").trim()
    ? `\nМАТЕРІАЛ ДЛЯ РОБОТИ — змістова основа тез (факти, дані, позиції бери звідси; структуру й оформлення — ні):\n${order.materialText.trim()}\n`
    : "";
  const deptGuidanceBlock = (order.deptGuidanceText || "").trim()
    ? `\nРЕКОМЕНДАЦІЇ КАФЕДРИ/ВИКЛАДАЧА (ОБОВ'ЯЗКОВО враховуй нарівні з методичкою; якщо суперечать методичці — пріоритет за рекомендаціями кафедри):\n${order.deptGuidanceText.trim()}\n`
    : "";

  const figureInstr = (info.needsFigures && (info.figureCount || 0) > 0)
    ? `\nРИСУНКИ (${info.figureCount} шт.): Постав рисунки у текст там де доречно. Для кожного рисунку:
– у реченні зроби посилання: (${L.figWord.toLowerCase()} N)
– після абзацу з посиланням окремим рядком маркер пошуку: [🔍 Рисунок N: "конкретний пошуковий запит для Google Images"]
– наступний рядок — підпис: ${L.figWord} N — Назва рисунку`
    : "";

  const files = order.files || [];
  const materialFiles = order.materialFiles || [];
  const prompt = `Напиши тези наукової доповіді на тему "${info.topic}". Галузь: ${[info.subject, info.direction].filter(Boolean).join(", ")}.
${materialContext}${(order.comment || "").trim() ? `\nКОМЕНТАР ЗАМОВНИКА (виконай обов'язково): ${order.comment.trim()}\n` : ""}
НЕ додавай слово «ТЕЗИ» як окремий заголовок-рядок на початку документу.
БЛОК АВТОРА (${authorFormat === "right" ? "вирівняти по правому краю" : "вирівняти по центру"}):
${authorBlockLines}

${info.needsUDK ? `Перший рядок документу: ${L.udc} [відповідний код для теми]` : ""}
Назва доповіді: "${info.topic}" — ВЕЛИКИМИ ЛІТЕРАМИ, по центру.

${structureInstr}
${sourcesContext}
${figureInstr}

Обсяг: ~${totalPages} сторінки. Мова: ${lang}.
${(order.methodRequirements || "").trim() ? `ВИМОГИ ДО РОБОТИ (ОБОВ'ЯЗКОВО дотримуватись):\n${order.methodRequirements}` : (info.requirements ? `Вимоги конференції: ${info.requirements}` : "")}
${deptGuidanceBlock}${info.uniqueness ? `Унікальність: ${info.uniqueness}.` : ""}
Без посилань у форматі footnotes. Без markdown заголовків (#, ##). Без зайвих жирних виділень у тексті.
${sourcesList ? `\nПісля основного тексту додай блок (зберігай форматування *курсив* у джерелах без змін):\n${sourcesList}` : "\nСписок літератури НЕ потрібен — конференція не вимагає."}
\nПісля списку літератури (або після основного тексту) додай блок (${authorFormat === "right" ? "по правому краю" : "по центру"}, жирним):
${supervisorBlock}`;

  const fileContext = files.length > 0
    ? [{ type: "text", text: "МЕТОДИЧКА / ВИМОГИ КОНФЕРЕНЦІЇ (файли) — звідси бери структуру, обсяг і оформлення; зміст тез звідси не бери:" }, ...await toClaudeFilesAsync(files)]
    : [];
  const matFileContext = materialFiles.length > 0
    ? [{ type: "text", text: "МАТЕРІАЛ ДЛЯ РОБОТИ (файли) — змістова основа тез: факти, дані, позиції бери звідси; структуру й оформлення звідси не переймай:" }, ...await toClaudeFilesAsync(materialFiles)]
    : [];

  const msgs = [{ role: "user", content: [...fileContext, ...matFileContext, { type: "text", text: prompt }] }];
  const tezyMaxTokens = Math.min(30000, Math.max(6000, Math.round(totalPages * 3000)));
  const rawResult = cleanDash(await callClaude(msgs, ctx.signal, buildSYSSmall(lang, "tezy"), tezyMaxTokens, null, undefined, { onCost: ctx.onCost }));
  let text = rawResult;
  try {
    text = await fixDanglingFigures({ text: rawResult, lang, callClaude, signal: ctx.signal });
  } catch (e) { console.error("fixDanglingFigures:", e.message); }

  if (hasSources) {
    const citedNums = new Set(extractCitedNumbers(text));
    const missing = citations
      .map((c, i) => ({ number: i + 1, sourceText: c, marker: citeMap[i + 1] || `[${i + 1}]` }))
      .filter(s => !citedNums.has(s.number));
    if (missing.length) {
      onProgress?.("Довставляю пропущені джерела...");
      try {
        const { text: fixedText } = await insertMissingCitations({ sectionText: text, insertions: missing, lang, callClaude, signal: ctx.signal });
        text = fixedText;
      } catch (e) { console.error("insertMissingCitations (tezy):", e.message); }
    }
  }

  text = capCitationRepeats(text);

  if (info.bodyStructure !== "structured") {
    text = text.replace(/(Висновки\.[\s\S]*?)(?=\n\n|$)/i, m => m.replace(/\s?\[[^[\]]*\d[^[\]]*\]/g, ""));
  }

  return {
    ...(citStructuredPatch ? { citStructured: citStructuredPatch } : {}),
    tezyCitations: citations,
    result: text,
    stage: "done", status: "done",
  };
}

/**
 * Есе/стаття/доповідь-як-текст — генерація одним чи кількома чанками (~6 стор.
 * кожен), із джерелами (якщо вже підібрані в order.tezyCitations). Перенесено
 * з doGenerateSimple (small-works.jsx) без зміни логіки, включно з дефолтним
 * промптом для типів роботи поза {stattia, ese} (та сама поведінка, що й у браузері).
 *
 * @param {object} order - { workType, info, files, materialFiles, materialText,
 *   comment, methodRequirements, authorData, tezyCitations? }
 * @param {object} ctx - { callClaude, onProgress?, signal? }
 * @returns {Promise<object>} патч {result, tezyCitations, stage:"done", status:"done"}
 */
export async function runSimple(order, ctx) {
  const { callClaude, onProgress } = ctx;
  const workType = order.workType;
  const info = order.info || {};
  const lang = info.language || "Українська";
  const totalPages = parsePagesAvg(info.pages || "5");

  const fileContext = await toClaudeFilesAsync(order.files);
  const matFileContext = (order.materialFiles || []).length > 0
    ? [{ type: "text", text: "Матеріал для роботи (файли — проаналізуй і використай):" }, ...await toClaudeFilesAsync(order.materialFiles)]
    : [];

  const searchesSources = ["stattia", "ese"].includes(workType);
  const sourcesMinRequired = searchesSources ? getSmallWorkSourcesMin(workType, totalPages) : null;
  let activeCitations = order.tezyCitations || [];
  let citStructuredPatch = order.citStructured;
  if (searchesSources && !activeCitations.length) {
    onProgress?.("Шукаю джерела...");
    const needed = info.sourceCount || sourcesMinRequired || (workType === "stattia" ? 5 : 3);
    const topic = info.topic || "";
    const searchOrder = {
      info,
      sections: [{ id: "_main", label: topic }],
      sourceDist: { _main: needed },
      citInputs: {}, citStructured: {}, content: {},
      commentAnalysis: null, methodInfo: order.methodInfo,
    };
    const patch = await runSourcesStage(searchOrder, { id: "_main", label: topic }, { callGemini: ctx.callGemini, onCost: ctx.onCost });
    activeCitations = (patch.citInputs?._main || "").split("\n").map(s => s.trim()).filter(Boolean);
    citStructuredPatch = { ...(order.citStructured || {}), _main: patch.citStructured?._main || [] };
  }

  // Жорсткий гейт, як у курсовій/дипломі (processOrder.js, waiting:"manual_sources"):
  // якщо навіть після каскаду не набрано мінімуму з таблиці — не пишемо текст.
  if (sourcesMinRequired && activeCitations.length < sourcesMinRequired) {
    return {
      tezyCitations: activeCitations, citStructured: citStructuredPatch,
      stage: "sources", status: "manual_sources_needed", sourcesMinRequired,
    };
  }

  const hasSources = activeCitations.length > 0;
  const citeMap = buildCiteMap(activeCitations);
  const sourcesContext = hasSources
    ? `\nДЖЕРЕЛА — при цитуванні вставляй у текст ЛИШЕ технічну позначку [N] (де N — номер джерела нижче), БЕЗ сторінки — сторінку система підставить сама з діапазону джерела. НІКОЛИ не пиши саму цитату (прізвище автора, рік, сторінку) в тексті в жодному вигляді — ні круглими дужками (Автор, рік), ні квадратними [Автор, рік, с. X]: остаточний стиль оформлення цитати підставить система вже після генерації, це не твоя турбота. Цитуй ЛИШЕ джерела зі списку нижче під їхніми номерами — категорично не згадуй і не посилайся на будь-яке інше дослідження, статтю чи автора, якого немає в цьому списку, яким би доречним воно не здавалося. Кожне джерело цитуй НЕ БІЛЬШЕ 2 РАЗІВ за весь текст роботи (рахуючи всі частини разом) — навіть якщо воно дуже доречне, для третього разу сформулюй без цитування або спирайся на інше джерело. ТОЧНО у форматі перед кожним джерелом:\n${activeCitations.map((s, i) => `${citeMap[i + 1]} ${s}`).join("\n")}`
    : "";
  const sourcesList = hasSources
    ? `\n${sourcesHeading(lang)}:\n${activeCitations.map((s, i) => `${i + 1}. ${s}`).join("\n")}`
    : "";

  const materialContext = (order.materialText || "").trim()
    ? `\nМАТЕРІАЛ ДЛЯ РОБОТИ (проаналізуй і використай як основу):\n${order.materialText.trim()}\n`
    : "";

  // Підпис рисунка мовою роботи — той самий figWord, за яким експорт шукає підписи
  const figWordW = getLangLabels(lang).figWord;
  const figureInstr = (info.needsFigures && (info.figureCount || 0) > 0)
    ? `\nРИСУНКИ (${info.figureCount} шт.): Постав рисунки у текст там де доречно. Для кожного рисунку:
– у реченні зроби посилання: (${figWordW.toLowerCase()} N)
– після абзацу з посиланням окремим рядком маркер пошуку: [🔍 Рисунок N: "конкретний пошуковий запит для Google Images"]
– наступний рядок — підпис: ${figWordW} N — Назва рисунку`
    : "";

  const isEnglishLang = /англ|english/i.test(lang);
  const typePrompts = {
    stattia: isEnglishLang
      ? `Write an ACADEMIC ARTICLE. Do NOT write a title line or author block — those are added separately by the system; start directly with the UDC line (if applicable) and the abstract. Do NOT write the word "ARTICLE" as a heading label anywhere in the document.
Field: ${[info.subject, info.direction].filter(Boolean).join(", ")}.
Default structure: Introduction (relevance, aim), Materials and Methods, Results and Discussion, Conclusions. If the requirements or provided materials below specify a different structure — use that instead. The Conclusions part — NO source references/citations there.
Length: ~${totalPages} pages. Academic style. No bold.`
      : `Напиши НАУКОВУ СТАТТЮ. НЕ пиши назву статті і блок автора — вони додаються окремо системою; починай одразу з рядка УДК (якщо потрібен) і анотації. НЕ додавай слово «СТАТТЯ» як окремий заголовок-рядок ніде в документі.
Галузь: ${[info.subject, info.direction].filter(Boolean).join(", ")}.
Структура за замовчуванням: Вступ (актуальність, мета), Матеріали і методи, Результати та обговорення, Висновки. Якщо у вимогах або наданих матеріалах нижче вказана інша структура — використай її замість цієї. Частина "Висновки" — БЕЗ посилань на джерела.
Обсяг: ~${totalPages} сторінок. Академічний стиль. Без жирного.`,
    ese: isEnglishLang
      ? `Write an ESSAY. Do NOT write the word "ESSAY" as a heading label — start directly with the title.
Title: "${info.topic}".
Default structure: thesis, arguments with examples (3-4 paragraphs), counter-argument, conclusion. If the requirements or provided materials below specify a different structure — use that instead. The conclusion — NO source references/citations there.
Length: ~${totalPages} pages. Clear, plain argumentative style (not a polished journal-article tone). No bold. No tables, figures or diagrams unless the requirements below explicitly ask for them. Paragraphs of clearly different length.${order.essayExampleText?.trim() ? `\n\nSAMPLE ESSAY — match its writing style (tone, sentence length, register), its way of building an argument, and its formatting conventions (paragraphing, use of quotes/emphasis, heading style if any). Do NOT copy its content, examples or wording — write entirely new content on the topic above:\n${order.essayExampleText.trim().slice(0, 4000)}` : ""}`
      : `Напиши ЕСЕ. НЕ додавай слово «ЕСЕ» як окремий заголовок-рядок — починай одразу з назви.
Назва: "${info.topic}".
Структура за замовчуванням: теза, аргументи з прикладами (3-4 абзаци), контраргумент, висновок. Якщо у вимогах або наданих матеріалах нижче вказана інша структура — використай її замість цієї. Висновок — БЕЗ посилань на джерела.
Обсяг: ~${totalPages} сторінок. Зрозумілий, простий аргументативний стиль (не «журнально-статейний» тон). Без жирного. Без таблиць, рисунків і діаграм, якщо у вимогах нижче їх прямо не просять. Абзаци помітно різної довжини.${order.essayExampleText?.trim() ? `\n\nЗРАЗОК ЕСЕ — орієнтуйся на його стиль викладу (тон, довжина речень, регістр), спосіб побудови аргументації та оформлення (абзаци, виділення, заголовки якщо є). НЕ копіюй його зміст, приклади чи формулювання — пиши повністю новий текст на тему вище:\n${order.essayExampleText.trim().slice(0, 4000)}` : ""}`,
  };

  // Універсальний варіант для дрібних робіт без окремого типу (ІНДЗ, самостійна, контрольна,
  // домашнє завдання тощо — у CRM-адаптері це workType "inshe"). Замість голого «Напиши роботу
  // на тему…» модель спершу визначає жанр із теми й вимог і пише саме в ньому.
  typePrompts.inshe = isEnglishLang
    ? `Write a student assignment on the topic "${info.topic}"${info.type ? ` (type: ${info.type})` : ""}.
First decide from the topic, the assignment type and the requirements below what exactly is needed (a reflective text, an explanation, answers to the listed questions, a short analysis, a description or comparison) — and write exactly that genre.
- If the requirements list questions or task items — answer each of them in order, with short subheadings.
- A reflective text is written in the first person, with the student's own position and concrete examples from student life.
- Do NOT invent statistics, surveys, studies or documents that are not in the provided materials. If the requirements refer to a document that is not provided, rely on its generally known provisions without quoting it.
Length: ~${totalPages} pages. No bold, no markdown.`
    : `Напиши студентську роботу на тему "${info.topic}"${info.type ? ` (вид: ${info.type})` : ""}.
Спершу визнач із теми, виду роботи та вимог нижче, що саме потрібно: текст-роздум, пояснення, відповіді на поставлені питання, короткий аналіз, опис чи порівняння — і пиши саме в цьому жанрі.
- Якщо у вимогах є питання чи пункти завдання — відповідай на кожен по порядку, з короткими підзаголовками.
- Текст-роздум пиши від першої особи, з власною позицією і конкретними прикладами зі студентського життя.
- НЕ вигадуй статистику, опитування, дослідження чи документи, яких немає в наданих матеріалах. Якщо вимоги посилаються на документ, якого немає в матеріалах, спирайся на його загальновідомі положення без цитат.
Обсяг: ~${totalPages} стор. Без жирного, без маркдауну.`;

  let articleFrontMatter = "";
  let authorBlockLines = "";
  const authorFormat = info.authorFormat || "center";
  if (workType === "stattia") {
    const ad = order.authorData || {};
    // Заглушки авторського блоку й підписи УДК/анотації/ключових слів — мовою роботи
    // (раніше для всіх неанглійських мов — українською).
    const L = getLangLabels(lang);
    const authorName = ad.authorName?.trim() || L.authorPlaceholder;
    const supervisor = ad.supervisor?.trim() || "";
    const university = ad.university?.trim() || L.universityPlaceholder;
    const faculty = ad.faculty?.trim() || "";
    const role = ad.role?.trim() || "";
    const email = (info.needsEmail && ad.email?.trim()) ? ad.email.trim() : null;
    authorBlockLines = [
      authorName + (role ? `, ${role}` : ""),
      supervisor,
      university + (faculty ? `, ${faculty}` : ""),
      email,
    ].filter(Boolean).join("\n");

    articleFrontMatter = isEnglishLang
      ? `\n${info.needsUDK !== false ? "First line of the document: UDC [appropriate code for the topic]\n" : ""}Then — ABSTRACT: start the line with "Abstract." and immediately on the same line write 50-80 words (aim, methods, results). Next line: "Keywords:" followed by 5-7 keywords separated by commas.`
      : `\n${info.needsUDK !== false ? `Перший рядок документу: ${L.udc} [відповідний код для теми]\n` : ""}Далі — АНОТАЦІЯ: почни рядок зі слова "${L.abstractWord}." і одразу на тому ж рядку 50-80 слів анотації (мета, методи, результати). Наступний рядок: "${L.keywordsWord}:" і одразу 5-7 ключових слів через кому.`;
  }

  const commonTailBlock = `${materialContext}
${(order.comment || "").trim() ? `\nКОМЕНТАР ЗАМОВНИКА (виконай обов'язково): ${order.comment.trim()}\n` : ""}${(order.methodRequirements || "").trim() ? `\nВИМОГИ ДО РОБОТИ (ОБОВ'ЯЗКОВО дотримуватись):\n${order.methodRequirements}` : (info.requirements ? `\nВИМОГИ: ${info.requirements}` : "")}
${info.uniqueness ? `Унікальність: ${info.uniqueness}.` : ""}
Мова: ${lang}.
${sourcesContext}`;

  const CHUNK_PAGES = 6;
  const numChunks = Math.max(1, Math.ceil(totalPages / CHUNK_PAGES));
  const basePages = Math.floor(totalPages / numChunks);
  const extraPages = totalPages % numChunks;
  const chunkPages = Array.from({ length: numChunks }, (_, i) => basePages + (i < extraPages ? 1 : 0));

  let fullText = "";
  for (let i = 0; i < numChunks; i++) {
    const isFirst = i === 0;
    const isLast = i === numChunks - 1;
    const pagesForChunk = chunkPages[i];
    onProgress?.(numChunks > 1 ? `Генерую частину ${i + 1}/${numChunks}...` : "Генерую...");

    let usedNote = "";
    if (!isFirst && hasSources) {
      const counts = {};
      extractCitedNumbers(fullText).forEach(n => { counts[n] = (counts[n] || 0) + 1; });
      const unused = activeCitations.map((_, idx) => idx + 1).filter(n => !counts[n]);
      const atLimit = Object.keys(counts).map(Number).filter(n => counts[n] >= 2);
      usedNote = `\nЦИТУВАННЯ ДОСІ: ${Object.keys(counts).length ? Object.entries(counts).map(([n, c]) => `[${n}]×${c}`).join(", ") : "жодного"}.`
        + (unused.length ? ` Ще ЖОДНОГО РАЗУ не процитовані: ${unused.map(n => `[${n}]`).join(", ")} — за можливості віддай їм пріоритет.` : "")
        + (atLimit.length ? ` ДОСЯГЛИ ЛІМІТУ 2 разів — БІЛЬШЕ НЕ цитуй: ${atLimit.map(n => `[${n}]`).join(", ")}.` : "");
    }

    let sectionPrompt;
    if (isFirst) {
      sectionPrompt = `${typePrompts[workType] || `Напиши роботу на тему "${info.topic}".`}
${articleFrontMatter}${commonTailBlock}${figureInstr}${usedNote}
${numChunks > 1 && !isLast ? `\nЦе ПЕРША частина роботи загальним обсягом ~${totalPages} стор. Напиши перші ~${pagesForChunk} стор. НЕ пиши висновків і не завершуй роботу — це буде в наступних частинах.` : ""}`;
    } else {
      sectionPrompt = `Ось уже написана частина роботи на тему "${info.topic}" (це продовження, частина ${i + 1} з ${numChunks}):
${fullText}

Продовж органічно від того місця, де текст вище закінчується, ще на ~${pagesForChunk} стор. КАТЕГОРИЧНО НЕ повторюй тези, приклади, формулювання чи посилання на джерела [N], які вже є в тексті вище — рухайся далі за змістом, розкривай нові аспекти, а не переказуй заново вже сказане. КАТЕГОРИЧНО НЕ повторюй жоден рисунок/таблицю/діаграму (і їхній підпис "Рис. N"), що вже наведені в тексті вище, навіть іншими словами чи в іншому форматуванні — кожен номер рисунка може з'явитися в роботі лише один раз.
${commonTailBlock}${usedNote}
${isLast ? "Це ОСТАННЯ частина — заверши роботу логічними висновками." : "Це НЕ остання частина — висновків поки не пиши, вони будуть далі."}`;
    }

    const msgs = [{ role: "user", content: [...matFileContext, ...fileContext, { type: "text", text: sectionPrompt }] }];
    const chunkMaxTokens = Math.min(20000, Math.max(4000, Math.round(pagesForChunk * 3000)));
    const smallWorkType = workType === "ese" ? "ese" : workType === "stattia" ? "stattia" : null;
    const rawChunk = cleanDash(await callClaude(msgs, ctx.signal, buildSYSSmall(lang, smallWorkType), chunkMaxTokens, null, undefined, { onCost: ctx.onCost }));
    const chunkText = await enforceWordCount({
      text: rawChunk, targetWords: Math.round(pagesForChunk * 230),
      label: `${info.topic || ""}${numChunks > 1 ? ` — частина ${i + 1}/${numChunks}` : ""}`,
      callClaude, sys: buildSYSSmall(lang, smallWorkType), signal: ctx.signal, onProgress, clean: cleanDash,
      cacheOpts: { onCost: ctx.onCost },
    });
    fullText = fullText ? `${fullText}\n\n${chunkText.trim()}` : chunkText.trim();
  }

  fullText = dedupeRepeatedFigures(fullText, lang);

  try {
    fullText = await fixDanglingFigures({ text: fullText, lang, callClaude, signal: ctx.signal });
  } catch (e) { console.error("fixDanglingFigures:", e.message); }

  if (hasSources) {
    const citedNums = new Set(extractCitedNumbers(fullText));
    const missing = activeCitations
      .map((c, i) => ({ number: i + 1, sourceText: c, marker: citeMap[i + 1] || `[${i + 1}]` }))
      .filter(s => !citedNums.has(s.number));
    if (missing.length) {
      onProgress?.("Довставляю пропущені джерела...");
      try {
        const { text: fixedText } = await insertMissingCitations({ sectionText: fullText, insertions: missing, lang, callClaude, signal: ctx.signal });
        fullText = fixedText;
      } catch (e) { console.error("insertMissingCitations (essay):", e.message); }
    }
  }

  fullText = capCitationRepeats(fullText);

  if (workType === "stattia") {
    let udkLine = "";
    const udkMatch = fullText.match(/^((?:УДК|UDC)\s[^\n]*)\n+/i);
    if (udkMatch) {
      udkLine = udkMatch[1];
      fullText = fullText.slice(udkMatch[0].length);
    }
    const titleText = (info.topic || "").toUpperCase();
    const frontMatter = [
      udkLine,
      `\x00TITLE\x00\n${titleText}\n\x00/TITLE\x00`,
      authorBlockLines ? `\x00AUTHORBLOCK:${authorFormat}\x00\n${authorBlockLines}\n\x00/AUTHORBLOCK\x00` : "",
    ].filter(Boolean).join("\n\n");
    fullText = `${frontMatter}\n\n${fullText}`;
  }

  const finalText = `${fullText}${sourcesList ? `\n\n${sourcesList}` : ""}`;
  return {
    ...(citStructuredPatch ? { citStructured: citStructuredPatch } : {}),
    result: finalText, tezyCitations: activeCitations, stage: "done", status: "done",
  };
}

/**
 * Презентація з нуля (один виклик Claude → JSON слайдів). Перенесено з
 * doGeneratePresentation (small-works.jsx) без зміни логіки.
 *
 * @param {object} order - { info, files, materialFiles, instrFiles, materialText,
 *   comment, methodRequirements, tezyCitations? }
 * @param {object} ctx - { callClaude, onProgress? }
 * @returns {Promise<object>} патч {slides, tezyCitations, stage:"done", status:"done"}
 */
export async function runSmallPresentation(order, ctx) {
  const { callClaude, onProgress } = ctx;
  const info = order.info || {};
  const lang = info.language || "Українська";
  const totalSlides = Math.max(8, Math.min(20, parsePagesAvg(info.pages || "15")));
  const activeCitations = order.tezyCitations || [];
  const hasSources = activeCitations.length > 0;
  const citStyle = info.citStyle || "ДСТУ 8302:2015";

  const fileContext = await toClaudeFilesAsync(order.files);
  const matFileContext = (order.materialFiles || []).length > 0
    ? [{ type: "text", text: "Матеріал для презентації (проаналізуй і використай для наповнення слайдів):" }, ...await toClaudeFilesAsync(order.materialFiles)]
    : [];
  const instrFileContext = (order.instrFiles || []).length > 0
    ? [{ type: "text", text: "Інструкції з оформлення (уважно прочитай і виконай при побудові слайдів — структура, вимоги, приклади):" }, ...await toClaudeFilesAsync(order.instrFiles)]
    : [];
  const materialContext = (order.materialText || "").trim()
    ? `\nМАТЕРІАЛ (використай як основу змісту):\n${order.materialText.trim()}\n`
    : "";
  const reqBlock = (order.methodRequirements || "").trim()
    ? `\nВИМОГИ (дотримуватись):\n${order.methodRequirements}\n`
    : (info.requirements ? `\nВимоги: ${info.requirements}\n` : "");
  const commentBlock = (order.comment || "").trim() ? `\nКОМЕНТАР ЗАМОВНИКА (виконай обов'язково): ${order.comment.trim()}\n` : "";
  const sourcesBlock = hasSources
    ? `\nДЖЕРЕЛА (спирайся на факти й дані з них при наповненні слайдів; список джерел додається окремим слайдом автоматично — НЕ вставляй жодних позначок на кшталт [1] чи посилань у тексті слайдів):\n${activeCitations.map((c, i) => `${i + 1}. ${c}`).join("\n")}\n`
    : "";

  onProgress?.("Аналізую матеріали та генерую презентацію...");
  const prompt = `Створи презентацію на тему "${info.topic}". Галузь: ${info.subject || ""}. Мова: ${lang}.
${reqBlock}${materialContext}${commentBlock}${sourcesBlock}
Поверни ТІЛЬКИ JSON без markdown — рівно ${totalSlides} слайдів:
{"slides":[...]}

СТРУКТУРА:
- Слайд 1: layout "hero", title = назва теми, subtitle = коротка підназва
- Слайди 2–${totalSlides - 1}: змістові слайди з конкретними фактами, цифрами, прикладами з матеріалів
- Слайд ${totalSlides}: layout "hero", title "Дякую за увагу!", subtitle ""

ТИПИ LAYOUT:
- "hero" — тільки 1-й, останній, великі розділювачі
- "icon_list" — перелік 3–5 рівнозначних пунктів. Поле: visual.items [{icon,header,text}]
- "numbered_steps" — послідовний процес, кроки (3–4 елементи). Поле: visual.items [{num,title,text}]
- "two_column" — порівняння або два аспекти. Поля: left, right (або right_type:"stat", right_value, right_label)
- "stat_callout" — конкретні числа/відсотки. Поле: visual.stats [{value,label}], content (текст нижче)
- "highlight_box" — основний текст (default). Поле: content (рядки через \\n), accent (виділений підсумок)
- "table" — таблиця з даними. Поле: visual.headers ["Кол1","Кол2"], visual.rows [["а","б"],["в","г"]]
- "chart" — графік. Поле: visual.type ("bar"|"line"|"pie"|"doughnut"), visual.series [{name,labels:[...],values:[...]}]
- "image_placeholder" — весь слайд займає виділений жовтий блок із підписом де має бути зображення. Поле: image "Назва/опис зображення"
- "two_column" з right_type:"image" — ліво текст, право виділений блок-заглушка. Поле: right "Назва зображення"

ШРИФТ: якщо інструкції вказують конкретний шрифт — додай поле "font":"Назва шрифту" в корінь JSON (поруч з "slides"). Стандартні системні шрифти: Arial, Calibri, Times New Roman, Georgia, Verdana.

ПРАВИЛА:
- Кожен слайд — 1 чітка ідея
- Конкретні дані з матеріалів, не загальні фрази
- Заголовки слайдів — 3–6 слів
- Текст у content — стислі тези, до 7 слів на рядок
- stat_callout тільки якщо є реальні числа з матеріалів
- table — коли потрібно порівняти кілька об'єктів по кількох параметрах
- chart — коли є числові дані для відображення динаміки або розподілу
- image_placeholder або two_column з right_type:"image" — коли за змістом має бути фото, схема, графік, діаграма, малюнок
НЕ додавай слайд джерел.
НЕ вставляй у текст слайдів жодних позначок чи посилань на джерела (ні [1], ні (Автор, рік)) — лише факти та дані.
КАТЕГОРИЧНО ЗАБОРОНЕНО додавати будь-яке застереження/дисклеймер про використання штучного інтелекту, ШІ, AI чи подібних інструментів для підготовки презентації — ні окремим слайдом, ні рядком у контенті, ні в приміткax, навіть якщо це здається доречним.`;

  const msgs = [{ role: "user", content: [...fileContext, ...matFileContext, ...instrFileContext, { type: "text", text: prompt }] }];
  const raw = await callClaude(msgs, ctx.signal, `Ти експерт із презентацій. Відповідай ТІЛЬКИ валідним JSON без markdown. Мова контенту: ${lang}.`, 6000, null, MODEL, { onCost: ctx.onCost });
  const parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || raw);
  let newSlides = parsed.slides || [];

  if (hasSources) {
    newSlides = [...newSlides, {
      layout: "highlight_box",
      title: `${sourcesHeading(lang)} (${citStyle})`,
      content: activeCitations.map((c, i) => `${i + 1}. ${c}`).join("\n"),
    }];
  }

  return { slides: newSlides, tezyCitations: activeCitations, stage: "done", status: "done" };
}

/**
 * Форматування списку джерел за стилем + перестановка [N] у тексті — спільний
 * фінальний крок для всіх типів малих робіт (referat/prezentatsiya/інші).
 * Перенесено з doFormatAndRemapCitations (small-works.jsx) без зміни логіки.
 * Без цього кроку headless-результат відрізняється від того, що дає кнопка в UI.
 *
 * @param {object} order - { workType, tezyCitations, citStructured, methodInfo,
 *   citStyleOverride?, sourcesOrderOverride?, citFootnotes?, info, sections?,
 *   citInputs?, slides?, result?, annotationUk? }
 * @param {object} ctx - { callClaude, onProgress? }
 * @returns {Promise<object>} патч — форма залежить від workType (див. нижче)
 */
export async function runSmallRemap(order, ctx) {
  const { callClaude, onProgress } = ctx;
  const tezyCitations = order.tezyCitations || [];
  if (!tezyCitations.length) return {};
  onProgress?.("Форматую та розставляю джерела...");

  const workType = order.workType;
  const info = order.info || {};
  const methodInfo = order.methodInfo;
  const citStructured = order.citStructured || {};
  const allStructured = Object.values(citStructured).flat();
  const effectiveOrder = order.sourcesOrderOverride || methodInfo?.sourcesOrder;
  const style = order.citStyleOverride || methodInfo?.sourcesStyle || info.citStyle || "ДСТУ 8302:2015";
  const isFootnoteMode = order.citFootnotes && /ДСТУ/i.test(style) && workType !== "prezentatsiya";
  const isAPA = /APA/i.test(style);
  const isMLA = /MLA/i.test(style);

  const { refList, oldToNew, refCiteText, pageRanges, pageAbbrev, pdfUrls } = await remapAndFormatCitations({
    citations: tezyCitations,
    citStructured: allStructured,
    citStyle: style,
    language: info.language,
    sourcesOrder: effectiveOrder,
    sourcesGrouping: methodInfo?.sourcesGrouping,
    sourcesFormatRules: methodInfo?.sourcesFormatRules,
    citFootnotes: isFootnoteMode,
    citationStyle: methodInfo?.citationStyle,
    callClaude,
  });
  if (!refList.length) return {};
  const refBlock = refList.map((c, i) => `${i + 1}. ${c}`).join("\n");

  // "Сторінка за змістом" (перемикач): сторінка посилання — за збігом речення з PDF джерела
  const remapTexts = {};
  if (workType === "referat") (order.sections || []).forEach(s => { if (s.id !== "sources") remapTexts[s.id] = s.text || ""; });
  else if (workType === "prezentatsiya") (order.slides || []).forEach((sl, i) => { remapTexts[`slide${i}`] = sl.content || ""; });
  else remapTexts._body = order.result || "";
  let contentPickers = {};
  if (order.pageByContent && !isFootnoteMode && Object.keys(pdfUrls || {}).length) {
    try {
      contentPickers = await buildContentPagePickers({ texts: remapTexts, mappingFor: () => oldToNew, pdfUrls, pageRanges });
    } catch (err) { console.error("Сторінка за змістом:", err.message); }
  }
  const remapText = (text, key) => applyCitationRemap(text, oldToNew, refCiteText, { pageRanges, pageAbbrev, pagePicker: contentPickers[key] });

  if (workType === "referat") {
    const sections = order.sections || [];
    const citInputs = order.citInputs || {};
    const remappedSections = sections.map(s => s.id === "sources"
      ? { ...s, text: refBlock }
      : { ...s, text: remapText(s.text, s.id) });

    const totalTargetWords = remappedSections
      .filter(s => !["intro", "conclusions", "sources"].includes(s.id))
      .reduce((sum, s) => sum + Number(s.pages || 0) * 230, 0);
    const contentMap = Object.fromEntries(remappedSections.map(s => [s.id, s.text]));
    const adjustedVolume = await enforceTotalVolume({
      sections: remappedSections, content: contentMap, targetWords: totalTargetWords,
      isEligible: (s) => !["intro", "conclusions", "sources"].includes(s.id),
      callClaude, sys: buildSYSSmall(info.language || "Українська"),
      onProgress, clean: cleanDash, lang: info.language,
      cacheOpts: { onCost: ctx.onCost },
    });
    const updatedSections = remappedSections.map(s =>
      adjustedVolume[s.id] !== undefined ? { ...s, text: adjustedVolume[s.id] } : s);

    let finalSections = updatedSections;
    let finalRefList = refList;
    let finalOldToNew = oldToNew;
    const citedGlobally = new Set();
    updatedSections.filter(s => s.id !== "sources").forEach(s => {
      extractCitedNumbers(s.text).forEach(n => citedGlobally.add(n));
    });
    const uncitedNums = refList.map((_, i) => i + 1).filter(n => !citedGlobally.has(n));
    if (uncitedNums.length) {
      onProgress?.("Перевіряю покриття джерел цитатами...");
      finalSections = [...updatedSections];
      const firstMainId = finalSections.find(s => !["intro", "conclusions", "sources"].includes(s.id))?.id;
      const unresolvedNums = [];
      for (const num of uncitedNums) {
        const oldNum = Number(Object.keys(oldToNew).find(k => oldToNew[k] === num));
        const assignedId = oldNum && sections.find(s => s.id !== "sources"
          && (citInputs[s.id] || "").split("\n").map(x => x.trim()).filter(Boolean)
            .some(c => tezyCitations.indexOf(c) + 1 === oldNum))?.id;
        const secIdx = finalSections.findIndex(s => s.id === (assignedId || firstMainId));
        if (secIdx < 0) { unresolvedNums.push(num); continue; }
        try {
          const { text, unresolved } = await insertMissingCitations({
            sectionText: finalSections[secIdx].text,
            insertions: [{ number: num, sourceText: refList[num - 1], marker: citationMarkerWithPage(num, refCiteText, pageRanges, pageAbbrev) }],
            lang: info.language,
            callClaude,
          });
          finalSections[secIdx] = { ...finalSections[secIdx], text: capCitationRepeats(text) };
          if (unresolved.length) unresolvedNums.push(num);
        } catch (e) {
          console.error("insertMissingCitations (referat, global coverage):", e.message);
          unresolvedNums.push(num);
        }
      }

      if (unresolvedNums.length) {
        const removed = new Set(unresolvedNums);
        const prunedToNew = {};
        let nextN = 1;
        refList.forEach((_, i) => {
          const n = i + 1;
          if (!removed.has(n)) prunedToNew[n] = nextN++;
        });
        if (!isAPA && !isMLA) {
          const prunedRefCiteText = {};
          const prunedPageRanges = {};
          Object.entries(prunedToNew).forEach(([oldNStr, newN]) => {
            const oldN = Number(oldNStr);
            prunedRefCiteText[newN] = isFootnoteMode ? `%%FN${newN}%%` : `[${newN}]`;
            if (pageRanges[oldN]) prunedPageRanges[newN] = pageRanges[oldN];
          });
          finalSections = finalSections.map(s => s.id === "sources" ? s
            : { ...s, text: applyCitationRemap(s.text, prunedToNew, prunedRefCiteText, { pageRanges: prunedPageRanges, pageAbbrev }) });
        }
        finalRefList = refList.filter((_, i) => !removed.has(i + 1));
        finalOldToNew = Object.fromEntries(
          Object.entries(oldToNew).map(([oldN, midN]) => [oldN, prunedToNew[midN]]).filter(([, v]) => v !== undefined)
        );
        const prunedRefBlock = finalRefList.map((c, i) => `${i + 1}. ${c}`).join("\n");
        finalSections = finalSections.map(s => s.id === "sources" ? { ...s, text: prunedRefBlock } : s);
      }
    }

    let newAnnotationUk = order.annotationUk;
    if (methodInfo?.needsAnnotation) {
      onProgress?.("Генерую анотацію...");
      try {
        const introSec = finalSections.find(s => s.id === "intro");
        const mainSecCount = new Set(finalSections
          .filter(s => !["intro", "conclusions", "sources"].includes(s.id))
          .map(s => s.id.includes(".") ? s.id.split(".")[0] : s.id)).size;
        const statsText = [
          `Дисципліна: ${info.subject || ""}`,
          `Кількість розділів: ${mainSecCount}`,
          `Кількість використаних джерел: ${finalRefList.length}`,
          info.pages ? `Орієнтовний обсяг роботи: ${info.pages} сторінок` : "",
        ].filter(Boolean).join("\n");
        const annPrompt = buildReferatAnnotationPrompt(info, methodInfo, statsText, introSec?.text || "");
        const annRaw = await callClaude([{ role: "user", content: annPrompt }], ctx.signal, SYS_JSON_SHORT, 1500, null, undefined, { onCost: ctx.onCost });
        const annMatch = annRaw.match(/\{[\s\S]*\}/);
        const annParsed = JSON.parse(annMatch?.[0] || annRaw.replace(/```json|```/g, "").trim());
        newAnnotationUk = annParsed.uk || "";
      } catch (e) { console.error("genReferatAnnotation:", e.message); }
    }

    const newCitInputs = {};
    sections.filter(s => s.id !== "sources").forEach(s => {
      const secRaw = (citInputs[s.id] || "").split("\n").map(l => l.trim()).filter(Boolean);
      const secFormatted = secRaw
        .map(r => {
          const newIdx = finalOldToNew[tezyCitations.indexOf(r) + 1];
          return newIdx ? (finalRefList[newIdx - 1] || null) : null;
        })
        .filter(Boolean);
      if (secFormatted.length) newCitInputs[s.id] = secFormatted.join("\n");
    });

    return {
      tezyCitations: finalRefList, citInputs: newCitInputs, sections: finalSections,
      sourcesFormatted: true, ...(newAnnotationUk ? { annotationUk: newAnnotationUk } : {}),
    };
  }

  if (workType === "prezentatsiya") {
    const slides = order.slides || [];
    const updatedSlides = slides.map((sl, i) => isSourcesTitle(sl.title || "")
      ? { ...sl, content: refBlock }
      : { ...sl, content: remapText(sl.content, `slide${i}`) });
    return { tezyCitations: refList, slides: updatedSlides, sourcesFormatted: true };
  }

  const result = order.result || "";
  const bibMatch = matchSourcesBlock(result);
  const body = bibMatch ? result.slice(0, bibMatch.index) : result;
  const remappedBody = remapText(body, "_body");
  const newResult = `${remappedBody}\n\n${sourcesHeading(info.language)}:\n${refBlock}`;
  return { tezyCitations: refList, result: newResult, sourcesFormatted: true };
}

// ── Повний текст роботи (для доповіді/презентації захисту) ──
function getWorkFullText(order) {
  if (order.workType === "dopovid") return "";
  if (order.workType === "referat") {
    return (order.sections || []).filter(s => s.text).map(s => `### ${s.label}\n${s.text}`).join("\n\n");
  }
  return order.result || "";
}

// ── fileContent для dopovid: DOCX → текст через mammoth; PPTX → текст зі слайдів; PDF/зображення → файл ──
async function getDopovIdFileContent(presFile) {
  if (!presFile) return { fileContent: [], extractedText: "" };
  const isDocx = presFile.type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    || presFile.name?.toLowerCase().endsWith(".docx")
    || presFile.name?.toLowerCase().endsWith(".doc");
  const isPptx = presFile.type === "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    || presFile.name?.toLowerCase().endsWith(".pptx");
  if (isDocx) {
    try {
      const bytes = Uint8Array.from(atob(presFile.b64), c => c.charCodeAt(0));
      const result = await mammoth.extractRawText(typeof Buffer !== "undefined" ? { buffer: Buffer.from(bytes) } : { arrayBuffer: bytes.buffer }); // Node-воркер: mammoth приймає лише buffer (інакше «Could not find file in options»)
      return { fileContent: [], extractedText: result.value.trim() };
    } catch { return { fileContent: [], extractedText: "" }; }
  }
  if (isPptx) {
    try {
      const text = await extractPptxText(presFile.b64);
      return { fileContent: [], extractedText: text };
    } catch { return { fileContent: [], extractedText: "" }; }
  }
  return {
    fileContent: [{ type: presFile.type.startsWith("image/") ? "image" : "document", source: { type: "base64", media_type: presFile.type, data: presFile.b64 } }],
    extractedText: "",
  };
}

/**
 * Текст доповіді для захисту — з тексту вже написаної роботи (sections/result)
 * або з окремо завантаженого файлу (order.presFile, лише для workType:"dopovid",
 * коли роботу писали не тут). Перенесено з generateSpeechWithout без зміни логіки.
 *
 * @param {object} order - { workType, info, sections?, result?, presFile? }
 * @param {object} ctx - { callGemini, onProgress? }
 * @returns {Promise<object>} патч {speechText}
 */
export async function runDopovidSpeech(order, ctx) {
  const { callGemini } = ctx;
  const info = order.info || {};
  const lang = info.language || "Українська";
  const sectionText = getWorkFullText(order);
  const isDopovid = order.workType === "dopovid";
  const { fileContent: dopFile, extractedText: dopText } = isDopovid
    ? await getDopovIdFileContent(order.presFile)
    : { fileContent: [], extractedText: "" };
  const workText = sectionText || dopText;

  const prompt = `Напиши текст доповіді для захисту ${info.type || WORK_TYPE_LABELS[order.workType] || "роботи"} на тему "${info.topic}".
${workText ? `\nПОВНИЙ ТЕКСТ РОБОТИ (витягуй конкретні факти, методи, результати, числа):\n${workText}\n` : ""}
ВИМОГИ:
- Обсяг: 3-5 хвилин (2-3 сторінки)
- Структура: вступ → актуальність → мета і завдання → методи → результати → висновки → завершення
- Стиль: стриманий академічний усний
- ОБОВ'ЯЗКОВО: конкретні назви методів, числа, відсотки з роботи
- ЗАБОРОНЕНО: "тема є актуальною", "варто відмітити", "слід зазначити"
- БЕЗ міток "Слайд N" — суцільний академічний текст
- НЕ виводь назви розділів та їх номери
- НЕ вигадуй і НЕ виводь об'єкт, предмет, методи якщо вони не сформульовані явно у тексті роботи
- Мова: ${lang}
- Без markdown, зірочок, жирного`;

  const speechMsgsWithout = isDopovid && dopFile.length > 0
    ? [{ role: "user", content: [...dopFile, { type: "text", text: prompt }] }]
    : [{ role: "user", content: prompt }];
  const raw = await callGemini(
    speechMsgsWithout, ctx.signal,
    "You are an expert academic writing assistant. Write a substantive, factual oral defense speech. Every sentence must state a concrete fact, method, result or conclusion — no filler phrases. No markdown formatting.", 5000,
    null, "gemini-2.5-flash", undefined, { onCost: ctx.onCost }
  );

  const cleaned = typographQuotes(stripStrayCJK(raw
    .split("\n")
    .filter(line => {
      const t = line.trim();
      if (!t) return true;
      if (/^\d+(\.\d+)+[\s.]/.test(t)) return false;
      if (/^#{1,6}\s/.test(t)) return false;
      return true;
    })
    .join("\n"), lang), lang)
    .replace(/\*\*(.+?)\*\*/g, "$1").replace(/\*(.+?)\*/g, "$1");

  return { speechText: cleaned };
}

/**
 * JSON слайдів презентації захисту (тема + масив слайдів) з тексту роботи й,
 * за наявності, тексту доповіді (order.speechText) — щоб слайди покривали ті ж
 * пункти. Перенесено з generateSmallPresentation, БЕЗ виклику exportToPptxFile
 * (сам .pptx-файл — окремий крок, як і для runSmallPresentation).
 *
 * @param {object} order - { workType, info, sections?, result?, presFile?, presComment?, speechText? }
 * @param {object} ctx - { callClaude, onProgress? }
 * @returns {Promise<object>} патч {presSlideJson, presReady:true}
 */
export async function runDopovidPresentation(order, ctx) {
  const { callClaude, onProgress } = ctx;
  const info = order.info || {};
  const lang = info.language || "Українська";
  const fullText = getWorkFullText(order);
  const isDopovid = order.workType === "dopovid";
  const commentBlock = (order.presComment || "").trim() ? `\nКОМЕНТАР ЗАМОВНИКА (виконай обов'язково): ${order.presComment.trim()}\n` : "";
  const { fileContent, extractedText } = isDopovid
    ? await getDopovIdFileContent(order.presFile)
    : { fileContent: order.presFile ? [{ type: order.presFile.type.startsWith("image/") ? "image" : "document", source: { type: "base64", media_type: order.presFile.type, data: order.presFile.b64 } }] : [], extractedText: "" };
  const workText = fullText || extractedText;
  const speechText = order.speechText || "";
  const speechBlock = speechText.trim()
    ? `\nТЕКСТ ДОПОВІДІ ДЛЯ ЗАХИСТУ (слайди ОБОВ'ЯЗКОВО мають покривати КОЖЕН пункт, завдання, стратегію, модель, етап тощо, перелічені в доповіді — з ТІЄЮ Ж кількістю елементів; нічого не пропускай і не додавай зайвого, аби виступ і слайди не розходились):\n${speechText.trim()}\n`
    : "";

  const claudePrompt = `Уважно прочитай роботу і згенеруй JSON для презентації захисту.
${workText ? `\nТЕКСТ РОБОТИ:\n${workText}\n` : ""}${speechBlock}${commentBlock}
КРИТИЧНІ ВИМОГИ ДО ТОЧНОСТІ:
- Копіюй всі числа, параметри, назви ДОСЛІВНО з тексту — НЕ перефразовуй
- ПІБ студента, керівника, назву закладу — точно як у роботі (якщо не знайдено — null, НЕ пиши "[Студент]" або плейсхолдери)
- Назви таблиць, заголовки колонок — точно як у тексті
- Всі рядки таблиць — повністю, нічого не скорочуй
${speechText.trim() ? "- Якщо в доповіді перелічено N пунктів (завдань, стратегій, моделей тощо) — відповідний слайд має містити всі N, навіть якщо доведеться розбити їх на кілька слайдів\n" : ""}

СТРУКТУРА (у такому порядку):
1. layout "title_slide" — тема, тип роботи, студент, керівник, заклад, рік
2. layout "two_column" — Актуальність
3. layout "two_column" або "highlight_box" — Об'єкт та предмет дослідження (тільки якщо явно сформульовані у тексті; якщо ні — пропусти цей слайд)
4. layout "icon_list" — Мета (🎯) та ВСІ завдання (→) дослівно як у тексті — порахуй їх точно; якщо разом із метою > 6 — розбий на 2 слайди
5. layout "numbered_steps" — Методи (якщо методів немає у тексті явно — пропусти)
6–N. ЗМІСТОВІ: для КОЖНОЇ таблиці → layout "table" з УСІМА рядками; для числових результатів → "stat_callout"; для решти → "highlight_box"
N-1. layout "icon_list" — Висновки (✅)
N. layout "hero" — "Дякую за увагу!", subtitle: ""

ПРАВИЛА JSON:
- Кількість слайдів: 12–20 залежно від обсягу роботи
- Мова: ${lang}
- title_slide: {title, work_type, student, supervisor, institution, year} — null якщо не знайдено
- two_column: {title, left, right_type:"text", right}
- icon_list: {title, visual:{items:[{icon,header,text}]}}
- numbered_steps: {title, visual:{items:[{num,title,text}]}}
- stat_callout: {title, visual:{stats:[{value,label}]}, content}
- highlight_box: {title, points:[], accent} (accent — реальний зміст або null; НІКОЛИ не пиши назви кольорів)
- table: {title, visual:{headers:[...], rows:[[...]]}, content:"підпис що показує таблиця"}
- hero: {title, subtitle:""}
- НІКОЛИ не додавай номери замовлень, ID або технічні ідентифікатори
- КАТЕГОРИЧНО ЗАБОРОНЕНО додавати будь-яке застереження/дисклеймер про використання штучного інтелекту, ШІ, AI чи подібних інструментів — ні окремим слайдом, ні рядком у контенті
- theme: "midnight" (техніка/інженерія), "forest" (природа/медицина/біологія), "coral" (соціальне/педагогіка), "slate" (економіка/фінанси), "warm" (решта)

Поверни ТІЛЬКИ валідний JSON без markdown:
{"theme":"...","slides":[...]}`;

  onProgress?.("Аналізую та генерую слайди...");
  const userContent = [...fileContent, { type: "text", text: claudePrompt }];
  const claudeRaw = await callClaude(
    [{ role: "user", content: userContent }], ctx.signal,
    SYS_JSON_SHORT, 12000,
    (s) => onProgress?.(`Генерую... зачекайте ${s}с`), MODEL, { onCost: ctx.onCost }
  );

  let slideData;
  try {
    slideData = JSON.parse(cleanDash(claudeRaw.replace(/```json\n?|\n?```/g, "").trim()));
  } catch { throw new Error("Claude повернув некоректний JSON слайдів"); }

  return { presSlideJson: slideData, presReady: true };
}

/**
 * Розмічає вже готовий текст доповіді (order.speechText) мітками "Слайд N" —
 * по одному фрагменту на кожен слайд презентації захисту (order.presSlideJson),
 * не змінюючи сам текст. Перенесено з generateSpeechWith без зміни логіки.
 *
 * @param {object} order - { info, speechText, presSlideJson }
 * @param {object} ctx - { callGemini }
 * @returns {Promise<object>} патч {speechWithText}
 */
export async function runDopovidSpeechAligned(order, ctx) {
  const { callGemini } = ctx;
  const info = order.info || {};
  const lang = info.language || "Українська";
  const speechText = order.speechText || "";
  const presSlideJson = order.presSlideJson;
  if (!speechText.trim() || !presSlideJson?.slides?.length) {
    throw new Error("Потрібні і текст доповіді (speechText), і згенерована презентація (presSlideJson) з хоча б одним слайдом.");
  }

  const LAYOUT_LABEL = {
    hero: "Титульний/фінальний", two_column: "Два стовпці", stat_callout: "Статистика",
    icon_list: "Список з іконками", highlight_box: "Виділені пункти", numbered_steps: "Кроки",
  };
  const slidesOutline = presSlideJson.slides
    .map((sl, i) => {
      const label = LAYOUT_LABEL[sl.layout] || sl.layout;
      const parts = [`Слайд ${i + 1} [${label}]: ${sl.title || ""}`];
      if (sl.subtitle) parts.push(`  Підзаголовок: ${sl.subtitle}`);
      if (sl.left) parts.push(`  Ліво: ${sl.left}`);
      if (sl.right) parts.push(`  Право: ${sl.right}`);
      if (sl.content) parts.push(`  Текст: ${sl.content}`);
      if (sl.accent) parts.push(`  Акцент: ${sl.accent}`);
      if (sl.visual?.stats?.length) parts.push(`  Статистика: ${sl.visual.stats.map(s => `${s.value} (${s.label})`).join(", ")}`);
      if (sl.visual?.items?.length) parts.push(`  Пункти: ${sl.visual.items.map(it => typeof it === "object" ? `${it.header || ""}: ${it.text || ""}` : it).join(" | ")}`);
      if (sl.points?.length) parts.push(`  Пункти: ${sl.points.join(" | ")}`);
      return parts.join("\n");
    })
    .join("\n\n");

  const prompt = `Розклади наведений нижче ГОТОВИЙ текст доповіді по слайдах презентації — встав мітку "Слайд N" окремим рядком перед фрагментом, який відповідає цьому слайду.

ГОТОВИЙ ТЕКСТ ДОПОВІДІ (використай ДОСЛІВНО — НЕ редагуй, НЕ перефразовуй, НЕ скорочуй і НЕ додавай нових речень, лише розбий його на фрагменти):
${speechText.trim()}

СТРУКТУРА ПРЕЗЕНТАЦІЇ (${presSlideJson.slides.length} слайдів, виступ має йти паралельно з ними):
${slidesOutline}

ВИМОГИ:
- Розбий наведений текст доповіді на фрагменти і встав перед кожним мітку "Слайд N" окремим рядком
- Якщо для якогось слайду немає відповідного фрагменту тексту — НЕ вставляй порожню мітку; об'єднай цей слайд з попереднім або наступним
- Мітка "Слайд N" має з'являтись ТІЛЬКИ якщо після неї є текст
- Збережи дослівний текст і його послідовність — це лише розмітка наявного тексту, а не новий текст
- Мова: ${lang}
- Без markdown, зірочок, жирного — тільки мітки "Слайд N" і незмінний текст доповіді`;

  const raw = await callGemini(
    [{ role: "user", content: prompt }], ctx.signal,
    "You only segment and label the given text into slide-aligned fragments — you must not rewrite, paraphrase, shorten or add anything to it.", 5000,
    null, "gemini-2.5-flash", undefined, { onCost: ctx.onCost }
  );

  const lines = raw
    .split("\n")
    .filter(line => {
      const t = line.trim();
      if (!t) return true;
      if (/^Слайд\s+\d+/i.test(t)) return true;
      if (/^#{1,6}\s/.test(t)) return false;
      return true;
    });

  const cleaned = lines
    .filter((line, i) => {
      if (!/^Слайд\s+\d+/i.test(line.trim())) return true;
      const nextNonEmpty = lines.slice(i + 1).find(l => l.trim());
      return nextNonEmpty && !/^Слайд\s+\d+/i.test(nextNonEmpty.trim());
    })
    .join("\n")
    .replace(/\*\*(.+?)\*\*/g, "$1").replace(/\*(.+?)\*/g, "$1");

  return { speechWithText: cleaned };
}

export { dedupAndSortCitations };
