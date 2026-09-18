"use client";

import { use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Plus, RefreshCw, Shield, Shirt, Trash2 } from "lucide-react";
import {
  Badge,
  Btn,
  Card,
  ErrorText,
  Field,
  IconBtn,
  Input,
  PageHeader,
  Select,
  Textarea,
} from "@/components/ui";
import { api, apiDelete, apiPatch, apiPost } from "@/components/api";
import { Combobox } from "@/components/Combobox";
import type {
  AttributeDef,
  Character,
  ClothingSlot,
  Garment,
  Place,
  Provider,
  Tool,
  ToolEffect,
} from "@/lib/types";
import { CARRIED_PREFIX, WORN_PREFIX } from "@/lib/types";

const EMOJIS = [
  "👩","👨","🧑","👧","👦","👵","👴","🧓","🦊","🐱","🐺","🦉","🌸","🔥","🌙","⭐",
  "🎧","🎮","☕","🍷","📚","💼","🏡","🚗","💎","👑","🎭","🖤","💜","😄","😎","🥲",
];

const PERSONA_PLACEHOLDER = `Характер, манера речи, привычки, цели и отношение к другим. Например:

Ты — Яна, 24 года. Ты жизнерадостная, немного ветреная, любишь внимание и флирт.
Говоришь легко, с юмором, иногда капризничаешь. Любишь кофе, танцы и поздние разговоры.
Ты встречаешься с Димой, но тебе не хватает его внимания. Твоя цель — добиться, чтобы он пригласил тебя на свидание в кафе.`;

interface FormState {
  name: string;
  emoji: string;
  persona: string;
  providerId: number | null;
  model: string;
  fallbackProviderId: number | null;
  fallbackModel: string;
  temperature: number;
  maxTokens: number;
  toolIds: number[];
  stateText: string;
  isHuman: boolean;
  income: number;
  boundaries: FormBoundary[];
}

const emptyForm: FormState = {
  name: "",
  emoji: "🙂",
  persona: "",
  providerId: null,
  model: "",
  fallbackProviderId: null,
  fallbackModel: "",
  temperature: 0.8,
  maxTokens: 1024,
  toolIds: [],
  stateText: "{}",
  isHuman: false,
  income: 0,
  boundaries: [],
};

/** Слот гардероба: что надето прямо сейчас. */
interface WardrobeSlotView {
  slot: string;
  worn: string | null;
  garmentId: number | null;
}

/** Ответ /wardrobe: что лежит в гардеробе и что надето по слотам. */
interface WardrobeView {
  owned: Garment[];
  slots: WardrobeSlotView[];
}

// ---- Границы: блочный конструктор «когда → условия → отказ» ----

/** Условие срабатывания границы (новый формат бэкенда). */
type BoundaryCondition =
  | { kind: "relation"; op: ">=" | "<" | "="; value: number }
  | { kind: "attr"; owner: "actor" | "target"; key: string; op: ">=" | "<" | "="; value: number }
  | { kind: "place"; place: string }
  | { kind: "worn"; slot: string; bare: boolean };

/** Граница в форме: инструмент + область действия + условия («И») + текст и последствия отказа. */
interface FormBoundary {
  toolName: string;
  scope: "incoming" | "outgoing" | "both";
  conditions: BoundaryCondition[];
  refusalText: string;
  effects: ToolEffect[];
}

/** Запись с сервера: новый формат (conditions) или легаси-поля старого бэкенда. */
interface RawBoundary {
  toolName?: string;
  scope?: "incoming" | "outgoing" | "both";
  conditions?: BoundaryCondition[];
  refusalText?: string;
  effects?: ToolEffect[];
  minRelation?: number | null;
  minAttr?: { key: string; value: number } | null;
  /** @deprecated самый старый порог настроения (ещё до minAttr) */
  minMood?: number | null;
  requirePlace?: string | null;
  requireAttr?: {
    owner: "actor" | "target";
    key: string;
    op: ">=" | "=";
    value: number;
  } | null;
}

/** Легаси-поля → условия нового формата: старые записи не теряются. */
function legacyToConditions(b: RawBoundary): BoundaryCondition[] {
  const out: BoundaryCondition[] = [];
  if (typeof b.minRelation === "number")
    out.push({ kind: "relation", op: ">=", value: b.minRelation });
  if (b.minAttr && typeof b.minAttr.value === "number")
    out.push({ kind: "attr", owner: "target", key: b.minAttr.key, op: ">=", value: b.minAttr.value });
  else if (typeof b.minMood === "number")
    out.push({ kind: "attr", owner: "target", key: "mood", op: ">=", value: b.minMood });
  if (b.requirePlace) out.push({ kind: "place", place: b.requirePlace });
  if (b.requireAttr && typeof b.requireAttr.value === "number")
    out.push({
      kind: "attr",
      owner: b.requireAttr.owner,
      key: b.requireAttr.key,
      op: b.requireAttr.op,
      value: b.requireAttr.value,
    });
  return out;
}

/** Граница с сервера → форма: новый формат; нет условий — защитный разбор легаси. */
function toFormBoundary(raw: RawBoundary): FormBoundary {
  return {
    toolName: raw.toolName ?? "*",
    scope: raw.scope ?? "incoming",
    conditions:
      Array.isArray(raw.conditions) && raw.conditions.length > 0
        ? raw.conditions
        : legacyToConditions(raw),
    refusalText: raw.refusalText ?? "",
    effects: Array.isArray(raw.effects) ? raw.effects : [],
  };
}

/** Правило по умолчанию: любое адресное действие при отношении ≥ 3. */
const defaultBoundary = (): FormBoundary => ({
  toolName: "*",
  scope: "incoming",
  conditions: [{ kind: "relation", op: ">=", value: 3 }],
  refusalText: "мягко уклоняется: слишком рано",
  effects: [],
});

const OP_OPTIONS = [
  { value: ">=", label: "≥" },
  { value: "<", label: "<" },
  { value: "=", label: "=" },
];

