// Приёмочный кейс Grok на новых механиках (Фазы A/B/C):
// «девушка не строит серьёзных отношений без настоящей близости — парень
// учится, сюжет развивается». Навыки + практика, исходы (кульминация/
// почти/не то), химия, курсы в магазине, границы, одежда.
// Идемпотентен по именам «Кейс2: …». Запуск: node scripts/grok-case.mjs

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 1. Атрибуты: фрустрация Яны (скрытая — Саша узнает по поведению) ----------
const attrs = await api("/api/attributes");
if (!attrs.some((a) => a.key === "frustration")) {
  await api("/api/attributes", "POST", {
    key: "frustration", label: "Фрустрация", emoji: "😤", type: "number", unit: "/10",
    min: 0, max: 10, options: [], position: 60, visibility: "hidden", liePenalty: 1, coveredBy: [],
  });
  log("атрибут frustration: создан (скрытый)");
} else {
  log("атрибут frustration: уже есть");
}

// ---------- 2. Навыки: секс (поцелуи уже есть) ----------
let skills = await api("/api/skills");
if (!skills.some((s) => s.key === "sex")) {
  await api("/api/skills", "POST", {
    key: "sex", label: "Секс", emoji: "🔥", maxLevel: 5, practicePerLevel: 3, grows: true,
  });
  skills = await api("/api/skills");
  log("навык «Секс»: создан (3 применения на уровень, скрытый атрибут skill_sex)");
} else {
  log("навык «Секс»: уже есть");
}

// ---------- 3. Тул близости с исходами ----------
const tools = await api("/api/tools");
const haveSexDef = {
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
    { target: "tool_target", key: "mood", op: "add", value: 1 },
    { target: "relation", key: "relation", op: "add", value: 1 },
  ],
  cost: 0,
  trainsSkill: "sex",
  outcomes: [
    {
      id: "climax",
      title: "Кульминация",
      conditions: [
        { kind: "actor_attr", key: "skill_sex", op: ">=", value: 3 },
        { kind: "worn", key: "underwear", op: "=", value: "" },
        { kind: "relation", key: "", op: ">=", value: 5 },
      ],
      effects: [
        { target: "tool_target", key: "mood", op: "add", value: 3 },
        { target: "relation", key: "relation", op: "add", value: 2 },
        { target: "chemistry", key: "chemistry", op: "add", value: 1 },
      ],
      noticeTarget:
        "Волна накрывает тебя с головой: тело дрожит, дыхание сбивается — вот оно, настоящее. Ты никогда не забудешь этот вечер.",
      hideFromPrompt: false,
    },
    {
      id: "almost",
      title: "Почти",
      conditions: [{ kind: "actor_attr", key: "skill_sex", op: ">=", value: 2 }],
      effects: [
        { target: "tool_target", key: "mood", op: "add", value: 1 },
        { target: "relation", key: "relation", op: "add", value: 1 },
      ],
      noticeTarget:
        "Было тепло и приятно… но той самой волны не случилось — как будто не дотянули самую малость.",
      hideFromPrompt: false,
    },
    {
      id: "flat",
      title: "Не то",
      conditions: [{ kind: "actor_attr", key: "skill_sex", op: "<", value: 2 }],
      effects: [
        { target: "tool_target", key: "mood", op: "add", value: -1 },
        { target: "tool_target", key: "frustration", op: "add", value: 1 },
      ],
      noticeTarget:
        "Было как-то механически и скованно: он старался, но ты не почувствовала ничего похожего на близость. Внутри нарастает разочарование.",
      hideFromPrompt: true,
    },
  ],
};
{
  const existing = tools.find((t) => t.name === "have_sex");
  if (existing) {
    await api(`/api/tools/${existing.id}`, "PATCH", haveSexDef);
    log(`тул have_sex: обновлён (исходы climax/almost/flat, тренирует «Секс»)`);
  } else {
    const t = await api("/api/tools", "POST", haveSexDef);
    log(`тул have_sex: создан (id=${t.id})`);
  }
}
// поцелуй — тренирует «Поцелуи» (навык уже есть)
{
  const kiss = tools.find((t) => t.name === "kiss");
  if (kiss && kiss.trainsSkill !== "kiss") {
    await api(`/api/tools/${kiss.id}`, "PATCH", { ...kiss, trainsSkill: "kiss" });
    log("тул kiss: привязан к навыку «Поцелуи»");
  }
}

