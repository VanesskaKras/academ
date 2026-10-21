// ─────────────────────────────────────────────
// Читання кольорових виділень і коментарів Word з .docx
// ─────────────────────────────────────────────
import { getBodyParagraphs, ownDescendants } from "./docxTree.js";

export const HIGHLIGHT_COLORS = {
  yellow:      { ua: "жовте",         css: "#FEF08A", text: "#854D0E" },
  red:         { ua: "червоне",       css: "#FCA5A5", text: "#991B1B" },
  green:       { ua: "зелене",        css: "#86EFAC", text: "#166534" },
  cyan:        { ua: "блакитне",      css: "#A5F3FC", text: "#155E75" },
  magenta:     { ua: "рожеве",        css: "#F9A8D4", text: "#9D174D" },
  blue:        { ua: "синє",          css: "#BFDBFE", text: "#1E3A8A" },
  darkBlue:    { ua: "темно-синє",    css: "#3B82F6", text: "#fff" },
  darkCyan:    { ua: "бірюзове",      css: "#06B6D4", text: "#fff" },
  darkGreen:   { ua: "темно-зелене",  css: "#22C55E", text: "#fff" },
  darkMagenta: { ua: "фіолетове",     css: "#A855F7", text: "#fff" },
  darkRed:     { ua: "бордове",       css: "#EF4444", text: "#fff" },
  darkYellow:  { ua: "золоте",        css: "#EAB308", text: "#fff" },
  darkGray:    { ua: "сіре",          css: "#9CA3AF", text: "#fff" },
  lightGray:   { ua: "світло-сіре",   css: "#E5E7EB", text: "#374151" },
};

// ─────────────────────────────────────────────
// Червонуватий колір ШРИФТУ (на відміну від фонової підсвітки w:highlight) —
// так керівники часто вписують власну нотатку прямо в абзац, замість реального
// коментаря Word чи виділення. w:color задає довільний hex, тож перевіряємо
// відтінок (домінує червоний канал), а не конкретний список значень.
// ─────────────────────────────────────────────
export function isReddishColor(hex) {
  if (!hex || !/^[0-9a-fA-F]{6}$/.test(hex)) return false;
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return r >= 100 && r > g * 1.4 && r > b * 1.4;
}

// ─────────────────────────────────────────────
// JSZip loader
// ─────────────────────────────────────────────
async function loadJSZip() {
  if (window.JSZip) return window.JSZip;
  await new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js";
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
  return window.JSZip;
}

// ─────────────────────────────────────────────
// Витяг виділень і коментарів з .docx
//
// io (опц.) — { JSZip, DOMParser } для запуску поза браузером (worker/*, через
// worker/docxNodeIO.js); без io — теперішня браузерна поведінка.
// Array.from() замість [...x]/for...of на getElementsByTagName — браузерний
// NodeList і серверний @xmldom/xmldom LiveNodeList обидва array-like
// (.length + індекси), але лише перший ще й ітерований (Symbol.iterator);
// Array.from() працює однаково на обох.
// ─────────────────────────────────────────────
export async function extractAnnotations(arrayBuffer, io = {}) {
  const JSZip = io.JSZip || (await loadJSZip());
  const zip = await JSZip.loadAsync(arrayBuffer);

  const docXmlRaw = await zip.file("word/document.xml")?.async("string");
  if (!docXmlRaw) return { highlights: [], comments: [], colorNotes: [] };

  let commentsXmlRaw = "";
  try { commentsXmlRaw = (await zip.file("word/comments.xml")?.async("string")) || ""; } catch { /**/ }

  const Parser = io.DOMParser || DOMParser;
  const parser = new Parser();
  const docXml = parser.parseFromString(docXmlRaw, "text/xml");
  const commentsXml = commentsXmlRaw ? parser.parseFromString(commentsXmlRaw, "text/xml") : null;
  return collectAnnotations(docXml, docXmlRaw, commentsXml);
}

