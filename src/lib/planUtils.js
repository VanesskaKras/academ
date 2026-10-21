// Розширення файлів коду — читаються як звичайний текст у ClientMaterialsZone
// і розпізнаються як "вихідний код" для програмної збірки Додатку з лістингами
export const CODE_FILE_EXTENSIONS = [
  ".py", ".js", ".jsx", ".ts", ".tsx", ".java", ".c", ".cpp", ".cc", ".h", ".hpp",
  ".cs", ".php", ".rb", ".go", ".rs", ".sql", ".json", ".yaml", ".yml",
  ".html", ".htm", ".css", ".scss", ".sh", ".kt", ".swift", ".m", ".r", ".pl", ".lua",
];

// Клієнт часто дописує до теми службовий дужковий хвіст типу
// "(+ презентація та доповідь)" — це вказівка на додаткові матеріали до захисту,
// а не частина самої теми. Прибираємо лише завершальні дужки/квадратні дужки зі
// словами "презентац"/"доповід" всередині.
export function stripPresentationSuffix(topic) {
  if (!topic) return topic;
  let result = String(topic);
  const tailRe = /\s*[([]\s*[^()[\]]*(?:презентац|доповід)[^()[\]]*[)\]]\s*$/iu;
  while (tailRe.test(result)) result = result.replace(tailRe, "");
  return result.trim();
}

// Слово-маркер розділу різними мовами — щоб не змішувати "РОЗДІЛ" з "CHAPTER"/"KAPITEL"
// тощо в межах однієї роботи (визначаємо фактично використане слово з наявних назв,
// а не хардкодимо українське за замовчуванням). До вбудованих слів додаються слова мов,
// набір яких склав ШІ (registerLangProfile нижче) — тому це функції, а не сталі регулярки.
const BUILTIN_CHAPTER_WORDS = "РОЗДІЛ|CHAPTER|ROZDZIAŁ|CAP[IÍ]TULO|CAPITULO|KAPITEL|KAPITOLA|CHAPITRE|CAPITOLO";
const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function dynamicChapterWords() {
  const dyn = [...DYNAMIC_PROFILES.values()];
  return {
    wordFirst: dyn.filter(lp => !lp.chapterPattern.startsWith("{n}")).map(lp => escRe(lp.chapterWord)),
    numFirst: dyn.filter(lp => lp.chapterPattern.startsWith("{n}")).map(lp => escRe(lp.chapterWord)),
  };
}
// Початок заголовка розділу. Група 1 — слово ("РОЗДІЛ", "CHAPTER", "第2章", "CAPITOLUL"…);
// група 2 — слово мови, де номер стоїть попереду ("1. FEJEZET").
export function chapterWordRe() {
  const { wordFirst, numFirst } = dynamicChapterWords();
  const numFirstAlt = numFirst.length ? `|\\d+\\.?\\s*(${numFirst.join("|")})(?!\\p{L})` : "";
  return new RegExp(`^(?:(${[BUILTIN_CHAPTER_WORDS, ...wordFirst].join("|")}|第\\d*章)${numFirstAlt})`, "iu");
}
// Префікс розділу з номером; група 1 — решта назви після нього
function chapterPrefixNumRe() {
  const { wordFirst, numFirst } = dynamicChapterWords();
  const numFirstAlt = numFirst.length ? `|\\d+\\.?\\s*(?:${numFirst.join("|")})` : "";
  return new RegExp(`^(?:(?:${[BUILTIN_CHAPTER_WORDS, ...wordFirst].join("|")})\\s*\\d+|第\\d+章${numFirstAlt})[.:]?\\s*(.*)`, "iu");
}

// Визначає слово-маркер розділу за вже наявними назвами розділів (перше, що збіглося),
// щоб перенумерація/експорт не додавали чуже мовою слово ("РОЗДІЛ") до назви, вже
// написаної іншою мовою ("CHAPTER 1. ...") — інакше вийде подвійний префікс.
export function detectChapterWord(titles, fallback = "РОЗДІЛ") {
  const re = chapterWordRe();
  for (const t of titles || []) {
    const m = (t || "").match(re);
    if (m) return (m[1] || m[2]).toUpperCase();
  }
  return fallback;
}

// "СЛОВО N" за словом, знайденим detectChapterWord: "РОЗДІЛ 2", "第2章" (номер усередині), а для
// мови з набору ШІ — за її шаблоном ("2. FEJEZET").
export function composeChapterPrefix(word, n) {
  if (/^第\d*章?$/.test(word)) return `第${n}章`;
  const dyn = [...DYNAMIC_PROFILES.values()].find(lp => lp.chapterWord.toUpperCase() === String(word).toUpperCase());
  if (dyn) return dyn.chapterPattern.replace("{n}", String(n)).toUpperCase();
  return `${word} ${n}`;
}

const LATIN_APPENDIX_LETTERS = ["A","B","C","D","E","F","G","H","I","J","K","L","M","N","O","P","Q","R","S","T","U","V","W","X","Y","Z"];
// ДСТУ 3008: нумерація додатків українською абеткою без літер Ґ, Є, З, І, Ї, Й, О, Ч, Ь (схожі на цифри/інші літери)
const UKRAINIAN_APPENDIX_LETTERS = ["А","Б","В","Г","Д","Е","Ж","И","К","Л","М","Н","П","Р","С","Т","У","Ф","Х","Ц","Ш","Щ","Ю","Я"];

// Слово-позначка ОДНОГО додатка всіма мовами роботи (getLangLabels().appendixSingular):
// "ДОДАТОК А" / "APPENDIX A" / "ZAŁĄCZNIK A" / "附录A". Між словом і літерою — пробіл
// (інакше "APPENDICE" ловило б множинне "APPENDICES"), лише для "附录" він необов'язковий.
// Після літери — межа, щоб "Додаток містить…" на початку абзацу не вважався позначкою.
// Слова мов з набору ШІ (registerLangProfile) додаються під час виклику.
const BUILTIN_APPENDIX_WORDS = "ДОДАТОК|APPENDIX|ZAŁĄCZNIK|APÉNDICE|ANHANG|PŘÍLOHA|PRÍLOHA|ANNEXE|APPENDICE";
const appendixWordAlt = () => {
  const dyn = [...DYNAMIC_PROFILES.values()].map(lp => escRe(lp.appendixSingular));
  return `(?:(?:${[BUILTIN_APPENDIX_WORDS, ...dyn].join("|")})\\s+|附录\\s*)`;
};
const APPENDIX_LETTER_TAIL = "(\\p{Lu})(?=$|[\\s.:,;)–—\\-\\d])";
// Рядок-позначка додатка (на початку рядка): appendixLabelRe().test(line)
export const appendixLabelRe = () => new RegExp(`^${appendixWordAlt()}${APPENDIX_LETTER_TAIL}`, "iu");
// Усі позначки в тексті з літерою в групі 1 — новий екземпляр щоразу (прапорець g тримає lastIndex)
export const appendixLetterRegex = () => new RegExp(`${appendixWordAlt()}${APPENDIX_LETTER_TAIL}`, "giu");

// Пропорційно підганяє масив сторінок під точну цільову суму — виправляє неточну
// арифметику ШІ (при генерації плану з багатьма підрозділами LLM часто не влучає
// точно в задану суму) і похибку округлення при рівному розподілі (recalcPages).
// minPerItem — бажаний мінімум на елемент, але якщо навіть по мінімуму сума вже
// перевищує targetSum, floor автоматично знижується до 1, щоб не ламати точну суму.
export function normalizePageDistribution(pagesArr, targetSum, minPerItem = 1) {
  const n = pagesArr.length;
  if (!n) return [];
  const floor = (minPerItem * n <= targetSum) ? minPerItem : 1;
  const nums = pagesArr.map(p => parseInt(p) || 0);
  const currentSum = nums.reduce((a, p) => a + p, 0);
  const scaled = currentSum > 0
    ? nums.map(p => Math.max(floor, Math.round(p * targetSum / currentSum)))
    : Array(n).fill(Math.max(floor, Math.round(targetSum / n)));
  // Залишок округлення розподіляємо по +1/-1 за раз (не одним стрибком на один
  // елемент) — інакше при великій похибці й малому floor корекція впирається в межу
  // одного елемента, і сума так і не збігається з ціллю.
  let diff = targetSum - scaled.reduce((a, p) => a + p, 0);
  let guard = 0;
  while (diff !== 0 && guard < 10000) {
    guard++;
    if (diff > 0) {
      const idx = scaled.indexOf(Math.min(...scaled));
      scaled[idx] += 1; diff -= 1;
    } else {
      const idx = scaled.indexOf(Math.max(...scaled));
      if (scaled[idx] <= floor) break; // нема куди далі знімати
      scaled[idx] -= 1; diff += 1;
    }
  }
  return scaled;
}

// Прибирає з плану "розділи", які насправді є формальними елементами документа
// (титульна сторінка, зміст, щоденник практики, список джерел) — вони вже існують
// як окремі фіксовані частини звіту й не повинні опинятись серед sections, де для
// кожного елемента система шукає джерела й генерує текст-переказ. Захист кодом на
// випадок, якщо LLM попри інструкцію в промпті все ж скопіює такий пункт із чек-листа
// складу документа (напр. з рекомендацій кафедри) як окремий розділ.
const NON_CONTENT_SECTION_RE = /^(титульна\s*сторінка|зміст|щоденник(\s+практики)?|список\s+(використаних\s+)?джерел)$/i;
export function stripNonContentSections(sections, fixedIds = ["intro", "conclusions", "sources"]) {
  return (sections || []).filter(s => {
    if (fixedIds.includes(s.id)) return true;
    const clean = (s.label || "").replace(/^[\d.)\s]+/, "").trim();
    return !NON_CONTENT_SECTION_RE.test(clean);
  });
}

// Компоненти вступу з методички ДОПОВНЮЮТЬ базовий обов'язковий список, а не замінюють
// його. Раніше, якщо крок читання методички не розпізнав явно згаданий пункт (напр.
// методичка каже "особливу увагу слід приділити поясненню методів дослідження" звичайним
// реченням, а не підзаголовком "методи дослідження:"), непорожній methodInfo.introComponents
// повністю витісняв дефолтний список — і пункт на кшталт "методи дослідження" просто
// зникав із вступу, хоча його включення завжди доречне для наукової роботи. Об'єднання
// (union) натомість лише додає специфічні для методички пункти (гіпотеза, апробація тощо)
// понад базові, не ризикуючи прибрати щось обов'язкове через неповне розпізнавання.
export function mergeIntroComponents(defaultComponents, methodComponents) {
  const base = defaultComponents || [];
  const extra = (methodComponents || []).filter(
    mc => !base.some(dc => dc.trim().toLowerCase() === (mc || "").trim().toLowerCase())
  );
  return [...base, ...extra];
}

// Виявлення посилань на рисунки в тексті ("Рис. 1.2", "Figure 3" тощо) — спільна для
// перевірки "чи є в розділі рисунок" у флоу курсових/дипломних (academic-assistant.jsx)
// і у флоу звітів з практики (PracticePage.jsx).
export function scanFigures(text) {
  const FIG_RE = /(?:рис(?:унок)?\.?\s*\d+(?:\.\d+)*|fig(?:ure)?\.?\s*\d+(?:\.\d+)*)/gi;
  const results = [];
  const lines = (text || "").split("\n");
  lines.forEach(line => {
    const matches = line.match(FIG_RE);
    if (matches) {
      const ctx = line.replace(/\s+/g, " ").trim().substring(0, 120);
      matches.forEach(m => results.push({ label: m, context: ctx }));
    }
  });
  const seen = new Set();
  return results.filter(r => { if (seen.has(r.label.toLowerCase())) return false; seen.add(r.label.toLowerCase()); return true; });
}

// Чи є в тексті розділу РЕАЛЬНО намальований рисунок (plantuml-блок або таблиця
// даних, одразу за якою йде підпис) — на відміну від scanFigures, яка ловить будь-
// яку словесну згадку "Рис. X" навіть без самого рисунка. Потрібна окремо для
// перевірки "чи розділ уже має рисунок" (mandatoryFigureNote у PracticePage.jsx і
// academic-assistant.jsx) — інакше підрозділ, що лише згадав рисунок словами,
// хибно "закриває" вимогу методички для решти розділу.
export function hasRealFigure(text) {
  if (!text) return false;
  if (/^\s*```\s*plantuml\s*$/im.test(text)) return true;
  const lines = text.split("\n");
  const FIG_CAP_RE = /^(рис(?:унок)?\.?|fig(?:ure)?\.?|rys\.?|abb\.?|obr\.?)\s*\d/i;
  let i = 0;
  while (i < lines.length) {
    if (/^\s*\|/.test(lines[i])) {
      let j = i;
      while (j < lines.length && /^\s*\|/.test(lines[j])) j++;
      let k = j;
      while (k < lines.length && !lines[k].trim()) k++;
      if (k < lines.length && FIG_CAP_RE.test(lines[k].trim())) return true;
      i = j;
      continue;
    }
    i++;
  }
  return false;
}

// Знаходить речення в тексті, які посилаються на рисунок за номером ("...показано
// на Рис. X.Y"), але для цього номера немає реального рисунка (plantuml-блоку чи
// таблиці з підписом) — тобто ШІ написала посилання, так і не намалювавши сам
// рисунок. Повертає {number, sentence, kind:"missing"} для точкової фінальної
// добудови/прибирання (fixDanglingFigures у PracticePage.jsx).
//
// Окремо ловить і другий випадок: рисунок з таким номером У ТЕКСТІ Є, але стоїть
// задалеко від речення, яке на нього посилається (типово — ШІ згадала "Рис. X.Y"
// на початку абзацу, а саму схему домалювала аж у кінці підрозділу). Раніше такий
// рисунок вважався "закритим" лише за фактом існування десь у тексті, тож і
// опинявся систематично в кінці. Такі елементи повертаються з kind:"misplaced" і
// межами свого блоку (blockStart/blockEnd) — fixDanglingFigures переносить сам
// блок ближче до посилання кодом, без повторного виклику ШІ.
export function findDanglingFigureRefs(text, figWord) {
  if (!text) return [];
  const fwEsc = figWord.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const CAP_RE = new RegExp(`^\\s*${fwEsc}\\s*(\\d+(?:\\.\\d+)?)`, "i");
  const REF_RE = new RegExp(`${fwEsc}\\s*(\\d+(?:\\.\\d+)?)`, "gi");
  const FENCE_OPEN_RE = /^\s*```\s*plantuml\s*$/i;

  const lines = text.split("\n");
  const lineStarts = [];
  { let pos = 0; for (const l of lines) { lineStarts.push(pos); pos += l.length + 1; } }

  // Для кожного номера — межі його ПЕРШОГО реального блоку в тексті (fence чи
  // таблиця + підпис одразу після). Перенесення (kind:"misplaced") робимо лише
  // для plantuml-блоків: межі fence однозначні й переносяться безпечно, а межі
  // таблиці з даними прив'язані до сусіднього тексту сильніше — там ризикованіше.
  const resolvedBlocks = new Map();
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].trim().match(CAP_RE);
    if (!m) continue;
    let j = i - 1;
    while (j >= 0 && !lines[j].trim()) j--;
    const prevTrimmed = j >= 0 ? lines[j].trim() : "";
    const isFenceClose = prevTrimmed === "```";
    const isTableRow = /^\s*\|/.test(lines[j] || "");
    if (!isFenceClose && !isTableRow) continue;
    const num = m[1];
    if (resolvedBlocks.has(num)) continue; // лишаємо перший знайдений блок
    const capLineEnd = lineStarts[i] + lines[i].length + (i < lines.length - 1 ? 1 : 0);
    let blockStart;
    if (isFenceClose) {
      let k = j;
      while (k >= 0 && !FENCE_OPEN_RE.test(lines[k])) k--;
      blockStart = k >= 0 ? lineStarts[k] : lineStarts[j];
    } else {
      let k = j;
      while (k >= 0 && /^\s*\|/.test(lines[k])) k--;
      blockStart = lineStarts[k + 1];
    }
    resolvedBlocks.set(num, { blockStart, blockEnd: capLineEnd, isFence: isFenceClose });
  }

  // Межі речення шукаємо вручну (а не наївним split за крапками) — сам номер
  // рисунка вже містить крапку (X.Y), тож розбиття тексту на речення "по крапці"
  // ламало б збіг рівно на цьому місці. Замість цього йдемо від знайденого
  // посилання назад/вперед до найближчого справжнього кінця речення.
  const MAX_NEARBY_DIST = 600; // символів між кінцем речення-посилання й початком блоку
  const out = [];
  const seen = new Set();
  const globalRefRe = new RegExp(REF_RE.source, "gi");
  let m;
  while ((m = globalRefRe.exec(text))) {
    const num = m[1];
    if (seen.has(num)) continue;
    seen.add(num);
    let start = m.index;
    while (start > 0 && !".!?\n".includes(text[start - 1])) start--;
    let end = m.index + m[0].length;
    while (end < text.length && !".!?\n".includes(text[end])) end++;
    if (end < text.length) end++;
    const sentence = text.slice(start, end).trim();

    const block = resolvedBlocks.get(num);
    if (!block) {
      out.push({ number: num, sentence, kind: "missing" });
      continue;
    }
    // Саме це "посилання" і є рядком підпису блоку — не помилка позиціювання.
    if (m.index >= block.blockStart && m.index <= block.blockEnd) continue;
    const dist = block.blockStart - end;
    if (block.isFence && (dist < 0 || dist > MAX_NEARBY_DIST)) {
      out.push({ number: num, sentence, kind: "misplaced", blockStart: block.blockStart, blockEnd: block.blockEnd });
    }
  }
  return out;
}

