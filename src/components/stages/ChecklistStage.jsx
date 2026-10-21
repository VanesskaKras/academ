import { useState } from "react";
import { Heading, NavBtn } from "../Buttons.jsx";

const CHECKLIST_FINAL = [
  { label: "Перевірено на плагіат та ШІ", link: "https://my.plag.com.ua/my-documents" },
  { label: "У вступі всі структурні елементи виділені жирним" },
  { label: "Виправлено титульну сторінку (якщо є)" },
  { label: "Таблиці що переносяться — розбиті на окремі" },
  { label: "Зміст додано через автоматичні посилання" },
];

const CHECKLIST_SMALL = [
  "Перевірено текст на помилки",
  "Перевірено відповідність темі",
  "Перевірена кількість сторінок",
  "Збережено копію роботи",
];

function getMethodItems(methodInfo) {
  if (!methodInfo) return [];
  const items = [];

  if (methodInfo.introComponents?.length) {
    items.push(`Вступ містить усі елементи: ${methodInfo.introComponents.join(", ")}`);
  }

  if (methodInfo.taskSheetTemplate?.length) items.push("Додано сторінку «Завдання на роботу»");
  if (methodInfo.calendarPlanTable) items.push("Додано «Календарний план» виконання роботи");

  const srcParts = [];
  if (methodInfo.sourcesMinCount) srcParts.push(`мінімум ${methodInfo.sourcesMinCount}`);
  if (methodInfo.sourcesStyle) srcParts.push(`стиль ${methodInfo.sourcesStyle}`);
  if (srcParts.length) items.push(`Джерела: ${srcParts.join(", ")}`);

  if (methodInfo.sourcesOrder === "alphabetical") items.push("Джерела в алфавітному порядку");
  else if (methodInfo.sourcesOrder === "citation_order") items.push("Джерела в порядку першої згадки у тексті");

  if (methodInfo.citationStyle) items.push(`Посилання у тексті: ${methodInfo.citationStyle}`);

  const fmt = methodInfo.formatting;
  if (fmt) {
    const fmtParts = [];
    if (fmt.font) fmtParts.push(fmt.font);
    if (fmt.fontSize) fmtParts.push(`${fmt.fontSize}pt`);
    if (fmt.lineSpacing) fmtParts.push(`інтервал ${fmt.lineSpacing}`);
    if (fmtParts.length) items.push(`Шрифт та інтервал: ${fmtParts.join(", ")}`);

    if (fmt.margins) {
      const m = fmt.margins;
      items.push(`Поля: ${m.left}/${m.right}/${m.top}/${m.bottom} мм (ліво/право/верх/низ)`);
    }
    if (fmt.chapterHeading) items.push(`Заголовки розділів: ${fmt.chapterHeading}`);
    if (fmt.subsectionHeading) items.push(`Підзаголовки: ${fmt.subsectionHeading}`);
    if (fmt.pageNumbers) items.push(`Нумерація сторінок: ${fmt.pageNumbers}`);
    if (fmt.tableFormat) items.push(`Таблиці: ${fmt.tableFormat}`);
    if (fmt.figureFormat) items.push(`Рисунки: ${fmt.figureFormat}`);
  }

  return items;
}

function buildSections(mode, methodInfo) {
  const raw = [];

  if (mode === "large") {
    raw.push({ title: "Фінальне оформлення", items: CHECKLIST_FINAL });
    const methodItems = getMethodItems(methodInfo);
    if (methodItems.length > 0) {
      raw.push({ title: "Звірка з методичкою", items: methodItems.map(label => ({ label })) });
    }
  } else {
    raw.push({ title: null, items: CHECKLIST_SMALL.map(label => ({ label })) });
  }

  let idx = 0;
  return raw.map(section => ({
    ...section,
    items: section.items.map(item => ({ ...item, idx: idx++ })),
  }));
}

