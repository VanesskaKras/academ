// ─────────────────────────────────────────────
// practiceStages.js — спільна, не прив'язана до React орхестраційна логіка
// звіту з практики — той самий патерн, що й orderStages.js/smallStages.js:
// кожна функція приймає (order, ctx) і повертає патч полів для збереження, без
// setState/window/alert усередині. Джерело логіки — src/PracticePage.jsx
// (React-компонент), звідки цей файл перенесений без зміни логіки промптів,
// щоб той самий потік міг виконуватись і в браузері, і в серверному воркері
// (worker/*) без React.
//
// На відміну від малих робіт, PracticePage.jsx НЕ використовує orderStages.js —
// це повністю паралельна реалізація зі своїми промптами (buildPracticePlanPrompt,
// buildPracticeWritingPrompt, buildPracticeDiaryPrompt тощо). Дві речі виправлені
// під час перенесення (не просто скопійовані):
//  - doGenKeywords/doRegenSectionSources робили сирий fetch("/api/gemini") +
//    window.dispatchEvent("apicost") — замінено на callGemini(..., {onCost}),
//    як і в orderStages.js (той самий перехід уже був зроблений раніше там).
//  - Локальна копія-дублікат fixDanglingFigures (застаріла, старша за
//    src/lib/figureFixup.js — сам файл це підтверджує коментарем) замінена на
//    імпорт спільної версії.
// Автоматичний відбір джерел (autoSelectSources/insertSourcesIntoOrder з
// orderStages.js) використано замість ручного відбору через SourcesStage.jsx —
// той самий headless-принцип, що й runTezy у smallStages.js.
//
// order — плоский стан замовлення (та ж форма, що документ Firestore, mode:"practice"):
//   info (practiceCategory/practiceType/practiceText/pages/language/topic/...,
//   те саме, що повертає getPracticeInfo() у PracticePage.jsx), methodInfo,
//   diaryTemplateInfo, structureExampleText, diaryExampleText, deptGuidanceText,
//   clientMaterials, clientMaterialsText, clientMaterialsSummary, sections,
//   content, citInputs, citStructured, citStyle, sourcesOrder, citFootnotes,
//   refList, abstractsMap, diaryContent, fileB64, fileType, clientDrawings
// ctx — { callClaude, callGemini, onProgress?(msg), onCost?, signal? }
// ─────────────────────────────────────────────
import mammoth from "mammoth";
import { MODEL_FAST } from "./api.js";
import {
  buildSYS, buildSYSTable, SYS_JSON, SYS_JSON_SHORT, STRUCTURE_READING_PROMPT,
  buildMethodologyReadingPrompt, buildStructureExampleTitlePagePrompt, isSchemaPlaceholderTitlePage,
  buildPracticePlanPrompt, buildPracticeWritingPrompt, FREEFORM_PARAGRAPH_RULES,
  buildPracticeDiaryPrompt, buildDiaryTemplateAnalysisPrompt,
  buildTemplateAnalysisPrompt, buildPracticeDetailsPrompt, getStyleProfileForSection, buildTitlePageFilePrompt,
  localPhrasesStep, localPhrasesJsonFieldBatch,
} from "./prompts.js";
import {
  parseTemplate, isEcon, isTechnical, getEconSections, hasRealFigure, extractNumericFacts,
  extractCodeFacts, extractOpeningSentences, normalizePageDistribution, stripNonContentSections,
  resolvePracticeFixedPages,
} from "./planUtils.js";
import { detectSpecialtyPrioritized } from "./academicDefaults.js";
import {
  CATEGORY_LABELS, PRACTICE_TYPES, getPracticeGuidance, detectPracticeType,
  parsePracticeDetails, buildPracticeTitlePageLines, buildPracticeDiaryTitlePageLines,
  buildPracticeTaskSheetLines, buildPracticeCalendarPlanTable, fillPracticeCalendarPlan, PRACTICE_TYPE_GENITIVE,
} from "./practiceDefaults.js";
import { enforceWordCount, enforceTotalVolume, stripEmDash } from "./wordCount.js";
import { filterSourcesWithGemini, searchByPhrase, phraseSearchOpts, getEconInstitutionalSources, generateAlternatePhrases, enrichSources } from "./sourcesSearch.js";
import { findWebsiteInText, searchCompanyWebsite, buildCompanyWebsiteSource } from "./companyWebsite.js";
import { splitDiaryCalendarGraph, parseDiaryCalendarGraphRows, parseDiaryWorkRecords } from "./exportDocx.js";
import { remapAndFormatCitations, applyCitationRemap, createReferenceDeduper, insertMissingCitations, capCitationRepeats, extractCitedNumbers, isAuthorYearCited, citationMarkerWithPage, renumberedCiteText } from "./citationFormatting.js";
import { buildContentPagePickers } from "./contentPages.js";
import { fixDanglingFigures } from "./figureFixup.js";
import { autoSelectSources, insertSourcesIntoOrder } from "./orderStages.js";
import { ensureLangProfile } from "./langProfile.js";

const DOCX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

// Gemini/Claude приймають "document"-блок лише для PDF, тож DOCX конвертуємо
// в текст через mammoth і передаємо як звичайний текстовий блок.
async function fileToContentPart(b64, mediaType) {
  if (mediaType === DOCX_MEDIA_TYPE) {
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const result = await mammoth.extractRawText(typeof Buffer !== "undefined" ? { buffer: Buffer.from(bytes) } : { arrayBuffer: bytes.buffer }); // Node-воркер: mammoth приймає лише buffer (інакше «Could not find file in options»)
    return { type: "text", text: result.value.trim() };
  }
  return { type: "document", source: { type: "base64", media_type: mediaType || "application/pdf", data: b64 } };
}

// Факти (цифри з одиницею, коди документів/журналів) для інструкції "вже зафіксовано, не
// вигадуй нове" в buildPracticeWritingPrompt. СПЕРШУ йдуть факти з ОРИГІНАЛЬНИХ матеріалів
// клієнта (rawText) — вони джерело правди; лише ПОТІМ факти з уже написаних розділів.
function buildEstablishedFacts(clientMaterialsSummary, otherSectionsText) {
  const sourceText = clientMaterialsSummary?.rawText || "";
  const sourceFacts = [...extractNumericFacts(sourceText), ...extractCodeFacts(sourceText)];
  const writtenFacts = otherSectionsText.flatMap(t => [...extractNumericFacts(t), ...extractCodeFacts(t)]);
  return [...new Set([...sourceFacts, ...writtenFacts])];
}

// Цільова к-сть джерел: явно вказана клієнтом, інакше — з обсягу звіту (як calcSourceDist у великих роботах)
function calcSourceTarget(mainSecs, info) {
  if (info.sourceCountExplicit) return info.sourceCountExplicit;
  return Math.round(Math.max(mainSecs.length * 2, parseInt(info.pages) || mainSecs.length * 3) / 2);
}
// Розподіл цільової к-сті по розділах пропорційно їхньому обсягу в сторінках
function calcSourceDist(mainSecs, total) {
  const pagesSum = mainSecs.reduce((a, s) => a + (parseInt(s.pages) || 0), 0) || 1;
  const minPerSec = Math.max(1, Math.floor(total / Math.max(mainSecs.length, 1) / 2));
  const raw = mainSecs.map(s => Math.max(minPerSec, (parseInt(s.pages) || 0) / pagesSum * total));
  const floors = raw.map(v => Math.floor(v));
  let remainder = Math.round(total) - floors.reduce((a, b) => a + b, 0);
  const order = raw
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac);
  const result = [...floors];
  for (let k = 0; k < order.length && remainder > 0; k++) { result[order[k].i] += 1; remainder--; }
  const dist = {};
  mainSecs.forEach((s, i) => { dist[s.id] = result[i]; });
  return dist;
}

