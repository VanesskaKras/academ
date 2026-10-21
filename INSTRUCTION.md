# Academic Assistant — Інструкція для відтворення

## Що це за програма

Веб-застосунок для автоматичного написання академічних робіт (курсових, дипломних, рефератів) українською мовою. Користувач вводить дані замовлення — система генерує план, пише текст посекційно, знаходить джерела та експортує готову роботу у DOCX/PPTX.

---

## Технологічний стек

- **Frontend**: React 18 (JSX, hooks, без Redux)
- **БД та авторизація**: Firebase (Firestore + Firebase Auth)
- **AI**: Claude API (Anthropic) + Google Gemini API
- **Експорт**: docx (npm), pptx (npm)
- **Стилі**: Tailwind CSS або власний CSS (немає ui-фреймворку)

---

## Архітектура файлів

```
src/
  academic-assistant.jsx      # Головний компонент (весь state, вся логіка)
  App.jsx                     # Router: Login / Dashboard / AcademAssist
  Dashboard.jsx               # Список замовлень користувача
  AuthContext.jsx             # Firebase Auth контекст
  LoginPage.jsx               # Сторінка входу
  AdminPage.jsx               # Адмін-панель
  firebase.js                 # Ініціалізація Firebase

  lib/
    api.js                    # callClaude(), callGemini(), MODEL, MODEL_FAST
    prompts.js                # buildSYS(), SYS_JSON, METHODOLOGY_READING_PROMPT, buildTemplateAnalysisPrompt(), buildCommentAnalysisPrompt()
    planUtils.js              # FIELD_LABELS, isPsychoPed(), isEcon(), STAGES, STAGE_KEYS, parsePagesAvg(), buildPlanText(), calcSourceDist(), buildWorkConfig(), parseClientPlan()
    exportDocx.js             # exportToDocx(), exportPlanToDocx(), exportAppendixToDocx(), exportSpeechToDocx(), renumberTablesAndFigures()
    exportPptx.js             # exportToPptxFile()
    sourcesSearch.js          # searchSourcesForSection(), buildSemanticKeywords(), enrichSources(), paperToCitation()
    pageUtils.js              # normalizePages(), parseRefPages(), extractPagesFromDoi() — сторінки як дані
    sourceMatch.js            # isSameWork() — суворий збіг "той самий твір" (назва + автор + рік)
    citationFormatting.js     # список джерел + посилання в тексті: parseCitationInner(), applyCitationRemap()
    contentPages.js           # buildContentPagePickers() — сторінка в посиланні за змістом PDF
    firestoreUtils.js         # serializeForFirestore()
    audio.js                  # playDoneSound()

  components/
    SpinDot.jsx               # Спінер та шиммер
    StagePills.jsx            # Навігація по кроках
    Buttons.jsx               # FieldBox, Heading, NavBtn, PrimaryBtn, GreenBtn, SaveIndicator
    StructurePreview.jsx      # Превью структури плану
    PlanLoadingSkeleton.jsx   # Скелетон завантаження плану
    DropZone.jsx              # Дропзона для PDF (методичка)
    PhotoDropZone.jsx         # Дропзона для фото (клієнтські вимоги)
    ClientPlanInput.jsx       # Поле введення готового плану від клієнта

    stages/
      InputStage.jsx          # Крок 1: Введення даних замовлення
      ParsedStage.jsx         # Крок 2: Перегляд розпізнаних даних
      PlanStage.jsx           # Крок 3: Перегляд та редагування плану
      WritingStage.jsx        # Крок 4: Генерація тексту
      SourcesStage.jsx        # Крок 5: Пошук та введення джерел
      DoneStage.jsx           # Крок 6: Фінальний перегляд і експорт
```

---

## Стани (state) головного компонента

`AcademAssist` отримує пропси: `orderId`, `onOrderCreated`, `onBack`.

Ключові стани:

