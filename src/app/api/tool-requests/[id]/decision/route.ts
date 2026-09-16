import { NextResponse } from "next/server";
import { getToolRequest } from "@/db/queries";
import { decideToolRequest } from "@/lib/toolRequests";
import { getHub } from "@/lib/engine/hub";
import { ApiError, jsonError, parseBody, parseId, toolRequestDecisionSchema } from "@/lib/api";

type Ctx = { params: Promise<{ id: string }> };

/** POST — решение архитектора по заявке (уведомление персонажу пишет библиотека). */
export async function POST(req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const rid = parseId(id);
    const data = await parseBody(req, toolRequestDecisionSchema);
    const before = getToolRequest(rid);
    if (!before) throw new ApiError(404, "Заявка не найдена");

    const result = decideToolRequest({
      requestId: rid,
      approve: data.action === "approve",
      reason: data.reason ?? "",
      patch: data.patch,
    });
    if (!result.ok) throw new ApiError(400, result.error);
    if (result.tool) getHub().emitParticipants(before.sceneId);
    return NextResponse.json({ ok: true, tool: result.tool, notice: result.notice });
  } catch (e) {
    return jsonError(e);
  }
}
