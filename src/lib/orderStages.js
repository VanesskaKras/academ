// Спільна, не прив'язана до React орхестраційна логіка генерації однієї роботи —
// використовується і браузером (academic-assistant.jsx викликає ці самі функції
// замість дублювання логіки), і серверним воркером (worker/runOrder.js), щоб
// генерація могла йти без відкритої вкладки. Кожна функція — "чиста": приймає
// плоский об'єкт стану замовлення (та ж форма, що й документ у Firestore) і
// повертає патч полів для збереження; жодних setState/window/alert усередині.

import {
  buildSYS, SYS_JSON, SYS_JSON_SHORT, SYS_JSON_ARRAY, buildTitlePageFilePrompt, buildContinuationPlanPrompt, buildIllustrationsPrompt, buildIllustrationsPdfPrompt,
  buildTemplateAnalysisPrompt, STRUCTURE_READING_PROMPT, buildMethodologyReadingPrompt, buildExampleWorkReadingPrompt, buildCommentAnalysisPrompt, buildDrawingsDescriptionPrompt,
  buildAnnotationPrompt, buildClientSourcesDistributionPrompt, getStyleProfileForSection, localPhrasesStep, localPhrasesJsonField,
} from "./prompts.js";
import { MODEL, MODEL_FAST } from "./api.js";
import { enforceWordCount, enforceTotalVolume, stripEmDash } from "./wordCount.js";
import { estimateRealPages } from "./pageLayout.js";
import { insertMissingCitations, capCitationRepeats, buildFinalReferenceList, buildCiteFormats, createReferenceDeduper, applyCitationRemap, computeDedupKey, assembleSourcesText, needsNormativeSectionHeaders, extractCitedNumbers, isAuthorYearCited, citationMarkerWithPage, replaceCitationBrackets, rebuildBracket, detectInTextPagePolicy } from "./citationFormatting.js";
import { buildContentPagePickers } from "./contentPages.js";
import { fixDanglingFigures } from "./figureFixup.js";
import { deriveDegreeLevelFromType } from "./titlePageTokens.js";
import { fixMixedScript, typographQuotes, stripStrayCJK, getIntroTasksProfile, INTRO_TASKS_MERGE_SPLIT_RULE, CODE_GROUNDING_RULE, APPENDIX_FILL_MARKER, APPENDIX_FILL_MARKER_RULE } from "./textCleanup.js";
import {
  getEmpiricalSections, getEconSections, getTechnicalSections, parsePagesAvg, hasRealFigure, extractOpeningSentences, getLangLabels,
  buildWorkConfig, calcSourceDist, buildPlanText, parseClientPlan, parseTemplate, detectRequestedChapterCount, detectWriteScopeFromComment, isPsychoPed,
  deriveStructureFromExampleTOC, mergeExampleWorkIntoMethodInfo, mergeIntroComponents, stripLeadingAppendixLabel,
  hasEmpiricalResearch, isEcon, isTechnical, CODE_FILE_EXTENSIONS, stripPresentationSuffix,
  extractPlanBlock, checkPlanIssues, chapterHeadingPrefix, appendixLabelRe, appendixLetterRegex, sourceLangQuota,
} from "./planUtils.js";
import { getAcademicDefaults, normalizeWorkType, classifyAppendixItem, detectSpecialty } from "./academicDefaults.js";
import { withLangProfile } from "./langProfile.js";
import { searchByPhrase, phraseSearchOpts, filterSourcesWithGemini, paperToCitation, enrichSources, getEconInstitutionalSources, generateAlternatePhrases, enrichManualLine, enrichFullSourceInfo, compareForAutoInsert } from "./sourcesSearch.js";
import { buildCompanyWebsiteSource, extractCompanyNameFromProfile, fillEnterpriseNameToken, findWebsiteInText, pickWebsiteFromSearchResults } from "./companyWebsite.js";
import { searchCompanyInfo } from "./companySearch.js";
import { extractReadyWorkStructure, quickParsePlanIds } from "./readyWorkExtract.js";
import mammoth from "mammoth";

// ── Підбір ілюстрацій клієнта для розділу (перенесено з academic-assistant.jsx
// без змін логіки — раніше читала component state напряму, тепер приймає його як аргументи) ──
function getIllustrationsForSection(sec, illustrationDescs, illustrations) {
  if (!illustrationDescs?.length) return [];
  if (illustrations?.length > 0) {
    return illustrations.map((ill, i) => {
      const desc = illustrationDescs.find(d => d.figureNum === i + 1) || illustrationDescs[i];
      if (!desc) return null;
      const target = ill.targetSection?.trim();
      if (target) {
        const t = target.toLowerCase().replace(/^розділ\s+/i, "").trim();
        if (sec.id?.toLowerCase() === t || sec.id?.toLowerCase().startsWith(t + ".") || sec.label?.toLowerCase().includes(t)) {
          return { ...desc, caption: ill.caption, index: i };
        }
        return null;
      }
      const suggested = desc.suggestedSection?.trim();
      if (suggested && (sec.id === suggested || sec.id?.startsWith(suggested + ".") || suggested?.startsWith(sec.id))) {
        return { ...desc, caption: ill.caption, index: i };
      }
      return null;
    }).filter(Boolean);
  }
  // PDF-режим: ілюстрації визначені тільки через illustrationDescs
  return illustrationDescs.filter(desc => {
    const suggested = desc.suggestedSection?.trim();
    return suggested && (sec.id === suggested || sec.id?.startsWith(suggested + ".") || suggested?.startsWith(sec.id));
  });
}

// ── Пошук заміни джерела, яке після довставки цитати не підтвердило жодного
// речення (unresolved) — та сама логіка, що й retryUnmatchedSource у
// academic-assistant.jsx, лише без прив'язки до component state ──
async function retryUnmatchedSource({ order, secId, sectionText, marker, thesis, lang, signal, ctx }) {
  if (!thesis) return null;
  try {
    const info = order.info;
    const topicCtx = [info?.topic, info?.direction, info?.subject].filter(Boolean).join(' ');
    const filterLabel = (order.sections.find(s => s.id === secId)?.label || '')
      .replace(/^РОЗДІЛ\s+[IVXivxІVХ\d]+[.\s:]+/i, '').trim();
    const existingTitles = new Set(
      Object.values(order.citStructured || {}).flat().map(p => (p.title || '').toLowerCase().slice(0, 60))
    );
    const candidates = await searchByPhrase(thesis, 15, 1, true, 0, '', phraseSearchOpts(info?.language, [], 0));
    const fresh = candidates.filter(p => {
      const key = (p.title || '').toLowerCase().slice(0, 60);
      return key && !existingTitles.has(key);
    });
    if (!fresh.length || signal?.aborted) return null;
    const filteredRaw = await filterSourcesWithGemini(fresh.slice(0, 25), filterLabel, topicCtx, 3, thesis, ctx.onCost);
    const filtered = await enrichSources(filteredRaw);
    const best = [...filtered]
      .filter(p => p._complete !== false)
      .sort(compareForAutoInsert)[0];
    if (!best || (best.geminiScore ?? 0) < 70 || signal?.aborted) return null;

    const newLine = paperToCitation(best);
    if (!newLine) return null;
    const { text, unresolved } = await insertMissingCitations({
      sectionText, insertions: [{ number: 1, marker, sourceText: newLine, abstract: best.abstract, thesis }],
      lang, callClaude: ctx.callClaude, signal,
    });
    if (unresolved.length) return null; // заміна теж не підтвердила жодного речення
    return { text, newLine, paper: best };
  } catch (e) {
    console.error('retryUnmatchedSource error:', e.message);
    return null;
  }
}

/**
 * Генерує ОДИН підрозділ (`sec`) роботи. Не знає про genIdx/цикл/паузи між
 * підрозділами й не зберігає нічого сама — виклик, збереження результату і
 * просування genIdx лишаються за викликачем (браузерний useEffect-цикл або
 * воркер), так само як і зараз.
 *
 * @param {object} order - плоский стан замовлення (та ж форма, що документ Firestore):
 *   info, sections, content, citInputs, citStructured, abstractsMap, sourceThesisMap,
 *   commentAnalysis, methodInfo, appendicesText, clientMaterialsSummary,
 *   clientMaterialsText, econProfile, glossary, illustrationDescs, illustrations
 * @param {object} sec - підрозділ зі order.sections, який генеруємо
 * @param {object} ctx - { callClaude, signal?, onProgress?(msg), onCost? }
 *   callClaude тут — ВЖЕ прив'язана до costTracker/onCost версія (див. api.js
 *   createCostTracker) — orderStages.js сам не керує лічильником вартості.
 * @returns {Promise<{content, citInputs, abstractsMap, sourceThesisMap, glossary}>}
 *   патч полів, які викликач має злити в order і зберегти (у Firestore чи де завгодно).
 */