const mainSecsOf = (sections) => (sections || []).filter(s => !["sources", "intro", "conclusions"].includes(s.id) && !/додат/i.test(s.label || ""));

/**
 * Аналіз методички (PDF/DOCX) + зразка структури + зразка щоденника + матеріалів
 * клієнта + шаблону замовлення → info/methodInfo/diaryTemplateInfo. Перенесено
 * з doAnalyze (PracticePage.jsx) без зміни логіки промптів.
 *
 * @param {object} order - { info, methodInfo?, fileB64?, fileType?, structureExampleText?,
 *   diaryExampleText?, diaryTemplateInfo?, clientMaterials?, clientMaterialsText? }
 * @param {object} ctx - { callClaude, callGemini, onProgress? }
 * @returns {Promise<object>} патч {info, methodInfo?, diaryTemplateInfo?,
 *   clientMaterialsSummary?, clientMaterialsText?, stage:"parsed", status:"new"}
 */
export async function runPracticeAnalyze(order, ctx) {
  const { callClaude, callGemini, onProgress } = ctx;
  const info = { ...(order.info || {}) };
  const practiceText = info.practiceText || "";

  let parsedMethodInfo = order.methodInfo || null;
  if (order.fileB64) {
    onProgress?.("Читаю методичку...");
    const docPart = await fileToContentPart(order.fileB64, order.fileType);
    try {
      onProgress?.("Читаю методичку... крок 1/2");
      const structMsgs = [docPart, { type: "text", text: STRUCTURE_READING_PROMPT }];
      const structRaw = await callGemini([{ role: "user", content: structMsgs }], ctx.signal, SYS_JSON_SHORT, 2000, null, "gemini-2.5-flash", true, { onCost: ctx.onCost });
      const structMatch = structRaw.match(/\{[\s\S]*\}/);
      let structureInfo = null;
      try { structureInfo = structMatch ? JSON.parse(structMatch[0]) : null; } catch { /* фолбек нижче */ }

      onProgress?.("Читаю методичку... крок 2/2");
      const methodMsgs = [docPart, { type: "text", text: buildMethodologyReadingPrompt(structureInfo, true, practiceText) }];
      const raw = await callGemini([{ role: "user", content: methodMsgs }], ctx.signal, SYS_JSON_SHORT, 10000, (s) => onProgress?.(`Читаю методичку... зачекайте ${s}с`), "gemini-2.5-flash", true, { onCost: ctx.onCost });
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      parsedMethodInfo = JSON.parse(jsonMatch?.[0] || raw.replace(/```json|```/g, "").trim());
      if (structureInfo) {
        if (structureInfo.chaptersCount != null) parsedMethodInfo.chaptersCount = structureInfo.chaptersCount;
        if (structureInfo.totalPages != null) parsedMethodInfo.totalPages = structureInfo.totalPages;
      }
      if (isSchemaPlaceholderTitlePage(parsedMethodInfo.titlePageTemplate)) {
        parsedMethodInfo.titlePageTemplate = null;
      }
    } catch (e) {
      console.warn("methodInfo failed:", e.message);
    }
  }

  // Окремий файл «Титульна сторінка» з CRM — пріоритет над титулкою з методички/зразка
  if (order.titlePageB64) {
    onProgress?.("Читаю зразок титульної сторінки...");
    try {
      const tpPart = await fileToContentPart(order.titlePageB64, order.titlePageType);
      const tpRaw = await callGemini([{ role: "user", content: [tpPart, { type: "text", text: buildTitlePageFilePrompt() }] }], ctx.signal, SYS_JSON_SHORT, 2500, null, undefined, undefined, { onCost: ctx.onCost });
      const tpMatch = tpRaw.match(/\{[\s\S]*\}/);
      const tpParsed = tpMatch ? JSON.parse(tpMatch[0]) : null;
      if (tpParsed?.titlePageTemplate?.length) parsedMethodInfo = { ...(parsedMethodInfo || {}), titlePageTemplate: tpParsed.titlePageTemplate };
    } catch (e) {
      console.warn("title page file failed:", e.message);
    }
  }

  if (order.structureExampleText && !parsedMethodInfo?.titlePageTemplate?.length) {
    onProgress?.("Шукаю титулку в зразку структури...");
    try {
      const tpRaw = await callClaude([{ role: "user", content: buildStructureExampleTitlePagePrompt(order.structureExampleText) }], ctx.signal, SYS_JSON_SHORT, 1500, null, MODEL_FAST, { onCost: ctx.onCost });
      const tpMatch = tpRaw.match(/\{[\s\S]*\}/);
      const tpParsed = tpMatch ? JSON.parse(tpMatch[0]) : null;
      if (tpParsed?.titlePageTemplate?.length) {
        parsedMethodInfo = { ...(parsedMethodInfo || {}), titlePageTemplate: tpParsed.titlePageTemplate };
      }
    } catch (e) {
      console.warn("structure example title page failed:", e.message);
    }
  }

  let parsedDiaryTemplateInfo = order.diaryTemplateInfo || null;
  if (order.diaryExampleText) {
    onProgress?.("Аналізую зразок щоденника...");
    try {
      const dtRaw = await callClaude([{ role: "user", content: buildDiaryTemplateAnalysisPrompt(order.diaryExampleText) }], ctx.signal, SYS_JSON_SHORT, 1500, null, MODEL_FAST, { onCost: ctx.onCost });
      const dtMatch = dtRaw.match(/\{[\s\S]*\}/);
      parsedDiaryTemplateInfo = dtMatch ? JSON.parse(dtMatch[0]) : null;
    } catch (e) {
      console.warn("diary template analysis failed:", e.message);
    }
  }

  const combinedText = [
    ...(order.clientMaterials || []).map(m => `=== ${m.name} ===\n${m.text}`),
    order.clientMaterialsText?.trim() || "",
  ].filter(Boolean).join("\n\n");

  let summary = null;
  if (combinedText.trim()) summary = { rawText: combinedText };

  onProgress?.("Аналізую шаблон замовлення...");
  let tpl = parseTemplate(practiceText);
  try {
    const tplRaw = await callClaude([{ role: "user", content: buildTemplateAnalysisPrompt(practiceText, combinedText) }], ctx.signal, SYS_JSON, 1000, null, MODEL_FAST, { onCost: ctx.onCost });
    const tplParsed = JSON.parse(tplRaw.match(/\{[\s\S]*\}/)?.[0] || "{}");
    tpl = { ...tpl, ...Object.fromEntries(Object.entries(tplParsed).filter(([, v]) => v != null && v !== "")) };
  } catch (e) {
    console.warn("template analysis fallback to regex:", e.message);
  }

  if (tpl.pages) info.pages = String(tpl.pages);
  if (tpl.language) info.language = tpl.language;
  if (tpl.topic) info.topic = tpl.topic;
  if (tpl.orderNumber) info.orderNumber = tpl.orderNumber;
  if (tpl.type) info.orderType = tpl.type;
  if (tpl.deadline) info.deadline = tpl.deadline;
  if (tpl.direction) info.direction = tpl.direction;
  if (tpl.subject) info.subject = tpl.subject;
  if (tpl.uniqueness) info.uniqueness = tpl.uniqueness;
  if (tpl.course) info.course = String(tpl.course);
  if (tpl.extras) info.extras = tpl.extras;
  // Мова поза таблицею — ШІ один раз складає для неї набір підписів (langProfile.js)
  const langProfile = await ensureLangProfile(info, callClaude, { signal: ctx.signal, onCost: ctx.onCost });
  if (langProfile) info.langProfile = langProfile;

  // Напрям/вид практики — headless-режим завжди автовизначає (немає "ручного" вибору
  // користувачем перед запуском аналізу, на відміну від браузера), якщо тільки
  // виклик заздалегідь не проставив конкретне значення в order.info.
  const detected = detectSpecialtyPrioritized(
    `${tpl.direction || ""} ${tpl.subject || ""} ${tpl.topic || ""}`,
    `${practiceText} ${combinedText}`
  );
  if (detected && CATEGORY_LABELS[detected]) info.practiceCategory = detected;

  const validPracticeTypes = PRACTICE_TYPES.map(t => t.key);
  const suggestedType = validPracticeTypes.includes(tpl.practiceType)
    ? tpl.practiceType
    : validPracticeTypes.includes(parsedMethodInfo?.practiceType)
    ? parsedMethodInfo.practiceType
    : detectPracticeType(tpl.course, info.degreeLevel, tpl.type, tpl.topic, tpl.subject, practiceText, combinedText);
  if (suggestedType) info.practiceType = suggestedType;
  info.practiceGuidance = getPracticeGuidance(info.practiceCategory, info.practiceType);

  onProgress?.("Витягую деталі практики...");
  let details = parsePracticeDetails(`${practiceText}\n${combinedText}`);
  try {
    const detRaw = await callClaude([{ role: "user", content: buildPracticeDetailsPrompt(practiceText, combinedText) }], ctx.signal, SYS_JSON, 500, null, MODEL_FAST, { onCost: ctx.onCost });
    const detParsed = JSON.parse(detRaw.match(/\{[\s\S]*\}/)?.[0] || "{}");
    details = { ...details, ...Object.fromEntries(Object.entries(detParsed).filter(([, v]) => v != null && v !== "")) };
  } catch (e) {
    console.warn("practice details fallback to regex:", e.message);
  }
  if (parsedMethodInfo) {
    const methodFallback = {
      companyName: parsedMethodInfo.practiceCompanyName,
      supervisorCompany: parsedMethodInfo.practiceSupervisorCompany,
      supervisorUniversity: parsedMethodInfo.practiceSupervisorUniversity,
      dateStart: parsedMethodInfo.practiceDateStart,
      dateEnd: parsedMethodInfo.practiceDateEnd,
      university: parsedMethodInfo.practiceUniversity,
      faculty: parsedMethodInfo.practiceFaculty,
      department: parsedMethodInfo.practiceDepartment,
      specialty: parsedMethodInfo.practiceSpecialty,
      degreeLevel: parsedMethodInfo.practiceDegreeLevel,
      knowledgeField: parsedMethodInfo.practiceKnowledgeField,
      city: parsedMethodInfo.practiceCity,
    };
    Object.entries(methodFallback).forEach(([k, v]) => { if (!details[k] && v) details[k] = v; });
  }
  const fields = ["companyName", "supervisorCompany", "supervisorUniversity", "individualTask", "dateStart", "dateEnd",
    "studentName", "studentGroup", "university", "faculty", "department", "specialty", "degreeLevel", "knowledgeField", "city"];
  fields.forEach(k => { if (!info[k] && details[k]) info[k] = details[k]; });
  if (!info.sourceCountExplicit && details.sourceCount) {
    const nums = String(details.sourceCount).match(/\d+/g);
    if (nums) info.sourceCountExplicit = Math.round(nums.reduce((a, b) => a + parseInt(b), 0) / nums.length);
  }

  return {
    info,
    methodInfo: parsedMethodInfo || null,
    diaryTemplateInfo: parsedDiaryTemplateInfo || null,
    clientMaterialsSummary: summary || null,
    clientMaterialsText: order.clientMaterialsText?.trim() || null,
    stage: "parsed", status: "new",
  };
}

