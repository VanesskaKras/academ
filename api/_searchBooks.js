import { requireAuth } from "./_auth.js";
// Проксі для Google Books — напряму через офіційний Books API (books.googleapis.com),
// не через Serper: серпер такого ендпоінту офіційно не документує (books там немає
// в списку продуктів), і він стабільно повертав порожньо незалежно від ключа.
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

function hasCyrillic(text = '') {
  return /[А-ЯҐЄІЇа-яґєіїёЁ]/.test(text);
}

async function searchBooks(query, limit, apiKey) {
  const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query)}&maxResults=${Math.min(limit, 40)}&key=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const data = await res.json();
  return (data.items || [])
    .map(item => item.volumeInfo || {})
    .filter(vi => vi.title && !isBlocked(vi));
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

  const apiKey = process.env.GOOGLE_BOOKS_API_KEY || '';
  if (!apiKey) return res.status(200).json({ sources: [] });

  try {
    const { query = '', limit = 8 } = req.body || {};
    if (!query.trim()) return res.status(200).json({ sources: [] });

    const raw = await withTimeout(searchBooks(query, limit, apiKey));

    const sources = raw.map(vi => {
      const authors = Array.isArray(vi.authors) ? vi.authors.slice(0, 3) : [];
      const year = (vi.publishedDate || '').match(/\b(19|20)\d{2}\b/)?.[0] || '';
      const lang = hasCyrillic(vi.title) ? 'uk' : 'en';

      return {
        id: vi.industryIdentifiers?.[0]?.identifier || vi.previewLink || String(Math.random()),
        title: vi.title || '',
        authors,
        year,
        venue: vi.publisher || '',
        doi: '',
        // pageCount — ЗАГАЛЬНИЙ обсяг книги ("240 с."), а не сторінки статті
        pages: '',
        totalPages: vi.pageCount || null,
        lang,
        source: 'books',
        type: 'book',
        abstract: (vi.description || '').slice(0, 400),
        url: vi.infoLink || vi.previewLink || '',
      };
    });

    return res.status(200).json({ sources });
  } catch (e) {
    console.error('search-books error:', e.message);
    return res.status(200).json({ sources: [] });
  }
}
