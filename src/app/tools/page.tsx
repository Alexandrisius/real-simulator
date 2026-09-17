"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Eye, Plus, Sparkles, Trash2, Wrench } from "lucide-react";
import {
  Badge,
  Btn,
  Card,
  EmptyState,
  ErrorText,
  Field,
  IconBtn,
  Input,
  PageHeader,
  Select,
  Textarea,
  Toggle,
} from "@/components/ui";
import { api, apiDelete, apiPatch, apiPost } from "@/components/api";
import type {
  AttributeDef,
  Character,
  ClothingSlot,
  Combo,
  OutcomeCondition,
  Place,
  Skill,
  Tool,
  ToolAudience,
  ToolEffect,
  ToolOutcome,
} from "@/lib/types";

const AUDIENCE_LABEL: Record<ToolAudience, string> = {
  all: "видно всем",
  target: "видно получателю",
  self: "видно только себе",
  none: "скрытое действие",
};

/**
 * Сущности мира для параметра: движок запишет x-entity в схему и подставит
 * живой enum — модель выбирает из существующих значений, а не угадывает.
 */
const ENTITY_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "— нет" },
  { value: "character", label: "персонажи сцены" },
  { value: "place", label: "места" },
  { value: "product", label: "товары и одежда" },
  { value: "slot", label: "слоты одежды" },
  { value: "attribute", label: "характеристики" },
];
const ENTITY_VALUES = ENTITY_OPTIONS.map((o) => o.value).filter(Boolean);

/** Типы параметров схемы человеческим языком */
const TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: "string", label: "текст" },
  { value: "number", label: "число" },
  { value: "boolean", label: "да / нет" },
];

/**
 * Одна строка конструктора параметров. В форме живём только строками;
 * JSON-схема собирается из них при сохранении (rowsToSchema) и разбирается
 * обратно при редактировании/шаблонах (schemaToRows).
 */
interface ArgRow {
  name: string;
  type: "string" | "number" | "boolean";
  description: string;
  required: boolean;
  /** "" | character | place | product | slot | attribute (x-entity) */
  entity: string;
}

const emptyArg = (): ArgRow => ({
  name: "",
  type: "string",
  description: "",
  required: false,
  entity: "",
});

/** JSON-схема → строки конструктора; неизвестные типы/сущности мягко приводим */
function schemaToRows(schema: Record<string, unknown> | null | undefined): ArgRow[] {
  if (!schema) return [];
  const props = schema.properties;
  if (!props || typeof props !== "object" || Array.isArray(props)) return [];
  const required = new Set(
    Array.isArray(schema.required)
      ? (schema.required as unknown[]).filter((x): x is string => typeof x === "string")
      : []
  );
  return Object.entries(props as Record<string, unknown>).map(([name, raw]) => {
    const p =
      raw && typeof raw === "object" && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : {};
    const type = p.type === "number" || p.type === "boolean" ? p.type : "string";
    const entity = ENTITY_VALUES.includes(p["x-entity"] as string)
      ? (p["x-entity"] as string)
      : "";
    return {
      name,
      type,
      description: typeof p.description === "string" ? p.description : "",
      required: required.has(name),
      entity,
    };
  });
}

/** Строки конструктора → JSON-схема для движка (то, что уйдёт модели) */
function rowsToSchema(rows: ArgRow[]): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const a of rows) {
    if (!a.name) continue; // безымянные черновики в схему не попадают
    properties[a.name] = {
      type: a.type,
      description: a.description,
      ...(a.entity ? { "x-entity": a.entity } : {}),
    };
    if (a.required) required.push(a.name);
  }
  return { type: "object", properties, required };
}

/** Имя параметра: латиница в нижнем регистре, цифры и _ (требование function calling) */
const sanitizeArgName = (v: string) => v.toLowerCase().replace(/[^a-z0-9_]/g, "");

const TEMPLATES: Record<string, () => Partial<Tool>> = {
  message: () => ({
    name: "",
    title: "Написать сообщение",
    description: "Отправить личное сообщение персонажу. Видит только получатель.",
    audience: "target",
    targetParam: "to",
    observationTemplate: "{name} пишет тебе: {text}",
    parametersSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Имя получателя" },
        text: { type: "string", description: "Текст сообщения" },
      },
      required: ["to", "text"],
    },
  }),
  activity: () => ({
    name: "",
    title: "Заняться делом",
    description: "Публичное действие, которое видят все участники сцены.",
    audience: "all",
    targetParam: null,
    observationTemplate: "{name}: {activity}",
    parametersSchema: {
      type: "object",
      properties: { activity: { type: "string", description: "Что делаешь" } },
      required: ["activity"],
    },
  }),
  photo: () => ({
    name: "",
    title: "Отправить фото",
    description: "Отправить фото (описание словами). Видит только получатель.",
    audience: "target",
    targetParam: "to",
    observationTemplate: "{name} отправил(а) тебе фото: {description}",
    parametersSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Имя получателя" },
        description: { type: "string", description: "Что на фото" },
      },
      required: ["to", "description"],
    },
  }),
};

interface FormState {
  name: string;
  title: string;
  description: string;
  /** Параметры как строки конструктора (JSON-схема собирается при сохранении) */
  args: ArgRow[];
  audience: ToolAudience;
  targetParam: string;
  observationTemplate: string;
  effects: ToolEffect[];
  cost: number;
  trainsSkill: string;
  outcomes: ToolOutcome[];
  requiresConsent: boolean;
  declineEffects: ToolEffect[];
}

const emptyForm: FormState = {
  name: "",
  title: "",
  description: "",
  args: [],
  audience: "all",
  targetParam: "",
  observationTemplate: "{name} использует {tool}",
  effects: [],
  cost: 0,
  trainsSkill: "",
  outcomes: [],
  requiresConsent: false,
  declineEffects: [],
};

function toolToForm(t: Tool): FormState {
  return {
    name: t.name,
    title: t.title,
    description: t.description,
    args: schemaToRows(t.parametersSchema),
    audience: t.audience,
    targetParam: t.targetParam ?? "",
    observationTemplate: t.observationTemplate,
    effects: t.effects,
    cost: t.cost ?? 0,
    trainsSkill: t.trainsSkill ?? "",
    outcomes: t.outcomes ?? [],
    requiresConsent: t.requiresConsent ?? false,
    declineEffects: t.declineEffects ?? [],
  };
}

/** Подзаголовок блока формы — как на других страницах приложения */
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-6 border-t border-line pt-4">
      <div className="mb-3 text-xs font-medium uppercase tracking-wide text-muted">
        {title}
      </div>
      {children}
    </section>
  );
}

// ---- Комбо: форма (шаг = инструмент + необязательные «кто» / «на ком») ----

interface ComboStepForm {
  toolName: string;
  actorName: string;
  targetName: string;
}

interface ComboFormState {
  name: string;
  title: string;
  description: string;
  steps: ComboStepForm[];
  windowTurns: number;
  effects: ToolEffect[];
  knowers: number[];
  announce: boolean;
}

const emptyComboStep = (): ComboStepForm => ({ toolName: "", actorName: "", targetName: "" });

const emptyComboForm: ComboFormState = {
  name: "",
  title: "",
  description: "",
  steps: [emptyComboStep(), emptyComboStep()],
  windowTurns: 10,
  effects: [],
  knowers: [],
  announce: true,
};

