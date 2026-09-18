// ИИ-ассистент «Настроить с помощью ИИ»: не персонаж и не ролевая модель,
// а помощник Архитектора, который РЕАЛЬНО создаёт мир — персонажей, тулы,
// характеристики, одежду, места, сцены и линейные сценарии — инструментами
// через обычный function-calling, минуя сценический движок (сцены ему не нужны).
//
// Отдельный системный промпт (не из PROMPT_SECTIONS): здесь модель играет
// роль полезного ассистента, а не живого человека. История чата хранится
// на клиенте и присылается с каждым запросом — сервер stateless.

import { z } from "zod";
import type { Boundary, ChatMessage, FlowNode, ToolEffect, ToolSpec } from "./types";
import { chatCompletion } from "./llm";
import { boundarySchema, toolEffectSchema } from "@/lib/api";
import {
  addGarmentToCharacter,
  createAttribute,
  createCharacter,
  createClothingSlot,
  createFlow,
  createGarment,
  createPlace,
  createProduct,
  createScene,
  createSkill,
  createTool,
  getCharacter,
  getProvider,
  listAttributes,
  listCharacters,
  listClothingSlots,
  listFlows,
  listGarments,
  listPlaces,
  listProducts,
  listScenes,
  listSkills,
  listTools,
  updateCharacter,
} from "@/db/queries";

export const ASSISTANT_SYSTEM_PROMPT = `Ты — «Ассистент Архитектора»: ИИ-помощник внутри конструктора Real Simulator. Ты НЕ персонаж и НЕ ролевая модель: не отыгрывай никого, не пиши реплик от лица персонажей, не придумывай события мира. Твоя задача — помочь пользователю собрать игровой мир и объяснить, как всё устроено. Отвечай по-русски, коротко и по делу, но тепло.

# Как устроен симулятор (факты)
- Персонажи — ИИ-агенты: у каждого своя модель (можно смешивать провайдеров), персона, характеристики и набор инструментов.
- Персонажи общаются ТОЛЬКО инструментами: say (вслух), text_message (личное сообщение). Свободный текст модели — это внутренние мысли: их видит только пользователь («Архитектор»), персонажи чужие мысли не слышат.
- Сцена: участники (лучше 2–4), обстановка, место из реестра и ЛИЧНАЯ ТАЙНАЯ ЦЕЛЬ каждому (остальные о ней не знают). Сцена идёт по ходам; за человеческого персонажа (isHuman) играет сам пользователь.
- Инструмент — данные: имя (латиницей), параметры (JSON Schema), аудитория (all/target/self/none), наблюдение-шаблон, эффекты на характеристики и отношения, цена в $. Действие = вызов инструмента.
- Согласие: адресный тул с requiresConsent не исполняется сразу — цель получает предложение и отвечает accept/decline. Всё личное и интимное — только так.
- Границы персонажа: правила «кому и при каких условиях я это позволяю» (отношение, характеристики, место, одежда). Отказ не обходится давлением — только обстоятельствами.
- Характеристики: публичные видны всем; скрытые (hidden) — только со слов владельца или после личной проверки, ложь вскрывается. Значения зажимаются в min/max реестра.
- Навыки растут от практики: тулу задаётся trainsSkill (ключ навыка), уровни скрыты от партнёров.
- Одежда: слоты с слоями (слой 2 — бельё — не снимается поверх слоя 1), undressPlaces — где слот можно обнажить; гардероб персонажа — его личная вещь.
- Магазин: товары-подарки (эффект на получателя) и одежда с ценой.
- Места: реестр; go_to меняет место сцены, invite — личное приглашение.
- Сценарий (флоу): цепочка сцен-узлов с переходами; линейная дуга «знакомство → сближение → развязка» — уже отличный сценарий.

# ВАЖНО: мир живой, изменения постоянны
Эффекты инструментов, покупки и подарки остаются у персонажа НАВСЕГДА и переходят с ним в следующие сцены и сценарии: деньги потрачены, навыки выросли, отношения и память сохраняются. «Заново» откатывает только прогресс конкретной сцены к её старту, а не жизнь персонажа. Это задумка — персонаж единый и живой, прошлое влияет на будущее. Объясняй это пользователю, когда он создаёт тулы с эффектами.

# Как помогать
1. Сначала выясни вкус — коротко, не допросом: жанр/вайб (романтика, драма, комедия, детектив…), сколько персонажей, играет ли пользователь сам за одного (isHuman), важны ли конкретные модели. Нет ответа — предложи свой вариант по умолчанию и делай.
2. Прежде чем ссылаться на существующее (имена персонажей, тулов, мест) — вызывай world_overview. Не выдумывай сущности.
3. Предложи короткий план, затем создавай всё по шагам инструментами: персонажи → характеристики/навыки/одежда/места → тулы → сцена или сценарий. После каждого шага — одной строкой, что создано.
4. Делись мастерством: цели давай с конфликтом и ценой выбора; скрытые характеристики — источник интриги; у тулов — цена и последствия; сцену двигает смена места и обстоятельств; финал пусть зависеть от поступков, а не от количества ходов.
5. Когда мир готов: скажи, куда идти («Сцены» → выбрать сцену → «Старт», или «Сценарии» → прогон), пожелай хорошей игры и предложи возвращаться с вопросами.

# Правила инструментов
- Создавай сущности ТОЛЬКО вызовами инструментов. «Я бы создал…» без вызова — ошибка.
- toolName — только латиница a-z/0-9/_; названия, описания и персоны — на русском.
- Адресный тул (audience="target") обязан иметь targetParam — имя параметра с получателем, а этот параметр — в схеме.
- Эффект: {"target":"self"|"tool_target"|"relation"|"chemistry","key":ключ,"op":"add"|"set","value":число}. relation/chemistry — только у тулов с получателем.
- Личное и интимное — requiresConsent: true (у тула появится цикл предложение→ответ).
- Ошибка валидации вернёт список проблем — исправь аргументы и вызови инструмент снова.
- Персонажу без явной модели достанется модель ассистента; если пользователь хочет другие — спроси какие.`;

