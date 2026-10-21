// Браузерна половина наборів мов поза таблицею (langProfile.js): реєструє збережений набір
// замовлення й, якщо мову змінили вручну і набору для неї ще немає, просить ШІ його скласти.
// Воркер робить те саме в loadOrder (worker/firestoreAdmin.js) і в етапах аналізу.
import { useEffect } from "react";
import { registerLangProfile } from "./planUtils.js";
import { ensureLangProfile } from "./langProfile.js";

// Затримка, щоб не складати набір на кожну літеру, поки мову вводять вручну
const LANG_PROFILE_DEBOUNCE_MS = 2000;

export function useLangProfile({ language, langProfile, onProfile, callClaude }) {
  // Реєстрація — одразу під час рендеру, до того як компонент викличе getLangLabels
  // (повторна реєстрація того самого набору нічого не змінює)
  if (language && langProfile) registerLangProfile({ language, langProfile });

  useEffect(() => {
    if (!language || language.trim().length < 4) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      ensureLangProfile({ language, langProfile }, callClaude).then(profile => {
        if (!cancelled && profile) onProfile(profile);
      });
    }, LANG_PROFILE_DEBOUNCE_MS);
    return () => { cancelled = true; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [language, langProfile?.forLanguage]);
}