/**
 * Генерує структуру звіту з практики (розділи + сторінки), з фіксованим
 * обсягом вступу/висновків та нормалізацією розподілу сторінок під заданий
 * обсяг. Перенесено з doGenPlan без зміни логіки.
 *
 * @param {object} order - { info, methodInfo?, structureExampleText?, deptGuidanceText? }
 * @param {object} ctx - { callClaude, onProgress? }
 * @returns {Promise<object>} патч {info, sections, stage:"plan", status:"new"}
 */
export async function runPracticePlan(order, ctx) {
  const { callClaude, onProgress } = ctx;
  const info = order.info || {};
  onProgress?.("Генерую структуру звіту...");
  const prompt = buildPracticePlanPrompt(info, order.methodInfo, order.structureExampleText, order.deptGuidanceText);
  const raw = await callClaude([{ role: "user", content: prompt }], ctx.signal, "Respond only with valid JSON. No markdown.", 4000, null, MODEL_FAST, { onCost: ctx.onCost });
  const parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || raw);
  if (parsed.sections?.length) parsed.sections = stripNonContentSections(parsed.sections);
  if (parsed.sections?.length) {
    const { introPages, conclPages } = resolvePracticeFixedPages(info.practiceText, order.deptGuidanceText);
    parsed.sections = parsed.sections.map(s =>
      s.id === "intro" ? { ...s, pages: introPages } : s.id === "conclusions" ? { ...s, pages: conclPages } : s
    );
    const target = parseInt(info.pages) || 30;
    const hasIntroSec = parsed.sections.some(s => s.id === "intro");
    const hasConclSec = parsed.sections.some(s => s.id === "conclusions");
    const fixedPages = (hasIntroSec ? introPages : 0) + (hasConclSec ? conclPages : 0);
    const adjustable = parsed.sections.filter(s => !["sources", "intro", "conclusions"].includes(s.id));
    const normPages = normalizePageDistribution(adjustable.map(s => s.pages), target - fixedPages, 2);
    let ni = 0;
    parsed.sections = parsed.sections.map(s =>
      ["sources", "intro", "conclusions"].includes(s.id) ? s : { ...s, pages: normPages[ni++] }
    );
  }
  return { info, sections: parsed.sections, stage: "plan", status: "new" };
}

