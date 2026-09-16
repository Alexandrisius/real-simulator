"use client";

import { use, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Plus, RefreshCw, Shield, Trash2 } from "lucide-react";
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
import type { AttributeDef, Boundary, Character, Provider, Tool } from "@/lib/types";

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
  temperature: number;
  maxTokens: number;
  toolIds: number[];
  stateText: string;
  isHuman: boolean;
  income: number;
  boundaries: Boundary[];
}

const emptyForm: FormState = {
  name: "",
  emoji: "🙂",
  persona: "",
  providerId: null,
  model: "",
  temperature: 0.8,
  maxTokens: 1024,
  toolIds: [],
  stateText: "{}",
  isHuman: false,
  income: 0,
  boundaries: [],
};

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
  const [models, setModels] = useState<string[]>([]);
  const [modelsError, setModelsError] = useState("");
  const [loadingModels, setLoadingModels] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);

  const loadMeta = useCallback(() => {
    Promise.all([
      api<Provider[]>("/api/providers"),
      api<Tool[]>("/api/tools"),
      api<AttributeDef[]>("/api/attributes"),
      api<Character[]>("/api/characters").catch(() => [] as Character[]),
      api<{ aId: number; bId: number; value: number }[]>("/api/chemistry").catch(() => []),
    ])
      .then(([p, t, a, ch, cm]) => {
        setProviders(p);
        setTools(t);
        setAttributes(a);
        setChem(cm);
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
        setForm({
          name: c.name,
          emoji: c.emoji,
          persona: c.persona,
          providerId: c.providerId,
          model: c.model,
          temperature: c.temperature,
          maxTokens: c.maxTokens,
          toolIds: c.toolIds,
          stateText: JSON.stringify(c.state, null, 2),
          isHuman: c.isHuman,
          income: c.income ?? 0,
          boundaries: c.boundaries ?? [],
        });
        setLoaded(true);
      })
      .catch((e) => setError(e.message));
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
    if (type === "number") {
      if (raw === "") delete next[key];
      else {
        const n = Number(raw);
        if (Number.isNaN(n)) return;
        next[key] = n;
      }
    } else if (raw === "") {
      delete next[key];
    } else {
      next[key] = raw;
    }
    setForm((f) => ({ ...f, stateText: JSON.stringify(next, null, 2) }));
  };

  const knownKeys = new Set(attributes.map((a) => a.key));
  const extraKeys = stateObj
    ? Object.keys(stateObj).filter((k) => !knownKeys.has(k))
    : [];
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
      state = JSON.parse(form.stateText || "{}");
    } catch {
      setError("Состояние (JSON) невалидно");
      return;
    }
    const body = {
      name: form.name,
      emoji: form.emoji || "🙂",
      persona: form.persona,
      providerId: form.isHuman ? null : form.providerId,
      model: form.isHuman ? "" : form.model,
      temperature: form.temperature,
      maxTokens: form.maxTokens,
      toolIds: form.toolIds,
      state,
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
          Правила на адресные действия против этого персонажа. Условия проверяются движком
          до денег и эффектов: не выполнено — отказ (действие не происходит, деньги целы),
          а попытку владелец границы видит автоматически. Последствия отказа бьют по
          отношению владельца к актёру и по его же настроению — актёра система не трогает.
        </p>

        <div className="flex flex-col gap-3">
          {form.boundaries.map((b, bi) => {
            const setB = (patch: Partial<Boundary>) =>
              setForm((f) => ({
                ...f,
                boundaries: f.boundaries.map((x, i) => (i === bi ? { ...x, ...patch } : x)),
              }));
            const addressedTools = tools.filter((t) => t.audience === "target");
            return (
              <div key={bi} className="rounded-lg border border-line bg-panel-2/40 p-3">
                <div className="flex items-center gap-2">
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

                <div className="mt-2.5 grid gap-2.5 sm:grid-cols-3">
                  <Field label="Отношение ≥" hint="отношение этого персонажа к актёру">
                    <Input
                      type="number"
                      value={b.minRelation ?? ""}
                      onChange={(e) =>
                        setB({ minRelation: e.target.value === "" ? null : Number(e.target.value) })
                      }
                      placeholder="—"
                      className="max-w-[7.5rem]"
                    />
                  </Field>
                  <Field label="Настроение ≥" hint="ключ mood владельца границы">
                    <Input
                      type="number"
                      value={b.minMood ?? ""}
                      onChange={(e) =>
                        setB({ minMood: e.target.value === "" ? null : Number(e.target.value) })
                      }
                      placeholder="—"
                      className="max-w-[7.5rem]"
                    />
                  </Field>
                  <Field label="Только в месте" hint="место сцены: дом, отель…">
                    <Combobox
                      value={b.requirePlace ?? ""}
                      onChange={(v) => setB({ requirePlace: v === "" ? null : v })}
                      options={["дом", "улица", "кафе", "отель", "пляж"]}
                      placeholder="— любое —"
                    />
                  </Field>
                </div>

                <div className="mt-2.5 grid gap-2.5 sm:grid-cols-2">
                  <Field label="Требование к характеристике (физика)" hint="проверяется истинное значение — заявления не считаются">
                    <div className="flex gap-2">
                      <Select
                        value={b.requireAttr ? b.requireAttr.owner : ""}
                        onChange={(v) =>
                          setB({
                            requireAttr:
                              v === ""
                                ? null
                                : {
                                    owner: v as "actor" | "target",
                                    key: b.requireAttr?.key ?? attributes[0]?.key ?? "height",
                                    op: b.requireAttr?.op ?? ">=",
                                    value: b.requireAttr?.value ?? 0,
                                  },
                          })
                        }
                        className="w-32"
                        options={[
                          { value: "", label: "нет" },
                          { value: "actor", label: "у актёра" },
                          { value: "target", label: "у владельца" },
                        ]}
                      />
                      {b.requireAttr && (
                        <>
                          <div className="min-w-0 flex-1">
                            <Select
                              value={b.requireAttr.key}
                              onChange={(v) =>
                                setB({ requireAttr: { ...b.requireAttr!, key: v } })
                              }
                              options={attributes.map((a) => ({
                                value: a.key,
                                label: `${a.emoji ? a.emoji + " " : ""}${a.label}`,
                              }))}
                            />
                          </div>
                          <Select
                            value={b.requireAttr.op}
                            onChange={(v) =>
                              setB({ requireAttr: { ...b.requireAttr!, op: v as ">=" | "=" } })
                            }
                            className="w-16 shrink-0"
                            options={[
                              { value: ">=", label: "≥" },
                              { value: "=", label: "=" },
                            ]}
                          />
                          <Input
                            type="number"
                            value={b.requireAttr.value}
                            onChange={(e) =>
                              setB({ requireAttr: { ...b.requireAttr!, value: Number(e.target.value) } })
                            }
                            className="w-20 shrink-0"
                          />
                        </>
                      )}
                    </div>
                  </Field>
                  <Field label="Текст отказа (от лица персонажа)">
                    <Input
                      value={b.refusalText}
                      onChange={(e) => setB({ refusalText: e.target.value })}
                      placeholder="твёрдо отстраняется: слишком рано"
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
            );
          })}
        </div>

        <Btn
          variant="ghost"
          className="mt-3"
          onClick={() =>
            setForm((f) => ({
              ...f,
              boundaries: [
                ...f.boundaries,
                {
                  toolName: tools.find((t) => t.audience === "target")?.name ?? "*",
                  minRelation: 3,
                  minMood: null,
                  requirePlace: null,
                  requireAttr: null,
                  refusalText: "мягко уклоняется: слишком рано",
                  effects: [{ target: "relation", key: "relation", op: "add", value: -1 }],
                },
              ],
            }))
          }
        >
          <Plus className="h-4 w-4" /> Правило
        </Btn>
      </Card>

      <Card className="p-5">
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

        {extraKeys.length > 0 && (
          <div className="mt-4 border-t border-line pt-3">
            <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">
              Другие поля state (нет в реестре)
            </div>
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
          </div>
        )}

        <details className="mt-4">
          <summary className="cursor-pointer text-xs text-muted hover:text-fg">
            продвинутый: весь state в JSON
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
    </div>
  );
}
