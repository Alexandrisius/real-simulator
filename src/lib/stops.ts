// Системные стоп-инструменты: персонаж сам прекращает общение, и генерация
// для него останавливается (токены не горят в пустую).
// leave_scene — уйти из сцены: персонаж выпадает из ротации; когда общаться
// больше не с кем, сцена завершается.
// block_character — заблокировать участника: пара замолкает в обе стороны
// (события друг друга не видят), переписка невозможна.

import type { ActionCall, Character, ToolSpec } from "./types";
import { BLOCK_TOOL_NAME, LEAVE_SCENE_TOOL_NAME } from "./types";
import { appendEvent, addSceneBlock, setSceneLeftFlag } from "@/db/queries";
import { getDb } from "@/db";
import { getHub } from "./engine/hub";

export const LEAVE_SPEC: ToolSpec = {
  name: LEAVE_SCENE_TOOL_NAME,
  description:
    "Покинуть сцену навсегда: ты выходишь из общения, мир перестаёт генерировать твои ходы. " +
    "Если после твоего ухода общаться больше не с кем — сцена завершится. " +
    "Используй, когда персонаж действительно хочет уйти: цель достигнута, свидание окончено, обида или отвращение сильнее желания остаться. Сначала скажи уходящие слова репликой.",
  parameters: { type: "object", properties: {} },
};

export const BLOCK_SPEC: ToolSpec = {
  name: BLOCK_TOOL_NAME,
  description:
    "Заблокировать участника: переписка с ним прекращается в обе стороны — ни ты его не видишь, ни он тебя. " +
    "Если после блокировки общаться больше не с кем — сцена завершится. " +
    "Осознанное решение персонажа: «не хочу иметь с ним дело». Обычно сперва говоришь, потом блокируешь.",
  parameters: {
    type: "object",
    properties: {
      target: { type: "string", description: "Имя участника, которого блокируешь" },
    },
    required: ["target"],
  },
};

export interface StopToolResult {
  call: ActionCall;
  /** Ушедший персонаж (leave_scene): движок убирает его из ротации. */
  leftCharId?: number;
  /** Заблокированная пара (block_character): движок проверяет жизнеспособность сцены. */
  blockedPair?: { blockerId: number; blockedId: number };
  stateChanges: { characterId: number; key: string; value: unknown }[];
  relationChanges: { fromId: number; toId: number; value: number }[];
}

const mkCallId = (p: string) => `${p}_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6)}`;

/** Исполнение leave_scene: событие-уход видно всем, персонаж покидает сцену. */
export function executeLeave(input: {
  sceneId: number;
  turn: number;
  actor: Character;
  participants: Character[];
  args: Record<string, unknown>;
}): StopToolResult {
  const { sceneId, actor } = input;
  // Уход — навсегда: флаг в scene_characters исключает из ротации даже после
  // паузы/перезапуска сервера (снимается пересбором состава или сбросом сцены).
  // Широковещательный director не нужен: наблюдение действия «X уходит»
  // имеет аудиторию "all" и видно всем.
  setSceneLeftFlag(sceneId, actor.id);
  return {
    call: {
      callId: mkCallId("leave"),
      toolName: LEAVE_SCENE_TOOL_NAME,
      args: input.args,
      ok: true,
      result:
        "Ты покинул(а) сцену: твои ходы прекращаются, партнёры больше не смогут к тебе обращаться. Прощай.",
      observation: `${actor.name} уходит`,
      audience: "all",
    },
    leftCharId: actor.id,
    stateChanges: [],
    relationChanges: [],
  };
}

/** Исполнение block_character: пара замолкает, уведомления обеим сторонам. */
export function executeBlock(input: {
  sceneId: number;
  turn: number;
  actor: Character;
  participants: Character[];
  args: Record<string, unknown>;
}): StopToolResult {
  const { sceneId, turn, actor, participants, args } = input;
  const raw = String(args.target ?? "").trim().toLowerCase();
  const target =
    participants.find((p) => p.id !== actor.id && p.name.toLowerCase() === raw) ??
    participants.find((p) => p.id !== actor.id && p.name.toLowerCase().includes(raw)) ??
    null;
  const fail = (result: string): StopToolResult => ({
    call: {
      callId: mkCallId("block"),
      toolName: BLOCK_TOOL_NAME,
      args,
      ok: false,
      result,
      observation: "",
      audience: "none",
    },
    stateChanges: [],
    relationChanges: [],
  });
  if (!target) {
    const names = participants.filter((p) => p.id !== actor.id).map((p) => p.name).join(", ");
    return fail(`Участник "${String(args.target ?? "")}" не найден. Доступны: ${names}.`);
  }
  if (target.id === actor.id) return fail("Нельзя заблокировать себя.");
  addSceneBlock(sceneId, actor.id, target.id);
  getHub().emitEvent(
    appendEvent(getDb(), sceneId, turn, "director", null, [target.id], {
      text: `${actor.name} заблокировал(а) тебя: переписка прекращена. Больше не пиши ${actor.name} — сообщения не дойдут.`,
    })
  );
  return {
    call: {
      callId: mkCallId("block"),
      toolName: BLOCK_TOOL_NAME,
      args,
      ok: true,
      result: `Ты заблокировал(а) ${target.name}: вы больше не видите сообщения друг друга. ${
        participants.length <= 2 ? "Сцена завершается — общаться больше не с кем." : ""
      }`,
      observation: `${actor.name} блокирует ${target.name}`,
      audience: [actor.id, target.id],
    },
    blockedPair: { blockerId: actor.id, blockedId: target.id },
    stateChanges: [],
    relationChanges: [],
  };
}
