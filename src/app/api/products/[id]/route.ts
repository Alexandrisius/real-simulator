import { NextResponse } from "next/server";
import { deleteProduct, getProduct, updateProduct } from "@/db/queries";
import { ApiError, jsonError, parseBody, parseId, productSchema } from "@/lib/api";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const p = getProduct(parseId(id));
    if (!p) throw new ApiError(404, "Товар не найден");
    return NextResponse.json(p);
  } catch (e) {
    return jsonError(e);
  }
}

export async function PATCH(req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const pid = parseId(id);
    const data = await parseBody(req, productSchema);
    const p = updateProduct(pid, data);
    if (!p) throw new ApiError(404, "Товар не найден");
    return NextResponse.json(p);
  } catch (e) {
    return jsonError(e);
  }
}

export async function DELETE(_req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    if (!deleteProduct(parseId(id))) throw new ApiError(404, "Товар не найден");
    return NextResponse.json({ ok: true });
  } catch (e) {
    return jsonError(e);
  }
}
