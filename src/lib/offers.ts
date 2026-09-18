// Механика предложений и согласия: адресный тул с requiresConsent не
// исполняется сразу — актёр ПРЕДЛАГАЕТ, а цель в свой ход отвечает
// виртуальным инструментом respond_to_offer (принять/отказаться).
// Отказ уважается: повторные предложения пресекаются, давление не работает.
// Исполнение по согласию проходит тот же executeTool (границы и деньги
// проверяются повторно в момент согласия) — обхода физики нет.

import type {
  ActionCall,
  Character,
  Offer,
  Tool,
  ToolEffect,
  ToolSpec,
} from "./types";
import { RESPOND_TOOL_NAME } from "./types";
import type { ToolExecResult } from "./tools";
import { clampStateValues } from "./tools";import {
  appendEvent,
  createOffer,
  findRecentlyDeclinedOffer,
  getCharacter,
  getRelation,
  hasPendingOffer,
  listAttributes,
  listPendingOffersForCharacter,
  listTools,
  setOfferStatus,
  setRelation,
  updateCharacter,
} from "@/db/queries";
import { getDb } from "@/db";
import { getHub } from "./engine/hub";

/** Сколько ходов живёт предложение, пока цель молчит (потом сгорает). */
export const OFFER_TTL_TURNS = 6;

/** Спецификация виртуального тула ответа на предложение (enum id подставляет движок). */
export const RESPOND_TOOL_SPEC: ToolSpec = {
  name: RESPOND_TOOL_NAME,
  description:
    "Ответить на предложение, которое тебе сделали (см. секцию «Тебе предлагают» в промпте). " +
    "decision=accept — согласиться (действие произойдёт), decision=decline — отказаться. " +
    "В words можно коротко объяснить решение своей репликой. Пока есть актуальное предложение — ответь на него в этот ход.",
  parameters: {
    type: "object",
    properties: {
      offer: { type: "string", description: "id предложения из секции «Тебе предлагают», например \"3\"" },
      decision: { type: "string", enum: ["accept", "decline"] },
      words: { type: "string", description: "необязательная короткая реплика при ответе" },
    },
    required: ["offer", "decision"],
  },
};

const toolTitleOf = (name: string): string => {
  const t = listTools().find((x) => x.name === name);
  return t ? t.title || t.name : name;
};

/**
 * Создание предложения вместо исполнения тула. Вызывается из executeTool,
 * когда тул требует согласия: границы/деньги уже проверены вызовом выше,
 * здесь остаётся анти-давление и запись самого предложения.
 */
export function createOfferProposal(input: {
  tool: Tool;
  actor: Character;
  target: Character;
  args: Record<string, unknown>;
  sceneId: number;
  turn: number;
}): ToolExecResult {
  const { tool, actor, target, args, sceneId, turn } = input;
  const title = tool.title || tool.name;

  if (hasPendingOffer(sceneId, actor.id, target.id, tool.name)) {
    return {
      ok: false,
      result: `Ты уже предложил «${title}» — ${target.name} ещё не ответил(а). Не дублируй предложение, жди ответа.`,
      observation: "",
      audience: "none",
      stateChanges: [],
      relationChanges: [],
    };
  }
  const declinedRecently = findRecentlyDeclinedOffer(sceneId, actor.id, target.id, tool.name);
  if (declinedRecently) {
    return {
      ok: false,
      result:
        `${target.name} недавно уже отказывал(а) от «${title}». Настойчивость не помогает — ` +
        `меняй обстоятельства (разговор, подарок, место, время), а не давление.`,
      observation: "",
      audience: "none",
      stateChanges: [],
      relationChanges: [],
    };
  }

  const created = createOffer(sceneId, actor.id, target.id, tool.name, args, turn, turn + OFFER_TTL_TURNS);
  return {
    ok: true,
    offered: true,
    offerId: created.id,
    result:
      `Предложение отправлено: «${title}» → ${target.name}. Действие произойдёт, только если ` +
      `${target.name} согласится в свой ход. Продолжай общение, не повторяй предложение.`,
    observation: `${actor.name} предлагает ${target.name}: «${title}»`,
    audience: [actor.id, target.id],
    stateChanges: [],
    relationChanges: [],
  };
}

/** Короткая сводка предложения для промпта: «#3 „Поцелуй“ от Димы». */
export function offerShortLine(offer: Offer, nameOf: (id: number) => string): string {
  return `#${offer.id} «${toolTitleOf(offer.toolName)}» от ${nameOf(offer.fromId)}`;
}

