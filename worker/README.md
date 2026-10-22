# worker/ — конвеєр генерації поза браузером

Node-скрипти, що проводять замовлення через ту саму логіку генерації
(`src/lib/orderStages.js` для великих робіт, `src/lib/smallStages.js` для
малих — `src/lib/exportDocx.js` для обох), що й браузерний UI, без відкритої
вкладки — для ручного/одноразового дороблення замовлень із консолі і для
інтеграції з SW CRM за контрактом `docs/crm-integration.md`.

## Скрипти

- **`pipeline.js`** — довгоживучий поллер поверх власного Firestore-прапорця
  `autoPipeline:true` (ручна черга, тимчасова заміна CRM). Постійно перевіряє
  Firestore на такі замовлення й проводить кожне через `processOrder()`, поки
  воно не готове або не впреться в чекпойнт, що потребує зовнішньої дії
  (затвердження плану, ручне дороблення джерел, пауза, перевищення
  `ORDER_COST_LIMIT`).
- **`crmPipeline.js`** — довгоживучий поллер за контрактом
  `docs/crm-integration.md` (v1.1): `claim` → створити/продовжити
  `orders/{run_id}` (`crmOrderMapping.js`, включно з витягуванням тексту з
  `client_materials`/`ready_part`/план-файлом через `materialsExtract.js` —
  pdf/docx/xlsx/txt/csv/код/фото/скановані PDF, той самий алгоритм, що
  `ClientMaterialsZone.jsx` у браузері) → `processOrder()` (+ затвердження
  плану через `POST/GET /jobs/{run_id}/plan`, якщо клієнт не дав готовий план,
  `crmPlanReview.js`) → зібрати `.docx` → `result`/`error`. Незалежний від
  `pipeline.js` — чергу тут тримає CRM, не власний Firestore-прапорець.
  `kind="large"` → `processOrder()` (`orderStages.js`); його останній крок —
  фото з інтернету для рисунків-заглушок (`src/lib/webImages.js` через
  `${API_BASE}/api/search-images`, картинки — у `orders/{id}/webImages`, у `.docx`
  підставляються при експорті). `kind="small"` →
  `crmOrderMapping.js` визначає конкретний `workType` (реферат/тези/стаття/
  есе/презентація/доповідь) з рядка "Тип - ..." у `template_text`, і поки
  доводить до кінця лише `workType="ese"` (`processSmallOrder.js` →
  `smallStages.js`: `runSmallAnalyze → runSimple → runSmallRemap`, з
  `exportSimpleDocx` замість `exportToDocx` на виході) — інші `workType`
  малих робіт відхиляються з чіткою retryable:false причиною, доки не портовані.
  `kind="practice"` поки не підтримано (окремий потік `PracticePage.jsx`, не
  підключений до `processOrder()`).
- **`pipelineControl.js pause|resume|status`** — керування паузою `pipeline.js`
  (на `crmPipeline.js` не впливає — там чергою керує сам CRM).
- **`enqueueOrder.js <orderId>`** — тимчасова заміна кроку "менеджер додав
  автора Academ Assist" для ручної черги (`pipeline.js`): позначає замовлення
  `autoPipeline:true`.
- **`runOrder.js <orderId>`** — одноразовий прогін одного замовлення без
  поллера (пауза конвеєра на нього не впливає).
- **`exportOrderDocx.js <orderId> [outPath]`** — збирає `.docx` готового
  замовлення тим самим шляхом, що й кнопка в UI (`exportToDocx`) — для звірки
  headless-результату з браузерним. Охоплює основний потік (курсова/диплом/
  реферат); звіти з практики (ширший набір полів у `PracticePage.jsx`) сюди
  ще не входять.