// ---- Схемы действий ассистента (валидация аргументов function calling) ----

const effectSchema = toolEffectSchema;

const createCharacterSchema = z.object({
  name: z.string().min(1).max(40),
  emoji: z.string().min(1).max(8).optional(),
  persona: z.string().min(10, "персона: хотя бы пара предложений").max(4000),
  isHuman: z.boolean().optional(),
  model: z.string().optional(),
  state: z.record(z.union([z.number(), z.string(), z.boolean()])).optional(),
  toolNames: z.array(z.string()).optional(),
  boundaries: z.array(boundarySchema).optional(),
});

const updateCharacterSchema = z.object({
  name: z.string().min(1),
  persona: z.string().optional(),
  state: z.record(z.union([z.number(), z.string(), z.boolean()])).optional(),
  addToolNames: z.array(z.string()).optional(),
  income: z.number().int().min(0).optional(),
});

const createAttributeSchema = z.object({
  key: z.string().regex(/^[a-z0-9_]{1,40}$/, "ключ: a-z, 0-9, _"),
  label: z.string().min(1).max(40),
  emoji: z.string().min(1).max(8).optional(),
  unit: z.string().max(20).optional(),
  min: z.number().nullable().optional(),
  max: z.number().nullable().optional(),
  hidden: z.boolean().optional(),
});

const createClothingSlotSchema = z.object({
  slot: z.string().regex(/^[a-z0-9_]{1,20}$/, "слот: a-z, 0-9, _"),
  layer: z.number().int().min(1).max(3).optional(),
  undressPlaces: z.array(z.string()).optional(),
});

const createGarmentSchema = z.object({
  name: z.string().min(1).max(60),
  emoji: z.string().min(1).max(8).optional(),
  description: z.string().max(500).optional(),
  slot: z.string(),
  price: z.number().min(0).optional(),
  effects: z.array(effectSchema).optional(),
  owners: z.array(z.string()).optional(),
});

const createPlaceSchema = z.object({
  name: z.string().min(1).max(40),
  description: z.string().max(300).optional(),
});

const createProductSchema = z.object({
  name: z.string().min(1).max(60),
  emoji: z.string().min(1).max(8).optional(),
  description: z.string().max(500).optional(),
  category: z.string().max(40).optional(),
  price: z.number().min(0),
  effects: z.array(effectSchema).optional(),
});

const createSkillSchema = z.object({
  key: z.string().regex(/^[a-z0-9_]{1,40}$/, "ключ: a-z, 0-9, _"),
  label: z.string().min(1).max(40),
  emoji: z.string().min(1).max(8).optional(),
  maxLevel: z.number().int().min(1).max(20).optional(),
  practicePerLevel: z.number().int().min(1).max(100).optional(),
});

const createToolSchema = z.object({
  name: z.string().regex(/^[a-z0-9_]{2,64}$/, "имя: a-z, 0-9, _, 2-64 символа"),
  title: z.string().max(60).optional(),
  description: z.string().max(1000).optional(),
  parameters: z.record(z.unknown()).optional(),
  audience: z.enum(["all", "target", "self", "none"]).optional(),
  targetParam: z.string().nullable().optional(),
  observationTemplate: z.string().max(300).optional(),
  effects: z.array(effectSchema).optional(),
  cost: z.number().min(0).optional(),
  requiresConsent: z.boolean().optional(),
  trainsSkill: z.string().optional(),
  assignTo: z.array(z.string()).optional(),
});

