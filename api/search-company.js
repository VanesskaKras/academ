import { requireAuth } from "./_auth.js";
// Проксі для звичайного Google-пошуку через Serper.dev (немає CORS у браузері) —
// використовується для пошуку реального підприємства (доГенEconProfile), коли
// клієнт не надав власних матеріалів по підприємству.
export const config = { maxDuration: 15 };

const BLOCKED = [
  'russia', 'russian federation', 'москв', 'санкт-петербург', 'новосибирск',
  'екатеринбург', 'казань', 'самар', 'нижн', 'российск', 'росс', 'rsci',
  'elibrary.ru', 'cyberleninka', 'киберленинк',
  'белорус', 'беларус', 'minsk', 'минск', 'гродн', 'витебск', 'брест',
];

function isRussianUrl(url = '') {
  return /\.ru(\/|$)/i.test(url.toLowerCase());
}

function isBlocked(obj) {
  const t = JSON.stringify(obj).toLowerCase();
  if (BLOCKED.some(p => t.includes(p))) return true;
  return isRussianUrl(obj?.link || obj?.url || '');
}

function withTimeout(promise, ms = 10000) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
}

function serperKeys() {
  return [process.env.SERPER_API_KEY, process.env.SERPER_API_KEY_1, process.env.SERPER_API_KEY_2,
          process.env.SERPER_API_KEY_3, process.env.SERPER_API_KEY_4, process.env.SERPER_API_KEY_5]
    .map(k => (k || '').trim()).filter((k, i, a) => k && a.indexOf(k) === i);
}

async function searchGoogle(query, limit, keys) {
  for (const apiKey of keys) {
    const res = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: query, num: limit, gl: 'ua', hl: 'uk' }),
    });
    if (res.ok) {
      const data = await res.json();
      return (data.organic || []).filter(p => p.title && !isBlocked(p));
    }
    let msg = ''; try { msg = (await res.text()).slice(0, 160); } catch { /* no body */ }
    const dead = res.status === 401 || res.status === 403 || (res.status === 400 && /credits/i.test(msg));
    if (!dead) return [];
    console.warn(`serper key #${keys.indexOf(apiKey) + 1} dead (${res.status}) — next`);
  }
  return [];
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

  const apiKey = serperKeys();
  if (!apiKey.length) return res.status(200).json({ results: [] });

  try {
    const { query = '', limit = 8 } = req.body || {};
    if (!query.trim()) return res.status(200).json({ results: [] });

    const raw = await withTimeout(searchGoogle(query, limit, apiKey));

    const results = raw.map(item => ({
      title: item.title || '',
      snippet: item.snippet || '',
      url: item.link || '',
    }));

    return res.status(200).json({ results });
  } catch (e) {
    console.error('search-company error:', e.message);
    return res.status(200).json({ results: [] });
  }
}
