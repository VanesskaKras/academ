import { useState, useRef, useEffect, useCallback, Fragment } from "react";
import mammoth from "mammoth";
import { db } from "./firebase";
import { useAuth } from "./AuthContext";
import { doc, getDoc, setDoc, addDoc, collection } from "firebase/firestore";
import {
  callClaude, callGemini, MODEL, MODEL_FAST, resetGenerationCost, getProxyAuthHeaders,
} from "./lib/api.js";
import {
  buildSYS, buildSYSTable, SYS_JSON, SYS_JSON_SHORT, STRUCTURE_READING_PROMPT,
  buildMethodologyReadingPrompt, buildStructureExampleTitlePagePrompt, isSchemaPlaceholderTitlePage,
  buildPracticePlanPrompt, buildPracticeWritingPrompt, FREEFORM_PARAGRAPH_RULES,
  buildPracticeDiaryPrompt, buildDiaryTemplateAnalysisPrompt,
  buildTemplateAnalysisPrompt, buildPracticeDetailsPrompt, getStyleProfileForSection,
  localPhrasesStep, localPhrasesJsonField, localPhrasesJsonFieldBatch,
} from "./lib/prompts.js";
import { parseTemplate, isEcon, isTechnical, getEconSections, hasRealFigure, extractNumericFacts, extractCodeFacts, extractOpeningSentences, normalizePageDistribution, stripNonContentSections, resolvePracticeFixedPages } from "./lib/planUtils.js";
import { fixDanglingFigures, dedupeRepeatedFigures } from "./lib/figureFixup.js";
import { findPlaceholderFigures } from "./lib/webImages.js";
import { useWebImages } from "./lib/useWebImages.js";
import { useLangProfile } from "./lib/useLangProfile.js";
import { detectSpecialtyPrioritized } from "./lib/academicDefaults.js";
import {
  CATEGORY_LABELS, PRACTICE_TYPES, getPracticeGuidance, detectPracticeType,
  parsePracticeDetails, buildPracticeTitlePageLines, buildPracticeDiaryTitlePageLines,
  buildPracticeTaskSheetLines, buildPracticeCalendarPlanTable, fillPracticeCalendarPlan,
  PRACTICE_TYPE_GENITIVE,
} from "./lib/practiceDefaults.js";
import { serializeForFirestore } from "./lib/firestoreUtils.js";
import { enforceWordCount, enforceTotalVolume, stripEmDash } from "./lib/wordCount.js";
import { playDoneSound } from "./lib/audio.js";
import {
  filterSourcesWithGemini, searchByPhrase, phraseSearchOpts, getEconInstitutionalSources, generateAlternatePhrases, enrichSources,
} from "./lib/sourcesSearch.js";
import { findWebsiteInText, searchCompanyWebsite, buildCompanyWebsiteSource } from "./lib/companyWebsite.js";
import { exportToDocx, exportPracticePlanToDocx, splitDiaryCalendarGraph, parseDiaryCalendarGraphRows, parseDiaryWorkRecords } from "./lib/exportDocx.js";
import { remapAndFormatCitations, applyCitationRemap, createReferenceDeduper, insertMissingCitations, capCitationRepeats, extractCitedNumbers, isAuthorYearCited, citationMarkerWithPage, renumberedCiteText } from "./lib/citationFormatting.js";
import { buildContentPagePickers } from "./lib/contentPages.js";
import { SourcesStage } from "./components/stages/SourcesStage.jsx";
import { SpinDot } from "./components/SpinDot.jsx";
import { DropZone } from "./components/DropZone.jsx";
import { WebImagesPanel } from "./components/WebImagesPanel.jsx";
import { ClientMaterialsZone } from "./components/ClientMaterialsZone.jsx";
import { ExampleFileZone } from "./components/ExampleFileZone.jsx";
import { DeptGuidanceZone } from "./components/DeptGuidanceZone.jsx";
import { FieldBox, Heading, NavBtn, PrimaryBtn, GreenBtn, SaveIndicator } from "./components/Buttons.jsx";
import { TA, TA_WHITE, SHARED_STYLES } from "./shared.jsx";

// ─── Конфіг кроків ───────────────────────────────────────────────────────────
const STAGE_LABELS = ["Дані", "Перевірка", "Структура", "Джерела", "Написання", "Щоденник", "Готово"];
const STAGE_KEYS   = ["input", "parsed", "plan", "sources", "writing", "diary", "done"];

const LANGUAGES = ["Українська", "Англійська", "Польська"];

const DOCX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

// Gemini/Claude приймають "document"-блок лише для PDF, тож DOCX конвертуємо
// в текст через mammoth і передаємо як звичайний текстовий блок.
async function fileToContentPart(b64, mediaType) {
  if (mediaType === DOCX_MEDIA_TYPE) {
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const result = await mammoth.extractRawText({ arrayBuffer: bytes.buffer });
    return { type: "text", text: result.value.trim() };
  }
  return { type: "document", source: { type: "base64", media_type: mediaType || "application/pdf", data: b64 } };
}

