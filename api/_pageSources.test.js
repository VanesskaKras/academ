// Тести серверного витягування сторінок: мета-теги сторінки журналу (_metaParse.js) і
// номери сторінок у колонтитулах PDF (_pdfPages.js — на PDF, згенерованих прямо тут).
// Запуск: node api/_pageSources.test.js
import assert from "node:assert/strict";
import { extractMetaPages, extractPdfUrl, resolveHtmlUrl, extractMetaDoi, looksLikePdfUrl, extractMetaJournal } from "./_metaParse.js";
import { parseScholarPublicationInfo } from "./_scholarParse.js";
import { analyzePdf, marginNumbers, pagesFromMarginSamples, citeLinePages, pickPagesForSnippets } from "./_pdfPages.js";
import { isSafeUrl } from "./_safeFetch.js";

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (err) {
    console.error(`  FAIL - ${name}\n    ${err.stack || err.message}`);
    process.exitCode = 1;
  }
}

// Мінімальний PDF: сторінки з текстом (Helvetica) у заданих позиціях.
// pages: [[{ text, x, y }], ...] — координати в пунктах, сторінка 595×842.
function buildPdf(pages) {
  const esc = s => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const objs = [];
  const add = body => { objs.push(body); return objs.length; };
  const fontId = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const pagesId = objs.length + 1; objs.push(null);
  const kids = [];
  for (const items of pages) {
    const stream = items.map(it => `BT /F1 10 Tf ${it.x} ${it.y} Td (${esc(it.text)}) Tj ET`).join("\n");
    const contentId = add(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`));
  }
  objs[pagesId - 1] = `<< /Type /Pages /Kids [${kids.map(k => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;
  const catalogId = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  let out = "%PDF-1.4\n";
  const offsets = [];
  objs.forEach((body, i) => { offsets.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(out, "latin1");
}

const LOREM = "Management of enterprise personnel requires coordinated motivation systems and training programmes";
function bodyLines(extra = "") {
  return Array.from({ length: 20 }, (_, k) => ({ text: `${LOREM} ${extra} line ${k}`, x: 60, y: 700 - k * 25 }));
}

// ── _metaParse ──
await test("мета-теги: citation_firstpage/lastpage (OJS)", () => {
  const html = `<head><meta name="citation_firstpage" content="53"><meta name="citation_lastpage" content="59"></head>`;
  assert.equal(extractMetaPages(html), "53–59");
});
await test("мета-теги: DC.Identifier.pageNumber (OJS 3), атрибути в іншому порядку", () => {
  assert.equal(extractMetaPages(`<meta content="101-107" name="DC.Identifier.pageNumber"/>`), "101–107");
});
await test("мета-теги: prism, eprints.pagerange, JSON-LD", () => {
  assert.equal(extractMetaPages(`<meta name="prism.startingPage" content="12"><meta name="prism.endingPage" content="19">`), "12–19");
  assert.equal(extractMetaPages(`<meta name="eprints.pagerange" content="45-52">`), "45–52");
  assert.equal(extractMetaPages(`<script type="application/ld+json">{"@type":"ScholarlyArticle","pageStart":"7","pageEnd":"15"}</script>`), "7–15");
});
await test("мета-теги: без сторінок — null", () => {
  assert.equal(extractMetaPages(`<meta name="citation_title" content="X">`), null);
});
await test("PDF статті: citation_pdf_url, <link>, кнопка галеї OJS", () => {
  const base = "https://journal.ua/index.php/j/article/view/123";
  assert.equal(extractPdfUrl(`<meta name="citation_pdf_url" content="https://journal.ua/index.php/j/article/download/123/456">`, base),
    "https://journal.ua/index.php/j/article/download/123/456");
  assert.equal(extractPdfUrl(`<link rel="alternate" type="application/pdf" href="/files/a.pdf">`, base), "https://journal.ua/files/a.pdf");
  assert.equal(extractPdfUrl(`<a class="obj_galley_link pdf" href="https://journal.ua/index.php/j/article/view/123/456">PDF</a>`, base),
    "https://journal.ua/index.php/j/article/download/123/456");
  assert.equal(extractPdfUrl(`<a href="/x">x</a>`, base), null);
});
await test("посилання на PDF-галею OJS → сторінка статті з мета-тегами", () => {
  assert.equal(resolveHtmlUrl("https://j.ua/index.php/ee/article/download/1428/1438"), "https://j.ua/index.php/ee/article/view/1428");
  assert.equal(resolveHtmlUrl("https://j.ua/index.php/ee/article/view/1428/1438"), "https://j.ua/index.php/ee/article/view/1428");
  assert.equal(resolveHtmlUrl("https://j.ua/index.php/ee/article/view/1428"), "https://j.ua/index.php/ee/article/view/1428");
  assert.equal(resolveHtmlUrl("https://dspace.x.ua/bitstream/123/456/1/a.pdf"), "https://dspace.x.ua/handle/123/456");
  assert.equal(looksLikePdfUrl("https://j.ua/index.php/ee/article/download/1428/1438"), true);
});
await test("DOI зі сторінки", () => {
  assert.equal(extractMetaDoi(`<meta name="citation_doi" content="10.32782/2524-0072/2024-60-71">`), "10.32782/2524-0072/2024-60-71");
  assert.equal(extractMetaDoi(`<meta name="DC.Identifier.DOI" content="10.1234/abc">`), "10.1234/abc");
});
await test("назва журналу зі сторінки статті (реальні мета-теги трьох журналів)", () => {
  assert.equal(extractMetaJournal(`<meta name="citation_journal_title" content="International Science Journal of Management, Economics &amp; Finance"/>`),
    "International Science Journal of Management, Economics & Finance");
  assert.equal(extractMetaJournal(`<meta name="DC.Source" content="«Вісник ЖДТУ»: Економіка, управління та адміністрування"/>`),
    "«Вісник ЖДТУ»: Економіка, управління та адміністрування");
  assert.equal(extractMetaJournal(`<meta name="DC.Source.ISSN" content="2415-8453"/><meta name="citation_journal_title" content="Актуальні питання економічних наук"/>`),
    "Актуальні питання економічних наук");
  assert.equal(extractMetaJournal(`<meta name="citation_journal_title" content="Актуальні питання …"/>`), null, "обрізана назва — не назва");
  assert.equal(extractMetaJournal(`<meta name="og:title" content="X"/>`), null);
});

await test("Google Scholar: журнал і сайт більше не потрапляють в авторів (реальні рядки)", () => {
  assert.deepEqual(parseScholarPublicationInfo("V Babenko, T Nazarova - International Science Journal of …, 2024 - isg-journal.com"),
    { authors: ["V Babenko", "T Nazarova"], venue: "", year: 2024, site: "isg-journal.com" });
  assert.deepEqual(parseScholarPublicationInfo("КС Головач - «Вісник ЖДТУ»: Економіка, управління та …, 2015 - ven.ztu.edu.ua"),
    { authors: ["КС Головач"], venue: "", year: 2015, site: "ven.ztu.edu.ua" });
  assert.deepEqual(parseScholarPublicationInfo("О Коваль - Економіка та суспільство, 2023 - economyandsociety.in.ua"),
    { authors: ["О Коваль"], venue: "Економіка та суспільство", year: 2023, site: "economyandsociety.in.ua" });
  // забагато авторів ("…"), журнал із " - " усередині, без сайту
  assert.deepEqual(parseScholarPublicationInfo("A Smith, B Jones, C Lee… - Economics - Innovative Research Journal, 2021 - sciendo.com").authors, ["A Smith", "B Jones", "C Lee"]);
  assert.equal(parseScholarPublicationInfo("A Smith, B Jones, C Lee… - Economics - Innovative Research Journal, 2021 - sciendo.com").venue, "Economics - Innovative Research Journal");
  assert.deepEqual(parseScholarPublicationInfo("V Babenko - Journal of Risk Studies, 2024"), { authors: ["V Babenko"], venue: "Journal of Risk Studies", year: 2024, site: "" });
  assert.deepEqual(parseScholarPublicationInfo("V Babenko - isg-journal.com"), { authors: ["V Babenko"], venue: "", year: null, site: "isg-journal.com" });
});

await test("SSRF: внутрішні адреси відхиляються", () => {
  assert.equal(isSafeUrl("http://169.254.169.254/latest/meta-data"), false);
  assert.equal(isSafeUrl("http://127.0.0.1:8080"), false);
  assert.equal(isSafeUrl("http://[::1]/"), false);
  assert.equal(isSafeUrl("file:///etc/passwd"), false);
  assert.equal(isSafeUrl("https://journals.maup.com.ua/x"), true);
});

// ── _pdfPages: чисті функції ──
await test("номери в полях: рік і номер випуску не вважаються сторінкою", () => {
  const items = [{ str: "53", y: 30 }, { str: "2024", y: 820 }, { str: "Економіка та суспільство. Випуск 60", y: 820 }, { str: "117", y: 400 },
    { str: "Стаття надійшла до редакції 24.03.2023 р.", y: 20 }, { str: "Гібридне навчання: причини і виклики .......... 123", y: 20 }];
  assert.deepEqual(marginNumbers(items, 842), [53]);
});
await test("голосування за зміщення: узгоджені номери → діапазон", () => {
  assert.deepEqual(pagesFromMarginSamples(4, [
    { index: 1, numbers: [340] }, { index: 2, numbers: [341] }, { index: 3, numbers: [342] }, { index: 4, numbers: [343] },
  ]), { first: 340, last: 343 });
  // перша сторінка без номера (типово) — діапазон усе одно визначається
  assert.deepEqual(pagesFromMarginSamples(7, [
    { index: 1, numbers: [] }, { index: 2, numbers: [54] }, { index: 3, numbers: [55] }, { index: 6, numbers: [58] }, { index: 7, numbers: [59] },
  ]), { first: 53, last: 59 });
  // розворот автореферату (дві сторінки на аркуші PDF) — не вгадуємо (було б хибне 9–20)
  assert.equal(pagesFromMarginSamples(12, [
    { index: 1, numbers: [] }, { index: 2, numbers: [1] }, { index: 3, numbers: [2, 3] }, { index: 11, numbers: [18, 19] }, { index: 12, numbers: [20] },
  ]), null);
  // уривок книги: номери лише з рядків змісту в кінці — не сторінки статті (було б хибне 228–243)
  assert.equal(pagesFromMarginSamples(16, [
    { index: 1, numbers: [] }, { index: 2, numbers: [] }, { index: 3, numbers: [] }, { index: 15, numbers: [123, 242] }, { index: 16, numbers: [243] },
  ]), null);
  // однакове число на кожній сторінці ("№ 4") — не сторінки
  assert.equal(pagesFromMarginSamples(5, [
    { index: 1, numbers: [4] }, { index: 2, numbers: [4] }, { index: 3, numbers: [4] }, { index: 4, numbers: [4] }, { index: 5, numbers: [4] },
  ]), null);
});
await test("рядок цитування на першій сторінці", () => {
  assert.deepEqual(citeLinePages("Для цитування: Фурман Д. Г. Імперативи… Ефективна економіка. 2023. № 4. С. 19–31.", 13), { first: 19, last: 31 });
  assert.equal(citeLinePages("Для цитування: … С. 19–31.", 4), null, "довжина не збігається з PDF");
});
await test("сторінка за змістом: перша сторінка й список літератури не рахуються", () => {
  const texts = [
    "Анотація. Мотивація персоналу підприємства система винагороди навчання персоналу",
    "Вступ. Організаційна культура корпоративні цінності згуртованість колективу підприємства",
    "Система винагороди мотивація персоналу грошові стимули премії бонуси мотиваційні програми",
    "Список використаних джерел. Мотивація персоналу підприємства винагороди",
  ];
  const got = pickPagesForSnippets(texts, 101, [
    "Грошові стимули й премії лишаються основою мотиваційних програм персоналу",
    "Корпоративні цінності підсилюють згуртованість колективу та організаційну культуру",
    "Зовсім інша тема про квантові обчислення",
  ]);
  assert.deepEqual(got, [103, 102, null]);
});

// ── _pdfPages: справжній розбір PDF ──
await test("PDF статті з номерами в колонтитулі й роком у шапці → 53–59", async () => {
  const pdf = buildPdf(Array.from({ length: 7 }, (_, i) => [
    { text: "Naukovi pratsi. 2024", x: 60, y: 815 },
    ...bodyLines(),
    ...(i === 0 ? [] : [{ text: String(53 + i), x: 290, y: 30 }]),
  ]));
  const r = await analyzePdf(pdf);
  assert.equal(r.pages, "53–59");
  assert.equal(r.numPages, 7);
  assert.equal(r.noPages, false);
});
await test("е-журнал: текст є, номерів сторінок немає → noPages", async () => {
  const pdf = buildPdf(Array.from({ length: 5 }, () => bodyLines()));
  const r = await analyzePdf(pdf);
  assert.equal(r.pages, null);
  assert.equal(r.noPages, true);
});
await test("PDF без тексту (скан) → не вгадуємо ні сторінок, ні їх відсутності", async () => {
  const pdf = buildPdf(Array.from({ length: 3 }, () => []));
  const r = await analyzePdf(pdf);
  assert.equal(r.pages, null);
  assert.equal(r.noPages, false);
});
await test("вибір сторінки за змістом на справжньому PDF", async () => {
  const pages = [
    [{ text: "Abstract. Personnel motivation remuneration training", x: 60, y: 700 }, ...bodyLines()],
    [{ text: "Corporate values strengthen team cohesion and organisational culture", x: 60, y: 750 }, { text: "11", x: 290, y: 30 }],
    [{ text: "Bonuses premiums financial incentives remain the core of motivation programmes", x: 60, y: 750 }, { text: "12", x: 290, y: 30 }],
    [{ text: "References", x: 60, y: 750 }, { text: "Bonuses premiums incentives motivation", x: 60, y: 720 }, { text: "13", x: 290, y: 30 }],
  ];
  const r = await analyzePdf(buildPdf(pages), ["Financial incentives and bonuses remain the core of motivation programmes"]);
  assert.equal(r.pages, "10–13");
  assert.deepEqual(r.snippetPages, [12]);
});

console.log(`\n${passed} тестів пройшло`);
