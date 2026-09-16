import { NextResponse } from "next/server";
import { getScene } from "@/db/queries";
import { getEngine } from "@/lib/engine/engine";
import { ApiError, jsonError, parseBody, parseId, saySchema } from "@/lib/api";

type Ctx = { params: Promise<{ id: string }> };

/** POST /api/scenes/:id/say { characterId, text } — реплика от лица персонажа. */
export async function POST(req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const sid = parseId(id);
    if (!getScene(sid)) throw new ApiError(404, "Сцена не найдена");
    const { characterId, text } = await parseBody(req, saySchema);
    const ev = getEngine().say(sid, characterId, text.trim());
    return NextResponse.json(ev, { status: 201 });
  } catch (e) {
    return jsonError(e);
  }
}
