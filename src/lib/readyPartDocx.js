import JSZip from "jszip";
import mammoth from "mammoth";
import { injectListNumbersIntoXml } from "./docxListNumbers.js";

// ── Готова частина роботи клієнта (.docx) → текст з таблицями і маркерами рисунків ──
// mammoth.extractRawText розкладає таблицю Word на окремі абзаци по клітинці ("Складова",
// "Характеристика", "Мотиваційна складова"…), а зображення просто викидає — у підсумковому
// файлі таблиці готової частини ставали стовпчиком тексту, а рисунки зникали (кейс 41570).
// Тут до mammoth: таблиці → рядки "| a | b |" (експорт малює з них справжню таблицю Word),
// зображення → окремий рядок-маркер READY_IMAGE_MARKER, а байти картинок повертаються окремо
// (воркер кладе їх у order.readyWorkImages, експорт вставляє на місце маркера).
// Ізоморфний: браузер (ArrayBuffer) і Node-воркер (Buffer), як docxListNumbers.js.

const NodeBuffer = globalThis.Buffer;
const isNode = typeof window === "undefined" && !!NodeBuffer;

export const READY_IMAGE_MARKER = (n) => `[ГОТОВА-ЧАСТИНА-РИСУНОК:${n}]`;
export const READY_IMAGE_MARKER_RE = /^\[ГОТОВА-ЧАСТИНА-РИСУНОК:(\d+)\]$/;

const escapeXml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const unescapeXml = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&amp;/g, "&");

const IMAGE_MIME = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", bmp: "image/bmp", tif: "image/tiff", tiff: "image/tiff", webp: "image/webp", emf: "image/x-emf", wmf: "image/x-wmf", svg: "image/svg+xml" };

const textPara = (text) => `<w:p><w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`;

// Текст абзацу/клітинки: усі w:t (разом із номерами, вписаними injectListNumbersIntoXml), табуляції — пробіл
function runsText(xml) {
  const parts = [];
  for (const m of xml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>/g)) parts.push(m[1] !== undefined ? unescapeXml(m[1]) : " ");
  return parts.join("");
}

function cellTexts(rowXml) {
  const cells = [];
  for (const tc of rowXml.matchAll(/<w:tc\b[^>]*>([\s\S]*?)<\/w:tc>/g)) {
    const paras = [...tc[1].matchAll(/<w:p\b[^>]*?(?:\/>|>([\s\S]*?)<\/w:p>)/g)].map(p => runsText(p[1] || "").trim()).filter(Boolean);
    cells.push(paras.join(" ").replace(/\s+/g, " ").replace(/\|/g, "/"));
    // об'єднані по горизонталі клітинки — порожні клітинки, щоб ширина рядків збігалась
    const span = parseInt(tc[1].match(/<w:gridSpan\b[^>]*\bw:val="(\d+)"/)?.[1] || "1", 10);
    for (let k = 1; k < span; k++) cells.push("");
  }
  return cells;
}

// Таблиця верхнього рівня → абзаци "| … |" (шапка, роздільник, рядки); маркери рисунків із
// клітинок — окремими абзацами після таблиці (маркер має стояти окремим рядком)
function tableToParas(tblXml) {
  const rows = [...tblXml.matchAll(/<w:tr\b[^>]*>([\s\S]*?)<\/w:tr>/g)].map(r => cellTexts(r[1]));
  const markers = [];
  const clean = rows.map(cells => cells.map(c => c.replace(/\[ГОТОВА-ЧАСТИНА-РИСУНОК:\d+\]/g, (mk) => { markers.push(mk); return ""; }).trim()));
  const nonEmpty = clean.filter(cells => cells.some(Boolean));
  if (!nonEmpty.length) return markers.map(textPara).join("");
  const width = Math.max(...nonEmpty.map(c => c.length));
  const line = (cells) => "| " + [...cells, ...Array(width - cells.length).fill("")].join(" | ") + " |";
  const out = [line(nonEmpty[0]), "| " + Array(width).fill("---").join(" | ") + " |", ...nonEmpty.slice(1).map(line)];
  return out.map(textPara).join("") + markers.map(textPara).join("");
}

// Вкладена таблиця (таблиця в клітинці) — просто абзаци тексту рядків через "; "
function nestedTableToParas(tblXml) {
  return [...tblXml.matchAll(/<w:tr\b[^>]*>([\s\S]*?)<\/w:tr>/g)]
    .map(r => cellTexts(r[1]).filter(Boolean).join("; ")).filter(Boolean).map(textPara).join("") || "<w:p/>";
}

export function tablesToMarkdownXml(docXml) {
  let xml = docXml;
  const innermost = /<w:tbl>(?:(?!<w:tbl>)[\s\S])*?<\/w:tbl>/;
  for (let guard = 0; guard < 500; guard++) {
    const m = xml.match(innermost);
    if (!m) break;
    const before = xml.slice(0, m.index);
    const depth = (before.match(/<w:tbl>/g) || []).length - (before.match(/<\/w:tbl>/g) || []).length;
    const repl = depth > 0 ? nestedTableToParas(m[0]) : tableToParas(m[0]);
    xml = before + repl + xml.slice(m.index + m[0].length);
  }
  return xml;
}