export async function runWritingSection(order, sec, ctx) {
  const { callClaude: doCallClaude, signal, onProgress } = ctx;
  const d = order.info;
  const lang = d?.language || "Українська";
  const sections = order.sections;
  const content = order.content || {};
  const citInputs = order.citInputs || {};
  const abstractsMap = order.abstractsMap || {};
  const sourceThesisMap = order.sourceThesisMap || {};
  const commentAnalysis = order.commentAnalysis;
  const methodInfo = order.methodInfo;
  const appendicesText = order.appendicesText;
  const clientMaterialsSummary = order.clientMaterialsSummary;
  const clientMaterialsText = order.clientMaterialsText;
  const econProfile = order.econProfile;
  const glossary = order.glossary || {};

  onProgress?.("Генерую: " + sec.label + "...");

  // Будуємо повний multi-turn контекст як у Claude.ai
  const buildMessages = (instruction) => {
    const prevEntries = Object.entries(content).filter(([k]) => k !== sec.id);
    if (!prevEntries.length) return [{ role: "user", content: instruction }];
    const isLargeWork = totalPages > 50;
    const currentChapter = sec.id.split(".")[0];
    const empSecsForConclusions = sec.type === "conclusions"
      ? getEmpiricalSections(sections, d, commentAnalysis, methodInfo)
      : null;
    const empSecsForIntro = sec.type === "intro"
      ? getEmpiricalSections(sections, d, commentAnalysis, methodInfo)
      : null;
    const contextText = prevEntries.map(([k, v]) => {
      const s = sections.find(x => x.id === k);
      const label = s?.label || k;
      if (!isLargeWork) return `=== ${label} ===\n${v}`;
      const sameChapter = k.split(".")[0] === currentChapter;
      const isIntroForConclusions = sec.type === "conclusions" && s?.type === "intro";
      const isEmpiricalForConclusions = sec.type === "conclusions" && empSecsForConclusions &&
        (empSecsForConclusions.chapterSectionIds.includes(k) || k === empSecsForConclusions.anchorId);
      const isEmpiricalForIntro = sec.type === "intro" && empSecsForIntro &&
        (empSecsForIntro.chapterSectionIds.includes(k) || k === empSecsForIntro.anchorId);
      if (sameChapter || isIntroForConclusions || isEmpiricalForConclusions || isEmpiricalForIntro) return `=== ${label} ===\n${v}`;
      const firstPara = v.split("\n").find(p => p.trim().length > 60) || v.slice(0, 400);
      return `=== ${label} [перший абзац] ===\n${firstPara}`;
    }).join("\n\n---\n\n");
    const glossaryBlock = sec.type === "conclusions"
      ? Object.entries(glossary)
        .map(([k, terms]) => {
          if (!terms) return null;
          const s = sections.find(x => x.id === k);
          return `${s?.label || k}: ${terms}`;
        })
        .filter(Boolean)
        .join("\n")
      : "";
    const fullContextText = glossaryBlock
      ? `${contextText}\n\n---\n\n=== Глосарій ключових авторських термінів і назв методик за розділами ===\n${glossaryBlock}`
      : contextText;
    return [
      { role: "user", content: "Ось вже написані частини цієї роботи:" },
      { role: "assistant", content: fullContextText },
      { role: "user", content: instruction },
    ];
  };
  const planSummary = sections
    .filter(s => !["intro", "conclusions", "sources", "chapter_conclusion"].includes(s.type))
    .map(s => s.label)
    .join("\n");
  const typeHints = {
    theory: "теоретичний — визначення понять, аналіз літератури, огляд наукових підходів",
    analysis: "аналітично-практичний — аналіз даних, виявлення закономірностей, порівняння",
    recommendations: "рекомендаційний — практичні пропозиції, шляхи вирішення, прогнози",
  };
  let instruction = "";
  const totalPages = parsePagesAvg(d?.pages);
  const isLarge = totalPages > 40;

  if (sec.type === "intro") {
    const mainSecs = sections.filter(s => !["intro", "conclusions", "sources", "chapter_conclusion"].includes(s.type));
    const tasksProfile = getIntroTasksProfile(d.type, d.course, mainSecs.length, isLarge);
    const tasksCount = tasksProfile.count;

    const lc = getLangLabels(lang);
    const il = lc.introLabels || {};
    const defaultComponents = lc.defaultIntroComponents || ["актуальність теми", "мета дослідження", "завдання дослідження", "об'єкт дослідження", "предмет дослідження", "методи дослідження", "практичне значення дослідження", "структура роботи"];
    const allComponents = mergeIntroComponents(defaultComponents, methodInfo?.introComponents);
    const structureRe = /структура|structure|struktura|štruktúra|aufbau/i;
    const structureIdx = allComponents.findIndex(c => structureRe.test(c));
    if (structureIdx !== -1 && structureIdx !== allComponents.length - 1) {
      allComponents.push(allComponents.splice(structureIdx, 1)[0]);
    }

    const componentLines = allComponents.map((comp) => {
      const label = comp.charAt(0).toUpperCase() + comp.slice(1);
      if (/актуальн|actuality|aktual|relevance|relevanz|pertine/i.test(comp)) {
        const phrase = il.actuality || "Актуальність теми.";
        return `${label}: one paragraph starting with "${phrase}" — immediately introduce why the topic is relevant today. Do not split into multiple paragraphs.`;
      }
      if (/теоретико|теоретичн.*основ|методологічн.*основ|podstawy.*teoret|theoretical.*basis/i.test(comp)) {
        const phrase = il.theoryBasis || "Теоретико-методологічну основу дослідження становлять";
        return `${label}: one paragraph starting with "${phrase}" — list scholarly works, authors, regulatory sources relevant to the topic.`;
      }
      if ((/мета|goal|cel|ziel|objetivo|purpose|účel|cieľ/i.test(comp)) && !/завдання|tasks|zadania|aufgaben|úkoly|úlohy/i.test(comp)) {
        const phrase = il.goal || "Мета дослідження –";
        return `${label}: write in format "${phrase} [clearly formulated goal for topic "${d.topic}"]".`;
      }
      if (/завдання|tasks|zadania|aufgaben|tareas|úkoly|úlohy/i.test(comp)) {
        const phrase = il.tasks || "Завдання дослідження:";
        const natureLine = tasksProfile.nature ? ` Завдання мають бути ${tasksProfile.nature}.` : "";
        return `${label}: write in format "${phrase}" — then exactly ${tasksCount} numbered tasks.${natureLine} ${INTRO_TASKS_MERGE_SPLIT_RULE}\nСтруктура плану роботи (змістова основа для завдань):\n${mainSecs.map((s, j) => `   ${j + 1}) "${s.label}"`).join("\n")}`;
      }
      if (/об.єкт|przedmiot|gegenstand|objeto/i.test(comp) && !/предмет|subject|obiekt/i.test(comp)) {
        const phrase = il.object || "Об'єкт дослідження –";
        return `${label}: write in format "${phrase} [phenomenon or process being studied]".`;
      }
      if (/предмет|subject|obiekt/i.test(comp)) {
        const phrase = il.subject || "Предмет дослідження –";
        return `${label}: write in format "${phrase} [specific aspect of the object being analyzed]".`;
      }
      if (/метод|method/i.test(comp) && !/теоретико|методологічн.*основ|podstawy/i.test(comp)) {
        const phrase = il.methods || "Методи дослідження:";
        return `${label}: write in format "${phrase} [list of methods, comma-separated]".`;
      }
      if (/новизн|novelty|nowość|neuheit|novedad/i.test(comp)) {
        const phrase = il.novelty || "Наукова новизна дослідження –";
        return `${label}: write in format "${phrase} [new positions or solutions proposed by the author]".`;
      }
      if (/практичн|practical|praktyczn|praktisch|přínos|prínos/i.test(comp)) {
        const phrase = il.practical || "Практична значущість:";
        return `${label}: write in format "${phrase} [how results can be applied in practice]".`;
      }
      if (/апробац|approbation|aprobata/i.test(comp)) {
        const phrase = il.approbation || "Апробація результатів дослідження –";
        return `${label}: write in format "${phrase} [conferences, publications, seminars where results were presented]".`;
      }
      if (structureRe.test(comp)) {
        const phrase = il.structure || "Структура роботи:";
        const chapCount = new Set(mainSecs.map(s => s.id.split(".")[0])).size || mainSecs.length;
        return `${label}: write EXACTLY one sentence following this template (translate it into the language of the work, keep the same structure), with NOTHING else added — no chapter-by-chapter description: "${phrase} the work consists of an introduction, ${chapCount} chapters, conclusions, and a list of sources. The total volume of the work is __TOTAL_PAGES__ pages." Keep the literal token __TOTAL_PAGES__ unchanged exactly as written (no digits) — it will be replaced automatically with the real page count once the whole work is generated.`;
      }
      return `${label}: write in format "${label} – [content relevant to topic "${d.topic}"]".`;
    });

    instruction = `Напиши ВСТУП для ${d.type} на тему "${d.topic}". Галузь: ${d.subject}.

INTRO STRUCTURE (follow strictly, each element as a new paragraph):

${componentLines.map((l, i) => `${i + 1}. ${l}`).join("\n\n")}
${methodInfo?.otherRequirements ? `\nМЕТОДИЧКА ВИМОГИ: ${methodInfo.otherRequirements}` : ""}${commentAnalysis?.textStructureHints ? `\nКЛІЄНТ ВИМОГИ (ОБОВ'ЯЗКОВО): ${commentAnalysis.textStructureHints}` : ""}

IMPORTANT: use already written sections (in context) for exact formulation of methods, sample, object — everything must match the text. Follow each element's format strictly. No citations. No bold or italic. Write in continuous paragraphs. EXCEPTION: research tasks — write as numbered list (1. 2. 3. ...), each task on a new line.

КРИТИЧНО ВАЖЛИВО (об'єкт, предмет, мета, завдання): якщо в тексті вище (розділ з анкетуванням/емпіричним дослідженням) вже вказано РЕАЛЬНИХ respondents дослідження (напр. вчителі, батьки, фахівці) — об'єкт, предмет, мета і завдання ОБОВ'ЯЗКОВО мають описувати ефект/результат САМЕ щодо цієї реальної вибірки, а не абстрактної групи з теми (напр. учнів), яку дослідження фактично не вимірювало. Якщо тема стосується учнів, а опитані — вчителі, сформулюй мету про вплив на педагогічну практику/готовність вчителів (за потреби — з поясненням, що це опосередкований шлях впливу на учнів), а НЕ про безпосередній ефект на учнях. Розрив між заявленою метою та реально дослідженою вибіркою — груба методологічна помилка, яку одразу помітить рецензент.`;

  } else if (sec.type === "conclusions") {
    const conclReq = methodInfo?.conclusionsRequirements || "";
    const mainSecsForConcl = sections.filter(s => !["intro", "conclusions", "sources", "chapter_conclusion"].includes(s.type));
    const conclTasksProfile = getIntroTasksProfile(d.type, d.course, mainSecsForConcl.length, isLarge);

    instruction = `Напиши ВИСНОВКИ для ${d.type} на тему "${d.topic}".
${conclReq ? `ВИМОГИ МЕТОДИЧКИ: ${conclReq}\n` : ""}${commentAnalysis?.textStructureHints ? `ВИМОГИ КЛІЄНТА ДО СТРУКТУРИ (ОБОВ'ЯЗКОВО): ${commentAnalysis.textStructureHints}\n` : ""}
ПРАВИЛА:
- Обсяг: приблизно ${(sec.pages || 2) * 230} слів (~${sec.pages} стор.).
- Перший абзац — загальний підсумок мети і що вдалось досягти
- Далі — рівно ${conclTasksProfile.count} абзаців, по одному на кожне завдання дослідження, сформульоване у вступі (текст вступу є в контексті) — у тому самому порядку. Якщо завдання у вступі поєднувало кілька підрозділів плану — зведи їхні конкретні результати в одному абзаці; якщо завдання було розбите з одного підрозділу — розподіли результати на відповідну кількість абзаців
- Кожен такий абзац = конкретний результат, що відповідає своєму завданню
- Останній абзац — перспективи подальших досліджень
- НЕ повторювати те що сказано у вступі, НЕ вводити нову інформацію
- Абзаци-результати мають мати різний ритм і різні відкривачі речень: не починай кожен з підсумкової конструкції на кшталт "Аналіз... засвідчив, що...", чергуй з прямим твердженням, конкретним фактом чи розгортанням попередньої думки. Висновки загалом мають звучати іншим голосом, ніж вступ, а не повторювати його ритм у зворотному порядку.
- Без посилань. Без жирного. Без нумерації. Пиши суцільними абзацами, не використовуй жодних списків.

Спирайся на весь написаний текст роботи, включно з формулюваннями завдань у вступі (є в контексті) — формулюй конкретні висновки на основі реального змісту підрозділів.`;

  } else if (sec.type === "chapter_conclusion") {
    const chapNum = sec.chapterNum || sec.id.split(".")[0];
    instruction = `Напиши "Висновки до розділу ${chapNum}" для ${d.type} на тему "${d.topic}".
${methodInfo?.chapterConclusionRequirements ? `ВИМОГИ МЕТОДИЧКИ: ${methodInfo.chapterConclusionRequirements}` : ""}
Обсяг: 120–150 слів (не більше).
Без нової інформації. Без посилань. Без жирного. Без нумерації. Пиши суцільними абзацами.
Спирайся на повний текст підрозділів розділу ${chapNum} (є в контексті).`;
  } else {
    const methodReqMap = {
      theory: methodInfo?.theoryRequirements,
      analysis: methodInfo?.analysisRequirements,
      recommendations: methodInfo?.analysisRequirements,
    };
    const methodReq = methodReqMap[sec.type] || methodInfo?.otherRequirements || "";

    const empSecs = getEmpiricalSections(sections, d, commentAnalysis, methodInfo);
    const isEmpChapter = empSecs.chapterSectionIds.includes(sec.id);
    const isEmpAnchor = empSecs.anchorId === sec.id;
    let empiricalBlock = "";

    // Незалежно від isEcon(d) (класифікація за спеціальністю може не спрацювати, напр. для
    // прикладної роботи не-економічного напряму): якщо САМА методичка явно вимагає характеристику
    // конкретного досліджуваного підприємства (requiresEnterpriseProfile), примусово вимагаємо її
    // саме в першому підрозділі практичної/аналітичної частини — інакше модель за замовчуванням
    // лишає підприємство безіменним "умовним прикладом" без реквізитів.
    const firstAnalysisSecId = sections.find(s => ["analysis", "recommendations"].includes(s.type))?.id;
    const isFirstAnalysisSubsection = !!methodInfo?.requiresEnterpriseProfile && firstAnalysisSecId === sec.id;
    const enterpriseProfileBlock = isFirstAnalysisSubsection
      ? `\nОБОВ'ЯЗКОВО НА ПОЧАТКУ цього підрозділу (методичка прямо вимагає характеристику конкретного досліджуваного підприємства/організації незалежно від теми роботи): дай коротку характеристику підприємства — назва, форма власності, рік заснування чи коротка історія, статутний фонд (якщо доречно для галузі), продукція чи послуги, ринки збуту, основні конкуренти. Підприємство НЕ МОЖЕ лишатись безіменним чи описаним лише як "умовне середнє підприємство" без цих деталей — навіть якщо дані вигадані, вони мають бути конкретними й послідовними.${econProfile ? `\nФІКСОВАНІ БАЗОВІ ДАНІ ПІДПРИЄМСТВА (використовуй САМЕ ЦІ дані, не вигадуй іншу назву/рік/цифри):\n${econProfile}\n` : ""}`
      : "";

    const econSecIds = getEconSections(sections, d);
    const isEconSec = econSecIds.includes(sec.id);
    let econBlock = "";
    if (isEconSec) {
      const secFormulas = (methodInfo?.requiredFormulas || []).filter(f => !f.section || f.section === sec.type);
      const secTables = (methodInfo?.requiredTables || []).filter(t => !t.section || t.section === sec.type);
      const formulasBlock = secFormulas.length
        ? `\nОБОВ'ЯЗКОВІ ФОРМУЛИ З МЕТОДИЧКИ (підстав реалістичні числові значення та підрахуй результат):\n${secFormulas.map(f =>
          `- ${f.name}: ${f.formula}\n  Змінні: ${f.variables}${f.interpretation ? `\n  Інтерпретація: ${f.interpretation}` : ""}`
        ).join("\n")}`
        : "";
      const tablesBlock = secTables.length
        ? `\nОБОВ'ЯЗКОВІ ТАБЛИЦІ З МЕТОДИЧКИ (відтвори структуру, заповни реалістичними даними під тему "${d.topic}"):\n${secTables.map(t =>
          `- ${t.name}\n  Структура: ${t.structure}\n  Що заповнювати: ${t.instructions}`
        ).join("\n")}`
        : "";
      const genericEcon = !secFormulas.length && !secTables.length
        ? `\nОБОВ'ЯЗКОВО для цього підрозділу (економічна/управлінська робота):
- Додай мінімум одну таблицю markdown (|---|---| формат) з конкретними числовими даними (показники за 2-3 роки або порівняння з нормою/конкурентами)
- Після таблиці — аналіз динаміки або відхилень, конкретні висновки з цифрами
- Якщо підрозділ рекомендаційний: додай таблицю прогнозних або планових показників після впровадження рекомендацій`
        : "";
      const profileBlock = econProfile
        ? `\nФІКСОВАНІ БАЗОВІ ДАНІ ПІДПРИЄМСТВА (використовуй САМЕ ЦІ дані в усіх розрахунках і таблицях цього підрозділу, не вигадуй іншу назву/рік/цифри):\n${econProfile}\n`
        : "";
      econBlock = `${profileBlock}${formulasBlock}${tablesBlock}${genericEcon}`;
    }

    const technicalSecIds = getTechnicalSections(sections, d);
    const isTechnicalSec = technicalSecIds.includes(sec.id);
    let technicalBlock = "";
    if (isTechnicalSec) {
      const secFormulasT = (methodInfo?.requiredFormulas || []).filter(f => !f.section || f.section === sec.type);
      const secTablesT = (methodInfo?.requiredTables || []).filter(t => !t.section || t.section === sec.type);
      const formulasBlockT = secFormulasT.length
        ? `\nОБОВ'ЯЗКОВІ ФОРМУЛИ З МЕТОДИЧКИ (підстав реалістичні числові значення та підрахуй результат):\n${secFormulasT.map(f =>
          `- ${f.name}: ${f.formula}\n  Змінні: ${f.variables}${f.interpretation ? `\n  Інтерпретація: ${f.interpretation}` : ""}`
        ).join("\n")}`
        : "";
      const tablesBlockT = secTablesT.length
        ? `\nОБОВ'ЯЗКОВІ ТАБЛИЦІ З МЕТОДИЧКИ (відтвори структуру, заповни реалістичними даними під тему "${d.topic}"):\n${secTablesT.map(t =>
          `- ${t.name}\n  Структура: ${t.structure}\n  Що заповнювати: ${t.instructions}`
        ).join("\n")}`
        : "";
      const genericTechnical = !secFormulasT.length && !secTablesT.length
        ? `\nОБОВ'ЯЗКОВО для цього підрозділу (технічна/інженерна робота):
- Наведи конкретний інженерний/технічний розрахунок з формулою і підстановкою реалістичних числових значень
- Результати розрахунків зведи в таблицю markdown (|---|---| формат)`
        : "";
      const hasClientMaterials = !!(clientMaterialsSummary?.rawText || clientMaterialsText?.trim());
      const codeSnippetBlock = hasClientMaterials
        ? `\nЯКЩО серед МАТЕРІАЛІВ КЛІЄНТА є реальний вихідний код — цей підрозділ ОБОВ'ЯЗКОВО пиши на основі цього коду: опиши реальну структуру програми (модулі/класи/функції), послідовність роботи алгоритму та ключову логіку, посилаючись на фактичні назви функцій/класів/змінних із наданого коду. ${CODE_GROUNDING_RULE} Додатково наведи в тексті ОДИН короткий фрагмент (5-15 рядків) цього коду як ілюстрацію, оформлений у потрійних зворотних лапках (\`\`\`), точно як у наданому коді (не вигадуй новий код, не спотворюй). Якщо коду серед матеріалів немає — пропусти цю вимогу.`
        : "";
      technicalBlock = `${formulasBlockT}${tablesBlockT}${genericTechnical}${codeSnippetBlock}`;
    }

    const appendixLetters = appendicesText
      ? Array.from(new Set([...appendicesText.matchAll(appendixLetterRegex())].map(m => m[1].toUpperCase())))
      : [];
    const methodReqTextForAppendix = [methodInfo?.otherRequirements, methodInfo?.theoryRequirements, methodInfo?.analysisRequirements, methodInfo?.chapterConclusionRequirements].filter(Boolean).join(" ");
    const methodRequiresAppendixRef = /додат/i.test(methodReqTextForAppendix) && /посилан|згада|порядку\s+(?:згадки|появи|посилань)|див\.?\s*додат/i.test(methodReqTextForAppendix);
    const appendixRefExamples = (appendixLetters.length ? appendixLetters : ["А"]).map(l => `«див. додаток ${l}»`).join(" / ");
    const appendixRefRule = methodRequiresAppendixRef
      ? `\nВИМОГА ПОСИЛАННЯ НА ДОДАТОК (методичка це прямо вимагає): якщо зміст цього підрозділу справді спирається на матеріал додатку вище (анкета, таблиця, схема, протокол, лістинг коду тощо) — обов'язково додай у тексті природне посилання на нього, наприклад ${appendixRefExamples}, або словами на кшталт "...наведено у додатку ${appendixLetters[0] || "А"}". Якщо цей конкретний підрозділ не апелює напряму до вмісту додатку — не згадуй додаток штучно.`
      : "";
    const appendixBlock = appendicesText
      ? `\nДОДАТОК А (вже згенерований — спирайся на нього точно):\n${appendicesText}\nПРАВИЛО ПОГОДЖЕННЯ ПОКАЗНИКІВ: якщо в тексті підрозділу наводиш відсоток чи цифру, пов'язану з даними з таблиці додатку, — або (а) вживай те саме число й те саме формулювання показника, що вже є в таблиці додатку, або (б) якщо це справді інший, ширший/агрегований показник (напр. частка тих, хто відповів "так" на будь-яке з кількох питань, — на відміну від частки конкретної відповіді на одне питання анкети) — прямо поясни в тексті, з яких показників таблиці він виводиться і чому число відрізняється. Не залишай поруч два близькі за формулюванням, але різні за суттю числа без явного пояснення зв'язку між ними.${appendixRefRule}\n`
      : "";

    const rd = commentAnalysis?.researchDesign ?? (commentAnalysis?.empiricalHints ? { instrumentType: "questionnaire", groups: [], comparisonRequired: false, biographicalFields: [], statisticalMinN: null } : null);
    const methodInfoHasEmpirical = !!(methodInfo && /анкет|опитуванн|емпіричн|респондент|вибірк|тест|експеримент|методик/i.test(
      [methodInfo.analysisRequirements, methodInfo.otherRequirements, methodInfo.theoryRequirements].filter(Boolean).join(" ")
    ));
    const hasEmpirical = !!(rd || methodInfoHasEmpirical);
    const practicalApproachEarly = commentAnalysis?.practicalApproach;
    const suppressEmpiricalBlock = !!(practicalApproachEarly && practicalApproachEarly !== "questionnaire");

    const secAcadDefaults = (!rd && !methodInfoHasEmpirical && !practicalApproachEarly && ["analysis", "recommendations"].includes(sec.type))
      ? getAcademicDefaults(d.subject, d.type, d.course, d.topic)
      : null;
    const secMethodsHint = secAcadDefaults?.methods?.length
      ? `\nМЕТОДИ ДОСЛІДЖЕННЯ (за типом роботи): ${secAcadDefaults.researchType}. Використовувані методи: ${secAcadDefaults.methods.join(", ")}.${secAcadDefaults.notes ? ` Примітка: ${secAcadDefaults.notes}.` : ""}`
      : "";

    const buildEmpHint = (rd, legacyHint) => {
      if (!rd) return legacyHint || "";
      const parts = [];
      if (rd.groups?.length) parts.push(`Групи: ${rd.groups.map(g => `${g.name}${g.minN ? ` (n≥${g.minN})` : ""}${g.criteria ? `, ${g.criteria}` : ""}`).join("; ")}.`);
      if (rd.biographicalFields?.length) parts.push(`Біографічний блок: ${rd.biographicalFields.join(", ")}.`);
      if (rd.statisticalMinN) parts.push(`Мін. вибірка: ${rd.statisticalMinN} осіб.`);
      if (rd.comparisonRequired) parts.push("Порівняння між групами обов'язкове.");
      return parts.join(" ") || legacyHint || "";
    };
    const empHint = buildEmpHint(rd, commentAnalysis?.empiricalHints || (methodInfo?.otherRequirements && /учасник|респондент|вибірк|осіб/i.test(methodInfo.otherRequirements) ? methodInfo.otherRequirements : "20-30 респондентів"));

    const hasMultipleGroups = (rd?.groups?.length || 0) > 1;
    const comparisonRequired = rd?.comparisonRequired || hasMultipleGroups;
    const bioDesc = rd?.biographicalFields?.length ? rd.biographicalFields.join(", ") : "ПІБ, вік, стаж, кваліфікація";
    const tableDataSource = appendicesText
      ? "з узагальненими показниками по 5-8 найпоказовіших запитаннях з Додатку А (НЕ роби окремий рядок чи блок на кожне запитання анкети підряд — обери ключові для аналізу; решту результатів викладай у тексті словами, без таблиці)"
      : "з 5-8 репрезентативними відсотковими показниками за темою дослідження (без рядка на кожне можливе питання анкети)";
    const appendixRef = appendicesText ? '\nДодай речення: "Анкета наведена у Додатку А."' : "";
    const compTableInstruction = comparisonRequired ? `\nПорівняльна таблиця: ОБОВ'ЯЗКОВО окрема таблиця markdown що порівнює ключові показники між групами.` : "";

    if (isEmpChapter && !suppressEmpiricalBlock) {
      empiricalBlock = `

КОНТЕКСТ (емпіричне дослідження):
${appendixBlock}${empHint ? `ВИМОГА: ${empHint}\n` : ""}Цей підрозділ є частиною емпіричного дослідження. Визнач за назвою підрозділу що саме писати:
- якщо підрозділ про організацію або методику дослідження: опиши вибірку (групи, кількість, критерії відбору), біографічний блок анкети (${bioDesc}), метод та принцип проведення.${appendixRef}
- якщо підрозділ про аналіз або результати: таблиця markdown ${tableDataSource}, аналіз даних.${compTableInstruction}
- якщо підрозділ про рекомендації: спирайся на результати з попередніх підрозділів, не повторюй опис вибірки.`;
    } else if (isEmpAnchor && !suppressEmpiricalBlock) {
      empiricalBlock = `

ОБОВ'ЯЗКОВО для цього підрозділу (емпіричне дослідження):
${appendixBlock}${empHint ? `ВИМОГА: ${empHint}\n` : ""}1. Вибірка: ${rd?.groups?.length ? rd.groups.map(g => `${g.name}${g.minN ? ` — мін. ${g.minN} осіб` : ""}${g.criteria ? ` (${g.criteria})` : ""}`).join("; ") : "25-30 осіб (вік, категорія, умови відбору)"}.
2. Біографічний блок анкети: ${bioDesc}.
3. Метод: ${rd?.instrumentType === "fitness_test" ? "фізичне тестування" : rd?.instrumentType === "psycho_scale" ? "психологічна методика/шкала" : rd?.instrumentType === "pedagogical_experiment" ? "педагогічний експеримент" : "анкетування"}. Мета, кількість запитань${appendicesText ? " — точно як в Додатку А" : " — відповідно до теми"}.
4. Принцип проведення: умови та порядок.
5. Результати: таблиця markdown (|---|---| формат) ${tableDataSource}.${compTableInstruction}
6. Аналіз: інтерпретація результатів.${appendixRef}`;
    } else if (hasEmpirical && ["analysis", "recommendations"].includes(sec.type) && !suppressEmpiricalBlock) {
      const practicalSecs = sections.filter(s => ["analysis", "recommendations"].includes(s.type));
      const secIdx = practicalSecs.findIndex(s => s.id === sec.id);
      if (secIdx === 0) {
        empiricalBlock = `

ОБОВ'ЯЗКОВО для цього підрозділу (емпіричне дослідження):
${appendixBlock}${empHint ? `ВИМОГА: ${empHint}\n` : ""}1. Організація дослідження: ${rd?.groups?.length ? `вибірка по групах: ${rd.groups.map(g => `${g.name}${g.minN ? ` (n≥${g.minN})` : ""}${g.criteria ? `, ${g.criteria}` : ""}`).join("; ")}` : "вибірка — кількість, категорії, критерії відбору"}.
2. Біографічний блок анкети: ${bioDesc}.
3. Метод: ${rd?.instrumentType === "fitness_test" ? "фізичне тестування" : rd?.instrumentType === "psycho_scale" ? "психологічна методика/шкала" : rd?.instrumentType === "pedagogical_experiment" ? "педагогічний експеримент" : "анкетування"}. ${appendicesText ? "Мета та кількість запитань — точно як в Додатку А." : "Опиши мету та орієнтовну кількість питань."}
4. Принцип проведення: умови та порядок, якщо кілька груп — опиши кожну окремо.
5. Результати: таблиця markdown (|---|---| формат) ${tableDataSource}.${compTableInstruction}
6. Аналіз: інтерпретація результатів.${appendixRef}`;
      } else if (secIdx < practicalSecs.length - 1) {
        empiricalBlock = `

КОНТЕКСТ (емпіричне дослідження):
${appendixBlock}${empHint ? `ВИМОГА: ${empHint}\n` : ""}Цей підрозділ продовжує аналіз результатів. Таблиця markdown (|---|---| формат) ${tableDataSource}.${compTableInstruction} Аналіз і висновки. Не повторюй опис вибірки та методики.`;
      } else {
        empiricalBlock = `

КОНТЕКСТ (емпіричне дослідження):
${appendixBlock}${empHint ? `ВИМОГА: ${empHint}\n` : ""}Рекомендації на основі результатів дослідження з попередніх підрозділів. Не повторюй опис вибірки та методики.`;
      }
    }

    let practicalBlock = "";
    const practicalApproachRun = commentAnalysis?.practicalApproach;
    if (practicalApproachRun && practicalApproachRun !== "questionnaire" && ["analysis", "recommendations"].includes(sec.type)) {
      const appRef = appendicesText ? "\nДодай речення з посиланням на Додаток А." : "";
      const appCtx = appendicesText ? `\nДОДАТОК А (вже згенерований — спирайся на нього точно):\n${appendicesText}\n` : "";
      if (practicalApproachRun === "textbook_analysis") {
        practicalBlock = `

ОБОВ'ЯЗКОВО для цього підрозділу (аналіз підручників):${appCtx}Визнач за назвою підрозділу що саме писати:
- підрозділ про критерії або методику аналізу: опиши принципи відбору підручників, параметри порівняння (структура, зміст, типи вправ, ілюстрації, методичний апарат, відповідність програмі).
- підрозділ про аналіз або результати: таблиця markdown з порівнянням підручників за критеріями (спирайся на Додаток А). Після таблиці детальний аналіз кожного підручника.${appRef}
- підрозділ про висновки або рекомендації: порівняльні висновки, який підручник краще відповідає меті навчання і чому.`;
      } else if (practicalApproachRun === "lesson_observation") {
        practicalBlock = `

ОБОВ'ЯЗКОВО для цього підрозділу (аналіз уроків):${appCtx}Визнач за назвою підрозділу що саме писати:
- підрозділ про методику спостереження: опиши протокол спостереження (Додаток А), кількість спостережуваних уроків, вчителів, клас.${appRef}
- підрозділ про результати: таблиця markdown з результатами спостережень за аспектами (мотивація, пояснення, практика, організація тощо). Аналіз виявлених закономірностей.
- підрозділ про рекомендації: методичні рекомендації вчителям на основі результатів спостережень.`;
      } else if (practicalApproachRun === "materials_development") {
        practicalBlock = `

ОБОВ'ЯЗКОВО для цього підрозділу (розробка матеріалів):${appCtx}Визнач за назвою підрозділу що саме писати:
- підрозділ про теоретичне обґрунтування: принципи розробки матеріалів, психолого-педагогічне підґрунтя вибору підходу.
- підрозділ про опис матеріалів: детальний опис розроблених матеріалів (Додаток А) — структура, призначення, як використовувати на практиці.${appRef}
- підрозділ про апробацію або ефективність: результати практичного застосування або обґрунтування очікуваної ефективності матеріалів.`;
      }
    }

    const secSourceLines = (citInputs[sec.id] || "").split("\n").map(l => l.trim()).filter(Boolean);
    const sourcesBlock = secSourceLines.length > 0
      ? `\nДЖЕРЕЛА ДЛЯ ЦЬОГО ПІДРОЗДІЛУ (${secSourceLines.length} шт.) — спирайся на них при написанні, вставляй посилання [N] після відповідних тверджень:\n${secSourceLines.map((s, i) => {
        const snippet = abstractsMap[s];
        return snippet ? `[${i + 1}] ${s}\n    Зміст: ${snippet}` : `[${i + 1}] ${s}`;
      }).join("\n")}\n`
      : "";
    const citNote = secSourceLines.length > 0
      ? "Вставляй [N] у текст одразу після тверджень що спираються на джерело (де N — номер зі списку вище). ЗАБОРОНЕНО вигадувати імена авторів перед цитатою — не пиши 'Іванов А. стверджує...'. Використовуй безособові конструкції: 'у дослідженні зазначається [N]', 'науковці вказують [N]', 'встановлено [N]' тощо. Цитата в тексті — ЛИШЕ [N] (технічна позначка), НІКОЛИ не пиши саму цитату (прізвище, рік, сторінку) в жодному вигляді, ні круглими, ні квадратними дужками — фінальний стиль оформлення підставить система пізніше. Посилайся ЛИШЕ на джерела зі списку вище під їхніми номерами — не згадуй і не посилайся на будь-яке дослідження чи автора, якого немає в цьому списку. Розподіляй посилання рівномірно між усіма наданими джерелами — спочатку використай кожне хоч раз, і лише потім за потреби повторюй. Одне й те саме джерело [N] НЕ цитувати більше 2 разів у межах цього підрозділу."
      : "Без посилань [1],[2].";

    const priorMainSecIds = sections.slice(0, sections.findIndex(s => s.id === sec.id))
      .filter(s => !["intro", "conclusions", "sources", "chapter_conclusion"].includes(s.type) && content[s.id]);
    const priorOpeningsBlock = priorMainSecIds.length
      ? `\n\nУЖЕ НАПИСАНІ ПОЧАТКИ ПОПЕРЕДНІХ ПІДРОЗДІЛІВ ЦІЄЇ Ж РОБОТИ (не повторюй ні структуру речень, ні перше слово, ні порядок "теза-приклад-висновок" — обери інший стиль відкриття й інший ритм):\n${priorMainSecIds.map((s, i) => `${i + 1}. ${extractOpeningSentences(content[s.id])}`).join("\n")}`
      : "";

    instruction = `Напиши підрозділ "${sec.label}" для ${d.type} на тему "${d.topic}". Галузь: ${d.subject}.
Тип підрозділу: ${typeHints[sec.type] || "основний"}.
${methodReq ? `ВИМОГИ МЕТОДИЧКИ ДО ЦЬОГО РОЗДІЛУ: ${methodReq}` : ""}${enterpriseProfileBlock}${empiricalBlock}${practicalBlock}${econBlock}${technicalBlock}${secMethodsHint}${sourcesBlock}${priorOpeningsBlock}
ПЛАН РОБОТИ (для розуміння структури та уникнення повторів):
${planSummary}

Обсяг: приблизно ${Math.round((sec.pages || 1) * 230)} слів (~${sec.pages} стор.).
Не обривай текст. Завершуй підсумковим абзацом. ${citNote} Без жирного.
ЗАБОРОНЕНО вставляти будь-які внутрішні підназви, заголовки абзаців або окремі рядки-мітки ("Загальна картина", "Результати аналізу" тощо). Кожен рядок тексту — повне речення, рядок таблиці або підпис до таблиці/рисунка.
Абзаци мають різнитись за довжиною: чергуй короткі (2-3 речення) з довшими (5-7 речень).`;

    const secIllustrations = getIllustrationsForSection(sec, order.illustrationDescs, order.illustrations);
    if (methodInfo?.hasFigures && !secIllustrations.length) {
      const chapterMainTypes = ["theory", "analysis", "recommendations"];
      const currentChapNum = sec.id.split(".")[0];
      const chapterSecs = sections.filter(s => chapterMainTypes.includes(s.type) && s.id.split(".")[0] === currentChapNum);
      const isLastInChapter = chapterSecs[chapterSecs.length - 1]?.id === sec.id;
      const hasFigureAlready = chapterSecs.some(s => s.id !== sec.id && (hasRealFigure(content[s.id] || "") || getIllustrationsForSection(s, order.illustrationDescs, order.illustrations).length));
      if (isLastInChapter && !hasFigureAlready) {
        instruction += `\n\nОБОВ'ЯЗКОВО: жоден інший підрозділ цього розділу ще не містить рисунка — цей підрозділ МАЄ містити хоча б один рисунок (графік із таблиці даних або PlantUML-схема за правилами FIGURES вище), інакше вимога методички "щонайменше один рисунок на розділ" буде порушена.`;
      }
    }
  }
  const clientWritingReqs = [
    commentAnalysis?.writingHints,
    commentAnalysis?.textStructureHints,
  ].filter(Boolean).join("\n");
  if (clientWritingReqs) instruction += `\n\nВИМОГИ КЛІЄНТА (ОБОВ'ЯЗКОВО виконати при написанні):\n${clientWritingReqs}`;
  const secIllustrations = getIllustrationsForSection(sec, order.illustrationDescs, order.illustrations);
  if (secIllustrations.length) {
    const hasIndex = secIllustrations.every(ill => ill.index != null);
    const illLines = secIllustrations.map(ill =>
      `Рис. ${ill.figureNum}${ill.caption ? ` – ${ill.caption}` : ""}: ${ill.description}${hasIndex ? ` — маркер вставки: [КЛІЄНТ-ІЛЮСТРАЦІЯ:${ill.index}]` : ""}`
    ).join("\n");
    instruction += `\n\nІЛЮСТРАЦІЇ КЛІЄНТА ДО ЦЬОГО ПІДРОЗДІЛУ (вже надані, треба вставити в текст):\n${illLines}\nОБОВ'ЯЗКОВО для кожної ілюстрації: 1) додай посилання на неї в тексті (напр. "як показано на Рис. X.Y..."), використовуючи нумерацію X.Y відповідно до номера підрозділу;${hasIndex ? " 2) безпосередньо ПЕРЕД стандартним підписом рисунка (Рис. X.Y – Назва) додай окремим рядком точно вказаний вище маркер вставки у форматі [КЛІЄНТ-ІЛЮСТРАЦІЯ:N] — без жодних змін, більше нічого на цьому рядку." : ""}`;
  }
  const isTechnicalSecFinal = getTechnicalSections(sections, d).includes(sec.id);
  const materialsRaw = clientMaterialsSummary?.rawText || clientMaterialsText?.trim() || "";
  const materialsBlock = materialsRaw
    ? `МАТЕРІАЛИ КЛІЄНТА (використовуй ці дані - не вигадуй, не замінюй):\n${materialsRaw.slice(0, 80000)}${isTechnicalSecFinal ? `\n\n${CODE_GROUNDING_RULE}` : ""}`
    : "";
  if (materialsBlock) instruction += `\n\nДив. МАТЕРІАЛИ КЛІЄНТА нижче в системному промпті - використовуй ці дані, не вигадуй і не замінюй їх.`;
  const genOpts = { cache: true, ...(materialsBlock ? { extraCached: [materialsBlock] } : {}), onCost: ctx.onCost };
  const sectionMaxTokens = Math.min(60000, Math.max(8000, Math.round((sec.pages || 1) * 3000)));
  const cleanResult = (raw) => typographQuotes(stripStrayCJK(fixMixedScript(raw, lang)
    .replace(/ — /g, ", ").replace(/— /g, " ").replace(/ —/g, " "), lang), lang)
    .replace(/(\[[^\]]*)\]\s*\[([^\]]*\])/g, "$1; $2")
    .replace(/(\[[^\]]*)\]\s*\[([^\]]*\])/g, "$1; $2");
  const targetWords = sec.type === "chapter_conclusion" ? 115 : Math.round((sec.pages || 1) * 230);
  const styleProfile = getStyleProfileForSection(sec);

  const raw = await doCallClaude(buildMessages(instruction), signal, buildSYS(lang, methodInfo, normalizeWorkType(d.type, d.course), styleProfile), sectionMaxTokens, (s) => onProgress?.(`Генерую: ${sec.label}... зачекайте ${s}с`), undefined, genOpts);
  const cleaned = cleanResult(raw);
  const result = sec.type === "sources" ? cleaned : await enforceWordCount({
    text: cleaned, targetWords, label: sec.label, callClaude: doCallClaude,
    sys: buildSYS(lang, methodInfo, normalizeWorkType(d.type, d.course), styleProfile), signal, onProgress, clean: cleanResult,
    cacheOpts: genOpts,
  });

  let finalResult = result;
  let nextCitInputs = citInputs;
  let nextAbstractsMap = abstractsMap;
  let nextSourceThesisMap = sourceThesisMap;
  const localSourceLines = (citInputs[sec.id] || "").split("\n").map(l => l.trim()).filter(Boolean);
  if (localSourceLines.length && !signal?.aborted) {
    const citedLocalNums = new Set(extractCitedNumbers(finalResult));
    const missingLocal = localSourceLines
      .map((line, i) => ({
        number: i + 1, marker: `[${i + 1}]`, sourceText: line,
        abstract: abstractsMap[line], thesis: sourceThesisMap[line],
      }))
      .filter(s => !citedLocalNums.has(s.number));
    if (missingLocal.length) {
      onProgress?.(`Довставляю пропущені джерела: ${sec.label}...`);
      try {
        const { text, unresolved } = await insertMissingCitations({
          sectionText: finalResult, insertions: missingLocal, lang, callClaude: doCallClaude, signal,
        });
        finalResult = cleanResult(text);

        const updatedLines = [...localSourceLines];
        let linesChanged = false;
        if (unresolved.length && !signal?.aborted) {
          for (const num of unresolved) {
            const idx = num - 1;
            const oldLine = localSourceLines[idx];
            const thesis = sourceThesisMap[oldLine];
            if (!thesis) continue;
            onProgress?.(`Шукаю заміну джерела: ${sec.label}...`);
            const replacement = await retryUnmatchedSource({
              order, secId: sec.id, sectionText: finalResult, marker: `[${num}]`, thesis, lang, signal, ctx,
            });
            if (replacement) {
              finalResult = cleanResult(replacement.text);
              updatedLines[idx] = replacement.newLine;
              linesChanged = true;
              if (replacement.paper.abstract) {
                nextAbstractsMap = { ...nextAbstractsMap, [replacement.newLine]: replacement.paper.abstract };
              }
              nextSourceThesisMap = { ...nextSourceThesisMap, [replacement.newLine]: thesis };
            }
          }
        }
        if (linesChanged) {
          nextCitInputs = { ...nextCitInputs, [sec.id]: updatedLines.join("\n") };
        }
      } catch (e) { console.error("Довставлення пропущених джерел одразу після генерації:", e); }
    }
  }

  finalResult = capCitationRepeats(finalResult);

  if (!signal?.aborted) {
    try {
      finalResult = await fixDanglingFigures({ text: finalResult, lang, callClaude: doCallClaude, signal });
    } catch (e) { console.error("fixDanglingFigures:", e.message); }
  }

  const newContent = { ...content, [sec.id]: finalResult };

  let nextGlossary = glossary;
  if (["theory", "analysis", "recommendations"].includes(sec.type) && !signal?.aborted) {
    try {
      onProgress?.(`Виділяю терміни: ${sec.label}...`);
      const glossPrompt = `Текст підрозділу "${sec.label}" ${d.type} на тему "${d.topic}":\n\n${finalResult.slice(0, 16000)}\n\nВиділи 3-6 ключових авторських термінів, назв методик/моделей/технологій чи багаторівневих структур (напр. "Етап 1 – Етап 2 – Етап 3"), ВВЕДЕНИХ саме в цьому тексті. Якщо таких немає — поверни порожній масив.\nВідповідь — ТІЛЬКИ JSON масив рядків, напр. ["термін 1", "термін 2"].`;
      const glossRaw = await doCallClaude([{ role: "user", content: glossPrompt }], null, SYS_JSON_ARRAY, 300, null, MODEL_FAST, { onCost: ctx.onCost });
      const terms = JSON.parse(glossRaw.match(/\[[\s\S]*\]/)?.[0] || "[]");
      if (terms.length) nextGlossary = { ...nextGlossary, [sec.id]: terms.join("; ") };
    } catch (e) { console.error("Глосарій термінів підрозділу:", e.message); }
  }

  return {
    content: newContent,
    citInputs: nextCitInputs,
    abstractsMap: nextAbstractsMap,
    sourceThesisMap: nextSourceThesisMap,
    glossary: nextGlossary,
  };
}

