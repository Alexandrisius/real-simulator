// Общие типы домена. Единственный источник правды для форм данных,
// используется и сервером (движок/API), и клиентом (UI).

export type ProviderKind =
  | "lmstudio"
  | "openrouter"
  | "opencode"
  | "openai-compatible"
  | "mock";

/**
 * Режим размышлений (thinking) для GLM/Z.AI-совместимых API: default —
 * как решает провайдер (у GLM включён), off/max — явные переключатели
 * (в тело запроса уходит thinking:{type:"disabled"|"enabled"}).
 */
export type ProviderThinkingMode = "default" | "off" | "max";

export interface Provider {
  id: number;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  apiKey: string;
  thinkingMode: ProviderThinkingMode;
  createdAt: string;
}

export type ToolAudience = "all" | "target" | "self" | "none";

export interface ToolEffect {
  /**
   * На кого действует: сам актёр, цель инструмента (параметр targetParam),
   * отношение цели к актёру (target='relation': key игнорируется,
   * op add — прибавить, set — задать абсолютное значение)
   * или химия пары актёр↔цель (target='chemistry': ±N, кламп −3..+3).
   */
  target: "self" | "tool_target" | "relation" | "chemistry";
  /** Ключ в state персонажа (для relation/chemistry — не используется, пишут своё) */
  key: string;
  op: "set" | "add";
  value: number | string | boolean | null;
}

/** Ключ state, в котором у персонажей лежат деньги (для инструментов с ценой). */
export const MONEY_KEY = "money";

export interface Tool {
  id: number;
  /** Имя функции для native function calling: [a-z0-9_] */
  name: string;
  /** Человекочитаемый ярлык */
  title: string;
  /** Описание для модели — когда и зачем вызывать */
  description: string;
  /** JSON Schema параметров */
  parametersSchema: Record<string, unknown>;
  audience: ToolAudience;
  /** Имя параметра, в котором приходит имя персонажа-получателя (при audience=target) */
  targetParam: string | null;
  /** Шаблон наблюдения: {name} и {параметры}. Напр. "{name} пишет тебе: {text}" */
  observationTemplate: string;
  effects: ToolEffect[];
  /** Цена действия в условных $: списывается с state.money актёра (0 = бесплатно) */
  cost: number;
  /**
   * Ключ навыка из реестра, который тренирует этот тул ('' = не тренирует):
   * каждые N успешных (ok:true) применений качают уровень актёру на +1.
   */
  trainsSkill: string;
  /** Исходы: условие → эффекты + заметка цели (первый подошедший поверх базовых эффектов) */
  outcomes: ToolOutcome[];
  /**
   * Адресный инструмент требует согласия получателя: вызов сначала создаёт
   * предложение (offer), а действие исполняется только после «да» адресата.
   * Опционально в типе: локальные виртуальные тулы (undress, shop_buy…)
   * поле не задают; тулы из БД всегда имеют значение (queries:mapTool).
   */
  requiresConsent?: boolean;
  /** Эффекты при отказе получателя (предложение отклонено): мягкая социальная цена */
  declineEffects?: ToolEffect[];
  /** Кто создал инструмент: вручную или агент через заявку (с одобрением архитектора) */
  origin: "manual" | "agent";
  /** Персонаж, по чьей заявке создан (при origin=agent) */
  createdBy: number | null;
  createdAt: string;
}

/** Черновик инструмента — то, что агент присылает в request_tool. */
export interface ToolDraft {
  name: string;
  title: string;
  description: string;
  parametersSchema: Record<string, unknown>;
  audience: ToolAudience;
  targetParam: string | null;
  observationTemplate: string;
  effects: ToolEffect[];
  cost: number;
}

export type ToolRequestStatus = "pending" | "approved" | "rejected";

export interface ToolRequest {
  id: number;
  sceneId: number;
  characterId: number;
  toolName: string;
  draft: ToolDraft;
  /** Пояснение агента: зачем ему этот инструмент */
  reason: string;
  status: ToolRequestStatus;
  decisionReason: string | null;
  createdAt: string;
  decidedAt: string | null;
}

/** Имя виртуального инструмента заявок (не хранится в БД, добавляется движком). */
export const REQUEST_TOOL_NAME = "request_tool";