// Одиниці виміру, які extractNumericFacts розпізнає одразу після числа — згруповані за
// галуззю, щоб довідник було легко доповнювати. Довші/складені токени (дБА, мг/м³, км/год)
// мають стояти РАНІШЕ за їхні короткі префікси (дБ, мг, км) лише для читабельності: коректність
// не залежить від порядку — regex-бектрекінг сам перебирає альтернативи, поки не знайде ту, що
// проходить негативний lookahead нижче (захист від збігу всередині іншого слова).
const MEASUREMENT_UNITS = [
  // Акустика і вібрація (охорона праці)
  "дБА", "дБ", "дБ\\(А\\)",
  "м/с²", "м/с2", "мм/с²", "мм/с2", "мм/с",
  // Концентрації, екологія, хімія
  "мкг/м³", "мкг/м3", "мг/м³", "мг/м3", "г/м³", "г/м3", "мг/л", "мг/кг", "г/л", "ppm", "promille|‰",
  // Освітленість, оптика
  "лк", "люкс[а-яії]*", "кд",
  // Тиск
  "кПа", "МПа", "гПа", "Па", "атм", "мм\\s?рт\\.?\\s?ст\\.?", "бар",
  // Електрика
  "кВт·год", "кВт\\*год", "кВт", "МВт", "мА", "кА", "А", "кВ", "В", "Ом", "Вт", "Гц", "кГц", "МГц",
  // Температура
  "°C", "°С", "°F", "°К", "К", "градус[а-яії]*",
  // Маса
  "мкг", "мг", "кг", "г", "т",
  // Довжина
  "мкм", "нм", "мм", "см", "дм", "км", "м",
  // Площа
  "км²", "км2", "га", "м²", "м2", "см²", "см2",
  // Об'єм
  "мл", "м³", "м3", "л",
  // Швидкість, оберти
  "км/год", "м/с", "об/хв", "rpm",
  // Час
  "рок(?:ів|и|у)?|рік", "місяц[а-яії]*", "тижн[а-яії]*", "доб[а-яії]*", "год(?:ин[а-яії]*)?", "хв(?:илин[а-яії]*)?", "с(?:ек(?:унд[а-яії]*)?)?",
  // Гроші
  "тис\\.?\\s?грн", "млн\\.?\\s?грн", "грн", "USD", "EUR", "\\$", "€",
  // Кількісні показники
  "відсотк[а-яії]*", "бал(?:ів|и|а)?", "шт\\.?", "од\\.?", "осіб", "чол\\.?", "%",
];
const UNIT_ALTERNATION = MEASUREMENT_UNITS.join("|");

// Негативний lookahead після одиниці виміру відсікає збіги всередині довшого слова (напр. "м"
// не повинно спрацьовувати на "5 метрів" чи "5 місяців" — там далі йде буква, а не пробіл/розділовий
// знак/цифра/кінець рядка), водночас дозволяючи одиниці одразу перед комою чи дужкою.
// Друга гілка — валютні символи ПЕРЕД числом ("$500", "€500"), бо грн/USD/EUR як слова
// зазвичай пишуться ПІСЛЯ числа й уже покриті першою гілкою через UNIT_ALTERNATION.
const NUMERIC_FACT_RE = new RegExp(
  `\\d+(?:[.,]\\d+)?\\s*(?:${UNIT_ALTERNATION})(?![a-zA-Zа-яіїєґА-ЯІЇЄҐ])|[$€]\\s*\\d+(?:[.,]\\d+)?`,
  "i"
);

