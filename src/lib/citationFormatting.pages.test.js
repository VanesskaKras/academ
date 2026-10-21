// Тести сторінок у посиланнях і списку джерел (citationFormatting.js + paperToCitation).
// Запуск: node src/lib/citationFormatting.pages.test.js
import assert from "node:assert/strict";
import {
  parseCitationInner, extractCitedNumbers, applyCitationRemap, capCitationRepeats,
  findCitationsToRenumber, findOutOfRangeCitationInText, extractPageRange, restoreLostPages,
  detectInTextPagePolicy, buildCiteFormats, citationMarkerWithPage, renumberedCiteText,
  isAuthorYearCited, fixOutOfRangeCitationPages, buildStructuredEntry, buildFinalReferenceList,
} from "./citationFormatting.js";
import { paperToCitation, cleanAuthorList, isBadVenue, cleanMetaText } from "./sourcesSearch.js";

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (err) {
    console.error(`  FAIL - ${name}\n    ${err.message}`);
    process.exitCode = 1;
  }
}

test("розбір позначок: усі форми, які пишуть модель і наші проходи", () => {
  assert.deepEqual(parseCitationInner("5").map(i => i.n), [5]);
  assert.deepEqual(parseCitationInner("2; 3").map(i => i.n), [2, 3]);
  assert.deepEqual(parseCitationInner("2, 3").map(i => i.n), [2, 3]);
  const g = parseCitationInner("2, с. 54; 3, с. 101");
  assert.deepEqual(g.map(i => [i.n, i.page]), [[2, 54], [3, 101]]);
  assert.deepEqual(parseCitationInner("5, с. 12–14").map(i => [i.n, i.page, i.pageTo]), [[5, 12, 14]]);
  assert.deepEqual(parseCitationInner("5 с.12").map(i => [i.n, i.page]), [[5, 12]]);
  assert.deepEqual(parseCitationInner("5, p. 7").map(i => [i.n, i.page]), [[5, 7]]);
  assert.deepEqual(parseCitationInner("5, с. X").map(i => [i.n, i.page]), [[5, undefined]], "заглушка замість сторінки");
  assert.deepEqual(parseCitationInner("1–3").map(i => i.n), [1, 2, 3]);
  assert.equal(parseCitationInner("Електронний ресурс"), null);
  assert.equal(parseCitationInner("КЛІЄНТ-ІЛЮСТРАЦІЯ:1"), null);
  assert.equal(parseCitationInner("1.1"), null);
  assert.equal(parseCitationInner("N"), null);
});

test("номери процитованих джерел — і в групах зі сторінками (раніше губилось друге)", () => {
  assert.deepEqual(extractCitedNumbers("Текст [2, с. 54; 3, с. 101]. Ще [5] і [6; 7]. [[[SEC:1.1]]]"), [2, 3, 5, 6, 7]);
});

test("ремап групи зі сторінками: жодне джерело не губиться (баг 4)", () => {
  const out = applyCitationRemap("Текст [2, с. 54; 3, с. 101].", { 2: 2, 3: 3 }, { 2: "[2]", 3: "[3]" },
    { pageRanges: { 2: { min: 50, max: 60 }, 3: { min: 100, max: 110 } } });
  assert.equal(out, "Текст [2, с. 54; 3, с. 101].");
});

test("ремап: сторінка з діапазону, модельна поза діапазоном замінюється, без діапазону — без сторінки", () => {
  const refCite = { 1: "[1]", 2: "[2]" };
  const ranges = { 1: { min: 12, max: 19 } };
  assert.equal(applyCitationRemap("А [1]. Б [1]. В [2, с. 44].", { 1: 1, 2: 2 }, refCite, { pageRanges: ranges }),
    "А [1, с. 12]. Б [1, с. 16]. В [2].");
  assert.equal(applyCitationRemap("А [1, с. 300].", { 1: 1 }, refCite, { pageRanges: ranges }), "А [1, с. 12].");
  assert.equal(applyCitationRemap("А [1, с. 15].", { 1: 1 }, refCite, { pageRanges: ranges }), "А [1, с. 15].");
});

test("ремап: група з локальних номерів, дублікати й хибні номери", () => {
  const out = applyCitationRemap("А [1; 2; 1; 9].", { 1: 4, 2: 1 }, { 1: "[1]", 4: "[4]" }, { pageRanges: {} });
  assert.equal(out, "А [4; 1].");
  assert.equal(applyCitationRemap("А [9].", { 1: 1 }, { 1: "[1]" }), "А.");
});

