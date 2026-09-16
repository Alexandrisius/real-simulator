import { NextResponse } from "next/server";
import { getScene } from "@/db/queries";
import { evaluateScene } from "@/lib/scoring";
import { ApiError, jsonError, parseId } from "@/lib/api";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/scenes/:id/scores — оценка участников по их схемам валидации. */
export async function GET(_req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const sid = parseId(id);
    if (!getScene(sid)) throw new ApiError(404, "Сцена не найдена");
    return NextResponse.json(evaluateScene(sid));
  } catch (e) {
    return jsonError(e);
  }
}