// ---- Магазин ----

/** Виртуальный инструмент «посмотреть ассортимент» (не хранится в БД). */
export const SHOP_BROWSE_TOOL = "shop_browse";
/** Виртуальный инструмент «купить товар» (не хранится в БД). */
export const SHOP_BUY_TOOL = "shop_buy";
/** Виртуальный инструмент «сообщить о своей характеристике» (заявление, может быть ложью). */
export const REVEAL_TOOL_NAME = "reveal_attribute";
/** Виртуальный инструмент «снять предмет одежды со слота». */
export const UNDRESS_TOOL_NAME = "undress";
/** Виртуальный инструмент «надеть обратно последнее снятое». */
export const WEAR_TOOL_NAME = "wear";
/** Виртуальный инструмент «отправиться в место» (меняет место сцены). */
export const GO_TOOL_NAME = "go_to";
/** Виртуальный инструмент «пригласить персонажа в место» (доставляет приглашение). */
export const INVITE_TOOL_NAME = "invite";
/** Виртуальный инструмент «ответить на предложение» (принять/отклонить оффер). */
export const RESPOND_TOOL_NAME = "respond_to_offer";
/** Виртуальный инструмент «покинуть сцену» (персонаж выходит из ротации). */
export const LEAVE_SCENE_TOOL_NAME = "leave_scene";
/** Виртуальный инструмент «заблокировать персонажа» (обоюдное молчание в сцене). */
export const BLOCK_TOOL_NAME = "block_character";
/** Виртуальный инструмент «сказать фразу вслух» (общение — только тулами). */
export const SAY_TOOL_NAME = "say";
/** Виртуальный инструмент «написать сообщение в переписке» (телефон/чат). */
export const TEXT_TOOL_NAME = "text_message";
/** Виртуальный инструмент «посмотреть свой гардероб». */
export const WARDROBE_BROWSE_TOOL_NAME = "wardrobe_browse";
/** Виртуальный инструмент «надеть предмет из своего гардероба». */
export const WEAR_GARMENT_TOOL_NAME = "wear_garment";

// ---- Предложения действий (offers): агент предлагает другому вызов тула ----

export type OfferStatus = "pending" | "accepted" | "declined" | "expired";

/** Предложение действия: from предлагает to вызвать toolName с аргументами. */
export interface Offer {
  id: number;
  sceneId: number;
  fromId: number;
  toId: number;
  toolName: string;
  args: Record<string, unknown>;
  status: OfferStatus;
  /** Комментарий адресата при решении (почему отказал) */
  comment: string | null;
  /** Ход, на котором предложение создано */
  turn: number;
  /** Ход, после которого предложение протухает */
  expiresTurn: number;
  createdAt: string;
  decidedAt: string | null;
}

/** Блокировка в сцене: blocker заглушил blocked (молчание в обе стороны). */
export interface SceneBlock {
  sceneId: number;
  blockerId: number;
  blockedId: number;
  createdAt: string;
}

/** Префиксы state-ключей одежды: worn_top = «надето», carried_top = «снято, в руках». */
export const WORN_PREFIX = "worn_";
export const CARRIED_PREFIX = "carried_";

/**
 * Товар магазина: простая карточка (название/цена/описание), а не инструмент.
 * Агенты видят ассортимент через shop_browse и покупают через shop_buy.
 */
export interface ShopProduct {
  id: number;
  name: string;
  emoji: string;
  description: string;
  /** Произвольная группа для витрины: «подарки», «внешность», «спорт»… */
  category: string;
  price: number;
  /** Эффекты покупки: на покупателя (self) или на получателя подарка (tool_target) */
  effects: ToolEffect[];
  /**
   * Задержка применения в сценах: 0 = сразу, N = эффект наступит после N
   * переходов между сценами сценария (деньги списываются сразу). Риск:
   * выбыл из сценария — эффекта не будет.
   */
  delayScenes: number;
  /** Слот одежды (top/bottom/underwear…): покупка сразу надевается на владельца */
  slot: string;
  createdAt: string;
}

/** Отложенный эффект купленного товара, ждущий наступления. */
export interface PendingEffect {
  id: number;
  characterId: number;
  recipientId: number | null;
  productId: number;
  productName: string;
  effects: ToolEffect[];
  remainingScenes: number;
  createdAt: string;
  appliedAt: string | null;
}

