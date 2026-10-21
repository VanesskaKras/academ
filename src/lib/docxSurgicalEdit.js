// ─────────────────────────────────────────────
// Хірургічне редагування .docx: точкова заміна тексту прямо в оригінальному
// XML файлі (як Edit-тулза працює з кодом — знайти конкретне місце, змінити
// тільки його), без переходу через plain text і перебудови документа з нуля.
// Це зберігає ВСЕ оригінальне форматування (таблиці, стилі, шрифти, підписи),
// яке губилось при старому підході mammoth.extractRawText → docx-реконструкція.
//
// Працює однаково в браузері й у воркері: лише DOM-операції, що є і в
// браузерному DOM, і в @xmldom/xmldom (io — Node-ін'єкція, worker/docxNodeIO.js).
// ─────────────────────────────────────────────

import { isReddishColor } from "./docxAnnotations.js";
import { getBodyParagraphs, ownDescendants, outermostAncestor, childByTag } from "./docxTree.js";

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

// ── Плаский текст документа + мапа "позиція в тексті → вузол <w:t>" ──
// Абзаци (<w:p>) розділяються символом "\n" без прив'язки до жодного вузла.
// Набір абзаців і тексту — за правилами docxTree.js (без дублів mc:Fallback і
// без тексту написів у зовнішньому абзаці), так само як у docxAnnotations.js.
//
// Array.from() замість спреду [...x] — xmldom LiveNodeList не ітерований.
function buildTextMap(docXml) {
  const paragraphs = getBodyParagraphs(docXml);
  const map = [];
  let plainText = "";
  paragraphs.forEach((p, pi) => {
    ownDescendants(p, "w:t").forEach(node => {
      const text = node.textContent;
      if (!text) return;
      map.push({ node, start: plainText.length, end: plainText.length + text.length });
      plainText += text;
    });
    if (pi < paragraphs.length - 1) plainText += "\n";
  });
  return { map, plainText };
}

// ── Відкрити .docx для редагування: повертає zip, DOM document.xml і поточну
// мапу тексту. zip/docXml — живі об'єкти, які потрібно тримати в ref (не в
// React-стейті) і передавати в наступні виклики цього модуля.
//
// io (опц.) — { JSZip, DOMParser } для запуску поза браузером (worker/*, через
// worker/docxNodeIO.js); без io — браузерна поведінка (CDN JSZip, глобальний
// DOMParser). ──
export async function openDocxForEditing(arrayBuffer, io = {}) {
  const JSZip = io.JSZip || (await loadJSZip());
  const zip = await JSZip.loadAsync(arrayBuffer);
  const docFile = zip.file("word/document.xml");
  if (!docFile) throw new Error("У файлі немає word/document.xml — це не .docx");
  const docXmlRaw = await docFile.async("string");
  const Parser = io.DOMParser || DOMParser;
  const docXml = new Parser().parseFromString(docXmlRaw, "text/xml");
  const { map, plainText } = buildTextMap(docXml);
  return { zip, docXml, map, plainText };
}

// ── Перебудувати мапу тексту після зміни DOM — виклик після КОЖНОЇ застосованої
// заміни, інакше позиції наступних правок (з locateFragment) з'їдуть відносно
// вже зміненого документа. ──
export function refreshTextMap(docXml) {
  return buildTextMap(docXml);
}

// Абзаци документа в тому самому порядку, що й рядки plainText:
// plainText.split("\n")[i] — це текст getParagraphs(docXml)[i].
export function getParagraphs(docXml) {
  return getBodyParagraphs(docXml);
}

// Текст одного абзацу + локальна мапа його вузлів <w:t>.
export function paragraphTextMap(p) {
  const map = [];
  let text = "";
  ownDescendants(p, "w:t").forEach(node => {
    const t = node.textContent;
    if (!t) return;
    map.push({ node, start: text.length, end: text.length + t.length });
    text += t;
  });
  return { map, text };
}

function ownParagraph(node) {
  for (let n = node.parentNode; n; n = n.parentNode) {
    if (n.tagName === "w:p") return n;
  }
  return null;
}

function setTextPreserve(t, s) {
  t.textContent = s;
  if (/^\s|\s$|\s\s/.test(s)) t.setAttribute("xml:space", "preserve");
}

// ── Позначка "цю правку вніс воркер" — заливка рану бірюзовим кольором
// (w:shd, а НЕ w:highlight): collectAnnotations (docxAnnotations.js) читає
// лише w:highlight і колір шрифту, тож ця заливка ніколи не сплутається із
// зауваженням керівника на наступному циклі правок. Вмикається лише прапорцем
// markEdits (worker/runCorrections.js) — кнопка "Правки" в браузері документ
// так не позначає. ──
const EDIT_SHADE_FILL = "0D9488";
// Теги rPr, що йдуть ПІСЛЯ w:shd за схемою OOXML (CT_RPr) — щоб вставити
// новий w:shd у правильну позицію, а не просто в кінець.
const RPR_AFTER_SHD = ["w:fitText", "w:vertAlign", "w:rtl", "w:cs", "w:em", "w:lang", "w:eastAsianLayout", "w:specVanish", "w:oMath"];

