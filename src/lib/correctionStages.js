// ─────────────────────────────────────────────
// correctionStages.js — спільна, не прив'язана до React орхестраційна логіка
// застосування "правок" (виправлень до готового .docx за виділеннями/
// коментарями Word чи ручними зауваженнями) — той самий патерн, що й
// orderStages.js/smallStages.js: кожна функція не робить setState/window/alert,
// а працює з переданими об'єктами (zip/docXml з docxSurgicalEdit.js) і
// повертає результат. Джерело логіки — src/FileCorrectionsPage.jsx (doAnalyze/
// doApply), перенесено без зміни промптів і правил, щоб той самий потік міг
// виконуватись і в браузері (замість дублювання), і в серверному воркері
// (worker/*) без React/DOM — лише з ін'єкцією Node-варіанту JSZip/DOMParser/
// XMLSerializer (worker/docxNodeIO.js) у docxSurgicalEdit.js/docxAnnotations.js.
//
// ctx — { callClaude, costTracker?, onProgress?(msg), io? }
//   callClaude — ВЖЕ прив'язаний до costTracker (як wrappedCallClaude в
//   processOrder.js) — ця функція сама не керує лічильником вартості.
//   costTracker — той самий об'єкт (createCostTracker() з api.js), що
//   передається в опції callClaude — тут використовується лише для .check()
//   між батчами (замість браузерного getGenerationCost()/GENERATION_COST_LIMIT,
//   які рахують вартість ВСІЄЇ сесії вкладки, а не одного прогону).
//   io — { JSZip, DOMParser, XMLSerializer } для removeDocxComment у Node
//   (worker/docxNodeIO.js); у браузері не потрібен (глобали за замовчуванням).
// ─────────────────────────────────────────────
import { MODEL, MODEL_FAST } from "./api.js";
import {
  SYS_JSON, SYS_JSON_ARRAY, buildSYS,
  buildFileCorrectionsAnalysisPrompt,
  buildFileApplyCorrectionBatchPrompt,
  buildAnnotationCorrectionBatchPrompt,
  buildDocumentWideCorrectionPrompt,
  buildSourcesRestructureAnalysisPrompt,
  buildSourcePlacementInTextPrompt,
} from "./prompts.js";
import { stripEmDash } from "./wordCount.js";
import {
  openDocxForEditing, refreshTextMap, applyDocxReplacement, removeDocxComment, serializeDocx,
  getParagraphs, setParagraphText, insertParagraphsAfterEl, deleteParagraphEls,
  acceptRevisionsInDocx, documentHasToc, setUpdateFieldsOnOpen,
} from "./docxSurgicalEdit.js";
import { extractAnnotationsFromOpenDocx } from "./docxAnnotations.js";
import { findOutOfRangeCitationInText, countOutOfRangeCitations, locateSourcesZone, findCitationsToRenumber, formatSourcesWithRetry } from "./citationFormatting.js";
import { locateFragment } from "./textFragmentLocate.js";
import { runAgentCorrections } from "./correctionAgent.js";
import { adaptDocumentParagraphs, isAdaptationTask } from "./documentAdaptation.js";

// Скільки завдань ОДНОГО типу групувати в один виклик ШІ при застосуванні правок —
// основне джерело економії токенів: повний текст роботи надсилається раз на групу.
const BATCH_SIZE = 5;

// ─────────────────────────────────────────────
// Чи стосується конкретна правка методички/матеріалів клієнта — щоб не тягнути
// їх у КОЖЕН запит на виправлення (дорого), а лише туди, де це справді потрібно.
// ─────────────────────────────────────────────
const METHODICHKA_HINT_RE = /методичк|оформленн|стил[ьяю].*цитуванн|цитуванн.*стил|шрифт|інтервал|поля\b|таблиц.*оформ|номер.*сторінк|структур.*розділ|дсту|apa|mla/i;
const CLIENT_MATERIALS_HINT_RE = /матеріал.*клієнт|дані клієнта|розрахун|калькуляц|фактичні дані|компані[їя]|підприємств|наведені дані/i;

export function classifyContextNeed(task) {
  const text = [task.annotatedText, task.instruction, task.issue, task.suggestion, task.location].filter(Boolean).join(" ");
  return {
    needsMethodichka: METHODICHKA_HINT_RE.test(text),
    needsClientMaterials: CLIENT_MATERIALS_HINT_RE.test(text),
  };
}

// ─────────────────────────────────────────────
// Зауваження, що явно стосується ВСЬОГО документа ("так має бути по всій
// роботі", "виправ скрізь" тощо), а не лише одного позначеного місця — такі
// завдання йдуть окремим шляхом (applyDocumentWideTask): ШІ шукає й виправляє
// ВСІ відповідні місця в тексті за один прохід, а не тільки те, де було
// залишено саме зауваження.
// ─────────────────────────────────────────────
const DOCUMENT_WIDE_HINT_RE = /по\s+всій\s+робот|по\s+всьому\s+документ|у\s+всьому\s+текст|у\s+всій\s+роботі|скрізь|усюди|кожного\s+разу|весь\s+документ|усі\s+згадк|щораз/i;

export function isDocumentWideTask(task) {
  const text = [task.annotatedText, task.instruction, task.noteText, task.issue, task.suggestion].filter(Boolean).join(" ");
  return DOCUMENT_WIDE_HINT_RE.test(text);
}

// ─────────────────────────────────────────────
// Типова обізнаність розділу — знаходить, чи фрагмент лежить у Вступі/Висновках/
// Списку джерел (за найближчим заголовком ПЕРЕД ним), щоб не дати ШІ поламати
// структурні вимоги до цих розділів (нумерацію джерел, склад вступу тощо).
// ─────────────────────────────────────────────
const ZONE_HEADING_RE = /^(ВСТУП|INTRODUCTION|ВИСНОВКИ|CONCLUSIONS?|СПИСОК ВИКОРИСТАНИХ ДЖЕРЕЛ|СПИСОК ЛІТЕРАТУРИ|REFERENCES|BIBLIOGRAPHY|РОЗДІЛ\s+\d+|CHAPTER\s+\d+)\s*$/im;

