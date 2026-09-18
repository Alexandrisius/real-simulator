"use client";

import { useCallback, useEffect, useState } from "react";
import { Pencil, Plus, Trash2, Zap } from "lucide-react";
import {
  Badge,
  Btn,
  Card,
  EmptyState,
  ErrorText,
  Field,
  IconBtn,
  Input,
  OkText,
  PageHeader,
} from "@/components/ui";
import { api, apiDelete, apiPatch, apiPost } from "@/components/api";
import { EmojiPicker } from "@/components/EmojiPicker";
import type { Skill, Tool } from "@/lib/types";

interface FormState {
  key: string;
  label: string;
  emoji: string;
  maxLevel: number;
  practicePerLevel: number;
  grows: boolean;
}

const emptyForm: FormState = {
  key: "",
  label: "",
  emoji: "💋",
  maxLevel: 5,
  practicePerLevel: 10,
  grows: true,
};

export default function SkillsPage() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [tools, setTools] = useState<Tool[]>([]);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");

  const load = useCallback(() => {
    api<Skill[]>("/api/skills").then(setSkills).catch((e) => setError(e.message));
    api<Tool[]>("/api/tools").then(setTools).catch(() => {});
  }, []);
  useEffect(load, [load]);

  const startEdit = (s: Skill) => {
    setForm({
      key: s.key,
      label: s.label,
      emoji: s.emoji || "🎓",
      maxLevel: s.maxLevel,
      practicePerLevel: s.practicePerLevel,
      grows: s.grows,
    });
    setEditingKey(s.key);
    setOk("");
    setError("");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const save = async () => {
    setError("");
    setOk("");
    if (!form.key.trim() || !form.label.trim()) {
      setError("Ключ и название обязательны");
      return;
    }
    setSaving(true);
    try {
      if (editingKey) {
        await apiPatch(`/api/skills/${editingKey}`, {
          label: form.label,
          emoji: form.emoji,
          maxLevel: form.maxLevel,
          practicePerLevel: form.practicePerLevel,
          grows: form.grows,
        });
      } else {
        await apiPost("/api/skills", { ...form, key: form.key.trim() });
      }
      setOk(
        editingKey
          ? "Навык обновлён — скрытая характеристика синхронизирована."
          : `Навык создан: уровень лежит в скрытой характеристике skill_${form.key.trim()} — создавать её вручную не нужно.`
      );
      setForm(emptyForm);
      setEditingKey(null);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (s: Skill) => {
    if (
      !confirm(
        `Удалить навык «${s.label}»? Вместе с ним уйдут счётчики практики, связанная скрытая характеристика ${s.attributeKey} и привязка тулов к нему.`
      )
    )
      return;
    setError("");
    try {
      await apiDelete(`/api/skills/${s.key}`);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="mx-auto max-w-5xl px-8 py-10">
      <PageHeader
        title="Навыки"
        subtitle="То, что персонажи умеют: уровень растёт практикой (успешные применения тулов) или товарами-курсами. Уровень — скрытая характеристика: партнёр видит только последствия, никогда не число."
        actions={
          <Btn
            variant="primary"
            onClick={() => {
              setForm(emptyForm);
              setEditingKey(null);
            }}
          >
            <Plus className="h-4 w-4" /> Создать
          </Btn>
        }
      />
      <ErrorText>{error}</ErrorText>
      <OkText>{ok}</OkText>

      <Card className="mb-6 p-5">
        <div className="mb-4 text-sm font-medium">
          {editingKey ? `Редактирование: ${editingKey}` : "Новый навык"}
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Ключ" hint="латиница a-z, 0-9, _ — уровень будет жить в state по ключу skill_<ключ>">
            <Input
              value={form.key}
              onChange={(e) => setForm({ ...form, key: e.target.value })}
              placeholder="kiss"
              className="font-mono"
              disabled={editingKey != null}
            />
          </Field>
          <Field label="Название">
            <Input
              value={form.label}
              onChange={(e) => setForm({ ...form, label: e.target.value })}
              placeholder="Поцелуи"
            />
          </Field>
          <Field label="Эмодзи">
            <div className="w-36">
              <EmojiPicker value={form.emoji} onChange={(v) => setForm({ ...form, emoji: v })} />
            </div>
          </Field>
          <Field label="Максимальный уровень">
            <Input
              type="number"
              min={1}
              max={20}
              value={form.maxLevel}
              onChange={(e) => setForm({ ...form, maxLevel: Number(e.target.value) })}
              className="max-w-[7.5rem]"
            />
          </Field>
        </div>

        <label className="mt-4 flex cursor-pointer items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={form.grows}
            onChange={(e) => setForm({ ...form, grows: e.target.checked })}
            className="h-4 w-4 accent-accent"
          />
          <span>Может развиваться практикой</span>
        </label>
        <p className="mt-1.5 text-xs leading-relaxed text-muted/80">
          По галочке система сама создаёт скрытую характеристику {form.key.trim() ? (
            <code className="rounded bg-black/40 px-1">skill_{form.key.trim()}</code>
          ) : (
            <code className="rounded bg-black/40 px-1">skill_&lt;ключ&gt;</code>
          )}{" "}
          (0…{form.maxLevel}) — вручную ничего создавать не нужно. Тулы с включённым
          «тренирует навык» качают уровень успешными применениями.
        </p>

        {form.grows && (
          <div className="mt-3">
            <Field label="Применений на уровень" hint="сколько успешных (ok) применений тула дают +1 уровень">
              <Input
                type="number"
                min={1}
                max={1000}
                value={form.practicePerLevel}
                onChange={(e) => setForm({ ...form, practicePerLevel: Number(e.target.value) })}
                className="max-w-[7.5rem]"
              />
            </Field>
          </div>
        )}

        <div className="mt-5 flex gap-2">
          <Btn variant="primary" onClick={save} loading={saving}>
            Сохранить
          </Btn>
          {editingKey && (
            <Btn
              variant="ghost"
              onClick={() => {
                setForm(emptyForm);
                setEditingKey(null);
              }}
            >
              Отмена
            </Btn>
          )}
        </div>
      </Card>

      {skills.length === 0 ? (
        <EmptyState
          icon={<Zap className="h-8 w-8" />}
          title="Навыков нет"
          hint="Создайте навык (поцелуи, секс, готовка…) и привяжите к туле поле «тренирует навык»."
        />
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          {skills.map((s) => {
            const trainers = tools.filter((t) => t.trainsSkill === s.key);
            return (
              <Card key={s.key} className="p-4 transition-colors hover:border-accent/40">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">
                        {s.emoji} {s.label}
                      </span>
                      <Badge color="accent">0…{s.maxLevel}</Badge>
                      {s.grows ? (
                        <Badge color="ok">растёт практикой</Badge>
                      ) : (
                        <Badge>без роста</Badge>
                      )}
                    </div>
                    <div className="mt-0.5 font-mono text-xs text-accent/80">
                      {s.key} → {s.attributeKey}
                    </div>
                    {s.grows && (
                      <div className="mt-2 text-xs text-muted">
                        каждые {s.practicePerLevel} успешных применений → +1 уровень
                      </div>
                    )}
                    <div className="mt-1.5 text-xs text-muted">
                      {trainers.length > 0
                        ? `тренируют: ${trainers.map((t) => t.title || t.name).join(", ")}`
                        : "ни один тул пока не тренирует"}
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-1.5">
                    <IconBtn label="Редактировать" onClick={() => startEdit(s)}>
                      <Pencil className="h-[18px] w-[18px]" />
                    </IconBtn>
                    <IconBtn variant="danger" label="Удалить навык" onClick={() => remove(s)}>
                      <Trash2 className="h-[18px] w-[18px]" />
                    </IconBtn>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