// ── Дефолтний план (без методички, без плану клієнта) — перенесено з
// academic-assistant.jsx без змін логіки ──
function buildDefaultPlan(totalPages, lang = "Українська", chapCountOverride = null) {
  const lc = getLangLabels(lang);
  const needThirdChapter = totalPages >= 40;
  const mainPages = Math.round(totalPages * 0.80);
  const chapCount = chapCountOverride || (needThirdChapter ? 3 : 2);
  const pagesPerCh = Math.max(1, Math.round(mainPages / chapCount));
  const pagesPerSub = Math.max(1, Math.round(pagesPerCh / 3));
  const introPages = 2;
  const concPages = totalPages > 40 ? 3 : 2;
  const chapterNames = lc.chapterTemplate.slice(0, chapCount);
  const chTypes = ["theory", "analysis", "recommendations"];
  const sections = [];
  chapterNames.forEach((chName, ci) => {
    const chapNum = ci + 1;
    for (let i = 1; i <= 3; i++) sections.push({ id: `${chapNum}.${i}`, label: `${chapNum}.${i} [${lc.subsWord} ${chapNum}.${i}]`, sectionTitle: chName, pages: pagesPerSub, type: chTypes[ci] });
  });
  sections.push({ id: "intro", label: lc.intro, pages: introPages, type: "intro" });
  sections.push({ id: "conclusions", label: lc.conclusions, pages: concPages, type: "conclusions" });
  sections.push({ id: "sources", label: lc.sources, pages: 1, type: "sources" });
  return sections;
}

/**
 * Генерує план роботи. Дерево гілок із гарантованим запасним варіантом
 * (buildDefaultPlan) у кінці — на відміну від runWritingSection, тут НЕ
 * потрібне покрокове відновлення: кожна гілка або вдається одразу, або
 * (перехоплено try/catch) провалюється до наступної, аж до дефолту. Повторний
 * виклик після збою просто безпечно повторює весь підбір — жодна гілка не
 * лишає замовлення в напівготовому стані.
 *
 * @param {object} order - те саме, що й для runWritingSection, плюс:
 *   comment, clientPlan, readyWorkText, illustrationsPdf
 * @param {object} ctx - { callClaude, callGemini, onProgress?, onCost?,
 *   extractIllustrationsFromPdf?(pdfFile, descs) } — останнє потрібне лише
 *   коли order.illustrationsPdf заданий і треба витягти реальні зображення
 *   сторінок (браузер має pdfjs для цього; воркер поки може це пропустити —
 *   illustrationDescs все одно повернуться, просто без картинок-джерел).
 * @returns {Promise<object>} патч полів (sections, planDisplay, info, stage,
 *   status, і залежно від гілки — content/citInputs/readyWorkImportedIds/
 *   illustrations/illustrationDescs/readyWorkNeedsManualAI), а також
 *   clientPlanIssues — попередження перевірки плану клієнта ([] — усе гаразд)
 */
export async function runPlanStage(order, ctx) {
  // План клієнта може прийти разом з іншим текстом (обґрунтування, мета, завдання…) —
  // далі йде лише вирізаний кодом план; сам order.clientPlan у Firestore не чіпаємо.
  if (!order.clientPlan?.trim()) return { ...(await runPlanStageInner(order, ctx)), clientPlanIssues: [] };
  const clientPlan = extractPlanBlock(order.clientPlan).trim();
  const patch = await runPlanStageInner({ ...order, clientPlan }, ctx);
  return { ...patch, clientPlanIssues: checkPlanIssues(clientPlan, { topic: order.info?.topic }) };
}