function detectZoneAtPosition(text, pos) {
  if (pos == null || pos < 0) return null;
  const before = text.slice(0, pos);
  const re = new RegExp(ZONE_HEADING_RE.source, "gim");
  let m, zone = null;
  while ((m = re.exec(before))) {
    const h = m[1].toUpperCase();
    if (/ВСТУП|INTRODUCTION/.test(h)) zone = "intro";
    else if (/ВИСНОВК|CONCLUSION/.test(h)) zone = "conclusions";
    else if (/ДЖЕРЕЛ|ЛІТЕРАТУР|REFERENCES|BIBLIOGRAPHY/.test(h)) zone = "sources";
    else zone = null;
  }
  return zone;
}

function detectZoneFromLocation(location) {
  if (!location) return null;
  if (/джерел|літератур|references|bibliography/i.test(location)) return "sources";
  if (/висновк|conclusion/i.test(location)) return "conclusions";
  if (/вступ|introduction/i.test(location)) return "intro";
  return null;
}

function buildZoneGuard(zone) {
  if (zone === "intro") return "\nЦе ВСТУП — обов'язково збережи всі стандартні структурні елементи (актуальність теми, мета, завдання дослідження, об'єкт, предмет, методи дослідження, практичне значення, структура роботи) в тому ж порядку й кількості, навіть якщо виправляєш лише частину.";
  if (zone === "conclusions") return "\nЦе ВИСНОВКИ — збережи структуру по одному абзацу на кожен пункт, без нумерації та без нових посилань [N].";
  if (zone === "sources") return "\nЦе СПИСОК ВИКОРИСТАНИХ ДЖЕРЕЛ — КАТЕГОРИЧНО ЗАБОРОНЕНО змінювати нумерацію, порядок чи кількість джерел. Виправляй ЛИШЕ те, про що сказано в завданні (форматування, розділові знаки).";
  return "";
}

function buildCitationGuard(existingCitationNumbers) {
  if (!existingCitationNumbers?.length) {
    return "\nЦИТУВАННЯ: у цьому фрагменті немає визначеного списку джерел — категорично заборонено додавати нові посилання [N].";
  }
  return `\nЦИТУВАННЯ: у документі існують лише джерела з номерами ${existingCitationNumbers.join(", ")}. Можеш посилатись на будь-яке з них під його реальним номером, якщо доречно. КАТЕГОРИЧНО ЗАБОРОНЕНО вигадувати номер джерела, якого немає в цьому списку.`;
}

function buildIllustrationGuard(hasIt) {
  return hasIt ? "\nІЛЮСТРАЦІЇ КЛІЄНТА: якщо у фрагменті є рядок-маркер [КЛІЄНТ-ІЛЮСТРАЦІЯ:N] — ОБОВ'ЯЗКОВО збережи його ТОЧНО без змін, включно з номером N." : "";
}

