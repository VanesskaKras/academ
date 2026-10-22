// Крок воркера "фото з інтернету для рисунків-заглушок" — спільний для
// processOrder.js (великі роботи) і processSmallOrder.js (есе); у браузері той
// самий пошук робить src/lib/useWebImages.js. Знайдені фото — в
// orders/{id}/webImages, у .docx їх підставляє експорт (crmPipeline.js). Збій
// пошуку не валить готову роботу: рисунок лишається підписом, як і раніше.
import { saveWebImage } from "./firestoreAdmin.js";
import { findPlaceholderFigures, findWebImages, buildWebImageRecord } from "../src/lib/webImages.js";

export async function runWebImagesStep({ orderId, content, sections, lang, topic, skipSectionIds, callClaude, onCost, log }) {
  const figs = findPlaceholderFigures({ content, sections, lang, skipSectionIds });
  if (!figs.length) return;
  log(`→ Пошук фото для рисунків-заглушок (${figs.length})...`);
  let found = 0;
  await findWebImages(figs, {
    topic, lang, callClaude, onCost,
    onResult: async (fig, res) => {
      if (res?.image) {
        await saveWebImage(orderId, fig.docId, buildWebImageRecord(fig, res));
        found++;
        log(`  ✓ ${fig.caption}`);
      } else {
        log(`  – ${fig.caption}: ${res?.reason || "не оброблено"}`);
      }
    },
  });
  log(`  Фото підставлено: ${found} з ${figs.length}`);
}
