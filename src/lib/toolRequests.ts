// Заявки агентов на новые инструменты: спека виртуального тула request_tool,
// нормализация и структурная проверка черновика, решения архитектора.
// Инструмент — это декларативные данные (схема/аудитория/эффекты), а не код:
// агент физически не может предложить ничего неисполнимого движком,
// проверка ниже ловит только кривые черновики.

import { z } from "zod";
import type { ActionCall, Tool, ToolDraft } from "./types";
import { REQUEST_TOOL_NAME } from "./types";
import {
  createTool,
  getToolByName,
  getCharacter,
  updateCharacter,
  createToolRequest,
  hasPendingToolRequest,
  getToolRequest,
  decideToolRequest as decideRequestRow,
  appendEvent,
} from "@/db/queries";
import { getDb } from "@/db";
import { getHub } from "@/lib/engine/hub";

/** Спецификация request_tool для function calling (плоские параметры — так моделям проще). */
export const REQUEST_TOOL_SPEC = {
  name: REQUEST_TOOL_NAME,
  description:
    "Запросить у Архитектора симуляции новый инструмент, если нужного действия нет среди твоих инструментов, но оно важно для твоей цели. " +
    "Заполни черновик: name — короткое имя функции (латиница a-z, 0-9, _); title — человеческий ярлык; description — когда и зачем вызывать; " +
    "parameters — JSON Schema объекта параметров (type/properties/required); audience — кому видно действие: all (всем) | target (получателю из target_param) | self (только себе) | none (скрытое); " +
    "target_param — имя строкового параметра с именем получателя (обязателен при audience=target); observation_template — как действие выглядит для других, плейсхолдеры {name} и имена параметров; " +
    "effects — массив эффектов: {target: self|tool_target, key, op: set|add, value} на состояние или {target: relation, key:'relation', op:'add', value} на отношение получателя к тебе; cost — цена в $ (0 = бесплатно). " +
    "Архитектор рассмотрит заявку и ответит. Пока решения нет — продолжай сцену доступными средствами.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Имя функции: латиница a-z, 0-9, _, 2-64 символа" },
      title: { type: "string", description: "Человеческий ярлык действия" },
      description: { type: "string", description: "Когда и зачем вызывать инструмент" },
      parameters: {
        type: "object",
        description: "JSON Schema параметров: {type:'object', properties:{...}, required:[...]}",
      },
      audience: {
        type: "string",
        enum: ["all", "target", "self", "none"],
        description: "Кому видно действие",
      },
      target_param: {
        type: "string",
        description: "Имя параметра с именем получателя (при audience=target)",
      },
      observation_template: {
        type: "string",
        description: "Шаблон наблюдения, напр. '{name} целует {who}'",
      },
      effects: {
        type: "array",
        description:
          "Эффекты: [{target:'self'|'tool_target', key, op:'set'|'add', value}] на состояние или [{target:'relation', key:'relation', op:'add', value}] на отношение получателя к тебе",
        items: {
          type: "object",
          properties: {
            target: { type: "string", enum: ["self", "tool_target", "relation"] },
            key: { type: "string" },
            op: { type: "string", enum: ["set", "add"] },
            value: {},
          },
        },
      },
      cost: { type: "number", description: "Цена действия в $ (0 = бесплатно)" },
      reason: { type: "string", description: "Зачем тебе этот инструмент (для архитектора)" },
    },
    required: ["name", "title", "description", "reason"],
  },
} as const;

/** Вход заявки от модели (плоская форма) -> zod. */
export const toolRequestArgsSchema = z.object({
  name: z.string().regex(/^[a-z0-9_]{2,64}$/, "имя: только a-z, 0-9, _, длина 2-64"),
  title: z.string().optional().default(""),
  description: z.string().optional().default(""),
  parameters: z.record(z.unknown()).optional().default({}),
  audience: z.enum(["all", "target", "self", "none"]).optional().default("all"),
  target_param: z.string().nullable().optional().default(null),
  observation_template: z.string().optional().default(""),
  effects: z
    .array(
      z.object({
        target: z.enum(["self", "tool_target", "relation", "chemistry"]),
        key: z.string(),
        op: z.enum(["set", "add"]),
        value: z.union([z.number(), z.string(), z.boolean(), z.null()]),
      })
    )
    .optional()
    .default([]),
  cost: z.number().min(0).max(1_000_000).optional().default(0),
  reason: z.string().optional().default(""),
});

export type ToolRequestArgs = z.infer<typeof toolRequestArgsSchema>;

/** Черновик для панелей UI (частичное обновление при одобрении). */
export const toolDraftPatchSchema = z.object({
  name: z.string().regex(/^[a-z0-9_]{2,64}$/).optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  parameters: z.record(z.unknown()).optional(),
  audience: z.enum(["all", "target", "self", "none"]).optional(),
  target_param: z.string().nullable().optional(),
  observation_template: z.string().optional(),
  effects: toolRequestArgsSchema.shape.effects.optional(),
  cost: z.number().min(0).optional(),
});

