// Розбір HTML сторінки статті на сайті журналу для /api/fetch-meta: сторінки статті з
// мета-тегів, DOI і посилання на PDF. Чисті функції без мережі (легко тестувати).
//
// Звідки сторінки (від найпоширенішого в українських журналах):
//   citation_firstpage/citation_lastpage — Google Scholar-теги (OJS, більшість журналів);
//   DC.Identifier.pageNumber            — Dublin Core в OJS 3 ("53-59");
//   citation_pages, prism.startingPage/endingPage, bepress_citation_firstpage/lastpage;
//   eprints.pagerange                   — репозиторії EPrints (lib.iitta.gov.ua тощо);
//   JSON-LD pageStart/pageEnd/pagination;
//   DC.description                      — DSpace/EPrints кладуть повну цитату ("… С. 82–87").

function decodeEntities(s) {
  return String(s || "")
    .replace(/&amp;/g, "&").replace(/&#0?38;/g, "&")
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&ndash;|&#8211;/g, "–").replace(/&mdash;|&#8212;/g, "—");
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Значення мета-тега name="…" (порядок атрибутів будь-який, регістр імені — будь-який)
export function getMeta(html, name) {
  const n = escapeRe(name);
  const m = html.match(new RegExp(`<meta[^>]+(?:name|property)=["']${n}["'][^>]*?content=["']([^"']*)["']`, "i"))
    || html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*?(?:name|property)=["']${n}["']`, "i"));
  return m ? decodeEntities(m[1]).trim() : null;
}

const NUM = /^\d{1,5}$/;
const RANGE = /^\s*(\d{1,5})\s*[-–—−]\s*(\d{1,5})\s*$/;

function pagesFromPair(first, last) {
  if (!first || !NUM.test(first)) return null;
  return last && NUM.test(last) && last !== first ? `${first}–${last}` : first;
}

function pagesFromRangeText(text) {
  const t = String(text || "").trim();
  const m = t.match(RANGE);
  if (m) return `${m[1]}–${m[2]}`;
  return NUM.test(t) ? t : null;
}

export function extractMetaPages(html) {
  const cit = pagesFromPair(getMeta(html, "citation_firstpage"), getMeta(html, "citation_lastpage"));
  if (cit) return cit;

  for (const name of ["DC.Identifier.pageNumber", "citation_pages", "eprints.pagerange", "dc.identifier.pagenumber"]) {
    const v = pagesFromRangeText(getMeta(html, name));
    if (v) return v;
  }

  const prism = pagesFromPair(getMeta(html, "prism.startingPage"), getMeta(html, "prism.endingPage"));
  if (prism) return prism;
  const bepress = pagesFromPair(getMeta(html, "bepress_citation_firstpage"), getMeta(html, "bepress_citation_lastpage"));
  if (bepress) return bepress;

  // JSON-LD (schema.org ScholarlyArticle): "pageStart": "12", "pageEnd": "19" / "pagination": "12-19"
  const ldStart = html.match(/"pageStart"\s*:\s*"?(\d{1,5})"?/);
  if (ldStart) {
    const ldEnd = html.match(/"pageEnd"\s*:\s*"?(\d{1,5})"?/);
    return pagesFromPair(ldStart[1], ldEnd?.[1]);
  }
  const ldPag = html.match(/"pagination"\s*:\s*"([^"]{1,20})"/);
  if (ldPag) {
    const v = pagesFromRangeText(ldPag[1]);
    if (v) return v;
  }

  // DC.description — DSpace/EPrints кладуть повну цитату сюди: "... - С.82-87." або "pp. 45-67"
  const dcDesc = getMeta(html, "DC.description");
  if (dcDesc && dcDesc.length >= 10) {
    const pm = dcDesc.match(/[СC]\.\s*(\d{1,4})\s*[-–]\s*(\d{1,4})/u)
      || dcDesc.match(/[Pp]{1,2}\.\s*(\d{1,4})\s*[-–]\s*(\d{1,4})/);
    if (pm && parseInt(pm[2], 10) >= parseInt(pm[1], 10)) return `${pm[1]}–${pm[2]}`;
  }
  return null;
}

/**
 * Повна назва журналу (чи збірника конференції) зі сторінки статті — для джерел, де пошук
 * її не дав або дав обрізаною (Google Scholar: "Актуальні питання …"). OJS віддає її в
 * citation_journal_title і DC.Source.
 */
export function extractMetaJournal(html) {
  for (const name of ["citation_journal_title", "DC.Source", "prism.publicationName", "bepress_citation_journal_title", "citation_conference_title"]) {
    const v = (getMeta(html, name) || "").replace(/\s+/g, " ").trim();
    if (v.length >= 3 && v.length <= 300 && !/(?:…|\.{3})$/.test(v) && !/^[\w-]+(\.[\w-]+)+$/i.test(v) && !/^https?:/i.test(v)) return v;
  }
  return null;
}

/**
 * DOI статті зі сторінки (мета-тег citation_doi або DC.Identifier).
 * OJS та більшість видавничих платформ завжди містять цей тег.
 */
export function extractMetaDoi(html) {
  const m1 = getMeta(html, "citation_doi");
  if (m1) return m1.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "").trim();
  const m2 = html.match(/<meta[^>]+name=["']DC\.Identifier(?:\.DOI)?["'][^>]+content=["'](?:doi:)?(10\.\d{4,}\/[^"']+)["']/i)
    || html.match(/<meta[^>]+content=["'](?:doi:)?(10\.\d{4,}\/[^"']+)["'][^>]+name=["']DC\.Identifier(?:\.DOI)?["']/i);
  if (m2) return decodeEntities(m2[1]).trim();
  const m3 = html.match(/https?:\/\/(?:dx\.)?doi\.org\/(10\.\d{4,}\/[^\s"'<>]+)/i);
  if (m3) return m3[1].trim();
  return null;
}

export function looksLikePdfUrl(url) {
  return /\.pdf(?:$|[?#])/i.test(url || "") || /\/article\/download\/\d+/i.test(url || "") || /\/bitstream\//i.test(url || "");
}

/**
 * Посилання на PDF статті: мета-теги (citation_pdf_url та аналоги), <link type=application/pdf>,
 * або кнопка PDF-галеї OJS 3 (a.obj_galley_link.pdf → /article/view/ID/GALLEY →
 * /article/download/ID/GALLEY — саме завантаження файлу).
 */
export function extractPdfUrl(html, baseUrl) {
  const abs = (href) => { try { return new URL(decodeEntities(href), baseUrl).toString(); } catch { return null; } };
  for (const name of ["citation_pdf_url", "bepress_citation_pdf_url", "eprints.document_url", "dc.identifier.pdf"]) {
    const v = getMeta(html, name);
    if (v && /^https?:|^\//i.test(v)) return abs(v);
  }
  const link = html.match(/<link[^>]+type=["']application\/pdf["'][^>]+href=["']([^"']+)["']/i)
    || html.match(/<link[^>]+href=["']([^"']+)["'][^>]+type=["']application\/pdf["']/i);
  if (link) return abs(link[1]);
  const galley = html.match(/<a[^>]+class=["'][^"']*obj_galley_link[^"']*\bpdf\b[^"']*["'][^>]+href=["']([^"']+)["']/i)
    || html.match(/<a[^>]+href=["']([^"']+)["'][^>]+class=["'][^"']*obj_galley_link[^"']*\bpdf\b[^"']*["']/i);
  if (galley) {
    const u = abs(galley[1]);
    return u ? u.replace(/\/article\/view\/(\d+)\/(\d+)/i, "/article/download/$1/$2") : null;
  }
  return null;
}

/**
 * Пряме посилання на PDF у репозиторії/журналі → HTML-сторінка статті, де є мета-теги.
 *   lib.iitta.gov.ua:  /id/eprint/NNN/seq/file.pdf           → /id/eprint/NNN
 *   DSpace:            /bitstream/NNN/MMM/seq/file            → /handle/NNN/MMM
 *   OJS:               /article/view|download|viewFile/ID/GALLEY[/FILE] → /article/view/ID
 */
export function resolveHtmlUrl(rawUrl) {
  const url = rawUrl.split("#")[0];
  const iittaM = url.match(/^(https?:\/\/lib\.iitta\.gov\.ua\/id\/eprint\/\d+)\/\d+\//i);
  if (iittaM) return iittaM[1];
  const dspaceM = url.match(/^(https?:\/\/[^/]+)\/bitstream\/(\d+\/\d+)\/\d+\//i);
  if (dspaceM) return `${dspaceM[1]}/handle/${dspaceM[2]}`;
  const ojsM = url.match(/^(https?:\/\/.+\/article\/)(?:view|download|viewFile)\/(\d+)\/\d+(?:\/\d+)?\/?$/i);
  if (ojsM) return `${ojsM[1]}view/${ojsM[2]}`;
  return url;
}
