// Тести автопідбору фото для рисунків-заглушок (webImages.js): що саме вважається
// заглушкою, стабільність ключа рисунка після перенумерації, і що експорт .docx
// ставить знайдене фото над підписом. Запуск: node src/lib/webImages.test.js
import assert from "node:assert/strict";
import JSZip from "jszip";
import sharp from "sharp";
import { findPlaceholderFigures, parseFigureCaption, webImageKey, webImageDocId, findWebImageForFigure, findSlideImageSlots, buildWebImageSlides, resolveSlideWebImages, SIMPLE_WORK_SECTION_ID } from "./webImages.js";
import { exportToDocx, exportSimpleDocx } from "./exportDocx.js";

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (err) {
    console.error(`FAIL - ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

const SECTIONS = [
  { id: "1.1", label: "1.1 Теорія", type: "theory" },
  { id: "1.2", label: "1.2 Готова частина", type: "theory" },
  { id: "2.1", label: "2.1 Аналіз", type: "analysis" },
];

const CONTENT = {
  "1.1": [
    "Будівлю театру зведено у 1901 році, її фасад показано на рис. 1.1.",
    "",
    "Рис. 1.1 – Фасад Національної опери України",
    "",
    "Динаміку відвідуваності наведено на рис. 1.2.",
    "| Рік | Глядачі |",
    "|---|---|",
    "| 2023 | 120 |",
    "",
    "Рис. 1.2 – Динаміка відвідуваності театру",
    "",
    "```plantuml",
    "@startuml",
    "A -> B",
    "@enduml",
    "```",
    "Рис. 1.3 – Схема взаємодії",
    "",
    "[КЛІЄНТ-ІЛЮСТРАЦІЯ:0]",
    "Рис. 1.4 – Фото клієнта",
    "",
    "Рис. 1.5 демонструє, що підпису тут немає, це звичайне речення.",
    "",
    "Рис. 1.6 – Структура опитаних респондентів (складено автором)",
  ].join("\n"),
  "1.2": "Рис. 1.7 – Рисунок з готової частини",
  "2.1": "Згідно з рис. 2.1, логотип компанії впізнаваний.\n\nРис. 2.1 – Логотип компанії «Нова Пошта».",
};

await test("заглушка — лише підпис без таблиці, схеми чи маркера над ним", () => {
  const figs = findPlaceholderFigures({ content: CONTENT, sections: SECTIONS, lang: "Українська", skipSectionIds: ["1.2"] });
  assert.deepEqual(figs.map(f => f.caption), [
    "Рис. 1.1 – Фасад Національної опери України",
    "Рис. 2.1 – Логотип компанії «Нова Пошта».",
  ]);
});

await test("контекст — речення з посиланням на рисунок, назва без крапки в кінці", () => {
  const [first, second] = findPlaceholderFigures({ content: CONTENT, sections: SECTIONS, lang: "Українська", skipSectionIds: ["1.2"] });
  assert.equal(first.context, "Будівлю театру зведено у 1901 році, її фасад показано на рис. 1.1.");
  assert.equal(second.name, "Логотип компанії «Нова Пошта»");
  assert.equal(second.secId, "2.1");
});

await test("готова частина клієнта не заповнюється (skipSectionIds)", () => {
  const withReady = findPlaceholderFigures({ content: CONTENT, sections: SECTIONS, lang: "Українська" });
  assert.ok(withReady.some(f => f.secId === "1.2"));
  const skipped = findPlaceholderFigures({ content: CONTENT, sections: SECTIONS, lang: "Українська", skipSectionIds: ["1.2"] });
  assert.ok(!skipped.some(f => f.secId === "1.2"));
});

await test("ключ рисунка не залежить від номера й апострофа", () => {
  const a = parseFigureCaption("Рис. 1.1 – Об'єкт дослідження", "Рис.");
  const b = parseFigureCaption("Рис. 1.4 – Об’єкт дослідження.", "Рис.");
  assert.equal(webImageKey("1.1", a.name), webImageKey("1.1", b.name));
  assert.notEqual(webImageKey("1.1", a.name), webImageKey("2.1", a.name));
  assert.ok(!webImageDocId(webImageKey("1.1", a.name)).includes("/"));
});

async function docxMediaCount(params) {
  const { buffer } = await exportToDocx(params);
  const zip = await JSZip.loadAsync(buffer);
  return Object.keys(zip.files).filter(n => n.startsWith("word/media/") && !zip.files[n].dir).length;
}

await test("експорт .docx ставить знайдене фото над підписом-заглушкою", async () => {
  const jpeg = await sharp({ create: { width: 400, height: 300, channels: 3, background: "#8899aa" } }).jpeg().toBuffer();
  const content = { "1.1": "Фасад показано на рис. 1.3.\n\nРис. 1.1 – Фасад Національної опери України" };
  const params = {
    content, info: { language: "Українська", topic: "Тест" },
    displayOrder: [{ id: "1.1", label: "1.1 Теорія", type: "theory" }], orderId: "test",
  };
  const [fig] = findPlaceholderFigures({ content, sections: params.displayOrder, lang: "Українська" });
  const record = { key: fig.key, secId: "1.1", b64: jpeg.toString("base64"), type: "image/jpeg" };
  assert.equal(await docxMediaCount(params), 0);
  assert.equal(await docxMediaCount({ ...params, webImages: [record] }), 1);
  // картинка чужого рисунка (інша назва) — не вставляється
  assert.equal(await docxMediaCount({ ...params, webImages: [{ ...record, key: webImageKey("1.1", "Інший рисунок") }] }), 0);
});

