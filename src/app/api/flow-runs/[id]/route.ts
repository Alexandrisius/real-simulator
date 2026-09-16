import { NextResponse } from "next/server";
import {
  getCharacter,
  getFlow,
  getFlowRun,
  getScene,
  listFlowProgress,
} from "@/db/queries";
import { getFlowRunner } from "@/lib/flow/runner";
import { getEngine } from "@/lib/engine/engine";
import { ApiError, jsonError, parseId } from "@/lib/api";

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET — отчёт прогона (оценки пересчитываются по живым событиям сцен:
 * правка схемы валидации после завершения сцены меняет отчёт) + сводка узлов.
 */
export async function GET(_req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const rid = parseId(id);
    const runner = getFlowRunner();
    const report = runner.report(rid);
    const flow = getFlow(report.run.flowId);
    const progress = listFlowProgress(rid);
    const nodes = (flow?.graph.nodes ?? []).map((n) => {
      const here = progress.filter((p) => p.nodeId === n.id);
      const scene = n.kind === "scene" && n.sceneId != null ? getScene(n.sceneId) : null;
      return {
        id: n.id,
        kind: n.kind,
        sceneId: n.sceneId,
        bonus: n.bonus,
        grantIncome: n.grantIncome,
        stopsRun: n.stopsRun,
        x: n.x,
        y: n.y,
        title:
          n.kind === "final"
            ? "Финал"
            : n.kind === "exit"
              ? "Выход"
              : (scene?.name ?? `сцена #${n.sceneId}`),
        sceneStatus: scene ? getEngine().getRuntime(scene.id).status : null,
        characters: here.map((p) => {
          const c = getCharacter(p.characterId);
          return {
            id: p.characterId,
            name: c?.name ?? `#${p.characterId}`,
            emoji: c?.emoji ?? "❓",
            status: p.status,
          };
        }),
      };
    });
    const edges = flow?.graph.edges ?? [];
    return NextResponse.json({ report, nodes, edges });
  } catch (e) {
    return jsonError(e);
  }
}

/** DELETE — остановить прогон (сцены на паузу, статус aborted). */
export async function DELETE(_req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const rid = parseId(id);
    if (!getFlowRun(rid)) throw new ApiError(404, "Прогон не найден");
    await getFlowRunner().abortRun(rid);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return jsonError(e);
  }
}
