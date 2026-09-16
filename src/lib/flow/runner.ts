// Раннер флоу: «метарежиссёр» поверх движка сцен. Управляет прогоном по канвасу
// сценариев — рассаживает персонажей по сценам узлов, оценивает условия переходов
// (машиночитаемые правила вызова тулов), начисляет доход и бонусы, собирает отчёт.
// Сам движок (engine.ts) не меняется: флоу оперирует только его публичным API
// (control/updateScene/события), поэтому эпохи, бюджеты и анти-спам остаются нетронутыми.

import { getDb } from "@/db";
import {
  appendEvent,
  closeFlowVisit,
  createFlowRun,
  getCharacter,
  getFlow,
  getFlowRun,
  getRelation,
  getScene,
  getSceneSchemas,
  getValidationSchema,
  getVisibleEvents,
  hasSeatedVisit,
  listFlowProgress,
  listFlowRuns,
  listFlowVisits,
  listRelationsOf,
  listSceneEvents,
  markVisitSeated,
  openFlowVisit,
  resetScene,
  setFlowProgress,
  setFlowRunStatus,
  setSceneCursor,
  setSceneStatus,
  updateCharacter,
  updateScene,
  flowHasRunningRun,
} from "@/db/queries";
import { characterSuccessfulCalls, evaluateCharacter } from "@/lib/scoring";
import { processPendingEffects } from "@/lib/shop";
import { getEngine } from "@/lib/engine/engine";
import { getHub } from "@/lib/engine/hub";
import type {
  Flow,
  FlowCondition,
  FlowGraph,
  FlowNode,
  FlowRun,
  FlowRunReport,
  FlowReportCharacter,
  FlowVisit,
} from "@/lib/types";
import { MONEY_KEY as MONEY } from "@/lib/types";

/** Структурная валидация графа (при сохранении и при старте прогона). */
export function validateGraph(graph: FlowGraph): string[] {
  const errors: string[] = [];
  const ids = new Set(graph.nodes.map((n) => n.id));
  if (graph.nodes.length === 0) errors.push("Граф пуст — добавьте хотя бы один узел");
  for (const n of graph.nodes) {
    if (n.kind === "scene" && (n.sceneId == null || n.sceneId <= 0)) {
      errors.push(`Узел «${n.id}» не привязан к сцене`);
    }
  }
  const sceneIds = new Set<number>();
  for (const n of graph.nodes) {
    if (n.kind !== "scene" || n.sceneId == null) continue;
    if (sceneIds.has(n.sceneId)) errors.push(`Сцена #${n.sceneId} используется в нескольких узлах — revisit делайте отдельной сценой`);
    sceneIds.add(n.sceneId);
  }
  for (const e of graph.edges) {
    if (!ids.has(e.from)) errors.push(`Ребро «${e.id}» начинается вне узла`);
    if (!ids.has(e.to)) errors.push(`Ребро «${e.id}» ведёт в несуществующий узел`);
  }
  const entries = graph.nodes.filter(
    (n) => !graph.edges.some((e) => e.to === n.id)
  );
  if (graph.nodes.length > 0 && entries.length !== 1) {
    errors.push(
      entries.length === 0
        ? "Нет входного узла (граф зациклен) — оставьте ровно один узел без входящих рёбер"
        : "Несколько входных узлов — оставьте ровно один узел без входящих рёбер"
    );
  }
  return errors;
}

function nodesById(flow: Flow): Map<string, FlowNode> {
  return new Map(flow.graph.nodes.map((n) => [n.id, n]));
}

export function nodeTitle(node: FlowNode, sceneName: (id: number) => string): string {
  if (node.kind === "final") return "Финал";
  if (node.kind === "exit") return "Выход";
  return node.sceneId != null ? sceneName(node.sceneId) : "Узел";
}

interface MoveResult {
  characterId: number;
  to: string;
  status: "active" | "final" | "eliminated";
}

export class FlowRunner {
  constructor() {
    // Автооценка переходов: сцена узла завершилась (maxTurns или «Стоп») ->
    // проверяем исходящие рёбра и рассаживаем персонажей дальше.
    const hub = getHub();
    hub.on("status", (payload: { sceneId: number; status: string }) => {
      if (payload.status !== "finished") return;
      setTimeout(() => {
        try {
          this.onSceneFinished(payload.sceneId);
        } catch (e) {
          console.error("[flow] автооценка переходов упала:", e);
        }
      }, 150);
    });
  }

