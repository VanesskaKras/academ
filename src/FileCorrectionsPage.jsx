import { useState, useRef, useEffect, useMemo } from "react";
import mammoth from "mammoth";
import { db } from "./firebase";
import { useAuth } from "./AuthContext";
import { collection, addDoc, updateDoc, serverTimestamp, query, where, getDocs, doc, getDoc } from "firebase/firestore";
import { callClaude, callGemini, resetGenerationCost, getGenerationCost, GENERATION_COST_LIMIT } from "./lib/api.js";
import { SYS_JSON_SHORT, STRUCTURE_READING_PROMPT, buildMethodologyReadingPrompt } from "./lib/prompts.js";
import { SpinDot } from "./components/SpinDot.jsx";
import { PhotoDropZone } from "./components/PhotoDropZone.jsx";
import { DropZone } from "./components/DropZone.jsx";
import { ClientMaterialsZone } from "./components/ClientMaterialsZone.jsx";
import { extractAnnotationsFromOpenDocx } from "./lib/docxAnnotations.js";
import { refreshTextMap } from "./lib/docxSurgicalEdit.js";
import { locateFragment } from "./lib/textFragmentLocate.js";
// Уся логіка правок — спільна з воркером (worker/runCorrections.js): той самий
// код готує файл, застосовує правки й запускає агента, тож UI і headless-режим
// дають однаковий результат.
import {
  prepareDocxForCorrections, annotationsToTasks, analyzeManualNotes, applyCorrectionTasks,
  buildCitationPagesTask, describeRevisions, finalizeCorrectedDocx,
} from "./lib/correctionStages.js";
import { runAgentCorrections } from "./lib/correctionAgent.js";
import { registerLangProfile } from "./lib/planUtils.js";

const LANG_OPTIONS = ["Українська", "English", "Польська", "Німецька", "Французька", "Іспанська"];

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

// ─────────────────────────────────────────────
// Завантаження хірургічно відредагованого .docx — serializeDocx уже повертає
// готовий Blob з оригінальним файлом, у якому змінено лише виправлені фрагменти.
// ─────────────────────────────────────────────
function downloadDocxBlob(blob, originalName) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const base = originalName?.replace(/\.docx$/i, "") || "документ";
  a.href = url;
  a.download = `${base}_виправлено.docx`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ─────────────────────────────────────────────
// Стилі
// ─────────────────────────────────────────────
const cardStyle = { border: "1.5px solid #d4cfc4", borderRadius: 8, overflow: "hidden", marginBottom: 14 };
const cardHead = (bg = "#1a1a14") => ({ padding: "11px 16px", background: bg, display: "flex", alignItems: "center", gap: 10 });
const cardBody = { padding: "14px 16px", background: "#faf8f3" };
const dot = (color) => ({ width: 8, height: 8, borderRadius: "50%", background: color, flexShrink: 0 });
const labelStyle = { fontSize: 13, fontWeight: 600, color: "#f5f2eb" };
const btnPrimary = (disabled) => ({ background: disabled ? "#444" : "#1a1a14", color: disabled ? "#888" : "#e8ff47", border: "none", borderRadius: 6, padding: "9px 24px", fontFamily: "'Spectral',serif", fontSize: 13, cursor: disabled ? "default" : "pointer", display: "inline-flex", alignItems: "center", gap: 8 });
const btnGreen = (disabled) => ({ background: disabled ? "#444" : "#1a4a1a", color: disabled ? "#aaa" : "#a8e060", border: "none", borderRadius: 6, padding: "9px 24px", fontFamily: "'Spectral',serif", fontSize: 13, cursor: disabled ? "default" : "pointer", display: "inline-flex", alignItems: "center", gap: 8 });

// ─────────────────────────────────────────────
// StepBar
// ─────────────────────────────────────────────
const STEPS = ["Файл", "Правки", "Виправлення", "Готово"];

