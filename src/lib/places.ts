// Места мира: реестр локаций + виртуальные тулы перемещения.
// go_to меняет место сцены (истинное окружение, с которым сверяются границы
// и правила одежды). invite лишь доставляет приглашение персонажу — поедет
// ли он, решает он сам, вызвав свой go_to. Слова не телепортируют: место
// меняет только вызов тула или режиссёр в настройках.

import type { Audience, Character, ToolSpec } from "./types";
import { GO_TOOL_NAME, INVITE_TOOL_NAME } from "./types";
import { findPlaceByName, listPlaces, updateScene } from "@/db/queries";
import { resolveTargetByName } from "./tools";

export { GO_TOOL_NAME, INVITE_TOOL_NAME } from "./types";

export const placeListText = () =>
  listPlaces()
    .map((p) => `«${p.name}»${p.description ? ` — ${p.description}` : ""}`)
    .join("; ");

export const GO_SPEC: ToolSpec = {
  name: GO_TOOL_NAME,
  description:
    "Отправиться в другое место — сцена продолжится там. Доступные места: " +
    placeListText() +
    ". Учти: другие участники отправляются вместе со сценой только своим согласием (своим go_to).",
  parameters: {
    type: "object",
    properties: {
      place: { type: "string", description: "Название места из списка" },
    },
    required: ["place"],
  },
};

export const INVITE_SPEC: ToolSpec = {
  name: INVITE_TOOL_NAME,
  description:
    "Пригласить персонажа в место — вежливая форма «поехали со мной». Приглашение доставляется лично; поедет ли человек, решает он (своим go_to). Доступные места: " +
    placeListText(),
  parameters: {
    type: "object",
    properties: {
      to: { type: "string", description: "Имя персонажа" },
      place: { type: "string", description: "Название места из списка" },
      say: { type: "string", description: "Что сказать при приглашении (необязательно)" },
    },
    required: ["to", "place"],
  },
};

interface MoveResult {
  ok: boolean;
  result: string;
  observation: string;
  audience: Audience;
}

/** go_to: смена места сцены. Только зарегистрированные места. */
export function executeGoTo(input: {
  sceneId: number;
  actor: Character;
  args: Record<string, unknown>;
}): MoveResult {
  const { sceneId, actor, args } = input;
  const place = findPlaceByName(args.place);
  if (!place) {
    const available = listPlaces().map((p) => `«${p.name}»`).join(", ") || "(реестр пуст)";
    return {
      ok: false,
      result: `Места «${String(args.place ?? "")}» нет в этом мире. Доступны: ${available}.`,
      observation: "",
      audience: "none",
    };
  }
  return applyGoTo(sceneId, actor, place.name, place.description);
}

function applyGoTo(
  sceneId: number,
  actor: Character,
  placeName: string,
  placeDescription: string
): MoveResult {
  const cur = updateScene(sceneId, { config: { place: placeName } });
  const now = cur?.config.place ?? placeName;
  const observation = `${actor.name} отправляется: ${placeName}.`;
  return {
    ok: true,
    result: `Вы отправились: ${placeName}${placeDescription ? ` — ${placeDescription}` : ""}. Место сцены теперь «${now}»: границы и правила одежды сверяются с ним.`,
    observation,
    audience: "all",
  };
}

/** invite: доставить приглашение в место — без смены места, решение за приглашённым. */
export function executeInvite(input: {
  sceneId: number;
  actor: Character;
  participants: Character[];
  args: Record<string, unknown>;
}): MoveResult {
  const { actor, participants, args } = input;
  const target = resolveTargetByName(participants, args.to);
  if (!target) {
    const names = participants.map((c) => c.name).join(", ");
    return {
      ok: false,
      result: `Получатель «${String(args.to ?? "")}» не найден среди участников. Доступны: ${names}`,
      observation: "",
      audience: "none",
    };
  }
  const place = findPlaceByName(args.place);
  if (!place) {
    const available = listPlaces().map((p) => `«${p.name}»`).join(", ") || "(реестр пуст)";
    return {
      ok: false,
      result: `Места «${String(args.place ?? "")}» нет в этом мире. Доступны: ${available}.`,
      observation: "",
      audience: "none",
    };
  }
  const say = typeof args.say === "string" && args.say.trim() ? ` «${args.say.trim()}»` : "";
  const observation = `${actor.name} приглашает ${target.name}: ${place.name}.${say}`;
  return {
    ok: true,
    result: `Вы пригласили ${target.name} в «${place.name}»${say ? `, сказав:${say}` : ""}. Приглашение доставлено лично — поедет ли, решает ${target.name} (своим go_to).`,
    observation,
    audience: [target.id],
  };
}
