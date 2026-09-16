import { NextResponse } from "next/server";
import { deleteFlow, flowHasRunningRun, getFlow, getScene, updateFlow } from "@/db/queries";
import { validateGraph } from "@/lib/flow/runner";
import { ApiError, flowSchema, jsonError, parseBody, parseId } from "@/lib/api";

type Ctx = { params: Promise<{ id: string }> };

/** GET — флоу + сцены графа + ошибки валидации графа. */
export async function GET(_req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const fid = parseId(id);
    const flow = getFlow(fid);
    if (!flow) throw new ApiError(404, "Сценарий не найден");
    const scenes = [];
    for (const node of flow.graph.nodes) {
      if (node.kind === "scene" && node.sceneId != null) {
        const s = getScene(node.sceneId);
        if (s) scenes.push({ id: s.id, name: s.name, status: s.status });
      }
    }
    return NextResponse.json({
      flow,
      scenes,
      graphErrors: validateGraph(flow.graph),
    });
  } catch (e) {
    return jsonError(e);
  }
}

export async function PATCH(req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const fid = parseId(id);
    const flow = getFlow(fid);
    if (!flow) throw new ApiError(404, "Сценарий не найден");
    const data = await parseBody(req, flowSchema.partial());
    const graph = data.graph ?? flow.graph;
    const errors = validateGraph(graph);
    if (errors.length > 0) throw new ApiError(400, errors.join("; "));
    const updated = updateFlow(fid, data);
    return NextResponse.json(updated);
  } catch (e) {
    return jsonError(e);
  }
}

export async function DELETE(_req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const fid = parseId(id);
    const flow = getFlow(fid);
    if (!flow) throw new ApiError(404, "Сценарий не найден");
    if (flowHasRunningRun(fid)) {
      throw new ApiError(409, "У сценария идёт прогон — остановите его перед удалением");
    }
    if (!deleteFlow(fid)) throw new ApiError(404, "Сценарий не найден");
    return NextResponse.json({ ok: true });
  } catch (e) {
    return jsonError(e);
  }
}
