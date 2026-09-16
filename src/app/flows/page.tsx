"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Play, Plus, Trash2, Waypoints } from "lucide-react";
import {
  Badge,
  Btn,
  Card,
  EmptyState,
  ErrorText,
  Field,
  Input,
  PageHeader,
  Textarea,
} from "@/components/ui";
import { api, apiDelete, apiPost } from "@/components/api";
import type { Flow } from "@/lib/types";

export default function FlowsPage() {
  const [flows, setFlows] = useState<Flow[]>([]);
  const [runsCount, setRunsCount] = useState<Record<number, number>>({});
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    api<Flow[]>("/api/flows")
      .then((f) => {
        setFlows(f);
        // количество прогонов — для бейджа «идёт»
        Promise.all(
          f.map((x) =>
            api<{ id: number; status: string }[]>(`/api/flows/${x.id}/runs`).then(
              (r) => [x.id, r] as const
            )
          )
        ).then((pairs) => {
          setRunsCount(Object.fromEntries(pairs.map(([id, r]) => [id, r.length])));
          setRunning(
            Object.fromEntries(
              pairs
                .filter(([, r]) => r.some((x) => x.status === "running"))
                .map(([id]) => [id, true])
            )
          );
        });
      })
      .catch((e) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  const [running, setRunning] = useState<Record<number, boolean>>({});

  const create = async () => {
    setError("");
    if (!name.trim()) {
      setError("Название обязательно");
      return;
    }
    setSaving(true);
    try {
      await apiPost("/api/flows", { name: name.trim(), description });
      setOpen(false);
      setName("");
      setDescription("");
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (f: Flow) => {
    if (!confirm(`Удалить сценарий «${f.name}»? Прогоны и их отчёты удалятся тоже.`)) return;
    setError("");
    try {
      await apiDelete(`/api/flows/${f.id}`);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="mx-auto max-w-5xl px-8 py-10">
      <PageHeader
        title="Сценарии"
        subtitle="Цепочки сцен на канвасе: условия переходов — машиночитаемые правила вызова инструментов. Кто пройдёт все сцены — дойдёт до финала."
        actions={
          <Btn variant="primary" onClick={() => setOpen(true)}>
            <Plus className="h-4 w-4" /> Создать
          </Btn>
        }
      />
      <ErrorText>{error}</ErrorText>

      {open && (
        <Card className="mb-6 p-5">
          <div className="mb-3 text-sm font-medium">Новый сценарий</div>
          <div className="grid gap-4">
            <Field label="Название">
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Роман Яны и Саши" />
            </Field>
            <Field label="Описание">
              <Textarea
                rows={2}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="О чём эта история…"
              />
            </Field>
          </div>
          <div className="mt-4 flex gap-2">
            <Btn variant="primary" onClick={create} loading={saving}>
              Создать
            </Btn>
            <Btn variant="ghost" onClick={() => setOpen(false)}>
              Отмена
            </Btn>
          </div>
        </Card>
      )}

      {flows.length === 0 ? (
        <EmptyState
          icon={<Waypoints className="h-8 w-8" />}
          title="Сценариев нет"
          hint="Создайте сценарий, добавьте на канвас узлы-сцены, свяжите их рёбрами с условиями — и запускайте прогон: персонажи пойдут по цепочке, а вы увидите, кто дойдёт до финала."
        />
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          {flows.map((f) => (
            <Card key={f.id} className="p-4 transition-colors hover:border-accent/40">
              <div className="flex items-start justify-between gap-2">
                <Link href={`/flows/${f.id}`} className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{f.name}</span>
                    {running[f.id] && (
                      <Badge color="ok">
                        <Play className="h-3 w-3" /> прогон идёт
                      </Badge>
                    )}
                    <Badge>{f.graph.nodes.length} узлов</Badge>
                    {runsCount[f.id] > 0 && <Badge>{runsCount[f.id]} прогонов</Badge>}
                  </div>
                  <p className="mt-2 line-clamp-2 text-xs leading-relaxed text-muted">
                    {f.description || "без описания"}
                  </p>
                </Link>
                <button
                  className="shrink-0 rounded-lg border border-line p-1.5 text-muted transition-colors hover:border-err/50 hover:text-err"
                  title="Удалить сценарий"
                  onClick={() => remove(f)}
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