// Комбінує весь додатковий контекст для одного завдання: методичка/матеріали
// клієнта (лише коли ключові слова завдання натякають, що це доречно) + захисні
// правила (цитування, тип розділу, маркери ілюстрацій) — застосовуються завжди.
export function buildTaskPromptExtras(task, { methodInfo, clientMaterialsSummary, existingCitationNumbers, text }) {
  const { needsMethodichka, needsClientMaterials } = classifyContextNeed(task);
  let block = "";
  if (needsMethodichka && methodInfo) {
    const parts = [methodInfo.sourcesFormatRules, methodInfo.citationStyle, methodInfo.formatting?.tableFormat, methodInfo.theoryRequirements].filter(Boolean);
    if (parts.length) block += `\nВИМОГИ МЕТОДИЧКИ: ${parts.join(". ")}`;
  }
  if (needsClientMaterials && clientMaterialsSummary?.rawText) {
    block += `\n\nМАТЕРІАЛИ КЛІЄНТА (використовуй ці дані — не вигадуй, не замінюй):\n${clientMaterialsSummary.rawText.slice(0, 80000)}`;
  }

  const zone = task.kind === "manual"
    ? detectZoneFromLocation(task.location)
    : detectZoneAtPosition(text, locateFragment(text, task.annotatedText, task.context)?.start);
  block += buildZoneGuard(zone);
  block += buildCitationGuard(existingCitationNumbers);

  const hasIllustrations = /\[КЛІЄНТ-ІЛЮСТРАЦІЯ:/.test(task.annotatedText || task.context || task.location || "");
  block += buildIllustrationGuard(hasIllustrations);

  return block;
}

// ─────────────────────────────────────────────
// Контроль обсягу — якщо виправлений фрагмент сильно "поплив" відносно оригіналу
// (значне ручне завдання, не дрібна правка), допрошуємо ШІ дописати чи скоротити
// до приблизно того самого обсягу, щоб довжина роботи не "гуляла" від правок.
// ─────────────────────────────────────────────
function wc(s) {
  const t = (s || "").trim();
  return t ? t.split(/\s+/).length : 0;
}

async function adjustVolume({ original, replacement, lang, methodInfo, label }, ctx) {
  const origWords = wc(original);
  const newWords = wc(replacement);
  if (origWords <= 30 || !replacement) return replacement;
  const sys = buildSYS(lang, methodInfo);
  if (newWords < origWords * 0.7) {
    const missing = origWords - newWords;
    const contPrompt = `Ось поточний текст фрагмента "${label || ""}" (${newWords} слів, оригінал мав ${origWords}):\n\n${replacement}\n\nДопиши ще приблизно ${missing} слів, органічно продовжуючи виклад далі, не повторюючи вже написане. Без вступних фраз, без заголовків. Просто продовж текст.`;
    try {
      const contRaw = await ctx.callClaude([{ role: "user", content: contPrompt }], null, sys, Math.min(20000, Math.max(2000, Math.round(missing * 3))), null, MODEL, { cache: true });
      return stripEmDash(replacement + "\n\n" + contRaw).trim();
    } catch { return replacement; }
  }
  if (newWords > origWords * 1.5) {
    const shortenPrompt = `Ось поточний текст фрагмента "${label || ""}" (${newWords} слів):\n\n${replacement}\n\nСкороти його до приблизно ${origWords} слів: прибери повтори та другорядні деталі, збережи головні тези. Поверни лише скорочений текст, без коментарів.`;
    try {
      const shortRaw = await ctx.callClaude([{ role: "user", content: shortenPrompt }], null, sys, Math.min(30000, Math.max(4000, Math.round(origWords * 3))), null, MODEL, { cache: true });
      return stripEmDash(shortRaw).trim();
    } catch { return replacement; }
  }
  return replacement;
}

// ─────────────────────────────────────────────
// Конвертація анотацій (виділення/коментарі Word) → tasks. kind:"annotation" —
// відрізняє їх від ручних зауважень (kind:"manual", див. analyzeManualNotes),
// щоб applyCorrectionTasks міг батчити кожен тип окремим промптом, не змішуючи
// формати.
// ─────────────────────────────────────────────
export function annotationsToTasks(annotations) {
  const tasks = [];
  annotations.highlights.forEach((h, i) => {
    tasks.push({
      id: `h_${i}`,
      kind: "annotation",
      type: "highlight",
      colorInfo: h.colorInfo,
      label: `Виділено ${h.colorInfo?.ua || h.color}`,
      annotatedText: h.text,
      context: h.context,
      instruction: "Виправте або перепишіть виділену частину, зберігаючи стиль і мову документу. Якщо всередині виділеного фрагмента є питання чи вимога від керівника (звернення до автора, знак питання, прохання щось уточнити чи додати) — це НЕ частина тексту роботи: розпізнай його окремо, дай на нього фактичну відповідь (якщо вона однозначно випливає з контексту — наприклад, автор перекладу цитати) і органічно встав цю відповідь у текст, а саме питання повністю прибери з фінального результату. Якщо відповідь не випливає однозначно з контексту — не вигадуй її, залиш позначку needs_review.",
    });
  });
  annotations.comments.forEach((c, i) => {
    tasks.push({
      id: `c_${i}`,
      kind: "annotation",
      type: "comment",
      colorInfo: null,
      label: `Коментар: ${c.author}`,
      annotatedText: c.commentedText,
      context: null,
      instruction: c.instruction,
      commentId: c.id,
    });
  });
  // Нотатки, вписані прямо в абзац червонуватим кольором шрифту (не справжній
  // коментар Word і не підсвітка) — на відміну від highlight/comment вище,
  // тут "фрагмент для заміни" (annotatedText) — ВЕСЬ абзац, а не сама нотатка:
  // сам проблемний текст, на який вона вказує, лежить поруч, а не всередині неї.
  (annotations.colorNotes || []).forEach((n, i) => {
    tasks.push({
      id: `cn_${i}`,
      kind: "annotation",
      type: "color_note",
      colorInfo: null,
      label: "Нотатка (колір шрифту)",
      annotatedText: n.context,
      context: null,
      noteText: n.text,
      instruction: `У цьому фрагменті вписана від руки нотатка керівника, виділена кольором шрифту: "${n.text}". Виправ фрагмент відповідно до цієї нотатки (якщо вона стосується сусіднього тексту — виправ саме його), і обов'язково повністю прибери саму нотатку з фінального тексту.`,
    });
  });
  tasks.forEach(t => { t.adaptation = isAdaptationTask(t); t.documentWide = !t.adaptation && isDocumentWideTask(t); });
  return tasks;
}

/**
 * Аналіз вільного тексту зауважень (від викладача/клієнта) → масив ручних
 * завдань (kind:"manual" або "sources_restructure") — той самий Claude-виклик,
 * що doAnalyze() у FileCorrectionsPage.jsx. Фото зауважень (correctionPhotos)
 * підтримуються так само, як у браузері.
 *
 * @param {{docText: string, correctionsText: string, correctionPhotos?: Array<{b64:string, type:string}>}} input
 * @param {{callClaude: Function}} ctx
 * @returns {Promise<Array<object>>}
 */
export async function analyzeManualNotes({ docText, correctionsText, correctionPhotos = [] }, ctx) {
  const prompt = buildFileCorrectionsAnalysisPrompt({ documentText: docText, correctionsText });
  const imageContent = correctionPhotos.map(p => ({ type: "image", source: { type: "base64", media_type: p.type, data: p.b64 } }));
  const userContent = imageContent.length ? [...imageContent, { type: "text", text: prompt }] : prompt;
  const raw = await ctx.callClaude([{ role: "user", content: userContent }], null, SYS_JSON_ARRAY, 10000, null, MODEL_FAST);
  const parsed = JSON.parse(raw.replace(/```json|```/g, "").trim());
  if (!Array.isArray(parsed)) throw new Error("Некоректна відповідь ШІ на аналіз зауважень");
  return parsed.map((t, i) => ({
    ...t,
    id: `m_${Date.now()}_${i}`,
    kind: t.sourcesAction === "restructure" ? "sources_restructure" : "manual",
    adaptation: t.sourcesAction !== "restructure" && isAdaptationTask(t),
    documentWide: t.sourcesAction !== "restructure" && !isAdaptationTask(t) && isDocumentWideTask(t),
  }));
}

// ─────────────────────────────────────────────
// Абзаци записів списку джерел (у межах zone з locateSourcesZone) — з тим
// самим правилом розпізнавання записів, що й у locateSourcesZone.
// ─────────────────────────────────────────────
function sourcesEntryParagraphs(docXml, text, zone) {
  const paras = getParagraphs(docXml);
  const out = [];
  let pos = 0;
  text.split("\n").forEach((line, i) => {
    const start = pos;
    pos += line.length + 1;
    if (start < zone.sourcesStart || start >= zone.sourcesEnd) return;
    const t = line.trim();
    if (zone.autoNumbered) {
      if (t.length >= 15 && t !== t.toUpperCase() && !/^[IVXІ]+\.\s/.test(t)) out.push({ p: paras[i], number: out.length + 1, line });
    } else {
      const m = t.match(/^(\d+)[.)]\s*(.*)$/);
      if (m && m[2].trim()) out.push({ p: paras[i], number: Number(m[1]), line });
    }
  });
  return out;
}

