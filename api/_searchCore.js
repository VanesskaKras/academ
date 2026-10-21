import { requireAuth } from "./_auth.js";
// Серверна функція для CORE.ac.uk (немає CORS у браузері — проксимо тут)
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

  const apiKey = process.env.CORE_API_KEY || '';
  if (!apiKey) return res.status(200).json({ results: [] });

  try {
    const { query = '', limit = 10 } = req.body || {};
    if (!query.trim()) return res.status(200).json({ results: [] });

    // Trailing slash — без нього CORE віддає 301 без CORS-заголовків
    const url = `https://api.core.ac.uk/v3/search/works/?q=${encodeURIComponent(query)}&limit=${limit}&apiKey=${apiKey}`;
    const r = await withTimeout(fetch(url, { cache: 'no-store' }));
    if (!r.ok) return res.status(200).json({ results: [] });
    const data = await r.json();
    return res.status(200).json({ results: data.results || [] });
  } catch (e) {
    console.error('search-core error:', e.message);
    return res.status(200).json({ results: [] });
  }
}
