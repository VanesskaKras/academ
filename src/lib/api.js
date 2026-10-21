import { buildSYS } from "./prompts.js";

export const MODEL = "claude-sonnet-5";
export const MODEL_FAST = "claude-haiku-4-5-20251001";

// ── Запобіжник від "втечі" вартості однієї генерації (напр. баг у циклі, що
// зумовлює десятки дорогих викликів поспіль). Трекер рахує суму cost з усіх
// викликів callClaude І callGemini, поки хтось явно не скине її через
// resetGenerationCost() — кожна "одна генерація" (написання роботи, розстановка
// джерел, пакетне застосування правок тощо) скидає її на старті.
//
// Вартість РЕЗЕРВУЄТЬСЯ синхронно (до першого await), одразу після перевірки
// ліміту — це закриває "check-then-act" гонку: коли кілька викликів стартують
// паралельно (напр. Promise.all при розбитті джерел навпіл), кожен наступний
// вже бачить резерв попередніх, а не стартовий рахунок. Після відповіді
// різниця між реальною вартістю й резервом коригується (settle) — при помилці/
// обриві резерв просто звільняється.
//
// createCostTracker() дає ІЗОЛЬОВАНИЙ лічильник — потрібен для серверного
// воркера, що може обробляти кілька замовлень паралельно (один спільний
// модульний лічильник змішав би їхню вартість). Браузер і досі користується
// одним дефолтним трекером на вкладку, як і раніше — передавати costTracker
// в opts там не обов'язково.
export const GENERATION_COST_LIMIT = 3; // USD

export function createCostTracker(limit = GENERATION_COST_LIMIT) {
  let cost = 0;
  return {
    get value() { return cost; },
    reset() { cost = 0; },
    check() {
      if (cost > limit) {
        const err = new Error(`⛔ Зупинено: вартість цієї генерації вже перевищила ліміт $${limit} (витрачено $${cost.toFixed(2)}). Уже згенероване/виправлене лишилось як є — перевірте документ вручну.`);
        err.isCostLimit = true;
        throw err;
      }
    },
    // Повертає {settle} — виклич settle(actualCost) щойно реальна вартість
    // відома; якщо виклик впав/обірвався до цього — обов'язково settle(0) в finally.
    reserve(estimatedCost) {
      cost += estimatedCost;
      let settled = false;
      return {
        settle(actualCost) {
          if (settled) return;
          settled = true;
          cost += actualCost - estimatedCost;
        },
        get settled() { return settled; },
      };
    },
  };
}

const defaultCostTracker = createCostTracker();
export function resetGenerationCost() { defaultCostTracker.reset(); }
export function getGenerationCost() { return defaultCostTracker.value; }

// Базовий URL для /api/* — порожній рядок (відносний шлях) у браузері, як і
// зараз. Node-воркер, у якого немає origin сторінки, викликає setApiBase()
// один раз на старті з абсолютною адресою (задеплоєні Vercel-функції або
// локальний dev-сервер).
let API_BASE = "";
export function setApiBase(base) { API_BASE = (base || "").replace(/\/$/, ""); }
// sourcesSearch.js також викликає /api/*, але не з api.js — щоб не тримати
// два окремі API_BASE, воно читає це саме значення через геттер.
export function getApiBase() { return API_BASE; }

// DIRECT_API=1 (лише Node-воркер, читається з env) — замість /api/claude та
// /api/gemini на Vercel, воркер б'є напряму в Anthropic/Google своїм ключем
// (ANTHROPIC_API_KEY, GEMINI_API_KEY або GEMINI_API_KEY_1/2/3 — ті самі назви,
// що в api/claude.js та api/gemini.js, лише в окремому env воркера). Браузер
// не має process — typeof-перевірка тримає цей код безпечним і там.
function isDirectApi() {
  return typeof process !== "undefined" && process.env?.DIRECT_API === "1";
}

