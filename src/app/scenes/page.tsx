"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronUp, Clapperboard, ListChecks, Plus, Target, Trash2 } from "lucide-react";
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
  StatusBadge,
  Textarea,
} from "@/components/ui";
import { Dropdown } from "@/components/Dropdown";
import { api, apiDelete, apiPost } from "@/components/api";
import type { Character, Place, Scene, SceneConfig, ValidationSchema } from "@/lib/types";

/** Варианты места действия: только реестр мест (/api/places) плюс «не задано». */
const placeOptionsOf = (places: Place[]) => [
  { value: "", label: "— не задано —" },
  ...places.map((p) => ({ value: p.name, label: p.name })),
];

export default function ScenesPage() {
  const [scenes, setScenes] = useState<Scene[]>([]);
  const [chars, setChars] = useState<Character[]>([]);
  const [schemas, setSchemas] = useState<ValidationSchema[]>([]);
  const [places, setPlaces] = useState<Place[]>([]);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [advanced, setAdvanced] = useState(false);

  const [name, setName] = useState("");
  const [setting, setSetting] = useState("");
  const [place, setPlace] = useState("");
  const [selected, setSelected] = useState<number[]>([]);
  const [schemasBy, setSchemasBy] = useState<Record<string, number | null>>({});
  const [goalsBy, setGoalsBy] = useState<Record<string, string>>({});
  const [turnDelayMs, setTurnDelayMs] = useState(5000);
  const [maxTurns, setMaxTurns] = useState(0);
  const [maxIterPerTurn, setMaxIterPerTurn] = useState(3);
  const [contextEvents, setContextEvents] = useState(60);
  const [rulesExtra, setRulesExtra] = useState("");
  const [pauseForHumans, setPauseForHumans] = useState(false);

  const placeOptions = placeOptionsOf(places);

  const load = useCallback(() => {
    Promise.all([
      api<Scene[]>("/api/scenes"),
      api<Character[]>("/api/characters"),
      api<ValidationSchema[]>("/api/schemas"),
      api<Place[]>("/api/places"),
    ])
      .then(([s, c, v, p]) => {
        setScenes(s);
        setChars(c);
        setSchemas(v);
        setPlaces(p);
      })
      .catch((e) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  // Живые статусы: пока какая-то сцена идёт — обновляем список каждые 3с,
  // в покое — раз в 15с (статусы/ходы/расходы меняются без перезагрузки).
  useEffect(() => {
    const tick = () =>
      api<Scene[]>("/api/scenes")
        .then((s) => setScenes(s))
        .catch(() => {});
    const anyRunning = scenes.some((s) => s.status === "running");
    const t = setInterval(tick, anyRunning ? 3000 : 15000);
    return () => clearInterval(t);
  }, [scenes]);

  const toggle = (id: number) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  const move = (i: number, dir: -1 | 1) =>
    setSelected((s) => {
      const j = i + dir;
      if (j < 0 || j >= s.length) return s;
      const copy = [...s];
      [copy[i], copy[j]] = [copy[j], copy[i]];
      return copy;
    });

  const create = async () => {
    setError("");
    if (!name.trim()) return setError("Дайте сцене название");
    if (selected.length === 0) return setError("Выберите хотя бы одного персонажа");
    setSaving(true);
    const config: Partial<SceneConfig> = {
      turnDelayMs,
      maxTurns,
      maxIterPerTurn,
      contextEvents,
      rulesExtra,
      pauseForHumans,
      place,
    };
    try {
      const s = await apiPost<Scene>("/api/scenes", {
        name,
        setting,
        config,
        characterIds: selected,
        schemas: Object.fromEntries(
          Object.entries(schemasBy).filter(([k]) => selected.includes(Number(k)))
        ),
        goals: Object.fromEntries(
          Object.entries(goalsBy).filter(([k]) => selected.includes(Number(k)))
        ),
      });
      location.href = `/scenes/${s.id}`;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  };

  const remove = async (s: Scene) => {
    if (!confirm(`Удалить сцену «${s.name}» вместе со всей историей?`)) return;
    setError("");
    try {
      await apiDelete(`/api/scenes/${s.id}`);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="mx-auto max-w-5xl px-8 py-10">
      <PageHeader
        title="Сцены"
        subtitle="Соберите состав участников и запустите симуляцию: персонажи будут ходить по очереди, общаться и действовать."
        actions={
          <Btn variant="primary" onClick={() => setCreating((v) => !v)}>
            <Plus className="h-4 w-4" /> {creating ? "Свернуть" : "Новая сцена"}
          </Btn>
        }
      />
      <ErrorText>{error}</ErrorText>

      {creating && (
        <Card className="mb-6 p-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Название">
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Вечер пятницы" />
            </Field>
            <Field
              label="Место действия"
              hint={
                places.length === 0
                  ? "Сначала создайте места в разделе „Характеристики“ → „Места“"
                  : "окружение: влияет на границы и одежду; реестр — в разделе «Характеристики»"
              }
            >
              <Dropdown
                value={place}
                options={placeOptions}
                onChange={setPlace}
                disabled={places.length === 0}
                title="Места из реестра"
              />
            </Field>
            <Field label="Обстановка сцены" hint="Контекст для всех персонажей: время, обстоятельства" className="sm:col-span-2">
              <Input
                value={setting}
                onChange={(e) => setSetting(e.target.value)}
                placeholder="Пятница, вечер. Яна и Дима дома после рабочей недели."
              />
            </Field>
          </div>

          <div className="mt-4">
            <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">
              Участники (порядок = порядок ходов)
            </div>
            {chars.length === 0 ? (
              <p className="text-xs text-muted">Сначала создайте персонажей.</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {chars.map((c) => {
                  const idx = selected.indexOf(c.id);
                  const on = idx >= 0;
                  return (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => toggle(c.id)}
                      className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm transition-colors ${
                        on
                          ? "border-accent/50 bg-accent/15 text-fg"
                          : "border-line bg-panel-2/50 text-muted hover:text-fg"
                      }`}
                    >
                      <span>{c.emoji}</span>
                      {c.name}
                      {c.isHuman && <span className="text-[10px] text-warn">вы</span>}
                      {on && <span className="text-xs text-accent">#{idx + 1}</span>}
                    </button>
                  );
                })}
              </div>
            )}
            {selected.length > 0 && (
              <div className="mt-3 rounded-lg border border-line bg-black/20 p-2">
                {selected.map((cid, i) => {
                  const c = chars.find((x) => x.id === cid)!;
                  return (
                    <div key={cid} className="mb-2 rounded-lg border border-line bg-black/20 p-2 last:mb-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="flex items-center gap-1 rounded-md bg-panel-2 px-2 py-1 text-xs">
                          {c.emoji} {c.name}
                          <button className="px-0.5 text-muted hover:text-fg" onClick={() => move(i, -1)}>↑</button>
                          <button className="px-0.5 text-muted hover:text-fg" onClick={() => move(i, 1)}>↓</button>
                          <button className="px-0.5 text-muted hover:text-err" onClick={() => toggle(cid)}>×</button>
                        </span>
                        <span className="flex items-center gap-1 text-[11px] text-muted">
                          <ListChecks className="h-3 w-3" />
                          схема:
                        </span>
                        <Dropdown
                          value={String(schemasBy[String(cid)] ?? "")}
                          onChange={(v) =>
                            setSchemasBy((s) => ({ ...s, [String(cid)]: v === "" ? null : Number(v) }))
                          }
                          options={[
                            { value: "", label: "— без схемы —" },
                            ...schemas.map((v) => ({ value: String(v.id), label: v.name })),
                          ]}
                        />
                      </div>
                      <div className="mt-1.5 flex items-start gap-2">
                        <span className="mt-2 flex shrink-0 items-center gap-1 text-[11px] text-muted">
                          <Target className="h-3 w-3" />
                          цель:
                        </span>
                        <Input
                          value={goalsBy[String(cid)] ?? ""}
                          onChange={(e) =>
                            setGoalsBy((g) => ({ ...g, [String(cid)]: e.target.value }))
                          }
                          placeholder={`Что ${c.name} хочет добиться в этой сцене (видит только он)`}
                          className="text-xs"
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <button
            type="button"
            className="mt-4 flex items-center gap-1.5 text-xs text-muted hover:text-fg"
            onClick={() => setAdvanced((v) => !v)}
          >
            {advanced ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
            Расширенные настройки
          </button>
          {advanced && (
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              <Field label="Пауза между ходами, мс" hint="меньше — быстрее симуляция">
                <Input type="number" min={0} step={100} value={turnDelayMs}
                  onChange={(e) => setTurnDelayMs(Number(e.target.value))} />
              </Field>
              <Field label="Максимум ходов" hint="0 = бесконечно, стоп вручную">
                <Input type="number" min={0} value={maxTurns}
                  onChange={(e) => setMaxTurns(Number(e.target.value))} />
              </Field>
              <Field label="Итераций на ход" hint="сколько вызовов модели за ход (действие + реплика)">
                <Input type="number" min={1} max={10} value={maxIterPerTurn}
                  onChange={(e) => setMaxIterPerTurn(Number(e.target.value))} />
              </Field>
              <Field label="Событий в контексте" hint="сколько последних событий видит персонаж">
                <Input type="number" min={5} max={2000} value={contextEvents}
                  onChange={(e) => setContextEvents(Number(e.target.value))} />
              </Field>
              <Field label="Дополнительные правила" className="sm:col-span-2"
                hint="дописываются в system prompt всем персонажам">
                <Textarea rows={2} value={rulesExtra} onChange={(e) => setRulesExtra(e.target.value)}
                  placeholder="Например: сегодня годовщина отношений Яны и Димы." />
              </Field>
              <label className="flex cursor-pointer items-center gap-2 self-end pb-2 text-sm sm:col-span-2">
                <input
                  type="checkbox"
                  checked={pauseForHumans}
                  onChange={(e) => setPauseForHumans(e.target.checked)}
                  className="h-4 w-4 accent-[var(--color-accent)]"
                />
                <span className="text-muted">
                  Пауза после каждого круга ИИ — если в сцене есть персонаж-человек, сцена будет ждать вашего хода
                </span>
              </label>
            </div>
          )}

          <div className="mt-5">
            <Btn variant="primary" onClick={create} loading={saving}>
              Создать сцену
            </Btn>
          </div>
        </Card>
      )}

      {scenes.length === 0 ? (
        <EmptyState
          icon={<Clapperboard className="h-8 w-8" />}
          title="Сцен пока нет"
          hint="Соберите первую сцену из двух и более персонажей и наблюдайте, что из этого выйдет."
        />
      ) : (
        <div className="flex flex-col gap-2">
          {scenes.map((s) => (
            <Card key={s.id} className="flex items-center gap-4 p-4 transition-colors hover:border-accent/40">
              <Link href={`/scenes/${s.id}`} className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{s.name}</span>
                  <StatusBadge status={s.status} />
                  <Badge>ходов: {s.cursor}</Badge>
                </div>
                {s.setting && <p className="mt-1 line-clamp-1 text-xs text-muted">{s.setting}</p>}
              </Link>
              <Link
                href={`/scenes/${s.id}`}
                className="rounded-lg border border-line bg-panel-2/50 px-3 py-1.5 text-xs text-muted transition-colors hover:border-accent/50 hover:text-fg"
              >
                Открыть →
              </Link>
              <IconBtn variant="danger" label="Удалить сцену" onClick={() => remove(s)}>
                <Trash2 className="h-[18px] w-[18px]" />
              </IconBtn>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