async function runPlanStageInner(order, ctx) {
  const { callClaude, callGemini, onProgress } = ctx;
  const d = order.info;
  const totalPages = parsePagesAvg(d.pages);
  const wc = buildWorkConfig({ info: d, methodInfo: order.methodInfo, commentAnalysis: order.commentAnalysis });
  const introP = wc.introPages;
  const conclP = wc.conclusionsPages;
  const L = getLangLabels(d?.language);
  const requestedChapCountRaw = detectRequestedChapterCount(
    [order.comment, order.clientMaterialsSummary?.rawText, order.clientMaterialsText].filter(Boolean).join("\n")
  );
  const requestedChapCount = requestedChapCountRaw ? Math.min(Math.max(requestedChapCountRaw, 1), 3) : null;

  let readyWorkNeedsManualAI = false;

  // Які розділи писати: write_scope з CRM, а якщо його немає, але є готова частина — з коментаря
  // клієнта ("Потрібно виконати 2-й розділ" → лише розділ 2; "розділи 2-3" → 2 і 3, обсяг з
  // замовлення ділиться між ними). Без цього дописувалось усе, чого бракує за планом (кейс 41570).
  const hasReadyPart = !!(order.readyWorkText?.trim() || order.readyWorkPreExtracted);
  const writeScope = order.writeScope || (hasReadyPart ? detectWriteScopeFromComment(order.comment) : null);

  // Часткова робота (order.writeScope = {chapters:[2], pages:25} з CRM): лишаємо лише розділи зі списку
  // (+ уже наявні розділи з готової частини, як є), без вступу/висновків/джерел, якщо їх немає в готовій
  // частині; обсяг scope.pages ділимо між НОВИМИ підрозділами.
  const applyWriteScope = (secs, scope, keepIds = new Set()) => {
    if (!scope?.chapters?.length) return secs;
    const chap = (id) => parseInt(String(id).split(".")[0], 10);
    const kept = secs.filter(s => keepIds.has(s.id) || (!isNaN(chap(s.id)) && scope.chapters.includes(chap(s.id))));
    const fresh = kept.filter(s => !keepIds.has(s.id) && s.type !== "chapter_conclusion" && !s.headingOnly);
    // Висновки до розділу займають фіксовано ~1 сторінку (targetWords=115 у runWritingSection) —
    // не ділять бюджет порівну зі звичайними підрозділами, інакше на них іде непропорційно
    // багато заявлених сторінок (бачили pages:8 замість pages:1 у тесті на writeScope).
    const freshConclCount = kept.filter(s => !keepIds.has(s.id) && s.type === "chapter_conclusion").length;
    if (scope.pages && fresh.length) {
      const split = splitPagesEvenly(scope.pages - freshConclCount, fresh.length);
      fresh.forEach((s, i) => { s.pages = split[i]; });
    }
    // Список джерел потрібен і для часткової роботи: готова частина + дописане = один файл
    // з одним спільним списком (обсягу scope.pages не забирає — він лише для тексту розділів)
    return withSourcesSec(kept);
  };
  // Рівно total сторінок на n пунктів, залишок — першим (10 на 4 → 3,3,2,2, а не 3×4=12)
  const splitPagesEvenly = (total, n) => {
    const t = Math.max(n, Math.round(total));
    const base = Math.floor(t / n), rem = t % n;
    return Array.from({ length: n }, (_, i) => base + (i < rem ? 1 : 0));
  };
  const withSourcesSec = (secs) => {
    if (d?.includeSources === false || secs.some(s => s.type === "sources")) return secs;
    return [...secs, { id: "sources", label: L.sources, pages: 1, type: "sources" }];
  };
  // Порядок за всіма рівнями номера (1.1 → 1.1.1 → 1.2), "Висновки до розділу N" — в кінці
  // розділу N; дописаний розділ 1 стає перед готовим розділом 2
  const sortByNumber = (secs) => {
    const orderKey = (s) => s.type === "intro" ? [-1]
      : s.type === "conclusions" ? [1e9] : s.type === "sources" ? [1e9 + 1]
      : String(s.id).split(".").map(x => /^\d+$/.test(x) ? Number(x) : 1e6);
    return [...secs].sort((a, b) => {
      const ka = orderKey(a), kb = orderKey(b);
      for (let k = 0; k < Math.max(ka.length, kb.length); k++) {
        if (ka[k] === undefined) return -1;
        if (kb[k] === undefined) return 1;
        if (ka[k] !== kb[k]) return ka[k] - kb[k];
      }
      return 0;
    });
  };

  const finalizeSections = async (secsIn) => {
    const secs = secsIn.filter(s => {
      if (s.type === "intro" && d?.includeIntro === false) return false;
      if (s.type === "conclusions" && d?.includeConclusions === false) return false;
      if (s.type === "sources" && d?.includeSources === false) return false;
      return true;
    });
    const mapped = secs.map(s => {
      let label = s.label;
      if (s.id && /^\d+\.\d+$/.test(s.id) && !label.startsWith(s.id)) {
        label = `${s.id} ${label}`;
      }
      return { ...s, label, prompts: (s.type === "sources" || s.headingOnly) ? 0 : Math.max(1, Math.ceil((s.pages || 1) / 3)) };
    });

    const withPrompts = (() => {
      const currentTotal = mapped.reduce((sum, s) => sum + (s.pages || 0), 0);
      if (currentTotal === totalPages) return mapped;
      // headingOnly-«шапки» (1.1 перед 1.1.1) лишаються з 0 сторінок — обсяг лише кінцевим пунктам
      const mainIdxs = mapped.reduce((acc, s, i) => {
        if (!["intro", "conclusions", "sources", "chapter_conclusion"].includes(s.type) && !s.headingOnly) acc.push(i);
        return acc;
      }, []);
      const fixedTotal = mapped.reduce((sum, s, i) => mainIdxs.includes(i) ? sum : sum + (s.pages || 0), 0);
      const pagesForMain = Math.max(mainIdxs.length, totalPages - fixedTotal);
      const currentMainTotal = mainIdxs.reduce((sum, i) => sum + (mapped[i].pages || 1), 0);
      const result = [...mapped];
      let assigned = 0;
      mainIdxs.forEach((idx, j) => {
        const isLast = j === mainIdxs.length - 1;
        const p = isLast
          ? Math.max(1, pagesForMain - assigned)
          : Math.max(1, Math.round((mapped[idx].pages / currentMainTotal) * pagesForMain));
        result[idx] = { ...result[idx], pages: p, prompts: Math.max(1, Math.ceil(p / 3)) };
        if (!isLast) assigned += p;
      });
      return result;
    })();

    const { dist, total } = calcSourceDist(withPrompts, parsePagesAvg(d?.pages));
    const patch = {
      sections: withPrompts, planDisplay: buildPlanText(withPrompts),
      info: { ...d, sourceCount: String(total) },
      stage: "plan", status: "plan_ready",
      readyWorkNeedsManualAI,
      sourceDist: dist, sourceTotal: total,
      sourcesMinRequired: wc.sourcesMinRequired,
    };
    if (order.illustrations?.length > 0 || order.illustrationsPdf) {
      try {
        let illContent;
        if (order.illustrationsPdf) {
          illContent = [
            { type: "document", source: { type: "base64", media_type: "application/pdf", data: order.illustrationsPdf.b64 } },
            { type: "text", text: buildIllustrationsPdfPrompt({ topic: d?.topic, planSections: withPrompts, lang: d?.language }) },
          ];
        } else {
          illContent = order.illustrations.map(ill => ({
            type: "image", source: { type: "base64", media_type: ill.type, data: ill.b64 }
          }));
          illContent.push({ type: "text", text: buildIllustrationsPrompt({ topic: d?.topic, illustrations: order.illustrations, planSections: withPrompts, lang: d?.language }) });
        }
        const illRaw = await callClaude([{ role: "user", content: illContent }], null, SYS_JSON_ARRAY, 1500, null, MODEL_FAST, { onCost: ctx.onCost });
        const illMatch = illRaw.match(/\[[\s\S]*\]/);
        const illParsed = JSON.parse(illMatch?.[0] || illRaw);
        patch.illustrationDescs = illParsed;
        if (order.illustrationsPdf && ctx.extractIllustrationsFromPdf) {
          const built = await ctx.extractIllustrationsFromPdf(order.illustrationsPdf, illParsed);
          if (built?.length) patch.illustrations = built;
        }
      } catch (e) {
        console.warn("illustrationDescs re-analysis in plan:", e.message);
      }
    }
    // Готову частину роботи клієнта більше НЕ підганяємо автоматично через ШІ тут — код-розпізнавання
    // вже спробувало це вище; якщо не вийшло, клієнтка сама натискає кнопку "Аналізувати через ШІ".
    return patch;
  };

  // Якщо клієнт надав готову частину роботи — беремо структуру З НЕЇ (реальні заголовки й реальний обсяг),
  // а не вигадуємо нову структуру і не підганяємо готовий текст під неї. Спочатку пробуємо чистим кодом
  // (безкоштовно, миттєво); лише якщо код не зміг розпізнати заголовки — падаємо на ШІ-резерв.
  // readyWorkPreExtracted — структура, яку вже розібрав ШІ (кнопка "Аналізувати через ШІ" в UI):
  // далі та сама логіка продовження, що й після розбору кодом
  if (order.readyWorkText?.trim() || order.readyWorkPreExtracted) {
    try {
      onProgress?.("Аналізую структуру готової частини роботи клієнта...");
      const planSections = order.clientPlan?.trim() ? quickParsePlanIds(order.clientPlan) : null;
      const extracted = order.readyWorkPreExtracted
        || extractReadyWorkStructure({ documentText: order.readyWorkText, lang: d?.language, planSections });

      if (extracted) {
        let finalSecs = extracted.sections;
        let finalContent = extracted.content;

        if (!order.clientPlan?.trim()) {
          const chapNums = finalSecs.map(s => parseInt(String(s.id).split(".")[0], 10)).filter(n => !isNaN(n));
          const lastChapNum = chapNums.length ? Math.max(...chapNums) : 0;
          const existingPages = finalSecs.reduce((sum, s) => sum + (s.pages || 0), 0);
          const scope = writeScope;
          // К-сть сторінок у замовленні при продовженні — обсяг саме НОВИХ розділів, чистий текст
          // від "Розділ N" до його кінця (підрозділи + висновки до розділу); вступ, висновки, список
          // джерел, зміст, анотація в нього не входять і пишуться понад нього:
          // готовий розділ на 20 с. + "25 с." у замовленні = новий розділ на 25 с.
          const continuationBudget = scope?.pages || totalPages;
          const desiredChapCount = scope ? Math.max(lastChapNum, ...scope.chapters) : Math.max(lastChapNum, order.methodInfo?.chaptersCount || ((existingPages + continuationBudget) >= 40 ? 3 : 2));
          const hasIntro = finalSecs.some(s => s.type === "intro");
          const hasConclusions = finalSecs.some(s => s.type === "conclusions");
          const hasSources = finalSecs.some(s => s.type === "sources");
          const needsChapterConcl = order.methodInfo?.hasChapterConclusions === true;
          // Усі відсутні розділи, а не лише ті, що після останнього готового: є розділ 2 — пишемо й розділ 1
          const existingChapNums = new Set(chapNums);
          const missingChapNums = [];
          for (let n = 1; n <= desiredChapCount; n++) if (!existingChapNums.has(n) && (!scope || scope.chapters.includes(n))) missingChapNums.push(n);

          if (missingChapNums.length || !hasSources || (!scope && (!hasIntro || !hasConclusions))) {
            onProgress?.("Догенеровую відсутні розділи (продовження)...");
            const contLC = getLangLabels(d?.language);
            let newChapterData = [];
            if (missingChapNums.length) {
              try {
                const subsOverrides = order.methodInfo?.subsectionsPerChapterOverrides || {};
                const defaultSubsPerChapter = order.methodInfo?.subsectionsPerChapter || 3;
                const existingChapterTitles = [...new Set(finalSecs.filter(s => s.sectionTitle).map(s => s.sectionTitle))];
                const prompt = buildContinuationPlanPrompt({
                  topic: d.topic, subject: d.subject, type: d.type, lang: d?.language,
                  existingChapterTitles,
                  newChapters: missingChapNums.map(num => ({
                    num,
                    subsCount: subsOverrides[String(num)] ?? defaultSubsPerChapter,
                    forcedType: order.methodInfo?.chapterTypes?.[num - 1],
                  })),
                  otherRequirements: order.methodInfo?.otherRequirements,
                });
                const raw = await callClaude([{ role: "user", content: prompt }], null, SYS_JSON, 2000, null, MODEL_FAST, { onCost: ctx.onCost });
                const jsonMatch = raw.match(/\{[\s\S]*\}/);
                const parsed = parseJsonLoose(raw);
                newChapterData = parsed.chapters || [];
              } catch (e) { console.error("Продовження плану:", e); }
            }

            const newSubCount = newChapterData.reduce((sum, c) => sum + (c.subsections?.length || 0), 0);
            const introPages = (hasIntro || scope) ? 0 : 2;
            const conclPages = (hasConclusions || scope) ? 0 : 3;
            const srcPages = hasSources ? 0 : 1;
            const chapConclCount = needsChapterConcl ? newChapterData.length : 0;
            // вступ/висновки/джерела — понад обсяг, весь бюджет іде в текст нових розділів
            const pagesForSubs = Math.max(newSubCount, continuationBudget - chapConclCount);
            const pagesPerSub = newSubCount ? Math.max(1, Math.round(pagesForSubs / newSubCount)) : 0;

            const newChapterSecs = [];
            newChapterData.forEach(c => {
              const forcedType = order.methodInfo?.chapterTypes?.[c.num - 1];
              (c.subsections || []).forEach((subLabel, i) => {
                const idMatch = subLabel.match(/^(\d+\.\d+)/);
                const id = idMatch ? idMatch[1] : `${c.num}.${i + 1}`;
                newChapterSecs.push({ id, label: subLabel, sectionTitle: c.title, pages: pagesPerSub, type: forcedType || c.type || "theory" });
              });
              if (needsChapterConcl) {
                newChapterSecs.push({ id: `${c.num}.conclusions`, label: contLC.chapConclLabel(c.num), sectionTitle: c.title, pages: 1, type: "chapter_conclusion" });
              }
            });

            const mainExisting = finalSecs.filter(s => !["intro", "conclusions", "sources"].includes(s.type));
            const introSec = finalSecs.find(s => s.type === "intro") || ((hasIntro || scope) ? null : { id: "intro", label: contLC.intro, pages: introPages, type: "intro" });
            const conclSec = finalSecs.find(s => s.type === "conclusions") || ((hasConclusions || scope) ? null : { id: "conclusions", label: contLC.conclusions, pages: conclPages, type: "conclusions" });
            const srcSec = finalSecs.find(s => s.type === "sources") || (hasSources ? null : { id: "sources", label: contLC.sources, pages: srcPages, type: "sources" });

            finalSecs = sortByNumber([introSec, ...mainExisting, ...newChapterSecs, conclSec, srcSec].filter(Boolean));
          }
        } else {
          const foundIdsSet = new Set(finalSecs.map(s => s.id));
          const scope = writeScope;
          const inScope = (id) => !scope || scope.chapters.includes(parseInt(String(id).split(".")[0], 10));
          const tailLC = getLangLabels(d?.language);
          // Вступ/висновки/список джерел, яких немає в готовій частині (крім часткової роботи за writeScope)
          const tailSecs = scope ? [] : [
            !finalSecs.some(s => s.type === "intro") && { id: "intro", label: tailLC.intro, pages: 2, type: "intro" },
            !finalSecs.some(s => s.type === "conclusions") && { id: "conclusions", label: tailLC.conclusions, pages: 3, type: "conclusions" },
            !finalSecs.some(s => s.type === "sources") && { id: "sources", label: tailLC.sources, pages: 1, type: "sources" },
          ].filter(Boolean);
          // Повний розбір плану, а не лише id: дописаним розділам потрібні назви розділів
          // (sectionTitle — інакше в експорті голе "РОЗДІЛ 1"), пункти 3-4 рівня і «шапки»
          const missingSecs = (parseClientPlan(order.clientPlan, totalPages, d?.language) || [])
            .filter(p => !["intro", "conclusions", "sources"].includes(p.type) && !foundIdsSet.has(p.id) && inScope(p.id));
          if (missingSecs.length) {
            // К-сть сторінок у замовленні при продовженні — обсяг саме НОВИХ розділів (чистий текст
            // від "Розділ N" до кінця), а не загальний разом з готовою: ділимо його між новими
            // пунктами плану; дописувані вступ/висновки/список джерел — понад цей обсяг.
            // "Висновки до розділу" серед дописуваного не беруть участь у рівному діленні —
            // їм завжди pages:1 (targetWords=115 у runWritingSection), інакше вони забирають
            // непропорційну частку бюджету нарівні зі звичайними підрозділами.
            const chapConclInMissing = missingSecs.filter(p => p.type === "chapter_conclusion").length;
            const leafCount = missingSecs.filter(p => !p.headingOnly && p.type !== "chapter_conclusion").length;
            const pagesLeft = Math.max(leafCount, (scope?.pages || totalPages) - chapConclInMissing);
            const leafPages = splitPagesEvenly(pagesLeft, Math.max(leafCount, 1));
            let leafI = 0;
            finalSecs = [...finalSecs, ...missingSecs.map(p => ({
              ...p,
              pages: p.headingOnly ? 0 : p.type === "chapter_conclusion" ? 1 : leafPages[leafI++],
            }))];
          }
          if (!scope) {
            finalSecs = [...tailSecs.filter(s => s.type === "intro"), ...finalSecs, ...tailSecs.filter(s => s.type !== "intro")];
          } else {
            finalSecs = applyWriteScope(finalSecs, scope, new Set(extracted.foundIds || []));
          }
          finalSecs = sortByNumber(finalSecs);
        }

        const mergedContent = { ...order.content, ...finalContent };
        const mergedCitInputs = { ...order.citInputs, ...extracted.citInputs };
        // Джерела шукаємо лише для дописуваних підрозділів — у готових вони вже є з документа клієнта
        const importedSet = new Set(extracted.foundIds || []);
        const { dist, total } = calcSourceDist(finalSecs.filter(s => !importedSet.has(s.id)));
        return {
          sourceDist: dist, sourceTotal: total,
          sections: finalSecs, planDisplay: buildPlanText(finalSecs),
          content: mergedContent, citInputs: mergedCitInputs,
          readyWorkImportedIds: extracted.foundIds, stage: "plan", status: "plan_ready",
          readyWorkNeedsManualAI: false,
        };
      }

      // Код не зміг розпізнати заголовки (нестандартне оформлення) — НЕ викликаємо ШІ автоматично.
      // Звичайний план згенерується як завжди нижче; аналіз через ШІ клієнтка запускає вручну кнопкою на етапі плану.
      console.warn("Структура з готової роботи: розпізнано замало розділів, повертаюсь до звичайної генерації плану");
      readyWorkNeedsManualAI = true;
    } catch (e) { console.error("Витяг структури з готової роботи:", e); }
  }

  if (order.clientPlan?.trim()) {
    const parsed = parseClientPlan(order.clientPlan.trim(), writeScope?.pages || totalPages, d?.language);
    if (parsed) return await finalizeSections(applyWriteScope(parsed, writeScope));
  }

  // Якщо на фото є готовий план — використати його структуру як шаблон (тільки якщо план клієнта не надано)
  if (!order.clientPlan?.trim() && order.commentAnalysis?.photoTOC && typeof order.commentAnalysis.photoTOC === "string" && order.commentAnalysis.photoTOC.length > 20) {
    try {
      const toc = order.commentAnalysis.photoTOC;
      const subsMatches = toc.match(/^\s*\d+\.\d+/gm) || [];
      const totalSubsPhoto = subsMatches.length || 4;
      const chapConclCount = (toc.match(/висновк[^\s]*\s+до\s+|conclusions?\s+to\s+chapter/gi) || []).length;
      const pagesPerSub = Math.max(3, Math.round((totalPages - introP - conclP - chapConclCount) / totalSubsPhoto));
      const photoTplPrompt = `A client provided a READY PLAN from a photo. Use its EXACT structure (number of chapters, subsections per chapter, chapter conclusions if present) but create NEW titles matching the topic below. Do NOT copy titles from the plan.

TOPIC: "${d.topic}". Type: ${d.type}. Field: ${d.subject}. Pages: ${totalPages}.
Language of work: ${d.language || "Ukrainian"} — all labels (INTRODUCTION, CONCLUSIONS, chapter/section titles) must be in the work language.

PLAN FROM PHOTO (structure only, do not copy titles):
${toc}

PAGE DISTRIBUTION (total must equal ${totalPages}):
- ${L.intro}: ${introP} p.
- ${L.conclusions}: ${conclP} p.
- Chapter conclusions: 1 p. each (if present in photo plan)
- Each subsection: ~${pagesPerSub} p. (total subsections: ${totalSubsPhoto})

Return ONLY JSON without markdown:
{"sections":[{"id":"1.1","label":"1.1 Title","sectionTitle":"${chapterHeadingPrefix(d?.language, 1)}. TITLE","pages":8,"type":"theory"},{"id":"intro","label":"${L.intro}","pages":${introP},"type":"intro"},{"id":"conclusions","label":"${L.conclusions}","pages":${conclP},"type":"conclusions"},{"id":"sources","label":"${L.sources}","pages":2,"type":"sources"}]}`;
      const raw = await callGemini([{ role: "user", content: photoTplPrompt }], null, SYS_JSON_SHORT, 3000, null, undefined, undefined, { onCost: ctx.onCost });
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      const parsed = parseJsonLoose(raw);
      const secs = parsed.sections || parsed;
      if (Array.isArray(secs) && secs.length > 3) return await finalizeSections(secs);
    } catch (e) { console.warn("photoTOC plan failed:", e.message); }
  }

  // Якщо коментар містить приклад структури плану — використати як шаблон, адаптувати назви під тему (тільки якщо план клієнта не надано)
  if (!order.clientPlan?.trim() && order.comment?.trim() && /розділ\s*\d+/i.test(order.comment)) {
    try {
      const chapNums = [...new Set((order.comment.match(/розділ\s*(\d+)/gi) || []).map(m => m.match(/\d+/)[0]))];
      const chapCount = chapNums.length || 2;
      const chapSubsMap = {};
      for (const line of order.comment.split('\n')) {
        const m = line.trim().match(/^(\d+)\.(\d+)/);
        if (m) chapSubsMap[m[1]] = (chapSubsMap[m[1]] || 0) + 1;
      }
      const subsCount = Object.values(chapSubsMap).reduce((a, b) => a + b, 0) || 4;
      const chapStructure = chapNums.length
        ? chapNums.map(n => `Chapter ${n}: EXACTLY ${chapSubsMap[n] || 2} subsection(s)`).join('\n')
        : `Each chapter: EXACTLY 2 subsections`;
      const chapConclCount = (order.comment.match(/висновк[^\s]*\s+до\s+/gi) || []).length;
      const pagesForSubs = totalPages - introP - conclP - chapConclCount;
      const pagesPerSub = Math.max(3, Math.round(pagesForSubs / subsCount));
      const templatePrompt = `A client provided a STRUCTURE EXAMPLE. Use EXACTLY the structure below.

Do NOT copy titles from the example. Create NEW titles for the topic below.
MANDATORY STRUCTURE — you MUST follow this exactly:
- EXACTLY ${chapCount} chapter(s)
${chapStructure}
${chapConclCount > 0 ? `- Chapter conclusions after each chapter` : `- NO chapter conclusions`}

TOPIC: "${d.topic}". Type: ${d.type}. Field: ${d.subject}. Pages: ${totalPages}.
Language of work: ${d.language || "Ukrainian"} — all labels must be in this language.

EXAMPLE (structure only, do not copy titles):
${order.comment}

PAGE DISTRIBUTION (total must equal ${totalPages}):
- ${L.intro}: ${introP} p.
- ${L.conclusions}: ${conclP} p.
- Chapter conclusions: 1 p. each (if present)
- Each subsection: ${pagesPerSub} p. (total: ${subsCount})

Allowed type values: "theory" | "analysis" | "recommendations" | "chapter_conclusion" | "intro" | "conclusions" | "sources"
Chapter conclusion id format: "1.conclusions", "2.conclusions", "3.conclusions"

Return ONLY JSON without markdown:
{"sections":[
  {"id":"1.1","label":"1.1 Section title","sectionTitle":"${chapterHeadingPrefix(d?.language, 1)}. CHAPTER TITLE","pages":8,"type":"theory"},
  ${chapConclCount > 0 ? `{"id":"1.conclusions","label":"${L.chapConclLabel(1)}","sectionTitle":"${chapterHeadingPrefix(d?.language, 1)}. CHAPTER TITLE","pages":1,"type":"chapter_conclusion"},` : ""}
  {"id":"2.1","label":"2.1 Section title","sectionTitle":"${chapterHeadingPrefix(d?.language, 2)}. CHAPTER TITLE","pages":8,"type":"analysis"},
  ${chapConclCount > 0 ? `{"id":"2.conclusions","label":"${L.chapConclLabel(2)}","sectionTitle":"${chapterHeadingPrefix(d?.language, 2)}. CHAPTER TITLE","pages":1,"type":"chapter_conclusion"},` : ""}
  {"id":"intro","label":"${L.intro}","pages":${introP},"type":"intro"},
  {"id":"conclusions","label":"${L.conclusions}","pages":${conclP},"type":"conclusions"},
  {"id":"sources","label":"${L.sources}","pages":2,"type":"sources"}
]}`;
      await new Promise(r => setTimeout(r, 1000));
      const raw = await callGemini([{ role: "user", content: templatePrompt }], null, SYS_JSON_SHORT, 3000, null, undefined, undefined, { onCost: ctx.onCost });
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      const parsed = parseJsonLoose(raw);
      const secs = parsed.sections || parsed;
      if (Array.isArray(secs) && secs.length > 3) return await finalizeSections(secs);
    } catch (e) { console.warn("comment template plan failed:", e.message); }
  }

  const commentHasConcl = order.commentAnalysis?.planHints ? /висновк[^\s]*\s+до\s+/i.test(order.commentAnalysis.planHints) : false;

  const acadDefaults = (!order.commentAnalysis?.practicalApproach && !order.commentAnalysis?.researchDesign)
    ? getAcademicDefaults(d.subject, d.type, d.course, d.topic)
    : null;
  const acadDefaultsBlock = acadDefaults
    ? `\nRESEARCH TYPE FOR PRACTICAL CHAPTER (use as context for subsection naming): ${acadDefaults.researchType}. Methods: ${acadDefaults.methods.join(", ")}.${acadDefaults.notes ? ` Note: ${acadDefaults.notes}.` : ""}`
    : "";

  if (order.methodInfo) {
    const chapCount = requestedChapCount || order.methodInfo.chaptersCount || (totalPages >= 40 ? 3 : 2);
    const hasConcl = order.methodInfo.hasChapterConclusions === true || commentHasConcl || false;
    const chTypes = order.methodInfo.chapterTypes?.length ? order.methodInfo.chapterTypes : ["theory", "analysis", "recommendations"].slice(0, chapCount);
    const chapConclP = hasConcl ? chapCount : 0;

    const subsPerChapter = order.methodInfo.subsectionsPerChapter || 3;
    const subsOverrides = order.methodInfo.subsectionsPerChapterOverrides || {};
    const chapSubsCounts = Array.from({ length: chapCount }, (_, i) => subsOverrides[String(i + 1)] ?? subsPerChapter);
    const totalSubsCount = chapSubsCounts.reduce((a, b) => a + b, 0);
    const pagesPerSub = Math.max(3, Math.round((totalPages - introP - conclP - chapConclP) / totalSubsCount));
    const subsCountLine = chapSubsCounts.every(c => c === subsPerChapter)
      ? `- Subsections per chapter: ${subsPerChapter}`
      : chapSubsCounts.map((c, i) => `- Chapter ${i + 1} subsections: ${c}`).join('\n');

    const planPrompt = `Create a plan for ${d.type} on topic: "${d.topic}". Field: ${d.subject}. Pages: ${totalPages}.
Language of work: ${d.language || "Ukrainian"} — all labels and titles must be in this language.
${order.clientPlan?.trim() ? `\nCLIENT'S REQUIRED CHAPTER TITLES — use these EXACTLY as sectionTitle values, in this exact order, do NOT rename or reorder them:\n${order.clientPlan}\n` : (order.commentAnalysis?.planHints ? `\nCLIENT HINTS:\n${order.commentAnalysis.planHints}\n` : "")}${acadDefaultsBlock}
GUIDE REQUIREMENTS:
- Chapters: ${chapCount}
${subsCountLine}
- Chapter conclusions: ${hasConcl ? "YES — add after last subsection of each chapter" : "NO — do not add"}
- Chapter types: ${chTypes.join(", ")}
${order.methodInfo.otherRequirements ? `- Other requirements: ${order.methodInfo.otherRequirements}` : ""}
${order.methodInfo.exampleTOC ? `\nFORMATTING EXAMPLE FROM GUIDE (headings style only — do NOT copy titles or use as structure):
${order.methodInfo.exampleTOC}` : ""}

PAGE DISTRIBUTION (must sum to exactly ${totalPages}):
- ${L.intro}: ${introP} p.
- ${L.conclusions}: ${conclP} p.
- Each subsection: ~${pagesPerSub} p. (total: ${totalSubsCount})
${hasConcl ? `- Chapter conclusions: 1 p. each (${chapCount} total)` : ""}

Allowed type values: "theory" | "analysis" | "recommendations" | "chapter_conclusion" | "intro" | "conclusions" | "sources"
Chapter conclusion id format: "1.conclusions", "2.conclusions" etc.
IMPORTANT: every subsection label MUST start with its numeric id (e.g. "1.1 ", "1.2 ", "2.3 "). Never omit the number prefix.

Return ONLY JSON without markdown:
{"sections":[
  {"id":"1.1","label":"1.1 Section title","sectionTitle":"${chapterHeadingPrefix(d?.language, 1)}. CHAPTER TITLE","pages":8,"type":"theory"},
  {"id":"1.2","label":"1.2 Section title","sectionTitle":"${chapterHeadingPrefix(d?.language, 1)}. CHAPTER TITLE","pages":7,"type":"theory"},${hasConcl ? `
  {"id":"1.conclusions","label":"${L.chapConclLabel(1)}","sectionTitle":"${chapterHeadingPrefix(d?.language, 1)}. CHAPTER TITLE","pages":1,"type":"chapter_conclusion"},` : ""}
  {"id":"2.1","label":"2.1 Section title","sectionTitle":"${chapterHeadingPrefix(d?.language, 2)}. CHAPTER TITLE","pages":8,"type":"analysis"},
  {"id":"2.2","label":"2.2 Section title","sectionTitle":"${chapterHeadingPrefix(d?.language, 2)}. CHAPTER TITLE","pages":7,"type":"analysis"},${hasConcl ? `
  {"id":"2.conclusions","label":"${L.chapConclLabel(2)}","sectionTitle":"${chapterHeadingPrefix(d?.language, 2)}. CHAPTER TITLE","pages":1,"type":"chapter_conclusion"},` : ""}
  {"id":"intro","label":"${L.intro}","pages":${introP},"type":"intro"},
  {"id":"conclusions","label":"${L.conclusions}","pages":${conclP},"type":"conclusions"},
  {"id":"sources","label":"${L.sources}","pages":2,"type":"sources"}
]}
Order: subsections grouped by chapter, then intro, conclusions, sources.`;

    try {
      await new Promise(r => setTimeout(r, 3000)); // пауза після аналізу методички
      const raw = await callGemini([{ role: "user", content: planPrompt }], null, SYS_JSON, 3000, null, undefined, undefined, { onCost: ctx.onCost });
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      const parsed = parseJsonLoose(raw);
      const secs = parsed.sections || parsed;
      if (Array.isArray(secs) && secs.length > 3) return await finalizeSections(secs);
      console.warn("methodInfo plan: unexpected shape", parsed);
    } catch (e) { console.error("methodInfo plan error:", e); }
  }

  const defaultSecs = buildDefaultPlan(totalPages, d?.language, requestedChapCount);
  const hasThreeChapters = requestedChapCount ? requestedChapCount >= 3 : totalPages >= 40;
  const empiricalChapNum = hasThreeChapters ? 3 : 2;
  const planSecs = isPsychoPed(d)
    ? defaultSecs.map(s => {
      const chapNum = parseInt(s.id.split(".")[0]);
      if (!hasThreeChapters && s.type === "analysis" && chapNum === 2) {
        const title = `${chapterHeadingPrefix(d?.language, 2)}. ${L.empiricalChapter}`;
        return { ...s, sectionTitle: title };
      }
      if (hasThreeChapters && s.type === "recommendations" && chapNum === 3) {
        const title = `${chapterHeadingPrefix(d?.language, 3)}. ${L.empiricalChapter}`;
        return { ...s, sectionTitle: title };
      }
      return s;
    })
    : defaultSecs;
  const psychoPedNamingHint = isPsychoPed(d)
    ? `\nIMPORTANT for Chapter ${empiricalChapNum} (empirical research): subsections should cover: research methodology and sample description, questionnaire/survey instrument, results analysis and interpretation.`
    : "";
  const namingPrompt = `For ${d.type} on topic "${d.topic}" (field: ${d.subject}) create subsection titles.\nLanguage of work: ${d.language || "Ukrainian"} — write titles exclusively in this language.${order.commentAnalysis?.planHints ? `\nHINTS:\n${order.commentAnalysis.planHints}` : ""}${psychoPedNamingHint}${acadDefaultsBlock}\nFixed structure:\n${planSecs.filter(s => !["intro", "conclusions", "sources", "chapter_conclusion"].includes(s.type)).map(s => `${s.id} [${s.sectionTitle}]`).join("\n")}\n\nReturn ONLY JSON without markdown:\n{"titles":{"1.1":"Title","1.2":"Title","2.1":"Title","2.2":"Title"}}`;
  try {
    await new Promise(r => setTimeout(r, 2000)); // пауза перед запитом
    const raw = await callClaude([{ role: "user", content: namingPrompt }], null, SYS_JSON, 1000, null, MODEL_FAST, { onCost: ctx.onCost });
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    const parsed = parseJsonLoose(raw);
    const namedSecs = planSecs.map(s => { const name = parsed.titles?.[s.id]; return name ? { ...s, label: `${s.id} ${name}` } : s; });
    return await finalizeSections(namedSecs);
  } catch (e) {
    console.error("Naming error:", e);
    return await finalizeSections(planSecs);
  }
}

// ── Розв'язання файлового входу (методичка/приклад роботи/ілюстрації-PDF/фото)
// в готові байти. Браузер завжди передає { b64, mediaType } — файл уже лежить
// у пам'яті вкладки, тож просто повертаємо його як є. CRM-шлях/воркер натомість
// може передати { url, mediaType } — файл довантажується звідти щоразу, коли
// потрібен (і при першому запуску, і при відновленні після збою), тож нічого не
// треба заливати в Firestore (там є жорсткий ліміт 1 МБ на документ, а методички
// в PDF легко можуть бути більшими) — джерело істини лишається зовнішнім.
async function resolveFileBytes(fileRef) {
  if (!fileRef) return null;
  if (fileRef.b64) return { b64: fileRef.b64, mediaType: fileRef.mediaType || fileRef.type || "application/pdf", name: fileRef.name };
  if (fileRef.url) {
    const res = await fetch(fileRef.url);
    if (!res.ok) throw new Error(`Не вдалось завантажити файл за посиланням (${res.status}): ${fileRef.url}`);
    const buf = await res.arrayBuffer();
    const bytes = new Uint8Array(buf);
    // Buffer існує в Node (воркер), відсутній у браузері; typeof-перевірка безпечна в обох середовищах
    /* eslint-disable no-undef */
    const b64 = typeof Buffer !== "undefined"
      ? Buffer.from(bytes).toString("base64")
      : btoa(bytes.reduce((s, b) => s + String.fromCharCode(b), ""));
    /* eslint-enable no-undef */
    return { b64, mediaType: fileRef.mediaType || "application/pdf", name: fileRef.name };
  }
  return null;
}

const DOCX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function base64ToBytes(b64) {
  /* eslint-disable no-undef */
  const raw = typeof Buffer !== "undefined" ? Buffer.from(b64, "base64") : Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  /* eslint-enable no-undef */
  return new Uint8Array(raw);
}

// Claude/Gemini приймають "document"-блок лише для PDF (докладніше — коментар
// у small-works.jsx). DOCX тому не шлемо файлом, а витягуємо текст через
// mammoth і передаємо як звичайний текстовий блок — працює однаково в браузері
// й у Node-воркері, бо resolveFileBytes вже уніфікував джерело байтів.
// mediaType не завжди дослівно збігається з канонічним рядком docx — CRM/сховище
// подекуди віддає його як application/zip (docx технічно й є zip-архів, тож деякі
// детектори за магічними байтами розпізнають саме так; кейс #41510: Gemini 400
// "Unsupported MIME type: application/zip"), тому докладаємо резервну перевірку
// за розширенням імені файлу.
async function fileToContentPart(resolved) {
  const isDocx = resolved.mediaType === DOCX_MEDIA_TYPE || /\.docx$/i.test(resolved.name || "");
  if (isDocx) {
    // Node-збірка mammoth (воркер) не знає опції arrayBuffer — лише buffer/path;
    // браузерна збірка (Vite) — навпаки, лише arrayBuffer. Той самий Buffer-чек,
    // що й вище в resolveFileBytes, безпечно розрізняє середовища.
    /* eslint-disable no-undef */
    const result = typeof Buffer !== "undefined"
      ? await mammoth.extractRawText({ buffer: Buffer.from(resolved.b64, "base64") })
      : await mammoth.extractRawText({ arrayBuffer: base64ToBytes(resolved.b64).buffer });
    /* eslint-enable no-undef */
    return { type: "text", text: result.value.trim() };
  }
  return { type: "document", source: { type: "base64", media_type: resolved.mediaType, data: resolved.b64 } };
}

/**
 * Аналізує вхідні дані замовлення: шаблон, методичку, приклад роботи, коментар
 * (+фото), ілюстрації, креслення, матеріали клієнта. На відміну від
 * runPlanStage, тут є справжнє покрокове відновлення — кроки з дорогими
 * викликами ШІ (читання PDF методички/прикладу роботи, опис ілюстрацій)
 * позначаються завершеними через order.analyzeProgress і на повторному
 * виклику НЕ повторюються, якщо вже зроблені. Аналіз шаблону (КРОК 1) — єдиний
 * виняток: він ніколи не був окремою точкою збереження навіть в оригінальному
 * коді (перший saveToFirestore відбувався вже після методички), тож і тут
 * завжди виконується заново — це дешевий виклик, це не проблема.
 *
 * ВАЖЛИВО: order.analyzeProgress призначений саме для АВТОМАТИЧНОГО
 * повторного запуску після збою (той самий order, той самий виклик). Якщо
 * викликач хоче зробити СВІЖИЙ аналіз (користувач завантажив нову методичку,
 * відредагував коментар тощо) — має явно передати analyzeProgress: {}
 * (або зовсім не передавати це поле), інакше вже пройдені кроки помилково
 * пропустяться зі старими даними. Браузерна обгортка (doAnalyze) саме так і
 * робить: кожен клік на "Аналізувати" — це свідомо нова спроба.
 *
 * @param {object} order - tplText, comment, clientPlan, methodInfo (попередній
 *   результат, якщо PDF не надано повторно), methodichkaFile, exampleWorkFile,
 *   illustrationsPdfFile, illustrations[], photos[], clientDrawings[],
 *   clientMaterials[], clientMaterialsText, appendicesText, fileLabel,
 *   exampleWorkFileName, analyzeProgress?
 * @param {object} ctx - { callClaude, callGemini, onProgress?, onCost?,
 *   save(patch) - ОБОВ'ЯЗКОВИЙ async колбек, викликається після кожного
 *   завершеного дорогого кроку для реального збереження прогресу (не лише
 *   в кінці — інакше сенс відновлення втрачається), extractIllustrationsFromPdf? }
 * @returns {Promise<object>} фінальний консолідований патч (те саме, що
 *   в сумі вже пішло через ctx.save по кроках)
 */
// Толерантний парсер JSON від LLM: прибирає ```json-обгортку, «хвости» до/після обʼєкта,
// trailing-коми; якщо відповідь обірвана (ліміт токенів) — відрізає до останньої
// повної пари «ключ: значення» і закриває дужки. Кейс #41437: методичка → «Expected ','
// or '}' after property value in JSON at position 5862» і вся генерація падала.
export function parseJsonLoose(raw) {
  let t = String(raw ?? "").replace(/```json\s*|```/g, "").trim();
  const m = t.match(/[\{\[][\s\S]*/);
  if (m) t = m[0];
  const tryParse = (x) => { try { return JSON.parse(x); } catch { return undefined; } };
  let v = tryParse(t);
  if (v !== undefined) return v;
  // trailing-коми та «розумні» лапки
  let u = t.replace(/,\s*([\]\}])/g, "$1").replace(/[“”]/g, '"');
  v = tryParse(u);
  if (v !== undefined) return v;
  // обірвана відповідь: скорочуємо до останньої повної пари/елемента і закриваємо дужки
  for (let cut = u.length; cut > 0; ) {
    const idx = Math.max(u.lastIndexOf(",", cut - 1), u.lastIndexOf("}", cut - 1), u.lastIndexOf("]", cut - 1));
    if (idx <= 0) break;
    let head = u.slice(0, idx + (u[idx] === "," ? 0 : 1));
    // закриваємо відкриті дужки з урахуванням рядків
    const stack = []; let inStr = false;
    for (let i = 0; i < head.length; i++) {
      const c = head[i];
      if (inStr) { if (c === "\\") i++; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === "{" || c === "[") stack.push(c === "{" ? "}" : "]");
      else if (c === "}" || c === "]") stack.pop();
    }
    if (!inStr) {
      const fixed = head.replace(/,\s*$/, "") + stack.reverse().join("");
      v = tryParse(fixed);
      if (v !== undefined) { console.warn(`[json] відповідь LLM обірвана — відновлено (${u.length}→${fixed.length} симв.)`); return v; }
    }
    cut = idx;
  }
  throw new SyntaxError("LLM повернув некоректний JSON (не вдалося відновити)");
}

export async function runAnalyzeStage(order, ctx) {
  const { callClaude, callGemini, onProgress, save } = ctx;
  const progress = { ...(order.analyzeProgress || {}) };
  const patch = { analyzeProgress: progress };

  // КРОК 1: Аналіз шаблону замовлення (тільки текст, без PDF) — завжди заново
  const msgs = [{ type: "text", text: buildTemplateAnalysisPrompt(order.tplText, order.comment) }];
  let newInfo;
  try {
    const raw = await callClaude([{ role: "user", content: msgs }], null, SYS_JSON, 1000, null, MODEL_FAST, { onCost: ctx.onCost });
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    const parsed = parseJsonLoose(raw);
    newInfo = { ...parseTemplate(order.tplText), ...Object.fromEntries(Object.entries(parsed).filter(([, v]) => v != null && v !== "")) };
  } catch (e) {
    console.warn("doAnalyze fallback:", e.message);
    newInfo = parseTemplate(order.tplText);
  }
  // Клієнт часто дописує до теми службовий дужковий хвіст типу "(презентація+доповідь)" —
  // це вказівка на додаткові матеріали до захисту, а не частина самої теми. Чистимо тут,
  // одразу після розбору, щоб очищена тема потрапляла всюди (титулка, план, промпти до ШІ,
  // назви файлів), а не лише в окремих місцях експорту.
  if (newInfo.topic) newInfo.topic = stripPresentationSuffix(newInfo.topic);
  if (!newInfo.course && /магістерськ/i.test(newInfo.type || "")) newInfo.course = "6";
  if (!newInfo.workCategory) {
    const dir = ((newInfo.direction || "") + " " + (newInfo.subject || "")).toLowerCase();
    if (/економ|фінанс|менедж|облік|маркет|бізнес|бухгалт|аудит|логіст|підприємн|публічн.*управл|держ.*управл/.test(dir)) newInfo.workCategory = "Економічне";
    else if (/біолог|медицин|хімі|фізіол|екол|природн|ветеринар/.test(dir)) newInfo.workCategory = "Біологічне";
    else if (/техн|інформ|програм|комп|it\b|кібер|електр|машин|буд|архіт/.test(dir)) newInfo.workCategory = "Технічне";
    else newInfo.workCategory = "Гуманітарне";
  }
  // Мова поза таблицею (напр. румунська) — ШІ один раз складає для неї набір підписів
  // (langProfile.js); далі він зберігається в info й використовується кодом
  newInfo = await withLangProfile(newInfo, ctx.callClaude, { signal: ctx.signal, onCost: ctx.onCost });
  patch.info = newInfo;
  // Миттєве оновлення (не запис у Firestore — той піде пізніше, разом із
  // методичкою, як і в оригіналі) — щоб інтерфейс показав тему/тип одразу,
  // не чекаючи повільного читання методички/прикладу роботи в фоні.
  ctx.onInfo?.(newInfo);
  onProgress?.("Аналізую шаблон...");

  // КРОК 2: методичка (пропускається, якщо вже пройдена і не надано нового файлу)
  let methodParsed = order.methodInfo || null;
  if (order.methodichkaFile && !progress.methodologyRead) {
    onProgress?.("Читаю методичку...");
    await new Promise(r => setTimeout(r, 2000));
    try {
      const resolved = await resolveFileBytes(order.methodichkaFile);
      const docPart = await fileToContentPart(resolved);
      onProgress?.("Читаю методичку... крок 1/2");
      const structMsgs = [docPart, { type: "text", text: STRUCTURE_READING_PROMPT }];
      const structRaw = await callGemini([{ role: "user", content: structMsgs }], null, SYS_JSON_SHORT, 2000, null, "gemini-2.5-flash", true, { onCost: ctx.onCost });
      const structMatch = structRaw.match(/\{[\s\S]*\}/);
      let structureInfo = null;
      try { structureInfo = structMatch ? JSON.parse(structMatch[0]) : null; } catch (e) { console.warn("[methodology] structure step parse error:", e.message); }

      await new Promise(r => setTimeout(r, 1500));
      const methodMsgs = [docPart, { type: "text", text: buildMethodologyReadingPrompt(structureInfo) }];
      let parsed = null;
      for (let attempt = 1; attempt <= 2 && !parsed; attempt++) {
        const raw = await callGemini([{ role: "user", content: methodMsgs }], null, SYS_JSON_SHORT, 8000, (s) => onProgress?.(`Читаю методичку... крок 2/2, зачекайте ${s}с`), "gemini-2.5-flash", true, { onCost: ctx.onCost });
        try { parsed = parseJsonLoose(raw); }
        catch (e) {
          console.warn(`[methodology] JSON parse error (спроба ${attempt}/2):`, e.message);
          if (attempt === 2) throw e;
          await new Promise(r => setTimeout(r, 2000));
        }
      }
      if (structureInfo) {
        if (structureInfo.chaptersCount != null) parsed.chaptersCount = structureInfo.chaptersCount;
        if (structureInfo.subsectionsPerChapter != null) parsed.subsectionsPerChapter = structureInfo.subsectionsPerChapter;
        parsed.subsectionsPerChapterOverrides = structureInfo.subsectionsPerChapterOverrides ?? null;
        parsed.hasChapterConclusions = structureInfo.hasChapterConclusions;
        if (structureInfo.chapterTypes?.length) parsed.chapterTypes = structureInfo.chapterTypes;
        if (structureInfo.totalPages != null) parsed.totalPages = structureInfo.totalPages;
        if (structureInfo.introPages != null) parsed.introPages = structureInfo.introPages;
        if (structureInfo.conclusionsPages != null) parsed.conclusionsPages = structureInfo.conclusionsPages;
      }
      if (Array.isArray(parsed.recommendedSources)) parsed.recommendedSources = parsed.recommendedSources.join('; ');
      if (Array.isArray(parsed.sourcesStyle)) parsed.sourcesStyle = parsed.sourcesStyle.join(', ');
      if (Array.isArray(parsed.citationStyle)) parsed.citationStyle = parsed.citationStyle.join('; ');
      if (typeof parsed.sourcesMinCount === 'string') parsed.sourcesMinCount = parseInt(parsed.sourcesMinCount) || null;
      if (typeof parsed.requiresEnterpriseProfile === 'string') parsed.requiresEnterpriseProfile = /true|так/i.test(parsed.requiresEnterpriseProfile);
      parsed.titlePageTemplate = stripLeadingAppendixLabel(parsed.titlePageTemplate);
      parsed.taskSheetTemplate = stripLeadingAppendixLabel(parsed.taskSheetTemplate);
      methodParsed = parsed;
      progress.methodologyRead = true;
      await save({ methodInfo: methodParsed, analyzeProgress: progress });
    } catch (e) {
      console.warn("methodInfo extract failed:", e.message);
      patch.apiError = e.message;
    }
  }

  // КРОК 2b: приклад роботи (той самий принцип пропуску)
  let exampleParsed = null, exampleStructure = null;
  if (order.exampleWorkFile && !progress.exampleWorkRead) {
    onProgress?.("Читаю приклад роботи...");
    await new Promise(r => setTimeout(r, 1500));
    try {
      const resolved = await resolveFileBytes(order.exampleWorkFile);
      const exampleDocPart = await fileToContentPart(resolved);
      const exampleMsgs = [exampleDocPart, { type: "text", text: buildExampleWorkReadingPrompt() }];
      // Той самий принцип, що й для методички (КРОК 2): один ретрай + толерантний
      // парсер замість голого JSON.parse — кейс #41306, коли відповідь на великий
      // приклад роботи обривалась і генерація тихо падала на нерозібраному JSON.
      for (let attempt = 1; attempt <= 2 && !exampleParsed; attempt++) {
        const exampleRaw = await callGemini([{ role: "user", content: exampleMsgs }], null, SYS_JSON_SHORT, 6000, (s) => onProgress?.(`Читаю приклад роботи... зачекайте ${s}с`), "gemini-2.5-flash", true, { onCost: ctx.onCost });
        try { exampleParsed = parseJsonLoose(exampleRaw); }
        catch (e) {
          console.warn(`[exampleWork] JSON parse error (спроба ${attempt}/2):`, e.message);
          if (attempt === 2) throw e;
          await new Promise(r => setTimeout(r, 2000));
        }
      }
      if (Array.isArray(exampleParsed.sourcesStyle)) exampleParsed.sourcesStyle = exampleParsed.sourcesStyle.join(', ');
      if (Array.isArray(exampleParsed.citationStyle)) exampleParsed.citationStyle = exampleParsed.citationStyle.join('; ');
      exampleParsed.titlePageTemplate = stripLeadingAppendixLabel(exampleParsed.titlePageTemplate);
      exampleParsed.taskSheetTemplate = stripLeadingAppendixLabel(exampleParsed.taskSheetTemplate);
      exampleStructure = deriveStructureFromExampleTOC(exampleParsed.exampleTOC, newInfo?.language);
      progress.exampleWorkRead = true;
    } catch (e) {
      console.warn("exampleWork extract failed:", e.message);
      patch.apiError = patch.apiError || e.message;
    }
  }

  // КРОК 2c: окремий файл «Титульна сторінка» з CRM (тег title_page) — має пріоритет над титулкою
  // з методички чи зразка: клієнт явно показав, як має виглядати саме титулка.
  let titleFromFile = null;
  if (order.titlePageFile) {
    onProgress?.("Читаю зразок титульної сторінки...");
    try {
      const tpResolved = await resolveFileBytes(order.titlePageFile);
      const tpPart = await fileToContentPart(tpResolved);
      const tpRaw = await callGemini([{ role: "user", content: [tpPart, { type: "text", text: buildTitlePageFilePrompt() }] }], null, SYS_JSON_SHORT, 2500, null, undefined, undefined, { onCost: ctx?.onCost });
      const tpParsed = parseJsonLoose(tpRaw);
      if (Array.isArray(tpParsed?.titlePageTemplate) && tpParsed.titlePageTemplate.length) titleFromFile = tpParsed.titlePageTemplate;
      else console.warn("[titlePage] у файлі титулки не знайдено титульної сторінки");
    } catch (e) {
      console.warn("titlePage file read failed:", e.message);
    }
  }

  // Об'єднуємо: явні поля методички мають пріоритет, приклад роботи заповнює те, чого в методичці нема
  let finalMethodInfo = (exampleParsed || exampleStructure)
    ? mergeExampleWorkIntoMethodInfo(methodParsed, exampleParsed, exampleStructure)
    : methodParsed;
  if (titleFromFile) finalMethodInfo = { ...(finalMethodInfo || {}), titlePageTemplate: titleFromFile };

  let filledTitleText = null, filledTitleLines = null;
  if (finalMethodInfo?.titlePageTemplate) {
    const currentYear = new Date().getFullYear().toString();
    const topic = newInfo?.topic || "";
    // Ці токени клієнт майже завжди вказує (ПІБ, група, факультет, кафедра, керівник) — без
    // підстановки тут вони лишаються буквальним "[ПІБ]" аж до фінального docx-експорту (де їх
    // ще підхоплює exportDocx.js), і саме тому попередній перегляд титулки на кроці "Готово"
    // показує сирі токени замість реальних даних. degreeLevel/specialty окремих полів у
    // клієнта немає — ступінь виводимо з типу роботи, спеціальність — з direction як фолбек.
    const personalFieldMap = {
      "[ПІБ]": newInfo?.studentName,
      "[ГРУПА]": newInfo?.studentGroup,
      "[КУРС]": newInfo?.course,
      "[ФАКУЛЬТЕТ]": newInfo?.faculty,
      "[КАФЕДРА]": newInfo?.department,
      "[КЕРІВНИК]": newInfo?.supervisorUniversity,
      "[ОКР]": deriveDegreeLevelFromType(newInfo?.type),
      "[СПЕЦІАЛЬНІСТЬ]": newInfo?.direction,
    };
    const fillText = (t) => {
      let s = t;
      if (topic) {
        s = s.replace(/\[ТЕМА\]/g, topic);
        s = s.replace(/\(найменування\s+теми\)/gi, topic);
        s = s.replace(/\(назва\s+теми\)/gi, topic);
      }
      s = s.replace(/\[РІК\]/g, currentYear).replace(/\[ДАТА\]/g, currentYear);
      s = s.replace(/\b20\d\d\b/g, currentYear);
      s = s.replace(/\b20\d?\s*[_]+/g, currentYear);
      for (const [token, value] of Object.entries(personalFieldMap)) {
        if (value && s.includes(token)) s = s.split(token).join(value);
      }
      s = fillEnterpriseNameToken(s, order.econProfile);
      return s;
    };
    if (Array.isArray(finalMethodInfo.titlePageTemplate)) {
      let filledLines = finalMethodInfo.titlePageTemplate.map(item => ({ ...item, text: fillText(item.text) }));
      filledLines = filledLines.reduce((acc, item) => {
        const prev = acc[acc.length - 1];
        if (prev && /–\s*\d{1,3}$/.test(prev.text) && /^\d{1,2}$/.test(item.text.trim())) {
          acc[acc.length - 1] = { ...prev, text: prev.text + item.text.trim() };
        } else {
          acc.push(item);
        }
        return acc;
      }, []);
      filledTitleLines = filledLines;
      filledTitleText = filledLines.map(item => item.text).join("\n");
    } else {
      filledTitleText = fillText(finalMethodInfo.titlePageTemplate);
    }
  }

  patch.methodInfo = finalMethodInfo || null;
  if (filledTitleText) { patch.titlePage = filledTitleText; patch.titlePageLines = filledTitleLines; }
  await save({
    tplText: order.tplText, comment: order.comment, clientPlan: order.clientPlan, info: newInfo,
    ...(finalMethodInfo ? { methodInfo: finalMethodInfo } : {}),
    fileLabel: order.fileLabel, exampleWorkFileName: order.exampleWorkFileName,
    ...(filledTitleText ? { titlePage: filledTitleText, titlePageLines: filledTitleLines } : {}),
    ...(order.appendicesText?.trim() ? { appendicesText: order.appendicesText } : {}),
    stage: "parsed", status: "new", analyzeProgress: progress,
  });

  // КРОК 3: коментар клієнта (+фото)
  if (progress.commentAnalysis) {
    patch.commentAnalysis = order.commentAnalysis ?? null;
  } else if (order.comment?.trim() || order.photos?.length > 0) {
    onProgress?.("Аналізую коментар...");
    await new Promise(r => setTimeout(r, 1000));
    try {
      const caContent = [];
      for (const ph of (order.photos || [])) {
        const resolved = await resolveFileBytes(ph);
        caContent.push({ type: "image", source: { type: "base64", media_type: resolved.mediaType, data: resolved.b64 } });
      }
      caContent.push({ type: "text", text: buildCommentAnalysisPrompt({ topic: newInfo?.topic, comment: order.comment, photoCount: order.photos?.length || 0 }) });
      // 600 токенів обрізало відповідь на довгих коментарях/фото з планом (photoTOC
      // просить дослівну копію) — JSON.parse тоді падав і весь аналіз тихо зникав.
      // Один ретрай з набагато вищим лімітом покриває решту випадків обрізання.
      let caParsed = null;
      let lastParseErr = null;
      for (const maxTokens of [3000, 12000]) {
        const caRaw = await callClaude([{ role: "user", content: caContent }], null, SYS_JSON_SHORT, maxTokens, null, MODEL_FAST, { onCost: ctx.onCost });
        const caMatch = caRaw.match(/\{[\s\S]*\}/);
        try {
          caParsed = JSON.parse(caMatch?.[0] || caRaw);
          break;
        } catch (parseErr) {
          lastParseErr = parseErr;
          console.warn(`commentAnalysis: JSON.parse не вдався при maxTokens=${maxTokens}:`, parseErr.message);
        }
      }
      if (!caParsed) throw new Error(`commentAnalysis: відповідь не розібралась навіть після ретраю (${lastParseErr?.message})`);
      if (Array.isArray(caParsed.sourcesHints)) caParsed.sourcesHints = caParsed.sourcesHints.join('; ');
      if (Array.isArray(caParsed.planHints)) caParsed.planHints = caParsed.planHints.join('; ');
      if (Array.isArray(caParsed.textStructureHints)) caParsed.textStructureHints = caParsed.textStructureHints.join('; ');
      if (Array.isArray(caParsed.writingHints)) caParsed.writingHints = caParsed.writingHints.join('; ');
      patch.commentAnalysis = caParsed;
      progress.commentAnalysis = true;
      await save({
        tplText: order.tplText, comment: order.comment, clientPlan: order.clientPlan, info: newInfo,
        commentAnalysis: caParsed, ...(order.appendicesText?.trim() ? { appendicesText: order.appendicesText } : {}),
        stage: "parsed", status: "new", analyzeProgress: progress,
      });
    } catch (e) {
      console.error("commentAnalysis failed — побажання клієнта не враховано:", e.message);
      patch.commentAnalysis = null;
    }
  } else {
    patch.commentAnalysis = null;
  }

  // КРОК 3.5: опис ілюстрацій клієнта
  if (progress.illustrationsDesc) {
    patch.illustrationDescs = order.illustrationDescs ?? [];
  } else if (order.illustrations?.length > 0 || order.illustrationsPdfFile) {
    onProgress?.("Описую ілюстрації...");
    await new Promise(r => setTimeout(r, 500));
    try {
      let illContent;
      if (order.illustrationsPdfFile) {
        const resolved = await resolveFileBytes(order.illustrationsPdfFile);
        illContent = [
          { type: "document", source: { type: "base64", media_type: resolved.mediaType, data: resolved.b64 } },
          { type: "text", text: buildIllustrationsPdfPrompt({ topic: newInfo?.topic, planSections: order.sections || [], lang: newInfo?.language }) },
        ];
      } else {
        illContent = [];
        for (const ill of order.illustrations) {
          const resolved = await resolveFileBytes(ill);
          illContent.push({ type: "image", source: { type: "base64", media_type: resolved.mediaType, data: resolved.b64 } });
        }
        illContent.push({ type: "text", text: buildIllustrationsPrompt({ topic: newInfo?.topic, illustrations: order.illustrations, planSections: order.sections || [], lang: newInfo?.language }) });
      }
      const illRaw = await callClaude([{ role: "user", content: illContent }], null, SYS_JSON_ARRAY, 1500, null, MODEL_FAST, { onCost: ctx.onCost });
      const illMatch = illRaw.match(/\[[\s\S]*\]/);
      const illParsed = JSON.parse(illMatch?.[0] || illRaw);
      patch.illustrationDescs = illParsed;
      progress.illustrationsDesc = true;
      if (order.illustrationsPdfFile && ctx.extractIllustrationsFromPdf) {
        const built = await ctx.extractIllustrationsFromPdf(order.illustrationsPdfFile, illParsed);
        if (built?.length) patch.illustrations = built;
      }
      await save({
        ...(order.illustrationsPdfFile ? {} : { illustrations: order.illustrations }),
        illustrationDescs: illParsed, analyzeProgress: progress,
      });
    } catch (e) {
      console.warn("illustrationDescs failed:", e.message);
      patch.illustrationDescs = [];
    }
  } else {
    patch.illustrationDescs = [];
  }

  // КРОК 3.6 + 4 (об'єднано в один checkpoint — проміжний drawingDescsResult
  // ніде окремо не зберігається, тож немає сенсу відновлювати їх нарізно):
  // опис креслень клієнта і збірка підсумкового тексту матеріалів
  if (progress.materialsText) {
    patch.clientMaterialsSummary = order.clientMaterialsSummary ?? null;
    patch.clientDrawings = order.clientDrawings;
  } else {
    let drawingDescsResult = [];
    if (order.clientDrawings?.length > 0) {
      onProgress?.("Описую креслення...");
      await new Promise(r => setTimeout(r, 500));
      try {
        const drContent = [];
        for (const d of order.clientDrawings) {
          const resolved = await resolveFileBytes(d);
          drContent.push({ type: "image", source: { type: "base64", media_type: resolved.mediaType, data: resolved.b64 } });
        }
        drContent.push({ type: "text", text: buildDrawingsDescriptionPrompt({ topic: newInfo?.topic, drawings: order.clientDrawings, lang: newInfo?.language }) });
        const drRaw = await callClaude([{ role: "user", content: drContent }], null, SYS_JSON_ARRAY, 1200, null, MODEL_FAST, { onCost: ctx.onCost });
        const drMatch = drRaw.match(/\[[\s\S]*\]/);
        drawingDescsResult = JSON.parse(drMatch?.[0] || drRaw);
        patch.clientDrawings = order.clientDrawings;
        await save({ clientDrawings: order.clientDrawings });
      } catch (e) {
        console.warn("clientDrawingDescs failed:", e.message);
      }
    }

    const combinedMaterialsText = [
      ...(order.clientMaterials || []).map(m => `=== ${m.name} ===\n${m.text}`),
      ...drawingDescsResult.map(d => `=== Технічний опис креслення: ${d.name} ===\n${d.description}`),
      order.clientMaterialsText?.trim() || "",
    ].filter(Boolean).join("\n\n");

    if (combinedMaterialsText.trim()) {
      const rawSummary = { rawText: combinedMaterialsText };
      patch.clientMaterialsSummary = rawSummary;
      progress.materialsText = true;
      await save({
        clientMaterialsSummary: rawSummary, clientMaterialsText: order.clientMaterialsText?.trim() || null,
        analyzeProgress: progress,
      });
    } else {
      patch.clientMaterialsSummary = null;
      progress.materialsText = true;
      await save({ analyzeProgress: progress });
    }
  }

  return patch;
}

// ── Анотація (укр/англ) для бакалаврських/магістерських робіт — перенесено з
// doGenAnnotation без зміни логіки, викликається лише зсередини runRemapStage ──
async function genAnnotation(order, contentForGen, refListForGen, ctx) {
  const mainSections = order.sections.filter(s => !["intro", "conclusions", "sources", "chapter_conclusion"].includes(s.type));
  const intro = order.sections.find(s => s.type === "intro");
  const concs = order.sections.find(s => s.type === "conclusions");
  const introText = intro ? (contentForGen[intro.id] || "") : "";
  const concsText = concs ? (contentForGen[concs.id] || "") : "";

  const wt = normalizeWorkType(order.info?.type, order.info?.course);
  const degreeLabel = wt === "master" ? "магістра (Master's)" : "бакалавра (Bachelor's)";
  const chaptersCount = new Set(mainSections.map(s => s.id.split(".")[0])).size;
  const sourcesCount = (refListForGen || order.refList || []).length;
  const appendicesCount = (order.appendicesText || "").split("\n").filter(l => appendixLabelRe().test(l.trim())).length;
  const pagesLabel = order.info?.pages || order.methodInfo?.totalPages || "";

  const statsText = [
    `Освітній ступінь: ${degreeLabel}`,
    `Спеціальність/напрям: ${order.info?.subject || order.info?.direction || ""}`,
    `Кількість розділів: ${chaptersCount}`,
    `Кількість використаних джерел: ${sourcesCount}`,
    appendicesCount ? `Кількість додатків: ${appendicesCount}` : "Додатків немає",
    pagesLabel ? `Орієнтовний обсяг роботи: ${pagesLabel} сторінок` : "",
  ].filter(Boolean).join("\n");

  const prompt = buildAnnotationPrompt(order.info, order.methodInfo, statsText, introText, concsText);
  const raw = await ctx.callClaude([{ role: "user", content: prompt }], ctx.signal, SYS_JSON, 3000, null, MODEL, { onCost: ctx.onCost });
  const match = raw.match(/\{[\s\S]*\}/);
  const parsed = JSON.parse(match?.[0] || raw.replace(/```json|```/g, "").trim());
  return { annotationUk: parsed.uk || "", annotationEn: parsed.en || "" };
}

/**
 * Фінальний крок після написання всіх підрозділів: перерозподіляє локальні
 * номери цитат [N] по підрозділах у глобальний список джерел, форматує список
 * за потрібним стилем (ДСТУ/APA/MLA), довставляє пропущені цитати
 * "осиротілих" джерел, прибирає ті, що так і не підтвердились, перевіряє
 * сумарний обсяг усієї роботи і генерує анотацію (для бакалаврських/
 * магістерських). Це те, що робить різницю між "весь текст дописаний" і
 * "робота дійсно готова" (стадія done з коректним списком літератури).
 *
 * @param {object} order - sections, citInputs, citStructured, methodInfo,
 *   commentAnalysis, citStyleOverride, sourcesOrderOverride, citFootnotes,
 *   content, info, appendicesText, refList
 * @param {object} ctx - { callClaude, signal?, onCost? }
 * @returns {Promise<object>} патч: content, citInputs, citStructured, refList,
 *   stage:"done", status:"done", і annotationUk/annotationEn для бак./маг.
 */
export async function runRemapStage(order, ctx) {
  const doCallClaude = (messages, signal, systemPrompt, maxTokens, onWait, model, opts) =>
    ctx.callClaude(messages, ctx.signal, systemPrompt, maxTokens, onWait, model, opts);

  const sections = order.sections;
  const citInputs = order.citInputs || {};
  const methodInfo = order.methodInfo;
  const commentAnalysis = order.commentAnalysis;
  const info = order.info;
  const mainSecs = sections.filter(s => s.type !== "sources");
  const _extraText2 = (methodInfo?.otherRequirements || "") + " " + (methodInfo?.citationStyle || "") + " " + (commentAnalysis?.sourcesHints || "");
  const sourcesStyle = order.citStyleOverride
    || methodInfo?.sourcesStyle
    || (/APA/i.test(_extraText2) ? "APA" : /MLA/i.test(_extraText2) ? "MLA" : "ДСТУ 8302:2015");
  const isAPA = /APA/i.test(sourcesStyle);
  const isMLA = /MLA/i.test(sourcesStyle);
  const isDstu = /ДСТУ/i.test(sourcesStyle);
  const isFootnoteMode = order.citFootnotes && isDstu;
  const _effectiveOrderRemap = order.sourcesOrderOverride || methodInfo?.sourcesOrder;
  const isAlphabeticalOrder = !_effectiveOrderRemap || _effectiveOrderRemap === "alphabetical";
  const skipSortRemap = !isAlphabeticalOrder && !isDstu;
  // Заголовки "І. Нормативна"/"ІІ. Спеціальна" мають сенс лише в алфавітному режимі:
  // саме тоді список лишається відсортованим законами-вперед аж до фінального
  // тексту. У режимі "порядок появи в тексті" (citation_order, isAlphabeticalOrder
  // false) нижче є окрема ділянка, що перебудовує порядок джерел за першою згадкою
  // в тексті — вона ламає групування законів, тож заголовки там показали б
  // "І."/"ІІ." у довільних, переплетених місцях списку.
  const needsHeaders = isAlphabeticalOrder && needsNormativeSectionHeaders(methodInfo?.sourcesFormatRules);

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

  const _remapWorkLang = info?.language || "Українська";
  // Для будь-якої неукраїнської роботи (зокрема чеської/словацької/китайської, яких тут раніше не було)
  const _remapLatinFirst = getLangLabels(_remapWorkLang).code !== "uk";
  const _remapPageAbbrev = getLangLabels(_remapWorkLang).pageAbbrev;

  const structuredByTitle2 = {};
  Object.values(order.citStructured || {}).forEach(papers => {
    (papers || []).forEach(p => {
      if (p.title) structuredByTitle2[p.title.toLowerCase().slice(0, 60)] = p;
    });
  });
  const findStructured2 = (refText) => {
    const lower = refText.toLowerCase();
    for (const [key, paper] of Object.entries(structuredByTitle2)) {
      if (lower.includes(key)) return paper;
    }
    return null;
  };

  let { finalTexts: allRefs, indexMap } = await buildFinalReferenceList({
    rawRefs, findStructured: findStructured2, sourcesStyle, isLatinWork: _remapLatinFirst,
    sourcesFormatRules: methodInfo?.sourcesFormatRules, sourcesGrouping: methodInfo?.sourcesGrouping, callClaude: doCallClaude,
    skipSort: skipSortRemap,
  });
  if (ctx.signal?.aborted) return {};
  let fmtLines = allRefs;
  let fmtResult = assembleSourcesText(allRefs, needsHeaders);

  const secLocalToGlobal = {};
  mainSecs.forEach(sec => {
    secLocalToGlobal[sec.id] = {};
    Object.entries(secLocalSources[sec.id]).forEach(([localN, text]) => {
      const rawIdx = deduper.add(text);
      secLocalToGlobal[sec.id][Number(localN)] = indexMap[rawIdx];
    });
  });

  // Сторінки в посиланнях — за вимогою методички ("[N]" без сторінок / "[N, с. X]")
  const { refCiteText, pageRanges: pageRanges2, pdfUrls } = buildCiteFormats({
    finalTexts: allRefs, rawRefs, indexMap, findStructured: findStructured2,
    isAPA, isMLA, isFootnoteMode, pagePolicy: detectInTextPagePolicy(methodInfo?.citationStyle),
  });

  // "Сторінка за змістом" (перемикач на етапі джерел): сторінку кожного посилання
  // обирає збіг речення з текстом PDF джерела; без PDF чи при слабкому збігу — як звичайно
  let contentPickers = {};
  if (order.pageByContent && !isFootnoteMode && Object.keys(pdfUrls).length) {
    try {
      contentPickers = await buildContentPagePickers({
        texts: Object.fromEntries(mainSecs.map(s => [s.id, order.content?.[s.id] || ""])),
        mappingFor: id => secLocalToGlobal[id], pdfUrls, pageRanges: pageRanges2,
      });
    } catch (e) {
      console.error("Сторінка за змістом: не вдалось зіставити з PDF —", e.message);
    }
  }

  const newContent = { ...order.content };
  mainSecs.forEach(sec => {
    if (!newContent[sec.id]) return;
    const mapping = secLocalToGlobal[sec.id];
    if (!mapping || !Object.keys(mapping).length) return;
    newContent[sec.id] = applyCitationRemap(newContent[sec.id], mapping, refCiteText, {
      pageRanges: pageRanges2, pageAbbrev: _remapPageAbbrev, pagePicker: contentPickers[sec.id],
    });
  });

  const citedGlobalNums = new Set();
  mainSecs.forEach(sec => {
    const text = newContent[sec.id];
    if (!text) return;
    if (isFootnoteMode) {
      [...text.matchAll(/%%FN(\d+)%%/g)].forEach(m => citedGlobalNums.add(Number(m[1])));
    } else if (isAPA || isMLA) {
      // "(Автор, Рік)" у тексті буває зі сторінкою "(Автор, Рік, с. 5)" чи в групі —
      // раніше такі джерела вважались непроцитованими і довставлялись удруге
      Object.entries(refCiteText).forEach(([n, cite]) => { if (isAuthorYearCited(text, cite)) citedGlobalNums.add(Number(n)); });
    } else {
      extractCitedNumbers(text).forEach(n => citedGlobalNums.add(n));
    }
  });

  // Готова частина клієнта йде в роботу як є: джерела з її списку без посилань у тексті
  // лишаються в спільному списку, але посилання на них у готовий текст не довставляємо
  const importedIds = new Set(order.readyWorkImportedIds || []);
  const orphans = [];
  const seenOrphanGlobalNums = new Set();
  mainSecs.forEach(sec => {
    if (importedIds.has(sec.id)) return;
    Object.entries(secLocalToGlobal[sec.id] || {}).forEach(([, globalN]) => {
      if (!globalN || citedGlobalNums.has(globalN) || seenOrphanGlobalNums.has(globalN)) return;
      seenOrphanGlobalNums.add(globalN);
      orphans.push({ sec, globalN });
    });
  });

  const unresolvedOrphans = [];
  const orphansBySec = new Map();
  orphans.forEach(o => {
    if (!newContent[o.sec.id]) return;
    if (!orphansBySec.has(o.sec.id)) orphansBySec.set(o.sec.id, []);
    orphansBySec.get(o.sec.id).push(o);
  });
  await Promise.all([...orphansBySec.entries()].map(async ([secId, secOrphans]) => {
    if (ctx.signal?.aborted) return;
    const insertions = secOrphans.map(({ globalN }) => ({
      number: globalN,
      // одразу зі сторінкою (якщо діапазон відомий) — після довставки прохід сторінок уже не йде
      marker: citationMarkerWithPage(globalN, refCiteText, pageRanges2, _remapPageAbbrev),
      sourceText: allRefs[globalN - 1],
    }));
    try {
      const { text, unresolved } = await insertMissingCitations({
        sectionText: newContent[secId], insertions, lang: _remapWorkLang,
        callClaude: doCallClaude, signal: ctx.signal,
      });
      newContent[secId] = text;
      unresolvedOrphans.push(...unresolved);
    } catch (e) {
      console.error("Помилка вставки цитат непроцитованих джерел", secId, e);
      unresolvedOrphans.push(...secOrphans.map(o => o.globalN));
    }
  }));
  if (ctx.signal?.aborted) return {};

  if (unresolvedOrphans.length) {
    const removed = new Set(unresolvedOrphans);
    const oldToNewGlobal = {};
    let nextN = 1;
    allRefs.forEach((_, i) => {
      const oldN = i + 1;
      if (!removed.has(oldN)) oldToNewGlobal[oldN] = nextN++;
    });
    if (!isAPA && !isMLA) {
      const newRefCiteText = {};
      const newPageRanges = {};
      Object.entries(oldToNewGlobal).forEach(([oldNStr, newN]) => {
        const oldN = Number(oldNStr);
        newRefCiteText[newN] = isFootnoteMode ? `%%FN${newN}%%` : `[${newN}]`;
        if (pageRanges2[oldN]) newPageRanges[newN] = pageRanges2[oldN];
      });
      mainSecs.forEach(sec => {
        if (!newContent[sec.id]) return;
        newContent[sec.id] = applyCitationRemap(newContent[sec.id], oldToNewGlobal, newRefCiteText, { pageRanges: newPageRanges, pageAbbrev: _remapPageAbbrev });
      });
    }
    allRefs = allRefs.filter((_, i) => !removed.has(i + 1));
    fmtLines = allRefs;
    fmtResult = assembleSourcesText(allRefs, needsHeaders);
  }

  if (!isAPA && !isMLA) {
    // Номери поза списком (галюциновані/видалені) прибираємо з позначки поелементно —
    // раніше через один хибний номер зникала вся група разом із правильними
    mainSecs.forEach(sec => {
      if (!newContent[sec.id]) return;
      let removedWhole = false;
      const cleaned = replaceCitationBrackets(newContent[sec.id], (items, whole) => {
        const valid = items.filter(it => it.n >= 1 && it.n <= fmtLines.length);
        if (valid.length === items.length) return whole;
        if (!valid.length) { removedWhole = true; return ""; }
        return rebuildBracket(valid);
      });
      // прибрана позначка лишає "висячий" пробіл перед розділовим знаком ("стану ." → "стану.")
      newContent[sec.id] = removedWhole ? cleaned.replace(/ +([.,;:!?])/g, "$1") : cleaned;
    });
  }

  if (!isAPA && !isMLA && !isAlphabeticalOrder) {
    const firstSeen = [], seen = new Set();
    mainSecs.forEach(sec => {
      extractCitedNumbers(newContent[sec.id] || "").forEach(n => {
        if (!seen.has(n)) { seen.add(n); firstSeen.push(n); }
      });
    });
    const oldToNew = {};
    firstSeen.forEach((oldN, idx) => { oldToNew[oldN] = idx + 1; });
    let nextNew = firstSeen.length + 1;
    fmtLines.forEach((_, i) => { const n = i + 1; if (!oldToNew[n]) oldToNew[n] = nextNew++; });

    if (Object.entries(oldToNew).some(([old, nw]) => Number(old) !== nw)) {
      mainSecs.forEach(sec => {
        if (!newContent[sec.id]) return;
        // Сторінки кожного елемента (і в групах) зберігаються як є, разом зі скороченням
        // ("с."/"p.") — раніше група втрачала сторінки, а "с." ставилось навіть в англомовній роботі
        newContent[sec.id] = replaceCitationBrackets(newContent[sec.id], items => {
          const renumbered = [];
          for (const it of items) {
            const nw = oldToNew[it.n];
            if (!nw || renumbered.some(r => r.n === nw)) continue;
            renumbered.push({ ...it, n: nw, raw: it.raw.replace(/^\d+/, String(nw)) });
          }
          return renumbered.length ? rebuildBracket(renumbered) : null;
        });
      });

      const newFmtLines = new Array(fmtLines.length);
      fmtLines.forEach((line, i) => {
        const newIdx = oldToNew[i + 1] - 1;
        if (newIdx >= 0 && newIdx < newFmtLines.length) newFmtLines[newIdx] = line;
      });
      fmtResult = newFmtLines
        .map((line, i) => line ? `${i + 1}. ${line.replace(/^\d+\.\s*/, "")}` : null)
        .filter(Boolean).join("\n");
    }
  }

  const srcSec = sections.find(s => s.type === "sources");
  if (srcSec) newContent[srcSec.id] = fmtResult || assembleSourcesText(allRefs, needsHeaders);
  // "І./ІІ." — це лише візуальні підписи розділів, не джерела: якщо їх пропустити
  // в підрахунок (refList.length живить "Кількість використаних джерел" в анотації
  // й перевірку мінімуму джерел), кожен заголовок сплутається з реальним джерелом.
  const NORMATIVE_HEADER_LINES = new Set(["І. Нормативна література", "ІІ. Спеціальна література"]);
  const newRefList = (fmtResult || assembleSourcesText(allRefs, needsHeaders))
    .split("\n").filter(l => l && !NORMATIVE_HEADER_LINES.has(l));

  if (!ctx.signal?.aborted) {
    const totalTargetWords = sections.reduce((sum, s) => sum + Number(s.pages || 0) * 230, 0);
    const adjustedVolume = await enforceTotalVolume({
      sections, content: newContent, targetWords: totalTargetWords,
      isEligible: (s) => !["intro", "conclusions", "sources", "chapter_conclusion"].includes(s.type) && !importedIds.has(s.id),
      callClaude: doCallClaude, signal: ctx.signal,
      sys: buildSYS(_remapWorkLang, methodInfo, normalizeWorkType(info?.type, info?.course)),
      clean: stripEmDash, lang: _remapWorkLang,
    });
    Object.assign(newContent, adjustedVolume);
  }

  if (!ctx.signal?.aborted) {
    const introSec = sections.find(s => s.type === "intro");
    if (introSec && newContent[introSec.id]?.includes("__TOTAL_PAGES__")) {
      const pagesPerSection = await Promise.all(
        sections.map(s => estimateRealPages(newContent[s.id] || "", methodInfo?.formatting, _remapWorkLang))
      );
      const actualPages = Math.max(1, pagesPerSection.reduce((sum, p) => sum + p, 0));
      newContent[introSec.id] = newContent[introSec.id].replaceAll("__TOTAL_PAGES__", String(actualPages));
    }
  }

  const patch = {
    content: newContent, citInputs, citStructured: order.citStructured,
    refList: newRefList, stage: "done", status: "done",
  };

  const wt = normalizeWorkType(info?.type, info?.course);
  if (wt === "master" || wt === "bachelor") {
    try {
      Object.assign(patch, await genAnnotation({ ...order, refList: newRefList }, newContent, newRefList, ctx));
    } catch (e) {
      console.error("doGenAnnotation error:", e);
    }
  }

  return patch;
}

// ── Чи потребує ЦЕЙ підрозділ уже готового Додатку А, перш ніж його можна
// писати — та сама умова, що й ворота в циклі написання academic-assistant.jsx
// (useEffect коло runSection: "appendicesLoading && !appendicesText" тощо).
// Викликач (браузерний цикл чи воркер) має сам вирішувати, чи чекати, коли
// ця функція повертає true, а Додаток А ще не готовий — сама вона нічого не чекає. ──
export function sectionNeedsAppendix(sec, order) {
  const empSecs = getEmpiricalSections(order.sections, order.info, order.commentAnalysis, order.methodInfo);
  const hasEmpirical = hasEmpiricalResearch(order.commentAnalysis, order.methodInfo);
  const practApproach = order.commentAnalysis?.practicalApproach;
  return !!(empSecs.chapterSectionIds.includes(sec.id) || sec.id === empSecs.anchorId ||
    (hasEmpirical && ["analysis", "recommendations"].includes(sec.type)) ||
    (practApproach && practApproach !== "questionnaire" && ["analysis", "recommendations"].includes(sec.type)));
}

/**
 * Чи потрібен Додаток А для цього замовлення взагалі, і якщо так — генерувати
 * його ДО написання тексту (реальний інструмент: методика/тест/експеримент,
 * або економічна/технічна робота — джерело істини не залежить від того, що
 * напише ШІ) чи ВІДКЛАСТИ до готового тексту (авторська анкета без фіксованого
 * інструменту — щоб додаток узгодився з реально написаною вибіркою). Та сама
 * логіка, що й у startGen() (academic-assistant.jsx, needsAppendixForGen/
 * appendixDeferredRef).
 * @returns {{needsAppendix: boolean, deferred: boolean}}
 */
export function planAppendixGeneration(order) {
  const info = order.info;
  const acadDefaults = getAcademicDefaults(info?.subject, info?.type, info?.course, info?.topic);
  const specialtyRecognized = !!detectSpecialty(info?.subject || "");
  const needsAppendix = !!(order.commentAnalysis?.practicalApproach || isPsychoPed(info) || (acadDefaults?.appendicesAiGen?.length > 0) || !specialtyRecognized);
  const instrumentType = order.commentAnalysis?.researchDesign?.instrumentType;
  const isRealInstrument = ["psycho_scale", "fitness_test", "pedagogical_experiment"].includes(instrumentType);
  const deferred = needsAppendix && !isRealInstrument && !isEcon(info) && !isTechnical(info);
  return { needsAppendix, deferred };
}

// ── Додаток із лістингами вихідного коду клієнта (лише для технічних робіт,
// коли серед матеріалів клієнта є файли коду) — перенесено без зміни логіки ──
function buildCodeAppendixBlock(order, existingText, lang) {
  if (!isTechnical(order.info)) return "";
  const codeMaterials = (order.clientMaterials || []).filter(m =>
    CODE_FILE_EXTENSIONS.some(ext => m.name.toLowerCase().endsWith(ext))
  );
  if (!codeMaterials.length) return "";

  const lc = getLangLabels(lang);
  const abc = lc.appendixLetters;
  const usedLetters = new Set();
  const re = appendixLetterRegex();
  let m;
  while ((m = re.exec(existingText || "")) !== null) usedLetters.add(m[1].toUpperCase());
  const letter = abc.find(l => !usedLetters.has(l)) || abc[abc.length - 1];

  const listings = codeMaterials.map((mat, idx) =>
    `${lc.listingWord} ${letter}.${idx + 1} — ${mat.name}\n\`\`\`\n${mat.text}\n\`\`\``
  ).join("\n\n");
  return `\n${lc.appendixSingular} ${letter}\n${lc.sourceCodeTitle}\n\n${listings}`;
}

/**
 * Генерує базовий профіль підприємства для економічних/управлінських робіт
 * (реальне з матеріалів клієнта, реальне знайдене в мережі, або правдоподібне
 * умовне) — той самий текст, на який спирається і Додаток А (runAppendicesStage),
 * і підрозділи аналітичної частини (isFirstAnalysisSubsection/econBlock у
 * writing). Перенесено з doGenEconProfile (academic-assistant.jsx) без зміни
 * логіки, щоб той самий крок міг виконати і браузер, і воркер.
 *
 * @param {object} order - info, methodInfo, clientMaterialsSummary, clientMaterialsText
 * @param {object} ctx - { callClaude, onCost? }
 * @returns {Promise<{econProfile: string, companyWebsite?: string, titlePage?: string, titlePageLines?: Array}>}
 */
export async function runEconProfileStage(order, ctx) {
  const info = order.info;
  const methodInfo = order.methodInfo;
  const lang = info?.language || "Українська";
  const realMaterials = order.clientMaterialsSummary?.rawText || order.clientMaterialsText?.trim() || "";
  const needsFullProfile = !!methodInfo?.requiresEnterpriseProfile;

  const fullFieldsReal = `Форма власності: [форма власності/організаційно-правова форма з матеріалів, якщо є — інакше "дані відсутні в матеріалах клієнта, потрібно уточнити"]
Рік заснування / історія: [з матеріалів, якщо є — інакше позначка про відсутність даних]
Статутний фонд: [з матеріалів, якщо є — інакше позначка про відсутність даних]
Продукція/послуги: [з матеріалів, якщо є — інакше позначка про відсутність даних]
Ринки збуту: [з матеріалів, якщо є — інакше позначка про відсутність даних]
Основні конкуренти: [з матеріалів, якщо є — інакше позначка про відсутність даних]
`;
  const fullFieldsFallback = `Форма власності: [приватна/колективна тощо + організаційно-правова форма, напр. ТОВ/ПрАТ/ФОП, відповідно до галузі]
Рік заснування / коротка історія: [1 речення]
Статутний фонд: [сума в тис. грн]
Продукція/послуги: [що виробляє чи надає]
Ринки збуту: [регіон/сегмент]
Основні конкуренти: [2-3 типових для галузі]
`;
  const fullFieldsWeb = `Форма власності: [з результатів пошуку, якщо є — інакше правдоподібне значення для цієї галузі]
Рік заснування / історія: [з результатів пошуку, якщо є — інакше правдоподібне значення]
Статутний фонд: [з результатів пошуку, якщо є — інакше правдоподібна сума в тис. грн]
Продукція/послуги: [з результатів пошуку, якщо є — інакше типове для галузі]
Ринки збуту: [з результатів пошуку, якщо є — інакше типове для галузі]
Основні конкуренти: [з результатів пошуку, якщо є — інакше 2-3 типових для галузі]
`;

  let searchResultsText = "";
  let companySearchResults = [];
  if (!realMaterials) {
    const companyQuery = [info?.subject, "підприємство", "Україна", "фінансова звітність"].filter(Boolean).join(" ");
    companySearchResults = await searchCompanyInfo(companyQuery, 8);
    if (companySearchResults.length) {
      searchResultsText = companySearchResults.map(r => `- ${r.title}\n  ${r.snippet}\n  ${r.url}`).join("\n");
    }
  }

  const prompt = realMaterials
    ? `На основі наведених нижче матеріалів клієнта визнач базовий профіль підприємства для роботи на тему "${info?.topic}". Галузь: ${info?.subject}.

МАТЕРІАЛИ КЛІЄНТА (реальні дані підприємства):
${realMaterials.slice(0, 80000)}

Виведи компактно, без markdown і зірочок, у форматі:
Підприємство: [точна назва з матеріалів]
Галузь: [галузь]
${needsFullProfile ? fullFieldsReal : ""}Період аналізу: [роки, наявні в матеріалах]
Базові показники: [ключові показники з матеріалів по роках — виручка, чистий прибуток, активи, власний капітал тощо, лише ті, що дійсно є в матеріалах]

Використовуй ТІЛЬКИ дані з матеріалів клієнта, нічого не вигадуй.${needsFullProfile ? " Якщо якогось із запитаних полів немає в матеріалах — так і зазнач, не вигадуй його." : ""}`
    : searchResultsText
    ? `Визнач базовий профіль підприємства для роботи на тему "${info?.topic}". Галузь: ${info?.subject}.
Клієнт не надав власних матеріалів — нижче результати пошуку реальних підприємств цієї галузі у відкритих джерелах.

РЕЗУЛЬТАТИ ПОШУКУ:
${searchResultsText}

Обери ОДНЕ реальне підприємство з результатів пошуку (реальна назва компанії — не вигадуй назву, якщо серед результатів є хоч одна релевантна). Використовуй ТІЛЬКИ ті факти й цифри, що дійсно є в наведених фрагментах — не приписуй компанії даних, яких там немає. Поля, для яких у результатах пошуку інформації немає, заповни правдоподібним прикладом, типовим для цієї галузі — профіль має виглядати завершеним, без позначок "дані відсутні".${needsFullProfile ? " Методичка вимагає характеристику КОНКРЕТНОГО підприємства (назва, форма власності, історія тощо)." : ""}
Якщо серед результатів пошуку немає жодного реального підприємства цієї галузі (самі нерелевантні сторінки) — використай замість реальної правдоподібну умовну назву, як і решту профілю.

Виведи компактно, без markdown і зірочок, у форматі:
Підприємство: [реальна назва з результатів пошуку, або умовна назва, якщо релевантних результатів немає]
Галузь: [галузь]
${needsFullProfile ? fullFieldsWeb : ""}Період аналізу: [роки, знайдені в результатах пошуку, якщо є — інакше останні 3-4 завершені роки]
Базові показники: [реальні показники з результатів пошуку, якщо знайдені — інакше правдоподібні числові значення в тис. грн, внутрішньо узгоджені за роками]

Ці дані будуть використані як незмінна основа для всіх розрахунків і таблиць у роботі, тому цифри мають бути внутрішньо узгодженими (динаміка логічна, показники не суперечать один одному).`
    : `Створи умовний базовий профіль підприємства для роботи на тему "${info?.topic}". Галузь: ${info?.subject}.
Клієнт не надав реальної фінансової звітності, тому потрібен правдоподібний умовний приклад.${needsFullProfile ? " Методичка вимагає характеристику КОНКРЕТНОГО підприємства (назва, форма власності, історія тощо) — тому не обмежуйся узагальненим \"умовним підприємством\", підприємство має мати конкретну назву та реквізити нижче." : ""}

Виведи компактно, без markdown і зірочок, у форматі:
Підприємство: [правдоподібна умовна назва${needsFullProfile ? " у форматі ТОВ/ПрАТ/ФОП тощо" : ""} відповідно до галузі]
Галузь: [галузь]
${needsFullProfile ? fullFieldsFallback : ""}Період аналізу: [останні 3-4 завершені роки]
Базові показники: [виручка, чистий прибуток, активи, власний капітал та інші релевантні показники за кожен рік періоду — конкретні числові значення в тис. грн]

Ці дані будуть використані як незмінна основа для всіх розрахунків і таблиць у роботі, тому цифри мають бути внутрішньо узгодженими (динаміка логічна, показники не суперечать один одному).`;

  const raw = await ctx.callClaude([{ role: "user", content: prompt }], null, buildSYS(lang, methodInfo, normalizeWorkType(info?.type, info?.course)), 1200, null, MODEL_FAST, { onCost: ctx.onCost });
  const result = stripStrayCJK(raw
    .replace(/ — /g, ", ").replace(/— /g, " ").replace(/ —/g, " "), lang)
    .trim();

  const patch = { econProfile: result };
  const website = findWebsiteInText(realMaterials) || pickWebsiteFromSearchResults(companySearchResults);
  if (website) patch.companyWebsite = website;

  // Титулка могла бути заповнена раніше з буквальним "[НАЗВА ПІДПРИЄМСТВА]" (тема
  // "на матеріалах ..."), бо на кроці аналізу методички назва ще не була відома —
  // підставляємо її заднім числом, тепер коли профіль готовий.
  if (Array.isArray(order.titlePageLines)) {
    const newLines = order.titlePageLines.map(l => ({ ...l, text: fillEnterpriseNameToken(l.text, result) }));
    if (newLines.some((l, i) => l.text !== order.titlePageLines[i].text)) patch.titlePageLines = newLines;
  }
  if (order.titlePage) {
    const newTitlePage = fillEnterpriseNameToken(order.titlePage, result);
    if (newTitlePage !== order.titlePage) patch.titlePage = newTitlePage;
  }

  return patch;
}

/**
 * Генерує Додаток А (інструмент дослідження — анкета/методика/тест/експеримент
 * — або таблиці/схеми/програми за таблицею academicDefaults, залежно від
 * спеціальності). Перенесено з doGenAppendices без зміни логіки.
 *
 * @param {object} order - info, methodInfo, commentAnalysis, sections, content,
 *   clientMaterialsSummary, clientMaterialsText, econProfile, appendicesCustomPrompt,
 *   clientMaterials (для коду, лише технічні роботи)
 * @param {object} ctx - { callClaude, signal?, onCost? }
 * @param {object} [opts] - { econProfileOverride, finishedBodyTextOverride } —
 *   friendBodyTextOverride задається для ВІДКЛАДЕНОЇ генерації (після тексту),
 *   econProfileOverride — коли профіль підприємства щойно згенеровано окремо
 *   і ще не встиг потрапити в order.econProfile
 * @returns {Promise<{appendicesText: string}>}
 */
export async function runAppendicesStage(order, ctx, opts = {}) {
  const info = order.info;
  const methodInfo = order.methodInfo;
  const commentAnalysis = order.commentAnalysis;
  const sections = order.sections || [];
  const content = order.content || {};
  const lang = info?.language || "Українська";
  // Позначка додатка мовою роботи: "ДОДАТОК А" / "APPENDIX A" / "ZAŁĄCZNIK A" — раніше завжди
  // "ДОДАТОК", і в англійській роботі він або лишався українським, або (перекладений моделлю)
  // не впізнавався експортом як заголовок додатка.
  const appLc = getLangLabels(lang);
  const appLabel = (i) => `${appLc.appendixSingular} ${appLc.appendixLetters[i]}`;

  const mainSecs = sections.filter(s => !["intro", "conclusions", "sources", "chapter_conclusion"].includes(s.type));
  const planBlock = mainSecs.length
    ? `СТРУКТУРА РОБОТИ:\n${mainSecs.map(s => `- ${s.label} (${s.type})`).join("\n")}`
    : "";

  const realMaterialsForApp = order.clientMaterialsSummary?.rawText || order.clientMaterialsText?.trim() || "";
  const econProfileForApp = opts.econProfileOverride !== undefined ? opts.econProfileOverride : order.econProfile;
  const groundingBlock = isTechnical(info) && realMaterialsForApp
    ? `\nМАТЕРІАЛИ КЛІЄНТА (реальний код — використовуй ці дані: посилайся на фактичні назви класів/функцій, мову програмування та тип інтерфейсу з цього коду, не вигадуй іншу архітектуру):\n${realMaterialsForApp.slice(0, 80000)}\n`
    : (isEcon(info) && econProfileForApp)
      ? `\nФІКСОВАНІ БАЗОВІ ДАНІ ПІДПРИЄМСТВА (використовуй САМЕ ЦІ дані, не вигадуй іншу назву/рік/цифри):\n${econProfileForApp}\n`
      : "";

  const methodBlock = methodInfo?.theoryRequirements || methodInfo?.analysisRequirements || methodInfo?.otherRequirements
    ? `ВИМОГИ МЕТОДИЧКИ: ${[methodInfo.theoryRequirements, methodInfo.analysisRequirements, methodInfo.otherRequirements].filter(Boolean).join(". ")}`
    : "";

  const bodyGroundingBlock = opts.finishedBodyTextOverride
    ? `\nТЕКСТ РОБОТИ ВЖЕ ПОВНІСТЮ НАПИСАНИЙ. Нижче наведені завершені емпіричні підрозділи — Додаток А ОБОВ'ЯЗКОВО має точно відповідати тому, що в них уже стверджується: та сама вибірка (кількість осіб, вік/клас/категорія, критерії відбору), той самий тип респондентів, той самий інструмент і кількість запитань. Це джерело істини, воно ПЕРЕВАЖАЄ над будь-якими загальними дефолтами чи прикладами нижче.\n\nЗАВЕРШЕНИЙ ТЕКСТ ЕМПІРИЧНОГО ДОСЛІДЖЕННЯ:\n${opts.finishedBodyTextOverride.slice(0, 60000)}\n`
    : "";

  const clientBlock = commentAnalysis?.writingHints
    ? `ПОБАЖАННЯ КЛІЄНТА: ${commentAnalysis.writingHints}`
    : "";

  const customBlock = order.appendicesCustomPrompt?.trim()
    ? `\nДОДАТКОВІ ІНСТРУКЦІЇ: ${order.appendicesCustomPrompt.trim()}`
    : "";

  const empSecs = getEmpiricalSections(sections, info, commentAnalysis, methodInfo);
  const hasEmpChapter = empSecs.chapterSectionIds.length > 0 || empSecs.anchorId;

  const promisesAppendixAnketa = Object.values(content || {}).some(text =>
    typeof text === "string" && text.split(/[.!?\n]/).some(s => /анкет/i.test(s) && /додат/i.test(s))
  );

  const rdApp = commentAnalysis?.researchDesign ?? (commentAnalysis?.empiricalHints ? { instrumentType: "questionnaire", groups: [], comparisonRequired: false, biographicalFields: [], statisticalMinN: null } : null);
  const hasEmpiricalApp = hasEmpiricalResearch(commentAnalysis, methodInfo) || isPsychoPed(info) || hasEmpChapter || promisesAppendixAnketa;
  const acadDefaultsApp = !rdApp ? getAcademicDefaults(info?.subject, info?.type, info?.course, info?.topic) : null;

  const empClientBlock = (() => {
    if (!rdApp && !commentAnalysis?.empiricalHints) return "";
    const parts = [];
    if (rdApp?.groups?.length) parts.push(`Групи учасників: ${rdApp.groups.map(g => `${g.name}${g.minN ? ` (мін. ${g.minN} осіб)` : ""}${g.criteria ? `, ${g.criteria}` : ""}`).join("; ")}.`);
    if (rdApp?.biographicalFields?.length) parts.push(`Біографічний блок анкети: ${rdApp.biographicalFields.join(", ")}.`);
    if (rdApp?.statisticalMinN) parts.push(`Загальна мін. вибірка: ${rdApp.statisticalMinN} осіб.`);
    if (rdApp?.comparisonRequired || (rdApp?.groups?.length || 0) > 1) parts.push("Передбачити порівняння між групами — питання мають бути однаковими для всіх груп.");
    if (!parts.length && commentAnalysis?.empiricalHints) return `ВИМОГА КЛІЄНТА: ${commentAnalysis.empiricalHints}\n`;
    return parts.length ? `ВИМОГА КЛІЄНТА:\n${parts.join("\n")}\n` : "";
  })();

  const needTwoQuestionnaires = rdApp?.groups?.length >= 2 ||
    /2\s*(дослідження|анкет|методик)|дві\s*(анкет|методик)|два\s*дослідження/i.test(commentAnalysis?.empiricalHints || "");

  const instrumentType = rdApp?.instrumentType || "questionnaire";
  const bioFieldsLine = rdApp?.biographicalFields?.length
    ? `Біографічний блок (перші запитання анкети): ${rdApp.biographicalFields.join(", ")}.`
    : "Біографічний блок (перші 4-5 запитань): ПІБ або псевдонім, вік, стаж, кваліфікація або посада.";

  const buildQuestionnairePrompt = (appendixLabel, groupDesc) => `Перший рядок: ${appendixLabel}
Другий рядок: назва анкети відповідно до теми роботи: "${info?.topic}"${groupDesc ? `, для групи: ${groupDesc}` : ""}.
Звернення до респондента та інструкція (2-3 речення).
${bioFieldsLine}
12-15 запитань закритого типу з варіантами відповідей: а), б), в), г).
Запитання логічно охоплюють різні аспекти теми "${info?.topic}"${groupDesc ? ` для групи: ${groupDesc}` : ""}.
В кінці: "Дякуємо за участь у дослідженні!"`;

  const buildScalePrompt = (appendixLabel) => `Перший рядок: ${appendixLabel}
Обери РЕАЛЬНУ, загальновідому стандартизовану психологічну методику (шкалу, опитувальник, тест), яка справді існує і відповідає темі роботи "${info?.topic}" (наприклад методики Айзенка, Розенберга, Кеттелла, Холмса-Рея, Спілбергера (оригінальна версія STAI, без російських адаптацій) та подібні залежно від теми).
СТРОГО ЗАБОРОНЕНО обирати методику, автор або адаптатор якої є російським чи білоруським науковцем (наприклад НЕ використовуй "Спілбергера-Ханіна" — Ханін є радянським/російським психологом; НЕ використовуй методики з прізвищами авторів-адаптаторів з Росії чи Білорусі). Обирай лише методики західних, українських або інших міжнародних (не рос./білор.) авторів. Якщо загальновідома методика має поширену в СНД назву з російським прізвищем — використай оригінальну назву автора (напр. оригінал Spielberger State-Trait Anxiety Inventory, без "-Ханіна").
Другий рядок: справжня назва цієї методики та автор(и).
Опис методики: мета, сфера застосування, кількість тверджень — як в оригіналі.
Інструкція для респондента — як в оригінальній методиці.
Відтвори пункти методики максимально точно як в офіційному оригіналі (ця методика загальновідома і вільно публікується в методичних збірниках, тому відтворення доречне). Якщо не повністю впевнений у дослівному формулюванні якогось пункту — формулюй його максимально близько до відомої структури та змісту цієї методики, не вигадуй нову методику з нуля.
Шкала відповідей та ключ до обробки — як в оригінальній методиці (розподіл балів, рівні).
СТРОГО ЗАБОРОНЕНО видавати вигадану (неіснуючу) методику за реальну. Якщо для теми справді немає підходящої стандартизованої методики — обери найближчу за тематикою реальну (не рос./білор. автора) і зазнач можливість адаптації.`;

  const buildFitnessTestPrompt = (appendixLabel) => `Перший рядок: ${appendixLabel}
Другий рядок: назва батареї тестів відповідно до теми роботи: "${info?.topic}".
Перелік 5-8 фізичних тестів або вимірювань: назва тесту, одиниці вимірювання, порядок проведення.
Нормативна таблиця: вікові норми або рівні (низький/нижчий за середній/середній/вищий за середній/високий).
Протокол фіксації результатів (таблиця для заповнення).`;

  const buildExperimentPrompt = (appendixLabel) => `Перший рядок: ${appendixLabel}
Другий рядок: назва протоколу педагогічного експерименту відповідно до теми роботи: "${info?.topic}".
Мета та гіпотеза експерименту відповідно до теми роботи: "${info?.topic}".
Опис контрольної та експериментальної груп (кількість, критерії відбору).
Констатувальний етап: діагностичний інструментарій (тести, завдання, спостереження) — 10-15 пунктів.
Формувальний етап: короткий опис педагогічного впливу або програми.
Контрольний етап: ті самі діагностичні інструменти для порівняння.
Протокол фіксації результатів до і після.`;

  const buildDataTableAppendixPart = (slot, itemName, topic) => `${slot} — ${itemName}.
Створи ілюстративну таблицю markdown (|---|---| формат) відповідно до теми "${topic}". Підпис таблиці одним рядком перед нею. За потреби короткий пояснювальний коментар під таблицею (2-3 речення).
Якщо ця таблиця узагальнює результати дослідження/опитування, що також описуються в основному тексті роботи (частки відповідей, середні оцінки, кількісні показники тощо) — постав у відповідні клітинки маркер із правила нижче замість вигаданих чисел, щоб цифри згодом узгодились з основним текстом. Якщо ж таблиця містить довідкові/нормативні дані, не пов'язані з результатами конкретного дослідження (наприклад загальні класифікації, нормативи, характеристики об'єктів) — заповнюй її реалістичними, правдоподібними даними одразу.`;

  const buildSchemeAppendixPart = (slot, itemName, topic) => `${slot} — ${itemName}.
Опиши схему/структуру у вигляді чіткого структурованого тексту (список рівнів, блоків і зв'язків між ними) відповідно до теми "${topic}". Це текстовий опис схеми, графічний рендер недоступний.`;

  const buildProgramAppendixPart = (slot, itemName, topic) => `${slot} — ${itemName}.
Розроби структуровану програму/методику/стратегію відповідно до теми "${topic}": мета, етапи або напрями роботи, конкретні заходи чи кроки, очікувані результати.`;

  const buildDocumentAppendixPart = (slot, itemName, topic) => `${slot} — ${itemName}.
Сформуй перелік або документ-зразок відповідно до теми "${topic}" — конкретні пункти, назви, реквізити. Не вигадуй реальні номери судових справ чи назви конкретних організацій, якщо вони не підтверджені контекстом.`;

  const buildFormAppendixPart = (slot, itemName, topic) => `${slot} — ${itemName}.
Створи бланк/протокол/гайд відповідно до теми "${topic}": структура, поля для заповнення, інструкція, 8-15 пунктів де доречно.`;

  const buildSoftwareTestProtocolAppendixPart = (slot, itemName, topic) => `${slot} — ${itemName}.
Створи протокол тестування функціональності програми відповідно до теми "${topic}": короткий вступний блок (назва програмного продукту, версія, мова реалізації, середовище виконання, шкала оцінювання результату: ПРОЙДЕНО / ПРОВАЛЕНО / ЧАСТКОВО), далі markdown-таблиця (|---|---| формат) з колонками: Тест | Умова | Очікуваний результат | Фактичний результат | Статус | Примітки. 6-10 рядків, що покривають ключові функції програми відповідно до теми (якщо в матеріалах клієнта є реальний код — тести мають відповідати саме тим функціям, що є в цьому коді). В кінці окремим рядком додай "Дата тестування: ${APPENDIX_FILL_MARKER}" — для цього протоколу дата теж позначається маркером (виняток із загального правила про порожній бланк для дати), бо вона підставляється автоматично.
У колонках "Фактичний результат" і "Статус" НЕ вигадуй конкретне значення — постав туди рівно текст ${APPENDIX_FILL_MARKER}, ці дані стають відомі лише після завершення написання роботи.`;

  const APPENDIX_BUILDERS = {
    data_table: buildDataTableAppendixPart,
    scheme: buildSchemeAppendixPart,
    program: buildProgramAppendixPart,
    document: buildDocumentAppendixPart,
    form: buildFormAppendixPart,
  };

  const isItSpecialty = detectSpecialty(info?.subject) === "it";

  const buildAcadDefaultsAppendixBlock = (candidates, topic) => {
    const parts = candidates.map(item => {
      const builder = (isItSpecialty && /тест/i.test(item))
        ? buildSoftwareTestProtocolAppendixPart
        : (APPENDIX_BUILDERS[classifyAppendixItem(item)] || buildFormAppendixPart);
      return builder(`[${appLc.appendixSingular}]`, item, topic);
    });
    const abc = getLangLabels(lang).appendixLetters;
    const sample = abc.slice(0, 3).join(", ");
    return `Можливі додатки для цієї роботи (оціни кожен і обери лише ті, що дійсно логічно потрібні для теми "${topic}" — не обов'язково всі, зазвичай достатньо 2-4):

${parts.join("\n\n---\n\n")}

Для кожного обраного додатку постав послідовну позначку ${appLc.appendixSingular} ${sample}... з ${abc.length === 24 ? "цієї української абетки (без Ґ, Є, З, І, Ї, Й, О, Ч, Ь)" : "латинської абетки"} (тільки для тих що дійсно генеруєш, без пропусків у нумерації).
Якщо для якогось додатку доречно посилатись на конкретну методику, теорію, модель або стандарт — СТРОГО ЗАБОРОНЕНО використовувати ті, чий автор є російським чи білоруським науковцем. Обирай лише західні, українські або інші міжнародні (не рос./білор.) джерела.`;
  };

  let prompt;
  if (hasEmpiricalApp && !order.appendicesCustomPrompt?.trim()) {
    const header = `Згенеруй інструмент дослідження (Додаток А) для ${info?.type || "наукової роботи"} на тему "${info?.topic}". Галузь: ${info?.subject}.
${planBlock}
${methodBlock}
${empClientBlock}${clientBlock}${groundingBlock}${bodyGroundingBlock}
Мова: ${lang}. БЕЗ markdown, зірочок, жирного. Звичайний текст.`;

    if (instrumentType === "psycho_scale") {
      prompt = `${header}\n\n${buildScalePrompt(appLabel(0))}`;
    } else if (instrumentType === "fitness_test") {
      prompt = `${header}\n\n${buildFitnessTestPrompt(appLabel(0))}`;
    } else if (instrumentType === "pedagogical_experiment") {
      prompt = `${header}\n\n${buildExperimentPrompt(appLabel(0))}`;
    } else if (needTwoQuestionnaires && rdApp?.groups?.length >= 2) {
      const g1 = rdApp.groups[0];
      const g2 = rdApp.groups[1];
      prompt = `${header}

Кожен додаток — окрема анкета для своєї групи учасників.

${appLabel(0)} — анкета для групи: ${g1.name}${g1.criteria ? ` (${g1.criteria})` : ""}.
${buildQuestionnairePrompt(appLabel(0), g1.name)}

---

${appLabel(1)} — анкета для групи: ${g2.name}${g2.criteria ? ` (${g2.criteria})` : ""}.
${buildQuestionnairePrompt(appLabel(1), g2.name)}
${rdApp.groups.length > 2 ? `\nПримітка: якщо є третя група (${rdApp.groups[2]?.name}), використовують той самий інструмент що й для найближчої за профілем групи.` : ""}`;
    } else if (acadDefaultsApp?.instrumentsCount > 1) {
      const n = acadDefaultsApp.instrumentsCount;
      const letters = (getLangLabels(lang).appendixLetters || []).slice(0, n);
      const blocks = letters.map((letter, i) => {
        const label = `${appLc.appendixSingular} ${letter}`;
        if (i === 0) return `${label} — авторська анкета.\n${buildQuestionnairePrompt(label, "")}`;
        return `${label} — окрема реальна психологічна методика (шкала/тест), відмінна від анкети та інших методик у цьому списку.\n${buildScalePrompt(label)}`;
      }).join("\n\n---\n\n");
      prompt = `${header}

Згенеруй ${n} окремі додатки — інструменти дослідження для емпіричної частини (${letters[0]} — авторська анкета, решта — реальні стандартизовані психологічні методики, кожна відмінна від інших), усі відповідно до теми.

${blocks}`;
    } else if (acadDefaultsApp?.appendicesAiGen?.length > 0) {
      prompt = `${header}

${buildAcadDefaultsAppendixBlock(acadDefaultsApp.appendicesAiGen, info?.topic)}`;
    } else {
      prompt = `${header}

Додаток А містить анкету для емпіричного дослідження.${rdApp?.groups?.length ? ` Основна група респондентів: ${rdApp.groups[0].name}${rdApp.groups[0].criteria ? ` (${rdApp.groups[0].criteria})` : ""}.` : ""}
Визнач що саме досліджується відповідно до теми.

${buildQuestionnairePrompt(appLabel(0), rdApp?.groups?.[0]?.name || "")}`;
    }
  } else if (!order.appendicesCustomPrompt?.trim() && acadDefaultsApp?.appendicesAiGen?.length > 0) {
    const header = `Згенеруй Додатки для ${info?.type || "наукової роботи"} на тему "${info?.topic}". Галузь: ${info?.subject}.
${planBlock}
${methodBlock}
${clientBlock}${groundingBlock}${bodyGroundingBlock}
Мова: ${lang}. БЕЗ markdown, зірочок, жирного. Звичайний текст.`;
    prompt = `${header}

${buildAcadDefaultsAppendixBlock(acadDefaultsApp.appendicesAiGen, info?.topic)}`;
  } else {
    prompt = `Згенеруй розділ "Додатки" для ${info?.type || "наукової роботи"} на тему "${info?.topic}". Галузь: ${info?.subject || ""}.
${planBlock}
${methodBlock}
${clientBlock}${groundingBlock}${bodyGroundingBlock}
${customBlock || `Включи один або два додатки що логічно доповнюють роботу відповідно до теми та структури (таблиці, схеми, зразки документів тощо).`}
Мова: ${lang}. БЕЗ markdown, зірочок, жирного. Кожен додаток починається з нового рядка: ${appLabel(0)}, ${appLabel(1)} тощо.`;
  }

  prompt += `\n\n${APPENDIX_FILL_MARKER_RULE}`;

  // 6000 токенів не вистачало, коли методичка/тема вимагали кілька додатків одразу
  // (instrumentsCount>1, кілька позицій з acadDefaultsApp) — відповідь обрізалась,
  // і додатки, що йшли після місця обриву, просто зникали з appendicesText
  // (той самий клас бага, що й у runClientSourcesDistributionStage нижче).
  const raw = await ctx.callClaude(
    [{ role: "user", content: prompt }], ctx.signal, buildSYS(lang, methodInfo, normalizeWorkType(info?.type, info?.course)), 16000, null, MODEL, { onCost: ctx.onCost }
  );
  const result = typographQuotes(stripStrayCJK(raw
    .replace(/ — /g, ", ").replace(/— /g, " ").replace(/ —/g, " "), lang), lang)
    .replace(/\n{2,}/g, '\n');
  const finalResult = result + buildCodeAppendixBlock(order, result, lang);
  return { appendicesText: finalResult };
}

/**
 * Автозаповнення полів Додатків, позначених маркером ЗАПОВНЮЄТЬСЯ_АВТОМАТИЧНО,
 * коли основний текст роботи вже готовий (напр. "Фактичний результат"/"Статус"
 * у протоколі тестування — стають відомі лише після написання розділів).
 * Перенесено з doFillAppendixData; на відміну від оригіналу тут немає
 * "виконати лише раз" — це рішення викликача (там був appendixFillDoneRef).
 *
 * @param {object} order - appendicesText, sections, content, info, methodInfo
 * @param {object} ctx - { callClaude, signal?, onCost? }
 * @returns {Promise<{appendicesText?: string}>} порожній патч, якщо маркерів
 *   немає взагалі (нічого робити) або якщо фінальний виклик ШІ провалився
 *   (лишаємо appendicesText як є, так само як в оригіналі)
 */
export async function runFillAppendixDataStage(order, ctx) {
  if (!order.appendicesText || !order.appendicesText.includes(APPENDIX_FILL_MARKER)) return {};
  const info = order.info;
  const todayStr = new Date().toLocaleDateString("uk-UA");
  const dateFilledText = order.appendicesText.replace(
    new RegExp(`(Дата тестування:\\s*)${APPENDIX_FILL_MARKER}`, "g"),
    `$1${todayStr}`
  );
  if (!dateFilledText.includes(APPENDIX_FILL_MARKER)) {
    return { appendicesText: dateFilledText };
  }
  const finishedText = (order.sections || [])
    .filter(s => s.type !== "sources")
    .map(s => (order.content || {})[s.id])
    .filter(Boolean)
    .join("\n\n");

  // Раніше ШІ просили дослівно повернути ВЕСЬ текст додатків (усі додатки одразу)
  // з підставленими значеннями — при кількох великих додатках це впиралось у стелю
  // токенів, обрізана відповідь замінювала appendicesText цілком, і додатки, які не
  // встигли влізти в ліміт повторного виводу, зникали зовсім. Натомість просимо лише
  // короткий список значень для маркерів (з контекстом рядка навколо кожного), а
  // підстановку в оригінальний текст робимо детерміновано в коді — без ризику
  // втратити частину додатків через обрізання.
  const lines = dateFilledText.split("\n");
  const contexts = [];
  let currentAppendixLabel = "";
  lines.forEach((line, idx) => {
    if (appendixLabelRe().test(line.trim())) currentAppendixLabel = line.trim();
    const count = line.split(APPENDIX_FILL_MARKER).length - 1;
    for (let k = 0; k < count; k++) {
      const before = lines.slice(Math.max(0, idx - 3), idx).filter(l => l.trim()).join(" | ");
      contexts.push(`${contexts.length + 1}. [${currentAppendixLabel || "Додаток"}] ${before ? before + " || " : ""}${line.trim()}`);
    }
  });

  const prompt = `Нижче наведено список полів розділу "Додатки" ${info?.type || "наукової роботи"} на тему "${info?.topic}", позначених маркером ${APPENDIX_FILL_MARKER}, — потрібно визначити значення для кожного з них на основі вже повністю готового основного тексту роботи.

ОСНОВНИЙ ТЕКСТ РОБОТИ (спирайся лише на нього, не вигадуй даних, що йому суперечать):
${finishedText.slice(0, 60000)}

ПОЛЯ ДЛЯ ЗАПОВНЕННЯ (у порядку появи в тексті додатків; "||" відділяє контекст рядків перед полем від самого рядка з маркером):
${contexts.join("\n")}

Для КОЖНОГО пункту зі списку вище визнач одне конкретне значення, яким має замінитися ${APPENDIX_FILL_MARKER} саме в цьому місці, узгоджене з тим, що вже стверджується в основному тексті роботи (наприклад, якщо текст стверджує, що функціонал працює коректно — постав відповідний фактичний результат і статус "ПРОЙДЕНО"; якщо десь згадано проблему чи обмеження — врахуй це). Значення — короткі, без markdown і зайвих пояснень.
Поверни ЛИШЕ JSON-масив рядків довжиною рівно ${contexts.length}, по одному значенню на кожен пункт у тому самому порядку.`;

  try {
    const raw = await ctx.callClaude([{ role: "user", content: prompt }], ctx.signal, SYS_JSON_ARRAY, 4000, null, MODEL, { onCost: ctx.onCost });
    const values = parseJsonLoose(raw);
    if (!Array.isArray(values) || values.length !== contexts.length) {
      console.warn(`Автозаповнення додатків: очікував ${contexts.length} значень, отримав ${Array.isArray(values) ? values.length : typeof values}`);
      return { appendicesText: dateFilledText };
    }
    let i = 0;
    const filledText = dateFilledText.replace(new RegExp(APPENDIX_FILL_MARKER, "g"), () => {
      const v = stripEmDash(String(values[i] ?? "").trim());
      i++;
      return v || APPENDIX_FILL_MARKER;
    });
    return { appendicesText: filledText };
  } catch (e) {
    console.warn("Автозаповнення додатків не вдалося:", e.message);
    return { appendicesText: dateFilledText };
  }
}

// ── Виконує async-задачі з обмеженим паралелізмом (пул) — перенесено без змін.
// На відміну від браузерної версії немає stopRef (кнопка "⏹ зупинити пошук" —
// ручний UI-контроль, поза межами цієї фази) ──
async function runWithConcurrency(items, limit, worker) {
  let cursor = 0;
  const runNext = async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      await worker(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runNext));
}

// ── Тези + пошукові фрази для ОДНОГО підрозділу — адаптовано з
// regenerateThesesAndPhrases (academic-assistant.jsx), яка вже й в оригіналі
// генерує по одній секції за раз (на відміну від doGenKeywords, що пакетує
// по 8 секцій в один виклик — свідомо спрощуємо до по-секційного підходу
// regenerateThesesAndPhrases, як і зафіксовано в плані: простіше й краще
// відновлюється воркером). callGemini замість сирого fetch("/api/gemini") —
// той самий фікс, що вже зробили для api.js/sourcesSearch.js. ──
async function genThesesForSection(order, sec, ctx) {
  const info = order.info;
  const commentAnalysis = order.commentAnalysis;
  const methodInfo = order.methodInfo;
  const sourceDist = order.sourceDist || {};
  const content = order.content || {};
  const txt = content[sec.id]
    ? `\n${content[sec.id].substring(0, 1200).replace(/["\\]/g, " ").replace(/\n+/g, " ")}`
    : "";
  const domainCtx = [info?.direction, info?.subject].filter(Boolean).join(', ');
  const commentCtx = [commentAnalysis?.planHints, commentAnalysis?.writingHints].filter(Boolean).join(' ').slice(0, 400);
  const methodCtx = [methodInfo?.otherRequirements, methodInfo?.theoryRequirements, methodInfo?.analysisRequirements].filter(Boolean).join(' ').slice(0, 400);
  const secBlock = `### ${sec.label} (потрібно ${sourceDist[sec.id] || 3} джерела)${txt}`;
  const prompt = `Ти допомагаєш знайти наукові джерела для академічної роботи на тему "${info?.topic}"${domainCtx ? ` (галузь: ${domainCtx})` : ''}.

ЗАВДАННЯ — для підрозділу:

КРОК 1. Визнач 4–5 конкретних тез — повних змістовних тверджень про те, що саме доводитиметься у цьому підрозділі: який об'єкт/група/явище, в якому аспекті, в якому контексті (країна, період, галузь). Не назва розділу і не загальна категорія, а конкретне твердження (7–14 слів).
Приклад: тема "Дистанційна зайнятість в ІТ" → теза "вплив дистанційної роботи на продуктивність працівників ІТ-компаній України", а НЕ просто "дистанційна робота" чи "продуктивність праці".

КРОК 2. Для кожної тези склади 3 пошукові фрази українською:
- 2 КОНКРЕТНІ = [1–2 ключових слова з ТЕМИ роботи] + [конкретний аспект тези] — як точний прицільний пошук.
- 1 ШИРША — РІВНО ДВА ключових поняття із загального предмета тези, не більше (не три і не чотири) — без вузьких власних назв, конкретних імен чи вузькоспеціальних термінів. Що менше понять — то ширше знаходить пошук: перевірено, що фраза з двох понять "філософія та естетика романтизму" знаходить у десятки разів більше, ніж фраза з трьох понять "символізм надприродного в романтизмі" про той самий предмет. Тому: обери два НАЙЗАГАЛЬНІШІ поняття з теми й тези, відкинь решту деталізації.
Приклад: теза "вплив натурфілософії Шеллінга на образ надприродного в романтизмі" → конкретні: "Шеллінг натурфілософія романтизм", "філософія природи Шеллінг надприродне"; ширша (лише два поняття): "філософія та естетика романтизму".
ВАЖЛИВО: конкретні фрази мають містити точний предмет теми; широка фраза — той самий загальний контекст без надмірної деталізації, не втрачаючи зв'язку з темою.${commentCtx ? `\nПОБАЖАННЯ КЛІЄНТА: ${commentCtx}` : ''}${methodCtx ? `\nВИМОГИ МЕТОДИЧКИ: ${methodCtx}` : ''}

КРОК 3. Додай 3 пошукові фрази АНГЛІЙСЬКОЮ для підрозділу загалом (academic English, ширші за тезу) —
для пошуку в міжнародних англомовних базах.${localPhrasesStep(info?.language)}

ПІДРОЗДІЛ:
${secBlock}

Поверни валідний JSON: {"theses": масив об'єктів {"thesis": рядок, "phrases": масив рядків}, "enPhrases": масив з 3 англомовних фраз${localPhrasesJsonField(info?.language)}}`;

  const raw = await ctx.callGemini([{ role: "user", content: prompt }], ctx.signal, undefined, 1200, null, "gemini-2.5-flash-lite", true, { onCost: ctx.onCost });
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  const parsed = parseJsonLoose(raw);
  const theses = (Array.isArray(parsed.theses) ? parsed.theses : [])
    .map(t => ({
      thesis: String(t.thesis || '').trim(),
      phrases: (Array.isArray(t.phrases) ? t.phrases : []).map(String).filter(Boolean),
    }))
    .filter(t => t.phrases.length > 0);
  const enPhrases = (Array.isArray(parsed.enPhrases) ? parsed.enPhrases : []).map(String).filter(Boolean);
  const localPhrases = (Array.isArray(parsed.localPhrases) ? parsed.localPhrases : []).map(String).filter(Boolean);
  return { theses, enPhrases, localPhrases };
}

// ── Пошук + фільтрація + збагачення + каскад добору при нестачі — перенесено
// з doSearchSources (academic-assistant.jsx) без зміни логіки каскаду
// (непокриті тези → +2/+3/+8 років → альтернативні фрази → повна регенерація
// тез), лише без setState (повертає накопичені групи, а не пише в стан) ──
async function searchSourcesForSection(order, sec, theses, enPhrases, ctx, localPhrases = []) {
  const info = order.info;
  // Робота неукраїнською: пошук ще й мовою роботи (localPhrases) і зарубіжні кандидати впереміш
  // з українськими (phraseSearchOpts); для української — {} і поведінка як раніше.
  const searchOpts = (i, phrasesForLocal = localPhrases) => phraseSearchOpts(info?.language, phrasesForLocal, i);
  const secId = sec.id;
  const needed = (order.sourceDist || {})[secId] || 4;
  const isEconSecForSources = isEcon(info) && getEconSections(order.sections, info).includes(secId);
  const isTechnicalWork = isTechnical(info);
  const institutionalGroup = isEconSecForSources
    ? [{ phrase: "Офіційна статистика", papers: getEconInstitutionalSources() }]
    : [];
  // Офіційний сайт підприємства — у той самий підрозділ, де методичка вимагає
  // характеристику конкретного підприємства (той самий isFirstAnalysisSubsection,
  // що й enterpriseProfileBlock вище в runWritingSection), і лише якщо його
  // вдалось визначити кодом (companyWebsite.js) — з матеріалів клієнта чи пошуку.
  const firstAnalysisSecId = (order.sections || []).find(s => ["analysis", "recommendations"].includes(s.type))?.id;
  const isFirstAnalysisSubsection = !!order.methodInfo?.requiresEnterpriseProfile && firstAnalysisSecId === secId;
  const companyWebsiteGroup = (isFirstAnalysisSubsection && order.companyWebsite)
    ? [{ phrase: "Офіційний сайт підприємства", papers: [buildCompanyWebsiteSource(order.companyWebsite, extractCompanyNameFromProfile(order.econProfile))] }]
    : [];
  const globalSeen = ctx.crossSectionSeen || new Set();
  const updatedGroups = [...institutionalGroup, ...companyWebsiteGroup];

  const filterLabel = (sec.label || '').replace(/^РОЗДІЛ\s+[IVXivxІVХ\d]+[.\s:]+/i, '').trim() || sec.label;
  const topicCtx = [info?.topic, info?.direction, info?.subject].filter(Boolean).join(' ');
  const nextEnPhrase = (i) => enPhrases.length ? enPhrases[i % enPhrases.length] : '';

  const phraseTasks = [];
  for (const { thesis, phrases } of theses) {
    (phrases || []).forEach((phrase, pi) => phraseTasks.push({ thesis, phrase, pi }));
  }
  // Рання зупинка: підрозділу треба `needed` джерел; коли добрих кандидатів (score ≥ 70) уже вдвічі
  // більше, решту фраз не шукаємо — це і є основний спосіб не палити Serper/Gemini даремно.
  const _needed = (order.sourceDist || {})[sec.id] || 4;
  const _goodCount = () => updatedGroups.flatMap(g => g.papers).filter(p => (p.geminiScore ?? 0) >= 70).length;
  let _skippedPhrases = 0;
  const processPhrase = async ({ thesis, phrase, pi }) => {
    if (_goodCount() >= _needed * 2 + 2) { _skippedPhrases++; return; }
    // Scholar — основне джерело україномовних публікацій; раніше вмикався лише на першій фразі тези,
    // і коли OpenAlex вичерпував денний бюджет, решта фраз давали 1–8 кандидатів (кейс 41468: 17 джерел із 20)
    const useScholar = true;
    const candidates = await searchByPhrase(phrase, 15, 1, useScholar, 0, nextEnPhrase(pi), searchOpts(pi));
    const fresh = candidates.filter(p => {
      const key = (p.title || '').toLowerCase().slice(0, 60);
      return key && !globalSeen.has(key);
    });
    if (!fresh.length) return;
    const top15raw = await filterSourcesWithGemini(fresh.slice(0, 25), filterLabel, topicCtx, 20, thesis, ctx.onCost);
    const top15tagged = thesis ? top15raw.map(p => ({ ...p, sourceThesis: thesis })) : top15raw;
    const top15enriched = await enrichSources(top15tagged);
    const top15 = top15enriched.filter(p => {
      const key = (p.title || '').toLowerCase().slice(0, 60);
      return key && !globalSeen.has(key);
    });
    if (!top15.length) return;
    top15.forEach(p => globalSeen.add((p.title || '').toLowerCase().slice(0, 60)));
    const existingIdx = updatedGroups.findIndex(g => g.phrase === phrase);
    if (existingIdx >= 0) {
      updatedGroups[existingIdx] = { phrase, papers: [...updatedGroups[existingIdx].papers, ...top15] };
    } else {
      updatedGroups.push({ phrase, papers: top15 });
    }
  };
  await runWithConcurrency(phraseTasks, 4, processPhrase);
  if (_skippedPhrases) console.log(`[sources:${sec.label?.slice(0, 40)}] достатньо кандидатів — пропущено фраз: ${_skippedPhrases} з ${phraseTasks.length}`);

  if (updatedGroups.length || theses.length) {
    const isGood = (p, min) => (p.geminiScore ?? 0) >= min && p._complete !== false;
    const countAtScore = (min) => updatedGroups.flatMap(g => g.papers).filter(p => isGood(p, min)).length;
    const countGood = () => countAtScore(70);
    const countForThesis = (t) => updatedGroups.flatMap(g => g.papers).filter(p => p.sourceThesis === t && isGood(p, 70)).length;
    const stillShort = () => countGood() < needed;
    let triedPhrases = theses.flatMap(t => t.phrases || []);

    const backfillPhrase = async (phrase, extraYears, enPhrase = '', thesisText = '', opts = {}) => {
      const candidates = await searchByPhrase(phrase, 15, 1, true, extraYears, enPhrase, opts);
      const fresh = candidates.filter(p => {
        const key = (p.title || '').toLowerCase().slice(0, 60);
        return key && !globalSeen.has(key);
      });
      if (!fresh.length) return;
      const filteredRaw = await filterSourcesWithGemini(fresh.slice(0, 25), filterLabel, topicCtx, 20, thesisText, ctx.onCost);
      const filteredTagged = thesisText ? filteredRaw.map(p => ({ ...p, sourceThesis: thesisText })) : filteredRaw;
      const filtered = await enrichSources(filteredTagged);
      filtered.forEach(p => globalSeen.add((p.title || '').toLowerCase().slice(0, 60)));
      const existingIdx = updatedGroups.findIndex(g => g.phrase === phrase);
      if (existingIdx >= 0) {
        updatedGroups[existingIdx] = { phrase, papers: [...updatedGroups[existingIdx].papers, ...filtered] };
      } else {
        updatedGroups.push({ phrase, papers: filtered });
      }
    };

    const uncoveredTheses = theses.filter(t => t.thesis && countForThesis(t.thesis) === 0);
    for (const t of uncoveredTheses) {
      if (countForThesis(t.thesis) > 0) continue;
      for (let i = 0; i < (t.phrases || []).length; i++) {
        if (countForThesis(t.thesis) > 0) break;
        await backfillPhrase(t.phrases[i], 2, nextEnPhrase(i), t.thesis, searchOpts(i));
      }
    }

    for (const extraYears of [2, 3, 8]) {
      if (countGood() >= needed) break;
      for (let i = 0; i < triedPhrases.length; i++) {
        if (countGood() >= needed) break;
        await backfillPhrase(triedPhrases[i], extraYears, nextEnPhrase(i), '', searchOpts(i));
      }
    }

    const maxAltRounds = 3;
    for (let round = 0; round < maxAltRounds && stillShort() && triedPhrases.length; round++) {
      const altPhrases = await generateAlternatePhrases(topicCtx, filterLabel, triedPhrases, ctx.onCost);
      if (!altPhrases.length) break;
      triedPhrases = [...triedPhrases, ...altPhrases];
      for (let i = 0; i < altPhrases.length; i++) {
        if (!stillShort()) break;
        await backfillPhrase(altPhrases[i], 3, nextEnPhrase(i), '', searchOpts(i));
      }
    }

    // Остання автоматична спроба — повна регенерація тез підрозділу (та сама
    // функція, що й для першого проходу — виправдана спрощена версія: жодна
    // з двох генерацій не залежить від попереднього результату).
    if (stillShort()) {
      try {
        const { theses: regenTheses, enPhrases: regenEnPhrases, localPhrases: regenLocalPhrases } = await genThesesForSection(order, sec, ctx);
        const regenPhrases = regenTheses.flatMap(t => t.phrases || []);
        const nextRegenEnPhrase = (i) => regenEnPhrases.length ? regenEnPhrases[i % regenEnPhrases.length] : '';
        for (let i = 0; i < regenPhrases.length; i++) {
          if (!stillShort()) break;
          await backfillPhrase(regenPhrases[i], 3, nextRegenEnPhrase(i), '', searchOpts(i, regenLocalPhrases));
        }
      } catch (e) {
        console.error('Auto thesis regeneration error:', e.message);
      }
    }
  }

  return { groups: updatedGroups, seenKeys: globalSeen };
}

// ── Автовибір знайдених джерел для вставки — перенесено з auto-insert
// useEffect у SourcesStage.jsx (autoInsertedRef) без зміни логіки: лише
// підтверджені (score≥70 і гейт повноти, або інституційні), розподіл по колу
// за тезою (не просто топ-N за оцінкою — щоб покриття тем було рівномірним),
// з мовною квотою (sourceLangQuota: для української роботи — на зарубіжні, для роботи
// іншою мовою — на українські). Використовується і воркером, і браузером (SourcesStage.jsx). ──
export function autoSelectSources(groups, needed, isTechnicalWork, lang = "Українська") {
  const suggestions = groups.flatMap(g => g.papers);
  const { foreignWork, maxForeign, maxUk } = sourceLangQuota(lang, isTechnicalWork, needed);
  const confirmed = suggestions.filter(p =>
    p.source === 'institutional' || ((p.geminiScore ?? 0) >= 70 && p._complete !== false)
  );
  const grouped = {};
  for (const p of confirmed) {
    const key = p.sourceThesis || '';
    (grouped[key] ||= []).push(p);
  }
  // той самий порядок, що в SourcesStage.jsx: оцінка, а за рівної — джерело зі сторінками
  Object.values(grouped).forEach(arr => arr.sort(compareForAutoInsert));
  const thesisKeys = Object.keys(grouped);
  const nextIdx = Object.fromEntries(thesisKeys.map(k => [k, 0]));
  const top = [];
  let foreignCount = 0;
  let ukCount = 0;
  let progress = true;
  while (top.length < needed && progress) {
    progress = false;
    for (const key of thesisKeys) {
      if (top.length >= needed) break;
      const arr = grouped[key];
      while (nextIdx[key] < arr.length) {
        const cand = arr[nextIdx[key]];
        nextIdx[key]++;
        const isForeign = cand.lang !== 'uk';
        if (isForeign && foreignCount >= maxForeign) continue;
        if (!isForeign && ukCount >= maxUk) continue;
        top.push(cand);
        if (isForeign) foreignCount++; else ukCount++;
        progress = true;
        break;
      }
    }
  }
  // Робота іншою мовою: якщо зарубіжних підтверджених не вистачило — добираємо пропущеними через
  // квоту українськими (частка — бажана, а не причина лишити підрозділ без джерел)
  if (foreignWork && top.length < needed) {
    const taken = new Set(top);
    const rest = confirmed.filter(p => !taken.has(p)).sort(compareForAutoInsert);
    top.push(...rest.slice(0, needed - top.length));
  }
  return top;
}

// ── Вставка обраних джерел у citInputs/citStructured/abstractsMap/
// sourceThesisMap — перенесено з insertSources (SourcesStage.jsx), без
// браузерного авторозтягування textarea (DOM, тут не потрібне) ──
export async function insertSourcesIntoOrder(order, secId, papersToAdd, { capForeign = true } = {}) {
  const unchanged = { citInputs: order.citInputs || {}, citStructured: order.citStructured || {}, abstractsMap: order.abstractsMap || {}, sourceThesisMap: order.sourceThesisMap || {} };
  if (!papersToAdd.length) return unchanged;

  const enriched = await enrichSources(papersToAdd);

  const needed = (order.sourceDist || {})[secId] || 4;
  const { foreignWork, maxForeign } = sourceLangQuota(order.info?.language, isTechnical(order.info), needed);
  const ukPapers = enriched.filter(p => p.lang === 'uk');
  const enPapers = capForeign
    ? enriched.filter(p => p.lang !== 'uk').slice(0, maxForeign)
    : enriched.filter(p => p.lang !== 'uk');
  // Робота іншою мовою — зарубіжні першими (частку вже збалансовано в autoSelectSources)
  const papers = foreignWork ? [...enPapers, ...ukPapers] : [...ukPapers, ...enPapers];

  const newLines = papers.map(paperToCitation).filter(Boolean);
  if (!newLines.length) return unchanged;

  let abstractsMap = order.abstractsMap || {};
  papers.forEach((p, i) => {
    if (p.abstract && newLines[i]) abstractsMap = { ...abstractsMap, [newLines[i]]: p.abstract };
  });

  let sourceThesisMap = order.sourceThesisMap || {};
  papers.forEach((p, i) => {
    if (p.sourceThesis && newLines[i]) sourceThesisMap = { ...sourceThesisMap, [newLines[i]]: p.sourceThesis };
  });

  const cur = (order.citInputs?.[secId] || '').trimEnd();
  // Звіряємо не лише проти цього підрозділу, а проти джерел УСІХ підрозділів —
  // те саме джерело могло вже потрапити в citInputs іншої секції з іншим
  // форматуванням тексту (порядок авторів, наявність venue/сторінок), тож
  // порівнюємо за тим самим ключем (DOI → URL → нормалізований текст), що й
  // фінальний дедуп у runRemapStage, а не за побуквеним збігом рядка.
  const existingKeys = new Set(
    Object.values(order.citInputs || {})
      .flatMap(text => (text || '').split('\n'))
      .filter(Boolean)
      .map(computeDedupKey)
  );
  const uniqueNewLines = newLines.filter(l => !existingKeys.has(computeDedupKey(l)));
  const citInputs = uniqueNewLines.length
    ? { ...(order.citInputs || {}), [secId]: cur + (cur ? '\n' : '') + uniqueNewLines.join('\n') }
    : (order.citInputs || {});

  const citStructured = {
    ...(order.citStructured || {}),
    [secId]: [...((order.citStructured || {})[secId] || []), ...papers],
  };

  return { citInputs, citStructured, abstractsMap, sourceThesisMap };
}

// Рядок — лише внутрішньотекстове посилання ([N с.X], [N; M], "С. 14–15"), без жодного
// опису джерела: після вилучення дужок, сторінок, цифр і розділових знаків не лишається слів.
export function isCitationMarkerOnly(line) {
  const rest = String(line || "")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/(?:с|c|s|p|pp|стор|стр)\.\s*[\d–—-]+/gi, " ")
    .replace(/[\d\s.,;:–—\-()[\]]/g, "");
  return rest.length < 3;
}

