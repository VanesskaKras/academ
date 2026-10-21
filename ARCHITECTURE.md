# Детальний опис архітектури academ-assist

> Дата: 2026-04-14

---

## Зміст

1. [Загальна архітектура](#1-загальна-архітектура)
2. [Структура файлів](#2-структура-файлів)
3. [Маршрутизація](#3-маршрутизація)
4. [Великі роботи — 6 стейджів](#4-великі-роботи--6-стейджів)
   - 4.1 [InputStage — введення даних](#41-inputstage--введення-даних)
   - 4.2 [ParsedStage — аналіз шаблону](#42-parsedstage--аналіз-шаблону)
   - 4.3 [PlanStage — структура роботи](#43-planstage--структура-роботи)
   - 4.4 [WritingStage — генерація тексту](#44-writingstage--генерація-тексту)
   - 4.5 [SourcesStage — джерела](#45-sourcesstage--джерела)
   - 4.6 [DoneStage — фінальний вивід](#46-donestage--фінальний-вивід)
5. [Малі роботи](#5-малі-роботи)
6. [API виклики (api.js)](#6-api-виклики-apijs)
7. [Системний промпт buildSYS](#7-системний-промпт-buildsys)
8. [DOCX Export детально](#8-docx-export-детально)
9. [PPTX Export детально](#9-pptx-export-детально)
10. [Бібліотека утиліт (planUtils.js)](#10-бібліотека-утиліт-planutilsjs)
11. [Firestore — структура даних](#11-firestore--структура-даних)
12. [Трекінг вартості API](#12-трекінг-вартості-api)
13. [Компоненти UI](#13-компоненти-ui)
14. [Повний Data Flow (схема)](#14-повний-data-flow-схема)

---

## 1. Загальна архітектура

```
Клієнт (React 19 + Vite)
  │
  ├── /api/claude.js   ← Vercel Serverless Function (ANTHROPIC_API_KEY)
  ├── /api/gemini.js   ← Vercel Serverless Function (GEMINI_API_KEY)
  │
  └── Firebase Firestore ← збереження стану замовлень і юзерів
```

- **Фронтенд:** React 19, Vite, без CSS-фреймворку (inline styles)
- **Деплой:** Vercel (фронт + serverless API)
- **Auth:** Firebase Authentication
- **База даних:** Firebase Firestore
- **AI-моделі:** Claude Sonnet 4.6 (основна), Claude Haiku 4.5 (швидкі задачі), Gemini 2.5 Flash Lite / 1.5 Flash

API-ключі **ніколи не потрапляють у клієнт** — всі запити до AI проходять через `/api/claude.js` і `/api/gemini.js`.

---

## 2. Структура файлів

```
academ-assist/
├── src/
│   ├── App.jsx                     ← Кореневий роутер (view: dashboard|admin|order)
│   ├── main.jsx                    ← React entry point (ReactDOM.createRoot)
│   ├── academic-assistant.jsx      ← Головний компонент великих робіт (~2252 рядки)
│   ├── small-works.jsx             ← Малі роботи (реферат, тези, стаття, есе, презентація)
│   ├── Dashboard.jsx               ← Список замовлень юзера
│   ├── LoginPage.jsx               ← Сторінка авторизації
│   ├── AdminPage.jsx               ← Адмін-панель (управління юзерами)
│   ├── AuthContext.jsx             ← React Context для Firebase Auth стану
│   ├── firebase.js                 ← Ініціалізація Firebase (app, auth, db)
│   ├── shared.jsx                  ← Утиліти для малих робіт (parsePagesAvg, styles)
│   │
│   ├── lib/
│   │   ├── smallStages.js          ← Headless потік малих робіт (order+ctx, без React) — для воркера
│   │   ├── api.js                  ← callClaude(), callGemini() — всі запити до AI
│   │   ├── prompts.js              ← buildSYS(), buildTemplateAnalysisPrompt(), і т.д.
│   │   ├── planUtils.js            ← parseTemplate(), parseClientPlan(), calcSourceDist(), і т.д.
│   │   ├── exportDocx.js           ← exportToDocx(), exportPlanToDocx(), exportSpeechToDocx(), exportSimpleDocx()
│   │   ├── exportPptx.js           ← exportToPptxFile()
│   │   ├── audio.js                ← playDoneSound() — звук/сповіщення після генерації
│   │   └── firestoreUtils.js       ← serializeForFirestore() (undefined → null)
│   │
│   └── components/
│       ├── Buttons.jsx             ← FieldBox, Heading, NavBtn, PrimaryBtn, GreenBtn, SaveIndicator
│       ├── SpinDot.jsx             ← Спінер + shimmer skeleton
│       ├── StagePills.jsx          ← Навігація по стейджах (таблетки зверху)
│       ├── StructurePreview.jsx    ← Попередній перегляд структури за замовчуванням
│       ├── DropZone.jsx            ← Завантаження PDF
│       ├── PhotoDropZone.jsx       ← Завантаження зображень
│       ├── ClientPlanInput.jsx     ← Вилучення плану з фото через Claude Vision
│       ├── PlanLoadingSkeleton.jsx ← Скелетон під час генерації плану
│       └── stages/
│           ├── InputStage.jsx      ← Стейдж 1: введення даних
│           ├── ParsedStage.jsx     ← Стейдж 2: перевірка вилучених даних
│           ├── PlanStage.jsx       ← Стейдж 3: перегляд і редагування плану
│           ├── WritingStage.jsx    ← Стейдж 4: генерація тексту розділів
│           ├── SourcesStage.jsx    ← Стейдж 5: джерела і бібліографія
│           └── DoneStage.jsx       ← Стейдж 6: фінал, завантаження файлів
│
├── api/
│   ├── claude.js                   ← Vercel API route: проксі до Anthropic API
│   └── gemini.js                   ← Vercel API route: проксі до Google Gemini API
│
├── public/                         ← Статичні файли
├── dist/                           ← Білд (після npm run build)
├── package.json
├── vite.config.js
├── index.html
├── .env                            ← Firebase config (публічні змінні)
└── .env.local                      ← API ключі (секретні, не в git)
```

---

## 3. Маршрутизація

**App.jsx** керує станом `view` ("dashboard" | "admin" | "order") і `currentMode` ("large" | "small").

```
Без auth  →  LoginPage
           ↓ (Firebase signIn)
З auth    →  AuthContext.Provider
               ↓
           Dashboard  (список замовлень)
             │  ← onOpen(id, "large"|"small")
             │  ← onNew("large"|"small")
             │  ← onAdmin()
             ↓
           ┌──────────────────┬──────────────────┬─────────────┐
           AcademAssist       SmallWorks          AdminPage
           (великі роботи)    (малі роботи)       (адмін)
```

**AcademAssist props:**
- `orderId` — ID існуючого замовлення (для відновлення з Firestore)
- `onOrderCreated(id)` — колбек коли створено нове замовлення
- `onBack()` — повернутися на Dashboard

---

## 4. Великі роботи — 6 стейджів

### 4.1 InputStage — введення даних

**Файл:** `src/components/stages/InputStage.jsx`

**Що показується юзеру:**
- Textarea для шаблону від викладача (`tplText`)
- Textarea для готового плану від студента (`clientPlan`)
- Textarea для додаткових коментарів (`comment`)
- DropZone для PDF методички
- PhotoDropZone для референсних зображень
- Кнопка "Аналізувати"

**Props:**
```js
{
  tplText, setTplText,        // шаблон
  clientPlan, setClientPlan,  // план студента
  comment, setComment,        // коментар
  fileLabel, fileB64,         // PDF методички (base64)
  methodInfo,                 // вже розпарсена методичка (якщо є)
  photos, setPhotos,          // масив зображень
  info,                       // розпарсений шаблон (якщо є)
  running, loadMsg,           // стан завантаження
  handleFile,                 // обробка PDF
  doAnalyze,                  // запускає аналіз (перехід на стейдж 2)
  setStage                    // переключення стейджу
}
```

**ClientPlanInput.jsx** — якщо юзер завантажує фото плану:
1. Зображення конвертується в base64
2. `callGemini([{role:"user", content:[{type:"image", ...}, {type:"text", text:"Витягни зміст..."}]}])`
3. Gemini повертає текст плану → вставляється в `clientPlan`

---

### 4.2 ParsedStage — аналіз шаблону

**Файл:** `src/components/stages/ParsedStage.jsx`

**Три паралельних API виклики в `doAnalyze()` (academic-assistant.jsx):**

#### Виклик 1: Аналіз шаблону (Claude)
```
System: SYS_JSON ("відповідай тільки валідним JSON")
User:   buildTemplateAnalysisPrompt(tplText, comment)
        → "Витягни з цього шаблону: тип роботи, кількість сторінок, тему,
           предмет, напрямок, унікальність, мову, дедлайн, примітки..."
```
**Повертає `info`:**
```js
{
  type: "курсова",          // тип роботи
  pages: "60-70",           // кількість сторінок
  topic: "...",             // тема роботи
  subject: "...",           // предмет
  direction: "...",         // спеціальність/напрямок
  uniqueness: "70",         // унікальність %
  language: "uk",           // мова ("uk" або "en")
  deadline: "2026-05-15",   // дедлайн
  extras: "...",            // додаткові вимоги
  methodNotes: "...",       // нотатки з методички
  sourceCount: "25",        // мінімум джерел
  workCategory: "..."       // категорія для логіки генерації
}
```

#### Виклик 2: Читання методички (Gemini)
```
User: [PDF file як base64 image/pdf] + METHODOLOGY_READING_PROMPT
      → "Прочитай методичку і витягни структурні вимоги..."
```
**Повертає `methodInfo`:**
```js
{
  totalPages: 60,
  introPages: 3,
  conclusionsPages: 3,
  chaptersCount: 3,
  sourcesMinCount: 25,
  sourcesStyle: "ДСТУ",           // ДСТУ | APA | MLA | тощо
  citationStyle: "author-year",
  formatting: {
    font: "Times New Roman",
    fontSize: 14,
    lineSpacing: 1.5,
    margins: {left: 30, right: 15, top: 20, bottom: 20},
    firstLineIndent: 1.25,
    tableCaption: "above",        // над/під таблицею
    figureCaption: "below"
  },
  exampleTOC: "...",              // приклад змісту з методички
  titlePageTemplate: "..."        // шаблон титульної сторінки
}
```

#### Виклик 3: Аналіз коментаря (Claude) — якщо є comment
```
System: SYS_JSON
User:   buildCommentAnalysisPrompt(topic, comment, photoCount)
        → "Проаналізуй цей коментар студента і витягни підказки для плану,
           структури тексту, написання, джерел..."
```
**Повертає `commentAnalysis`:**
```js
{
  planHints: "...",           // що врахувати при генерації плану
  textStructureHints: "...",  // структурні особливості розділів
  writingHints: "...",        // стиль/тон написання
  sourcesHints: "...",        // особливості джерел
  photoTOC: null              // TOC якщо в фото є план
}
```

**UI ParsedStage:**
- Сітка редагованих полів `info` (тема, тип, сторінки, унікальність...)
- Бейджі з `methodInfo` (формат, джерела, стиль)
- Відображення помилок
- Кнопка "Генерувати план" → переходить на стейдж 3

---

### 4.3 PlanStage — структура роботи

**Файл:** `src/components/stages/PlanStage.jsx`

**Генерація плану в `doGenPlan()` (academic-assistant.jsx):**

```
Якщо є clientPlan:
  sections = parseClientPlan(clientPlan, totalPages)
  ← конвертує текстовий план в масив секцій

Якщо немає clientPlan:
  Claude: System = buildSYS(language, methodInfo)
          User   = "Згенеруй план для [тип] роботи на тему '[topic]'
                    на [pages] сторінок, [chaptersCount] розділів.
                    Підказки: [commentAnalysis.planHints]"
  → повертає JSON масив секцій
```

**Об'єкт секції:**
```js
{
  id: "1.1",                          // "intro" | "conclusions" | "sources" | "1" | "1.1"
  label: "1.1 Теоретичні засади...",  // відображувана назва
  sectionTitle: "Розділ 1. ...",      // назва батьківського розділу
  type: "theory"                      // "theory" | "analysis" | "recommendations"
        | "analysis"                  //  | "intro" | "conclusions" | "sources"
        | "recommendations"           //  | "chapter_conclusion"
        | "intro"
        | "conclusions"
        | "sources",
  pages: 8,                           // кількість сторінок
  prompts: 3                          // кількість батчів генерації
}
```

**Автоматичні секції** (завжди додаються):
- `intro` — Вступ (~3 сторінки)
- `conclusions` — Висновки (~3 сторінки)
- `sources` — Список джерел

**`calcSourceDist(sections, overallPages)`** → `{dist: {sectionId: count}, total}`
- Розраховує скільки джерел потрібно цитувати в кожній секції
- Пропорційно до кількості сторінок

**UI PlanStage:**
- Текстовий вигляд плану (для копіювання)
- Таблиця: checkbox | назва (редагована) | сторінки (редаговані) | видалити
- Кнопки: "Додати підрозділ", "Додати розділ", "Перерахувати сторінки"
- Кнопка "Авто-назви" → Claude замінює плейсхолдери на реальні назви
- Кнопка "Завантажити план (.docx)"

---

### 4.4 WritingStage — генерація тексту

**Файл:** `src/components/stages/WritingStage.jsx`

**Основний цикл `startGen()` (academic-assistant.jsx):**

```
genIdx = 0
running = true

while (genIdx < sections.length && !aborted) {

  if (paused) → wait...

  section = sections[genIdx]

  1. systemPrompt = buildSYS(info.language, methodInfo)

  2. userPrompt = buildSectionPrompt(section, info, methodInfo, commentAnalysis)
     ← різні промпти залежно від section.type:
        - "intro"         → вступ: актуальність, мета, завдання, об'єкт, предмет, методи
        - "conclusions"   → висновки: узагальнення по кожному завданню
        - "theory"        → теоретичний підрозділ
        - "analysis"      → аналітичний з таблицями (якщо isEcon)
        - "recommendations" → практичні рекомендації
        - "chapter_conclusion" → висновки до розділу

  3. messages = [{role:"user", content: userPrompt}]

  4. text = await callClaude(messages, abortSignal, systemPrompt,
                              maxTokens = section.prompts * 2000,
                              onWait = (s) => setLoadMsg(`...${s}с`),
                              model = MODEL)
     ← стрімінг через SSE для maxTokens >= 2000

  5. content[section.id] = text

  6. await saveToFirestore({content, stage: "writing", status: "writing"})

  7. genIdx++
}

playDoneSound()  ← звук/браузерне сповіщення
```

**Особлива логіка за типом роботи:**

- **isPsychoPed(info)** → для психолого-педагогічних робіт:
  - Секції "analysis" отримують промпт про емпіричне дослідження
  - Пізніше генеруються анкети/тести в додатках

- **isEcon(info)** → для економічних робіт:
  - Секції "analysis" і "recommendations" отримують вказівку додавати таблиці з даними

**Регенерація секції `doRegenSection(section, customPrompt)`:**
```
1. regenLoading = true
2. prompt = buildSectionPrompt(section) + "\n\nДодаткова вимога: " + customPrompt
3. text = await callClaude(...)
4. content[section.id] = text
5. saveToFirestore({content})
6. regenLoading = false
```

**Регенерація всіх `doRegenAll()`:**
- Те саме що `startGen()` але з `regenAllAbortRef` для можливості зупинити

**UI WritingStage:**
- Прогрес-бар (виконано / всього секцій)
- Для кожної секції: кольоровий статус-дот + назва + сторінки + COPY + REGEN
- Поле для кастомного промпту при регенерації
- Кнопки: Пауза / Продовжити / Зупинити
- Прев'ю тексту (scrollable)

---

### 4.5 SourcesStage — джерела

**Файл:** `src/components/stages/SourcesStage.jsx`

**Крок 1: Генерація ключових слів `doGenKeywords()`:**
```
For each mainSection in sections:
  Claude: "Згенеруй 5 ключових слів для пошуку джерел
           до підрозділу '[label]' в контексті '[topic]'"
  → JSON масив ["слово1", "слово2", ...]

keywords = {sectionId: ["keyword1", ...], ...}
```

**Крок 2: Юзер вводить джерела:**
```
citInputs = {
  "1.1": "Прізвище А.Б. Назва книги...\nДруге джерело...",
  "1.2": "...",
  ...
}
```
Для кожної секції показується:
- Ключові слова (клікнути → копіюється)
- Посилання на Google Scholar
- Textarea для вставки сирих джерел
- Лічильник (введено / потрібно)

**Крок 3: Форматування бібліографії `doAddAllCitations()`:**
```
System: buildSYS() + citationStyle
User:   "Відформатуй ці джерела за стилем [ДСТУ/APA/MLA]:
         [всі введені джерела з'єднані разом]"
→ відформатований масив рядків refList[]
```

**UI SourcesStage:**
- Блок по кожному розділу з textarea
- Загальна бібліографія знизу
- Кнопка "Готово" → перехід на стейдж 6

---

### 4.6 DoneStage — фінальний вивід

**Файл:** `src/components/stages/DoneStage.jsx`

#### Завантаження основного DOCX

```
doExportDocx():
  1. docxLoading = true
  2. content = renumberTablesAndFigures(content, displayOrder)
     ← оновлює всі Таблиця X.Y і Рис. X.Y
  3. await exportToDocx({
       content,
       info,
       displayOrder,    ← порядок секцій: [intro, ...mainSections, conclusions, sources]
       appendicesText,  ← згенеровані додатки
       titlePage,       ← редагований текст титульної
       titlePageLines,  ← розпарсені рядки з methodInfo.titlePageTemplate
       methodInfo
     })
  4. docxLoading = false
```

#### Генерація та завантаження презентації

```
generatePresentation():
  КРОК 1 (Gemini):
    System: "Respond with valid JSON"
    User:   "Проаналізуй цю академічну роботу і згенеруй структуру слайдів.
             Структура: title, overview, [3 головні розділи], conclusions, thank_you.
             Контент: [перші 500 символів кожної секції]"
    → slideJson = {slides: [{layout, title, content, visual, stat?}, ...]}

  КРОК 2 (Claude):
    System: buildSYS()
    User:   "Збагати цю структуру слайдів детальним контентом:
             [slideJson]
             Для кожного слайду: конкретні цифри, факти, висновки з тексту."
    → збагачений slideJson

  КРОК 3:
    exportToPptxFile(slideJson, info)
    ← автовизначає тему, рендерить PPTX через PptxGenJS
```

#### Генерація промови

```
generateSpeech():
  Claude: System = buildSYS()
          User   = "Згенеруй текст захисту на 5-7 хвилин.
                    Структура: Привітання → Актуальність → Мета/завдання →
                    Теоретична база → Результати дослідження → Висновки →
                    Подяка комісії.
                    Джерело: [content ключових секцій]"
  → speechText (стрімінг)
  exportSpeechToDocx(speechText, info, methodInfo)
```

#### Генерація додатків

```
generateAppendices(customPrompt):
  Claude: System = buildSYS()
          User   = "Згенеруй дослідницькі додатки для роботи на тему '[topic]'.
                    [isPsychoPed → 'Включи анкету/тест']
                    [isEcon → 'Включи таблиці з вихідними даними']
                    [customPrompt якщо є]"
  → appendicesText (стрімінг)
  exportAppendixToDocx(appendicesText, info, methodInfo)
```

**UI DoneStage:**
- Редагована textarea для титульної сторінки
- Перегляд кожної секції: назва + COPY + REGEN
- Секція додатків з кнопкою генерації
- Панель відстеження рисунків (розкривна)
- Кнопки завантаження:
  - "Копіювати все" — весь текст в буфер
  - "Завантажити .docx" — основний документ
  - "Презентація .pptx" — презентація
  - "Промова .docx" — текст захисту
  - "Додатки .docx" — додатки окремо
- Кнопка "Нове замовлення" (скидає стан)

---

## 5. Малі роботи

**Файл:** `src/small-works.jsx`

**Типи:**
| Тип | Назва | Є план | Стейджів |
|-----|-------|--------|----------|
| `referat` | Реферат | так | 4 |
| `tezy` | Тези | ні | 3 |
| `stattia` | Стаття | ні | 3 |
| `ese` | Есе | ні | 3 |
| `prezentatsiya` | Презентація | ні | 3 |

**Флоу:**
```
Input → (PlanStage якщо referat) → Writing → Done
```

**Відмінності від AcademAssist:**
- Немає стейджу Sources
- Простіша структура секцій
- `exportSimpleDocx()` з `lib/exportDocx.js` (без ренумерації таблиць/рисунків)
- Для `prezentatsiya` → `exportToPptxFile()` напряму

---

## 6. API виклики (api.js)

**Файл:** `src/lib/api.js`

### callClaude

```js
async callClaude(
  messages,      // [{role: "user"|"assistant", content: string | ContentBlock[]}]
  signal,        // AbortSignal
  systemPrompt,  // string
  maxTokens,     // number (200–64000)
  onWait,        // (seconds: number) => void  ← при rate limit
  model          // опціонально, за замовчуванням MODEL ("claude-sonnet-4-6")
)
```

**ContentBlock для Vision:**
```js
content: [
  {type: "image", source: {type: "base64", media_type: "image/jpeg", data: "..."}},
  {type: "text", text: "Що зображено?"}
]
```

**Логіка:**
1. `maxTokens >= 2000` → **стрімінг** (Server-Sent Events)
2. Інакше → звичайний fetch, чекає повну відповідь
3. При 429 (rate limit) → ретрай:
   - Перший раз: чекає 12 секунд
   - Другий: 30 секунд
   - Третій+: 60 секунд
   - `onWait(seconds)` викликається кожну секунду для відображення відліку
4. При 400 → виводить "💳 Ліміт вичерпано"
5. Успішно → повертає рядок тексту

**Стрімінг:**
```
POST /api/claude
  ← "data: {...text chunk...}\n"  (SSE)
  ← "data: [DONE]\n"

Клієнт: reader = response.body.getReader()
        while chunk: text += decodeChunk(chunk)
```

**Трекінг токенів:**
```js
// В кінці кожного виклику:
window.dispatchEvent(new CustomEvent("apicost", {
  detail: {
    cost: (inputTokens * inputPrice + outputTokens * outputPrice),
    model: "claude-sonnet-4-6",
    inTok: inputTokens,
    outTok: outputTokens
  }
}))
```

**Ціни Claude:**
- Sonnet 4.6: вхід $3 / вихід $15 за 1M токенів
- Haiku 4.5: вхід $0.80 / вихід $4 за 1M токенів

---

### callGemini

```js
async callGemini(
  messages,      // те саме що в callClaude
  signal,
  systemPrompt,
  maxTokens,
  onWait,
  model,         // за замовчуванням "gemini-2.5-flash-lite"
  jsonMode       // bool → примушує JSON відповідь
)
```

**Fallback:** при 503 помилці автоматично перемикається на `gemini-1.5-flash`

**Ціни Gemini:**
- 2.5 Flash Lite: вхід $0.075 / вихід $0.30 за 1M токенів

---

## 7. Системний промпт buildSYS

**Файл:** `src/lib/prompts.js`

`buildSYS(lang, methodInfo)` генерує системний промпт з такими блоками:

### 1. Мова
```
Пиши ТІЛЬКИ українською мовою. (або: Write ONLY in English.)
```

### 2. Заборонені слова
```
НЕ використовуй слова: "аспект", "важливий", "значний", "суттєвий",
"варто зазначити", "слід відмітити", "очевидно", "таким чином",
"отже", "зокрема", "насамперед"...
```

### 3. Правила таблиць
```
- Таблиця нумерується як "Таблиця X.Y – Назва" (де X — номер розділу)
- Підпис: [вирівнювання з методички: над/під]
- В тексті посилання: "(табл. X.Y)" або "(див. Таблицю X.Y)"
- Заголовки колонок великими літерами
```

### 4. Правила рисунків
```
- "Рис. X.Y – Назва рисунку"
- Підпис: під рисунком, по центру
- В тексті: "(рис. X.Y)" перед вставкою рисунку
- Нумерація в межах розділу
```

### 5. Правила абзаців
```
- Чергуй довгі (5-7 речень) і короткі (3-4 речення) абзаци
- Максимум 1 кома в реченні
- Без крапки з комою
- Без тире (крім підписів до таблиць/рисунків)
- Починай абзаци різними словами
```

### 6. Стиль написання
```
- Активний голос ("дослідження показує", не "було показано")
- Конкретні цифри і факти
- Тепла академічна мова без канцеляризмів
- Без вступних фраз ("У цьому розділі ми розглянемо...")
- Пряма мова з першого слова абзацу
```

### 7. Форматування з методички
```
[якщо methodInfo.formatting існує:]
- Шрифт: [font] [fontSize]pt
- Міжрядковий інтервал: [lineSpacing]
- Відступ першого рядка: [firstLineIndent]см
```

---

## 8. DOCX Export детально

**Файл:** `src/lib/exportDocx.js`

### renumberTablesAndFigures

```js
renumberTablesAndFigures(content, displayOrder) → updatedContent
```

Алгоритм:
1. Для кожної секції в `displayOrder`:
   - Визначає номер розділу з `section.id` (напр. "2.1" → розділ 2)
   - Скидає лічильники `tableNum = 0`, `figNum = 0` на початку нового розділу
2. Регекс-пошук:
   - `Таблиця \d+\.\d+` → замінює на `Таблиця X.Y`
   - `Рис\. \d+\.\d+` → замінює на `Рис. X.Y`
3. Оновлює також inline-посилання:
   - `(табл. 1.2)` → `(табл. X.Y)`
   - `(рис. 1.2)` → `(рис. X.Y)`

### exportToDocx

```js
exportToDocx({content, info, displayOrder, appendicesText, titlePage, titlePageLines, methodInfo})
```

**Крок 1: Завантажити бібліотеку**
```js
// Динамічно підвантажує з CDN (не входить у бандл)
await loadScript("https://cdn.jsdelivr.net/npm/docx@8.5.0/build/index.umd.min.js")
const {Document, Packer, Paragraph, TextRun, AlignmentType, Table, TableRow, TableCell,
       WidthType, BorderStyle, HeadingLevel, LevelFormat, ...} = window.docx
```

**Крок 2: Константи форматування**
```js
const SIZE = 28          // 14pt в half-points
const LINE = 360         // 1.5 міжрядковий в twips
const INDENT = 709       // 1.25см в twips
const FONT = "Times New Roman"

// Поля з methodInfo або дефолт:
margins = {
  left: 30mm → 1701 twips,
  right: 15mm → 851 twips,
  top: 20mm → 1134 twips,
  bottom: 20mm → 1134 twips
}
```

**Крок 3: buildBlocks(text, sectionLabel)**

Парсить текст рядок за рядком і повертає масив docx-елементів:

```
Рядок            → docx елемент
─────────────────────────────────────────────────────
"## Назва"       → Paragraph(HeadingLevel.HEADING_2, bold, center)
"| col1 | col2 |"→ Table(rows, cols, borders, cell margins)
"Таблиця X.Y –" → Paragraph(caption, відповідно до methodInfo.tableCaption)
"Рис. X.Y –"    → Paragraph(orange text #B85C00, center)
звичайний рядок → Paragraph(FONT, SIZE, LINE, indent, JUSTIFIED)
порожній рядок  → Paragraph("") ← відступ між абзацами
```

**Крок 4: Структура документа**
```js
children = [
  ...titlePageBlocks,       // розпарсені рядки titlePage
  pageBreak,                // розрив сторінки
  ...buildBlocks(content["intro"], "Вступ"),
  pageBreak,
  ...buildBlocks(content["1.1"], "1.1 ..."),
  // ... всі секції
  pageBreak,
  ...buildBlocks(content["conclusions"], "Висновки"),
  pageBreak,
  ...refListBlocks,         // бібліографія
  ...(appendicesText ? appendixBlocks : [])
]
```

**Крок 5: Document object**
```js
doc = new Document({
  styles: {
    default: {
      document: {
        run: {font: FONT, size: SIZE},
        paragraph: {spacing: {line: LINE}}
      }
    }
  },
  sections: [{
    properties: {
      page: {
        size: {width: 11906, height: 16838},  // A4 в twips
        margin: margins
      }
    },
    headers: {
      default: new Header({children: [pageNumPara]})
    },
    children
  }]
})
```

**Крок 6: Завантаження**
```js
blob = await Packer.toBlob(doc)
url = URL.createObjectURL(blob)
a = document.createElement("a")
a.href = url
a.download = `${info.type}_${info.topic.slice(0, 30)}.docx`
a.click()
URL.revokeObjectURL(url)
```

### Таблиці в DOCX

Markdown формат:
```
| Показник | 2022 | 2023 | 2024 |
|----------|------|------|------|
| Дохід    | 100  | 120  | 150  |
```

Конвертується в `Table` з:
- Ширина кожної колонки: рівномірно від загальної ширини сторінки
- Межі: `BorderStyle.SINGLE`, розмір 4
- Cell padding: 60 twips
- Заголовковий рядок: `bold = true`

---

## 9. PPTX Export детально

**Файл:** `src/lib/exportPptx.js`

### Визначення теми

```js
function detectTheme(info) {
  const dir = (info.direction + " " + info.subject).toLowerCase()
  if (/it|програм|комп'ют|інформ|техн/.test(dir))  return "midnight"
  if (/медицин|біолог|хімія|здоров/.test(dir))      return "forest"
  if (/право|психол|педагог|соціол|літератур/.test(dir)) return "coral"
  if (/економ|фінанс|бізнес|менеджм/.test(dir))    return "slate"
  return "warm"
}
```

**Теми:**
```js
themes = {
  midnight: {bg: "1E2761", accent: "CADCFC", text: "1E2761", light: "EEF3FF"},
  forest:   {bg: "2C5F2D", accent: "97BC62", text: "1A3A1B", light: "EDF5E1"},
  coral:    {bg: "B85042", accent: "F5C6C0", text: "5A1A0F", light: "FDF0EF"},
  slate:    {bg: "36454F", accent: "C8D8E4", text: "2A3540", light: "EEF4F8"},
  warm:     {bg: "1A1A14", accent: "D4CF80", text: "1A1A14", light: "FAFAF0"}
}
```

### Layouts слайдів

| Layout | Опис | Коли використовується |
|--------|------|-----------------------|
| `hero` / `dark_title` | Повноекранний темний з великим заголовком | Титульний, перший слайд розділу |
| `two_column` | Текст ліворуч + кольоровий блок праворуч (опціонально: велике число/статистика) | Основні слайди з контентом |
| `stat_callout` | 1-3 великих числових карточки + текст | Слайди зі статистикою |
| `icon_list` | Маркований список з іконками | Перелік пунктів |
| `numbered_steps` | 4 карточки з номерами | Методологія, кроки |
| `highlight_box` | Смуговані рядки + опціональний footer | Таблиці/порівняння |

### exportToPptxFile

```js
exportToPptxFile(slideData, info)
  // slideData = {slides: [{layout, title, content, visual, stat?}, ...]}
```

1. Завантажує PptxGenJS з CDN
2. Визначає тему за `info`
3. Для кожного слайду в `slideData.slides`:
   - Вибирає функцію-рендерер за `slide.layout`
   - Додає елементи на слайд (заголовки, текст, форми, числа)
4. `pptx.writeFile({fileName: "presentation.pptx"})` → завантаження

---

## 10. Бібліотека утиліт (planUtils.js)

**Файл:** `src/lib/planUtils.js`

### Константи

```js
FIELD_LABELS = {
  type: "Тип роботи", pages: "Сторінок", topic: "Тема",
  subject: "Предмет", direction: "Напрямок/Спеціальність",
  uniqueness: "Унікальність %", language: "Мова",
  deadline: "Дедлайн", sourceCount: "Джерел (мін)"
}

STAGES = ["input", "parsed", "plan", "writing", "sources", "done"]

ORDER_STATUS = {
  input: "new",
  parsed: "new",
  plan: "plan_ready",
  writing: "writing",
  sources: "sources",
  done: "done"
}
```

### Функції визначення типу роботи

```js
isPsychoPed(info) → bool
// Перевіряє info.direction і info.subject на ключові слова:
// "психол", "педагог", "соціал", "виховання", "корекц"

isEcon(info) → bool
// "економ", "фінанс", "бізнес", "менеджм", "маркет", "облік"
```

### Функції аналізу секцій

```js
getEmpiricalSections(sections, info) → {anchorId, chapterSectionIds}
// Для психол/пед робіт: знаходить розділ для емпіричного дослідження
// anchorId — ID секції де починається практична частина

getEconSections(sections, info) → [sectionIds]
// Для екон робіт: ID секцій де потрібні таблиці з даними
```

### Парсинг та конвертація

```js
parsePagesAvg("80-100") → 90    // серединнє значення діапазону
parsePagesAvg("100")    → 100   // просто число

parseTemplate(text) → {orderNumber, type, deadline, direction, subject,
                        topic, pages, uniqueness, extras, language,
                        methodNotes, sourceCount}
// Regex-парсинг шаблону викладача

parseClientPlan(text, totalPages) → [sections]
// Конвертує текстовий план в масив секцій
// Автоматично розраховує сторінки пропорційно
// Типізує секції (intro/conclusions або theory/analysis/recommendations)

buildPlanText([sections]) → string
// "Вступ\n1. Назва розділу\n  1.1 Підрозділ\n...Висновки\n"

buildPreviewStructure(totalPages) → [chapters]
// Дефолтна структура для прев'ю на InputStage
```

### Розрахунок джерел

```js
calcSourceDist(sections, overallPages) → {dist: {sectionId: count}, total}
// Розподіляє мінімальну кількість джерел між секціями
// Пропорційно до pages кожної секції
// Вступ і висновки отримують менше (фіксований мінімум)
```

### Конфігурація роботи

```js
buildWorkConfig({info, methodInfo, commentAnalysis}) → {
  totalPages,           // parsePagesAvg(info.pages)
  introPages,           // з methodInfo або дефолт
  conclusionsPages,     // з methodInfo або дефолт
  chaptersCount,        // з methodInfo або дефолт (3)
  sourcesMinCount,      // з methodInfo або info.sourceCount
  sourcesStyle,         // стиль цитування
  citationStyle,        // author-year | numeric
  formatting: {...},    // шрифт, поля тощо
  language: info.language
}
```

---

## 11. Firestore — структура даних

### Колекція `orders`

Документ `orders/{orderId}`:
```js
{
  // Мета
  uid: "firebase_user_id",
  createdAt: Timestamp,
  status: "new" | "plan_ready" | "writing" | "sources" | "done",
  stage: "input" | "parsed" | "plan" | "writing" | "sources" | "done",

  // Вхідні дані
  tplText: "...",
  comment: "...",
  clientPlan: "...",
  // fileB64 НЕ зберігається (занадто великий)

  // Розпарсені дані
  info: {type, pages, topic, subject, direction, uniqueness, language, deadline, ...},
  methodInfo: {totalPages, chaptersCount, formatting, ...},
  commentAnalysis: {planHints, writingHints, ...},

  // Структура
  sections: [{id, label, sectionTitle, type, pages, prompts}, ...],
  planDisplay: "...",
  sourceDist: {sectionId: count, ...},
  sourceTotal: 25,

  // Згенерований контент
  content: {
    "intro": "текст вступу...",
    "1.1": "текст підрозділу...",
    "conclusions": "текст висновків...",
    // ...
  },

  // Джерела
  citInputs: {sectionId: "сирі джерела...", ...},
  refList: ["1. Відформатоване джерело...", ...],
  keywords: {sectionId: ["ключове слово", ...], ...},

  // Фінальні матеріали
  appendicesText: "...",
  speechText: "...",
  titlePage: "...",
  slideJson: {slides: [...]}
}
```

### Колекція `users`

Документ `users/{userId}`:
```js
{
  email: "...",
  name: "...",
  role: "admin" | "manager",
  approved: true | false,
  blocked: false,
  createdAt: Timestamp
}
```

**Правила доступу:**
- Юзер бачить тільки свої `orders` (фільтр по `uid`)
- Admin бачить всі orders через AdminPage
- Нові юзери мають `approved: false` — не можуть входити поки admin не схвалить

### serializeForFirestore

```js
// firestoreUtils.js
function serializeForFirestore(obj) {
  return JSON.parse(JSON.stringify(obj, (key, value) =>
    value === undefined ? null : value
  ))
}
// Firestore кидає помилку на undefined — конвертує в null
```

---

## 12. Трекінг вартості API

**Де зберігається:** `localStorage["sessionCost"]`

**Структура:**
```js
sessionCost = {
  totalCost: 0.0523,          // USD всього за сесію
  calls: [
    {
      model: "claude-sonnet-4-6",
      inTok: 1200,
      outTok: 3400,
      cost: 0.0564,
      timestamp: 1713123456789
    },
    ...
  ]
}
```

**Потік даних:**
```
api.js виклик успішний
  → розраховує cost = (inTok * inputPrice + outTok * outputPrice) / 1_000_000
  → window.dispatchEvent(new CustomEvent("apicost", {detail: {...}}))

AcademAssist:
  useEffect → addEventListener("apicost", handler)
  handler → setSessionCost(prev => {...prev, totalCost: prev.totalCost + detail.cost})
  → localStorage.setItem("sessionCost", JSON.stringify(sessionCost))
```

**Відображення:** У хедері показується `$0.05` (поточна вартість сесії)

---

## 13. Компоненти UI

### Buttons.jsx

```jsx
<FieldBox label="Тема" value={...} onChange={...} />
// Textarea з плаваючим лейблом, стилізована під тему додатку

<Heading>Аналіз завершено</Heading>
// H2 з Spectral SC шрифтом

<NavBtn onClick={...} disabled={...}>Далі →</NavBtn>
// Кнопка навігації між стейджами

<PrimaryBtn onClick={...} loading={...}>Генерувати план</PrimaryBtn>
// Основна CTA кнопка з опціональним спінером

<GreenBtn onClick={...}>Завантажити .docx</GreenBtn>
// Зелена кнопка для download-дій

<SaveIndicator saving={saving} saved={saved} />
// "Збереження..." / "Збережено ✓" індикатор автозбереження
```

### StagePills.jsx

```jsx
<StagePills
  stages={STAGES}         // масив назв стейджів
  current={stage}         // поточний стейдж
  max={maxStageIdx}       // максимально досягнутий
  onChange={setStage}     // клік по пігулці
/>
```

Навігаційні "пігулки" зверху. Клік дозволений тільки на вже пройдені стейджі (`index <= maxStageIdx`).

### SpinDot.jsx

```jsx
<SpinDot />              // кружляючий спінер
<ShimmerSkeleton />      // мерехтливий скелетон (під час завантаження плану)
```

### DropZone.jsx / PhotoDropZone.jsx

```jsx
<DropZone
  label="Методичка (PDF)"
  onFile={(b64, type, name) => handleFile(b64, type, name)}
/>

<PhotoDropZone
  photos={photos}
  onChange={setPhotos}
  maxPhotos={5}
/>
```

Drag-and-drop або клік → FileReader → base64 → callback

### ClientPlanInput.jsx

```jsx
<ClientPlanInput
  onExtract={(text) => setClientPlan(text)}
/>
```

1. Юзер завантажує фото плану
2. `callGemini([image, "Витягни зміст..."])` → текст
3. `onExtract(text)` → вставляється в поле плану

---

## 14. Повний Data Flow (схема)

```
ЮЗЕР ВВОДИТЬ ДАНІ
│
├─ tplText ──────────────────────────────────────────────────────┐
├─ comment ──────────────────────────────────────────────────────┤
├─ clientPlan ───────────────────────────────────────────────────┤
├─ PDF методички (base64) ───────────────────────────────────────┤
└─ photos ───────────────────────────────────────────────────────┘
                                                                 │
                                                    doAnalyze()  │
                                                                 ▼
                    ┌────────────────────────────────────────────┐
                    │           АНАЛІЗ (ParsedStage)             │
                    │                                            │
                    │  Claude: шаблон → info {}                  │
                    │  Gemini: PDF → methodInfo {}               │
                    │  Claude: коментар → commentAnalysis {}     │
                    └────────────────────────────────────────────┘
                                        │
                                        │ Юзер редагує info
                                        │ doGenPlan()
                                        ▼
                    ┌────────────────────────────────────────────┐
                    │              ПЛАН (PlanStage)              │
                    │                                            │
                    │  parseClientPlan() АБО Claude генерує      │
                    │  sections = [{id, label, type, pages}]     │
                    │  calcSourceDist() → sourceDist             │
                    └────────────────────────────────────────────┘
                                        │
                                        │ Юзер редагує план
                                        │ startGen()
                                        ▼
                    ┌────────────────────────────────────────────┐
                    │           НАПИСАННЯ (WritingStage)         │
                    │                                            │
                    │  For each section:                         │
                    │    buildSYS() + section prompt             │
                    │    → Claude streams text                   │
                    │    → content[section.id] = text            │
                    │    → saveToFirestore()                     │
                    │                                            │
                    │  playDoneSound() після завершення          │
                    └────────────────────────────────────────────┘
                                        │
                                        │ Юзер вставляє джерела
                                        │ doAddAllCitations()
                                        ▼
                    ┌────────────────────────────────────────────┐
                    │            ДЖЕРЕЛА (SourcesStage)          │
                    │                                            │
                    │  Claude: keywords per section              │
                    │  Юзер: вставляє сирі джерела               │
                    │  Claude: форматує → refList[]              │
                    └────────────────────────────────────────────┘
                                        │
                                        │ onFinish()
                                        ▼
                    ┌────────────────────────────────────────────┐
                    │              ФІНАЛ (DoneStage)             │
                    │                                            │
                    │  renumberTablesAndFigures()                │
                    │       ↓                                    │
                    │  exportToDocx() → 📄 Курсова.docx         │
                    │                                            │
                    │  Gemini (структура) + Claude (контент)     │
                    │  exportToPptxFile() → 📊 Презентація.pptx │
                    │                                            │
                    │  Claude → exportSpeechToDocx() → 🗣️ Промова.docx
                    │                                            │
                    │  Claude → exportAppendixToDocx() → 📎 Додатки.docx
                    └────────────────────────────────────────────┘
                                        │
                                        ▼
                               ЗАВАНТАЖЕНІ ФАЙЛИ
```

---

*Кінець документу*
