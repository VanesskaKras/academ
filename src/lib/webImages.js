// Автопідбір фото з інтернету для рисунків-заглушок — спільний для браузера
// (academic-assistant.jsx, PracticePage.jsx, small-works.jsx) і воркера
// (worker/processOrder.js), щоб headless-результат збігався з кнопкою в UI.
//
// Заглушка — підпис рисунка ("Рис. 1.2 – Назва"), над яким немає нічого, з чого
// експорт намалював би картинку: ні таблиці даних (→ графік), ні plantuml-блоку
// (→ схема), ні маркера ілюстрації клієнта чи рисунка готової частини. Такі підписи
// в .docx лишаються помаранчевими — менеджер раніше шукав картинку вручну.
//
// Пошук заглушок і пошуковий запит — чистий код (запит = назва з підпису). ШІ
// лише вибирає серед знайдених кандидатів ту картинку, що справді відповідає
// підпису (або жодну) — це кодом не зробити. Сам пошук і завантаження картинок —
// /api/search-images (Serper Images + стиснення на сервері).
import { getApiBase, getProxyAuthHeaders, MODEL } from "./api.js";
import { getLangLabels } from "./planUtils.js";

// Малі роботи (есе, тези, доповідь) — один суцільний текст (order.result) без плану;
// для пошуку заглушок і ключа фото він — "підрозділ" з цим id.
export const SIMPLE_WORK_SECTION_ID = "_body";

// Скільки заглушок максимум шукаємо на одне замовлення — межа вартості (кредит
// Serper + один виклик ШІ з картинками на кожну).
export const WEB_IMAGES_MAX_PER_ORDER = 8;

function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

// "Рис. 1.2 – Назва" → { num: "1.2", name: "Назва" }. Тире обов'язкове — інакше це
// звичайне речення, що починається з "Рис. 1.2 демонструє…", а не підпис.
export function parseFigureCaption(line, figWord) {
  const m = String(line || "").trim().match(new RegExp(`^${escRe(figWord)}\\s*(\\d+(?:\\.\\d+)*)\\.?\\s*[–—-]\\s*(\\S.*)$`, "i"));
  if (!m) return null;
  const name = m[2].trim().replace(/\s*\[[^\]]*\]\s*$/, "").replace(/[.;:]+$/, "").trim();
  return name ? { num: m[1], name } : null;
}