test("ремап: pagePicker (сторінка за змістом) має пріоритет, якщо в межах діапазону", () => {
  const ranges = { 1: { min: 12, max: 19 } };
  const picker = (n, occ) => (occ === 1 ? 17 : 99);
  assert.equal(applyCitationRemap("А [1]. Б [1].", { 1: 1 }, { 1: "[1]" }, { pageRanges: ranges, pagePicker: picker }),
    "А [1, с. 17]. Б [1, с. 16].");
});

test("ремап APA: сторінка в дужці й у групі", () => {
  const refCite = { 1: "(Іванов, 2021)", 2: "(Smith, 2020)" };
  const out = applyCitationRemap("А [1]. Б [1; 2].", { 1: 1, 2: 2 }, refCite,
    { pageRanges: { 1: { min: 12, max: 19 } }, pageAbbrev: "с." });
  assert.equal(out, "А (Іванов, 2021, с. 12). Б (Іванов, 2021, с. 16; Smith, 2020).");
});

test("APA: процитоване зі сторінкою не вважається «осиротілим»", () => {
  assert.equal(isAuthorYearCited("Текст (Іванов, 2021, с. 12).", "(Іванов, 2021)"), true);
  assert.equal(isAuthorYearCited("Текст (Петров, 2020; Іванов, 2021).", "(Іванов, 2021)"), true);
  assert.equal(isAuthorYearCited("Текст без посилань.", "(Іванов, 2021)"), false);
});

test("обмеження повторів працює і з групами зі сторінками", () => {
  const out = capCitationRepeats("А [1, с. 12]. Б [1; 2]. В [1, с. 14; 3].", 2);
  assert.equal(out, "А [1, с. 12]. Б [1; 2]. В [3].");
});

test("«Правки до файлу»: перенумерація за один прохід, без подвійного зсуву і зациклення", () => {
  const text = "Текст [1] і [5, с. 12]. Ще [4]. Група [3; 5].\nСПИСОК ВИКОРИСТАНИХ ДЖЕРЕЛ\n1. А\n2. Б";
  const zoneStart = text.indexOf("СПИСОК");
  const oldToNew = { 1: 1, 2: 2, 3: 3, 5: 4, 4: null };
  const fixes = findCitationsToRenumber(text, oldToNew, zoneStart, text.length);
  let t = text;
  for (const f of fixes) t = t.slice(0, f.start) + f.replacement + t.slice(f.end);
  assert.equal(t.slice(0, t.indexOf("\n")), "Текст [1] і [4, с. 12]. Ще. Група [3; 4].");
  assert.ok(fixes.every((f, i) => i === 0 || fixes[i - 1].start > f.start), "від кінця до початку");
});

test("сторінки поза межами джерела виправляються і всередині групи", () => {
  const text = "А [1, с. 99; 2]. \nСПИСОК ВИКОРИСТАНИХ ДЖЕРЕЛ\n1. Іванов І. Назва. Вісник. 2022. № 4. С. 12–19.\n2. Сайт. URL: https://x.ua";
  const fix = findOutOfRangeCitationInText(text);
  assert.equal(fix.replacement, "[1, с. 12; 2]");
  const r = fixOutOfRangeCitationPages({
    content: { a: "Б [1, с. 99].", src: "1. Іванов І. Назва. Вісник. 2022. № 4. С. 12–19." },
    sections: [{ id: "a", type: "theory" }, { id: "src", type: "sources" }],
  });
  assert.equal(r.updatedContent.a, "Б [1, с. 12].");
  assert.equal(r.fixedCount, 1);
});

test("діапазон для посилань: англомовна стаття, рік не сторінка, книги", () => {
  assert.deepEqual(extractPageRange("Smith J. Remote work. *J. of Management*. 2021. Vol. 12. No. 3. P. 191–199.", null), { min: 191, max: 199 });
  assert.equal(extractPageRange("Smith J. Transformational leadership. 2021.", null), null);
  assert.equal(extractPageRange("Іванов І. Освітній процес. 2021.", null), null);
  assert.deepEqual(extractPageRange("Петренко П. Менеджмент. Київ : Логос, 2020. 240 с.", null), { min: 4, max: 237 });
  // старий запис Google Books: обсяг лежав у "С. 240"
  assert.deepEqual(extractPageRange("Петренко П. Менеджмент. *Логос*. 2020. С. 240.", { type: "book", pages: "240" }), { min: 4, max: 237 });
  assert.deepEqual(extractPageRange("Петренко П. Менеджмент. 2020.", { type: "book", totalPages: 240 }), { min: 4, max: 237 });
});

