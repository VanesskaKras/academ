import { requireAuth } from "./_auth.js";
import { parseScholarPublicationInfo } from "./_scholarParse.js";
// Проксі для Google Scholar через Serper.dev (немає CORS у браузері)
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


// Ключі Serper: SERPER_API_KEY + SERPER_API_KEY_1…_5 (у Vercel). Коли на ключі закінчились кредити
// (400 «Not enough credits») або він неробочий (401/403) — беремо наступний. Це резерв, не обхід лімітів:
// усі ключі — з акаунтів власника.
function serperKeys() {
  return [process.env.SERPER_API_KEY, process.env.SERPER_API_KEY_1, process.env.SERPER_API_KEY_2,
          process.env.SERPER_API_KEY_3, process.env.SERPER_API_KEY_4, process.env.SERPER_API_KEY_5]
    .map(k => (k || '').trim()).filter((k, i, a) => k && a.indexOf(k) === i);
}
function serperKeyDead(status, body) {
  return status === 401 || status === 403 || (status === 400 && /credits/i.test(body || ''));
}

async function searchScholar(query, limit, keys) {
  let lastErr = null;
  for (const apiKey of keys) {
    const res = await fetch('https://google.serper.dev/scholar', {
      method: 'POST',
      headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: query, num: limit }),
    });
    if (res.ok) {
      const data = await res.json();
      // скільки кредитів Serper реально списав за цей запит (поле credits у відповіді) — для точного
      // обліку вартості пошуку джерел у CRM; немає поля → 1
      const organic = (data.organic || []).filter(p => p.title && !isBlocked(p));
      organic._credits = Number(data.credits) > 0 ? Number(data.credits) : 1;
      return organic;
    }
    // раніше відмова Serper (закінчились кредити, мертвий ключ) мовчки давала [] — роботи виходили з 4–9
    // джерелами і ніхто не знав чому (17–19.09.2026). Тепер причину видно викликачу; мертвий ключ → наступний.
    let msg = ''; try { msg = (await res.text()).slice(0, 160); } catch { /* no body */ }
    lastErr = new Error(`serper ${res.status}: ${msg}`); lastErr.serperStatus = res.status;
    if (!serperKeyDead(res.status, msg)) throw lastErr;
    console.warn(`serper key #${keys.indexOf(apiKey) + 1} dead (${res.status}) — next`);
  }
  throw lastErr || new Error('serper: no keys');
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
  if (!apiKey.length) return res.status(200).json({ sources: [] });

  try {
    const { query = '', limit = 10 } = req.body || {};
    if (!query.trim()) return res.status(200).json({ sources: [] });

    const raw = await withTimeout(searchScholar(query, limit, apiKey));

    const sources = raw.map(item => {
      // "автори - журнал, рік - сайт": автори лише з першої частини, обрізаний ("…") журнал
      // і домен сайту журналом не вважаються (див. _scholarParse.js)
      const { authors, venue, year: pubYear, site } = parseScholarPublicationInfo(item.publicationInfo || '');
      const year = item.year || pubYear || '';
      const hasCyr = /[А-ЯҐЄІЇа-яґєіїёЁ]/.test(item.title || '');

      return {
        id: item.link || String(Math.random()),
        title: item.title || '',
        authors,
        year,
        venue,
        // сайт журналу (домен) — не назва видання, але ознака, що джерело опубліковане
        site,
        doi: '',
        pages: '',
        lang: hasCyr ? 'uk' : 'en',
        source: 'scholar',
        abstract: item.snippet || '',
        url: item.link || '',
      };
    });

    res.setHeader('x-serper-credits', String(raw._credits || 1));
    return res.status(200).json({ sources, serperCredits: raw._credits || 1 });
  } catch (e) {
    console.error('search-scholar error:', e.message);
    if (e.serperStatus) res.setHeader('x-serper-error', String(e.message).replace(/[^\x20-\x7E]/g, '').slice(0, 200));
    return res.status(200).json({ sources: [], ...(e.serperStatus ? { serperError: String(e.message).slice(0, 200) } : {}) });
  }
}
