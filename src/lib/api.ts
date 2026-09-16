// Zod-схемы валидации входных данных API + хелперы ошибок.

import { NextResponse } from "next/server";
import { z } from "zod";
import { toolDraftPatchSchema } from "./toolRequests";

export const providerSchema = z.object({
  name: z.string().min(1, "Название обязательно"),
  kind: z.enum(["lmstudio", "openrouter", "openai-compatible", "mock"]),
  baseUrl: z.string().min(1, "URL обязателен"),
  apiKey: z.string().optional().default(""),
});

export const toolEffectSchema = z.object({
  target: z.enum(["self", "tool_target", "relation", "chemistry"]),
  key: z.string().min(1),
  op: z.enum(["set", "add"]),
  value: z.union([z.number(), z.string(), z.boolean(), z.null()]),
});

/** Условие исхода: истинные атрибуты/отношение/место/слот/химия. */
export const outcomeConditionSchema = z.object({
  kind: z.enum(["actor_attr", "target_attr", "relation", "place", "worn", "chemistry"]),
  key: z.string().default(""),
  op: z.enum([">=", "<", "="]).default(">="),
  value: z.union([z.number(), z.string()]),
});

/** Исход тула: условия («И») → эффекты + личная заметка цели. */
export const outcomeSchema = z.object({
  id: z.string().regex(/^[a-z0-9_]{1,24}$/, "id исхода: a-z, 0-9, _"),
  title: z.string().min(1, "Название исхода обязательно").max(60),
  conditions: z.array(outcomeConditionSchema).min(1, "Нужно хотя бы одно условие"),
  effects: z.array(toolEffectSchema).optional().default([]),
  noticeTarget: z.string().max(400).optional().default(""),
  hideFromPrompt: z.boolean().optional().default(false),
});

export const toolSchema = z.object({
  name: z
    .string()
    .regex(/^[a-z0-9_]{2,64}$/, "Только a-z, 0-9 и _, длина 2-64"),
  title: z.string().optional().default(""),
  description: z.string().optional().default(""),
  parametersSchema: z.record(z.unknown()).optional().default({}),
  audience: z.enum(["all", "target", "self", "none"]),
  targetParam: z.string().nullable().optional().default(null),
  observationTemplate: z.string().optional().default("{name} использует {tool}"),
  effects: z.array(toolEffectSchema).optional().default([]),
  cost: z.number().min(0).max(1_000_000).optional().default(0),
  trainsSkill: z.string().regex(/^[a-z0-9_]{0,24}$/).optional().default(""),
  outcomes: z.array(outcomeSchema).optional().default([]),
});

/** Требование на истинный атрибут в границе персонажа. */
const boundaryRequireAttrSchema = z.object({
  owner: z.enum(["actor", "target"]),
  key: z.string().min(1),
  op: z.enum([">=", "="]),
  value: z.number(),
});

/** Правило-граница персонажа (согласие на адресный инструмент). */
export const boundarySchema = z.object({
  toolName: z.string().min(1),
  minRelation: z.number().nullable().optional().default(null),
  minMood: z.number().nullable().optional().default(null),
  requirePlace: z.string().max(40).nullable().optional().default(null),
  requireAttr: boundaryRequireAttrSchema.nullable().optional().default(null),
  refusalText: z.string().min(1, "Текст отказа обязателен").max(300),
  effects: z.array(toolEffectSchema).optional().default([]),
});

export const characterSchema = z.object({
  name: z.string().min(1, "Имя обязательно"),
  emoji: z.string().optional().default("🙂"),
  persona: z.string().optional().default(""),
  providerId: z.number().int().positive().nullable().optional(),
  model: z.string().optional().default(""),
  temperature: z.number().min(0).max(2).optional().default(0.8),
  maxTokens: z.number().int().min(16).max(128000).optional().default(1024),
  toolIds: z.array(z.number().int().positive()).optional().default([]),
  state: z.record(z.unknown()).optional().default({}),
  isHuman: z.boolean().optional().default(false),
  income: z.number().min(0).max(1_000_000_000).optional().default(0),
  boundaries: z.array(boundarySchema).optional().default([]),
});

export const sceneConfigSchema = z.object({
  turnDelayMs: z.number().int().min(0).max(600000).optional(),
  maxTurns: z.number().int().min(0).max(100000).optional(),
  maxIterPerTurn: z.number().int().min(1).max(10).optional(),
  contextEvents: z.number().int().min(5).max(2000).optional(),
  rulesExtra: z.string().optional(),
  pauseForHumans: z.boolean().optional(),
  maxApiCallsPerScene: z.number().int().min(0).max(1000000).optional(),
  maxTokensPerScene: z.number().int().min(0).max(2000000000).optional(),
  allowToolRequests: z.boolean().optional(),
  place: z.string().max(40, "Место — до 40 символов").optional(),
});