// ---------- 4. Товары: курсы мастерства ----------
const products = await api("/api/products");
const courseDefs = [
  {
    name: "Курс «Искусство любви»", emoji: "📚", price: 60, delay: 1,
    description: "Онлайн-курс техники близости: нежность, ритм, внимание к партнёру. Заметно повышает мастерство (уровень навыка «Секс» +2). Учёба занимает время — эффект наступит в следующей сцене.",
    effects: [{ target: "self", key: "skill_sex", op: "add", value: 2 }],
  },
  {
    name: "Мастер-класс тантры", emoji: "🕯️", price: 90, delay: 1,
    description: "Глубокий практикум для опытных: дыхание, энергия, кульминация. Резко повышает мастерство (уровень навыка «Секс» +3). Эффект — в следующей сцене.",
    effects: [{ target: "self", key: "skill_sex", op: "add", value: 3 }],
  },
];
for (const c of courseDefs) {
  const existing = products.find((p) => p.name === c.name);
  const body = {
    name: c.name, emoji: c.emoji, description: c.description, category: "обучение",
    price: c.price, delayScenes: c.delay, slot: "", effects: c.effects,
  };
  if (existing) await api(`/api/products/${existing.id}`, "PATCH", body);
  else await api("/api/products", "POST", body);
  log(`товар «${c.name}»: ${existing ? "обновлён" : "создан"} ($${c.price}, skill_sex +${c.effects[0].value} через сцену)`);
}

// ---------- 5. Персонажи ----------
const chars = await api("/api/characters");
const freshTools = await api("/api/tools");
const toolIds = freshTools.filter((t) => ["compliment", "kiss", "have_sex"].includes(t.name)).map((t) => t.id);
const baseToolIds = [1, 2, 3, ...toolIds];

