// Сборка контекста для каждого агента: system prompt из персонажа и сцены
// + реконструкция видимой ему истории событий в формат чата OpenAI.
// Каждый агент видит только то, что должен видеть (личные сообщения,
// публичные события, собственные действия), — как человек в реальной жизни.
//
// Инвариант эпистемики: истина о скрытых характеристиках других участников
// НЕ попадает в промпт без verified-записи в картине мира наблюдателя.
// Публичные характеристики показываются истиной; скрытые — только со слов
// (claimed) или как увиденное лично (verified).

import type {
  AttributeDef,
  Character,
  ChatMessage,
  KnowledgeEntry,
  Scene,
  SimEvent,
} from "./types";
import {
  CARRIED_PREFIX,
  REQUEST_TOOL_NAME,
  REVEAL_TOOL_NAME,
  UNDRESS_TOOL_NAME,
  WEAR_TOOL_NAME,
  WORN_PREFIX,
} from "./types";
import { getSetting } from "@/db/queries";

export interface BuildContextOptions {
  character: Character;
  scene: Scene;
  /** Все участники сцены в порядке очерёдности */
  participants: Character[];
  /** Видимые персонажу события (уже отфильтрованы) */
  events: SimEvent[];
  turn: number;
  /** Личная цель персонажа в этой сцене (остальные о ней не знают) */
  goal?: string | null;
  /** Есть ли у персонажа платные инструменты / деньги (для правил экономики) */
  hasPricedTools?: boolean;
  /** Есть ли товары в магазине (для правил магазина) */
  hasShop?: boolean;
  /** Реестр характеристик (для публичных/скрытых строк об участниках) */
  attributeDefs?: AttributeDef[];
  /** Отношения персонажа к другим: [{toId, value}] */
  relations?: { toId: number; value: number }[];
  /** Картина мира персонажа-наблюдателя (записи knowledge) */
  knowledge?: KnowledgeEntry[];
  /** Есть ли скрытые характеристики в мире (доступен reveal_attribute) */
  hasHiddenAttributes?: boolean;
  /** Моделируется ли одежда (доступны undress/wear) */
  hasClothing?: boolean;
}

/**
 * Редактируемые текстовые секции системного промпта. Хранятся в settings
 * (ключ prompt.<id>); пустое значение = дефолт. Подстановки:
 * {name} — имя персонажа, {request_tool}/{reveal_tool}/{undress_tool}/{wear_tool}.
 */
