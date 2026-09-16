"use client";

import { useCallback, useEffect, useState } from "react";
import { Eye, Plus, Trash2, Wrench } from "lucide-react";
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
} from "@/components/ui";
import { api, apiDelete, apiPatch, apiPost } from "@/components/api";
import type {
  AttributeDef,
  ClothingSlot,
  OutcomeCondition,
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
  schemaText: string;
  audience: ToolAudience;
  targetParam: string;
  observationTemplate: string;
  effects: ToolEffect[];
  cost: number;
  trainsSkill: string;
  outcomes: ToolOutcome[];
}

const emptyForm: FormState = {
  name: "",
  title: "",
  description: "",
  schemaText: '{\n  "type": "object",\n  "properties": {},\n  "required": []\n}',
  audience: "all",
  targetParam: "",
  observationTemplate: "{name}: {action}",
  effects: [],
  cost: 0,
  trainsSkill: "",
  outcomes: [],
};

function toolToForm(t: Tool): FormState {
  return {
    name: t.name,
    title: t.title,
    description: t.description,
    schemaText: JSON.stringify(t.parametersSchema, null, 2),
    audience: t.audience,
    targetParam: t.targetParam ?? "",
    observationTemplate: t.observationTemplate,
    effects: t.effects,
    cost: t.cost ?? 0,
    trainsSkill: t.trainsSkill ?? "",
    outcomes: t.outcomes ?? [],
  };
}

export default function ToolsPage() {
  const [tools, setTools] = useState<Tool[]>([]);
  const [attributes, setAttributes] = useState<AttributeDef[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [slots, setSlots] = useState<ClothingSlot[]>([]);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    api<Tool[]>("/api/tools").then(setTools).catch((e) => setError(e.message));
    api<AttributeDef[]>("/api/attributes").then(setAttributes).catch(() => {});
    api<Skill[]>("/api/skills").then(setSkills).catch(() => {});
    api<ClothingSlot[]>("/api/clothing-slots").then(setSlots).catch(() => {});
  }, []);
  useEffect(load, [load]);

  const skillById = new Map(skills.map((s) => [s.key, s]));

  const attrKeyOptions = attributes.map((a) => ({
    value: a.key,
    label: `${a.emoji ? a.emoji + " " : ""}${a.label} (${a.key})`,
  }));
  const keyOptions = (cur: string) =>
    attrKeyOptions.some((o) => o.value === cur)
      ? attrKeyOptions
      : [{ value: cur, label: `${cur} (нет в реестре)` }, ...attrKeyOptions];

  const startCreate = (tpl?: keyof typeof TEMPLATES) => {
    const base = tpl ? TEMPLATES[tpl]() : {};
    setForm({
      ...emptyForm,
      ...(base as Partial<FormState>),
      schemaText: base.parametersSchema
        ? JSON.stringify(base.parametersSchema, null, 2)
        : emptyForm.schemaText,
    });
    setEditingId(null);
    setOpen(true);
  };

  const startEdit = (t: Tool) => {
    setForm(toolToForm(t));
    setEditingId(t.id);
    setOpen(true);
  };

  const save = async () => {
    setError("");
    let schema: Record<string, unknown>;
    try {
      schema = JSON.parse(form.schemaText || "{}");
    } catch {
      setError("JSON-схема параметров невалидна");
      return;
    }
    if (form.audience === "target" && !form.targetParam.trim()) {
      setError("Укажите параметр с именем получателя (например «to»)");
      return;
    }
    setSaving(true);
    const body = {
      name: form.name,
      title: form.title,
      description: form.description,
      parametersSchema: schema,
      audience: form.audience,
      targetParam: form.audience === "target" ? form.targetParam.trim() : null,
      observationTemplate: form.observationTemplate,
      effects: form.effects,
      cost: form.cost,
      trainsSkill: form.trainsSkill,
      outcomes: form.outcomes,
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
            <Field label="JSON-схема параметров" className="sm:col-span-2">
              <Textarea
                rows={8}
                value={form.schemaText}
                onChange={(e) => setForm({ ...form, schemaText: e.target.value })}
                className="font-mono text-xs"
                spellCheck={false}
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
              <Field label="Параметр с получателем" hint="имя параметра из схемы, в котором приходит имя персонажа">
                <Input
                  value={form.targetParam}
                  onChange={(e) => setForm({ ...form, targetParam: e.target.value })}
                  placeholder="to"
                  className="font-mono"
                />
              </Field>
            )}
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
            <Field
              label="Шаблон наблюдения"
              className="sm:col-span-2"
              hint="Как действие выглядит для других. Подстановки: {name} — имя актёра, {tool} — ярлык, {параметр} — любой параметр из схемы."
            >
              <Input
                value={form.observationTemplate}
                onChange={(e) => setForm({ ...form, observationTemplate: e.target.value })}
                placeholder="{name} пишет тебе: {text}"
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

          {/* Исходы: условие → эффекты + личная заметка цели */}
          <div className="mt-5">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-medium uppercase tracking-wide text-muted">
                Исходы (условия → эффекты + заметка цели)
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
                            value: v === "worn" ? "" : typeof c.value === "number" ? c.value : 0,
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
                          <Input
                            value={String(c.value)}
                            onChange={(e) => setOutcomeCond(oi, ci, { value: e.target.value })}
                            placeholder="отель"
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
          </div>

          <div className="mt-5 flex gap-2">
            <Btn variant="primary" onClick={save} loading={saving}>
              Сохранить
            </Btn>
            <Btn variant="ghost" onClick={() => setOpen(false)}>
              Отмена
            </Btn>
          </div>
        </Card>
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
    </div>
  );
}
