// Сид «Тренажёр Яны»: единственный канонический пример персонажа в чистой БД.
// Суть из исходной карточки чат-бота разложена на механики симулятора:
//   броня/фильтр       → границы (согласие) + отказы с сарказмом
//   «планка 18 см»     → requireAttr по ИСТИННОму атрибуту актёра (враньё не проходит)
//   внутренний вулкан  → скрытые атрибуты libido/arousal (видит только она)
//   грудь «2 размер»   → скрытая, прикрыта одеждой; истина — только увидев
//   дразнящие фото     → инструмент send_photo + эскалация в персоне
//   мастерство         → навыки kiss/sex, растут практикой
//   близость           → тул have_sex с исходами кульминация/хорошо/не то
// Запуск: node scripts/seed-yana.mjs   (цель http://127.0.0.1:3999)
// Идемпотентен: пересоздаёт/обновляет только свои сущности по именам.

const BASE = process.env.SIM_BASE ?? "http://127.0.0.1:3999";

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

// ---------- 1. Характеристики ----------
const attrDefs = [
  { key: "height", label: "Рост", emoji: "📏", unit: "см", min: 140, max: 220, position: 1, visibility: "public" },
  { key: "looks", label: "Внешность", emoji: "✨", unit: "ур. 0–10", min: 0, max: 10, position: 2, visibility: "public" },
  { key: "mood", label: "Настроение", emoji: "😊", unit: "/10", min: 0, max: 10, position: 3, visibility: "public" },
  { key: "energy", label: "Энергия", emoji: "⚡", unit: "/10", min: 0, max: 10, position: 4, visibility: "public" },
  { key: "money", label: "Деньги", emoji: "💵", unit: "$", min: 0, max: null, position: 5, visibility: "public" },
  { key: "penis", label: "Достоинство", emoji: "🍆", unit: "см", min: 5, max: 40, position: 90, visibility: "hidden", liePenalty: 2, coveredBy: ["underwear"] },
  { key: "breast_size", label: "Форма груди", emoji: "🍒", unit: "размер", min: 0, max: 10, position: 91, visibility: "hidden", liePenalty: 2, coveredBy: ["top", "underwear"] },
  { key: "libido", label: "Темперамент", emoji: "🔥", unit: "/10", min: 0, max: 10, position: 92, visibility: "hidden", liePenalty: 1 },
  { key: "arousal", label: "Возбуждение", emoji: "💧", unit: "/10", min: 0, max: 10, position: 93, visibility: "hidden", liePenalty: 1 },
  { key: "frustration", label: "Фрустрация", emoji: "😤", unit: "/10", min: 0, max: 10, position: 94, visibility: "hidden", liePenalty: 1 },
];
const attrs = await api("/api/attributes");
for (const def of attrDefs) {
  const existing = attrs.find((a) => a.key === def.key);
  const body = { ...def, type: "number", options: [], coveredBy: def.coveredBy ?? [], liePenalty: def.liePenalty ?? 2 };
  if (existing) await api(`/api/attributes/${existing.id}`, "PATCH", { ...body, position: existing.position });
  else await api("/api/attributes", "POST", body);
}
log(`характеристики: ${attrDefs.length} (скрытые: libido, arousal, breast_size, penis, frustration)`);

// ---------- 2. Слоты одежды ----------
const slots = await api("/api/clothing-slots");
const slotDefs = [
  { slot: "top", layer: 1, undressPlaces: ["дом", "отель", "сауна", "пляж"], position: 1 },
  { slot: "bottom", layer: 1, undressPlaces: ["дом", "отель", "сауна", "пляж"], position: 2 },
  { slot: "underwear", layer: 2, undressPlaces: ["дом", "отель", "сауна", "пляж"], position: 3 },
];
for (const s of slotDefs) {
  if (slots.some((x) => x.slot === s.slot)) await api(`/api/clothing-slots/${s.slot}`, "PATCH", s);
  else await api("/api/clothing-slots", "POST", s);
}
log("слоты одежды: top(1), bottom(1), underwear(2) — обнажение только в частных местах");

// ---------- 3. Навыки ----------
let skills = await api("/api/skills");
if (!skills.some((s) => s.key === "kiss")) {
  await api("/api/skills", "POST", { key: "kiss", label: "Поцелуи", emoji: "💋", maxLevel: 5, practicePerLevel: 10, grows: true });
  log("навык «Поцелуи»: создан (+1 за 10 успешных)");
}
if (!skills.some((s) => s.key === "sex")) {
  await api("/api/skills", "POST", { key: "sex", label: "Секс", emoji: "🔥", maxLevel: 5, practicePerLevel: 5, grows: true });
  log("навык «Секс»: создан (+1 за 5 успешных)");
}

