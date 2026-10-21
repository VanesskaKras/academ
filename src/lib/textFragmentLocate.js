// ─────────────────────────────────────────────
// Пошук фрагмента для заміни: дослівно → в межах абзаца-контексту (рятує, якщо
// той самий рядок трапляється в тексті кілька разів) → гнучкий regex, що ігнорує
// різницю в пробілах/лапках/тире (рятує, коли ШІ трохи розходиться з оригіналом
// у пунктуації). Якщо нічого не знайдено — повертає null, і виклик має це
// показати користувачу, а не мовчки пропустити завдання.
// ─────────────────────────────────────────────
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildFuzzyPattern(str) {
  return escapeRegex(str.trim())
    .replace(/\s+/g, "\\s+")
    .replace(/["""«»]/g, "[\"“”«»]")
    .replace(/['''`]/g, "['‘’`]")
    .replace(/[-–—]/g, "[-–—]");
}

export function locateFragment(text, original, context) {
  if (!original) return null;
  if (context && text.includes(context)) {
    const ctxStart = text.indexOf(context);
    const localIdx = context.indexOf(original);
    if (localIdx !== -1) return { start: ctxStart + localIdx, end: ctxStart + localIdx + original.length };
    try {
      const m = context.match(new RegExp(buildFuzzyPattern(original)));
      if (m) {
        const idx = ctxStart + context.indexOf(m[0]);
        return { start: idx, end: idx + m[0].length };
      }
    } catch { /* некоректний патерн — пробуємо далі по всьому тексту */ }
  }
  const exactIdx = text.indexOf(original);
  if (exactIdx !== -1) return { start: exactIdx, end: exactIdx + original.length };
  try {
    const m = text.match(new RegExp(buildFuzzyPattern(original)));
    if (m) return { start: m.index, end: m.index + m[0].length };
  } catch { /* некоректний regex-патерн з фрагмента */ }
  return null;
}
