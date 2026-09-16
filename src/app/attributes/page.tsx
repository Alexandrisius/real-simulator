"use client";

import { useCallback, useEffect, useState } from "react";
import { Plus, Shirt, SlidersHorizontal, Trash2,
  MapPin,
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
  Select,
} from "@/components/ui";
import { api, apiDelete, apiPatch, apiPost } from "@/components/api";
import type { AttributeDef, ClothingSlot, Place } from "@/lib/types";

interface FormState {
  key: string;
  label: string;
  emoji: string;
  type: "number" | "select" | "text";
  unit: string;
  min: string;
  max: string;
  options: string;
  position: number;
  visibility: "public" | "hidden";
  liePenalty: number;
  coveredBy: string[];
}

const emptyForm: FormState = {
  key: "",
  label: "",
  emoji: "",
  type: "number",
  unit: "",
  min: "",
  max: "",
  options: "",
  position: 100,
  visibility: "public",
  liePenalty: 2,
  coveredBy: [],
};

function attrToForm(a: AttributeDef): FormState {
  return {
    key: a.key,
    label: a.label,
    emoji: a.emoji,
    type: a.type,
    unit: a.unit,
    min: a.min != null ? String(a.min) : "",
    max: a.max != null ? String(a.max) : "",
    options: a.options.join(", "),
    position: a.position,
    visibility: a.visibility,
    liePenalty: a.liePenalty,
    coveredBy: a.coveredBy,
  };
}

interface SlotFormState {
  slot: string;
  layer: number;
  undressPlaces: string;
  position: number;
}

const emptySlotForm: SlotFormState = { slot: "", layer: 1, undressPlaces: "", position: 10 };