function markEditedRun(run) {
  if (!run || run.tagName !== "w:r") return;
  const doc = run.ownerDocument;
  const ns = run.namespaceURI;
  let rPr = childByTag(run, "w:rPr");
  if (!rPr) {
    rPr = doc.createElementNS(ns, "w:rPr");
    run.insertBefore(rPr, run.firstChild);
  }
  let shd = childByTag(rPr, "w:shd");
  if (!shd) {
    shd = doc.createElementNS(ns, "w:shd");
    const before = Array.from(rPr.childNodes).find(n => RPR_AFTER_SHD.includes(n.tagName));
    rPr.insertBefore(shd, before || null);
  }
  shd.setAttribute("w:val", "clear");
  shd.setAttribute("w:color", "auto");
  shd.setAttribute("w:fill", EDIT_SHADE_FILL);
}

// Маркери "потребує уваги" на рані: підсвітка (w:highlight) і червонуватий колір
// шрифту (нотатка керівника, вписана в текст). Повертає, чи щось зняли.
export function clearAttentionMarkers(run) {
  const rPr = run && run.tagName === "w:r" ? childByTag(run, "w:rPr") : null;
  if (!rPr) return false;
  let changed = false;
  const hl = childByTag(rPr, "w:highlight");
  if (hl) { rPr.removeChild(hl); changed = true; }
  const color = childByTag(rPr, "w:color");
  if (color && isReddishColor(color.getAttribute("w:val"))) { rPr.removeChild(color); changed = true; }
  return changed;
}

// Властивості рану без маркерів уваги й без слідів рецензування — для нових ранів.
function cleanRunProps(rPr) {
  ["w:highlight", "w:ins", "w:del", "w:moveFrom", "w:moveTo", "w:rPrChange"].forEach(tag => {
    const el = childByTag(rPr, tag);
    if (el) rPr.removeChild(el);
  });
  const color = childByTag(rPr, "w:color");
  if (color && isReddishColor(color.getAttribute("w:val"))) rPr.removeChild(color);
  return rPr;
}

// Базова операція над вузлами: [start, end) у координатах map → replacement
// у першому зачепленому вузлі, решта зачеплених вузлів — лише обрізаються.
function writeRange(map, start, end, replacement, markEdits = false) {
  const touched = map.filter(m => m.end > start && m.start < end);
  if (!touched.length) return false;
  touched.forEach((m, i) => {
    const text = m.node.textContent;
    const localStart = Math.max(0, start - m.start);
    const localEnd = Math.min(text.length, end - m.start);
    const newText = i === 0
      ? text.slice(0, localStart) + replacement + text.slice(localEnd)
      : text.slice(0, localStart) + text.slice(localEnd);
    setTextPreserve(m.node, newText);
    if (markEdits && i === 0) markEditedRun(m.node.parentNode);
  });
  return true;
}

// ── Пословне порівняння старого й нового тексту абзацу → мінімальні заміни
// (hunks) у координатах старого тексту. Так правка зачіпає лише справді змінені
// слова, а жирне "Актуальність теми.", курсивні терміни, гіперпосилання поруч
// лишаються у своїх ранах — замість того, щоб увесь новий текст ліг у формат
// першого рану абзацу. ──
const TOKEN_RE = /\s+|[^\s]+/g;
const DIFF_MAX_CELLS = 2_000_000;

function diffHunks(oldText, newText) {
  const a = oldText.match(TOKEN_RE) || [];
  const b = newText.match(TOKEN_RE) || [];
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const A = a.slice(pre, a.length - suf);
  const B = b.slice(pre, b.length - suf);
  const offA = [];
  let o = 0;
  for (const t of a) { offA.push(o); o += t.length; }
  offA.push(o);
  const base = offA[pre];
  if (!A.length && !B.length) return [];
  if (A.length * B.length > DIFF_MAX_CELLS) {
    return [{ start: base, end: offA[a.length - suf], replacement: B.join("") }];
  }
  const n = A.length, m = B.length;
  const dp = [];
  for (let i = 0; i <= n; i++) dp.push(new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const hunks = [];
  let cur = null;
  let pos = base;
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && A[i] === B[j]) {
      if (cur) { hunks.push(cur); cur = null; }
      pos += A[i].length; i++; j++;
    } else if (j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) {
      cur = cur || { start: pos, end: pos, replacement: "" };
      cur.replacement += B[j]; j++;
    } else {
      cur = cur || { start: pos, end: pos, replacement: "" };
      cur.end += A[i].length; pos += A[i].length; i++;
    }
  }
  if (cur) hunks.push(cur);
  // Зливаємо заміни, розділені лише пробілом чи одним коротким словом — інакше
  // суттєво переписане речення розсипається на десятки дрібних шматків.
  const merged = [];
  for (const h of hunks) {
    const prev = merged[merged.length - 1];
    if (prev) {
      const gap = oldText.slice(prev.end, h.start);
      if (!gap.trim() || (gap.trim().length <= 2 && gap.trim().split(/\s+/).length === 1)) {
        prev.replacement += gap + h.replacement;
        prev.end = h.end;
        continue;
      }
    }
    merged.push({ ...h });
  }
  return merged;
}

