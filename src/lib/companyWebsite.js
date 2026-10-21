// Офіційний сайт підприємства/установи (для профілю компанії у курсових/дипломах
// та для звіту з практики) — визначається кодом, без ШІ, у два кроки:
//   1) явний URL прямо в тексті матеріалів клієнта — найнадійніше джерело правди;
//   2) якщо в матеріалах його немає — url найрелевантнішого результату вже
//      виконаного пошуку компанії (Serper, companySearch.js), а не сподівання,
//      що модель сама коректно перенесе посилання зі сніпету в текст.
// Знайдений сайт додається як звичайне джерело в список літератури (той самий
// шлях, що й ECON_INSTITUTIONAL_SOURCES у sourcesSearch.js).
import { searchCompanyInfo } from "./companySearch.js";

const BLOCKED_HOST_SUFFIXES = [
  "facebook.com", "instagram.com", "linkedin.com", "youtube.com", "youtu.be",
  "twitter.com", "x.com", "tiktok.com", "t.me", "telegram.me", "viber.com",
  "wikipedia.org", "wikimedia.org", "prom.ua", "olx.ua", "rozetka.com.ua",
  "google.com", "goo.gl", "bit.ly",
];

const URL_RE = /\bhttps?:\/\/[^\s"'<>()]+|\bwww\.[a-zA-Z0-9-]+\.[a-zA-Z]{2,}(?:\/[^\s"'<>()]*)?/gi;

function normalizeUrl(raw) {
  const trimmed = raw.replace(/[.,;:!?)\]]+$/, "");
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function isBlockedHost(url) {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    return BLOCKED_HOST_SUFFIXES.some(d => host === d || host.endsWith(`.${d}`));
  } catch {
    return true;
  }
}

export function findWebsiteInText(text) {
  if (!text) return "";
  const matches = text.match(URL_RE) || [];
  for (const raw of matches) {
    const url = normalizeUrl(raw);
    if (!isBlockedHost(url)) return url;
  }
  return "";
}

export function pickWebsiteFromSearchResults(results) {
  for (const r of results || []) {
    if (r?.url && !isBlockedHost(r.url)) return r.url;
  }
  return "";
}

// Для звіту з практики назва підприємства вже відома від клієнта (поле "Місце
// практики"), тому можна шукати офіційний сайт напряму, без проміжного профілю.
export async function searchCompanyWebsite(companyName) {
  if (!companyName?.trim()) return "";
  const results = await searchCompanyInfo(`${companyName.trim()} офіційний сайт`, 5);
  return pickWebsiteFromSearchResults(results);
}

function detectLang(name) {
  const m = (name || "").trim().match(/^[«"']?([A-Za-zА-ЯҐЄІЇа-яґєії]+)/);
  if (!m) return "uk";
  const word = m[1];
  const lat = (word.match(/[A-Za-z]/g) || []).length;
  const cyr = (word.match(/[А-ЯҐЄІЇа-яґєії]/g) || []).length;
  return lat > cyr ? "en" : "uk";
}

// Той самий сирий формат, що й ECON_INSTITUTIONAL_SOURCES (sourcesSearch.js) —
// іде тим самим шляхом: paperToCitation → список джерел; source:'institutional'
// (не 'company-website' навмисно) — щоб автовставка (autoSelectSources /
// SourcesStage.jsx) визнавала його підтвердженим кодом, а не ШІ-оцінкою.
export function buildCompanyWebsiteSource(url, companyName) {
  return {
    id: "company-website",
    title: "Офіційний сайт",
    authors: [],
    year: new Date().getFullYear(),
    venue: companyName || "",
    pages: "",
    lang: detectLang(companyName),
    source: "institutional",
    abstract: "",
    url,
  };
}

// Текст профілю (doGenEconProfile) завжди починається з "Підприємство: <назва>".
export function extractCompanyNameFromProfile(profileText) {
  const m = (profileText || "").match(/Підприємство:\s*(.+)/);
  return m ? m[1].trim() : "";
}

// Титулка деяких методичок містить плейсхолдер типу "[НАЗВА ПІДПРИЄМСТВА]"
// ("на матеріалах [...]") для тем робіт "на матеріалах конкретного підприємства/
// організації". Назва підприємства (реальна, знайдена ШІ, чи умовна) стає
// відома лише пізніше, коли генерується профіль (doGenEconProfile) — тому цей
// токен підставляється заднім числом, як тільки профіль з'явився.
const ENTERPRISE_TOKEN_RE = /\[[^\]]*(?:ПІДПРИЄМСТВ|ОРГАНІЗАЦ)[^\]]*\]/i;

export function fillEnterpriseNameToken(text, profileText) {
  if (!text || !ENTERPRISE_TOKEN_RE.test(text)) return text;
  const name = extractCompanyNameFromProfile(profileText);
  if (!name) return text;
  return text.replace(new RegExp(ENTERPRISE_TOKEN_RE.source, "gi"), name);
}
