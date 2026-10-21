import { useState, useRef } from "react";
import mammoth from "mammoth";
import { callClaude, MODEL_FAST } from "../lib/api.js";
import { extractPdfText, extractPdfPageImages } from "../lib/pdfImages.js";

const MAX_TEXT_CHARS = 50000;
const OCR_PAGE_LIMIT = 20;

const EXTRACT_SCAN_PROMPT = "Transcribe all text from these page images exactly as it appears — headings, chapter/section titles and numbering, paragraph text. Preserve the original structure and line breaks between paragraphs and headings so the document's real division into parts stays visible. Return only the plain text content, no explanations, no markdown.";

// Односайлова зона: приймає .docx (mammoth) або .pdf, одразу витягує текст і повертає
// його через onExtracted — сирі байти файлу нікуди не зберігаються.
export function ExampleFileZone({ hint, fileName, onExtracted }) {
  const fileRef = useRef();
  const [dragging, setDragging] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [error, setError] = useState("");

  // Скановані/фото-PDF не мають текстового шару (pdf.js поверне порожній рядок) —
  // тоді рендеримо сторінки в зображення і розпізнаємо текст через Claude vision,
  // інакше зразок структури мовчки залишається порожнім і губиться пріоритет над методичкою.
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

  async function processFile(f) {
    const name = f.name.toLowerCase();
    const isDocx = name.endsWith(".docx") ||
      f.type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    const isPdf = name.endsWith(".pdf") || f.type === "application/pdf";
    if (!isDocx && !isPdf) {
      setError("Підтримуються лише .docx та .pdf. Якщо файл .doc — спершу збережіть його як .pdf.");
      return;
    }
    setError("");
    setExtracting(true);
    try {
      let text;
      if (isDocx) {
        const arrayBuffer = await f.arrayBuffer();
        const result = await mammoth.extractRawText({ arrayBuffer });
        text = result.value.trim();
      } else {
        const b64 = await new Promise((res, rej) => {
          const r = new FileReader();
          r.onload = ev => res(ev.target.result.split(",")[1]);
          r.onerror = rej;
          r.readAsDataURL(f);
        });
        try { text = await extractPdfText(b64, 200); } catch (e) { console.warn("pdf text layer read failed:", e.message); text = ""; }
        if (!text || text.trim().length < 30) text = await extractPdfViaOcr(b64);
      }
      onExtracted(f.name, text.slice(0, MAX_TEXT_CHARS));
    } catch (e) {
      setError("Не вдалось прочитати файл: " + e.message);
    }
    setExtracting(false);
  }

  return (
    <div>
      <div
        onClick={() => fileRef.current.click()}
        onDrop={e => { e.preventDefault(); setDragging(false); const f = e.dataTransfer.files[0]; if (f) processFile(f); }}
        onDragOver={e => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        style={{
          minHeight: 64, border: `1.5px dashed ${dragging ? "#1a1a14" : "#c4bfb4"}`,
          borderRadius: 6, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
          gap: 4, cursor: "pointer", padding: 12, background: dragging ? "#e8e4d8" : "#ede9e0", transition: "all .2s",
        }}
      >
        <div style={{ fontSize: 20 }}>{extracting ? "⏳" : fileName ? "📄" : "⬆️"}</div>
        <div style={{ fontSize: 12, color: "#888", textAlign: "center" }}>
          {extracting
            ? "Витягую текст..."
            : fileName
              ? `${fileName} (клікніть щоб замінити)`
              : (hint || "Перетягніть або клікніть — .docx, .pdf")}
        </div>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept=".docx,.pdf,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        style={{ display: "none" }}
        onChange={e => { const f = e.target.files[0]; if (f) processFile(f); e.target.value = ""; }}
      />
      {error && <div style={{ color: "#c55", fontSize: 11, marginTop: 4 }}>{error}</div>}
    </div>
  );
}
