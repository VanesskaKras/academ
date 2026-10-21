import { getLangLabels } from "./planUtils.js";

// ── Перевірка фактичного обсягу згенерованого тексту ──
// ШІ інколи недописує (чи навпаки перегинає) заданий обсяг. countWords рахує
// реальну кількість слів, enforceWordCount звіряє її з ціллю і за потреби
// робить ще один виклик — "допиши ще N слів" або "скороти до N слів".
//
// Китайський текст не ділиться пробілами на слова — без окремого підрахунку абзац у
// кілька сотень ієрогліфів рахувався б як одне "слово", і кожен підрозділ здавався б
// майже порожнім (система просила "дописати" вдвічі більше). Ієрогліфи рахуємо як
// частку слова: сторінка (14 пт, інтервал 1,5, поля 30/15/20/20 мм) вміщує ~995
// ієрогліфів проти ~272 українських слів, тож 1 "слово" обсягу ≈ 3,5 ієрогліфа —
// та сама ціль "230 слів = сторінка" дає однакову заповненість сторінки.
export const CJK_CHARS_PER_WORD = 3.5;
const CJK_CHAR_RE = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/g;

export function countWords(text) {
  const cjk = (text.match(CJK_CHAR_RE) || []).length;
  if (!cjk) return text.trim().split(/\s+/).filter(Boolean).length;
  const restWords = text.replace(CJK_CHAR_RE, " ").trim().split(/\s+/).filter(t => /[\p{L}\p{N}]/u.test(t)).length;
  return restWords + Math.round(cjk / CJK_CHARS_PER_WORD);
}

// Прибирає довге тире "—" на всякий випадок (модель іноді ігнорує заборону
// з промпту) — центральна версія патерну, що раніше дублювався по файлах.
export function stripEmDash(text) {
  return (text || "").replace(/ — /g, ", ").replace(/— /g, " ").replace(/ —/g, " ");
}

