import JSZip from "jszip";

// Витягує текст зі слайдів .pptx (по порядку slide1, slide2, ...) —
// для доповіді, коли клієнт замість DOCX/PDF надсилає готову презентацію.
// Ізоморфний хелпер: викликається і з браузера (small-works.jsx), і з
// Node-воркера (smallStages.js) — тому приймає base64 напряму (JSZip сам
// вміє base64 в обох середовищах, без ручного decode в bytes/Buffer).
const ENTITY_MAP = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decodeXmlEntities = (s) => s.replace(/&(amp|lt|gt|quot|apos);/g, (_, e) => ENTITY_MAP[e]);

export async function extractPptxText(base64) {
  const zip = await JSZip.loadAsync(base64, { base64: true });
  const slideFiles = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => {
      const na = parseInt(a.match(/slide(\d+)\.xml$/)[1], 10);
      const nb = parseInt(b.match(/slide(\d+)\.xml$/)[1], 10);
      return na - nb;
    });

  const slides = [];
  for (let i = 0; i < slideFiles.length; i++) {
    const xml = await zip.files[slideFiles[i]].async("text");
    const runs = [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => decodeXmlEntities(m[1]));
    const text = runs.join(" ").replace(/\s+/g, " ").trim();
    if (text) slides.push(`Слайд ${i + 1}:\n${text}`);
  }
  return slides.join("\n\n").trim();
}
