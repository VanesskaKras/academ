import { FIELD_LABELS, parsePagesAvg, isEcon } from "../../lib/planUtils.js";
import { Heading, NavBtn, PrimaryBtn } from "../Buttons.jsx";
import { SpinDot } from "../SpinDot.jsx";
import { getAcademicDefaults } from "../../lib/academicDefaults.js";

const SAMPLE_SIZE_KW = /осіб|респондент|пацієнт|клієнт|учнів|спортсмен|учасник/i;

export function ParsedStage({
  info, setInfo, methodInfo, setMethodInfo, fileB64, apiError, sections,
  commentAnalysis, setCommentAnalysis,
  doGenPlan, setStage,
  running, loadMsg,
}) {
  const courseMissing = !String(info.course || "").trim();

  const defaults = getAcademicDefaults(info.subject, info.type, info.course, info.topic);
  const userMaterials = defaults?.appendicesUserProvide?.filter(Boolean) ?? [];
  const showSampleSize = !!(commentAnalysis?.researchDesign || (defaults && SAMPLE_SIZE_KW.test(defaults.researchType || "")));
  const sampleSize = commentAnalysis?.researchDesign?.statisticalMinN ?? "";

  return (
    <div className="fade">
      <Heading>02 / Перевірте дані</Heading>
      <p style={{ fontSize: 13, color: "#888", marginBottom: 20 }}>Клікніть на значення щоб змінити</p>

      {running && (
        <div style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 12, color: "#7a5000", background: "#fff8e8", border: "1px solid #e8c84a", borderRadius: 20, padding: "6px 14px", marginBottom: 16 }}>
          <SpinDot />
          Аналіз триває у фоні: {loadMsg || "обробляю…"} — можна редагувати дані нижче, план стане доступний після завершення.
        </div>
      )}

      {/* Напрям роботи */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16, padding: "10px 16px", background: "#f0ece2", borderRadius: 8, border: "1.5px solid #d4cfc4" }}>
        <div style={{ fontSize: 11, color: "#888", letterSpacing: "1px", textTransform: "uppercase", whiteSpace: "nowrap" }}>Напрям роботи</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {["Гуманітарне", "Економічне", "Технічне", "Біологічне"].map(cat => (
            <button key={cat} onClick={() => setInfo(p => ({ ...p, workCategory: cat }))}
              style={{ padding: "5px 16px", borderRadius: 20, fontSize: 12, cursor: "pointer", fontFamily: "inherit", border: "1.5px solid", transition: "all .15s",
                background: info.workCategory === cat ? "#1a1a14" : "transparent",
                color: info.workCategory === cat ? "#e8ff47" : "#555",
                borderColor: info.workCategory === cat ? "#1a1a14" : "#ccc" }}>
              {cat}
            </button>
          ))}
        </div>
      </div>

      <div style={{ border: "1.5px solid #d4cfc4", borderRadius: 8, overflow: "hidden", marginBottom: 16 }}>
        {Object.entries(FIELD_LABELS).map(([k, l], i, arr) => (
          <div key={k} style={{ display: "grid", gridTemplateColumns: "200px 1fr", borderBottom: (i < arr.length - 1 || showSampleSize) ? "1px solid #e4dfd4" : "none" }}>
            <div style={{ padding: "11px 16px", fontSize: 11, color: "#888", letterSpacing: "1px", textTransform: "uppercase", borderRight: "1px solid #e4dfd4", display: "flex", alignItems: "center", background: "#ede9e0" }}>{l}</div>
            <input value={info[k] || ""} onChange={e => setInfo(p => ({ ...p, [k]: e.target.value }))}
              style={{ padding: "11px 16px", background: "transparent", border: "none", fontSize: 14, color: "#1a1a14", width: "100%", fontFamily: "'Spectral',serif" }} />
          </div>
        ))}
        {showSampleSize && (
          <div style={{ display: "grid", gridTemplateColumns: "200px 1fr" }}>
            <div style={{ padding: "11px 16px", fontSize: 11, color: "#888", letterSpacing: "1px", textTransform: "uppercase", borderRight: "1px solid #e4dfd4", display: "flex", alignItems: "center", background: "#ede9e0" }}>Кількість осіб для вибірки</div>
            <div style={{ padding: "11px 16px", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
              <input type="number" min="1" value={sampleSize}
                onChange={e => {
                  const raw = e.target.value;
                  setCommentAnalysis(p => ({
                    ...(p || {}),
                    researchDesign: {
                      instrumentType: "questionnaire", groups: [], comparisonRequired: false, biographicalFields: [],
                      ...(p?.researchDesign || {}),
                      statisticalMinN: raw === "" ? null : Number(raw),
                    },
                  }));
                }}
                placeholder="Порожньо = автоматично"
                style={{ width: 200, padding: 0, background: "transparent", border: "none", fontSize: 14, color: "#1a1a14", fontFamily: "'Spectral',serif" }} />
              <span style={{ fontSize: 11, color: "#aaa" }}>Порожньо = система визначить сама{defaults?.researchType ? ` (за замовчуванням: ${defaults.researchType})` : ""}.</span>
            </div>
          </div>
        )}
      </div>
      {info.pages?.includes("-") && <div style={{ fontSize: 12, color: "#888", marginBottom: 16, fontStyle: "italic" }}>Діапазон "{info.pages}" → середнє: {parsePagesAvg(info.pages)} стор.</div>}

      {/* Оберіть підприємство (для економічних/фінансових робіт, або якщо методичка explicitly цього вимагає) */}
      {(isEcon(info) || methodInfo?.requiresEnterpriseProfile) && (
        <div style={{ border: "1.5px solid #f0d080", borderRadius: 8, overflow: "hidden", marginBottom: 16 }}>
          <div style={{ background: "#7a5a00", color: "#ffe89a", padding: "9px 16px", fontFamily: "'Spectral SC',serif", fontSize: 11, letterSpacing: 2 }}>
            ℹ ОБЕРІТЬ ПІДПРИЄМСТВО
          </div>
          <div style={{ padding: "12px 16px", background: "#fffbee", fontSize: 13, color: "#4a3800" }}>
            {methodInfo?.requiresEnterpriseProfile
              ? "Методичка прямо вимагає характеристику конкретного досліджуваного підприємства (назва, форма власності, історія тощо) — незалежно від теми. "
              : "Це економічна/фінансова робота — "}
            Оберіть реальне підприємство і додайте його дані (назву, галузь, фінансові показники) через розділ "Матеріали клієнта" на кроці 1. Якщо не додати — ШІ спробує знайти реальне підприємство цієї галузі у відкритих джерелах, а бракуючі дані добере правдоподібно{methodInfo?.requiresEnterpriseProfile ? " (з назвою та реквізитами)" : ""}; якщо нічого релевантного не знайдеться — використає умовний вигаданий приклад.
          </div>
        </div>
      )}

      {/* Підготуйте заздалегідь */}
      {userMaterials.length > 0 && (
        <div style={{ border: "1.5px solid #f0d080", borderRadius: 8, overflow: "hidden", marginBottom: 16 }}>
          <div style={{ background: "#7a5a00", color: "#ffe89a", padding: "9px 16px", fontFamily: "'Spectral SC',serif", fontSize: 11, letterSpacing: 2 }}>
            ℹ ПІДГОТУЙТЕ ЗАЗДАЛЕГІДЬ
          </div>
          <div style={{ padding: "12px 16px", background: "#fffbee" }}>
            <div style={{ fontSize: 12, color: "#7a5a00", marginBottom: 8 }}>
              Для цього типу роботи потрібні матеріали, які AI не може створити — підберіть їх до початку написання:
            </div>
            <ul style={{ margin: 0, padding: "0 0 0 18px" }}>
              {userMaterials.map((m, i) => (
                <li key={i} style={{ fontSize: 13, color: "#4a3800", marginBottom: 4 }}>{m}</li>
              ))}
            </ul>
            <div style={{ fontSize: 12, color: "#7a5a00", marginTop: 10, fontStyle: "italic" }}>
              Поверніться на крок 1 (кнопка "← Назад") і додайте ці матеріали через розділ "Матеріали клієнта", перед тим як генерувати план.
            </div>
          </div>
        </div>
      )}

      {/* Карточка методички або помилка */}
      {!methodInfo && fileB64 && apiError && (
        <div style={{ border: "1.5px solid #f5c6c6", borderRadius: 8, overflow: "hidden", marginBottom: 20 }}>
          <div style={{ background: "#8a1a1a", color: "#ffd0d0", padding: "9px 16px", fontFamily: "'Spectral SC',serif", fontSize: 11, letterSpacing: 2 }}>
            ⚠ ПОМИЛКА АНАЛІЗУ МЕТОДИЧКИ
          </div>
          <div style={{ padding: "12px 16px", background: "#fff5f5", fontSize: 13, color: "#8a1a1a" }}>{apiError}</div>
        </div>
      )}
      {methodInfo && (
        <div style={{ border: "1.5px solid #c8dfa0", borderRadius: 8, overflow: "hidden", marginBottom: 20 }}>
          <div style={{ background: "#2a3a1a", color: "#a8d060", padding: "9px 16px", fontFamily: "'Spectral SC',serif", fontSize: 11, letterSpacing: 2 }}>
            📋 ВИТЯГНУТО З МЕТОДИЧКИ
          </div>
          <div style={{ padding: "14px 18px", background: "#f5faf0", display: "flex", flexWrap: "wrap", gap: 8 }}>
            {methodInfo.totalPages && <span style={{ fontSize: 12, background: "#eef5e4", color: "#3a6010", padding: "3px 10px", borderRadius: 10 }}>📄 Обсяг: {methodInfo.totalPages} стор.</span>}
            {methodInfo.chaptersCount && <span style={{ fontSize: 12, background: "#eef5e4", color: "#3a6010", padding: "3px 10px", borderRadius: 10 }}>📑 Розділів: {methodInfo.chaptersCount}</span>}
            <span
              onClick={() => setMethodInfo(p => ({ ...p, hasChapterConclusions: !p.hasChapterConclusions }))}
              title="Клікніть щоб увімкнути/вимкнути"
              style={{ fontSize: 12, background: methodInfo.hasChapterConclusions ? "#eef5e4" : "#f0ece2", color: methodInfo.hasChapterConclusions ? "#3a6010" : "#888", padding: "3px 10px", borderRadius: 10, cursor: "pointer", userSelect: "none", border: "1px dashed " + (methodInfo.hasChapterConclusions ? "#a8d060" : "#ccc") }}
            >
              {methodInfo.hasChapterConclusions ? "✓ Висновки до розділів" : "✗ Без висновків до розділів"}
            </span>
            {methodInfo.sourcesStyle && <span style={{ fontSize: 12, background: "#e4f0ff", color: "#1a5a8a", padding: "3px 10px", borderRadius: 10 }}>📚 Стиль: {methodInfo.sourcesStyle}</span>}
            {methodInfo.sourcesOrder && <span style={{ fontSize: 12, background: "#e4f0ff", color: "#1a5a8a", padding: "3px 10px", borderRadius: 10 }}>{methodInfo.sourcesOrder === "alphabetical" ? "🔤 За алфавітом" : "🔢 За появою"}</span>}
            {methodInfo.formatting?.font && <span style={{ fontSize: 12, background: "#f0ece2", color: "#555", padding: "3px 10px", borderRadius: 10 }}>🖋 {methodInfo.formatting.font} {methodInfo.formatting.fontSize}pt</span>}
            {methodInfo.formatting?.margins && <span style={{ fontSize: 12, background: "#f0ece2", color: "#555", padding: "3px 10px", borderRadius: 10 }}>📐 Поля: Л{methodInfo.formatting.margins.left}мм П{methodInfo.formatting.margins.right}мм</span>}
            {methodInfo.citationStyle && <span style={{ fontSize: 12, background: "#f5e4ff", color: "#8a1a8a", padding: "3px 10px", borderRadius: 10 }}>🔗 {methodInfo.citationStyle}</span>}
          </div>
        </div>
      )}

      {courseMissing && (
        <div style={{ fontSize: 12, color: "#8a1a1a", marginBottom: 12 }}>⚠ Вкажіть курс, щоб продовжити</div>
      )}

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <NavBtn onClick={() => setStage("input")}>← Назад</NavBtn>
        {sections.length > 0 && <NavBtn onClick={() => setStage("plan")} disabled={courseMissing || running}>Вперед (збережений план) →</NavBtn>}
        <PrimaryBtn onClick={doGenPlan} disabled={courseMissing} loading={running} msg={loadMsg || "Аналізую…"} label={sections.length > 0 ? "Перегенерувати план →" : "Генерувати план →"} />
      </div>
    </div>
  );
}
