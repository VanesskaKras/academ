import { useState, useRef, useEffect } from "react";
import { db } from "./firebase";
import { useAuth } from "./AuthContext";
import { doc, getDoc, setDoc } from "firebase/firestore";
import { MODEL, MODEL_FAST, callClaude, callGemini, resetGenerationCost } from "./lib/api.js";
import { buildSYSSmall, buildSmallWorkFormattingPrompt, buildReferatAnnotationPrompt } from "./lib/prompts.js";
import { searchSourcesForSection, buildSemanticKeywords, generateSearchPhrases, paperToCitation, filterSourcesWithGemini, enrichSources } from "./lib/sourcesSearch.js";
import { runSourcesStage } from "./lib/orderStages.js";
import { remapAndFormatCitations, applyCitationRemap, detectSourceGrouping, createReferenceDeduper, insertMissingCitations, capCitationRepeats, isLawSource, extractCitedNumbers, citationMarkerWithPage } from "./lib/citationFormatting.js";
import { buildContentPagePickers } from "./lib/contentPages.js";
import { serializeForFirestore } from "./lib/firestoreUtils.js";
import { playDoneSound } from "./lib/audio.js";
import { enforceWordCount, enforceTotalVolume } from "./lib/wordCount.js";
import { SpinDot, Shimmer } from "./components/SpinDot.jsx";
import { FieldBox, Heading, NavBtn, PrimaryBtn, GreenBtn, SaveIndicator } from "./components/Buttons.jsx";
import { DropZone } from "./components/DropZone.jsx";
import { DeptGuidanceZone } from "./components/DeptGuidanceZone.jsx";
import { ExampleFileZone } from "./components/ExampleFileZone.jsx";
import { parsePagesAvg, TA, TA_WHITE, SHARED_STYLES } from "./shared.jsx";
import { getLangLabels, getSourcesMinFromTable, extractPlanBlock, chapterWordRe, chapterHeadingPrefix, normLangName, sourcesHeading, matchSourcesBlock, isSourcesTitle } from "./lib/planUtils.js";
import { typographQuotes, stripStrayCJK } from "./lib/textCleanup.js";
import { fixDanglingFigures, fixMissingTableConclusion, dedupeRepeatedFigures } from "./lib/figureFixup.js";
import { findPlaceholderFigures, findSlideImageSlots, resolveSlideWebImages, SIMPLE_WORK_SECTION_ID } from "./lib/webImages.js";
import { useWebImages } from "./lib/useWebImages.js";
import { useLangProfile } from "./lib/useLangProfile.js";
import { WebImagesPanel } from "./components/WebImagesPanel.jsx";
import mammoth from "mammoth";
import { exportToDocx, exportSpeechToDocx, exportSimpleDocx } from "./lib/exportDocx.js";
import { SYS_JSON_SHORT } from "./lib/prompts.js";
import { exportToPptxFile } from "./lib/exportPptx.js";
import { DesignSelector, PresentationDownload } from "./components/PresentationDesignPicker.jsx";
import { renderPlantUmlToPng } from "./lib/diagramRender.js";
import { extractPptxText } from "./lib/pptxText.js";
import { ChecklistStage } from "./components/stages/ChecklistStage.jsx";

// ── Видаляємо довге тире на всякий випадок (модель іноді ігнорує заборону з промпту) ──
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
      const result = await mammoth.extractRawText({ arrayBuffer: bytes.buffer });
      return { type: "text", text: `[Файл: ${f.name}]\n\n${result.value.trim()}` };
    } catch {
      return { type: "text", text: `[Файл: ${f.name}] — не вдалося прочитати вміст.` };
    }
  }
  return { type: "document", source: { type: "base64", media_type: "application/pdf", data: f.b64 } };
}

const toClaudeFilesAsync = files => Promise.all(files.map(toClaudeFileAsync));

// ── Рендер тексту з markdown-таблицями ──
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
    if (seg.type === "text") {
      return <span key={si} style={{ whiteSpace: "pre-wrap" }}>{seg.content}</span>;
    }
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

