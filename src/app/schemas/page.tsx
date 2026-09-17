"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Ban,
  ListChecks,
  Plus,
  Trash2,
  Zap,
} from "lucide-react";
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
  Textarea,
} from "@/components/ui";
import { Dropdown } from "@/components/Dropdown";
import { api, apiDelete, apiPatch, apiPost } from "@/components/api";
import type { Tool, ValidationSchema, ValidationStep } from "@/lib/types";

interface FormState {
  name: string;
  description: string;
  steps: ValidationStep[];
  forbidden: string[];
  penalty: number;
}

const emptyForm: FormState = { name: "", description: "", steps: [], forbidden: [], penalty: 3 };

export default function SchemasPage() {
  const [schemas, setSchemas] = useState<ValidationSchema[]>([]);
  const [tools, setTools] = useState<Tool[]>([]);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  // Реф карточки формы: «Изменить» открывает форму наверху страницы — прокручиваем к ней
  const formRef = useRef<HTMLDivElement>(null);

  const load = useCallback(() => {
    Promise.all([api<ValidationSchema[]>("/api/schemas"), api<Tool[]>("/api/tools")])
      .then(([s, t]) => {
        setSchemas(s);
        setTools(t);
      })
      .catch((e) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  const startCreate = () => {
    setForm({ ...emptyForm, steps: [] });
    setEditingId(null);
    setOpen(true);
  };

  const startEdit = (s: ValidationSchema) => {
    setForm({
      name: s.name,
      description: s.description,
      steps: s.steps.map((st) => ({ ...st })),
      forbidden: [...s.forbidden],
      penalty: s.penalty,
    });
    setEditingId(s.id);
    setOpen(true);
    requestAnimationFrame(() =>
      formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })
    );
  };

  const save = async () => {
    setError("");
    if (!form.name.trim()) return setError("Дайте схеме название");
    if (form.steps.length === 0) return setError("Добавьте хотя бы один шаг цепочки");
    setSaving(true);
    try {
      if (editingId) await apiPatch(`/api/schemas/${editingId}`, form);
      else await apiPost("/api/schemas", form);
      setOpen(false);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (s: ValidationSchema) => {
    if (!confirm(`Удалить схему «${s.name}»? Привязки в сценах будут отвязаны.`)) return;
    setError("");
    try {
      await apiDelete(`/api/schemas/${s.id}`);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const setStep = (i: number, patch: Partial<ValidationStep>) =>
    setForm((f) => ({ ...f, steps: f.steps.map((s, j) => (i === j ? { ...s, ...patch } : s)) }));

  const moveStep = (i: number, dir: -1 | 1) =>
    setForm((f) => {
      const j = i + dir;
      if (j < 0 || j >= f.steps.length) return f;
      const copy = [...f.steps];
      [copy[i], copy[j]] = [copy[j], copy[i]];
      return { ...f, steps: copy };
    });

  const toggleForbidden = (name: string) =>
    setForm((f) => ({
      ...f,
      forbidden: f.forbidden.includes(name)
        ? f.forbidden.filter((x) => x !== name)
        : [...f.forbidden, name],
    }));

  const toolOptions = [{ value: "", label: "— инструмент —" }, ...tools.map((t) => ({ value: t.name, label: t.title || t.name }))];

  return (
    <div className="mx-auto max-w-5xl px-8 py-10">
      <PageHeader
        title="Схемы валидации"
        subtitle="Цепочки действий для оценки персонажей: шаги должны выполняться по порядку. Персонажи о схемах не знают — оценка считается по логу событий после (или во время) сцены."
        actions={
          <Btn variant="primary" onClick={startCreate}>
            <Plus className="h-4 w-4" /> Создать
          </Btn>
        }
      />
      <ErrorText>{error}</ErrorText>

      {open && (
        <div ref={formRef}>
        <Card className="mb-6 p-5">
          <div className="mb-4 text-sm font-medium">
            {editingId ? `Редактирование: ${form.name}` : "Новая схема"}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Название">
              <Input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="Соблазнение Яны"
              />
            </Field>
            <Field label="Штраф за нарушение" hint="за каждый ранний/запрещённый вызов">
              <Input
                type="number"
                min={0}
                value={form.penalty}
                onChange={(e) => setForm({ ...form, penalty: Number(e.target.value) })}
              />
            </Field>
            <Field
              label="Описание (для вас, персонажам не видно)"
              className="sm:col-span-2"
            >
              <Textarea
                rows={2}
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                placeholder="Романтическая динамика: кофе → поцелуй → свидание. Перепрыгивать нельзя, поцелуй — бонус."
              />
            </Field>
          </div>

          <div className="mt-5">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-medium uppercase tracking-wide text-muted">
                Цепочка шагов (порядок важен)
              </span>
              <Btn
                variant="ghost"
                className="h-7 px-2 text-xs"
                onClick={() =>
                  setForm((f) => ({
                    ...f,
                    steps: [...f.steps, { toolName: "", required: true, points: 10, minCount: 1, argContains: null }],
                  }))
                }
              >
                <Plus className="h-3 w-3" /> шаг
              </Btn>
            </div>
            {form.steps.length === 0 && (
              <p className="text-xs text-muted/70">
                Пример: «пригласить на кофе» (обязательный, 10) → «поцелуй» (бонус, 5) →
                «свидание» (обязательный, 20). Поцелуй раньше кофе — нарушение; без поцелуя —
                просто нет бонуса.
              </p>
            )}
            {form.steps.map((s, i) => (
              <div
                key={i}
                className="mb-2 flex flex-wrap items-end gap-2 rounded-xl border border-line bg-panel-2/30 p-3"
              >
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent/20 text-xs font-semibold text-accent">
                  {i + 1}
                </span>
                <div className="w-48">
                  <Dropdown
                    direction="down"
                    value={s.toolName}
                    onChange={(v) => setStep(i, { toolName: v })}
                    options={toolOptions}
                  />
                </div>
                <label className="flex cursor-pointer items-center gap-1.5 pb-2 text-xs text-muted">
                  <input
                    type="checkbox"
                    checked={s.required}
                    onChange={(e) => setStep(i, { required: e.target.checked })}
                    className="h-3.5 w-3.5 accent-[var(--color-accent)]"
                  />
                  обязательный
                </label>
                <Input
                  type="number"
                  min={0}
                  value={s.points}
                  onChange={(e) => setStep(i, { points: Number(e.target.value) })}
                  className="w-20"
                  title="Баллы"
                  placeholder="баллы"
                />
                <Input
                  type="number"
                  min={1}
                  value={s.minCount}
                  onChange={(e) => setStep(i, { minCount: Number(e.target.value) })}
                  className="w-16"
                  title="Сколько раз нужно вызвать"
                  placeholder="кол-во"
                />
                <Input
                  value={s.argContains ?? ""}
                  onChange={(e) => setStep(i, { argContains: e.target.value || null })}
                  className="w-36"
                  title="Фильтр по аргументам: подстрока в JSON (например, имя получателя)"
                  placeholder="фильтр args"
                />
                <div className="ml-auto flex gap-1.5 pb-0.5">
                  <IconBtn size="sm" label="Шаг выше" onClick={() => moveStep(i, -1)}>
                    <ArrowUp className="h-4 w-4" />
                  </IconBtn>
                  <IconBtn size="sm" label="Шаг ниже" onClick={() => moveStep(i, 1)}>
                    <ArrowDown className="h-4 w-4" />
                  </IconBtn>
                  <IconBtn
                    variant="danger"
                    size="sm"
                    label="Удалить шаг"
                    onClick={() => setForm((f) => ({ ...f, steps: f.steps.filter((_, j) => j !== i) }))}
                  >
                    <Trash2 className="h-4 w-4" />
                  </IconBtn>
                </div>
              </div>
            ))}
          </div>

          <div className="mt-4">
            <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">
              Запрещённые инструменты
            </div>
            {tools.length === 0 ? (
              <p className="text-xs text-muted/70">Сначала создайте инструменты.</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {tools.map((t) => {
                  const on = form.forbidden.includes(t.name);
                  return (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => toggleForbidden(t.name)}
                      className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs transition-colors ${
                        on
                          ? "border-err/50 bg-err/15 text-err"
                          : "border-line bg-panel-2/50 text-muted hover:text-fg"
                      }`}
                    >
                      {on && <Ban className="h-3 w-3" />}
                      {t.title || t.name}
                    </button>
                  );
                })}
              </div>
            )}
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
        </div>
      )}

      {schemas.length === 0 ? (
        <EmptyState
          icon={<ListChecks className="h-8 w-8" />}
          title="Схем пока нет"
          hint="Создайте цепочку шагов — она станет «e2e-тестом» для персонажа в сцене."
        />
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          {schemas.map((s) => (
            <Card key={s.id} className="p-4 transition-colors hover:border-accent/40">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{s.name}</span>
                    {s.penalty > 0 && <Badge color="err">−{s.penalty} за нарушение</Badge>}
                  </div>
                  {s.description && (
                    <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted">
                      {s.description}
                    </p>
                  )}
                  <div className="mt-2 flex flex-wrap items-center gap-1">
                    {s.steps.map((st, i) => (
                      <span key={i} className="flex items-center gap-1">
                        {i > 0 && <span className="text-muted/50">→</span>}
                        <span
                          className={`rounded-md border px-1.5 py-0.5 font-mono text-[10px] ${
                            st.required
                              ? "border-accent/40 bg-accent/10 text-accent"
                              : "border-line bg-panel-2/50 text-muted"
                          }`}
                          title={`${st.required ? "обязательный" : "бонус"} · ${st.points} баллов${st.minCount > 1 ? ` · ×${st.minCount}` : ""}`}
                        >
                          {st.toolName}
                          <span className="opacity-60"> +{st.points}</span>
                        </span>
                      </span>
                    ))}
                    {s.forbidden.map((f) => (
                      <span
                        key={f}
                        className="rounded-md border border-err/40 bg-err/10 px-1.5 py-0.5 font-mono text-[10px] text-err line-through"
                      >
                        {f}
                      </span>
                    ))}
                  </div>
                </div>
                <div className="flex shrink-0 gap-1.5">
                  <IconBtn label="Редактировать схему" onClick={() => startEdit(s)}>
                    <Zap className="h-[18px] w-[18px]" />
                  </IconBtn>
                  <IconBtn variant="danger" label="Удалить схему" onClick={() => remove(s)}>
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
