import { useState, useRef } from "react";
import mammoth from "mammoth";
import { CODE_FILE_EXTENSIONS } from "../lib/planUtils.js";
import { callClaude, MODEL_FAST } from "../lib/api.js";
import { extractPdfText, extractPdfPageImages } from "../lib/pdfImages.js";
import { extractDocxTextWithNumbering } from "../lib/docxListNumbers.js";
import { looksLikeReadyPart } from "../lib/readyWorkExtract.js";

const MAX_FILES = 70;
const MAX_TEXT_CHARS = 50000;
const OCR_PAGE_LIMIT = 20;
const CODE_ACCEPT = CODE_FILE_EXTENSIONS.join(",");

const EXTRACT_IMAGE_PROMPT = "Transcribe all text, data and content visible in this image exactly as it appears (headings, tables, numbers, notes). Return only the plain text content, no explanations.";
const EXTRACT_SCAN_PROMPT = "Transcribe all text from these page images exactly as it appears — headings, tables, numbers, notes, structure. Return only the plain text content, no explanations.";

const XLSX_CDN = "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js";

// onReadyWorkFile/clientPlan (необов'язково) — якщо .docx, кинутий у матеріали, схожий на
// готову частину роботи, пропонуємо перенести його в зону «Готова частина» (кейс 41476).
export function ClientMaterialsZone({ materials, onAdd, onRemove, manualText, onManualText, onReadyWorkFile, clientPlan }) {
  const fileRef = useRef();
  const [dragging, setDragging] = useState(false);
  const [extracting, setExtracting] = useState(false);

  async function loadXlsx() {
    if (window.XLSX) return window.XLSX;
    await new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = XLSX_CDN; s.onload = resolve; s.onerror = reject;
      document.head.appendChild(s);
    });
    return window.XLSX;
  }

  async function extractXlsxText(arrayBuffer) {
    const XLSX = await loadXlsx();
    const wb = XLSX.read(arrayBuffer, { type: "array" });
    const parts = [];
    for (const sheetName of wb.SheetNames) {
      const ws = wb.Sheets[sheetName];
      const csv = XLSX.utils.sheet_to_csv(ws, { blankrows: false });
      if (!csv.trim()) continue;
      // Конвертуємо CSV → markdown-таблицю
      const rows = csv.split("\n").filter(r => r.trim());
      const mdRows = rows.map((r, i) => {
        const cells = r.split(",").map(c => c.trim().replace(/^"|"$/g, ""));
        const line = "| " + cells.join(" | ") + " |";
        if (i === 0) return line + "\n|" + cells.map(() => "---").join("|") + "|";
        return line;
      });
      parts.push(`=== Аркуш: ${sheetName} ===\n${mdRows.join("\n")}`);
    }
    return parts.join("\n\n").slice(0, MAX_TEXT_CHARS);
  }

  // Скановані/фото-PDF не мають текстового шару (pdf.js поверне порожній рядок) —
  // тоді рендеримо сторінки в зображення і розпізнаємо текст через Claude vision.
  async function extractPdfViaOcr(b64) {
    const images = await extractPdfPageImages(b64, { maxDim: 1400, quality: 0.85 });
    const pageParts = images.slice(0, OCR_PAGE_LIMIT).filter(Boolean)
      .map(img => ({ type: "image", source: { type: "base64", media_type: img.type, data: img.b64 } }));
    if (!pageParts.length) throw new Error("не вдалося прочитати жодної сторінки");
    const raw = await callClaude([{
      role: "user", content: [...pageParts, { type: "text", text: EXTRACT_SCAN_PROMPT }],
    }], null, "Return only plain text, no markdown.", 6000, null, MODEL_FAST);
    return raw.trim();
  }

  async function extractImageText(b64, mediaType) {
    const raw = await callClaude([{
      role: "user", content: [
        { type: "image", source: { type: "base64", media_type: mediaType, data: b64 } },
        { type: "text", text: EXTRACT_IMAGE_PROMPT },
      ],
    }], null, "Return only plain text, no markdown.", 800, null, MODEL_FAST);
    return raw.trim().slice(0, MAX_TEXT_CHARS);
  }

  async function processFiles(files) {
    const remaining = MAX_FILES - materials.length;
    const toProcess = Array.from(files).slice(0, remaining);
    if (!toProcess.length) return;
    setExtracting(true);
    for (const f of toProcess) {
      try {
        const isCode = CODE_FILE_EXTENSIONS.some(ext => f.name.toLowerCase().endsWith(ext));
        const isText = f.type === "text/plain" || f.name.endsWith(".txt") || f.name.endsWith(".csv") || isCode;
        const isPdf = f.type === "application/pdf" || f.name.endsWith(".pdf");
        const isXlsx = f.name.endsWith(".xlsx") || f.name.endsWith(".xls") ||
          f.type === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
          f.type === "application/vnd.ms-excel";
        const isXml = f.name.endsWith(".xml") || f.type === "text/xml" || f.type === "application/xml";
        const isDocx = f.name.toLowerCase().endsWith(".docx") ||
          f.type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
        const isImage = f.type.startsWith("image/");

        if (isImage) {
          const b64 = await new Promise((res, rej) => {
            const r = new FileReader();
            r.onload = ev => res(ev.target.result.split(",")[1]);
            r.onerror = rej;
            r.readAsDataURL(f);
          });
          const text = await extractImageText(b64, f.type);
          onAdd({ name: f.name, text });
        } else if (isText || isXml) {
          const text = await new Promise((res, rej) => {
            const r = new FileReader();
            r.onload = ev => res(ev.target.result.slice(0, MAX_TEXT_CHARS));
            r.onerror = rej;
            r.readAsText(f, "utf-8");
          });
          onAdd({ name: f.name, text });
        } else if (isPdf) {
          const b64 = await new Promise((res, rej) => {
            const r = new FileReader();
            r.onload = ev => res(ev.target.result.split(",")[1]);
            r.onerror = rej;
            r.readAsDataURL(f);
          });
          let text = "";
          try { text = await extractPdfText(b64, 200); } catch (e) { console.warn("pdf text layer read failed:", e.message); }
          if (!text || text.trim().length < 30) text = await extractPdfViaOcr(b64);
          onAdd({ name: f.name, text: text.trim().slice(0, MAX_TEXT_CHARS) });
        } else if (isDocx) {
          const arrayBuffer = await new Promise((res, rej) => {
            const r = new FileReader();
            r.onload = ev => res(ev.target.result);
            r.onerror = rej;
            r.readAsArrayBuffer(f);
          });
          if (onReadyWorkFile) {
            const fullText = await extractDocxTextWithNumbering(arrayBuffer.slice(0));
            if (looksLikeReadyPart(fullText, clientPlan, { allowWithoutPlan: true })
              && window.confirm(`Файл «${f.name}» схожий на готову частину роботи (є пронумеровані підрозділи). Завантажити його як «Готову частину роботи»? Тоді текст увійде в роботу як є, а не буде переписаний.`)) {
              onReadyWorkFile(arrayBuffer, f.name);
              continue;
            }
          }
          const result = await mammoth.extractRawText({ arrayBuffer });
          onAdd({ name: f.name, text: result.value.trim().slice(0, MAX_TEXT_CHARS) });
        } else if (isXlsx) {
          const arrayBuffer = await new Promise((res, rej) => {
            const r = new FileReader();
            r.onload = ev => res(ev.target.result);
            r.onerror = rej;
            r.readAsArrayBuffer(f);
          });
          const text = await extractXlsxText(arrayBuffer);
          onAdd({ name: f.name, text });
        }
      } catch (e) {
        console.warn("ClientMaterialsZone: failed to process", f.name, e.message);
      }
    }
    setExtracting(false);
  }

  const canAdd = materials.length < MAX_FILES;

  return (
    <div>
      <div style={{ display: "flex", gap: 10, alignItems: "stretch" }}>
        <textarea
          value={manualText}
          onChange={e => onManualText(e.target.value)}
          placeholder="Або вставте текст вручну — власні напрацювання, дані дослідження, таблиці..."
          style={{
            flex: 1, minWidth: 0, minHeight: 64,
            background: "#f0ece2", border: "1.5px solid #d4cfc4", borderRadius: 6,
            color: "#1a1a14", fontSize: 13, padding: "10px 12px",
            resize: "vertical", lineHeight: 1.7, fontFamily: "'Spectral',Georgia,serif",
          }}
        />

        <div
          onClick={() => canAdd && fileRef.current.click()}
          onDrop={e => { e.preventDefault(); setDragging(false); if (canAdd) processFiles(e.dataTransfer.files); }}
          onDragOver={e => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          style={{
            flex: 1, minWidth: 0, minHeight: 64,
            border: `1.5px dashed ${dragging && canAdd ? "#1a1a14" : "#c4bfb4"}`,
            borderRadius: 6,
            display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
            gap: 4, cursor: canAdd ? "pointer" : "default",
            padding: 12, background: dragging && canAdd ? "#e8e4d8" : "#ede9e0", transition: "all .2s",
          }}
        >
          <div style={{ fontSize: 20 }}>{extracting ? "⏳" : "📎"}</div>
          <div style={{ fontSize: 12, color: "#888", textAlign: "center" }}>
            {extracting
              ? "Витягую текст..."
              : canAdd
                ? `Перетягніть або клікніть — PDF, DOCX, TXT, CSV, XLSX, XML, фото, файли коду (${materials.length}/${MAX_FILES})`
                : `Максимум ${MAX_FILES} файлів завантажено`}
          </div>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept={`.pdf,.docx,.txt,.csv,.xlsx,.xls,.xml,image/*,text/plain,application/pdf,text/csv,text/xml,application/xml,${CODE_ACCEPT}`}
          multiple
          style={{ display: "none" }}
          onChange={e => { processFiles(e.target.files); e.target.value = ""; }}
        />
      </div>

      {materials.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
          {materials.map((m, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 5, background: "#e0dbd0", borderRadius: 4, padding: "3px 8px", fontSize: 12, color: "#333" }}>
              <span>📄 {m.name}</span>
              <span style={{ color: "#999", fontSize: 10 }}>({Math.round(m.text.length / 1000)}k)</span>
              <button
                onClick={() => onRemove(i)}
                style={{ background: "none", border: "none", cursor: "pointer", color: "#8a1a1a", fontSize: 14, lineHeight: 1, padding: "0 2px" }}
              >×</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
