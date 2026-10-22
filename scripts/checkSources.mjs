// Діагностика джерел для пошуку літератури (src/lib/sourcesSearch.js).
// Перевіряє кожне джерело окремо тестовим запитом і друкує OK/FAIL + кількість
// результатів, бо в проксі (search-core/scholar/books) відсутній ключ на
// Vercel тихо повертає порожній масив замість помилки — з боку застосунку
// це виглядає просто як "менше джерел", без жодного сигналу.
//
// Запуск: node scripts/checkSources.mjs [baseUrl]
// baseUrl — адреса задеплоєного бекенду (проксі-ендпоінти /api/* там мають
// бути доступні з реальними ключами). За замовчуванням береться з
// SOURCES_CHECK_BASE_URL або з дефолту нижче.

const BASE_URL = (process.argv[2] || process.env.SOURCES_CHECK_BASE_URL || 'https://academ-assist-beryl.vercel.app').replace(/\/$/, '');
const QUERY_UK = 'інтерактивні технології навчання';
const QUERY_EN = 'interactive learning technologies';
const TEST_META_URL = 'https://doi.org/10.1038/nphys1170'; // стабільний DOI, завжди відкривається
// PDF статті з наскрізною нумерацією в колонтитулах (перевірено: 340–343)
const TEST_PDF_URL = 'https://economyandsociety.in.ua/index.php/journal/article/download/3610/3541';
// Проксі /api/* закриті токеном (22.09.2026) — той самий WORKER_PROXY_TOKEN, що у воркера
const AUTH = process.env.WORKER_PROXY_TOKEN ? { Authorization: `Bearer ${process.env.WORKER_PROXY_TOKEN}` } : {};

const results = [];

function record(name, status, detail) {
  results.push({ name, status, detail });
  const icon = status === 'OK' ? '✓' : status === 'WARN' ? '⚠' : '✗';
  console.log(`${icon} ${name}: ${detail}`);
}

async function withTimeout(promise, ms = 12000) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
}

// ── Прямі джерела (без проксі) ──

async function checkOpenAlex() {
  try {
    const url = `https://api.openalex.org/works?search=${encodeURIComponent(QUERY_UK)}&filter=language:uk&per_page=5&mailto=support@academ-assist.vercel.app`;
    const r = await withTimeout(fetch(url));
    if (!r.ok) return record('OpenAlex', 'FAIL', `HTTP ${r.status}`);
    const d = await r.json();
    const n = (d.results || []).length;
    record('OpenAlex', n > 0 ? 'OK' : 'WARN', `${n} результатів`);
  } catch (e) {
    record('OpenAlex', 'FAIL', e.message);
  }
}

async function checkCrossRef() {
  try {
    const url = `https://api.crossref.org/works?query=${encodeURIComponent(QUERY_UK)}&rows=5&mailto=support@academ-assist.vercel.app`;
    const r = await withTimeout(fetch(url));
    if (!r.ok) return record('CrossRef', 'FAIL', `HTTP ${r.status}`);
    const d = await r.json();
    const n = (d.message?.items || []).length;
    record('CrossRef', n > 0 ? 'OK' : 'WARN', `${n} результатів`);
  } catch (e) {
    record('CrossRef', 'FAIL', e.message);
  }
}

// ── Проксі-джерела (через задеплоєний бекенд) ──

async function checkProxy(name, path, body, extract, { keyGated = false } = {}) {
  try {
    const r = await withTimeout(fetch(`${BASE_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH },
      body: JSON.stringify(body),
    }));
    if (!r.ok) return record(name, 'FAIL', `HTTP ${r.status}`);
    const d = await r.json();
    const n = extract(d);
    if (n > 0) return record(name, 'OK', `${n} результатів`);
    const hint = keyGated ? ' — можливо, відсутній/протермінований API-ключ на Vercel (тихий фолбек на [])' : '';
    record(name, 'WARN', `0 результатів${hint}`);
  } catch (e) {
    record(name, 'FAIL', e.message);
  }
}

async function checkFetchMeta() {
  try {
    const r = await withTimeout(fetch(`${BASE_URL}/api/fetch-meta`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH },
      body: JSON.stringify({ url: TEST_META_URL }),
    }));
    if (!r.ok) return record('fetch-meta', 'FAIL', `HTTP ${r.status}`);
    const d = await r.json();
    record('fetch-meta', d.urlOk ? 'OK' : 'FAIL', `urlOk=${d.urlOk}, pages=${d.pages}`);
  } catch (e) {
    record('fetch-meta', 'FAIL', e.message);
  }
}

async function checkPdfPages() {
  try {
    const r = await withTimeout(fetch(`${BASE_URL}/api/pdf-pages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH },
      body: JSON.stringify({ url: TEST_PDF_URL }),
    }), 30000);
    if (!r.ok) return record('pdf-pages', 'FAIL', `HTTP ${r.status}`);
    const d = await r.json();
    record('pdf-pages', d.pages === '340–343' ? 'OK' : 'FAIL', `pages=${d.pages}, numPages=${d.numPages} (очікується 340–343)`);
  } catch (e) {
    record('pdf-pages', 'FAIL', e.message);
  }
}

async function main() {
  console.log(`Перевіряю джерела пошуку літератури проти ${BASE_URL}\n`);

  await checkOpenAlex();
  await checkCrossRef();
  await checkProxy('Semantic Scholar', '/api/search-sources', { enKeywords: QUERY_EN.split(' '), needed: 5 }, d => (d.sources || []).length);
  await checkProxy('DOAJ', '/api/search-doaj', { query: QUERY_UK, limit: 5 }, d => (d.results || []).length);
  await checkProxy('CORE.ac.uk', '/api/search-core', { query: QUERY_UK, limit: 5 }, d => (d.results || []).length, { keyGated: true });
  await checkProxy('Google Scholar (Serper)', '/api/search-scholar', { query: QUERY_UK, limit: 5 }, d => (d.sources || []).length, { keyGated: true });
  await checkProxy('Google Books', '/api/search-books', { query: QUERY_UK, limit: 5 }, d => (d.sources || []).length, { keyGated: true });
  await checkFetchMeta();
  await checkPdfPages();

  const failed = results.filter(r => r.status === 'FAIL');
  const warned = results.filter(r => r.status === 'WARN');
  console.log(`\nПідсумок: ${results.length - failed.length - warned.length} OK, ${warned.length} WARN, ${failed.length} FAIL`);
  if (failed.length) process.exitCode = 1;
}

main();