export const saySchema = z.object({
  characterId: z.number().int().positive(),
  text: z.string().min(1, "Текст обязателен"),
});

export const actSchema = z.object({
  characterId: z.number().int().positive(),
  toolName: z.string().min(1),
  args: z.record(z.unknown()).optional().default({}),
});

export const sceneSchema = z.object({
  name: z.string().min(1, "Название обязательно"),
  setting: z.string().optional().default(""),
  config: sceneConfigSchema.optional().default({}),
  characterIds: z.array(z.number().int().positive()).min(1, "Нужен хотя бы один персонаж"),
  /** Привязка схем валидации: { [characterId]: schemaId | null } */
  schemas: z.record(z.number().int().positive().nullable()).optional(),
  /** Личные цели участников в этой сцене: { [characterId]: текст | null } */
  goals: z.record(z.string().nullable()).optional(),
});

export const controlSchema = z.object({
  action: z.enum(["start", "pause", "resume", "step", "stop"]),
});

export const validationStepSchema = z.object({
  toolName: z.string().min(1, "Выберите инструмент"),
  required: z.boolean().optional().default(true),
  points: z.number().min(0).max(1000).optional().default(10),
  minCount: z.number().int().min(1).max(100).optional().default(1),
  argContains: z.string().nullable().optional().default(null),
});

export const validationSchemaSchema = z.object({
  name: z.string().min(1, "Название обязательно"),
  description: z.string().optional().default(""),
  steps: z.array(validationStepSchema).optional().default([]),
  forbidden: z.array(z.string()).optional().default([]),
  penalty: z.number().min(0).max(1000).optional().default(0),
});

export const injectSchema = z.object({
  text: z.string().min(1, "Текст обязателен"),
  audience: z.union([z.literal("all"), z.array(z.number().int().positive())]),
});

// ---- Флоу: канвас сценариев ----

const characterIdRef = z.number().int().positive().nullable().optional().default(null);

export const flowConditionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("step"),
    toolName: z.string().min(1, "Выберите инструмент"),
    argContains: z.string().nullable().optional().default(null),
    characterId: characterIdRef,
  }),
  z.object({
    type: z.literal("score"),
    metric: z.enum(["score", "completionPct"]),
    op: z.enum([">=", "="]),
    value: z.number(),
    characterId: characterIdRef,
  }),
  z.object({
    type: z.literal("clean"),
    characterId: characterIdRef,
  }),
  z.object({
    type: z.literal("state"),
    key: z.string().min(1, "Ключ состояния обязателен"),
    op: z.enum([">=", "="]),
    value: z.number(),
    characterId: characterIdRef,
  }),
  z.object({
    type: z.literal("relation"),
    whoseId: z.number().int().positive().nullable().optional().default(null),
    toId: z.number().int().positive(),
    op: z.enum([">=", "="]),
    value: z.number(),
  }),
  z.object({
    /** Персонаж добился исхода инструмента в сцене узла: «оргазм случился» */
    type: z.literal("outcome"),
    toolName: z.string().min(1, "Выберите инструмент"),
    outcomeId: z.string().min(1, "Выберите исход"),
    characterId: characterIdRef,
  }),
]);

export const flowNodeSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["scene", "final", "exit"]),
  sceneId: z.number().int().positive().nullable().optional().default(null),
  bonus: z.number().min(0).max(100000).optional().default(0),
  resetOnEntry: z.boolean().optional().default(true),
  grantIncome: z.boolean().optional().default(false),
  stopsRun: z.boolean().optional().default(false),
  x: z.number(),
  y: z.number(),
});

export const flowEdgeSchema = z.object({
  id: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  priority: z.number().int().min(0).max(1000).optional().default(0),
  conditions: z.array(flowConditionSchema).optional().default([]),
  label: z.string().optional().default(""),
});

export const flowGraphSchema = z.object({
  nodes: z.array(flowNodeSchema),
  edges: z.array(flowEdgeSchema),
});

export const flowSchema = z.object({
  name: z.string().min(1, "Название обязательно"),
  description: z.string().optional().default(""),
  graph: flowGraphSchema.optional().default({ nodes: [], edges: [] }),
});

export const flowRunStartSchema = z.object({
  characterIds: z.array(z.number().int().positive()).min(1, "Выберите персонажей"),
});

export const flowEvaluateSchema = z.object({
  nodeId: z.string().min(1),
});

