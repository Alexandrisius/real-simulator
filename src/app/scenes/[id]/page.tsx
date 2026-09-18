"use client";

import { Fragment, use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowDown,
  ArrowLeft,
  Braces,
  Check,
  Clapperboard,
  Inbox,
  Megaphone,
  Pause,
  Play,
  RotateCcw,
  Settings2,
  SkipForward,
  Square,
  Target,
  Terminal,
  Trophy,
  Wrench,
  X,
  Zap,
} from "lucide-react";
import { Badge, Btn, Card, ErrorText, Field, IconBtn, Input, StatusBadge, Textarea } from "@/components/ui";
import { Dropdown } from "@/components/Dropdown";
import { api, apiPatch, apiPost } from "@/components/api";
import type { Audience, AttributeDef, Character, ClothingSlot, FinishCondition, Garment, Place, Scene, SimEvent, SceneStatus, StreamMessage, ApiLog, Tool, CharacterScore, ToolRequest, ShopProduct } from "@/lib/types";

interface RequestRow extends ToolRequest {
  characterName: string;
  characterEmoji: string;
  sceneName: string;
}

/** Активное предложение сцены (GET /api/scenes/:id/offers) — для выбора в ручном ответе. */
interface SceneOffer {
  id: number;
  toolName: string;
  toolTitle: string;
  fromId: number;
  fromName: string;
  fromEmoji: string;
  toId: number;
  toName: string;
  toEmoji: string;
  args: Record<string, unknown>;
}

/** Пресеты паузы между ходами агентов (мс) — регулятор «вайба» в шапке. */
const DELAY_PRESETS = [0, 1000, 2000, 5000, 10000, 15000, 30000];

const delayLabel = (ms: number) => (ms === 0 ? "пауза: выкл" : `пауза: ${ms / 1000} с`);

/** Варианты места действия: только реестр мест (/api/places) плюс «не задано». */
const placeOptionsOf = (places: Place[]) => [
  { value: "", label: "— не задано —" },
  ...places.map((p) => ({ value: p.name, label: p.name })),
];

/** Заготовка условия авто-финиша выбранного типа (привязка к персонажу сохраняется). */
function makeCondition(type: FinishCondition["type"], characterId?: number): FinishCondition {
  const base: FinishCondition =
    type === "toolCall"
      ? { type, toolName: "" }
      : type === "outcome"
        ? { type, toolName: "", outcomeId: "" }
        : { type, key: "", op: ">=", value: 0 };
  return characterId == null ? base : { ...base, characterId };
}

/** Правка условия авто-финиша: поля со значением undefined удаляются (напр. characterId). */
function patchCondition(c: FinishCondition, patch: Record<string, unknown>): FinishCondition {
  const next = { ...c } as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete next[k];
    else next[k] = v;
  }
  return next as FinishCondition;
}

const PALETTE = [
  "text-violet-300",
  "text-sky-300",
  "text-emerald-300",
  "text-amber-300",
  "text-rose-300",
  "text-cyan-300",
  "text-fuchsia-300",
  "text-orange-300",
];

interface Participant extends Character {
  providerName: string;
  providerKind: string;
  validationSchemaId: number | null;
  validationSchemaName: string | null;
  goal: string | null;
}

interface SceneData {
  scene: Scene;
  participants: Participant[];
  runtime: {
    status: SceneStatus;
    turn: number;
    nextCharacterId: number | null;
    spentApiCalls: number;
    spentTokens: number;
  };
}

function fmtTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString("ru-RU", { hour12: false });
  } catch {
    return "";
  }
}

/** Видимость события персонажу (зеркало серверной модели): свои события, публичные
 *  и адресованные ему; чужие speech-события — мысли, их не слышит никто, кроме автора. */
function visibleForCharacter(ev: SimEvent, cid: number): boolean {
  if (ev.type === "speech") return ev.actorId === cid;
  if (ev.actorId === cid) return true;
  if (ev.audience === "all") return true;
  if (ev.audience === "none") return false;
  return Array.isArray(ev.audience) && ev.audience.includes(cid);
}

