// Затвердження плану в CRM (docs/crm-integration.md §3.5) — гілка, куди
// потрапляє processOrder(), коли повертає {waiting:"plan_approval"} і в job
// немає client_plan_text/файлу client_plan. GET /plan сам є heartbeat на цей
// час (окремий від звичайного /progress — контракт прямо каже не змішувати).
//
// "Затвердити" (можливо, з правками менеджера) → текст плану розбирає код
// (rebuildPlanFromText: parseClientPlan + збереження сторінок + перерахунок джерел).
// "Відхилити" з коментарем → ШІ (Sonnet) отримує старий план і коментар та повертає
// новий план цілком, далі той самий rebuildPlanFromText. Нового плану воркер не
// "вирішує" сам — він іде в CRM як round=N на затвердження (контракт §3.5).
// Якщо ШІ не зміг внести правку — помилка (не тихий повтор старого плану).
import { loadOrder, saveOrderPatch, appendCostEntry } from "./firestoreAdmin.js";
import { buildPlanText, buildPlanTextWithPages, rebuildPlanFromText, isSamePlanText } from "../src/lib/planUtils.js";
import { buildPlanRewritePrompt } from "../src/lib/prompts.js";
import { callClaude, MODEL, createCostTracker } from "../src/lib/api.js";
import { createTokenAccumulator } from "./tokenAccumulator.js";
import { submitPlan, getPlanStatus } from "./crmClient.js";

const PLAN_POLL_MS = 60_000;
const MAX_ROUNDS = 3;
const SYS_PLAN_TEXT = "Return only the plan text. No markdown, no code fences, no commentary.";

function planError(message) {
  const e = new Error(message);
  e.crmStage = "plan";
  return e;
}

