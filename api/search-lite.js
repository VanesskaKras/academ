// Одна серверна функція на три легкі пошуки (CORE, DOAJ, Google Books). Vercel Hobby дозволяє не більше
// 12 функцій на деплой; після search-images їх стало 13 і прод перестав оновлюватись (28.09.2026).
// Адреси для клієнтів ті самі: /api/search-core, /api/search-doaj, /api/search-books → rewrites у vercel.json.
import core from "./_searchCore.js";
import doaj from "./_searchDoaj.js";
import books from "./_searchBooks.js";

export const config = { maxDuration: 15 };

const HANDLERS = { core, doaj, books };

export default async function handler(req, res) {
  const kind = String(req.query?.kind || "");
  const h = HANDLERS[kind];
  if (!h) return res.status(404).json({ error: "unknown search kind" });
  return h(req, res);
}