// Кінець речення: крапка/!/?/… (можливо перед закриваючою лапкою/дужкою),
// після якого йде пробіл або кінець тексту.
const SENTENCE_END_RE = /[.!?…]+[»"'）)\]]*(?=\s|$)/g;

// Якщо в тексті непарна кількість ``` — останній fence не закрився (генерація
// обірвалась посеред коду plantuml-діаграми через ліміт токенів). У такому разі
// прибираємо весь незавершений блок від його відкриваючого маркера й далі: код
// діаграми часто містить крапки/знаки оклику (в підписах стрілок на кшталт
// "Alice -> Bob: Готово."), тож "останнє речення" всередині нього — не справжня
// межа речення, а випадковий збіг.
function stripUnterminatedFence(text) {
  const fences = [...text.matchAll(/```/g)];
  if (fences.length % 2 !== 1) return text;
  const lastOpenIdx = fences[fences.length - 1].index;
  return text.slice(0, lastOpenIdx).replace(/\s+$/, "");
}

// Відрізає незавершений "хвіст" в кінці тексту (обрив ШІ посеред речення
// через ліміт токенів) — повертає текст по останню знайдену межу речення.
// Якщо в тексті взагалі немає завершеного речення - повертає як є (нема куди різати).
export function cutToLastSentence(text) {
  const trimmed = stripUnterminatedFence((text || "").replace(/\s+$/, ""));
  let lastEnd = -1;
  SENTENCE_END_RE.lastIndex = 0;
  let m;
  while ((m = SENTENCE_END_RE.exec(trimmed))) {
    lastEnd = m.index + m[0].length;
  }
  if (lastEnd === -1 || lastEnd === trimmed.length) return trimmed;
  return trimmed.slice(0, lastEnd).trim();
}

function endsWithSentence(text) {
  const raw = (text || "").replace(/\s+$/, "");
  const trimmed = stripUnterminatedFence(raw);
  if (trimmed !== raw) return false; // незавершений fence - точно не коректний кінець
  if (!trimmed) return true;
  let lastEnd = -1;
  SENTENCE_END_RE.lastIndex = 0;
  let m;
  while ((m = SENTENCE_END_RE.exec(trimmed))) lastEnd = m.index + m[0].length;
  return lastEnd === trimmed.length;
}

export async function enforceWordCount({ text, targetWords, label, callClaude, sys, signal, onProgress, clean, cacheOpts, styleNote }) {
  const n = countWords(text);
  try {
    if (n < targetWords * 0.85) {
      const missing = targetWords - n;
      onProgress?.(`Дописую: ${label}...`);
      const contPrompt = `Ось поточний текст "${label}" (${n} слів):\n\n${text}\n\nДопиши ще приблизно ${missing} слів, органічно продовжуючи виклад далі. Не повторюй вже написане. Якщо наведений текст закінчується таблицею (рядки з "|") чи підписом рисунка/таблиці — категорично НЕ повторюй, не переказуй і не перефразовуй ці дані чи підпис у своєму продовженні; почни одразу з нового змістовного речення, що аналізує чи розвиває тему далі, не називаючи знову ті самі цифри в табличному вигляді. Не додавай вступних фраз на кшталт "Продовжимо" чи "Отже". Просто продовжуй текст з того місця де він закінчився, без заголовків і міток.${styleNote ? `\n\n${styleNote}` : ""}`;
      const contRaw = await callClaude([{ role: "user", content: contPrompt }], signal, sys, Math.min(20000, Math.max(2000, Math.round(missing * 3))), null, undefined, cacheOpts);
      let contClean = (clean ? clean(contRaw) : contRaw).trim();
      if (!endsWithSentence(contClean)) contClean = cutToLastSentence(contClean);
      return text + "\n\n" + contClean;
    }
    if (n > targetWords * 1.2) {
      onProgress?.(`Скорочую: ${label}...`);
      const shortenPrompt = `Ось поточний текст "${label}" (${n} слів, а потрібно приблизно ${targetWords}):\n\n${text}\n\nСкороти цей текст приблизно до ${targetWords} слів: прибери повтори, зайві деталі й другорядні речення, але збережи логічну цілісність викладу, усі цифри й факти, посилання на джерела у форматі [N] та рисунки/таблиці без змін. Не додавай вступних фраз на кшталт "Ось скорочений варіант". Поверни лише скорочений текст розділу, без заголовків і міток.`;
      const shortRaw = await callClaude([{ role: "user", content: shortenPrompt }], signal, sys, Math.min(20000, Math.max(2000, Math.round(targetWords * 3))), null, undefined, cacheOpts);
      let shortClean = (clean ? clean(shortRaw) : shortRaw).trim();
      if (!endsWithSentence(shortClean)) shortClean = cutToLastSentence(shortClean);
      return shortClean;
    }
  } catch {
    // Якщо допис не вдався - лишаємо початковий текст як є
  }
  // Обсяг у прийнятних межах (85-120% цілі), тож жодна з гілок вище не спрацювала —
  // але текст все одно міг обірватись посеред речення (модель зупинилась невдало,
  // не через нестачу слів і не через ліміт токенів). Ріжемо по останній завершеній
  // межі речення незалежно від обсягу, а не лише в гілках "задовго"/"закоротко".
  return endsWithSentence(text) ? text : cutToLastSentence(text);
}

const PLANTUML_FENCE_RE = /^```\s*plantuml\s*$/i;

// Розбиває текст на блоки-рядки: звичайний абзац (у сховищі кожен абзац — один
// рядок), markdown-таблиця чи plantuml-схема (кожна — суцільний неподільний
// блок з кількох рядків) і порожні рядки-роздільники. Той самий поділ, що й
// pageLayout.js використовує для підрахунку сторінок, тож "абзац" тут завжди
// збігається з тим, що реально побачить читач як окрему одиницю тексту.
function splitIntoLineBlocks(text) {
  const lines = text.split("\n");
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const trimmed = lines[i].trim();
    if (!trimmed) { blocks.push({ type: "blank", lines: [lines[i]] }); i++; continue; }
    if (trimmed.startsWith("|")) {
      const start = i;
      while (i < lines.length && lines[i].trim().startsWith("|")) i++;
      blocks.push({ type: "table", lines: lines.slice(start, i) });
      continue;
    }
    if (PLANTUML_FENCE_RE.test(trimmed)) {
      const start = i;
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i].trim())) i++;
      i = Math.min(i + 1, lines.length);
      blocks.push({ type: "plantuml", lines: lines.slice(start, i) });
      continue;
    }
    blocks.push({ type: "para", lines: [lines[i]], words: countWords(trimmed) });
    i++;
  }
  return blocks;
}

