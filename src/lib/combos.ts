// Комбо: скрытая последовательность успешных (исполненных, не предложений)
// вызовов, которая при точном порядке даёт неожиданный результат. Шаг может
// требовать конкретного исполнителя (actorName) или получателя (targetName) —
// так «поцелуй → массаж → смена позы С Яной» срабатывает только когда всё это
// делают С Яной, а не она сама партнёру. Кто знает рецепт (knowers) — видит
// его в своём промпте; пусто = рецепт не знает никто (секретное «достижение»).
// announce=true объявляет срабатывание всем участникам событием мира.
// Срабатывает один раз за сцену на комбо.

import type { Character, Combo, ComboStep, ToolEffect } from "./types";
import { RESPOND_TOOL_NAME } from "./types";
import {
  addChemistry,
  appendEvent,
  getCharacter,
  getChemistry,
  listAttributes,
  listCombos,
  updateCharacter,
} from "@/db/queries";
import { getDb } from "@/db";
import { getHub } from "./engine/hub";
import { applyRelationDelta, clampStateValues } from "./tools";

export interface ComboFiredInfo {
  combo: Combo;
  stateChanges: { characterId: number; key: string; value: unknown }[];
  relationChanges: { fromId: number; toId: number; value: number }[];
  /** Дописывается в tool-результат актёра */
  resultNote: string;
}

interface SeqItem {
  toolName: string;
  turn: number;
  actorId: number | null;
  targetName: string | null;
}

/** Уже сработавшие в сцене комбо (по payload.comboId в событиях). */
function firedComboIds(sceneId: number): Set<number> {
  const rows = getDb()
    .prepare("SELECT payload FROM events WHERE scene_id = ?")
    .all(sceneId) as unknown as { payload: string }[];
  const ids = new Set<number>();
  for (const r of rows) {
    try {
      const payload = JSON.parse(r.payload) as { comboId?: number };
      if (typeof payload.comboId === "number") ids.add(payload.comboId);
    } catch {
      // игнорируем битые
    }
  }
  return ids;
}

/**
 * Успешные (исполненные, не предложения) вызовы сцены по порядку — от всех
 * участников. Имя получателя: из targetId вызова (современные события) либо
 * по значению аргумента, совпавшему с именем участника (старые записи).
 */
function successfulSequence(sceneId: number): SeqItem[] {
  const participants = getDb()
    .prepare(
      "SELECT character_id FROM scene_characters WHERE scene_id = ?"
    )
    .all(sceneId)
    .map((r) => getCharacter(Number((r as { character_id: number | bigint }).character_id)))
    .filter((c): c is Character => c !== null);
  const byId = new Map(participants.map((p) => [p.id, p.name.toLowerCase()]));
  const rows = getDb()
    .prepare(
      "SELECT turn, actor_id, payload FROM events WHERE scene_id = ? AND type = 'action' ORDER BY id ASC"
    )
    .all(sceneId) as unknown as { turn: number; actor_id: number | null; payload: string }[];
  const out: SeqItem[] = [];
  for (const r of rows) {
    try {
      const payload = JSON.parse(r.payload) as {
        calls?: {
          toolName: string;
          ok: boolean;
          offered?: boolean;
          targetId?: number;
          args?: Record<string, unknown>;
        }[];
      };
      for (const c of payload.calls ?? []) {
        if (!c.ok || c.offered === true) continue;
        if (c.toolName === RESPOND_TOOL_NAME) continue; // мета-действие, не часть цепочек
        let targetName: string | null = null;
        if (typeof c.targetId === "number" && byId.has(c.targetId)) {
          targetName = byId.get(c.targetId)!;
        } else {
          // Легаси-события без targetId: ищем аргумент, совпадающий с именем участника
          for (const v of Object.values(c.args ?? {})) {
            if (typeof v === "string") {
              const hit = participants.find(
                (p) => p.name.toLowerCase() === v.trim().toLowerCase()
              );
              if (hit) {
                targetName = hit.name.toLowerCase();
                break;
              }
            }
          }
        }
        out.push({
          toolName: c.toolName,
          turn: r.turn,
          actorId: r.actor_id == null ? null : Number(r.actor_id),
          targetName,
        });
      }
    } catch {
      // игнорируем битые
    }
  }
  return out;
}

/** Применить эффекты комбо (как эффекты тула: self→актёр, tool_target→цель, relation/химия). */
function applyComboEffects(
  effects: ToolEffect[],
  actor: Character,
  target: Character | null
): Pick<ComboFiredInfo, "stateChanges" | "relationChanges"> {
  const stateChanges: ComboFiredInfo["stateChanges"] = [];
  const relationChanges: ComboFiredInfo["relationChanges"] = [];
  const states = new Map<number, Record<string, unknown>>();
  const stateOf = (c: Character) => {
    let s = states.get(c.id);
    if (!s) {
      s = { ...c.state };
      states.set(c.id, s);
    }
    return s;
  };
  for (const eff of effects) {
    const delta = typeof eff.value === "number" ? eff.value : Number(eff.value) || 0;
    if (eff.target === "relation") {
      if (!target || target.id === actor.id) continue;
      const next = applyRelationDelta(actor.id, target.id, eff.op, delta);
      relationChanges.push({ fromId: target.id, toId: actor.id, value: next });
      continue;
    }
    if (eff.target === "chemistry") {
      if (!target || target.id === actor.id) continue;
      const cur = getChemistry(actor.id, target.id);
      const next = eff.op === "set" ? delta : cur + delta;
      const clamped = Math.max(-3, Math.min(3, next));
      if (clamped !== cur) addChemistry(actor.id, target.id, clamped - cur);
      continue;
    }
    const who = eff.target === "self" ? actor : target;
    if (!who) continue;
    const s = stateOf(who);
    if (eff.op === "set") {
      s[eff.key] = eff.value;
    } else {
      const curVal = typeof s[eff.key] === "number" ? (s[eff.key] as number) : 0;
      s[eff.key] = curVal + delta;
    }
    stateChanges.push({ characterId: who.id, key: eff.key, value: s[eff.key] });
  }
  const defs = listAttributes();
  states.forEach((state, id) => {
    updateCharacter(id, { state: clampStateValues(state, defs) });
  });
  return { stateChanges, relationChanges };
}

