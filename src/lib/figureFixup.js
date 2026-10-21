import { findDanglingFigureRefs, getLangLabels } from "./planUtils.js";
import { buildFigureInsertPrompt } from "./prompts.js";
import { locateFragment } from "./textFragmentLocate.js";

// Спільна для academic-assistant.jsx, small-works.jsx і PracticePage.jsx (яка має свою
// локальну копію старшу за цей файл) добудова рисунків, які ШІ згадала в тексті ("...показано
// на Рис. X.Y"), але так і не намалювала (ні plantuml-блоку, ні таблиці з підписом) — типово
// тому, що модель обрала "запасний" варіант з FIGURES-правил промпту (голий підпис-плейсхолдер)
// замість того, щоб намалювати PlantUML-схему. findDanglingFigureRefs (planUtils.js) знаходить
// такі місця кодом; ця функція для kind:"missing" точково домальовує PlantUML-схему одним
// пакетним запитом, а для kind:"misplaced" (рисунок є, але задалеко від посилання) просто
// переносить блок кодом, без звернення до ШІ.
// Прибирає повторний рисунок з тим самим номером ("Рис. N"). Трапляється у двох формах:
// 1) при генерації частинами (CHUNK_PAGES у smallStages.js/small-works.jsx) — модель отримує
//    весь попередній текст і має "не повторювати вже написане", але біля межі частин іноді
//    все одно повторює останню таблицю+підпис рисунка, часто в трохи іншому, "покаліченому"
//    форматуванні, яке пізніше resolveDiagrams (exportDocx.js) не розпізнає як таблицю;
// 2) модель пише "голий" підпис одразу після речення-посилання ("...показано на Рис. N."),
//    а сам рисунок (таблицю даних чи plantuml-блок, що стає картинкою) додає окремо, за текстом
//    (кейс 2026-09-23) — тут порядок протилежний: перше входження "голе", друге — справжнє.
// Чисто кодова перевірка (без ШІ): для кожного номера знаходимо входження підпису, що йде
// одразу за таблицею даних чи ```plantuml```-блоком (з можливими порожніми рядками між ними),
// і лишаємо ПЕРШЕ таке "справжнє" входження як є; усі інші входження (і "голі" підписи без
// рисунка, і зайві повторні блоки з рисунком) прибираємо разом з їхнім рисунком-джерелом.
function findFigureBlockStart(lines, capIdx) {
  let j = capIdx - 1;
  while (j >= 0 && !lines[j].trim()) j--;
  if (j < 0) return { start: capIdx, hasBlock: false };
  if (lines[j].trim() === "```") {
    let k = j - 1;
    while (k >= 0 && !/^```/.test(lines[k].trim())) k--;
    return k >= 0 ? { start: k, hasBlock: true } : { start: capIdx, hasBlock: false };
  }
  if (lines[j].includes("|")) {
    // Рядки таблиці-джерела можуть бути розділені порожніми рядками (модель іноді пише
    // "покалічену" таблицю кожним рядком окремим абзацом) — відкочуємось назад через
    // порожні рядки теж, але зупиняємось на першому рядку без "|" (справжня проза).
    let lastPipe = j;
    let p = j - 1;
    while (p >= 0) {
      if (lines[p].includes("|")) { lastPipe = p; p--; continue; }
      if (!lines[p].trim()) { p--; continue; }
      break;
    }
    return { start: lastPipe, hasBlock: true };
  }
  return { start: capIdx, hasBlock: false };
}

export function dedupeRepeatedFigures(text, lang) {
  if (!text) return text;
  const figWord = getLangLabels(lang).figWord;
  const fwEsc = figWord.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const CAP_RE = new RegExp(`^${fwEsc}\\s*(\\d+(?:\\.\\d+)?)\\s*[–-]`, "i");
  const lines = text.split("\n");
  const byNum = new Map();
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].trim().match(CAP_RE);
    if (!m) continue;
    const num = m[1];
    const info = findFigureBlockStart(lines, i);
    const list = byNum.get(num) || [];
    list.push({ i, ...info });
    byNum.set(num, list);
  }
  const toRemove = new Set();
  for (const occurrences of byNum.values()) {
    if (occurrences.length < 2) continue;
    const keepIdx = occurrences.findIndex(o => o.hasBlock);
    const keep = keepIdx === -1 ? 0 : keepIdx;
    occurrences.forEach((o, idx) => {
      if (idx === keep) return;
      for (let k = o.start; k <= o.i; k++) toRemove.add(k);
    });
  }
  if (!toRemove.size) return text;
  return lines.filter((_, idx) => !toRemove.has(idx)).join("\n").replace(/\n{3,}/g, "\n\n");
}

export async function fixDanglingFigures({ text, lang, callClaude, signal }) {
  const figWord = getLangLabels(lang).figWord;
  const dangling = findDanglingFigureRefs(text, figWord);
  if (!dangling.length) return text;

  let fixed = text;
  const misplaced = dangling.filter(d => d.kind === "misplaced").sort((a, b) => b.blockStart - a.blockStart);
  misplaced.forEach(d => {
    const blockText = fixed.slice(d.blockStart, d.blockEnd).trim();
    const before = fixed.slice(0, d.blockStart).replace(/\n{3,}$/, "\n\n");
    const after = fixed.slice(d.blockEnd).replace(/^\n{3,}/, "\n\n");
    const withoutBlock = before + after;
    const loc = locateFragment(withoutBlock, d.sentence, null);
    if (!loc) return; // не знайшли, куди переносити — лишаємо блок на місці, не втрачаємо рисунок
    fixed = withoutBlock.slice(0, loc.end) + "\n\n" + blockText + "\n" + withoutBlock.slice(loc.end);
  });

  const missing = dangling.filter(d => d.kind === "missing");
  if (!missing.length) return fixed;

  let raw;
  try {
    raw = await callClaude(
      [{ role: "user", content: buildFigureInsertPrompt({ sectionText: fixed, dangling: missing, lang }) }],
      signal || null, "Ти — редактор академічного тексту. Повертай лише JSON, без пояснень.", 4000,
    );
  } catch (e) {
    console.error("fixDanglingFigures error:", e.message);
    raw = null;
  }
  let parsed = [];
  try {
    const m = raw?.match(/\[[\s\S]*\]/);
    parsed = m ? JSON.parse(m[0]) : [];
  } catch { /* нижче — фолбек: прибираємо речення без рисунка */ }

  missing.forEach((d, i) => {
    const loc = locateFragment(fixed, d.sentence, null);
    if (!loc) return;
    const item = parsed.find(p => p.index === i);
    if (item?.feasible && item?.plantuml) {
      const caption = item.caption?.trim() || `${figWord} ${d.number}`;
      const block = `\n\n\`\`\`plantuml\n${item.plantuml.trim()}\n\`\`\`\n${caption}`;
      fixed = fixed.slice(0, loc.end) + block + fixed.slice(loc.end);
    } else {
      // Модель визнала рисунок недоречним, чи відповідь не розпарсилась — прибираємо саме
      // речення-посилання, щоб текст не посилався на схему, якої так і не буде.
      const before = fixed.slice(0, loc.start).replace(/\s+$/, "");
      const after = fixed.slice(loc.end).replace(/^\s+/, "");
      fixed = before + (before && after ? " " : "") + after;
    }
  });
  return fixed;
}