// Перебудова списку джерел по абзацах (раніше весь новий список писався в
// один текстовий вузол із переносами всередині — Word злипав його в один абзац).
function rewriteSourcesList(docXml, text, zone, { survivors, removeNumbers, newFormatted }, markEdits = false) {
  const entryParas = sourcesEntryParagraphs(docXml, text, zone);
  if (!entryParas.length) throw new Error("не вдалося зіставити записи списку джерел з абзацами документа");
  const byNumber = new Map(entryParas.map(e => [e.number, e]));
  survivors.forEach((e, idx) => {
    const ep = byNumber.get(e.number);
    if (!ep || zone.autoNumbered) return; // автонумерація Word перенумерує сама
    setParagraphText(ep.p, ep.line.replace(/^(\s*)\d+/, `$1${idx + 1}`), markEdits);
  });
  if (newFormatted.length) {
    const kept = entryParas.filter(ep => !removeNumbers.has(ep.number));
    const model = (kept[kept.length - 1] || entryParas[entryParas.length - 1]).p;
    const texts = newFormatted.map((t, i) => (zone.autoNumbered ? t : `${survivors.length + i + 1}. ${t}`));
    insertParagraphsAfterEl(model, texts, model, { markEdits });
  }
  const toRemove = entryParas.filter(ep => removeNumbers.has(ep.number)).map(ep => ep.p);
  if (toRemove.length) {
    const neighbour = entryParas.find(ep => !removeNumbers.has(ep.number))?.p || null;
    const res = deleteParagraphEls(toRemove, { moveMarkersTo: neighbour });
    res.skipped.forEach(({ p }) => setParagraphText(p, ""));
  }
}

/**
 * Застосовує обраний набір завдань (annotation/manual/citation_pages/
 * sources_restructure/document-wide) до вже відкритого .docx (openDocxForEditing)
 * — та сама логіка, що doApply() у FileCorrectionsPage.jsx, без React-стану:
 * docXml мутується напряму (як і в браузері), результат повертається одним
 * об'єктом замість кількох setState.
 *
 * @param {{zip: object, docXml: object, plainText: string, map: Array, tasks: Array<object>, lang?: string, methodInfo?: object, clientMaterialsSummary?: {rawText:string}}} input
 * @param {{callClaude: Function, costTracker?: object, onProgress?: (msg:string)=>void, onTaskDone?: (done:number)=>void, io?: object}} ctx
 * @returns {Promise<{correctedText: string, failed: Array, messages: Array, changes: Array, appliedCount: number}>}
 */
