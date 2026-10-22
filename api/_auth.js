// Спільна авторизація для /api/claude, /api/gemini, /api/gemini-files-init —
// без цього будь-хто з інтернету, знаючи URL, міг безкоштовно споживати
// ANTHROPIC_API_KEY / GEMINI_API_KEY* з бюджету проєкту (CORS був "*", жодної
// перевірки токена). Два шляхи авторизації:
//   1. Браузер (UI) — Firebase ID token залогіненого користувача, перевіряється
//      через firebase-admin (той самий проєкт, що й src/firebase.js).
//   2. Воркер — окремий статичний секрет WORKER_PROXY_TOKEN (той самий підхід,
//      що ACADEM_WORKER_TOKEN для звернень worker → CRM, worker/crmClient.js).
//      Потрібен, навіть коли воркер працює з DIRECT_API=1: кілька викликів у
//      src/lib/sourcesSearch.js (фільтрація джерел) завжди йдуть через цей
//      проксі напряму fetch'ем, а не через callClaude/callGemini.
import { getApps, initializeApp, cert } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

function ensureAdminApp() {
  if (getApps().length) return;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT не задано — потрібен JSON-ключ сервісного акаунта Firebase (той самий, що для воркера)");
  // Приймаємо або сирий JSON, або його base64 (стійкіше до пошкодження лапок/переносів у UI)
  const text = raw.trim().startsWith("{") ? raw : Buffer.from(raw.trim(), "base64").toString("utf8");
  initializeApp({ credential: cert(JSON.parse(text)) });
}

export async function requireAuth(req, res) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  if (!token) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }

  const workerToken = process.env.WORKER_PROXY_TOKEN;
  if (workerToken && token === workerToken) return true;

  try {
    ensureAdminApp();
    await getAuth().verifyIdToken(token);
    return true;
  } catch (e) {
    console.warn("Auth: перевірка токена не пройшла —", e.message);
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
}

// CORS: якщо ALLOWED_ORIGIN заданий — відбиваємо лише його, інакше "*" (як і
// було) — авторизація вище лишається головним захистом.
export function applyCors(req, res, methods = "POST") {
  const allowed = process.env.ALLOWED_ORIGIN;
  res.setHeader("Access-Control-Allow-Origin", allowed || "*");
  res.setHeader("Access-Control-Allow-Methods", `${methods},OPTIONS`);
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}
