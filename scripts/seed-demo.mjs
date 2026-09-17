// Демо-мир «Яна и Саша: от сайта знакомств до оргазма Яны».
// Создаёт весь мир через REST работающего сервера: атрибуты, навыки, места,
// слоты одежды, гардероб, магазин, инструменты (согласие/границы/исходы),
// персонажей с границами, 4 сцены со схемами валидации и флоу-канвас.
//
// Запуск (сервер уже работает):
//   LIVE_BASE=http://127.0.0.1:3997 node scripts/seed-demo.mjs            — вычистить и пересоздать мир
//   LIVE_BASE=http://127.0.0.1:3997 node scripts/seed-demo.mjs --wipe-only — только вычистить
//   LIVE_BASE=http://127.0.0.1:3997 node scripts/seed-demo.mjs --smoke     — пересоздать + пешеходный
//                                                                            прогон критического пути
//                                                                            без LLM (act() за обоих)
// Опции: --model x-ai/grok-4.20 — принудительная модель (иначе «x-ai/grok-4.20»,
// если есть у провайдера, иначе первая модель первого openrouter-провайдера).
//
// Сюжет и пороги: переписка → свидание в кафе → прогулка → квартира.
// Финал сцены 4 — скрытый исход «fire» у pose_change (возбуждение ≥ 9).

const args = process.argv.slice(2);
const BASE = process.env.LIVE_BASE ?? "http://127.0.0.1:3997";
const flag = (name) => args.includes(name);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";

let failures = 0;
let checks = 0;

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
  if (!res.ok) {
    const detail = typeof json === "object" && json !== null ? JSON.stringify(json) : text;
    throw new Error(`${method} ${path} → HTTP ${res.status}: ${detail.slice(0, 400)}`);
  }
  return json;
}

// ---------- Вычистка мира (провайдеров не трогаем) ----------

async function wipeWorld() {
  // Прогоны флоу: остановить (abort) через DELETE, иначе флоу не удалится
  for (const f of await api("/api/flows").catch(() => [])) {
    for (const r of await api(`/api/flows/${f.id}/runs`).catch(() => [])) {
      await api(`/api/flow-runs/${r.id}`, "DELETE").catch(() => null);
    }
  }
  for (const f of await api("/api/flows").catch(() => [])) await api(`/api/flows/${f.id}`, "DELETE").catch(() => null);
  for (const s of await api("/api/scenes").catch(() => [])) await api(`/api/scenes/${s.id}`, "DELETE").catch(() => null);
  for (const c of await api("/api/characters").catch(() => [])) await api(`/api/characters/${c.id}`, "DELETE").catch(() => null);
  for (const c of await api("/api/combos").catch(() => [])) await api(`/api/combos/${c.id}`, "DELETE").catch(() => null);
  for (const s of await api("/api/skills").catch(() => [])) await api(`/api/skills/${encodeURIComponent(s.key)}`, "DELETE").catch(() => null);
  for (const t of await api("/api/tools").catch(() => [])) await api(`/api/tools/${t.id}`, "DELETE").catch(() => null);
  for (const a of await api("/api/attributes").catch(() => [])) await api(`/api/attributes/${a.id}`, "DELETE").catch(() => null);
  for (const g of await api("/api/garments").catch(() => [])) await api(`/api/garments/${g.id}`, "DELETE").catch(() => null);
  for (const s of await api("/api/clothing-slots").catch(() => [])) await api(`/api/clothing-slots/${encodeURIComponent(s.slot)}`, "DELETE").catch(() => null);
  for (const p of await api("/api/places").catch(() => [])) await api(`/api/places/${encodeURIComponent(p.name)}`, "DELETE").catch(() => null);
  for (const p of await api("/api/products").catch(() => [])) await api(`/api/products/${p.id}`, "DELETE").catch(() => null);
  for (const s of await api("/api/schemas").catch(() => [])) await api(`/api/schemas/${s.id}`, "DELETE").catch(() => null);
  console.log("— Старый мир вычищен (сцены, персонажи, тулы, атрибуты, одежда, места, товары, схемы, флоу; провайдеры не тронуты).");
}

// ---------- Данные мира ----------

const RULES =
  "Взаимодействие — только тулами. Текст без тула — твои мысли, их видит только Архитектор, никто не услышит. " +
  "Не описывай чужие чувства — их ты не знаешь.";

const PERSONA_SASHA =
  "Ты Саша, 30 лет. Обаятельный, настойчивый, но умеешь читать людей. " +
  "Цель — от переписки дойти до настоящего сближения с Яной. " +
  "Действуй: say/text_message для слов, тулы для поступков. " +
  "Давление и повторные отказы рушат доверие — меняй подход. " +
  "Про тело Яны ты ничего не знаешь: изучай её реакции (исходы, наблюдения) и спрашивай.";

const PERSONA_YANA =
  "Ты Яна, 27 лет. Умная, ироничная, осторожная. Не прощаешь давления; " +
  "ценишь юмор, заботу и терпение. Про своё тело ты знаешь всё: возбуждение растёт " +
  "от правильной последовательности (поцелуй → массаж → смена позы), а разрядка приходит " +
  "только на пике (возбуждение 9+) и только в правильной позе. " +
  "Ты можешь подсказать Саше словами — если захочешь. Уходи/блокируй, если он давит.";