// Новий ран у кінці абзацу (для абзацу, де ще немає жодного <w:t>) з
// оформленням знака абзацу (w:pPr/w:rPr).
function appendRunWithText(p, text, markEdits = false) {
  const doc = p.ownerDocument;
  const ns = p.namespaceURI;
  const r = doc.createElementNS(ns, "w:r");
  const pPr = childByTag(p, "w:pPr");
  const markRPr = pPr && childByTag(pPr, "w:rPr");
  if (markRPr) r.appendChild(cleanRunProps(markRPr.cloneNode(true)));
  const t = doc.createElementNS(ns, "w:t");
  setTextPreserve(t, text);
  r.appendChild(t);
  p.appendChild(r);
  if (markEdits) markEditedRun(r);
}

// ── Встановити текст абзацу, змінюючи лише відмінні слова (diffHunks). Після
// застосування — перевірка: якщо з якоїсь причини текст не збігся, повна
// заміна в перший вузол (текст важливіший за збереження дрібного форматування). ──
export function setParagraphText(p, newText, markEdits = false) {
  const { map, text } = paragraphTextMap(p);
  if (text === newText) return true;
  if (!map.length) {
    if (newText) appendRunWithText(p, newText, markEdits);
    return true;
  }
  const hunks = diffHunks(text, newText).sort((x, y) => y.start - x.start);
  for (const h of hunks) {
    let { start, end, replacement } = h;
    if (start === end) {
      // Чиста вставка між двома вузлами не зачепила б жоден — "чіпляємо" її
      // до сусіднього символу, щоб вона лягла в його ран (його форматування).
      if (start > 0) { start -= 1; replacement = text[start] + replacement; }
      else { replacement += text[end]; end += 1; }
    }
    writeRange(map, start, end, replacement, markEdits);
  }
  const check = paragraphTextMap(p);
  if (check.text !== newText) {
    if (check.map.length) writeRange(check.map, 0, check.text.length, newText, markEdits);
    else if (newText) appendRunWithText(p, newText, markEdits);
  }
  return true;
}

// ── Замінити фрагмент [start, end) плаского тексту на replacement, лишаючи
// решту XML (форматування, таблиці, стилі, підписи) недоторканою.
// - У межах одного абзацу змінюються лише відмінні слова (setParagraphText).
// - Якщо фрагмент охоплює кілька абзаців або replacement містить "\n" —
//   абзаци перебудовуються як абзаци (replaceTextRange), а не зливаються в один
//   текстовий вузол із переносами всередині (Word такі переноси не показує —
//   раніше так злипався, напр., перебудований список джерел).
// Заодно знімає підсвітку й червонуватий колір з ранів, що перетинали
// фрагмент: його виправлено, маркер "потребує уваги" більше не актуальний. ──
export function applyDocxReplacement(map, start, end, replacement, markEdits = false) {
  const touched = map.filter(m => m.end > start && m.start < end);
  if (!touched.length) return false;
  const markedRuns = touched.map(m => m.node.parentNode).filter(Boolean);
  const paras = new Set(touched.map(m => ownParagraph(m.node)));
  // Захист таблиць: markdown-таблиця в replacement (ШІ любить так "малювати" таблиці)
  // записалась би як звичайний текст в комірки й зіпсувала таблицю; заміна, що
  // охоплює кілька абзаців таблиці, злила б комірки. Таке не застосовуємо —
  // виклик отримує false і має позначити завдання як таке, що потребує уваги.
  if (/^\s*\|.*\|\s*$/m.test(replacement)) return false;
  if (paras.size > 1 && [...paras].some(p => p && outermostAncestor(p, "w:tbl"))) return false;
  if (paras.size === 1 && !replacement.includes("\n")) {
    const p = [...paras][0];
    const local = paragraphTextMap(p);
    const first = local.map.find(e => e.node === touched[0].node);
    const delta = touched[0].start - (first ? first.start : 0);
    const s = start - delta;
    const e = end - delta;
    setParagraphText(p, local.text.slice(0, Math.max(0, s)) + replacement + local.text.slice(Math.max(0, e)), markEdits);
  } else {
    replaceTextRange(touched[0].node.ownerDocument, start, end, replacement, markEdits);
  }
  markedRuns.forEach(run => clearAttentionMarkers(run));
  return true;
}

