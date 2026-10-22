#!/usr/bin/env node
// Керування паузою конвеєра (worker/pipeline.js). Не впливає на ручні
// одноразові запуски worker/runOrder.js — той пауза конвеєра не стосується.
import { readPipelineControl, setPipelinePaused } from "./firestoreAdmin.js";

const cmd = process.argv[2];

async function main() {
  if (cmd === "pause") {
    await setPipelinePaused(true);
    console.log("⏸ Конвеєр поставлено на паузу. Замовлення, що вже в роботі, зупиниться на найближчому чекпойнті (максимум — час одного підрозділу).");
  } else if (cmd === "resume") {
    await setPipelinePaused(false);
    console.log("▶ Конвеєр знято з паузи.");
  } else if (cmd === "status") {
    const control = await readPipelineControl();
    console.log(control.paused ? "⏸ На паузі" : "▶ Працює");
  } else {
    console.error("Використання: node worker/pipelineControl.js pause|resume|status");
    process.exit(1);
  }
}

main().catch(e => {
  console.error("✗ Помилка:", e.message);
  process.exit(1);
});
