"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Plus, Shirt, Trash2 } from "lucide-react";
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
import { EmojiPicker } from "@/components/EmojiPicker";
import type { AttributeDef, Character, ClothingSlot, Garment, ToolEffect } from "@/lib/types";

/** Слот в виде гардероба персонажа: что надето и какой предмет в нём. */
interface WardrobeSlotView {
  slot: string;
  worn: string | null;
  garmentId: number | null;
}

/** Вид гардероба персонажа (GET /api/characters/[id]/wardrobe). */
interface WardrobeView {
  owned: Garment[];
  slots: WardrobeSlotView[];
}

interface FormState {
  name: string;
  emoji: string;
  description: string;
  slot: string;
  price: number;
  effects: ToolEffect[];
}

const emptyForm: FormState = {
  name: "",
  emoji: "👕",
  description: "",
  slot: "",
  price: 0,
  effects: [],
};

function garmentToForm(g: Garment): FormState {
  return {
    name: g.name,
    emoji: g.emoji,
    description: g.description,
    slot: g.slot,
    price: g.price,
    effects: g.effects,
  };
}

/** Короткая запись значения эффекта: числа как есть, строки без кавычек. */
function fmtValue(v: ToolEffect["value"]): string {
  return typeof v === "string" ? v : JSON.stringify(v);
}

