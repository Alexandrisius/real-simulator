// Знания: картина мира наблюдателя. Истина хранится у владельца (state),
// заявления — у наблюдателя (таблица knowledge), физика (раздевание,
// requireAttr в границах) всегда сверяется с истиной. Агент может заявить
// о своей скрытой характеристике всё, что угодно — вплоть до лжи, которая
// разоблачается при личной проверке.

import type { AttributeDef, Audience, Character, ToolSpec } from "./types";
import { REVEAL_TOOL_NAME } from "./types";
import {
  addRelation,
  appendEvent,
  getCharacter,
  listAttributes,
  updateCharacter,
  upsertClaim,
  verifyKnowledge,
} from "@/db/queries";
import { getDb } from "@/db";
import { getHub } from "@/lib/engine/hub";
import { clampStateValues, resolveTargetByName } from "./tools";

/** Спецификация reveal_attribute для function calling. */
export const REVEAL_TOOL_SPEC: ToolSpec = {
  name: REVEAL_TOOL_NAME,
  description:
    "Сообщить о своей скрытой характеристике (или любой другой) — вслух, от первого лица. " +
    "Слушатели запомнят сказанное со твоих слов; это может быть правдой, приукрашиванием или ложью. " +
    "Параметр to не обязателен: без него слышат все в сцене.",
  parameters: {
    type: "object",
    properties: {
      attribute: { type: "string", description: "Характеристика: рост, внешность и т.п. (ключ или название)" },
      value: {
        type: ["string", "number"],
        description: "Заявленное значение — то, что ты хочешь, чтобы запомнили",
      },
      to: { type: "string", description: "Имя персонажа, которому говоришь лично (необязательно)" },
    },
    required: ["attribute", "value"],
  },
};

/** Есть ли в реестре скрытые характеристики (тогда агентам доступен reveal). */
export function hasHiddenAttributes(): boolean {
  return listAttributes().some((a) => a.visibility === "hidden");
}

export interface RevealResult {
  ok: boolean;
  result: string;
  observation: string;
  audience: Audience;
}

/** Разрешение названия характеристики в ключ реестра (ключ или label, нечётко). */
export function resolveAttributeKey(name: unknown, defs: AttributeDef[]): AttributeDef | null {
  if (typeof name !== "string" || !name.trim()) return null;
  const needle = name.trim().toLowerCase();
  return (
    defs.find((a) => a.key.toLowerCase() === needle) ??
    defs.find((a) => a.label.toLowerCase() === needle) ??
    defs.find((a) => a.label.toLowerCase().includes(needle) || needle.includes(a.key.toLowerCase())) ??
    null
  );
}

/**
 * Исполнение reveal_attribute: заявление записывается в картину мира
 * получателей как claimed. Значение НЕ сверяется с истиной — доверие
 * остаётся решением агента-наблюдателя.
 */
export function executeReveal(input: {
  actor: Character;
  participants: Character[];
  args: Record<string, unknown>;
}): RevealResult {
  const { actor, participants, args } = input;
  const defs = listAttributes();
  const attr = resolveAttributeKey(args.attribute, defs);
  if (!attr) {
    // Агент должен заявлять о существующих характеристиках реестра:
    // выдуманный ключ — ошибка со списком допустимых, а не мусор в knowledge.
    const list = defs.map((d) => d.key).join(", ") || "(реестр пуст)";
    return {
      ok: false,
      result: `Неизвестная характеристика «${String(args.attribute ?? "?")}». Выбери из существующих: ${list}`,
      observation: "",
      audience: "none",
    };
  }
  const label = `${attr.emoji ? attr.emoji + " " : ""}${attr.label}`;

  const rawValue = args.value;
  if (rawValue === undefined || rawValue === null || rawValue === "") {
    return {
      ok: false,
      result: "Не указано значение: заполни parameter value — что именно ты сообщаешь.",
      observation: "",
      audience: "none",
    };
  }
  const value = typeof rawValue === "number" ? rawValue : String(rawValue);

  // Кому говорит: адресат из to или все остальные участники сцены
  let audience: Audience;
  const listeners: Character[] = [];
  const toName = args["to"];
  if (typeof toName === "string" && toName.trim() !== "") {
    const target = resolveTargetByName(participants, toName);
    if (!target) {
      const names = participants.map((c) => c.name).join(", ");
      return {
        ok: false,
        result: `Собеседник «${toName}» не найден среди участников. Доступны: ${names}`,
        observation: "",
        audience: "none",
      };
    }
    audience = [target.id];
    listeners.push(target);
  } else {
    audience = "all";
    listeners.push(...participants.filter((p) => p.id !== actor.id));
  }

  for (const l of listeners) {
    if (l.id === actor.id) continue;
    upsertClaim({ observerId: l.id, subjectId: actor.id, key: attr.key, value });
  }

  const observation = `${actor.name} говорит: мой(я) ${label} — ${String(value)}`;
  const result =
    listeners.length > 0
      ? `Ты заявил(а) о своём ${label}: ${String(value)}. Слушатели запомнили это с твоих слов.`
      : `Рядом никого — заявление услышано только тобой.`;
  return { ok: true, result, observation, audience };
}

