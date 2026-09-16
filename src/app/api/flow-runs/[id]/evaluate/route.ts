import { NextResponse } from "next/server";
import { getFlowRunner } from "@/lib/flow/runner";
import { ApiError, flowEvaluateSchema, jsonError, parseBody, parseId } from "@/lib/api";

type Ctx = { params: Promise<{ id: string }> };

/** POST — оценить переходы из узла вручную (кнопка «Оценить переход»). */
export async function POST(req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const rid = parseId(id);
    const { nodeId } = await parseBody(req, flowEvaluateSchema);
    const result = await getFlowRunner().evaluateNode(rid, nodeId);
    return NextResponse.json(result);
  } catch (e) {
    return jsonError(e);
  }
}
