// Машиночитаемые условия завершения сцены: все условия проверяются по «И»
// после каждого сыгранного хода. Когда выполнены — сцена доигрывается ещё
// delayTurns ходов (чтобы «процесс» успел случиться и его можно было читать),
// затем движок завершает её сам. Считаем только реально исполненные вызовы
// (предложения — offered — не засчитываются).

import type { SceneFinishConfig } from "./types";
import { getCharacter, getSceneParticipants } from "@/db/queries";
import { getDb } from "@/db";

interface CallRow {
  actorId: number | null;
  turn: number;
  calls: { toolName: string; ok: boolean; offered?: boolean; outcome?: string }[];
}

/** Все action-вызовы сцены (упорядочены по id). */
export function sceneCalls(sceneId: number): CallRow[] {
  const rows = getDb()
    .prepare("SELECT actor_id, turn, payload FROM events WHERE scene_id = ? AND type = 'action' ORDER BY id ASC")
    .all(sceneId) as unknown as { actor_id: number | null; turn: number; payload: string }[];
  const out: CallRow[] = [];
  for (const r of rows) {
    try {
      const payload = JSON.parse(r.payload) as { calls?: CallRow["calls"] };
      if (payload.calls?.length) out.push({ actorId: r.actor_id, turn: r.turn, calls: payload.calls });
    } catch {
      // битый payload пропускаем
    }
  }
  return out;
}

function executedCallExists(
  sceneId: number,
  pred: (toolName: string) => boolean,
  actorId: number | null
): boolean {
  return sceneCalls(sceneId).some((row) =>
    (actorId == null || row.actorId === actorId) &&
    row.calls.some((c) => c.ok && c.offered !== true && pred(c.toolName))
  );
}

/** Выполнены ли ВСЕ условия завершения сцены прямо сейчас. */
export function finishConditionsSatisfied(sceneId: number, config: SceneFinishConfig): boolean {
  for (const cond of config.conditions) {
    if (cond.type === "toolCall") {
      if (!executedCallExists(sceneId, (n) => n === cond.toolName, cond.characterId ?? null)) {
        return false;
      }
    } else if (cond.type === "outcome") {
      const rows = sceneCalls(sceneId);
      const hit = rows.some(
        (row) =>
          (cond.characterId == null || row.actorId === cond.characterId) &&
          row.calls.some(
            (c) => c.ok && c.offered !== true && c.toolName === cond.toolName && c.outcome === cond.outcomeId
          )
      );
      if (!hit) return false;
    } else {
      // state: заданный персонаж (или хоть кто-то из участников)
      const ids = cond.characterId != null ? [cond.characterId] : getSceneParticipants(sceneId);
      const ok = ids.some((id) => {
        const c = getCharacter(id);
        if (!c) return false;
        const v = c.state[cond.key];
        const num = typeof v === "number" ? v : 0;
        if (cond.op === ">=") return num >= cond.value;
        if (cond.op === "<") return num < cond.value;
        return num === cond.value;
      });
      if (!ok) return false;
    }
  }
  return config.conditions.length > 0;
}