const sashaBody = {
  name: "Саша",
  emoji: "🧔",
  persona:
    "Ты Александр, 29 лет, разработчик. Романтик с юмором, умеешь ухаживать. Честная слабость: в близости ты пока неопытен — сам это знаешь и переживаешь. Умеешь учиться: книги, курсы, практика. Получив «не то» от партнёрши — не паникуешь, а делаешь выводы (в том числе покупаешь курсы в магазине: shop_browse → shop_buy). При отказе не давишь, а меняешь тактику.",
  providerId: PROVIDER_ID,
  model: MODEL,
  temperature: 0.9,
  maxTokens: 2048,
  toolIds: baseToolIds,
  state: {
    height: 182, weight: 80, fitness: 5, looks: 6, mood: 6, energy: 7,
    money: 150, penis: 15, skill_sex: 0, skill_kiss: 0,
    worn_top: "Рубашка", worn_bottom: "Джинсы", worn_underwear: "Боксеры",
  },
  isHuman: false,
  income: 50,
};
const yanaBody = {
  name: "Яна",
  emoji: "👩",
  persona:
    "Ты Яна, 26 лет, дизайнер. Умная, с самоуважением, чувственная. Секс для тебя — важная часть любви: заниматься им ты не против, но серьёзные отношения строишь только с тем, с кем получается настоящая близость. Если в постели «не то» — ты не устраиваешь скандал, но внутри копится разочарование, и ты честно говоришь об этом мягко. Ценишь, когда мужчина работает над собой. Врать тебе нельзя — проверишь и уйдёшь.",
  providerId: PROVIDER_ID,
  model: MODEL,
  temperature: 0.9,
  maxTokens: 2048,
  toolIds: baseToolIds,
  state: {
    height: 172, weight: 55, fitness: 4, looks: 8, mood: 6, energy: 6,
    money: 150, breast_size: 3, frustration: 0,
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
      minRelation: 4, minMood: null, requirePlace: "отель", requireAttr: null,
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
if (sasha) await api(`/api/characters/${sasha.id}`, "PATCH", sashaBody);
else sasha = await api("/api/characters", "POST", sashaBody);
if (yana) await api(`/api/characters/${yana.id}`, "PATCH", yanaBody);
else yana = await api("/api/characters", "POST", yanaBody);
log(`Саша id=${sasha.id} (skill_sex 0, $150), Яна id=${yana.id} (frustration 0)`);

// Химия: чистый лист
await api("/api/chemistry", "PATCH", { aId: sasha.id, bId: yana.id, value: 0 });
log("химия пары: 0");

// ---------- 6. Сцены ----------
const scenes = await api("/api/scenes");
const sceneDefs = [
  {
    key: "site", name: "Кейс2: сайт знакомств", place: "сайт знакомств", maxTurns: 6,
    setting:
      "Вечер. Онлайн-переписка на сайте знакомств: Саша написал Яне первым. Вы в чате, друг друга видите только по фото в профилях.",
    sasha: "Произвести впечатление и договориться о свидании в кафе. Вопросы, юмор, комплименты. Не будь пошлым.",
    yana: "Понять, интересен ли Саша. Флиртуй, если нравится, но на встречу соглашайся, только если он приятен.",
  },
  {
    key: "cafe", name: "Кейс2: свидание в кафе", place: "кафе", maxTurns: 10,
    setting:
      "Уютное кафе, приглушённый свет, столик на двоих. Первая встреча вживую после переписки.",
    sasha: "Ухаживай: разговор, комплименты, подарок из магазина (shop_browse/shop_buy) — цветы любят все. При взаимности можно поцеловать на прощание.",
    yana: "Наслаждайся вечером, флиртуй. Ближе подпускай того, кто заслужил доверие.",
  },
  {
    key: "hotel1", name: "Кейс2: первая ночь", place: "отель", maxTurns: 10,
    setting:
      "Поздний вечер. Уютный номер отеля после свидания: мягкий свет, вино. Дальше — только по взаимному желанию.",
    sasha: "Яна с тобой — доверяет. Создай атмосферу, действуй постепенно. Близость (have_sex) инициируешь сам, не жди её первого шага. Помни: бельё снимается инструментом undress — и у тебя, и у неё.",
    yana: "Ты доверяешь Саше и хочешь его. Если готова — разденься сама (undress). Скажи честно, что чувствуешь после близости.",
  },
  {
    key: "pause", name: "Кейс2: неделя спустя", place: "кафе", maxTurns: 10,
    setting:
      "Прошла неделя после той ночи. Саша и Яна снова в кафе — разговор о том, что случилось (и что не случилось).",
    sasha: "Та ночь вышла неловкой — ты сам это понял по её реакции. Не оправдывайся: покажи, что работаешь над собой (в магазине есть курсы!). Дай ей услышать, что тебе важно не только своё.",
    yana: "Скажи честно и мягко: секс был, а близости не получилось. Ты не уходишь — но тебе нужно видеть, что он умеет меняться. Решай по его поступкам.",
  },
  {
    key: "hotel2", name: "Кейс2: вторая ночь", place: "отель", maxTurns: 12,
    setting:
      "Саша снова пригласил Яну в отель — и на этот раз ты подготовился. Вечер, свечи, вино.",
    sasha: "Ты учился — теперь покажи. Нежность, не спеши: бельё снимается undress (у неё — всё, у тебя тоже). Близость (have_sex) вызываешь ты; требования «кульминации» ты знаешь из описания инструмента.",
    yana: "Ты пришла, потому что он старался. Доверься: если готова — разденься сама до конца (undress) и отдайся моменту.",
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
      maxApiCallsPerScene: 60, maxTokensPerScene: 3_000_000, place: s.place,
    },
    characterIds: [sasha.id, yana.id],
    goals: { [String(sasha.id)]: s.sasha, [String(yana.id)]: s.yana },
  };
  if (existing) {
    await api(`/api/scenes/${existing.id}`, "PATCH", body);
    sceneIds[s.key] = existing.id;
  } else {
    const created = await api("/api/scenes", "POST", body);
    sceneIds[s.key] = created.id;
  }
  log(`сцена «${s.name}»: id=${sceneIds[s.key]}`);
}

// ---------- 7. Флоу: обучение как условие развития сюжета ----------
const flows = await api("/api/flows");
let flow = flows.find((f) => f.name === "Кейс2: она ждёт близости");
const graph = {
  nodes: [
    { id: "n1", kind: "scene", sceneId: sceneIds.site, bonus: 0, resetOnEntry: true, grantIncome: false, stopsRun: false, x: 0, y: 0 },
    { id: "n2", kind: "scene", sceneId: sceneIds.cafe, bonus: 0, resetOnEntry: true, grantIncome: false, stopsRun: false, x: 280, y: 0 },
    { id: "n3", kind: "scene", sceneId: sceneIds.hotel1, bonus: 0, resetOnEntry: true, grantIncome: true, stopsRun: false, x: 560, y: 0 },
    { id: "n4", kind: "scene", sceneId: sceneIds.pause, bonus: 0, resetOnEntry: true, grantIncome: false, stopsRun: false, x: 840, y: 0 },
    { id: "n5", kind: "scene", sceneId: sceneIds.hotel2, bonus: 0, resetOnEntry: true, grantIncome: true, stopsRun: false, x: 1120, y: 0 },
    { id: "n6", kind: "final", sceneId: null, bonus: 50, resetOnEntry: true, grantIncome: false, stopsRun: false, x: 1400, y: 0 },
    { id: "x1", kind: "exit", sceneId: null, bonus: 0, resetOnEntry: true, grantIncome: false, stopsRun: false, x: 840, y: 200 },
  ],
  edges: [
    { id: "e1", from: "n1", to: "n2", priority: 1, conditions: [], label: "переписка — на свидание" },
    { id: "e2", from: "n2", to: "n3", priority: 1, conditions: [{ type: "relation", whoseId: yana.id, toId: sasha.id, op: ">=", value: 4 }], label: "Яна доверяет (≥4) — отель" },
    { id: "e3", from: "n2", to: "x1", priority: 2, conditions: [], label: "не сложилось" },
    { id: "e4", from: "n3", to: "n4", priority: 1, conditions: [{ type: "step", toolName: "have_sex", argContains: "Яна", characterId: sasha.id }], label: "первая близость была" },
    { id: "e5", from: "n3", to: "x1", priority: 2, conditions: [], label: "вечер закончился иначе" },
    { id: "e6", from: "n4", to: "n5", priority: 1, conditions: [{ type: "state", key: "skill_sex", op: ">=", value: 2, characterId: sasha.id }], label: "Саша выучился (навык ≥ 2) — второй шанс" },
    { id: "e6b", from: "n4", to: "n5", priority: 1, conditions: [{ type: "step", toolName: "shop_buy", argContains: "Искусство любви", characterId: sasha.id }], label: "купил курс — второй шанс" },
    { id: "e6c", from: "n4", to: "n5", priority: 1, conditions: [{ type: "step", toolName: "shop_buy", argContains: "тантры", characterId: sasha.id }], label: "купил мастер-класс — второй шанс" },
    { id: "e7", from: "n4", to: "x1", priority: 2, conditions: [{ type: "state", key: "frustration", op: ">=", value: 3, characterId: yana.id }], label: "фрустрация Яны ≥ 3 — разрыв" },
    { id: "e8", from: "n5", to: "n6", priority: 1, conditions: [{ type: "outcome", toolName: "have_sex", outcomeId: "climax", characterId: sasha.id }], label: "кульминация случилась — финал" },
    { id: "e9", from: "n5", to: "x1", priority: 2, conditions: [{ type: "state", key: "frustration", op: ">=", value: 3, characterId: yana.id }], label: "опять не то — разрыв" },
    { id: "e10", from: "n5", to: "x1", priority: 3, conditions: [], label: "без кульминации — разошлись" },
  ],
};
if (flow) {
  await api(`/api/flows/${flow.id}`, "PATCH", { name: flow.name, description: "Кейс пользователя: оргазм как условие серьёзных отношений", graph });
} else {
  flow = await api("/api/flows", "POST", { name: "Кейс2: она ждёт близости", description: "Кейс пользователя: оргазм как условие серьёзных отношений", graph });
}
log(`флоу id=${flow.id}`);

// ---------- 8. Прогон ----------
const run = await api(`/api/flows/${flow.id}/runs`, "POST", { characterIds: [sasha.id, yana.id] });
log(`\n=== ПРОГОН #${run.id} ЗАПУЩЕН ===`);

const deadline = Date.now() + 45 * 60 * 1000;
let lastNode = "";
while (Date.now() < deadline) {
  await sleep(15000);
  const { report } = await api(`/api/flow-runs/${run.id}`);
  const at = report.characters.map((c) => `${c.name}: ${c.status}${c.visits.length ? ` (сцен: ${c.visits.length}, скор ${c.score})` : ""}`).join(" | ");
  if (at !== lastNode) {
    log(`[${new Date().toLocaleTimeString("ru-RU")}] ${at}`);
    lastNode = at;
  }
  if (report.run.status !== "running") break;
}

// ---------- 9. Отчёт ----------
const { report } = await api(`/api/flow-runs/${run.id}`);
log(`\n=== ИТОГ ПРОГОНА #${run.id}: ${report.run.status} ===`);
for (const c of report.characters) {
  log(`${c.emoji} ${c.name}: статус=${c.status}, скор=${c.score}, бонус=${c.bonus}, всего=${c.total}`);
  log(`  отношения: ${c.relations.map((r) => `${r.name}=${r.value}`).join(", ") || "—"}`);
}
const chem = await api("/api/chemistry");
const pair = chem.find((c) => (c.aId === sasha.id && c.bId === yana.id) || (c.aId === yana.id && c.bId === sasha.id));
log(`химия пары: ${pair?.value ?? 0}`);

const sashaFinal = await api(`/api/characters/${sasha.id}`);
const yanaFinal = await api(`/api/characters/${yana.id}`);
log(`Саша: skill_sex=${sashaFinal.state.skill_sex ?? 0}, money=${sashaFinal.state.money}, worn_underwear="${sashaFinal.state.worn_underwear ?? ""}"`);
log(`Яна: mood=${yanaFinal.state.mood ?? "?"}, frustration=${yanaFinal.state.frustration ?? 0}, worn_underwear="${yanaFinal.state.worn_underwear ?? ""}"`);

log("\n=== КЛЮЧЕВЫЕ СОБЫТИЯ ===");
const sceneOrder = [];
for (const c of report.characters[0].visits) sceneOrder.push({ id: c.sceneId, title: c.nodeTitle });
const names = { [sasha.id]: "Саша", [yana.id]: "Яна" };
for (const s of sceneOrder) {
  if (s.id == null) continue;
  const events = await api(`/api/scenes/${s.id}/events`);
  log(`\n--- ${s.title} ---`);
  for (const ev of events) {
    const who = ev.actorId != null ? names[ev.actorId] ?? `#${ev.actorId}` : "мир";
    if (ev.type === "action") {
      for (const call of ev.payload.calls ?? []) {
        const oc = call.outcome ? ` [ИСХОД: ${call.outcome}]` : "";
        log(`  ${call.ok ? "✓" : "✗"} ${who}: ${call.toolName}${oc}`);
      }
    } else if (ev.type === "director") {
      log(`  💬 ${who}: ${(ev.payload.text ?? "").slice(0, 140)}`);
    } else if (ev.type === "system" && (ev.payload.message ?? "").includes("Практика")) {
      log(`  📈 ${(ev.payload.message ?? "").slice(0, 120)}`);
    }
  }
}