// Ключ рисунка — підрозділ + назва без номера: експорт перенумеровує рисунки
// (renumberTablesAndFigures), а назва лишається тією самою. Апострофи прибираємо,
// бо експорт підмінює ' на ’ ще до того, як шукає картинку.
export function normalizeCaptionName(name) {
  return String(name || "").toLowerCase().replace(/[’'`ʼ]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

export function webImageKey(secId, name) {
  return `${secId}::${normalizeCaptionName(name)}`;
}

// id документа в orders/{id}/webImages — "/" у ньому заборонений, а повна назва
// рисунка задовга, тож підрозділ + короткий хеш назви.
export function webImageDocId(key) {
  let h = 5381;
  for (let i = 0; i < key.length; i++) h = ((h * 33) ^ key.charCodeAt(i)) >>> 0;
  const secPart = key.split("::")[0].replace(/[^\w.-]/g, "_").slice(0, 40);
  return `${secPart}_${h.toString(36)}`;
}

// Рядок, з якого експорт малює рисунок, якщо одразу за ним іде підпис: рядок
// таблиці даних (зокрема без рамкових "|"), кінець plantuml-блоку, маркер
// ілюстрації клієнта / рисунка готової частини, вже вставлена картинка.
const IMAGE_MARKER_LINE_RE = /^\[[^\]\n]+:\d+\]$/;
export function isFigureSourceLine(trimmed) {
  return trimmed.includes("|") || trimmed.startsWith("```") || IMAGE_MARKER_LINE_RE.test(trimmed) || trimmed.startsWith("\x00DIAGRAM");
}

// Рисунок з власними даними роботи — картинки з інтернету для нього не буває.
const OWN_WORK_RE = /(складено|розроблено|побудовано|сформовано|створено|опрацьовано)\s+автором|власн\w*\s+розробк|авторськ\w*\s+(розробк|модел|схем)|author'?s own|(compiled|developed|designed) by the author/i;

function findFigureContext(lines, capIdx, num, figWord) {
  const refRe = new RegExp(`${escRe(figWord)}\\s*${escRe(num)}(?!\\d|\\.\\d)`, "i");
  for (let k = 0; k < lines.length; k++) {
    if (k === capIdx) continue;
    const t = lines[k].trim();
    if (t && refRe.test(t) && !parseFigureCaption(t, figWord)) return t.slice(0, 700);
  }
  let j = capIdx - 1;
  while (j >= 0 && !lines[j].trim()) j--;
  return j >= 0 ? lines[j].trim().slice(0, 700) : "";
}

/**
 * Усі рисунки-заглушки роботи в порядку плану (не більше WEB_IMAGES_MAX_PER_ORDER).
 * skipSectionIds — підрозділи готової частини клієнта: там порожній підпис означає
 * рисунок клієнта, який не вдалось перенести, і чужу картинку туди ставити не можна.
 * @returns {Array<{key, docId, secId, secLabel, num, name, caption, context}>}
 */
export function findPlaceholderFigures({ content, sections, lang, skipSectionIds = [] }) {
  const figWord = getLangLabels(lang).figWord;
  const skip = new Set(skipSectionIds || []);
  const out = [];
  const seen = new Set();
  for (const sec of sections || []) {
    if (skip.has(sec.id) || sec.type === "sources" || sec.id === "sources") continue;
    const text = content?.[sec.id];
    if (!text) continue;
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const cap = parseFigureCaption(lines[i], figWord);
      if (!cap || OWN_WORK_RE.test(cap.name) || cap.name.length > 200) continue;
      let j = i - 1;
      while (j >= 0 && !lines[j].trim()) j--;
      if (j >= 0 && isFigureSourceLine(lines[j].trim())) continue;
      const key = webImageKey(sec.id, cap.name);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        key, docId: webImageDocId(key), secId: sec.id, secLabel: sec.label,
        num: cap.num, name: cap.name, caption: lines[i].trim(),
        context: findFigureContext(lines, i, cap.num, figWord),
      });
      if (out.length >= WEB_IMAGES_MAX_PER_ORDER) return out;
    }
  }
  return out;
}

// Мова/країна пошуку Google Images — за мовою роботи, щоб підписи на картинках
// були тією ж мовою, що й текст.
// (getLangLabels().searchLocale — та сама таблиця мов, що й для плану/експорту; раніше тут
// була окрема без китайської, тож для китайської роботи шукало українською.)
function searchLocale(lang) {
  return getLangLabels(lang).searchLocale;
}

// Та сама схема обліку вартості, що в sourcesSearch.js: у воркері — onCost, у
// браузері — подія apicost для живого лічильника.
function reportCost(detail, onCost) {
  if (onCost) { onCost(detail); return; }
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("apicost", { detail }));
}

async function fetchCandidates(query, lang, exclude, onCost) {
  try {
    const res = await fetch(`${getApiBase()}/api/search-images`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await getProxyAuthHeaders()) },
      body: JSON.stringify({ query, ...searchLocale(lang), exclude }),
    });
    if (!res.ok) return [];
    const data = await res.json();
    if (data.searched) reportCost({ cost: 0.001, model: "serper", inTok: 1, outTok: 0 }, onCost);
    return Array.isArray(data.images) ? data.images.filter(c => c?.b64) : [];
  } catch {
    return [];
  }
}

const PICK_SYSTEM = "Ти — редактор ілюстрацій для академічних робіт. Відповідай лише валідним JSON без markdown.";