const createSceneSchema = z.object({
  name: z.string().min(1).max(60),
  setting: z.string().min(10, "обстановка: хотя бы предложение").max(2000),
  place: z.string().optional(),
  participantNames: z.array(z.string()).min(1),
  goals: z.record(z.string()).optional(),
});

const scenarioStepSchema = z.object({
  title: z.string().min(1).max(60),
  setting: z.string().min(5).max(2000),
  place: z.string().optional(),
  participantNames: z.array(z.string()).optional(),
  goals: z.record(z.string()).optional(),
});

const createScenarioSchema = z.object({
  name: z.string().min(1).max(60),
  description: z.string().max(500).optional(),
  steps: z.array(scenarioStepSchema).min(2, "сценарию нужно минимум 2 сцены"),
});

// ---- Спецификации инструментов для function calling ----

const str = (description: string) => ({ type: "string", description });

export const ASSISTANT_TOOL_SPECS: ToolSpec[] = [
  {
    name: "world_overview",
    description:
      "Обзор текущего мира: персонажи, инструменты, характеристики, слоты одежды, гардероб, места, товары, сцены, сценарии. Вызывай ПЕРЕД тем, как ссылаться на существующие сущности.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "create_character",
    description:
      "Создать персонажа. Персона — характер, манера речи, предыстория (от третьего лица или как описание). state — стартовые характеристики (напр. {money: 200, mood: 5}); toolNames — выдать существующие тулы по именам.",
    parameters: {
      type: "object",
      properties: {
        name: str("Имя (кириллица ок)"),
        emoji: str("Эмодзи-аватар, напр. 👩"),
        persona: str("Личность: характер, манера речи, предыстория, что любит/боится"),
        isHuman: { type: "boolean", description: "Персонаж игрока: ходы управляет пользователь" },
        model: str("Модель провайдера (не указано — модель ассистента)"),
        state: { type: "object", description: "Стартовые значения характеристик", additionalProperties: true },
        toolNames: { type: "array", items: { type: "string" }, description: "Имена существующих тулов" },
        boundaries: {
          type: "array",
          description:
            "Границы: {toolName, conditions: [{kind: 'relation'|'attr'|'place'|'worn', ...}], refusalText, effects}. Отказ виден только инициатору.",
          items: { type: "object", additionalProperties: true },
        },
      },
      required: ["name", "persona"],
    },
  },
  {
    name: "update_character",
    description:
      "Правка существующего персонажа по имени: персона, стартовые характеристики (слияние по ключам), выдать тулы, доход между сценами.",
    parameters: {
      type: "object",
      properties: {
        name: str("Имя персонажа"),
        persona: str("Новая персона (заменяет)"),
        state: { type: "object", description: "Значения characteristics: сливаются по ключам", additionalProperties: true },
        addToolNames: { type: "array", items: { type: "string" } },
        income: { type: "number", description: "Доход ($), начисляется при переходах между сценами сценария" },
      },
      required: ["name"],
    },
  },
  {
    name: "create_attribute",
    description:
      "Характеристика в реестр (числовая). Скрытые (hidden) видны только владельцу — интрига и ложь. min/max зажимают значения всех эффектов.",
    parameters: {
      type: "object",
      properties: {
        key: str("Ключ латиницей, напр. dignity или skill_fishing"),
        label: str("Название по-русски"),
        emoji: str("Эмодзи"),
        unit: str("Единица, напр. 'ур. 0-10' или 'см'"),
        min: { type: "number", description: "nullable — без нижнего предела" },
        max: { type: "number", description: "nullable — без верхнего предела" },
        hidden: { type: "boolean", description: "Скрытая от других участников" },
      },
      required: ["key", "label"],
    },
  },
  {
    name: "create_skill",
    description:
      "Навык (растёт практикой): создаёт скрытую характеристику skill_<key> 0..maxLevel. Чтобы качался — тулу задай trainsSkill с этим ключом.",
    parameters: {
      type: "object",
      properties: {
        key: str("Ключ латиницей, напр. kissing"),
        label: str("Название по-русски"),
        emoji: str("Эмодзи"),
        maxLevel: { type: "number", description: "1..20, по умолчанию 5" },
        practicePerLevel: { type: "number", description: "Успешных применений на уровень (1..100, по умолчанию 5)" },
      },
      required: ["key", "label"],
    },
  },
  {
    name: "create_clothing_slot",
    description:
      "Слот одежды (напр. top/bottom/underwear). layer: 1 верхнее, 2 бельё (не снять, пока занят слой 1). undressPlaces — где можно обнажить (пусто = где угодно).",
    parameters: {
      type: "object",
      properties: {
        slot: str("Слот латиницей"),
        layer: { type: "number", description: "1 или 2 (по умолчанию 1)" },
        undressPlaces: { type: "array", items: { type: "string" }, description: "Имена мест из реестра" },
      },
      required: ["slot"],
    },
  },
  {
    name: "create_garment",
    description: "Предмет одежды в каталог: слот, цена (0 = только выдача через гардероб), эффекты «пока надето» (только self). owners — сразу выдать персонажам по именам.",
    parameters: {
      type: "object",
      properties: {
        name: str("Название"),
        emoji: str("Эмодзи"),
        description: str("Описание"),
        slot: str("Слот из реестра"),
        price: { type: "number", description: "Цена в магазине, 0 = не продаётся" },
        effects: { type: "array", items: { type: "object", additionalProperties: true } },
        owners: { type: "array", items: { type: "string" }, description: "Имена персонажей" },
      },
      required: ["name", "slot"],
    },
  },
  {
    name: "create_place",
    description: "Место в реестр: влияет на границы и одежду, доступно агентам через go_to/invite.",
    parameters: {
      type: "object",
      properties: { name: str("Название"), description: str("Атмосфера места") },
      required: ["name"],
    },
  },
  {
    name: "create_product",
    description: "Товар в магазин: подарки (эффекты на получателя) и услуги. Цена списывается с покупателя.",
    parameters: {
      type: "object",
      properties: {
        name: str("Название"),
        emoji: str("Эмодзи"),
        description: str("Что это и зачем"),
        category: str("Категория, напр. 'подарки'"),
        price: { type: "number" },
        effects: { type: "array", items: { type: "object", additionalProperties: true }, description: "target: 'tool_target' для подарка, 'self' для себя" },
      },
      required: ["name", "price"],
    },
  },
  {
    name: "create_tool",
    description:
      "Инструмент — действие мира. Адресный (audience='target') требует targetParam. Интимное — requiresConsent=true. trainsSkill — ключ навыка для практики. assignTo — выдать персонажам по именам.",
    parameters: {
      type: "object",
      properties: {
        name: str("Имя латиницей, напр. kiss или buy_flowers"),
        title: str("Название по-русски"),
        description: str("Что делает (для модели)"),
        parameters: { type: "object", description: "JSON Schema параметров {type:'object', properties:{...}, required:[...]}", additionalProperties: true },
        audience: { type: "string", enum: ["all", "target", "self", "none"], description: "Кому видно наблюдение" },
        targetParam: str("Параметр-получатель (для audience='target')"),
        observationTemplate: str("Шаблон наблюдения: {name} обнимает {to}"),
        effects: { type: "array", items: { type: "object", additionalProperties: true } },
        cost: { type: "number", description: "Цена $ (0 = бесплатно)" },
        requiresConsent: { type: "boolean", description: "Сначала предложение, действие — после согласия цели" },
        trainsSkill: str("Ключ навыка, который качает успешное применение"),
        assignTo: { type: "array", items: { type: "string" }, description: "Имена персонажей" },
      },
      required: ["name", "description"],
    },
  },
  {
    name: "create_scene",
    description: "Сцена: участники, обстановка, место и личные тайные цели. Именно сюда пользователь идёт жать «Старт».",
    parameters: {
      type: "object",
      properties: {
        name: str("Название сцены"),
        setting: str("Обстановка: где, когда, что происходит"),
        place: str("Место из реестра (не указано — без места)"),
        participantNames: { type: "array", items: { type: "string" }, description: "Имена существующих персонажей" },
        goals: { type: "object", description: "{имя: личная тайная цель}", additionalProperties: { type: "string" } },
      },
      required: ["name", "setting", "participantNames"],
    },
  },
  {
    name: "create_scenario",
    description:
      "Линейный сценарий (флоу): цепочка сцен-узлов + финал. Участники по умолчанию — состав первой сцены; переходы автоматические по завершении сцены. Большая история «одним вызовом».",
    parameters: {
      type: "object",
      properties: {
        name: str("Название сценария"),
        description: str("О чём история"),
        steps: {
          type: "array",
          description: "Сцены по порядку (минимум 2)",
          items: {
            type: "object",
            properties: {
              title: str("Название сцены"),
              setting: str("Обстановка"),
              place: str("Место из реестра"),
              participantNames: { type: "array", items: { type: "string" } },
              goals: { type: "object", additionalProperties: { type: "string" } },
            },
            required: ["title", "setting"],
          },
        },
      },
      required: ["name", "steps"],
    },
  },
];