// Скорочує текст, прибираючи цілі абзаци з КІНЦЯ — ніколи не всередині абзацу
// й ніколи не перетинаючи таблицю/plantuml-блок (вони — тверда межа: якщо
// скорочення до них доходить, зупиняється, не займаючи їх). Раніше скорочення
// різало по межі речення й могло лишити абзац із тезою, але без розвитку думки
// чи висновку — саме завершальні речення й зрізались, тож абзац "провисав".
// Прибираючи абзац цілком, такого розриву логіки всередині абзацу вже не буде.
// Завжди лишає хоч один абзац — підрозділ ніколи не спорожняється повністю.
//
// Той самий підпис/абзац-підсумок, який fixMissingTableConclusion/fixDanglingFigures
// (figureFixup.js) домальовують одразу після таблиці чи рисунка, тут теж захищено:
// якщо прибирання абзацу лишило б розділ закінченим "голою" таблицею, plantuml-схемою
// чи підписом рисунка/таблиці без інтерпретації — зупиняємось, не чіпаючи його, так
// само як не чіпаємо саму таблицю/схему.
export function trimTrailingParagraphs(text, wordsToCut, lang) {
  if (wordsToCut <= 0) return text;
  const blocks = splitIntoLineBlocks(text);
  const paraCount = blocks.filter(b => b.type === "para").length;
  if (paraCount <= 1) return text;

  const { tableWord, figWord } = getLangLabels(lang);
  const captionRe = new RegExp(`^(${tableWord}|${figWord.replace(/\./g, "\\.")})\\s*\\d+(\\.\\d+)?\\s*[–-]`, "i");
  // Чи стане непокритим (голим) блок, що йде прямо перед позицією i, якщо абзац
  // на позиції i прибрати — тобто чи є він таблицею/схемою/підписом без висновку.
  const wouldDangle = (i) => {
    for (let j = i - 1; j >= 0; j--) {
      const b = blocks[j];
      if (b.type === "blank") continue;
      if (b.type === "table" || b.type === "plantuml") return true;
      if (b.type === "para") return captionRe.test(b.lines[0].trim());
      return false;
    }
    return false;
  };

  let cut = 0;
  let removedParas = 0;
  let keptUntil = blocks.length;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b.type === "table" || b.type === "plantuml") break;
    if (b.type === "para") {
      if (removedParas >= paraCount - 1) break;
      if (wouldDangle(i)) break;
      cut += b.words;
      removedParas++;
      keptUntil = i;
      if (cut >= wordsToCut) break;
    } else {
      keptUntil = i;
    }
  }
  if (cut === 0) return text;
  const kept = blocks.slice(0, keptUntil);
  while (kept.length && kept[kept.length - 1].type === "blank") kept.pop();
  return kept.map(b => b.lines.join("\n")).join("\n");
}