/** Применить эффекты отказа: как у границ — только отказывающийся и его чувства. */
function applyDeclineEffects(
  effects: ToolEffect[],
  proposer: Character,
  responder: Character
): Pick<ToolExecResult, "stateChanges" | "relationChanges"> {
  const stateChanges: ToolExecResult["stateChanges"] = [];
  const relationChanges: ToolExecResult["relationChanges"] = [];
  const state = { ...responder.state };
  let dirty = false;
  for (const eff of effects) {
    const delta = typeof eff.value === "number" ? eff.value : Number(eff.value) || 0;
    if (eff.target === "relation") {
      const next = eff.op === "set" ? delta : getRelation(responder.id, proposer.id) + delta;
      setRelation(responder.id, proposer.id, next);
      relationChanges.push({ fromId: responder.id, toId: proposer.id, value: next });
      continue;
    }
    // self и tool_target здесь одно и то же: состояние отказывающегося.
    if (eff.op === "set") {
      state[eff.key] = eff.value;
    } else {
      const curVal = typeof state[eff.key] === "number" ? (state[eff.key] as number) : 0;
      state[eff.key] = curVal + delta;
    }
    stateChanges.push({ characterId: responder.id, key: eff.key, value: state[eff.key] });
    dirty = true;
  }
  if (dirty) {
    updateCharacter(responder.id, { state: clampStateValues(state, listAttributes()) });
  }
  return { stateChanges, relationChanges };
}

export interface RespondResult {
  call: ActionCall;
  stateChanges: ToolExecResult["stateChanges"];
  relationChanges: ToolExecResult["relationChanges"];
}

/**
 * Хук движка после успешного исполнения принятого тула: сюда вешается
 * проверка комбо (исполнение по согласию — полноправный шаг цепочки).
 * Возвращает дописку к результату и накопленные эффекты комбо.
 */
export type OnOfferExecuted = (
  tool: Tool,
  actor: Character,
  ex: ToolExecResult
) => { note: string; stateChanges: ToolExecResult["stateChanges"]; relationChanges: ToolExecResult["relationChanges"] };

/**
 * Ответ на предложение (виртуальный тул respond_to_offer). Исполнение
 * принятого тула делегировано колбэку execTool — движок передаёт executeTool
 * с skipConsent, чтобы тот же путь границы/деньги/эффекты работал ещё раз.
 */
