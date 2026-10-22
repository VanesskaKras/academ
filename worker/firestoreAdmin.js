// Підключення до Firestore з Node через firebase-admin (сервісний акаунт) —
// на відміну від браузерного src/firebase.js (клієнтський SDK, публічний
// конфіг, права через security rules прив'язані до автентифікованого
// користувача), тут повні права на читання/запис без прив'язки до браузера.
// Налаштування (GOOGLE_APPLICATION_CREDENTIALS тощо) — див. firebaseApp.js.
import { getFirestore } from "firebase-admin/firestore";
import { ensureApp } from "./firebaseApp.js";
import { registerLangProfile } from "../src/lib/planUtils.js";

function ordersCollection() {
  ensureApp();
  return getFirestore().collection("orders");
}

export async function loadOrder(orderId) {
  const snap = await ordersCollection().doc(orderId).get();
  if (!snap.exists) throw new Error(`Замовлення "${orderId}" не знайдено в Firestore (колекція orders)`);
  const order = { id: snap.id, ...snap.data() };
  // Мова роботи поза вбудованою таблицею — реєструємо збережений набір підписів (info.langProfile,
  // src/lib/langProfile.js), щоб усі етапи цього процесу бачили його через getLangLabels.
  registerLangProfile(order.info);
  return order;
}

// merge:true, як і саме saveToFirestore в academic-assistant.jsx; Firestore
// (як admin, так і клієнтський SDK) не приймає значення undefined в полях —
// відфільтровуємо їх, щоб патчі з orderStages.js (де частина полів
// умовно undefined) не падали з помилкою запису.
export async function saveOrderPatch(orderId, patch) {
  const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  await ordersCollection().doc(orderId).set({ ...clean, updatedAt: new Date().toISOString() }, { merge: true });
}

// ── Керування конвеєром (worker/pipeline.js) ────────────────────────────────
// Службовий документ поза колекцією orders — пауза стосується всього
// поллера, а не конкретного замовлення.
const PIPELINE_CONTROL_PATH = ["_system", "pipelineControl"];

export async function readPipelineControl() {
  ensureApp();
  const snap = await getFirestore().collection(PIPELINE_CONTROL_PATH[0]).doc(PIPELINE_CONTROL_PATH[1]).get();
  return snap.exists ? snap.data() : { paused: false };
}

export async function setPipelinePaused(paused) {
  ensureApp();
  await getFirestore().collection(PIPELINE_CONTROL_PATH[0]).doc(PIPELINE_CONTROL_PATH[1])
    .set({ paused, updatedAt: new Date().toISOString() }, { merge: true });
}

// Лок протухає через LOCK_STALE_MS — якщо процес впав або перезапустився,
// не тримаючи чужий лок вічно, наступний тік поллера зможе забрати
// замовлення знову.
const LOCK_STALE_MS = 20 * 60 * 1000;

function isLockStale(lockedAt) {
  if (!lockedAt) return true;
  return Date.now() - new Date(lockedAt).getTime() > LOCK_STALE_MS;
}

// Бере наступне замовлення, позначене для автообробки (autoPipeline:true,
// поки тимчасова заміна CRM-кроку "менеджер додав автора Academ Assist"),
// не завершене й не захоплене іншим інстансом поллера. Захоплення —
// транзакцією, щоб два паралельні перезапуски процесу не взяли одне й те
// саме замовлення одночасно.
export async function claimNextOrder(workerId) {
  ensureApp();
  const db = getFirestore();
  const snap = await db.collection("orders").where("autoPipeline", "==", true).get();
  const candidates = snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(o => o.stage !== "done" && o.status !== "error" && isLockStale(o.pipelineLockedAt))
    .sort((a, b) => new Date(a.updatedAt || 0) - new Date(b.updatedAt || 0));

  for (const candidate of candidates) {
    const ref = db.collection("orders").doc(candidate.id);
    const claimed = await db.runTransaction(async (tx) => {
      const doc = await tx.get(ref);
      const data = doc.data();
      if (!data || !isLockStale(data.pipelineLockedAt)) return false; // хтось встиг захопити першим
      tx.set(ref, { pipelineLockedAt: new Date().toISOString(), pipelineLockedBy: workerId }, { merge: true });
      return true;
    });
    if (claimed) return candidate.id;
  }
  return null;
}

export async function releaseLock(orderId) {
  ensureApp();
  await ordersCollection().doc(orderId).set({ pipelineLockedAt: null, pipelineLockedBy: null }, { merge: true });
}

// Освіжає pipelineLockedAt під час обробки (викликається періодично з
// pipeline.js) — щоб довге замовлення не виглядало протухлим (isLockStale)
// для інших інстансів поллера ще до завершення обробки.
export async function touchLock(orderId, workerId) {
  ensureApp();
  await ordersCollection().doc(orderId).set({ pipelineLockedAt: new Date().toISOString(), pipelineLockedBy: workerId }, { merge: true });
}

// Один рядок витрат на один виклик API (стадія + модель + токени + $) — щоб
// потім було видно, куди йдуть гроші всередині замовлення. Доповнює
// сумарний totalCostUsd на самому orders/{id} (tokenAccumulator.js), не
// замінює його.
export async function appendCostEntry(orderId, entry) {
  ensureApp();
  await ordersCollection().doc(orderId).collection("costs").add({ ...entry, at: new Date().toISOString() });
}

export async function getCostsForOrder(orderId) {
  ensureApp();
  const snap = await ordersCollection().doc(orderId).collection("costs").get();
  return snap.docs.map(d => d.data());
}

// Фото з інтернету для рисунків-заглушок (src/lib/webImages.js) — окрема
// підколекція, по документу на картинку: у самому orders/{id} (ліміт 1 МБ) їх
// не вмістити поруч із текстом і рисунками готової частини.
export async function saveWebImage(orderId, docId, record) {
  ensureApp();
  await ordersCollection().doc(orderId).collection("webImages").doc(docId).set(record);
}

export async function loadWebImages(orderId) {
  ensureApp();
  const snap = await ordersCollection().doc(orderId).collection("webImages").get();
  return snap.docs.map(d => d.data());
}