// ── Заміна діапазону плаского тексту з урахуванням абзаців: старі рядки
// (абзаци) [a..b] перетворюються на нові рядки. Наявні абзаци переписуються
// по черзі (зберігаючи свій стиль), зайві — видаляються (або очищуються, якщо
// видаляти небезпечно), бракуючі — додаються з оформленням останнього. ──
export function replaceTextRange(docXml, start, end, replacement, markEdits = false) {
  const paras = getBodyParagraphs(docXml);
  const lines = [];
  const ls = [];
  let off = 0;
  paras.forEach(p => {
    const t = paragraphTextMap(p).text;
    ls.push(off);
    lines.push(t);
    off += t.length + 1;
  });
  const lineAt = pos => {
    let lo = 0, hi = ls.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (ls[mid] <= pos) lo = mid; else hi = mid - 1;
    }
    return lo;
  };
  const a = lineAt(start);
  const b = lineAt(end);
  const combined = lines[a].slice(0, start - ls[a]) + replacement + lines[b].slice(end - ls[b]);
  const newLines = combined.split("\n");
  const old = paras.slice(a, b + 1);
  const common = Math.min(newLines.length, old.length);
  for (let i = 0; i < common; i++) setParagraphText(old[i], newLines[i], markEdits);
  if (newLines.length > old.length) {
    const model = old[old.length - 1];
    insertParagraphsAfterEl(model, newLines.slice(old.length), model, { markEdits });
  } else if (newLines.length < old.length) {
    const res = deleteParagraphEls(old.slice(newLines.length), { moveMarkersTo: old[newLines.length - 1] || old[0] });
    res.skipped.forEach(({ p }) => setParagraphText(p, ""));
  }
  return true;
}

// Властивості рану, що переважають в абзаці (найдовший текстовий ран), —
// а не першого рану: абзаци часто починаються з жирного "Мета дослідження –".
function dominantRunProps(p) {
  let best = null;
  let bestLen = 0;
  ownDescendants(p, "w:r").forEach(run => {
    const len = Array.from(run.childNodes).filter(n => n.tagName === "w:t").reduce((s, t) => s + (t.textContent || "").length, 0);
    if (len > bestLen) { bestLen = len; best = run; }
  });
  if (best) return childByTag(best, "w:rPr");
  const pPr = childByTag(p, "w:pPr");
  return pPr ? childByTag(pPr, "w:rPr") : null;
}

// Новий <w:p> з тим самим оформленням абзацу (w:pPr) і шрифтом переважного
// рану model — так вставлений абзац виглядає як сусідні. Із клону прибирається
// все, що не можна дублювати: розрив розділу (w:sectPr), сліди рецензування,
// підсвітка/червонуватий колір (маркери "потребує уваги").
function buildParagraphLike(doc, model, text, markEdits = false) {
  const ns = model.namespaceURI;
  const p = doc.createElementNS(ns, "w:p");
  const pPr = childByTag(model, "w:pPr");
  if (pPr) {
    const pPrClone = pPr.cloneNode(true);
    ["w:sectPr", "w:pPrChange"].forEach(tag => {
      const el = childByTag(pPrClone, tag);
      if (el) pPrClone.removeChild(el);
    });
    const markRPr = childByTag(pPrClone, "w:rPr");
    if (markRPr) cleanRunProps(markRPr);
    p.appendChild(pPrClone);
  }
  const r = doc.createElementNS(ns, "w:r");
  const rPr = dominantRunProps(model);
  if (rPr) r.appendChild(cleanRunProps(rPr.cloneNode(true)));
  const t = doc.createElementNS(ns, "w:t");
  setTextPreserve(t, text);
  r.appendChild(t);
  p.appendChild(r);
  if (markEdits) markEditedRun(r);
  return p;
}

// ── Вставити абзаци після anchor з оформленням model. afterTable:true — якщо
// anchor у таблиці, вставити ПІСЛЯ всієї таблиці (а не в її клітинку).
// Повертає створені елементи. ──
export function insertParagraphsAfterEl(anchor, texts, model = anchor, { afterTable = false, markEdits = false } = {}) {
  const doc = anchor.ownerDocument;
  let ref = anchor;
  if (afterTable) {
    const tbl = outermostAncestor(anchor, "w:tbl");
    if (tbl) ref = tbl;
  }
  const created = [];
  for (const text of texts) {
    const newP = buildParagraphLike(doc, model, text, markEdits);
    ref.parentNode.insertBefore(newP, ref.nextSibling);
    ref = newP;
    created.push(newP);
  }
  return created;
}

