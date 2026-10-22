// Накопичення вартості/токенів у поля документа (totalCostUsd, claudeInTok
// тощо) — та сама логіка, що й window.addEventListener("apicost", ...) у
// academic-assistant.jsx (lines ~177-200), лише без window: тут callClaude/
// callGemini викликають onCost напряму (opts.onCost), а не подію. Стартує з
// того, що вже в документі (частину міг згенерувати браузер до воркера), і
// доповнює зверху — не перезаписує.
export function createTokenAccumulator(order) {
  let acc = {
    inTok: order.totalInTok || 0, outTok: order.totalOutTok || 0, costUsd: order.totalCostUsd || 0,
    claudeInTok: order.claudeInTok || 0, claudeOutTok: order.claudeOutTok || 0, claudeCostUsd: order.claudeCostUsd || 0,
    geminiInTok: order.geminiInTok || 0, geminiOutTok: order.geminiOutTok || 0, geminiCostUsd: order.geminiCostUsd || 0,
    serperCredits: order.serperCredits || 0, serperCostUsd: order.serperCostUsd || 0,
  };
  const onCost = (detail) => {
    const isGemini = detail.model?.startsWith("gemini");
    const isSerper = detail.model === "serper";
    const inTok = detail.inTok || 0, outTok = detail.outTok || 0, cost = detail.cost || 0;
    acc = {
      inTok: acc.inTok + (isSerper ? 0 : inTok),
      outTok: acc.outTok + (isSerper ? 0 : outTok),
      costUsd: acc.costUsd + cost,
      claudeInTok: acc.claudeInTok + (!isGemini && !isSerper ? inTok : 0),
      claudeOutTok: acc.claudeOutTok + (!isGemini && !isSerper ? outTok : 0),
      claudeCostUsd: acc.claudeCostUsd + (!isGemini && !isSerper ? cost : 0),
      geminiInTok: acc.geminiInTok + (isGemini ? inTok : 0),
      geminiOutTok: acc.geminiOutTok + (isGemini ? outTok : 0),
      geminiCostUsd: acc.geminiCostUsd + (isGemini ? cost : 0),
      serperCredits: acc.serperCredits + (isSerper ? inTok : 0),
      serperCostUsd: acc.serperCostUsd + (isSerper ? cost : 0),
    };
  };
  const snapshot = () => ({
    totalInTok: acc.inTok, totalOutTok: acc.outTok, totalCostUsd: acc.costUsd,
    claudeInTok: acc.claudeInTok, claudeOutTok: acc.claudeOutTok, claudeCostUsd: acc.claudeCostUsd,
    geminiInTok: acc.geminiInTok, geminiOutTok: acc.geminiOutTok, geminiCostUsd: acc.geminiCostUsd,
    serperCredits: acc.serperCredits, serperCostUsd: acc.serperCostUsd,
  });
  return { onCost, snapshot };
}
