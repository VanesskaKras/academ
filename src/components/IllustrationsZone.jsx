import { useState, useRef } from "react";

const MAX_ILLUSTRATIONS = 20;

export function IllustrationsZone({ illustrations, onAdd, onUpdate, onRemove }) {
  const fileRef = useRef();
  const [dragging, setDragging] = useState(false);

  function processFiles(files) {
    const remaining = MAX_ILLUSTRATIONS - illustrations.length;
    if (remaining <= 0) return;
    Array.from(files).slice(0, remaining).forEach(f => {
      if (!f.type.startsWith("image/")) return;
      const r = new FileReader();
      r.onload = ev => {
        const dataUrl = ev.target.result;
        const img = new Image();
        img.onload = () => {
          // Стискаємо фото перед збереженням у Firestore (документ обмежений 1 МБ) — оригінал
          // з телефону важить кілька МБ, а для аналізу й друку така роздільність не потрібна.
          const MAX_DIM = 1000;
          let w = img.naturalWidth, h = img.naturalHeight;
          if (w > MAX_DIM || h > MAX_DIM) {
            if (w >= h) { h = Math.round(h * MAX_DIM / w); w = MAX_DIM; }
            else { w = Math.round(w * MAX_DIM / h); h = MAX_DIM; }
          }
          try {
            const canvas = document.createElement("canvas");
            canvas.width = w; canvas.height = h;
            canvas.getContext("2d").drawImage(img, 0, 0, w, h);
            const jpegB64 = canvas.toDataURL("image/jpeg", 0.72).split(",")[1];
            onAdd({ name: f.name, b64: jpegB64, type: "image/jpeg", caption: "", targetSection: "" });
          } catch {
            onAdd({ name: f.name, b64: dataUrl.split(",")[1], type: f.type, caption: "", targetSection: "" });
          }
        };
        img.onerror = () => {
          onAdd({ name: f.name, b64: dataUrl.split(",")[1], type: f.type, caption: "", targetSection: "" });
        };
        img.src = dataUrl;
      };
      r.readAsDataURL(f);
    });
  }

  return (
    <div>
      {illustrations.length < MAX_ILLUSTRATIONS && (
        <div
          onClick={() => fileRef.current.click()}
          onDrop={e => { e.preventDefault(); setDragging(false); processFiles(e.dataTransfer.files); }}
          onDragOver={e => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          style={{
            minHeight: 60, border: `1.5px dashed ${dragging ? "#1a1a14" : "#c4bfb4"}`,
            borderRadius: 6, display: "flex", flexDirection: "column", alignItems: "center",
            justifyContent: "center", gap: 4, cursor: "pointer", padding: 10,
            background: dragging ? "#e8e4d8" : "#ede9e0", transition: "all .2s",
          }}
        >
          <div style={{ fontSize: 20 }}>🖼️</div>
          <div style={{ fontSize: 12, color: "#888", textAlign: "center" }}>
            Перетягніть або клікніть для додавання (макс. {MAX_ILLUSTRATIONS})
          </div>
        </div>
      )}
      <input
        ref={fileRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/gif"
        multiple
        style={{ display: "none" }}
        onChange={e => { processFiles(e.target.files); e.target.value = ""; }}
      />
      {illustrations.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 10 }}>
          {illustrations.map((ill, i) => (
            <div key={i} style={{ display: "flex", gap: 10, alignItems: "flex-start", background: "#f5f2ea", borderRadius: 6, padding: 8 }}>
              <div style={{ position: "relative", flexShrink: 0, textAlign: "center" }}>
                <img
                  src={`data:${ill.type};base64,${ill.b64}`}
                  alt={ill.name}
                  style={{ height: 72, width: 72, objectFit: "cover", borderRadius: 4, border: "1px solid #c4bfb4", display: "block" }}
                />
                <button
                  onClick={() => onRemove(i)}
                  style={{ position: "absolute", top: -6, right: -6, width: 18, height: 18, borderRadius: "50%", background: "#8a1a1a", color: "#fff", border: "none", cursor: "pointer", fontSize: 11, lineHeight: "18px", padding: 0 }}
                >×</button>
                <div style={{ fontSize: 10, color: "#999", marginTop: 3 }}>Рис. {i + 1}</div>
              </div>
              <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6 }}>
                <input
                  value={ill.caption}
                  onChange={e => onUpdate(i, { ...ill, caption: e.target.value })}
                  placeholder="Підпис (необов'язково) — що зображено на фото"
                  style={{ fontSize: 12, padding: "5px 8px", border: "1px solid #c4bfb4", borderRadius: 4, background: "#fff", width: "100%", boxSizing: "border-box", fontFamily: "inherit" }}
                />
                <input
                  value={ill.targetSection}
                  onChange={e => onUpdate(i, { ...ill, targetSection: e.target.value })}
                  placeholder="Розділ (необов'язково) — напр. 2.1 або Розділ 3"
                  style={{ fontSize: 12, padding: "5px 8px", border: "1px solid #c4bfb4", borderRadius: 4, background: "#fff", width: "100%", boxSizing: "border-box", fontFamily: "inherit" }}
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
