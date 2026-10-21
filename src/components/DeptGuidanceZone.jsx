import { useState, useRef } from "react";
import { callClaude, MODEL_FAST } from "../lib/api.js";

const MAX_PHOTOS = 12;
const MAX_TEXT_CHARS = 9000;

// Рекомендації кафедри/викладача щодо написання звіту (обсяг, структура, вимоги до щоденника
// тощо) — часто приходять як скріншоти посту в Telegram, а не офіційний PDF методички.
// Кілька фото (можливий послідовний скрол) зводяться в один текст одним викликом візії,
// щоб модель сама прибрала дублікати рядків на стиках сусідніх скріншотів.
export function DeptGuidanceZone({ value, onChange }) {
  const fileRef = useRef();
  const [photos, setPhotos] = useState([]);
  const [dragging, setDragging] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [error, setError] = useState("");

  function addPhotos(files) {
    const remaining = MAX_PHOTOS - photos.length;
    if (remaining <= 0) return;
    Array.from(files).slice(0, remaining).forEach(f => {
      if (!f.type.startsWith("image/")) return;
      const r = new FileReader();
      r.onload = ev => setPhotos(prev => [...prev, { name: f.name, b64: ev.target.result.split(",")[1], type: f.type }]);
      r.readAsDataURL(f);
    });
  }

  async function extract() {
    if (!photos.length) return;
    setError("");
    setExtracting(true);
    try {
      const content = [
        ...photos.map(p => ({ type: "image", source: { type: "base64", media_type: p.type, data: p.b64 } })),
        {
          type: "text",
          text: "Це скріншоти одного або кількох повідомлень з рекомендаціями кафедри щодо написання звіту з практики. Якщо кілька сусідніх фото — це послідовний скрол одного повідомлення (текст на стику збігається), зведи їх в один зв'язний фрагмент без дублювання рядків, зберігаючи оригінальну нумерацію пунктів і формулювання. Якщо фото належать до різних повідомлень — не змішуй і не дублюй їх, просто впорядкуй одне за одним. Прибери елементи інтерфейсу застосунку (час, іконки, кнопки, імена/аватари). Поверни лише текст рекомендацій, без власних пояснень.",
        },
      ];
      const raw = await callClaude(
        [{ role: "user", content }],
        null, "Return only plain text, no markdown, no explanations.", 3000, null, MODEL_FAST
      );
      const text = raw.trim().slice(0, MAX_TEXT_CHARS);
      onChange(value?.trim() ? `${value.trim()}\n\n${text}` : text);
      setPhotos([]);
    } catch (e) {
      setError("Не вдалось розпізнати фото: " + e.message);
    }
    setExtracting(false);
  }

  return (
    <div>
      <textarea
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder="Вставте текст рекомендацій вручну, або завантажте фото/скріншоти нижче..."
        style={{
          width: "100%", minHeight: 64, boxSizing: "border-box",
          background: "#f0ece2", border: "1.5px solid #d4cfc4", borderRadius: 6,
          color: "#1a1a14", fontSize: 13, padding: "10px 12px",
          resize: "vertical", lineHeight: 1.7, fontFamily: "'Spectral',Georgia,serif",
        }}
      />

      <div
        onClick={() => fileRef.current.click()}
        onDrop={e => { e.preventDefault(); setDragging(false); addPhotos(e.dataTransfer.files); }}
        onDragOver={e => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        style={{
          marginTop: 8, minHeight: 60, border: `1.5px dashed ${dragging ? "#1a1a14" : "#c4bfb4"}`,
          borderRadius: 6, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
          gap: 4, cursor: "pointer", padding: 10, background: dragging ? "#e8e4d8" : "#ede9e0", transition: "all .2s",
        }}
      >
        <div style={{ fontSize: 20 }}>🖼️</div>
        <div style={{ fontSize: 12, color: "#888", textAlign: "center" }}>
          Перетягніть або клікніть — фото/скріншоти рекомендацій ({photos.length}/{MAX_PHOTOS})
        </div>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/gif"
        multiple
        style={{ display: "none" }}
        onChange={e => { addPhotos(e.target.files); e.target.value = ""; }}
      />

      {photos.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8, alignItems: "center" }}>
          {photos.map((p, i) => (
            <div key={i} style={{ position: "relative", display: "inline-block" }}>
              <img
                src={`data:${p.type};base64,${p.b64}`}
                alt={p.name}
                style={{ height: 56, width: 56, objectFit: "cover", borderRadius: 4, border: "1px solid #c4bfb4" }}
              />
              <button
                onClick={() => setPhotos(prev => prev.filter((_, idx) => idx !== i))}
                style={{ position: "absolute", top: -6, right: -6, width: 18, height: 18, borderRadius: "50%", background: "#8a1a1a", color: "#fff", border: "none", cursor: "pointer", fontSize: 11, lineHeight: "18px", padding: 0 }}
              >×</button>
            </div>
          ))}
          <button
            onClick={extract}
            disabled={extracting}
            style={{
              fontSize: 12, padding: "8px 14px", borderRadius: 6, border: "1px solid #5a8a30",
              background: extracting ? "#ccc" : "#5a8a30", color: "#fff", cursor: extracting ? "wait" : "pointer",
            }}
          >
            {extracting ? "Розпізнаю..." : "Розпізнати текст"}
          </button>
        </div>
      )}

      {error && <div style={{ color: "#c55", fontSize: 11, marginTop: 4 }}>{error}</div>}
      {value?.trim() && <div style={{ fontSize: 11, color: "#5a8a30", marginTop: 4 }}>✓ рекомендації збережено ({value.trim().length} символів)</div>}
    </div>
  );
}
