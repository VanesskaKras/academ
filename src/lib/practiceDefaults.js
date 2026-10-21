// Довідник по практиці: напрям (той самий список, що й SPECIALTY_MAP в academicDefaults.js)
// × вид практики (навчальна/виробнича/переддипломна) → мета, зміст звіту, завдання щоденника,
// додатки, особливість.
//
// PRACTICE_TABLE поки порожня — контент чекає на чистий (непошкоджений) текст довідника від
// користувача. getPracticeGuidance() безпечно повертає null, доки конкретний напрям не заповнено,
// і виклики в prompts.js це враховують.

export const PRACTICE_TYPES = [
  { key: "navchalna",         label: "Навчальна" },
  { key: "vyrobnycha",        label: "Виробнича" },
  { key: "perededyplomna",    label: "Переддипломна" },
  { key: "naukovo_doslidna",  label: "Науково-дослідна" },
];

// Людські назви напрямів для UI (той самий перелік ключів, що й SPECIALTY_MAP)
export const CATEGORY_LABELS = {
  psychology:       { label: "Психологія",                              icon: "🧠" },
  sociology:        { label: "Соціологія",                              icon: "👥" },
  social_work:      { label: "Соціальна робота",                        icon: "🤝" },
  philology:        { label: "Філологія / Мовознавство",                icon: "📖" },
  translation:      { label: "Переклад",                                icon: "🌐" },
  history:          { label: "Історія",                                 icon: "🏛️" },
  philosophy:       { label: "Філософія",                               icon: "💭" },
  political_sci:    { label: "Політологія",                             icon: "🗳️" },
  intl_relations:   { label: "Міжнародні відносини",                    icon: "🌍" },
  journalism:       { label: "Журналістика / Медіа",                    icon: "📰" },
  cultural_studies: { label: "Культурологія / Релігієзнавство",         icon: "⛩️" },
  preschool:        { label: "Дошкільна освіта",                        icon: "🧸" },
  special_edu:      { label: "Спеціальна освіта / Логопедія",           icon: "🗣️" },
  pedagogy:         { label: "Педагогіка / Початкова освіта",           icon: "📚" },
  sport:            { label: "Фізична культура і спорт",                icon: "🏃" },
  law:              { label: "Право / Юриспруденція",                   icon: "⚖️" },
  public_admin:     { label: "Публічне управління / Держслужба",        icon: "🏢" },
  management:       { label: "Менеджмент",                              icon: "📈" },
  finance:          { label: "Фінанси / Облік",                         icon: "💰" },
  marketing:        { label: "Маркетинг / Реклама / PR",                icon: "📣" },
  economics:        { label: "Економіка",                               icon: "📊" },
  tourism:          { label: "Туризм / Готельно-ресторанна справа",     icon: "🧳" },
  cybersecurity:    { label: "Кібербезпека",                            icon: "🔒" },
  it:               { label: "ІТ / Комп'ютерні науки",                  icon: "💻" },
  engineering:      { label: "Інженерія",                               icon: "⚙️" },
  construction:     { label: "Будівництво / Архітектура",                icon: "🏗️" },
  natural_sci:      { label: "Природничі науки",                        icon: "🔬" },
  medicine:         { label: "Медицина / Фармація",                     icon: "⚕️" },
  agriculture:      { label: "Аграрні науки / Ветеринарія",              icon: "🌾" },
  design:           { label: "Дизайн",                                   icon: "🎨" },
  art:              { label: "Мистецтво / Музика / Театр",               icon: "🎭" },
  english_teaching: { label: "Англійська мова (методика викладання)",    icon: "🇬🇧" },
  inclusive_edu:    { label: "Інклюзивна освіта",                        icon: "♿" },
  logic_ethics:     { label: "Логіка / Етика",                          icon: "🧩" },
  local_history:    { label: "Краєзнавство",                            icon: "🏞️" },
  archaeology:      { label: "Археологія",                              icon: "⛏️" },
  anthropology:     { label: "Антропологія / Етнологія",                icon: "🧑‍🤝‍🧑" },
  document_science: { label: "Документознавство / Бібліотекознавство",  icon: "📑" },
  military:         { label: "Військова справа",                       icon: "🎖️" },
  business:         { label: "Бізнес / Підприємництво",                 icon: "💼" },
  logistics:        { label: "Логістика",                              icon: "📦" },
  trade:            { label: "Торгівля / Торгова справа",               icon: "🛒" },
  customs:          { label: "Митна справа",                           icon: "🛃" },
  banking:          { label: "Банківська справа",                      icon: "🏦" },
  intl_economics:   { label: "Міжнародна економіка / ЗЕД",              icon: "🌐" },
  intl_law:         { label: "Міжнародне право",                       icon: "⚖️" },
  transport_tech:   { label: "Транспортні технології",                 icon: "🚚" },
  food_tech:        { label: "Харчові технології",                     icon: "🍞" },
  automation_robotics: { label: "Автоматизація / Робототехніка",        icon: "🤖" },
  math:             { label: "Математика / Теорія ймовірності",         icon: "📐" },
  statistics:       { label: "Статистика",                             icon: "📉" },
  physics:          { label: "Фізика",                                 icon: "⚛️" },
  astronomy:        { label: "Астрономія",                             icon: "🔭" },
  geography:        { label: "Географія",                              icon: "🗺️" },
  geology:          { label: "Геологія",                               icon: "🪨" },
  botany_zoology:   { label: "Ботаніка / Зоологія",                    icon: "🌿" },
  microbiology:     { label: "Мікробіологія / Біотехнологія",          icon: "🦠" },
  anatomy:          { label: "Анатомія / Гістологія",                  icon: "🫀" },
  dentistry:        { label: "Стоматологія",                          icon: "🦷" },
  physical_therapy: { label: "Фізична терапія та реабілітація",        icon: "🏥" },
};