// Витягує речення з конкретними числовими показниками (%, °C, дБ, мг/м³ тощо) з уже написаного
// тексту — для передачі як "вже зафіксовані цифри" в наступні розділи звіту з практики (чи
// будь-якої іншої роботи), щоб той самий показник (напр. рівень шуму, концентрація пилу,
// норматив вібрації) не отримував різні значення в різних розділах.
export function extractNumericFacts(text) {
  if (!text) return [];
  // Речення розбиваються за крапкою/!/?, після якої йде пробіл І ВЕЛИКА ЛІТЕРА чи лапки —
  // тобто справжній початок нового речення. Це водночас рятує від двох типів хибного розриву:
  // номери "Таблиця 6.1"/виміри "8.5 мг/м³" (крапка одразу перед цифрою, без пробілу — і так
  // не зачепить лапки), і посилання-скорочення на кшталт "(табл. 6.1)", "(рис. 2.3)" (після
  // крапки йде пробіл, але далі цифра, а не велика літера — теж не межа речення).
  const sentences = text.split(/(?<=[.!?])\s+(?=[А-ЯІЇЄҐA-Z«"“'])/);
  const seen = new Set();
  const out = [];
  sentences.forEach(raw => {
    const trimmed = raw.replace(/\s+/g, " ").trim();
    if (!trimmed || !NUMERIC_FACT_RE.test(trimmed)) return;
    const key = trimmed.toLowerCase().replace(/[^0-9a-zа-яіїєґ%°²³/$€‰]/g, "");
    if (seen.has(key)) return;
    seen.add(key);
    out.push(trimmed);
  });
  return out;
}

// Літерно-цифрові коди документів/журналів (напр. "ВЛ-06", "ЕТ-9") — extractNumericFacts їх
// не ловить (вимагає цифру ПЕРЕД одиницею виміру), а саме такі коди на практиці "пливуть" між
// розділами звіту (ВЛ-06 в одному місці, ВА-06 чи БЛ-06 в іншому — одна літера переплутана
// при повторному читанні джерела). \b тут не годиться: JS-двигун вважає \w лише латиницю й
// цифри, тож межа слова навколо кирилиці працює непередбачувано — межі задані вручну через
// lookaround, з тим самим набором "сусідніх" символів, що й у NUMERIC_FACT_RE вище.
const CODE_FACT_RE = /(?<![а-яіїєґА-ЯІЇЄҐa-zA-Z0-9])[А-ЯІЇЄҐ]{1,3}-\d{1,3}(?:\.\d+)?(?![а-яіїєґА-ЯІЇЄҐa-zA-Z0-9])/g;

// Витягує коди документів/журналів (ВЛ-06, ЕТ-9 тощо) з тексту — так само як extractNumericFacts,
// але для літерно-цифрових позначень, щоб той самий код не "плив" між розділами звіту.
export function extractCodeFacts(text) {
  if (!text) return [];
  const seen = new Set();
  const out = [];
  for (const m of text.matchAll(CODE_FACT_RE)) {
    const code = m[0];
    if (seen.has(code)) continue;
    seen.add(code);
    out.push(code);
  }
  return out;
}

// Перші 3 речення вже написаного підрозділу — для передачі в промпт НАСТУПНИХ
// підрозділів тієї ж роботи як "уже використані початки, не повторюй". Генерація
// йде строго послідовно (runSection/doWrite), тож увесь попередній текст завжди
// вже готовий, просто досі ніде не передавався моделі: інструкція в buildSYS
// ("якщо попередні підрозділи показані тобі як контекст вище — обери інший
// стиль") була порожньою обіцянкою без реальних даних під нею. Три речення (а
// не одне) — щоб зловити не лише перше слово-гачок, а й ритм довжини речень і
// форму абзацу (теза-приклад-висновок тощо), які buildSYS також просить варіювати.
export function extractOpeningSentences(text, count = 3) {
  if (!text?.trim()) return "";
  const clean = text.trim();
  const SENT_RE = /[^.!?\n]*[.!?…]+/g;
  let lastEnd = 0, found = 0, m;
  while (found < count && (m = SENT_RE.exec(clean))) {
    lastEnd = m.index + m[0].length;
    found++;
  }
  return (lastEnd > 0 ? clean.slice(0, lastEnd) : clean.slice(0, 200)).trim();
}

// Код мови роботи за назвою з шаблону ("Англійська", "English", "Польська"…). Порядок
// перевірок збережено з попередньої версії (англійська першою — тож "українська з анотацією
// англійською" розпізнається так само, як раніше). Українська — лише явно ("укр"/"ukrain")
// або коли мову не вказано; будь-яка інша нерозпізнана мова — "other" (раніше вона мовчки
// вважалась українською й отримувала заборону латиниці та українські заголовки).
export function detectLangCode(lang) {
  const l = (lang || "").toLowerCase().trim();
  if (/англ|english/.test(l)) return "en";
  if (/польськ|polish|polsk/.test(l)) return "pl";
  if (/іспан|spanish|español|espanol/.test(l)) return "es";
  if (/нім|german|deutsch/.test(l)) return "de";
  if (/чеськ|czech|češt|česk/.test(l)) return "cs";
  if (/словацьк|slovak|slovenčin/.test(l)) return "sk";
  if (/китайськ|chinese|中文/.test(l)) return "zh";
  if (/франц|french|fran[cç]ais/.test(l)) return "fr";
  if (/італ|italian|italiano/.test(l)) return "it";
  if (!l || /укр|ukrain/.test(l)) return "uk";
  return "other";
}

// latinScript: true = мова використовує латиницю (не забороняємо її в тексті)
const LANG_PROFILES = {
  en: { intro: "INTRODUCTION",  conclusions: "CONCLUSIONS",      sources: "REFERENCES",                 chapConclLabel: n => `Conclusions to Chapter ${n}`,       chapterWord: "CHAPTER",   subsWord: "subsection",  chapterTemplate: ["CHAPTER 1. THEORETICAL FOUNDATIONS", "CHAPTER 2. ANALYSIS AND PRACTICAL PART", "CHAPTER 3. RECOMMENDATIONS AND PROPOSALS"],  tableWord: "Table",    figWord: "Fig.",   tableRef: "shown in Table",            figRef: "shown in Fig.",            forbiddenWords: "aspect, important, special, significant, key, critical, fundamental",  latinScript: true, pageAbbrev: "p.", toc: "TABLE OF CONTENTS", appendixWord: "APPENDICES", introLabels: { actuality: "Relevance of the topic.", goal: "The purpose of the study –", tasks: "Research objectives:", object: "Object of study –", subject: "Subject of study –", methods: "Research methods:", novelty: "Scientific novelty –", practical: "Practical significance:", approbation: "Approbation of results –", structure: "Structure of the work:", theoryBasis: "The theoretical basis is" }, defaultIntroComponents: ["relevance of the topic", "purpose of the study", "research objectives", "object of study", "subject of study", "research methods", "practical significance", "structure of the work"], appendixLetters: LATIN_APPENDIX_LETTERS },
  pl: { intro: "WSTĘP",         conclusions: "WNIOSKI",          sources: "BIBLIOGRAFIA",               chapConclLabel: n => `Wnioski do rozdziału ${n}`,          chapterWord: "ROZDZIAŁ",  subsWord: "podrozdział", chapterTemplate: ["ROZDZIAŁ 1. PODSTAWY TEORETYCZNE BADANIA", "ROZDZIAŁ 2. ANALIZA I CZĘŚĆ PRAKTYCZNA", "ROZDZIAŁ 3. WNIOSKI I ZALECENIA"],             tableWord: "Tabela",   figWord: "Rys.",   tableRef: "przedstawiono w Tabeli",    figRef: "pokazano na Rys.",         forbiddenWords: "aspekt, ważny, szczególny, znaczący, kluczowy, krytyczny, fundamentalny", latinScript: true, pageAbbrev: "s.", toc: "SPIS TREŚCI", appendixWord: "ZAŁĄCZNIKI", introLabels: { actuality: "Aktualność tematu.", goal: "Cel badania –", tasks: "Zadania badania:", object: "Przedmiot badania –", subject: "Obiekt badania –", methods: "Metody badania:", novelty: "Naukowa nowość badania –", practical: "Znaczenie praktyczne:", approbation: "Aprobata wyników –", structure: "Struktura pracy:", theoryBasis: "Podstawy teoretyczno-metodologiczne stanowią" }, defaultIntroComponents: ["aktualność tematu", "cel badania", "zadania badania", "przedmiot badania", "obiekt badania", "metody badania", "znaczenie praktyczne badania", "struktura pracy"], appendixLetters: LATIN_APPENDIX_LETTERS },
  es: { intro: "INTRODUCCIÓN", conclusions: "CONCLUSIONES", sources: "BIBLIOGRAFÍA",        chapConclLabel: n => `Conclusiones del capítulo ${n}`,    chapterWord: "CAPÍTULO",  subsWord: "sección",     chapterTemplate: ["CAPÍTULO 1. FUNDAMENTOS TEÓRICOS DE LA INVESTIGACIÓN", "CAPÍTULO 2. ANÁLISIS Y PARTE PRÁCTICA", "CAPÍTULO 3. RECOMENDACIONES Y PROPUESTAS"], tableWord: "Tabla",    figWord: "Fig.",   tableRef: "se muestra en la Tabla",    figRef: "se muestra en la Fig.",    forbiddenWords: "aspecto, importante, especial, significativo, clave, crítico, fundamental", latinScript: true, pageAbbrev: "p.", toc: "ÍNDICE", appendixWord: "APÉNDICES", introLabels: { actuality: "Relevancia del tema.", goal: "El objetivo del estudio –", tasks: "Tareas de investigación:", object: "Objeto de estudio –", subject: "Sujeto de estudio –", methods: "Métodos de investigación:", novelty: "Novedad científica –", practical: "Significado práctico:", approbation: "Aprobación de resultados –", structure: "Estructura del trabajo:", theoryBasis: "La base teórico-metodológica es" }, defaultIntroComponents: ["relevancia del tema", "objetivo del estudio", "tareas de investigación", "objeto de estudio", "sujeto de estudio", "métodos de investigación", "significado práctico", "estructura del trabajo"], appendixLetters: LATIN_APPENDIX_LETTERS },
  de: { intro: "EINLEITUNG",   conclusions: "SCHLUSSFOLGERUNGEN", sources: "LITERATURVERZEICHNIS",     chapConclLabel: n => `Schlussfolgerungen zu Kapitel ${n}`, chapterWord: "KAPITEL",   subsWord: "Unterkapitel",chapterTemplate: ["KAPITEL 1. THEORETISCHE GRUNDLAGEN DER UNTERSUCHUNG", "KAPITEL 2. ANALYSE UND PRAKTISCHER TEIL", "KAPITEL 3. EMPFEHLUNGEN UND VORSCHLÄGE"],       tableWord: "Tabelle",  figWord: "Abb.",   tableRef: "in Tabelle dargestellt",    figRef: "in Abb. gezeigt",          forbiddenWords: "Aspekt, wichtig, besonders, bedeutend, entscheidend, kritisch, grundlegend", latinScript: true, pageAbbrev: "S.", toc: "INHALTSVERZEICHNIS", appendixWord: "ANHÄNGE", introLabels: { actuality: "Relevanz des Themas.", goal: "Das Ziel der Arbeit –", tasks: "Forschungsaufgaben:", object: "Untersuchungsobjekt –", subject: "Untersuchungsgegenstand –", methods: "Forschungsmethoden:", novelty: "Wissenschaftliche Neuheit –", practical: "Praktische Bedeutung:", approbation: "Approbation der Ergebnisse –", structure: "Struktur der Arbeit:", theoryBasis: "Die theoretisch-methodologische Grundlage bilden" }, defaultIntroComponents: ["Relevanz des Themas", "Ziel der Arbeit", "Forschungsaufgaben", "Untersuchungsobjekt", "Untersuchungsgegenstand", "Forschungsmethoden", "Praktische Bedeutung", "Struktur der Arbeit"], appendixLetters: LATIN_APPENDIX_LETTERS },
  cs: { intro: "ÚVOD",          conclusions: "ZÁVĚR",            sources: "SEZNAM POUŽITÉ LITERATURY",  chapConclLabel: n => `Závěry ke kapitole ${n}`,           chapterWord: "KAPITOLA",  subsWord: "podkapitola", chapterTemplate: ["KAPITOLA 1. TEORETICKÉ ZÁKLADY VÝZKUMU", "KAPITOLA 2. ANALÝZA A PRAKTICKÁ ČÁST", "KAPITOLA 3. DOPORUČENÍ A NÁVRHY"],                     tableWord: "Tabulka",  figWord: "Obr.",   tableRef: "uvedeno v Tabulce",         figRef: "znázorněno na Obr.",       forbiddenWords: "aspekt, důležitý, zvláštní, významný, klíčový, kritický, základní", latinScript: true, pageAbbrev: "s.", toc: "OBSAH", appendixWord: "PŘÍLOHY", introLabels: { actuality: "Aktuálnost tématu.", goal: "Cíl práce –", tasks: "Úkoly výzkumu:", object: "Objekt výzkumu –", subject: "Předmět výzkumu –", methods: "Výzkumné metody:", novelty: "Vědecká novost –", practical: "Praktický přínos:", approbation: "Aprobace výsledků –", structure: "Struktura práce:", theoryBasis: "Teoreticko-metodologickým základem je" }, defaultIntroComponents: ["aktuálnost tématu", "cíl práce", "úkoly výzkumu", "objekt výzkumu", "předmět výzkumu", "výzkumné metody", "praktický přínos", "struktura práce"], appendixLetters: LATIN_APPENDIX_LETTERS },
  sk: { intro: "ÚVOD",          conclusions: "ZÁVER",            sources: "ZOZNAM POUŽITEJ LITERATÚRY", chapConclLabel: n => `Závery ku kapitole ${n}`,           chapterWord: "KAPITOLA",  subsWord: "podkapitola", chapterTemplate: ["KAPITOLA 1. TEORETICKÉ ZÁKLADY VÝSKUMU", "KAPITOLA 2. ANALÝZA A PRAKTICKÁ ČASŤ", "KAPITOLA 3. ODPORÚČANIA A NÁVRHY"],                   tableWord: "Tabuľka",  figWord: "Obr.",   tableRef: "uvedené v Tabuľke",         figRef: "znázornené na Obr.",       forbiddenWords: "aspekt, dôležitý, špeciálny, významný, kľúčový, kritický, základný", latinScript: true, pageAbbrev: "s.", toc: "OBSAH", appendixWord: "PRÍLOHY", introLabels: { actuality: "Aktuálnosť témy.", goal: "Cieľ práce –", tasks: "Úlohy výskumu:", object: "Objekt výskumu –", subject: "Predmet výskumu –", methods: "Výskumné metódy:", novelty: "Vedecká novosť –", practical: "Praktický prínos:", approbation: "Aprobácia výsledkov –", structure: "Štruktúra práce:", theoryBasis: "Teoreticko-metodologickým základom je" }, defaultIntroComponents: ["aktuálnosť témy", "cieľ práce", "úlohy výskumu", "objekt výskumu", "predmet výskumu", "výskumné metódy", "praktický prínos", "štruktúra práce"], appendixLetters: LATIN_APPENDIX_LETTERS },
  zh: { intro: "引言",      conclusions: "结论",             sources: "参考文献",                    chapConclLabel: n => `第${n}章结论`,                      chapterWord: "第",        subsWord: "小节",        chapterTemplate: ["第1章. 研究的理论基础", "第2章. 分析与实践部分", "第3章. 建议与对策"],                                                                              tableWord: "表",       figWord: "图",     tableRef: "如表所示",                  figRef: "如图所示",                 forbiddenWords: "方面, 重要, 特殊, 显著, 关键, 批判, 基本", latinScript: false, pageAbbrev: "页", toc: "目录", appendixWord: "附录", introLabels: { actuality: "选题意义：", goal: "研究目的：", tasks: "研究任务：", object: "研究对象：", subject: "研究主题：", methods: "研究方法：", novelty: "科学新颖性：", practical: "实践意义：", approbation: "成果鉴定：", structure: "论文结构：", theoryBasis: "理论方法论基础为" }, defaultIntroComponents: ["选题意义", "研究目的", "研究任务", "研究对象", "研究主题", "研究方法", "实践意义", "论文结构"], appendixLetters: LATIN_APPENDIX_LETTERS },
  fr: { intro: "INTRODUCTION", conclusions: "CONCLUSION", sources: "BIBLIOGRAPHIE", chapConclLabel: n => `Conclusions du chapitre ${n}`, chapterWord: "CHAPITRE", subsWord: "sous-section", chapterTemplate: ["CHAPITRE 1. FONDEMENTS THÉORIQUES DE LA RECHERCHE", "CHAPITRE 2. ANALYSE ET PARTIE PRATIQUE", "CHAPITRE 3. RECOMMANDATIONS ET PROPOSITIONS"], tableWord: "Tableau", figWord: "Fig.", tableRef: "présenté dans le Tableau", figRef: "illustré à la Fig.", forbiddenWords: "aspect, important, spécial, significatif, clé, critique, fondamental", latinScript: true, pageAbbrev: "p.", toc: "TABLE DES MATIÈRES", appendixWord: "ANNEXES", introLabels: { actuality: "Actualité du sujet.", goal: "L'objectif de la recherche –", tasks: "Tâches de la recherche :", object: "Objet de la recherche –", subject: "Sujet de la recherche –", methods: "Méthodes de recherche :", novelty: "Nouveauté scientifique –", practical: "Portée pratique :", approbation: "Approbation des résultats –", structure: "Structure du travail :", theoryBasis: "La base théorique et méthodologique est constituée par" }, defaultIntroComponents: ["actualité du sujet", "objectif de la recherche", "tâches de la recherche", "objet de la recherche", "sujet de la recherche", "méthodes de recherche", "portée pratique", "structure du travail"], appendixLetters: LATIN_APPENDIX_LETTERS },
  it: { intro: "INTRODUZIONE", conclusions: "CONCLUSIONI", sources: "BIBLIOGRAFIA", chapConclLabel: n => `Conclusioni del capitolo ${n}`, chapterWord: "CAPITOLO", subsWord: "paragrafo", chapterTemplate: ["CAPITOLO 1. FONDAMENTI TEORICI DELLA RICERCA", "CAPITOLO 2. ANALISI E PARTE PRATICA", "CAPITOLO 3. RACCOMANDAZIONI E PROPOSTE"], tableWord: "Tabella", figWord: "Fig.", tableRef: "riportato nella Tabella", figRef: "mostrato nella Fig.", forbiddenWords: "aspetto, importante, speciale, significativo, chiave, critico, fondamentale", latinScript: true, pageAbbrev: "p.", toc: "INDICE", appendixWord: "APPENDICI", introLabels: { actuality: "Attualità del tema.", goal: "L'obiettivo della ricerca –", tasks: "Compiti della ricerca:", object: "Oggetto della ricerca –", subject: "Ambito della ricerca –", methods: "Metodi di ricerca:", novelty: "Novità scientifica –", practical: "Rilevanza pratica:", approbation: "Approvazione dei risultati –", structure: "Struttura del lavoro:", theoryBasis: "La base teorico-metodologica è costituita da" }, defaultIntroComponents: ["attualità del tema", "obiettivo della ricerca", "compiti della ricerca", "oggetto della ricerca", "ambito della ricerca", "metodi di ricerca", "rilevanza pratica", "struttura del lavoro"], appendixLetters: LATIN_APPENDIX_LETTERS },
  uk: { intro: "ВСТУП", conclusions: "ВИСНОВКИ", sources: "СПИСОК ВИКОРИСТАНИХ ДЖЕРЕЛ", chapConclLabel: n => `Висновки до розділу ${n}`, chapterWord: "РОЗДІЛ", subsWord: "підрозділ", chapterTemplate: ["РОЗДІЛ 1. ТЕОРЕТИЧНІ ОСНОВИ ДОСЛІДЖЕННЯ", "РОЗДІЛ 2. АНАЛІЗ ТА ПРАКТИЧНА ЧАСТИНА", "РОЗДІЛ 3. РЕКОМЕНДАЦІЇ ТА ПРОПОЗИЦІЇ"], tableWord: "Таблиця", figWord: "Рис.", tableRef: "наведено в Таблиці", figRef: "показано на Рис.", forbiddenWords: "аспект, важливий, особливий, значущий, ключовий, критичний, фундаментальний", latinScript: false, pageAbbrev: "с.", toc: "ЗМІСТ", appendixWord: "ДОДАТКИ", introLabels: { actuality: "Актуальність теми.", goal: "Мета дослідження –", tasks: "Завдання дослідження:", object: "Об'єкт дослідження –", subject: "Предмет дослідження –", methods: "Методи дослідження:", novelty: "Наукова новизна дослідження –", practical: "Практична значущість:", approbation: "Апробація результатів дослідження –", structure: "Структура роботи:", theoryBasis: "Теоретико-методологічну основу дослідження становлять" }, defaultIntroComponents: ["актуальність теми", "мета дослідження", "завдання дослідження", "об'єкт дослідження", "предмет дослідження", "методи дослідження", "практичне значення дослідження", "структура роботи"], appendixLetters: UKRAINIAN_APPENDIX_LETTERS },
};

// Додаткові мовні дані поверх основного профілю: мова правопису Word, пара лапок (null —
// лапки моделі не чіпаємо), однинна позначка додатка, підписи анотації/ключових слів статті
// й заглушки авторського блоку, підпис наукового керівника (тези), назва емпіричного розділу, підписи креслень і лістингів коду,
// чи позначає мова рід автора в першій особі (дієслово минулого часу / прикметник — "я
// зрозумів/зрозуміла", "zrozumiałem/zrozumiałam", "estoy convencido/convencida"), мова й
// країна пошуку Google Images.
const LANG_EXTRAS = {
  en: { wordCode: "en-US", quotes: ["\u201C", "\u201D"], supervisorLabel: "Scientific supervisor", appendixSingular: "APPENDIX", abstractWord: "Abstract", keywordsWord: "Keywords", authorPlaceholder: "[Author's name]", universityPlaceholder: "[University]", udc: "UDC", empiricalChapter: "EMPIRICAL RESEARCH", drawingWord: "Drawing", listingWord: "Listing", sourceCodeTitle: "Program source code", genderedFirstPerson: false, searchLocale: { hl: "en", gl: "us" } },
  pl: { wordCode: "pl-PL", quotes: ["\u201E", "\u201D"], supervisorLabel: "Opiekun naukowy", appendixSingular: "ZAŁĄCZNIK", abstractWord: "Streszczenie", keywordsWord: "Słowa kluczowe", authorPlaceholder: "[Imię i nazwisko autora]", universityPlaceholder: "[Uczelnia]", udc: "UKD", empiricalChapter: "BADANIA EMPIRYCZNE", drawingWord: "Rysunek techniczny", listingWord: "Listing", sourceCodeTitle: "Kod źródłowy programu", genderedFirstPerson: true, searchLocale: { hl: "pl", gl: "pl" } },
  es: { wordCode: "es-ES", quotes: ["\u00AB", "\u00BB"], supervisorLabel: "Director científico", appendixSingular: "APÉNDICE", abstractWord: "Resumen", keywordsWord: "Palabras clave", authorPlaceholder: "[Nombre del autor]", universityPlaceholder: "[Universidad]", udc: "CDU", empiricalChapter: "INVESTIGACIÓN EMPÍRICA", drawingWord: "Plano", listingWord: "Listado", sourceCodeTitle: "Código fuente del programa", genderedFirstPerson: true, searchLocale: { hl: "es", gl: "es" } },
  de: { wordCode: "de-DE", quotes: ["\u201E", "\u201C"], supervisorLabel: "Wissenschaftlicher Betreuer", appendixSingular: "ANHANG", abstractWord: "Zusammenfassung", keywordsWord: "Schlüsselwörter", authorPlaceholder: "[Name des Autors]", universityPlaceholder: "[Universität]", udc: "DK", empiricalChapter: "EMPIRISCHE UNTERSUCHUNG", drawingWord: "Zeichnung", listingWord: "Listing", sourceCodeTitle: "Quellcode des Programms", genderedFirstPerson: false, searchLocale: { hl: "de", gl: "de" } },
  cs: { wordCode: "cs-CZ", quotes: ["\u201E", "\u201C"], supervisorLabel: "Vedoucí práce", appendixSingular: "PŘÍLOHA", abstractWord: "Abstrakt", keywordsWord: "Klíčová slova", authorPlaceholder: "[Jméno autora]", universityPlaceholder: "[Univerzita]", udc: "MDT", empiricalChapter: "EMPIRICKÝ VÝZKUM", drawingWord: "Výkres", listingWord: "Výpis", sourceCodeTitle: "Zdrojový kód programu", genderedFirstPerson: true, searchLocale: { hl: "cs", gl: "cz" } },
  sk: { wordCode: "sk-SK", quotes: ["\u201E", "\u201C"], supervisorLabel: "Vedúci práce", appendixSingular: "PRÍLOHA", abstractWord: "Abstrakt", keywordsWord: "Kľúčové slová", authorPlaceholder: "[Meno autora]", universityPlaceholder: "[Univerzita]", udc: "MDT", empiricalChapter: "EMPIRICKÝ VÝSKUM", drawingWord: "Výkres", listingWord: "Výpis", sourceCodeTitle: "Zdrojový kód programu", genderedFirstPerson: true, searchLocale: { hl: "sk", gl: "sk" } },
  zh: { wordCode: "zh-CN", quotes: ["\u201C", "\u201D"], supervisorLabel: "指导教师", appendixSingular: "附录", abstractWord: "摘要", keywordsWord: "关键词", authorPlaceholder: "[作者姓名]", universityPlaceholder: "[大学]", udc: "UDC", empiricalChapter: "实证研究", drawingWord: "图纸", listingWord: "代码清单", sourceCodeTitle: "程序源代码", genderedFirstPerson: false, searchLocale: { hl: "zh-CN", gl: "cn" } },
  fr: { wordCode: "fr-FR", quotes: ["\u00AB\u00A0", "\u00A0\u00BB"], supervisorLabel: "Directeur de recherche", appendixSingular: "ANNEXE", abstractWord: "Résumé", keywordsWord: "Mots-clés", authorPlaceholder: "[Nom de l'auteur]", universityPlaceholder: "[Université]", udc: "CDU", empiricalChapter: "RECHERCHE EMPIRIQUE", drawingWord: "Dessin technique", listingWord: "Listing", sourceCodeTitle: "Code source du programme", genderedFirstPerson: true, searchLocale: { hl: "fr", gl: "fr" } },
  it: { wordCode: "it-IT", quotes: ["\u00AB", "\u00BB"], supervisorLabel: "Relatore", appendixSingular: "APPENDICE", abstractWord: "Riassunto", keywordsWord: "Parole chiave", authorPlaceholder: "[Nome dell'autore]", universityPlaceholder: "[Università]", udc: "CDU", empiricalChapter: "RICERCA EMPIRICA", drawingWord: "Disegno tecnico", listingWord: "Listato", sourceCodeTitle: "Codice sorgente del programma", genderedFirstPerson: true, searchLocale: { hl: "it", gl: "it" } },
  uk: { wordCode: "uk-UA", quotes: ["\u00AB", "\u00BB"], supervisorLabel: "Науковий керівник", appendixSingular: "ДОДАТОК", abstractWord: "Анотація", keywordsWord: "Ключові слова", authorPlaceholder: "[ПІБ автора]", universityPlaceholder: "[Університет]", udc: "УДК", empiricalChapter: "ЕМПІРИЧНЕ ДОСЛІДЖЕННЯ", drawingWord: "Креслення", listingWord: "Лістинг", sourceCodeTitle: "Вихідний код програми", genderedFirstPerson: true, searchLocale: { hl: "uk", gl: "ua" } },
};

// Нерозпізнана мова (не з таблиць вище): структурні підписи — англійською як нейтральний
// варіант (назви плану ШІ все одно пише мовою роботи), латиниця дозволена, лапки моделі не
// чіпаємо, правопис Word — за фактичним текстом (detectTextLanguage).
const OTHER_PROFILE = { ...LANG_PROFILES.en, ...LANG_EXTRAS.en, quotes: null, genderedFirstPerson: true };

// ── Мови поза таблицею: набір, складений ШІ (ensureLangProfile, langProfile.js) ──
// Набір один раз на замовлення складає ШІ, він зберігається в замовленні (info.langProfile)
// і реєструється тут: у воркері — при кожному завантаженні замовлення (loadOrder), у
// браузері — при завантаженні й зміні мови. Після реєстрації getLangLabels повертає його
// так само синхронно, як вбудовані мови, і далі все працює кодом.
const DYNAMIC_PROFILES = new Map();
// ("\b" не бачить меж кириличних слів — тому явний пробіл/кінець рядка)
export const normLangName = (s) => String(s || "").toLowerCase().replace(/\s+мова(?=\s|$)/g, "").replace(/\s+/g, " ").trim();

const LANG_PROFILE_STRING_FIELDS = [
  "intro", "conclusions", "sources", "subsWord", "tableWord", "figWord", "tableRef", "figRef", "pageAbbrev", "toc",
  "appendixWord", "appendixSingular", "supervisorLabel", "abstractWord", "keywordsWord", "authorPlaceholder",
  "universityPlaceholder", "udc", "empiricalChapter", "drawingWord", "listingWord", "sourceCodeTitle",
];

// Сирий набір від ШІ → збережуваний профіль (лише JSON, без функцій). Кожне поле
// перевіряється; чого бракує чи що має неправильну форму — береться з англійського набору.
export function sanitizeLangProfile(raw, language) {
  if (!raw || typeof raw !== "object") return null;
  const base = { ...LANG_PROFILES.en, ...LANG_EXTRAS.en };
  const str = (v, max = 120) => (typeof v === "string" && v.trim() && v.trim().length <= max ? v.trim() : null);
  const out = { forLanguage: String(language || "") };
  for (const k of LANG_PROFILE_STRING_FIELDS) out[k] = str(raw[k]) || base[k];
  out.forbiddenWords = str(raw.forbiddenWords, 300) || base.forbiddenWords;
  out.iso = typeof raw.iso === "string" && /^[a-z]{2}$/.test(raw.iso) ? raw.iso : null;
  out.wordCode = typeof raw.wordCode === "string" && /^[a-z]{2,3}-[A-Z]{2}$/.test(raw.wordCode) ? raw.wordCode : base.wordCode;
  out.latinScript = typeof raw.latinScript === "boolean" ? raw.latinScript : true;
  out.genderedFirstPerson = typeof raw.genderedFirstPerson === "boolean" ? raw.genderedFirstPerson : true;
  // "CAPITOLUL {n}" або "{n}. FEJEZET": рівно один {n} і хоч одна літера
  const cp = str(raw.chapterPattern, 40);
  out.chapterPattern = cp && (cp.match(/\{n\}/g) || []).length === 1 && /\p{L}/u.test(cp) ? cp.toUpperCase().replace("{N}", "{n}") : "CHAPTER {n}";
  out.chapterWord = out.chapterPattern.replace("{n}", "").replace(/[.\s]+/g, " ").trim();
  const titles = Array.isArray(raw.chapterTitles) ? raw.chapterTitles.map(t => str(t)) : [];
  const defaultTitles = LANG_PROFILES.en.chapterTemplate.map(t => t.split(". ").slice(1).join(". "));
  out.chapterTitles = [0, 1, 2].map(i => titles[i] || defaultTitles[i]);
  const cc = str(raw.chapterConclusion, 80);
  out.chapterConclusion = cc && cc.includes("{n}") ? cc : "Conclusions to Chapter {n}";
  const il = raw.introLabels && typeof raw.introLabels === "object" ? raw.introLabels : {};
  out.introLabels = Object.fromEntries(Object.keys(base.introLabels).map(k => [k, str(il[k]) || base.introLabels[k]]));
  const dic = Array.isArray(raw.defaultIntroComponents) ? raw.defaultIntroComponents.map(t => str(t)).filter(Boolean) : [];
  out.defaultIntroComponents = dic.length >= 5 ? dic.slice(0, 10) : base.defaultIntroComponents;
  out.quotes = Array.isArray(raw.quotes) && raw.quotes.length === 2 && raw.quotes.every(x => typeof x === "string" && x.length >= 1 && x.length <= 3) ? raw.quotes : null;
  const letters = Array.isArray(raw.appendixLetters) ? raw.appendixLetters.filter(x => typeof x === "string" && /^\p{Lu}$/u.test(x)) : [];
  out.appendixLetters = !out.latinScript && letters.length >= 10 ? letters : LATIN_APPENDIX_LETTERS;
  const sl = raw.searchLocale && typeof raw.searchLocale === "object" ? raw.searchLocale : {};
  out.searchLocale = {
    hl: typeof sl.hl === "string" && /^[a-z]{2}(-[A-Z]{2})?$/.test(sl.hl) ? sl.hl : (out.iso || "en"),
    gl: typeof sl.gl === "string" && /^[a-z]{2}$/.test(sl.gl) ? sl.gl : "us",
  };
  return out;
}

// Чи вже є в info набір саме для поточної мови (а не для мови, яку потім змінили вручну)
export function hasLangProfileFor(info) {
  return !!(info?.langProfile && normLangName(info.langProfile.forLanguage) === normLangName(info?.language));
}

// Реєструє збережений набір мови замовлення; повертає true, якщо зареєстровано
export function registerLangProfile(info) {
  if (!info?.language || detectLangCode(info.language) !== "other" || !hasLangProfileFor(info)) return false;
  DYNAMIC_PROFILES.set(normLangName(info.language), info.langProfile);
  return true;
}

function dynamicLabels(lp) {
  const prefix = (n) => lp.chapterPattern.replace("{n}", String(n));
  return {
    ...lp,
    dynamic: true,
    chapterTemplate: lp.chapterTitles.map((t, i) => `${prefix(i + 1)}. ${t}`),
    chapConclLabel: (n) => lp.chapterConclusion.replace("{n}", String(n)),
  };
}

export function getLangLabels(lang = "Українська") {
  const code = detectLangCode(lang);
  if (code === "other") {
    const lp = DYNAMIC_PROFILES.get(normLangName(lang));
    return lp ? { code, ...OTHER_PROFILE, ...dynamicLabels(lp) } : { code, ...OTHER_PROFILE };
  }
  return { code, ...LANG_PROFILES[code], ...LANG_EXTRAS[code] };
}

// Заголовок списку джерел звичайним регістром ("Список використаних джерел", "References",
// "Bibliografia") — для блоку джерел у тезах/статтях/есе й слайда джерел презентації.
export function sourcesHeading(lang) {
  const s = getLangLabels(lang).sources;
  return s.charAt(0) + s.slice(1).toLowerCase();
}

// Будь-який заголовок списку джерел (усі мови роботи, зокрема з набору ШІ, + поширені
// варіанти) — альтернативи для RegExp з прапорцем "i": розбір тексту, згенерованого раніше
// чи іншою мовою, ніж зараз.
export function sourcesHeadingAlt() {
  return [...new Set([
    ...Object.values(LANG_PROFILES).map(p => p.sources),
    ...[...DYNAMIC_PROFILES.values()].map(lp => lp.sources),
    "Список літератури", "Використані джерела", "References", "Bibliography", "Works cited",
  ])].map(escRe).join("|");
}

// Множинні заголовки ("ДОДАТКИ") й однинні позначки ("ДОДАТОК") додатків мов з набору ШІ —
// для розборів тексту, де вбудовані мови перелічено в самій регулярці (citationFormatting.js)
export function dynamicAppendixWords() {
  return [...DYNAMIC_PROFILES.values()].flatMap(lp => [lp.appendixWord, lp.appendixSingular]).map(escRe);
}

// Блок джерел у кінці тексту тез/статті/есе: як і раніше, "Список використаних джерел…" з
// будь-яким хвостом рядка; заголовок іншою мовою — лише як цілий рядок (з необов'язковими
// "(стиль)" і двокрапкою), щоб абзац на кшталт "References to …" не обрізав текст.
export function matchSourcesBlock(text) {
  return text.match(/\n\s*Список використаних джерел[^\n]*\n([\s\S]*)$/i)
    || text.match(new RegExp(`\\n\\s*(?:${sourcesHeadingAlt()})\\s*(?:\\([^)\\n]*\\))?\\s*[:.]?\\s*\\n([\\s\\S]*)$`, "i"));
}

// Заголовок слайда/рядка зі списком джерел будь-якою мовою роботи
export function isSourcesTitle(title) {
  return /Список використаних джерел/i.test(title) || new RegExp(`^\\s*(?:${sourcesHeadingAlt()})`, "i").test(title);
}

// "РОЗДІЛ 2" / "CHAPTER 2" / "第2章" / "2. FEJEZET" — префікс заголовка розділу мовою роботи:
// за шаблоном із набору ШІ (chapterPattern) або за chapterTemplate вбудованої мови (у
// китайській номер стоїть усередині слова, тож не "chapterWord + n").
export function chapterHeadingPrefix(lang, n) {
  const L = getLangLabels(lang);
  if (L.chapterPattern) return L.chapterPattern.replace("{n}", String(n));
  return L.chapterTemplate[0].split(". ")[0].replace(/\d+/, String(n));
}

export const FIELD_LABELS = {
  type: "Тип роботи", course: "Курс", pages: "К-сть сторінок", topic: "Тема роботи",
  subject: "Тематика / предмет", direction: "Галузь / напрям", uniqueness: "Унікальність",
  language: "Мова роботи", deadline: "Дедлайн", extras: "Додаткові матеріали",
  methodNotes: "Вимоги методички",
};

// Визначає чи є робота з психології або педагогіки
export const isPsychoPed = (info) => {
  if (info?.workCategory === "Гуманітарне") {
    const dir = ((info?.direction || "") + " " + (info?.subject || "")).toLowerCase();
    return /психол|педагог/.test(dir);
  }
  if (info?.workCategory && info.workCategory !== "Гуманітарне") return false;
  const dir = ((info?.direction || "") + " " + (info?.subject || "")).toLowerCase();
  return /психол|педагог/.test(dir);
};

// Визначає чи є робота економічного спрямування
export const isEcon = (info) => {
  if (info?.workCategory === "Економічне") return true;
  if (info?.workCategory && info.workCategory !== "Економічне") return false;
  const dir = ((info?.direction || "") + " " + (info?.subject || "")).toLowerCase();
  return /економ|фінанс|менедж|облік|маркет|бізнес|бухгалт|аудит|логіст|підприємн|публічн.*управл|держ.*управл/.test(dir);
};

// Визначає чи є робота технічної спеціальності (інженерія/будівництво/IT/кібербезпека)
export const isTechnical = (info) => {
  if (info?.workCategory === "Технічне") return true;
  if (info?.workCategory && info.workCategory !== "Технічне") return false;
  const dir = ((info?.direction || "") + " " + (info?.subject || "")).toLowerCase();
  return /техн|інформ|програм|комп|it\b|кібер|електр|машин|буд|архіт/.test(dir);
};

// Мовна квота джерел підрозділу. Українська робота — як і раніше: зарубіжних не більше 30%
// (технічна — 50%, якісних укр. джерел по вузьких IT-темах мало). Робота іншою мовою — навпаки:
// українських не більше 30%, решта зарубіжні (рішення від 03.10.2026: англомовний текст на 70%
// з кириличних джерел виглядав дивно). maxUk/maxForeign = Infinity — без обмеження.
export function sourceLangQuota(lang, technical, needed) {
  if (getLangLabels(lang).code !== "uk") {
    return { foreignWork: true, maxUk: Math.max(1, Math.round(needed * 0.3)), maxForeign: Infinity };
  }
  return { foreignWork: false, maxUk: Infinity, maxForeign: Math.max(1, Math.round(needed * (technical ? 0.5 : 0.3))) };
}

// Код мови для пошуку джерел МОВОЮ РОБОТИ (OpenAlex language:<code> за фразами localPhrases) —
// лише для неукраїнської й неанглійської роботи: англійська шукається англомовними фразами
// (enPhrases), українська — основним пошуком. Перевірено на OpenAlex: фраза рідною мовою дає
// в 5–30 разів більше й точніших збігів, ніж англійська фраза з тим самим фільтром мови.
// Мова з набору ШІ — за її кодом ISO 639-1 (крім російської й білоруської: такі джерела заборонені).
const LOCAL_SOURCE_LANGS = ["pl", "de", "es", "cs", "sk", "zh", "fr", "it"];
export function localSourceLangCode(lang) {
  const L = getLangLabels(lang);
  if (LOCAL_SOURCE_LANGS.includes(L.code)) return L.code;
  return L.dynamic && L.iso && !["uk", "en", "ru", "be"].includes(L.iso) ? L.iso : null;
}

// Визначає чи є в роботі емпіричне дослідження (з коментаря або методички)
export const hasEmpiricalResearch = (commentAnalysis, methodInfo) => {
  if (commentAnalysis?.researchDesign) return true;
  if (commentAnalysis?.empiricalHints) return true; // fallback для старих замовлень
  if (!methodInfo) return false;
  return /анкет|опитуванн|емпіричн|респондент|вибірк|тест|експеримент|методик/i.test(
    [methodInfo.analysisRequirements, methodInfo.otherRequirements, methodInfo.theoryRequirements].filter(Boolean).join(" ")
  );
};

// Визначає підрозділи що мають отримати інструкції емпіричного дослідження
export const getEmpiricalSections = (sections, info, commentAnalysis, methodInfo) => {
  const empty = { anchorId: null, chapterSectionIds: [] };
  if (!isPsychoPed(info) && !hasEmpiricalResearch(commentAnalysis, methodInfo)) return empty;

  const mainSecs = sections.filter(s => !["intro", "conclusions", "sources", "chapter_conclusion"].includes(s.type));
  const empiricalRe = /дослідженн|емпіричн|анкетуванн|практичн.*дослідж|вибірк|результат.*дослідж/i;

  // Варіант 2: є підрозділи з ключовими словами → беремо весь їх розділ
  const matchingChapNums = new Set(
    mainSecs
      .filter(s => empiricalRe.test(s.label) || empiricalRe.test(s.sectionTitle || ""))
      .map(s => s.id.split(".")[0])
  );
  if (matchingChapNums.size > 0) {
    const ids = mainSecs
      .filter(s => matchingChapNums.has(s.id.split(".")[0]))
      .map(s => s.id);
    return { anchorId: null, chapterSectionIds: ids };
  }

  // Варіант 1: ключових слів у назвах немає — anchor лише якщо є реальні ознаки емпіричного дослідження
  // (не просто "педагогічна робота" — без коментаря/методички, що підтверджує анкетування/опитування)
  if (!hasEmpiricalResearch(commentAnalysis, methodInfo)) return empty;
  const practicalSecs = mainSecs.filter(s => ["analysis", "recommendations"].includes(s.type));
  if (!practicalSecs.length) return empty;
  const softRe = /практичн|аналіз|результат|застосуванн/i;
  const best = practicalSecs.find(s => softRe.test(s.label)) || practicalSecs[practicalSecs.length - 1];
  return { anchorId: best.id, chapterSectionIds: [] };
};

// Повертає id підрозділів економічної роботи що мають містити таблиці/розрахунки
export const getEconSections = (sections, info) => {
  if (!isEcon(info)) return [];
  const typed = sections.filter(s => ["analysis", "recommendations"].includes(s.type));
  if (typed.length) return typed.map(s => s.id);
  // Звіт з практики: секціям НІКОЛИ не присвоюється .type (на відміну від курсової/дипломної,
  // де це робить buildPracticePlanPrompt/orderStages), тож без цього фолбека getEconSections
  // завжди повертає [] для практики, навіть коли напрям явно економічний — і добір
  // "інституційних" джерел для економічних розділів практики просто ніколи не спрацьовує.
  // Якщо типів немає ЖОДНОГО (а не просто немає analysis/recommendations серед наявних) —
  // це і є ознака такого звіту без типізації; тоді до "економічних" відносимо всі змістовні
  // розділи, крім фіксованих вступу/висновків/джерел.
  const hasAnyType = sections.some(s => s.type);
  if (hasAnyType) return [];
  return sections
    .filter(s => !["intro", "conclusions", "sources", "chapter_conclusion"].includes(s.id))
    .map(s => s.id);
};

// Повертає id підрозділів технічної роботи що мають містити розрахунки/формули/код
export const getTechnicalSections = (sections, info) => {
  if (!isTechnical(info)) return [];
  return sections
    .filter(s => ["analysis", "recommendations"].includes(s.type))
    .map(s => s.id);
};

export const STAGES_SOURCES_FIRST = ["Дані", "Перевірка", "План", "Джерела", "Написання", "Готово", "Чек-лист"];
export const STAGE_KEYS_SOURCES_FIRST = ["input", "parsed", "plan", "sources", "writing", "done", "checklist"];

export const STAGES     = STAGES_SOURCES_FIRST;
export const STAGE_KEYS = STAGE_KEYS_SOURCES_FIRST;

// Статуси для Firestore
export const ORDER_STATUS = {
  input: "new",
  parsed: "new",
  plan: "plan_ready",
  writing: "writing",
  sources: "writing",
  done: "done",
  checklist: "done",
};

// Дефолт 80 — для великих академічних робіт (курсова, дипломна). Мала версія в shared.jsx має дефолт 20.
export function parsePagesAvg(str) {
  if (!str) return 80;
  const s = String(str);
  const nums = s.match(/\d+/g);
  if (!nums) return 80;
  const avg = nums.length === 1 ? parseInt(nums[0]) : Math.round(nums.reduce((a, b) => a + parseInt(b), 0) / nums.length);
  // Якщо поруч із числом вказано "слів"/"слова"/"words" — це обсяг у словах, конвертуємо в сторінки (~230 слів/стор.)
  if (/слів|слова|слово|words?\b/i.test(s)) return Math.max(1, Math.round(avg / 230));
  return avg;
}

// Верхня межа діапазону сторінок ("65-85" → 85). Використовується як стеля
// для фінальної перевірки фактичного обсягу згенерованої роботи.
export function parsePagesMax(str) {
  if (!str) return null;
  const s = String(str);
  const nums = s.match(/\d+/g);
  if (!nums) return null;
  const max = Math.max(...nums.map(n => parseInt(n, 10)));
  if (/слів|слова|слово|words?\b/i.test(s)) return Math.max(1, Math.round(max / 230));
  return max;
}

// Явно вказаний клієнтом чи кафедрою обсяг вступу/висновків (у сторінках) для звіту
// з практики — регексом з вільного тексту (даних практики, вимог кафедри), без
// виклику ШІ. За відсутності явної вказівки — стандартний обсяг 2 сторінки для
// кожного (типовий для звітів з практики, на відміну від курсових/дипломних).
export function resolvePracticeFixedPages(practiceText, deptGuidanceText) {
  const combined = `${practiceText || ""} ${deptGuidanceText || ""}`;
  const extract = (keywordRe) => {
    const m = combined.match(keywordRe);
    return m ? parseInt(m[1], 10) : null;
  };
  const introPages = extract(/вступ[^.\d]{0,20}(\d+)\s*стор/i) || 2;
  const conclPages = extract(/висновк[^.\d]{0,20}(\d+)\s*стор/i) || 2;
  return { introPages, conclPages };
}

// Методичка часто зберігає зразки титулки/завдання у ВЛАСНИХ додатках
// ("ДОДАТОК В", "ДОДАТОК Г" тощо) — цей ярлик належить нумерації додатків
// методички, а не сторінці студентської роботи (де титулка й завдання —
// обов'язкові структурні елементи без жодного "Додаток"-заголовка). AI іноді
// копіює цей рядок разом із самим зразком; прибираємо його детерміновано.
export function stripLeadingAppendixLabel(templateArr) {
  if (!Array.isArray(templateArr) || !templateArr.length) return templateArr;
  let i = 0;
  while (i < templateArr.length) {
    const line = (templateArr[i]?.text || "").trim();
    if (/^ДОДАТ(ОК\s+[А-ЯA-Z]\.?|КИ)$/i.test(line)) i++;
    else break;
  }
  return i ? templateArr.slice(i) : templateArr;
}

export function parseTemplate(text) {
  const g = (re, fb = "") => { const m = text.match(re); return m ? m[1].trim() : fb; };
  return {
    orderNumber: g(/№\s*замовлення\s*[-–—:]\s*(\S+)/i),
    type: g(/Тип\s*[-–:]\s*(.+?)(?=\n|⏰|📌|✈️|⚙️|⚡|$)/i),
    deadline: g(/Дедлайн\s*[-–:]\s*(.+?)(?=\n|⚡|📌|✈️|⚙️|$)/i),
    direction: g(/Напрям\s*[-–:]\s*(.+?)(?=\n|📌|✈️|⚙️|$)/i),
    subject: g(/Тематика\s*[-–:]\s*(.+?)(?=\n|✈️|⚙️|$)/i),
    topic: g(/Тема\s*[-–:]\s*(.+?)(?=\n|Презентація|⚙️|$)/i),
    pages: g(/К-кість стр\.\s*[-–:]\s*(.+?)(?=\n|⚙️|$)/i),
    uniqueness: g(/Унікальність\s*[-–:]\s*(.+?)(?=\n|$)/i),
    course: g(/Курс\s*[-–:]\s*(\d+)/i),
    extras: g(/Презентація(.+?)(?=\n|⚙️|$)/i),
    language: "Українська", methodNotes: "", sourceCount: "30-40",
  };
}

export function parseClientPlan(text, totalPages, lang = "Українська") {
  const { intro: introLabel, conclusions: conclLabel, sources: srcLabel, chapConclLabel } = getLangLabels(lang);

  const normalized = text
    .replace(/С(?=[Hh][Aa][Pp][Tt][Ee][Rr])/g, 'C')
    .replace(/([^\n])\s+(Розділ\s)/gi, "$1\n$2")
    .replace(/([^\n])\s+(Chapter\s)/gi, "$1\n$2")
    .replace(/([^\n])\s+(Rozdział\s)/gi, "$1\n$2")
    .replace(/([^\n])\s+(Cap[ií]tulo\s)/gi, "$1\n$2")
    .replace(/([^\n])\s+(Kapitol[ao]\s)/gi, "$1\n$2")
    .replace(/([^\n])\s+(Kapitel\s)/gi, "$1\n$2")
    .replace(/([^\n])\s+(Chapitre\s)/gi, "$1\n$2")
    .replace(/([^\n])\s+(Capitolo\s)/gi, "$1\n$2")
    .replace(/([^\n])\s+(висновк\w*)/gi, "$1\n$2")
    .replace(/([^\n])\s+(список\s)/gi, "$1\n$2")
    .replace(/([^\n])\s+(вступ\s|вступ$)/gi, "$1\n$2");
  // Хвіст змісту — відточія й номер сторінки: "Назва …………… 12", а також одинарне "…"
  // ("МОВОЗНАВСТВІ …") — інакше воно лишалось у назві розділу
  const lines = normalized.split("\n")
    .map(l => l.trim().replace(/(?:\s*[…‥]|[.·\s]{3,})[.…·‥\s]*\d*\s*$/, "").replace(/\s{2,}/g, " ").trim())
    .filter(Boolean);
  const chapters = []; let current = null;
  let expectingChapterTitle = false;
  // Мова з набору ШІ: заголовок розділу, "висновки до розділу N" і службові рядки її словами
  const dynChapterRe = dynamicChapterLineRe();
  const dynServiceRe = dynamicServiceLineRe(["intro", "conclusions", "sources", "appendixWord", "appendixSingular", "toc"]);
  const dynConclPrefixes = [...DYNAMIC_PROFILES.values()].map(lp => escRe(lp.chapterConclusion.split("{n}")[0].trim())).filter(Boolean);
  const dynConclRe = dynConclPrefixes.length ? new RegExp(`^(?:${dynConclPrefixes.join("|")})\\s*\\d`, "iu") : null;
  for (const line of lines) {
    const isChapter = /^розділ\s/i.test(line) || /^chapter\s/i.test(line)
      || /^rozdział\s/i.test(line) || /^cap[ií]tulo\s/i.test(line)
      || /^kapitol[ao]\s/i.test(line) || /^kapitel\s/i.test(line)
      || /^chapitre\s/i.test(line) || /^capitolo\s/i.test(line)
      || /^第\d+章/.test(line)
      || !!dynChapterRe?.test(line)
      || /^\d+[\.\)]\s+\p{L}/u.test(line);
    const isSubsection = /^\d+\.\d+/.test(line) || /^[-–•]\s+/.test(line);
    const isChapterConclusion = /^висновк[^\s]*\s+до\s+/i.test(line)
      || /^wnioski\s+do\s+/i.test(line) || /^conclusiones\s+(del|al)\s+/i.test(line)
      || /^závěry\s+ke\s+/i.test(line) || /^závery\s+ku\s+/i.test(line)
      || /^schlussfolgerungen\s+zu\s+/i.test(line)
      || /^conclusions?\s+(?:to|of|for)\s+(?:the\s+)?chapter/i.test(line)
      || /^conclusions?\s+(?:du|au)\s+chapitre/i.test(line) || /^conclusioni\s+(?:del|al)\s+capitolo/i.test(line)
      || !!dynConclRe?.test(line);
    const isSpecial = !isChapterConclusion && /^(вступ[\s,\.!]?$|вступ\s|висновк|список|загальн|практичн|додатк|зміст|wstęp|wnioski|zakończenie|bibliografia|spis\s|introducción|introduccion|conclusiones|bibliografía|bibliografia|índice|indice|einleitung|schlussfolgerungen|fazit|literaturverzeichnis|inhaltsverzeichnis|úvod|závěr|záver|seznam\s|zoznam\s|引言|绪论|结论|参考文献|目录|(?:introduction|conclusions?|references|bibliography|list of references|(?:table of )?contents|introduzione|conclusioni|conclusion générale|bibliographie|table des matières|sommaire)\.?$|appendi(?:x|ces|ce|ci)\b|annexes?\b)/i.test(line)
      || (!isChapterConclusion && !!dynServiceRe?.test(line));
    if (isSpecial) { expectingChapterTitle = false; continue; }
    if (isChapterConclusion && current) { current.hasConclusion = true; expectingChapterTitle = false; continue; }
    if (isChapter) {
      const dynM = dynChapterRe ? line.match(dynChapterRe) : null;
      const numMatch = line.match(/^(?:розділ|chapter|rozdział|cap[ií]tulo|kapitol[ao]|kapitel|chapitre|capitolo)\s*(\d+)/i)
        || (dynM ? [dynM[0], dynM[1] || dynM[2]] : null)
        || line.match(/^(\d+)[\.\)]\s+/) || line.match(/^第(\d+)章/);
      current = { title: line.trim(), subsections: [], hasConclusion: false, declaredNum: numMatch ? parseInt(numMatch[1], 10) : null };
      chapters.push(current);
      expectingChapterTitle = true;
    } else if (isSubsection) {
      expectingChapterTitle = false;
      if (current) current.subsections.push(line.replace(/^[-–•]\s+/, "").trim());
    } else if (expectingChapterTitle && current) {
      current.title = current.title + ". " + line.trim();
      expectingChapterTitle = false;
    }
  }
  // Fallback: no chapter headers found but subsections exist — auto-group by leading digit
  if (!chapters.length) {
    const subLines = lines.filter(l => /^\d+\.\d+/.test(l));
    if (!subLines.length) return null;
    const chapMap = {}; const chapOrder = [];
    for (const l of subLines) {
      const chapNum = l.match(/^(\d+)\./)[1];
      if (!chapMap[chapNum]) { chapMap[chapNum] = { title: chapNum, subsections: [], hasConclusion: false }; chapOrder.push(chapNum); }
      chapMap[chapNum].subsections.push(l.trim());
    }
    for (const n of chapOrder) chapters.push(chapMap[n]);
  }
  if (!chapters.length) return null;
  const mainPages = Math.round(totalPages * 0.80);
  const pagesPerChapter = Math.max(1, Math.round(mainPages / chapters.length));
  const introPages = 2;
  const concPages = totalPages > 40 ? 3 : 2;
  const sections = []; let chapCounter = 0;
  for (const ch of chapters) {
    chapCounter++;
    const chapNum = ch.declaredNum || chapCounter;
    const chType = chapNum === 1 ? "theory" : chapNum === 2 ? "analysis" : "recommendations";
    if (ch.subsections.length === 0) {
      sections.push({ id: `${chapNum}`, label: ch.title, sectionTitle: ch.title.toUpperCase(), pages: pagesPerChapter, type: chType });
    } else {
      // Глибина пункту — кількість груп цифр у його номері (1.1 → 2, 1.1.1 → 3, 1.1.1.1 → 4);
      // пункт без номера ("- Назва") — другий рівень. id рахуємо послідовно на кожному рівні,
      // як і раніше для 1.1/1.2 (стійко до описок у номерах клієнта).
      const idx = [];
      const subs = ch.subsections.map(text => {
        const num = text.match(/^(\d+(?:\.\d+)+)/)?.[1];
        const depth = Math.min(num ? num.split(".").length : 2, 4);
        idx.length = depth + 1;
        for (let d = 2; d < depth; d++) idx[d] = idx[d] || 1; // пропущений батьківський рівень
        idx[depth] = (idx[depth] || 0) + 1;
        const id = [chapNum, ...idx.slice(2, depth + 1)].join(".");
        return { id, text, hasNum: !!num };
      });
      // Пункт, під яким у плані є вкладені (1.1 перед 1.1.1) — лише заголовок-«шапка»
      // без власного тексту; обсяг ділиться між кінцевими пунктами.
      const isParent = (s) => subs.some(o => o.id.startsWith(s.id + "."));
      const leafCount = subs.filter(s => !isParent(s)).length;
      const pagesPerSub = Math.max(1, Math.round(pagesPerChapter / Math.max(leafCount, 1)));
      for (const s of subs) {
        const parent = isParent(s);
        sections.push({
          id: s.id, label: s.hasNum ? s.text : `${s.id} ${s.text}`, sectionTitle: ch.title.toUpperCase(),
          pages: parent ? 0 : pagesPerSub, type: chType, ...(parent ? { headingOnly: true } : {}),
        });
      }
    }
    if (ch.hasConclusion) {
      sections.push({ id: `${chapNum}.conclusions`, label: chapConclLabel(chapNum), sectionTitle: ch.title.toUpperCase(), pages: 1, type: "chapter_conclusion", chapterNum: String(chapNum) });
    }
  }
  sections.push({ id: "intro", label: introLabel, pages: introPages, type: "intro" });
  sections.push({ id: "conclusions", label: conclLabel, pages: concPages, type: "conclusions" });
  sections.push({ id: "sources", label: srcLabel, pages: 1, type: "sources" });
  return sections;
}

// ── План клієнта може прийти файлом/текстом разом з іншим вмістом (обґрунтування теми,
// мета, завдання, список джерел…). extractPlanBlock вирізає кодом лише сам план:
// від першого "Розділ N"/"N.N" (з "Вступом" перед ним) до останнього службового пункту
// (список джерел/додатки), склеюючи перенесені рядки назв. Якщо плану не видно —
// повертає текст без змін; на вже чистому плані нічого не змінює. ──
const PLAN_CHAPTER_WORD_RE = /^(?:розділ|chapter|rozdział|cap[ií]tulo|kapitol[ao]|kapitel|chapitre|capitolo)\s*\d+|^第\d+章/i;
// 1.1 / 1.1.1 / 1.1.1.1 — будь-яка глибина (раніше 1.1.1 вважався звичайним текстом і план обривався)
const PLAN_SUB_RE = /^\d+(?:\.\d+)+\.?(?:\s|$)/;
const PLAN_INTRO_RE = /^(?:вступ|introduction|wstęp|einleitung|úvod|introducci[oó]n|introduzione)(?![a-zа-яґєії])/i;
const PLAN_SPECIAL_RE = /^(?:вступ|висновк|список|перелік|додат|introduction|conclusions?|references|bibliography|appendi|wstęp|wnioski|zakończenie|bibliografia|spis\s|einleitung|schlussfolgerungen|fazit|literaturverzeichnis|anhang|úvod|závěr|záver|seznam\s|zoznam\s|introducci[oó]n|conclusiones|bibliograf[ií]a|anexo|introduzione|conclusioni|bibliographie|annexe)/i;
const PLAN_END_RE = /^(?:список|перелік|додат|references|bibliography|appendi|bibliografia|spis\s|literaturverzeichnis|anhang|seznam\s|zoznam\s|bibliograf[ií]a|anexo|bibliographie|annexe)/i;

// Те саме для мов із набору ШІ (registerLangProfile): рядок-заголовок розділу ("CAPITOLUL 2…" /
// "2. FEJEZET…", номер — у групі 1 або 2) і службові рядки (вступ/висновки/джерела/додатки).
// null — таких мов не зареєстровано.
function dynamicChapterLineRe() {
  const { wordFirst, numFirst } = dynamicChapterWords();
  const alts = [];
  if (wordFirst.length) alts.push(`(?:${wordFirst.join("|")})\\s*(\\d+)`);
  if (numFirst.length) alts.push(`(\\d+)\\.?\\s*(?:${numFirst.join("|")})(?!\\p{L})`);
  return alts.length ? new RegExp(`^(?:${alts.join("|")})`, "iu") : null;
}
function dynamicServiceLineRe(fields) {
  const words = [...DYNAMIC_PROFILES.values()].flatMap(lp => fields.map(f => lp[f])).filter(Boolean).map(escRe);
  return words.length ? new RegExp(`^(?:${words.join("|")})(?!\\p{L})`, "iu") : null;
}

function planLineKind(line, nextLine) {
  const l = line.replace(/[.…·‥\s]{3,}\d*\s*$/, "").trim();
  if (PLAN_CHAPTER_WORD_RE.test(l) || dynamicChapterLineRe()?.test(l)) return "chapter";
  if (PLAN_SUB_RE.test(l)) return "sub";
  // "2. Назва розділу" без слова "Розділ" — лише якщо одразу за ним іде "2.1"
  const top = l.match(/^(\d+)[.)]\s+\S/);
  if (top && nextLine && new RegExp(`^${top[1]}\\.\\d`).test(nextLine.trim())) return "chapter";
  if (l.length <= 100 && (PLAN_SPECIAL_RE.test(l) || dynamicServiceLineRe(["intro", "conclusions", "sources", "appendixWord", "appendixSingular"])?.test(l))) {
    return PLAN_END_RE.test(l) || dynamicServiceLineRe(["sources", "appendixWord", "appendixSingular"])?.test(l) ? "end" : "special";
  }
  return "text";
}

