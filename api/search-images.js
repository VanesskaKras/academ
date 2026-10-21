import sharp from "sharp";
import { requireAuth } from "./_auth.js";
import { safeFetch, isSafeUrl, readLimited } from "./_safeFetch.js";
// Пошук фото для рисунків-заглушок (src/lib/webImages.js): Google Images через
// Serper.dev → завантаження кращих кандидатів → стиснення в JPEG. Картинки
// завантажуємо тут, а не в браузері: більшість сайтів не віддає їх з CORS, а
// воркеру потрібен той самий шлях, що й UI. Вибір серед кандидатів робить ШІ
// вже на боці викликача.
export const config = { maxDuration: 30 };

const MAX_CANDIDATES = 6;
const MAX_DOWNLOADS = 10;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MIN_SHORT_SIDE = 300;
const OUT_MAX_DIM = 1000;

// Фотобанки (водяні знаки на прев'ю) і російські/білоруські домени — відсіюємо
// ще до завантаження; решту (текст російською на самій картинці тощо) перевіряє ШІ.
const BLOCKED_HOST_RE = /(^|\.)(shutterstock|depositphotos|istockphoto|gettyimages|dreamstime|alamy|123rf|vectorstock|canstockphoto|bigstockphoto|fotolia|pond5|agefotostock|superstock|megapixl|stock\.adobe)\.[a-z.]+$|\.(ru|by|su|xn--p1ai)$/i;

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ""; }
}

function isBlockedResult(item) {
  const img = item.imageUrl || "";
  if (!img || !isSafeUrl(img) || /\.svg(\?|$)/i.test(img)) return true;
  if (BLOCKED_HOST_RE.test(hostOf(img)) || BLOCKED_HOST_RE.test(hostOf(item.link || ""))) return true;
  const w = Number(item.imageWidth) || 0, h = Number(item.imageHeight) || 0;
  return w > 0 && h > 0 && Math.min(w, h) < MIN_SHORT_SIDE;
}

// Ключі Serper — той самий резерв, що в search-scholar.js: закінчились кредити чи
// ключ неробочий → наступний.
function serperKeys() {
  return [process.env.SERPER_API_KEY, process.env.SERPER_API_KEY_1, process.env.SERPER_API_KEY_2,
          process.env.SERPER_API_KEY_3, process.env.SERPER_API_KEY_4, process.env.SERPER_API_KEY_5]
    .map(k => (k || "").trim()).filter((k, i, a) => k && a.indexOf(k) === i);
}
function serperKeyDead(status, body) {
  return status === 401 || status === 403 || (status === 400 && /credits/i.test(body || ""));
}

async function searchImages(query, gl, hl, keys) {
  let lastErr = null;
  for (const apiKey of keys) {
    const res = await fetch("https://google.serper.dev/images", {
      method: "POST",
      headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ q: query, gl, hl, num: 20 }),
    });
    if (res.ok) {
      const data = await res.json();
      return data.images || [];
    }
    let msg = ""; try { msg = (await res.text()).slice(0, 160); } catch { /* no body */ }
    lastErr = new Error(`serper ${res.status}: ${msg}`); lastErr.serperStatus = res.status;
    if (!serperKeyDead(res.status, msg)) throw lastErr;
    console.warn(`serper key #${keys.indexOf(apiKey) + 1} dead (${res.status}) — next`);
  }
  throw lastErr || new Error("serper: no keys");
}

async function downloadCandidate(item) {
  try {
    const { res: r } = await safeFetch(item.imageUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
        "Accept": "image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8",
        ...(item.link ? { "Referer": item.link } : {}),
      },
    }, { timeoutMs: 7000 });
    const ct = r.headers.get("content-type") || "";
    if (!r.ok || !/^image\//i.test(ct) || /svg/i.test(ct)) {
      try { await r.body?.cancel(); } catch { /* ignore */ }
      return null;
    }
    const buf = await readLimited(r, MAX_IMAGE_BYTES);
    if (!buf) return null;
    const src = sharp(buf, { limitInputPixels: 60_000_000, animated: false });
    const meta = await src.metadata();
    if (!meta.width || !meta.height || Math.min(meta.width, meta.height) < MIN_SHORT_SIDE) return null;
    const { data, info } = await src.rotate()
      .resize(OUT_MAX_DIM, OUT_MAX_DIM, { fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: 80 })
      .toBuffer({ resolveWithObject: true });
    return {
      b64: data.toString("base64"), type: "image/jpeg", width: info.width, height: info.height,
      url: item.imageUrl, page: item.link || "", domain: item.domain || hostOf(item.link || item.imageUrl), title: item.title || "",
    };
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    return res.status(200).end();
  }
  if (req.method !== "POST") return res.status(405).end();
  if (!(await requireAuth(req, res))) return;

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  const keys = serperKeys();
  if (!keys.length) return res.status(200).json({ images: [] });

  const { query = "", gl = "ua", hl = "uk", exclude = [] } = req.body || {};
  if (typeof query !== "string" || !query.trim()) return res.status(200).json({ images: [] });
  const excluded = new Set(Array.isArray(exclude) ? exclude.filter(u => typeof u === "string") : []);

  let results;
  try {
    results = await searchImages(query.trim().slice(0, 300), String(gl).slice(0, 5), String(hl).slice(0, 5), keys);
  } catch (e) {
    console.error("search-images error:", e.message);
    return res.status(200).json({ images: [], ...(e.serperStatus ? { serperError: String(e.message).slice(0, 200) } : {}) });
  }

  const picked = results.filter(item => !isBlockedResult(item) && !excluded.has(item.imageUrl)).slice(0, MAX_DOWNLOADS);
  // паралельно, але порядок кандидатів — як у видачі Google (перші зазвичай найдоречніші)
  const downloaded = await Promise.all(picked.map(downloadCandidate));
  const images = downloaded.filter(Boolean).slice(0, MAX_CANDIDATES);
  return res.status(200).json({ images, searched: true });
}
