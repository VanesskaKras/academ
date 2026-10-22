// job від CRM (POST /jobs/claim, docs/crm-integration.md §3.1) → документ orders/{id}
// у Firestore, яким далі керує processOrder() — та сама логіка, що й для
// замовлень, створених вручну в UI. orderId = job.run_id: той самий run_id на
// attempt=2 (продовження) природно потрапляє в той самий документ, а нова
// кнопка «Повторити» в CRM (новий run_id) — у свіжий документ.
//
// methodology/example_work/illustrations(pdf) — лінива URL-посилання
// (resolveFileBytes сам довантажить пізніше, у runAnalyzeStage);
// illustrations(фото)/client_drawings/photos/client_materials/ready_part/
// client_plan(файл) — довантажуються й (де треба) розбираються в текст тут,
// одразу, бо ці поля очікують готові дані, а не URL.
//
// Вартість витягування (лише гілки з ШІ: фото, скановані PDF) рахується в той
// самий job.limits.cost_usd, що й уся інша генерація — costTracker спільний
// на весь виклик, тож занадто "важкий" пакет client_materials зупинить
// створення job ДО старту генерації, а не витратить бюджет і провалиться пізніше.
import { loadOrder, saveOrderPatch } from "./firestoreAdmin.js";
import { downloadFile } from "./storage.js";
import { extractFileText } from "./materialsExtract.js";
import { looksLikeReadyPart } from "../src/lib/readyWorkExtract.js";
import { extractDocxReadyPart } from "../src/lib/readyPartDocx.js";
import { compressReadyImages } from "./readyPartImages.js";
import { createCostTracker } from "../src/lib/api.js";
import { createTokenAccumulator } from "./tokenAccumulator.js";

// ready_part — це вже написана клієнтом частина роботи, яку код-розпізнавання
// (readyWorkExtract.js) розбирає по реальних заголовках і вставляє як є. Звичайний
// MAX_TEXT_CHARS (50 000) у materialsExtract.js розрахований на довідкові
// client_materials і обрізав готові розділи повністю (разом зі списком джерел
// у кінці файлу) — той самий файл через UI (handleReadyWorkFile) читається без
// жодного обмеження, тож тут ставимо високу стелю лише як запобіжник від аномально
// великого файлу, а не робочий ліміт.
const READY_PART_MAX_CHARS = 500000;

function firstFileForSlot(files, slot) {
  return (files || []).find(f => f.slot === slot) || null;
}
function filesForSlot(files, slot) {
  return (files || []).filter(f => f.slot === slot);
}

async function toEagerImages(files) {
  return Promise.all(files.map(async f => ({
    name: f.name,
    b64: (await downloadFile(f.url)).toString("base64"),
    type: f.mime,
  })));
}

async function orderExists(orderId) {
  try {
    await loadOrder(orderId);
    return true;
  } catch {
    return false;
  }
}

// Мала робота (kind="small") — CRM визначає kind за типом роботи (§3.1
// контракту), але сам конкретний workType (реферат/тези/стаття/есе/
// презентація/доповідь) окремим полем job не приходить — лише всередині
// template_text, у тому самому рядку "Тип - ...", що й для великих робіт.
// Розпізнаємо його тут, ДО виклику runSmallAnalyze (яка приймає workType як
// вхідний параметр, а не визначає його сама — див. smallStages.js).
const SMALL_WORK_TYPE_PATTERNS = [
  ["ese", /есе/i],
  ["referat", /реферат/i],
  ["tezy", /тези/i],
  ["stattia", /стат(тя|ті|ей|тю)/i],
  ["prezentatsiya", /презентац/i],
  ["dopovid", /доповід/i],
];

// Headless-воркер поки вміє доводити до кінця лише "ese" — інші workType
// малих робіт (worker/processSmallOrder.js) ще не портовані зі small-works.jsx.
// Для "tezy": methodology → files, department_guidance → deptGuidanceText,
// client_materials → materialText, кожен окремо (див. worker/README.md, "TODO: тези").
const SMALL_WORK_TYPES_SUPPORTED = new Set(["ese"]);

function detectSmallWorkType(templateText) {
  const m = (templateText || "").match(/Тип\s*[-–—:]\s*([^\n]+)/i);
  const raw = (m?.[1] || "").trim();
  for (const [key, re] of SMALL_WORK_TYPE_PATTERNS) {
    if (re.test(raw)) return key;
  }
  return null;
}

