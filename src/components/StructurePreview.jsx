import { memo, useMemo } from "react";
import { buildPreviewStructure } from "../lib/planUtils.js";

export const StructurePreview = memo(function StructurePreview({ totalPages }) {
  const items = useMemo(() => buildPreviewStructure(totalPages), [totalPages]);
  return <div style={{ border: "1.5px solid #d4cfc4", borderRadius: 8, overflow: "hidden", marginBottom: 18 }}>
    <div style={{ background: "#1a1a14", color: "#e8ff47", padding: "10px 18px", fontFamily: "'Spectral SC',serif", fontSize: 11, letterSpacing: 3 }}>СТРУКТУРА (попередній перегляд)</div>
    <div style={{ padding: "14px 18px", background: "#faf8f3" }}>
      {items.map((item, i) => (
        <div key={i} style={{ marginBottom: item.sub.length ? 10 : 6 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "#1a1a14", marginBottom: 4 }}>{item.label}</div>
          {item.sub.map((s, j) => <div key={j} style={{ fontSize: 12, color: "#888", paddingLeft: 20, marginBottom: 2 }}>{s}</div>)}
        </div>
      ))}
    </div>
  </div>;
});
