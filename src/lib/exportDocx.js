import { getLangLabels, detectChapterWord, chapterWordRe, composeChapterPrefix, chapterHeadingPrefix, stripPresentationSuffix, appendixLabelRe, appendixLetterRegex, sourcesHeadingAlt, sourcesHeading } from "./planUtils.js";
import { parseDdMmYyyy } from "./ukrainianHolidays.js";
import { PRACTICE_TYPE_GENITIVE } from "./practiceDefaults.js";
import { deriveDegreeLevelFromType, fixMismatchedDegreeWord } from "./titlePageTokens.js";
import { renderPlantUmlToPng, b64ToBytes } from "./diagramRender.js";
import { parseFigureCaption, isFigureSourceLine, webImageKey, SIMPLE_WORK_SECTION_ID } from "./webImages.js";
import {
  Document, Packer, Paragraph, TextRun, AlignmentType, PageNumber, Header, HeadingLevel,
  TableOfContents, Table, TableRow, TableCell, WidthType, BorderStyle,
  ExternalHyperlink, InternalHyperlink, Bookmark, FootnoteReferenceRun, ImageRun,
} from "docx";

// ─────────────────────────────────────────────
// Лістинги коду: розпізнавання ```-блоків і моношрифтовий рендер
// ─────────────────────────────────────────────
// Безпечне приведення до числа для полів docx (fontSize, margins тощо) —
// значення часто приходять з відповіді ШІ (аналіз методички) і можуть бути
// нечисловими truthy-рядками ("14 пт"), тоді Number(v) дає NaN, і docx падає
// з "Invalid value 'NaN' specified. Must be an integer" без цього захисту.
function toNum(v, def) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : def;
}

