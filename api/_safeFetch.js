// Спільний безпечний fetch для проксі, що ходять на довільні адреси від клієнта
// (/api/fetch-meta, /api/pdf-pages). Захист від SSRF: лише http(s), жодних адрес
// локальної/внутрішньої мережі (loopback, link-local разом із cloud-metadata
// 169.254.169.254, приватні діапазони) — і перевірка повторюється на КОЖНОМУ
// редиректі та після DNS-резолву імені (раніше перевірявся лише текст першої адреси,
// а публічна адреса могла переадресувати чи резолвитись у внутрішню мережу).
import { lookup } from "node:dns/promises";
import net from "node:net";
import { Buffer } from "node:buffer";

export function withTimeout(promise, ms = 6000) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms)),
  ]);
}

function isPrivateIPv4(ip) {
  const [a, b] = ip.split(".").map(Number);
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local / cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // multicast / reserved
  return false;
}

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) return isPrivateIPv4(ip);
  const v6 = ip.toLowerCase();
  if (v6 === "::1" || v6 === "::") return true;
  if (v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe8") || v6.startsWith("fe9") || v6.startsWith("fea") || v6.startsWith("feb")) return true;
  const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIPv4(mapped[1]);
  return false;
}

export function isSafeUrl(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch { return false; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".internal")) return false;
  if (net.isIP(h) && isPrivateIp(h)) return false;
  return true;
}

async function resolvesToPublic(hostname) {
  const h = hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(h)) return !isPrivateIp(h);
  try {
    const addrs = await lookup(h, { all: true });
    return addrs.length > 0 && addrs.every(a => !isPrivateIp(a.address));
  } catch {
    return false;
  }
}

/**
 * fetch з ручним проходом редиректів (до maxRedirects), перевіркою кожної адреси й
 * таймаутом на кожен крок. Повертає { res, finalUrl } або кидає помилку.
 */
export async function safeFetch(url, init = {}, { maxRedirects = 5, timeoutMs = 7000 } = {}) {
  let current = url;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (!isSafeUrl(current)) throw new Error("blocked url");
    if (!(await resolvesToPublic(new URL(current).hostname))) throw new Error("blocked host");
    const res = await withTimeout(fetch(current, { ...init, redirect: "manual" }), timeoutMs);
    const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (!location) return { res, finalUrl: current };
    try { await res.body?.cancel(); } catch { /* тіло редиректу не потрібне */ }
    current = new URL(location, current).toString();
  }
  throw new Error("too many redirects");
}

// Читає тіло відповіді не більше maxBytes (далі обриває завантаження) → Buffer | null
export async function readLimited(res, maxBytes) {
  const declared = Number(res.headers.get("content-length") || 0);
  if (declared && declared > maxBytes) {
    try { await res.body?.cancel(); } catch { /* ignore */ }
    return null;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maxBytes) {
      try { await reader.cancel(); } catch { /* ignore */ }
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map(c => Buffer.from(c)));
}
