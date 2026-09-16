import { NextResponse } from "next/server";
import { getScene } from "@/db/queries";
import { getEngine } from "@/lib/engine/engine";
import { ApiError, injectSchema, jsonError, parseBody, parseId } from "@/lib/api";

type Ctx = { params: Promise<{ id: string }> };

/** POST /api/scenes/:id/inject { text, audience } — событие от режиссёра. */
export async function POST(req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const sid = parseId(id);
    if (!getScene(sid)) throw new ApiError(404, "Сцена не найдена");
    const { text, audience } = await parseBody(req, injectSchema);
    const ev = getEngine().inject(sid, text, audience);
    return NextResponse.json(ev, { status: 201 });
  } catch (e) {
    return jsonError(e);
  }
}
