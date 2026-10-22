// Спільна ініціалізація firebase-admin — і firestoreAdmin.js, і storage.js
// мають користуватись ОДНИМ і тим самим App (initializeApp вдруге на той
// самий процес кидає помилку), тому винесено окремо замість дублювання.
//
// Потрібно перед запуском:
//   1. Firebase Console → Project Settings → Service Accounts → Generate new
//      private key → зберегти JSON-файл десь ЛОКАЛЬНО (не комітити в git!).
//   2. Встановити змінні середовища:
//        GOOGLE_APPLICATION_CREDENTIALS=шлях/до/service-account.json
//        FIREBASE_PROJECT_ID=той самий projectId, що й у src/firebase.js
//        FIREBASE_STORAGE_BUCKET=той самий VITE_FIREBASE_STORAGE_BUCKET (для storage.js)
import { initializeApp, applicationDefault, getApps } from "firebase-admin/app";

export function ensureApp() {
  if (getApps().length) return;
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    throw new Error(
      "GOOGLE_APPLICATION_CREDENTIALS не задано — потрібен шлях до JSON-ключа сервісного акаунта Firebase " +
      "(Firebase Console → Project Settings → Service Accounts → Generate new private key)."
    );
  }
  initializeApp({
    credential: applicationDefault(),
    projectId: process.env.FIREBASE_PROJECT_ID,
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  });
}
