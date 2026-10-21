import { requireAuth } from "./_auth.js";
import { safeFetch, isSafeUrl, readLimited } from "./_safeFetch.js";
import { analyzePdf, MAX_PDF_BYTES } from "./_pdfPages.js";
// Сторінки статті з самого PDF (номери в колонтитулах) — коли ні CrossRef/OpenAlex,
// ні мета-теги сторінки журналу їх не дали (типово для українських журналів).
// Вхід: { url, snippets? } — snippets: речення з тексту роботи, для кожного
// повертається сторінка PDF, де про це йдеться найбільше (вибір сторінки за змістом).
// Вихід: { pages: "12–19" | null, noPages, numPages, snippetPages? }.
export const config = { maxDuration: 30 };

const MAX_SNIPPETS = 60;

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    return res.status(200).end();
  }
  if (req.method !== 'POST') return res.status(405).end();
  if (!(await requireAuth(req, res))) return;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  const empty = { pages: null, noPages: false, numPages: null };
  const { url, snippets } = req.body || {};
  if (!url || typeof url !== 'string' || !isSafeUrl(url)) return res.status(200).json(empty);
  const cleanSnippets = Array.isArray(snippets)
    ? snippets.slice(0, MAX_SNIPPETS).map(s => String(s || '').slice(0, 600))
    : null;

  try {
    const { res: r } = await safeFetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; AcademAssist/1.0; +https://academ-assist.vercel.app)',
        'Accept': 'application/pdf,*/*;q=0.8',
      },
    }, { timeoutMs: 12000 });
    if (!r.ok) {
      try { await r.body?.cancel(); } catch { /* ignore */ }
      return res.status(200).json(empty);
    }
    const buf = await readLimited(r, MAX_PDF_BYTES);
    // заголовок %PDF- за специфікацією може стояти не на самому початку, а в першому КБ
    const magicAt = buf ? buf.indexOf('%PDF-') : -1;
    if (magicAt < 0 || magicAt > 1024) {
      return res.status(200).json({ ...empty, reason: 'not-pdf' });
    }
    const result = await analyzePdf(buf, cleanSnippets);
    return res.status(200).json(result);
  } catch (e) {
    console.error('pdf-pages error:', e.message);
    return res.status(200).json(empty);
  }
}
