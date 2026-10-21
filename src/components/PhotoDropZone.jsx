import { useState, useRef } from "react";

export function PhotoDropZone({ photos, onAdd, onRemove }) {
  const fileRef = useRef();
  const [dragging, setDragging] = useState(false);

  function processFiles(files) {
    Array.from(files).forEach(f => {
      if (!f.type.startsWith("image/")) return;
      const r = new FileReader();
      r.onload = ev => onAdd({ name: f.name, b64: ev.target.result.split(",")[1], type: f.type });
      r.readAsDataURL(f);
    });
  }

  return (
    <div>
      <div
        onClick={() => fileRef.current.click()}
        onDrop={e => { e.preventDefault(); setDragging(false); processFiles(e.dataTransfer.files); }}
        onDragOver={e => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        style={{ minHeight: 60, border: `1.5px dashed ${dragging ? "#1a1a14" : "#c4bfb4"}`, borderRadius: 6, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 4, cursor: "pointer", padding: 10, background: dragging ? "#e8e4d8" : "#ede9e0", transition: "all .2s" }}
      >
        <div style={{ fontSize: 20 }}>🖼️</div>
        <div style={{ fontSize: 12, color: "#888", textAlign: "center" }}>Перетягніть або клікніть для вибору фото</div>
      </div>
      <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp,image/gif" multiple style={{ display: "none" }} onChange={e => { processFiles(e.target.files); e.target.value = ""; }} />
      {photos.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
          {photos.map((p, i) => (
            <div key={i} style={{ position: "relative", display: "inline-block" }}>
              <img src={`data:${p.type};base64,${p.b64}`} alt={p.name} style={{ height: 56, width: 56, objectFit: "cover", borderRadius: 4, border: "1px solid #c4bfb4" }} />
              <button onClick={() => onRemove(i)} style={{ position: "absolute", top: -6, right: -6, width: 18, height: 18, borderRadius: "50%", background: "#8a1a1a", color: "#fff", border: "none", cursor: "pointer", fontSize: 11, lineHeight: "18px", padding: 0 }}>×</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