export const toolRequestDecisionSchema = z.object({
  action: z.enum(["approve", "reject"]),
  reason: z.string().optional().default(""),
  /** Правки черновика при одобрении (плоская форма, как в заявке) */
  patch: toolDraftPatchSchema.optional(),
});

// ---- Магазин ----

const productEffectSchema = z.object({
  target: z.enum(["self", "tool_target", "relation"]),
  key: z.string().min(1, "Ключ обязателен"),
  op: z.enum(["set", "add"]),
  value: z.union([z.number(), z.string(), z.boolean(), z.null()]),
});

export const productSchema = z.object({
  name: z.string().min(1, "Название обязательно"),
  emoji: z.string().optional().default("🛍️"),
  description: z.string().optional().default(""),
  category: z.string().optional().default(""),
  price: z.number().min(0, "Цена не может быть отрицательной").max(1_000_000).optional().default(0),
  effects: z.array(productEffectSchema).optional().default([]),
  delayScenes: z.number().int().min(0).max(50).optional().default(0),
  slot: z.string().max(32).optional().default(""),
});

// ---- Реестр характеристик ----

export const attributeSchema = z.object({
  key: z
    .string()
    .regex(/^[a-zA-Z0-9_]{1,32}$/, "Ключ: латиница/цифры/_, до 32 символов")
    .refine((k) => k.toLowerCase() === k, "Ключ — только строчными буквами"),
  label: z.string().min(1, "Название обязательно"),
  emoji: z.string().optional().default(""),
  type: z.enum(["number", "select", "text"]).optional().default("number"),
  unit: z.string().optional().default(""),
  min: z.number().nullable().optional().default(null),
  max: z.number().nullable().optional().default(null),
  options: z.array(z.string()).optional().default([]),
  position: z.number().int().min(0).max(1000).optional().default(0),
  visibility: z.enum(["public", "hidden"]).optional().default("public"),
  liePenalty: z.number().min(0).max(100).optional().default(2),
  coveredBy: z.array(z.string().max(32)).optional().default([]),
});

// ---- Реестр слотов одежды ----

export const clothingSlotSchema = z.object({
  slot: z
    .string()
    .regex(/^[a-z0-9_]{1,24}$/, "Слот: латиница строчными/цифры/_, до 24 символов"),
  layer: z.number().int().min(1).max(10).optional().default(1),
  undressPlaces: z.array(z.string().max(40)).optional().default([]),
  position: z.number().int().min(0).max(100).optional().default(0),
});

// ---- Реестр навыков ----

export const skillSchema = z.object({
  key: z
    .string()
    .regex(/^[a-z0-9_]{1,24}$/, "Ключ: латиница строчными/цифры/_, до 24 символов"),
  label: z.string().min(1, "Название обязательно").max(40),
  emoji: z.string().optional().default("🎓"),
  maxLevel: z.number().int().min(1).max(20).optional().default(5),
  practicePerLevel: z.number().int().min(1).max(1000).optional().default(10),
  grows: z.boolean().optional().default(true),
});

/** Ключ навыка неизменен — патчим только настройки. */
export const skillPatchSchema = skillSchema.omit({ key: true });

// ---- Реестр мест ----

export const placeSchema = z.object({
  name: z
    .string()
    .min(1, "Название обязательно")
    .max(40, "Название — до 40 символов")
    .regex(/^[а-яёa-z0-9][а-яёa-z0-9\s-]*$/i, "Буквы, цифры, пробел и дефис"),
  description: z.string().max(200).optional().default(""),
  position: z.number().int().min(0).max(1000).optional().default(0),
});

// ---- Химия пары ----

export const chemistrySchema = z.object({
  aId: z.number().int().positive(),
  bId: z.number().int().positive(),
  value: z.number().min(-3).max(3),
});

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}

export function jsonError(e: unknown): NextResponse {
  if (e instanceof z.ZodError) {
    return NextResponse.json(
      { error: e.errors.map((x) => `${x.path.join(".")}: ${x.message}`).join("; ") },
      { status: 400 }
    );
  }
  if (e instanceof ApiError) {
    return NextResponse.json({ error: e.message }, { status: e.status });
  }
  const msg = e instanceof Error ? e.message : String(e);
  return NextResponse.json({ error: msg }, { status: 500 });
}

export async function parseBody<T extends z.ZodTypeAny>(
  req: Request,
  schema: T
): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new ApiError(400, "Невалидный JSON в теле запроса");
  }
  return schema.parse(raw);
}

export function parseId(v: string): number {
  const id = Number(v);
  if (!Number.isInteger(id) || id <= 0) throw new ApiError(400, `Некорректный id: ${v}`);
  return id;
}