export function extractPlanBlock(text) {
  if (!text?.trim()) return text || "";
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const kinds = lines.map((l, i) => planLineKind(l, lines[i + 1]));

  for (let start = 0; start < lines.length; start++) {
    if (kinds[start] !== "chapter" && kinds[start] !== "sub") continue;
    let from = start;
    if (from > 0 && (PLAN_INTRO_RE.test(lines[from - 1]) || dynamicServiceLineRe(["intro"])?.test(lines[from - 1])) && kinds[from - 1] === "special") from--;

    const out = [];
    let prevKind = null, structural = 0, ended = false, contCount = 0;
    for (let i = from; i < lines.length; i++) {
      const kind = kinds[i];
      const line = lines[i];
      if (kind === "chapter" || kind === "sub") {
        if (ended) break;
        out.push(line); structural++; contCount = 0;
      } else if (kind === "special" || kind === "end") {
        out.push(line); contCount = 0;
        if (kind === "end") ended = true;
      } else {
        // Перенесений рядок назви розділу/підрозділу: попередній рядок не закінчився
        // крапкою/двокрапкою або це голе "Розділ 1" (назва — наступним рядком).
        const prev = out[out.length - 1] || "";
        const bareChapter = /^(?:розділ|chapter|rozdział|cap[ií]tulo|kapitol[ao]|kapitel|chapitre|capitolo)\s*\d+\.?$/i.test(prev)
          || !!(dynamicChapterLineRe() && prev.replace(dynamicChapterLineRe(), "").replace(/^\.?\s*$/, "") === "");
        const canContinue = (prevKind === "chapter" || prevKind === "sub") && contCount < 2
          && (bareChapter || !/[.!?:;]$/.test(prev));
        if (!canContinue) break;
        out[out.length - 1] = bareChapter
          ? `${prev.replace(/\.$/, "")}. ${line}`
          : /[-‐]$/.test(prev) ? prev + line : `${prev} ${line}`;
        contCount++;
        continue;
      }
      prevKind = kind;
    }
    if (structural >= 2) return out.join("\n");
  }
  return text;
}

