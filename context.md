# AcademAssist — Контекст проекту

## Що це за застосунок

AcademAssist — веб-інструмент для автоматичного написання академічних робіт на замовлення. Користувач вставляє шаблон замовлення (тема, тип, к-сть сторінок, дедлайн, вимоги), завантажує методичку (PDF/DOCX), і застосунок покроково генерує повну роботу через AI, а потім експортує її у `.docx` з академічним форматуванням.

**Цільова аудиторія:** виконавці замовлень академічних робіт (не кінцеві студенти). Доступ за логіном і паролем.

---

## Стек

| Шар | Технологія |
|-----|-----------|
| Frontend | React + Vite (SPA) |
| Backend API | Vercel Serverless Functions (`/api/`) |
| База даних | Firebase Firestore |
| Авторизація | Firebase Auth (email/password) |
| AI | Anthropic Claude API + Google Gemini API |
| DOCX export | `docx` npm library (завантажується через CDN) |

---

## Структура файлів

```
src/
  App.jsx                  — роутер, AuthProvider
  AuthContext.jsx          — провайдер авторизації (useAuth hook)
  LoginPage.jsx            — сторінка входу
  Dashboard.jsx            — список замовлень, пошук, фільтри по статусу
  AdminPage.jsx            — управління користувачами (ролі: admin, manager, user)
  academic-assistant.jsx   — головний модуль великих робіт (курсові, дипломні...)
  small-works.jsx          — модуль малих робіт (реферат, тези, стаття, есе, презентація)
  shared.jsx               — спільний код: buildSYS, callClaude, callGemini, UI-компоненти
  firebase.js              — ініціалізація Firebase
api/
  claude.js                — проксі до Anthropic API (захищає ключ, ліміт тіла 10MB)
  gemini.js                — проксі до Gemini API (модель gemini-2.5-flash)
```

---

## AI моделі

| Константа | Модель | Використання |
|-----------|--------|-------------|
| `MODEL` | `claude-sonnet-4-6` | Генерація тексту підрозділів |
| `MODEL_FAST` | `claude-haiku-4-5-20251001` | JSON-задачі: аналіз шаблону, план, ключові слова, аналіз коментаря |
| _(без константи)_ | `gemini-2.5-flash` | Читання методички (PDF) — дешевша альтернатива |

Вартість запитів відстежується в `sessionCost` (localStorage) і відображається в інтерфейсі.

---

## Модуль `academic-assistant.jsx` — великі роботи

### Стадії (6 кроків)

```
input → parsed → plan → writing → sources → done
Дані  → Перевірка → План → Написання → Джерела → Готово
```

Статуси в Firestore: `new`, `plan_ready`, `writing`, `done`.

### Крок 1 — Дані (input)
Користувач вставляє:
- Текст шаблону замовлення (парситься регулярками в `parseTemplate()`)
- Коментар клієнта (опційно)
- Власний план клієнта (опційно)
- Методичка PDF/DOCX (drag-and-drop або вибір файлу)

### Крок 2 — Перевірка (parsed / doAnalyze)
Три API-виклики:
1. Claude Haiku — парсить шаблон у JSON (`info`: тип, тема, к-сть сторінок, дедлайн...)
2. Gemini Flash — читає методичку PDF і витягує структурні вимоги (`methodInfo`: к-сть розділів, стиль джерел, форматування...)
3. Claude Haiku — аналізує коментар клієнта в `commentAnalysis.planHints` та `writingHints`

### Крок 3 — План (plan / doGeneratePlan)
Claude Haiku генерує JSON зі структурою:
```json
[
  {"id": "intro", "type": "intro", "label": "ВСТУП", "pages": 3},
  {"id": "1.1", "type": "subsection", "label": "1.1 Назва підрозділу", "pages": 8, "sectionTitle": "РОЗДІЛ 1. Назва"},
  ...
  {"id": "conclusions", "type": "conclusions", "label": "ВИСНОВКИ", "pages": 3},
  {"id": "sources", "type": "sources", "label": "СПИСОК ВИКОРИСТАНИХ ДЖЕРЕЛ"}
]
```
Підрозділи мають `id` формату `"1.1"`, `"2.3"` тощо.
Розподіл джерел по підрозділах: `calcSourceDist()`.

### Крок 4 — Написання (writing)
Послідовна генерація кожного підрозділу через `callClaude()` з системним промптом `buildSYS()`.
Кожен підрозділ отримує промпт з темою, кількістю сторінок, `writingHints` з коментаря, вимогами методички.
Прогрес зберігається в Firestore після кожного підрозділу (через `saveToFirestore()`).
Можна перегенерувати окремий підрозділ з власним промптом (`regenId`, `regenPrompt`).

