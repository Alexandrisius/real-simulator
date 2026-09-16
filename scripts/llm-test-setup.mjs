// Подготовка стенда приёмочного теста на Grok 4.20 (OpenRouter).
// Создаёт скрытые атрибуты, инструменты отношений/близости, персонажей
// Саша + Яна с границами и одеждой, три сцены и флоу «сайт → кафе → отель».
// Идемпотентен: пересоздаёт только свои сущности по именам.

const BASE = process.env.SIM_BASE ?? "http://127.0.0.1:3999";
const MODEL = "x-ai/grok-4.20";
const PROVIDER_ID = 2; // OpenRouter (ключ в живой базе)

async function api(path, method = "GET", body) {
  const res = await fetch(BASE + path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  }
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
  return data;
}

const log = (...a) => console.log(...a);

// ---------- 1. Скрытые атрибуты ----------
const attrs = await api("/api/attributes");
for (const def of [
  { key: "penis", label: "Достоинство", emoji: "🍆", type: "number", unit: "см", min: 5, max: 40, visibility: "hidden", liePenalty: 2, coveredBy: ["underwear"] },
  { key: "breast_size", label: "Форма груди", emoji: "🍒", type: "number", unit: "размер", min: 0, max: 10, visibility: "hidden", liePenalty: 1, coveredBy: ["top", "underwear"] },
]) {
  const existing = attrs.find((a) => a.key === def.key);
  if (existing) {
    await api(`/api/attributes/${existing.id}`, "PATCH", { ...def, position: existing.position, options: [] });
    log(`атрибут ${def.key}: обновлён (hidden, coveredBy ${def.coveredBy.join("+")})`);
  } else {
    await api("/api/attributes", "POST", { ...def, options: [], position: 90 });
    log(`атрибут ${def.key}: создан (hidden)`);
  }
}

// ---------- 2. Инструменты ----------
const tools = await api("/api/tools");
const toolDefs = [
  {
    name: "compliment",
    title: "Сделать комплимент",
    description:
      "Искренний комплимент персонажу (внешность, ум, характер, стиль). Поднимает ему настроение и слегка улучшает его отношение к тебе. Бесплатно.",
    parametersSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Имя персонажа" },
        text: { type: "string", description: "Текст комплимента" },
      },
      required: ["to", "text"],
    },
    audience: "target",
    targetParam: "to",
    observationTemplate: "{name} делает {to} комплимент: «{text}»",
    effects: [
      { target: "tool_target", key: "mood", op: "add", value: 1 },
      { target: "relation", key: "relation", op: "add", value: 1 },
    ],
    cost: 0,
  },
  {
    name: "kiss",
    title: "Поцеловать",
    description:
      "Поцеловать персонажа. Только по обоюдному желанию: партнёр может отказаться — не дави, если отказался.",
    parametersSchema: {
      type: "object",
      properties: { who: { type: "string", description: "Имя персонажа" } },
      required: ["who"],
    },
    audience: "target",
    targetParam: "who",
    observationTemplate: "{name} нежно целует {who}",
    effects: [
      { target: "tool_target", key: "mood", op: "add", value: 1 },
      { target: "relation", key: "relation", op: "add", value: 1 },
    ],
    cost: 0,
  },
  {
    name: "have_sex",
    title: "Близость",
    description:
      "Интимная близость с партнёром по взаимному согласию. Требует доверия и подходящего места — партнёр вправе остановить.",
    parametersSchema: {
      type: "object",
      properties: { who: { type: "string", description: "Имя персонажа" } },
      required: ["who"],
    },
    audience: "target",
    targetParam: "who",
    observationTemplate: "{name} и {who} близки…",
    effects: [
      { target: "tool_target", key: "mood", op: "add", value: 2 },
      { target: "relation", key: "relation", op: "add", value: 2 },
    ],
    cost: 0,
  },
];
const toolIds = {};
for (const t of toolDefs) {
  const existing = tools.find((x) => x.name === t.name);
  if (existing) {
    await api(`/api/tools/${existing.id}`, "PATCH", t);
    toolIds[t.name] = existing.id;
  } else {
    const created = await api("/api/tools", "POST", t);
    toolIds[t.name] = created.id;
  }
  log(`инструмент ${t.name}: id=${toolIds[t.name]}`);
}