export default function AttributesPage() {
  const [attrs, setAttrs] = useState<AttributeDef[]>([]);
  const [slots, setSlots] = useState<ClothingSlot[]>([]);
  const [places, setPlaces] = useState<Place[]>([]);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const [slotForm, setSlotForm] = useState<SlotFormState>(emptySlotForm);
  const [slotEditing, setSlotEditing] = useState<string | null>(null);
  const [slotOpen, setSlotOpen] = useState(false);
  const [slotSaving, setSlotSaving] = useState(false);

  const load = useCallback(() => {
    api<AttributeDef[]>("/api/attributes").then(setAttrs).catch((e) => setError(e.message));
    api<ClothingSlot[]>("/api/clothing-slots").then(setSlots).catch(() => setSlots([]));
    api<Place[]>("/api/places").then(setPlaces).catch(() => {});
  }, []);
  useEffect(load, [load]);

  const startCreate = () => {
    setForm(emptyForm);
    setEditingId(null);
    setOpen(true);
  };

  const startEdit = (a: AttributeDef) => {
    setForm(attrToForm(a));
    setEditingId(a.id);
    setOpen(true);
  };

  const save = async () => {
    setError("");
    const body = {
      key: form.key.trim(),
      label: form.label.trim(),
      emoji: form.emoji,
      type: form.type,
      unit: form.unit,
      min: form.min === "" ? null : Number(form.min),
      max: form.max === "" ? null : Number(form.max),
      options:
        form.type === "select"
          ? form.options.split(",").map((s) => s.trim()).filter(Boolean)
          : [],
      position: form.position,
      visibility: form.visibility,
      liePenalty: form.liePenalty,
      coveredBy: form.coveredBy.filter((s) => slots.some((cs) => cs.slot === s)),
    };
    if (!body.key || !body.label) {
      setError("Ключ и название обязательны");
      return;
    }
    setSaving(true);
    try {
      if (editingId) await apiPatch(`/api/attributes/${editingId}`, body);
      else await apiPost("/api/attributes", body);
      setOpen(false);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (a: AttributeDef) => {
    if (
      !confirm(
        `Удалить характеристику «${a.label}»? Значения у персонажей останутся в state, но исчезнут из форм.`
      )
    )
      return;
    setError("");
    try {
      await apiDelete(`/api/attributes/${a.id}`);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const saveSlot = async () => {
    setError("");
    const body = {
      slot: slotForm.slot.trim(),
      layer: slotForm.layer,
      undressPlaces: slotForm.undressPlaces.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
      position: slotForm.position,
    };
    if (!body.slot) {
      setError("Имя слота обязательно");
      return;
    }
    setSlotSaving(true);
    try {
      if (slotEditing) await apiPatch(`/api/clothing-slots/${slotEditing}`, body);
      else await apiPost("/api/clothing-slots", body);
      setSlotOpen(false);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSlotSaving(false);
    }
  };

  const removeSlot = async (s: ClothingSlot) => {
    if (!confirm(`Удалить слот «${s.slot}»? Надетые предметы останутся в state персонажей (worn_${s.slot}).`))
      return;
    setError("");
    try {
      await apiDelete(`/api/clothing-slots/${s.slot}`);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const [placeForm, setPlaceForm] = useState({ name: "", description: "" });
  const savePlace = async () => {
    setError("");
    if (!placeForm.name.trim()) {
      setError("Название места обязательно");
      return;
    }
    try {
      await apiPost("/api/places", {
        name: placeForm.name.trim(),
        description: placeForm.description.trim(),
        position: places.length + 1,
      });
      setPlaceForm({ name: "", description: "" });
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const removePlace = async (name: string) => {
    if (!confirm(`Удалить место «${name}»?`)) return;
    setError("");
    try {
      await apiDelete(`/api/places/${encodeURIComponent(name)}`);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="mx-auto max-w-4xl px-8 py-10">
      <PageHeader
        title="Характеристики"
        subtitle="Реестр полей персонажей: рост, вес, физподготовка, красота… Значения задаются в редакторе персонажа и меняются инструментами и товарами магазина (по ключу). Публичные видны окружающим в промпте, скрытые — только владелец (и те, кому он рассказал или показал)."
        actions={
          <Btn variant="primary" onClick={startCreate}>
            <Plus className="h-4 w-4" /> Характеристика
          </Btn>
        }
      />
      <ErrorText>{error}</ErrorText>

      {open && (
        <Card className="mb-6 p-5">
          <div className="mb-4 text-sm font-medium">
            {editingId ? `Редактирование: ${form.label}` : "Новая характеристика"}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Ключ" hint="техническое имя: латиница, строчными — по нему меняют state эффекты">
              <Input
                value={form.key}
                onChange={(e) => setForm({ ...form, key: e.target.value })}
                placeholder="charisma"
                className="font-mono"
                disabled={editingId != null}
              />
            </Field>
            <Field label="Название">
              <Input
                value={form.label}
                onChange={(e) => setForm({ ...form, label: e.target.value })}
                placeholder="Харизма"
              />
            </Field>
            <Field label="Эмодзи">
              <Input
                value={form.emoji}
                onChange={(e) => setForm({ ...form, emoji: e.target.value })}
                className="w-20 text-center text-lg"
              />
            </Field>
            <Field label="Тип">
              <Select
                value={form.type}
                onChange={(v) => setForm({ ...form, type: v as FormState["type"] })}
                options={[
                  { value: "number", label: "Число" },
                  { value: "select", label: "Выбор из вариантов" },
                  { value: "text", label: "Текст" },
                ]}
              />
            </Field>
            <Field label="Единица / подсказка">
              <Input
                value={form.unit}
                onChange={(e) => setForm({ ...form, unit: e.target.value })}
                placeholder="см / кг / ур. 0–10"
              />
            </Field>
            <Field label="Порядок в формах">
              <Input
                type="number"
                min={0}
                value={form.position}
                onChange={(e) => setForm({ ...form, position: Number(e.target.value) })}
              />
            </Field>
            <Field label="Видимость" hint="скрытая не показывается окружающим в промпте — о ней можно заявить (reveal) или обнажиться">
              <Select
                value={form.visibility}
                onChange={(v) => setForm({ ...form, visibility: v as FormState["visibility"] })}
                options={[
                  { value: "public", label: "Публичная — видно окружающим" },
                  { value: "hidden", label: "Скрытая — только владелец" },
                ]}
              />
            </Field>
            <Field label="Штраф за разоблачённую ложь" hint="сколько упадёт отношение наблюдателя, если заявление не совпало с истиной">
              <Input
                type="number"
                min={0}
                max={100}
                value={form.liePenalty}
                onChange={(e) => setForm({ ...form, liePenalty: Number(e.target.value) })}
              />
            </Field>
            {form.type === "number" && (
              <>
                <Field label="Минимум (необязательно)">
                  <Input
                    type="number"
                    value={form.min}
                    onChange={(e) => setForm({ ...form, min: e.target.value })}
                  />
                </Field>
                <Field label="Максимум (необязательно)">
                  <Input
                    type="number"
                    value={form.max}
                    onChange={(e) => setForm({ ...form, max: e.target.value })}
                  />
                </Field>
              </>
            )}
            {form.type === "select" && (
              <Field
                label="Варианты через запятую"
                className="sm:col-span-2"
                hint="напр.: худой, стройный, спортивный, плотный"
              >
                <Input
                  value={form.options}
                  onChange={(e) => setForm({ ...form, options: e.target.value })}
                />
              </Field>
            )}
            {slots.length > 0 && form.visibility === "hidden" && (
              <Field
                label="Прикрыта одеждой (слоты)"
                className="sm:col-span-2"
                hint="пока все прикрыывающие слоты надеты — окружающие не видят характеристику; обнажение верифицирует её"
              >
                <div className="flex flex-wrap gap-3">
                  {slots.map((s) => (
                    <label key={s.slot} className="flex cursor-pointer items-center gap-1.5 text-sm">
                      <input
                        type="checkbox"
                        checked={form.coveredBy.includes(s.slot)}
                        onChange={(e) =>
                          setForm({
                            ...form,
                            coveredBy: e.target.checked
                              ? [...form.coveredBy, s.slot]
                              : form.coveredBy.filter((x) => x !== s.slot),
                          })
                        }
                        className="h-4 w-4 accent-[var(--color-accent)]"
                      />
                      <span className="text-muted">{s.slot}</span>
                    </label>
                  ))}
                </div>
              </Field>
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
      )}

      {attrs.length === 0 ? (
        <EmptyState
          icon={<SlidersHorizontal className="h-8 w-8" />}
          title="Характеристик нет"
          hint="Добавьте поля персонажей: рост, вес, физподготовка, красота — они появятся в редакторе персонажа, а инструменты и товары смогут их менять."
        />
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          {attrs.map((a) => (
            <Card key={a.id} className="flex items-center gap-3 p-4">
              <span className="text-xl leading-none">{a.emoji || "•"}</span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{a.label}</span>
                  <Badge>{a.key}</Badge>
                  {a.visibility === "hidden" ? (
                    <Badge color="warn">скрытая</Badge>
                  ) : (
                    <Badge color="ok">публичная</Badge>
                  )}
                  {a.unit && <span className="text-xs text-muted">{a.unit}</span>}
                  {a.type === "select" && a.options.length > 0 && (
                    <span className="text-xs text-muted">{a.options.join(" / ")}</span>
                  )}
                </div>
                {(a.min != null || a.max != null || a.coveredBy.length > 0 || a.visibility === "hidden") && (
                  <div className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-muted">
                    {a.min != null || a.max != null ? (
                      <span>диапазон: {a.min ?? "−∞"} … {a.max ?? "∞"}</span>
                    ) : null}
                    {a.visibility === "hidden" && <span>штраф за ложь: −{a.liePenalty}</span>}
                    {a.coveredBy.length > 0 && <span>прикрыто: {a.coveredBy.join(" + ")}</span>}
                  </div>
                )}
              </div>
              <div className="flex shrink-0 gap-1">
                <IconBtn label="Редактировать" onClick={() => startEdit(a)}>
                  ✎
                </IconBtn>
                <IconBtn variant="danger" label="Удалить" onClick={() => remove(a)}>
                  <Trash2 className="h-[18px] w-[18px]" />
                </IconBtn>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* ---- Слоты одежды ---- */}
      <div className="mt-10 flex items-center justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <Shirt className="h-5 w-5 text-accent" /> Слоты одежды
          </h2>
          <p className="mt-1 text-sm text-muted">
            Слой задаёт порядок (нижнее не снимается поверх верхнего), места — где слот можно
            обнажить (пусто = где угодно). Персонажи носят предметы в ключах worn_*, снимают
            инструментом undress, надевают — wear.
          </p>
        </div>
        <Btn
          variant="primary"
          onClick={() => {
            setSlotForm(emptySlotForm);
            setSlotEditing(null);
            setSlotOpen(true);
          }}
        >
          <Plus className="h-4 w-4" /> Слот
        </Btn>
      </div>

      {slotOpen && (
        <Card className="mt-4 p-5">
          <div className="mb-4 text-sm font-medium">
            {slotEditing ? `Редактирование слота: ${slotEditing}` : "Новый слот"}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Имя слота" hint="латиница строчными: top, bottom, underwear, dress…">
              <Input
                value={slotForm.slot}
                onChange={(e) => setSlotForm({ ...slotForm, slot: e.target.value })}
                placeholder="underwear"
                className="font-mono"
                disabled={slotEditing != null}
              />
            </Field>
            <Field label="Слой (1 = верхнее, 2 = бельё…)">
              <Input
                type="number"
                min={1}
                max={10}
                value={slotForm.layer}
                onChange={(e) => setSlotForm({ ...slotForm, layer: Number(e.target.value) })}
              />
            </Field>
            <Field
              label="Где можно снять (через запятую)"
              className="sm:col-span-2"
              hint="места сцены: дом, отель, пляж… Пусто — где угодно"
            >
              <Input
                value={slotForm.undressPlaces}
                onChange={(e) => setSlotForm({ ...slotForm, undressPlaces: e.target.value })}
                placeholder="дом, отель, пляж"
              />
            </Field>
          </div>
          <div className="mt-5 flex gap-2">
            <Btn variant="primary" onClick={saveSlot} loading={slotSaving}>
              Сохранить
            </Btn>
            <Btn variant="ghost" onClick={() => setSlotOpen(false)}>
              Отмена
            </Btn>
          </div>
        </Card>
      )}

      {slots.length > 0 && (
        <div className="mt-4 grid gap-2 sm:grid-cols-3">
          {slots.map((s) => (
            <Card key={s.slot} className="flex items-center gap-3 p-3.5">
              <Shirt className="h-4 w-4 shrink-0 text-muted" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-sm">{s.slot}</span>
                  <Badge>слой {s.layer}</Badge>
                </div>
                <div className="mt-0.5 truncate text-xs text-muted">
                  {s.undressPlaces.length === 0 ? "снять можно где угодно" : `обнажать: ${s.undressPlaces.join(", ")}`}
                </div>
              </div>
              <div className="flex shrink-0 gap-1">
                <IconBtn
                  label="Редактировать"
                  onClick={() => {
                    setSlotForm({
                      slot: s.slot,
                      layer: s.layer,
                      undressPlaces: s.undressPlaces.join(", "),
                      position: s.position,
                    });
                    setSlotEditing(s.slot);
                    setSlotOpen(true);
                  }}
                >
                  ✎
                </IconBtn>
                <IconBtn variant="danger" label="Удалить" onClick={() => removeSlot(s)}>
                  <Trash2 className="h-[18px] w-[18px]" />
                </IconBtn>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* ---- Места (реестр для go_to/invite) ---- */}
      <Card className="mt-10 mb-6 p-5">
        <div className="mb-3 flex items-center gap-2">
          <MapPin className="h-5 w-5 text-accent" /> Места
          <Badge color="accent">тулы go_to / invite у агентов</Badge>
        </div>
        <p className="mb-3 text-xs leading-relaxed text-muted">
          Локации мира: агенты могут «отправиться» в них (go_to — меняет место
          сцены, с ним сверяются границы и правила одежды) и «пригласить» туда
          другого персонажа (invite — доставляет приглашение лично).
        </p>
        <div className="mb-3 grid gap-2 sm:grid-cols-[10rem_1fr_auto]">
          <Input
            value={placeForm.name}
            onChange={(e) => setPlaceForm((f) => ({ ...f, name: e.target.value }))}
            placeholder="название (отель)"
          />
          <Input
            value={placeForm.description}
            onChange={(e) => setPlaceForm((f) => ({ ...f, description: e.target.value }))}
            placeholder="описание для агентов (необязательно)"
          />
          <Btn onClick={savePlace}>
            <Plus className="h-4 w-4" /> Добавить
          </Btn>
        </div>
        {places.length === 0 ? (
          <p className="text-xs text-muted/70">Мест пока нет — добавьте хотя бы одно.</p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {places.map((pl) => (
              <div
                key={pl.name}
                className="flex items-center gap-2 rounded-lg border border-line bg-panel-2/40 px-3 py-2"
              >
                <span className="text-sm font-medium">{pl.name}</span>
                <span className="min-w-0 flex-1 truncate text-xs text-muted">
                  {pl.description}
                </span>
                <IconBtn
                  variant="danger"
                  size="sm"
                  label={`Удалить ${pl.name}`}
                  onClick={() => removePlace(pl.name)}
                >
                  <Trash2 className="h-4 w-4" />
                </IconBtn>
              </div>
            ))}
          </div>
        )}
      </Card>

    </div>
  );
}