export const OTHER_CATEGORY = "other";
CATEGORY_LABELS[OTHER_CATEGORY] = { label: "Інший напрям", icon: "📋" };

// TODO: заповнити реальним змістом (мета/reportContent/diaryTasks/appendices/feature)
// після отримання непошкодженого тексту довідника. Структура запису:
// { purpose, reportContent, diaryTasks, appendices, feature }
export const PRACTICE_TABLE = {};

export function getPracticeGuidance(cat, type) {
  return PRACTICE_TABLE?.[cat]?.[type] || null;
}

// Визначає вид практики з номера курсу та/або будь-якої кількості текстових джерел
// (тип роботи, тема, тематика/предмет тощо — вид практики нерідко згаданий лише в темі,
// а не в полі "Тип"). Регулярка — фолбек, якщо окреме LLM-поле practiceType не визначилось.
export function detectPracticeType(course, degreeLevel, ...texts) {
  const t = texts.filter(Boolean).join(" ").toLowerCase();
  // Перевіряємо ПЕРЕД "переддипломн" — методички/оголошення нерідко згадують обидва слова поруч
  // (напр. "переддипломна науково-дослідна практика"), а "науково-дослідна" тут точніша ознака
  // виду практики, ніж "переддипломна", яка радше вказує на етап навчання.
  if (/науков[а-яії]*[-\s]?дослідн/.test(t)) return "naukovo_doslidna";
  if (/передипломн|переддипломн/.test(t)) return "perededyplomna";
  if (/навчальн|ознайомч/.test(t)) return "navchalna";
  if (/виробнич/.test(t)) return "vyrobnycha";
  const c = parseInt(course, 10);
  if (!c) return null;
  // Магістратура 2 курс (окремо або наскрізним курсом 6) — типово переддипломна
  // науково-дослідна практика, якщо вид ніде більше не вказано.
  const isMaster = /магістр/i.test(degreeLevel || "") || /магістратур/i.test(t);
  if (c === 6 || (isMaster && c === 2)) return "naukovo_doslidna";
  if (c <= 2) return "navchalna";
  if (c === 4) return "perededyplomna";
  return "vyrobnycha";
}