export function insertParagraphsBeforeEl(anchor, texts, model = anchor, markEdits = false) {
  const doc = anchor.ownerDocument;
  return texts.map(text => {
    const newP = buildParagraphLike(doc, model, text, markEdits);
    anchor.parentNode.insertBefore(newP, anchor);
    return newP;
  });
}

// Сумісність зі старим API за індексами (getParagraphs): -1 — на початок.
export function insertParagraphsAfter(docXml, afterIndex, texts, styleLikeIndex = afterIndex, markEdits = false) {
  const paras = getParagraphs(docXml);
  if (!paras.length) throw new Error("У документі немає абзаців");
  const model = paras[styleLikeIndex] || paras[Math.max(0, afterIndex)];
  if (afterIndex < 0) return insertParagraphsBeforeEl(paras[0], texts, model, markEdits).length;
  if (!paras[afterIndex]) throw new Error(`Абзацу ${afterIndex} не існує (усього ${paras.length})`);
  return insertParagraphsAfterEl(paras[afterIndex], texts, model, { markEdits }).length;
}

// Поля Word (зміст, посилання, номери сторінок) у вигляді fldChar begin/end
// можуть тягнутися через кілька абзаців — видалити абзац із "половиною" поля
// означає зламати файл ("виявлено нечитабельний вміст").
function fieldsBalanced(p) {
  let depth = 0;
  for (const fc of Array.from(p.getElementsByTagName("w:fldChar"))) {
    const type = fc.getAttribute("w:fldCharType");
    if (type === "begin") depth++;
    else if (type === "end") {
      depth--;
      if (depth < 0) return false;
    }
  }
  return depth === 0;
}

export function unsafeToDeleteReason(p) {
  if (p.getElementsByTagName("w:drawing").length || p.getElementsByTagName("w:pict").length || p.getElementsByTagName("w:object").length) return "рисунок/об'єкт";
  if (p.getElementsByTagName("m:oMath").length) return "формула";
  if (p.getElementsByTagName("w:txbxContent").length) return "напис/фігура";
  if (!fieldsBalanced(p)) return "частина поля Word (напр., змісту)";
  return null;
}

// Закладки й межі коментарів з абзацу, що видаляється, переносимо в сусідній —
// інакше лишаються "осиротілі" пари start/end.
function moveRangeMarkers(from, to) {
  ["w:bookmarkStart", "w:bookmarkEnd", "w:commentRangeStart", "w:commentRangeEnd"].forEach(tag => {
    ownDescendants(from, tag).forEach(el => to.appendChild(el));
  });
  ownDescendants(from, "w:commentReference").forEach(ref => {
    const run = ref.parentNode;
    if (run?.tagName === "w:r") to.appendChild(run);
  });
}

// ── Видалити абзаци. Не видаляються, а лише очищуються від тексту: абзац із
// розривом розділу (w:sectPr) та єдиний абзац клітинки таблиці. Абзаци з
// рисунками, формулами, написами чи частиною поля Word пропускаються (skipped).
// Повертає id коментарів, чиї прив'язки були в прибраних абзацах. ──
export function deleteParagraphEls(els, { moveMarkersTo = null } = {}) {
  const result = { deleted: 0, cleared: 0, skipped: [], commentIds: [] };
  for (const p of els) {
    if (!p.parentNode) continue;
    const reason = unsafeToDeleteReason(p);
    if (reason) {
      result.skipped.push({ p, reason });
      continue;
    }
    ["w:commentRangeStart", "w:commentReference"].forEach(tag => {
      ownDescendants(p, tag).forEach(el => result.commentIds.push(el.getAttribute("w:id")));
    });
    const pPr = childByTag(p, "w:pPr");
    const hasSectPr = pPr && childByTag(pPr, "w:sectPr");
    const parent = p.parentNode;
    const onlyInCell = parent.tagName === "w:tc" && Array.from(parent.childNodes).filter(n => n.tagName === "w:p").length === 1;
    if (moveMarkersTo && moveMarkersTo !== p && moveMarkersTo.parentNode) moveRangeMarkers(p, moveMarkersTo);
    if (hasSectPr || onlyInCell) {
      Array.from(p.childNodes).filter(n => n.tagName !== "w:pPr").forEach(n => p.removeChild(n));
      result.cleared++;
    } else {
      parent.removeChild(p);
      result.deleted++;
    }
  }
  result.commentIds = [...new Set(result.commentIds.filter(Boolean))];
  return result;
}