// ---- Гардероб: предметы одежды как отдельные карточки ----

/**
 * Предмет одежды: карточка со слотом и эффектами «пока надето». Покупается в
 * магазине (или раздаётся через REST), хранится в гардеробе персонажа
 * (character_garments); ношение — плоские ключи state worn_<slot>.
 */
export interface Garment {
  id: number;
  /** Уникальное человекочитаемое название («Джинсы») — по нему ищут агенты */
  name: string;
  emoji: string;
  description: string;
  /** Слот из реестра clothing_slots ('' = предмет без слота, просто хранится) */
  slot: string;
  /** Эффекты «пока надето»: только self-эффекты на носителя (обратимые add) */
  effects: ToolEffect[];
  /** Цена в магазине (0 = не продаётся, раздаётся через гардероб) */
  price: number;
  createdAt: string;
}

// ---- Комбо: цепочка вызовов с наградой ----

/**
 * Шаг комбо: инструмент + необязательные фильтры ролей. actorName/targetName —
 * имена участников («кто делает» / «на ком делают»); без фильтров шагу всё
 * равно, кто вызвал и на кого. Если ни у одного шага нет фильтров — работает
 * легаси-правило: всю цепочку должен пройти один и тот же персонаж.
 */
export interface ComboStep {
  toolName: string;
  actorName?: string | null;
  targetName?: string | null;
}

/**
 * Комбо: последовательность успешных (исполненных, не предложений) вызовов
 * за окно ходов. Кто «знает» комбо (knowers) — видит подсказку-рецепт;
 * пусто = рецепт не знает никто (секретное «достижение»: узнают по анонсу).
 * announce — при срабатывании объявить всем участникам событием мира.
 */
export interface Combo {
  id: number;
  /** Уникальный машинный ключ ([a-z0-9_]) */
  name: string;
  /** Человекочитаемый заголовок («Нежное утро») */
  title: string;
  description: string;
  /** Цепочка шагов в точном порядке */
  steps: ComboStep[];
  /** Сколько ходов отделяет первый шаг от последнего */
  windowTurns: number;
  /** Эффекты завершённого комбо (актёр — исполнитель последнего шага, tool_target — его цель) */
  effects: ToolEffect[];
  /** id персонажей, знающих рецепт комбо (пусто = никто: секретное достижение) */
  knowers: number[];
  /** Объявить срабатывание всем участникам сцены («достижение открыто») */
  announce: boolean;
  createdAt: string;
}

/**
 * Определение характеристики персонажа (реестр). Значения хранятся в
 * state персонажа по ключу — реестр это метаданные для форм и подсказок.
 */
export interface AttributeDef {
  id: number;
  /** Ключ в state персонажа: money, fitness, looks… */
  key: string;
  label: string;
  emoji: string;
  type: "number" | "select" | "text";
  unit: string;
  min: number | null;
  max: number | null;
  /** Варианты для type=select */
  options: string[];
  position: number;
  /** Публичная (видна окружающим в промпте) или скрытая (только владелец) */
  visibility: "public" | "hidden";
  /** Штраф отношению наблюдателя при разоблачении лжи по этой характеристике */
  liePenalty: number;
  /** Какими слотами одежды прикрыта (фаза «Одежда»; пусто = не прикрыта) */
  coveredBy: string[];
  createdAt: string;
}

/** Спецификация инструмента в формате OpenAI function calling */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

// ---- Отношения и знания ----

/**
 * Отношение — направленное чувство между персонажами (матрица в таблице
 * relations): «насколько X расположен к Y». Проверяется границами (условие
 * kind:"relation" — цели к актёру) и условиями переходов флоу.
 */

/**
 * Запись в картине мира наблюдателя: что он знает о чужой характеристике.
 * claimed — со слов субъекта (может быть ложью), verified — увидено лично
 * (сверено с истиной). Переживает сцены: это память о людях.
 */
export interface KnowledgeEntry {
  observerId: number;
  subjectId: number;
  key: string;
  status: "claimed" | "verified";
  /** Строковое представление значения (числа сериализуются) */
  value: string;
  updatedAt: string;
}

// ---- Одежда ----