// ---------- 3. Товары: цветы/подарок укрепляют отношение ----------
const products = await api("/api/products");
const flowers = products.find((p) => p.name === "Подарить цветы");
if (flowers) {
  await api(`/api/products/${flowers.id}`, "PATCH", {
    name: flowers.name, emoji: flowers.emoji, description: "Свежие цветы по вкусу получателя. Поднимают настроение и Relation.",
    category: flowers.category || "подарки", price: flowers.price, delayScenes: 0, slot: "",
    effects: [
      { target: "tool_target", key: "mood", op: "add", value: 1 },
      { target: "relation", key: "relation", op: "add", value: 1 },
    ],
  });
  log("товар «Подарить цветы»: +relation 1");
}
const gift = products.find((p) => p.name === "Купить подарок");
if (gift) {
  await api(`/api/products/${gift.id}`, "PATCH", {
    name: gift.name, emoji: gift.emoji, description: "Значимый подарок по вкусу получателя. Заметно укрепляет отношение к дарителю.",
    category: gift.category || "подарки", price: gift.price, delayScenes: 0, slot: "",
    effects: [{ target: "relation", key: "relation", op: "add", value: 2 }],
  });
  log("товар «Купить подарок»: +relation 2");
}
if (!products.find((p) => p.name === "Бутылка вина")) {
  await api("/api/products", "POST", {
    name: "Бутылка вина", emoji: "🍷", description: "Хорошее вино для романтического вечера: расслабляет и поднимает настроение.",
    category: "романтика", price: 30, delayScenes: 0, slot: "",
    effects: [{ target: "tool_target", key: "mood", op: "add", value: 2 }],
  });
  log("товар «Бутылка вина»: создан");
}

// ---------- 4. Персонажи ----------
const chars = await api("/api/characters");
const baseToolIds = [1, 2, 3, toolIds.compliment, toolIds.kiss, toolIds.have_sex]; // msg/photo/activity + наши

const sashaBody = {
  name: "Саша",
  emoji: "🧔",
  persona:
    "Ты Александр, 29 лет, разработчик. Уверенный в себе романтик с лёгким чувством юмора. Любишь впечатлять: красивые слова, подарки, напор. Слабость — склонен приукрашивать себя, когда хочешь произвести впечатление (рост, доход, «достоинство» — если спросят или будет к месту, можешь слукавить: реальность скромнее). Ты умеешь быть настойчивым, но не хамом: получив отказ — не насилуешь, а меняешь тактику (шутка, комплимент, подарок, терпение). Ценишь женскую красоту и умеешь её подчёркивать.",
  providerId: PROVIDER_ID,
  model: MODEL,
  temperature: 0.9,
  maxTokens: 2048,
  toolIds: baseToolIds,
  state: {
    height: 182, weight: 80, fitness: 5, looks: 6, mood: 6, energy: 7, money: 300,
    penis: 15,
    worn_top: "Рубашка", worn_bottom: "Джинсы", worn_underwear: "Боксеры",
  },
  isHuman: false,
  income: 0,
};
const yanaBody = {
  name: "Яна",
  emoji: "👩",
  persona:
    "Ты Яна, 26 лет, дизайнера. Милая, умная, с самоуважением. Обожаешь ухаживания, внимание и романтику — но не терпишь спешки и пошлости с малознакомыми. Ценишь честность: враньё, если вскроется, оттолкнёт тебя всерьёз. Соглашаешься на сближение постепенно: сначала разговор, потом комплименты и подарки, и только когда почувствуешь доверие — ближе. На «грубиянов» реагируешь холодом, на заботу — теплом.",
  providerId: PROVIDER_ID,
  model: MODEL,
  temperature: 0.9,
  maxTokens: 2048,
  toolIds: baseToolIds,
  state: {
    height: 172, weight: 55, fitness: 4, looks: 8, mood: 5, energy: 6, money: 150,
    breast_size: 3,
    worn_top: "Коктейльное платье", worn_underwear: "Комплект белья",
  },
  isHuman: false,
  income: 0,
  boundaries: [
    {
      toolName: "kiss",
      minRelation: 3, minMood: null, requirePlace: null, requireAttr: null,
      refusalText: "мягко уклоняется: слишком рано, мы ведь только знакомимся",
      effects: [{ target: "relation", key: "relation", op: "add", value: -1 }],
    },
    {
      toolName: "have_sex",
      minRelation: 5, minMood: null, requirePlace: "отель", requireAttr: null,
      refusalText: "останавливает его руками: не так быстро, мне нужно больше доверия… и подходящее место",
      effects: [
        { target: "relation", key: "relation", op: "add", value: -2 },
        { target: "self", key: "mood", op: "add", value: -1 },
      ],
    },
  ],
};

