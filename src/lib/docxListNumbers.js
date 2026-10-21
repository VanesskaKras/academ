import JSZip from "jszip";
import mammoth from "mammoth";

// ── Автонумерація Word у витягнутому тексті .docx ──
// mammoth.extractRawText віддає лише текст абзаців: номери, які Word малює сам
// (список/«Багаторівневий список» — 1.1., 1.1.1, 1.1.1.1), у текст не потрапляють.
// Для плану/змісту чи готової частини роботи це фатально: "1.1. Назва" стає просто
// "Назва", і парсер плану приклеює її до назви розділу (кейс 41476). Тут ми
// рахуємо номери так, як їх показує Word (numbering.xml + numPr абзацу або його
// стилю), вписуємо їх звичайним текстом на початок абзаців і вже цей .docx
// віддаємо mammoth. Ізоморфний хелпер: браузер (ArrayBuffer) і Node-воркер (Buffer).
// Маркери списків (bullet) не вписуємо — лише номери.

const NodeBuffer = globalThis.Buffer; // лише у Node-воркері; у браузері undefined
const isNode = typeof window === "undefined" && !!NodeBuffer;

const attr = (xml, tag) => xml.match(new RegExp(`<w:${tag}\\b[^>]*\\bw:val="([^"]*)"`))?.[1];