// ── Компонент-панель налаштувань оформлення джерел ──
function SmCitSettings({ effectiveCitStyle, effectiveSourcesOrder, citStyleOverride, sourcesOrderOverride, onCitStyleChange, onSourcesOrderChange, citFootnotes, onCitFootnotesChange, pageByContent, onPageByContentChange }) {
  const isDstu = effectiveCitStyle === "ДСТУ 8302:2015";
  return (
    <div style={{ padding: "10px 14px", background: "#f5f2eb", border: "1.5px solid #d4cfc4", borderRadius: 8, marginBottom: 16, display: "flex", gap: 16, flexWrap: "wrap", alignItems: "center" }}>
      <span style={{ fontSize: 11, color: "#666", fontWeight: 600, flexShrink: 0 }}>Оформлення:</span>
      <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
        <span style={{ fontSize: 11, color: "#888" }}>Стиль</span>
        {["ДСТУ 8302:2015", "APA", "MLA"].map(s => {
          const active = effectiveCitStyle === s;
          return (
            <button key={s} onClick={() => onCitStyleChange(s)}
              style={{ fontSize: 11, padding: "3px 10px", borderRadius: 5, border: `1.5px solid ${active ? "#1a1a14" : "#c8c2b5"}`, background: active ? "#1a1a14" : "transparent", color: active ? "#f5f2eb" : "#555", cursor: "pointer", fontFamily: "inherit" }}>
              {s}
            </button>
          );
        })}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
        <span style={{ fontSize: 11, color: "#888" }}>Порядок</span>
        {[["alphabetical", "🔤 Алфавіт"], ["appearance", "🔢 За порядком"]].map(([val, label]) => {
          const active = effectiveSourcesOrder === val;
          return (
            <button key={val} onClick={() => onSourcesOrderChange(val)}
              style={{ fontSize: 11, padding: "3px 10px", borderRadius: 5, border: `1.5px solid ${active ? "#1a1a14" : "#c8c2b5"}`, background: active ? "#1a1a14" : "transparent", color: active ? "#f5f2eb" : "#555", cursor: "pointer", fontFamily: "inherit" }}>
              {label}
            </button>
          );
        })}
      </div>
      {isDstu && (
        <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <span style={{ fontSize: 11, color: "#888" }}>Посилання</span>
          {[[false, "У тексті"], [true, "Виноски"]].map(([val, label]) => {
            const active = !!citFootnotes === val;
            return (
              <button key={String(val)} onClick={() => onCitFootnotesChange(val)}
                style={{ fontSize: 11, padding: "3px 10px", borderRadius: 5, border: `1.5px solid ${active ? "#1a1a14" : "#c8c2b5"}`, background: active ? "#1a1a14" : "transparent", color: active ? "#f5f2eb" : "#555", cursor: "pointer", fontFamily: "inherit" }}>
                {label}
              </button>
            );
          })}
        </div>
      )}
      {onPageByContentChange && !citFootnotes && (
        <div style={{ display: "flex", alignItems: "center", gap: 5 }}
          title="«За змістом PDF»: сторінка кожного посилання обирається там, де в PDF статті найбільше збігів з реченням перед посиланням (без ШІ). Без PDF чи при слабкому збігу — як звичайно, з діапазону сторінок джерела.">
          <span style={{ fontSize: 11, color: "#888" }}>Сторінка в посиланні</span>
          {[[false, "З діапазону"], [true, "За змістом PDF"]].map(([val, label]) => {
            const active = !!pageByContent === val;
            return (
              <button key={String(val)} onClick={() => onPageByContentChange(val)}
                style={{ fontSize: 11, padding: "3px 10px", borderRadius: 5, border: `1.5px solid ${active ? "#1a1a14" : "#c8c2b5"}`, background: active ? "#1a1a14" : "transparent", color: active ? "#f5f2eb" : "#555", cursor: "pointer", fontFamily: "inherit" }}>
                {label}
              </button>
            );
          })}
        </div>
      )}
      {(citStyleOverride || sourcesOrderOverride) && (
        <span style={{ fontSize: 10, color: "#e8a050", display: "flex", alignItems: "center", gap: 4 }}>
          ✏ змінено вручну ·{" "}
          <button onClick={() => { onCitStyleChange(null); onSourcesOrderChange(null); }}
            style={{ fontSize: 10, background: "transparent", border: "none", color: "#e8a050", cursor: "pointer", textDecoration: "underline", padding: 0, fontFamily: "inherit" }}>
            скинути
          </button>
        </span>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────
// Конфіг типів робіт
// ─────────────────────────────────────────────
const WORK_TYPES = {
  referat: {
    label: "Реферат",
    icon: "📄",
    hasplan: true,
    stages: ["Дані", "План", "Джерела", "Генерація", "Готово", "Чек-лист"],
    stageKeys: ["input", "plan", "sources", "writing", "done", "checklist"],
    color: "#1a5a8a",
    bg: "#e4f0ff",
  },
  tezy: {
    label: "Тези",
    icon: "📝",
    hasplan: false,
    stages: ["Дані", "Джерела", "Генерація", "Готово", "Чек-лист"],
    stageKeys: ["input", "sources", "writing", "done", "checklist"],
    color: "#5a1a8a",
    bg: "#f0e4ff",
  },
  stattia: {
    label: "Стаття",
    icon: "📰",
    hasplan: false,
    stages: ["Дані", "Джерела", "Генерація", "Готово", "Чек-лист"],
    stageKeys: ["input", "sources", "writing", "done", "checklist"],
    color: "#1a6a1a",
    bg: "#e4ffe4",
  },
  ese: {
    label: "Есе",
    icon: "✍️",
    hasplan: false,
    stages: ["Дані", "Джерела", "Генерація", "Готово", "Чек-лист"],
    stageKeys: ["input", "sources", "writing", "done", "checklist"],
    color: "#8a5a1a",
    bg: "#fff5e4",
  },
  prezentatsiya: {
    label: "Презентація",
    icon: "🎞️",
    hasplan: false,
    stages: ["Дані", "Джерела", "Генерація", "Готово", "Чек-лист"],
    stageKeys: ["input", "sources", "writing", "done", "checklist"],
    color: "#8a1a1a",
    bg: "#ffe4e4",
  },
  dopovid: {
    label: "Доповідь та презентація",
    icon: "🎤",
    hasplan: false,
    stages: ["Дані", "Готово"],
    stageKeys: ["input", "done"],
    color: "#6a1a8a",
    bg: "#f5e4ff",
  },
};

// ─────────────────────────────────────────────
// StagePills для малих робіт (динамічні)
// ─────────────────────────────────────────────
function StagePills({ stage, workType, onNavigate, maxStageIdx = 0 }) {
  const cfg = WORK_TYPES[workType] || WORK_TYPES.tezy;
  const cur = cfg.stageKeys.indexOf(stage);
  return (
    <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
      {cfg.stages.map((l, i) => {
        const visited = i <= maxStageIdx;
        const clickable = i !== cur && visited && onNavigate;
        return (
          <div key={i}
            onClick={clickable ? () => onNavigate(cfg.stageKeys[i]) : undefined}
            style={{ padding: "4px 12px", borderRadius: 20, fontSize: 11, letterSpacing: "1px", cursor: clickable ? "pointer" : "default", background: i === cur ? "#e8ff47" : visited ? "#1e2a00" : "transparent", color: i === cur ? "#111" : visited ? "#6a9000" : "#555", border: `1px solid ${i === cur ? "#e8ff47" : visited ? "#3a5000" : "#444"}` }}>
            {visited && i !== cur ? "✓ " : ""}{l}
          </div>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────
// Вибір типу роботи
// ─────────────────────────────────────────────
function WorkTypeSelector({ onSelect }) {
  return (
    <div className="fade">
      <Heading>Оберіть тип роботи</Heading>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 12 }}>
        {Object.entries(WORK_TYPES).map(([key, cfg]) => (
          <div key={key} onClick={() => onSelect(key)}
            style={{ border: `1.5px solid ${cfg.color}33`, borderRadius: 10, padding: "20px 16px", textAlign: "center", cursor: "pointer", background: cfg.bg, transition: "all .15s" }}
            onMouseEnter={e => { e.currentTarget.style.transform = "translateY(-2px)"; e.currentTarget.style.boxShadow = "0 4px 16px rgba(0,0,0,0.10)"; }}
            onMouseLeave={e => { e.currentTarget.style.transform = ""; e.currentTarget.style.boxShadow = ""; }}>
            <div style={{ fontSize: 32, marginBottom: 8 }}>{cfg.icon}</div>
            <div style={{ fontSize: 14, fontWeight: 600, color: cfg.color }}>{cfg.label}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// Головний компонент
// ─────────────────────────────────────────────
export default function SmallWorks({ orderId, onOrderCreated, onBack }) {
  const { user, profile } = useAuth();
  const isAdmin = profile?.role === "admin";

  // ── Стан ──
  const [workType, setWorkType] = useState(null);
  const [stage, setStage] = useState("input");
  // ── Автоматичний режим (реферат): один клік проганяє Аналіз→План→Джерела→Написання
  // без ручних воріт, за зразком runAutoPipeline у academic-assistant.jsx. Написання→Готово
  // вже автоматичне (useEffect на stage==="writing"), тож оркестратор лише доводить до
  // setStage("writing") і завершується — решту довершує наявний конвеєр ──
  const [autoRunning, setAutoRunning] = useState(false);
  const [autoStepLabel, setAutoStepLabel] = useState("");
  const [autoError, setAutoError] = useState(null); // { step, message }
  const autoModeRef = useRef(false);
  const [tplText, setTplText] = useState("");
  const [comment, setComment] = useState("");
  const [clientPlan, setClientPlan] = useState("");
  const [info, setInfo] = useState(null);

  // Файли (рекомендації/скріни) — до 3 штук (до 10 для тез)
  const [files, setFiles] = useState([]); // [{name, b64, type}]

  // Тези — матеріал для роботи (текст + файли що аналізуються при генерації)
  const [materialText, setMaterialText] = useState("");
  const [materialFiles, setMaterialFiles] = useState([]); // [{name, b64, type}]
  // Додаткові рекомендації кафедри/викладача (текст або фото/скріншоти — не офіційна методичка) — для реферату
  const [deptGuidanceText, setDeptGuidanceText] = useState("");
  // Зразок структури реферату (docx/pdf) — текст витягується одразу при завантаженні
  const [structureExampleName, setStructureExampleName] = useState("");
  const [structureExampleText, setStructureExampleText] = useState("");
  // Зразок есе (docx/pdf) — стиль викладу, аргументація й оформлення, текст витягується одразу при завантаженні
  const [essayExampleName, setEssayExampleName] = useState("");
  const [essayExampleText, setEssayExampleText] = useState("");
  const [instrFiles, setInstrFiles] = useState([]); // презентація — файли з інструкціями оформлення

  // Тези — дані автора
  const [authorData, setAuthorData] = useState({ authorName: "", supervisor: "", university: "", faculty: "", role: "", email: "" });
  const [authorDataOpen, setAuthorDataOpen] = useState(false);
  const [authorRawText, setAuthorRawText] = useState("");
  const [authorRecognizing, setAuthorRecognizing] = useState(false);

  // Тези — джерела
  const [tezyPapers, setTezyPapers] = useState([]);
  const [selectedTezyIds, setSelectedTezyIds] = useState([]);
  const [tezySearchLoading, setTezySearchLoading] = useState(false);
  const [tezyCitations, setTezyCitations] = useState([]);
  const [tezyPage, setTezyPage] = useState(1);
  const [citText, setCitText] = useState("");        // текстове поле джерел (tezy/stattia/ese)
  const [citInputs, setCitInputs] = useState({});   // { secId: "cite1\ncite2" } — для реферату
  const [citStructured, setCitStructured] = useState({}); // { secId: paper[] } — структуровані дані джерел (для форматування); "_main" — для tezy/stattia/ese/prezentatsiya
  const [activeSecId, setActiveSecId] = useState(null); // активна секція на кроці джерел (реферат)
  const [searchPhrases, setSearchPhrases] = useState([]); // фрази для Google Scholar
  const [sourcesSearchDone, setSourcesSearchDone] = useState(false); // автопошук (каскад) для tezy/stattia/ese вже відпрацював

  // Реферат — секції з текстом
  const [sections, setSections] = useState([]); // [{id, label, text, pages, sectionTitle?}] — sectionTitle присутній лише у підрозділах
  const [namingLoading, setNamingLoading] = useState(false);
  const [singleNamingId, setSingleNamingId] = useState(null);
  const [genIdx, setGenIdx] = useState(0);
  const [maxStageIdx, setMaxStageIdx] = useState(0);
  const [running, setRunning] = useState(false);
  const runningRef = useRef(false);
  const genAbortRef = useRef(null); // AbortController активної генерації — для кнопки "Зупинити"

  // Прості роботи — один блок тексту або слайди
  const [result, setResult] = useState(""); // для тез/статті/есе
  const [slides, setSlides] = useState([]); // [{title, content}] для презентації
  const [presDesign, setPresDesign] = useState(null); // дизайн презентації { style, palette }; null — авто

  const [sourcesFormatted, setSourcesFormatted] = useState(false);
  const [annotationUk, setAnnotationUk] = useState(""); // анотація+ключові слова для реферату (лише якщо methodInfo.needsAnnotation)
  const [methodInfo, setMethodInfo] = useState(null);
  const [methodRequirements, setMethodRequirements] = useState("");
  // Per-section джерела для реферату
  const [refSecPapers, setRefSecPapers] = useState({});
  const [refSecPhrases, setRefSecPhrases] = useState({});
  const [refSecLoading, setRefSecLoading] = useState({});
  const [allSecLoading, setAllSecLoading] = useState(false);
  const [allSecProgress, setAllSecProgress] = useState({ done: 0, total: 0 });

  const [loadMsg, setLoadMsg] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [dbLoading, setDbLoading] = useState(false);
  const [citStyleOverride, setCitStyleOverride] = useState(null);        // "ДСТУ 8302:2015" | "APA" | "MLA" | null
  const [sourcesOrderOverride, setSourcesOrderOverride] = useState(null); // "alphabetical" | "appearance" | null
  const [citFootnotes, setCitFootnotes] = useState(false);               // true → ДСТУ-посилання у виносках
  const [pageByContent, setPageByContent] = useState(false);             // true → сторінка в посиланні за змістом PDF джерела
  const [docxLoading, setDocxLoading] = useState(false);
  const [error, setError] = useState("");

  // ── Презентація + доповідь (малі роботи) ──
  const [presLoading, setPresLoading] = useState(false);
  const [presMsg, setPresMsg] = useState("");
  const [presReady, setPresReady] = useState(false);
  const [presSlideJson, setPresSlideJson] = useState(null);
  const [presComment, setPresComment] = useState("");
  const [dopOrderNumber, setDopOrderNumber] = useState("");
  const [presFile, setPresFile] = useState(null); // { name, b64, type }
  const [speechWithLoading, setSpeechWithLoading] = useState(false);
  const [speechWithText, setSpeechWithText] = useState("");
  const [speechLoading, setSpeechLoading] = useState(false);
  const [speechText, setSpeechText] = useState("");

  const currentIdRef = useRef(orderId || null);
  // Фото з інтернету для рисунків-заглушок (src/lib/webImages.js) — orders/{id}/webImages
  const webImg = useWebImages({ getOrderId: () => currentIdRef.current, saveOrderPatch: (patch) => saveToFirestore(patch) });
  const loadWebImages = webImg.load;
  // Есе, тези, стаття — один суцільний текст (result); для пошуку заглушок це один "підрозділ"
  const simpleWebImageArgs = (text) => ({ content: { [SIMPLE_WORK_SECTION_ID]: text || "" }, sections: [{ id: SIMPLE_WORK_SECTION_ID }], lang: info?.language, topic: info?.topic });
  // true, якщо створення документа в Firestore вже підтверджено успішним збереженням
  const createdConfirmedRef = useRef(!!orderId);
  // true, якщо написання реферату вже завершено — щоб повторний візит на вкладку "Написання" не запускав генерацію знову
  const writingDoneRef = useRef(false);
  const tokenAccRef = useRef({ inTok: 0, outTok: 0, costUsd: 0, claudeInTok: 0, claudeOutTok: 0, claudeCostUsd: 0, geminiInTok: 0, geminiOutTok: 0, geminiCostUsd: 0 });

  useEffect(() => {
    const handler = (e) => {
      const isGemini = (e.detail.model || "").startsWith("gemini");
      const dIn = e.detail.inTok || 0, dOut = e.detail.outTok || 0, dCost = e.detail.cost || 0;
      const t = tokenAccRef.current;
      tokenAccRef.current = {
        inTok: t.inTok + dIn, outTok: t.outTok + dOut, costUsd: t.costUsd + dCost,
        claudeInTok:  t.claudeInTok  + (isGemini ? 0 : dIn),
        claudeOutTok: t.claudeOutTok + (isGemini ? 0 : dOut),
        claudeCostUsd: t.claudeCostUsd + (isGemini ? 0 : dCost),
        geminiInTok:  t.geminiInTok  + (isGemini ? dIn  : 0),
        geminiOutTok: t.geminiOutTok + (isGemini ? dOut : 0),
        geminiCostUsd: t.geminiCostUsd + (isGemini ? dCost : 0),
      };
    };
    window.addEventListener("apicost", handler);
    return () => window.removeEventListener("apicost", handler);
  }, []);

  // ── Завантаження існуючого замовлення ──
  useEffect(() => {
    if (!orderId || !user) return;
    const load = async () => {
      setDbLoading(true);
      try {
        const snap = await getDoc(doc(db, "orders", orderId));
        if (snap.exists()) {
          const d = snap.data();
          if (!d.createdAt) createdConfirmedRef.current = false;
          if (d.workType) setWorkType(d.workType);
          if (d.tplText) setTplText(d.tplText);
          if (d.comment) setComment(d.comment);
          if (d.clientPlan) setClientPlan(d.clientPlan);
          if (d.info) setInfo(d.info);
          if (d.sections?.length) setSections(d.sections);
          if (d.result) setResult(d.result);
          if (d.slides?.length) setSlides(d.slides);
          if (d.stage) {
            setStage(d.stage);
            const loadedCfg = WORK_TYPES[d.workType] || WORK_TYPES.tezy;
            setMaxStageIdx(loadedCfg.stageKeys.indexOf(d.stage));
          }
          if (d.genIdx !== undefined) setGenIdx(d.genIdx);
          if (d.status === "done" || (d.sections?.length > 0 && d.genIdx >= d.sections.length)) {
            writingDoneRef.current = true;
          }
          if (d.authorData) setAuthorData(d.authorData);
          if (d.tezyCitations?.length) setTezyCitations(d.tezyCitations);
          if (d.tezyPapers?.length) setTezyPapers(d.tezyPapers);
          if (d.selectedTezyIds?.length) setSelectedTezyIds(d.selectedTezyIds);
          if (d.citText) setCitText(d.citText);
          if (d.citInputs) setCitInputs(d.citInputs);
          if (d.citStructured) setCitStructured(d.citStructured);
          if (d.searchPhrases?.length) setSearchPhrases(d.searchPhrases);
          if (d.sourcesSearchDone) setSourcesSearchDone(true);
          if (d.materialText) setMaterialText(d.materialText);
          if (d.deptGuidanceText) setDeptGuidanceText(d.deptGuidanceText);
          if (d.structureExampleName) setStructureExampleName(d.structureExampleName);
          if (d.structureExampleText) setStructureExampleText(d.structureExampleText);
          if (d.essayExampleName) setEssayExampleName(d.essayExampleName);
          if (d.essayExampleText) setEssayExampleText(d.essayExampleText);
          if (d.instrFiles?.length) setInstrFiles(d.instrFiles);
          if (d.sourcesFormatted) setSourcesFormatted(d.sourcesFormatted);
          loadWebImages(orderId, d.webImagesDone);
          if (d.annotationUk) setAnnotationUk(d.annotationUk);
          if (d.methodInfo) setMethodInfo(d.methodInfo);
          if (d.methodRequirements) setMethodRequirements(d.methodRequirements);
          if (d.citStyleOverride) setCitStyleOverride(d.citStyleOverride);
          if (d.sourcesOrderOverride) setSourcesOrderOverride(d.sourcesOrderOverride);
          if (d.citFootnotes !== undefined) setCitFootnotes(d.citFootnotes);
          if (d.pageByContent !== undefined) setPageByContent(!!d.pageByContent);
          if (d.refSecPapers) setRefSecPapers(d.refSecPapers);
          if (d.refSecPhrases) setRefSecPhrases(d.refSecPhrases);
          if (d.presReady) setPresReady(d.presReady);
          if (d.presSlideJson) setPresSlideJson(d.presSlideJson);
          if (d.speechWithText) setSpeechWithText(d.speechWithText);
          if (d.speechText) setSpeechText(d.speechText);
          if (d.presComment) setPresComment(d.presComment);
          if (d.info?.orderNumber) setDopOrderNumber(d.info.orderNumber);
          if (d.totalInTok !== undefined) {
            tokenAccRef.current = {
              inTok: d.totalInTok || 0, outTok: d.totalOutTok || 0, costUsd: d.totalCostUsd || 0,
              claudeInTok: d.claudeInTok || 0, claudeOutTok: d.claudeOutTok || 0, claudeCostUsd: d.claudeCostUsd || 0,
              geminiInTok: d.geminiInTok || 0, geminiOutTok: d.geminiOutTok || 0, geminiCostUsd: d.geminiCostUsd || 0,
            };
          }
        } else {
          createdConfirmedRef.current = false;
        }
      } catch (e) { console.error(e); }
      setDbLoading(false);
    };
    load();
  }, [orderId, user, loadWebImages]);

  // ── Оновлення максимального досягнутого індексу стадії ──
  useEffect(() => {
    if (!workType) return;
    const cfg = WORK_TYPES[workType];
    if (!cfg) return;
    const idx = cfg.stageKeys.indexOf(stage);
    setMaxStageIdx(prev => Math.max(prev, idx));
  }, [stage, workType]);

  // ── Автозапуск пошуку джерел для тез/статті/есе/презентації ──
  useEffect(() => {
    if (stage !== "sources" || !info?.topic || tezySearchLoading) return;
    // tezy/stattia/ese — каскадний автопошук (runSourcesStage) запускається рівно
    // один раз (sourcesSearchDone), бо одразу вставляє знайдені джерела в citText,
    // а не чекає ручного відбору — на відміну від презентації нижче.
    if (["tezy", "stattia", "ese"].includes(workType) && stage === "sources" && !sourcesSearchDone) {
      doSearchTezyPapers();
    } else if (workType === "prezentatsiya" && stage === "sources" && tezyPapers.length === 0) {
      doSearchTezyPapers();
    }
  }, [workType, stage, info?.topic, sourcesSearchDone]);

  // ── Авто-збереження вибраних джерел ──
  useEffect(() => {
    if (!["tezy", "stattia", "ese", "referat", "prezentatsiya"].includes(workType) || stage !== "sources") return;
    const t = setTimeout(() => {
      saveToFirestore({ selectedTezyIds });
    }, 1000);
    return () => clearTimeout(t);
  }, [selectedTezyIds]);

  // ── Авто-збереження текстового поля джерел ──
  useEffect(() => {
    if (!["tezy", "stattia", "ese", "referat", "prezentatsiya"].includes(workType) || stage !== "sources") return;
    const t = setTimeout(() => {
      saveToFirestore({ citText });
    }, 1500);
    return () => clearTimeout(t);
  }, [citText]);

  // ── Авто-збереження citInputs (реферат) ──
  useEffect(() => {
    if (workType !== "referat" || stage !== "sources") return;
    const t = setTimeout(() => {
      saveToFirestore({ citInputs });
    }, 1500);
    return () => clearTimeout(t);
  }, [citInputs]);

  // ── Ініціалізація активної секції при переході на джерела (реферат) ──
  useEffect(() => {
    if (workType !== "referat" || stage !== "sources") return;
    if (!activeSecId && sections.length > 0) {
      const first = sections.find(s => s.id !== "sources");
      if (first) setActiveSecId(first.id);
    }
  }, [workType, stage, sections]);

  // ── Збереження ──
  const saveToFirestore = async (patch) => {
    if (!user) return;
    setSaving(true); setSaved(false);
    try {
      const isNew = !currentIdRef.current;
      const id = currentIdRef.current || `${user.uid}_${Date.now()}`;
      if (isNew) { currentIdRef.current = id; onOrderCreated?.(id); }
      const ref = doc(db, "orders", id);
      const base = {
        uid: user.uid, mode: "small", workType,
        updatedAt: new Date().toISOString(),
        topic: patch.info?.topic || info?.topic || "",
        type: patch.info?.type || info?.type || workType || "",
        pages: patch.info?.pages || info?.pages || "",
        deadline: patch.info?.deadline || info?.deadline || "",
        totalInTok: tokenAccRef.current.inTok,
        totalOutTok: tokenAccRef.current.outTok,
        totalCostUsd: tokenAccRef.current.costUsd,
        claudeInTok: tokenAccRef.current.claudeInTok,
        claudeOutTok: tokenAccRef.current.claudeOutTok,
        claudeCostUsd: tokenAccRef.current.claudeCostUsd,
        geminiInTok: tokenAccRef.current.geminiInTok,
        geminiOutTok: tokenAccRef.current.geminiOutTok,
        geminiCostUsd: tokenAccRef.current.geminiCostUsd,
        ...(patch.status === "done" ? { completedAt: new Date().toISOString() } : {}),
      };
      await setDoc(ref, serializeForFirestore({ ...base, ...patch, ...(!createdConfirmedRef.current ? { createdAt: new Date().toISOString() } : {}) }), { merge: true });
      createdConfirmedRef.current = true;
      setSaved(true); setTimeout(() => setSaved(false), 3000);
    } catch (e) { console.error(e); }
    setSaving(false);
  };

  // Мова поза вбудованою таблицею — набір підписів, який один раз складає ШІ
  // (useLangProfile / langProfile.js); зберігаємо лише info.langProfile (setDoc з merge)
  useLangProfile({
    language: info?.language, langProfile: info?.langProfile, callClaude,
    onProfile: (langProfile) => {
      setInfo(prev => (prev && normLangName(prev.language) === normLangName(langProfile.forLanguage) ? { ...prev, langProfile } : prev));
      if (currentIdRef.current) saveToFirestore({ info: { langProfile } });
    },
  });

  // ── Розпізнавання даних автора з вільного тексту ──
  const doRecognizeAuthorData = async () => {
    if (!authorRawText.trim()) return;
    setAuthorRecognizing(true);
    try {
      const prompt = `Розпізнай дані автора наукової роботи з тексту нижче. Текст може містити ПІБ, курс/посаду, наукового керівника, університет, факультет/кафедру, email — у будь-якому порядку і форматі.

ТЕКСТ:
${authorRawText.trim()}

Поверни ТІЛЬКИ JSON (без markdown):
{"authorName":"","role":"","supervisor":"","university":"","faculty":"","email":""}

authorName — ПІБ автора повністю, як у тексті.
role — курс навчання і/або посада (напр. "2 курс (ОС «магістр»)", "студент 3 курсу", "доцент").
supervisor — ПІБ та звання наукового керівника, якщо згадано (напр. "проф. Петренко П.П."). Порожній рядок якщо немає.
university — повна назва університету/закладу освіти. Порожній рядок якщо немає.
faculty — факультет, кафедра, спеціальність або освітня програма — все що стосується підрозділу/напряму. Порожній рядок якщо немає.
email — email автора, якщо є в тексті. Порожній рядок якщо немає.
Не вигадуй нічого, чого немає в тексті — порожній рядок для полів, яких там немає.`;
      const raw = await callClaude([{ role: "user", content: prompt }], null, "Respond only with valid JSON. No markdown.", 500, null, MODEL_FAST);
      const parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || raw);
      setAuthorData(d => ({ ...d, ...Object.fromEntries(Object.entries(parsed).filter(([, v]) => v)) }));
    } catch (e) {
      setError(e.message);
    }
    setAuthorRecognizing(false);
  };

  // ── Аналіз шаблону ──
  const doAnalyze = async () => {
    setRunning(true); setLoadMsg("Аналізую замовлення...");
    let newInfo = null;
    try {
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

      const prompt = `Проаналізуй замовлення на ${WORK_TYPES[workType]?.label || workType}.

ШАБЛОН:
${tplText}
${comment ? `\nКОМЕНТАР: ${comment}` : ""}${materialHint}${deptGuidanceHint}

Поверни ТІЛЬКИ JSON (без markdown):
{"type":"${WORK_TYPES[workType]?.label || workType}","pages":"","topic":"","subject":"","direction":"","uniqueness":"","language":"Українська","deadline":"","orderNumber":"","requirements":"","formatting":{"left":null,"right":null,"top":null,"bottom":null}${tezyFields}${simpleFields}${stattiaFields}${referatFields}}

orderNumber — номер замовлення якщо є (наприклад "37808.2"), інакше порожній рядок.
pages — кількість сторінок, якщо явно вказана у шаблоні/коментарі/файлах (число або діапазон, наприклад "10" або "10-12"). Якщо не вказано — порожній рядок.
requirements — якщо є рекомендації у файлах, стисло опиши ключові вимоги до структури та оформлення.
formatting — поля сторінки в мм якщо явно вказані у файлах або коментарі: left (ліве), right (праве), top (верхнє), bottom (нижнє). Якщо написано "зі всіх сторін X см" — постав X*10 у всі чотири поля. null для кожного поля якщо не вказано.${tezyHints}${simpleHints}${stattiaHints}${referatHints}`;

      const msgs = [{ role: "user", content: [...fileContext, ...matFileContext, { type: "text", text: prompt }] }];
      // Для тез/статті/есе/реферату з файлами — Sonnet (краще читає зображення), інакше Haiku
      const model = ((isTezy || isSimpleWithSources || isReferat || workType === "prezentatsiya") && (files.length > 0 || materialFiles.length > 0)) ? MODEL : MODEL_FAST;
      const raw = await callClaude(msgs, null, "Respond only with valid JSON. No markdown.", 10000, null, model);
      const parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || raw);
      const extractedFormatting = parsed.formatting;
      delete parsed.formatting;
      if (!parsed.orderNumber) {
        const m = tplText.match(/№\s*замовлення\s*[-–—:]\s*(\S+)/i);
        if (m) parsed.orderNumber = m[1].trim();
      }
      // Дефолти кількості джерел/рисунків — застосовуються ЛИШЕ якщо AI не знайшла явної
      // вказівки в методичці/шаблоні (повернула null). Так дефолт ніколи не підмінить
      // реальну вимогу методички, навіть якщо вона відрізняється від типового значення.
      if (parsed.sourceCount == null || parsed.sourceCount === "") {
        if (isReferat) parsed.sourceCount = Number(parsed.pages) || 10;
        else if (isStattia) parsed.sourceCount = 5;
        else if (isTezy || workType === "ese") parsed.sourceCount = 3;
      }
      if ((isTezy || isSimpleWithSources) && (parsed.figureCount == null || parsed.figureCount === "")) {
        parsed.figureCount = parsed.needsFigures ? (isTezy ? 1 : 2) : 0;
      }
      newInfo = { ...parsed, workType };
      setInfo(newInfo);
      let mergedMethodInfo = null;
      if (extractedFormatting?.left || extractedFormatting?.right || extractedFormatting?.top || extractedFormatting?.bottom) {
        const toNum = v => (v != null && v !== "" ? Number(v) : null);
        mergedMethodInfo = { formatting: { margins: { left: toNum(extractedFormatting.left), right: toNum(extractedFormatting.right), top: toNum(extractedFormatting.top), bottom: toNum(extractedFormatting.bottom) } } };
      }

      // Читаємо повні вимоги з файлів методички і структуроване оформлення
      // (стиль/групування джерел, оформлення таблиць/рисунків — та сама логіка,
      // що й у великих роботах) паралельно, якщо файли є.
      let extractedMethodReqs = "";
      if (fileContext.length > 0) {
        setLoadMsg("Читаю вимоги методички...");
        const reqMsgs = [{ role: "user", content: [...fileContext, { type: "text", text: `Уважно прочитай ці вимоги/методичку до написання ${WORK_TYPES[workType]?.label || "роботи"}. Витягни ВСІ вимоги: структуру роботи, обсяг кожного розділу, форматування (шрифт, поля, інтервал), вимоги до джерел та цитування, стиль написання, особливі умови конференції/викладача. Поверни лише текст вимог — повно але без зайвих коментарів. Відповідай мовою документу.` }] }];
        const fmtMsgs = [{ role: "user", content: [...fileContext, { type: "text", text: buildSmallWorkFormattingPrompt() }] }];
        const [reqResult, fmtResult] = await Promise.allSettled([
          callClaude(reqMsgs, null, "You are a helpful assistant. Extract requirements from the provided documents.", 2000, null, MODEL),
          callClaude(fmtMsgs, null, "Respond only with valid JSON. No markdown.", 1500, null, MODEL),
        ]);
        if (reqResult.status === "fulfilled") {
          extractedMethodReqs = reqResult.value.trim();
          setMethodRequirements(extractedMethodReqs);
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
      if (mergedMethodInfo) setMethodInfo(prev => ({ ...(prev || {}), ...mergedMethodInfo, formatting: { ...(prev?.formatting || {}), ...mergedMethodInfo.formatting } }));

      if (workType === "referat") {
        await saveToFirestore({ tplText, comment, clientPlan, materialText, deptGuidanceText, structureExampleName, structureExampleText, info: newInfo, ...(extractedMethodReqs ? { methodRequirements: extractedMethodReqs } : {}), ...(mergedMethodInfo ? { methodInfo: mergedMethodInfo } : {}), stage: "plan", status: "new" });
        setStage("plan");
      } else if (isTezy && newInfo.needsSources !== false) {
        await saveToFirestore({ tplText, comment, materialText, deptGuidanceText, authorData, info: newInfo, ...(extractedMethodReqs ? { methodRequirements: extractedMethodReqs } : {}), ...(mergedMethodInfo ? { methodInfo: mergedMethodInfo } : {}), stage: "sources", status: "new" });
        setStage("sources");
      } else if (isSimpleWithSources) {
        await saveToFirestore({ tplText, comment, materialText, ...(workType === "ese" ? { essayExampleName, essayExampleText } : {}), info: newInfo, ...(extractedMethodReqs ? { methodRequirements: extractedMethodReqs } : {}), ...(mergedMethodInfo ? { methodInfo: mergedMethodInfo } : {}), stage: "sources", status: "new" });
        setStage("sources");
      } else if (workType === "prezentatsiya") {
        await saveToFirestore({ tplText, comment, materialText, instrFiles, info: newInfo, ...(extractedMethodReqs ? { methodRequirements: extractedMethodReqs } : {}), ...(mergedMethodInfo ? { methodInfo: mergedMethodInfo } : {}), stage: "sources", status: "new" });
        setStage("sources");
      } else {
        await saveToFirestore({ tplText, comment, materialText, authorData, info: newInfo, ...(extractedMethodReqs ? { methodRequirements: extractedMethodReqs } : {}), ...(mergedMethodInfo ? { methodInfo: mergedMethodInfo } : {}), stage: "writing", status: "new" });
        resetGenerationCost();
        setStage("writing");
      }
    } catch (e) {
      setError(e.message);
    }
    setRunning(false); setLoadMsg("");
    return newInfo;
  };

  // Мінімум джерел за таблицею (той самий SOURCES_MIN_TABLE, що й у курсовій) —
  // "тези"/"есе"/"наукова стаття" за обсягом сторінок; null, якщо таблиця не
  // покриває цей діапазон (тоді викликач падає на старий дефолт).
  const getSmallWorkSourcesMin = () => {
    const tableLabel = workType === "stattia" ? "наукова стаття" : workType === "tezy" ? "тези" : workType === "ese" ? "есе" : null;
    if (!tableLabel) return null;
    return getSourcesMinFromTable(tableLabel, parsePagesAvg(info?.pages || "3"));
  };

  // ── Пошук джерел для презентації — старий одноразовий пошук з ручним
  // відбором (checkbox-пікер нижче в UI); тези/стаття/есе йдуть новим шляхом
  // (doSearchTezyPapers нижче) ──
  const doSearchTezyPapersLegacy = async () => {
    setTezySearchLoading(true);
    try {
      const topic = info?.topic || tplText.slice(0, 120);
      const direction = info?.direction || "";
      const subject = info?.subject || "";
      const needed = info?.sourceCount || 5;

      const [allPhrases, ukKw] = await Promise.all([
        generateSearchPhrases(topic, topic, direction, subject),
        Promise.resolve(buildSemanticKeywords(topic, topic, direction, subject)),
      ]);

      // Перші 4 — українські, наступні 4 — англійські
      const ukPhrases = allPhrases.length ? allPhrases.slice(0, 4) : ukKw.slice(0, 4);
      const enPhrases = allPhrases.slice(4, 8);
      // Fallback: якщо generateSearchPhrases не повернув нічого — беремо семантичні ключові слова
      const displayPhrases = allPhrases.length ? allPhrases : ukKw.slice(0, 6);

      const { flat } = await searchSourcesForSection(ukKw, enPhrases, needed + 6, topic, topic, 1, [], [], ukPhrases, info?.language);
      // Без фолбеку на нефільтроване flat: якщо Gemini законно нічого не підтвердив
      // (чи запит впав), користувач має побачити чесний результат, а не непровірені кандидати.
      const filtered = await filterSourcesWithGemini(flat || [], topic, topic, 10);
      const papers = filtered.slice(0, 10);
      setTezyPapers(papers);
      setTezyPage(1);
      setSelectedTezyIds([]);
      setSearchPhrases(displayPhrases);
      await saveToFirestore({ tezyPapers: papers, selectedTezyIds: [], searchPhrases: displayPhrases });
    } catch (e) {
      setError(e.message);
    }
    setTezySearchLoading(false);
  };

  // ── Пошук джерел для тез/статті/есе — той самий каскадний механізм, що й у
  // великих роботах (runSourcesStage: тези → пошукові фрази → паралельний
  // пошук → Gemini-фільтр → каскад добору при нестачі — розширення років →
  // альтернативні фрази → регенерація тез), через секцію-заглушку "_main".
  // Знайдені джерела одразу автовставляються в citText (як і в реферату/
  // курсовій) — без ручного відбору чекбоксами, бо вже пройшли Gemini-фільтр
  // (score ≥70). Результат домішується до вже введених вручну рядків. ──
  const doSearchTezyPapers = async () => {
    if (workType === "prezentatsiya") return doSearchTezyPapersLegacy();
    setTezySearchLoading(true);
    try {
      const topic = info?.topic || tplText.slice(0, 120);
      const minRequired = getSmallWorkSourcesMin();
      const needed = info?.sourceCount || minRequired || (workType === "stattia" ? 5 : 3);
      const sec = { id: "_main", label: topic };
      const order = {
        info, sections: [sec], sourceDist: { _main: needed },
        citInputs: {}, citStructured, content: {},
        commentAnalysis: null, methodInfo,
      };
      const patch = await runSourcesStage(order, sec, { callGemini });
      const found = (patch.citInputs?._main || "").split("\n").map(s => s.trim()).filter(Boolean);
      const existing = citText.split("\n").map(s => s.trim()).filter(Boolean);
      const mergedText = [...new Set([...existing, ...found])].join("\n");
      setCitText(mergedText);
      setCitStructured(patch.citStructured);
      setSourcesSearchDone(true);
      await saveToFirestore({ citText: mergedText, citStructured: patch.citStructured, sourcesSearchDone: true });
    } catch (e) {
      setError(e.message);
    }
    setTezySearchLoading(false);
  };

  // ── Пошук + підбір джерел для ОДНОГО розділу реферату — та сама логіка, що й
  // у великих роботах (runSourcesStage): тези → пошукові фрази → паралельний
  // пошук → Gemini-фільтр → каскад добору при нестачі (розширення років →
  // альтернативні фрази → повна регенерація тез) → авто-вставка. baseCitInputs/
  // baseCitStructured/sharedSeen приймаються ззовні (doSearchAllSections), щоб у
  // пакетному пошуку кожен наступний розділ бачив джерела, щойно додані
  // попередніми (React-стан ще не встиг би оновитись між ітераціями цикла) ──
  const doSearchForSection = async (secId, secLabel, baseCitInputs = citInputs, baseCitStructured = citStructured, sharedSeen = new Set(), sectionsOverride, infoOverride) => {
    setRefSecLoading(prev => ({ ...prev, [secId]: true }));
    let patch = null;
    try {
      const effInfo = infoOverride || info;
      const topic = effInfo?.topic || tplText.slice(0, 120);
      const direction = effInfo?.direction || "";
      const subject = effInfo?.subject || "";
      const refSecs = (sectionsOverride || sections).filter(s => !["sources", "intro", "conclusions"].includes(s.id));
      const minSrc = effInfo?.sourceCount || parsePagesAvg(effInfo?.pages || "3");
      const perSec = Math.ceil(minSrc / Math.max(refSecs.length, 1));
      const sourceDist = Object.fromEntries(refSecs.map(s => [s.id, perSec]));

      // Фрази — лише підказки для користувача (клік = копіювати в буфер); сам
      // пошук веде runSourcesStage за власними фразами, згенерованими з тез.
      const [allPhrases, ukKw] = await Promise.all([
        generateSearchPhrases(secLabel, topic, direction, subject),
        Promise.resolve(buildSemanticKeywords(secLabel, topic, direction, subject)),
      ]);
      const displayPhrases = allPhrases.length ? allPhrases : ukKw.slice(0, 6);
      setRefSecPhrases(prev => {
        const next = { ...prev, [secId]: displayPhrases };
        saveToFirestore({ refSecPhrases: next });
        return next;
      });

      const order = {
        info: effInfo, sections: refSecs, sourceDist,
        citInputs: baseCitInputs, citStructured: baseCitStructured,
        content: {}, commentAnalysis: null, methodInfo,
      };
      patch = await runSourcesStage(order, { id: secId, label: secLabel }, { callGemini, crossSectionSeen: sharedSeen });
      setCitInputs(patch.citInputs);
      setCitStructured(patch.citStructured);
      await saveToFirestore({ citInputs: patch.citInputs, citStructured: patch.citStructured });
      setRefSecPapers(prev => {
        const next = { ...prev, [secId]: patch.citStructured[secId] || [] };
        saveToFirestore({ refSecPapers: next });
        return next;
      });
    } catch (e) { setError(e.message); }
    setRefSecLoading(prev => ({ ...prev, [secId]: false }));
    return patch;
  };

  // ── Пошук джерел для ВСІХ розділів і підрозділів реферату одразу — спільний
  // Set (як crossSectionSeen у worker/runOrder.js для великих робіт) не дає
  // тому самому джерелу потрапити у два різні розділи ──
  const doSearchAllSections = async (sectionsOverride, infoOverride) => {
    const refSecs = (sectionsOverride || sections).filter(s => !["sources", "intro", "conclusions"].includes(s.id));
    if (!refSecs.length) return;
    setAllSecLoading(true);
    setAllSecProgress({ done: 0, total: refSecs.length });
    const sharedSeen = new Set();
    let curCitInputs = citInputs;
    let curCitStructured = citStructured;
    for (const sec of refSecs) {
      const patch = await doSearchForSection(sec.id, sec.label, curCitInputs, curCitStructured, sharedSeen, sectionsOverride, infoOverride);
      if (patch) { curCitInputs = patch.citInputs; curCitStructured = patch.citStructured; }
      setAllSecProgress(prev => ({ ...prev, done: prev.done + 1 }));
    }
    setAllSecLoading(false);
    return curCitInputs;
  };

  // ── Генерація із текстового поля джерел ──
  const doGenerateFromCitText = async () => {
    let citations = citText.split("\n").map(s => s.trim()).filter(Boolean);
    // Дедуплікація — джерела для однієї теми часто трапляються в кількох пошукових
    // фразах і додаються двічі; без цього кроку дублікат так і лишається в списку
    // літератури (buildFinalReferenceList довіряє, що rawRefs уже унікальні).
    const _dedup1 = createReferenceDeduper();
    citations = citations.map(c => { _dedup1.add(c); return c; });
    citations = _dedup1.canonicalRefs;
    const _smEffOrder1 = sourcesOrderOverride || methodInfo?.sourcesOrder;
    const _smShouldSort1 = _smEffOrder1 ? _smEffOrder1 === "alphabetical" : info?.sortAlpha;
    if (_smShouldSort1) {
      const { lawFirst } = detectSourceGrouping({ sourcesFormatRules: methodInfo?.sourcesFormatRules, sourcesGrouping: methodInfo?.sourcesGrouping });
      const _isLaw = s => lawFirst && isLawSource(s);
      citations.sort((a, b) => {
        const lawA = _isLaw(a), lawB = _isLaw(b);
        if (lawA !== lawB) return lawA ? -1 : 1;
        return a.localeCompare(b, "uk");
      });
    }
    setTezyCitations(citations);
    await saveToFirestore({ tezyCitations: citations, citText, stage: "writing", status: "sources_done" });
    resetGenerationCost();
    setStage("writing");
    if (workType === "tezy") await doGenerateTezy(citations);
    else if (workType === "prezentatsiya") { /* user picks theme first, then clicks generate manually */ }
    else if (workType !== "referat") await doGenerateSimple(citations);
  };

  // ── Генерація реферату із посекційних полів джерел ──
  // Джерела зберігаються сирими — форматування відбувається окремим кроком після генерації тексту
  const doGenerateFromCitInputs = async (sectionsOverride, citInputsOverride) => {
    const effSections = sectionsOverride || sections;
    const effCitInputs = citInputsOverride || citInputs;
    const raw = [];
    effSections.filter(s => s.id !== "sources").forEach(s => {
      (effCitInputs[s.id] || "").split("\n").map(l => l.trim()).filter(Boolean).forEach(l => {
        if (!raw.includes(l)) raw.push(l);
      });
    });
    const _smEffOrder2 = sourcesOrderOverride || methodInfo?.sourcesOrder;
    const _smShouldSort2 = _smEffOrder2 ? _smEffOrder2 === "alphabetical" : info?.sortAlpha;
    if (_smShouldSort2) {
      const { lawFirst } = detectSourceGrouping({ sourcesFormatRules: methodInfo?.sourcesFormatRules, sourcesGrouping: methodInfo?.sourcesGrouping });
      const _isLaw = s => lawFirst && isLawSource(s);
      raw.sort((a, b) => {
        const lawA = _isLaw(a), lawB = _isLaw(b);
        if (lawA !== lawB) return lawA ? -1 : 1;
        return a.localeCompare(b, "uk");
      });
    }
    setTezyCitations(raw);
    setSourcesFormatted(false);
    await saveToFirestore({ tezyCitations: raw, citInputs: effCitInputs, stage: "writing", status: "sources_done", sourcesFormatted: false });
    resetGenerationCost();
    setStage("writing");
    return raw;
  };

  const stopAutoWithError = (step, message) => {
    autoModeRef.current = false;
    setAutoRunning(false);
    setAutoError({ step, message });
  };

  const stopAutoPipeline = () => {
    autoModeRef.current = false;
    setAutoRunning(false);
  };

  // ── Автоматичний режим для реферату: один клік замість ручного переходу
  // по кожному етапу. Кожен крок бере результат попереднього напряму з
  // повернутого значення (а не зі стану React), бо стан оновлюється лише на
  // наступному рендері — читання його одразу після await дало б застарілі дані. ──
  const runAutoPipelineReferat = async () => {
    setAutoRunning(true); autoModeRef.current = true; setAutoError(null); setError("");

    setAutoStepLabel("Аналізую вхідні дані...");
    let newInfo;
    try {
      newInfo = await doAnalyze();
    } catch (e) { stopAutoWithError("Аналіз", e.message); return; }
    if (!autoModeRef.current) return;
    if (!newInfo?.topic) {
      stopAutoWithError("Аналіз", "Не вдалося визначити тему роботи. Перевірте вручну на кроці «Дані».");
      return;
    }

    setAutoStepLabel("Генерую план...");
    let newSections;
    try {
      newSections = await doGenPlan(newInfo);
    } catch (e) { stopAutoWithError("План", e.message); return; }
    if (!autoModeRef.current) return;
    if (!newSections?.length) {
      stopAutoWithError("План", "План вийшов порожнім. Перевірте вручну на кроці «План».");
      return;
    }
    setStage("sources");
    await saveToFirestore({ sections: newSections, stage: "sources" });
    if (!autoModeRef.current) return;

    setAutoStepLabel("Шукаю джерела...");
    let newCitInputs;
    try {
      newCitInputs = await doSearchAllSections(newSections, newInfo);
    } catch (e) { stopAutoWithError("Джерела", e.message); return; }
    if (!autoModeRef.current) return;
    const refSecs = newSections.filter(s => !["sources", "intro", "conclusions"].includes(s.id));
    const shortSecs = refSecs.filter(s => !(newCitInputs?.[s.id] || "").trim());
    if (shortSecs.length) {
      stopAutoWithError("Джерела", `Не знайдено джерел для: ${shortSecs.map(s => s.label).join(", ")}. Додайте вручну на кроці «Джерела» й продовжте звичайним флоу.`);
      return;
    }

    setAutoStepLabel("Починаю написання...");
    try {
      await doGenerateFromCitInputs(newSections, newCitInputs);
    } catch (e) { stopAutoWithError("Написання", e.message); return; }
    // Далі — вже наявний автоматичний конвеєр: писання по секціях → форматування
    // джерел → stage "done" (useEffect на stage==="writing").
    setAutoStepLabel("Пишу текст...");
  };

  // Завершення автопрогону на "done", або зупинка з показом помилки якщо
  // конвеєр написання сам зупинився через помилку API.
  useEffect(() => {
    if (!autoRunning) return;
    if (stage === "done") {
      autoModeRef.current = false;
      setAutoRunning(false);
      return;
    }
    if (error) {
      autoModeRef.current = false;
      setAutoRunning(false);
      setAutoError({ step: "Написання", message: error });
    }
  }, [autoRunning, stage, error]);

  // ── Форматування списку джерел за стилем + перестановка посилань [N] у тексті (всі типи робіт) ──
  const doFormatAndRemapCitations = async () => {
    if (!tezyCitations.length) return;
    setRunning(true); setLoadMsg("Форматую та розставляю джерела...");
    resetGenerationCost();
    try {
      const allStructured = Object.values(citStructured).flat();
      const _effectiveSmOrder = sourcesOrderOverride || methodInfo?.sourcesOrder;
      const _smStyle = citStyleOverride || methodInfo?.sourcesStyle || info?.citStyle || "ДСТУ 8302:2015";
      const isFootnoteMode = citFootnotes && /ДСТУ/i.test(_smStyle) && workType !== "prezentatsiya";
      const isAPA = /APA/i.test(_smStyle);
      const isMLA = /MLA/i.test(_smStyle);
      const { refList, oldToNew, refCiteText, pageRanges, pageAbbrev, pdfUrls } = await remapAndFormatCitations({
        citations: tezyCitations,
        citStructured: allStructured,
        citStyle: _smStyle,
        language: info?.language,
        sourcesOrder: _effectiveSmOrder,
        sourcesGrouping: methodInfo?.sourcesGrouping,
        sourcesFormatRules: methodInfo?.sourcesFormatRules,
        citFootnotes: isFootnoteMode,
        citationStyle: methodInfo?.citationStyle,
        callClaude,
      });
      if (!refList.length) { setRunning(false); setLoadMsg(""); return; }
      const refBlock = refList.map((c, i) => `${i + 1}. ${c}`).join("\n");
      // "Сторінка за змістом" (перемикач): сторінка посилання — за збігом речення з PDF джерела
      const remapTexts = {};
      if (workType === "referat") sections.forEach(s => { if (s.id !== "sources") remapTexts[s.id] = s.text || ""; });
      else if (workType === "prezentatsiya") slides.forEach((sl, i) => { remapTexts[`slide${i}`] = sl.content || ""; });
      else remapTexts._body = result || "";
      let contentPickers = {};
      if (pageByContent && !isFootnoteMode && Object.keys(pdfUrls || {}).length) {
        setLoadMsg("Підбираю сторінки за змістом PDF джерел...");
        try {
          contentPickers = await buildContentPagePickers({ texts: remapTexts, mappingFor: () => oldToNew, pdfUrls, pageRanges });
        } catch (err) { console.error("Сторінка за змістом:", err.message); }
      }
      const remapText = (text, key) => applyCitationRemap(text, oldToNew, refCiteText, { pageRanges, pageAbbrev, pagePicker: contentPickers[key] });

      if (workType === "referat") {
        const remappedSections = sections.map(s => s.id === "sources"
          ? { ...s, text: refBlock }
          : { ...s, text: remapText(s.text, s.id) });

        // Фінальна перевірка сумарного обсягу — кожен підрозділ окремо вже пройшов
        // enforceWordCount (85-120%) під час генерації, але накопичена похибка по
        // всій роботі (плюс вставлені джерела/цитати) ніде не звірялась із заданою
        // к-стю сторінок; тут звіряємо й коригуємо, як і у великих роботах.
        const totalTargetWords = remappedSections
          .filter(s => !["intro", "conclusions", "sources"].includes(s.id))
          .reduce((sum, s) => sum + Number(s.pages || 0) * 230, 0);
        const contentMap = Object.fromEntries(remappedSections.map(s => [s.id, s.text]));
        const adjustedVolume = await enforceTotalVolume({
          sections: remappedSections, content: contentMap, targetWords: totalTargetWords,
          isEligible: (s) => !["intro", "conclusions", "sources"].includes(s.id),
          callClaude, sys: buildSYSSmall(info?.language || "Українська"),
          onProgress: setLoadMsg, clean: cleanDash, lang: info?.language,
        });
        const updatedSections = remappedSections.map(s =>
          adjustedVolume[s.id] !== undefined ? { ...s, text: adjustedVolume[s.id] } : s);

        // ── Глобальна перевірка покриття джерел цитатами ──
        // insertMissingCitations під час генерації (doWriteSection) страхує лише
        // в межах ОДНОГО розділу за джерелами, призначеними саме йому. Джерело,
        // яке взагалі не потрапило в citInputs жодного розділу, лишалось би
        // "осиротілим" у списку літератури без жодної згадки в тексті — тут
        // остання страховка на рівні всієї роботи.
        let finalSections = updatedSections;
        let finalRefList = refList;
        let finalOldToNew = oldToNew;
        const citedGlobally = new Set();
        updatedSections.filter(s => s.id !== "sources").forEach(s => {
          extractCitedNumbers(s.text).forEach(n => citedGlobally.add(n));
        });
        const uncitedNums = refList.map((_, i) => i + 1).filter(n => !citedGlobally.has(n));
        if (uncitedNums.length) {
          setLoadMsg("Перевіряю покриття джерел цитатами...");
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
                lang: info?.language,
                callClaude,
              });
              finalSections[secIdx] = { ...finalSections[secIdx], text: capCitationRepeats(text) };
              if (unresolved.length) unresolvedNums.push(num);
            } catch (e) {
              console.error("insertMissingCitations (referat, global coverage):", e.message);
              unresolvedNums.push(num);
            }
          }

          // Джерела, які так і не вдалось прив'язати до жодного речення в жодному
          // розділі, — видаляємо зі списку літератури й перенумеровуємо решту (як
          // у великих роботах, orderStages.js:runRemapStage), щоб список точно
          // відповідав тому, що реально процитоване в тексті.
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

        // ── Анотація та ключові слова — лише якщо методичка явно вимагає цей
        // структурний блок (needsAnnotation з аналізу методички, доAnalyze) ──
        let newAnnotationUk = annotationUk;
        if (methodInfo?.needsAnnotation) {
          setLoadMsg("Генерую анотацію...");
          try {
            const introSec = finalSections.find(s => s.id === "intro");
            const mainSecCount = new Set(finalSections
              .filter(s => !["intro", "conclusions", "sources"].includes(s.id))
              .map(s => s.id.includes(".") ? s.id.split(".")[0] : s.id)).size;
            const statsText = [
              `Дисципліна: ${info?.subject || ""}`,
              `Кількість розділів: ${mainSecCount}`,
              `Кількість використаних джерел: ${finalRefList.length}`,
              info?.pages ? `Орієнтовний обсяг роботи: ${info.pages} сторінок` : "",
            ].filter(Boolean).join("\n");
            const annPrompt = buildReferatAnnotationPrompt(info, methodInfo, statsText, introSec?.text || "");
            const annRaw = await callClaude([{ role: "user", content: annPrompt }], null, SYS_JSON_SHORT, 1500);
            const annMatch = annRaw.match(/\{[\s\S]*\}/);
            const annParsed = JSON.parse(annMatch?.[0] || annRaw.replace(/```json|```/g, "").trim());
            newAnnotationUk = annParsed.uk || "";
            setAnnotationUk(newAnnotationUk);
          } catch (e) { console.error("genReferatAnnotation:", e.message); }
        }

        // Оновлюємо citInputs — замінюємо сирі рядки на відформатовані відповідно до нового порядку
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
        setSections(finalSections);
        setCitInputs(newCitInputs);
        setTezyCitations(finalRefList);
        setSourcesFormatted(true);
        await saveToFirestore({ tezyCitations: finalRefList, citInputs: newCitInputs, sections: finalSections, sourcesFormatted: true, ...(newAnnotationUk ? { annotationUk: newAnnotationUk } : {}) });
        // текст реферату остаточний — фото для рисунків-заглушок підбираються у фоні, раз на замовлення
        webImg.searchAll({ content: Object.fromEntries(finalSections.map(s => [s.id, s.text])), sections: finalSections, lang: info?.language, topic: info?.topic, auto: true })
          .catch(e => console.error("webImages:", e.message));
      } else if (workType === "prezentatsiya") {
        const updatedSlides = slides.map((sl, i) => isSourcesTitle(sl.title || "")
          ? { ...sl, content: refBlock }
          : { ...sl, content: remapText(sl.content, `slide${i}`) });
        setSlides(updatedSlides);
        setTezyCitations(refList);
        setSourcesFormatted(true);
        await saveToFirestore({ tezyCitations: refList, slides: updatedSlides, sourcesFormatted: true });
      } else {
        const bibMatch = matchSourcesBlock(result);
        const body = bibMatch ? result.slice(0, bibMatch.index) : result;
        const remappedBody = remapText(body, "_body");
        const newResult = `${remappedBody}\n\n${sourcesHeading(info?.language)}:\n${refBlock}`;
        setResult(newResult);
        setTezyCitations(refList);
        setSourcesFormatted(true);
        await saveToFirestore({ tezyCitations: refList, result: newResult, sourcesFormatted: true });
      }
    } catch (e) { setError(e.message); }
    setRunning(false); setLoadMsg("");
  };

  const doConfirmTezyPapers = async () => {
    const selected = tezyPapers.filter(p => selectedTezyIds.includes(p.id));
    if (!selected.length) return;
    setRunning(true); setLoadMsg("Оформлюю джерела...");
    try {
      // Те саме збагачення, що й в автопошуку (enrichSources): DOI (суворий збіг), метадані
      // за DOI, мета-теги сторінки журналу, PDF статті, обсяг книги — щоб сторінки в
      // описі й у посиланнях тез були такими ж повними й перевіреними, як у великих роботах
      const enriched = await enrichSources(selected);
      const rawCitations = enriched.map(paperToCitation).filter(Boolean);
      setCitText(prev => {
        const existing = prev.trim();
        const toAdd = rawCitations.filter(c => !existing.includes(c.slice(0, 40)));
        const next = existing ? existing + "\n" + toAdd.join("\n") : toAdd.join("\n");
        saveToFirestore({ citText: next });
        return next;
      });
      setCitStructured(prev => {
        const existing = prev["_main"] || [];
        const existingTitles = new Set(existing.map(p => (p.title || "").toLowerCase().slice(0, 60)));
        const toAdd = enriched.filter(p => p.title && !existingTitles.has(p.title.toLowerCase().slice(0, 60)));
        const next = { ...prev, _main: [...existing, ...toAdd] };
        saveToFirestore({ citStructured: next });
        return next;
      });
      setSelectedTezyIds([]);
    } catch (e) { setError(e.message); }
    setRunning(false); setLoadMsg("");
  };

  // Карта позначок для промпту: { 1: "[1]", ... } — лише номер. Сторінку ставить
  // фінальний крок (doFormatAndRemapCitations → applyCitationRemap) з перевіреного
  // діапазону джерела. Раніше модель отримувала готове "[N, с. X]" з першою сторінкою
  // статті (усі посилання на джерело — з тією самою сторінкою), а за сторінку часом
  // бралась рік ("процес. 2021").
  const buildCiteMap = (citations) => {
    const map = {};
    citations.forEach((_, i) => { map[i + 1] = `[${i + 1}]`; });
    return map;
  };

  // ── Генерація тез ──
  const doGenerateTezy = async (citationsOverride) => {
    setRunning(true); setLoadMsg("Генерую тези...");
    const lang = info?.language || "Українська";
    const totalPages = parsePagesAvg(info?.pages || "3");

    const ad = authorData;
    // Заглушки й підписи блоку автора, УДК, список джерел і підпис рисунка — мовою роботи (як у smallStages.js)
    const L = getLangLabels(lang);
    const authorName = ad.authorName?.trim() || L.authorPlaceholder;
    const supervisor = ad.supervisor?.trim() || `[${L.supervisorLabel}]`;
    const university = ad.university?.trim() || L.universityPlaceholder;
    const faculty = ad.faculty?.trim() || "";
    const role = ad.role?.trim() || "";
    const email = (info?.needsEmail && ad.email?.trim()) ? ad.email.trim() : null;

    const authorFormat = info?.authorFormat || "center";
    const authorBlockLines = [
      authorName + (role ? `, ${role}` : ""),
      supervisor,
      university + (faculty ? `, ${faculty}` : ""),
      email,
    ].filter(Boolean).join("\n");

    const activeCitations = citationsOverride ?? tezyCitations;
    const hasSources = activeCitations.length > 0;
    const citeMap = buildCiteMap(activeCitations);
    const sourcesContext = hasSources
      ? `\nДЖЕРЕЛА — при цитуванні вставляй у текст ЛИШЕ технічну позначку [N] (де N — номер джерела нижче), БЕЗ сторінки — сторінку система підставить сама з діапазону джерела. НІКОЛИ не пиши саму цитату (прізвище автора, рік, сторінку) в тексті в жодному вигляді — ні круглими дужками (Автор, рік), ні квадратними [Автор, рік, с. X]: остаточний стиль оформлення цитати підставить система вже після генерації, це не твоя турбота. Цитуй ЛИШЕ джерела зі списку нижче під їхніми номерами — категорично не згадуй і не посилайся на будь-яке інше дослідження, статтю чи автора, якого немає в цьому списку, яким би доречним воно не здавалося. Кожне джерело цитуй НЕ БІЛЬШЕ 2 РАЗІВ за весь текст роботи (рахуючи всі частини разом) — навіть якщо воно дуже доречне, для третього разу сформулюй без цитування або спирайся на інше джерело. ТОЧНО у форматі перед кожним джерелом:\n${activeCitations.map((s, i) => `${citeMap[i + 1]} ${s}`).join("\n")}`
      : "";

    const structureInstr = info?.bodyStructure === "structured"
      ? "Структура за замовчуванням: Преамбула (2-3 речення: актуальність і новизна) → Тези (5-7 речень: ключові ідеї, власна позиція) → Аргументація (4-6 речень: обґрунтування, посилання на джерела) → Демонстрація (4-6 речень: ілюстрація прикладами) → Результати (2-4 речення: висновки, теоретична/практична цінність). Якщо у методичці або рекомендаціях кафедри вказана інша структура тез — використай її замість цієї."
      : "Структура за замовчуванням: Актуальність (1-2 абзаци) → Мета та завдання (1 абзац) → Матеріали і методи (1 абзац) → Результати та обговорення (2-3 абзаци з посиланнями на джерела) → Висновки (пиши слово \"Висновки.\" жирним inline, потім текст). Якщо у методичці або рекомендаціях кафедри вказана інша структура тез — використай її замість цієї.";

    const sourcesList = hasSources
      ? `\n${sourcesHeading(lang)}:\n${activeCitations.map((s, i) => `${i + 1}. ${s}`).join("\n")}`
      : "";
    const supervisorBlock = `${L.supervisorLabel}: ${supervisor}`;

    const materialContext = materialText.trim()
      ? `\nМАТЕРІАЛ ДЛЯ РОБОТИ — змістова основа тез (факти, дані, позиції бери звідси; структуру й оформлення — ні):\n${materialText.trim()}\n`
      : "";
    const deptGuidanceBlock = deptGuidanceText?.trim()
      ? `\nРЕКОМЕНДАЦІЇ КАФЕДРИ/ВИКЛАДАЧА (ОБОВ'ЯЗКОВО враховуй нарівні з методичкою; якщо суперечать методичці — пріоритет за рекомендаціями кафедри):\n${deptGuidanceText.trim()}\n`
      : "";

    const figureInstr = (info?.needsFigures && (info?.figureCount || 0) > 0)
      ? `\nРИСУНКИ (${info.figureCount} шт.): Постав рисунки у текст там де доречно. Для кожного рисунку:
– у реченні зроби посилання: (${L.figWord.toLowerCase()} N)
– після абзацу з посиланням окремим рядком маркер пошуку: [🔍 Рисунок N: "конкретний пошуковий запит для Google Images"]
– наступний рядок — підпис: ${L.figWord} N — Назва рисунку`
      : "";

    const prompt = `Напиши тези наукової доповіді на тему "${info?.topic}". Галузь: ${[info?.subject, info?.direction].filter(Boolean).join(", ")}.
${materialContext}${comment?.trim() ? `\nКОМЕНТАР ЗАМОВНИКА (виконай обов'язково): ${comment.trim()}\n` : ""}
НЕ додавай слово «ТЕЗИ» як окремий заголовок-рядок на початку документу.
БЛОК АВТОРА (${authorFormat === "right" ? "вирівняти по правому краю" : "вирівняти по центру"}):
${authorBlockLines}

${info?.needsUDK ? `Перший рядок документу: ${L.udc} [відповідний код для теми]` : ""}
Назва доповіді: "${info?.topic}" — ВЕЛИКИМИ ЛІТЕРАМИ, по центру.

${structureInstr}
${sourcesContext}
${figureInstr}

Обсяг: ~${totalPages} сторінки. Мова: ${lang}.
${methodRequirements?.trim() ? `ВИМОГИ ДО РОБОТИ (ОБОВ'ЯЗКОВО дотримуватись):\n${methodRequirements}` : (info?.requirements ? `Вимоги конференції: ${info.requirements}` : "")}
${deptGuidanceBlock}${info?.uniqueness ? `Унікальність: ${info.uniqueness}.` : ""}
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

    try {
      const msgs = [{ role: "user", content: [...fileContext, ...matFileContext, { type: "text", text: prompt }] }];
      const tezyMaxTokens = Math.min(30000, Math.max(6000, Math.round(totalPages * 3000)));
      const rawResult = cleanDash(await callClaude(msgs, null, buildSYSSmall(lang), tezyMaxTokens));
      let text = rawResult;
      try {
        text = await fixDanglingFigures({ text: rawResult, lang, callClaude });
      } catch (e) { console.error("fixDanglingFigures:", e.message); }

      // Довставляємо джерела, які мали бути процитовані (sourcesContext), але модель
      // їх пропустила — без цього джерело лишалось би "осиротілим" у списку джерел
      // (додане до списку, але жодного разу не згадане в тексті).
      if (hasSources) {
        const citedNums = new Set(extractCitedNumbers(text));
        const missing = activeCitations
          .map((c, i) => ({ number: i + 1, sourceText: c, marker: citeMap[i + 1] || `[${i + 1}]` }))
          .filter(s => !citedNums.has(s.number));
        if (missing.length) {
          setLoadMsg("Довставляю пропущені джерела...");
          try {
            const { text: fixedText } = await insertMissingCitations({ sectionText: text, insertions: missing, lang, callClaude });
            text = fixedText;
          } catch (e) { console.error("insertMissingCitations (tezy):", e.message); }
        }
      }

      // Код-рівнева підстраховка: модель не завжди дотримується ліміту "не більше
      // 2 разів" заданого лише текстом промпту (sourcesContext вище).
      text = capCitationRepeats(text);
      setResult(text);
      playDoneSound();
      await saveToFirestore({ result: text, authorData, tezyCitations: activeCitations, stage: "done", status: "done" });
      setStage("done");
      webImg.searchAll({ ...simpleWebImageArgs(text), auto: true }).catch(e => console.error("webImages:", e.message));
    } catch (e) { setError(e.message); }
    setRunning(false); setLoadMsg("");
  };

  // ── Генерація плану реферату ──
  const doGenPlan = async (infoOverride) => {
    setRunning(true); setLoadMsg("Генерую план...");
    const effInfo = infoOverride || info;
    const totalPages = parsePagesAvg(effInfo?.pages);
    const chapCount = totalPages < 10 ? 2 : 3;
    const pagesPerChap = Math.max(2, Math.round((totalPages - 2) / chapCount));
    // Підписи вступу/висновків/списку джерел і слово "розділ" — мовою роботи (як у runReferatPlan, smallStages.js)
    const L = getLangLabels(effInfo?.language);

    let newSections = [];
    try {
      if (clientPlan?.trim()) {
        const lines = extractPlanBlock(clientPlan).split("\n").map(l => l.trim()).filter(Boolean);
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
        const fileContext = await toClaudeFilesAsync(files);

        const chapEntries = Array.from({ length: chapCount }, (_, i) =>
          `  {"id":"${i + 1}","label":"${chapterHeadingPrefix(effInfo?.language, i + 1)}. Назва","pages":${pagesPerChap}}`
        ).join(",\n");

        const prompt = `Склади план реферату.
Тема: "${effInfo?.topic}". Галузь: ${effInfo?.subject || ""}. Обсяг: ${totalPages} стор.
${L.code !== "uk" ? `Мова роботи: ${effInfo?.language}. Усі назви в плані (розділи, вступ, висновки, список джерел) — ТІЛЬКИ цією мовою.\n` : ""}Кількість основних розділів: ${chapCount}.
${effInfo?.requirements ? `Вимоги методички: ${effInfo.requirements}` : ""}
${deptGuidanceText?.trim() ? `\nДодаткові рекомендації кафедри/викладача (враховуй нарівні з методичкою): ${deptGuidanceText.trim()}\n` : ""}
${structureExampleText?.trim() ? `\nЗРАЗОК СТРУКТУРИ реферату — побудуй план розділів за реальною структурою цього зразка:\n${structureExampleText.trim().slice(0, 4000)}\n` : ""}

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
        const raw = await callClaude(msgs, null, "Respond only with valid JSON. No markdown.", 1200, null, model);
        const parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || raw);
        // Ігноруємо id від AI для розділів — перенумеровуємо за позицією, щоб гарантувати "1","2","3"...
        let chapN = 0;
        newSections = (parsed.sections || []).map(s => {
          if (["intro", "conclusions", "sources"].includes(s.id)) return { ...s, text: "" };
          chapN++;
          return { ...s, id: `${chapN}`, text: "" };
        });
      }

      setSections(newSections);
      await saveToFirestore({ sections: newSections, stage: "plan", status: "plan_ready", clientPlan });
    } catch (e) { setError(e.message); }
    setRunning(false); setLoadMsg("");
    return newSections;
  };

  // ── План реферату: перенумерація розділів/підрозділів за позицією у масиві ──
  // Розділ без sectionTitle = "цілий розділ" (id "1","2"...). Підрозділ має sectionTitle = заголовок батьківського розділу, id "1.1","1.2"...
  // "РОЗДІЛ 2" як і раніше; заголовок іншою мовою ("CHAPTER 2", "第2章", "2. FEJEZET") — міняємо лише номер
  const renumberChapterTitle = (title, n) => /^РОЗДІЛ\s+\d+/i.test(title)
    ? title.replace(/^РОЗДІЛ\s+\d+/i, `РОЗДІЛ ${n}`)
    : chapterWordRe().test(title) ? title.replace(/\d+/, String(n)) : title;
  const renumberReferatSections = (list) => {
    let chapNum = 0, lastTitle = null, subNum = 0;
    const titleMap = {};
    return list.map(s => {
      if (["intro", "conclusions", "sources"].includes(s.id)) return s;
      if (!s.sectionTitle) {
        chapNum++; lastTitle = null;
        return { ...s, id: `${chapNum}`, label: renumberChapterTitle(s.label, chapNum) };
      }
      if (s.sectionTitle !== lastTitle) { chapNum++; lastTitle = s.sectionTitle; subNum = 0; }
      subNum++;
      const newId = `${chapNum}.${subNum}`;
      if (!titleMap[s.sectionTitle]) {
        titleMap[s.sectionTitle] = renumberChapterTitle(s.sectionTitle, chapNum);
      }
      const newLabel = /^\d+\.\d+/.test(s.label) ? s.label.replace(/^\d+\.\d+/, newId) : `${newId} ${s.label}`;
      return { ...s, id: newId, sectionTitle: titleMap[s.sectionTitle], label: newLabel };
    });
  };

  // Групує рядки-розділи у "блоки": цілий розділ = блок з 1 рядка, розбитий розділ = блок з його підрозділів
  const getReferatBlocks = (mainRows) => {
    const blocks = [];
    let i = 0;
    while (i < mainRows.length) {
      const row = mainRows[i];
      if (!row.sectionTitle) { blocks.push([row]); i++; continue; }
      const title = row.sectionTitle;
      const rows = [];
      while (i < mainRows.length && mainRows[i].sectionTitle === title) { rows.push(mainRows[i]); i++; }
      blocks.push(rows);
    }
    return blocks;
  };

  // Додати підрозділ: якщо клікнули на цілий розділ — розбиває його на 2 підрозділи; якщо на підрозділ — додає ще один поруч у тому ж розділі
  const addReferatSubsection = (rowId) => {
    setSections(prev => {
      const idx = prev.findIndex(s => s.id === rowId);
      if (idx < 0) return prev;
      const row = prev[idx];
      let next;
      if (!row.sectionTitle) {
        const half = Math.max(1, Math.round((row.pages || 2) / 2));
        const sub1 = { id: `${row.id}.1`, label: `${row.id}.1 [Підрозділ]`, sectionTitle: row.label, pages: half, text: "" };
        const sub2 = { id: `${row.id}.2`, label: `${row.id}.2 [Підрозділ]`, sectionTitle: row.label, pages: Math.max(1, (row.pages || 2) - half), text: "" };
        next = [...prev.slice(0, idx), sub1, sub2, ...prev.slice(idx + 1)];
      } else {
        const chapNum = row.id.split(".")[0];
        const siblings = prev.filter(s => s.sectionTitle === row.sectionTitle);
        const maxSub = Math.max(...siblings.map(s => parseInt(s.id.split(".")[1], 10) || 0));
        const newSub = { id: `${chapNum}.${maxSub + 1}`, label: `${chapNum}.${maxSub + 1} [Підрозділ]`, sectionTitle: row.sectionTitle, pages: 2, text: "" };
        next = [...prev.slice(0, idx + 1), newSub, ...prev.slice(idx + 1)];
      }
      return renumberReferatSections(next);
    });
  };

  // Додати новий цілий розділ (без підрозділів — за замовчуванням)
  const addReferatChapter = () => {
    setSections(prev => {
      const mainNums = prev.filter(s => !["intro", "conclusions", "sources"].includes(s.id))
        .map(s => parseInt(s.id.split(".")[0], 10) || 0);
      const nextNum = (mainNums.length ? Math.max(...mainNums) : 0) + 1;
      const newChap = { id: `${nextNum}`, label: `${chapterHeadingPrefix(info?.language, nextNum)}. [Назва розділу]`, pages: 3, text: "" };
      const insertAt = prev.findIndex(s => s.id === "conclusions");
      const at = insertAt >= 0 ? insertAt : prev.length;
      return renumberReferatSections([...prev.slice(0, at), newChap, ...prev.slice(at)]);
    });
  };

  // Переміщення: підрозділи — лише в межах свого розділу; цілі розділи — серед інших розділів
  const moveReferatRow = (rowId, dir) => {
    setSections(prev => {
      const front = prev.filter(s => s.id === "intro");
      const back = prev.filter(s => s.id === "conclusions" || s.id === "sources");
      const mainRows = prev.filter(s => !["intro", "conclusions", "sources"].includes(s.id));
      const blocks = getReferatBlocks(mainRows);
      const blockIdx = blocks.findIndex(b => b.some(r => r.id === rowId));
      if (blockIdx < 0) return prev;
      const block = blocks[blockIdx];
      if (block.length > 1) {
        const rowIdx = block.findIndex(r => r.id === rowId);
        const targetIdx = rowIdx + dir;
        if (targetIdx < 0 || targetIdx >= block.length) return prev;
        const newBlock = [...block];
        [newBlock[rowIdx], newBlock[targetIdx]] = [newBlock[targetIdx], newBlock[rowIdx]];
        const newBlocks = [...blocks]; newBlocks[blockIdx] = newBlock;
        return renumberReferatSections([...front, ...newBlocks.flat(), ...back]);
      }
      const targetBlockIdx = blockIdx + dir;
      if (targetBlockIdx < 0 || targetBlockIdx >= blocks.length) return prev;
      const newBlocks = [...blocks];
      [newBlocks[blockIdx], newBlocks[targetBlockIdx]] = [newBlocks[targetBlockIdx], newBlocks[blockIdx]];
      return renumberReferatSections([...front, ...newBlocks.flat(), ...back]);
    });
  };
  const moveReferatRowUp = (rowId) => moveReferatRow(rowId, -1);
  const moveReferatRowDown = (rowId) => moveReferatRow(rowId, 1);

  const deleteReferatRow = (rowId) => {
    setSections(prev => renumberReferatSections(prev.filter(s => s.id !== rowId)));
  };

  const recalcReferatPages = () => {
    const totalPages = parsePagesAvg(info?.pages);
    setSections(prev => {
      const mainRows = prev.filter(s => !["intro", "conclusions", "sources"].includes(s.id));
      const pagesForMain = Math.max(mainRows.length, totalPages - 2);
      const perRow = Math.max(1, Math.round(pagesForMain / Math.max(mainRows.length, 1)));
      return prev.map(s => {
        if (s.id === "intro" || s.id === "conclusions") return { ...s, pages: 1 };
        if (s.id === "sources") return s;
        return { ...s, pages: perRow };
      });
    });
  };

  // ── Придумати назви для заглушок (масово, якщо onlyId не задано, або для одного рядка) ──
  const doNameReferatPlaceholders = async (onlyId = null) => {
    if (onlyId) setSingleNamingId(onlyId); else setNamingLoading(true);
    try {
      const mainRows = sections.filter(s => !["intro", "conclusions", "sources"].includes(s.id));
      const scope = onlyId ? mainRows.filter(s => s.id === onlyId) : mainRows;
      const subPlaceholders = scope.filter(s => s.sectionTitle && /\[|новий/i.test(s.label));
      const chapPlaceholderIds = [...new Set([
        ...scope.filter(s => !s.sectionTitle && /\[|новий/i.test(s.label)).map(s => s.id),
        ...scope.filter(s => s.sectionTitle && /\[/.test(s.sectionTitle)).map(s => s.id.split(".")[0]),
      ])];
      if (!subPlaceholders.length && !chapPlaceholderIds.length) { if (onlyId) setSingleNamingId(null); else setNamingLoading(false); return; }

      const planContext = mainRows.map(s => `${s.id} — ${s.label}${s.sectionTitle ? ` (розділ: ${s.sectionTitle})` : ""}`).join("\n");
      const prompt = `Реферат. Тема: "${info?.topic}". Галузь: ${info?.subject || ""}.
Мова: ${info?.language || "Українська"} — усі назви мають бути цією мовою.

ПОТОЧНИЙ ПЛАН:
${planContext}

Придумай назви лише для заглушок (де у назві є дужки [...]). Назви мають відповідати темі, не повторювати вже існуючі.

Поверни ТІЛЬКИ JSON:
{"chapters":{${chapPlaceholderIds.map(id => `"${id}":"назва розділу"`).join(",")}},"subsections":{${subPlaceholders.map(s => `"${s.id}":"назва підрозділу"`).join(",")}}}`;

      const raw = await callClaude([{ role: "user", content: prompt }], null, "Respond only with valid JSON. No markdown.", 1200, null, MODEL_FAST);
      const parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || raw);
      const chapTitles = parsed.chapters || {};
      const subTitles = parsed.subsections || {};

      setSections(prev => prev.map(s => {
        if (!s.sectionTitle) {
          return chapTitles[s.id] ? { ...s, label: `${chapterHeadingPrefix(info?.language, s.id)}. ${chapTitles[s.id]}` } : s;
        }
        const chapNum = s.id.split(".")[0];
        const next = { ...s };
        if (chapTitles[chapNum]) next.sectionTitle = `${chapterHeadingPrefix(info?.language, chapNum)}. ${chapTitles[chapNum]}`;
        if (subTitles[s.id]) next.label = `${s.id} ${subTitles[s.id]}`;
        return next;
      }));
    } catch (e) {
      console.warn("referat naming failed:", e.message);
    }
    if (onlyId) setSingleNamingId(null); else setNamingLoading(false);
  };

  // ── Генерація тексту реферату (по секціях) ──
  useEffect(() => {
    if (workType !== "referat" || stage !== "writing" || running) return;
    if (runningRef.current) return;
    if (genIdx >= sections.length) {
      if (!writingDoneRef.current) {
        writingDoneRef.current = true;
        playDoneSound();
        saveToFirestore({ sections, stage: "done", status: "done" });
        setStage("done");
        // Список джерел форматуємо й розставляємо посилання одразу, без ручного
        // кліку — раніше користувач мав сам натискати "Сформувати список
        // літератури і посилання" на екрані "Готово".
        doFormatAndRemapCitations();
      }
      return;
    }
    const sec = sections[genIdx];
    if (sec.text) { setGenIdx(g => g + 1); return; }
    if (sec.id === "sources") {
      const totalPages = parsePagesAvg(info?.pages);
      // Збираємо всі унікальні джерела: пріоритет — tezyCitations (вже скомпільовані), потім citInputs
      let compiledCitations = tezyCitations;
      if (compiledCitations.length === 0 && Object.keys(citInputs).length > 0) {
        const all = [];
        sections.filter(s => s.id !== "sources").forEach(s => {
          (citInputs[s.id] || "").split("\n").map(l => l.trim()).filter(Boolean).forEach(l => {
            if (!all.includes(l)) all.push(l);
          });
        });
        compiledCitations = all;
      }
      const sourcesText = compiledCitations.length > 0
        ? compiledCitations.map((c, i) => `${i + 1}. ${c}`).join("\n")
        : citText.trim() || `Список використаних джерел формується за кількістю сторінок (${totalPages} джерел). Додайте джерела вручну.`;
      setSections(p => p.map((s, i) => i === genIdx ? { ...s, text: sourcesText } : s));
      setGenIdx(g => g + 1);
      return;
    }
    runSection(sec);
  }, [workType, stage, genIdx, running, sections]);

  const runSection = async (sec) => {
    runningRef.current = true; setRunning(true);
    setLoadMsg(`Генерую: ${sec.label}...`);
    const lang = info?.language || "Українська";
    const totalPages = parsePagesAvg(info?.pages);
    const chapCount = sections.filter(s => !["intro", "conclusions", "sources"].includes(s.id)).length;
    const pagesPerSec = sec.pages != null
      ? sec.pages
      : (sec.id === "intro" || sec.id === "conclusions"
          ? Math.max(1, Math.round(totalPages * 0.07))
          : Math.max(2, Math.round(totalPages * 0.8 / chapCount)));
    const approxParas = Math.max(3, Math.round(pagesPerSec * 3));

    // ── Джерела ──
    // Для реферату — беремо тільки джерела цієї секції, але з глобальними номерами.
    // ВАЖЛИВО: фолбек на tezyCitations (повний список джерел усієї роботи) —
    // лише для tezy/stattia/ese/prezentatsiya, де немає розбивки по розділах.
    // Для реферату, якщо citInputs[sec.id] порожній (intro/conclusions, чи
    // розділ без знайдених джерел), secCitations МАЄ лишатись порожнім масивом —
    // інакше нижче спрацьовує примусова вставка "пропущених" джерел і в текст
    // (напр. висновків) форсом вставляються посилання на ВСІ джерела роботи.
    const isReferat = workType === "referat";
    const secCitations = isReferat
      ? (citInputs[sec.id] || "").split("\n").map(s => s.trim()).filter(Boolean)
      : tezyCitations;
    const hasSources = secCitations.length > 0;

    let citeMap;
    if (isReferat && tezyCitations.length > 0 && secCitations.length > 0) {
      citeMap = {};
      secCitations.forEach(c => {
        const n = tezyCitations.indexOf(c) + 1;
        if (n > 0) citeMap[n] = `[${n}]`; // лише номер — сторінку ставить фінальний крок
      });
    } else {
      citeMap = buildCiteMap(secCitations);
    }

    const firstCiteRef = isReferat && tezyCitations.length > 0
      ? (citeMap[Object.keys(citeMap)[0]] || "[1]")
      : (citeMap[1] || "[1]");

    const sourcesBlock = hasSources
      ? isReferat && tezyCitations.length > 0
        ? `\nДЖЕРЕЛА ДЛЯ РОБОТИ (${secCitations.length} шт.) — спирайся на них, вставляй посилання у тексті ТОЧНО у форматі вказаному перед кожним джерелом:\n${secCitations.map(c => {
            const n = tezyCitations.indexOf(c) + 1;
            return `${citeMap[n] || `[${n}]`} ${c}`;
          }).join("\n")}\n`
        : `\nДЖЕРЕЛА ДЛЯ РОБОТИ (${secCitations.length} шт.) — спирайся на них, вставляй посилання у тексті ТОЧНО у форматі вказаному перед кожним джерелом:\n${secCitations.map((s, i) => `${citeMap[i + 1]} ${s}`).join("\n")}\n`
      : "";
    const citNote = hasSources
      ? `Вставляй позначку джерела ЗАВЖДИ в самому кінці речення, перед крапкою — ніколи не одразу після дієслова на початку речення. НЕПРАВИЛЬНО: 'Зазначається ${firstCiteRef}, що явище поширене.' ПРАВИЛЬНО: 'Явище поширене ${firstCiteRef}.' Безособові конструкції: 'встановлено, що ...', 'зазначається, що ...' — без позначки одразу після цих слів, позначка йде в кінці всього речення. Формат позначки — точно як у таблиці вище. ЗАБОРОНЕНО об'єднувати джерела через кому — ставь кожне окремо. Кожне джерело цитуй НЕ БІЛЬШЕ 2 РАЗІВ у межах цього підрозділу.`
      : "Без посилань на джерела.";

    // ── Матеріал ──
    const materialContext = materialText.trim()
      ? `\nМАТЕРІАЛ ДЛЯ РОБОТИ (використай як основу для змісту):\n${materialText.trim()}\n`
      : "";

    const methodReqBlock = methodRequirements?.trim()
      ? `\nВИМОГИ ДО РОБОТИ (ОБОВ'ЯЗКОВО дотримуватись):\n${methodRequirements}\n`
      : "";

    const matFileContext = materialFiles.length > 0
      ? [{ type: "text", text: "Матеріал для роботи (файли):" }, ...await toClaudeFilesAsync(materialFiles)]
      : [];
    const refFileContext = await toClaudeFilesAsync(files);

    // Номер розділу (для нумерації таблиць/рисунків X.Y) — підтримує і цілий розділ ("2"), і підрозділ ("2.1")
    const chapNum = sec.id.includes(".") ? sec.id.split(".")[0] : (/^\d+$/.test(sec.id) ? sec.id : null);
    const commentBlock = comment?.trim() ? `\nКОМЕНТАР ДО РОБОТИ: ${comment.trim()}\n` : "";
    const deptGuidanceBlock = isReferat && deptGuidanceText?.trim()
      ? `\nРЕКОМЕНДАЦІЇ КАФЕДРИ/ВИКЛАДАЧА (враховуй нарівні з методичкою): ${deptGuidanceText.trim()}\n`
      : "";
    // Текст уже написаних секцій — контекст, щоб модель бачила, яким стилем відкриття/
    // завершення вже скористалась, і свідомо обрала інший (без цього кожна секція
    // генерується окремим викликом наосліп і всі відкриваються однаково).
    const priorSectionsContext = isReferat
      ? sections.filter(s => s.id !== sec.id && s.id !== "sources" && s.text?.trim())
          .map(s => `=== ${s.label} ===\n${s.text.trim()}`).join("\n\n")
      : "";
    const priorContextBlock = priorSectionsContext
      ? `ПОПЕРЕДНІ СЕКЦІЇ РЕФЕРАТУ (вже написані — контекст лише для стилю: не повторюй їх зміст і факти, орієнтуйся на них тільки щоб обрати ІНШИЙ стиль відкриття та завершення абзацу):\n${priorSectionsContext}\n\n`
      : "";

    let instruction = "";
    if (sec.id === "intro") {
      // Якщо методичка явно вказала структуру вступу — використовуємо її
      const hasMethodIntroReq = info?.introStructure || (info?.requirements && /вступ.*(?:актуальн|мет[аи]|об.єкт|предмет)/i.test(info.requirements));
      const introStructure = hasMethodIntroReq
        ? `Структура вступу відповідно до вимог: ${info.introStructure || info.requirements}`
        : `Структура вступу (СТРОГО: кожен елемент — один окремий абзац, мітка і текст на ОДНОМУ рядку):
Абзац 1 — починай рядок зі слів "Актуальність теми:" і одразу на тому ж рядку пиши 95-110 слів актуальності (без переносу рядка між міткою і текстом).
Абзац 2 — починай рядок зі слів "Об'єкт дослідження:" і одразу на тому ж рядку — одне речення про що досліджується.
Абзац 3 — починай рядок зі слів "Предмет дослідження:" і одразу на тому ж рядку — конкретний аспект об'єкту.
Абзац 4 — починай рядок зі слів "Мета роботи:" і одразу на тому ж рядку — одне речення.
Абзац 5 — починай рядок зі слів "Завдання дослідження:" і одразу на тому ж рядку — 3-4 завдання через крапку з комою АБО кожне з нового рядка як продовження абзацу.
ЗАБОРОНЕНО: НЕ пиши мітку окремим рядком а текст нижче — мітка і текст завжди разом на одному рядку.`;
      instruction = `${priorContextBlock}Напиши ВСТУП для реферату на тему "${info?.topic}".
${materialContext}${methodReqBlock}${commentBlock}${deptGuidanceBlock}${introStructure}
${!methodReqBlock && info?.requirements ? `\nДодаткові вимоги: ${info.requirements}` : ""}
Обсяг: ~${approxParas} абзаців (~${pagesPerSec} стор.). Без цитат на джерела. Починай одразу з тексту — не пиши слово "Вступ" на початку.`;
    } else if (sec.id === "conclusions") {
      instruction = `${priorContextBlock}Напиши ВИСНОВКИ для реферату на тему "${info?.topic}".
${materialContext}${methodReqBlock}${commentBlock}${deptGuidanceBlock}Підсумуй основні результати по кожному розділу. Конкретні висновки без загальних фраз.
${!methodReqBlock && info?.requirements ? `Вимоги: ${info.requirements}\n` : ""}Обсяг: ~${approxParas} абзаців (~${pagesPerSec} стор.). Без цитат. Без жирного. Без нумерації. Пиши суцільними абзацами.`;
    } else if (sec.sectionTitle) {
      // Підрозділ — частина розбитого розділу
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

    try {
      const secMaxTokens = Math.min(30000, Math.max(6000, Math.round(pagesPerSec * 3000)));
      const sysSmall = buildSYSSmall(lang, isReferat ? "referat" : null);
      const raw = cleanDash(await callClaude(msgs, null, sysSmall, secMaxTokens));
      let result = await enforceWordCount({
        text: raw, targetWords: Math.round(pagesPerSec * 230), label: sec.label,
        callClaude, sys: sysSmall, onProgress: setLoadMsg, clean: cleanDash,
      });
      try {
        result = await fixDanglingFigures({ text: result, lang, callClaude });
      } catch (e) { console.error("fixDanglingFigures:", e.message); }
      try {
        result = await fixMissingTableConclusion({ text: result, lang, callClaude });
      } catch (e) { console.error("fixMissingTableConclusion:", e.message); }

      // Довставляємо джерела секції, які мали бути процитовані (sourcesBlock), але
      // модель їх пропустила — без цього джерело лишалось би "осиротілим" у списку
      // літератури (додане до citInputs, але жодного разу не згадане в тексті).
      if (isReferat && secCitations.length) {
        const citedNums = new Set(extractCitedNumbers(result));
        const missing = secCitations
          .map(c => ({ number: tezyCitations.indexOf(c) + 1, sourceText: c }))
          .filter(s => s.number > 0 && !citedNums.has(s.number))
          .map(s => ({ ...s, marker: citeMap[s.number] || `[${s.number}]` }));
        if (missing.length) {
          setLoadMsg(`Довставляю пропущені джерела: ${sec.label}...`);
          try {
            const { text } = await insertMissingCitations({ sectionText: result, insertions: missing, lang, callClaude });
            result = text;
          } catch (e) { console.error("insertMissingCitations (referat):", e.message); }
        }
        // Код-рівнева підстраховка: модель не завжди дотримується ліміту "не більше
        // 2 разів" заданого лише текстом промпту (citNote вище) — обрізаємо зайві
        // повтори примусово.
        result = capCitationRepeats(result);
      } else if (isReferat && (sec.id === "intro" || sec.id === "conclusions")) {
        // Код-рівнева підстраховка для вступу й висновків: інструкція "Без цитат"
        // у промпті — лише текстова, модель іноді все одно вставляє маркер [N].
        // Для цих секцій sourcesBlock узагалі не передається, тож жодне [N] тут
        // не може бути легітимним — прибираємо будь-які цитатні маркери. Інакше
        // такий маркер пройшов би непоміченим крізь remapAndFormatCitations (він
        // лише перенумеровує вже наявні валідні номери, а не видаляє зайві).
        result = result.replace(/\s?\[[^[\]]*\d[^[\]]*\]/g, "").replace(/[ \t]{2,}/g, " ").replace(/[ \t]+([.,;:!?])/g, "$1");
      }

      setSections(p => {
        const next = p.map((s, i) => i === genIdx ? { ...s, text: result } : s);
        saveToFirestore({ sections: next, stage: "writing", status: "writing", genIdx: genIdx + 1 });
        return next;
      });
      await new Promise(r => setTimeout(r, 2000));
      setGenIdx(g => g + 1);
    } catch (e) {
      setError(e.message);
    }
    runningRef.current = false; setRunning(false); setLoadMsg("");
  };

  // ── Генерація статті/есе ──
  const doGenerateSimple = async (citationsOverride) => {
    setRunning(true); setLoadMsg("Генерую...");
    resetGenerationCost();
    const controller = new AbortController();
    genAbortRef.current = controller;
    const lang = info?.language || "Українська";
    const totalPages = parsePagesAvg(info?.pages || "5");

    const fileContext = await toClaudeFilesAsync(files);
    const matFileContext = materialFiles.length > 0
      ? [{ type: "text", text: "Матеріал для роботи (файли — проаналізуй і використай):" }, ...await toClaudeFilesAsync(materialFiles)]
      : [];

    const activeCitations = citationsOverride ?? tezyCitations;
    const hasSources = activeCitations.length > 0;
    const citeMap = buildCiteMap(activeCitations);
    const sourcesContext = hasSources
      ? `\nДЖЕРЕЛА — при цитуванні вставляй у текст ЛИШЕ технічну позначку [N] (де N — номер джерела нижче), БЕЗ сторінки — сторінку система підставить сама з діапазону джерела. НІКОЛИ не пиши саму цитату (прізвище автора, рік, сторінку) в тексті в жодному вигляді — ні круглими дужками (Автор, рік), ні квадратними [Автор, рік, с. X]: остаточний стиль оформлення цитати підставить система вже після генерації, це не твоя турбота. Цитуй ЛИШЕ джерела зі списку нижче під їхніми номерами — категорично не згадуй і не посилайся на будь-яке інше дослідження, статтю чи автора, якого немає в цьому списку, яким би доречним воно не здавалося. Кожне джерело цитуй НЕ БІЛЬШЕ 2 РАЗІВ за весь текст роботи (рахуючи всі частини разом) — навіть якщо воно дуже доречне, для третього разу сформулюй без цитування або спирайся на інше джерело. ТОЧНО у форматі перед кожним джерелом:\n${activeCitations.map((s, i) => `${citeMap[i + 1]} ${s}`).join("\n")}`
      : "";
    const sourcesList = hasSources
      ? `\n${sourcesHeading(lang)}:\n${activeCitations.map((s, i) => `${i + 1}. ${s}`).join("\n")}`
      : "";

    const materialContext = materialText.trim()
      ? `\nМАТЕРІАЛ ДЛЯ РОБОТИ (проаналізуй і використай як основу):\n${materialText.trim()}\n`
      : "";

    // Підпис рисунка мовою роботи — той самий figWord, за яким експорт шукає підписи
    const figWordW = getLangLabels(lang).figWord;
    const figureInstr = (info?.needsFigures && (info?.figureCount || 0) > 0)
      ? `\nРИСУНКИ (${info.figureCount} шт.): Постав рисунки у текст там де доречно. Для кожного рисунку:
– у реченні зроби посилання: (${figWordW.toLowerCase()} N)
– після абзацу з посиланням окремим рядком маркер пошуку: [🔍 Рисунок N: "конкретний пошуковий запит для Google Images"]
– наступний рядок — підпис: ${figWordW} N — Назва рисунку`
      : "";

    const isEnglishLang = /англ|english/i.test(lang);
    const typePrompts = {
      stattia: isEnglishLang
        ? `Write an ACADEMIC ARTICLE. Do NOT write a title line or author block — those are added separately by the system; start directly with the UDC line (if applicable) and the abstract. Do NOT write the word "ARTICLE" as a heading label anywhere in the document.
Field: ${[info?.subject, info?.direction].filter(Boolean).join(", ")}.
Default structure: Introduction (relevance, aim), Materials and Methods, Results and Discussion, Conclusions. If the requirements or provided materials below specify a different structure — use that instead.
Length: ~${totalPages} pages. Academic style. No bold.`
        : `Напиши НАУКОВУ СТАТТЮ. НЕ пиши назву статті і блок автора — вони додаються окремо системою; починай одразу з рядка УДК (якщо потрібен) і анотації. НЕ додавай слово «СТАТТЯ» як окремий заголовок-рядок ніде в документі.
Галузь: ${[info?.subject, info?.direction].filter(Boolean).join(", ")}.
Структура за замовчуванням: Вступ (актуальність, мета), Матеріали і методи, Результати та обговорення, Висновки. Якщо у вимогах або наданих матеріалах нижче вказана інша структура — використай її замість цієї.
Обсяг: ~${totalPages} сторінок. Академічний стиль. Без жирного.`,
      ese: isEnglishLang
        ? `Write an ESSAY. Do NOT write the word "ESSAY" as a heading label — start directly with the title.
Title: "${info?.topic}".
Default structure: thesis, arguments with examples (3-4 paragraphs), counter-argument, conclusion. If the requirements or provided materials below specify a different structure — use that instead.
Length: ~${totalPages} pages. Analytical style. No bold.`
        : `Напиши ЕСЕ. НЕ додавай слово «ЕСЕ» як окремий заголовок-рядок — починай одразу з назви.
Назва: "${info?.topic}".
Структура за замовчуванням: теза, аргументи з прикладами (3-4 абзаци), контраргумент, висновок. Якщо у вимогах або наданих матеріалах нижче вказана інша структура — використай її замість цієї.
Обсяг: ~${totalPages} сторінок. Аналітичний стиль. Без жирного.`,
    };

    // Наукова стаття (на відміну від есе) конвенційно вимагає УДК, блок автора
    // і анотацію з ключовими словами — без цього робота виглядає неповною.
    // Назву й блок автора будуємо кодом (нижче, після генерації) — жирним/по
    // центру гарантовано, а не залежно від того, чи модель виконає інструкцію
    // "жирним" всупереч загальній забороні жирного тексту в системному промпті.
    let articleFrontMatter = "";
    let authorBlockLines = "";
    const authorFormat = info?.authorFormat || "center";
    if (workType === "stattia") {
      const ad = authorData;
      // Заглушки авторського блоку й підписи УДК/анотації/ключових слів — мовою роботи (як у smallStages.js)
      const L = getLangLabels(lang);
      const authorName = ad.authorName?.trim() || L.authorPlaceholder;
      const supervisor = ad.supervisor?.trim() || "";
      const university = ad.university?.trim() || L.universityPlaceholder;
      const faculty = ad.faculty?.trim() || "";
      const role = ad.role?.trim() || "";
      const email = (info?.needsEmail && ad.email?.trim()) ? ad.email.trim() : null;
      authorBlockLines = [
        authorName + (role ? `, ${role}` : ""),
        supervisor,
        university + (faculty ? `, ${faculty}` : ""),
        email,
      ].filter(Boolean).join("\n");

      articleFrontMatter = isEnglishLang
        ? `\n${info?.needsUDK !== false ? "First line of the document: UDC [appropriate code for the topic]\n" : ""}Then — ABSTRACT: start the line with "Abstract." and immediately on the same line write 50-80 words (aim, methods, results). Next line: "Keywords:" followed by 5-7 keywords separated by commas.`
        : `\n${info?.needsUDK !== false ? `Перший рядок документу: ${L.udc} [відповідний код для теми]\n` : ""}Далі — АНОТАЦІЯ: почни рядок зі слова "${L.abstractWord}." і одразу на тому ж рядку 50-80 слів анотації (мета, методи, результати). Наступний рядок: "${L.keywordsWord}:" і одразу 5-7 ключових слів через кому.`;
    }

    const commonTailBlock = `${materialContext}
${comment?.trim() ? `\nКОМЕНТАР ЗАМОВНИКА (виконай обов'язково): ${comment.trim()}\n` : ""}${methodRequirements?.trim() ? `\nВИМОГИ ДО РОБОТИ (ОБОВ'ЯЗКОВО дотримуватись):\n${methodRequirements}` : (info?.requirements ? `\nВИМОГИ: ${info.requirements}` : "")}
${info?.uniqueness ? `Унікальність: ${info.uniqueness}.` : ""}
Мова: ${lang}.
${sourcesContext}`;

    // ── Розбивка генерації на частини по ~6 сторінок — довгий одноразовий виклик
    // гірше тримає структуру, обсяг і рівномірність цитувань (модель "забуває"
    // вже використані джерела за тисячі слів поспіль). Короткі роботи (≤6 стор.)
    // лишаються одним викликом — без змін порівняно з попередньою поведінкою.
    const CHUNK_PAGES = 6;
    const numChunks = Math.max(1, Math.ceil(totalPages / CHUNK_PAGES));
    const basePages = Math.floor(totalPages / numChunks);
    const extraPages = totalPages % numChunks;
    const chunkPages = Array.from({ length: numChunks }, (_, i) => basePages + (i < extraPages ? 1 : 0));

    let fullText = "";
    try {
      for (let i = 0; i < numChunks; i++) {
        const isFirst = i === 0;
        const isLast = i === numChunks - 1;
        const pagesForChunk = chunkPages[i];
        setLoadMsg(numChunks > 1 ? `Генерую частину ${i + 1}/${numChunks}...` : "Генерую...");

        // Рахуємо, скільки разів кожне джерело вже процитоване у вже написаному
        // тексті — щоб наступна частина (а) не тягнулась до тих самих 2-3 "зручних"
        // джерел і (б) не перевищила ліміт 2 цитувань на джерело за весь текст.
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
          sectionPrompt = `${typePrompts[workType] || `Напиши роботу на тему "${info?.topic}".`}
${articleFrontMatter}${commonTailBlock}${figureInstr}${usedNote}
${numChunks > 1 && !isLast ? `\nЦе ПЕРША частина роботи загальним обсягом ~${totalPages} стор. Напиши перші ~${pagesForChunk} стор. НЕ пиши висновків і не завершуй роботу — це буде в наступних частинах.` : ""}`;
        } else {
          // Повний текст (не лише хвіст) — інакше модель не бачить, що вже написано в
          // попередніх частинах, і повторює ті самі тези та посилання на джерела ще раз.
          sectionPrompt = `Ось уже написана частина роботи на тему "${info?.topic}" (це продовження, частина ${i + 1} з ${numChunks}):
${fullText}

Продовж органічно від того місця, де текст вище закінчується, ще на ~${pagesForChunk} стор. КАТЕГОРИЧНО НЕ повторюй тези, приклади, формулювання чи посилання на джерела [N], які вже є в тексті вище — рухайся далі за змістом, розкривай нові аспекти, а не переказуй заново вже сказане. КАТЕГОРИЧНО НЕ повторюй жоден рисунок/таблицю/діаграму (і їхній підпис "Рис. N"), що вже наведені в тексті вище, навіть іншими словами чи в іншому форматуванні — кожен номер рисунка може з'явитися в роботі лише один раз.
${commonTailBlock}${usedNote}
${isLast ? "Це ОСТАННЯ частина — заверши роботу логічними висновками." : "Це НЕ остання частина — висновків поки не пиши, вони будуть далі."}`;
        }

        const msgs = [{ role: "user", content: [...matFileContext, ...fileContext, { type: "text", text: sectionPrompt }] }];
        const chunkMaxTokens = Math.min(20000, Math.max(4000, Math.round(pagesForChunk * 3000)));
        const rawChunk = cleanDash(await callClaude(msgs, controller.signal, buildSYSSmall(lang, workType === "ese" ? "ese" : null), chunkMaxTokens));
        const chunkText = await enforceWordCount({
          text: rawChunk, targetWords: Math.round(pagesForChunk * 230),
          label: `${info?.topic || ""}${numChunks > 1 ? ` — частина ${i + 1}/${numChunks}` : ""}`,
          callClaude, sys: buildSYSSmall(lang, workType === "ese" ? "ese" : null), signal: controller.signal, onProgress: setLoadMsg, clean: cleanDash,
        });
        fullText = fullText ? `${fullText}\n\n${chunkText.trim()}` : chunkText.trim();
      }

      fullText = dedupeRepeatedFigures(fullText, lang);

      try {
        fullText = await fixDanglingFigures({ text: fullText, lang, callClaude, signal: controller.signal });
      } catch (e) { console.error("fixDanglingFigures:", e.message); }

      // Довставляємо джерела, які мали бути процитовані (sourcesContext/usedNote), але
      // модель їх пропустила — без цього джерело лишалось би "осиротілим" у списку
      // джерел (додане до списку, але жодного разу не згадане в тексті).
      if (hasSources) {
        const citedNums = new Set(extractCitedNumbers(fullText));
        const missing = activeCitations
          .map((c, i) => ({ number: i + 1, sourceText: c, marker: citeMap[i + 1] || `[${i + 1}]` }))
          .filter(s => !citedNums.has(s.number));
        if (missing.length) {
          setLoadMsg("Довставляю пропущені джерела...");
          try {
            const { text: fixedText } = await insertMissingCitations({ sectionText: fullText, insertions: missing, lang, callClaude, signal: controller.signal });
            fullText = fixedText;
          } catch (e) { console.error("insertMissingCitations (essay):", e.message); }
        }
      }

      // Код-рівнева підстраховка: модель не завжди дотримується ліміту "не більше
      // 2 разів" заданого лише текстом промпту (usedNote/sourcesContext вище).
      fullText = capCitationRepeats(fullText);

      // Назву й блок автора вставляємо кодом на початок — з маркерами \x00TITLE\x00/
      // \x00AUTHORBLOCK\x00, які exportSimpleDocx розпізнає й рендерить жирним по
      // центру (чи праворуч), незалежно від того, що написала модель. Якщо модель
      // почала відповідь з рядка "УДК ..." (як просили) — переносимо його ще вище,
      // перед назвою, а не лишаємо після (порядок має бути: УДК → назва → автор).
      if (workType === "stattia") {
        let udkLine = "";
        const udkMatch = fullText.match(/^((?:УДК|UDC)\s[^\n]*)\n+/i);
        if (udkMatch) {
          udkLine = udkMatch[1];
          fullText = fullText.slice(udkMatch[0].length);
        }
        const titleText = (info?.topic || "").toUpperCase();
        const frontMatter = [
          udkLine,
          `\x00TITLE\x00\n${titleText}\n\x00/TITLE\x00`,
          authorBlockLines ? `\x00AUTHORBLOCK:${authorFormat}\x00\n${authorBlockLines}\n\x00/AUTHORBLOCK\x00` : "",
        ].filter(Boolean).join("\n\n");
        fullText = `${frontMatter}\n\n${fullText}`;
      }

      // Список джерел додається кодом (не проситься від моделі) — надійніше й
      // точно у форматі, який очікує подальший крок форматування/перенумерації.
      const finalText = `${fullText}${sourcesList ? `\n\n${sourcesList}` : ""}`;
      setResult(finalText);
      playDoneSound();
      await saveToFirestore({ result: finalText, tezyCitations: activeCitations, stage: "done", status: "done" });
      setStage("done");
      webImg.searchAll({ ...simpleWebImageArgs(finalText), auto: true }).catch(e => console.error("webImages:", e.message));
    } catch (e) {
      setError(e.name === "AbortError" || e.message === "AbortError" ? "Генерацію зупинено." : e.message);
    }
    genAbortRef.current = null;
    setRunning(false); setLoadMsg("");
  };

  // ── Допоміжна: текст роботи для прези/доповіді ──
  const getWorkFullText = () => {
    if (workType === "dopovid") return "";
    if (workType === "referat") {
      return sections.filter(s => s.text).map(s => `### ${s.label}\n${s.text}`).join("\n\n");
    }
    return result || "";
  };

  // ── Допоміжна: fileContent для dopovid ──
  // DOCX → текст через mammoth; PPTX → текст зі слайдів; PDF/зображення → передаємо як файл
  const getDopovIdFileContent = async () => {
    if (!presFile) return { fileContent: [], extractedText: "" };
    const isDocx = presFile.type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      || presFile.name?.toLowerCase().endsWith(".docx")
      || presFile.name?.toLowerCase().endsWith(".doc");
    const isPptx = presFile.type === "application/vnd.openxmlformats-officedocument.presentationml.presentation"
      || presFile.name?.toLowerCase().endsWith(".pptx");
    if (isDocx) {
      try {
        const bytes = Uint8Array.from(atob(presFile.b64), c => c.charCodeAt(0));
        const result = await mammoth.extractRawText({ arrayBuffer: bytes.buffer });
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
  };

  // ── Презентація для малих робіт (один Claude виклик) ──
  const generateSmallPresentation = async () => {
    setPresLoading(true);
    setPresMsg("Генерую презентацію...");
    try {
      const lang = info?.language || "Українська";
      const fullText = getWorkFullText();
      const isDopovid = workType === "dopovid";
      const commentBlock = presComment.trim() ? `\nКОМЕНТАР ЗАМОВНИКА (виконай обов'язково): ${presComment.trim()}\n` : "";
      const { fileContent, extractedText } = isDopovid
        ? await getDopovIdFileContent()
        : { fileContent: presFile ? [{ type: presFile.type.startsWith("image/") ? "image" : "document", source: { type: "base64", media_type: presFile.type, data: presFile.b64 } }] : [], extractedText: "" };
      const workText = fullText || extractedText;
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

      setPresMsg("Аналізую та генерую слайди...");
      const userContent = [
        ...fileContent,
        { type: "text", text: claudePrompt },
      ];
      const claudeRaw = await callClaude(
        [{ role: "user", content: userContent }], null,
        SYS_JSON_SHORT, 12000,
        (s) => setPresMsg(`Генерую... зачекайте ${s}с`), MODEL
      );

      let slideData;
      try {
        slideData = JSON.parse(cleanDash(claudeRaw.replace(/```json\n?|\n?```/g, "").trim()));
      } catch { throw new Error("Claude повернув некоректний JSON слайдів"); }

      // ── Крок 3: Зберігаємо дані ДО експорту (щоб при помилці або оновленні сторінки не загубити) ──
      setPresSlideJson(slideData);
      setPresReady(true);
      await saveToFirestore({ presReady: true, presSlideJson: slideData });

      // ── Крок 4: Створюємо PPTX ──
      setPresMsg("Створюю файл...");
      await exportToPptxFile(slideData, info, currentIdRef.current);
    } catch (e) { alert("Помилка генерації презентації: " + e.message); }
    setPresLoading(false);
    setPresMsg("");
  };

  // ── Доповідь, розмічена по слайдах (мітки "Слайд N" над уже готовим текстом доповіді) ──
  const generateSpeechWith = async () => {
    if (!speechText.trim()) {
      alert("Спочатку згенеруйте доповідь.");
      return;
    }
    if (!presSlideJson?.slides?.length) {
      alert("Спочатку згенеруйте презентацію.");
      return;
    }
    setSpeechWithLoading(true);
    try {
      const lang = info?.language || "Українська";

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
        [{ role: "user", content: prompt }], null,
        "You only segment and label the given text into slide-aligned fragments — you must not rewrite, paraphrase, shorten or add anything to it.", 5000,
        null, "gemini-2.5-flash"
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

      // Видаляємо мітки "Слайд N" без тексту після них
      const cleaned = lines
        .filter((line, i) => {
          if (!/^Слайд\s+\d+/i.test(line.trim())) return true;
          const nextNonEmpty = lines.slice(i + 1).find(l => l.trim());
          return nextNonEmpty && !/^Слайд\s+\d+/i.test(nextNonEmpty.trim());
        })
        .join("\n")
        .replace(/\*\*(.+?)\*\*/g, "$1").replace(/\*(.+?)\*/g, "$1");

      setSpeechWithText(cleaned);
      await saveToFirestore({ speechWithText: cleaned });
    } catch (e) { alert("Помилка розмітки доповіді: " + e.message); }
    setSpeechWithLoading(false);
  };

  // ── Доповідь без прив'язки до слайдів ──
  const generateSpeechWithout = async () => {
    setSpeechLoading(true);
    try {
      const lang = info?.language || "Українська";
      const sectionText = getWorkFullText();
      const isDopovid = workType === "dopovid";
      const { fileContent: dopFile, extractedText: dopText } = isDopovid ? await getDopovIdFileContent() : { fileContent: [], extractedText: "" };
      const workText = sectionText || dopText;

      const prompt = `Напиши текст доповіді для захисту ${info?.type || cfg?.label || "роботи"} на тему "${info?.topic}".
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
        speechMsgsWithout, null,
        "You are an expert academic writing assistant. Write a substantive, factual oral defense speech. Every sentence must state a concrete fact, method, result or conclusion — no filler phrases. No markdown formatting.", 5000,
        null, "gemini-2.5-flash"
      );

      const cleaned = typographQuotes(stripStrayCJK(raw
        .split("\n")
        .filter(line => {
          const t = line.trim();
          if (!t) return true;
          if (/^\d+(\.\d+)+[\s\.]/.test(t)) return false;
          if (/^#{1,6}\s/.test(t)) return false;
          return true;
        })
        .join("\n"), lang), lang)
        .replace(/\*\*(.+?)\*\*/g, "$1").replace(/\*(.+?)\*/g, "$1");

      setSpeechText(cleaned);
      await saveToFirestore({ speechText: cleaned });
    } catch (e) { alert("Помилка генерації доповіді: " + e.message); }
    setSpeechLoading(false);
  };

  // ── Генерація презентації (2 кроки) ──
  const doGeneratePresentation = async (citationsOverride) => {
    setRunning(true);
    const lang = info?.language || "Українська";
    const totalSlides = Math.max(8, Math.min(20, parsePagesAvg(info?.pages || "15")));
    const activeCitations = citationsOverride ?? tezyCitations;
    const hasSources = activeCitations.length > 0;
    const citStyle = info?.citStyle || "ДСТУ 8302:2015";

    const fileContext = await toClaudeFilesAsync(files);
    const matFileContext = materialFiles.length > 0
      ? [{ type: "text", text: "Матеріал для презентації (проаналізуй і використай для наповнення слайдів):" }, ...await toClaudeFilesAsync(materialFiles)]
      : [];
    const instrFileContext = instrFiles.length > 0
      ? [{ type: "text", text: "Інструкції з оформлення (уважно прочитай і виконай при побудові слайдів — структура, вимоги, приклади):" }, ...await toClaudeFilesAsync(instrFiles)]
      : [];
    const materialContext = materialText.trim()
      ? `\nМАТЕРІАЛ (використай як основу змісту):\n${materialText.trim()}\n`
      : "";
    const reqBlock = methodRequirements?.trim()
      ? `\nВИМОГИ (дотримуватись):\n${methodRequirements}\n`
      : (info?.requirements ? `\nВимоги: ${info.requirements}\n` : "");
    const commentBlock = comment?.trim() ? `\nКОМЕНТАР ЗАМОВНИКА (виконай обов'язково): ${comment.trim()}\n` : "";
    const sourcesBlock = hasSources
      ? `\nДЖЕРЕЛА (спирайся на факти й дані з них при наповненні слайдів; список джерел додається окремим слайдом автоматично — НЕ вставляй жодних позначок на кшталт [1] чи посилань у тексті слайдів):\n${activeCitations.map((c, i) => `${i + 1}. ${c}`).join("\n")}\n`
      : "";

    const materialImages = materialFiles.filter(f => f.type?.startsWith("image/"));
    const materialImagesBlock = materialImages.length > 0
      ? `\nЗОБРАЖЕННЯ ВІД ЗАМОВНИКА (${materialImages.length} шт., індекси 0–${materialImages.length - 1} за порядком серед завантажених файлів) — якщо якесь із них підходить під слайд image_placeholder/right_type:"image", встав його індекс у полі "image_material_index" замість вигаданого підпису.\n`
      : "";

    try {
      setLoadMsg("Аналізую матеріали та генерую презентацію...");
      const prompt = `Створи презентацію на тему "${info?.topic}". Галузь: ${info?.subject || ""}. Мова: ${lang}.
${reqBlock}${materialContext}${commentBlock}${sourcesBlock}${materialImagesBlock}
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
- "image_placeholder" — весь слайд займає зображення. Поле "image": короткий підпис (запасний варіант, якщо реального зображення немає). Якщо серед зображень замовника є відповідне — замість вигаданого підпису додай "image_material_index": N. Якщо на слайді має бути СХЕМА/ЦИКЛ/ПРОЦЕС/ІЄРАРХІЯ (не фото) — додай поле "diagram" з лаконічним PlantUML-кодом (@startuml ... @enduml, без кольорів)
- "two_column" з right_type:"image" — ліво текст, право зображення. Поля ті самі: "image" (підпис-заглушка), опційно "image_material_index" або "diagram"

ШРИФТ: якщо інструкції вказують конкретний шрифт — додай поле "font":"Назва шрифту" в корінь JSON (поруч з "slides"). Стандартні системні шрифти: Arial, Calibri, Times New Roman, Georgia, Verdana.

ПРАВИЛА:
- Кожен слайд — 1 чітка ідея
- Конкретні дані з матеріалів, не загальні фрази
- Заголовки слайдів — 3–6 слів
- Текст у content — стислі тези, до 7 слів на рядок
- stat_callout тільки якщо є реальні числа з матеріалів
- table — коли потрібно порівняти кілька об'єктів по кількох параметрах
- chart — коли є числові дані для відображення динаміки або розподілу
- image_placeholder або two_column з right_type:"image" — коли за змістом має бути фото, схема, графік, діаграма, малюнок; спочатку шукай відповідне зображення замовника (image_material_index), інакше для схем/циклів/процесів обов'язково додай diagram (PlantUML) — не лишай це просто текстовим підписом
НЕ додавай слайд джерел.
НЕ вставляй у текст слайдів жодних позначок чи посилань на джерела (ні [1], ні (Автор, рік)) — лише факти та дані.
КАТЕГОРИЧНО ЗАБОРОНЕНО додавати будь-яке застереження/дисклеймер про використання штучного інтелекту, ШІ, AI чи подібних інструментів для підготовки презентації — ні окремим слайдом, ні рядком у контенті, ні в приміткax, навіть якщо це здається доречним.`;

      const msgs = [{ role: "user", content: [...fileContext, ...matFileContext, ...instrFileContext, { type: "text", text: prompt }] }];
      const raw = await callClaude(msgs, null, `Ти експерт із презентацій. Відповідай ТІЛЬКИ валідним JSON без markdown. Мова контенту: ${lang}.`, 6000, null, MODEL);
      const parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || raw);
      let newSlides = parsed.slides || [];

      // ── Замінюємо заглушки на реальні зображення: фото замовника за індексом,
      // або схему, згенеровану кодом (PlantUML → PNG через /api/render-diagram) ──
      setLoadMsg("Домальовую схеми...");
      const diagramJobs = [];
      newSlides.forEach(sl => {
        const isImageSlot = sl.layout === "image_placeholder" || (sl.layout === "two_column" && sl.right_type === "image");
        if (!isImageSlot) return;
        const matIdx = sl.image_material_index;
        if (Number.isInteger(matIdx) && materialImages[matIdx]) {
          sl.image = { b64: materialImages[matIdx].b64, type: materialImages[matIdx].type };
          return;
        }
        if (typeof sl.diagram === "string" && sl.diagram.trim()) {
          diagramJobs.push(renderPlantUmlToPng(sl.diagram).then(img => {
            if (img) sl.image = { b64: img.b64, type: "image/png" };
          }));
        }
      });
      if (diagramJobs.length) await Promise.all(diagramJobs);

      // Жовті блоки, куди не підставилось ні фото замовника, ні схема, — фото з інтернету.
      // У слайдах лишається підпис блоку, фото підставляє resolveSlideWebImages перед експортом.
      const imageSlots = findSlideImageSlots(newSlides);
      if (imageSlots.length) {
        setLoadMsg("Шукаю фото для слайдів...");
        await webImg.searchFigs(imageSlots, { lang, topic: info?.topic });
      }

      if (hasSources) {
        newSlides = [...newSlides, {
          layout: "highlight_box",
          title: `${sourcesHeading(lang)} (${citStyle})`,
          content: activeCitations.map((c, i) => `${i + 1}. ${c}`).join("\n"),
        }];
      }

      setSlides(newSlides);
      playDoneSound();
      setStage("done");
      await saveToFirestore({ slides: newSlides, tezyCitations: activeCitations, stage: "done", status: "done" });
    } catch (e) { setError(e.message); }
    setRunning(false); setLoadMsg("");
  };

  const fileLimit = workType === "tezy" ? 10 : 3;
  const handleAddFile = (name, b64, type) => {
    if (files.length >= fileLimit) {
      setFiles(p => [...p.slice(1), { name, b64, type }]);
    } else {
      setFiles(p => [...p, { name, b64, type }]);
    }
  };

  const progress = sections.length
    ? Math.round(sections.filter(s => s.text).length / sections.length * 100)
    : 0;

  if (dbLoading) return (
    <div style={{ minHeight: "100vh", background: "#f5f2eb", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <SpinDot />
    </div>
  );

  const cfg = workType ? WORK_TYPES[workType] : null;

  return (
    <div style={{ minHeight: "100vh", background: "#f5f2eb", fontFamily: "'Spectral',Georgia,serif", color: "#1a1a14" }}>
      <style>{SHARED_STYLES}</style>

      {/* Header */}
      <div style={{ position: "sticky", top: 0, zIndex: 100, background: "#1a1a14", color: "#f5f2eb", padding: "15px 32px", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        {onBack && (
          <button onClick={onBack} style={{ background: "transparent", border: "1px solid #555", color: "#aaa", borderRadius: 6, padding: "5px 14px", cursor: "pointer", fontFamily: "inherit", fontSize: 12, marginRight: 4 }}>
            ← Замовлення
          </button>
        )}
        <div style={{ fontFamily: "'Spectral SC',serif", fontSize: 19, letterSpacing: 5, color: "#e8ff47" }}>ACADEM</div>
        <div style={{ fontFamily: "'Spectral SC',serif", fontSize: 19, letterSpacing: 5 }}>SMALL</div>
        {cfg && <div style={{ fontSize: 12, color: "#888", marginLeft: 4 }}>{cfg.icon} {cfg.label}</div>}
        {(info?.orderNumber || dopOrderNumber.trim()) && <div style={{ fontSize: 11, color: "#888", whiteSpace: "nowrap", flexShrink: 0 }}>#{info?.orderNumber || dopOrderNumber.trim()}</div>}
        {info?.topic && <div style={{ fontSize: 12, color: "#555", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{info.topic}</div>}
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 12 }}>
          <SaveIndicator saving={saving} saved={saved} />
          {workType && <StagePills stage={stage} workType={workType} onNavigate={setStage} maxStageIdx={maxStageIdx} />}
          {cfg && (
            <button
              onClick={() => setMaxStageIdx(cfg.stageKeys.length - 1)}
              style={{ background: "transparent", border: "1px solid #555", color: "#888", fontSize: 10, letterSpacing: 1, padding: "4px 10px", borderRadius: 20, cursor: "pointer" }}>
              🔓 Розблокувати всі кроки
            </button>
          )}
        </div>
      </div>

      <div style={{ maxWidth: 860, margin: "0 auto", padding: "32px clamp(16px, 3vw, 48px)" }}>

        {/* Помилка */}
        {error && (
          <div style={{ background: "#fff0f0", border: "1px solid #ffcccc", borderRadius: 8, padding: "12px 16px", marginBottom: 20, color: "#c00", fontSize: 13, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span>⚠ {error}</span>
            <button onClick={() => setError("")} style={{ background: "none", border: "none", color: "#c00", cursor: "pointer", fontSize: 16 }}>✕</button>
          </div>
        )}

        {/* ── Автоматичний режим: банер прогресу / помилки ── */}
        {(autoRunning || autoError) && (
          <div style={{
            background: autoError ? "#3a1414" : "#14261a",
            border: `1px solid ${autoError ? "#5a2020" : "#2a4a30"}`,
            borderRadius: 8, color: "#f0ece0", padding: "10px 16px", marginBottom: 20,
            display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap",
          }}>
            {autoRunning && !autoError && (
              <>
                <SpinDot />
                <div style={{ fontSize: 13 }}>⚡ Автоматичний режим: {autoStepLabel}</div>
                <button onClick={stopAutoPipeline}
                  style={{ marginLeft: "auto", background: "transparent", border: "1px solid #7a7a5a", color: "#ddd8cc", borderRadius: 6, padding: "5px 14px", fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>
                  ⏹ Зупинити
                </button>
              </>
            )}
            {autoError && (
              <>
                <div style={{ fontSize: 13, lineHeight: 1.5 }}>
                  <b>⚠ Автоматичний режим зупинено</b> на кроці «{autoError.step}»: {autoError.message}
                </div>
                <button onClick={() => setAutoError(null)}
                  style={{ marginLeft: "auto", background: "transparent", border: "1px solid #7a7a5a", color: "#ddd8cc", borderRadius: 6, padding: "5px 14px", fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>
                  Зрозуміло
                </button>
              </>
            )}
          </div>
        )}

        {/* ══ ВИБІР ТИПУ ══ */}
        {!workType && <WorkTypeSelector onSelect={t => { setWorkType(t); setStage("input"); }} />}

        {/* ══ КРОК 1: ДАНІ ══ */}
        {workType && stage === "input" && (
          <div className="fade">
            <Heading>{cfg.icon} {cfg.label} — Дані замовлення</Heading>

            {/* ── Тип "Доповідь та презентація" — спрощена форма ── */}
            {workType === "dopovid" && (
              <>
                <FieldBox label="Тема роботи *">
                  <textarea value={tplText} onChange={e => setTplText(e.target.value)}
                    placeholder={"Тема - ...\nДисципліна - ...\nТип роботи - (курсова, реферат, диплом...)\nАвтор - ...\nНауковий керівник - ..."}
                    style={{ ...TA, minHeight: 120 }} />
                </FieldBox>
<FieldBox label="Готова робота * (PDF, DOCX, PPTX, зображення)">
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {presFile && (
                      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", background: "#eef5e4", borderRadius: 6, fontSize: 13 }}>
                        <span>📄 {presFile.name}</span>
                        <button onClick={() => setPresFile(null)} style={{ marginLeft: "auto", background: "none", border: "none", color: "#888", cursor: "pointer", fontSize: 14 }}>✕</button>
                      </div>
                    )}
                    {!presFile && (
                      <DropZone fileLabel={null} onFile={(name, b64, type) => setPresFile({ name, b64, type })} accept=".pdf,.docx,.doc,.pptx,.jpg,.jpeg,.png" />
                    )}
                  </div>
                </FieldBox>
                <FieldBox label="Коментар (необов'язково)">
                  <textarea value={presComment} onChange={e => setPresComment(e.target.value)}
                    placeholder="Вимоги до оформлення, стиль, що врахувати при генерації..."
                    style={{ ...TA, minHeight: 70 }} />
                </FieldBox>
              </>
            )}

            {/* ── Інші типи робіт — стандартна форма ── */}
            {workType !== "dopovid" && (
            <><FieldBox label="Шаблон замовлення *">
              <textarea value={tplText} onChange={e => setTplText(e.target.value)}
                placeholder={workType === "prezentatsiya"
                  ? `Тема - ...\nК-сть слайдів - ...\nДедлайн - ...\nДисципліна - ...\nВимоги - ...`
                  : `Тема - ...\nСторінок - ...\nДедлайн - ...\nВимоги - ...`}
                style={{ ...TA, minHeight: 160 }} />
            </FieldBox>

            {workType === "referat" && (
              <FieldBox label="Готовий план від клієнта (необов'язково)">
                <textarea value={clientPlan} onChange={e => setClientPlan(e.target.value)}
                  placeholder={"Розділ 1. Назва\nРозділ 2. Назва\n..."}
                  style={{ ...TA, minHeight: 80 }} />
              </FieldBox>
            )}

            {workType !== "tezy" && workType !== "prezentatsiya" && (
              <FieldBox label="Коментар">
                <textarea value={comment} onChange={e => setComment(e.target.value)}
                  placeholder="Додаткові вимоги..." style={{ ...TA, minHeight: 70 }} />
              </FieldBox>
            )}

            {workType !== "prezentatsiya" && (
              <FieldBox label={
                workType === "tezy"
                  ? "Методичка / вимоги конференції (необов'язково)"
                  : ["stattia", "ese", "referat"].includes(workType)
                  ? "Методичка (необов'язково)"
                  : "Рекомендації / методичка / скріни (до 3 файлів) — необов'язково"
              }>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {files.map((f, i) => (
                    <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", background: "#eef5e4", borderRadius: 6, fontSize: 13 }}>
                      <span>📄 {f.name}</span>
                      <button onClick={() => setFiles(p => p.filter((_, j) => j !== i))} style={{ marginLeft: "auto", background: "none", border: "none", color: "#888", cursor: "pointer", fontSize: 14 }}>✕</button>
                    </div>
                  ))}
                  {files.length < fileLimit && (
                    <DropZone fileLabel={null} multiple onFile={handleAddFile} accept=".pdf,.docx,.jpg,.jpeg,.png" />
                  )}
                </div>
              </FieldBox>
            )}

            {(workType === "referat" || workType === "tezy") && (
              <FieldBox label="Додаткові рекомендації кафедри (необов'язково)" tooltip="Якщо крім методички є ще вказівки викладача/кафедри (напр. скріншоти посту в Telegram) — вставте текст або завантажте фото, програма врахує їх при написанні плану та тексту">
                <DeptGuidanceZone
                  value={deptGuidanceText}
                  onChange={text => { setDeptGuidanceText(text); saveToFirestore({ deptGuidanceText: text }); }}
                />
              </FieldBox>
            )}

            {workType === "referat" && (
              <FieldBox label="Зразок структури реферату (необов'язково)" tooltip="Приклад готового реферату — план розділів згенерується за його реальною структурою. Приймається .docx та .pdf; якщо файл .doc — спершу збережіть його як .pdf.">
                <ExampleFileZone
                  fileName={structureExampleName}
                  hint="Перетягніть або клікніть — .docx, .pdf (.doc спершу збережіть як .pdf)"
                  onExtracted={(name, text) => {
                    setStructureExampleName(name); setStructureExampleText(text);
                    saveToFirestore({ structureExampleName: name, structureExampleText: text });
                  }}
                />
              </FieldBox>
            )}

            {/* Матеріал для роботи — для тез, статті, есе, реферату, презентації */}
            {["tezy", "stattia", "ese", "referat", "prezentatsiya"].includes(workType) && (
              <FieldBox label={workType === "prezentatsiya" ? "Текст і файл для аналізу — основа змісту слайдів (необов'язково)" : `Матеріал для роботи — текст або файли/фото до ${["stattia", "ese", "referat"].includes(workType) ? 8 : 6} (необов'язково)`}>
                <textarea
                  value={materialText}
                  onChange={e => setMaterialText(e.target.value)}
                  placeholder={workType === "prezentatsiya"
                    ? "Вставте текст статті, конспект лекцій або нотатки — ШІ проаналізує і наповнить слайди конкретним змістом..."
                    : "Вставте текст, конспект або будь-який матеріал що має лягти в основу роботи..."}
                  style={{ ...TA, minHeight: 100 }}
                />
                <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}>
                  {materialFiles.map((f, i) => (
                    <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 12px", background: "#eef5e4", borderRadius: 6, fontSize: 13 }}>
                      <span>{f.type.startsWith("image/") ? "🖼" : "📄"} {f.name}</span>
                      <button onClick={() => setMaterialFiles(p => p.filter((_, j) => j !== i))} style={{ marginLeft: "auto", background: "none", border: "none", color: "#888", cursor: "pointer", fontSize: 14 }}>✕</button>
                    </div>
                  ))}
                  {materialFiles.length < (["stattia", "ese", "referat"].includes(workType) ? 8 : workType === "prezentatsiya" ? 20 : 6) && (
                    <DropZone fileLabel={null} multiple onFile={(name, b64, type) => { const lim = ["stattia", "ese", "referat"].includes(workType) ? 8 : workType === "prezentatsiya" ? 20 : 6; setMaterialFiles(p => p.length >= lim ? [...p.slice(1), { name, b64, type }] : [...p, { name, b64, type }]); }} accept=".pdf,.docx,.jpg,.jpeg,.png" />
                  )}
                </div>
                {(materialText.trim() || materialFiles.length > 0) && (
                  <div style={{ fontSize: 11, color: "#5a8a2a", marginTop: 6 }}>
                    ✓ {[materialText.trim() ? `${materialText.trim().split(/\s+/).length} сл.` : null, materialFiles.length ? `${materialFiles.length} файл(и)` : null].filter(Boolean).join(" + ")} — буде передано ШІ
                  </div>
                )}

                {workType === "prezentatsiya" && (
                  <>
                    <div style={{ borderTop: "1px dashed #d4cfc4", margin: "14px 0 10px" }} />
                    <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.08em", color: "#888", marginBottom: 8 }}>
                      ІНСТРУКЦІЇ З ОФОРМЛЕННЯ (необов'язково)
                    </div>
                    <div style={{ fontSize: 12, color: "#999", marginBottom: 8 }}>
                      Скріни, PDF, DOCX або фото з вимогами до структури — ШІ прочитає і виконає
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      {instrFiles.map((f, i) => (
                        <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 12px", background: "#f0eee8", borderRadius: 6, fontSize: 13 }}>
                          <span>{f.type.startsWith("image/") ? "🖼" : "📄"} {f.name}</span>
                          <button onClick={() => setInstrFiles(p => p.filter((_, j) => j !== i))} style={{ marginLeft: "auto", background: "none", border: "none", color: "#888", cursor: "pointer", fontSize: 14 }}>✕</button>
                        </div>
                      ))}
                      {instrFiles.length < 20 && (
                        <DropZone fileLabel={null} multiple onFile={(name, b64, type) => setInstrFiles(p => p.length >= 20 ? [...p.slice(1), { name, b64, type }] : [...p, { name, b64, type }])} accept=".pdf,.docx,.jpg,.jpeg,.png,.webp" />
                      )}
                    </div>
                    {instrFiles.length > 0 && (
                      <div style={{ fontSize: 11, color: "#5a8a2a", marginTop: 6 }}>
                        ✓ {instrFiles.length} файл(и) з інструкціями — буде передано ШІ
                      </div>
                    )}
                  </>
                )}
              </FieldBox>
            )}

            {/* Блок даних автора — для тез і статті (стаття потребує УДК/автора/анотації) */}
            {["tezy", "stattia"].includes(workType) && (
              <div style={{ border: "1.5px solid #d4cfc4", borderRadius: 8, overflow: "hidden", marginBottom: 8 }}>
                <button onClick={() => setAuthorDataOpen(o => !o)}
                  style={{ width: "100%", display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 16px", background: "#f5f2eb", border: "none", cursor: "pointer", fontFamily: "inherit", fontSize: 13, color: "#555" }}>
                  <span>Дані автора <span style={{ color: "#aaa", fontStyle: "italic" }}>(необов'язково — якщо є у шаблоні, ШІ витягне сам)</span></span>
                  <span style={{ fontSize: 11 }}>{authorDataOpen ? "▲" : "▼"}</span>
                </button>
                {authorDataOpen && (
                  <div style={{ padding: "16px", display: "flex", flexDirection: "column", gap: 10, background: "#faf8f3" }}>
                    <div>
                      <div style={{ fontSize: 11, color: "#888", marginBottom: 4 }}>Вставте текст (як у методичці) — розпізнається автоматично</div>
                      <textarea value={authorRawText} onChange={e => setAuthorRawText(e.target.value)}
                        placeholder={"Іваненко І. І., 2 курс (ОС «магістр»)...\nНауковий керівник: проф. Петренко П.П.\nКиївський національний університет..."}
                        style={{ width: "100%", minHeight: 60, padding: "8px 10px", border: "1px solid #d4cfc4", borderRadius: 6, fontFamily: "inherit", fontSize: 13, background: "#fff", boxSizing: "border-box", resize: "vertical" }} />
                      <button onClick={doRecognizeAuthorData} disabled={authorRecognizing || !authorRawText.trim()}
                        style={{ marginTop: 6, fontSize: 12, padding: "6px 14px", borderRadius: 6, border: "1.5px solid #1a1a14", background: authorRecognizing ? "#aaa" : "#1a1a14", color: "#e8ff47", cursor: authorRecognizing || !authorRawText.trim() ? "default" : "pointer", fontFamily: "inherit", display: "inline-flex", alignItems: "center", gap: 6 }}>
                        {authorRecognizing ? <><SpinDot light />Розпізнаю...</> : "🪄 Розпізнати"}
                      </button>
                    </div>
                    <div style={{ borderTop: "1px solid #e0dcd0", paddingTop: 10, fontSize: 11, color: "#aaa" }}>або заповніть вручну:</div>
                    {[
                      { key: "authorName", label: "ПІБ автора", placeholder: "Іваненко Іван Іванович" },
                      { key: "role", label: "Курс / посада", placeholder: "студент 3 курсу / аспірант / доцент" },
                      { key: "supervisor", label: "Науковий керівник", placeholder: "проф. Петренко П.П." },
                      { key: "university", label: "Університет", placeholder: "Київський національний університет..." },
                      { key: "faculty", label: "Факультет / кафедра", placeholder: "Факультет..." },
                    ].map(({ key, label, placeholder }) => (
                      <div key={key}>
                        <div style={{ fontSize: 11, color: "#888", marginBottom: 4 }}>{label}</div>
                        <input value={authorData[key]} onChange={e => setAuthorData(d => ({ ...d, [key]: e.target.value }))}
                          placeholder={placeholder}
                          style={{ width: "100%", padding: "8px 10px", border: "1px solid #d4cfc4", borderRadius: 6, fontFamily: "inherit", fontSize: 13, background: "#fff", boxSizing: "border-box" }} />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <PrimaryBtn
                onClick={doAnalyze}
                disabled={!tplText.trim() || autoRunning}
                loading={running}
                msg={loadMsg}
                label="Аналізувати →"
              />
              {isAdmin && workType === "referat" && (
                <button onClick={runAutoPipelineReferat} disabled={!tplText.trim() || running || autoRunning}
                  title="Аналіз → План → Джерела → Написання без ручних кроків"
                  style={{
                    background: "transparent", border: "1px solid #8a1a8a", color: "#8a1a8a", borderRadius: 8,
                    padding: "11px 22px", fontSize: 13, cursor: (!tplText.trim() || running || autoRunning) ? "default" : "pointer",
                    fontFamily: "inherit", opacity: (!tplText.trim() || running || autoRunning) ? 0.5 : 1,
                  }}>
                  ⚡ Автоматично
                </button>
              )}
            </div>
            </>
            )}

            {/* Кнопка для dopovid */}
            {workType === "dopovid" && (
              <PrimaryBtn
                onClick={() => {
                  if (!tplText.trim()) { alert("Введіть тему роботи."); return; }
                  const lines = tplText.split("\n").map(l => l.trim()).filter(Boolean);
                  const topicLine = lines.find(l => /тема\s*[-–:]/i.test(l));
                  const SKIP = [/^[№#]\s*замовл/i, /^статус/i, /^дедлайн/i, /^менеджер/i, /^uid/i, /^date-/i, /^\d{4,}$/];
                  const topic = topicLine
                    ? topicLine.replace(/^.*тема\s*[-–:]\s*/i, "").trim()
                    : (lines.find(l => !SKIP.some(p => p.test(l)) && l.length > 8) || lines[0] || "").trim();
                  const extractedNum = lines.find(l => /^[№#]\s*замовл/i.test(l))?.match(/\d{3,}/)?.[0] || "";
                  const finalOrderNum = dopOrderNumber.trim() || extractedNum;
                  if (finalOrderNum && !dopOrderNumber.trim()) setDopOrderNumber(finalOrderNum);
                  const dopInfo = { topic, type: "Доповідь та презентація", ...(finalOrderNum && { orderNumber: finalOrderNum }) };
                  setInfo(dopInfo);
                  saveToFirestore({ tplText, presComment, info: dopInfo, stage: "done", status: "done" });
                  setStage("done");
                }}
                disabled={!tplText.trim()}
                label="Далі →"
              />
            )}
          </div>
        )}

        {/* ══ ПЛАН (тільки реферат) ══ */}
        {workType === "referat" && stage === "plan" && (
          <div className="fade">
            <Heading>📋 План реферату</Heading>

            {sections.length === 0 ? (
              <>
                <p style={{ fontSize: 13, color: "#888", marginBottom: 8 }}>
                  {clientPlan?.trim()
                    ? "Знайдено готовий план від клієнта — розберу його структуру."
                    : files.length > 0
                      ? "Є методичка — витягну структуру з неї."
                      : "Згенерую стандартний план за темою та кількістю сторінок."}
                </p>
                <p style={{ fontSize: 12, color: "#aaa", marginBottom: 20 }}>Стандарт: Вступ 1 стор. → Розділ 1 → Розділ 2 → Розділ 3 → Висновки 1 стор. → Список джерел</p>
                <PrimaryBtn onClick={() => doGenPlan()} loading={running} msg={loadMsg} label="Згенерувати план →" />
              </>
            ) : (
              <>
                <p style={{ fontSize: 13, color: "#888", marginBottom: 16 }}>Перевірте та відредагуйте план. Після підтвердження — збір джерел.</p>
                <div style={{ fontSize: 12, color: "#888", marginBottom: 10, padding: "8px 12px", background: "#f0ece2", borderRadius: 6, lineHeight: "1.6" }}>
                  ✏️ Редагуй назви та сторінки прямо в таблиці. Кнопка <strong>+</strong> на розділі — розбити його на підрозділи (або додати ще один підрозділ), <strong>✕</strong> — видалити.
                </div>
                <div style={{ border: "1.5px solid #d4cfc4", borderRadius: 8, overflow: "hidden", marginBottom: 20 }}>
                  {(() => {
                    let lastTitle = null;
                    let rowNum = 0;
                    const mainRows = sections.filter(s => !["intro", "conclusions", "sources"].includes(s.id));
                    const blocks = getReferatBlocks(mainRows);
                    const rows = [];
                    sections.forEach(s => {
                      const isSpecial = ["intro", "conclusions", "sources"].includes(s.id);
                      const isSub = !isSpecial && !!s.sectionTitle;
                      if (isSub && s.sectionTitle !== lastTitle) {
                        lastTitle = s.sectionTitle;
                        rows.push(
                          <div key={`hdr-${s.sectionTitle}`} style={{ padding: "7px 16px", background: "#ddd8c8", fontSize: 12, fontWeight: "bold", color: "#1a1a14", letterSpacing: "0.5px", textTransform: "uppercase", borderBottom: "1px solid #e4dfd4" }}>
                            {s.sectionTitle}
                          </div>
                        );
                      }
                      if (!isSub) lastTitle = null;
                      rowNum++;
                      const isPlaceholder = !isSpecial && (/\[|новий/i.test(s.label) || (s.sectionTitle && /\[/.test(s.sectionTitle)));
                      const block = !isSpecial ? blocks.find(b => b.some(r => r.id === s.id)) : null;
                      const rowIdxInBlock = block ? block.findIndex(r => r.id === s.id) : -1;
                      const blockIdx = block ? blocks.indexOf(block) : -1;
                      const canUp = !isSpecial && (block.length > 1 ? rowIdxInBlock > 0 : blockIdx > 0);
                      const canDown = !isSpecial && (block.length > 1 ? rowIdxInBlock < block.length - 1 : blockIdx < blocks.length - 1);
                      rows.push(
                        <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 16px", paddingLeft: isSub ? 30 : 16, borderBottom: "1px solid #e4dfd4", background: isSpecial ? "#ede9e0" : rowNum % 2 === 0 ? "#f5f2eb" : "#faf8f3" }}>
                          <span style={{ fontSize: 11, color: "#bbb", width: 20, flexShrink: 0 }}>{rowNum}</span>
                          <input value={s.label} onChange={e => { const val = e.target.value; setSections(p => p.map(x => x.id === s.id ? { ...x, label: val } : x)); }}
                            style={{ flex: 1, background: "transparent", border: "none", fontSize: 13, fontFamily: "'Spectral',serif", color: isSpecial ? "#888" : "#1a1a14", fontStyle: isSpecial ? "italic" : "normal", minWidth: 0 }} />
                          {isPlaceholder && (
                            <button onClick={() => doNameReferatPlaceholders(s.id)} disabled={singleNamingId === s.id} title="Згенерувати назву"
                              style={{ background: "transparent", border: "none", fontSize: 14, cursor: singleNamingId === s.id ? "wait" : "pointer", padding: "2px 4px", color: singleNamingId === s.id ? "#ccc" : "#b8a020", flexShrink: 0 }}
                            >{singleNamingId === s.id ? "…" : "✨"}</button>
                          )}
                          {s.id !== "sources" ? (
                            <div style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
                              <input
                                type="number" min="0.5" max="30" step="0.5"
                                value={s.pages ?? 1}
                                onChange={e => { const v = parseFloat(e.target.value) || 1; setSections(p => p.map(x => x.id === s.id ? { ...x, pages: v } : x)); }}
                                style={{ width: 42, textAlign: "center", padding: "2px 4px", border: "1px solid #d4cfc4", borderRadius: 4, fontSize: 12, fontFamily: "'Spectral',serif", background: "#fff", color: "#555" }}
                              />
                              <span style={{ fontSize: 11, color: "#aaa" }}>стор.</span>
                            </div>
                          ) : (
                            <span style={{ fontSize: 11, color: "#aaa", whiteSpace: "nowrap", flexShrink: 0 }}>авто</span>
                          )}
                          {!isSpecial ? (
                            <>
                              <div style={{ display: "flex", gap: 2, flexShrink: 0 }}>
                                <button onClick={() => moveReferatRowUp(s.id)} disabled={!canUp} title="Вгору"
                                  style={{ background: "transparent", border: "none", fontSize: 12, cursor: canUp ? "pointer" : "default", color: canUp ? "#555" : "#ddd", padding: "1px 4px", lineHeight: 1 }}>↑</button>
                                <button onClick={() => moveReferatRowDown(s.id)} disabled={!canDown} title="Вниз"
                                  style={{ background: "transparent", border: "none", fontSize: 12, cursor: canDown ? "pointer" : "default", color: canDown ? "#555" : "#ddd", padding: "1px 4px", lineHeight: 1 }}>↓</button>
                              </div>
                              <button onClick={() => addReferatSubsection(s.id)} title="Додати підрозділ"
                                style={{ background: "transparent", border: "1px dashed #8ab060", color: "#6a9030", fontSize: 12, cursor: "pointer", padding: "1px 6px", borderRadius: 4, flexShrink: 0 }}>+</button>
                              <button onClick={() => deleteReferatRow(s.id)}
                                style={{ background: "none", border: "none", color: "#ccc", cursor: "pointer", fontSize: 14, flexShrink: 0 }}
                                onMouseEnter={e => e.currentTarget.style.color = "#c00"}
                                onMouseLeave={e => e.currentTarget.style.color = "#ccc"}>✕</button>
                            </>
                          ) : (
                            <span style={{ width: 88, flexShrink: 0 }} />
                          )}
                        </div>
                      );
                    });
                    return rows;
                  })()}
                  <div style={{ padding: "10px 14px", background: "#f5f2eb", display: "flex", gap: 8, alignItems: "center" }}>
                    <button onClick={addReferatChapter} style={{ background: "transparent", border: "1.5px dashed #8ab060", color: "#6a9030", borderRadius: 6, padding: "7px 20px", fontFamily: "'Spectral',serif", fontSize: 12, cursor: "pointer", flex: 1, letterSpacing: "1px" }}
                      onMouseEnter={e => { e.currentTarget.style.borderColor = "#3a6010"; e.currentTarget.style.color = "#3a6010"; }}
                      onMouseLeave={e => { e.currentTarget.style.borderColor = "#8ab060"; e.currentTarget.style.color = "#6a9030"; }}>
                      + Розділ
                    </button>
                    <button onClick={recalcReferatPages} style={{ background: "transparent", border: "1.5px dashed #a0a0a0", color: "#888", borderRadius: 6, padding: "7px 14px", fontFamily: "'Spectral',serif", fontSize: 11, cursor: "pointer", letterSpacing: "0.5px", whiteSpace: "nowrap" }}
                      onMouseEnter={e => { e.currentTarget.style.borderColor = "#555"; e.currentTarget.style.color = "#555"; }}
                      onMouseLeave={e => { e.currentTarget.style.borderColor = "#a0a0a0"; e.currentTarget.style.color = "#888"; }}>
                      ⟳ стор.
                    </button>
                  </div>
                </div>

                {sections.some(s => !["intro", "conclusions", "sources"].includes(s.id) && (/\[|новий/i.test(s.label) || (s.sectionTitle && /\[/.test(s.sectionTitle)))) && (
                  <div style={{ marginBottom: 14 }}>
                    <GreenBtn onClick={() => doNameReferatPlaceholders(null)} loading={namingLoading} msg="Генерую назви..." label="✨ Придумати назви для заглушок" />
                  </div>
                )}

                <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                  <NavBtn onClick={() => setSections([])}>Перегенерувати</NavBtn>
                  <PrimaryBtn onClick={() => { setStage("sources"); saveToFirestore({ sections, stage: "sources" }); }} label="До джерел →" />
                </div>
              </>
            )}
          </div>
        )}

        {/* ══ ГЕНЕРАЦІЯ (реферат — секції) ══ */}
        {workType === "referat" && stage === "writing" && (
          <div className="fade">
            <Heading>✍️ Генерація тексту</Heading>
            <div style={{ marginBottom: 20 }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6, fontSize: 12, color: "#888" }}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
                  {running && <SpinDot />}{running ? loadMsg : `${sections.filter(s => s.text).length} / ${sections.length} секцій готово`}
                </span>
                <span style={{ fontWeight: 600, color: "#1a1a14" }}>{progress}%</span>
              </div>
              <div style={{ height: 3, background: "#d4cfc4", borderRadius: 2 }}>
                <div style={{ height: "100%", width: progress + "%", background: "#1a1a14", borderRadius: 2, transition: "width .6s ease" }} />
              </div>
            </div>

            {sections.map((sec, i) => (
              <div key={sec.id} style={{ border: `1.5px solid ${sec.text ? "#aaa49a" : "#ddd9d0"}`, borderRadius: 8, marginBottom: 10, overflow: "hidden" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 16px", background: sec.text ? "#1a1a14" : "#f0ece2" }}>
                  <div style={{ width: 8, height: 8, borderRadius: "50%", background: sec.text ? "#e8ff47" : running && genIdx === i ? "#555" : "#ccc" }} />
                  <div style={{ flex: 1, fontSize: 13, fontWeight: 600, color: sec.text ? "#f5f2eb" : "#1a1a14" }}>{sec.label}</div>
                  {sec.text && <button onClick={() => navigator.clipboard.writeText(sec.text)} style={{ background: "transparent", border: "1px solid #555", color: "#999", borderRadius: 5, padding: "3px 10px", fontSize: 10, cursor: "pointer" }}>COPY</button>}
                </div>
                {sec.text && <div style={{ padding: "14px 18px", fontSize: 13, lineHeight: "1.85", color: "#2a2a1e", whiteSpace: "pre-wrap", maxHeight: 240, overflowY: "auto", background: "#faf8f3" }}>{sec.text}</div>}
                {running && genIdx === i && !sec.text && <div style={{ padding: "12px 18px", fontSize: 13, color: "#888", display: "flex", alignItems: "center", gap: 8, background: "#faf8f3" }}><SpinDot />Генерується...</div>}
              </div>
            ))}
          </div>
        )}

        {/* ══ ДЖЕРЕЛА ══ */}
        {["tezy", "stattia", "ese", "referat", "prezentatsiya"].includes(workType) && stage === "sources" && (() => {
          const isReferat = workType === "referat";
          const tableMinSrc = getSmallWorkSourcesMin();
          const minSrc = workType === "prezentatsiya"
            ? (info?.sourceCount || 5)
            : (info?.sourceCount || tableMinSrc || parsePagesAvg(info?.pages || "3"));
          // Жорсткий гейт (як у курсовій): для tezy/stattia/ese — лише коли є
          // табличний мінімум (поза діапазоном таблиці — стара м'яка поведінка).
          const hardGateActive = ["tezy", "stattia", "ese"].includes(workType) && !!tableMinSrc;
          const citLines = citText.split("\n").map(s => s.trim()).filter(Boolean);
          const allRefCitations = isReferat
            ? [...new Set(sections.filter(s => s.id !== "sources").flatMap(s =>
                (citInputs[s.id] || "").split("\n").map(l => l.trim()).filter(Boolean)
              ))]
            : citLines;
          const totalCitCount = isReferat ? allRefCitations.length : citLines.length;

          // ── РЕФЕРАТ: per-section cards (тільки розділи/підрозділи — без вступу і висновків) ──
          if (isReferat) {
            const refSections = sections.filter(s => !["sources", "intro", "conclusions"].includes(s.id));
            const perSec = Math.ceil(minSrc / Math.max(refSections.length, 1));
            let runIdx = 0;
            const _smDefaultStyle = methodInfo?.sourcesStyle || (info?.citStyle) || "ДСТУ 8302:2015";
            const _smEffStyle = citStyleOverride || _smDefaultStyle;
            const _smEffOrder = sourcesOrderOverride || methodInfo?.sourcesOrder || (info?.sortAlpha ? "alphabetical" : "appearance");
            return (
              <div className="fade">
                <Heading>📚 Джерела</Heading>
                {/* ── Налаштування оформлення ── */}
                <SmCitSettings
                  effectiveCitStyle={_smEffStyle} effectiveSourcesOrder={_smEffOrder}
                  citStyleOverride={citStyleOverride} sourcesOrderOverride={sourcesOrderOverride}
                  onCitStyleChange={(s) => { setCitStyleOverride(s); saveToFirestore({ citStyleOverride: s }); }}
                  onSourcesOrderChange={(o) => { setSourcesOrderOverride(o); saveToFirestore({ sourcesOrderOverride: o }); }}
                  citFootnotes={citFootnotes}
                  onCitFootnotesChange={(v) => { setCitFootnotes(v); saveToFirestore({ citFootnotes: v }); }}
                  pageByContent={pageByContent}
                  onPageByContentChange={(v) => { setPageByContent(v); saveToFirestore({ pageByContent: v }); }}
                />
                {/* ── Масовий пошук джерел для всіх розділів і підрозділів ── */}
                <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 16 }}>
                  <GreenBtn onClick={() => doSearchAllSections()} disabled={allSecLoading} loading={allSecLoading}
                    msg={`Шукаю... (${allSecProgress.done}/${allSecProgress.total})`}
                    label="🔍 Згенерувати джерела для всіх розділів" />
                  <a href={`https://scholar.google.com/scholar?hl=uk&as_sdt=0%2C5&as_ylo=2021&q=${encodeURIComponent(info?.topic || "")}&btnG=`}
                    target="_blank" rel="noopener noreferrer"
                    style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, color: "#1a5a8a", textDecoration: "none", background: "#e4f0ff", padding: "9px 16px", borderRadius: 7, border: "1px solid #b0d0f0" }}>
                    🎓 Шукати на Google Scholar →
                  </a>
                </div>
                {refSections.map(sec => {
                  const secLines = (citInputs[sec.id] || "").split("\n").map(l => l.trim()).filter(Boolean);
                  const startIdx = runIdx + 1; runIdx += secLines.length;
                  const hasSources = secLines.length > 0;
                  const papers = refSecPapers[sec.id] || [];
                  const phrases = refSecPhrases[sec.id] || [];
                  const isLoadingSec = refSecLoading[sec.id] || false;
                  const isSearched = refSecPapers[sec.id] !== undefined;
                  const scholarQuery = phrases[0] || `${sec.label} ${info?.topic || ""}`;
                  const scholarUrl = `https://scholar.google.com/scholar?hl=uk&as_sdt=0%2C5&as_ylo=2021&q=${encodeURIComponent(scholarQuery)}&btnG=`;
                  return (
                    <div key={sec.id} style={{ border: `1.5px solid ${hasSources ? "#d4cfc4" : "#e8a050"}`, borderRadius: 8, overflow: "hidden", marginBottom: 14 }}>
                      <div style={{ background: "#1a1a14", padding: "11px 18px", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <span style={{ width: 8, height: 8, borderRadius: "50%", background: hasSources ? "#5ad060" : "#e8a050", flexShrink: 0, display: "inline-block" }} />
                          <span style={{ fontSize: 13, fontWeight: 600, color: "#f5f2eb" }}>{sec.label}</span>
                        </div>
                        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                          {secLines.length > 0 && <div style={{ fontSize: 11, color: "#888" }}>джерела [{startIdx}–{startIdx + secLines.length - 1}]</div>}
                          <div style={{ fontSize: 12, color: "#e8ff47", background: "#2a2a1a", padding: "2px 10px", borderRadius: 10 }}>потрібно: {perSec} дж.</div>
                        </div>
                      </div>
                      <div style={{ padding: "12px 16px", background: "#faf8f3" }}>
                        {(isSearched || isLoadingSec) && (
                          <>
                            <div style={{ background: "#eef5e4", padding: "8px 14px", display: "flex", alignItems: "center", justifyContent: "space-between", borderRadius: 6, marginBottom: 10 }}>
                              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                {isLoadingSec || running
                                  ? <><SpinDot size={12} /><span style={{ fontSize: 12, color: "#5a8a2a" }}>{running ? loadMsg || "Оформлюю джерела..." : "Шукаю джерела..."}</span></>
                                  : <span style={{ fontSize: 12, fontWeight: 600, color: "#3a6010" }}>✓ Знайдено й додано {papers.length} джерел</span>
                                }
                              </div>
                              {!isLoadingSec && !running && (
                                <button onClick={() => doSearchForSection(sec.id, sec.label)}
                                  style={{ fontSize: 10, background: "transparent", border: "1px solid #8cc84b", color: "#3a6010", borderRadius: 5, padding: "2px 8px", cursor: "pointer" }}>
                                  оновити
                                </button>
                              )}
                            </div>
                            {phrases.length > 0 && (
                              <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 10, alignItems: "center" }}>
                                {phrases.map((ph, i) => (
                                  <span key={i} onClick={() => navigator.clipboard.writeText(ph)} title="Клікни щоб скопіювати"
                                    style={{ fontSize: 11, background: "#eef5e4", color: "#3a6010", padding: "2px 9px", borderRadius: 10, border: "1px solid #c8dfa0", cursor: "pointer", userSelect: "none", display: "inline-flex", alignItems: "center", gap: 4 }}>
                                    🔍 {ph}
                                  </span>
                                ))}
                              </div>
                            )}
                          </>
                        )}
                        <div style={{ marginTop: 8 }}>
                          <div style={{ fontSize: 11, color: "#888", letterSpacing: "1px", textTransform: "uppercase", marginBottom: 5, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                            <span>або додайте джерела вручну (кожне з нового рядка):</span>
                            {(citInputs[sec.id] || "").trim() && (
                              <button onClick={() => setCitInputs(prev => ({ ...prev, [sec.id]: "" }))}
                                style={{ fontSize: 11, background: "transparent", border: "1px solid #e0b0b0", color: "#a04040", borderRadius: 5, padding: "2px 8px", cursor: "pointer" }}>
                                × Очистити
                              </button>
                            )}
                          </div>
                          <textarea data-secid={sec.id} value={citInputs[sec.id] || ""}
                            onChange={e => setCitInputs(prev => ({ ...prev, [sec.id]: e.target.value }))}
                            onBlur={() => saveToFirestore({ citInputs })}
                            placeholder="Петренко В.І. Психологія навчання. Київ: Наука, 2020. 245 с."
                            style={{ ...TA, width: "100%", minHeight: 80, resize: "vertical", boxSizing: "border-box", fontSize: 12, lineHeight: "1.7", fontFamily: "'Spectral',serif" }} />
                          {secLines.length > 0 && (
                            <div style={{ fontSize: 11, color: "#3a6010", marginTop: 4 }}>
                              ✓ {secLines.length} джерело(а) введено → [{startIdx}–{startIdx + secLines.length - 1}]
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
                <div style={{ background: "#f0f8e8", border: "1px solid #c8dfa0", borderRadius: 8, padding: "12px 16px", marginBottom: 16, fontSize: 13, color: "#3a6010" }}>
                  <b>Загальна к-сть джерел: {totalCitCount}</b>
                  {" · "}
                  <span style={{ color: totalCitCount >= minSrc ? "#3a6010" : "#c07000" }}>
                    Мінімум: {minSrc} {totalCitCount < minSrc ? `(ще ${minSrc - totalCitCount})` : "✓"}
                  </span>
                </div>
                <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                  <NavBtn disabled={running} onClick={() => { setCitInputs({}); saveToFirestore({ citInputs: {}, stage: "writing", status: "new" }); resetGenerationCost(); setStage("writing"); }}>
                    Пропустити без джерел →
                  </NavBtn>
                  <PrimaryBtn onClick={() => doGenerateFromCitInputs()} disabled={totalCitCount === 0} loading={running} msg={loadMsg}
                    label={`Генерувати (${totalCitCount} джерел) →`} />
                </div>
              </div>
            );
          }

          // ── ТЕЗИ / СТАТТЯ / ЕСЕ: існуючий UI ──
          const scholaUrl = `https://scholar.google.com/scholar?hl=uk&as_sdt=0%2C5&as_ylo=2021&q=${encodeURIComponent(info?.topic || "")}&btnG=`;
          const _smDefaultStyle2 = methodInfo?.sourcesStyle || info?.citStyle || "ДСТУ 8302:2015";
          const _smEffStyle2 = citStyleOverride || _smDefaultStyle2;
          const _smEffOrder2b = sourcesOrderOverride || methodInfo?.sourcesOrder || (info?.sortAlpha ? "alphabetical" : "appearance");
          return (
            <div className="fade">
              <Heading>📚 Джерела</Heading>
              {/* ── Налаштування оформлення ── */}
              <SmCitSettings
                effectiveCitStyle={_smEffStyle2} effectiveSourcesOrder={_smEffOrder2b}
                citStyleOverride={citStyleOverride} sourcesOrderOverride={sourcesOrderOverride}
                onCitStyleChange={(s) => { setCitStyleOverride(s); saveToFirestore({ citStyleOverride: s }); }}
                onSourcesOrderChange={(o) => { setSourcesOrderOverride(o); saveToFirestore({ sourcesOrderOverride: o }); }}
                citFootnotes={citFootnotes}
                onCitFootnotesChange={(v) => { setCitFootnotes(v); saveToFirestore({ citFootnotes: v }); }}
                pageByContent={pageByContent}
                onPageByContentChange={(v) => { setPageByContent(v); saveToFirestore({ pageByContent: v }); }}
              />

              {/* Інфо-блок */}
              <div style={{ background: "#f0f8e8", border: "1px solid #c8dfa0", borderRadius: 8, padding: "12px 16px", marginBottom: 18, fontSize: 13, color: "#3a6010" }}>
                <div style={{ marginBottom: 6 }}>
                  <b>Загальна к-сть джерел: {totalCitCount}</b>
                  {" · "}
                  <span style={{ color: totalCitCount >= minSrc ? "#3a6010" : "#c07000" }}>
                    Мінімум: {minSrc} {totalCitCount < minSrc ? `(ще ${minSrc - totalCitCount})` : "✓"}
                  </span>
                </div>
                <div style={{ fontSize: 12, color: "#555", marginBottom: 10 }}>
                  {workType === "prezentatsiya"
                    ? "Натисніть «Знайти джерела автоматично» — програма згенерує ключові слова і знайде відповідні джерела. Виберіть потрібні галочкою та натисніть «Додати вибрані». Після заповнення натисніть «Генерувати»."
                    : "Пошук запускається автоматично й одразу додає перевірені джерела в список нижче (без ручного відбору). Можна дописати джерела вручну або натиснути «Знайти джерела автоматично» ще раз, щоб дошукати решту."}
                </div>
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                  <GreenBtn onClick={doSearchTezyPapers} loading={tezySearchLoading} msg="Шукаю..." label="Знайти джерела автоматично →" />
                  <a href={scholaUrl} target="_blank" rel="noopener noreferrer"
                    style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: "#1a5a8a", textDecoration: "none", background: "#e4f0ff", padding: "6px 12px", borderRadius: 6, border: "1px solid #b0d0f0" }}>
                    🎓 Шукати додатково на Google Scholar →
                  </a>
                </div>
                {searchPhrases.length > 0 && (
                  <div style={{ marginTop: 10 }}>
                    <div style={{ fontSize: 11, color: "#888", letterSpacing: "1px", textTransform: "uppercase", marginBottom: 5 }}>Шукайте за фразами:</div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                      {searchPhrases.map((ph, i) => (
                        <span key={i} onClick={() => navigator.clipboard.writeText(ph)} title="Клікни щоб скопіювати"
                          style={{ fontSize: 11, background: "#eef5e4", color: "#3a6010", padding: "2px 9px", borderRadius: 10, border: "1px solid #c8dfa0", cursor: "pointer", userSelect: "none" }}>
                          {ph}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Список знайдених — лише для презентації (тези/стаття/есе автовставляють одразу) */}
              {tezySearchLoading && (
                <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "16px 0", color: "#888", fontSize: 13 }}>
                  <SpinDot /> {workType === "prezentatsiya" ? "Шукаю в наукових базах..." : "Шукаю й перевіряю джерела (може тривати трохи довше — каскад по кількох раундах)..."}
                </div>
              )}

              {workType === "prezentatsiya" && tezyPapers.length > 0 && (
                <>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                    <div style={{ fontSize: 12, color: "#888" }}>Знайдено: {tezyPapers.length} · Обрано: {selectedTezyIds.length}</div>
                    <button onClick={doSearchTezyPapers} disabled={tezySearchLoading}
                      style={{ background: "transparent", border: "1px solid #ccc", borderRadius: 6, padding: "4px 12px", fontSize: 11, cursor: "pointer", color: "#666" }}>
                      ↺ Шукати ще
                    </button>
                  </div>
                  {(() => {
                    const PAGE_SIZE = 5;
                    const totalPgs = Math.ceil(tezyPapers.length / PAGE_SIZE);
                    const pagePapers = tezyPapers.slice((tezyPage - 1) * PAGE_SIZE, tezyPage * PAGE_SIZE);
                    return (
                      <>
                        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 12 }}>
                          {pagePapers.map(paper => {
                            const authorsList = Array.isArray(paper.authors) ? paper.authors : [];
                            const authLine = authorsList.length > 2 ? `${authorsList.slice(0, 2).join(", ")} та ін.` : authorsList.join(", ") || "Автор невідомий";
                            const isUk = paper.lang === "uk";
                            const isChecked = selectedTezyIds.includes(paper.id);
                            return (
                              <label key={paper.id} style={{ display: "flex", gap: 10, alignItems: "flex-start", cursor: "pointer", padding: "10px 12px", borderRadius: 7, background: isChecked ? "#f0f8e8" : "#faf8f3", border: `1.5px solid ${isChecked ? "#8cc84b" : "#e0ddd5"}`, transition: "all 0.15s" }}>
                                <input type="checkbox" checked={isChecked}
                                  onChange={() => setSelectedTezyIds(p => isChecked ? p.filter(id => id !== paper.id) : [...p, paper.id])}
                                  style={{ marginTop: 3, accentColor: "#5a9a1a", flexShrink: 0 }} />
                                <div style={{ flex: 1, minWidth: 0 }}>
                                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 2, alignItems: "center" }}>
                                    <span style={{ fontSize: 11, fontWeight: 600, color: "#3a6010" }}>{authLine}</span>
                                    {paper.year && <span style={{ fontSize: 11, color: "#888" }}>{paper.year}</span>}
                                    <span style={{ fontSize: 10, padding: "1px 6px", borderRadius: 8, background: isUk ? "#e8f5e0" : "#e8f0ff", color: isUk ? "#3a6010" : "#1a4a8a", border: `1px solid ${isUk ? "#b8dfa0" : "#b0c8f0"}` }}>
                                      {isUk ? "🇺🇦 укр." : "🌐 зарубіж."}
                                    </span>
                                  </div>
                                  <div style={{ fontSize: 12, color: "#1a1a14", lineHeight: "1.4" }}>
                                    {paper.title.length > 120 ? paper.title.slice(0, 120) + "…" : paper.title}
                                  </div>
                                  {paper.venue && <div style={{ fontSize: 11, color: "#777", fontStyle: "italic", marginTop: 2 }}>{paper.venue}</div>}
                                </div>
                              </label>
                            );
                          })}
                        </div>
                        {totalPgs > 1 && (
                          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                            <button onClick={() => setTezyPage(p => Math.max(1, p - 1))} disabled={tezyPage === 1}
                              style={{ background: "transparent", border: "1px solid #d4cfc4", borderRadius: 6, padding: "4px 12px", fontSize: 12, cursor: tezyPage === 1 ? "default" : "pointer", color: tezyPage === 1 ? "#ccc" : "#555" }}>←</button>
                            {Array.from({ length: totalPgs }, (_, i) => i + 1).map(p => (
                              <button key={p} onClick={() => setTezyPage(p)}
                                style={{ background: p === tezyPage ? "#1a1a14" : "transparent", border: "1px solid #d4cfc4", borderRadius: 6, padding: "4px 10px", fontSize: 12, cursor: "pointer", color: p === tezyPage ? "#e8ff47" : "#555", fontWeight: p === tezyPage ? 600 : 400 }}>
                                {p}
                              </button>
                            ))}
                            <button onClick={() => setTezyPage(p => Math.min(totalPgs, p + 1))} disabled={tezyPage === totalPgs}
                              style={{ background: "transparent", border: "1px solid #d4cfc4", borderRadius: 6, padding: "4px 12px", fontSize: 12, cursor: tezyPage === totalPgs ? "default" : "pointer", color: tezyPage === totalPgs ? "#ccc" : "#555" }}>→</button>
                            <span style={{ fontSize: 11, color: "#aaa", marginLeft: 4 }}>{tezyPage} / {totalPgs}</span>
                          </div>
                        )}
                        {selectedTezyIds.length > 0 && (
                          <div style={{ marginBottom: 16 }}>
                            <PrimaryBtn onClick={doConfirmTezyPapers} disabled={running} loading={running} msg={loadMsg}
                              label={`Додати вибрані (${selectedTezyIds.length}) до списку →`} />
                          </div>
                        )}
                      </>
                    );
                  })()}
                </>
              )}

              {/* Текстове поле джерел */}
              <div style={{ marginTop: 16, marginBottom: 16 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                  <div style={{ fontSize: 12, color: "#555", fontWeight: 600 }}>
                    Список джерел ({citLines.length} введено — кожне з нового рядка):
                  </div>
                  {citText.trim() && (
                    <button onClick={() => setCitText("")}
                      style={{ fontSize: 11, background: "transparent", border: "1px solid #e0b0b0", color: "#a04040", borderRadius: 5, padding: "2px 8px", cursor: "pointer" }}>
                      × Очистити
                    </button>
                  )}
                </div>
                <textarea
                  value={citText}
                  onChange={e => setCitText(e.target.value)}
                  onBlur={() => saveToFirestore({ citText })}
                  placeholder={"Петренко В.І. Психологія навчання. Київ: Наука, 2020. 245 с.\nSmirnova O. Child development. Oxford: OUP, 2019."}
                  style={{ ...TA, width: "100%", minHeight: 120, resize: "vertical", boxSizing: "border-box", fontSize: 12, lineHeight: "1.7", fontFamily: "'Spectral',serif" }}
                />
                {info?.sortAlpha && citLines.length > 1 && (
                  <div style={{ fontSize: 11, color: "#888", marginTop: 4 }}>
                    ℹ Джерела буде відсортовано за алфавітом перед генерацією.
                  </div>
                )}
              </div>

              {/* Кнопки дій */}
              {hardGateActive && citLines.length < minSrc && (
                <div style={{ background: "#fff3e0", border: "1px solid #e8b060", borderRadius: 8, padding: "10px 14px", marginBottom: 12, fontSize: 12, color: "#a05a00" }}>
                  Джерел ще недостатньо для мінімуму ({citLines.length} з {minSrc}) — «Пропустити без джерел» тут недоступне. Дошукайте автоматично ще раз або додайте потрібну кількість вручну в полі вище.
                </div>
              )}
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                {!(hardGateActive && citLines.length < minSrc) && (
                  <NavBtn disabled={running} onClick={() => {
                    setCitText(""); setTezyCitations([]);
                    saveToFirestore({ citText: "", tezyCitations: [], stage: "writing", status: "new" });
                    resetGenerationCost();
                    setStage("writing");
                    if (workType === "tezy") doGenerateTezy([]);
                    else if (workType === "prezentatsiya") { /* user picks theme first */ }
                    else doGenerateSimple([]);
                  }}>
                    Пропустити без джерел →
                  </NavBtn>
                )}
                <PrimaryBtn
                  onClick={doGenerateFromCitText}
                  disabled={hardGateActive ? citLines.length < minSrc : citLines.length === 0}
                  loading={running}
                  msg={loadMsg}
                  label={`Генерувати (${citLines.length} джерел) →`}
                />
              </div>
            </div>
          );
        })()}

        {/* ══ ГЕНЕРАЦІЯ тез ══ */}
        {workType === "tezy" && stage === "writing" && (
          <div className="fade">
            <Heading>📝 Генерація тез</Heading>
            {result ? (
              <>
                <div style={{ border: "1.5px solid #aaa49a", borderRadius: 8, overflow: "hidden", marginBottom: 16 }}>
                  <div style={{ background: "#1a1a14", padding: "10px 16px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ fontSize: 13, color: "#f5f2eb", fontWeight: 600 }}>{info?.topic}</span>
                    <button onClick={() => navigator.clipboard.writeText(result)} style={{ background: "transparent", border: "1px solid #555", color: "#999", borderRadius: 5, padding: "3px 10px", fontSize: 10, cursor: "pointer" }}>COPY</button>
                  </div>
                  <div style={{ padding: "16px 20px", fontSize: 13, lineHeight: "1.85", color: "#2a2a1e", maxHeight: 400, overflowY: "auto", background: "#faf8f3" }}>{renderWithTables(result)}</div>
                </div>
                <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                  <NavBtn onClick={() => setResult("")}>Перегенерувати</NavBtn>
                  <PrimaryBtn onClick={() => setStage("done")} label="Готово →" />
                </div>
              </>
            ) : (
              <div style={{ textAlign: "center", padding: "40px 0" }}>
                <PrimaryBtn onClick={() => doGenerateTezy()} loading={running} msg={loadMsg} label="Генерувати тези →" />
              </div>
            )}
          </div>
        )}

        {/* ══ ГЕНЕРАЦІЯ (стаття / есе) ══ */}
        {["stattia", "ese"].includes(workType) && stage === "writing" && (
          <div className="fade">
            <Heading>{cfg.icon} Генерація {cfg.label}</Heading>
            {!result ? (
              <div style={{ textAlign: "center", padding: "40px 0" }}>
                <p style={{ fontSize: 14, color: "#888", marginBottom: 24 }}>
                  {tezyCitations.length > 0 ? `${tezyCitations.length} джерел обрано. ` : ""}{(materialText.trim() || materialFiles.length > 0) ? "Матеріал для роботи є. " : ""}
                  Натисніть щоб розпочати генерацію.
                </p>
                <div style={{ display: "flex", gap: 10, justifyContent: "center", alignItems: "center" }}>
                  <PrimaryBtn onClick={() => doGenerateSimple()} loading={running} msg={loadMsg} label={`Генерувати ${cfg.label} →`} />
                  {running && (
                    <button
                      onClick={() => genAbortRef.current?.abort()}
                      style={{ background: "transparent", border: "1.5px solid #b03030", color: "#b03030", borderRadius: 7, padding: "10px 20px", fontFamily: "'Spectral',serif", fontSize: 13, cursor: "pointer" }}
                    >
                      ✕ Зупинити
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <>
                <div style={{ border: "1.5px solid #aaa49a", borderRadius: 8, overflow: "hidden", marginBottom: 16 }}>
                  <div style={{ background: "#1a1a14", padding: "10px 16px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ fontSize: 13, color: "#f5f2eb", fontWeight: 600 }}>{info?.topic}</span>
                    <button onClick={() => navigator.clipboard.writeText(result)} style={{ background: "transparent", border: "1px solid #555", color: "#999", borderRadius: 5, padding: "3px 10px", fontSize: 10, cursor: "pointer" }}>COPY</button>
                  </div>
                  <div style={{ padding: "16px 20px", fontSize: 13, lineHeight: "1.85", color: "#2a2a1e", maxHeight: 400, overflowY: "auto", background: "#faf8f3" }}>{renderWithTables(result)}</div>
                </div>
                <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                  <NavBtn onClick={() => { setResult(""); }}>Перегенерувати</NavBtn>
                  <PrimaryBtn onClick={() => { saveToFirestore({ result, stage: "done", status: "done" }); setStage("done"); }} label="Завершити →" />
                </div>
              </>
            )}
          </div>
        )}

        {/* ══ ГЕНЕРАЦІЯ (презентація) ══ */}
        {workType === "prezentatsiya" && stage === "writing" && (
          <div className="fade">
            <Heading>🎞️ Генерація презентації</Heading>
            {slides.length === 0 ? (
              <div style={{ padding: "20px 0" }}>
                {/* Вибір дизайну: стиль + палітра (Авто — підбирає код під галузь і тему) */}
                <div style={{ border: "1.5px solid #d4cfc4", borderRadius: 8, padding: "16px", marginBottom: 20, background: "#faf8f3" }}>
                  <div style={{ fontSize: 12, color: "#888", letterSpacing: "1px", textTransform: "uppercase", marginBottom: 10 }}>Дизайн</div>
                  <DesignSelector value={presDesign} onChange={setPresDesign} allowAuto />
                </div>
                <p style={{ fontSize: 14, color: "#888", marginBottom: 24 }}>
                  {tezyCitations.length > 0 ? `${tezyCitations.length} джерел. ` : ""}
                  {(materialText.trim() || materialFiles.length > 0) ? `Матеріал: ${[materialText.trim() ? "текст" : null, materialFiles.length > 0 ? `${materialFiles.length} файл(ів)` : null].filter(Boolean).join(" + ")}. ` : ""}
                  Генеруватиму структуру та текст для кожного слайду.
                </p>
                <PrimaryBtn onClick={() => doGeneratePresentation()} loading={running} msg={loadMsg} label="Генерувати презентацію →" />
              </div>
            ) : (
              <>
                <p style={{ fontSize: 13, color: "#888", marginBottom: 16 }}>{slides.length} слайдів згенеровано.</p>
                <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 20 }}>
                  {slides.map((slide, i) => {
                    const slideText = `${slide.title}\n${slide.content || (slide.visual?.items ? slide.visual.items.map(it => `${it.icon || "•"} ${it.header ? it.header + ": " : ""}${it.text || ""}`).join("\n") : slide.subtitle || "")}`;
                    return (
                      <div key={i} style={{ border: "1.5px solid #d4cfc4", borderRadius: 8, overflow: "hidden" }}>
                        <div style={{ background: "#1a1a14", padding: "9px 16px", display: "flex", alignItems: "center", gap: 10 }}>
                          <span style={{ fontSize: 11, color: "#e8ff47", background: "#2a2a1a", padding: "1px 8px", borderRadius: 10 }}>{i + 1}</span>
                          <span style={{ fontSize: 11, color: "#666", background: "#2a2a2a", padding: "1px 7px", borderRadius: 8, textTransform: "uppercase", letterSpacing: "0.5px" }}>{slide.layout || "slide"}</span>
                          <span style={{ fontSize: 13, fontWeight: 600, color: "#f5f2eb", flex: 1 }}>{slide.title}</span>
                          <button onClick={() => navigator.clipboard.writeText(slideText)} style={{ background: "transparent", color: "#aaa", border: "1px solid #555", borderRadius: 5, padding: "2px 10px", fontSize: 11, cursor: "pointer", fontFamily: "'Spectral',serif" }}>COPY</button>
                        </div>
                        <div style={{ padding: "12px 16px", fontSize: 13, color: "#444", lineHeight: "1.7", whiteSpace: "pre-wrap", background: "#faf8f3" }}>
                          {slide.content || (slide.visual?.items ? slide.visual.items.map(it => `${it.icon || "•"} ${it.header ? it.header + ": " : ""}${it.text || ""}`).join("\n") : slide.subtitle || "")}
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div style={{ marginBottom: 16 }}>
                  <DesignSelector value={presDesign} onChange={setPresDesign} allowAuto />
                </div>
                <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                  <NavBtn onClick={() => setSlides([])}>Перегенерувати</NavBtn>
                  <button onClick={() => navigator.clipboard.writeText(slides.map((s, i) => `СЛАЙД ${i + 1}: ${s.title}\n${s.content || ""}`).join("\n\n"))}
                    style={{ background: "#1a1a14", color: "#e8ff47", border: "none", borderRadius: 7, padding: "11px 24px", fontFamily: "'Spectral',serif", fontSize: 13, cursor: "pointer" }}>
                    Скопіювати все
                  </button>
                  <button disabled={docxLoading} onClick={async () => {
                    setDocxLoading(true);
                    try { await exportToPptxFile(resolveSlideWebImages({ slides, design: presDesign || undefined }, webImg.webImages), info); }
                    catch (e) { setError(e.message); }
                    setDocxLoading(false);
                  }} style={{ background: docxLoading ? "#aaa" : "#1a4a1a", color: docxLoading ? "#eee" : "#a8e060", border: "none", borderRadius: 7, padding: "11px 24px", fontFamily: "'Spectral',serif", fontSize: 13, cursor: docxLoading ? "default" : "pointer", display: "inline-flex", alignItems: "center", gap: 8 }}>
                    {docxLoading ? <><SpinDot light />Генерую...</> : "⬇ Завантажити .pptx"}
                  </button>
                  <PrimaryBtn onClick={() => { saveToFirestore({ slides, stage: "done", status: "done" }); setStage("done"); }} label="Завершити →" />
                </div>
              </>
            )}
          </div>
        )}

        {/* ══ ГОТОВО ══ */}
        {stage === "done" && (
          <div className="fade">
            <Heading>✓ Готово!</Heading>

            {/* ── Доповідь та презентація ── */}
            {workType === "dopovid" && (
              <div>
                <p style={{ fontSize: 13, color: "#888", marginBottom: 24 }}>
                  Завантажте матеріали та оберіть що генерувати.
                </p>

                {/* Інфо про завантажений файл */}
                {presFile ? (
                  <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", background: "#eef5e4", borderRadius: 8, marginBottom: 20, fontSize: 13 }}>
                    <span style={{ color: "#2a6a2a" }}>✓</span>
                    <span style={{ color: "#2a4a1a", fontWeight: 600 }}>{presFile.name}</span>
                    <button onClick={() => setPresFile(null)} style={{ marginLeft: "auto", background: "none", border: "none", color: "#888", cursor: "pointer", fontSize: 14 }}>✕</button>
                  </div>
                ) : (
                  <div style={{ marginBottom: 20 }}>
                    <div style={{ fontSize: 12, color: "#888", marginBottom: 8 }}>Завантажте файл готової роботи (PDF, DOCX, PPTX, зображення):</div>
                    <DropZone fileLabel={null} onFile={(name, b64, type) => setPresFile({ name, b64, type })} accept=".pdf,.docx,.doc,.pptx,.jpg,.jpeg,.png" />
                  </div>
                )}

                {/* Коментар */}
                <div style={{ marginBottom: 24 }}>
                  <textarea
                    value={presComment}
                    onChange={e => setPresComment(e.target.value)}
                    placeholder="Коментар: вимоги до оформлення, стиль, що врахувати..."
                    style={{ width: "100%", minHeight: 54, fontSize: 12, lineHeight: "1.7", color: "#2a2a1e", background: "#f5f2ea", borderRadius: 6, padding: "9px 12px", border: "1px solid #d4cfc4", fontFamily: "'Spectral',serif", resize: "vertical", boxSizing: "border-box" }}
                  />
                </div>

                <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>

                  {/* 1. Доповідь — генерується першою, з тексту роботи; джерело істини для презентації */}
                  <div style={{ flex: 1, minWidth: 200, border: "1.5px solid #d4cfc4", borderRadius: 8, padding: "16px 18px" }}>
                    <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>Доповідь (.docx)</div>
                    <div style={{ fontSize: 12, color: "#888", marginBottom: 14 }}>Суцільний текст виступу для захисту (3–5 хв)</div>
                    {!speechText ? (
                      <button onClick={generateSpeechWithout} disabled={speechLoading || !presFile}
                        style={{ background: (speechLoading || !presFile) ? "#aaa" : "#1a1a14", color: (speechLoading || !presFile) ? "#eee" : "#e8ff47", border: "none", borderRadius: 6, padding: "9px 20px", fontFamily: "'Spectral',serif", fontSize: 12, letterSpacing: "1px", cursor: (speechLoading || !presFile) ? "default" : "pointer", display: "inline-flex", alignItems: "center", gap: 8 }}>
                        {speechLoading ? <><SpinDot light />Генерую...</> : "Генерувати"}
                      </button>
                    ) : (
                      <div>
                        <div style={{ fontSize: 12, lineHeight: "1.8", color: "#444", maxHeight: 140, overflowY: "auto", background: "#f5f2ea", borderRadius: 6, padding: "10px 12px", marginBottom: 10, whiteSpace: "pre-wrap" }}>
                          {speechText.substring(0, 400)}...
                        </div>
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                          <button onClick={async () => { setSpeechLoading(true); try { await exportSpeechToDocx(speechText, info, methodInfo, currentIdRef.current, "Доповідь"); } catch (e) { alert("Помилка: " + e.message); } setSpeechLoading(false); }} disabled={speechLoading}
                            style={{ background: speechLoading ? "#aaa" : "#1a4a1a", color: speechLoading ? "#eee" : "#a8e060", border: "none", borderRadius: 6, padding: "9px 18px", fontFamily: "'Spectral',serif", fontSize: 12, cursor: speechLoading ? "default" : "pointer", display: "inline-flex", alignItems: "center", gap: 8 }}>
                            {speechLoading ? <><SpinDot light />...</> : "⬇ Завантажити .docx"}
                          </button>
                          <button onClick={() => { setSpeechText(""); saveToFirestore({ speechText: "" }); }}
                            style={{ background: "transparent", border: "1.5px solid #d4cfc4", color: "#888", borderRadius: 6, padding: "9px 14px", fontFamily: "'Spectral',serif", fontSize: 12, cursor: "pointer" }}>
                            Переробити
                          </button>
                        </div>
                      </div>
                    )}
                    {!presFile && !speechLoading && <div style={{ marginTop: 8, fontSize: 11, color: "#bbb" }}>Спочатку завантажте файл</div>}
                  </div>

                  {/* 2. Презентація — слайди мають покривати все, що перелічено в доповіді */}
                  <div style={{ flex: 1, minWidth: 200, border: "1.5px solid #d4cfc4", borderRadius: 8, padding: "16px 18px" }}>
                    <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>Презентація (.pptx)</div>
                    <div style={{ fontSize: 12, color: "#888", marginBottom: 14 }}>10–13 слайдів для захисту з дизайном</div>
                    <button
                      onClick={generateSmallPresentation}
                      disabled={presLoading || !presFile || !speechText}
                      style={{ background: (presLoading || !presFile || !speechText) ? "#aaa" : "#1a1a14", color: (presLoading || !presFile || !speechText) ? "#eee" : "#e8ff47", border: "none", borderRadius: 6, padding: "9px 20px", fontFamily: "'Spectral',serif", fontSize: 12, letterSpacing: "1px", cursor: (presLoading || !presFile || !speechText) ? "default" : "pointer", display: "inline-flex", alignItems: "center", gap: 8 }}>
                      {presLoading ? <><SpinDot light />{presMsg || "Генерую..."}</> : presReady ? "Генерувати знову" : "Генерувати"}
                    </button>
                    {!presFile && !presLoading && <div style={{ marginTop: 8, fontSize: 11, color: "#bbb" }}>Спочатку завантажте файл</div>}
                    {presFile && !speechText && !presLoading && <div style={{ marginTop: 8, fontSize: 11, color: "#bbb", lineHeight: 1.5 }}>Спочатку згенеруйте доповідь — слайди будуть побудовані так, щоб збігатись з нею</div>}
                    {presReady && !presLoading && (
                      <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
                        <div style={{ fontSize: 12, color: "#2a6a2a", display: "flex", alignItems: "center", gap: 6 }}>✓ Готово</div>
                        <PresentationDownload slideData={presSlideJson} info={info} orderId={currentIdRef.current}
                          onDesignSaved={(design) => {
                            const next = { ...presSlideJson, design };
                            setPresSlideJson(next);
                            saveToFirestore({ presSlideJson: next });
                          }} />
                      </div>
                    )}
                    {!presReady && !presLoading && presFile && speechText && (
                      <div style={{ marginTop: 10, fontSize: 11, color: "#aaa", lineHeight: 1.5 }}>Claude генерує слайди на основі тексту роботи й доповіді</div>
                    )}
                  </div>

                  {/* 3. Доповідь з мітками слайдів — той самий текст доповіді, лише розмічений по слайдах */}
                  <div style={{ flex: 1, minWidth: 200, border: "1.5px solid #d4cfc4", borderRadius: 8, padding: "16px 18px" }}>
                    <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>Доповідь з мітками слайдів (.docx)</div>
                    <div style={{ fontSize: 12, color: "#888", marginBottom: 14 }}>Той самий текст доповіді, розбитий по слайдах з мітками «Слайд N» (3–5 хв)</div>
                    {!speechWithText ? (
                      <button onClick={generateSpeechWith} disabled={speechWithLoading || !speechText || !presSlideJson?.slides?.length}
                        style={{ background: (speechWithLoading || !speechText || !presSlideJson?.slides?.length) ? "#aaa" : "#1a1a14", color: (speechWithLoading || !speechText || !presSlideJson?.slides?.length) ? "#eee" : "#e8ff47", border: "none", borderRadius: 6, padding: "9px 20px", fontFamily: "'Spectral',serif", fontSize: 12, letterSpacing: "1px", cursor: (speechWithLoading || !speechText || !presSlideJson?.slides?.length) ? "default" : "pointer", display: "inline-flex", alignItems: "center", gap: 8 }}>
                        {speechWithLoading ? <><SpinDot light />Генерую...</> : "Генерувати"}
                      </button>
                    ) : (
                      <div>
                        <div style={{ fontSize: 12, lineHeight: "1.8", color: "#444", maxHeight: 140, overflowY: "auto", background: "#f5f2ea", borderRadius: 6, padding: "10px 12px", marginBottom: 10, whiteSpace: "pre-wrap" }}>
                          {speechWithText.substring(0, 400)}...
                        </div>
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                          <button onClick={async () => { setSpeechWithLoading(true); try { await exportSpeechToDocx(speechWithText, info, methodInfo, currentIdRef.current, "Доповідь з презентацією"); } catch (e) { alert("Помилка: " + e.message); } setSpeechWithLoading(false); }} disabled={speechWithLoading}
                            style={{ background: speechWithLoading ? "#aaa" : "#1a4a1a", color: speechWithLoading ? "#eee" : "#a8e060", border: "none", borderRadius: 6, padding: "9px 18px", fontFamily: "'Spectral',serif", fontSize: 12, cursor: speechWithLoading ? "default" : "pointer", display: "inline-flex", alignItems: "center", gap: 8 }}>
                            {speechWithLoading ? <><SpinDot light />...</> : "⬇ Завантажити .docx"}
                          </button>
                          <button onClick={() => { setSpeechWithText(""); saveToFirestore({ speechWithText: "" }); }}
                            style={{ background: "transparent", border: "1.5px solid #d4cfc4", color: "#888", borderRadius: 6, padding: "9px 14px", fontFamily: "'Spectral',serif", fontSize: 12, cursor: "pointer" }}>
                            Переробити
                          </button>
                        </div>
                      </div>
                    )}
                    {!speechText && !speechWithLoading && (
                      <div style={{ marginTop: 8, fontSize: 11, color: "#bbb", lineHeight: 1.5 }}>Спочатку згенеруйте доповідь</div>
                    )}
                    {speechText && !presSlideJson?.slides?.length && !speechWithLoading && (
                      <div style={{ marginTop: 8, fontSize: 11, color: "#bbb", lineHeight: 1.5 }}>Спочатку згенеруйте презентацію</div>
                    )}
                  </div>

                </div>

                <div style={{ marginTop: 24 }}>
                  <NavBtn onClick={() => setStage("input")}>← Назад</NavBtn>
                </div>
              </div>
            )}

            {/* Реферат — всі секції */}
            {workType === "referat" && (
              <>
                {/* Блок з даними титулки якщо витягнуто */}
                {info?.titlePageInfo && (() => {
                  const tpi = info.titlePageInfo;
                  const fields = [
                    tpi.university && `Університет: ${tpi.university}`,
                    tpi.faculty && `Факультет: ${tpi.faculty}`,
                    tpi.discipline && `Дисципліна: ${tpi.discipline}`,
                    tpi.student && `Студент: ${tpi.student}`,
                    tpi.supervisor && `Науковий керівник: ${tpi.supervisor}`,
                    tpi.year && `Рік: ${tpi.year}`,
                  ].filter(Boolean);
                  if (!fields.length) return null;
                  return (
                    <div style={{ border: "1.5px solid #b0c8f0", borderRadius: 8, overflow: "hidden", marginBottom: 16 }}>
                      <div style={{ background: "#1a3a6a", padding: "10px 16px", display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ fontSize: 13, fontWeight: 600, color: "#e4f0ff" }}>Титульна сторінка — витягнуто з файлу</span>
                        <span style={{ fontSize: 11, color: "#8ab0d0", marginLeft: 4 }}>· буде додано автоматично у .docx</span>
                      </div>
                      <div style={{ padding: "12px 16px", background: "#f0f5ff", fontSize: 13, color: "#1a3a6a", display: "flex", flexDirection: "column", gap: 4 }}>
                        {fields.map((f, i) => <div key={i}>{f}</div>)}
                        <div style={{ marginTop: 4, fontSize: 12, color: "#3a6aaa", fontStyle: "italic" }}>Тема: «{info?.topic}»</div>
                      </div>
                    </div>
                  );
                })()}

                {sections.filter(s => s.text).map(sec => (
                  <div key={sec.id} style={{ border: "1.5px solid #aaa49a", borderRadius: 8, marginBottom: 10, overflow: "hidden" }}>
                    <div style={{ background: "#1a1a14", padding: "10px 16px", display: "flex", alignItems: "center", gap: 10 }}>
                      <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#e8ff47" }} />
                      <div style={{ flex: 1, fontSize: 13, fontWeight: 600, color: "#f5f2eb" }}>{sec.label}</div>
                      <button onClick={() => navigator.clipboard.writeText(sec.text)} style={{ background: "transparent", border: "1px solid #555", color: "#999", borderRadius: 5, padding: "3px 10px", fontSize: 10, cursor: "pointer" }}>COPY</button>
                    </div>
                    <div style={{ padding: "14px 18px", fontSize: 13, lineHeight: "1.85", color: "#2a2a1e", whiteSpace: "pre-wrap", maxHeight: 260, overflowY: "auto", background: "#faf8f3" }}>{renderWithTables(sec.text)}</div>
                  </div>
                ))}

                {/* Кнопка форматування джерел */}
                {tezyCitations.length > 0 && !sourcesFormatted && (
                  <div style={{ border: "1.5px solid #e8c840", borderRadius: 8, padding: "14px 18px", marginTop: 12, marginBottom: 4, background: "#fffbf0" }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: "#5a3a00", marginBottom: 6 }}>Список літератури ще не відформатовано</div>
                    <div style={{ fontSize: 12, color: "#7a5a20", marginBottom: 12 }}>
                      Натисніть щоб оформити список джерел ({tezyCitations.length} шт.) за стилем {info?.citStyle || "ДСТУ 8302:2015"} і розставити посилання у тексті.
                    </div>
                    <button onClick={doFormatAndRemapCitations} disabled={running}
                      style={{ background: running ? "#aaa" : "#3a2a00", color: running ? "#eee" : "#e8c840", border: "none", borderRadius: 7, padding: "10px 22px", fontFamily: "'Spectral',serif", fontSize: 13, cursor: running ? "default" : "pointer", display: "inline-flex", alignItems: "center", gap: 8 }}>
                      {running ? <><SpinDot light />{loadMsg || "Форматую..."}</> : "📋 Сформувати список літератури і посилання →"}
                    </button>
                  </div>
                )}
                {sourcesFormatted && (
                  <div style={{ fontSize: 12, color: "#3a6010", marginTop: 4, marginBottom: 8 }}>✓ Список літератури відформатовано ({info?.citStyle || "ДСТУ 8302:2015"})</div>
                )}
                <WebImagesPanel
                  figs={findPlaceholderFigures({ content: Object.fromEntries(sections.map(s => [s.id, s.text])), sections, lang: info?.language })} wi={webImg}
                  onSearchAll={() => webImg.searchAll({ content: Object.fromEntries(sections.map(s => [s.id, s.text])), sections, lang: info?.language, topic: info?.topic }).catch(e => console.error("webImages:", e.message))}
                  onSearchOne={(fig) => webImg.searchOne(fig, { lang: info?.language, topic: info?.topic })}
                />

                <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 16 }}>
                  <button onClick={() => navigator.clipboard.writeText(sections.map(s => s.label + "\n\n" + s.text).join("\n\n" + "─".repeat(50) + "\n\n"))}
                    style={{ background: "#1a1a14", color: "#e8ff47", border: "none", borderRadius: 7, padding: "11px 24px", fontFamily: "'Spectral',serif", fontSize: 13, cursor: "pointer" }}>
                    Скопіювати все
                  </button>
                  <button disabled={docxLoading || running || webImg.webImagesBusy} onClick={async () => {
                    setDocxLoading(true);
                    try {
                      const content = Object.fromEntries(sections.map(s => [s.id, s.text]));
                      const displayOrder = sections.map(s => ({
                        id: s.id,
                        label: s.label,
                        sectionTitle: s.sectionTitle,
                        type: s.id === "intro" ? "intro"
                          : s.id === "conclusions" ? "conclusions"
                          : s.id === "sources" ? "sources"
                          : "body",
                      }));
                      // Будуємо titlePageLines з витягнутих даних титулки
                      const tpi = info?.titlePageInfo;
                      const refTitlePageLines = tpi ? (() => {
                        const yr = tpi.year || new Date().getFullYear();
                        const lines = [];
                        if (tpi.university) lines.push({ text: tpi.university.toUpperCase(), align: "center", bold: true, spaceBefore: 0 });
                        if (tpi.faculty) lines.push({ text: tpi.faculty, align: "center", bold: false, spaceBefore: 0 });
                        lines.push({ text: "", align: "center", spaceBefore: 960 });
                        lines.push({ text: (info?.type || "РЕФЕРАТ").toUpperCase(), align: "center", bold: true, spaceBefore: 0 });
                        if (tpi.discipline) lines.push({ text: `з дисципліни: ${tpi.discipline}`, align: "center", bold: false, spaceBefore: 0 });
                        lines.push({ text: `на тему: «[ТЕМА]»`, align: "center", bold: false, spaceBefore: 0 });
                        lines.push({ text: "", align: "center", spaceBefore: 2880 });
                        if (tpi.student) lines.push({ text: `Виконав(ла): ${tpi.student}`, align: "right", bold: false, spaceBefore: 0 });
                        if (tpi.supervisor) lines.push({ text: `Науковий керівник: ${tpi.supervisor}`, align: "right", bold: false, spaceBefore: 0 });
                        lines.push({ text: "", align: "center", spaceBefore: 3840 });
                        lines.push({ text: `${tpi.city || ""}${tpi.city ? " – " : ""}${yr}`, align: "center", bold: false, spaceBefore: 0 });
                        return lines;
                      })() : null;
                      await exportToDocx({ content, info, displayOrder, appendicesText: "", titlePage: null, titlePageLines: refTitlePageLines, methodInfo, orderId: currentIdRef.current, annotationUk, webImages: webImg.webImages });
                    } catch (e) { setError(e.message); }
                    setDocxLoading(false);
                  }} style={{ background: (docxLoading || running || webImg.webImagesBusy) ? "#aaa" : "#1a4a1a", color: (docxLoading || running || webImg.webImagesBusy) ? "#eee" : "#a8e060", border: "none", borderRadius: 7, padding: "11px 24px", fontFamily: "'Spectral',serif", fontSize: 13, cursor: (docxLoading || running || webImg.webImagesBusy) ? "default" : "pointer", display: "inline-flex", alignItems: "center", gap: 8 }}>
                    {docxLoading ? <><SpinDot light />Генерую...</> : running ? <><SpinDot light />{loadMsg || "Дооформлюю..."}</> : webImg.webImagesBusy ? <><SpinDot light />Підбираю фото...</> : "⬇ Завантажити .docx"}
                  </button>
                </div>
              </>
            )}

            {/* Тези / Стаття / Есе */}
            {["tezy", "stattia", "ese"].includes(workType) && result && (
              <>
                <div style={{ border: "1.5px solid #aaa49a", borderRadius: 8, overflow: "hidden", marginBottom: 16 }}>
                  <div style={{ background: "#1a1a14", padding: "10px 16px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ fontSize: 13, color: "#f5f2eb", fontWeight: 600 }}>{info?.topic}</span>
                    <button onClick={() => navigator.clipboard.writeText(result)} style={{ background: "transparent", border: "1px solid #555", color: "#999", borderRadius: 5, padding: "3px 10px", fontSize: 10, cursor: "pointer" }}>COPY</button>
                  </div>
                  <div style={{ padding: "16px 20px", fontSize: 13, lineHeight: "1.85", color: "#2a2a1e", maxHeight: 400, overflowY: "auto", background: "#faf8f3" }}>{renderWithTables(result)}</div>
                </div>

                {/* Рекомендації щодо рисунків */}
                {workType === "tezy" && (() => {
                  const figRe = /\[🔍 Рисунок (\d+): "([^"]+)"\]/g;
                  const figures = [];
                  let m;
                  const text = result || "";
                  while ((m = figRe.exec(text)) !== null) figures.push({ num: m[1], query: m[2] });
                  if (!figures.length) return null;
                  return (
                    <div style={{ border: "1.5px solid #e8a840", borderRadius: 8, overflow: "hidden", marginBottom: 16 }}>
                      <div style={{ background: "#3a2000", padding: "10px 16px", display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ fontSize: 13, fontWeight: 600, color: "#ffcc70" }}>Рисунки для вставки у роботу</span>
                        <span style={{ fontSize: 11, color: "#aa8040" }}>· знайдіть і вставте у Word замість маркерів [🔍]</span>
                      </div>
                      <div style={{ padding: "12px 16px", background: "#fffbf0", display: "flex", flexDirection: "column", gap: 10 }}>
                        {figures.map(({ num, query }) => (
                          <div key={num} style={{ padding: "10px 14px", background: "#fff8e8", border: "1px solid #e8c870", borderRadius: 7 }}>
                            <div style={{ fontSize: 12, fontWeight: 600, color: "#5a3a00", marginBottom: 6 }}>Рис. {num} — пошуковий запит: <span style={{ fontStyle: "italic" }}>«{query}»</span></div>
                            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                              {[
                                { label: "Google Зображення", url: `https://images.google.com/search?tbm=isch&q=${encodeURIComponent(query)}` },
                                { label: "Wikimedia Commons", url: `https://commons.wikimedia.org/w/index.php?search=${encodeURIComponent(query)}&ns6=1` },
                                { label: "Google Академія", url: `https://scholar.google.com/scholar?q=${encodeURIComponent(query)}` },
                              ].map(({ label, url }) => (
                                <a key={label} href={url} target="_blank" rel="noopener noreferrer"
                                  style={{ fontSize: 11, color: "#1a5a8a", background: "#e4f0ff", padding: "3px 10px", borderRadius: 6, border: "1px solid #b0d0f0", textDecoration: "none" }}>
                                  🔍 {label}
                                </a>
                              ))}
                            </div>
                          </div>
                        ))}
                        <div style={{ fontSize: 11, color: "#8a6020", marginTop: 4 }}>
                          У файлі .docx маркери [🔍] не потрапляють — тільки підписи «Рис. N — ...» виділені помаранчевим.
                        </div>
                      </div>
                    </div>
                  );
                })()}

                {/* Кнопка форматування джерел */}
                {tezyCitations.length > 0 && !sourcesFormatted && (
                  <div style={{ border: "1.5px solid #e8c840", borderRadius: 8, padding: "14px 18px", marginTop: 4, marginBottom: 16, background: "#fffbf0" }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: "#5a3a00", marginBottom: 6 }}>Список літератури ще не відформатовано</div>
                    <div style={{ fontSize: 12, color: "#7a5a20", marginBottom: 12 }}>
                      Натисніть щоб оформити список джерел ({tezyCitations.length} шт.) за стилем {info?.citStyle || "ДСТУ 8302:2015"} і розставити посилання у тексті.
                    </div>
                    <button onClick={doFormatAndRemapCitations} disabled={running}
                      style={{ background: running ? "#aaa" : "#3a2a00", color: running ? "#eee" : "#e8c840", border: "none", borderRadius: 7, padding: "10px 22px", fontFamily: "'Spectral',serif", fontSize: 13, cursor: running ? "default" : "pointer", display: "inline-flex", alignItems: "center", gap: 8 }}>
                      {running ? <><SpinDot light />{loadMsg || "Форматую..."}</> : "📋 Сформувати список літератури і посилання →"}
                    </button>
                  </div>
                )}
                {sourcesFormatted && (
                  <div style={{ fontSize: 12, color: "#3a6010", marginTop: 4, marginBottom: 8 }}>✓ Список літератури відформатовано ({info?.citStyle || "ДСТУ 8302:2015"})</div>
                )}

                <WebImagesPanel
                  figs={findPlaceholderFigures(simpleWebImageArgs(result))} wi={webImg}
                  onSearchAll={() => webImg.searchAll(simpleWebImageArgs(result)).catch(e => console.error("webImages:", e.message))}
                  onSearchOne={(fig) => webImg.searchOne(fig, { lang: info?.language, topic: info?.topic })}
                />

                <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                  <button disabled={docxLoading || webImg.webImagesBusy} onClick={async () => {
                    setDocxLoading(true);
                    try {
                      await exportSimpleDocx({ title: info?.topic, sections: [{ label: "", text: result }], info, citations: workType === "tezy" ? tezyCitations : undefined, orderId: currentIdRef.current, methodInfo, pageNumbers: false, webImages: webImg.webImages });
                    } catch (e) { setError(e.message); }
                    setDocxLoading(false);
                  }} style={{ background: (docxLoading || webImg.webImagesBusy) ? "#aaa" : "#1a4a1a", color: (docxLoading || webImg.webImagesBusy) ? "#eee" : "#a8e060", border: "none", borderRadius: 7, padding: "11px 24px", fontFamily: "'Spectral',serif", fontSize: 13, cursor: (docxLoading || webImg.webImagesBusy) ? "default" : "pointer", display: "inline-flex", alignItems: "center", gap: 8 }}>
                    {docxLoading ? <><SpinDot light />Генерую...</> : webImg.webImagesBusy ? <><SpinDot light />Підбираю фото...</> : "⬇ Завантажити .docx"}
                  </button>
                </div>
              </>
            )}

            {/* Презентація */}
            {workType === "prezentatsiya" && slides.length > 0 && (
              <>
                <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 16 }}>
                  {slides.map((slide, i) => {
                    const slideText = `${slide.title}\n${slide.content || (slide.visual?.items ? slide.visual.items.map(it => `${it.icon || "•"} ${it.header ? it.header + ": " : ""}${it.text || ""}`).join("\n") : slide.subtitle || "")}`;
                    return (
                      <div key={i} style={{ border: "1.5px solid #d4cfc4", borderRadius: 8, overflow: "hidden" }}>
                        <div style={{ background: "#1a1a14", padding: "9px 16px", display: "flex", alignItems: "center", gap: 10 }}>
                          <span style={{ fontSize: 11, color: "#e8ff47", background: "#2a2a1a", padding: "1px 8px", borderRadius: 10 }}>{i + 1}</span>
                          {slide.layout && <span style={{ fontSize: 11, color: "#666", background: "#2a2a2a", padding: "1px 7px", borderRadius: 8, textTransform: "uppercase", letterSpacing: "0.5px" }}>{slide.layout}</span>}
                          <span style={{ fontSize: 13, fontWeight: 600, color: "#f5f2eb", flex: 1 }}>{slide.title}</span>
                          <button onClick={() => navigator.clipboard.writeText(slideText)} style={{ background: "transparent", color: "#aaa", border: "1px solid #555", borderRadius: 5, padding: "2px 10px", fontSize: 11, cursor: "pointer", fontFamily: "'Spectral',serif" }}>COPY</button>
                        </div>
                        <div style={{ padding: "12px 16px", fontSize: 13, color: "#444", lineHeight: "1.7", whiteSpace: "pre-wrap", background: "#faf8f3" }}>
                          {slide.content || (slide.visual?.items ? slide.visual.items.map(it => `${it.icon || "•"} ${it.header ? it.header + ": " : ""}${it.text || ""}`).join("\n") : slide.subtitle || "")}
                        </div>
                      </div>
                    );
                  })}
                </div>
                {/* Кнопка форматування джерел */}
                {tezyCitations.length > 0 && !sourcesFormatted && (
                  <div style={{ border: "1.5px solid #e8c840", borderRadius: 8, padding: "14px 18px", marginTop: 4, marginBottom: 16, background: "#fffbf0" }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: "#5a3a00", marginBottom: 6 }}>Список літератури ще не відформатовано</div>
                    <div style={{ fontSize: 12, color: "#7a5a20", marginBottom: 12 }}>
                      Натисніть щоб оформити список джерел ({tezyCitations.length} шт.) за стилем {info?.citStyle || "ДСТУ 8302:2015"} і розставити посилання у тексті.
                    </div>
                    <button onClick={doFormatAndRemapCitations} disabled={running}
                      style={{ background: running ? "#aaa" : "#3a2a00", color: running ? "#eee" : "#e8c840", border: "none", borderRadius: 7, padding: "10px 22px", fontFamily: "'Spectral',serif", fontSize: 13, cursor: running ? "default" : "pointer", display: "inline-flex", alignItems: "center", gap: 8 }}>
                      {running ? <><SpinDot light />{loadMsg || "Форматую..."}</> : "📋 Сформувати список літератури і посилання →"}
                    </button>
                  </div>
                )}
                {sourcesFormatted && (
                  <div style={{ fontSize: 12, color: "#3a6010", marginTop: 4, marginBottom: 8 }}>✓ Список літератури відформатовано ({info?.citStyle || "ДСТУ 8302:2015"})</div>
                )}

                <div style={{ marginBottom: 12 }}>
                  <WebImagesPanel
                    figs={findSlideImageSlots(slides)} wi={webImg}
                    onSearchAll={() => webImg.searchFigs(findSlideImageSlots(slides), { lang: info?.language, topic: info?.topic }).catch(e => console.error("webImages:", e.message))}
                    onSearchOne={(fig) => webImg.searchOne(fig, { lang: info?.language, topic: info?.topic })}
                  />
                </div>
                <div style={{ marginBottom: 12 }}>
                  <DesignSelector value={presDesign} onChange={setPresDesign} allowAuto />
                </div>
                <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                  <button onClick={() => navigator.clipboard.writeText(slides.map((s, i) => `СЛАЙД ${i + 1}: ${s.title}\n${s.content || ""}`).join("\n\n"))}
                    style={{ background: "#1a1a14", color: "#e8ff47", border: "none", borderRadius: 7, padding: "11px 24px", fontFamily: "'Spectral',serif", fontSize: 13, cursor: "pointer" }}>
                    Скопіювати все
                  </button>
                  <button disabled={docxLoading} onClick={async () => {
                    setDocxLoading(true);
                    try { await exportToPptxFile(resolveSlideWebImages({ slides, design: presDesign || undefined }, webImg.webImages), info); }
                    catch (e) { setError(e.message); }
                    setDocxLoading(false);
                  }} style={{ background: docxLoading ? "#aaa" : "#1a4a1a", color: docxLoading ? "#eee" : "#a8e060", border: "none", borderRadius: 7, padding: "11px 24px", fontFamily: "'Spectral',serif", fontSize: 13, cursor: docxLoading ? "default" : "pointer", display: "inline-flex", alignItems: "center", gap: 8 }}>
                    {docxLoading ? <><SpinDot light />Генерую...</> : "⬇ Завантажити .pptx"}
                  </button>
                </div>
              </>
            )}

            <div style={{ marginTop: 20, padding: "10px 14px", background: "#f0ece2", borderRadius: 6, fontSize: 12, color: "#888" }}>
              Word: Times New Roman 14, міжрядковий 1.5, поля ліво 3см / право 1.5см / верх-низ 2см.
            </div>
            <div style={{ marginTop: 20 }}>
              <button onClick={() => setStage("checklist")} style={{ background: "transparent", border: "1.5px solid #e8ff47", color: "#e8ff47", borderRadius: 7, padding: "11px 22px", fontFamily: "'Spectral',serif", fontSize: 13, cursor: "pointer" }}>
                Чек-лист →
              </button>
            </div>
          </div>
        )}

        {stage === "checklist" && (
          <ChecklistStage info={info} setStage={setStage} mode="small" />
        )}

      </div>
    </div>
  );
}
