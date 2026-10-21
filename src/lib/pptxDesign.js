// Дизайн-система презентацій: стилі (композиція) × палітри (кольори).
// Стиль і палітра обираються незалежно: slideData.design = { style, palette }.
// Якщо design не задано — обирає код (не ШІ): галузь з legacy-поля theme або
// з напряму роботи + детермінований хеш теми, щоб різні замовлення виглядали
// по-різному, а повторне завантаження того самого — однаково.

export const DESIGN_STYLES = {
  acad: {
    name: "Академічний",
    desc: "білий фон, сериф, тонкі лінії",
    fonts: { title: "Georgia", body: "Calibri" },
    palettes: [
      { bg: "FFFFFF", ink: "1B2A41", acc: "A8843A", acc2: "5B7AA6", soft: "EEF1F5", muted: "5B6576" },
      { bg: "FFFFFF", ink: "3B1F2B", acc: "8C2F39", acc2: "B08968", soft: "F4EEEF", muted: "6E5A60" },
      { bg: "FFFFFF", ink: "1F3B2D", acc: "4F7A5A", acc2: "A8843A", soft: "EDF3EF", muted: "5A6B61" },
    ],
  },
  geo: {
    name: "Геометрія",
    desc: "кола й трикутники, легкість",
    fonts: { title: "Century Gothic", body: "Century Gothic" },
    palettes: [
      { bg: "F6F8F9", ink: "16324F", acc: "1FA2A6", acc2: "F2A541", soft: "DDF1F1", muted: "56697A" },
      { bg: "FAF7F2", ink: "2B2D42", acc: "EF6F6C", acc2: "56A3A6", soft: "FBE3E2", muted: "666879" },
      { bg: "F5F6FB", ink: "1E1E3F", acc: "6C63FF", acc2: "FFB547", soft: "E6E4FF", muted: "5F5F7F" },
    ],
  },
  mag: {
    name: "Журнальний",
    desc: "асиметрія, великі цифри",
    fonts: { title: "Franklin Gothic Demi", body: "Calibri" },
    palettes: [
      { bg: "FBFBF8", ink: "141414", acc: "D64933", acc2: "7A7A72", soft: "F0EFEA", muted: "5C5C58" },
      { bg: "F7F8FA", ink: "101828", acc: "2E6FDB", acc2: "7A8494", soft: "EBEEF3", muted: "566072" },
      { bg: "FAF9F6", ink: "1C1C1C", acc: "2F8F6B", acc2: "7A7A72", soft: "EDF0EC", muted: "5A5E5B" },
    ],
  },
  dark: {
    name: "Темний преміум",
    desc: "темний фон, золото, сериф",
    fonts: { title: "Garamond", body: "Calibri Light" },
    palettes: [
      { bg: "13201B", ink: "F1EDE2", acc: "C9A961", acc2: "7FA392", soft: "1D2C26", muted: "A7B7AF" },
      { bg: "141A2E", ink: "EEF0F6", acc: "D4B26A", acc2: "8A9BD1", soft: "1E2640", muted: "A3AAC2" },
      { bg: "241717", ink: "F4ECE8", acc: "D9A38B", acc2: "B9867A", soft: "302121", muted: "BBA49C" },
    ],
  },
  cards: {
    name: "Картки",
    desc: "білі картки з тінню",
    fonts: { title: "Segoe UI Semibold", body: "Segoe UI" },
    palettes: [
      { bg: "EEF1F6", ink: "1D2433", acc: "2F5BEA", acc2: "8FA8F5", soft: "DDE6FD", muted: "5B6478" },
      { bg: "F2F0F7", ink: "231F33", acc: "7B4FD6", acc2: "B79BEA", soft: "EBE3FA", muted: "625C75" },
      { bg: "EEF4F2", ink: "15302A", acc: "1E8C6E", acc2: "7CC3AE", soft: "D6EEE5", muted: "56695F" },
    ],
  },
  bold: {
    name: "Сміливі блоки",
    desc: "великі кольорові площини",
    fonts: { title: "Arial Black", body: "Arial" },
    palettes: [
      { bg: "FFFFFF", ink: "1E1B4B", acc: "FF5A36", acc2: "FFD23F", soft: "FFF4E5", muted: "55537A" },
      { bg: "FFFFFF", ink: "0B3954", acc: "E4572E", acc2: "BFD7EA", soft: "EAF2F8", muted: "4F6B7D" },
      { bg: "FFFFFF", ink: "22223B", acc: "F28F3B", acc2: "8AC926", soft: "F3F9E8", muted: "5A5A72" },
    ],
  },
  pastel: {
    name: "Пастельний",
    desc: "м'які кольори, округлості",
    fonts: { title: "Corbel", body: "Corbel" },
    palettes: [
      { bg: "FFF7F2", ink: "3D3551", acc: "E8799C", acc2: "9ED9CC", acc3: "FFD27F", soft: "FDE3EC", muted: "6E6680" },
      { bg: "F5F7FF", ink: "2F3552", acc: "8C7BE8", acc2: "A7D8F0", acc3: "FFC9A8", soft: "E9E5FC", muted: "646A85" },
      { bg: "F6FBF5", ink: "2F4034", acc: "6DB58B", acc2: "F7C8B5", acc3: "F9E29C", soft: "DDF0E4", muted: "627366" },
    ],
  },
  blueprint: {
    name: "Креслення",
    desc: "сітка, штамп, моноширинний",
    fonts: { title: "Segoe UI Semibold", body: "Segoe UI", mono: "Consolas" },
    palettes: [
      { bg: "0F2A4A", ink: "EAF2FF", acc: "4FD1FF", acc2: "FFC857", soft: "173659", muted: "8FA8C8" },
      { bg: "12202B", ink: "E8F1F2", acc: "3DDC97", acc2: "FF9F43", soft: "1A2C3A", muted: "8AA3A8" },
      { bg: "1B1B2F", ink: "EDEAFF", acc: "A48BFF", acc2: "FFD166", soft: "25253F", muted: "9C97BF" },
    ],
  },
  organic: {
    name: "Природний",
    desc: "пагорби, листочки, сериф",
    fonts: { title: "Cambria", body: "Calibri" },
    palettes: [
      { bg: "F6F3EA", ink: "2E3B2C", acc: "5F8D4E", acc2: "D9A441", soft: "E3EBD6", muted: "66705F" },
      { bg: "F3F6F4", ink: "22333B", acc: "3E7C7B", acc2: "E07A5F", soft: "D9E8E6", muted: "5F6F72" },
      { bg: "F8F2EA", ink: "3B2F2A", acc: "A0522D", acc2: "7F9C5A", soft: "EFE0D2", muted: "6F625A" },
    ],
  },
  consulting: {
    name: "Консалтинговий",
    desc: "діловий, смуги-індикатори",
    fonts: { title: "Calibri", body: "Calibri" },
    palettes: [
      { bg: "FFFFFF", ink: "0B2545", acc: "13315C", acc2: "00A6A6", soft: "E8EEF4", muted: "5E6B7A" },
      { bg: "FFFFFF", ink: "1E1E24", acc: "2B2D42", acc2: "E63946", soft: "EDEDF1", muted: "63636E" },
      { bg: "FFFFFF", ink: "10261E", acc: "1B4332", acc2: "E9A23B", soft: "E7EFEA", muted: "5B6A62" },
    ],
  },
  orbit: {
    name: "Орбіта",
    desc: "мета в центрі, бульбашки",
    fonts: { title: "Trebuchet MS", body: "Trebuchet MS" },
    palettes: [
      { bg: "F7F7FB", ink: "232046", acc: "5B5BD6", acc2: "FF8A5B", soft: "E6E6FA", muted: "5F5C80" },
      { bg: "F5FAF9", ink: "12343B", acc: "1E9E8F", acc2: "F2B134", soft: "DCF1EE", muted: "56706F" },
      { bg: "FBF7F4", ink: "3A2A26", acc: "C8553D", acc2: "588B8B", soft: "F5E4DC", muted: "75625C" },
    ],
  },
  spread: {
    name: "Розворот",
    desc: "половина з головною думкою",
    fonts: { title: "Palatino Linotype", body: "Calibri" },
    palettes: [
      { bg: "FAF8F5", ink: "222222", acc: "7B2CBF", acc2: "C77DFF", soft: "F1E9FA", muted: "666360" },
      { bg: "F7F9F9", ink: "1D2A2E", acc: "0E7C86", acc2: "7CC6CC", soft: "E3F1F2", muted: "5E6B6E" },
      { bg: "FBF8F4", ink: "2A2320", acc: "B23A48", acc2: "E08E98", soft: "F6E6E7", muted: "6E625D" },
    ],
  },
  tree: {
    name: "Дерево",
    desc: "ієрархія: мета → завдання",
    fonts: { title: "Candara", body: "Candara" },
    palettes: [
      { bg: "F5F8F7", ink: "16302B", acc: "2A9D8F", acc2: "E76F51", soft: "DDEFEC", muted: "5C6F6B" },
      { bg: "F6F7FB", ink: "1F2544", acc: "4F5BD5", acc2: "F29E4C", soft: "E3E6FA", muted: "5F6480" },
      { bg: "F8F6F2", ink: "2F2A24", acc: "8A5A44", acc2: "5B8E7D", soft: "EFE6DD", muted: "6E655C" },
    ],
  },
};