const ROMAN = [[1000, "M"], [900, "CM"], [500, "D"], [400, "CD"], [100, "C"], [90, "XC"], [50, "L"], [40, "XL"], [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"]];
const toRoman = (n) => { let out = ""; for (const [v, s] of ROMAN) while (n >= v) { out += s; n -= v; } return out; };
const toLetters = (n, alphabet) => {
  const i = (n - 1) % alphabet.length;
  return alphabet[i].repeat(Math.floor((n - 1) / alphabet.length) + 1);
};
const LATIN = "abcdefghijklmnopqrstuvwxyz";
const CYRILLIC = "абвгдежзиклмнопрстуфхцчшщэюя"; // як russianLower у Word (без ё/й/ъ/ы/ь)

function formatNum(n, fmt) {
  switch (fmt) {
    case "decimalZero": return String(n).padStart(2, "0");
    case "upperRoman": return toRoman(n);
    case "lowerRoman": return toRoman(n).toLowerCase();
    case "upperLetter": return toLetters(n, LATIN).toUpperCase();
    case "lowerLetter": return toLetters(n, LATIN);
    case "russianUpper": return toLetters(n, CYRILLIC).toUpperCase();
    case "russianLower": return toLetters(n, CYRILLIC);
    default: return String(n);
  }
}

function parseNumbering(xml) {
  const abstracts = {};
  for (const m of xml.matchAll(/<w:abstractNum\b[^>]*\bw:abstractNumId="(\d+)"[^>]*>([\s\S]*?)<\/w:abstractNum>/g)) {
    const levels = {};
    for (const l of m[2].matchAll(/<w:lvl\b[^>]*\bw:ilvl="(\d+)"[^>]*>([\s\S]*?)<\/w:lvl>/g)) {
      levels[l[1]] = {
        start: parseInt(attr(l[2], "start") ?? "1", 10),
        fmt: attr(l[2], "numFmt") || "decimal",
        text: attr(l[2], "lvlText") ?? "",
        isLgl: /<w:isLgl\b/.test(l[2]),
        pStyle: attr(l[2], "pStyle"),
      };
    }
    abstracts[m[1]] = levels;
  }
  const nums = {};
  for (const m of xml.matchAll(/<w:num\b[^>]*\bw:numId="(\d+)"[^>]*>([\s\S]*?)<\/w:num>/g)) {
    const overrides = {};
    for (const o of m[2].matchAll(/<w:lvlOverride\b[^>]*\bw:ilvl="(\d+)"[^>]*>([\s\S]*?)<\/w:lvlOverride>/g)) {
      const s = attr(o[2], "startOverride");
      if (s != null) overrides[o[1]] = parseInt(s, 10);
    }
    nums[m[1]] = { abstractId: attr(m[2], "abstractNumId"), overrides };
  }
  return { abstracts, nums };
}

// Нумерація, задана стилем абзацу (часто так нумерують заголовки): styleId → {numId, ilvl}
function parseStyleNumbering(xml) {
  const styles = {};
  for (const m of (xml || "").matchAll(/<w:style\b[^>]*\bw:styleId="([^"]+)"[^>]*>([\s\S]*?)<\/w:style>/g)) {
    const numPr = m[2].match(/<w:numPr>([\s\S]*?)<\/w:numPr>/)?.[1];
    styles[m[1]] = {
      basedOn: attr(m[2], "basedOn"),
      numId: numPr ? attr(numPr, "numId") : undefined,
      ilvl: numPr ? attr(numPr, "ilvl") : undefined,
    };
  }
  return styles;
}

function styleNumPr(styles, styleId) {
  for (let id = styleId, depth = 0; id && styles[id] && depth < 10; id = styles[id].basedOn, depth++) {
    if (styles[id].numId != null) return { numId: styles[id].numId, ilvl: styles[id].ilvl, styleId };
  }
  return null;
}

const escapeXml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Повертає document.xml, у якому перед текстом кожного нумерованого абзацу стоїть його номер
export function injectListNumbersIntoXml(docXml, numberingXml, stylesXml) {
  const { abstracts, nums } = parseNumbering(numberingXml || "");
  if (!Object.keys(nums).length) return docXml;
  const styles = parseStyleNumbering(stylesXml);
  const counters = {}; // abstractId → {ilvl: поточне значення}
  const seenNums = new Set();

  const labelFor = (pPr) => {
    const direct = pPr.match(/<w:numPr>([\s\S]*?)<\/w:numPr>/)?.[1];
    let numId, ilvl;
    if (direct) { numId = attr(direct, "numId"); ilvl = attr(direct, "ilvl"); }
    const styleId = attr(pPr, "pStyle");
    if (numId == null && styleId) {
      const fromStyle = styleNumPr(styles, styleId);
      if (fromStyle) { numId = fromStyle.numId; ilvl = ilvl ?? fromStyle.ilvl; }
    }
    if (numId == null || numId === "0" || !nums[numId]) return null;
    const { abstractId, overrides } = nums[numId];
    const levels = abstracts[abstractId];
    if (!levels) return null;
    if (ilvl == null) {
      // рівень, прив'язаний до стилю абзацу в самому abstractNum (w:pStyle усередині w:lvl)
      ilvl = Object.keys(levels).find(k => styleId && levels[k].pStyle === styleId) ?? "0";
    }
    const level = parseInt(ilvl, 10);
    const lvl = levels[level];
    if (!lvl || lvl.fmt === "bullet" || lvl.fmt === "none" || !lvl.text) return null;

    const state = counters[abstractId] || (counters[abstractId] = { cnt: {}, start: {} });
    const { cnt } = state;
    const startOf = (li) => state.start[li] ?? levels[li]?.start ?? 1;
    if (!seenNums.has(numId)) {
      // "Почати нумерацію заново" у Word — новий w:num зі startOverride: лічильники
      // цих рівнів скидаються, а невикористаний рівень показується своїм стартом
      seenNums.add(numId);
      for (const [ol, start] of Object.entries(overrides)) {
        state.start[ol] = start;
        Object.keys(cnt).forEach(k => { if (+k >= +ol) delete cnt[k]; });
      }
    }
    cnt[level] = (cnt[level] ?? (startOf(level) - 1)) + 1;
    Object.keys(cnt).forEach(k => { if (+k > level) delete cnt[k]; });

    const label = lvl.text.replace(/%(\d)/g, (_, k) => {
      const li = parseInt(k, 10) - 1;
      const refLvl = levels[li] || { fmt: "decimal" };
      const value = cnt[li] ?? startOf(li);
      return formatNum(value, lvl.isLgl ? "decimal" : refLvl.fmt);
    }).trim();
    return label || null;
  };

  return docXml.replace(/<w:p\b(\s[^>]*)?>(\s*<w:pPr\b[^>]*>[\s\S]*?<\/w:pPr>)?/g, (whole, attrs, pPrBlock) => {
    if (attrs && attrs.trim().endsWith("/")) return whole; // порожній <w:p .../>
    const label = labelFor(pPrBlock || "");
    if (!label) return whole;
    return `${whole}<w:r><w:t xml:space="preserve">${escapeXml(label)} </w:t></w:r>`;
  });
}

// .docx (ArrayBuffer | Uint8Array | Buffer) → той самий .docx з номерами списків, вписаними в текст
export async function injectDocxListNumbers(input) {
  const zip = await JSZip.loadAsync(input);
  const docFile = zip.file("word/document.xml");
  const numFile = zip.file("word/numbering.xml");
  if (!docFile || !numFile) return input;
  const [docXml, numberingXml, stylesXml] = await Promise.all([
    docFile.async("text"), numFile.async("text"), zip.file("word/styles.xml")?.async("text") ?? "",
  ]);
  const newXml = injectListNumbersIntoXml(docXml, numberingXml, stylesXml);
  if (newXml === docXml) return input;
  zip.file("word/document.xml", newXml);
  return zip.generateAsync({ type: isNode ? "nodebuffer" : "arraybuffer" });
}

// Сирий текст .docx, як mammoth.extractRawText, але з номерами автонумерації Word.
// Якщо вписати номери не вдалося (битий numbering.xml тощо) — звичайний текст mammoth.
export async function extractDocxTextWithNumbering(input) {
  let src = input;
  try { src = await injectDocxListNumbers(input); }
  catch (e) { console.warn("extractDocxTextWithNumbering: нумерацію не відновлено:", e.message); }
  const arg = isNode
    ? { buffer: NodeBuffer.isBuffer(src) ? src : NodeBuffer.from(src instanceof ArrayBuffer ? new Uint8Array(src) : src) }
    : { arrayBuffer: src instanceof ArrayBuffer ? src : src.buffer.slice(src.byteOffset, src.byteOffset + src.byteLength) };
  return (await mammoth.extractRawText(arg)).value;
}
