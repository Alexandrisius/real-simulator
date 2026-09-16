import { NextResponse } from "next/server";
import { getScene, resetScene, resetSceneFull } from "@/db/queries";
import { getEngine } from "@/lib/engine/engine";
import { getHub } from "@/lib/engine/hub";
import { ApiError, jsonError, parseId } from "@/lib/api";
import { z } from "zod";

type Ctx = { params: Promise<{ id: string }> };

const bodySchema = z.object({
  /** full = «Заново»: события + отношения + взаимная память + состояния к снимку рассадки */
  full: z.boolean().optional().default(false),
});

/** POST — сброс сцены: события удаляются, курсор/расход в ноль, статус idle. */
export async function POST(req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const sid = parseId(id);
    const scene = getScene(sid);
    if (!scene) throw new ApiError(404, "Сцена не найдена");
    if (scene.status === "running") throw new ApiError(409, "Остановите сцену перед сбросом");
    let full = false;
    try {
      const text = await req.text();
      if (text.trim()) full = bodySchema.parse(JSON.parse(text)).full;
    } catch (e) {
      if (e instanceof z.ZodError) throw e;
    }
    getEngine().forget(sid);
    if (full) resetSceneFull(sid);
    else resetScene(sid);
    getHub().emitParticipants(sid);
    return NextResponse.json({ ok: true, full });
  } catch (e) {
    return jsonError(e);
  }
}
