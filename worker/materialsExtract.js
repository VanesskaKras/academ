// Витягування тексту з файлів client_materials/ready_part/client_plan (CRM
// contract §4) — Node-порт того самого алгоритму, що ClientMaterialsZone.jsx
// у браузері (той самий вибір бібліотек: pdf.js для текстового шару PDF +
// ШІ-OCR для сканів, mammoth для docx, SheetJS для xlsx, Claude vision для
// фото). Джерело байтів тут — вже довантажений Buffer, а не File/FileReader.
//
// Цей файл ніколи не імпортується з src/ (лише з worker/*.js), тож Vite його
// взагалі не бачить — статичні імпорти canvas/pdfjs-dist/xlsx безпечні, на
// відміну від exportDocx.js, де ті самі пакети доводиться ізолювати динамічним
// імпортом під /* @vite-ignore */.
import mammoth from "mammoth";
import { extractDocxTextWithNumbering } from "../src/lib/docxListNumbers.js";
import * as XLSX from "xlsx";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { createCanvas } from "canvas";
import { callClaude, MODEL_FAST } from "../src/lib/api.js";
import { CODE_FILE_EXTENSIONS } from "../src/lib/planUtils.js";

const MAX_TEXT_CHARS = 50000;
const OCR_PAGE_LIMIT = 20;
const PDF_TEXT_MAX_PAGES = 200;

const EXTRACT_IMAGE_PROMPT = "Transcribe all text, data and content visible in this image exactly as it appears (headings, tables, numbers, notes). Return only the plain text content, no explanations.";
const EXTRACT_SCAN_PROMPT = "Transcribe all text from these page images exactly as it appears — headings, tables, numbers, notes, structure. Return only the plain text content, no explanations.";

async function extractPdfTextLayer(buffer) {
  const doc = await getDocument({ data: new Uint8Array(buffer) }).promise;
  const numPages = Math.min(doc.numPages, PDF_TEXT_MAX_PAGES);
  const pageTexts = [];
  for (let i = 1; i <= numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const text = content.items.map(it => it.str).join(" ").trim();
    if (text) pageTexts.push(text);
  }
  return pageTexts.join("\n");
}

// Скановані/фото-PDF не мають текстового шару — рендеримо сторінки в
// зображення (node-canvas) і розпізнаємо текст через Claude vision.
async function extractPdfPageImages(buffer, { maxDim = 1400, quality = 0.85, maxPages = OCR_PAGE_LIMIT } = {}) {
  const doc = await getDocument({ data: new Uint8Array(buffer) }).promise;
  const numPages = Math.min(doc.numPages, maxPages);
  const results = [];
  for (let i = 1; i <= numPages; i++) {
    try {
      const page = await doc.getPage(i);
      const baseViewport = page.getViewport({ scale: 1 });
      const scale = maxDim / Math.max(baseViewport.width, baseViewport.height);
      const viewport = page.getViewport({ scale });
      const canvas = createCanvas(Math.round(viewport.width), Math.round(viewport.height));
      const ctx = canvas.getContext("2d");
      await page.render({ canvasContext: ctx, viewport }).promise;
      results.push({ b64: canvas.toDataURL("image/jpeg", quality).split(",")[1], type: "image/jpeg" });
    } catch {
      results.push(null);
    }
  }
  return results;
}

async function extractPdfViaOcr(buffer, opts) {
  const images = await extractPdfPageImages(buffer);
  const pageParts = images.filter(Boolean).map(img => ({ type: "image", source: { type: "base64", media_type: img.type, data: img.b64 } }));
  if (!pageParts.length) throw new Error("не вдалося прочитати жодної сторінки");
  const raw = await callClaude(
    [{ role: "user", content: [...pageParts, { type: "text", text: EXTRACT_SCAN_PROMPT }] }],
    null, "Return only plain text, no markdown.", 6000, null, MODEL_FAST, opts
  );
  return raw.trim();
}

async function extractImageText(buffer, mediaType, opts) {
  const raw = await callClaude(
    [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: mediaType, data: buffer.toString("base64") } }, { type: "text", text: EXTRACT_IMAGE_PROMPT }] }],
    null, "Return only plain text, no markdown.", 800, null, MODEL_FAST, opts
  );
  return raw.trim().slice(0, MAX_TEXT_CHARS);
}

function extractXlsxText(buffer) {
  const wb = XLSX.read(buffer, { type: "buffer" });
  const parts = [];
  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    const csv = XLSX.utils.sheet_to_csv(ws, { blankrows: false });
    if (!csv.trim()) continue;
    const rows = csv.split("\n").filter(r => r.trim());
    const mdRows = rows.map((r, i) => {
      const cells = r.split(",").map(c => c.trim().replace(/^"|"$/g, ""));
      const line = "| " + cells.join(" | ") + " |";
      return i === 0 ? line + "\n|" + cells.map(() => "---").join("|") + "|" : line;
    });
    parts.push(`=== Аркуш: ${sheetName} ===\n${mdRows.join("\n")}`);
  }
  return parts.join("\n\n").slice(0, MAX_TEXT_CHARS);
}

/**
 * Витягує текст з одного файлу — та сама класифікація за назвою/mime, що й
 * ClientMaterialsZone.jsx. Повертає порожній рядок для нерозпізнаного типу
 * (виклик має сам вирішити, пропускати такий файл чи ні).
 * @param {{name: string, mime?: string, buffer: Buffer, maxChars?: number, withListNumbers?: boolean}} file
 * @param {{costTracker?: object, onCost?: Function}} [opts] - лише для гілок
 *   із ШІ (фото, скановані PDF) — той самий костТрекер/onCost, що передається
 *   в callClaude деінде, щоб ці виклики теж рахувались у ORDER_COST_LIMIT job.
 * @returns {Promise<string>}
 */
export async function extractFileText({ name, mime = "", buffer, maxChars = MAX_TEXT_CHARS, withListNumbers = false }, opts) {
  const lower = name.toLowerCase();
  const isCode = CODE_FILE_EXTENSIONS.some(ext => lower.endsWith(ext));
  const isText = mime === "text/plain" || lower.endsWith(".txt") || lower.endsWith(".csv") || isCode;
  const isPdf = mime === "application/pdf" || lower.endsWith(".pdf");
  const isXlsx = lower.endsWith(".xlsx") || lower.endsWith(".xls") ||
    mime === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" || mime === "application/vnd.ms-excel";
  const isXml = lower.endsWith(".xml") || mime === "text/xml" || mime === "application/xml";
  const isDocx = lower.endsWith(".docx") || mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  const isImage = mime.startsWith("image/");

  if (isImage) return extractImageText(buffer, mime, opts);
  if (isText || isXml) return buffer.toString("utf-8").slice(0, maxChars);
  if (isPdf) {
    let text = "";
    try { text = await extractPdfTextLayer(buffer); } catch (e) { console.warn(`extractFileText(${name}): pdf text layer read failed:`, e.message); }
    if (!text || text.trim().length < 30) text = await extractPdfViaOcr(buffer, opts);
    return text.trim().slice(0, maxChars);
  }
  if (isDocx) {
    // withListNumbers — для плану й готової частини: номери автонумерації Word (1.1., 1.1.1)
    // mammoth сам не віддає, і пункти плану приклеювались до назви розділу (кейс 41476)
    const text = withListNumbers ? await extractDocxTextWithNumbering(buffer) : (await mammoth.extractRawText({ buffer })).value;
    return text.trim().slice(0, maxChars);
  }
  if (isXlsx) return extractXlsxText(buffer);
  return "";
}
