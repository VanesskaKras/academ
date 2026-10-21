import { memo, useState } from "react";
import { SpinDot } from "./SpinDot.jsx";

export function FieldBox({ label, children, tooltip, labelColor }) {
  const [visible, setVisible] = useState(false);
  return <div style={{ marginBottom: 16 }}>
    <div style={{ fontSize: 11, color: labelColor || "#888", letterSpacing: "2px", textTransform: "uppercase", marginBottom: 6, display: "flex", alignItems: "center", gap: 6 }}>
      {label}
      {tooltip && (
        <span style={{ position: "relative", display: "inline-flex", alignItems: "center" }}>
          <span
            onMouseEnter={() => setVisible(true)}
            onMouseLeave={() => setVisible(false)}
            style={{ width: 14, height: 14, borderRadius: "50%", background: "#555", color: "#ccc", fontSize: 9, display: "inline-flex", alignItems: "center", justifyContent: "center", cursor: "default", flexShrink: 0, letterSpacing: 0, fontFamily: "sans-serif", textTransform: "none" }}
          >i</span>
          {visible && (
            <span style={{ position: "absolute", left: 20, top: "50%", transform: "translateY(-50%)", background: "#222", color: "#ddd", fontSize: 11, lineHeight: "1.6", padding: "8px 12px", borderRadius: 6, whiteSpace: "pre-wrap", width: 260, zIndex: 100, boxShadow: "0 2px 10px rgba(0,0,0,0.4)", letterSpacing: 0, textTransform: "none", fontFamily: "'Spectral',serif", fontWeight: 400, pointerEvents: "none" }}>
              {tooltip}
            </span>
          )}
        </span>
      )}
    </div>
    {children}
  </div>;
}

export function Heading({ children, style = {} }) {
  return <div style={{ fontFamily: "'Spectral SC',serif", fontSize: 17, letterSpacing: 2, marginBottom: 20, userSelect: "none", cursor: "default", ...style }}>{children}</div>;
}

export function NavBtn({ onClick, children, disabled }) {
  return <button onClick={onClick} disabled={disabled} style={{ background: "transparent", border: "1.5px solid #c4bfb4", color: disabled ? "#ccc" : "#777", borderRadius: 7, padding: "11px 22px", fontFamily: "'Spectral',serif", fontSize: 13, cursor: disabled ? "default" : "pointer" }}>{children}</button>;
}

export function PrimaryBtn({ onClick, disabled, loading, msg, label }) {
  return <button onClick={onClick} disabled={disabled || loading} style={{ background: (disabled || loading) ? "#aaa" : "#1a1a14", color: (disabled || loading) ? "#eee" : "#e8ff47", border: "none", borderRadius: 7, padding: "11px 34px", fontFamily: "'Spectral',serif", fontSize: 13, letterSpacing: "1.5px", cursor: (disabled || loading) ? "default" : "pointer" }}>
    {loading ? <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}><SpinDot light />{msg}</span> : label}
  </button>;
}

export function GreenBtn({ onClick, disabled, loading, msg, label }) {
  return <button onClick={onClick} disabled={disabled || loading} style={{ background: (disabled || loading) ? "#aaa" : "#2a3a1a", color: (disabled || loading) ? "#eee" : "#a8d060", border: "none", borderRadius: 7, padding: "10px 24px", fontFamily: "'Spectral',serif", fontSize: 12, letterSpacing: "1px", cursor: (disabled || loading) ? "default" : "pointer", display: "inline-flex", alignItems: "center", gap: 8 }}>
    {loading ? <><SpinDot light />{msg}</> : label}
  </button>;
}

export const SaveIndicator = memo(function SaveIndicator({ saving, saved, error }) {
  if (saving) return <span style={{ fontSize: 11, color: "#aaa", display: "inline-flex", alignItems: "center", gap: 5 }}><SpinDot />Збереження...</span>;
  if (error) return <span style={{ fontSize: 11, color: "#b03030" }} title={error}>⚠ Не збереглося — {error}</span>;
  if (saved) return <span style={{ fontSize: 11, color: "#6a9000" }}>✓ Збережено</span>;
  return null;
});
