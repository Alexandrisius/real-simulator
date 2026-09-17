// Live-проверка новых механик на реальной модели (Grok 4.20 через OpenRouter).
// Сервер должен быть уже запущен: npm run dev -- -p 3999 с SIM_DB_PATH=data/grok-test.db
// и NODE_USE_SYSTEM_CA=1 (см. AGENTS.md). Скрипт:
//   1) --copy-providers  переносит провайдеров из data/app.db (ключ не печатается)
//   2) --seed            создаёт мир: атрибуты, места, слоты, одежду, тулы
//                        (согласие/границы/комбо), персонажей, сцену с finish-условиями
//   3) --run [минуты]    стартует сцену и пишет живой транскрипт в data/grok-live-transcript.txt
// Использование: node scripts/grok-live-check.mjs --copy-providers --seed --run 10
import { DatabaseSync } from "node:sqlite";
import { writeFileSync, existsSync, readFileSync } from "node:fs";

const args = process.argv.slice(2);
const BASE = process.env.LIVE_BASE ?? "http://127.0.0.1:3999";
const flag = (name) => args.includes(name);
const minutes = Number(args[args.indexOf("--run") + 1] ?? 0) || 10;

async function api(path, method = "GET", body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${method} ${path} → HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  if (!res.ok) throw new Error(`${method} ${path} → HTTP ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
  return json;
}

// ---------- 1. Провайдеры из живой БД (ключ не печатаем!) ----------
function copyProviders() {
  if (!existsSync("data/app.db")) throw new Error("data/app.db не найден");
  const db = new DatabaseSync("data/app.db", { readOnly: true });
  const rows = db.prepare("SELECT name, kind, base_url, api_key FROM providers").all();
  db.close();
  if (rows.length === 0) throw new Error("В app.db нет провайдеров");
  console.log(`Провайдеры в app.db: ${rows.map((r) => r.name).join(", ")} — переношу...`);
  return Promise.all(
    rows.map((r) =>
      api("/api/providers", "POST", { name: r.name, kind: r.kind, baseUrl: r.base_url, apiKey: r.api_key })
    )
  ).then((created) => {
    console.log(`Перенесено провайдеров: ${created.length}`);
    return created;
  });
}

// ---------- 2. Мир для проверки механик ----------
async function wipeWorld() {
  const del = (p) => api(p, "DELETE").catch(() => null);
  for (const s of await api("/api/scenes").catch(() => [])) await del(`/api/scenes/${s.id}`);
  for (const c of await api("/api/characters").catch(() => [])) await del(`/api/characters/${c.id}`);
  for (const c of await api("/api/combos").catch(() => [])) await del(`/api/combos/${c.id}`);
  for (const g of await api("/api/garments").catch(() => [])) await del(`/api/garments/${g.id}`);
  for (const t of await api("/api/tools").catch(() => [])) await del(`/api/tools/${t.id}`);
  for (const a of await api("/api/attributes").catch(() => [])) await del(`/api/attributes/${a.id}`);
  for (const s of await api("/api/clothing-slots").catch(() => [])) await del(`/api/clothing-slots/${encodeURIComponent(s.slot)}`);
  for (const p of await api("/api/places").catch(() => [])) await del(`/api/places/${encodeURIComponent(p.name)}`);
  console.log("Старый мир вычищен.");
}

async function seed() {
  const providers = await api("/api/providers");
  const grok = providers.find((p) => p.kind === "openrouter") ?? providers[0];
  const modelsResp = await api(`/api/providers/${grok.id}/models`);
  const models = Array.isArray(modelsResp) ? modelsResp : (modelsResp.models ?? []);
  const model =
    models.find((m) => m === "x-ai/grok-4.20") ??
    models.find((m) => m.includes("grok-4.20")) ??
    models.find((m) => m.includes("grok")) ??
    models[0];
  console.log(`Провайдер: ${grok.name}, модель: ${model}`);
  await wipeWorld();

  // Атрибуты
  const attrs = [
    { key: "mood", label: "Настроение", emoji: "😊", type: "number", min: 0, max: 10, position: 1 },
    { key: "arousal", label: "Возбуждение", emoji: "🔥", type: "number", min: 0, max: 10, position: 2, visibility: "hidden", coveredBy: [] },
    { key: "anxiety", label: "Тревожность", emoji: "😰", type: "number", min: 0, max: 10, position: 3 },
    { key: "trust", label: "Доверие", emoji: "🤝", type: "number", min: 0, max: 10, position: 4 },
  ];
  const attrIds = {};
  for (const a of attrs) attrIds[a.key] = (await api("/api/attributes", "POST", a)).id;

  // Места
  for (const [i, p] of ["кафе|Уютная кофейня у парка", "дом|Её квартира", "отель|Номер с большой кроватью"].entries()) {
    const [name, description] = p.split("|");
    await api("/api/places", "POST", { name, description, position: i + 1 });
  }

  // Слоты одежды: верхнее снимается раньше нижнего; бельё — только дома/в отеле
  const slots = [
    { slot: "top", layer: 1, undressPlaces: [], position: 1, bareEffects: [] },
    { slot: "bottom", layer: 1, undressPlaces: [], position: 2, bareEffects: [] },
    {
      slot: "underwear", layer: 2, undressPlaces: ["дом", "отель"], position: 3,
      // «эффект прогулки без белья»: возбуждение и настроение вверх, тревожность вверх
      bareEffects: [
        { target: "self", key: "arousal", op: "add", value: 1 },
        { target: "self", key: "mood", op: "add", value: 1 },
        { target: "self", key: "anxiety", op: "add", value: 1 },
      ],
    },
  ];
  for (const s of slots) await api("/api/clothing-slots", "POST", s);

  // Одежда (гардероб)
  const garments = [
    { name: "Коктейльное платье", emoji: "👗", description: "Короткое платье на бретельках", slot: "top", price: 60, effects: [{ target: "self", key: "mood", op: "add", value: 1 }] },
    { name: "Джинсы", emoji: "👖", description: "Обтягивающие джинсы", slot: "bottom", price: 40, effects: [] },
    { name: "Кружевное бельё", emoji: "🩲", description: "Набор кружевного белья", slot: "underwear", price: 50, effects: [{ target: "self", key: "arousal", op: "add", value: 1 }] },
    { name: "Рубашка", emoji: "👔", description: "Свежая рубашка", slot: "top", price: 35, effects: [] },
  ];
  for (const g of garments) await api("/api/garments", "POST", g);

  // Тулы. Поцелуй/смена позы/секс — ПРЕДЛОЖЕНИЯ (requiresConsent).
  const tools = [
    {
      name: "compliment", title: "Комплимент", description: "Сказать приятное о внешности или характере партнёра",
      audience: "target", targetParam: "to", observationTemplate: "{name} делает {to} комплимент",
      parametersSchema: { type: "object", properties: { to: { type: "string", description: "Имя" }, text: { type: "string", description: "Что именно сказать" } }, required: ["to", "text"] },
      effects: [{ target: "relation", key: "relation", op: "add", value: 1 }, { target: "tool_target", key: "mood", op: "add", value: 1 }], cost: 0,
    },
    {
      name: "hug", title: "Обнять", description: "Нежно обнять партнёра",
      audience: "target", targetParam: "to", observationTemplate: "{name} обнимает {to}",
      parametersSchema: { type: "object", properties: { to: { type: "string" } }, required: ["to"] },
      effects: [{ target: "tool_target", key: "arousal", op: "add", value: 1 }, { target: "relation", key: "relation", op: "add", value: 1 }], cost: 0,
    },
    {
      name: "kiss", title: "Поцелуй", description: "Поцеловать. ПРЕДЛОЖЕНИЕ: партнёр должен согласиться",
      audience: "target", targetParam: "to", observationTemplate: "{name} целует {to}",
      parametersSchema: { type: "object", properties: { to: { type: "string" } }, required: ["to"] },
      effects: [{ target: "tool_target", key: "arousal", op: "add", value: 1 }, { target: "tool_target", key: "mood", op: "add", value: 1 }, { target: "relation", key: "relation", op: "add", value: 1 }],
      cost: 0, requiresConsent: true,
      declineEffects: [{ target: "relation", key: "relation", op: "add", value: -1 }],
    },
    {
      name: "massage", title: "Массаж", description: "Сделать партнёру расслабляющий массаж",
      audience: "target", targetParam: "to", observationTemplate: "{name} делает {to} массаж",
      parametersSchema: { type: "object", properties: { to: { type: "string" } }, required: ["to"] },
      effects: [{ target: "tool_target", key: "arousal", op: "add", value: 2 }, { target: "tool_target", key: "anxiety", op: "add", value: -1 }],
      cost: 0,
    },
    {
      name: "pose_change", title: "Предложить позу", description: "Предложить новую позу. ПРЕДЛОЖЕНИЕ: партнёр решает",
      audience: "target", targetParam: "to", observationTemplate: "{name} предлагает {to} сменить позу",
      parametersSchema: { type: "object", properties: { to: { type: "string" }, pose: { type: "string", description: "Какая поза" } }, required: ["to", "pose"] },
      effects: [{ target: "tool_target", key: "mood", op: "add", value: 1 }],
      cost: 0, requiresConsent: true,
      // отказ от позы: возбуждение девушки падает
      declineEffects: [{ target: "self", key: "arousal", op: "add", value: -1 }],
    },
    {
      name: "sex", title: "Близость", description: "Интимная близость. ПРЕДЛОЖЕНИЕ: партнёр должен согласиться",
      audience: "target", targetParam: "to", observationTemplate: "{name} и {to} близки",
      parametersSchema: { type: "object", properties: { to: { type: "string" } }, required: ["to"] },
      effects: [{ target: "tool_target", key: "arousal", op: "add", value: 2 }, { target: "relation", key: "relation", op: "add", value: 2 }],
      cost: 0, requiresConsent: true,
      declineEffects: [{ target: "relation", key: "relation", op: "add", value: -2 }],
    },
    {
      name: "go_hotel", title: "Позвать в отель", description: "Предложить продолжить в отеле (меняет место, если согласится)",
      audience: "target", targetParam: "to", observationTemplate: "{name} зовёт {to} в отель",
      parametersSchema: { type: "object", properties: { to: { type: "string" } }, required: ["to"] },
      effects: [], cost: 0, requiresConsent: true, declineEffects: [],
    },
  ];
  const toolIds = [];
  for (const t of tools) toolIds.push((await api("/api/tools", "POST", t)).id);

  // Комбо: поцелуй → массаж → смена позы = «волна» (знает только Яна)
  await api("/api/combos", "POST", {
    name: "wave", title: "Волна", windowTurns: 12,
    description: "Правильная последовательность ласк накрывает её волной — возбуждение резко растёт.",
    steps: [{ toolName: "kiss" }, { toolName: "massage" }, { toolName: "pose_change" }],
    effects: [{ target: "tool_target", key: "arousal", op: "add", value: 3 }],
    knowers: [],
  });

  // Персонажи
  const yana = await api("/api/characters", "POST", {
    name: "Яна", emoji: "👩", providerId: grok.id, model,
    persona:
      "Ты Яна, 26 лет. Умная, ироничная, осторожная в новых знакомствах, но чувственная, когда доверяешь. " +
      "Любишь комплименты и attentive мужчин, не терпишь давления. Твоя цель на свидании — понять, стоит ли Дима большего. " +
      "Ты хорошо знаешь своё тело: понимаешь, какие ласки и в каком порядке тебя заводят (поцелуй → массаж → новая поза).",
    temperature: 0.9, maxTokens: 2048, toolIds,
    state: { mood: 5, arousal: 0, anxiety: 2, trust: 3, money: 100, skill_kiss: 0 },
    boundaries: [
      { toolName: "kiss", minRelation: 3, minAttr: null, requirePlace: null, requireAttr: null, refusalText: "мягко уклоняется: слишком рано для поцелуя", effects: [{ target: "relation", key: "relation", op: "add", value: -1 }] },
      { toolName: "sex", minRelation: 5, minAttr: { key: "arousal", value: 6 }, requirePlace: "отель", requireAttr: null, refusalText: "твёрдо отстраняется: не сейчас и не здесь", effects: [{ target: "relation", key: "relation", op: "add", value: -2 }] },
      { toolName: "*", minRelation: 1, minAttr: null, requirePlace: null, requireAttr: null, refusalText: "отстраняется", effects: [] },
    ],
  });
  const dima = await api("/api/characters", "POST", {
    name: "Дима", emoji: "👨", providerId: grok.id, model,
    persona:
      "Ты Дима, 29 лет. Уверенный, тёплый, с юмором. Хочешь понравиться Яне и провести с ней вечер. " +
      "Действуй: флиртуй, предлагай, слушай её ответы. Не дави — если отказала, меняй подход.",
    temperature: 0.9, maxTokens: 2048, toolIds,
    state: { mood: 6, anxiety: 1, money: 200, skill_kiss: 0 },
    boundaries: [],
  });

  // Комбо-знание: только Яна знает последовательность (PATCH требует полное тело)
  const combos = await api("/api/combos");
  const wave = combos.find((c) => c.name === "wave");
  await api(`/api/combos/${wave.id}`, "PATCH", {
    name: wave.name,
    title: wave.title,
    description: wave.description,
    steps: wave.steps,
    windowTurns: wave.windowTurns,
    effects: wave.effects,
    knowers: [yana.id],
  });

  // Гардероб: одеть Яну
  const w1 = await api(`/api/characters/${yana.id}/wardrobe`, "POST", { garmentId: (await api("/api/garments")).find((g) => g.name === "Коктейльное платье").id, action: "wear" });
  await api(`/api/characters/${yana.id}/wardrobe`, "POST", { garmentId: (await api("/api/garments")).find((g) => g.name === "Джинсы").id, action: "wear" });
  await api(`/api/characters/${yana.id}/wardrobe`, "POST", { garmentId: (await api("/api/garments")).find((g) => g.name === "Кружевное бельё").id, action: "wear" });
  const wFinal = await api(`/api/characters/${yana.id}/wardrobe`);
  console.log(`Яна одета: ${wFinal.slots.map((s) => `${s.slot}=${s.worn}`).join(", ")}`);

  // Сцена: кафе → цель «секс в отеле», завершение по факту + отсрочка 4 хода
  const scene = await api("/api/scenes", "POST", {
    name: "Свидание: Дима и Яна (live-проверка)",
    setting: "Первое свидание после знакомства в приложении. Начинается в кафе, вечер.",
    characterIds: [dima.id, yana.id],
    config: {
      place: "кафе", turnDelayMs: 5000, maxTurns: 40, allowToolRequests: false,
      allowAgentStops: true, rulesExtra: "",
      finish: { conditions: [{ type: "toolCall", toolName: "sex" }], delayTurns: 4 },
    },
    goals: { [dima.id]: "Развлечь Яну, вызвать доверие и желание; близость — только по обоюдному согласию.", [yana.id]: "Понять Диму. Не торопиться: близость — только если захочется самой и в правильном месте." },
  });
  writeFileSync("data/grok-live-scene.json", JSON.stringify({ sceneId: scene.id, dimaId: dima.id, yanaId: yana.id }, null, 2));
  console.log(`Мир создан. Сцена #${scene.id}, Дима #${dima.id}, Яна #${yana.id}. Сохранено в data/grok-live-scene.json`);
}

// ---------- 3. Прогон с транскриптом ----------
async function run() {
  if (!existsSync("data/grok-live-scene.json")) throw new Error("Сначала --seed");
  const { sceneId } = JSON.parse(readFileSync("data/grok-live-scene.json", "utf8"));
  const chars = await api(`/api/scenes/${sceneId}`);
  const nameOf = Object.fromEntries(chars.participants.map((p) => [p.id, p.name]));

  const lines = [];
  const log = (s) => {
    lines.push(s);
    console.log(s);
  };
  log(`=== LIVE-ПРОГОН сцены #${sceneId} (${new Date().toLocaleString()}) ===`);

  await api(`/api/scenes/${sceneId}/control`, "POST", { action: "start" });
  const deadline = Date.now() + minutes * 60_000;
  let after = 0;
  let lastStatus = "";
  const summary = { offers: [], blocks: [], leaves: [], finish: [], combos: [] };
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 4000));
    const events = await api(`/api/scenes/${sceneId}/events?after=${after}`);
    for (const ev of events) {
      const who = ev.actorId != null ? (nameOf[ev.actorId] ?? `#${ev.actorId}`) : "Мир";
      if (ev.type === "speech") log(`${who}: ${ev.payload.text}`);
      else if (ev.type === "action")
        for (const c of ev.payload.calls ?? []) {
          const tag = c.offered ? " [ПРЕДЛОЖЕНИЕ]" : "";
          log(`  ⚙ ${who} → ${c.toolName}${tag} ${c.ok ? "✓" : "✗"} ${String(c.observation || c.result).slice(0, 160)}`);
          if (c.offered && c.ok) summary.offers.push(`${who}: ${c.toolName}`);
          if (!c.ok && c.result) log(`    ↳ результат: ${c.result.slice(0, 220)}`);
        }
      else if (ev.type === "director") log(`🎬 [${who}] ${ev.payload.text ?? ev.payload.message ?? ""}`);
      else if (ev.type === "system") {
        log(`ℹ ${ev.payload.message ?? ""}`);
        const m = ev.payload.message ?? "";
        if (m.includes("Условия завершения")) summary.finish.push(m);
        if (m.includes("завершена")) summary.finish.push(m);
      }
      after = Math.max(after, ev.id);
    }
    const rt = (await api(`/api/scenes/${sceneId}`)).runtime;
    if (rt.status !== lastStatus) {
      log(`-- статус: ${rt.status}, ход ${rt.turn}, API-вызовов ${rt.spentApiCalls}, токенов ${rt.spentTokens}`);
      lastStatus = rt.status;
    }
    if (rt.status === "finished") break;
  }
  const offersRows = await api(`/api/scenes/${sceneId}`).catch(() => null);
  log(`=== ИТОГ: статус ${lastStatus} ===`);
  log(`Предложения отправлены: ${summary.offers.length}; события завершения: ${summary.finish.length}`);
  const transcript = lines.join("\n");
  writeFileSync("data/grok-live-transcript.txt", transcript);
  console.log(`Транскрипт: data/grok-live-transcript.txt (${lines.length} строк)`);
}

try {
  if (flag("--copy-providers")) await copyProviders();
  if (flag("--seed")) await seed();
  if (flag("--run")) await run();
  if (!flag("--copy-providers") && !flag("--seed") && !flag("--run")) {
    console.log("Флаги: --copy-providers | --seed | --run [минуты]");
  }
  process.exit(0);
} catch (e) {
  console.error("ОШИБКА:", e.message);
  process.exit(1);
}