function InfoRow({ label, value }) {
  if (!value) return null;
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 10, letterSpacing: "1.5px", color: "#555", textTransform: "uppercase", marginBottom: 3 }}>{label}</div>
      <div style={{ fontSize: 13, color: "#f5f2eb", lineHeight: 1.5 }}>{value}</div>
    </div>
  );
}

function MethodInfoBlock({ methodInfo }) {
  if (!methodInfo) return null;
  const fmt = methodInfo.formatting;

  return (
    <div style={{ marginTop: 20, paddingTop: 16, borderTop: "1px solid #333" }}>
      <div style={{ fontSize: 11, letterSpacing: "2px", color: "#e8ff47", textTransform: "uppercase", marginBottom: 16 }}>З методички</div>

      {methodInfo.introComponents?.length > 0 && (
        <InfoRow label="Елементи вступу" value={methodInfo.introComponents.join(", ")} />
      )}

      {(methodInfo.sourcesMinCount || methodInfo.sourcesStyle || methodInfo.sourcesOrder) && (
        <InfoRow label="Список джерел" value={[
          methodInfo.sourcesMinCount && `мінімум ${methodInfo.sourcesMinCount}`,
          methodInfo.sourcesStyle && `стиль ${methodInfo.sourcesStyle}`,
          methodInfo.sourcesOrder === "alphabetical" && "алфавітний порядок",
          methodInfo.sourcesOrder === "citation_order" && "порядок цитування",
        ].filter(Boolean).join(" · ")} />
      )}

      {methodInfo.citationStyle && (
        <InfoRow label="Цитування у тексті" value={methodInfo.citationStyle} />
      )}

      {fmt && <>
        {(fmt.font || fmt.fontSize || fmt.lineSpacing) && (
          <InfoRow label="Шрифт / інтервал" value={[
            fmt.font,
            fmt.fontSize && `${fmt.fontSize}pt`,
            fmt.lineSpacing && `інт. ${fmt.lineSpacing}`,
          ].filter(Boolean).join(", ")} />
        )}
        {fmt.margins && (
          <InfoRow label="Поля (л/п/в/н)" value={`${fmt.margins.left} / ${fmt.margins.right} / ${fmt.margins.top} / ${fmt.margins.bottom} мм`} />
        )}
        {fmt.indent && (
          <InfoRow label="Абзацний відступ" value={`${fmt.indent} см`} />
        )}
        {fmt.pageNumbers && (
          <InfoRow label="Нумерація сторінок" value={fmt.pageNumbers} />
        )}
        {fmt.chapterHeading && (
          <InfoRow label="Заголовки розділів" value={fmt.chapterHeading} />
        )}
        {fmt.subsectionHeading && (
          <InfoRow label="Підзаголовки" value={fmt.subsectionHeading} />
        )}
        {fmt.tableFormat && (
          <InfoRow label="Таблиці" value={fmt.tableFormat} />
        )}
        {fmt.figureFormat && (
          <InfoRow label="Рисунки" value={fmt.figureFormat} />
        )}
      </>}
    </div>
  );
}