// /api/claude та /api/gemini вимагають Authorization — інакше будь-хто з
// інтернету міг би споживати наші ключі напряму. У браузері шлемо Firebase
// ID token залогіненого користувача (динамічний import — firebase.js читає
// import.meta.env, чого нема в Node-воркері, тож статичний import зламав би
// воркер); у Node — окремий серверний секрет WORKER_PROXY_TOKEN.
// Викликається й з sourcesSearch.js (прямі fetch до /api/gemini, в обхід
// postGemini), тому експортована.
export async function getProxyAuthHeaders() {
  if (typeof window !== "undefined") {
    const { auth } = await import("../firebase.js");
    const u = auth.currentUser;
    if (!u) return {};
    return { Authorization: `Bearer ${await u.getIdToken()}` };
  }
  const workerToken = typeof process !== "undefined" && process.env?.WORKER_PROXY_TOKEN;
  return workerToken ? { Authorization: `Bearer ${workerToken}` } : {};
}

async function postClaude(body, signal) {
  if (isDirectApi()) {
    if (body.max_tokens > 64000) body.max_tokens = 64000; // той самий кеп, що й api/claude.js
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("DIRECT_API=1 потребує ANTHROPIC_API_KEY в env воркера");
    return fetch("https://api.anthropic.com/v1/messages", {
      method: "POST", signal,
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify(body),
    });
  }
  return fetch(`${API_BASE}/api/claude`, {
    method: "POST", signal,
    headers: { "Content-Type": "application/json", ...(await getProxyAuthHeaders()) },
    body: JSON.stringify(body),
  });
}

function getDirectGeminiKeys() {
  return [process.env.GEMINI_API_KEY_1, process.env.GEMINI_API_KEY_2, process.env.GEMINI_API_KEY_3, process.env.GEMINI_API_KEY].filter(Boolean);
}