/** Вид условия; attr различается владельцем — два отдельных пункта. */
const CONDITION_KIND_OPTIONS = [
  { value: "relation", label: "отношение" },
  { value: "attr:actor", label: "характеристика того, кто действует" },
  { value: "attr:target", label: "характеристика того, на кого действуют" },
  { value: "place", label: "место" },
  { value: "worn", label: "слот одежды" },
];

/** Строка условия: первый Select — вид условия, дальше поля по виду. */
function ConditionRow({
  cond,
  onChange,
  onRemove,
  attributes,
  places,
  slots,
}: {
  cond: BoundaryCondition;
  onChange: (next: BoundaryCondition) => void;
  onRemove: () => void;
  attributes: AttributeDef[];
  places: Place[];
  slots: ClothingSlot[];
}) {
  const kindValue = cond.kind === "attr" ? `attr:${cond.owner}` : cond.kind;
  const setKind = (v: string) => {
    if (v === "relation") onChange({ kind: "relation", op: ">=", value: 3 });
    else if (v === "attr:actor" || v === "attr:target")
      onChange({
        kind: "attr",
        owner: v === "attr:actor" ? "actor" : "target",
        key: attributes[0]?.key ?? "mood",
        op: ">=",
        value: 0,
      });
    else if (v === "place") onChange({ kind: "place", place: places[0]?.name ?? "" });
    else onChange({ kind: "worn", slot: slots[0]?.slot ?? "", bare: true });
  };
  // Варианты ключей из реестра; фактическое значение могло из реестра удалиться.
  const attrOptions = attributes.map((a) => ({
    value: a.key,
    label: `${a.emoji ? a.emoji + " " : ""}${a.label}`,
  }));
  const attrKeyOptions =
    cond.kind === "attr" && !attrOptions.some((o) => o.value === cond.key)
      ? [{ value: cond.key, label: `${cond.key} (нет в реестре)` }, ...attrOptions]
      : attrOptions;
  const placeOptions = places.map((p) => ({ value: p.name, label: p.name }));
  if (cond.kind === "place" && cond.place && !places.some((p) => p.name === cond.place))
    placeOptions.unshift({ value: cond.place, label: `${cond.place} (нет в реестре)` });
  const slotOptions = slots.map((s) => ({ value: s.slot, label: s.slot }));
  if (cond.kind === "worn" && cond.slot && !slots.some((s) => s.slot === cond.slot))
    slotOptions.unshift({ value: cond.slot, label: `${cond.slot} (нет в реестре)` });

  // Числовое условие (relation/attr): оператор и порог пересобираем явно.
  const setOp = (v: string) => {
    const op = v as ">=" | "<" | "=";
    if (cond.kind === "relation") onChange({ kind: "relation", op, value: cond.value });
    else if (cond.kind === "attr")
      onChange({ kind: "attr", owner: cond.owner, key: cond.key, op, value: cond.value });
  };
  const setValue = (n: number) => {
    if (cond.kind === "relation") onChange({ kind: "relation", op: cond.op, value: n });
    else if (cond.kind === "attr")
      onChange({ kind: "attr", owner: cond.owner, key: cond.key, op: cond.op, value: n });
  };
  const opSelect =
    cond.kind === "relation" || cond.kind === "attr" ? (
      <Select
        value={cond.op}
        onChange={setOp}
        className="w-16 shrink-0"
        options={OP_OPTIONS}
      />
    ) : null;
  const numInput =
    cond.kind === "relation" || cond.kind === "attr" ? (
      <Input
        type="number"
        value={cond.value}
        onChange={(e) => setValue(Number(e.target.value))}
        className="w-20 shrink-0"
      />
    ) : null;

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-panel-2/40 px-2.5 py-2">
      <Select
        value={kindValue}
        onChange={setKind}
        className="min-w-44 flex-1"
        options={CONDITION_KIND_OPTIONS}
      />
      {cond.kind === "relation" && (
        <>
          {opSelect}
          {numInput}
        </>
      )}
      {cond.kind === "attr" && (
        <>
          <div className="min-w-40 flex-1">
            <Select
              value={cond.key}
              onChange={(v) =>
                onChange({
                  kind: "attr",
                  owner: cond.owner,
                  key: v,
                  op: cond.op,
                  value: cond.value,
                })
              }
              options={attrKeyOptions}
            />
          </div>
          {opSelect}
          {numInput}
        </>
      )}
      {cond.kind === "place" && (
        <div className="min-w-40 flex-1">
          <Select
            value={cond.place}
            onChange={(v) => onChange({ kind: "place", place: v })}
            options={placeOptions}
          />
        </div>
      )}
      {cond.kind === "worn" && (
        <>
          <div className="min-w-40 flex-1">
            <Select
              value={cond.slot}
              onChange={(v) => onChange({ kind: "worn", slot: v, bare: cond.bare })}
              options={slotOptions}
            />
          </div>
          <Select
            value={cond.bare ? "bare" : "worn"}
            onChange={(v) => onChange({ kind: "worn", slot: cond.slot, bare: v === "bare" })}
            className="min-w-40 flex-1"
            options={[
              { value: "bare", label: "должен быть пуст" },
              { value: "worn", label: "занят" },
            ]}
          />
        </>
      )}
      <IconBtn variant="danger" label="Удалить условие" onClick={onRemove}>
        <Trash2 className="h-3.5 w-3.5" />
      </IconBtn>
    </div>
  );
}