  private onSceneFinished(sceneId: number): void {
    for (const run of listFlowRuns()) {
      if (run.status !== "running") continue;
      const flow = getFlow(run.flowId);
      if (!flow) continue;
      const node = flow.graph.nodes.find(
        (n) => n.kind === "scene" && n.sceneId === sceneId
      );
      if (!node) continue;
      this.evaluateNode(run.id, node.id).catch((e) =>
        console.error(`[flow] переход из узла ${node.id} упал:`, e)
      );
    }
  }

  /** Запуск прогона: валидация графа и сцен, рассадка входного узла. */
  async start(flowId: number, castIds: number[]): Promise<FlowRun> {
    const flow = getFlow(flowId);
    if (!flow) throw new Error("Сценарий не найден");
    const errors = validateGraph(flow.graph);
    if (errors.length > 0) throw new Error(`Граф сценария невалиден: ${errors.join("; ")}`);
    if (castIds.length === 0) throw new Error("Выберите хотя бы одного персонажа");
    if (flowHasRunningRun(flowId)) throw new Error("У этого сценария уже есть идущий прогон — остановите его первым");
    for (const cid of castIds) {
      if (!getCharacter(cid)) throw new Error(`Персонаж #${cid} не найден`);
    }
    for (const n of flow.graph.nodes) {
      if (n.kind !== "scene" || n.sceneId == null) continue;
      const scene = getScene(n.sceneId);
      if (!scene) throw new Error(`Сцена #${n.sceneId} (узел ${n.id}) не найдена`);
      if (scene.status === "running") throw new Error(`Сцена «${scene.name}» сейчас запущена — остановите её перед прогоном`);
    }

    const entry = flow.graph.nodes.find(
      (n) => !flow.graph.edges.some((e) => e.to === n.id)
    )!;
    const run = createFlowRun(flowId, castIds);
    for (const cid of castIds) {
      setFlowProgress(run.id, cid, entry.id, "active");
      openFlowVisit({
        runId: run.id,
        characterId: cid,
        nodeId: entry.id,
        sceneId: entry.kind === "scene" ? entry.sceneId : null,
      });
    }
    await this.activateScenes(run.id);
    return run;
  }