// Regex-фолбек для деталей практики (місце, керівники, дати, індивідуальне завдання) —
// орієнтується на формат підказки текстового поля "Дані практики" в PracticePage.jsx.
export function parsePracticeDetails(text) {
  const t = text || "";
  const g = (re, fb = "") => { const m = t.match(re); return m ? m[1].trim() : fb; };

  const period = g(/Строки\s*[-–:]\s*(.+?)(?=\n|$)/i);
  const dateRangeRe = /(\d{1,2}[./]\d{1,2}[./]\d{2,4})\s*[-–—]\s*(\d{1,2}[./]\d{1,2}[./]\d{2,4})/;
  const dates = period.match(dateRangeRe) || t.match(dateRangeRe);

  // Число/діапазон може стояти і до, і після слова "джерел" ("не менше 20-25 джерел" або "джерел: 20-25")
  const sourceCountMatch =
    t.match(/(\d+)\s*[-–]\s*(\d+)\s*джерел/i) ||
    t.match(/джерел[а-яіїєґ]*\s*[:\-–]?\s*(?:не менше\s*)?(\d+)\s*[-–]\s*(\d+)/i) ||
    t.match(/(\d+)\s*джерел/i) ||
    t.match(/джерел[а-яіїєґ]*\s*[:\-–]?\s*(?:не менше\s*)?(\d+)/i);

  return {
    companyName: g(/Місце практики\s*[-–:]\s*(.+?)(?=\n|$)/i),
    supervisorCompany: g(/Керівник від підприємства\s*[-–:]\s*(.+?)(?=\n|$)/i),
    supervisorUniversity: g(/Керівник від університету\s*[-–:]\s*(.+?)(?=\n|$)/i),
    individualTask: g(/Індивідуальне завдання\s*[-–:]\s*(.+?)(?=\n|$)/i),
    dateStart: dates ? dates[1] : "",
    dateEnd: dates ? dates[2] : "",
    sourceCount: sourceCountMatch ? (sourceCountMatch[2] ? `${sourceCountMatch[1]}-${sourceCountMatch[2]}` : sourceCountMatch[1]) : "",
    studentName: g(/Студент\s*[-–:]\s*([^,\n]+)/i),
    studentGroup: g(/груп[аи]\s*[-–:]?\s*([А-ЯІЇЄҐA-Z0-9-]+)/i),
    university: g(/(?:університет|заклад вищої освіти)\s*[-–:]\s*(.+?)(?=\n|$)/i),
    faculty: g(/факультет\s*[-–:]?\s*(.+?)(?=\n|$)/i),
    city: g(/м\.\s*([А-ЯІЇЄҐ][а-яіїєґ'’-]+)/i),
  };
}

// Будує рядки титульної сторінки звіту з практики (формат для exportToDocx({titlePageLines})).
// Використовується, лише якщо в методичці НЕ знайдено власного зразка титулки (methodInfo.titlePageTemplate).
export const PRACTICE_TYPE_GENITIVE = {
  navchalna: "навчальної",
  vyrobnycha: "виробничої",
  perededyplomna: "переддипломної",
  naukovo_doslidna: "науково-дослідної",
};

export function buildPracticeTitlePageLines(info) {
  const {
    university, faculty, companyName, supervisorCompany, supervisorUniversity,
    studentName, studentGroup, course, practiceType, city,
  } = info || {};
  const typeLabel = PRACTICE_TYPE_GENITIVE[practiceType] || "";

  const lines = [];
  lines.push({ text: "МІНІСТЕРСТВО ОСВІТИ І НАУКИ УКРАЇНИ", align: "center", bold: true, spaceBefore: 0 });
  lines.push({ text: university ? university.toUpperCase() : "[Назва університету]", align: "center", bold: true, spaceBefore: 200 });
  if (faculty) lines.push({ text: faculty, align: "center", bold: false, spaceBefore: 0 });
  lines.push({ text: "", align: "center", spaceBefore: 960 });
  lines.push({ text: "ЗВІТ", align: "center", bold: true, spaceBefore: 0 });
  lines.push({ text: `про проходження ${typeLabel ? typeLabel + " " : ""}практики`, align: "center", bold: false, spaceBefore: 0 });
  lines.push({ text: `на базі: ${companyName || "[Місце практики]"}`, align: "center", bold: false, spaceBefore: 200 });
  lines.push({ text: "", align: "center", spaceBefore: 2880 });

  const studentBits = [studentName || "[ПІБ студента]"];
  const groupBits = [course ? `${course} курс` : "", studentGroup ? `група ${studentGroup}` : ""].filter(Boolean).join(", ");
  if (groupBits) studentBits.push(groupBits);
  lines.push({ text: `Виконав(ла): ${studentBits.join(", ")}`, align: "right", bold: false, spaceBefore: 0 });
  lines.push({ text: `Керівник від підприємства: ${supervisorCompany || "[ПІБ, посада]"}`, align: "right", bold: false, spaceBefore: 0 });
  lines.push({ text: `Керівник від університету: ${supervisorUniversity || "[ПІБ, посада]"}`, align: "right", bold: false, spaceBefore: 0 });
  lines.push({ text: "", align: "center", spaceBefore: 3840 });
  lines.push({ text: `${city || "[Місто]"} – [РІК]`, align: "center", bold: false, spaceBefore: 0 });
  return lines;
}

// Будує рядки сторінки "ЗАВДАННЯ ТА РЕЗУЛЬТАТИ ПРОХОДЖЕННЯ ПРАКТИКИ" (формат для
// exportToDocx через methodInfo.taskSheetTemplate). Використовується як фолбек, коли
// зразок бланка завдання, знайдений buildMethodologyReadingPrompt у методичці, НЕ підходить
// для звіту з практики — той пошук орієнтований на "ЗАВДАННЯ на курсову/кваліфікаційну/
// дипломну роботу" (спільне поле для всіх видів робіт) і часто хапає бланк завдання саме
// на кваліфікаційну роботу за темою практики, а не бланк завдання на саму практику — це
// РІЗНІ документи з різними полями (терміни практики й керівник від підприємства тут,
// консультанти й наказ університету — там).
export function buildPracticeTaskSheetLines(info) {
  const {
    university, faculty, department, studentName, studentGroup, course,
    companyName, supervisorCompany, supervisorUniversity, practiceType,
    dateStart, dateEnd, topic, individualTask,
  } = info || {};
  const typeLabel = PRACTICE_TYPE_GENITIVE[practiceType] || "";

  const lines = [];
  lines.push({ text: "МІНІСТЕРСТВО ОСВІТИ І НАУКИ УКРАЇНИ", align: "center", bold: true, spaceBefore: 0 });
  lines.push({ text: university ? university.toUpperCase() : "[Назва університету]", align: "center", bold: true, spaceBefore: 200 });
  if (faculty) lines.push({ text: faculty, align: "center", bold: false, spaceBefore: 0 });
  if (department) lines.push({ text: `Кафедра ${department}`, align: "center", bold: false, spaceBefore: 0 });
  lines.push({ text: "", align: "center", spaceBefore: 480 });
  lines.push({ text: "ЗАВДАННЯ ТА РЕЗУЛЬТАТИ ПРОХОДЖЕННЯ ПРАКТИКИ", align: "center", bold: true, spaceBefore: 0 });
  lines.push({ text: "", align: "center", spaceBefore: 240 });

  lines.push({ text: `Студент(ка): ${studentName || "______"}${studentGroup ? `, група ${studentGroup}` : ""}${course ? `, ${course} курс` : ""}`, align: "left", bold: false, spaceBefore: 0 });
  lines.push({ text: `Скерований(а) на ${typeLabel ? typeLabel + " " : ""}практику на базі: ${companyName || "______"}`, align: "left", bold: false, spaceBefore: 0 });
  lines.push({ text: `Термін практики: ${dateStart && dateEnd ? `з ${dateStart} до ${dateEnd}` : "з ______ до ______"}`, align: "left", bold: false, spaceBefore: 0 });
  lines.push({ text: `Тема: ${topic || individualTask || "______"}`, align: "left", bold: false, spaceBefore: 0 });
  lines.push({ text: "", align: "center", spaceBefore: 240 });
  lines.push({ text: `Керівник практики від підприємства: ${supervisorCompany || "______"}`, align: "left", bold: false, spaceBefore: 0 });
  lines.push({ text: `Керівник практики від університету: ${supervisorUniversity || "______"}`, align: "left", bold: false, spaceBefore: 0 });
  lines.push({ text: "", align: "center", spaceBefore: 480 });
  lines.push({ text: "Зміст завдання: характеристика бази практики; економіка виробничо-господарської діяльності; управління виробничо-господарською діяльністю; адміністративна діяльність бази практики; висновки і пропозиції.", align: "left", bold: false, spaceBefore: 0 });
  lines.push({ text: "", align: "center", spaceBefore: 480 });
  lines.push({ text: "Завдання видав: ______________________________", align: "left", bold: false, spaceBefore: 0 });
  lines.push({ text: "Завдання отримав: ______________________________", align: "left", bold: false, spaceBefore: 0 });

  return lines;
}

// Будує рядок(и) "КАЛЕНДАРНИЙ ПЛАН" виконання ЗВІТУ З ПРАКТИКИ (формат для exportToDocx через
// methodInfo.calendarPlanTable) — фолбек з тієї ж причини, що й buildPracticeTaskSheetLines
// вище: спільне поле calendarPlanTable шукає в методичці календарний план КВАЛІФІКАЦІЙНОЇ
// РОБОТИ (етапи типу "виконання теоретичної частини", "оформлення пояснювальної записки"),
// а не етапи самої практики — якщо знайдений зразок не згадує практику явно, він не підходить.
export function buildPracticeCalendarPlanTable(info, sections) {
  const { dateStart, dateEnd } = info || {};
  const stages = practiceStageNames(sections) || [
    "Ознайомлення з базою практики, інструктаж, опрацювання документації",
    "Збір і опрацювання даних для аналітичної частини звіту",
    "Дослідження системи управління та адміністрування бази практики",
    "Формування висновків, оформлення звіту та супровідних документів",
  ];
  const rows = stages.map((s, i) => {
    const term = (i === 0 && dateStart) ? `з ${dateStart}` : (i === stages.length - 1 && dateEnd) ? `до ${dateEnd}` : "______";
    return `| ${i + 1} | ${s} | ${term} | Виконано |`;
  });
  return [
    "| № з/п | Етапи проходження практики | Термін виконання | Примітки |",
    "|---|---|---|---|",
    ...rows,
  ].join("\n");
}

// ── Заповнення календарного плану практики ──────────────────────────────────────────────
// Зразок із методички часто містить лише шапку й рядок нумерації колонок ("1 | 2 | 3 | 4") без
// жодного етапу — такий бланк не можна віддавати клієнту порожнім. Заповнюємо його кодом:
// етапи беремо з реального плану звіту (розділи = види робіт практики), терміни — з дат практики.
function parseUaDate(s) {
  const m = String(s || "").match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  return m ? new Date(Date.UTC(+m[3], +m[2] - 1, +m[1])) : null;
}
const fmtShort = d => `${String(d.getUTCDate()).padStart(2, "0")}.${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
const fmtFull = d => `${fmtShort(d)}.${d.getUTCFullYear()}`;

function practiceStageNames(sections) {
  const chapters = (sections || [])
    .filter(s => s && /^\d+$/.test(String(s.id)) && !["intro", "conclusions", "sources"].includes(s.type))
    .map(s => String(s.label || "").replace(/^\s*(розділ\s*)?\d+[.)]?\s*/i, "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .map(l => l.charAt(0).toUpperCase() + l.slice(1));
  if (!chapters.length) return null;
  return [
    "Ознайомлення з базою практики, інструктаж з охорони праці, опрацювання документації",
    ...chapters,
    "Формування висновків і пропозицій, оформлення звіту та супровідних документів",
  ];
}

export function fillPracticeCalendarPlan(template, info, sections) {
  const lines = String(template || "").split("\n").filter(l => /^\s*\|/.test(l));
  if (lines.length < 2) return buildPracticeCalendarPlanTable(info, sections);
  const cells = l => l.trim().replace(/^\||\|$/g, "").split("|").map(c => c.trim());
  const isSep = l => /^\s*\|?[\s:|-]+\|?\s*$/.test(l);
  const header = cells(lines[0]);
  const rest = lines.slice(1);
  const body = rest.filter(l => !isSep(l));
  // рядок нумерації колонок ("1 | 2 | 3 | 4") і порожні рядки — не змістовні
  const meaningful = body.filter(l => cells(l).some(c => c && !/^\d{1,2}$/.test(c) && !/^_+$/.test(c)));
  if (meaningful.length) return template;

  const roles = header.map(h => /№|з\/п/i.test(h) ? "num"
    : /тижн|термін|строк|дат|період/i.test(h) ? "term"
    : /відмітк|примітк|виконан/i.test(h) ? "note"
    : "name");
  if (!roles.includes("name")) roles[Math.min(1, roles.length - 1)] = "name";

  const stages = practiceStageNames(sections) || [
    "Ознайомлення з базою практики, інструктаж, опрацювання документації",
    "Збір і опрацювання даних для аналітичної частини звіту",
    "Дослідження системи управління та адміністрування бази практики",
    "Формування висновків, оформлення звіту та супровідних документів",
  ];
  const start = parseUaDate(info?.dateStart);
  const end = parseUaDate(info?.dateEnd);
  const totalDays = start && end && end >= start ? Math.round((end - start) / 86400000) + 1 : 0;
  const weeks = totalDays ? Math.max(1, Math.ceil(totalDays / 7)) : 0;
  const termHeader = header.find((_, k) => roles[k] === "term") || "";

  const rows = stages.map((name, i) => {
    let term = "______";
    if (totalDays) {
      const w1 = Math.floor(i * weeks / stages.length);
      const w2 = Math.max(w1, Math.ceil((i + 1) * weeks / stages.length) - 1);
      const from = new Date(start.getTime() + w1 * 7 * 86400000);
      const to = i === stages.length - 1 ? end : new Date(Math.min(end.getTime(), start.getTime() + (w2 * 7 + 6) * 86400000));
      const dates = `${fmtShort(from)}–${fmtFull(to)}`;
      const weekLabel = w1 === w2 ? `${w1 + 1}-й тиждень` : `${w1 + 1}–${w2 + 1} тижні`;
      term = /тижн/i.test(termHeader) ? `${weekLabel} (${dates})` : dates;
    }
    const vals = roles.map(r => r === "num" ? String(i + 1) : r === "name" ? name : r === "term" ? term : "Виконано");
    return `| ${vals.join(" | ")} |`;
  });
  const sep = rest.find(isSep) || `|${header.map(() => "---").join("|")}|`;
  return [lines[0], sep, ...body, ...rows].join("\n");
}

// Будує рядки титульної сторінки щоденника практики (блок "ЗАТВЕРДЖУЮ" + дані студента).
// Дефолт, якщо в методичці НЕ знайдено власного зразка титулки щоденника — підставляє реальні
// дані де вони відомі, інакше залишає загальний підпис-плейсхолдер (без вигаданого закладу).
export function buildPracticeDiaryTitlePageLines(info) {
  const { faculty, department, specialty, degreeLevel, knowledgeField, studentName, supervisorCompany, practiceType, course, studentGroup } = info || {};
  const practiceLabel = PRACTICE_TYPE_GENITIVE[practiceType]
    ? `${PRACTICE_TYPE_GENITIVE[practiceType]} практики`
    : "практики";

  const lines = [];
  lines.push({ text: "ЗАТВЕРДЖУЮ", align: "right", bold: true, spaceBefore: 0 });
  lines.push({ text: "Керівник підприємства", align: "right", bold: false, spaceBefore: 0 });
  lines.push({ text: "(організації, установи)", align: "right", bold: false, spaceBefore: 0 });
  lines.push({ text: supervisorCompany || "___________________", align: "right", bold: false, spaceBefore: 240 });
  lines.push({ text: "(підпис)               (ініціали, прізвище)", align: "right", bold: false, spaceBefore: 0 });
  lines.push({ text: "«___» _____________ 20__ р.", align: "right", bold: false, spaceBefore: 120 });

  lines.push({ text: "", align: "center", spaceBefore: 1200 });
  lines.push({ text: "ЩОДЕННИК ПРАКТИКИ", align: "center", bold: true, fontSize: 16, spaceBefore: 0 });
  lines.push({ text: "", align: "center", spaceBefore: 480 });

  lines.push({ text: practiceLabel, align: "center", bold: false, spaceBefore: 0 });
  lines.push({ text: "(вид і назва практики)", align: "center", bold: false, spaceBefore: 0 });
  lines.push({ text: "", align: "center", spaceBefore: 240 });

  lines.push({ text: `студента ${studentName || "[ПІБ студента]"}`, align: "left", bold: false, spaceBefore: 0 });
  lines.push({ text: "(прізвище, ім’я, по батькові)", align: "center", bold: false, spaceBefore: 0 });
  lines.push({ text: "", align: "center", spaceBefore: 240 });

  lines.push({ text: `інститут (факультет) ${faculty || "___________________"}`, align: "left", bold: false, spaceBefore: 0 });
  lines.push({ text: `кафедра ${department || "___________________"}`, align: "left", bold: false, spaceBefore: 0 });
  lines.push({ text: `освітньо-кваліфікаційний рівень ${degreeLevel || "___________________"}`, align: "left", bold: false, spaceBefore: 0 });
  lines.push({ text: `спеціальність ${specialty || "___________________"}`, align: "left", bold: false, spaceBefore: 0 });
  lines.push({ text: `галузь знань ${knowledgeField || "___________________"}`, align: "left", bold: false, spaceBefore: 0 });
  lines.push({ text: "ОПП ___________________", align: "left", bold: false, spaceBefore: 0 });
  lines.push({ text: "", align: "center", spaceBefore: 240 });
  lines.push({ text: `курс ${course || "___________"}, група ${studentGroup || "___________"}`, align: "left", bold: false, spaceBefore: 0 });

  return lines;
}