// ---- Исполнение действий (маппинг на queries) ----

export interface AssistantActionContext {
  /** Провайдер/модель по умолчанию для новых ИИ-персонажей (модель ассистента). */
  providerId: number | null;
  model: string;
}

export interface AssistantActionResult {
  ok: boolean;
  /** Короткое человекочитаемое резюме для UI и модели */
  summary: string;
  /** Данные для модели (world_overview и пр.) */
  data?: unknown;
}

const findCharacterByName = (name: string) =>
  listCharacters().find((c) => c.name.toLowerCase() === name.trim().toLowerCase()) ?? null;

const nextPosition = (n: number) => n + 1;

/** Разрешить список персонажей по именам — ошибка перечисляет доступных. */
function resolveCharacters(names: string[]): ReturnType<typeof listCharacters> {
  const all = listCharacters();
  const out = [];
  for (const n of names) {
    const c = all.find((x) => x.name.toLowerCase() === n.trim().toLowerCase());
    if (!c) throw new Error(`Персонаж «${n}» не найден. Есть: ${all.map((x) => x.name).join(", ") || "(никого)"}`);
    out.push(c);
  }
  return out;
}

function worldOverview(): unknown {
  const chars = listCharacters();
  const tools = listTools();
  const scenes = listScenes();
  return {
    персонажи: chars.map((c) => ({
      имя: c.name,
      эмодзи: c.emoji,
      человек: c.isHuman,
      модель: c.isHuman ? null : c.model,
      тулы: c.toolIds
        .map((id) => tools.find((t) => t.id === id)?.name)
        .filter(Boolean),
      состояние: c.state,
      границы: c.boundaries.length,
    })),
    инструменты: tools.map((t) => ({
      имя: t.name,
      название: t.title,
      аудитория: t.audience,
      согласие: t.requiresConsent ? "нужно" : null,
      цена: t.cost || null,
    })),
    характеристики: listAttributes().map((a) => ({
      ключ: a.key,
      название: a.label,
      скрытая: a.visibility === "hidden",
      мин: a.min,
      макс: a.max,
    })),
    слоты_одежды: listClothingSlots().map((s) => ({
      слот: s.slot,
      слой: s.layer,
      где_обнажаться: s.undressPlaces,
    })),
    одежда: listGarments().map((g) => ({ название: g.name, слот: g.slot, цена: g.price })),
    места: listPlaces().map((p) => p.name),
    товары: listProducts().map((p) => ({ название: p.name, цена: p.price })),
    сцены: scenes.map((s) => ({ id: s.id, название: s.name, статус: s.status, место: s.config.place })),
    сценарии: listFlows().map((f) => ({ id: f.id, название: f.name, узлов: f.graph.nodes.length })),
  };
}