function parseImageRels(relsXml) {
  const rels = {};
  for (const m of (relsXml || "").matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const a = m[1];
    const id = a.match(/\bId="([^"]+)"/)?.[1];
    const type = a.match(/\bType="([^"]+)"/)?.[1] || "";
    const target = a.match(/\bTarget="([^"]+)"/)?.[1];
    if (!id || !target || !/\/image$/.test(type) || /TargetMode="External"/.test(a)) continue;
    rels[id] = target.startsWith("/") ? target.slice(1) : "word/" + target.replace(/^\.\//, "");
  }
  return rels;
}

// Зображення (DrawingML w:drawing і старий VML w:pict) → маркер; повертає [{rId, path}] у порядку появи
function drawingsToMarkers(docXml, rels) {
  const found = [];
  const idxByPath = new Map();
  // mc:AlternateContent містить ту саму картинку двічі (Choice + Fallback) — лишаємо Choice
  let xml = docXml.replace(/<mc:Fallback\b[^>]*>[\s\S]*?<\/mc:Fallback>/g, "");
  const replace = (whole, idAttrRe) => {
    const rId = whole.match(idAttrRe)?.[1];
    const path = rId && rels[rId];
    if (!path) return whole; // фігура/діаграма без растру — лишаємо як є (її текст mammoth прочитає)
    let n = idxByPath.get(path);
    if (n === undefined) { n = found.length; found.push({ rId, path }); idxByPath.set(path, n); }
    return `<w:t xml:space="preserve">${READY_IMAGE_MARKER(n)}</w:t>`;
  };
  xml = xml.replace(/<w:drawing>[\s\S]*?<\/w:drawing>/g, (w) => replace(w, /<a:blip\b[^>]*\br:embed="([^"]+)"/));
  xml = xml.replace(/<w:pict\b[^>]*>[\s\S]*?<\/w:pict>/g, (w) => replace(w, /<v:imagedata\b[^>]*\br:id="([^"]+)"/));
  return { xml, found };
}

// Порожні рядки між рядками таблиці прибираємо (mammoth ставить "\n\n" після кожного абзацу,
// а експорт чекає рядки таблиці поспіль); маркер рисунка — завжди окремим рядком
function tidyText(text) {
  return text
    .replace(/\s*(\[ГОТОВА-ЧАСТИНА-РИСУНОК:\d+\])\s*/g, "\n\n$1\n\n")
    .replace(/^(\|.*\|)[ \t]*\n\s*\n(?=\|)/gm, "$1\n")
    .replace(/^(\|.*\|)[ \t]*\n\s*\n(?=\|)/gm, "$1\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const toB64 = (u8) => {
  if (isNode) return NodeBuffer.from(u8).toString("base64");
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
};

/**
 * Готова частина .docx → { text, images }.
 * text — як extractDocxTextWithNumbering (з номерами автонумерації Word), але таблиці — рядками
 * "| … |", а на місці кожного рисунка — окремий рядок [ГОТОВА-ЧАСТИНА-РИСУНОК:N].
 * images[N] = { name, type, b64 } — сирі байти з word/media (стискає вже викликач).
 * @param {ArrayBuffer|Uint8Array|Buffer} input
 * @param {{images?: boolean}} [opts] images:false — рисунки не витягувати (маркерів у тексті теж не буде)
 */
export async function extractDocxReadyPart(input, { images = true } = {}) {
  const zip = await JSZip.loadAsync(input);
  const docFile = zip.file("word/document.xml");
  if (!docFile) throw new Error("word/document.xml не знайдено — це не .docx");
  let docXml = await docFile.async("text");
  const numFile = zip.file("word/numbering.xml");
  if (numFile) {
    try { docXml = injectListNumbersIntoXml(docXml, await numFile.async("text"), await zip.file("word/styles.xml")?.async("text") ?? ""); }
    catch (e) { console.warn("extractDocxReadyPart: нумерацію не відновлено:", e.message); }
  }
  let found = [];
  if (images) {
    const rels = parseImageRels(await zip.file("word/_rels/document.xml.rels")?.async("text"));
    ({ xml: docXml, found } = drawingsToMarkers(docXml, rels));
  }
  docXml = tablesToMarkdownXml(docXml);
  zip.file("word/document.xml", docXml);
  const out = await zip.generateAsync({ type: isNode ? "nodebuffer" : "arraybuffer" });
  const raw = (await mammoth.extractRawText(isNode ? { buffer: out } : { arrayBuffer: out })).value;

  const imgs = await Promise.all(found.map(async ({ path }) => {
    const f = zip.file(path);
    if (!f) return null;
    const ext = (path.split(".").pop() || "").toLowerCase();
    return { name: path.split("/").pop(), type: IMAGE_MIME[ext] || "application/octet-stream", b64: toB64(await f.async("uint8array")) };
  }));
  return { text: tidyText(raw), images: imgs };
}
