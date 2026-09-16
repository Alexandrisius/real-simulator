// Наблюдение за прогоном кейса + финальный отчёт. Запуск: RUN_ID=2 node scripts/grok-watch-case.mjs
const BASE = process.env.SIM_BASE ?? "http://127.0.0.1:3999";
const RUN_ID = Number(process.env.RUN_ID ?? 2);

async function api(path) {
  const res = await fetch(BASE + path);
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}
const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const deadline = Date.now() + 45 * 60 * 1000;
let lastLine = "";
while (Date.now() < deadline) {
  await sleep(15000);
  const { report } = await api(`/api/flow-runs/${RUN_ID}`);
  const at = report.characters
    .map((c) => `${c.name}: ${c.status}${c.visits.length ? ` (сцен: ${c.visits.length}, скор ${c.score})` : ""}`)
    .join(" | ");
  if (at !== lastLine) {
    log(`[${new Date().toLocaleTimeString("ru-RU")}] ${at}`);
    lastLine = at;
  }
  if (report.run.status !== "running") break;
}

const { report } = await api(`/api/flow-runs/${RUN_ID}`);
log(`\n=== ИТОГ ПРОГОНА #${RUN_ID}: ${report.run.status} ===`);
const chars = await api("/api/characters");
const sasha = chars.find((c) => c.name === "Саша");
const yana = chars.find((c) => c.name === "Яна");
for (const c of report.characters) {
  log(`${c.emoji} ${c.name}: статус=${c.status}, скор=${c.score}, бонус=${c.bonus}, всего=${c.total}`);
  log(`  отношения: ${c.relations.map((r) => `${r.name}=${r.value}`).join(", ") || "—"}`);
}
const chem = await api("/api/chemistry");
const pair = chem.find(
  (c) => (c.aId === sasha.id && c.bId === yana.id) || (c.aId === yana.id && c.bId === sasha.id)
);
log(`химия пары: ${pair?.value ?? 0}`);
log(`Саша: skill_sex=${sasha.state.skill_sex ?? 0}, money=${sasha.state.money}`);
log(`Яна: mood=${yana.state.mood ?? "?"}, frustration=${yana.state.frustration ?? 0}, worn_underwear="${yana.state.worn_underwear ?? ""}"`);

log("\n=== КЛЮЧЕВЫЕ СОБЫТИЯ ===");
const names = { [sasha.id]: "Саша", [yana.id]: "Яна" };
const seen = new Set();
for (const c of report.characters) {
  for (const v of c.visits) {
    if (v.sceneId == null || seen.has(v.sceneId)) continue;
    seen.add(v.sceneId);
    const events = await api(`/api/scenes/${v.sceneId}/events`);
    log(`\n--- ${v.nodeTitle} ---`);
    for (const ev of events) {
      const who = ev.actorId != null ? names[ev.actorId] ?? `#${ev.actorId}` : "мир";
      if (ev.type === "action") {
        for (const call of ev.payload.calls ?? []) {
          const oc = call.outcome ? ` [ИСХОД: ${call.outcome}]` : "";
          log(`  ${call.ok ? "✓" : "✗"} ${who}: ${call.toolName}${oc}`);
        }
      } else if (ev.type === "director") {
        log(`  💬 ${who}: ${(ev.payload.text ?? "").slice(0, 160)}`);
      } else if (ev.type === "system" && (ev.payload.message ?? "").includes("Практика")) {
        log(`  📈 ${(ev.payload.message ?? "").slice(0, 120)}`);
      }
    }
  }
}
