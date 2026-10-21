// ─────────────────────────────────────────────
// shared.js — утиліти спільні для small-works (стилі, парсинг)
// Логіка API, промпти, компоненти — в lib/ та components/; docx-експорт
// (exportSimpleDocx) — у lib/exportDocx.js, щоб бути придатним і для воркера
// без React/browser globals.
// ─────────────────────────────────────────────

// ── Парсинг сторінок ──
// Дефолт 20 — для малих робіт (реферат, тези, есе). Велика версія в lib/planUtils.js має дефолт 80.
export function parsePagesAvg(str) {
  if (!str) return 20;
  const s = String(str);
  const nums = s.match(/\d+/g);
  if (!nums) return 20;
  const avg = nums.length === 1 ? parseInt(nums[0]) : Math.round(nums.reduce((a, b) => a + parseInt(b), 0) / nums.length);
  // Якщо поруч із числом вказано "слів"/"слова"/"words" — це обсяг у словах, конвертуємо в сторінки (~230 слів/стор.)
  if (/слів|слова|слово|words?\b/i.test(s)) return Math.max(1, Math.round(avg / 230));
  return avg;
}

// ── Загальні стилі ──
export const TA = { width: "100%", background: "#f0ece2", border: "1.5px solid #d4cfc4", borderRadius: 6, color: "#1a1a14", fontSize: 14, padding: "12px 14px", resize: "vertical", lineHeight: "1.75", fontFamily: "'Spectral',Georgia,serif" };
export const TA_WHITE = { ...TA, background: "#fff", fontSize: 13 };

// ── Загальні CSS анімації (вставляються один раз в компоненті) ──
export const SHARED_STYLES = `
  @import url('https://fonts.googleapis.com/css2?family=Spectral:ital,wght@0,400;0,600;1,400&family=Spectral+SC:wght@600&display=swap');
  *{box-sizing:border-box;margin:0;padding:0}
  ::-webkit-scrollbar{width:5px}::-webkit-scrollbar-track{background:#ede9e0}::-webkit-scrollbar-thumb{background:#bbb4a0;border-radius:3px}
  @keyframes fd{from{opacity:0;transform:translateY(7px)}to{opacity:1;transform:translateY(0)}}
  @keyframes spin{to{transform:rotate(360deg)}}
  @keyframes shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}
  .fade{animation:fd .35s ease}
  button:not(:disabled):active{transform:scale(.98)}
  textarea:focus,input:focus{outline:none;border-color:#aaa49a}
`;
