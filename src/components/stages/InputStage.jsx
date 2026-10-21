import { useRef, useMemo } from "react";
import { TA } from "../../shared.jsx";
import { FieldBox, Heading, PrimaryBtn } from "../Buttons.jsx";
import { DropZone } from "../DropZone.jsx";
import { PhotoDropZone } from "../PhotoDropZone.jsx";
import { IllustrationsZone } from "../IllustrationsZone.jsx";
import { DrawingsZone } from "../DrawingsZone.jsx";
import { ClientPlanInput } from "../ClientPlanInput.jsx";
import { parseTemplate } from "../../lib/planUtils.js";
import { ClientMaterialsZone } from "../ClientMaterialsZone.jsx";

const S = (color) => ({ borderLeft: `3px solid ${color}`, paddingLeft: 12 });
const COLORS = {
  plan: "#5588d0",
  comment: "#5ca83c",
  anketa: "#e06868",
  photos: "#c050a0",
  illustrations: "#e08030",
  drawings: "#8060c0",
  materials: "#4090c0",
  readyWork: "#3a9a6a",
  example: "#a07830",
};

export function InputStage({
  tplText, setTplText, clientPlan, setClientPlan, comment, setComment,
  appendicesText, setAppendicesText,
  fileLabel, fileB64, methodInfo, photos, setPhotos,
  exampleWorkFileName, exampleWorkFileB64, handleExampleWorkFile,
  illustrations, setIllustrations,
  illustrationsPdf, setIllustrationsPdf,
  clientDrawings, setClientDrawings,
  clientMaterials, onAddClientMaterial, onRemoveClientMaterial,
  clientMaterialsText, setClientMaterialsText,
  readyWorkFileName, onReadyWorkFile, onRemoveReadyWork,
  info, running, loadMsg,
  handleFile, doAnalyze, setStage,
  isAdmin, autoRunning, onRunAuto,
}) {
  const readyWorkFileRef = useRef();
  const planTopic = useMemo(() => info?.topic || parseTemplate(tplText || "").topic, [info?.topic, tplText]);
  return (
    <div className="fade">
      <Heading>01 / Введіть дані замовлення</Heading>
      <FieldBox label="Шаблон замовлення *" tooltip={"Головне поле — аналізується автоматично.\nВитягується: тип роботи, тема, предмет, напрям, обсяг сторінок, дедлайн, унікальність, номер замовлення.\nУся подальша генерація базується на цих даних."}>
        <textarea value={tplText} onChange={e => setTplText(e.target.value)}
          placeholder={"№ замовлення - 34455\nТип - Магістерська\n⏰Дедлайн - 06.03.2026\n⚡️Напрям - Гуманітарне\n📌Тематика - Психологія\n✈️Тема - Вплив гаджетів на когнітивну поведінку дітей\n⚙️К-кість стр. - 100-120\n⚙️Унікальність - 70-80%"}
          style={{ ...TA, minHeight: 200 }} />
      </FieldBox>

      <div style={S(COLORS.plan)}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 20 }}>
          <FieldBox label="Готовий план від клієнта (необов'язково)" labelColor={COLORS.plan} tooltip={"Назви розділів використовуються точно як є, без змін.\nЯкщо порожньо — план генерується автоматично на основі теми та типу роботи."}>
            <textarea value={clientPlan} onChange={e => setClientPlan(e.target.value)}
              placeholder="Вставте план клієнта якщо є. Порожньо = план згенерується автоматично."
              style={{ ...TA, minHeight: 90 }} />
          </FieldBox>
          <FieldBox label="Або файл плану" labelColor={COLORS.plan} tooltip={"Альтернатива текстовому плану — завантажте фото/скрін, PDF або .docx з планом.\nAI розпізнає структуру і використає назви розділів точно як у клієнта."}>
            <ClientPlanInput onExtracted={setClientPlan} extracted={clientPlan} topic={planTopic} />
          </FieldBox>
        </div>
      </div>

      <div style={S(COLORS.comment)}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 20 }}>
          <FieldBox label="Коментар" labelColor={COLORS.comment} tooltip={"Аналізується AI і передається у генерацію як:\n— підказки до плану (назви розділів)\n— вимоги до тексту (структура, стиль)\n— тип практичного дослідження (анкета, експеримент тощо)\nЧим детальніший коментар — тим точніший результат."}>
            <textarea value={comment} onChange={e => setComment(e.target.value)}
              placeholder="Додаткові побажання..." style={{ ...TA, minHeight: 90 }} />
          </FieldBox>
          <FieldBox label="Методичка (PDF або DOCX)" labelColor={COLORS.comment} tooltip={"Аналізується і витягується: вимоги до оформлення, кількість і типи джерел, структура розділів, особливі вимоги викладача.\nВикористовується при генерації плану та кожного розділу."}>
            <DropZone fileLabel={fileLabel} onFile={handleFile} accept=".pdf,.docx" />
            {methodInfo && !fileB64 && (
              <div style={{ fontSize: 11, color: "#7a8a5a", marginTop: 5 }}>
                ✓ Методичку вже проаналізовано. Завантажте файл знову лише якщо потрібно перепроаналізувати.
              </div>
            )}
          </FieldBox>
        </div>
      </div>

      {handleExampleWorkFile && (
        <div style={S(COLORS.example)}>
          <FieldBox label="Приклад роботи — зразок (PDF або DOCX, необов'язково)" labelColor={COLORS.example} tooltip={"Завантажте ЧУЖУ готову роботу як зразок оформлення. Скопіюються структура (к-сть розділів/підрозділів), титулка, оформлення таблиць/рисунків, стиль списку джерел. Зміст буде повністю новий, під вашу тему — текст зразка НЕ копіюється.\nЯкщо є й методичка з вимогами вище — вона має пріоритет, приклад лише доповнює те, чого в методичці нема.\nНе плутайте з полем 'Готова частина роботи від клієнта' нижче — те поле вставляє СПРАВЖНІЙ текст клієнта як є."}>
            <DropZone fileLabel={exampleWorkFileName} onFile={handleExampleWorkFile} accept=".pdf,.docx" />
            {exampleWorkFileName && !exampleWorkFileB64 && (
              <div style={{ fontSize: 11, color: "#7a8a5a", marginTop: 5 }}>
                ✓ Приклад роботи вже проаналізовано. Завантажте файл знову лише якщо потрібно перепроаналізувати.
              </div>
            )}
          </FieldBox>
        </div>
      )}

      <div style={S(COLORS.materials)}>
        <FieldBox label="Матеріали клієнта — PDF, DOCX, TXT або текст (необов'язково, до 10 файлів)" labelColor={COLORS.materials} tooltip={"PDF, DOCX або TXT файли аналізуються і резюмуються.\nРезультат використовується при написанні тексту як додатковий контекст.\nПідходить для: статей, розділів підручника, власних матеріалів клієнта."}>
          <ClientMaterialsZone
            materials={clientMaterials}
            onAdd={onAddClientMaterial}
            onRemove={onRemoveClientMaterial}
            manualText={clientMaterialsText}
            onManualText={setClientMaterialsText}
            onReadyWorkFile={onReadyWorkFile}
            clientPlan={clientPlan}
          />
        </FieldBox>
      </div>

      {onReadyWorkFile && (
        <div style={S(COLORS.readyWork)}>
          <FieldBox label="Готова частина роботи від клієнта (.docx, необов'язково)" labelColor={COLORS.readyWork} tooltip={"Якщо клієнт вже написав частину роботи (наприклад, розділ 1) і має свої джерела — завантажте файл тут.\nПісля формування плану текст автоматично розподілиться по відповідних підрозділах — вони не будуть перезаписані генерацією.\nДжерела клієнта теж витягуються автоматично і пізніше об'єднуються з підібраними в один список із правильною наскрізною нумерацією."}>
            <div
              onClick={() => readyWorkFileRef.current.click()}
              style={{
                display: "flex", alignItems: "center", gap: 10, cursor: "pointer",
                border: `1.5px dashed ${readyWorkFileName ? "#3a9a6a" : "#c4bfb4"}`,
                borderRadius: 6, padding: "10px 14px",
                background: readyWorkFileName ? "#eef8f2" : "#f0ece2",
              }}
            >
              <span style={{ fontSize: 18 }}>{readyWorkFileName ? "✅" : "📎"}</span>
              <span style={{ fontSize: 13, color: readyWorkFileName ? "#2a6a4a" : "#888", flex: 1 }}>
                {readyWorkFileName || "Клікніть, щоб обрати .docx файл із готовою частиною роботи"}
              </span>
              {readyWorkFileName && (
                <button
                  onClick={e => { e.stopPropagation(); onRemoveReadyWork(); }}
                  style={{ background: "none", border: "none", cursor: "pointer", color: "#8a1a1a", fontSize: 14, lineHeight: 1, padding: 0 }}
                >✕</button>
              )}
            </div>
            <input
              ref={readyWorkFileRef}
              type="file"
              accept=".docx"
              style={{ display: "none" }}
              onChange={e => {
                const f = e.target.files[0];
                if (!f) return;
                f.arrayBuffer().then(buf => onReadyWorkFile(buf, f.name));
                e.target.value = "";
              }}
            />
          </FieldBox>
        </div>
      )}

      <div style={S(COLORS.anketa)}>
        <FieldBox label="Готова анкета / додаток (необов'язково)" labelColor={COLORS.anketa} tooltip={"Якщо заповнено — вставляється як Додаток А.\nВесь практичний розділ (методологія, таблиці, аналіз) будується точно по цій анкеті.\nЯкщо порожньо — анкета генерується автоматично перед початком написання."}>
          <textarea value={appendicesText} onChange={e => setAppendicesText(e.target.value)}
            placeholder="Вставте готову анкету або інший додаток якщо є. Порожньо = анкета згенерується автоматично перед написанням тексту."
            style={{ ...TA, minHeight: 90 }} />
        </FieldBox>
      </div>

      <div style={S(COLORS.drawings)}>
        <FieldBox label="Креслення клієнта (необов'язково)" labelColor={COLORS.drawings} tooltip={"Реальні креслення клієнта — підуть у Додатки в кінці роботи як є, в текст НЕ вставляються.\nШІ використає їх лише для того, щоб писати текст із реальними розмірами/вузлами/специфікацією, а не вигаданими."}>
          <DrawingsZone
            drawings={clientDrawings}
            onAdd={d => setClientDrawings(prev => [...prev, d])}
            onRemove={i => setClientDrawings(prev => prev.filter((_, idx) => idx !== i))}
          />
        </FieldBox>
      </div>

      <div style={S(COLORS.photos)}>
        <FieldBox label="Фото як додатковий матеріал (необов'язково)" labelColor={COLORS.photos} tooltip={"Фото надсилаються напряму до AI як зображення (Claude бачить їх).\nПідходить для: фото завдання, скрін методички, фото з підручника.\nАналізуються разом з коментарем — витягуються підказки для виконавця."}>
          <PhotoDropZone
            photos={photos}
            onAdd={p => setPhotos(prev => [...prev, p])}
            onRemove={i => setPhotos(prev => prev.filter((_, idx) => idx !== i))}
          />
        </FieldBox>
      </div>

      <div style={S(COLORS.illustrations)}>
        <FieldBox label="Ілюстрації до роботи (необов'язково) — ШІ опише їх та вставить у потрібні розділи" labelColor={COLORS.illustrations} tooltip={"Зображення або PDF — AI знайде всі рисунки, опише кожен і вставить посилання у відповідний розділ роботи."}>
          <IllustrationsZone
            illustrations={illustrations}
            onAdd={ill => setIllustrations(prev => [...prev, ill])}
            onUpdate={(i, ill) => setIllustrations(prev => prev.map((x, idx) => idx === i ? ill : x))}
            onRemove={i => setIllustrations(prev => prev.filter((_, idx) => idx !== i))}
          />
          <div style={{ margin: "10px 0 6px", fontSize: 11, color: "#bbb", textAlign: "center" }}>— або PDF із усіма ілюстраціями —</div>
          {illustrationsPdf ? (
            <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "#555", background: "#f5f2ea", borderRadius: 6, padding: "6px 10px" }}>
              <span>📄 {illustrationsPdf.name}</span>
              <button
                onClick={() => setIllustrationsPdf(null)}
                style={{ background: "none", border: "none", cursor: "pointer", color: "#8a1a1a", fontSize: 14, lineHeight: 1, padding: 0 }}
              >✕</button>
            </div>
          ) : (
            <DropZone fileLabel={null} onFile={(name, b64) => setIllustrationsPdf({ name, b64 })} accept=".pdf" />
          )}
        </FieldBox>
      </div>

      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <PrimaryBtn onClick={doAnalyze} disabled={!tplText.trim() || autoRunning} loading={running} msg={loadMsg} label="Аналізувати →" />
        {info && !running && !autoRunning && (
          <button onClick={() => setStage("parsed")}
            style={{ background: "transparent", border: "1.5px solid #555", color: "#555", borderRadius: 8, padding: "11px 22px", fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>
            Продовжити без повторного аналізу →
          </button>
        )}
        {isAdmin && (
          <button onClick={onRunAuto} disabled={!tplText.trim() || running || autoRunning}
            title="Тестовий режим: весь конвеєр (аналіз → план → джерела → написання) запускається без ручних кроків. Вкладку не закривайте до завершення."
            style={{
              background: "transparent", border: "1.5px solid #7a9e50", color: "#5ca83c", borderRadius: 8,
              padding: "11px 22px", fontSize: 13, cursor: (!tplText.trim() || running || autoRunning) ? "default" : "pointer",
              fontFamily: "inherit", opacity: (!tplText.trim() || running || autoRunning) ? 0.5 : 1,
            }}>
            ⚡ Автоматичний режим (тест) →
          </button>
        )}
      </div>
    </div>
  );
}
