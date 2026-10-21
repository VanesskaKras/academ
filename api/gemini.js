// Gemini 2.5 Flash — дешева альтернатива Sonnet для генерації тексту
import { requireAuth, applyCors } from "./_auth.js";

export const config = {
    maxDuration: 60,
    api: {
        bodyParser: {
            sizeLimit: "32mb",
        },
    },
};

function getApiKeys() {
    const keys = [
        process.env.GEMINI_API_KEY_1,
        process.env.GEMINI_API_KEY_2,
        process.env.GEMINI_API_KEY_3,
        process.env.GEMINI_API_KEY,
    ].filter(Boolean);
    return keys.length > 0 ? keys : [];
}

export default async function handler(req, res) {
    applyCors(req, res, "GET,POST");
    if (req.method === "OPTIONS") return res.status(204).end();
    if (req.method === "GET") {
        if (!(await requireAuth(req, res))) return;
        const keys = getApiKeys();
        const listUrl = `https://generativelanguage.googleapis.com/v1beta/models?key=${keys[0]}`;
        const r = await fetch(listUrl);
        const d = await r.json();
        return res.status(200).json(d);
    }
    if (req.method !== "POST") return res.status(405).end();
    if (!(await requireAuth(req, res))) return;

    const keys = getApiKeys();
    if (keys.length === 0) {
        return res.status(500).json({ error: "No Gemini API keys configured" });
    }

    const { _model, ...body } = req.body;
    // Спершу пробуємо РІВНО ту модель, яку просить код (2.5-* — найдешевші: lite $0.10/$0.40, flash $0.30/$2.50
    // за 1M). Для частини ключів Google їх закрив («no longer available to new users», 404) — тоді, і лише
    // тоді, йдемо на найдешевшу доступну заміну, а не одразу на 3.5 (lite $0.30/$2.50, flash $1.50/$9.00).
    const MODEL_CHAIN = {
        "gemini-2.5-flash-lite": ["gemini-2.5-flash-lite", "gemini-3.1-flash-lite", "gemini-3.5-flash-lite"],
        "gemini-2.5-flash":      ["gemini-2.5-flash", "gemini-3.8-flash", "gemini-3.5-flash"],
        "gemini-2.5-pro":        ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-3.8-flash"],
    };
    const asked = _model || "gemini-2.5-flash";
    const requestedModel = asked;

    // 3.5-flash-lite не приймає thinkingConfig.thinkingBudget (400 «Request contains an invalid argument»),
    // а бібліотека шле thinkingBudget:0 у кожному callGemini. Lite і так не «думає» — прибираємо параметр
    // для lite; для 3.5-flash лишаємо 0 (інакше ~1000 токенів роздумів на виклик, а вони платні як output).
    const stripThinking = (m) => /flash-lite/.test(m);
    const bodyFor = (m) => {
        if (!stripThinking(m) || !body?.generationConfig?.thinkingConfig) return body;
        const { thinkingConfig, ...gc } = body.generationConfig;
        return { ...body, generationConfig: gc };
    };

    // Ланцюжок: модель недоступна ключам або перевантажена — наступна
    const modelsToTry = MODEL_CHAIN[requestedModel] || [requestedModel];

    let lastError = null;
    const tried = [];   // діагностика без секретів: модель · № ключа · код · початок тексту помилки
    for (const model of modelsToTry) {
        let allOverloaded = true;
        for (let i = 0; i < keys.length; i++) {
            try {
                const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${keys[i]}`;
                const response = await fetch(url, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(bodyFor(model)),
                });

                const data = await response.json();
                if (!response.ok) tried.push(`${model}#${i + 1}:${response.status}:${String(data?.error?.message || '').replace(/[^\x20-\x7E]/g, '').slice(0, 90)}`);

                // 402 (вичерпано передплату) / 401 / 403 (ключ вимкнено чи обмежено) — проблема КОНКРЕТНОГО ключа:
                // пробуємо наступний, а не валимо весь виклик (21.09.2026: перший ключ без кредитів → падали всі)
                // 404 — ця модель недоступна САМЕ цьому ключу: пробуємо інші ключі, потім наступну модель ланцюжка
                if ([401, 402, 403, 404].includes(response.status)) {
                    console.warn(`Gemini model=${model} key ${i + 1} returned ${response.status} — next key | ${String(data?.error?.message || '').slice(0, 180)}`);
                    // Файл (методичка >3 МБ) завантажено через gemini-files-init під ключем 1 — ключі з іншого
                    // проєкту його не бачать (403 «permission to access the File»). Це не справжня причина збою:
                    // не затираємо нею lastError, інакше 429/503 перших ключів (перевантаження — клієнт повторив
                    // би) ховались за 403 і генерація падала без повтору (кейс 41510, 24.09.2026).
                    const fileDenied = response.status === 403 && /access the File/i.test(String(data?.error?.message || ""));
                    if (!fileDenied || !lastError) lastError = { status: response.status, data };
                    continue;
                }
                if (response.status === 429 || response.status === 503) {
                    console.warn(`Gemini model=${model} key ${i + 1} returned ${response.status}`);
                    lastError = { status: response.status, data };
                    continue;
                }

                allOverloaded = false;

                if (!response.ok) {
                    console.error("Gemini API error:", response.status, JSON.stringify(data));
                    return res.status(response.status).json(data);
                }

                if (data && typeof data === "object") data._servedModel = model;   // для обліку вартості в бібліотеці
                res.setHeader("x-gemini-model", model);
                if (tried.length) res.setHeader("x-gemini-tried", tried.join(" || ").slice(0, 1500));   // яка модель реально відповіла (для перевірки й обліку)
                return res.status(200).json(data);
            } catch (e) {
                console.error(`Gemini model=${model} key ${i + 1} error:`, e.message);
                lastError = { status: 500, data: { error: e.message } };
                allOverloaded = false;
            }
        }
        if (allOverloaded) {
            console.warn(`All keys overloaded for model=${model}, trying fallback`);
        } else {
            break;
        }
    }

    console.error("All Gemini models/keys exhausted");
    res.status(lastError.status).json(lastError.data);
}