// ── Фінальна перевірка сумарного обсягу готової роботи ──
// enforceWordCount тримає в межах кожен підрозділ окремо (допуск 85-120%), а
// цитати "осиротілих" джерел довставляються (doRemapCitations/doFinalizeSources)
// вже ПІСЛЯ цієї перевірки, без повторного контролю обсягу. Разом ці допуски,
// помножені на десяток підрозділів, і додані цитати можуть дати сумарний обсяг
// усієї роботи за межами заданої к-сті сторінок, навіть якщо кожен підрозділ
// окремо формально пройшов перевірку. enforceTotalVolume рахує сумарний обсяг
// усіх переданих секцій і, якщо він вийшов за межі допуску (tolerance):
// - при перевищенні — скорочує кодом (trimTrailingParagraphs, цілими абзацами,
//   ніколи не всередині абзацу чи таблиці/схеми) найбільш "переповнені" відносно
//   власної цілі придатні підрозділи;
// - при нестачі — дописує ще одним викликом ШІ найбільші придатні підрозділи
//   (щоб додаток був якнайменш помітним відносно вже написаного обсягу).
// Службові секції (вступ/висновки/висновки до розділу/список джерел — див.
// isEligible) не займає: їх обсяг зазвичай суворо регламентований форматом.
export async function enforceTotalVolume({
  sections, content, targetWords, isEligible, tolerance = 0.05,
  callClaude, sys, signal, onProgress, clean, cacheOpts, lang,
}) {
  const updated = { ...content };
  const wordsOf = (id) => countWords(updated[id] || "");
  const total = () => sections.reduce((sum, s) => sum + wordsOf(s.id), 0);

  const upper = targetWords * (1 + tolerance);
  const lower = targetWords * (1 - tolerance);
  const currentTotal = total();
  if (currentTotal <= upper && currentTotal >= lower) return updated;

  const eligible = sections.filter(s => isEligible(s) && updated[s.id]);

  if (currentTotal > upper) {
    let excess = currentTotal - targetWords;
    for (let round = 0; round < 4 && excess > 0; round++) {
      const bySize = eligible
        .map(s => ({ s, words: wordsOf(s.id), ownTarget: Math.max(1, Number(s.pages || 1) * 230) }))
        .filter(x => x.words > x.ownTarget)
        .sort((a, b) => (b.words - b.ownTarget) - (a.words - a.ownTarget));
      if (!bySize.length) break;
      let cutThisRound = 0;
      for (const { s, words } of bySize) {
        if (excess <= 0) break;
        const wantCut = Math.min(Math.round(words * 0.25), excess);
        if (wantCut < 30) continue;
        onProgress?.(`Перевіряю обсяг: скорочую "${s.label}"...`);
        const before = wordsOf(s.id);
        updated[s.id] = trimTrailingParagraphs(updated[s.id], wantCut, lang);
        const actualCut = before - wordsOf(s.id);
        excess -= actualCut;
        cutThisRound += actualCut;
      }
      if (cutThisRound < 5) break;
    }
    return updated;
  }

  let deficit = targetWords - currentTotal;
  const targets = eligible
    .map(s => ({ s, words: wordsOf(s.id) }))
    .sort((a, b) => b.words - a.words)
    .slice(0, 2);
  for (const { s } of targets) {
    if (deficit < 30) break;
    const addWords = targets.length > 1 ? Math.round(deficit / targets.length) : deficit;
    onProgress?.(`Перевіряю обсяг: доповнюю "${s.label}"...`);
    try {
      const text = updated[s.id];
      const before = countWords(text);
      const contPrompt = `Ось поточний текст "${s.label}" (${before} слів):\n\n${text}\n\nДопиши ще приблизно ${addWords} слів, органічно продовжуючи виклад далі. Не повторюй вже написане. Якщо наведений текст закінчується таблицею (рядки з "|") чи підписом рисунка/таблиці — категорично НЕ повторюй, не переказуй і не перефразовуй ці дані чи підпис у своєму продовженні; почни одразу з нового змістовного речення, що аналізує чи розвиває тему далі, не називаючи знову ті самі цифри в табличному вигляді. Не додавай вступних фраз на кшталт "Продовжимо" чи "Отже". Просто продовжуй текст з того місця де він закінчився, без заголовків і міток.`;
      const raw = await callClaude([{ role: "user", content: contPrompt }], signal, sys, Math.min(20000, Math.max(2000, Math.round(addWords * 3))), null, undefined, cacheOpts);
      let contClean = (clean ? clean(raw) : raw).trim();
      if (!endsWithSentence(contClean)) contClean = cutToLastSentence(contClean);
      updated[s.id] = text + "\n\n" + contClean;
      deficit -= (countWords(updated[s.id]) - before);
    } catch {
      // якщо дописати не вдалось - лишаємо як є, наступний придатний підрозділ спробує компенсувати
    }
  }
  return updated;
}