// ── Пошук + каскад добору при нестачі для ОДНОГО розділу — перенесено з
// doSearchSources без зміни логіки (мінус проміжні setState для live-прогресу
// UI — тут повертається лише фінальний результат, як і runSourcesStage у
// orderStages.js). institutionalGroup/companyWebsiteGroup — готові групи,
// додані ПЕРЕД пошуком (не з ШІ) — рахуються викликачем один раз для першого проходу. ──
async function searchSectionSources(secId, sectionLabel, thesesData, enPhrases, seedGroups, info, isTechnicalWork, needed, ctx, localPhrases = []) {
  const topicCtx = [info?.topic, info?.direction, info?.subject].filter(Boolean).join(" ");
  // Звіт неукраїнською — пошук ще й мовою звіту і зарубіжні кандидати впереміш (як у orderStages.js)
  const searchOpts = (i) => phraseSearchOpts(info?.language, localPhrases, i);
  const globalSeen = new Set();
  const updatedGroups = [...seedGroups];
  const filterLabel = sectionLabel.replace(/^РОЗДІЛ\s+[IVXivxІVХ\d]+[.\s:]+/i, "").trim() || sectionLabel;
  // Пул кандидатів, що пройшли Прохід А, але не Прохід Б («адвокат диявола») — для звіту
  // з практики теми часто прив'язані до конкретного підприємства, і адверсаріальна
  // перевірка «спробуй спростувати» відсіює майже все навіть коли по суті все гаразд
  // (кейс 41524: 0-2 з підрозділу після Проходу Б при 6-9 на Проході А). Пул — резерв
  // на випадок, якщо звичайний добір (роки/альтернативні фрази) все одно не дотягне до needed.
  const passAOnlyPool = [];
  const poolKey = (p) => (p.title || "").toLowerCase().slice(0, 60);

  const normalizedTheses = Array.isArray(thesesData) && thesesData.length > 0 && typeof thesesData[0] === "string"
    ? [{ thesis: "", phrases: thesesData }]
    : [...(thesesData || [])];
  const nextEnPhrase = (i) => enPhrases.length ? enPhrases[i % enPhrases.length] : "";

  for (const { thesis, phrases } of normalizedTheses) {
    for (let pi = 0; pi < (phrases || []).length; pi++) {
      const phrase = phrases[pi];
      const useScholar = pi === 0 || isTechnicalWork;
      const candidates = await searchByPhrase(phrase, 10, 1, useScholar, 0, nextEnPhrase(pi), searchOpts(pi));
      const fresh = candidates.filter(p => {
        const key = (p.title || "").toLowerCase().slice(0, 60);
        return key && !globalSeen.has(key);
      });
      if (!fresh.length) continue;
      const { passB, passA } = await filterSourcesWithGemini(fresh.slice(0, 20), filterLabel, topicCtx, 20, thesis, ctx.onCost, { returnPassA: true });
      const top15tagged = thesis ? passB.map(p => ({ ...p, sourceThesis: thesis })) : passB;
      const top15 = await enrichSources(top15tagged);
      top15.forEach(p => globalSeen.add((p.title || "").toLowerCase().slice(0, 60)));
      const existingIdx = updatedGroups.findIndex(g => g.phrase === phrase);
      if (existingIdx >= 0) updatedGroups[existingIdx] = { phrase, papers: [...updatedGroups[existingIdx].papers, ...top15] };
      else updatedGroups.push({ phrase, papers: top15 });
      passA.filter(p => (p.geminiScore ?? 0) >= 80 && !passB.includes(p))
        .forEach(p => passAOnlyPool.push(thesis ? { ...p, sourceThesis: thesis } : p));
    }
  }

  const isGood = (p) => (p.geminiScore ?? 0) >= 70 && p._complete !== false;
  const countGood = () => updatedGroups.flatMap(g => g.papers).filter(isGood).length;
  const countForThesis = (t) => updatedGroups.flatMap(g => g.papers).filter(p => p.sourceThesis === t && isGood(p)).length;
  const allTriedPhrases = normalizedTheses.flatMap(t => t.phrases || []);

  const backfillPhrase = async (phrase, extraYears, enPhrase = "", thesisText = "", opts = {}) => {
    const candidates = await searchByPhrase(phrase, 10, 1, true, extraYears, enPhrase, opts);
    const fresh = candidates.filter(p => {
      const key = (p.title || "").toLowerCase().slice(0, 60);
      return key && !globalSeen.has(key);
    });
    if (!fresh.length) return;
    const { passB: filteredRaw, passA } = await filterSourcesWithGemini(fresh.slice(0, 20), filterLabel, topicCtx, 20, thesisText, ctx.onCost, { returnPassA: true });
    const filteredTagged = thesisText ? filteredRaw.map(p => ({ ...p, sourceThesis: thesisText })) : filteredRaw;
    const filtered = await enrichSources(filteredTagged);
    filtered.forEach(p => globalSeen.add((p.title || "").toLowerCase().slice(0, 60)));
    const existingIdx = updatedGroups.findIndex(g => g.phrase === phrase);
    if (existingIdx >= 0) updatedGroups[existingIdx] = { phrase, papers: [...updatedGroups[existingIdx].papers, ...filtered] };
    else updatedGroups.push({ phrase, papers: filtered });
    passA.filter(p => (p.geminiScore ?? 0) >= 80 && !filteredRaw.includes(p))
      .forEach(p => passAOnlyPool.push(thesisText ? { ...p, sourceThesis: thesisText } : p));
  };

  const uncoveredTheses = normalizedTheses.filter(t => t.thesis && countForThesis(t.thesis) === 0);
  for (const t of uncoveredTheses) {
    if (countForThesis(t.thesis) > 0) continue;
    for (let i = 0; i < (t.phrases || []).length; i++) {
      if (countForThesis(t.thesis) > 0) break;
      await backfillPhrase(t.phrases[i], 2, nextEnPhrase(i), t.thesis, searchOpts(i));
    }
  }
  for (const extraYears of [2, 3]) {
    if (countGood() >= needed) break;
    for (let i = 0; i < allTriedPhrases.length; i++) {
      if (countGood() >= needed) break;
      await backfillPhrase(allTriedPhrases[i], extraYears, nextEnPhrase(i), "", searchOpts(i));
    }
  }
  if (countGood() < needed && allTriedPhrases.length) {
    const altPhrases = await generateAlternatePhrases(topicCtx, filterLabel, allTriedPhrases);
    for (let i = 0; i < altPhrases.length; i++) {
      if (countGood() >= needed) break;
      await backfillPhrase(altPhrases[i], 3, nextEnPhrase(i), "", searchOpts(i));
    }
  }

  // М'який фолбек: звичайний добір (роки + альтернативні фрази) все одно не дотягнув до
  // needed — добираємо з пулу Проходу А (score ≥ 80, не пройшли Прохід Б), по спаданню score.
  // Позначаємо _softFallback, щоб було видно в SourcesStage.jsx/QA, що адверсаріальну
  // перевірку джерело не пройшло.
  if (countGood() < needed && passAOnlyPool.length) {
    const seenPool = new Set();
    const dedupedPool = passAOnlyPool.filter(p => {
      const key = poolKey(p);
      if (!key || seenPool.has(key) || globalSeen.has(key)) return false;
      seenPool.add(key);
      return true;
    }).sort((a, b) => (b.geminiScore ?? 0) - (a.geminiScore ?? 0));
    const shortfall = needed - countGood();
    const picked = dedupedPool.slice(0, shortfall);
    if (picked.length) {
      const enriched = await enrichSources(picked.map(p => ({ ...p, _softFallback: true })));
      enriched.forEach(p => globalSeen.add(poolKey(p)));
      console.log(`[searchSectionSources:${sectionLabel}] м'який фолбек: взято з Проходу А ${enriched.length} (score≥80, needed=${needed})`);
      updatedGroups.push({ phrase: "Резервний відбір (Прохід А, score≥80)", papers: enriched });
    }
  }

  return updatedGroups;
}

/**
 * Ключові слова + пошук + автоматичний відбір джерел для ВСІХ розділів звіту.
 * Перенесено з doGenKeywords+doSearchSources (PracticePage.jsx), з двома
 * відмінностями від оригіналу: 1) сирий fetch("/api/gemini") замінено на
 * callGemini (headless-сумісно); 2) замість ручного відбору користувачем через
 * SourcesStage.jsx (suggestedSources → клік → citInputs) — автоматичний відбір
 * через autoSelectSources/insertSourcesIntoOrder (orderStages.js), як і для
 * реферату/тез у smallStages.js.
 *
 * @param {object} order - { info, sections, content?, citInputs?, citStructured?,
 *   abstractsMap?, companyName? }
 * @param {object} ctx - { callGemini, onProgress? }
 * @returns {Promise<object>} патч {keywords, enKeywords, citInputs, citStructured, abstractsMap}
 */
