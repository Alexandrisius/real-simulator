import { NextResponse } from "next/server";
import { getDb } from "@/db";
import {
  deleteScene,
  getCharacter,
  getProvider,
  getScene,
  getSceneGoals,
  getSceneParticipants,
  getSceneSchemas,
  getValidationSchema,
  updateScene,
} from "@/db/queries";
import { getEngine } from "@/lib/engine/engine";
import { ApiError, jsonError, parseBody, parseId, sceneSchema } from "@/lib/api";

type Ctx = { params: Promise<{ id: string }> };

/** GET — сцена + участники (с провайдерами и схемами) + runtime-статус движка. */
export async function GET(_req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const sid = parseId(id);
    const scene = getScene(sid);
    if (!scene) throw new ApiError(404, "Сцена не найдена");
    const schemaIds = getSceneSchemas(sid);
    const goals = getSceneGoals(sid);
    const participants = getSceneParticipants(sid)
      .map((cid) => {
        const c = getCharacter(cid);
        if (!c) return null;
        const provider = c.providerId != null ? getProvider(c.providerId) : null;
        const schema = schemaIds[cid] != null ? getValidationSchema(schemaIds[cid]) : null;
        return {
          ...c,
          providerName: provider?.name ?? (c.isHuman ? "вы" : "?"),
          providerKind: provider?.kind ?? (c.isHuman ? "human" : "?"),
          validationSchemaId: schema?.id ?? null,
          validationSchemaName: schema?.name ?? null,
          goal: goals[cid] ?? null,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
    const runtime = getEngine().getRuntime(sid);
    return NextResponse.json({ scene, participants, runtime });
  } catch (e) {
    return jsonError(e);
  }
}

export async function PATCH(req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const sid = parseId(id);
    const scene = getScene(sid);
    if (!scene) throw new ApiError(404, "Сцена не найдена");
    const data = await parseBody(req, sceneSchema.partial());
    if (
      data.characterIds &&
      !data.characterIds.every((cid) => getCharacter(cid))
    )
      throw new ApiError(400, "Среди персонажей есть несуществующие");
    if (scene.status === "running" && data.characterIds)
      throw new ApiError(409, "Нельзя менять состав участников запущенной сцены");
    const s = updateScene(sid, data);
    return NextResponse.json(s);
  } catch (e) {
    return jsonError(e);
  }
}

export async function DELETE(_req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const sid = parseId(id);
    const status = getScene(sid)?.status;
    if (status === "running") {
      getEngine().control(sid, "stop");
    } else {
      getEngine().forget(sid);
    }
    getDb().prepare("DELETE FROM api_logs WHERE scene_id = ?").run(sid);
    if (!deleteScene(sid)) throw new ApiError(404, "Сцена не найдена");
    return NextResponse.json({ ok: true });
  } catch (e) {
    return jsonError(e);
  }
}