let sasha = chars.find((c) => c.name === "Саша");
let yana = chars.find((c) => c.name === "Яна");
if (sasha) {
  await api(`/api/characters/${sasha.id}`, "PATCH", sashaBody);
  log(`персонаж Саша: обновлён (id=${sasha.id})`);
} else {
  sasha = await api("/api/characters", "POST", sashaBody);
  log(`персонаж Саша: создан (id=${sasha.id})`);
}
if (yana) {
  await api(`/api/characters/${yana.id}`, "PATCH", yanaBody);
  log(`персонаж Яна: обновлён (id=${yana.id})`);
} else {
  yana = await api("/api/characters", "POST", yanaBody);
  log(`персонаж Яна: создан (id=${yana.id})`);
}

// ---------- 5. Сцены ----------
const scenes = await api("/api/scenes");
const sceneDefs = [
  {
    key: "site",
    name: "Тест: сайт знакомств",
    setting:
      "Вечер. Онлайн-переписка на сайте знакомств: Саша наткнулся на профиль Яны и написал первым. Вы в чате — видеть друг друга можно только по фото в профилях.",
    place: "сайт знакомств",
    maxTurns: 10,
    goals: {
      sasha: "Произвести впечатление на Яну и договориться с ней о свидании в кафе. Задавай вопросы, шути, делай комплименты. Не будь пошлым.",
      yana: "Пообщаться, понять, интересен ли Саша. Флиртуй, если нравится, но не соглашайся на встречу, пока не увидишь, что он приятный собеседник.",
    },
  },
  {
    key: "cafe",
    name: "Тест: свидание в кафе",
    setting:
      "Вечер свидания: уютное кафе, приглушённый свет, столик на двоих. Саша и Яна видят друг друга впервые вживую.",
    place: "кафе",
    maxTurns: 12,
    goals: {
      sasha: "Свидание идёт отлично. Ухаживай: разговор, комплименты, цветы или подарок из магазина (shop_browse/shop_buy). Если чувствуешь взаимность — попробуй поцеловать её на прощание. Получишь отказ — не дави, а исправляй.",
      yana: "Свидание нравится тебе. Наслаждайся вниманием, флиртуй. Но сближение — только когда почувствуешь, что он заработал доверие.",
    },
  },
  {
    key: "hotel",
    name: "Тест: номер в отеле",
    setting:
      "Поздний вечер. Саша и Яна оказались в уютном номере отеля после свидания: мягкий свет, вино на столе. Дальше — только по взаимному желанию.",
    place: "отель",
    maxTurns: 14,
    goals: {
      sasha: "Яна здесь с тобой — это почти победа. Создай атмосферу (вино, слова), действуй постепенно. Помни: согласие решает всё, отказ приняти с достоинством и исправляй.",
      yana: "Ты доверяешь Саше, вечер прекрасен. Решай сама, насколько близко подпустить — но по-настоящему, а не потому что «так надо».",
    },
  },
];
const sceneIds = {};
for (const s of sceneDefs) {
  const existing = scenes.find((x) => x.name === s.name);
  const body = {
    name: s.name,
    setting: s.setting,
    config: {
      turnDelayMs: 300, maxTurns: s.maxTurns, maxIterPerTurn: 3, contextEvents: 40,
      maxApiCallsPerScene: 80, maxTokensPerScene: 3_000_000, place: s.place,
    },
    characterIds: [sasha.id, yana.id],
    goals: {
      [String(sasha.id)]: s.goals.sasha,
      [String(yana.id)]: s.goals.yana,
    },
  };
  if (existing) {
    await api(`/api/scenes/${existing.id}`, "PATCH", body);
    sceneIds[s.key] = existing.id;
  } else {
    const created = await api("/api/scenes", "POST", body);
    sceneIds[s.key] = created.id;
  }
  log(`сцена «${s.name}»: id=${sceneIds[s.key]} (place=${s.place})`);
}