export function argsToDraft(args: ToolRequestArgs): ToolDraft {
  return {
    name: args.name,
    title: args.title,
    description: args.description,
    parametersSchema: args.parameters,
    audience: args.audience,
    targetParam: args.target_param && args.target_param.trim() !== "" ? args.target_param.trim() : null,
    observationTemplate: args.observation_template,
    effects: args.effects,
    cost: args.cost,
  };
}

export function draftToArgs(draft: ToolDraft): ToolRequestArgs {
  return {
    name: draft.name,
    title: draft.title,
    description: draft.description,
    parameters: draft.parametersSchema,
    audience: draft.audience,
    target_param: draft.targetParam,
    observation_template: draft.observationTemplate,
    effects: draft.effects,
    cost: draft.cost,
    reason: "",
  };
}

/**
 * Структурная проверка черновика («работоспособность»): согласованность
 * аудитории, targetParam, эффектов и плейсхолдеров наблюдения со схемой.
 * Побочных эффектов нет — это чистая валидация данных.
 */
export function validateDraft(draft: ToolDraft): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  const schema = draft.parametersSchema ?? {};
  const props = (schema.properties ?? {}) as Record<string, unknown>;
  if (schema.type !== undefined && schema.type !== "object") {
    errors.push("parameters должен быть схемой объекта (type: 'object')");
  }
  if (!schema.properties || typeof props !== "object") {
    warnings.push("у инструмента нет параметров — убедись, что это намеренно");
  }
  for (const key of (schema.required ?? []) as unknown[]) {
    if (typeof key !== "string" || !(key in props)) {
      errors.push(`required содержит "${String(key)}", которого нет в properties`);
    }
  }

  if (draft.audience === "target") {
    if (!draft.targetParam) errors.push("при audience=target нужен target_param — имя параметра с получателем");
    else if (!(draft.targetParam in props)) errors.push(`target_param "${draft.targetParam}" отсутствует в parameters.properties`);
  } else if (draft.targetParam) {
    warnings.push("target_param имеет смысл только при audience=target");
  }

  for (const eff of draft.effects) {
    if (eff.target === "tool_target" && draft.audience !== "target") {
      errors.push("эффект на получателя (tool_target) требует audience=target и target_param");
    }
    if (eff.target === "relation" && draft.audience !== "target") {
      errors.push("эффект на отношение требует адресного инструмента (audience=target и target_param)");
    }
    if (!eff.key || typeof eff.key !== "string") errors.push("у эффекта не заполнен key (ключ состояния)");
    if (eff.op === "add" && typeof eff.value !== "number") {
      warnings.push(`эффект '${eff.key}' с op=add и нечисловым значением всегда даст 0`);
    }
  }

  // Плейсхолдеры наблюдения: {name}, {tool} или имя параметра
  if (draft.observationTemplate.trim() !== "") {
    const placeholders = draft.observationTemplate.match(/\{([a-zA-Z0-9_]+)\}/g) ?? [];
    for (const p of placeholders) {
      const key = p.slice(1, -1);
      if (key === "name" || key === "tool") continue;
      if (!(key in props)) warnings.push(`плейсхолдер {${key}} не является параметром — он останется текстом`);
    }
  } else {
    warnings.push("пустой шаблон наблюдения — другие участники не увидят описание действия");
  }

  if (draft.name === REQUEST_TOOL_NAME) errors.push("это имя зарезервировано");
  return { errors, warnings };
}

export interface HandleRequestResult {
  call: ActionCall;
  created: boolean;
}

/**
 * Исполнение вызова request_tool внутри хода персонажа:
 * валидация -> строка в очереди заявок -> ответ модели.
 * Ничего не блокирует: решение архитектора придёт позже событием.
 */
