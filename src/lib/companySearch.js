import { getApiBase, getProxyAuthHeaders } from "./api.js";

// Пошук реального підприємства у відкритих джерелах (проксі /api/search-company,
// Serper.dev) — для doGenEconProfile, коли клієнт не надав власних матеріалів по
// підприємству. Повертає сирі сніпети пошуку (title/snippet/url), без парсингу —
// модель сама обирає підходящу компанію й витягує з них реальні дані.
export async function searchCompanyInfo(query, limit = 8) {
  try {
    const res = await fetch(`${getApiBase()}/api/search-company`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await getProxyAuthHeaders()) },
      body: JSON.stringify({ query, limit }),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data.results) ? data.results : [];
  } catch {
    return [];
  }
}
