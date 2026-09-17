// Общение персонажей: сказать/написать можно ТОЛЬКО тулами. Свободный текст
// модели — внутренний монолог («мысли»): его видит только Архитектор, другие
// персонажи мысли не слышат (buildMessages чужую речь не реконструирует).
// say — фраза вслух (слышат все в сцене или один адресат),
// text_message — сообщение в переписке (телефон/чат, видит только получатель).

import type { Audience, Character, ToolSpec } from "./types";
import { SAY_TOOL_NAME, TEXT_TOOL_NAME } from "./types";
import { resolveTargetByName } from "./tools";

export const SAY_SPEC: ToolSpec = {
  name: SAY_TOOL_NAME,
  description:
    "Сказать фразу вслух — услышат все в сцене (или один человек, если указать to). " +
    "Это единственный способ быть услышанным: обычный текст — твои мысли, их никто не слышит.",
  parameters: {
    type: "object",
    properties: {
      phrase: { type: "string", description: "Что сказать (коротко, по-человечески)" },
      to: { type: "string", description: "Имя адресата (необязательно: без него — всем вслух)" },
    },
    required: ["phrase"],
  },
};

export const TEXT_SPEC: ToolSpec = {
  name: TEXT_TOOL_NAME,
  description:
    "Написать сообщение в переписку (телефон/мессенджер) — увидит только получатель. " +
    "Для общения на расстоянии: сайт знакомств, переписка между встречами.",
  parameters: {
    type: "object",
    properties: {
      text: { type: "string", description: "Текст сообщения (коротко)" },
      to: { type: "string", description: "Имя получателя" },
    },
    required: ["text", "to"],
  },
};

export interface ChatResult {
  ok: boolean;
  result: string;
  observation: string;
  audience: Audience;
}

/** say: фраза вслух. observation слышат все (или адресат). */
export function executeSay(input: {
  actor: Character;
  participants: Character[];
  args: Record<string, unknown>;
}): ChatResult {
  const { actor, participants, args } = input;
  const phrase = typeof args.phrase === "string" ? args.phrase.trim() : "";
  if (!phrase) {
    return {
      ok: false,
      result: "Пустая фраза: заполни параметр phrase — что именно сказать.",
      observation: "",
      audience: "none",
    };
  }
  const toRaw = args.to;
  if (toRaw !== undefined && String(toRaw).trim() !== "") {
    const target = resolveTargetByName(participants, toRaw);
    if (!target) {
      const names = participants.map((c) => c.name).join(", ");
      return {
        ok: false,
        result: `Адресат «${String(toRaw)}» не найден среди участников. Доступны: ${names}`,
        observation: "",
        audience: "none",
      };
    }
    return {
      ok: true,
      result: `Ты сказал(а) ${target.name}: «${phrase}».`,
      observation: `${actor.name} (тебе): «${phrase}»`,
      audience: [target.id],
    };
  }
  return {
    ok: true,
    result: `Ты сказал(а) вслух: «${phrase}».`,
    observation: `${actor.name}: «${phrase}»`,
    audience: "all",
  };
}

/** text_message: сообщение в переписке, видит только получатель. */
export function executeTextMessage(input: {
  actor: Character;
  participants: Character[];
  args: Record<string, unknown>;
}): ChatResult {
  const { actor, participants, args } = input;
  const text = typeof args.text === "string" ? args.text.trim() : "";
  const target = resolveTargetByName(participants, args.to);
  if (!text) {
    return {
      ok: false,
      result: "Пустое сообщение: заполни параметр text.",
      observation: "",
      audience: "none",
    };
  }
  if (!target) {
    const names = participants.map((c) => c.name).join(", ");
    return {
      ok: false,
      result: `Получатель «${String(args.to ?? "")}» не найден среди участников. Доступны: ${names}`,
      observation: "",
      audience: "none",
    };
  }
  return {
    ok: true,
    result: `Сообщение доставлено ${target.name}. Ответа пока нет: ${target.name} ответит в СВОЙ ход — не выдумывай его реплику и не пиши несколько сообщений подряд.`,
    observation: `📱 ${actor.name}: «${text}»`,
    audience: [target.id],
  };
}