export function executeRespond(input: {
  sceneId: number;
  turn: number;
  responder: Character;
  participants: Character[];
  args: Record<string, unknown>;
  execTool: (tool: Tool, actor: Character, args: Record<string, unknown>) => ToolExecResult;
  onExecuted?: OnOfferExecuted;
}): RespondResult {
  const { sceneId, turn, responder, participants, args, execTool } = input;
  const db = getDb();
  const mkCallId = () => `resp_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6)}`;
  const none = (result: string): RespondResult => ({
    call: {
      callId: mkCallId(),
      toolName: RESPOND_TOOL_NAME,
      args,
      ok: false,
      result,
      observation: "",
      audience: "none",
    },
    stateChanges: [],
    relationChanges: [],
  });

  const decision = String(args.decision ?? "").trim().toLowerCase();
  if (decision !== "accept" && decision !== "decline") {
    return none('Параметр decision должен быть "accept" или "decline".');
  }
  const rawId = String(args.offer ?? "").trim().replace(/^#/, "");
  const pending = listPendingOffersForCharacter(sceneId, responder.id);
  const offer = pending.find((o) => String(o.id) === rawId);
  if (!offer) {
    const list = pending.map((o) => `#${o.id} («${toolTitleOf(o.toolName)}»)`).join(", ") || "(нет)";
    return none(
      `Предложение "${String(args.offer ?? "")}" не найдено (или на него уже ответили). Актуальные: ${list}.`
    );
  }
  const words = typeof args.words === "string" ? args.words.trim().slice(0, 200) : "";
  const title = toolTitleOf(offer.toolName);
  const proposer = getCharacter(offer.fromId);
  const proposerStillHere = proposer != null && participants.some((p) => p.id === proposer.id);

  if (!proposer || !proposerStillHere) {
    setOfferStatus(offer.id, "expired", null);
    return none("Автор предложения больше не в сцене — предложение сгорело.");
  }

  if (decision === "decline") {
    setOfferStatus(offer.id, "declined", words || null);
    const tool = listTools().find((t) => t.name === offer.toolName);
    const { stateChanges, relationChanges } = applyDeclineEffects(
      tool?.declineEffects ?? [],
      proposer,
      responder
    );
    // Отдельный director-уведомитель автору не нужен: наблюдение самого
    // respond_to_offer («...отвечает отказ») видно обоим участникам пары.
    return {
      call: {
        callId: mkCallId(),
        toolName: RESPOND_TOOL_NAME,
        args,
        ok: true,
        result: `Ты отказался(ась) от «${title}» от ${proposer.name}.${
          stateChanges.length > 0
            ? ` Твоё состояние изменилось: ${stateChanges.map((c) => `${c.key}=${JSON.stringify(c.value)}`).join(", ")}.`
            : ""
        }`,
        observation: `${responder.name} отвечает ${proposer.name} на «${title}»: отказ${words ? ` — «${words}»` : ""}`,
        audience: [proposer.id, responder.id],
      },
      stateChanges,
      relationChanges,
    };
  }

  // Согласие: исполняем тул от имени автора предложения — той же дорогой
  // (границы проверяются снова в момент согласия, деньги списываются тут же).
  const tool = listTools().find((t) => t.name === offer.toolName);
  if (!tool) {
    setOfferStatus(offer.id, "expired", null);
    return none(`Инструмент «${offer.toolName}» больше не существует — предложение сгорело.`);
  }
  const ex = execTool(tool, proposer, offer.args);
  if (!ex.ok) {
    // Согласилась, но мир отказал (границы/деньги): предложение снято обстоятельствами.
    setOfferStatus(offer.id, "declined", "границы/обстоятельства не позволили");
    getHub().emitEvent(
      appendEvent(db, sceneId, turn, "action", proposer.id, ex.audience, {
        iteration: -1,
        calls: [
          {
            callId: `offer_${offer.id}`,
            toolName: tool.name,
            args: offer.args,
            ok: false,
            result: ex.result,
            observation: ex.observation,
            audience: ex.audience,
          },
        ],
        offerId: offer.id,
      })
    );
    return {
      call: {
        callId: mkCallId(),
        toolName: RESPOND_TOOL_NAME,
        args,
        ok: true,
        result: `Ты согласилась на «${title}», но обстоятельства не позволили: ${ex.result}`,
        observation: "",
        audience: [responder.id],
      },
      stateChanges: ex.stateChanges,
      relationChanges: ex.relationChanges,
    };
  }

  setOfferStatus(offer.id, "accepted", words || null);
  // Комбо: исполнение по согласию — тоже шаг цепочки (например, поцелуй
  // «по предложению» должен замыкать последовательность не хуже прямого).
  const combo = input.onExecuted?.(tool, proposer, ex) ?? {
    note: "",
    stateChanges: [],
    relationChanges: [] as ToolExecResult["relationChanges"],
  };
  // Действие исполнено: событие от имени автора, аудитория тула + оба участника.
  const audienceIds = new Set<number>([proposer.id, responder.id]);
  if (Array.isArray(ex.audience)) ex.audience.forEach((id) => audienceIds.add(id));
  const audience = ex.audience === "all" ? "all" : [...audienceIds];
  getHub().emitEvent(
    appendEvent(db, sceneId, turn, "action", proposer.id, audience, {
      iteration: -1,
      calls: [
        {
          callId: `offer_${offer.id}`,
          toolName: tool.name,
          args: offer.args,
          ok: true,
          result: ex.result + combo.note,
          observation: ex.observation,
          audience,
          outcome: ex.outcome?.outcomeId,
          targetId: ex.targetId,
        },
      ],
      stateChanges:
        ex.stateChanges.length > 0 || combo.stateChanges.length > 0
          ? [...ex.stateChanges, ...combo.stateChanges]
          : undefined,
      relationChanges:
        ex.relationChanges.length > 0 || combo.relationChanges.length > 0
          ? [...ex.relationChanges, ...combo.relationChanges]
          : undefined,
      offerId: offer.id,
    })
  );
  if (ex.outcome) {
    getHub().emitEvent(
      appendEvent(db, sceneId, turn, "director", null, [ex.outcome.targetId], {
        text: ex.outcome.noticeTarget,
      })
    );
  }
  if (ex.stateChanges.length > 0 || combo.stateChanges.length > 0) getHub().emitParticipants(sceneId);
  return {
    call: {
      callId: mkCallId(),
      toolName: RESPOND_TOOL_NAME,
      args,
      ok: true,
      result: `Ты согласилась: «${title}» состоялось.${ex.outcome ? ` Исход: «${ex.outcome.title}».` : ""}${combo.note}`,
      observation: `${responder.name} принимает предложение ${proposer.name}: «${title}»${words ? `. «${words}»` : ""}`,
      audience: [proposer.id, responder.id],
    },
    stateChanges: combo.stateChanges,
    relationChanges: combo.relationChanges,
  };
}