/**
 * Слот одежды в реестре. layer задаёт порядок: нельзя снять слой 2 (бельё),
 * пока надет слой 1 (верхнее). undressPlaces — в каких местах сцены слот
 * можно снять (пусто = где угодно). bareEffects — эффекты ПУСТОГО слота
 * (нет белья → беспокойство; надевание их гасит, снятие возвращает).
 */
export interface ClothingSlot {
  slot: string;
  layer: number;
  undressPlaces: string[];
  bareEffects: ToolEffect[];
  position: number;
  createdAt: string;
}

// ---- Места ----

/**
 * Зарегистрированное место мира: доступно агентам через тул go_to
 * («отправиться туда») и invite («пригласить туда персонажа»).
 * Физика границ/одежды сверяется с местом сцены — его меняет go_to.
 */
export interface Place {
  name: string;
  description: string;
  position: number;
  createdAt: string;
}

// ---- Навыки ----

/** Префикс state-ключа уровня навыка: skill_kiss = текущий уровень навыка kiss. */
export const SKILL_PREFIX = "skill_";

/**
 * Навык из реестра: то, что персонаж умеет, и что растёт практикой.
 * Уровень хранится в state персонажа скрытой характеристикой skill_<key>,
 * которая создаётся автоматически: владелец видит своё число, партнёры —
 * только последствия (исходы действий), никогда не сам уровень.
 */
export interface Skill {
  /** Ключ: [a-z0-9_]; уровень лежит в state по ключу skill_<key> */
  key: string;
  label: string;
  emoji: string;
  /** Максимальный уровень */
  maxLevel: number;
  /** Сколько успешных применений даёт +1 уровень (используется при grows) */
  practicePerLevel: number;
  /** Растёт практикой: успешные вызовы тулов с «тренирует навык» качают уровень */
  grows: boolean;
  /** Ключ связанной скрытой характеристики (всегда skill_<key>) */
  attributeKey: string;
  createdAt: string;
}

/** Выросший уровень навыка (для личного уведомления актёра). */
export interface SkillUp {
  key: string;
  label: string;
  fromLevel: number;
  toLevel: number;
  maxLevel: number;
}

// ---- Исходы действий ----

/**
 * Условие исхода. Проверяется по ИСТИННЫМ значениям на момент действия
 * (до эффектов) — физика, как у границ: заявлениям веры нет.
 */
export interface OutcomeCondition {
  /** Что проверяем: атрибут актёра (навыки — тоже state: skill_sex), атрибут цели, отношение цели к актёру, место сцены, слот одежды цели, химия пары */
  kind: "actor_attr" | "target_attr" | "relation" | "place" | "worn" | "chemistry";
  /** Ключ (state-ключ для *_attr, слот для worn); для relation/place/chemistry не используется */
  key: string;
  op: ">=" | "<" | "=";
  value: number | string;
}

/**
 * Исход инструмента: набор условий («И») → эффекты поверх базовых +
 * личная заметка цели от лица мира («волна накрывает с головой»).
 * Проверяются по порядку; побеждает первый подошедший. Требования можно
 * скрыть из описания тула (hideFromPrompt) — тогда агенты узнают по факту.
 */
export interface ToolOutcome {
  /** Стабильный идентификатор для условий флоу и транскрипта: "orgasm" */
  id: string;
  /** Человекочитаемо: «кульминация», «не то» */
  title: string;
  conditions: OutcomeCondition[];
  effects: ToolEffect[];
  /** Заметка, лично доставляемая цели при срабатывании (director-событие) */
  noticeTarget: string;
  /** Не раскрывать требования в описании тула для модели */
  hideFromPrompt: boolean;
}

/** Сработавший исход действия (для события и условий флоу). */
export interface OutcomeFired {
  outcomeId: string;
  title: string;
  noticeTarget: string;
  /** Кому доставить заметку */
  targetId: number;
}