export const PROMPT_SECTIONS: { key: string; title: string; hint: string; def: string }[] = [
  {
    key: "preamble",
    title: "Преамбула",
    hint: "первая строка промпта — кто такой агент",
    def: "Ты — живой человек и играешь роль персонажа в симуляции социальных отношений. Полностью останься в образе.",
  },
  {
    key: "rules_reply",
    title: "Правила: как отвечать",
    hint: "подстановка {name} — имя персонажа",
    def: `# Как отвечать
- Ты видишь историю сцены: реплики и действия участников, которые тебе видны. Личные сообщения приходят только тебе.
- Отвечай СТРОГО от лица {name}: соблюдай характер, манеру речи и цели персонажа.
- Хочешь сказать — просто напиши реплику текстом. Хочешь что-то сделать — вызови подходящий инструмент (function calling). Можно совмещать: действие + реплика.
- Никогда не пиши реплики и действия за других персонажей и не выдумывай события, которых не было.
- Реагируй на происходящее естественно, помни всё, что уже произошло.`,
  },
  {
    key: "rules_actions",
    title: "Правила: действия",
    hint: "почему всё делается инструментами",
    def: `# Правила этого мира: действия
- Инструментами делается то, что МЕНЯЕТ мир: характеристики (настроение, внешность, деньги…), отношения людей, состояние одежды, шансы в цели. Такие действия словами не считаются — пока инструмент не вызван, ничего не произошло.
- Атмосфера, разговоры, эмоции, флирт в чате — отыгрывай обычными репликами, инструменты для этого не нужны. Специальных тулов «написать сообщение» в этом мире нет: то, что ты пишешь в чат, и есть сообщение.
- Не дублируй: совершил действие инструментом — его текст уже случился, не повторяй его же репликой.
- Доступные тебе инструменты перечислены в вызове функции. Если нужного значимого действия среди них нет — попроси его через {request_tool} (если доступно) или добивайся цели тем, что есть.`,
  },
  {
    key: "rules_tool_requests",
    title: "Правила: заявки на новые инструменты",
    hint: "показывается, когда в сцене включены заявки; {request_tool} — имя инструмента",
    def: `# Правила этого мира: новые возможности
- Если для твоей ЦЕЛИ нужно действие, которое меняет характеристики, отношения или деньги, а такого инструмента у тебя нет — попроси Архитектора создать его: вызови {request_tool} с черновиком (имя, параметры, кому видно, как выглядит для остальных, эффекты на характеристики).
- Заявляй только действия, которые реально двигают тебя к цели и пригодятся больше одного раза — не проси инструмент ради одного красивого жеста. Бытовщину отыгрывай словами.
- Архитектор — тот, кто ведёт эту симуляцию. Он рассмотрит заявку и ответит событием; продолжай сцену доступными средствами, не жди на месте.
- Прося инструмент, помни: он должен помогать отыгрывать роль, а не ломать её. Товары заявками не создаются — смотри магазин.`,
  },
  {
    key: "rules_money",
    title: "Правила: деньги",
    hint: "показывается при платных инструментах или деньгах в state",
    def: `# Правила этого мира: деньги
- У тебя есть деньги — смотри ключ money в своём состоянии. Часть действий стоит денег: цена указана в описании инструмента.
- Действие без нужной суммы не выполнится — трать разумно и планируй: доход появляется со временем, а не из воздуха.`,
  },
  {
    key: "rules_shop",
    title: "Правила: магазин",
    hint: "показывается, когда в магазине есть товары",
    def: `# Правила этого мира: магазин
- В этом мире есть магазин. Бесплатно посмотри ассортимент и цены — инструмент shop_browse.
- Покупка — shop_buy с точным названием товара; деньги спишутся, при нехватке откажут. Реши, что тебе действительно нужно, и соотнеси с бюджетом.
- Подарок другому — тот же shop_buy с именем получателя в параметре for: эффекты подарка подействуют на него.
- Некоторые товары действуют не сразу, а через несколько сцен: деньги уходят сейчас, а эффект наступит, только если ты дойдёшь до тех сцен в сценарии. Взвешивай: маленькая выгода сейчас или большая — в перспективе.`,
  },
  {
    key: "rules_hidden",
    title: "Правила: скрытое и репутация",
    hint: "показывается при наличии скрытых характеристик; {reveal_tool} — имя инструмента",
    def: `# Правила этого мира: скрытое и репутация
- Часть характеристик людей в этом мире скрыта: их не видно, пока сам человек не расскажет или не покажет.
- О своей характеристике можно заявить через инструмент {reveal_tool} — вслух, лично или всем. Окружающие запомнят со твоих слов… и не обязательно поверят.
- Заявить можно что угодно — и правду, и ложь. Но ложь вскрывается при личной проверке, и тогда доверие падает. Решай, что выгоднее.`,
  },
  {
    key: "rules_clothing",
    title: "Правила: одежда",
    hint: "показывается при наличии слотов одежды; {undress_tool}/{wear_tool}",
    def: `# Правила этого мира: одежда
- Одежда моделируется слотами (какие именно — см. свои ключи worn_* в состоянии). Снять предмет — инструмент {undress_tool}, надеть обратно — {wear_tool}.
- Обнажаться можно не везде: место сцены имеет значение. И порядок естественный: верхнее снимается раньше нижнего.
- Снятое остаётся при тебе. Помни: то, что под одеждой, окружающие узнают только увидев.
- Твою одежду определяют ТОЛЬКО ключи worn_*: репликами она не меняется. Не описывай в словах, что ты разделся или оделся, — пока ключ не пуст, ты в одежде, и наоборот.`,
  },
];

const SECTION_BY_KEY = new Map(PROMPT_SECTIONS.map((s) => [s.key, s]));

/** Текст секции с учётом override из настроек + подстановки плейсхолдеров. */
function sectionText(key: string, character: Character): string {
  const meta = SECTION_BY_KEY.get(key)!;
  const raw = getSetting("prompt." + key) ?? meta.def;
  return raw
    .replaceAll("{name}", character.name)
    .replaceAll("{request_tool}", REQUEST_TOOL_NAME)
    .replaceAll("{reveal_tool}", REVEAL_TOOL_NAME)
    .replaceAll("{undress_tool}", UNDRESS_TOOL_NAME)
    .replaceAll("{wear_tool}", WEAR_TOOL_NAME);
}
/**
 * Значение числовой характеристики для промпта: единица + диапазон.
 * «Из N» показываем только для оценочных шкал (навыки, настроение — где
 * важно «насколько из скольки»); физические величины (рост, вес, деньги)
 * печатаются значением и единицей. Единица с цифрами ('ур. 0–10') или
 * слэшем ('/10') самодостаточна — ничего не дописываем.
 */
function formatAttrValue(def: AttributeDef, v: number): string {
  const unit = def.unit.trim();
  if (unit.includes("/")) return `${v}${unit}`; // 8/10
  if (/\d/.test(unit)) return `${v} ${unit}`; // 4 ур. 0–10
  const scale = def.max != null && def.max <= 20;
  if (unit === "") return scale ? `${v} из ${def.max}` : `${v}`;
  return scale ? `${v} ${unit} из ${def.max}` : `${v} ${unit}`;
}

