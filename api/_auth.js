// Спільна авторизація для /api/claude, /api/gemini, /api/gemini-files-init —
// без неї будь-хто з інтернету міг би споживати ключі ANTHROPIC_API_KEY /
// GEMINI_API_KEY* з твого бюджету. Браузер надсилає Firebase ID token
// залогіненого користувача, він перевіряється через firebase-admin.
import { getApps, initializeApp, cert } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

function ensureAdminApp() {
  if (getApps().length) return;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT не задано — потрібен JSON-ключ сервісного акаунта Firebase");
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