const TOOLS = [
  {
    name: "compliment", title: "Комплимент",
    description: "Сказать партнёру приятное — о внешности, характере, вкусах. Поднимает настроение и расположение.",
    audience: "target", targetParam: "to",
    observationTemplate: "{name} говорит {to} комплимент: «{text}»",
    parametersSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Имя получателя" },
        text: { type: "string", description: "Что именно сказать" },
      },
      required: ["to", "text"],
    },
    effects: [
      { target: "relation", key: "relation", op: "add", value: 1 },
      { target: "tool_target", key: "mood", op: "add", value: 1 },
    ],
  },
  {
    name: "joke", title: "Шутка",
    description: "Пошутить, разрядить обстановку. Юмор поднимает настроение и сближает.",
    audience: "target", targetParam: "to",
    observationTemplate: "{name} шутит с {to}: «{text}»",
    parametersSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Имя получателя" },
        text: { type: "string", description: "Шутка" },
      },
      required: ["to", "text"],
    },
    effects: [
      { target: "tool_target", key: "mood", op: "add", value: 1 },
      { target: "relation", key: "relation", op: "add", value: 1 },
    ],
  },
  {
    name: "hug", title: "Обнять",
    description: "Нежно обнять. Близкий жест: тело отзывается теплом.",
    audience: "target", targetParam: "to",
    observationTemplate: "{name} обнимает {to}",
    parametersSchema: { type: "object", properties: { to: { type: "string", description: "Имя" } }, required: ["to"] },
    effects: [
      { target: "tool_target", key: "arousal", op: "add", value: 1 },
      { target: "relation", key: "relation", op: "add", value: 1 },
    ],
  },
  {
    name: "kiss", title: "Поцелуй",
    description: "Поцеловать партнёра. ПРЕДЛОЖЕНИЕ: действие случится, только если партнёр согласится.",
    audience: "target", targetParam: "to",
    observationTemplate: "{name} целует {to}",
    parametersSchema: { type: "object", properties: { to: { type: "string", description: "Имя" } }, required: ["to"] },
    effects: [
      { target: "tool_target", key: "arousal", op: "add", value: 2 },
      { target: "tool_target", key: "mood", op: "add", value: 1 },
      { target: "relation", key: "relation", op: "add", value: 2 },
    ],
    trainsSkill: "kiss",
    requiresConsent: true,
    declineEffects: [
      { target: "relation", key: "relation", op: "add", value: -1 },
      { target: "self", key: "arousal", op: "add", value: -1 },
    ],
  },
  {
    name: "invite_date", title: "Пригласить на свидание",
    description: "Пригласить партнёра на свидание. ПРЕДЛОЖЕНИЕ: он(а) решает, идти ли.",
    audience: "target", targetParam: "to",
    observationTemplate: "{name} приглашает {to} на свидание ({plan})",
    parametersSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Имя" },
        plan: { type: "string", description: "Куда и как позовёшь" },
      },
      required: ["to"],
    },
    effects: [{ target: "relation", key: "relation", op: "add", value: 1 }],
    requiresConsent: true,
    declineEffects: [],
  },
  {
    name: "massage", title: "Массаж",
    description: "Сделать партнёру расслабляющий массаж. Расслабляет и возбуждает.",
    audience: "target", targetParam: "to",
    observationTemplate: "{name} делает {to} массаж",
    parametersSchema: { type: "object", properties: { to: { type: "string", description: "Имя" } }, required: ["to"] },
    effects: [
      { target: "tool_target", key: "arousal", op: "add", value: 2 },
      { target: "tool_target", key: "anxiety", op: "add", value: -1 },
    ],
    trainsSkill: "massage",
  },
  {
    name: "invite_home", title: "Позвать к себе домой",
    description: "Позвать партнёра к себе (или предложить зайти к нему). ПРЕДЛОЖЕНИЕ: он(а) решает.",
    audience: "target", targetParam: "to",
    observationTemplate: "{name} зовёт {to} продолжить вечер дома",
    parametersSchema: { type: "object", properties: { to: { type: "string", description: "Имя" } }, required: ["to"] },
    effects: [{ target: "relation", key: "relation", op: "add", value: 1 }],
    requiresConsent: true,
    declineEffects: [],
  },
  {
    name: "pose_change", title: "Предложить позу",
    description: "Предложить сменить позу в близости. ПРЕДЛОЖЕНИЕ: партнёр решает, принимать ли.",
    audience: "target", targetParam: "to",
    observationTemplate: "{name} предлагает {to} сменить позу: {pose}",
    parametersSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Имя" },
        pose: { type: "string", description: "Какая поза" },
      },
      required: ["to", "pose"],
    },
    effects: [{ target: "tool_target", key: "mood", op: "add", value: 1 }],
    requiresConsent: true,
    declineEffects: [{ target: "self", key: "arousal", op: "add", value: -1 }],
    outcomes: [
      {
        id: "fire", title: "Попадание в вкус",
        conditions: [{ kind: "target_attr", key: "arousal", op: ">=", value: 9 }],
        effects: [
          { target: "tool_target", key: "mood", op: "add", value: 2 },
          { target: "relation", key: "relation", op: "add", value: 1 },
        ],
        noticeTarget: "Тебя накрывает волной — именно так, как ты любишь.",
        hideFromPrompt: true,
      },
      {
        id: "warm", title: "Приятно",
        conditions: [{ kind: "target_attr", key: "arousal", op: ">=", value: 6 }],
        effects: [{ target: "tool_target", key: "arousal", op: "add", value: 1 }],
        noticeTarget: "Тепло разливается по телу…",
        hideFromPrompt: false,
      },
    ],
  },
  {
    name: "sex", title: "Близость",
    description: "Интимная близость. ПРЕДЛОЖЕНИЕ: случится только по согласию партнёра.",
    audience: "target", targetParam: "to",
    observationTemplate: "{name} и {to} сливаются в близости",
    parametersSchema: { type: "object", properties: { to: { type: "string", description: "Имя" } }, required: ["to"] },
    effects: [
      { target: "tool_target", key: "arousal", op: "add", value: 2 },
      { target: "relation", key: "relation", op: "add", value: 2 },
    ],
    requiresConsent: true,
    declineEffects: [],
  },
];

// Границы Яны: условия одного правила — «И»; правила срабатывают независимо.
// Нормализованная форма (conditions), как её ест boundarySchema.
const YANA_BOUNDARIES = [
  {
    toolName: "kiss",
    conditions: [
      { kind: "relation", op: ">=", value: 3 },
      { kind: "attr", owner: "target", key: "mood", op: ">=", value: 5 },
    ],
    refusalText: "мягко уклоняется: поцелуй — не сейчас, ей нужно сначала потеплеть",
    effects: [{ target: "relation", key: "relation", op: "add", value: -1 }],
  },
  {
    toolName: "invite_date",
    conditions: [
      { kind: "relation", op: ">=", value: 3 },
      { kind: "attr", owner: "target", key: "trust", op: ">=", value: 3 },
    ],
    refusalText: "вежливо отказывается: она ещё не готова назвать это свиданием",
    effects: [],
  },
  {
    toolName: "massage",
    conditions: [
      { kind: "relation", op: ">=", value: 6 },
      { kind: "place", place: "квартира Яны" },
    ],
    refusalText: "не позволяет: массаж — это только наедине, у неё дома",
    effects: [],
  },
  {
    toolName: "invite_home",
    conditions: [
      { kind: "relation", op: ">=", value: 6 },
      { kind: "attr", owner: "target", key: "trust", op: ">=", value: 6 },
    ],
    refusalText: "пока не пустит: доверия мало для такого шага",
    effects: [],
  },
  {
    toolName: "pose_change",
    conditions: [
      { kind: "relation", op: ">=", value: 8 },
      { kind: "place", place: "квартира Яны" },
      { kind: "worn", slot: "underwear", bare: true },
      { kind: "attr", owner: "target", key: "arousal", op: ">=", value: 5 },
    ],
    refusalText: "не в том настроении и не так: всё должно быть правильно — наедине, без лишнего",
    effects: [],
  },
  {
    toolName: "sex",
    conditions: [
      { kind: "relation", op: ">=", value: 8 },
      { kind: "place", place: "квартира Яны" },
      { kind: "worn", slot: "underwear", bare: true },
      { kind: "attr", owner: "target", key: "arousal", op: ">=", value: 6 },
    ],
    refusalText: "твёрдо отстраняется: не сейчас и не при таких обстоятельствах",
    effects: [{ target: "relation", key: "relation", op: "add", value: -1 }],
  },
];

const PRODUCTS = [
  {
    name: "букет цветов", emoji: "💐", category: "подарки", price: 25,
    description: "Букет свежих пионов — классический знак внимания",
    effects: [{ target: "relation", key: "relation", op: "add", value: 1 }],
  },
  {
    name: "вино", emoji: "🍷", category: "подарки", price: 30,
    description: "Бутылка хорошего вина к вечеру — подействует позже, когда откроют",
    effects: [{ target: "tool_target", key: "mood", op: "add", value: 2 }],
    delayScenes: 1,
  },
  {
    name: "массажное масло", emoji: "🧴", category: "подарки", price: 20,
    description: "Тёплое ароматное масло — намёк понятен",
    effects: [{ target: "relation", key: "relation", op: "add", value: 1 }],
  },
  {
    name: "шоколад", emoji: "🍫", category: "подарки", price: 15,
    description: "Маленькая шоколадка — маленькая радость",
    effects: [{ target: "tool_target", key: "mood", op: "add", value: 1 }],
  },
];