export async function runPracticeSources(order, ctx) {
  const { callGemini, onProgress } = ctx;
  const info = order.info || {};
  const mainSecs = mainSecsOf(order.sections);
  if (!mainSecs.length) return { keywords: {}, enKeywords: {} };

  const labelToId = {};
  for (const s of mainSecs) {
    labelToId[s.id] = s.id;
    const m = s.label.match(/^(\d+(?:\.\d+)*)/);
    if (m) labelToId[m[1]] = s.id;
  }
  const normalizeKey = (k) => labelToId[k] || k.match(/^(\d+\.\d+)/)?.[1] || k;
  const sourceTarget = calcSourceTarget(mainSecs, info);
  const sourceDist = calcSourceDist(mainSecs, sourceTarget);

  const BATCH_SIZE = 8;
  const snippetLen = mainSecs.length > 10 ? 600 : 1200;
  const content = order.content || {};
  const allThesesNorm = {};
  const allEnNorm = {};
  const allLocalNorm = {};

  onProgress?.("Генерую ключові слова для пошуку джерел...");
  for (let bStart = 0; bStart < mainSecs.length; bStart += BATCH_SIZE) {
    const batch = mainSecs.slice(bStart, bStart + BATCH_SIZE);
    const secBlocks = batch.map(s => {
      const txt = content[s.id]
        ? `\n${content[s.id].substring(0, snippetLen).replace(/["\\]/g, " ").replace(/\n+/g, " ")}`
        : "";
      return `### [${s.id}] ${s.label} (потрібно ${sourceDist[s.id] || 3} джерела)${txt}`;
    }).join("\n\n");

    // Назва підприємства («ТОВ РГ "Bagira"») і структурні розділи звіту («виконані завдання», «індивідуальне
    // завдання») — не наукові теми: Scholar по них порожній, фільтр бракує все (кейс 41506: 4 джерела з 5).
    // Шукаємо по ПРЕДМЕТНІЙ ОБЛАСТІ (галузь, вид діяльності, методи), без назви бази практики.
    const fieldHint = [info?.direction, info?.subject].filter(Boolean).join(", ");
    const prompt = `Ти допомагаєш знайти наукові джерела для звіту з практики на тему "${info?.topic}".${fieldHint ? `\nГалузь/предмет: ${fieldHint}.` : ""}

ПРАВИЛА ДЛЯ ЗВІТУ З ПРАКТИКИ (важливо):
- НЕ вживай у тезах і фразах назву підприємства/організації (ТОВ, ПП, агенція «…», ФОП тощо) — наукових публікацій про конкретну фірму немає. Замість цього — галузь і вид діяльності (напр. «рекламна агенція» → «рекламна діяльність», «маркетингові комунікації», «управління рекламним агентством»).
- Розділи про хід практики (характеристика бази, виконані завдання, індивідуальне завдання, щоденник) підкріплюй джерелами про ТЕОРІЮ й МЕТОДИ відповідної діяльності (організація роботи, аналіз ринку, інструменти), а не про сам процес проходження практики.
- Фрази — загальнонаукові, такі, що реально зустрічаються в назвах статей і підручників.

ЗАВДАННЯ — для кожного розділу:

КРОК 1. Визнач 4–5 конкретних тез — повних змістовних тверджень про те, що саме доводитиметься у цьому розділі: який об'єкт/група/явище, в якому аспекті, в якому контексті (країна, період, галузь). Не назва розділу і не загальна категорія, а конкретне твердження (7–14 слів).
Приклад: тема "Дистанційна зайнятість в ІТ" → теза "вплив дистанційної роботи на продуктивність працівників ІТ-компаній України", а НЕ просто "дистанційна робота" чи "продуктивність праці".

КРОК 2. Для кожної тези склади 3 пошукові фрази українською:
- 2 КОНКРЕТНІ = [1–2 ключових слова з ТЕМИ роботи] + [конкретний аспект тези] — як точний прицільний пошук.
- 1 ШИРША — РІВНО ДВА ключових поняття із загального предмета тези, не більше (не три і не чотири) — без вузьких власних назв, конкретних імен чи вузькоспеціальних термінів. Що менше понять — то ширше знаходить пошук: перевірено, що фраза з двох понять "філософія та естетика романтизму" знаходить у десятки разів більше, ніж фраза з трьох понять "символізм надприродного в романтизмі" про той самий предмет. Тому: обери два НАЙЗАГАЛЬНІШІ поняття з теми й тези, відкинь решту деталізації.
ВАЖЛИВО: конкретні фрази мають містити точний предмет теми; широка фраза — той самий загальний контекст без надмірної деталізації, не втрачаючи зв'язку з темою.

КРОК 3. Додай 3 пошукові фрази АНГЛІЙСЬКОЮ для розділу загалом (academic English, ширші за тезу) —
для пошуку в міжнародних англомовних базах.${localPhrasesStep(info?.language, "розділу")}

РОЗДІЛИ:
${secBlocks}

Поверни валідний JSON з полями:
- "theses": об'єкт, ключ = ідентифікатор розділу з квадратних дужок ("1.1", "1.2", "3" тощо), значення = масив об'єктів {"thesis": рядок, "phrases": масив рядків}
- "enPhrases": об'єкт, ключ = ідентифікатор розділу з квадратних дужок, значення = масив з 3 англомовних фраз (рядки)${localPhrasesJsonFieldBatch(info?.language, "розділу")}`;

    const raw = await callGemini([{ role: "user", content: prompt }], ctx.signal, "Respond only with valid JSON. No markdown.", 8192, null, "gemini-2.5-flash-lite", true, { onCost: ctx.onCost });
    const parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || raw);
    const thesesRaw = parsed.theses || {};
    const enPhrasesRaw = parsed.enPhrases || {};
    for (const [k, v] of Object.entries(parsed.localPhrases || {})) {
      allLocalNorm[normalizeKey(k)] = Array.isArray(v) ? v.map(String).filter(Boolean) : [];
    }

    for (const [k, arr] of Object.entries(thesesRaw)) {
      allThesesNorm[normalizeKey(k)] = (Array.isArray(arr) ? arr : []).map(t => ({
        thesis: String(t.thesis || "").trim(),
        phrases: (Array.isArray(t.phrases) ? t.phrases : []).map(String).filter(Boolean),
      })).filter(t => t.phrases.length > 0);
    }
    for (const [k, v] of Object.entries(enPhrasesRaw)) {
      allEnNorm[normalizeKey(k)] = Array.isArray(v) ? v.map(String).filter(Boolean) : [];
    }
  }

  const kwNorm = Object.fromEntries(Object.entries(allThesesNorm).map(([k, theses]) => [k, theses.flatMap(t => t.phrases)]));

  const isTechnicalWork = isTechnical(info);
  const isEconSecForSources = isEcon(info);
  const econSecIds = getEconSections(mainSecs, info);
  let citInputs = order.citInputs || {};
  let citStructured = order.citStructured || {};
  let abstractsMap = order.abstractsMap || {};

  for (const sec of mainSecs) {
    const normalKey = normalizeKey(sec.id);
    const thesesData = allThesesNorm[normalKey] || allThesesNorm[sec.id] || [];
    if (!thesesData.length && !econSecIds.includes(sec.id)) continue;

    onProgress?.(`Шукаю джерела: ${sec.label}...`);
    const isFirstMainSection = sec.id === mainSecs[0].id;
    const institutionalGroup = (isEconSecForSources && econSecIds.includes(sec.id))
      ? [{ phrase: "Офіційна статистика", papers: getEconInstitutionalSources() }]
      : [];
    let companyWebsiteGroup = [];
    if (isFirstMainSection && info.companyName?.trim()) {
      const website = findWebsiteInText(order.clientMaterialsSummary?.rawText || order.clientMaterialsText)
        || await searchCompanyWebsite(info.companyName);
      if (website) companyWebsiteGroup = [{ phrase: "Офіційний сайт підприємства", papers: [buildCompanyWebsiteSource(website, info.companyName)] }];
    }

    const groups = await searchSectionSources(
      sec.id, sec.label || "", thesesData, allEnNorm[normalKey] || [],
      [...institutionalGroup, ...companyWebsiteGroup], info, isTechnicalWork,
      sourceDist[sec.id] || 3, ctx, allLocalNorm[normalKey] || [],
    );

    const needed = sourceDist[sec.id] || 4;
    const top = autoSelectSources(groups, needed, isTechnicalWork, info?.language);
    const inserted = await insertSourcesIntoOrder(
      { info, citInputs, citStructured, abstractsMap, sourceDist },
      sec.id, top, { capForeign: true },
    );
    citInputs = inserted.citInputs;
    citStructured = inserted.citStructured;
    abstractsMap = inserted.abstractsMap;
  }

  return { keywords: kwNorm, enKeywords: allEnNorm, citInputs, citStructured, abstractsMap, sourceTarget, sourceDist };
}