export async function applyCorrectionTasks({ zip, docXml, tasks, lang = "Українська", methodInfo = null, clientMaterialsSummary = null, markEdits = false }, ctx) {
  const { callClaude, costTracker, onProgress = () => {}, onTaskDone = () => {}, io = {} } = ctx;
  const toFix = tasks;
  let { map, plainText: text } = refreshTextMap(docXml);
  // Знімок тексту на старт раунду — якщо фрагмент завдання не знайдеться в ПОТОЧНОМУ
  // тексті, але знайдеться тут, значить його вже переписала інша правка цього ж
  // раунду (типовий конфлікт між двома завданнями на той самий фрагмент), а не
  // випадок "фрагмента взагалі нема в документі".
  const roundStartText = text;
  const failed = [];
  const messages = [];
  const changes = [];

  // Групуємо підряд по BATCH_SIZE завдань ОДНОГО типу (annotation/manual — різні
  // промпти) в один виклик ШІ: повний текст роботи надсилається раз на групу.
  // citation_pages, sources_restructure і documentWide не батчуються — кожне йде
  // своїм окремим кодовим чи багатоетапним шляхом (documentWide — бо це один
  // виклик ШІ на ВЕСЬ документ, який сам шукає всі відповідні місця).
  const batches = [];
  for (let i = 0; i < toFix.length;) {
    if (toFix[i].adaptation) {
      batches.push({ kind: "adaptation", items: [toFix[i]] });
      i++;
      continue;
    }
    if (toFix[i].documentWide) {
      batches.push({ kind: "document_wide", items: [toFix[i]] });
      i++;
      continue;
    }
    const kind = toFix[i].kind;
    const group = [];
    while (i < toFix.length && toFix[i].kind === kind && group.length < BATCH_SIZE && kind !== "sources_restructure" && !toFix[i].documentWide && !toFix[i].adaptation) {
      group.push(toFix[i]); i++;
    }
    if (!group.length) { group.push(toFix[i]); i++; }
    batches.push({ kind, items: group });
  }

  let done = 0;
  // onTaskDone(done) — лічильник для смужки прогресу в UI ("виправлено N з M").
  const advance = (n = 1) => { done += n; onTaskDone(done); };
  const sysPromptSuffix = "\n\nВідповідай ЛИШЕ JSON, як описано вище. Без markdown, без пояснень поза ним.";

  // Один виклик ШІ на батч — якщо ВЕСЬ масив не розпарсився (типово: одна відповідь
  // містить незекрановані лапки й ламає JSON цілого батчу), пробуємо кожне завдання
  // окремо, а не валимо всі одразу — так само надійно, як старий підхід "один виклик
  // на завдання", але дешевше в щасливому випадку, коли батч парситься з першого разу.
  async function applyOneBatch(kind, batch) {
    onProgress(kind === "annotation" ? `Виділення та коментарі (${batch.length})` : `Ручні зауваження (${batch.length})`);
    const zoneNow = locateSourcesZone(text);
    const existingCitationNumbers = zoneNow?.entries.map(e => e.number) || [];
    const tasksForPrompt = batch.map(t => ({
      ...t,
      extraContext: buildTaskPromptExtras(t, { methodInfo, clientMaterialsSummary, existingCitationNumbers, text }),
    }));
    const prompt = kind === "annotation"
      ? buildAnnotationCorrectionBatchPrompt({ documentText: text, tasks: tasksForPrompt })
      : buildFileApplyCorrectionBatchPrompt({ documentText: text, tasks: tasksForPrompt });
    const maxTokens = Math.min(80000, Math.max(8000, 6000 * batch.length));
    const sysPrompt = buildSYS(lang, methodInfo) + sysPromptSuffix;

    let items;
    try {
      const result = await callClaude([{ role: "user", content: prompt }], null, sysPrompt, maxTokens, null, MODEL, { cache: true });
      const parsed = JSON.parse(result.replace(/```json|```/g, "").trim());
      if (!Array.isArray(parsed)) throw new Error("не масив");
      items = parsed;
    } catch (e) {
      if (e?.isCostLimit) {
        batch.forEach(task => failed.push({ task, reason: e.message }));
        advance(batch.length);
        return;
      }
      if (batch.length === 1) {
        failed.push({ task: batch[0], reason: "Не вдалося розпізнати відповідь ШІ." });
        advance();
        return;
      }
      for (const singleTask of batch) await applyOneBatch(kind, [singleTask]);
      return;
    }

    for (let i = 0; i < batch.length; i++) {
      const task = batch[i];
      const item = items.find(p => p?.index === i) ?? items[i];
      if (!item) {
        failed.push({ task, reason: "ШІ не повернув результат для цього завдання." });
      } else if (item.status === "needs_review") {
        failed.push({ task, reason: item.note || "Потрібна ручна перевірка — ШІ не може підтвердити правильне значення." });
      } else {
        // Кандидат на заміну: спершу шматок, який сам вказав ШІ (item.original) —
        // він вужчий і точніший (бачить повний текст роботи, тож для нотаток
        // кольором шрифту вкаже конкретне речення, а не цілий абзац, як раніше).
        // Якщо ШІ процитував неточно і цей шматок не знайшовся — для анотацій є
        // резерв: task.annotatedText, узятий напряму з XML при витягу анотацій,
        // на 100% присутній у документі саме таким, яким його бачив код.
        let original = kind === "annotation" ? (item.original || task.annotatedText) : item.original;
        let loc = original ? locateFragment(text, original, task.context) : null;
        if (!loc && kind === "annotation" && item.original && task.annotatedText && item.original !== task.annotatedText) {
          original = task.annotatedText;
          loc = locateFragment(text, original, task.context);
        }
        if (loc) {
          // Контроль обсягу — лише для суттєвих ручних завдань (кілька речень
          // і більше); для короткого виділення природно, що заміна коротша.
          let replacement = stripEmDash(item.replacement || "");
          if (kind === "manual" && original) {
            replacement = await adjustVolume({ original, replacement, lang, methodInfo, label: task.location }, ctx);
          }
          if (!applyDocxReplacement(map, loc.start, loc.end, replacement, markEdits)) {
            failed.push({ task, reason: "Заміна зачіпає таблицю або має некоректну структуру (напр. таблицю в тексті) — застосуйте вручну." });
            advance();
            continue;
          }
          changes.push({ label: task.label || task.location || (original || "").slice(0, 60), original, replacement });
          if (task.commentId) await removeDocxComment(zip, docXml, task.commentId, io);
          ({ map, plainText: text } = refreshTextMap(docXml));
        } else {
          // Фрагмент відсутній у поточному тексті — перевіряємо, чи він був там на
          // старті раунду: якщо так, це не "фрагмента нема", а інша правка вище по
          // списку вже його змінила.
          const wasThereAtStart = original ? !!locateFragment(roundStartText, original, task.context) : false;
          failed.push({
            task,
            reason: wasThereAtStart
              ? "Фрагмент уже змінено іншою правкою вище по списку — перевірте вручну, чи потрібна ця правка ще."
              : "Фрагмент не знайдено в тексті документа — заміну не застосовано.",
          });
        }
      }
      advance();
    }
  }

  // ── Зауваження, що стосується ВСЬОГО документа ("так має бути по всій
  // роботі" тощо, — DOCUMENT_WIDE_HINT_RE) — один виклик ШІ на весь текст
  // роботи, що сам знаходить і виправляє КОЖНЕ відповідне місце, а не лише
  // те, де було залишено саме зауваження. Кожна знайдена заміна застосовується
  // тим самим хірургічним шляхом, з оновленням text/map між замінами. ──
  async function applyDocumentWideTask(task) {
    onProgress(`Шукаю всі місця в документі (${task.label || task.location || "зауваження"})...`);
    try {
      const prompt = buildDocumentWideCorrectionPrompt({ documentText: text, task });
      const sysPrompt = buildSYS(lang, methodInfo) + sysPromptSuffix;
      const raw = await callClaude([{ role: "user", content: prompt }], null, sysPrompt, 20000, null, MODEL, { cache: true });
      const parsed = JSON.parse(raw.replace(/```json|```/g, "").trim());
      if (!Array.isArray(parsed)) throw new Error("не масив");

      let appliedCount = 0;
      for (const item of parsed) {
        if (!item?.original) continue;
        const loc = locateFragment(text, item.original, null);
        if (!loc) continue;
        const replacement = stripEmDash(item.replacement || "");
        if (!applyDocxReplacement(map, loc.start, loc.end, replacement, markEdits)) continue;
        changes.push({ label: task.label || task.location || "По всьому документу", original: item.original, replacement });
        ({ map, plainText: text } = refreshTextMap(docXml));
        appliedCount++;
      }
      if (task.commentId) await removeDocxComment(zip, docXml, task.commentId, io);

      if (appliedCount > 0) {
        messages.push({ type: "success", text: `Виправлено по всьому документу: ${appliedCount} місце(ць) (${task.label || task.location || "зауваження"}).` });
      } else {
        failed.push({ task, reason: "Не вдалося знайти в документі жодного місця, що підпадає під це зауваження — перевірте вручну." });
      }
    } catch (e) {
      failed.push({ task, reason: "Помилка пошуку по всьому документу: " + e.message });
    }
    advance();
  }

  // ── Адаптація ВСІЄЇ роботи під інший контекст ("переробити під ЗДО, а не
  // школу"): кодовий прохід по всіх абзацах (documentAdaptation.js), а не пошук
  // окремих фрагментів, що покривав лише частину тексту. ──
  async function applyAdaptationTask(task) {
    onProgress(`Переробляю всю роботу (${task.label || task.location || "зауваження"})...`);
    try {
      const instruction = [task.instruction, task.noteText, task.issue, task.suggestion].filter(Boolean).join(" ").trim();
      const res = await adaptDocumentParagraphs({ docXml, instruction, lang, methodInfo, markEdits }, { callClaude, onProgress });
      ({ map, plainText: text } = refreshTextMap(docXml));
      changes.push(...res.changes);
      if (task.commentId) await removeDocxComment(zip, docXml, task.commentId, io);
      if (res.changedCount === 0) {
        failed.push({ task, reason: "Не вдалося переробити жодного абзацу — перевірте вручну." });
      } else {
        messages.push({ type: "success", text: `Переробка під новий контекст: змінено абзаців — ${res.changedCount}${res.rejected ? `; відхилено як небезпечні для структури: ${res.rejected}` : ""}.` });
      }
      const body = res.leftover.filter(l => !l.inSources);
      const src = res.leftover.filter(l => l.inSources);
      if (body.length) messages.push({ type: "error", text: `Лишились згадки старого контексту в ${body.length} абзац(ах) — перевірте: ${body.slice(0, 6).map(l => `«…${l.snippet.trim()}…»`).join("; ")}${body.length > 6 ? "…" : ""}` });
      if (src.length) messages.push({ type: "error", text: `Список джерел не переписувався; ${src.length} запис(ів) стосуються старого контексту — замініть джерела вручну.` });
    } catch (e) {
      if (e?.isCostLimit) failed.push({ task, reason: e.message });
      else failed.push({ task, reason: "Помилка переробки всієї роботи: " + e.message });
    }
    advance();
  }

  // ── Перебудова списку джерел: додати/видалити конкретне джерело, перенумерувати
  // всі цитати по документу, вставити цитування нових джерел. Без структури
  // sections/content — усе працює прямо на плоскому тексті через хірургічні
  // заміни, як і решта інструмента. Підтримує лише нумерований стиль [N]. ──
  async function applySourcesRestructureTask(task) {
    onProgress("Перебудовую список джерел...");
    const zone = locateSourcesZone(text);
    if (!zone || !zone.entries.length) {
      failed.push({ task, reason: "Не вдалося знайти пронумерований список джерел у документі." });
      advance();
      return;
    }
    try {
      const currentSourcesText = zone.entries.map(e => `${e.number}. ${e.text}`).join("\n");
      const restructurePrompt = buildSourcesRestructureAnalysisPrompt({ currentSourcesText, issue: task.issue, suggestion: task.suggestion });
      const restructureRaw = await callClaude([{ role: "user", content: restructurePrompt }], null, SYS_JSON, 2000, null, MODEL);
      const restructureParsed = JSON.parse(restructureRaw.replace(/```json|```/g, "").trim());
      const removeNumbers = new Set((restructureParsed.remove || []).map(Number).filter(Number.isFinite));
      const addRaw = (restructureParsed.add || []).filter(s => s && s.trim());

      const survivors = zone.entries.filter(e => !removeNumbers.has(e.number));
      const removedCount = zone.entries.length - survivors.length;

      const sourcesStyle = methodInfo?.sourcesStyle || "ДСТУ 8302:2015";
      let newFormatted = [];
      if (addRaw.length) {
        newFormatted = await formatSourcesWithRetry({
          rawRefs: addRaw, findStructured: () => null, sourcesStyle,
          sourcesFormatRules: methodInfo?.sourcesFormatRules, callClaude,
        });
      }

      const oldToNew = {};
      survivors.forEach((e, idx) => { oldToNew[e.number] = idx + 1; });
      removeNumbers.forEach(n => { oldToNew[n] = null; });
      const newSourceFinalNumbers = newFormatted.map((_, idx) => survivors.length + idx + 1);

      // 1) Перебудувати сам список — по абзацах: уцілілі джерела лише
      // перенумеровуються (закладки й оформлення лишаються), нові — окремими
      // абзацами з оформленням сусіднього джерела, видалені — прибираються.
      rewriteSourcesList(docXml, text, zone, { survivors, removeNumbers, newFormatted }, markEdits);
      ({ map, plainText: text } = refreshTextMap(docXml));

      // 2) Перенумерувати/прибрати цитати по всьому тексту поза списком джерел —
      // одна за одною, без ШІ, так само як сторінки в цитатах.
      // Усі заміни — за один прохід, застосування від кінця тексту до початку
      // (позиції ще не застосованих лишаються дійсними).
      let renumberedCount = 0;
      const zoneNow = locateSourcesZone(text);
      const renumberFixes = findCitationsToRenumber(text, oldToNew, zoneNow?.sourcesStart ?? text.length, zoneNow?.sourcesEnd ?? text.length);
      for (const fix of renumberFixes) {
        applyDocxReplacement(map, fix.start, fix.end, fix.replacement, markEdits);
        ({ map, plainText: text } = refreshTextMap(docXml));
        renumberedCount++;
      }

      // 3) Знайти в тексті доречне місце й вставити цитування кожного нового джерела
      const unplaced = [];
      for (let i = 0; i < newFormatted.length; i++) {
        const finalN = newSourceFinalNumbers[i];
        const marker = `[${finalN}]`;
        try {
          const placementPrompt = buildSourcePlacementInTextPrompt({ documentText: text, newSourceText: newFormatted[i], citationMarker: marker });
          const placementRaw = await callClaude([{ role: "user", content: placementPrompt }], null, SYS_JSON, 2000, null, MODEL);
          const placementParsed = JSON.parse(placementRaw.replace(/```json|```/g, "").trim());
          const anchorLoc = placementParsed?.found && placementParsed.anchor ? locateFragment(text, placementParsed.anchor, null) : null;
          if (anchorLoc) {
            applyDocxReplacement(map, anchorLoc.start, anchorLoc.end, text.slice(anchorLoc.start, anchorLoc.end) + ` ${marker}`, markEdits);
            ({ map, plainText: text } = refreshTextMap(docXml));
          } else {
            unplaced.push(finalN);
          }
        } catch {
          unplaced.push(finalN);
        }
      }

      const summaryParts = [];
      if (removedCount) summaryParts.push(`видалено ${removedCount} джерел${renumberedCount ? ` (прибрано/перенумеровано посилань: ${renumberedCount})` : ""}`);
      if (newFormatted.length) summaryParts.push(`додано ${newFormatted.length} нових джерел${unplaced.length ? ` (для №${unplaced.join(", ")} не вдалося автоматично підібрати місце цитування — процитуйте вручну)` : ""}`);
      if (!summaryParts.length) summaryParts.push("змін у списку джерел не знайдено за цим зауваженням");
      messages.push({ type: "success", text: `Список джерел оновлено: ${summaryParts.join("; ")}.` });
    } catch (e) {
      failed.push({ task, reason: "Помилка перебудови списку джерел: " + e.message });
    }
    advance();
  }

  for (const { kind, items: batch } of batches) {
    if (costTracker) {
      try {
        costTracker.check();
      } catch (e) {
        if (e.isCostLimit) {
          messages.push({ type: "error", text: `⛔ Зупинено: вартість цих правок перевищила ліміт. Уже застосовані правки збережено — решту завдань (${toFix.length - done}) перевірте вручну. (${e.message})` });
          break;
        }
        throw e;
      }
    }
    // Сторінки в цитатах — суто кодова перевірка, без ШІ: номер підбирає
    // pickPageInRange у межах реального обсягу джерела, тож ризику
    // вигадування немає. Застосовуємо всі знайдені випадки одразу.
    if (kind === "citation_pages") {
      onProgress("Сторінки в цитатах (без ШІ)");
      const task = batch[0];
      let fixedCount = 0;
      for (let guard = 0; guard < 500; guard++) {
        const fix = findOutOfRangeCitationInText(text);
        if (!fix) break;
        const before = text.slice(fix.start, fix.end);
        applyDocxReplacement(map, fix.start, fix.end, fix.replacement, markEdits);
        changes.push({ label: "Сторінка в цитаті", original: before, replacement: fix.replacement });
        ({ map, plainText: text } = refreshTextMap(docXml));
        fixedCount++;
      }
      if (fixedCount === 0) {
        failed.push({ task, reason: "Не вдалося повторно знайти невалідні сторінки — можливо, документ змінився з моменту завантаження." });
      } else {
        messages.push({ type: "success", text: `Сторінки в цитатах: виправлено ${fixedCount}.` });
      }
      advance(batch.length);
      continue;
    }

    if (kind === "sources_restructure") {
      await applySourcesRestructureTask(batch[0]);
      continue;
    }

    if (kind === "adaptation") {
      await applyAdaptationTask(batch[0]);
      continue;
    }

    if (kind === "document_wide") {
      await applyDocumentWideTask(batch[0]);
      continue;
    }

    await applyOneBatch(kind, batch);
  }

  const appliedCount = toFix.length - failed.length;
  return { correctedText: text, failed, messages, changes, appliedCount };
}

