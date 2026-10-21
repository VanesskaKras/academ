import PptxGenJS from "pptxgenjs";
import { DESIGN_STYLES, resolveDesign } from "./pptxDesign.js";

// Converts any value to string safely (Claude may return arrays/objects instead of strings)
function toStr(v) {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map(item => (typeof item === 'object' && item !== null ? (item.text || item.header || Object.values(item).join(' ')) : String(item))).join('\n');
  if (typeof v === 'object') return v.text || v.label || String(Object.values(v).filter(Boolean).join(' ') || '');
  return String(v);
}

const W = 10;
const H = 5.625;
const ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII"];
const COLOR_NAMES = new Set(["blue", "green", "orange", "red", "yellow", "purple", "pink", "white", "black", "gray", "cyan", "magenta", "violet", "brown", "beige"]);

// Грубо оцінює, чи влізе текст у бокс, і зменшує кегль, доки не влізе.
// PowerPoint сам не стискає текст при відкритті файлу, тому рахуємо тут.
function fitSize(text, w, h, size, min = 10, charW = 0.52, lineH = 1.2) {
  const t = String(text || "");
  if (!t) return size;
  // найдовше слово не повинно рватися посередині (вузькі панелі, великий кегль)
  const longest = t.split(/\s+/).reduce((m, word) => Math.max(m, word.length), 0);
  for (let s = size; s > min; s--) {
    const cpl = Math.max(1, Math.floor((w * 72) / (s * charW)));
    if (longest > cpl) continue;
    const lines = t.split("\n").reduce((n, p) => n + Math.max(1, Math.ceil((p.length * 1.1) / cpl)), 0);
    if ((lines * s * lineH) / 72 <= h) return s;
  }
  return min;
}

// Уніфікує пункти з visual.items / steps / points / content у [{title, text}]
function normItems(data) {
  const raw = data.visual?.items || data.steps || data.points
    || (data.content ? toStr(data.content).split("\n").filter(Boolean) : []);
  return (Array.isArray(raw) ? raw : [raw]).map(it => {
    if (it && typeof it === "object") {
      const title = toStr(it.title || it.header || "");
      const text = toStr(it.text || "");
      return { title, text: text === title ? "" : text };
    }
    return { title: "", text: toStr(it) };
  }).filter(x => x.title || x.text);
}

function normStats(data) {
  const v = data.visual || {};
  const stats = v.stats || (v.stat
    ? [{ value: v.stat, label: v.stat_label || "" }, ...(v.stat2 ? [{ value: v.stat2, label: v.stat2_label || "" }] : [])]
    : []);
  return stats.slice(0, 3).map(st => ({ value: toStr(st.value ?? ""), label: toStr(st.label || "") }));
}