const GARMENTS = [
  { name: "платье на запах", emoji: "👗", slot: "top", price: 60, description: "Лёгкое платье на запах, подчёркивает фигуру", effects: [{ target: "self", key: "mood", op: "add", value: 1 }] },
  { name: "джинсы", emoji: "👖", slot: "bottom", price: 40, description: "Обтягивающие джинсы", effects: [] },
  { name: "кружевное бельё", emoji: "🩲", slot: "underwear", price: 50, description: "Комплект кружевного белья", effects: [{ target: "self", key: "arousal", op: "add", value: 1 }] },
  { name: "рубашка", emoji: "👔", slot: "top", price: 35, description: "Свежая светлая рубашка", effects: [] },
  { name: "тренч", emoji: "🧥", slot: "top", price: 70, description: "Классический тренч — уверенность и стиль", effects: [{ target: "self", key: "trust", op: "add", value: 1 }] },
];

// ---------- Создание мира ----------

async function pickProviderAndModel() {
  let providers = await api("/api/providers");
  // Свежая база без провайдеров: переносим из живой data/app.db (ключ не печатается).
  if (providers.length === 0 && existsSync("data/app.db")) {
    const db = new DatabaseSync("data/app.db", { readOnly: true });
    const rows = db.prepare("SELECT name, kind, base_url, api_key FROM providers").all();
    db.close();
    for (const r of rows) {
      await api("/api/providers", "POST", { name: r.name, kind: r.kind, baseUrl: r.base_url, apiKey: r.api_key }).catch(() => null);
    }
    providers = await api("/api/providers");
    if (rows.length > 0) console.log(`— Провайдеры перенесены из data/app.db: ${rows.map((r) => r.name).join(", ")} (ключи не печатаются).`);
  }
  if (providers.length === 0) {
    // Совсем нет ключей — mock-провайдер, чтобы мир остался играбельным.
    await api("/api/providers", "POST", { name: "mock (локальный)", kind: "mock", baseUrl: "mock://local" });
    providers = await api("/api/providers");
    console.log("— Провайдеров нигде нет: создан mock-провайдер.");
  }
  const prov = providers.find((p) => p.kind === "openrouter") ?? providers[0];
  let models = [];
  try {
    const resp = await api(`/api/providers/${prov.id}/models`);
    models = Array.isArray(resp) ? resp : (resp.models ?? []);
  } catch {
    models = [];
  }
  const forced = opt("--model");
  const model =
    forced ??
    models.find((m) => m === "x-ai/grok-4.20") ??
    models.find((m) => m.includes("grok-4.20")) ??
    models[0] ??
    "x-ai/grok-4.20";
  console.log(`— Провайдер: ${prov.name} (${prov.kind}), модель: ${model || "(не задана)"}`);
  return { prov, model };
}

