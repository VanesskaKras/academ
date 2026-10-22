# Воркер конвеєра — Node-скрипт, що імпортує спільну бізнес-логіку напряму з
# src/lib/*.js (та сама логіка, що й браузерний UI), без Vite-збірки.
# За замовчуванням запускається CRM-поллер (crmPipeline.js); для ручної черги
# без CRM перевизначте команду: `docker run ... academ-assist-worker node worker/pipeline.js`.
# Детально про env-змінні й запуск — worker/README.md.

# ── Stage 1: залежності (потребує компіляторів для canvas/node-canvas — Cairo) ──
FROM node:20-bookworm-slim AS deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential pkg-config \
    libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ── Stage 2: рантайм (без компіляторів — легший образ) ──
FROM node:20-bookworm-slim
# Рантайм-бібліотеки canvas (без -dev заголовків) + шрифт, метрично сумісний
# з Times New Roman — для коректного рендеру вбудованих у документ діаграм
# (renderChartFromParsed, exportDocx.js). Сам текст Word лишається у форматі
# шрифту й рендериться Word'ом читача як завжди — шрифт тут лише для картинок.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libcairo2 libpango-1.0-0 libpangocairo-1.0-0 libjpeg62-turbo libgif7 librsvg2-2 \
    fonts-liberation ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY worker ./worker

# GOOGLE_APPLICATION_CREDENTIALS має вказувати на файл УСЕРЕДИНІ контейнера —
# змонтуйте JSON-ключ сервісного акаунта як volume (не бейкайте в образ).
# Повний список env-змінних і приклад запуску — worker/README.md.
CMD ["node", "worker/crmPipeline.js"]
