import { requireAuth } from "./_auth.js";
// Проксі для DOAJ (Directory of Open Access Journals) — публічний API без ключа,
// але без гарантованого CORS у браузері
export const config = { maxDuration: 15 };

function withTimeout(promise, ms = 10000) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    return res.status(200).end();
  }
  if (req.method !== 'POST') return res.status(405).end();
  // закрито тим самим токеном, що /api/gemini і /api/claude: відкритий адрес дозволяв будь-кому
  // палити кредити Serper/квоти Books/CORE та ходити через fetch-meta (22.09.2026)
  if (!(await requireAuth(req, res))) return;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  try {
    const { query = '', limit = 10 } = req.body || {};
    if (!query.trim()) return res.status(200).json({ results: [] });

    const url = `https://doaj.org/api/search/articles/${encodeURIComponent(query)}?pageSize=${limit}`;
    const r = await withTimeout(fetch(url, { cache: 'no-store' }));
    if (!r.ok) return res.status(200).json({ results: [] });
    const data = await r.json();
    return res.status(200).json({ results: data.results || [] });
  } catch (e) {
    console.error('search-doaj error:', e.message);
    return res.status(200).json({ results: [] });
  }
}