async function defaultEnrichClientSourceLine(line) {
  return enrichFullSourceInfo(await enrichManualLine(line));
}

/**
 * Розподіляє джерела, надані клієнтом (order.clientMaterialsSummary.rawText —
 * текст з client_materials), по підрозділах плану: один ШІ-виклик відділяє
 * реальні джерела від іншого контенту матеріалів і для кожного визначає
 * найбільш підходящий підрозділ разом із коротким "чому" (snippet) — тим
 * самим, що для автопошукових джерел зазвичай дає анотація пошукового API.
 * Знайдені рядки форматуються так само, як ручна вставка в SourcesStage.jsx
 * (enrichManualLine/enrichFullSourceInfo), і довставляються в citInputs —
 * тому далі по конвеєру (написання, фінальний список джерел) вони нічим не
 * відрізняються від джерел, знайдених автопошуком чи вставлених вручну.
 *
 * Одноразовий крок: викликач має сам пропускати повторний виклик, коли
 * order.clientSourcesDistributed вже true (як і з іншими one-shot кроками).
 *
 * @param {object} order - info, sections, clientMaterialsSummary, citInputs, abstractsMap
 * @param {object} ctx - { callClaude, onCost?, enrichLine? } — enrichLine
 *   (line: string) => Promise<string> перевизначає форматування рядка,
 *   лише для тестів (за замовчуванням — реальний enrichManualLine+enrichFullSourceInfo)
 * @returns {Promise<{citInputs, abstractsMap, clientSourcesLog}>}
 */
