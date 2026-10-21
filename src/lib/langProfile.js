// Набір мовних підписів для мови роботи, якої немає в таблиці getLangLabels (planUtils.js):
// заголовки (ВСТУП/РОЗДІЛ/ВИСНОВКИ…), підписи таблиць і рисунків, слово "додаток", лапки,
// код мови для пошуку джерел і правопису Word тощо. ШІ складає його ОДИН раз на замовлення,
// код перевіряє (sanitizeLangProfile) і реєструє (registerLangProfile), а замовлення зберігає
// в info.langProfile — далі все працює кодом, так само як для вбудованих мов.
import { MODEL_FAST } from "./api.js";
import { detectLangCode, sanitizeLangProfile, registerLangProfile, hasLangProfileFor } from "./planUtils.js";
import { buildLangProfilePrompt } from "./prompts.js";

// Повертає новий набір (уже зареєстрований), якщо мова поза таблицею й набору саме для неї ще
// немає; інакше null (зареєструвавши вже збережений). Помилка ШІ не зупиняє замовлення:
// лишається нейтральний англійський варіант, як і було до появи наборів.
export async function ensureLangProfile(info, callClaude, { signal, onCost } = {}) {
  if (!info?.language || detectLangCode(info.language) !== "other") return null;
  if (hasLangProfileFor(info)) {
    registerLangProfile(info);
    return null;
  }
  try {
    const raw = await callClaude(
      [{ role: "user", content: buildLangProfilePrompt(info.language) }],
      signal, "Respond only with valid JSON. No markdown.", 3000, null, MODEL_FAST, { onCost },
    );
    const profile = sanitizeLangProfile(JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || raw), info.language);
    if (!profile) return null;
    registerLangProfile({ ...info, langProfile: profile });
    return profile;
  } catch (e) {
    console.warn("ensureLangProfile:", e.message);
    return null;
  }
}

// Те саме для патча аналізу: info з доданим набором або без змін
export async function withLangProfile(info, callClaude, opts) {
  const profile = await ensureLangProfile(info, callClaude, opts);
  return profile ? { ...info, langProfile: profile } : info;
}
