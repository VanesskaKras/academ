// Маршрутизує вхідне замовлення з CRM (за полем "Вид роботи") до одного з
// чотирьох наявних флоу сайту, і будує зі структурованих полів CRM той самий
// текстовий шаблон, який зараз вручну вставляють у InputStage — щоб фактичний
// розбір полів робив уже перевірений parseTemplate() (src/lib/planUtils.js),
// а не новий парсер.
//
// ПРИМІТКА: точні назви полів реального вебхука CRM ще невідомі (CRM поки не
// підключена технічно) — форма нижче побудована за полями, видимими у формі
// CRM ("Вид роботи", "Напрям", "Тема", "Дедлайн клієнта", "Повна ціна" тощо).
// Коли буде відомий реальний payload вебхука — найімовірніше, треба буде
// підправити лише readCrmPayload()/поля нижче, сама таблиця маршрутизації і
// buildTemplateText() не зміняться.

export const FLOW = {
  GREAT: "great",             // academic-assistant.jsx — курсова/диплом/бакалаврська/магістерська
  SMALL: "small",             // small-works.jsx — реферат/тези/есе/презентація
  PRACTICE: "practice",       // PracticePage.jsx — звіт/щоденник практики
  CORRECTIONS: "corrections", // FileCorrectionsPage.jsx — правки
};

// Значення поля "Вид роботи" в CRM (закритий dropdown, підтверджено користувачем)
// → внутрішній флоу. "Практична робота" і "Самостійна робота" відсутні
// навмисно — CRM не надсилатиме такі замовлення на автообробку (підтверджено
// користувачем), тож routeOrder() свідомо не має для них "тихого" фолбеку.
//
// workType для FLOW.SMALL — внутрішні коди з WORK_TYPES у src/small-works.jsx
// (referat/tezy/ese/prezentatsiya) — тримати в синхроні з тими лейблами,
// якщо вони там зміняться.
const CRM_WORK_TYPE_MAP = {
  "Курсова": { flow: FLOW.GREAT },
  "Диплом": { flow: FLOW.GREAT },
  "Бакалаврська": { flow: FLOW.GREAT },
  "Магістерська": { flow: FLOW.GREAT },
  "Правки": { flow: FLOW.CORRECTIONS },
  "Проходження практики (звіт/щоденник)": { flow: FLOW.PRACTICE },
  "Презентація": { flow: FLOW.SMALL, workType: "prezentatsiya" },
  "Реферат": { flow: FLOW.SMALL, workType: "referat" },
  "Тези": { flow: FLOW.SMALL, workType: "tezy" },
  "Есе": { flow: FLOW.SMALL, workType: "ese" },
};

export class UnroutableOrderError extends Error {
  constructor(crmWorkType) {
    super(`Немає маршруту для "Вид роботи" = "${crmWorkType}" — CRM не мала надсилати цей тип на автообробку`);
    this.name = "UnroutableOrderError";
    this.crmWorkType = crmWorkType;
  }
}

// Будує той самий текстовий блок, який зараз вручну вставляють у InputStage —
// фактичний розбір полів (orderNumber/type/deadline/direction/subject/topic/
// pages/uniqueness/course) робить наявний parseTemplate() з planUtils.js.
export function buildTemplateText(crmPayload) {
  const line = (label, emoji, value) => (value ? `${emoji}${label} - ${value}` : "");
  return [
    crmPayload.orderNumber ? `№ замовлення - ${crmPayload.orderNumber}` : "",
    crmPayload.workTypeCrm ? `Тип - ${crmPayload.workTypeCrm}` : "",
    line("Дедлайн", "⏰", crmPayload.deadline),
    line("Напрям", "⚡️", crmPayload.direction),
    line("Тематика", "📌", crmPayload.subject),
    line("Тема", "✈️", crmPayload.topic),
    line("К-кість стр.", "⚙️", crmPayload.pages),
    line("Унікальність", "⚙️", crmPayload.uniqueness),
    crmPayload.course ? `Курс - ${crmPayload.course}` : "",
  ].filter(Boolean).join("\n");
}

/**
 * @param {object} crmPayload
 * @param {string} crmPayload.workTypeCrm - точне значення з dropdown "Вид роботи" в CRM
 * @param {string} [crmPayload.orderNumber]
 * @param {string} [crmPayload.direction] - "Напрям"
 * @param {string} [crmPayload.subject] - "Тематика"
 * @param {string} [crmPayload.topic] - "Тема"
 * @param {string} [crmPayload.deadline]
 * @param {string} [crmPayload.pages]
 * @param {string} [crmPayload.uniqueness]
 * @param {string} [crmPayload.course]
 * @param {number} [crmPayload.price]
 * @param {Array}  [crmPayload.files]
 * @throws {UnroutableOrderError} якщо "Вид роботи" не входить у підтримувані 10 значень
 */
export function routeOrder(crmPayload) {
  const route = CRM_WORK_TYPE_MAP[crmPayload.workTypeCrm];
  if (!route) throw new UnroutableOrderError(crmPayload.workTypeCrm);

  return {
    flow: route.flow,
    workType: route.workType || null,
    orderNumber: crmPayload.orderNumber || null,
    templateText: buildTemplateText(crmPayload),
    price: crmPayload.price ?? null,
    files: crmPayload.files || [],
  };
}
