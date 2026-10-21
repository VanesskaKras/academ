import { memo } from "react";
import { SpinDot, Shimmer } from "./SpinDot.jsx";

export const PlanLoadingSkeleton = memo(function PlanLoadingSkeleton() {
  return <div style={{ border: "1.5px solid #d4cfc4", borderRadius: 8, overflow: "hidden", marginBottom: 18 }}>
    <div style={{ background: "#1a1a14", color: "#e8ff47", padding: "10px 18px", display: "flex", alignItems: "center", gap: 10, fontFamily: "'Spectral SC',serif", fontSize: 11, letterSpacing: 3 }}>
      <SpinDot light /> ГЕНЕРУЮ ПЛАН...
    </div>
    <div style={{ padding: "18px", background: "#faf8f3", display: "flex", flexDirection: "column", gap: 11 }}>
      <Shimmer width="55%" height={15} /><div style={{ paddingLeft: 18, display: "flex", flexDirection: "column", gap: 8 }}><Shimmer width="72%" /><Shimmer width="64%" /><Shimmer width="69%" /></div>
      <Shimmer width="50%" height={15} /><div style={{ paddingLeft: 18, display: "flex", flexDirection: "column", gap: 8 }}><Shimmer width="68%" /><Shimmer width="58%" /></div>
      <Shimmer width="28%" height={13} /><Shimmer width="44%" height={13} />
    </div>
  </div>;
});