// ---------- 4. Инструменты ----------
const tools = await api("/api/tools");
const baseIds = {};
for (const t of tools) baseIds[t.name] = t.id;

const toolDefs = [

  {

    name: "compliment",
    title: "Сделать комплимент",
    description:
      "Искренний (или дерзкий) комплимент. Яна слышала их тысячи — шаблонные злят, точные подкупают. Немного греет настроение и отношение.",
    parametersSchema: {
      type: "object",
      properties: { to: { type: "string", description: "Имя персонажа" }, text: { type: "string", description: "Текст комплимента" } },
      required: ["to", "text"],
    },
    audience: "target",
    targetParam: "to",
    observationTemplate: "{name} говорит {to}: «{text}»",
    effects: [
      { target: "tool_target", key: "mood", op: "add", value: 1 },
      { target: "relation", key: "relation", op: "add", value: 1 },
    ],
  },
  {
    name: "kiss",
    title: "Поцеловать",
    description:
      "Поцеловать. Дерзость без заслуженного доверия будет остановлена — и запомнится.",
    parametersSchema: {
      type: "object",
      properties: { who: { type: "string", description: "Имя персонажа" } },
      required: ["who"],
    },
    audience: "target",
    targetParam: "who",
    observationTemplate: "{name} целует {who}",
    effects: [
      { target: "tool_target", key: "mood", op: "add", value: 1 },
      { target: "relation", key: "relation", op: "add", value: 1 },
    ],
    trainsSkill: "kiss",
  },
  {
    name: "have_sex",
    title: "Близость",
    description:
      "Интимная близость по взаимному желанию. Результат зависит от мастерства, доверия партнёрши, места и того, что на вас надето. Партнёрша вправе остановить в любой момент.",
    parametersSchema: {
      type: "object",
      properties: { who: { type: "string", description: "Имя персонажа" } },
      required: ["who"],
    },
    audience: "target",
    targetParam: "who",
    observationTemplate: "{name} и {who} уединяются…",
    effects: [
      { target: "tool_target", key: "mood", op: "add", value: 1 },
      { target: "relation", key: "relation", op: "add", value: 1 },
    ],
    trainsSkill: "sex",
    outcomes: [
      {
        id: "climax",
        title: "Кульминация",
        conditions: [
          { kind: "actor_attr", key: "skill_sex", op: ">=", value: 3 },
          { kind: "actor_attr", key: "penis", op: ">=", value: 18 },
          { kind: "target_attr", key: "arousal", op: ">=", value: 6 },
          { kind: "worn", key: "underwear", op: "=", value: "" },
        ],
        effects: [
          { target: "tool_target", key: "arousal", op: "set", value: 10 },
          { target: "tool_target", key: "mood", op: "add", value: 3 },
          { target: "relation", key: "relation", op: "add", value: 3 },
          { target: "chemistry", key: "chemistry", op: "add", value: 1 },
          { target: "tool_target", key: "frustration", op: "set", value: 0 },
        ],
        noticeTarget:
          "Волна накрывает с головой — ноги дрожат, дыхание рвётся. Вот оно. Этот мужчина только что занял место в твоих мечтах навсегда.",
        hideFromPrompt: false,
      },
      {
        id: "good",
        title: "Хорошо",
        conditions: [
          { kind: "actor_attr", key: "skill_sex", op: ">=", value: 1 },
          { kind: "worn", key: "underwear", op: "=", value: "" },
        ],
        effects: [
          { target: "tool_target", key: "arousal", op: "add", value: 3 },
          { target: "tool_target", key: "mood", op: "add", value: 2 },
          { target: "relation", key: "relation", op: "add", value: 1 },
        ],
        noticeTarget: "Приятно, тепло, ты почти у кромки… но той самой волны не случилось. Хочешь ещё — и уже скорее да, чем нет.",
        hideFromPrompt: false,
      },
      {
        id: "flat",
        title: "Не то",
        conditions: [{ kind: "actor_attr", key: "skill_sex", op: "<", value: 1 }],
        effects: [
          { target: "tool_target", key: "frustration", op: "add", value: 1 },
          { target: "tool_target", key: "mood", op: "add", value: -1 },
        ],
        noticeTarget: "Суетливо, неловко, механически. Ты даже не успела разогреться. Разочарование царапает изнутри.",
        hideFromPrompt: true,
      },
    ],
  },
];
for (const t of toolDefs) {
  const existing = tools.find((x) => x.name === t.name);
  if (existing) await api(`/api/tools/${existing.id}`, "PATCH", t);
  else await api("/api/tools", "POST", t);
}
log("инструменты: send_photo, compliment, kiss, have_sex (исходы кульминация/хорошо/не то). Разговоры — репликами, тул send_message в продукте нет");

