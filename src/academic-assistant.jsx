import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { db } from "./firebase";
import { useAuth } from "./AuthContext";
import {
  doc, getDoc, setDoc, updateDoc, serverTimestamp,
} from "firebase/firestore";

import { exportPlanToDocx, exportAppendixToDocx, exportSpeechToDocx, renumberTablesAndFigures } from "./lib/exportDocx.js";
import { exportToPptxFile } from "./lib/exportPptx.js";
import { extractPdfPageImages } from "./lib/pdfImages.js";
import { callClaude, callGemini, MODEL, MODEL_FAST, resetGenerationCost, getProxyAuthHeaders } from "./lib/api.js";
import { playDoneSound } from "./lib/audio.js";
import { stripEmDash } from "./lib/wordCount.js";
import { buildSYS, SYS_JSON, SYS_JSON_SHORT, SYS_JSON_ARRAY, STRUCTURE_READING_PROMPT, buildClientMaterialsAnalysisPrompt, buildExtractStructurePrompt, buildAnnotationRegenPrompt, buildAntiPlagiarismSYS, buildAntiDetectionSYS, buildClientPlanEditsPrompt, getStyleProfileForSection, localPhrasesStep, localPhrasesJsonField, localPhrasesJsonFieldBatch } from "./lib/prompts.js";
import { FIELD_LABELS, isEcon, isTechnical, getEmpiricalSections, getEconSections, getTechnicalSections, CODE_FILE_EXTENSIONS, STAGES_SOURCES_FIRST, STAGE_KEYS_SOURCES_FIRST, ORDER_STATUS, parsePagesAvg, buildPlanText, buildPreviewStructure, calcSourceDist, buildWorkConfig, getLangLabels, insertBeforeTail, scanFigures, renumberSections, rebuildWithChapterConclusions, applyPlanEditOps, describePlanEditOp, mergeIntroComponents, localSourceLangCode, chapterHeadingPrefix, normLangName } from "./lib/planUtils.js";
import { serializeForFirestore } from "./lib/firestoreUtils.js";
import { normalizeWorkType } from "./lib/academicDefaults.js";
import { searchByPhrase, phraseSearchOpts, filterSourcesWithGemini, getEconInstitutionalSources, generateAlternatePhrases, enrichSources } from "./lib/sourcesSearch.js";
import { buildCompanyWebsiteSource, extractCompanyNameFromProfile } from "./lib/companyWebsite.js";
import { createReferenceDeduper, detectSourceGrouping, capCitationRepeats, isLawSource } from "./lib/citationFormatting.js";
import { fixDanglingFigures, dedupeRepeatedFigures } from "./lib/figureFixup.js";
import { findPlaceholderFigures, buildWebImageSlides, resolveSlideWebImages } from "./lib/webImages.js";
import { useWebImages } from "./lib/useWebImages.js";
import { useLangProfile } from "./lib/useLangProfile.js";
import { fixMixedScript, typographQuotes, stripStrayCJK, getIntroTasksProfile, INTRO_TASKS_MERGE_SPLIT_RULE, APPENDIX_FILL_MARKER, APPENDIX_FILL_MARKER_RULE, CODE_GROUNDING_RULE } from "./lib/textCleanup.js";
import { runWritingSection, runPlanStage, runAnalyzeStage, runRemapStage, runAppendicesStage, runFillAppendixDataStage, runEconProfileStage, sectionNeedsAppendix, planAppendixGeneration } from "./lib/orderStages.js";
import { SpinDot, Shimmer } from "./components/SpinDot.jsx";
import { StagePills } from "./components/StagePills.jsx";
import { FieldBox, Heading, NavBtn, PrimaryBtn, GreenBtn, SaveIndicator } from "./components/Buttons.jsx";
import { StructurePreview } from "./components/StructurePreview.jsx";
import { PlanLoadingSkeleton } from "./components/PlanLoadingSkeleton.jsx";
import { DropZone } from "./components/DropZone.jsx";
import { PhotoDropZone } from "./components/PhotoDropZone.jsx";
import { ClientPlanInput } from "./components/ClientPlanInput.jsx";
import { ClientMaterialsZone } from "./components/ClientMaterialsZone.jsx";
import { extractDocxReadyPart } from "./lib/readyPartDocx.js";
import { InputStage } from "./components/stages/InputStage.jsx";
import { ParsedStage } from "./components/stages/ParsedStage.jsx";
import { PlanStage } from "./components/stages/PlanStage.jsx";
import { WritingStage } from "./components/stages/WritingStage.jsx";
import { SourcesStage } from "./components/stages/SourcesStage.jsx";
import { DoneStage } from "./components/stages/DoneStage.jsx";
import { ChecklistStage } from "./components/stages/ChecklistStage.jsx";

const AUTO_STEPS = { analyze: "Аналіз шаблону", plan: "Генерація плану", sources: "Підбір джерел", writing: "Написання тексту" };

