// Спільний рендер PlantUML-схем у PNG через api/render-diagram (Kroki) — раніше жив
// лише в exportDocx.js, тепер потрібен і exportPptx.js (схеми на слайдах презентації),
// тож винесений сюди, щоб не дублювати логіку виклику API/масштабування.
import { getApiBase, getProxyAuthHeaders } from "./api.js";

export const MONOCHROME_SKINPARAMS = "skinparam monochrome true\nskinparam shadowing false";

export function withMonochromeSkin(source) {
  if (/skinparam\s+monochrome/i.test(source)) return source;
  return source.replace(/^(\s*@startuml[^\n]*\n)/i, `$1${MONOCHROME_SKINPARAMS}\n`);
}

export function pngDimensions(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

export function b64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export function bytesToB64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

// Повертає {data: Uint8Array, b64: string, width, height} масштабовані під maxW×maxH,
// або null, якщо рендер не вдався (сервіс недоступний, невалідний PlantUML тощо) — виклик
// має бути готовий до null і показати заглушку замість схеми.
export async function renderPlantUmlToPng(source, maxW = 450, maxH = 550) {
  try {
    const res = await fetch(`${getApiBase()}/api/render-diagram`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await getProxyAuthHeaders()) },
      body: JSON.stringify({ source: withMonochromeSkin(source) }),
    });
    const data = await res.json();
    if (!data?.image) return null;
    const bytes = b64ToBytes(data.image);
    const { width, height } = pngDimensions(bytes);
    let w = width, h = height;
    if (w > maxW) { h = Math.round(h * maxW / w); w = maxW; }
    if (h > maxH) { w = Math.round(w * maxH / h); h = maxH; }
    return { data: bytes, b64: data.image, width: w, height: h };
  } catch {
    return null;
  }
}