function buildPickPrompt({ topic, caption, context, count }) {
  return `Тема роботи: «${topic || ""}».
Рисунок у тексті: «${caption}».
${context ? `Абзац, що посилається на рисунок: «${context}».\n` : ""}
Вище — ${count} зображень-кандидатів з інтернету. Обери ОДНЕ, яке можна вставити в роботу як цей рисунок, або жодне.
Зображення підходить, лише якщо виконано ВСІ умови:
- показує саме те, що названо в підписі; якщо в підписі конкретна організація, місце, особа, пам'ятка, пристрій чи документ — саме їх, а не схожі;
- немає водяних знаків, логотипів фотобанків, рекламних написів чи цін;
- немає тексту російською мовою;
- це не мем, не скриншот сайту чи соцмережі, не колаж, не обкладинка книги чи відео з назвою;
- якість достатня для друку (не розмите, не дрібне, не обрізане).
Якщо підпис описує дані саме цієї роботи (результати опитування чи експерименту автора, показники досліджуваного підприємства за роки, авторську модель, розрахунки) — жодне зображення з інтернету не підходить, відповідай null.
Відповідь — лише JSON: {"choice": номер кандидата від 1 до ${count} або null, "reason": "коротко чому"}`;
}

async function chooseCandidate(fig, candidates, { topic, callClaude, onCost, signal }) {
  const content = [];
  candidates.forEach((c, i) => {
    content.push({ type: "text", text: `Кандидат ${i + 1}${c.domain ? ` (${c.domain})` : ""}:` });
    content.push({ type: "image", source: { type: "base64", media_type: c.type || "image/jpeg", data: c.b64 } });
  });
  content.push({ type: "text", text: buildPickPrompt({ topic, caption: fig.caption || fig.name, context: fig.context, count: candidates.length }) });
  const raw = await callClaude([{ role: "user", content }], signal || null, PICK_SYSTEM, 400, null, MODEL, onCost ? { onCost } : undefined);
  let parsed = {};
  try { parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || "{}"); } catch { /* нижче — як "жодне" */ }
  const n = Number(parsed.choice);
  const candidate = Number.isInteger(n) && n >= 1 && n <= candidates.length ? candidates[n - 1] : null;
  return { candidate, reason: String(parsed.reason || "") };
}

/**
 * Шукає й вибирає одне фото для рисунка (або слайда презентації).
 * fig — { name, caption?, context?, query? }; exclude — адреси картинок, які вже
 * пропонувались (кнопка "Інше" в UI).
 * @returns {Promise<{image: object|null, tried: string[], reason: string}>}
 */
export async function findWebImageForFigure(fig, { topic, lang, callClaude, onCost, signal, exclude = [] }) {
  const candidates = await fetchCandidates(fig.query || fig.name, lang, exclude, onCost);
  if (!candidates.length) return { image: null, tried: [], reason: "пошук нічого не дав" };
  const tried = candidates.map(c => c.url).filter(Boolean);
  const { candidate, reason } = await chooseCandidate(fig, candidates, { topic, callClaude, onCost, signal });
  if (!candidate) return { image: null, tried, reason: reason || "жоден кандидат не підійшов" };
  const { b64, type, width, height, url, page } = candidate;
  return { image: { b64, type: type || "image/jpeg", width, height, url: url || "", page: page || "" }, tried, reason };
}

/**
 * Пошук для кількох рисунків, по concurrency одночасно. Ніколи не кидає помилку:
 * збій одного рисунка — лише "не знайдено" для нього; перевищення ліміту вартості
 * (err.isCostLimit) зупиняє решту, уже знайдене лишається.
 * onResult(fig, result) — викликається щойно рисунок оброблено (для збереження по одному).
 * @returns {Promise<Array<{image, tried, reason}|null>>} null — рисунок не встигли обробити
 */
export async function findWebImages(figs, { concurrency = 2, onResult, ...opts }) {
  const results = new Array(figs.length).fill(null);
  let next = 0;
  let stop = false;
  const runOne = async () => {
    while (!stop && next < figs.length) {
      if (opts.signal?.aborted) { stop = true; return; }
      const idx = next++;
      try {
        results[idx] = await findWebImageForFigure(figs[idx], opts);
      } catch (e) {
        results[idx] = { image: null, tried: [], reason: e.message };
        if (e.isCostLimit || e.name === "AbortError") stop = true;
      }
      try { await onResult?.(figs[idx], results[idx]); } catch (e) { console.error("webImages onResult:", e.message); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, figs.length) }, runOne));
  return results;
}