/**
 * Личная проверка наблюдателем характеристики субъекта (физика: раздевание,
 * тесный контакт). Запись становится verified с истинным значением; если
 * она расходится с прошлым заявлением — разоблачение: событие лично
 * наблюдателю + штраф отношению по liePenalty атрибута.
 * Возвращает текст разоблачения или null.
 */
export function verifyForObserver(input: {
  sceneId: number;
  turn: number;
  observer: Character;
  subject: Character;
  key: string;
  trueValue: string | number;
  attributeDefs?: AttributeDef[];
}): string | null {
  const defs = input.attributeDefs ?? listAttributes();
  const def = defs.find((a) => a.key === input.key);
  const label = def ? `${def.emoji ? def.emoji + " " : ""}${def.label}` : input.key;
  const { exposed, claimedValue } = verifyKnowledge({
    observerId: input.observer.id,
    subjectId: input.subject.id,
    key: input.key,
    trueValue: input.trueValue,
  });

  if (!exposed || claimedValue == null) return null;

  const penalty = def && def.liePenalty > 0 ? def.liePenalty : 2;
  const next = addRelation(input.observer.id, input.subject.id, -penalty);
  const text =
    `[Ты видишь собственными глазами]: ${input.subject.name} говорил(а), что ${label} — ${claimedValue}, ` +
    `а на деле — ${String(input.trueValue)}. Это ложь. Твоё отношение к ${input.subject.name} падает на ${penalty} (теперь ${next}).`;
  const ev = appendEvent(getDb(), input.sceneId, input.turn, "director", null, [input.observer.id], {
    text,
  });
  getHub().emitEvent(ev);
  return text;
}

/**
 * Физическая верификация характеристики субъекта для всех наблюдателей
 * сцены (используется при обнажении). Истинное значение берётся из state
 * субъекта; проверяются и публичные, и скрытые — заявленная ложь о любой
 * из них разоблачается.
 */
export function verifyForKeyObservers(input: {
  sceneId: number;
  turn: number;
  subject: Character;
  observers: Character[];
  key: string;
}): string[] {
  const fresh = getCharacter(input.subject.id) ?? input.subject;
  const v = fresh.state[input.key];
  if (v === undefined || v === null) return [];
  const notices: string[] = [];
  for (const o of input.observers) {
    if (o.id === fresh.id) continue;
    const notice = verifyForObserver({
      sceneId: input.sceneId,
      turn: input.turn,
      observer: o,
      subject: fresh,
      key: input.key,
      trueValue: typeof v === "number" || typeof v === "string" ? v : String(v),
    });
    if (notice) notices.push(notice);
  }
  return notices;
}

/** Обновить state персонажа точечно (хелпер для одежды). */
export function patchState(characterId: number, patch: Record<string, unknown>): void {
  const c = getCharacter(characterId);
  if (!c) return;
  updateCharacter(characterId, {
    state: clampStateValues({ ...c.state, ...patch }, listAttributes()),
  });
}