export default function AcademAssist({ orderId, onOrderCreated, onBack }) {
  const { user, profile } = useAuth();
  const isAdmin = profile?.role === "admin";

  const [scrolled, setScrolled] = useState(false);
  const [headerOpen, setHeaderOpen] = useState(true);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [stage, setStage] = useState("input");
  const [maxStageIdx, setMaxStageIdx] = useState(0);
  const [tplText, setTplText] = useState("");
  const [comment, setComment] = useState("");
  const [clientPlan, setClientPlan] = useState("");
  const [fileLabel, setFileLabel] = useState("");
  const [fileB64, setFileB64] = useState(null);
  const [fileType, setFileType] = useState(null);
  const [exampleWorkFileName, setExampleWorkFileName] = useState(""); // приклад роботи — зразок структури й оформлення (PDF)
  const [exampleWorkFileB64, setExampleWorkFileB64] = useState(null);
  const [exampleWorkFileType, setExampleWorkFileType] = useState(null);
  const [methodInfo, setMethodInfo] = useState(null); // структурна інфо з методички
  const [commentAnalysis, setCommentAnalysis] = useState(null); // {planHints, writingHints}
  const [photos, setPhotos] = useState([]); // [{name, b64, type}] — додаткові фото
  const [illustrations, setIllustrations] = useState([]); // [{name, b64, type, caption, targetSection}]
  const [illustrationsPdf, setIllustrationsPdf] = useState(null); // {name, b64} — PDF із ілюстраціями
  const [illustrationDescs, setIllustrationDescs] = useState([]); // [{figureNum, description, caption, suggestedSection}]
  const [clientDrawings, setClientDrawings] = useState([]); // [{name, b64, type}] — реальні креслення клієнта (лише в Додатки, не в текст)
  const [clientMaterials, setClientMaterials] = useState([]); // [{name, text}] — файли клієнта
  const [clientMaterialsText, setClientMaterialsText] = useState(""); // ручний ввід
  const [clientMaterialsSummary, setClientMaterialsSummary] = useState(null); // {rawText, keyFacts, tablesMd, sectionHints}
  const [readyWorkFileName, setReadyWorkFileName] = useState(""); // готова частина роботи від клієнта (.docx)
  const [readyWorkText, setReadyWorkText] = useState(""); // сирий текст, розібраний по розділах після генерації плану
  const [readyWorkImages, setReadyWorkImages] = useState([]); // рисунки готової частини (воркер CRM) — для маркерів [ГОТОВА-ЧАСТИНА-РИСУНОК:N]
  const [readyWorkImportedIds, setReadyWorkImportedIds] = useState([]); // id розділів, заповнених з файлу клієнта
  const [readyWorkNeedsManualAI, setReadyWorkNeedsManualAI] = useState(false); // код не розпізнав заголовки — пропонуємо кнопку аналізу через ШІ
  const [info, setInfo] = useState(null);
  const [sections, setSections] = useState([]);
  const [planDisplay, setPlanDisplay] = useState("");
  const [content, setContent] = useState({});
  // Ключові авторські терміни/назви методик з кожного вже згенерованого підрозділу основної
  // частини — окремий від content канал, бо при стисненні контексту для великих робіт
  // (isLargeWork у buildMessages) чужі розділи підставляються лише "першим абзацом", і
  // терміни, введені глибше в тексті, губляться. Висновки завжди отримують повний глосарій,
  // незалежно від стиснення — це і не дає їм "вигадувати" власну термінологію.
  const [glossary, setGlossary] = useState({});
  const [genIdx, setGenIdx] = useState(0);
  const [running, setRunning] = useState(false);
  const runningRef = useRef(false);
  const [planLoading, setPlanLoading] = useState(false);
  const [loadMsg, setLoadMsg] = useState("");
  const [paused, setPaused] = useState(false);
  const [sourceDist, setSourceDist] = useState({});
  const [sourceTotal, setSourceTotal] = useState(0);
  const [keywords, setKeywords] = useState({});
  const [searchAnchors, setSearchAnchors] = useState({});
  const [enKeywords, setEnKeywords] = useState({});
  // Пошукові фрази мовою роботи (для неукраїнської й неанглійської роботи) — поряд з enKeywords
  const [localKeywords, setLocalKeywords] = useState({});
  const [kwLoading, setKwLoading] = useState(false);
  const [kwError, setKwError] = useState("");
  const stopSearchRef = useRef(false);
  const [citInputs, setCitInputs] = useState({});
  const [docxLoading, setDocxLoading] = useState(false);
  const [planDocxLoading, setPlanDocxLoading] = useState(false);
  const [showManualPlanInput, setShowManualPlanInput] = useState(false);
  const [manualPlanText, setManualPlanText] = useState("");
  const [showClientEditsInput, setShowClientEditsInput] = useState(false);
  const [clientEditsText, setClientEditsText] = useState("");
  const [clientEditsLoading, setClientEditsLoading] = useState(false);
  const [clientEditsOps, setClientEditsOps] = useState(null); // null = ще не проаналізовано; [] = проаналізовано, нічого не знайдено
  const [clientEditsChecked, setClientEditsChecked] = useState({});
  const [clientEditsError, setClientEditsError] = useState("");
  const [namingLoading, setNamingLoading] = useState(false);
  const [singleNamingId, setSingleNamingId] = useState(null);
  const [allCitLoading, setAllCitLoading] = useState(false);
  const [refList, setRefList] = useState([]);
  const [citInputsSnapshot, setCitInputsSnapshot] = useState(null);
  const [citStructured, setCitStructured] = useState({});
  const [figureRefs, setFigureRefs] = useState({});
  const [figureKeywords, setFigureKeywords] = useState([]);
  const [figKwLoading, setFigKwLoading] = useState(false);
  const [figPanelOpen, setFigPanelOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [dbLoading, setDbLoading] = useState(false);
  const [remapLoading, setRemapLoading] = useState(false);
  const [citStyleOverride, setCitStyleOverride] = useState(null);       // "ДСТУ 8302:2015" | "APA" | "MLA" | null
  const [sourcesOrderOverride, setSourcesOrderOverride] = useState(null); // "alphabetical" | "appearance" | null
  const [citFootnotes, setCitFootnotes] = useState(false);               // true → ДСТУ-посилання у виносках
  const [pageByContent, setPageByContent] = useState(false);             // true → сторінка в посиланні за змістом PDF джерела
  // For regenerating a single section
  const [regenId, setRegenId] = useState(null);
  const [regenPrompt, setRegenPrompt] = useState("");
  const [regenLoading, setRegenLoading] = useState(false);
  const [regenAllLoading, setRegenAllLoading] = useState(false);
  const regenAllAbortRef = useRef(null);
  // For reducing plagiarism (paraphrase existing text, not regenerate from scratch)
  const [plagId, setPlagId] = useState(null);
  const [plagLoading, setPlagLoading] = useState(false);
  const [plagAllLoading, setPlagAllLoading] = useState(false);
  const [plagAllMsg, setPlagAllMsg] = useState("");
  const plagAllAbortRef = useRef(null);
  const [aiDetectAllLoading, setAiDetectAllLoading] = useState(false);
  const [aiDetectAllMsg, setAiDetectAllMsg] = useState("");
  const aiDetectAllAbortRef = useRef(null);
  const writingDoneRef = useRef(false);
  const autoRemapDoneRef = useRef(false);
  const appendixFillDoneRef = useRef(false);
  const appendixDeferredRef = useRef(false);
  const appendixDeferredGenDoneRef = useRef(false);
  const maxStageIdxRef = useRef(0);
  const generationStartRef = useRef(null);
  const [apiError, setApiError] = useState("");
  const [speechText, setSpeechText] = useState("");
  const [speechLoading, setSpeechLoading] = useState(false);
  const [slideJson, setSlideJson] = useState(null);
  const [presentationLoading, setPresentationLoading] = useState(false);
  const [presentationMsg, setPresentationMsg] = useState("");
  const [presentationReady, setPresentationReady] = useState(false);
  const [appendicesText, setAppendicesText] = useState("");
  const [appendicesLoading, setAppendicesLoading] = useState(false);
  const [appendicesCustomPrompt, setAppendicesCustomPrompt] = useState("");
  const [econProfile, setEconProfile] = useState("");
  const [econProfileLoading, setEconProfileLoading] = useState(false);
  const [companyWebsite, setCompanyWebsite] = useState("");
  const [annotationUk, setAnnotationUk] = useState("");
  const [annotationEn, setAnnotationEn] = useState("");
  const [annotationLoading, setAnnotationLoading] = useState(false);
  const [titlePage, setTitlePage] = useState("");
  const [titlePageLines, setTitlePageLines] = useState(null);
  const [showMissingSources, setShowMissingSources] = useState(false);
  const [suggestedSources, setSuggestedSources] = useState({});
  const [sourcesSearchLoading, setSourcesSearchLoading] = useState({});
  const [sourcesSearchError, setSourcesSearchError] = useState({});
  const [abstractsMap, setAbstractsMap] = useState({}); // { citationString: abstractSnippet }
  const [sourceThesisMap, setSourceThesisMap] = useState({}); // { citationString: theza, під яку джерело шукалось }
  const [searchPageCount, setSearchPageCount] = useState({}); // лічильник натискань "оновити" на секцію
  const [seenSourceKeys, setSeenSourceKeys] = useState({}); // заголовки вже показаних джерел — не показувати повторно
  const [phraseGroups, setPhraseGroups] = useState({}); // { secId: [{phrase, papers}] }
  const tokenAccRef = useRef({ inTok: 0, outTok: 0, costUsd: 0, claudeInTok: 0, claudeOutTok: 0, claudeCostUsd: 0, geminiInTok: 0, geminiOutTok: 0, geminiCostUsd: 0, serperCredits: 0, serperCostUsd: 0 });
  useEffect(() => {
    const handler = (e) => {
      const isGemini = e.detail.model?.startsWith("gemini");
      const isSerper = e.detail.model === "serper";
      const inTok = e.detail.inTok || 0;
      const outTok = e.detail.outTok || 0;
      const cost = e.detail.cost || 0;
      tokenAccRef.current = {
        inTok: tokenAccRef.current.inTok + (isSerper ? 0 : inTok),
        outTok: tokenAccRef.current.outTok + (isSerper ? 0 : outTok),
        costUsd: tokenAccRef.current.costUsd + cost,
        claudeInTok: tokenAccRef.current.claudeInTok + (!isGemini && !isSerper ? inTok : 0),
        claudeOutTok: tokenAccRef.current.claudeOutTok + (!isGemini && !isSerper ? outTok : 0),
        claudeCostUsd: tokenAccRef.current.claudeCostUsd + (!isGemini && !isSerper ? cost : 0),
        geminiInTok: tokenAccRef.current.geminiInTok + (isGemini ? inTok : 0),
        geminiOutTok: tokenAccRef.current.geminiOutTok + (isGemini ? outTok : 0),
        geminiCostUsd: tokenAccRef.current.geminiCostUsd + (isGemini ? cost : 0),
        serperCredits: tokenAccRef.current.serperCredits + (isSerper ? inTok : 0),
        serperCostUsd: tokenAccRef.current.serperCostUsd + (isSerper ? cost : 0),
      };
    };
    window.addEventListener("apicost", handler);
    return () => window.removeEventListener("apicost", handler);
  }, []);

  // Зберігаємо актуальний id документа (може змінитись після першого збереження)
  const currentIdRef = useRef(orderId || null);
  // Фото з інтернету для рисунків-заглушок (src/lib/webImages.js) — зберігаються в orders/{id}/webImages
  const webImg = useWebImages({ getOrderId: () => currentIdRef.current, saveOrderPatch: (patch) => saveToFirestore(patch) });
  const loadWebImages = webImg.load;
  // true, якщо створення документа в Firestore вже підтверджено успішним збереженням
  const createdConfirmedRef = useRef(!!orderId);
  const abortRef = useRef(null);
  const remapAbortRef = useRef(null);
  const contentRef = useRef(content);
  const glossaryRef = useRef(glossary);
  const savedTimerRef = useRef(null);
  useEffect(() => { contentRef.current = content; }, [content]);
  useEffect(() => { glossaryRef.current = glossary; }, [glossary]);
  useEffect(() => {
    const onScroll = () => {
      const y = window.scrollY;
      setScrolled(y > 300);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    return () => clearTimeout(savedTimerRef.current);
  }, []);

  // ── Завантаження існуючого замовлення з Firestore ──
  useEffect(() => {
    if (!orderId || !user) return;
    const load = async () => {
      setDbLoading(true);
      try {
        const snap = await getDoc(doc(db, "orders", orderId));
        if (snap.exists()) {
          const d = snap.data();
          // якщо документ існує але без createdAt (збій першого save) — наступний save його додасть
          if (!d.createdAt) createdConfirmedRef.current = false;
          if (d.tplText) setTplText(d.tplText);
          if (d.comment) setComment(d.comment);
          if (d.clientPlan) setClientPlan(d.clientPlan);
          if (d.info) setInfo(d.info);
          if (d.sections?.length) {
            setSections(d.sections);
            setPlanDisplay(buildPlanText(d.sections));
            // готові підрозділи клієнта мають джерела з документа — розподіл лише для дописуваних
            const imported = new Set(d.readyWorkImportedIds || []);
            const { dist, total } = calcSourceDist(d.sections.filter(s => !imported.has(s.id)), parsePagesAvg(d.info?.pages));
            setSourceDist(dist); setSourceTotal(total);
          }
          if (d.methodInfo) setMethodInfo(d.methodInfo);
          if (d.fileLabel) setFileLabel(d.fileLabel);
          if (d.exampleWorkFileName) setExampleWorkFileName(d.exampleWorkFileName);
          if (d.commentAnalysis) {
            const ca = d.commentAnalysis;
            if (Array.isArray(ca.sourcesHints)) ca.sourcesHints = ca.sourcesHints.join('; ');
            if (Array.isArray(ca.planHints)) ca.planHints = ca.planHints.join('; ');
            if (Array.isArray(ca.textStructureHints)) ca.textStructureHints = ca.textStructureHints.join('; ');
            if (Array.isArray(ca.writingHints)) ca.writingHints = ca.writingHints.join('; ');
            setCommentAnalysis(ca);
          }
          if (d.illustrations?.length) setIllustrations(d.illustrations);
          if (d.illustrationDescs?.length) setIllustrationDescs(d.illustrationDescs);
          if (d.clientDrawings?.length) setClientDrawings(d.clientDrawings);
          if (d.clientMaterialsSummary) setClientMaterialsSummary(d.clientMaterialsSummary);
          if (d.clientMaterialsText) setClientMaterialsText(d.clientMaterialsText);
          if (d.readyWorkFileName) setReadyWorkFileName(d.readyWorkFileName);
          if (d.readyWorkText) setReadyWorkText(d.readyWorkText);
          setReadyWorkImages(d.readyWorkImages || []);
          loadWebImages(orderId, d.webImagesDone);
          if (d.readyWorkImportedIds) setReadyWorkImportedIds(d.readyWorkImportedIds);
          if (d.content) setContent(d.content);
          if (d.citInputs) setCitInputs(d.citInputs);
          if (d.citStructured) setCitStructured(d.citStructured);
          if (d.abstractsMap) setAbstractsMap(d.abstractsMap);
          if (d.sourceThesisMap) setSourceThesisMap(d.sourceThesisMap);
          if (d.refList) setRefList(d.refList);
          if (d.suggestedSources) {
            setSuggestedSources(d.suggestedSources);
            const seen = {};
            Object.entries(d.suggestedSources).forEach(([secId, papers]) => {
              seen[secId] = new Set((papers || []).map(p => (p.title || '').toLowerCase().slice(0, 60)));
            });
            setSeenSourceKeys(seen);
          }
          if (d.phraseGroups) setPhraseGroups(d.phraseGroups);
          if (d.keywords) setKeywords(d.keywords);
          if (d.searchAnchors) setSearchAnchors(d.searchAnchors);
          if (d.enKeywords) setEnKeywords(d.enKeywords);
          if (d.localKeywords) setLocalKeywords(d.localKeywords);
          if (d.speechText) setSpeechText(d.speechText);
          if (d.appendicesText) setAppendicesText(d.appendicesText.replace(/\n{2,}/g, '\n'));
          if (d.econProfile) setEconProfile(d.econProfile);
          if (d.companyWebsite) setCompanyWebsite(d.companyWebsite);
          if (d.annotationUk) setAnnotationUk(d.annotationUk);
          if (d.annotationEn) setAnnotationEn(d.annotationEn);
          if (d.titlePage) setTitlePage(d.titlePage);
          if (d.titlePageLines) setTitlePageLines(d.titlePageLines);
          if (d.slideJson) setSlideJson(d.slideJson);
          if (d.presentationReady) setPresentationReady(true);
          if (d.citStyleOverride) setCitStyleOverride(d.citStyleOverride);
          if (d.sourcesOrderOverride) setSourcesOrderOverride(d.sourcesOrderOverride);
          if (d.citFootnotes !== undefined) setCitFootnotes(d.citFootnotes);
          if (d.pageByContent !== undefined) setPageByContent(!!d.pageByContent);
          if (d.stage) {
            const keys = STAGE_KEYS_SOURCES_FIRST;
            const stageIdx = keys.indexOf(d.stage);
            setStage(d.stage);
            // Якщо написання вже завершено — позначаємо і розблоковуємо всі стадії
            const writingIdx = keys.indexOf("writing");
            const writingIsDone = stageIdx > writingIdx
              || d.status === "done"
              || (d.maxStageIdx !== undefined && d.maxStageIdx >= keys.length - 1)
              || (d.genIdx !== undefined && (d.sections?.length ?? 0) > 0 && d.genIdx >= d.sections.length);
            if (writingIsDone) {
              writingDoneRef.current = true;
              setMaxStageIdx(keys.length - 1);
            } else {
              const savedMax = d.maxStageIdx !== undefined ? d.maxStageIdx : stageIdx;
              setMaxStageIdx(Math.max(0, savedMax));
            }
          }
          if (d.genIdx !== undefined) setGenIdx(d.genIdx);
          if (d.totalInTok !== undefined) {
            tokenAccRef.current = {
              inTok: d.totalInTok || 0, outTok: d.totalOutTok || 0, costUsd: d.totalCostUsd || 0,
              claudeInTok: d.claudeInTok || 0, claudeOutTok: d.claudeOutTok || 0, claudeCostUsd: d.claudeCostUsd || 0,
              geminiInTok: d.geminiInTok || 0, geminiOutTok: d.geminiOutTok || 0, geminiCostUsd: d.geminiCostUsd || 0,
              serperCredits: d.serperCredits || 0, serperCostUsd: d.serperCostUsd || 0,
            };
          }
          if (d.generationStartedAt && d.status !== "done") {
            generationStartRef.current = new Date(d.generationStartedAt).getTime();
          }
        } else {
          // документ не існує (ID в sessionStorage але перший setDoc впав) — наступний save додасть createdAt
          createdConfirmedRef.current = false;
        }
      } catch (e) { console.error("Load error:", e); }
      setDbLoading(false);
    };
    load();
  }, [orderId, user, loadWebImages]);

  const activeStageKeys = STAGE_KEYS_SOURCES_FIRST;
  const activeStages = STAGES_SOURCES_FIRST;

  // Оновлюємо maxStageIdx коли просуваємось вперед
  useEffect(() => {
    const idx = activeStageKeys.indexOf(stage);
    if (idx >= 0) {
      // На стейджі "done" одразу розблоковуємо чек-лист
      const newMax = stage === "done" ? activeStageKeys.length - 1 : idx;
      setMaxStageIdx(prev => Math.max(prev, newMax));
    }
  }, [stage]);

  // Синхронізуємо ref з state для використання всередині async-функцій
  useEffect(() => { maxStageIdxRef.current = maxStageIdx; }, [maxStageIdx]);

  // ── Авто-збереження полів введення (input stage) ──
  const inputSaveTimer = useRef(null);
  useEffect(() => {
    if (stage !== "input") return;
    if (!tplText.trim() && !comment.trim() && !clientPlan.trim() && !appendicesText.trim() && !clientMaterialsText.trim() && !readyWorkText.trim()) return;
    clearTimeout(inputSaveTimer.current);
    inputSaveTimer.current = setTimeout(() => {
      saveToFirestore({ tplText, comment, clientPlan, appendicesText, clientMaterialsText, readyWorkFileName, readyWorkText, fileLabel, exampleWorkFileName, stage: "input", status: "new" });
    }, 1500);
    return () => clearTimeout(inputSaveTimer.current);
  }, [tplText, comment, clientPlan, appendicesText, clientMaterialsText, readyWorkFileName, readyWorkText, exampleWorkFileName, stage]); // eslint-disable-line

  // ── Авто-збереження sections при ручному редагуванні плану ──
  const planSaveTimer = useRef(null);
  useEffect(() => {
    if (stage !== "plan" || !sections.length) return;
    clearTimeout(planSaveTimer.current);
    planSaveTimer.current = setTimeout(() => {
      saveToFirestore({ sections, planDisplay });
    }, 1500);
    return () => clearTimeout(planSaveTimer.current);
  }, [sections]); // eslint-disable-line

  // ── Авто-збереження citInputs на стейджі джерел ──
  const citSaveTimer = useRef(null);
  useEffect(() => {
    if (stage !== "sources") return;
    clearTimeout(citSaveTimer.current);
    citSaveTimer.current = setTimeout(() => {
      saveToFirestore({ citInputs, citStructured, abstractsMap, sourceThesisMap });
    }, 500);
    return () => clearTimeout(citSaveTimer.current);
  }, [citInputs]); // eslint-disable-line

  // ── Авто-збереження результатів пошуку джерел ──
  const sourcesSaveTimer = useRef(null);
  useEffect(() => {
    if (stage !== "sources") return;
    if (!Object.keys(suggestedSources).length && !Object.keys(phraseGroups).length && !Object.keys(keywords).length) return;
    clearTimeout(sourcesSaveTimer.current);
    sourcesSaveTimer.current = setTimeout(() => {
      saveToFirestore({ suggestedSources, phraseGroups, keywords });
    }, 2000);
    return () => clearTimeout(sourcesSaveTimer.current);
  }, [suggestedSources, phraseGroups, keywords]); // eslint-disable-line

  // ── Збереження в Firestore ──
  const saveToFirestore = async (patch) => {
    if (!user) return;
    setSaving(true); setSaved(false);
    try {
      const isNew = !currentIdRef.current;
      const id = currentIdRef.current || `${user.uid}_${Date.now()}`;
      if (isNew) {
        currentIdRef.current = id;
        onOrderCreated?.(id);
      }
      const ref = doc(db, "orders", id);
      const base = {
        uid: user.uid,
        updatedAt: new Date().toISOString(),
        topic: patch.info?.topic || info?.topic || "",
        type: patch.info?.type || info?.type || "",
        pages: patch.info?.pages || info?.pages || "",
        deadline: patch.info?.deadline || info?.deadline || "",
        maxStageIdx: maxStageIdxRef.current,
        totalInTok: tokenAccRef.current.inTok,
        totalOutTok: tokenAccRef.current.outTok,
        totalCostUsd: tokenAccRef.current.costUsd,
        claudeInTok: tokenAccRef.current.claudeInTok,
        claudeOutTok: tokenAccRef.current.claudeOutTok,
        claudeCostUsd: tokenAccRef.current.claudeCostUsd,
        geminiInTok: tokenAccRef.current.geminiInTok,
        geminiOutTok: tokenAccRef.current.geminiOutTok,
        geminiCostUsd: tokenAccRef.current.geminiCostUsd,
        serperCredits: tokenAccRef.current.serperCredits,
        serperCostUsd: tokenAccRef.current.serperCostUsd,
        ...(patch.status === "done" ? {
          completedAt: new Date().toISOString(),
          ...(generationStartRef.current ? { generationDurationSec: Math.round((Date.now() - generationStartRef.current) / 1000) } : {}),
        } : {}),
      };
      const data = serializeForFirestore({ ...base, ...patch });
      await setDoc(ref, { ...data, ...(!createdConfirmedRef.current ? { createdAt: new Date().toISOString() } : {}) }, { merge: true });
      createdConfirmedRef.current = true;
      setSaved(true);
      setSaveError("");
      clearTimeout(savedTimerRef.current);
      savedTimerRef.current = setTimeout(() => setSaved(false), 3000);
    } catch (e) {
      console.error("Save error:", e);
      const isSizeError = /maximum size|exceeds|too large|1048576|longer than/i.test(e.message || "");
      setSaveError(isSizeError
        ? "запис завеликий — видаліть частину матеріалів клієнта"
        : "помилка збереження");
    }
    setSaving(false);
  };

  // Мова поза вбудованою таблицею (напр. румунська) — набір підписів, який один раз складає ШІ
  // (useLangProfile / langProfile.js); зберігаємо лише info.langProfile (setDoc з merge)
  useLangProfile({
    language: info?.language, langProfile: info?.langProfile, callClaude,
    onProfile: (langProfile) => {
      setInfo(prev => (prev && normLangName(prev.language) === normLangName(langProfile.forLanguage) ? { ...prev, langProfile } : prev));
      if (currentIdRef.current) saveToFirestore({ info: { langProfile } });
    },
  });

  // Зберігаємо перед виходом — дебаунс-таймери скасовуються при розмонтуванні компонента
  const handleBack = async () => {
    clearTimeout(citSaveTimer.current);
    clearTimeout(sourcesSaveTimer.current);
    try {
      await saveToFirestore({ citInputs, citStructured, abstractsMap, sourceThesisMap, suggestedSources, phraseGroups, keywords });
    } catch (e) { console.error("Pre-back save error:", e); }
    onBack?.();
  };

  const handleFile = useCallback((name, b64, type) => { setFileLabel(name); setFileB64(b64); setFileType(type); }, []);
  const handleExampleWorkFile = useCallback((name, b64, type) => { setExampleWorkFileName(name); setExampleWorkFileB64(b64); setExampleWorkFileType(type); }, []);

  // ── Готова частина роботи від клієнта: витягуємо сирий текст (розбивка по розділах — після генерації плану) ──
  const handleReadyWorkFile = useCallback((arrayBuffer, fileName) => {
    // з номерами автонумерації Word (заголовки 2.1/2.1.1, набрані списком, інакше губляться) і таблицями
    // рядками "| … |" (інакше в роботі таблиця розсипалась на абзаци по клітинці). Рисунки тут не
    // витягуються — їх зберігає лише воркер CRM (order.readyWorkImages)
    extractDocxReadyPart(arrayBuffer, { images: false }).then(({ text: raw }) => {
      const text = raw.trim();
      if (!text) { alert("Не вдалося витягти текст з документа"); return; }
      setReadyWorkFileName(fileName);
      setReadyWorkText(text);
      setReadyWorkImportedIds([]);
      setReadyWorkNeedsManualAI(false);
    }).catch(e => alert("Помилка читання файлу: " + e.message));
  }, []);
  const handleRemoveReadyWork = useCallback(() => {
    setReadyWorkFileName(""); setReadyWorkText(""); setReadyWorkImportedIds([]); setReadyWorkNeedsManualAI(false);
  }, []);

  // ── Автоматичний режим (тест): refs-дзеркала стейту для читання актуальних значень
  // усередині orchestrator-функції runAutoPipeline (звичайний стейт там був би застарілим,
  // бо async-функція не перерендерюється разом з рештою компонента) ──
  const [autoRunning, setAutoRunning] = useState(false);
  const [autoStepLabel, setAutoStepLabel] = useState("");
  const [autoError, setAutoError] = useState(null); // { step, kind: "api" | "missing", message }
  const autoModeRef = useRef(false);
  const sectionsRef = useRef(sections);
  const infoRef = useRef(info);
  const citInputsRef = useRef(citInputs);
  const kwErrorRef = useRef("");
  const sourcesSearchLoadingRef = useRef({});
  const readyWorkImportedIdsRef = useRef(readyWorkImportedIds);
  const methodInfoRef = useRef(methodInfo);
  const commentAnalysisRef = useRef(commentAnalysis);
  useEffect(() => { sectionsRef.current = sections; }, [sections]);
  useEffect(() => { infoRef.current = info; }, [info]);
  useEffect(() => { citInputsRef.current = citInputs; }, [citInputs]);
  useEffect(() => { kwErrorRef.current = kwError; }, [kwError]);
  useEffect(() => { sourcesSearchLoadingRef.current = sourcesSearchLoading; }, [sourcesSearchLoading]);
  useEffect(() => { readyWorkImportedIdsRef.current = readyWorkImportedIds; }, [readyWorkImportedIds]);
  useEffect(() => { methodInfoRef.current = methodInfo; }, [methodInfo]);
  useEffect(() => { commentAnalysisRef.current = commentAnalysis; }, [commentAnalysis]);

  const handleNavigateMain = useCallback((s) => {
    if (running || autoRunning) return;
    setStage(s);
  }, [running, autoRunning]);

  const handleNavigateHeader = useCallback((s) => {
    if (running || autoRunning) return;
    setStage(s);
  }, [running, autoRunning]);

  // ── Аналіз шаблону — делеговано в src/lib/orderStages.js (runAnalyzeStage),
  // яка й дає справжнє покрокове відновлення після збою; браузер тут завжди
  // просить свіжий аналіз (analyzeProgress: {}), бо кожен клік на "Аналізувати"
  // — свідомо нова спроба, а не відновлення після падіння. ──
  const applyAnalyzePatch = (patch) => {
    if (patch.info) setInfo(patch.info);
    if ("methodInfo" in patch) setMethodInfo(patch.methodInfo);
    if ("commentAnalysis" in patch) setCommentAnalysis(patch.commentAnalysis);
    if ("illustrationDescs" in patch) setIllustrationDescs(patch.illustrationDescs);
    if (patch.illustrations) setIllustrations(patch.illustrations);
    if ("clientMaterialsSummary" in patch) setClientMaterialsSummary(patch.clientMaterialsSummary);
    if (patch.titlePage) { setTitlePage(patch.titlePage); setTitlePageLines(patch.titlePageLines); }
  };

  const doAnalyze = async () => {
    setRunning(true); runningRef.current = true; setLoadMsg("Аналізую шаблон...");
    setApiError("");
    setStage("parsed");
    // Клік "Аналізувати" — завжди нова спроба генерації (як і analyzeProgress
    // нижче), тому час рахуємо від цього моменту, навіть якщо це повторний
    // аналіз того самого замовлення.
    generationStartRef.current = Date.now();
    saveToFirestore({ generationStartedAt: new Date().toISOString() });

    const order = {
      tplText, comment, clientPlan,
      methodInfo,
      methodichkaFile: fileB64 ? { b64: fileB64, mediaType: fileType || "application/pdf", name: fileLabel } : null,
      exampleWorkFile: exampleWorkFileB64 ? { b64: exampleWorkFileB64, mediaType: exampleWorkFileType || "application/pdf", name: exampleWorkFileName } : null,
      illustrationsPdfFile: illustrationsPdf ? { b64: illustrationsPdf.b64, mediaType: "application/pdf" } : null,
      illustrations, photos, clientDrawings, clientMaterials, clientMaterialsText,
      appendicesText, fileLabel, exampleWorkFileName,
      analyzeProgress: {},
    };
    const patch = await runAnalyzeStage(order, {
      callClaude, callGemini, onProgress: setLoadMsg,
      onInfo: setInfo,
      extractIllustrationsFromPdf: buildIllustrationsFromPdf,
      save: async (p) => { applyAnalyzePatch(p); await saveToFirestore(p); },
    });
    applyAnalyzePatch(patch);
    if (patch.apiError) setApiError(patch.apiError);

    setRunning(false); runningRef.current = false; setLoadMsg("");
    return patch.info;
  };


  // ── Витяг реальних картинок з PDF-ілюстрацій (сторінка = одна ілюстрація) і підключення
  // їх до того самого масиву illustrations, яким уже користуються docx- і pptx-експорт.
  // Не зберігається в Firestore (як і сам illustrationsPdf) — живе лише в пам'яті сесії.
  async function buildIllustrationsFromPdf(pdfFile, descs) {
    try {
      const pageImages = await extractPdfPageImages(pdfFile.b64);
      const built = descs
        .map((desc, i) => pageImages[i] ? {
          name: `Рис. ${desc.figureNum}`,
          b64: pageImages[i].b64,
          type: pageImages[i].type,
          caption: desc.caption || "",
          targetSection: desc.suggestedSection || "",
        } : null)
        .filter(Boolean);
      if (built.length) setIllustrations(built);
    } catch (e) {
      console.warn("extractPdfPageImages failed:", e.message);
    }
  }

  // ── Підбір ілюстрацій для розділу ──
  function getIllustrationsForSection(sec) {
    if (!illustrationDescs.length) return [];
    if (illustrations.length > 0) {
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

  // Генерація плану делегована в src/lib/orderStages.js (runPlanStage) — та сама
  // функція, яку викликає й серверний воркер, щоб дерево рішень плану не
  // дублювалось і не розходилось між браузером і воркером.
  const doGenPlan = async () => {
    setPlanLoading(true); setSections([]); setPlanDisplay(""); setStage("plan"); setReadyWorkNeedsManualAI(false);
    const d = infoRef.current;
    const order = {
      info: d, methodInfo, commentAnalysis, comment, clientPlan,
      clientMaterialsSummary, clientMaterialsText, readyWorkText,
      content: contentRef.current, citInputs, illustrations, illustrationsPdf,
    };
    const patch = await runPlanStage(order, {
      callClaude, callGemini, onProgress: setLoadMsg,
      extractIllustrationsFromPdf: buildIllustrationsFromPdf,
    });

    setSections(patch.sections); setPlanDisplay(patch.planDisplay);
    setSourceDist(patch.sourceDist); setSourceTotal(patch.sourceTotal);
    if (patch.info) setInfo(patch.info);
    if (patch.content) { setContent(patch.content); contentRef.current = patch.content; }
    if (patch.citInputs) setCitInputs(patch.citInputs);
    if (patch.readyWorkImportedIds) setReadyWorkImportedIds(patch.readyWorkImportedIds);
    if (patch.illustrationDescs) setIllustrationDescs(patch.illustrationDescs);
    setReadyWorkNeedsManualAI(!!patch.readyWorkNeedsManualAI);

    await saveToFirestore({
      sections: patch.sections, planDisplay: patch.planDisplay,
      ...(patch.content ? { content: patch.content } : {}),
      ...(patch.citInputs ? { citInputs: patch.citInputs } : {}),
      ...(patch.readyWorkImportedIds ? { readyWorkImportedIds: patch.readyWorkImportedIds } : {}),
      ...(patch.illustrationDescs ? { illustrationDescs: patch.illustrationDescs } : {}),
      ...(patch.info ? { info: patch.info } : {}),
      stage: patch.stage, status: patch.status,
    });
    setPlanLoading(false); setLoadMsg("");
  };

  // ── Перерахувати сторінки рівномірно (чиста функція — придатна для повторного використання) ──
  const recalcPagesFor = (secs, wc) => {
    const mainIdxs = secs.reduce((acc, s, i) => {
      if (!["intro", "conclusions", "sources", "chapter_conclusion"].includes(s.type)) acc.push(i);
      return acc;
    }, []);
    // Фіксований обсяг — усе, що НЕ підрозділ: вступ/висновки (за wc), висновки до розділів (по 1 стор.), джерела (як є)
    const fixedTotal = secs.reduce((sum, s) => {
      if (s.type === "intro") return sum + wc.introPages;
      if (s.type === "conclusions") return sum + wc.conclusionsPages;
      if (s.type === "chapter_conclusion") return sum + 1;
      if (s.type === "sources") return sum + (s.pages || 1);
      return sum;
    }, 0);
    const pagesForMain = Math.max(mainIdxs.length, wc.totalPages - fixedTotal);
    const n = Math.max(mainIdxs.length, 1);
    const basePages = Math.floor(pagesForMain / n);
    const remainder = pagesForMain - basePages * n;
    const result = [...secs];
    // Залишок від ділення розкидаємо по одній сторінці на перші `remainder` підрозділів,
    // а не скидаємо його весь на останній — інакше останній підрозділ роздувається
    mainIdxs.forEach((idx, j) => {
      const p = Math.max(1, basePages + (j < remainder ? 1 : 0));
      result[idx] = { ...result[idx], pages: p, prompts: Math.max(1, Math.ceil(p / 3)) };
    });
    return result.map(s => {
      if (s.type === "intro") return { ...s, pages: wc.introPages };
      if (s.type === "conclusions") return { ...s, pages: wc.conclusionsPages };
      if (s.type === "chapter_conclusion") return { ...s, pages: 1 };
      return s;
    });
  };

  const recalcPages = () => {
    const wc = buildWorkConfig({ info, methodInfo, commentAnalysis });
    setSections(prev => {
      const next = recalcPagesFor(prev, wc);
      setPlanDisplay(buildPlanText(next));
      return next;
    });
  };

  // ── Увімкнути/вимкнути вступ, висновки або список джерел прямо в уже сформованому плані ──
  const toggleStructureSection = (key) => {
    const type = key === "includeIntro" ? "intro" : key === "includeConclusions" ? "conclusions" : "sources";
    const wc = buildWorkConfig({ info, methodInfo, commentAnalysis });
    const lc = getLangLabels(info?.language);
    const currentlyOn = info?.[key] !== false;
    const nextOn = !currentlyOn;
    setInfo(p => (p ? { ...p, [key]: nextOn } : p));
    setSections(prev => {
      let base;
      if (!nextOn) {
        base = prev.filter(s => s.type !== type);
      } else if (prev.some(s => s.type === type)) {
        base = prev;
      } else {
        const newSec = type === "intro" ? { id: "intro", label: lc.intro, pages: wc.introPages, type: "intro" }
          : type === "conclusions" ? { id: "conclusions", label: lc.conclusions, pages: wc.conclusionsPages, type: "conclusions" }
          : { id: "sources", label: lc.sources, pages: 1, type: "sources" };
        if (type === "intro") base = [newSec, ...prev];
        else if (type === "sources") base = [...prev, newSec];
        else {
          const srcIdx = prev.findIndex(s => s.type === "sources");
          base = srcIdx >= 0 ? [...prev.slice(0, srcIdx), newSec, ...prev.slice(srcIdx)] : [...prev, newSec];
        }
      }
      const next = recalcPagesFor(base, wc);
      setPlanDisplay(buildPlanText(next));
      const { dist, total } = calcSourceDist(next);
      setSourceDist(dist); setSourceTotal(total);
      return next;
    });
  };

  // ── Додати новий розділ (з підрозділами-заглушками) ──
  const addNewChapter = () => {
    const mainSecs = sections.filter(s => !["intro", "conclusions", "sources", "chapter_conclusion"].includes(s.type));
    const maxCh = mainSecs.reduce((m, s) => Math.max(m, parseInt(s.id.split(".")[0]) || 0), 0);
    const chapNum = maxCh + 1;
    const chTypes = ["theory", "analysis", "recommendations"];
    const chType = chTypes[Math.min(chapNum - 1, chTypes.length - 1)];
    const pagesPerSub = Math.max(3, Math.round(parsePagesAvg(info?.pages) * 0.10));
    const lc = getLangLabels(info?.language);
    const sectionTitle = `${chapterHeadingPrefix(info?.language, chapNum)}. [Назва розділу]`;
    const newSubs = [1, 2, 3].map(i => ({
      id: `${chapNum}.${i}`,
      label: `${chapNum}.${i} [${lc.subsWord}]`,
      sectionTitle,
      pages: pagesPerSub,
      prompts: Math.max(1, Math.ceil(pagesPerSub / 3)),
      type: chType,
    }));
    setSections(prev => {
      const next = insertBeforeTail(prev, newSubs);
      setPlanDisplay(buildPlanText(next));
      return next;
    });
  };

  // ── Новий розділ БЕЗ підрозділів — один рядок, чий текст пишеться суцільно
  // на весь розділ (типово для короткого формального розділу, напр. охорона
  // праці, що в частині робіт не розбивається на підпункти). chapterOnly:true —
  // прапорець, за яким buildPlanText/renumberSections/exportDocx не друкують
  // цей рядок ще й як окремий підрозділ під тим самим заголовком. ──
  const addNewChapterEmpty = () => {
    const mainSecs = sections.filter(s => !["intro", "conclusions", "sources", "chapter_conclusion"].includes(s.type));
    const maxCh = mainSecs.reduce((m, s) => Math.max(m, parseInt(s.id.split(".")[0]) || 0), 0);
    const chapNum = maxCh + 1;
    const chTypes = ["theory", "analysis", "recommendations"];
    const chType = chTypes[Math.min(chapNum - 1, chTypes.length - 1)];
    const pages = Math.max(3, Math.round(parsePagesAvg(info?.pages) * 0.08));
    const sectionTitle = `${chapterHeadingPrefix(info?.language, chapNum)}. [Назва розділу]`;
    const newSec = {
      id: `${chapNum}.1`, label: sectionTitle, sectionTitle, chapterOnly: true,
      pages, prompts: Math.max(1, Math.ceil(pages / 3)), type: chType,
    };
    setSections(prev => {
      const next = insertBeforeTail(prev, [newSec]);
      setPlanDisplay(buildPlanText(next));
      return next;
    });
  };

  // ── Переміщення підрозділів ──
  const _applyMove = (prev, newMainSecs) => {
    const rebuilt = rebuildWithChapterConclusions(prev, newMainSecs);
    const renumbered = renumberSections(rebuilt);
    setPlanDisplay(buildPlanText(renumbered));
    const { dist, total } = calcSourceDist(renumbered);
    setSourceDist(dist); setSourceTotal(total);
    return renumbered;
  };

  const moveSectionUp = (sectionId) => {
    setSections(prev => {
      const movable = prev.filter(s => !["intro", "conclusions", "sources", "chapter_conclusion"].includes(s.type));
      const idx = movable.findIndex(s => s.id === sectionId);
      if (idx <= 0) return prev;
      const newMovable = [...movable];
      const moved = { ...newMovable[idx] };
      const above = newMovable[idx - 1];
      if (moved.sectionTitle !== above.sectionTitle) moved.sectionTitle = above.sectionTitle;
      newMovable.splice(idx, 1);
      newMovable.splice(idx - 1, 0, moved);
      return _applyMove(prev, newMovable);
    });
  };

  const moveSectionDown = (sectionId) => {
    setSections(prev => {
      const movable = prev.filter(s => !["intro", "conclusions", "sources", "chapter_conclusion"].includes(s.type));
      const idx = movable.findIndex(s => s.id === sectionId);
      if (idx < 0 || idx >= movable.length - 1) return prev;
      const newMovable = [...movable];
      const moved = { ...newMovable[idx] };
      const below = newMovable[idx + 1];
      if (moved.sectionTitle !== below.sectionTitle) moved.sectionTitle = below.sectionTitle;
      newMovable.splice(idx, 1);
      newMovable.splice(idx + 1, 0, moved);
      return _applyMove(prev, newMovable);
    });
  };

  const moveSectionToPosition = (sectionId, targetChapterTitle, targetPosition) => {
    setSections(prev => {
      const movable = prev.filter(s => !["intro", "conclusions", "sources", "chapter_conclusion"].includes(s.type));
      const idx = movable.findIndex(s => s.id === sectionId);
      if (idx < 0) return prev;
      const newMovable = [...movable];
      const [moved] = newMovable.splice(idx, 1);
      const updatedMoved = { ...moved, sectionTitle: targetChapterTitle };
      let insertIdx = newMovable.length;
      let count = 0;
      for (let i = 0; i <= newMovable.length; i++) {
        if (newMovable[i]?.sectionTitle === targetChapterTitle) {
          if (count === targetPosition - 1) { insertIdx = i; break; }
          count++;
        } else if (count > 0) { insertIdx = i; break; }
      }
      newMovable.splice(insertIdx, 0, updatedMoved);
      return _applyMove(prev, newMovable);
    });
  };

  // ── Придумати назви для заглушок ──
  const doNamePlaceholders = async () => {
    setNamingLoading(true);
    const mainSecs = sections.filter(s => !["intro", "conclusions", "sources", "chapter_conclusion"].includes(s.type));
    // Розділи без підрозділів (chapterOnly) не потребують окремої назви підрозділу —
    // їхній label дублює sectionTitle, тому їх виключаємо із запиту на назви підрозділів.
    const placeholderSubs = mainSecs.filter(s => !s.chapterOnly && /\[|новий/i.test(s.label));
    // Розділи чиї sectionTitle ще заглушки
    const placeholderChapNums = [...new Set(
      mainSecs.filter(s => /\[Назва розділу/i.test(s.sectionTitle)).map(s => s.id.split(".")[0])
    )];
    if (!placeholderSubs.length && !placeholderChapNums.length) { setNamingLoading(false); return; }

    const planContext = mainSecs.map(s => `${s.id} — ${s.label}`).join("\n");
    const subIds = placeholderSubs.map(s => s.id);
    const chapIds = placeholderChapNums;

    const prompt = `Academic work. Topic: "${info?.topic}". Type: ${info?.type}. Field: ${info?.subject}.
Language: ${info?.language || "Ukrainian"} — all titles must be in this language.

CURRENT PLAN:
${planContext}

Generate titles for placeholder sections only. They must fit the topic and not repeat existing sections.

Return ONLY JSON without markdown:
{
  "subsections": {${subIds.map(id => `"${id}":"subsection title"`).join(",")}},
  "chapters": {${chapIds.map(id => `"${id}":"chapter title (without the chapter-word N. prefix, e.g. without 'CHAPTER 1.' / 'РОЗДІЛ 1.')"`).join(",")}}
}`;

    try {
      const raw = await callClaude([{ role: "user", content: prompt }], null, SYS_JSON_SHORT, 1200, null, MODEL_FAST);
      const match = raw.match(/\{[\s\S]*\}/);
      const parsed = JSON.parse(match?.[0] || raw);
      const subTitles = parsed.subsections || {};
      const chapTitles = parsed.chapters || {};

      setSections(prev => {
        const next = prev.map(s => {
          const chNum = s.id.split(".")[0];
          // Оновлюємо sectionTitle якщо є нова назва розділу
          const newSectionTitle = chapTitles[chNum]
            ? `${chapterHeadingPrefix(info?.language, chNum)}. ${chapTitles[chNum]}`
            : s.sectionTitle;
          // Розділ без підрозділів: label завжди дублює sectionTitle
          if (s.chapterOnly) return { ...s, label: newSectionTitle, sectionTitle: newSectionTitle };
          // Оновлюємо label підрозділу якщо є нова назва
          const newLabel = subTitles[s.id]
            ? `${s.id} ${subTitles[s.id]}`
            : s.label;
          return { ...s, label: newLabel, sectionTitle: newSectionTitle };
        });
        setPlanDisplay(buildPlanText(next));
        return next;
      });
    } catch (e) {
      console.warn("naming failed:", e.message);
    }
    setNamingLoading(false);
  };

  // ── Придумати назву для одного підрозділу-заглушки ──
  const doNameSinglePlaceholder = async (sectionId) => {
    setSingleNamingId(sectionId);
    const mainSecs = sections.filter(s => !["intro", "conclusions", "sources", "chapter_conclusion"].includes(s.type));
    const target = mainSecs.find(s => s.id === sectionId);
    if (!target) { setSingleNamingId(null); return; }
    const isChapPlaceholder = /\[Назва розділу/i.test(target.sectionTitle);
    const chNum = sectionId.split(".")[0];
    const planContext = mainSecs.map(s => `${s.id} — ${s.label}`).join("\n");
    const prompt = `Academic work. Topic: "${info?.topic}". Type: ${info?.type}. Field: ${info?.subject}.
Language: ${info?.language || "Ukrainian"} — all titles must be in this language.

CURRENT PLAN:
${planContext}

Generate a title for ONE placeholder section: ${sectionId} (currently: "${target.label}"). It must fit the topic and not repeat existing sections.
${isChapPlaceholder ? `Also generate a chapter title for chapter ${chNum}.` : ""}
Return ONLY JSON:
{"subsections":{"${sectionId}":"subsection title"}${isChapPlaceholder ? `,"chapters":{"${chNum}":"chapter title (without the chapter-word N. prefix, e.g. without 'CHAPTER 1.' / 'РОЗДІЛ 1.')"}` : ""}}`;
    try {
      const raw = await callClaude([{ role: "user", content: prompt }], null, SYS_JSON_SHORT, 600, null, MODEL_FAST);
      const match = raw.match(/\{[\s\S]*\}/);
      const parsed = JSON.parse(match?.[0] || raw);
      const subTitles = parsed.subsections || {};
      const chapTitles = parsed.chapters || {};
      setSections(prev => {
        const next = prev.map(s => {
          const cn = s.id.split(".")[0];
          const newSectionTitle = chapTitles[cn] ? `${chapterHeadingPrefix(info?.language, cn)}. ${chapTitles[cn]}` : s.sectionTitle;
          const newLabel = subTitles[s.id] ? `${s.id} ${subTitles[s.id]}` : s.label;
          return { ...s, label: newLabel, sectionTitle: newSectionTitle };
        });
        setPlanDisplay(buildPlanText(next));
        return next;
      });
    } catch (e) {
      console.warn("single naming failed:", e.message);
    }
    setSingleNamingId(null);
  };

  // ── Ручне перейменування розділу (заголовок групи в таблиці) — застосовується
  // одразу до sectionTitle усіх підрозділів (і "висновків до розділу") з тим самим
  // старим sectionTitle. Для розділу без підрозділів (chapterOnly) label теж
  // дублює sectionTitle, тож синхронізуємо і його. ──
  const updateChapterTitle = (oldSectionTitle, newSectionTitle) => {
    setSections(prev => {
      const next = prev.map(s => s.sectionTitle === oldSectionTitle
        ? { ...s, sectionTitle: newSectionTitle, ...(s.chapterOnly ? { label: newSectionTitle } : {}) }
        : s);
      setPlanDisplay(buildPlanText(next));
      return next;
    });
  };

  // ── Придумати назву для розділу (без прив'язки до конкретного підрозділу) —
  // окрема кнопка ✨ біля заголовка розділу, на відміну від doNameSinglePlaceholder,
  // яка генерує назву розділу лише як побічний ефект генерації назви підрозділу. ──
  const doNameSingleChapter = async (chapNum) => {
    const namingId = `chapter_${chapNum}`;
    setSingleNamingId(namingId);
    const mainSecs = sections.filter(s => !["intro", "conclusions", "sources", "chapter_conclusion"].includes(s.type));
    const chapterSecs = mainSecs.filter(s => s.id.split(".")[0] === String(chapNum));
    if (!chapterSecs.length) { setSingleNamingId(null); return; }
    const oldTitle = chapterSecs[0].sectionTitle;
    const planContext = mainSecs.map(s => `${s.id} — ${s.label}`).join("\n");
    const prompt = `Academic work. Topic: "${info?.topic}". Type: ${info?.type}. Field: ${info?.subject}.
Language: ${info?.language || "Ukrainian"} — all titles must be in this language.

CURRENT PLAN:
${planContext}

Generate a title for chapter ${chapNum} (currently: "${oldTitle}"). It must fit the topic and not repeat existing chapters.
Return ONLY JSON:
{"title":"chapter title (without the chapter-word N. prefix, e.g. without 'CHAPTER ${chapNum}.' / 'РОЗДІЛ ${chapNum}.')"}`;
    try {
      const raw = await callClaude([{ role: "user", content: prompt }], null, SYS_JSON_SHORT, 300, null, MODEL_FAST);
      const match = raw.match(/\{[\s\S]*\}/);
      const parsed = JSON.parse(match?.[0] || raw);
      if (!parsed.title) throw new Error("empty title");
      const newTitle = `${chapterHeadingPrefix(info?.language, chapNum)}. ${parsed.title}`;
      updateChapterTitle(oldTitle, newTitle);
    } catch (e) {
      console.warn("chapter naming failed:", e.message);
    }
    setSingleNamingId(null);
  };

  // ── Правки клієнта до плану: ШІ лише перетворює вільний текст клієнта на список
  // структурних операцій (planUtils не вміє розуміти вільну мову) — саме застосування
  // до sections виконує детермінований код (applyPlanEditOps), не ШІ. ──
  const doAnalyzeClientEdits = async () => {
    if (!clientEditsText.trim()) return;
    setClientEditsLoading(true);
    setClientEditsError("");
    try {
      const prompt = buildClientPlanEditsPrompt({ sections, editsText: clientEditsText });
      const raw = await callClaude([{ role: "user", content: prompt }], null, SYS_JSON_ARRAY, 2000, null, MODEL_FAST);
      const match = raw.match(/\[[\s\S]*\]/);
      const parsed = JSON.parse(match?.[0] || raw.replace(/```json|```/g, "").trim());
      if (!Array.isArray(parsed)) throw new Error("Некоректна відповідь ШІ");
      const withIds = parsed.map((op, i) => ({ ...op, _id: `op_${i}` }));
      const defaultChecked = {};
      withIds.forEach(op => {
        const { invalid } = describePlanEditOp(op, sections);
        defaultChecked[op._id] = !invalid;
      });
      setClientEditsOps(withIds);
      setClientEditsChecked(defaultChecked);
    } catch (e) {
      setClientEditsError("Не вдалося розпізнати правки: " + e.message);
    }
    setClientEditsLoading(false);
  };

  const doApplyClientEdits = () => {
    const toApply = (clientEditsOps || []).filter(op => clientEditsChecked[op._id] !== false);
    if (!toApply.length) return;
    setSections(prev => {
      const next = applyPlanEditOps(prev, toApply, info?.language);
      setPlanDisplay(buildPlanText(next));
      const { dist, total } = calcSourceDist(next);
      setSourceDist(dist); setSourceTotal(total);
      return next;
    });
    setShowClientEditsInput(false);
    setClientEditsText("");
    setClientEditsOps(null);
    setClientEditsChecked({});
    setClientEditsError("");
  };

  const cancelClientEdits = () => {
    setShowClientEditsInput(false);
    setClientEditsText("");
    setClientEditsOps(null);
    setClientEditsChecked({});
    setClientEditsError("");
  };

  const startGen = async () => {
    resetGenerationCost();
    const ORDER = ["theory", "analysis", "recommendations", "chapter_conclusion", "intro", "conclusions", "sources"];
    setSections(prev => [...prev].sort((a, b) => ORDER.indexOf(a.type) - ORDER.indexOf(b.type)));
    // Не стираємо текст, імпортований з готової частини роботи клієнта — лише те, що ще належить дописати
    setContent(prev => {
      const preserved = {};
      (readyWorkImportedIds || []).forEach(id => { if (prev[id]) preserved[id] = prev[id]; });
      return preserved;
    });
    setGlossary({});
    setGenIdx(0); setPaused(false); writingDoneRef.current = false; autoRemapDoneRef.current = false; appendixFillDoneRef.current = false;
    appendixDeferredGenDoneRef.current = false;
    const needsEconProfileForGen = !econProfile && (isEcon(info) || !!methodInfo?.requiresEnterpriseProfile);
    // Реальну методику/тест/експеримент (фіксований інструмент) і додатки з реальним обґрунтуванням
    // (код клієнта, профіль підприємства) генеруємо ДО тексту — вони не залежать від того, що напише AI.
    // Авторську анкету (немає фіксованого джерела істини) — відкладаємо й генеруємо ПІСЛЯ тексту,
    // узгоджено з тим, що там реально написано (вибірка, вік/клас, кількість запитань).
    const { needsAppendix: needsAppendixForGen, deferred: isDeferredForGen } = planAppendixGeneration({ info, commentAnalysis });
    appendixDeferredRef.current = isDeferredForGen;
    (async () => {
      // Для економічних робіт додатки мають спиратись на той самий профіль підприємства,
      // що й основний текст — тому чекаємо його готовності перед генерацією додатків.
      const profileForAppendices = needsEconProfileForGen ? await doGenEconProfile() : econProfile;
      if (!appendicesText && needsAppendixForGen && !appendixDeferredRef.current) doGenAppendices(profileForAppendices);
    })();
    setStage("sources");
    saveToFirestore({ workflowMode: "sources-first", stage: "sources", status: "writing" });
  };


  const doScanAndGenFigures = async () => {
    setFigKwLoading(true);
    // 1. Сканування всіх підрозділів
    const newRefs = {};
    sections.forEach(sec => { if (content[sec.id]) newRefs[sec.id] = scanFigures(content[sec.id]); });
    setFigureRefs(newRefs);
    const allFigs = sections.flatMap(sec => (newRefs[sec.id] || []).map(f => ({ ...f, secLabel: sec.label })));
    if (!allFigs.length) { setFigKwLoading(false); return; }
    // 2. Генерація ключових слів для знайдених рисунків
    const topic = info?.topic || "";
    const prompt = `Ти допомагаєш студенту знайти ілюстрації для курсової/дипломної роботи на тему "${topic}".
Нижче список рисунків згаданих у роботі з контекстом. Для кожного рисунка дай:
1. Коротку назву що зображує рисунок (1 речення)
2. 3-4 ключових слова для пошуку зображення (краще англійською для Google Images/Unsplash/ResearchGate)

Відповідь — ТІЛЬКИ JSON масив:
[{"label":"Рис. 1","name":"Короткий опис","keywords":"ключові слова для пошуку"}]

Рисунки:
${allFigs.map((f, i) => `${i + 1}. ${f.label} (підрозділ: ${f.secLabel})\nКонтекст: ${f.context}`).join("\n\n")}`;
    try {
      const raw = await callClaude([{ role: "user", content: prompt }], null, SYS_JSON_ARRAY, 2000, null, MODEL_FAST);
      const parsed = JSON.parse(raw.match(/\[[\s\S]*\]/)?.[0] || "[]");
      setFigureKeywords(parsed);
    } catch (e) { console.error(e); }
    setFigKwLoading(false);
  };

  // ── Авто-сканування рисунків при переході на done ──
  useEffect(() => {
    if (stage !== "done") return;
    const newRefs = {};
    sections.forEach(sec => { if (content[sec.id]) newRefs[sec.id] = scanFigures(content[sec.id]); });
    setFigureRefs(newRefs);
  }, [stage, content]);

  // ── Відкладена генерація Додатку А (авторська анкета) — після завершення тексту,
  // щоб анкета точно відповідала вибірці й даним, які там реально описані ──
  useEffect(() => {
    if (stage !== "done") return;
    if (!appendixDeferredRef.current || appendicesText || appendixDeferredGenDoneRef.current) return;
    appendixDeferredGenDoneRef.current = true;
    const empSecsForApp = getEmpiricalSections(sections, info, commentAnalysis, methodInfo);
    const empIds = new Set([...(empSecsForApp.chapterSectionIds || []), empSecsForApp.anchorId].filter(Boolean));
    const empText = sections.filter(s => empIds.has(s.id)).map(s => content[s.id]).filter(Boolean).join("\n\n");
    const finishedBodyText = empText || sections.filter(s => s.type !== "sources").map(s => content[s.id]).filter(Boolean).join("\n\n");
    doGenAppendices(undefined, finishedBodyText);
  }, [stage]); // eslint-disable-line

  // ── Авто-заповнення полів додатків, позначених маркером, при переході на done ──
  useEffect(() => {
    if (stage !== "done") return;
    doFillAppendixData();
  }, [stage, appendicesText]); // eslint-disable-line

  // ── Генерація тексту ──
  useEffect(() => {
    if (stage !== "writing" || paused) return;
    if (runningRef.current) return;
    if (genIdx >= sections.length) {
      if (!writingDoneRef.current) {
        writingDoneRef.current = true;
        autoRemapDoneRef.current = true; // ремап цитат запускаємо лише після завершення обрізки/підстановки нижче
        playDoneSound();

        (async () => {
          // Перевірка сумарного обсягу й підстановка фактичної к-сті сторінок у
          // "Структура роботи" переїхали в кінець doRemapCitations — там текст
          // уже остаточний (з довставленими цитатами для осиротілих джерел),
          // тож обрізка й підрахунок сторінок рахують правдиву, а не проміжну цифру.
          const finalContent = contentRef.current;
          const allUnlocked = activeStageKeys.length - 1;
          saveToFirestore({ stage: "writing", status: "writing", content: finalContent, citInputs, maxStageIdx: allUnlocked });
          doRemapCitations();
        })();
      }
      return;
    }
    const sec = sections[genIdx];
    if (contentRef.current[sec.id] !== undefined) { setGenIdx(g => g + 1); return; }
    if (sec.type === "sources") {
      setContent(p => ({ ...p, [sec.id]: "[Додайте джерела на кроці «Джерела»]" }));
      setGenIdx(g => g + 1); return;
    }
    // headingOnly довіряємо лише якщо в плані справді є вкладений пункт (id, що починається
    // з "${sec.id}.") — інакше це осиротіла "шапка" без дітей (баг парсера плану чи готової
    // частини клієнта), і пункт пишеться як звичайний підрозділ, а не лишається порожнім.
    if (sec.headingOnly && sections.some(s => s.id !== sec.id && s.id.startsWith(sec.id + "."))) {
      // пункт-«шапка» (1.1 перед 1.1.1) — лише заголовок, власного тексту не пишемо
      setContent(p => ({ ...p, [sec.id]: "" }));
      setGenIdx(g => g + 1); return;
    }
    // Практичні підрозділи потребують готового Додатку А — чекаємо якщо він ще генерується
    if (appendicesLoading && !appendicesText && info) {
      if (sectionNeedsAppendix(sec, { sections, info, commentAnalysis, methodInfo })) return;
    }
    runSection(sec);
  }, [stage, genIdx, paused, sections, appendicesText, appendicesLoading]);

  // Генерація одного підрозділу делегована в src/lib/orderStages.js
  // (runWritingSection) — та сама функція, яку викликає й серверний воркер,
  // щоб логіка написання тексту не дублювалась і не розходилась між ними.
  const runSection = async (sec) => {
    runningRef.current = true; setRunning(true); setLoadMsg("Генерую: " + sec.label + "...");
    const ctrl = new AbortController(); abortRef.current = ctrl;
    const order = {
      info, sections, content: contentRef.current, citInputs, citStructured,
      abstractsMap, sourceThesisMap, commentAnalysis, methodInfo, appendicesText,
      clientMaterialsSummary, clientMaterialsText, econProfile, glossary: glossaryRef.current,
      illustrationDescs, illustrations,
    };
    try {
      const patch = await runWritingSection(order, sec, {
        callClaude, signal: ctrl.signal, onProgress: setLoadMsg,
      });
      setContent(patch.content);
      if (patch.citInputs !== order.citInputs) setCitInputs(patch.citInputs);
      if (patch.abstractsMap !== order.abstractsMap) setAbstractsMap(patch.abstractsMap);
      if (patch.sourceThesisMap !== order.sourceThesisMap) setSourceThesisMap(patch.sourceThesisMap);
      if (patch.glossary !== order.glossary) setGlossary(patch.glossary);

      runningRef.current = false; setRunning(false); setLoadMsg("");
      await saveToFirestore({ content: patch.content, stage: "writing", status: "writing", genIdx: genIdx + 1 });
      // Пауза між підрозділами щоб не вичерпати rate limit
      await new Promise(r => setTimeout(r, 2000));
      setGenIdx(g => g + 1);
    } catch (e) {
      if (e.name === "AbortError") {
        runningRef.current = false; setRunning(false); setPaused(true); setLoadMsg("");
      } else {
        console.error(e);
        runningRef.current = false; setRunning(false); setPaused(true);
        setApiError(e.message);
        setLoadMsg("⚠ " + e.message);
      }
    }
  };

  // ── Переписати один підрозділ ──
  const doRegenSection = async (sec) => {
    setRegenLoading(true);
    const d = info;
    const lang = d?.language || "Українська";
    const approxParas = Math.max(2, Math.round((sec.pages || 1) * 2.5));
    const customInstructions = regenPrompt ? `\nДОДАТКОВІ ВИМОГИ: ${regenPrompt}` : "";
    const originalText = contentRef.current[sec.id] || "";

    // Будуємо multi-turn: всі інші секції як контекст + оригінал поточної
    const buildRegenMessages = (instruction) => {
      const otherEntries = Object.entries(contentRef.current).filter(([k]) => k !== sec.id);
      const msgs = [];
      if (otherEntries.length) {
        const contextText = otherEntries.map(([k, v]) => {
          const s = sections.find(x => x.id === k);
          return `=== ${s?.label || k} ===\n${v}`;
        }).join("\n\n---\n\n");
        msgs.push({ role: "user", content: "Ось вже написані частини цієї роботи:" });
        msgs.push({ role: "assistant", content: contextText });
      }
      if (originalText) {
        msgs.push({ role: "user", content: `Ось поточний варіант підрозділу "${sec.label}" — він потребує переписування:` });
        msgs.push({ role: "assistant", content: originalText });
      }
      msgs.push({ role: "user", content: instruction });
      return msgs;
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
          return `${label}: one paragraph starting with "${phrase}" — strong opening sentence about the problem. Do NOT split into multiple paragraphs.`;
        }
        if (/теоретико|теоретичн.*основ|методологічн.*основ|theoretical.*basis|podstawy.*teor/i.test(comp)) {
          const phrase = il.theoryBasis || "Теоретико-методологічну основу дослідження становлять";
          return `${label}: paragraph starting with "${phrase}" — list authors, academic works, regulatory acts relevant to the topic.`;
        }
        if ((/мета|goal|cel\b|ziel|objetivo|cíl|účel/i.test(comp)) && !/завдання|task|zadani|aufgab/i.test(comp)) {
          const phrase = il.goal || "Мета дослідження –";
          return `${label}: write as "${phrase} [clearly formulated goal]".`;
        }
        if (/завдання|tasks|zadania|aufgaben|tareas|úkoly/i.test(comp)) {
          const phrase = il.tasks || "Завдання дослідження:";
          const natureLine = tasksProfile.nature ? ` Tasks should be ${tasksProfile.nature}.` : "";
          return `${label}: write as "${phrase}" — exactly ${tasksCount} numbered tasks.${natureLine} ${INTRO_TASKS_MERGE_SPLIT_RULE}\nPlan structure (content basis for tasks):\n${mainSecs.map((s, j) => `   ${j + 1}) "${s.label}"`).join("\n")}`;
        }
        if (/об.єкт|object|przedmiot\s+bad|gegenstand|objeto\s+de/i.test(comp)) {
          const phrase = il.object || "Об'єкт дослідження –";
          return `${label}: write as "${phrase} [phenomenon or process under study]".`;
        }
        if (/предмет|subject|obiekt\s+bad|subjekt|sujeto/i.test(comp)) {
          const phrase = il.subject || "Предмет дослідження –";
          return `${label}: write as "${phrase} [specific aspect of the object]".`;
        }
        if ((/метод|methods|metody|methoden|métodos/i.test(comp)) && !/теоретико|методологічн.*основ|teoretyczn|podstawy/i.test(comp)) {
          const phrase = il.methods || "Методи дослідження:";
          return `${label}: write as "${phrase} [comma-separated list of methods]".`;
        }
        if (/новизн|novelty|nowość|neuheit|novedad/i.test(comp)) {
          const phrase = il.novelty || "Наукова новизна дослідження –";
          return `${label}: write as "${phrase} [new propositions, distinction from known]".`;
        }
        if (/практичн|practical|praktyczn|praktisch|práctico/i.test(comp)) {
          const phrase = il.practical || "Практична значущість:";
          return `${label}: write as "${phrase} [practical application of results]".`;
        }
        if (/апробац|approbation|aprobacja/i.test(comp)) {
          const phrase = il.approbation || "Апробація результатів дослідження –";
          return `${label}: write as "${phrase} [where presented: conferences, articles, seminars]".`;
        }
        if (structureRe.test(comp)) {
          const phrase = il.structure || "Структура роботи:";
          const chapCount = new Set(mainSecs.map(s => s.id.split(".")[0])).size || mainSecs.length;
          return `${label}: write EXACTLY one sentence following this template (translate it into the language of the work, keep the same structure), with NOTHING else added — no chapter-by-chapter description: "${phrase} the work consists of an introduction, ${chapCount} chapters, conclusions, and a bibliography."`;
        }
        return `${label}: write in format "${label} – [content relevant to the topic]".`;
      });

      instruction = `Rewrite the INTRODUCTION for ${d.type} on the topic "${d.topic}". Field: ${d.subject}.

INTRO STRUCTURE (follow strictly, each element as a new paragraph):

${componentLines.map((l, i) => `${i + 1}. ${l}`).join("\n\n")}
${methodInfo?.otherRequirements ? `\nMETHOD REQUIREMENTS: ${methodInfo.otherRequirements}` : ""}
IMPORTANT: use the written chapters (provided in context) for precise formulation of methods, sample, object. Follow the format of each element strictly. Do NOT bold or italicize anything. No citations. EXCEPTION: research tasks — write as a numbered list (1. 2. 3. ...), each task on a new line.${customInstructions}`;

    } else if (sec.type === "conclusions") {
      const mainSecsForConcl = sections.filter(s => !["intro", "conclusions", "sources", "chapter_conclusion"].includes(s.type));
      const conclTasksProfile = getIntroTasksProfile(d.type, d.course, mainSecsForConcl.length, isLarge);
      instruction = `Перепиши ВИСНОВКИ для ${d.type} на тему "${d.topic}".
${methodInfo?.conclusionsRequirements ? `ВИМОГИ МЕТОДИЧКИ: ${methodInfo.conclusionsRequirements}\n` : ""}
Обсяг: приблизно ${(sec.pages || 2) * 230} слів (~${sec.pages} стор.). Кожен абзац = один конкретний результат.
Перший — загальний підсумок. Далі — рівно ${conclTasksProfile.count} абзаців, по одному на кожне завдання дослідження, сформульоване у вступі (текст вступу є в контексті), у тому самому порядку; якщо завдання поєднувало кілька підрозділів — зведи результати в одному абзаці, якщо було розбите з одного підрозділу — розподіли на відповідну кількість абзаців. Останній — перспективи.
Абзаци-результати мають мати різний ритм і різні відкривачі речень, не всі підряд у форматі "Аналіз... засвідчив, що..." — чергуй з прямим твердженням, конкретним фактом, розгортанням попередньої думки. Висновки мають звучати іншим голосом, ніж вступ, а не дзеркалити його ритм.
НЕ повторювати вступ. НЕ вводити нове. Без посилань. Без жирного. Без нумерації.
Спирайся на весь написаний текст роботи, включно з формулюваннями завдань у вступі (є в контексті).${customInstructions}`;
    } else {
      const empSecsRegen = getEmpiricalSections(sections, d, commentAnalysis, methodInfo);
      const isEmpChapterRegen = empSecsRegen.chapterSectionIds.includes(sec.id);
      const isEmpAnchorRegen = empSecsRegen.anchorId === sec.id;
      let empiricalBlockRegen = "";

      const econSecIdsRegen = getEconSections(sections, d);
      const isEconSecRegen = econSecIdsRegen.includes(sec.id);
      let econBlockRegen = "";
      if (isEconSecRegen) {
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
          ? `\nОБОВ'ЯЗКОВО: мінімум одна таблиця markdown з числовими даними, аналіз динаміки з цифрами${sec.type === "recommendations" ? ", таблиця прогнозних показників після впровадження рекомендацій" : ""}`
          : "";
        const profileBlockRegen = econProfile
          ? `\nФІКСОВАНІ БАЗОВІ ДАНІ ПІДПРИЄМСТВА (використовуй САМЕ ЦІ дані в усіх розрахунках і таблицях цього підрозділу, не вигадуй іншу назву/рік/цифри):\n${econProfile}\n`
          : "";
        econBlockRegen = `${profileBlockRegen}${formulasBlock}${tablesBlock}${genericEcon}`;
      }

      const technicalSecIdsRegen = getTechnicalSections(sections, d);
      const isTechnicalSecRegen = technicalSecIdsRegen.includes(sec.id);
      let technicalBlockRegen = "";
      if (isTechnicalSecRegen) {
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
          ? `\nОБОВ'ЯЗКОВО для цього підрозділу (технічна/інженерна робота): конкретний інженерний/технічний розрахунок з формулою і підстановкою реалістичних числових значень, результати — у таблиці markdown (|---|---| формат)`
          : "";
        const hasClientMaterialsRegen = !!(clientMaterialsSummary?.rawText || clientMaterialsText?.trim());
        const codeSnippetBlockRegen = hasClientMaterialsRegen
          ? `\nЯКЩО серед МАТЕРІАЛІВ КЛІЄНТА є реальний вихідний код — цей підрозділ ОБОВ'ЯЗКОВО пиши на основі цього коду: опиши реальну структуру програми (модулі/класи/функції), послідовність роботи алгоритму та ключову логіку, посилаючись на фактичні назви функцій/класів/змінних із наданого коду. ${CODE_GROUNDING_RULE} Додатково наведи ОДИН короткий фрагмент (5-15 рядків) цього коду як приклад, у потрійних зворотних лапках (\`\`\`), точно як у наданому коді. Якщо коду немає — пропусти цю вимогу.`
          : "";
        technicalBlockRegen = `${formulasBlockT}${tablesBlockT}${genericTechnical}${codeSnippetBlockRegen}`;
      }

      const rdRegen = commentAnalysis?.researchDesign ?? (commentAnalysis?.empiricalHints ? { instrumentType: "questionnaire", groups: [], comparisonRequired: false, biographicalFields: [], statisticalMinN: null } : null);
      const methodInfoHasEmpiricalRegen = !!(methodInfo && /анкет|опитуванн|емпіричн|респондент|вибірк|тест|експеримент|методик/i.test(
        [methodInfo.analysisRequirements, methodInfo.otherRequirements, methodInfo.theoryRequirements].filter(Boolean).join(" ")
      ));
      const hasEmpiricalRegen = !!(rdRegen || methodInfoHasEmpiricalRegen);
      const empHintRegen = (() => {
        if (!rdRegen) return commentAnalysis?.empiricalHints || "";
        const parts = [];
        if (rdRegen.groups?.length) parts.push(`Групи: ${rdRegen.groups.map(g => `${g.name}${g.minN ? ` (n≥${g.minN})` : ""}${g.criteria ? `, ${g.criteria}` : ""}`).join("; ")}.`);
        if (rdRegen.biographicalFields?.length) parts.push(`Біографічний блок: ${rdRegen.biographicalFields.join(", ")}.`);
        if (rdRegen.statisticalMinN) parts.push(`Мін. вибірка: ${rdRegen.statisticalMinN} осіб.`);
        if (rdRegen.comparisonRequired) parts.push("Порівняння між групами обов'язкове.");
        return parts.join(" ") || commentAnalysis?.empiricalHints || "";
      })();
      const hasMultipleGroupsRegen = (rdRegen?.groups?.length || 0) > 1;
      const comparisonRequiredRegen = rdRegen?.comparisonRequired || hasMultipleGroupsRegen;
      const bioDescRegen = rdRegen?.biographicalFields?.length ? rdRegen.biographicalFields.join(", ") : "ПІБ, вік, стаж, кваліфікація";
      const appendixRefRegen = appendicesText ? '\nДодай речення: "Анкета наведена у Додатку А."' : "";
      const compTableRegen = comparisonRequiredRegen ? `\nПорівняльна таблиця: ОБОВ'ЯЗКОВО окрема таблиця markdown що порівнює ключові показники між групами.` : "";
      const tableSourceRegen = appendicesText
        ? "з узагальненими показниками по 5-8 найпоказовіших запитаннях з Додатку А (НЕ роби окремий рядок чи блок на кожне запитання анкети підряд — обери ключові для аналізу; решту результатів викладай у тексті словами, без таблиці)"
        : "з 5-8 репрезентативними відсотковими показниками за темою (без рядка на кожне можливе питання анкети)";

      const practicalApproachRegen = commentAnalysis?.practicalApproach;
      const suppressEmpRegen = !!(practicalApproachRegen && practicalApproachRegen !== "questionnaire");

      if (isEmpChapterRegen && !suppressEmpRegen) {
        empiricalBlockRegen = `

КОНТЕКСТ (емпіричне дослідження):
${empHintRegen ? `ВИМОГА: ${empHintRegen}\n` : ""}Визнач за назвою підрозділу що писати:
- організація/методика: вибірка (групи, кількість, критерії), біографічний блок (${bioDescRegen}), метод та принцип проведення.${appendixRefRegen}
- аналіз/результати: таблиця markdown ${tableSourceRegen}, аналіз.${compTableRegen}
- рекомендації: на основі результатів з попередніх підрозділів, без повтору вибірки.`;
      } else if (isEmpAnchorRegen && !suppressEmpRegen) {
        empiricalBlockRegen = `

ОБОВ'ЯЗКОВО (емпіричне дослідження):
${empHintRegen ? `ВИМОГА: ${empHintRegen}\n` : ""}Вибірка, біографічний блок (${bioDescRegen}), метод, принцип проведення, таблиця markdown ${tableSourceRegen}, аналіз.${compTableRegen}${appendixRefRegen}`;
      } else if (hasEmpiricalRegen && ["analysis", "recommendations"].includes(sec.type) && !suppressEmpRegen) {
        const practicalSecsRegen = sections.filter(s => ["analysis", "recommendations"].includes(s.type));
        const secIdxRegen = practicalSecsRegen.findIndex(s => s.id === sec.id);
        if (secIdxRegen === 0) {
          empiricalBlockRegen = `

ОБОВ'ЯЗКОВО (емпіричне дослідження):
${empHintRegen ? `ВИМОГА: ${empHintRegen}\n` : ""}1. Організація: ${rdRegen?.groups?.length ? rdRegen.groups.map(g => `${g.name}${g.minN ? ` (n≥${g.minN})` : ""}${g.criteria ? `, ${g.criteria}` : ""}`).join("; ") : "вибірка — кількість, категорії, критерії"}.
2. Біографічний блок: ${bioDescRegen}.
3. Метод та принцип проведення.
4. Таблиця markdown (|---|---| формат) ${tableSourceRegen}.${compTableRegen}
5. Аналіз і висновки.${appendixRefRegen}`;
        } else if (secIdxRegen < practicalSecsRegen.length - 1) {
          empiricalBlockRegen = `

КОНТЕКСТ (емпіричне дослідження):
${empHintRegen ? `ВИМОГА: ${empHintRegen}\n` : ""}Таблиця markdown ${tableSourceRegen}.${compTableRegen} Аналіз. Без повтору опису вибірки.`;
        } else {
          empiricalBlockRegen = `

КОНТЕКСТ (емпіричне дослідження):
${empHintRegen ? `ВИМОГА: ${empHintRegen}\n` : ""}Рекомендації на основі результатів. Без повтору опису вибірки та методики.`;
        }
      }

      const clientReqsRegen = [
        commentAnalysis?.writingHints,
        commentAnalysis?.textStructureHints,
      ].filter(Boolean).join("\n");
      const clientMaterialsBlockRegen = (() => {
        if (clientMaterialsSummary?.rawText) {
          return `\n\nМАТЕРІАЛИ КЛІЄНТА (використовуй ці дані):\n${clientMaterialsSummary.rawText.slice(0, 80000)}${isTechnicalSecRegen ? `\n\n${CODE_GROUNDING_RULE}` : ""}`;
        }
        if (clientMaterialsText?.trim()) {
          return `\n\nМАТЕРІАЛИ КЛІЄНТА (використовуй ці дані — не вигадуй, не замінюй):\n${clientMaterialsText.slice(0, 80000)}${isTechnicalSecRegen ? `\n\n${CODE_GROUNDING_RULE}` : ""}`;
        }
        return "";
      })();
      const secIllRegen = getIllustrationsForSection(sec);
      const hasIndexRegen = secIllRegen.every(ill => ill.index != null);
      const illBlockRegen = secIllRegen.length
        ? `\n\nІЛЮСТРАЦІЇ КЛІЄНТА ДО ЦЬОГО ПІДРОЗДІЛУ:\n${secIllRegen.map(ill => `Рис. ${ill.figureNum}${ill.caption ? ` – ${ill.caption}` : ""}: ${ill.description}${hasIndexRegen ? ` — маркер вставки: [КЛІЄНТ-ІЛЮСТРАЦІЯ:${ill.index}]` : ""}`).join("\n")}\nОБОВ'ЯЗКОВО для кожної ілюстрації: 1) додай посилання на неї в тексті;${hasIndexRegen ? " 2) безпосередньо ПЕРЕД стандартним підписом рисунка (Рис. X.Y – Назва) додай окремим рядком точно вказаний вище маркер вставки у форматі [КЛІЄНТ-ІЛЮСТРАЦІЯ:N] — без жодних змін, більше нічого на цьому рядку." : ""} Використовуй нумерацію X.Y відповідно до номера підрозділу.`
        : "";
      instruction = `Перепиши підрозділ "${sec.label}" для ${d.type} на тему "${d.topic}". Галузь: ${d.subject}.
${empiricalBlockRegen}${econBlockRegen}${technicalBlockRegen}
${clientReqsRegen ? `ВИМОГИ КЛІЄНТА (ОБОВ'ЯЗКОВО виконати):\n${clientReqsRegen}\n` : ""}Обсяг: приблизно ${Math.round((sec.pages || 1) * 230)} слів (~${sec.pages} стор.).
Не обривай текст. Завершуй підсумковим абзацом. Без посилань. Без жирного.
ЗАБОРОНЕНО вставляти будь-які внутрішні підназви, заголовки абзаців або окремі рядки-мітки. Кожен рядок тексту — повне речення, рядок таблиці або підпис до таблиці/рисунка.${customInstructions}${illBlockRegen}${clientMaterialsBlockRegen}`;
    }
    const regenMaxTokens = Math.min(60000, Math.max(8000, Math.round((sec.pages || 1) * 3000)));
    try {
      const raw = await callClaude(buildRegenMessages(instruction), null, buildSYS(lang, methodInfo, normalizeWorkType(d.type, d.course), getStyleProfileForSection(sec)), regenMaxTokens);
      const result = typographQuotes(stripStrayCJK(fixMixedScript(raw, lang)
        .replace(/ — /g, ", ").replace(/— /g, " ").replace(/ —/g, " "), lang), lang)
        .replace(/(\[[^\]]*)\]\s*\[([^\]]*\])/g, "$1; $2")
        .replace(/(\[[^\]]*)\]\s*\[([^\]]*\])/g, "$1; $2");
      let cappedResult = capCitationRepeats(result);
      cappedResult = dedupeRepeatedFigures(cappedResult, lang);
      try {
        cappedResult = await fixDanglingFigures({ text: cappedResult, lang, callClaude });
      } catch (e) { console.error("fixDanglingFigures:", e.message); }
      const newContent = { ...contentRef.current, [sec.id]: cappedResult };
      setContent(newContent);
      setRegenId(null); setRegenPrompt("");
      await saveToFirestore({ content: newContent });
    } catch (e) { console.error(e); }
    setRegenLoading(false);
  };

  // ── Перефразувати наявний текст секції, щоб знизити плагіат (не генерація з нуля) ──
  const reduceSectionPlagiarismText = async (text, lang, signal) => {
    const approxWords = text.trim().split(/\s+/).length;
    const maxTokens = Math.min(60000, Math.max(4000, Math.round((approxWords / 230) * 3000)));
    const raw = await callClaude(
      [{ role: "user", content: text }],
      signal,
      buildAntiPlagiarismSYS(lang),
      maxTokens
    );
    return typographQuotes(fixMixedScript(raw, lang)
      .replace(/ — /g, ", ").replace(/— /g, " ").replace(/ —/g, " "), lang)
      .replace(/(\[[^\]]*)\]\s*\[([^\]]*\])/g, "$1; $2")
      .replace(/(\[[^\]]*)\]\s*\[([^\]]*\])/g, "$1; $2");
  };

  // ── Зменшити плагіат в одній секції ──
  const doReducePlagiarism = async (sec) => {
    const originalText = contentRef.current[sec.id] || "";
    if (!originalText.trim()) return;
    setPlagLoading(true);
    setPlagId(sec.id);
    setApiError("");
    try {
      const lang = info?.language || "Українська";
      const result = await reduceSectionPlagiarismText(originalText, lang);
      const newContent = { ...contentRef.current, [sec.id]: result };
      setContent(newContent);
      setPlagId(null);
      await saveToFirestore({ content: newContent });
    } catch (e) {
      console.error(e);
      setApiError(e.message);
    }
    setPlagLoading(false);
  };

  // ── Зменшити плагіат по всій роботі (послідовно, з можливістю зупинити) ──
  const doReducePlagiarismAll = async () => {
    if (!window.confirm("Перефразувати всі секції для зниження плагіату? Поточний текст буде замінено.")) return;
    const ctrl = new AbortController();
    plagAllAbortRef.current = ctrl;
    setPlagAllLoading(true);
    setApiError("");

    const lang = info?.language || "Українська";
    const secsToProcess = sections.filter(s => s.type !== "sources" && contentRef.current[s.id]);

    for (let i = 0; i < secsToProcess.length; i++) {
      if (ctrl.signal.aborted) break;
      const sec = secsToProcess[i];
      setPlagAllMsg(`Зменшую плагіат (${i + 1}/${secsToProcess.length}): ${sec.label}...`);
      try {
        const result = await reduceSectionPlagiarismText(contentRef.current[sec.id], lang, ctrl.signal);
        const newContent = { ...contentRef.current, [sec.id]: result };
        setContent(newContent);
        await saveToFirestore({ content: newContent });
      } catch (e) {
        if (e.name === "AbortError") break;
        console.error(e);
        setApiError(e.message);
        break;
      }
    }

    setPlagAllMsg("");
    setPlagAllLoading(false);
  };

  // ── Зменшити ШІ-детекцію по всій роботі одним викликом (документ бачить
  // себе цілком, на відміну від "Зменшити плагіат", що йде по секціях окремо) ──
  const doReduceAiDetectionAll = async () => {
    if (!window.confirm("Переписати весь текст одним проходом для зниження ШІ-детекції? Поточний текст буде замінено.")) return;
    const ctrl = new AbortController();
    aiDetectAllAbortRef.current = ctrl;
    setAiDetectAllLoading(true);
    setApiError("");
    resetGenerationCost();

    try {
      const lang = info?.language || "Українська";
      const secsToProcess = sections.filter(s => s.type !== "sources" && contentRef.current[s.id]);
      if (!secsToProcess.length) { setAiDetectAllLoading(false); return; }

      const combined = secsToProcess.map(s => `[[[SEC:${s.id}]]]\n${contentRef.current[s.id]}`).join("\n\n");
      const totalPages = secsToProcess.reduce((sum, s) => sum + (s.pages || 1), 0);
      const maxTokens = Math.min(60000, Math.max(8000, Math.round(totalPages * 3000)));

      setAiDetectAllMsg("Переписую весь текст для зниження ШІ-детекції...");
      const raw = await callClaude(
        [{ role: "user", content: combined }],
        ctrl.signal,
        buildAntiDetectionSYS(lang),
        maxTokens
      );

      const parts = raw.split(/\[\[\[SEC:([^\]]+)\]\]\]/);
      const resultById = {};
      for (let i = 1; i < parts.length; i += 2) {
        resultById[parts[i]] = parts[i + 1]?.trim() || "";
      }
      const missing = secsToProcess.filter(s => !resultById[s.id]);
      if (missing.length) throw new Error(`Модель не повернула частину секцій (${missing.map(s => s.label).join(", ")}) — текст не змінено.`);

      const newContent = { ...contentRef.current };
      for (const sec of secsToProcess) {
        newContent[sec.id] = typographQuotes(fixMixedScript(resultById[sec.id], lang)
          .replace(/ — /g, ", ").replace(/— /g, " ").replace(/ —/g, " "), lang)
          .replace(/(\[[^\]]*)\]\s*\[([^\]]*\])/g, "$1; $2")
          .replace(/(\[[^\]]*)\]\s*\[([^\]]*\])/g, "$1; $2");
      }
      setContent(newContent);
      await saveToFirestore({ content: newContent });
    } catch (e) {
      if (e.name !== "AbortError") { console.error(e); setApiError(e.message); }
    }
    setAiDetectAllMsg("");
    setAiDetectAllLoading(false);
  };

  // ── Текст доповіді (без міток слайдів) — джерело істини для змісту презентації ──
  const generateSpeechText = async () => {
    const lang = info?.language || "Українська";

    const sectionSummaries = sections
      .filter(s => s.type !== "sources")
      .map(s => { const txt = content[s.id] || ""; return txt ? `### ${s.label}\n${txt}` : ""; })
      .filter(Boolean).join("\n\n");

    const prompt = `Напиши текст доповіді для захисту ${info?.type || "наукової роботи"} перед науковою комісією на тему "${info?.topic}".

ПОВНИЙ ТЕКСТ РОБОТИ (витягуй звідси конкретні факти, методи, результати, числа):
${sectionSummaries}

ВИМОГИ:
- Обсяг: 9-12 хвилин (4-5 сторінок)
- Структура: вступ → актуальність → мета і завдання → методи → результати → висновки → завершення
- Стиль: стриманий академічний усний. Науковець звітує перед комісією
- ОБОВ'ЯЗКОВО: конкретні назви методів, числа, відсотки, коефіцієнти, розміри вибірки з роботи
- ЗАБОРОНЕНО: "тема є актуальною", "у роботі розглядається", "варто відмітити", "слід зазначити"
- Кожне речення — факт, метод, результат або висновок
- БЕЗ міток "Слайд N" — суцільний академічний текст
- НЕ виводь назви розділів та їх номери (наприклад "Розділ 1.2")
- Мова: ${lang}
- Без markdown, зірочок, жирного`;

    const raw = await callGemini(
      [{ role: "user", content: prompt }], null,
      `You are an expert academic writing assistant. Write a substantive, factual oral defense speech for a scientific committee. Every sentence must state a concrete fact, method, result or conclusion — no filler phrases. No markdown formatting.`, 6000,
      null, "gemini-2.5-flash"
    );

    return typographQuotes(stripStrayCJK(raw
      .split("\n")
      .filter(line => {
        const t = line.trim();
        if (!t) return true;
        if (/^\d+(\.\d+)+[\s\.]/.test(t)) return false;
        if (/^(ВСТУП|ВИСНОВКИ|РОЗДІЛ|ЗМІСТ|ДОДАТКИ?|СПИСОК\s+ЛІТЕРАТУРИ)$/i.test(t)) return false;
        if (/^#{1,6}\s/.test(t)) return false;
        return true;
      })
      .join("\n"), lang), lang)
      .replace(/\*\*(.+?)\*\*/g, "$1").replace(/\*(.+?)\*/g, "$1");
  };

  const generateSpeech = async () => {
    setSpeechLoading(true);
    try {
      const result = await generateSpeechText();
      setSpeechText(result);
      await saveToFirestore({ speechText: result });
    } catch (e) { alert("Помилка генерації доповіді: " + e.message); }
    setSpeechLoading(false);
  };

  // ── Прибрати мітки "Слайд N" з тексту доповіді (щоб не дублювати при повторній розмітці) ──
  const stripSlideLabels = (text) => (text || "")
    .split("\n")
    .filter(line => !/^Слайд\s+\d+\s*$/i.test(line.trim()))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  // ── Розмітка готового тексту доповіді мітками "Слайд N" відповідно до структури презентації ──
  const labelSpeechWithSlides = async (plainSpeechText, slideData) => {
    const lang = info?.language || "Українська";
    const LAYOUT_LABEL = {
      hero: "Титульний/фінальний", two_column: "Два стовпці", stat_callout: "Статистика",
      icon_list: "Список з іконками", highlight_box: "Виділені пункти", numbered_steps: "Кроки",
    };
    const slidesOutline = slideData.slides
      .map((sl, i) => {
        const label = LAYOUT_LABEL[sl.layout] || sl.layout;
        const parts = [`Слайд ${i + 1} [${label}]: ${sl.title || ""}`];
        if (sl.subtitle) parts.push(`  Підзаголовок: ${sl.subtitle}`);
        if (sl.left) parts.push(`  Ліво: ${sl.left}`);
        if (sl.right) parts.push(`  Право: ${sl.right}`);
        if (sl.right_value) parts.push(`  Ключове число: ${sl.right_value} — ${sl.right_label || ""}`);
        if (sl.content) parts.push(`  Текст: ${sl.content}`);
        if (sl.accent) parts.push(`  Акцент: ${sl.accent}`);
        if (sl.visual?.stats?.length) parts.push(`  Статистика: ${sl.visual.stats.map(s => `${s.value} (${s.label})`).join(", ")}`);
        if (sl.visual?.items?.length) parts.push(`  Пункти: ${sl.visual.items.map(it => typeof it === "object" ? `${it.header || ""}: ${it.text || ""}` : it).join(" | ")}`);
        if (sl.points?.length) parts.push(`  Пункти: ${sl.points.join(" | ")}`);
        if (sl.steps?.length) parts.push(`  Кроки: ${sl.steps.map(st => `${st.num}. ${st.title} — ${st.text}`).join(" | ")}`);
        return parts.join("\n");
      })
      .join("\n\n");

    const prompt = `Розклади наведений нижче ГОТОВИЙ текст доповіді по слайдах презентації — встав мітку "Слайд N" окремим рядком перед фрагментом, який відповідає цьому слайду.

ГОТОВИЙ ТЕКСТ ДОПОВІДІ (використай ДОСЛІВНО — НЕ редагуй, НЕ перефразовуй, НЕ скорочуй і НЕ додавай нових речень, лише розбий його на фрагменти):
${plainSpeechText.trim()}

СТРУКТУРА ПРЕЗЕНТАЦІЇ (${slideData.slides.length} слайдів, виступ має йти паралельно з ними):
${slidesOutline}

ВИМОГИ:
- Розбий наведений текст доповіді на фрагменти — по одному на кожен слайд (або групу суміжних слайдів, якщо для окремого слайду немає відповідного фрагменту) — і встав перед кожним мітку "Слайд N" окремим рядком
- Збережи дослівний текст і його послідовність — це лише розмітка наявного тексту, а не новий текст
- Мова: ${lang}
- Без markdown, зірочок, жирного — тільки мітки "Слайд N" і незмінний текст доповіді`;

    const raw = await callGemini(
      [{ role: "user", content: prompt }], null,
      "You only segment and label the given text into slide-aligned fragments — you must not rewrite, paraphrase, shorten or add anything to it.", 5000,
      null, "gemini-2.5-flash"
    );

    return raw
      .split("\n")
      .filter(line => {
        const t = line.trim();
        if (!t) return true;
        if (/^Слайд\s+\d+/i.test(t)) return true;
        if (/^#{1,6}\s/.test(t)) return false;
        return true;
      })
      .join("\n")
      .replace(/\*\*(.+?)\*\*/g, "$1").replace(/\*(.+?)\*/g, "$1");
  };

  // ── Фіксований базовий профіль підприємства для економічних/фінансових робіт ──
  // Генерується один раз перед написанням, щоб усі економічні підрозділи спирались
  // на ту саму назву підприємства, галузь і базові показники, а не вигадували нові.
  const doGenEconProfile = async () => {
    setEconProfileLoading(true);
    let result = "";
    try {
      const order = { info, methodInfo, clientMaterialsSummary, clientMaterialsText, titlePage, titlePageLines };
      const patch = await runEconProfileStage(order, { callClaude });
      result = patch.econProfile || "";
      setEconProfile(result);
      if (patch.companyWebsite) setCompanyWebsite(patch.companyWebsite);
      if (patch.titlePage !== undefined) setTitlePage(patch.titlePage);
      if (patch.titlePageLines !== undefined) setTitlePageLines(patch.titlePageLines);
      await saveToFirestore(patch);
    } catch (e) {
      console.warn("econ profile generation failed:", e.message);
    }
    setEconProfileLoading(false);
    return result;
  };

  // ── Додаток А — делеговано в src/lib/orderStages.js (runAppendicesStage,
  // runFillAppendixDataStage), ті самі функції, що й серверний воркер. ──
  const buildAppendicesOrder = () => ({
    info, methodInfo, commentAnalysis, sections, content: contentRef.current,
    clientMaterialsSummary, clientMaterialsText, econProfile, appendicesCustomPrompt,
    clientMaterials, appendicesText,
  });

  const doGenAppendices = async (econProfileOverride, finishedBodyTextOverride) => {
    setAppendicesLoading(true);
    try {
      const patch = await runAppendicesStage(buildAppendicesOrder(), { callClaude }, { econProfileOverride, finishedBodyTextOverride });
      setAppendicesText(patch.appendicesText);
      await saveToFirestore({ appendicesText: patch.appendicesText });
    } catch (e) { alert("Помилка генерації додатків: " + e.message); }
    setAppendicesLoading(false);
  };

  // ── Автозаповнення полів додатків, позначених маркером, коли основний текст роботи вже готовий ──
  const doFillAppendixData = async () => {
    if (appendixFillDoneRef.current) return;
    if (!appendicesText || !appendicesText.includes(APPENDIX_FILL_MARKER)) return;
    appendixFillDoneRef.current = true;
    setAppendicesLoading(true);
    const patch = await runFillAppendixDataStage(buildAppendicesOrder(), { callClaude });
    if (patch.appendicesText) {
      setAppendicesText(patch.appendicesText);
      await saveToFirestore({ appendicesText: patch.appendicesText });
    }
    setAppendicesLoading(false);
  };


  const generatePresentation = async () => {
    setPresentationLoading(true);
    setPresentationMsg("Готую доповідь...");
    try {
      const lang = info?.language || "Українська";

      // ── Крок 0: Доповідь — джерело істини для змісту слайдів (генеруємо, якщо її ще немає) ──
      let baseSpeech = stripSlideLabels(speechText);
      if (!baseSpeech) {
        setPresentationMsg("Генерую доповідь...");
        baseSpeech = await generateSpeechText();
        setSpeechText(baseSpeech);
        await saveToFirestore({ speechText: baseSpeech });
      }

      setPresentationMsg("Аналізую текст роботи...");
      // ── Крок 1: Gemini аналізує текст ──
      const fullText = sections
        .filter(s => s.type !== "sources")
        .map(s => { const txt = content[s.id] || ""; return txt ? `### ${s.label}\n${txt}` : ""; })
        .filter(Boolean).join("\n\n");

      const geminiPrompt = `Проаналізуй наукову роботу та витягни всі дані для презентації захисту. Поверни ТІЛЬКИ валідний JSON без markdown:
{
  "student_info": {
    "student": "ПІБ студента (з титульної сторінки або null)",
    "supervisor": "ПІБ наукового керівника (або null)",
    "institution": "Коротка назва навчального закладу (або null)"
  },
  "relevance": "Чому ця тема актуальна, яку проблему вирішує (2-3 речення)",
  "object": "Об'єкт дослідження (точно як у роботі)",
  "subject": "Предмет дослідження (точно як у роботі)",
  "goal": "Мета дослідження (точно як у роботі)",
  "tasks": ["завдання 1", "завдання 2", "завдання 3"],
  "hypothesis": "Гіпотеза (якщо є у вступі, інакше null)",
  "methods": [
    {"name": "Назва методу", "description": "1 речення опису"}
  ],
  "main_results": [
    {
      "title": "Назва блоку результату",
      "points": ["конкретний результат 1", "результат 2"],
      "key_stat": {"value": "87%", "label": "точність моделі"}
    }
  ],
  "conclusions": ["висновок 1", "висновок 2", "висновок 3"],
  "practical_value": "Де і як можна застосувати результати (або null)",
  "novelty": "Наукова новизна (або null)",
  "field": "tech | medicine | social | economics | default"
}

ПРАВИЛА:
- student_info: шукай рядки "ПІБ студента", "Виконав", "Науковий керівник", назву закладу — на початку тексту
- main_results: 3-5 блоків з конкретними знахідками. Числа/відсотки → key_stat. Без числа → key_stat: null
- tasks: рівно стільки, скільки перелічено у вступі роботи
- Мова: ${lang}

ТИТУЛЬНА СТОРІНКА:
${titlePage ? titlePage.substring(0, 800) : "(не надана)"}

ТЕКСТ РОБОТИ:
${fullText}

ТЕКСТ ДОПОВІДІ ДЛЯ ЗАХИСТУ (ОБОВ'ЯЗКОВО — масиви "tasks", "methods", "main_results", "conclusions" мають збігатися з тим, що перелічено в доповіді: ТА Ж кількість елементів, нічого не пропускай і не додавай зайвого, аби виступ і слайди презентації не розходились):
${baseSpeech}`;

      const geminiRaw = await callGemini(
        [{ role: "user", content: geminiPrompt }], null,
        SYS_JSON_SHORT, 5000,
        (s) => setPresentationMsg(`Аналізую... зачекайте ${s}с`), "gemini-2.5-flash"
      );

      let analysis;
      try {
        analysis = JSON.parse(geminiRaw.replace(/```json\n?|\n?```/g, "").trim());
      } catch { throw new Error("Gemini повернув некоректний JSON аналізу"); }

      // ── Крок 2: Claude генерує зміст слайдів ──
      setPresentationMsg("Генерую слайди...");

      const themeMap = { tech: "midnight", medicine: "forest", social: "coral", economics: "slate" };
      const defaultTheme = themeMap[analysis.field] || "warm";

      const hasHypothesis = !!analysis.hypothesis;
      const hasPractical = !!(analysis.practical_value || analysis.novelty);
      const resultsCount = Math.min(Math.max((analysis.main_results || []).length, 3), 5);
      let slideN = 0;
      const next = () => ++slideN;

      const slideSpecs = [];
      slideSpecs.push(`Слайд ${next()}: layout "title_slide"
  title: ${JSON.stringify(info?.topic || "")}
  work_type: ${JSON.stringify(info?.type || "Наукова робота")}
  student: ${JSON.stringify(analysis.student_info?.student || null)}
  supervisor: ${JSON.stringify(analysis.student_info?.supervisor || null)}
  institution: ${JSON.stringify(analysis.student_info?.institution || null)}
  year: ${new Date().getFullYear()}`);

      slideSpecs.push(`Слайд ${next()}: layout "two_column" — title: "Актуальність"
  left: 2-3 речення чому тема важлива (з analysis.relevance)
  right_type: "text", right: яку конкретну проблему вирішує`);

      slideSpecs.push(`Слайд ${next()}: layout "two_column" — title: "Об'єкт і предмет дослідження"
  left: "Об'єкт дослідження:\\n${(analysis.object || "").replace(/"/g, "'")}"
  right_type: "text", right: "Предмет дослідження:\\n${(analysis.subject || "").replace(/"/g, "'")}"`);

      slideSpecs.push(`Слайд ${next()}: layout "icon_list" — title: "Мета та завдання"
  visual.items: [{icon:"🎯",header:"Мета",text:${JSON.stringify(analysis.goal || "")}}, потім по одному item на кожне завдання {icon:"→",header:"Завдання N",text:...}]
  Максимум 5 items загалом`);

      if (hasHypothesis) {
        slideSpecs.push(`Слайд ${next()}: layout "highlight_box" — title: "Гіпотеза дослідження"
  points: [${JSON.stringify(analysis.hypothesis)}]
  accent: "Перевіряється в ході дослідження"`);
      }

      slideSpecs.push(`Слайд ${next()}: layout "numbered_steps" — title: "Методи дослідження"
  visual.items: до 4 методів з analysis.methods → [{"num":"1","title":"назва","text":"1 речення"}]`);
      const methodsSlideIdx = slideSpecs.length - 1;

      (analysis.main_results || []).slice(0, resultsCount).forEach((res, i) => {
        const hasStat = res.key_stat?.value;
        const layout = hasStat ? "stat_callout" : "highlight_box";
        slideSpecs.push(`Слайд ${next()}: layout "${layout}" — title: ${JSON.stringify(res.title || `Результати ${i + 1}`)}
  ${hasStat
          ? `visual.stats: [{"value":${JSON.stringify(res.key_stat.value)},"label":${JSON.stringify(res.key_stat.label || "")}}]\n  content: ${JSON.stringify((res.points || []).slice(0, 2).join(". "))}`
          : `points: [${(res.points || []).map(p => JSON.stringify(p)).join(", ")}]`}`);
      });

      slideSpecs.push(`Слайд ${next()}: layout "icon_list" — title: "Висновки"
  visual.items: до 5 висновків з analysis.conclusions → [{"icon":"✅","header":"Висновок N","text":"..."}]`);

      if (hasPractical) {
        slideSpecs.push(`Слайд ${next()}: layout "two_column" — title: "Практичне значення та наукова новизна"
  left: ${JSON.stringify(analysis.practical_value || "Практичне застосування результатів")}
  right_type: "text", right: ${JSON.stringify(analysis.novelty || "Сфери впровадження")}`);
      }

      slideSpecs.push(`Слайд ${next()}: layout "hero" — title: "Дякую за увагу!", subtitle: ""`);
      const totalSlides = slideN;

      const claudePrompt = `Згенеруй JSON для презентації захисту ${info?.type || "наукової роботи"}.

АНАЛІЗ РОБОТИ (від Gemini):
${JSON.stringify(analysis, null, 2)}

СПЕЦИФІКАЦІЯ — рівно ${totalSlides} слайдів:
${slideSpecs.join("\n\n")}

ПРАВИЛА JSON:
- Мова всіх текстів: ${lang}
- title_slide: поля title, work_type, student, supervisor, institution, year (null якщо невідомо)
- icon_list items: [{"icon":"...","header":"...","text":"..."}]
- numbered_steps items: [{"num":"...","title":"...","text":"..."}]
- stat_callout: {title, visual:{stats:[{value,label}]}, content}
- two_column: {title, left, right_type, right} або right_value/right_label для stat
- highlight_box: {title, points:[], accent} (accent — короткий підсумковий текст для виділеного блоку внизу слайду; пиши реальний зміст або залиш null; НІКОЛИ не пиши назви кольорів)
- hero: {title, subtitle}
- Числа та % з аналізу — обов'язково включай
- НІКОЛИ не додавай номер замовлення, ID або технічні ідентифікатори у текст будь-якого слайду
- НЕ додавай зайвих слайдів, рівно ${totalSlides}
- КАТЕГОРИЧНО ЗАБОРОНЕНО додавати будь-яке застереження/дисклеймер про використання штучного інтелекту, ШІ, AI чи подібних інструментів — ні окремим слайдом, ні рядком у контенті

Поверни ТІЛЬКИ валідний JSON без markdown:
{"theme":"${defaultTheme}","slides":[...рівно ${totalSlides} об'єктів...]}`;

      const claudeRaw = await callClaude(
        [{ role: "user", content: claudePrompt }], null,
        SYS_JSON_SHORT, 6000,
        (s) => setPresentationMsg(`Генерую слайди... зачекайте ${s}с`), MODEL_FAST
      );

      let slideData;
      try {
        slideData = JSON.parse(stripEmDash(claudeRaw.replace(/```json\n?|\n?```/g, "").trim()));
      } catch { throw new Error("Claude повернув некоректний JSON слайдів"); }

      // ── Вставляємо реальні ілюстрації з роботи (якщо студент їх завантажив) одразу після слайду з методами ──
      if (illustrations.length > 0 && Array.isArray(slideData.slides)) {
        const imageSlides = illustrations.map((ill, i) => ({
          layout: "image_placeholder",
          title: ill.caption || `Ілюстрація ${i + 1}`,
          image: { b64: ill.b64, type: ill.type },
        }));
        slideData.slides.splice(methodsSlideIdx + 1, 0, ...imageSlides);
      }
      // ── Фото з інтернету, знайдені для рисунків роботи, — теж окремими слайдами, одразу після
      // ілюстрацій клієнта. У слайді лише посилання на фото (webImageKey): base64 у slideJson
      // переповнив би документ замовлення, фото підставляє resolveSlideWebImages перед експортом ──
      const webSlides = buildWebImageSlides(webImageFigs, webImg.webImages);
      if (webSlides.length && Array.isArray(slideData.slides)) {
        slideData.slides.splice(methodsSlideIdx + 1 + illustrations.length, 0, ...webSlides);
      }

      // ── Крок 3: Створюємо PPTX ──
      setPresentationMsg("Створюю файл...");
      await exportToPptxFile(resolveSlideWebImages(slideData, webImg.webImages), info);

      setSlideJson(slideData);
      setPresentationReady(true);
      await saveToFirestore({ presentationReady: true, slideJson: slideData });

      // ── Крок 4: Розмічаємо доповідь мітками "Слайд N" відповідно до готових слайдів ──
      setPresentationMsg("Узгоджую доповідь зі слайдами...");
      try {
        const labeled = await labelSpeechWithSlides(baseSpeech, slideData);
        setSpeechText(labeled);
        await saveToFirestore({ speechText: labeled });
      } catch { /* презентація вже готова — лишаємо доповідь без міток, якщо розмітка не вдалась */ }
    } catch (e) { alert("Помилка генерації презентації: " + e.message); }
    setPresentationLoading(false);
    setPresentationMsg("");
  };

  const stopGen = () => { abortRef.current?.abort(); runningRef.current = false; setRunning(false); setPaused(true); setLoadMsg(""); };
  const resumeGen = () => { setApiError(""); setPaused(false); };

  // ── Готова частина роботи клієнта: ручний аналіз через ШІ ──
  // Викликається кнопкою на етапі плану, коли код-розпізнавання заголовків не впоралось
  // (нестандартне оформлення документа клієнта) — не автоматично, щоб не витрачати токени наосліп.
  const doAIAnalyzeReadyWork = async () => {
    if (!readyWorkText?.trim()) return;
    setPlanLoading(true); setLoadMsg("Аналізую готову частину роботи через ШІ...");
    try {
      const prompt = buildExtractStructurePrompt({ documentText: readyWorkText });
      const approxWords = readyWorkText.trim().split(/\s+/).length;
      const maxTokens = Math.min(60000, Math.max(16000, Math.round((approxWords / 230) * 3000)));
      const raw = await callClaude([{ role: "user", content: prompt }], null, null, maxTokens, null, MODEL);
      const blockRe = /@@@SECTION id="([^"]+)" title="([^"]*)" chapterTitle="([^"]*)" type="([^"]+)"@@@([\s\S]*?)@@@SOURCES@@@([\s\S]*?)@@@END@@@/g;
      const extractedSecs = [];
      const extractedContent = {};
      const extractedCitInputs = {};
      const extractedIds = [];
      let m;
      while ((m = blockRe.exec(raw))) {
        const [, id, title, chapterTitle, type, textPart, sourcesPart] = m;
        const text = textPart.trim();
        if (!text) continue;
        const words = text.split(/\s+/).length;
        const pages = Math.max(1, Math.round(words / 230));
        extractedSecs.push({ id, label: title?.trim() || id, ...(chapterTitle?.trim() ? { sectionTitle: chapterTitle.trim() } : {}), pages, type: type || "theory" });
        extractedContent[id] = text;
        extractedIds.push(id);
        const sources = sourcesPart.split("\n").map(s => s.trim()).filter(Boolean);
        if (sources.length) extractedCitInputs[id] = sources.join("\n");
      }
      if (extractedSecs.length <= 3) {
        alert("ШІ теж не зміг впевнено розпізнати структуру документа. Спробуйте вписати план вручну.");
        return;
      }
      // Далі — та сама логіка продовження, що й після розбору кодом (runPlanStage): дописувані
      // розділи за планом клієнта / writeScope, обсяг лише під текст розділів, спільний список джерел
      const patch = await runPlanStage({
        info: infoRef.current, methodInfo, commentAnalysis, comment, clientPlan,
        clientMaterialsSummary, clientMaterialsText, readyWorkText,
        content: contentRef.current, citInputs, illustrations, illustrationsPdf,
        readyWorkPreExtracted: { sections: extractedSecs, content: extractedContent, citInputs: extractedCitInputs, foundIds: extractedIds },
      }, { callClaude, callGemini, onProgress: setLoadMsg });
      setSections(patch.sections);
      setPlanDisplay(patch.planDisplay);
      setSourceDist(patch.sourceDist || {}); setSourceTotal(patch.sourceTotal || 0);
      setContent(patch.content);
      contentRef.current = patch.content;
      setCitInputs(patch.citInputs);
      setReadyWorkImportedIds(patch.readyWorkImportedIds);
      setReadyWorkNeedsManualAI(false);
      await saveToFirestore({
        sections: patch.sections, planDisplay: patch.planDisplay,
        content: patch.content, citInputs: patch.citInputs,
        readyWorkImportedIds: patch.readyWorkImportedIds, stage: "plan", status: "plan_ready",
      });
    } catch (e) {
      console.error("ШІ-аналіз готової частини роботи:", e);
      alert("Не вдалося розібрати готову частину роботи клієнта: " + e.message);
    }
    setPlanLoading(false); setLoadMsg("");
  };

  // ── Переписати всю роботу з нуля (з урахуванням вже згенерованого контексту) ──
  const doRegenAll = async () => {
    if (!window.confirm("Переписати всю роботу повністю з нуля? Поточний текст буде замінено новим.")) return;
    const ctrl = new AbortController();
    regenAllAbortRef.current = ctrl;
    setRegenAllLoading(true);
    setApiError("");
    resetGenerationCost();

    const d = info;
    const lang = d?.language || "Українська";
    const totalPages = parsePagesAvg(d?.pages);
    const isLarge = totalPages > 40;
    const secsToRegen = sections.filter(s => s.type !== "sources");
    const empSecs = getEmpiricalSections(sections, d, commentAnalysis, methodInfo);
    const empIdsSet = new Set(empSecs.chapterSectionIds);

    // Будуємо multi-turn повідомлення для doRegenAll
    const buildRegenAllMessages = (excludeId, instruction) => {
      const otherEntries = sections
        .filter(s => s.id !== excludeId && contentRef.current[s.id] && s.type !== "sources")
        .map(s => [s.id, contentRef.current[s.id]]);
      if (!otherEntries.length) return [{ role: "user", content: instruction }];
      const contextText = otherEntries.map(([k, v]) => {
        const s = sections.find(x => x.id === k);
        return `=== ${s?.label || k} ===\n${v}`;
      }).join("\n\n---\n\n");
      return [
        { role: "user", content: "Ось вже написані частини цієї роботи:" },
        { role: "assistant", content: contextText },
        { role: "user", content: instruction },
      ];
    };

    for (let i = 0; i < secsToRegen.length; i++) {
      if (ctrl.signal.aborted) break;
      const sec = secsToRegen[i];
      setLoadMsg(`Переписую (${i + 1}/${secsToRegen.length}): ${sec.label}...`);

      const approxParas = Math.max(3, Math.round((sec.pages || 1) * 3.5));
      let instruction = "";

      if (sec.type === "intro") {
        const mainSecs = sections.filter(s => !["intro", "conclusions", "sources", "chapter_conclusion"].includes(s.type));
        const tasksProfile = getIntroTasksProfile(d.type, d.course, mainSecs.length, isLarge);
        const tasksCount = tasksProfile.count;
        const lc = getLangLabels(lang);
        const il = lc.introLabels || {};
        const defaultComponents = lc.defaultIntroComponents || ["актуальність теми", "мета дослідження", "завдання дослідження", "об'єкт дослідження", "предмет дослідження", "методи дослідження", "структура роботи"];
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
            return `${label}: starts with "${phrase}" — do NOT split into multiple paragraphs`;
          }
          if (/теоретико|теоретичн.*основ|методологічн.*основ|theoretical.*basis|podstawy.*teor/i.test(comp)) {
            const phrase = il.theoryBasis || "Теоретико-методологічну основу дослідження становлять";
            return `${label}: starts with "${phrase}" — authors, works, regulatory acts`;
          }
          if ((/мета|goal|cel\b|ziel|objetivo|cíl|účel/i.test(comp)) && !/завдання|task|zadani|aufgab/i.test(comp)) {
            const phrase = il.goal || "Метою роботи є";
            return `${label}: starts with "${phrase}"`;
          }
          if (/завдання|tasks|zadania|aufgaben|tareas|úkoly/i.test(comp)) {
            const phrase = il.tasks || "Для досягнення мети поставлено такі завдання:";
            const natureLine = tasksProfile.nature ? ` Завдання мають бути ${tasksProfile.nature}.` : "";
            return `${label}: starts with "${phrase}" — exactly ${tasksCount} numbered tasks.${natureLine} ${INTRO_TASKS_MERGE_SPLIT_RULE}\nСтруктура плану роботи (змістова основа для завдань):\n${mainSecs.map((s, j) => `  ${j + 1}) "${s.label}"`).join("\n")}`;
          }
          if (/об.єкт|object|przedmiot\s+bad|gegenstand|objeto\s+de/i.test(comp)) {
            const phrase = il.object || "Об'єктом дослідження є";
            return `${label}: starts with "${phrase}"`;
          }
          if (/предмет|subject|obiekt\s+bad|subjekt|sujeto/i.test(comp)) {
            const phrase = il.subject || "Предметом дослідження є";
            return `${label}: starts with "${phrase}"`;
          }
          if ((/метод|methods|metody|methoden|métodos/i.test(comp)) && !/теоретико|методологічн.*основ|teoretyczn|podstawy/i.test(comp)) {
            const phrase = il.methods || "Для вирішення поставлених завдань використано такі методи:";
            return `${label}: starts with "${phrase}"`;
          }
          if (/новизн|novelty|nowość|neuheit|novedad/i.test(comp)) {
            const phrase = il.novelty || "Наукова новизна дослідження полягає в тому, що";
            return `${label}: starts with "${phrase}"`;
          }
          if (/практичн|practical|praktyczn|praktisch|práctico/i.test(comp)) {
            const phrase = il.practical || "Практична значущість одержаних результатів полягає в тому, що";
            return `${label}: starts with "${phrase}"`;
          }
          if (/апробац|approbation|aprobacja/i.test(comp)) {
            const phrase = il.approbation || "Апробація результатів дослідження здійснювалась";
            return `${label}: starts with "${phrase}"`;
          }
          if (structureRe.test(comp)) {
            const phrase = il.structure || "Робота складається з вступу,";
            const chapCount = new Set(mainSecs.map(s => s.id.split(".")[0])).size || mainSecs.length;
            return `${label}: write EXACTLY one sentence following this template (translate it into the language of the work, keep the same structure), with NOTHING else added — no chapter-by-chapter description: "${phrase} ${chapCount} chapters, conclusions, and a list of used sources."`;
          }
          return `${label}`;
        });
        instruction = `Write the INTRODUCTION for ${d.type} on the topic "${d.topic}". Field: ${d.subject}.
INTRO STRUCTURE (strictly, each element as a new paragraph):
${componentLines.map((l, idx) => `${idx + 1}. ${l}`).join("\n")}
${methodInfo?.otherRequirements ? `\nMETHOD REQUIREMENTS: ${methodInfo.otherRequirements}` : ""}
Use the written chapters (provided in context) for precise formulation of sample, methods, results — everything must match.
Do NOT bold anything. Do NOT add citations. Write as continuous prose paragraphs.`;

      } else if (sec.type === "conclusions") {
        const mainSecsForConcl = sections.filter(s => !["intro", "conclusions", "sources", "chapter_conclusion"].includes(s.type));
        const conclTasksProfile = getIntroTasksProfile(d.type, d.course, mainSecsForConcl.length, isLarge);
        instruction = `Напиши ВИСНОВКИ для ${d.type} на тему "${d.topic}".
${methodInfo?.conclusionsRequirements ? `ВИМОГИ МЕТОДИЧКИ: ${methodInfo.conclusionsRequirements}\n` : ""}
Перший абзац — загальний підсумок мети і досягнутого. Далі — рівно ${conclTasksProfile.count} абзаців, по одному на кожне завдання дослідження, сформульоване у вступі (текст вступу є в контексті), у тому самому порядку; якщо завдання поєднувало кілька підрозділів — зведи результати в одному абзаці, якщо було розбите з одного підрозділу — розподіли на відповідну кількість абзаців. Останній абзац — перспективи подальших досліджень.
Абзаци-результати мають мати різний ритм і різні відкривачі речень, не всі підряд у форматі "Аналіз... засвідчив, що..." — чергуй з прямим твердженням, конкретним фактом, розгортанням попередньої думки. Висновки мають звучати іншим голосом, ніж вступ, а не дзеркалити його ритм.
Без посилань. Без жирного. Без нумерації. Суцільними абзацами.
Спирайся на весь написаний текст роботи, включно з формулюваннями завдань у вступі (є в контексті).`;

      } else if (sec.type === "chapter_conclusion") {
        const chapNum = sec.chapterNum || sec.id.split(".")[0];
        instruction = `Напиши "Висновки до розділу ${chapNum}" для ${d.type} на тему "${d.topic}".
${methodInfo?.chapterConclusionRequirements ? `ВИМОГИ МЕТОДИЧКИ: ${methodInfo.chapterConclusionRequirements}` : ""}
Обсяг: 120–150 слів (не більше). Без нової інформації. Без посилань. Без жирного. Без нумерації. Суцільними абзацами.
Спирайся на повний текст підрозділів розділу ${chapNum} (є в контексті).`;

      } else {
        const typeHints = {
          theory: "теоретичний — визначення понять, аналіз літератури, огляд наукових підходів",
          analysis: "аналітично-практичний — аналіз даних, виявлення закономірностей, порівняння",
          recommendations: "рекомендаційний — практичні пропозиції, шляхи вирішення, прогнози",
        };
        const methodReq = methodInfo?.theoryRequirements && sec.type === "theory"
          ? methodInfo.theoryRequirements
          : (methodInfo?.analysisRequirements && ["analysis", "recommendations"].includes(sec.type) ? methodInfo.analysisRequirements : methodInfo?.otherRequirements || "");
        const isEmpChapter = empIdsSet.has(sec.id);
        const empiricalBlock = isEmpChapter ? `\n\nКОНТЕКСТ: цей підрозділ є частиною емпіричного дослідження. Визнач за назвою що писати:
- організація/методика дослідження: опиши вибірку, метод, структуру анкети. Додай: "Анкета наведена у Додатку А."
- аналіз/результати: таблиця markdown з відсотковими показниками, аналіз, висновки
- рекомендації: спирайся на результати попередніх підрозділів, не повторюй опис анкети` : "";

        instruction = `Напиши підрозділ "${sec.label}" для ${d.type} на тему "${d.topic}". Галузь: ${d.subject}.
Тип: ${typeHints[sec.type] || "основний"}.
${methodReq ? `ВИМОГИ МЕТОДИЧКИ: ${methodReq}` : ""}${empiricalBlock}

Обсяг: приблизно ${Math.round((sec.pages || 1) * 230)} слів (~${sec.pages} стор.).
Не обривай текст. Завершуй підсумковим абзацом. Без посилань [1],[2]. Без жирного.
ЗАБОРОНЕНО вставляти будь-які внутрішні підназви, заголовки абзаців або окремі рядки-мітки. Кожен рядок тексту — повне речення, рядок таблиці або підпис до таблиці/рисунка.
Абзаци різняться за довжиною: чергуй короткі (2-3 речення) з довшими (5-7 речень).`;
      }

      const sectionMaxTokens = Math.min(60000, Math.max(8000, Math.round((sec.pages || 1) * 3000)));
      try {
        const raw = await callClaude(buildRegenAllMessages(sec.id, instruction), ctrl.signal, buildSYS(lang, methodInfo, normalizeWorkType(d.type, d.course), getStyleProfileForSection(sec)), sectionMaxTokens, null, MODEL);
        const result = typographQuotes(stripStrayCJK(fixMixedScript(raw, lang)
          .replace(/ — /g, ", ").replace(/— /g, " ").replace(/ —/g, " "), lang), lang);
        let cappedResult = capCitationRepeats(result);
        cappedResult = dedupeRepeatedFigures(cappedResult, lang);
        if (!ctrl.signal.aborted) {
          try {
            cappedResult = await fixDanglingFigures({ text: cappedResult, lang, callClaude, signal: ctrl.signal });
          } catch (e) { console.error("fixDanglingFigures:", e.message); }
        }
        const newContent = { ...contentRef.current, [sec.id]: cappedResult };
        setContent(newContent);
        await saveToFirestore({ content: newContent });
        await new Promise(r => setTimeout(r, 2000));
      } catch (e) {
        if (e.name === "AbortError") break;
        console.error(e);
        setApiError(e.message);
        setLoadMsg("⚠ " + e.message);
        break;
      }
    }

    regenAllAbortRef.current = null;
    setRegenAllLoading(false);
    setLoadMsg("");
  };

  // ── Спільна генерація нових тез+фраз для підрозділу через Gemini — використовується і кнопкою
  // «регенерувати» (doRegenSectionSources), і автоескалацією при нестачі джерел (doSearchSources) ──
  const regenerateThesesAndPhrases = async (secId, sectionLabel) => {
    const txt = content[secId]
      ? `\n${content[secId].substring(0, 1200).replace(/["\\]/g, " ").replace(/\n+/g, " ")}`
      : "";
    const domainCtx = [info?.direction, info?.subject].filter(Boolean).join(', ');
    const commentCtx = [commentAnalysis?.planHints, commentAnalysis?.writingHints].filter(Boolean).join(' ').slice(0, 400);
    const methodCtx = [methodInfo?.otherRequirements, methodInfo?.theoryRequirements, methodInfo?.analysisRequirements].filter(Boolean).join(' ').slice(0, 400);
    const secBlock = `### ${sectionLabel} (потрібно ${sourceDist[secId] || 3} джерела)${txt}`;
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

    const res = await fetch("/api/gemini", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await getProxyAuthHeaders()) },
      body: JSON.stringify({
        _model: "gemini-2.5-flash-lite",
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          maxOutputTokens: 1200,
          responseMimeType: "application/json",
          responseSchema: {
            type: "object",
            properties: {
              theses: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    thesis: { type: "string" },
                    phrases: { type: "array", items: { type: "string" } },
                  },
                  required: ["thesis", "phrases"],
                },
              },
              enPhrases: { type: "array", items: { type: "string" } },
              localPhrases: { type: "array", items: { type: "string" } },
            },
            required: ["theses"],
          },
        },
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || JSON.stringify(data).slice(0, 200));
    if (data.usageMetadata) {
      const cost = (data.usageMetadata.promptTokenCount * 0.10 + data.usageMetadata.candidatesTokenCount * 0.40) / 1_000_000;
      window.dispatchEvent(new CustomEvent("apicost", { detail: { cost, model: "gemini-2.5-flash-lite", inTok: data.usageMetadata.promptTokenCount, outTok: data.usageMetadata.candidatesTokenCount } }));
    }
    const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
    const parsed = JSON.parse(raw);
    const theses = (Array.isArray(parsed.theses) ? parsed.theses : [])
      .map(t => ({
        thesis: String(t.thesis || '').trim(),
        phrases: (Array.isArray(t.phrases) ? t.phrases : []).map(String).filter(Boolean),
      }))
      .filter(t => t.phrases.length > 0);
    const enPhrases = (Array.isArray(parsed.enPhrases) ? parsed.enPhrases : []).map(String).filter(Boolean);
    const localPhrases = (Array.isArray(parsed.localPhrases) ? parsed.localPhrases : []).map(String).filter(Boolean);
    return { theses, enPhrases, localPhrases };
  };

  // Виконує async-задачі з обмеженим паралелізмом (пул), а не одну за одною —
  // використовується для пошуку джерел по фразах підрозділу.
  const runWithConcurrency = async (items, limit, worker, stopRef = null) => {
    let cursor = 0;
    const runNext = async () => {
      while (cursor < items.length) {
        if (stopRef?.current) return;
        const item = items[cursor++];
        await worker(item);
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runNext));
  };

  // ── Автоматичний пошук джерел ──
  // crossSectionSeen — спільний Set назв (title-key), що переноситься між послідовними
  // викликами для різних підрозділів (напр. з doGenKeywords), щоб те саме джерело не
  // пропонувалось і не забиралось у два підрозділи одразу.
  const doSearchSources = async (secId, thesesData, sectionLabel = '', resetPage = false, anchors = [], enPhrases = [], crossSectionSeen = null, localPhrases = []) => {
    stopSearchRef.current = false;
    const isFirstSearch = resetPage || (searchPageCount[secId] || 0) === 0;
    // Для econ-аналітичних підрозділів додаємо офіційну статистику (Держстат/НБУ/Мінфін/World Bank)
    // як нагадування-посилання, поряд зі знайденими науковими статтями
    const isEconSecForSources = isEcon(info) && getEconSections(sections, info).includes(secId);
    const isTechnicalWork = isTechnical(info);
    const institutionalGroup = (isFirstSearch && isEconSecForSources)
      ? [{ phrase: "Офіційна статистика", papers: getEconInstitutionalSources() }]
      : [];
    // Офіційний сайт підприємства — у той самий підрозділ, де методичка вимагає
    // характеристику конкретного підприємства (isFirstAnalysisSubsection у
    // runWritingSection/orderStages.js), і лише якщо companyWebsite вже визначено
    // кодом (doGenEconProfile → companyWebsite.js), а не ШІ.
    const firstAnalysisSecId = sections.find(s => ["analysis", "recommendations"].includes(s.type))?.id;
    const isFirstAnalysisSubsection = !!methodInfo?.requiresEnterpriseProfile && firstAnalysisSecId === secId;
    const companyWebsiteGroup = (isFirstSearch && isFirstAnalysisSubsection && companyWebsite)
      ? [{ phrase: "Офіційний сайт підприємства", papers: [buildCompanyWebsiteSource(companyWebsite, extractCompanyNameFromProfile(econProfile))] }]
      : [];
    if (isFirstSearch) {
      setSuggestedSources(prev => ({ ...prev, [secId]: [...institutionalGroup, ...companyWebsiteGroup].flatMap(g => g.papers) }));
      setPhraseGroups(prev => ({ ...prev, [secId]: [...institutionalGroup, ...companyWebsiteGroup] }));
      setSeenSourceKeys(prev => ({ ...prev, [secId]: new Set() }));
    }
    setSourcesSearchLoading(prev => ({ ...prev, [secId]: true }));
    setSourcesSearchError(prev => ({ ...prev, [secId]: null }));
    const nextCount = resetPage ? 1 : (searchPageCount[secId] || 0) + 1;
    setSearchPageCount(prev => ({ ...prev, [secId]: nextCount }));
    const page = nextCount;
    try {
      const topicCtx = [info?.topic, info?.direction, info?.subject].filter(Boolean).join(' ');
      const globalSeen = new Set(isFirstSearch ? [] : (seenSourceKeys[secId] || []));
      if (crossSectionSeen) crossSectionSeen.forEach(k => globalSeen.add(k));
      const updatedGroups = isFirstSearch ? [...institutionalGroup, ...companyWebsiteGroup] : [...(phraseGroups[secId] || [])];

      // Для розділів без підрозділів label містить "РОЗДІЛ N. НАЗВА РОЗДІЛУ" —
      // обрізаємо структурний префікс щоб Gemini-фільтр орієнтувався на зміст, а не на "напрями удосконалення"
      const filterLabel = sectionLabel
        .replace(/^РОЗДІЛ\s+[IVXivxІVХ\d]+[.\s:]+/i, '')
        .trim() || sectionLabel;

      // Нормалізація: підтримка як [{thesis, phrases}], так і старого плоского рядкового масиву
      const normalizedTheses = Array.isArray(thesesData) && thesesData.length > 0 && typeof thesesData[0] === 'string'
        ? [{ thesis: '', phrases: thesesData }]
        : [...(thesesData || [])]; // копія — нижче можемо доштовхнути anchors, не чіпаючи параметр виклику
      // Якірні фрази від Gemini (searchAnchors) — раніше генерувались і одразу викидались;
      // тепер це ще один "псевдо-тезовий" раунд пошуку, без прив'язки до конкретної тези
      if (isFirstSearch && anchors.length) {
        normalizedTheses.push({ thesis: '', phrases: anchors });
      }
      const nextEnPhrase = (i) => enPhrases.length ? enPhrases[i % enPhrases.length] : '';
      // Робота неукраїнською: пошук ще й мовою роботи (localPhrases) і зарубіжні кандидати впереміш
      // з українськими — той самий phraseSearchOpts, що й у воркері (orderStages.js)
      const searchOpts = (i, lp = localPhrases) => phraseSearchOpts(info?.language, lp, i);

      // Фрази (з усіх тез підрозділу разом) обробляються пулом із обмеженим паралелізмом,
      // а не одна за одною — це основний виграш у швидкості пошуку джерел. Дедуп за globalSeen
      // робиться ДВІЧІ: до фільтрації Gemini (щоб не витрачати виклик на явний дубль) і ще раз
      // синхронно прямо перед мерджем у updatedGroups (та точка не переривається await, тож
      // безпечна навіть коли кілька фраз завершуються "одночасно" і могли знайти те саме джерело).
      const phraseTasks = [];
      for (const { thesis, phrases } of normalizedTheses) {
        (phrases || []).forEach((phrase, pi) => phraseTasks.push({ thesis, phrase, pi }));
      }
      const processPhrase = async ({ thesis, phrase, pi }) => {
        if (stopSearchRef.current) return;
        const useScholar = pi === 0 || isTechnicalWork; // Scholar тільки для першої фрази тези; для технічних робіт — на кожній
        const candidates = await searchByPhrase(phrase, 15, page, useScholar, 0, nextEnPhrase(pi), searchOpts(pi));
        if (stopSearchRef.current) return;
        const fresh = candidates.filter(p => {
          const key = (p.title || '').toLowerCase().slice(0, 60);
          return key && !globalSeen.has(key);
        });
        if (!fresh.length) return;

        const top15raw = await filterSourcesWithGemini(fresh.slice(0, 25), filterLabel, topicCtx, 20, thesis);
        if (stopSearchRef.current) return;
        // Тегуємо тезою, під яку джерело шукалось — щоб при примусовій довставці цитати
        // (insertMissingCitations) можна було звірити зміст джерела САМЕ з цією тезою,
        // а не тільки з назвою підрозділу в цілому, і, якщо не підійде, шукати заміну; а
        // також щоб автовставка (SourcesStage.jsx buildTop) могла розподілити джерела
        // рівномірно по тезах, а не просто взяти топ-N за оцінкою.
        const top15tagged = thesis ? top15raw.map(p => ({ ...p, sourceThesis: thesis })) : top15raw;
        // Автозбагачення метаданих (DOI/сторінки/видавництво) + гейт повноти — до вставки
        // в suggestedSources, щоб автовставка вже бачила, чого реально бракує.
        const top15enriched = await enrichSources(top15tagged);

        const top15 = top15enriched.filter(p => {
          const key = (p.title || '').toLowerCase().slice(0, 60);
          return key && !globalSeen.has(key);
        });
        if (!top15.length) return;
        top15.forEach(p => {
          const key = (p.title || '').toLowerCase().slice(0, 60);
          globalSeen.add(key);
          crossSectionSeen?.add(key);
        });

        const existingIdx = updatedGroups.findIndex(g => g.phrase === phrase);
        if (existingIdx >= 0) {
          updatedGroups[existingIdx] = {
            phrase,
            papers: [...updatedGroups[existingIdx].papers, ...top15],
          };
        } else {
          updatedGroups.push({ phrase, papers: top15 });
        }

        // Прогресивне оновлення — щойно готова фраза відображається одразу
        setPhraseGroups(prev => ({ ...prev, [secId]: [...updatedGroups] }));
        setSuggestedSources(prev => ({ ...prev, [secId]: updatedGroups.flatMap(g => g.papers) }));
      };
      await runWithConcurrency(phraseTasks, 4, processPhrase, stopSearchRef);

      // ── Добір при нестачі: спершу закриваємо тези, які лишились БЕЗ жодного підтвердженого
      // джерела (а не просто нарощуємо загальну кількість там, де вже й так є надлишок),
      // потім — розширюємо діапазон років (+2, потім +3, потім +8 — як «ширший період»),
      // потім — альтернативні фрази ──
      if (!stopSearchRef.current) {
        const needed = sourceDist[secId] || 3;
        // Джерело рахується "добрим" лише якщо пройшло Прохід А+Б (score≥70) І гейт повноти
        // (_complete !== false — undefined тут означає інституційне джерело, завжди добре).
        const isGood = (p, min) => (p.geminiScore ?? 0) >= min && p._complete !== false;
        const countAtScore = (min) => updatedGroups.flatMap(g => g.papers).filter(p => isGood(p, min)).length;
        const countGood = () => countAtScore(70);
        const countForThesis = (t) => updatedGroups.flatMap(g => g.papers).filter(p => p.sourceThesis === t && isGood(p, 70)).length;
        const stillShort = () => !stopSearchRef.current && countGood() < needed;
        let triedPhrases = normalizedTheses.flatMap(t => t.phrases || []);

        const backfillPhrase = async (phrase, extraYears, enPhrase = '', thesisText = '', opts = {}) => {
          // Scholar тут (на відміну від першого проходу) увімкнено завжди: ми вже точно знаємо,
          // що інших джерел бракує, а Scholar — найкраще джерело саме для вузьких/локальних тем
          const candidates = await searchByPhrase(phrase, 15, page, true, extraYears, enPhrase, opts);
          const fresh = candidates.filter(p => {
            const key = (p.title || '').toLowerCase().slice(0, 60);
            return key && !globalSeen.has(key);
          });
          if (!fresh.length) return;
          const filteredRaw = await filterSourcesWithGemini(fresh.slice(0, 25), filterLabel, topicCtx, 20, thesisText);
          const filteredTagged = thesisText ? filteredRaw.map(p => ({ ...p, sourceThesis: thesisText })) : filteredRaw;
          const filtered = await enrichSources(filteredTagged);
          filtered.forEach(p => globalSeen.add((p.title || '').toLowerCase().slice(0, 60)));
          const existingIdx = updatedGroups.findIndex(g => g.phrase === phrase);
          if (existingIdx >= 0) {
            updatedGroups[existingIdx] = { phrase, papers: [...updatedGroups[existingIdx].papers, ...filtered] };
          } else {
            updatedGroups.push({ phrase, papers: filtered });
          }
          setPhraseGroups(prev => ({ ...prev, [secId]: [...updatedGroups] }));
          setSuggestedSources(prev => ({ ...prev, [secId]: updatedGroups.flatMap(g => g.papers) }));
        };

        // Пріоритетний раунд: тези, що лишились зовсім без підтвердженого джерела,
        // закриваємо першими — власними фразами тієї самої тези з розширеним діапазоном років.
        const uncoveredTheses = normalizedTheses.filter(t => t.thesis && countForThesis(t.thesis) === 0);
        for (const t of uncoveredTheses) {
          if (stopSearchRef.current || countForThesis(t.thesis) > 0) continue;
          for (let i = 0; i < (t.phrases || []).length; i++) {
            if (stopSearchRef.current || countForThesis(t.thesis) > 0) break;
            await backfillPhrase(t.phrases[i], 2, nextEnPhrase(i), t.thesis, searchOpts(i));
          }
        }

        for (const extraYears of [2, 3, 8]) {
          if (stopSearchRef.current || countGood() >= needed) break;
          for (let i = 0; i < triedPhrases.length; i++) {
            if (stopSearchRef.current || countGood() >= needed) break;
            await backfillPhrase(triedPhrases[i], extraYears, nextEnPhrase(i), '', searchOpts(i));
          }
        }

        // Альтернативні (синонімічні) пошукові фрази — до 3 раундів; кожен наступний
        // раунд враховує всі раніше спробувані фрази, щоб Gemini не повторював варіанти.
        const maxAltRounds = 3;
        for (let round = 0; round < maxAltRounds && stillShort() && triedPhrases.length; round++) {
          const altPhrases = await generateAlternatePhrases(topicCtx, filterLabel, triedPhrases);
          if (!altPhrases.length) break;
          triedPhrases = [...triedPhrases, ...altPhrases];
          for (let i = 0; i < altPhrases.length; i++) {
            if (!stillShort()) break;
            await backfillPhrase(altPhrases[i], 3, nextEnPhrase(i), '', searchOpts(i));
          }
        }

        // Остання автоматична спроба — повна регенерація тез підрозділу (та сама логіка,
        // що й за кнопкою «регенерувати»), перш ніж лишити користувачу попередження про нестачу.
        if (stillShort()) {
          try {
            const { theses: regenTheses, enPhrases: regenEnPhrases, localPhrases: regenLocalPhrases } = await regenerateThesesAndPhrases(secId, sectionLabel);
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

      setSeenSourceKeys(prev => ({ ...prev, [secId]: globalSeen }));
      // Явне збереження після завершення пошуку по секції — не залежить від дебаунс-таймерів
      if (updatedGroups.length > 0) {
        const finalSuggested = { ...suggestedSources, [secId]: updatedGroups.flatMap(g => g.papers) };
        const finalGroups = { ...phraseGroups, [secId]: updatedGroups };
        saveToFirestore({ suggestedSources: finalSuggested, phraseGroups: finalGroups, keywords, searchAnchors, enKeywords, localKeywords });
      }
    } catch (e) {
      console.error('Source search error:', e.message);
      setSourcesSearchError(prev => ({ ...prev, [secId]: e.message }));
    }
    setSourcesSearchLoading(prev => ({ ...prev, [secId]: false }));
  };

  // ── Заміна джерела, яке хірургічна вставка (insertMissingCitations) чесно визнала
  // (Пошук заміни непідтвердженого джерела для генерації підрозділу тепер
  // живе в src/lib/orderStages.js — retryUnmatchedSource усередині
  // runWritingSection; тут більше не дублюється.)

  // ── Ключові слова ──
  const doGenKeywords = async () => {
    setKwLoading(true);
    stopSearchRef.current = false;
    // Розділи, вже імпортовані з готової частини роботи клієнта, мають реальні джерела з документа — не шукаємо для них додатково
    const mainSecs = sectionsRef.current.filter(s => !["intro", "conclusions", "sources", "chapter_conclusion"].includes(s.type) && !s.headingOnly && !readyWorkImportedIds.includes(s.id));
    const labelToId = {};
    for (const s of mainSecs) {
      labelToId[s.id] = s.id;
      const m = s.label.match(/^(\d+(?:\.\d+)*)/);
      if (m) labelToId[m[1]] = s.id;
    }
    const normalizeKey = (k) => labelToId[k] || k.match(/^(\d+\.\d+)/)?.[1] || k;
    const domainCtx = [info?.direction, info?.subject].filter(Boolean).join(', ');
    const commentCtx = [commentAnalysis?.planHints, commentAnalysis?.writingHints].filter(Boolean).join(' ').slice(0, 400);
    const methodCtx = [methodInfo?.otherRequirements, methodInfo?.theoryRequirements, methodInfo?.analysisRequirements].filter(Boolean).join(' ').slice(0, 400);

    // Батч по 8 секцій — щоб JSON відповідь не обрізалась токенним лімітом
    const BATCH_SIZE = 8;
    const snippetLen = mainSecs.length > 10 ? 600 : 1200;
    const allThesesNorm = {};
    const allAnchorsNorm = {};
    const allEnNorm = {};
    const allLocalNorm = {};

    try {
      for (let bStart = 0; bStart < mainSecs.length; bStart += BATCH_SIZE) {
        if (stopSearchRef.current) break;
        const batch = mainSecs.slice(bStart, bStart + BATCH_SIZE);
        const secBlocks = batch.map(s => {
          const txt = content[s.id]
            ? `\n${content[s.id].substring(0, snippetLen).replace(/["\\]/g, " ").replace(/\n+/g, " ")}`
            : "";
          return `### [${s.id}] ${s.label} (потрібно ${sourceDist[s.id] || 3} джерела)${txt}`;
        }).join("\n\n");

        const prompt = `Ти допомагаєш знайти наукові джерела для академічної роботи на тему "${info?.topic}"${domainCtx ? ` (галузь: ${domainCtx})` : ''}.

ЗАВДАННЯ — для кожного підрозділу:

КРОК 1. Визнач 4–5 конкретних тез — повних змістовних тверджень про те, що саме доводитиметься у цьому підрозділі: який об'єкт/група/явище, в якому аспекті, в якому контексті (країна, період, галузь). Не назва розділу і не загальна категорія, а конкретне твердження (7–14 слів).
Приклад: тема "Форми роботи з реалізації завдань громадянської освіти у початковій школі" → теза "вплив ігрових форм роботи на засвоєння громадянських цінностей учнями 2-4 класів", а НЕ просто "форми роботи" чи "ігрові методи".
Ще приклад: тема "Дистанційна зайнятість в ІТ" → теза "вплив дистанційної роботи на продуктивність працівників ІТ-компаній України", а НЕ просто "дистанційна робота" чи "продуктивність праці".

КРОК 2. Для кожної тези склади 3 пошукові фрази українською:
- 2 КОНКРЕТНІ = [1–2 ключових слова з ТЕМИ роботи] + [конкретний аспект тези] — як точний прицільний пошук.
- 1 ШИРША — РІВНО ДВА ключових поняття із загального предмета тези, не більше (не три і не чотири) — без вузьких власних назв, конкретних імен чи вузькоспеціальних термінів. Що менше понять — то ширше знаходить пошук: перевірено, що фраза з двох понять "філософія та естетика романтизму" знаходить у десятки разів більше, ніж фраза з трьох понять "символізм надприродного в романтизмі" про той самий предмет. Тому: обери два НАЙЗАГАЛЬНІШІ поняття з теми й тези, відкинь решту деталізації.
Приклад: тема "ЕІ підлітки", теза "структура компонентів ЕІ" → конкретні: "компоненти емоційного інтелекту підлітки", "структура ЕІ психологічна модель"; ширша: "емоційний інтелект підлітковий вік".
ВАЖЛИВО: конкретні фрази мають містити точний предмет теми; широка фраза — той самий загальний контекст без надмірної деталізації, не втрачаючи зв'язку з темою.${commentCtx ? `\nПОБАЖАННЯ КЛІЄНТА: ${commentCtx}` : ''}${methodCtx ? `\nВИМОГИ МЕТОДИЧКИ: ${methodCtx}` : ''}

КРОК 3. Додай 3 пошукові фрази АНГЛІЙСЬКОЮ для підрозділу загалом (academic English, ширші за тезу) —
для пошуку в міжнародних англомовних базах (OpenAlex, Semantic Scholar), де є суттєва профільна література.${localPhrasesStep(info?.language)}

ПІДРОЗДІЛИ:
${secBlocks}

Поверни валідний JSON з ${localSourceLangCode(info?.language) ? "чотирма" : "трьома"} полями:
- "theses": об'єкт, ключ = ідентифікатор підрозділу з квадратних дужок ("1.1", "1.2", "3" тощо), значення = масив об'єктів {"thesis": рядок, "phrases": масив рядків}
- "searchAnchors": об'єкт, ключ = ідентифікатор підрозділу з квадратних дужок, значення = масив з 2–3 якірних фраз (рядки)
- "enPhrases": об'єкт, ключ = ідентифікатор підрозділу з квадратних дужок, значення = масив з 3 англомовних фраз (рядки)${localPhrasesJsonFieldBatch(info?.language, "підрозділу")}`;

        const MAX_ATTEMPTS = 3;
        let parsed;
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
          const res = await fetch("/api/gemini", {
            method: "POST",
            headers: { "Content-Type": "application/json", ...(await getProxyAuthHeaders()) },
            body: JSON.stringify({
              _model: "gemini-2.5-flash-lite",
              contents: [{ role: "user", parts: [{ text: prompt }] }],
              generationConfig: { maxOutputTokens: 8192, responseMimeType: "application/json" },
            }),
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error?.message || JSON.stringify(data).slice(0, 200));
          if (data.usageMetadata) {
            const cost = (data.usageMetadata.promptTokenCount * 0.10 + data.usageMetadata.candidatesTokenCount * 0.40) / 1_000_000;
            window.dispatchEvent(new CustomEvent("apicost", { detail: { cost, model: "gemini-2.5-flash-lite", inTok: data.usageMetadata.promptTokenCount, outTok: data.usageMetadata.candidatesTokenCount } }));
          }
          const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
          try {
            parsed = JSON.parse(raw);
            break;
          } catch (e) {
            if (attempt === MAX_ATTEMPTS) throw new Error(`Не вдалося розпарсити відповідь ШІ після ${MAX_ATTEMPTS} спроб: ${e.message}`);
          }
        }
        const thesesRaw = parsed.theses || {};
        const anchorsRaw = parsed.searchAnchors || {};
        const enPhrasesRaw = parsed.enPhrases || {};

        for (const [k, v] of Object.entries(anchorsRaw)) {
          allAnchorsNorm[normalizeKey(k)] = Array.isArray(v) ? v.map(String).filter(Boolean) : [];
        }
        for (const [k, v] of Object.entries(enPhrasesRaw)) {
          allEnNorm[normalizeKey(k)] = Array.isArray(v) ? v.map(String).filter(Boolean) : [];
        }
        for (const [k, v] of Object.entries(parsed.localPhrases || {})) {
          allLocalNorm[normalizeKey(k)] = Array.isArray(v) ? v.map(String).filter(Boolean) : [];
        }
        for (const [k, arr] of Object.entries(thesesRaw)) {
          allThesesNorm[normalizeKey(k)] = (Array.isArray(arr) ? arr : []).map(t => ({
            thesis: String(t.thesis || '').trim(),
            phrases: (Array.isArray(t.phrases) ? t.phrases : []).map(String).filter(Boolean),
          })).filter(t => t.phrases.length > 0);
        }
      }

      setSearchAnchors(allAnchorsNorm);
      setEnKeywords(allEnNorm);
      setLocalKeywords(allLocalNorm);

      const kwNorm = Object.fromEntries(
        Object.entries(allThesesNorm).map(([k, theses]) => [k, theses.flatMap(t => t.phrases)])
      );
      setKeywords(kwNorm);

      const econSecIdsForSources = getEconSections(sectionsRef.current, info);
      // Спільний для всіх підрозділів набір уже забраних назв джерел — щоб те саме
      // джерело не потрапило одразу в кілька підрозділів під час цього пакетного пошуку.
      const crossSectionSeen = new Set();
      for (const s of mainSecs) {
        if (stopSearchRef.current) break;
        const normalKey = normalizeKey(s.id);
        const thesesData = allThesesNorm[normalKey] || allThesesNorm[s.id] || [];
        // Навіть якщо Gemini не повернув тез для econ-підрозділу (обрізаний батч, збій парсингу),
        // офіційна статистика (Держстат/НБУ/Мінфін/World Bank) все одно має з'явитись
        if (thesesData.length || econSecIdsForSources.includes(s.id)) {
          await doSearchSources(s.id, thesesData, s.label || '', false, allAnchorsNorm[normalKey] || [], allEnNorm[normalKey] || [], crossSectionSeen, allLocalNorm[normalKey] || []);
        }
      }
    } catch (e) { console.error(e); setKwError(e.message); }
    setKwLoading(false);
  };

  const doStopSearch = () => { stopSearchRef.current = true; };

  // ── Явне розширення пошуку за роками — на прохання користувача, коли автоматичного
  // каскаду (+2/+3 роки) у doSearchSources не вистачило. Не знижує поріг релевантності —
  // лише пошукову глибину (ще +8 років понад стандартний діапазон). Знайдені підтверджені
  // джерела не вставляються автоматично (у секції вже є частковий вміст) — потрапляють
  // у список пропозицій нижче, користувач сам добирає, що додати.
  const doExpandYearsSection = async (sec) => {
    const secId = sec.id;
    setSourcesSearchLoading(prev => ({ ...prev, [secId]: true }));
    setSourcesSearchError(prev => ({ ...prev, [secId]: null }));
    try {
      const topicCtx = [info?.topic, info?.direction, info?.subject].filter(Boolean).join(' ');
      const filterLabel = (sec.label || '').replace(/^РОЗДІЛ\s+[IVXivxІVХ\d]+[.\s:]+/i, '').trim();
      const phrases = keywords[secId] || [];
      const enPhrasesArr = enKeywords[secId] || [];
      const globalSeen = new Set(seenSourceKeys[secId] || []);
      // Не пропонувати повторно джерела, вже забрані іншими підрозділами
      Object.entries(suggestedSources).forEach(([sid, papers]) => {
        if (sid === secId) return;
        (papers || []).forEach(p => { const k = (p.title || '').toLowerCase().slice(0, 60); if (k) globalSeen.add(k); });
      });
      const updatedGroups = [...(phraseGroups[secId] || [])];
      for (let i = 0; i < phrases.length; i++) {
        if (stopSearchRef.current) break;
        const enPhrase = enPhrasesArr.length ? enPhrasesArr[i % enPhrasesArr.length] : '';
        const candidates = await searchByPhrase(phrases[i], 15, 1, true, 8, enPhrase, phraseSearchOpts(info?.language, localKeywords[secId] || [], i));
        const fresh = candidates.filter(p => {
          const key = (p.title || '').toLowerCase().slice(0, 60);
          return key && !globalSeen.has(key);
        });
        if (!fresh.length) continue;
        const filteredRaw = await filterSourcesWithGemini(fresh.slice(0, 25), filterLabel, topicCtx, 20);
        const filtered = await enrichSources(filteredRaw);
        filtered.forEach(p => globalSeen.add((p.title || '').toLowerCase().slice(0, 60)));
        updatedGroups.push({ phrase: `${phrases[i]} (ширший період)`, papers: filtered });
        setPhraseGroups(prev => ({ ...prev, [secId]: [...updatedGroups] }));
        setSuggestedSources(prev => ({ ...prev, [secId]: updatedGroups.flatMap(g => g.papers) }));
      }
      setSeenSourceKeys(prev => ({ ...prev, [secId]: globalSeen }));
    } catch (e) {
      console.error('doExpandYearsSection error:', e.message);
      setSourcesSearchError(prev => ({ ...prev, [secId]: e.message }));
    }
    setSourcesSearchLoading(prev => ({ ...prev, [secId]: false }));
  };

  // ── Оновлення ключових слів + пошук для одного підрозділу ──
  const doRegenSectionSources = async (sec) => {
    setSourcesSearchLoading(prev => ({ ...prev, [sec.id]: true }));
    setSourcesSearchError(prev => ({ ...prev, [sec.id]: null }));
    try {
      const { theses: newTheses, enPhrases: newEnPhrases, localPhrases: newLocalPhrases } = await regenerateThesesAndPhrases(sec.id, sec.label || '');
      if (newTheses.length) {
        setKeywords(prev => ({ ...prev, [sec.id]: newTheses.flatMap(t => t.phrases) }));
        setEnKeywords(prev => ({ ...prev, [sec.id]: newEnPhrases }));
        setLocalKeywords(prev => ({ ...prev, [sec.id]: newLocalPhrases }));
        // Не пропонувати повторно джерела, вже забрані іншими підрозділами
        const crossSectionSeen = new Set();
        Object.entries(suggestedSources).forEach(([sid, papers]) => {
          if (sid === sec.id) return;
          (papers || []).forEach(p => { const k = (p.title || '').toLowerCase().slice(0, 60); if (k) crossSectionSeen.add(k); });
        });
        await doSearchSources(sec.id, newTheses, sec.label || '', true, searchAnchors[sec.id] || [], newEnPhrases, crossSectionSeen, newLocalPhrases);
      } else {
        setSourcesSearchLoading(prev => ({ ...prev, [sec.id]: false }));
      }
    } catch (e) {
      console.error('doRegenSectionSources error:', e.message);
      setSourcesSearchError(prev => ({ ...prev, [sec.id]: e.message }));
      setSourcesSearchLoading(prev => ({ ...prev, [sec.id]: false }));
    }
  };

  // ── Джерела ──
  const buildGlobalRefList = () => {
    const mainSecs = sections.filter(s => !["intro", "conclusions", "sources", "chapter_conclusion"].includes(s.type));
    const _effectiveOrder = sourcesOrderOverride || methodInfo?.sourcesOrder;
    const isAlphabetical = !_effectiveOrder || _effectiveOrder === "alphabetical";

    // Збираємо всі унікальні джерела з прив'язкою до секцій (за порядком появи).
    // Нечітка дедуплікація (createReferenceDeduper) — та сама логіка, що й у
    // doRemapCitations, щоб прев'ю тут збігалося з фінальним результатом.
    const deduper = createReferenceDeduper();
    const secRefMapRaw = {};
    mainSecs.forEach(sec => {
      const raw = citInputs[sec.id] || "";
      const lines = raw.split("\n").map(l => l.trim()).filter(Boolean);
      secRefMapRaw[sec.id] = lines.map(line => deduper.add(line));
    });
    const rawRefs = deduper.canonicalRefs;

    // Якщо алфавітний порядок — сортуємо і перебудовуємо індекси. Мовні блоки
    // (кирилиця/латиниця) — завжди; закони окремо — лише за явним сигналом методички
    // (detectSourceGrouping), щоб прев'ю тут збігалося з фінальним результатом
    // doRemapCitations.
    let allRefs, indexMap;
    if (isAlphabetical) {
      const _workLang = info?.language || "Українська";
      const { lawFirst: _lawFirst, foreignGroup: _foreignGroup, foreignFirst: _foreignFirst } = detectSourceGrouping({
        sourcesFormatRules: methodInfo?.sourcesFormatRules, sourcesGrouping: methodInfo?.sourcesGrouping,
      });
      const _latinFirst = _foreignFirst ?? getLangLabels(_workLang).code !== "uk";
      const _isLaw = s => _lawFirst && isLawSource(s);
      const langGroup = (s) => {
        if (!_foreignGroup) return 0;
        const isCyrillic = /^[А-ЯҐЄІЇа-яґєії]/i.test(s);
        return _latinFirst ? (isCyrillic ? 1 : 0) : (isCyrillic ? 0 : 1);
      };
      const _groupLocales = _latinFirst ? ["en", "uk"] : ["uk", "en"];
      const sorted = [...rawRefs].sort((a, b) => {
        const lawA = _isLaw(a), lawB = _isLaw(b);
        if (lawA !== lawB) return lawA ? -1 : 1;
        const ga = langGroup(a), gb = langGroup(b);
        if (ga !== gb) return ga - gb;
        return a.localeCompare(b, _groupLocales[ga]);
      });
      indexMap = rawRefs.map(r => sorted.indexOf(r) + 1);
      allRefs = sorted;
    } else {
      allRefs = rawRefs;
      indexMap = rawRefs.map((_, i) => i + 1);
    }

    // Перебудовуємо secRefMap з фінальними номерами
    const secRefMap = {};
    mainSecs.forEach(sec => {
      secRefMap[sec.id] = (secRefMapRaw[sec.id] || []).map(rawIdx => indexMap[rawIdx]);
    });

    return { allRefs, secRefMap };
  };

  const globalRefData = useMemo(() => buildGlobalRefList(), [citInputs, sections, sourcesOrderOverride, methodInfo]); // eslint-disable-line

  const handleCitStyleChange = (style) => {
    setCitStyleOverride(style);
    saveToFirestore({ citStyleOverride: style });
  };
  const handleSourcesOrderChange = (order) => {
    setSourcesOrderOverride(order);
    saveToFirestore({ sourcesOrderOverride: order });
  };
  const handleCitFootnotesChange = (val) => {
    setCitFootnotes(val);
    saveToFirestore({ citFootnotes: val });
  };
  const handlePageByContentChange = (val) => {
    setPageByContent(val);
    saveToFirestore({ pageByContent: val });
  };

  // ── Точкове редагування анотації за коментарем (без повної регенерації) ──
  const doRegenAnnotation = async (comment) => {
    setAnnotationLoading(true);
    try {
      const prompt = buildAnnotationRegenPrompt(annotationUk, annotationEn, comment);
      const raw = await callClaude([{ role: "user", content: prompt }], null, SYS_JSON, 3000, null, MODEL);
      const match = raw.match(/\{[\s\S]*\}/);
      const parsed = JSON.parse(match?.[0] || raw.replace(/```json|```/g, "").trim());
      const newUk = parsed.uk || annotationUk;
      const newEn = parsed.en || annotationEn;
      setAnnotationUk(newUk);
      setAnnotationEn(newEn);
      await saveToFirestore({ annotationUk: newUk, annotationEn: newEn });
    } catch (e) {
      console.error("doRegenAnnotation error:", e);
      alert("Помилка: " + e.message);
    }
    setAnnotationLoading(false);
  };

  // ── sources-first: ремаппінг локальних [N] → глобальні номери + форматування списку ──
  const stopRemap = () => { remapAbortRef.current?.abort(); setRemapLoading(false); };

  // ── Абсолютний мінімум джерел (SOURCES_MIN_TABLE у planUtils.js) — та сама
  // перевірка, що вже блокує headless-воркер (processOrder.js) перед переходом
  // у писання. У браузері такого гейту не було: якщо реальний пошук не
  // дотягував до "needed" по підрозділах, генерація тихо йшла далі з тим, що
  // знайшлось (жовте попередження в SourcesStage лише інформує, не блокує). ──
  const getSourcesShortfall = () => {
    const mainSecs = sections.filter(s => !["intro", "conclusions", "sources", "chapter_conclusion"].includes(s.type));
    const totalGathered = mainSecs.reduce((sum, s) => {
      const text = (citInputs[s.id] || "").trim();
      return sum + (text ? text.split("\n").filter(l => l.trim()).length : 0);
    }, 0);
    const minRequired = buildWorkConfig({ info, methodInfo, commentAnalysis }).sourcesMinRequired;
    const short = mainSecs.length > 0 && !!minRequired && totalGathered < minRequired;
    return { totalGathered, minRequired, short };
  };

  // ── Фінальний крок після написання: перерозподіл цитат, список джерел,
  // перевірка обсягу, анотація — делеговано в src/lib/orderStages.js
  // (runRemapStage), та сама функція, яку викликає й серверний воркер. ──
  const doRemapCitations = async () => {
    const shortfall = getSourcesShortfall();
    if (shortfall.short) {
      alert(`⚠ Джерел зібрано лише ${shortfall.totalGathered} з мінімум ${shortfall.minRequired}, потрібних для такого обсягу роботи. Поверніться на крок «Джерела» й додайте ще — вручну або кнопкою «Знайти джерела автоматично» — перш ніж завершувати.`);
      return;
    }
    setRemapLoading(true);
    resetGenerationCost();
    const ctrl = new AbortController(); remapAbortRef.current = ctrl;
    const order = {
      sections, citInputs, citStructured, methodInfo, commentAnalysis,
      citStyleOverride, sourcesOrderOverride, citFootnotes, pageByContent,
      content: contentRef.current, info, appendicesText, refList, readyWorkImportedIds,
    };
    try {
      const patch = await runRemapStage(order, { callClaude, signal: ctrl.signal });
      if (ctrl.signal.aborted || !patch.stage) { setRemapLoading(false); return; }
      setRefList(patch.refList);
      setContent(patch.content);
      setCitInputsSnapshot(JSON.stringify(citInputs));
      if (patch.annotationUk !== undefined) setAnnotationUk(patch.annotationUk);
      if (patch.annotationEn !== undefined) setAnnotationEn(patch.annotationEn);
      await saveToFirestore({
        content: patch.content, citInputs, citStructured, refList: patch.refList,
        stage: patch.stage, status: patch.status,
        ...(patch.annotationUk !== undefined ? { annotationUk: patch.annotationUk, annotationEn: patch.annotationEn } : {}),
      });
      setRemapLoading(false);
      setStage(patch.stage);
      // Фото для рисунків-заглушок — у фоні, лише раз на замовлення (кнопка .docx чекає на нього)
      if (patch.stage === "done") {
        webImg.searchAll({ content: patch.content, sections, lang: info?.language, topic: info?.topic, skipSectionIds: readyWorkImportedIds, auto: true })
          .catch(e => console.error("webImages:", e.message));
      }
    } catch (e) {
      if (e.name !== "AbortError" && !ctrl.signal.aborted) {
        console.error("doRemapCitations error:", e);
        alert("⚠ " + e.message);
      }
    } finally {
      setRemapLoading(false);
    }
  };


  const copyAll = () => {
    const intro = sections.find(s => s.type === "intro");
    const concs = sections.find(s => s.type === "conclusions");
    const srcs = sections.find(s => s.type === "sources");
    const main = sections.filter(s => !["intro", "conclusions", "sources", "chapter_conclusion"].includes(s.type));
    const order = [intro, ...main, concs, srcs].filter(Boolean);
    const sep = "\n\n" + "─".repeat(60) + "\n\n";
    navigator.clipboard.writeText(order.map(s => content[s.id] ? (s.label + "\n\n" + content[s.id]) : null).filter(Boolean).join(sep));
  };

  const progress = sections.length ? Math.round(Object.keys(content).length / sections.length * 100) : 0;
  const totalPagesNum = info ? parsePagesAvg(info.pages) : 80;

  const displayOrder = useMemo(() => {
    if (!sections.length) return [];
    const intro = sections.find(s => s.type === "intro");
    const concs = sections.find(s => s.type === "conclusions");
    const srcs = sections.find(s => s.type === "sources");
    // Сортуємо за номером розділу/підрозділу — незалежно від фізичного порядку в масиві sections,
    // щоб розділи в експортованому документі завжди йшли за зростанням (1, 2, 3...).
    const main = sections
      .filter(s => !["intro", "conclusions", "sources", "chapter_conclusion"].includes(s.type))
      .slice()
      .sort((a, b) => {
        const [aChap, aSub] = a.id.split(".").map(Number);
        const [bChap, bSub] = b.id.split(".").map(Number);
        if (aChap !== bChap) return aChap - bChap;
        return (aSub || 0) - (bSub || 0);
      });
    const ordered = [];
    for (let i = 0; i < main.length; i++) {
      ordered.push(main[i]);
      const chap = main[i].id.split(".")[0];
      const nextChap = main[i + 1]?.id.split(".")[0];
      if (chap !== nextChap) {
        const chapConc = sections.find(s => s.type === "chapter_conclusion" && s.id === `${chap}.conclusions`);
        if (chapConc) ordered.push(chapConc);
      }
    }
    return [intro, ...ordered, concs, srcs].filter(Boolean);
  }, [sections]);

  const mainSections = useMemo(() => sections.filter(s => !["intro", "conclusions", "sources", "chapter_conclusion"].includes(s.type)), [sections]);

  const webImageFigs = useMemo(() => stage === "done"
    ? findPlaceholderFigures({ content, sections, lang: info?.language, skipSectionIds: readyWorkImportedIds })
    : [], [stage, content, sections, info?.language, readyWorkImportedIds]);
  const searchAllWebImages = () => webImg.searchAll({ content: contentRef.current, sections, lang: info?.language, topic: info?.topic, skipSectionIds: readyWorkImportedIds })
    .catch(e => console.error("webImages:", e.message));
  const searchOneWebImage = (fig) => webImg.searchOne(fig, { lang: info?.language, topic: info?.topic });

  const resetAll = () => {
    setStage("input"); setTplText(""); setComment(""); setClientPlan("");
    setFileLabel(""); setFileB64(null); setFileType(null); setInfo(null);
    setSections([]); setPlanDisplay(""); setContent({}); setGlossary({}); setGenIdx(0);
    setPaused(false); setPlanLoading(false); setMethodInfo(null); setCommentAnalysis(null); setSourceDist({}); setSourceTotal(0);
    setKeywords({}); setCitInputs({}); setAllCitLoading(false); setRefList([]); setCitInputsSnapshot(null); setFigureRefs({}); setFigureKeywords([]); setFigKwLoading(false);
    setSpeechText(""); setAppendicesText(""); setEconProfile(""); setCompanyWebsite("");
    setAnnotationUk(""); setAnnotationEn(""); setAnnotationLoading(false);
    setPresentationReady(false); setPresentationMsg(""); setSlideJson(null);
    webImg.reset();
    runningRef.current = false; setRunning(false);
    autoModeRef.current = false; setAutoRunning(false); setAutoError(null); setAutoStepLabel("");
  };

  // ── Автоматичний режим (тест): один клік проганяє Дані→Перевірка→План→Джерела→Написання
  // без ручних воріт. Написання→Готово вже автоматичне (useEffect на stage==="writing"), тож
  // оркестратор лише доводить до setStage("writing") і далі стежить за завершенням/помилками. ──
  const tick = (ms = 80) => new Promise(r => setTimeout(r, ms));

  const stopAutoWithError = (step, kind, message) => {
    autoModeRef.current = false;
    setAutoRunning(false);
    setAutoError({ step, kind, message });
  };

  const runAutoPipeline = async () => {
    setAutoRunning(true); autoModeRef.current = true; setAutoError(null);

    // КРОК 1 — аналіз шаблону
    setAutoStepLabel(AUTO_STEPS.analyze);
    let newInfo;
    try {
      newInfo = await doAnalyze();
    } catch (e) {
      stopAutoWithError(AUTO_STEPS.analyze, "api", e.message); return;
    }
    if (!autoModeRef.current) return;
    await tick();
    const missingInfo = [];
    if (!newInfo?.type) missingInfo.push("тип роботи");
    if (!newInfo?.subject && !newInfo?.direction) missingInfo.push("спеціальність/напрям");
    if (!newInfo?.topic) missingInfo.push("тема");
    if (missingInfo.length) {
      stopAutoWithError(AUTO_STEPS.analyze, "missing", `Не вдалося визначити: ${missingInfo.join(", ")}. Уточніть вручну на кроці «Перевірка» і продовжте звичайним флоу.`);
      return;
    }

    // КРОК 2 — план
    setAutoStepLabel(AUTO_STEPS.plan);
    try {
      await doGenPlan();
    } catch (e) {
      stopAutoWithError(AUTO_STEPS.plan, "api", e.message); return;
    }
    if (!autoModeRef.current) return;
    await tick();
    if (!sectionsRef.current?.length) {
      stopAutoWithError(AUTO_STEPS.plan, "missing", "Не вдалося згенерувати структуру роботи (план вийшов порожнім). Перевірте вручну на кроці «План».");
      return;
    }

    // КРОК 3 — джерела (автопідбір з розширенням пошуку вже вбудований у doGenKeywords/doSearchSources)
    setAutoStepLabel(AUTO_STEPS.sources);
    setKwError("");
    startGen();
    await tick();
    try {
      await doGenKeywords();
    } catch (e) {
      stopAutoWithError(AUTO_STEPS.sources, "api", e.message); return;
    }
    if (!autoModeRef.current) return;
    await tick();
    if (kwErrorRef.current) {
      stopAutoWithError(AUTO_STEPS.sources, "api", kwErrorRef.current); return;
    }

    // Чекаємо поки завершиться пошук і автовставка релевантних джерел (ефект у SourcesStage) добіжить до кінця
    const searchStart = Date.now();
    while (Object.values(sourcesSearchLoadingRef.current || {}).some(Boolean)) {
      if (Date.now() - searchStart > 60000) break;
      await tick(400);
    }
    await tick(4000); // час на довставку (DOI/сторінки/Google Books) усередині SourcesStage
    if (!autoModeRef.current) return;

    const mainSecsForCheck = (sectionsRef.current || []).filter(s =>
      !["intro", "conclusions", "sources", "chapter_conclusion"].includes(s.type) && !s.headingOnly &&
      !(readyWorkImportedIdsRef.current || []).includes(s.id)
    );
    const shortSecs = mainSecsForCheck.filter(s => !(citInputsRef.current[s.id] || "").trim());
    if (shortSecs.length) {
      stopAutoWithError(
        AUTO_STEPS.sources, "missing",
        `Не знайдено достатньо релевантних джерел для: ${shortSecs.map(s => s.label).join(", ")}. Додайте джерела вручну на кроці «Джерела» й продовжте звичайним флоу.`
      );
      return;
    }
    const totalGathered = mainSecsForCheck.reduce((sum, s) => {
      const text = (citInputsRef.current[s.id] || "").trim();
      return sum + (text ? text.split("\n").filter(l => l.trim()).length : 0);
    }, 0);
    const minRequired = buildWorkConfig({ info: infoRef.current, methodInfo: methodInfoRef.current, commentAnalysis: commentAnalysisRef.current }).sourcesMinRequired;
    if (mainSecsForCheck.length && minRequired && totalGathered < minRequired) {
      stopAutoWithError(
        AUTO_STEPS.sources, "missing",
        `Джерел зібрано лише ${totalGathered} з мінімум ${minRequired}, потрібних для такого обсягу роботи. Додайте ще на кроці «Джерела» й продовжте звичайним флоу.`
      );
      return;
    }

    // КРОК 4 — написання (далі повністю автоматичний наявний конвеєр: writing → doRemapCitations → done)
    setAutoStepLabel(AUTO_STEPS.writing);
    setStage("writing");
  };

  // Завершення автопрогону на "Готово", або зупинка з показом помилки, якщо наявний конвеєр
  // сам поставив paused+apiError під час написання (rate limit, вичерпаний баланс тощо).
  useEffect(() => {
    if (!autoRunning) return;
    if (stage === "done") {
      autoModeRef.current = false;
      setAutoRunning(false);
      return;
    }
    if (stage === "writing" && paused && apiError) {
      autoModeRef.current = false;
      setAutoRunning(false);
      setAutoError({ step: AUTO_STEPS.writing, kind: "api", message: apiError });
    }
  }, [autoRunning, stage, paused, apiError]);

  const stopAutoPipeline = () => {
    autoModeRef.current = false;
    setAutoRunning(false);
    if (stage === "writing") stopGen();
    if (kwLoading) doStopSearch();
  };

  if (dbLoading) return (
    <div style={{ minHeight: "100vh", background: "#f5f2eb", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'Spectral',serif" }}>
      <div style={{ textAlign: "center" }}>
        <SpinDot /><div style={{ fontSize: 14, color: "#888", marginTop: 12 }}>Завантаження замовлення...</div>
      </div>
    </div>
  );

  return (
    <div style={{ minHeight: "100vh", background: "#f5f2eb", fontFamily: "'Spectral',Georgia,serif", color: "#1a1a14" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Spectral:ital,wght@0,400;0,600;1,400&family=Spectral+SC:wght@600&display=swap');
        *{box-sizing:border-box;margin:0;padding:0}
        ::-webkit-scrollbar{width:5px}::-webkit-scrollbar-track{background:#ede9e0}::-webkit-scrollbar-thumb{background:#bbb4a0;border-radius:3px}
        @keyframes fd{from{opacity:0;transform:translateY(7px)}to{opacity:1;transform:translateY(0)}}
        @keyframes pl{0%,100%{opacity:1}50%{opacity:.3}}
        @keyframes spin{to{transform:rotate(360deg)}}
        @keyframes shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}
        .fade{animation:fd .35s ease}
        button:not(:disabled):active{transform:scale(.98)}
        .sec-row:hover{background:#edeadf!important}
        textarea:focus,input:focus{outline:none;border-color:#aaa49a}
        .sidebar-panel{transition:width .28s cubic-bezier(.4,0,.2,1),opacity .2s ease}
        .sidebar-tab:hover{background:#2a2a1a!important}
        .sidebar-field-row{display:grid;grid-template-columns:110px 1fr;border-bottom:1px solid #2a2a20;font-size:12px}
        .sidebar-field-row:last-child{border-bottom:none}
      `}</style>

      {/* Header */}
      <div style={{ position: "sticky", top: 0, zIndex: 100, background: "#1a1a14" }}>
        {/* Full header */}
        {headerOpen && (
          <div style={{ color: "#f5f2eb", padding: "15px 32px", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            {onBack && (
              <button onClick={handleBack} style={{ background: "transparent", border: "1px solid #555", color: "#aaa", borderRadius: 6, padding: "5px 14px", cursor: "pointer", fontFamily: "inherit", fontSize: 12, marginRight: 4 }}>
                ← Замовлення
              </button>
            )}
            <div style={{ fontFamily: "'Spectral SC',serif", fontSize: 19, letterSpacing: 5, color: "#e8ff47", flexShrink: 0 }}>ACADEM</div>
            <div style={{ fontFamily: "'Spectral SC',serif", fontSize: 19, letterSpacing: 5, flexShrink: 0 }}>ASSIST</div>
            {info?.orderNumber && <div style={{ fontSize: 11, color: "#888", whiteSpace: "nowrap", flexShrink: 0 }}>#{info.orderNumber}</div>}
            {info?.topic && <div style={{ fontSize: 12, color: "#666", flex: 1, minWidth: 0, lineHeight: 1.4 }}>{info.topic}</div>}
            <div style={{ display: "flex", alignItems: "center", gap: 12, flexShrink: 0, marginLeft: "auto" }}>
              <SaveIndicator saving={saving} saved={saved} error={saveError} />
              <StagePills stage={stage} maxStageIdx={maxStageIdx} onNavigate={(running || autoRunning) ? null : handleNavigateMain} stages={activeStages} stageKeys={activeStageKeys} />
              <button
                onClick={() => setMaxStageIdx(activeStageKeys.length - 1)}
                style={{ background: "transparent", border: "1px solid #555", color: "#888", fontSize: 10, letterSpacing: 1, padding: "4px 10px", borderRadius: 20, cursor: "pointer" }}>
                🔓 Розблокувати всі кроки
              </button>
            </div>
          </div>
        )}
        {/* Collapsed bar */}
        {!headerOpen && (
          <div
            onClick={() => setHeaderOpen(true)}
            style={{ padding: "6px 32px", display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer", borderBottom: "1px solid #2a2a20" }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontFamily: "'Spectral SC',serif", fontSize: 13, letterSpacing: 4, color: "#e8ff47" }}>ACADEM</span>
              <span style={{ fontFamily: "'Spectral SC',serif", fontSize: 13, letterSpacing: 4, color: "#f5f2eb" }}>ASSIST</span>
              {info?.orderNumber && <span style={{ fontSize: 11, color: "#555" }}>#{info.orderNumber}</span>}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <StagePills stage={stage} maxStageIdx={maxStageIdx} onNavigate={(running || autoRunning) ? null : handleNavigateHeader} stages={activeStages} stageKeys={activeStageKeys} />
              <span style={{ fontSize: 11, color: "#555", marginLeft: 6 }}>▼</span>
            </div>
          </div>
        )}
      </div>

      {/* ══ Автоматичний режим: банер прогресу / помилки ══ */}
      {(autoRunning || autoError) && (
        <div style={{
          position: "sticky", top: headerOpen ? 0 : 0, zIndex: 90,
          background: autoError ? "#3a1414" : "#14261a",
          borderBottom: `1px solid ${autoError ? "#5a2020" : "#2a4a30"}`,
          color: "#f0ece0", padding: "10px 32px",
          display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap",
        }}>
          {autoRunning && !autoError && (
            <>
              <SpinDot />
              <div style={{ fontSize: 13 }}>⚡ Автоматичний режим: {autoStepLabel}…</div>
              <button onClick={stopAutoPipeline}
                style={{ marginLeft: "auto", background: "transparent", border: "1px solid #7a7a5a", color: "#ddd8cc", borderRadius: 6, padding: "5px 14px", fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>
                ⏹ Зупинити
              </button>
            </>
          )}
          {autoError && (
            <>
              <div style={{ fontSize: 13, lineHeight: 1.5 }}>
                <b>⚠ Автоматичний режим зупинено</b> на кроці «{autoError.step}»{autoError.kind === "missing" ? " — бракує інформації" : " — помилка"}: {autoError.message}
              </div>
              <button onClick={() => setAutoError(null)}
                style={{ marginLeft: "auto", background: "transparent", border: "1px solid #7a7a5a", color: "#ddd8cc", borderRadius: 6, padding: "5px 14px", fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>
                Зрозуміло
              </button>
            </>
          )}
        </div>
      )}

      {/* ══ LEFT SIDEBAR (fixed, план / джерела / готово) ══ */}
      {["plan", "sources", "done"].includes(stage) && info && (() => {
        const PANEL_W = 270;
        const TAB_W = 32;
        const totalW = sidebarOpen ? PANEL_W + TAB_W : TAB_W;
        return (
          <div
            onMouseEnter={() => setSidebarOpen(true)}
            onMouseLeave={() => setSidebarOpen(false)}
            style={{
              position: "fixed",
              left: 0,
              top: 0,
              height: "100vh",
              width: totalW,
              display: "flex",
              zIndex: 200,
              transition: "width .28s cubic-bezier(.4,0,.2,1)",
              overflow: "hidden",
              boxShadow: sidebarOpen ? "4px 0 20px rgba(0,0,0,.35)" : "none",
            }}
          >
            {/* Tab — always visible */}
            <div
              onClick={() => setSidebarOpen(v => !v)}
              style={{
                width: TAB_W,
                flexShrink: 0,
                background: "#1a1a14",
                borderRight: "2px solid #e8ff47",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                height: "100%",
                userSelect: "none",
              }}
            >
              <span style={{
                writingMode: "vertical-rl",
                transform: "rotate(180deg)",
                fontSize: 10,
                letterSpacing: 2,
                color: "#e8ff47",
                textTransform: "uppercase",
                fontFamily: "'Spectral SC', serif",
              }}>
                {sidebarOpen ? "◂ закрити" : "▸ дані"}
              </span>
            </div>

            {/* Panel content */}
            <div style={{
              width: PANEL_W,
              flexShrink: 0,
              background: "#1a1a14",
              height: "100%",
              overflowY: "auto",
            }}>
              {/* Header */}
              <div style={{ padding: "18px 14px 12px", borderBottom: "1px solid #2a2a20" }}>
                <div style={{ fontFamily: "'Spectral SC', serif", fontSize: 10, letterSpacing: 3, color: "#e8ff47", marginBottom: 10 }}>ДАНІ ЗАМОВЛЕННЯ</div>
                {info.workCategory && (
                  <span style={{ fontSize: 11, background: "#2a3a00", color: "#a8d060", padding: "3px 10px", borderRadius: 12, letterSpacing: 1 }}>
                    {info.workCategory}
                  </span>
                )}
              </div>

              {/* Fields */}
              <div style={{ borderBottom: "1px solid #2a2a20" }}>
                {Object.entries(FIELD_LABELS).map(([k, l]) => info[k] ? (
                  <div key={k} className="sidebar-field-row">
                    <div style={{ padding: "8px 8px 8px 14px", color: "#666", lineHeight: 1.4 }}>{l}</div>
                    <div style={{ padding: "8px 12px 8px 6px", color: "#ddd8cc", lineHeight: 1.4, wordBreak: "break-word" }}>{info[k]}</div>
                  </div>
                ) : null)}
              </div>

              {/* methodInfo chips */}
              {methodInfo && (
                <div style={{ padding: "12px 14px" }}>
                  <div style={{ fontSize: 10, letterSpacing: 2, color: "#555", textTransform: "uppercase", marginBottom: 8, fontFamily: "'Spectral SC', serif" }}>Методичка</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {methodInfo.totalPages && <span style={{ fontSize: 11, background: "#1e2a10", color: "#7ab840", padding: "3px 8px", borderRadius: 8 }}>📄 {methodInfo.totalPages} стор.</span>}
                    {methodInfo.chaptersCount && <span style={{ fontSize: 11, background: "#1e2a10", color: "#7ab840", padding: "3px 8px", borderRadius: 8 }}>📑 {methodInfo.chaptersCount} розд.</span>}
                    {methodInfo.sourcesStyle && <span style={{ fontSize: 11, background: "#102030", color: "#6ab0e0", padding: "3px 8px", borderRadius: 8 }}>📚 {methodInfo.sourcesStyle}</span>}
                    {methodInfo.sourcesOrder && <span style={{ fontSize: 11, background: "#102030", color: "#6ab0e0", padding: "3px 8px", borderRadius: 8 }}>{methodInfo.sourcesOrder === "alphabetical" ? "🔤 Алфавіт" : "🔢 За появою"}</span>}
                    {methodInfo.formatting?.font && <span style={{ fontSize: 11, background: "#222218", color: "#aaa", padding: "3px 8px", borderRadius: 8 }}>🖋 {methodInfo.formatting.font} {methodInfo.formatting.fontSize}pt</span>}
                    {methodInfo.formatting?.margins && <span style={{ fontSize: 11, background: "#222218", color: "#aaa", padding: "3px 8px", borderRadius: 8 }}>📐 Л{methodInfo.formatting.margins.left} П{methodInfo.formatting.margins.right}мм</span>}
                    {methodInfo.citationStyle && <span style={{ fontSize: 11, background: "#2a1030", color: "#c090e0", padding: "3px 8px", borderRadius: 8 }}>🔗 {methodInfo.citationStyle}</span>}
                    <span style={{ fontSize: 11, background: "#1e2a10", color: methodInfo.hasChapterConclusions ? "#7ab840" : "#666", padding: "3px 8px", borderRadius: 8 }}>
                      {methodInfo.hasChapterConclusions ? "✓ Висновки до розд." : "✗ Без висновків"}
                    </span>
                  </div>
                </div>
              )}
            </div>
          </div>
        );
      })()}

      {/* ══ MAIN CONTENT (shifted right when sidebar present) ══ */}
      <div style={{
        paddingLeft: ["plan", "sources", "done"].includes(stage) && info ? (sidebarOpen ? 302 : 32) : 0,
        transition: "padding-left .28s cubic-bezier(.4,0,.2,1)",
      }}>
        <div style={{ maxWidth: 1100, margin: "0 auto", padding: "32px clamp(16px, 3vw, 48px)" }}>

          {/* ══ STAGES ══ */}
          {stage === "input" && (
            <InputStage
              tplText={tplText} setTplText={setTplText}
              clientPlan={clientPlan} setClientPlan={setClientPlan}
              comment={comment} setComment={setComment}
              appendicesText={appendicesText} setAppendicesText={setAppendicesText}
              fileLabel={fileLabel} fileB64={fileB64} methodInfo={methodInfo}
              exampleWorkFileName={exampleWorkFileName} exampleWorkFileB64={exampleWorkFileB64} handleExampleWorkFile={handleExampleWorkFile}
              photos={photos} setPhotos={setPhotos}
              illustrations={illustrations} setIllustrations={setIllustrations}
              illustrationsPdf={illustrationsPdf} setIllustrationsPdf={setIllustrationsPdf}
              clientDrawings={clientDrawings} setClientDrawings={setClientDrawings}
              info={info}
              clientMaterials={clientMaterials}
              onAddClientMaterial={m => setClientMaterials(prev => [...prev, m])}
              onRemoveClientMaterial={i => setClientMaterials(prev => prev.filter((_, idx) => idx !== i))}
              clientMaterialsText={clientMaterialsText} setClientMaterialsText={setClientMaterialsText}
              readyWorkFileName={readyWorkFileName}
              onReadyWorkFile={handleReadyWorkFile}
              onRemoveReadyWork={handleRemoveReadyWork}
              running={running} loadMsg={loadMsg}
              handleFile={handleFile} doAnalyze={doAnalyze} setStage={setStage}
              isAdmin={isAdmin} autoRunning={autoRunning} onRunAuto={runAutoPipeline}
            />
          )}
          {stage === "parsed" && info && (
            <ParsedStage
              info={info} setInfo={setInfo}
              methodInfo={methodInfo} setMethodInfo={setMethodInfo}
              fileB64={fileB64} apiError={apiError} sections={sections}
              commentAnalysis={commentAnalysis} setCommentAnalysis={setCommentAnalysis}
              doGenPlan={doGenPlan} setStage={setStage}
              running={running} loadMsg={loadMsg}
            />
          )}
          {stage === "plan" && (
            <PlanStage
              sections={sections} setSections={setSections}
              planDisplay={planDisplay} setPlanDisplay={setPlanDisplay}
              planLoading={planLoading} clientPlan={clientPlan}
              showManualPlanInput={showManualPlanInput} setShowManualPlanInput={setShowManualPlanInput}
              manualPlanText={manualPlanText} setManualPlanText={setManualPlanText}
              planDocxLoading={planDocxLoading} setPlanDocxLoading={setPlanDocxLoading}
              namingLoading={namingLoading} totalPagesNum={totalPagesNum}
              info={info} setInfo={setInfo} methodInfo={methodInfo} content={content}
              readyWorkFileName={readyWorkFileName} readyWorkImportedIds={readyWorkImportedIds}
              readyWorkNeedsManualAI={readyWorkNeedsManualAI} doAIAnalyzeReadyWork={doAIAnalyzeReadyWork}
              doGenPlan={doGenPlan} doNamePlaceholders={doNamePlaceholders}
              startGen={startGen} setStage={setStage}
              setSourceDist={setSourceDist} setSourceTotal={setSourceTotal}
              addNewChapter={addNewChapter} addNewChapterEmpty={addNewChapterEmpty} recalcPages={recalcPages}
              toggleStructureSection={toggleStructureSection}
              moveSectionUp={moveSectionUp} moveSectionDown={moveSectionDown}
              moveSectionToPosition={moveSectionToPosition}
              doNameSinglePlaceholder={doNameSinglePlaceholder} singleNamingId={singleNamingId}
              doNameSingleChapter={doNameSingleChapter} updateChapterTitle={updateChapterTitle}
              showClientEditsInput={showClientEditsInput} setShowClientEditsInput={setShowClientEditsInput}
              clientEditsText={clientEditsText} setClientEditsText={setClientEditsText}
              clientEditsLoading={clientEditsLoading} clientEditsOps={clientEditsOps}
              clientEditsChecked={clientEditsChecked} setClientEditsChecked={setClientEditsChecked}
              clientEditsError={clientEditsError}
              doAnalyzeClientEdits={doAnalyzeClientEdits} doApplyClientEdits={doApplyClientEdits}
              cancelClientEdits={cancelClientEdits}
            />
          )}
          {stage === "writing" && (
            <WritingStage
              running={running} paused={paused}
              regenId={regenId} setRegenId={setRegenId}
              regenPrompt={regenPrompt} setRegenPrompt={setRegenPrompt}
              regenLoading={regenLoading} regenAllLoading={regenAllLoading}
              loadMsg={loadMsg} apiError={apiError} setApiError={setApiError}
              progress={progress} displayOrder={displayOrder}
              sections={sections} genIdx={genIdx} content={content}
              regenAllAbortRef={regenAllAbortRef}
              stopGen={stopGen} resumeGen={resumeGen} doRegenAll={doRegenAll}
              doRegenSection={doRegenSection} setStage={setStage}
              doRemapCitations={doRemapCitations} remapLoading={remapLoading} stopRemap={stopRemap}
              appendicesText={appendicesText} appendicesLoading={appendicesLoading}
            />
          )}
          {stage === "sources" && (
            <SourcesStage
              mainSections={mainSections}
              readyWorkImportedIds={readyWorkImportedIds}
              citInputs={citInputs} setCitInputs={setCitInputs}
              citStructured={citStructured} setCitStructured={setCitStructured}
              sourceDist={sourceDist} sourceTotal={sourceTotal}
              keywords={keywords} kwLoading={kwLoading}
              kwError={kwError} setKwError={setKwError}
              onStopSearch={doStopSearch}
              methodInfo={methodInfo} commentAnalysis={commentAnalysis}
              citStyleOverride={citStyleOverride} sourcesOrderOverride={sourcesOrderOverride}
              onCitStyleChange={handleCitStyleChange} onSourcesOrderChange={handleSourcesOrderChange}
              citFootnotes={citFootnotes} onCitFootnotesChange={handleCitFootnotesChange}
              pageByContent={pageByContent} onPageByContentChange={handlePageByContentChange}
              allRefs={globalRefData.allRefs} refList={refList}
              showMissingSources={showMissingSources}
              citInputsSnapshot={citInputsSnapshot} allCitLoading={allCitLoading}
              info={info} doGenKeywords={doGenKeywords}
              suggestedSources={suggestedSources}
              phraseGroups={phraseGroups}
              sourcesSearchLoading={sourcesSearchLoading}
              sourcesSearchError={sourcesSearchError}
              doSearchSources={doSearchSources}
              doRegenSectionSources={doRegenSectionSources}
              doExpandYearsSection={doExpandYearsSection}
              onAddAbstracts={(entries) => setAbstractsMap(prev => ({ ...prev, ...entries }))}
              onAddSourceTheses={(entries) => setSourceThesisMap(prev => ({ ...prev, ...entries }))}
              onFinish={doRemapCitations} remapLoading={remapLoading} stopRemap={stopRemap}
              onProceedToWriting={() => setStage("writing")}
              setStage={setStage}
              onSave={() => saveToFirestore({ citInputs, citStructured, abstractsMap, sourceThesisMap, suggestedSources, phraseGroups, keywords })}
              saving={saving}
              hasGeneratedContent={Object.keys(content).some(id => !readyWorkImportedIds.includes(id))}
              onRegenWithNewSources={() => {
                const shortfall = getSourcesShortfall();
                if (shortfall.short) {
                  alert(`⚠ Джерел зібрано лише ${shortfall.totalGathered} з мінімум ${shortfall.minRequired}, потрібних для такого обсягу роботи. Додайте ще джерел — вручну або кнопкою «Знайти джерела автоматично» — перш ніж починати написання.`);
                  return;
                }
                // Контент, імпортований з готової частини роботи клієнта, не рахуємо "згенерованим" — його не чіпаємо
                const hasWrittenContent = Object.keys(content).some(id => !readyWorkImportedIds.includes(id));
                if (hasWrittenContent) {
                  if (!window.confirm("Переписати всю роботу з нуля з новими джерелами? Поточний текст буде замінено.")) return;
                  const preserved = {};
                  readyWorkImportedIds.forEach(id => { if (content[id]) preserved[id] = content[id]; });
                  contentRef.current = preserved;
                  setContent(preserved);
                  setGenIdx(0);
                  writingDoneRef.current = false;
                  autoRemapDoneRef.current = false;
                  setPaused(false);
                }
                setStage("writing");
              }}
            />
          )}
          {stage === "done" && (
            <DoneStage
              annotationUk={annotationUk} setAnnotationUk={setAnnotationUk}
              annotationEn={annotationEn} setAnnotationEn={setAnnotationEn}
              annotationLoading={annotationLoading} doRegenAnnotation={doRegenAnnotation}
              content={content} displayOrder={displayOrder}
              titlePage={titlePage} setTitlePage={setTitlePage} titlePageLines={titlePageLines}
              regenId={regenId} setRegenId={setRegenId}
              regenPrompt={regenPrompt} setRegenPrompt={setRegenPrompt}
              regenLoading={regenLoading} regenAllLoading={regenAllLoading}
              loadMsg={loadMsg}
              appendicesText={appendicesText} setAppendicesText={setAppendicesText}
              appendicesLoading={appendicesLoading} setAppendicesLoading={setAppendicesLoading}
              appendicesCustomPrompt={appendicesCustomPrompt} setAppendicesCustomPrompt={setAppendicesCustomPrompt}
              speechText={speechText} setSpeechText={setSpeechText}
              speechLoading={speechLoading} setSpeechLoading={setSpeechLoading}
              presentationLoading={presentationLoading} presentationMsg={presentationMsg}
              presentationReady={presentationReady}
              docxLoading={docxLoading} setDocxLoading={setDocxLoading}
              figureRefs={figureRefs} figureKeywords={figureKeywords}
              figKwLoading={figKwLoading} figPanelOpen={figPanelOpen} setFigPanelOpen={setFigPanelOpen}
              sections={sections} info={info} methodInfo={methodInfo} commentAnalysis={commentAnalysis}
              illustrations={illustrations} readyWorkImages={readyWorkImages}
              webImg={webImg} webImageFigs={webImageFigs}
              onWebImagesSearchAll={searchAllWebImages} onWebImageSearchOne={searchOneWebImage}
              doRegenSection={doRegenSection} doRegenAll={doRegenAll}
              regenAllAbortRef={regenAllAbortRef}
              plagId={plagId} setPlagId={setPlagId} plagLoading={plagLoading}
              doReducePlagiarism={doReducePlagiarism}
              plagAllLoading={plagAllLoading} plagAllMsg={plagAllMsg}
              doReducePlagiarismAll={doReducePlagiarismAll} plagAllAbortRef={plagAllAbortRef}
              aiDetectAllLoading={aiDetectAllLoading} aiDetectAllMsg={aiDetectAllMsg}
              doReduceAiDetectionAll={doReduceAiDetectionAll} aiDetectAllAbortRef={aiDetectAllAbortRef}
              doGenAppendices={doGenAppendices} saveToFirestore={saveToFirestore}
              copyAll={copyAll} resetAll={resetAll}
              generatePresentation={generatePresentation} generateSpeech={generateSpeech}
              doScanAndGenFigures={doScanAndGenFigures} setStage={setStage}
              orderId={currentIdRef.current}
              slideJson={slideJson}
              onSlideDesignSaved={(design) => {
                const next = { ...slideJson, design };
                setSlideJson(next);
                saveToFirestore({ slideJson: next });
              }}
            />
          )}
          {stage === "checklist" && (
            <ChecklistStage info={info} methodInfo={methodInfo} setStage={setStage} mode="large" />
          )}
        </div>
      </div>{/* end flex layout wrapper */}

      {/* Scroll arrows */}
      <div style={{ position: "fixed", right: 18, bottom: 24, zIndex: 999, display: "flex", flexDirection: "column", gap: 6 }}>
        {[{ dir: "↑", title: "Нагору", action: () => window.scrollTo({ top: 0, behavior: "smooth" }) },
        { dir: "↓", title: "Вниз", action: () => window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" }) }
        ].map(({ dir, title, action }) => (
          <button key={dir} onClick={action} title={title}
            style={{
              width: 38, height: 38, borderRadius: "50%",
              background: "#1a1a14", border: "1.5px solid #444",
              color: "#e8ff47", fontSize: 18, lineHeight: 1,
              display: "flex", alignItems: "center", justifyContent: "center",
              cursor: "pointer", boxShadow: "0 2px 10px rgba(0,0,0,.25)",
              opacity: 0.85,
            }}
            onMouseEnter={e => e.currentTarget.style.opacity = "1"}
            onMouseLeave={e => e.currentTarget.style.opacity = "0.85"}
          >{dir}</button>
        ))}
      </div>

    </div>
  );
}
