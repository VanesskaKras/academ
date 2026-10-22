// Інтеграційний (не юніт-) тест storage.js — реальний Firebase Storage, не
// мок: сенс перевірки саме в тому, що upload/download/delete справді
// працюють проти живого бакета. Потребує тих самих змінних середовища, що
// й worker/runOrder.js (GOOGLE_APPLICATION_CREDENTIALS, FIREBASE_PROJECT_ID,
// FIREBASE_STORAGE_BUCKET). Заливає й одразу прибирає тестовий файл під
// шляхом test/ — не займає нічого з реальних даних.
// Запуск: node worker/storage.test.js
import assert from "node:assert/strict";
import { uploadFile, downloadFile, deleteFile } from "./storage.js";

const testPath = `test/storage-test-${Date.now()}.txt`;
const original = Buffer.from(`тестовий вміст, ${new Date().toISOString()}`, "utf8");

async function main() {
  console.log(`→ Заливаю ${testPath}...`);
  const url = await uploadFile(original, testPath, "text/plain; charset=utf-8");
  console.log(`  URL: ${url.slice(0, 80)}...`);
  assert.ok(url.startsWith("https://"), "має повернути справжній https URL");

  console.log("→ Довантажую назад...");
  const roundtrip = await downloadFile(url);
  assert.equal(roundtrip.toString("utf8"), original.toString("utf8"), "вміст після round-trip має збігатись побайтово");

  console.log("→ Прибираю тестовий файл...");
  await deleteFile(testPath);

  console.log("\n✓ storage.js: upload → download → delete — усе працює");
}

main().catch(e => {
  console.error("\n✗ FAIL:", e.message);
  console.error(e.stack);
  process.exitCode = 1;
});