export interface Character {
  id: number;
  name: string;
  emoji: string;
  persona: string;
  /** null у персонажей-людей (управляются пользователем вручную) */
  providerId: number | null;
  model: string;
  /**
   * Страховочный провайдер (null = нет): когда основная модель отказывается
   * (цензура) или её ответ обрывается, ход молча перенаправляется сюда —
   * отказ не попадает в события сцены. Следующий ход снова делает основная.
   */
  fallbackProviderId: number | null;
  /** Модель страховочного провайдера (id модели, напр. grok-4.2) */
  fallbackModel: string;
  temperature: number;
  maxTokens: number;
  /** Отсортированный список id доступных инструментов */
  toolIds: number[];
  /** Свободный JSON: настроение, отношения, одежда, что угодно */
  state: Record<string, unknown>;
  /** Персонаж управляется человеком: движок пропускает его в ротации */
  isHuman: boolean;
  /** Доход персонажа за период, $: начисляется при переходах между сценами флоу */
  income: number;
  /**
   * Личные границы (согласие): правила на адресные инструменты против этого
   * персонажа. Проверяются в executeTool до денег и эффектов; никогда не
   * показываются в промптах — агент узнаёт о них, только столкнувшись.
   */
  boundaries: Boundary[];
  createdAt: string;
}

/** Условие границы. Все условия правила объединяются по «И». */
export type BoundaryCondition =
  | { kind: "relation"; op: ">=" | "<" | "="; value: number } // отношение ВЛАДЕЛЬЦА границы к актёру (системная матрица отношений)
  | { kind: "attr"; owner: "actor" | "target"; key: string; op: ">=" | "<" | "="; value: number } // характеристика актёра или владельца (ключ из реестра), проверяется по истинному state
  | { kind: "place"; place: string } // место сцены (scene.config.place, без учёта регистра)
  | { kind: "worn"; slot: string; bare: boolean }; // слот одежды ВЛАДЕЛЬЦА: bare=true — слот пуст, false — занят

/**
 * @deprecated Легаси-форма требования requireAttr: теперь это условие
 * kind:"attr" внутри conditions (переписывается при чтении — queries.ts:mapBoundary).
 */
export interface BoundaryRequireAttr {
  /** Чей атрибут проверяем: актёра или самого владельца границы */
  owner: "actor" | "target";
  /** Ключ в state */
  key: string;
  op: ">=" | "=";
  value: number;
}

/**
 * Правило-граница персонажа. toolName — имя адресного инструмента
 * ('*' = любой адресный). Условия объединяются по «И»; невыполнение любого —
 * отказ: действие не исполняется, деньги не списываются, применяются
 * effects нарушения (target 'relation' — отношение владельца к актёру,
 * 'self' — state самого владельца; эффектов на актёра нет).
 * Легаси-поля (minRelation/minAttr/minMood/requirePlace/requireAttr) держатся
 * только для старых записей и литералов: при чтении (queries.ts:mapBoundary)
 * они переписываются в conditions и в нормализованном правиле не хранятся.
 */
export interface Boundary {
  toolName: string;
  /**
   * Когда правило действует: "incoming" (по умолчанию) — когда кто-то
   * применяет тул ко мне; "outgoing" — когда я сам применяю тул к другому
   * («я не сплю с теми, у кого X < N»); "both" — в обе стороны.
   * Роли в условиях всегда относительно вызова: actor — кто вызывает,
   * target — на кого.
   */
  scope?: "incoming" | "outgoing" | "both";
  /**
   * Условия допуска («И»); пустой список — правило никогда не срабатывает.
   * Верно управляемый код всегда заполняет его (queries.ts:mapBoundary при
   * чтении, api.ts:boundarySchema на входе); поле оставлено необязательным
   * только чтобы старые литералы с легаси-полями продолжали компилироваться.
   */
  conditions?: BoundaryCondition[];
  /** Текст отказа от лица владельца («твёрдо отстраняется: слишком рано») */
  refusalText: string;
  effects: ToolEffect[];
  /** @deprecated Легаси: порог отношения владельца к актёру → условие kind:"relation" */
  minRelation?: number | null;
  /** @deprecated Легаси: порог характеристики владельца (state[key] >= value) → условие kind:"attr" */
  minAttr?: { key: string; value: number } | null;
  /** @deprecated Легаси-порог mood; читается только при отсутствии minAttr → kind:"attr" по ключу mood */
  minMood?: number | null;
  /** @deprecated Легаси: требуемое место сцены (scene.config.place) → условие kind:"place" */
  requirePlace?: string | null;
  /** @deprecated Легаси: требование к истинному атрибуту → условие kind:"attr" */
  requireAttr?: BoundaryRequireAttr | null;
}

