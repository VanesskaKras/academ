// Браузерне сховище фото для рисунків-заглушок — підколекція orders/{id}/webImages
// (той самий формат, що пише воркер через worker/firestoreAdmin.js).
import { collection, doc, getDocs, setDoc, deleteDoc } from "firebase/firestore";
import { db } from "../firebase.js";
import { serializeForFirestore } from "./firestoreUtils.js";

export async function loadWebImagesClient(orderId) {
  const snap = await getDocs(collection(db, "orders", orderId, "webImages"));
  return snap.docs.map(d => d.data());
}

export async function saveWebImageClient(orderId, docId, record) {
  await setDoc(doc(db, "orders", orderId, "webImages", docId), serializeForFirestore(record));
}

export async function deleteWebImageClient(orderId, docId) {
  await deleteDoc(doc(db, "orders", orderId, "webImages", docId));
}
