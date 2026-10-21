import { memo } from "react";
import { STAGES, STAGE_KEYS } from "../lib/planUtils.js";

export const StagePills = memo(function StagePills({ stage, maxStageIdx, onNavigate, stages, stageKeys }) {
  const activeStages = stages || STAGES;
  const activeKeys   = stageKeys || STAGE_KEYS;
  const cur = activeKeys.indexOf(stage);
  const maxReached = maxStageIdx ?? cur;
  return <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
    {activeStages.map((l, i) => {
      const isClickable = i <= maxReached && onNavigate;
      return (
        <div key={i}
          onClick={isClickable ? () => onNavigate(activeKeys[i]) : undefined}
          style={{
            padding: "4px 12px", borderRadius: 20, fontSize: 11, letterSpacing: "1px",
            background: i === cur ? "#e8ff47" : i < cur ? "#1e2a00" : i <= maxReached ? "#2a3a00" : "transparent",
            color: i === cur ? "#111" : i < cur ? "#6a9000" : i <= maxReached ? "#8aaa30" : "#555",
            border: `1px solid ${i === cur ? "#e8ff47" : i < cur ? "#3a5000" : i <= maxReached ? "#4a6a00" : "#444"}`,
            cursor: isClickable ? "pointer" : "default",
          }}>
          {i < cur ? "✓ " : i > cur && i <= maxReached ? "↩ " : ""}{l}
        </div>
      );
    })}
  </div>;
});
