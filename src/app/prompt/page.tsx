"use client";

import { useCallback, useEffect, useState } from "react";
import { Eye, FileText, RotateCcw, Save } from "lucide-react";
import {
  Badge,
  Btn,
  Card,
  ErrorText,
  Field,
  OkText,
  PageHeader,
  Select,
  Textarea,
} from "@/components/ui";
import { api, apiPatch, apiPost } from "@/components/api";
import type { Character, Scene } from "@/lib/types";

interface PromptSection {
  key: string;
  title: string;
  hint: string;
  def: string;
  current: string;
}

export default function PromptPage() {
  const [sections, setSections] = useState<PromptSection[]>([]);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");

  const [characters, setCharacters] = useState<Character[]>([]);
  const [scenes, setScenes] = useState<Scene[]>([]);
  const [pickChar, setPickChar] = useState("");
  const [pickScene, setPickScene] = useState("");
  const [preview, setPreview] = useState("");
  const [previewing, setPreviewing] = useState(false);

  const load = useCallback(() => {
    api<{ sections: PromptSection[] }>("/api/prompt-settings")
      .then((d) => {
        setSections(d.sections);
        const e: Record<string, string> = {};
        for (const s of d.sections) e[s.key] = s.current;
        setEdits(e);
      })
      .catch((e) => setError(e.message));
    api<Character[]>("/api/characters").then(setCharacters).catch(() => {});
    api<Scene[]>("/api/scenes").then(setScenes).catch(() => {});
  }, []);
  useEffect(load, [load]);

  const save = async () => {
    setSaving(true);
    setError("");
    setOk("");
    try {
      await apiPatch("/api/prompt-settings", { sections: edits });
      setOk("Сохранено — новые промпты применяются со следующего хода. Пустая секция = текст по умолчанию.");
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const showPreview = async () => {
    if (!pickChar || !pickScene) return;
    setPreviewing(true);
    setError("");
    try {
      const d = await apiPost<{ prompt: string }>("/api/prompt-preview", {
        characterId: Number(pickChar),
        sceneId: Number(pickScene),
      });
      setPreview(d.prompt);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPreviewing(false);
    }
  };

  return (
    <div className="mx-auto max-w-5xl px-8 py-10">
      <PageHeader
        title="Системный промпт"
        subtitle="Тексты, из которых собирается промпт каждого агента. Пустая секция = встроенный текст. Подстановки: {name} — имя персонажа, {request_tool}, {reveal_tool}, {undress_tool}, {wear_tool} — имена инструментов."
        actions={
          <Btn variant="primary" onClick={save} loading={saving}>
            <Save className="h-4 w-4" /> Сохранить
          </Btn>
        }
      />
      <ErrorText>{error}</ErrorText>
      <OkText>{ok}</OkText>

      <div className="grid gap-4">
        {sections.map((s) => {
          const value = edits[s.key] ?? "";
          const changed = value !== s.current;
          const custom = value.trim() !== "";
          return (
            <Card key={s.key} className={`p-4 ${custom ? "border-accent/40" : ""}`}>
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">{s.title}</span>
                {custom ? <Badge color="accent">кастомный</Badge> : <Badge>по умолчанию</Badge>}
                {changed && <Badge color="warn">не сохранено</Badge>}
                <span className="text-xs text-muted">{s.hint}</span>
                <Btn
                  variant="ghost"
                  className="ml-auto h-7 px-2 text-xs"
                  onClick={() => setEdits((e) => ({ ...e, [s.key]: "" }))}
                  title="Вернуть текст по умолчанию (секция станет пустой)"
                >
                  <RotateCcw className="h-3 w-3" /> дефолт
                </Btn>
              </div>
              <Textarea
                rows={Math.min(14, Math.max(4, (value || s.def).split("\n").length + 1))}
                value={value}
                onChange={(e) => setEdits((ed) => ({ ...ed, [s.key]: e.target.value }))}
                placeholder={s.def}
                className="font-mono text-xs"
                spellCheck={false}
              />
            </Card>
          );
        })}
      </div>

      <Card className="mt-6 p-4">
        <div className="mb-3 flex flex-wrap items-end gap-3">
          <div className="min-w-56">
            <Field label="Персонаж">
              <Select
                value={pickChar}
                onChange={setPickChar}
                options={[
                  { value: "", label: "— выберите —" },
                  ...characters.map((c) => ({ value: String(c.id), label: `${c.emoji} ${c.name}` })),
                ]}
              />
            </Field>
          </div>
          <div className="min-w-56">
            <Field label="Сцена">
              <Select
                value={pickScene}
                onChange={setPickScene}
                options={[
                  { value: "", label: "— выберите —" },
                  ...scenes.map((s) => ({ value: String(s.id), label: s.name })),
                ]}
              />
            </Field>
          </div>
          <Btn onClick={showPreview} loading={previewing} disabled={!pickChar || !pickScene}>
            <Eye className="h-4 w-4" /> Собрать промпт
          </Btn>
        </div>
        {preview && (
          <div>
            <div className="mb-2 flex items-center gap-2 text-xs text-muted">
              <FileText className="h-3.5 w-3.5" /> готовый system prompt (как увидит модель)
            </div>
            <pre className="max-h-[28rem] overflow-y-auto whitespace-pre-wrap rounded-lg border border-line bg-black/40 p-4 font-mono text-xs leading-relaxed text-fg/90">
              {preview}
            </pre>
          </div>
        )}
      </Card>
    </div>
  );
}