// Розділ/підрозділ не може закінчуватись рядком таблиці чи підписом рисунка без
// абзацу-висновку після — методичка (та й здоровий глузд академічного письма)
// вимагає, щоб автор інтерпретував наведені дані, а не просто лишив їх "голими".
// Текстова інструкція в промпті ("Завершуй підсумковим реченням") не завжди
// дотримується моделлю буквально для цього випадку (таблиця сама по собі —
// вже "не обірваний" текст), тому тут — код-рівнева перевірка й добудова
// пропущеного абзацу, за тим самим принципом, що й fixDanglingFigures вище.
export async function fixMissingTableConclusion({ text, lang, callClaude, signal }) {
  const { tableWord, figWord } = getLangLabels(lang);
  const trimmed = text.replace(/\s+$/, "");
  const lines = trimmed.split("\n").map(l => l.trim()).filter(Boolean);
  const lastLine = lines[lines.length - 1] || "";
  const isTableRow = /^\|.*\|$/.test(lastLine);
  const captionRe = new RegExp(`^(${tableWord}|${figWord})\\s*\\d+(\\.\\d+)?\\s*[–-]`, "i");
  const isCaption = captionRe.test(lastLine);
  if (!isTableRow && !isCaption) return text;

  const prompt = `Ось кінець розділу академічної роботи — він закінчується таблицею або рисунком без абзацу-висновку після:

${trimmed.slice(-2000)}

Напиши ОДИН короткий абзац (3-5 речень) мовою цього тексту, який інтерпретує наведені вище дані й підсумовує розгляд матеріалу. Без markdown, без цитат на джерела, без жирного. Поверни ЛИШЕ текст цього абзацу, без пояснень і без повторення попереднього тексту.`;

  try {
    const raw = await callClaude([{ role: "user", content: prompt }], signal || null, "Ти — редактор академічного тексту.", 800);
    const paragraph = raw?.trim();
    if (!paragraph) return text;
    return `${trimmed}\n\n${paragraph}`;
  } catch (e) {
    console.error("fixMissingTableConclusion error:", e.message);
    return text;
  }
}