function isFenceLine(line) { return /^\s*```/.test(line || ""); }

// Підпис таблиці ("Таблиця 2.3 – Назва") відрізняється від речення аналізу, що
// теж починається з "Таблиця 2.3 ..." (напр. "Таблиця 2.3 наочно підтверджує...")
// тим, що одразу за ним (без порожніх рядків між ними) іде markdown-таблиця.
function isFollowedByTable(lines, index) {
  let j = index + 1;
  while (j < lines.length && !lines[j].trim()) j++;
  return j < lines.length && /^\s*\|/.test(lines[j]);
}

function codeListingParagraphs(lines, methodInfo) {
  const fmt = methodInfo?.formatting || {};
  const font = fmt.codeFont || "Courier New";
  const fontSize = Math.round(toNum(fmt.codeFontSize, 10) * 2); // docx: half-points
  const spacingLine = Math.round(toNum(fmt.codeLineSpacing, 1.0) * 240);
  return lines.map(line => new Paragraph({
    alignment: AlignmentType.LEFT,
    indent: { firstLine: 0 },
    spacing: { line: spacingLine, lineRule: "auto", before: 0, after: 0 },
    children: [new TextRun({ text: line.replace(/\t/g, "    "), font, size: fontSize, color: "000000" })],
  }));
}

// Читає рядки з fence-блоком, починаючи з indexу, що вказує на відкриваючу ```.
// Повертає {codeLines, nextIndex} — nextIndex вказує на рядок ПІСЛЯ закриваючої ```.
function readFencedBlock(lines, startIndex) {
  let i = startIndex + 1;
  const codeLines = [];
  while (i < lines.length && !isFenceLine(lines[i])) { codeLines.push(lines[i]); i++; }
  if (i < lines.length) i++; // пропускаємо закриваючу ```
  return { codeLines, nextIndex: i };
}

// Підпис лістингу коду всіма мовами роботи (getLangLabels().listingWord)
const LISTING_CAPTION_RE = /^(?:Лістинг|Listing|Listado|Výpis|Listato|代码清单)\s*[А-ЯA-Z0-9]/i;

// ─────────────────────────────────────────────
// UML-діаграми: ```plantuml``` → PNG через api/render-diagram (Kroki)
// ─────────────────────────────────────────────
const PLANTUML_FENCE_RE = /^\s*```\s*plantuml\s*$/i;

const CLIENT_IMAGE_MARKER_RE = /^\[КЛІЄНТ-ІЛЮСТРАЦІЯ:(\d+)\]$/;
// Рисунок з готової частини клієнта (readyPartDocx.js) — картинка в readyWorkImages[N]
const READY_IMAGE_MARKER_RE = /^\[ГОТОВА-ЧАСТИНА-РИСУНОК:(\d+)\]$/;

function scaleToFit(width, height, maxW, maxH) {
  let w = width, h = height;
  if (w > maxW) { h = Math.round(h * maxW / w); w = maxW; }
  if (h > maxH) { w = Math.round(w * maxH / h); h = maxH; }
  return { width: w, height: h };
}

// 7 см і 14 см у px при 96 dpi; альбомні (ширші за висоту) картинки обмежуємо 14×7 см,
// портретні — 7×14 см, щоб зображення не займали пів сторінки в "короткому" вимірі.
const CLIENT_IMG_SHORT_SIDE_PX = Math.round(7 * 96 / 2.54);
const CLIENT_IMG_LONG_SIDE_PX = Math.round(14 * 96 / 2.54);

function scaleClientImage(width, height) {
  const [maxW, maxH] = width >= height
    ? [CLIENT_IMG_LONG_SIDE_PX, CLIENT_IMG_SHORT_SIDE_PX]
    : [CLIENT_IMG_SHORT_SIDE_PX, CLIENT_IMG_LONG_SIDE_PX];
  return scaleToFit(width, height, maxW, maxH);
}

// docx завжди пакує вставлені зображення як .png (незалежно від реального формату), тож
// перекодовуємо клієнтське фото (jpeg/webp/gif) через canvas у PNG прямо перед вставкою в
// документ — і лише тоді, а не при завантаженні, щоб не зберігати подвійну копію у Firestore.
// У Node (воркер) немає ні Image, ні canvas — той самий ресайз+PNG робить sharp, значно
// простіше, ніж відтворювати canvas-шлях (typeof document !== "undefined" — єдина гілка,
// що взагалі виконується в браузері, sharp туди не бандлиться завдяки /* @vite-ignore */).
async function clientImageToPng(ill, maxDim = 1200) {
  if (!ill?.b64) return null;
  if (typeof document === "undefined") {
    try {
      const { default: sharp } = await import(/* @vite-ignore */ "sharp");
      const input = Buffer.from(ill.b64, "base64");
      const rotated = sharp(input).rotate(); // авто-орієнтація по EXIF — те саме, що робить браузер при decode
      const meta = await rotated.metadata();
      let w = meta.width, h = meta.height;
      if (w > maxDim || h > maxDim) {
        if (w >= h) { h = Math.round(h * maxDim / w); w = maxDim; }
        else { w = Math.round(w * maxDim / h); h = maxDim; }
      }
      const data = await rotated.resize(w, h).png().toBuffer();
      return { data, width: w, height: h };
    } catch {
      return null;
    }
  }
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      let w = img.naturalWidth, h = img.naturalHeight;
      if (w > maxDim || h > maxDim) {
        if (w >= h) { h = Math.round(h * maxDim / w); w = maxDim; }
        else { w = Math.round(w * maxDim / h); h = maxDim; }
      }
      try {
        const canvas = document.createElement("canvas");
        canvas.width = w; canvas.height = h;
        canvas.getContext("2d").drawImage(img, 0, 0, w, h);
        const pngB64 = canvas.toDataURL("image/png").split(",")[1];
        resolve({ data: b64ToBytes(pngB64), width: w, height: h });
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = `data:${ill.type || "image/png"};base64,${ill.b64}`;
  });
}

function resolveClientIllustrations(illustrations, maxDim) {
  return Promise.all((illustrations || []).map(ill => clientImageToPng(ill, maxDim)));
}

// Фото з інтернету для рисунків-заглушок (src/lib/webImages.js) → Map ключ рисунка → PNG,
// уже масштабований як ілюстрації клієнта. Ключ — підрозділ + назва з підпису без номера.
async function resolveWebImages(webImages) {
  const list = (webImages || []).filter(w => w?.key && w?.b64);
  const pngs = await resolveClientIllustrations(list);
  const map = new Map();
  list.forEach((w, i) => {
    if (pngs[i]) map.set(w.key, { data: pngs[i].data, ...scaleClientImage(pngs[i].width, pngs[i].height) });
  });
  return map;
}

// Повносторінкові зображення (креслення в Додатках) масштабуємо під майже всю ширину сторінки,
// на відміну від невеликих inline-ілюстрацій (scaleClientImage) — 16×22 см максимум.
const DRAWING_MAX_W_PX = Math.round(16 * 96 / 2.54);
const DRAWING_MAX_H_PX = Math.round(22 * 96 / 2.54);

function scaleDrawingImage(width, height) {
  return scaleToFit(width, height, DRAWING_MAX_W_PX, DRAWING_MAX_H_PX);
}

// ─────────────────────────────────────────────
// Числові діаграми: markdown-таблиця з даними, за якою одразу йде підпис
// рисунка, → PNG-стовпчикова діаграма (Canvas 2D, без сторонніх бібліотек).
// ─────────────────────────────────────────────
const CHART_SERIES_COLORS = ["#3B6EA5", "#8FB3D6", "#1F3F5C", "#B8CFE3"];
const CHART_FONT = '"Times New Roman", Times, serif';

function parseChartNumber(raw) {
  const cleaned = String(raw ?? "").trim().replace(/\s+/g, "").replace(/%$/, "").replace(",", ".");
  const v = parseFloat(cleaned);
  return Number.isFinite(v) ? v : null;
}

// Перший стовпець таблиці — підписи категорій, решта — числові ряди (за назвою
// стовпця в шапці). Повертає null, якщо в таблиці взагалі немає жодного числа —
// Рядок даних «a | b | c» без рамкових вертикальних рисок (≥2 непорожні клітинки, не markdown-таблиця).
function isLooseTableRow(l) {
  if (!l || /^\s*\|/.test(l) || l.length > 300) return false;
  const cells = l.split("|").map(c => c.trim());
  return cells.length >= 2 && cells.filter(Boolean).length >= 2;
}

// Markdown-таблиця БЕЗ рамкових «|» (Sonnet 5 так пише: «Клас | Блок | Потенціал» і «---|---|---»):
// раніше такі рядки йшли у файл сирим текстом (кейс 41468, 23.09). Пробіг ≥2 «вільних» рядків із
// роздільником ---|--- або ≥3 рядків з однаковою кількістю клітинок → обрамляємо «| … |», далі
// спрацьовує звичайна гілка таблиць/діаграм.
const LOOSE_SEP_RE = /^\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+$/;
// рядок таблиці з порожніми клітинками («Критерій | | |» — чек-листи): ≥3 клітинки, ≥1 непорожня
function isSparseTableRow(l) {
  if (!l || /^\s*\|/.test(l) || l.length > 300) return false;
  const cells = l.split("|").map(c => c.trim());
  return cells.length >= 3 && cells.filter(Boolean).length >= 1;
}
export function normalizeLooseTableLines(lines) {
  const ncells = l => l.split("|").length;
  const rowish = l => isLooseTableRow(l) || isSparseTableRow(l) || LOOSE_SEP_RE.test(l || "");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    if (!rowish(lines[i])) { out.push(lines[i]); i++; continue; }
    let j = i;
    while (j < lines.length) {
      if (rowish(lines[j])) { j++; continue; }
      // Один порожній рядок усередині таблиці (модель часом відділяє шапку від даних
      // порожнім рядком) — не розриває пробіжку, якщо за ним ще йдуть рядки таблиці.
      if (!lines[j].trim() && j + 1 < lines.length && rowish(lines[j + 1])) { j++; continue; }
      break;
    }
    const run = lines.slice(i, j).filter(l => l.trim());
    const sep = run.find(l => LOOSE_SEP_RE.test(l));
    // ширина таблиці: за роздільником; без нього — найчастіша ширина ≥3 клітинок, що трапляється ≥3 рази
    // (два-клітинкові «a | b» без роздільника — надто схожі на звичайний текст із рискою)
    let width = 0;
    if (sep && run.length >= 2) width = ncells(sep);
    else if (run.length >= 3) {
      const freq = new Map();
      for (const l of run) freq.set(ncells(l), (freq.get(ncells(l)) || 0) + 1);
      for (const [w, n] of freq) if (w >= 3 && n >= 3 && n > (freq.get(width) || 0)) width = w;
    }
    if (width < 2) { out.push(...run); i = j; continue; }
    // Довгий заголовок модель часом переносить на новий фізичний рядок — такий
    // куций уламок (менше клітинок, ніж width) раніше просто випадав з таблиці
    // як звичайний текст, і разом з ним губилась колонка (кейс із субшкалами,
    // 23.09). Тут клеїмо його з наступним рядком, доки не набереться рівно
    // width клітинок; клеїмо лише коли рахунок збігається точно — щоб випадково
    // не зжерти в "шапку" повноцінний рядок даних. Якщо перший фрагмент шапки
    // взагалі без жодної "|" (окреме слово-заголовок на своєму рядку), пробуємо
    // забрати назад уже виштовхнутий попередній рядок з out.
    let pending = null; // { cells, lines }
    let borrowedPrev = false;
    const prevLine = out[out.length - 1];
    if (
      prevLine !== undefined && prevLine.trim() && !prevLine.includes("|") &&
      prevLine.trim().length < 200 && prevLine.trim().split(/\s+/).length <= 6
    ) {
      pending = { cells: [prevLine.trim()], lines: [] };
      borrowedPrev = true;
    }
    for (const l of run) {
      if (LOOSE_SEP_RE.test(l)) {
        if (pending) { if (!borrowedPrev) out.push(...pending.lines); pending = null; borrowedPrev = false; }
        out.push("| " + Array(width).fill("---").join(" | ") + " |");
        continue;
      }
      const cells = l.split("|").map(c => c.trim());
      if (pending) {
        const need = width - pending.cells.length;
        if (cells.length <= need) {
          pending.cells.push(...cells);
          pending.lines.push(l);
          if (pending.cells.length === width) {
            if (borrowedPrev) out.pop();
            out.push("| " + pending.cells.join(" | ") + " |");
            pending = null; borrowedPrev = false;
          }
          continue;
        }
        if (!borrowedPrev) out.push(...pending.lines);
        pending = null; borrowedPrev = false;
      }
      if (cells.length === width) out.push("| " + cells.join(" | ") + " |");
      else if (cells.length < width) pending = { cells, lines: [l] };
      else out.push(l);
    }
    if (pending && !borrowedPrev) out.push(...pending.lines);
    i = j;
  }
  return out;
}

// тоді таблиця лишається просто текстовою, без діаграми.
function parseChartTable(tableLines) {
  const dataLines = tableLines.filter(l => !/^\s*\|[-:| ]+\|\s*$/.test(l));
  if (dataLines.length < 2) return null;
  const rows = dataLines.map(l => l.replace(/^\|/, "").replace(/\|$/, "").split("|").map(c => c.trim()));
  const header = rows[0];
  if (header.length < 2) return null;
  const seriesNames = header.slice(1);
  const labels = [];
  const series = seriesNames.map(() => []);
  let hasValue = false;
  for (const row of rows.slice(1)) {
    labels.push(row[0] || "");
    for (let s = 0; s < seriesNames.length; s++) {
      const v = parseChartNumber(row[s + 1]);
      if (v !== null) hasValue = true;
      series[s].push(v ?? 0);
    }
  }
  return hasValue ? { labels, seriesNames, series } : null;
}

function niceChartMax(v) {
  if (v <= 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  const norm = v / mag;
  const nice = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return nice * mag;
}

function formatChartNum(v) {
  const r = Math.round(v * 100) / 100;
  const s = Number.isInteger(r) ? String(r) : r.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
  return s.replace(".", ",");
}

// Малює просту стовпчикову діаграму на offscreen canvas, повертає PNG у тому ж
// форматі, що й renderPlantUmlToPng ({ data, width, height }). Розмір шрифту
// підписів категорій автоматично зменшується, а за потреби підписи повертаються
// під кутом — щоб вони не накладались одне на одне; вісь значень отримує запас
// зверху під підпис над стовпцем, а її ліве поле підганяється під ширину чисел.
// Підписи значень над стовпцями показуються лише для одного ряду даних — при
// кількох рядах замість них унизу малюється легенда (інакше цифри зіллються).
// Canvas 2D: у браузері — справжній DOM canvas; у Node (воркер) — пакет "canvas"
// (node-canvas, той самий Canvas 2D API на Cairo). /* @vite-ignore */ не дає Vite
// намагатись забандлити нативний Node-модуль у браузерну збірку — ця гілка
// взагалі не виконується в браузері (typeof document !== "undefined").
async function makeCanvas(w, h) {
  if (typeof document !== "undefined") {
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    return c;
  }
  const { createCanvas } = await import(/* @vite-ignore */ "canvas");
  return createCanvas(w, h);
}

async function renderChartFromParsed({ labels, seriesNames, series }) {
  const DPR = 2;
  const W = 620;
  // Виміри шрифтів не залежать від розміру canvas, тож спершу рахуємо їх на
  // тимчасовому canvas, щоб визначити фактичну висоту зображення (H) — і лише
  // потім створюємо canvas потрібного розміру. Це потрібно, бо повернуті під
  // кутом підписи категорій можуть займати різну висоту залежно від довжини
  // тексту, а фіксована висота призводила до накладання підписів на легенду.
  const measureCtx = (await makeCanvas(10, 10)).getContext("2d");

  const INK = "#111111", GRID = "#e3e7ec", MUTED = "#6b7280";
  const n = labels.length;
  const seriesCount = seriesNames.length;
  const showValueLabels = seriesCount === 1;
  const showLegend = seriesCount > 1;
  const legendH = showLegend ? 26 : 0;

  const maxVal = Math.max(1e-9, ...series.flat());
  const niceMax = niceChartMax(maxVal * (showValueLabels ? 1.15 : 1.08));

  measureCtx.font = `11px ${CHART_FONT}`;
  const steps = 4;
  let maxTickW = 0;
  for (let i = 0; i <= steps; i++) {
    const w = measureCtx.measureText(formatChartNum((niceMax / steps) * i)).width;
    if (w > maxTickW) maxTickW = w;
  }
  const padL = Math.max(40, Math.round(maxTickW) + 16);
  const padR = 16;
  const padT = showValueLabels ? 32 : 18;
  const plotWidth = W - padL - padR;
  const slot = plotWidth / n;

  let labelFont = 13;
  const fitsHorizontal = (font) => {
    measureCtx.font = `${font}px ${CHART_FONT}`;
    return labels.every(l => measureCtx.measureText(l).width <= slot - 6);
  };
  while (labelFont > 9 && !fitsHorizontal(labelFont)) labelFont -= 1;
  const rotate = !fitsHorizontal(labelFont);
  if (rotate) labelFont = 12;

  // Кут повороту підписів — 36°; довгі підписи обрізаються з "…", щоб верти-
  // кальний відступ під них не ріс необмежено (інакше зображення виходило б
  // занадто витягнутим по висоті).
  const ROTATE_ANGLE = Math.PI / 5;
  let plotLabels = labels;
  let rotatedDrop = 0;
  if (rotate) {
    measureCtx.font = `${labelFont}px ${CHART_FONT}`;
    const maxDrop = 130;
    const maxLabelW = maxDrop / Math.sin(ROTATE_ANGLE);
    plotLabels = labels.map(l => {
      if (measureCtx.measureText(l).width <= maxLabelW) return l;
      let s = l;
      while (s.length > 1 && measureCtx.measureText(s + "…").width > maxLabelW) {
        s = s.slice(0, -1);
      }
      return s + "…";
    });
    rotatedDrop = Math.max(...plotLabels.map(l => measureCtx.measureText(l).width)) * Math.sin(ROTATE_ANGLE);
  }

  const padB = (rotate ? Math.ceil(rotatedDrop) + 20 : 28) + legendH;
  const plotT = padT;
  const minPlotH = 270;
  const H = plotT + minPlotH + padB;
  const plotB = H - padB;
  const plotH = plotB - plotT;

  const canvas = await makeCanvas(W * DPR, H * DPR);
  const ctx = canvas.getContext("2d");
  ctx.scale(DPR, DPR);

  ctx.strokeStyle = GRID;
  ctx.lineWidth = 1;
  ctx.fillStyle = MUTED;
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (let i = 0; i <= steps; i++) {
    const val = (niceMax / steps) * i;
    const y = plotB - (val / niceMax) * plotH;
    ctx.font = `11px ${CHART_FONT}`;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(padL + plotWidth, y);
    ctx.stroke();
    ctx.fillText(formatChartNum(val), padL - 8, y);
  }

  ctx.strokeStyle = INK;
  ctx.lineWidth = 1.3;
  ctx.beginPath();
  ctx.moveTo(padL, plotB);
  ctx.lineTo(padL + plotWidth, plotB);
  ctx.stroke();

  const groupPad = 0.28;
  const groupW = slot * (1 - groupPad);
  const barGap = seriesCount > 1 ? 2 : 0;
  const barW = Math.max(2, (groupW - barGap * (seriesCount - 1)) / seriesCount);

  labels.forEach((label, i) => {
    const groupX = padL + slot * i + (slot - groupW) / 2;
    for (let s = 0; s < seriesCount; s++) {
      const v = series[s][i];
      const barH = (v / niceMax) * plotH;
      const x = groupX + s * (barW + barGap);
      const y = plotB - barH;
      ctx.fillStyle = CHART_SERIES_COLORS[s % CHART_SERIES_COLORS.length];
      ctx.fillRect(x, y, barW, barH);
      if (showValueLabels && barH > 1) {
        ctx.fillStyle = INK;
        ctx.font = `12px ${CHART_FONT}`;
        ctx.textAlign = "center";
        ctx.textBaseline = "alphabetic";
        ctx.fillText(formatChartNum(v), x + barW / 2, Math.max(12, y - 6));
      }
    }
    ctx.fillStyle = INK;
    ctx.font = `${labelFont}px ${CHART_FONT}`;
    const cx = padL + slot * i + slot / 2;
    if (rotate) {
      ctx.save();
      ctx.translate(cx, plotB + 12);
      ctx.rotate(-ROTATE_ANGLE);
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      ctx.fillText(plotLabels[i], 0, 0);
      ctx.restore();
    } else {
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillText(label, cx, plotB + 8);
    }
  });

  if (showLegend) {
    ctx.font = `12px ${CHART_FONT}`;
    ctx.textBaseline = "middle";
    const swatch = 10, gap = 18;
    const widths = seriesNames.map(nm => swatch + 6 + ctx.measureText(nm).width);
    const totalW = widths.reduce((a, b) => a + b, 0) + gap * (seriesNames.length - 1);
    let lx = padL + Math.max(0, (plotWidth - totalW) / 2);
    const ly = H - legendH / 2 - 6;
    seriesNames.forEach((nm, s) => {
      ctx.fillStyle = CHART_SERIES_COLORS[s % CHART_SERIES_COLORS.length];
      ctx.fillRect(lx, ly - swatch / 2, swatch, swatch);
      ctx.fillStyle = INK;
      ctx.textAlign = "left";
      ctx.fillText(nm, lx + swatch + 6, ly);
      lx += widths[s] + gap;
    });
  }

  const pngB64 = canvas.toDataURL("image/png").split(",")[1];
  const { width, height } = scaleToFit(W, H, 450, 320);
  return { data: b64ToBytes(pngB64), width, height };
}

// tableLines → PNG діаграми, або null якщо в таблиці немає жодного числа (тоді
// таблиця лишається як є, без діаграми — так само, як невдалий рендер PlantUML).
export async function renderDataChartToPng(tableLines) {
  try {
    const parsed = parseChartTable(tableLines);
    if (!parsed) return null;
    return await renderChartFromParsed(parsed);
  } catch (e) {
    // У Node-воркері найчастіша причина — не зібрався нативний пакет "canvas"
    // (потрібні системні бібліотеки Cairo/Pango, див. worker/README.md) — без
    // цього логу графік тихо ставав таблицею без жодного сліду в логах.
    console.error("renderDataChartToPng: графік не намальовано —", e.message);
    return null;
  }
}

// Заміняє кожен ```plantuml``` fence-блок на маркер \x00DIAGRAM<i>\x00 і рендерить
// відповідні PNG паралельно; таблицю з даними, за якою одразу йде підпис рисунка
// (${figWord} N – ...), замінює на автоматично намальовану діаграму (сама таблиця
// прибирається з тексту, щоб не дублювати ті самі дані таблицею й графіком одразу;
// якщо рендер графіка не вдався — таблиця лишається як фолбек). Викликається один
// раз для всього numberedContent.
async function resolveDiagrams(content, figWord, webImageMap = new Map()) {
  const diagramImages = [];
  const jobs = [];
  // Коли рендер графіка з таблиці даних не вдається — лишаємо таблицю текстом,
  // як і раніше; тепер рендер асинхронний (той самий jobs-пайплайн, що й
  // PlantUML), тож рішення "маркер чи таблиця" відкладаємо до resolved.
  const tableFallbacks = [];
  const updated = { ...content };
  const fwRe = new RegExp("^" + figWord.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\d");
  for (const key of Object.keys(updated)) {
    const txt = updated[key];
    if (!txt) continue;
    const lines = normalizeLooseTableLines(txt.split("\n"));
    const outLines = [];
    let i = 0;
    while (i < lines.length) {
      if (PLANTUML_FENCE_RE.test(lines[i])) {
        const { codeLines, nextIndex } = readFencedBlock(lines, i);
        const idx = diagramImages.length;
        diagramImages.push(null);
        jobs.push(renderPlantUmlToPng(codeLines.join("\n")).then(img => { diagramImages[idx] = img; }));
        outLines.push(`\x00DIAGRAM${idx}\x00`);
        i = nextIndex;
        continue;
      }
      // Таблиця даних БЕЗ рамкових «|» («Форма роботи | Тривалість | Рівень» — так модель часом пише дані
      // для діаграми): раніше це не розпізнавалось як таблиця → діаграма не малювалась, у файлі лишались
      // сирі рядки й кольоровий підпис рисунка (кейс 41406). Якщо після ≥3 таких рядків іде підпис рисунка —
      // нормалізуємо їх у звичайну markdown-таблицю, далі спрацьовує стандартна гілка.
      if (isLooseTableRow(lines[i])) {
        let j0 = i;
        while (j0 < lines.length && isLooseTableRow(lines[j0])) j0++;
        let k0 = j0;
        while (k0 < lines.length && !lines[k0].trim()) k0++;
        if (j0 - i >= 3 && k0 < lines.length && fwRe.test(lines[k0].trim())) {
          for (let q = i; q < j0; q++) lines[q] = "| " + lines[q].split("|").map(c => c.trim()).join(" | ") + " |";
        }
      }
      if (/^\s*\|/.test(lines[i])) {
        const tableLines = [];
        let j = i;
        while (j < lines.length && /^\s*\|/.test(lines[j])) { tableLines.push(lines[j]); j++; }
        let k = j;
        while (k < lines.length && !lines[k].trim()) k++;
        if (k < lines.length && fwRe.test(lines[k].trim())) {
          // Графік ще не намальований (асинхронно) — оптимістично лишаємо маркер;
          // якщо рендер зрештою не вдасться, підмінимо маркер назад на таблицю
          // (tableFallbacks, після await Promise.all(jobs) нижче).
          const idx = diagramImages.length;
          diagramImages.push(null);
          jobs.push(renderDataChartToPng(tableLines).then(img => { diagramImages[idx] = img; }));
          tableFallbacks.push({ idx, tableLines });
          outLines.push(`\x00DIAGRAM${idx}\x00`);
        } else {
          outLines.push(...tableLines);
        }
        i = j;
        continue;
      }
      // Застарілий рядок-підказку (з уже згенерованого раніше вмісту) більше не показуємо —
      // тепер діаграма вставляється сама.
      if (/^⚠/.test(lines[i].trim())) { i++; continue; }
      // Підпис-заглушка (над ним нічого, з чого малюється рисунок), для якого знайдено фото
      // з інтернету, — ставимо фото над підписом тим самим маркером, що й схеми.
      const cap = webImageMap.size ? parseFigureCaption(lines[i], figWord) : null;
      if (cap) {
        let p = outLines.length - 1;
        while (p >= 0 && !outLines[p].trim()) p--;
        const webImg = p < 0 || !isFigureSourceLine(outLines[p].trim()) ? webImageMap.get(webImageKey(key, cap.name)) : null;
        if (webImg) {
          outLines.push(`\x00DIAGRAM${diagramImages.length}\x00`);
          diagramImages.push(webImg);
        }
      }
      outLines.push(lines[i]);
      i++;
    }
    updated[key] = outLines.join("\n");
  }
  await Promise.all(jobs);
  for (const { idx, tableLines } of tableFallbacks) {
    if (diagramImages[idx]) continue; // рендер вдався — маркер лишається
    const marker = `\x00DIAGRAM${idx}\x00`;
    for (const key of Object.keys(updated)) {
      if (updated[key]?.includes(marker)) updated[key] = updated[key].replace(marker, tableLines.join("\n"));
    }
  }
  return { content: updated, diagramImages };
}

// ─────────────────────────────────────────────
// Перенумерація таблиць і рисунків
// ─────────────────────────────────────────────
export function renumberTablesAndFigures(content, displayOrder, lang) {
  const lc = getLangLabels(lang);
  const tw = lc.tableWord;
  const fw = lc.figWord;

  function getChapter(sec) {
    if (!sec?.id) return null;
    const m = sec.id.match(/^(\d+)/);
    return m ? m[1] : null;
  }
  function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

  const chTableCount = {}, chFigCount = {};
  const secRenamings = {};

  for (const sec of displayOrder) {
    const txt = content[sec.id];
    if (!txt) continue;
    const ch = getChapter(sec);
    if (!ch) continue;
    chTableCount[ch] = chTableCount[ch] || 0;
    chFigCount[ch]   = chFigCount[ch]   || 0;
    secRenamings[sec.id] = [];

    let m;
    // Рахуємо лише справжні підписи таблиць (одразу за рядком іде markdown-таблиця),
    // а не речення аналізу, що теж починаються з "Таблиця X.Y" (напр. "Таблиця 2.3 наочно
    // підтверджує...") — інакше такі речення з'їдають номер і справжні підписи проскакують.
    const tableCapRe = new RegExp(`^${escRe(tw)}\\s+(\\d+\\.\\d+)`);
    const txtLines = txt.split("\n");
    for (let li = 0; li < txtLines.length; li++) {
      const cap = txtLines[li].match(tableCapRe);
      if (cap && isFollowedByTable(txtLines, li)) {
        chTableCount[ch]++;
        secRenamings[sec.id].push({ oldRef: cap[1], newRef: `${ch}.${chTableCount[ch]}`, type: "table" });
      }
    }
    const figRe = new RegExp(`^${escRe(fw)}\\s+(\\d+\\.\\d+)`, "gm");
    while ((m = figRe.exec(txt)) !== null) {
      chFigCount[ch]++;
      secRenamings[sec.id].push({ oldRef: m[1], newRef: `${ch}.${chFigCount[ch]}`, type: "fig" });
    }
  }

  const updated = { ...content };
  for (const sec of displayOrder) {
    let txt = content[sec.id];
    if (!txt) continue;
    const renamings = (secRenamings[sec.id] || []).filter(r => r.oldRef !== r.newRef);
    if (!renamings.length) continue;

    let tokI = 0;
    const tokMap = new Map();

    for (const { oldRef, newRef, type } of renamings) {
      const tok = `\x00T${tokI++}\x00`;
      tokMap.set(tok, newRef);
      if (type === "table") {
        txt = txt.replace(new RegExp(`(^${escRe(tw)}\\s+)${escRe(oldRef)}`, "m"), `$1${tok}`);
        if (tw === "Таблиця") {
          txt = txt.replace(new RegExp(`(Таблиц[яіюю]\\s+)${escRe(oldRef)}(?!\\d)`, "g"), `$1${tok}`);
        } else {
          txt = txt.replace(new RegExp(`(${escRe(tw)}\\s+)${escRe(oldRef)}(?!\\d)`, "gi"), `$1${tok}`);
        }
      } else {
        txt = txt.replace(new RegExp(`(^${escRe(fw)}\\s+)${escRe(oldRef)}`, "m"), `$1${tok}`);
        txt = txt.replace(new RegExp(`(${escRe(fw)}\\s+)${escRe(oldRef)}(?!\\d)`, "gi"), `$1${tok}`);
      }
    }

    for (const [tok, newRef] of tokMap) {
      txt = txt.replaceAll(tok, newRef);
    }
    updated[sec.id] = txt;
  }
  return updated;
}

// ─────────────────────────────────────────────
// Визначає код мови Word для перевірки правопису
// ─────────────────────────────────────────────
function getLangWordCode(lang) {
  return getLangLabels(lang).wordCode;
}

// ─────────────────────────────────────────────
// Визначає мову перевірки правопису за фактичним текстом документа
// (info.language — це заявлена мова роботи, вона не завжди збігається з
// реальною мовою згенерованого тексту, тому мову правопису беремо з тексту)
// ─────────────────────────────────────────────
export function detectTextLanguage(text, fallbackLang) {
  const sample = (text || "").slice(0, 8000);
  const letters = sample.match(/\p{L}/gu) || [];
  if (letters.length < 30) return getLangWordCode(fallbackLang);
  const cyrillic = letters.filter(c => /[Ѐ-ӿ]/.test(c)).length;
  const cjk = letters.filter(c => /[一-鿿]/.test(c)).length;
  const latin = letters.filter(c => /[A-Za-z]/.test(c)).length;
  if (cjk / letters.length > 0.3) return "zh-CN";
  const declared = getLangLabels(fallbackLang);
  // Кириличний текст — українська, якщо тільки заявлена мова не кирилична мова з набору ШІ (болгарська тощо)
  if (cyrillic >= latin) return declared.dynamic && !declared.latinScript ? declared.wordCode : "uk-UA";
  // Текст латиницею, а заявлена мова — відома латинична (вбудована чи з набору ШІ): беремо її,
  // а не вгадуємо за діакритикою (французьке "é" інакше давало іспанський, німецьке "Café" — теж).
  if (declared.latinScript && (declared.code !== "other" || declared.dynamic)) return declared.wordCode;
  if (/[ąćęłńśźż]/i.test(sample)) return "pl-PL";
  if (/[ñáéíóúü¡¿]/i.test(sample)) return "es-ES";
  if (/[äöüß]/i.test(sample)) return "de-DE";
  if (/[řě]/i.test(sample)) return "cs-CZ";
  if (/[ľĺŕôňäť]/i.test(sample)) return "sk-SK";
  const fb = getLangWordCode(fallbackLang);
  return fb !== "uk-UA" ? fb : "en-US";
}

// ─────────────────────────────────────────────
// Щоденник практики: розбір markdown-таблиць, згенерованих ШІ (buildPracticeDiaryPrompt),
// у структуровані дані для "Календарного графіка" та "Робочих записів" — детерміновано, кодом,
// а не повторним зверненням до ШІ.
// ─────────────────────────────────────────────
const CALENDAR_GRAPH_MARKER = "%%CALENDAR_GRAPH%%";

function parseMdTableDataRows(text) {
  const tableLines = (text || "").split("\n").filter(l => /^\s*\|/.test(l));
  const dataLines = tableLines.filter(l => !/^\s*\|[-:| ]+\|\s*$/.test(l));
  const rows = dataLines.map(l => l.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map(c => c.trim()));
  return rows.length > 1 ? rows.slice(1) : []; // без рядка шапки
}

// Відокремлює основну таблицю щоденника від блоку "Календарний графік", який ШІ (за інструкцією
// в buildPracticeDiaryPrompt) виводить після явного маркера-роздільника — щоб друга таблиця не
// потрапила в тіло щоденника як звичайний текст.
export function splitDiaryCalendarGraph(diaryText) {
  const idx = (diaryText || "").indexOf(CALENDAR_GRAPH_MARKER);
  if (idx === -1) return { mainText: diaryText || "", calendarGraphText: "" };
  return { mainText: diaryText.slice(0, idx).trim(), calendarGraphText: diaryText.slice(idx + CALENDAR_GRAPH_MARKER.length) };
}

// Знаходить першу дату "дд.мм" чи "дд.мм.рррр" у тексті клітинки календарного графіка.
function extractFirstDayMonth(text) {
  const m = /(\d{1,2})\.(\d{1,2})(?:\.(\d{4}))?/.exec(text || "");
  return m ? { day: +m[1], month: +m[2], year: m[3] ? +m[3] : null } : null;
}

// Номер тижня (0-індекс), у якому фактично лежить дата з клітинки, рахуючи від dateStart —
// незалежно від того, в яку колонку таблиці ШІ цю дату помилково вписав (ШІ регулярно ставить
// усі дати в колонку "Тиждень 1", ігноруючи реальний тиждень практики).
function weekIndexForCell(cellText, startDate, weeksCount) {
  if (!startDate) return null;
  const parsed = extractFirstDayMonth(cellText);
  if (!parsed) return null;
  const year = parsed.year || startDate.getUTCFullYear();
  const cellDate = new Date(Date.UTC(year, parsed.month - 1, parsed.day));
  const diffDays = Math.round((cellDate - startDate) / 86400000);
  if (diffDays < 0) return null;
  return Math.min(weeksCount - 1, Math.floor(diffDays / 7));
}

// Таблиця "Календарний графік" → рядки для exportToDocx: [{ name, weeks: [...], note }]
export function parseDiaryCalendarGraphRows(calendarGraphText, weeksCount, dateStart) {
  const startDate = parseDdMmYyyy(dateStart);
  return parseMdTableDataRows(calendarGraphText)
    .map(cells => {
      const weeks = Array.from({ length: weeksCount }, () => "");
      for (let i = 1; i <= weeksCount; i++) {
        const cellText = (cells[i] || "").trim();
        if (!cellText) continue;
        const targetIdx = weekIndexForCell(cellText, startDate, weeksCount) ?? (i - 1);
        weeks[targetIdx] = weeks[targetIdx] ? `${weeks[targetIdx]}, ${cellText}` : cellText;
      }
      return {
        name: cells[0] || "",
        weeks,
        note: cells[weeksCount + 1] || "Виконано",
      };
    })
    .filter(r => r.name);
}

// Основна таблиця щоденника → короткі рядки "дата/тема — зміст" для лінованих сторінок
// "Робочі записи під час практики" (замість порожніх рядків для рукопису).
export function parseDiaryWorkRecords(mainDiaryText) {
  return parseMdTableDataRows(mainDiaryText)
    .map(cells => cells.filter(Boolean).join(" — "))
    .filter(Boolean);
}

// Packer.toBuffer/toBlob — офіційний дуальний API самого пакету "docx" (не
// потребує canvas/sharp-трюків, у Node працює нативно). У браузері — той самий
// download через <a>, що й раніше; у Node — повертає {buffer, filename} замість
// side-effect'у, щоб виклик з воркера сам вирішив, що з файлом робити (записати
// на диск для звірки з UI, віддати в CRM тощо).
async function packDocx(doc, filename) {
  if (typeof document === "undefined") {
    const buffer = await Packer.toBuffer(doc);
    return { buffer, filename };
  }
  const blob = await Packer.toBlob(doc);
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  } finally {
    URL.revokeObjectURL(url);
  }
  return undefined;
}

// ─────────────────────────────────────────────
// Word export (основний документ)
// ─────────────────────────────────────────────
export async function exportToDocx({ content, info, displayOrder, appendicesText, titlePage, titlePageLines, methodInfo, commentAnalysis, orderId, annotationUk, annotationEn, illustrations = [], readyWorkImages = [], webImages = [], clientDrawings = [], skipToc = false, keepHeadingCase = false, diaryArrivalDeparture = false, diaryBlankNotesPages = false, diaryStudentName = "", diaryReviewBlock = false, diarySupervisorCompany = "", diarySupervisorUniversity = "", diaryCalendarGraph = false, diaryCalendarGraphWeeks = 6, diaryCalendarGraphRows = [], diaryWorkRecords = [], diarySupervisorSignatureBlock = false, diaryInspectorReview = false, diaryGradeFields = false, diaryConclusionDepartment = "" }) {
  // Деякі виклики (напр. звіти з практики) не проставляють sec.type — довизначаємо його
  // з id для фіксованих розділів, щоб список джерел коректно розпізнавався нижче.
  displayOrder = (displayOrder || []).map(s =>
    !s.type && ["intro", "conclusions", "sources"].includes(s.id) ? { ...s, type: s.id } : s
  );
  const lc = getLangLabels(info?.language);
  const numberedContent = renumberTablesAndFigures(content, displayOrder, info?.language);
  Object.keys(numberedContent).forEach(k => { if (numberedContent[k]) numberedContent[k] = numberedContent[k].replace(/'/g, '\u2019'); });
  const langCode = detectTextLanguage(Object.values(numberedContent).join("\n\n"), info?.language);
  const rawAppendices = appendicesText ? appendicesText.replace(/'/g, '\u2019') : appendicesText;
  const webImageMap = await resolveWebImages(webImages);
  const { content: diagramResolvedContent, diagramImages } = await resolveDiagrams(numberedContent, lc.figWord, webImageMap);
  Object.assign(numberedContent, diagramResolvedContent);
  // Додатки рендеряться окремим циклом нижче (не через makeBlocks), тож рисунки в них
  // резолвимо окремим викликом — інакше plantuml-схема лишалась би сирим кодом у тексті.
  const { content: appendixDiagramResolved, diagramImages: appendixDiagramImages } = rawAppendices
    ? await resolveDiagrams({ appendix: rawAppendices }, lc.figWord)
    : { content: {}, diagramImages: [] };
  const normAppendices = rawAppendices ? appendixDiagramResolved.appendix : rawAppendices;
  const clientImages = await resolveClientIllustrations(illustrations);
  // рисунки готової частини — у розмірі, близькому до оригіналу (на ширину тексту), а не як мініатюри ілюстрацій
  const readyImages = await resolveClientIllustrations(readyWorkImages, 1600);
  const drawingImages = await resolveClientIllustrations(clientDrawings, 1600);

  // \u2500\u2500 \u0412\u0438\u043d\u043e\u0441\u043a\u0438 (\u0414\u0421\u0422\u0423-\u0440\u0435\u0436\u0438\u043c): %%FN<n>%% \u0443 \u0442\u0435\u043a\u0441\u0442\u0456 \u2192 \u0440\u0435\u0430\u043b\u044c\u043d\u0430 Word-\u0432\u0438\u043d\u043e\u0441\u043a\u0430 \u2500\u2500
  // n \u2192 \u043f\u043e\u0432\u043d\u0438\u0439 \u0442\u0435\u043a\u0441\u0442 \u0434\u0436\u0435\u0440\u0435\u043b\u0430, \u0440\u043e\u0437\u043f\u0430\u0440\u0441\u0435\u043d\u0438\u0439 \u0437\u0456 \u0441\u043f\u0438\u0441\u043a\u0443 \u0434\u0436\u0435\u0440\u0435\u043b ("\u0421\u041f\u0418\u0421\u041e\u041a \u0412\u0418\u041a\u041e\u0420\u0418\u0421\u0422\u0410\u041d\u0418\u0425 \u0414\u0416\u0415\u0420\u0415\u041b").
  const footnoteTextByNum = {};
  const sourcesSec = displayOrder.find(s => s.type === "sources");
  if (sourcesSec && numberedContent[sourcesSec.id]) {
    numberedContent[sourcesSec.id].split("\n").forEach(line => {
      const cleaned = line.trim().replace(/\*\*(.+?)\*\*/g, "$1").replace(/\*(.+?)\*/g, "$1");
      const m = cleaned.match(/^(\d+)[.)]\s*(.*)/);
      if (m) footnoteTextByNum[parseInt(m[1])] = m[2];
    });
  }
  const footnotesRegistry = {};
  let footnoteCounter = 0;

  const FONT = methodInfo?.formatting?.font || "Times New Roman";
  const SIZE = Math.round(toNum(methodInfo?.formatting?.fontSize, 14) * 2);
  const SIZE_NUM = Math.max(16, SIZE - 4);
  function _escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
  // Пробіл після "Рис."/"Таблиця" необов'язковий: у готових частинах клієнтів часто "Рис.1.1." —
  // без цього підпис не впізнавався (помаранчевий, як рисунок без зображення, кейс 41570).
  // Номер — без кінцевої крапки ("Рис.1.1." → "1.1"), як у посиланнях у тексті (FIG_INLINE_NUM_RE)
  const twRe = new RegExp("^" + _escRe(lc.tableWord) + "\\s*\\d");
  const fwRe = new RegExp("^" + _escRe(lc.figWord) + "\\s*\\d");
  const figNumRe = new RegExp("^" + _escRe(lc.figWord) + "\\s*(\\d+(?:\\.\\d+)*)");
  // Номери рисунків, для яких у поточному підрозділі реально вставлено зображення (не текстова
  // заглушка) — щоб посилання на них у тексті малювалось чорним, а не помаранчевим "TODO".
  let resolvedFigNums = new Set();
  const mmToTwip = mm => Math.round(mm * 1440 / 25.4);
  const marg = methodInfo?.formatting?.margins || commentAnalysis?.formattingHints?.margins || {};
  const toMm = v => toNum(v, null);
  const L = mmToTwip(toMm(marg.left)   ?? 30);
  const R = mmToTwip(toMm(marg.right)  ?? 15);
  const T = mmToTwip(toMm(marg.top)    ?? 20);
  const B = mmToTwip(toMm(marg.bottom) ?? 20);
  const INDENT = 709, LINE = 360;
  const LINE_SINGLE = 240;

  function cleanMarkdown(line) {
    return line.replace(/^#{1,6}\s+/, "").replace(/\*\*(.+?)\*\*/g, "$1")
      .replace(/\*(.+?)\*/g, "$1").replace(/^[-*]\s+/, "").replace(/^\d+\.\s+/, "").trim();
  }
  function isDuplicateTitle(firstLine, secLabel) {
    if (!firstLine || !secLabel) return false;
    const a = cleanMarkdown(firstLine).toLowerCase().replace(/\s+/g, " ").trim();
    const b = secLabel.toLowerCase().replace(/\s+/g, " ").trim();
    if (a === b) return true;
    const numMatch = secLabel.match(/^(\d+\.\d+)/);
    if (numMatch && a.startsWith(numMatch[1])) return true;
    return false;
  }
  const FIG_INLINE_RE = /(?:рис(?:унок)?\.?\s*\d+(?:\.\d+)*|fig(?:ure)?\.?\s*\d+(?:\.\d+)*)/i;
  const FIG_INLINE_NUM_RE = /(?:рис(?:унок)?\.?|fig(?:ure)?\.?)\s*(\d+(?:\.\d+)*)/gi;
  function hasUnresolvedFigRef(text) {
    if (!FIG_INLINE_RE.test(text || "")) return false;
    FIG_INLINE_NUM_RE.lastIndex = 0;
    let m, any = false, allResolved = true;
    while ((m = FIG_INLINE_NUM_RE.exec(text)) !== null) {
      any = true;
      if (!resolvedFigNums.has(m[1])) allResolved = false;
    }
    return !(any && allResolved);
  }
  function parseTextWithCitations(text, color) {
    const CITE_RE = /\[(\d+)\]|%%FN(\d+)%%/g;
    const result = [];
    let lastIndex = 0;
    let match;
    while ((match = CITE_RE.exec(text)) !== null) {
      if (match.index > lastIndex) {
        result.push(new TextRun({ text: text.slice(lastIndex, match.index), font: FONT, size: SIZE, color }));
      }
      if (match[2]) {
        footnoteCounter++;
        const fnText = footnoteTextByNum[Number(match[2])] || "";
        footnotesRegistry[footnoteCounter] = { children: [new Paragraph({ children: [new TextRun({ text: fnText, font: FONT, size: SIZE_NUM, color: "000000" })] })] };
        result.push(new TextRun({ children: [new FootnoteReferenceRun(footnoteCounter)], font: FONT, size: SIZE, color }));
      } else {
        result.push(new InternalHyperlink({
          anchor: `ref_${match[1]}`,
          children: [new TextRun({ text: match[0], font: FONT, size: SIZE, color: "000000" })],
        }));
      }
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < text.length) {
      result.push(new TextRun({ text: text.slice(lastIndex), font: FONT, size: SIZE, color }));
    }
    return result.length ? result : [new TextRun({ text, font: FONT, size: SIZE, color })];
  }
  function bodyPara(text) {
    const color = hasUnresolvedFigRef(text) ? "B85C00" : "000000";
    return new Paragraph({
      indent: { firstLine: INDENT },
      spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 },
      alignment: AlignmentType.BOTH,
      children: parseTextWithCitations(text || "", color),
    });
  }
  function introBoldPara(text) {
    const STARTS = /^(Актуальн|Мет(?:ою|а\s)|Завдання|Для досягн|Для вирішен|Об.єкт|Предмет|Метод(?:и|ологічн)|Наукова новизна|Практична знач|Апробац|Структур|Теоретико|Матеріал|Хронологічн)/i;
    if (!STARTS.test(text)) return bodyPara(text);
    let boldEnd = -1;
    const colon = text.indexOf(':');
    if (colon > 0 && colon < 120) {
      boldEnd = colon + 1;
    } else {
      const dashIdx = text.indexOf(' – ') !== -1 ? text.indexOf(' – ') : text.indexOf(' — ');
      if (dashIdx > 0 && dashIdx < 80) {
        boldEnd = dashIdx + 2;
      } else {
        const dot = text.indexOf('.');
        if (dot > 0 && dot < 50) {
          boldEnd = dot + 1;
        } else {
          const єIdx = text.indexOf(' є ');
          if (єIdx > 0 && єIdx < 60) {
            boldEnd = єIdx + 2;
          } else {
            const полягIdx = text.indexOf(' полягає');
            if (полягIdx > 0 && полягIdx < 60) boldEnd = полягIdx;
            else {
              const становIdx = text.indexOf(' становлять');
              if (становIdx > 0 && становIdx < 70) boldEnd = становIdx;
            }
          }
        }
      }
    }
    if (boldEnd <= 0) return bodyPara(text);
    const boldPart = text.slice(0, boldEnd);
    const restPart = text.slice(boldEnd);
    return new Paragraph({
      indent: { firstLine: INDENT },
      spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 },
      alignment: AlignmentType.BOTH,
      children: [
        new TextRun({ text: boldPart, font: FONT, size: SIZE, bold: true, color: "000000" }),
        ...(restPart ? parseTextWithCitations(restPart, "000000") : []),
      ],
    });
  }
  function listPara(text) {
    return new Paragraph({
      indent: { left: INDENT, hanging: 360 },
      spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 },
      alignment: AlignmentType.BOTH,
      children: parseTextWithCitations(text, "000000"),
    });
  }
  function numberedListPara(text) {
    return new Paragraph({
      indent: { left: INDENT, hanging: 360 },
      spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 },
      alignment: AlignmentType.BOTH,
      children: parseTextWithCitations(text, "000000"),
    });
  }
  function heading1(text) {
    return new Paragraph({
      heading: HeadingLevel.HEADING_1,
      spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 },
      alignment: AlignmentType.CENTER, indent: { firstLine: 0 },
      children: [new TextRun({ text: keepHeadingCase ? text : text.toUpperCase(), font: FONT, size: SIZE, bold: true, color: "000000" })],
    });
  }
  function headingSubsection(text) {
    return new Paragraph({
      heading: HeadingLevel.HEADING_2,
      spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 },
      alignment: AlignmentType.BOTH, indent: { firstLine: INDENT },
      children: [new TextRun({ text, font: FONT, size: SIZE, bold: true, color: "000000" })],
    });
  }
  function makeTableDocx(lines) {
    const border = { style: BorderStyle.SINGLE, size: 1, color: "000000" };
    const cellBorders = { top: border, bottom: border, left: border, right: border };
    const filteredLines = lines.filter(l => !/^\s*\|[-:| ]+\|\s*$/.test(l));
    const rawRows = filteredLines.map(l => l.replace(/^\|/, "").replace(/\|$/, "").split("|").map(c => c.trim()));
    const headerCount = rawRows[0]?.length || 0;
    // Якщо джерело розбило один рядок таблиці на кілька фізичних "|"-рядків
    // (клітинок менше, ніж у шапці), доклеюємо продовження до попереднього
    // рядка замість того, щоб рендерити його як окремий кривий рядок.
    const mergedRows = [];
    for (const cells of rawRows) {
      const prev = mergedRows[mergedRows.length - 1];
      if (prev && headerCount > 0 && cells.length < headerCount && prev.length < headerCount) {
        prev.push(...cells);
      } else {
        mergedRows.push(cells);
      }
    }
    const rows = mergedRows.map((cells, rowIndex) => {
      const isHeader = rowIndex === 0;
      return new TableRow({
        children: cells.map(cellText =>
          new TableCell({
            borders: cellBorders,
            margins: { left: 57, right: 57, top: 57, bottom: 57 },
            children: [new Paragraph({
              alignment: isHeader ? AlignmentType.CENTER : AlignmentType.LEFT,
              spacing: { line: 240, lineRule: "exact", before: 0, after: 0 },
              children: [new TextRun({ text: cellText, font: FONT, size: SIZE_NUM, color: "000000", bold: isHeader && !!methodInfo?.formatting?.tableHeaderBold })],
            })],
          })
        ),
      });
    });
    return new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows,
    });
  }

  function makeBlocks(text, secLabel, isIntro = false) {
    if (!text) return [];
    const result = [];
    const lines = normalizeLooseTableLines(text.split("\n"));
    resolvedFigNums = new Set();
    for (let k = 0; k < lines.length; k++) {
      const t = lines[k].trim();
      const dm = t.startsWith("\x00DIAGRAM") && t.endsWith("\x00") ? t.slice(8, -1) : null;
      const cm = t.match(CLIENT_IMAGE_MARKER_RE);
      const rm = t.match(READY_IMAGE_MARKER_RE);
      const hasImg = dm !== null ? !!diagramImages[Number(dm)] : cm ? !!clientImages[Number(cm[1])] : rm ? !!readyImages[Number(rm[1])] : false;
      if (!hasImg) continue;
      let j = k + 1;
      while (j < lines.length && !lines[j].trim()) j++;
      const capLine = j < lines.length ? lines[j].trim() : "";
      const numMatch = capLine.match(figNumRe);
      if (numMatch) resolvedFigNums.add(numMatch[1]);
    }
    let firstContentLine = true;
    let i = 0;
    let taskMode = false;
    let taskNum = 0;
    let lastWasDiagramTable = false;
    const TASK_HEADER_RE = /^(Завдання дослідження|Для досягнення мети|Для вирішення поставлених)/i;
    const INTRO_KEYWORD_RE = /^(Актуальн|Мета[\s.–—]|Метою|Завдання|Для досягн|Для вирішен|Об.єкт|Предмет|Метод(?:и|ологічн)|Наукова|Практична|Апробац|Структур|Теоретико|Матеріал|Хронологічн)/i;
    while (i < lines.length) {
      const line = lines[i];
      const trimmedLine = line.trim();
      const diagMatch = trimmedLine.startsWith("\x00DIAGRAM") && trimmedLine.endsWith("\x00")
        ? trimmedLine.slice(8, -1)
        : null;
      if (diagMatch !== null) {
        const img = diagramImages[Number(diagMatch)];
        if (img) {
          result.push(new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 },
            children: [new ImageRun({ data: img.data, transformation: { width: img.width, height: img.height } })],
          }));
          lastWasDiagramTable = true;
        } else {
          lastWasDiagramTable = false;
        }
        i++;
        continue;
      }
      const clientImgMatch = trimmedLine.match(CLIENT_IMAGE_MARKER_RE);
      if (clientImgMatch) {
        const img = clientImages[Number(clientImgMatch[1])];
        if (img) {
          const { width, height } = scaleClientImage(img.width, img.height);
          result.push(new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 },
            children: [new ImageRun({ data: img.data, transformation: { width, height } })],
          }));
          lastWasDiagramTable = true;
        } else {
          lastWasDiagramTable = false;
        }
        i++;
        continue;
      }
      const readyImgMatch = trimmedLine.match(READY_IMAGE_MARKER_RE);
      if (readyImgMatch) {
        // картинки немає (не вмістилась у ліміт, EMF/WMF тощо) — маркер просто не виводимо, підпис лишається
        const img = readyImages[Number(readyImgMatch[1])];
        if (img) {
          const { width, height } = scaleDrawingImage(img.width, img.height);
          result.push(new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 },
            children: [new ImageRun({ data: img.data, transformation: { width, height } })],
          }));
        }
        lastWasDiagramTable = !!img;
        i++;
        continue;
      }
      if (isFenceLine(line)) {
        const { codeLines, nextIndex } = readFencedBlock(lines, i);
        result.push(...codeListingParagraphs(codeLines, methodInfo));
        result.push(new Paragraph({ spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 }, children: [] }));
        i = nextIndex;
        continue;
      }
      if (/^\s*\|/.test(line)) {
        const tableLines = [];
        while (i < lines.length && /^\s*\|/.test(lines[i])) {
          tableLines.push(lines[i]);
          i++;
        }
        lastWasDiagramTable = false;
        if (tableLines.filter(l => !/^\s*\|[-:| ]+\|\s*$/.test(l)).length > 0) {
          result.push(makeTableDocx(tableLines));
          result.push(new Paragraph({ spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 }, children: [] }));
        }
        continue;
      }
      if (twRe.test(line.trim()) && isFollowedByTable(lines, i)) {
        const fmt = methodInfo?.formatting || {};
        const tf = fmt.tableFormat || "";
        const tAlignRight = fmt.tableNumberRight ?? /правий|right|справа|верхн.*кут/i.test(tf);
        const tCenter    = fmt.tableTitleCenter ?? /по\s*центру.*назв|назв.*по\s*центру|центр/i.test(tf);
        const tBold      = fmt.tableTitleBold   ?? /жирн|bold/i.test(tf);
        const tTwoLine = tAlignRight && (tCenter || tBold);
        const tAlign = tAlignRight ? AlignmentType.RIGHT : AlignmentType.BOTH;
        const dashIdx = line.search(/ [–\-] /);
        if (tTwoLine && dashIdx !== -1) {
          const numPart = line.trim().substring(0, dashIdx).trim();
          const namePart = line.trim().substring(dashIdx + 3).trim();
          result.push(new Paragraph({
            alignment: AlignmentType.RIGHT,
            spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 },
            indent: { firstLine: 0 },
            children: [new TextRun({ text: numPart, font: FONT, size: SIZE, color: "000000" })],
          }));
          result.push(new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 },
            indent: { firstLine: 0 },
            children: [new TextRun({ text: namePart, font: FONT, size: SIZE, color: "000000" })],
          }));
        } else {
          result.push(new Paragraph({
            alignment: tAlignRight ? AlignmentType.RIGHT : AlignmentType.BOTH,
            spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 },
            indent: { firstLine: tAlignRight ? 0 : INDENT },
            children: [new TextRun({ text: line.trim(), font: FONT, size: SIZE, bold: tBold, color: "000000" })],
          }));
        }
        i++;
        continue;
      }
      if (fwRe.test(line.trim())) {
        const ff = methodInfo?.formatting?.figureFormat || "";
        const fBold = /жирн|bold/i.test(ff);
        const fItalic = /курсив|italic/i.test(ff);
        const isResolved = lastWasDiagramTable;
        lastWasDiagramTable = false;
        result.push(new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { line: LINE, lineRule: "auto", before: 0, after: LINE },
          children: [new TextRun({ text: line.trim(), font: FONT, size: SIZE, bold: fBold, italics: fItalic, color: isResolved ? "000000" : "B85C00" })],
        }));
        i++;
        continue;
      }
      const isHyphenList = /^[-*]\s+/.test(line.trim());
      const isNumberedList = /^\s*\d+[.)]\s+/.test(line);
      const numMatchRaw = isNumberedList ? line.trim().match(/^(\d+[.)]\s*)(.*)/) : null;
      const raw = cleanMarkdown(line);
      if (!raw) { i++; continue; }
      if (isIntro) {
        if (TASK_HEADER_RE.test(raw)) {
          taskMode = true;
          taskNum = 0;
        } else if (taskMode && INTRO_KEYWORD_RE.test(raw)) {
          taskMode = false;
        }
      }
      if (firstContentLine && isDuplicateTitle(line, secLabel)) { firstContentLine = false; i++; continue; }
      firstContentLine = false;
      if (/^[–—]\s/.test(raw) || isHyphenList) {
        const listText = /^[–—]\s/.test(raw) ? raw : `– ${raw}`;
        result.push(listPara(listText));
        i++; continue;
      }
      if (isNumberedList && numMatchRaw) {
        if (taskMode) taskNum++;
        const numPrefix = numMatchRaw[1].trimEnd();
        const numBody = cleanMarkdown(numMatchRaw[2] || "");
        result.push(numberedListPara(`${numPrefix} ${numBody}`));
        i++; continue;
      }
      if (isIntro && taskMode && !TASK_HEADER_RE.test(raw)) {
        taskNum++;
        result.push(numberedListPara(`${taskNum}. ${raw}`));
        i++; continue;
      }
      lastWasDiagramTable = false;
      result.push(isIntro ? introBoldPara(raw) : bodyPara(raw));
      i++;
    }
    return result;
  }

  function sourceParaChildren(text) {
    const URL_RE = /(https?:\/\/[^\s]+)/;
    const parts = text.split(URL_RE);
    return parts.flatMap(part => {
      if (URL_RE.test(part)) {
        const cleanUrl = part.replace(/[.,;:!?)]+$/, '');
        const tail = part.slice(cleanUrl.length);
        const link = new ExternalHyperlink({
          link: cleanUrl,
          children: [new TextRun({ text: cleanUrl, font: FONT, size: SIZE, color: "0563C1", underline: {} })],
        });
        return tail ? [link, new TextRun({ text: tail, font: FONT, size: SIZE, color: "000000" })] : [link];
      }
      // Парсимо *курсив* всередині звичайного тексту
      const runs = [];
      const italicRe = /\*([^*]+)\*/g;
      let last = 0, m;
      while ((m = italicRe.exec(part)) !== null) {
        if (m.index > last) runs.push(new TextRun({ text: part.slice(last, m.index), font: FONT, size: SIZE, color: "000000" }));
        runs.push(new TextRun({ text: m[1], font: FONT, size: SIZE, color: "000000", italics: true }));
        last = m.index + m[0].length;
      }
      if (last < part.length) runs.push(new TextRun({ text: part.slice(last), font: FONT, size: SIZE, color: "000000" }));
      return runs;
    });
  }
  function sourcePara(text) {
    const cleaned = text.replace(/\*\*(.+?)\*\*/g, "$1").trim();
    if (!cleaned) return null;
    return new Paragraph({
      spacing: { line: LINE, lineRule: "auto", before: 0, after: Math.round(LINE * 0.3) },
      alignment: AlignmentType.BOTH,
      indent: { firstLine: INDENT },
      children: sourceParaChildren(cleaned),
    });
  }
  function sourceParaWithBookmark(text, refNum) {
    const cleaned = text.replace(/\*\*(.+?)\*\*/g, "$1").trim();
    if (!cleaned) return null;
    const numMatch = cleaned.match(/^(\d+[\.\)]\s*)/);
    let children;
    if (numMatch) {
      const prefix = numMatch[1];
      const rest = cleaned.slice(prefix.length);
      children = [
        new Bookmark({
          id: `ref_${refNum}`,
          children: [new TextRun({ text: prefix, font: FONT, size: SIZE, color: "000000" })],
        }),
        ...sourceParaChildren(rest),
      ];
    } else {
      children = sourceParaChildren(cleaned);
    }
    return new Paragraph({
      spacing: { line: LINE, lineRule: "auto", before: 0, after: Math.round(LINE * 0.3) },
      alignment: AlignmentType.BOTH,
      indent: { firstLine: INDENT },
      children,
    });
  }

  const children = [];

  const alignMap = { left: AlignmentType.LEFT, center: AlignmentType.CENTER, right: AlignmentType.RIGHT };
  const topicStr = stripPresentationSuffix(info?.topic) || "";
  const currentYear = new Date().getFullYear().toString();
  const practiceFieldMap = {
    "[ПІБ]": info?.studentName,
    "[ГРУПА]": info?.studentGroup,
    "[КУРС]": info?.course,
    "[БАЗА_ПРАКТИКИ]": info?.companyName,
    "[КЕРІВНИК_ПІДПРИЄМСТВА]": info?.supervisorCompany,
    "[КЕРІВНИК_КАФЕДРИ]": info?.supervisorUniversity,
    "[ДАТА_ПОЧАТКУ]": info?.dateStart,
    "[ДАТА_КІНЦЯ]": info?.dateEnd,
    // Узагальнені токени титулки (не лише практика) — методичка іноді наводить у Додатках
    // уже ЗАПОВНЕНИЙ приклад титулки (чуже ім'я/кафедра), і крок читання методички заміняє
    // такі конкретні значення на ці токени, щоб вони не потрапили в роботу клієнта як є.
    // Дані беруться з аналізу тексту замовлення (buildTemplateAnalysisPrompt) — якщо клієнт
    // їх явно не вказав, лишається видимий плейсхолдер "___________", який треба вручну
    // заповнити на кроці "Готово".
    "[ФАКУЛЬТЕТ]": info?.faculty,
    "[КАФЕДРА]": info?.department,
    "[КЕРІВНИК]": info?.supervisorUniversity,
    // degreeLevel/specialty існують як окремі поля лише в потоці практики (PracticePage) —
    // для курсових/кваліфікаційних/магістерських робіт клієнт їх окремо не вказує, тож без
    // фолбеків тут ці токени завжди підставляли б порожній рядок і в титулку проривався б
    // буквальний ступінь/спеціальність чужого зразка з методички.
    "[ОКР]": info?.degreeLevel || deriveDegreeLevelFromType(info?.type),
    "[СПЕЦІАЛЬНІСТЬ]": info?.specialty || info?.direction,
    "[ГАЛУЗЬ_ЗНАНЬ]": info?.knowledgeField,
    "[ВИД_ПРАКТИКИ]": info?.practiceLabel,
  };
  const applyTopic = (t) => {
    let s = topicStr ? t.replace(/\[ТЕМА\]/g, topicStr) : t;
    if (topicStr) {
      s = s.replace(/(Тема\s*[:：]\s*«\s*)([_\s]*)(\s*»)/g, `$1${topicStr}$3`);
      s = s.replace(/\(найменування\s+теми\)/gi, topicStr);
      s = s.replace(/\(назва\s+теми\)/gi, topicStr);
    }
    s = s.replace(/\[РІК\]/g, currentYear).replace(/\[ДАТА\]/g, currentYear);
    s = s.replace(/(?<![/\d])20\d{2}(?![/\d])/g, currentYear);
    for (const [token, value] of Object.entries(practiceFieldMap)) {
      if (s.includes(token)) s = s.split(token).join(value || "___________________");
    }
    // Страховка, якщо аналіз зразка щоденника/методички не розпізнав фразу "вид практики" і не
    // підставив токен [ВИД_ПРАКТИКИ] — тоді в титулці лишається буквальний вид практики зі
    // зразка (напр. "переддипломної"), який може не збігатись із фактичним info.practiceType
    // (напр. коли зразок узятий з іншого курсу/етапу навчання). Виправляємо будь-яку іншу форму
    // виду практики поруч зі словом "практики" на правильну.
    const correctGenitive = info?.practiceType ? PRACTICE_TYPE_GENITIVE[info.practiceType] : null;
    if (correctGenitive) {
      const wrongForms = Object.values(PRACTICE_TYPE_GENITIVE).filter(f => f !== correctGenitive);
      if (wrongForms.length) {
        const wrongRe = new RegExp(`(?:${wrongForms.join("|")})(\\s+практики)`, "gi");
        s = s.replace(wrongRe, `${correctGenitive}$1`);
      }
    }
    return s;
  };
  const RIGHT_LINE_RE = /^(Група|Курс|ПІБ\s+студента|ПІБ\s+керівника)\s*:/i;
  const buildDefaultTitlePageLines = () => [
    { text: "МІНІСТЕРСТВО ОСВІТИ І НАУКИ УКРАЇНИ", align: "center", bold: true },
    { text: info?.university || "[Назва університету]", align: "center" },
    ...(info?.faculty ? [{ text: info.faculty, align: "center" }] : []),
    ...(info?.department ? [{ text: `Кафедра ${info.department}`, align: "center" }] : []),
    { text: "", align: "center", spaceBefore: 960 },
    { text: (info?.type || "КУРСОВА РОБОТА").toUpperCase(), align: "center", bold: true },
    ...(info?.subject ? [{ text: `з дисципліни: ${info.subject}`, align: "center" }] : []),
    { text: `на тему: «${topicStr || "[тема]"}»`, align: "center" },
    { text: "", align: "center", spaceBefore: 2880 },
    { text: `Група: ${info?.studentGroup || "___________"}`, align: "right" },
    { text: `Курс: ${info?.course || "___________"}`, align: "right" },
    { text: `ПІБ студента: ${info?.studentName || "___________"}`, align: "right" },
    { text: `ПІБ керівника: ${info?.supervisorUniversity || "___________"}`, align: "right" },
    { text: "", align: "center", spaceBefore: 3840 },
    { text: info?.city ? `${info.city} – ${currentYear}` : currentYear, align: "center" },
  ];
  // Компенсує найбільший (типово останній, перед "Місто – Рік") spaceBefore титулки так, щоб
  // сума висот усіх рядків точно дорівнювала висоті сторінки — незалежно від того, скільки
  // фізичних рядків реально займуть довга тема роботи чи довге ПІБ. Без цього нижній блок
  // зсувається на фіксовану "оцінку на око" ШІ/дефолту й титулка або не дотягує до низу
  // сторінки, або переливається на другу.
  function autoFitTitlePageLines(lines) {
    if (!Array.isArray(lines) || !lines.length) return lines;

    const contentWidth = 11906 - L - R;
    const pageContentHeight = 16838 - T - B;
    const lineHeightTwips = fontSizeHalfPt => Math.round((fontSizeHalfPt / 2) * 1.15 * 20);
    const estimateLineCount = (text, fontSizeHalfPt) => {
      if (!text) return 1;
      const avgCharWidth = (fontSizeHalfPt / 2) * 20 * 0.5; // приблизна середня ширина символу ~0.5em
      const charsPerLine = Math.max(1, Math.floor(contentWidth / avgCharWidth));
      return Math.max(1, Math.ceil(text.length / charsPerLine));
    };

    // Порожні рядки-заповнювачі (без тексту) — це так само вертикальний проміжок, як і
    // spaceBefore, просто закодований AI по-іншому (кілька порожніх абзаців підряд замість
    // одного числа-відступу). Якщо їх не звести до spaceBefore тут, масштабування нижче їх
    // не бачить — вони лишаються "незгортними" рядками фіксованої висоти і можуть самі по
    // собі виштовхнути титулку на другу сторінку. Тому зливаємо кожен прогін порожніх рядків
    // у spaceBefore наступного змістовного рядка — весь "повітряний" простір потрапляє під
    // однакове подальше масштабування, незалежно від того, як саме AI його закодував.
    const normalized = [];
    let pendingGap = 0;
    for (const item of lines) {
      if (!item.text || !item.text.trim()) {
        pendingGap += (item.spaceBefore || 0) + lineHeightTwips(toNum(item.fontSize, SIZE / 2) * 2);
        continue;
      }
      normalized.push({ ...item, spaceBefore: (item.spaceBefore || 0) + pendingGap });
      pendingGap = 0;
    }
    if (pendingGap && normalized.length) {
      normalized.push({ text: "", align: "center", spaceBefore: pendingGap });
    }
    if (!normalized.length) return lines;

    // Замість підганяння ОДНОГО "гнучкого" рядка (AI все одно вгадує абсолютні twips
    // на око, дивлячись на зразок, і легко помиляється) масштабуємо ВСІ задані відступи
    // одним спільним коефіцієнтом. Це зберігає їхні відносні пропорції зі зразка методички
    // (який проміжок був більшим/меншим за інший — той самий ритм лишається), і водночас
    // гарантує, що сума точно влізе на сторінку — незалежно від того, наскільки AI
    // помилився з абсолютними числами чи наскільки тема/ПІБ студента довші/коротші за
    // приклад у методичці.
    const gapSum = normalized.reduce((sum, item) => sum + (item.spaceBefore || 0), 0);
    if (gapSum <= 0) return normalized;

    const textHeight = normalized.reduce((sum, item) => {
      const fs = toNum(item.fontSize, SIZE / 2) * 2;
      return sum + estimateLineCount(item.text, fs) * lineHeightTwips(fs);
    }, 0);

    // estimateLineCount — груба оцінка (середня ширина символу ~0.5em), тому може трохи
    // недооцінити реальний обгорнутий рядок (напр. довгу тему в лапках) — SAFETY_BUFFER
    // залишає запас ~одного рядка висоти, щоб неточність оцінки не зіштовхувала останній
    // рядок (місто — рік) на другу сторінку.
    const SAFETY_BUFFER = 600;
    const availableGapBudget = Math.max(0, pageContentHeight - textHeight - SAFETY_BUFFER);
    const scale = availableGapBudget / gapSum;
    return normalized.map(item =>
      item.spaceBefore ? { ...item, spaceBefore: Math.round(item.spaceBefore * scale) } : item);
  }

  let resolvedLines = autoFitTitlePageLines(titlePageLines?.length
    ? titlePageLines.map(item => ({ ...item, text: applyTopic(item.text) }))
    : (titlePage?.trim()
      ? titlePage.split("\n").map(text => ({ text: applyTopic(text), align: RIGHT_LINE_RE.test(text.trim()) ? "right" : "center" }))
      : buildDefaultTitlePageLines()));
  // Страховка від недогляду кроку читання методички: якщо titlePageTemplate узятий із
  // ЗАПОВНЕНОГО зразка в Додатках методички (напр. "на здобуття освітнього ступеня
  // «бакалавр»") і крок токенізації не розпізнав ступінь як чужі дані для заміни на [ОКР],
  // буквальний ступінь чужого зразка потрапляє прямо в титулку клієнта. На відміну від
  // ПІБ/теми (які без токена просто лишаються порожніми), ступінь тут можна перевірити
  // детерміновано — він завжди випливає з типу роботи ("Магістерська" → "магістр") — тому
  // будь-яке розходження виправляємо кодом, а не покладаємось лише на слухняність ШІ.
  const correctDegreeLevel = info?.degreeLevel || deriveDegreeLevelFromType(info?.type);
  if (correctDegreeLevel && Array.isArray(resolvedLines)) {
    resolvedLines = resolvedLines.map(item =>
      item.text ? { ...item, text: fixMismatchedDegreeWord(item.text, correctDegreeLevel) } : item);
  }
  if (resolvedLines) {
    resolvedLines.forEach((item, idx) => {
      const itemSize = toNum(item.fontSize, SIZE / 2) * 2;
      const spaceBefore = item.spaceBefore != null ? item.spaceBefore : 0;
      children.push(new Paragraph({
        alignment: alignMap[item.align] || AlignmentType.CENTER,
        spacing: { line: LINE_SINGLE, lineRule: "auto", before: spaceBefore, after: 0 },
        indent: { firstLine: 0 },
        children: [new TextRun({ text: item.text, font: FONT, size: itemSize, bold: !!item.bold, color: "000000" })],
      }));
    });
  } else {
    children.push(new Paragraph({ spacing: { before: 0, after: 0, line: LINE, lineRule: "auto" }, children: [] }));
  }

  // ── Завдання на курсову/кваліфікаційну роботу (якщо знайдено у зразку/методичці), окрема сторінка ──
  const hasTaskSheet = Array.isArray(methodInfo?.taskSheetTemplate) && methodInfo.taskSheetTemplate.length > 0;
  if (hasTaskSheet) {
    methodInfo.taskSheetTemplate.forEach((item, idx) => {
      const itemSize = toNum(item.fontSize, SIZE / 2) * 2;
      children.push(new Paragraph({
        pageBreakBefore: idx === 0,
        alignment: alignMap[item.align] || AlignmentType.CENTER,
        spacing: { line: LINE_SINGLE, lineRule: "auto", before: item.spaceBefore || 0, after: 0 },
        indent: { firstLine: 0 },
        children: [new TextRun({ text: applyTopic(item.text), font: FONT, size: itemSize, bold: !!item.bold, color: "000000" })],
      }));
    });
  }

  // ── Календарний план виконання роботи (якщо знайдено) — продовжує сторінку завдання, або власна сторінка ──
  const calendarPlanLines = methodInfo?.calendarPlanTable?.trim()
    ? methodInfo.calendarPlanTable.split("\n").map(applyTopic).filter(l => /^\s*\|/.test(l))
    : [];
  if (calendarPlanLines.length) {
    children.push(new Paragraph({
      pageBreakBefore: !hasTaskSheet,
      alignment: AlignmentType.CENTER,
      spacing: { line: LINE_SINGLE, lineRule: "auto", before: 240, after: 120 },
      children: [new TextRun({ text: "КАЛЕНДАРНИЙ ПЛАН", font: FONT, size: SIZE, bold: true, color: "000000" })],
    }));
    children.push(makeTableDocx(calendarPlanLines));
    children.push(new Paragraph({ spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 }, children: [] }));
  }

  // ── Анотація (укр + англ), кожна мова — окрема сторінка, перед змістом ──
  [annotationUk, annotationEn].filter(a => a?.trim()).forEach(annotationText => {
    let isFirstLine = true;
    annotationText.replace(/'/g, '’').split("\n").forEach(line => {
      const trimmed = line.trim();
      if (!trimmed) return;
      const isHeading = isFirstLine && /^(АНОТАЦІЯ|РЕФЕРАТ|ABSTRACT)$/i.test(trimmed);
      children.push(new Paragraph({
        pageBreakBefore: isFirstLine,
        alignment: isHeading ? AlignmentType.CENTER : AlignmentType.BOTH,
        indent: isHeading ? { firstLine: 0 } : { firstLine: INDENT },
        spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 },
        children: [new TextRun({ text: trimmed, font: FONT, size: SIZE, bold: isHeading, color: "000000" })],
      }));
      if (isHeading) {
        children.push(new Paragraph({ spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 }, children: [] }));
      }
      isFirstLine = false;
    });
  });

  if (!skipToc) {
    children.push(new Paragraph({
      pageBreakBefore: true,
      alignment: AlignmentType.CENTER,
      spacing: { line: LINE_SINGLE, lineRule: "auto", before: 0, after: LINE_SINGLE * 2 },
      children: [new TextRun({ text: lc.toc, font: FONT, size: SIZE, bold: true, color: "000000" })],
    }));
    children.push(new TableOfContents(lc.toc, {
      hyperlink: true,
      headingStyleRange: "1-2",
    }));
    children.push(new Paragraph({
      spacing: { line: LINE_SINGLE, lineRule: "auto", before: 0, after: 0 },
      children: [],
    }));
  }

  let lastChapter = null;
  let firstMainSec = true;

  for (let i = 0; i < displayOrder.length; i++) {
    const sec = displayOrder[i]; const txt = numberedContent[sec.id];
    // headingOnly — підрозділ-«шапка» без власного тексту (готова частина клієнта,
    // де назва групи стоїть одразу перед вкладеним пунктом на кшталt "2.1.1") —
    // заголовок усе одно друкуємо, просто без абзаців тіла під ним.
    if (!txt && !sec.headingOnly) continue;
    const isMain = !["intro", "conclusions", "sources"].includes(sec.type);
    const isChapterConc = sec.type === "chapter_conclusion";
    const isSubsection = isMain && !sec.chapterOnly && (/^\d+\.\d+/.test(sec.id) || isChapterConc);
    const thisChapter = isSubsection ? sec.id.split(".")[0] : null;

    let needsPageBreak = true;
    if (firstMainSec) { needsPageBreak = true; firstMainSec = false; }
    else if (isSubsection) {
      const prevSec = displayOrder.slice(0, i).reverse().find(s => numberedContent[s.id]);
      const prevIsSubsection = prevSec && !["intro", "conclusions", "sources"].includes(prevSec.type) && (/^\d+\.\d+/.test(prevSec.id || "") || prevSec.type === "chapter_conclusion");
      needsPageBreak = !prevIsSubsection || thisChapter !== prevSec?.id?.split(".")?.[0];
    }
    if (needsPageBreak) children.push(new Paragraph({ pageBreakBefore: true, spacing: { before: 0, after: 0, line: LINE, lineRule: "auto" }, children: [] }));

    if (sec.type === "sources") {
      children.push(heading1(sec.label));
      children.push(new Paragraph({ spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 }, children: [] }));
      txt.split("\n").forEach(line => {
        const cleaned = line.replace(/\*\*(.+?)\*\*/g, "$1").replace(/\*(.+?)\*/g, "$1").trim();
        const numMatch = cleaned.match(/^(\d+)[\.\)]/);
        if (numMatch) {
          const p = sourceParaWithBookmark(line, parseInt(numMatch[1]));
          if (p) children.push(p);
        } else {
          const p = sourcePara(line);
          if (p) children.push(p);
        }
      });
      continue;
    }

    if (!isSubsection) {
      children.push(heading1(sec.label));
      if (sec.type === "intro" || sec.type === "conclusions" || (isMain && !isSubsection)) {
        children.push(new Paragraph({ spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 }, children: [] }));
      }
    } else {
      if (thisChapter !== lastChapter) {
        lastChapter = thisChapter;
        // Префікс "РОЗДІЛ 2" / "第2章" / "2. FEJEZET" — за мовою роботи (chapterHeadingPrefix)
        const rawTitle = sec.sectionTitle || chapterHeadingPrefix(info?.language, thisChapter);
        const alreadyHasPrefix = chapterWordRe().test(rawTitle.trim()) || rawTitle.trim().startsWith("第");
        const chapterLabel = alreadyHasPrefix ? rawTitle.trim() : `${chapterHeadingPrefix(info?.language, thisChapter)}. ${rawTitle}`;
        children.push(heading1(chapterLabel));
      }
      children.push(new Paragraph({ spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 }, children: [] }));
      children.push(headingSubsection(sec.label));
      children.push(new Paragraph({ spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 }, children: [] }));
    }
    let processedTxt = txt;
    if (isChapterConc) {
      // Стрипаємо перший рядок якщо AI дублює назву "Висновки до розділу N" (з markdown-заголовком або без)
      processedTxt = txt
        .replace(/^\s*#{1,6}\s+[^\n]*\n?/, "")
        .replace(/^\s*(?:висновк[^\s]*\s+до\s+|wnioski\s+do\s+|conclusiones\s+(?:del|al)\s+|závěry\s+ke\s+|závery\s+ku\s+|schlussfolgerungen\s+zu\s+)[^\n]*\n?/i, "")
        .trimStart();
    } else if (isMain && !isSubsection) {
      // Стрипаємо перший рядок якщо AI дублює заголовок розділу (РОЗДІЛ N. або # Назва)
      processedTxt = txt
        .replace(/^\s*(?:#{1,6}\s*)?розділ\s+\d+[^\n]*\n?/i, "")
        .replace(/^\s*#{1,6}\s+[^\n]*\n?/, "")
        .trimStart();
    }
    children.push(...makeBlocks(processedTxt, sec.label, sec.type === "intro"));
  }

  if (normAppendices && normAppendices.trim()) {
    children.push(new Paragraph({ pageBreakBefore: true, spacing: { before: 0, after: 0, line: LINE, lineRule: "auto" }, children: [] }));
    children.push(heading1(lc.appendixWord));
    const appLines = normAppendices.split("\n");
    let ai = 0;
    const fmt = methodInfo?.formatting || {};
    const tf = fmt.tableFormat || "";
    const tAlignRight = fmt.tableNumberRight ?? /правий|right|справа|верхн.*кут/i.test(tf);
    const tCenter    = fmt.tableTitleCenter ?? /по\s*центру.*назв|назв.*по\s*центру|центр/i.test(tf);
    const tBold      = fmt.tableTitleBold   ?? /жирн|bold/i.test(tf);
    while (ai < appLines.length) {
      const line = appLines[ai];
      const trimmedAppLine = line.trim();
      const appDiagMatch = trimmedAppLine.startsWith("\x00DIAGRAM") && trimmedAppLine.endsWith("\x00")
        ? trimmedAppLine.slice(8, -1)
        : null;
      if (appDiagMatch !== null) {
        const img = appendixDiagramImages[Number(appDiagMatch)];
        if (img) {
          children.push(new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 },
            children: [new ImageRun({ data: img.data, transformation: { width: img.width, height: img.height } })],
          }));
        }
        ai++;
        continue;
      }
      if (isFenceLine(line)) {
        const { codeLines, nextIndex } = readFencedBlock(appLines, ai);
        children.push(...codeListingParagraphs(codeLines, methodInfo));
        children.push(new Paragraph({ spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 }, children: [] }));
        ai = nextIndex;
        continue;
      }
      if (/^\s*\|/.test(line)) {
        const tableLines = [];
        while (ai < appLines.length && /^\s*\|/.test(appLines[ai])) { tableLines.push(appLines[ai]); ai++; }
        if (tableLines.filter(l => !/^\s*\|[-:| ]+\|\s*$/.test(l)).length > 0) {
          children.push(makeTableDocx(tableLines));
          children.push(new Paragraph({ spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 }, children: [] }));
        }
        continue;
      }
      const raw = line.replace(/\*\*(.+?)\*\*/g, "$1").replace(/\*(.+?)\*/g, "$1").trim();
      if (!raw) {
        children.push(new Paragraph({ spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 }, children: [] }));
        ai++; continue;
      }
      if (LISTING_CAPTION_RE.test(raw) || raw.startsWith(`${lc.listingWord} `)) {
        children.push(new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { line: LINE, lineRule: "auto", before: Math.round(LINE * 0.5), after: 0 },
          children: [new TextRun({ text: raw, font: FONT, size: SIZE, bold: true, color: "000000" })],
        }));
        ai++; continue;
      }
      if (appendixLabelRe().test(raw)) {
        children.push(new Paragraph({
          alignment: AlignmentType.RIGHT,
          indent: { firstLine: 0 },
          spacing: { line: LINE, lineRule: "auto", before: LINE, after: Math.round(LINE / 2) },
          children: [new TextRun({ text: raw.toUpperCase(), font: FONT, size: SIZE, bold: false, color: "000000" })],
        }));
        ai++; continue;
      }
      if (/^Таблиця\s+\w/.test(raw) || /^Tabelle\s+\w/i.test(raw) || /^Table\s+\w/i.test(raw) || raw.startsWith(`${lc.tableWord} `) || (lc.code === "zh" && /^表\s*\d/.test(raw))) {
        const tTwoLine = tAlignRight && (tCenter || tBold);
        const dashIdx = raw.search(/ [–\-] /);
        if (tTwoLine && dashIdx !== -1) {
          const numPart = raw.substring(0, dashIdx).trim();
          const namePart = raw.substring(dashIdx + 3).trim();
          children.push(new Paragraph({
            alignment: AlignmentType.RIGHT,
            spacing: { line: LINE, lineRule: "auto", before: Math.round(LINE * 0.5), after: 0 },
            indent: { firstLine: 0 },
            children: [new TextRun({ text: numPart, font: FONT, size: SIZE, color: "000000" })],
          }));
          children.push(new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 },
            indent: { firstLine: 0 },
            children: [new TextRun({ text: namePart, font: FONT, size: SIZE, bold: true, color: "000000" })],
          }));
        } else {
          children.push(new Paragraph({
            alignment: tAlignRight ? AlignmentType.RIGHT : AlignmentType.BOTH,
            spacing: { line: LINE, lineRule: "auto", before: Math.round(LINE * 0.5), after: 0 },
            indent: { firstLine: tAlignRight ? 0 : INDENT },
            children: [new TextRun({ text: raw, font: FONT, size: SIZE, bold: tBold, color: "000000" })],
          }));
        }
        ai++; continue;
      }
      children.push(new Paragraph({
        indent: { firstLine: INDENT },
        spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 },
        alignment: AlignmentType.BOTH,
        children: [new TextRun({ text: raw, font: FONT, size: SIZE, color: "000000" })],
      }));
      ai++;
    }
  }

  // Реальні креслення клієнта — вставляються програмно як окремі додатки в кінці, без згадки в тілі тексту.
  if (drawingImages.some(Boolean)) {
    if (!(normAppendices && normAppendices.trim())) {
      children.push(new Paragraph({ pageBreakBefore: true, spacing: { before: 0, after: 0, line: LINE, lineRule: "auto" }, children: [] }));
      children.push(heading1(lc.appendixWord));
    }
    const abc = lc.appendixLetters || [];
    const usedLetters = new Set();
    const letterRe = appendixLetterRegex();
    let lm;
    while ((lm = letterRe.exec(normAppendices || "")) !== null) usedLetters.add(lm[1].toUpperCase());
    let letterIdx = abc.findIndex(l => !usedLetters.has(l));
    if (letterIdx === -1) letterIdx = Math.max(abc.length - 1, 0);
    clientDrawings.forEach((drawing, idx) => {
      const img = drawingImages[idx];
      if (!img) return;
      const letter = abc[letterIdx] || String(letterIdx + 1);
      letterIdx++;
      const { width, height } = scaleDrawingImage(img.width, img.height);
      children.push(new Paragraph({ pageBreakBefore: true, spacing: { before: 0, after: 0, line: LINE, lineRule: "auto" }, children: [] }));
      children.push(new Paragraph({
        alignment: AlignmentType.RIGHT,
        spacing: { line: LINE, lineRule: "auto", before: 0, after: Math.round(LINE / 2) },
        children: [new TextRun({ text: `${lc.appendixSingular} ${letter}`, font: FONT, size: SIZE, color: "000000" })],
      }));
      children.push(new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { line: LINE, lineRule: "auto", before: 0, after: Math.round(LINE / 2) },
        children: [new TextRun({ text: `${lc.drawingWord} — ${drawing.name}`, font: FONT, size: SIZE, bold: true, color: "000000" })],
      }));
      children.push(new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 },
        children: [new ImageRun({ data: img.data, transformation: { width, height } })],
      }));
    });
  }

  // ── Щоденник практики: статичні канцелярські додатки (з методички, без участі ШІ) ──
  if (diaryArrivalDeparture) {
    const plainLine = (text, opts = {}) => new Paragraph({
      alignment: AlignmentType.LEFT,
      indent: { firstLine: 0 },
      spacing: { line: LINE, lineRule: "auto", before: 0, after: 0, ...opts.spacing },
      children: [new TextRun({ text, font: FONT, size: opts.size || SIZE, bold: !!opts.bold, color: "000000" })],
    });
    children.push(new Paragraph({ pageBreakBefore: true, spacing: { before: 0, after: 0, line: LINE, lineRule: "auto" }, children: [] }));
    children.push(plainLine(`Здобувач вищої освіти ${diaryStudentName || "___________________________"}`));
    children.push(new Paragraph({
      alignment: AlignmentType.CENTER, indent: { firstLine: 0 },
      spacing: { line: LINE, lineRule: "auto", before: 0, after: LINE },
      children: [new TextRun({ text: "(прізвище, ім’я, по батькові)", font: FONT, size: SIZE_NUM, color: "000000" })],
    }));
    children.push(plainLine("прибув на підприємство ___________________________ практику закінчено з оцінкою ___________"));
    children.push(plainLine("МП                                                                              «___» _____________ 20__ року"));
    children.push(plainLine("_________________     (посада, прізвище та ініціали відповідальної особи)", { spacing: { after: LINE } }));
    children.push(plainLine("Вибув з підприємства", { bold: true }));
    children.push(plainLine("МП                                                                              «___» _____________ 20__ року"));
    children.push(plainLine("_________________     (посада, прізвище та ініціали відповідальної особи)"));
  }

  // Календарний графік проходження практики — окрема таблиця по тижнях, яка в офіційних бланках
  // (форма Н-6.03) стоїть ПЕРЕД робочими записами, а не замінює їх. Заповнюється даними, які ШІ
  // згенерував за окремою інструкцією в buildPracticeDiaryPrompt (diaryCalendarGraphRows, розібрані
  // з відповіді кодом через parseDiaryCalendarGraphRows) — якщо їх немає, клітинки лишаються
  // порожніми, як і в самому бланку, для ручного заповнення.
  if (diaryCalendarGraph) {
    const border = { style: BorderStyle.SINGLE, size: 1, color: "000000" };
    const cellBorders = { top: border, bottom: border, left: border, right: border };
    const weeksCount = Math.max(1, Math.min(12, diaryCalendarGraphWeeks || 6));
    const headCell = (text, widthPct) => new TableCell({
      width: { size: widthPct, type: WidthType.PERCENTAGE },
      borders: cellBorders,
      margins: { left: 57, right: 57, top: 57, bottom: 57 },
      children: [new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { line: 240, lineRule: "exact", before: 0, after: 0 },
        children: [new TextRun({ text, font: FONT, size: SIZE_NUM, bold: true, color: "000000" })],
      })],
    });
    const bodyCell = (text = "", alignment = AlignmentType.LEFT) => new TableCell({
      borders: cellBorders,
      margins: { left: 57, right: 57, top: 57, bottom: 57 },
      children: [new Paragraph({ alignment, spacing: { line: 240, lineRule: "exact", before: 0, after: 0 }, children: [new TextRun({ text, font: FONT, size: SIZE_NUM, color: "000000" })] })],
    });
    const numColPct = 6, workColPct = 100 - numColPct - weeksCount * 8 - 12;
    const headerRow = new TableRow({
      children: [
        headCell("№ з/п", numColPct),
        headCell("Назви робіт", workColPct),
        ...Array.from({ length: weeksCount }, (_, i) => headCell(`Тиждень ${i + 1}`, 8)),
        headCell("Відмітки про виконання", 12),
      ],
    });
    const bodyRows = Array.from({ length: 12 }, (_, i) => {
      const row = diaryCalendarGraphRows[i];
      return new TableRow({
        children: [
          new TableCell({
            borders: cellBorders, margins: { left: 57, right: 57, top: 57, bottom: 57 },
            children: [new Paragraph({ alignment: AlignmentType.CENTER, spacing: { line: 240, lineRule: "exact", before: 0, after: 0 }, children: [new TextRun({ text: String(i + 1), font: FONT, size: SIZE_NUM, color: "000000" })] })],
          }),
          bodyCell(row?.name || ""),
          ...Array.from({ length: weeksCount }, (_, w) => bodyCell(row?.weeks?.[w] || "", AlignmentType.CENTER)),
          bodyCell(row ? (row.note || "Виконано") : "", AlignmentType.CENTER),
        ],
      });
    });
    children.push(new Paragraph({ pageBreakBefore: true, spacing: { before: 0, after: 0, line: LINE, lineRule: "auto" }, children: [] }));
    children.push(new Paragraph({
      alignment: AlignmentType.CENTER, indent: { firstLine: 0 },
      spacing: { line: LINE, lineRule: "auto", before: 0, after: LINE },
      children: [new TextRun({ text: "1. Календарний графік проходження практики", font: FONT, size: SIZE, bold: true, color: "000000" })],
    }));
    children.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [headerRow, ...bodyRows] }));

    if (diarySupervisorSignatureBlock) {
      const sigLine = (text) => new Paragraph({
        alignment: AlignmentType.LEFT, indent: { firstLine: 0 },
        spacing: { line: LINE, lineRule: "auto", before: LINE, after: 0 },
        children: [new TextRun({ text, font: FONT, size: SIZE, color: "000000" })],
      });
      children.push(sigLine("Керівники практики:"));
      children.push(sigLine(`від кафедри: _______________     ${diarySupervisorUniversity || "___________________"}`));
      children.push(sigLine(`від підприємства (організації, установи): _______________     ${diarySupervisorCompany || "___________________"}`));
    }
  }

  if (diaryBlankNotesPages) {
    children.push(new Paragraph({ pageBreakBefore: true, spacing: { before: 0, after: 0, line: LINE, lineRule: "auto" }, children: [] }));
    children.push(new Paragraph({
      alignment: AlignmentType.CENTER, indent: { firstLine: 0 },
      spacing: { line: LINE, lineRule: "auto", before: 0, after: LINE },
      children: [new TextRun({ text: diaryCalendarGraph ? "2. Робочі записи під час практики" : "Робочі записи під час практики", font: FONT, size: SIZE, bold: true, color: "000000" })],
    }));
    // diaryWorkRecords — рядки основної таблиці щоденника (розібрані кодом через
    // parseDiaryWorkRecords), по одному на лінований рядок; якщо їх немає (напр. щоденник ще не
    // згенеровано), лишаємо порожні ліновані рядки для рукопису, як і раніше.
    const notesLines = diaryWorkRecords.length ? diaryWorkRecords : Array.from({ length: 28 }, () => "");
    notesLines.forEach(text => {
      children.push(new Paragraph({
        spacing: { line: LINE, lineRule: "auto", before: 0, after: 260 },
        border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: "000000", space: 1 } },
        children: [new TextRun({ text, font: FONT, size: SIZE })],
      }));
    });
  }

  // Щоденник практики: відгук керівника від бази практики + висновок керівника від закладу
  // вищої освіти + місця під підписи (форма Н-7.03) — стандартна завершальна частина будь-якого
  // щоденника практики, незалежно від того, який формат основної таблиці обрано вище. Без цього
  // блоку щоденник обривається одразу після таблиці, хоча цей блок студент і керівники мають
  // заповнити власноруч — тут лише лінований бланк, без вигаданого тексту відгуку.
  if (diaryReviewBlock) {
    const blankLine = () => new Paragraph({
      spacing: { line: LINE, lineRule: "auto", before: 0, after: 260 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: "000000", space: 1 } },
      children: [new TextRun({ text: "", font: FONT, size: SIZE })],
    });
    const heading = (text) => new Paragraph({
      alignment: AlignmentType.CENTER, indent: { firstLine: 0 },
      spacing: { line: LINE, lineRule: "auto", before: 0, after: LINE },
      children: [new TextRun({ text, font: FONT, size: SIZE, bold: true, color: "000000" })],
    });
    const plainLine2 = (text, opts = {}) => new Paragraph({
      alignment: AlignmentType.LEFT,
      indent: { firstLine: 0 },
      spacing: { line: LINE, lineRule: "auto", before: 0, after: 0, ...opts.spacing },
      children: [new TextRun({ text, font: FONT, size: opts.size || SIZE, bold: !!opts.bold, color: "000000" })],
    });

    children.push(new Paragraph({ pageBreakBefore: true, spacing: { before: 0, after: 0, line: LINE, lineRule: "auto" }, children: [] }));
    children.push(heading("Відгук і оцінка роботи здобувача вищої освіти на практиці"));
    for (let i = 0; i < 6; i++) children.push(blankLine());
    children.push(plainLine2(`Керівник практики від підприємства: ${diarySupervisorCompany || "___________________"}`, { spacing: { before: LINE } }));
    children.push(plainLine2("(підпис)                                   (ініціали, прізвище)"));
    children.push(plainLine2("МП                                                                              «___» _____________ 20__ року", { spacing: { after: LINE } }));

    // Відгук осіб, які перевіряли проходження практики — окремий розділ офіційного бланка,
    // відмінний від відгуку керівника від підприємства і від висновку керівника від кафедри.
    if (diaryInspectorReview) {
      children.push(new Paragraph({ pageBreakBefore: true, spacing: { before: 0, after: 0, line: LINE, lineRule: "auto" }, children: [] }));
      children.push(heading("Відгук осіб, які перевіряли проходження практики"));
      for (let i = 0; i < 6; i++) children.push(blankLine());
    }

    children.push(new Paragraph({ pageBreakBefore: true, spacing: { before: 0, after: 0, line: LINE, lineRule: "auto" }, children: [] }));
    children.push(heading(diaryConclusionDepartment
      ? `Висновок керівника практики від ${diaryConclusionDepartment}`
      : "Висновок керівника практики від закладу вищої освіти"));
    for (let i = 0; i < 6; i++) children.push(blankLine());
    if (diaryGradeFields) {
      children.push(plainLine2("Дата складання заліку «___» _____________ 20__ року", { spacing: { before: LINE } }));
      children.push(plainLine2("Оцінка:"));
      children.push(plainLine2("за національною шкалою ___________________________"));
      children.push(plainLine2("кількість балів ___________________________"));
      children.push(plainLine2("за шкалою ECTS ___________________________", { spacing: { after: LINE } }));
    }
    children.push(plainLine2(`Керівник практики від закладу вищої освіти: ${diarySupervisorUniversity || "___________________"}`, { spacing: { before: LINE } }));
    children.push(plainLine2("(підпис)                                   (ініціали, прізвище)"));
    children.push(plainLine2("«___» _____________ 20__ року"));
  }

  const doc = new Document({
    features: { updateFields: true },
    styles: {
      default: { document: { run: { font: FONT, size: SIZE, color: "000000", language: { value: langCode } }, paragraph: { spacing: { line: LINE, lineRule: "auto" } } } },
      paragraphStyles: [
        { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", run: { font: FONT, size: SIZE, bold: true, color: "000000", language: { value: langCode } }, paragraph: { spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 }, alignment: AlignmentType.CENTER, indent: { firstLine: 0 } } },
        { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", run: { font: FONT, size: SIZE, bold: true, color: "000000", language: { value: langCode } }, paragraph: { spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 }, alignment: AlignmentType.BOTH, indent: { firstLine: INDENT } } },
        { id: "TOC1", name: "TOC 1", basedOn: "Normal", next: "Normal", run: { font: FONT, size: SIZE, color: "000000", language: { value: langCode } }, paragraph: { spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 }, indent: { firstLine: 0 } } },
        { id: "TOC2", name: "TOC 2", basedOn: "Normal", next: "Normal", run: { font: FONT, size: SIZE, color: "000000", language: { value: langCode } }, paragraph: { spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 }, indent: { firstLine: 0 } } },
      ],
    },
    footnotes: footnoteCounter > 0 ? footnotesRegistry : undefined,
    sections: [{
      properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: T, right: R, bottom: B, left: L } }, pageNumberStart: 1, titlePage: true },
      headers: {
        first: new Header({ children: [] }),
        default: new Header({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, spacing: { before: 0, after: 0 }, children: [new TextRun({ children: [PageNumber.CURRENT], font: FONT, size: SIZE_NUM, color: "000000" })] })] }),
      },
      children,
    }],
  });

  const prefix = info?.orderNumber ? info.orderNumber + "_" : (orderId ? orderId + "_" : "");
  const safeName = prefix + (info?.topic || "робота").replace(/[^\wА-ЯҐЄІЇа-яґєії\s]/g, "").trim().slice(0, 40);
  return packDocx(doc, safeName + ".docx");
}

// ─────────────────────────────────────────────
// Export plan to docx
// ─────────────────────────────────────────────
export async function exportPlanToDocx({ sections, info, methodInfo }) {
  const FONT = methodInfo?.formatting?.font || "Times New Roman";
  const SIZE = Math.round(toNum(methodInfo?.formatting?.fontSize, 14) * 2);
  const LINE = 360, INDENT = 709;
  const langCode = detectTextLanguage(sections.map(s => `${s.label || ""} ${s.sectionTitle || ""}`).join(" "), info?.language);
  const L = getLangLabels(info?.language);
  const mmToTwip = mm => Math.round(mm * 1440 / 25.4);
  const marg = methodInfo?.formatting?.margins || {};
  const toMm = v => toNum(v, null);
  const ML = mmToTwip(toMm(marg.left)   ?? 30);
  const MR = mmToTwip(toMm(marg.right)  ?? 15);
  const MT = mmToTwip(toMm(marg.top)    ?? 20);
  const MB = mmToTwip(toMm(marg.bottom) ?? 20);

  const intro = sections.find(s => s.type === "intro");
  const concs = sections.find(s => s.type === "conclusions");
  const srcs = sections.find(s => s.type === "sources");
  const main = sections.filter(s => !["intro", "conclusions", "sources", "chapter_conclusion"].includes(s.type));
  const chapWord = detectChapterWord(main.map(s => s.sectionTitle), L.chapterWord);

  const cleanTopic = stripPresentationSuffix(info?.topic);

  const children = [];
  if (cleanTopic) {
    children.push(new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { line: LINE, lineRule: "auto", before: 0, after: LINE * 2 },
      children: [new TextRun({ text: cleanTopic, font: FONT, size: SIZE, color: "000000" })],
    }));
  }

  const groups = {};
  for (const s of main) { const top = s.id.split(".")[0]; if (!groups[top]) groups[top] = []; groups[top].push(s); }

  if (intro) children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { line: LINE, lineRule: "auto", before: LINE, after: Math.round(LINE / 2) }, alignment: AlignmentType.LEFT, indent: { firstLine: 0 }, children: [new TextRun({ text: intro.label || L.intro, font: FONT, size: SIZE, bold: true, color: "000000" })] }));

  for (const [num, items] of Object.entries(groups)) {
    const rawTitle = items[0].sectionTitle || composeChapterPrefix(chapWord, num);
    const alreadyHasPrefix = chapterWordRe().test(rawTitle.trim());
    const secLabel = alreadyHasPrefix ? rawTitle.trim() : `${composeChapterPrefix(chapWord, num)}. ${rawTitle}`;
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { line: LINE, lineRule: "auto", before: LINE, after: Math.round(LINE / 2) }, alignment: AlignmentType.LEFT, indent: { firstLine: 0 }, children: [new TextRun({ text: secLabel, font: FONT, size: SIZE, bold: true, color: "000000" })] }));
    for (const s of items) {
      if (!s.chapterOnly && /^\d+\.\d+/.test(s.id)) {
        children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, spacing: { line: LINE, lineRule: "auto", before: Math.round(LINE / 2), after: 0 }, alignment: AlignmentType.LEFT, indent: { firstLine: INDENT }, children: [new TextRun({ text: s.label, font: FONT, size: SIZE, color: "000000" })] }));
      }
    }
    const chapConc = sections.find(s => s.type === "chapter_conclusion" && s.id === `${num}.conclusions`);
    if (chapConc) {
      children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, spacing: { line: LINE, lineRule: "auto", before: Math.round(LINE / 2), after: 0 }, alignment: AlignmentType.LEFT, indent: { firstLine: INDENT }, children: [new TextRun({ text: chapConc.label, font: FONT, size: SIZE, color: "000000" })] }));
    }
  }
  if (concs) children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { line: LINE, lineRule: "auto", before: LINE, after: Math.round(LINE / 2) }, alignment: AlignmentType.LEFT, indent: { firstLine: 0 }, children: [new TextRun({ text: concs.label || L.conclusions, font: FONT, size: SIZE, bold: true, color: "000000" })] }));
  if (srcs) children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { line: LINE, lineRule: "auto", before: LINE, after: Math.round(LINE / 2) }, alignment: AlignmentType.LEFT, indent: { firstLine: 0 }, children: [new TextRun({ text: srcs.label || L.sources, font: FONT, size: SIZE, bold: true, color: "000000" })] }));

  const doc = new Document({
    styles: { default: { document: { run: { font: FONT, size: SIZE, color: "000000", language: { value: langCode } }, paragraph: { spacing: { line: LINE, lineRule: "auto" } } } } },
    sections: [{ properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: MT, right: MR, bottom: MB, left: ML } } }, children }],
  });

  const prefix = info?.orderNumber ? info.orderNumber + "_" : "";
  const safeName = prefix + ("план_" + (cleanTopic || "робота")).replace(/[^\wА-ЯҐЄІЇа-яґєії\s]/g, "").trim().slice(0, 40);
  return packDocx(doc, safeName + ".docx");
}

// ─────────────────────────────────────────────
// Export practice report plan to docx (flat id/label shape, no `type` field)
// ─────────────────────────────────────────────
export async function exportPracticePlanToDocx({ sections, info, methodInfo }) {
  const FONT = methodInfo?.formatting?.font || "Times New Roman";
  const SIZE = Math.round(toNum(methodInfo?.formatting?.fontSize, 14) * 2);
  const LINE = 360, INDENT = 709;
  const langCode = detectTextLanguage(sections.map(s => `${s.label || ""} ${s.sectionTitle || ""}`).join(" "), info?.language);
  const mmToTwip = mm => Math.round(mm * 1440 / 25.4);
  const marg = methodInfo?.formatting?.margins || {};
  const toMm = v => toNum(v, null);
  const L = mmToTwip(toMm(marg.left)   ?? 30);
  const R = mmToTwip(toMm(marg.right)  ?? 15);
  const T = mmToTwip(toMm(marg.top)    ?? 20);
  const B = mmToTwip(toMm(marg.bottom) ?? 20);

  const cleanTopic = stripPresentationSuffix(info?.topic);

  const FIXED = ["intro", "conclusions", "sources"];
  const children = [];
  if (cleanTopic) {
    children.push(new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { line: LINE, lineRule: "auto", before: 0, after: LINE * 2 },
      children: [new TextRun({ text: cleanTopic, font: FONT, size: SIZE, color: "000000" })],
    }));
  }
  let lastChapterTitle = null;
  for (const s of sections) {
    const isSub = !FIXED.includes(s.id) && /^\d+\.\d+/.test(String(s.id));
    if (isSub && s.sectionTitle && s.sectionTitle !== lastChapterTitle) {
      lastChapterTitle = s.sectionTitle;
      children.push(new Paragraph({
        heading: HeadingLevel.HEADING_1,
        spacing: { line: LINE, lineRule: "auto", before: LINE, after: Math.round(LINE / 2) },
        alignment: AlignmentType.LEFT,
        indent: { firstLine: 0 },
        children: [new TextRun({ text: s.sectionTitle, font: FONT, size: SIZE, bold: true, color: "000000" })],
      }));
    } else if (!isSub) {
      lastChapterTitle = null;
    }
    children.push(new Paragraph({
      heading: isSub ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_1,
      spacing: { line: LINE, lineRule: "auto", before: isSub ? Math.round(LINE / 2) : LINE, after: isSub ? 0 : Math.round(LINE / 2) },
      alignment: AlignmentType.LEFT,
      indent: { firstLine: isSub ? INDENT : 0 },
      children: [new TextRun({ text: s.label, font: FONT, size: SIZE, bold: !isSub, color: "000000" })],
    }));
  }

  const doc = new Document({
    styles: { default: { document: { run: { font: FONT, size: SIZE, color: "000000", language: { value: langCode } }, paragraph: { spacing: { line: LINE, lineRule: "auto" } } } } },
    sections: [{ properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: T, right: R, bottom: B, left: L } } }, children }],
  });

  const prefix = info?.orderNumber ? info.orderNumber + "_" : "";
  const safeName = prefix + ("план_" + (cleanTopic || "звіт")).replace(/[^\wА-ЯҐЄІЇа-яґєії\s]/g, "").trim().slice(0, 40);
  return packDocx(doc, safeName + ".docx");
}

// ─────────────────────────────────────────────
// Додатки (.docx)
// ─────────────────────────────────────────────
export async function exportAppendixToDocx(text, info, methodInfo, orderId) {
  const FONT = methodInfo?.formatting?.font || "Times New Roman";
  const SIZE = Math.round(toNum(methodInfo?.formatting?.fontSize, 14) * 2);
  const SIZE_NUM = Math.max(16, SIZE - 4);
  const langCode = detectTextLanguage(text, info?.language);
  const mmToTwip = mm => Math.round(mm * 1440 / 25.4);
  const marg = methodInfo?.formatting?.margins || {};
  const toMm = v => toNum(v, null);
  const L = mmToTwip(toMm(marg.left)   ?? 30);
  const R = mmToTwip(toMm(marg.right)  ?? 15);
  const T = mmToTwip(toMm(marg.top)    ?? 20);
  const B = mmToTwip(toMm(marg.bottom) ?? 20);
  const INDENT = 709, LINE = 360;

  function cleanMarkdown(line) {
    return line.replace(/^#{1,6}\s+/, "").replace(/\*\*(.+?)\*\*/g, "$1")
      .replace(/\*(.+?)\*/g, "$1").replace(/^[-*]\s+/, "").replace(/^\d+\.\s+/, "").trim();
  }
  function makeTableDocx(lines) {
    const border = { style: BorderStyle.SINGLE, size: 1, color: "000000" };
    const cellBorders = { top: border, bottom: border, left: border, right: border };
    const filteredLines = lines.filter(l => !/^\s*\|[-:| ]+\|\s*$/.test(l));
    const rawRows = filteredLines.map(l => l.replace(/^\|/, "").replace(/\|$/, "").split("|").map(c => c.trim()));
    const headerCount = rawRows[0]?.length || 0;
    // Якщо джерело розбило один рядок таблиці на кілька фізичних "|"-рядків
    // (клітинок менше, ніж у шапці), доклеюємо продовження до попереднього
    // рядка замість того, щоб рендерити його як окремий кривий рядок.
    const mergedRows = [];
    for (const cells of rawRows) {
      const prev = mergedRows[mergedRows.length - 1];
      if (prev && headerCount > 0 && cells.length < headerCount && prev.length < headerCount) {
        prev.push(...cells);
      } else {
        mergedRows.push(cells);
      }
    }
    const rows = mergedRows.map((cells, rowIndex) => {
      const isHeader = rowIndex === 0;
      return new TableRow({
        children: cells.map(cellText =>
          new TableCell({
            borders: cellBorders,
            margins: { left: 57, right: 57, top: 57, bottom: 57 },
            children: [new Paragraph({
              alignment: isHeader ? AlignmentType.CENTER : AlignmentType.LEFT,
              spacing: { line: 240, lineRule: "exact", before: 0, after: 0 },
              children: [new TextRun({ text: cellText, font: FONT, size: SIZE_NUM, color: "000000", bold: isHeader && !!methodInfo?.formatting?.tableHeaderBold })],
            })],
          })
        ),
      });
    });
    return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows });
  }

  if (text) text = text.replace(/'/g, '\u2019');
  const lc = getLangLabels(info?.language);
  const { content: diagResolved, diagramImages } = text
    ? await resolveDiagrams({ appendix: text }, lc.figWord)
    : { content: {}, diagramImages: [] };
  if (text) text = diagResolved.appendix;
  const children = [];
  const lines = normalizeLooseTableLines(text.split("\n"));
  let i = 0;
  let isQuestionnaire = false;
  while (i < lines.length) {
    const line = lines[i];
    const trimmedLine0 = line.trim();
    const diagMatch0 = trimmedLine0.startsWith("\x00DIAGRAM") && trimmedLine0.endsWith("\x00")
      ? trimmedLine0.slice(8, -1)
      : null;
    if (diagMatch0 !== null) {
      const img = diagramImages[Number(diagMatch0)];
      if (img) {
        children.push(new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 },
          children: [new ImageRun({ data: img.data, transformation: { width: img.width, height: img.height } })],
        }));
      }
      i++;
      continue;
    }
    if (isFenceLine(line)) {
      const { codeLines, nextIndex } = readFencedBlock(lines, i);
      children.push(...codeListingParagraphs(codeLines, methodInfo));
      children.push(new Paragraph({ spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 }, children: [] }));
      i = nextIndex;
      continue;
    }
    if (/^\s*\|/.test(line)) {
      const tableLines = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) { tableLines.push(lines[i]); i++; }
      if (tableLines.filter(l => !/^\s*\|[-:| ]+\|\s*$/.test(l)).length > 0) {
        children.push(makeTableDocx(tableLines));
        children.push(new Paragraph({ spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 }, children: [] }));
      }
      continue;
    }
    if (LISTING_CAPTION_RE.test(line.trim()) || line.trim().startsWith(`${lc.listingWord} `)) {
      children.push(new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { line: LINE, lineRule: "auto", before: Math.round(LINE * 0.5), after: 0 },
        children: [new TextRun({ text: line.trim(), font: FONT, size: SIZE, bold: true, color: "000000" })],
      }));
      i++; continue;
    }
    if (/^Таблиця\s+\d/.test(line.trim()) && isFollowedByTable(lines, i)) {
      const fmt = methodInfo?.formatting || {};
      const tf = fmt.tableFormat || "";
      const tAlignRight = fmt.tableNumberRight ?? /правий|right|справа|верхн.*кут/i.test(tf);
      const tCenter    = fmt.tableTitleCenter ?? /по\s*центру.*назв|назв.*по\s*центру|центр/i.test(tf);
      const tBold      = fmt.tableTitleBold   ?? /жирн|bold/i.test(tf);
      const tTwoLine = tAlignRight && (tCenter || tBold);
      const dashIdx = line.search(/ [–\-] /);
      if (tTwoLine && dashIdx !== -1) {
        const numPart = line.trim().substring(0, dashIdx).trim();
        const namePart = line.trim().substring(dashIdx + 3).trim();
        children.push(new Paragraph({
          alignment: AlignmentType.RIGHT,
          spacing: { line: LINE, lineRule: "auto", before: Math.round(LINE * 0.5), after: 0 },
          indent: { firstLine: 0 },
          children: [new TextRun({ text: numPart, font: FONT, size: SIZE, color: "000000" })],
        }));
        children.push(new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 },
          indent: { firstLine: 0 },
          children: [new TextRun({ text: namePart, font: FONT, size: SIZE, bold: true, color: "000000" })],
        }));
      } else {
        children.push(new Paragraph({
          alignment: tAlignRight ? AlignmentType.RIGHT : AlignmentType.BOTH,
          spacing: { line: LINE, lineRule: "auto", before: Math.round(LINE * 0.5), after: 0 },
          indent: { firstLine: tAlignRight ? 0 : INDENT },
          children: [new TextRun({ text: line.trim(), font: FONT, size: SIZE, bold: tBold, color: "000000" })],
        }));
      }
      i++; continue;
    }
    if (/^Рис\.\s+\d/.test(line.trim()) || (lc.figWord !== "Рис." && line.trim().startsWith(lc.figWord) && /^\s*\d/.test(line.trim().slice(lc.figWord.length)))) {
      const ff = methodInfo?.formatting?.figureFormat || "";
      const fBold = /жирн|bold/i.test(ff);
      children.push(new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { line: LINE, lineRule: "auto", before: 0, after: Math.round(LINE * 0.5) },
        children: [new TextRun({ text: line.trim(), font: FONT, size: SIZE, bold: fBold, color: "000000" })],
      }));
      i++; continue;
    }
    const raw = cleanMarkdown(line);
    if (!raw) { i++; continue; }
    if (appendixLabelRe().test(raw)) {
      // Peek at upcoming lines to detect questionnaire
      let peekIdx = i + 1;
      while (peekIdx < lines.length && !lines[peekIdx].trim()) peekIdx++;
      const nextNonEmpty = (lines[peekIdx] || "").replace(/^#{1,6}\s+/, "").replace(/\*\*(.+?)\*\*/g, "$1").trim();
      isQuestionnaire = /анкет|опитувальник|questionnaire|survey|ankieta|kwestionariusz|cuestionario|encuesta|fragebogen|dotazník|questionario|问卷/i.test(nextNonEmpty);
      children.push(new Paragraph({
        spacing: { line: LINE, lineRule: "auto", before: LINE, after: Math.round(LINE / 2) },
        alignment: AlignmentType.RIGHT,
        children: [new TextRun({ text: raw.toUpperCase(), font: FONT, size: SIZE, bold: true, color: "000000" })],
      }));
      i++; continue;
    }
    if (/^#{1,6}\s/.test(line.trim())) {
      children.push(new Paragraph({
        heading: HeadingLevel.HEADING_2,
        spacing: { line: LINE, lineRule: "auto", before: LINE, after: Math.round(LINE / 2) },
        alignment: AlignmentType.LEFT,
        indent: { firstLine: INDENT },
        children: [new TextRun({ text: raw, font: FONT, size: SIZE, bold: true, color: "000000" })],
      }));
      i++; continue;
    }
    children.push(new Paragraph({
      indent: { firstLine: isQuestionnaire ? 0 : INDENT },
      spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 },
      alignment: isQuestionnaire ? AlignmentType.LEFT : AlignmentType.BOTH,
      children: [new TextRun({ text: raw, font: FONT, size: SIZE, color: "000000" })],
    }));
    i++;
  }

  const doc = new Document({
    styles: { default: { document: { run: { font: FONT, size: SIZE, color: "000000", language: { value: langCode } }, paragraph: { spacing: { line: LINE, lineRule: "auto" } } } } },
    sections: [{
      properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: T, right: R, bottom: B, left: L } }, pageNumberStart: 1 },
      headers: { default: new Header({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, spacing: { before: 0, after: 0 }, children: [new TextRun({ children: [PageNumber.CURRENT], font: FONT, size: SIZE_NUM, color: "000000" })] })] }) },
      children,
    }],
  });

  const prefix = info?.orderNumber ? info.orderNumber + "_" : (orderId ? orderId + "_" : "");
  const safeName = prefix + (info?.topic || "додатки").replace(/[^\wА-ЯҐЄІЇа-яґєії\s]/g, "").trim().slice(0, 40);
  return packDocx(doc, safeName + " - додатки.docx");
}

// ─────────────────────────────────────────────
// Доповідь (.docx)
// ─────────────────────────────────────────────
export async function exportSpeechToDocx(text, info, methodInfo, orderId, speechLabel) {
  const FONT = methodInfo?.formatting?.font || "Times New Roman";
  const SIZE = Math.round(toNum(methodInfo?.formatting?.fontSize, 14) * 2);
  const SIZE_NUM = Math.max(16, SIZE - 4);
  const langCode = detectTextLanguage(text, info?.language);
  const mmToTwip = mm => Math.round(mm * 1440 / 25.4);
  const marg = methodInfo?.formatting?.margins || {};
  const toMm = v => toNum(v, null);
  const L = mmToTwip(toMm(marg.left)   ?? 30);
  const R = mmToTwip(toMm(marg.right)  ?? 15);
  const T = mmToTwip(toMm(marg.top)    ?? 20);
  const B = mmToTwip(toMm(marg.bottom) ?? 20);
  const INDENT = 709, LINE = 360;
  if (text) text = text.replace(/'/g, '\u2019');

  const topic = info?.topic || "";
  const workType = info?.type || "";
  const typeMap = { "дипломн": "дипломної роботи", "кваліфікаційн": "кваліфікаційної роботи", "курсов": "курсової роботи", "магістерськ": "магістерської роботи", "бакалавр": "бакалаврської роботи", "реферат": "реферату", "стаття": "статті", "есе": "есе", "доповід": "роботи" };
  const typeLabel = Object.entries(typeMap).find(([k]) => workType.toLowerCase().includes(k))?.[1] || "роботи";

  const header = [
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 }, children: [new TextRun({ text: "ДОПОВІДЬ", font: FONT, size: SIZE, bold: true, color: "000000" })] }),
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 }, children: [new TextRun({ text: `до ${typeLabel} на тему:`, font: FONT, size: SIZE, color: "000000" })] }),
    ...(topic ? [new Paragraph({ alignment: AlignmentType.CENTER, spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 }, children: [new TextRun({ text: `«${topic}»`, font: FONT, size: SIZE, bold: true, color: "000000" })] })] : []),
    new Paragraph({ spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 }, children: [] }),
  ];

  const children = [...header, ...text.split("\n").map(line => {
    const raw = line.replace(/\*\*(.+?)\*\*/g, "$1").replace(/\*(.+?)\*/g, "$1").trim();
    if (!raw) return new Paragraph({ spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 }, children: [] });
    if (/^Слайд\s+\d+/i.test(raw)) {
      return new Paragraph({
        spacing: { line: LINE, lineRule: "auto", before: 120, after: 0 },
        alignment: AlignmentType.LEFT,
        children: [new TextRun({ text: raw, font: FONT, size: SIZE, bold: true, color: "000000" })],
      });
    }
    return new Paragraph({
      indent: { firstLine: INDENT },
      spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 },
      alignment: AlignmentType.BOTH,
      children: [new TextRun({ text: raw, font: FONT, size: SIZE, color: "000000" })],
    });
  })];

  const doc = new Document({
    styles: { default: { document: { run: { font: FONT, size: SIZE, color: "000000", language: { value: langCode } }, paragraph: { spacing: { line: LINE, lineRule: "auto" } } } } },
    sections: [{
      properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: T, right: R, bottom: B, left: L } }, pageNumberStart: 1 },
      headers: { default: new Header({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, spacing: { before: 0, after: 0 }, children: [new TextRun({ children: [PageNumber.CURRENT], font: FONT, size: SIZE_NUM, color: "000000" })] })] }) },
      children,
    }],
  });

  const num = info?.orderNumber || (orderId ? orderId.slice(0, 10) : "");
  const label = speechLabel || "доповідь";
  const fileName = num ? `${num}_${label}.docx` : `${label}.docx`;
  return packDocx(doc, fileName);
}

// ─────────────────────────────────────────────
// Simple docx export для малих робіт (плоский текст без підрозділів) —
// перенесено з shared.jsx (там вантажило docx через window.docx/CDN, що
// працює лише в браузері; тут — прямий import "docx", як і в exportToDocx,
// тож придатне й для воркера).
// ─────────────────────────────────────────────
const SIMPLE_PLANTUML_FENCE_RE = /^\s*```\s*plantuml\s*$/i;
const SIMPLE_FENCE_END_RE = /^\s*```\s*$/;
const SIMPLE_FIG_CAPTION_RE = /^рис\.?\s+\d/i;

// Замінює кожен ```plantuml``` fence-блок у тексті на маркер \x00DIAGRAM<i>\x00 і
// рендерить відповідні PNG паралельно (та сама логіка, що й для великих робіт).
// Таблицю з даними, за якою одразу йде підпис рисунка, замінює на ту саму
// позначку, але з автоматично намальованою стовпчиковою діаграмою (сама таблиця
// лишається видимою текстом — вставляється лише картинка під нею). Підпис-заглушка, для
// якого знайдено фото з інтернету (webImageMap), отримує це фото над собою.
async function resolveSimpleDiagrams(sections, figWord, webImageMap = new Map()) {
  const diagramImages = [];
  const jobs = [];
  const updated = sections.map(sec => {
    if (!sec.text) return sec;
    const lines = normalizeLooseTableLines(sec.text.split("\n"));
    const outLines = [];
    let i = 0;
    while (i < lines.length) {
      if (SIMPLE_PLANTUML_FENCE_RE.test(lines[i])) {
        const codeLines = [];
        let j = i + 1;
        while (j < lines.length && !SIMPLE_FENCE_END_RE.test(lines[j])) { codeLines.push(lines[j]); j++; }
        if (j < lines.length) j++; // пропускаємо закриваючу ```
        const idx = diagramImages.length;
        diagramImages.push(null);
        jobs.push(renderPlantUmlToPng(codeLines.join("\n")).then(img => { diagramImages[idx] = img; }));
        outLines.push(`\x00DIAGRAM${idx}\x00`);
        i = j;
        continue;
      }
      // Таблиця даних БЕЗ рамкових «|» («Форма роботи | Тривалість | Рівень» — так модель часом пише дані
      // для діаграми): раніше це не розпізнавалось як таблиця → діаграма не малювалась, у файлі лишались
      // сирі рядки й кольоровий підпис рисунка (кейс 41406). Якщо після ≥3 таких рядків іде підпис рисунка —
      // нормалізуємо їх у звичайну markdown-таблицю, далі спрацьовує стандартна гілка.
      if (isLooseTableRow(lines[i])) {
        let j0 = i;
        while (j0 < lines.length && isLooseTableRow(lines[j0])) j0++;
        let k0 = j0;
        while (k0 < lines.length && !lines[k0].trim()) k0++;
        if (j0 - i >= 3 && k0 < lines.length && SIMPLE_FIG_CAPTION_RE.test(lines[k0].trim())) {
          for (let q = i; q < j0; q++) lines[q] = "| " + lines[q].split("|").map(c => c.trim()).join(" | ") + " |";
        }
      }
      if (/^\s*\|/.test(lines[i])) {
        const tableLines = [];
        let j = i;
        while (j < lines.length && /^\s*\|/.test(lines[j])) { tableLines.push(lines[j]); j++; }
        outLines.push(...tableLines);
        let k = j;
        while (k < lines.length && !lines[k].trim()) k++;
        if (k < lines.length && SIMPLE_FIG_CAPTION_RE.test(lines[k].trim())) {
          const idx = diagramImages.length;
          diagramImages.push(null);
          jobs.push(renderDataChartToPng(tableLines).then(img => { diagramImages[idx] = img; }));
          outLines.push(`\x00DIAGRAM${idx}\x00`);
        }
        i = j;
        continue;
      }
      // Застарілий рядок-підказку (з уже згенерованого раніше вмісту) більше не показуємо —
      // тепер діаграма вставляється сама.
      if (/^⚠/.test(lines[i].trim())) { i++; continue; }
      const cap = webImageMap.size ? parseFigureCaption(lines[i], figWord) : null;
      if (cap) {
        let p = outLines.length - 1;
        while (p >= 0 && !outLines[p].trim()) p--;
        const webImg = p < 0 || !isFigureSourceLine(outLines[p].trim()) ? webImageMap.get(webImageKey(sec.id || SIMPLE_WORK_SECTION_ID, cap.name)) : null;
        if (webImg) {
          outLines.push(`\x00DIAGRAM${diagramImages.length}\x00`);
          diagramImages.push(webImg);
        }
      }
      outLines.push(lines[i]);
      i++;
    }
    return { ...sec, text: outLines.join("\n") };
  });
  await Promise.all(jobs);
  return { sections: updated, diagramImages };
}