// Пряма ротація ключів для ОДНІЄЇ моделі — той самий підхід, що api/gemini.js
// робить на сервері; фолбек на іншу модель (FALLBACK_MODEL) лишається в
// зовнішньому retry-циклі callGeminiInner і працює однаково в обох режимах.
async function postGemini(model, payload, signal) {
  if (isDirectApi()) {
    const keys = getDirectGeminiKeys();
    if (!keys.length) throw new Error("DIRECT_API=1 потребує GEMINI_API_KEY (або GEMINI_API_KEY_1/2/3) в env воркера");
    let res;
    for (let i = 0; i < keys.length; i++) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${keys[i]}`;
      res = await fetch(url, { method: "POST", signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      if (res.status !== 429 && res.status !== 503) break; // цей ключ відповів (успіх або інша помилка) — решту не пробуємо
    }
    return res;
  }
  return fetch(`${API_BASE}/api/gemini`, {
    method: "POST", signal,
    headers: { "Content-Type": "application/json", ...(await getProxyAuthHeaders()) },
    body: JSON.stringify({ _model: model, ...payload }),
  });
}

// window.dispatchEvent('apicost', ...) — браузерний спосіб донести вартість
// виклику до живого лічильника в UI (academic-assistant.jsx). У Node-воркері
// window немає — там викликач передає opts.onCost і отримує ті самі дані
// прямим викликом функції замість події.
function reportCost(detail, opts) {
  if (opts?.onCost) { opts.onCost(detail); return; }
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("apicost", { detail }));
}

export async function callClaude(messages, signal, systemPrompt, maxTokens, onWait, model, opts) {
  const tracker = opts?.costTracker || defaultCostTracker;
  tracker.check();
  const CLAUDE_PRICES = { [MODEL]: { in: 2, out: 10 }, [MODEL_FAST]: { in: 1, out: 5 } };
  const claudeP = CLAUDE_PRICES[model || MODEL] || CLAUDE_PRICES[MODEL];
  const reservation = tracker.reserve(((maxTokens || 8000) * claudeP.out) / 1_000_000);
  try {
    return await callClaudeInner(messages, signal, systemPrompt, maxTokens, onWait, model, opts, reservation);
  } finally {
    if (!reservation.settled) reservation.settle(0);
  }
}

async function callClaudeInner(messages, signal, systemPrompt, maxTokens, onWait, model, opts, reservation) {
  const MAX_RETRIES = 5;
  let delay = 12000;
  const useStream = (maxTokens || 8000) >= 2000; // stream for large responses only
  // Кешування системного промпту (opts.cache) — вигідно коли той самий system
  // повторюється в кількох послідовних викликах (напр. цикл правок по розділах):
  // перший виклик пише кеш, наступні читають його в рази дешевше.
  // opts.extraCached — додаткові статичні блоки (напр. матеріали клієнта), що
  // повторюються в кожному виклику циклу генерації підрозділів так само незмінно,
  // як system — виносимо їх окремим кешованим блоком замість user-повідомлення,
  // щоб не пересилати їх по повній ціні на кожен підрозділ.
  const baseSystemText = systemPrompt || buildSYS();
  const systemField = (opts?.cache || opts?.extraCached?.length)
    ? [
        { type: "text", text: baseSystemText, ...(opts?.cache ? { cache_control: { type: "ephemeral" } } : {}) },
        ...(opts?.extraCached || []).map(t => ({ type: "text", text: t, cache_control: { type: "ephemeral" } })),
      ]
    : baseSystemText;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await postClaude({
      model: model || MODEL,
      max_tokens: maxTokens || 8000,
      system: systemField,
      messages,
      ...(useStream ? { stream: true } : {}),
    }, signal);

    if (res.status === 429) {
      if (attempt === MAX_RETRIES) throw new Error("Rate limit: спробуйте через хвилину");
      const waitSec = Math.ceil(delay / 1000);
      for (let s = waitSec; s > 0; s--) {
        if (onWait) onWait(s);
        await new Promise(r => setTimeout(r, 1000));
        if (signal?.aborted) throw new Error("AbortError");
      }
      delay = Math.min(delay * 1.5, 60000);
      continue;
    }
    if (res.status === 400) {
      let errData = {};
      try { errData = await res.json(); } catch { }
      const msg = errData?.error?.message || "";
      if (msg.includes("usage limits") || msg.includes("regain access")) {
        throw new Error("💳 Вичерпано місячний ліміт API. Поповніть баланс або підніміть ліміт на console.anthropic.com");
      }
      throw new Error("API 400: " + (msg || "Bad Request"));
    }
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error("API " + res.status + " " + errText.slice(0, 200));
    }

    // --- Streaming path ---
    if (useStream) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let fullText = "";
      let buffer = "";
      let inputTokens = 0, outputTokens = 0, cacheCreationTokens = 0, cacheReadTokens = 0;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (signal?.aborted) throw new Error("AbortError");
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const raw = line.slice(6).trim();
            if (!raw || raw === "[DONE]") continue;
            try {
              const evt = JSON.parse(raw);
              if (evt.type === "content_block_delta" && evt.delta?.type === "text_delta") {
                fullText += evt.delta.text;
              } else if (evt.type === "message_start" && evt.message?.usage) {
                inputTokens = evt.message.usage.input_tokens || 0;
                cacheCreationTokens = evt.message.usage.cache_creation_input_tokens || 0;
                cacheReadTokens = evt.message.usage.cache_read_input_tokens || 0;
              } else if (evt.type === "message_delta" && evt.usage) {
                outputTokens = evt.usage.output_tokens || 0;
              }
            } catch { /* ignore malformed chunks */ }
          }
        }
      } finally {
        reader.releaseLock();
        // Звітуємо про витрачені токени навіть при перериванні (abort) — Anthropic вже їх обробив
        if (inputTokens || outputTokens || cacheCreationTokens || cacheReadTokens) {
          const PRICES = { [MODEL]: { in: 2, out: 10 }, [MODEL_FAST]: { in: 1, out: 5 } };
          const p = PRICES[model || MODEL] || PRICES[MODEL];
          // Запис у кеш коштує 1.25х ціни input, читання з кешу — 0.1х (тарифи Anthropic prompt caching)
          const cost = (inputTokens * p.in + outputTokens * p.out + cacheCreationTokens * p.in * 1.25 + cacheReadTokens * p.in * 0.1) / 1_000_000;
          reservation.settle(cost);
          reportCost({ cost, model: model || MODEL, inTok: inputTokens + cacheCreationTokens + cacheReadTokens, outTok: outputTokens }, opts);
        }
      }
      return fullText;
    }

    // --- Non-streaming path (short JSON tasks) ---
    const data = await res.json();
    if (!data.content) {
      console.error("Claude API unexpected response:", JSON.stringify(data).slice(0, 300));
      throw new Error("No content in response: " + JSON.stringify(data).slice(0, 200));
    }
    if (data.usage) {
      const PRICES = { [MODEL]: { in: 2, out: 10 }, [MODEL_FAST]: { in: 1, out: 5 } };
      const p = PRICES[model || MODEL] || PRICES[MODEL];
      const cacheCreationTokens = data.usage.cache_creation_input_tokens || 0;
      const cacheReadTokens = data.usage.cache_read_input_tokens || 0;
      // Запис у кеш коштує 1.25х ціни input, читання з кешу — 0.1х (тарифи Anthropic prompt caching)
      const cost = (data.usage.input_tokens * p.in + data.usage.output_tokens * p.out + cacheCreationTokens * p.in * 1.25 + cacheReadTokens * p.in * 0.1) / 1_000_000;
      reservation.settle(cost);
      reportCost({ cost, model: model || MODEL, inTok: data.usage.input_tokens + cacheCreationTokens + cacheReadTokens, outTok: data.usage.output_tokens }, opts);
    }
    return data.content.map(b => b.text || "").join("") || "";
  }
}

// ── Один крок агентного циклу з інструментами (tool use) — для агентного режиму
// правок (correctionAgent.js). На відміну від callClaude повертає не текст, а
// повну відповідь ({ content, stop_reason, usage }), бо агенту потрібні блоки
// tool_use. Завжди стрімінг: без нього відповідь на довгий крок приходить лише
// після генерації всього тексту, і запит упирається в таймаут (300 с — і
// функції на Vercel, і заголовків у fetch Node-воркера). Блоки tool_use
// збираються з input_json_delta.
//
// Кешування: system (+ tools перед ним) і extraCached кешуються завжди, а
// останній блок ОСТАННЬОГО й ПЕРЕДОСТАННЬОГО user-повідомлення отримують
// cache_control. Друга точка — там, де кеш записано на попередньому кроці:
// API шукає збіг лише ~20 блоків назад від точки, тож при багатьох паралельних
// викликах за крок одна точка промахувалась і вся історія оплачувалась заново.
//
// Повторні спроби: 429/5xx/529 і обрив мережі чи стріму — з наростаючою паузою.
//
// opts — { tools, costTracker?, onCost?, signal?, extraCached?: string[] }
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504, 529]);
const STEP_RETRIES = 5;

export async function callClaudeMessage(messages, systemPrompt, maxTokens, model, opts = {}) {
  const tracker = opts.costTracker || defaultCostTracker;
  tracker.check();
  const PRICES = { [MODEL]: { in: 2, out: 10 }, [MODEL_FAST]: { in: 1, out: 5 } };
  const p = PRICES[model || MODEL] || PRICES[MODEL];
  const reservation = tracker.reserve(((maxTokens || 8000) * p.out) / 1_000_000);
  try {
    const system = [
      { type: "text", text: systemPrompt || buildSYS(), cache_control: { type: "ephemeral" } },
      ...(opts.extraCached || []).map(t => ({ type: "text", text: t, cache_control: { type: "ephemeral" } })),
    ];
    const breakpointsLeft = Math.max(0, 4 - system.length);
    const userIdx = messages.map((m, i) => (m.role === "user" ? i : -1)).filter(i => i >= 0);
    const cacheAt = new Set(breakpointsLeft ? userIdx.slice(-Math.min(2, breakpointsLeft)) : []);
    const cachedMessages = messages.map((m, mi) => {
      const blocks = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content;
      return {
        role: m.role,
        content: blocks.map((b, bi) => {
          const { cache_control, ...rest } = b; // eslint-disable-line no-unused-vars
          return cacheAt.has(mi) && bi === blocks.length - 1 ? { ...rest, cache_control: { type: "ephemeral" } } : rest;
        }),
      };
    });
    const body = {
      model: model || MODEL,
      max_tokens: maxTokens || 8000,
      system,
      ...(opts.tools?.length ? { tools: opts.tools } : {}),
      messages: cachedMessages,
      stream: true,
    };

    let delay = 5000;
    const wait = async () => {
      await new Promise(r => setTimeout(r, delay));
      delay = Math.min(delay * 2, 60000);
    };
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await postClaude(body, opts.signal);
      } catch (e) {
        // Повторюємо лише справжні мережеві збої ("fetch failed" у Node, "Failed to
        // fetch"/"NetworkError" у браузері), а не помилки налаштування (напр. не
        // задано API_BASE у воркері — "Failed to parse URL"): їх повтор лише гає час.
        const network = /fetch failed|failed to fetch|networkerror|network|ECONN|ETIMEDOUT|socket|terminated/i.test(`${e.message} ${e.cause?.code || ""}`)
          && e.cause?.code !== "ERR_INVALID_URL";
        if (opts.signal?.aborted || attempt >= STEP_RETRIES || !network) {
          if (e.cause?.code === "ERR_INVALID_URL") throw new Error(`Некоректна адреса API (${e.message}). У воркері задайте DIRECT_API=1 з ANTHROPIC_API_KEY або API_BASE/--api-base.`);
          throw e;
        }
        await wait();
        continue;
      }
      if (RETRYABLE_STATUS.has(res.status) && attempt < STEP_RETRIES) {
        await wait();
        continue;
      }
      if (!res.ok) {
        let msg = "";
        try { msg = (await res.json())?.error?.message || ""; } catch { /* тіло не JSON */ }
        if (msg.includes("usage limits") || msg.includes("regain access")) {
          throw new Error("💳 Вичерпано місячний ліміт API. Поповніть баланс або підніміть ліміт на console.anthropic.com");
        }
        throw new Error(`API ${res.status}: ${msg || "помилка запиту"}`);
      }
      let data;
      try {
        data = await readMessageStream(res, opts.signal);
      } catch (e) {
        // Обрив стріму посередині — повторюємо крок цілком (стан агента ще не змінено).
        if (opts.signal?.aborted || attempt >= STEP_RETRIES || e.fatal) throw e;
        await wait();
        continue;
      }
      const u = data.usage;
      const cost = (u.input_tokens * p.in + u.output_tokens * p.out + u.cache_creation_input_tokens * p.in * 1.25 + u.cache_read_input_tokens * p.in * 0.1) / 1_000_000;
      reservation.settle(cost);
      reportCost({ cost, model: model || MODEL, inTok: u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens, outTok: u.output_tokens }, opts);
      return data;
    }
  } finally {
    if (!reservation.settled) reservation.settle(0);
  }
}

// Збирає SSE-стрім Messages API в об'єкт { content, stop_reason, usage }.
// Експортовано для тестів (worker/callClaudeMessage.test.js).
export async function readMessageStream(res, signal) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const content = [];
  const partialJson = {};
  const usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  let stopReason = null;
  let gotStop = false;
  let buffer = "";
  const handle = evt => {
    if (evt.type === "message_start" && evt.message?.usage) {
      const mu = evt.message.usage;
      usage.input_tokens = mu.input_tokens || 0;
      usage.cache_creation_input_tokens = mu.cache_creation_input_tokens || 0;
      usage.cache_read_input_tokens = mu.cache_read_input_tokens || 0;
      usage.output_tokens = mu.output_tokens || 0;
    } else if (evt.type === "content_block_start") {
      const b = evt.content_block || {};
      if (b.type === "tool_use") {
        content[evt.index] = { type: "tool_use", id: b.id, name: b.name, input: {} };
        partialJson[evt.index] = "";
      } else {
        content[evt.index] = { ...b, text: b.text || "" };
      }
    } else if (evt.type === "content_block_delta") {
      const block = content[evt.index];
      if (!block) return;
      if (evt.delta?.type === "text_delta") block.text += evt.delta.text;
      else if (evt.delta?.type === "input_json_delta") partialJson[evt.index] += evt.delta.partial_json || "";
    } else if (evt.type === "content_block_stop") {
      const block = content[evt.index];
      if (block?.type === "tool_use") {
        const json = partialJson[evt.index];
        try { block.input = json ? JSON.parse(json) : {}; } catch { block._truncated = true; }
        delete partialJson[evt.index];
      }
    } else if (evt.type === "message_delta") {
      if (evt.delta?.stop_reason) stopReason = evt.delta.stop_reason;
      if (evt.usage?.output_tokens != null) usage.output_tokens = evt.usage.output_tokens;
    } else if (evt.type === "message_stop") {
      gotStop = true;
    } else if (evt.type === "error") {
      const err = new Error(`API stream error: ${evt.error?.message || evt.error?.type || "невідома помилка"}`);
      // overloaded посеред стріму варто повторити, решту — ні
      err.fatal = evt.error?.type !== "overloaded_error";
      throw err;
    }
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (signal?.aborted) throw new Error("AbortError");
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const raw = line.slice(6).trim();
        if (!raw || raw === "[DONE]") continue;
        let evt;
        try { evt = JSON.parse(raw); } catch { continue; }
        handle(evt);
      }
    }
  } finally {
    reader.releaseLock();
  }
  if (!gotStop && !stopReason) throw new Error("Стрім відповіді обірвався до завершення");
  // tool_use без content_block_stop (обрив на max_tokens посеред JSON)
  Object.keys(partialJson).forEach(i => {
    const block = content[i];
    if (!block) return;
    try { block.input = JSON.parse(partialJson[i]); } catch { block._truncated = true; }
  });
  return { content: content.filter(Boolean), stop_reason: stopReason, usage };
}

const FILE_INLINE_LIMIT = 3 * 1024 * 1024; // 3MB raw → ~4MB base64

async function uploadLargeFile(base64Data, mimeType) {
  const rawSize = Math.floor(base64Data.length * 0.75);
  if (rawSize <= FILE_INLINE_LIMIT) return null;

  // Decode first to get exact byte count (base64 padding makes estimates off by 1-2 bytes)
  const binary = atob(base64Data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  const initRes = await fetch(`${API_BASE}/api/gemini-files-init`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await getProxyAuthHeaders()) },
    body: JSON.stringify({ mimeType, fileSize: bytes.byteLength }),
  });
  if (!initRes.ok) throw new Error("Не вдалось ініціалізувати завантаження файлу");
  const { uploadUrl } = await initRes.json();

  const uploadRes = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      "X-Goog-Upload-Offset": "0",
      "X-Goog-Upload-Command": "upload, finalize",
    },
    body: bytes,
  });
  if (!uploadRes.ok) {
    const errText = await uploadRes.text().catch(() => "");
    throw new Error(`Не вдалось завантажити файл до Gemini (${uploadRes.status}): ${errText.slice(0, 150)}`);
  }
  const data = await uploadRes.json();
  return data.file?.uri;
}

// Ціни за 1M токенів. Код і далі просить назви 2.5-*, але проксі (api/gemini.js) із 21.09.2026 перекладає їх
// на 3.5-flash-lite / 3.5-flash (2.5 закриті для нових ключів) — тож рахуємо за тарифом 3.5 (paid tier).
// Ціни за 1M токенів — за моделлю, яка РЕАЛЬНО відповіла (проксі кладе її у відповідь як _servedModel:
// спершу пробує запитану 2.5-*, а якщо ключам вона недоступна — найдешевшу заміну).
export const GEMINI_PRICES = {
  "gemini-2.5-flash-lite": { in: 0.10, out: 0.40 }, "gemini-2.5-flash": { in: 0.30, out: 2.50 }, "gemini-2.5-pro": { in: 1.25, out: 10.00 },
  "gemini-3.1-flash-lite": { in: 0.25, out: 1.50 }, "gemini-3.5-flash-lite": { in: 0.30, out: 2.50 },
  "gemini-3.8-flash": { in: 0.75, out: 3.75 }, "gemini-3.5-flash": { in: 1.50, out: 9.00 },
};
export function geminiCost(data, askedModel) {
  const u = data?.usageMetadata; if (!u) return 0;
  const p = GEMINI_PRICES[data?._servedModel] || GEMINI_PRICES[askedModel] || GEMINI_PRICES["gemini-3.1-flash-lite"];
  return ((u.promptTokenCount || 0) * p.in + ((u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0)) * p.out) / 1_000_000;
}

export async function callGemini(messages, signal, systemPrompt, maxTokens, onWait, model, jsonMode, opts) {
  const tracker = opts?.costTracker || defaultCostTracker;
  tracker.check();
  const geminiP = GEMINI_PRICES[model || "gemini-2.5-flash-lite"] || GEMINI_PRICES["gemini-2.5-flash-lite"];
  const reservation = tracker.reserve(((maxTokens || 8000) * geminiP.out) / 1_000_000);
  try {
    return await callGeminiInner(messages, signal, systemPrompt, maxTokens, onWait, model, jsonMode, reservation, opts);
  } finally {
    if (!reservation.settled) reservation.settle(0);
  }
}

async function callGeminiInner(messages, signal, systemPrompt, maxTokens, onWait, model, jsonMode, reservation, opts) {
  const MAX_RETRIES = 5;
  const FALLBACK_MODEL = "gemini-2.5-flash";
  const FALLBACK_AFTER_503 = 2;
  let delay = 12000;
  let currentModel = model || "gemini-2.5-flash-lite";
  let failCount503 = 0;

  // Upload large documents to Gemini Files API to bypass Vercel 4.5MB limit
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const part of msg.content) {
      if ((part.type === "document" || part.type === "image") && part.source?.type === "base64") {
        const uri = await uploadLargeFile(part.source.data, part.source.media_type || "application/pdf");
        if (uri) part.source = { type: "file_uri", media_type: part.source.media_type, uri };
      }
    }
  }

  const toGeminiPart = (c) => {
    if ((c.type === "document" || c.type === "image") && c.source?.type === "base64")
      return { inlineData: { mimeType: c.source.media_type || "application/pdf", data: c.source.data } };
    if ((c.type === "document" || c.type === "image") && c.source?.type === "file_uri")
      return { fileData: { mimeType: c.source.media_type || "application/pdf", fileUri: c.source.uri } };
    return { text: c.text || c.content || "" };
  };

  const contents = messages.map((msg, i) => {
    if (Array.isArray(msg.content)) {
      const parts = msg.content.map(toGeminiPart);
      if (i === 0 && systemPrompt) {
        const firstTextIdx = parts.findIndex(p => p.text !== undefined);
        if (firstTextIdx >= 0) parts[firstTextIdx] = { text: systemPrompt + "\n\n" + parts[firstTextIdx].text };
        else parts.unshift({ text: systemPrompt });
      }
      return { role: msg.role === "assistant" ? "model" : "user", parts };
    }
    return {
      role: msg.role === "assistant" ? "model" : "user",
      parts: [{ text: (i === 0 && systemPrompt ? systemPrompt + "\n\n" : "") + (msg.content || "") }],
    };
  });

  const body = {
    contents,
    generationConfig: { maxOutputTokens: maxTokens || 8000, thinkingConfig: { thinkingBudget: 0 }, ...(jsonMode ? { responseMimeType: "application/json" } : {}) },
  };

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await postGemini(currentModel, body, signal);
    // 500 (INTERNAL) — транзієнтна помилка на боці Google (кейс #41504), тому
    // ретраїмо її так само, як 503 (перевантаження), а не кидаємо одразу.
    if (res.status === 429 || res.status === 503 || res.status === 500) {
      if (attempt === MAX_RETRIES) throw new Error(res.status === 429 ? "Rate limit: спробуйте через хвилину" : "Gemini перевантажений, спробуйте ще раз");
      if (res.status === 503 || res.status === 500) {
        failCount503++;
        if (failCount503 >= FALLBACK_AFTER_503 && currentModel !== FALLBACK_MODEL) {
          currentModel = FALLBACK_MODEL;
          failCount503 = 0;
          delay = 3000;
        }
      }
      const waitSec = Math.ceil(delay / 1000);
      for (let s = waitSec; s > 0; s--) {
        if (onWait) onWait(s);
        await new Promise(r => setTimeout(r, 1000));
        if (signal?.aborted) { const e = new Error("AbortError"); e.name = "AbortError"; throw e; }
      }
      delay = Math.min(delay * 1.5, 60000);
      continue;
    }
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error("Gemini API " + res.status + ": " + errText.slice(0, 200));
    }
    const data = await res.json();
    const candidate = data.candidates?.[0];
    const finishReason = candidate?.finishReason;
    if (finishReason && finishReason !== "STOP" && finishReason !== "MAX_TOKENS") {
      throw new Error(`Gemini зупинився: ${finishReason}. ${candidate?.content ? "" : "Відповідь порожня."}`);
    }
    const text = candidate?.content?.parts?.filter(p => !p.thought)?.map(p => p.text || "").join("") || "";
    if (!text) {
      console.error("Gemini порожня відповідь. Raw:", JSON.stringify(data).slice(0, 500));
      throw new Error("Gemini: порожня відповідь" + (finishReason ? ` (${finishReason})` : ""));
    }
    if (data.usageMetadata) {
      const gp = GEMINI_PRICES[currentModel] || GEMINI_PRICES["gemini-2.5-flash-lite"];
      const cost = geminiCost(data, currentModel) || (data.usageMetadata.promptTokenCount * gp.in + data.usageMetadata.candidatesTokenCount * gp.out) / 1_000_000;
      reservation.settle(cost);
      reportCost({ cost, model: currentModel, inTok: data.usageMetadata.promptTokenCount, outTok: data.usageMetadata.candidatesTokenCount }, opts);
    }
    return text;
  }
}