### Крок 5 — Джерела (sources)
Для кожного підрозділу:
1. Claude Haiku витягує ключові слова (`keywords`)
2. Claude Sonnet генерує список джерел у заданому стилі (APA / ДСТУ / MLA)
3. Є кнопка "Генерувати всі джерела" (`allCitLoading`)

### Крок 6 — Готово (done)
Кнопки:
- Завантажити план `.docx` (`exportPlanToDocx`)
- Завантажити роботу `.docx` (`exportToDocx`)

---

## DOCX форматування (exportToDocx)

| Параметр | Значення |
|---------|---------|
| Шрифт | Times New Roman 14pt (SIZE=28 в одиницях docx) |
| Поля | Ліво 30мм, право 15мм, верх/низ 20мм |
| Міжрядковий інтервал | 1.5 (LINE=360) |
| Відступ першого рядка | 1.25см (INDENT=709) |
| Вирівнювання тексту | По ширині (BOTH) |
| Нумерація сторінок | Правий верхній кут, починається з 1, титульна без номера |
| Зміст | Автоматичний Word TOC (оновлюється при відкритті) |
| Заголовки розділів | Великими літерами, по центру, жирний |
| Заголовки підрозділів | Нормальний регістр, ліво, жирний, з відступом |

Структура документа:
1. Порожня сторінка (титульна)
2. ЗМІСТ (автоматичний)
3. Основний текст (кожен розділ / вступ / висновки з нового аркуша, підрозділи того ж розділу без переривання)

---

## Модуль `small-works.jsx` — малі роботи

Типи: `referat`, `tezy`, `stattia`, `ese`, `prezentatsiya`.

Спрощений потік (3-4 кроки):
- Реферат: Дані → План → Текст → Готово
- Тези/Стаття/Есе/Презентація: Дані → Генерація → Готово

Використовує спільні функції з `shared.jsx`.

---

## Firebase Firestore — структура документа `orders/{id}`

```
uid             — id користувача
createdAt       — ISO рядок
updatedAt       — ISO рядок
topic           — тема роботи
type            — тип роботи
pages           — к-сть сторінок
deadline        — дедлайн
status          — new | plan_ready | plan_approved | writing | done
stage           — input | parsed | plan | writing | sources | done
tplText         — вихідний текст шаблону
comment         — коментар клієнта
clientPlan      — власний план клієнта
info            — {type, pages, topic, subject, direction, uniqueness, language, deadline, extras, methodNotes, orderNumber}
methodInfo      — структурна інфо з методички (chaptersCount, sourcesStyle, formatting...)
commentAnalysis — {planHints, writingHints}
sections        — масив об'єктів підрозділів
content         — {[sectionId]: "текст підрозділу"}
citInputs       — {[sectionId]: "введені ключові слова"}
keywords        — {[sectionId]: "ключові слова"}
refList         — масив рядків джерел
genIdx          — індекс поточного підрозділу при генерації
```

---

## Ролі користувачів

| Роль | Доступ |
|------|--------|
| `admin` | Всі функції + AdminPage (управління юзерами) |
| `manager` | Dashboard + робота із замовленнями |
| `user` | Dashboard + робота із замовленнями |
| `blocked` | Доступ закритий |

---

## Системний промпт (buildSYS) — ключові правила

- Мова: Ukrainian за замовчуванням (або English якщо вказано)
- Заборонені слова: аспект, важливий, особливий, значущий, ключовий, критичний, фундаментальний
- Заборонено: markdown, жирний текст, повтор заголовка підрозділу, посилання в тексті, список джерел в підрозділі
- **Заборонено довге тире "—"** — тільки кома або перебудова речення
- Заборонені джерела: російські та білоруські
- Стиль: теплий академічний тон, короткі речення, без пафосу

---

## Важливі деталі реалізації

- `callClaude` / `callGemini` мають retry з exponential backoff (до 5 спроб, затримка 12с → 60с) при 429
- Всі Firestore-записи через `serializeForFirestore()` — заміна `undefined` на `null`
- `contentRef` — ref для актуального content щоб не замикати state в callbacks
- `abortRef` — AbortController для зупинки генерації
- Звуковий сигнал по завершенні: `playDoneSound()` (кастомний файл `/sounds/hi.mp3` або Web Audio API)
- API cost трекінг через custom event `apicost` → `sessionCost` в localStorage
- `orderId` приходить через props; якщо null — створюється новий при першому збереженні

---

## Команди розробки

```bash
npm run dev      # Vite dev server (localhost:5173)
npm run build    # Production build
npm run preview  # Preview production build
```

API-ключі (через Vercel env або `.env.local`):
- `ANTHROPIC_API_KEY`
- `GEMINI_API_KEY`
- Firebase config — в `src/firebase.js`