export function ChecklistStage({ info, methodInfo, setStage, mode = "large" }) {
  const sections = buildSections(mode, methodInfo);
  const totalItems = sections.reduce((sum, s) => sum + s.items.length, 0);

  const [checked, setChecked] = useState(() =>
    Object.fromEntries(Array.from({ length: totalItems }, (_, i) => [i, false]))
  );

  const doneCount = Object.values(checked).filter(Boolean).length;
  const allDone = doneCount === totalItems;
  const toggle = (idx) => setChecked(c => ({ ...c, [idx]: !c[idx] }));

  return (
    <div className="fade">
      <Heading style={{ marginBottom: 4 }}>Перевірка роботи</Heading>
      <p style={{ fontSize: 13, color: "#888", marginBottom: 24 }}>Перевірте всі пункти перед здачею замовлення.</p>

      <div style={{ display: "flex", gap: 20, alignItems: "flex-start", flexWrap: "wrap" }}>

        {/* ── Ліворуч: зведення замовлення ── */}
        <div style={{ flex: 1, minWidth: 260, background: "#1a1a14", border: "1.5px solid #333", borderRadius: 10, padding: "22px 24px" }}>
          <div style={{ fontSize: 11, letterSpacing: "2px", color: "#e8ff47", textTransform: "uppercase", marginBottom: 20 }}>Замовлення</div>
          <InfoRow label="Тема" value={info?.topic} />
          <InfoRow label="Тип роботи" value={info?.type} />
          <InfoRow label="Предмет / спеціальність" value={info?.subject || info?.direction} />
          <InfoRow label="Кількість сторінок" value={info?.pages} />
          <InfoRow label="Унікальність" value={info?.uniqueness} />
          <InfoRow label="Дедлайн" value={info?.deadline} />
          {mode === "large" && info?.sourceCount && (
            <InfoRow label="Кількість джерел" value={String(info.sourceCount)} />
          )}
          {mode === "large" && <MethodInfoBlock methodInfo={methodInfo} />}
        </div>

        {/* ── Праворуч: чек-лист ── */}
        <div style={{ flex: 1, minWidth: 260, background: "#faf8f3", border: "1.5px solid #d4cfc4", borderRadius: 10, padding: "22px 24px" }}>
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 20 }}>
            <div style={{ fontSize: 11, letterSpacing: "2px", color: "#7a7060", textTransform: "uppercase" }}>Чек-лист</div>
            <div style={{ fontSize: 12, color: allDone ? "#2a7a2a" : "#888" }}>
              {doneCount} / {totalItems}
            </div>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {sections.map((section, si) => (
              <div key={si}>
                {section.title && (
                  <div style={{
                    fontSize: 10, letterSpacing: "1.5px", color: "#7a7060",
                    textTransform: "uppercase", marginBottom: 8,
                    paddingBottom: 6, borderBottom: "1px solid #e0dbd4",
                  }}>
                    {section.title}
                  </div>
                )}
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {section.items.map((item) => {
                    const isChecked = checked[item.idx];
                    return (
                      <label
                        key={item.idx}
                        style={{
                          display: "flex", alignItems: "center", gap: 12, cursor: "pointer",
                          padding: "11px 14px", borderRadius: 7,
                          background: isChecked ? "#e8f5e8" : "#fff",
                          border: `1.5px solid ${isChecked ? "#6a9a6a" : "#d4cfc4"}`,
                          transition: "background 0.15s, border-color 0.15s",
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={() => toggle(item.idx)}
                          style={{ width: 16, height: 16, accentColor: "#4a8a4a", cursor: "pointer", flexShrink: 0 }}
                        />
                        <span style={{
                          fontSize: 13, lineHeight: 1.4,
                          color: isChecked ? "#3a6a3a" : "#2a2a1e",
                          textDecoration: isChecked ? "line-through" : "none",
                          display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap",
                        }}>
                          {item.label}
                          {item.link && (
                            <a
                              href={item.link}
                              target="_blank"
                              rel="noopener noreferrer"
                              onClick={e => e.stopPropagation()}
                              style={{ fontSize: 11, color: "#5a7a9a", textDecoration: "none", whiteSpace: "nowrap" }}
                            >
                              ↗ перейти
                            </a>
                          )}
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>

          {allDone && (
            <div style={{ marginTop: 16, padding: "12px 14px", background: "#d4f0d4", borderRadius: 8, fontSize: 13, color: "#2a6a2a", display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 16 }}>✓</span> Усі пункти виконано — робота готова до здачі!
            </div>
          )}
        </div>
      </div>

      <div style={{ marginTop: 24 }}>
        <NavBtn onClick={() => setStage("done")}>← Готово</NavBtn>
      </div>
    </div>
  );
}