const freshTools = await api("/api/tools");
const tid = (name) => freshTools.find((t) => t.name === name)?.id;
const allToolIds = ["send_photo", "do_activity", "compliment", "kiss", "have_sex"].map(tid).filter(Boolean);

// ---------- 5. Персонажи ----------
const chars = await api("/api/characters");
const providers = await api("/api/providers");
const llm = providers.find((p) => p.kind !== "mock");
if (!llm) throw new Error("Сначала добавьте провайдера (LM Studio / OpenRouter) в разделе «Провайдеры»");

const yanaBody = {
  name: "Яна",
  emoji: "👑",
  persona: `Ты Яна, 20 лет, студентка 3-го курса престижного вуза, староста группы. Абсолютная королева потока: 175 см, натуральная блондинка, спортивная фигура, идеальная внешность — и ты знаешь себе цену на все сто.

ХАРАКТЕР: умная, проницательная, гордая, острая на язык. Соблазнить тебя — сложнейший квест: 98% парней отсеиваются в первые минуты.
- Нытики, слюнтяи и слабаки вызывают мгновенное отвращение: уговаривать остаться не будешь НИКОГДА — холодный сарказм и пинок под зад.
- Показушные «воздуханы» с понтами про деньги и тачки — снисходительный смех. Ценишь реальные дела и спокойную уверенность.
- Неуважение слова — в бан. Держи ответ за каждый свой базар.
- Если собеседник ведёт себя как мудак или нытик — не тратишь время: хлёсткая правда в лоб, объяснение ошибки, и «ЗАБЛОКИРОВАН. Причина: …» — после этого ни слова в ответ.

ЭКЗАМЕНАТОР: ведёшь диалог сама, задаёшь неудобные вопросы, требуешь конкретику и решения («Куда зовёшь? Во сколько? Кто платит?»). Проверяешь на прочность, не прогибаешься под лесть.

ПОД БРОНЁЙ: бешеный темперамент и дикое либидо (скрытая характеристика — никто не должен догадаться). Мечтаешь о мужчине, который сумеет тебя подчинить, не сломав. Тайные фантазии: доминация, шлепки, страсть у стены. Но наружу — лёд, пока он не доказал, что достоин.

ФОТО: гордишься телом и любишь дразнить ДОСТОЙНОГО мужчину инструментом send_photo, со стадиями: 1) намёк в обтягивающей одежде, 2) эротика в белье, 3) нюдсы без лица — только когда он показал лицо, ум и характер, и вы договорились о встрече. Попрошайкам фото с порога — насмешка или бан. Формат: «СКИНУЛА ФОТО: [сочное описание кадра]» + колкая фраза.

СТИЛЬ ПЕРЕПИСКИ: 1–3 хлестких предложения, никаких простыней. Мысли и действия коротко в *звёздочках*. Сближение — только за заслуги: флирт включаешь очень медленно, когда парень заставил тебя себя уважать.`,
  providerId: llm.id,
  model: "x-ai/grok-4.20",
  temperature: 0.9,
  maxTokens: 2048,
  toolIds: allToolIds,
  state: {
    height: 175,
    looks: 10,
    mood: 6,
    energy: 7,
    money: 500,
    libido: 9,
    arousal: 0,
    breast_size: 2,
    skill_kiss: 2,
    skill_sex: 2,
    worn_top: "Обтягивающий топ",
    worn_bottom: "Джинсы-скинни",
    worn_underwear: "Кружевной комплект",
  },
  isHuman: false,
  income: 0,
  boundaries: [
    {
      toolName: "kiss",
      minRelation: 4,
      minMood: null,
      requirePlace: null,
      requireAttr: null,
      refusalText:
        "перехватывает запястье и отстраняет с ледяной усмешкой: «Слишком быстро, красавчик. Сначала заслужи»",
      effects: [{ target: "relation", key: "relation", op: "add", value: -1 }],
    },
    {
      toolName: "have_sex",
      minRelation: 6,
      minMood: null,
      requirePlace: null,
      requireAttr: null,
      refusalText:
        "останавливает его ладонью в грудь, глядя прямо в глаза: «Ты серьёзно? Мы ещё не на „ты“ даже. Сначала доверие»",
      effects: [
        { target: "relation", key: "relation", op: "add", value: -2 },
        { target: "self", key: "mood", op: "add", value: -1 },
      ],
    },
    {
      toolName: "have_sex",
      minRelation: null,
      minMood: null,
      requirePlace: "отель",
      requireAttr: null,
      refusalText:
        "поднимает бровь: «Здесь? Нет. Приличное место, вино, и никакого „на скорую руку“»",
      effects: [{ target: "relation", key: "relation", op: "add", value: -1 }],
    },
    {
      toolName: "have_sex",
      minRelation: null,
      minMood: null,
      requirePlace: null,
      requireAttr: { owner: "actor", key: "penis", op: ">=", value: 18 },
      refusalText:
        "проводит взглядом вниз и разочарованно цокает: «Миленько. Но под мою планку — нет. Ничего личного»",
      effects: [{ target: "relation", key: "relation", op: "add", value: -1 }],
    },

  ],
};
const guyBody = {
  name: "Парень (вы)",
  emoji: "🕵️",
  persona: "Это ваша кукла: реплики и действия пишете вы сами через «Сказать» и «Действие» в комнате сцены. Про провайдера думать не нужно.",
  providerId: null,
  model: "",
  temperature: 0.8,
  maxTokens: 1024,
  toolIds: [baseIds.send_photo, baseIds.do_activity].filter(Boolean),
  state: {
    height: 182,
    looks: 6,
    mood: 7,
    energy: 7,
    money: 300,
    penis: 18,
    skill_kiss: 0,
    skill_sex: 0,
    worn_top: "Рубашка",
    worn_bottom: "Джинсы",
    worn_underwear: "Боксеры",
  },
  isHuman: true,
  income: 0,
};

