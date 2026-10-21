import { useState, useRef, useMemo } from "react";
import { extractDocxTextWithNumbering } from "../lib/docxListNumbers.js";
import { callClaude, MODEL_FAST } from "../lib/api.js";
import { extractPdfText, extractPdfPageImages } from "../lib/pdfImages.js";
import { extractPlanBlock, checkPlanIssues } from "../lib/planUtils.js";

const EXTRACT_PLAN_PROMPT = "Extract the table of contents / plan from this text. Copy all lines exactly as they appear (chapter numbers, subsection numbers, titles). Return only the plain text of the plan, no explanations. If no clear plan/table of contents is present, return the original text unchanged.";
const EXTRACT_PLAN_IMAGE_PROMPT = "Extract the table of contents / plan from this image. Copy all lines exactly as they appear (chapter numbers, subsection numbers, titles). Return only the plain text of the plan, no explanations.";

function arrayBufferToBase64(buf) {
  let binary = "";
  const bytes = new Uint8Array(buf);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return btoa(binary);
}

// ── Спільне для PDF (текстовий шар) і .docx: уже маємо сирий текст файлу, ШІ лише
// вичленовує з нього сам план/зміст (файл може містити й інший вміст навколо) —
// сама розбивка плану на розділи/підрозділи лишається за parseClientPlan (код). ──
async function extractPlanFromText(text) {
  const raw = await callClaude([{
    role: "user", content: `${EXTRACT_PLAN_PROMPT}\n\nTEXT:\n${text.slice(0, 20000)}`,
  }], null, "Return only plain text, no markdown.", 800, null, MODEL_FAST);
  return raw.trim();
}

