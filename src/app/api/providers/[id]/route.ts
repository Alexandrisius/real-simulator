import { NextResponse } from "next/server";
import {
  deleteProvider,
  getProvider,
  providerInUse,
  updateProvider,
} from "@/db/queries";
import { ApiError, jsonError, parseBody, parseId, providerSchema } from "@/lib/api";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const p = getProvider(parseId(id));
    if (!p) throw new ApiError(404, "Провайдер не найден");
    return NextResponse.json(p);
  } catch (e) {
    return jsonError(e);
  }
}

export async function PATCH(req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const data = await parseBody(req, providerSchema.partial());
    const p = updateProvider(parseId(id), data);
    if (!p) throw new ApiError(404, "Провайдер не найден");
    return NextResponse.json(p);
  } catch (e) {
    return jsonError(e);
  }
}

export async function DELETE(_req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const pid = parseId(id);
    if (providerInUse(pid))
      throw new ApiError(409, "Провайдер используется персонажами — сначала отвяжите их");
    if (!deleteProvider(pid)) throw new ApiError(404, "Провайдер не найден");
    return NextResponse.json({ ok: true });
  } catch (e) {
    return jsonError(e);
  }
}