// Сумісність зі старим API за індексами.
export function deleteParagraphs(docXml, from, to) {
  const paras = getParagraphs(docXml);
  const res = deleteParagraphEls(paras.slice(from, to + 1));
  return { ...res, skipped: res.skipped.map(s => paras.indexOf(s.p)) };
}

// ── Що в абзаці, крім тексту: для позначок, які бачить агент ([12|рисунок]). ──
export function paragraphInfo(p, styleNames = {}) {
  const styleId = paragraphStyleId(p);
  const pPr = childByTag(p, "w:pPr");
  return {
    styleName: styleNames[styleId] || styleId || "",
    inTable: !!outermostAncestor(p, "w:tbl"),
    hasPicture: !!(p.getElementsByTagName("w:drawing").length || p.getElementsByTagName("w:pict").length || p.getElementsByTagName("w:object").length),
    hasMath: !!p.getElementsByTagName("m:oMath").length,
    numbered: !!(pPr && childByTag(pPr, "w:numPr")),
  };
}

// ── Табуляції й розриви рядка всередині абзацу (у плаский текст вони не
// потрапляють — лише <w:t>): позиції в тексті абзацу, де вони стоять. ──
export function paragraphInlineMarkers(p) {
  const markers = [];
  let offset = 0;
  const walk = node => {
    for (const ch of Array.from(node.childNodes)) {
      const tag = ch.tagName;
      if (!tag || tag === "w:p" || tag === "mc:Fallback") continue;
      if (tag === "w:t") { offset += (ch.textContent || "").length; continue; }
      if ((tag === "w:tab" || tag === "w:br" || tag === "w:cr") && ch.parentNode?.tagName === "w:r") {
        markers.push({ offset, kind: tag === "w:tab" ? "tab" : "br" });
        continue;
      }
      walk(ch);
    }
  };
  walk(p);
  return markers;
}

// ── Прийняти всі виправлення режиму рецензування ("Виправлення" у Word):
// вставлене стає звичайним текстом, видалене прибирається, зміни форматування
// лишаються новими. Раніше їх не бачив ніхто: видалення викладача були
// невидимі, вставки — звичайним текстом, а клієнт отримував файл із
// неприйнятими виправленнями. ──
const MARKER_PARENTS = new Set(["w:rPr", "w:trPr", "w:pPr", "w:numPr", "w:tcPr"]);
const MOVE_RANGE_MARKERS = [
  "w:moveFromRangeStart", "w:moveFromRangeEnd", "w:moveToRangeStart", "w:moveToRangeEnd",
  "w:customXmlInsRangeStart", "w:customXmlInsRangeEnd", "w:customXmlDelRangeStart", "w:customXmlDelRangeEnd",
  "w:customXmlMoveFromRangeStart", "w:customXmlMoveFromRangeEnd", "w:customXmlMoveToRangeStart", "w:customXmlMoveToRangeEnd",
];
const FORMAT_CHANGES = ["w:rPrChange", "w:pPrChange", "w:sectPrChange", "w:tblPrChange", "w:tblPrExChange", "w:trPrChange", "w:tcPrChange", "w:tblGridChange", "w:numberingChange"];

function nextSiblingElement(el) {
  let n = el.nextSibling;
  while (n && !n.tagName) n = n.nextSibling;
  return n;
}