async function buildSmallOrderFromJob(job, log) {
  const workType = detectSmallWorkType(job.template_text);
  if (!workType) {
    const e = new Error(
      'kind="small", але тип роботи не розпізнано з template_text (рядок "Тип - ..." відсутній або не збігся з жодним відомим типом).'
    );
    e.crmRetryable = false;
    e.crmStage = "input";
    throw e;
  }
  if (!SMALL_WORK_TYPES_SUPPORTED.has(workType)) {
    const e = new Error(`kind="small", workType="${workType}" — цей тип малої роботи ще не підтримується headless-воркером (наразі реалізовано лише "ese").`);
    e.crmRetryable = false;
    e.crmStage = "input";
    throw e;
  }

  const files = job.files || [];
  const methodology = firstFileForSlot(files, "methodology");
  const exampleWork = firstFileForSlot(files, "example_work");
  const clientMaterialsFiles = filesForSlot(files, "client_materials");

  const tokenAcc = createTokenAccumulator({});
  const costTracker = createCostTracker(job.limits?.cost_usd ?? 6);
  const extractOpts = { costTracker, onCost: tokenAcc.onCost };

  const order = {
    workType, mode: "small",
    tplText: job.template_text || "",
    comment: job.comment || "",
    orderNumber: job.order_num,
    crmRunId: job.run_id,
    crmKind: job.kind,
    stage: "input",
    status: "new",
  };

  // Методичка — тут, на відміну від великих робіт, одразу eager (b64): runSmallAnalyze
  // очікує order.files як готові {name,b64,type} (toClaudeFilesAsync), а не лаяву URL-адресу.
  if (methodology) {
    try {
      order.files = await toEagerImages([methodology]);
    } catch (e) {
      log(`⚠ Не вдалось довантажити методичку (${methodology.name}): ${e.message}`);
    }
  }
  // «Титульна сторінка» (тег title_page) — у малих роботах іде тим самим списком файлів:
  // runSmallAnalyze сам знаходить титулку серед фото/PDF (titlePageInfo).
  const titlePageSmall = firstFileForSlot(files, "title_page");
  if (titlePageSmall) {
    try {
      order.files = [...(order.files || []), ...(await toEagerImages([titlePageSmall]))];
    } catch (e) {
      log(`⚠ Не вдалось довантажити титулку (${titlePageSmall.name}): ${e.message}`);
    }
  }

  if (clientMaterialsFiles.length) {
    log(`→ Витягую текст з ${clientMaterialsFiles.length} файл(ів) client_materials...`);
    const extracted = (await Promise.all(clientMaterialsFiles.map(async f => {
      try {
        const buffer = await downloadFile(f.url);
        const text = await extractFileText({ name: f.name, mime: f.mime, buffer }, extractOpts);
        return text?.trim() ? `[${f.name}]\n${text.trim()}` : null;
      } catch (e) {
        if (e.isCostLimit) { e.crmRetryable = false; e.crmStage = "analysis"; throw e; }
        log(`⚠ Не вдалось витягти текст з ${f.name}: ${e.message}`);
        return null;
      }
    }))).filter(Boolean);
    if (extracted.length) order.materialText = extracted.join("\n\n");
  }

  // Зразок роботи — для "ese" читається одразу в текст (як structureExampleText
  // у реферату через ExampleFileZone.jsx у браузері), а не лаяво як exampleWorkFile
  // для великих робіт — малий пайплайн такого лаявого поля не резолвить.
  if (exampleWork) {
    try {
      const buffer = await downloadFile(exampleWork.url);
      const text = await extractFileText({ name: exampleWork.name, mime: exampleWork.mime, buffer }, extractOpts);
      if (text?.trim()) {
        order.essayExampleName = exampleWork.name;
        order.essayExampleText = text.trim();
      }
    } catch (e) {
      log(`⚠ Не вдалось прочитати зразок роботи (${exampleWork.name}): ${e.message}`);
    }
  }

  return { ...order, ...tokenAcc.snapshot() };
}

/**
 * Гарантує, що orders/{job.run_id} існує (створює зі свіжого job на attempt=1,
 * або лишає як є — продовження — якщо документ уже є). Повертає orderId.
 */
