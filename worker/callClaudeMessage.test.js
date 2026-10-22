// Тест кроку агента в api.js (callClaudeMessage + readMessageStream) без
// мережі: глобальний fetch підмінено, відповіді — справжній SSE-формат Messages
// API, розрізаний на шматки посеред рядків і посеред JSON інструмента.
// Запуск: node worker/callClaudeMessage.test.js
import assert from "node:assert/strict";
import { callClaudeMessage, createCostTracker, MODEL } from "../src/lib/api.js";

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (err) {
    console.error(`FAIL - ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

function sse(events, chunkSize = 37) {
  const raw = events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  const bytes = new TextEncoder().encode(raw);
  return new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += chunkSize) controller.enqueue(bytes.slice(i, i + chunkSize));
      controller.close();
    },
  });
}

const TOOL_JSON = JSON.stringify({ paragraph: 12, old: "памилка", new: "помилка «лапки»" });
const EVENTS = [
  { type: "message_start", message: { usage: { input_tokens: 100, cache_creation_input_tokens: 2000, cache_read_input_tokens: 5000, output_tokens: 1 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Виправляю " } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "помилку." } },
  { type: "content_block_stop", index: 0 },
  { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tu_1", name: "replace_text", input: {} } },
  { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: TOOL_JSON.slice(0, 15) } },
  { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: TOOL_JSON.slice(15) } },
  { type: "content_block_stop", index: 1 },
  { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 40 } },
  { type: "message_stop" },
];

const calls = [];
let script = [];
globalThis.fetch = async (url, init) => {
  calls.push({ url, body: JSON.parse(init.body) });
  const next = script.shift();
  if (next === "529") return new Response(JSON.stringify({ error: { message: "overloaded" } }), { status: 529 });
  if (next === "cut") return new Response(sse(EVENTS.slice(0, 7)), { status: 200 });
  return new Response(sse(EVENTS), { status: 200 });
};

const conversation = [
  { role: "user", content: [{ type: "text", text: "зауваження" }] },
  { role: "assistant", content: [{ type: "tool_use", id: "a", name: "read_paragraphs", input: { from: 0 } }] },
  { role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: "текст" }] },
  { role: "assistant", content: [{ type: "tool_use", id: "b", name: "search", input: { query: "x" } }] },
  { role: "user", content: [{ type: "tool_result", tool_use_id: "b", content: "знайдено", cache_control: { type: "ephemeral" } }] },
];

await test("стрім збирається у { content, stop_reason, usage }; tool_use — зі шматків JSON", async () => {
  script = ["ok"];
  calls.length = 0;
  const tracker = createCostTracker(10);
  const data = await callClaudeMessage(conversation, "system", 4000, MODEL, { tools: [{ name: "replace_text", input_schema: { type: "object" } }], extraCached: ["doc"], costTracker: tracker });
  assert.equal(data.stop_reason, "tool_use");
  assert.equal(data.content[0].text, "Виправляю помилку.");
  assert.deepEqual(data.content[1], { type: "tool_use", id: "tu_1", name: "replace_text", input: JSON.parse(TOOL_JSON) });
  assert.deepEqual(data.usage, { input_tokens: 100, output_tokens: 40, cache_creation_input_tokens: 2000, cache_read_input_tokens: 5000 });
  assert.ok(tracker.value > 0 && tracker.value < 0.1, `вартість кроку порахована: ${tracker.value}`);

  const body = calls[0].body;
  assert.equal(body.stream, true);
  assert.equal(body.tools.length, 1);
  const marks = JSON.stringify(body).match(/cache_control/g).length;
  assert.equal(marks, 4, "system + extraCached + два останні user-повідомлення");
  assert.ok(body.messages[2].content.at(-1).cache_control && body.messages[4].content.at(-1).cache_control);
  assert.ok(!body.messages[0].content.at(-1).cache_control, "стара позначка з першого повідомлення знята");
});

await test("529 і обірваний стрім — повторюються, крок не губиться", async () => {
  script = ["529", "cut", "ok"];
  calls.length = 0;
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn) => realSetTimeout(fn, 0); // без реальних пауз у тесті
  try {
    const data = await callClaudeMessage(conversation, "system", 4000, MODEL, { tools: [{ name: "x", input_schema: { type: "object" } }], costTracker: createCostTracker(10) });
    assert.equal(calls.length, 3);
    assert.equal(data.content[1].name, "replace_text");
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
});

await test("без інструментів поле tools не надсилається (розпізнавання фото)", async () => {
  script = ["ok"];
  calls.length = 0;
  await callClaudeMessage([{ role: "user", content: "фото" }], "system", 1000, MODEL, { costTracker: createCostTracker(10) });
  assert.ok(!("tools" in calls[0].body));
});

console.log(`\n${passed} passed`);