export function acceptAllRevisions(xmlDoc) {
  const counts = { inserted: 0, deleted: 0, formatting: 0 };
  const all = tag => Array.from(xmlDoc.getElementsByTagName(tag));

  // 1) Видалений вміст (обгортки з ранами). Закладки, межі коментарів і ран із
  //    посиланням на коментар виносимо назовні — щоб коментар не "осиротів".
  for (const tag of ["w:del", "w:moveFrom"]) {
    for (const el of all(tag)) {
      const parent = el.parentNode;
      if (!parent || MARKER_PARENTS.has(parent.tagName)) continue;
      Array.from(el.childNodes).forEach(ch => {
        if (!ch.tagName) return;
        const keepMarker = /^w:(commentRange(Start|End)|bookmark(Start|End)|permStart|permEnd)$/.test(ch.tagName);
        const keepRef = ch.tagName === "w:r" && ch.getElementsByTagName("w:commentReference").length > 0;
        if (keepRef) {
          Array.from(ch.childNodes).filter(n => n.tagName === "w:delText" || n.tagName === "w:delInstrText").forEach(n => ch.removeChild(n));
        }
        if (keepMarker || keepRef) parent.insertBefore(ch, el);
      });
      parent.removeChild(el);
      counts.deleted++;
    }
  }

  // 2) Видалені знаки абзацу (абзац зливається з наступним) і видалені рядки таблиць.
  for (const el of [...all("w:del"), ...all("w:moveFrom")]) {
    const parent = el.parentNode;
    if (!parent) continue;
    parent.removeChild(el);
    if (parent.tagName === "w:rPr" && parent.parentNode?.tagName === "w:pPr") {
      const p = parent.parentNode.parentNode;
      const next = p && nextSiblingElement(p);
      if (next && next.tagName === "w:p") {
        const nextPPr = childByTag(next, "w:pPr");
        const insertRef = nextPPr ? nextPPr.nextSibling : next.firstChild;
        Array.from(p.childNodes).filter(n => n.tagName !== "w:pPr").forEach(n => next.insertBefore(n, insertRef));
        p.parentNode.removeChild(p);
      }
      counts.deleted++;
    } else if (parent.tagName === "w:trPr") {
      const tr = parent.parentNode;
      const tbl = tr?.parentNode;
      if (tr && tbl) {
        tbl.removeChild(tr);
        if (!Array.from(tbl.childNodes).some(n => n.tagName === "w:tr")) tbl.parentNode?.removeChild(tbl);
      }
      counts.deleted++;
    }
  }

  // 3) Вставлений вміст — розгортаємо обгортку; порожні маркери вставки — прибираємо.
  for (const tag of ["w:ins", "w:moveTo"]) {
    for (const el of all(tag)) {
      const parent = el.parentNode;
      if (!parent) continue;
      if (MARKER_PARENTS.has(parent.tagName) || !el.firstChild) {
        parent.removeChild(el);
        continue;
      }
      while (el.firstChild) parent.insertBefore(el.firstChild, el);
      parent.removeChild(el);
      counts.inserted++;
    }
  }

  MOVE_RANGE_MARKERS.forEach(tag => all(tag).forEach(el => el.parentNode?.removeChild(el)));
  FORMAT_CHANGES.forEach(tag => all(tag).forEach(el => {
    if (!el.parentNode) return;
    el.parentNode.removeChild(el);
    counts.formatting++;
  }));
  ["w:cellIns", "w:cellDel", "w:cellMerge"].forEach(tag => all(tag).forEach(el => el.parentNode?.removeChild(el)));
  return counts;
}

// Те саме для всього файлу: основний текст + виноски/колонтитули, і вимкнення
// режиму рецензування (інакше кожна наступна правка клієнта знову
// відстежуватиметься).
export async function acceptRevisionsInDocx(zip, docXml, io = {}) {
  const total = acceptAllRevisions(docXml);
  const Parser = io.DOMParser || DOMParser;
  const Serializer = io.XMLSerializer || XMLSerializer;
  const parts = Object.keys(zip.files).filter(n => /^word\/(footnotes|endnotes|header\d*|footer\d*)\.xml$/.test(n));
  for (const name of parts) {
    const raw = await zip.file(name).async("string");
    if (!/<w:(ins|del|moveFrom|moveTo|rPrChange|pPrChange)\b/.test(raw)) continue;
    const xml = new Parser().parseFromString(raw, "text/xml");
    const c = acceptAllRevisions(xml);
    Object.keys(c).forEach(k => { total[k] += c[k]; });
    zip.file(name, new Serializer().serializeToString(xml));
  }
  total.trackingDisabled = false;
  const settings = zip.file("word/settings.xml");
  if (settings) {
    const raw = await settings.async("string");
    if (/<w:trackRevisions\b/.test(raw)) {
      const xml = new Parser().parseFromString(raw, "text/xml");
      Array.from(xml.getElementsByTagName("w:trackRevisions")).forEach(el => el.parentNode.removeChild(el));
      zip.file("word/settings.xml", new Serializer().serializeToString(xml));
      total.trackingDisabled = true;
    }
  }
  return total;
}

// ── Зміст (поле TOC) у документі? ──
export function documentHasToc(docXml) {
  if (Array.from(docXml.getElementsByTagName("w:instrText")).some(el => /\bTOC\b/.test(el.textContent || ""))) return true;
  if (Array.from(docXml.getElementsByTagName("w:fldSimple")).some(el => /\bTOC\b/.test(el.getAttribute("w:instr") || ""))) return true;
  return Array.from(docXml.getElementsByTagName("w:docPartGallery")).some(el => /Table of Contents/i.test(el.getAttribute("w:val") || ""));
}

// ── Попросити Word оновити поля (зміст, номери сторінок) під час відкриття —
// після зміни заголовків чи обсягу старий зміст інакше лишається як був.
// Елемент ставиться на своє місце в послідовності w:settings (Word до неї
// прискіпливий). ──
const SETTINGS_AFTER_UPDATE_FIELDS = [
  "w:hdrShapeDefaults", "w:footnotePr", "w:endnotePr", "w:compat", "w:docVars", "w:rsids", "m:mathPr",
  "w:attachedSchema", "w:themeFontLang", "w:clrSchemeMapping", "w:doNotIncludeSubdocsInStats",
  "w:doNotAutoCompressPictures", "w:forceUpgrade", "w:captions", "w:readModeInkLockDown", "w:smartTagType",
  "sl:schemaLibrary", "w:shapeDefaults", "w:doNotEmbedSmartTags", "w:decimalSymbol", "w:listSeparator",
];