/**
 * Порахувати завдання з out-of-range цитатами — та сама кодова перевірка
 * (без ШІ), що doExtract() додає до списку правок у браузері.
 * @param {string} plainText
 * @returns {object|null} завдання kind:"citation_pages" або null, якщо проблем немає
 */
export function buildCitationPagesTask(plainText) {
  const citationIssues = countOutOfRangeCitations(plainText);
  if (citationIssues <= 0) return null;
  return { id: "citation_pages", kind: "citation_pages", label: `Сторінки в цитатах поза межами джерела (${citationIssues})` };
}

/**
 * Єдина точка входу для зовнішнього адаптера (воркер CRM тощо): бере сирий
 * .docx + вільний текст зауважень + фото зауважень і повертає виправлений
 * .docx. Обгортка над усім іншим у цьому модулі — сама нічого нового не
 * рахує, лише проводить один файл через весь конвеєр правок (виявлення
 * виділень/коментарів → опційний аналіз instructions/remarkFiles → застосування
 * → серіалізація), так само як робить кнопка "Правки" в браузері.
 *
 * @param {object} input
 * @param {Buffer|ArrayBuffer} input.docxBuffer - вхідний .docx
 * @param {string} [input.fileName] - лише для summary/логів, на логіку не впливає
 * @param {string} [input.instructions] - вільний текст зауважень (аналог
 *   correctionsText у браузері) — якщо порожній і remarkFiles теж порожній,
 *   застосовуються лише автоматично знайдені виділення/коментарі Word
 * @param {Array<{b64: string, type: string}>} [input.remarkFiles] - фото
 *   зауважень (аналог correctionPhotos/PhotoDropZone), аналізуються РАЗОМ з
 *   instructions одним викликом (analyzeManualNotes)
 * @param {{lang?: string, methodInfo?: object, clientMaterialsSummary?: {rawText:string}, orderNumber?: string|number, topic?: string, type?: string, subject?: string, course?: string|number, pages?: string|number}} [input.info] -
 *   lang/methodInfo/clientMaterialsSummary впливають на самі правки (мова,
 *   вимоги методички, дані клієнта); orderNumber/topic — для тексту summary;
 *   у mode:"agent" ще type/topic/subject/course (правила агента) і pages
 *   (кодовий контроль загального обсягу)
 * @param {{callClaude: Function, costTracker?: object, onProgress?: (msg:string)=>void, io?: object}} ctx -
 *   io — { JSZip, DOMParser, XMLSerializer } для запуску поза браузером
 *   (worker/docxNodeIO.js); без io — браузерна поведінка за замовчуванням
 * @returns {Promise<{buffer: Buffer|Blob, summary: string, changes: Array, failed?: Array, messages?: Array}>}
 */