export async function exportSimpleDocx({ title, sections, info, citations, orderId, methodInfo, commentAnalysis, pageNumbers = true, webImages = [] }) {
  const webImageMap = await resolveWebImages(webImages);
  const { sections: resolvedSections, diagramImages } = await resolveSimpleDiagrams(sections, getLangLabels(info?.language).figWord, webImageMap);
  sections = resolvedSections;
  const langCode = detectTextLanguage(sections.map(s => s.text || "").join("\n\n"), info?.language);
  const FONT = methodInfo?.formatting?.font || "Times New Roman";
  const SIZE = Math.round(toNum(methodInfo?.formatting?.fontSize, 14) * 2);
  const SIZE_NUM = Math.max(16, SIZE - 4);
  const mmToTwip = mm => Math.round(mm * 1440 / 25.4);
  const marg = methodInfo?.formatting?.margins || commentAnalysis?.formattingHints?.margins || {};
  const toMm = v => toNum(v, null);
  const L = mmToTwip(toMm(marg.left)   ?? 30);
  const R = mmToTwip(toMm(marg.right)  ?? 15);
  const T = mmToTwip(toMm(marg.top)    ?? 20);
  const B = mmToTwip(toMm(marg.bottom) ?? 20);
  const INDENT = 709, LINE = 360;

  const footnotesRegistry = {};
  let footnoteCounter = 0;
  const footnoteTextByNum = {};

  // [N] → внутрішнє гіперпосилання на закладку джерела; %%FN<n>%% → справжня Word-виноска
  function parseTextWithCitations(text, bold = false, italics = false) {
    const CITE_RE = /\[(\d+)\]|%%FN(\d+)%%/g;
    const result = [];
    let lastIndex = 0, match;
    while ((match = CITE_RE.exec(text)) !== null) {
      if (match.index > lastIndex)
        result.push(new TextRun({ text: text.slice(lastIndex, match.index), font: FONT, size: SIZE, bold, italics, color: "000000" }));
      if (match[2]) {
        footnoteCounter++;
        const fnText = footnoteTextByNum[Number(match[2])] || "";
        footnotesRegistry[footnoteCounter] = { children: [new Paragraph({ children: [new TextRun({ text: fnText, font: FONT, size: SIZE_NUM, color: "000000" })] })] };
        result.push(new TextRun({ children: [new FootnoteReferenceRun(footnoteCounter)], font: FONT, size: SIZE, bold, italics }));
      } else {
        result.push(new InternalHyperlink({
          anchor: `ref_${match[1]}`,
          children: [new TextRun({ text: match[0], font: FONT, size: SIZE, italics, color: "000000" })],
        }));
      }
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < text.length)
      result.push(new TextRun({ text: text.slice(lastIndex), font: FONT, size: SIZE, bold, italics, color: "000000" }));
    return result.length ? result : [new TextRun({ text, font: FONT, size: SIZE, bold, italics, color: "000000" })];
  }

  // **жирний** inline + [N] для абзаців тексту; italics — примусовий курсив для
  // цілого абзацу (анотація за методичкою оформлюється курсивом)
  function parseBodyLine(text, italics = false) {
    const BOLD_RE = /\*\*(.+?)\*\*/g;
    const parts = [];
    let last = 0, m;
    while ((m = BOLD_RE.exec(text)) !== null) {
      if (m.index > last) parts.push({ text: text.slice(last, m.index), bold: false });
      parts.push({ text: m[1], bold: true });
      last = m.index + m[0].length;
    }
    if (last < text.length) parts.push({ text: text.slice(last), bold: false });
    if (!parts.length) parts.push({ text, bold: false });
    // Одинарні "*" (курсив markdown) поза межами **жирного** — у звичайних абзацах
    // не підтримуються (на відміну від списку джерел), тож просто прибираємо їх,
    // а не лишаємо буквально в тексті.
    return parts.flatMap(p => parseTextWithCitations(
      p.bold ? p.text : p.text.replace(/\*(.+?)\*/g, "$1").replace(/\*/g, ""),
      p.bold, italics
    ));
  }

  // URL → зовнішній гіперлінк, *курсив* → курсив (для рядків джерел)
  function sourceParaChildren(text) {
    const URL_RE = /(https?:\/\/[^\s]+)/;
    return text.split(URL_RE).flatMap(part => {
      if (URL_RE.test(part)) {
        const cleanUrl = part.replace(/[.,;:!?)]+$/, "");
        const tail = part.slice(cleanUrl.length);
        const link = new ExternalHyperlink({
          link: cleanUrl,
          children: [new TextRun({ text: cleanUrl, font: FONT, size: SIZE, color: "0563C1", underline: {} })],
        });
        return tail ? [link, new TextRun({ text: tail, font: FONT, size: SIZE, color: "000000" })] : [link];
      }
      const runs = [];
      const italicRe = /\*([^*]+)\*/g;
      let last2 = 0, m2;
      while ((m2 = italicRe.exec(part)) !== null) {
        if (m2.index > last2) runs.push(new TextRun({ text: part.slice(last2, m2.index), font: FONT, size: SIZE, color: "000000" }));
        runs.push(new TextRun({ text: m2[1], font: FONT, size: SIZE, italics: true, color: "000000" }));
        last2 = m2.index + m2[0].length;
      }
      if (last2 < part.length) runs.push(new TextRun({ text: part.slice(last2), font: FONT, size: SIZE, color: "000000" }));
      return runs;
    });
  }

  function sourcePara(text) {
    const cleaned = text.replace(/\*\*(.+?)\*\*/g, "$1").trim();
    if (!cleaned) return null;
    return new Paragraph({
      spacing: { line: LINE, lineRule: "auto", before: 0, after: Math.round(LINE * 0.3) },
      alignment: AlignmentType.BOTH,
      indent: { firstLine: INDENT },
      children: sourceParaChildren(cleaned),
    });
  }

  function sourceParaWithBookmark(text, refNum) {
    const cleaned = text.replace(/\*\*(.+?)\*\*/g, "$1").trim();
    if (!cleaned) return null;
    const numMatch = cleaned.match(/^(\d+[\.\)]\s*)/);
    const children = numMatch
      ? [
          new Bookmark({ id: `ref_${refNum}`, children: [new TextRun({ text: numMatch[1], font: FONT, size: SIZE, color: "000000" })] }),
          ...sourceParaChildren(cleaned.slice(numMatch[1].length)),
        ]
      : sourceParaChildren(cleaned);
    return new Paragraph({
      spacing: { line: LINE, lineRule: "auto", before: 0, after: Math.round(LINE * 0.3) },
      alignment: AlignmentType.BOTH,
      indent: { firstLine: INDENT },
      children,
    });
  }

  // Заголовок списку джерел, підпис таблиці й рядок "Джерело:" під нею — усіма мовами роботи
  // (раніше лише українською/англійською — польська "Tabela 1" чи "Bibliografia" не впізнавались).
  const simpleLc = getLangLabels(info?.language);
  const SOURCES_HEADER_RE = new RegExp(`^(?:список використаних джерел|список літератури|використані джерела|references?|${sourcesHeadingAlt()})\\s*[:.]?\\s*$`, "i");
  const escSimple = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const FIG_MARKER_RE = /^\[🔍 Рисунок \d+:/;
  const TABLE_CAPTION_RE = new RegExp(`^(?:таблиця|table|${simpleLc.tableWord.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})\\s*\\d`, "i");
  const SOURCE_CAPTION_RE = /^(джерело|source|źródło|fuente|quelle|zdroj|fonte|来源)\s*[:：]/i;
  // Підписи анотації/ключових слів і УДК усіма мовами роботи (getLangLabels: abstractWord,
  // keywordsWord, udc); у китайській після підпису — повноширинна двокрапка "：".
  // Плюс підписи поточної мови — для мови з набору ШІ їх немає в переліку.
  const ANOTATION_RE = new RegExp(`^(анотація|abstract|ключові слова|keywords|streszczenie|słowa kluczowe|resumen|palabras clave|zusammenfassung|schlüsselwörter|abstrakt|klíčová slova|kľúčové slová|摘要|关键词|résumé|mots-clés|riassunto|parole chiave|${escSimple(simpleLc.abstractWord)}|${escSimple(simpleLc.keywordsWord)})\\s*[:.：]`, "i");
  const UDK_RE = new RegExp(`^(УДК|UDC|UKD|CDU|DK|MDT|${escSimple(simpleLc.udc)})\\s`, "i");
  const TITLE_MARKER = "\x00TITLE\x00";
  const TITLE_END_MARKER = "\x00/TITLE\x00";
  const AUTHORBLOCK_PREFIX = "\x00AUTHORBLOCK:";
  const AUTHORBLOCK_END_MARKER = "\x00/AUTHORBLOCK\x00";

  // ── Виноски (ДСТУ-режим): %%FN<n>%% у тексті → реальна Word-виноска ──
  // n → повний текст джерела, узятий з explicit citations або розпарсений зі списку джерел у тексті.
  if (citations && citations.length > 0) {
    citations.forEach((c, i) => { footnoteTextByNum[i + 1] = c; });
  } else {
    sections.forEach(sec => {
      if (!sec.text) return;
      let inSrc = false;
      sec.text.split("\n").forEach(line => {
        const cleaned = line.trim().replace(/\*\*(.+?)\*\*/g, "$1").replace(/\*(.+?)\*/g, "$1");
        if (SOURCES_HEADER_RE.test(cleaned)) { inSrc = true; return; }
        if (!inSrc || !cleaned) return;
        const m = cleaned.match(/^(\d+)[.)]\s*(.*)/);
        if (m) footnoteTextByNum[parseInt(m[1])] = m[2];
      });
    });
  }

  function makeSimpleTableDocx(tableLines) {
    const border = { style: BorderStyle.SINGLE, size: 1, color: "000000" };
    const cellBorders = { top: border, bottom: border, left: border, right: border };
    const dataLines = tableLines.filter(l => !/^\s*\|[-:| ]+\|\s*$/.test(l));
    if (!dataLines.length) return null;
    const rows = dataLines.map((l, rowIdx) => {
      const cells = l.replace(/^\|/, "").replace(/\|$/, "").split("|").map(c => c.trim());
      const isHeader = rowIdx === 0;
      return new TableRow({
        children: cells.map(cellText => new TableCell({
          borders: cellBorders,
          margins: { left: 57, right: 57, top: 57, bottom: 57 },
          children: [new Paragraph({
            alignment: isHeader ? AlignmentType.CENTER : AlignmentType.LEFT,
            spacing: { line: 240, lineRule: "exact", before: 0, after: 0 },
            children: [new TextRun({ text: cellText, font: FONT, size: SIZE_NUM, color: "000000", bold: isHeader && !!methodInfo?.formatting?.tableHeaderBold })],
          })],
        })),
      });
    });
    return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows });
  }

  const children = [];
  for (let i = 0; i < sections.length; i++) {
    const sec = sections[i];
    if (!sec.text) continue;
    if (i > 0) children.push(new Paragraph({ pageBreakBefore: true, spacing: { before: 0, after: 0, line: LINE, lineRule: "auto" }, children: [] }));
    if (sec.label) {
      children.push(new Paragraph({
        heading: HeadingLevel.HEADING_1,
        spacing: { line: LINE, lineRule: "auto", before: 0, after: LINE },
        alignment: AlignmentType.CENTER, indent: { firstLine: 0 },
        children: [new TextRun({ text: sec.label.toUpperCase(), font: FONT, size: SIZE, bold: true, color: "000000" })],
      }));
    }
    let inSources = false;
    let lastWasDiagram = false;
    const lines = normalizeLooseTableLines(sec.text.split("\n"));
    let li = 0;
    while (li < lines.length) {
      const line = lines[li];
      const trimmed = line.trim();
      const trimmedClean = trimmed.replace(/\*\*(.+?)\*\*/g, "$1").replace(/\*(.+?)\*/g, "$1");
      const wasDiagram = lastWasDiagram;
      lastWasDiagram = false;

      // Маркери пошуку рисунків — не потрапляють у docx
      if (FIG_MARKER_RE.test(trimmed)) { li++; continue; }

      // PlantUML-діаграма, вже відрендерена в PNG — вставляємо як зображення
      if (trimmed.startsWith("\x00DIAGRAM") && trimmed.endsWith("\x00")) {
        const img = diagramImages[Number(trimmed.slice(8, -1))];
        if (img) {
          children.push(new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 },
            children: [new ImageRun({ data: img.data, transformation: { width: img.width, height: img.height } })],
          }));
          lastWasDiagram = true;
          li++; continue;
        }
        lastWasDiagram = false;
        li++; continue;
      }

      // Назва статті — вставлена кодом між маркерами \x00TITLE\x00 — жирним, по
      // центру, без відступу, незалежно від того, що написала модель довкола.
      if (trimmed === TITLE_MARKER) {
        li++;
        const titleLines = [];
        while (li < lines.length && lines[li].trim() !== TITLE_END_MARKER) { titleLines.push(lines[li].trim()); li++; }
        li++; // пропускаємо закриваючий маркер
        titleLines.filter(Boolean).forEach(t => {
          children.push(new Paragraph({
            alignment: AlignmentType.CENTER, indent: { firstLine: 0 },
            spacing: { line: LINE, lineRule: "auto", before: 0, after: LINE },
            children: [new TextRun({ text: t, font: FONT, size: SIZE, bold: true, color: "000000" })],
          }));
        });
        continue;
      }

      // Блок автора — вставлений кодом між маркерами \x00AUTHORBLOCK:format\x00 —
      // жирним, по центру або праворуч (format), кожен рядок окремим абзацом.
      if (trimmed.startsWith(AUTHORBLOCK_PREFIX) && trimmed.endsWith("\x00")) {
        const abFormat = trimmed.slice(AUTHORBLOCK_PREFIX.length, -1);
        li++;
        const abLines = [];
        while (li < lines.length && lines[li].trim() !== AUTHORBLOCK_END_MARKER) { abLines.push(lines[li].trim()); li++; }
        li++; // пропускаємо закриваючий маркер
        const nonEmpty = abLines.filter(Boolean);
        nonEmpty.forEach((t, idx) => {
          children.push(new Paragraph({
            alignment: abFormat === "right" ? AlignmentType.RIGHT : AlignmentType.CENTER, indent: { firstLine: 0 },
            spacing: { line: LINE, lineRule: "auto", before: 0, after: idx === nonEmpty.length - 1 ? LINE : 0 },
            children: [new TextRun({ text: t, font: FONT, size: SIZE, bold: true, color: "000000" })],
          }));
        });
        continue;
      }

      // Рядок УДК — без абзацного відступу, звичайним накресленням.
      if (UDK_RE.test(trimmed)) {
        children.push(new Paragraph({
          alignment: AlignmentType.LEFT, indent: { firstLine: 0 },
          spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 },
          children: [new TextRun({ text: trimmedClean, font: FONT, size: SIZE, color: "000000" })],
        }));
        li++; continue;
      }

      // Якщо citations передано явно й непорожньо — пропускаємо вбудований блок джерел
      // з тексту (він буде замінений явним списком нижче). Порожній масив ([]) —
      // це "джерел ще не підібрано", а не "явний список" — тоді лишаємо вбудований
      // блок як є, інакше він просто зникає без заміни.
      if (citations && citations.length > 0 && SOURCES_HEADER_RE.test(trimmedClean)) { inSources = true; li++; continue; }
      if (citations && citations.length > 0 && inSources) { li++; continue; }

      // Підпис таблиці: "Таблиця N – Назва" — оформлення за methodInfo.formatting.tableFormat
      // (та сама логіка, що й для великих робіт): номер окремим рядком праворуч +
      // (центрована або жирна назва) → два рядки; інакше — один рядок.
      if (TABLE_CAPTION_RE.test(trimmedClean)) {
        const tfmt = methodInfo?.formatting || {};
        const tAlignRight = !!tfmt.tableNumberRight;
        const tCenter = !!tfmt.tableTitleCenter;
        const tBold = !!tfmt.tableTitleBold;
        const tTwoLine = tAlignRight && (tCenter || tBold);
        const dashIdx = trimmedClean.search(/ [–-] /);
        if (tTwoLine && dashIdx !== -1) {
          const numPart = trimmedClean.slice(0, dashIdx).trim();
          const namePart = trimmedClean.slice(dashIdx + 3).trim();
          children.push(new Paragraph({
            alignment: AlignmentType.RIGHT, indent: { firstLine: 0 },
            spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 },
            children: [new TextRun({ text: numPart, font: FONT, size: SIZE, color: "000000" })],
          }));
          children.push(new Paragraph({
            alignment: AlignmentType.CENTER, indent: { firstLine: 0 },
            spacing: { line: LINE, lineRule: "auto", before: 0, after: LINE },
            children: [new TextRun({ text: namePart, font: FONT, size: SIZE, bold: tBold, color: "000000" })],
          }));
        } else {
          children.push(new Paragraph({
            alignment: tAlignRight ? AlignmentType.RIGHT : AlignmentType.BOTH,
            indent: { firstLine: tAlignRight ? 0 : INDENT },
            spacing: { line: LINE, lineRule: "auto", before: 0, after: LINE },
            children: [new TextRun({ text: trimmedClean, font: FONT, size: SIZE, bold: tBold, color: "000000" })],
          }));
        }
        li++; continue;
      }

      // Таблиця markdown (рядки що починаються з |)
      if (/^\s*\|/.test(trimmed)) {
        const tableLines = [];
        while (li < lines.length && /^\s*\|/.test(lines[li].trim())) { tableLines.push(lines[li]); li++; }
        let peek = li;
        while (peek < lines.length && !lines[peek].trim()) peek++;
        const tbl = makeSimpleTableDocx(tableLines);
        if (tbl) {
          children.push(tbl);
          // Якщо одразу під таблицею йде рядок "Джерело:" — без інтервалу перед ним
          // (за методичкою); інакше — стандартний відступ від наступного тексту.
          const nextIsSourceCaption = peek < lines.length && SOURCE_CAPTION_RE.test(lines[peek].trim());
          if (!nextIsSourceCaption) {
            children.push(new Paragraph({ spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 }, children: [] }));
          }
        }
        continue;
      }

      // Підпис джерела під таблицею: "Джерело: ..." — без відступу, дрібніший шрифт,
      // без інтервалу від таблиці вище.
      if (SOURCE_CAPTION_RE.test(trimmedClean)) {
        children.push(new Paragraph({
          indent: { firstLine: 0 },
          spacing: { line: LINE, lineRule: "auto", before: 0, after: LINE },
          alignment: AlignmentType.LEFT,
          children: [new TextRun({ text: trimmedClean, font: FONT, size: SIZE_NUM, color: "000000" })],
        }));
        li++; continue;
      }

      // Підпис рисунку: "Рис. N — Назва" — жирний/курсив за methodInfo.formatting.figureFormat;
      // чорний, якщо зображення вище реально вставлено, інакше помаранчевий (потрібно вручну).
      if (SIMPLE_FIG_CAPTION_RE.test(trimmed)) {
        const ff = methodInfo?.formatting?.figureFormat || "";
        children.push(new Paragraph({
          alignment: AlignmentType.CENTER, indent: { firstLine: 0 },
          spacing: { line: LINE, lineRule: "auto", before: 0, after: LINE },
          children: [new TextRun({ text: trimmedClean, font: FONT, size: SIZE, bold: /жирн|bold/i.test(ff), italics: /курсив|italic/i.test(ff), color: wasDiagram ? "000000" : "B85C00" })],
        }));
        li++; continue;
      }

      // Заголовок списку джерел (парсинг з тексту — лише якщо citations не передано)
      if (SOURCES_HEADER_RE.test(trimmedClean)) {
        inSources = true;
        children.push(new Paragraph({
          spacing: { line: LINE, lineRule: "auto", before: LINE, after: Math.round(LINE * 0.5) },
          alignment: AlignmentType.CENTER, indent: { firstLine: 0 },
          children: [new TextRun({ text: trimmedClean.replace(/[:\.]$/, ""), font: FONT, size: SIZE, bold: true, color: "000000" })],
        }));
        li++; continue;
      }

      // Рядки списку джерел (парсинг з тексту)
      if (inSources) {
        if (!trimmed) { li++; continue; }
        const numMatch = trimmedClean.match(/^(\d+)[\.\)]/);
        const p = numMatch ? sourceParaWithBookmark(trimmed, parseInt(numMatch[1])) : sourcePara(trimmed);
        if (p) children.push(p);
        li++; continue;
      }

      // Звичайний абзац тексту
      const raw = trimmed.replace(/^#{1,6}\s+/, "").replace(/^[-*]\s+/, "");
      const plain = raw.replace(/\*\*(.+?)\*\*/g, "$1").replace(/\*(.+?)\*/g, "$1");
      if (!plain) { li++; continue; }
      // Анотація/ключові слова (укр. і англ.) — курсивом, за методичкою.
      const isAnotation = ANOTATION_RE.test(plain);
      children.push(new Paragraph({
        indent: { firstLine: INDENT },
        spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 },
        alignment: AlignmentType.BOTH,
        children: parseBodyLine(raw, isAnotation),
      }));
      li++;
    }
  }

  // Явний список джерел (для тез — передається tezyCitations)
  if (citations && citations.length > 0) {
    children.push(new Paragraph({
      spacing: { line: LINE, lineRule: "auto", before: LINE, after: Math.round(LINE * 0.5) },
      alignment: AlignmentType.CENTER, indent: { firstLine: 0 },
      children: [new TextRun({ text: sourcesHeading(info?.language), font: FONT, size: SIZE, bold: true, color: "000000" })],
    }));
    citations.forEach((citation, idx) => {
      const refNum = idx + 1;
      const p = sourceParaWithBookmark(`${refNum}. ${citation}`, refNum);
      if (p) children.push(p);
    });
  }

  const doc = new Document({
    styles: { default: { document: { run: { font: FONT, size: SIZE, color: "000000", language: { value: langCode } }, paragraph: { spacing: { line: LINE, lineRule: "auto" } } } } },
    footnotes: footnoteCounter > 0 ? footnotesRegistry : undefined,
    sections: [{
      properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: T, right: R, bottom: B, left: L } }, pageNumberStart: 1, titlePage: true },
      headers: pageNumbers ? {
        first: new Header({ children: [] }),
        default: new Header({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, spacing: { before: 0, after: 0 }, children: [new TextRun({ children: [PageNumber.CURRENT], font: FONT, size: SIZE_NUM, color: "000000" })] })] }),
      } : { default: new Header({ children: [] }) },
      children,
    }],
  });

  const prefix = info?.orderNumber ? info.orderNumber + "_" : (orderId ? orderId + "_" : "");
  const safeName = prefix + (info?.topic || title || "робота").replace(/[^\wА-ЯҐЄІЇа-яґєії\s]/g, "").trim().slice(0, 40);
  return packDocx(doc, safeName + ".docx");
}