/**
 * Генерує ОДИН розділ звіту з практики. Викликач має проганяти секції
 * послідовно (не паралельно) — кожна наступна отримує в контексті вже
 * написані попередні (антиповторення відкриттів/таблиць), як і doWrite.
 * Перенесено без зміни логіки промптів.
 *
 * @param {object} order - { info, methodInfo?, sections, content, citInputs?,
 *   abstractsMap?, clientMaterialsSummary?, deptGuidanceText? }
 * @param {object} sec - розділ зі order.sections, який генеруємо
 * @param {object} ctx - { callClaude, onProgress? }
 * @returns {Promise<object>} патч {content} — з оновленим текстом для sec.id
 */
export async function runPracticeWriteSection(order, sec, ctx) {
  const { callClaude, onProgress } = ctx;
  const info = order.info || {};
  const methodInfo = order.methodInfo;
  const content = order.content || {};
  const writableSecs = (order.sections || []).filter(s => s.id !== "sources");
  const idx = writableSecs.findIndex(s => s.id === sec.id);

  onProgress?.(`Генерую: ${sec.label}...`);
  const establishedFacts = buildEstablishedFacts(
    order.clientMaterialsSummary,
    writableSecs.filter(s => s.id !== sec.id && content[s.id]).map(s => content[s.id]),
  );
  let instruction = buildPracticeWritingPrompt(sec, info, methodInfo, order.clientMaterialsSummary, order.citInputs, order.abstractsMap, establishedFacts, order.deptGuidanceText);

  const priorSecs = idx > 0 ? writableSecs.slice(0, idx).filter(s => content[s.id]) : [];
  if (priorSecs.length) {
    instruction += `\n\nУЖЕ НАПИСАНІ ПОЧАТКИ ПОПЕРЕДНІХ РОЗДІЛІВ ЦІЄЇ Ж РОБОТИ (не повторюй ні структуру речень, ні перше слово, ні порядок "теза-приклад-висновок" — обери інший стиль відкриття й інший ритм):\n${priorSecs.map((s, i) => `${i + 1}. ${extractOpeningSentences(content[s.id])}`).join("\n")}`;
  }

  const priorTableSecs = priorSecs.filter(s => /\|[^\n|]+\|[^\n|]+\|/.test(content[s.id] || ""));
  if (priorTableSecs.length) {
    instruction += `\n\nПОПЕРЕДНІ РОЗДІЛИ ВЖЕ МІСТЯТЬ ТАБЛИЦЮ З ПОКАЗНИКАМИ (${priorTableSecs.map(s => `"${s.label}"`).join(", ")}) — у цьому розділі НЕ вставляй ту саму або майже ту саму таблицю з тими самими рядками показників повторно. Якщо тут теж природно потрібна таблиця — заповни її ІНШИМИ показниками, що стосуються саме теми цього розділу (не дублюй попередню), або згадай уже наведені дані текстом без повторного відтворення таблиці.`;
  }

  if (methodInfo?.requiredFigures?.length) {
    const currentChapNum = sec.id.split(".")[0];
    const chapterSecs = writableSecs.filter(s => s.id !== "intro" && s.id !== "conclusions" && s.id.split(".")[0] === currentChapNum);
    const isLastInChapter = chapterSecs[chapterSecs.length - 1]?.id === sec.id;
    const hasFigureAlready = chapterSecs.some(s => s.id !== sec.id && hasRealFigure(content[s.id] || ""));
    if (!hasFigureAlready) {
      instruction += isLastInChapter
        ? `\n\nОБОВ'ЯЗКОВО: жоден інший підрозділ цього розділу ще не містить рисунка/схеми — цей підрозділ МАЄ містити хоча б один рисунок (PlantUML-схема за правилами FIGURES вище, або графік із таблиці даних), інакше вимога методички щодо схем буде порушена. Методичка явно вимагає: ${methodInfo.requiredFigures.join("; ")}.`
        : `\n\nЯкщо зміст цього підрозділу природно ілюструється рисунком чи схемою (PlantUML за правилами FIGURES вище, або графік із таблиці даних) — додай його саме тут, одразу біля відповідного тексту: це краще, ніж відкладати рисунок у кінець розділу. Методичка вимагає: ${methodInfo.requiredFigures.join("; ")}.`;
    }
  }

  const lang = info.language || "Українська";
  const isTableSec = methodInfo?.reportFormat === "table_questionnaire" && sec.id !== "intro" && sec.id !== "conclusions";
  const isFreeformMain = sec.id === "main" && !sec.sectionTitle;
  const sysPrompt = isTableSec ? buildSYSTable(lang, methodInfo) : buildSYS(lang, methodInfo, null, getStyleProfileForSection(sec));

  const maxTok = Math.min(30000, Math.max(6000, Math.round((sec.pages || 1) * 1800)));
  const raw = stripEmDash(await callClaude([{ role: "user", content: instruction }], ctx.signal, sysPrompt, maxTok, null, undefined, { onCost: ctx.onCost }));
  let text = isTableSec ? raw : await enforceWordCount({
    text: raw, targetWords: Math.round((sec.pages || 1) * 230), label: sec.label,
    callClaude, sys: sysPrompt, signal: ctx.signal, onProgress, clean: stripEmDash,
    styleNote: isFreeformMain ? FREEFORM_PARAGRAPH_RULES : undefined,
    cacheOpts: { onCost: ctx.onCost },
  });
  if (!text || !text.trim()) throw new Error(`Порожня відповідь для секції "${sec.label}" — спробуйте ще раз.`);

  const localSourceLines = (order.citInputs?.[sec.id] || "").split("\n").map(l => l.trim()).filter(Boolean);
  if (localSourceLines.length) {
    const citedLocalNums = new Set(extractCitedNumbers(text));
    const missingLocal = localSourceLines
      .map((line, i) => ({ number: i + 1, marker: `[${i + 1}]`, sourceText: line, abstract: order.abstractsMap?.[line] }))
      .filter(s => !citedLocalNums.has(s.number));
    if (missingLocal.length) {
      try {
        const { text: fixed } = await insertMissingCitations({ sectionText: text, insertions: missingLocal, lang, callClaude, signal: ctx.signal });
        text = fixed;
      } catch (e) { console.error("insertMissingSectionCitations error:", e.message); }
    }
  }
  text = capCitationRepeats(text);

  return { content: { ...content, [sec.id]: text } };
}

/**
 * Список літератури: дедуплікація, форматування за стилем, перенумерація [N]
 * у тексті всіх розділів, довставка "осиротілих" джерел, перевірка рисунків і
 * сумарного обсягу. Перенесено з doFinalizeSources без зміни логіки.
 *
 * @param {object} order - { info, sections, content, citInputs, citStructured,
 *   methodInfo?, citStyle?, sourcesOrder?, citFootnotes? }
 * @param {object} ctx - { callClaude, onProgress? }
 * @returns {Promise<object>} патч {content, refList, stage/status не змінюються}
 */