export default function CharacterEditorPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const isNew = id === "new";
  const numericId = Number(id);

  const [form, setForm] = useState<FormState>(emptyForm);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [tools, setTools] = useState<Tool[]>([]);
  const [attributes, setAttributes] = useState<AttributeDef[]>([]);
  const [others, setOthers] = useState<Character[]>([]);
  const [chem, setChem] = useState<{ aId: number; bId: number; value: number }[]>([]);
  const [places, setPlaces] = useState<Place[]>([]);
  const [clothingSlots, setClothingSlots] = useState<ClothingSlot[]>([]);
  const [models, setModels] = useState<string[]>([]);
  const [modelsError, setModelsError] = useState("");
  const [loadingModels, setLoadingModels] = useState(false);
  const [fbModels, setFbModels] = useState<string[]>([]);
  const [fbModelsError, setFbModelsError] = useState("");
  const [loadingFbModels, setLoadingFbModels] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [wardrobe, setWardrobe] = useState<WardrobeView>({ owned: [], slots: [] });
  const [wardrobeBusy, setWardrobeBusy] = useState(false);
  // Опорный state персонажа на момент загрузки страницы (и после каждой
  // синхронизации с сервером). «Сохранить» шлёт ТОЛЬКО отличия от опоры —
  // иначе устаревшие ключи (деньги, потраченные сценой; одежда из карточки
  // гардероба) молча откатывали бы сервер к моменту открытия редактора.
  const baselineRef = useRef<Record<string, unknown> | null>(null);

  const loadMeta = useCallback(() => {
    Promise.all([
      api<Provider[]>("/api/providers"),
      api<Tool[]>("/api/tools"),
      api<AttributeDef[]>("/api/attributes"),
      api<Character[]>("/api/characters").catch(() => [] as Character[]),
      api<{ aId: number; bId: number; value: number }[]>("/api/chemistry").catch(() => []),
      api<Place[]>("/api/places").catch(() => [] as Place[]),
      api<ClothingSlot[]>("/api/clothing-slots").catch(() => [] as ClothingSlot[]),
    ])
      .then(([p, t, a, ch, cm, pl, cs]) => {
        setProviders(p);
        setTools(t);
        setAttributes(a);
        setChem(cm);
        setPlaces(pl);
        setClothingSlots(cs);
        if (!isNew) setOthers(ch.filter((c) => c.id !== numericId));
      })
      .catch((e) => setError(e.message));
  }, [isNew, numericId]);

  useEffect(() => {
    loadMeta();
    if (isNew) {
      setLoaded(true);
      return;
    }
    api<Character>(`/api/characters/${numericId}`)
      .then((c) => {
        baselineRef.current = c.state;
        setForm({
          name: c.name,
          emoji: c.emoji,
          persona: c.persona,
          providerId: c.providerId,
          model: c.model,
          fallbackProviderId: c.fallbackProviderId ?? null,
          fallbackModel: c.fallbackModel ?? "",
          temperature: c.temperature,
          maxTokens: c.maxTokens,
          toolIds: c.toolIds,
          stateText: JSON.stringify(c.state, null, 2),
          isHuman: c.isHuman,
          income: c.income ?? 0,
          // Новый формат (conditions) или защитный разбор легаси-полей старого сервера.
          boundaries: ((c.boundaries ?? []) as unknown as RawBoundary[]).map(toFormBoundary),
        });
        setLoaded(true);
      })
      .catch((e) => setError(e.message));
    // Гардероб: сбой не блокирует редактор.
    api<WardrobeView>(`/api/characters/${numericId}/wardrobe`)
      .then(setWardrobe)
      .catch(() => {});
  }, [isNew, numericId, loadMeta]);

  const loadModels = useCallback(
    async (providerId: number) => {
      setLoadingModels(true);
      setModelsError("");
      try {
        const r = await api<{ models: string[] }>(`/api/providers/${providerId}/models`);
        setModels(r.models);
        if (r.models.length === 0) setModelsError("Список пуст — сервер не отдаёт модели, введите имя вручную");
      } catch (e) {
        setModels([]);
        setModelsError(
          `${e instanceof Error ? e.message : String(e)} — можно ввести имя модели вручную`
        );
      } finally {
        setLoadingModels(false);
      }
    },
    []
  );

  useEffect(() => {
    if (form.providerId) loadModels(form.providerId);
    else setModels([]);
  }, [form.providerId, loadModels]);

  // Модели страховочного провайдера — отдельный список под свою пару полей.
  const loadFbModels = useCallback(async (providerId: number) => {
    setLoadingFbModels(true);
    setFbModelsError("");
    try {
      const r = await api<{ models: string[] }>(`/api/providers/${providerId}/models`);
      setFbModels(r.models);
      if (r.models.length === 0) setFbModelsError("Список пуст — введите имя модели вручную");
    } catch (e) {
      setFbModels([]);
      setFbModelsError(
        `${e instanceof Error ? e.message : String(e)} — можно ввести имя модели вручную`
      );
    } finally {
      setLoadingFbModels(false);
    }
  }, []);

  useEffect(() => {
    if (form.fallbackProviderId) loadFbModels(form.fallbackProviderId);
    else {
      setFbModels([]);
      setFbModelsError("");
    }
  }, [form.fallbackProviderId, loadFbModels]);

  // Разница формы с опорным state: только то, что пользователь реально менял
  // в этом визите редактора (значение или удаление ключа). null = нет правок
  // (или невалидный JSON — тогда state не шлём вовсе, ошибку покажет save()).
  const userStateDiff = (): Record<string, unknown> | null => {
    let cur: Record<string, unknown>;
    try {
      const parsed = JSON.parse(form.stateText || "{}");
      if (!parsed || typeof parsed !== "object") return null;
      cur = parsed as Record<string, unknown>;
    } catch {
      return null;
    }
    const base = baselineRef.current ?? {};
    const diff: Record<string, unknown> = {};
    const keys = new Set([...Object.keys(base), ...Object.keys(cur)]);
    for (const k of keys) {
      const removedHere = k in base && !(k in cur);
      const addedHere = !(k in base) && k in cur;
      if (removedHere) diff[k] = null;
      else if (addedHere || JSON.stringify(base[k]) !== JSON.stringify(cur[k])) diff[k] = cur[k];
    }
    return Object.keys(diff).length > 0 ? diff : null;
  };

  // Гардероб: надеть/снять. Сервер при «надеть» сам выдаёт владение предметом
  // и возвращает свежий вид гардероба — он же и переполучение после мутации.
  // State на сервере тоже изменился (worn_*, эффекты) — подтягиваем его в
  // форму, поверх накатывая несохранённые правки пользователя, и двигаем
  // опору: иначе следующее «Сохранить» откатит переодевание.
  const applyWardrobe = async (garmentId: number, action: "wear" | "remove") => {
    setError("");
    setWardrobeBusy(true);
    try {
      const r = await apiPost<WardrobeView>(`/api/characters/${numericId}/wardrobe`, {
        garmentId,
        action,
      });
      setWardrobe(r);
      // Сначала фиксируем несохранённые правки формы против СТАРОЙ опоры,
      // и только потом двигаем опору на свежий state — иначе само переодевание
      // (его нет в старой опоре) попало бы в диф как «правка наоборот»
      // и следующий «Сохранить» вернул бы снятое обратно.
      const diff = userStateDiff();
      const fresh = await api<Character>(`/api/characters/${numericId}`);
      baselineRef.current = fresh.state;
      const next = { ...fresh.state };
      if (diff) {
        for (const [k, v] of Object.entries(diff)) {
          if (v === null) delete next[k];
          else next[k] = v;
        }
      }
      setForm((f) => ({ ...f, stateText: JSON.stringify(next, null, 2) }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setWardrobeBusy(false);
    }
  };

  const toggleTool = (tid: number) =>
    setForm((f) => ({
      ...f,
      toolIds: f.toolIds.includes(tid)
        ? f.toolIds.filter((x) => x !== tid)
        : [...f.toolIds, tid],
    }));

  // Характеристики: значения живут в state (JSON), поля — просто удобная форма.
  const stateObj = useMemo(() => {
    try {
      const parsed = JSON.parse(form.stateText || "{}");
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }, [form.stateText]);

  const setAttrValue = (key: string, raw: string, type: AttributeDef["type"]) => {
    if (!stateObj) return; // невалидный JSON в ручном редакторе — не трогаем
    const next = { ...stateObj };
    // Пустое поле = null: сервер при PATCH удаляет ключ (state мёржится по
    // ключам, простое отсутствие ключа ничего бы не изменило).
    if (type === "number") {
      if (raw === "") next[key] = null;
      else {
        const n = Number(raw);
        if (Number.isNaN(n)) return;
        next[key] = n;
      }
    } else if (raw === "") {
      next[key] = null;
    } else {
      next[key] = raw;
    }
    setForm((f) => ({ ...f, stateText: JSON.stringify(next, null, 2) }));
  };

  const knownKeys = new Set(attributes.map((a) => a.key));
  // worn_*/carried_* — ключи одежды: ими управляет гардероб, в форме их не правим.
  const isWardrobeKey = (k: string) =>
    k.startsWith(WORN_PREFIX) || k.startsWith(CARRIED_PREFIX);
  const extraKeys = stateObj
    ? Object.keys(stateObj).filter((k) => !knownKeys.has(k) && !isWardrobeKey(k))
    : [];
  const hasWardrobeKeys = stateObj ? Object.keys(stateObj).some(isWardrobeKey) : false;
  // Навыки — характеристики с ключом skill_*: отдельная группа, уровень скрыт.
  const skillAttrs = attributes.filter((a) => a.key.startsWith("skill_"));
  const plainAttrs = attributes.filter((a) => !a.key.startsWith("skill_"));

  const save = async () => {
    setError("");
    if (!form.isHuman && !form.providerId) {
      setError("Выберите провайдера (моделей)");
      return;
    }
    let state: Record<string, unknown>;
    try {
      const parsed = JSON.parse(form.stateText || "{}");
      if (!parsed || typeof parsed !== "object") throw new Error("no");
      state = parsed;
    } catch {
      setError("Состояние (JSON) невалидно");
      return;
    }
    // Существующему персонажу шлём только отличия от опорного state: сервер
    // с момента открытия редактора мог поменять другие ключи (сцена потратила
    // деньги, карточка гардероба переодела) — их откатывать нельзя.
    const body = {
      name: form.name,
      emoji: form.emoji || "🙂",
      persona: form.persona,
      providerId: form.isHuman ? null : form.providerId,
      model: form.isHuman ? "" : form.model,
      fallbackProviderId: form.isHuman ? null : form.fallbackProviderId,
      fallbackModel: form.isHuman ? "" : form.fallbackModel,
      temperature: form.temperature,
      maxTokens: form.maxTokens,
      toolIds: form.toolIds,
      state: isNew ? state : (userStateDiff() ?? undefined),
      isHuman: form.isHuman,
      income: form.income,
      boundaries: form.boundaries,
    };
    setSaving(true);
    try {
      if (isNew) {
        await apiPost("/api/characters", body);
      } else {
        await apiPatch(`/api/characters/${numericId}`, body);
        baselineRef.current = state;
      }
      router.push("/characters");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!confirm(`Удалить персонажа «${form.name}»?`)) return;
    setError("");
    try {
      await apiDelete(`/api/characters/${numericId}`);
      router.push("/characters");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const selectedProvider = useMemo(
    () => providers.find((p) => p.id === form.providerId),
    [providers, form.providerId]
  );
  const selectedFallbackProvider = useMemo(
    () => providers.find((p) => p.id === form.fallbackProviderId),
    [providers, form.fallbackProviderId]
  );

  // «В шкафу»: выданные, но сейчас не надетые предметы со слотом (их можно надеть).
  const closetGarments = useMemo(() => {
    const wornIds = new Set(wardrobe.slots.map((s) => s.garmentId));
    return wardrobe.owned.filter((g) => g.slot && !wornIds.has(g.id));
  }, [wardrobe]);

  if (!loaded) {
    return (
      <div className="mx-auto max-w-4xl px-8 py-10">
        <ErrorText>{error || "Загрузка…"}</ErrorText>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl px-8 py-10">
      <PageHeader
        title={isNew ? "Новый персонаж" : `Персонаж: ${form.name}`}
        subtitle="Личность, модель и доступные действия."
        actions={
          <>
            <Btn variant="ghost" onClick={() => router.push("/characters")}>
              <ArrowLeft className="h-4 w-4" /> К списку
            </Btn>
            {!isNew && (
              <Btn variant="danger" onClick={remove}>
                <Trash2 className="h-4 w-4" /> Удалить
              </Btn>
            )}
            <Btn variant="primary" onClick={save} loading={saving}>
              Сохранить
            </Btn>
          </>
        }
      />
      <ErrorText>{error}</ErrorText>

      <Card className="mb-4 p-5">
        <label className="flex cursor-pointer items-center gap-3">
          <input
            type="checkbox"
            checked={form.isHuman}
            onChange={(e) => setForm({ ...form, isHuman: e.target.checked })}
            className="h-4 w-4 accent-[var(--color-accent)]"
          />
          <span className="text-sm">
            <b>Этот персонаж — вы.</b>{" "}
            <span className="text-muted">
              Движок не играет за него: вы пишете реплики и вызываетаете инструменты вручную
              прямо в комнате сцены. Модель и провайдер не нужны.
            </span>
          </span>
        </label>
      </Card>

      <Card className="mb-4 p-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Имя">
            <Input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="Яна"
            />
          </Field>
          <Field label="Аватар">
            <div className="flex flex-wrap gap-1">
              {EMOJIS.map((e) => (
                <button
                  key={e}
                  type="button"
                  onClick={() => setForm({ ...form, emoji: e })}
                  className={`h-8 w-8 rounded-lg text-lg leading-none transition-colors ${
                    form.emoji === e ? "bg-accent/25 ring-1 ring-accent" : "hover:bg-panel-2"
                  }`}
                >
                  {e}
                </button>
              ))}
            </div>
          </Field>
          <Field
            label="Характер (persona)"
            className="sm:col-span-2"
            hint="Этот текст попадает в system prompt персонажа. Пишите от второго лица («ты — …») или от третьего — модели понимают оба варианта."
          >
            <Textarea
              rows={10}
              value={form.persona}
              onChange={(e) => setForm({ ...form, persona: e.target.value })}
              placeholder={PERSONA_PLACEHOLDER}
            />
          </Field>
        </div>
      </Card>

      {form.isHuman ? (
        <Card className="mb-4 border-dashed p-4 text-sm text-muted">
          Модель не нужна: реплики и действия этого персонажа управляются вами вручную
          в комнате сцены. Инструменты ниже — то, что вы сможете вызывать руками.
        </Card>
      ) : (
      <Card className="mb-4 p-5">
        <div className="mb-4 text-sm font-medium">Модель</div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Провайдер">
            <Select
              value={form.providerId != null ? String(form.providerId) : ""}
              onChange={(v) =>
                setForm({
                  ...form,
                  providerId: v ? Number(v) : null,
                  model: "",
                })
              }
              options={[
                { value: "", label: "— выберите —" },
                ...providers.map((p) => ({ value: String(p.id), label: p.name })),
              ]}
            />
          </Field>
          <Field
            label="Модель"
            hint={
              modelsError ||
              (selectedProvider?.kind === "mock"
                ? "Для mock подойдёт любое имя"
                : "Выберите из списка или введите вручную")
            }
          >
            <div className="flex gap-2">
              <Combobox
                value={form.model}
                onChange={(model) => setForm({ ...form, model })}
                options={models}
                placeholder="qwen/qwen3-14b / meta-llama/llama-3.3-70b-instruct"
                className="min-w-0 flex-1"
                inputClassName="font-mono text-xs"
              />
              <IconBtn
                label="Обновить список моделей"
                loading={loadingModels}
                onClick={() => form.providerId && loadModels(form.providerId)}
              >
                {!loadingModels && <RefreshCw className="h-[18px] w-[18px]" />}
              </IconBtn>
            </div>
          </Field>
          <Field label={`Температура: ${form.temperature.toFixed(2)}`} hint="ниже — предсказуемее, выше — креативнее">
            <input
              type="range"
              min={0}
              max={2}
              step={0.05}
              value={form.temperature}
              onChange={(e) => setForm({ ...form, temperature: Number(e.target.value) })}
              className="w-full accent-[var(--color-accent)]"
            />
          </Field>
          <Field label="Макс. токенов ответа">
            <Input
              type="number"
              min={16}
              max={128000}
              value={form.maxTokens}
              onChange={(e) => setForm({ ...form, maxTokens: Number(e.target.value) })}
            />
          </Field>
        </div>

        <div className="mt-4 border-t border-line pt-4">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">Страховочная модель</span>
            <Badge color="warn">подхватывает ход, когда основная отказывается</Badge>
          </div>
          <p className="mb-3 text-xs leading-relaxed text-muted">
            Если основная модель отвечает отказом («я не могу…»), её генерация обрывается
            фильтром (пустой ответ, content_filter) или API блокирует запрос — этот же ход
            молча выполняет страховочная модель. Отказ в сцену не попадает: другие персонажи
            его не видят, а следующий ход снова делает основная модель. Ставьте сюда
            безотказную модель (Grok, локальный Qwen без цензуры в LM Studio…).
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Провайдер (страховка)">
              <Select
                value={form.fallbackProviderId != null ? String(form.fallbackProviderId) : ""}
                onChange={(v) =>
                  setForm({
                    ...form,
                    fallbackProviderId: v ? Number(v) : null,
                    fallbackModel: "",
                  })
                }
                options={[
                  { value: "", label: "— нет (отказы видны как мысли) —" },
                  ...providers.map((p) => ({ value: String(p.id), label: p.name })),
                ]}
              />
            </Field>
            <Field
              label="Модель (страховка)"
              hint={
                fbModelsError ||
                (selectedFallbackProvider?.kind === "mock"
                  ? "Для mock подойдёт любое имя"
                  : "Выберите из списка или введите вручную")
              }
            >
              <div className="flex gap-2">
                <Combobox
                  value={form.fallbackModel}
                  onChange={(m) => setForm({ ...form, fallbackModel: m })}
                  options={fbModels}
                  placeholder="xai/grok-4.2 / qwen2.5-72b-instruct"
                  className="min-w-0 flex-1"
                  inputClassName="font-mono text-xs"
                />
                <IconBtn
                  label="Обновить список моделей страховки"
                  loading={loadingFbModels}
                  onClick={() =>
                    form.fallbackProviderId && loadFbModels(form.fallbackProviderId)
                  }
                >
                  {!loadingFbModels && <RefreshCw className="h-[18px] w-[18px]" />}
                </IconBtn>
              </div>
            </Field>
          </div>
        </div>
      </Card>
      )}

      <Card className="mb-4 p-5">
        <div className="mb-3 flex items-center justify-between">
          <div className="text-sm font-medium">Инструменты персонажа</div>
          <div className="flex gap-2">
            <Btn
              variant="ghost"
              className="h-7 px-2 text-xs"
              onClick={() => setForm((f) => ({ ...f, toolIds: tools.map((t) => t.id) }))}
            >
              все
            </Btn>
            <Btn
              variant="ghost"
              className="h-7 px-2 text-xs"
              onClick={() => setForm((f) => ({ ...f, toolIds: [] }))}
            >
              убрать все
            </Btn>
          </div>
        </div>
        {tools.length === 0 ? (
          <p className="text-xs text-muted">Инструментов нет — создайте их в разделе «Инструменты».</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {tools.map((t) => {
              const on = form.toolIds.includes(t.id);
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => toggleTool(t.id)}
                  className={`rounded-lg border px-3 py-1.5 text-xs transition-colors ${
                    on
                      ? "border-accent/50 bg-accent/15 text-fg"
                      : "border-line bg-panel-2/50 text-muted hover:text-fg"
                  }`}
                  title={t.description}
                >
                  {t.title || t.name}
                </button>
              );
            })}
          </div>
        )}
      </Card>

      <Card className="mb-4 p-5">
        <div className="mb-1 flex flex-wrap items-center gap-2">
          <Shield className="h-4 w-4 text-warn" />
          <div className="text-sm font-medium">Границы (согласие)</div>
          <Badge color="warn">агент о них не знает — узнаёт, столкнувшись</Badge>
        </div>
        <p className="mb-3 text-xs leading-relaxed text-muted">
          Правила на адресные действия: условие не выполнено — отказ (действие не происходит,
          деньги целы), попытку и причину видит только инициатор. «Когда другие действуют на меня»
          — классическое согласие; «когда я действую на других» — личные принципы («не сплю с
          теми, у кого X ниже порога»). Последствия отказа бьют только по владельцу правила.
        </p>

        <div className="flex flex-col gap-3">
          {form.boundaries.map((b, bi) => {
            const setB = (patch: Partial<FormBoundary>) =>
              setForm((f) => ({
                ...f,
                boundaries: f.boundaries.map((x, i) => (i === bi ? { ...x, ...patch } : x)),
              }));
            const addressedTools = tools.filter((t) => t.audience === "target");
            return (
              <div key={bi} className="rounded-lg border border-line bg-panel-2/40 p-3">
                {/* 1/3. Когда срабатывает */}
                <div className="text-xs font-medium uppercase tracking-wide text-muted">
                  Когда срабатывает
                </div>
                <div className="mt-1.5 flex flex-wrap items-center gap-2">
                  <Select
                    value={b.scope}
                    onChange={(v) => setB({ scope: v as FormBoundary["scope"] })}
                    className="min-w-56 flex-1"
                    options={[
                      { value: "incoming", label: "когда действуют на меня" },
                      { value: "outgoing", label: "когда я действую на других" },
                      { value: "both", label: "в обе стороны" },
                    ]}
                  />
                  <Select
                    value={b.toolName}
                    onChange={(v) => setB({ toolName: v })}
                    className="min-w-40 flex-1"
                    options={[
                      { value: "*", label: "любое адресное действие" },
                      ...addressedTools.map((t) => ({ value: t.name, label: t.title || t.name })),
                    ]}
                  />
                  <IconBtn
                    variant="danger"
                    label="Удалить правило"
                    onClick={() =>
                      setForm((f) => ({ ...f, boundaries: f.boundaries.filter((_, i) => i !== bi) }))
                    }
                  >
                    <Trash2 className="h-4 w-4" />
                  </IconBtn>
                </div>
                <p className="mt-1 text-xs text-muted/80">
                  «*» — любой адресный инструмент. В условиях «кто действует» — инициатор вызова,
                  «на кого действуют» — получатель (для правила «на меня» это сам персонаж).
                </p>

                {/* 2/3. Условия («И») */}
                <div className="mt-3 border-t border-line pt-3">
                  <div className="text-xs font-medium uppercase tracking-wide text-muted">
                    Условия (все должны выполняться)
                  </div>
                  <div className="mt-1.5 flex flex-col gap-1.5">
                    {b.conditions.map((cond, ci) => (
                      <ConditionRow
                        key={ci}
                        cond={cond}
                        onChange={(next) =>
                          setB({ conditions: b.conditions.map((x, i) => (i === ci ? next : x)) })
                        }
                        onRemove={() =>
                          setB({ conditions: b.conditions.filter((_, i) => i !== ci) })
                        }
                        attributes={attributes}
                        places={places}
                        slots={clothingSlots}
                      />
                    ))}
                    {b.conditions.length === 0 && (
                      <p className="text-xs text-muted/70">
                        Добавьте хотя бы одно условие — иначе правило никогда не сработает.
                      </p>
                    )}
                  </div>
                  <Btn
                    variant="ghost"
                    className="mt-1.5 h-6 px-2 text-[11px]"
                    onClick={() =>
                      setB({
                        conditions: [...b.conditions, { kind: "relation", op: ">=", value: 3 }],
                      })
                    }
                  >
                    <Plus className="h-3 w-3" /> условие
                  </Btn>
                </div>

                {/* 3/3. Отказ */}
                <div className="mt-3 border-t border-line pt-3">
                  <div className="text-xs font-medium uppercase tracking-wide text-muted">
                    Отказ
                  </div>
                  <div className="mt-1.5">
                    <Field label="Текст отказа (от лица персонажа)">
                      <Input
                        value={b.refusalText}
                        onChange={(e) => setB({ refusalText: e.target.value })}
                        placeholder="мягко уклоняется: слишком рано"
                      />
                    </Field>
                  </div>

                  <div className="mt-2">
                    <div className="mb-1 flex items-center justify-between">
                      <span className="text-xs font-medium uppercase tracking-wide text-muted">
                        Последствия отказа
                      </span>
                      <Btn
                        variant="ghost"
                        className="h-6 px-2 text-[11px]"
                        onClick={() =>
                          setB({
                            effects: [
                              ...b.effects,
                              { target: "relation", key: "relation", op: "add", value: -1 },
                            ],
                          })
                        }
                      >
                        <Plus className="h-3 w-3" /> эффект
                      </Btn>
                    </div>
                    <div className="flex flex-col gap-1.5">
                      {b.effects.map((eff, ei) => {
                        const setEff = (patch: Partial<typeof eff>) =>
                          setB({
                            effects: b.effects.map((x, i) => (i === ei ? { ...x, ...patch } : x)),
                          });
                        return (
                          <div key={ei} className="flex items-center gap-2">
                            <Select
                              value={eff.target}
                              onChange={(v) =>
                                setEff({
                                  target: v as "relation" | "self",
                                  key: v === "relation" ? "relation" : attributes[0]?.key ?? "mood",
                                  op: "add",
                                })
                              }
                              className="min-w-40 flex-1"
                              options={[
                                { value: "relation", label: "отношение к актёру" },
                                { value: "self", label: "своё состояние" },
                              ]}
                            />
                            {eff.target === "self" && (
                              <div className="min-w-0 flex-1">
                                <Select
                                  value={eff.key}
                                  onChange={(v) => setEff({ key: v })}
                                  options={attributes.map((a) => ({
                                    value: a.key,
                                    label: `${a.emoji ? a.emoji + " " : ""}${a.label}`,
                                  }))}
                                />
                              </div>
                            )}
                            <Select
                              value={eff.op}
                              onChange={(v) => setEff({ op: v as "set" | "add" })}
                              className="w-16 shrink-0"
                              options={[
                                { value: "add", label: "+" },
                                { value: "set", label: "=" },
                              ]}
                            />
                            <Input
                              type="number"
                              value={typeof eff.value === "number" ? eff.value : Number(eff.value) || 0}
                              onChange={(e) => setEff({ value: Number(e.target.value) })}
                              className="w-20 shrink-0"
                            />
                            <IconBtn
                              variant="danger"
                              label="Удалить эффект"
                              onClick={() =>
                                setB({ effects: b.effects.filter((_, i) => i !== ei) })
                              }
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </IconBtn>
                          </div>
                        );
                      })}
                      {b.effects.length === 0 && (
                        <p className="text-xs text-muted/70">
                          Без последствий: отказ просто не пропускает действие.
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <Btn
          variant="ghost"
          className="mt-3"
          onClick={() =>
            setForm((f) => ({ ...f, boundaries: [...f.boundaries, defaultBoundary()] }))
          }
        >
          <Plus className="h-4 w-4" /> Правило
        </Btn>
      </Card>

      <Card className="mb-4 p-5">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div className="text-sm font-medium">Характеристики</div>
          <Badge>видно только этому персонажу</Badge>
          <span className="text-xs text-muted">
            меняются инструментами и товарами магазина
          </span>
        </div>

        {attributes.length === 0 && (
          <p className="mb-3 text-xs text-muted">
            Реестр характеристик пуст — задайте поля (рост, вес, красота…) в разделе «Характеристики».
          </p>
        )}

        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Доход за период, $" hint="начисляется на money при переходах сценария">
            <Input
              type="number"
              min={0}
              value={form.income}
              onChange={(e) => setForm({ ...form, income: Number(e.target.value) })}
              className="max-w-[7.5rem]"
            />
          </Field>
          {plainAttrs.map((a) => {
            const raw = stateObj ? stateObj[a.key] : undefined;
            const label = `${a.emoji ? a.emoji + " " : ""}${a.label}${a.unit ? `, ${a.unit}` : ""}`;
            if (a.type === "select") {
              const cur = typeof raw === "string" ? raw : "";
              return (
                <Field key={a.key} label={label}>
                  <Select
                    value={cur}
                    onChange={(v) => setAttrValue(a.key, v, a.type)}
                    options={[
                      { value: "", label: "— не задано —" },
                      ...a.options.map((o) => ({ value: o, label: o })),
                    ]}
                  />
                </Field>
              );
            }
            if (a.type === "text") {
              return (
                <Field key={a.key} label={label}>
                  <Input
                    value={typeof raw === "string" ? raw : raw == null ? "" : String(raw)}
                    onChange={(e) => setAttrValue(a.key, e.target.value, a.type)}
                  />
                </Field>
              );
            }
            return (
              <Field key={a.key} label={label}>
                <Input
                  type="number"
                  min={a.min ?? undefined}
                  max={a.max ?? undefined}
                  value={typeof raw === "number" ? raw : raw == null ? "" : String(raw)}
                  onChange={(e) => setAttrValue(a.key, e.target.value, a.type)}
                  className="max-w-[7.5rem]"
                />
              </Field>
            );
          })}
        </div>

        {skillAttrs.length > 0 && (
          <div className="mt-4 border-t border-line pt-3">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium uppercase tracking-wide text-muted">
                Навыки
              </span>
              <Badge>уровень видит только владелец — другие узнают по факту</Badge>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              {skillAttrs.map((a) => {
                const raw = stateObj ? stateObj[a.key] : undefined;
                return (
                  <Field
                    key={a.key}
                    label={`${a.emoji ? a.emoji + " " : ""}${a.label}`}
                    hint={`уровень 0…${a.max ?? "∞"}, растёт практикой`}
                  >
                    <Input
                      type="number"
                      min={a.min ?? 0}
                      max={a.max ?? undefined}
                      value={typeof raw === "number" ? raw : raw == null ? "" : String(raw)}
                      onChange={(e) => setAttrValue(a.key, e.target.value, "number")}
                      className="max-w-[7.5rem]"
                    />
                  </Field>
                );
              })}
            </div>
          </div>
        )}

        {!isNew && others.length > 0 && (
          <div className="mt-4 border-t border-line pt-3">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium uppercase tracking-wide text-muted">
                Химия с другими
              </span>
              <Badge>−3…+3 — скрытый множитель пары, никто из агентов её не видит</Badge>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              {others.map((o) => {
                const pair = chem.find(
                  (c) =>
                    (c.aId === o.id && c.bId === numericId) || (c.aId === numericId && c.bId === o.id)
                );
                const v = pair?.value ?? 0;
                return (
                  <Field
                    key={o.id}
                    label={`${o.emoji} ${o.name}`}
                    hint="+ усиливает эффекты отношений, − гасит; растёт от удачных исходов"
                  >
                    <Input
                      type="number"
                      min={-3}
                      max={3}
                      value={v}
                      onChange={(e) => {
                        const next = Math.max(-3, Math.min(3, Number(e.target.value)));
                        setChem((cs) => {
                          const exists = cs.some(
                            (c) =>
                              (c.aId === o.id && c.bId === numericId) ||
                              (c.aId === numericId && c.bId === o.id)
                          );
                          return exists
                            ? cs.map((c) =>
                                (c.aId === o.id && c.bId === numericId) ||
                                (c.aId === numericId && c.bId === o.id)
                                  ? { ...c, value: next }
                                  : c
                              )
                            : [...cs, { aId: numericId, bId: o.id, value: next }];
                        });
                        void apiPatch("/api/chemistry", {
                          aId: numericId,
                          bId: o.id,
                          value: next,
                        }).catch(() => {});
                      }}
                      className="max-w-[7.5rem]"
                    />
                  </Field>
                );
              })}
            </div>
          </div>
        )}

        {(extraKeys.length > 0 || hasWardrobeKeys) && (
          <div className="mt-4 border-t border-line pt-3">
            <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">
              Другие поля state (нет в реестре)
            </div>
            {hasWardrobeKeys && (
              <p className="mb-3 text-xs text-muted">
                worn_*/carried_* управляются гардеробом — смотрите карточку «Гардероб» ниже.
              </p>
            )}
            {extraKeys.length > 0 && (
              <div className="grid gap-3 sm:grid-cols-3">
                {extraKeys.map((k) => (
                  <Field key={k} label={k}>
                    <Input
                      value={String(stateObj?.[k] ?? "")}
                      onChange={(e) => setAttrValue(k, e.target.value, "text")}
                    />
                  </Field>
                ))}
              </div>
            )}
          </div>
        )}

        <details className="mt-4">
          <summary className="cursor-pointer text-xs text-muted hover:text-fg">
            продвинутый: весь state в JSON (null — удалить ключ; сохранение мёржит по ключам)
          </summary>
          <div className="mt-2">
            <Textarea
              rows={6}
              value={form.stateText}
              onChange={(e) => setForm({ ...form, stateText: e.target.value })}
              className="font-mono text-xs"
              spellCheck={false}
            />
            {stateObj === null && (
              <p className="mt-1 text-xs text-err">
                JSON невалиден — поля характеристик выше отключены, пока не исправите.
              </p>
            )}
          </div>
        </details>
      </Card>

      {!isNew && (
        <Card className="p-5">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <Shirt className="h-4 w-4 text-accent" />
            <div className="text-sm font-medium">Гардероб</div>
            <Badge>эффекты предмета действуют, пока он надет</Badge>
          </div>
          <p className="mb-3 text-xs text-muted">
            Личный шкаф персонажа. Каталог и цены — в разделе „Гардероб“ (/wardrobe).
          </p>

          <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">
            Надето
          </div>
          {wardrobe.slots.length === 0 ? (
            <p className="text-xs text-muted">
              Слоты одежды не заданы — создайте их в разделе «Характеристики».
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {wardrobe.slots.map((s) => {
                const slotOwned = wardrobe.owned.filter((g) => g.slot === s.slot);
                // Чем снимать: надетый предмет; если его нет в гардеробе — любой из слота.
                const removeId = s.garmentId ?? slotOwned[0]?.id ?? null;
                const currentValue =
                  s.garmentId != null ? String(s.garmentId) : s.worn ? "__worn__" : "";
                return (
                  <div
                    key={s.slot}
                    className="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-panel-2/40 px-3 py-2"
                  >
                    <div className="w-36 shrink-0">
                      <div className="font-mono text-xs text-fg">{s.slot}</div>
                      <div className="text-xs text-muted">{s.worn ?? "— пусто —"}</div>
                    </div>
                    <Select
                      value={currentValue}
                      onChange={(v) => {
                        if (v === currentValue || v === "" || v === "__worn__") return;
                        if (v === "__remove__") {
                          if (removeId != null) void applyWardrobe(removeId, "remove");
                          return;
                        }
                        void applyWardrobe(Number(v), "wear");
                      }}
                      options={[
                        s.worn
                          ? removeId != null
                            ? { value: "__remove__", label: "— снять —" }
                            : { value: "__worn__", label: `надето: ${s.worn}` }
                          : { value: "", label: "— надеть —" },
                        ...slotOwned.map((g) => ({
                          value: String(g.id),
                          label: `${g.emoji} ${g.name}`,
                        })),
                      ]}
                      className="min-w-44 flex-1"
                      disabled={wardrobeBusy}
                    />
                  </div>
                );
              })}
            </div>
          )}

          <div className="mt-4 border-t border-line pt-3">
            <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">
              В шкафу
            </div>
            {closetGarments.length === 0 ? (
              <p className="text-xs text-muted">
                Пусто — выданные, но не надетые вещи появятся здесь.
              </p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {closetGarments.map((g) => (
                  <button
                    key={g.id}
                    type="button"
                    disabled={wardrobeBusy}
                    onClick={() => void applyWardrobe(g.id, "wear")}
                    className="flex items-center gap-1.5 rounded-lg border border-line bg-panel-2/50 px-3 py-1.5 text-xs text-fg transition-colors hover:border-accent/50 disabled:opacity-50"
                    title={g.slot ? `Надеть в слот ${g.slot}` : "Надеть"}
                  >
                    <span className="text-base leading-none">{g.emoji}</span>
                    <span>{g.name}</span>
                    {g.slot && (
                      <span className="rounded bg-black/30 px-1.5 py-0.5 font-mono text-[10px] text-muted">
                        {g.slot}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        </Card>
      )}
    </div>
  );
}