export const STYLE_IDS = Object.keys(DESIGN_STYLES);

// Які стилі пасують галузі (сміливі блоки — не для суворих кафедр).
const FIELD_STYLES = {
  tech: ["geo", "cards", "mag", "bold", "dark", "blueprint", "orbit", "tree"],
  medicine: ["cards", "acad", "geo", "dark", "organic", "tree"],
  social: ["acad", "dark", "mag", "geo", "cards", "organic", "orbit", "spread", "tree", "pastel"],
  economics: ["mag", "cards", "acad", "dark", "geo", "consulting", "spread", "tree"],
  other: STYLE_IDS,
};

// Legacy-теми (старі slideJson і промпти досі повертають theme) → галузь.
const LEGACY_THEME_FIELD = { midnight: "tech", forest: "medicine", coral: "social", slate: "economics", warm: "other" };

function detectField(info) {
  const dir = ((info?.direction || "") + " " + (info?.subject || "")).toLowerCase();
  if (/it|інформ|програм|комп|tech|техн|систем|цифр/.test(dir)) return "tech";
  if (/медицин|біол|фарм|здоров|лікар/.test(dir)) return "medicine";
  if (/право|психол|соціол|педагог|гуманіт|мов|освіт|істор|філол/.test(dir)) return "social";
  if (/економ|менедж|фінанс|облік|маркет|бізнес/.test(dir)) return "economics";
  return "other";
}

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** Повертає валідний { style, palette } для slideData (явний вибір або автоматичний). */
export function resolveDesign(slideData, info) {
  const d = slideData?.design;
  if (d && DESIGN_STYLES[d.style]) {
    const n = DESIGN_STYLES[d.style].palettes.length;
    const palette = Number.isInteger(d.palette) && d.palette >= 0 && d.palette < n ? d.palette : 0;
    return { style: d.style, palette };
  }
  const field = LEGACY_THEME_FIELD[slideData?.theme] || detectField(info);
  const candidates = FIELD_STYLES[field] || STYLE_IDS;
  const seed = info?.topic || slideData?.slides?.[0]?.title || "";
  const h = hashStr(String(seed));
  const style = candidates[h % candidates.length];
  return { style, palette: (h >>> 8) % DESIGN_STYLES[style].palettes.length };
}
