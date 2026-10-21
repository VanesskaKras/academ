import { useState, useEffect, useRef } from "react";
import { paperToCitation, enrichManualLine, enrichFullSourceInfo, enrichSources, compareForAutoInsert, hasKnownPages, cleanAuthorList } from "../../lib/sourcesSearch.js";
import { detectInTextPagePolicy } from "../../lib/citationFormatting.js";
import { isTechnical, sourceLangQuota } from "../../lib/planUtils.js";
import { autoSelectSources } from "../../lib/orderStages.js";
import { TA_WHITE } from "../../shared.jsx";
import { Heading, NavBtn, PrimaryBtn, GreenBtn } from "../Buttons.jsx";
import { SpinDot } from "../SpinDot.jsx";

// Звідки сторінки джерела — менеджер бачить, чому їм можна вірити (чи варто перевірити)
const PAGES_SRC_LABEL = {
  crossref: 'CrossRef', openalex: 'OpenAlex', doaj: 'DOAJ', s2: 'Semantic Scholar',
  meta: 'сайт журналу', pdf: 'PDF статті', books: 'Google Books', doi: 'з DOI',
};

function pagesLine(paper) {
  const src = PAGES_SRC_LABEL[paper.pagesSrc];
  if (paper.pages) return ` · С. ${paper.pages}${src ? ` (${src})` : ''}`;
  if (paper.totalPages) return ` · ${paper.totalPages} с.${src ? ` (${src})` : ''}`;
  if (paper.noPages) return ' · без сторінок (електронне видання)';
  return '';
}

// ── Картка одного знайденого джерела ──
function SourceCard({ paper, checked, onToggle, pagesRequired }) {
  const authorsList = cleanAuthorList(paper.authors);
  const authLine = authorsList.length > 2
    ? `${authorsList.slice(0, 2).join(', ')} та ін.`
    : authorsList.join(', ') || 'Автор невідомий';
  const isUk = paper.lang === 'uk';
  const isPl = paper.lang === 'pl';
  const langBg = isUk ? '#e8f5e0' : isPl ? '#fff0f5' : '#e8f0ff';
  const langColor = isUk ? '#3a6010' : isPl ? '#8a1050' : '#1a4a8a';
  const langBorder = isUk ? '#b8dfa0' : isPl ? '#e0a0c0' : '#b0c8f0';
  const langLabel = isUk ? '🇺🇦 укр.' : isPl ? '🇵🇱 польськ.' : '🌐 зарубіж.';
  return (
    <label style={{
      display: 'flex', gap: 10, alignItems: 'flex-start', cursor: 'pointer',
      padding: '9px 12px', borderRadius: 7,
      background: checked ? '#f0f8e8' : '#faf8f3',
      border: `1.5px solid ${checked ? '#8cc84b' : '#e0ddd5'}`,
      marginBottom: 6, transition: 'all 0.15s',
    }}>
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        style={{ marginTop: 3, accentColor: '#5a9a1a', flexShrink: 0 }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: authorsList.length ? '#3a6010' : '#8a6010' }}>{authLine}</span>
          {!authorsList.length && paper.doi && <span style={{ fontSize: 10, color: '#8a6010', fontStyle: 'italic' }}>↗ буде уточнено по DOI</span>}
          {paper.year && <span style={{ fontSize: 11, color: '#888' }}>{paper.year}</span>}
          <span style={{
            fontSize: 10, padding: '1px 6px', borderRadius: 8,
            background: langBg, color: langColor, border: `1px solid ${langBorder}`,
            flexShrink: 0,
          }}>{langLabel}</span>
          {paper.type === 'book' && (
            <span style={{
              fontSize: 10, padding: '1px 6px', borderRadius: 8,
              background: '#fff5e0', color: '#8a5a00', border: '1px solid #e8c870',
              flexShrink: 0,
            }}>📚 книга</span>
          )}
          {paper._missingFields?.length > 0 && (
            <span
              title={`Не вдалось автоматично підтягнути: ${paper._missingFields.join(', ')}`}
              style={{
                fontSize: 10, padding: '1px 6px', borderRadius: 8,
                background: '#fff0f0', color: '#a03030', border: '1px solid #e8b0b0',
                flexShrink: 0,
              }}
            >⚠ неповні дані: {paper._missingFields.join(', ')}</span>
          )}
          {pagesRequired && paper.type !== 'book' && paper.source !== 'institutional' && !hasKnownPages(paper) && (
            <span
              title="Методичка вимагає сторінку в посиланні [N, с. X], а сторінок цього джерела не вдалось знайти"
              style={{
                fontSize: 10, padding: '1px 6px', borderRadius: 8,
                background: '#fff0f0', color: '#a03030', border: '1px solid #e8b0b0',
                flexShrink: 0,
              }}
            >⚠ методичка вимагає сторінки</span>
          )}
          {paper._softFallback && (
            <span
              title="Пройшло лише Прохід А (score ≥ 80) — Прохід Б («адвокат диявола») не підтвердив. Додано резервно через нестачу джерел."
              style={{
                fontSize: 10, padding: '1px 6px', borderRadius: 8,
                background: '#fff0f0', color: '#a03030', border: '1px solid #e8b0b0',
                flexShrink: 0,
              }}
            >⚠ резервне (не пройшло Прохід Б)</span>
          )}
        </div>
        <div style={{ fontSize: 12, color: '#1a1a14', lineHeight: '1.4', marginBottom: 2 }}>
          {paper.title.length > 120 ? paper.title.slice(0, 120) + '…' : paper.title}
        </div>
        {(paper.venue || paper.pages || paper.totalPages || paper.noPages) && (
          <div style={{ fontSize: 11, color: '#777', fontStyle: 'italic' }}>
            {paper.venue}{pagesLine(paper)}
            {paper.pages && paper.pagesSrc === 'doi' && (
              <span title="Сторінки вгадано з кінця DOI — жодна база їх не підтвердила" style={{ color: '#a06010', fontStyle: 'normal' }}> ⚠ перевірити</span>
            )}
          </div>
        )}
        {paper.url && (
          <a
            href={paper.url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={e => e.stopPropagation()}
            style={{ display: 'inline-block', marginTop: 4, fontSize: 11, color: '#1a5a8a', textDecoration: 'none' }}
          >
            🔗 Відкрити джерело →
          </a>
        )}
      </div>
    </label>
  );
}

