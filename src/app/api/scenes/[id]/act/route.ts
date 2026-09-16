import { NextResponse } from "next/server";
import { getScene } from "@/db/queries";
import { getEngine } from "@/lib/engine/engine";
import { actSchema, jsonError, parseBody, parseId } from "@/lib/api";

type Ctx = { params: Promise<{ id: string }> };

/** POST /api/scenes/:id/act { characterId, toolName, args } — ручной вызов инструмента. */
export async function POST(req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const sid = parseId(id);
    if (!getScene(sid)) {
      return NextResponse.json({ error: "Сцена не найдена" }, { status: 404 });
    }
    const { characterId, toolName, args } = await parseBody(req, actSchema);
    const result = getEngine().act(sid, characterId, toolName, args);
    return NextResponse.json(result, { status: result.ok ? 201 : 200 });
  } catch (e) {
    return jsonError(e);
  }
}