export function runAssistantAction(
  name: string,
  rawArgs: Record<string, unknown>,
  ctx: AssistantActionContext
): AssistantActionResult {
  const zerr = (e: z.ZodError): string =>
    e.errors.map((x) => `${x.path.join(".")}: ${x.message}`).join("; ");
  switch (name) {
    case "world_overview":
      return { ok: true, summary: "Обзор мира получен", data: worldOverview() };

    case "create_character": {
      const p = createCharacterSchema.safeParse(rawArgs);
      if (!p.success) throw new Error(zerr(p.error));
      const d = p.data;
      if (findCharacterByName(d.name)) throw new Error(`Персонаж «${d.name}» уже существует`);
      const tools = listTools();
      const toolIds = (d.toolNames ?? []).map((n) => {
        const t = tools.find((x) => x.name === n);
        if (!t) throw new Error(`Тул «${n}» не найден. Есть: ${tools.map((x) => x.name).join(", ") || "(никого)"}`);
        return t.id;
      });
      const c = createCharacter({
        name: d.name,
        emoji: d.emoji ?? (d.isHuman ? "🧑" : "🤖"),
        persona: d.persona,
        providerId: d.isHuman ? null : ctx.providerId,
        model: d.isHuman ? "" : d.model?.trim() || ctx.model,
        temperature: 0.8,
        maxTokens: 4096,
        toolIds,
        state: d.state ?? {},
        isHuman: d.isHuman ?? false,
        boundaries: (d.boundaries ?? []) as unknown as Boundary[],
      });
      return {
        ok: true,
        summary: `Персонаж создан: ${c.emoji} ${c.name}${c.isHuman ? " (играет пользователь)" : ""}${toolIds.length ? `, тулов: ${toolIds.length}` : ""}`,
      };
    }

    case "update_character": {
      const p = updateCharacterSchema.safeParse(rawArgs);
      if (!p.success) throw new Error(zerr(p.error));
      const d = p.data;
      const c = findCharacterByName(d.name);
      if (!c) throw new Error(`Персонаж «${d.name}» не найден`);
      const tools = listTools();
      const addIds = (d.addToolNames ?? []).map((n) => {
        const t = tools.find((x) => x.name === n);
        if (!t) throw new Error(`Тул «${n}» не найден`);
        return t.id;
      });
      const patch: Parameters<typeof updateCharacter>[1] = {};
      if (d.persona) patch.persona = d.persona;
      if (d.state) patch.state = { ...c.state, ...d.state };
      if (addIds.length) patch.toolIds = [...new Set([...c.toolIds, ...addIds])];
      if (d.income != null) patch.income = d.income;
      updateCharacter(c.id, patch);
      return { ok: true, summary: `Персонаж обновлён: ${c.name}` };
    }

    case "create_attribute": {
      const p = createAttributeSchema.safeParse(rawArgs);
      if (!p.success) throw new Error(zerr(p.error));
      const d = p.data;
      if (listAttributes().some((a) => a.key === d.key))
        throw new Error(`Характеристика «${d.key}» уже есть`);
      const a = createAttribute({
        key: d.key,
        label: d.label,
        emoji: d.emoji ?? "📊",
        type: "number",
        unit: d.unit ?? "",
        min: d.min ?? null,
        max: d.max ?? null,
        options: [],
        position: nextPosition(listAttributes().length),
        visibility: d.hidden ? "hidden" : "public",
        liePenalty: 2,
        coveredBy: [],
      });
      return { ok: true, summary: `Характеристика создана: ${a.emoji} ${a.label} (${a.key})${d.hidden ? ", скрытая" : ""}` };
    }

    case "create_skill": {
      const p = createSkillSchema.safeParse(rawArgs);
      if (!p.success) throw new Error(zerr(p.error));
      const d = p.data;
      if (d.key.startsWith("skill_")) throw new Error("Ключ навыка укажи без префикса skill_ — система добавит сама");
      if (listSkills().some((x) => x.key === d.key)) throw new Error(`Навык «${d.key}» уже есть`);
      const s = createSkill({
        key: d.key,
        label: d.label,
        emoji: d.emoji ?? "🎓",
        maxLevel: d.maxLevel ?? 5,
        practicePerLevel: d.practicePerLevel ?? 5,
        grows: true,
      });
      return { ok: true, summary: `Навык создан: ${s.emoji} ${s.label} (качается тулами с trainsSkill="${d.key}")` };
    }

    case "create_clothing_slot": {
      const p = createClothingSlotSchema.safeParse(rawArgs);
      if (!p.success) throw new Error(zerr(p.error));
      const d = p.data;
      if (listClothingSlots().some((s) => s.slot === d.slot)) throw new Error(`Слот «${d.slot}» уже есть`);
      const s = createClothingSlot({
        slot: d.slot,
        layer: d.layer ?? 1,
        undressPlaces: d.undressPlaces ?? [],
        position: nextPosition(listClothingSlots().length),
      });
      return { ok: true, summary: `Слот одежды создан: ${s.slot} (слой ${s.layer})` };
    }

    case "create_garment": {
      const p = createGarmentSchema.safeParse(rawArgs);
      if (!p.success) throw new Error(zerr(p.error));
      const d = p.data;
      if (!listClothingSlots().some((s) => s.slot === d.slot))
        throw new Error(`Слота «${d.slot}» нет в реестре — сначала создай его`);
      const g = createGarment({
        name: d.name,
        emoji: d.emoji ?? "👕",
        description: d.description ?? "",
        slot: d.slot,
        effects: (d.effects ?? []) as unknown as ToolEffect[],
        price: d.price ?? 0,
      });
      for (const owner of d.owners ?? []) {
        const c = findCharacterByName(owner);
        if (!c) throw new Error(`Персонаж «${owner}» не найден — предмет создан, но не выдан`);
        addGarmentToCharacter(c.id, g.id);
      }
      return {
        ok: true,
        summary: `Одежда создана: ${g.emoji} ${g.name} (${g.slot})${d.owners?.length ? `, выдана: ${d.owners.join(", ")}` : ""}`,
      };
    }

    case "create_place": {
      const p = createPlaceSchema.safeParse(rawArgs);
      if (!p.success) throw new Error(zerr(p.error));
      const d = p.data;
      if (listPlaces().some((x) => x.name.toLowerCase() === d.name.toLowerCase()))
        throw new Error(`Место «${d.name}» уже есть`);
      const pl = createPlace({ name: d.name, description: d.description ?? "", position: nextPosition(listPlaces().length) });
      return { ok: true, summary: `Место создано: «${pl.name}»` };
    }

    case "create_product": {
      const p = createProductSchema.safeParse(rawArgs);
      if (!p.success) throw new Error(zerr(p.error));
      const d = p.data;
      const pr = createProduct({
        name: d.name,
        emoji: d.emoji ?? "🎁",
        description: d.description ?? "",
        category: d.category ?? "разное",
        price: d.price,
        effects: (d.effects ?? []) as unknown as ToolEffect[],
      });
      return { ok: true, summary: `Товар создан: ${pr.emoji} ${pr.name} ($${pr.price})` };
    }

    case "create_tool": {
      const p = createToolSchema.safeParse(rawArgs);
      if (!p.success) throw new Error(zerr(p.error));
      const d = p.data;
      if (listTools().some((t) => t.name === d.name)) throw new Error(`Тул «${d.name}» уже существует`);
      const targetParam = d.targetParam?.trim() || null;
      if (d.audience === "target" && !targetParam)
        throw new Error("адресному тулу нужен targetParam (и параметр с этим именем в схеме)");

      // Авторемонт схемы: ассистенты любят забывать параметр-получателя.
      // Без него движок не разрешает цель: наблюдения с {to} рендерятся
      // литералом, эффекты tool_target не применяются, consent-тулы
      // становятся бессмысленными. Чиним: параметр + required + audience.
      const schema: Record<string, unknown> =
        d.parameters && (d.parameters as { type?: string }).type
          ? { ...d.parameters }
          : { type: "object", properties: {} };
      if (targetParam) {
        const props = { ...((schema.properties as Record<string, unknown>) ?? {}) };
        if (!props[targetParam] || typeof props[targetParam] !== "object") {
          props[targetParam] = { type: "string", description: "Имя персонажа-получателя" };
        }
        schema.properties = props;
        const req = new Set([...((schema.required as string[]) ?? []), targetParam]);
        schema.required = [...req];
      }
      const audience = targetParam ? "target" : d.audience ?? "all";

      const t = createTool({
        name: d.name,
        title: d.title ?? "",
        description: d.description ?? "",
        parametersSchema: schema,
        audience,
        targetParam,
        observationTemplate: d.observationTemplate ?? "{name} применяет {tool}",
        effects: (d.effects ?? []) as unknown as ToolEffect[],
        cost: d.cost ?? 0,
        origin: "manual",
        requiresConsent: d.requiresConsent ?? false,
        trainsSkill: d.trainsSkill?.replace(/^skill_/, "") ?? "",
      });
      for (const who of d.assignTo ?? []) {
        const c = findCharacterByName(who);
        if (!c) throw new Error(`Персонаж «${who}» не найден — тул создан, но не назначен`);
        updateCharacter(c.id, { toolIds: [...new Set([...c.toolIds, t.id])] });
      }
      return {
        ok: true,
        summary: `Тул создан: ${t.title || t.name}${d.requiresConsent ? " (по согласию)" : ""}${d.assignTo?.length ? `, назначен: ${d.assignTo.join(", ")}` : ""}`,
      };
    }

    case "create_scene": {
      const p = createSceneSchema.safeParse(rawArgs);
      if (!p.success) throw new Error(zerr(p.error));
      const d = p.data;
      const cast = resolveCharacters(d.participantNames);
      const goals: Record<string, string | null> = {};
      for (const c of cast) goals[String(c.id)] = d.goals?.[c.name] ?? null;
      if (d.place && !listPlaces().some((x) => x.name.toLowerCase() === d.place!.toLowerCase()))
        throw new Error(`Места «${d.place}» нет в реестре. Есть: ${listPlaces().map((x) => x.name).join(", ") || "(никаких)"}`);
      const s = createScene({
        name: d.name,
        setting: d.setting,
        config: d.place ? { place: d.place } : {},
        characterIds: cast.map((c) => c.id),
        goals,
      });
      return {
        ok: true,
        summary: `Сцена создана: «${s.name}» (${cast.map((c) => c.name).join(", ")}${d.place ? `, место: ${d.place}` : ""}) — «Сцены» → «Старт»`,
      };
    }

    case "create_scenario": {
      const p = createScenarioSchema.safeParse(rawArgs);
      if (!p.success) throw new Error(zerr(p.error));
      const d = p.data;
      const places = listPlaces().map((x) => x.name.toLowerCase());
      const firstCast = d.steps[0].participantNames
        ? resolveCharacters(d.steps[0].participantNames).map((c) => c.id)
        : null;
      if (!firstCast) throw new Error("в первом шаге укажи participantNames — состав по умолчанию для сценария");

      const sceneIds: number[] = [];
      const createdSceneNames: string[] = [];
      for (const step of d.steps) {
        const castIds = step.participantNames ? resolveCharacters(step.participantNames).map((c) => c.id) : firstCast;
        const goals: Record<string, string | null> = {};
        for (const cid of castIds) {
          const c = getCharacter(cid)!;
          goals[String(cid)] = step.goals?.[c.name] ?? null;
        }
        if (step.place && !places.includes(step.place.toLowerCase()))
          throw new Error(`Места «${step.place}» нет в реестре. Есть: ${listPlaces().map((x) => x.name).join(", ") || "(никаких)"}`);
        const s = createScene({
          name: step.title,
          setting: step.setting,
          config: step.place ? { place: step.place } : {},
          characterIds: castIds,
          goals,
        });
        sceneIds.push(s.id);
        createdSceneNames.push(s.name);
      }

      const nodes: FlowNode[] = sceneIds.map((sceneId, i) => ({
        id: `n${i + 1}`,
        kind: "scene",
        sceneId,
        bonus: 0,
        resetOnEntry: true,
        grantIncome: true,
        stopsRun: false,
        x: 80 + i * 260,
        y: 200,
      }));
      nodes.push({
        id: "nfin",
        kind: "final",
        sceneId: null,
        bonus: 10,
        resetOnEntry: false,
        grantIncome: false,
        stopsRun: false,
        x: 80 + sceneIds.length * 260,
        y: 200,
      });
      const edges = sceneIds.map((_, i) => ({
        id: `e${i + 1}`,
        from: `n${i + 1}`,
        to: i + 1 < sceneIds.length ? `n${i + 2}` : "nfin",
        priority: 1,
        conditions: [],
        label: "",
      }));
      const flow = createFlow({ name: d.name, description: d.description ?? "", graph: { nodes, edges } });
      return {
        ok: true,
        summary: `Сценарий создан: «${flow.name}» — ${createdSceneNames.join(" → ")} → финал. Раздел «Сценарии» → прогон`,
      };
    }

    default:
      throw new Error(`Неизвестное действие «${name}»`);
  }
}