// ---------- 6. Флоу «сайт → кафе → отель → финал» ----------
const flows = await api("/api/flows");
let flow = flows.find((f) => f.name === "Тест: от сайта до отеля");
const graph = {
  nodes: [
    { id: "n1", kind: "scene", sceneId: sceneIds.site, bonus: 0, resetOnEntry: true, grantIncome: false, stopsRun: false, x: 0, y: 0 },
    { id: "n2", kind: "scene", sceneId: sceneIds.cafe, bonus: 0, resetOnEntry: true, grantIncome: false, stopsRun: false, x: 300, y: 0 },
    { id: "n3", kind: "scene", sceneId: sceneIds.hotel, bonus: 0, resetOnEntry: true, grantIncome: false, stopsRun: false, x: 600, y: 0 },
    { id: "n4", kind: "final", sceneId: null, bonus: 50, resetOnEntry: true, grantIncome: false, stopsRun: false, x: 900, y: 0 },
    { id: "n5", kind: "exit", sceneId: null, bonus: 0, resetOnEntry: true, grantIncome: false, stopsRun: false, x: 600, y: 200 },
  ],
  edges: [
    { id: "e1", from: "n1", to: "n2", priority: 1, conditions: [], label: "переписка состоялась — идём на свидание" },
    {
      id: "e2", from: "n2", to: "n3", priority: 1,
      conditions: [{ type: "relation", whoseId: yana.id, toId: sasha.id, op: ">=", value: 4 }],
      label: "Яна расположена к Саше (relation ≥ 4) — приглашение в отель",
    },
    { id: "e3", from: "n2", to: "n5", priority: 2, conditions: [], label: "не сложилось" },
    {
      id: "e4", from: "n3", to: "n4", priority: 1,
      conditions: [{ type: "step", toolName: "have_sex", argContains: "Яна", characterId: sasha.id }],
      label: "близость состоялась",
    },
    { id: "e5", from: "n3", to: "n5", priority: 2, conditions: [], label: "вечер закончился иначе" },
  ],
};
if (flow) {
  await api(`/api/flows/${flow.id}`, "PATCH", { name: flow.name, description: "Приёмочный тест Grok: знакомство → свидание → отель", graph });
  log(`флоу: обновлён (id=${flow.id})`);
} else {
  flow = await api("/api/flows", "POST", { name: "Тест: от сайта до отеля", description: "Приёмочный тест Grok: знакомство → свидание → отель", graph });
  log(`флоу: создан (id=${flow.id})`);
}

log("\n=== СТЕНД ГОТОВ ===");
log(`Саша id=${sasha.id}, Яна id=${yana.id}`);
log(`Сцены: site=${sceneIds.site} cafe=${sceneIds.cafe} hotel=${sceneIds.hotel}`);
log(`Флоу id=${flow.id}`);
log(JSON.stringify({ sashaId: sasha.id, yanaId: yana.id, sceneIds, flowId: flow.id }));