export async function runClientSourcesDistributionStage(order, ctx) {
  const unchanged = { citInputs: order.citInputs || {}, abstractsMap: order.abstractsMap || {}, clientSourcesLog: order.clientSourcesLog || [] };
  const materialsText = order.clientMaterialsSummary?.rawText?.trim();
  if (!materialsText) return unchanged;

  const mainSecs = (order.sections || []).filter(s => !["intro", "conclusions", "sources", "chapter_conclusion"].includes(s.type) && !s.headingOnly);
  if (!mainSecs.length) return unchanged;

  const d = order.info;
  let items;
  try {
    const raw = await ctx.callClaude(
      [{ role: "user", content: buildClientSourcesDistributionPrompt({ topic: d?.topic, materialsText: materialsText.slice(0, 50000), planSections: mainSecs, lang: d?.language }) }],
      // 4000 токенів не вистачало вже на ~40 джерел (raw + snippet на кожне) → відповідь
      // обрізалась, JSON не розбирався, і крок мовчки нічого не додавав
      null, SYS_JSON_ARRAY, 16000, null, MODEL_FAST, { onCost: ctx.onCost },
    );
    items = parseJsonLoose(raw);
  } catch (e) {
    console.warn("runClientSourcesDistributionStage:", e.message);
    return unchanged;
  }
  if (!Array.isArray(items) || !items.length) return unchanged;

  const validSecIds = new Set(mainSecs.map(s => s.id));
  const enrichLine = ctx.enrichLine || defaultEnrichClientSourceLine;
  const log = [];
  let citInputs = order.citInputs || {};
  let abstractsMap = order.abstractsMap || {};
  const existingKeys = new Set(
    Object.values(citInputs).flatMap(text => (text || "").split("\n")).filter(Boolean).map(computeDedupKey)
  );

  for (const item of items) {
    const rawLine = (item?.raw || "").trim();
    if (!rawLine) continue;
    if (isCitationMarkerOnly(rawLine)) {
      // "[12 с.312]", "[14 с.39; 15 с.214]. С. 14–15." — посилання з тексту (напр. готової
      // частини серед матеріалів), а не бібліографічний запис; у список джерел не беремо (кейс 41476)
      log.push({ raw: rawLine, sectionId: null, reason: "посилання з тексту, а не джерело" });
      continue;
    }
    // модель інколи повертає id числом (1.1 без лапок) або разом із назвою ("1.1 Теоретичні…") —
    // тоді жодне джерело клієнта не потрапляло в роботу (кейс 41468: «розподілено 0 з 32»)
    const sidRaw = item?.sectionId == null ? "" : String(item.sectionId).trim();
    const sidNum = sidRaw.match(/^\d+(?:\.\d+)*/)?.[0] || "";
    let secId = validSecIds.has(sidRaw) ? sidRaw : (validSecIds.has(sidNum) ? sidNum : null);
    let fallback = false;
    if (!secId) {
      // джерело надав сам клієнт — воно має бути в роботі; кладемо в найменш заповнений підрозділ
      secId = mainSecs.map(s => s.id).sort((a, b) =>
        (citInputs[a] || "").split("\n").filter(Boolean).length - (citInputs[b] || "").split("\n").filter(Boolean).length)[0];
      fallback = true;
    }

    let enriched;
    try {
      enriched = (await enrichLine(rawLine)).trim() || rawLine;
    } catch (e) {
      console.warn("runClientSourcesDistributionStage enrichLine:", e.message);
      enriched = rawLine;
    }

    const key = computeDedupKey(enriched);
    if (existingKeys.has(key)) { log.push({ raw: rawLine, sectionId: secId, reason: "дублікат наявного джерела" }); continue; }
    existingKeys.add(key);

    const cur = (citInputs[secId] || "").trimEnd();
    citInputs = { ...citInputs, [secId]: cur + (cur ? "\n" : "") + enriched };
    if (item.snippet) abstractsMap = { ...abstractsMap, [enriched]: item.snippet };
    log.push(fallback ? { raw: rawLine, sectionId: secId, reason: "підрозділ не визначено — додано в найменш заповнений" } : { raw: rawLine, sectionId: secId });
  }

  return { citInputs, abstractsMap, clientSourcesLog: log };
}