export async function runFileCorrections({ docxBuffer, fileName = "", instructions = "", remarkFiles = [], info = {}, mode = "classic", contextMode = "auto", markEdits = false }, ctx) {
  const io = ctx.io || {};
  const prepared = await prepareDocxForCorrections(docxBuffer, io);
  const { zip, docXml, plainText, annotations, revisions } = prepared;
  const revisionsMessage = describeRevisions(revisions);
  const label = info.orderNumber ? `#${info.orderNumber}` : (info.topic || fileName || "");
  const prefix = label ? `${label}: ` : "";

  // mode:"agent" — ШІ сам читає/шукає/правит документ інструментами
  // (correctionAgent.js) замість фіксованих типів завдань нижче.
  if (mode === "agent") {
    const result = await runAgentCorrections(
      {
        zip, docXml, annotations, instructions, remarkFiles, contextMode, markEdits,
        lang: info.lang, methodInfo: info.methodInfo, clientMaterialsSummary: info.clientMaterialsSummary,
        orderInfo: { type: info.type, topic: info.topic, subject: info.subject, course: info.course, pages: info.pages },
      },
      { ...ctx, io }
    );
    const changed = result.modified || prepared.revisionsAccepted;
    const buffer = changed ? await finalizeCorrectedDocx(zip, docXml, io) : docxBuffer;
    const summary = `${prefix}агент: змін ${result.appliedCount}, кроків ${result.steps}${result.failed.length ? `, потребує перевірки: ${result.failed.length}` : ""}${result.finished ? "" : " (не завершено)"}.`;
    const messages = revisionsMessage ? [revisionsMessage, ...result.messages] : result.messages;
    return { buffer, summary, changes: result.changes, failed: result.failed, messages, volume: result.volume };
  }

  const tasks = annotationsToTasks(annotations);

  const citationTask = buildCitationPagesTask(plainText);
  if (citationTask) tasks.push(citationTask);

  if (instructions.trim() || remarkFiles.length) {
    const manualTasks = await analyzeManualNotes({ docText: plainText, correctionsText: instructions, correctionPhotos: remarkFiles }, ctx);
    tasks.push(...manualTasks);
  }

  if (!tasks.length) {
    return {
      buffer: prepared.revisionsAccepted ? await finalizeCorrectedDocx(zip, docXml, io) : docxBuffer,
      summary: `${prefix}${prepared.revisionsAccepted ? "прийнято лише виправлення рецензування; " : ""}нічого виправляти — не знайдено виділень/коментарів у файлі, і не надано ні instructions, ні remarkFiles.`,
      changes: [],
      messages: revisionsMessage ? [revisionsMessage] : [],
    };
  }

  const result = await applyCorrectionTasks(
    { zip, docXml, tasks, lang: info.lang, methodInfo: info.methodInfo, clientMaterialsSummary: info.clientMaterialsSummary, markEdits },
    { ...ctx, io }
  );

  const buffer = await finalizeCorrectedDocx(zip, docXml, io);
  const summary = `${prefix}застосовано ${result.appliedCount} з ${tasks.length}${result.failed.length ? `, не вдалося: ${result.failed.length}` : ""}.`;
  const messages = revisionsMessage ? [revisionsMessage, ...result.messages] : result.messages;

  return { buffer, summary, changes: result.changes, failed: result.failed, messages };
}