// Детермінована перевірка вже вирізаного плану клієнта. Повертає масив зрозумілих
// людині попереджень (порожній — усе гаразд). Показується в UI під планом, а для
// CRM-замовлень іде разом з планом на затвердження (docs/crm-integration.md §3.5).
export function checkPlanIssues(planText, { topic } = {}) {
  const issues = [];
  const lines = (planText || "").split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const chapters = []; // {num, subs:[{chap, sub, label}]}
  let current = null;
  lines.forEach((line, i) => {
    const kind = planLineKind(line, lines[i + 1]);
    if (kind === "chapter") {
      const m = line.match(/(\d+)/);
      current = { num: m ? parseInt(m[1], 10) : null, subs: [] };
      chapters.push(current);
    } else if (kind === "sub") {
      // Пункти 3-4 рівня (1.1.1) не рахуємо як підрозділи — інакше "1.1, 1.1.1, 1.2"
      // давало б хибне "підрозділи йдуть не підряд"
      if (/^\d+\.\d+\.\d/.test(line)) return;
      const m = line.match(/^(\d+)\.(\d+)/);
      const sub = { chap: parseInt(m[1], 10), sub: parseInt(m[2], 10), label: `${m[1]}.${m[2]}` };
      if (!current) { current = { num: sub.chap, subs: [], implicit: true }; chapters.push(current); }
      else if (current.implicit && current.num !== sub.chap) { current = { num: sub.chap, subs: [], implicit: true }; chapters.push(current); }
      current.subs.push(sub);
    }
  });

  if (chapters.length < 2) {
    issues.push(chapters.length ? "У плані знайдено лише 1 розділ." : "У тексті не знайдено плану (розділів і підрозділів).");
  }
  const nums = chapters.map(c => c.num).filter(n => n != null);
  if (nums.length >= 2 && nums.some((n, i) => n !== nums[0] + i)) {
    issues.push(`Номери розділів ідуть не підряд: ${nums.join(", ")}.`);
  }
  for (const ch of chapters) {
    const wrong = ch.subs.filter(s => ch.num != null && s.chap !== ch.num);
    if (wrong.length) issues.push(`У розділі ${ch.num} є підрозділи з чужим номером: ${wrong.map(s => s.label).join(", ")}.`);
    const own = ch.subs.filter(s => s.chap === ch.num).map(s => s.sub);
    if (own.length >= 2 && own.some((n, i) => n !== own[0] + i)) {
      issues.push(`У розділі ${ch.num} підрозділи йдуть не підряд: ${own.map(n => `${ch.num}.${n}`).join(", ")}.`);
    }
  }
  const withSubs = chapters.filter(c => c.subs.length);
  if (withSubs.length && withSubs.length < chapters.length) {
    const empty = chapters.filter(c => !c.subs.length).map(c => c.num ?? "?");
    issues.push(`Розділ${empty.length > 1 ? "и" : ""} ${empty.join(", ")} без підрозділів, хоча в інших вони є.`);
  }

  // Назви організацій у лапках: у плані не має бути іншої організації, ніж у темі.
  const quoted = (s) => [...(s || "").matchAll(/«([^»]{2,60})»/g)].map(m => m[1].trim());
  const norm = (s) => s.toLowerCase().replace(/[^a-zа-яґєії0-9]/gi, "");
  const topicNames = quoted(topic).map(norm).filter(Boolean);
  if (topicNames.length) {
    const foreign = [...new Set(quoted(planText).filter(n => {
      const k = norm(n);
      return k && !topicNames.some(t => t.includes(k) || k.includes(t));
    }))];
    if (foreign.length) {
      issues.push(`У плані згадано ${foreign.map(n => `«${n}»`).join(", ")}, а в темі — ${quoted(topic).map(n => `«${n}»`).join(", ")}. Перевірте, яка організація правильна.`);
    }
  }
  return issues;
}

