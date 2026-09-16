import { NextResponse } from "next/server";
import { listSceneEvents } from "@/db/queries";
import { jsonError, parseId } from "@/lib/api";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/scenes/:id/events?after=<id> — история событий (для polling-фолбэка). */
export async function GET(req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const after = Number(new URL(req.url).searchParams.get("after") ?? 0);
    return NextResponse.json(listSceneEvents(parseId(id), Number.isFinite(after) ? after : 0));
  } catch (e) {
    return jsonError(e);
  }
}