export default function WardrobePage() {
  const [garments, setGarments] = useState<Garment[]>([]);
  const [attributes, setAttributes] = useState<AttributeDef[]>([]);
  const [clothingSlots, setClothingSlots] = useState<ClothingSlot[]>([]);
  const [characters, setCharacters] = useState<Character[]>([]);
  // Гардеробы персонажей: id персонажа → что выдано и что надето
  const [wardrobes, setWardrobes] = useState<Record<number, WardrobeView>>({});
  const [form, setForm] = useState<FormState>(emptyForm);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  // Реф карточки формы: «Изменить» открывает форму наверху страницы — прокручиваем к ней
  const formRef = useRef<HTMLDivElement>(null);

  // Гардеробы грузим отдельными запросами (персонажей немного — это ок)
  const loadWardrobes = useCallback((chars: Character[]) => {
    for (const c of chars) {
      api<WardrobeView>(`/api/characters/${c.id}/wardrobe`)
        .then((v) => setWardrobes((w) => ({ ...w, [c.id]: v })))
        .catch(() => {});
    }
  }, []);

  const load = useCallback(() => {
    api<Garment[]>("/api/garments").then(setGarments).catch((e) => setError(e.message));
    api<AttributeDef[]>("/api/attributes").then(setAttributes).catch(() => {});
    api<ClothingSlot[]>("/api/clothing-slots").then(setClothingSlots).catch(() => {});
    api<Character[]>("/api/characters")
      .then((chars) => {
        setCharacters(chars);
        loadWardrobes(chars);
      })
      .catch(() => {});
  }, [loadWardrobes]);
  useEffect(load, [load]);

  const attrOptions = useMemo(
    () =>
      attributes.map((a) => ({
        value: a.key,
        label: `${a.emoji ? a.emoji + " " : ""}${a.label} (${a.key})`,
      })),
    [attributes]
  );

  /** Красивое имя характеристики для карточек: «😊 Настроение», а не «mood». */
const attrName = (key: string) => {
  const a = attributes.find((x) => x.key === key);
  return a ? `${a.emoji ? a.emoji + " " : ""}${a.label}` : key;
};

const startCreate = () => {
    setForm(emptyForm);
    setEditingId(null);
    setOpen(true);
  };

  const startEdit = (g: Garment) => {
    setForm(garmentToForm(g));
    setEditingId(g.id);
    setOpen(true);
    requestAnimationFrame(() =>
      formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })
    );
  };

  const save = async () => {
    setError("");
    if (!form.name.trim()) {
      setError("Название обязательно");
      return;
    }
    setSaving(true);
    try {
      if (editingId) await apiPatch(`/api/garments/${editingId}`, form);
      else await apiPost("/api/garments", form);
      setOpen(false);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (g: Garment) => {
    if (!confirm(`Удалить предмет «${g.name}»? Он исчезнет и из гардеробов персонажей.`)) return;
    setError("");
    try {
      await apiDelete(`/api/garments/${g.id}`);
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

  /** Выдать предмет персонажу: wear выдаёт в гардероб и сразу надевает. */
  const issue = async (charId: number, garmentId: number) => {
    setError("");
    try {
      const view = await apiPost<WardrobeView>(`/api/characters/${charId}/wardrobe`, {
        garmentId,
        action: "wear",
      });
      setWardrobes((w) => ({ ...w, [charId]: view }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const bySlot = useMemo(() => {
    const map = new Map<string, Garment[]>();
    for (const g of garments) {
      const key = g.slot.trim() || "без слота";
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(g);
    }
    // Группы идут в порядке реестра слотов, «без слота» — в конце
    const order = new Map<string, number>();
    clothingSlots.forEach((s, i) => order.set(s.slot, i));
    return [...map.entries()].sort(([a], [b]) => {
      const ai = order.get(a) ?? Number.MAX_SAFE_INTEGER;
      const bi = order.get(b) ?? Number.MAX_SAFE_INTEGER;
      return ai - bi || a.localeCompare(b, "ru");
    });
  }, [garments, clothingSlots]);

  /** Статус предмета у персонажа: не выдан / в шкафу / надет. */
  const ownership = (charId: number, g: Garment): "none" | "closet" | "worn" => {
    const view = wardrobes[charId];
    if (!view || !view.owned.some((og) => og.id === g.id)) return "none";
    return view.slots.some((s) => s.garmentId === g.id && s.worn) ? "worn" : "closet";
  };

  return (
    <div className="mx-auto max-w-5xl px-8 py-10">
      <PageHeader
        title="Гардероб"
        subtitle="Предметы одежды: цена для магазина, слот, эффекты на самочувствие пока надето. Выдавайте предметы персонажам — в своей карточке они выбирают, что надеть, а что убрать в шкаф; агенты переодеваются тулом wear_garment."
        actions={
          <>
            <Badge color="accent">каталог одежды мира</Badge>
            <Btn variant="primary" onClick={startCreate}>
              <Plus className="h-4 w-4" /> Предмет
            </Btn>
          </>
        }
      />
      <ErrorText>{error}</ErrorText>

      {open && (
        <div ref={formRef}>
        <Card className="mb-6 p-5">
          <div className="mb-4 text-sm font-medium">
            {editingId ? `Редактирование: ${form.name}` : "Новый предмет"}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Название" hint="как предмет ищут агенты; буквы, цифры, пробел и дефис">
              <Input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="Джинсы"
              />
            </Field>
            <Field label="Эмодзи">
              <div className="w-36">
                <EmojiPicker value={form.emoji} onChange={(v) => setForm({ ...form, emoji: v })} />
              </div>
            </Field>
            <Field
              label="Слот одежды"
              hint="куда предмет надевается; порядок слоёв задаётся в реестре слотов"
            >
              {clothingSlots.length > 0 ? (
                <Select
                  value={form.slot}
                  onChange={(v) => setForm({ ...form, slot: v })}
                  options={[
                    { value: "", label: "— без слота (нельзя надеть) —" },
                    ...clothingSlots.map((s) => ({ value: s.slot, label: s.slot })),
                  ]}
                />
              ) : (
                <p className="text-xs leading-relaxed text-warn">
                  Сначала создайте слоты в «Характеристиках».
                </p>
              )}
            </Field>
            <Field label="Цена, $" hint="0 = не продаётся (предмет только выдаётся через гардероб)">
              <Input
                type="number"
                min={0}
                value={form.price}
                onChange={(e) => setForm({ ...form, price: Number(e.target.value) })}
              />
            </Field>
            <Field
              label="Описание"
              className="sm:col-span-2"
              hint="что это за вещь и зачем её носить — это видит модель"
            >
              <Textarea
                rows={2}
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                placeholder="Классические тёмные джинсы, подходят к чему угодно."
              />
            </Field>
          </div>

          <div className="mt-4">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-medium uppercase tracking-wide text-muted">
                Эффекты ношения (необязательно)
              </span>
              <Btn
                variant="ghost"
                className="h-7 px-2 text-xs"
                onClick={() =>
                  setForm((f) => ({
                    ...f,
                    effects: [
                      ...f.effects,
                      { target: "self", key: attributes[0]?.key ?? "mood", op: "add", value: 1 },
                    ],
                  }))
                }
              >
                <Plus className="h-3 w-3" /> эффект
              </Btn>
            </div>
            {form.effects.length === 0 && (
              <p className="text-xs text-muted/70">
                Действуют, пока предмет надет: при надевании прибавляются, при снятии — убираются
                обратно. Имеют смысл численные прибавки себе (mood +1, comfort +2).
              </p>
            )}
            {form.effects.map((e, i) => (
              <div key={i} className="mb-2 flex flex-wrap items-center gap-2">
                <div className="min-w-44 flex-1">
                  <Select
                    value={e.key}
                    onChange={(v) => setEffect(i, { key: v })}
                    options={
                      attrOptions.some((o) => o.value === e.key)
                        ? attrOptions
                        : [{ value: e.key, label: `${e.key} (нет в реестре)` }, ...attrOptions]
                    }
                  />
                </div>
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
                    placeholder="±1"
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

          <div className="mt-5 flex gap-2">
            <Btn variant="primary" onClick={save} loading={saving}>
              {editingId ? "Сохранить" : "Создать"}
            </Btn>
            <Btn variant="ghost" onClick={() => setOpen(false)}>
              Отмена
            </Btn>
          </div>
        </Card>
        </div>
      )}

      {clothingSlots.length === 0 && (
        <p className="mb-4 text-xs text-warn">Слоты одежды не заданы.</p>
      )}

      {garments.length === 0 ? (
        <EmptyState
          icon={<Shirt className="h-8 w-8" />}
          title="Каталог пуст — создайте первый предмет"
          hint="Название, слот и цена — и предмет появится в гардеробе. Его можно выдать персонажу здесь или продавать в магазине; надевание меняет характеристики носителя."
        />
      ) : (
        bySlot.map(([slot, items]) => (
          <div key={slot} className="mb-6">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
              слот: {slot}
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {items.map((g) => (
                <Card key={g.id} className="p-4 transition-colors hover:border-accent/40">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xl leading-none">{g.emoji}</span>
                        <span className="font-medium">{g.name}</span>
                        {g.price > 0 ? (
                          <Badge color="warn">${g.price}</Badge>
                        ) : (
                          <Badge>не продаётся</Badge>
                        )}
                      </div>
                      <p className="mt-2 line-clamp-3 text-xs leading-relaxed text-muted">
                        {g.description || "без описания"}
                      </p>
                      {g.effects.length > 0 && (
                        <div className="mt-2 border-t border-line pt-2 text-xs text-muted">
                          {g.effects
                            .map((e) => `${attrName(e.key)} ${e.op === "add" ? "+" : "="} ${fmtValue(e.value)}`)
                            .join("; ")}
                        </div>
                      )}
                      {/* Выдача персонажам: чип кликается, пока предмет не выдан */}
                      <div className="mt-3 border-t border-line pt-2">
                        <div className="mb-1.5 text-[11px] uppercase tracking-wide text-muted/70">
                          Выдать персонажам
                        </div>
                        {characters.length === 0 ? (
                          <p className="text-xs text-muted/70">Нет персонажей</p>
                        ) : g.slot.trim() === "" ? (
                          <p className="text-xs text-muted/70">
                            Без слота — выдать нельзя: нечего надевать.
                          </p>
                        ) : (
                          <div className="flex flex-wrap gap-1.5">
                            {characters.map((c) => {
                              const st = ownership(c.id, g);
                              if (st === "none") {
                                return (
                                  <button
                                    key={c.id}
                                    type="button"
                                    title={`Выдать «${g.name}» и надеть на ${c.name}`}
                                    onClick={() => issue(c.id, g.id)}
                                    className="flex cursor-pointer items-center gap-1.5 rounded-full border border-line bg-panel-2/50 px-3 py-1 text-xs text-muted transition-colors hover:border-accent/50 hover:text-fg"
                                  >
                                    <span>{c.emoji}</span> {c.name} <span className="text-muted/60">—</span>
                                  </button>
                                );
                              }
                              const wornSlot = wardrobes[c.id]?.slots.find(
                                (s) => s.garmentId === g.id && s.worn
                              );
                              return (
                                <span
                                  key={c.id}
                                  title={
                                    st === "worn"
                                      ? `Надет (слот ${wornSlot?.slot ?? g.slot})`
                                      : "Лежит в шкафу персонажа"
                                  }
                                  className={`flex cursor-default items-center gap-1.5 rounded-full border px-3 py-1 text-xs ${
                                    st === "worn"
                                      ? "border-ok/40 bg-ok/10 text-ok"
                                      : "border-accent/40 bg-accent/15 text-accent"
                                  }`}
                                >
                                  <span>{c.emoji}</span> {c.name}{" "}
                                  <span>{st === "worn" ? "надето" : "в шкафу"}</span>
                                </span>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="flex shrink-0 gap-1">
                      <IconBtn label="Редактировать" onClick={() => startEdit(g)}>
                        ✎
                      </IconBtn>
                      <IconBtn variant="danger" label="Удалить" onClick={() => remove(g)}>
                        <Trash2 className="h-[18px] w-[18px]" />
                      </IconBtn>
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          </div>
        ))
      )}
    </div>
  );
}