export function SourcesStage({
  mainSections, readyWorkImportedIds, citInputs, setCitInputs, citStructured, setCitStructured, sourceDist, sourceTotal,
  keywords, kwLoading, kwError, setKwError, methodInfo, commentAnalysis, onStopSearch,
  allRefs, refList, showMissingSources, citInputsSnapshot, allCitLoading, info,
  suggestedSources, phraseGroups, sourcesSearchLoading, sourcesSearchError, doSearchSources, doRegenSectionSources,
  doExpandYearsSection,
  doGenKeywords, onAddAbstracts, onAddSourceTheses, onFinish, remapLoading, stopRemap, onProceedToWriting, setStage,
  onRegenWithNewSources, hasGeneratedContent, onSave, saving,
  citStyleOverride, sourcesOrderOverride, onCitStyleChange, onSourcesOrderChange,
  citFootnotes, onCitFootnotesChange,
  pageByContent, onPageByContentChange,
}) {
  const [selectedSugg, setSelectedSugg] = useState({});
  const [suggOpen, setSuggOpen] = useState({});
  // "secId_phraseIdx" → поточна сторінка (1-based)
  const [phrasePages, setPhrasePages] = useState({});
  const [enrichLoading, setEnrichLoading] = useState({});
  const [enrichResult, setEnrichResult] = useState({});
  const [fullInfoLoading, setFullInfoLoading] = useState({});
  const [fullInfoResult, setFullInfoResult] = useState({});

  let runningIdx = 0;
  const missingSections = mainSections.filter(s => !(citInputs[s.id] || "").trim());
  const visibleSections = showMissingSources ? missingSections : mainSections;

  const _extraHints = (methodInfo?.otherRequirements || "") + " " + (methodInfo?.citationStyle || "");
  const defaultCitStyle = methodInfo?.sourcesStyle || (/APA/i.test(_extraHints) ? "APA" : /MLA/i.test(_extraHints) ? "MLA" : "ДСТУ 8302:2015");
  const effectiveCitStyle = citStyleOverride || defaultCitStyle;
  const effectiveSourcesOrder = sourcesOrderOverride || methodInfo?.sourcesOrder || "alphabetical";
  // Вимога методички до посилань у тексті: "[N, с. X]" → сторінки обов'язкові, "[N]" → без сторінок
  const inTextPagePolicy = detectInTextPagePolicy(methodInfo?.citationStyle);

  const isChecked = (secId, paperId) =>
    (selectedSugg[secId] || []).some(p => p.id === paperId);

  const togglePaper = (secId, paper) => {
    setSelectedSugg(prev => {
      const cur = prev[secId] || [];
      const exists = cur.some(p => p.id === paper.id);
      return {
        ...prev,
        [secId]: exists ? cur.filter(p => p.id !== paper.id) : [...cur, paper],
      };
    });
  };

  const selectAll = (secId) => {
    setSelectedSugg(prev => ({
      ...prev,
      [secId]: [...(suggestedSources[secId] || [])],
    }));
  };

  const clearAll = (secId) => {
    setSelectedSugg(prev => ({ ...prev, [secId]: [] }));
  };

  // Спільна логіка вставки джерел у підрозділ — і для ручного вибору (чекбокси), і для автовставки
  const insertSources = async (secId, papersToAdd, { capForeign = true } = {}) => {
    if (!papersToAdd.length) return;

    // Автозбагачення метаданих (DOI/сторінки/видавництво). Для джерел, що вже пройшли
    // пошук (авто чи ручний вибір з пропозицій), це здебільшого no-op — enrichSources
    // уже викликається раніше, в самому пошуковому циклі; тут — страховка для рядків,
    // які потрапили сюди іншим шляхом (напр. дозбагачення вже після ручного редагування).
    const enriched = await enrichSources(papersToAdd);

    // Мовна квота (sourceLangQuota): для української роботи зарубіжні до 30% (технічна — до 50%, бо
    // якісних укр. джерел по вузьких IT-темах об'єктивно мало); для роботи іншою мовою зарубіжні не
    // обмежуються (частку українських уже збалансовано в autoSelectSources) і йдуть першими.
    // capForeign=false — свідома відмова від квоти (ручний вибір користувача або останній fallback
    // при нестачі кількості, коли інакше знайдені релевантні іноземні джерела просто викидались би)
    const needed = sourceDist[secId] || 4;
    const { foreignWork, maxForeign } = sourceLangQuota(info?.language, isTechnical(info), needed);
    const ukPapers = enriched.filter(p => p.lang === 'uk');
    const enPapers = capForeign
      ? enriched.filter(p => p.lang !== 'uk').slice(0, maxForeign)
      : enriched.filter(p => p.lang !== 'uk');
    const papers = foreignWork ? [...enPapers, ...ukPapers] : [...ukPapers, ...enPapers];

    const newLines = papers.map(paperToCitation).filter(Boolean);
    if (!newLines.length) return;

    // Зберігаємо abstract snippets для промпту генерації тексту
    if (onAddAbstracts) {
      const entries = {};
      papers.forEach((p, i) => {
        if (p.abstract && newLines[i]) entries[newLines[i]] = p.abstract;
      });
      if (Object.keys(entries).length) onAddAbstracts(entries);
    }

    // Зберігаємо тезу, під яку джерело шукалось — потрібна для звірки змісту при
    // довставці пропущеної цитати й для пошуку заміни, якщо джерело не підійде
    if (onAddSourceTheses) {
      const entries = {};
      papers.forEach((p, i) => {
        if (p.sourceThesis && newLines[i]) entries[newLines[i]] = p.sourceThesis;
      });
      if (Object.keys(entries).length) onAddSourceTheses(entries);
    }

    // Використовуємо prev щоб уникнути stale closure; фільтруємо рядки, які вже є (захист від повторного натискання)
    setCitInputs(prev => {
      const cur = (prev[secId] || '').trimEnd();
      const curLinesNorm = cur ? cur.split('\n').map(l => l.trim().toLowerCase()) : [];
      const uniqueNewLines = newLines.filter(l => !curLinesNorm.includes(l.trim().toLowerCase()));
      if (!uniqueNewLines.length) return prev;
      const sep = cur ? '\n' : '';
      return { ...prev, [secId]: cur + sep + uniqueNewLines.join('\n') };
    });

    // Зберігаємо структуровані об'єкти паперів для якісного форматування
    if (setCitStructured) {
      setCitStructured(prev => ({
        ...prev,
        [secId]: [...(prev[secId] || []), ...papers],
      }));
    }

    // Авторозтягування textarea після програмного оновлення
    requestAnimationFrame(() => {
      const ta = document.querySelector(`textarea[data-secid="${secId}"]`);
      if (ta) { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; }
    });
  };

  const handleAddSelected = async (secId) => {
    const allSelected = selectedSugg[secId] || [];
    // capForeign:false — це явний вибір користувача (галочки), мовна квота тут недоречна
    await insertSources(secId, allSelected, { capForeign: false });
    setSelectedSugg(prev => ({ ...prev, [secId]: [] }));
  };

  // ── Автовставка: щойно пошук для підрозділу завершується, вставляємо підтверджені джерела
  // без очікування ручного вибору — користувач перевіряє й редагує результат у полі нижче.
  // Правила автовставки (свідомо без компромісів заради кількості):
  //  - лише score ≥ 70 (пройшло Прохід А і Прохід Б — незалежний "адвокат диявола" — в filterSourcesWithGemini);
  //  - лише якщо пройшло гейт повноти (_complete !== false: є рік, видання/видавництво і
  //    підтверджене існування; анотація — не блокує, лише інформаційний бейдж —
  //    виняток institutional-джерела, це фіксовані державні/офіційні посилання, не результат пошуку);
  //  - розподіл не лише за кількістю, а за покриттям тез: спершу по одному найкращому джерелу
  //    на кожну тезу, і лише потім — другі/треті по колу, щоб не вийшло "10 джерел на одну тезу
  //    і жодного на іншу";
  //  - якщо навіть так не набирається потрібна кількість — НЕ послаблюємо поріг, а вставляємо
  //    скільки є підтверджених; решту користувач бачить і добирає вручну зі списку нижче (без автовставки).
  const autoInsertedRef = useRef({});
  useEffect(() => {
    for (const sec of mainSections) {
      const secId = sec.id;
      const isLoading = sourcesSearchLoading[secId] || false;
      if (isLoading) { autoInsertedRef.current[secId] = false; continue; }
      if (autoInsertedRef.current[secId]) continue;
      const suggestions = suggestedSources[secId] || [];
      if (!suggestions.length) continue;
      if ((citInputs[secId] || '').trim()) continue; // вже є джерела — не втручаємось
      autoInsertedRef.current[secId] = true;

      const needed = sourceDist[secId] || 4;
      // Той самий добір, що й у воркері (autoSelectSources, orderStages.js): лише підтверджені
      // (score≥70 і гейт повноти, або інституційні), по колу за тезою — щоб покриття тем було
      // рівномірним, — з мовною квотою за мовою роботи. Раніше тут була окрема копія цього коду.
      const top = autoSelectSources([{ papers: suggestions }], needed, isTechnical(info), info?.language);
      if (top.length) insertSources(secId, top, { capForeign: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourcesSearchLoading, suggestedSources]);

  // ── Компенсація дефіциту: спрацьовує один раз одразу після того, як пошук
  // завершився по ВСІХ підрозділах. Якщо сумарно зібрано менше за рекомендовану
  // ціль (sourceTotal), шукаємо підрозділи-"донори" — ті, де свою квоту (needed)
  // вже виконано, але в пропозиціях лишились ще підтверджені (score≥70)
  // кандидати, яким просто не вистачило місця. Дефіцит розподіляється між
  // донорами ПРОПОРЦІЙНО розміру їхнього запасу (метод найбільших остач — той
  // самий, що й calcSourceDist для розподілу цілей), щоб не перевантажити один
  // підрозділ. Мета — sourceTotal; якщо донорів не вистачає навіть на
  // абсолютний мінімум — це вже ловить окремий жорсткий гейт перед переходом
  // у написання (academic-assistant.jsx/PracticePage.jsx), тут лише best-effort добір. ──
  const everLoadingRef = useRef(false);
  const compensationDoneRef = useRef(false);
  useEffect(() => {
    const anyLoading = mainSections.some(s => sourcesSearchLoading[s.id]);
    if (anyLoading) { everLoadingRef.current = true; compensationDoneRef.current = false; return; }
    if (!everLoadingRef.current || compensationDoneRef.current || !mainSections.length) return;
    compensationDoneRef.current = true;

    const countLines = (secId) => {
      const text = (citInputs[secId] || '').trim();
      return text ? text.split('\n').filter(l => l.trim()).length : 0;
    };
    const target = sourceTotal || mainSections.reduce((sum, s) => sum + (sourceDist[s.id] || 0), 0);
    const totalGathered = mainSections.reduce((sum, s) => sum + countLines(s.id), 0);
    const deficit = target - totalGathered;
    if (deficit <= 0) return;

    // Донор: свою квоту вже набрав, і в пропозиціях є ще не додані підтверджені кандидати
    const donors = mainSections.map(s => {
      const needed = sourceDist[s.id] || 0;
      if (countLines(s.id) < needed) return null;
      const added = (citInputs[s.id] || '').toLowerCase();
      const pool = (suggestedSources[s.id] || [])
        .filter(p => p.source === 'institutional' || ((p.geminiScore ?? 0) >= 70 && p._complete !== false))
        .filter(p => !added.includes((p.title || '').toLowerCase().slice(0, 60)))
        .sort(compareForAutoInsert);
      return pool.length ? { secId: s.id, pool } : null;
    }).filter(Boolean);
    if (!donors.length) return;

    const totalPool = donors.reduce((sum, d) => sum + d.pool.length, 0);
    const need = Math.min(deficit, totalPool);
    const raw = donors.map(d => (d.pool.length / totalPool) * need);
    const take = raw.map(v => Math.floor(v));
    let remainder = need - take.reduce((a, b) => a + b, 0);
    const order = raw
      .map((v, i) => ({ i, frac: v - Math.floor(v) }))
      .sort((a, b) => b.frac - a.frac);
    for (let k = 0; k < order.length && remainder > 0; k++) {
      if (take[order[k].i] < donors[order[k].i].pool.length) { take[order[k].i]++; remainder--; }
    }

    donors.forEach((d, i) => {
      if (take[i] > 0) insertSources(d.secId, d.pool.slice(0, take[i]), { capForeign: true });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourcesSearchLoading, suggestedSources, citInputs]);

  const handleEnrichManual = async (secId) => {
    const lines = (citInputs[secId] || '').split('\n');
    setEnrichLoading(prev => ({ ...prev, [secId]: true }));
    setEnrichResult(prev => ({ ...prev, [secId]: null }));
    try {
      // Послідовно, з паузою 400 мс між рядками — щоб уникнути 429 від академічних сайтів
      const enriched = [];
      for (let i = 0; i < lines.length; i++) {
        enriched.push(await enrichManualLine(lines[i]));
        if (i < lines.length - 1 && /https?:\/\//.test(lines[i])) {
          await new Promise(r => setTimeout(r, 400));
        }
      }
      const changed = enriched.filter((l, i) => l !== lines[i]).length;
      setCitInputs(prev => ({ ...prev, [secId]: enriched.join('\n') }));
      setEnrichResult(prev => ({ ...prev, [secId]: changed }));
      // Авторозтягування textarea
      requestAnimationFrame(() => {
        const ta = document.querySelector(`textarea[data-secid="${secId}"]`);
        if (ta) { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; }
      });
    } finally {
      setEnrichLoading(prev => ({ ...prev, [secId]: false }));
    }
  };

  const handleEnrichFullInfo = async (secId) => {
    const lines = (citInputs[secId] || '').split('\n');
    setFullInfoLoading(prev => ({ ...prev, [secId]: true }));
    setFullInfoResult(prev => ({ ...prev, [secId]: null }));
    try {
      // Послідовно, з паузою 400 мс між рядками — щоб уникнути 429 від CrossRef/Google Books
      const enriched = [];
      for (let i = 0; i < lines.length; i++) {
        enriched.push(await enrichFullSourceInfo(lines[i]));
        if (i < lines.length - 1) await new Promise(r => setTimeout(r, 400));
      }
      const changed = enriched.filter((l, i) => l !== lines[i]).length;
      setCitInputs(prev => ({ ...prev, [secId]: enriched.join('\n') }));
      setFullInfoResult(prev => ({ ...prev, [secId]: changed }));
      requestAnimationFrame(() => {
        const ta = document.querySelector(`textarea[data-secid="${secId}"]`);
        if (ta) { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; }
      });
    } finally {
      setFullInfoLoading(prev => ({ ...prev, [secId]: false }));
    }
  };

  return (
    <div className="fade">
      <Heading>04 / Джерела</Heading>

      {/* ── Заголовок: статистика + кнопка генерації ── */}
      <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 20, flexWrap: "wrap" }}>
        <div style={{ fontSize: 13, color: "#888" }}>
          Загальна к-сть джерел: <strong style={{ color: "#1a1a14" }}>{sourceTotal}</strong>
          {methodInfo?.sourcesMinCount
            ? <span style={{ marginLeft: 8, fontSize: 11, color: "#8a5a1a" }}>(мін. {typeof methodInfo.sourcesMinCount === 'object' ? JSON.stringify(methodInfo.sourcesMinCount) : methodInfo.sourcesMinCount} за методичкою)</span>
            : null}
        </div>
        {methodInfo && (methodInfo.sourcesStyle || methodInfo.sourcesOrder) && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {methodInfo.sourcesStyle && <span style={{ fontSize: 11, background: "#e4f0ff", color: "#1a5a8a", padding: "2px 10px", borderRadius: 10 }}>📋 {Array.isArray(methodInfo.sourcesStyle) ? methodInfo.sourcesStyle.join(', ') : typeof methodInfo.sourcesStyle === 'object' ? JSON.stringify(methodInfo.sourcesStyle) : methodInfo.sourcesStyle}</span>}
            {methodInfo.sourcesOrder && <span style={{ fontSize: 11, background: "#eef5e4", color: "#3a6010", padding: "2px 10px", borderRadius: 10 }}>{methodInfo.sourcesOrder === "alphabetical" ? "🔤 За алфавітом" : "🔢 За порядком появи"}</span>}
          </div>
        )}
        <GreenBtn
          onClick={() => { setKwError(""); doGenKeywords(); }}
          loading={kwLoading}
          msg="Генерую ключові слова та шукаю джерела..."
          label={Object.keys(keywords).length > 0 ? "Оновити ключові слова та джерела" : "Знайти джерела автоматично →"}
        />
        {kwLoading && (
          <button
            onClick={onStopSearch}
            style={{ background: "transparent", border: "1.5px solid #b03a3a", color: "#b03a3a", borderRadius: 7, padding: "9px 16px", fontFamily: "'Spectral',serif", fontSize: 12, letterSpacing: "1px", cursor: "pointer" }}
          >
            ⏹ Зупинити
          </button>
        )}
        {kwError && (
          <div style={{ fontSize: 12, color: "#8a1a1a", background: "#fff5f5", border: "1px solid #e8b0b0", borderRadius: 6, padding: "4px 10px" }}>
            ⚠ {kwError}
          </div>
        )}
      </div>

      {/* ── Налаштування оформлення джерел ── */}
      <div style={{ padding: "10px 16px", background: "#f5f2eb", border: "1.5px solid #d4cfc4", borderRadius: 8, marginBottom: 18, display: "flex", gap: 20, flexWrap: "wrap", alignItems: "center" }}>
        <span style={{ fontSize: 11, color: "#666", fontWeight: 600, flexShrink: 0 }}>Оформлення:</span>
        <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <span style={{ fontSize: 11, color: "#888" }}>Стиль</span>
          {["ДСТУ 8302:2015", "APA", "MLA"].map(s => {
            const active = effectiveCitStyle === s;
            return (
              <button key={s} onClick={() => onCitStyleChange(s)}
                style={{ fontSize: 11, padding: "3px 10px", borderRadius: 5, border: `1.5px solid ${active ? "#1a1a14" : "#c8c2b5"}`, background: active ? "#1a1a14" : "transparent", color: active ? "#f5f2eb" : "#555", cursor: "pointer", fontFamily: "inherit" }}>
                {s}
              </button>
            );
          })}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <span style={{ fontSize: 11, color: "#888" }}>Порядок</span>
          {[["alphabetical", "🔤 Алфавіт"], ["appearance", "🔢 За порядком"]].map(([val, label]) => {
            const active = effectiveSourcesOrder === val;
            return (
              <button key={val} onClick={() => onSourcesOrderChange(val)}
                style={{ fontSize: 11, padding: "3px 10px", borderRadius: 5, border: `1.5px solid ${active ? "#1a1a14" : "#c8c2b5"}`, background: active ? "#1a1a14" : "transparent", color: active ? "#f5f2eb" : "#555", cursor: "pointer", fontFamily: "inherit" }}>
                {label}
              </button>
            );
          })}
        </div>
        {effectiveCitStyle === "ДСТУ 8302:2015" && (
          <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <span style={{ fontSize: 11, color: "#888" }}>Посилання</span>
            {[[false, "У тексті"], [true, "Виноски"]].map(([val, label]) => {
              const active = !!citFootnotes === val;
              return (
                <button key={String(val)} onClick={() => onCitFootnotesChange(val)}
                  style={{ fontSize: 11, padding: "3px 10px", borderRadius: 5, border: `1.5px solid ${active ? "#1a1a14" : "#c8c2b5"}`, background: active ? "#1a1a14" : "transparent", color: active ? "#f5f2eb" : "#555", cursor: "pointer", fontFamily: "inherit" }}>
                  {label}
                </button>
              );
            })}
          </div>
        )}
        {onPageByContentChange && !citFootnotes && inTextPagePolicy !== "never" && (
          <div style={{ display: "flex", alignItems: "center", gap: 5 }}
            title="«За змістом PDF»: на фінальному кроці сторінка кожного посилання обирається там, де в PDF статті найбільше збігів з реченням перед посиланням (без ШІ). Без PDF чи при слабкому збігу — як звичайно, з діапазону сторінок джерела.">
            <span style={{ fontSize: 11, color: "#888" }}>Сторінка в посиланні</span>
            {[[false, "З діапазону"], [true, "За змістом PDF"]].map(([val, label]) => {
              const active = !!pageByContent === val;
              return (
                <button key={String(val)} onClick={() => onPageByContentChange(val)}
                  style={{ fontSize: 11, padding: "3px 10px", borderRadius: 5, border: `1.5px solid ${active ? "#1a1a14" : "#c8c2b5"}`, background: active ? "#1a1a14" : "transparent", color: active ? "#f5f2eb" : "#555", cursor: "pointer", fontFamily: "inherit" }}>
                  {label}
                </button>
              );
            })}
          </div>
        )}
        {inTextPagePolicy !== "auto" && (
          <span style={{ fontSize: 10, color: "#888", fontStyle: "italic" }}>
            {inTextPagePolicy === "never" ? "посилання без сторінок — за методичкою" : "сторінки в посиланнях обов'язкові — за методичкою"}
          </span>
        )}
        {(citStyleOverride || sourcesOrderOverride) && (
          <span style={{ fontSize: 10, color: "#e8a050", display: "flex", alignItems: "center", gap: 4 }}>
            ✏ змінено вручну ·{" "}
            <button onClick={() => { onCitStyleChange(null); onSourcesOrderChange(null); }}
              style={{ fontSize: 10, background: "transparent", border: "none", color: "#e8a050", cursor: "pointer", textDecoration: "underline", padding: 0, fontFamily: "inherit" }}>
              скинути
            </button>
          </span>
        )}
        {!citStyleOverride && !sourcesOrderOverride && (methodInfo?.sourcesStyle || methodInfo?.sourcesOrder) && (
          <span style={{ fontSize: 10, color: "#888", fontStyle: "italic" }}>за методичкою</span>
        )}
      </div>

      {/* ── Підказка ── */}
      <div style={{ padding: "12px 16px", background: "#f0f5e8", border: "1px solid #c8dfa0", borderRadius: 8, marginBottom: 20, fontSize: 13, color: "#3a6010", lineHeight: "1.7" }}>
        <strong>Як це працює:</strong> Натисніть <em>"Знайти джерела автоматично"</em> — програма згенерує ключові слова, знайде й оцінить джерела та сама вставить найрелевантніші (score ≥ 70) у кожен підрозділ; якщо їх бракує — розширить пошук (роки, альтернативні фрази). Перевірте результат у полях нижче — можна прибрати зайве або додати ще з пропозицій — і натисніть <em>"Розставити всі посилання"</em>, коли будете готові.
        <div style={{ marginTop: 6, fontSize: 12, color: "#5a6a3a" }}>
          Обмеження: іноземних джерел (польськ. + зарубіж.) <strong>не більше {isTechnical(info) ? 50 : 30}%</strong> від загальної кількості{isTechnical(info) ? " (підвищено для технічної роботи)" : ""}. Російські та білоруські джерела <strong>заборонені</strong>.
        </div>
        <div style={{ marginTop: 8 }}>
          <a
            href={`https://scholar.google.com/scholar?hl=uk&as_sdt=0%2C5&as_ylo=2021&q=${encodeURIComponent(info?.topic || "")}&btnG=`}
            target="_blank"
            rel="noopener noreferrer"
            style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: "#1a5a8a", textDecoration: "none", background: "#e4f0ff", padding: "4px 12px", borderRadius: 6, border: "1px solid #b0d0f0" }}
          >
            🎓 Шукати додатково на Google Scholar →
          </a>
        </div>
      </div>

      {/* ── Рекомендації з методички / клієнта ── */}
      {(methodInfo?.recommendedSources || commentAnalysis?.sourcesHints) && (
        <div style={{ padding: "12px 16px", background: "#fff8e8", border: "1px solid #e8d48a", borderRadius: 8, marginBottom: 20, fontSize: 13, color: "#5a3a00", lineHeight: "1.7" }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>Рекомендації щодо джерел:</div>
          {methodInfo?.recommendedSources && (
            <div style={{ marginBottom: commentAnalysis?.sourcesHints ? 8 : 0 }}>
              <span style={{ fontSize: 11, color: "#8a6010", textTransform: "uppercase", letterSpacing: "0.5px" }}>З методички: </span>
              {Array.isArray(methodInfo.recommendedSources)
                ? methodInfo.recommendedSources.join('; ')
                : typeof methodInfo.recommendedSources === 'object'
                  ? JSON.stringify(methodInfo.recommendedSources)
                  : methodInfo.recommendedSources}
            </div>
          )}
          {commentAnalysis?.sourcesHints && (
            <div>
              <span style={{ fontSize: 11, color: "#8a6010", textTransform: "uppercase", letterSpacing: "0.5px" }}>Від клієнта: </span>
              {Array.isArray(commentAnalysis.sourcesHints)
                ? commentAnalysis.sourcesHints.join('; ')
                : typeof commentAnalysis.sourcesHints === 'object'
                  ? JSON.stringify(commentAnalysis.sourcesHints)
                  : commentAnalysis.sourcesHints}
            </div>
          )}
        </div>
      )}


      {/* ── Підрозділи ── */}
      {visibleSections.map(sec => {
        const secRefs = (citInputs[sec.id] || "").split("\n").map(l => l.trim()).filter(Boolean);
        const startIdx = runningIdx + 1; runningIdx += secRefs.length;
        const hasSources = secRefs.length > 0;
        const isImported = readyWorkImportedIds?.includes(sec.id);
        const alreadyAdded = (citInputs[sec.id] || '').toLowerCase();
        const suggestions = (suggestedSources[sec.id] || []).filter(p =>
          !alreadyAdded.includes((p.title || '').toLowerCase().slice(0, 60))
        );
        const isSearching = sourcesSearchLoading[sec.id] || false;
        const searchErr = sourcesSearchError?.[sec.id] || null;
        const isOpen = suggOpen[sec.id] ?? (suggestions.length > 0);
        const selectedList = selectedSugg[sec.id] || [];
        const selectedCount = selectedList.length;
        const ukCount = suggestions.filter(p => p.lang === 'uk').length;
        const plCount = suggestions.filter(p => p.lang === 'pl').length;
        const enCount = suggestions.filter(p => p.lang !== 'uk' && p.lang !== 'pl').length;
        const needed = sourceDist[sec.id] || 4;
        const maxForeign = Math.max(1, Math.round(needed * (isTechnical(info) ? 0.5 : 0.3)));
        const selectedForeign = selectedList.filter(p => p.lang !== 'uk').length;
        const foreignOverLimit = selectedForeign > maxForeign;

        return (
          <div key={sec.id} style={{ border: `1.5px solid ${hasSources ? "#d4cfc4" : "#e8a050"}`, borderRadius: 8, overflow: "hidden", marginBottom: 14 }}>

            {/* Заголовок підрозділу */}
            <div style={{ background: "#1a1a14", padding: "11px 18px", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ width: 8, height: 8, borderRadius: "50%", background: hasSources ? "#5ad060" : "#e8a050", flexShrink: 0, display: "inline-block" }} />
                <span style={{ fontSize: 13, fontWeight: 600, color: "#f5f2eb" }}>{sec.label}</span>
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                {secRefs.length > 0 && <div style={{ fontSize: 11, color: "#888" }}>джерела [{startIdx}–{startIdx + secRefs.length - 1}]</div>}
                {isImported ? (
                  <div style={{ fontSize: 12, color: "#3a6010", background: "#e4f5d0", padding: "2px 10px", borderRadius: 10 }}>✓ з документа клієнта</div>
                ) : !hasSources ? (
                  <div style={{ fontSize: 12, color: "#e8ff47", background: "#2a2a1a", padding: "2px 10px", borderRadius: 10 }}>
                    {isSearching ? "шукаю…" : `потрібно: ${needed} дж.`}
                  </div>
                ) : secRefs.length >= needed ? (
                  <div style={{ fontSize: 12, color: "#3a6010", background: "#e4f5d0", padding: "2px 10px", borderRadius: 10 }}>✓ {secRefs.length}/{needed} дж. автоматично</div>
                ) : isSearching ? (
                  <div style={{ fontSize: 12, color: "#8a6010", background: "#fff5e0", padding: "2px 10px", borderRadius: 10 }}>додаю {secRefs.length}/{needed}…</div>
                ) : (
                  <>
                    <div style={{ fontSize: 12, color: "#8a5a00", background: "#fff5e0", padding: "2px 10px", borderRadius: 10 }}>⚠ підтверджено {secRefs.length} з {needed} — без зниження релевантності решту не знайдено, оберіть вручну нижче</div>
                    {doExpandYearsSection && (
                      <button
                        onClick={e => { e.stopPropagation(); doExpandYearsSection(sec); }}
                        title="Пошук ще ширшого діапазону років (додатково +8 років понад стандартний автоматичний каскад) — не знижує поріг релевантності, лише глибину пошуку"
                        style={{ fontSize: 10, background: "transparent", border: "1px solid #e8a050", color: "#c07020", borderRadius: 5, padding: "2px 8px", cursor: "pointer" }}
                      >ширший період</button>
                    )}
                  </>
                )}
              </div>
            </div>

            <div style={{ padding: "14px 18px", background: "#faf8f3" }}>

              {/* Ключові слова */}
              {Array.isArray(keywords[sec.id]) && keywords[sec.id].length > 0 && (
                <div style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 11, color: "#888", letterSpacing: "1px", textTransform: "uppercase", marginBottom: 5 }}>Шукайте за фразами:</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                    {keywords[sec.id].map((kw, ki) => (
                      <span
                        key={ki}
                        onClick={() => navigator.clipboard.writeText(kw)}
                        title="Клікни щоб скопіювати"
                        style={{ fontSize: 11, background: "#eef5e4", color: "#3a6010", padding: "2px 9px", borderRadius: 10, border: "1px solid #c8dfa0", cursor: "pointer", userSelect: "none" }}
                      >{kw}</span>
                    ))}
                  </div>
                </div>
              )}

              {/* ── Блок пропозицій ── */}
              {(isSearching || suggestions.length > 0 || searchErr) && (
                <div style={{ marginBottom: 12, border: "1.5px solid #c8dfa0", borderRadius: 8, overflow: "hidden" }}>

                  {/* Заголовок панелі */}
                  <div
                    onClick={() => setSuggOpen(prev => ({ ...prev, [sec.id]: !isOpen }))}
                    style={{ background: "#eef5e4", padding: "8px 14px", display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer", gap: 8, flexWrap: "wrap" }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      {isSearching
                        ? <><SpinDot size={12} /><span style={{ fontSize: 12, color: "#5a8a2a" }}>Шукаю джерела...</span></>
                        : <>
                          <span style={{ fontSize: 12, fontWeight: 600, color: "#3a6010" }}>Знайдені джерела ({suggestions.length})</span>
                          <span style={{ fontSize: 11, color: "#5a7a3a" }}>🇺🇦 {ukCount} укр.</span>
                          {plCount > 0 && <span style={{ fontSize: 11, color: "#9a3a6a" }}>🇵🇱 {plCount} польськ.</span>}
                          {enCount > 0 && <span style={{ fontSize: 11, color: "#3a6a9a" }}>🌐 {enCount} зарубіж.</span>}
                        </>
                      }
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      {!isSearching && (
                        <button
                          onClick={e => { e.stopPropagation(); doRegenSectionSources(sec); }}
                          style={{ fontSize: 10, background: "transparent", border: "1px solid #8cc84b", color: "#3a6010", borderRadius: 5, padding: "2px 8px", cursor: "pointer" }}
                        >оновити</button>
                      )}
                      <span style={{ fontSize: 11, color: "#5a7a3a" }}>{isOpen ? "▲" : "▼"}</span>
                    </div>
                  </div>

                  {/* Картки джерел */}
                  {isOpen && !isSearching && suggestions.length > 0 && (
                    <div style={{ padding: "10px 12px", background: "#f5faf0" }}>


                      {/* Картки — по фразах або плоский список */}
                      {(phraseGroups?.[sec.id] || []).length > 0
                        ? phraseGroups[sec.id].map((group, gi) => {
                            const groupPapers = group.papers.filter(p =>
                              !alreadyAdded.includes((p.title || '').toLowerCase().slice(0, 60))
                            );
                            if (!groupPapers.length) return null;
                            const pageKey = `${sec.id}_${gi}`;
                            const PAGE_SIZE = 5;
                            const currentPage = phrasePages[pageKey] || 1;
                            const totalPages = Math.ceil(groupPapers.length / PAGE_SIZE);
                            const visible = groupPapers.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
                            return (
                              <div key={gi} style={{ marginBottom: 14 }}>
                                <div style={{ fontSize: 10, color: '#5a7a3a', padding: '3px 8px', background: '#f0f7e8', borderRadius: 4, marginBottom: 6, fontStyle: 'italic', display: 'inline-block' }}>
                                  🔍 {group.phrase}
                                </div>
                                {visible.map(paper => (
                                  <SourceCard key={paper.id} paper={paper} checked={isChecked(sec.id, paper.id)} onToggle={() => togglePaper(sec.id, paper)} pagesRequired={inTextPagePolicy === "always"} />
                                ))}
                                {totalPages > 1 && (
                                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
                                    <button
                                      onClick={() => setPhrasePages(prev => ({ ...prev, [pageKey]: Math.max(1, currentPage - 1) }))}
                                      disabled={currentPage === 1}
                                      style={{ fontSize: 11, background: 'transparent', border: '1px solid #c8dfa0', color: currentPage === 1 ? '#bbb' : '#5a7a3a', borderRadius: 5, padding: '2px 8px', cursor: currentPage === 1 ? 'default' : 'pointer' }}
                                    >←</button>
                                    <span style={{ fontSize: 11, color: '#5a7a3a' }}>{currentPage} / {totalPages}</span>
                                    <button
                                      onClick={() => setPhrasePages(prev => ({ ...prev, [pageKey]: Math.min(totalPages, currentPage + 1) }))}
                                      disabled={currentPage === totalPages}
                                      style={{ fontSize: 11, background: 'transparent', border: '1px solid #c8dfa0', color: currentPage === totalPages ? '#bbb' : '#5a7a3a', borderRadius: 5, padding: '2px 8px', cursor: currentPage === totalPages ? 'default' : 'pointer' }}
                                    >→</button>
                                  </div>
                                )}
                              </div>
                            );
                          })
                        : suggestions.map(paper => (
                            <SourceCard key={paper.id} paper={paper} checked={isChecked(sec.id, paper.id)} onToggle={() => togglePaper(sec.id, paper)} pagesRequired={inTextPagePolicy === "always"} />
                          ))
                      }

                      {/* Кнопки дій */}
                      <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap", alignItems: "center" }}>
                        <button
                          onClick={() => handleAddSelected(sec.id)}
                          disabled={selectedCount === 0}
                          style={{
                            fontSize: 12, fontWeight: 600,
                            background: selectedCount > 0 ? "#5a9a1a" : "#ccc",
                            color: "#fff", border: "none", borderRadius: 6,
                            padding: "6px 14px", cursor: selectedCount > 0 ? "pointer" : "default",
                          }}
                        >
                          Додати вибрані ({selectedCount}) →
                        </button>
                        <button onClick={() => selectAll(sec.id)} style={{ fontSize: 11, background: "transparent", border: "1px solid #8cc84b", color: "#3a6010", borderRadius: 5, padding: "4px 10px", cursor: "pointer" }}>вибрати всі</button>
                        {selectedCount > 0 && (
                          <button onClick={() => clearAll(sec.id)} style={{ fontSize: 11, background: "transparent", border: "1px solid #ccc", color: "#888", borderRadius: 5, padding: "4px 10px", cursor: "pointer" }}>скинути</button>
                        )}
                      </div>
                    </div>
                  )}

                  {isOpen && !isSearching && suggestions.length === 0 && (
                    <div style={{ padding: "10px 14px", fontSize: 12, background: "#f5faf0", color: searchErr ? "#8a1a1a" : "#888" }}>
                      {searchErr
                        ? `⚠ Помилка пошуку: ${searchErr}. Спробуйте оновити або додайте джерела вручну.`
                        : "Джерел не знайдено. Спробуйте оновити або додайте вручну."}
                    </div>
                  )}
                </div>
              )}

              {/* Ручне введення */}
              {(() => {
                const hasUrlLines = secRefs.some(line =>
                  /https?:\/\//.test(line) && !/[СP]\.\s*\d/.test(line)
                );
                return (
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 5, gap: 8 }}>
                    <div style={{ fontSize: 11, color: "#888", letterSpacing: "1px", textTransform: "uppercase" }}>
                      {suggestions.length > 0 ? "Або додайте джерела вручну (кожне з нового рядка):" : "Вставте джерела (кожне з нового рядка):"}
                    </div>
                    <div style={{ display: "flex", gap: 6, flexShrink: 0, alignItems: "center" }}>
                      {hasUrlLines && (
                        <button
                          onClick={() => handleEnrichManual(sec.id)}
                          disabled={enrichLoading[sec.id]}
                          title="Підтягнути сторінки для джерел з URL"
                          style={{
                            fontSize: 11, background: enrichLoading[sec.id] ? "#f0f5e8" : "#eef5e4",
                            border: "1px solid #8cc84b", color: "#3a6010",
                            borderRadius: 5, padding: "2px 9px", cursor: enrichLoading[sec.id] ? "default" : "pointer",
                            flexShrink: 0,
                          }}
                        >
                          {enrichLoading[sec.id] ? '⏳ Шукаю…' : '📄 Підтягнути сторінки'}
                        </button>
                      )}
                      {enrichResult[sec.id] != null && !enrichLoading[sec.id] && (
                        <span style={{ fontSize: 11, color: enrichResult[sec.id] > 0 ? "#3a6010" : "#888" }}>
                          {enrichResult[sec.id] > 0 ? `✓ ${enrichResult[sec.id]} оновлено` : '— не знайдено'}
                        </span>
                      )}
                      {(citInputs[sec.id] || "").trim() && (
                        <button
                          onClick={() => handleEnrichFullInfo(sec.id)}
                          disabled={fullInfoLoading[sec.id]}
                          title="Знайти повнішу бібліографічну інформацію (рік, том/випуск, видавництво, сторінки) для джерел цього підрозділу"
                          style={{
                            fontSize: 11, background: fullInfoLoading[sec.id] ? "#f0f5fa" : "#eaf1fb",
                            border: "1px solid #6fa8dc", color: "#1a4a7a",
                            borderRadius: 5, padding: "2px 9px", cursor: fullInfoLoading[sec.id] ? "default" : "pointer",
                            flexShrink: 0,
                          }}
                        >
                          {fullInfoLoading[sec.id] ? '⏳ Шукаю…' : '🔎 Знайти повну інформацію'}
                        </button>
                      )}
                      {fullInfoResult[sec.id] != null && !fullInfoLoading[sec.id] && (
                        <span style={{ fontSize: 11, color: fullInfoResult[sec.id] > 0 ? "#1a4a7a" : "#888" }}>
                          {fullInfoResult[sec.id] > 0 ? `✓ ${fullInfoResult[sec.id]} оновлено` : '— не знайдено'}
                        </span>
                      )}
                      {(citInputs[sec.id] || "").trim() && (
                        <button
                          onClick={() => {
                            setCitInputs(p => ({ ...p, [sec.id]: "" }));
                            if (setCitStructured) setCitStructured(p => ({ ...p, [sec.id]: [] }));
                            setEnrichResult(p => ({ ...p, [sec.id]: null }));
                            requestAnimationFrame(() => {
                              const ta = document.querySelector(`textarea[data-secid="${sec.id}"]`);
                              if (ta) { ta.style.height = "auto"; }
                            });
                          }}
                          style={{ fontSize: 11, background: "transparent", border: "1px solid #e0b0b0", color: "#a04040", borderRadius: 5, padding: "2px 8px", cursor: "pointer", flexShrink: 0 }}
                        >× Очистити</button>
                      )}
                    </div>
                  </div>
                );
              })()}
              <textarea
                data-secid={sec.id}
                value={citInputs[sec.id] || ""}
                onChange={e => {
                  setCitInputs(p => ({ ...p, [sec.id]: e.target.value }));
                  e.target.style.height = "auto";
                  e.target.style.height = e.target.scrollHeight + "px";
                }}
                onFocus={e => {
                  e.target.style.height = "auto";
                  e.target.style.height = e.target.scrollHeight + "px";
                }}
                onPaste={e => {
                  e.preventDefault();
                  const pasted = e.clipboardData.getData("text");
                  const el = e.target;
                  const start = el.selectionStart;
                  const end = el.selectionEnd;
                  const prev = citInputs[sec.id] || "";
                  const next = prev.slice(0, start) + pasted + "\n" + prev.slice(end);
                  setCitInputs(p => ({ ...p, [sec.id]: next }));
                  requestAnimationFrame(() => {
                    el.style.height = "auto";
                    el.style.height = el.scrollHeight + "px";
                    const pos = start + pasted.length + 1;
                    el.setSelectionRange(pos, pos);
                  });
                }}
                placeholder={"Петренко В.І. Психологія навчання. Київ: Наука, 2020. 245 с.\nSmirnova O. Child development. Oxford: OUP, 2019."}
                style={{ ...TA_WHITE, minHeight: 80, overflow: "hidden", resize: "none" }}
              />
              {secRefs.length > 0 && (
                <div style={{ fontSize: 11, color: "#5a8a2a", marginTop: 4 }}>
                  ✓ {secRefs.length} джерело(а) введено → [{startIdx}–{startIdx + secRefs.length - 1}]
                </div>
              )}
            </div>
          </div>
        );
      })}

      {/* ── Лічильник джерел ── */}
      <div style={{ padding: "12px 18px", background: "#f0f5e8", border: "1.5px solid #c8dfa0", borderRadius: 8, marginBottom: 16, fontSize: 13, color: "#3a6010" }}>
        Всього введено: <strong>{allRefs.length}</strong> з {sourceTotal} рекомендованих.
      </div>

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 8 }}>
        <NavBtn onClick={() => setStage("plan")}>← До плану</NavBtn>
        {onSave && (
          <button
            onClick={onSave}
            disabled={saving}
            style={{ background: "transparent", border: "1.5px solid #8cc84b", color: saving ? "#aaa" : "#3a6010", borderRadius: 6, padding: "8px 18px", fontFamily: "'Spectral',serif", fontSize: 13, cursor: saving ? "default" : "pointer" }}>
            {saving ? "Зберігаю..." : "💾 Зберегти"}
          </button>
        )}
        <>
          <button
            onClick={onRegenWithNewSources}
            style={{ background: "#1a1a14", color: "#e8ff47", border: "1.5px solid #e8ff47", borderRadius: 6, padding: "8px 20px", fontFamily: "'Spectral',serif", fontSize: 13, cursor: "pointer" }}>
            → Почати генерацію тексту
          </button>
          {hasGeneratedContent && (
            <PrimaryBtn onClick={onFinish} loading={remapLoading} msg="Формую список літератури..." label="До готового тексту →" />
          )}
          {remapLoading && (
            <button onClick={stopRemap} style={{ background: "#7a1010", color: "#fff", border: "none", borderRadius: 6, padding: "8px 20px", fontFamily: "'Spectral',serif", fontSize: 13, cursor: "pointer" }}>⏹ Зупинити</button>
          )}
        </>
      </div>
    </div>
  );
}