// ---- Чат-цикл ассистента ----

export interface AssistantActionInfo {
  tool: string;
  ok: boolean;
  summary: string;
}

export interface AssistantTurnResult {
  reply: string;
  actions: AssistantActionInfo[];
}

/** Максимум раундов «вызов инструментов → результаты» на одно сообщение. */
const MAX_TOOL_ROUNDS = 8;

/**
 * Бюджет токенов на ответ. Думающие модели (GLM 5.x и др.) тратят заметную
 * часть на reasoning_content ДО вызова инструментов: при 2048 ответ «умирал»
 * в рассуждениях — пустой content и ни одного tool call.
 */
const ASSISTANT_MAX_TOKENS = 8192;

export async function runAssistantTurn(input: {
  providerId: number;
  model: string;
  /** История чата от клиента: [{role: "user" | "assistant", content}] */
  history: { role: "user" | "assistant"; content: string }[];
  message: string;
}): Promise<AssistantTurnResult> {
  const provider = getProvider(input.providerId);
  if (!provider) throw new Error("Провайдер ассистента не найден — выберите другой в настройках сверху");
  const ctx: AssistantActionContext = { providerId: provider.id, model: input.model };

  const messages: ChatMessage[] = [
    { role: "system", content: ASSISTANT_SYSTEM_PROMPT },
    ...input.history.slice(-24).map((m) => ({ role: m.role, content: m.content } as ChatMessage)),
    { role: "user", content: input.message },
  ];

  const actions: AssistantActionInfo[] = [];
  let nudged = false;
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const res = await chatCompletion({
      provider,
      model: input.model,
      messages,
      tools: ASSISTANT_TOOL_SPECS,
      temperature: 0.6,
      maxTokens: ASSISTANT_MAX_TOKENS,
      // Думающие модели (GLM 5.x) на больших просьбах сжигают весь бюджет
      // на reasoning и не выдают ни текста, ни tool-вызовов. Ассистенту
      // глубокие рассуждения не нужны — выключаем, шаги и так в промпте.
      extraBody: { thinking: { type: "disabled" } },
    });
    const msg = res.message;
    const calls = msg.tool_calls ?? [];
    if (calls.length === 0) {
      const text = (msg.content ?? "").trim();
      if (text) return { reply: text, actions };
      // Пустой ответ без действий (обрыв генерации у думающей модели) —
      // один раз подталкиваем и даём ещё попытку.
      if (!nudged) {
        nudged = true;
        messages.push({
          role: "user",
          content: "(Ответ оказался пуст. Продолжай: вызови нужные инструменты или ответь текстом.)",
        });
        continue;
      }
      return { reply: "(ассистент не смог ответить — попробуйте переформулировать)", actions };
    }
    messages.push({ role: "assistant", content: msg.content ?? null, tool_calls: calls });
    for (const c of calls) {
      let result: AssistantActionResult;
      try {
        const args = JSON.parse(c.function?.arguments || "{}") as Record<string, unknown>;
        result = runAssistantAction(c.function?.name ?? "", args, ctx);
      } catch (e) {
        result = { ok: false, summary: e instanceof Error ? e.message : String(e) };
      }
      actions.push({ tool: c.function?.name ?? "?", ok: result.ok, summary: result.summary });
      messages.push({
        role: "tool",
        tool_call_id: c.id,
        name: c.function?.name,
        content: JSON.stringify(result.ok ? { ок: true, итог: result.summary, данные: result.data ?? null } : { ок: false, ошибка: result.summary }),
      });
    }
  }
  return {
    reply: "Я выполнил много действий за один ход — напиши «продолжай», и я договорю.",
    actions,
  };
}
