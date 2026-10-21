import { SpinDot } from "../SpinDot.jsx";
import { Heading, NavBtn, PrimaryBtn, GreenBtn } from "../Buttons.jsx";

export function WritingStage({
  running, paused, regenId, setRegenId, regenPrompt, setRegenPrompt,
  regenLoading, regenAllLoading, loadMsg, apiError, setApiError, progress,
  displayOrder, sections, genIdx, content, regenAllAbortRef,
  stopGen, resumeGen, doRegenAll, doRegenSection, setStage,
  doRemapCitations, remapLoading, stopRemap,
  appendicesText, appendicesLoading,
}) {
  return (
    <div className="fade">
      <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 10, flexWrap: "wrap" }}>
        <Heading style={{ margin: 0 }}>05 / Генерація тексту</Heading>
        {running && <button onClick={stopGen} style={{ background: "#7a1010", color: "#fff", border: "none", borderRadius: 6, padding: "6px 18px", fontFamily: "'Spectral',serif", fontSize: 12, cursor: "pointer" }}>⏹ Зупинити</button>}
        {!running && paused && genIdx < sections.length && <button onClick={resumeGen} style={{ background: "#0a4a0a", color: "#e8ff47", border: "none", borderRadius: 6, padding: "6px 18px", fontFamily: "'Spectral',serif", fontSize: 12, cursor: "pointer" }}>▶ Продовжити</button>}
        {/* ↺ "Переписати всю роботу" тимчасово приховано на прохання користувача */}
        {regenAllLoading && <><span style={{ fontSize: 12, color: "#888", display: "inline-flex", alignItems: "center", gap: 6 }}><SpinDot />{loadMsg}</span><button onClick={() => regenAllAbortRef.current?.abort()} style={{ background: "#7a1010", color: "#fff", border: "none", borderRadius: 6, padding: "6px 14px", fontFamily: "'Spectral',serif", fontSize: 12, cursor: "pointer" }}>⏹ Зупинити</button></>}
      </div>
      <div style={{ marginBottom: 22 }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6, fontSize: 12, color: "#888" }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>{running && <SpinDot />}{running ? loadMsg : Object.keys(content).length + " / " + sections.length + " блоків готово"}</span>
          <span style={{ fontWeight: 600, color: "#1a1a14" }}>{progress}%</span>
        </div>
        <div style={{ height: 3, background: "#d4cfc4", borderRadius: 2 }}>
          <div style={{ height: "100%", width: progress + "%", background: "#1a1a14", borderRadius: 2, transition: "width .6s ease" }} />
        </div>
      </div>

      {apiError && paused && (
        <div style={{ background: apiError.includes("💳") ? "#1a0a00" : "#1a0000", border: `1.5px solid ${apiError.includes("💳") ? "#8a4a00" : "#8a1a1a"}`, borderRadius: 8, padding: "14px 18px", marginBottom: 18, fontSize: 13, color: apiError.includes("💳") ? "#f0a060" : "#f08080", lineHeight: 1.6 }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>{apiError.includes("💳") ? "💳 Закінчився баланс API" : "⚠ Помилка генерації"}</div>
          <div>{apiError}</div>
          {apiError.includes("💳") && <div style={{ marginTop: 8, fontSize: 12, color: "#c08040" }}>Поповніть баланс на console.anthropic.com, після чого натисніть "Продовжити".</div>}
          <button onClick={() => setApiError("")} style={{ marginTop: 10, background: "transparent", border: "1px solid #555", color: "#888", borderRadius: 5, padding: "3px 12px", fontSize: 11, cursor: "pointer", fontFamily: "inherit" }}>✕ Закрити</button>
        </div>
      )}

      {displayOrder.map(sec => {
        const txt = content[sec.id];
        const isGen = running && sections[genIdx]?.id === sec.id;
        const isRegen = regenId === sec.id;
        return (
          <div key={sec.id} style={{ border: "1.5px solid " + (txt ? "#aaa49a" : isGen ? "#1a1a14" : "#ddd9d0"), borderRadius: 8, marginBottom: 10, overflow: "hidden", transition: "border-color .3s" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 16px", background: txt ? "#1a1a14" : "#f0ece2", borderBottom: txt ? "1px solid #2a2a20" : "none" }}>
              <div style={{ width: 8, height: 8, borderRadius: "50%", flexShrink: 0, background: txt ? "#e8ff47" : isGen ? "#555" : "#ccc", animation: isGen ? "pl 1.2s ease-in-out infinite" : "none" }} />
              <div style={{ flex: 1, fontSize: 13, fontWeight: 600, color: txt ? "#f5f2eb" : "#1a1a14" }}>{sec.label}</div>
              <div style={{ fontSize: 11, color: txt ? "#666" : "#aaa", marginRight: 4 }}>{sec.pages} стор.</div>
              {txt && <>
                <button onClick={() => navigator.clipboard.writeText(txt)} style={{ background: "transparent", border: "1px solid #555", color: "#999", borderRadius: 5, padding: "3px 10px", fontSize: 10, cursor: "pointer", fontFamily: "'Spectral',serif", letterSpacing: 1 }}>COPY</button>
                {!["sources"].includes(sec.type) && (
                  <button onClick={() => setRegenId(isRegen ? null : sec.id)} style={{ background: isRegen ? "#e8ff47" : "transparent", color: isRegen ? "#111" : "#aaa", border: "1px solid " + (isRegen ? "#e8ff47" : "#555"), borderRadius: 5, padding: "3px 10px", fontSize: 10, cursor: "pointer", fontFamily: "'Spectral',serif" }}>✏️ Переписати</button>
                )}
              </>}
            </div>

            {/* Regen panel */}
            {isRegen && (
              <div style={{ padding: "12px 16px", background: "#1a1a14", borderBottom: "1px solid #2a2a20" }}>
                <div style={{ fontSize: 11, color: "#888", marginBottom: 6, letterSpacing: 1 }}>ДОДАТКОВІ ВИМОГИ (необов'язково):</div>
                <div style={{ display: "flex", gap: 8 }}>
                  <input value={regenPrompt} onChange={e => setRegenPrompt(e.target.value)}
                    placeholder="Наприклад: більше прикладів, акцент на практичну частину..."
                    style={{ flex: 1, background: "#2a2a20", border: "1px solid #444", borderRadius: 5, color: "#f5f2eb", fontSize: 12, padding: "7px 10px", fontFamily: "'Spectral',serif" }} />
                  <button onClick={() => doRegenSection(sec)} disabled={regenLoading} style={{ background: regenLoading ? "#444" : "#e8ff47", color: "#111", border: "none", borderRadius: 5, padding: "7px 18px", fontSize: 12, cursor: regenLoading ? "default" : "pointer", fontFamily: "'Spectral',serif", display: "inline-flex", alignItems: "center", gap: 6 }}>
                    {regenLoading ? <><SpinDot />Генерую...</> : "Переписати →"}
                  </button>
                </div>
              </div>
            )}

            {txt && <div style={{ padding: "16px 20px", fontSize: 13, lineHeight: "1.85", color: "#2a2a1e", whiteSpace: "pre-wrap", maxHeight: 360, overflowY: "auto", background: "#faf8f3" }}>{txt}</div>}
            {isGen && !txt && <div style={{ padding: "14px 20px", fontSize: 13, color: "#888", display: "flex", alignItems: "center", gap: 8, background: "#faf8f3" }}><SpinDot />Генерується...</div>}
          </div>
        );
      })}

      {/* ── Додаток А (генерується у фоні) ── */}
      {(appendicesLoading || appendicesText) && (
        <div style={{ border: "1.5px solid #3a4a1a", borderRadius: 8, marginBottom: 10, overflow: "hidden" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 16px", background: "#1a2a0a", borderBottom: appendicesText ? "1px solid #2a3a10" : "none" }}>
            <div style={{ width: 8, height: 8, borderRadius: "50%", flexShrink: 0, background: appendicesText ? "#a8e060" : "#555", animation: appendicesLoading && !appendicesText ? "pl 1.2s ease-in-out infinite" : "none" }} />
            <div style={{ flex: 1, fontSize: 13, fontWeight: 600, color: "#c8e890" }}>ДОДАТОК А</div>
            {appendicesLoading && !appendicesText && <span style={{ fontSize: 11, color: "#7ab840", display: "inline-flex", alignItems: "center", gap: 6 }}><SpinDot />Генерую анкету...</span>}
            {appendicesText && <button onClick={() => navigator.clipboard.writeText(appendicesText)} style={{ background: "transparent", border: "1px solid #4a6a20", color: "#7ab840", borderRadius: 5, padding: "3px 10px", fontSize: 10, cursor: "pointer", fontFamily: "'Spectral',serif", letterSpacing: 1 }}>COPY</button>}
          </div>
          {appendicesText && <div style={{ padding: "14px 18px", fontSize: 12, lineHeight: "1.85", color: "#2a3a1e", whiteSpace: "pre-wrap", maxHeight: 260, overflowY: "auto", background: "#f5faf0" }}>{appendicesText}</div>}
        </div>
      )}

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 24 }}>
        <NavBtn onClick={() => setStage("sources")} disabled={running}>← До джерел</NavBtn>
        {!running && progress === 100 && (
          <GreenBtn onClick={doRemapCitations} loading={remapLoading} msg="Формую список літератури..." label="Сформувати список літератури та посилання →" />
        )}
        {remapLoading && <button onClick={stopRemap} style={{ background: "#7a1010", color: "#fff", border: "none", borderRadius: 6, padding: "6px 18px", fontFamily: "'Spectral',serif", fontSize: 12, cursor: "pointer" }}>⏹ Зупинити</button>}
      </div>
    </div>
  );
}
