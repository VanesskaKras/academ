import { useState } from "react";
import { DESIGN_STYLES, STYLE_IDS, resolveDesign } from "../lib/pptxDesign.js";
import { exportToPptxFile } from "../lib/exportPptx.js";
import { SpinDot } from "./SpinDot.jsx";

const swatch = (p) => [p.ink, p.acc, p.acc2];

// Вибір стилю + палітри. value = { style, palette } або null (= авто, якщо allowAuto).
export function DesignSelector({ value, onChange, allowAuto = false }) {
  const current = value && DESIGN_STYLES[value.style] ? value : null;
  const chip = (active) => ({
    display: "flex", alignItems: "center", gap: 8, padding: "7px 12px", borderRadius: 8,
    border: `2px solid ${active ? "#e8ff47" : "#d4cfc4"}`, background: active ? "#1a1a14" : "#fff",
    cursor: "pointer", fontFamily: "inherit",
  });
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {allowAuto && (
          <button type="button" onClick={() => onChange(null)} style={chip(!current)}>
            <div style={{ textAlign: "left" }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: !current ? "#e8ff47" : "#1a1a14" }}>Авто</div>
              <div style={{ fontSize: 10, color: !current ? "#aaa" : "#888" }}>під галузь і тему</div>
            </div>
          </button>
        )}
        {STYLE_IDS.map((id) => {
          const st = DESIGN_STYLES[id];
          const active = current?.style === id;
          const pal = st.palettes[active ? current.palette : 0];
          return (
            <button type="button" key={id} onClick={() => onChange({ style: id, palette: active ? current.palette : 0 })} style={chip(active)}>
              <div style={{ display: "flex", gap: 2 }}>
                {swatch(pal).map((c, i) => <div key={i} style={{ width: 10, height: 22, borderRadius: 3, background: `#${c}` }} />)}
              </div>
              <div style={{ textAlign: "left" }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: active ? "#e8ff47" : "#1a1a14" }}>{st.name}</div>
                <div style={{ fontSize: 10, color: active ? "#aaa" : "#888" }}>{st.desc}</div>
              </div>
            </button>
          );
        })}
      </div>
      {current && (
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 11, color: "#888" }}>Палітра:</span>
          {DESIGN_STYLES[current.style].palettes.map((p, i) => (
            <button type="button" key={i} aria-label={`Палітра ${i + 1}`} onClick={() => onChange({ style: current.style, palette: i })}
              style={{ display: "flex", padding: 3, borderRadius: 99, cursor: "pointer", background: "#fff", border: `2px solid ${current.palette === i ? "#1a1a14" : "#d4cfc4"}` }}>
              {swatch(p).map((c, j) => <span key={j} style={{ width: 14, height: 14, borderRadius: "50%", background: `#${c}`, marginLeft: j ? -3 : 0, boxShadow: "0 0 0 2px #fff" }} />)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// Перезбирає .pptx з уже згенерованого JSON у вибраному дизайні — без нового виклику ШІ.
export function PresentationDownload({ slideData, info, orderId, onDesignSaved }) {
  const [design, setDesign] = useState(() => resolveDesign(slideData, info));
  const [loading, setLoading] = useState(false);
  if (!slideData?.slides?.length) return null;
  const download = async () => {
    setLoading(true);
    try {
      await exportToPptxFile({ ...slideData, design }, info, orderId);
      const prev = slideData.design;
      if (!prev || prev.style !== design.style || prev.palette !== design.palette) onDesignSaved?.(design);
    } catch (e) { alert("Помилка: " + e.message); }
    setLoading(false);
  };
  return (
    <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ fontSize: 11, color: "#888", letterSpacing: "1px", textTransform: "uppercase" }}>Дизайн</div>
      <DesignSelector value={design} onChange={(d) => d && setDesign(d)} />
      <button type="button" onClick={download} disabled={loading}
        style={{ alignSelf: "flex-start", background: loading ? "#aaa" : "#1a4a1a", color: loading ? "#eee" : "#a8e060", border: "none", borderRadius: 6, padding: "8px 16px", fontFamily: "'Spectral',serif", fontSize: 12, cursor: loading ? "default" : "pointer", display: "inline-flex", alignItems: "center", gap: 6 }}>
        {loading ? <><SpinDot light />Створюю файл...</> : "⬇ Завантажити .pptx"}
      </button>
    </div>
  );
}