export function ClientPlanInput({ onExtracted, extracted, topic }) {
  const fileRef = useRef();
  const [extracting, setExtracting] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [previewSrc, setPreviewSrc] = useState(null);
  const [fileLabel, setFileLabel] = useState("");

  const planBlock = useMemo(() => extracted?.trim() ? extractPlanBlock(extracted).trim() : "", [extracted]);
  const issues = useMemo(() => planBlock ? checkPlanIssues(planBlock, { topic }) : [], [planBlock, topic]);
  const hasExtraText = !!planBlock && planBlock !== extracted.trim();

  // Текст файлу → план через ШІ (вичленовує план з сирого тексту, файл може містити й інше).
  async function applyFileText(text) {
    onExtracted(await extractPlanFromText(text));
  }

  async function handlePhoto(file) {
    setExtracting(true);
    setFileLabel("");
    try {
      const b64 = await new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = e => { setPreviewSrc(e.target.result); res(e.target.result.split(",")[1]); };
        r.onerror = rej;
        r.readAsDataURL(file);
      });
      const raw = await callClaude([{
        role: "user", content: [
          { type: "image", source: { type: "base64", media_type: file.type, data: b64 } },
          { type: "text", text: EXTRACT_PLAN_IMAGE_PROMPT },
        ],
      }], null, "Return only plain text, no markdown.", 800, null, MODEL_FAST);
      onExtracted(raw.trim());
    } catch (e) {
      console.warn("plan photo extract failed:", e.message);
      alert("Не вдалося розпізнати план з фото: " + e.message);
    } finally {
      setExtracting(false);
      setDragging(false);
    }
  }

  // ── PDF: спершу пробуємо текстовий шар напряму (pdf.js, без ШІ) — типовий випадок
  // для PDF, збереженого з текстового документа. Якщо шару нема (скан/фото-PDF) —
  // фолбек на перші сторінки як зображення через те саме ШІ-розпізнавання, що й фото. ──
  async function handlePdf(file) {
    setExtracting(true);
    setPreviewSrc(null);
    setFileLabel(file.name);
    try {
      const buf = await file.arrayBuffer();
      const b64 = arrayBufferToBase64(buf);
      let text = "";
      try { text = await extractPdfText(b64); } catch (e) { console.warn("pdf text layer read failed:", e.message); }
      if (text && text.trim().length > 30) {
        await applyFileText(text);
      } else {
        const images = await extractPdfPageImages(b64, { maxDim: 1400, quality: 0.85 });
        const pageParts = images.slice(0, 3).filter(Boolean).map(img => ({ type: "image", source: { type: "base64", media_type: img.type, data: img.b64 } }));
        if (!pageParts.length) throw new Error("не вдалося прочитати жодної сторінки");
        const raw = await callClaude([{
          role: "user", content: [...pageParts, { type: "text", text: EXTRACT_PLAN_IMAGE_PROMPT.replace("this image", "these page images") }],
        }], null, "Return only plain text, no markdown.", 800, null, MODEL_FAST);
        onExtracted(raw.trim());
      }
    } catch (e) {
      console.warn("plan pdf extract failed:", e.message);
      alert("Не вдалося розпізнати план з PDF: " + e.message);
    } finally {
      setExtracting(false);
      setDragging(false);
    }
  }

  async function handleDocx(file) {
    setExtracting(true);
    setPreviewSrc(null);
    setFileLabel(file.name);
    try {
      const buf = await file.arrayBuffer();
      // з номерами автонумерації Word: "1.1."/"1.1.1", набрані списком, mammoth сам губить (кейс 41476)
      const text = (await extractDocxTextWithNumbering(buf)).trim();
      if (!text) throw new Error("порожній документ");
      await applyFileText(text);
    } catch (e) {
      console.warn("plan docx extract failed:", e.message);
      alert("Не вдалося розпізнати план з .docx: " + e.message);
    } finally {
      setExtracting(false);
      setDragging(false);
    }
  }

  function handleFile(file) {
    if (!file || extracting) return;
    if (file.type.startsWith("image/")) return handlePhoto(file);
    const name = file.name.toLowerCase();
    if (file.type === "application/pdf" || name.endsWith(".pdf")) return handlePdf(file);
    if (name.endsWith(".docx") || file.type.includes("wordprocessingml")) return handleDocx(file);
    alert("Непідтримуваний формат. Підтримуються: фото/зображення, PDF, .docx");
  }

  function onDrop(e) {
    e.preventDefault();
    handleFile(e.dataTransfer.files[0]);
  }

  const done = !extracting && extracted && (previewSrc || fileLabel);

  return <>
    <div
      onClick={() => !extracting && fileRef.current.click()}
      onDrop={onDrop}
      onDragOver={e => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      style={{ minHeight: 90, border: `1.5px dashed ${dragging ? "#5a8a30" : "#c4bfb4"}`, borderRadius: 6, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 6, cursor: extracting ? "wait" : "pointer", padding: 14, background: dragging ? "#e8e4d8" : "#ede9e0", transition: "all .2s" }}
    >
      {extracting
        ? <><div style={{ fontSize: 22 }}>⏳</div><div style={{ fontSize: 12, color: "#888" }}>Розпізнаю план...</div></>
        : done
          ? <>
              {previewSrc
                ? <img src={previewSrc} alt="" style={{ maxHeight: 56, maxWidth: "100%", borderRadius: 4, objectFit: "contain" }} />
                : <div style={{ fontSize: 22 }}>📄</div>}
              {fileLabel && <div style={{ fontSize: 11, color: "#555" }}>{fileLabel}</div>}
              <div style={{ fontSize: 11, color: "#5a8a30" }}>✓ План розпізнано</div>
              <div style={{ fontSize: 10, color: "#aaa" }}>(клікніть щоб замінити)</div>
            </>
          : <><div style={{ fontSize: 22 }}>📎</div><div style={{ fontSize: 12, color: "#888", textAlign: "center" }}>Перетягніть або клікніть — фото, PDF чи .docx плану</div></>
      }
    </div>
    <input ref={fileRef} type="file" accept="image/*,.pdf,application/pdf,.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document" style={{ display: "none" }}
      onChange={e => { handleFile(e.target.files[0]); e.target.value = ""; }} />
    {!extracting && (issues.length > 0 || hasExtraText) && (
      <div style={{ marginTop: 8, padding: "8px 10px", borderRadius: 6, background: issues.length ? "#fdf3e1" : "#eef4e6", border: `1px solid ${issues.length ? "#e0b860" : "#b8d098"}`, fontSize: 11, lineHeight: 1.5, color: "#555" }}>
        {hasExtraText && <div>У тексті є не лише план — у роботу піде тільки план.{" "}
          <span onClick={() => onExtracted(planBlock)} style={{ color: "#5a8a30", cursor: "pointer", textDecoration: "underline" }}>Залишити лише план</span></div>}
        {issues.map((t, i) => <div key={i} style={{ color: "#8a5a10" }}>⚠ {t}</div>)}
      </div>
    )}
  </>;
}
