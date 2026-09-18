// Исполнение tool-вызовов: валидация аргументов, разрешение получателя,
// границы персонажа (согласие), рендер наблюдения, эффекты на state и отношения.
// Это единая точка исполнения: модельный вызов и ручной act проходят один
// и тот же путь — деньги, границы и физика не обходятся ничем.

import type {
  AttributeDef,
  Audience,
  Boundary,
  Character,
  OutcomeCondition,
  OutcomeFired,
  Scene,
  Skill,
  SkillUp,
  Tool,
  ToolEffect,
  ToolOutcome,
} from "./types";
import { MONEY_KEY } from "./types";
import {
  addChemistry,
  getCharacter,
  getChemistry,
  getPracticeCount,
  getRelation,
  getSkillByKey,
  listAttributes,
  setPracticeCount,
  setRelation,
  updateCharacter,
} from "@/db/queries";
import { createOfferProposal } from "./offers";

export interface ToolExecInput {
  tool: Tool;
  actor: Character;
  /** Все участники сцены (для разрешения имён получателей) */
  participants: Character[];
  args: Record<string, unknown>;
  /** Сцена исполнения (место — для границ и одежды); null = без контекста места */
  scene: Scene | null;
  /** Номер хода (для предложений): нужен, чтобы датировать offer */
  turn?: number;
  /** Исполнение по согласию: предложение уже принято, не создавать новое */
  skipConsent?: boolean;
}

export interface ToolExecResult {
  ok: boolean;
  /** Текст для роли tool (что модель получает как результат действия) */
  result: string;
  /** Наблюдение для остальных участников */
  observation: string;
  audience: Audience;
  /** id разрешённого получателя адресного тула (null/undefined = без цели) */
  targetId?: number;
  stateChanges: { characterId: number; key: string; value: unknown }[];
  /** Изменения отношений: fromId испытывает чувство к toId, value — новое значение */
  relationChanges: { fromId: number; toId: number; value: number }[];
  /**
   * Выросшие уровни навыков актёра (практика). Уровень пишется в state
   * актёра, но НЕ в stateChanges события: payload виден цели действия,
   * а уровень навыка — скрытая характеристика (партнёр видит только последствия).
   */
  skillUps?: SkillUp[];
  /** Сработавший исход (условия → эффекты + заметка цели); заметку движок доставляет лично */
  outcome?: OutcomeFired;
  /** true = вместо исполнения создано предложение (тул требует согласия) */
  offered?: boolean;
  /** id созданного предложения (когда offered) — движок кладёт его в вызов события */
  offerId?: number;
}

/** Разрешение получателя по имени (используется и магазином). */
export function resolveTargetByName(participants: Character[], name: unknown): Character | null {
  if (typeof name !== "string" || !name.trim()) return null;
  const needle = name.trim().toLowerCase();
  return (
    participants.find((c) => c.name.toLowerCase() === needle) ??
    participants.find((c) => c.name.toLowerCase().includes(needle)) ??
    null
  );
}

/**
 * Минимальная валидация args против JSON Schema (типы + required + enum).
 * Enum в схеме — список допустимых значений (движок подставляет туда имена
 * существующих сущностей): несуществующее имя — ошибка со списком вариантов.
 */
export function validateArgs(
  schema: Record<string, unknown>,
  args: Record<string, unknown>
): string | null {
  if (schema.type === "object" || schema.properties) {
    const props = (schema.properties ?? {}) as Record<
      string,
      { type?: string; enum?: unknown[] }
    >;
    for (const key of (schema.required ?? []) as string[]) {
      const v = args[key];
      if (v === undefined || v === null || v === "") return `Не хватает обязательного параметра "${key}"`;
      const t = props[key]?.type;
      if (t === "string" && typeof v !== "string") return `Параметр "${key}" должен быть строкой`;
      if (t === "number" && typeof v !== "number") return `Параметр "${key}" должен быть числом`;
      if (t === "boolean" && typeof v !== "boolean") return `Параметр "${key}" должен быть булевым`;
    }
    // Enum-членство: для каждого переданного параметра, у которого в схеме
    // есть enum (движок кладёт туда реальные сущности сцены/мира).
    for (const [key, def] of Object.entries(props)) {
      if (!Array.isArray(def.enum) || def.enum.length === 0) continue;
      const v = args[key];
      if (v === undefined || v === null || v === "") continue;
      if (!def.enum.includes(v as never)) {
        return `Параметр "${key}" = "${String(v)}" не существует. Выбери из: ${def.enum
          .map((x) => String(x))
          .join(", ")}`;
      }
    }
  }
  return null;
}

