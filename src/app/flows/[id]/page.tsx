"use client";

import { useCallback, useEffect, useMemo, useState, use } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  ConnectionMode,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  ArrowLeft,
  Flag,
  LogOut,
  Plus,
  RotateCcw,
  Save,
  Trash2,
  Waypoints,
  DollarSign,
} from "lucide-react";
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
} from "@/components/ui";
import { api, apiPatch, apiPost } from "@/components/api";
import type {
  AttributeDef,
  Character,
  Flow,
  FlowCondition,
  FlowEdge,
  FlowGraph,
  FlowNode,
  FlowRun,
  Scene,
  Tool,
} from "@/lib/types";

interface FlowNodeData extends Record<string, unknown> {
  flowNode: FlowNode;
  sceneName: string;
}

interface FlowEdgeData extends Record<string, unknown> {
  flowEdge: FlowEdge;
}

function conditionSummary(c: FlowCondition): string {
  switch (c.type) {
    case "step":
      return `${c.toolName}${c.argContains ? ` (${c.argContains})` : ""}`;
    case "score":
      return `${c.metric === "score" ? "скор" : "обязательные %"} ${c.op} ${c.value}`;
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

function edgeLabel(fe: FlowEdge): string {
  const base = fe.conditions.length > 0 ? fe.conditions.map(conditionSummary).join(" И ") : "всегда";
  return fe.label ? `${fe.label}: ${base}` : base;
}

// ---------- Карточка узла на канвасе ----------

function FlowCard({ data, selected }: NodeProps) {
  const d = data as FlowNodeData;
  const n = d.flowNode;
  const isScene = n.kind === "scene";
  return (
    <div
      className={`w-56 rounded-xl border-2 bg-panel px-3.5 py-3 shadow-lg transition-colors ${
        selected ? "border-accent" : isScene ? "border-line-2 hover:border-accent/50" : n.kind === "final" ? "border-ok/50" : "border-err/40"
      }`}
    >
      {/* Точки соединения: тянем от нижней точки к верхней — появляется ребро */}
      <Handle type="target" position={Position.Top} isConnectable />
      <Handle type="source" position={Position.Bottom} isConnectable />
      <div className="flex items-center gap-2">
        {n.kind === "scene" && <Waypoints className="h-4 w-4 shrink-0 text-accent" />}
        {n.kind === "final" && <Flag className="h-4 w-4 shrink-0 text-ok" />}
        {n.kind === "exit" && <LogOut className="h-4 w-4 shrink-0 text-err" />}
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {isScene ? d.sceneName : n.kind === "final" ? "Финал" : "Выход"}
        </span>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1">
        {n.bonus > 0 && <Badge color="accent">+{n.bonus}</Badge>}
        {n.resetOnEntry && isScene && (
          <span title="Сброс сцены при входе" className="text-muted">
            <RotateCcw className="h-3.5 w-3.5" />
          </span>
        )}
        {n.grantIncome && (
          <span title="Начислить доход при уходе" className="text-warn">
            <DollarSign className="h-3.5 w-3.5" />
          </span>
        )}
        {n.stopsRun && n.kind === "exit" && <Badge color="err">стоп всё</Badge>}
      </div>
    </div>
  );
}

const nodeTypes = { flow: FlowCard };

// ---------- Страница-редактор ----------

export default function FlowEditorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const [flowId] = useState(() => Number(id));

  const [flow, setFlow] = useState<Flow | null>(null);
  const [scenes, setScenes] = useState<Scene[]>([]);
  const [characters, setCharacters] = useState<Character[]>([]);
  const [tools, setTools] = useState<Tool[]>([]);
  const [attributes, setAttributes] = useState<AttributeDef[]>([]);
  const [error, setError] = useState("");
  const [graphErrors, setGraphErrors] = useState<string[]>([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [sel, setSel] = useState<{ type: "node" | "edge"; id: string } | null>(null);
  const [runOpen, setRunOpen] = useState(false);
  const [runCast, setRunCast] = useState<number[]>([]);
  const [runBusy, setRunBusy] = useState(false);
  const [runs, setRuns] = useState<FlowRun[]>([]);
  const [edgeCounter, setEdgeCounter] = useState(1);

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  const sceneName = useCallback(
    (sceneId: number | null) =>
      sceneId == null ? "сцена не задана" : (scenes.find((s) => s.id === sceneId)?.name ?? `сцена #${sceneId}`),
    [scenes]
  );

  useEffect(() => {
    Promise.all([
      api<{ flow: Flow; graphErrors: string[] }>(`/api/flows/${flowId}`),
      api<Scene[]>("/api/scenes"),
      api<Character[]>("/api/characters"),
      api<Tool[]>("/api/tools"),
      api<AttributeDef[]>("/api/attributes"),
      api<FlowRun[]>(`/api/flows/${flowId}/runs`).catch(() => [] as FlowRun[]),
    ])
      .then(([d, sc, ch, tl, at, rn]) => {
        setFlow(d.flow);
        setGraphErrors(d.graphErrors);
        setScenes(sc);
        setCharacters(ch);
        setTools(tl);
        setAttributes(at);
        setRuns(rn);
        setRunCast(ch.filter((c) => !c.isHuman).map((c) => c.id));
        setNodes(
          d.flow.graph.nodes.map((n) => ({
            id: n.id,
            type: "flow",
            position: { x: n.x, y: n.y },
            data: { flowNode: n, sceneName: "" } as FlowNodeData,
          }))
        );
        setEdges(
          d.flow.graph.edges.map((e) => ({
            id: e.id,
            source: e.from,
            target: e.to,
            label: edgeLabel(e),
            markerEnd: { type: MarkerType.ArrowClosed },
            data: { flowEdge: e } as FlowEdgeData,
          }))
        );
        setEdgeCounter(d.flow.graph.edges.length + 1);
      })
      .catch((e) => setError(e.message));
  }, [flowId, setNodes, setEdges]);

  // Подпись узлов обновляется, когда подтянется список сцен
  useEffect(() => {
    setNodes((ns) =>
      ns.map((n) => ({
        ...n,
        data: { ...(n.data as FlowNodeData), sceneName: sceneName((n.data as FlowNodeData).flowNode.sceneId) },
      }))
    );
  }, [scenes, sceneName, setNodes]);

  const updateNode = (nodeId: string, patch: Partial<FlowNode>) => {
    setNodes((ns) =>
      ns.map((n) =>
        n.id === nodeId
          ? {
              ...n,
              data: {
                ...(n.data as FlowNodeData),
                flowNode: { ...(n.data as FlowNodeData).flowNode, ...patch },
              },
            }
          : n
      )
    );
    setDirty(true);
    setSaved(false);
  };

  const updateEdge = (edgeId: string, patch: Partial<FlowEdge>) => {
    setEdges((es) =>
      es.map((e) => {
        if (e.id !== edgeId) return e;
        const fe = { ...((e.data as FlowEdgeData).flowEdge), ...patch };
        return { ...e, data: { flowEdge: fe } as FlowEdgeData, label: edgeLabel(fe) };
      })
    );
    setDirty(true);
    setSaved(false);
  };

  const addNode = (kind: FlowNode["kind"]) => {
    const num = nodes.length + 1;
    const n: FlowNode = {
      id: `n${Date.now().toString(36)}`,
      kind,
      sceneId: null,
      bonus: kind === "final" ? 50 : 0,
      resetOnEntry: true,
      grantIncome: false,
      stopsRun: false,
      x: 120 + ((num * 80) % 420),
      y: 60 + ((num * 120) % 320),
    };
    setNodes((ns) => [...ns, { id: n.id, type: "flow", position: { x: n.x, y: n.y }, data: { flowNode: n, sceneName: "" } }]);
    setSel({ type: "node", id: n.id });
    setDirty(true);
  };

  const deleteNode = (nodeId: string) => {
    setNodes((ns) => ns.filter((n) => n.id !== nodeId));
    setEdges((es) => es.filter((e) => e.source !== nodeId && e.target !== nodeId));
    setSel(null);
    setDirty(true);
  };

  const deleteEdge = (edgeId: string) => {
    setEdges((es) => es.filter((e) => e.id !== edgeId));
    setSel(null);
    setDirty(true);
  };

  const onConnect = useCallback(
    (c: Connection) => {
      if (!c.source || !c.target || c.source === c.target) return;
      const fe: FlowEdge = {
        id: `e${Date.now().toString(36)}_${edgeCounter}`,
        from: c.source,
        to: c.target,
        priority: edgeCounter,
        conditions: [],
        label: "",
      };
      setEdges((es) => [
        ...es,
        {
          id: fe.id,
          source: fe.from,
          target: fe.to,
          label: edgeLabel(fe),
          markerEnd: { type: MarkerType.ArrowClosed },
          data: { flowEdge: fe } as FlowEdgeData,
        },
      ]);
      setEdgeCounter((x) => x + 1);
      setDirty(true);
    },
    [edgeCounter, setEdges]
  );

  const graphNow = useMemo(
    (): FlowGraph => ({
      nodes: nodes.map((n) => {
        const fn = (n.data as FlowNodeData).flowNode;
        return { ...fn, x: Math.round(n.position.x), y: Math.round(n.position.y) };
      }),
      edges: edges.map((e) => ({ ...((e.data as FlowEdgeData).flowEdge) })),
    }),
    [nodes, edges]
  );

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      const f = await apiPatch<Flow>(`/api/flows/${flowId}`, { graph: graphNow });
      setGraphErrors([]);
      setDirty(false);
      setSaved(true);
      setFlow(f);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const startRun = async () => {
    setRunBusy(true);
    setError("");
    try {
      const run = await apiPost<{ id: number }>(`/api/flows/${flowId}/runs`, { characterIds: runCast });
      router.push(`/flows/run/${run.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunBusy(false);
    }
  };

  const selNode = sel?.type === "node" ? nodes.find((n) => n.id === sel.id) : null;
  const selEdge = sel?.type === "edge" ? edges.find((e) => e.id === sel.id) : null;

  if (!flow) {
    return (
      <div className="mx-auto max-w-6xl px-8 py-10">
        <ErrorText>{error || "Загрузка…"}</ErrorText>
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col">
      <div className="border-b border-line px-6 py-3">
        <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-3">
          <button className="text-muted transition-colors hover:text-fg" onClick={() => router.push("/flows")}>
            <ArrowLeft className="h-4 w-4" />
          </button>
          <span className="font-semibold">{flow.name}</span>
          {dirty ? <Badge color="warn">не сохранено</Badge> : saved ? <Badge color="ok">сохранено</Badge> : null}
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Btn onClick={() => addNode("scene")}>
              <Plus className="h-4 w-4" /> сцена
            </Btn>
            <Btn onClick={() => addNode("final")}>
              <Plus className="h-4 w-4" /> финал
            </Btn>
            <Btn onClick={() => addNode("exit")}>
              <Plus className="h-4 w-4" /> выход
            </Btn>
            <Btn variant="primary" onClick={save} loading={saving}>
              <Save className="h-4 w-4" /> Сохранить
            </Btn>
            <Btn
              variant="primary"
              onClick={() => setRunOpen((v) => !v)}
              disabled={dirty || graphErrors.length > 0}
              title={dirty ? "Сначала сохраните граф" : graphErrors.length ? "Граф невалиден" : "Запустить прогон"}
            >
              ▶ Прогон
            </Btn>
          </div>
        </div>
        {(graphErrors.length > 0 || error) && (
          <div className="mx-auto mt-2 max-w-[1600px]">
            <ErrorText>{error || graphErrors.join("; ")}</ErrorText>
          </div>
        )}
        {runs.length > 0 && (
          <div className="mx-auto mt-2 flex max-w-[1600px] flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
            <span className="font-medium uppercase tracking-wide text-muted">
              Прогоны ({runs.length}):
            </span>
            {runs.map((r) => (
              <Link
                key={r.id}
                href={`/flows/run/${r.id}`}
                className="flex items-center gap-1.5 rounded-lg border border-line bg-panel-2/50 px-2.5 py-1 text-fg transition-colors hover:border-accent/50"
                title={`Старт: ${new Date(r.startedAt).toLocaleString("ru-RU")} — открыть карту и транскрипт прогона`}
              >
                <Badge color={r.status === "running" ? "ok" : r.status === "finished" ? "accent" : "err"}>
                  {r.status === "running" ? "идёт" : r.status === "finished" ? "завершён" : "остановлен"}
                </Badge>
                #{r.id}
                <span className="text-muted">{new Date(r.startedAt).toLocaleString("ru-RU")}</span>
                <span className="text-muted/70">
                  {r.cast
                    .map((cid) => characters.find((c) => c.id === cid))
                    .filter((c): c is Character => c != null)
                    .map((c) => c.emoji)
                    .join(" ")}
                </span>
                <span className="text-accent">история →</span>
              </Link>
            ))}
            <span className="text-muted/70">транскрипт читается кнопкой «Транскрипт» внутри прогона</span>
          </div>
        )}
        {runOpen && (
          <div className="mx-auto mt-2 max-w-[1600px] rounded-xl border border-line bg-panel p-4">
            <div className="mb-2 text-sm font-medium">Состав прогона</div>
            <div className="flex flex-wrap gap-2">
              {characters.map((c) => (
                <label
                  key={c.id}
                  className={`flex cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-colors ${
                    runCast.includes(c.id) ? "border-accent/60 bg-accent/20 text-fg" : "border-line bg-panel-2/50 text-muted hover:text-fg"
                  }`}
                >
                  <input
                    type="checkbox"
                    className="hidden"
                    checked={runCast.includes(c.id)}
                    onChange={() =>
                      setRunCast((s) => (s.includes(c.id) ? s.filter((x) => x !== c.id) : [...s, c.id]))
                    }
                  />
                  <span>{c.emoji}</span> {c.name} {c.isHuman ? "(вы)" : ""}
                </label>
              ))}
            </div>
            <div className="mt-3 flex items-center gap-2">
              <Btn variant="primary" onClick={startRun} loading={runBusy} disabled={runCast.length === 0}>
                Запустить и открыть прогон
              </Btn>
              <span className="text-xs text-muted">
                Входной узел стартует сразу; переходы оцениваются по завершению сцен или кнопкой в прогоне.
              </span>
            </div>
          </div>
        )}
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={(chg) => {
              onNodesChange(chg);
              if (chg.some((c) => c.type === "position" || c.type === "remove")) {
                setDirty(true);
                setSaved(false);
              }
            }}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={(_, n) => setSel({ type: "node", id: n.id })}
            onEdgeClick={(_, e) => setSel({ type: "edge", id: e.id })}
            onPaneClick={() => setSel(null)}
            nodeTypes={nodeTypes}
            connectionMode={ConnectionMode.Loose}
            deleteKeyCode={["Backspace", "Delete"]}
            fitView
            minZoom={0.2}
          >
            <Background variant={BackgroundVariant.Dots} gap={22} size={1.5} color="#242433" />
            <Controls position="bottom-left" showInteractive={false} />
            <MiniMap pannable zoomable maskColor="rgba(9,9,15,0.7)" nodeColor="#32324a" />
          </ReactFlow>
        </div>

        {/* Панель свойств */}
        <aside className="hidden w-80 shrink-0 overflow-y-auto border-l border-line p-4 xl:block">
          {!sel && (
            <p className="text-xs leading-relaxed text-muted">
              Кликните узел или ребро, чтобы настроить. Узел-сцена запускает свою сцену для персонажей,
              которые в него пришли; финал и выход — терминалы. Ребро = правило перехода: условия
              по вызовам инструментов («И»), первое подошедшее по приоритету побеждает.
            </p>
          )}

          {selNode && (
            <NodePanel
              node={(selNode.data as FlowNodeData).flowNode}
              sceneName={sceneName}
              scenes={scenes}
              onChange={(p) => updateNode(selNode.id, p)}
              onDelete={() => deleteNode(selNode.id)}
            />
          )}

          {selEdge && (
            <EdgePanel
              edge={(selEdge.data as FlowEdgeData).flowEdge}
              tools={tools}
              characters={characters}
              attributes={attributes}
              onChange={(p) => updateEdge(selEdge.id, p)}
              onDelete={() => deleteEdge(selEdge.id)}
            />
          )}
        </aside>
      </div>
    </div>
  );
}

// ---------- Панель узла ----------

function NodePanel({
  node,
  scenes,
  sceneName,
  onChange,
  onDelete,
}: {
  node: FlowNode;
  scenes: Scene[];
  sceneName: (id: number | null) => string;
  onChange: (patch: Partial<FlowNode>) => void;
  onDelete: () => void;
}) {
  return (
    <Card className="p-4">
      <div className="mb-3 text-sm font-medium">Узел: {node.kind === "scene" ? sceneName(node.sceneId) : node.kind === "final" ? "Финал" : "Выход"}</div>
      <div className="flex flex-col gap-3">
        <Field label="Тип узла">
          <Select
            value={node.kind}
            onChange={(v) => onChange({ kind: v as FlowNode["kind"] })}
            options={[
              { value: "scene", label: "Сцена" },
              { value: "final", label: "Финал" },
              { value: "exit", label: "Выход (провал)" },
            ]}
          />
        </Field>
        {node.kind === "scene" && (
          <Field label="Сцена" hint="Разные узлы не должны ссылаться на одну сцену">
            <Select
              value={node.sceneId != null ? String(node.sceneId) : ""}
              onChange={(v) => onChange({ sceneId: v ? Number(v) : null })}
              options={[
                { value: "", label: "— не задана —" },
                ...scenes.map((s) => ({ value: String(s.id), label: s.name })),
              ]}
            />
          </Field>
        )}
        {node.kind !== "exit" && (
          <Field label="Бонус очков за достижение узла">
            <Input
              type="number"
              min={0}
              value={node.bonus}
              onChange={(e) => onChange({ bonus: Number(e.target.value) })}
            />
          </Field>
        )}
        {node.kind === "scene" && (
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="h-4 w-4 accent-[var(--color-accent)]"
              checked={node.resetOnEntry}
              onChange={(e) => onChange({ resetOnEntry: e.target.checked })}
            />
            <span className="text-muted">Сбрасывать сцену при входе (новый заход)</span>
          </label>
        )}
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="h-4 w-4 accent-[var(--color-accent)]"
            checked={node.grantIncome}
            onChange={(e) => onChange({ grantIncome: e.target.checked })}
          />
          <span className="text-muted">Начислять доход персонажам при уходе (течение времени)</span>
        </label>
        {node.kind === "exit" && (
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="h-4 w-4 accent-[var(--color-accent)]"
              checked={node.stopsRun}
              onChange={(e) => onChange({ stopsRun: e.target.checked })}
            />
            <span className="text-muted">Остановить весь прогон, если кто-то сюда попал</span>
          </label>
        )}
        <Btn variant="danger" onClick={onDelete}>
          <Trash2 className="h-4 w-4" /> Удалить узел
        </Btn>
      </div>
    </Card>
  );
}

// ---------- Панель ребра ----------

function EdgePanel({
  edge,
  tools,
  characters,
  attributes,
  onChange,
  onDelete,
}: {
  edge: FlowEdge;
  tools: Tool[];
  characters: Character[];
  attributes: AttributeDef[];
  onChange: (patch: Partial<FlowEdge>) => void;
  onDelete: () => void;
}) {
  const setCondition = (i: number, c: FlowCondition | null) => {
    const next = [...edge.conditions];
    if (c === null) next.splice(i, 1);
    else next[i] = c;
    onChange({ conditions: next });
  };

  const charOptions = [
    { value: "", label: "переходящему персонажу" },
    ...characters.map((c) => ({ value: String(c.id), label: c.name })),
  ];
  const attrKeyOptions = (cur: string) => {
    const opts = attributes.map((a) => ({
      value: a.key,
      label: `${a.emoji ? a.emoji + " " : ""}${a.label} (${a.key})`,
    }));
    return opts.some((o) => o.value === cur)
      ? opts
      : [{ value: cur, label: `${cur} (нет в реестре)` }, ...opts];
  };

  return (
    <Card className="p-4">
      <div className="mb-3 text-sm font-medium">Ребро → {edge.to}</div>
      <div className="flex flex-col gap-3">
        <Field label="Приоритет" hint="меньше число — проверяется раньше">
          <Input
            type="number"
            min={0}
            value={edge.priority}
            onChange={(e) => onChange({ priority: Number(e.target.value) })}
          />
        </Field>
        <Field label="Заметка для себя">
          <Input value={edge.label} onChange={(e) => onChange({ label: e.target.value })} placeholder="если поцеловал…" />
        </Field>

        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-xs font-medium uppercase tracking-wide text-muted">
              Условия (все одновременно)
            </span>
            <Btn
              variant="ghost"
              className="h-7 px-2 text-xs"
              onClick={() => onChange({ conditions: [...edge.conditions, { type: "step", toolName: tools[0]?.name ?? "tool", argContains: null, characterId: null }] })}
            >
              <Plus className="h-3 w-3" /> условие
            </Btn>
          </div>
          {edge.conditions.length === 0 && (
            <p className="text-xs leading-relaxed text-muted/70">
              Без условий переход безусловный. Пример: «Саша обязан поцеловать Яну» — условие
              «шаг: kiss_yana» с закреплением за Сашей.
            </p>
          )}
          <div className="flex flex-col gap-2">
            {edge.conditions.map((c, i) => {
              const lbl = (text: string) => (
                <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted/80">{text}</div>
              );
              return (
                <div key={i} className="rounded-lg border border-line bg-panel-2/40 p-3">
                  <div className="flex items-center gap-2">
                    <div className="min-w-0 flex-1">
                      <Select
                        value={c.type}
                        onChange={(v) => {
                          const t = v as FlowCondition["type"];
                          const keep = "characterId" in c ? (c.characterId ?? null) : null;
                          if (t === "step") setCondition(i, { type: "step", toolName: tools[0]?.name ?? "tool", argContains: null, characterId: keep });
                          if (t === "score") setCondition(i, { type: "score", metric: "completionPct", op: ">=", value: 60, characterId: keep });
                          if (t === "clean") setCondition(i, { type: "clean", characterId: keep });
                          if (t === "state") setCondition(i, { type: "state", key: "mood", op: ">=", value: 0, characterId: keep });
                          if (t === "relation") setCondition(i, { type: "relation", whoseId: null, toId: characters[0]?.id ?? 1, op: ">=", value: 3 });
                          if (t === "outcome") setCondition(i, { type: "outcome", toolName: tools[0]?.name ?? "tool", outcomeId: tools[0]?.outcomes?.[0]?.id ?? "", characterId: keep });
                        }}
                        options={[
                          { value: "step", label: "вызов инструмента" },
                          { value: "outcome", label: "исход инструмента" },
                          { value: "relation", label: "отношение" },
                          { value: "score", label: "скор / % схемы" },
                          { value: "state", label: "ключ состояния" },
                          { value: "clean", label: "без нарушений" },
                        ]}
                      />
                    </div>
                    <IconBtn variant="danger" size="sm" label="Удалить условие" onClick={() => setCondition(i, null)}>
                      <Trash2 className="h-4 w-4" />
                    </IconBtn>
                  </div>
                  <div className="mt-2.5 grid gap-x-3 gap-y-2.5 sm:grid-cols-2">
                    {c.type === "step" && (
                      <>
                        <div className="sm:col-span-2">
                          {lbl("инструмент")}
                          <Select
                            value={c.toolName}
                            onChange={(v) => setCondition(i, { ...c, toolName: v })}
                            options={tools.map((t) => ({ value: t.name, label: t.title || t.name }))}
                          />
                        </div>
                        <div className="sm:col-span-2">
                          {lbl("фильтр по аргументам (необязательно)")}
                          <Input
                            value={c.argContains ?? ""}
                            onChange={(e) => setCondition(i, { ...c, argContains: e.target.value })}
                            placeholder="подстрока в аргументах, напр. имя получателя"
                            className="text-xs"
                          />
                        </div>
                      </>
                    )}
                    {c.type === "outcome" && (
                      <>
                        <div>
                          {lbl("инструмент")}
                          <Select
                            value={c.toolName}
                            onChange={(v) =>
                              setCondition(i, {
                                ...c,
                                toolName: v,
                                outcomeId: tools.find((t) => t.name === v)?.outcomes?.[0]?.id ?? "",
                              })
                            }
                            options={tools.map((t) => ({ value: t.name, label: t.title || t.name }))}
                          />
                        </div>
                        <div>
                          {lbl("исход")}
                          <Select
                            value={c.outcomeId}
                            onChange={(v) => setCondition(i, { ...c, outcomeId: v })}
                            options={
                              tools.find((t) => t.name === c.toolName)?.outcomes?.map((o) => ({
                                value: o.id,
                                label: `${o.title} (${o.id})`,
                              })) ?? [{ value: c.outcomeId, label: c.outcomeId }]
                            }
                          />
                        </div>
                      </>
                    )}
                    {c.type === "score" && (
                      <>
                        <div>
                          {lbl("метрика схемы")}
                          <Select
                            value={c.metric}
                            onChange={(v) => setCondition(i, { ...c, metric: v as "score" | "completionPct" })}
                            options={[
                              { value: "completionPct", label: "% обязательных шагов" },
                              { value: "score", label: "скор" },
                            ]}
                          />
                        </div>
                        <div>
                          {lbl("порог")}
                          <div className="flex items-center gap-2">
                            <Select
                              value={c.op}
                              onChange={(v) => setCondition(i, { ...c, op: v as ">=" | "=" })}
                              className="w-24 shrink-0"
                              options={[
                                { value: ">=", label: "≥" },
                                { value: "=", label: "=" },
                              ]}
                            />
                            <Input
                              type="number"
                              value={c.value}
                              onChange={(e) => setCondition(i, { ...c, value: Number(e.target.value) })}
                              className="flex-1"
                            />
                          </div>
                        </div>
                      </>
                    )}
                    {c.type === "state" && (
                      <>
                        <div>
                          {lbl("ключ состояния")}
                          <Select
                            value={c.key}
                            onChange={(v) => setCondition(i, { ...c, key: v })}
                            options={attrKeyOptions(c.key)}
                          />
                        </div>
                        <div>
                          {lbl("порог")}
                          <div className="flex items-center gap-2">
                            <Select
                              value={c.op}
                              onChange={(v) => setCondition(i, { ...c, op: v as ">=" | "=" })}
                              className="w-24 shrink-0"
                              options={[
                                { value: ">=", label: "≥" },
                                { value: "=", label: "=" },
                              ]}
                            />
                            <Input
                              type="number"
                              value={c.value}
                              onChange={(e) => setCondition(i, { ...c, value: Number(e.target.value) })}
                              className="flex-1"
                            />
                          </div>
                        </div>
                      </>
                    )}
                    {c.type === "relation" && (
                      <>
                        <div>
                          {lbl("чьё отношение")}
                          <Select
                            value={c.whoseId != null ? String(c.whoseId) : ""}
                            onChange={(v) => setCondition(i, { ...c, whoseId: v ? Number(v) : null })}
                            options={[{ value: "", label: "чей переходит — тот и проверяем" }, ...charOptions]}
                          />
                        </div>
                        <div>
                          {lbl("к кому")}
                          <Select
                            value={String(c.toId)}
                            onChange={(v) => setCondition(i, { ...c, toId: Number(v) })}
                            options={charOptions}
                          />
                        </div>
                        <div className="sm:col-span-2">
                          {lbl("порог отношения")}
                          <div className="flex items-center gap-2">
                            <Select
                              value={c.op}
                              onChange={(v) => setCondition(i, { ...c, op: v as ">=" | "=" })}
                              className="w-24 shrink-0"
                              options={[
                                { value: ">=", label: "≥" },
                                { value: "=", label: "=" },
                              ]}
                            />
                            <Input
                              type="number"
                              value={c.value}
                              onChange={(e) => setCondition(i, { ...c, value: Number(e.target.value) })}
                              className="flex-1"
                            />
                          </div>
                        </div>
                      </>
                    )}
                    {"characterId" in c && (
                      <div className="sm:col-span-2">
                        {lbl("кто должен выполнить (пусто = каждый переходящий лично)")}
                        <Select
                          value={c.characterId != null ? String(c.characterId) : ""}
                          onChange={(v) => setCondition(i, { ...c, characterId: v ? Number(v) : null })}
                          options={[{ value: "", label: "каждый переходящий лично" }, ...charOptions]}
                        />
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <Btn variant="danger" onClick={onDelete}>
          <Trash2 className="h-4 w-4" /> Удалить ребро
        </Btn>
      </div>
    </Card>
  );
}
