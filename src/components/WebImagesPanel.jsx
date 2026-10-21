import { SpinDot } from "./SpinDot.jsx";

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
}

const btn = (disabled) => ({
  fontSize: 11, background: "transparent", border: "1px solid #6a9a78", borderRadius: 5, padding: "3px 10px",
  cursor: disabled ? "default" : "pointer", color: disabled ? "#aaa" : "#2a5a3a", fontFamily: "'Spectral',serif",
});

// Фото з інтернету для рисунків-заглушок (src/lib/webImages.js) — що знайдено, що ні,
// кнопки "Інше" / "Прибрати" / "Шукати фото". figs — findPlaceholderFigures() по
// поточному тексту; wi — результат useWebImages().
export function WebImagesPanel({ figs, wi, onSearchAll, onSearchOne }) {
  const { webImages, webImagesDone, webImagesBusy, busyKeys, notes, storeError, remove } = wi;
  if (!figs.length && !webImagesBusy) return null;
  return (
    <div style={{ marginTop: 20, border: "1.5px solid #9cc3a8", borderRadius: 8, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "10px 16px", background: "#eef7f0" }}>
        <span style={{ fontWeight: 600, fontSize: 13, color: "#2a5a3a", fontFamily: "'Spectral',serif" }}>Фото з інтернету для рисунків без зображення</span>
        {webImagesBusy ? (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11, color: "#2a5a3a" }}><SpinDot /> Шукаю фото…</span>
        ) : figs.length > 0 && !webImagesDone ? (
          <button onClick={onSearchAll} style={btn(false)}>Знайти фото</button>
        ) : null}
      </div>
      <div style={{ padding: "12px 16px", background: "#fafdfb" }}>
        {figs.map(fig => {
          const img = webImages.find(w => w.key === fig.key);
          const busy = webImagesBusy || !!busyKeys[fig.key];
          const status = busyKeys[fig.key] ? "Шукаю…"
            : img ? `Джерело: ${hostOf(img.page || img.url)}`
            : notes[fig.key] || (webImagesBusy ? "У черзі…" : webImagesDone ? "Фото не знайдено — у файлі лишиться лише підпис" : "Ще не шукали");
          return (
            <div key={fig.key} style={{ display: "flex", gap: 12, alignItems: "flex-start", marginBottom: 12, paddingLeft: 10, borderLeft: `3px solid ${img ? "#6a9a78" : "#e8c84a"}` }}>
              {img && (
                <a href={img.page || img.url} target="_blank" rel="noreferrer" style={{ flexShrink: 0 }}>
                  <img src={`data:${img.type || "image/jpeg"};base64,${img.b64}`} alt={fig.name}
                    style={{ width: 110, height: 80, objectFit: "contain", background: "#fff", border: "1px solid #c4d8ca", borderRadius: 4, display: "block" }} />
                </a>
              )}
              <div style={{ flex: 1, minWidth: 0, fontSize: 12, lineHeight: 1.6 }}>
                <div style={{ color: "#1a1a14", fontWeight: 600 }}>{fig.caption}</div>
                {fig.secLabel && <div style={{ color: "#888", fontSize: 11 }}>{fig.secLabel}</div>}
                <div style={{ color: img ? "#3a6a4a" : "#7a5a20", fontSize: 11, marginTop: 2 }}>{status}</div>
                {notes[fig.key] && img && <div style={{ color: "#7a5a20", fontSize: 11 }}>{notes[fig.key]}</div>}
                <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
                  {img ? (
                    <>
                      <button disabled={busy} onClick={() => onSearchOne(fig)} style={btn(busy)}>Інше</button>
                      <button disabled={busy} onClick={() => remove(fig)} style={btn(busy)}>Прибрати</button>
                    </>
                  ) : (
                    <button disabled={busy} onClick={() => onSearchOne(fig)} style={btn(busy)}>Шукати фото</button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
        {storeError && <div style={{ fontSize: 12, color: "#a03020", marginTop: 6 }}>{storeError}</div>}
      </div>
    </div>
  );
}