await test("вибір ШІ: картинки йдуть у запит, відповідь розбирається, «жоден» — без фото", async () => {
  const realFetch = globalThis.fetch;
  let sentBody = null;
  globalThis.fetch = async (url, init) => {
    assert.ok(String(url).endsWith("/api/search-images"));
    sentBody = JSON.parse(init.body);
    return { ok: true, json: async () => ({ searched: true, images: [
      { b64: "AAA", type: "image/jpeg", url: "https://a.ua/1.jpg", page: "https://a.ua/p1", domain: "a.ua" },
      { b64: "BBB", type: "image/jpeg", url: "https://b.ua/2.jpg", page: "https://b.ua/p2", domain: "b.ua" },
    ] }) };
  };
  try {
    let seen = null;
    const costs = [];
    const pick = (answer) => async (messages) => { seen = messages; return answer; };
    const fig = { name: "Фасад театру", caption: "Рис. 1.1 – Фасад театру", context: "Фасад показано на рис. 1.1." };
    const found = await findWebImageForFigure(fig, { topic: "Т", lang: "Українська", callClaude: pick('{"choice": 2, "reason": "саме цей фасад"}'), onCost: d => costs.push(d), exclude: ["https://x.ua/0.jpg"] });
    assert.equal(found.image.url, "https://b.ua/2.jpg");
    assert.deepEqual(found.tried, ["https://a.ua/1.jpg", "https://b.ua/2.jpg"]);
    assert.deepEqual(sentBody, { query: "Фасад театру", hl: "uk", gl: "ua", exclude: ["https://x.ua/0.jpg"] });
    const images = seen[0].content.filter(b => b.type === "image");
    assert.equal(images.length, 2);
    assert.deepEqual(images[1].source, { type: "base64", media_type: "image/jpeg", data: "BBB" });
    assert.equal(costs[0].model, "serper");
    const none = await findWebImageForFigure(fig, { topic: "Т", lang: "Українська", callClaude: pick('{"choice": null, "reason": "дані роботи"}') });
    assert.equal(none.image, null);
    assert.equal(none.reason, "дані роботи");
  } finally {
    globalThis.fetch = realFetch;
  }
});

await test("спрощений .docx (есе, тези): фото над підписом-заглушкою", async () => {
  const jpeg = await sharp({ create: { width: 400, height: 300, channels: 3, background: "#aa9988" } }).jpeg().toBuffer();
  const text = "Логотип показано на рис. 1.\n\nРис. 1 – Логотип компанії «Нова Пошта»\n\nДалі текст.";
  const args = { content: { [SIMPLE_WORK_SECTION_ID]: text }, sections: [{ id: SIMPLE_WORK_SECTION_ID }], lang: "Українська" };
  const [fig] = findPlaceholderFigures(args);
  assert.equal(fig.name, "Логотип компанії «Нова Пошта»");
  const params = { title: "Тест", sections: [{ label: "", text }], info: { language: "Українська" }, orderId: "t", pageNumbers: false };
  const count = async (p) => {
    const zip = await JSZip.loadAsync((await exportSimpleDocx(p)).buffer);
    return Object.keys(zip.files).filter(n => n.startsWith("word/media/") && !zip.files[n].dir).length;
  };
  assert.equal(await count(params), 0);
  assert.equal(await count({ ...params, webImages: [{ key: fig.key, b64: jpeg.toString("base64"), type: "image/jpeg" }] }), 1);
});

await test("презентація: жовті блоки й слайди-ілюстрації отримують фото лише при експорті", () => {
  const slides = [
    { layout: "hero", title: "Тема" },
    { layout: "image_placeholder", title: "Об'єкт", image: "Будівля музею" },
    { layout: "two_column", title: "Порівняння", left: "Текст", right_type: "image", image: "Схема метро" },
    { layout: "image_placeholder", title: "Фото замовника", image: { b64: "CLIENT", type: "image/png" } },
  ];
  const slots = findSlideImageSlots(slides);
  assert.deepEqual(slots.map(s => s.name), ["Будівля музею", "Схема метро"]);
  const workFig = { key: webImageKey("1.1", "Фасад театру"), name: "Фасад театру" };
  const webImages = [
    { key: slots[0].key, b64: "MUSEUM", type: "image/jpeg" },
    { key: workFig.key, b64: "THEATRE", type: "image/jpeg" },
  ];
  const webSlides = buildWebImageSlides([workFig, { key: "1.1::інше", name: "Інше" }], webImages);
  assert.equal(webSlides.length, 1);
  assert.equal(webSlides[0].image.b64, undefined); // у збережених слайдах — лише посилання
  const resolved = resolveSlideWebImages({ slides: [...slides, ...webSlides] }, webImages).slides;
  assert.equal(resolved[1].image.b64, "MUSEUM");
  assert.equal(resolved[2].image, "Схема метро"); // фото не знайшли — лишається жовтий блок з підписом
  assert.equal(resolved[3].image.b64, "CLIENT");
  assert.equal(resolved[4].image.b64, "THEATRE");
  // фото роботи прибрали — слайд-ілюстрація зникає
  assert.equal(resolveSlideWebImages({ slides: [...slides, ...webSlides] }, [webImages[0]]).slides.length, 4);
});

console.log(`\n${passed} passed`);