export function handleToolRequestCall(input: {
  sceneId: number;
  characterId: number;
  callId: string;
  args: Record<string, unknown>;
}): HandleRequestResult {
  const { sceneId, characterId, callId, args } = input;
  const fail = (result: string): HandleRequestResult => ({
    call: {
      callId,
      toolName: REQUEST_TOOL_NAME,
      args,
      ok: false,
      result,
      observation: "",
      audience: "none",
    },
    created: false,
  });

  const parsed = toolRequestArgsSchema.safeParse(args);
  if (!parsed.success) {
    return fail(
      `Черновик инструмента невалиден: ${parsed.error.errors
        .map((e) => `${e.path.join(".")}: ${e.message}`)
        .join("; ")}. Исправь и попробуй снова.`
    );
  }
  const draft = argsToDraft(parsed.data);
  if (!parsed.data.reason || parsed.data.reason.trim().length < 3) {
    return fail("Укажи reason — зачем тебе этот инструмент (минимум пара слов).");
  }

  const { errors } = validateDraft(draft);
  if (errors.length > 0) {
    return fail(`Черновик инструмента не прошёл проверку: ${errors.join("; ")}`);
  }

  const existing = getToolByName(draft.name);
  if (existing) {
    const character = getCharacter(characterId);
    const assigned = character?.toolIds.includes(existing.id) ?? false;
    return fail(
      assigned
        ? `Инструмент "${draft.name}" уже есть и доступен тебе — просто вызывай его.`
        : `Инструмент "${draft.name}" уже существует в симуляции, но не назначен тебе. Опиши словами, что хочешь сделать, — Архитектор увидит это в транскрипте.`
    );
  }

  if (hasPendingToolRequest(sceneId, characterId)) {
    return fail("У тебя уже есть заявка на рассмотрении — дождись решения Архитектора прежде чем слать новую.");
  }

  createToolRequest({
    sceneId,
    characterId,
    toolName: draft.name,
    draft,
    reason: parsed.data.reason.trim(),
  });
  return {
    call: {
      callId,
      toolName: REQUEST_TOOL_NAME,
      args,
      ok: true,
      result: `Заявка на инструмент "${draft.name}" отправлена Архитектору. Продолжай сцену доступными средствами — решение придёт событием от Архитектора.`,
      observation: "",
      audience: "none",
    },
    created: true,
  };
}

/**
 * Решение архитектора по заявке: одобрение создаёт инструмент по черновику
 * (с возможными правками) и назначает его просителю; отказ — просто причина.
 * Персонажу уведомление пишется director-событием с аудиторией [персонаж] —
 * оно попадает в его контекст (buildMessages реконструирует director как user).
 */
export function decideToolRequest(input: {
  requestId: number;
  approve: boolean;
  reason: string;
  patch?: Partial<ToolRequestArgs>;
}): { ok: true; tool: Tool | null; notice: string } | { ok: false; error: string } {
  const req = getToolRequest(input.requestId);
  if (!req) return { ok: false, error: "Заявка не найдена" };
  if (req.status !== "pending") return { ok: false, error: "Заявка уже рассмотрена" };

  const character = getCharacter(req.characterId);
  if (!character) return { ok: false, error: "Персонаж заявки не найден" };

  if (!input.approve) {
    decideRequestRow(req.id, "rejected", input.reason || null);
    const notice = `[Архитектор симуляции — тебе лично]: Архитектор отклонил заявку на инструмент "${req.toolName}"${
      input.reason ? `. Причина: ${input.reason}` : ""
    }. Продолжай добиваться цели доступными инструментами и словами.`;
    notifyCharacter(req, notice);
    return { ok: true, tool: null, notice };
  }

  // Правки архитектора поверх черновика (плоская форма -> ToolDraft)
  const base = draftToArgs(req.draft);
  const merged = toolRequestArgsSchema.parse({ ...base, ...input.patch });
  const draft = argsToDraft(merged);
  const { errors } = validateDraft(draft);
  if (errors.length > 0) return { ok: false, error: `Черновик с правками невалиден: ${errors.join("; ")}` };
  if (draft.name !== req.toolName) {
    const clash = getToolByName(draft.name);
    if (clash) return { ok: false, error: `Инструмент с именем "${draft.name}" уже существует` };
  }

  const tool = createTool({
    name: draft.name,
    title: draft.title || draft.name,
    description: draft.description,
    parametersSchema: draft.parametersSchema,
    audience: draft.audience,
    targetParam: draft.targetParam,
    observationTemplate: draft.observationTemplate || "{name} использует {tool}",
    effects: draft.effects,
    cost: draft.cost,
    origin: "agent",
    createdBy: req.characterId,
  });
  updateCharacter(req.characterId, {
    toolIds: [...new Set([...character.toolIds, tool.id])],
  });
  decideRequestRow(req.id, "approved", input.reason || null);
  const notice = `[Архитектор симуляции — тебе лично]: Архитектор одобрил инструмент "${tool.name}" (${
    tool.title || "без ярлыка"
  })${input.reason ? `. Примечание: ${input.reason}` : ""}. Он уже назначен тебе — теперь можешь вызывать его как обычное действие${
    tool.cost > 0 ? ` (цена: $${tool.cost})` : ""
  }.`;
  notifyCharacter(req, notice);
  return { ok: true, tool, notice };
}

/** Уведомление персонажа о решении: director-событие + рассылка в SSE. */
function notifyCharacter(
  req: { sceneId: number; characterId: number },
  notice: string
): void {
  const hub = getHub();
  const ev = appendEvent(getDb(), req.sceneId, 0, "director", null, [req.characterId], {
    text: notice,
  });
  hub.emitEvent(ev);
  hub.emitToolRequests(req.sceneId);
}
