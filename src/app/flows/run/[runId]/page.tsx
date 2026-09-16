"use client";

import { useCallback, useEffect, use, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  MarkerType,
  useEdgesState,
  useNodesState,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  ArrowLeft,
  BookOpen,
  Flag,
  LogOut,
  Map as MapIcon,
  RefreshCw,
  Square,
  Waypoints,
  Trophy,
} from "lucide-react";
import {
  Badge,
  Btn,
  Card,
  ErrorText,
  PageHeader,
} from "@/components/ui";
import { api, apiDelete, apiPost } from "@/components/api";
import type { FlowCondition, FlowEdge, FlowRunReport, SimEvent } from "@/lib/types";

interface RunNodeInfo {
  id: string;
  kind: "scene" | "final" | "exit";
  sceneId: number | null;
  bonus: number;
  grantIncome: boolean;
  stopsRun: boolean;
  x: number;
  y: number;
  title: string;
  sceneStatus: string | null;
  characters: { id: number; name: string; emoji: string; status: string }[];
}

interface RunData {
  report: FlowRunReport;
  nodes: RunNodeInfo[];
  edges: FlowEdge[];
}

interface RunNodeData extends Record<string, unknown> {
  info: RunNodeInfo;
}

// ---------- Транскрипт прогона: вся история сцен глазами режиссёра ----------

interface TranscriptSection {
  key: string;
  title: string;
  sceneId: number | null;
  enteredAt: string;
  events: SimEvent[];
  names: Map<number, string>;
}

function EventRow({ ev, names }: { ev: SimEvent; names: Map<number, string> }) {
  const who = ev.actorId != null ? names.get(ev.actorId) ?? `#${ev.actorId}` : null;
  if (ev.type === "speech") {
    return (
      <div className="flex gap-2.5">
        <span className="w-20 shrink-0 truncate pt-0.5 text-right text-xs font-medium text-accent">{who}</span>
        <p className="min-w-0 flex-1 whitespace-pre-wrap text-sm leading-relaxed">{ev.payload.text ?? ""}</p>
      </div>
    );
  }
  if (ev.type === "action") {
    return (
      <div className="flex gap-2.5">
        <span className="w-20 shrink-0 truncate pt-0.5 text-right text-xs font-medium text-accent">{who}</span>
        <div className="min-w-0 flex-1 space-y-1">
          {(ev.payload.calls ?? []).map((c, i) => {
            const argsStr = JSON.stringify(c.args);
            const argsShort = argsStr.length > 90 ? `${argsStr.slice(0, 90)}…` : argsStr;
            return (
              <div key={i} className="text-xs leading-relaxed">
                <span className={c.ok ? "text-ok" : "text-err"}>{c.ok ? "✓" : "✗"}</span>{" "}
                <span className="font-mono text-muted">{c.toolName}</span>
                <span className="text-muted/70">({argsShort})</span>
                {c.ok ? (
                  c.observation ? <span className="text-fg/80"> — {c.observation}</span> : null
                ) : (
                  <span className="text-err/80"> — отказ: {c.result}</span>
                )}
              </div>
            );
          })}
          {(ev.payload.relationChanges ?? []).length > 0 && (
            <div className="text-[11px] text-warn">
              отношения:{" "}
              {(ev.payload.relationChanges ?? [])
                .map((r) => `${names.get(r.fromId) ?? r.fromId}→${names.get(r.toId) ?? r.toId} = ${r.value}`)
                .join(", ")}
            </div>
          )}
          {(ev.payload.stateChanges ?? []).length > 0 && (
            <div className="text-[11px] text-muted">
              state:{" "}
              {(ev.payload.stateChanges ?? [])
                .map((s) => `${names.get(s.characterId) ?? s.characterId}.${s.key}=${JSON.stringify(s.value)}`)
                .join(", ")}
            </div>
          )}
        </div>
      </div>
    );
  }
  if (ev.type === "director") {
    const aud = Array.isArray(ev.audience)
      ? ev.audience.map((id) => names.get(id) ?? `#${id}`).join(", ")
      : "всем";
    return (
      <div className="rounded-lg border border-warn/30 bg-warn/5 px-3 py-2 text-xs leading-relaxed">
        <span className="font-medium text-warn">[событие → {aud}]</span>{" "}
        <span className="whitespace-pre-wrap">{ev.payload.text ?? ""}</span>
      </div>
    );
  }
  if (ev.type === "system") {
    return <div className="px-3 text-[11px] italic text-muted/70">[система] {ev.payload.message ?? ""}</div>;
  }
  return null;
}

