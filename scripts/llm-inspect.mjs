// Инспекция приёмочного теста: что реально уходило в промпты (api_logs),
// текущие отношения/знания/state. usage: node scripts/llm-inspect.mjs <sceneId>
import { DatabaseSync } from "node:sqlite";

const BASE = process.env.SIM_BASE ?? "http://127.0.0.1:3999";
const sceneId = Number(process.argv[2]);
const DB = process.env.SIM_DB_PATH ?? "data/smoke.db";

async function api(path) {
  const res = await fetch(BASE + path);
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}

const scene = await api(`/api/scenes/${sceneId}`);
const participants = scene.participants; // {id,name,emoji}
console.log(`=== Сцена #${sceneId} «${scene.scene.name}» place=${scene.scene.config.place || "—"} ===`);

// ---- Промпты: последний запрос каждого персонажа ----
const logs = await api(`/api/scenes/${sceneId}/apilogs`);
for (const p of participants) {
  const mine = logs.filter((l) => l.characterId === p.id);
  if (mine.length === 0) continue;
  const last = mine[mine.length - 1];
  const req = JSON.parse(last.requestJson);
  const sys = req.messages.find((m) => m.role === "system")?.content ?? "";
  console.log(`\n----- ПРОМПТ ${p.emoji} ${p.name} (лог #${last.id}, ${req.messages.length} сообщений, tools: ${req.tools?.length ?? 0}) -----`);
  console.log(sys);
  console.log("[маркеры]");
  for (const marker of ["Место:", "Твоё отношение к другим", "скрытое и репутация", "reveal_attribute", "одежда", "undress", "деньги", "магазин"]) {
    if (sys.includes(marker)) console.log(`  ✓ ${marker}`);
  }
}

// ---- Утечки истины: чужие скрытые ключи/значения в промпте наблюдателя ----
console.log(`\n----- ПРОВЕРКА УТЕЧЕК (последние промпты обоих) -----`);
const hidden = {};
const db = new DatabaseSync(DB, { readonly: true });
const attrRows = db.prepare("SELECT key, visibility, covered_by FROM attributes").all();
for (const a of attrRows) if (a.visibility === "hidden") hidden[a.key] = true;
const charRows = db.prepare("SELECT id, name, state FROM characters").all();
const stateOf = Object.fromEntries(charRows.map((c) => [c.name, JSON.parse(c.state)]));
for (const p of participants) {
  const mine = logs.filter((l) => l.characterId === p.id);
  const last = mine[mine.length - 1];
  if (!last) continue;
  const sys = JSON.parse(last.requestJson).messages.find((m) => m.role === "system")?.content ?? "";
  for (const other of participants) {
    if (other.id === p.id) continue;
    for (const key of Object.keys(hidden)) {
      const val = stateOf[other.name]?.[key];
      if (val === undefined) continue;
      const leakedKey = sys.includes(key);
      const leakedVal = String(val).length >= 2 && sys.includes(`${key}: ${String(val)}`);
      console.log(`  ${p.name} не должен знать ${other.name}.${key}=${val}: ключ в промпте: ${leakedKey ? "!! УТЕЧКА" : "нет ✓"}; значение: ${leakedVal ? "!! УТЕЧКА" : "нет ✓"}`);
    }
  }
}

// ---- Отношения ----
console.log(`\n----- ОТНОШЕНИЯ (матрица) -----`);
const rels = db.prepare("SELECT from_id, to_id, value FROM relations").all();
const nameById = Object.fromEntries(charRows.map((c) => [c.id, c.name]));
for (const r of rels) {
  if (!participants.some((p) => p.id === r.from_id) && !participants.some((p) => p.id === r.to_id)) continue;
  console.log(`  ${nameById[r.from_id]} → ${nameById[r.to_id]} = ${r.value}`);
}

// ---- Знания ----
console.log(`\n----- ЗНАНИЯ (картины мира) -----`);
const kn = db.prepare("SELECT observer_id, subject_id, key, status, value FROM knowledge").all();
if (kn.length === 0) console.log("  (пусто — заявлений не было)");
for (const k of kn) {
  console.log(`  ${nameById[k.observer_id]} знает про ${nameById[k.subject_id]}: ${k.key} = ${k.value} [${k.status}]`);
}

// ---- State персонажей ----
console.log(`\n----- STATE -----`);
for (const p of participants) {
  const c = await api(`/api/characters/${p.id}`);
  console.log(`  ${p.name}: ${JSON.stringify(c.state)}`);
}

// ---- Действия по итогам ----
console.log(`\n----- ДЕЙСТВИЯ (итог по вызовам) -----`);
const events = await api(`/api/scenes/${sceneId}/events`);
const stats = {};
for (const e of events) {
  for (const c of e.payload.calls ?? []) {
    const k = `${c.toolName}:${c.ok ? "ok" : "fail"}`;
    stats[k] = (stats[k] ?? 0) + 1;
  }
}
console.log("  " + JSON.stringify(stats));
const fails = events.flatMap((e) => (e.payload.calls ?? []).filter((c) => !c.ok).map((c) => `${c.toolName}: ${c.result.slice(0, 150)}`));
for (const f of fails) console.log(`  ✗ ${f}`);
const spend = scene.scene.spentTokens;
console.log(`\nрасход: ${scene.scene.spentApiCalls} вызовов, ${spend} токенов (~$${((spend * 0.3 * 1.25 + scene.scene.spentApiCalls * 800 * 2.5) / 1e6).toFixed(2)} грубо)`);