/** Подстановка {name} и {параметров} в шаблон наблюдения. */
export function renderTemplate(
  template: string,
  actorName: string,
  tool: Tool,
  args: Record<string, unknown>
): string {
  let out = template.replaceAll("{name}", actorName).replaceAll("{tool}", tool.title || tool.name);
  for (const [k, v] of Object.entries(args)) {
    out = out.replaceAll(`{${k}}`, String(v ?? ""));
  }
  return out;
}

/**
 * Клампинг числовых значений state по min/max реестра характеристик:
 * эффекты не должны выносить значение за диапазон (mood 16 из 10 возможных).
 * Ключи без определения в реестре не трогаются.
 */
export function clampStateValues(
  state: Record<string, unknown>,
  defs: AttributeDef[]
): Record<string, unknown> {
  const byKey = new Map(defs.map((d) => [d.key, d]));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(state)) {
    const def = byKey.get(k);
    if (def && typeof v === "number" && Number.isFinite(v)) {
      let x = v;
      if (def.min != null) x = Math.max(def.min, x);
      if (def.max != null) x = Math.min(def.max, x);
      out[k] = x;
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Отношение цели к актёру с учётом химии пары: дельта умножается на
 * (1 + химия/2) — созвездные пары тают быстрее, несозвездные глушатся.
 * Знак сохраняется, ноль остаётся нулём; set — абсолют без множителя.
 */
export function applyRelationDelta(
  actorId: number,
  targetId: number,
  op: "set" | "add",
  delta: number
): number {
  if (op === "set") {
    setRelation(targetId, actorId, delta);
    return delta;
  }
  const chem = getChemistry(actorId, targetId);
  let next: number;
  if (delta === 0) {
    next = getRelation(targetId, actorId);
  } else {
    const scaled = delta * (1 + chem / 2);
    const rounded = Math.round(scaled);
    next = delta > 0 ? Math.max(0, rounded) : Math.min(0, rounded);
    next = getRelation(targetId, actorId) + next;
  }
  setRelation(targetId, actorId, next);
  return next;
}

/** Сравнение значения условия исхода (число или строка). */
function outcomeCondOk(cond: OutcomeCondition, v: unknown): boolean {
  if (typeof cond.value === "number") {
    // Отсутствующая числовая характеристика = 0: новичок без ключа в state
    // (навык не прокачан) должен проваливать «≥ N», но проходить «< N».
    const num = typeof v === "number" ? v : v == null || v === "" ? 0 : NaN;
    if (Number.isNaN(num)) return false;
    if (cond.op === ">=") return num >= cond.value;
    if (cond.op === "<") return num < cond.value;
    return num === cond.value;
  }
  return cond.op === "=" && String(v ?? "") === String(cond.value);
}

/**
 * Первый подошедший исход тула: условия проверяются по ИСТИННОМУ состоянию
 * на момент действия (до эффектов этого вызова). Только для адресных тулов
 * с реальной целью (не сам актёр).
 */
export function matchOutcome(
  tool: Tool,
  actor: Character,
  target: Character | null,
  scene: Scene | null
): ToolOutcome | null {
  if (tool.outcomes.length === 0) return null;
  if (!target || target.id === actor.id) return null;
  for (const oc of tool.outcomes) {
    if (oc.conditions.length === 0) continue;
    const all = oc.conditions.every((cond) => {
      switch (cond.kind) {
        case "actor_attr":
          return outcomeCondOk(cond, actor.state[cond.key]);
        case "target_attr":
          return outcomeCondOk(cond, target.state[cond.key]);
        case "relation":
          return outcomeCondOk(cond, getRelation(target.id, actor.id));
        case "chemistry":
          return outcomeCondOk(cond, getChemistry(actor.id, target.id));
        case "place":
          return (
            cond.op === "=" &&
            (scene?.config.place ?? "").trim().toLowerCase() === String(cond.value).trim().toLowerCase()
          );
        case "worn":
          return outcomeCondOk(cond, target.state["worn_" + cond.key] ?? "");
      }
    });
    if (all) return oc;
  }
  return null;
}

/** Условие исхода человеческим языком (для описания тула модели). */
function outcomeCondText(cond: OutcomeCondition, skills: Skill[], defs: AttributeDef[]): string {
  const labelOf = (key: string): string => {
    if (key.startsWith("skill_")) {
      const s = skills.find((x) => x.attributeKey === key);
      if (s) return `навык «${s.label}»`;
    }
    const d = defs.find((x) => x.key === key);
    return d ? d.label : key;
  };
  switch (cond.kind) {
    case "actor_attr":
      return `твой ${labelOf(cond.key)} ${cond.op} ${cond.value}`;
    case "target_attr":
      return `${labelOf(cond.key)} партнёра ${cond.op} ${cond.value}`;
    case "relation":
      return `отношение партнёра к тебе ${cond.op} ${cond.value}`;
    case "chemistry":
      return `химия между вами ${cond.op} ${cond.value}`;
    case "place":
      return `место — ${cond.value}`;
    case "worn":
      return cond.value === "" ? `слот ${cond.key} партнёра пуст (снято)` : `на партнёре надет ${cond.key}`;
  }
}

/**
 * Подсказка об исходах для описания тула (function calling): перечисляет
 * требования незасекреченных исходов, чтобы модель понимала, от чего зависит
 * результат. Скрытые (hideFromPrompt) исходы не раскрываются — «по факту».
 */
export function outcomeHintText(tool: Tool, skills: Skill[], defs: AttributeDef[]): string {
  const open = tool.outcomes.filter((o) => !o.hideFromPrompt && o.conditions.length > 0);
  if (open.length === 0) return "";
  const lines = open.map(
    (o) => `«${o.title}»: ${o.conditions.map((c) => outcomeCondText(c, skills, defs)).join(", ")}`
  );
  return ` Возможные исходы (зависят от обстоятельств): ${lines.join("; ")}.`;
}

/**
 * Практика навыка: успешное (ok:true) применение тула инкрементит счётчик
 * актёра; на пороге practicePerLevel уровень растёт на +1 (до maxLevel),
 * счётчик сбрасывается. Пишем уровень в state актёра, но не в stateChanges
 * события — уровень скрыт от партнёров. Возвращает выросшие уровни.
 */
function applySkillPractice(
  tool: Tool,
  actor: Character,
  selfState: Record<string, unknown>
): SkillUp[] {
  if (!tool.trainsSkill) return [];
  const skill = getSkillByKey(tool.trainsSkill);
  if (!skill || !skill.grows) return [];
  const levelKey = skill.attributeKey;
  const fromLevel =
    typeof selfState[levelKey] === "number" ? (selfState[levelKey] as number) : 0;
  if (fromLevel >= skill.maxLevel) return [];
  const count = getPracticeCount(actor.id, skill.key) + 1;
  if (count < skill.practicePerLevel) {
    setPracticeCount(actor.id, skill.key, count);
    return [];
  }
  const toLevel = Math.min(skill.maxLevel, fromLevel + 1);
  selfState[levelKey] = toLevel;
  setPracticeCount(actor.id, skill.key, 0);
  return [{ key: skill.key, label: skill.label, fromLevel, toLevel, maxLevel: skill.maxLevel }];
}

/**
 * Проверка границ: правила согласия участников против адресного вызова.
 * Возвращает null, если всё в порядке, или текст причины отказа. Правило —
 * произвольный список условий («И», types:BoundaryCondition), проверяется по
 * порядку над ИСТИННЫМ состоянием (физика), а не заявлениям: обмануть словами
 * нельзя. Пустой список условий — правило проходит всегда.
 *
 * ownerIsActor: правило принадлежит самому актёру (scope outgoing/both) —
 * «моё собственное правило на мои действия». Роли в условиях всегда
 * относительны вызова: actor — кто вызывает, target — на кого.
 */
function boundaryViolation(
  rule: Boundary,
  input: ToolExecInput,
  target: Character,
  ownerIsActor = false
): string | null {
  const { actor, scene } = input;
  // Хозяин правила и «другой» участник пары: для входящего правила хозяин —
  // цель вызова, для исходящего (своего) — сам актёр.
  const owner = ownerIsActor ? actor : target;
  const other = ownerIsActor ? target : actor;
  for (const cond of rule.conditions ?? []) {
    switch (cond.kind) {
      case "relation": {
        // Отношение ВЛАДЕЛЬЦА границы к другому участнику (системная матрица).
        const rel = getRelation(owner.id, other.id);
        const ok =
          cond.op === ">=" ? rel >= cond.value : cond.op === "<" ? rel < cond.value : rel === cond.value;
        if (ok) break;
        // Чужие чувства — приватны: без точных цифр, только сигнал.
        if (cond.op === "<") {
          return `отношение ${owner.name} к тебе недостаточно прохладное`;
        }
        if (cond.op === "=") {
          return `отношение ${owner.name} к тебе не равно нужному`;
        }
        return `отношение ${owner.name} к тебе ещё не доросло до нужного`;
      }
      case "attr": {
        // Истинный state участника условия (актёра вызова или его цели):
        // отсутствующая числовая характеристика считается нулём.
        const who = cond.owner === "actor" ? actor : target;
        const raw = who.state[cond.key];
        const num = typeof raw === "number" ? raw : 0;
        const ok =
          cond.op === ">=" ? num >= cond.value : cond.op === "<" ? num < cond.value : num === cond.value;
        if (ok) break;
        // Название характеристики — из реестра (неизвестный ключ показываем как есть).
        const def = listAttributes().find((d) => d.key === cond.key);
        const label = def ? def.label : cond.key;
        // Скрытые характеристики не раскрываем цифрами: сам факт отказа уже
        // сигнал («не дотягивает»), точное значение — эпистемическая утечка.
        const masked = def?.visibility === "hidden";
        if (cond.op === "<") {
          return `у ${who.name} «${label}» не ниже нужного${masked ? "" : ` (${num} ≥ ${cond.value})`}`;
        }
        if (cond.op === "=") {
          return `у ${who.name} «${label}» не то значение${masked ? "" : ` (${num} ≠ ${cond.value})`}`;
        }
        return `у ${who.name} «${label}» ниже нужного${masked ? "" : ` (${num} < ${cond.value})`}`;
      }
      case "place": {
        // Место сцены, сравнение без учёта регистра.
        const place = (scene?.config.place ?? "").trim().toLowerCase();
        if (place === cond.place.trim().toLowerCase()) break;
        return `не то место (нужно: ${cond.place}, а сейчас: ${place || "не задано"})`;
      }
      case "worn": {
        // Слот одежды ВЛАДЕЛЬЦА правила: пустой = нет непустой строки worn_<слот>.
        const v = owner.state["worn_" + cond.slot];
        const bare = !(typeof v === "string" && v.trim() !== "");
        if (bare === cond.bare) break;
        return `слот ${cond.slot} ${owner.name} должен быть ${cond.bare ? "пуст" : "занят"}`;
      }
    }
  }
  return null;
}

/** Применить эффекты нарушения границы: отношение владельца правила к другому и state владельца. */
function applyBoundaryEffects(
  rule: Boundary,
  actor: Character,
  target: Character,
  refuser: Character
): {
  stateChanges: ToolExecResult["stateChanges"];
  relationChanges: ToolExecResult["relationChanges"];
} {
  const stateChanges: ToolExecResult["stateChanges"] = [];
  const relationChanges: ToolExecResult["relationChanges"] = [];
  const state = { ...refuser.state };
  let dirty = false;
  for (const eff of rule.effects) {
    if (eff.target === "relation") {
      const delta = typeof eff.value === "number" ? eff.value : Number(eff.value) || 0;
      const next = eff.op === "set" ? delta : getRelation(refuser.id, actor.id) + delta;
      setRelation(refuser.id, actor.id, next);
      relationChanges.push({ fromId: refuser.id, toId: actor.id, value: next });
    } else {
      // Эффектов нарушения на инициатора нет — наказание социальное: владелец и его чувства.
      if (eff.op === "set") {
        state[eff.key] = eff.value;
      } else {
        const curVal = typeof state[eff.key] === "number" ? (state[eff.key] as number) : 0;
        const delta = typeof eff.value === "number" ? eff.value : Number(eff.value) || 0;
        state[eff.key] = curVal + delta;
      }
      stateChanges.push({ characterId: refuser.id, key: eff.key, value: state[eff.key] });
      dirty = true;
    }
  }
  if (dirty)
    updateCharacter(refuser.id, { state: clampStateValues(state, listAttributes()) });
  return { stateChanges, relationChanges };
}

export function executeTool(input: ToolExecInput): ToolExecResult {
  const { tool, actor, participants, args } = input;

  const validationError = validateArgs(tool.parametersSchema, args);
  if (validationError) {
    return {
      ok: false,
      result: `Ошибка валидации: ${validationError}`,
      observation: "",
      audience: "all",
      stateChanges: [],
      relationChanges: [],
    };
  }

  // Аудитория действия и получатель (до денег: граница важнее кошелька)
  let audience: Audience = "all";
  let targetChar: Character | null = null;
  if (tool.audience === "target") {
    const targetName = tool.targetParam ? args[tool.targetParam] : undefined;
    targetChar = resolveTargetByName(participants, targetName);
    if (!targetChar) {
      const names = participants.map((c) => c.name).join(", ");
      return {
        ok: false,
        result: `Получатель "${String(targetName)}" не найден среди участников. Доступны: ${names}`,
        observation: "",
        audience: "none",
        stateChanges: [],
        relationChanges: [],
      };
    }
    if (targetChar.id === actor.id && participants.length > 1) {
      // Разрешаем, но предупреждаем — модель иногда путает имена.
      audience = [actor.id];
    } else {
      audience = [targetChar.id];
    }
  } else if (tool.audience === "self") {
    audience = [actor.id];
  } else if (tool.audience === "none") {
    audience = "none";
  }

  // Границы (согласие): проверяем ДО денег и эффектов. Отказ = действие
  // не исполняется, деньги целы, применяется социальное наказание владельца.
  // Две стороны: incoming-правила ЦЕЛИ («кто делает это со мной») и
  // outgoing-правила АКТЁРА («с кем я сам это делаю»). Результат отказа
  // виден только инициатору: причина может называть скрытые вещи —
  // ни цель, ни остальные участники чужих отказов не видят.
  if (tool.audience === "target" && targetChar && targetChar.id !== actor.id) {
    const rulesOf = (c: Character, scopes: Boundary["scope"][]) =>
      c.boundaries.filter(
        (b) =>
          (b.toolName === tool.name || b.toolName === "*") &&
          scopes.includes(b.scope ?? "incoming")
      );
    const checks: { rule: Boundary; ownerIsActor: boolean }[] = [
      ...rulesOf(targetChar, ["incoming", "both"]).map((rule) => ({ rule, ownerIsActor: false })),
      ...rulesOf(actor, ["outgoing", "both"]).map((rule) => ({ rule, ownerIsActor: true })),
    ];
    for (const { rule, ownerIsActor } of checks) {
      const reason = boundaryViolation(rule, input, targetChar, ownerIsActor);
      if (reason === null) continue;
      const refuser = ownerIsActor ? actor : targetChar;
      const { stateChanges, relationChanges } = applyBoundaryEffects(
        rule,
        actor,
        targetChar,
        refuser
      );
      const refusal = rule.refusalText.trim() || "твёрдо отстраняется";
      const observation =
        ownerIsActor
          ? `${actor.name} останавливается: ${refusal}`
          : `${actor.name} пытается: ${tool.title || tool.name} — но ${targetChar.name} ${refusal}`;
      let result = ownerIsActor
        ? `Твоё собственное правило не пускает: ${refusal}. Причина: ${reason}. Действие не произошло.`
        : `${targetChar.name} ${refusal}. Причина: ${reason}. Действие не произошло.`;
      if (relationChanges.length > 0) {
        result += ` | Отношение ${refuser.name} к тебе изменилось: теперь ${relationChanges[0].value}.`;
      }
      if (stateChanges.length > 0) {
        result += ` | ${refuser.name}: ${stateChanges.map((c) => `${c.key}=${JSON.stringify(c.value)}`).join(", ")}`;
      }
      result += " Не дави: попробуй разговор, подарок или подожди более подходящего момента.";
      return {
        ok: false,
        result,
        observation,
        audience: "none",
        targetId: targetChar.id,
        stateChanges,
        relationChanges,
      };
    }
  }

  // Экономика: платные действия списывают деньги с ключа money актёра.
  const cost = tool.cost > 0 ? tool.cost : 0;
  const balance = typeof actor.state[MONEY_KEY] === "number" ? (actor.state[MONEY_KEY] as number) : 0;
  if (cost > 0 && balance < cost) {
    return {
      ok: false,
      result: `Недостаточно денег: действие стоит $${cost}, а у тебя $${balance}. Найди бесплатный способ добиться цели или заработай.`,
      observation: "",
      audience: "none",
      stateChanges: [],
      relationChanges: [],
    };
  }

  // Предложение (согласие): тул не исполняется сразу — цель ответит в свой
  // ход. Границы уже проверены выше: не проходит по характеристикам — даже
  // предложить нельзя (модель увидела причину). Деньги проверены тоже.
  if (
    tool.requiresConsent &&
    tool.audience === "target" &&
    targetChar &&
    targetChar.id !== actor.id &&
    !input.skipConsent &&
    input.scene != null
  ) {
    return createOfferProposal({
      tool,
      actor,
      target: targetChar,
      args,
      sceneId: input.scene.id,
      turn: input.turn ?? 0,
    });
  }
  // Согласие без адресата не имеет смысла (кривой тул, напр. из заявки
  // агента с audience != "target"): исполнять такое молча — обход
  // согласия. Отказываем с внятной причиной — пусть просят починку.
  if (tool.requiresConsent && tool.audience !== "target" && !input.skipConsent && input.scene != null) {
    return {
      ok: false,
      result:
        `Инструмент «${tool.title || tool.name}» помечен как требующий согласия, но не адресный ` +
        `(audience="${tool.audience}") — это ошибка конфигурации. Действие отменено; ` +
        `попроси Архитектора исправить тул (адресный + параметр получателя).`,
      observation: "",
      audience: "none",
      stateChanges: [],
      relationChanges: [],
    };
  }

  // Эффекты: state — через карту состояний (один write на цель),
  // relation — отдельным блоком с множителем химии пары,
  // chemistry — сама пара. Исход (если условия сошлись) добавляет свои
  // эффекты поверх базовых; условия проверены по состоянию ДО эффектов.
  const firedOutcome = matchOutcome(tool, actor, targetChar, input.scene);
  const allEffects = [...tool.effects, ...(firedOutcome?.effects ?? [])];
  const stateMap = new Map<number, Record<string, unknown>>();
  const stateOf = (c: Character) => {
    let s = stateMap.get(c.id);
    if (!s) {
      // База — свежий state из БД: несколько тулов одной итерации, действующие
      // на одну цель, не должны затирать записи друг друга старым снимком.
      const fresh = getCharacter(c.id);
      s = { ...(fresh?.state ?? c.state) };
      stateMap.set(c.id, s);
    }
    return s;
  };
  const stateChanges: ToolExecResult["stateChanges"] = [];
  const relationChanges: ToolExecResult["relationChanges"] = [];
  const relationNotes: string[] = [];
  let chemistryNote = "";
  for (const eff of allEffects) {
    if (eff.target === "relation") {
      if (!targetChar || targetChar.id === actor.id) continue;
      const delta = typeof eff.value === "number" ? eff.value : Number(eff.value) || 0;
      const next = applyRelationDelta(actor.id, targetChar.id, eff.op, delta);
      relationChanges.push({ fromId: targetChar.id, toId: actor.id, value: next });
      relationNotes.push(
        `Отношение ${targetChar.name} к тебе: ${eff.op === "set" ? "теперь" : delta >= 0 ? `+${delta}` : delta} (теперь ${next})`
      );
      continue;
    }
    if (eff.target === "chemistry") {
      if (!targetChar || targetChar.id === actor.id) continue;
      const delta = typeof eff.value === "number" ? eff.value : Number(eff.value) || 0;
      const cur = getChemistry(actor.id, targetChar.id);
      const next = eff.op === "set" ? Math.max(-3, Math.min(3, delta)) : Math.max(-3, Math.min(3, cur + delta));
      if (next !== cur) {
        addChemistry(actor.id, targetChar.id, next - cur);
        chemistryNote = `Химия с ${targetChar.name} теперь ${next}`;
      }
      continue;
    }
    const target = eff.target === "self" ? actor : targetChar;
    if (!target) continue;
    const cur = stateOf(target);
    if (eff.op === "set") {
      cur[eff.key] = eff.value;
    } else if (eff.op === "add") {
      const curVal = typeof cur[eff.key] === "number" ? (cur[eff.key] as number) : 0;
      const delta = typeof eff.value === "number" ? eff.value : Number(eff.value) || 0;
      cur[eff.key] = curVal + delta;
    }
    stateChanges.push({ characterId: target.id, key: eff.key, value: cur[eff.key] });
  }
  // Списание цены — после эффектов, в той же записи state (один write на цель).
  if (cost > 0) {
    const self = stateOf(actor);
    self[MONEY_KEY] = (typeof self[MONEY_KEY] === "number" ? (self[MONEY_KEY] as number) : 0) - cost;
    stateChanges.push({ characterId: actor.id, key: MONEY_KEY, value: self[MONEY_KEY] });
  }
  // Практика навыка актёра: только на успешном пути (отказы не качают).
  const skillUps = applySkillPractice(tool, actor, stateOf(actor));
  const attributeDefs = listAttributes();
  stateMap.forEach((state, id) => {
    const clamped = clampStateValues(state, attributeDefs);
    stateMap.set(id, clamped);
    updateCharacter(id, { state: clamped });
  });
  // Отображение честно: в stateChanges и результате — клампнутые значения
  for (let i = 0; i < stateChanges.length; i++) {
    const c = stateChanges[i];
    const v = stateMap.get(c.characterId)?.[c.key];
    if (v !== undefined) stateChanges[i] = { ...c, value: v };
  }

  const observation = renderTemplate(tool.observationTemplate, actor.name, tool, args);
  // Tool-результат не эхом возвращает наблюдение, составленное из длинных
  // аргументов самого актёра: текст уже есть в tool_calls.arguments —
  // повтор просто раздувает контекст. Наблюдение остаётся в событии для других.
  const echoedArg = Object.values(args).some(
    (v) => typeof v === "string" && v.length >= 40 && observation.includes(v)
  );
  let result = echoedArg
    ? `Выполнено: ${tool.title || tool.name}. Текст из аргументов уже доставлен/состоялся — не повторяй его же репликой.`
    : `Выполнено: ${observation || tool.title || tool.name}`;
  if (cost > 0) {
    const left = typeof stateOf(actor)[MONEY_KEY] === "number" ? (stateOf(actor)[MONEY_KEY] as number) : 0;
    result += ` | Оплачено: $${cost}, остаток: $${left}`;
  }
  if (relationNotes.length > 0) {
    result += ` | ${relationNotes.join("; ")}`;
  }
  if (chemistryNote) {
    result += ` | ${chemistryNote}`;
  }
  if (firedOutcome) {
    result += ` | Исход: «${firedOutcome.title}»`;
  }
  if (stateChanges.length > 0) {
    // ЧЬЁ состояние изменилось: у адресных тулов эффекты чаще всего ложатся
    // на цель, а не на актёра — без имени модель читает чужой рост как свой.
    const nameOf = new Map<number, string>([[actor.id, "ты"]]);
    if (targetChar) nameOf.set(targetChar.id, targetChar.name);
    result += ` | Изменения состояния: ${stateChanges
      .map(
        (c) =>
          `${nameOf.get(c.characterId) ?? `#${c.characterId}`}: ${c.key}=${JSON.stringify(c.value)}`
      )
      .join(", ")}`;
  }
  for (const up of skillUps) {
    result += ` | Навык «${up.label}»: уровень ${up.toLevel}/${up.maxLevel} — практика даёт о себе знать.`;
  }
  return {
    ok: true,
    result,
    observation,
    audience,
    stateChanges,
    relationChanges,
    skillUps,
    targetId: targetChar?.id,
    outcome: firedOutcome
      ? {
          outcomeId: firedOutcome.id,
          title: firedOutcome.title,
          noticeTarget: firedOutcome.noticeTarget,
          targetId: targetChar!.id,
        }
      : undefined,
  };
}

/** Парсинг arguments из tool_call (модели иногда отдают невалидный JSON). */
export function parseToolArguments(raw: string): { args: Record<string, unknown>; error?: string } {
  if (!raw || raw.trim() === "") return { args: {}, error: "Пустые аргументы" };
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { args: parsed as Record<string, unknown> };
    }
    return { args: {}, error: "Аргументы должны быть JSON-объектом" };
  } catch {
    return { args: {}, error: `Невалидный JSON в аргументах: ${raw.slice(0, 200)}` };
  }
}

/** Эффекты отношения/химии и исходы допустимы только у адресных тулов (есть получатель). */
export function relationEffectAllowed(
  tool: { audience: string; targetParam: string | null },
  effects: ToolEffect[],
  outcomes: ToolOutcome[] = []
): string | null {
  const needsTarget = effects.some((e) => e.target === "relation" || e.target === "chemistry");
  if (needsTarget && tool.audience !== "target") {
    return "эффект на отношение/химию требует адресного инструмента (audience=target и target_param)";
  }
  if (outcomes.length > 0 && tool.audience !== "target") {
    return "исходы требуют адресного инструмента (audience=target и target_param)";
  }
  return null;
}