function StepBar({ current }) {
  return (
    <div style={{ display: "flex", alignItems: "center", marginBottom: 24, gap: 0 }}>
      {STEPS.map((s, i) => {
        const active = i === current;
        const done = i < current;
        return (
          <div key={i} style={{ display: "flex", alignItems: "center", flex: i < STEPS.length - 1 ? 1 : "initial" }}>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
              <div style={{ width: 28, height: 28, borderRadius: "50%", background: done ? "#6a9000" : active ? "#1a1a14" : "#ddd", color: done ? "#fff" : active ? "#e8ff47" : "#aaa", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 700 }}>
                {done ? "✓" : i + 1}
              </div>
              <div style={{ fontSize: 10, color: active ? "#1a1a14" : "#aaa", fontWeight: active ? 700 : 400, letterSpacing: 0.5 }}>
                {s}
              </div>
            </div>
            {i < STEPS.length - 1 && (
              <div style={{ flex: 1, height: 2, background: done ? "#6a9000" : "#ddd", margin: "0 4px", marginBottom: 16 }} />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────
// Рядок одного завдання (анотація, ручне зауваження, сторінки в цитатах чи
// перебудова джерел) у списку кроку 1
// ─────────────────────────────────────────────
function TaskRow({ task, isChecked, onToggle, hasConflict }) {
  return (
    <div style={{ padding: "12px 16px", display: "flex", gap: 12, alignItems: "flex-start", opacity: isChecked ? 1 : 0.4 }}>
      <input type="checkbox" checked={isChecked} onChange={e => onToggle(e.target.checked)} style={{ marginTop: 3, accentColor: "#6a9000", flexShrink: 0, cursor: "pointer" }} />
      <div style={{ flex: 1 }}>
        {task.kind === "annotation" ? (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4, flexWrap: "wrap" }}>
              {task.type === "highlight" && task.colorInfo && (
                <span style={{ display: "inline-block", background: task.colorInfo.css, color: task.colorInfo.text, fontSize: 10, borderRadius: 3, padding: "1px 7px", fontWeight: 600, letterSpacing: 0.3 }}>
                  {task.colorInfo.ua}
                </span>
              )}
              {task.type === "comment" && (
                <span style={{ display: "inline-block", background: "#dbeafe", color: "#1e40af", fontSize: 10, borderRadius: 3, padding: "1px 7px", fontWeight: 600 }}>
                  💬 {task.label}
                </span>
              )}
              {task.type === "color_note" && (
                <span style={{ display: "inline-block", background: "#fbe0e0", color: "#a01e1e", fontSize: 10, borderRadius: 3, padding: "1px 7px", fontWeight: 600 }}>
                  🖊 {task.label}
                </span>
              )}
              {hasConflict && (
                <span title="Ще одна правка стосується того самого фрагмента тексту" style={{ display: "inline-block", background: "#fde2b8", color: "#8a4a00", fontSize: 10, borderRadius: 3, padding: "1px 7px", fontWeight: 600 }}>
                  ⚠ перетинається з іншою правкою
                </span>
              )}
              {task.documentWide && (
                <span title="ШІ шукатиме й виправлятиме всі відповідні місця в документі, не лише це" style={{ display: "inline-block", background: "#dfe8ff", color: "#1e3a8a", fontSize: 10, borderRadius: 3, padding: "1px 7px", fontWeight: 600 }}>
                  📌 стосується всього документа
                </span>
              )}
            </div>
            <div style={{ fontSize: 12, color: "#c04020", marginBottom: task.type === "comment" || task.type === "color_note" ? 3 : 0, fontStyle: "italic" }}>
              «{(task.type === "color_note" ? task.noteText : task.annotatedText).slice(0, 120)}{(task.type === "color_note" ? task.noteText : task.annotatedText).length > 120 ? "..." : ""}»
            </div>
            {task.type === "comment" && (
              <div style={{ fontSize: 12, color: "#3a6010", marginTop: 2 }}>
                <span style={{ fontWeight: 600 }}>Інструкція:</span> {task.instruction}
              </div>
            )}
          </>
        ) : task.kind === "citation_pages" ? (
          <>
            <div style={{ fontSize: 10, background: "#dbeafe", color: "#1e40af", display: "inline-block", borderRadius: 3, padding: "1px 7px", fontWeight: 600, marginBottom: 4 }}>
              🔢 Автоматично, без ШІ
            </div>
            <div style={{ fontSize: 13, color: "#2a2a1e" }}>{task.label}</div>
            <div style={{ fontSize: 12, color: "#888", marginTop: 2 }}>Номер сторінки підбирається кодом у межах реального обсягу джерела — без ризику вигадування.</div>
          </>
        ) : task.kind === "sources_restructure" ? (
          <>
            <div style={{ fontSize: 10, background: "#fbe8e0", color: "#c04020", display: "inline-block", borderRadius: 3, padding: "1px 7px", fontWeight: 600, marginBottom: 4 }}>
              ⚠ Перебудова списку джерел
            </div>
            <div style={{ fontSize: 13, color: "#c04020", marginBottom: 3 }}><span style={{ fontWeight: 600 }}>Проблема:</span> {task.issue}</div>
            <div style={{ fontSize: 13, color: "#3a6010" }}><span style={{ fontWeight: 600 }}>Що зробити:</span> {task.suggestion}</div>
          </>
        ) : (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4, flexWrap: "wrap" }}>
              <div style={{ fontSize: 10, background: "#e8dcc8", color: "#7a5a2a", display: "inline-block", borderRadius: 3, padding: "1px 7px", fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5 }}>
                ✏️ {task.location}
              </div>
              {task.documentWide && (
                <span title="ШІ шукатиме й виправлятиме всі відповідні місця в документі, не лише це" style={{ display: "inline-block", background: "#dfe8ff", color: "#1e3a8a", fontSize: 10, borderRadius: 3, padding: "1px 7px", fontWeight: 600 }}>
                  📌 стосується всього документа
                </span>
              )}
            </div>
            <div style={{ fontSize: 13, color: "#c04020", marginBottom: 3 }}><span style={{ fontWeight: 600 }}>Проблема:</span> {task.issue}</div>
            <div style={{ fontSize: 13, color: "#3a6010" }}><span style={{ fontWeight: 600 }}>Що зробити:</span> {task.suggestion}</div>
          </>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// Головний компонент
// ─────────────────────────────────────────────
export default function FileCorrectionsPage({ onBack }) {
  const { user } = useAuth();

  const [step, setStep] = useState(0);

  // Файл
  const [fileName, setFileName] = useState("");
  const [docText, setDocText] = useState("");
  const [fileLoading, setFileLoading] = useState(false);
  const fileRef = useRef();
  // {zip, docXml} — живі об'єкти для хірургічного редагування оригінального
  // .docx; не в React-стейті, бо мутуються напряму (DOM/JSZip), а не через рендер.
  const docStateRef = useRef(null);
  // Той самий Firestore-документ оновлюється (не пересоздається) на кожному
  // наступному раунді правок у межах цієї сесії — так history накопичується
  // в одному записі, а не розсипається по окремих.
  const orderDocIdRef = useRef(null);

  // Завдання: об'єднує і автоматично знайдені виділення/коментарі (kind:"annotation"),
  // і ручно введені зауваження (kind:"manual") — програма сама розпізнає перше під
  // час завантаження файлу, друге можна додати в будь-який момент на кроці 1.
  const [extractLoading, setExtractLoading] = useState(false);
  const [annotations, setAnnotations] = useState({ highlights: [], comments: [], colorNotes: [] });
  const [tasks, setTasks] = useState([]);
  const [checked, setChecked] = useState({});

  // Ручні зауваження — форма для доповнення списку завдань
  const [manualOpen, setManualOpen] = useState(false);
  const [correctionsText, setCorrectionsText] = useState("");
  const [correctionPhotos, setCorrectionPhotos] = useState([]);
  const [analysisLoading, setAnalysisLoading] = useState(false);

  // Застосування (крок 2-3)
  const [applyLoading, setApplyLoading] = useState(false);
  const [applyProgress, setApplyProgress] = useState(0);
  const [currentBatchLabel, setCurrentBatchLabel] = useState("");
  const [correctedText, setCorrectedText] = useState("");
  const [failedTasks, setFailedTasks] = useState([]);
  const [applyMessages, setApplyMessages] = useState([]); // [{type:"success"|"error", text}]
  const [appliedChanges, setAppliedChanges] = useState([]); // [{label, original, replacement}] — приклади "до/після"
  const [correctionHistory, setCorrectionHistory] = useState([]);
  const [error, setError] = useState("");

  // Режим: "classic" — кожне завдання окремим запитом (як раніше); "agent" — ШІ
  // сам читає й правит документ інструментами (correctionAgent.js).
  const [mode, setMode] = useState("classic");
  const [agentLog, setAgentLog] = useState([]);
  const [applyVolume, setApplyVolume] = useState(null); // {before, after, lo, hi, fromOrder}
  // Повідомлення про прийняті виправлення рецензування — показується в першому раунді.
  const [revisionsMessage, setRevisionsMessage] = useState(null);
  // Умови замовлення (для агента: тип/тема/предмет/курс/обсяг) — з обраного замовлення;
  // обсяг можна вказати вручну.
  const [orderInfo, setOrderInfo] = useState({});
  const [orderPages, setOrderPages] = useState("");

  // Мова роботи — впливає на системний промпт (заборона змішування скриптів,
  // заборона рос./біл. джерел тощо). За замовчуванням українська; автопідтягується
  // з обраного замовлення, якщо його вибрано.
  const [lang, setLang] = useState("Українська");

  // Контекст (необов'язково): методичка + матеріали клієнта — підтягуються лише
  // до тих правок, де це справді доречно (classifyContextNeed), а не завжди й одразу.
  const [contextOpen, setContextOpen] = useState(false);
  const [myOrders, setMyOrders] = useState(null); // null = ще не завантажено
  const [myOrdersLoading, setMyOrdersLoading] = useState(false);
  const [selectedOrderId, setSelectedOrderId] = useState("");
  const [methodInfo, setMethodInfo] = useState(null);
  const [methodFileLabel, setMethodFileLabel] = useState("");
  const [methodLoading, setMethodLoading] = useState(false);
  const [methodError, setMethodError] = useState("");
  const [clientMaterials, setClientMaterials] = useState([]);
  const [clientMaterialsManualText, setClientMaterialsManualText] = useState("");

  const clientMaterialsSummary = (() => {
    const combined = [
      ...clientMaterials.map(m => `=== ${m.name} ===\n${m.text}`),
      clientMaterialsManualText.trim(),
    ].filter(Boolean).join("\n\n");
    return combined ? { rawText: combined } : null;
  })();

  // Витрати
  const tokenAccRef = useRef({ inTok: 0, outTok: 0, costUsd: 0, claudeInTok: 0, claudeOutTok: 0, claudeCostUsd: 0 });
  const [sessionCost, setSessionCost] = useState(0);

  useEffect(() => {
    const handler = (e) => {
      if (e.detail.model?.startsWith("gemini") || e.detail.model === "serper") return;
      const cost = e.detail.cost || 0;
      tokenAccRef.current = {
        inTok: tokenAccRef.current.inTok + (e.detail.inTok || 0),
        outTok: tokenAccRef.current.outTok + (e.detail.outTok || 0),
        costUsd: tokenAccRef.current.costUsd + cost,
        claudeInTok: tokenAccRef.current.claudeInTok + (e.detail.inTok || 0),
        claudeOutTok: tokenAccRef.current.claudeOutTok + (e.detail.outTok || 0),
        claudeCostUsd: tokenAccRef.current.claudeCostUsd + cost,
      };
      setSessionCost(c => c + cost);
    };
    window.addEventListener("apicost", handler);
    return () => window.removeEventListener("apicost", handler);
  }, []);

  const checkedCount = Object.values(checked).filter(Boolean).length;

  // ── Конфлікти між завданнями: для виділень/коментарів/нотаток фрагмент для заміни
  // відомий заздалегідь (task.annotatedText), тож можна знайти його позицію в docText
  // ще ДО застосування і позначити пари, чиї діапазони перетинаються — інакше друга
  // правка з тієї самої пари або не знайде вже змінений фрагмент, або мовчки
  // перезапише результат першої. Для kind:"manual" точний фрагмент з'являється лише
  // з відповіді ШІ під час застосування, тож наперед його не визначити (розпізнається
  // постфактум у doApply — див. roundStartText).
  const conflictTaskIds = useMemo(() => {
    const ranges = [];
    tasks.forEach(t => {
      if (t.kind !== "annotation") return;
      const loc = locateFragment(docText, t.annotatedText, t.context);
      if (loc) ranges.push({ id: t.id, ...loc });
    });
    const conflicts = new Set();
    for (let i = 0; i < ranges.length; i++) {
      for (let j = i + 1; j < ranges.length; j++) {
        if (ranges[i].start < ranges[j].end && ranges[j].start < ranges[i].end) {
          conflicts.add(ranges[i].id);
          conflicts.add(ranges[j].id);
        }
      }
    }
    return conflicts;
  }, [tasks, docText]);

  // ── Список власних замовлень із уже проаналізованою методичкою (для автопідвантаження,
  // щоб не змушувати завантажувати методичку вдруге для роботи, згенерованої в цій програмі) ──
  async function loadMyOrders() {
    if (!user?.uid || myOrders !== null) return;
    setMyOrdersLoading(true);
    try {
      const q = query(collection(db, "orders"), where("uid", "==", user.uid));
      const snap = await getDocs(q);
      const withMethod = snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(d => d.methodInfo)
        .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""))
        .slice(0, 30);
      setMyOrders(withMethod);
    } catch (e) {
      console.error("Не вдалося завантажити список замовлень", e);
      setMyOrders([]);
    }
    setMyOrdersLoading(false);
  }

  async function selectOrder(orderId) {
    setSelectedOrderId(orderId);
    if (!orderId) { setMethodInfo(null); setOrderInfo({}); return; }
    try {
      const snap = await getDoc(doc(db, "orders", orderId));
      const d = snap.data();
      if (d?.methodInfo) setMethodInfo(d.methodInfo);
      if (d?.clientMaterialsSummary?.rawText) setClientMaterialsManualText(d.clientMaterialsSummary.rawText);
      if (d?.info?.language) setLang(d.info.language);
      // Мова поза вбудованою таблицею — набір підписів, збережений у замовленні (langProfile.js)
      registerLangProfile(d?.info);
      if (d?.info) setOrderInfo({ type: d.info.type, topic: d.info.topic, subject: d.info.subject, course: d.info.course, pages: d.info.pages });
    } catch (e) {
      setMethodError("Не вдалося завантажити дані замовлення: " + e.message);
    }
  }

  // ── Ручне завантаження методички (якщо роботу згенеровано не в цій програмі) ──
  async function handleMethodFile(name, b64, type) {
    setMethodFileLabel(name);
    setMethodLoading(true);
    setMethodError("");
    try {
      const docPart = await fileToContentPart(b64, type);
      const structMsgs = [docPart, { type: "text", text: STRUCTURE_READING_PROMPT }];
      const structRaw = await callGemini([{ role: "user", content: structMsgs }], null, SYS_JSON_SHORT, 2000, null, "gemini-2.5-flash", true);
      const structMatch = structRaw.match(/\{[\s\S]*\}/);
      let structureInfo = null;
      try { structureInfo = structMatch ? JSON.parse(structMatch[0]) : null; } catch { /* необов'язковий крок */ }

      const methodMsgs = [docPart, { type: "text", text: buildMethodologyReadingPrompt(structureInfo) }];
      const raw = await callGemini([{ role: "user", content: methodMsgs }], null, SYS_JSON_SHORT, 8000, null, "gemini-2.5-flash", true);
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      const parsed = JSON.parse(jsonMatch?.[0] || raw.replace(/```json|```/g, "").trim());
      setMethodInfo(parsed);
    } catch (e) {
      setMethodError("Не вдалося проаналізувати методичку: " + e.message);
    }
    setMethodLoading(false);
  }

  // ── Список правок з анотацій (виділення/коментарі/нотатки кольором) + суто
  // кодова перевірка сторінок у цитатах (без ШІ). Якщо правок немає — одразу
  // відкривається форма ручного вводу. ──
  function loadTasksFromAnnotations(ann, plainText) {
    setAnnotations(ann);
    const newTasks = annotationsToTasks(ann);
    const citationTask = buildCitationPagesTask(plainText);
    if (citationTask) newTasks.push(citationTask);
    const defaultChecked = {};
    newTasks.forEach(t => { defaultChecked[t.id] = true; });
    setTasks(newTasks);
    setChecked(defaultChecked);
    if (!newTasks.length) setManualOpen(true);
  }

  // ── Завантаження файлу: спільна підготовка з воркером — відкрити .docx,
  // прийняти виправлення режиму рецензування, витягти анотації. ──
  async function handleFile(file) {
    if (!file) return;
    setFileLoading(true);
    setError("");
    setTasks([]); setChecked({}); setAnnotations({ highlights: [], comments: [], colorNotes: [] });
    setManualOpen(false); setCorrectionsText(""); setCorrectionPhotos([]);
    orderDocIdRef.current = null; setCorrectionHistory([]); setRevisionsMessage(null);
    try {
      const arrayBuffer = await file.arrayBuffer();
      setExtractLoading(true);
      const prepared = await prepareDocxForCorrections(arrayBuffer);
      if (!prepared.plainText.trim()) throw new Error("Не вдалося витягти текст з документа");
      docStateRef.current = { zip: prepared.zip, docXml: prepared.docXml };
      setFileName(file.name);
      setDocText(prepared.plainText);
      setRevisionsMessage(describeRevisions(prepared.revisions));
      loadTasksFromAnnotations(prepared.annotations, prepared.plainText);
      setStep(1);
    } catch (e) {
      setError("Помилка читання файлу: " + e.message);
    }
    setExtractLoading(false);
    setFileLoading(false);
  }

  // ── Аналіз ручних зауважень — ДОДАЄ нові завдання до вже наявного списку
  // (виявлені виділення/коментарі нікуди не зникають), а не замінює його. ──
  async function doAnalyze() {
    if (!correctionsText.trim() && correctionPhotos.length === 0) return;
    setAnalysisLoading(true);
    setError("");
    try {
      const currentText = docStateRef.current ? refreshTextMap(docStateRef.current.docXml).plainText : docText;
      const manualTasks = await analyzeManualNotes({ docText: currentText, correctionsText, correctionPhotos }, { callClaude });
      const defaultChecked = {};
      manualTasks.forEach(t => { defaultChecked[t.id] = true; });
      setTasks(prev => [...prev, ...manualTasks]);
      setChecked(prev => ({ ...prev, ...defaultChecked }));
      setCorrectionsText("");
      setCorrectionPhotos([]);
    } catch (e) {
      setError("Помилка аналізу: " + e.message);
    }
    setAnalysisLoading(false);
  }

  // Повідомлення про рецензування — лише в першому раунді.
  function withRevisionsMessage(messages) {
    if (!revisionsMessage) return messages;
    setRevisionsMessage(null);
    return [revisionsMessage, ...messages];
  }

  // ── Запис раунду в історію й у Firestore (той самий документ на всю сесію). ──
  async function saveRound({ appliedCount, failedCount, labels }) {
    let updatedHistory = correctionHistory;
    if (appliedCount > 0) {
      const entry = { clientTimestamp: Date.now(), appliedCount, failedCount, mode, labels: labels.filter(Boolean).slice(0, 10) };
      updatedHistory = [...correctionHistory, entry];
      setCorrectionHistory(updatedHistory);
    }
    try {
      const acc = tokenAccRef.current;
      const payload = {
        mode: "file_corrections", type: "file_corrections",
        topic: `Правки: ${fileName}`, uid: user?.uid || null,
        fileName, correctionsApplied: appliedCount, correctionsFailed: failedCount, correctionsMode: mode,
        totalInTok: acc.inTok, totalOutTok: acc.outTok, totalCostUsd: acc.costUsd,
        claudeInTok: acc.claudeInTok, claudeOutTok: acc.claudeOutTok, claudeCostUsd: acc.claudeCostUsd,
        geminiInTok: 0, geminiOutTok: 0, geminiCostUsd: 0, serperCredits: 0, serperCostUsd: 0,
        info: { topic: `Правки: ${fileName}`, orderNumber: null },
        correctionHistory: updatedHistory,
        timestamp: serverTimestamp(),
      };
      if (orderDocIdRef.current) {
        await updateDoc(doc(db, "orders", orderDocIdRef.current), payload);
      } else {
        const ref = await addDoc(collection(db, "orders"), { ...payload, createdAt: new Date().toISOString() });
        orderDocIdRef.current = ref.id;
      }
    } catch { /**/ }
  }

  // Ліміт вартості одного раунду в браузері — той самий лічильник вкладки, що й раніше.
  const uiCostGuard = {
    check() {
      if (getGenerationCost() > GENERATION_COST_LIMIT) {
        const e = new Error(`ліміт $${GENERATION_COST_LIMIT}`);
        e.isCostLimit = true;
        throw e;
      }
    },
  };

  // ── Застосування: звичайний режим (applyCorrectionTasks — спільний з воркером) ──
  async function doApplyClassic() {
    const toFix = tasks.filter(t => checked[t.id] !== false);
    if (!toFix.length) return;
    setApplyLoading(true);
    setApplyProgress(0);
    setError("");
    resetGenerationCost();
    setFailedTasks([]);
    setApplyMessages([]);
    setAppliedChanges([]);
    setApplyVolume(null);
    try {
      const { zip, docXml } = docStateRef.current;
      const result = await applyCorrectionTasks(
        { zip, docXml, tasks: toFix, lang, methodInfo, clientMaterialsSummary },
        { callClaude, costTracker: uiCostGuard, onProgress: setCurrentBatchLabel, onTaskDone: setApplyProgress },
      );
      setCorrectedText(result.correctedText);
      setFailedTasks(result.failed);
      setApplyMessages(withRevisionsMessage(result.messages));
      setAppliedChanges(result.changes);

      // Успішно застосовані завдання — знімаємо чекбокс (щоб повторний "Виправити
      // обрані" не намагався заново виправити вже виправлене); невдалі лишаються
      // позначені, готові до повторної спроби одним кліком.
      const failedIds = new Set(result.failed.map(f => f.task.id));
      setChecked(prev => {
        const next = { ...prev };
        toFix.forEach(t => { next[t.id] = failedIds.has(t.id); });
        return next;
      });
      setStep(3);
      await saveRound({
        appliedCount: result.appliedCount,
        failedCount: result.failed.length,
        labels: toFix.filter(t => !failedIds.has(t.id)).map(t => t.label || t.location || (t.annotatedText || "").slice(0, 40)),
      });
    } catch (e) {
      setError("Помилка виправлення: " + e.message);
    }
    setApplyLoading(false);
    setCurrentBatchLabel("");
  }

  // ── Застосування: агент (runAgentCorrections — спільний з воркером). Бере
  // обрані виділення/коментарі/нотатки, додані вручну зауваження, текст і фото
  // зі форми та умови замовлення (обсяг контролює код). ──
  async function doApplyAgent() {
    setApplyLoading(true);
    setError("");
    resetGenerationCost();
    setFailedTasks([]);
    setApplyMessages([]);
    setAppliedChanges([]);
    setAgentLog([]);
    setApplyVolume(null);
    try {
      const { zip, docXml } = docStateRef.current;
      const selected = {
        highlights: annotations.highlights.filter((_, i) => checked[`h_${i}`] !== false),
        comments: annotations.comments.filter((_, i) => checked[`c_${i}`] !== false),
        colorNotes: (annotations.colorNotes || []).filter((_, i) => checked[`cn_${i}`] !== false),
      };
      const manualLines = tasks
        .filter(t => (t.kind === "manual" || t.kind === "sources_restructure") && checked[t.id] !== false)
        .map(t => `${t.location ? t.location + ": " : ""}${t.issue || ""}${t.suggestion ? ` → ${t.suggestion}` : ""}`);
      const instructions = [correctionsText.trim(), ...manualLines].filter(Boolean).join("\n");
      const result = await runAgentCorrections(
        {
          zip, docXml, annotations: selected, instructions, remarkFiles: correctionPhotos,
          lang, methodInfo, clientMaterialsSummary,
          orderInfo: { ...orderInfo, pages: orderPages.trim() || orderInfo.pages },
        },
        {
          callClaude,
          onProgress: msg => {
            setCurrentBatchLabel(msg);
            setAgentLog(prev => [...prev.slice(-11), msg]);
          },
        },
      );
      const newText = refreshTextMap(docXml).plainText;
      setCorrectedText(newText);
      setFailedTasks(result.failed);
      setApplyMessages(withRevisionsMessage(result.messages));
      setAppliedChanges(result.changes);
      setApplyVolume(result.volume);
      // Список правок — заново з документа: лишаються лише неопрацьовані
      // виділення/коментарі (ручні зауваження вже передано агенту).
      loadTasksFromAnnotations(await extractAnnotationsFromOpenDocx(zip, docXml), newText);
      setCorrectionsText("");
      setCorrectionPhotos([]);
      setStep(3);
      await saveRound({
        appliedCount: result.appliedCount,
        failedCount: result.failed.length,
        labels: result.changes.map(c => c.label),
      });
    } catch (e) {
      setError("Помилка виправлення: " + e.message);
    }
    setApplyLoading(false);
    setCurrentBatchLabel("");
  }

  function toggleAll(val) {
    const next = {};
    tasks.forEach(t => { next[t.id] = val; });
    setChecked(next);
  }

  function resetFile() {
    docStateRef.current = null;
    orderDocIdRef.current = null;
    setStep(0); setFileName(""); setDocText("");
    setAnnotations({ highlights: [], comments: [], colorNotes: [] }); setTasks([]); setChecked({});
    setManualOpen(false); setCorrectionsText(""); setCorrectionPhotos([]);
    setCorrectedText(""); setError(""); setApplyProgress(0); setFailedTasks([]);
    setApplyMessages([]); setAppliedChanges([]); setCorrectionHistory([]);
    setAgentLog([]); setApplyVolume(null); setRevisionsMessage(null);
  }

  function reset() {
    resetFile();
    setContextOpen(false); setSelectedOrderId(""); setMethodInfo(null);
    setMethodFileLabel(""); setMethodError(""); setClientMaterials([]); setClientMaterialsManualText("");
    setLang("Українська");
    setOrderInfo({}); setOrderPages("");
  }

  // ─────────────────────────────────────────────
  // РЕНДЕР
  // ─────────────────────────────────────────────
  return (
    <div style={{ minHeight: "100vh", background: "#f5f2eb", fontFamily: "'Spectral', Georgia, serif", padding: "0 0 60px" }}>
      {/* Хедер */}
      <div style={{ background: "#1a1a14", padding: "14px 24px", display: "flex", alignItems: "center", gap: 14, position: "sticky", top: 0, zIndex: 10 }}>
        <button
          onClick={() => {
            if (step === 0) { onBack(); return; }
            if (step === 1) { resetFile(); return; }
            if (step === 2) { setStep(1); setApplyProgress(0); return; }
            // currentDocText НЕ скидаємо на docText — оригінальний docXml у docStateRef
            // вже незворотно змінено попередніми правками, тож текст має й далі
            // відповідати саме йому, а не давно застарілому вихідному тексту.
            if (step === 3) { setStep(1); setCorrectedText(""); setApplyProgress(0); setFailedTasks([]); setApplyMessages([]); setAppliedChanges([]); setApplyVolume(null); }
          }}
          style={{ background: "none", border: "none", color: "#888", fontSize: 18, cursor: "pointer", lineHeight: 1, padding: 4 }}
        >←</button>
        <div style={{ color: "#e8ff47", fontFamily: "'Spectral SC',serif", fontSize: 14, letterSpacing: 3 }}>ПРАВКИ ДО ФАЙЛУ</div>
        {sessionCost > 0 && <div style={{ marginLeft: "auto", fontSize: 11, color: "#888", fontFamily: "monospace" }}>сесія: ${sessionCost.toFixed(4)}</div>}
      </div>

      <div style={{ maxWidth: 720, margin: "0 auto", padding: "28px 20px 0" }}>
        <StepBar current={step} />

        {error && (
          <div style={{ background: "#fff0f0", border: "1.5px solid #f00a", borderRadius: 8, padding: "10px 16px", marginBottom: 14, fontSize: 13, color: "#c00" }}>
            {error}
          </div>
        )}

        {/* ═══ КРОК 0: Завантаження файлу ═══ */}
        {step === 0 && (
          <>
            <div style={cardStyle}>
              <div style={cardHead()}>
                <div style={dot("#e8ff47")} />
                <div style={labelStyle}>Завантажте вашу роботу (.docx)</div>
              </div>
              <div style={cardBody}>
                <div
                  onClick={() => fileRef.current.click()}
                  onDrop={e => { e.preventDefault(); handleFile(e.dataTransfer.files[0]); }}
                  onDragOver={e => e.preventDefault()}
                  style={{ minHeight: 120, border: "1.5px dashed #c4bfb4", borderRadius: 6, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, cursor: "pointer", background: "#ede9e0" }}
                >
                  {fileLoading || extractLoading
                    ? <><SpinDot /><div style={{ fontSize: 12, color: "#888" }}>{fileLoading ? "Читаю файл..." : "Шукаю виділення та коментарі..."}</div></>
                    : <>
                      <div style={{ fontSize: 32 }}>📄</div>
                      <div style={{ fontSize: 13, color: "#555" }}>Перетягніть або клікніть щоб вибрати .docx</div>
                      <div style={{ fontSize: 11, color: "#aaa" }}>Кольорові виділення й коментарі Word розпізнаються автоматично — якщо їх немає, можна буде додати зауваження вручну</div>
                    </>
                  }
                </div>
                <input ref={fileRef} type="file" accept=".docx" style={{ display: "none" }} onChange={e => handleFile(e.target.files[0])} />
              </div>
            </div>

            {/* Опціональний контекст: методичка / матеріали клієнта / мова — підтягуються
                лише до тих правок, де це дійсно доречно (формат, стиль цитування тощо) */}
            <div style={cardStyle}>
              <div
                onClick={() => { setContextOpen(o => !o); if (!contextOpen) loadMyOrders(); }}
                style={{ ...cardHead("#2a2a1e"), cursor: "pointer", justifyContent: "space-between" }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div style={dot(methodInfo || clientMaterialsSummary ? "#a8e060" : "#666")} />
                  <div style={labelStyle}>Контекст роботи (необов'язково): мова, методичка, матеріали клієнта</div>
                </div>
                <div style={{ color: "#888", fontSize: 12 }}>{contextOpen ? "▲" : "▼"}</div>
              </div>
              {contextOpen && (
                <div style={cardBody}>
                  <div style={{ fontSize: 11, color: "#888", marginBottom: 10, lineHeight: 1.6 }}>
                    Мова впливає на всі виправлення (заборона змішування скриптів). Методичка/матеріали клієнта підтягуються лише для правок, де це доречно — оформлення, цитування, розрахунки.
                  </div>

                  <div style={{ marginBottom: 14 }}>
                    <div style={{ fontSize: 11, color: "#aaa", marginBottom: 6, letterSpacing: 0.5 }}>МОВА РОБОТИ</div>
                    <select
                      value={lang}
                      onChange={e => setLang(e.target.value)}
                      style={{ width: "100%", fontSize: 13, padding: "8px 10px", borderRadius: 6, border: "1px solid #d4cfc4", background: "#f5f2ea", color: "#2a2a1e", fontFamily: "inherit" }}
                    >
                      {LANG_OPTIONS.map(l => <option key={l} value={l}>{l}</option>)}
                    </select>
                  </div>

                  <div style={{ marginBottom: 14 }}>
                    <div style={{ fontSize: 11, color: "#aaa", marginBottom: 6, letterSpacing: 0.5 }}>ЦЯ РОБОТА ЗГЕНЕРОВАНА В ACADEM ASSIST?</div>
                    {myOrdersLoading ? (
                      <div style={{ fontSize: 12, color: "#888", display: "flex", alignItems: "center", gap: 8 }}><SpinDot />Завантажую ваші замовлення...</div>
                    ) : (
                      <select
                        value={selectedOrderId}
                        onChange={e => selectOrder(e.target.value)}
                        style={{ width: "100%", fontSize: 13, padding: "8px 10px", borderRadius: 6, border: "1px solid #d4cfc4", background: "#f5f2ea", color: "#2a2a1e", fontFamily: "inherit" }}
                      >
                        <option value="">— оберіть замовлення, якщо є —</option>
                        {(myOrders || []).map(o => (
                          <option key={o.id} value={o.id}>{o.topic || o.info?.topic || o.id}</option>
                        ))}
                      </select>
                    )}
                    {selectedOrderId && methodInfo && (
                      <div style={{ fontSize: 11, color: "#6a9000", marginTop: 6 }}>✓ Дані методички, матеріалів і мови підтягнуто із замовлення</div>
                    )}
                  </div>

                  <div style={{ marginBottom: 14 }}>
                    <div style={{ fontSize: 11, color: "#aaa", marginBottom: 6, letterSpacing: 0.5 }}>ЗАМОВЛЕНИЙ ОБСЯГ, СТОР. (для режиму агента — він тримає обсяг роботи в цих межах)</div>
                    <input
                      value={orderPages}
                      onChange={e => setOrderPages(e.target.value)}
                      placeholder={orderInfo.pages ? `із замовлення: ${orderInfo.pages}` : "напр. 30-35 (якщо не вказати — ±10% від поточного обсягу)"}
                      style={{ width: "100%", boxSizing: "border-box", fontSize: 13, padding: "8px 10px", borderRadius: 6, border: "1px solid #d4cfc4", background: "#f5f2ea", color: "#2a2a1e", fontFamily: "inherit" }}
                    />
                  </div>

                  <div style={{ marginBottom: 14 }}>
                    <div style={{ fontSize: 11, color: "#aaa", marginBottom: 6, letterSpacing: 0.5 }}>АБО ЗАВАНТАЖТЕ МЕТОДИЧКУ САМІ (PDF або DOCX)</div>
                    <DropZone fileLabel={methodFileLabel} onFile={handleMethodFile} accept=".pdf,.docx" />
                    {methodLoading && <div style={{ fontSize: 12, color: "#888", marginTop: 6, display: "flex", alignItems: "center", gap: 8 }}><SpinDot />Аналізую методичку...</div>}
                    {methodError && <div style={{ fontSize: 12, color: "#c00", marginTop: 6 }}>{methodError}</div>}
                    {methodInfo && !methodLoading && !selectedOrderId && <div style={{ fontSize: 11, color: "#6a9000", marginTop: 6 }}>✓ Методичку проаналізовано</div>}
                  </div>

                  <div>
                    <div style={{ fontSize: 11, color: "#aaa", marginBottom: 6, letterSpacing: 0.5 }}>МАТЕРІАЛИ КЛІЄНТА (необов'язково)</div>
                    <ClientMaterialsZone
                      materials={clientMaterials}
                      onAdd={m => setClientMaterials(prev => [...prev, m])}
                      onRemove={i => setClientMaterials(prev => prev.filter((_, idx) => idx !== i))}
                      manualText={clientMaterialsManualText}
                      onManualText={setClientMaterialsManualText}
                    />
                  </div>
                </div>
              )}
            </div>
          </>
        )}

        {/* ═══ КРОК 1: Список правок (виявлені автоматично + додані вручну) ═══ */}
        {step === 1 && (
          <>
            <div style={{ ...cardStyle, marginBottom: 14 }}>
              <div style={cardHead("#1a2a00")}>
                <div style={dot("#a8e060")} />
                <div style={labelStyle}>Файл завантажено</div>
                <div style={{ marginLeft: "auto", fontSize: 11, color: "#a8e060" }}>{fileName}</div>
              </div>
            </div>

            {/* Режим виправлення: звичайний (кожне завдання окремо) або агент */}
            <div style={{ ...cardStyle, marginBottom: 14 }}>
              <div style={cardHead("#2a2a1e")}>
                <div style={dot(mode === "agent" ? "#e8ff47" : "#a8e060")} />
                <div style={labelStyle}>Режим виправлення</div>
              </div>
              <div style={{ ...cardBody, display: "flex", gap: 8, flexWrap: "wrap" }}>
                {[
                  ["classic", "Звичайний", "Кожне зауваження — окремим завданням. Дешевше, добре для точкових правок."],
                  ["agent", "Агент (як Claude)", "ШІ сам читає й виправляє документ: будь-які зауваження, нові абзаци, узгодженість, контроль обсягу. Дорожче."],
                ].map(([key, title, desc]) => (
                  <button
                    key={key}
                    onClick={() => setMode(key)}
                    style={{ flex: "1 1 240px", textAlign: "left", padding: "10px 14px", borderRadius: 8, border: `2px solid ${mode === key ? "#1a1a14" : "#d4cfc4"}`, background: mode === key ? "#1a1a14" : "#f5f2ea", cursor: "pointer", fontFamily: "inherit" }}
                  >
                    <div style={{ fontSize: 13, fontWeight: 600, color: mode === key ? "#e8ff47" : "#2a2a1e" }}>{title}</div>
                    <div style={{ fontSize: 11, color: mode === key ? "#aaa" : "#888", marginTop: 3, lineHeight: 1.5 }}>{desc}</div>
                  </button>
                ))}
              </div>
            </div>

            {tasks.length > 0 && (
              <div style={{ ...cardStyle, border: "1.5px solid #4a6a00" }}>
                <div style={{ ...cardHead("#1a2a00"), justifyContent: "space-between" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <div style={dot("#a8e060")} />
                    <div style={labelStyle}>
                      Знайдено правок: {tasks.length} ({annotations.highlights.length} виділень, {annotations.comments.length} коментарів{(annotations.colorNotes || []).length ? `, ${annotations.colorNotes.length} нотаток кольором шрифту` : ""}{tasks.some(t => t.kind === "citation_pages") ? ", сторінки в цитатах" : ""}{tasks.some(t => t.kind === "sources_restructure") ? ", перебудова джерел" : ""}{tasks.some(t => t.kind === "manual") ? `, ${tasks.filter(t => t.kind === "manual").length} вручну` : ""})
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button onClick={() => toggleAll(true)} style={{ fontSize: 10, color: "#a8e060", background: "transparent", border: "1px solid #4a6a00", borderRadius: 4, padding: "3px 8px", cursor: "pointer", fontFamily: "inherit" }}>Всі</button>
                    <button onClick={() => toggleAll(false)} style={{ fontSize: 10, color: "#888", background: "transparent", border: "1px solid #444", borderRadius: 4, padding: "3px 8px", cursor: "pointer", fontFamily: "inherit" }}>Жоден</button>
                  </div>
                </div>
                <div style={{ background: "#faf8f3" }}>
                  {tasks.map((task, i) => (
                    <div key={task.id} style={{ borderBottom: i < tasks.length - 1 ? "1px solid #e8e4dc" : "none" }}>
                      <TaskRow task={task} isChecked={checked[task.id] !== false} onToggle={val => setChecked(prev => ({ ...prev, [task.id]: val }))} hasConflict={conflictTaskIds.has(task.id)} />
                    </div>
                  ))}
                </div>
                <div style={{ padding: "12px 16px", background: "#1a2a00", display: "flex", gap: 10, alignItems: "center" }}>
                  <button onClick={() => setStep(2)} disabled={checkedCount === 0} style={btnGreen(checkedCount === 0)}>
                    {mode === "agent" ? `Виправити агентом (${checkedCount}) →` : `Виправити обрані (${checkedCount}) →`}
                  </button>
                </div>
              </div>
            )}

            {/* Ручні зауваження — завжди доступно як доповнення до автоматично знайденого */}
            <div style={cardStyle}>
              <div
                onClick={() => setManualOpen(o => !o)}
                style={{ ...cardHead(), cursor: "pointer", justifyContent: "space-between" }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div style={dot("#e8ff47")} />
                  <div style={labelStyle}>{tasks.length ? "Додати зауваження вручну (необов'язково)" : "Зауваження викладача"}</div>
                </div>
                <div style={{ color: "#888", fontSize: 12 }}>{manualOpen ? "▲" : "▼"}</div>
              </div>
              {manualOpen && (
                <div style={cardBody}>
                  <textarea
                    value={correctionsText}
                    onChange={e => setCorrectionsText(e.target.value)}
                    placeholder={"Вставте зауваження від викладача...\nНаприклад: «Висновки надто короткі. Додай ще одне джерело про X. Прибери застаріле джерело Іванова.»"}
                    style={{ width: "100%", minHeight: 130, fontSize: 13, lineHeight: "1.8", color: "#2a2a1e", background: "#f5f2ea", borderRadius: 6, padding: "12px 14px", border: "1px solid #d4cfc4", fontFamily: "'Spectral',serif", resize: "vertical", boxSizing: "border-box" }}
                  />
                  <div style={{ marginTop: 10 }}>
                    <div style={{ fontSize: 11, color: "#888", marginBottom: 6, letterSpacing: 1 }}>АБО ДОДАЙТЕ ФОТО ЗАУВАЖЕНЬ:</div>
                    <PhotoDropZone
                      photos={correctionPhotos}
                      onAdd={photo => setCorrectionPhotos(prev => [...prev, photo])}
                      onRemove={i => setCorrectionPhotos(prev => prev.filter((_, idx) => idx !== i))}
                    />
                  </div>
                  {mode === "agent" && (
                    <div style={{ marginTop: 10, fontSize: 11, color: "#6a6a5a", lineHeight: 1.6 }}>
                      У режимі агента текст і фото зауважень передаються агенту напряму разом із виділеннями та коментарями з файлу — додавати їх до списку не обов'язково.
                    </div>
                  )}
                  <div style={{ marginTop: 12, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                    {mode === "agent" && (
                      <button onClick={() => setStep(2)} disabled={!correctionsText.trim() && correctionPhotos.length === 0} style={btnGreen(!correctionsText.trim() && correctionPhotos.length === 0)}>
                        Виправити агентом →
                      </button>
                    )}
                    <button onClick={doAnalyze} disabled={analysisLoading || (!correctionsText.trim() && correctionPhotos.length === 0)} style={btnPrimary(analysisLoading || (!correctionsText.trim() && correctionPhotos.length === 0))}>
                      {analysisLoading ? <><SpinDot />Аналізую...</> : "Додати до списку правок →"}
                    </button>
                    {analysisLoading && <span style={{ fontSize: 12, color: "#888" }}>Claude визначає що потрібно виправити</span>}
                  </div>
                </div>
              )}
            </div>

            {/* Історія правок у цій сесії */}
            {correctionHistory.length > 0 && (
              <div style={{ ...cardStyle, marginTop: 14 }}>
                <div style={cardHead()}>
                  <div style={labelStyle}>Історія правок ({correctionHistory.length})</div>
                </div>
                <div style={{ background: "#faf8f3" }}>
                  {[...correctionHistory].reverse().map((entry, i) => (
                    <div key={i} style={{ padding: "10px 16px", borderBottom: i < correctionHistory.length - 1 ? "1px solid #e8e4dc" : "none", display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start" }}>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 12, color: "#2a2a1e" }}>Застосовано: {entry.appliedCount}{entry.failedCount ? `, не вдалось: ${entry.failedCount}` : ""}</div>
                        {entry.labels?.length > 0 && (
                          <div style={{ marginTop: 4, display: "flex", flexWrap: "wrap", gap: 4 }}>
                            {entry.labels.map((l, j) => (
                              <span key={j} style={{ fontSize: 10, background: "#e8f4d8", color: "#3a6010", borderRadius: 4, padding: "2px 7px" }}>{l}</span>
                            ))}
                          </div>
                        )}
                      </div>
                      <div style={{ fontSize: 11, color: "#aaa", whiteSpace: "nowrap" }}>{new Date(entry.clientTimestamp).toLocaleDateString("uk-UA", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <button onClick={resetFile} style={{ background: "none", border: "none", color: "#aaa", fontSize: 12, cursor: "pointer", fontFamily: "inherit", padding: "4px 0", marginTop: 8 }}>
              ← Завантажити інший файл
            </button>
          </>
        )}

        {/* ═══ КРОК 2: Виправлення ═══ */}
        {step === 2 && (
          <>
            <div style={{ ...cardStyle, border: "1.5px solid #4a6a00" }}>
              <div style={cardHead("#1a2a00")}>
                <div style={dot("#a8e060")} />
                <div style={labelStyle}>{mode === "agent" ? "Агент виправляє документ" : `Виправляю ${checkedCount} елементів...`}</div>
              </div>
              {mode === "agent" ? (
                <div style={{ padding: "16px", background: "#faf8f3" }}>
                  <div style={{ fontSize: 12, color: "#6a6a5a", marginBottom: 8, lineHeight: 1.6 }}>
                    Агент читає роботу, виправляє зауваження й перевіряє результат. Великі правки можуть тривати кілька хвилин — не закривайте вкладку.
                  </div>
                  {agentLog.length > 0 && (
                    <div style={{ fontFamily: "monospace", fontSize: 11, color: "#3a6010", background: "#f0ede4", borderRadius: 6, padding: "8px 10px", maxHeight: 180, overflowY: "auto" }}>
                      {agentLog.map((l, i) => <div key={i}>{i === agentLog.length - 1 && applyLoading ? "▸ " : "✓ "}{l}</div>)}
                    </div>
                  )}
                  {!applyLoading && !agentLog.length && <div style={{ fontSize: 13, color: "#3a6010" }}>Готово до виправлення</div>}
                </div>
              ) : (
              <div style={{ padding: "16px", background: "#faf8f3" }}>
                <div style={{ height: 6, borderRadius: 3, background: "#e8e4dc", overflow: "hidden", marginBottom: 12 }}>
                  <div style={{ height: "100%", borderRadius: 3, background: "#a8e060", width: `${Math.round((applyProgress / checkedCount) * 100)}%`, transition: "width 0.4s ease" }} />
                </div>
                <div style={{ fontSize: 13, color: "#3a6010" }}>
                  {applyLoading
                    ? <>Виправляю... ({applyProgress} з {checkedCount}){currentBatchLabel ? <> — <strong>{currentBatchLabel}</strong></> : ""}</>
                    : applyProgress === 0
                      ? "Готово до виправлення"
                      : "Завершено"}
                </div>
              </div>
              )}
              <div style={{ padding: "12px 16px", background: "#1a2a00" }}>
                <button onClick={mode === "agent" ? doApplyAgent : doApplyClassic} disabled={applyLoading} style={btnGreen(applyLoading)}>
                  {applyLoading ? <><SpinDot light />Виправляю...</> : "Почати виправлення →"}
                </button>
              </div>
            </div>
            <button onClick={() => { setStep(1); setApplyProgress(0); }} style={{ background: "none", border: "none", color: "#aaa", fontSize: 12, cursor: "pointer", fontFamily: "inherit", padding: "4px 0" }}>
              ← Назад до списку
            </button>
          </>
        )}

        {/* ═══ КРОК 3: Готово ═══ */}
        {step === 3 && (
          <>
            <div style={{ ...cardStyle, border: "1.5px solid #4a6a00" }}>
              <div style={cardHead("#1a2a00")}>
                <div style={dot("#a8e060")} />
                <div style={labelStyle}>{failedTasks.length ? "Виправлення внесено частково" : "Виправлення внесено"}</div>
              </div>
              <div style={{ ...cardBody, maxHeight: 300, overflowY: "auto" }}>
                <pre style={{ fontSize: 12, color: "#333", whiteSpace: "pre-wrap", margin: 0, fontFamily: "inherit", lineHeight: 1.7 }}>
                  {correctedText.slice(0, 1200)}{correctedText.length > 1200 ? "\n\n...[решта документа]" : ""}
                </pre>
              </div>
            </div>

            {applyVolume && (
              <div style={{ marginTop: 14, fontSize: 12, color: "#3a6010", background: "#eef5e0", borderRadius: 8, padding: "10px 16px", lineHeight: 1.6 }}>
                Обсяг основної частини: {applyVolume.before} → {applyVolume.after} слів (≈{Math.round(applyVolume.before / 230)} → {Math.round(applyVolume.after / 230)} стор.; допустимо {applyVolume.lo}–{applyVolume.hi}{applyVolume.fromOrder ? ", з урахуванням замовлення" : ""})
              </div>
            )}

            {applyMessages.length > 0 && (
              <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 8 }}>
                {applyMessages.map((msg, i) => (
                  <div key={i} style={{ border: `1.5px solid ${msg.type === "error" ? "#c04020" : "#4a6a00"}`, borderRadius: 8, padding: "11px 16px", background: msg.type === "error" ? "#2a1410" : "#1a2a00", display: "flex", gap: 10 }}>
                    <div style={{ width: 8, height: 8, borderRadius: "50%", marginTop: 4, background: msg.type === "error" ? "#e07050" : "#a8e060", flexShrink: 0 }} />
                    <div style={{ fontSize: 12.5, lineHeight: 1.6, color: "#f5f2eb" }}>{msg.text}</div>
                  </div>
                ))}
              </div>
            )}

            {appliedChanges.length > 0 && (
              <div style={{ ...cardStyle, border: "1.5px solid #4a6a00", marginTop: 14 }}>
                <div style={cardHead("#1a2a00")}>
                  <div style={dot("#a8e060")} />
                  <div style={labelStyle}>Приклади застосованих правок ({appliedChanges.length})</div>
                </div>
                <div style={{ background: "#faf8f3", maxHeight: 320, overflowY: "auto" }}>
                  {appliedChanges.map((c, i) => (
                    <div key={i} style={{ padding: "12px 16px", borderBottom: i < appliedChanges.length - 1 ? "1px solid #e8e4dc" : "none" }}>
                      <div style={{ fontSize: 11, color: "#7a5a2a", fontWeight: 600, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>{c.label}</div>
                      <div style={{ fontSize: 12, color: "#c04020", marginBottom: 3 }}>
                        <span style={{ fontWeight: 600 }}>Було:</span> «{(c.original || "").slice(0, 160)}{(c.original || "").length > 160 ? "..." : ""}»
                      </div>
                      <div style={{ fontSize: 12, color: "#3a6010" }}>
                        <span style={{ fontWeight: 600 }}>Стало:</span> {c.replacement ? `«${c.replacement.slice(0, 160)}${c.replacement.length > 160 ? "..." : ""}»` : "(фрагмент видалено)"}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {failedTasks.length > 0 && (
              <div style={{ ...cardStyle, border: "1.5px solid #a04a1a", marginTop: 14 }}>
                <div style={cardHead("#3a1a0a")}>
                  <div style={dot("#e8a060")} />
                  <div style={labelStyle}>Не вдалося виправити автоматично ({failedTasks.length}) — перевірте вручну</div>
                </div>
                <div style={{ background: "#faf8f3" }}>
                  {failedTasks.map(({ task, reason }, i) => (
                    <div key={i} style={{ padding: "12px 16px", borderBottom: i < failedTasks.length - 1 ? "1px solid #e8e4dc" : "none" }}>
                      <div style={{ fontSize: 12, color: "#c04020", fontStyle: "italic", marginBottom: 3 }}>
                        «{(task.annotatedText || task.issue || task.location || task.label || "").slice(0, 140)}»
                      </div>
                      <div style={{ fontSize: 12, color: "#a04a1a" }}><span style={{ fontWeight: 600 }}>Причина:</span> {reason}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 14 }}>
              <button
                onClick={async () => {
                  const blob = await finalizeCorrectedDocx(docStateRef.current.zip, docStateRef.current.docXml);
                  downloadDocxBlob(blob, fileName);
                }}
                style={btnGreen(false)}
              >
                Завантажити виправлений .docx
              </button>
              <button
                onClick={() => { setStep(1); setApplyProgress(0); setCorrectedText(""); setFailedTasks([]); setApplyMessages([]); setAppliedChanges([]); setApplyVolume(null); }}
                style={{ ...btnPrimary(false), background: "transparent", color: "#555", border: "1px solid #ccc" }}
              >
                Внести ще правки
              </button>
              <button onClick={reset} style={{ background: "none", border: "none", color: "#aaa", fontSize: 12, cursor: "pointer", fontFamily: "inherit", alignSelf: "center" }}>
                Новий файл
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
