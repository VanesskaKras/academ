// ─────────────────────────────────────────────
// documentAdaptation.js — правка, що стосується ВСІЄЇ роботи ("переробити під
// ЗДО, а не школу"). На відміну від фрагментних правок (ШІ вибирає окремі місця
// й покриває лише частину тексту), тут код сам проходить УСІ абзаци документа
// (разом із комірками таблиць) порціями, і ШІ вирішує по кожному абзацу окремо.
// Кожен змінений абзац переписується через setParagraphText (структура таблиць,
// стилі, колонтитули лишаються недоторканими; markEdits — підсвітка правки).
// Другий прохід — кодова перевірка: абзаци, де ще лишились слова старого
// контексту (корені від ШІ + regex), перевіряються повторно; що лишилось після
// цього — повертається в leftover, щоб звіт не мовчав про недороблене.
// Список джерел не переписується (назви джерел не можна змінювати) — лише
// повідомляється, які записи лишились із старим контекстом.
// ─────────────────────────────────────────────
import { MODEL, MODEL_FAST } from "./api.js";
import { SYS_JSON, buildSYS, buildAdaptationStemsPrompt, buildAdaptationChunkPrompt } from "./prompts.js";
import { stripEmDash } from "./wordCount.js";
import { getParagraphs, paragraphTextMap, setParagraphText, paragraphInfo } from "./docxSurgicalEdit.js";
import { locateSourcesZone } from "./citationFormatting.js";

const CHUNK_MAX_CHARS = 9000;
const CHUNK_MAX_PARAS = 25;

// Ознаки "переробити всю роботу під інший контекст" у тексті зауваження.
const ADAPTATION_HINT_RE = /перероб\w*\s+(?:\S+\s+){0,4}під\s|адаптуй|адаптувати|адаптаці|переорієнту|а\s+не\s+(?:для\s+|у\s+|в\s+)?(?:школ|універс|вуз)/i;

export function isAdaptationTask(task) {
  const text = [task.instruction, task.noteText, task.issue, task.suggestion].filter(Boolean).join(" ");
  return ADAPTATION_HINT_RE.test(text);
}

const citationsOf = s => (s.match(/\[[^\[\]]*\d[^\[\]]*\]/g) || []).join("|");
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function parseJson(raw) {
  return JSON.parse(String(raw).replace(/```json|```/g, "").trim());
}

// Перевірка відповіді ШІ по абзацу: не приймаємо те, що може зіпсувати документ.
function acceptableText(original, text) {
  if (typeof text !== "string") return false;
  const t = text.trim();
  if (!t || /[\r\n]/.test(t)) return false;
  if (/^\s*\|.*\|\s*$/.test(t) || /^#{1,6}\s/.test(t)) return false;
  if (citationsOf(original) !== citationsOf(t)) return false;
  const lo = original.length * 0.4, hi = original.length * 2.2;
  return original.length < 40 || (t.length >= lo && t.length <= hi);
}

/**
 * @param {{docXml: object, instruction: string, lang?: string, methodInfo?: object, markEdits?: boolean}} input
 * @param {{callClaude: Function, onProgress?: Function}} ctx
 * @returns {Promise<{changedCount:number, rejected:number, leftover:Array<{index:number, snippet:string, inSources:boolean}>, changes:Array}>}
 */
export async function adaptDocumentParagraphs({ docXml, instruction, lang = "Українська", methodInfo = null, markEdits = false }, ctx) {
  const { callClaude, onProgress = () => {} } = ctx;
  const sys = buildSYS(lang, methodInfo) + "\n\nВідповідай ЛИШЕ JSON, як описано вище. Без markdown, без пояснень поза ним.";
  const paras = getParagraphs(docXml);
  const texts = () => paras.map(p => paragraphTextMap(p).text);

  // Межі списку джерел у координатах абзаців — його не переписуємо.
  const sourcesParaSet = new Set();
  {
    const all = texts();
    const zone = locateSourcesZone(all.join("\n"));
    if (zone) {
      let pos = 0;
      all.forEach((t, i) => {
        if (pos >= zone.sourcesStart && pos < zone.sourcesEnd) sourcesParaSet.add(i);
        pos += t.length + 1;
      });
    }
  }

  let stemRe = null;
  try {
    const raw = await callClaude([{ role: "user", content: buildAdaptationStemsPrompt({ instruction }) }], null, SYS_JSON, 600, null, MODEL_FAST);
    const stems = (parseJson(raw).stems || []).map(s => String(s).trim().toLowerCase()).filter(s => s.length >= 3);
    if (stems.length) stemRe = { stems, re: new RegExp(stems.map(escapeRe).join("|"), "i") };
  } catch { /* без другого проходу — лишається перший */ }

  const changes = [];
  let rejected = 0;
  const changedIdx = new Set();

  async function runPass(indices, label, recheckStems) {
    const chunks = [];
    let cur = [], size = 0;
    for (const i of indices) {
      const text = paragraphTextMap(paras[i]).text;
      if (cur.length && (size + text.length > CHUNK_MAX_CHARS || cur.length >= CHUNK_MAX_PARAS)) { chunks.push(cur); cur = []; size = 0; }
      cur.push({ i, text, inTable: paragraphInfo(paras[i]).inTable });
      size += text.length;
    }
    if (cur.length) chunks.push(cur);

    let n = 0;
    for (const chunk of chunks) {
      n++;
      onProgress(`${label}: частина ${n} з ${chunks.length}`);
      let items;
      try {
        const raw = await callClaude(
          [{ role: "user", content: buildAdaptationChunkPrompt({ instruction, paragraphs: chunk, recheckStems }) }],
          null, sys, Math.min(60000, Math.max(6000, Math.round(size / 1.2))), null, MODEL, { cache: true }
        );
        items = parseJson(raw);
        if (!Array.isArray(items)) throw new Error("не масив");
      } catch (e) {
        if (e?.isCostLimit) throw e;
        rejected += chunk.length; // порція не розпарсилась — її абзаци лишаються як були, їх підхопить leftover
        continue;
      }
      for (const it of items) {
        const item = chunk.find(c => c.i === it?.i);
        if (!item) continue;
        const newText = stripEmDash(String(it.text ?? "")).trim();
        if (!acceptableText(item.text, newText)) { rejected++; continue; }
        if (newText === item.text.trim()) continue;
        setParagraphText(paras[item.i], newText, markEdits);
        changedIdx.add(item.i);
        changes.push({ label: "Адаптація тексту", original: item.text, replacement: newText });
      }
    }
  }

  const eligible = i => !sourcesParaSet.has(i) && paragraphTextMap(paras[i]).text.trim().length >= 2;
  await runPass(paras.map((_, i) => i).filter(eligible), "Переробка абзаців", null);

  if (stemRe) {
    const again = paras.map((_, i) => i).filter(i => eligible(i) && stemRe.re.test(paragraphTextMap(paras[i]).text));
    if (again.length) await runPass(again, "Повторна перевірка залишків", stemRe.stems);
  }

  const leftover = [];
  if (stemRe) {
    texts().forEach((t, i) => {
      const m = t.match(stemRe.re);
      if (m) leftover.push({ index: i, snippet: t.slice(Math.max(0, m.index - 30), m.index + 50), inSources: sourcesParaSet.has(i) });
    });
  }
  return { changedCount: changedIdx.size, rejected, leftover, changes };
}