const stripFences = (raw) => String(raw || "").replace(/^\s*```[a-z]*\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();

/**
 * Просить ШІ внести коментар менеджера в план і повертає текст нового плану (з "[N стор.]").
 * Якщо ШІ повернув план без змін — один повтор з нагадуванням; далі помилка.
 * @param {{sections:object[], comment:string, info:object, call:(messages:object[])=>Promise<string>}} p
 */
export async function rewritePlanText({ sections, comment, info, call }) {
  const oldText = buildPlanTextWithPages(sections);
  const prompt = buildPlanRewritePrompt({ topic: info?.topic, language: info?.language, planText: oldText, comment: comment || "" });
  const messages = [{ role: "user", content: prompt }];
  let reply = stripFences(await call(messages));
  if (!reply || isSamePlanText(reply, oldText)) {
    messages.push(
      { role: "assistant", content: reply || "(порожньо)" },
      { role: "user", content: "План лишився без змін, а коментар менеджера вимагає змін. Внеси їх і поверни повний оновлений план (тільки текст плану)." },
    );
    reply = stripFences(await call(messages));
    if (!reply || isSamePlanText(reply, oldText)) {
      throw planError(`ШІ не вніс правку менеджера в план: «${(comment || "").slice(0, 200)}». Потрібне ручне втручання команди.`);
    }
  }
  return reply;
}

// Що змінилось між двома текстами плану (для логу): рядки, яких нема в іншому тексті
function planDiffSummary(before, after) {
  const lines = (t) => t.split("\n").map(l => l.trim()).filter(Boolean);
  const b = lines(before), a = lines(after);
  const removed = b.filter(l => !a.includes(l)), added = a.filter(l => !b.includes(l));
  return [...removed.map(l => `  − ${l}`), ...added.map(l => `  + ${l}`)].slice(0, 20).join("\n");
}

// Поля order, які залежать від sections: джерела на підрозділ, текст плану, загальна кількість джерел
function planPatch(order, plan) {
  return {
    sections: plan.sections,
    planDisplay: plan.planDisplay,
    sourceDist: plan.sourceDist,
    sourceTotal: plan.sourceTotal,
    info: { ...order.info, sourceCount: String(plan.sourceTotal) },
  };
}

async function regenerateFromComment(orderId, comment, costLimit, log) {
  const order = await loadOrder(orderId);
  const tokenAcc = createTokenAccumulator(order);
  const costTracker = createCostTracker(costLimit ?? 6);
  const already = order.totalCostUsd || 0;
  if (already > 0) costTracker.reserve(already).settle(already);
  const onCost = (detail) => {
    tokenAcc.onCost(detail);
    appendCostEntry(orderId, { ...detail, stage: "plan_review" }).catch(() => {});
  };

  const call = (messages) => callClaude(messages, null, SYS_PLAN_TEXT, 3000, null, MODEL, { costTracker, onCost });
  const newText = await rewritePlanText({ sections: order.sections, comment, info: order.info, call });
  const plan = rebuildPlanFromText(order.sections, newText, order.info?.language);
  if (!plan) throw planError("Не вдалось розібрати план, переписаний ШІ за коментарем менеджера (не знайдено розділів або нумерація зламана).");

  await saveOrderPatch(orderId, { ...planPatch(order, plan), ...tokenAcc.snapshot() });
  const diff = planDiffSummary(buildPlanText(order.sections), buildPlanText(plan.sections));
  if (diff) log(`  Зміни в плані:\n${diff}`);
  return plan.sections;
}

/**
 * Прогонить повний цикл затвердження плану для job, що зупинився на
 * plan_approval. Повертає, коли план затверджено (order.status:"plan_approved"
 * уже записано) — виклик processOrder() далі продовжить сам.
 * @param {object} job - job від claimJob() (run_id, limits.cost_usd)
 * @param {string} orderId
 * @param {(msg:string)=>void} log
 */
export async function runPlanReview(job, orderId, log = console.log) {
  let order = await loadOrder(orderId);
  let round = 1;
  let planText = buildPlanText(order.sections);
  // Перевірка плану клієнта (runPlanStage → clientPlanIssues) не пройшла — менеджер
  // бачить причини в картці разом з планом і може виправити план перед затвердженням.
  const warnings = order.clientPlanIssues || [];
  await submitPlan(job.run_id, { planText, round, warnings });
  if (warnings.length) log(`⚠ План клієнта не пройшов перевірку — попередження передано в CRM: ${warnings.join(" | ")}`);
  log(`→ План відправлено на затвердження в CRM (раунд ${round}), чекаю рішення менеджера...`);

  while (true) {
    await new Promise(r => setTimeout(r, PLAN_POLL_MS));
    const status = await getPlanStatus(job.run_id); // CrmCancelledError на 409 — летить нагору

    if (status.state === "pending") continue;

    if (status.state === "approved") {
      order = await loadOrder(orderId);
      const approvedText = (status.plan_text || planText).trim();
      if (approvedText !== planText.trim()) {
        log("→ Менеджер відредагував план — перерозбираю за новим текстом.");
        const plan = rebuildPlanFromText(order.sections, approvedText, order.info?.language);
        if (!plan) throw planError("Не вдалось розібрати план, відредагований менеджером у CRM (не знайдено розділів).");
        await saveOrderPatch(orderId, { ...planPatch(order, plan), clientPlan: approvedText, status: "plan_approved" });
      } else {
        await saveOrderPatch(orderId, { status: "plan_approved" });
      }
      log("✓ План затверджено, продовжую генерацію.");
      return;
    }

    if (status.state === "rejected") {
      round = status.round || round + 1;
      if (round > MAX_ROUNDS) {
        const e = new Error(`План відхилено ${MAX_ROUNDS} рази — потрібне ручне втручання команди.`);
        e.crmRetryable = false;
        e.crmStage = "plan";
        throw e;
      }
      log(`→ План відхилено (наступний раунд ${round}): ${status.comment || "(без коментаря)"}. Перегенеровую.`);
      const nextSections = await regenerateFromComment(orderId, status.comment, job.limits?.cost_usd, log);
      planText = buildPlanText(nextSections);
      await submitPlan(job.run_id, { planText, round });
      log(`→ Оновлений план відправлено (раунд ${round}), чекаю рішення менеджера...`);
      continue;
    }

    log(`⚠ Невідомий стан плану від CRM: ${JSON.stringify(status)} — продовжую опитування.`);
  }
}