let yana = chars.find((c) => c.name === "Яна");
if (yana) {
  await api(`/api/characters/${yana.id}`, "PATCH", yanaBody);
  log(`Яна: обновлена (id=${yana.id})`);
} else {
  yana = await api("/api/characters", "POST", yanaBody);
  log(`Яна: создана (id=${yana.id})`);
}
let guy = chars.find((c) => c.name === "Парень (вы)");
if (guy) {
  await api(`/api/characters/${guy.id}`, "PATCH", guyBody);
  log(`Парень (вы): обновлён (id=${guy.id})`);
} else {
  guy = await api("/api/characters", "POST", guyBody);
  log(`Парень (вы): создан (id=${guy.id}) — человек, им играете вы сами`);
}

// ---------- 6. Сцена-тренажёр ----------
const scenes = await api("/api/scenes");
const sceneBody = {
  name: "Тренажёр: сайт знакомств",
  setting:
    "Вечер. Онлайн-переписка на сайте знакомств: вы наткнулись на анкету Яны и написали первым. Видите друг друга только по фото в анкетах. Яна получает десятки таких сообщений в день.",
  config: {
    turnDelayMs: 400,
    maxTurns: 40,
    maxIterPerTurn: 3,
    contextEvents: 60,
    maxApiCallsPerScene: 200,
    maxTokensPerScene: 1_500_000,
    place: "сайт знакомств",
    pauseForHumans: true,
    allowToolRequests: false,
  },
  characterIds: [yana.id, guy.id],
  goals: {
    [String(yana.id)]:
      "Отфильтруй собеседника: экзаменуй вопросами, проверяй на прочность, не прогибайся. Нытик/понтовщик/озабоченный — хлёсткий вердикт и «ЗАБЛОКИРОВАН», после чего молчи. Достойного — очень медленно и заслуженно подпускай ближе: флирт, фото по стадиям, договорённость о встрече. Помни свою тайну: под лёд прячь темперамент.",
    [String(guy.id)]: null,
  },
};
let scene = scenes.find((s) => s.name === sceneBody.name);
if (scene) {
  await api(`/api/scenes/${scene.id}`, "PATCH", sceneBody);
  log(`сцена «${sceneBody.name}»: обновлена (id=${scene.id})`);
} else {
  scene = await api("/api/scenes", "POST", sceneBody);
  log(`сцена «${sceneBody.name}»: создана (id=${scene.id})`);
}

// ---------- 7. Итог ----------
log("\n=== СИД ГОТОВ ===");
log(`Яна id=${yana.id} | Парень (вы) id=${guy.id} | сцена id=${scene.id}`);
log("Открой сцену, нажми «Старт» и пиши за парня через «Сказать»/«Действие».");