/**
 * Спільна підготовка файлу до правок — для воркера й UI, в обох режимах:
 * відкрити .docx, прийняти виправлення режиму рецензування (викладач міг
 * правити через "Виправлення" — це вже готові правки; без цього його видалення
 * були невидимі, а клієнт отримував файл із неприйнятими виправленнями) і
 * витягти анотації з того самого DOM, що редагуватиметься (з посиланнями на
 * рани — для агентного режиму).
 *
 * @returns {Promise<{zip, docXml, map, plainText, annotations, revisions, revisionsAccepted: boolean}>}
 */
export async function prepareDocxForCorrections(docxBuffer, io = {}) {
  const { zip, docXml } = await openDocxForEditing(docxBuffer, io);
  const revisions = await acceptRevisionsInDocx(zip, docXml, io);
  const revisionsAccepted = revisions.inserted + revisions.deleted + revisions.formatting > 0 || revisions.trackingDisabled;
  const { map, plainText } = refreshTextMap(docXml);
  const annotations = await extractAnnotationsFromOpenDocx(zip, docXml, io);
  return { zip, docXml, map, plainText, annotations, revisions, revisionsAccepted };
}

export function describeRevisions(revisions) {
  if (!revisions) return null;
  const parts = [];
  if (revisions.inserted) parts.push(`вставок: ${revisions.inserted}`);
  if (revisions.deleted) parts.push(`видалень: ${revisions.deleted}`);
  if (revisions.formatting) parts.push(`змін оформлення: ${revisions.formatting}`);
  if (!parts.length) return null;
  return { type: "success", text: `Прийнято виправлення викладача з режиму рецензування (${parts.join(", ")}).` };
}

/**
 * Серіалізувати виправлений документ; якщо в ньому є зміст (поле TOC) —
 * попросити Word оновити поля при відкритті (заголовки й сторінки після правок
 * могли змінитися).
 */
export async function finalizeCorrectedDocx(zip, docXml, io = {}) {
  if (documentHasToc(docXml)) await setUpdateFieldsOnOpen(zip, io);
  return serializeDocx(zip, docXml, io);
}