function comboToForm(c: Combo): ComboFormState {
  return {
    name: c.name,
    title: c.title,
    description: c.description,
    steps: c.steps.map((s) => ({
      toolName: s.toolName,
      actorName: s.actorName ?? "",
      targetName: s.targetName ?? "",
    })),
    windowTurns: c.windowTurns,
    effects: c.effects.map((e) => ({ ...e })),
    knowers: [...c.knowers],
    announce: c.announce,
  };
}

export default function ToolsPage() {
  const [tools, setTools] = useState<Tool[]>([]);
  const [attributes, setAttributes] = useState<AttributeDef[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [slots, setSlots] = useState<ClothingSlot[]>([]);
  const [places, setPlaces] = useState<Place[]>([]);
  const [combos, setCombos] = useState<Combo[]>([]);
  const [characters, setCharacters] = useState<Character[]>([]);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // Экспертный лаз: raw JSON схемы, двусторонне синхронизирован со строками
  const [expertOpen, setExpertOpen] = useState(false);
  const [expertText, setExpertText] = useState("");
  const [expertInvalid, setExpertInvalid] = useState(false);
  // Трогал ли пользователь селект «Параметр с получателем» (для автоподсказки)
  const targetTouched = useRef(false);

  const [comboForm, setComboForm] = useState<ComboFormState>(emptyComboForm);
  const [comboEditing, setComboEditing] = useState<number | null>(null);
  const [comboOpen, setComboOpen] = useState(false);
  const [comboSaving, setComboSaving] = useState(false);

  // Рефы карточек форм: «Изменить» открывает форму наверху страницы —
  // прокручиваем к ней, чтобы не искать глазами.
  const formRef = useRef<HTMLDivElement>(null);
  const comboFormRef = useRef<HTMLDivElement>(null);

  const load = useCallback(() => {
    api<Tool[]>("/api/tools").then(setTools).catch((e) => setError(e.message));
    api<AttributeDef[]>("/api/attributes").then(setAttributes).catch(() => {});
    api<Skill[]>("/api/skills").then(setSkills).catch(() => {});
    api<ClothingSlot[]>("/api/clothing-slots").then(setSlots).catch(() => {});
    api<Place[]>("/api/places").then(setPlaces).catch(() => {});
    api<Combo[]>("/api/combos").then(setCombos).catch(() => setCombos([]));
    api<Character[]>("/api/characters").then(setCharacters).catch(() => {});
  }, []);
  useEffect(load, [load]);

  const skillById = new Map(skills.map((s) => [s.key, s]));
  const charById = new Map(characters.map((c) => [c.id, c]));

  const attrKeyOptions = attributes.map((a) => ({
    value: a.key,
    label: `${a.emoji ? a.emoji + " " : ""}${a.label} (${a.key})`,
  }));
  const keyOptions = (cur: string) =>
    attrKeyOptions.some((o) => o.value === cur)
      ? attrKeyOptions
      : [{ value: cur, label: `${cur} (нет в реестре)` }, ...attrKeyOptions];

  // ---- Конструктор параметров ----

  const setArg = (i: number, patch: Partial<ArgRow>) =>
    setForm((f) => ({ ...f, args: f.args.map((a, j) => (i === j ? { ...a, ...patch } : a)) }));

  /** Дубликаты имён параметров: в схему молча войдёт только один — подсвечиваем */
  const duplicateArgNames = useMemo(() => {
    const seen = new Set<string>();
    const dups = new Set<string>();
    for (const a of form.args) {
      if (!a.name) continue;
      if (seen.has(a.name)) dups.add(a.name);
      seen.add(a.name);
    }
    return dups;
  }, [form.args]);

  const argNames = form.args.map((a) => a.name).filter(Boolean);

  // Получатель: сбрасываем, если такой параметр удалён; автоподсказка —
  // ровно один параметр-персонаж и пользователь ещё не трогал селект.
  useEffect(() => {
    setForm((f) => {
      const names = f.args.map((a) => a.name);
      if (f.targetParam && !names.includes(f.targetParam)) return { ...f, targetParam: "" };
      const charArgs = f.args.filter((a) => a.entity === "character" && a.name);
      if (!targetTouched.current && !f.targetParam && charArgs.length === 1) {
        return { ...f, targetParam: charArgs[0].name };
      }
      return f;
    });
  }, [form.args]);

  /** Открыли блок эксперта — показываем текущий JSON, собранный из строк */
  const toggleExpert = (next: boolean) => {
    setExpertOpen(next);
    if (next) {
      setExpertText(JSON.stringify(rowsToSchema(form.args), null, 2));
      setExpertInvalid(false);
    }
  };

  /** Правка JSON экспертом: применяем к строкам, только если распарсилось */
  const applyExpertText = () => {
    try {
      const parsed: unknown = JSON.parse(expertText || "{}");
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        setExpertInvalid(true);
        return;
      }
      setForm((f) => ({ ...f, args: schemaToRows(parsed as Record<string, unknown>) }));
      setExpertText(JSON.stringify(parsed, null, 2));
      setExpertInvalid(false);
    } catch {
      setExpertInvalid(true); // строки не трогаем — правки остаются только в текстовом поле
    }
  };

  // ---- Наблюдение: живой предпросмотр и подстановки ----

  /** Подставляем образцы вместо {плейсхолдеров}: как renderTemplate в движке */
  const observationPreview = useMemo(() => {
    const tpl = form.observationTemplate;
    if (!tpl) return "";
    let firstStringDone = false;
    const byName = new Map(form.args.map((a) => [a.name, a]));
    return tpl.replace(/\{([A-Za-z0-9_]+)\}/g, (whole, key: string) => {
      if (key === "name") return "Дима";
      if (key === "tool") return form.title || form.name || "инструмент";
      const arg = byName.get(key);
      if (!arg) return whole; // неизвестная подстановка — видна как есть
      if (arg.type === "number") return "3";
      if (arg.type === "boolean") return "да";
      if (!firstStringDone) {
        firstStringDone = true;
        return "Яна";
      }
      return "…";
    });
  }, [form.observationTemplate, form.title, form.name, form.args]);

  /** Клик по чипу — дописываем подстановку в конец текста */
  const appendTemplateToken = (token: string) =>
    setForm((f) => ({ ...f, observationTemplate: f.observationTemplate + token }));

  const chipCls =
    "rounded-md border border-line bg-panel-2/50 px-2 py-1 font-mono text-[11px] text-muted transition-colors hover:border-accent/50 hover:text-fg";

  const startCreate = (tpl?: keyof typeof TEMPLATES) => {
    const base = tpl ? TEMPLATES[tpl]() : {};
    setForm({
      ...emptyForm,
      name: base.name ?? "",
      title: base.title ?? "",
      description: base.description ?? "",
      args: schemaToRows(base.parametersSchema),
      audience: base.audience ?? "all",
      targetParam: base.targetParam ?? "",
      observationTemplate: base.observationTemplate ?? emptyForm.observationTemplate,
    });
    targetTouched.current = false;
    setExpertOpen(false);
    setExpertInvalid(false);
    setEditingId(null);
    setOpen(true);
  };

  const startEdit = (t: Tool) => {
    setForm(toolToForm(t));
    targetTouched.current = false;
    setExpertOpen(false);
    setExpertInvalid(false);
    setEditingId(t.id);
    setOpen(true);
    requestAnimationFrame(() =>
      formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })
    );
  };

  const save = async () => {
    setError("");
    if (form.audience === "target" && !form.targetParam.trim()) {
      setError("Укажите параметр с именем получателя (например «to»)");
      return;
    }
    setSaving(true);
    const body = {
      name: form.name,
      title: form.title,
      description: form.description,
      // Схема всегда собирается из строк конструктора
      parametersSchema: rowsToSchema(form.args),
      audience: form.audience,
      targetParam: form.audience === "target" ? form.targetParam.trim() : null,
      observationTemplate: form.observationTemplate,
      effects: form.effects,
      cost: form.cost,
      trainsSkill: form.trainsSkill,
      outcomes: form.outcomes,
      requiresConsent: form.requiresConsent,
      declineEffects: form.declineEffects,
    };
    try {
      if (editingId) await apiPatch(`/api/tools/${editingId}`, body);
      else await apiPost("/api/tools", body);
      setOpen(false);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (t: Tool) => {
    if (!confirm(`Удалить инструмент «${t.title || t.name}»?`)) return;
    setError("");
    try {
      await apiDelete(`/api/tools/${t.id}`);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const setEffect = (i: number, patch: Partial<ToolEffect>) => {
    setForm((f) => ({
      ...f,
      effects: f.effects.map((e, j) => (i === j ? { ...e, ...patch } : e)),
    }));
  };
  const setOutcome = (i: number, patch: Partial<ToolOutcome>) => {
    setForm((f) => ({
      ...f,
      outcomes: f.outcomes.map((o, j) => (i === j ? { ...o, ...patch } : o)),
    }));
  };
  const setOutcomeCond = (oi: number, ci: number, patch: Partial<OutcomeCondition>) => {
    setForm((f) => ({
      ...f,
      outcomes: f.outcomes.map((o, j) =>
        j === oi ? { ...o, conditions: o.conditions.map((c, k) => (k === ci ? { ...c, ...patch } : c)) } : o
      ),
    }));
  };
  const setOutcomeEffect = (oi: number, ei: number, patch: Partial<ToolEffect>) => {
    setForm((f) => ({
      ...f,
      outcomes: f.outcomes.map((o, j) =>
        j === oi ? { ...o, effects: o.effects.map((e, k) => (k === ei ? { ...e, ...patch } : e)) } : o
      ),
    }));
  };

  // ---- Эффекты отказа (declineEffects): отказывающийся и его чувства ----
  const setDeclineEffect = (i: number, patch: Partial<ToolEffect>) => {
    setForm((f) => ({
      ...f,
      declineEffects: f.declineEffects.map((e, j) => (i === j ? { ...e, ...patch } : e)),
    }));
  };

  // ---- Комбо ----
  const startComboCreate = () => {
    setComboForm(emptyComboForm);
    setComboEditing(null);
    setComboOpen(true);
    requestAnimationFrame(() =>
      comboFormRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })
    );
  };

  const startComboEdit = (c: Combo) => {
    setComboForm(comboToForm(c));
    setComboEditing(c.id);
    setComboOpen(true);
    requestAnimationFrame(() =>
      comboFormRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })
    );
  };

  const saveCombo = async () => {
    setError("");
    if (!comboForm.name.trim() || !comboForm.title.trim()) {
      setError("Имя и заголовок комбо обязательны");
      return;
    }
    if (comboForm.steps.length < 2 || comboForm.steps.some((s) => !s.toolName)) {
      setError("Комбо — минимум два шага, в каждом шаге выбран инструмент");
      return;
    }
    setComboSaving(true);
    const body = {
      name: comboForm.name.trim(),
      title: comboForm.title.trim(),
      description: comboForm.description,
      steps: comboForm.steps.map((s) => ({
        toolName: s.toolName,
        actorName: s.actorName || null,
        targetName: s.targetName || null,
      })),
      windowTurns: comboForm.windowTurns,
      effects: comboForm.effects,
      knowers: comboForm.knowers,
      announce: comboForm.announce,
    };
    try {
      if (comboEditing) await apiPatch(`/api/combos/${comboEditing}`, body);
      else await apiPost("/api/combos", body);
      setComboOpen(false);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setComboSaving(false);
    }
  };

  const removeCombo = async (c: Combo) => {
    if (!confirm(`Удалить комбо «${c.title}»?`)) return;
    setError("");
    try {
      await apiDelete(`/api/combos/${c.id}`);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const setComboStep = (i: number, patch: Partial<ComboStepForm>) =>
    setComboForm((f) => ({
      ...f,
      steps: f.steps.map((s, j) => (i === j ? { ...s, ...patch } : s)),
    }));

  const toggleKnower = (id: number) =>
    setComboForm((f) => ({
      ...f,
      knowers: f.knowers.includes(id)
        ? f.knowers.filter((x) => x !== id)
        : [...f.knowers, id],
    }));

  const setComboEffect = (i: number, patch: Partial<ToolEffect>) => {
    setComboForm((f) => ({
      ...f,
      effects: f.effects.map((e, j) => (i === j ? { ...e, ...patch } : e)),
    }));
  };

  const comboToolOptions = [
    { value: "", label: "— инструмент —" },
    ...tools.map((t) => ({ value: t.name, label: t.title || t.name })),
  ];
  const comboWhoOptions = [
    { value: "", label: "— любой —" },
    ...characters.map((c) => ({ value: c.name, label: `${c.emoji} ${c.name}` })),
  ];

  return (
    <div className="mx-auto max-w-5xl px-8 py-10">
      <PageHeader
        title="Инструменты"
        subtitle="Действия, доступные персонажам через native function calling. Каждый инструмент — настраиваемая функция с параметрами, видимостью и эффектами."
        actions={
          <Btn variant="primary" onClick={() => startCreate()}>
            <Plus className="h-4 w-4" /> Создать
          </Btn>
        }
      />
      <ErrorText>{error}</ErrorText>

      {open && (
        <div ref={formRef}>
        <Card className="mb-6 p-5">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <div className="text-sm font-medium">
              {editingId ? `Редактирование: ${form.name}` : "Новый инструмент"}
            </div>
            {!editingId && (
              <div className="flex items-center gap-2 text-xs text-muted">
                Шаблон:
                <Btn variant="ghost" className="h-7 px-2 text-xs" onClick={() => startCreate("message")}>
                  сообщение
                </Btn>
                <Btn variant="ghost" className="h-7 px-2 text-xs" onClick={() => startCreate("activity")}>
                  действие
                </Btn>
                <Btn variant="ghost" className="h-7 px-2 text-xs" onClick={() => startCreate("photo")}>
                  фото
                </Btn>
              </div>
            )}
          </div>

          {/* ОСНОВНОЕ */}
          <Section title="Основное">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Имя функции" hint="латиница a-z, 0-9, _ — так модель вызывает инструмент">
                <Input
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="send_message"
                  className="font-mono"
                />
              </Field>
              <Field label="Ярлык в UI">
                <Input
                  value={form.title}
                  onChange={(e) => setForm({ ...form, title: e.target.value })}
                  placeholder="Написать сообщение"
                />
              </Field>
              <Field label="Описание для модели" className="sm:col-span-2" hint="Когда и зачем персонажу вызывать этот инструмент — от описания зависит поведение модели">
                <Textarea
                  rows={2}
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  placeholder="Отправить личное сообщение. Видит только получатель."
                />
              </Field>
              <Field label="Кому видно действие">
                <Select
                  value={form.audience}
                  onChange={(v) => setForm({ ...form, audience: v as ToolAudience })}
                  options={[
                    { value: "all", label: "Видно всем участникам" },
                    { value: "target", label: "Видно получателю" },
                    { value: "self", label: "Видно только актёру" },
                    { value: "none", label: "Скрытое действие" },
                  ]}
                />
              </Field>
              {form.audience === "target" && (
                <Field label="Параметр с получателем" hint="в каком параметре приходит имя персонажа-получателя">
                  {argNames.length > 0 ? (
                    <Select
                      value={form.targetParam}
                      onChange={(v) => {
                        targetTouched.current = true;
                        setForm({ ...form, targetParam: v });
                      }}
                      options={[
                        { value: "", label: "— нет —" },
                        ...argNames.map((p) => ({ value: p, label: p })),
                      ]}
                    />
                  ) : (
                    <p className="pt-2 text-xs leading-relaxed text-muted/70">
                      Сначала добавьте в разделе «Параметры» параметр с именем получателя.
                    </p>
                  )}
                </Field>
              )}
            </div>
          </Section>

          {/* ПАРАМЕТРЫ */}
          <Section title="Параметры">
            <p className="mb-3 text-xs leading-relaxed text-muted/70">
              Параметры — то, что персонаж указывает при вызове действия: кому, что, сколько.
              Модель видит имя, тип и описание каждого параметра.
            </p>
            <div className="mb-2 flex items-center justify-end">
              <Btn
                variant="ghost"
                className="h-7 px-2 text-xs"
                onClick={() => setForm((f) => ({ ...f, args: [...f.args, emptyArg()] }))}
              >
                <Plus className="h-3 w-3" /> параметр
              </Btn>
            </div>
            {form.args.length === 0 && (
              <p className="text-xs leading-relaxed text-muted/70">
                Параметров нет — действие вызывается без аргументов. Нажмите «параметр», чтобы добавить.
              </p>
            )}
            {form.args.map((a, i) => (
              <div key={i} className="mb-2 rounded-xl border border-line bg-panel-2/30 p-3">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-xs font-medium text-muted">Параметр #{i + 1}</span>
                  <IconBtn
                    variant="danger"
                    size="sm"
                    label="Удалить параметр"
                    onClick={() =>
                      setForm((f) => ({ ...f, args: f.args.filter((_, j) => j !== i) }))
                    }
                  >
                    <Trash2 className="h-4 w-4" />
                  </IconBtn>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Имя">
                    <Input
                      value={a.name}
                      onChange={(e) => setArg(i, { name: sanitizeArgName(e.target.value) })}
                      placeholder="who"
                      className="font-mono"
                    />
                    {a.name && duplicateArgNames.has(a.name) && (
                      <span className="mt-1 block text-xs text-err">
                        Имя занято — параметров с таким именем несколько
                      </span>
                    )}
                  </Field>
                  <Field label="Тип">
                    <Select
                      value={a.type}
                      onChange={(v) => setArg(i, { type: v as ArgRow["type"] })}
                      options={TYPE_OPTIONS}
                    />
                  </Field>
                  <Field label="Описание" className="sm:col-span-2">
                    <Input
                      value={a.description}
                      onChange={(e) => setArg(i, { description: e.target.value })}
                      placeholder="что сюда подставить — видит модель"
                    />
                  </Field>
                  <Field
                    label="Ссылка на сущность"
                    hint="модель выберет из существующих значений, а не будет угадывать"
                  >
                    <Select
                      value={a.entity}
                      onChange={(v) => setArg(i, { entity: v })}
                      options={ENTITY_OPTIONS}
                    />
                  </Field>
                  <Field label="Обязательный">
                    <div className="flex h-[38px] items-center gap-2">
                      <Toggle
                        checked={a.required}
                        onChange={(v) => setArg(i, { required: v })}
                        label="Параметр обязателен"
                      />
                      <span className="text-xs text-muted">
                        {a.required ? "модель обязана его указать" : "по желанию"}
                      </span>
                    </div>
                  </Field>
                </div>
              </div>
            ))}

            {/* Экспертный лаз: raw JSON, двусторонняя синхронизация со строками */}
            <details
              className="mt-3 rounded-xl border border-line bg-panel-2/30 p-3"
              open={expertOpen}
              onToggle={(e) => toggleExpert((e.target as HTMLDetailsElement).open)}
            >
              <summary className="cursor-pointer select-none text-xs font-medium uppercase tracking-wide text-muted">
                Эксперт: JSON-схема
              </summary>
              <p className="mt-2 text-xs leading-relaxed text-muted/70">
                Конструктора выше достаточно. Здесь — точная схема, которая уйдёт модели;
                правка применится к параметрам, когда поле потеряет фокус.
              </p>
              <Textarea
                rows={7}
                value={expertText}
                onChange={(e) => setExpertText(e.target.value)}
                onBlur={applyExpertText}
                className="mt-2 font-mono text-xs"
                spellCheck={false}
              />
              {expertInvalid && (
                <p className="mt-1.5 text-xs text-err">
                  JSON невалиден — правки не применены, параметры остались как были.
                </p>
              )}
            </details>
          </Section>

          {/* НАБЛЮДЕНИЕ */}
          <Section title="Наблюдение">
            <Field
              label="Наблюдение для остальных"
              hint="Текст, который другие участники увидят вместо «сухого» вызова инструмента."
            >
              <Input
                value={form.observationTemplate}
                onChange={(e) => setForm({ ...form, observationTemplate: e.target.value })}
                placeholder="Например: {name} обнимает {who}"
              />
            </Field>
            {observationPreview && (
              <p className="mt-2 text-xs leading-relaxed text-muted">
                Увидят остальные: <span className="text-fg">«{observationPreview}»</span>
              </p>
            )}
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-muted/70">добавить:</span>
              <button
                type="button"
                className={chipCls}
                title="имя актёра"
                onClick={() => appendTemplateToken("{name}")}
              >
                {"{имя}"}
              </button>
              <button
                type="button"
                className={chipCls}
                title="ярлык инструмента"
                onClick={() => appendTemplateToken("{tool}")}
              >
                {"{тул}"}
              </button>
              {form.args.map((a, ai) =>
                a.name ? (
                  <button
                    key={ai}
                    type="button"
                    className={chipCls}
                    title="значение аргумента"
                    onClick={() => appendTemplateToken(`{${a.name}}`)}
                  >
                    {`{${a.name}}`}
                  </button>
                ) : null
              )}
            </div>
            <p className="mt-1.5 text-xs leading-relaxed text-muted/70">
              Подстановки: {"{name}"} — имя актёра, {"{tool}"} — ярлык, {"{параметр}"} — значение
              аргумента. Клик по кнопке дописывает её в конец текста.
            </p>
          </Section>

          {/* ЭФФЕКТЫ И ЦЕНА */}
          <Section title="Эффекты и цена">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label="Цена, $ (0 = бесплатно)"
                hint="списывается с ключа money в состоянии актёра; при нехватке денег действие не выполняется"
              >
                <Input
                  type="number"
                  min={0}
                  value={form.cost}
                  onChange={(e) => setForm({ ...form, cost: Number(e.target.value) })}
                />
              </Field>
              <Field
                label="Тренирует навык"
                hint="успешные применения качают уровень навыка актёру (каждые N применений → +1). Навыки — в разделе «Навыки»"
              >
                <Select
                  value={form.trainsSkill}
                  onChange={(v) => setForm({ ...form, trainsSkill: v })}
                  options={[
                    { value: "", label: "— не тренирует —" },
                    ...skills.map((s) => ({
                      value: s.key,
                      label: `${s.emoji} ${s.label} (+1 за ${s.practicePerLevel} применений)`,
                    })),
                  ]}
                />
              </Field>
            </div>

            <div className="mt-4">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-xs font-medium uppercase tracking-wide text-muted">
                  Эффекты на состояние персонажей
                </span>
                <Btn
                  variant="ghost"
                  className="h-7 px-2 text-xs"
                  onClick={() =>
                    setForm((f) => ({
                      ...f,
                      effects: [...f.effects, { target: "self", key: "", op: "add", value: 1 }],
                    }))
                  }
                >
                  <Plus className="h-3 w-3" /> эффект
                </Btn>
              </div>
              {form.effects.length === 0 && (
                <p className="text-xs text-muted/70">
                  Необязательно. Пример: инструмент «свидание» добавляет +1 к ключу closeness
                  получателя.
                </p>
              )}
              {form.effects.map((e, i) => (
                <div key={i} className="mb-2 flex flex-wrap items-center gap-2">
                  <Select
                    value={e.target}
                    onChange={(v) =>
                      setEffect(i, {
                        target: v as ToolEffect["target"],
                        key: v === "relation" || v === "chemistry" ? v : e.key || "mood",
                      })
                    }
                    className="min-w-40 flex-1"
                    options={[
                      { value: "self", label: "актёру" },
                      { value: "tool_target", label: "получателю" },
                      { value: "relation", label: "отношение получателя к актёру" },
                      { value: "chemistry", label: "химия пары ±N" },
                    ]}
                  />
                  {e.target !== "relation" && e.target !== "chemistry" && (
                    <div className="min-w-44 flex-1">
                      <Select
                        value={e.key}
                        onChange={(ev) => setEffect(i, { key: ev })}
                        options={keyOptions(e.key)}
                      />
                    </div>
                  )}
                  <Select
                    value={e.op}
                    onChange={(v) => setEffect(i, { op: v as ToolEffect["op"] })}
                    className="w-20 shrink-0"
                    options={[
                      { value: "add", label: "+=" },
                      { value: "set", label: "=" },
                    ]}
                  />
                  <div className="w-24 shrink-0">
                    <Input
                      value={String(e.value)}
                      onChange={(ev) => {
                        const v = ev.target.value;
                        const num = Number(v);
                        setEffect(i, { value: v !== "" && !Number.isNaN(num) ? num : v });
                      }}
                      placeholder="1"
                    />
                  </div>
                  <IconBtn
                    variant="danger"
                    size="sm"
                    label="Удалить эффект"
                    onClick={() => setForm((f) => ({ ...f, effects: f.effects.filter((_, j) => j !== i) }))}
                  >
                    <Trash2 className="h-4 w-4" />
                  </IconBtn>
                </div>
              ))}
            </div>
          </Section>

          {/* СОГЛАСИЕ */}
          <Section title="Согласие">
            <div className="flex flex-wrap items-center gap-3">
              <Toggle
                checked={form.requiresConsent}
                onChange={(v) => setForm({ ...form, requiresConsent: v })}
                label="Требует согласия получателя"
              />
              <div>
                <div className="text-sm">Требует согласия получателя</div>
                <p className="text-xs leading-relaxed text-muted/80">
                  адресный тул исполняется только после «да» получателя: сначала предложение
                  (offer), потом respond_to_offer
                </p>
              </div>
            </div>
            {form.audience !== "target" && form.requiresConsent && (
              <p className="mt-2 text-xs text-warn/90">
                Согласие работает только у адресных тулов (видно получателю).
              </p>
            )}

            {/* Эффекты отказа: применяются получателем при отклонении предложения */}
            {form.requiresConsent && (
              <div className="mt-4">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-xs font-medium uppercase tracking-wide text-muted">
                    Эффекты отказа
                  </span>
                  <Btn
                    variant="ghost"
                    className="h-7 px-2 text-xs"
                    onClick={() =>
                      setForm((f) => ({
                        ...f,
                        declineEffects: [
                          ...f.declineEffects,
                          { target: "self", key: attributes[0]?.key ?? "mood", op: "add", value: -1 },
                        ],
                      }))
                    }
                  >
                    <Plus className="h-3 w-3" /> эффект
                  </Btn>
                </div>
                {form.declineEffects.length === 0 && (
                  <p className="text-xs leading-relaxed text-muted/70">
                    Необязательно. Мягкая социальная цена отказа: применяются к отказывающемуся,
                    когда он отклоняет предложение (пример: отношение к инициатору −1).
                  </p>
                )}
                {form.declineEffects.map((e, i) => (
                  <div key={i} className="mb-2 flex flex-wrap items-center gap-2">
                    <Select
                      value={e.target}
                      onChange={(v) =>
                        setDeclineEffect(i, {
                          target: v as ToolEffect["target"],
                          key: v === "relation" ? "relation" : e.key || "mood",
                        })
                      }
                      className="min-w-44 flex-1"
                      options={[
                        { value: "self", label: "отказавшемуся" },
                        { value: "relation", label: "отношение отказавшегося к инициатору" },
                      ]}
                    />
                    {e.target !== "relation" && (
                      <div className="min-w-44 flex-1">
                        <Select
                          value={e.key}
                          onChange={(ev) => setDeclineEffect(i, { key: ev })}
                          options={keyOptions(e.key)}
                        />
                      </div>
                    )}
                    <Select
                      value={e.op}
                      onChange={(v) => setDeclineEffect(i, { op: v as ToolEffect["op"] })}
                      className="w-20 shrink-0"
                      options={[
                        { value: "add", label: "+=" },
                        { value: "set", label: "=" },
                      ]}
                    />
                    <div className="w-24 shrink-0">
                      <Input
                        value={String(e.value)}
                        onChange={(ev) => {
                          const v = ev.target.value;
                          const num = Number(v);
                          setDeclineEffect(i, { value: v !== "" && !Number.isNaN(num) ? num : v });
                        }}
                        placeholder="-1"
                      />
                    </div>
                    <IconBtn
                      variant="danger"
                      size="sm"
                      label="Удалить эффект отказа"
                      onClick={() =>
                        setForm((f) => ({
                          ...f,
                          declineEffects: f.declineEffects.filter((_, j) => j !== i),
                        }))
                      }
                    >
                      <Trash2 className="h-4 w-4" />
                    </IconBtn>
                  </div>
                ))}
              </div>
            )}
          </Section>

          {/* ИСХОДЫ: условие → эффекты + личная заметка цели */}
          <Section title="Исходы">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-medium uppercase tracking-wide text-muted">
                Условие → эффекты + заметка цели
              </span>
              <Btn
                variant="ghost"
                className="h-7 px-2 text-xs"
                onClick={() =>
                  setForm((f) => ({
                    ...f,
                    outcomes: [
                      ...f.outcomes,
                      {
                        id: `outcome${f.outcomes.length + 1}`,
                        title: "Особый исход",
                        conditions: [{ kind: "relation", key: "", op: ">=", value: 5 }],
                        effects: [],
                        noticeTarget: "",
                        hideFromPrompt: false,
                      },
                    ],
                  }))
                }
              >
                <Plus className="h-3 w-3" /> исход
              </Btn>
            </div>
            {form.outcomes.length === 0 && (
              <p className="text-xs leading-relaxed text-muted/70">
                Необязательно. Пример: «кульминация» при [навык секса ≥ 3, достоинство ≥ 18,
                отношение ≥ 5] → настроение +3, отношение +2, химия +1 и личная заметка цели;
                «не то» при [навык &lt; 1] → настроение −1. Проверяются по истинным значениям
                на момент действия; побеждает первый подошедший.
              </p>
            )}
            {form.outcomes.length > 0 && form.audience !== "target" && (
              <p className="text-xs text-err">Исходы работают только у адресных тулов (видно получателю).</p>
            )}
            {form.outcomes.map((o, oi) => (
              <div key={oi} className="mb-3 rounded-xl border border-line bg-panel-2/30 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <div className="w-40">
                    <Input
                      value={o.id}
                      onChange={(e) => setOutcome(oi, { id: e.target.value })}
                      className="font-mono text-xs"
                      placeholder="orgasm"
                      title="Стабильный id для условий флоу"
                    />
                  </div>
                  <div className="min-w-40 flex-1">
                    <Input
                      value={o.title}
                      onChange={(e) => setOutcome(oi, { title: e.target.value })}
                      placeholder="Кульминация"
                    />
                  </div>
                  <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted" title="Не раскрывать требования в описании тула — модель узнает по факту">
                    <input
                      type="checkbox"
                      checked={o.hideFromPrompt}
                      onChange={(e) => setOutcome(oi, { hideFromPrompt: e.target.checked })}
                      className="h-3.5 w-3.5 accent-accent"
                    />
                    скрыть требования
                  </label>
                  <IconBtn
                    variant="danger"
                    size="sm"
                    label="Удалить исход"
                    onClick={() =>
                      setForm((f) => ({ ...f, outcomes: f.outcomes.filter((_, j) => j !== oi) }))
                    }
                  >
                    <Trash2 className="h-4 w-4" />
                  </IconBtn>
                </div>

                {/* Условия исхода */}
                <div className="mt-2">
                  <div className="mb-1 flex items-center justify-between">
                    <span className="text-[11px] uppercase tracking-wide text-muted/80">условия (И)</span>
                    <Btn
                      variant="ghost"
                      className="h-6 px-2 text-[11px]"
                      onClick={() =>
                        setOutcome(oi, {
                          conditions: [...o.conditions, { kind: "actor_attr", key: attributes[0]?.key ?? "mood", op: ">=", value: 1 }],
                        })
                      }
                    >
                      <Plus className="h-3 w-3" /> условие
                    </Btn>
                  </div>
                  {o.conditions.map((c, ci) => (
                    <div key={ci} className="mb-1.5 flex flex-wrap items-center gap-2">
                      <Select
                        value={c.kind}
                        onChange={(v) =>
                          setOutcomeCond(oi, ci, {
                            kind: v as OutcomeCondition["kind"],
                            key:
                              v === "worn"
                                ? slots[0]?.slot ?? "top"
                                : v === "actor_attr" || v === "target_attr"
                                  ? c.key || attributes[0]?.key || "mood"
                                  : "",
                            // у place/worn значением строка; остальным — число
                            value:
                              v === "worn" || v === "place"
                                ? ""
                                : typeof c.value === "number"
                                  ? c.value
                                  : 0,
                          })
                        }
                        className="min-w-40 shrink-0"
                        options={[
                          { value: "actor_attr", label: "атрибут/навык актёра" },
                          { value: "target_attr", label: "атрибут цели" },
                          { value: "relation", label: "отношение цели к актёру" },
                          { value: "chemistry", label: "химия пары" },
                          { value: "place", label: "место сцены" },
                          { value: "worn", label: "слот одежды цели" },
                        ]}
                      />
                      {(c.kind === "actor_attr" || c.kind === "target_attr") && (
                        <div className="min-w-40 flex-1">
                          <Select
                            value={c.key}
                            onChange={(v) => setOutcomeCond(oi, ci, { key: v })}
                            options={keyOptions(c.key)}
                          />
                        </div>
                      )}
                      {c.kind === "worn" && (
                        <div className="min-w-32 flex-1">
                          <Select
                            value={c.key}
                            onChange={(v) => setOutcomeCond(oi, ci, { key: v })}
                            options={slots.map((s) => ({ value: s.slot, label: s.slot }))}
                          />
                        </div>
                      )}
                      {c.kind === "place" ? (
                        <div className="min-w-32 flex-1">
                          <Select
                            value={String(c.value)}
                            onChange={(v) => setOutcomeCond(oi, ci, { value: v })}
                            options={[
                              { value: "", label: "— не задано —" },
                              ...places.map((p) => ({ value: p.name, label: p.name })),
                            ]}
                          />
                        </div>
                      ) : c.kind === "worn" ? (
                        <span className="flex-1 text-xs text-muted">значение: пусто (снято) — надето: любое имя предмета</span>
                      ) : (
                        <>
                          <Select
                            value={c.op}
                            onChange={(v) => setOutcomeCond(oi, ci, { op: v as OutcomeCondition["op"] })}
                            className="w-16 shrink-0"
                            options={[
                              { value: ">=", label: "≥" },
                              { value: "<", label: "<" },
                              { value: "=", label: "=" },
                            ]}
                          />
                          <div className="w-24 shrink-0">
                            <Input
                              value={String(c.value)}
                              onChange={(e) => {
                                const num = Number(e.target.value);
                                setOutcomeCond(oi, ci, {
                                  value: e.target.value !== "" && !Number.isNaN(num) ? num : e.target.value,
                                });
                              }}
                              placeholder="3"
                            />
                          </div>
                        </>
                      )}
                      <IconBtn
                        variant="danger"
                        size="sm"
                        label="Удалить условие"
                        onClick={() =>
                          setOutcome(oi, {
                            conditions: o.conditions.filter((_, k) => k !== ci),
                          })
                        }
                      >
                        <Trash2 className="h-4 w-4" />
                      </IconBtn>
                    </div>
                  ))}
                </div>

                {/* Эффекты исхода */}
                <div className="mt-2">
                  <div className="mb-1 flex items-center justify-between">
                    <span className="text-[11px] uppercase tracking-wide text-muted/80">эффекты исхода</span>
                    <Btn
                      variant="ghost"
                      className="h-6 px-2 text-[11px]"
                      onClick={() =>
                        setOutcome(oi, {
                          effects: [...o.effects, { target: "tool_target", key: attributes[0]?.key ?? "mood", op: "add", value: 1 }],
                        })
                      }
                    >
                      <Plus className="h-3 w-3" /> эффект
                    </Btn>
                  </div>
                  {o.effects.map((e, ei) => (
                    <div key={ei} className="mb-1.5 flex flex-wrap items-center gap-2">
                      <Select
                        value={e.target}
                        onChange={(v) =>
                          setOutcomeEffect(oi, ei, {
                            target: v as ToolEffect["target"],
                            key: v === "relation" || v === "chemistry" ? v : e.key || "mood",
                          })
                        }
                        className="min-w-40 flex-1"
                        options={[
                          { value: "self", label: "актёру" },
                          { value: "tool_target", label: "получателю" },
                          { value: "relation", label: "отношение получателя к актёру" },
                          { value: "chemistry", label: "химия пары ±N" },
                        ]}
                      />
                      {e.target !== "relation" && e.target !== "chemistry" && (
                        <div className="min-w-40 flex-1">
                          <Select
                            value={e.key}
                            onChange={(ev) => setOutcomeEffect(oi, ei, { key: ev })}
                            options={keyOptions(e.key)}
                          />
                        </div>
                      )}
                      <Select
                        value={e.op}
                        onChange={(v) => setOutcomeEffect(oi, ei, { op: v as ToolEffect["op"] })}
                        className="w-20 shrink-0"
                        options={[
                          { value: "add", label: "+=" },
                          { value: "set", label: "=" },
                        ]}
                      />
                      <div className="w-24 shrink-0">
                        <Input
                          value={String(e.value)}
                          onChange={(ev) => {
                            const v = ev.target.value;
                            const num = Number(v);
                            setOutcomeEffect(oi, ei, { value: v !== "" && !Number.isNaN(num) ? num : v });
                          }}
                          placeholder="1"
                        />
                      </div>
                      <IconBtn
                        variant="danger"
                        size="sm"
                        label="Удалить эффект исхода"
                        onClick={() =>
                          setOutcome(oi, { effects: o.effects.filter((_, k) => k !== ei) })
                        }
                      >
                        <Trash2 className="h-4 w-4" />
                      </IconBtn>
                    </div>
                  ))}
                </div>

                <div className="mt-2">
                  <Input
                    value={o.noticeTarget}
                    onChange={(e) => setOutcome(oi, { noticeTarget: e.target.value })}
                    placeholder="Заметка цели от лица мира: «…волна накрывает с головой»"
                    className="text-xs"
                  />
                </div>
              </div>
            ))}
          </Section>

          <div className="mt-5 flex gap-2">
            <Btn variant="primary" onClick={save} loading={saving}>
              Сохранить
            </Btn>
            <Btn variant="ghost" onClick={() => setOpen(false)}>
              Отмена
            </Btn>
          </div>
        </Card>
        </div>
      )}

      {tools.length === 0 ? (
        <EmptyState
          icon={<Wrench className="h-8 w-8" />}
          title="Инструментов нет"
          hint="Создайте действия для персонажей: сообщения, прогулки, фото — что угодно."
        />
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          {tools.map((t) => (
            <Card key={t.id} className="p-4 transition-colors hover:border-accent/40">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{t.title || t.name}</span>
                <Badge>{AUDIENCE_LABEL[t.audience]}</Badge>
                {t.cost > 0 && <Badge color="warn">${t.cost}</Badge>}
                {t.origin === "agent" && <Badge color="accent">от агента</Badge>}
                {t.trainsSkill && (
                  <Badge color="ok">
                    тренирует: {skillById.get(t.trainsSkill)?.label ?? t.trainsSkill}
                  </Badge>
                )}
              </div>
                  <div className="mt-0.5 font-mono text-xs text-accent/80">{t.name}</div>
                  <p className="mt-2 line-clamp-2 text-xs leading-relaxed text-muted">
                    {t.description}
                  </p>
                </div>
                <div className="flex shrink-0 gap-1.5">
                  <IconBtn label="Редактировать" onClick={() => startEdit(t)}>
                    <Eye className="h-[18px] w-[18px]" />
                  </IconBtn>
                  <IconBtn variant="danger" label="Удалить инструмент" onClick={() => remove(t)}>
                    <Trash2 className="h-[18px] w-[18px]" />
                  </IconBtn>
                </div>
              </div>
              {t.outcomes.length > 0 && (
                <div className="mt-2 text-xs text-muted">
                  Исходы:{" "}
                  {t.outcomes
                    .map((o) => `«${o.title}» (${o.id}${o.hideFromPrompt ? ", скрыт" : ""})`)
                    .join("; ")}
                </div>
              )}
              {t.effects.length > 0 && (
                <div className="mt-3 border-t border-line pt-2 text-xs text-muted">
                  Эффекты:{" "}
                  {t.effects
                    .map((e) => `${e.target === "self" ? "актёр" : e.target === "relation" ? "отношение получателя" : e.target === "chemistry" ? "химия пары" : "получатель"}.${e.key} ${e.op === "add" ? "+=" : "="} ${JSON.stringify(e.value)}`)
                    .join("; ")}
                </div>
              )}
            </Card>
          ))}
        </div>
      )}

      {/* ---- Комбо: скрытые последовательности вызовов ---- */}
      <div className="mt-10 flex items-center justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <Sparkles className="h-5 w-5 text-accent" /> Комбо (скрытые последовательности)
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            Цепочка успешных вызовов за окно ходов: сработала — применяются эффекты. Шаг можно
            привязать к получателю («на ком») и исполнителю («кто»). Подсказку-рецепт видят только
            знающие; пусто — секретное достижение: никто не знает, при срабатывании объявление всем.
          </p>
        </div>
        <Btn variant="primary" onClick={startComboCreate}>
          <Plus className="h-4 w-4" /> Комбо
        </Btn>
      </div>
      <ErrorText>{error}</ErrorText>

      {comboOpen && (
        <div ref={comboFormRef}>
        <Card className="mt-4 p-5">
          <div className="mb-4 text-sm font-medium">
            {comboEditing ? `Редактирование комбо: ${comboForm.title || comboForm.name}` : "Новое комбо"}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Имя (ключ)" hint="латиница строчными: tender_morning, workout…">
              <Input
                value={comboForm.name}
                onChange={(e) => setComboForm({ ...comboForm, name: e.target.value })}
                placeholder="tender_morning"
                className="font-mono"
                disabled={comboEditing != null}
              />
            </Field>
            <Field label="Заголовок" hint="что увидит исполнитель в подсказке">
              <Input
                value={comboForm.title}
                onChange={(e) => setComboForm({ ...comboForm, title: e.target.value })}
                placeholder="Нежное утро"
              />
            </Field>
            <Field
              label="Описание"
              className="sm:col-span-2"
              hint="что случится — текст, который увидит исполнитель"
            >
              <Textarea
                rows={2}
                value={comboForm.description}
                onChange={(e) => setComboForm({ ...comboForm, description: e.target.value })}
                placeholder="Поцелуй, объятия и завтрак — настроение обоим поднимается."
              />
            </Field>
            <Field label="Окно в ходах" hint="сколько ходов отделяет первый шаг от последнего">
              <Input
                type="number"
                min={1}
                max={100}
                value={comboForm.windowTurns}
                onChange={(e) => setComboForm({ ...comboForm, windowTurns: Number(e.target.value) })}
              />
            </Field>
          </div>

          <div className="mt-4">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-medium uppercase tracking-wide text-muted">
                Шаги (по порядку, минимум два)
              </span>
              <Btn
                variant="ghost"
                className="h-7 px-2 text-xs"
                disabled={comboForm.steps.length >= 10}
                onClick={() => setComboForm((f) => ({ ...f, steps: [...f.steps, emptyComboStep()] }))}
              >
                <Plus className="h-3 w-3" /> шаг
              </Btn>
            </div>
            <p className="mb-2 text-xs leading-relaxed text-muted/70">
              «На ком» — шаг засчитывается, только когда действие направлено на этого участника
              (массаж Яне, а не от неё). «Кто» — исполнитель. Без фильтров всю цепочку должен
              пройти один и тот же персонаж.
            </p>
            {comboForm.steps.map((s, i) => (
              <div key={i} className="mb-2 flex items-center gap-2">
                <span className="w-5 shrink-0 text-center text-xs text-muted">{i + 1}</span>
                <div className="min-w-40 flex-1">
                  <Select
                    value={s.toolName}
                    onChange={(v) => setComboStep(i, { toolName: v })}
                    options={comboToolOptions}
                  />
                </div>
                <div className="min-w-36 flex-1">
                  <Select
                    value={s.targetName}
                    onChange={(v) => setComboStep(i, { targetName: v })}
                    options={comboWhoOptions}
                    className="text-xs"
                  />
                </div>
                <div className="min-w-36 flex-1">
                  <Select
                    value={s.actorName}
                    onChange={(v) => setComboStep(i, { actorName: v })}
                    options={comboWhoOptions}
                    className="text-xs"
                  />
                </div>
                <IconBtn
                  variant="danger"
                  size="sm"
                  label="Удалить шаг"
                  disabled={comboForm.steps.length <= 2}
                  onClick={() =>
                    setComboForm((f) => ({ ...f, steps: f.steps.filter((_, j) => j !== i) }))
                  }
                >
                  <Trash2 className="h-4 w-4" />
                </IconBtn>
              </div>
            ))}
          </div>

          <div className="mt-4">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-medium uppercase tracking-wide text-muted">
                Эффекты завершённого комбо
              </span>
              <Btn
                variant="ghost"
                className="h-7 px-2 text-xs"
                onClick={() =>
                  setComboForm((f) => ({
                    ...f,
                    effects: [...f.effects, { target: "self", key: attributes[0]?.key ?? "mood", op: "add", value: 1 }],
                  }))
                }
              >
                <Plus className="h-3 w-3" /> эффект
              </Btn>
            </div>
            {comboForm.effects.length === 0 && (
              <p className="text-xs leading-relaxed text-muted/70">
                Необязательно. Применяются исполнителю (и цели последнего вызова) при закрытии
                цепочки.
              </p>
            )}
            {comboForm.effects.map((e, i) => (
              <div key={i} className="mb-2 flex flex-wrap items-center gap-2">
                <Select
                  value={e.target}
                  onChange={(v) =>
                    setComboEffect(i, {
                      target: v as ToolEffect["target"],
                      key: v === "relation" || v === "chemistry" ? v : e.key || "mood",
                    })
                  }
                  className="min-w-40 flex-1"
                  options={[
                    { value: "self", label: "исполнителю" },
                    { value: "tool_target", label: "цели последнего вызова" },
                    { value: "relation", label: "отношение цели к исполнителю" },
                    { value: "chemistry", label: "химия пары ±N" },
                  ]}
                />
                {e.target !== "relation" && e.target !== "chemistry" && (
                  <div className="min-w-44 flex-1">
                    <Select
                      value={e.key}
                      onChange={(ev) => setComboEffect(i, { key: ev })}
                      options={keyOptions(e.key)}
                    />
                  </div>
                )}
                <Select
                  value={e.op}
                  onChange={(v) => setComboEffect(i, { op: v as ToolEffect["op"] })}
                  className="w-20 shrink-0"
                  options={[
                    { value: "add", label: "+=" },
                    { value: "set", label: "=" },
                  ]}
                />
                <div className="w-24 shrink-0">
                  <Input
                    value={String(e.value)}
                    onChange={(ev) => {
                      const v = ev.target.value;
                      const num = Number(v);
                      setComboEffect(i, { value: v !== "" && !Number.isNaN(num) ? num : v });
                    }}
                    placeholder="1"
                  />
                </div>
                <IconBtn
                  variant="danger"
                  size="sm"
                  label="Удалить эффект"
                  onClick={() =>
                    setComboForm((f) => ({ ...f, effects: f.effects.filter((_, j) => j !== i) }))
                  }
                >
                  <Trash2 className="h-4 w-4" />
                </IconBtn>
              </div>
            ))}
          </div>

          <div className="mt-4">
            <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">
              Знают комбо
            </div>
            {characters.length === 0 ? (
              <p className="text-xs text-muted/70">
                Персонажей пока нет — комбо будет доступно всем (появившимся позже тоже).
              </p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {characters.map((c) => {
                  const on = comboForm.knowers.includes(c.id);
                  return (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => toggleKnower(c.id)}
                      className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs transition-colors ${
                        on
                          ? "border-accent/50 bg-accent/15 text-fg"
                          : "border-line bg-panel-2/50 text-muted hover:text-fg"
                      }`}
                    >
                      <span>{c.emoji}</span>
                      {c.name}
                    </button>
                  );
                })}
              </div>
            )}
            <p className="mt-1.5 text-xs text-muted/70">
              Никого не выбрано — рецепт не знает никто: секретное достижение, оба узнают по
              анонсу при срабатывании.
            </p>
          </div>

          <label className="mt-4 flex cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={comboForm.announce}
              onChange={(e) => setComboForm((f) => ({ ...f, announce: e.target.checked }))}
              className="h-4 w-4 accent-[var(--accent)]"
            />
            <span>
              Анонс при срабатывании
              <span className="ml-1 text-xs text-muted">
                — событие мира для всех участников («достижение открыто»)
              </span>
            </span>
          </label>

          <div className="mt-5 flex gap-2">
            <Btn variant="primary" onClick={saveCombo} loading={comboSaving}>
              Сохранить
            </Btn>
            <Btn variant="ghost" onClick={() => setComboOpen(false)}>
              Отмена
            </Btn>
          </div>
        </Card>
        </div>
      )}

      {combos.length === 0 && !comboOpen ? (
        <p className="mt-4 text-xs text-muted/70">Комбо пока нет — добавьте первую цепочку.</p>
      ) : (
        <div className="mt-4 grid gap-2 sm:grid-cols-2">
          {combos.map((c) => (
            <Card key={c.id} className="p-4 transition-colors hover:border-accent/40">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{c.title}</span>
                    <Badge color="accent">окно {c.windowTurns} ход.</Badge>
                  </div>
                  <div className="mt-0.5 font-mono text-xs text-accent/80">{c.name}</div>
                  {c.description && (
                    <p className="mt-2 line-clamp-2 text-xs leading-relaxed text-muted">
                      {c.description}
                    </p>
                  )}
                  <div className="mt-2 flex flex-wrap items-center gap-1">
                    {c.steps.map((st, i) => (
                      <span key={i} className="flex items-center gap-1">
                        {i > 0 && <span className="text-muted/50">→</span>}
                        <span className="rounded-md border border-line bg-panel-2/50 px-1.5 py-0.5 font-mono text-[10px] text-muted">
                          {st.toolName}
                          {st.targetName ? ` → ${st.targetName}` : ""}
                          {st.actorName ? ` (${st.actorName})` : ""}
                        </span>
                      </span>
                    ))}
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-1 text-xs text-muted">
                    знают:
                    {c.knowers.length === 0 ? (
                      <span className="ml-1">
                        никто — секретное достижение{c.announce ? ", анонс всем" : ""}
                      </span>
                    ) : (
                      c.knowers.map((id) => (
                        <span
                          key={id}
                          className="rounded-md border border-line bg-panel-2/50 px-1.5 py-0.5"
                        >
                          {charById.get(id)?.emoji ? `${charById.get(id)!.emoji} ` : ""}
                          {charById.get(id)?.name ?? `#${id}`}
                        </span>
                      ))
                    )}
                  </div>
                </div>
                <div className="flex shrink-0 gap-1.5">
                  <IconBtn label="Редактировать комбо" onClick={() => startComboEdit(c)}>
                    ✎
                  </IconBtn>
                  <IconBtn variant="danger" label="Удалить комбо" onClick={() => removeCombo(c)}>
                    <Trash2 className="h-[18px] w-[18px]" />
                  </IconBtn>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
