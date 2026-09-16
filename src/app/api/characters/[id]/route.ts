import { NextResponse } from "next/server";
import {
  characterInScenes,
  deleteCharacter,
  getCharacter,
  getProvider,
  updateCharacter,
} from "@/db/queries";
import { ApiError, characterSchema, jsonError, parseBody, parseId } from "@/lib/api";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const c = getCharacter(parseId(id));
    if (!c) throw new ApiError(404, "Персонаж не найден");
    return NextResponse.json(c);
  } catch (e) {
    return jsonError(e);
  }
}

export async function PATCH(req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const data = await parseBody(req, characterSchema.partial());
    if (data.providerId != null && !getProvider(data.providerId))
      throw new ApiError(400, "Провайдер не найден");
    const c = updateCharacter(parseId(id), data);
    if (!c) throw new ApiError(404, "Персонаж не найден");
    return NextResponse.json(c);
  } catch (e) {
    return jsonError(e);
  }
}

export async function DELETE(_req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const cid = parseId(id);
    const used = characterInScenes(cid);
    if (used > 0)
      throw new ApiError(409, `Персонаж участвует в сценах (${used}) — сначала удалите их или уберите его`);
    if (!deleteCharacter(cid)) throw new ApiError(404, "Персонаж не найден");
    return NextResponse.json({ ok: true });
  } catch (e) {
    return jsonError(e);
  }
}