// ─────────────────────────────────────────────
// Те саме для вже відкритого документа (openDocxForEditing): анотації беруться
// з ТОГО Ж DOM, що редагується, — тож highlights/colorNotes несуть посилання на
// свої рани (runs) і абзац (paragraph). Агентний режим правок за ними бачить,
// які виділення вже опрацьовано, а які ні. Сам перелік і тексти — ті самі,
// що в extractAnnotations.
// ─────────────────────────────────────────────
export async function extractAnnotationsFromOpenDocx(zip, docXml, io = {}) {
  const Parser = io.DOMParser || DOMParser;
  const Serializer = io.XMLSerializer || XMLSerializer;
  const docXmlRaw = new Serializer().serializeToString(docXml);
  let commentsXml = null;
  try {
    const raw = await zip.file("word/comments.xml")?.async("string");
    if (raw) commentsXml = new Parser().parseFromString(raw, "text/xml");
  } catch { /**/ }
  return collectAnnotations(docXml, docXmlRaw, commentsXml);
}

function collectAnnotations(docXml, docXmlRaw, commentsXml) {
  // ── Коментарі ──
  const commentMap = {};
  if (commentsXml) {
    const commentEls = Array.from(commentsXml.getElementsByTagName("w:comment"));
    for (const c of commentEls) {
      const id = c.getAttribute("w:id");
      const author = c.getAttribute("w:author") || "Автор";
      const tEls = Array.from(c.getElementsByTagName("w:t"));
      let text = "";
      for (const t of tEls) text += t.textContent + " ";
      commentMap[id] = { author, text: text.trim() };
    }
  }

  // ── Виділення (параграф за параграфом) ──
  const highlights = [];
  // Нотатки, вписані прямо в текст червонуватим кольором шрифту (не підсвітка,
  // не справжній коментар Word) — див. isReddishColor.
  const colorNotes = [];
  // Абзаци й рани — за тими самими правилами, що й текстова мапа
  // (docxSurgicalEdit.js): без дублів mc:Fallback і без тексту вкладених написів.
  const paragraphs = getBodyParagraphs(docXml);

  for (const para of paragraphs) {
    // Повний текст параграфу
    const allT = ownDescendants(para, "w:t");
    let paraText = "";
    for (const t of allT) paraText += t.textContent;
    if (!paraText.trim()) continue;

    const runs = ownDescendants(para, "w:r");
    let curColor = null;
    let curText = "";
    // Короткий нерозфарбований розрив (звичайно — пробіл) між двома виділеннями
    // ТОГО САМОГО кольору не повинен розривати їх на окремі анотації: керівники
    // часто виділяють і сам проблемний фрагмент, і власний коментар одразу після
    // нього — розділені лише пробілом-раном без highlight. Якщо розривати тут,
    // завдання на виправлення губить половину контексту (див. "6678-6679]." +
    // "Що це за нереальні сторінки?" — без об'єднання ШІ не бачить, до чого
    // відноситься коментар).
    let pendingGap = "";
    // Рани поточного виділення/нотатки — посилання на вузли того DOM, з якого
    // читали (для агентного режиму: чи виділення ще на місці).
    let curRuns = [];

    const flush = () => {
      if (curText && curColor) {
        highlights.push({
          color: curColor,
          colorInfo: HIGHLIGHT_COLORS[curColor] || { ua: curColor, css: "#e5e7eb", text: "#374151" },
          text: curText.trim(),
          context: paraText.trim(),
          runs: curRuns,
          paragraph: para,
        });
      }
      curColor = null;
      curText = "";
      pendingGap = "";
      curRuns = [];
    };

    // Той самий принцип групування сусідніх ранів, що й для підсвітки вище,
    // але за кольором ШРИФТУ (w:color), а не фону.
    let curNoteColor = null;
    let curNoteText = "";
    let notePendingGap = "";
    let curNoteRuns = [];

    const flushNote = () => {
      if (curNoteText && curNoteColor) {
        colorNotes.push({ text: curNoteText.trim(), context: paraText.trim(), runs: curNoteRuns, paragraph: para });
      }
      curNoteColor = null;
      curNoteText = "";
      notePendingGap = "";
      curNoteRuns = [];
    };

    for (const run of runs) {
      const rPr = run.getElementsByTagName("w:rPr")[0];
      const highlightEl = rPr?.getElementsByTagName("w:highlight")[0];
      const color = highlightEl?.getAttribute("w:val");
      const colorEl = rPr?.getElementsByTagName("w:color")[0];
      const fontColor = colorEl?.getAttribute("w:val");

      const tEls = Array.from(run.getElementsByTagName("w:t"));
      let runText = "";
      for (const t of tEls) runText += t.textContent;

      const isHighlighted = color && color !== "none" && color !== "white" && color !== "black";
      const isRedNote = fontColor && isReddishColor(fontColor);

      if (isHighlighted) {
        if (color === curColor) {
          curText += pendingGap + runText;
          pendingGap = "";
        } else {
          flush();
          curColor = color;
          curText = runText;
        }
        curRuns.push(run);
      } else if (curColor && /^\s*$/.test(runText)) {
        // пробільний розрив під час активного виділення — тримаємо про запас,
        // не скидаємо накопичене одразу
        pendingGap += runText;
      } else {
        flush();
      }

      if (isRedNote) {
        if (fontColor === curNoteColor) {
          curNoteText += notePendingGap + runText;
          notePendingGap = "";
        } else {
          flushNote();
          curNoteColor = fontColor;
          curNoteText = runText;
        }
        curNoteRuns.push(run);
      } else if (curNoteColor && /^\s*$/.test(runText)) {
        notePendingGap += runText;
      } else {
        flushNote();
      }
    }
    flush();
    flushNote();
  }

  // ── Коментарі з прив'язкою до тексту ──
  const comments = [];
  if (Object.keys(commentMap).length > 0) {
    const commentStarts = Array.from(docXml.getElementsByTagName("w:commentRangeStart"));
    for (const startEl of commentStarts) {
      const id = startEl.getAttribute("w:id");
      const comment = commentMap[id];
      if (!comment) continue;

      // Витягуємо текст між commentRangeStart і commentRangeEnd через рядковий пошук
      const startMarker = `w:id="${id}"`;
      const endTag = `<w:commentRangeEnd`;
      let searchFrom = 0;
      let commentedText = "";

      while (searchFrom < docXmlRaw.length) {
        const sPos = docXmlRaw.indexOf("<w:commentRangeStart", searchFrom);
        if (sPos === -1) break;
        const idPos = docXmlRaw.indexOf(startMarker, sPos);
        const tagEnd = docXmlRaw.indexOf(">", sPos);
        if (idPos !== -1 && idPos < tagEnd) {
          const afterStart = tagEnd + 1;
          let ePos = afterStart;
          // Знаходимо commentRangeEnd з тим самим id
          while (ePos < docXmlRaw.length) {
            const candidateEnd = docXmlRaw.indexOf(endTag, ePos);
            if (candidateEnd === -1) { ePos = docXmlRaw.length; break; }
            const endIdPos = docXmlRaw.indexOf(startMarker, candidateEnd);
            const endTagEnd = docXmlRaw.indexOf(">", candidateEnd);
            if (endIdPos !== -1 && endIdPos < endTagEnd) { ePos = candidateEnd; break; }
            ePos = candidateEnd + 1;
          }
          if (ePos < docXmlRaw.length) {
            const between = docXmlRaw.slice(afterStart, ePos);
            const tMatches = [...between.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)];
            commentedText = tMatches.map(m => m[1]).join("").trim();
          }
          break;
        }
        searchFrom = sPos + 1;
      }

      if (commentedText || comment.text) {
        comments.push({
          id,
          author: comment.author,
          instruction: comment.text,
          commentedText: commentedText || "(текст не визначено)",
        });
      }
    }
  }

  return { highlights, comments, colorNotes };
}
