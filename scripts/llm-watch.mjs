// Наблюдатель за сценой: печатает новые события по мере появления,
// выходит при завершении сцены или по дедлайну. usage:
//   node scripts/llm-watch.mjs <sceneId> [timeoutMs]

const BASE = process.env.SIM_BASE ?? "http://127.0.0.1:3999";
const sceneId = Number(process.argv[2]);
const deadline = Date.now() + Number(process.argv[3] ?? 10 * 60_000);

async function api(path) {
  const res = await fetch(BASE + path);
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}

const nameOf = new Map();
let lastId = 0;
let status = "";
(async () => {
  const data = await api(`/api/scenes/${sceneId}`);
  data.participants.forEach((p) => nameOf.set(p.id, `${p.emoji} ${p.name}`));
  console.log(`сцена #${sceneId} «${data.scene.name}» place=${data.scene.config.place || "—"}, цель: ${deadline - Date.now()}ms`);
  while (Date.now() < deadline) {
    const st = await api(`/api/scenes/${sceneId}`);
    if (st.runtime.status !== status) {
      status = st.runtime.status;
      console.log(`\n[статус: ${status}] ход ${st.runtime.turn}, вызовов ${st.runtime.spentApiCalls}, токенов ${st.runtime.spentTokens}`);
    }
    const events = await api(`/api/scenes/${sceneId}/events`);
    for (const e of events) {
      if (e.id <= lastId) continue;
      lastId = e.id;
      const who = e.actorId != null ? (nameOf.get(e.actorId) ?? `#${e.actorId}`) : "—";
      if (e.type === "speech") {
        console.log(`\n${who}: ${(e.payload.text ?? "").slice(0, 400)}`);
      } else if (e.type === "action") {
        for (const c of e.payload.calls ?? []) {
          const mark = c.ok ? "✓" : "✗";
          console.log(`  ${mark} ${who} → ${c.toolName}(${JSON.stringify(c.args).slice(0, 160)})${c.ok ? "" : ` | ОТКАЗ: ${c.result.slice(0, 220)}`}`);
          if (c.ok && c.observation && c.audience === "all") console.log(`      все видят: ${c.observation.slice(0, 160)}`);
        }
        const rel = e.payload.relationChanges ?? [];
        if (rel.length) console.log(`      [relations] ${rel.map((r) => `${nameOf.get(r.fromId)}→${nameOf.get(r.toId)}=${r.value}`).join(", ")}`);
      } else if (e.type === "director") {
        const aud = Array.isArray(e.audience) ? e.audience.map((id) => nameOf.get(id)).join(",") : e.audience;
        console.log(`\n[режиссёр → ${aud}] ${(e.payload.text ?? "").slice(0, 300)}`);
      } else if (e.type === "system") {
        console.log(`[система] ${(e.payload.message ?? "").slice(0, 200)}`);
      }
    }
    if (status === "finished" || status === "idle") {
      console.log("\n(сцена завершена)");
      break;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
})().catch((e) => {
  console.error("watch error:", e.message);
  process.exit(1);
});