const stepHasRoles = (s: ComboStep) => Boolean(s.actorName || s.targetName);

/**
 * Шаг комбо подходит вызову: инструмент совпадает и роли (если заданы) тоже.
 */
function stepMatchesCall(step: ComboStep, c: SeqItem): boolean {
  if (c.toolName !== step.toolName) return false;
  if (step.actorName && (c.actorId == null || !nameEq(step.actorName, c.actorId))) return false;
  if (
    step.targetName &&
    (c.targetName == null || c.targetName !== step.targetName.trim().toLowerCase())
  )
    return false;
  return true;
}

/**
 * Проверка после каждого успешного действия: если хвост последовательности
 * вызовов совпал с шагами комбо (в пределах windowTurns) — комбо срабатывает.
 * Текущий вызов передаётся явно: его событие ещё не записано.
 *
 * Реальные сцены «болтают»: между шагами реплики (say), шутки и чужие
 * действия. Хвост поэтому ищется не по всем вызовам подряд, а по ПРОЕКЦИИ
 * последовательности на релевантные вызовы: остаются только те, чей
 * инструмент встречается в шагах комбо и чьи роли подходят хоть к одному
 * шагу с этим инструментом (не туда направленный шаг из цепочки вылетает,
 * но её не рвёт). Если ни у одного шага нет фильтров ролей — работает
 * легаси-правило: вся цепочка должна принадлежать одному актёру.
 */
export function checkCombos(params: {
  sceneId: number;
  turn: number;
  actor: Character;
  toolName: string;
  target: Character | null;
}): ComboFiredInfo[] {
  const combos = listCombos();
  if (combos.length === 0) return [];
  const fired = firedComboIds(params.sceneId);
  const past = successfulSequence(params.sceneId);
  const current: SeqItem = {
    toolName: params.toolName,
    turn: params.turn,
    actorId: params.actor.id,
    targetName: params.target ? params.target.name.toLowerCase() : null,
  };
  const out: ComboFiredInfo[] = [];
  for (const combo of combos) {
    if (combo.steps.length < 2) continue;
    if (fired.has(combo.id)) continue;
    if (combo.steps[combo.steps.length - 1].toolName !== params.toolName) continue;
    const k = combo.steps.length;
    // Проекция: релевантные данному комбо вызовы (шум не рвёт цепочку).
    const roleFiltered = combo.steps.some(stepHasRoles);
    const relevant = (c: SeqItem) =>
      combo.steps.some((step) => c.toolName === step.toolName && (!stepHasRoles(step) || stepMatchesCall(step, c)));
    const seq = [...past, current].filter(relevant);
    if (seq.length < k) continue;
    const tail = seq.slice(-k);
    const match = tail.every((s, i) => stepMatchesCall(combo.steps[i], s));
    if (!match) continue;
    // Без фильтров ролей — вся цепочка от одного актёра (как раньше).
    if (!roleFiltered && new Set(tail.map((s) => s.actorId)).size !== 1) continue;
    if (tail[k - 1].turn - tail[0].turn > combo.windowTurns) continue;
    const { stateChanges, relationChanges } = applyComboEffects(
      combo.effects,
      params.actor,
      params.target
    );
    const announceText = `Комбо «${combo.title}»: ${combo.description}`;
    if (combo.announce) {
      // «Достижение открыто»: событие мира для всех участников сцены.
      getHub().emitEvent(
        appendEvent(getDb(), params.sceneId, params.turn, "director", null, "all", {
          text: `✨ ${announceText}`,
          comboId: combo.id,
        })
      );
    } else {
      getHub().emitEvent(
        appendEvent(getDb(), params.sceneId, params.turn, "director", null, [params.actor.id], {
          text: announceText,
          comboId: combo.id,
        })
      );
    }
    if (stateChanges.length > 0) getHub().emitParticipants(params.sceneId);
    out.push({
      combo,
      stateChanges,
      relationChanges,
      resultNote: ` | Комбо «${combo.title}» сработало! ${combo.description}`,
    });
  }
  return out;
}

/** Сравнение имени шага с актёром события (по id персонажа). */
function nameEq(stepActorName: string, actorId: number): boolean {
  const c = getCharacter(actorId);
  if (!c) return false;
  return c.name.toLowerCase() === stepActorName.trim().toLowerCase();
}