export async function runPracticeFinalizeSources(order, ctx) {
  const { callClaude, onProgress } = ctx;
  const info = order.info || {};
  const methodInfo = order.methodInfo;
  const sections = order.sections || [];
  const mainSecs = sections.filter(s => s.id !== "sources");
  const citInputs = order.citInputs || {};
  const citStructured = order.citStructured || {};
  onProgress?.("Формую список літератури...");

  const secLocalSources = {};
  mainSecs.forEach(sec => {
    const lines = (citInputs[sec.id] || "").split("\n").map(l => l.trim()).filter(Boolean);
    secLocalSources[sec.id] = {};
    lines.forEach((line, i) => { secLocalSources[sec.id][i + 1] = line; });
  });

  const deduper = createReferenceDeduper();
  mainSecs.forEach(sec => {
    Object.values(secLocalSources[sec.id]).forEach(text => { deduper.add(text); });
  });
  const rawRefs = deduper.canonicalRefs;
  if (!rawRefs.length) return {};

  const flatStructured = mainSecs.flatMap(sec => citStructured[sec.id] || []);
  const effStyle = order.citStyle || methodInfo?.sourcesStyle
    || (/APA/i.test(`${methodInfo?.otherRequirements || ""} ${methodInfo?.citationStyle || ""}`) ? "APA"
      : /MLA/i.test(`${methodInfo?.otherRequirements || ""} ${methodInfo?.citationStyle || ""}`) ? "MLA" : "ДСТУ 8302:2015");
  const effSourcesOrder = order.sourcesOrder || methodInfo?.sourcesOrder || "alphabetical";

  let { refList: fmtList, oldToNew, refCiteText, pageRanges, pageAbbrev, pdfUrls } = await remapAndFormatCitations({
    citations: rawRefs, citStructured: flatStructured, citStyle: effStyle, language: info.language,
    sourcesOrder: effSourcesOrder, sourcesFormatRules: methodInfo?.sourcesFormatRules,
    sourcesGrouping: methodInfo?.sourcesGrouping, citFootnotes: order.citFootnotes,
    citationStyle: methodInfo?.citationStyle, callClaude,
  });

  const secLocalToGlobal = {};
  mainSecs.forEach(sec => {
    secLocalToGlobal[sec.id] = {};
    Object.entries(secLocalSources[sec.id]).forEach(([localN, text]) => {
      const rawIdx = deduper.add(text);
      secLocalToGlobal[sec.id][Number(localN)] = oldToNew[rawIdx + 1];
    });
  });

  // "Сторінка за змістом" (перемикач на етапі джерел): сторінка посилання — за збігом
  // речення з PDF джерела; без PDF чи при слабкому збігу — як звичайно, з діапазону
  let contentPickers = {};
  if (order.pageByContent && !order.citFootnotes && Object.keys(pdfUrls || {}).length) {
    try {
      contentPickers = await buildContentPagePickers({
        texts: Object.fromEntries(mainSecs.map(s => [s.id, order.content?.[s.id] || ""])),
        mappingFor: id => secLocalToGlobal[id], pdfUrls, pageRanges,
      });
    } catch (e) { console.error("Сторінка за змістом:", e.message); }
  }

  const nextContent = { ...(order.content || {}) };
  mainSecs.forEach(sec => {
    const text = nextContent[sec.id] || "";
    if (!text) return;
    const mapping = secLocalToGlobal[sec.id] || {};
    if (!Object.keys(mapping).length) return;
    nextContent[sec.id] = applyCitationRemap(text, mapping, refCiteText, { pageRanges, pageAbbrev, pagePicker: contentPickers[sec.id] });
  });

  const isAPA = /APA/i.test(effStyle);
  const isMLA = /MLA/i.test(effStyle);
  const citedGlobalNums = new Set();
  mainSecs.forEach(sec => {
    const text = nextContent[sec.id];
    if (!text) return;
    if (isAPA || isMLA) {
      // "(Автор, Рік)" буває в тексті зі сторінкою чи в групі — шукаємо без дужок
      Object.entries(refCiteText).forEach(([n, cite]) => { if (isAuthorYearCited(text, cite)) citedGlobalNums.add(Number(n)); });
    } else {
      extractCitedNumbers(text).forEach(n => citedGlobalNums.add(n));
    }
  });
  const orphans = [];
  const seenOrphanGlobalNums = new Set();
  mainSecs.forEach(sec => {
    Object.entries(secLocalToGlobal[sec.id] || {}).forEach(([, globalN]) => {
      if (!globalN || citedGlobalNums.has(globalN) || seenOrphanGlobalNums.has(globalN)) return;
      seenOrphanGlobalNums.add(globalN);
      orphans.push({ secId: sec.id, globalN });
    });
  });
  if (orphans.length) {
    onProgress?.("Довставляю пропущені джерела у список літератури...");
    const unresolvedOrphans = [];
    const orphansBySec = new Map();
    orphans.forEach(o => {
      if (!nextContent[o.secId]) return;
      if (!orphansBySec.has(o.secId)) orphansBySec.set(o.secId, []);
      orphansBySec.get(o.secId).push(o);
    });
    await Promise.all([...orphansBySec.entries()].map(async ([secId, secOrphans]) => {
      const insertions = secOrphans.map(({ globalN }) => ({
        number: globalN, marker: citationMarkerWithPage(globalN, refCiteText, pageRanges, pageAbbrev), sourceText: fmtList[globalN - 1],
      }));
      try {
        const { text, unresolved } = await insertMissingCitations({ sectionText: nextContent[secId], insertions, lang: info.language, callClaude, signal: ctx.signal });
        nextContent[secId] = text;
        unresolvedOrphans.push(...unresolved);
      } catch (e) {
        console.error("Помилка вставки цитат непроцитованих джерел", secId, e);
        unresolvedOrphans.push(...secOrphans.map(o => o.globalN));
      }
    }));
    if (unresolvedOrphans.length) {
      const removedSet = new Set(unresolvedOrphans);
      const removeOldToNew = {};
      const newFmtList = [];
      const newRefCiteText = {};
      const newPageRanges = {};
      fmtList.forEach((ref, i) => {
        const oldN = i + 1;
        if (removedSet.has(oldN)) return;
        const newN = newFmtList.length + 1;
        newFmtList.push(ref);
        removeOldToNew[oldN] = newN;
        if (refCiteText[oldN] != null) newRefCiteText[newN] = renumberedCiteText(refCiteText[oldN], newN);
        if (pageRanges[oldN] != null) newPageRanges[newN] = pageRanges[oldN];
      });
      mainSecs.forEach(sec => {
        if (!nextContent[sec.id]) return;
        nextContent[sec.id] = applyCitationRemap(nextContent[sec.id], removeOldToNew, newRefCiteText, { pageRanges: newPageRanges, pageAbbrev });
      });
      fmtList = newFmtList;
      refCiteText = newRefCiteText;
      pageRanges = newPageRanges;
    }
  }

  onProgress?.("Перевіряю рисунки...");
  await Promise.all(mainSecs.map(async sec => {
    const text = nextContent[sec.id];
    if (!text) return;
    const fixed = await fixDanglingFigures({ text, lang: info.language, callClaude, signal: ctx.signal });
    if (fixed !== text) nextContent[sec.id] = fixed;
  }));

  onProgress?.("Перевіряю сумарний обсяг...");
  const totalTargetWords = sections.reduce((sum, s) => sum + (parseInt(s.pages) || 0) * 230, 0);
  const adjustedVolume = await enforceTotalVolume({
    sections, content: nextContent, targetWords: totalTargetWords,
    isEligible: (s) => !["sources", "intro", "conclusions"].includes(s.id) && !/додат/i.test(s.label || ""),
    callClaude, sys: buildSYS(info.language, methodInfo), onProgress, clean: stripEmDash,
    lang: info.language, cacheOpts: { onCost: ctx.onCost },
  });
  Object.assign(nextContent, adjustedVolume);

  const formattedText = fmtList.map((c, i) => `${i + 1}. ${c}`).join("\n");
  return { content: nextContent, citInputs, citStructured, refList: formattedText };
}

/**
 * Щоденник практики — на основі вже написаного звіту, зразка щоденника й
 * структурного аналізу офіційного бланка (diaryTemplateInfo). Перенесено з
 * doGenerateDiary без зміни логіки.
 *
 * @param {object} order - { info, sections, content, diaryExampleText?,
 *   methodInfo?, deptGuidanceText?, diaryTemplateInfo?, clientMaterialsSummary? }
 * @param {object} ctx - { callClaude, onProgress? }
 * @returns {Promise<object>} патч {diaryContent, stage:"diary", status:"writing"}
 */