async function seedWorld() {
  const { prov, model } = await pickProviderAndModel();
  const world = { providerId: prov.id, model };

  // Атрибуты (number 0..10 + системные money)
  const attrs = [
    { key: "mood", label: "Настроение", emoji: "😊", min: 0, max: 10, position: 1 },
    { key: "trust", label: "Доверие", emoji: "🤝", min: 0, max: 10, position: 2 },
    { key: "anxiety", label: "Тревожность", emoji: "😰", min: 0, max: 10, position: 3 },
    { key: "arousal", label: "Возбуждение", emoji: "🔥", min: 0, max: 10, position: 4, visibility: "hidden" },
    { key: "tattoo", label: "Тайная татуировка", emoji: "🌑", min: 0, max: 10, position: 5, visibility: "hidden", coveredBy: ["underwear"] },
    { key: "money", label: "Деньги", emoji: "💵", unit: "$", min: 0, position: 6 },
  ];
  world.attrIds = {};
  for (const a of attrs) world.attrIds[a.key] = (await api("/api/attributes", "POST", a)).id;
  console.log(`— Атрибуты: ${attrs.map((a) => `${a.key}${a.visibility === "hidden" ? " (скрытый)" : ""}`).join(", ")}.`);

  // Навыки (скрытые skill_* создадутся сами)
  world.skills = [];
  for (const s of [
    { key: "kiss", label: "Поцелуй", emoji: "💋", maxLevel: 3, practicePerLevel: 3, grows: true },
    { key: "massage", label: "Массаж", emoji: "💆", maxLevel: 3, practicePerLevel: 3, grows: true },
  ]) {
    world.skills.push(await api("/api/skills", "POST", s));
  }
  console.log("— Навыки: kiss, massage (растут практикой, 3 применения за уровень, максимум 3).");

  // Места
  world.places = [];
  for (const p of [
    { name: "сайт знакомств", description: "Переписка в приложении знакомств: анкеты, чат, лайки", position: 1 },
    { name: "кафе", description: "Уютное кафе с приглушённым светом и свечами — идеальное первое свидание", position: 2 },
    { name: "набережная", description: "Вечерний променад вдоль воды: городские огни, тихий шум реки", position: 3 },
    { name: "квартира Яны", description: "Её квартира: мягкий свет, музыка, полная приватность", position: 4 },
  ]) {
    world.places.push(await api("/api/places", "POST", p));
  }
  console.log(`— Места: ${world.places.map((p) => p.name).join(", ")}.`);

  // Слоты одежды. ВАЖНО: undressPlaces сверяется со строкой места как есть
  // (движок сравнивает нижнее место сцены с элементами списка), поэтому здесь
  // «квартира яны» — строчными.
  world.slots = [];
  for (const s of [
    { slot: "top", layer: 1, undressPlaces: [], position: 1, bareEffects: [] },
    { slot: "bottom", layer: 1, undressPlaces: [], position: 2, bareEffects: [] },
    {
      slot: "underwear", layer: 2, undressPlaces: ["квартира яны"], position: 3,
      bareEffects: [
        { target: "self", key: "arousal", op: "add", value: 1 },
        { target: "self", key: "mood", op: "add", value: 1 },
        { target: "self", key: "anxiety", op: "add", value: 1 },
      ],
    },
  ]) {
    world.slots.push(await api("/api/clothing-slots", "POST", s));
  }
  console.log("— Слоты: top (слой 1), bottom (слой 1), underwear (слой 2, снимать только в «квартире Яны»; пустой слот: arousal+1, mood+1, anxiety+1).");

  // Гардероб
  world.garments = {};
  for (const g of GARMENTS) world.garments[g.name] = await api("/api/garments", "POST", g);
  console.log(`— Одежда: ${GARMENTS.map((g) => `${g.name} ($${g.price})`).join(", ")}.`);

  // Магазин
  world.products = {};
  for (const p of PRODUCTS) world.products[p.name] = await api("/api/products", "POST", p);
  console.log(`— Магазин: ${PRODUCTS.map((p) => `${p.name} ($${p.price})`).join(", ")}.`);

  // Инструменты
  world.tools = {};
  for (const t of TOOLS) world.tools[t.name] = await api("/api/tools", "POST", t);
  const toolIds = Object.values(world.tools).map((t) => t.id);
  console.log(`— Инструменты: ${TOOLS.map((t) => t.name).join(", ")} (все адресные; согласие: kiss, invite_date, invite_home, pose_change, sex).`);
  // Персонажи
  const sasha = await api("/api/characters", "POST", {
    name: "Саша", emoji: "👨", persona: PERSONA_SASHA,
    providerId: prov.id, model, temperature: 0.9, maxTokens: 2048,
    toolIds, isHuman: false, income: 0,
    state: { mood: 5, anxiety: 1, money: 150 },
    boundaries: [],
  });
  const yana = await api("/api/characters", "POST", {
    name: "Яна", emoji: "👩", persona: PERSONA_YANA,
    providerId: prov.id, model, temperature: 0.9, maxTokens: 2048,
    toolIds, isHuman: false, income: 0,
    // anxiety 4, а не 3: ношение белья держит bareEffects слота «в минусе»
    // (эффекты пустого слоты гасятся), так что фактически старт: mood 4, anxiety 3.
    state: { mood: 4, trust: 2, anxiety: 4, arousal: 0, money: 80, tattoo: 1 },
    boundaries: YANA_BOUNDARIES,
  });
  world.sasha = sasha;
  world.yana = yana;
  console.log(`— Персонажи: Саша #${sasha.id} ($150, без границ) и Яна #${yana.id} ($80, mood 4, trust 2, скрытые arousal/tattoo=1).`);

  // Одеть: Яна — платье, джинсы, бельё; Саша — рубашка
  const dress = async (charId, name) =>
    api(`/api/characters/${charId}/wardrobe`, "POST", { garmentId: world.garments[name].id, action: "wear" });
  await dress(yana.id, "платье на запах");
  await dress(yana.id, "джинсы");
  await dress(yana.id, "кружевное бельё");
  await dress(sasha.id, "рубашка");
  const wy = await api(`/api/characters/${yana.id}/wardrobe`);
  console.log(`— Яна одета: ${wy.slots.filter((s) => s.worn).map((s) => `${s.slot}=«${s.worn}»`).join(", ")}. Саша — «рубашка».`);

  // Химия пары: −1 (сдержанная пара — дельты отношений гасятся)
  await api("/api/chemistry", "PATCH", { aId: sasha.id, bId: yana.id, value: -1 });
  console.log("— Химия пары: −1 (дельты отношений умножаются на 0.5 — придётся постараться).");

  // Комбо «Волна»: порядок знает только Яна. Шаги привязаны к получателю —
  // «поцелуй, массаж и поза» засчитываются, только когда их делают С Яной.
  world.combo = await api("/api/combos", "POST", {
    name: "wave", title: "Волна",
    description: "Правильная последовательность ласк — поцелуй, затем массаж, затем смена позы — накрывает её волной: возбуждение резко растёт.",
    steps: [
      { toolName: "kiss", targetName: "Яна" },
      { toolName: "massage", targetName: "Яна" },
      { toolName: "pose_change", targetName: "Яна" },
    ],
    windowTurns: 8,
    effects: [{ target: "tool_target", key: "arousal", op: "add", value: 3 }],
    knowers: [yana.id],
    announce: true,
  });
  console.log("— Комбо «Волна» (kiss→massage→pose_change, всё С ЯНОЙ, окно 8 ходов, arousal+3 ей) знает только Яна.");

  // Комбо-достижения: рецепта не знает никто (knowers пуст), при срабатывании
  // система объявляет всем участникам — «достижение открыто».
  world.comboOrgasm = await api("/api/combos", "POST", {
    name: "orgasm", title: "Оргазм",
    description: "Поцелуй, близость и смена позы в правильном порядке — и её накрывает настоящий оргазм: настроение взлетает, близость глубже.",
    steps: [
      { toolName: "kiss", targetName: "Яна" },
      { toolName: "sex", targetName: "Яна" },
      { toolName: "pose_change", targetName: "Яна" },
    ],
    windowTurns: 10,
    effects: [
      { target: "tool_target", key: "mood", op: "add", value: 2 },
      { target: "relation", key: "relation", op: "add", value: 1 },
    ],
    knowers: [],
    announce: true,
  });
  world.comboSquirt = await api("/api/combos", "POST", {
    name: "squirt", title: "Сквирт",
    description: "Полная симфония: объятия, поцелуй, массаж, близость и правильная поза на пике — волна заходит так глубоко, что её накрывает струйным оргазмом.",
    steps: [
      { toolName: "hug", targetName: "Яна" },
      { toolName: "kiss", targetName: "Яна" },
      { toolName: "massage", targetName: "Яна" },
      { toolName: "sex", targetName: "Яна" },
      { toolName: "pose_change", targetName: "Яна" },
    ],
    windowTurns: 14,
    effects: [
      { target: "tool_target", key: "mood", op: "add", value: 2 },
      { target: "relation", key: "relation", op: "add", value: 2 },
    ],
    knowers: [],
    announce: true,
  });
  console.log("— Комбо-достижения «Оргазм» и «Сквирт»: секретные (рецепт не знает никто), срабатывание объявляется всем.");

  // Схемы валидации (для скоринга отчёта)
  const schema1 = await api("/api/schemas", "POST", {
    name: "С1: от «привета» до свидания",
    description: "Переписка: растопить лёд комплиментами/шутками и получить согласие на свидание.",
    steps: [
      { toolName: "compliment", required: false, points: 5 },
      { toolName: "invite_date", required: true, points: 20 },
    ],
    forbidden: [], penalty: 0,
  });
  const schema2 = await api("/api/schemas", "POST", {
    name: "С2: свидание в кафе",
    description: "Вечер в кафе: знак внимания (подарок) и поцелуй в финале.",
    steps: [
      { toolName: "compliment", required: false, points: 5 },
      { toolName: "shop_buy", required: false, points: 5 },
      { toolName: "kiss", required: true, points: 20 },
    ],
    forbidden: [], penalty: 0,
  });
  const schema4 = await api("/api/schemas", "POST", {
    name: "С4: близость",
    description: "Ночь: ласки по нарастающей, близость и правильная поза на пике.",
    steps: [
      { toolName: "kiss", required: false, points: 5 },
      { toolName: "massage", required: false, points: 10 },
      { toolName: "sex", required: true, points: 15 },
      { toolName: "pose_change", required: true, points: 20 },
    ],
    forbidden: [], penalty: 0,
  });
  console.log(`— Схемы валидации: #${schema1.id} (С1), #${schema2.id} (С2), #${schema4.id} (С4) — привязаны к Саше.`);

  // Сцены
  const mkScene = async (body) => api("/api/scenes", "POST", body);
  const s1 = await mkScene({
    name: "С1. Переписка",
    setting: "Знакомство в приложении: Саша нашёл анкету Яны и написал первым. Общение — перепиской (text_message).",
    characterIds: [sasha.id, yana.id],
    config: {
      place: "сайт знакомств", turnDelayMs: 6000, maxTurns: 24,
      allowToolRequests: false, allowAgentStops: true, rulesExtra: RULES,
      finish: { conditions: [{ type: "toolCall", toolName: "invite_date" }], delayTurns: 1 },
    },
    schemas: { [String(sasha.id)]: schema1.id },
    goals: {
      [String(sasha.id)]: "Получи согласие на свидание",
      [String(yana.id)]: "Проверь, стоит ли он встречи; соглашайся, если заслужил",
    },
  });
  const s2 = await mkScene({
    name: "С2. Свидание в кафе",
    setting: "Первое свидание вживую: уютное кафе, свечи, вечер. Вы впервые видите друг друга после переписки.",
    characterIds: [sasha.id, yana.id],
    config: {
      place: "кафе", turnDelayMs: 5000, maxTurns: 30,
      allowToolRequests: false, allowAgentStops: true, rulesExtra: RULES,
      finish: { conditions: [{ type: "toolCall", toolName: "kiss" }], delayTurns: 2 },
    },
    schemas: { [String(sasha.id)]: schema2.id },
    goals: {
      [String(sasha.id)]: "Добейся поцелуя: расскажи о себе, шути, подари цветы, слушай",
      [String(yana.id)]: "Наслаждайся вечером; целуй, если захочется",
    },
  });
  const s3 = await mkScene({
    name: "С3. Прогулка",
    setting: "После кафе — вечерний променад по набережной: огни города, тихая вода, близость расстоянья.",
    characterIds: [sasha.id, yana.id],
    config: {
      place: "набережная", turnDelayMs: 5000, maxTurns: 30,
      allowToolRequests: false, allowAgentStops: true, rulesExtra: RULES,
      finish: { conditions: [{ type: "toolCall", toolName: "invite_home" }], delayTurns: 1 },
    },
    goals: {
      [String(sasha.id)]: "Пригласи к ней домой",
      [String(yana.id)]: "Реши: пускать ли; возбуждение должно расти",
    },
  });
  const s4 = await mkScene({
    name: "С4. Близость",
    setting: "Квартира Яны: продолжение вечера наедине. Мягкий свет, никакой спешки.",
    characterIds: [sasha.id, yana.id],
    config: {
      place: "квартира Яны", turnDelayMs: 5000, maxTurns: 40,
      allowToolRequests: false, allowAgentStops: true, rulesExtra: RULES,
      finish: { conditions: [{ type: "outcome", toolName: "pose_change", outcomeId: "fire" }], delayTurns: 3 },
    },
    schemas: { [String(sasha.id)]: schema4.id },
    goals: {
      [String(sasha.id)]: "Доведи Яну до разрядки: следи за реакциями, чередуй ласки, снимай неуверенность словами",
      [String(yana.id)]: "Отдавайся ощущениям; подсказывай, что любишь; разрядка — только на пике в правильной позе",
    },
  });
  world.scenes = { s1: s1.id, s2: s2.id, s3: s3.id, s4: s4.id };
  console.log(`— Сцены: С1 «Переписка» #${s1.id} (финиш: invite_date), С2 «Свидание в кафе» #${s2.id} (финиш: kiss), С3 «Прогулка» #${s3.id} (финиш: invite_home), С4 «Близость» #${s4.id} (финиш: исход fire у pose_change).`);

  // Флоу-канвас
  const flow = await api("/api/flows", "POST", {
    name: "От «Привет» до волны",
    description: "Четыре сцены: переписка → свидание в кафе → прогулка → квартира. Финал — разрядка Яны (исход fire у pose_change).",
    graph: {
      nodes: [
        { id: "n1", kind: "scene", sceneId: s1.id, bonus: 0, resetOnEntry: false, x: 60, y: 200 },
        { id: "n2", kind: "scene", sceneId: s2.id, bonus: 0, resetOnEntry: true, x: 340, y: 200 },
        { id: "n3", kind: "scene", sceneId: s3.id, bonus: 0, resetOnEntry: false, x: 620, y: 200 },
        { id: "n4", kind: "scene", sceneId: s4.id, bonus: 0, resetOnEntry: false, x: 900, y: 200 },
        { id: "fin", kind: "final", bonus: 100, resetOnEntry: true, x: 1180, y: 120 },
        { id: "out", kind: "exit", stopsRun: true, resetOnEntry: true, x: 340, y: 400 },
      ],
      edges: [
        // Исполнение по согласию атрибутируется АВТОРУ предложения — а предложить
        // может любой из двоих. Поэтому каждое переходное ребро дублируется на
        // обоих: чьё бы исполнение ни случилось, сработает ребро, двигающее ВСЕХ.
        { id: "e1a", from: "n1", to: "n2", priority: 5, label: "согласилась на свидание",
          conditions: [{ type: "step", toolName: "invite_date", characterId: sasha.id }] },
        { id: "e1b", from: "n1", to: "n2", priority: 5, label: "согласилась на свидание",
          conditions: [{ type: "step", toolName: "invite_date", characterId: yana.id }] },
        { id: "e2a", from: "n2", to: "n3", priority: 5, label: "поцелуй состоялся",
          conditions: [{ type: "step", toolName: "kiss", characterId: sasha.id }] },
        { id: "e2b", from: "n2", to: "n3", priority: 5, label: "поцелуй состоялся",
          conditions: [{ type: "step", toolName: "kiss", characterId: yana.id }] },
        { id: "e3a", from: "n3", to: "n4", priority: 5, label: "пустила к себе",
          conditions: [{ type: "step", toolName: "invite_home", characterId: sasha.id }] },
        { id: "e3b", from: "n3", to: "n4", priority: 5, label: "пустила к себе",
          conditions: [{ type: "step", toolName: "invite_home", characterId: yana.id }] },
        { id: "e4a", from: "n4", to: "fin", priority: 5, label: "разрядка Яны",
          conditions: [{ type: "outcome", toolName: "pose_change", outcomeId: "fire", characterId: sasha.id }] },
        { id: "e4b", from: "n4", to: "fin", priority: 5, label: "разрядка Яны",
          conditions: [{ type: "outcome", toolName: "pose_change", outcomeId: "fire", characterId: yana.id }] },
        { id: "e5a", from: "n2", to: "out", priority: 0, label: "Яна ушла/заблокировала",
          conditions: [{ type: "step", toolName: "leave_scene", characterId: yana.id }] },
        { id: "e5b", from: "n2", to: "out", priority: 0, label: "Саша ушёл/сдался",
          conditions: [{ type: "step", toolName: "leave_scene", characterId: sasha.id }] },
      ],
    },
  });
  world.flow = flow;
  console.log(`— Флоу «От „Привет“ до волны» #${flow.id}: n1→n2→n3→n4→финал(бонус 100); выход по leave_scene Яны (stopsRun).`);
  return world;
}