/** Условие авто-финиша сцены (движок сверяет после каждого хода). */
export type FinishCondition =
  | {
      /** Персонаж (или кто угодно) успешно вызвал инструмент */
      type: "toolCall";
      toolName: string;
      characterId?: number;
    }
  | {
      /** Сработал исход инструмента («кульминация случилась») */
      type: "outcome";
      toolName: string;
      outcomeId: string;
      /** Необязательное закрепление за персонажем (как у toolCall) */
      characterId?: number;
    }
  | {
      /** Числовая проверка state персонажа (или любого участника) */
      type: "state";
      characterId?: number;
      key: string;
      op: ">=" | "<" | "=";
      value: number;
    };

/** Настройка авто-финиша: все условия («И») + пауза в ходах после срабатывания. */
export interface SceneFinishConfig {
  conditions: FinishCondition[];
  /** Сколько ходов досидеть после срабатывания условий (0 = сразу) */
  delayTurns: number;
}

export interface SceneConfig {
  /** Пауза между ходами, мс */
  turnDelayMs: number;
  /** Максимум ходов (0 = бесконечно) */
  maxTurns: number;
  /** Максимум итераций (вызов модели) на один ход: действие + реплика */
  maxIterPerTurn: number;
  /** Сколько последних видимых событий класть в контекст */
  contextEvents: number;
  /** Дополнительные правила, дописываемые в system prompt */
  rulesExtra: string;
  /** Пауза после каждого круга ИИ, чтобы походил человек */
  pauseForHumans: boolean;
  /** Бюджет сцены: максимум вызовов модели (0 = без лимита) */
  maxApiCallsPerScene: number;
  /** Бюджет сцены: максимум токенов (0 = без лимита) */
  maxTokensPerScene: number;
  /** Разрешить агентам просить новые инструменты через request_tool */
  allowToolRequests: boolean;
  /** Разрешить агентам отвечать на предложения и покидать сцену (respond_to_offer / leave_scene) */
  allowAgentStops: boolean;
  /** Авто-финиш: условия срабатывания и задержка (null = выключено) */
  finish: SceneFinishConfig | null;
  /** Место действия («дом», «улица», «кафе»…): окружение + правило для границ/одежды */
  place: string;
}

export const DEFAULT_SCENE_CONFIG: SceneConfig = {
  turnDelayMs: 5000,
  maxTurns: 0,
  maxIterPerTurn: 3,
  contextEvents: 60,
  rulesExtra: "",
  pauseForHumans: false,
  maxApiCallsPerScene: 300,
  maxTokensPerScene: 1_000_000,
  allowToolRequests: false,
  allowAgentStops: true,
  finish: null,
  place: "",
};

export type SceneStatus = "idle" | "running" | "paused" | "finished";

export interface Scene {
  id: number;
  name: string;
  setting: string;
  status: SceneStatus;
  config: SceneConfig;
  /** Сколько ходов уже сделано (курсор) */
  cursor: number;
  /** Потрачено вызовов API за всё время сцены */
  spentApiCalls: number;
  /** Потрачено токенов (prompt+completion) за всё время сцены */
  spentTokens: number;
  createdAt: string;
}

export type EventType = "speech" | "action" | "director" | "system";

/** audience: "all" | "none" (скрытое) | массив id персонажей, которым видно событие */
export type Audience = "all" | "none" | number[];

export interface ActionCall {
  callId: string;
  toolName: string;
  args: Record<string, unknown>;
  ok: boolean;
  /** Текст, возвращённый моделью как результат tool-вызова */
  result: string;
  /** Наблюдение для остальных (отрендеренный шаблон) */
  observation: string;
  /** Кому было видно это конкретное действие */
  audience: Audience;
  /** id сработавшего исхода (если у тула есть исходы и один сработал) */
  outcome?: string;
  /** id разрешённого получателя адресного тула (для комбо-фильтров по цели) */
  targetId?: number;
  /**
   * true = это вызов-предложение (требует согласия получателя): действие
   * ещё не совершено, только предложено. Скоринг и условия флоу считают
   * только исполненные вызовы (offered не считаются).
   */
  offered?: boolean;
  /** id созданного предложения (для offered-вызовов) — карточка в ленте комнаты */
  offerId?: number;
}

