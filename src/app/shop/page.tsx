"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Plus, ShoppingCart, Trash2 } from "lucide-react";
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
import { Combobox } from "@/components/Combobox";
import { api, apiDelete, apiPatch, apiPost } from "@/components/api";
import { EmojiPicker } from "@/components/EmojiPicker";
import type { AttributeDef, ClothingSlot, ShopProduct, ToolEffect } from "@/lib/types";

interface FormState {
  name: string;
  emoji: string;
  price: number;
  category: string;
  description: string;
  delayScenes: number;
  slot: string;
  effects: ToolEffect[];
}

const emptyForm: FormState = {
  name: "",
  emoji: "🛍️",
  price: 0,
  category: "",
  description: "",
  delayScenes: 0,
  slot: "",
  effects: [],
};

function productToForm(p: ShopProduct): FormState {
  return {
    name: p.name,
    emoji: p.emoji,
    price: p.price,
    category: p.category,
    description: p.description,
    delayScenes: p.delayScenes ?? 0,
    slot: p.slot ?? "",
    effects: p.effects,
  };
}

export default function ShopPage() {
  const [products, setProducts] = useState<ShopProduct[]>([]);
  const [attributes, setAttributes] = useState<AttributeDef[]>([]);
  const [clothingSlots, setClothingSlots] = useState<ClothingSlot[]>([]);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  // Реф карточки формы: «Изменить» открывает форму наверху страницы — прокручиваем к ней
  const formRef = useRef<HTMLDivElement>(null);

  const load = useCallback(() => {
    api<ShopProduct[]>("/api/products").then(setProducts).catch((e) => setError(e.message));
    api<AttributeDef[]>("/api/attributes").then(setAttributes).catch(() => {});
    api<ClothingSlot[]>("/api/clothing-slots").then(setClothingSlots).catch(() => {});
  }, []);
  useEffect(load, [load]);

  const attrOptions = useMemo(() => {
    const opts = attributes.map((a) => ({
      value: a.key,
      label: `${a.emoji ? a.emoji + " " : ""}${a.label} (${a.key})`,
    }));
    return opts;
  }, [attributes]);

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

  const startEdit = (p: ShopProduct) => {
    setForm(productToForm(p));
    setEditingId(p.id);
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
      if (editingId) await apiPatch(`/api/products/${editingId}`, form);
      else await apiPost("/api/products", form);
      setOpen(false);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (p: ShopProduct) => {
    if (!confirm(`Удалить товар «${p.name}»?`)) return;
    setError("");
    try {
      await apiDelete(`/api/products/${p.id}`);
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

  const byCategory = useMemo(() => {
    const map = new Map<string, ShopProduct[]>();
    for (const p of products) {
      const key = p.category || "без категории";
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(p);
    }
    return [...map.entries()];
  }, [products]);

  // Подсказки категории: уже существующие на витрине (свободный ввод сохранён)
  const categoryOptions = useMemo(
    () =>
      [...new Set(products.map((p) => p.category).filter(Boolean))].sort((a, b) =>
        a.localeCompare(b, "ru")
      ),
    [products]
  );

  return (
    <div className="mx-auto max-w-5xl px-8 py-10">
      <PageHeader
        title="Магазин"
        subtitle="Товары с ценами — простые карточки, не инструменты. Агенты видят ассортимент через shop_browse и покупают через shop_buy; деньги списываются, эффекты применяются."
        actions={
          <Btn variant="primary" onClick={startCreate}>
            <Plus className="h-4 w-4" /> Товар
          </Btn>
        }
      />
      <ErrorText>{error}</ErrorText>

      {open && (
        <div ref={formRef}>
        <Card className="mb-6 p-5">
          <div className="mb-4 text-sm font-medium">
            {editingId ? `Редактирование: ${form.name}` : "Новый товар"}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Название">
              <Input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="Букет пионов"
              />
            </Field>
            <Field label="Цена, $">
              <Input
                type="number"
                min={0}
                value={form.price}
                onChange={(e) => setForm({ ...form, price: Number(e.target.value) })}
              />
            </Field>
            <Field label="Эмодзи">
              <div className="w-36">
                <EmojiPicker value={form.emoji} onChange={(v) => setForm({ ...form, emoji: v })} />
              </div>
            </Field>
            <Field
              label="Категория"
              hint="группа на витрине: подарки, спорт, внешность… Существующие подсказаны"
            >
              <Combobox
                value={form.category}
                onChange={(v) => setForm({ ...form, category: v })}
                options={categoryOptions}
                placeholder="подарки"
              />
            </Field>
            <Field label="Описание" className="sm:col-span-2" hint="что товар делает и зачем он агенту — это видит модель">
              <Textarea
                rows={2}
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                placeholder="Цветы, которые любит получатель. Поднимает настроение тому, кому вручён."
              />
            </Field>
            <Field
              label="Применится через N сцен"
              hint="0 = сразу (помада). N = деньги списываются сейчас, а эффект наступит после N переходов между сценами сценария — и только если агент до них дойдёт (операция, курс тренировок)."
            >
              <Input
                type="number"
                min={0}
                max={50}
                value={form.delayScenes}
                onChange={(e) => setForm({ ...form, delayScenes: Number(e.target.value) })}
              />
            </Field>
            {clothingSlots.length > 0 && (
              <Field
                label="Слот одежды (необязательно)"
                hint="товар-одежда сразу надевается на владельца (получателя подарка): worn_<слот> = название"
              >
                <Select
                  value={form.slot}
                  onChange={(v) => setForm({ ...form, slot: v })}
                  options={[
                    { value: "", label: "— не одежда —" },
                    ...clothingSlots.map((s) => ({ value: s.slot, label: s.slot })),
                  ]}
                />
              </Field>
            )}
          </div>

          <div className="mt-4">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-medium uppercase tracking-wide text-muted">
                Эффекты покупки (необязательно)
              </span>
              <Btn
                variant="ghost"
                className="h-7 px-2 text-xs"
                onClick={() =>
                  setForm((f) => ({
                    ...f,
                    effects: [...f.effects, { target: "self", key: attributes[0]?.key ?? "mood", op: "add", value: 1 }],
                  }))
                }
              >
                <Plus className="h-3 w-3" /> эффект
              </Btn>
            </div>
            {form.effects.length === 0 && (
              <p className="text-xs text-muted/70">
                Пример: цветы → получателю mood +1; спортзал → себе fitness +1. Атрибуты берутся
                из реестра характеристик.
              </p>
            )}
            {form.effects.map((e, i) => (
              <div key={i} className="mb-2 flex flex-wrap items-center gap-2">
                <Select
                  value={e.target}
                  onChange={(v) =>
                    setEffect(i, {
                      target: v as ToolEffect["target"],
                      key: v === "relation" ? "relation" : e.key || "mood",
                    })
                  }
                  className="min-w-44 flex-1"
                  options={[
                    { value: "self", label: "покупателю" },
                    { value: "tool_target", label: "получателю подарка" },
                    { value: "relation", label: "отношение получателя к дарителю" },
                  ]}
                />
                {e.target !== "relation" && (
                  <div className="min-w-44 flex-1">
                    <Select
                      value={e.key}
                      onChange={(v) => setEffect(i, { key: v })}
                      options={attrOptions.some((o) => o.value === e.key) ? attrOptions : [{ value: e.key, label: `${e.key} (нет в реестре)` }, ...attrOptions]}
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
              Сохранить
            </Btn>
            <Btn variant="ghost" onClick={() => setOpen(false)}>
              Отмена
            </Btn>
          </div>
        </Card>
        </div>
      )}

      {products.length === 0 ? (
        <EmptyState
          icon={<ShoppingCart className="h-8 w-8" />}
          title="Товаров нет"
          hint="Добавьте товары: название, цена, описание — и они появятся на витрине агентов (shop_browse). Эффекты меняют характеристики покупателей и получателей подарков."
        />
      ) : (
        byCategory.map(([cat, items]) => (
          <div key={cat} className="mb-6">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">{cat}</div>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {items.map((p) => (
                <Card key={p.id} className="p-4 transition-colors hover:border-accent/40">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xl leading-none">{p.emoji}</span>
                        <span className="font-medium">{p.name}</span>
                        <Badge color="warn">${p.price}</Badge>
                        {p.delayScenes > 0 && (
                          <Badge color="accent" >через {p.delayScenes} сцен</Badge>
                        )}
                      </div>
                      <p className="mt-2 line-clamp-3 text-xs leading-relaxed text-muted">
                        {p.description || "без описания"}
                      </p>
                      {p.effects.length > 0 && (
                        <div className="mt-2 border-t border-line pt-2 text-xs text-muted">
                          {p.effects
                            .map(
                              (e) =>
                                `${
                                  e.target === "self"
                                    ? "покупателю"
                                    : e.target === "relation"
                                      ? "отношение получателя"
                                      : "получателю"
                                }.${attrName(e.key)} ${
                                  e.op === "add" ? "+=" : "="
                                } ${JSON.stringify(e.value)}`
                            )
                            .join("; ")}
                        </div>
                      )}
                      {p.slot && (
                        <div className="mt-1 text-xs text-muted">
                          👕 надевается в слот <span className="font-mono">{p.slot}</span>
                        </div>
                      )}
                    </div>
                    <div className="flex shrink-0 gap-1">
                      <IconBtn label="Редактировать" onClick={() => startEdit(p)}>
                        ✎
                      </IconBtn>
                      <IconBtn variant="danger" label="Удалить" onClick={() => remove(p)}>
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