// ─── Render markdown tables ───────────────────────────────────────────────────
function renderWithTables(text) {
  if (!text) return null;
  const lines = text.split("\n");
  const segments = [];
  let i = 0;
  while (i < lines.length) {
    if (/^\s*\|/.test(lines[i])) {
      const tableLines = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) { tableLines.push(lines[i]); i++; }
      segments.push({ type: "table", lines: tableLines });
    } else {
      const textLines = [];
      while (i < lines.length && !/^\s*\|/.test(lines[i])) { textLines.push(lines[i]); i++; }
      segments.push({ type: "text", content: textLines.join("\n") });
    }
  }
  return segments.map((seg, si) => {
    if (seg.type === "text") return <span key={si} style={{ whiteSpace: "pre-wrap" }}>{seg.content}</span>;
    const dataLines = seg.lines.filter(l => !/^\s*\|[-:| ]+\|\s*$/.test(l));
    const rows = dataLines.map(l => l.replace(/^\|/, "").replace(/\|$/, "").split("|").map(c => c.trim()));
    if (!rows.length) return null;
    return (
      <div key={si} style={{ overflowX: "auto", margin: "6px 0" }}>
        <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12, fontFamily: "'Spectral',serif" }}>
          <tbody>
            {rows.map((cells, ri) => (
              <tr key={ri}>
                {cells.map((cell, ci) => ri === 0
                  ? <th key={ci} style={{ border: "1px solid #c4bfb4", padding: "5px 8px", textAlign: "center", background: "#ede9e0", fontWeight: 600 }}>{cell}</th>
                  : <td key={ci} style={{ border: "1px solid #c4bfb4", padding: "5px 8px", textAlign: "left" }}>{cell}</td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  });
}

// ─── Список джерел з активними посиланнями (URL — синім, клікабельні) ─────────
function renderRefListWithLinks(text) {
  if (!text) return null;
  const urlRe = /(https?:\/\/[^\s)]+)/g;
  return text.split("\n").map((line, li) => (
    <div key={li} style={{ marginBottom: 4 }}>
      {line.split(urlRe).map((part, pi) =>
        pi % 2 === 1
          ? <a key={pi} href={part} target="_blank" rel="noopener noreferrer" style={{ color: "#1a5a8a", textDecoration: "underline" }}>{part}</a>
          : part
      )}
    </div>
  ));
}

// ─── Текстове представлення структури (для копіювання) ───────────────────────
const PLAN_FIXED_IDS = ["intro", "conclusions", "sources"];
function buildPracticePlanText(sections) {
  const lines = [];
  sections.forEach((s, i) => {
    const isSub = !PLAN_FIXED_IDS.includes(s.id) && /^\d+\.\d+/.test(String(s.id));
    if (!isSub && i > 0) lines.push("");
    lines.push(isSub ? `    ${s.label}` : s.label);
  });
  return lines.join("\n");
}

// Факти (цифри з одиницею, коди документів/журналів) для інструкції "вже зафіксовано, не
// вигадуй нове" в buildPracticeWritingPrompt. СПЕРШУ йдуть факти з ОРИГІНАЛЬНИХ матеріалів
// клієнта (rawText) — вони джерело правди; лише ПОТІМ факти з уже написаних розділів. Порядок
// критичний: якщо це не так, а перший-таки написаний розділ помилково прочитає джерело (напр.
// "4 хв" як "4 год"), ця вже написана-й-помилкова версія стає "зафіксованим фактом" і мовчки
// тиражується у всі наступні розділи/таблиці/щоденник — сам механізм консистентності консервує
// одну випадкову помилку замість того, щоб її виправити.
function buildEstablishedFacts(clientMaterialsSummary, otherSectionsText) {
  const sourceText = clientMaterialsSummary?.rawText || "";
  const sourceFacts = [...extractNumericFacts(sourceText), ...extractCodeFacts(sourceText)];
  const writtenFacts = otherSectionsText.flatMap(t => [...extractNumericFacts(t), ...extractCodeFacts(t)]);
  return [...new Set([...sourceFacts, ...writtenFacts])];
}

// ─── Компонент пілюль ─────────────────────────────────────────────────────────
function StagePills({ stage, maxStageIdx, onNavigate }) {
  const cur = STAGE_KEYS.indexOf(stage);
  return (
    <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
      {STAGE_LABELS.map((l, i) => {
        const visited = i <= maxStageIdx;
        const clickable = i !== cur && visited && onNavigate;
        return (
          <div key={i}
            onClick={clickable ? () => onNavigate(STAGE_KEYS[i]) : undefined}
            style={{
              padding: "4px 12px", borderRadius: 20, fontSize: 11, letterSpacing: "1px",
              cursor: clickable ? "pointer" : "default",
              background: i === cur ? "#e8ff47" : visited ? "#1e2a00" : "transparent",
              color: i === cur ? "#111" : visited ? "#6a9000" : "#555",
              border: `1px solid ${i === cur ? "#e8ff47" : visited ? "#3a5000" : "#444"}`,
            }}>
            {visited && i !== cur ? "✓ " : ""}{l}
          </div>
        );
      })}
    </div>
  );
}

// ─── Головний компонент ───────────────────────────────────────────────────────
export default function PracticePage({ orderId, onOrderCreated, onBack }) {
  const { user } = useAuth();

  // Стадія
  const [stage, setStage] = useState("input");
  const [maxStageIdx, setMaxStageIdx] = useState(0);
  const maxStageIdxRef = useRef(0);

  // Форма
  const [practiceCategory, setPracticeCategory] = useState("other");
  const [practiceType, setPracticeType] = useState("vyrobnycha");
  const categoryManualRef = useRef(false);
  const typeManualRef = useRef(false);
  const [practiceText, setPracticeText] = useState("");
  const [pages, setPages] = useState("30");
  const [language, setLanguage] = useState("Українська");
  const [langProfile, setLangProfile] = useState(null);

  // Дані з аналізу шаблону замовлення
  const [orderNumber, setOrderNumber] = useState("");
  const [orderType, setOrderType] = useState("");
  const [topic, setTopic] = useState("");
  const [deadline, setDeadline] = useState("");
  const [direction, setDirection] = useState("");
  const [subject, setSubject] = useState("");
  const [uniqueness, setUniqueness] = useState("");
  const [course, setCourse] = useState("");
  const [extras, setExtras] = useState("");

  // Деталі практики (місце, керівники, дати, індивідуальне завдання)
  const [companyName, setCompanyName] = useState("");
  const [supervisorCompany, setSupervisorCompany] = useState("");
  const [supervisorUniversity, setSupervisorUniversity] = useState("");
  const [individualTask, setIndividualTask] = useState("");
  const [dateStart, setDateStart] = useState("");
  const [dateEnd, setDateEnd] = useState("");
  const [sourceCountExplicit, setSourceCountExplicit] = useState(null);

  // Дані для титульної сторінки
  const [studentName, setStudentName] = useState("");
  const [studentGroup, setStudentGroup] = useState("");
  const [university, setUniversity] = useState("");
  const [faculty, setFaculty] = useState("");
  const [department, setDepartment] = useState("");
  const [specialty, setSpecialty] = useState("");
  const [degreeLevel, setDegreeLevel] = useState("");
  const [knowledgeField, setKnowledgeField] = useState("");
  const [city, setCity] = useState("");

  // Методичка (PDF)
  const [fileLabel, setFileLabel] = useState("");
  const [fileB64, setFileB64] = useState(null);
  const [fileType, setFileType] = useState(null);
  const [methodInfo, setMethodInfo] = useState(null);

  // Зразки-приклади (docx/pdf → текст витягується одразу при завантаженні)
  const [structureExampleName, setStructureExampleName] = useState("");
  const [structureExampleText, setStructureExampleText] = useState("");
  const [diaryExampleName, setDiaryExampleName] = useState("");
  const [diaryExampleText, setDiaryExampleText] = useState("");
  // Структурний аналіз зразка щоденника (які розділи офіційного бланка присутні —
  // календарний графік, ліновані сторінки, відгук осіб перевірки, поля оцінки тощо)
  const [diaryTemplateInfo, setDiaryTemplateInfo] = useState(null);

  // Матеріали клієнта
  const [clientMaterials, setClientMaterials] = useState([]);
  const [clientMaterialsText, setClientMaterialsText] = useState("");
  const [clientMaterialsSummary, setClientMaterialsSummary] = useState(null);
  // Креслення клієнта (client_drawings з CRM) — у цій версії UI немає форми для
  // завантаження, лише довантажуються з існуючого замовлення (створеного через
  // CRM/воркер) і мають потрапити в експорт .docx, якщо вони є.
  const [clientDrawings, setClientDrawings] = useState([]);

  // Додаткові рекомендації кафедри/викладача (текст або фото/скріншоти — не офіційна методичка)
  const [deptGuidanceText, setDeptGuidanceText] = useState("");

  // Структура (план)
  const [sections, setSections] = useState([]);

  // Контент секцій
  const [content, setContent] = useState({});
  const [genIdx, setGenIdx] = useState(0);

  // Щоденник
  const [diaryContent, setDiaryContent] = useState("");

  // Джерела
  const [citInputs, setCitInputs] = useState({});
  const [citStructured, setCitStructured] = useState({});
  const [citStyle, setCitStyle] = useState(null);
  const [sourcesOrder, setSourcesOrder] = useState(null);
  const [citFootnotes, setCitFootnotes] = useState(false);
  const [pageByContent, setPageByContent] = useState(false); // сторінка в посиланні за змістом PDF джерела
  const [refList, setRefList] = useState("");
  const [abstractsMap, setAbstractsMap] = useState({});
  const [suggestedSources, setSuggestedSources] = useState({});
  const [phraseGroups, setPhraseGroups] = useState({});
  const [sourcesSearchLoading, setSourcesSearchLoading] = useState({});
  const [sourcesSearchError, setSourcesSearchError] = useState({});
  const [keywords, setKeywords] = useState({});
  const [enKeywords, setEnKeywords] = useState({});
  // Пошукові фрази мовою звіту (для польськомовного звіту) — поряд з enKeywords
  const [localKeywords, setLocalKeywords] = useState({});
  const [kwLoading, setKwLoading] = useState(false);
  const [kwError, setKwError] = useState("");
  const [searchPageCount, setSearchPageCount] = useState({});
  const [seenSourceKeys, setSeenSourceKeys] = useState({});
  const stopSearchRef = useRef(false);

  // UI стан
  const [running, setRunning] = useState(false);
  const runningRef = useRef(false);
  const [loadMsg, setLoadMsg] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState("");
  const savedTimerRef = useRef(null);
  const [error, setError] = useState("");
  const [dbLoading, setDbLoading] = useState(false);
  const [regenId, setRegenId] = useState(null);
  const [regenPrompt, setRegenPrompt] = useState("");
  const [regenLoading, setRegenLoading] = useState(false);
  const [docxLoading, setDocxLoading] = useState(false);
  const [planDocxLoading, setPlanDocxLoading] = useState(false);
  const [planCopied, setPlanCopied] = useState(false);
  const [diaryDocxLoading, setDiaryDocxLoading] = useState(false);
  const [namingId, setNamingId] = useState(null);
  const [namingAllLoading, setNamingAllLoading] = useState(false);

  const currentIdRef = useRef(orderId || null);
  // Фото з інтернету для рисунків-заглушок звіту (src/lib/webImages.js) — orders/{id}/webImages
  const webImg = useWebImages({ getOrderId: () => currentIdRef.current, saveOrderPatch: (patch) => saveToFirestore(patch) });
  const loadWebImages = webImg.load;
  const tokenAccRef = useRef({ inTok: 0, outTok: 0, costUsd: 0 });

  // Збираємо токени
  useEffect(() => {
    const handler = (e) => {
      tokenAccRef.current = {
        inTok: tokenAccRef.current.inTok + (e.detail.inTok || 0),
        outTok: tokenAccRef.current.outTok + (e.detail.outTok || 0),
        costUsd: tokenAccRef.current.costUsd + (e.detail.cost || 0),
      };
    };
    window.addEventListener("apicost", handler);
    return () => window.removeEventListener("apicost", handler);
  }, []);

  // Info-об'єкт для промптів
  const getPracticeInfo = useCallback(() => ({
    practiceCategory, practiceType, practiceText, pages, language,
    topic: topic || "Звіт із практики",
    type: "Звіт із практики",
    orderNumber, orderType, deadline, direction, subject, uniqueness, course, extras,
    companyName, supervisorCompany, supervisorUniversity, individualTask, dateStart, dateEnd,
    // Період "останні N років" для статистики/динаміки показників, що можуть згадуватись у розділах
    // і в щоденнику — рахуємо один раз тут (а не даємо кожній генерації вгадувати свій діапазон),
    // щоб усі частини роботи посилались на той самий проміжок років.
    statsPeriod: `${new Date().getFullYear() - 4}–${new Date().getFullYear()}`,
    sourceCountExplicit,
    studentName, studentGroup, university, faculty, department, specialty, degreeLevel, knowledgeField, city,
    practiceGuidance: getPracticeGuidance(practiceCategory, practiceType),
    // Набір підписів для мови поза вбудованою таблицею (useLangProfile нижче)
    ...(langProfile ? { langProfile } : {}),
  }), [
    practiceCategory, practiceType, practiceText, pages, language, topic,
    orderNumber, orderType, deadline, direction, subject, uniqueness, course, extras,
    companyName, supervisorCompany, supervisorUniversity, individualTask, dateStart, dateEnd,
    sourceCountExplicit, studentName, studentGroup, university, faculty, department, specialty, degreeLevel, knowledgeField, city,
    langProfile,
  ]);

  // ── Збереження в Firestore ──────────────────────────────────────────────────
  const saveToFirestore = useCallback(async (patch = {}) => {
    setSaving(true);
    try {
      const isNew = !currentIdRef.current;
      if (isNew) {
        const newRef = await addDoc(collection(db, "orders"), { createdAt: new Date().toISOString() });
        currentIdRef.current = newRef.id;
        onOrderCreated?.(newRef.id);
      }
      const ref = doc(db, "orders", currentIdRef.current);
      const info = getPracticeInfo();
      const base = {
        uid: user.uid,
        mode: "practice",
        type: "practice",
        topic: info.topic,
        pages: info.pages,
        deadline: info.deadline,
        language: info.language,
        updatedAt: new Date().toISOString(),
        totalInTok: tokenAccRef.current.inTok,
        totalOutTok: tokenAccRef.current.outTok,
        totalCostUsd: tokenAccRef.current.costUsd,
      };
      const data = serializeForFirestore({ ...base, ...patch });
      await setDoc(ref, data, { merge: true });
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
  }, [user, getPracticeInfo, onOrderCreated]);

  // Мова поза вбудованою таблицею — набір підписів, який один раз складає ШІ
  // (useLangProfile / langProfile.js); зберігаємо лише info.langProfile (setDoc з merge)
  useLangProfile({
    language, langProfile, callClaude,
    onProfile: (profile) => {
      setLangProfile(profile);
      if (currentIdRef.current) saveToFirestore({ info: { langProfile: profile } });
    },
  });

  // ── Завантаження існуючого замовлення ──────────────────────────────────────
  useEffect(() => {
    if (!orderId || !user) return;
    const load = async () => {
      setDbLoading(true);
      try {
        const snap = await getDoc(doc(db, "orders", orderId));
        if (snap.exists()) {
          const d = snap.data();
          currentIdRef.current = orderId;
          const i = d.info || {};
          if (i.practiceCategory) {
            const cat = CATEGORY_LABELS[i.practiceCategory]
              ? i.practiceCategory
              : (detectSpecialtyPrioritized(`${i.direction || ""} ${i.subject || ""} ${i.topic || ""}`, i.practiceText || "") || "other");
            setPracticeCategory(cat);
          }
          if (i.practiceType) setPracticeType(i.practiceType);
          if (i.practiceText) setPracticeText(i.practiceText);
          if (i.pages) setPages(i.pages);
          if (i.language) setLanguage(i.language);
          if (i.langProfile) setLangProfile(i.langProfile);
          if (i.topic) setTopic(i.topic);
          if (i.orderNumber) setOrderNumber(i.orderNumber);
          if (i.orderType) setOrderType(i.orderType);
          if (i.deadline) setDeadline(i.deadline);
          if (i.direction) setDirection(i.direction);
          if (i.subject) setSubject(i.subject);
          if (i.uniqueness) setUniqueness(i.uniqueness);
          if (i.course) setCourse(i.course);
          if (i.extras) setExtras(i.extras);
          if (i.companyName) setCompanyName(i.companyName);
          if (i.supervisorCompany) setSupervisorCompany(i.supervisorCompany);
          if (i.supervisorUniversity) setSupervisorUniversity(i.supervisorUniversity);
          if (i.individualTask) setIndividualTask(i.individualTask);
          if (i.dateStart) setDateStart(i.dateStart);
          if (i.dateEnd) setDateEnd(i.dateEnd);
          if (i.sourceCountExplicit) setSourceCountExplicit(i.sourceCountExplicit);
          if (i.studentName) setStudentName(i.studentName);
          if (i.studentGroup) setStudentGroup(i.studentGroup);
          if (i.university) setUniversity(i.university);
          if (i.faculty) setFaculty(i.faculty);
          if (i.department) setDepartment(i.department);
          if (i.specialty) setSpecialty(i.specialty);
          if (i.degreeLevel) setDegreeLevel(i.degreeLevel);
          if (i.knowledgeField) setKnowledgeField(i.knowledgeField);
          if (i.city) setCity(i.city);
          if (d.fileLabel) setFileLabel(d.fileLabel);
          if (d.methodInfo) setMethodInfo(d.methodInfo);
          if (d.structureExampleName) setStructureExampleName(d.structureExampleName);
          if (d.structureExampleText) setStructureExampleText(d.structureExampleText);
          if (d.diaryExampleName) setDiaryExampleName(d.diaryExampleName);
          if (d.diaryExampleText) setDiaryExampleText(d.diaryExampleText);
          if (d.diaryTemplateInfo) setDiaryTemplateInfo(d.diaryTemplateInfo);
          if (d.clientMaterialsSummary) setClientMaterialsSummary(d.clientMaterialsSummary);
          if (d.clientMaterialsText) setClientMaterialsText(d.clientMaterialsText);
          if (d.clientDrawings?.length) setClientDrawings(d.clientDrawings);
          if (d.deptGuidanceText) setDeptGuidanceText(d.deptGuidanceText);
          if (d.sections?.length) setSections(d.sections);
          if (d.content) setContent(d.content);
          loadWebImages(orderId, d.webImagesDone);
          if (d.diaryContent) setDiaryContent(d.diaryContent);
          if (d.citInputs) setCitInputs(d.citInputs);
          if (d.citStructured) setCitStructured(d.citStructured);
          if (d.citStyle) setCitStyle(d.citStyle);
          if (d.sourcesOrder) setSourcesOrder(d.sourcesOrder);
          if (d.citFootnotes != null) setCitFootnotes(d.citFootnotes);
          if (d.pageByContent != null) setPageByContent(!!d.pageByContent);
          if (d.refList) setRefList(d.refList);
          if (d.abstractsMap) setAbstractsMap(d.abstractsMap);
          if (d.suggestedSources) setSuggestedSources(d.suggestedSources);
          if (d.phraseGroups) setPhraseGroups(d.phraseGroups);
          if (d.keywords) setKeywords(d.keywords);
          if (d.enKeywords) setEnKeywords(d.enKeywords);
          if (d.localKeywords) setLocalKeywords(d.localKeywords);
          if (d.stage) {
            setStage(d.stage);
            const idx = STAGE_KEYS.indexOf(d.stage);
            const mi = Math.max(idx, d.maxStageIdx || 0);
            setMaxStageIdx(mi);
            maxStageIdxRef.current = mi;
          }
          if (d.genIdx != null) setGenIdx(d.genIdx);
        }
      } catch (e) { console.error(e); }
      setDbLoading(false);
    };
    load();
  }, [orderId, user, loadWebImages]);

  const goToStage = (s) => {
    const idx = STAGE_KEYS.indexOf(s);
    setStage(s);
    if (idx > maxStageIdxRef.current) { maxStageIdxRef.current = idx; setMaxStageIdx(idx); }
  };

  // ── Крок 1: Аналіз PDF методички + матеріали ───────────────────────────────
  const doAnalyze = async () => {
    if (!practiceText.trim()) { setError("Введіть дані про практику"); return; }
    setError("");
    setRunning(true); runningRef.current = true;
    const info = getPracticeInfo();

    // Методичка
    let parsedMethodInfo = methodInfo;
    if (fileB64) {
      setLoadMsg("Читаю методичку...");
      await new Promise(r => setTimeout(r, 1500));
      const docPart = await fileToContentPart(fileB64, fileType);
      try {
        setLoadMsg("Читаю методичку... крок 1/2");
        const structMsgs = [docPart, { type: "text", text: STRUCTURE_READING_PROMPT }];
        const structRaw = await callGemini([{ role: "user", content: structMsgs }], null, SYS_JSON_SHORT, 2000, null, "gemini-2.5-flash", true);
        const structMatch = structRaw.match(/\{[\s\S]*\}/);
        let structureInfo = null;
        try { structureInfo = structMatch ? JSON.parse(structMatch[0]) : null; } catch {}

        await new Promise(r => setTimeout(r, 1500));
        setLoadMsg("Читаю методичку... крок 2/2");
        const methodMsgs = [docPart, { type: "text", text: buildMethodologyReadingPrompt(structureInfo, true, practiceText) }];
        const raw = await callGemini([{ role: "user", content: methodMsgs }], null, SYS_JSON_SHORT, 10000, (s) => setLoadMsg(`Читаю методичку... зачекайте ${s}с`), "gemini-2.5-flash", true);
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        parsedMethodInfo = JSON.parse(jsonMatch?.[0] || raw.replace(/```json|```/g, "").trim());
        if (structureInfo) {
          if (structureInfo.chaptersCount != null) parsedMethodInfo.chaptersCount = structureInfo.chaptersCount;
          if (structureInfo.totalPages != null) parsedMethodInfo.totalPages = structureInfo.totalPages;
        }
        // Словесна заборона копіювати приклад-заглушку зі схеми промпту не стовідсоткова —
        // модель іноді все одно повертає її дослівно замість null. Кодова страховка: якщо
        // впізнаємо саме цей приклад, обнуляємо поле, щоб спрацював резервний варіант нижче.
        if (isSchemaPlaceholderTitlePage(parsedMethodInfo.titlePageTemplate)) {
          parsedMethodInfo.titlePageTemplate = null;
        }
        setMethodInfo(parsedMethodInfo);
      } catch (e) {
        console.warn("methodInfo failed:", e.message);
      }
    }

    // Титулка з методички може бути відсутня (робоча програма практики часто не містить
    // зразка для заповнення студентом), тоді як "зразок структури звіту" — реальна завершена
    // робота іншого студента — дуже часто її має. Перевіряємо цей текстовий зразок окремо,
    // щоб не втратити готову титулку лише через те, що вона лежить не в тому файлі.
    if (structureExampleText && !parsedMethodInfo?.titlePageTemplate?.length) {
      setLoadMsg("Шукаю титулку в зразку структури...");
      try {
        const tpRaw = await callClaude([{ role: "user", content: buildStructureExampleTitlePagePrompt(structureExampleText) }], null, SYS_JSON_SHORT, 1500, null, MODEL_FAST);
        const tpMatch = tpRaw.match(/\{[\s\S]*\}/);
        const tpParsed = tpMatch ? JSON.parse(tpMatch[0]) : null;
        if (tpParsed?.titlePageTemplate?.length) {
          parsedMethodInfo = { ...(parsedMethodInfo || {}), titlePageTemplate: tpParsed.titlePageTemplate };
          setMethodInfo(parsedMethodInfo);
        }
      } catch (e) {
        console.warn("structure example title page failed:", e.message);
      }
    }

    // Зразок щоденника практики: структурний аналіз (яка структура в офіційному бланку —
    // календарний графік, ліновані сторінки, відгук осіб перевірки, поля оцінки тощо), щоб
    // генерація й експорт щоденника її повторили, а не спрощували довільно.
    let parsedDiaryTemplateInfo = diaryTemplateInfo;
    if (diaryExampleText) {
      setLoadMsg("Аналізую зразок щоденника...");
      try {
        const dtRaw = await callClaude([{ role: "user", content: buildDiaryTemplateAnalysisPrompt(diaryExampleText) }], null, SYS_JSON_SHORT, 1500, null, MODEL_FAST);
        const dtMatch = dtRaw.match(/\{[\s\S]*\}/);
        parsedDiaryTemplateInfo = dtMatch ? JSON.parse(dtMatch[0]) : null;
        setDiaryTemplateInfo(parsedDiaryTemplateInfo);
      } catch (e) {
        console.warn("diary template analysis failed:", e.message);
      }
    }

    // Матеріали клієнта
    const combinedText = [
      ...clientMaterials.map(m => `=== ${m.name} ===\n${m.text}`),
      clientMaterialsText?.trim() || "",
    ].filter(Boolean).join("\n\n");

    let summary = null;
    if (combinedText.trim()) {
      summary = { rawText: combinedText };
      setClientMaterialsSummary(summary);
    }

    // Аналіз шаблону замовлення: regex-парсинг як база + LLM для гнучкості (шаблон може змінюватись)
    setLoadMsg("Аналізую шаблон замовлення...");
    let tpl = parseTemplate(practiceText);
    try {
      const tplRaw = await callClaude([{ role: "user", content: buildTemplateAnalysisPrompt(practiceText, combinedText) }], null, SYS_JSON, 1000, null, MODEL_FAST);
      const tplParsed = JSON.parse(tplRaw.match(/\{[\s\S]*\}/)?.[0] || "{}");
      tpl = { ...tpl, ...Object.fromEntries(Object.entries(tplParsed).filter(([, v]) => v != null && v !== "")) };
    } catch (e) {
      console.warn("template analysis fallback to regex:", e.message);
    }

    if (tpl.pages) { setPages(String(tpl.pages)); info.pages = String(tpl.pages); }
    if (tpl.language) { setLanguage(tpl.language); info.language = tpl.language; }
    if (tpl.topic) { setTopic(tpl.topic); info.topic = tpl.topic; }
    if (tpl.orderNumber) { setOrderNumber(tpl.orderNumber); info.orderNumber = tpl.orderNumber; }
    if (tpl.type) { setOrderType(tpl.type); info.orderType = tpl.type; }
    if (tpl.deadline) { setDeadline(tpl.deadline); info.deadline = tpl.deadline; }
    if (tpl.direction) { setDirection(tpl.direction); info.direction = tpl.direction; }
    if (tpl.subject) { setSubject(tpl.subject); info.subject = tpl.subject; }
    if (tpl.uniqueness) { setUniqueness(tpl.uniqueness); info.uniqueness = tpl.uniqueness; }
    if (tpl.course) { setCourse(String(tpl.course)); info.course = String(tpl.course); }
    if (tpl.extras) { setExtras(tpl.extras); info.extras = tpl.extras; }

    // Напрям практики: автовизначення з напряму/тематики/тексту (+ матеріали клієнта), якщо не обрано вручну
    if (!categoryManualRef.current) {
      const detected = detectSpecialtyPrioritized(
        `${tpl.direction || ""} ${tpl.subject || ""} ${tpl.topic || ""}`,
        `${practiceText} ${combinedText}`
      );
      if (detected && CATEGORY_LABELS[detected]) { setPracticeCategory(detected); info.practiceCategory = detected; }
    }
    // Вид практики: автопідказка, якщо користувач не обрав вручну.
    // Пріоритет: 1) practiceType з LLM-аналізу шаблону (бачить весь контекст замовлення — часто
    // єдине місце, де вид взагалі згаданий, якщо клієнт не завантажив методичку) →
    // 2) practiceType з методички (клієнт нерідко лише прикріплює методичку й не пише вид
    // практики в самому замовленні — тоді назва/вступ методички лишається єдиним джерелом) →
    // 3) регулярка по ВСІХ доступних текстах (розпарсені поля тип/тема/тематика + сирий текст
    // замовлення й матеріалів клієнта — вид часто згаданий лише десь у вільному тексті) →
    // 4) курс як останній фолбек (усередині detectPracticeType).
    if (!typeManualRef.current) {
      const validPracticeTypes = PRACTICE_TYPES.map(t => t.key);
      const suggestedType = validPracticeTypes.includes(tpl.practiceType)
        ? tpl.practiceType
        : validPracticeTypes.includes(parsedMethodInfo?.practiceType)
        ? parsedMethodInfo.practiceType
        : detectPracticeType(tpl.course, degreeLevel, tpl.type, tpl.topic, tpl.subject, practiceText, combinedText);
      if (suggestedType) { setPracticeType(suggestedType); info.practiceType = suggestedType; }
    }
    info.practiceGuidance = getPracticeGuidance(info.practiceCategory, info.practiceType);

    // Деталі практики: місце, керівники, дати, індивідуальне завдання (regex-фолбек + LLM)
    setLoadMsg("Витягую деталі практики...");
    let details = parsePracticeDetails(`${practiceText}\n${combinedText}`);
    try {
      const detRaw = await callClaude([{ role: "user", content: buildPracticeDetailsPrompt(practiceText, combinedText) }], null, SYS_JSON, 500, null, MODEL_FAST);
      const detParsed = JSON.parse(detRaw.match(/\{[\s\S]*\}/)?.[0] || "{}");
      details = { ...details, ...Object.fromEntries(Object.entries(detParsed).filter(([, v]) => v != null && v !== "")) };
    } catch (e) {
      console.warn("practice details fallback to regex:", e.message);
    }
    // Методичка часто містить розклад/базу практики, спільну для всієї групи (не вигадка,
    // а реальні дані курсу) — використовуємо як фолбек лише для полів, які з тексту/матеріалів
    // клієнта витягнути не вдалось.
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
    if (!companyName && details.companyName) { setCompanyName(details.companyName); info.companyName = details.companyName; }
    if (!supervisorCompany && details.supervisorCompany) { setSupervisorCompany(details.supervisorCompany); info.supervisorCompany = details.supervisorCompany; }
    if (!supervisorUniversity && details.supervisorUniversity) { setSupervisorUniversity(details.supervisorUniversity); info.supervisorUniversity = details.supervisorUniversity; }
    if (!individualTask && details.individualTask) { setIndividualTask(details.individualTask); info.individualTask = details.individualTask; }
    if (!dateStart && details.dateStart) { setDateStart(details.dateStart); info.dateStart = details.dateStart; }
    if (!dateEnd && details.dateEnd) { setDateEnd(details.dateEnd); info.dateEnd = details.dateEnd; }
    if (!sourceCountExplicit && details.sourceCount) {
      const nums = String(details.sourceCount).match(/\d+/g);
      if (nums) {
        const avg = Math.round(nums.reduce((a, b) => a + parseInt(b), 0) / nums.length);
        setSourceCountExplicit(avg);
        info.sourceCountExplicit = avg;
      }
    }
    if (!studentName && details.studentName) { setStudentName(details.studentName); info.studentName = details.studentName; }
    if (!studentGroup && details.studentGroup) { setStudentGroup(details.studentGroup); info.studentGroup = details.studentGroup; }
    if (!university && details.university) { setUniversity(details.university); info.university = details.university; }
    if (!faculty && details.faculty) { setFaculty(details.faculty); info.faculty = details.faculty; }
    if (!department && details.department) { setDepartment(details.department); info.department = details.department; }
    if (!specialty && details.specialty) { setSpecialty(details.specialty); info.specialty = details.specialty; }
    if (!degreeLevel && details.degreeLevel) { setDegreeLevel(details.degreeLevel); info.degreeLevel = details.degreeLevel; }
    if (!knowledgeField && details.knowledgeField) { setKnowledgeField(details.knowledgeField); info.knowledgeField = details.knowledgeField; }
    if (!city && details.city) { setCity(details.city); info.city = details.city; }

    await saveToFirestore({
      info,
      fileLabel: fileLabel || null,
      methodInfo: parsedMethodInfo || null,
      diaryTemplateInfo: parsedDiaryTemplateInfo || null,
      clientMaterialsSummary: summary || null,
      clientMaterialsText: clientMaterialsText?.trim() || null,
      stage: "parsed",
      status: "new",
    });
    goToStage("parsed");
    setRunning(false); runningRef.current = false; setLoadMsg("");
  };

  // ── Крок 2: Перевірка → генерація структури звіту ──────────────────────────
  const doGenPlan = async () => {
    setRunning(true); runningRef.current = true; setLoadMsg("Генерую структуру звіту...");
    const info = getPracticeInfo();
    try {
      const prompt = buildPracticePlanPrompt(info, methodInfo, structureExampleText, deptGuidanceText);
      const raw = await callClaude([{ role: "user", content: prompt }], null, "Respond only with valid JSON. No markdown.", 4000, null, MODEL_FAST);
      const parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || raw);
      if (parsed.sections?.length) parsed.sections = stripNonContentSections(parsed.sections);
      if (parsed.sections?.length) {
        // Вступ і висновки мають фіксований обсяг (стандартно 2 стор. кожен, якщо в
        // методичці/умовах клієнта явно не вказано інше) — рахуємо кодом, а не
        // довіряємо LLM, і виключаємо їх з пропорційного підганяння нижче, щоб той
        // крок їх не "роздував"/не стискав разом з основними розділами.
        const { introPages, conclPages } = resolvePracticeFixedPages(info.practiceText, deptGuidanceText);
        parsed.sections = parsed.sections.map(s =>
          s.id === "intro" ? { ...s, pages: introPages } : s.id === "conclusions" ? { ...s, pages: conclPages } : s
        );
        // LLM не завжди точно влучає сумою сторінок у заданий обсяг, особливо коли
        // підрозділів багато (кожен рахується окремо, похибки накопичуються) — підганяємо
        // кодом, щоб "N / target стор." на кроці плану завжди збігалось точно.
        // Вступ/висновки фіксовані лише якщо вони реально є в масиві (напр. цілком
        // безструктурний звіт за зразком їх не має — тоді ввесь обсяг іде в "main").
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
        setSections(parsed.sections);
      }
      await saveToFirestore({ info, sections: parsed.sections, stage: "plan", status: "new" });
      goToStage("plan");
    } catch (e) {
      setError("Помилка генерації структури: " + e.message);
    }
    setRunning(false); runningRef.current = false; setLoadMsg("");
  };

  // ── Джерела: прогресивний пошук по фразах для розділу (як у великих роботах) ──
  const doSearchSources = async (secId, thesesData, sectionLabel = '', resetPage = false, anchors = [], enPhrases = [], localPhrases = []) => {
    stopSearchRef.current = false;
    const info = getPracticeInfo();
    const mainSecs = sections.filter(s => !["sources", "intro", "conclusions"].includes(s.id) && !/додат/i.test(s.label || ""));
    const isFirstSearch = resetPage || (searchPageCount[secId] || 0) === 0;
    const isEconSecForSources = isEcon(info) && getEconSections(mainSecs, info).includes(secId);
    const isTechnicalWork = isTechnical(info);
    const institutionalGroup = (isFirstSearch && isEconSecForSources)
      ? [{ phrase: "Офіційна статистика", papers: getEconInstitutionalSources() }]
      : [];
    // Офіційний сайт підприємства-бази практики — у перший основний розділ
    // звіту (де описується підприємство), лише на першому проході пошуку.
    // Назва вже відома від клієнта (поле "Місце практики"), тож шукаємо кодом,
    // не ШІ: спершу URL у матеріалах клієнта, інакше — пошук сайту компанії.
    const isFirstMainSection = secId === mainSecs[0]?.id;
    let companyWebsiteGroup = [];
    if (isFirstSearch && isFirstMainSection && companyName?.trim()) {
      const website = findWebsiteInText(clientMaterialsSummary?.rawText || clientMaterialsText)
        || await searchCompanyWebsite(companyName);
      if (website) {
        companyWebsiteGroup = [{ phrase: "Офіційний сайт підприємства", papers: [buildCompanyWebsiteSource(website, companyName)] }];
      }
    }
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
      const updatedGroups = isFirstSearch ? [...institutionalGroup, ...companyWebsiteGroup] : [...(phraseGroups[secId] || [])];
      // Пул кандидатів, що пройшли Прохід А, але не Прохід Б («адвокат диявола») — резерв на
      // випадок, якщо звичайний добір (роки/альтернативні фрази) все одно не дотягне до needed
      // (кейс 41524: теми звіту прив'язані до конкретного підприємства, адверсаріальна
      // перевірка відсіює майже все навіть коли по суті все гаразд).
      const passAOnlyPool = [];
      const poolKey = (p) => (p.title || '').toLowerCase().slice(0, 60);

      const filterLabel = sectionLabel
        .replace(/^РОЗДІЛ\s+[IVXivxІVХ\d]+[.\s:]+/i, '')
        .trim() || sectionLabel;

      const normalizedTheses = Array.isArray(thesesData) && thesesData.length > 0 && typeof thesesData[0] === 'string'
        ? [{ thesis: '', phrases: thesesData }]
        : [...(thesesData || [])]; // копія — нижче можемо доштовхнути anchors, не чіпаючи параметр виклику
      if (isFirstSearch && anchors.length) {
        normalizedTheses.push({ thesis: '', phrases: anchors });
      }
      const nextEnPhrase = (i) => enPhrases.length ? enPhrases[i % enPhrases.length] : '';
      // Звіт неукраїнською — пошук ще й мовою звіту і зарубіжні кандидати впереміш (як у practiceStages.js)
      const searchOpts = (i) => phraseSearchOpts(info?.language, localPhrases, i);

      outer:
      for (const { thesis, phrases } of normalizedTheses) {
        for (let pi = 0; pi < (phrases || []).length; pi++) {
          if (stopSearchRef.current) break outer;
          const phrase = phrases[pi];
          const useScholar = pi === 0 || isTechnicalWork;
          const candidates = await searchByPhrase(phrase, 10, page, useScholar, 0, nextEnPhrase(pi), searchOpts(pi));
          const fresh = candidates.filter(p => {
            const key = (p.title || '').toLowerCase().slice(0, 60);
            return key && !globalSeen.has(key);
          });
          if (!fresh.length) continue;

          const { passB: top15raw, passA } = await filterSourcesWithGemini(fresh.slice(0, 20), filterLabel, topicCtx, 20, thesis, undefined, { returnPassA: true });
          const top15tagged = thesis ? top15raw.map(p => ({ ...p, sourceThesis: thesis })) : top15raw;
          const top15 = await enrichSources(top15tagged);
          top15.forEach(p => globalSeen.add((p.title || '').toLowerCase().slice(0, 60)));
          passA.filter(p => (p.geminiScore ?? 0) >= 80 && !top15raw.includes(p))
            .forEach(p => passAOnlyPool.push(thesis ? { ...p, sourceThesis: thesis } : p));

          const existingIdx = updatedGroups.findIndex(g => g.phrase === phrase);
          if (existingIdx >= 0) {
            updatedGroups[existingIdx] = { phrase, papers: [...updatedGroups[existingIdx].papers, ...top15] };
          } else {
            updatedGroups.push({ phrase, papers: top15 });
          }

          setPhraseGroups(prev => ({ ...prev, [secId]: [...updatedGroups] }));
          setSuggestedSources(prev => ({ ...prev, [secId]: updatedGroups.flatMap(g => g.papers) }));
        }
      }

      // ── Добір при нестачі: спершу закриваємо тези без жодного підтвердженого джерела,
      // потім розширюємо діапазон років (+2, потім +3), потім — альтернативні фрази ──
      if (!stopSearchRef.current) {
        const sourceTarget = calcSourceTarget(mainSecs);
        const sourceDist = calcSourceDist(mainSecs, sourceTarget);
        const needed = sourceDist[secId] || 3;
        // Джерело рахується "добрим" лише якщо пройшло Прохід А+Б (score≥70) І гейт повноти.
        const isGood = (p) => (p.geminiScore ?? 0) >= 70 && p._complete !== false;
        const countGood = () => updatedGroups.flatMap(g => g.papers).filter(isGood).length;
        const countForThesis = (t) => updatedGroups.flatMap(g => g.papers).filter(p => p.sourceThesis === t && isGood(p)).length;
        const allTriedPhrases = normalizedTheses.flatMap(t => t.phrases || []);

        const backfillPhrase = async (phrase, extraYears, enPhrase = '', thesisText = '', opts = {}) => {
          const candidates = await searchByPhrase(phrase, 10, page, true, extraYears, enPhrase, opts);
          const fresh = candidates.filter(p => {
            const key = (p.title || '').toLowerCase().slice(0, 60);
            return key && !globalSeen.has(key);
          });
          if (!fresh.length) return;
          const { passB: filteredRaw, passA } = await filterSourcesWithGemini(fresh.slice(0, 20), filterLabel, topicCtx, 20, thesisText, undefined, { returnPassA: true });
          const filteredTagged = thesisText ? filteredRaw.map(p => ({ ...p, sourceThesis: thesisText })) : filteredRaw;
          const filtered = await enrichSources(filteredTagged);
          filtered.forEach(p => globalSeen.add((p.title || '').toLowerCase().slice(0, 60)));
          passA.filter(p => (p.geminiScore ?? 0) >= 80 && !filteredRaw.includes(p))
            .forEach(p => passAOnlyPool.push(thesisText ? { ...p, sourceThesis: thesisText } : p));
          const existingIdx = updatedGroups.findIndex(g => g.phrase === phrase);
          if (existingIdx >= 0) {
            updatedGroups[existingIdx] = { phrase, papers: [...updatedGroups[existingIdx].papers, ...filtered] };
          } else {
            updatedGroups.push({ phrase, papers: filtered });
          }
          setPhraseGroups(prev => ({ ...prev, [secId]: [...updatedGroups] }));
          setSuggestedSources(prev => ({ ...prev, [secId]: updatedGroups.flatMap(g => g.papers) }));
        };

        // Пріоритетний раунд: тези без жодного підтвердженого джерела — власними фразами першими.
        const uncoveredTheses = normalizedTheses.filter(t => t.thesis && countForThesis(t.thesis) === 0);
        for (const t of uncoveredTheses) {
          if (stopSearchRef.current || countForThesis(t.thesis) > 0) continue;
          for (let i = 0; i < (t.phrases || []).length; i++) {
            if (stopSearchRef.current || countForThesis(t.thesis) > 0) break;
            await backfillPhrase(t.phrases[i], 2, nextEnPhrase(i), t.thesis, searchOpts(i));
          }
        }

        for (const extraYears of [2, 3]) {
          if (stopSearchRef.current || countGood() >= needed) break;
          for (let i = 0; i < allTriedPhrases.length; i++) {
            if (stopSearchRef.current || countGood() >= needed) break;
            await backfillPhrase(allTriedPhrases[i], extraYears, nextEnPhrase(i), '', searchOpts(i));
          }
        }

        if (!stopSearchRef.current && countGood() < needed && allTriedPhrases.length) {
          const altPhrases = await generateAlternatePhrases(topicCtx, filterLabel, allTriedPhrases);
          for (let i = 0; i < altPhrases.length; i++) {
            if (stopSearchRef.current || countGood() >= needed) break;
            await backfillPhrase(altPhrases[i], 3, nextEnPhrase(i), '', searchOpts(i));
          }
        }

        // М'який фолбек: звичайний добір (роки + альтернативні фрази) все одно не дотягнув до
        // needed — добираємо з пулу Проходу А (score ≥ 80, не пройшли Прохід Б), по спаданню
        // score. Позначаємо _softFallback — видно в SourcesStage.jsx/QA, що адверсаріальну
        // перевірку джерело не пройшло.
        if (!stopSearchRef.current && countGood() < needed && passAOnlyPool.length) {
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
            console.log(`[doSearchSources:${sectionLabel}] м'який фолбек: взято з Проходу А ${enriched.length} (score≥80, needed=${needed})`);
            updatedGroups.push({ phrase: "Резервний відбір (Прохід А, score≥80)", papers: enriched });
            setPhraseGroups(prev => ({ ...prev, [secId]: [...updatedGroups] }));
            setSuggestedSources(prev => ({ ...prev, [secId]: updatedGroups.flatMap(g => g.papers) }));
          }
        }
      }

      setSeenSourceKeys(prev => ({ ...prev, [secId]: globalSeen }));
      if (updatedGroups.length > 0) {
        const finalSuggested = { ...suggestedSources, [secId]: updatedGroups.flatMap(g => g.papers) };
        const finalGroups = { ...phraseGroups, [secId]: updatedGroups };
        saveToFirestore({ suggestedSources: finalSuggested, phraseGroups: finalGroups, keywords, enKeywords, localKeywords });
      }
    } catch (e) {
      console.error('Source search error:', e.message);
      setSourcesSearchError(prev => ({ ...prev, [secId]: e.message }));
    }
    setSourcesSearchLoading(prev => ({ ...prev, [secId]: false }));
  };

  // ── Ключові слова: тези + пошукові фрази пакетами по всіх розділах ──────────
  const doGenKeywords = async () => {
    setKwLoading(true);
    stopSearchRef.current = false;
    const info = getPracticeInfo();
    const mainSecs = sections.filter(s => !["sources", "intro", "conclusions"].includes(s.id) && !/додат/i.test(s.label || ""));
    const labelToId = {};
    for (const s of mainSecs) {
      labelToId[s.id] = s.id;
      const m = s.label.match(/^(\d+(?:\.\d+)*)/);
      if (m) labelToId[m[1]] = s.id;
    }
    const normalizeKey = (k) => labelToId[k] || k.match(/^(\d+\.\d+)/)?.[1] || k;
    const sourceTarget = calcSourceTarget(mainSecs);
    const sourceDist = calcSourceDist(mainSecs, sourceTarget);

    const BATCH_SIZE = 8;
    const snippetLen = mainSecs.length > 10 ? 600 : 1200;
    const allThesesNorm = {};
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

        const prompt = `Ти допомагаєш знайти наукові джерела для звіту з практики на тему "${info?.topic}".

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
        const parsed = JSON.parse(raw);
        const thesesRaw = parsed.theses || {};
        const enPhrasesRaw = parsed.enPhrases || {};

        for (const [k, arr] of Object.entries(thesesRaw)) {
          allThesesNorm[normalizeKey(k)] = (Array.isArray(arr) ? arr : []).map(t => ({
            thesis: String(t.thesis || '').trim(),
            phrases: (Array.isArray(t.phrases) ? t.phrases : []).map(String).filter(Boolean),
          })).filter(t => t.phrases.length > 0);
        }
        for (const [k, v] of Object.entries(enPhrasesRaw)) {
          allEnNorm[normalizeKey(k)] = Array.isArray(v) ? v.map(String).filter(Boolean) : [];
        }
        for (const [k, v] of Object.entries(parsed.localPhrases || {})) {
          allLocalNorm[normalizeKey(k)] = Array.isArray(v) ? v.map(String).filter(Boolean) : [];
        }
      }

      const kwNorm = Object.fromEntries(
        Object.entries(allThesesNorm).map(([k, theses]) => [k, theses.flatMap(t => t.phrases)])
      );
      setKeywords(kwNorm);
      setEnKeywords(allEnNorm);
      setLocalKeywords(allLocalNorm);

      const econSecIdsForSources = getEconSections(mainSecs, info);
      for (const s of mainSecs) {
        if (stopSearchRef.current) break;
        const normalKey = normalizeKey(s.id);
        const thesesData = allThesesNorm[normalKey] || allThesesNorm[s.id] || [];
        if (thesesData.length || econSecIdsForSources.includes(s.id)) {
          await doSearchSources(s.id, thesesData, s.label || '', false, [], allEnNorm[normalKey] || [], allLocalNorm[normalKey] || []);
        }
      }
    } catch (e) { console.error(e); setKwError(e.message); }
    setKwLoading(false);
  };

  const doStopSearch = () => { stopSearchRef.current = true; };

  // ── Явне розширення пошуку за роками — на прохання користувача, коли автоматичного
  // каскаду (+2/+3 роки) у doSearchSources не вистачило. Не знижує поріг релевантності —
  // лише пошукову глибину. Знайдені підтверджені джерела не вставляються автоматично
  // (у секції вже є частковий вміст) — потрапляють у список пропозицій, користувач
  // сам добирає, що додати.
  const doExpandYearsSection = async (sec) => {
    const secId = sec.id;
    setSourcesSearchLoading(prev => ({ ...prev, [secId]: true }));
    setSourcesSearchError(prev => ({ ...prev, [secId]: null }));
    try {
      const info = getPracticeInfo();
      const topicCtx = [info?.topic, info?.direction, info?.subject].filter(Boolean).join(' ');
      const filterLabel = (sec.label || '').replace(/^РОЗДІЛ\s+[IVXivxІVХ\d]+[.\s:]+/i, '').trim();
      const phrases = keywords[secId] || [];
      const enPhrasesArr = enKeywords[secId] || [];
      const globalSeen = new Set(seenSourceKeys[secId] || []);
      const updatedGroups = [...(phraseGroups[secId] || [])];
      for (let i = 0; i < phrases.length; i++) {
        if (stopSearchRef.current) break;
        const enPhrase = enPhrasesArr.length ? enPhrasesArr[i % enPhrasesArr.length] : '';
        const candidates = await searchByPhrase(phrases[i], 10, 1, true, 8, enPhrase, phraseSearchOpts(info?.language, localKeywords[secId] || [], i));
        const fresh = candidates.filter(p => {
          const key = (p.title || '').toLowerCase().slice(0, 60);
          return key && !globalSeen.has(key);
        });
        if (!fresh.length) continue;
        const filteredRaw = await filterSourcesWithGemini(fresh.slice(0, 20), filterLabel, topicCtx, 20);
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

  // ── Оновлення ключових слів + пошук для одного розділу ──────────────────────
  const doRegenSectionSources = async (sec) => {
    setSourcesSearchLoading(prev => ({ ...prev, [sec.id]: true }));
    setSourcesSearchError(prev => ({ ...prev, [sec.id]: null }));
    const info = getPracticeInfo();
    const mainSecs = sections.filter(s => !["sources", "intro", "conclusions"].includes(s.id) && !/додат/i.test(s.label || ""));
    const sourceTarget = calcSourceTarget(mainSecs);
    const sourceDist = calcSourceDist(mainSecs, sourceTarget);
    try {
      const txt = content[sec.id]
        ? `\n${content[sec.id].substring(0, 1200).replace(/["\\]/g, " ").replace(/\n+/g, " ")}`
        : "";
      const secBlock = `### ${sec.label} (потрібно ${sourceDist[sec.id] || 3} джерела)${txt}`;
      const prompt = `Ти допомагаєш знайти наукові джерела для звіту з практики на тему "${info?.topic}".

ЗАВДАННЯ — для розділу:

КРОК 1. Визнач 4–5 конкретних тез — повних змістовних тверджень про те, що саме доводитиметься у цьому розділі: який об'єкт/група/явище, в якому аспекті, в якому контексті (країна, період, галузь). Не назва розділу і не загальна категорія, а конкретне твердження (7–14 слів).
Приклад: тема "Дистанційна зайнятість в ІТ" → теза "вплив дистанційної роботи на продуктивність працівників ІТ-компаній України", а НЕ просто "дистанційна робота" чи "продуктивність праці".

КРОК 2. Для кожної тези склади 3 пошукові фрази українською:
- 2 КОНКРЕТНІ = [1–2 ключових слова з ТЕМИ роботи] + [конкретний аспект тези] — як точний прицільний пошук.
- 1 ШИРША — РІВНО ДВА ключових поняття із загального предмета тези, не більше (не три і не чотири) — без вузьких власних назв, конкретних імен чи вузькоспеціальних термінів. Що менше понять — то ширше знаходить пошук: перевірено, що фраза з двох понять "філософія та естетика романтизму" знаходить у десятки разів більше, ніж фраза з трьох понять "символізм надприродного в романтизмі" про той самий предмет. Тому: обери два НАЙЗАГАЛЬНІШІ поняття з теми й тези, відкинь решту деталізації.
ВАЖЛИВО: конкретні фрази мають містити точний предмет теми; широка фраза — той самий загальний контекст без надмірної деталізації, не втрачаючи зв'язку з темою.

КРОК 3. Додай 3 пошукові фрази АНГЛІЙСЬКОЮ для розділу загалом (academic English, ширші за тезу) —
для пошуку в міжнародних англомовних базах.${localPhrasesStep(info?.language, "розділу")}

РОЗДІЛ:
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
      const newTheses = (Array.isArray(parsed.theses) ? parsed.theses : [])
        .map(t => ({
          thesis: String(t.thesis || '').trim(),
          phrases: (Array.isArray(t.phrases) ? t.phrases : []).map(String).filter(Boolean),
        }))
        .filter(t => t.phrases.length > 0);
      const newEnPhrases = (Array.isArray(parsed.enPhrases) ? parsed.enPhrases : []).map(String).filter(Boolean);
      const newLocalPhrases = (Array.isArray(parsed.localPhrases) ? parsed.localPhrases : []).map(String).filter(Boolean);
      if (newTheses.length) {
        setKeywords(prev => ({ ...prev, [sec.id]: newTheses.flatMap(t => t.phrases) }));
        setEnKeywords(prev => ({ ...prev, [sec.id]: newEnPhrases }));
        setLocalKeywords(prev => ({ ...prev, [sec.id]: newLocalPhrases }));
        await doSearchSources(sec.id, newTheses, sec.label || '', true, [], newEnPhrases, newLocalPhrases);
      } else {
        setSourcesSearchLoading(prev => ({ ...prev, [sec.id]: false }));
      }
    } catch (e) {
      console.error('doRegenSectionSources error:', e.message);
      setSourcesSearchError(prev => ({ ...prev, [sec.id]: e.message }));
      setSourcesSearchLoading(prev => ({ ...prev, [sec.id]: false }));
    }
  };

  // ── Джерела: зберегти короткий зміст джерела (підказка при написанні тексту) ──
  const onAddAbstracts = (entries) => {
    setAbstractsMap(prev => {
      const next = { ...prev, ...entries };
      saveToFirestore({ abstractsMap: next });
      return next;
    });
  };

  // ── Джерела: форматувати список ─────────────────────────────────────────────
  // Ефективні стиль/порядок: явний вибір користувача, інакше — з методички (як у великих роботах)
  const getEffectiveCitStyle = () => {
    const extraHints = (methodInfo?.otherRequirements || "") + " " + (methodInfo?.citationStyle || "");
    const defaultCitStyle = methodInfo?.sourcesStyle || (/APA/i.test(extraHints) ? "APA" : /MLA/i.test(extraHints) ? "MLA" : "ДСТУ 8302:2015");
    return citStyle || defaultCitStyle;
  };
  const getEffectiveSourcesOrder = () => sourcesOrder || methodInfo?.sourcesOrder || "alphabetical";

  // Цільова к-сть джерел: явно вказана клієнтом, інакше — з обсягу звіту (як calcSourceDist у великих роботах)
  const calcSourceTarget = (mainSecs) => {
    if (sourceCountExplicit) return sourceCountExplicit;
    return Math.round(Math.max(mainSecs.length * 2, parseInt(pages) || mainSecs.length * 3) / 2);
  };
  // Розподіл цільової к-сті по розділах пропорційно їхньому обсягу в сторінках
  const calcSourceDist = (mainSecs, total) => {
    const pagesSum = mainSecs.reduce((a, s) => a + (parseInt(s.pages) || 0), 0) || 1;
    const minPerSec = Math.max(1, Math.floor(total / Math.max(mainSecs.length, 1) / 2));
    const raw = mainSecs.map(s => Math.max(minPerSec, (parseInt(s.pages) || 0) / pagesSum * total));
    const floors = raw.map(v => Math.floor(v));
    let remainder = Math.round(total) - floors.reduce((a, b) => a + b, 0);
    // Метод найбільших остач: залишок від округлення розподіляємо по одному джерелу
    // підрозділам з найбільшою дробовою частиною — а не скидаємо все на останній підрозділ
    const order = raw
      .map((v, i) => ({ i, frac: v - Math.floor(v) }))
      .sort((a, b) => b.frac - a.frac);
    const result = [...floors];
    for (let k = 0; k < order.length && remainder > 0; k++) { result[order[k].i] += 1; remainder--; }
    const dist = {};
    mainSecs.forEach((s, i) => { dist[s.id] = result[i]; });
    return dist;
  };

  const doFinalizeSources = async (contentOverride) => {
    const baseContent = contentOverride || content;
    const mainSecs = sections.filter(s => s.id !== "sources");
    setRunning(true); setLoadMsg("Формую список літератури...");
    resetGenerationCost();
    try {
      // 1. Локальна карта: secId → { localN: sourceText }
      const secLocalSources = {};
      mainSecs.forEach(sec => {
        const lines = (citInputs[sec.id] || "").split("\n").map(l => l.trim()).filter(Boolean);
        secLocalSources[sec.id] = {};
        lines.forEach((line, i) => { secLocalSources[sec.id][i + 1] = line; });
      });

      // 2. Глобальна нечітка дедуплікація (createReferenceDeduper, як у великих роботах) —
      // об'єднує не лише побайтово однакові тексти, а й "майже дублікати" того самого джерела.
      const deduper = createReferenceDeduper();
      mainSecs.forEach(sec => {
        Object.values(secLocalSources[sec.id]).forEach(text => { deduper.add(text); });
      });
      const rawRefs = deduper.canonicalRefs;

      if (!rawRefs.length) { setRunning(false); setLoadMsg(""); return; }

      const flatStructured = mainSecs.flatMap(sec => citStructured[sec.id] || []);
      const info = getPracticeInfo();

      // 3. Сортування + форматування стилю (спільна функція, як у великих роботах)
      let { refList: fmtList, oldToNew, refCiteText, pageRanges, pageAbbrev, pdfUrls } = await remapAndFormatCitations({
        citations: rawRefs,
        citStructured: flatStructured,
        citStyle: getEffectiveCitStyle(),
        language: info.language,
        sourcesOrder: getEffectiveSourcesOrder(),
        sourcesFormatRules: methodInfo?.sourcesFormatRules,
        sourcesGrouping: methodInfo?.sourcesGrouping,
        citFootnotes,
        citationStyle: methodInfo?.citationStyle,
        callClaude,
      });

      // 4. Мапа localN → globalN для кожного розділу
      const secLocalToGlobal = {};
      mainSecs.forEach(sec => {
        secLocalToGlobal[sec.id] = {};
        Object.entries(secLocalSources[sec.id]).forEach(([localN, text]) => {
          const rawIdx = deduper.add(text); // ідемпотентно — знаходить уже канонічний індекс
          secLocalToGlobal[sec.id][Number(localN)] = oldToNew[rawIdx + 1];
        });
      });

      // 5. Переписати [N] (і [N, с. X]) у тексті кожного розділу на нові глобальні номери —
      // через спільну applyCitationRemap, яка ще й підставляє сторінки з pageRanges.
      // "Сторінка за змістом" (перемикач): сторінка посилання — за збігом речення з PDF джерела
      let contentPickers = {};
      if (pageByContent && !citFootnotes && Object.keys(pdfUrls || {}).length) {
        setLoadMsg("Підбираю сторінки за змістом PDF джерел...");
        try {
          contentPickers = await buildContentPagePickers({
            texts: Object.fromEntries(mainSecs.map(s => [s.id, baseContent[s.id] || ""])),
            mappingFor: id => secLocalToGlobal[id], pdfUrls, pageRanges,
          });
        } catch (err) { console.error("Сторінка за змістом:", err.message); }
      }
      const nextContent = { ...baseContent };
      mainSecs.forEach(sec => {
        const text = nextContent[sec.id] || "";
        if (!text) return;
        const mapping = secLocalToGlobal[sec.id] || {};
        if (!Object.keys(mapping).length) return;
        nextContent[sec.id] = applyCitationRemap(text, mapping, refCiteText, { pageRanges, pageAbbrev, pagePicker: contentPickers[sec.id] });
      });

      // 5б. Довставлення цитат для джерел, призначених розділу на етапі "Джерела", але які
      // модель під час написання не процитувала жодного разу (типово — коли розділу
      // призначено кілька джерел, а частину просто ігноровано). Без цього такі джерела
      // тихо лишаються в списку літератури без жодної згадки в тексті — та сама перевірка,
      // що й крок 7б в doRemapCitations великих робіт (academic-assistant.jsx).
      const effStyle = getEffectiveCitStyle();
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
        setLoadMsg("Довставляю пропущені джерела у список літератури...");
        const unresolvedOrphans = [];
        const orphansBySec = new Map();
        orphans.forEach(o => {
          if (!nextContent[o.secId]) return;
          if (!orphansBySec.has(o.secId)) orphansBySec.set(o.secId, []);
          orphansBySec.get(o.secId).push(o);
        });
        await Promise.all([...orphansBySec.entries()].map(async ([secId, secOrphans]) => {
          const insertions = secOrphans.map(({ globalN }) => ({
            number: globalN,
            marker: citationMarkerWithPage(globalN, refCiteText, pageRanges, pageAbbrev),
            sourceText: fmtList[globalN - 1],
          }));
          try {
            const { text, unresolved } = await insertMissingCitations({
              sectionText: nextContent[secId], insertions, lang: info.language, callClaude,
            });
            nextContent[secId] = text;
            unresolvedOrphans.push(...unresolved);
          } catch (e) {
            console.error("Помилка вставки цитат непроцитованих джерел", secId, e);
            unresolvedOrphans.push(...secOrphans.map(o => o.globalN));
          }
        }));
        // Джерела, які так і не вдалось процитувати навіть хірургічною вставкою (модель
        // не змогла знайти природне місце в тексті) — прибираємо зі списку літератури
        // замість того, щоб лишати там непроцитований "сирітський" запис: список джерел
        // має точно відповідати тому, що реально процитоване в тексті.
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

      // 5в. Рисунки, на які текст посилається словами ("...показано на Рис. X.Y"), але сам
      // рисунок (plantuml-блок/таблиця) так і не з'явився в тексті — fixDanglingFigures
      // (findDanglingFigureRefs кодом ловить "голі" посилання) пробує домалювати кожен
      // точково, а якщо не вдалось — прибирає саме речення-посилання.
      setLoadMsg("Перевіряю рисунки...");
      await Promise.all(mainSecs.map(async sec => {
        const text = nextContent[sec.id];
        if (!text) return;
        const deduped = dedupeRepeatedFigures(text, info.language);
        const fixed = await fixDanglingFigures({ text: deduped, lang: info.language, callClaude });
        if (fixed !== text) nextContent[sec.id] = fixed;
      }));

      // ── 5г. Фінальна перевірка сумарного обсягу готової роботи (вступ...список
      // джерел) — той самий крок, що й у великих роботах (academic-assistant.jsx,
      // doRemapCitations): без нього обсяг кожного розділу міг формально пройти
      // enforceWordCount окремо, а сумарний обсяг усе одно вийти за межі заданої
      // к-сті сторінок, особливо після довставки осиротілих цитат вище (5б-5в).
      setLoadMsg("Перевіряю сумарний обсяг...");
      const totalTargetWords = sections.reduce((sum, s) => sum + (parseInt(s.pages) || 0) * 230, 0);
      const adjustedVolume = await enforceTotalVolume({
        sections, content: nextContent, targetWords: totalTargetWords,
        isEligible: (s) => !["sources", "intro", "conclusions"].includes(s.id) && !/додат/i.test(s.label || ""),
        callClaude, sys: buildSYS(info.language, methodInfo), onProgress: setLoadMsg, clean: stripEmDash,
        lang: info.language,
      });
      Object.assign(nextContent, adjustedVolume);

      const formattedText = fmtList.map((c, i) => `${i + 1}. ${c}`).join("\n");
      setContent(nextContent);
      setRefList(formattedText);
      await saveToFirestore({ content: nextContent, citInputs, citStructured, citStyle, sourcesOrder, citFootnotes, pageByContent, refList: formattedText });
    } catch (e) { setError(e.message); }
    setRunning(false); setLoadMsg("");
  };

  // ── Гаряча перевірка одразу після написання розділу: які з призначених
  // розділу джерел LLM не процитувала (попри пряму інструкцію в промпті), і
  // хірургічна довставка пропущених позначок [N], поки контекст генерації ще
  // актуальний. Той самий підхід, що й у великих роботах (academic-assistant.jsx) —
  // дешевше й надійніше, ніж ловити ці ж промахи пізніше єдиним глобальним
  // проходом (тут це крок 5б в doFinalizeSources, як підстраховка на випадок,
  // якщо ця локальна перевірка щось не вирішила).
  const insertMissingSectionCitations = async (secId, text, lang) => {
    const localSourceLines = (citInputs[secId] || "").split("\n").map(l => l.trim()).filter(Boolean);
    if (!localSourceLines.length) return text;
    const citedLocalNums = new Set(extractCitedNumbers(text));
    const missingLocal = localSourceLines
      .map((line, i) => ({ number: i + 1, marker: `[${i + 1}]`, sourceText: line, abstract: abstractsMap[line] }))
      .filter(s => !citedLocalNums.has(s.number));
    if (!missingLocal.length) return text;
    try {
      const { text: fixed } = await insertMissingCitations({ sectionText: text, insertions: missingLocal, lang, callClaude });
      return fixed;
    } catch (e) {
      console.error("insertMissingSectionCitations error:", e.message);
      return text;
    }
  };

  // ── Написання: генерація всіх секцій ───────────────────────────────────────
  const doWrite = async (startIdx = 0) => {
    const writableSecs = sections.filter(s => s.id !== "sources");
    if (!writableSecs.length) return;
    setRunning(true); runningRef.current = true;
    resetGenerationCost();
    const lang = language;
    const info = getPracticeInfo();
    let finalContent = { ...content };

    let idx = startIdx;
    while (idx < writableSecs.length && runningRef.current) {
      const sec = writableSecs[idx];
      setGenIdx(idx);
      setLoadMsg(`Генерую: ${sec.label}...`);
      const establishedFacts = buildEstablishedFacts(
        clientMaterialsSummary,
        writableSecs.filter(s => s.id !== sec.id && finalContent[s.id]).map(s => finalContent[s.id]),
      );
      let instruction = buildPracticeWritingPrompt(sec, info, methodInfo, clientMaterialsSummary, citInputs, abstractsMap, establishedFacts, deptGuidanceText);

      // Уже написані початки попередніх розділів цієї ж роботи — doWrite генерує строго
      // послідовно, тож увесь текст до поточного idx вже готовий у finalContent. Без цього
      // кожен розділ обирає стиль відкриття "наосліп", і однакові відкриття між розділами
      // (не всередині одного) — саме те, що ловлять ШІ-детектори як статистичну одноманітність.
      const priorSecs = writableSecs.slice(0, idx).filter(s => finalContent[s.id]);
      if (priorSecs.length) {
        instruction += `\n\nУЖЕ НАПИСАНІ ПОЧАТКИ ПОПЕРЕДНІХ РОЗДІЛІВ ЦІЄЇ Ж РОБОТИ (не повторюй ні структуру речень, ні перше слово, ні порядок "теза-приклад-висновок" — обери інший стиль відкриття й інший ритм):\n${priorSecs.map((s, i) => `${i + 1}. ${extractOpeningSentences(finalContent[s.id])}`).join("\n")}`;
      }

      // Розділ, що вже містить таблицю з показниками діяльності — без цього кожен наступний
      // розділ, який теж торкається показників (напр. "Економіка..." і "Управління..." в тому
      // самому звіті практики), незалежно приходить до тієї самої заглушки-таблиці з тими
      // самими рядками, бо жоден не бачить, що сусідній розділ вже її навів.
      const priorTableSecs = priorSecs.filter(s => /\|[^\n|]+\|[^\n|]+\|/.test(finalContent[s.id] || ""));
      if (priorTableSecs.length) {
        instruction += `\n\nПОПЕРЕДНІ РОЗДІЛИ ВЖЕ МІСТЯТЬ ТАБЛИЦЮ З ПОКАЗНИКАМИ (${priorTableSecs.map(s => `"${s.label}"`).join(", ")}) — у цьому розділі НЕ вставляй ту саму або майже ту саму таблицю з тими самими рядками показників повторно. Якщо тут теж природно потрібна таблиця — заповни її ІНШИМИ показниками, що стосуються саме теми цього розділу (не дублюй попередню), або згадай уже наведені дані текстом без повторного відтворення таблиці.`;
      }

      // Обов'язкові схеми з методички (requiredFigures) — та сама перевірка "чи вже є рисунок
      // десь у цьому розділі методички", що й e4c61f2 для курсових/дипломних: mandatoryFigureNote
      // у system-промпті однаково каже кожному підрозділу "тут має бути рисунок", але жоден
      // підрозділ "не бачить" сусідні, тож усі можуть покластись один на одного і розділ
      // лишиться без жодної схеми.
      // Раніше вимога форсувалась ЛИШЕ на останньому підрозділі розділу — і рисунок
      // системно опинявся в кінці розділу незалежно від того, де за змістом він
      // насправді доречний. Тепер попередні підрозділи отримують м'яке заохочення
      // (якщо тема природно пасує — намалюй тут), а жорстка вимога лишається лише
      // як гарантія-фолбек на останньому підрозділі, якщо досі жоден рисунок не з'явився.
      if (methodInfo?.requiredFigures?.length) {
        const currentChapNum = sec.id.split(".")[0];
        const chapterSecs = writableSecs.filter(s => s.id !== "intro" && s.id !== "conclusions" && s.id.split(".")[0] === currentChapNum);
        const isLastInChapter = chapterSecs[chapterSecs.length - 1]?.id === sec.id;
        const hasFigureAlready = chapterSecs.some(s => s.id !== sec.id && hasRealFigure(finalContent[s.id] || ""));
        if (!hasFigureAlready) {
          instruction += isLastInChapter
            ? `\n\nОБОВ'ЯЗКОВО: жоден інший підрозділ цього розділу ще не містить рисунка/схеми — цей підрозділ МАЄ містити хоча б один рисунок (PlantUML-схема за правилами FIGURES вище, або графік із таблиці даних), інакше вимога методички щодо схем буде порушена. Методичка явно вимагає: ${methodInfo.requiredFigures.join("; ")}.`
            : `\n\nЯкщо зміст цього підрозділу природно ілюструється рисунком чи схемою (PlantUML за правилами FIGURES вище, або графік із таблиці даних) — додай його саме тут, одразу біля відповідного тексту: це краще, ніж відкладати рисунок у кінець розділу. Методичка вимагає: ${methodInfo.requiredFigures.join("; ")}.`;
        }
      }

      const isTableSec = methodInfo?.reportFormat === "table_questionnaire" && sec.id !== "intro" && sec.id !== "conclusions";
      const isFreeformMain = sec.id === "main" && !sec.sectionTitle;
      const sysPrompt = isTableSec ? buildSYSTable(lang, methodInfo) : buildSYS(lang, methodInfo, null, getStyleProfileForSection(sec));
      try {
        const maxTok = Math.min(30000, Math.max(6000, Math.round(sec.pages * 1800)));
        const raw = stripEmDash(await callClaude(
          [{ role: "user", content: instruction }],
          null,
          sysPrompt,
          maxTok,
        ));
        let text = isTableSec ? raw : await enforceWordCount({
          text: raw, targetWords: Math.round((sec.pages || 1) * 230), label: sec.label,
          callClaude, sys: sysPrompt, onProgress: setLoadMsg, clean: stripEmDash,
          styleNote: isFreeformMain ? FREEFORM_PARAGRAPH_RULES : undefined,
        });
        if (!text || !text.trim()) throw new Error(`Порожня відповідь для секції "${sec.label}" — спробуйте ще раз.`);
        text = await insertMissingSectionCitations(sec.id, text, lang);
        text = capCitationRepeats(text);
        finalContent = { ...finalContent, [sec.id]: text };
        setContent(prev => {
          const next = { ...prev, [sec.id]: text };
          saveToFirestore({ content: next, genIdx: idx + 1 });
          return next;
        });
      } catch (e) {
        setError(e.message);
        break;
      }
      idx++;
    }

    if (idx >= writableSecs.length && runningRef.current) {
      // Передаємо свіжий вміст явно — content-стейт міг ще не встигнути оновитись
      // у замиканні цього виклику doWrite (React стейт оновлюється асинхронно).
      await doFinalizeSources(finalContent);
      playDoneSound();
      await saveToFirestore({ status: "writing", genIdx: idx });
    }
    setRunning(false); runningRef.current = false; setLoadMsg("");
  };

  // ── Написання: перегенерація однієї секції ──────────────────────────────────
  const doRegenSection = async (secId) => {
    const sec = sections.find(s => s.id === secId);
    if (!sec) return;
    setRegenLoading(true);
    const info = getPracticeInfo();
    const establishedFacts = buildEstablishedFacts(
      clientMaterialsSummary,
      sections.filter(s => s.id !== secId && s.id !== "sources" && content[s.id]).map(s => content[s.id]),
    );
    let instruction = buildPracticeWritingPrompt(sec, info, methodInfo, clientMaterialsSummary, citInputs, abstractsMap, establishedFacts);
    const otherTableSecs = sections.filter(s => s.id !== secId && s.id !== "sources" && /\|[^\n|]+\|[^\n|]+\|/.test(content[s.id] || ""));
    if (otherTableSecs.length) {
      instruction += `\n\nІНШІ РОЗДІЛИ ВЖЕ МІСТЯТЬ ТАБЛИЦЮ З ПОКАЗНИКАМИ (${otherTableSecs.map(s => `"${s.label}"`).join(", ")}) — у цьому розділі НЕ вставляй ту саму або майже ту саму таблицю з тими самими рядками показників повторно; якщо тут теж природно потрібна таблиця, заповни її ІНШИМИ показниками, що стосуються саме теми цього розділу.`;
    }
    if (regenPrompt.trim()) instruction += `\n\nДОДАТКОВІ ВИМОГИ: ${regenPrompt.trim()}`;
    const isTableSec = methodInfo?.reportFormat === "table_questionnaire" && sec.id !== "intro" && sec.id !== "conclusions";
    const isFreeformMain = sec.id === "main" && !sec.sectionTitle;
    const sysPrompt = isTableSec ? buildSYSTable(language, methodInfo) : buildSYS(language, methodInfo, null, getStyleProfileForSection(sec));
    try {
      const maxTok = Math.min(30000, Math.max(6000, Math.round(sec.pages * 1800)));
      const raw = stripEmDash(await callClaude([{ role: "user", content: instruction }], null, sysPrompt, maxTok));
      let text = isTableSec ? raw : await enforceWordCount({
        text: raw, targetWords: Math.round((sec.pages || 1) * 230), label: sec.label,
        callClaude, sys: sysPrompt, onProgress: setLoadMsg, clean: stripEmDash,
        styleNote: isFreeformMain ? FREEFORM_PARAGRAPH_RULES : undefined,
      });
      if (!text || !text.trim()) throw new Error(`Порожня відповідь для секції "${sec.label}" — спробуйте ще раз.`);
      text = await insertMissingSectionCitations(secId, text, language);
      text = capCitationRepeats(text);
      text = await fixDanglingFigures({ text, lang: language, callClaude });
      setContent(prev => {
        const next = { ...prev, [secId]: text };
        saveToFirestore({ content: next });
        return next;
      });
      setRegenId(null); setRegenPrompt("");
    } catch (e) { setError(e.message); }
    setRegenLoading(false);
  };

  // ── Щоденник ────────────────────────────────────────────────────────────────
  const doGenerateDiary = async () => {
    setRunning(true); runningRef.current = true; setLoadMsg("Генерую щоденник практики...");
    const info = getPracticeInfo();
    try {
      const writableSecs = sections?.filter(s => s.id !== "sources") || [];
      const reportText = writableSecs.map(s => content[s.id]).filter(Boolean).join("\n\n");
      const prompt = buildPracticeDiaryPrompt(info, diaryExampleText, methodInfo, deptGuidanceText, diaryTemplateInfo, clientMaterialsSummary?.rawText, writableSecs, reportText);
      const text = stripEmDash(await callClaude([{ role: "user", content: prompt }], null, buildSYS(language, methodInfo), 8000));
      setDiaryContent(text);
      await saveToFirestore({ diaryContent: text, stage: "diary", status: "writing" });
      goToStage("diary");
      playDoneSound();
    } catch (e) { setError(e.message); }
    setRunning(false); runningRef.current = false; setLoadMsg("");
  };

  // ── Експорт звіту у .docx (без щоденника) ────────────────────────────────────
  const doExportMain = async () => {
    setDocxLoading(true);
    try {
      const info = getPracticeInfo();
      // Список джерел має йти ПЕРЕД Додатками (вимога методички), а не автоматично в самому кінці —
      // секція "Додатки" це звичайний писемний розділ у masивi sections і природно опиняється
      // останньою, тож джерела треба вставити ПЕРЕД нею, а не після.
      const nonSourceSecs = sections.filter(s => s.id !== "sources");
      const sourcesEntry = refList ? [{ id: "sources", label: "Список використаних джерел", pages: 0 }] : [];
      const appendixIdx = nonSourceSecs.findIndex(s => /додат/i.test(s.label || ""));
      const displayOrder = appendixIdx >= 0
        ? [...nonSourceSecs.slice(0, appendixIdx), ...sourcesEntry, ...nonSourceSecs.slice(appendixIdx)]
        : [...nonSourceSecs, ...sourcesEntry];
      const exportContent = {
        ...content,
        ...(refList ? { sources: refList } : {}),
      };
      // Титульна сторінка: пріоритет — зразок ІЗ МЕТОДИЧКИ, АЛЕ лише якщо це справді зразок для
      // звіту з практики (згадує "практик...") — та сама методичка часто містить титулку для
      // курсової/кваліфікаційної роботи (інший жанр, з рядком "з дисципліни"), яку не можна
      // підставляти в звіт з практики. Інакше складаємо з витягнутих даних практики.
      const methodTitlePageMatchesPractice = methodInfo?.titlePageTemplate?.some(l => /практик/i.test(l?.text || ""));
      const titlePageLines = (methodInfo?.titlePageTemplate?.length && methodTitlePageMatchesPractice)
        ? methodInfo.titlePageTemplate
        : buildPracticeTitlePageLines(info);
      // Той самий принцип для "аркуша завдання" й календарного плану: methodInfo.taskSheetTemplate/
      // calendarPlanTable шукаються buildMethodologyReadingPrompt як бланк САМЕ на практику (окрема
      // гілка інструкції для practiceMode), але якщо методичка має лише зразок завдання на курсову/
      // кваліфікаційну роботу за темою практики (інший документ — консультанти з розділів, наказ
      // університету замість термінів практики й керівника від підприємства), він міг проскочити —
      // перевіряємо ще раз кодом і підставляємо свій, якщо в тексті зразка практика не згадана.
      const methodTaskSheetMatchesPractice = methodInfo?.taskSheetTemplate?.some(l => /практик/i.test(l?.text || ""));
      const taskSheetTemplate = (methodInfo?.taskSheetTemplate?.length && methodTaskSheetMatchesPractice)
        ? methodInfo.taskSheetTemplate
        : buildPracticeTaskSheetLines(info);
      const methodCalendarMatchesPractice = !!methodInfo?.calendarPlanTable?.trim() && /практик/i.test(methodInfo.calendarPlanTable);
      const calendarPlanTable = (methodInfo?.calendarPlanTable?.trim() && methodCalendarMatchesPractice)
        ? fillPracticeCalendarPlan(methodInfo.calendarPlanTable, info, sections)
        : buildPracticeCalendarPlanTable(info, sections);
      const exportMethodInfo = { ...methodInfo, taskSheetTemplate, calendarPlanTable };
      // Зразок без підрозділів → звіт це один суцільний розділ "main" (без вступу/висновків) —
      // сторінка "Зміст" з одного пункту не має сенсу і не відповідає зразку, пропускаємо її.
      const isFreeformReport = sections.length === 1 && sections[0]?.id === "main";
      await exportToDocx({
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
        orderId: currentIdRef.current,
        keepHeadingCase: true,
        skipToc: isFreeformReport,
        clientDrawings,
        webImages: webImg.webImages,
      });
    } catch (e) { setError(e.message); }
    setDocxLoading(false);
  };

  // ── Експорт щоденника у окремий .docx ────────────────────────────────────────
  const doExportDiary = async () => {
    if (!diaryContent) return;
    setDiaryDocxLoading(true);
    try {
      const info = getPracticeInfo();
      // Пріоритет титулки щоденника: явний зразок офіційного бланка (diaryTemplateInfo, з окремого
      // структурного аналізу завантаженого "Прикладу щоденника") > те, що знайшлось у методичці
      // (може бути менш точним — зразок щоденника там часто лише один з багатьох додатків) > типова.
      const dti = diaryTemplateInfo;
      const diaryTitlePageLines = dti?.diaryTitlePageTemplate?.length
        ? dti.diaryTitlePageTemplate
        : methodInfo?.diaryTitlePageTemplate?.length
          ? methodInfo.diaryTitlePageTemplate
          : buildPracticeDiaryTitlePageLines(info);
      const practiceLabel = PRACTICE_TYPE_GENITIVE[info.practiceType]
        ? `${PRACTICE_TYPE_GENITIVE[info.practiceType]} практики`
        : "";
      // Основна таблиця щоденника і, якщо зразок вимагає окремий "Календарний графік" (форма
      // Н-6.03), таблиця під маркером %%CALENDAR_GRAPH%% (buildPracticeDiaryPrompt) розбираються
      // тут кодом (не ШІ) — щоб дані з відповіді ШІ реально потрапили в обидва бланки замість
      // порожніх клітинок/рядків.
      const diaryCalendarGraphWeeks = dti?.calendarGraphWeeksCount || 6;
      const { mainText: diaryMainText, calendarGraphText } = splitDiaryCalendarGraph(diaryContent);
      const diaryCalendarGraphRows = dti?.hasCalendarGraphSection
        ? parseDiaryCalendarGraphRows(calendarGraphText, diaryCalendarGraphWeeks, info.dateStart)
        : [];
      const diaryWorkRecords = parseDiaryWorkRecords(diaryMainText);
      await exportToDocx({
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
        orderId: currentIdRef.current ? `${currentIdRef.current}_diary` : null,
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
      });
    } catch (e) { setError(e.message); }
    setDiaryDocxLoading(false);
  };

  // ── Копіювати текст ───────────────────────────────────────────────────────────
  const doCopyAll = () => {
    const writableSecs = sections.filter(s => s.id !== "sources");
    const parts = writableSecs.map(s => `${s.label}\n\n${content[s.id] || ""}`);
    if (diaryContent) parts.push(`Щоденник практики\n\n${diaryContent}`);
    if (refList) parts.push(`Список використаних джерел\n\n${refList}`);
    navigator.clipboard.writeText(parts.join("\n\n---\n\n"));
  };

  // ── Переміщення секцій ────────────────────────────────────────────────────────
  const FIXED = ["intro", "conclusions", "sources"];
  const movableFilter = s => !FIXED.includes(s.id);

  const moveSectionUp = (id) => {
    setSections(prev => {
      const movable = prev.filter(movableFilter);
      const idx = movable.findIndex(s => s.id === id);
      if (idx <= 0) return prev;
      const fullIdx = prev.findIndex(s => s.id === id);
      const prevMovIdx = prev.findIndex(s => s.id === movable[idx - 1].id);
      const next = [...prev];
      [next[prevMovIdx], next[fullIdx]] = [next[fullIdx], next[prevMovIdx]];
      saveToFirestore({ sections: next });
      return next;
    });
  };

  const moveSectionDown = (id) => {
    setSections(prev => {
      const movable = prev.filter(movableFilter);
      const idx = movable.findIndex(s => s.id === id);
      if (idx >= movable.length - 1) return prev;
      const fullIdx = prev.findIndex(s => s.id === id);
      const nextMovIdx = prev.findIndex(s => s.id === movable[idx + 1].id);
      const next = [...prev];
      [next[fullIdx], next[nextMovIdx]] = [next[nextMovIdx], next[fullIdx]];
      saveToFirestore({ sections: next });
      return next;
    });
  };

  const recalcPages = () => {
    const target = parseInt(pages) || 30;
    setSections(prev => {
      const movable = prev.filter(movableFilter);
      const fixed = prev.filter(s => ["intro", "conclusions"].includes(s.id));
      const fixedP = fixed.reduce((a, s) => a + (s.pages || 0), 0);
      const mainP = Math.max(target - fixedP, movable.length);
      const normPages = normalizePageDistribution(movable.map(() => 1), mainP, 2);
      let mi = 0;
      const next = prev.map(s => movableFilter(s) ? { ...s, pages: normPages[mi++] } : s);
      saveToFirestore({ sections: next });
      return next;
    });
  };

  const doNameSingle = async (id) => {
    const sec = sections.find(s => s.id === id);
    if (!sec) return;
    setNamingId(id);
    try {
      const prompt = `Придумай конкретну назву розділу звіту з практики замість заглушки.
Контекст практики: ${practiceText.slice(0, 500)}
Заглушка: "${sec.label}"
Інші розділи: ${sections.filter(s => !FIXED.includes(s.id) && s.id !== id).map(s => s.label).join("; ")}
Поверни ТІЛЬКИ нову назву розділу (без лапок, без пояснень).`;
      const name = (await callClaude([{ role: "user", content: prompt }], null, null, 200, null, MODEL_FAST)).trim();
      setSections(prev => {
        const next = prev.map(s => s.id === id ? { ...s, label: name } : s);
        saveToFirestore({ sections: next });
        return next;
      });
    } catch (e) { console.warn(e); }
    setNamingId(null);
  };

  const doNameAllPlaceholders = async () => {
    const placeholders = sections.filter(s => !FIXED.includes(s.id) && /\[|новий/i.test(s.label));
    if (!placeholders.length) return;
    setNamingAllLoading(true);
    try {
      const list = placeholders.map(s => `"${s.id}": "${s.label}"`).join(", ");
      const others = sections.filter(s => !FIXED.includes(s.id) && !/\[|новий/i.test(s.label)).map(s => s.label).join("; ");
      const prompt = `Придумай конкретні назви розділів звіту з практики замість заглушок.
Контекст практики: ${practiceText.slice(0, 500)}
Інші розділи вже мають назви: ${others}
Заглушки: ${list}
Поверни ТІЛЬКИ JSON: {"id":"нова назва",...}`;
      const raw = await callClaude([{ role: "user", content: prompt }], null, null, 500, null, MODEL_FAST);
      const parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || "{}");
      setSections(prev => {
        const next = prev.map(s => parsed[s.id] ? { ...s, label: parsed[s.id] } : s);
        saveToFirestore({ sections: next });
        return next;
      });
    } catch (e) { console.warn(e); }
    setNamingAllLoading(false);
  };

  // ─── РЕНДЕР: шапка ──────────────────────────────────────────────────────────
  const renderHeader = () => (
    <div style={{ background: "#1a1a14", color: "#f5f2eb", padding: "14px 28px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <button onClick={onBack} style={{ background: "transparent", border: "none", color: "#888", fontSize: 20, cursor: "pointer", lineHeight: 1 }}>←</button>
        <div style={{ fontFamily: "'Spectral SC',serif", fontSize: 14, letterSpacing: 3, color: "#e8ff47" }}>ПРАКТИКА</div>
        <SaveIndicator saving={saving} saved={saved} error={saveError} />
      </div>
      <StagePills stage={stage} maxStageIdx={maxStageIdx} onNavigate={running ? null : (s) => setStage(s)} />
      <button
        onClick={() => { maxStageIdxRef.current = STAGE_KEYS.length - 1; setMaxStageIdx(STAGE_KEYS.length - 1); }}
        style={{ background: "transparent", border: "1px solid #555", color: "#888", fontSize: 10, letterSpacing: 1, padding: "4px 10px", borderRadius: 20, cursor: "pointer" }}>
        🔓 Розблокувати всі кроки
      </button>
    </div>
  );

  // ─── РЕНДЕР: крок 1 — Дані ───────────────────────────────────────────────────
  const renderInput = () => (
    <div className="fade">
      <Heading>Дані практики</Heading>

      <FieldBox label="Дані практики" tooltip="Вставте будь-який текст — бланк завдання, опис підприємства, вимоги викладача. AI сам витягне всю потрібну інформацію.">
        <textarea
          value={practiceText}
          onChange={e => setPracticeText(e.target.value)}
          placeholder={`Вставте або введіть дані про практику — бланк завдання, опис підприємства, вимоги тощо.

Наприклад:
Місце практики: ТОВ «Назва», м. Київ
Строки: 01.06.2025 – 28.06.2025
Студент: Іваненко І. І., 3 курс, група ФБС-31
Спеціальність: 072 Фінанси
Керівник від підприємства: Петренко П. П., директор
Керівник від університету: Сидоренко С. С., доцент
Індивідуальне завдання: ...`}
          style={{ ...TA_WHITE, minHeight: 200 }}
        />
      </FieldBox>

      <FieldBox label="Місце практики та керівники" tooltip="Підтягнеться автоматично з тексту вище після натискання «Далі», якщо там є ці дані. Можна заповнити вручну заздалегідь.">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 8 }}>
          <input value={companyName} onChange={e => setCompanyName(e.target.value)} placeholder="Місце практики (підприємство/установа)" style={{ ...TA_WHITE, minHeight: "auto", padding: "9px 10px", fontSize: 13 }} />
          <input value={supervisorCompany} onChange={e => setSupervisorCompany(e.target.value)} placeholder="Керівник від підприємства" style={{ ...TA_WHITE, minHeight: "auto", padding: "9px 10px", fontSize: 13 }} />
          <input value={supervisorUniversity} onChange={e => setSupervisorUniversity(e.target.value)} placeholder="Керівник від університету" style={{ ...TA_WHITE, minHeight: "auto", padding: "9px 10px", fontSize: 13 }} />
        </div>
      </FieldBox>

      <FieldBox label="Дати практики" tooltip="Потрібні для щоденника — без них дати доведеться вигадувати. Підтягнуться автоматично, якщо є в тексті.">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 8 }}>
          <input value={dateStart} onChange={e => setDateStart(e.target.value)} placeholder="Дата початку (дд.мм.рррр)" style={{ ...TA_WHITE, minHeight: "auto", padding: "9px 10px", fontSize: 13 }} />
          <input value={dateEnd} onChange={e => setDateEnd(e.target.value)} placeholder="Дата закінчення (дд.мм.рррр)" style={{ ...TA_WHITE, minHeight: "auto", padding: "9px 10px", fontSize: 13 }} />
        </div>
      </FieldBox>

      <FieldBox label="Дані для титульної сторінки" tooltip="Підтягнеться автоматично з тексту вище або з методички (якщо там є зразок титулки). Можна заповнити вручну.">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 8 }}>
          <input value={studentName} onChange={e => setStudentName(e.target.value)} placeholder="ПІБ студента" style={{ ...TA_WHITE, minHeight: "auto", padding: "9px 10px", fontSize: 13 }} />
          <input value={studentGroup} onChange={e => setStudentGroup(e.target.value)} placeholder="Група" style={{ ...TA_WHITE, minHeight: "auto", padding: "9px 10px", fontSize: 13 }} />
          <input value={university} onChange={e => setUniversity(e.target.value)} placeholder="Назва університету" style={{ ...TA_WHITE, minHeight: "auto", padding: "9px 10px", fontSize: 13 }} />
          <input value={faculty} onChange={e => setFaculty(e.target.value)} placeholder="Факультет" style={{ ...TA_WHITE, minHeight: "auto", padding: "9px 10px", fontSize: 13 }} />
          <input value={department} onChange={e => setDepartment(e.target.value)} placeholder="Кафедра" style={{ ...TA_WHITE, minHeight: "auto", padding: "9px 10px", fontSize: 13 }} />
          <input value={specialty} onChange={e => setSpecialty(e.target.value)} placeholder="Спеціальність (напр. 181 Харчові технології)" style={{ ...TA_WHITE, minHeight: "auto", padding: "9px 10px", fontSize: 13 }} />
          <input value={degreeLevel} onChange={e => setDegreeLevel(e.target.value)} placeholder="ОКР/ступінь (напр. Бакалавр)" style={{ ...TA_WHITE, minHeight: "auto", padding: "9px 10px", fontSize: 13 }} />
          <input value={knowledgeField} onChange={e => setKnowledgeField(e.target.value)} placeholder="Галузь знань" style={{ ...TA_WHITE, minHeight: "auto", padding: "9px 10px", fontSize: 13 }} />
          <input value={city} onChange={e => setCity(e.target.value)} placeholder="Місто" style={{ ...TA_WHITE, minHeight: "auto", padding: "9px 10px", fontSize: 13 }} />
        </div>
      </FieldBox>

      <FieldBox label="Індивідуальне завдання" tooltip="Персональне завдання від керівника, окреме від загальної програми практики. Якщо прийшло файлом/сканом — завантажте його нижче в «Матеріали клієнта» замість цього поля.">
        <textarea
          value={individualTask}
          onChange={e => setIndividualTask(e.target.value)}
          placeholder="Текст індивідуального завдання, якщо воно є окремим текстом..."
          style={{ ...TA_WHITE, minHeight: 70 }}
        />
      </FieldBox>

      <FieldBox label="Вид практики" tooltip="Підказується автоматично з курсу після натискання «Далі», але можна обрати вручну заздалегідь або виправити після аналізу.">
        <div style={{ display: "flex", gap: 8 }}>
          {PRACTICE_TYPES.map(t => (
            <button key={t.key} type="button"
              onClick={() => { typeManualRef.current = true; setPracticeType(t.key); }}
              style={{
                padding: "8px 14px", borderRadius: 8, fontSize: 12, cursor: "pointer",
                background: practiceType === t.key ? "#1a1a14" : "#f0ece2",
                color: practiceType === t.key ? "#e8ff47" : "#333",
                border: `1.5px solid ${practiceType === t.key ? "#1a1a14" : "#d4cfc4"}`,
              }}>
              {t.label}
            </button>
          ))}
        </div>
      </FieldBox>

      <FieldBox label="Методичка (PDF або DOCX)" tooltip="Завантажте методичні вказівки — програма врахує всі вимоги до оформлення та структури">
        <DropZone fileLabel={fileLabel} onFile={(name, b64, type) => { setFileLabel(name); setFileB64(b64); setFileType(type); }} accept=".pdf,.docx" />
      </FieldBox>

      <FieldBox label="Додаткові рекомендації кафедри (необов'язково)" tooltip="Якщо крім офіційної методички є ще вказівки викладача/кафедри (напр. скріншоти посту в Telegram) — вставте текст або завантажте фото, програма врахує їх при написанні розділів, плану та щоденника">
        <DeptGuidanceZone
          value={deptGuidanceText}
          onChange={text => { setDeptGuidanceText(text); saveToFirestore({ deptGuidanceText: text }); }}
        />
      </FieldBox>

      <FieldBox label="Зразок структури звіту (необов'язково)" tooltip="Приклад готового звіту — план розділів згенерується за його реальною структурою. Приймається .docx та .pdf; якщо файл .doc — спершу збережіть його як .pdf.">
        <ExampleFileZone
          fileName={structureExampleName}
          hint="Перетягніть або клікніть — .docx, .pdf (.doc спершу збережіть як .pdf)"
          onExtracted={(name, text) => {
            setStructureExampleName(name); setStructureExampleText(text);
            saveToFirestore({ structureExampleName: name, structureExampleText: text });
          }}
        />
      </FieldBox>

      <FieldBox label="Приклад щоденника практики (необов'язково)" tooltip="Зразок заповненого щоденника — згенерований щоденник повторить його формат і рівень деталізації. Приймається .docx та .pdf; якщо файл .doc — спершу збережіть його як .pdf.">
        <ExampleFileZone
          fileName={diaryExampleName}
          hint="Перетягніть або клікніть — .docx, .pdf (.doc спершу збережіть як .pdf)"
          onExtracted={(name, text) => {
            setDiaryExampleName(name); setDiaryExampleText(text);
            saveToFirestore({ diaryExampleName: name, diaryExampleText: text });
          }}
        />
      </FieldBox>

      <FieldBox label="Матеріали клієнта" tooltip="Завантажте звіти, таблиці, описи — вони будуть використані при написанні">
        <ClientMaterialsZone
          materials={clientMaterials}
          onAdd={m => setClientMaterials(prev => [...prev, m])}
          onRemove={i => setClientMaterials(prev => prev.filter((_, idx) => idx !== i))}
          manualText={clientMaterialsText}
          onManualText={setClientMaterialsText}
        />
      </FieldBox>

      {error && <div style={{ color: "#c55", fontSize: 13, marginBottom: 12 }}>{error}</div>}

      <div style={{ display: "flex", gap: 12, marginTop: 8 }}>
        <NavBtn onClick={onBack}>← Назад</NavBtn>
        <PrimaryBtn
          onClick={doAnalyze}
          disabled={running}
          loading={running}
          msg={loadMsg || "Аналізую..."}
          label="Далі →"
        />
      </div>
    </div>
  );

  // ─── РЕНДЕР: крок 1.5 — Перевірка ────────────────────────────────────────────
  const renderParsed = () => {
    const courseMissing = !String(course || "").trim();
    const recommendedMissing = [
      !(dateStart && dateEnd) && "дати практики",
      !companyName && "місце практики",
      !individualTask && "індивідуальне завдання",
      !studentName && "ПІБ студента (для титульної)",
      !university && "університет (для титульної)",
    ].filter(Boolean);
    const hasExtras = !!extras?.trim();

    const row = (label, value, onChange, opts = {}) => (
      <div style={{ display: "grid", gridTemplateColumns: "220px 1fr", borderBottom: "1px solid #e4dfd4" }}>
        <div style={{ padding: "10px 14px", fontSize: 11, letterSpacing: "1px", textTransform: "uppercase", color: "#888", background: "#f0ece2", display: "flex", alignItems: "center" }}>{label}</div>
        <div style={{ padding: "6px 10px", display: "flex", alignItems: "center" }}>
          {opts.readOnly
            ? <span style={{ fontSize: 13, color: "#1a1a14" }}>{value || "—"}</span>
            : opts.textarea
            ? <textarea value={value} onChange={onChange} style={{ ...TA_WHITE, minHeight: 60, border: "none", background: "transparent", padding: "4px 0", width: "100%" }} />
            : <input value={value} onChange={onChange} style={{ border: "none", background: "transparent", fontSize: 13, fontFamily: "'Spectral',serif", padding: "4px 0", width: "100%", outline: "none" }} />}
        </div>
      </div>
    );

    return (
      <div className="fade">
        <Heading>Перевірка даних</Heading>
        <p style={{ fontSize: 13, color: "#888", marginBottom: 14 }}>Клікніть на значення, щоб змінити. Перевірте дані перед генерацією структури звіту.</p>

        <div style={{ border: "1.5px solid #d4cfc4", borderRadius: 8, overflow: "hidden", marginBottom: 12 }}>
          {row("Номер замовлення", orderNumber, e => setOrderNumber(e.target.value))}
          {row("Тип", orderType, e => setOrderType(e.target.value))}
          <div style={{ display: "grid", gridTemplateColumns: "220px 1fr", borderBottom: "1px solid #e4dfd4" }}>
            <div style={{ padding: "10px 14px", fontSize: 11, letterSpacing: "1px", textTransform: "uppercase", color: "#888", background: "#f0ece2", display: "flex", alignItems: "center" }}>Напрям практики</div>
            <div style={{ padding: "6px 10px", display: "flex", alignItems: "center" }}>
              <select value={practiceCategory} onChange={e => { categoryManualRef.current = true; setPracticeCategory(e.target.value); }}
                style={{ border: "none", background: "transparent", fontSize: 13, fontFamily: "'Spectral',serif", padding: "4px 0", width: "100%", outline: "none" }}>
                {Object.entries(CATEGORY_LABELS).map(([key, c]) => (
                  <option key={key} value={key}>{c.icon} {c.label}</option>
                ))}
              </select>
            </div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "220px 1fr", borderBottom: "1px solid #e4dfd4" }}>
            <div style={{ padding: "10px 14px", fontSize: 11, letterSpacing: "1px", textTransform: "uppercase", color: "#888", background: "#f0ece2", display: "flex", alignItems: "center" }}>Вид практики</div>
            <div style={{ padding: "6px 10px", display: "flex", gap: 6, alignItems: "center" }}>
              {PRACTICE_TYPES.map(t => (
                <button key={t.key} type="button"
                  onClick={() => { typeManualRef.current = true; setPracticeType(t.key); }}
                  style={{
                    padding: "5px 10px", borderRadius: 6, fontSize: 11, cursor: "pointer",
                    background: practiceType === t.key ? "#1a1a14" : "#f0ece2",
                    color: practiceType === t.key ? "#e8ff47" : "#333",
                    border: `1px solid ${practiceType === t.key ? "#1a1a14" : "#d4cfc4"}`,
                  }}>
                  {t.label}
                </button>
              ))}
            </div>
          </div>
          {row("Курс", course, e => setCourse(e.target.value))}
          {row("Тема", topic, e => setTopic(e.target.value))}
          {row("Тематика / предмет", subject, e => setSubject(e.target.value))}
          {row("Галузь / напрям", direction, e => setDirection(e.target.value))}
          {row("К-сть сторінок", pages, e => setPages(e.target.value))}
          {row("Мова роботи", language, e => setLanguage(e.target.value))}
          {row("Дедлайн", deadline, e => setDeadline(e.target.value))}
          {row("Унікальність", uniqueness, e => setUniqueness(e.target.value))}
          {row("Додаткові матеріали", extras, e => setExtras(e.target.value))}
          {row("Місце практики", companyName, e => setCompanyName(e.target.value))}
          {row("Керівник від підприємства", supervisorCompany, e => setSupervisorCompany(e.target.value))}
          {row("Керівник від університету", supervisorUniversity, e => setSupervisorUniversity(e.target.value))}
          {row("Дата початку", dateStart, e => setDateStart(e.target.value))}
          {row("Дата закінчення", dateEnd, e => setDateEnd(e.target.value))}
          {row("Індивідуальне завдання", individualTask, e => setIndividualTask(e.target.value), { textarea: true })}
          {row("ПІБ студента", studentName, e => setStudentName(e.target.value))}
          {row("Група", studentGroup, e => setStudentGroup(e.target.value))}
          {row("Університет", university, e => setUniversity(e.target.value))}
          {row("Факультет", faculty, e => setFaculty(e.target.value))}
          {row("Кафедра", department, e => setDepartment(e.target.value))}
          {row("Спеціальність", specialty, e => setSpecialty(e.target.value))}
          {row("ОКР/ступінь", degreeLevel, e => setDegreeLevel(e.target.value))}
          {row("Галузь знань", knowledgeField, e => setKnowledgeField(e.target.value))}
          {row("Місто", city, e => setCity(e.target.value))}
          {row("Методичка", fileLabel || (methodInfo ? "прочитано" : "не завантажено"), null, { readOnly: true })}
        </div>

        {courseMissing && <div style={{ fontSize: 12, color: "#8a1a1a", marginBottom: 6 }}>⚠ Вкажіть курс, щоб продовжити</div>}
        {recommendedMissing.length > 0 && (
          <div style={{ fontSize: 12, color: "#8a6a1a", marginBottom: 6 }}>⚠ Рекомендується заповнити: {recommendedMissing.join(", ")}</div>
        )}
        {hasExtras && (
          <div style={{ fontSize: 12, color: "#8a6a1a", marginBottom: 6 }}>⚠ Презентація/доповідь та подібні додаткові матеріали виконуються окремо в «Малих роботах» — практика їх не генерує</div>
        )}

        {error && <div style={{ color: "#c55", fontSize: 13, marginBottom: 12 }}>{error}</div>}

        <div style={{ display: "flex", gap: 12, marginTop: 8 }}>
          <NavBtn onClick={() => goToStage("input")}>← Назад</NavBtn>
          <PrimaryBtn
            onClick={doGenPlan}
            disabled={running || courseMissing}
            loading={running}
            msg={loadMsg || "Генерую..."}
            label="Генерувати структуру →"
          />
        </div>
      </div>
    );
  };

  // ─── РЕНДЕР: крок 2 — Структура ─────────────────────────────────────────────
  const renderPlan = () => {
    const targetPages = parseInt(pages) || 30;
    const totalP = sections.reduce((a, s) => s.id !== "sources" ? a + (parseInt(s.pages) || 0) : a, 0);
    const pagesOk = totalP === targetPages;
    const movable = sections.filter(s => !FIXED.includes(s.id));
    const hasPlaceholders = sections.some(s => !FIXED.includes(s.id) && /\[|новий/i.test(s.label));

    const updateSec = (id, field, val) => setSections(prev => {
      const next = prev.map(s => s.id === id ? { ...s, [field]: field === "pages" ? parseInt(val) || 0 : val } : s);
      saveToFirestore({ sections: next });
      return next;
    });

    const addChapter = () => {
      const chNums = sections.filter(s => !FIXED.includes(s.id)).map(s => parseInt(s.id.replace(/\D/g, "")) || 0);
      const newNum = (Math.max(0, ...chNums) + 1);
      const newSec = { id: `ch${newNum}`, label: `[Новий розділ ${newNum}]`, pages: Math.max(3, Math.round(targetPages * 0.12)) };
      setSections(prev => {
        const idx = prev.findIndex(s => s.id === "conclusions");
        const next = idx >= 0 ? [...prev.slice(0, idx), newSec, ...prev.slice(idx)] : [...prev, newSec];
        saveToFirestore({ sections: next });
        return next;
      });
    };

    const addSubsection = () => {
      const lastMovable = movable[movable.length - 1];
      const parentLabel = lastMovable?.label?.replace(/^\[|\]$/g, "") || "розділу";
      const subId = `sub${Date.now()}`;
      const newSec = { id: subId, label: `[Підрозділ до: ${parentLabel.slice(0, 30)}]`, pages: Math.max(2, Math.round(targetPages * 0.07)) };
      setSections(prev => {
        const idx = prev.findIndex(s => s.id === "conclusions");
        const next = idx >= 0 ? [...prev.slice(0, idx), newSec, ...prev.slice(idx)] : [...prev, newSec];
        saveToFirestore({ sections: next });
        return next;
      });
    };

    const delSec = (id) => {
      if (FIXED.includes(id)) return;
      setSections(prev => { const next = prev.filter(s => s.id !== id); saveToFirestore({ sections: next }); return next; });
    };

    const COL = "36px 1fr 68px 68px 72px 36px";

    return (
      <div className="fade">
        <Heading>Структура звіту</Heading>
        <p style={{ fontSize: 13, color: "#888", marginBottom: 14 }}>Відредагуйте назви та кількість сторінок. Затвердіть структуру перед переходом до джерел.</p>

        <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
          <button
            onClick={() => {
              navigator.clipboard.writeText(buildPracticePlanText(sections));
              setPlanCopied(true);
              setTimeout(() => setPlanCopied(false), 2000);
            }}
            style={{ background: "transparent", border: "1.5px solid #c4bfb4", color: "#666", borderRadius: 6, padding: "6px 16px", fontFamily: "'Spectral',serif", fontSize: 12, cursor: "pointer", letterSpacing: "0.5px" }}>
            {planCopied ? "✓ Скопійовано" : "COPY"}
          </button>
          <button
            disabled={planDocxLoading}
            onClick={async () => {
              setPlanDocxLoading(true);
              try { await exportPracticePlanToDocx({ sections, info: getPracticeInfo(), methodInfo }); } catch (e) { setError("Помилка експорту: " + e.message); }
              setPlanDocxLoading(false);
            }}
            style={{ background: "transparent", border: "1.5px solid #8ab060", color: planDocxLoading ? "#aaa" : "#6a9030", borderRadius: 6, padding: "6px 16px", fontFamily: "'Spectral',serif", fontSize: 12, cursor: planDocxLoading ? "wait" : "pointer", letterSpacing: "0.5px", display: "inline-flex", alignItems: "center", gap: 6 }}>
            {planDocxLoading ? <><SpinDot />...</> : "⬇ .docx"}
          </button>
        </div>

        {/* Таблиця */}
        <div style={{ border: "1.5px solid #d4cfc4", borderRadius: 8, overflow: "hidden", marginBottom: 16 }}>
          {/* Шапка */}
          <div style={{ display: "grid", gridTemplateColumns: COL, background: "#1a1a14", color: "#e8ff47", padding: "9px 14px", fontSize: 11, letterSpacing: "1.5px", textTransform: "uppercase" }}>
            <div>#</div><div>Назва розділу</div><div style={{ textAlign: "center" }}>Стор.</div><div style={{ textAlign: "center" }}>Перем.</div><div /><div />
          </div>

          {sections.map((s, i) => {
            const isFixed = FIXED.includes(s.id);
            const movIdx = movable.findIndex(x => x.id === s.id);
            const canUp = !isFixed && movIdx > 0;
            const canDown = !isFixed && movIdx < movable.length - 1;
            const isPlaceholder = !isFixed && /\[|новий|підрозділ/i.test(s.label);
            const isNaming = namingId === s.id;
            const showChapterDivider = s.sectionTitle && s.sectionTitle !== sections[i - 1]?.sectionTitle;

            return (
              <Fragment key={s.id}>
              {showChapterDivider && (
                <div style={{ gridColumn: "1 / -1", padding: "6px 14px", background: "#e4dfd4", fontSize: 11, fontWeight: "bold", letterSpacing: "0.5px", color: "#555" }}>
                  {s.sectionTitle}
                </div>
              )}
              <div style={{ display: "grid", gridTemplateColumns: COL, borderBottom: i < sections.length - 1 ? "1px solid #e4dfd4" : "none", background: isFixed ? "#ede9e0" : i % 2 === 0 ? "#f5f2eb" : "#f0ece2", alignItems: "center" }}>
                <div style={{ padding: "9px 10px", fontSize: 12, color: "#bbb" }}>{i + 1}</div>

                {/* Назва + ✨ */}
                <div style={{ display: "flex", alignItems: "center", overflow: "hidden" }}>
                  <input
                    value={s.label}
                    onChange={e => updateSec(s.id, "label", e.target.value)}
                    style={{ background: "transparent", border: "none", fontSize: 13, padding: "9px 8px", color: isFixed ? "#888" : "#1a1a14", fontStyle: isFixed ? "italic" : "normal", flex: 1, minWidth: 0, fontFamily: "'Spectral',serif", outline: "none" }}
                  />
                  {isPlaceholder && (
                    <button onClick={() => doNameSingle(s.id)} disabled={isNaming} title="Згенерувати назву"
                      style={{ background: "transparent", border: "none", fontSize: 14, cursor: isNaming ? "wait" : "pointer", padding: "2px 6px", color: isNaming ? "#ccc" : "#b8a020", flexShrink: 0 }}>
                      {isNaming ? "…" : "✨"}
                    </button>
                  )}
                </div>

                {/* Сторінки */}
                <div style={{ textAlign: "center", padding: "4px 6px" }}>
                  {s.id === "sources" ? <span style={{ color: "#aaa" }}>—</span> : (
                    <input type="number" value={s.pages} min={0} max={99} onChange={e => updateSec(s.id, "pages", e.target.value)}
                      style={{ width: 52, border: "1px solid #e0ddd4", borderRadius: 4, textAlign: "center", padding: "4px", fontSize: 13, fontFamily: "'Spectral',serif" }} />
                  )}
                </div>

                {/* ↑↓ */}
                <div style={{ display: "flex", justifyContent: "center", gap: 2 }}>
                  {!isFixed && (<>
                    <button onClick={() => moveSectionUp(s.id)} disabled={!canUp} style={{ background: "transparent", border: "none", fontSize: 13, cursor: canUp ? "pointer" : "default", color: canUp ? "#555" : "#ddd", padding: "2px 4px" }}>↑</button>
                    <button onClick={() => moveSectionDown(s.id)} disabled={!canDown} style={{ background: "transparent", border: "none", fontSize: 13, cursor: canDown ? "pointer" : "default", color: canDown ? "#555" : "#ddd", padding: "2px 4px" }}>↓</button>
                  </>)}
                </div>

                <div />

                {/* ✕ */}
                <div style={{ display: "flex", justifyContent: "center" }}>
                  {!isFixed && (
                    <button onClick={() => delSec(s.id)}
                      style={{ background: "transparent", border: "none", color: "#ccc", fontSize: 15, cursor: "pointer", padding: "2px 4px" }}
                      onMouseEnter={e => e.currentTarget.style.color = "#c55"}
                      onMouseLeave={e => e.currentTarget.style.color = "#ccc"}>✕</button>
                  )}
                </div>
              </div>
              </Fragment>
            );
          })}

          {/* Нижня панель */}
          <div style={{ padding: "10px 14px", background: "#f5f2eb", borderTop: "1px solid #e4dfd4", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ fontSize: 12, fontFamily: "'Spectral',serif", color: pagesOk ? "#5a8a2a" : "#c03030", fontWeight: "bold", marginRight: 4 }}>
              {totalP} / {targetPages} стор. {pagesOk ? "✓" : "⚠"}
            </span>
            <button onClick={addChapter}
              style={{ background: "transparent", border: "1.5px dashed #8ab060", color: "#6a9030", borderRadius: 6, padding: "6px 16px", fontFamily: "'Spectral',serif", fontSize: 12, cursor: "pointer", letterSpacing: "0.5px" }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = "#3a6010"; e.currentTarget.style.color = "#3a6010"; }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = "#8ab060"; e.currentTarget.style.color = "#6a9030"; }}>
              + Розділ
            </button>
            <button onClick={addSubsection}
              style={{ background: "transparent", border: "1.5px dashed #bbb4a0", color: "#888", borderRadius: 6, padding: "6px 16px", fontFamily: "'Spectral',serif", fontSize: 12, cursor: "pointer", letterSpacing: "0.5px" }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = "#1a1a14"; e.currentTarget.style.color = "#1a1a14"; }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = "#bbb4a0"; e.currentTarget.style.color = "#888"; }}>
              + Підрозділ
            </button>
            <button onClick={recalcPages}
              style={{ background: "transparent", border: "1.5px dashed #a0a0a0", color: "#888", borderRadius: 6, padding: "6px 12px", fontFamily: "'Spectral',serif", fontSize: 11, cursor: "pointer", whiteSpace: "nowrap" }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = "#555"; e.currentTarget.style.color = "#555"; }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = "#a0a0a0"; e.currentTarget.style.color = "#888"; }}>
              ⟳ стор.
            </button>
          </div>
        </div>

        {/* Кнопка назв для заглушок */}
        {hasPlaceholders && (
          <div style={{ marginBottom: 14 }}>
            <GreenBtn onClick={doNameAllPlaceholders} disabled={namingAllLoading} loading={namingAllLoading} msg="Генерую назви..." label="✨ Придумати назви для заглушок" />
          </div>
        )}

        {error && <div style={{ color: "#c55", fontSize: 13, marginBottom: 12 }}>{error}</div>}
        <div style={{ display: "flex", gap: 12 }}>
          <NavBtn onClick={() => setStage("parsed")}>← Назад</NavBtn>
          <PrimaryBtn
            onClick={() => { saveToFirestore({ sections, stage: "sources", status: "new" }); goToStage("sources"); }}
            disabled={running}
            label="Далі → Джерела"
          />
        </div>
      </div>
    );
  };

  // ─── РЕНДЕР: крок 3 — Джерела ───────────────────────────────────────────────
  const renderSources = () => {
    const mainSecs = sections.filter(s => !["sources", "intro", "conclusions"].includes(s.id) && !/додат/i.test(s.label || ""));
    const sourceTarget = calcSourceTarget(mainSecs);
    const sourceDist = calcSourceDist(mainSecs, sourceTarget);
    // minPerSec-підлога в calcSourceDist може дати суму дистрибуції вище sourceTarget
    // (напр. багато підрозділів при малому обсязі) — показуємо користувачу фактичну суму,
    // а не недосяжну вихідну ціль
    const sourceTotalActual = Object.values(sourceDist).reduce((a, b) => a + b, 0) || sourceTarget;
    const allRefs = (() => {
      const deduper = createReferenceDeduper();
      mainSecs.forEach(sec => (citInputs[sec.id] || "").split("\n").map(l => l.trim()).filter(Boolean).forEach(l => deduper.add(l)));
      return deduper.canonicalRefs;
    })();
    const hasGeneratedContent = Object.keys(content).some(id => content[id]);
    const info = getPracticeInfo();

    return (
      <div className="fade">
        {error && <div style={{ color: "#c55", fontSize: 13, marginBottom: 12 }}>{error}</div>}
        <SourcesStage
          mainSections={mainSecs}
          readyWorkImportedIds={[]}
          citInputs={citInputs} setCitInputs={setCitInputs}
          citStructured={citStructured} setCitStructured={setCitStructured}
          sourceDist={sourceDist} sourceTotal={sourceTotalActual}
          keywords={keywords} kwLoading={kwLoading}
          kwError={kwError} setKwError={setKwError}
          onStopSearch={doStopSearch}
          methodInfo={methodInfo} commentAnalysis={null}
          citStyleOverride={citStyle} sourcesOrderOverride={sourcesOrder}
          onCitStyleChange={v => { setCitStyle(v); saveToFirestore({ citStyle: v }); }}
          onSourcesOrderChange={v => { setSourcesOrder(v); saveToFirestore({ sourcesOrder: v }); }}
          citFootnotes={citFootnotes}
          onCitFootnotesChange={v => { setCitFootnotes(v); saveToFirestore({ citFootnotes: v }); }}
          pageByContent={pageByContent}
          onPageByContentChange={v => { setPageByContent(v); saveToFirestore({ pageByContent: v }); }}
          allRefs={allRefs} refList={refList}
          showMissingSources={false}
          citInputsSnapshot={null} allCitLoading={false}
          info={info} doGenKeywords={doGenKeywords}
          suggestedSources={suggestedSources}
          phraseGroups={phraseGroups}
          sourcesSearchLoading={sourcesSearchLoading}
          sourcesSearchError={sourcesSearchError}
          doSearchSources={doSearchSources}
          doRegenSectionSources={doRegenSectionSources}
          doExpandYearsSection={doExpandYearsSection}
          onAddAbstracts={onAddAbstracts}
          onFinish={async () => { await doFinalizeSources(); goToStage("writing"); }}
          remapLoading={running}
          onProceedToWriting={() => goToStage("writing")}
          setStage={setStage}
          onSave={() => saveToFirestore({ citInputs, citStructured, abstractsMap, suggestedSources, phraseGroups, keywords })}
          saving={saving}
          hasGeneratedContent={hasGeneratedContent}
          onRegenWithNewSources={() => {
            if (hasGeneratedContent && !window.confirm("Переписати всю роботу з нуля з новими джерелами? Поточний текст буде замінено.")) return;
            saveToFirestore({ citInputs, stage: "writing", status: "plan_approved" });
            goToStage("writing");
            doWrite(0);
          }}
        />
      </div>
    );
  };

  // ─── РЕНДЕР: крок 4 — Написання ─────────────────────────────────────────────
  const renderWriting = () => {
    const writableSecs = sections.filter(s => s.id !== "sources");
    const doneCount = writableSecs.filter(s => content[s.id]).length;
    const progress = writableSecs.length ? Math.round(doneCount / writableSecs.length * 100) : 0;
    const allDone = doneCount === writableSecs.length;
    const effectiveCitStyle = getEffectiveCitStyle();
    const effectiveSourcesOrder = getEffectiveSourcesOrder();

    return (
      <div className="fade">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16, flexWrap: "wrap", gap: 10 }}>
          <Heading style={{ marginBottom: 0 }}>Написання</Heading>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {running ? (
              <button onClick={() => { runningRef.current = false; setRunning(false); setLoadMsg(""); }}
                style={{ background: "#c55", color: "#fff", border: "none", borderRadius: 6, padding: "7px 16px", fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>
                Зупинити
              </button>
            ) : !allDone ? (
              <GreenBtn onClick={() => doWrite(genIdx)} disabled={running} label="Продовжити генерацію →" />
            ) : null}
          </div>
        </div>

        {/* Прогрес-бар */}
        <div style={{ background: "#e0ddd4", borderRadius: 6, height: 8, marginBottom: 20, overflow: "hidden" }}>
          <div style={{ height: "100%", background: "#8ac040", borderRadius: 6, width: `${progress}%`, transition: "width 0.5s" }} />
        </div>
        {running && loadMsg && (
          <div style={{ fontSize: 12, color: "#888", marginBottom: 16, display: "flex", alignItems: "center", gap: 8 }}><SpinDot />{loadMsg}</div>
        )}
        {error && <div style={{ color: "#c55", fontSize: 13, marginBottom: 12 }}>{error}</div>}

        {writableSecs.map((sec, idx) => {
          const secContent = content[sec.id];
          const isGenerating = running && genIdx === idx;
          const isRegen = regenId === sec.id;
          const showChapterDivider = sec.sectionTitle && sec.sectionTitle !== writableSecs[idx - 1]?.sectionTitle;
          return (
            <Fragment key={sec.id}>
            {showChapterDivider && (
              <div style={{ fontSize: 12, fontWeight: "bold", letterSpacing: "0.5px", color: "#555", margin: "18px 0 8px" }}>{sec.sectionTitle}</div>
            )}
            <div style={{ marginBottom: 20, background: "#fff", borderRadius: 10, padding: "16px 18px", boxShadow: "0 2px 8px rgba(0,0,0,0.05)" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10, gap: 10 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: "#1a1a14" }}>{sec.label}</div>
                <div style={{ display: "flex", gap: 6 }}>
                  {secContent && (
                    <button onClick={() => navigator.clipboard.writeText(secContent)}
                      style={{ background: "#f0ece2", border: "none", borderRadius: 5, padding: "4px 10px", fontSize: 11, cursor: "pointer" }}>
                      Копіювати
                    </button>
                  )}
                  {!isGenerating && (
                    <button onClick={() => setRegenId(isRegen ? null : sec.id)} disabled={running}
                      style={{ background: "#e8f0ff", border: "1.5px solid #4a9ade44", color: "#1a5a8a", borderRadius: 5, padding: "4px 10px", fontSize: 11, cursor: running ? "default" : "pointer", opacity: running ? 0.5 : 1 }}>
                      {secContent ? "Перегенерувати" : "Згенерувати"}
                    </button>
                  )}
                  {isGenerating && <span style={{ fontSize: 11, color: "#888", display: "flex", alignItems: "center", gap: 5 }}><SpinDot />Генерую...</span>}
                </div>
              </div>

              {isRegen && (
                <div style={{ marginBottom: 10 }}>
                  <textarea value={regenPrompt} onChange={e => setRegenPrompt(e.target.value)}
                    placeholder="Додаткові вимоги (необов'язково)..."
                    style={{ ...TA_WHITE, minHeight: 50, width: "100%", marginBottom: 6 }} />
                  <div style={{ display: "flex", gap: 8 }}>
                    <GreenBtn onClick={() => doRegenSection(sec.id)} disabled={regenLoading} loading={regenLoading} msg="Генерую..." label="Перегенерувати" />
                    <NavBtn onClick={() => { setRegenId(null); setRegenPrompt(""); }}>Скасувати</NavBtn>
                  </div>
                </div>
              )}

              {secContent ? (
                <textarea value={secContent}
                  onChange={e => setContent(prev => { const next = { ...prev, [sec.id]: e.target.value }; saveToFirestore({ content: next }); return next; })}
                  style={{ ...TA_WHITE, minHeight: 200, width: "100%" }} />
              ) : (
                <div style={{ fontSize: 12, color: "#aaa", padding: "20px 0", textAlign: "center" }}>
                  {isGenerating ? "Генерується..." : "Ще не згенеровано"}
                </div>
              )}
            </div>
            </Fragment>
          );
        })}

        {allDone && (
          <div style={{ border: "1.5px solid #d4cfc4", borderRadius: 8, padding: "10px 14px", display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginTop: 16, marginBottom: 10, fontSize: 12 }}>
            <span style={{ color: "#888" }}>Оформлення:</span>
            <span style={{ color: "#888" }}>Стиль</span>
            {["ДСТУ 8302:2015", "APA", "MLA"].map(s => (
              <button key={s} type="button" onClick={() => setCitStyle(s)}
                style={{ padding: "4px 10px", borderRadius: 6, fontSize: 11, cursor: "pointer", background: effectiveCitStyle === s ? "#1a1a14" : "#f0ece2", color: effectiveCitStyle === s ? "#e8ff47" : "#333", border: `1px solid ${effectiveCitStyle === s ? "#1a1a14" : "#d4cfc4"}` }}>
                {s}
              </button>
            ))}
            <span style={{ color: "#888", marginLeft: 8 }}>Порядок</span>
            {[{ key: "alphabetical", label: "Алфавіт" }, { key: "appearance", label: "За порядком" }].map(o => (
              <button key={o.key} type="button" onClick={() => setSourcesOrder(o.key)}
                style={{ padding: "4px 10px", borderRadius: 6, fontSize: 11, cursor: "pointer", background: effectiveSourcesOrder === o.key ? "#1a1a14" : "#f0ece2", color: effectiveSourcesOrder === o.key ? "#e8ff47" : "#333", border: `1px solid ${effectiveSourcesOrder === o.key ? "#1a1a14" : "#d4cfc4"}` }}>
                {o.label}
              </button>
            ))}
            <GreenBtn onClick={() => doFinalizeSources()} disabled={running} loading={running} msg={loadMsg || "Формую..."} label="Переформувати список літератури" />
          </div>
        )}

        {refList && (
          <div style={{ background: "#fff", borderRadius: 10, padding: "16px 18px", boxShadow: "0 2px 8px rgba(0,0,0,0.05)", marginBottom: 20 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "#1a1a14", marginBottom: 8 }}>Список використаних джерел:</div>
            <div style={{ fontSize: 12, whiteSpace: "pre-wrap", color: "#333", lineHeight: 1.7 }}>{renderRefListWithLinks(refList)}</div>
          </div>
        )}

        {/* Кнопка завантаження доступна як тільки є хоч одна секція */}
        {Object.keys(content).length > 0 && (
          <div style={{ display: "flex", gap: 10, marginTop: 16, padding: "14px 18px", background: "#f0f5e8", border: "1.5px solid #c8dfa0", borderRadius: 8 }}>
            <GreenBtn onClick={doExportMain} disabled={docxLoading || webImg.webImagesBusy} loading={docxLoading} msg="Завантажую..." label={webImg.webImagesBusy ? "Підбираю фото…" : "⬇ Завантажити звіт .docx"} />
          </div>
        )}

        {allDone && (
          <div style={{ display: "flex", gap: 12, marginTop: 12 }}>
            <NavBtn onClick={() => setStage("sources")}>← Назад</NavBtn>
            <PrimaryBtn
              onClick={() => {
                saveToFirestore({ content, stage: "diary", status: "writing" });
                goToStage("diary");
                // текст звіту остаточний — фото для рисунків-заглушок підбираються у фоні, раз на замовлення
                webImg.searchAll({ content, sections, lang: language, topic, auto: true })
                  .catch(e => console.error("webImages:", e.message));
              }}
              label="Далі → Щоденник"
            />
          </div>
        )}
      </div>
    );
  };

  // ─── РЕНДЕР: крок 5 — Щоденник ──────────────────────────────────────────────
  const renderDiary = () => (
    <div className="fade">
      <Heading>Щоденник практики</Heading>
      <p style={{ fontSize: 13, color: "#888", marginBottom: 16 }}>
        Щоденник автоматично формується по робочих днях у межах вказаних строків практики.
      </p>

      {error && <div style={{ color: "#c55", fontSize: 13, marginBottom: 12 }}>{error}</div>}

      {running && loadMsg && (
        <div style={{ fontSize: 12, color: "#888", marginBottom: 16, display: "flex", alignItems: "center", gap: 8 }}><SpinDot />{loadMsg}</div>
      )}

      <div style={{ display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
        <GreenBtn onClick={doGenerateDiary} disabled={running} loading={running} msg="Генерую..." label="Згенерувати щоденник" />
        {diaryContent && (<>
          <button onClick={() => navigator.clipboard.writeText(diaryContent)}
            style={{ background: "#f0ece2", border: "1.5px solid #d4cfc4", color: "#555", borderRadius: 7, padding: "9px 16px", fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>
            Копіювати
          </button>
          <GreenBtn onClick={doExportDiary} disabled={diaryDocxLoading} loading={diaryDocxLoading} msg="Завантажую..." label="⬇ Щоденник .docx" />
        </>)}
      </div>

      {diaryContent && (
        <div style={{ marginBottom: 20 }}>
          <div style={{ background: "#fff", borderRadius: 10, padding: "14px 16px", boxShadow: "0 2px 8px rgba(0,0,0,0.05)", marginBottom: 10, fontSize: 13, lineHeight: 1.7 }}>
            {renderWithTables(diaryContent)}
          </div>
          <FieldBox label="Редагувати щоденник">
            <textarea value={diaryContent}
              onChange={e => { setDiaryContent(e.target.value); saveToFirestore({ diaryContent: e.target.value }); }}
              style={{ ...TA_WHITE, minHeight: 300, width: "100%", fontSize: 12 }} />
          </FieldBox>
        </div>
      )}

      <div style={{ display: "flex", gap: 12 }}>
        <NavBtn onClick={() => setStage("writing")}>← Назад</NavBtn>
        <PrimaryBtn
          onClick={() => { saveToFirestore({ diaryContent, stage: "done", status: "done" }); goToStage("done"); }}
          disabled={!diaryContent}
          label="Далі → Готово"
        />
      </div>
    </div>
  );

  // ─── РЕНДЕР: крок 6 — Готово ─────────────────────────────────────────────────
  const renderDone = () => {
    const writableSecs = sections.filter(s => s.id !== "sources");
    return (
      <div className="fade">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20, flexWrap: "wrap", gap: 10 }}>
          <Heading style={{ marginBottom: 0 }}>Готово</Heading>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button onClick={doCopyAll}
              style={{ background: "#f0ece2", border: "1.5px solid #d4cfc4", color: "#555", borderRadius: 7, padding: "9px 16px", fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>
              Копіювати текст
            </button>
            <GreenBtn onClick={doExportMain} disabled={docxLoading || webImg.webImagesBusy} loading={docxLoading} msg="Завантажую..." label={webImg.webImagesBusy ? "Підбираю фото…" : "⬇ Звіт .docx"} />
            {diaryContent && (
              <GreenBtn onClick={doExportDiary} disabled={diaryDocxLoading} loading={diaryDocxLoading} msg="Завантажую..." label="⬇ Щоденник .docx" />
            )}
          </div>
        </div>

        {error && <div style={{ color: "#c55", fontSize: 13, marginBottom: 12 }}>{error}</div>}

        {writableSecs.map(sec => (
          <div key={sec.id} style={{ marginBottom: 16, background: "#fff", borderRadius: 10, padding: "16px 18px", boxShadow: "0 2px 8px rgba(0,0,0,0.05)" }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "#888", letterSpacing: 1, textTransform: "uppercase", marginBottom: 8 }}>{sec.label}</div>
            <textarea
              value={content[sec.id] || ""}
              onChange={e => setContent(prev => { const next = { ...prev, [sec.id]: e.target.value }; saveToFirestore({ content: next }); return next; })}
              style={{ ...TA_WHITE, minHeight: 160, width: "100%" }}
            />
          </div>
        ))}

        <div style={{ marginBottom: 16 }}>
          <WebImagesPanel
            figs={findPlaceholderFigures({ content, sections, lang: language })} wi={webImg}
            onSearchAll={() => webImg.searchAll({ content, sections, lang: language, topic }).catch(e => console.error("webImages:", e.message))}
            onSearchOne={(fig) => webImg.searchOne(fig, { lang: language, topic })}
          />
        </div>

        {diaryContent && (
          <div style={{ marginBottom: 16, background: "#fff", borderRadius: 10, padding: "16px 18px", boxShadow: "0 2px 8px rgba(0,0,0,0.05)" }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "#888", letterSpacing: 1, textTransform: "uppercase", marginBottom: 8 }}>Щоденник практики</div>
            <div style={{ fontSize: 13, lineHeight: 1.7 }}>{renderWithTables(diaryContent)}</div>
          </div>
        )}

        {refList && (
          <div style={{ marginBottom: 16, background: "#fff", borderRadius: 10, padding: "16px 18px", boxShadow: "0 2px 8px rgba(0,0,0,0.05)" }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "#888", letterSpacing: 1, textTransform: "uppercase", marginBottom: 8 }}>Список використаних джерел</div>
            <div style={{ fontSize: 12, whiteSpace: "pre-wrap", lineHeight: 1.7 }}>{renderRefListWithLinks(refList)}</div>
          </div>
        )}
      </div>
    );
  };

  // ─── Спільні стилі ────────────────────────────────────────────────────────────
  const inputStyle = {
    width: "100%", padding: "9px 12px", border: "1.5px solid #d4cfc4", borderRadius: 6,
    fontSize: 13, fontFamily: "'Spectral',Georgia,serif", background: "#fff", color: "#1a1a14", outline: "none",
  };
  const thStyle = { padding: "10px 12px", fontSize: 11, color: "#888", fontWeight: 600, letterSpacing: 1, textTransform: "uppercase" };
  const tdStyle = { padding: "10px 12px", fontSize: 13, verticalAlign: "middle" };

  // ─── Головний рендер ─────────────────────────────────────────────────────────
  if (dbLoading) {
    return (
      <div style={{ minHeight: "100vh", background: "#f5f2eb", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <SpinDot />
      </div>
    );
  }

  return (
    <div style={{ minHeight: "100vh", background: "#f5f2eb", fontFamily: "'Spectral',Georgia,serif" }}>
      <style>{`${SHARED_STYLES} @import url('https://fonts.googleapis.com/css2?family=Spectral:wght@400;600&family=Spectral+SC:wght@600&display=swap');*{box-sizing:border-box;margin:0;padding:0}.fade{animation:fd .25s ease}`}</style>
      {renderHeader()}
      <div style={{ maxWidth: 900, margin: "0 auto", padding: "32px clamp(16px,3vw,40px)" }}>
        {stage === "input"   && renderInput()}
        {stage === "parsed"  && renderParsed()}
        {stage === "plan"    && renderPlan()}
        {stage === "sources" && renderSources()}
        {stage === "writing" && renderWriting()}
        {stage === "diary"   && renderDiary()}
        {stage === "done"    && renderDone()}
      </div>

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