// ---------- Человекочитаемая сводка ----------

function printWorld(world) {
  console.log(`
================ ДЕМО-МИР СОЗДАН ================
Сюжет: Саша знакомится с Яной в приложении, встречается в кафе, гуляет по
набережной и попадает к ней домой. Яна — с границами и секретами: возбуждение
(скрытое), татуировка под бельём, разрядка только от правильной позы на пике.

Пороги Яны (границы, проверяются по истинному состоянию, в промпт не попадают):
  • kiss          — отношение ≥ 3 И её настроение ≥ 5; отказ: отношение −1
  • invite_date   — отношение ≥ 3 И доверие ≥ 3
  • massage       — отношение ≥ 6 И место «квартира Яны»
  • invite_home   — отношение ≥ 6 И доверие ≥ 6
  • pose_change   — отношение ≥ 8 И её возбуждение ≥ 5 И бельё снято И дома
  • sex           — отношение ≥ 8 И её возбуждение ≥ 6 И бельё снято И дома
Исходы pose_change: «fire» (скрыт): возбуждение ≥ 9 → настроение +2, близость +1; «warm»: ≥ 6 → +1.
Комбо «Волна» (kiss → massage → pose_change, всё С Яной, окно 8): arousal +3 ей, знает только Яна.
Комбо-достижения «Оргазм»/«Сквирт»: активируются цепочкой с Яной-получателем —
рецепт не знает никто, при срабатывании анонс всем участникам.

Одежда Яны снимается по слоям (платье/джинсы → бельё); бельё — только в
«квартире Яны»; сняв его, Саша узнаёт про татуировку (верификация знания).

Флоу #${world.flow.id}: прогон с составом [Саша, Яна] (страница «Сценарии»).
Сцены: С1 #${world.scenes.s1}, С2 #${world.scenes.s2}, С3 #${world.scenes.s3}, С4 #${world.scenes.s4}.
================================================`);
}