/**
 * Собственное состояние персонажа — человеческим языком, по реестру:
 * лейбл, единицы, диапазон. Навыки помечаются явно, одежда группируется.
 */
function formatState(state: Record<string, unknown>, defs: AttributeDef[]): string {
  const byKey = new Map(defs.map((d) => [d.key, d]));
  const lines: string[] = [];
  const worn: string[] = [];
  const carried: string[] = [];
  for (const [k, v] of Object.entries(state)) {
    if (k.startsWith(WORN_PREFIX)) {
      if (v !== "" && v != null) worn.push(`${k.slice(WORN_PREFIX.length)} — ${v}`);
      continue;
    }
    if (k.startsWith(CARRIED_PREFIX)) {
      if (v !== "" && v != null) carried.push(`${k.slice(CARRIED_PREFIX.length)} — ${v}`);
      continue;
    }
    const def = byKey.get(k);
    if (!def) {
      lines.push(`${k}: ${JSON.stringify(v)}`);
      continue;
    }
    const label = k.startsWith("skill_") ? `навык «${def.label}»` : def.label.toLowerCase();
    if (def.type === "number" && typeof v === "number") {
      lines.push(`${label}: ${formatAttrValue(def, v)}`);
    } else {
      lines.push(`${label}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
    }
  }
  if (worn.length > 0) lines.push(`надето: ${worn.join(", ")}`);
  if (carried.length > 0) lines.push(`снято, при тебе: ${carried.join(", ")}`);
  if (lines.length === 0) return "(пусто)";
  return lines.join("\n");
}

/** Предел публичных характеристик одного участника в промпте (защита контекста). */
const PUBLIC_ATTR_LIMIT = 8;

/**
 * Строка характеристик участника для чужого промпта: публичные — истиной,
 * скрытые — только из картины мира наблюдателя (claimed со слов, verified
 * как увиденное). Истина о скрытом без verified не показывается никогда.
 */
function participantAttrLine(
  who: Character,
  defs: AttributeDef[],
  knowledge: KnowledgeEntry[]
): string {
  const parts: string[] = [];
  let shown = 0;
  for (const def of defs) {
    if (def.key === "money") continue; // чужие деньги не подсматриваются
    if (shown >= PUBLIC_ATTR_LIMIT) break;
    if (def.visibility === "hidden") {
      const entry = knowledge.find((k) => k.subjectId === who.id && k.key === def.key);
      if (!entry) continue; // нет записи — характеристика не существует для наблюдателя
      const label = def.label;
      parts.push(
        entry.status === "verified"
          ? `${label}: ${entry.value} (видел(а) лично)`
          : `${label}: по словам ${who.name} — ${entry.value} (не проверено)`
      );
      shown += 1;
    } else {
      const v = who.state[def.key];
      if (v === undefined || v === null || v === "") continue;
      if (def.type === "number" && typeof v === "number") {
        parts.push(`${def.label}: ${formatAttrValue(def, v)}`);
      } else {
        parts.push(`${def.label}: ${String(v)}`);
      }
      shown += 1;
    }
  }
  return parts.length > 0 ? ` — ${parts.join(", ")}` : "";
}

export function buildSystemPrompt(opts: BuildContextOptions): string {
  const { character, scene, participants, goal } = opts;
  const others = participants.filter((p) => p.id !== character.id);
  const parts: string[] = [];
  const defs = opts.attributeDefs ?? [];
  const knowledge = opts.knowledge ?? [];

  const placeLine = scene.config.place?.trim() ? `\nМесто: ${scene.config.place.trim()}` : "";

  parts.push(
    sectionText("preamble", character),
    `# Твой персонаж\nИмя: ${character.name}\n${
      character.persona.trim() || "(описание не задано)"
    }`,
    `# Сцена\n${scene.setting.trim() || "(без описания)"}${placeLine}`,
    `# Участники сцены\n${participants
      .map(
        (p) =>
          `- ${p.emoji} ${p.name}${
            p.id === character.id ? " (это ты)" : participantAttrLine(p, defs, knowledge)
          }`
      )
      .join("\n")}${
      others.length === 0 ? "" : `\nВсего вас ${participants.length}.`
    }`,
    `# Твоё текущее состояние (видно только тебе)\n${formatState(character.state, defs)}`,
    sectionText("rules_reply", character),
    sectionText("rules_actions", character)
  );

  if (opts.relations && opts.relations.length > 0) {
    const nameById = new Map(participants.map((p) => [p.id, p.name]));
    const lines = opts.relations
      .filter((r) => nameById.has(r.toId))
      .map((r) => `- ${nameById.get(r.toId)!}: ${r.value}`);
    if (lines.length > 0) {
      parts.push(
        `# Твоё отношение к другим\n${lines.join(
          "\n"
        )}\nЭто твои чувства (чем выше — тем ты благосклоннее). Отношения других к тебе ты не видишь — только их поступки.`
      );
    }
  }

  if (scene.config.allowToolRequests) {
    parts.push(sectionText("rules_tool_requests", character));
  }

  if (opts.hasPricedTools) {
    parts.push(sectionText("rules_money", character));
  }

  if (opts.hasShop) {
    parts.push(sectionText("rules_shop", character));
  }

  if (opts.hasHiddenAttributes) {
    parts.push(sectionText("rules_hidden", character));
  }

  if (opts.hasClothing) {
    parts.push(sectionText("rules_clothing", character));
  }

  if (goal && goal.trim()) {
    parts.push(
      `# Твоя цель в этой сцене (личная и тайная — остальные участники о ней не знают)
${goal.trim()}
Веди себя естественно и не разглашай цель прямо: добивайся её поступками и словами.`
    );
  }

  if (scene.config.rulesExtra?.trim()) {
    parts.push(`# Дополнительные правила сцены\n${scene.config.rulesExtra.trim()}`);
  }
  return parts.join("\n\n");
}

interface PendingActionGroup {
  /** Ключ группы: "ход:итерация" — действия разных ходов не склеиваются */
  key: string;
  events: SimEvent[];
}

/**
 * Реконструкция истории в массив messages.
 * - своя реплика -> assistant content
 * - свои действия -> assistant tool_calls (по "ход:итерация") + tool results;
 *   реплика сразу перед действиями вливается в этот же assistant (как в live-цикле)
 * - чужая реплика/действие -> user "{Имя}: ..."
 * - режиссёр -> user "[Режиссёр]: ..."
 */
export function buildMessages(opts: BuildContextOptions): ChatMessage[] {
  const { character, events, turn } = opts;
  const messages: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt(opts) },
  ];

  let pending: PendingActionGroup | null = null;
  const nameById = new Map<number, string>();
  for (const p of opts.participants) nameById.set(p.id, p.name);

  const flushPending = () => {
    if (!pending || pending.events.length === 0) {
      pending = null;
      return;
    }
    const calls = pending.events.flatMap((e) => e.payload.calls ?? []);
    if (calls.length > 0) {
      // Если непосредственно перед действиями была своя реплика — вливаем её
      // в тот же assistant-месседж (протокол + симметрия с live-циклом).
      let mergedContent: string | null = null;
      const last = messages[messages.length - 1];
      if (last && last.role === "assistant" && typeof last.content === "string" && last.content) {
        mergedContent = last.content;
        messages.pop();
      }
      messages.push({
        role: "assistant",
        content: mergedContent,
        tool_calls: calls.map((c) => ({
          id: c.callId,
          type: "function" as const,
          function: { name: c.toolName, arguments: JSON.stringify(c.args) },
        })),
      });
      for (const c of calls) {
        messages.push({
          role: "tool",
          tool_call_id: c.callId,
          content: c.result,
          name: c.toolName,
        });
      }
    }
    pending = null;
  };

  for (const ev of events) {
    if (ev.type === "system") continue;

    if (ev.actorId === character.id) {
      if (ev.type === "speech") {
        flushPending();
        messages.push({ role: "assistant", content: ev.payload.text ?? "" });
      } else if (ev.type === "action") {
        const key = `${ev.turn}:${ev.payload.iteration ?? 0}`;
        if (pending && pending.key !== key) flushPending();
        if (!pending) pending = { key, events: [] };
        pending.events.push(ev);
      }
      continue;
    }

    flushPending();
    const actorName = ev.actorId != null ? (nameById.get(ev.actorId) ?? "Кто-то") : "Система";

    if (ev.type === "speech") {
      messages.push({ role: "user", content: `${actorName}: ${ev.payload.text ?? ""}` });
    } else if (ev.type === "action") {
      const obs = (ev.payload.calls ?? [])
        .filter((c) => c.audience === "all" || (Array.isArray(c.audience) && c.audience.includes(character.id)))
        .map((c) => c.observation)
        .filter(Boolean)
        .join("; ");
      if (obs) messages.push({ role: "user", content: obs });
    } else if (ev.type === "director") {
      const isBroadcast = ev.audience === "all";
      messages.push({
        role: "user",
        content: isBroadcast
          ? `[Режиссёр сцены — событие, известное всем участникам]: ${ev.payload.text ?? ""}`
          : `[Режиссёр сцены — указание тебе лично]: ${ev.payload.text ?? ""}`,
      });
    }
  }
  flushPending();

  messages.push({
    role: "user",
    content: `(Ход ${turn}. Сейчас твой ход, ${character.name}. Продолжай сцену: скажи что-то и/или соверши действие.)`,
  });
  return messages;
}