// Рахує chaptersCount/subsectionsPerChapter/hasChapterConclusions з реального
// змісту "приклада роботи" (exampleTOC), детерміновано кодом — без AI-виклику.
// Перевикористовує parseClientPlan лише як парсер тексту в розділи/підрозділи;
// самі назви розділів з нього НЕ беруться, тільки кількості.
export function deriveStructureFromExampleTOC(exampleTOC, lang = "Українська") {
  if (!exampleTOC?.trim()) return null;
  const sections = parseClientPlan(exampleTOC.trim(), 30, lang);
  if (!sections?.length) return null;

  const subsPerChap = {}; // "1" -> к-сть підрозділів
  let hasChapterConclusions = false;
  for (const s of sections) {
    const subMatch = s.id.match(/^(\d+)\.(\d+)$/);
    if (subMatch) {
      const chapNum = subMatch[1];
      subsPerChap[chapNum] = (subsPerChap[chapNum] || 0) + 1;
      continue;
    }
    if (/^\d+\.conclusions$/.test(s.id)) hasChapterConclusions = true;
  }
  const chapNums = Object.keys(subsPerChap);
  if (!chapNums.length) return null;

  const counts = chapNums.map(n => subsPerChap[n]);
  // Найчастіше значення — базове; розділи що відрізняються — в overrides
  const freq = {};
  counts.forEach(c => { freq[c] = (freq[c] || 0) + 1; });
  const subsectionsPerChapter = Number(Object.entries(freq).sort((a, b) => b[1] - a[1])[0][0]);
  const subsectionsPerChapterOverrides = {};
  for (const n of chapNums) {
    if (subsPerChap[n] !== subsectionsPerChapter) subsectionsPerChapterOverrides[n] = subsPerChap[n];
  }

  return {
    chaptersCount: chapNums.length,
    subsectionsPerChapter,
    subsectionsPerChapterOverrides: Object.keys(subsectionsPerChapterOverrides).length ? subsectionsPerChapterOverrides : null,
    hasChapterConclusions,
  };
}

// Зливає дані, витягнуті з "приклада роботи" (exampleInfo/exampleStructure), у
// methodInfo — ЛИШЕ для полів, які methodInfo лишив порожніми. Явні вимоги з
// методички завжди мають пріоритет над зразком.
const EXAMPLE_WORK_FIELDS = [
  "chaptersCount", "subsectionsPerChapter", "subsectionsPerChapterOverrides",
  "hasChapterConclusions", "titlePageTemplate", "taskSheetTemplate", "calendarPlanTable",
  "hasFigures", "formatting", "sourcesStyle",
  "sourcesOrder", "sourcesGrouping", "citationStyle", "sourcesFormatRules",
  "introComponents", "introStructureHasChapterDetail", "exampleTOC",
];
export function mergeExampleWorkIntoMethodInfo(methodInfo, exampleInfo, exampleStructure) {
  const source = { ...(exampleStructure || {}), ...(exampleInfo || {}) };
  const result = { ...(methodInfo || {}) };
  for (const key of EXAMPLE_WORK_FIELDS) {
    if (result[key] == null && source[key] != null) result[key] = source[key];
  }
  return result;
}