/**
 * Підбирає й довставляє джерела для ОДНОГО підрозділу: генерує тези й пошукові
 * фрази (спрощено — по одній секції, не пакетами по 8, як в оригінальному
 * doGenKeywords), шукає з каскадом добору при нестачі (doSearchSources), і
 * автоматично вставляє підтверджені джерела в citInputs (авто-вставка з
 * SourcesStage.jsx — раніше єдине місце, куди воркер не мав доступу взагалі).
 *
 * Природний чекпойнт: якщо order.citInputs[sec.id] вже непорожній, викликач
 * має просто пропустити цю секцію — та сама ознака "секція готова", яку й
 * досі використовує авто-вставка в браузері ("вже є джерела — не втручаємось").
 *
 * @param {object} order - info, sections, sourceDist, citInputs, citStructured,
 *   abstractsMap, sourceThesisMap, content, commentAnalysis, methodInfo
 * @param {object} sec - підрозділ зі order.sections
 * @param {object} ctx - { callGemini, signal?, onCost?, crossSectionSeen? } —
 *   crossSectionSeen (Set) можна передати спільним для всіх секцій одного
 *   замовлення, щоб те саме джерело не потрапило у два підрозділи (як
 *   doGenKeywords робить у браузері); якщо не передати — ізольовано на секцію.
 * @returns {Promise<{citInputs, citStructured, abstractsMap, sourceThesisMap}>}
 */
export async function runSourcesStage(order, sec, ctx) {
  const secId = sec.id;
  const { theses, enPhrases, localPhrases } = await genThesesForSection(order, sec, ctx);

  const isEconSecForSources = isEcon(order.info) && getEconSections(order.sections, order.info).includes(secId);
  if (!theses.length && !isEconSecForSources) {
    return { citInputs: order.citInputs || {}, citStructured: order.citStructured || {}, abstractsMap: order.abstractsMap || {}, sourceThesisMap: order.sourceThesisMap || {} };
  }

  const { groups } = await searchSourcesForSection(order, sec, theses, enPhrases, ctx, localPhrases);
  const needed = (order.sourceDist || {})[secId] || 4;
  const top = autoSelectSources(groups, needed, isTechnical(order.info), order.info?.language);
  return await insertSourcesIntoOrder(order, secId, top, { capForeign: true });
}