export async function setUpdateFieldsOnOpen(zip, io = {}) {
  const file = zip.file("word/settings.xml");
  if (!file) return false;
  const raw = await file.async("string");
  if (/<w:updateFields(\s+w:val="(true|1|on)")?\s*\/>/.test(raw)) return false;
  const Parser = io.DOMParser || DOMParser;
  const Serializer = io.XMLSerializer || XMLSerializer;
  const xml = new Parser().parseFromString(raw, "text/xml");
  const settings = xml.getElementsByTagName("w:settings")[0];
  if (!settings) return false;
  Array.from(settings.getElementsByTagName("w:updateFields")).forEach(el => el.parentNode.removeChild(el));
  const el = xml.createElementNS(settings.namespaceURI, "w:updateFields");
  el.setAttribute("w:val", "true");
  const before = Array.from(settings.childNodes).find(n => SETTINGS_AFTER_UPDATE_FIELDS.includes(n.tagName));
  settings.insertBefore(el, before || null);
  zip.file("word/settings.xml", new Serializer().serializeToString(xml));
  return true;
}

// ── Карта styleId → назва стилю з word/styles.xml — щоб розпізнати заголовки
// в укр. Word, де styleId заголовків часто просто "1"/"2", а зрозуміла назва
// ("heading 1"/"Заголовок 1") лежить лише в styles.xml. ──
export async function readStyleNames(zip, io = {}) {
  const file = zip.file("word/styles.xml");
  if (!file) return {};
  const Parser = io.DOMParser || DOMParser;
  const stylesXml = new Parser().parseFromString(await file.async("string"), "text/xml");
  const names = {};
  Array.from(stylesXml.getElementsByTagName("w:style")).forEach(s => {
    const nameEl = s.getElementsByTagName("w:name")[0];
    names[s.getAttribute("w:styleId")] = nameEl?.getAttribute("w:val") || "";
  });
  return names;
}

export function paragraphStyleId(p) {
  const pPr = childByTag(p, "w:pPr");
  const ps = pPr && childByTag(pPr, "w:pStyle");
  return ps?.getAttribute("w:val") || "";
}

// ── Видалити конкретний коментар Word (за id) — і сам запис у comments.xml, і
// його прив'язку в document.xml (commentRangeStart/End/Reference) — щоб
// виправлений файл не тягнув коментар, на який вже відповіли правкою.
// io (опц.) — { DOMParser, XMLSerializer }, див. openDocxForEditing. ──
export async function removeDocxComment(zip, docXml, commentId, io = {}) {
  if (!commentId) return;
  const idStr = String(commentId);
  [...Array.from(docXml.getElementsByTagName("w:commentRangeStart")), ...Array.from(docXml.getElementsByTagName("w:commentRangeEnd"))]
    .filter(el => el.getAttribute("w:id") === idStr)
    .forEach(el => el.parentNode?.removeChild(el));
  Array.from(docXml.getElementsByTagName("w:commentReference"))
    .filter(el => el.getAttribute("w:id") === idStr)
    .forEach(el => { const run = el.parentNode; run?.parentNode?.removeChild(run); });

  const commentsFile = zip.file("word/comments.xml");
  if (!commentsFile) return;
  const commentsRaw = await commentsFile.async("string");
  const Parser = io.DOMParser || DOMParser;
  const Serializer = io.XMLSerializer || XMLSerializer;
  const commentsXml = new Parser().parseFromString(commentsRaw, "text/xml");
  Array.from(commentsXml.getElementsByTagName("w:comment"))
    .filter(el => el.getAttribute("w:id") === idStr)
    .forEach(el => el.parentNode.removeChild(el));
  zip.file("word/comments.xml", new Serializer().serializeToString(commentsXml));
}

// ── Серіалізувати змінений XML назад у zip і повернути готовий .docx.
// asBuffer (за замовчуванням — поза браузером): Buffer замість Blob (у Node
// немає сенсу створювати Blob лише щоб одразу писати його байти у файл). ──
export async function serializeDocx(zip, docXml, io = {}) {
  const Serializer = io.XMLSerializer || XMLSerializer;
  zip.file("word/document.xml", new Serializer().serializeToString(docXml));
  const asBuffer = io.asBuffer ?? typeof window === "undefined";
  if (asBuffer) return zip.generateAsync({ type: "nodebuffer" });
  const raw = await zip.generateAsync({ type: "blob" });
  return new Blob([raw], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
}