test("опис джерела: книга з Google Books — «240 с.», а не «С. 240»", () => {
  const line = paperToCitation({ title: "Менеджмент", authors: ["Петренко П."], venue: "Логос", year: 2020, type: "book", pages: "", totalPages: 240, lang: "uk" });
  assert.match(line, /2020\. 240 с\.$/);
  assert.doesNotMatch(line, /С\. 240/);
  const legacy = paperToCitation({ title: "Менеджмент", authors: ["Петренко П."], year: 2020, type: "book", pages: "240", lang: "uk" });
  assert.match(legacy, /240 с\.$/);
  const art = paperToCitation({ title: "Remote work", authors: ["Smith J."], venue: "Journal", year: 2021, pages: "191-199", lang: "en" });
  assert.match(art, /P\. 191–199\./);
});

test("ЛЛМ загубила чи змінила сторінки — код повертає їх", () => {
  const raw = "Іванов І. Назва. *Вісник*. 2022. № 4. С. 12–19. URL: https://x.ua/1";
  assert.equal(restoreLostPages(raw, "Іванов І. Назва. *Вісник*. 2022. № 4. URL: https://x.ua/1 (дата звернення: 01.09.2026).", "ДСТУ 8302:2015"),
    "Іванов І. Назва. *Вісник*. 2022. № 4. С. 12–19. URL: https://x.ua/1 (дата звернення: 01.09.2026).");
  assert.equal(restoreLostPages(raw, "Іванов І. Назва. *Вісник*. 2022. № 4. С. 12–91.", "ДСТУ 8302:2015"),
    "Іванов І. Назва. *Вісник*. 2022. № 4. С. 12–19.");
  const same = "Іванов І. Назва. *Вісник*. 2022. № 4. С. 12–19.";
  assert.equal(restoreLostPages(raw, same, "ДСТУ 8302:2015"), same);
  assert.equal(restoreLostPages("Smith J. Title. *Journal*. 2021. Vol. 12. No. 3. P. 191–199.",
    "Smith, J. (2021). Title. *Journal*, 12(3). https://doi.org/10.1234/x", "APA"),
  "Smith, J. (2021). Title. *Journal*, 12(3), 191–199. https://doi.org/10.1234/x");
  assert.equal(restoreLostPages("Петренко П. Менеджмент. Київ : Логос, 2020. 240 с.", "Петренко П. Менеджмент. Київ : Логос, 2020.", "ДСТУ 8302:2015"),
    "Петренко П. Менеджмент. Київ : Логос, 2020. 240 с.");
  assert.equal(restoreLostPages("Сайт. URL: https://x.ua", "Сайт. URL: https://x.ua (дата звернення: 01.09.2026).", "ДСТУ 8302:2015"),
    "Сайт. URL: https://x.ua (дата звернення: 01.09.2026).");
});

test("вимога методички до посилань у тексті", () => {
  assert.equal(detectInTextPagePolicy("[N, с. 25]"), "always");
  assert.equal(detectInTextPagePolicy("(Автор, рік) або (Автор, рік, с. 25)"), "always");
  assert.equal(detectInTextPagePolicy("у квадратних дужках із зазначенням номера джерела та сторінки"), "always");
  assert.equal(detectInTextPagePolicy("[1]"), "never");
  assert.equal(detectInTextPagePolicy("(Автор, рік)"), "never");
  assert.equal(detectInTextPagePolicy("посилання у квадратних дужках"), "auto");
  assert.equal(detectInTextPagePolicy(null), "auto");
});

test("політика «без сторінок» прибирає сторінки з посилань", () => {
  const args = {
    finalTexts: ["Іванов І. Назва. Вісник. 2022. № 4. С. 12–19."], rawRefs: ["Іванов І. Назва. Вісник. 2022. № 4. С. 12–19."],
    indexMap: [1], findStructured: () => null, isAPA: false, isMLA: false, isFootnoteMode: false,
  };
  assert.deepEqual(buildCiteFormats(args).pageRanges, { 1: { min: 12, max: 19 } });
  assert.deepEqual(buildCiteFormats({ ...args, pagePolicy: "never" }).pageRanges, {});
  const { refCiteText, pageRanges } = buildCiteFormats({ ...args, pagePolicy: "never" });
  assert.equal(applyCitationRemap("А [1, с. 14].", { 1: 1 }, refCiteText, { pageRanges }), "А [1].");
});

test("довставка осиротілого джерела — одразу зі сторінкою (баг 5)", () => {
  assert.equal(citationMarkerWithPage(3, { 3: "[3]" }, { 3: { min: 12, max: 19 } }), "[3, с. 12]");
  assert.equal(citationMarkerWithPage(3, { 3: "[3]" }, {}), "[3]");
  assert.equal(citationMarkerWithPage(2, { 2: "(Іванов, 2021)" }, { 2: { min: 5, max: 9 } }, "p."), "(Іванов, 2021, p. 5)");
  assert.equal(citationMarkerWithPage(4, { 4: "%%FN4%%" }, {}), "%%FN4%%");
});

