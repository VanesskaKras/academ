import { parseClientPlan, buildPlanText, calcSourceDist, getLangLabels, insertBeforeTail, describePlanEditOp } from "../../lib/planUtils.js";
import { exportPlanToDocx } from "../../lib/exportDocx.js";
import { SpinDot } from "../SpinDot.jsx";
import { Heading, NavBtn, PrimaryBtn, GreenBtn } from "../Buttons.jsx";
import { PlanLoadingSkeleton } from "../PlanLoadingSkeleton.jsx";


export function PlanStage({
  sections, setSections, planDisplay, setPlanDisplay, planLoading, clientPlan,
  showManualPlanInput, setShowManualPlanInput, manualPlanText, setManualPlanText,
  planDocxLoading, setPlanDocxLoading, namingLoading, totalPagesNum,
  info, setInfo, methodInfo, content, readyWorkFileName, readyWorkImportedIds, readyWorkNeedsManualAI, doAIAnalyzeReadyWork, doGenPlan, doNamePlaceholders, startGen, setStage,
  setSourceDist, setSourceTotal, addNewChapter, addNewChapterEmpty, recalcPages, toggleStructureSection,
  moveSectionUp, moveSectionDown,
  doNameSinglePlaceholder, singleNamingId, doNameSingleChapter, updateChapterTitle,
  showClientEditsInput, setShowClientEditsInput, clientEditsText, setClientEditsText,
  clientEditsLoading, clientEditsOps, clientEditsChecked, setClientEditsChecked, clientEditsError,
  doAnalyzeClientEdits, doApplyClientEdits, cancelClientEdits,
}) {
  return (
    <div className="fade">
      <Heading>03 / План роботи</Heading>
      {planLoading ? (
        <>{clientPlan ? (
          <div style={{ border: "1.5px solid #d4cfc4", borderRadius: 8, overflow: "hidden", marginBottom: 18 }}>
            <div style={{ background: "#1a1a14", color: "#e8ff47", padding: "10px 18px", fontFamily: "'Spectral SC',serif", fontSize: 11, letterSpacing: 3 }}>ПЛАН КЛІЄНТА (обробляється...)</div>
            <div style={{ padding: "14px 18px", background: "#faf8f3" }}><pre style={{ fontFamily: "'Spectral',serif", fontSize: 13, color: "#888", whiteSpace: "pre-wrap", lineHeight: 1.8 }}>{clientPlan}</pre></div>
          </div>
        ) : null}
          <PlanLoadingSkeleton /></>
      ) : sections.length > 0 ? (
        <>
          <p style={{ fontSize: 13, color: "#888", marginBottom: 16 }}>Відредагуйте назви та к-сть сторінок. Після затвердження плану — починайте написання.</p>

          {readyWorkImportedIds?.length > 0 && (
            <div style={{ padding: "10px 16px", background: "#eef8f2", border: "1.5px solid #8cc8a8", borderRadius: 8, marginBottom: 16, fontSize: 12, color: "#2a6a4a" }}>
              ✅ З файлу «{readyWorkFileName}» імпортовано {readyWorkImportedIds.length} підрозділ(и): {sections.filter(s => readyWorkImportedIds.includes(s.id)).map(s => s.label).join(", ")}. Ці підрозділи не будуть перезаписані генерацією — джерела клієнта вже підставлені на кроці «Джерела».
            </div>
          )}

          {readyWorkNeedsManualAI && !readyWorkImportedIds?.length && (
            <div style={{ padding: "10px 16px", background: "#faf3e6", border: "1.5px solid #d8b878", borderRadius: 8, marginBottom: 16, fontSize: 12, color: "#7a5a20", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
              <span>⚠️ Не вдалося автоматично розпізнати заголовки в файлі «{readyWorkFileName}» (нестандартне оформлення). План згенеровано окремо, без даних з файлу.</span>
              <button onClick={doAIAnalyzeReadyWork} style={{ background: "#1a1a14", color: "#e8ff47", border: "none", borderRadius: 6, padding: "8px 16px", fontFamily: "'Spectral',serif", fontSize: 12, cursor: "pointer", whiteSpace: "nowrap" }}>
                Аналізувати через ШІ
              </button>
            </div>
          )}

          {/* Plan text block */}
          <div style={{ background: "#1a1a14", color: "#f5f2eb", borderRadius: 8, padding: 20, marginBottom: 18 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
              <div style={{ fontFamily: "'Spectral SC'", fontSize: 11, color: "#e8ff47", letterSpacing: 3 }}>ПЛАН ДЛЯ КОПІЮВАННЯ</div>
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={() => navigator.clipboard.writeText(planDisplay)} style={{ background: "transparent", border: "1px solid #555", color: "#aaa", borderRadius: 5, padding: "4px 12px", fontSize: 11, cursor: "pointer", fontFamily: "'Spectral',serif", letterSpacing: 1 }}>COPY</button>
                <button onClick={() => { setShowManualPlanInput(v => !v); setManualPlanText(""); }} style={{ background: showManualPlanInput ? "#3a2a00" : "transparent", border: "1px solid #888", color: "#e8c84a", borderRadius: 5, padding: "4px 12px", fontSize: 11, cursor: "pointer", fontFamily: "'Spectral',serif", letterSpacing: 1 }}>✏ Замінити</button>
                <button onClick={() => setShowClientEditsInput(v => !v)} style={{ background: showClientEditsInput ? "#1a2a3a" : "transparent", border: "1px solid #6a90b8", color: "#7ab0e0", borderRadius: 5, padding: "4px 12px", fontSize: 11, cursor: "pointer", fontFamily: "'Spectral',serif", letterSpacing: 1 }}>📝 Правки клієнта</button>
                <button
                  disabled={planDocxLoading}
                  onClick={async () => { setPlanDocxLoading(true); try { await exportPlanToDocx({ sections, info, methodInfo }); } catch (e) { alert("Помилка: " + e.message); } setPlanDocxLoading(false); }}
                  style={{ background: planDocxLoading ? "#444" : "#2a3a1a", color: "#a8d060", border: "none", borderRadius: 5, padding: "4px 14px", fontSize: 11, cursor: "pointer", fontFamily: "'Spectral',serif", letterSpacing: 1, display: "inline-flex", alignItems: "center", gap: 6 }}>
                  {planDocxLoading ? <><SpinDot light />...</> : "⬇ .docx"}
                </button>
              </div>
            </div>
            <pre style={{ fontFamily: "'Spectral',serif", fontSize: 13, lineHeight: "2.1", whiteSpace: "pre-wrap", color: "#e0ddd4", margin: 0 }}>{planDisplay}</pre>
          </div>

          {/* Що включати в план — вимкніть зайве, якщо клієнт просить виконати лише частину роботи. Сторінки одразу перерозподіляються між розділами. */}
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 18, padding: "10px 16px", background: "#f0ece2", borderRadius: 8, border: "1.5px solid #d4cfc4", flexWrap: "wrap" }}>
            <div style={{ fontSize: 11, color: "#888", letterSpacing: "1px", textTransform: "uppercase", whiteSpace: "nowrap" }}>Включити в план</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {[["includeIntro", "Вступ"], ["includeConclusions", "Висновки"], ["includeSources", "Список джерел"]].map(([key, label]) => {
                const on = info[key] !== false;
                return (
                  <span key={key}
                    onClick={() => toggleStructureSection(key)}
                    title="Клікніть щоб увімкнути/вимкнути — сторінки перерозподіляться автоматично"
                    style={{ fontSize: 12, padding: "5px 16px", borderRadius: 20, cursor: "pointer", userSelect: "none", fontFamily: "inherit", border: "1.5px solid", transition: "all .15s",
                      background: on ? "#1a1a14" : "transparent",
                      color: on ? "#e8ff47" : "#888",
                      borderColor: on ? "#1a1a14" : "#ccc" }}>
                    {on ? "✓ " : "✗ "}{label}
                  </span>
                );
              })}
            </div>
          </div>

          {showManualPlanInput && (
            <div style={{ background: "#1e1c0e", border: "1.5px solid #e8c84a", borderRadius: 8, padding: 16, marginBottom: 18 }}>
              <div style={{ fontFamily: "'Spectral SC'", fontSize: 11, color: "#e8c84a", letterSpacing: 3, marginBottom: 10 }}>ВСТАВИТИ НОВИЙ ПЛАН</div>
              <textarea
                value={manualPlanText}
                onChange={e => setManualPlanText(e.target.value)}
                placeholder={"РОЗДІЛ 1. Назва розділу\n    1.1 Назва підрозділу\n    1.2 Назва підрозділу\nРОЗДІЛ 2. Назва розділу\n    2.1 Назва підрозділу\n    ..."}
                style={{ width: "100%", minHeight: 180, background: "#141410", color: "#e0ddd4", border: "1px solid #555", borderRadius: 6, padding: "10px 12px", fontFamily: "'Spectral',serif", fontSize: 13, lineHeight: 1.8, resize: "vertical", boxSizing: "border-box" }}
              />
              <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                <button
                  onClick={() => {
                    const parsed = parseClientPlan(manualPlanText.trim(), totalPagesNum, info?.language);
                    if (!parsed || !parsed.length) { alert("Не вдалося розпізнати план. Перевірте формат."); return; }
                    const withPrompts = parsed.map(s => ({ ...s, prompts: s.type === "sources" ? 0 : Math.max(1, Math.ceil((s.pages || 3) / 3)) }));
                    setSections(withPrompts);
                    setPlanDisplay(buildPlanText(withPrompts));
                    const { dist, total } = calcSourceDist(withPrompts);
                    setSourceDist(dist); setSourceTotal(total);
                    setShowManualPlanInput(false);
                    setManualPlanText("");
                  }}
                  style={{ background: "#2a3a1a", color: "#a8d060", border: "none", borderRadius: 6, padding: "7px 20px", fontFamily: "'Spectral',serif", fontSize: 12, cursor: "pointer", letterSpacing: 1 }}
                >Застосувати</button>
                <button
                  onClick={() => { setShowManualPlanInput(false); setManualPlanText(""); }}
                  style={{ background: "transparent", border: "1px solid #555", color: "#aaa", borderRadius: 6, padding: "7px 16px", fontFamily: "'Spectral',serif", fontSize: 12, cursor: "pointer" }}
                >Скасувати</button>
              </div>
            </div>
          )}

          {showClientEditsInput && (
            <div style={{ background: "#0e1a24", border: "1.5px solid #6a90b8", borderRadius: 8, padding: 16, marginBottom: 18 }}>
              <div style={{ fontFamily: "'Spectral SC'", fontSize: 11, color: "#7ab0e0", letterSpacing: 3, marginBottom: 10 }}>ПРАВКИ КЛІЄНТА ДО ПЛАНУ</div>
              {!clientEditsOps ? (
                <>
                  <textarea
                    value={clientEditsText}
                    onChange={e => setClientEditsText(e.target.value)}
                    placeholder={"Вставте текст правок клієнта як є, наприклад:\nприберіть підрозділ 2.3\nдодайте у розділ 1 підрозділ про історію питання\nзбільшіть вступ до 3 сторінок"}
                    style={{ width: "100%", minHeight: 120, background: "#141410", color: "#e0ddd4", border: "1px solid #555", borderRadius: 6, padding: "10px 12px", fontFamily: "'Spectral',serif", fontSize: 13, lineHeight: 1.8, resize: "vertical", boxSizing: "border-box" }}
                  />
                  {clientEditsError && <div style={{ color: "#e08a6a", fontSize: 12, marginTop: 8 }}>{clientEditsError}</div>}
                  <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                    <button
                      onClick={doAnalyzeClientEdits}
                      disabled={clientEditsLoading || !clientEditsText.trim()}
                      style={{ background: clientEditsLoading ? "#333" : "#1a3a4a", color: clientEditsLoading ? "#888" : "#7ab0e0", border: "none", borderRadius: 6, padding: "7px 20px", fontFamily: "'Spectral',serif", fontSize: 12, cursor: clientEditsLoading || !clientEditsText.trim() ? "default" : "pointer", letterSpacing: 1, display: "inline-flex", alignItems: "center", gap: 6 }}
                    >{clientEditsLoading ? <><SpinDot light />Аналізую...</> : "Розпізнати правки"}</button>
                    <button onClick={cancelClientEdits} style={{ background: "transparent", border: "1px solid #555", color: "#aaa", borderRadius: 6, padding: "7px 16px", fontFamily: "'Spectral',serif", fontSize: 12, cursor: "pointer" }}>Скасувати</button>
                  </div>
                </>
              ) : clientEditsOps.length === 0 ? (
                <>
                  <div style={{ fontSize: 13, color: "#aaa" }}>ШІ не знайшов у цьому тексті конкретних структурних змін до плану.</div>
                  <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                    <button onClick={cancelClientEdits} style={{ background: "transparent", border: "1px solid #555", color: "#aaa", borderRadius: 6, padding: "7px 16px", fontFamily: "'Spectral',serif", fontSize: 12, cursor: "pointer" }}>Закрити</button>
                  </div>
                </>
              ) : (
                <>
                  <div style={{ fontSize: 12, color: "#8ab0d0", marginBottom: 10 }}>Перевірте розпізнані зміни — зайве можна зняти галочкою:</div>
                  <div style={{ borderRadius: 6, overflow: "hidden", marginBottom: 12 }}>
                    {clientEditsOps.map((op, i) => {
                      const { text, invalid } = describePlanEditOp(op, sections);
                      const checked = clientEditsChecked[op._id] !== false;
                      return (
                        <label key={op._id} style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "8px 10px", background: i % 2 === 0 ? "#152430" : "#0e1a24", cursor: invalid ? "default" : "pointer", opacity: checked ? 1 : 0.45 }}>
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={invalid}
                            onChange={e => setClientEditsChecked(prev => ({ ...prev, [op._id]: e.target.checked }))}
                            style={{ marginTop: 3, accentColor: "#6a90b8", flexShrink: 0 }}
                          />
                          <span style={{ fontSize: 13, color: invalid ? "#c07050" : "#e0ddd4", fontFamily: "'Spectral',serif" }}>{text}</span>
                        </label>
                      );
                    })}
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button
                      onClick={doApplyClientEdits}
                      disabled={!clientEditsOps.some(op => clientEditsChecked[op._id] !== false)}
                      style={{ background: "#2a3a1a", color: "#a8d060", border: "none", borderRadius: 6, padding: "7px 20px", fontFamily: "'Spectral',serif", fontSize: 12, cursor: "pointer", letterSpacing: 1 }}
                    >Застосувати вибрані</button>
                    <button onClick={cancelClientEdits} style={{ background: "transparent", border: "1px solid #555", color: "#aaa", borderRadius: 6, padding: "7px 16px", fontFamily: "'Spectral',serif", fontSize: 12, cursor: "pointer" }}>Скасувати</button>
                  </div>
                </>
              )}
            </div>
          )}

          {/* Sections table */}
          <div style={{ fontSize: 12, color: "#888", marginBottom: 10, padding: "8px 12px", background: "#f0ece2", borderRadius: 6, lineHeight: "1.6" }}>
            ✏️ Редагуй назви та сторінки прямо в таблиці. Кнопка <strong>+</strong> — додати підрозділ, <strong>✕</strong> — видалити.
          </div>
          <div style={{ border: "1.5px solid #d4cfc4", borderRadius: 8, overflow: "hidden", marginBottom: 22 }}>
            <div style={{ display: "grid", gridTemplateColumns: "36px 1fr 70px 54px 84px 36px", background: "#1a1a14", color: "#e8ff47", padding: "9px 14px", fontSize: 11, letterSpacing: "1.5px", textTransform: "uppercase" }}>
              <div>#</div><div>Підрозділ</div><div style={{ textAlign: "center" }}>Стор.</div><div style={{ textAlign: "center" }}>Промти</div><div style={{ textAlign: "center" }}>Перем.</div><div />
            </div>
            {(() => {
              // Скільки рядків мають цей sectionTitle — потрібно, щоб розділ без
              // підрозділів (chapterOnly, рівно 1 рядок на розділ) відрендерився
              // одним об'єднаним рядком-заголовком замість "заголовок + підрозділ".
              const mainSubs = sections.filter(s => !["intro", "conclusions", "sources", "chapter_conclusion"].includes(s.type) && s.sectionTitle);
              const titleCounts = {};
              mainSubs.forEach(s => { titleCounts[s.sectionTitle] = (titleCounts[s.sectionTitle] || 0) + 1; });

              let lastChapterTitle = null;
              let rowNum = 0;
              const rows = [];
              sections.forEach((s, i) => {
                const isSpecial = ["intro", "conclusions", "sources"].includes(s.type);
                const isChapterConclusion = s.type === "chapter_conclusion";
                const isMainSub = !isSpecial && !isChapterConclusion && s.sectionTitle;
                const isChapterOnlyRow = isMainSub && s.chapterOnly && titleCounts[s.sectionTitle] === 1;
                const chapNum = isMainSub ? s.id.split(".")[0] : null;
                const isChapTitlePlaceholder = isMainSub && /\[Назва розділу/i.test(s.sectionTitle);
                const chapNaming = chapNum != null && singleNamingId === `chapter_${chapNum}`;

                if (isMainSub && s.sectionTitle !== lastChapterTitle) {
                  lastChapterTitle = s.sectionTitle;
                  if (!isChapterOnlyRow) {
                    rows.push(
                      <div key={`chhead-${s.sectionTitle}`} style={{ display: "grid", gridTemplateColumns: "36px 1fr 70px 54px 84px 36px", borderBottom: "1px solid #e4dfd4", background: "#ddd8c8", alignItems: "center" }}>
                        <div style={{ padding: "8px 10px" }} />
                        <div style={{ display: "flex", alignItems: "center", gridColumn: "2 / 7", overflow: "hidden" }}>
                          <input
                            value={s.sectionTitle}
                            onChange={e => updateChapterTitle(s.sectionTitle, e.target.value)}
                            style={{ background: "transparent", border: "none", fontSize: 12, fontWeight: "bold", color: "#1a1a14", letterSpacing: "0.5px", textTransform: "uppercase", padding: "8px 8px", flex: 1, minWidth: 0, fontFamily: "'Spectral',serif" }}
                          />
                          {isChapTitlePlaceholder && (
                            <button
                              onClick={() => doNameSingleChapter(chapNum)}
                              disabled={chapNaming}
                              title="Згенерувати назву розділу"
                              style={{ background: "transparent", border: "none", fontSize: 14, cursor: chapNaming ? "wait" : "pointer", padding: "2px 6px", color: chapNaming ? "#ccc" : "#8a7010", flexShrink: 0 }}
                            >{chapNaming ? "…" : "✨"}</button>
                          )}
                        </div>
                      </div>
                    );
                  }
                }
                rowNum++;
                const isMovable = !isSpecial && !isChapterConclusion;
                const isPlaceholder = isMovable && !isChapterOnlyRow && /\[|новий/i.test(s.label);
                const movable = sections.filter(x => !["intro", "conclusions", "sources", "chapter_conclusion"].includes(x.type));
                const movIdx = movable.findIndex(x => x.id === s.id);
                const canUp = isMovable && movIdx > 0;
                const canDown = isMovable && movIdx < movable.length - 1;
                rows.push(
                  <div key={s.id} className="sec-row" style={{ display: "grid", gridTemplateColumns: "36px 1fr 70px 54px 84px 36px", borderBottom: i < sections.length - 1 ? "1px solid #e4dfd4" : "none", background: isChapterOnlyRow ? "#ddd8c8" : isSpecial ? "#ede9e0" : rowNum % 2 === 0 ? "#f5f2eb" : "#f0ece2", alignItems: "center", transition: "background .15s" }}>
                    <div style={{ padding: "9px 10px", fontSize: 12, color: "#bbb" }}>{rowNum}</div>
                    <div style={{ display: "flex", alignItems: "center", overflow: "hidden" }}>
                      <input
                        value={isChapterOnlyRow ? s.sectionTitle : s.label}
                        onChange={e => {
                          const val = e.target.value;
                          if (isChapterOnlyRow) { updateChapterTitle(s.sectionTitle, val); return; }
                          setSections(p => { const next = p.map((x, j) => j === i ? { ...x, label: val } : x); setPlanDisplay(buildPlanText(next)); return next; });
                        }}
                        style={{ background: "transparent", border: "none", fontSize: 13, padding: "9px 8px", color: isSpecial ? "#888" : "#1a1a14", fontStyle: isSpecial ? "italic" : "normal", fontWeight: isChapterOnlyRow ? "bold" : "normal", textTransform: isChapterOnlyRow ? "uppercase" : "none", letterSpacing: isChapterOnlyRow ? "0.5px" : "normal", flex: 1, minWidth: 0, fontFamily: "'Spectral',serif" }}
                      />
                      {isPlaceholder && (
                        <button
                          onClick={() => doNameSinglePlaceholder(s.id)}
                          disabled={singleNamingId === s.id}
                          title="Згенерувати назву"
                          style={{ background: "transparent", border: "none", fontSize: 14, cursor: singleNamingId === s.id ? "wait" : "pointer", padding: "2px 6px", color: singleNamingId === s.id ? "#ccc" : "#b8a020", flexShrink: 0 }}
                        >{singleNamingId === s.id ? "…" : "✨"}</button>
                      )}
                      {isChapterOnlyRow && isChapTitlePlaceholder && (
                        <button
                          onClick={() => doNameSingleChapter(chapNum)}
                          disabled={chapNaming}
                          title="Згенерувати назву розділу"
                          style={{ background: "transparent", border: "none", fontSize: 14, cursor: chapNaming ? "wait" : "pointer", padding: "2px 6px", color: chapNaming ? "#ccc" : "#8a7010", flexShrink: 0 }}
                        >{chapNaming ? "…" : "✨"}</button>
                      )}
                    </div>
                    <input type="number" min="1" value={s.pages} onChange={e => { const v = parseInt(e.target.value) || 1; setSections(p => { const next = p.map((x, j) => j === i ? { ...x, pages: v, prompts: x.type === "sources" ? 0 : Math.max(1, Math.ceil(v / 3)) } : x); setPlanDisplay(buildPlanText(next)); const { dist, total } = calcSourceDist(next); setSourceDist(dist); setSourceTotal(total); return next; }); }} style={{ background: "transparent", border: "none", fontSize: 13, padding: "9px 4px", color: "#1a1a14", textAlign: "center", width: "100%", fontFamily: "'Spectral',serif" }} />
                    <div style={{ textAlign: "center", fontSize: 12, color: "#888", padding: "9px" }}>{s.type === "sources" ? "—" : s.prompts}</div>
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2, padding: "4px 2px" }}>
                      {isMovable ? (
                        <div style={{ display: "flex", gap: 2 }}>
                          <button onClick={() => moveSectionUp(s.id)} disabled={!canUp} title="Вгору" style={{ background: "transparent", border: "none", fontSize: 12, cursor: canUp ? "pointer" : "default", color: canUp ? "#555" : "#ddd", padding: "1px 4px", lineHeight: 1 }}>↑</button>
                          <button onClick={() => moveSectionDown(s.id)} disabled={!canDown} title="Вниз" style={{ background: "transparent", border: "none", fontSize: 12, cursor: canDown ? "pointer" : "default", color: canDown ? "#555" : "#ddd", padding: "1px 4px", lineHeight: 1 }}>↓</button>
                        </div>
                      ) : null}
                    </div>
                    <div style={{ display: "flex", justifyContent: "center" }}>
                      <button onClick={() => setSections(p => { const next = p.filter((_, j) => j !== i); setPlanDisplay(buildPlanText(next)); const { dist, total } = calcSourceDist(next); setSourceDist(dist); setSourceTotal(total); return next; })} style={{ background: "transparent", border: "none", color: "#bbb", fontSize: 15, cursor: "pointer", padding: "2px 4px", borderRadius: 4 }} onMouseEnter={e => e.currentTarget.style.color = "#c03030"} onMouseLeave={e => e.currentTarget.style.color = "#bbb"}>✕</button>
                    </div>
                  </div>
                );
              });
              return rows;
            })()}
            <div style={{ padding: "10px 14px", background: "#f5f2eb", borderTop: "1px solid #e4dfd4", display: "flex", gap: 8, alignItems: "center" }}>
              {(() => {
                const importedSet = new Set(readyWorkImportedIds || []);
                const alreadyDone = sections.filter(x => importedSet.has(x.id)).reduce((s, x) => s + (x.pages || 0), 0);
                const toWrite = sections.filter(x => !importedSet.has(x.id)).reduce((s, x) => s + (x.pages || 0), 0);
                const ok = toWrite === totalPagesNum;
                return (
                  <span style={{ fontSize: 12, fontFamily: "'Spectral',serif", color: ok ? "#5a8a2a" : "#c03030", fontWeight: "bold", marginRight: 4 }}>
                    {toWrite} / {totalPagesNum} стор. {ok ? "✓" : "⚠"}
                    {alreadyDone > 0 ? <span style={{ color: "#888", fontWeight: "normal", marginLeft: 6 }}>(+{alreadyDone} стор. вже готово)</span> : null}
                  </span>
                );
              })()}
              <button onClick={() => {
                const mainSecs = sections.filter(s => !["intro", "conclusions", "sources", "chapter_conclusion"].includes(s.type));
                const lastId = mainSecs.length ? mainSecs[mainSecs.length - 1].id : "1.0";
                const [ch, sub] = lastId.split(".").map(Number);
                const newId = `${ch}.${(sub || 0) + 1}`;
                const newSubWord = getLangLabels(info?.language).subsWord;
                const newSec = { id: newId, label: `${newId} [${newSubWord}]`, sectionTitle: mainSecs[mainSecs.length - 1]?.sectionTitle || "", pages: Math.max(1, Math.round(totalPagesNum * 0.1)), prompts: 1, type: mainSecs[mainSecs.length - 1]?.type || "theory" };
                setSections(p => { const next = insertBeforeTail(p, [newSec]); setPlanDisplay(buildPlanText(next)); return next; });
              }} style={{ background: "transparent", border: "1.5px dashed #bbb4a0", color: "#888", borderRadius: 6, padding: "7px 20px", fontFamily: "'Spectral',serif", fontSize: 12, cursor: "pointer", flex: 1, letterSpacing: "1px" }}
                onMouseEnter={e => { e.currentTarget.style.borderColor = "#1a1a14"; e.currentTarget.style.color = "#1a1a14"; }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = "#bbb4a0"; e.currentTarget.style.color = "#888"; }}>
                + Підрозділ
              </button>
              <button onClick={addNewChapter} style={{ background: "transparent", border: "1.5px dashed #8ab060", color: "#6a9030", borderRadius: 6, padding: "7px 20px", fontFamily: "'Spectral',serif", fontSize: 12, cursor: "pointer", flex: 1, letterSpacing: "1px" }}
                onMouseEnter={e => { e.currentTarget.style.borderColor = "#3a6010"; e.currentTarget.style.color = "#3a6010"; }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = "#8ab060"; e.currentTarget.style.color = "#6a9030"; }}>
                + Розділ
              </button>
              <button onClick={addNewChapterEmpty} title="Розділ без підрозділів — текст пишеться суцільно на весь розділ" style={{ background: "transparent", border: "1.5px dashed #8ab060", color: "#6a9030", borderRadius: 6, padding: "7px 20px", fontFamily: "'Spectral',serif", fontSize: 12, cursor: "pointer", flex: 1, letterSpacing: "1px" }}
                onMouseEnter={e => { e.currentTarget.style.borderColor = "#3a6010"; e.currentTarget.style.color = "#3a6010"; }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = "#8ab060"; e.currentTarget.style.color = "#6a9030"; }}>
                + Розділ без підрозділів
              </button>
              <button onClick={recalcPages} style={{ background: "transparent", border: "1.5px dashed #a0a0a0", color: "#888", borderRadius: 6, padding: "7px 14px", fontFamily: "'Spectral',serif", fontSize: 11, cursor: "pointer", letterSpacing: "0.5px", whiteSpace: "nowrap" }}
                onMouseEnter={e => { e.currentTarget.style.borderColor = "#555"; e.currentTarget.style.color = "#555"; }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = "#a0a0a0"; e.currentTarget.style.color = "#888"; }}>
                ⟳ стор.
              </button>
            </div>
          </div>

          {sections.some(s => !["intro", "conclusions", "sources", "chapter_conclusion"].includes(s.type) && /\[|новий/i.test(s.label)) && (
            <div style={{ marginBottom: 14 }}>
              <GreenBtn
                onClick={doNamePlaceholders}
                loading={namingLoading}
                msg="Генерую назви..."
                label="✨ Придумати назви для заглушок"
              />
            </div>
          )}
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <NavBtn onClick={() => setStage("parsed")}>← Назад</NavBtn>
          </div>

          {/* Вибір режиму або продовження — контент з готової частини роботи клієнта (readyWorkImportedIds)
              не рахуємо "вже згенерованим", бо це перший прохід, а не повернення після написання */}
          {Object.keys(content).some(id => !readyWorkImportedIds?.includes(id)) ? (
            <div style={{ marginTop: 16, padding: "16px 18px", background: "#f0f5e8", border: "1.5px solid #c8dfa0", borderRadius: 8 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: "#2a4010", marginBottom: 12 }}>Текст вже згенеровано — продовжте роботу:</div>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <button
                  onClick={() => setStage("sources")}
                  style={{
                    flex: 1, minWidth: 200, padding: "12px 16px", borderRadius: 8, cursor: "pointer",
                    fontFamily: "'Spectral',serif", fontSize: 13, textAlign: "left", lineHeight: 1.5,
                    background: "#2a3a1a", color: "#e8ff47", border: "2px solid #5a9a1a",
                  }}
                >
                  <div style={{ fontWeight: 600, marginBottom: 4 }}>Продовжити →</div>
                  <div style={{ fontSize: 11, color: "#a8d060", opacity: 0.9 }}>Повернутись до вже згенерованого тексту</div>
                </button>
                <button
                  onClick={() => { if (window.confirm("Увага! Весь згенерований текст буде стерто. Продовжити?")) startGen(); }}
                  style={{
                    padding: "12px 16px", borderRadius: 8, cursor: "pointer",
                    fontFamily: "'Spectral',serif", fontSize: 12, textAlign: "left", lineHeight: 1.5,
                    background: "transparent", color: "#888", border: "1.5px dashed #ccc",
                  }}
                >
                  <div style={{ fontWeight: 600, marginBottom: 4 }}>Генерувати заново</div>
                  <div style={{ fontSize: 11, opacity: 0.8 }}>Стере поточний текст</div>
                </button>
              </div>
            </div>
          ) : (
            <div style={{ marginTop: 16, padding: "16px 18px", background: "#f0f5e8", border: "1.5px solid #c8dfa0", borderRadius: 8 }}>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <button
                  onClick={() => startGen()}
                  style={{
                    flex: 1, minWidth: 200, padding: "12px 16px", borderRadius: 8, cursor: "pointer",
                    fontFamily: "'Spectral',serif", fontSize: 13, textAlign: "left", lineHeight: 1.5,
                    background: "#2a3a1a", color: "#e8ff47", border: "2px solid #5a9a1a",
                  }}
                >
                  <div style={{ fontWeight: 600, marginBottom: 4 }}>Спочатку джерела →</div>
                  <div style={{ fontSize: 11, color: "#a8d060", opacity: 0.9 }}>Знайдіть джерела, потім AI пише текст спираючись на них і вставляє [1][2] одразу</div>
                </button>
              </div>
            </div>
          )}
        </>
      ) : (
        <div style={{ color: "#888", fontSize: 14 }}>
          Помилка генерації.{" "}
          <button onClick={doGenPlan} style={{ background: "none", border: "none", color: "#1a1a14", textDecoration: "underline", cursor: "pointer", fontSize: 14, fontFamily: "inherit" }}>Спробувати ще раз</button>
        </div>
      )}
    </div>
  );
}
