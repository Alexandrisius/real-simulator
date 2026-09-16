import { NextResponse } from "next/server";
import { deleteAttribute, getAttribute, updateAttribute } from "@/db/queries";
import { ApiError, attributeSchema, jsonError, parseBody, parseId } from "@/lib/api";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const a = getAttribute(parseId(id));
    if (!a) throw new ApiError(404, "Атрибут не найден");
    return NextResponse.json(a);
  } catch (e) {
    return jsonError(e);
  }
}

export async function PATCH(req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const aid = parseId(id);
    const data = await parseBody(req, attributeSchema);
    const a = updateAttribute(aid, data);
    if (!a) throw new ApiError(404, "Атрибут не найден");
    return NextResponse.json(a);
  } catch (e) {
    return jsonError(e);
  }
}

export async function DELETE(_req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    if (!deleteAttribute(parseId(id))) throw new ApiError(404, "Атрибут не найден");
    return NextResponse.json({ ok: true });
  } catch (e) {
    return jsonError(e);
  }
}