  /**
   * Оценить переходы из узла: для каждого активного персонажа проверяем рёбра
   * (по priority, условия через «И»), двигаем прошедших, начисляем доход/бонусы,
   * закрываем визиты со снапшотом оценки сцены. Можно вызывать и вручную
   * (кнопка «Оценить переход»), и автоматически по завершению сцены.
   */
  async evaluateNode(runId: number, nodeId: string): Promise<{ moved: MoveResult[]; stayed: number[] }> {
    const run = getFlowRun(runId);
    if (!run) throw new Error("Прогон не найден");
    if (run.status !== "running") throw new Error("Прогон не идёт");
    const flow = getFlow(run.flowId)!;
    const node = nodesById(flow).get(nodeId);
    if (!node) throw new Error("Узел не найден");
    if (node.kind !== "scene" || node.sceneId == null) throw new Error("Переходы оцениваются только из узлов-сцен");

    const actives = listFlowProgress(runId).filter(
      (p) => p.nodeId === nodeId && p.status === "active"
    );
    if (actives.length === 0) throw new Error("В узле нет активных персонажей");

    const events = listSceneEvents(node.sceneId);
    const schemas = getSceneSchemas(node.sceneId);
    const edges = flow.graph.edges
      .filter((e) => e.from === nodeId)
      .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));

    const moved: MoveResult[] = [];
    const stayed: number[] = [];
    const incomeNotes = new Map<number, number>();

    for (const p of actives) {
      const edge = edges.find((e) =>
        e.conditions.every((c) => this.evalCondition(c, events, schemas, p.characterId))
      );
      if (!edge) {
        stayed.push(p.characterId);
        continue;
      }
      // Снапшот оценки сцены для отчёта (по привязанной схеме валидации)
      const schemaId = schemas[p.characterId];
      const schema = schemaId != null ? getValidationSchema(schemaId) : null;
      let score: number | null = null;
      let completion: number | null = null;
      if (schema) {
        const sc = evaluateCharacter(events, p.characterId, schema);
        score = sc.score;
        completion = sc.completionPct;
      }
      closeFlowVisit(runId, p.characterId, nodeId, score, completion);

      // Течение времени: доход персонажа при уходе с узла
      const char = getCharacter(p.characterId);
      if (node.grantIncome && char && char.income > 0) {
        const state = { ...char.state };
        state[MONEY] = (typeof state[MONEY] === "number" ? (state[MONEY] as number) : 0) + char.income;
        updateCharacter(char.id, { state });
        incomeNotes.set(char.id, char.income);
        getHub().emitParticipants(node.sceneId!);
      }

      const target = nodesById(flow).get(edge.to)!;
      const status: MoveResult["status"] =
        target.kind === "final" ? "final" : target.kind === "exit" ? "eliminated" : "active";
      setFlowProgress(runId, p.characterId, target.id, status);
      openFlowVisit({
        runId,
        characterId: p.characterId,
        nodeId: target.id,
        sceneId: target.kind === "scene" ? target.sceneId : null,
      });
      moved.push({ characterId: p.characterId, to: target.id, status });

      // Узел выхода с флагом «остановить всё»: прогон завершается сразу.
      if (target.kind === "exit" && target.stopsRun) {
        await this.abortRun(runId);
        return { moved, stayed };
      }
    }

    const terminal = listFlowProgress(runId).every((p) => p.status !== "active");
    if (terminal) setFlowRunStatus(runId, "finished");

    if (moved.length > 0) await this.activateScenes(runId, incomeNotes);
    return { moved, stayed };
  }

  /** Проверка одного условия перехода (для конкретного переходящего персонажа). */
  private evalCondition(
    cond: FlowCondition,
    events: ReturnType<typeof listSceneEvents>,
    schemas: Record<number, number>,
    moverId: number
  ): boolean {
    const cid = "characterId" in cond ? (cond.characterId ?? moverId) : moverId;
    switch (cond.type) {
      case "step": {
        const needle = cond.argContains?.trim();
        return characterSuccessfulCalls(events, cid).some(
          (c) =>
            c.toolName === cond.toolName &&
            (!needle || JSON.stringify(c.args).includes(needle))
        );
      }
      case "score": {
        const schemaId = schemas[cid];
        if (schemaId == null) return false;
        const schema = getValidationSchema(schemaId);
        if (!schema) return false;
        const sc = evaluateCharacter(events, cid, schema);
        const v = cond.metric === "score" ? sc.score : sc.completionPct;
        return cond.op === ">=" ? v >= cond.value : v === cond.value;
      }
      case "clean": {
        const schemaId = schemas[cid];
        if (schemaId == null) return true; // без схемы нарушений не бывает
        const schema = getValidationSchema(schemaId);
        if (!schema) return true;
        return evaluateCharacter(events, cid, schema).violations.length === 0;
      }
      case "state": {
        const char = getCharacter(cid);
        const v = char?.state[cond.key];
        if (typeof v !== "number") return false;
        return cond.op === ">=" ? v >= cond.value : v === cond.value;
      }
      case "relation": {
        const whose = cond.whoseId ?? moverId;
        const v = getRelation(whose, cond.toId);
        return cond.op === ">=" ? v >= cond.value : v === cond.value;
      }
      case "outcome": {
        // Исход инструмента, добытый персонажем в сцене узла: «оргазм случился»
        return events.some(
          (e) =>
            e.type === "action" &&
            e.actorId === cid &&
            (e.payload.calls ?? []).some(
              (c) => c.ok && c.toolName === cond.toolName && c.outcome === cond.outcomeId
            )
        );
      }
    }
  }

  /**
   * Рассадка персонажей по сценам узлов: первая волна — сброс/продолжение сцены
   * и старт; догоняющие — добавление в участники работающей сцены.
   * incomeNotes — строки о начисленном доходе для рекапа.
   */
  private async activateScenes(runId: number, incomeNotes?: Map<number, number>): Promise<void> {
    const run = getFlowRun(runId);
    if (!run || run.status !== "running") return;
    const flow = getFlow(run.flowId);
    if (!flow) return;
    const progress = listFlowProgress(runId);

    const latestVisit = new Map<string, FlowVisit>();
    for (const v of listFlowVisits(runId)) {
      const k = `${v.characterId}:${v.nodeId}`;
      const cur = latestVisit.get(k);
      if (!cur || v.id > cur.id) latestVisit.set(k, v);
    }

    for (const node of flow.graph.nodes) {
      if (node.kind !== "scene" || node.sceneId == null) continue;
      const actives = progress.filter((p) => p.nodeId === node.id && p.status === "active");
      if (actives.length === 0) continue;
      const scene = getScene(node.sceneId);
      if (!scene) continue;

      const toSeat = actives.filter(
        (p) => (latestVisit.get(`${p.characterId}:${node.id}`)?.seated ?? 0) !== 1
      );
      if (toSeat.length === 0) continue;

      const firstWave = !hasSeatedVisit(runId, node.id);
      const engine = getEngine();
      const db = getDb();
      engine.forget(node.sceneId);
      if (firstWave) {
        if (node.resetOnEntry) {
          resetScene(node.sceneId);
        } else if (scene.cursor > 0 || scene.status !== "idle") {
          // Продолжение: события остаются историей, но ходы и статус — с чистого листа
          setSceneCursor(node.sceneId, 0);
          setSceneStatus(node.sceneId, "idle");
        }
      }

      updateScene(node.sceneId, { characterIds: actives.map((p) => p.characterId) });

      for (const p of toSeat) {
        // Ход времени: отложенные эффекты товаров наступают при входе в новую сцену
        const effectNotices = processPendingEffects(p.characterId);
        const recap = this.buildRecap(runId, p.characterId, incomeNotes?.get(p.characterId));
        const text = [recap, ...effectNotices].filter(Boolean).join("\n\n");
        if (text) {
          getHub().emitEvent(
            appendEvent(db, node.sceneId, 0, "director", null, [p.characterId], { text })
          );
        }
        markVisitSeated(runId, p.characterId, node.id);
      }
      getHub().emitParticipants(node.sceneId);

      // Старт (или перезапуск с обновлённым составом — engine перечитает участников)
      const rt = engine.getRuntime(node.sceneId);
      try {
        if (rt.status === "running") await engine.control(node.sceneId, "pause");
        await engine.control(node.sceneId, "start");
      } catch (e) {
        const msg = `Флоу не смог запустить сцену «${scene.name}»: ${
          e instanceof Error ? e.message : String(e)
        }`;
        getHub().emitEvent(
          appendEvent(db, node.sceneId, 0, "system", null, "all", { message: msg })
        );
        console.error(`[flow] ${msg}`);
      }
    }
  }

  /**
   * Рекап — суррогат памяти между сценами: личное director-событие с тем,
   * что персонаж видел в предыдущей сцене прогона (в скоринг не попадает).
   */
  private buildRecap(runId: number, characterId: number, incomeNote?: number): string {
    const prev = listFlowVisits(runId)
      .filter((v) => v.characterId === characterId && v.leftAt != null && v.sceneId != null)
      .sort((a, b) => b.id - a.id)[0];
    if (!prev || prev.sceneId == null) return "";
    const scene = getScene(prev.sceneId);
    if (!scene) return "";

    const parts: string[] = [`Это новое место и новая сцена. Что ты помнишь о предыдущей сцене («${scene.name}»):`];
    const visible = getVisibleEvents(prev.sceneId, characterId, 400);
    const nameById = new Map<number, string>();
    for (const ev of visible) {
      if (ev.actorId != null && !nameById.has(ev.actorId)) {
        const c = getCharacter(ev.actorId);
        if (c) nameById.set(ev.actorId, c.name);
      }
    }
    const lines: string[] = [];
    for (const ev of visible.slice(-10)) {
      if (ev.type === "speech") {
        lines.push(`${nameById.get(ev.actorId ?? -1) ?? "Кто-то"}: «${(ev.payload.text ?? "").slice(0, 160)}»`);
      } else if (ev.type === "action") {
        const obs = (ev.payload.calls ?? [])
          .map((c) => c.observation)
          .filter(Boolean)
          .join("; ");
        if (obs) lines.push(obs.slice(0, 160));
      }
    }
    if (lines.length > 0) parts.push(lines.slice(-8).join("\n"));
    if (incomeNote != null && incomeNote > 0) {
      parts.push(`За прошедший период ты получил(а) доход $${incomeNote} — он уже на твоём счёте.`);
    }
    parts.push("Продолжай вести себя естественно, опираясь на этот опыт.");
    return parts.join("\n").slice(0, 1600);
  }

  /** Остановить прогон: сцены на паузу, статус aborted. */
  async abortRun(runId: number): Promise<void> {
    const run = getFlowRun(runId);
    if (!run || run.status !== "running") return;
    const flow = getFlow(run.flowId);
    if (flow) {
      for (const n of flow.graph.nodes) {
        if (n.kind !== "scene" || n.sceneId == null) continue;
        try {
          const rt = getEngine().getRuntime(n.sceneId);
          if (rt.status === "running") await getEngine().control(n.sceneId, "pause");
        } catch {
          // сцена могла уже закончиться
        }
      }
    }
    setFlowRunStatus(runId, "aborted");
  }

  /**
   * Отчёт по прогону. Оценки сцен пересчитываются по живым событиям —
   * правка схемы валидации после завершения сцены меняет отчёт (переоценка).
   * Если сцена удалена/сброшена — используется снапшот, снятый при переходе.
   */
  report(runId: number): FlowRunReport {
    const run = getFlowRun(runId);
    if (!run) throw new Error("Прогон не найден");
    const flow = getFlow(run.flowId)!;
    const map = nodesById(flow);
    const progress = listFlowProgress(runId);
    const visits = listFlowVisits(runId);

    const characters: FlowReportCharacter[] = run.cast.map((cid) => {
      const char = getCharacter(cid);
      const p = progress.find((x) => x.characterId === cid);
      const myVisits = visits
        .filter((v) => v.characterId === cid)
        .sort((a, b) => a.id - b.id)
        .map((v) => {
          const node = map.get(v.nodeId);
          let score = v.score;
          let completion = v.completionPct;
          if (v.sceneId != null) {
            const scene = getScene(v.sceneId);
            if (scene) {
              const schemas = getSceneSchemas(v.sceneId);
              const schemaId = schemas[cid];
              const schema = schemaId != null ? getValidationSchema(schemaId) : null;
              if (schema) {
                const sc = evaluateCharacter(listSceneEvents(v.sceneId), cid, schema);
                score = sc.score;
                completion = sc.completionPct;
              } else {
                score = null;
                completion = null;
              }
            }
          }
          return {
            nodeId: v.nodeId,
            nodeTitle: node ? nodeTitle(node, (id) => getScene(id)?.name ?? `сцена #${id}`) : v.nodeId,
            sceneId: v.sceneId,
            score,
            completionPct: completion,
            enteredAt: v.enteredAt,
            leftAt: v.leftAt,
          };
        });
      const bonus = myVisits.reduce(
        (s, v) => s + (map.get(v.nodeId)?.bonus ?? 0),
        0
      );
      const score = myVisits.reduce((s, v) => s + (v.score ?? 0), 0);
      const relations = listRelationsOf(cid)
        .filter((r) => run.cast.includes(r.toId) && r.toId !== cid)
        .map((r) => ({
          toId: r.toId,
          name: getCharacter(r.toId)?.name ?? `#${r.toId}`,
          value: r.value,
        }));
      return {
        characterId: cid,
        name: char?.name ?? `#${cid}`,
        emoji: char?.emoji ?? "❓",
        status: p?.status ?? "active",
        reachedFinal: p?.status === "final",
        score,
        bonus,
        total: score + bonus,
        relations,
        visits: myVisits,
      };
    });

    return {
      run,
      flow: { id: flow.id, name: flow.name },
      characters: characters.sort(
        (a, b) => Number(b.reachedFinal) - Number(a.reachedFinal) || b.total - a.total
      ),
    };
  }
}

const g = globalThis as unknown as { __simFlowRunner?: FlowRunner };

export function getFlowRunner(): FlowRunner {
  if (!g.__simFlowRunner) g.__simFlowRunner = new FlowRunner();
  return g.__simFlowRunner;
}