export async function ensureOrderFromJob(job, log = console.log) {
  const orderId = job.run_id;

  if (await orderExists(orderId)) {
    log(`Замовлення ${orderId} уже є в Firestore — продовжую (attempt ${job.attempt}).`);
    return orderId;
  }

  if (job.kind === "practice") {
    const e = new Error(
      'kind="practice" ще не підтримується воркером — звіти з практики зараз окремий потік ' +
      "(PracticePage.jsx: щоденник, календарний графік, креслення), не підключений до processOrder()."
    );
    e.crmRetryable = false;
    e.crmStage = "input";
    throw e;
  }

  if (job.kind === "small") {
    const order = await buildSmallOrderFromJob(job, log);
    await saveOrderPatch(orderId, order);
    log(`✓ Створено замовлення ${orderId} (CRM #${job.order_num}, kind=small, workType=${order.workType}).`);
    return orderId;
  }

  const files = job.files || [];
  const methodology = firstFileForSlot(files, "methodology");
  const methodologyAll = filesForSlot(files, "methodology");
  if (methodologyAll.length > 1) {
    log(`⚠ CRM надіслав ${methodologyAll.length} methodology-файли — беру лише перший (${methodology.name}), інші поки ігноруються.`);
  }
  const exampleWork = firstFileForSlot(files, "example_work");

  const illustrationFiles = filesForSlot(files, "illustrations");
  const illustrationsIsSinglePdf = illustrationFiles.length === 1 && illustrationFiles[0].mime === "application/pdf";

  const clientDrawingFiles = filesForSlot(files, "client_drawings");
  const photoFiles = [...filesForSlot(files, "photos"), ...filesForSlot(files, "department_guidance")];

  const clientMaterialsFiles = filesForSlot(files, "client_materials");
  const readyPartFile = firstFileForSlot(files, "ready_part");
  const clientPlanFile = firstFileForSlot(files, "client_plan");

  // Спільний трекер вартості для всіх ШІ-гілок витягування (фото, скановані
  // PDF) на цей job — той самий ліміт, що й уся генерація.
  const tokenAcc = createTokenAccumulator({});
  const costTracker = createCostTracker(job.limits?.cost_usd ?? 6);
  const extractOpts = { costTracker, onCost: tokenAcc.onCost };

  // readyPart — готова частина .docx: таблиці рядками "| … |", рисунки — маркерами + images
  async function extractSlotFile(file, { maxChars, withListNumbers, readyPart } = {}) {
    try {
      const buffer = await downloadFile(file.url);
      const isDocx = /\.docx$/i.test(file.name || "") || file.mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
      if (readyPart && isDocx) {
        const { text, images } = await extractDocxReadyPart(buffer);
        return text?.trim() ? { name: file.name, text: text.trim().slice(0, maxChars), images } : null;
      }
      const text = await extractFileText({ name: file.name, mime: file.mime, buffer, maxChars, withListNumbers }, extractOpts);
      return text?.trim() ? { name: file.name, text: text.trim() } : null;
    } catch (e) {
      if (e.isCostLimit) {
        e.crmRetryable = false; // повторний спробунок не змінить того, що матеріали задорогі для ліміту job
        e.crmStage = "analysis";
        throw e; // зупиняємо створення job цілком, а не пропускаємо один файл
      }
      log(`⚠ Не вдалось витягти текст з ${file.name}: ${e.message}`);
      return null;
    }
  }

  if (clientMaterialsFiles.length) {
    log(`→ Витягую текст з ${clientMaterialsFiles.length} файл(ів) client_materials...`);
  }
  let extractedMaterials = (await Promise.all(clientMaterialsFiles.map(f => extractSlotFile(f)))).filter(Boolean);

  // План і готову частину читаємо з номерами автонумерації Word (1.1., 1.1.1) — без них
  // пункти плану/заголовки губляться (кейс 41476)
  let clientPlanFromFile = null;
  if (clientPlanFile && !job.client_plan_text) {
    const extracted = await extractSlotFile(clientPlanFile, { withListNumbers: true });
    if (extracted) {
      clientPlanFromFile = extracted.text;
      log(`✓ План клієнта розібрано з файлу (${clientPlanFile.name}).`);
    } else {
      log(`⚠ Не вдалось розібрати план з файлу (${clientPlanFile.name}) — замовлення піде шляхом "плану немає" (§3.5).`);
    }
  }

  let readyWorkText = null;
  let readyWorkRawImages = [];
  if (readyPartFile) {
    const extracted = await extractSlotFile(readyPartFile, { maxChars: READY_PART_MAX_CHARS, withListNumbers: true, readyPart: true });
    if (extracted) {
      readyWorkText = extracted.text;
      readyWorkRawImages = extracted.images || [];
      log(`✓ Готову частину роботи отримано слотом ready_part (${readyPartFile.name}, ${extracted.text.length} символів).`);
    } else log(`⚠ Не вдалось розібрати ready_part (${readyPartFile.name}) — ігнорується.`);
  } else {
    // ready_part порожній, але готову частину могли покласти в client_materials: .docx, чиї
    // заголовки (2.1, 2.1.1…) збігаються з планом клієнта за номером і назвою, беремо як
    // ready_part (повний текст, без ліміту матеріалів) і прибираємо з матеріалів — інакше
    // її переписували заново, а посилання з тексту ставали "джерелами" (кейс 41476)
    const planText = job.client_plan_text || clientPlanFromFile || "";
    const docxMaterials = clientMaterialsFiles.filter(f => /\.docx$/i.test(f.name || "") || f.mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    if (planText.trim()) {
      for (const f of docxMaterials) {
        const full = await extractSlotFile(f, { maxChars: READY_PART_MAX_CHARS, withListNumbers: true, readyPart: true });
        if (full && looksLikeReadyPart(full.text, planText)) {
          readyWorkText = full.text;
          readyWorkRawImages = full.images || [];
          extractedMaterials = extractedMaterials.filter(m => m.name !== f.name);
          log(`✓ Файл ${f.name} з client_materials розпізнано як готову частину роботи (заголовки збігаються з планом) — використовую як ready_part.`);
          break;
        }
      }
    }
  }

  const order = {
    tplText: job.template_text || "",
    comment: job.comment || "",
    // часткова робота за коментарем менеджера ({chapters:[2], pages:25}) — пишемо лише ці розділи
    writeScope: (job.write_scope && Array.isArray(job.write_scope.chapters) && job.write_scope.chapters.length) ? job.write_scope : null,
    clientPlan: job.client_plan_text || clientPlanFromFile || "",
    orderNumber: job.order_num,
    crmRunId: job.run_id,
    crmKind: job.kind,
    stage: "input",
    status: "new",
    ...tokenAcc.snapshot(), // вартість витягування (якщо були ШІ-гілки) — щоб рахувалась у ORDER_COST_LIMIT job з першого запуску processOrder()
  };
  if (extractedMaterials.length) order.clientMaterials = extractedMaterials;
  if (readyWorkText) order.readyWorkText = readyWorkText;
  if (readyWorkRawImages.length) {
    order.readyWorkImages = await compressReadyImages(readyWorkRawImages, log);
    log(`✓ Рисунків у готовій частині: ${readyWorkRawImages.length}, збережено: ${order.readyWorkImages.filter(Boolean).length}.`);
  }
  if (methodology) order.methodichkaFile = { url: methodology.url, mediaType: methodology.mime, name: methodology.name };
  if (exampleWork) order.exampleWorkFile = { url: exampleWork.url, mediaType: exampleWork.mime, name: exampleWork.name };
  const titlePage = firstFileForSlot(files, "title_page");
  if (titlePage) order.titlePageFile = { url: titlePage.url, mediaType: titlePage.mime, name: titlePage.name };
  if (illustrationsIsSinglePdf) {
    order.illustrationsPdfFile = { url: illustrationFiles[0].url, mediaType: illustrationFiles[0].mime, name: illustrationFiles[0].name };
  } else if (illustrationFiles.length) {
    order.illustrations = await toEagerImages(illustrationFiles);
  }
  if (clientDrawingFiles.length) order.clientDrawings = await toEagerImages(clientDrawingFiles);
  if (photoFiles.length) order.photos = await toEagerImages(photoFiles);

  await saveOrderPatch(orderId, order);
  log(`✓ Створено замовлення ${orderId} (CRM #${job.order_num}, kind=${job.kind}).`);
  return orderId;
}