export default function SceneRoomPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const sid = Number(id);

  const [data, setData] = useState<SceneData | null>(null);
  const [events, setEvents] = useState<SimEvent[]>([]);
  const [error, setError] = useState("");
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState("");
  const [directorText, setDirectorText] = useState("");
  const [directorTarget, setDirectorTarget] = useState<string>("all");
  /** Режим ввода: "director" | id персонажа */
  const [mode, setMode] = useState<string>("director");
  /** Чья лента: "architect" (всё, без фильтра) | id персонажа (его видимость). */
  const [feedView, setFeedView] = useState<string>("architect");
  const [tools, setTools] = useState<Tool[]>([]);
  const [showActions, setShowActions] = useState(false);
  const [actionToolId, setActionToolId] = useState<number | null>(null);
  const [actionValues, setActionValues] = useState<Record<string, string>>({});
  const [actionError, setActionError] = useState("");
  const [actionBusy, setActionBusy] = useState(false);
  const [actionSearch, setActionSearch] = useState("");
  const [apiQuery, setApiQuery] = useState<{ characterId: number; turn: number } | null>(null);
  const [apiLogs, setApiLogs] = useState<ApiLog[] | null>(null);
  const [showScores, setShowScores] = useState(false);
  const [scores, setScores] = useState<CharacterScore[] | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsForm, setSettingsForm] = useState({
    setting: "",
    rulesExtra: "",
    turnDelayMs: 5000,
    contextEvents: 60,
    pauseForHumans: false,
    maxApiCallsPerScene: 300,
    maxTokensPerScene: 1000000,
    allowToolRequests: false,
    allowAgentStops: true,
    place: "",
  });
  const [goalDrafts, setGoalDrafts] = useState<Record<string, string>>({});
  const [settingsSaved, setSettingsSaved] = useState(false);
  /** Черновик авто-финиша: включён ли, условия («И») и сколько ходов доигрывать после. */
  const [finishOn, setFinishOn] = useState(false);
  const [finishConditions, setFinishConditions] = useState<FinishCondition[]>([]);
  const [finishDelay, setFinishDelay] = useState(2);
  const [showRequests, setShowRequests] = useState(false);
  const [requests, setRequests] = useState<RequestRow[] | null>(null);
  /** Комментарий Архитектора к решению по заявке — свой на каждую заявку. */
  const [requestReasons, setRequestReasons] = useState<Record<number, string>>({});
  const [requestBusy, setRequestBusy] = useState(0);
  /** Идёт ли ответ на предложение (id предложения) — для карточек в ленте. */
  const [offerBusy, setOfferBusy] = useState<number | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const lastIdRef = useRef(0);
  const [newCount, setNewCount] = useState(0);
  /** Режим ввода выставлен вручную (тогглом) — дефолт больше не навязываем. */
  const modeTouchedRef = useRef(false);

  /** Слияние событий по id — устойчиво к гонкам REST-снимка и SSE. */
  const mergeEvents = useCallback((incoming: SimEvent[]) => {
    setEvents((prev) => {
      const byId = new Map<number, SimEvent>();
      for (const e of [...prev, ...incoming]) if (!byId.has(e.id)) byId.set(e.id, e);
      const merged = [...byId.values()].sort((a, b) => a.id - b.id);
      lastIdRef.current = merged.length > 0 ? merged[merged.length - 1].id : 0;
      return merged;
    });
  }, []);

  const charById = useMemo(() => {
    const m = new Map<number, Participant>();
    data?.participants.forEach((p) => m.set(p.id, p));
    return m;
  }, [data]);

  const colorOf = useCallback(
    (cid: number | null) => {
      if (!data || cid == null) return "text-muted";
      const i = data.participants.findIndex((p) => p.id === cid);
      return PALETTE[i % PALETTE.length];
    },
    [data]
  );

  const loadScene = useCallback(async () => {
    try {
      const d = await api<SceneData>(`/api/scenes/${sid}`);
      setData(d);
      setSettingsForm({
        setting: d.scene.setting,
        rulesExtra: d.scene.config.rulesExtra ?? "",
        turnDelayMs: d.scene.config.turnDelayMs,
        contextEvents: d.scene.config.contextEvents,
        pauseForHumans: d.scene.config.pauseForHumans ?? false,
        maxApiCallsPerScene: d.scene.config.maxApiCallsPerScene ?? 300,
        maxTokensPerScene: d.scene.config.maxTokensPerScene ?? 1000000,
        allowToolRequests: d.scene.config.allowToolRequests ?? false,
        allowAgentStops: d.scene.config.allowAgentStops ?? true,
        place: d.scene.config.place ?? "",
      });
      setFinishOn(d.scene.config.finish != null);
      setFinishConditions(d.scene.config.finish?.conditions ?? []);
      setFinishDelay(d.scene.config.finish?.delayTurns ?? 2);
      setGoalDrafts(
        Object.fromEntries(d.participants.map((p) => [String(p.id), p.goal ?? ""]))
      );
      // Дефолт режима ввода: если в сцене есть человек — говорим от его лица.
      // Архитектора всегда можно вернуть тогглом (modeTouchedRef фиксирует выбор).
      if (!modeTouchedRef.current && mode === "director") {
        const human = d.participants.find((p) => p.isHuman);
        if (human) setMode(String(human.id));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [sid]);

  useEffect(() => {
    loadScene();
    api<SimEvent[]>(`/api/scenes/${sid}/events`)
      .then((initial) => {
        // Снимок мог прийти позже SSE-событий — сливаем, а не затираем.
        setEvents((prev) => {
          if (prev.length === 0) {
            const sorted = [...initial].sort((a, b) => a.id - b.id);
            lastIdRef.current = sorted.length > 0 ? sorted[sorted.length - 1].id : 0;
            return sorted;
          }
          return prev;
        });
        mergeEvents([]);
      })
      .catch((e) => setError(e.message));
    api<Tool[]>("/api/tools").then(setTools).catch(() => {});
  }, [sid, loadScene, mergeEvents]);

  /** Полная перезагрузка ленты (после «Заново»): заменить список целиком. */
  const reloadEvents = useCallback(async () => {
    try {
      const fresh = await api<SimEvent[]>(`/api/scenes/${sid}/events`);
      const sorted = [...fresh].sort((a, b) => a.id - b.id);
      lastIdRef.current = sorted.length > 0 ? sorted[sorted.length - 1].id : 0;
      setEvents(sorted);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [sid]);

  const loadRequests = useCallback(async () => {
    try {
      setRequests(await api<RequestRow[]>(`/api/tool-requests?sceneId=${sid}`));
    } catch {
      /* очередь не критична для комнаты */
    }
  }, [sid]);

  /** Живые предложения сцены: карточки в ленте и выбор в respond_to_offer. */
  const loadOffers = useCallback(async () => {
    try {
      setOffers(await api<SceneOffer[]>(`/api/scenes/${sid}/offers`));
    } catch {
      /* не критично для комнаты */
    }
  }, [sid]);

  useEffect(() => {
    loadRequests();
  }, [loadRequests]);

  // SSE
  useEffect(() => {
    const es = new EventSource(`/api/stream?sceneId=${sid}`);
    es.onopen = () => {
      setConnected(true);
      // После реконнекта догружаем то, что могли пропустить за время обрыва.
      if (lastIdRef.current > 0) {
        api<SimEvent[]>(`/api/scenes/${sid}/events?after=${lastIdRef.current}`)
          .then(mergeEvents)
          .catch(() => {});
      }
    };
    es.onerror = () => setConnected(false);
    es.onmessage = (m) => {
      let msg: StreamMessage;
      try {
        msg = JSON.parse(m.data) as StreamMessage;
      } catch {
        return;
      }
      if (msg.type === "event") {
        mergeEvents([msg.event]);
        if (!stickRef.current) setNewCount((n) => n + 1);
        // Предложения живут своей жизнью (созданы/приняты агентами) — освежим.
        loadOffers();
      } else if (msg.type === "status") {
        setData((d) =>
          d
            ? {
                ...d,
                runtime: {
                  status: msg.status,
                  turn: msg.turn,
                  nextCharacterId: msg.nextCharacterId,
                  spentApiCalls: msg.spentApiCalls ?? d.runtime.spentApiCalls,
                  spentTokens: msg.spentTokens ?? d.runtime.spentTokens,
                },
              }
            : d
        );
      } else if (msg.type === "participants") {
        loadScene();
      } else if (msg.type === "tool-requests") {
        loadRequests();
      }
    };
    return () => es.close();
  }, [sid, loadScene, mergeEvents, loadRequests, loadOffers]);

  // автоскролл
  useEffect(() => {
    if (stickRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [events, feedView]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 90;
    if (stickRef.current) setNewCount(0);
  };

  const jumpDown = () => {
    stickRef.current = true;
    setNewCount(0);
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  };

  const control = async (action: string) => {
    setBusy(action);
    setError("");
    try {
      await apiPost(`/api/scenes/${sid}/control`, { action });
      await loadScene();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  };

  /** «Заново»: полный откат диалога — события, отношения, память, состояния. */
  const restartDialogue = async () => {
    if (
      !confirm(
        "Начать диалог заново? История сообщений сотрётся, отношения и взаимная память участников обнулятся, состояния вернутся к моменту рассадки."
      )
    )
      return;
    setBusy("resetFull");
    setError("");
    try {
      await apiPost(`/api/scenes/${sid}/reset`, { full: true });
      await loadScene();
      await reloadEvents();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  };

  const send = async () => {
    const text = directorText.trim();
    if (!text) return;
    setError("");
    try {
      if (mode === "director") {
        const audience: Audience =
          directorTarget === "all" ? "all" : [Number(directorTarget)];
        await apiPost(`/api/scenes/${sid}/inject`, { text, audience });
      } else {
        await apiPost(`/api/scenes/${sid}/say`, { characterId: Number(mode), text });
      }
      setDirectorText("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const modeChar = mode !== "director" ? charById.get(Number(mode)) ?? null : null;
  const [products, setProducts] = useState<ShopProduct[]>([]);
  const [garments, setGarments] = useState<Garment[]>([]);
  /** Предметы, которыми владеет текущий персонаж (для wear_garment). */
  const [ownedGarments, setOwnedGarments] = useState<Garment[]>([]);
  const [hasHiddenAttrs, setHasHiddenAttrs] = useState(false);
  const [clothingSlots, setClothingSlots] = useState<ClothingSlot[]>([]);
  const hasClothing = clothingSlots.length > 0;
  const [places, setPlaces] = useState<Place[]>([]);
  /** Реестр характеристик — для выбора ключа в условиях авто-финиша. */
  const [attrs, setAttrs] = useState<AttributeDef[]>([]);
  /** Активные предложения сцены: выбор в respond_to_offer вместо ручного id. */
  const [offers, setOffers] = useState<SceneOffer[]>([]);

  useEffect(() => {
    api<ShopProduct[]>("/api/products").then(setProducts).catch(() => {});
    api<Garment[]>("/api/garments").then(setGarments).catch(() => {});
    api<AttributeDef[]>("/api/attributes")
      .then((list) => {
        setAttrs(list);
        setHasHiddenAttrs(list.some((a) => a.visibility === "hidden"));
      })
      .catch(() => {});
    api<ClothingSlot[]>("/api/clothing-slots").then(setClothingSlots).catch(() => {});
    api<Place[]>("/api/places").then(setPlaces).catch(() => {});
    loadOffers();
  }, [loadOffers]);

  // Личный гардероб текущего персонажа: варианты для wear_garment.
  useEffect(() => {
    if (mode === "director") {
      setOwnedGarments([]);
      return;
    }
    api<{ owned: Garment[] }>(`/api/characters/${mode}/wardrobe`)
      .then((w) => setOwnedGarments(w.owned ?? []))
      .catch(() => setOwnedGarments([]));
  }, [mode]);
  const placeOptions = placeOptionsOf(places);
  // Сохранённое место вне реестра показываем отдельным вариантом, чтобы не терять значение.
  const settingsPlaceOptions =
    settingsForm.place && !placeOptions.some((o) => o.value === settingsForm.place)
      ? [
          ...placeOptions,
          { value: settingsForm.place, label: `${settingsForm.place} (нет в реестре)` },
        ]
      : placeOptions;
  /** Инструменты для условий авто-финиша (выбор по имени из реестра тулов). */
  const toolOptions = tools.map((t) => ({
    value: t.name,
    label: t.title ? `${t.title} · ${t.name}` : t.name,
  }));

  // Ассортимент магазина: товары + продаваемая одежда (зеркалит движок).
  const shopItems = [
    ...products.map((p) => ({ name: p.name, emoji: p.emoji, price: p.price })),
    ...garments.filter((g) => g.price > 0).map((g) => ({ name: g.name, emoji: g.emoji, price: g.price })),
  ];

  // Псевдотулы магазина: доступны всем, в БД не хранятся (исполняет движок).
  const shopPseudoTools: Tool[] =
    shopItems.length > 0
      ? [
          {
            id: -1,
            name: "shop_browse",
            title: "Заглянуть в магазин",
            description: "Посмотреть ассортимент и цены. Бесплатно.",
            parametersSchema: { type: "object", properties: {} },
            audience: "self",
            targetParam: null,
            observationTemplate: "",
            effects: [],
            cost: 0,
            origin: "manual",
            createdBy: null,
            trainsSkill: "",
            outcomes: [],
            createdAt: "",
          },
          {
            id: -2,
            name: "shop_buy",
            title: "Купить в магазине",
            description: `Купить товар по названию (деньги спишутся). Подарок — укажи получателя. В наличии: ${shopItems
              .slice(0, 12)
              .map((p) => `${p.name} ($${p.price})`)
              .join(", ")}`,
            parametersSchema: {
              type: "object",
              properties: {
                item: { type: "string", description: "Название товара" },
                for: { type: "string", description: "Кому подарить (необязательно)" },
              },
              required: ["item"],
            },
            audience: "all",
            targetParam: null,
            observationTemplate: "{name} покупает {item}",
            effects: [],
            cost: 0,
            origin: "manual",
            createdBy: null,
            trainsSkill: "",
            outcomes: [],
            createdAt: "",
          },
        ]
      : [];

  // Виртуальные тулы движка: выдаются всем, когда в мире есть скрытое/одежда.
  const virtualPseudoTools: Tool[] = [];
  if (hasHiddenAttrs) {
    virtualPseudoTools.push({
      id: -3,
      name: "reveal_attribute",
      title: "Заявить о характеристике",
      description:
        "Сообщить о своей характеристике вслух — можно правду, приукрасить или соврать. Слушатели запомнят «со слов», а при личной проверке ложь вскроется.",
      parametersSchema: {
        type: "object",
        properties: {
          attribute: { type: "string", description: "Характеристика (напр. Достоинство)" },
          value: { type: "string", description: "Заявленное значение" },
          to: { type: "string", description: "Кому говоришь (пусто = все)" },
        },
        required: ["attribute", "value"],
      },
      audience: "all",
      targetParam: null,
      observationTemplate: "{name} заявляет о себе",
      effects: [],
      cost: 0,
      origin: "manual",
      createdBy: null,
      trainsSkill: "",
      outcomes: [],
      createdAt: "",
    });
  }
  if (hasClothing) {
    virtualPseudoTools.push(
      {
        id: -4,
        name: "undress",
        title: "Снять одежду",
        description:
          "Снять предмет со слота (top/bottom/underwear). Порядок слоёв и место сцены имеют значение; снятое остаётся при тебе.",
        parametersSchema: {
          type: "object",
          properties: { slot: { type: "string", description: "Слот: top, bottom или underwear" } },
          required: ["slot"],
        },
        audience: "all",
        targetParam: null,
        observationTemplate: "{name} снимает одежду",
        effects: [],
        cost: 0,
        origin: "manual",
        createdBy: null,
        trainsSkill: "",
        outcomes: [],
        createdAt: "",
      },
      {
        id: -5,
        name: "wear",
        title: "Надеть одежду",
        description: "Надеть обратно ранее снятое (по слоту).",
        parametersSchema: {
          type: "object",
          properties: { slot: { type: "string", description: "Слот: top, bottom или underwear" } },
          required: ["slot"],
        },
        audience: "all",
        targetParam: null,
        observationTemplate: "{name} надевает одежду",
        effects: [],
        cost: 0,
        origin: "manual",
        createdBy: null,
        trainsSkill: "",
        outcomes: [],
        createdAt: "",
      }
    );
  }

  if (places.length > 0) {
    const placeList = places.map((p) => `«${p.name}»`).join(", ");
    virtualPseudoTools.push(
      {
        id: -6,
        name: "go_to",
        title: "Отправиться в место",
        description: `Сменить место сцены — все продолжат в новой локации. Доступно: ${placeList}.`,
        parametersSchema: {
          type: "object",
          properties: { place: { type: "string", description: "Название места" } },
          required: ["place"],
        },
        audience: "all",
        targetParam: null,
        observationTemplate: "{name} отправляется: {place}",
        effects: [],
        cost: 0,
        origin: "manual",
        createdBy: null,
        trainsSkill: "",
        outcomes: [],
        createdAt: "",
      },
      {
        id: -7,
        name: "invite",
        title: "Пригласить в место",
        description: `Пригласить персонажа в место (лично ему). Поедет — решит он сам, своим «Отправиться». Доступно: ${placeList}.`,
        parametersSchema: {
          type: "object",
          properties: {
            to: { type: "string", description: "Имя персонажа" },
            place: { type: "string", description: "Название места" },
            say: { type: "string", description: "Что сказать (необязательно)" },
          },
          required: ["to", "place"],
        },
        audience: "target",
        targetParam: "to",
        observationTemplate: "{name} приглашает {to}: {place}",
        effects: [],
        cost: 0,
        origin: "manual",
        createdBy: null,
        trainsSkill: "",
        outcomes: [],
        createdAt: "",
      }
    );
  }

  // Ответ на предложение: виден только тому, кому действительно предложили
  // (как у агентов в движке) — и предлагает выбор из живых предложений.
  const myPendingOffers = offers.filter((o) => o.toId === modeChar?.id);
  if (myPendingOffers.length > 0) {
    virtualPseudoTools.push({
      id: -8,
      name: "respond_to_offer",
      title: "Ответить на предложение",
      description:
        "Принять (accept) или отклонить (decline) адресованное вам предложение — с ответными словами или без.",
      parametersSchema: {
        type: "object",
        properties: {
          offer: { type: "string", description: "id предложения, напр. 3" },
          decision: { type: "string", description: "accept или decline" },
          words: { type: "string", description: "Что сказать при ответе (необязательно)" },
        },
        required: ["offer", "decision"],
      },
      audience: "all",
      targetParam: null,
      observationTemplate: "{name} отвечает на предложение",
      effects: [],
      cost: 0,
      origin: "manual",
      createdBy: null,
      trainsSkill: "",
      outcomes: [],
      createdAt: "",
    });
  }

  // Стоп-инструменты агентов: выдаются, когда в сцене включены allowAgentStops.
  if (data?.scene.config.allowAgentStops ?? true) {
    virtualPseudoTools.push(
      {
        id: -9,
        name: "leave_scene",
        title: "Уйти из сцены",
        description: "Покинуть сцену: персонаж больше не участвует в ротации ходов.",
        parametersSchema: { type: "object", properties: {} },
        audience: "all",
        targetParam: null,
        observationTemplate: "{name} уходит из сцены",
        effects: [],
        cost: 0,
        origin: "manual",
        createdBy: null,
        trainsSkill: "",
        outcomes: [],
        createdAt: "",
      },
      {
        id: -10,
        name: "block_character",
        title: "Заблокировать персонажа",
        description:
          "Разорвать всякий контакт с участником: он больше не сможет действовать на вас и обращаться к вам.",
        parametersSchema: {
          type: "object",
          properties: { target: { type: "string", description: "Имя участника" } },
          required: ["target"],
        },
        audience: "all",
        targetParam: "target",
        observationTemplate: "{name} блокирует {target}",
        effects: [],
        cost: 0,
        origin: "manual",
        createdBy: null,
        trainsSkill: "",
        outcomes: [],
        createdAt: "",
      }
    );
  }

  // Общение — только тулами: свободный текст модели это мысли, их слышит только Архитектор.
  if ((data?.participants.length ?? 0) > 1) {
    virtualPseudoTools.push(
      {
        id: -11,
        name: "say",
        title: "Сказать вслух",
        description:
          "Сказать фразу вслух — услышат все в сцене (или один, если указать «кому»). " +
          "Обычный текст без тула — внутренние мысли, его никто не слышит.",
        parametersSchema: {
          type: "object",
          properties: {
            phrase: { type: "string", description: "Что сказать (коротко, по-человечески)" },
            to: { type: "string", description: "Кому сказать (необязательно: пусто = всем вслух)" },
          },
          required: ["phrase"],
        },
        audience: "all",
        targetParam: "to",
        observationTemplate: "{name} говорит: «…»",
        effects: [],
        cost: 0,
        origin: "manual",
        createdBy: null,
        trainsSkill: "",
        outcomes: [],
        createdAt: "",
      },
      {
        id: -12,
        name: "text_message",
        title: "Написать в переписку",
        description:
          "Сообщение в переписке (телефон/мессенджер) — увидит только получатель. " +
          "Для общения на расстоянии: сайт знакомств, переписка между встречами.",
        parametersSchema: {
          type: "object",
          properties: {
            text: { type: "string", description: "Текст сообщения (коротко)" },
            to: { type: "string", description: "Имя получателя" },
          },
          required: ["text", "to"],
        },
        audience: "target",
        targetParam: "to",
        observationTemplate: "{name} пишет {to}: «…»",
        effects: [],
        cost: 0,
        origin: "manual",
        createdBy: null,
        trainsSkill: "",
        outcomes: [],
        createdAt: "",
      }
    );
  }

  // Гардероб: виртуальные тулы личного шкафа (как у агентов — при непустом реестре одежды).
  if (hasClothing) {
    virtualPseudoTools.push(
      {
        id: -13,
        name: "wardrobe_browse",
        title: "Посмотреть свой гардероб",
        description:
          "Что надето, что лежит в шкафу и как одежда влияет на самочувствие. Только тебе.",
        parametersSchema: { type: "object", properties: {} },
        audience: "self",
        targetParam: null,
        observationTemplate: "{name} смотрит в гардероб",
        effects: [],
        cost: 0,
        origin: "manual",
        createdBy: null,
        trainsSkill: "",
        outcomes: [],
        createdAt: "",
      },
      {
        id: -14,
        name: "wear_garment",
        title: "Надеть предмет из шкафа",
        description:
          "Надеть предмет из своего гардероба (обмен с тем, что надето). " +
          "Переодевание меняет самочувствие.",
        parametersSchema: {
          type: "object",
          properties: {
            garment: { type: "string", description: "Название предмета из твоего гардероба" },
          },
          required: ["garment"],
        },
        audience: "all",
        targetParam: null,
        observationTemplate: "{name} переодевается",
        effects: [],
        cost: 0,
        origin: "manual",
        createdBy: null,
        trainsSkill: "",
        outcomes: [],
        createdAt: "",
      }
    );
  }

  const modeTools = modeChar
    ? [
        ...tools.filter((t) => modeChar.toolIds.includes(t.id)),
        ...shopPseudoTools,
        ...virtualPseudoTools,
      ]
    : [];
  const selectedTool = modeTools.find((t) => t.id === actionToolId) ?? null;

  const filteredTools = (() => {
    const q = actionSearch.trim().toLowerCase();
    if (!q) return modeTools;
    return modeTools.filter((t) =>
      [t.name, t.title, t.description].some((s) => s.toLowerCase().includes(q))
    );
  })();

  const closeActions = () => {
    setShowActions(false);
    setActionToolId(null);
    setActionError("");
  };

  // Esc в диалоге действий: из формы — к списку, из списка — закрыть
  useEffect(() => {
    if (!showActions) return;
    const h = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (actionToolId != null) {
        setActionToolId(null);
      } else {
        closeActions();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [showActions, actionToolId]);

  /** Варианты выбора для параметра вместо ручного ввода: enum схемы,
   *  x-entity-связи с реестрами и спецслучаи виртуальных тулов — зеркалит
   *  enum-инъекцию движка, чтобы выбор у кукловода совпадал с агентским. */
  const paramPickOptions = (
    tool: Tool,
    key: string,
    prop: { type?: string; description?: string; enum?: unknown[]; "x-entity"?: string }
  ): { value: string; label: string; title?: string }[] | null => {
    const others = (data?.participants ?? []).filter((p) => p.id !== modeChar?.id);
    const charOpts = others.map((p) => ({ value: p.name, label: `${p.emoji} ${p.name}` }));
    const shopOpts = shopItems.map((i) => ({
      value: i.name,
      label: `${i.emoji} ${i.name} — $${i.price}`,
    }));
    // 1. Явный enum в схеме — фиксированный список значений от автора тула
    if (
      Array.isArray(prop.enum) &&
      prop.enum.length > 0 &&
      prop.enum.every((v) => typeof v === "string")
    )
      return (prop.enum as string[]).map((v) => ({ value: v, label: v }));
    // 2. targetParam и x-entity: те же списки живых сущностей, что движок даёт агенту
    const ent = prop["x-entity"];
    if (ent === "character" || (ent == null && tool.targetParam === key))
      return charOpts.length > 0 ? charOpts : null;
    if (ent === "place")
      return places.map((p) => ({ value: p.name, label: p.name, title: p.description }));
    if (ent === "product" || ent === "garment") return shopOpts;
    if (ent === "slot") return clothingSlots.map((s) => ({ value: s.slot, label: s.slot }));
    if (ent === "attribute")
      return attrs.map((a) => ({ value: a.key, label: `${a.emoji} ${a.label}`, title: a.key }));
    // 3. Виртуальные тулы движка: enum подставляется по имени тула и параметру
    if (tool.name === "respond_to_offer" && key === "offer")
      return myPendingOffers.map((o) => ({
        value: String(o.id),
        label: `#${o.id} «${o.toolTitle}» — от ${o.fromName}`,
        title: `аргументы: ${JSON.stringify(o.args)}`,
      }));
    if (tool.name === "shop_buy" && key === "item") return shopOpts;
    if (tool.name === "reveal_attribute" && key === "attribute")
      return attrs
        .filter((a) => a.visibility === "hidden")
        .map((a) => ({ value: a.key, label: `${a.emoji} ${a.label}`, title: a.key }));
    if ((tool.name === "undress" || tool.name === "wear") && key === "slot") {
      const wornOf = (slot: string) => String(modeChar?.state[`worn_${slot}`] ?? "");
      const carriedOf = (slot: string) => String(modeChar?.state[`carried_${slot}`] ?? "");
      return clothingSlots.map((s) => {
        if (tool.name === "undress") {
          const w = wornOf(s.slot);
          return { value: s.slot, label: w ? `${s.slot} — надето: ${w}` : `${s.slot} — пусто` };
        }
        const c = carriedOf(s.slot);
        return { value: s.slot, label: c ? `${s.slot} — при тебе: ${c}` : `${s.slot} — ничего` };
      });
    }
    if (tool.name === "wear_garment" && key === "garment")
      return ownedGarments.map((g) => ({ value: g.name, label: `${g.emoji || "👕"} ${g.name}` }));
    return null;
  };

  const openAction = (toolId: number) => {
    setActionToolId(toolId);
    // Адресные параметры предзаполняем: если собеседник в сцене один — это он
    const tool = modeTools.find((t) => t.id === toolId);
    const others = participants.filter((p) => p.id !== modeChar?.id);
    const preset: Record<string, string> = {};
    if (tool && modeChar && others.length === 1) {
      for (const [key, p] of Object.entries(
        (tool.parametersSchema?.properties ?? {}) as Record<
          string,
          { type?: string; description?: string }
        >
      )) {
        if (
          (p.type === "string" || !p.type) &&
          (/^(to|who|for|target|recipient)$/i.test(key) ||
            /персонаж|получател|кому/i.test(p.description ?? ""))
        ) {
          preset[key] = others[0].name;
        }
      }
    }
    // respond_to_offer: решение по умолчанию — принять, единственное
    // входящее предложение выбираем сразу (никаких id руками).
    if (tool?.name === "respond_to_offer" && modeChar) {
      const mine = offers.filter((o) => o.toId === modeChar.id);
      if (mine.length === 1 && !preset.offer) preset.offer = String(mine[0].id);
      if (!preset.decision) preset.decision = "accept";
    }
    setActionValues(preset);
    setActionError("");
  };  const runAction = async () => {
    if (!selectedTool || !modeChar) return;
    setActionError("");
    const props = (selectedTool.parametersSchema?.properties ?? {}) as Record<
      string,
      { type?: string }
    >;
    const args: Record<string, unknown> = {};
    for (const [k, p] of Object.entries(props)) {
      const v = actionValues[k];
      if (v === undefined || v === "") continue;
      if (p.type === "number") {
        const n = Number(v);
        if (Number.isNaN(n)) {
          setActionError(`«${k}» должно быть числом`);
          return;
        }
        args[k] = n;
      } else if (p.type === "boolean") {
        args[k] = v === "true";
      } else if (v.trim().startsWith("{") || v.trim().startsWith("[")) {
        try {
          args[k] = JSON.parse(v);
        } catch {
          setActionError(`«${k}» — невалидный JSON`);
          return;
        }
      } else {
        args[k] = v;
      }
    }
    for (const r of (selectedTool.parametersSchema?.required ?? []) as string[]) {
      if (args[r] === undefined) {
        setActionError(`Заполните обязательное поле «${r}»`);
        return;
      }
    }
    setActionBusy(true);
    try {
      await apiPost(`/api/scenes/${sid}/act`, {
        characterId: modeChar.id,
        toolName: selectedTool.name,
        args,
      });
      setShowActions(false);
      setActionToolId(null);
      // Предложения могли создаться/закрыться — освежим (SSE тоже подтянет).
      loadOffers();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setActionBusy(false);
    }
  };

  const openApi = async (characterId: number, turn: number) => {
    setApiQuery({ characterId, turn });
    setApiLogs(null);
    try {
      setApiLogs(await api<ApiLog[]>(`/api/scenes/${sid}/apilogs?characterId=${characterId}&turn=${turn}`));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const saveSettings = async () => {
    setError("");
    setSettingsSaved(false);
    try {
      await apiPatch(`/api/scenes/${sid}`, {
        setting: settingsForm.setting,
        config: {
          rulesExtra: settingsForm.rulesExtra,
          turnDelayMs: settingsForm.turnDelayMs,
          contextEvents: settingsForm.contextEvents,
          pauseForHumans: settingsForm.pauseForHumans,
          maxApiCallsPerScene: settingsForm.maxApiCallsPerScene,
          maxTokensPerScene: settingsForm.maxTokensPerScene,
          allowToolRequests: settingsForm.allowToolRequests,
          allowAgentStops: settingsForm.allowAgentStops,
          place: settingsForm.place,
          finish: finishOn ? { conditions: finishConditions, delayTurns: finishDelay } : null,
        },
        goals: goalDrafts,
      });
      setSettingsSaved(true);
      loadScene();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const openScores = async () => {
    setShowScores(true);
    setScores(null);
    try {
      setScores(await api<CharacterScore[]>(`/api/scenes/${sid}/scores`));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  /** Красивое имя характеристики для заявок: «😊 Настроение», а не «mood». */
  const attrName = (key: string) => {
    const a = attrs.find((x) => x.key === key);
    return a ? `${a.emoji ? a.emoji + " " : ""}${a.label}` : key;
  };
  const pendingCount = requests?.filter((r) => r.status === "pending").length ?? 0;

  const decide = async (reqId: number, action: "approve" | "reject") => {
    setRequestBusy(reqId);
    setError("");
    try {
      await apiPost(`/api/tool-requests/${reqId}/decision`, {
        action,
        reason: requestReasons[reqId] ?? "",
      });
      setRequestReasons((s) => {
        const next = { ...s };
        delete next[reqId];
        return next;
      });
      await loadRequests();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRequestBusy(0);
    }
  };

  /** Ответ на предложение прямо из карточки в ленте: действуем от лица адресата. */
  const respondOffer = async (offerId: number, toId: number, decision: "accept" | "decline") => {
    setOfferBusy(offerId);
    setError("");
    try {
      await apiPost(`/api/scenes/${sid}/act`, {
        characterId: toId,
        toolName: "respond_to_offer",
        args: { offer: String(offerId), decision },
      });
      await loadOffers();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setOfferBusy(null);
    }
  };

  if (!data) {
    return (
      <div className="mx-auto max-w-6xl px-8 py-10">
        <ErrorText>{error || "Загрузка…"}</ErrorText>
      </div>
    );
  }

  const { scene, participants, runtime } = data;
  const nextChar = runtime.nextCharacterId != null ? charById.get(runtime.nextCharacterId) : null;

  /** Лента: «Архитектор (всё)» — без фильтра (включая audience:"none" и личные мысли),
   *  иначе — глазами выбранного персонажа (клиентский фильтр видимости). */
  const feedViewOptions = [
    { value: "architect", label: "👁 Архитектор (всё)" },
    ...participants.map((p) => ({ value: String(p.id), label: `${p.emoji} ${p.name}` })),
  ];
  const shownEvents =
    feedView === "architect"
      ? events
      : events.filter((ev) => visibleForCharacter(ev, Number(feedView)));

  const curDelay = scene.config.turnDelayMs ?? 5000;
  const delayOptions = [
    ...(!DELAY_PRESETS.includes(curDelay)
      ? [{ value: String(curDelay), label: `${delayLabel(curDelay)} (свой)` }]
      : []),
    ...DELAY_PRESETS.map((ms) => ({ value: String(ms), label: delayLabel(ms) })),
  ];
  const setDelay = async (ms: number) => {
    try {
      await apiPatch(`/api/scenes/${sid}`, { config: { turnDelayMs: ms } });
      loadScene();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="flex h-screen flex-col">
      {/* Шапка */}
      <header className="flex flex-wrap items-center gap-3 border-b border-line px-6 py-3">
        <Link href="/scenes" className="text-muted transition-colors hover:text-fg">
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate font-semibold">{scene.name}</span>
            <StatusBadge status={runtime.status} />
            <Badge>ход {runtime.turn + (runtime.status === "running" ? 1 : 0)}</Badge>
            {runtime.status === "running" && nextChar && (
              <Badge color="accent">
                <Zap className="h-3 w-3" /> сейчас: {nextChar.emoji} {nextChar.name}
              </Badge>
            )}
            <Badge>
              вызовов API: {runtime.spentApiCalls}
              {scene.config.maxApiCallsPerScene > 0 ? ` / ${scene.config.maxApiCallsPerScene}` : ""}
            </Badge>
            <Badge>токенов: {runtime.spentTokens.toLocaleString("ru-RU")}</Badge>
            <span className={`h-1.5 w-1.5 rounded-full ${connected ? "bg-ok" : "bg-err"}`} title={connected ? "SSE подключен" : "нет соединения"} />
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <div
            className="w-40 shrink-0"
            title="Пауза между ходами агентов — применяется со следующего хода, можно менять на лету"
          >
            <Dropdown
              size="md"
              value={String(curDelay)}
              options={delayOptions}
              onChange={(v) => setDelay(Number(v))}
            />
          </div>
          {runtime.status !== "running" && (
            <Btn
              onClick={restartDialogue}
              loading={busy === "resetFull"}
              title="Стереть историю диалога: события, отношения, память и состояния — с чистого листа"
            >
              <RotateCcw className="h-4 w-4" /> Заново
            </Btn>
          )}
          {(runtime.status === "idle" || runtime.status === "finished") && (
            <Btn variant="primary" onClick={() => control("start")} loading={busy === "start"}>
              <Play className="h-4 w-4" /> Старт
            </Btn>
          )}
          {runtime.status === "paused" && (
            <Btn variant="primary" onClick={() => control("resume")} loading={busy === "resume"}>
              <Play className="h-4 w-4" /> Продолжить
            </Btn>
          )}
          {runtime.status === "running" && (
            <Btn onClick={() => control("pause")} loading={busy === "pause"}>
              <Pause className="h-4 w-4" /> Пауза
            </Btn>
          )}
          {(runtime.status === "paused" || runtime.status === "idle") && (
            <Btn onClick={() => control("step")} loading={busy === "step"} title="Один ход и стоп">
              <SkipForward className="h-4 w-4" /> Шаг
            </Btn>
          )}
          {(runtime.status === "running" || runtime.status === "paused") && (
            <Btn variant="danger" onClick={() => control("stop")} loading={busy === "stop"}>
              <Square className="h-4 w-4" /> Стоп
            </Btn>
          )}
          <div className="relative">
            <IconBtn
              variant={showRequests ? "outline" : "ghost"}
              label="Заявки агентов на новые инструменты"
              onClick={() => {
                setShowRequests((v) => !v);
                loadRequests();
              }}
              className={pendingCount > 0 ? "text-warn" : ""}
            >
              <Inbox className="h-[18px] w-[18px]" />
            </IconBtn>
            {pendingCount > 0 && (
              <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-warn px-1 text-[10px] font-bold text-black">
                {pendingCount}
              </span>
            )}
          </div>
          <IconBtn
            variant={showScores ? "outline" : "ghost"}
            label="Оценка участников по схемам валидации"
            onClick={openScores}
            className={participants.some((p) => p.validationSchemaId != null) ? "text-warn" : ""}
          >
            <Trophy className="h-[18px] w-[18px]" />
          </IconBtn>
          <IconBtn
            variant={showSettings ? "outline" : "ghost"}
            label="Настройки сцены"
            onClick={() => setShowSettings((v) => !v)}
          >
            <Settings2 className="h-[18px] w-[18px]" />
          </IconBtn>
        </div>
      </header>

      {showSettings && (
        <div className="border-b border-line bg-panel/50 px-6 py-4">
          <div className="grid gap-3 lg:grid-cols-2">
            <Field label="Обстановка сцены">
              <Textarea
                rows={2}
                value={settingsForm.setting}
                onChange={(e) => setSettingsForm({ ...settingsForm, setting: e.target.value })}
              />
            </Field>
            <Field
              label="Место действия"
              hint={
                places.length === 0
                  ? "Сначала создайте места в разделе „Характеристики“ → „Места“"
                  : "окружение: влияет на границы и одежду"
              }
            >
              <Dropdown
                value={settingsForm.place}
                options={settingsPlaceOptions}
                onChange={(v) => setSettingsForm({ ...settingsForm, place: v })}
                disabled={places.length === 0}
                title="Места из реестра (раздел «Характеристики»)"
              />
            </Field>
            <Field label="Дополнительные правила (всем персонажам)">
              <Textarea
                rows={2}
                value={settingsForm.rulesExtra}
                onChange={(e) => setSettingsForm({ ...settingsForm, rulesExtra: e.target.value })}
              />
            </Field>
            <Field label="Пауза между ходами, мс">
              <Input
                type="number"
                min={0}
                step={100}
                value={settingsForm.turnDelayMs}
                onChange={(e) => setSettingsForm({ ...settingsForm, turnDelayMs: Number(e.target.value) })}
              />
            </Field>
            <Field label="Событий в контексте">
              <Input
                type="number"
                min={5}
                value={settingsForm.contextEvents}
                onChange={(e) => setSettingsForm({ ...settingsForm, contextEvents: Number(e.target.value) })}
              />
            </Field>
            <label className="flex cursor-pointer items-center gap-2 self-end pb-2 text-sm">
              <input
                type="checkbox"
                checked={settingsForm.pauseForHumans}
                onChange={(e) => setSettingsForm({ ...settingsForm, pauseForHumans: e.target.checked })}
                className="h-4 w-4 accent-[var(--color-accent)]"
              />
              <span className="text-muted">Пауза для человека после каждого круга ИИ</span>
            </label>
            <label className="flex cursor-pointer items-center gap-2 self-end pb-2 text-sm">
              <input
                type="checkbox"
                checked={settingsForm.allowToolRequests}
                onChange={(e) => setSettingsForm({ ...settingsForm, allowToolRequests: e.target.checked })}
                className="h-4 w-4 accent-[var(--color-accent)]"
              />
              <span className="text-muted">
                Разрешить агентам просить новые инструменты (request_tool)
              </span>
            </label>
            <label className="flex cursor-pointer items-center gap-2 self-end pb-2 text-sm">
              <input
                type="checkbox"
                checked={settingsForm.allowAgentStops}
                onChange={(e) => setSettingsForm({ ...settingsForm, allowAgentStops: e.target.checked })}
                className="h-4 w-4 accent-[var(--color-accent)]"
              />
              <span className="text-muted">
                Стоп-инструменты агентов (уйти / заблокировать)
              </span>
            </label>

            <div className="sm:col-span-2">
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={finishOn}
                  onChange={(e) => setFinishOn(e.target.checked)}
                  className="h-4 w-4 accent-[var(--color-accent)]"
                />
                <span className="text-muted">Завершать сцену по условиям</span>
              </label>
              {finishOn && (
                <div className="mt-3 rounded-xl border border-line bg-black/20 p-3">
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <span className="text-xs font-medium uppercase tracking-wide text-muted">
                      Условия завершения
                    </span>
                    <span className="text-[11px] text-muted/70">все условия объединяются по «И»</span>
                  </div>
                  <div className="flex flex-col gap-2">
                    {finishConditions.map((cond, i) => {
                      const c = cond;
                      const cid = c.characterId;
                      const charOptions = [
                        { value: "", label: "любой участник" },
                        ...participants.map((p) => ({
                          value: String(p.id),
                          label: `${p.emoji} ${p.name}`,
                        })),
                        ...(cid != null && !participants.some((p) => p.id === cid)
                          ? [{ value: String(cid), label: `#${cid} (не в сцене)` }]
                          : []),
                      ];
                      return (
                        <div
                          key={i}
                          className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-panel-2/40 p-2"
                        >
                          <div className="w-44 shrink-0">
                            <Dropdown
                              value={c.type}
                              title="Тип условия"
                              options={[
                                { value: "toolCall", label: "вызов инструмента" },
                                { value: "outcome", label: "исход инструмента" },
                                { value: "state", label: "значение характеристики" },
                              ]}
                              onChange={(v) =>
                                setFinishConditions((cs) =>
                                  cs.map((x, j) =>
                                    j === i ? makeCondition(v as FinishCondition["type"], cid) : x
                                  )
                                )
                              }
                            />
                          </div>
                          {c.type === "state" ? (
                            <>
                              <div className="w-56 shrink-0">
                                <Dropdown
                                  value={c.key}
                                  title="Ключ состояния персонажа"
                                  options={[
                                    ...attrs.map((a) => ({
                                      value: a.key,
                                      label: `${a.emoji} ${a.label} (${a.key})`,
                                    })),
                                    ...(c.key && !attrs.some((a) => a.key === c.key)
                                      ? [{ value: c.key, label: `${c.key} (нет в реестре)` }]
                                      : []),
                                  ]}
                                  onChange={(v) =>
                                    setFinishConditions((cs) =>
                                      cs.map((x, j) => (j === i ? patchCondition(x, { key: v }) : x))
                                    )
                                  }
                                />
                              </div>
                              <div className="w-20 shrink-0">
                                <Dropdown
                                  value={c.op}
                                  title="Сравнение"
                                  options={[
                                    { value: ">=", label: "≥" },
                                    { value: "<", label: "<" },
                                    { value: "=", label: "=" },
                                  ]}
                                  onChange={(v) =>
                                    setFinishConditions((cs) =>
                                      cs.map((x, j) => (j === i ? patchCondition(x, { op: v }) : x))
                                    )
                                  }
                                />
                              </div>
                              <Input
                                type="number"
                                value={String(c.value)}
                                title="Значение"
                                onChange={(e) =>
                                  setFinishConditions((cs) =>
                                    cs.map((x, j) =>
                                      j === i ? patchCondition(x, { value: Number(e.target.value) }) : x
                                    )
                                  )
                                }
                                className="w-24"
                              />
                            </>
                          ) : (
                            <>
                              <div className="w-60 shrink-0">
                                <Dropdown
                                  value={c.toolName}
                                  title="Инструмент"
                                  options={toolOptions}
                                  onChange={(v) =>
                                    setFinishConditions((cs) =>
                                      cs.map((x, j) =>
                                        j === i
                                          ? patchCondition(
                                              x,
                                              c.type === "outcome"
                                                ? { toolName: v, outcomeId: "" }
                                                : { toolName: v }
                                            )
                                          : x
                                      )
                                    )
                                  }
                                />
                              </div>
                              {c.type === "outcome" &&
                                (() => {
                                  const outs =
                                    tools.find((t) => t.name === c.toolName)?.outcomes ?? [];
                                  return outs.length === 0 ? (
                                    <span className="text-[11px] text-muted">
                                      у инструмента нет исходов
                                    </span>
                                  ) : (
                                    <div className="w-56 shrink-0">
                                      <Dropdown
                                        value={c.outcomeId}
                                        title="Исход инструмента"
                                        options={outs.map((o) => ({
                                          value: o.id,
                                          label: o.title || o.id,
                                        }))}
                                        onChange={(v) =>
                                          setFinishConditions((cs) =>
                                            cs.map((x, j) =>
                                              j === i ? patchCondition(x, { outcomeId: v }) : x
                                            )
                                          )
                                        }
                                      />
                                    </div>
                                  );
                                })()}
                            </>
                          )}
                          <div className="w-44 shrink-0">
                            <Dropdown
                              value={cid != null ? String(cid) : ""}
                              title="Кто выполняет: любой участник или конкретный"
                              options={charOptions}
                              onChange={(v) =>
                                setFinishConditions((cs) =>
                                  cs.map((x, j) =>
                                    j === i
                                      ? patchCondition(x, {
                                          characterId: v === "" ? undefined : Number(v),
                                        })
                                      : x
                                  )
                                )
                              }
                            />
                          </div>
                          <button
                            type="button"
                            className="ml-auto px-1 text-muted transition-colors hover:text-err"
                            title="Убрать условие"
                            onClick={() => setFinishConditions((cs) => cs.filter((_, j) => j !== i))}
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                  {finishConditions.length === 0 && (
                    <p className="mt-2 text-xs text-muted">Условий нет — добавьте хотя бы одно.</p>
                  )}
                  <div className="mt-3 flex flex-wrap items-end gap-3">
                    <Btn
                      variant="outline"
                      onClick={() =>
                        setFinishConditions((cs) => [...cs, { type: "toolCall", toolName: "" }])
                      }
                    >
                      + условие
                    </Btn>
                    <Field
                      label="Доиграть ходов после выполнения"
                      hint="Условия выполнились → сцена доигрывает ещё N ходов и завершается (системное событие в ленте)"
                      className="min-w-64"
                    >
                      <Input
                        type="number"
                        min={0}
                        max={1000}
                        value={finishDelay}
                        onChange={(e) => setFinishDelay(Number(e.target.value))}
                      />
                    </Field>
                  </div>
                </div>
              )}
            </div>

            <div className="sm:col-span-2">
              <div className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted">
                Личные цели участников (видит только сам персонаж)
              </div>
              <div className="flex flex-col gap-2">
                {participants.map((p) => (
                  <div key={p.id} className="flex items-center gap-2">
                    <span className="w-24 shrink-0 truncate text-xs">
                      {p.emoji} {p.name}
                    </span>
                    <Input
                      value={goalDrafts[String(p.id)] ?? ""}
                      onChange={(e) =>
                        setGoalDrafts((g) => ({ ...g, [String(p.id)]: e.target.value }))
                      }
                      placeholder="Цель в этой сцене…"
                      className="text-xs"
                    />
                  </div>
                ))}
              </div>
            </div>
            <Field label="Лимит вызовов API (0 = нет)" hint="защита бюджета: сцена встанет на паузу">
              <Input
                type="number"
                min={0}
                value={settingsForm.maxApiCallsPerScene}
                onChange={(e) =>
                  setSettingsForm({ ...settingsForm, maxApiCallsPerScene: Number(e.target.value) })
                }
              />
            </Field>
            <Field label="Лимит токенов (0 = нет)" hint="prompt + completion, по данным usage">
              <Input
                type="number"
                min={0}
                value={settingsForm.maxTokensPerScene}
                onChange={(e) =>
                  setSettingsForm({ ...settingsForm, maxTokensPerScene: Number(e.target.value) })
                }
              />
            </Field>
          </div>
          <div className="mt-3 flex items-center gap-3">
            <Btn variant="primary" onClick={saveSettings}>
              Сохранить настройки
            </Btn>
            {settingsSaved && <span className="text-xs text-ok">сохранено — применится со следующего хода</span>}
          </div>
        </div>
      )}

      <ErrorText>{error}</ErrorText>

      {/* Основная область */}
      <div className="flex min-h-0 flex-1">
        {/* Транскрипт */}
        <div className="relative flex min-w-0 flex-1 flex-col">
          {/* Лента: чьими глазами смотрим + легенда модели общения */}
          <div className="flex flex-wrap items-center gap-3 border-b border-line bg-panel/40 px-6 py-2">
            <div className="w-56 shrink-0">
              <Dropdown
                size="md"
                value={feedView}
                onChange={setFeedView}
                title="Чьими глазами видеть ленту: Архитектор видит всё, персонаж — только свою видимость"
                options={feedViewOptions}
              />
            </div>
            <span className="text-[11px] leading-relaxed text-muted">
              💭 — мысли персонажей, их видите только вы (Архитектор); персонажи обмениваются
              тулами say/text_message и действиями
            </span>
          </div>
          <div ref={scrollRef} onScroll={onScroll} className="flex-1 overflow-y-auto px-6 py-5">
            <div className="mx-auto flex max-w-3xl flex-col gap-3">
              {scene.setting && (
                <div className="mb-2 rounded-xl border border-line bg-panel/60 p-4 text-sm leading-relaxed text-muted">
                  <Clapperboard className="mr-2 inline h-4 w-4 text-accent" />
                  {scene.setting}
                  {scene.config.rulesExtra && (
                    <div className="mt-2 border-t border-line pt-2 text-xs">{scene.config.rulesExtra}</div>
                  )}
                </div>
              )}
              {events.length === 0 && (
                <p className="py-16 text-center text-sm text-muted">
                  Событий ещё нет. Нажмите «Старт» — персонажи начнут действовать по очереди.
                </p>
              )}
              {shownEvents.map((ev) => {
                // Предложения и заявки — интерактивные карточки прямо в ленте:
                // отдельное окно легко пропустить, а решение нужно здесь и сейчас.
                const calls = ev.type === "action" ? ev.payload.calls ?? [] : [];
                const offerCalls = calls.filter((c) => c.offered && c.offerId != null);
                const reqCall = calls.find((c) => c.toolName === "request_tool" && c.ok);
                const hasPlainCalls =
                  calls.length === 0 ||
                  calls.some((c) => !c.offered && c.toolName !== "request_tool");
                return (
                  <Fragment key={ev.id}>
                    {hasPlainCalls && (
                      <EventRow ev={ev} charById={charById} colorOf={colorOf} onOpenApi={openApi} />
                    )}
                    {offerCalls.map((c, i) => {
                      const live = offers.find((o) => o.id === c.offerId) ?? null;
                      const from = charById.get(ev.actorId ?? -1) ?? null;
                      const to = live
                        ? charById.get(live.toId) ?? null
                        : charById.get(c.targetId ?? -1) ?? null;
                      return (
                        <OfferCard
                          key={`offer-${ev.id}-${i}`}
                          live={live}
                          title={live?.toolTitle ?? c.toolName}
                          fromName={live?.fromName ?? from?.name ?? "?"}
                          fromEmoji={live?.fromEmoji ?? from?.emoji ?? "❓"}
                          toName={live?.toName ?? to?.name ?? "?"}
                          toId={live?.toId ?? to?.id ?? -1}
                          offerId={c.offerId!}
                          args={c.args}
                          busy={offerBusy === c.offerId}
                          onRespond={respondOffer}
                        />
                      );
                    })}
                    {reqCall &&
                      (() => {
                        const draftName =
                          typeof reqCall.args?.name === "string" ? reqCall.args.name : "";
                        const actor = charById.get(ev.actorId ?? -1) ?? null;
                        // Заявка могла быть решена в панели или уже закрыта — ищем живую.
                        const req =
                          requests?.find(
                            (r) =>
                              r.status === "pending" &&
                              r.characterId === ev.actorId &&
                              r.toolName === draftName
                          ) ?? null;
                        return (
                          <RequestCard
                            key={`req-${ev.id}`}
                            req={req}
                            draftName={draftName}
                            actorName={actor?.name ?? "?"}
                            actorEmoji={actor?.emoji ?? "❓"}
                            reason={req?.reason ?? String(reqCall.args?.reason ?? "")}
                            busy={requestBusy}
                            reasons={requestReasons}
                            onReason={(id, v) =>
                              setRequestReasons((s) => ({ ...s, [id]: v }))
                            }
                            onDecide={decide}
                          />
                        );
                      })()}
                  </Fragment>
                );
              })}
            </div>
          </div>

          {newCount > 0 && (
            <button
              onClick={jumpDown}
              className="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full border border-accent/40 bg-accent/20 px-4 py-1.5 text-xs text-fg shadow-lg backdrop-blur"
            >
              <ArrowDown className="h-3.5 w-3.5" /> {newCount} новых событий
            </button>
          )}
        </div>

        {/* Правая колонка */}
        <aside className="hidden w-72 shrink-0 flex-col gap-3 overflow-y-auto border-l border-line p-4 lg:flex">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted">Участники</div>
          {participants.map((p) => {
            const isNext = runtime.status === "running" && runtime.nextCharacterId === p.id;
            return (
              <Card
                key={p.id}
                className={`p-3 ${isNext ? "border-ok/50 shadow-[0_0_16px_rgba(52,211,153,0.08)]" : ""}`}
              >
                <div className="flex items-center gap-2.5">
                  <span className={`flex h-9 w-9 items-center justify-center rounded-full border border-line bg-panel-2 text-lg ${colorOf(p.id)}`}>
                    {p.emoji}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 truncate text-sm font-medium">
                      {p.name}
                      {p.isHuman && <Badge color="warn">вы</Badge>}
                      {p.goal && (
                        <span title={`Цель: ${p.goal}`} className="cursor-help">
                          <Target className="h-3.5 w-3.5 text-accent/80" />
                        </span>
                      )}
                      {isNext && <span className="pulse-dot h-1.5 w-1.5 rounded-full bg-ok" />}
                    </div>
                    <div className="truncate text-[11px] text-muted">
                      {p.isHuman ? "управляется вами" : `${p.model || "?"} · ${p.providerName}`}
                    </div>
                  </div>
                </div>
                {p.goal && (
                  <p className="mt-1.5 line-clamp-2 rounded-md border border-accent/20 bg-accent/5 px-2 py-1 text-[11px] leading-relaxed text-muted" title={p.goal}>
                    🎯 {p.goal}
                  </p>
                )}
                {Object.keys(p.state).length > 0 && (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-[11px] text-muted hover:text-fg">
                      состояние
                    </summary>
                    <pre className="mt-1 max-h-48 overflow-auto rounded-lg bg-black/30 p-2 font-mono text-[10px] leading-relaxed text-muted">
                      {JSON.stringify(p.state, null, 2)}
                    </pre>
                  </details>
                )}
              </Card>
            );
          })}
        </aside>
      </div>

      {/* Ввод: Архитектор или персонаж */}
      <footer className="border-t border-line bg-panel/60 px-6 py-3">
        <div className="mx-auto max-w-3xl">
          {/* Тоггл «кто говорит» */}
          <div className="mb-2 flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() => {
                modeTouchedRef.current = true;
                setMode("director");
                setShowActions(false);
              }}
              className={`flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-colors ${
                mode === "director"
                  ? "border-warn/50 bg-warn/15 text-warn"
                  : "border-line bg-panel-2/50 text-muted hover:text-fg"
              }`}
            >
              <Megaphone className="h-3 w-3" /> Архитектор
            </button>
            {participants.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => {
                  modeTouchedRef.current = true;
                  setMode(String(p.id));
                  setShowActions(false);
                }}
                className={`flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-colors ${
                  mode === String(p.id)
                    ? "border-accent/60 bg-accent/20 text-fg"
                    : "border-line bg-panel-2/50 text-muted hover:text-fg"
                }`}
              >
                <span>{p.emoji}</span>
                {p.name}
                {p.isHuman ? (
                  <span className="text-[10px] text-warn">вы</span>
                ) : (
                  <span className="text-[10px] opacity-50">ИИ</span>
                )}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2">
            {mode === "director" ? (
              <Megaphone className="h-4 w-4 shrink-0 text-warn" />
            ) : (
              <span className="shrink-0 text-lg leading-none">{modeChar?.emoji}</span>
            )}
            <Input
              value={directorText}
              onChange={(e) => setDirectorText(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && send()}
              placeholder={
                mode === "director"
                  ? "Архитектор → сцена: событие мира или мысль персонажу…"
                  : `Реплика от лица ${modeChar?.name ?? "персонажа"}…`
              }
              className="flex-1"
            />
            {mode === "director" ? (
              <Dropdown
                value={directorTarget}
                onChange={setDirectorTarget}
                title="Кому адресовано событие от Архитектора"
                options={[
                  { value: "all", label: "всем (событие мира)" },
                  ...participants.map((p) => ({
                    value: String(p.id),
                    label: `одному: ${p.name} (мысль в голову)`,
                  })),
                ]}
              />
            ) : (
              <Btn
                variant={showActions ? "primary" : "outline"}
                onClick={() => {
                  setShowActions((v) => !v);
                  setActionToolId(null);
                }}
                title="Вызвать инструмент вручную"
              >
                <Zap className="h-4 w-4" /> Действие
              </Btn>
            )}
            <Btn variant={mode === "director" ? "outline" : "primary"} onClick={send}>
              Отправить
            </Btn>
          </div>
          {mode === "director" && directorTarget !== "all" && (
            <p className="mt-1.5 text-[11px] leading-relaxed text-muted/70">
              Личное событие приходит персонажу как собственная мысль, без фигуры наблюдателя.
            </p>
          )}
        </div>
      </footer>

      {/* Диалог ручных действий: поиск + сетка карточек + форма */}
      {showActions && mode !== "director" && modeChar && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6 backdrop-blur-sm"
          onClick={closeActions}
        >
          <div
            className="flex max-h-[82vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-line bg-panel shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2.5 border-b border-line px-5 py-3.5">
              <Zap className="h-4 w-4 text-accent" />
              <span className="text-sm font-medium">
                Действия: {modeChar.emoji} {modeChar.name}
              </span>
              <button className="ml-auto text-muted hover:text-fg" onClick={closeActions}>
                <X className="h-4 w-4" />
              </button>
            </div>

            {!selectedTool ? (
              <div className="flex min-h-0 flex-1 flex-col">
                <div className="border-b border-line px-5 py-3">
                  <input
                    autoFocus
                    value={actionSearch}
                    onChange={(e) => setActionSearch(e.target.value)}
                    placeholder={`Поиск среди ${modeTools.length} инструментов…`}
                    className="w-full rounded-lg border border-line bg-black/30 px-3 py-2 text-sm text-fg outline-none placeholder:text-muted/50 focus:border-accent/60"
                  />
                </div>
                <div className="flex-1 overflow-y-auto p-4">
                  {filteredTools.length === 0 ? (
                    <p className="py-10 text-center text-sm text-muted">
                      {modeTools.length === 0
                        ? "У этого персонажа нет инструментов — назначьте их в редакторе персонажа."
                        : "Ничего не найдено"}
                    </p>
                  ) : (
                    <div className="grid gap-2 sm:grid-cols-2">
                      {filteredTools.map((t) => (
                        <button
                          key={t.id}
                          type="button"
                          onClick={() => openAction(t.id)}
                          className="rounded-xl border border-line bg-panel-2/40 p-3.5 text-left transition-colors hover:border-accent/50 hover:bg-panel-2"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="truncate text-sm font-medium">
                              {t.title || t.name}
                            </span>
                            <Badge>
                              {t.audience === "all"
                                ? "всем"
                                : t.audience === "target"
                                  ? "получателю"
                                  : t.audience === "self"
                                    ? "себе"
                                    : "скрытое"}
                            </Badge>
                          </div>
                          <div className="mt-0.5 truncate font-mono text-[11px] text-accent/80">
                            {t.name}
                          </div>
                          {t.description && (
                            <p className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-muted">
                              {t.description}
                            </p>
                          )}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="flex min-h-0 flex-1 flex-col">
                <div className="border-b border-line px-5 py-3">
                  <button
                    className="mb-2 text-xs text-muted transition-colors hover:text-fg"
                    onClick={() => setActionToolId(null)}
                  >
                    ← все инструменты
                  </button>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold">
                      {selectedTool.title || selectedTool.name}
                    </span>
                    <span className="font-mono text-[11px] text-accent/80">
                      {selectedTool.name}
                    </span>
                  </div>
                  {selectedTool.description && (
                    <p className="mt-1 text-xs leading-relaxed text-muted">
                      {selectedTool.description}
                    </p>
                  )}
                  <p className="mt-1.5 text-[11px] text-muted/70">
                    Наблюдение: {selectedTool.observationTemplate}
                  </p>
                </div>
                <div className="flex-1 overflow-y-auto p-5">
                  {Object.keys(
                    (selectedTool.parametersSchema?.properties ?? {}) as Record<string, unknown>
                  ).length === 0 ? (
                    <p className="text-sm text-muted">У инструмента нет параметров.</p>
                  ) : (
                    <div className="grid gap-4 sm:grid-cols-2">
                      {Object.entries(
                        (selectedTool.parametersSchema?.properties ?? {}) as Record<
                          string,
                          { type?: string; description?: string }
                        >
                      ).map(([key, p]) => {
                        const required = (
                          (selectedTool.parametersSchema?.required ?? []) as string[]
                        ).includes(key);
                        const isBool = p.type === "boolean";
                        const isNum = p.type === "number";
                        const isStr = p.type === "string" || !p.type;
                        const isComplex = !isBool && !isNum && !isStr;
                        // Эвристики-фолбэки: «получатель» и «место» по имени ключа/описанию
                        const isPlaceParam =
                          isStr && (key === "place" || /место/i.test(p.description ?? ""));
                        const isCharParam =
                          isStr &&
                          !isPlaceParam &&
                          (/^(to|who|for|target|recipient)$/i.test(key) ||
                            /персонаж|получател|кому/i.test(p.description ?? ""));
                        // Выбор из существующих значений вместо ручного ввода:
                        // сначала точные списки (enum/x-entity/виртуальные тулы), потом эвристики.
                        const isDecision = selectedTool.name === "respond_to_offer" && key === "decision";
                        const pickOptions =
                          (isDecision
                            ? null
                            : paramPickOptions(selectedTool, key, p)) ??
                          (isCharParam
                            ? participants.map((pt) => ({ value: pt.name, label: `${pt.emoji} ${pt.name}` }))
                            : isPlaceParam
                              ? places.map((pl) => ({ value: pl.name, label: pl.name, title: pl.description }))
                              : null);
                        const curVal = actionValues[key] ?? "";
                        return (
                          <Field
                            key={key}
                            label={`${key}${required ? " *" : ""}`}
                            hint={p.description}
                            className={isStr || isComplex ? "sm:col-span-2" : ""}
                          >
                            {isBool ? (
                              <Dropdown
                                direction="down"
                                value={actionValues[key] ?? "true"}
                                onChange={(v) => setActionValues((s) => ({ ...s, [key]: v }))}
                                options={[
                                  { value: "true", label: "да" },
                                  { value: "false", label: "нет" },
                                ]}
                              />
                            ) : isDecision ? (
                              <Dropdown
                                direction="down"
                                value={actionValues[key] ?? "accept"}
                                onChange={(v) => setActionValues((s) => ({ ...s, [key]: v }))}
                                options={[
                                  { value: "accept", label: "принять (accept)" },
                                  { value: "decline", label: "отклонить (decline)" },
                                ]}
                              />
                            ) : pickOptions ? (
                              pickOptions.length === 0 ? (
                                <p className="text-xs leading-relaxed text-muted">
                                  Нет доступных значений — выберите нечего.
                                </p>
                              ) : (
                                <ChipChoices
                                  options={pickOptions}
                                  value={curVal}
                                  allowEmpty={!required}
                                  emptyLabel={isCharParam ? "всем / не указывать" : "не указывать"}
                                  onPick={(v) => setActionValues((s) => ({ ...s, [key]: v }))}
                                />
                              )
                            ) : isStr ? (
                              <Textarea
                                rows={2}
                                value={actionValues[key] ?? ""}
                                onChange={(e) =>
                                  setActionValues((v) => ({ ...v, [key]: e.target.value }))
                                }
                              />
                            ) : isComplex ? (
                              <Textarea
                                rows={3}
                                value={actionValues[key] ?? ""}
                                onChange={(e) =>
                                  setActionValues((v) => ({ ...v, [key]: e.target.value }))
                                }
                                placeholder="JSON"
                                className="font-mono text-xs"
                                spellCheck={false}
                              />
                            ) : (
                              <Input
                                type="number"
                                value={actionValues[key] ?? ""}
                                onChange={(e) =>
                                  setActionValues((v) => ({ ...v, [key]: e.target.value }))
                                }
                              />
                            )}
                          </Field>
                        );
                      })}
                    </div>
                  )}
                  <ErrorText>{actionError}</ErrorText>
                </div>
                <div className="flex justify-end gap-2 border-t border-line px-5 py-3">
                  <Btn variant="ghost" onClick={closeActions}>
                    Отмена
                  </Btn>
                  <Btn variant="primary" onClick={runAction} loading={actionBusy}>
                    <Zap className="h-4 w-4" /> Выполнить
                  </Btn>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Панель оценки (скоринг по схемам валидации) */}
      {showScores && (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/50" onClick={() => setShowScores(false)}>
          <div
            className="flex h-full w-[520px] max-w-[90vw] flex-col border-l border-line bg-panel"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 border-b border-line px-4 py-3">
              <Trophy className="h-4 w-4 text-warn" />
              <span className="text-sm font-medium">Оценка участников</span>
              <button className="ml-auto text-muted hover:text-fg" onClick={() => setShowScores(false)}>
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-4">
              {!scores && <p className="text-xs text-muted">Загрузка…</p>}
              {scores && scores.length === 0 && (
                <p className="text-xs leading-relaxed text-muted">
                  Ни к одному участнику сцены не привязана схема валидации. Привяжите схемы при
                  создании сцены (у каждого участника — своя).
                </p>
              )}
              {scores?.map((sc) => {
                const p = charById.get(sc.characterId);
                return (
                  <div key={sc.characterId} className="mb-4 rounded-xl border border-line">
                    <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2.5">
                      <span className={`text-lg ${colorOf(sc.characterId)}`}>{p?.emoji ?? "❓"}</span>
                      <span className="text-sm font-medium">{p?.name ?? "?"}</span>
                      <Badge>{sc.schemaName}</Badge>
                      <span className="ml-auto text-sm font-semibold tabular-nums">
                        <span className={sc.score >= 0 ? "text-ok" : "text-err"}>{sc.score}</span>
                        <span className="text-muted"> / {sc.maxScore}</span>
                      </span>
                    </div>
                    <div className="px-3 py-2.5">
                      <div className="mb-2 h-1.5 overflow-hidden rounded-full bg-black/40">
                        <div
                          className="h-full rounded-full bg-gradient-to-r from-accent to-accent-2"
                          style={{ width: `${sc.completionPct}%` }}
                        />
                      </div>
                      <div className="mb-1 text-[11px] text-muted">
                        обязательные шаги: {sc.completionPct}%
                      </div>
                      {sc.steps.map((st, i) => (
                        <div key={i} className="flex items-center gap-2 py-0.5 text-xs">
                          <span className="w-4 text-center text-muted/50">{i + 1}</span>
                          {st.satisfied ? (
                            <span className="text-ok">✓</span>
                          ) : st.required ? (
                            <span className="text-err">✗</span>
                          ) : (
                            <span className="text-muted/50">○</span>
                          )}
                          <span className="font-mono">{st.toolName}</span>
                          {st.needed > 1 && (
                            <span className="text-muted/60">
                              {st.matched}/{st.needed}
                            </span>
                          )}
                          {st.firstMatchTurn != null && (
                            <span className="text-[10px] text-muted/50">ход {st.firstMatchTurn}</span>
                          )}
                          <span className={`ml-auto tabular-nums ${st.earned > 0 ? "text-ok" : "text-muted/50"}`}>
                            {st.earned > 0 ? `+${st.earned}` : `(${st.points})`}
                          </span>
                        </div>
                      ))}
                      {sc.violations.length > 0 && (
                        <div className="mt-2 rounded-lg border border-err/30 bg-err/5 p-2">
                          {sc.violations.map((v, i) => (
                            <div key={i} className="text-[11px] leading-relaxed text-err">
                              − {v.toolName} (ход {v.turn}): {v.reason}
                            </div>
                          ))}
                        </div>
                      )}
                      {Object.keys(sc.toolStats).length > 0 && (
                        <details className="mt-2">
                          <summary className="cursor-pointer text-[11px] text-muted hover:text-fg">
                            статистика вызовов
                          </summary>
                          <div className="mt-1 space-y-0.5">
                            {Object.entries(sc.toolStats).map(([t, s]) => (
                              <div key={t} className="font-mono text-[10px] text-muted">
                                {t}: ×{s.count} (ходы {s.firstTurn}–{s.lastTurn})
                              </div>
                            ))}
                          </div>
                        </details>
                      )}
                    </div>
                  </div>
                );
              })}
              {scores && scores.length > 0 && (
                <Btn className="w-full" onClick={openScores}>
                  Пересчитать
                </Btn>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Панель заявок на новые инструменты */}
      {showRequests && (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/50" onClick={() => setShowRequests(false)}>
          <div
            className="flex h-full w-[520px] max-w-[90vw] flex-col border-l border-line bg-panel"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 border-b border-line px-4 py-3">
              <Inbox className="h-4 w-4 text-warn" />
              <span className="text-sm font-medium">Заявки на инструменты</span>
              {pendingCount > 0 && <Badge color="warn">{pendingCount} на рассмотрении</Badge>}
              <button className="ml-auto text-muted hover:text-fg" onClick={() => setShowRequests(false)}>
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-4">
              {!requests && <p className="text-xs text-muted">Загрузка…</p>}
              {requests && requests.length === 0 && (
                <p className="text-xs leading-relaxed text-muted">
                  Заявок нет. Включите «Разрешить агентам просить новые инструменты» в настройках
                  сцены — тогда у агентов появится инструмент request_tool, и они смогут предлагать
                  новые действия, когда не найдут подходящего.
                </p>
              )}
              {requests?.map((r) => (
                <div key={r.id} className="mb-4 rounded-xl border border-line">
                  <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2.5">
                    <span className="text-lg">{r.characterEmoji}</span>
                    <span className="text-sm font-medium">{r.characterName}</span>
                    <span className="font-mono text-xs text-accent/80">{r.draft.name}</span>
                    {r.status === "pending" && <Badge color="warn">на рассмотрении</Badge>}
                    {r.status === "approved" && <Badge color="ok">одобрен</Badge>}
                    {r.status === "rejected" && <Badge color="err">отклонён</Badge>}
                    <span className="ml-auto text-[10px] text-muted/60">
                      {new Date(r.createdAt).toLocaleTimeString("ru-RU")}
                    </span>
                  </div>
                  <div className="px-3 py-2.5 text-xs leading-relaxed">
                    {r.reason && (
                      <p className="mb-2 rounded-lg border border-accent/20 bg-accent/5 px-2.5 py-1.5 text-muted">
                        «{r.reason}»
                      </p>
                    )}
                    <div className="grid gap-1 text-muted">
                      <span><span className="text-fg/70">ярлык:</span> {r.draft.title || "—"}</span>
                      <span><span className="text-fg/70">описание:</span> {r.draft.description || "—"}</span>
                      <span>
                        <span className="text-fg/70">видимость:</span>{" "}
                        {r.draft.audience === "all" ? "всем" : r.draft.audience === "target" ? `получателю (${r.draft.targetParam ?? "?"})` : r.draft.audience === "self" ? "только себе" : "скрытое"}
                        {r.draft.cost > 0 && <span className="text-warn"> · цена ${r.draft.cost}</span>}
                      </span>
                      <span><span className="text-fg/70">наблюдение:</span> <span className="italic">{r.draft.observationTemplate || "—"}</span></span>
                      {r.draft.effects.length > 0 && (
                        <span>
                          <span className="text-fg/70">эффекты:</span>{" "}
                          {r.draft.effects.map((e) => `${e.target === "self" ? "актёр" : "получатель"}.${attrName(e.key)} ${e.op === "add" ? "+=" : "="} ${JSON.stringify(e.value)}`).join("; ")}
                        </span>
                      )}
                    </div>
                    <details className="mt-2">
                      <summary className="cursor-pointer text-[11px] text-muted/70 hover:text-muted">схема параметров</summary>
                      <pre className="mt-1 max-h-40 overflow-auto rounded-lg bg-black/30 p-2 font-mono text-[10px] text-muted">
                        {JSON.stringify(r.draft.parametersSchema, null, 2)}
                      </pre>
                    </details>
                    {r.decisionReason && (
                      <p className="mt-2 text-[11px] text-muted/80">Решение: {r.decisionReason}</p>
                    )}
                    {r.status === "pending" && (
                      <div className="mt-3 flex flex-col gap-2">
                        <Input
                          value={requestReasons[r.id] ?? ""}
                          onChange={(e) =>
                            setRequestReasons((s) => ({ ...s, [r.id]: e.target.value }))
                          }
                          placeholder="Комментарий (необязательно): почему да / почему нет"
                          className="text-xs"
                        />
                        <div className="flex gap-2">
                          <Btn
                            className="h-8 flex-1"
                            onClick={() => decide(r.id, "approve")}
                            loading={requestBusy === r.id}
                          >
                            <Check className="h-4 w-4" /> Одобрить и создать
                          </Btn>
                          <Btn
                            variant="danger"
                            className="h-8 flex-1"
                            onClick={() => decide(r.id, "reject")}
                            loading={requestBusy === r.id}
                          >
                            <X className="h-4 w-4" /> Отклонить
                          </Btn>
                        </div>
                        <p className="text-[10px] leading-relaxed text-muted/60">
                          Одобренный инструмент создаётся по черновику, назначается просителю и
                          доступен ему уже со следующего хода. Персонаж получит уведомление от
                          Архитектора.
                        </p>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Инспектор промптов */}
      {apiQuery && (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/50" onClick={() => setApiQuery(null)}>
          <div
            className="flex h-full w-[560px] max-w-[90vw] flex-col border-l border-line bg-panel"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 border-b border-line px-4 py-3">
              <Terminal className="h-4 w-4 text-accent" />
              <span className="text-sm font-medium">
                Запросы к модели: {charById.get(apiQuery.characterId)?.name ?? "?"}, ход {apiQuery.turn}
              </span>
              <button className="ml-auto text-muted hover:text-fg" onClick={() => setApiQuery(null)}>
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-4">
              {!apiLogs && <p className="text-xs text-muted">Загрузка…</p>}
              {apiLogs && apiLogs.length === 0 && (
                <p className="text-xs text-muted">Логов нет.</p>
              )}
              {apiLogs?.map((log) => (
                <div key={log.id} className="mb-4 rounded-lg border border-line">
                  <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2 text-xs">
                    <Badge color="accent">итерация {log.iteration + 1}</Badge>
                    <span className="font-mono text-muted">{log.model}</span>
                    {log.latencyMs != null && <Badge>{log.latencyMs} мс</Badge>}
                    {log.error && <Badge color="err">ошибка</Badge>}
                  </div>
                  {log.error && (
                    <p className="px-3 py-2 text-xs text-err">{log.error}</p>
                  )}
                  <details className="px-3 py-2" open>
                    <summary className="cursor-pointer text-xs text-muted">запрос (messages + tools)</summary>
                    <pre className="mt-2 max-h-72 overflow-auto rounded-lg bg-black/40 p-2 font-mono text-[10px] leading-relaxed text-muted">
                      {(() => {
                        try {
                          return JSON.stringify(JSON.parse(log.requestJson), null, 2);
                        } catch {
                          return log.requestJson;
                        }
                      })()}
                    </pre>
                  </details>
                  {log.responseJson && (
                    <details className="px-3 py-2">
                      <summary className="cursor-pointer text-xs text-muted">ответ модели (raw)</summary>
                      <pre className="mt-2 max-h-72 overflow-auto rounded-lg bg-black/40 p-2 font-mono text-[10px] leading-relaxed text-muted">
                        {(() => {
                          try {
                            return JSON.stringify(JSON.parse(log.responseJson), null, 2);
                          } catch {
                            return log.responseJson;
                          }
                        })()}
                      </pre>
                    </details>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- Карточки решений прямо в ленте ----------

/** Класс чипа выбора (единый стиль с прежними чипами персонажей/мест). */
const chipCls = (active: boolean) =>
  `rounded-full border px-3 py-1 text-xs transition-colors ${
    active
      ? "border-accent/60 bg-accent/20 text-fg"
      : "border-line bg-panel-2/50 text-muted hover:text-fg"
  }`;

/** Чипы выбора значения параметра: существующие сущности вместо ручного ввода. */
function ChipChoices({
  options,
  value,
  allowEmpty,
  emptyLabel = "не указывать",
  onPick,
}: {
  options: { value: string; label: string; title?: string }[];
  value: string;
  allowEmpty: boolean;
  emptyLabel?: string;
  onPick: (v: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {allowEmpty && (
        <button type="button" onClick={() => onPick("")} className={chipCls(value === "")}>
          {emptyLabel}
        </button>
      )}
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          title={o.title}
          onClick={() => onPick(o.value)}
          className={chipCls(value === o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Предложение действия (requiresConsent) в ленте: пока живо — оранжевая
 * карточка с кнопками принять/отклонить от лица адресата; решённое — приглушено.
 */
function OfferCard({
  live,
  title,
  fromName,
  fromEmoji,
  toName,
  toId,
  offerId,
  args,
  busy,
  onRespond,
}: {
  live: SceneOffer | null;
  title: string;
  fromName: string;
  fromEmoji: string;
  toName: string;
  toId: number;
  offerId: number;
  args: Record<string, unknown>;
  busy: boolean;
  onRespond: (offerId: number, toId: number, decision: "accept" | "decline") => void;
}) {
  return (
    <div
      className={`anim-in rounded-xl border px-4 py-3 text-sm ${
        live ? "border-warn/40 bg-warn/5" : "border-line bg-panel/40 opacity-70"
      }`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span title="Предложение действия — ждёт согласия адресата">💍</span>
        <span className="font-medium">
          {fromEmoji} {fromName}
        </span>
        <span className="text-muted">предлагает {toName}:</span>
        <span className="font-medium">«{title}»</span>
        {live ? (
          <>
            <Btn
              className="ml-2 h-8"
              onClick={() => onRespond(offerId, toId, "accept")}
              loading={busy}
              title={`Согласиться за ${toName}: действие произойдёт сразу`}
            >
              <Check className="h-4 w-4" /> Принять
            </Btn>
            <Btn
              variant="danger"
              className="h-8"
              onClick={() => onRespond(offerId, toId, "decline")}
              loading={busy}
              title={`Отказаться за ${toName}`}
            >
              <X className="h-4 w-4" /> Отклонить
            </Btn>
            <span className="text-[11px] text-muted">ждёт ответа: {toName}</span>
          </>
        ) : (
          <span className="text-[11px] text-muted">
            — предложение закрыто (получен ответ или оно сгорело)
          </span>
        )}
      </div>
      {Object.keys(args).length > 0 && (
        <details className="mt-1.5">
          <summary className="cursor-pointer text-[11px] text-muted/70 hover:text-muted">
            с какими параметрами
          </summary>
          <pre className="mt-1 overflow-auto rounded-lg bg-black/30 p-2 font-mono text-[10px] leading-relaxed text-muted">
            {JSON.stringify(args, null, 2)}
          </pre>
        </details>
      )}
    </div>
  );
}

/**
 * Заявка агента на новый инструмент в ленте: пока на рассмотрении —
 * оранжевая карточка с решением Архитектора; решённая — приглушена.
 */
function RequestCard({
  req,
  draftName,
  actorName,
  actorEmoji,
  reason,
  busy,
  reasons,
  onReason,
  onDecide,
}: {
  req: RequestRow | null;
  draftName: string;
  actorName: string;
  actorEmoji: string;
  reason: string;
  busy: number;
  reasons: Record<number, string>;
  onReason: (id: number, v: string) => void;
  onDecide: (id: number, action: "approve" | "reject") => void;
}) {
  const draft = req?.draft ?? null;
  return (
    <div
      className={`anim-in rounded-xl border px-4 py-3 text-sm ${
        req ? "border-warn/40 bg-warn/5" : "border-line bg-panel/40 opacity-70"
      }`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span title="Заявка агента на новый инструмент">🛠</span>
        <span className="font-medium">
          {actorEmoji} {actorName}
        </span>
        <span className="text-muted">просит инструмент:</span>
        <span className="font-medium">
          «{draft?.title || draftName || "?"}»
        </span>
        <span className="font-mono text-[11px] text-accent/80">{draftName}</span>
        {req ? (
          <Badge color="warn">на рассмотрении</Badge>
        ) : (
          <span className="text-[11px] text-muted">— заявка решена</span>
        )}
      </div>
      {reason && (
        <p className="mt-1.5 rounded-lg border border-accent/20 bg-accent/5 px-2.5 py-1.5 text-xs leading-relaxed text-muted">
          «{reason}»
        </p>
      )}
      {draft && draft.description && (
        <p className="mt-1.5 text-xs leading-relaxed text-muted/80">{draft.description}</p>
      )}
      {draft && (
        <details className="mt-1.5">
          <summary className="cursor-pointer text-[11px] text-muted/70 hover:text-muted">
            черновик: параметры, видимость, эффекты
            {draft.cost > 0 ? ` · цена $${draft.cost}` : ""}
          </summary>
          <pre className="mt-1 max-h-40 overflow-auto rounded-lg bg-black/30 p-2 font-mono text-[10px] leading-relaxed text-muted">
            {JSON.stringify(
              {
                параметры: draft.parametersSchema,
                видимость: draft.audience,
                наблюдение: draft.observationTemplate,
                эффекты: draft.effects,
              },
              null,
              2
            )}
          </pre>
        </details>
      )}
      {req && (
        <div className="mt-2.5 flex flex-col gap-2">
          <Input
            value={reasons[req.id] ?? ""}
            onChange={(e) => onReason(req.id, e.target.value)}
            placeholder="Комментарий (необязательно): почему да / почему нет"
            className="text-xs"
          />
          <div className="flex gap-2">
            <Btn
              className="h-8 flex-1"
              onClick={() => onDecide(req.id, "approve")}
              loading={busy === req.id}
            >
              <Check className="h-4 w-4" /> Одобрить и создать
            </Btn>
            <Btn
              variant="danger"
              className="h-8 flex-1"
              onClick={() => onDecide(req.id, "reject")}
              loading={busy === req.id}
            >
              <X className="h-4 w-4" /> Отклонить
            </Btn>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- Рендер одного события ----------

function EventRow({
  ev,
  charById,
  colorOf,
  onOpenApi,
}: {
  ev: SimEvent;
  charById: Map<number, Participant>;
  colorOf: (cid: number | null) => string;
  onOpenApi: (characterId: number, turn: number) => void;
}) {
  const actor = ev.actorId != null ? charById.get(ev.actorId) : null;
  const color = colorOf(ev.actorId);
  const audienceLabel = (a: Audience) => {
    if (a === "all") return null;
    if (a === "none") return "скрытое действие";
    if (Array.isArray(a)) {
      const names = a.map((x) => charById.get(x)?.name ?? "?").join(", ");
      return `видно только: ${names}`;
    }
    return null;
  };

  if (ev.type === "system") {
    return (
      <div className="anim-in py-1 text-center text-[11px] leading-relaxed text-muted/70">
        {ev.payload.message ?? ""}
      </div>
    );
  }

  if (ev.type === "director") {
    // События Архитектора: всем — «событие мира», лично — «мысль в голову» (без фигуры наблюдателя).
    const personal = Array.isArray(ev.audience);
    const label = Array.isArray(ev.audience)
      ? `🔒 Мысль в голову: ${ev.audience.map((x) => charById.get(x)?.name ?? "?").join(", ")}`
      : "Событие мира";
    return (
      <div
        className="anim-in rounded-xl border border-warn/30 bg-warn/5 px-4 py-2.5 text-sm"
        title={
          personal
            ? "Личное событие от Архитектора: персонаж воспринимает его как собственную мысль"
            : "Событие мира от Архитектора: знают все участники"
        }
      >
        <span className="mr-2 text-xs font-medium uppercase tracking-wide text-warn">
          {label}
        </span>
        <span className="text-fg/90">{ev.payload.text}</span>
      </div>
    );
  }

  if (ev.type === "speech") {
    // Свободный текст модели — внутренние мысли: слышит только Архитектор,
    // персонажи общаются тулами say/text_message (их наблюдения — в action-событиях).
    return (
      <div className="anim-in group flex gap-3 opacity-80">
        <span
          className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-dashed border-line bg-panel-2/40 text-lg ${color}`}
        >
          {actor?.emoji ?? "❓"}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={`text-xs font-semibold ${color}`}>{actor?.name ?? "Неизвестный"}</span>
            <span
              className="text-[10px] text-muted/70"
              title="Внутренняя мысль — её видите только вы (Архитектор); персонажи её не слышат"
            >
              💭 (мысль)
            </span>
            <span className="text-[10px] text-muted/50">
              T{ev.turn} · {fmtTime(ev.createdAt)}
            </span>
            <button
              className="ml-auto hidden text-[10px] text-muted/50 hover:text-accent group-hover:block"
              onClick={() => ev.actorId && onOpenApi(ev.actorId, ev.turn)}
              title="Показать промпты и ответ модели"
            >
              <Braces className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="mt-1 whitespace-pre-wrap rounded-xl rounded-tl-sm border border-dashed border-line/70 px-4 py-2 text-sm italic leading-relaxed text-muted">
            {ev.payload.text}
          </div>
        </div>
      </div>
    );
  }

  // action
  const calls = ev.payload.calls ?? [];
  const aud = audienceLabel(ev.audience);
  return (
    <div className="anim-in group flex gap-3">
      <span className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-line bg-panel-2 text-lg ${color}`}>
        {actor?.emoji ?? "❓"}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className={`text-xs font-semibold ${color}`}>{actor?.name ?? "Неизвестный"}</span>
          <Wrench className="h-3 w-3 text-muted" />
          <span className="text-[10px] text-muted/50">
            T{ev.turn} · {fmtTime(ev.createdAt)}
          </span>
          {aud && <span className="rounded-full border border-line px-2 py-0.5 text-[10px] text-muted">{aud}</span>}
          <button
            className="ml-auto hidden text-[10px] text-muted/50 hover:text-accent group-hover:block"
            onClick={() => ev.actorId && onOpenApi(ev.actorId, ev.turn)}
            title="Показать промпты и ответ модели"
          >
            <Braces className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="mt-1 flex flex-col gap-1.5">
          {calls.map((c, i) => (
            <div
              key={c.callId + i}
              className={`rounded-xl border px-3.5 py-2 text-sm ${
                c.ok ? "border-line bg-panel/60" : "border-err/40 bg-err/5"
              }`}
            >
              <span className="font-mono text-xs text-accent/90">{c.toolName}</span>
              {c.observation && (
                <span className="ml-2 italic text-muted">*{c.observation}*</span>
              )}
              {!c.ok && <span className="ml-2 text-xs text-err">{c.result}</span>}
              <details className="mt-1">
                <summary className="cursor-pointer text-[10px] text-muted/60 hover:text-muted">
                  подробности
                </summary>
                <pre className="mt-1 overflow-auto rounded-lg bg-black/30 p-2 font-mono text-[10px] leading-relaxed text-muted">
                  {JSON.stringify(c.args, null, 2)}
                </pre>
                <p className="mt-1 text-[10px] leading-relaxed text-muted/80">→ {c.result}</p>
              </details>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