test("перенумерація позначки після видалення джерела (практика)", () => {
  assert.equal(renumberedCiteText("[5]", 4), "[4]");
  assert.equal(renumberedCiteText("%%FN5%%", 4), "%%FN4%%");
  assert.equal(renumberedCiteText("(Іванов, 2021)", 4), "(Іванов, 2021)");
});

// ── "…" у назві журналу: джерела Google Scholar, зібрані старим розбором (реальні записи) ──
const LEGACY_HOLOVACH = {
  title: "Узагальнення наукових підходів до поняття «криза на підприємстві»", year: 2015, pages: "74–79",
  authors: ["КС Головач - «Вісник ЖДТУ»: Економіка", "управління та …", "2015"], venue: "ven.ztu.edu.ua",
  lang: "uk", source: "scholar", url: "http://ven.ztu.edu.ua/article/view/50144",
};
const LEGACY_BABENKO = {
  title: "Стратегії і інструменти оцінки ризиків управління підприємством в кризових умовах", year: 2024,
  authors: ["V Babenko", "T Nazarova - International Science Journal of …", "2024"], venue: "isg-journal.com",
  lang: "uk", source: "scholar", url: "https://isg-journal.com/isjmef/article/view/774",
};

test("чистка авторів і назви видання", () => {
  assert.deepEqual(cleanAuthorList(LEGACY_HOLOVACH.authors), ["КС Головач"]);
  assert.deepEqual(cleanAuthorList(LEGACY_BABENKO.authors), ["V Babenko", "T Nazarova"]);
  assert.deepEqual(cleanAuthorList(["Іванов І. І.", "Smith J."]), ["Іванов І. І.", "Smith J."]);
  assert.equal(isBadVenue("ven.ztu.edu.ua"), true);
  assert.equal(isBadVenue("Актуальні питання …"), true);
  assert.equal(isBadVenue(""), true);
  assert.equal(isBadVenue("Економіка та суспільство"), false);
  assert.equal(cleanMetaText("Management, Economics &amp; Finance"), "Management, Economics & Finance");
  assert.equal(cleanMetaText("Effects of <i>Salmonella</i> &#8211; review"), "Effects of Salmonella – review");
  assert.equal(cleanMetaText("Діти < 5 років і > 10"), "Діти < 5 років і > 10", "не теги — не чіпаємо");
});

test("старі джерела Scholar: у ЛЛМ ідуть чисті автори й жодного обрізаного журналу", () => {
  const e = buildStructuredEntry(LEGACY_BABENKO);
  assert.deepEqual(e.authorsRaw, ["В Бабенко", "Т Назарова"]);
  assert.equal(e.journal, undefined);
  assert.doesNotMatch(JSON.stringify(e), /…|Скєнке|Йоурнал|Journal of/);
  const line = paperToCitation(LEGACY_HOLOVACH);
  assert.doesNotMatch(line, /…|2015\. Узагальнення|управління та/);
  assert.match(line, /^КС Головач\. Узагальнення/);
});

await test("перед оформленням списку назва журналу береться зі сторінки статті", async () => {
  let prompt = "";
  const fetchMeta = async url => (url.includes("ven.ztu") ? { journal: "«Вісник ЖДТУ»: Економіка, управління та адміністрування" } : null);
  const callClaude = async messages => {
    prompt = messages[0].content;
    const json = JSON.parse(prompt.split("\n").find(l => l.startsWith("1. {")).slice(3));
    return `1. Головач К. С. ${json.title}. *${json.journal}*. ${json.year}. С. 74–79. URL: ${json.url}`;
  };
  const raw = paperToCitation(LEGACY_HOLOVACH);
  const { finalTexts } = await buildFinalReferenceList({
    rawRefs: [raw], findStructured: () => LEGACY_HOLOVACH, sourcesStyle: "ДСТУ 8302:2015",
    isLatinWork: false, callClaude, fetchMeta,
  });
  assert.match(prompt, /"journal":"«Вісник ЖДТУ»: Економіка, управління та адміністрування"/);
  assert.match(prompt, /"authorsRaw":\["КС Головач"\]/);
  assert.equal(finalTexts[0], "Головач К. С. Узагальнення наукових підходів до поняття «криза на підприємстві». *«Вісник ЖДТУ»: Економіка, управління та адміністрування*. 2015. С. 74–79. URL: http://ven.ztu.edu.ua/article/view/50144");
});

console.log(`\n${passed} тестів пройшло`);
