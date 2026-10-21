import { requireAuth } from "./_auth.js";
// Серверний проксі для рендеру PlantUML-діаграм у PNG через Kroki (https://kroki.io)
export const config = { maxDuration: 20 };

function withTimeout(promise, ms = 12000) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
}

async function fetchKroki(source, timeoutMs) {
  const r = await withTimeout(
    fetch('https://kroki.io/plantuml/png', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ diagram_source: source }),
    }),
    timeoutMs,
  );
  if (!r.ok) {
    const errText = await r.text().catch(() => '');
    throw new Error(`Kroki ${r.status}: ${errText.slice(0, 300)}`);
  }
  return Buffer.from(await r.arrayBuffer());
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    return res.status(200).end();
  }
  if (req.method !== 'POST') return res.status(405).end();
  // закрито тим самим токеном, що /api/gemini і /api/claude: відкритий адрес дозволяв будь-кому
  // палити кредити Serper/квоти Books/CORE та ходити через fetch-meta (22.09.2026)
  if (!(await requireAuth(req, res))) return;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  const { source } = req.body || {};
  if (!source || typeof source !== 'string') {
    return res.status(400).json({ error: 'Missing diagram source' });
  }

  // Одна повторна спроба при тайм-ауті/збої Kroki — рисунок раніше мовчки зникав
  // через разову затримку сервісу. Перша спроба 12с, друга коротша 6с, разом
  // укладаємось у maxDuration 20с serverless-функції.
  try {
    const buf = await fetchKroki(source, 12000);
    return res.status(200).json({ image: buf.toString('base64') });
  } catch (e1) {
    console.error('Kroki attempt 1 failed:', e1.message);
    try {
      const buf = await fetchKroki(source, 6000);
      return res.status(200).json({ image: buf.toString('base64') });
    } catch (e2) {
      console.error('Kroki attempt 2 failed:', e2.message);
      return res.status(200).json({ error: 'render_failed' });
    }
  }
}
