import { requireAuth } from "./_auth.js";
import { safeFetch, isSafeUrl, withTimeout } from "./_safeFetch.js";
import { extractMetaPages, extractMetaDoi, extractPdfUrl, extractMetaJournal, resolveHtmlUrl, looksLikePdfUrl } from "./_metaParse.js";
// Серверний проксі для витягування сторінок зі сторінки статті журналу.
// Більшість академічних видань публікують мета-теги сторінок (citation_firstpage/
// citation_lastpage, DC.Identifier.pageNumber тощо — див. _metaParse.js). Якщо їх
// немає — витягуємо citation_doi і звертаємось до CrossRef. Окремо повертаємо
// посилання на PDF статті (pdfUrl) — по ньому /api/pdf-pages читає номери сторінок
// з самого PDF, коли мета-тегів немає, і повну назву журналу (journal) — коли пошук
// дав її обрізаною (Google Scholar: "Актуальні питання …") чи не дав зовсім.
export const config = { maxDuration: 15 };

const HTML_HEAD_BYTES = 60000;   // мета-теги — у <head>
const HTML_BODY_BYTES = 300000;  // кнопка PDF-галеї OJS — у <body>, читаємо далі лише за потреби

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

  // urlOk: чи справді відкрилась сторінка (для перевірки існування джерела без DOI) —
  // окремо від pages, бо багато легітимних сторінок просто не мають citation-мета-тегів,
  // і це не означає, що посилання нежиттєздатне.
  const { url: rawUrl } = req.body || {};
  if (!rawUrl || typeof rawUrl !== 'string' || !isSafeUrl(rawUrl)) return res.status(200).json({ pages: null, urlOk: false, pdfUrl: null });

  // Пряме посилання на PDF (типово з Google Scholar) ведемо на сторінку статті з мета-тегами,
  // але сам PDF лишаємо запасним варіантом для /api/pdf-pages
  const url = resolveHtmlUrl(rawUrl);
  const fallbackPdf = looksLikePdfUrl(rawUrl) ? rawUrl : null;

  try {
    const { res: r, finalUrl } = await safeFetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; AcademAssist/1.0; +https://academ-assist.vercel.app)',
        'Accept': 'text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.8',
      },
    }, { timeoutMs: 7000 });
    if (!r.ok) {
      try { await r.body?.cancel(); } catch { /* ignore */ }
      return res.status(200).json({ pages: null, urlOk: false, pdfUrl: fallbackPdf });
    }

    // Посилання веде одразу на PDF — мета-тегів тут немає, сторінки дістане /api/pdf-pages
    if (/application\/pdf/i.test(r.headers.get('content-type') || '')) {
      try { await r.body?.cancel(); } catch { /* ignore */ }
      return res.status(200).json({ pages: null, urlOk: true, pdfUrl: finalUrl });
    }

    // Читаємо <head> (мета-теги); тіло — лише якщо в <head> немає ні сторінок, ні PDF
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let html = '';
    let headDone = false;
    for (;;) {
      const limit = headDone ? HTML_BODY_BYTES : HTML_HEAD_BYTES;
      if (html.length >= limit) break;
      const { done, value } = await withTimeout(reader.read(), 7000);
      if (done) break;
      html += decoder.decode(value, { stream: true });
      if (!headDone && html.includes('</head>')) {
        headDone = true;
        if (extractMetaPages(html) || extractPdfUrl(html, finalUrl)) break;
      }
    }
    try { await reader.cancel(); } catch { /* ignore */ }

    const pdfUrl = extractPdfUrl(html, finalUrl) || fallbackPdf;
    const journal = extractMetaJournal(html);
    const pages = extractMetaPages(html);
    if (pages) return res.status(200).json({ pages, urlOk: true, pdfUrl, journal });

    // Мета-теги сторінок відсутні — пробуємо CrossRef по DOI зі сторінки
    const doi = extractMetaDoi(html);
    if (doi) {
      try {
        const cr = await withTimeout(
          fetch(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, {
            headers: { 'User-Agent': 'AcademAssist/1.0 (mailto:support@academ-assist.vercel.app)' },
          }),
          5000,
        );
        if (cr.ok) {
          const crData = await cr.json();
          const p = crData?.message;
          if (p?.page) {
            return res.status(200).json({ pages: p.page.replace(/-/g, '–'), urlOk: true, pdfUrl, journal });
          }
        }
      } catch { /* CrossRef недоступний — сторінка все одно відкрилась */ }
    }

    return res.status(200).json({ pages: null, urlOk: true, pdfUrl, journal });
  } catch {
    return res.status(200).json({ pages: null, urlOk: false, pdfUrl: fallbackPdf });
  }
}