const CARDINAL_CHAPTER_WORDS = [
  [/\bодн[а-яії]*\s+розділ/i, 1],
  [/\bдв[аі][а-яії]*\s+розділ/i, 2],
  [/\bтр(?:и|ьох)\s+розділ/i, 3],
  [/\bчотир(?:и|ьох)\s+розділ/i, 4],
  [/\bп['ʼ’]?ят(?:ь|и)\s+розділ/i, 5],
  [/\bшіст(?:ь|и)\s+розділ/i, 6],
];
const ORDINAL_CHAPTER_WORDS = [
  [/\bперш[а-яії]*\s+розділ/i, 1],
  [/\bдруг[а-яії]*\s+розділ/i, 2],
  [/\bтрет[а-яії]*\s+розділ/i, 3],
  [/\bчетверт[а-яії]*\s+розділ/i, 4],
  [/\bп['ʼ’]?ят[а-яії]*\s+розділ/i, 5],
  [/\bшост[а-яії]*\s+розділ/i, 6],
];

// Розпізнає явно вказану клієнтом кількість розділів у вільному тексті (коментар/матеріали клієнта) —
// цифрою ("3 розділи"), кардинальним числівником ("три розділи") або порядковим числівником, що натякає
// на мінімальну кількість розділів ("третій розділ — ...", тобто розділів щонайменше 3).
export function detectRequestedChapterCount(text) {
  if (!text) return null;
  const t = String(text).toLowerCase();
  const digitMatch = t.match(/(\d+)\s*розділ/i);
  if (digitMatch) return parseInt(digitMatch[1], 10);
  for (const [re, n] of CARDINAL_CHAPTER_WORDS) if (re.test(t)) return n;
  let maxOrdinal = 0;
  for (const [re, n] of ORDINAL_CHAPTER_WORDS) if (re.test(t)) maxOrdinal = Math.max(maxOrdinal, n);
  return maxOrdinal || null;
}

const ORDINAL_STEMS = [[/^перш/, 1], [/^друг/, 2], [/^трет/, 3], [/^четверт/, 4], [/^п['ʼ’]?ят/, 5], [/^шост/, 6]];
// Номер розділу: "2", "2-й", "2-го", "другий", "другого"…
const CH_NUM = String.raw`(?:\d+(?:\s*-?\s*(?:й|ий|ій|го|ого|му|ому|ї|і))?|(?:перш|друг|трет|четверт|п['ʼ’]?ят|шост)[а-яії]*)`;
// \b у JS не бачить меж кириличних слів — сполучники обгороджуємо пробілами явно
const CH_CONN = String.raw`(?:\s*(?:,|-|–|—)\s*|\s+(?:і|й|та|або)\s+)`;
const chapNumsOf = (seq) => {
  const out = [];
  const parts = seq.match(new RegExp(CH_NUM + "|-|–|—", "gi")) || [];
  for (let k = 0; k < parts.length; k++) {
    const p = parts[k].toLowerCase();
    // "2-3" / "2–3" — діапазон; "2-й" — порядковий (суфікс уже в самому токені)
    if (/^[-–—]$/.test(p)) {
      const a = out[out.length - 1], b = parseInt(parts[k + 1], 10);
      if (a && b > a) { for (let n = a + 1; n <= b; n++) out.push(n); k++; }
      continue;
    }
    const d = parseInt(p, 10);
    if (!isNaN(d)) { out.push(d); continue; }
    const st = ORDINAL_STEMS.find(([re]) => re.test(p));
    if (st) out.push(st[1]);
  }
  return out;
};

// Які саме розділи просить написати клієнт у коментарі до продовження роботи ("Потрібно виконати
// 2-й розділ", "дописати розділи 2-3", "написати другий і третій розділи") → {chapters:[2,3]}.
// Лише речення з дією (виконати/написати/…) і без "вже/уже/написаний" — "1-й розділ уже написаний"
// не рахується. "2 розділи" (кількість) — не номер розділу. Обсяг pages — з замовлення, тут null.
export function detectWriteScopeFromComment(text) {
  if (!text) return null;
  const chapters = new Set();
  for (const sentence of String(text).toLowerCase().split(/[.!?\n;]+/)) {
    if (!/(виконат|написат|дописат|зробит|підготуват|продовжит|потрібн|треба|необхідн)/.test(sentence)) continue;
    if (/(^|\s)(вже|уже)(\s|$)|написан|виконан|готов(ий|а|і)\s+розділ/.test(sentence)) continue;
    // "2-й та 3-й розділи", "другий розділ"; голе число перед "розділи/розділів" — кількість, не номер
    const before = new RegExp(`((?:${CH_NUM})(?:${CH_CONN}(?:${CH_NUM}))*)\\s+розділ([а-яії]*)`, "gi");
    for (const m of sentence.matchAll(before)) {
      // "у 2 розділі" / "в розділах" — місце в роботі ("щоб у 2 розділі була таблиця"), не прохання
      if (/^(і|ах)$/.test(m[2])) continue;
      const plural = /^(и|ів)$/.test(m[2]);
      if (plural && /^\d+$/.test(m[1].trim())) continue;
      chapNumsOf(m[1]).forEach(n => chapters.add(n));
    }
    // "розділ 2", "розділи 2 і 3", "розділи 2-3", "розділ №2"
    const after = new RegExp(`розділ([а-яії]*)\\s+(?:№\\s*)?(\\d+(?:${CH_CONN}\\d+)*)`, "gi");
    for (const m of sentence.matchAll(after)) {
      if (/^(і|ах)$/.test(m[1])) continue;
      chapNumsOf(m[2]).forEach(n => chapters.add(n));
    }
  }
  const list = [...chapters].filter(n => n >= 1 && n <= 6).sort((a, b) => a - b);
  return list.length ? { chapters: list, pages: null } : null;
}

// Вставляє нові розділи/підрозділи в кінець "основних" розділів — перед Висновками
// чи Списком джерел (вони, на відміну від Вступу, завжди останні незалежно від
// попередніх переміщень стрілками ↑/↓), інакше в кінець масиву.
export function insertBeforeTail(sections, newItems) {
  let idx = sections.findIndex(s => s.type === "conclusions");
  if (idx < 0) idx = sections.findIndex(s => s.type === "sources");
  return idx >= 0
    ? [...sections.slice(0, idx), ...newItems, ...sections.slice(idx)]
    : [...sections, ...newItems];
}

export function buildPlanText(secs) {
  const intro = secs.find(s => s.type === "intro");
  const concs = secs.find(s => s.type === "conclusions");
  const srcs = secs.find(s => s.type === "sources");
  const main = secs.filter(s => !["intro", "conclusions", "sources", "chapter_conclusion"].includes(s.type));
  // Auto-detect chapter word from existing section titles so we never mix languages
  const detectedChapWord = detectChapterWord(main.map(s => s.sectionTitle));
  const lines = [];
  if (intro) lines.push((intro.label || "ВСТУП") + "\n");
  const groups = {};
  for (const s of main) { const top = s.id.split(".")[0]; if (!groups[top]) groups[top] = []; groups[top].push(s); }
  for (const [num, items] of Object.entries(groups)) {
    const rawTitle = items[0].sectionTitle || items[0].label.replace(/^\d+\.\d+\s+/, "").split(" ").slice(0, 7).join(" ").toUpperCase();
    const alreadyHasPrefix = chapterWordRe().test(rawTitle.trim());
    const secLabel = alreadyHasPrefix ? rawTitle.trim() : `${composeChapterPrefix(detectedChapWord, num)}. ${rawTitle}`;
    lines.push(secLabel);
    for (const s of items) { if (!s.chapterOnly && /^\d+\.\d+/.test(s.id)) lines.push(`    ${s.label}`); }
    const chapConc = secs.find(s => s.type === "chapter_conclusion" && s.id === `${num}.conclusions`);
    if (chapConc) lines.push(`    ${chapConc.label}`);
    lines.push("");
  }
  if (concs) lines.push((concs.label || "ВИСНОВКИ") + "\n");
  if (srcs) lines.push(srcs.label || "СПИСОК ВИКОРИСТАНИХ ДЖЕРЕЛ");
  return lines.join("\n");
}

export function buildPreviewStructure(totalPages) {
  return [
    { label: "ВСТУП", sub: [] },
    { label: "РОЗДІЛ 1. Теоретичні основи дослідження", sub: ["1.1 [підрозділ 1.1]", "1.2 [підрозділ 1.2]", "1.3 [підрозділ 1.3]"] },
    { label: "РОЗДІЛ 2. Аналітично-практична частина", sub: ["2.1 [підрозділ 2.1]", "2.2 [підрозділ 2.2]", "2.3 [підрозділ 2.3]"] },
    ...(totalPages >= 70 ? [{ label: "РОЗДІЛ 3. Рекомендації та пропозиції", sub: ["3.1 [підрозділ 3.1]", "3.2 [підрозділ 3.2]"] }] : []),
    { label: "ВИСНОВКИ", sub: [] },
    { label: "СПИСОК ВИКОРИСТАНИХ ДЖЕРЕЛ", sub: [] },
  ];
}

export function calcSourceDist(secs) {
  // headingOnly — пункт-«шапка» без власного тексту (1.1 перед 1.1.1): джерела йому не потрібні
  const mainSecs = secs.filter(s => !["intro", "conclusions", "sources", "chapter_conclusion"].includes(s.type) && !s.headingOnly);
  const secPagesSum = mainSecs.reduce((sum, s) => sum + (s.pages || 0), 0);
  if (!secPagesSum) return { dist: {}, total: 0 };
  // 1 джерело на 1 сторінку ОСНОВНОГО тексту — усе від Розділу 1 до Висновків (не
  // включно): підрозділи розділів + "Висновки до розділу N", БЕЗ Вступу, Висновків
  // і Списку джерел (їх обсяг з кількістю використаної літератури не пов'язаний).
  const total = secs.reduce((sum, s) =>
    ["intro", "conclusions", "sources"].includes(s.type) ? sum : sum + (s.pages || 0), 0);
  const minPerSec = Math.max(1, Math.floor(total / mainSecs.length / 2));
  // Пропорційна частка (дробова) кожного підрозділу за обсягом сторінок, не нижче minPerSec
  const raw = mainSecs.map(s => Math.max(minPerSec, (s.pages / secPagesSum) * total));
  const floors = raw.map(v => Math.floor(v));
  let remainder = Math.round(total) - floors.reduce((a, b) => a + b, 0);
  // Метод найбільших остач: залишок від округлення розподіляємо по одному джерелу
  // підрозділам з найбільшою дробовою частиною — а не скидаємо все на останній підрозділ
  const order = raw
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac);
  const result = [...floors];
  for (let k = 0; k < order.length && remainder > 0; k++) { result[order[k].i] += 1; remainder--; }
  const dist = {};
  mainSecs.forEach((s, i) => { dist[s.id] = result[i]; });
  return { dist, total: Object.values(dist).reduce((a, b) => a + b, 0) };
}

// ── Перенумерація id/назв розділів і підрозділів після перебудови плану (переміщення,
// додавання, видалення) — розділи нумеруються за порядком першої появи їхнього
// sectionTitle у масиві, підрозділи — послідовно в межах свого розділу. Раніше жила
// лише в academic-assistant.jsx (для стрілок ↑/↓); винесена сюди, щоб її ж міг
// використати applyPlanEditOps нижче — без дублювання логіки.
export function renumberSections(sections) {
  const chapterTitles = [];
  sections.forEach(s => {
    if (!["intro", "conclusions", "sources", "chapter_conclusion"].includes(s.type) && s.sectionTitle) {
      if (!chapterTitles.includes(s.sectionTitle)) chapterTitles.push(s.sectionTitle);
    }
  });
  const chapWord = detectChapterWord(chapterTitles);
  const chNumMap = {};
  chapterTitles.forEach((title, idx) => { chNumMap[title] = idx + 1; });
  const chTitleMap = {};
  const prefixNumRe = chapterPrefixNumRe();
  chapterTitles.forEach(title => {
    const newN = chNumMap[title];
    const match = title.match(prefixNumRe);
    const rest = match ? match[1] : title;
    chTitleMap[title] = `${composeChapterPrefix(chapWord, newN)}. ${rest}`.trimEnd();
  });
  const subCount = {};
  let lastChNum = 1;
  return sections.map(s => {
    if (["intro", "conclusions", "sources"].includes(s.type)) return s;
    if (s.type === "chapter_conclusion") {
      const newTitle = chTitleMap[s.sectionTitle] || s.sectionTitle;
      return { ...s, id: `${lastChNum}.conclusions`, sectionTitle: newTitle };
    }
    const cn = chNumMap[s.sectionTitle] || 1;
    lastChNum = cn;
    if (!subCount[cn]) subCount[cn] = 0;
    subCount[cn]++;
    const newId = `${cn}.${subCount[cn]}`;
    const newTitle = chTitleMap[s.sectionTitle] || s.sectionTitle;
    if (s.chapterOnly) return { ...s, id: newId, sectionTitle: newTitle, label: newTitle };
    const labelBody = s.label.replace(/^\d+\.\d+\s*/, "");
    return { ...s, id: newId, sectionTitle: newTitle, label: `${newId} ${labelBody}` };
  });
}

// ── Перезбирає повний масив sections з intro/conclusions/sources/висновків-до-розділу
// (взятих із prev) навколо нового порядку основних підрозділів (newMainSecs) —
// висновки до розділу прив'язуються позиційно до i-го розділу в новому порядку.
export function rebuildWithChapterConclusions(prev, newMainSecs) {
  const intro = prev.filter(s => s.type === "intro");
  const conclusions = prev.filter(s => s.type === "conclusions");
  const sources = prev.filter(s => s.type === "sources");
  const chapConcs = prev
    .filter(s => s.type === "chapter_conclusion")
    .sort((a, b) => (parseInt(a.id) || 0) - (parseInt(b.id) || 0));
  const chapTitles = [];
  const chapSecs = {};
  newMainSecs.forEach(s => {
    if (!chapSecs[s.sectionTitle]) { chapTitles.push(s.sectionTitle); chapSecs[s.sectionTitle] = []; }
    chapSecs[s.sectionTitle].push(s);
  });
  const result = [...intro];
  chapTitles.forEach((title, i) => {
    result.push(...chapSecs[title]);
    if (chapConcs[i]) result.push(chapConcs[i]);
  });
  result.push(...conclusions, ...sources);
  return result;
}

// ── Людський опис однієї операції правки плану (для прев'ю перед застосуванням) —
// формується кодом з полів операції й поточного sections, а не з тексту від ШІ,
// щоб опис завжди точно відповідав тому, що реально застосується.
export function describePlanEditOp(op, sections) {
  const findLabel = (id) => {
    if (id === "intro") return sections.find(s => s.type === "intro")?.label ?? null;
    if (id === "conclusions") return sections.find(s => s.type === "conclusions")?.label ?? null;
    if (id === "sources") return sections.find(s => s.type === "sources")?.label ?? null;
    return sections.find(s => s.id === id)?.label ?? null;
  };
  switch (op.op) {
    case "rename": {
      const old = findLabel(op.id);
      if (old == null) return { text: `Перейменувати ${op.id} — не знайдено в плані, пропущено`, invalid: true };
      return { text: `Перейменувати «${old}» → «${op.newLabel}»` };
    }
    case "rename_chapter": {
      const target = sections.find(s => !["intro", "conclusions", "sources", "chapter_conclusion"].includes(s.type) && s.id.split(".")[0] === String(op.chapterId));
      if (!target) return { text: `Перейменувати розділ ${op.chapterId} — не знайдено, пропущено`, invalid: true };
      return { text: `Перейменувати розділ ${op.chapterId}: «${target.sectionTitle}» → «${op.newTitle}»` };
    }
    case "resize": {
      const old = op.id === "intro" || op.id === "conclusions" || op.id === "sources"
        ? sections.find(s => s.type === op.id)
        : sections.find(s => s.id === op.id);
      if (!old) return { text: `Змінити обсяг ${op.id} — не знайдено, пропущено`, invalid: true };
      return { text: `Обсяг «${old.label}»: ${old.pages} → ${op.newPages} стор.` };
    }
    case "remove": {
      const old = findLabel(op.id);
      if (old == null) return { text: `Видалити ${op.id} — не знайдено, пропущено`, invalid: true };
      return { text: `Видалити: «${old}»` };
    }
    case "add_subsection":
      return { text: `Додати підрозділ у розділ ${op.chapterId}: «${op.label || "новий підрозділ"}» (${op.pages || 3} стор.)` };
    case "add_chapter":
      return { text: `Додати новий розділ: «${op.title || "новий розділ"}»${op.subsections?.length ? ` (${op.subsections.length} підрозділ.)` : ""}` };
    default:
      return { text: `Невідома операція «${op.op}»`, invalid: true };
  }
}

// ── Детерміноване застосування розпізнаних ШІ операцій правки плану до sections.
// ШІ лише перетворює вільний текст клієнта на структуровані операції (planUtils
// цього не вміє — це вимагає розуміння мови); саму мутацію масиву sections
// завжди виконує код нижче, а не ШІ, щоб результат був передбачуваним.
export function applyPlanEditOps(sections, ops, lang = "Українська") {
  const lc = getLangLabels(lang);
  let mainSecs = sections.filter(s => !["intro", "conclusions", "sources", "chapter_conclusion"].includes(s.type));
  const special = {
    intro: sections.find(s => s.type === "intro") || null,
    conclusions: sections.find(s => s.type === "conclusions") || null,
    sources: sections.find(s => s.type === "sources") || null,
  };
  let chapConcs = sections.filter(s => s.type === "chapter_conclusion");
  let tmpCounter = 0;

  for (const op of ops) {
    switch (op.op) {
      case "rename": {
        if (["intro", "conclusions", "sources"].includes(op.id)) {
          if (special[op.id]) special[op.id] = { ...special[op.id], label: op.newLabel };
        } else {
          mainSecs = mainSecs.map(s => s.id === op.id ? { ...s, label: op.newLabel } : s);
        }
        break;
      }
      case "rename_chapter": {
        const target = mainSecs.find(s => s.id.split(".")[0] === String(op.chapterId));
        if (target) {
          const oldTitle = target.sectionTitle;
          const newTitle = `${chapterHeadingPrefix(lang, op.chapterId)}. ${op.newTitle}`;
          mainSecs = mainSecs.map(s => s.sectionTitle === oldTitle ? { ...s, sectionTitle: newTitle } : s);
          chapConcs = chapConcs.map(s => s.sectionTitle === oldTitle ? { ...s, sectionTitle: newTitle } : s);
        }
        break;
      }
      case "resize": {
        const newPages = Math.max(1, parseInt(op.newPages) || 1);
        const resize = (s) => ({ ...s, pages: newPages, prompts: s.type === "sources" ? 0 : Math.max(1, Math.ceil(newPages / 3)) });
        if (["intro", "conclusions", "sources"].includes(op.id)) {
          if (special[op.id]) special[op.id] = resize(special[op.id]);
        } else {
          mainSecs = mainSecs.map(s => s.id === op.id ? resize(s) : s);
        }
        break;
      }
      case "remove": {
        mainSecs = mainSecs.filter(s => s.id !== op.id);
        break;
      }
      case "add_subsection": {
        const chapterSecs = mainSecs.filter(s => s.id.split(".")[0] === String(op.chapterId));
        if (!chapterSecs.length) break;
        const sectionTitle = chapterSecs[0].sectionTitle;
        const type = chapterSecs[0].type;
        const pages = Math.max(1, parseInt(op.pages) || 3);
        const newSec = { id: `_new_${tmpCounter++}`, label: op.label || `[${lc.subsWord}]`, sectionTitle, pages, prompts: Math.max(1, Math.ceil(pages / 3)), type };
        const afterIdx = op.afterId ? mainSecs.findIndex(s => s.id === op.afterId) : -1;
        if (afterIdx >= 0) {
          mainSecs = [...mainSecs.slice(0, afterIdx + 1), newSec, ...mainSecs.slice(afterIdx + 1)];
        } else {
          let lastIdx = -1;
          mainSecs.forEach((s, i) => { if (s.id.split(".")[0] === String(op.chapterId)) lastIdx = i; });
          mainSecs = lastIdx >= 0
            ? [...mainSecs.slice(0, lastIdx + 1), newSec, ...mainSecs.slice(lastIdx + 1)]
            : [...mainSecs, newSec];
        }
        break;
      }
      case "add_chapter": {
        const maxCh = mainSecs.reduce((m, s) => Math.max(m, parseInt(s.id.split(".")[0]) || 0), 0);
        const chapNum = maxCh + 1;
        const chTypes = ["theory", "analysis", "recommendations"];
        const chType = chTypes[Math.min(chapNum - 1, chTypes.length - 1)];
        const sectionTitle = `${chapterHeadingPrefix(lang, chapNum)}. ${op.title || "[Назва розділу]"}`;
        const subsInput = op.subsections?.length ? op.subsections : [{}, {}, {}];
        const newSubs = subsInput.map((sub) => {
          const pages = Math.max(1, parseInt(sub.pages) || 3);
          return { id: `_new_${tmpCounter++}`, label: sub.label || `[${lc.subsWord}]`, sectionTitle, pages, prompts: Math.max(1, Math.ceil(pages / 3)), type: chType };
        });
        mainSecs = [...mainSecs, ...newSubs];
        break;
      }
      default: break;
    }
  }

  const pseudoPrev = [special.intro, special.conclusions, special.sources, ...chapConcs].filter(Boolean);
  const rebuilt = rebuildWithChapterConclusions(pseudoPrev, mainSecs);
  return renumberSections(rebuilt);
}

// ── Переписаний ШІ план (правки менеджера з CRM) → sections. ШІ повертає лише ТЕКСТ плану,
// усе інше — розбір, збереження сторінок, перерахунок джерел — робить код нижче. ──
const PLAN_NON_LEAF_TYPES = ["intro", "conclusions", "sources", "chapter_conclusion"];
const isLeafMainSection = (s) => !PLAN_NON_LEAF_TYPES.includes(s.type) && !s.headingOnly;
// "[4 стор.]" / "(4 стор.)" в кінці рядка підрозділу — обсяг, який бачить ШІ й може змінити
const PLAN_PAGES_MARK_RE = /\s*[[(]\s*(\d{1,2})\s*стор\.?\s*[\])]\s*$/i;
const PLAN_CHAPTER_LINE_RE = /^(\s*)(розділ|chapter|rozdział|cap[ií]tulo|kapitol[ao]|kapitel|chapitre|capitolo)(\s*)\d+/i;

// Ключ підрозділу для зіставлення зі старим планом: без номера, регістру й зайвих пробілів
export function planLabelKey(label) {
  return String(label || "").replace(/^\s*(?:[-–•]\s*)?\d+(?:\.\d+)*\.?\s*/, "").replace(/\s+/g, " ").trim().toLowerCase();
}

// buildPlanText + "[N стор.]" у рядках кінцевих підрозділів — вигляд плану для ШІ
// (менеджеру в CRM іде звичайний buildPlanText без обсягів).
export function buildPlanTextWithPages(sections) {
  const pagesByLabel = new Map();
  sections.filter(isLeafMainSection).forEach(s => { if (s.label && !pagesByLabel.has(s.label.trim())) pagesByLabel.set(s.label.trim(), s.pages); });
  return buildPlanText(sections).split("\n").map(line => {
    const pages = pagesByLabel.get(line.trim());
    return pages ? `${line} [${pages} стор.]` : line;
  }).join("\n");
}

// Однаковий вміст двох текстів плану (регістр, пробіли й порожні рядки не рахуються)
export function isSamePlanText(a, b) {
  const norm = (t) => String(t || "").split("\n").map(l => l.replace(/\s+/g, " ").trim().toLowerCase()).filter(Boolean).join("\n");
  return norm(a) === norm(b);
}

// Рівно target сторінок на пункти пропорційно до їхніх поточних обсягів (мінімум 1 на пункт)
function scalePagesToTarget(pages, target) {
  const base = pages.map(p => Math.max(1, p));
  const sum = base.reduce((a, b) => a + b, 0);
  if (sum === target) return base;
  const raw = base.map(p => (p / sum) * target);
  const out = raw.map(v => Math.max(1, Math.floor(v)));
  let diff = target - out.reduce((a, b) => a + b, 0);
  const byFrac = raw.map((v, i) => ({ i, frac: v - Math.floor(v) })).sort((a, b) => b.frac - a.frac);
  for (let k = 0; diff > 0; k++, diff--) out[byFrac[k % byFrac.length].i]++;
  while (diff < 0) {
    let big = 0;
    out.forEach((v, i) => { if (v > out[big]) big = i; });
    if (out[big] <= 1) break;
    out[big]--; diff++;
  }
  return out;
}

/**
 * Збирає sections із тексту плану (відредагованого менеджером або переписаного ШІ).
 * Від старого плану береться все, чого текст не несе: вступ/висновки/джерела як є (разом із
 * тим, чи вони взагалі є), а сторінки — для підрозділів зі збереженою назвою (або з явним
 * "[N стор.]" у тексті); решта ділить залишок. Сума сторінок лишається такою, як у старому
 * плані (обсяг замовлення не змінюється). Повертає null, якщо план не розібрався.
 * @returns {{sections:object[], planDisplay:string, sourceDist:object, sourceTotal:number}|null}
 */
export function rebuildPlanFromText(oldSections, text, lang = "Українська") {
  // Номери розділів у тексті — послідовні 1..N (ШІ міг помилитись у нумерації після вставки/видалення)
  let chapterNo = 0;
  const hints = [];
  const cleanText = String(text || "").split("\n").map(raw => {
    let line = raw;
    const mark = line.match(PLAN_PAGES_MARK_RE);
    if (mark) { line = line.replace(PLAN_PAGES_MARK_RE, ""); hints.push([planLabelKey(line), parseInt(mark[1], 10)]); }
    if (PLAN_CHAPTER_LINE_RE.test(line)) return line.replace(PLAN_CHAPTER_LINE_RE, (_, ind, word, gap) => `${ind}${word}${gap || " "}${++chapterNo}`);
    // Мова з набору ШІ: міняємо лише номер ("CAPITOLUL 3" / "3. FEJEZET")
    const dynRe = dynamicChapterLineRe();
    const dynM = dynRe ? line.trimStart().match(dynRe) : null;
    if (dynM) {
      const n = ++chapterNo;
      const indent = line.slice(0, line.length - line.trimStart().length);
      return indent + line.trimStart().replace(/\d+/, String(n));
    }
    return line;
  }).join("\n");

  const oldTotal = oldSections.reduce((n, s) => n + (s.pages || 0), 0);
  const parsed = parseClientPlan(cleanText, oldTotal || 1, lang);
  if (!parsed) return null;

  const queueOf = (pairs) => {
    const m = new Map();
    pairs.forEach(([k, p]) => { if (!m.has(k)) m.set(k, []); m.get(k).push(p); });
    return m;
  };
  const oldQueue = queueOf(oldSections.filter(isLeafMainSection).map(s => [planLabelKey(s.label), s.pages]));
  const hintQueue = queueOf(hints);

  const merged = parsed.flatMap(s => {
    if (["intro", "conclusions", "sources"].includes(s.type)) {
      const old = oldSections.find(o => o.type === s.type);
      return old ? [old] : []; // вступу/висновків/джерел у замовленні немає — не додаємо
    }
    if (!isLeafMainSection(s)) return [s];
    const key = planLabelKey(s.label);
    const fromText = hintQueue.get(key)?.shift();
    const fromOld = oldQueue.get(key)?.shift();
    return [{ ...s, _known: fromText ?? fromOld ?? null, _parsedPages: s.pages }];
  });

  const leaves = merged.filter(isLeafMainSection);
  const fixedTotal = merged.filter(s => !isLeafMainSection(s)).reduce((n, s) => n + (s.pages || 0), 0);
  const target = Math.max(leaves.length, oldTotal - fixedTotal);
  const knownPages = leaves.map(s => s._known).filter(p => p != null);
  const knownSum = knownPages.reduce((a, b) => a + b, 0);
  const unmatched = leaves.length - knownPages.length;
  let final;
  if (!oldTotal || !leaves.length) {
    final = leaves.map(s => s._known ?? s._parsedPages ?? 3);
  } else if (unmatched && target - knownSum >= unmatched) {
    // Нові/перейменовані пункти ділять залишок — обсяги незмінених пунктів не чіпаємо
    const base = Math.floor((target - knownSum) / unmatched);
    let rem = (target - knownSum) % unmatched;
    final = leaves.map(s => s._known ?? (base + (rem-- > 0 ? 1 : 0)));
  } else {
    // Усе зіставлено (видалили пункт, змінили обсяг) або залишку не вистачає — пропорційно до суми
    const filler = knownPages.length ? Math.max(1, Math.round(knownSum / knownPages.length)) : 3;
    final = scalePagesToTarget(leaves.map(s => s._known ?? filler), target);
  }
  let li = 0;
  const withPages = merged.map(s => {
    if (!isLeafMainSection(s)) return s;
    const { _known, _parsedPages, ...rest } = s;
    const pages = final[li++];
    return { ...rest, pages, prompts: Math.max(1, Math.ceil(pages / 3)) };
  });

  // label підрозділу має нести той самий номер, що й id (ШІ міг лишити старий номер)
  const numbered = withPages.map(s => (isLeafMainSection(s) || s.headingOnly) && /^\d+(?:\.\d+)+/.test(s.id) && /^\d+(?:\.\d+)+\.?\s/.test(s.label)
    ? { ...s, label: s.label.replace(/^\d+(?:\.\d+)+\.?\s+/, `${s.id} `) }
    : s);
  if (new Set(numbered.map(s => s.id)).size !== numbered.length) return null;

  // Порядок як у плані зі stage "plan": вступ → розділи → висновки → список джерел
  const sections = [
    ...numbered.filter(s => s.type === "intro"),
    ...numbered.filter(s => !["intro", "conclusions", "sources"].includes(s.type)),
    ...numbered.filter(s => s.type === "conclusions"),
    ...numbered.filter(s => s.type === "sources"),
  ];
  const { dist, total } = calcSourceDist(sections);
  return { sections, planDisplay: buildPlanText(sections), sourceDist: dist, sourceTotal: total };
}

// Абсолютний мінімум джерел за видом роботи й обсягом (нижче — генерація
// зупиняється й чекає на ручне дороблення, а не тихо триває з нестачею).
// Ціль підбору лишається рекомендованою кількістю (sourcesMinCount/needed,
// без змін) — це лише нижня межа, а не бажаний результат.
const SOURCES_MIN_TABLE = [
  { kw: "есе", min: 3, max: 5, count: 3 },
  { kw: "доповід", min: 5, max: 10, count: 5 },
  { kw: "реферат", min: 10, max: 15, count: 8 },
  { kw: "реферат", min: 16, max: 25, count: 10 },
  { kw: "тези", min: 2, max: 5, count: 3 },
  { kw: "наукова стаття", min: 6, max: 10, count: 8 },
  { kw: "курсов", min: 20, max: 25, count: 15 },
  { kw: "курсов", min: 26, max: 35, count: 20 },
  { kw: "курсов", min: 36, max: 50, count: 25 },
  { kw: "бакалавр", min: 40, max: 50, count: 30 },
  { kw: "бакалавр", min: 51, max: 70, count: 40 },
  { kw: "диплом", min: 50, max: 70, count: 40 },
  { kw: "диплом", min: 71, max: 100, count: 50 },
  { kw: "кваліфікаційн", min: 50, max: 70, count: 40 },
  { kw: "кваліфікаційн", min: 71, max: 100, count: 50 },
  { kw: "магістерськ", min: 60, max: 70, count: 50 },
  { kw: "магістерськ", min: 71, max: 90, count: 60 },
  { kw: "магістерськ", min: 91, max: 120, count: 70 },
  { kw: "практик", min: 20, max: 30, count: 10 },
  { kw: "практик", min: 31, max: 50, count: 15 },
];

export function getSourcesMinFromTable(workTypeLabel, totalPages) {
  const label = (workTypeLabel || "").toLowerCase();
  const pages = Number(totalPages) || 0;
  const row = SOURCES_MIN_TABLE.find(r => label.includes(r.kw) && pages >= r.min && pages <= r.max);
  return row ? row.count : null;
}

export function buildWorkConfig({ info, methodInfo, commentAnalysis }) {
  const totalPages = parsePagesAvg(info?.pages);

  let introPages = 2;
  if (methodInfo?.introPages) {
    introPages = methodInfo.introPages;
  } else if (commentAnalysis?.textStructureHints) {
    const m = commentAnalysis.textStructureHints.match(/вступ[^.\d]{0,20}(\d+)\s*стор/i);
    if (m && !/більше|максимум|перевищ/i.test(m[0])) introPages = parseInt(m[1]);
  }

  let conclusionsPages = totalPages > 40 ? 3 : 2;
  if (methodInfo?.conclusionsPages) {
    conclusionsPages = methodInfo.conclusionsPages;
  } else if (commentAnalysis?.textStructureHints) {
    const m = commentAnalysis.textStructureHints.match(/висновк[^.\d]{0,20}(\d+)\s*стор/i);
    if (m && !/більше|максимум|перевищ/i.test(m[0])) conclusionsPages = parseInt(m[1]);
  }

  const sourcesMinCount = methodInfo?.sourcesMinCount || (totalPages >= 40 ? 40 : 20);
  const sourcesMinRequired = methodInfo?.sourcesMinCount || getSourcesMinFromTable(info?.type, totalPages) || sourcesMinCount;

  return {
    totalPages,
    introPages,
    conclusionsPages,
    chapConclusionPages: 1,
    sourcesMinCount,
    sourcesMinRequired,
    sourcesStyle: methodInfo?.sourcesStyle || (/APA/i.test((methodInfo?.otherRequirements || "") + " " + (methodInfo?.citationStyle || "")) ? "APA" : /MLA/i.test((methodInfo?.otherRequirements || "") + " " + (methodInfo?.citationStyle || "")) ? "MLA" : "ДСТУ 8302:2015"),
    sourcesOrder: methodInfo?.sourcesOrder || "alphabetical",
    sourcesGrouping: methodInfo?.sourcesGrouping || "",
    citationStyle: methodInfo?.citationStyle || "(Автор, рік)",
  };
}
