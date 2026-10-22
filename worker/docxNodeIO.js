// Node-реалізація { JSZip, DOMParser, XMLSerializer } для src/lib/docxSurgicalEdit.js
// і src/lib/docxAnnotations.js — ті самі функції, що редагують .docx у браузері
// (кнопка "Правки"), тут отримують ін'єкцію замість window.JSZip/CDN-скрипта і
// глобального DOMParser/XMLSerializer. Живе лише в worker/ (як materialsExtract.js),
// тож Vite цей файл не бачить і не намагається бандлити jszip/@xmldom/xmldom для браузера.
//
// compressImage — стиснення фото зауважень перед відправкою в Claude (API
// відхиляє зображення понад 5 МБ, а фото з телефона часто більші; HEIC API
// взагалі не приймає). У браузері те саме робить canvas (correctionAgent.js).
import JSZip from "jszip";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";

async function compressImage({ name, b64 }) {
  const sharp = (await import("sharp")).default; // лише коли справді є що стискати
  const out = await sharp(Buffer.from(b64, "base64"))
    .rotate()
    .resize({ width: 2000, height: 2000, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer();
  return { name, type: "image/jpeg", b64: out.toString("base64") };
}

export function getDocxNodeIO() {
  return { JSZip, DOMParser, XMLSerializer, compressImage };
}
