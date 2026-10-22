// HTTP-клієнт до SW CRM за контрактом docs/crm-integration.md (v1.1). Лише
// worker → CRM (pull), вхідних портів на боці воркера немає. Усі деталі
// протоколу (заголовки, коди відповідей, форма тіл) — звідти; тут лише
// тонка обгортка без бізнес-логіки.
const BASE = () => (process.env.CRM_BASE_URL || "").replace(/\/$/, "");
const TOKEN = () => process.env.ACADEM_WORKER_TOKEN;

function authHeaders(extra) {
  const token = TOKEN();
  if (!token) throw new Error("ACADEM_WORKER_TOKEN не задано — потрібен для звернень до CRM");
  return { Authorization: `Bearer ${token}`, ...extra };
}

function requireBase() {
  const base = BASE();
  if (!base) throw new Error("CRM_BASE_URL не задано");
  return base;
}

// Позначає скасування CRM (409) окремим прапорцем — виклики мають розрізняти
// "робота більше не активна" (зупинитись мовчки, нічого не слати) від решти
// мережевих/серверних помилок (варто залогувати й спробувати ще раз пізніше).
class CrmCancelledError extends Error {
  constructor() {
    super("CRM: робота більше не активна (409) — зупиняюсь");
    this.crmCancelled = true;
  }
}

/**
 * POST /jobs/claim — взяти наступну роботу. null, якщо черга порожня (204).
 */
export async function claimJob(workerId) {
  const res = await fetch(`${requireBase()}/jobs/claim`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ worker_id: workerId }),
  });
  if (res.status === 204) return null;
  if (!res.ok) throw new Error(`CRM claim ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  return res.json();
}

/**
 * POST /jobs/{run_id}/progress — прогрес + heartbeat. Кидає CrmCancelledError на 409.
 */
export async function sendProgress(runId, { stage, pct, note, cost_usd }) {
  const res = await fetch(`${requireBase()}/jobs/${runId}/progress`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ stage, pct, note, cost_usd }),
  });
  if (res.status === 409) throw new CrmCancelledError();
  if (!res.ok) throw new Error(`CRM progress ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  return res.json();
}

/**
 * POST /jobs/{run_id}/plan — віддати план на затвердження (§3.5).
 */
export async function submitPlan(runId, { planText, round, warnings }) {
  const body = { plan_text: planText, round };
  if (warnings?.length) body.warnings = warnings; // §3.5 v1.2 — лише коли перевірка плану клієнта не пройшла
  const res = await fetch(`${requireBase()}/jobs/${runId}/plan`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });
  if (res.status === 409) throw new CrmCancelledError();
  if (!res.ok) throw new Error(`CRM POST /plan ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  return res.json();
}

/**
 * GET /jobs/{run_id}/plan — стан затвердження. {state:"pending"|"approved"|"rejected", ...}
 */
export async function getPlanStatus(runId) {
  const res = await fetch(`${requireBase()}/jobs/${runId}/plan`, {
    method: "GET",
    headers: authHeaders(),
  });
  if (res.status === 409) throw new CrmCancelledError();
  if (!res.ok) throw new Error(`CRM GET /plan ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  return res.json();
}

/**
 * POST /jobs/{run_id}/result — готово. files: [{ name, buffer, contentType }].
 */
export async function sendResult(runId, { meta, files }) {
  const form = new FormData();
  form.append("meta", new Blob([JSON.stringify(meta)], { type: "application/json" }), "meta.json");
  for (const f of files) {
    form.append("files[]", new Blob([f.buffer], { type: f.contentType || "application/octet-stream" }), f.name);
  }
  const res = await fetch(`${requireBase()}/jobs/${runId}/result`, {
    method: "POST",
    headers: authHeaders(), // Content-Type для multipart виставляє сам fetch (з boundary)
    body: form,
  });
  if (!res.ok) throw new Error(`CRM result ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  return res.json();
}

/**
 * POST /jobs/{run_id}/error — не вийшло.
 */
export async function sendError(runId, { stage, message, cost_usd, retryable }) {
  const res = await fetch(`${requireBase()}/jobs/${runId}/error`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ stage, message, cost_usd, retryable }),
  });
  if (!res.ok) throw new Error(`CRM error-report ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  return res.json();
}

export { CrmCancelledError };
