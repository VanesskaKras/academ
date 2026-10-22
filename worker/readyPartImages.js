// Стиснення рисунків готової частини (.docx від CRM) перед збереженням у orders/{id}.readyWorkImages.
// Рисунки готової частини лежать у самому документі orders/{id} (як illustrations) — посилання
// CRM на файл живе лише 24 год, а .docx перевивантажують і пізніше (DoneStage). Документ Firestore —
// до 1 МБ разом з текстом, тож на всі рисунки — ~600 КБ base64; що не влізло — лише підпис у роботі.
const READY_IMAGES_MAX_B64 = 600000;
const READY_IMAGE_MAX_DIM = 1400;

export async function compressReadyImages(images, log) {
  const { default: sharp } = await import("sharp");
  const out = [];
  let total = 0;
  for (const [n, img] of images.entries()) {
    let packed = null;
    try {
      const input = Buffer.from(img.b64, "base64");
      const base = () => sharp(input).rotate().resize(READY_IMAGE_MAX_DIM, READY_IMAGE_MAX_DIM, { fit: "inside", withoutEnlargement: true });
      // схеми з текстом — PNG (чіткіше); якщо PNG завеликий (фото) — JPEG на білому тлі
      const png = await base().png({ compressionLevel: 9 }).toBuffer();
      packed = png.length <= 200000
        ? { name: img.name, type: "image/png", b64: png.toString("base64") }
        : { name: img.name, type: "image/jpeg", b64: (await base().flatten({ background: "#ffffff" }).jpeg({ quality: 78 }).toBuffer()).toString("base64") };
    } catch (e) {
      log(`⚠ Рисунок ${n + 1} готової частини (${img.name}, ${img.type}) не вдалось перетворити — у роботі лишиться лише підпис: ${e.message}`);
    }
    if (packed && total + packed.b64.length > READY_IMAGES_MAX_B64) {
      log(`⚠ Рисунок ${n + 1} готової частини (${img.name}) не вміщається в ліміт документа — у роботі лишиться лише підпис.`);
      packed = null;
    }
    if (packed) total += packed.b64.length;
    out.push(packed); // індекс = N у маркері [ГОТОВА-ЧАСТИНА-РИСУНОК:N], тож null теж зберігаємо
  }
  return out;
}
