import { NextResponse } from "next/server";
import { listSceneApiLogs } from "@/db/queries";
import { jsonError, parseId } from "@/lib/api";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/scenes/:id/apilogs?characterId=&turn= — инспектор запросов к моделям. */
export async function GET(req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const sp = new URL(req.url).searchParams;
    const characterId = sp.get("characterId") ? Number(sp.get("characterId")) : undefined;
    const turn = sp.get("turn") ? Number(sp.get("turn")) : undefined;
    return NextResponse.json(
      listSceneApiLogs(
        parseId(id),
        characterId != null && Number.isFinite(characterId) ? characterId : undefined,
        turn != null && Number.isFinite(turn) ? turn : undefined
      )
    );
  } catch (e) {
    return jsonError(e);
  }
}
