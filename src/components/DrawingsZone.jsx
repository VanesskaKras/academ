import { useState, useRef } from "react";

const MAX_DRAWINGS = 20;
const MAX_DIM = 1400;

export function DrawingsZone({ drawings, onAdd, onRemove }) {
  const fileRef = useRef();
  const [dragging, setDragging] = useState(false);

  function processFiles(files) {
    const remaining = MAX_DRAWINGS - drawings.length;
    if (remaining <= 0) return;
    Array.from(files).slice(0, remaining).forEach(f => {
      if (!f.type.startsWith("image/")) return;
      const r = new FileReader();
      r.onload = ev => {
        const dataUrl = ev.target.result;
        const img = new Image();
        img.onload = () => {
          let w = img.naturalWidth, h = img.naturalHeight;
          if (w > MAX_DIM || h > MAX_DIM) {
            if (w >= h) { h = Math.round(h * MAX_DIM / w); w = MAX_DIM; }
            else { w = Math.round(w * MAX_DIM / h); h = MAX_DIM; }
          }
          try {
            const canvas = document.createElement("canvas");
            canvas.width = w; canvas.height = h;
            canvas.getContext("2d").drawImage(img, 0, 0, w, h);
            const jpegB64 = canvas.toDataURL("image/jpeg", 0.8).split(",")[1];
            onAdd({ name: f.name, b64: jpegB64, type: "image/jpeg" });
          } catch {
            onAdd({ name: f.name, b64: dataUrl.split(",")[1], type: f.type });
          }
        };
        img.onerror = () => {
          onAdd({ name: f.name, b64: dataUrl.split(",")[1], type: f.type });
        };
        img.src = dataUrl;
      };
      r.readAsDataURL(f);
    });
  }

  return (
    <div>
      {drawings.length < MAX_DRAWINGS && (
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
          <div style={{ fontSize: 20 }}>📐</div>
          <div style={{ fontSize: 12, color: "#888", textAlign: "center" }}>
            Перетягніть або клікніть — креслення (макс. {MAX_DRAWINGS})
          </div>
        </div>
      )}
      <input
        ref={fileRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        multiple
        style={{ display: "none" }}
        onChange={e => { processFiles(e.target.files); e.target.value = ""; }}
      />
      {drawings.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
          {drawings.map((d, i) => (
            <div key={i} style={{ position: "relative", textAlign: "center" }}>
              <img
                src={`data:${d.type};base64,${d.b64}`}
                alt={d.name}
                style={{ height: 72, width: 72, objectFit: "cover", borderRadius: 4, border: "1px solid #c4bfb4", display: "block" }}
              />
              <button
                onClick={() => onRemove(i)}
                style={{ position: "absolute", top: -6, right: -6, width: 18, height: 18, borderRadius: "50%", background: "#8a1a1a", color: "#fff", border: "none", cursor: "pointer", fontSize: 11, lineHeight: "18px", padding: 0 }}
              >×</button>
              <div style={{ fontSize: 10, color: "#999", marginTop: 3, maxWidth: 72, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.name}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