| State | Тип | Призначення |
|---|---|---|
| `stage` | string | Поточний крок: "input" / "parsed" / "plan" / "writing" / "sources" / "done" |
| `workflowMode` | string | "text-first" або "sources-first" |
| `info` | object | Розпізнані дані замовлення (topic, type, pages, subject, language, deadline, workCategory та ін.) |
| `tplText` | string | Сирий текст шаблону замовлення |
| `comment` | string | Коментар клієнта |
| `clientPlan` | string | Готовий план від клієнта (необов'язково) |
| `fileB64` | string | Base64 PDF методички |
| `fileLabel` | string | Ім'я файлу методички |
| `fileType` | string | MIME-тип файлу |
| `photos` | array | Фото від клієнта [{name, b64, type}] |
| `methodInfo` | object | Структурна інфо з методички (витягується Gemini) |
| `commentAnalysis` | object | {planHints, writingHints, textStructureHints, photoTOC} |
| `sections` | array | Масив підрозділів плану [{id, label, sectionTitle, pages, type, prompts}] |
| `planDisplay` | string | Текстове відображення плану |
| `content` | object | {sectionId: "текст підрозділу"} |
| `genIdx` | number | Індекс поточного підрозділу при генерації |
| `running` | bool | Чи виконується AI-запит |
| `paused` | bool | Генерацію призупинено |
| `citInputs` | object | {sectionId: "список цитат/джерел"} |
| `refList` | array | Фінальний список джерел |
| `abstractsMap` | object | {цитата: анотація джерела} |
| `speechText` | string | Текст доповіді |
| `appendicesText` | string | Текст додатків |
| `slideJson` | object | JSON для презентації |
| `titlePage` | string | Титульна сторінка (текст) |
| `titlePageLines` | array | Титульна сторінка з форматуванням [{text, bold, center}] |
| `sessionCost` | object | {claude: number, gemini: number} — витрати сесії |

---

## Кроки (stages) та логіка переходів

### Режим text-first (за замовчуванням)
```
input → parsed → plan → writing → sources → done
```

### Режим sources-first
```
input → parsed → plan → sources → writing → done
```

---

## Детальний опис кожного кроку

### Крок 1: InputStage ("input")

**Що відображається:**
- Текстове поле для вставки тексту замовлення (`tplText`)
- Текстове поле для коментаря клієнта (`comment`)
- Текстове поле для готового плану клієнта (`clientPlan`) — необов'язково
- Дропзона для завантаження PDF-методички (`DropZone`)
- Дропзона для фото клієнта (`PhotoDropZone`) — необов'язково
- Кнопка "Аналізувати"

**Функція `doAnalyze()`:**

1. Викликає `callClaude` з `buildTemplateAnalysisPrompt(tplText, comment)` → отримує JSON з полями замовлення
2. Парсить і зберігає в `info` (topic, type, pages, subject, direction, language, deadline, workCategory тощо)
3. Автодетектує `workCategory` за регекспом якщо не задано явно:
   - Економічне: економ, фінанс, менедж, облік, маркет, бізнес тощо
   - Біологічне: біолог, медицин тощо
   - Технічне: техн, інформ, програм, IT тощо
   - Гуманітарне: всі інші
4. Якщо завантажено PDF-методичку: викликає `callGemini` з `METHODOLOGY_READING_PROMPT` → отримує `methodInfo`
5. `methodInfo` містить: `totalPages, introPages, conclusionsPages, chaptersCount, subsectionsPerChapter, hasChapterConclusions, chapterTypes, exampleTOC, introComponents, introStructureHasChapterDetail, theoryRequirements, analysisRequirements, conclusionsRequirements, chapterConclusionRequirements, otherRequirements, requiredFormulas, requiredTables, formatting.tableFormat, formatting.figureFormat, titlePageTemplate`
6. Якщо є `titlePageTemplate` у методичці — підставляє тему і рік в шаблон титульної сторінки
7. Якщо є коментар або фото — викликає `callClaude` з `buildCommentAnalysisPrompt()` → `commentAnalysis`
8. Зберігає в Firestore. Переходить до `stage = "parsed"`

---

### Крок 2: ParsedStage ("parsed")

**Що відображається:**
- Редаговані поля для всіх розпізнаних даних замовлення (`info`)
- Поля: тема, тип роботи, к-сть сторінок, галузь, мова, дедлайн, унікальність, доп.вимоги
- `FieldBox` — кожне поле як редагована форма
- Якщо є `methodInfo` — показати індикатор "методичка прочитана"
- Якщо є `commentAnalysis.planHints` — показати блок підказок до плану
- Кнопка "Згенерувати план"

---

### Крок 3: PlanStage ("plan")

**Що відображається:**
- `StructurePreview` — деревоподібна структура плану з редагуванням назв і сторінок
- `planDisplay` — текстове відображення плану
- Кнопки: "Перерахувати сторінки", "Додати розділ", "Придумати назви"
- Перемикач режиму: text-first / sources-first
- Кнопка "Почати написання"

**Функція `doGenPlan()`:**

Пріоритет джерел плану (від вищого до нижчого):

1. **Готовий план клієнта** (`clientPlan`) → `parseClientPlan()` → якщо отримано >3 розділів — використати
2. **Фото з планом** (`commentAnalysis.photoTOC`) → адаптувати структуру, згенерувати нові назви через Gemini
3. **Текстовий приклад у коментарі** (містить "розділ N") → адаптувати структуру через Gemini
4. **Методичка** (`methodInfo`) → побудувати план за параметрами методички через Gemini
5. **Дефолтний план** (`buildDefaultPlan()`) → Claude іменує підрозділи

**Структура об'єкта секції:**
```js
{
  id: "1.1",                        // "intro" | "conclusions" | "sources" | "N.M" | "N.conclusions"
  label: "1.1 Назва підрозділу",    // відображається в документі
  sectionTitle: "РОЗДІЛ 1. НАЗВА",  // назва батьківського розділу
  pages: 8,                         // кількість сторінок
  type: "theory",                   // theory | analysis | recommendations | chapter_conclusion | intro | conclusions | sources
  prompts: 3,                       // кількість AI-запитів = ceil(pages/3)
}
```

**Типи секцій:**
- `theory` — теоретичний підрозділ (розділ 1)
- `analysis` — аналітичний/практичний (розділ 2)
- `recommendations` — рекомендаційний (розділ 3)
- `chapter_conclusion` — висновки до розділу (id: "1.conclusions")
- `intro` — ВСТУП
- `conclusions` — ВИСНОВКИ
- `sources` — СПИСОК ВИКОРИСТАНИХ ДЖЕРЕЛ

**Дефолтний розподіл сторінок:**
- До 40 стор: 2 розділи × 3 підрозділи
- Від 40 стор: 3 розділи × 3 підрозділи
- Вступ: 2-3 стор, Висновки: 2-3 стор
- Основна частина: 80% від загального

**Функція `recalcPages()`** — перераховує сторінки рівномірно між підрозділами

**Функція `addNewChapter()`** — додає новий розділ з 3 підрозділами-заглушками

**Функція `doNamePlaceholders()`** — Claude іменує заглушки "[Новий підрозділ]"

---

### Крок 4: WritingStage ("writing")

**Що відображається:**
- Progress bar по секціям
- Поточна секція що генерується
- Кнопки: "Пауза" / "Продовжити", "Зупинити"
- Список вже згенерованих секцій з можливістю перегляду і регенерації

**Логіка генерації (useEffect на `genIdx`):**
- Перебирає `sections[genIdx]`
- Якщо вже є `content[sec.id]` — пропускає
- Секцію типу `sources` — заповнює заглушкою
- Якщо йдуть емпіричні підрозділи і `appendicesText` ще не готовий — чекає
- Викликає `runSection(sec)`

**Функція `runSection(sec)`:**

Будує `instruction` залежно від типу секції:

- **`intro`**: детальна структура вступу (актуальність, мета, завдання, об'єкт, предмет, методи, структура) — кожен компонент як окремий абзац із заданими зачинами. Перелік компонентів береться з `methodInfo.introComponents` або дефолтний.

- **`conclusions`**: правила без нумерації — суцільні абзаци, один абзац = один результат. Контекст всіх розділів передається до AI. Заборонені нумеровані списки.

- **`chapter_conclusion`**: "Висновки до розділу N" — 4-5 абзаців, підсумок підрозділів цього розділу

- **`theory`**: теоретичний — визначення, огляд літератури, наукові підходи

- **`analysis`**: аналітично-практичний — дані, закономірності, порівняння. Для економічних робіт (`isEcon()`) — обов'язкові таблиці Markdown з числовими даними, формули з методички.

- **`recommendations`**: рекомендаційний — практичні пропозиції, прогнози

- **Психолого-педагогічні роботи** (`isPsychoPed()`): емпіричні підрозділи отримують контекст додатків (анкети, бланки) — передається `appendicesText`

Виклик AI: `callClaude` з системним промптом `buildSYS(lang, methodInfo)`.

Системний промпт (`buildSYS`) забороняє:
- Markdown (крім таблиць)
- Жирний шрифт
- Посилання у тексті
- Тире (em dash)
- Двокрапки поза вступом
- Крапки з комою
- Слова: аспект, важливий, особливий, значущий, ключовий, критичний, фундаментальний
- Англійські слова у тексті (крім посилань [N])
- Російських/білоруських авторів

Після завершення всіх секцій:
- text-first → переходить до `stage = "sources"`
- sources-first → залишається на writing, очікує `remapCitations`

**Регенерація секції** (`regenId`, `regenPrompt`): користувач може дати інструкцію і перегенерувати будь-яку секцію.

**Регенерація всіх** (`regenAllLoading`): перегенерує всі секції послідовно.

---

### Крок 5: SourcesStage ("sources")

**Що відображається:**
- По кожній секції: поле для введення джерел
- Кнопка "Знайти джерела" (для кожної секції окремо)
- Знайдені джерела з анотаціями
- Кнопка "Зібрати всі джерела" → генерує `refList`
- Поле для ручного коригування

**Функція `searchSourcesForSection()`** (з `sourcesSearch.js`):
- Будує семантичні ключові слова через `buildSemanticKeywords()`
- Шукає джерела через зовнішні API або Gemini
- Повертає список джерел з анотаціями

**Логіка пошуку:**
- Пошук прив'язаний до теми дипломної роботи
- Чергується "anchor mode" між пошуковими запитами
- Кожен перезапуск збільшує `searchPageCount[secId]` → інший набір ключових слів

**Збір джерел:**
- Формує `refList` — пронумерований список у ДСТУ-стилі
- Зберігає `citInputs` — посилання по секціям
- Зберігає `abstractsMap` — {цитата → анотація}

---

### Крок 6: DoneStage ("done")

**Що відображається:**
- Повний текст роботи по секціям з редагуванням
- Фінальний список джерел
- Пошук рисунків: `doScanAndGenFigures()` — сканує текст на "Рис. X.Y", генерує ключові слова для пошуку зображень
- Кнопки експорту:
  - "Скачати DOCX" (`exportToDocx`)
  - "Скачати план DOCX" (`exportPlanToDocx`)
  - "Скачати додатки DOCX" (`exportAppendixToDocx`)
  - "Скачати доповідь DOCX" (`exportSpeechToDocx`)
  - "Скачати презентацію PPTX" (`exportToPptxFile`)
- Генерація доповіді (`speechText`)
- Генерація презентації (`slideJson` → PPTX)
- Генерація додатків (`appendicesText`) — запускається у фоні при старті writing

---

## Збереження в Firestore

Колекція: `orders/{orderId}`

Поля документа:
```js
{
  uid,              // userId
  topic, type, pages, deadline,  // з info
  createdAt, updatedAt,
  tplText, comment, clientPlan,
  info,             // повний об'єкт info
  methodInfo,       // з методички
  commentAnalysis,
  fileLabel,
  sections,
  content,          // {sectionId: text}
  citInputs,        // {sectionId: citations}
  abstractsMap,
  refList,
  speechText,
  appendicesText,
  titlePage,
  titlePageLines,
  slideJson,
  presentationReady,
  workflowMode,
  stage,
  genIdx,
  status,           // "new" | "plan_ready" | "writing" | "done"
}
```

Авто-збереження: debounce 1500ms на `citInputs` при stage="sources".

---

## Системний промпт AI (buildSYS)

Налаштовується під мову роботи (укр/англ) і `methodInfo`.

**Забороняє:**
- Markdown (окрім таблиць)
- Жирний шрифт у тексті підрозділів
- Тире будь-якого виду (em dash, en dash) — крім підписів таблиць/рисунків
- Крапки з комою
- Двокрапки (лише у ВСТУП дозволено)
- Слова: аспект, важливий, особливий, значущий, ключовий, критичний, фундаментальний
- Англомовні слова у тексті (виняток: посилання [N] з латинськими прізвищами)
- Іноземні терміни — замінювати українськими відповідниками
- Російських/білоруських авторів і джерел
- Вигадані імена авторів ("Іванов А. стверджує...") — тільки безособові форми

**Правила таблиць:**
- Перед кожною таблицею: `Таблиця X.Y – Назва` (де X — номер розділу, Y — порядковий)
- У тексті перед таблицею — обов'язкове посилання "наведено в Таблиці X.Y"
- Формат: Markdown з `|---|---|`

**Правила рисунків:**
- Плейсхолдер: `Рис. X.Y – Назва` (окремий рядок)
- У тексті перед плейсхолдером — посилання "показано на Рис. X.Y"

**Стиль письма:**
- Короткі чіткі речення
- Чергування довжини абзаців (3-4 речення з 5-7)
- Заборонені абзаци з 1-2 речень
- Природній академічний тон без пафосу
- Приклади для теоретичних положень

---

## Експорт DOCX (exportDocx.js)

**`exportToDocx(content, sections, info, refList, titlePageLines, methodInfo)`**

- Генерує повний DOCX
- Перед експортом викликає `renumberTablesAndFigures()` — перенумеровує таблиці і рисунки по розділам (Таблиця X.Y де X — розділ)
- Включає: титульну сторінку, зміст, всі розділи з підрозділами, список джерел
- Форматування: Times New Roman 14pt, відступи, поля
- Таблиці Markdown → реальні таблиці DOCX
- Рисунки-плейсхолдери → залишаються як текст

**`exportPlanToDocx(sections, info)`** — тільки план (зміст)

**`exportAppendixToDocx(appendicesText, info)`** — додатки окремим файлом

**`exportSpeechToDocx(speechText, info)`** — доповідь окремим файлом

---

## Спеціальна логіка для типів робіт

### Психолого-педагогічні роботи (`isPsychoPed`)
Умова: workCategory="Гуманітарне" + напрям містить "психол" або "педагог"

- Емпіричний розділ (де є анкетування, вибірка, результати) отримує ширший контекст
- Перед генерацією емпіричного розділу чекає на `appendicesText` (анкети, бланки)
- Додатки генеруються у фоні при старті writing через `doGenAppendices()`

### Економічні роботи (`isEcon`)
Умова: workCategory="Економічне" або напрям містить економ/фінанс/менедж/облік/маркет тощо

- Аналітичні і рекомендаційні підрозділи обов'язково містять таблиці з числовими даними
- Якщо в методичці є `requiredFormulas` — підставляє реалістичні числа і розраховує
- Якщо є `requiredTables` — відтворює структуру з методички

---

## API функції (lib/api.js)

```js
// Виклик Claude
callClaude(messages, signal, systemPrompt, maxTokens, onStream, model)

// Виклик Gemini  
callGemini(messages, signal, systemPrompt, maxTokens, onStream, model, jsonMode)

// Константи моделей
MODEL       // основна модель Claude (claude-sonnet або claude-opus)
MODEL_FAST  // швидка модель для JSON-задач (claude-haiku)
```

Функції генерують подію `window.dispatchEvent(new CustomEvent("apicost", {detail: {cost, model}}))` для підрахунку вартості сесії.

---

## Пошук джерел (lib/sourcesSearch.js)

**`buildSemanticKeywords(section, info, pageNum)`**
- Будує набір ключових слів на основі теми роботи і конкретного підрозділу
- `pageNum` визначає набір ключових слів (різний при кожному перезапуску)

**`searchSourcesForSection(section, info, anchors, pageCount)`**
- Шукає академічні джерела
- Підтримує "anchor mode" — чергування пошукових запитів
- Повертає [{title, authors, year, journal, abstract, citation}]

---

## Сторінки джерел: від пошуку до посилання в тексті

1. **Витягування** (`enrichSources`): сторінки з бази пошуку (OpenAlex biblio, CrossRef page,
   DOAJ start/end_page, Semantic Scholar journal.pages) → DOI за описом (для Scholar/CORE теж,
   лише той самий твір — `isSameWork`) → метадані за DOI → мета-теги сторінки журналу
   (`/api/fetch-meta`: citation_*, DC.Identifier.pageNumber, prism, eprints, JSON-LD) → номери в
   колонтитулах PDF статті (`/api/pdf-pages`) → останній шанс — кінець DOI (позначка "перевірити").
   Книги — загальний обсяг (`totalPages`, "240 с."), не сторінки. PDF без жодного номера —
   `noPages` (електронне видання, цитується без "С.").
2. **Перевірка** (`normalizePages`): відкидає "e12345", нулі попереду, рік замість сторінки,
   діапазон усього номера (>100 с.), "рік-випуск-стаття" з кінця DOI. `pagesSrc` — звідки сторінки
   (показується в картці джерела).
3. **Список**: `paperToCitation` пише "С. 12–19." / "240 с."; після ЛЛМ-оформлення
   `restoreLostPages` повертає загублені чи змінені сторінки кодом.
4. **Посилання в тексті**: модель пише лише `[N]`/`[2; 3]`; сторінку ставить `applyCitationRemap`
   з діапазону (`extractPageRange`, строгий розбір `parseRefPages`), різну для повторних посилань;
   з перемикачем "Сторінка за змістом PDF" — сторінку, де в PDF найбільше збігів з реченням.
   Вимога методички (`detectInTextPagePolicy`): "[N]" — без сторінок, "[N, с. X]" — обов'язкові.
   Усі місця, що читають посилання, йдуть через `parseCitationInner` (групи зі сторінками теж).
5. **Замір**: `node scripts/measurePages.mjs` (Firestore, лише читання); після деплою —
   `WORKER_PROXY_TOKEN=… node scripts/checkSources.mjs` (перевіряє й `/api/pdf-pages`).

---

## Перенумерація таблиць і рисунків (exportDocx.js)

**`renumberTablesAndFigures(content, displayOrder)`**
- Проходить по всім секціям в порядку відображення
- Лічить таблиці і рисунки по розділам
- Перейменовує `Таблиця 1.1 → Таблиця 1.2` якщо нумерація збилась
- Оновлює всі посилання у тексті
- Використовує token-based підхід щоб уникнути подвійної заміни

---

## Компоненти UI

### StagePills
Відображає кроки прогресу. Пропси: `stages`, `stageKeys`, `currentStage`, `maxStageIdx`, `onNavigate`.

Дозволяє навігацію тільки до кроків ≤ `maxStageIdx`. Під час генерації (`running=true`) навігація заблокована.

### StructurePreview
Деревоподібне відображення плану. Підтримує:
- Inline-редагування назв підрозділів
- Редагування кількості сторінок
- Drag-and-drop (необов'язково)
- Видалення підрозділів

### DropZone / PhotoDropZone
- Drag-and-drop або click для вибору файлу
- DropZone: приймає PDF → конвертує у base64
- PhotoDropZone: приймає зображення → масив [{name, b64, type}]

### SaveIndicator
Показує стан збереження: "зберігається..." / "збережено ✓"

---

## Важливі деталі реалізації

1. **Паузи між API-запитами**: `await new Promise(r => setTimeout(r, 2000))` між послідовними викликами щоб не перевищити rate limit

2. **AbortController**: кожен `runSection` створює `new AbortController()`, ref зберігається в `abortRef` → зупинка через `abort()`

3. **contentRef**: `useRef` синхронізується з `content` через `useEffect` — потрібно щоб читати актуальний контент всередині async функцій

4. **runningRef**: аналогічно для `running` — щоб useEffect не запускав паралельні генерації

5. **Merge Firestore**: `setDoc(ref, data, {merge: true})` замість `updateDoc` — не потрібен `getDoc` перед записом

6. **serializeForFirestore**: рекурсивно видаляє `undefined` значення (Firestore не приймає)

7. **Додатки у фоні**: `doGenAppendices()` викликається без await при старті writing — генерується паралельно з першими підрозділами

8. **sessionCost**: зберігається в localStorage, оновлюється через window events

9. **Заповнення титульної сторінки**: при аналізі методички якщо є `titlePageTemplate` — підставляється тема (`[ТЕМА]`, `(найменування теми)`) і рік (`[РІК]`, всі `20XX`)

10. **Merge split-year рядків**: після заповнення титульної сторінки зливає рядки типу "Місто – 202" + "6" → "Місто – 2026"

---

## Workflow генерації плану (повний алгоритм)

```
doGenPlan()
  │
  ├── clientPlan є і парситься → finalizeSections()
  │
  ├── commentAnalysis.photoTOC є → Gemini адаптує структуру → finalizeSections()
  │
  ├── comment містить "розділ N" → Gemini адаптує структуру → finalizeSections()
  │
  ├── methodInfo є → Gemini генерує план за параметрами методички → finalizeSections()
  │
  └── Дефолт: buildDefaultPlan() → Claude іменує підрозділи → finalizeSections()

finalizeSections(secs)
  ├── Обчислює prompts = ceil(pages/3) для кожної секції
  ├── calcSourceDist() → sourceDist, sourceTotal
  ├── Оновлює info.sourceCount
  └── saveToFirestore()
```

---

## Workflow генерації тексту (повний алгоритм)

```
startGen(mode)
  ├── Сортує sections за ORDER: theory → analysis → recommendations → chapter_conclusion → intro → conclusions → sources
  ├── Скидає content, genIdx=0
  ├── Запускає doGenAppendices() у фоні
  └── Переходить до stage="writing" або "sources"

useEffect [genIdx] →
  ├── sections[genIdx] вже є в content → genIdx++
  ├── тип "sources" → заповнює заглушку → genIdx++
  ├── емпіричний підрозділ + appendicesText ще не готовий → чекає
  └── runSection(sec)
        ├── Будує instruction залежно від sec.type
        ├── Додає контекст попередніх секцій (prevCtx)
        ├── callClaude(messages, signal, buildSYS(lang, methodInfo))
        ├── content[sec.id] = result
        ├── genIdx++
        └── saveToFirestore() (кожні N секцій)
```

---

## Що НЕ описано і потрібно реалізувати самостійно

- Конкретний UI/дизайн компонентів (кольори, розміри, анімації)
- Реалізація `callClaude` і `callGemini` (залежить від вашого API ключа і обгортки)
- Реалізація `searchSourcesForSection` (потрібен зовнішній API для академічних джерел або Gemini)
- Firebase конфігурація (свій проєкт)
- `exportToDocx` / `exportToPptxFile` — деталі форматування DOCX/PPTX
- `buildTemplateAnalysisPrompt` і `buildCommentAnalysisPrompt` — конкретні промпти для аналізу замовлення
- Авторизація і Dashboard (список замовлень)