- **`runCorrections.js <файл.docx> [--notes="текст зауважень"] [--lang="Українська"]
  [--out=outPath.docx]`** — тонкий CLI над `runFileCorrections()` з
  `src/lib/correctionStages.js` — єдиною точкою входу для будь-якого
  зовнішнього адаптера (CLI тут, майбутній CRM-адаптер тощо):
  `runFileCorrections({ docxBuffer, fileName, instructions, remarkFiles, info }, ctx)
  → { buffer, summary, changes, failed?, messages? }`. Застосовує "правки"
  (виділення/коментарі Word + опційно вільний текст `instructions`/фото
  `remarkFiles`) до `.docx` тим самим шляхом, що кнопка "Правки" в браузері
  (`FileCorrectionsPage.jsx`). Без Firestore/CRM: локальний файл на вході,
  виправлений локальний файл на виході — для ручного/одноразового
  дороблення з консолі, як і `runOrder.js`/`exportOrderDocx.js`. DOM-хірургія
  над `.docx` (`src/lib/docxSurgicalEdit.js`, `src/lib/docxAnnotations.js`) в
  браузері спирається на `window.JSZip`/`DOMParser`/`XMLSerializer`; тут
  замість них підставляється Node-версія (`docxNodeIO.js`: пакети `jszip`,
  `@xmldom/xmldom`) — сама логіка виправлень і промпти не змінені. CRM поки
  не надсилає роботи типу "Правки" на автообробку (у контракті
  `docs/crm-integration.md` такого `kind` немає) — це окремий CLI, не
  підключений до `crmPipeline.js`.
  **Той самий код — і в UI.** Сторінка "Правки" (`FileCorrectionsPage.jsx`)
  більше не має власної копії логіки: підготовка файлу
  (`prepareDocxForCorrections` — відкрити .docx, автоматично прийняти
  виправлення режиму рецензування викладача, витягти анотації),
  `applyCorrectionTasks`, `runAgentCorrections` і збереження
  (`finalizeCorrectedDocx` — з оновленням змісту при відкритті) спільні для
  браузера й воркера.
  `--mode=agent` — агентний режим (`src/lib/correctionAgent.js`): замість
  фіксованих типів завдань і одного JSON-виклику ШІ працює з документом
  інструментами (read_paragraphs/search/replace_text/insert_paragraphs/
  delete_paragraphs/resolve + кодові restructure_sources/fix_citation_pages),
  як Claude Code з кодом, і сам завершує через finish. Кодом (не ШІ)
  контролюються: постійні мітки абзаців ([12], нові — [n1]); звірка початку
  абзацу перед видаленням; рисунки/формули/частини полів не видаляються;
  посилання [N] лише на наявні джерела й жодних нових у ВИСНОВКАХ, у роботах
  з "(Автор, рік)" — лише автори зі списку; таблиці markdown/код схем у текст
  не потрапляють; finish приймається, лише коли кожне зауваження (#H/#C/#N/#P)
  виконано, закрито або внесено в needs_review, і обсяг у межах. Крок агента —
  стрімінгом (без таймауту 300 с), з повторами на 429/5xx/обрив мережі.
  `--context=full|outline|auto` — чи тримати весь текст роботи в кеші (краще
  бачить роботу цілком, дорожче; лише до ~150 тис. символів) чи лише структуру.
  `--notes-file=` — зауваження з файлу; `--remark-files=a.jpg,b.pdf` — фото/PDF
  зауважень (розпізнаються в текст один раз на старті; завеликі/HEIC
  стискаються через sharp). Вихід: `<ім'я>_виправлено_agent.docx`.
  Умови замовлення: `--order=<id>` підтягує з Firestore мову, методичку,
  матеріали клієнта, тип/тему/предмет/курс і замовлений обсяг
  (потрібен `GOOGLE_APPLICATION_CREDENTIALS`); `--pages=30-35`/`--type=`/
  `--topic=` — вручну. Загальний обсяг основної частини (від ВСТУП до кінця
  списку джерел, 230 слів = сторінка, як при генерації) — не більше ±10% від
  обсягу до правок і в межах замовленого ±5%; якщо зауваження прямо вимагає
  змінити обсяг (`finish.volume_change_reason`) — у межах замовленого (без
  нього — ±25%). finish поза межами відхиляється (до 2 разів), далі — пункт
  "Обсяг роботи" у потребує перевірки.
  Тести без ШІ: `node worker/correctionAgent.test.js`, `node worker/docxSurgicalEdit.test.js`,
  `node worker/callClaudeMessage.test.js`.

## TODO: тези (`kind="small"`, `workType="tezy"`) з CRM

`runTezy`/`runSmallAnalyze` (`src/lib/smallStages.js`) уже розводять три
джерела за роллю, так само як три поля в UI (`small-works.jsx`). При підключенні
тез у `crmOrderMapping.js` (`SMALL_WORK_TYPES_SUPPORTED`) слоти CRM
(`docs/crm-integration.md` §4) треба класти **кожен у своє поле**, не зливаючи:

| слот CRM (тег у картці) | поле `orders/{id}` | роль у промпті |
|---|---|---|
| `methodology` («Методичка») | `files` (eager `{name,b64,type}`) | вимоги: структура, обсяг, оформлення; з неї ж `runSmallAnalyze` тягне `methodRequirements` |
| `department_guidance` («Рекомендації кафедри») | `deptGuidanceText` — текст, зведений зі скрінів одним vision-викликом, як у `DeptGuidanceZone.jsx` | вимоги нарівні з методичкою, при конфлікті — пріоритет за кафедрою |
| `client_materials` («Матеріали») | `materialText` (як зараз, через `extractFileText`) | лише зміст — факти/дані/позиції, не структура |

Зараз `buildSmallOrderFromJob` слот `department_guidance` не читає взагалі
(для `ese` теж), а для великих робіт зливає його в `photos` — для тез так робити
не можна: скріни кафедри опиняться серед матеріалу або загубляться. Формат
контракту від цього не змінюється (слоти вже описані), але в
`docs/crm-integration.md` варто відмітити, що тези підтримуються.

## Запуск

```
# Ручна черга (pipeline.js):
GOOGLE_APPLICATION_CREDENTIALS=/шлях/до/service-account.json \
FIREBASE_PROJECT_ID=... FIREBASE_STORAGE_BUCKET=... \
  node worker/pipeline.js

# CRM-черга (crmPipeline.js):
CRM_BASE_URL=https://crm.studentbrains.online/api/academ ACADEM_WORKER_TOKEN=... WORKER_ID=vps2-1 \
GOOGLE_APPLICATION_CREDENTIALS=/шлях/до/service-account.json \
FIREBASE_PROJECT_ID=... FIREBASE_STORAGE_BUCKET=... \
DIRECT_API=1 ANTHROPIC_API_KEY=... GEMINI_API_KEY_1=... \
WORKER_PROXY_TOKEN=... \
  node worker/crmPipeline.js
```

## Графіки в docx поза Docker-образом

`exportDocx.js` малює числові діаграми в Node через нативний пакет `canvas`
(node-canvas, Cairo) — той самий код, що в браузері малює на DOM `<canvas>`.
Якщо запускаєте воркер **не** через готовий `Dockerfile` (наприклад, голим
`node worker/crmPipeline.js` на VPS), на сервері мають бути встановлені ті самі
системні бібліотеки, що й у `Dockerfile` (`apt-get install`: `libcairo2-dev
libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev` для збірки `npm install`,
або рантайм-варіанти без `-dev` після збірки). Без них `import("canvas")`
падає, і графіки в `.docx` мовчки перетворюються на звичайні таблиці — тепер
це видно в логах воркера (`renderDataChartToPng: графік не намальовано — ...`),
раніше падало без жодного сліду.

## Env-змінні

| Змінна | Обов'язкова | За замовчуванням | Призначення |
|---|---|---|---|
| `GOOGLE_APPLICATION_CREDENTIALS` | так | — | Шлях до JSON-ключа сервісного акаунта Firebase (Firebase Console → Project Settings → Service Accounts → Generate new private key). **Не комітити в git.** |
| `FIREBASE_PROJECT_ID` | так | — | Той самий `projectId`, що й у `src/firebase.js` / `VITE_FIREBASE_PROJECT_ID`. |
| `FIREBASE_STORAGE_BUCKET` | для Storage | — | Той самий `VITE_FIREBASE_STORAGE_BUCKET` — потрібен `worker/storage.js` (майбутній CRM-шлях для файлів методичок/матеріалів клієнта). |
| `DIRECT_API` | ні | вимкнено | `1` — воркер б'є напряму в Anthropic/Google своїм ключем, минаючи `/api/claude` та `/api/gemini` на Vercel. Без цього — ходить через Vercel (`API_BASE`), як і браузер. |
| `ANTHROPIC_API_KEY` | якщо `DIRECT_API=1` | — | Окремий ключ для воркера (щоб витрати були видні окремим рядком в Anthropic Console). |
| `GEMINI_API_KEY`, `GEMINI_API_KEY_1`, `GEMINI_API_KEY_2`, `GEMINI_API_KEY_3` | якщо `DIRECT_API=1` | — | Ті самі назви, що в `api/gemini.js`; можна задати кілька для ротації при 429/503. |
| `API_BASE` | так, завжди | `""` | Абсолютна адреса задеплоєного Vercel (напр. `https://academ-assist.vercel.app`) — потрібна, бо у воркера немає origin сторінки. **Обов'язкова НЕЗАЛЕЖНО від `DIRECT_API`**: той перемикає лише `/api/claude`/`/api/gemini`, а пошук і фільтрація джерел (`src/lib/sourcesSearch.js`: Scholar, CORE, DOAJ, Semantic Scholar, `fetch-meta`, і сама Gemini-фільтрація кандидатів — Прохід А/Б) завжди йдуть через `getApiBase()`. Без цього в Node `${API_BASE}/api/...` стає відносним шляхом, `fetch()` кидає `TypeError` (нема origin сторінки, як у браузері) — і оскільки Прохід А/Б fail-closed за задумом (збій = "нічого не підтверджено", не "усе підходить"), жодне джерело не проходить автоматичне підтвердження, а решта провайдерів (Scholar/CORE/DOAJ/Semantic Scholar) мовчки повертають `[]`. `crmPipeline.js` — той самий CMD, що в `Dockerfile` — довго не мав виклику `setApiBase()` взагалі; тепер має (`--api-base=`/`API_BASE`, як і в `pipeline.js`/`runOrder.js`). |
| `ORDER_COST_LIMIT` | ні | `6` (USD) | Стеля вартості на ВСЕ замовлення (сума всіх запусків, не один прохід). При перевищенні — замовлення зупиняється зі `status:"error"` і причиною в `errorReason`. У `crmPipeline.js` перевизначається на конкретний job через `job.limits.cost_usd` — це лише запасне значення. |
| `CORRECTIONS_COST_LIMIT` | ні | `3` (USD, `GENERATION_COST_LIMIT` з `api.js`) | Стеля вартості на один прогін `runCorrections.js`. При перевищенні — уже застосовані правки лишаються як є, решта позначається `failed`. |
| `WORKER_CONCURRENCY` | ні | `1` | К-сть незалежних слотів поллера, що можуть обробляти замовлення паралельно. |
| `PIPELINE_POLL_INTERVAL_MS` | ні | `30000` | Пауза між тіками поллера, коли немає готових замовлень/робіт. |
| `CRM_BASE_URL` | для `crmPipeline.js` | — | Базова адреса CRM (`https://crm.studentbrains.online/api/academ`), докладно — `docs/crm-integration.md`. |
| `ACADEM_WORKER_TOKEN` | для `crmPipeline.js` | — | Bearer-токен до CRM; той самий, що на боці CRM (`Authorization: Bearer ...`). |
| `WORKER_ID` | ні (`crmPipeline.js`) | `hostname:pid` | Стабільний ідентифікатор інстансу воркера, який CRM бачить у `claim`. |
| `WORKER_PROXY_TOKEN` | так | — | Bearer-токен до `/api/claude`/`/api/gemini` на Vercel (той самий секрет треба задати і в env Vercel-проєкту). Потрібен **навіть при `DIRECT_API=1`** — кілька викликів фільтрації джерел (`src/lib/sourcesSearch.js`) завжди йдуть через цей проксі напряму, в обхід `DIRECT_API`. Без нього ці запити падатимуть з 401. |

## Docker

```
docker build -t academ-assist-worker .
docker run -d --name academ-worker \
  -v /шлях/до/service-account.json:/run/secrets/firebase-sa.json:ro \
  -e GOOGLE_APPLICATION_CREDENTIALS=/run/secrets/firebase-sa.json \
  -e FIREBASE_PROJECT_ID=... -e FIREBASE_STORAGE_BUCKET=... \
  -e CRM_BASE_URL=https://crm.studentbrains.online/api/academ -e ACADEM_WORKER_TOKEN=... -e WORKER_ID=vps2-1 \
  -e DIRECT_API=1 -e ANTHROPIC_API_KEY=... -e GEMINI_API_KEY_1=... \
  -e WORKER_CONCURRENCY=1 \
  academ-assist-worker
```

Образ за замовчуванням запускає `crmPipeline.js` (CMD у Dockerfile). Для ручної
черги без CRM (`pipeline.js`) перевизначте команду в кінці `docker run`:
`... academ-assist-worker node worker/pipeline.js` (тоді `CRM_BASE_URL`/
`ACADEM_WORKER_TOKEN`/`WORKER_ID` не потрібні).

Ключ сервісного акаунта монтується як read-only volume, а не запікається в
образ — щоб той самий образ можна було використовувати з різними ключами й не
тримати секрет у шарах образу.