const cleanSubtitle = (t) => toStr(t)
  .replace(/\|?\s*Замовлення\s*№?\s*\S+/gi, "")
  .replace(/\|?\s*замовлення\s*#\S+/gi, "")
  .trim().replace(/\s*\|\s*$/, "").trim();

export async function exportToPptxFile(slideData, info, orderId) {
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_16x9";
  const SH = pptx.ShapeType;

  const design = resolveDesign(slideData, info);
  const STYLE = DESIGN_STYLES[design.style];
  const P = STYLE.palettes[design.palette];
  const F = STYLE.fonts;
  const slides = slideData.slides || [];
  const total = slides.length;
  const coverTitle = toStr(slides.find(s => s.layout === "title_slide")?.title || "");
  const topicRaw = toStr(info?.topic || coverTitle);
  const topic = topicRaw.length > 80 ? topicRaw.slice(0, 78).trimEnd() + "…" : topicRaw;

  // ── Примітиви ──
  const shape = (s, type, x, y, w, h, color, o = {}) => {
    s.addShape(type, {
      x, y, w, h,
      fill: color ? { color, transparency: o.transparency || 0 } : { color: "FFFFFF", transparency: 100 },
      line: o.line ? { color: o.line.color, width: o.line.width || 0.75, transparency: o.line.transparency || 0, ...(o.line.dash ? { dashType: o.line.dash } : {}) } : { type: "none" },
      ...(o.rotate ? { rotate: o.rotate } : {}),
      ...(o.rectRadius ? { rectRadius: o.rectRadius } : {}),
      // копія: pptxgenjs мутує переданий обʼєкт тіні (blur/offset/angle/opacity × одиниці на кожній фігурі),
      // спільний cardShadow з 2-го слайда виходив за межі схеми (dir, alpha) → PowerPoint «чинив» файл і
      // видаляв вміст слайдів (замовлення 41400, 30.09.2026)
      ...(o.shadow ? { shadow: { ...o.shadow } } : {}),
      ...(o.flipH ? { flipH: true } : {}),
      ...(o.flipV ? { flipV: true } : {}),
    });
  };
  const rect = (s, x, y, w, h, color, o) => shape(s, SH.rect, x, y, w, h, color, o);
  const hline = (s, x, y, w, color, width = 0.75, transparency = 0, dash) =>
    s.addShape(SH.line, { x, y, w, h: 0, line: { color, width, transparency, ...(dash ? { dashType: dash } : {}) } });
  const vline = (s, x, y, h, color, width = 0.75, transparency = 0, dash) =>
    s.addShape(SH.line, { x, y, w: 0, h, line: { color, width, transparency, ...(dash ? { dashType: dash } : {}) } });
  // довільний відрізок (x1,y1)→(x2,y2): лінія в pptx — це бокс, похилу задаємо flipV
  const seg = (s, x1, y1, x2, y2, color, width = 1, transparency = 0) => s.addShape(SH.line, {
    x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1),
    line: { color, width, transparency }, ...((x2 - x1) * (y2 - y1) < 0 ? { flipV: true } : {}),
  });
  // змішує два hex-кольори: t=0 → a, t=1 → b
  const mix = (a, b, t) => [0, 2, 4].map(i => {
    const v = Math.round(parseInt(a.slice(i, i + 2), 16) * (1 - t) + parseInt(b.slice(i, i + 2), 16) * t);
    return v.toString(16).padStart(2, "0");
  }).join("").toUpperCase();
  // перший пункт «Мета: …» — центр схеми в «Орбіті» й корінь у «Дереві»
  const isGoal = (it) => /^\s*(мета|ціль|goal|aim|purpose)(?=$|[\s:.,—–-])/i.test(it?.title || it?.text || "");

  // text: рядок або масив runs; розмір підбирається під бокс, якщо не fit:false
  const text = (s, content, x, y, w, h, o = {}) => {
    if (content == null || content === "" || (Array.isArray(content) && !content.length)) return;
    const plain = Array.isArray(content) ? content.map(r => r.text).join("\n") : String(content);
    const size = o.fit === false ? (o.size || 14) : fitSize(plain, w, h, o.size || 14, o.min || 10, o.charW || (o.bold ? 0.58 : 0.52));
    s.addText(content, {
      x, y, w, h,
      fontFace: o.font === "title" ? F.title : (o.font || F.body),
      fontSize: size,
      color: o.color || P.ink,
      bold: !!o.bold, italic: !!o.italic,
      align: o.align || "left", valign: o.valign || "top",
      wrap: true, margin: [0, 0, 0, 0],
      ...(o.spacing ? { charSpacing: o.spacing } : {}),
      ...(o.lineSpacing ? { lineSpacingMultiple: o.lineSpacing } : {}),
    });
  };
  const bg = (s, color = P.bg) => { s.background = { color }; };
  const onColor = (c) => (c === P.acc2 && design.style === "bold") ? P.ink : "FFFFFF";

  // Рядки списку: маркер (стиль задає) + заголовок жирним + текст
  const rowsList = (s, box, items, o) => {
    const list = items.slice(0, o.max || 6);
    const n = list.length;
    if (!n) return;
    const gap = o.gap ?? 0;
    const rowH = (box.h - gap * (n - 1)) / n;
    const base = n <= 3 ? 16 : n === 4 ? 15 : n === 5 ? 14 : 13;
    list.forEach((it, i) => {
      const y = box.y + i * (rowH + gap);
      o.card?.(s, box.x, y, box.w, rowH, i);
      if (o.sep && (i > 0 || o.sep.first)) hline(s, box.x, y, box.w, o.sep.color, o.sep.width || 0.75, o.sep.transparency || 0, o.sep.dash);
      const pad = o.pad || 0;
      const m = Math.min(o.markerSize || 0.42, rowH * 0.75);
      const mx = box.x + pad;
      o.marker(s, i, mx, y + (rowH - m) / 2, m);
      const tx = mx + (o.markerW || m) + 0.18;
      const tw = box.x + box.w - pad - tx;
      const runs = [];
      if (it.title) runs.push({ text: it.title, options: { bold: true, color: o.titleColor, breakLine: !!it.text } });
      if (it.text) runs.push({ text: it.text, options: { color: o.textColor } });
      text(s, runs, tx, y + 0.06, tw, rowH - 0.12, { size: base, min: 10, valign: "middle" });
    });
  };

  // Колонки-кроки: маркер зверху, під ним заголовок і текст
  const columns = (s, box, items, o) => {
    const list = items.slice(0, 4);
    const n = list.length;
    if (!n) return;
    const gap = o.gap ?? 0.3;
    const cw = (box.w - gap * (n - 1)) / n;
    const pad = o.pad || 0;
    const ms = o.markerSize || 0.5;
    o.before?.(s, box, n, cw, gap, ms);
    list.forEach((it, i) => {
      const x = box.x + i * (cw + gap);
      const cols = o.card?.(s, x, box.y, cw, box.h, i) || {};
      let y = box.y + pad;
      if (o.topLine) { hline(s, x, box.y, cw, o.topLine.color, o.topLine.width || 0.75, o.topLine.transparency || 0); y += 0.18; }
      o.marker(s, i, x + pad, y, ms);
      y += ms + 0.16;
      const runs = [];
      if (it.title) runs.push({ text: it.title, options: { bold: true, color: cols.title || o.titleColor, breakLine: !!it.text } });
      if (it.text) runs.push({ text: it.text, options: { color: cols.text || o.textColor } });
      text(s, runs, x + pad, y, cw - pad * 2, box.y + box.h - y - pad, { size: n <= 3 ? 15 : 13, min: 10 });
    });
  };

  const romanMarker = (color, size) => (s, i, x, y, m) =>
    text(s, ROMAN[i] || String(i + 1), x, y, Math.max(m, 0.6), m, { font: "title", size, color, fit: false, valign: "middle" });
  const numText = (color, size, font) => (s, i, x, y, m) =>
    text(s, String(i + 1).padStart(2, "0"), x, y, Math.max(m, 0.6), m, { font, size, color, bold: font !== "title", fit: false, valign: "middle" });
  const dotNum = (type, fills, txt) => (s, i, x, y, m) => {
    const c = fills[i % fills.length];
    shape(s, type, x, y, m, m, c);
    text(s, String(i + 1), x, y, m, m, { size: Math.round(m * 30), bold: true, color: txt ? txt(c) : "FFFFFF", align: "center", valign: "middle", fit: false });
  };

  const diamondOrnament = (s, cx, y) => {
    hline(s, cx - 1.35, y + 0.07, 1.1, P.acc);
    shape(s, SH.diamond, cx - 0.07, y, 0.14, 0.14, P.acc);
    hline(s, cx + 0.25, y + 0.07, 1.1, P.acc);
  };
  const peopleRuns = (d, o = {}) => {
    const runs = [];
    const lab = (t) => ({ text: t, options: { bold: true, color: o.labelColor || o.color, breakLine: false } });
    if (d.student) { runs.push(lab("Виконав(ла): ")); runs.push({ text: toStr(d.student), options: { color: o.color, breakLine: true } }); }
    if (d.supervisor) { runs.push(lab("Науковий керівник: ")); runs.push({ text: toStr(d.supervisor), options: { color: o.color, breakLine: true } }); }
    if (o.withInst && d.institution) runs.push({ text: toStr(d.institution), options: { color: o.color } });
    if (runs.length) runs[runs.length - 1].options.breakLine = false;
    return runs;
  };
  const labeled = (label, value, o) => [
    { text: label.toUpperCase(), options: { fontSize: 9, color: o.labelColor, charSpacing: 2, breakLine: true } },
    { text: toStr(value), options: { fontSize: o.size || 13, color: o.color } },
  ];
  const cardShadow = { type: "outer", blur: 8, offset: 2, angle: 90, color: "1D2433", opacity: 0.12 };
  const card = (s, x, y, w, h, color = "FFFFFF") => shape(s, SH.roundRect, x, y, w, h, color, { rectRadius: 0.12, shadow: cardShadow });
  // висота під підсумкове речення слайда з цифрами: рахуємо від довжини тексту,
  // щоб довгий підсумок не стискався до дрібного шрифту в низенькій смужці
  const noteHeight = (t, w, size, max = 1.6) => {
    const cpl = Math.max(1, Math.floor((w * 72) / (size * 0.52)));
    const lines = Math.ceil((String(t || "").length * 1.1) / cpl);
    return Math.min(max, Math.max(0.55, (lines * size * 1.3) / 72 + 0.1));
  };
  const pctOf = (v) => { const m = String(v).match(/^\s*(\d{1,3}(?:[.,]\d+)?)\s*%\s*$/); const n = m ? parseFloat(m[1].replace(",", ".")) : NaN; return n >= 0 && n <= 100 ? n : null; };

  // ════════════════════ СТИЛІ ════════════════════
  const STYLES = {
    // ── Академічний класичний ──
    acad: {
      cover(s, d) {
        bg(s);
        if (d.institution) text(s, toStr(d.institution).toUpperCase(), 0.8, 0.3, 8.4, 0.45, { size: 11, min: 8, color: P.acc, align: "center", valign: "middle", spacing: 2 });
        hline(s, 2.2, 0.86, 5.6, P.acc); hline(s, 2.2, 0.92, 5.6, P.acc);
        text(s, toStr(d.title || info?.topic), 1.0, 1.15, 8.0, 2.0, { font: "title", size: 30, min: 18, align: "center", valign: "middle" });
        if (d.work_type) text(s, toStr(d.work_type), 1, 3.2, 8, 0.45, { font: "title", italic: true, size: 15, color: P.acc, align: "center" });
        if (d.student) text(s, labeled("Виконав(ла)", d.student, { labelColor: P.muted, color: P.ink }), 0.9, 3.95, 4.1, 0.8, { fit: false, size: 13 });
        if (d.supervisor) text(s, labeled("Науковий керівник", d.supervisor, { labelColor: P.muted, color: P.ink }), 5.0, 3.95, 4.1, 0.8, { fit: false, size: 13, align: "right" });
        text(s, String(d.year || new Date().getFullYear()), 0, 5.0, W, 0.35, { size: 12, color: P.muted, align: "center", fit: false });
      },
      closing(s, d) {
        bg(s);
        hline(s, 3.2, 1.65, 3.6, P.acc); hline(s, 3.2, 1.71, 3.6, P.acc);
        text(s, toStr(d.title), 1, 1.95, 8, 1.2, { font: "title", size: 36, min: 20, align: "center", valign: "middle" });
        text(s, cleanSubtitle(d.subtitle), 1, 3.2, 8, 0.6, { font: "title", italic: true, size: 16, color: P.acc, align: "center" });
        hline(s, 3.2, 3.95, 3.6, P.acc); hline(s, 3.2, 4.01, 3.6, P.acc);
      },
      chrome(s, title, idx) {
        bg(s);
        text(s, toStr(title), 0.7, 0.3, 8.6, 0.8, { font: "title", size: 24, min: 16, valign: "bottom" });
        hline(s, 0.7, 1.2, 0.6, P.acc, 2.25);
        hline(s, 0.7, 5.18, 8.6, P.muted, 0.5, 60);
        text(s, topic, 0.7, 5.24, 7.2, 0.28, { size: 9, color: P.muted, fit: false });
        text(s, `${idx + 1} / ${total}`, 8.1, 5.24, 1.2, 0.28, { size: 9, color: P.muted, align: "right", fit: false });
        return { x: 0.7, y: 1.4, w: 8.6, h: 3.6 };
      },
      list(s, box, items) {
        rowsList(s, box, items, { marker: romanMarker(P.acc, 18), markerW: 0.5, sep: { color: P.muted, transparency: 65 }, titleColor: P.ink, textColor: P.muted });
      },
      steps(s, box, items) {
        columns(s, box, items, { marker: romanMarker(P.acc, 22), topLine: { color: P.ink, transparency: 70 }, titleColor: P.ink, textColor: P.muted });
      },
      stats(s, d, idx) {
        const box = this.chrome(s, d.title, idx);
        const stats = normStats(d);
        const n = stats.length;
        if (n) {
          const cw = box.w / n;
          stats.forEach((st, i) => {
            const x = box.x + i * cw;
            if (i > 0) vline(s, x, box.y + 0.2, 1.9, P.ink, 0.75, 75);
            const px = i === 0 ? 0 : 0.3;
            text(s, st.value, x + px, box.y + 0.15, cw - px - 0.2, 1.0, { font: "title", size: 40, min: 22, color: P.acc, valign: "bottom" });
            text(s, st.label, x + px, box.y + 1.25, cw - px - 0.2, 0.85, { size: 13, min: 10 });
          });
        }
        if (d.content) {
          const nh = noteHeight(d.content, box.w - 0.2, 15);
          rect(s, box.x, box.y + box.h - nh - 0.05, 0.05, nh, P.acc);
          text(s, toStr(d.content), box.x + 0.2, box.y + box.h - nh - 0.05, box.w - 0.2, nh, { font: "title", italic: true, size: 15, min: 12, valign: "middle" });
        }
      },
      panel(s, x, y, w, h) { rect(s, x, y, w, h, P.soft); return { color: P.ink, strong: P.acc }; },
      callout(s, x, y, w, h, t) {
        rect(s, x, y, 0.05, h, P.acc);
        text(s, t, x + 0.2, y, w - 0.2, h, { font: "title", italic: true, size: 15, min: 10, valign: "middle" });
      },
      table: { head: P.ink, headText: "FFFFFF", zebra: P.soft, alt: "FFFFFF", text: P.ink, border: "D5D9E0" },
    },

    // ── Геометрія ──
    geo: {
      cover(s, d) {
        bg(s);
        shape(s, SH.ellipse, 5.7, -2.4, 6.2, 6.2, P.acc);
        shape(s, SH.ellipse, 4.9, 4.425, 2.1, 2.1, P.acc2);
        shape(s, SH.rtTriangle, 0, 4.325, 1.7, 1.3, P.acc2);
        text(s, String(d.year || new Date().getFullYear()), 7.0, 0.45, 2.4, 0.6, { size: 24, bold: true, color: "FFFFFF", align: "right", fit: false });
        if (d.institution) text(s, toStr(d.institution), 0.6, 0.3, 5.0, 0.4, { size: 10, min: 8, color: P.muted });
        if (d.work_type) text(s, toStr(d.work_type).toUpperCase(), 0.6, 0.75, 5.2, 0.35, { size: 11, min: 8, bold: true, color: P.acc, spacing: 2 });
        text(s, toStr(d.title || info?.topic), 0.6, 1.15, 5.2, 2.15, { font: "title", size: 28, min: 16, bold: true });
        text(s, peopleRuns(d, { color: P.ink, labelColor: P.acc }), 0.6, 3.45, 4.3, 0.85, { size: 12, min: 9 });
      },
      closing(s, d) {
        bg(s);
        shape(s, SH.ellipse, 5.7, -2.4, 6.2, 6.2, P.acc);
        shape(s, SH.ellipse, 4.9, 4.425, 2.1, 2.1, P.acc2);
        shape(s, SH.rtTriangle, 0, 4.325, 1.7, 1.3, P.acc2);
        text(s, toStr(d.title), 0.6, 1.5, 5.0, 1.6, { size: 36, min: 20, bold: true, valign: "bottom" });
        text(s, cleanSubtitle(d.subtitle), 0.6, 3.2, 4.8, 0.8, { size: 16, color: P.muted });
      },
      chrome(s, title) {
        bg(s);
        shape(s, SH.ellipse, 8.9, -0.55, 1.55, 1.55, P.acc2);
        shape(s, SH.rtTriangle, 9.2, 5.025, 0.8, 0.6, P.acc, { flipH: true });
        text(s, toStr(title), 0.6, 0.35, 7.9, 0.8, { size: 22, min: 15, bold: true, valign: "middle" });
        return { x: 0.7, y: 1.35, w: 8.3, h: 3.75 };
      },
      list(s, box, items) {
        rowsList(s, box, items, { marker: dotNum(SH.ellipse, [P.acc, P.acc2]), gap: 0.08, titleColor: P.ink, textColor: P.muted });
      },
      steps(s, box, items) {
        columns(s, box, items, {
          markerSize: 0.55,
          marker: dotNum(SH.ellipse, [P.acc]),
          before: (sl, b, n, cw, gap, ms) => { if (n > 1) hline(sl, b.x + ms / 2, b.y + ms / 2, (n - 1) * (cw + gap), P.acc, 2.5, 55); },
          titleColor: P.ink, textColor: P.muted,
        });
      },
      stats(s, d, idx) {
        const box = this.chrome(s, d.title, idx);
        const stats = normStats(d);
        const n = stats.length;
        if (n) {
          const cw = box.w / n;
          const diam = Math.min(1.65, cw - 0.4);
          const fills = [P.acc, P.acc2, P.ink];
          stats.forEach((st, i) => {
            const x = box.x + i * cw;
            const cx = x + (cw - diam) / 2;
            shape(s, SH.ellipse, cx, box.y + 0.05, diam, diam, fills[i]);
            text(s, st.value, cx + 0.12, box.y + 0.05, diam - 0.24, diam, { size: 26, min: 12, bold: true, color: "FFFFFF", align: "center", valign: "middle" });
            text(s, st.label, x + 0.15, box.y + diam + 0.2, cw - 0.3, 0.75, { size: 12, min: 9, align: "center" });
          });
        }
        if (d.content) {
          const nh = noteHeight(d.content, box.w - 0.5, 13, 1.05);
          shape(s, SH.ellipse, box.x, box.y + box.h - nh / 2 - 0.09, 0.18, 0.18, P.acc2);
          text(s, toStr(d.content), box.x + 0.3, box.y + box.h - nh, box.w - 0.5, nh, { size: 13, min: 11, bold: true, valign: "middle" });
        }
      },
      panel(s, x, y, w, h) { shape(s, SH.roundRect, x, y, w, h, P.acc, { rectRadius: 0.2 }); return { color: "FFFFFF", strong: "FFFFFF" }; },
      callout(s, x, y, w, h, t) {
        shape(s, SH.ellipse, x, y + h / 2 - 0.09, 0.18, 0.18, P.acc2);
        text(s, t, x + 0.3, y, w - 0.3, h, { size: 14, min: 10, bold: true, valign: "middle" });
      },
      table: { head: P.acc, headText: "FFFFFF", zebra: P.soft, alt: "FFFFFF", text: P.ink, border: "FFFFFF" },
    },

    // ── Журнальний ──
    mag: {
      cover(s, d) {
        bg(s);
        rect(s, 0, 0, 3.4, H, P.acc);
        if (d.work_type) text(s, toStr(d.work_type).toUpperCase(), 0.35, 0.45, 2.7, 0.9, { size: 11, min: 8, color: "FFFFFF", spacing: 2 });
        if (d.institution) text(s, toStr(d.institution), 0.35, 1.45, 2.7, 1.4, { size: 10, min: 8, color: "FFFFFF" });
        text(s, String(d.year || new Date().getFullYear()), 0.25, 4.05, 3.1, 1.2, { font: "title", size: 60, color: "FFFFFF", valign: "bottom", fit: false });
        text(s, toStr(d.title || info?.topic), 3.85, 0.55, 5.75, 3.05, { font: "title", size: 32, min: 18, valign: "bottom", lineSpacing: 0.95 });
        hline(s, 3.85, 3.75, 5.75, P.ink, 1);
        if (d.student) text(s, labeled("Виконав(ла)", d.student, { labelColor: P.acc, color: P.ink, size: 12 }), 3.85, 3.92, 2.75, 1.0, { fit: false, size: 12 });
        if (d.supervisor) text(s, labeled("Науковий керівник", d.supervisor, { labelColor: P.acc, color: P.ink, size: 12 }), 6.75, 3.92, 2.85, 1.0, { fit: false, size: 12 });
      },
      closing(s, d) {
        bg(s);
        rect(s, 0, 0, 3.4, H, P.acc);
        text(s, toStr(d.title), 3.85, 1.2, 5.75, 2.3, { font: "title", size: 42, min: 22, valign: "bottom" });
        hline(s, 3.85, 3.65, 5.75, P.ink, 1);
        text(s, cleanSubtitle(d.subtitle), 3.85, 3.8, 5.75, 0.8, { size: 14, color: P.muted });
      },
      chrome(s, title, idx, o = {}) {
        bg(s);
        text(s, String(idx + 1).padStart(2, "0"), 0.35, 0.2, 1.5, 1.0, { font: "title", size: 48, color: P.acc, fit: false });
        vline(s, 1.85, 0.45, 4.7, P.ink, 0.75, 80);
        text(s, toStr(title), 2.15, 0.35, o.titleW ?? 7.3, 0.9, { font: "title", size: 24, min: 15, valign: "middle" });
        return { x: 2.15, y: 1.45, w: o.boxW ?? 7.3, h: 3.8 };
      },
      list(s, box, items) {
        rowsList(s, box, items, { marker: numText(P.acc, 14), markerW: 0.45, sep: { color: P.ink, first: true }, titleColor: P.ink, textColor: P.muted });
      },
      steps(s, box, items) {
        rowsList(s, box, items, { max: 4, marker: numText(P.acc, 22, "title"), markerW: 0.6, sep: { color: P.ink, first: true }, titleColor: P.ink, textColor: P.muted });
      },
      stats(s, d, idx) {
        const stats = normStats(d);
        const [hero, ...rest] = stats;
        if (hero) {
          rect(s, 5.6, 0, 4.4, H, P.ink);
          text(s, hero.value, 5.9, 0.9, 3.8, 1.7, { font: "title", size: 72, min: 30, color: P.acc, valign: "bottom", charW: 0.55 });
          text(s, hero.label, 5.95, 2.75, 3.7, 1.5, { size: 16, min: 11, color: "FFFFFF" });
        }
        const box = this.chrome(s, d.title, idx, hero ? { titleW: 3.3, boxW: 3.2 } : {});
        const rowH = 0.95;
        rest.forEach((st, i) => {
          const y = box.y + i * rowH;
          hline(s, box.x, y, box.w, P.ink);
          text(s, st.value, box.x, y + 0.1, 1.35, rowH - 0.2, { font: "title", size: 28, min: 14, valign: "middle", charW: 0.55 });
          text(s, st.label, box.x + 1.45, y + 0.1, box.w - 1.45, rowH - 0.2, { size: 11, min: 9, valign: "middle" });
        });
        // підсумок займає все місце під показниками — інакше з одним числом середина слайда порожня,
        // а довгий текст стискається до дрібного шрифту внизу
        if (d.content) {
          const ny = box.y + rest.length * rowH + (rest.length ? 0.25 : 0);
          if (!rest.length) rect(s, box.x, ny, 0.6, 0.05, P.acc);
          const top = ny + (rest.length ? 0 : 0.3);
          text(s, toStr(d.content), box.x, top, box.w, box.y + box.h - top, { size: rest.length ? 14 : 17, min: 10, color: P.ink, lineSpacing: 1.1 });
        }
      },
      panel(s, x, y, w, h) { rect(s, x, y, w, h, P.ink); return { color: "FFFFFF", strong: P.acc }; },
      callout(s, x, y, w, h, t) {
        rect(s, x, y, w, h, P.acc);
        text(s, t, x + 0.25, y + 0.05, w - 0.5, h - 0.1, { size: 14, min: 10, bold: true, color: "FFFFFF", valign: "middle" });
      },
      table: { head: P.ink, headText: "FFFFFF", zebra: P.soft, alt: P.bg, text: P.ink, border: "D6D6D0" },
    },

    // ── Темний преміум ──
    dark: {
      frame(s) { rect(s, 0.35, 0.35, 9.3, 4.925, null, { line: { color: P.acc, width: 0.75, transparency: 45 } }); },
      cover(s, d) {
        bg(s); this.frame(s);
        if (d.institution) text(s, toStr(d.institution), 1, 0.5, 8, 0.32, { size: 10, min: 8, color: P.muted, align: "center" });
        if (d.work_type) text(s, toStr(d.work_type).toUpperCase(), 1, 0.88, 8, 0.35, { size: 11, min: 8, color: P.acc, align: "center", spacing: 5 });
        text(s, toStr(d.title || info?.topic), 1.2, 1.3, 7.6, 1.85, { font: "title", size: 34, min: 20, align: "center", valign: "middle" });
        diamondOrnament(s, W / 2, 3.3);
        text(s, peopleRuns(d, { color: P.muted }), 1, 3.6, 8, 0.8, { size: 12, min: 9, align: "center" });
        text(s, String(d.year || new Date().getFullYear()), 0, 4.55, W, 0.35, { size: 12, color: P.acc, align: "center", spacing: 3, fit: false });
      },
      closing(s, d) {
        bg(s); this.frame(s);
        text(s, toStr(d.title), 1, 1.6, 8, 1.4, { font: "title", size: 40, min: 22, align: "center", valign: "middle" });
        diamondOrnament(s, W / 2, 3.15);
        text(s, cleanSubtitle(d.subtitle), 1, 3.5, 8, 0.7, { size: 14, color: P.muted, align: "center" });
      },
      chrome(s, title) {
        bg(s); this.frame(s);
        text(s, toStr(title), 0.8, 0.55, 8.4, 0.8, { font: "title", size: 26, min: 16, valign: "middle" });
        return { x: 0.9, y: 1.5, w: 8.2, h: 3.5 };
      },
      list(s, box, items) {
        rowsList(s, box, items, { marker: romanMarker(P.acc, 20), markerW: 0.5, sep: { color: P.acc, transparency: 70 }, titleColor: P.ink, textColor: P.muted });
      },
      steps(s, box, items) {
        columns(s, box, items, { marker: romanMarker(P.acc, 24), topLine: { color: P.acc, transparency: 50 }, titleColor: P.ink, textColor: P.muted });
      },
      stats(s, d, idx) {
        const box = this.chrome(s, d.title, idx);
        const stats = normStats(d);
        const n = stats.length;
        if (n) {
          const cw = box.w / n;
          stats.forEach((st, i) => {
            const x = box.x + i * cw;
            if (i > 0) vline(s, x, box.y + 0.3, 1.8, P.acc, 0.75, 60);
            text(s, st.value, x + 0.2, box.y + 0.2, cw - 0.4, 1.05, { font: "title", size: 44, min: 22, color: P.acc, align: "center", valign: "bottom" });
            text(s, st.label, x + 0.2, box.y + 1.35, cw - 0.4, 0.8, { size: 12, min: 9, color: P.muted, align: "center" });
          });
        }
        if (d.content) {
          const nh = noteHeight(d.content, box.w - 0.8, 16, 1.3);
          text(s, toStr(d.content), box.x + 0.4, box.y + box.h - nh, box.w - 0.8, nh, { font: "title", italic: true, size: 16, min: 12, align: "center", valign: "middle" });
        }
      },
      panel(s, x, y, w, h) { rect(s, x, y, w, h, P.soft, { line: { color: P.acc, width: 0.75, transparency: 50 } }); return { color: P.ink, strong: P.acc }; },
      callout(s, x, y, w, h, t) {
        hline(s, x, y, 0.8, P.acc, 1);
        text(s, t, x, y + 0.1, w, h - 0.1, { font: "title", italic: true, size: 16, min: 10, valign: "middle" });
      },
      table: { head: P.acc, headText: P.bg, zebra: P.soft, alt: P.bg, text: P.ink, border: P.soft },
    },

    // ── Картки ──
    cards: {
      cover(s, d) {
        bg(s);
        card(s, 0.5, 0.5, 6.0, 4.625);
        if (d.work_type) {
          const kind = toStr(d.work_type);
          const cw = Math.min(5.3, 0.4 + kind.length * 0.075);
          shape(s, SH.roundRect, 0.85, 0.85, cw, 0.36, P.soft, { rectRadius: 0.18 });
          text(s, kind, 0.85, 0.85, cw, 0.36, { size: 10, bold: true, color: P.acc, align: "center", valign: "middle", fit: false });
        }
        text(s, toStr(d.title || info?.topic), 0.85, 1.4, 5.3, 2.3, { font: "title", size: 28, min: 16, valign: "middle" });
        text(s, peopleRuns(d, { color: P.muted }), 0.85, 3.9, 5.3, 0.95, { size: 11, min: 9, valign: "bottom" });
        shape(s, SH.roundRect, 6.75, 0.5, 2.75, 4.625, P.acc, { rectRadius: 0.12 });
        if (d.institution) text(s, toStr(d.institution), 7.0, 0.75, 2.3, 1.8, { size: 11, min: 8, color: "FFFFFF" });
        text(s, String(d.year || new Date().getFullYear()), 7.0, 3.9, 2.3, 1.0, { font: "title", size: 40, color: "FFFFFF", valign: "bottom", fit: false });
      },
      closing(s, d) {
        bg(s);
        shape(s, SH.roundRect, 0.5, 0.5, 9, 4.625, P.acc, { rectRadius: 0.14, shadow: cardShadow });
        text(s, toStr(d.title), 1, 1.6, 8, 1.4, { font: "title", size: 40, min: 22, color: "FFFFFF", align: "center", valign: "middle" });
        text(s, cleanSubtitle(d.subtitle), 1, 3.1, 8, 0.7, { size: 14, color: "FFFFFF", align: "center" });
      },
      chrome(s, title) {
        bg(s);
        text(s, toStr(title), 0.5, 0.3, 9, 0.8, { font: "title", size: 22, min: 15, valign: "middle" });
        return { x: 0.5, y: 1.25, w: 9, h: 3.95 };
      },
      list(s, box, items) {
        rowsList(s, box, items, {
          gap: 0.12, pad: 0.2, markerSize: 0.4,
          card: (sl, x, y, w, h) => card(sl, x, y, w, h),
          marker: dotNum(SH.ellipse, [P.soft], () => P.acc),
          titleColor: P.ink, textColor: P.muted,
        });
      },
      steps(s, box, items) {
        columns(s, box, items, {
          gap: 0.2, pad: 0.22, markerSize: 0.42,
          card: (sl, x, y, w, h) => { card(sl, x, y, w, h); },
          marker: dotNum(SH.ellipse, [P.soft], () => P.acc),
          titleColor: P.ink, textColor: P.muted,
        });
      },
      stats(s, d, idx) {
        const box = this.chrome(s, d.title, idx);
        const stats = normStats(d);
        const n = stats.length;
        const ch = d.content ? 2.35 : 2.9;
        if (n) {
          const gap = 0.2;
          const cw = (box.w - gap * (n - 1)) / n;
          stats.forEach((st, i) => {
            const x = box.x + i * (cw + gap);
            card(s, x, box.y, cw, ch);
            text(s, st.value, x + 0.25, box.y + 0.2, cw - 0.5, 0.9, { font: "title", size: 34, min: 18, color: P.acc, valign: "bottom", charW: 0.56 });
            text(s, st.label, x + 0.25, box.y + 1.2, cw - 0.5, ch - 1.6, { size: 12, min: 9 });
            const pct = pctOf(st.value);
            if (pct != null) {
              shape(s, SH.roundRect, x + 0.25, box.y + ch - 0.3, cw - 0.5, 0.09, P.soft, { rectRadius: 0.045 });
              if (pct > 0) shape(s, SH.roundRect, x + 0.25, box.y + ch - 0.3, Math.max(0.09, (cw - 0.5) * pct / 100), 0.09, P.acc, { rectRadius: 0.045 });
            }
          });
        }
        if (d.content) {
          shape(s, SH.roundRect, box.x, box.y + ch + 0.25, box.w, box.h - ch - 0.25, P.soft, { rectRadius: 0.12 });
          text(s, toStr(d.content), box.x + 0.3, box.y + ch + 0.3, box.w - 0.6, box.h - ch - 0.35, { size: 13, min: 10, bold: true, valign: "middle" });
        }
      },
      panel(s, x, y, w, h) { card(s, x, y, w, h); return { color: P.ink, strong: P.acc }; },
      callout(s, x, y, w, h, t) {
        shape(s, SH.roundRect, x, y, w, h, P.soft, { rectRadius: 0.12 });
        text(s, t, x + 0.3, y + 0.05, w - 0.6, h - 0.1, { size: 13, min: 10, bold: true, valign: "middle" });
      },
      table: { head: P.acc, headText: "FFFFFF", zebra: P.soft, alt: "FFFFFF", text: P.ink, border: "E1E5EC" },
    },

    // ── Сміливі блоки ──
    bold: {
      slant(s, color) {
        rect(s, 0, 0, 5.6, H, color);
        shape(s, SH.rtTriangle, 5.6, 0, 1.4, H, color, { flipV: true });
      },
      cover(s, d) {
        bg(s, P.ink); this.slant(s, P.acc);
        if (d.work_type) text(s, toStr(d.work_type).toUpperCase(), 0.5, 0.45, 5.0, 0.4, { size: 11, min: 8, bold: true, color: "FFFFFF", spacing: 1 });
        text(s, toStr(d.title || info?.topic), 0.5, 0.95, 5.1, 2.75, { font: "title", size: 30, min: 16, color: "FFFFFF", charW: 0.68 });
        rect(s, 7.8, 0.55, 1.7, 1.7, P.acc2);
        text(s, String(d.year || new Date().getFullYear()), 7.8, 0.55, 1.7, 1.7, { font: "title", size: 22, color: P.ink, align: "center", valign: "middle", fit: false });
        text(s, peopleRuns(d, { color: "FFFFFF", withInst: true }), 6.1, 3.7, 3.45, 1.4, { size: 11, min: 8, align: "right", valign: "bottom", charW: 0.58 });
      },
      closing(s, d) {
        bg(s, P.ink); this.slant(s, P.acc);
        text(s, toStr(d.title), 0.5, 1.4, 4.7, 1.9, { font: "title", size: 40, min: 20, color: "FFFFFF", valign: "bottom", charW: 0.68 });
        text(s, cleanSubtitle(d.subtitle), 0.5, 3.45, 5.0, 0.8, { size: 14, color: "FFFFFF" });
        rect(s, 7.8, 3.4, 1.7, 1.7, P.acc2);
      },
      chrome(s, title) {
        bg(s);
        rect(s, 0, 0, W, 1.1, P.acc);
        text(s, toStr(title), 0.5, 0.15, 9, 0.8, { font: "title", size: 22, min: 14, color: "FFFFFF", valign: "middle", charW: 0.68 });
        return { x: 0.6, y: 1.4, w: 8.8, h: 3.85 };
      },
      list(s, box, items) {
        rowsList(s, box, items, { gap: 0.1, markerSize: 0.45, marker: dotNum(SH.rect, [P.ink, P.acc, P.acc2], onColor), titleColor: P.ink, textColor: P.muted });
      },
      steps(s, box, items) {
        const fills = [P.ink, P.acc, P.acc2, P.ink];
        columns(s, box, items, {
          gap: 0.15, pad: 0.25, markerSize: 0.55,
          card: (sl, x, y, w, h, i) => { rect(sl, x, y, w, h, fills[i]); const c = onColor(fills[i]); return { title: c, text: c }; },
          marker: (sl, i, x, y, m) => text(sl, String(i + 1), x, y, m * 2, m, { font: "title", size: 28, color: onColor(fills[i]), fit: false, valign: "middle" }),
        });
      },
      stats(s, d) {
        bg(s);
        text(s, toStr(d.title), 0.5, 0.3, 9, 0.7, { font: "title", size: 24, min: 15, valign: "middle", charW: 0.68 });
        const nh = d.content ? noteHeight(d.content, 9, 13, 1.4) : 0;
        if (d.content) text(s, toStr(d.content), 0.5, 1.0, 9, nh, { size: 13, min: 11, bold: true, color: P.muted, valign: "top" });
        const stats = normStats(d);
        const n = stats.length;
        if (!n) return;
        const fills = [P.ink, P.acc, P.acc2];
        const cw = W / n;
        const y0 = Math.max(1.65, 1.0 + nh + 0.15);
        stats.forEach((st, i) => {
          const x = i * cw;
          rect(s, x, y0, cw, H - y0, fills[i]);
          const c = onColor(fills[i]);
          text(s, st.value, x + 0.4, y0 + 0.35, cw - 0.8, 1.35, { font: "title", size: 40, min: 18, color: c, valign: "bottom", charW: 0.64 });
          text(s, st.label, x + 0.4, y0 + 1.85, cw - 0.8, H - y0 - 2.2, { size: 13, min: 10, bold: true, color: c });
        });
      },
      panel(s, x, y, w, h) { rect(s, x, y, w, h, P.ink); return { color: "FFFFFF", strong: P.acc2 }; },
      callout(s, x, y, w, h, t) {
        rect(s, x, y, w, h, P.acc2);
        text(s, t, x + 0.25, y + 0.05, w - 0.5, h - 0.1, { size: 14, min: 10, bold: true, color: P.ink, valign: "middle" });
      },
      table: { head: P.ink, headText: "FFFFFF", zebra: P.soft, alt: "FFFFFF", text: P.ink, border: "FFFFFF" },
    },
    // ── Пастельний ──
    pastel: {
      tints() { return [P.soft, mix(P.acc2, "FFFFFF", 0.55), mix(P.acc3 || P.acc2, "FFFFFF", 0.5)]; },
      blobs(s) {
        shape(s, SH.ellipse, 6.6, -1.8, 4.6, 4.6, P.acc2);
        shape(s, SH.ellipse, -0.8, 4.4, 2.4, 2.4, P.acc);
        shape(s, SH.ellipse, 6.3, 4.0, 0.7, 0.7, P.acc3 || P.acc2);
      },
      pill(s, t, x, y) {
        const w = Math.min(5.1, 0.4 + t.length * 0.07);
        shape(s, SH.roundRect, x, y, w, 0.36, P.soft, { rectRadius: 0.18 });
        text(s, t, x, y, w, 0.36, { size: 10, align: "center", valign: "middle", fit: false });
      },
      cover(s, d) {
        bg(s); this.blobs(s);
        text(s, String(d.year || new Date().getFullYear()), 7.6, 0.55, 1.8, 0.6, { size: 26, bold: true, align: "right", fit: false });
        shape(s, SH.roundRect, 0.8, 0.95, 5.8, 3.7, "FFFFFF", { rectRadius: 0.3, shadow: cardShadow });
        if (d.work_type) text(s, toStr(d.work_type), 1.15, 1.25, 5.1, 0.35, { size: 11, min: 8, bold: true, color: P.acc });
        text(s, toStr(d.title || info?.topic), 1.15, 1.65, 5.1, 1.8, { font: "title", size: 26, min: 15, bold: true, valign: "middle" });
        if (d.student) this.pill(s, `Виконав(ла): ${toStr(d.student)}`, 1.15, 3.6);
        if (d.supervisor) this.pill(s, `Керівник: ${toStr(d.supervisor)}`, 1.15, 4.05);
        if (d.institution) text(s, toStr(d.institution), 1.8, 4.8, 4.6, 0.45, { size: 10, min: 8, color: P.muted });
      },
      closing(s, d) {
        bg(s); this.blobs(s);
        shape(s, SH.roundRect, 1.3, 1.4, 5.4, 2.6, "FFFFFF", { rectRadius: 0.3, shadow: cardShadow });
        text(s, toStr(d.title), 1.6, 1.6, 4.8, 1.5, { font: "title", size: 36, min: 20, bold: true, align: "center", valign: "middle" });
        text(s, cleanSubtitle(d.subtitle), 1.6, 3.1, 4.8, 0.7, { size: 14, color: P.muted, align: "center" });
      },
      chrome(s, title) {
        bg(s);
        shape(s, SH.ellipse, 9.1, -0.45, 1.2, 1.2, P.acc3 || P.acc2);
        text(s, toStr(title), 0.7, 0.35, 8.2, 0.8, { font: "title", size: 24, min: 15, bold: true, valign: "middle" });
        return { x: 0.7, y: 1.3, w: 8.6, h: 3.9 };
      },
      list(s, box, items) {
        const tints = this.tints();
        rowsList(s, box, items, {
          gap: 0.12, pad: 0.25, markerSize: 0.4, markerW: 0.3,
          card: (sl, x, y, w, h, i) => shape(sl, SH.roundRect, x, y, w, h, tints[i % 3], { rectRadius: Math.min(0.22, h / 2) }),
          marker: (sl, i, x, y, m) => text(sl, String(i + 1), x, y, m, m, { size: 18, bold: true, color: P.acc, valign: "middle", fit: false }),
          titleColor: P.ink, textColor: P.ink,
        });
      },
      steps(s, box, items) {
        const tints = this.tints();
        columns(s, box, items, {
          gap: 0.25, pad: 0.28, markerSize: 0.5,
          card: (sl, x, y, w, h, i) => { shape(sl, SH.roundRect, x, y, w, h, tints[i % 3], { rectRadius: 0.28 }); },
          marker: (sl, i, x, y, m) => text(sl, String(i + 1), x, y, m, m, { size: 26, bold: true, fit: false, valign: "middle" }),
          titleColor: P.ink, textColor: P.ink,
        });
      },
      stats(s, d, idx) {
        const box = this.chrome(s, d.title, idx);
        const stats = normStats(d);
        const n = stats.length;
        const tints = this.tints();
        const ch = d.content ? Math.max(2.3, box.h - noteHeight(d.content, box.w, 14, 1.4) - 0.2) : 3.6;
        if (n) {
          const gap = 0.3;
          const cw = (box.w - gap * (n - 1)) / n;
          stats.forEach((st, i) => {
            const x = box.x + i * (cw + gap);
            shape(s, SH.roundRect, x, box.y, cw, ch, tints[i % 3], { rectRadius: Math.min(cw / 2, 0.9) });
            text(s, st.value, x + 0.25, box.y + 0.45, cw - 0.5, 1.0, { font: "title", size: 32, min: 16, bold: true, align: "center", valign: "middle", charW: 0.56 });
            text(s, st.label, x + 0.3, box.y + 1.55, cw - 0.6, ch - 1.8, { size: 13, min: 9, align: "center" });
          });
        }
        if (d.content) text(s, toStr(d.content), box.x, box.y + ch + 0.2, box.w, box.h - ch - 0.2, { size: 14, min: 11, bold: true, align: "center", valign: "middle" });
      },
      panel(s, x, y, w, h) { shape(s, SH.roundRect, x, y, w, h, "FFFFFF", { rectRadius: 0.25, shadow: cardShadow }); return { color: P.ink, strong: P.acc }; },
      callout(s, x, y, w, h, t) {
        shape(s, SH.roundRect, x, y, w, h, P.soft, { rectRadius: Math.min(0.25, h / 2) });
        text(s, t, x + 0.35, y + 0.05, w - 0.7, h - 0.1, { size: 14, min: 10, bold: true, valign: "middle" });
      },
      table: { head: P.ink, headText: "FFFFFF", zebra: P.soft, alt: "FFFFFF", text: P.ink, border: "FFFFFF" },
    },

    // ── Креслення ──
    blueprint: {
      grid(s) {
        for (let x = 0.5; x < W; x += 0.5) vline(s, x, 0, H, P.ink, 0.5, 90);
        for (let y = 0.5; y < H; y += 0.5) hline(s, 0, y, W, P.ink, 0.5, 90);
      },
      // кутова мітка: кут у (x,y), плечі йдуть у бік dx/dy (±1)
      bracket(s, x, y, dx, dy) {
        hline(s, dx > 0 ? x : x - 0.4, y, 0.4, P.acc, 1.75);
        vline(s, x, dy > 0 ? y : y - 0.4, 0.4, P.acc, 1.75);
      },
      mono: (t, o = {}) => ({ text: t, options: { fontFace: F.mono, ...o } }),
      cover(s, d) {
        bg(s); this.grid(s);
        this.bracket(s, 0.6, 0.675, 1, 1); this.bracket(s, 9.4, 0.675, -1, 1);
        this.bracket(s, 0.6, 3.1, 1, -1); this.bracket(s, 9.4, 3.1, -1, -1);
        if (d.work_type) text(s, "// " + toStr(d.work_type).toUpperCase(), 0.9, 0.9, 8.2, 0.35, { font: F.mono, size: 11, min: 8, color: P.acc });
        text(s, toStr(d.title || info?.topic), 0.9, 1.3, 8.2, 1.65, { font: "title", size: 30, min: 16, valign: "middle" });
        const cells = [["ВИКОНАВ(ЛА)", d.student, 2.1], ["КЕРІВНИК", d.supervisor, 2.1], ["РІК", d.year || new Date().getFullYear(), 1.0]];
        rect(s, 4.2, 4.2, 5.2, 0.85, null, { line: { color: P.acc, width: 1 } });
        let cx = 4.2;
        cells.forEach(([lab, val, cw], i) => {
          if (i > 0) vline(s, cx, 4.2, 0.85, P.acc, 0.75, 40);
          text(s, [this.mono(lab, { fontSize: 8, color: P.acc, breakLine: true }), { text: toStr(val || "—"), options: { fontSize: 11, color: P.ink } }], cx + 0.12, 4.28, cw - 0.24, 0.7, { fit: false, size: 11 });
          cx += cw;
        });
        if (d.institution) text(s, toStr(d.institution), 0.6, 4.2, 3.4, 0.85, { font: F.mono, size: 9, min: 7, color: P.muted, valign: "bottom" });
      },
      closing(s, d) {
        bg(s); this.grid(s);
        this.bracket(s, 1.5, 1.4, 1, 1); this.bracket(s, 8.5, 1.4, -1, 1);
        this.bracket(s, 1.5, 4.1, 1, -1); this.bracket(s, 8.5, 4.1, -1, -1);
        text(s, toStr(d.title), 1.8, 1.7, 6.4, 1.2, { font: "title", size: 36, min: 20, align: "center", valign: "middle" });
        const sub = cleanSubtitle(d.subtitle);
        if (sub) text(s, "// " + sub, 1.8, 3.0, 6.4, 0.6, { font: F.mono, size: 12, color: P.muted, align: "center" });
      },
      chrome(s, title, idx) {
        bg(s); this.grid(s);
        text(s, String(idx + 1).padStart(2, "0") + ".", 0.6, 0.35, 0.85, 0.7, { font: F.mono, size: 20, color: P.acc, valign: "middle", fit: false });
        text(s, toStr(title), 1.45, 0.35, 8.0, 0.7, { font: "title", size: 22, min: 14, valign: "middle" });
        return { x: 0.6, y: 1.3, w: 8.8, h: 3.85 };
      },
      list(s, box, items) {
        rowsList(s, box, items, {
          markerW: 0.55,
          marker: (sl, i, x, y, m) => text(sl, `[${String(i + 1).padStart(2, "0")}]`, x, y, 0.6, m, { font: F.mono, size: 12, color: P.acc2, valign: "middle", fit: false }),
          sep: { color: P.acc, transparency: 65, dash: "dash" }, titleColor: P.ink, textColor: P.muted,
        });
      },
      steps(s, box, items) {
        const h = Math.min(box.h, 2.7);
        const b = { ...box, y: box.y + (box.h - h) / 2, h };
        columns(s, b, items, {
          gap: 0.5, pad: 0.2, markerSize: 0.3,
          before: (sl, bx, n, cw, gap) => {
            for (let i = 0; i < n - 1; i++) {
              const x = bx.x + (i + 1) * cw + i * gap + 0.07;
              sl.addShape(SH.line, { x, y: bx.y + bx.h / 2, w: gap - 0.14, h: 0, line: { color: P.acc, width: 1.5, endArrowType: "triangle" } });
            }
          },
          card: (sl, x, y, w, hh) => { rect(sl, x, y, w, hh, P.bg, { line: { color: P.acc, width: 1 } }); },
          marker: (sl, i, x, y, m) => text(sl, `[${String(i + 1).padStart(2, "0")}]`, x, y, 0.8, m, { font: F.mono, size: 11, color: P.acc2, valign: "middle", fit: false }),
          titleColor: P.ink, textColor: P.muted,
        });
      },
      stats(s, d, idx) {
        const box = this.chrome(s, d.title, idx);
        const stats = normStats(d);
        const n = stats.length;
        if (n) {
          const gap = 0.35;
          const cw = (box.w - gap * (n - 1)) / n;
          stats.forEach((st, i) => {
            const x = box.x + i * (cw + gap);
            rect(s, x, box.y + 0.3, cw, 2.4, null, { line: { color: P.acc, width: 1 } });
            rect(s, x + 0.2, box.y + 0.2, 0.62, 0.2, P.bg);
            text(s, `R-${String(i + 1).padStart(2, "0")}`, x + 0.2, box.y + 0.2, 0.62, 0.2, { font: F.mono, size: 8, color: P.acc2, align: "center", valign: "middle", fit: false });
            text(s, st.value, x + 0.25, box.y + 0.55, cw - 0.5, 0.9, { font: F.mono, size: 34, min: 16, bold: true, color: P.acc, valign: "bottom", charW: 0.62 });
            text(s, st.label, x + 0.25, box.y + 1.55, cw - 0.5, 1.05, { size: 12, min: 9, color: P.muted });
          });
        }
        if (d.content) {
          const nh = noteHeight(d.content, box.w, 12, 1.05) + 0.05;
          text(s, "> " + toStr(d.content), box.x, box.y + box.h - nh, box.w, nh, { font: F.mono, size: 12, min: 10, color: P.muted, valign: "middle", charW: 0.6 });
        }
      },
      panel(s, x, y, w, h) { rect(s, x, y, w, h, P.soft, { line: { color: P.acc, width: 1, dash: "dash" } }); return { color: P.ink, strong: P.acc }; },
      callout(s, x, y, w, h, t) {
        rect(s, x, y, w, h, null, { line: { color: P.acc, width: 1, dash: "dash" } });
        text(s, "> " + t, x + 0.2, y + 0.05, w - 0.4, h - 0.1, { size: 13, min: 10, valign: "middle" });
      },
      table: { head: P.acc, headText: P.bg, zebra: P.soft, alt: P.bg, text: P.ink, border: P.soft },
    },

    // ── Природний ──
    organic: {
      hills(s) {
        shape(s, SH.ellipse, 4.2, 4.5, 8.0, 2.925, P.acc2, { transparency: 10 });
        shape(s, SH.ellipse, -1.4, 4.385, 7.8, 2.59, P.acc);
      },
      cover(s, d) {
        bg(s); this.hills(s);
        shape(s, SH.teardrop, 0.7, 0.5, 0.5, 0.5, P.acc, { flipH: true });
        text(s, peopleRuns(d, { color: P.muted }), 5.3, 0.5, 4.1, 0.8, { size: 11, min: 8, align: "right" });
        if (d.work_type) text(s, toStr(d.work_type), 0.7, 1.35, 7.5, 0.45, { font: "title", italic: true, size: 16, min: 11, color: P.acc });
        text(s, toStr(d.title || info?.topic), 0.7, 1.8, 7.3, 2.1, { font: "title", size: 32, min: 16 });
        text(s, String(d.year || new Date().getFullYear()), 7.9, 4.95, 1.5, 0.45, { font: "title", size: 20, color: "FFFFFF", align: "right", fit: false });
        if (d.institution) text(s, toStr(d.institution), 0.7, 3.95, 5.5, 0.4, { size: 10, min: 8, color: P.muted });
      },
      closing(s, d) {
        bg(s); this.hills(s);
        text(s, toStr(d.title), 0.7, 1.2, 8.6, 1.4, { font: "title", size: 40, min: 22, valign: "bottom" });
        text(s, cleanSubtitle(d.subtitle), 0.7, 2.75, 8, 0.6, { font: "title", italic: true, size: 16, color: P.muted });
      },
      chrome(s, title) {
        bg(s);
        shape(s, SH.teardrop, 0.6, 0.6, 0.28, 0.28, P.acc, { flipH: true });
        text(s, toStr(title), 1.05, 0.35, 8.3, 0.8, { font: "title", size: 26, min: 15, valign: "middle" });
        rect(s, 0, 5.37, W, 0.255, P.acc, { transparency: 15 });
        return { x: 0.7, y: 1.35, w: 8.6, h: 3.8 };
      },
      list(s, box, items) {
        rowsList(s, box, items, {
          markerSize: 0.3, markerW: 0.35,
          marker: (sl, i, x, y, m) => shape(sl, SH.teardrop, x, y, m, m, i % 2 ? P.acc2 : P.acc, { rotate: -45 }),
          titleColor: P.ink, textColor: P.muted,
        });
      },
      steps(s, box, items) {
        columns(s, box, items, {
          markerSize: 0.6,
          marker: (sl, i, x, y, m) => {
            shape(sl, SH.ellipse, x, y, m, m, P.soft);
            text(sl, String(i + 1), x, y, m, m, { font: "title", size: 20, color: P.acc, align: "center", valign: "middle", fit: false });
          },
          titleColor: P.ink, textColor: P.muted,
        });
      },
      stats(s, d, idx) {
        const box = this.chrome(s, d.title, idx);
        const stats = normStats(d);
        const n = stats.length;
        if (n) {
          const cw = box.w / n;
          const diam = Math.min(1.8, cw - 0.4);
          stats.forEach((st, i) => {
            const x = box.x + i * cw;
            const cx = x + (cw - diam) / 2;
            shape(s, SH.ellipse, cx, box.y, diam, diam, P.soft);
            text(s, st.value, cx + 0.12, box.y, diam - 0.24, diam, { font: "title", size: 34, min: 14, color: P.acc, align: "center", valign: "middle", charW: 0.55 });
            text(s, st.label, x + 0.15, box.y + diam + 0.15, cw - 0.3, 0.8, { size: 12, min: 9, align: "center" });
          });
        }
        if (d.content) {
          const nh = noteHeight(d.content, box.w - 1, 15, 1.0);
          text(s, toStr(d.content), box.x + 0.5, box.y + box.h - nh, box.w - 1, nh, { font: "title", italic: true, size: 15, min: 12, align: "center", valign: "middle" });
        }
      },
      panel(s, x, y, w, h) { shape(s, SH.roundRect, x, y, w, h, P.soft, { rectRadius: 0.25 }); return { color: P.ink, strong: P.acc }; },
      callout(s, x, y, w, h, t) {
        rect(s, x, y, 0.06, h, P.acc2);
        text(s, t, x + 0.25, y, w - 0.25, h, { size: 15, min: 10, valign: "middle" });
      },
      table: { head: P.acc, headText: "FFFFFF", zebra: P.soft, alt: P.bg, text: P.ink, border: "FFFFFF" },
    },

    // ── Консалтинговий ──
    consulting: {
      bar(s) { rect(s, 0, 0, W, 0.09, P.acc2); },
      cover(s, d) {
        bg(s); this.bar(s);
        const kind = [toStr(d.work_type), String(d.year || new Date().getFullYear())].filter(Boolean).join(" · ");
        text(s, kind.toUpperCase(), 0.6, 0.6, 8.8, 0.4, { size: 12, min: 8, bold: true, color: P.acc2, spacing: 1 });
        text(s, toStr(d.title || info?.topic), 0.6, 1.05, 7.2, 2.4, { font: "title", size: 32, min: 18, bold: true });
        rect(s, 0, 4.1, W, H - 4.1, P.acc);
        const lab = mix(P.acc, "FFFFFF", 0.6);
        [["Виконав(ла)", d.student, 0.6], ["Науковий керівник", d.supervisor, 3.6], ["Заклад", d.institution, 6.6]].forEach(([l, v, x]) => {
          if (v) text(s, labeled(l, v, { labelColor: lab, color: "FFFFFF", size: 12 }), x, 4.4, 2.85, 1.0, { fit: false, size: 12 });
        });
      },
      closing(s, d) {
        bg(s); this.bar(s);
        text(s, toStr(d.title), 0.6, 1.4, 8.8, 1.3, { font: "title", size: 38, min: 20, bold: true, valign: "bottom" });
        text(s, cleanSubtitle(d.subtitle), 0.6, 2.85, 8.8, 0.6, { size: 15, color: P.muted });
        rect(s, 0, 4.9, W, H - 4.9, P.acc);
      },
      chrome(s, title, idx) {
        bg(s); this.bar(s);
        text(s, toStr(title), 0.6, 0.3, 8.8, 0.85, { font: "title", size: 20, min: 14, bold: true, valign: "bottom" });
        hline(s, 0.6, 1.22, 8.8, P.ink, 0.75, 75);
        text(s, topic, 0.6, 5.27, 7.5, 0.25, { size: 9, color: P.muted, fit: false });
        text(s, String(idx + 1), 8.6, 5.27, 0.8, 0.25, { size: 9, color: P.muted, align: "right", fit: false });
        return { x: 0.6, y: 1.45, w: 8.8, h: 3.65 };
      },
      list(s, box, items) {
        rowsList(s, box, items, {
          markerW: 0.35,
          marker: (sl, i, x, y, m) => text(sl, String(i + 1), x, y, 0.4, m, { size: 16, bold: true, color: P.acc2, valign: "middle", fit: false }),
          sep: { color: P.ink, transparency: 80 }, titleColor: P.ink, textColor: P.muted,
        });
      },
      steps(s, box, items) {
        columns(s, box, items, {
          topLine: { color: P.acc2, width: 4.5 },
          marker: (sl, i, x, y, m) => text(sl, String(i + 1), x, y, m, m, { size: 22, bold: true, color: P.acc2, valign: "middle", fit: false }),
          titleColor: P.ink, textColor: P.muted,
        });
      },
      stats(s, d, idx) {
        const box = this.chrome(s, d.title, idx);
        const stats = normStats(d);
        const n = stats.length;
        const noteH = d.content ? noteHeight(d.content, box.w - 0.2, 13, 1.5) + 0.1 : 0;
        if (n) {
          const rowH = Math.min(1.0, (box.h - noteH - 0.1) / n);
          stats.forEach((st, i) => {
            const y = box.y + i * rowH;
            text(s, st.value, box.x, y, 1.9, rowH - 0.1, { font: "title", size: 30, min: 16, bold: true, color: P.acc, valign: "middle", charW: 0.56 });
            text(s, st.label, box.x + 2.0, y, 3.5, rowH - 0.1, { size: 13, min: 9, valign: "middle" });
            const pct = pctOf(st.value);
            const frac = pct != null ? pct / 100 : [1, 0.75, 0.5][i];
            rect(s, box.x + 5.7, y + rowH / 2 - 0.14, 3.1, 0.18, P.soft);
            rect(s, box.x + 5.7, y + rowH / 2 - 0.14, Math.max(0.05, 3.1 * frac), 0.18, P.acc2);
          });
        }
        if (d.content) {
          const nh = noteH - 0.1;
          rect(s, box.x, box.y + box.h - nh, 0.06, nh, P.acc2);
          text(s, toStr(d.content), box.x + 0.2, box.y + box.h - nh, box.w - 0.2, nh, { size: 13, min: 11, bold: true, valign: "middle" });
        }
      },
      panel(s, x, y, w, h) { rect(s, x, y, w, h, P.acc); return { color: "FFFFFF", strong: P.acc2 }; },
      callout(s, x, y, w, h, t) {
        rect(s, x, y, w, h, P.soft);
        rect(s, x, y, 0.06, h, P.acc2);
        text(s, t, x + 0.25, y + 0.05, w - 0.45, h - 0.1, { size: 13, min: 10, bold: true, valign: "middle" });
      },
      table: { head: P.acc, headText: "FFFFFF", zebra: P.soft, alt: "FFFFFF", text: P.ink, border: "D9E0E8" },
    },

    // ── Орбіта ──
    orbit: {
      ring(s) { shape(s, SH.ellipse, 1.4, 0.7, 7.2, 4.2, null, { line: { color: P.acc, width: 1.25, transparency: 40, dash: "dash" } }); },
      cover(s, d) {
        bg(s); this.ring(s);
        shape(s, SH.ellipse, 3.1, 0.9, 3.8, 3.8, P.soft);
        if (d.institution) text(s, toStr(d.institution), 0.5, 0.15, 9, 0.35, { size: 10, min: 8, color: P.muted, align: "center" });
        if (d.work_type) text(s, toStr(d.work_type).toUpperCase(), 3.5, 1.5, 3.0, 0.45, { size: 10, min: 7, bold: true, color: P.acc, align: "center", valign: "bottom" });
        text(s, toStr(d.title || info?.topic), 3.45, 2.0, 3.1, 1.9, { font: "title", size: 20, min: 11, align: "center", valign: "middle" });
        [[1.3, 2.7], [8.5, 2.7], [4.9, 4.8]].forEach(([x, y]) => shape(s, SH.ellipse, x, y, 0.2, 0.2, P.acc2));
        const who = (lab, v) => [{ text: lab, options: { bold: true, color: P.acc, breakLine: true } }, { text: toStr(v), options: { color: P.ink } }];
        if (d.student) text(s, who("Виконав(ла)", d.student), 0.2, 3.0, 2.4, 0.8, { size: 12, min: 9 });
        if (d.supervisor) text(s, who("Науковий керівник", d.supervisor), 7.4, 3.0, 2.4, 0.8, { size: 12, min: 9, align: "right" });
        text(s, String(d.year || new Date().getFullYear()), 5.25, 4.72, 1.5, 0.35, { size: 13, bold: true, color: P.acc, valign: "middle", fit: false });
      },
      closing(s, d) {
        bg(s); this.ring(s);
        shape(s, SH.ellipse, 3.1, 0.9, 3.8, 3.8, P.acc);
        text(s, toStr(d.title), 3.45, 1.6, 3.1, 2.1, { font: "title", size: 28, min: 16, bold: true, color: "FFFFFF", align: "center", valign: "middle" });
        text(s, cleanSubtitle(d.subtitle), 1, 5.0, 8, 0.4, { size: 13, color: P.muted, align: "center" });
      },
      chrome(s, title) {
        bg(s);
        shape(s, SH.ellipse, 9.0, -0.5, 1.4, 1.4, P.soft);
        text(s, toStr(title), 0.5, 0.3, 8.3, 0.75, { font: "title", size: 22, min: 14, bold: true, valign: "middle" });
        return { x: 0.5, y: 1.25, w: 9, h: 3.95 };
      },
      // Ментальна карта: мета в центрі, завдання довкола (2–4 вузли)
      radial(s, box, center, nodes) {
        const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
        const D = 2.5, nw = 2.9, nh = 1.2;
        const L = box.x, R = box.x + box.w - nw, T = box.y + 0.05, B = box.y + box.h - nh - 0.05, M = cy - nh / 2;
        const pos = { 2: [[L, M], [R, M]], 3: [[L, M], [R, T], [R, B]], 4: [[L, T], [L, B], [R, T], [R, B]] }[nodes.length];
        pos.forEach(([x, y]) => seg(s, cx, cy, x + nw / 2, y + nh / 2, P.acc, 1, 50));
        shape(s, SH.ellipse, cx - D / 2, cy - D / 2, D, D, P.acc);
        const cRuns = [];
        if (center.title) cRuns.push({ text: center.title, options: { bold: true, breakLine: !!center.text } });
        if (center.text) cRuns.push({ text: center.text, options: {} });
        // вписаний у коло квадрат ≈ 0.7·D — текст не виходить за край кола
        const inner = D * 0.7;
        text(s, cRuns, cx - inner / 2, cy - inner / 2, inner, inner, { size: 13, min: 8, color: "FFFFFF", align: "center", valign: "middle" });
        nodes.forEach((it, i) => {
          const [x, y] = pos[i];
          shape(s, SH.roundRect, x, y, nw, nh, "FFFFFF", { rectRadius: 0.15, line: { color: P.acc, width: 1.25 } });
          const runs = [{ text: `${i + 1}  `, options: { bold: true, color: P.acc2 } }];
          if (it.title) runs.push({ text: it.title, options: { bold: true, color: P.ink, breakLine: !!it.text } });
          if (it.text) runs.push({ text: it.text, options: { color: P.ink } });
          text(s, runs, x + 0.15, y + 0.08, nw - 0.3, nh - 0.16, { size: 13, min: 8, valign: "middle" });
        });
      },
      list(s, box, items) {
        if (items.length >= 3 && items.length <= 5 && isGoal(items[0])) return this.radial(s, box, items[0], items.slice(1));
        rowsList(s, box, items, { marker: dotNum(SH.ellipse, [P.acc, P.acc2]), gap: 0.08, titleColor: P.ink, textColor: P.muted });
      },
      steps(s, box, items) {
        columns(s, box, items, {
          markerSize: 0.55,
          marker: dotNum(SH.ellipse, [P.acc]),
          before: (sl, b, n, cw, gap, ms) => { if (n > 1) hline(sl, b.x + ms / 2, b.y + ms / 2, (n - 1) * (cw + gap), P.acc, 1.5, 30, "dash"); },
          titleColor: P.ink, textColor: P.muted,
        });
      },
      stats(s, d, idx) {
        const box = this.chrome(s, d.title, idx);
        const stats = normStats(d);
        const fills = [P.acc, P.acc2, P.ink];
        const noteH = d.content ? noteHeight(d.content, box.w, 13, 1.2) : 0;
        const k = Math.min(1, (box.h - noteH - 0.15) / 3.35);
        const bub = [[box.x + 0.3 * k, box.y + 0.35 * k, 2.6 * k], [box.x + 3.0 * k, box.y, 1.8 * k], [box.x + 3.1 * k, box.y + 1.95 * k, 1.4 * k]];
        stats.forEach((st, i) => {
          const [x, y, dd] = bub[i];
          shape(s, SH.ellipse, x, y, dd, dd, fills[i]);
          text(s, st.value, x + dd * 0.15, y, dd * 0.7, dd, { size: Math.round(dd * 15), min: 10, bold: true, color: "FFFFFF", align: "center", valign: "middle", charW: 0.56 });
        });
        const rowH = stats.length ? Math.min(1.1, (box.h - noteH) / stats.length) : 0;
        stats.forEach((st, i) => {
          const y = box.y + 0.1 + i * rowH;
          shape(s, SH.ellipse, 5.9, y + 0.1, 0.18, 0.18, fills[i]);
          text(s, [{ text: st.value, options: { bold: true, fontSize: 16, breakLine: true } }, { text: st.label, options: { fontSize: 12 } }], 6.25, y, 3.25, rowH - 0.05, { fit: false, size: 12 });
        });
        if (d.content) text(s, toStr(d.content), box.x, box.y + box.h - noteH, box.w, noteH, { size: 13, min: 11, bold: true, color: P.acc, valign: "middle" });
      },
      panel(s, x, y, w, h) { shape(s, SH.roundRect, x, y, w, h, P.soft, { rectRadius: 0.3 }); return { color: P.ink, strong: P.acc }; },
      callout(s, x, y, w, h, t) {
        shape(s, SH.ellipse, x, y + h / 2 - 0.09, 0.18, 0.18, P.acc2);
        text(s, t, x + 0.3, y, w - 0.3, h, { size: 14, min: 10, bold: true, color: P.acc, valign: "middle" });
      },
      table: { head: P.acc, headText: "FFFFFF", zebra: P.soft, alt: "FFFFFF", text: P.ink, border: "FFFFFF" },
    },

    // ── Розворот: кольорова половина з головною думкою чергує бік ──
    spread: {
      frame(s, idx, pw, message, label) {
        bg(s);
        const left = idx % 2 === 1;
        const px = left ? 0 : W - pw;
        const soft = mix(P.acc, "FFFFFF", 0.55);
        rect(s, px, 0, pw, H, P.acc);
        if (label) text(s, label.toUpperCase(), px + 0.45, 0.55, pw - 0.9, 0.3, { size: 10, color: soft, spacing: 2, fit: false });
        if (message) text(s, message, px + 0.45, 0.9, pw - 0.9, H - 1.8, { font: "title", size: 26, min: 13, color: "FFFFFF", valign: "middle" });
        text(s, String(idx + 1).padStart(2, "0"), px + 0.45, H - 0.6, 1, 0.3, { size: 10, color: soft, fit: false });
        return { x: left ? pw + 0.5 : 0.5, y: 0.6, w: W - pw - 1.0, h: H - 1.2, px, pw };
      },
      chrome(s, title, idx, o = {}) { return this.frame(s, idx, o.wide ? 3.0 : 4.2, toStr(title), ""); },
      cover(s, d) {
        bg(s);
        rect(s, 0, 0, W, 3.49, P.acc);
        const kind = [toStr(d.work_type), String(d.year || new Date().getFullYear())].filter(Boolean).join(" · ");
        text(s, kind.toUpperCase(), 0.6, 0.5, 8.8, 0.35, { size: 11, min: 8, color: mix(P.acc, "FFFFFF", 0.6), spacing: 2 });
        text(s, toStr(d.title || info?.topic), 0.6, 0.95, 8.6, 2.3, { font: "title", size: 32, min: 18, color: "FFFFFF", valign: "bottom" });
        [["Виконав(ла)", d.student, 0.6], ["Науковий керівник", d.supervisor, 3.6], ["Заклад", d.institution, 6.6]].forEach(([l, v, x]) => {
          if (v) text(s, labeled(l, v, { labelColor: P.acc, color: P.ink, size: 12 }), x, 3.95, 2.85, 1.2, { fit: false, size: 12 });
        });
      },
      closing(s, d) {
        bg(s, P.acc);
        text(s, toStr(d.title), 1, 1.6, 8, 1.4, { font: "title", size: 40, min: 22, color: "FFFFFF", align: "center", valign: "middle" });
        text(s, cleanSubtitle(d.subtitle), 1, 3.1, 8, 0.7, { size: 14, color: "FFFFFF", align: "center" });
      },
      list(s, box, items) {
        rowsList(s, box, items, {
          markerW: 0.35,
          marker: (sl, i, x, y, m) => text(sl, String(i + 1), x, y, 0.4, m, { size: 14, bold: true, color: P.acc, valign: "middle", fit: false }),
          sep: { color: P.ink, transparency: 80, first: true }, titleColor: P.ink, textColor: P.muted,
        });
      },
      steps(s, box, items) { this.list(s, box, items.slice(0, 4)); },
      stats(s, d, idx) {
        const stats = normStats(d);
        const box = this.frame(s, idx, 4.2, toStr(d.content || d.title), d.content ? "Головна думка" : "");
        let y0 = box.y;
        if (d.content) { text(s, toStr(d.title), box.x, box.y, box.w, 0.7, { font: "title", size: 22, min: 14, valign: "bottom" }); y0 += 0.9; }
        const n = stats.length;
        if (!n) return;
        const rowH = Math.min(1.15, (box.y + box.h - y0) / n);
        stats.forEach((st, i) => {
          const y = y0 + i * rowH;
          hline(s, box.x, y, box.w, P.ink, 0.75, 80);
          text(s, st.value, box.x, y + 0.05, 1.8, rowH - 0.1, { font: "title", size: 30, min: 14, color: P.acc, valign: "middle", charW: 0.56 });
          text(s, st.label, box.x + 1.9, y + 0.05, box.w - 1.9, rowH - 0.1, { size: 13, min: 9, valign: "middle" });
        });
      },
      // Правий текст двоколонкового слайда стає «головною думкою» на кольоровій половині
      twoColumn(s, d, idx) {
        if (d.right_type === "image") return false;
        const isStat = d.right_type === "stat";
        const box = this.frame(s, idx, 4.2, isStat ? "" : toStr(d.right || d.key_point || ""), "");
        if (isStat) {
          text(s, toStr(d.right_value || ""), box.px + 0.45, 1.2, box.pw - 0.9, 1.6, { font: "title", size: 54, min: 24, color: "FFFFFF", valign: "bottom", charW: 0.56 });
          text(s, toStr(d.right_label || ""), box.px + 0.45, 3.0, box.pw - 0.9, 1.6, { size: 16, min: 10, color: "FFFFFF" });
        }
        text(s, toStr(d.title), box.x, box.y, box.w, 0.8, { font: "title", size: 22, min: 14, valign: "bottom" });
        hline(s, box.x, box.y + 0.95, 0.6, P.acc, 2);
        text(s, toStr(d.left || d.content || ""), box.x, box.y + 1.15, box.w, box.h - 1.15, { size: 15, min: 10 });
        return true;
      },
      panel(s, x, y, w, h) { rect(s, x, y, w, h, P.soft); return { color: P.ink, strong: P.acc }; },
      callout(s, x, y, w, h, t) {
        rect(s, x, y, w, h, P.soft);
        text(s, t, x + 0.25, y + 0.05, w - 0.5, h - 0.1, { size: 13, min: 10, bold: true, valign: "middle" });
      },
      table: { head: P.acc, headText: "FFFFFF", zebra: P.soft, alt: "FFFFFF", text: P.ink, border: "E0DCD6" },
    },

    // ── Дерево ──
    tree: {
      V(s, x, y, h) { rect(s, x - 0.01, y, 0.02, h, P.ink, { transparency: 55 }); },
      Hz(s, x, y, w) { rect(s, x, y - 0.01, w, 0.02, P.ink, { transparency: 55 }); },
      node(s, x, y, w, h, main) {
        shape(s, SH.roundRect, x, y, w, h, main ? P.acc : "FFFFFF", { rectRadius: 0.1, ...(main ? {} : { line: { color: P.acc, width: 1.25 } }) });
      },
      badge(s, i, x, y) {
        shape(s, SH.ellipse, x, y, 0.36, 0.36, P.acc2);
        text(s, String(i + 1), x, y, 0.36, 0.36, { size: 12, bold: true, color: "FFFFFF", align: "center", valign: "middle", fit: false });
      },
      runs(it, color) {
        const r = [];
        if (it.title) r.push({ text: it.title, options: { bold: true, color, breakLine: !!it.text } });
        if (it.text) r.push({ text: it.text, options: { color } });
        return r;
      },
      cover(s, d) {
        bg(s);
        this.node(s, 1.2, 0.5, 7.6, 1.95, true);
        if (d.work_type) text(s, toStr(d.work_type).toUpperCase(), 1.5, 0.62, 7, 0.3, { size: 10, min: 7, color: mix(P.acc, "FFFFFF", 0.6), spacing: 2, align: "center" });
        text(s, toStr(d.title || info?.topic), 1.5, 0.95, 7, 1.4, { font: "title", size: 26, min: 14, color: "FFFFFF", align: "center", valign: "middle" });
        this.V(s, 5, 2.45, 0.65); this.Hz(s, 2.0, 3.1, 6.0);
        [2.0, 5.0, 8.0].forEach(x => this.V(s, x, 3.1, 0.4));
        [["Виконав(ла)", d.student, 0.6], ["Науковий керівник", d.supervisor, 3.6], ["Рік захисту", d.year || new Date().getFullYear(), 6.6]].forEach(([l, v, x]) => {
          this.node(s, x, 3.5, 2.8, 1.1, false);
          text(s, labeled(l, v || "—", { labelColor: P.acc, color: P.ink, size: 12 }), x + 0.15, 3.6, 2.5, 0.9, { fit: false, size: 12, valign: "middle" });
        });
        if (d.institution) text(s, toStr(d.institution), 0.6, 4.85, 8.8, 0.4, { size: 10, min: 8, color: P.muted, align: "center" });
      },
      closing(s, d) {
        bg(s);
        this.node(s, 2.2, 1.3, 5.6, 1.6, true);
        text(s, toStr(d.title), 2.4, 1.4, 5.2, 1.4, { font: "title", size: 34, min: 18, bold: true, color: "FFFFFF", align: "center", valign: "middle" });
        this.V(s, 5, 2.9, 0.45); this.Hz(s, 3, 3.35, 4);
        [3, 5, 7].forEach(x => { this.V(s, x, 3.35, 0.3); shape(s, SH.roundRect, x - 0.45, 3.65, 0.9, 0.35, P.soft, { rectRadius: 0.08 }); });
        text(s, cleanSubtitle(d.subtitle), 1, 4.3, 8, 0.6, { size: 14, color: P.muted, align: "center" });
      },
      chrome(s, title) {
        bg(s);
        text(s, toStr(title), 0.6, 0.25, 8.8, 0.75, { font: "title", size: 22, min: 14, bold: true, valign: "middle" });
        return { x: 0.6, y: 1.15, w: 8.8, h: 4.1 };
      },
      topDown(s, box, root, kids) {
        const rootH = 1.15, rw = Math.min(6, box.w - 2);
        this.node(s, box.x + (box.w - rw) / 2, box.y, rw, rootH, true);
        text(s, this.runs(root, "FFFFFF"), box.x + (box.w - rw) / 2 + 0.2, box.y + 0.08, rw - 0.4, rootH - 0.16, { size: 14, min: 9, align: "center", valign: "middle" });
        const n = kids.length, gap = 0.25;
        const cw = (box.w - gap * (n - 1)) / n;
        const railY = box.y + rootH + 0.35, kidY = railY + 0.35;
        const cxs = kids.map((_, i) => box.x + i * (cw + gap) + cw / 2);
        this.V(s, box.x + box.w / 2, box.y + rootH, 0.35);
        if (n > 1) this.Hz(s, cxs[0], railY, cxs[n - 1] - cxs[0]);
        kids.forEach((it, i) => {
          const kx = box.x + i * (cw + gap);
          const kh = box.y + box.h - kidY;
          this.V(s, cxs[i], railY, 0.35);
          this.node(s, kx, kidY, cw, kh, false);
          this.badge(s, i, kx + 0.15, kidY + 0.15);
          text(s, this.runs(it, P.ink), kx + 0.15, kidY + 0.62, cw - 0.3, kh - 0.75, { size: n <= 3 ? 14 : 13, min: 9 });
        });
      },
      list(s, box, items) {
        if (items.length >= 3 && items.length <= 5 && isGoal(items[0])) return this.topDown(s, box, items[0], items.slice(1));
        const list = items.slice(0, 6);
        const n = list.length;
        if (!n) return;
        const gap = 0.12, rowH = (box.h - gap * (n - 1)) / n;
        const trunkX = box.x + 0.15;
        if (n > 1) this.V(s, trunkX, box.y + rowH / 2, (n - 1) * (rowH + gap));
        const base = n <= 3 ? 15 : n === 4 ? 14 : n === 5 ? 13 : 12;
        list.forEach((it, i) => {
          const y = box.y + i * (rowH + gap);
          const yc = y + rowH / 2;
          this.Hz(s, trunkX, yc, 0.3);
          this.node(s, box.x + 0.45, y, box.w - 0.45, rowH, false);
          this.badge(s, i, box.x + 0.6, yc - 0.18);
          text(s, this.runs(it, P.ink), box.x + 1.1, y + 0.05, box.w - 1.25, rowH - 0.1, { size: base, min: 9, valign: "middle" });
        });
      },
      steps(s, box, items) {
        const list = items.slice(0, 4);
        const n = list.length;
        if (!n) return;
        const gap = 0.45, cw = (box.w - gap * (n - 1)) / n;
        const h = Math.min(box.h, 2.8), y = box.y + (box.h - h) / 2;
        list.forEach((it, i) => {
          const x = box.x + i * (cw + gap);
          if (i < n - 1) {
            this.Hz(s, x + cw, y + h / 2, gap);
            shape(s, SH.ellipse, x + cw + gap / 2 - 0.07, y + h / 2 - 0.07, 0.14, 0.14, P.acc);
          }
          this.node(s, x, y, cw, h, false);
          this.badge(s, i, x + 0.15, y + 0.15);
          text(s, this.runs(it, P.ink), x + 0.15, y + 0.62, cw - 0.3, h - 0.75, { size: n <= 3 ? 14 : 13, min: 9 });
        });
      },
      stats(s, d, idx) {
        const box = this.chrome(s, d.title, idx);
        const stats = normStats(d);
        const n = stats.length;
        if (!n) return;
        const note = toStr(d.content || "Результати");
        const rw = note.length > 110 ? 3.2 : 2.5, gap = 0.2;
        const rootH = Math.min(box.h, Math.max(1.7, noteHeight(note, rw - 0.4, 13, box.h) + 0.2));
        const bh = Math.min(1.15, (box.h - gap * (n - 1)) / n);
        const total = n * bh + (n - 1) * gap;
        const y0 = box.y + (box.h - total) / 2, cy = box.y + box.h / 2;
        this.node(s, box.x, cy - rootH / 2, rw, rootH, true);
        text(s, note, box.x + 0.2, cy - rootH / 2 + 0.1, rw - 0.4, rootH - 0.2, { size: 13, min: 11, bold: true, color: "FFFFFF", valign: "middle" });
        const trunkX = box.x + rw + 0.35;
        this.Hz(s, box.x + rw, cy, 0.35);
        if (n > 1) this.V(s, trunkX, y0 + bh / 2, (n - 1) * (bh + gap));
        stats.forEach((st, i) => {
          const y = y0 + i * (bh + gap);
          const x = trunkX + 0.35, w = box.x + box.w - x;
          this.Hz(s, trunkX, y + bh / 2, 0.35);
          this.node(s, x, y, w, bh, false);
          text(s, st.value, x + 0.2, y, 1.9, bh, { font: "title", size: 28, min: 14, bold: true, color: P.acc, valign: "middle", charW: 0.56 });
          text(s, st.label, x + 2.2, y + 0.05, w - 2.4, bh - 0.1, { size: 13, min: 9, valign: "middle" });
        });
      },
      panel(s, x, y, w, h) { this.node(s, x, y, w, h, false); return { color: P.ink, strong: P.acc }; },
      callout(s, x, y, w, h, t) {
        this.node(s, x, y, w, h, true);
        text(s, t, x + 0.25, y + 0.05, w - 0.5, h - 0.1, { size: 13, min: 10, bold: true, color: "FFFFFF", valign: "middle" });
      },
      table: { head: P.acc, headText: "FFFFFF", zebra: P.soft, alt: "FFFFFF", text: P.ink, border: "D5E0DD" },
    },
  };

  const st = STYLES[design.style];

  // ── Заглушка для зображення: навмисно жовта, щоб менеджер помітив і вставив картинку ──
  const addImagePlaceholder = (s, x, y, w, h, label) => {
    rect(s, x, y, w, h, "FFF8E1", { line: { color: "FFB300", width: 1.5 } });
    rect(s, x, y, w, 0.06, "FFB300");
    rect(s, x, y + h - 0.06, w, 0.06, "FFB300");
    text(s, "📷", x, y + h * 0.18, w, h * 0.38, { size: Math.min(48, Math.round(h * 30)), align: "center", valign: "bottom", fit: false });
    text(s, toStr(label) || "Додайте зображення", x + 0.1, y + h * 0.56, w - 0.2, h * 0.35, { size: 13, min: 9, bold: true, color: "795548", align: "center" });
  };
  const addImage = (s, image, x, y, w, h) => s.addImage({
    data: `data:${image.type || "image/jpeg"};base64,${image.b64}`,
    x, y, w, h, sizing: { type: "contain", w, h },
  });

  // ════════════════════ LAYOUTS ════════════════════
  const renderTwoColumn = (s, d, idx) => {
    if (st.twoColumn?.(s, d, idx)) return;
    const box = st.chrome(s, d.title, idx);
    const gap = 0.35;
    const lw = box.w * 0.5;
    text(s, toStr(d.left || d.content || ""), box.x, box.y, lw, box.h, { size: 15, min: 10 });
    const rx = box.x + lw + gap;
    const rw = box.w - lw - gap;
    if (d.right_type === "image") {
      if (d.image?.b64) addImage(s, d.image, rx, box.y, rw, box.h);
      else addImagePlaceholder(s, rx, box.y, rw, box.h, d.right || d.image || "Додайте зображення");
      return;
    }
    const col = st.panel(s, rx, box.y, rw, box.h);
    if (d.right_type === "stat") {
      text(s, toStr(d.right_value || ""), rx + 0.3, box.y + 0.4, rw - 0.6, 1.5, { font: "title", size: 54, min: 24, color: col.strong, align: "center", valign: "middle", charW: 0.58 });
      text(s, toStr(d.right_label || ""), rx + 0.3, box.y + 2.0, rw - 0.6, box.h - 2.3, { size: 14, min: 10, color: col.color, align: "center" });
    } else {
      text(s, toStr(d.right || d.key_point || ""), rx + 0.3, box.y + 0.3, rw - 0.6, box.h - 0.6, { size: 14, min: 10, color: col.color });
    }
  };

  const renderHighlight = (s, d, idx) => {
    const box = st.chrome(s, d.title, idx);
    const raw = d.accent || d.gap;
    const isColor = typeof raw === "string" && raw.trim().split(/\s+/).length === 1 && COLOR_NAMES.has(raw.trim().toLowerCase());
    const accent = raw && !isColor ? toStr(raw) : "";
    const ch = accent ? 0.8 : 0;
    st.list(s, { ...box, h: box.h - (accent ? ch + 0.2 : 0) }, normItems(d).slice(0, 5));
    if (accent) st.callout(s, box.x, box.y + box.h - ch, box.w, ch, accent);
  };

  const renderList = (s, d, idx) => st.list(s, st.chrome(s, d.title, idx), normItems(d));

  const renderSteps = (s, d, idx) => {
    const items = normItems(d);
    const box = st.chrome(s, d.title, idx);
    if (items.length > 4) st.list(s, box, items);
    else st.steps(s, box, items);
  };

  const renderTable = (s, d, idx) => {
    const box = st.chrome(s, d.title, idx, { wide: true });
    const v = d.visual || {};
    const headers = v.headers || [];
    const rows = v.rows || [];
    if (!headers.length && !rows.length) return;
    const T = st.table;
    const colCount = headers.length || (rows[0]?.length ?? 1);
    const fs = rows.length > 10 ? 10 : rows.length > 6 ? 11 : 12;
    const tableRows = [];
    if (headers.length) {
      tableRows.push(headers.map(h => ({
        text: toStr(h),
        options: { bold: true, color: T.headText, fill: { color: T.head }, fontSize: fs + 1, fontFace: F.body, align: "center", valign: "middle" },
      })));
    }
    rows.forEach((row, ri) => {
      tableRows.push((Array.isArray(row) ? row : [row]).map(cell => ({
        text: toStr(cell ?? ""),
        options: { color: T.text, fill: { color: ri % 2 === 0 ? T.zebra : T.alt }, fontSize: fs, fontFace: F.body, valign: "middle" },
      })));
    });
    s.addTable(tableRows, {
      x: box.x, y: box.y, w: box.w, h: Math.min(box.h, 0.42 * tableRows.length),
      colW: Array(colCount).fill(box.w / colCount),
      border: { type: "solid", color: T.border, pt: 0.75 },
      autoPage: false,
    });
  };

  const CHART_TYPE_MAP = { bar: "bar", column: "bar", line: "line", pie: "pie", doughnut: "doughnut", area: "area" };
  const renderChart = (s, d, idx) => {
    const box = st.chrome(s, d.title, idx, { wide: true });
    const v = d.visual || {};
    const chartType = CHART_TYPE_MAP[v.type] || "bar";
    const series = (v.series || []).map(sr => ({
      name: sr.name || "",
      labels: (sr.labels || []).map(toStr),
      values: (sr.values || []).map(Number),
    }));
    if (!series.length || !series[0].values.length) return;
    const isPie = chartType === "pie" || chartType === "doughnut";
    s.addChart(chartType, series, {
      x: box.x, y: box.y, w: box.w, h: box.h,
      showLegend: series.length > 1 || isPie,
      legendPos: "b", legendFontSize: 11, legendColor: P.ink, legendFontFace: F.body,
      showTitle: false,
      // один ряд стовпчиків/лінії — одним кольором, інакше кожна точка отримує свій
      chartColors: isPie || series.length > 1 ? [P.acc, P.acc2, P.ink, P.muted, P.soft] : [P.acc],
      dataLabelFontSize: 11, dataLabelColor: isPie ? "FFFFFF" : P.ink, dataLabelFontFace: F.body,
      valAxisLabelFontSize: 11, catAxisLabelFontSize: 11,
      valAxisLabelColor: P.muted, catAxisLabelColor: P.ink,
      valAxisLabelFontFace: F.body, catAxisLabelFontFace: F.body,
      valGridLine: { color: P.muted, size: 0.5, style: "dash" },
      catAxisLineShow: false, valAxisLineShow: false,
      showValue: v.showValues !== false,
    });
  };

  const renderImage = (s, d, idx) => {
    const box = st.chrome(s, d.title, idx, { wide: true });
    if (d.image?.b64) addImage(s, d.image, box.x, box.y, box.w, box.h);
    else addImagePlaceholder(s, box.x, box.y, box.w, box.h, d.image || d.content || "Додайте зображення");
  };

  // ── Dispatch ──
  slides.forEach((slide, idx) => {
    const s = pptx.addSlide();
    switch (slide.layout) {
      case "title_slide": st.cover(s, slide); break;
      case "hero":
      case "dark_title": st.closing(s, slide); break;
      case "two_column": renderTwoColumn(s, slide, idx); break;
      case "stat_callout": st.stats(s, slide, idx); break;
      case "icon_list":
      case "icon_grid": renderList(s, slide, idx); break;
      case "numbered_steps":
      case "timeline": renderSteps(s, slide, idx); break;
      case "table": renderTable(s, slide, idx); break;
      case "chart": renderChart(s, slide, idx); break;
      case "image_placeholder": renderImage(s, slide, idx); break;
      default: renderHighlight(s, slide, idx); break;
    }
  });

  const num = info?.orderNumber || (orderId ? orderId.slice(0, 10) : "");
  const fileName = num ? `${num}_презентація.pptx` : "презентація.pptx";
  await pptx.writeFile({ fileName });
}
