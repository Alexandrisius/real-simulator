// Одноразовый наблюдатель за живой сценой: node scripts/observe-scene.mjs <sceneId> <afterTurn>
const id = process.argv[2] ?? "1";
const after = Number(process.argv[3] ?? 0);
const BASE = process.env.LIVE_BASE ?? "http://127.0.0.1:3998";
const names = {};
for (const p of (await (await fetch(`${BASE}/api/scenes/${id}`)).json()).participants) names[p.id] = p.name;
const ev = await (await fetch(`${BASE}/api/scenes/${id}/events?after=0`)).json();
for (const e of ev.filter((x) => x.turn >= after)) {
  const w = e.actorId != null ? (names[e.actorId] ?? `#${e.actorId}`) : "Мир";
  if (e.type === "speech") console.log(e.turn, `${w}:`, String(e.payload.text).slice(0, 130));
  else if (e.type === "action")
    for (const c of e.payload.calls ?? [])
      console.log(e.turn, "⚙", w, "→", c.toolName, c.offered ? "[ПРЕДЛ]" : "", c.ok ? "✓" : "✗", "|", String(c.observation || c.result).slice(0, 130));
  else if (e.type === "director") console.log(e.turn, "🎬", String(e.payload.text || "").slice(0, 150));
  else if (e.type === "system") console.log(e.turn, "ℹ", String(e.payload.message || "").slice(0, 150));
}
const s = (await (await fetch(`${BASE}/api/scenes/${id}`)).json()).scene;
console.log(`— status: ${s.status} turn: ${s.cursor} api: ${s.spentApiCalls} tokens: ${s.spentTokens}`);