export interface EventPayload {
  /** speech: текст реплики */
  text?: string;
  /** action: данные вызовов */
  iteration?: number;
  calls?: ActionCall[];
  /** system: служебное сообщение; director: указание режиссёра (в text) */
  message?: string;
  /** Изменения state, применённые этим ходом */
  stateChanges?: { characterId: number; key: string; value: unknown }[];
  /** Изменения отношений, применённые этим ходом (fromId чувствует к toId) */
  relationChanges?: { fromId: number; toId: number; value: number }[];
  /** action: сработавшее комбо (движок досылает эффекты и личную заметку) */
  comboId?: number;
  /** action: id предложения, связанного с этим вызовом (respond_to_offer и т.п.) */
  offerId?: number;
  [k: string]: unknown;
}

export interface SimEvent {
  id: number;
  sceneId: number;
  turn: number;
  type: EventType;
  actorId: number | null;
  audience: Audience;
  payload: EventPayload;
  createdAt: string;
}

export interface ApiLog {
  id: number;
  sceneId: number;
  characterId: number | null;
  turn: number;
  iteration: number;
  model: string | null;
  requestJson: string;
  responseJson: string | null;
  error: string | null;
  latencyMs: number | null;
  createdAt: string;
}

// ---- Сообщения чата (OpenAI-совместимый формат) ----

export interface ToolCallRaw {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCallRaw[];
  tool_call_id?: string;
  name?: string;
}

// ---- Скоринг: схемы валидации ----

/** Один шаг цепочки: инструмент, который должен вызываться в этом месте схемы */
export interface ValidationStep {
  toolName: string;
  /** Обязательный шаг: провал рвёт цепочку, дальше ничего не засчитывается */
  required: boolean;
  points: number;
  /** Сколько вхождений нужно для зачёта шага */
  minCount: number;
  /** Необязательный фильтр: подстрока в JSON аргументов (напр. имя получателя) */
  argContains: string | null;
}

export interface ValidationSchema {
  id: number;
  name: string;
  description: string;
  /** Упорядоченная цепочка шагов */
  steps: ValidationStep[];
  /** Запрещённые инструменты: любое вхождение — нарушение */
  forbidden: string[];
  /** Штраф за каждое нарушение (ранний вызов / запрещённый инструмент) */
  penalty: number;
  createdAt: string;
}

export interface StepResult {
  toolName: string;
  required: boolean;
  satisfied: boolean;
  /** Сколько подходящих вхождений найдено в правильном месте цепочки */
  matched: number;
  needed: number;
  points: number;
  earned: number;
  firstMatchTurn: number | null;
}

export interface ScoreViolation {
  toolName: string;
  turn: number;
  reason: string;
}

export interface CharacterScore {
  characterId: number;
  schemaId: number;
  schemaName: string;
  steps: StepResult[];
  violations: ScoreViolation[];
  score: number;
  maxScore: number;
  /** % выполненных обязательных шагов */
  completionPct: number;
  /** Статистика вызовов инструментов персонажа за сцену */
  toolStats: Record<string, { count: number; firstTurn: number; lastTurn: number }>;
}


// ---- Флоу: канвас сценариев (цепочка сцен с условиями переходов) ----

/**
 * Условие перехода по ребру канваса. Все условия ребра объединяются по «И».
 * characterId закрепляет условие за конкретным персонажем (например,
 * «Саша обязан поцеловать Яну» — условие по вызовам Саши); без него условие
 * проверяется для каждого переходящего персонажа лично.
 */