function Transcript({ sections }: { sections: TranscriptSection[] }) {
  return (
    <div className="h-full overflow-y-auto px-6 py-5">
      <div className="mx-auto flex max-w-3xl flex-col gap-6">
        {sections.map((s, idx) => (
          <section key={s.key} className="flex flex-col gap-3">
            <div className="sticky top-0 z-10 -mx-2 border-b border-line bg-bg/95 px-2 py-2 backdrop-blur">
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="text-xs font-semibold uppercase tracking-wide text-muted">
                  Сцена {idx + 1}
                </span>
                <span className="text-sm font-semibold">{s.title}</span>
                {s.sceneId != null && (
                  <Link href={`/scenes/${s.sceneId}`} className="text-xs text-accent hover:underline">
                    комната сцены →
                  </Link>
                )}
                <span className="ml-auto text-[11px] text-muted">
                  {new Date(s.enteredAt).toLocaleString("ru-RU")}
                </span>
              </div>
            </div>
            {s.events.length === 0 ? (
              <p className="text-xs text-muted/70">В этой сцене не было событий.</p>
            ) : (
              <div className="flex flex-col gap-2.5">
                {s.events.map((ev) => (
                  <EventRow key={ev.id} ev={ev} names={s.names} />
                ))}
              </div>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}

function conditionSummary(c: FlowCondition): string {
  switch (c.type) {
    case "step":
      return `${c.toolName}${c.argContains ? ` (${c.argContains})` : ""}`;
    case "score":
      return `${c.metric === "score" ? "скор" : "%"} ${c.op} ${c.value}`;
    case "clean":
      return "без нарушений";
    case "state":
      return `${c.key} ${c.op} ${c.value}`;
    case "relation":
      return `отношение ${c.whoseId == null ? "переходящего" : `#${c.whoseId}`} к #${c.toId} ${c.op} ${c.value}`;
    case "outcome":
      return `${c.toolName} → исход «${c.outcomeId}»`;
  }
}

function RunCard({ data }: NodeProps) {
  const info = (data as RunNodeData).info;
  const isScene = info.kind === "scene";
  return (
    <div
      className={`w-60 rounded-xl border-2 bg-panel px-3.5 py-3 shadow-lg ${
        info.characters.length > 0
          ? info.kind === "exit"
            ? "border-err"
            : info.kind === "final"
              ? "border-ok"
              : "border-accent"
          : isScene
            ? "border-line-2"
            : info.kind === "final"
              ? "border-ok/40"
              : "border-err/30"
      }`}
    >
      <div className="flex items-center gap-2">
        {info.kind === "scene" && <Waypoints className="h-4 w-4 shrink-0 text-accent" />}
        {info.kind === "final" && <Flag className="h-4 w-4 shrink-0 text-ok" />}
        {info.kind === "exit" && <LogOut className="h-4 w-4 shrink-0 text-err" />}
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{info.title}</span>
        {info.bonus > 0 && <Badge color="accent">+{info.bonus}</Badge>}
      </div>
      {info.characters.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {info.characters.map((c) => (
            <span
              key={c.id}
              title={`${c.name} — ${c.status === "active" ? "в сцене" : c.status === "final" ? "дошёл до финала" : "выбыл"}`}
              className={`rounded-full border px-2 py-0.5 text-[11px] ${
                c.status === "active"
                  ? "border-accent/50 bg-accent/15 text-fg"
                  : c.status === "final"
                    ? "border-ok/40 bg-ok/10 text-ok"
                    : "border-err/40 bg-err/10 text-err"
              }`}
            >
              {c.emoji} {c.name}
            </span>
          ))}
        </div>
      )}
      {isScene && info.sceneStatus && (
        <div className="mt-1.5 text-[10px] text-muted">
          сцена: {info.sceneStatus === "running" ? "идёт" : info.sceneStatus === "paused" ? "пауза" : info.sceneStatus === "finished" ? "завершена" : "не запущена"}
        </div>
      )}
    </div>
  );
}

const nodeTypes = { run: RunCard };

export default function FlowRunPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = use(params);
  const rid = Number(runId);
  const router = useRouter();

  const [data, setData] = useState<RunData | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  const load = useCallback(async () => {
    try {
      const d = await api<RunData>(`/api/flow-runs/${rid}`);
      setData(d);
      setNodes(
        d.nodes.map((n) => ({
          id: n.id,
          type: "run",
          position: { x: n.x, y: n.y },
          data: { info: n } as RunNodeData,
          draggable: false,
        }))
      );
      setEdges(
        d.edges.map((e) => ({
          id: e.id,
          source: e.from,
          target: e.to,
          label:
            e.conditions.length > 0
              ? e.conditions.map(conditionSummary).join(" И ")
              : "всегда",
          markerEnd: { type: MarkerType.ArrowClosed },
        }))
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [rid, setNodes, setEdges]);

  useEffect(() => {
    load();
  }, [load]);

  // Живое обновление, пока прогон идёт
  useEffect(() => {
    if (data?.report.run.status !== "running") return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [data?.report.run.status, load]);

  const evaluate = async (nodeId: string) => {
    setBusy(nodeId);
    setError("");
    try {
      await apiPost(`/api/flow-runs/${rid}/evaluate`, { nodeId });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  };

  const restartScene = async (sceneId: number) => {
    setBusy(`scene${sceneId}`);
    setError("");
    try {
      await apiPost(`/api/scenes/${sceneId}/control`, { action: "start" });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  };

  const stopRun = async () => {
    if (!confirm("Остановить прогон? Активные сцены встанут на паузу.")) return;
    setBusy("stop");
    try {
      await apiDelete(`/api/flow-runs/${rid}`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  };

  // ---------- Транскрипт: сцены в порядке прохождения, события целиком ----------
  const [view, setView] = useState<"map" | "transcript">("map");
  const [transcript, setTranscript] = useState<TranscriptSection[] | null>(null);
  const [trLoading, setTrLoading] = useState(false);

  const openTranscript = useCallback(async () => {
    setView("transcript");
    // Кэш используем только для завершённого прогона; идущий — обновляем
    if (!data) return;
    if (transcript && data.report.run.status !== "running") return;
    setTrLoading(true);
    setError("");
    try {
      // Порядок сцен — по первому входу любого персонажа в узел прогона
      const firstEnter = new Map<string, { at: string; title: string; sceneId: number | null }>();
      for (const c of data.report.characters) {
        for (const v of c.visits) {
          const cur = firstEnter.get(v.nodeId);
          if (!cur || v.enteredAt < cur.at) {
            firstEnter.set(v.nodeId, { at: v.enteredAt, title: v.nodeTitle, sceneId: v.sceneId });
          }
        }
      }
      const ordered = [...firstEnter.entries()]
        .filter(([, v]) => v.sceneId != null)
        .sort((a, b) => a[1].at.localeCompare(b[1].at));
      const sections: TranscriptSection[] = [];
      for (const [nodeId, v] of ordered) {
        const sceneData = await api<{
          scene: { name: string };
          participants: { id: number; name: string; emoji: string }[];
        }>(`/api/scenes/${v.sceneId}`);
        const events = await api<SimEvent[]>(`/api/scenes/${v.sceneId}/events`);
        const names = new Map<number, string>();
        for (const p of sceneData.participants) names.set(p.id, p.name);
        sections.push({
          key: nodeId,
          title: v.title || sceneData.scene.name,
          sceneId: v.sceneId,
          enteredAt: v.at,
          events: [...events].sort((a, b) => a.id - b.id),
          names,
        });
      }
      setTranscript(sections);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setTrLoading(false);
    }
  }, [data, transcript]);

  if (!data) {
    return (
      <div className="mx-auto max-w-6xl px-8 py-10">
        <ErrorText>{error || "Загрузка…"}</ErrorText>
      </div>
    );
  }

  const { report } = data;
  const running = report.run.status === "running";

  return (
    <div className="flex h-screen flex-col">
      <div className="border-b border-line px-6 py-3">
        <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-3">
          <button className="text-muted transition-colors hover:text-fg" onClick={() => router.push(`/flows/${report.flow.id}`)}>
            <ArrowLeft className="h-4 w-4" />
          </button>
          <span className="font-semibold">
            {report.flow.name} — прогон #{report.run.id}
          </span>
          <Badge color={running ? "ok" : report.run.status === "finished" ? "accent" : "err"}>
            {running ? "идёт" : report.run.status === "finished" ? "завершён" : "остановлен"}
          </Badge>
          <span className="text-xs text-muted">
            старт {new Date(report.run.startedAt).toLocaleString("ru-RU")}
          </span>
          <div className="ml-2 flex overflow-hidden rounded-lg border border-line">
            <button
              type="button"
              onClick={() => setView("map")}
              className={`flex h-8 items-center gap-1.5 px-3 text-xs transition-colors ${
                view === "map" ? "bg-accent/15 text-fg" : "text-muted hover:text-fg"
              }`}
              title="Карта прогона"
            >
              <MapIcon className="h-3.5 w-3.5" /> Карта
            </button>
            <button
              type="button"
              onClick={openTranscript}
              className={`flex h-8 items-center gap-1.5 px-3 text-xs transition-colors ${
                view === "transcript" ? "bg-accent/15 text-fg" : "text-muted hover:text-fg"
              }`}
              title="Читать историю всех сцен прогона подряд"
            >
              <BookOpen className="h-3.5 w-3.5" /> Транскрипт
            </button>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <Btn onClick={load} loading={busy === "reload"} title="Обновить данные">
              <RefreshCw className="h-4 w-4" />
            </Btn>
            {running && (
              <Btn variant="danger" onClick={stopRun} loading={busy === "stop"}>
                <Square className="h-4 w-4" /> Остановить прогон
              </Btn>
            )}
          </div>
        </div>
        {error && (
          <div className="mx-auto mt-2 max-w-[1600px]">
            <ErrorText>{error}</ErrorText>
          </div>
        )}
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1">
          {view === "transcript" ? (
            trLoading || !transcript ? (
              <div className="flex h-full items-center justify-center text-sm text-muted">
                {trLoading ? "Собираю историю сцен…" : "Транскрипт пуст"}
              </div>
            ) : (
              <Transcript sections={transcript} />
            )
          ) : (
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable={false}
            nodeTypes={nodeTypes}
            fitView
            minZoom={0.2}
          >
            <Background variant={BackgroundVariant.Dots} gap={22} size={1.5} color="#242433" />
            <Controls position="bottom-left" showInteractive={false} />
            <MiniMap pannable zoomable maskColor="rgba(9,9,15,0.7)" nodeColor="#32324a" />
          </ReactFlow>
          )}
        </div>

        {/* Правая колонка: активные узлы + отчёт */}
        <aside className="hidden w-96 shrink-0 flex-col gap-3 overflow-y-auto border-l border-line p-4 xl:flex">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted">Сцены прогона</div>
          {data.nodes
            .filter((n) => n.kind === "scene")
            .map((n) => {
              const hasActives = n.characters.some((c) => c.status === "active");
              return (
                <Card key={n.id} className={`p-3 ${hasActives ? "border-accent/40" : ""}`}>
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">{n.title}</span>
                    {n.sceneStatus && (
                      <Badge color={n.sceneStatus === "running" ? "ok" : "muted"}>
                        {n.sceneStatus === "running" ? "идёт" : n.sceneStatus === "paused" ? "пауза" : n.sceneStatus === "finished" ? "завершена" : "не запущена"}
                      </Badge>
                    )}
                  </div>
                  {n.characters.length > 0 && (
                    <div className="mt-1 text-[11px] text-muted">
                      {n.characters.map((c) => `${c.emoji} ${c.name}`).join(", ")}
                    </div>
                  )}
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {n.sceneId != null && (
                      <Link
                        href={`/scenes/${n.sceneId}`}
                        className="rounded-lg border border-line bg-panel-2/50 px-2.5 py-1 text-xs text-fg transition-colors hover:border-accent/50"
                      >
                        комната сцены →
                      </Link>
                    )}
                    {hasActives && running && (
                      <Btn className="h-7 px-2 text-xs" onClick={() => evaluate(n.id)} loading={busy === n.id}>
                        Оценить переход
                      </Btn>
                    )}
                    {hasActives && running && n.sceneId != null && n.sceneStatus !== "running" && (
                      <Btn className="h-7 px-2 text-xs" onClick={() => restartScene(n.sceneId!)} loading={busy === `scene${n.sceneId}`}>
                        Перезапустить сцену
                      </Btn>
                    )}
                  </div>
                </Card>
              );
            })}

          <div className="mt-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted">
            <Trophy className="h-4 w-4 text-warn" /> Отчёт прогона
          </div>
          {report.characters.map((c) => (
            <Card key={c.characterId} className="p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-lg">{c.emoji}</span>
                <span className="text-sm font-medium">{c.name}</span>
                {c.reachedFinal ? (
                  <Badge color="ok">дошёл до финала</Badge>
                ) : c.status === "eliminated" ? (
                  <Badge color="err">выбыл</Badge>
                ) : (
                  <Badge color="accent">в пути</Badge>
                )}
                <span className="ml-auto text-sm font-semibold tabular-nums">
                  <span className={c.total >= 0 ? "text-ok" : "text-err"}>{c.total}</span>
                  <span className="text-muted"> ({c.score} + {c.bonus})</span>
                </span>
              </div>
              <div className="mt-2 flex flex-col gap-1">
                {c.visits.map((v, i) => (
                  <div key={i} className="flex items-center gap-2 text-xs">
                    <span className="w-4 text-center text-muted/50">{i + 1}</span>
                    <span className="min-w-0 flex-1 truncate">{v.nodeTitle}</span>
                    {v.score != null && (
                      <span className="tabular-nums text-muted">
                        {v.score}
                        {v.completionPct != null && ` · ${v.completionPct}%`}
                      </span>
                    )}
                  </div>
                ))}
              </div>
              {c.relations?.length > 0 && (
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line pt-2 text-xs">
                  <span className="text-muted">отношения:</span>
                  {c.relations.map((r) => (
                    <span key={r.toId} className="tabular-nums">
                      {r.name}{" "}
                      <span className={r.value >= 0 ? "text-ok" : "text-err"}>{r.value >= 0 ? `+${r.value}` : r.value}</span>
                    </span>
                  ))}
                </div>
              )}
            </Card>
          ))}
          <p className="text-[11px] leading-relaxed text-muted/70">
            Оценки сцен пересчитываются по текущим событиям: правка схемы валидации после
            завершения сцены меняет отчёт при обновлении.
          </p>
        </aside>
      </div>
    </div>
  );
}