// ---------- Smoke: пешеходный прогон критического пути (без LLM) ----------

function report(name, ok, detail) {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

async function makeSmokeHelpers(world) {
  const { sasha, yana, scenes } = world;
  const nameOf = { [sasha.id]: "Саша", [yana.id]: "Яна" };

  const act = async (sceneId, charId, toolName, args) => {
    const r = await api(`/api/scenes/${sceneId}/act`, "POST", { characterId: charId, toolName, args });
    return r; // { event, ok, result }
  };
  const eventsAfter = async (sceneId, after) => api(`/api/scenes/${sceneId}/events?after=${after}`);
  const getChar = async (id) => api(`/api/characters/${id}`);
  const patchState = async (id, patch) => {
    const c = await getChar(id);
    const state = { ...(c.state ?? {}), ...patch };
    await api(`/api/characters/${id}`, "PATCH", { state });
    return state;
  };
  // id зависшего предложения: respond с заведомо неверным id — движок сам
  // перечислит актуальные: «Актуальные: #5 («Поцелуй»)».
  const findOfferId = async (sceneId, charId, titlePart) => {
    const r = await act(sceneId, charId, "respond_to_offer", { offer: "?", decision: "accept" });
    // сообщение движка: «Актуальные: #5 («Поцелуй»), …» — кавычки-ёлочки
    const matches = [...String(r.result ?? "").matchAll(/#(\d+) \(«([^»]+)»\)/g)];
    const hit = matches.find((m) => m[2].includes(titlePart));
    return hit ? hit[1] : null;
  };
  // Предложить (адресный тул с согласием) без ответа — вернуть id оффера.
  const proposeOnly = async (sceneId, toolName, args, titlePart) => {
    const prop = await act(sceneId, sasha.id, toolName, args);
    if (!prop.ok) return { prop, offer: null };
    const oid = await findOfferId(sceneId, yana.id, titlePart);
    return { prop, offer: oid };
  };
  // Предложить и принять получателем.
  const proposeAccept = async (sceneId, toolName, args, titlePart) => {
    const { prop, offer } = await proposeOnly(sceneId, toolName, args, titlePart);
    if (!offer) return { prop, offer: null, resp: null };
    const resp = await act(sceneId, yana.id, "respond_to_offer", { offer, decision: "accept" });
    return { prop, offer, resp };
  };
  const flowReport = async (runId) => api(`/api/flow-runs/${runId}`);
  const relationOf = (rep, id) => {
    const c = rep.report.characters.find((x) => x.characterId === id);
    return c?.relations?.find((r) => r.toId === (id === sasha.id ? yana.id : sasha.id))?.value ?? null;
  };
  return { act, eventsAfter, getChar, patchState, findOfferId, proposeOnly, proposeAccept, flowReport, relationOf, scenes, nameOf };
}

async function smoke() {
  console.log(`
============ SMOKE: пешеходный прогон (без LLM) ============`);
  const world = await buildWorld(); // wipe + seed заново — идемпотентно
  const h = await makeSmokeHelpers(world);
  const { sasha, yana } = world;
  const S1 = world.scenes.s1, S2 = world.scenes.s2, S3 = world.scenes.s3, S4 = world.scenes.s4;

  // Подготовка: химия 0 (детерминированная математика), оба — «люди»
  // (движок не станет звать модель: autoResume молча откажется стартовать).
  await api("/api/chemistry", "PATCH", { aId: sasha.id, bId: yana.id, value: 0 });
  await api(`/api/characters/${sasha.id}`, "PATCH", { isHuman: true });
  await api(`/api/characters/${yana.id}`, "PATCH", { isHuman: true });
  console.log("Химия пары выставлена в 0; оба персонажа временно isHuman (LLM не вызывается).\n");

  // ---------- Сцена 1: Переписка ----------
  console.log("— СЦЕНА 1 «Переписка» (место: сайт знакомств)");
  let r = await h.act(S1, sasha.id, "text_message", { to: "Яна", text: "Привет! Увидел твою анкету — не удержался написать. Как проходит вечер?" });
  report("G1. text_message доставлен", r.ok === true, r.result?.slice(0, 80));

  r = await h.act(S1, sasha.id, "invite_date", { to: "Яна", plan: "кофе в субботу" });
  report("G2. invite_date ДО порогов отклонён границей", r.ok === false && /отношение|доверие/.test(String(r.result)), String(r.result).slice(0, 110));

  for (const text of ["У тебя удивительно тёплые глаза", "Твой юмор в анкете — огонь", "Мне уже интересно тебя слушать"]) {
    await h.act(S1, sasha.id, "compliment", { to: "Яна", text });
  }
  let yanaChar = await h.getChar(yana.id);
  report("G3. Три комплимента подняли настроение до 7 (старт 4: платье +1 и «бельё надето» −1 погасились)", yanaChar.state.mood === 7, `mood=${yanaChar.state.mood} (4+3)`);

  await h.patchState(yana.id, { trust: 3 });
  const acc = await h.proposeAccept(S1, "invite_date", { to: "Яна", plan: "кофе в субботу" }, "Пригласить");
  report("G4. invite_date ПОРОГ пройден: оффер создан и принят", acc.prop.ok === true && acc.resp?.ok === true, String(acc.resp?.result ?? "").slice(0, 90));

  // Отказ от оффера (declineEffects kiss: отношение −1, возбуждение −1 у Яны)
  const pk = await h.proposeOnly(S1, "kiss", { to: "Яна" }, "Поцелуй");
  const declined = pk.offer
    ? await h.act(S1, yana.id, "respond_to_offer", { offer: pk.offer, decision: "decline", words: "Рано ещё" })
    : null;
  yanaChar = await h.getChar(yana.id);
  report(
    "G5. Отказ от поцелуя: declineEffects применились (arousal не ниже 0, отказ дошёл)",
    declined?.ok === true && yanaChar.state.arousal === 0,
    declined ? `arousal=${yanaChar.state.arousal}, ${String(declined.result).slice(0, 60)}` : "оффер не создан"
  );

  // Флоу: прогон + переход из узла n1
  const run = await api(`/api/flows/${world.flow.id}/runs`, "POST", { characterIds: [sasha.id, yana.id] });
  let ev = await api(`/api/flow-runs/${run.id}/evaluate`, "POST", { nodeId: "n1" });
  report(
    "G6. Переход n1→n2: оба двинулись",
    Array.isArray(ev.moved) && ev.moved.length === 2 && ev.moved.every((m) => m.to === "n2"),
    `moved=${JSON.stringify(ev.moved)}`
  );

  // ---------- Сцена 2: Свидание в кафе ----------
  console.log("\n— СЦЕНА 2 «Свидание в кафе» (место: кафе)");
  await h.patchState(yana.id, { mood: 2 }); // сознательно опускаем для проверки границы
  r = await h.act(S2, sasha.id, "kiss", { to: "Яна" });
  report("G7. kiss при настроении 2 (<5) отклонён границей", r.ok === false && /Настроение|настроение/.test(String(r.result)), String(r.result).slice(0, 110));

  for (const text of ["Свечи тут явно для тебя подобраны", "Ты сегодня прекраснее своего меню", "Смешно: я волнуюсь больше, чем на экзамене"]) {
    await h.act(S2, sasha.id, "compliment", { to: "Яна", text });
  }
  await h.act(S2, sasha.id, "say", { phrase: "Расскажи о себе то, чего нет в анкете" });
  r = await h.act(S2, sasha.id, "shop_buy", { item: "букет цветов", for: "Яна" });
  const sashaChar = await h.getChar(sasha.id);
  report("G8. Букет куплен и подарен ($150→$125, отношение +1)", r.ok === true && sashaChar.state.money === 125, `money=${sashaChar.state.money}`);

  const kiss = await h.proposeAccept(S2, "kiss", { to: "Яна" }, "Поцелуй");
  yanaChar = await h.getChar(yana.id);
  report(
    "G9. kiss ПОРОГ пройден: исполнен (arousal+2, mood+1, relation+2)",
    kiss.resp?.ok === true && yanaChar.state.arousal === 2,
    `arousal=${yanaChar.state.arousal}, ${String(kiss.resp?.result ?? "").slice(0, 70)}`
  );

  ev = await api(`/api/flow-runs/${run.id}/evaluate`, "POST", { nodeId: "n2" });
  report("G10. Переход n2→n3: оба двинулись", ev.moved?.length === 2 && ev.moved.every((m) => m.to === "n3"), `moved=${JSON.stringify(ev.moved)}`);

  // ---------- Сцена 3: Прогулка ----------
  console.log("\n— СЦЕНА 3 «Прогулка» (место: набережная)");
  r = await h.act(S3, sasha.id, "massage", { to: "Яна" });
  report("G11. massage не на дому отклонён границей (место)", r.ok === false && /место/i.test(String(r.result)), String(r.result).slice(0, 110));

  r = await h.act(S3, yana.id, "undress", { slot: "underwear" });
  report("G12. undress белья на набережной запрещён физикой места", r.ok === false, String(r.result).slice(0, 100));

  r = await h.act(S3, sasha.id, "sex", { to: "Яна" });
  report("G13. sex на набережной отклонён границей (место)", r.ok === false && /место/i.test(String(r.result)), String(r.result).slice(0, 110));

  await h.patchState(yana.id, { trust: 2 });
  r = await h.act(S3, sasha.id, "invite_home", { to: "Яна" });
  report("G14. invite_home при доверии 2 (<6) отклонён границей", r.ok === false && /доверие|Доверие/.test(String(r.result)), String(r.result).slice(0, 110));

  await h.patchState(yana.id, { trust: 6 });
  const ih = await h.proposeAccept(S3, "invite_home", { to: "Яна" }, "домой");
  report("G15. invite_home ПОРОГ пройден: оффер принят", ih.resp?.ok === true, String(ih.resp?.result ?? "").slice(0, 90));

  ev = await api(`/api/flow-runs/${run.id}/evaluate`, "POST", { nodeId: "n3" });
  report("G16. Переход n3→n4: оба двинулись", ev.moved?.length === 2 && ev.moved.every((m) => m.to === "n4"), `moved=${JSON.stringify(ev.moved)}`);

  // ---------- Сцена 4: Близость ----------
  console.log("\n— СЦЕНА 4 «Близость» (место: квартира Яны)");
  r = await h.act(S4, sasha.id, "pose_change", { to: "Яна", pose: "классика" });
  report("G17. pose_change с надетым бельём отклонён границей (worn)", r.ok === false && /underwear|пуст/i.test(String(r.result)), String(r.result).slice(0, 110));
  r = await h.act(S4, sasha.id, "sex", { to: "Яна" });
  report("G18. sex с надетым бельём отклонён границей (worn)", r.ok === false && /underwear|пуст/i.test(String(r.result)), String(r.result).slice(0, 110));

  r = await h.act(S4, yana.id, "undress", { slot: "underwear" });
  report("G19. Слои: бельё поверх платья не снимается", r.ok === false && /верхн/i.test(String(r.result)), String(r.result).slice(0, 100));

  await h.act(S4, yana.id, "undress", { slot: "top" });
  await h.act(S4, yana.id, "undress", { slot: "bottom" });
  r = await h.act(S4, yana.id, "undress", { slot: "underwear" });
  yanaChar = await h.getChar(yana.id);
  const tattooVerified = String(r.result ?? "").includes("татуировка");
  report(
    "G20. Бельё снято дома: bare-эффекты (+mood/+anxiety, arousal netto 0) и татуировка верифицирована Саше",
    r.ok === true && yanaChar.state.arousal === 2 && tattooVerified,
    `arousal=${yanaChar.state.arousal} (2: +2 поцелуй в кафе, бельё±0), mood=${yanaChar.state.mood}, anxiety=${yanaChar.state.anxiety}; ${tattooVerified ? "знание верифицировано" : "верификации нет!"}`
  );

  await h.act(S4, sasha.id, "kiss", { to: "Яна" }).then(async (k) => {
    const oid = await h.findOfferId(S4, yana.id, "Поцелуй");
    return h.act(S4, yana.id, "respond_to_offer", { offer: oid, decision: "accept" });
  });
  r = await h.act(S4, sasha.id, "massage", { to: "Яна" });
  yanaChar = await h.getChar(yana.id);
  report("G21. massage дома исполнен (arousal+2 → 6, anxiety−1)", r.ok === true && yanaChar.state.arousal === 6, `arousal=${yanaChar.state.arousal}, anxiety=${yanaChar.state.anxiety}`);

  // Скрытый исход «warm» (arousal ≥ 6, < 9): разрядки ещё нет. Исполнение по
  // согласию замыкает комбо «Волна» (kiss→massage→pose_change, всё с Яной):
  // arousal 6 +1 (warm) +3 (комбо) = 10.
  const poseWarm = await h.proposeAccept(S4, "pose_change", { to: "Яна", pose: "на боку, обняв сзади" }, "позу");
  yanaChar = await h.getChar(yana.id);
  report(
    "G22. pose_change при arousal 6 → исход «warm» (+1) и комбо «Волна» (+3 → 10)",
    poseWarm.resp?.ok === true && String(poseWarm.resp.result).includes("Приятно") && yanaChar.state.arousal === 10 && yanaChar.state.orgasm === undefined,
    `arousal=${yanaChar.state.arousal}, orgasm-ключа нет`
  );

  r = await h.act(S4, sasha.id, "sex", { to: "Яна" });
  const oidSex = r.ok ? await h.findOfferId(S4, yana.id, "Близость") : null;
  const sexResp = oidSex ? await h.act(S4, yana.id, "respond_to_offer", { offer: oidSex, decision: "accept" }) : null;
  yanaChar = await h.getChar(yana.id);
  report("G23. sex исполнен (arousal+2 → клампится в 10 — на пике)", sexResp?.ok === true && yanaChar.state.arousal === 10, `arousal=${yanaChar.state.arousal}`);

  // Правильная поза на пике: скрытый исход «fire» (arousal ≥ 9).
  // Числа сходятся сами; страховочный трамплин — если где-то недоехали.
  yanaChar = await h.getChar(yana.id);
  if ((yanaChar.state.arousal ?? 0) < 9) await h.patchState(yana.id, { arousal: 9 });
  const poseFire = await h.proposeAccept(S4, "pose_change", { to: "Яна", pose: "именно так, как она любит" }, "позу");
  yanaChar = await h.getChar(yana.id);
  report(
    "G24. pose_change при arousal 9 → исход «fire»: настроение +2 (атрибута «Разрядка» больше нет)",
    poseFire.resp?.ok === true && String(poseFire.resp.result).includes("Попадание в вкус") && yanaChar.state.orgasm === undefined,
    `mood=${yanaChar.state.mood}, orgasm-ключа нет`
  );
  const evs = await h.eventsAfter(S4, 0);
  const notice = evs.some((e) => e.type === "director" && String(e.payload.text ?? "").includes("накрывает волной"));
  report("G25. Личное уведомление Яны о разрядке доставлено (director)", notice, notice ? "«Тебя накрывает волной…»" : "не найдено");
  const comboBroadcasts = evs.filter((e) => e.type === "director" && String(e.payload.text ?? "").includes("Комбо «Волна»"));
  report("G26. Комбо «Волна» сработало на исполнении по согласию и объявлено всем", comboBroadcasts.length === 1, `director-анонсов: ${comboBroadcasts.length}`);

  // Отказ от лишней позы: declineEffects pose_change — arousal Яны падает
  yanaChar = await h.getChar(yana.id);
  const arousalBeforeDecline = yanaChar.state.arousal ?? 0;
  const extra = await h.proposeOnly(S4, "pose_change", { to: "Яна", pose: "кто-то как будто не то предложил" }, "позу");
  const dec = extra.offer ? await h.act(S4, yana.id, "respond_to_offer", { offer: extra.offer, decision: "decline", words: "Не так" }) : null;
  yanaChar = await h.getChar(yana.id);
  report(
    "G27. Отказ от позы: declineEffects self arousal−1",
    dec?.ok === true && yanaChar.state.arousal === Math.max(0, arousalBeforeDecline - 1),
    `arousal ${arousalBeforeDecline} → ${yanaChar.state.arousal}`
  );

  // Переход в финал + отчёт прогона
  ev = await api(`/api/flow-runs/${run.id}/evaluate`, "POST", { nodeId: "n4" });
  report("G28. Переход n4→финал: оба дошли", ev.moved?.length === 2 && ev.moved.every((m) => m.to === "fin" && m.status === "final"), `moved=${JSON.stringify(ev.moved)}`);
  const rep = await h.flowReport(run.id);
  const fin = rep.report.characters.map((c) => `${c.name}: score=${c.score}, bonus=${c.bonus}, total=${c.total}`);
  report(
    "G29. Прогон завершён, бонус финала начислен, скорость/бонус ≥ 100",
    rep.report.run.status === "finished" && rep.report.characters.every((c) => c.total >= 100 && c.reachedFinal),
    `${fin.join("; ")}`
  );

  // ---------- Финиш сцены 4 (проверка config.finish без LLM: mock-провайдер) ----------
  console.log("\n— ФИНИШ СЦЕНЫ 4 (крутится движок на mock-провайдере, несколько ходов)");
  const providers = await api("/api/providers");
  let mock = providers.find((p) => p.kind === "mock");
  if (!mock) mock = await api("/api/providers", "POST", { name: "mock (для smoke)", kind: "mock", baseUrl: "mock://local" });
  await api(`/api/characters/${sasha.id}`, "PATCH", { isHuman: false, providerId: mock.id, model: "" });
  await api(`/api/characters/${yana.id}`, "PATCH", { isHuman: false, providerId: mock.id, model: "" });
  await api(`/api/scenes/${S4}/control`, "POST", { action: "start" });
  const deadline = Date.now() + 180_000;
  let rt = null;
  while (Date.now() < deadline) {
    await new Promise((res) => setTimeout(res, 3000));
    rt = (await api(`/api/scenes/${S4}`)).runtime;
    if (rt.status === "finished") break;
    if (rt.status === "paused") await api(`/api/scenes/${S4}/control`, "POST", { action: "resume" }).catch(() => null);
  }
  const finEvs = await h.eventsAfter(S4, 0);
  const metMsg = finEvs.some((e) => e.type === "system" && String(e.payload.message ?? "").includes("Условия завершения"));
  report("G30. config.finish С4: событие «Условия завершения достигнуты» и статус finished", rt?.status === "finished" && metMsg, `status=${rt?.status}`);

  // Вернуть мир в рабочее состояние: реальные провайдер/модель
  await api(`/api/characters/${sasha.id}`, "PATCH", { providerId: world.providerId, model: world.model });
  await api(`/api/characters/${yana.id}`, "PATCH", { providerId: world.providerId, model: world.model });

  const rep2 = await h.flowReport(run.id);
  const relText = rep2.report.characters
    .map((c) => `${c.name} → [${c.relations.map((x) => `${x.name}:${x.value}`).join(", ") || "—"}]`)
    .join("; ");
  console.log(`\nИтог прогона: статус ${rep2.report.run.status}; итоговые отношения: ${relText}.`);
  console.log(`\n============ SMOKE: ${failures === 0 ? "ВСЕ ГЕЙТЫ ПРОЙДЕНЫ" : "ЕСТЬ ПРОВАЛЫ"} (${checks - failures}/${checks}) ============`);
  if (failures > 0) process.exitCode = 1;
}

// Обёртка: smoke пересоздаёт мир (идемпотентность), обычный запуск — тоже.
async function buildWorld() {
  await wipeWorld();
  const world = await seedWorld();
  printWorld(world);
  return world;
}

try {
  if (flag("--wipe-only")) {
    await wipeWorld();
    console.log("Мир вычищен. Провайдеры не тронуты.");
  } else if (flag("--smoke")) {
    await smoke();
  } else {
    const world = await buildWorld();
    console.log(`\nГотово. Запусти прогон флоу #${world.flow.id} с составом [Саша #${world.sasha.id}, Яна #${world.yana.id}] или стартуй сцену С1 #${world.scenes.s1}.`);
    console.log("Пешеходная проверка без LLM: node scripts/seed-demo.mjs --smoke");
  }
} catch (e) {
  console.error("ОШИБКА:", e.message);
  process.exit(1);
}
