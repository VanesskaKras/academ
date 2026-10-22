// Firebase Storage з Node через firebase-admin — для майбутнього CRM-шляху:
// замість заливання файлів (методичка, приклад роботи) у Firestore-документ
// (жорсткий ліміт 1 МБ, обходили в runAnalyzeStage через resolveFileBytes),
// файл лежить у Storage, а в Firestore/у payload CRM передається лише URL.
// Наразі ніде не підключено до живого потоку — самої CRM-інтеграції ще
// немає, це лише готова інфраструктура під той самий resolveFileBytes.
import { getStorage } from "firebase-admin/storage";
import { ensureApp } from "./firebaseApp.js";

function bucket() {
  ensureApp();
  if (!process.env.FIREBASE_STORAGE_BUCKET) {
    throw new Error(
      "FIREBASE_STORAGE_BUCKET не задано — те саме значення, що й VITE_FIREBASE_STORAGE_BUCKET у .env " +
      "(напр. writemate-1b972.firebasestorage.app)."
    );
  }
  return getStorage().bucket();
}

/**
 * Заливає буфер у Storage і повертає підписаний (тривалий) URL для читання —
 * саме такий URL очікує resolveFileBytes() в src/lib/orderStages.js.
 * @param {Buffer} buffer
 * @param {string} destPath - шлях у бакеті, напр. "orders/41280/methodichka.pdf"
 * @param {string} contentType - напр. "application/pdf"
 * @returns {Promise<string>} URL для читання (діє 1 рік)
 */
export async function uploadFile(buffer, destPath, contentType) {
  const file = bucket().file(destPath);
  await file.save(buffer, { contentType, resumable: false });
  const [url] = await file.getSignedUrl({ action: "read", expires: Date.now() + 365 * 24 * 60 * 60 * 1000 });
  return url;
}

// Довантаження за URL — для симетрії й тестів; той самий підхід, що вже
// використовує resolveFileBytes() (звичайний fetch, підписаний URL публічно читається).
export async function downloadFile(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Не вдалось завантажити файл зі Storage (${res.status}): ${url}`);
  const buf = await res.arrayBuffer();
  return Buffer.from(buf);
}

export async function deleteFile(destPath) {
  await bucket().file(destPath).delete({ ignoreNotFound: true });
}