export type FlowCondition =
  | {
      type: "step";
      /** Успешный вызов этого инструмента персонажем в сцене узла */
      toolName: string;
      /** Необязательный фильтр: подстрока в JSON аргументов вызова */
      argContains?: string | null;
      characterId?: number | null;
    }
  | {
      type: "score";
      /** Метрика схемы валидации, привязанной к персонажу в сцене узла */
      metric: "score" | "completionPct";
      op: ">=" | "=";
      value: number;
      characterId?: number | null;
    }
  | {
      /** Ноль нарушений схемы валидации в сцене узла */
      type: "clean";
      characterId?: number | null;
    }
  | {
      /** Проверка ключа в state персонажа (число) */
      type: "state";
      key: string;
      op: ">=" | "=";
      value: number;
      characterId?: number | null;
    }
  | {
      /** Отношение одного персонажа к другому: «Яна к Саше ≥ 5» */
      type: "relation";
      /** Чьё отношение проверяем (null = переходящий персонаж) */
      whoseId: number | null;
      /** К кому отношение */
      toId: number;
      op: ">=" | "=";
      value: number;
    }
  | {
      /** Персонаж добился исхода инструмента в сцене узла: «оргазм случился» */
      type: "outcome";
      toolName: string;
      outcomeId: string;
      characterId?: number | null;
    };

export type FlowNodeKind = "scene" | "final" | "exit";

export interface FlowNode {
  /** id внутри графа (не БД): "n1", "n2"… */
  id: string;
  kind: FlowNodeKind;
  /** Сцена узла (для kind=scene) */
  sceneId: number | null;
  /** Очки за достижение узла (финал = награда за пройденный путь) */
  bonus: number;
  /** Сбросить события сцены при первом входе в прогоне (свежий заход) */
  resetOnEntry: boolean;
  /** Начислить персонажам их доход при переходе дальше (течение времени) */
  grantIncome: boolean;
  /** Узел выхода: остановить весь прогон, когда кто-то сюда попал */
  stopsRun: boolean;
  /** Координаты на канвасе */
  x: number;
  y: number;
}

export interface FlowEdge {
  id: string;
  from: string;
  to: string;
  /** Рёбра проверяются по возрастанию priority; побеждает первое подошедшее */
  priority: number;
  /** Условия («И»); пусто = безусловное */
  conditions: FlowCondition[];
  /** Произвольная подпись для себя */
  label: string;
}

export interface FlowGraph {
  nodes: FlowNode[];
  edges: FlowEdge[];
}

export interface Flow {
  id: number;
  name: string;
  description: string;
  graph: FlowGraph;
  createdAt: string;
}

export type FlowRunStatus = "running" | "finished" | "aborted";

export interface FlowRun {
  id: number;
  flowId: number;
  status: FlowRunStatus;
  /** Состав прогона: id персонажей */
  cast: number[];
  startedAt: string;
  finishedAt: string | null;
}

/** Где персонаж находится в прогоне прямо сейчас. */
export interface FlowProgress {
  runId: number;
  characterId: number;
  nodeId: string;
  status: "active" | "final" | "eliminated";
}

/** Посещение узла персонажем — строка отчёта по прогону. */
export interface FlowVisit {
  id: number;
  runId: number;
  characterId: number;
  nodeId: string;
  sceneId: number | null;
  score: number | null;
  completionPct: number | null;
  /** Рассадка по сцене состоялась (для повторных волн персонажей) */
  seated: number;
  enteredAt: string;
  leftAt: string | null;
}

export interface FlowReportCharacter {
  characterId: number;
  name: string;
  emoji: string;
  status: FlowProgress["status"];
  reachedFinal: boolean;
  /** Сумма скоров сцен (пересчитывается по живым событиям) */
  score: number;
  /** Сумма бонусов посещённых узлов */
  bonus: number;
  total: number;
  /** Итоговые отношения персонажа к другим участникам прогона */
  relations: { toId: number; name: string; value: number }[];
  visits: {
    nodeId: string;
    nodeTitle: string;
    sceneId: number | null;
    score: number | null;
    completionPct: number | null;
    enteredAt: string;
    leftAt: string | null;
  }[];
}

export interface FlowRunReport {
  run: FlowRun;
  flow: { id: number; name: string };
  characters: FlowReportCharacter[];
}

export type StreamMessage =
  | { type: "hello" }
  | { type: "heartbeat" }
  | { type: "event"; event: SimEvent }
  | {
      type: "status";
      sceneId: number;
      status: SceneStatus;
      turn: number;
      nextCharacterId: number | null;
      spentApiCalls?: number;
      spentTokens?: number;
    }
  | { type: "participants"; sceneId: number }
  /** Изменилась очередь заявок на инструменты (sceneId) */
  | { type: "tool-requests"; sceneId: number };

export type ControlAction = "start" | "pause" | "resume" | "step" | "stop";
