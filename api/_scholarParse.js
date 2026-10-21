// Розбір рядка Google Scholar "автори - журнал, рік - сайт" (поле publicationInfo у Serper).
// Раніше рядок ділився за ОСТАННІМ " - ": у "автори" потрапляла ще й назва журналу з
// роком ("T Nazarova - International Science Journal of …", "2024"), а "журналом" ставав
// домен сайту (isg-journal.com). Далі ШІ-оформлення списку переносило цей шматок назад на
// місце журналу — обрізаним Scholar-ом до "…" (а англійську назву ще й транслітерувало
// разом з авторами: "Інтернаціонал Скєнке Йоурнал оф …"). Чистий код без мережі.

const DOMAIN_RE = /^[\w-]+(\.[\w-]+)+$/i;
const YEAR_RE = /\b(?:19|20)\d{2}\b/;

// Scholar обрізає довгі назви журналів до "…" — така назва в списку літератури хибна
export function isTruncatedVenue(v) {
  return /(?:…|\.{3})\s*$/.test(String(v || "").trim());
}

/**
 * "V Babenko, T Nazarova - International Science Journal of …, 2024 - isg-journal.com" →
 * { authors: ["V Babenko", "T Nazarova"], venue: "", year: 2024, site: "isg-journal.com" }.
 * Обрізана ("…") назва журналу, домен чи сама лише назва сайту журналом не вважаються —
 * повну назву потім дає DOI (CrossRef) або сторінка статті (citation_journal_title).
 */
export function parseScholarPublicationInfo(pubInfo = "") {
  const parts = String(pubInfo).split(/\s+[-–]\s+/).map(s => s.trim()).filter(Boolean);
  const authorsPart = parts[0] || "";
  const rest = parts.slice(1);
  let venueYear = "";
  let site = "";
  if (rest.length >= 2) {
    site = rest[rest.length - 1];
    venueYear = rest.slice(0, -1).join(" - ");
  } else if (rest.length === 1) {
    if (YEAR_RE.test(rest[0])) venueYear = rest[0];
    else site = rest[0];
  }

  const yearM = venueYear.match(YEAR_RE) || String(pubInfo).match(YEAR_RE);
  let venue = venueYear.replace(/,?\s*\b(?:19|20)\d{2}\b.*$/, "").replace(/[,;]\s*$/, "").trim();
  if (!venue || DOMAIN_RE.test(venue) || isTruncatedVenue(venue)) venue = "";

  // "C Lee…" / "…" — Scholar обрізав список авторів; роки й уламки без прізвища — не автори
  const authors = authorsPart.split(",")
    .map(a => a.trim().replace(/\s*(?:…|\.{3})\s*$/, "").trim())
    .filter(a => a && !YEAR_RE.test(a) && /\p{L}{2,}/u.test(a))
    .slice(0, 3);

  return { authors, venue, year: yearM ? Number(yearM[0]) : null, site };
}