// ── Презентації ──────────────────────────────────────────────────────────────
// Слот-заглушка — слайд-зображення без картинки (у .pptx це жовтий блок "Додайте
// зображення" з підписом): ні фото замовника, ні схеми туди не підставилось.
// Слайди в Firestore не змінюються — знайдене фото лежить в orders/{id}/webImages під
// ключем за підписом блоку, а підставляє його resolveSlideWebImages() перед експортом
// (base64 у самих слайдах переповнив би документ замовлення).
const isImageSlot = (sl) => sl?.layout === "image_placeholder" || (sl?.layout === "two_column" && sl?.right_type === "image");

function slotLabel(sl) {
  const label = typeof sl.image === "string" ? sl.image : sl.layout === "two_column" ? sl.right : "";
  return String(label || sl.title || "").trim();
}

export function slideWebImageKey(label) {
  return `slides::${normalizeCaptionName(label)}`;
}

export function findSlideImageSlots(slides) {
  const out = [];
  const seen = new Set();
  for (const sl of slides || []) {
    if (!isImageSlot(sl) || sl.image?.b64 || sl.image?.webImageKey) continue;
    const label = slotLabel(sl);
    const key = label && slideWebImageKey(label);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({
      key, docId: webImageDocId(key), secId: "slides", secLabel: sl.title || "", name: label, caption: label,
      context: [sl.title, sl.content, sl.left].filter(v => typeof v === "string" && v.trim()).join(". ").slice(0, 700),
    });
    if (out.length >= WEB_IMAGES_MAX_PER_ORDER) break;
  }
  return out;
}

// Слайди-ілюстрації для презентації до захисту: фото, знайдені для рисунків роботи,
// окремими слайдами (як ілюстрації клієнта). У слайді — лише посилання на фото.
export function buildWebImageSlides(figs, webImages) {
  return (figs || [])
    .filter(fig => (webImages || []).some(w => w.key === fig.key && w.b64))
    .map(fig => ({ layout: "image_placeholder", title: fig.name, image: { webImageKey: fig.key } }));
}

// Підставляє фото з webImages у слайди перед експортом .pptx: слоти-заглушки — за
// підписом блоку, слайди-ілюстрації роботи — за посиланням (якщо фото прибрали —
// такий слайд випадає, а слот лишається жовтою заглушкою з підписом).
export function resolveSlideWebImages(slideData, webImages) {
  if (!slideData?.slides?.length) return slideData;
  const byKey = new Map((webImages || []).filter(w => w?.key && w?.b64).map(w => [w.key, w]));
  const toImage = (rec) => ({ b64: rec.b64, type: rec.type || "image/jpeg" });
  const slides = slideData.slides.flatMap(sl => {
    const refKey = sl?.image?.webImageKey;
    if (refKey) {
      const rec = byKey.get(refKey);
      return rec ? [{ ...sl, image: toImage(rec) }] : [];
    }
    if (isImageSlot(sl) && !sl.image?.b64) {
      const label = slotLabel(sl);
      const rec = label ? byKey.get(slideWebImageKey(label)) : null;
      if (rec) return [{ ...sl, image: toImage(rec) }];
    }
    return [sl];
  });
  return { ...slideData, slides };
}

// Запис для orders/{id}/webImages/{docId} — з нього ж експорт бере картинку.
export function buildWebImageRecord(fig, found) {
  const { b64, type, width, height, url, page } = found.image;
  return {
    key: fig.key, secId: fig.secId, name: fig.name, caption: fig.caption,
    b64, type, width: width || null, height: height || null, url, page,
    tried: (found.tried || []).slice(0, 40), at: new Date().toISOString(),
  };
}
