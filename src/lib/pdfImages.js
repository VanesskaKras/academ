import * as pdfjsLib from "pdfjs-dist";
import pdfjsWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl;

const MAX_PAGES = 60;

function base64ToUint8Array(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// Витягує текстовий шар перших сторінок PDF (без ШІ, напряму з pdf.js) — працює для
// PDF, збережених з текстового документа (Word → PDF тощо). Для сканованих/фото-PDF
// текстового шару немає — повертає порожній рядок, і виклик має впасти на fallback
// через зображення сторінок (extractPdfPageImages) + ШІ-розпізнавання.
export async function extractPdfText(pdfB64, maxPages = 5) {
  const pdf = await pdfjsLib.getDocument({ data: base64ToUint8Array(pdfB64) }).promise;
  const numPages = Math.min(pdf.numPages, maxPages);
  const pageTexts = [];
  for (let i = 1; i <= numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const text = content.items.map(it => it.str).join(" ").trim();
    if (text) pageTexts.push(text);
  }
  return pageTexts.join("\n");
}

// Рендерить кожну сторінку PDF у окреме JPEG-зображення (сторінка = одна ілюстрація —
// типовий випадок PDF, зібраного зі сканів/фото телефоном для великих робіт, де ілюстрацій
// більше за ліміт прямого завантаження). Помилка на конкретній сторінці не рве весь масив.
export async function extractPdfPageImages(pdfB64, { maxDim = 1000, quality = 0.72 } = {}) {
  const pdf = await pdfjsLib.getDocument({ data: base64ToUint8Array(pdfB64) }).promise;
  const numPages = Math.min(pdf.numPages, MAX_PAGES);

  const results = [];
  for (let i = 1; i <= numPages; i++) {
    try {
      const page = await pdf.getPage(i);
      const baseViewport = page.getViewport({ scale: 1 });
      const scale = maxDim / Math.max(baseViewport.width, baseViewport.height);
      const viewport = page.getViewport({ scale });

      const canvas = document.createElement("canvas");
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      const ctx = canvas.getContext("2d");
      await page.render({ canvasContext: ctx, viewport }).promise;

      const b64 = canvas.toDataURL("image/jpeg", quality).split(",")[1];
      results.push({ b64, type: "image/jpeg" });
    } catch {
      results.push(null);
    }
  }
  return results;
}
