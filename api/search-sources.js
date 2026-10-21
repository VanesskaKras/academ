import { requireAuth } from "./_auth.js";
// Серверна функція для Semantic Scholar (немає CORS у браузері — проксимо тут)
export const config = { maxDuration: 25 };

const BLOCKED = [
  'russia', 'russian federation', 'москв', 'санкт-петербург', 'новосибирск',
  'екатеринбург', 'казань', 'самар', 'нижн', 'российск', 'росс', 'rsci',
  'elibrary.ru', 'cyberleninka', 'киберленинк',
  'белорус', 'беларус', 'minsk', 'минск', 'гродн', 'витебск', 'брест',
];

function isBlocked(obj) {
  const t = JSON.stringify(obj).toLowerCase();
  return BLOCKED.some(p => t.includes(p));
}

function withTimeout(promise, ms = 10000) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
}

// Обрізає анотацію до перших 2 речень / 100 слів (як snippetAbstract у src/lib/sourcesSearch.js)
function snippetAbstract(text) {
  if (!text) return '';
  const sentences = text.match(/[^.!?]+[.!?]+/g) || [];
  const snippet = sentences.slice(0, 2).join(' ').trim();
  if (!snippet) return '';
  const words = snippet.split(/\s+/);
  return words.length > 100 ? words.slice(0, 100).join(' ') + '...' : snippet;
}

// Той самий "нестрогий" поріг (останні 10 років), що й YEAR_LOOSE у src/lib/sourcesSearch.js —
// рахуємо від поточного року, а не захардкоджуємо конкретний рік
const YEAR_LOOSE = new Date().getFullYear() - 9;

async function searchSemanticScholar(query, limit) {
  const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(query)}&fields=title,authors,year,venue,externalIds,abstract,journal&limit=${limit}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'AcademAssist/1.0' } });
  if (!r.ok) return [];
  const data = await r.json();
  return (data.data || [])
    .filter(p => {
      if (!p.title || !p.year || p.year < YEAR_LOOSE) return false;
      if (isBlocked(p)) return false;
      // Тільки латиниця (англомовні)
      const cyr = (p.title.match(/[А-ЯҐЄІЇа-яґєіїёЁ]/g) || []).length;
      return cyr === 0;
    })
    .map(p => ({
      id: p.paperId,
      title: p.title,
      authors: (p.authors || []).slice(0, 3).map(a => a.name || '').filter(Boolean),
      year: p.year,
      venue: p.venue || p.journal?.name || '',
      doi: p.externalIds?.DOI || '',
      // сторінки й том — з поля journal (сирі; перевіряє й нормалізує клієнт)
      pages: (p.journal?.pages || '').trim(),
      volume: (p.journal?.volume || '').trim(),
      lang: 'en',
      source: 'ss',
      abstract: snippetAbstract(p.abstract || ''),
      url: p.externalIds?.DOI
        ? `https://doi.org/${p.externalIds.DOI}`
        : `https://www.semanticscholar.org/paper/${p.paperId}`,
    }));
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
    const { enKeywords = [], needed = 3 } = req.body || {};
    const query = enKeywords.slice(0, 3).join(' ').trim();

    if (!query) return res.status(200).json({ sources: [] });

    const sources = await withTimeout(searchSemanticScholar(query, needed + 3));

    // Дедуп
    const seen = new Set();
    const deduped = sources.filter(p => {
      const key = p.title.toLowerCase().slice(0, 60);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    return res.status(200).json({ sources: deduped.slice(0, needed) });
  } catch (e) {
    console.error('search-sources error:', e.message);
    return res.status(200).json({ sources: [] }); // не падаємо — повертаємо порожній масив
  }
}
