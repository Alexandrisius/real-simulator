// Скоринг: сверка последовательности tool-вызовов персонажа со схемой валидации.
// Семантика цепочки:
// - шаг засчитывается вхождением ПОСЛЕ всех предыдущих обязательных шагов;
// - вхождение раньше места в цепочке = нарушение со штрафом («поцелуй раньше кофе»);
// - необязательный шаг — бонус: пропустил, просто без баллов;
// - провал обязательного шага рвёт цепочку: дальнейшие шаги не засчитываются,
//   а их вхождения считаются нарушениями («от секса к кофе нельзя»);
// - запрещённый инструмент — нарушение за каждое вхождение.
// Персонажи о схемах не знают: оценка считается по логу событий в любой момент.

import type {
  CharacterScore,
  ScoreViolation,
  SimEvent,
  StepResult,
  ValidationSchema,
  ValidationStep,
} from "./types";
import {
  getCharacter,
  getSceneSchemas,
  getValidationSchema,
  listSceneEvents,
} from "@/db/queries";

interface FlatCall {
  toolName: string;
  args: Record<string, unknown>;
  turn: number;
  ok: boolean;
}

function flatCalls(events: SimEvent[], characterId: number): FlatCall[] {
  const out: FlatCall[] = [];
  for (const e of events) {
    if (e.type !== "action" || e.actorId !== characterId) continue;
    for (const c of e.payload.calls ?? []) {
      // Предложения (offered) — не исполненные действия: скоринг их не видит,
      // засчитывается только состоявшееся действие (в т.ч. по согласию).
      if (c.offered) continue;
      out.push({ toolName: c.toolName, args: c.args, turn: e.turn, ok: c.ok });
    }
  }
  return out;
}

/** Успешные вызовы инструментов персонажа (для условий переходов флоу). */
export function characterSuccessfulCalls(
  events: SimEvent[],
  characterId: number
): { toolName: string; args: Record<string, unknown>; turn: number }[] {
  return flatCalls(events, characterId).filter((c) => c.ok);
}

function stepMatches(step: ValidationStep, c: FlatCall): boolean {
  if (c.toolName !== step.toolName) return false;
  if (step.argContains && step.argContains.trim() !== "") {
    return JSON.stringify(c.args).includes(step.argContains.trim());
  }
  return true;
}

export function evaluateCharacter(
  events: SimEvent[],
  characterId: number,
  schema: ValidationSchema
): CharacterScore {
  const calls = flatCalls(events, characterId).filter((c) => c.ok);
  const violations: ScoreViolation[] = [];
  const steps: StepResult[] = [];

  // Статистика по всем успешным вызовам
  const toolStats: CharacterScore["toolStats"] = {};
  for (const c of calls) {
    const s = (toolStats[c.toolName] ??= { count: 0, firstTurn: c.turn, lastTurn: c.turn });
    s.count += 1;
    s.firstTurn = Math.min(s.firstTurn, c.turn);
    s.lastTurn = Math.max(s.lastTurn, c.turn);
  }

  // Запрещённые инструменты
  for (const c of calls) {
    if (schema.forbidden.includes(c.toolName)) {
      violations.push({
        toolName: c.toolName,
        turn: c.turn,
        reason: "запрещённый схемой инструмент",
      });
    }
  }

  // Проход по цепочке
  let progress = 0; // позиция, до которой цепочка уже засчитана
  let chainBroken = false;
  for (const step of schema.steps) {
    const needed = Math.max(1, step.minCount);
    let matched = 0;
    let firstMatchTurn: number | null = null;

    if (chainBroken) {
      // Цепочка оборвана: вхождения этого шага — нарушения
      for (let i = 0; i < calls.length; i++) {
        if (stepMatches(step, calls[i])) {
          violations.push({
            toolName: step.toolName,
            turn: calls[i].turn,
            reason: "цепочка уже оборвана обязательным шагом",
          });
        }
      }
      steps.push({
        toolName: step.toolName,
        required: step.required,
        satisfied: false,
        matched: 0,
        needed,
        points: step.points,
        earned: 0,
        firstMatchTurn: null,
      });
      continue;
    }

    // Вхождения ДО позиции цепочки — ранние вызовы (нарушения порядка)
    for (let i = 0; i < progress; i++) {
      if (stepMatches(step, calls[i])) {
        violations.push({
          toolName: step.toolName,
          turn: calls[i].turn,
          reason: "раньше, чем разрешено схемой",
        });
      }
    }
    // Вхождения начиная с текущей позиции цепочки
    for (let i = progress; i < calls.length; i++) {
      if (stepMatches(step, calls[i])) {
        if (firstMatchTurn === null) {
          firstMatchTurn = calls[i].turn;
          progress = i + 1; // цепочка двигается вперёд с первого вхождения
        }
        matched += 1;
      }
    }
    const satisfied = matched >= needed;
    if (step.required && !satisfied) chainBroken = true;

    steps.push({
      toolName: step.toolName,
      required: step.required,
      satisfied,
      matched,
      needed,
      points: step.points,
      earned: satisfied ? step.points : 0,
      firstMatchTurn,
    });
  }

  const maxScore = schema.steps.reduce((s, st) => s + st.points, 0);
  const earned = steps.reduce((s, st) => s + st.earned, 0);
  const penaltyTotal = schema.penalty * violations.length;
  const requiredSteps = steps.filter((st) => st.required);
  const requiredDone = requiredSteps.filter((st) => st.satisfied).length;

  return {
    characterId,
    schemaId: schema.id,
    schemaName: schema.name,
    steps,
    violations,
    score: earned - penaltyTotal,
    maxScore,
    completionPct:
      requiredSteps.length === 0
        ? 100
        : Math.round((requiredDone / requiredSteps.length) * 100),
    toolStats,
  };
}

/** Оценить всех участников сцены, у которых привязана схема. */
export function evaluateScene(sceneId: number): CharacterScore[] {
  const events = listSceneEvents(sceneId);
  const schemas = getSceneSchemas(sceneId);
  const out: CharacterScore[] = [];
  for (const [cid, sid] of Object.entries(schemas)) {
    const schema = getValidationSchema(sid);
    const character = getCharacter(Number(cid));
    if (!schema || !character) continue;
    out.push(evaluateCharacter(events, Number(cid), schema));
  }
  return out.sort((a, b) => b.score - a.score);
}