export async function runPracticeDiary(order, ctx) {
  const { callClaude, onProgress } = ctx;
  const info = order.info || {};
  onProgress?.("Генерую щоденник практики...");
  const writableSecs = (order.sections || []).filter(s => s.id !== "sources");
  const content = order.content || {};
  const reportText = writableSecs.map(s => content[s.id]).filter(Boolean).join("\n\n");
  const prompt = buildPracticeDiaryPrompt(info, order.diaryExampleText, order.methodInfo, order.deptGuidanceText, order.diaryTemplateInfo, order.clientMaterialsSummary?.rawText, writableSecs, reportText);
  const text = stripEmDash(await callClaude([{ role: "user", content: prompt }], ctx.signal, buildSYS(info.language, order.methodInfo), 8000, null, undefined, { onCost: ctx.onCost }));
  return { diaryContent: text, stage: "diary", status: "writing" };
}

/**
 * Параметри для exportToDocx() основного звіту (без щоденника) — та сама
 * логіка вибору титулки/аркуша завдання/календарного плану (методичка, якщо
 * вона справді зразок ПРАКТИКИ, інакше згенеровані practiceDefaults.js),
 * позиціювання списку джерел перед "Додатками", що й doExportMain. Включає
 * clientDrawings (раніше ніде не передавались у doExportMain — прогалина,
 * виправлена й тут, і в PracticePage.jsx).
 *
 * @param {object} order - { info, sections, content, methodInfo?, refList?, clientDrawings? }
 * @returns {object} параметри для exportToDocx({...})
 */
export function buildPracticeMainExportParams(order) {
  const info = order.info || {};
  const sections = order.sections || [];
  const content = order.content || {};
  const methodInfo = order.methodInfo;
  const refList = order.refList || "";

  const nonSourceSecs = sections.filter(s => s.id !== "sources");
  const sourcesEntry = refList ? [{ id: "sources", label: "Список використаних джерел", pages: 0 }] : [];
  const appendixIdx = nonSourceSecs.findIndex(s => /додат/i.test(s.label || ""));
  const displayOrder = appendixIdx >= 0
    ? [...nonSourceSecs.slice(0, appendixIdx), ...sourcesEntry, ...nonSourceSecs.slice(appendixIdx)]
    : [...nonSourceSecs, ...sourcesEntry];
  const exportContent = { ...content, ...(refList ? { sources: refList } : {}) };

  const methodTitlePageMatchesPractice = methodInfo?.titlePageTemplate?.some(l => /практик/i.test(l?.text || ""));
  const titlePageLines = (methodInfo?.titlePageTemplate?.length && methodTitlePageMatchesPractice)
    ? methodInfo.titlePageTemplate
    : buildPracticeTitlePageLines(info);
  const methodTaskSheetMatchesPractice = methodInfo?.taskSheetTemplate?.some(l => /практик/i.test(l?.text || ""));
  const taskSheetTemplate = (methodInfo?.taskSheetTemplate?.length && methodTaskSheetMatchesPractice)
    ? methodInfo.taskSheetTemplate
    : buildPracticeTaskSheetLines(info);
  const methodCalendarMatchesPractice = !!methodInfo?.calendarPlanTable?.trim() && /практик/i.test(methodInfo.calendarPlanTable);
  const calendarPlanTable = (methodInfo?.calendarPlanTable?.trim() && methodCalendarMatchesPractice)
    ? fillPracticeCalendarPlan(methodInfo.calendarPlanTable, info, sections)
    : buildPracticeCalendarPlanTable(info, sections);
  const exportMethodInfo = { ...methodInfo, taskSheetTemplate, calendarPlanTable };
  const isFreeformReport = sections.length === 1 && sections[0]?.id === "main";

  return {
    content: exportContent,
    info: {
      topic: info.topic, type: info.type, language: info.language, pages: info.pages, orderNumber: info.orderNumber,
      studentName: info.studentName, studentGroup: info.studentGroup, course: info.course,
      companyName: info.companyName, supervisorCompany: info.supervisorCompany, supervisorUniversity: info.supervisorUniversity,
      dateStart: info.dateStart, dateEnd: info.dateEnd, practiceType: info.practiceType,
    },
    displayOrder,
    titlePage: null,
    titlePageLines,
    methodInfo: exportMethodInfo,
    keepHeadingCase: true,
    skipToc: isFreeformReport,
    clientDrawings: order.clientDrawings || [],
  };
}

/**
 * Параметри для exportToDocx() щоденника практики окремим файлом — розбирає
 * календарний графік/робочі записи з тексту щоденника кодом (не ШІ), обирає
 * титулку щоденника (зразок > методичка > типова). Перенесено з doExportDiary.
 *
 * @param {object} order - { info, diaryContent, diaryTemplateInfo?, methodInfo? }
 * @returns {object|null} параметри для exportToDocx({...}), або null якщо diaryContent порожній
 */
export function buildPracticeDiaryExportParams(order) {
  if (!order.diaryContent) return null;
  const info = order.info || {};
  const methodInfo = order.methodInfo;
  const dti = order.diaryTemplateInfo;

  const diaryTitlePageLines = dti?.diaryTitlePageTemplate?.length
    ? dti.diaryTitlePageTemplate
    : methodInfo?.diaryTitlePageTemplate?.length
      ? methodInfo.diaryTitlePageTemplate
      : buildPracticeDiaryTitlePageLines(info);
  const practiceLabel = PRACTICE_TYPE_GENITIVE[info.practiceType] ? `${PRACTICE_TYPE_GENITIVE[info.practiceType]} практики` : "";
  const diaryCalendarGraphWeeks = dti?.calendarGraphWeeksCount || 6;
  const { mainText: diaryMainText, calendarGraphText } = splitDiaryCalendarGraph(order.diaryContent);
  const diaryCalendarGraphRows = dti?.hasCalendarGraphSection
    ? parseDiaryCalendarGraphRows(calendarGraphText, diaryCalendarGraphWeeks, info.dateStart)
    : [];
  const diaryWorkRecords = parseDiaryWorkRecords(diaryMainText);

  return {
    content: { diary: diaryMainText },
    info: {
      topic: `Щоденник практики ${info.topic || ""}`.trim(), type: "Щоденник", language: info.language, pages: "5", orderNumber: info.orderNumber,
      studentName: info.studentName, studentGroup: info.studentGroup, course: info.course,
      companyName: info.companyName, supervisorCompany: info.supervisorCompany, supervisorUniversity: info.supervisorUniversity,
      dateStart: info.dateStart, dateEnd: info.dateEnd,
      faculty: info.faculty, department: info.department, degreeLevel: info.degreeLevel,
      specialty: info.specialty, knowledgeField: info.knowledgeField, practiceLabel, practiceType: info.practiceType,
    },
    displayOrder: [{ id: "diary", label: "", pages: 0 }],
    titlePage: null,
    titlePageLines: diaryTitlePageLines,
    methodInfo,
    skipToc: true,
    keepHeadingCase: true,
    diaryArrivalDeparture: dti ? !!dti.hasArrivalDepartureBlock : !!methodInfo?.hasArrivalDepartureBlock,
    diaryBlankNotesPages: dti ? !!dti.hasBlankNotesPages : !!methodInfo?.hasBlankNotesPages,
    diaryCalendarGraph: !!dti?.hasCalendarGraphSection,
    diaryCalendarGraphWeeks,
    diaryCalendarGraphRows,
    diaryWorkRecords,
    diarySupervisorSignatureBlock: !!dti?.hasSupervisorSignatureBlock,
    diaryInspectorReview: !!dti?.hasInspectorReviewSection,
    diaryGradeFields: !!dti?.hasGradeFields,
    diaryConclusionDepartment: dti?.departmentNameForConclusion || "",
    diaryStudentName: info.studentName,
    diaryReviewBlock: true,
    diarySupervisorCompany: info.supervisorCompany,
    diarySupervisorUniversity: info.supervisorUniversity,
  };
}
