import { memo } from "react";

export const SpinDot = memo(function SpinDot({ light }) {
  const c = light ? "#e8ff47" : "#1a1a14";
  return <span style={{ display: "inline-block", width: 10, height: 10, borderRadius: "50%", border: `2px solid ${c}33`, borderTop: `2px solid ${c}`, animation: "spin .7s linear infinite", flexShrink: 0 }} />;
});

export const Shimmer = memo(function Shimmer({ width = "100%", height = 13 }) {
  return <div style={{ width, height, borderRadius: 4, background: "linear-gradient(90deg,#e8e4da 25%,#f5f2ea 50%,#e8e4da 75%)", backgroundSize: "200% 100%", animation: "shimmer 1.4s infinite" }} />;
});
