// Стан фото з інтернету для рисунків-заглушок на сторінці замовлення — спільний для
// academic-assistant.jsx, PracticePage.jsx і small-works.jsx (реферат): завантаження
// з orders/{id}/webImages, автопошук після фінального оформлення тексту, кнопки
// "Інше"/"Прибрати"/"Шукати фото" в панелі (components/WebImagesPanel.jsx).
import { useState, useRef, useCallback } from "react";
import { callClaude } from "./api.js";
import { findPlaceholderFigures, findWebImages, findWebImageForFigure, buildWebImageRecord } from "./webImages.js";
import { loadWebImagesClient, saveWebImageClient, deleteWebImageClient } from "./webImagesStore.js";

const STORE_ERROR = "Фото не вдалось зберегти в базі (перевірте правила Firestore для orders/{id}/webImages) — у .docx з цієї сторінки воно буде, але після перезавантаження зникне.";

export function useWebImages({ getOrderId, saveOrderPatch }) {
  const [webImages, setWebImages] = useState([]);
  const [webImagesDone, setWebImagesDone] = useState(false);
  const [webImagesBusy, setWebImagesBusy] = useState(false);
  const [busyKeys, setBusyKeys] = useState({});
  const [notes, setNotes] = useState({});
  const [storeError, setStoreError] = useState("");
  const imagesRef = useRef([]);
  const doneRef = useRef(false);
  const runningRef = useRef(false);

  const apply = (next) => { imagesRef.current = next; setWebImages(next); };
  const upsert = (rec) => apply([...imagesRef.current.filter(w => w.key !== rec.key), rec]);
  const note = (key, text) => setNotes(n => ({ ...n, [key]: text }));
  const markDone = (flag) => { doneRef.current = flag; setWebImagesDone(flag); };

  const persist = async (orderId, docId, rec) => {
    try { await saveWebImageClient(orderId, docId, rec); }
    catch (e) { console.warn("webImages save:", e.message); setStoreError(STORE_ERROR); }
  };

  const reset = () => { apply([]); markDone(false); setNotes({}); setStoreError(""); };

  // стабільна (useCallback) — її викликає ефект завантаження замовлення на сторінках
  const load = useCallback(async (orderId, doneFlag) => {
    doneRef.current = !!doneFlag;
    setWebImagesDone(!!doneFlag);
    let list = [];
    try { list = await loadWebImagesClient(orderId); }
    catch (e) { console.warn("webImages load:", e.message); }
    imagesRef.current = list;
    setWebImages(list);
  }, []);

  // Пошук для готового списку рисунків (чи слотів презентації — findSlideImageSlots);
  // ті, для яких фото вже є, пропускаються. Повертає false, якщо пошук уже йде.
  const searchFigs = async (figs, { lang, topic }) => {
    const orderId = getOrderId();
    if (!orderId || runningRef.current) return false;
    const todo = figs.filter(f => !imagesRef.current.some(w => w.key === f.key));
    runningRef.current = true;
    setWebImagesBusy(true);
    try {
      await findWebImages(todo, {
        topic, lang, callClaude,
        onResult: async (fig, res) => {
          if (res?.image) {
            const rec = buildWebImageRecord(fig, res);
            upsert(rec);
            await persist(orderId, fig.docId, rec);
          } else {
            note(fig.key, res?.reason ? `Фото не знайдено: ${res.reason}` : "Фото не знайдено");
          }
        },
      });
      return true;
    } finally {
      runningRef.current = false;
      setWebImagesBusy(false);
    }
  };

  // Рисунки-заглушки тексту роботи. auto:true — виклик одразу після фінального оформлення:
  // лише раз на замовлення (замовлення з CRM, де воркер уже шукав, не шукаємо вдруге — .docx
  // має збігатися).
  const searchAll = async ({ content, sections, lang, topic, skipSectionIds, auto = false }) => {
    if (auto && doneRef.current) return;
    const figs = findPlaceholderFigures({ content, sections, lang, skipSectionIds });
    if (!(await searchFigs(figs, { lang, topic }))) return;
    markDone(true);
    await saveOrderPatch({ webImagesDone: true });
  };

  // Один рисунок: "Інше" (є фото — шукаємо, пропускаючи вже показані кандидати) або
  // "Шукати фото" (фото ще немає).
  const searchOne = async (fig, { lang, topic }) => {
    const orderId = getOrderId();
    if (!orderId) return;
    const prev = imagesRef.current.find(w => w.key === fig.key);
    const exclude = [...new Set([...(prev?.tried || []), ...(prev?.url ? [prev.url] : [])])];
    setBusyKeys(b => ({ ...b, [fig.key]: true }));
    note(fig.key, "");
    try {
      const res = await findWebImageForFigure(fig, { topic, lang, callClaude, exclude });
      if (res.image) {
        const rec = buildWebImageRecord(fig, { ...res, tried: [...exclude, ...res.tried] });
        upsert(rec);
        await persist(orderId, fig.docId, rec);
      } else {
        note(fig.key, prev ? "Іншого відповідного фото не знайдено — лишається попереднє" : `Фото не знайдено${res.reason ? `: ${res.reason}` : ""}`);
      }
    } catch (e) {
      note(fig.key, `Помилка пошуку: ${e.message}`);
    } finally {
      setBusyKeys(b => { const { [fig.key]: _done, ...rest } = b; return rest; });
    }
  };

  const remove = async (fig) => {
    const orderId = getOrderId();
    apply(imagesRef.current.filter(w => w.key !== fig.key));
    note(fig.key, "Фото прибрано — у файлі лишиться лише підпис");
    if (!orderId) return;
    try { await deleteWebImageClient(orderId, fig.docId); }
    catch (e) { console.warn("webImages delete:", e.message); setStoreError(STORE_ERROR); }
  };

  return {
    webImages, webImagesDone, webImagesBusy, busyKeys, notes, storeError,
    load, reset, searchAll, searchFigs, searchOne, remove,
  };
}
